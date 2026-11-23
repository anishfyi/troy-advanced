import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LiteBrowserEngine,
  RobotsDisallowedError,
  computeBackoffDelayMs,
  evaluateRobots,
  extractRateLimitDelayMs,
  parseRetryAfterMs,
  parseRobotsTxt,
  resolveRetryPolicy,
} from '../src/index.js'

describe('M39: robots.txt parser & evaluator (unit)', () => {
  it('parses BOM, comments, CRLF, sitemaps, multi-agent groups, and crawl-delay', () => {
    const raw = [
      '\uFEFF# Top comment',
      'User-agent: TroyBot',
      'User-agent: CustomAgent/1.0 # inline comment',
      'Disallow: /admin',
      'Allow: /admin/status',
      'Crawl-delay: 1.5',
      '',
      'User-agent: *',
      'Disallow: /private/',
      'Sitemap: https://example.com/sitemap.xml',
    ].join('\r\n')

    const doc = parseRobotsTxt(raw)
    expect(doc.sitemaps).toEqual(['https://example.com/sitemap.xml'])
    expect(doc.groups).toHaveLength(2)
    expect(doc.groups[0]!.userAgents).toEqual(['troybot', 'customagent/1.0'])
    expect(doc.groups[0]!.crawlDelayMs).toBe(1500)

    const d1 = evaluateRobots(doc, '/admin/panel', 'TroyBot/2.0')
    expect(d1.allowed).toBe(false)
    expect(d1.matchedAgent).toBe('troybot')
    expect(d1.crawlDelayMs).toBe(1500)

    // Longest-match-wins: /admin/status (13) beats /admin (6)
    const d2 = evaluateRobots(doc, '/admin/status', 'TroyBot/2.0')
    expect(d2.allowed).toBe(true)
    expect(d2.matchedRule?.directive).toBe('allow')

    // Fallback to * group for other agents
    const d3 = evaluateRobots(doc, '/private/doc', 'Mozilla/5.0')
    expect(d3.allowed).toBe(false)
    expect(d3.matchedAgent).toBe('*')

    const d4 = evaluateRobots(doc, '/admin/panel', 'Mozilla/5.0')
    expect(d4.allowed).toBe(true)
  })

  it('supports wildcards (*), end-anchors ($), query strings, empty Disallow, and Allow tie-breaker', () => {
    const doc = parseRobotsTxt(`
      User-agent: *
      Disallow: /*.pdf$
      Allow: /public/*.pdf$
      Disallow: /*?token=
      Disallow: /tie
      Allow: /tie
    `)

    expect(evaluateRobots(doc, '/files/report.pdf', 'TestBot').allowed).toBe(false)
    expect(evaluateRobots(doc, '/files/report.pdf.html', 'TestBot').allowed).toBe(true)
    expect(evaluateRobots(doc, '/public/guide.pdf', 'TestBot').allowed).toBe(true)
    expect(evaluateRobots(doc, '/search?token=abc', 'TestBot').allowed).toBe(false)
    // RFC 9309 §2.2.2: equal length tie-breaker favors Allow
    expect(evaluateRobots(doc, '/tie/page', 'TestBot').allowed).toBe(true)

    const allowAll = parseRobotsTxt('User-agent: *\nDisallow:\n')
    expect(evaluateRobots(allowAll, '/anything', 'TestBot').allowed).toBe(true)
  })

  it('caps Crawl-delay at maxCrawlDelayMs and merges duplicate agent groups', () => {
    const doc = parseRobotsTxt(`
      User-agent: Troy
      Disallow: /a
      Crawl-delay: 60

      User-agent: Troy
      Disallow: /b
    `)

    const dA = evaluateRobots(doc, '/a', 'Troy/1.0', 5000)
    const dB = evaluateRobots(doc, '/b', 'Troy/1.0', 5000)
    expect(dA.allowed).toBe(false)
    expect(dB.allowed).toBe(false)
    expect(dA.crawlDelayMs).toBe(5000)
  })
})

