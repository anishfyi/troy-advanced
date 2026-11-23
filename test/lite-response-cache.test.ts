import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  LiteBrowserEngine,
  ResponseCache,
  normalizeCacheUrl,
  parseCacheControl,
} from '../src/index.js'

describe('ResponseCache unit tests (M40)', () => {
  it('parses Cache-Control directives cleanly', () => {
    const cc1 = parseCacheControl('public, max-age=120, must-revalidate')
    expect(cc1).toEqual({
      noStore: false,
      noCache: false,
      mustRevalidate: true,
      isPrivate: false,
      isPublic: true,
      maxAge: 120,
    })

    const cc2 = parseCacheControl('private, no-cache="Set-Cookie", no-store')
    expect(cc2.noStore).toBe(true)
    expect(cc2.noCache).toBe(true)
    expect(cc2.isPrivate).toBe(true)

    const cc3 = parseCacheControl('max-age=0, s-maxage=60')
    expect(cc3.maxAge).toBe(0)
    expect(cc3.sMaxAge).toBe(60)

    const cc4 = parseCacheControl('max-age=notanumber')
    expect(cc4.maxAge).toBeUndefined()
  })

  it('normalizes URLs by stripping fragments', () => {
    expect(normalizeCacheUrl('https://example.com/docs?q=1#top')).toBe('https://example.com/docs?q=1')
    expect(normalizeCacheUrl('https://example.com/docs#section')).toBe('https://example.com/docs')
  })

  it('enforces maxEntries and maxTotalBytes LRU eviction', () => {
    let now = 1_000
    const cache = new ResponseCache(
      { maxEntries: 2, maxTotalBytes: 100 },
      { now: () => now },
    )

    cache.store({
      url: 'http://example.test/a',
      status: 200,
      headers: { etag: '"a"', 'cache-control': 'max-age=60' },
      body: 'aaaaaaaaaa', // 10 bytes
    })
    cache.store({
      url: 'http://example.test/b',
      status: 200,
      headers: { etag: '"b"', 'cache-control': 'max-age=60' },
      body: 'bbbbbbbbbb', // 10 bytes
    })

    // Access /a so /b becomes the least-recently-used entry
    const hitA = cache.lookup('http://example.test/a')
    expect(hitA.status).toBe('fresh')

    // Adding /c should evict /b (LRU), keeping /a and /c
    cache.store({
      url: 'http://example.test/c',
      status: 200,
      headers: { etag: '"c"', 'cache-control': 'max-age=60' },
      body: 'cccccccccc',
    })

    expect(cache.has('http://example.test/a')).toBe(true)
    expect(cache.has('http://example.test/b')).toBe(false)
    expect(cache.has('http://example.test/c')).toBe(true)
    expect(cache.getStats().evictions).toBe(1)

    // Adding a 95-byte entry should evict older entries to stay under maxTotalBytes=100
    cache.store({
      url: 'http://example.test/big',
      status: 200,
      headers: { etag: '"big"' },
      body: 'x'.repeat(95),
    })
    expect(cache.has('http://example.test/big')).toBe(true)
    expect(cache.getStats().totalBytes).toBeLessThanOrEqual(100)
    expect(cache.getStats().entries).toBe(1)

    now += 1000
    expect(cache.list()[0]?.url).toBe('http://example.test/big')
  })

  it('respects Vary headers and Authorization isolation and skips Vary: *', () => {
    const cache = new ResponseCache()
    const storedWildcard = cache.store({
      url: 'http://example.test/wild',
      status: 200,
      headers: { etag: '"w1"', vary: '*' },
      body: 'wildcard',
    })
    expect(storedWildcard).toBe(false)

    cache.store({
      url: 'http://example.test/i18n',
      status: 200,
      headers: { etag: '"en"', 'cache-control': 'max-age=60', vary: 'Accept-Language' },
      requestHeaders: { 'accept-language': 'en-US' },
      body: 'Hello',
    })

    expect(cache.lookup('http://example.test/i18n', { 'accept-language': 'en-US' }).status).toBe('fresh')
    expect(cache.lookup('http://example.test/i18n', { 'accept-language': 'fr-FR' }).status).toBe('miss')

    cache.store({
      url: 'http://example.test/secret',
      status: 200,
      headers: { etag: '"s1"', 'cache-control': 'private, max-age=60' },
      requestHeaders: { authorization: 'Bearer token-1' },
      body: 'Secret 1',
    })
    expect(cache.lookup('http://example.test/secret', { authorization: 'Bearer token-1' }).status).toBe('fresh')
    expect(cache.lookup('http://example.test/secret', { authorization: 'Bearer token-2' }).status).toBe('miss')
  })

  it('supports Expires and Age headers for freshness computation', () => {
    let now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const cache = new ResponseCache({}, { now: () => now })

    cache.store({
      url: 'http://example.test/expires',
      status: 200,
      headers: {
        date: new Date(now).toUTCString(),
        expires: new Date(now + 30_000).toUTCString(),
        age: '10',
        etag: '"exp-1"',
      },
      body: 'expires body',
    })

    // Fresh for 20s (30s - 10s age)
    now += 15_000
    expect(cache.lookup('http://example.test/expires').status).toBe('fresh')

    now += 10_000 // total +25s -> stale
    const stale = cache.lookup('http://example.test/expires')
    expect(stale.status).toBe('stale')
    if (stale.status === 'stale') {
      expect(stale.conditionalHeaders['if-none-match']).toBe('"exp-1"')
    }
  })
})

