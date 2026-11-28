import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import {
  createAgentSocket,
  type AgentSocketOptions,
  type AgentSocketServer,
} from '../src/bridge/agent-socket.js'
import {
  AgentSocketRateLimiter,
  buildRateLimitHeaders,
} from '../src/bridge/rate-limit.js'

interface HttpResult {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
  json: Record<string, unknown> | null
}

function sendHttpRequest(opts: {
  port: number
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string | Buffer
  chunkedChunks?: Array<string | Buffer>
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/tabs',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: Record<string, unknown> | null = null
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            json = null
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
          })
        })
      },
    )

    // For oversized chunked uploads, the server may close the connection right after
    // sending 413 while the client is still writing remaining chunks. Ignore EPIPE/ECONNRESET
    // once a response is being received.
    let gotResponse = false
    req.on('response', () => {
      gotResponse = true
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (gotResponse && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) return
      reject(err)
    })

    if (opts.chunkedChunks) {
      for (const chunk of opts.chunkedChunks) {
        if (req.destroyed) break
        req.write(chunk)
      }
      if (!req.destroyed) req.end()
    } else if (opts.body !== undefined) {
      req.end(opts.body)
    } else {
      req.end()
    }
  })
}

function sendRawTcp(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(payload)
    })
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => chunks.push(c))
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (chunks.length > 0 && err.code === 'ECONNRESET') {
        resolve(Buffer.concat(chunks).toString('utf8'))
        return
      }
      reject(err)
    })
    sock.setTimeout(3000, () => {
      sock.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

// Deterministic PRNG (Mulberry32) for reproducible fuzzing.
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('M77: AgentSocketRateLimiter unit tests', () => {
  it('enforces sliding-window limits and recovers after windowMs', () => {
    let now = 1_000_000
    const limiter = new AgentSocketRateLimiter({
      maxRequests: 3,
      windowMs: 5_000,
      now: () => now,
    })

    const d1 = limiter.consume('session:a')
    expect(d1.allowed).toBe(true)
    expect(d1.remaining).toBe(2)

    now += 1_000
    const d2 = limiter.consume('session:a')
    expect(d2.allowed).toBe(true)
    expect(d2.remaining).toBe(1)

    now += 1_000
    const d3 = limiter.consume('session:a')
    expect(d3.allowed).toBe(true)
    expect(d3.remaining).toBe(0)

    // 4th request within window must be blocked
    const d4 = limiter.consume('session:a')
    expect(d4.allowed).toBe(false)
    expect(d4.reason).toBe('rate_limit_exceeded')
    expect(d4.retryAfterSeconds).toBe(3) // oldest was at t=1_000_000, now=1_002_000 -> 3s left

    const headers = buildRateLimitHeaders(d4)
    expect(headers['x-ratelimit-limit']).toBe('3')
    expect(headers['x-ratelimit-remaining']).toBe('0')
    expect(headers['retry-after']).toBe('3')

    // Advance past oldest timestamp (t=1_000_000 + 5_000 = 1_005_000)
    now = 1_005_001
    const d5 = limiter.consume('session:a')
    expect(d5.allowed).toBe(true)
    expect(d5.remaining).toBe(0)
  })

  it('isolates rate-limit buckets per key', () => {
    const limiter = new AgentSocketRateLimiter({ maxRequests: 2, windowMs: 10_000, now: () => 50_000 })
    expect(limiter.consume('session:alpha').allowed).toBe(true)
    expect(limiter.consume('session:alpha').allowed).toBe(true)
    expect(limiter.consume('session:alpha').allowed).toBe(false)

    // session:beta still has full quota
    expect(limiter.consume('session:beta').allowed).toBe(true)
    expect(limiter.consume('session:beta').allowed).toBe(true)
    expect(limiter.consume('session:beta').allowed).toBe(false)
  })

  it('enforces auth-failure lockout and recovers after authWindowMs', () => {
    let now = 200_000
    const limiter = new AgentSocketRateLimiter({
      maxAuthFailures: 3,
      authWindowMs: 10_000,
      now: () => now,
    })

    expect(limiter.checkAuthAllowed('127.0.0.1').allowed).toBe(true)
    limiter.recordAuthFailure('127.0.0.1')
    limiter.recordAuthFailure('127.0.0.1')
    expect(limiter.checkAuthAllowed('127.0.0.1').allowed).toBe(true)

    limiter.recordAuthFailure('127.0.0.1')
    const blocked = limiter.checkAuthAllowed('127.0.0.1')
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('auth_rate_limit_exceeded')
    expect(blocked.retryAfterSeconds).toBe(10)

    const stats = limiter.getStats()
    expect(stats.authBlocked).toBe(1)
    expect(stats.totalBlocked).toBe(1)

    now += 10_001
    expect(limiter.checkAuthAllowed('127.0.0.1').allowed).toBe(true)
  })

  it('bounds memory via maxBuckets LRU eviction under key-flood fuzzing', () => {
    let now = 10_000
    const limiter = new AgentSocketRateLimiter({
      maxRequests: 5,
      windowMs: 60_000,
      maxBuckets: 16,
      now: () => now,
    })

    for (let i = 0; i < 500; i++) {
      now += 1
      limiter.consume(`fuzz-key-${i}`)
    }

    const stats = limiter.getStats()
    expect(stats.activeBuckets).toBeLessThanOrEqual(16)
    expect(stats.totalAllowed).toBe(500)
  })

  it('allows all traffic when disabled and clamps invalid numeric options', () => {
    const disabled = new AgentSocketRateLimiter({
      enabled: false,
      maxRequests: -5,
      windowMs: 0,
      maxBuckets: Number.NaN,
    })
    for (let i = 0; i < 20; i++) {
      expect(disabled.consume('k').allowed).toBe(true)
    }
    expect(disabled.config.maxRequests).toBe(1)
    expect(disabled.config.windowMs).toBe(10)
    expect(disabled.config.maxBuckets).toBe(1024)
  })
})

describe('M77: Agent Socket HTTP rate-limiting & body-size fuzz tests', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!
      await fn().catch(() => {})
    }
  })

  async function startSocket(opts: AgentSocketOptions = {}): Promise<{
    socket: AgentSocketServer
    manager: BrowserManager
  }> {
    const manager = await BrowserManager.create({ engine: 'lite', memory: false })
    const socket = await createAgentSocket(manager, { port: 0, ...opts })

    cleanups.push(async () => {
      await socket.close()
      await manager.close()
    })

    return { socket, manager }
  }

  it('enforces HTTP request rate limit with 429, Retry-After, and window recovery', async () => {
    const { socket } = await startSocket({
      rateLimit: { maxRequests: 4, windowMs: 180 },
    })

    const headers = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

    for (let i = 0; i < 4; i++) {
      const res = await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers })
      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe('4')
      expect(res.headers['x-ratelimit-remaining']).toBe(String(3 - i))
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0)
    }

    const blocked = await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers })
    expect(blocked.status).toBe(429)
    expect(blocked.json?.ok).toBe(false)
    expect(blocked.json?.code).toBe('rate_limit_exceeded')
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0')

    // Wait for window to slide past
    await new Promise((r) => setTimeout(r, 220))

    const recovered = await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers })
    expect(recovered.status).toBe(200)
    const rlStats = recovered.json?.rateLimit as Record<string, unknown>
    expect(rlStats.totalAllowed).toBe(5)
    expect(rlStats.totalBlocked).toBe(1)
  })

  it('isolates HTTP rate limits across distinct x-troy-session headers', async () => {
    const { socket } = await startSocket({
      rateLimit: { maxRequests: 2, windowMs: 5_000 },
    })

    const headersA = { 'x-troy-agent': socket.token, 'x-troy-session': 'agent-a' }
    const headersB = { 'x-troy-agent': socket.token, 'x-troy-session': 'agent-b' }

    expect((await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers: headersA })).status).toBe(200)
    expect((await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers: headersA })).status).toBe(200)
    expect((await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers: headersA })).status).toBe(429)

    // agent-b is unaffected by agent-a's exhaustion
    const resB = await sendHttpRequest({ port: socket.port, method: 'GET', path: '/health', headers: headersB })
    expect(resB.status).toBe(200)
    expect(resB.headers['x-ratelimit-remaining']).toBe('1')
  })

  it('rate-limits auth brute-force attempts with 429 auth_rate_limit_exceeded', async () => {
    const { socket } = await startSocket({
      rateLimit: { maxAuthFailures: 3, authWindowMs: 5_000, maxRequests: 100, windowMs: 5_000 },
    })

    for (let i = 0; i < 3; i++) {
      const bad = await sendHttpRequest({
        port: socket.port,
        method: 'GET',
        path: '/health',
        headers: { 'x-troy-agent': `wrong-token-${i}` },
      })
      expect(bad.status).toBe(401)
    }

    const lockedOut = await sendHttpRequest({
      port: socket.port,
      method: 'GET',
      path: '/health',
      headers: { 'x-troy-agent': 'wrong-token-4' },
    })
    expect(lockedOut.status).toBe(429)
    expect(lockedOut.json?.code).toBe('auth_rate_limit_exceeded')
    expect(Number(lockedOut.headers['retry-after'])).toBeGreaterThanOrEqual(1)
  })

  it('enforces exact maxBodyBytes boundary on standard POST and maxImportBodyBytes on import routes', async () => {
    const maxBodyBytes = 256
    const maxImportBodyBytes = 1024
    const { socket } = await startSocket({
      maxBodyBytes,
      maxImportBodyBytes,
      rateLimit: { enabled: false },
    })
    const baseHeaders = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

    // Exact maxBodyBytes payload -> 200
    const prefix = '{"pad":"'
    const suffix = '"}'
    const exactBody = prefix + 'a'.repeat(maxBodyBytes - prefix.length - suffix.length) + suffix
    expect(Buffer.byteLength(exactBody)).toBe(maxBodyBytes)

    const okRes = await sendHttpRequest({
      port: socket.port,
      path: '/tabs',
      headers: { ...baseHeaders, 'content-length': String(Buffer.byteLength(exactBody)) },
      body: exactBody,
    })
    expect(okRes.status).toBe(200)
    expect(okRes.json?.ok).toBe(true)

    // maxBodyBytes + 1 -> 413
    const overBody = prefix + 'a'.repeat(maxBodyBytes - prefix.length - suffix.length + 1) + suffix
    expect(Buffer.byteLength(overBody)).toBe(maxBodyBytes + 1)

    const overRes = await sendHttpRequest({
      port: socket.port,
      path: '/tabs',
      headers: { ...baseHeaders, 'content-length': String(Buffer.byteLength(overBody)) },
      body: overBody,
    })
    expect(overRes.status).toBe(413)
    expect(overRes.json?.ok).toBe(false)
    expect(overRes.json?.code).toBe('body_too_large')
    expect(overRes.json?.maxBytes).toBe(maxBodyBytes)

    // Import route accepts > maxBodyBytes up to maxImportBodyBytes
    const importPayload = JSON.stringify({
      cookies: [{ name: 'c', value: 'x'.repeat(400), domain: 'example.com', path: '/' }],
    })
    expect(Buffer.byteLength(importPayload)).toBeGreaterThan(maxBodyBytes)
    expect(Buffer.byteLength(importPayload)).toBeLessThanOrEqual(maxImportBodyBytes)

    const importOk = await sendHttpRequest({
      port: socket.port,
      path: '/cookies/import',
      headers: { ...baseHeaders, 'content-length': String(Buffer.byteLength(importPayload)) },
      body: importPayload,
    })
    expect(importOk.status).toBe(200)

    // Import route rejects > maxImportBodyBytes with 413
    const importOver = JSON.stringify({
      cookies: [{ name: 'c', value: 'x'.repeat(maxImportBodyBytes + 50), domain: 'example.com', path: '/' }],
    })
    const importTooBig = await sendHttpRequest({
      port: socket.port,
      path: '/cookies/import',
      headers: { ...baseHeaders, 'content-length': String(Buffer.byteLength(importOver)) },
      body: importOver,
    })
    expect(importTooBig.status).toBe(413)
    expect(importTooBig.json?.code).toBe('body_too_large')
    expect(importTooBig.json?.maxBytes).toBe(maxImportBodyBytes)
  })

  it('rejects oversized Transfer-Encoding: chunked streams cleanly with 413 without hanging', async () => {
    const maxBodyBytes = 512
    const { socket } = await startSocket({
      maxBodyBytes,
      rateLimit: { enabled: false },
    })

    // Stream 32 chunks of 64 bytes = 2048 bytes (> 512) with no Content-Length
    const chunks = Array.from({ length: 32 }, (_, i) => (i === 0 ? '{"d":"' + 'z'.repeat(58) : 'z'.repeat(64)))
    chunks.push('"}')

    const res = await sendHttpRequest({
      port: socket.port,
      path: '/tabs',
      headers: {
        'x-troy-agent': socket.token,
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
      chunkedChunks: chunks,
    })
    expect(res.status).toBe(413)
    expect(res.json?.ok).toBe(false)
    expect(res.json?.code).toBe('body_too_large')

    // Server must remain completely healthy after chunked overflow
    const health = await sendHttpRequest({
      port: socket.port,
      method: 'GET',
      path: '/health',
      headers: { 'x-troy-agent': socket.token },
    })
    expect(health.status).toBe(200)
    expect(health.json?.ok).toBe(true)
  })

  it('rejects non-object JSON primitives with 400 invalid_json_object and strips prototype pollution keys', async () => {
    const { socket } = await startSocket({ rateLimit: { enabled: false } })
    const headers = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

    const nonObjects = ['null', 'true', 'false', '42', '"hello"', '[]', '[1,2,3]']
    for (const payload of nonObjects) {
      const res = await sendHttpRequest({ port: socket.port, path: '/tabs', headers, body: payload })
      expect(res.status).toBe(400)
      expect(res.json?.ok).toBe(false)
      expect(res.json?.code).toBe('invalid_json_object')
    }

    // Prototype pollution payload must not pollute Object.prototype
    const protoPayload = '{"__proto__":{"pollutedM77":true},"constructor":{"prototype":{"pollutedM77":true}},"ok":1}'
    const protoRes = await sendHttpRequest({ port: socket.port, path: '/tabs', headers, body: protoPayload })
    expect(protoRes.status).toBe(200)
    expect(({} as Record<string, unknown>).pollutedM77).toBeUndefined()
  })

  it('survives deterministic body-size, binary, UTF-8, and malformed-JSON fuzz corpus without 500s', async () => {
    const maxBodyBytes = 1024
    const { socket } = await startSocket({
      maxBodyBytes,
      rateLimit: { enabled: false },
    })
    const rng = createSeededRng(0x77_2026)
    const headers = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

    const staticCorpus: Array<string | Buffer> = [
      '{',
      '}',
      '{"unclosed": "str',
      '{"a": NaN}',
      '{"a": undefined}',
      '{"a": [1, 2,]}',
      '\u0000\u0001\u0002\u00ff',
      Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x7b, 0x22, 0x80, 0x99]),
      '{"deep":' + '['.repeat(300) + ']'.repeat(300) + '}',
      '{"nul":"\u0000"}',
      '   \t\n\r   ', // whitespace-only -> valid empty object {}
      '{"a": "' + '🚀'.repeat(400) + '"}', // multi-byte UTF-8 > 1024 bytes
    ]

    // Generate 50 seeded random fuzz payloads (random bytes, truncated JSON, oversized strings)
    const generatedCorpus: Array<string | Buffer> = []
    for (let i = 0; i < 50; i++) {
      const mode = i % 4
      if (mode === 0) {
        // Random raw bytes
        const len = Math.floor(rng() * 1400) + 1
        const buf = Buffer.allocUnsafe(len)
        for (let b = 0; b < len; b++) buf[b] = Math.floor(rng() * 256)
        generatedCorpus.push(buf)
      } else if (mode === 1) {
        // Truncated JSON object
        const full = JSON.stringify({ key: 'x'.repeat(Math.floor(rng() * 500)), n: i })
        const cut = Math.max(1, Math.floor(rng() * (full.length - 1)))
        generatedCorpus.push(full.slice(0, cut))
      } else if (mode === 2) {
        // Oversized valid JSON object
        const len = maxBodyBytes + Math.floor(rng() * 1024) + 1
        generatedCorpus.push(`{"blob":"${'A'.repeat(len)}"}`)
      } else {
        // Random ASCII garbage
        const len = Math.floor(rng() * 300) + 1
        let s = ''
        for (let c = 0; c < len; c++) s += String.fromCharCode(32 + Math.floor(rng() * 95))
        generatedCorpus.push(s)
      }
    }

    const allPayloads = [...staticCorpus, ...generatedCorpus]
    for (const payload of allPayloads) {
      const byteLen = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, 'utf8')
      const res = await sendHttpRequest({
        port: socket.port,
        path: '/tabs',
        headers: { ...headers, 'content-length': String(byteLen) },
        body: payload,
      })
      // Never 500! Must be 200 (if accidentally valid small JSON object or whitespace), 400, or 413.
      expect([200, 400, 413]).toContain(res.status)
      if (byteLen > maxBodyBytes) {
        expect(res.status).toBe(413)
      }
    }

    // Verify server is still 100% operational after the fuzz storm
    const health = await sendHttpRequest({
      port: socket.port,
      method: 'GET',
      path: '/health',
      headers: { 'x-troy-agent': socket.token },
    })
    expect(health.status).toBe(200)
    expect(health.json?.ok).toBe(true)
  })

  it('rejects oversized URLs with 414 and malformed raw Content-Length with 400', async () => {
    const { socket } = await startSocket({
      maxUrlLength: 256,
      rateLimit: { enabled: false },
    })

    const longPath = '/health?' + 'q='.concat('x'.repeat(300))
    const uriRes = await sendHttpRequest({
      port: socket.port,
      method: 'GET',
      path: longPath,
      headers: { 'x-troy-agent': socket.token },
    })
    expect(uriRes.status).toBe(414)
    expect(uriRes.json?.code).toBe('uri_too_long')

    // Raw TCP request with malformed negative Content-Length
    const rawResp = await sendRawTcp(
      socket.port,
      `POST /tabs HTTP/1.1\r\nHost: 127.0.0.1:${socket.port}\r\nx-troy-agent: ${socket.token}\r\nContent-Length: -5\r\nConnection: close\r\n\r\n`,
    )
    expect(rawResp).toMatch(/^HTTP\/1\.1 400 /)
  })

  it('handles concurrent mixed storm of valid, oversized chunked, and malformed requests cleanly', async () => {
    const { socket } = await startSocket({
      maxBodyBytes: 512,
      rateLimit: { enabled: false },
    })
    const headers = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

    const tasks = Array.from({ length: 24 }, (_, idx) => {
      if (idx % 3 === 0) {
        return sendHttpRequest({ port: socket.port, path: '/tabs', headers, body: '{}' }).then((r) => ({
          kind: 'valid',
          status: r.status,
        }))
      }
      if (idx % 3 === 1) {
        return sendHttpRequest({
          port: socket.port,
          path: '/tabs',
          headers: { ...headers, 'transfer-encoding': 'chunked' },
          chunkedChunks: Array.from({ length: 16 }, () => 'x'.repeat(64)),
        }).then((r) => ({ kind: 'chunked_over', status: r.status }))
      }
      return sendHttpRequest({
        port: socket.port,
        path: '/tabs',
        headers,
        body: '{broken-json',
      }).then((r) => ({ kind: 'malformed', status: r.status }))
    })

    const results = await Promise.all(tasks)
    for (const r of results) {
      if (r.kind === 'valid') expect(r.status).toBe(200)
      if (r.kind === 'chunked_over') expect(r.status).toBe(413)
      if (r.kind === 'malformed') expect(r.status).toBe(400)
    }

    const health = await sendHttpRequest({
      port: socket.port,
      method: 'GET',
      path: '/health',
      headers: { 'x-troy-agent': socket.token },
    })
    expect(health.status).toBe(200)
    expect(health.json?.ok).toBe(true)
  })
})