describe('M39: Retry-After, rate-limit headers & exponential backoff (unit)', () => {
  it('parses delta-seconds and HTTP-date Retry-After headers', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    expect(parseRetryAfterMs('3', now)).toBe(3000)
    expect(parseRetryAfterMs('0', now)).toBe(0)
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 12:00:05 GMT', now)).toBe(5000)
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 11:59:50 GMT', now)).toBe(0)
    expect(parseRetryAfterMs('invalid-date', now)).toBeUndefined()
    expect(parseRetryAfterMs(null, now)).toBeUndefined()
  })

  it('extracts cooldown from X-RateLimit-Remaining=0 and epoch or delta Reset headers', () => {
    const now = 1_750_000_000_000 // ms
    const hEpoch = new Headers({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(1_750_000_004), // 4s in the future
    })
    expect(extractRateLimitDelayMs(hEpoch, now)).toEqual({ delayMs: 4000, reason: 'RateLimit-Reset' })

    const hDelta = new Headers({
      'ratelimit-remaining': '0',
      'ratelimit-reset': '2.5',
    })
    expect(extractRateLimitDelayMs(hDelta, now)).toEqual({ delayMs: 2500, reason: 'RateLimit-Reset' })

    const hRemaining = new Headers({
      'x-ratelimit-remaining': '10',
      'x-ratelimit-reset': '5',
    })
    expect(extractRateLimitDelayMs(hRemaining, now)).toBeUndefined()
  })

  it('computes exponential backoff with capping, bounded jitter, and Retry-After override', () => {
    const det = resolveRetryPolicy({
      baseDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 500,
      jitterRatio: 0,
      respectRetryAfter: true,
    })
    expect(computeBackoffDelayMs(0, det)).toBe(100)
    expect(computeBackoffDelayMs(1, det)).toBe(200)
    expect(computeBackoffDelayMs(2, det)).toBe(400)
    expect(computeBackoffDelayMs(3, det)).toBe(500) // capped
    expect(computeBackoffDelayMs(0, det, 350)).toBe(350) // Retry-After honored
    expect(computeBackoffDelayMs(0, det, 9000)).toBe(500) // Retry-After capped

    const withJitter = resolveRetryPolicy({
      baseDelayMs: 1000,
      backoffFactor: 2,
      maxDelayMs: 10000,
      jitterRatio: 0.25,
    })
    expect(computeBackoffDelayMs(0, withJitter, undefined, () => 0)).toBe(750)
    expect(computeBackoffDelayMs(0, withJitter, undefined, () => 0.5)).toBe(1000)
    expect(computeBackoffDelayMs(0, withJitter, undefined, () => 1)).toBe(1250)
  })
})