describe('Lite engine ETag / If-None-Match response caching integration (M40)', () => {
  let server: http.Server
  let baseUrl = ''

  let etagVersion = 1
  let etagRequests = 0
  let etag304Count = 0
  let lastIfNoneMatch: string | undefined

  let weakRequests = 0
  let lastModRequests = 0
  let lastIfModifiedSince: string | undefined

  let maxAgeRequests = 0
  let maxAge304Count = 0

  let noStoreRequests = 0
  let noCacheRequests = 0

  let itemsList = ['Alpha']
  let itemsGetCount = 0

  const LAST_MODIFIED_DATE = 'Wed, 21 Oct 2025 07:28:00 GMT'

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/etag') {
        etagRequests += 1
        lastIfNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined
        const currentTag = `"v${etagVersion}"`
        if (lastIfNoneMatch === currentTag) {
          etag304Count += 1
          res.writeHead(304, {
            ETag: currentTag,
            'X-Revalidated': 'yes',
          })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: currentTag,
        })
        res.end(`<html><head><title>ETag v${etagVersion}</title></head><body><h1>Version ${etagVersion}</h1></body></html>`)
        return
      }

      if (url.pathname === '/weak-etag') {
        weakRequests += 1
        const tag = 'W/"weak-42"'
        if (req.headers['if-none-match'] === tag) {
          res.writeHead(304, { ETag: tag })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: tag,
        })
        res.end('<html><head><title>Weak ETag</title></head><body><p>Weakly validated</p></body></html>')
        return
      }

      if (url.pathname === '/last-modified') {
        lastModRequests += 1
        lastIfModifiedSince =
          typeof req.headers['if-modified-since'] === 'string' ? req.headers['if-modified-since'] : undefined
        if (lastIfModifiedSince === LAST_MODIFIED_DATE) {
          res.writeHead(304, { 'Last-Modified': LAST_MODIFIED_DATE })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Last-Modified': LAST_MODIFIED_DATE,
        })
        res.end('<html><head><title>Last Modified</title></head><body><p>Modified Check</p></body></html>')
        return
      }

      if (url.pathname === '/max-age') {
        maxAgeRequests += 1
        const tag = '"ma-1"'
        if (req.headers['if-none-match'] === tag) {
          maxAge304Count += 1
          res.writeHead(304, {
            ETag: tag,
            'Cache-Control': 'public, max-age=60',
          })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: tag,
          'Cache-Control': 'public, max-age=60',
        })
        res.end(`<html><head><title>Fresh Page</title></head><body><p>Hit #${maxAgeRequests}</p></body></html>`)
        return
      }

      if (url.pathname === '/no-store') {
        noStoreRequests += 1
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: '"ns-1"',
          'Cache-Control': 'no-store',
        })
        res.end(`<html><head><title>No Store ${noStoreRequests}</title></head><body><p>Fresh ${noStoreRequests}</p></body></html>`)
        return
      }

      if (url.pathname === '/no-cache') {
        noCacheRequests += 1
        const tag = '"nc-1"'
        if (req.headers['if-none-match'] === tag) {
          res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: tag,
          'Cache-Control': 'no-cache',
        })
        res.end('<html><head><title>No Cache</title></head><body><p>Always revalidate</p></body></html>')
        return
      }

      if (url.pathname === '/items') {
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            const params = new URLSearchParams(body)
            const item = params.get('item')
            if (item) itemsList.push(item)
            res.writeHead(303, { Location: '/items' })
            res.end()
          })
          return
        }
        itemsGetCount += 1
        const tag = `"items-${itemsList.length}"`
        if (req.headers['if-none-match'] === tag) {
          res.writeHead(304, { ETag: tag, 'Cache-Control': 'max-age=300' })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: tag,
          'Cache-Control': 'max-age=300',
        })
        res.end(
          `<html><head><title>Items (${itemsList.length})</title></head><body>` +
            `<ul>${itemsList.map((i) => `<li>${i}</li>`).join('')}</ul>` +
            `<form method="POST" action="/items"><input name="item" value="" /><button type="submit">Add</button></form>` +
            `</body></html>`,
        )
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends If-None-Match and serves cached body on 304 Not Modified, then updates when ETag changes', async () => {
    etagVersion = 1
    etagRequests = 0
    etag304Count = 0
    lastIfNoneMatch = undefined

    const engine = new LiteBrowserEngine({ cookieJarPath: null })
    const tab = await engine.createTab()

    // First read: 200 OK, stored in cache
    await tab.navigate(`${baseUrl}/etag`)
    let snap = await tab.snapshot()
    expect(snap.title).toBe('ETag v1')
    expect(snap.text).toContain('Version 1')
    expect(etagRequests).toBe(1)
    expect(lastIfNoneMatch).toBeUndefined()

    // Second read: sends If-None-Match: "v1", server replies 304 Not Modified
    await tab.navigate(`${baseUrl}/etag#section-2`)
    snap = await tab.snapshot()
    expect(snap.title).toBe('ETag v1')
    expect(snap.text).toContain('Version 1')
    expect(etagRequests).toBe(2)
    expect(etag304Count).toBe(1)
    expect(lastIfNoneMatch).toBe('"v1"')

    const net = await tab.getNetwork()
    const secondReq = net[net.length - 1]!
    expect(secondReq.status).toBe(304)
    expect(secondReq.ok).toBe(true)
    expect(secondReq.fromCache).toBe(true)
    expect(secondReq.cacheStatus).toBe('revalidated')
    expect(secondReq.encodedDataLength).toBe(0)

    const stats = engine.getCacheStats()
    expect(stats.revalidated).toBe(1)
    expect(stats.bytesSaved).toBeGreaterThan(0)

    // Mutate server resource -> new ETag "v2", server replies 200 OK
    etagVersion = 2
    await tab.navigate(`${baseUrl}/etag`)
    snap = await tab.snapshot()
    expect(snap.title).toBe('ETag v2')
    expect(snap.text).toContain('Version 2')
    expect(lastIfNoneMatch).toBe('"v1"')

    // Next read sends If-None-Match: "v2" -> 304 Not Modified
    await tab.navigate(`${baseUrl}/etag`)
    expect(lastIfNoneMatch).toBe('"v2"')
    expect(etag304Count).toBe(2)

    await engine.close()
  })

  it('supports weak ETags and Last-Modified / If-Modified-Since revalidation', async () => {
    weakRequests = 0
    lastModRequests = 0
    lastIfModifiedSince = undefined

    const engine = new LiteBrowserEngine({ cookieJarPath: null })
    const tab = await engine.createTab()

    await tab.navigate(`${baseUrl}/weak-etag`)
    await tab.navigate(`${baseUrl}/weak-etag`)
    expect(weakRequests).toBe(2)
    let net = await tab.getNetwork()
    expect(net[net.length - 1]?.status).toBe(304)
    expect(net[net.length - 1]?.cacheStatus).toBe('revalidated')

    await tab.navigate(`${baseUrl}/last-modified`)
    await tab.navigate(`${baseUrl}/last-modified`)
    expect(lastModRequests).toBe(2)
    expect(lastIfModifiedSince).toBe(LAST_MODIFIED_DATE)
    net = await tab.getNetwork()
    expect(net[net.length - 1]?.status).toBe(304)
    expect(net[net.length - 1]?.fromCache).toBe(true)

    await engine.close()
  })

  it('serves fresh max-age responses with zero network calls, and revalidates on reload or after expiry', async () => {
    maxAgeRequests = 0
    maxAge304Count = 0
    let now = 10_000

    const engine = new LiteBrowserEngine({
      cookieJarPath: null,
      cacheHooks: { now: () => now },
    })
    const tab1 = await engine.createTab()
    const tab2 = await engine.createTab()

    // First fetch hits server
    await tab1.navigate(`${baseUrl}/max-age`)
    expect(maxAgeRequests).toBe(1)

    // Second fetch from another tab while fresh: 0 network requests!
    now += 10_000 // +10s (< 60s max-age)
    await tab2.navigate(`${baseUrl}/max-age`)
    expect(maxAgeRequests).toBe(1) // untouched!
    const snap2 = await tab2.snapshot()
    expect(snap2.title).toBe('Fresh Page')
    expect(snap2.text).toContain('Hit #1')

    const net2 = await tab2.getNetwork()
    expect(net2[0]?.fromCache).toBe(true)
    expect(net2[0]?.cacheStatus).toBe('hit')
    expect(net2[0]?.encodedDataLength).toBe(0)
    expect(engine.getCacheStats().hits).toBe(1)

    // Explicit reload while still fresh forces conditional revalidation (304)
    await tab2.history('reload')
    expect(maxAgeRequests).toBe(2)
    expect(maxAge304Count).toBe(1)
    expect(engine.getCacheStats().revalidated).toBe(1)

    // Advance past 60s max-age -> next navigate revalidates via If-None-Match (304)
    now += 65_000
    await tab1.navigate(`${baseUrl}/max-age`)
    expect(maxAgeRequests).toBe(3)
    expect(maxAge304Count).toBe(2)

    await engine.close()
  })

  it('never caches Cache-Control: no-store and always revalidates Cache-Control: no-cache', async () => {
    noStoreRequests = 0
    noCacheRequests = 0

    const engine = new LiteBrowserEngine({ cookieJarPath: null })
    const tab = await engine.createTab()

    await tab.navigate(`${baseUrl}/no-store`)
    await tab.navigate(`${baseUrl}/no-store`)
    expect(noStoreRequests).toBe(2)
    const snap = await tab.snapshot()
    expect(snap.title).toBe('No Store 2')
    expect(engine.getResponseCache().has(`${baseUrl}/no-store`)).toBe(false)

    await tab.navigate(`${baseUrl}/no-cache`)
    await tab.navigate(`${baseUrl}/no-cache`)
    expect(noCacheRequests).toBe(2)
    const net = await tab.getNetwork()
    expect(net[net.length - 1]?.status).toBe(304)
    expect(net[net.length - 1]?.cacheStatus).toBe('revalidated')

    await engine.close()
  })

  it('invalidates cached GET entry after POST form submission (RFC 9111 §4.4)', async () => {
    itemsList = ['Alpha']
    itemsGetCount = 0

    const engine = new LiteBrowserEngine({ cookieJarPath: null })
    const tab = await engine.createTab()

    await tab.navigate(`${baseUrl}/items`)
    expect(itemsGetCount).toBe(1)

    // Cached fresh hit
    await tab.navigate(`${baseUrl}/items`)
    expect(itemsGetCount).toBe(1)

    // Fill and submit form (POST /items -> 303 /items)
    const snap = await tab.snapshot()
    const input = snap.elements.find((e) => e.name === 'item')!
    const btn = snap.elements.find((e) => e.role === 'button')!
    await tab.fill(input.selector, 'Beta')
    await tab.click(btn.selector)

    // Cache was invalidated on POST so GET /items fetched updated list!
    expect(itemsGetCount).toBe(2)
    const afterSnap = await tab.snapshot()
    expect(afterSnap.title).toBe('Items (2)')
    expect(afterSnap.text).toContain('Beta')
    expect(engine.getCacheStats().invalidations).toBeGreaterThanOrEqual(1)

    await engine.close()
  })

  it('supports disabling cache and clearing cache via BrowserManager options', async () => {
    etagVersion = 1
    etagRequests = 0

    const manager = await BrowserManager.create({
      engine: 'lite',
      memoryEnabled: false,
      cache: { enabled: false },
    })

    try {
      const tab = await manager.openTab(`${baseUrl}/etag`)
      await manager.runTool(tab.id, 'page_navigate', { url: `${baseUrl}/etag` })
      expect(etagRequests).toBe(2)

      const lite = manager.engine as LiteBrowserEngine
      expect(lite.getCachePolicy().enabled).toBe(false)
      expect(lite.getCacheStats().bypasses).toBeGreaterThanOrEqual(2)

      // Enable dynamically and verify clearCache(origin)
      lite.setCachePolicy({ enabled: true })
      await manager.runTool(tab.id, 'page_navigate', { url: `${baseUrl}/etag` })
      expect(lite.getCacheStats().entries).toBe(1)
      const cleared = lite.clearCache(baseUrl)
      expect(cleared).toBe(1)
      expect(lite.getCacheStats().entries).toBe(0)
    } finally {
      await manager.close()
    }
  })
})