describe('M39: LiteBrowserEngine robots, rate-limit & 429/503 retry integration', () => {
  let server: http.Server
  let baseUrl = ''

  let robotsMode: 'rules' | '404' | '500' | 'crawl-delay' = 'rules'
  let robotsHits = 0
  const hitCounts = new Map<string, number>()

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const urlPath = req.url ?? '/'
      hitCounts.set(urlPath, (hitCounts.get(urlPath) ?? 0) + 1)
      const count = hitCounts.get(urlPath)!

      if (urlPath === '/robots.txt') {
        robotsHits += 1
        if (robotsMode === '404') {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('Not Found')
          return
        }
        if (robotsMode === '500') {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('Server Error')
          return
        }
        if (robotsMode === 'crawl-delay') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('User-agent: *\nCrawl-delay: 1.5\nAllow: /\n')
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('User-agent: *\nDisallow: /secret\nAllow: /secret/public\n')
        return
      }

      if (urlPath === '/flaky-429') {
        if (count <= 2) {
          res.writeHead(429, { 'content-type': 'text/plain' })
          res.end('Too Many Requests')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><head><title>Recovered 429</title></head><body><h1>Success after 429</h1></body></html>')
        return
      }

      if (urlPath === '/flaky-503-retry-after') {
        if (count === 1) {
          res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' })
          res.end('Service Unavailable')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><head><title>Recovered 503</title></head><body><p>Back online</p></body></html>')
        return
      }

      if (urlPath === '/always-503') {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('Still unavailable')
        return
      }

      if (urlPath === '/post-form') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(
          '<html><head><title>Post Form</title></head><body><form method="POST" action="/submit-503"><input name="q" value="hi"/><button type="submit">Go</button></form></body></html>',
        )
        return
      }

      if (urlPath === '/submit-503') {
        if (count === 1) {
          res.writeHead(503, { 'content-type': 'text/plain' })
          res.end('Busy')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><head><title>Submitted</title></head><body><h1>Submitted OK</h1></body></html>')
        return
      }

      if (urlPath === '/redirect-to-secret') {
        res.writeHead(302, { location: '/secret/hidden' })
        res.end()
        return
      }

      if (urlPath === '/ratelimited-ok') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'x-ratelimit-remaining': '0',
          'ratelimit-reset': '2',
        })
        res.end('<html><head><title>Rate Limited OK</title></head><body><p>Quota used</p></body></html>')
        return
      }

      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><head><title>Page ${urlPath}</title></head><body><h1>Path ${urlPath}</h1></body></html>`)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('retries HTTP 429 with exponential backoff and logs retry metadata', async () => {
    hitCounts.delete('/flaky-429')
    const sleeps: number[] = []
    let fakeNow = 1_700_000_000_000

    const engine = new LiteBrowserEngine({
      retry: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 100,
        backoffFactor: 2,
        jitterRatio: 0,
      },
      robotsRetryHooks: {
        now: () => fakeNow,
        sleep: async (ms) => {
          sleeps.push(ms)
          fakeNow += ms
        },
      },
    })

    const tab = await engine.createTab()
    const nav = await tab.navigate(`${baseUrl}/flaky-429`)
    expect(nav.title).toBe('Recovered 429')
    expect(hitCounts.get('/flaky-429')).toBe(3)
    expect(sleeps).toEqual([100, 200])

    const net = tab.getNetwork()
    expect(net).toHaveLength(1)
    expect(net[0]!.status).toBe(200)
    expect(net[0]!.retries).toBe(2)

    const logs = tab.getConsole()
    expect(logs.some((l) => l.level === 'warning' && l.text.includes('HTTP 429'))).toBe(true)

    const stats = engine.getRateLimitStats()
    expect(stats.totalRetries).toBe(2)
    expect(stats.totalRetryDelayMs).toBe(300)

    await engine.close()
  })

  it('honors Retry-After header on HTTP 503', async () => {
    hitCounts.delete('/flaky-503-retry-after')
    const sleeps: number[] = []
    let fakeNow = 1_700_000_000_000

    const engine = new LiteBrowserEngine({
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 50,
        maxDelayMs: 5000,
        jitterRatio: 0,
        respectRetryAfter: true,
      },
      robotsRetryHooks: {
        now: () => fakeNow,
        sleep: async (ms) => {
          sleeps.push(ms)
          fakeNow += ms
        },
      },
    })

    const tab = await engine.createTab()
    const nav = await tab.navigate(`${baseUrl}/flaky-503-retry-after`)
    expect(nav.title).toBe('Recovered 503')
    expect(sleeps).toEqual([2000])
    expect(hitCounts.get('/flaky-503-retry-after')).toBe(2)
    await engine.close()
  })

  it('stops after maxRetries and respects retry.enabled=false', async () => {
    hitCounts.delete('/always-503')
    const sleeps: number[] = []
    const engine = new LiteBrowserEngine({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 50, backoffFactor: 2, jitterRatio: 0 },
      robotsRetryHooks: { sleep: async (ms) => void sleeps.push(ms) },
    })
    const tab = await engine.createTab()
    await tab.navigate(`${baseUrl}/always-503`)
    expect(hitCounts.get('/always-503')).toBe(3)
    expect(sleeps).toEqual([50, 100])
    expect(tab.getNetwork()[0]!.status).toBe(503)
    expect(tab.getNetwork()[0]!.retries).toBe(2)

    // Now disable retries
    hitCounts.delete('/always-503')
    sleeps.length = 0
    engine.setRetryPolicy({ enabled: false })
    await tab.navigate(`${baseUrl}/always-503`)
    expect(hitCounts.get('/always-503')).toBe(1)
    expect(sleeps).toEqual([])
    await engine.close()
  })

  it('does not retry POST on 503 unless retryNonIdempotent is true', async () => {
    const sleeps: number[] = []
    const engine = new LiteBrowserEngine({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 25, jitterRatio: 0, retryNonIdempotent: false },
      robotsRetryHooks: { sleep: async (ms) => void sleeps.push(ms) },
    })

    const tab = await engine.createTab()
    await tab.navigate(`${baseUrl}/post-form`)
    const snap = await tab.snapshot()
    const btn = snap.elements.find((e) => e.tag === 'button')!

    hitCounts.delete('/submit-503')
    await tab.click(btn.selector)
    expect(hitCounts.get('/submit-503')).toBe(1)
    expect(sleeps).toEqual([])
    expect(tab.getNetwork().at(-1)!.status).toBe(503)

    // Enable retryNonIdempotent and try again
    engine.setRetryPolicy({ retryNonIdempotent: true })
    await tab.navigate(`${baseUrl}/post-form`)
    const snap2 = await tab.snapshot()
    const btn2 = snap2.elements.find((e) => e.tag === 'button')!

    hitCounts.delete('/submit-503')
    await tab.click(btn2.selector)
    expect(hitCounts.get('/submit-503')).toBe(2)
    expect(sleeps).toEqual([25])
    expect(tab.getTitle()).toBe('Submitted')
    await engine.close()
  })

  it('enforces robots.txt Disallow/Allow, caches robots.txt, and blocks disallowed redirects', async () => {
    robotsMode = 'rules'
    robotsHits = 0

    const engine = new LiteBrowserEngine({
      robots: { enabled: true, cacheTtlMs: 60_000 },
    })
    const tab = await engine.createTab()

    // Disallowed path
    await expect(tab.navigate(`${baseUrl}/secret/panel`)).rejects.toThrow(RobotsDisallowedError)
    expect(robotsHits).toBe(1)
    expect(engine.getRateLimitStats().robotsBlocked).toBe(1)
    const blockedNet = tab.getNetwork().at(-1)!
    expect(blockedNet.blocked).toBe(true)
    expect(blockedNet.blockedReason).toBe('robots.txt')

    // Allowed exception under /secret/public — uses cached robots.txt!
    const okNav = await tab.navigate(`${baseUrl}/secret/public`)
    expect(okNav.title).toBe('Page /secret/public')
    expect(robotsHits).toBe(1)

    // Redirect to a disallowed path is also blocked
    await expect(tab.navigate(`${baseUrl}/redirect-to-secret`)).rejects.toThrow(RobotsDisallowedError)
    expect(engine.getRateLimitStats().robotsBlocked).toBe(2)

    await engine.close()
  })

  it('enforces robots.txt Crawl-delay and X-RateLimit-Reset pacing across consecutive requests', async () => {
    robotsMode = 'crawl-delay'
    robotsHits = 0
    const sleeps: number[] = []
    let fakeNow = 1_700_000_000_000

    const engine = new LiteBrowserEngine({
      robots: { enabled: true, maxCrawlDelayMs: 5000 },
      robotsRetryHooks: {
        now: () => fakeNow,
        sleep: async (ms) => {
          sleeps.push(ms)
          fakeNow += ms
        },
      },
    })

    const tab = await engine.createTab()
    await tab.navigate(`${baseUrl}/page-1`)
    expect(sleeps).toEqual([]) // First request does not wait

    await tab.navigate(`${baseUrl}/page-2`)
    expect(sleeps).toEqual([1500]) // Second request waits Crawl-delay: 1.5s

    // Now test X-RateLimit-Remaining: 0 + RateLimit-Reset: 2 overriding cooldown
    await tab.navigate(`${baseUrl}/ratelimited-ok`)
    expect(sleeps).toEqual([1500, 1500])

    await tab.navigate(`${baseUrl}/page-3`)
    expect(sleeps).toEqual([1500, 1500, 2000])

    const stats = engine.getRateLimitStats()
    expect(stats.totalRateLimitWaits).toBe(3)
    expect(stats.totalRateLimitWaitMs).toBe(5000)

    await engine.close()
  })

  it('handles robots.txt 404 (allow-all) and 500 (failOpen true vs false)', async () => {
    robotsMode = '404'
    const engine = new LiteBrowserEngine({
      robots: { enabled: true, failOpen: true },
    })
    const tab = await engine.createTab()
    const nav404 = await tab.navigate(`${baseUrl}/secret/ok`)
    expect(nav404.title).toBe('Page /secret/ok')

    // 500 with failOpen: true -> allowed
    robotsMode = '500'
    engine.clearRobotsCache()
    const nav500Open = await tab.navigate(`${baseUrl}/secret/open`)
    expect(nav500Open.title).toBe('Page /secret/open')

    // 500 with failOpen: false -> blocked
    engine.setRobotsPolicy({ failOpen: false })
    engine.clearRobotsCache()
    await expect(tab.navigate(`${baseUrl}/secret/closed`)).rejects.toThrow(RobotsDisallowedError)

    await engine.close()
  })
})
