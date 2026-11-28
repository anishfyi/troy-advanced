import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'
import {
  AgentMetricsCollector,
  PROMETHEUS_CONTENT_TYPE,
  evaluateLivenessProbe,
  evaluateReadinessProbe,
  formatMetricsAscii,
  normalizeMetricsRoute,
  type RuntimeMetricsSource,
} from '../src/bridge/metrics.js'

function sendRawHttp(port: number, rawRequest: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(rawRequest)
    })
    const chunks: Buffer[] = []
    sock.setTimeout(3000)
    sock.on('data', (chunk) => chunks.push(chunk))
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const sep = raw.indexOf('\r\n\r\n')
      const head = sep >= 0 ? raw.slice(0, sep) : raw
      const body = sep >= 0 ? raw.slice(sep + 4) : ''
      const firstLine = head.split('\r\n')[0] ?? ''
      const statusCode = Number(firstLine.split(' ')[1] ?? 0)
      resolve({ statusCode, body })
    })
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error('raw HTTP request timed out'))
    })
    sock.on('error', reject)
  })
}

function makeBaseSource(overrides: Partial<RuntimeMetricsSource> = {}): RuntimeMetricsSource {
  return {
    version: '0.1.0',
    engine: 'lite',
    tabsTotal: 2,
    tabsOwned: 1,
    sessionsActive: 1,
    sseClients: 1,
    wsClients: 2,
    wsRequestsTotal: 15,
    crashRecoveriesTotal: 0,
    auditEventsTotal: 12,
    auditRefusalsTotal: 2,
    rateLimitBlockedTotal: 1,
    memoryEntriesTotal: 7,
    ready: true,
    ...overrides,
  }
}

describe('M83: Health-check HTTP probes & Prometheus /metrics (unit)', () => {
  it('normalizes known routes and collapses unknown paths to /other to prevent cardinality explosion', () => {
    expect(normalizeMetricsRoute('/health')).toBe('/health')
    expect(normalizeMetricsRoute('/healthz')).toBe('/healthz')
    expect(normalizeMetricsRoute('/readyz')).toBe('/readyz')
    expect(normalizeMetricsRoute('/metrics')).toBe('/metrics')
    expect(normalizeMetricsRoute('/tool')).toBe('/tool')
    expect(normalizeMetricsRoute('/random/404/path/12345')).toBe('/other')
    expect(normalizeMetricsRoute('/users/alice/secret')).toBe('/other')
  })

  it('tracks HTTP requests, tool latency percentiles, histograms, and renders valid Prometheus 0.0.4 text', () => {
    const startMs = 1_700_000_000_000
    const collector = new AgentMetricsCollector({ startedAtMs: startMs })

    collector.onHttpRequestStart()
    collector.recordHttpRequest({ method: 'POST', route: '/tool', status: 200, durationMs: 12 })
    collector.onHttpRequestStart()
    collector.recordHttpRequest({ method: 'GET', route: '/nonexistent-xyz', status: 404, durationMs: 3 })

    collector.recordToolCall({ tool: 'page_read', outcome: 'ok', durationMs: 10 })
    collector.recordToolCall({ tool: 'page_read', outcome: 'ok', durationMs: 20 })
    collector.recordToolCall({ tool: 'page_read', outcome: 'ok', durationMs: 60 })
    collector.recordToolCall({ tool: 'page_click', outcome: 'refused', durationMs: 2 })
    collector.recordToolCall({ tool: 'page_eval', outcome: 'error', durationMs: 150 })

    const nowMs = startMs + 42_500
    const snap = collector.getSnapshot(makeBaseSource(), nowMs)

    expect(snap.uptimeSeconds).toBe(42.5)
    expect(snap.memory.rssBytes).toBeGreaterThan(0)
    expect(snap.memory.rssMb).toBeGreaterThan(0)
    expect(snap.tabs).toEqual({ open: 2, owned: 1 })
    expect(snap.requests.total).toBe(2)
    expect(snap.requests.inFlight).toBe(0)
    expect(snap.requests.errors4xx).toBe(1)
    expect(snap.requests.byRoute['/tool']).toBe(1)
    expect(snap.requests.byRoute['/other']).toBe(1)

    expect(snap.tools.total).toBe(5)
    expect(snap.tools.ok).toBe(3)
    expect(snap.tools.refused).toBe(1)
    expect(snap.tools.error).toBe(1)

    const pageRead = snap.tools.byTool.find((t) => t.tool === 'page_read')
    expect(pageRead).toBeDefined()
    expect(pageRead!.count).toBe(3)
    expect(pageRead!.avgMs).toBe(30)
    expect(pageRead!.minMs).toBe(10)
    expect(pageRead!.maxMs).toBe(60)
    expect(pageRead!.p50Ms).toBe(20)
    expect(pageRead!.p95Ms).toBe(60)

    const prom = collector.renderPrometheus(makeBaseSource(), nowMs)
    expect(prom.endsWith('\n')).toBe(true)
    expect(prom).toContain('# TYPE troy_up gauge')
    expect(prom).toContain('troy_up 1')
    expect(prom).toContain('troy_uptime_seconds 42.5')
    expect(prom).toContain('troy_tabs_open 2')
    expect(prom).toContain('troy_tabs_owned 1')
    expect(prom).toContain('troy_process_resident_memory_bytes ')
    expect(prom).toContain('troy_http_requests_total{method="POST",route="/tool",status="200"} 1')
    expect(prom).toContain('troy_http_requests_total{method="GET",route="/other",status="404"} 1')
    expect(prom).toContain('troy_http_request_duration_seconds_bucket{route="/tool",le="+Inf"} 1')
    expect(prom).toContain('troy_tool_calls_total{tool="page_read",outcome="ok"} 3')
    expect(prom).toContain('troy_tool_calls_total{tool="page_click",outcome="refused"} 1')
    expect(prom).toContain('troy_tool_calls_total{tool="page_eval",outcome="error"} 1')
    expect(prom).toContain('troy_tool_duration_seconds_bucket{tool="page_read",le="0.025"} 2')
    expect(prom).toContain('troy_tool_duration_seconds_bucket{tool="page_read",le="+Inf"} 3')
    expect(prom).toContain('troy_tool_duration_seconds_count{tool="page_read"} 3')

    // ASCII dashboard is strictly 7-bit printable ASCII
    const ascii = formatMetricsAscii(snap, { width: 80 })
    expect(ascii).toContain('TROY ADVANCED METRICS (READY)')
    expect(ascii).toContain('page_read')
    expect(ascii).toContain('page_click')
    expect(/^[\x09\x0a\x0d\x20-\x7e]+$/.test(ascii)).toBe(true)
  })

  it('evaluates liveness and readiness probes with 200 vs 503', () => {
    const live = evaluateLivenessProbe(12.3456)
    expect(live.status).toBe(200)
    expect(live.payload).toEqual({ ok: true, status: 'ok', uptimeSeconds: 12.346 })

    const readyOk = evaluateReadinessProbe({ ready: true, engine: 'chromium' }, 5.5)
    expect(readyOk.status).toBe(200)
    expect(readyOk.payload).toEqual({ ok: true, status: 'ready', engine: 'chromium', uptimeSeconds: 5.5 })

    const readyFail = evaluateReadinessProbe(
      { ready: false, readyReason: 'chromium_max_restarts_exceeded', engine: 'chromium' },
      9.1,
    )
    expect(readyFail.status).toBe(503)
    expect(readyFail.payload).toEqual({
      ok: false,
      status: 'not_ready',
      engine: 'chromium',
      reason: 'chromium_max_restarts_exceeded',
      uptimeSeconds: 9.1,
    })
  })
})

describe('M83: Health-check HTTP probes & Prometheus /metrics (Agent Socket E2E)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!
      await fn().catch(() => {})
    }
  })

  async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Metrics Fixture</title></head><body><h1>Hello Metrics</h1><button>Go</button></body></html>')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    }
  }

  async function startAgent(opts: Parameters<typeof createAgentSocket>[1] = {}): Promise<{
    manager: BrowserManager
    socket: AgentSocketServer
    baseUrl: string
  }> {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const socket = await createAgentSocket(manager, opts)
    cleanups.push(async () => {
      await socket.close()
      await manager.close()
    })
    return { manager, socket, baseUrl: `http://127.0.0.1:${socket.port}` }
  }

  it('serves unauthenticated loopback GET/HEAD /healthz, /livez, /readyz and blocks forged Host headers', async () => {
    const { socket, baseUrl } = await startAgent()

    for (const p of ['/healthz', '/livez']) {
      const r = await fetch(`${baseUrl}${p}`)
      expect(r.status).toBe(200)
      const json = (await r.json()) as Record<string, unknown>
      expect(json.ok).toBe(true)
      expect(json.status).toBe('ok')
      expect(typeof json.uptimeSeconds).toBe('number')
      // Must not leak sensitive fields
      expect(json.agentToken).toBeUndefined()
      expect(json.tabs).toBeUndefined()
    }

    const readyRes = await fetch(`${baseUrl}/readyz`)
    expect(readyRes.status).toBe(200)
    const readyJson = (await readyRes.json()) as Record<string, unknown>
    expect(readyJson.ok).toBe(true)
    expect(readyJson.status).toBe('ready')
    expect(readyJson.engine).toBe('lite')

    // HEAD probes work cleanly with empty body
    const headHealthz = await fetch(`${baseUrl}/healthz`, { method: 'HEAD' })
    expect(headHealthz.status).toBe(200)
    expect(await headHealthz.text()).toBe('')

    const headReadyz = await fetch(`${baseUrl}/readyz`, { method: 'HEAD' })
    expect(headReadyz.status).toBe(200)
    expect(await headReadyz.text()).toBe('')

    // DNS rebinding Host header attack is still blocked on /healthz and /metrics
    const forged = await sendRawHttp(
      socket.port,
      'GET /healthz HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n',
    )
    expect(forged.statusCode).toBe(403)
  })

  it('requires auth on /healthz and /readyz when healthProbeUnauthenticated is false', async () => {
    const { socket, baseUrl } = await startAgent({ healthProbeUnauthenticated: false })

    const unauth = await fetch(`${baseUrl}/healthz`)
    expect(unauth.status).toBe(401)

    const auth = await fetch(`${baseUrl}/healthz`, {
      headers: { 'x-troy-agent': socket.token },
    })
    expect(auth.status).toBe(200)
    const json = (await auth.json()) as Record<string, unknown>
    expect(json.ok).toBe(true)
  })

  it('authenticates /metrics via x-troy-agent or Authorization: Bearer, and supports metricsUnauthenticated opt-in', async () => {
    const { socket, baseUrl } = await startAgent()

    // Unauthenticated rejected by default
    const unauth = await fetch(`${baseUrl}/metrics`)
    expect(unauth.status).toBe(401)

    // Invalid bearer rejected
    const badBearer = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: 'Bearer wrong-token-value' },
    })
    expect(badBearer.status).toBe(401)

    // Valid Authorization: Bearer <token> accepted (Prometheus scrape config)
    const bearerRes = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${socket.token}` },
    })
    expect(bearerRes.status).toBe(200)
    expect(bearerRes.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE)
    const promText = await bearerRes.text()
    expect(promText).toContain('troy_up 1')
    expect(promText).toContain('troy_process_resident_memory_bytes ')

    // Valid x-troy-agent accepted + ?format=json returns JSON snapshot
    const jsonRes = await fetch(`${baseUrl}/metrics?format=json`, {
      headers: { 'x-troy-agent': socket.token },
    })
    expect(jsonRes.status).toBe(200)
    const jsonBody = (await jsonRes.json()) as { ok: boolean; metrics: { engine: string; memory: { rssBytes: number } } }
    expect(jsonBody.ok).toBe(true)
    expect(jsonBody.metrics.engine).toBe('lite')
    expect(jsonBody.metrics.memory.rssBytes).toBeGreaterThan(0)

    // Opt-in unauthenticated loopback /metrics
    const publicAgent = await startAgent({ metricsUnauthenticated: true })
    const pubRes = await fetch(`${publicAgent.baseUrl}/metrics`)
    expect(pubRes.status).toBe(200)
    expect(await pubRes.text()).toContain('troy_info{')
  })

  it('records live tab counts, HTTP requests, memory RSS, uptime, and tool latency in /metrics and /health', async () => {
    const fixture = await startFixtureServer()
    cleanups.push(fixture.close)

    const { socket, baseUrl } = await startAgent()
    const headers = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

    // Open a tab
    const openRes = await fetch(`${baseUrl}/open`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: fixture.url, activate: true }),
    })
    expect(openRes.status).toBe(200)
    const opened = (await openRes.json()) as { ok: boolean; id: number }
    expect(opened.ok).toBe(true)

    // Invoke tools via /tool
    const readRes = await fetch(`${baseUrl}/tool`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: opened.id, name: 'page_read', args: {} }),
    })
    expect(readRes.status).toBe(200)
    expect(((await readRes.json()) as { ok: boolean }).ok).toBe(true)

    const findRes = await fetch(`${baseUrl}/tool`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: opened.id, name: 'page_find', args: { query: 'Go' } }),
    })
    expect(findRes.status).toBe(200)
    expect(((await findRes.json()) as { ok: boolean }).ok).toBe(true)

    // Trigger an unknown tool error
    const errRes = await fetch(`${baseUrl}/tool`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: opened.id, name: 'nonexistent_tool', args: {} }),
    })
    expect(errRes.status).toBe(200)
    expect(((await errRes.json()) as { ok: boolean }).ok).toBe(false)

    // Scrape Prometheus /metrics
    const promRes = await fetch(`${baseUrl}/metrics`, { headers: { 'x-troy-agent': socket.token } })
    expect(promRes.status).toBe(200)
    const prom = await promRes.text()

    expect(prom).toMatch(/troy_tabs_open [1-9]\d*/)
    expect(prom).toContain('troy_http_requests_total{method="POST",route="/open",status="200"} 1')
    expect(prom).toContain('troy_http_requests_total{method="POST",route="/tool",status="200"} 3')
    expect(prom).toContain('troy_tool_calls_total{tool="page_read",outcome="ok"} 1')
    expect(prom).toContain('troy_tool_calls_total{tool="page_find",outcome="ok"} 1')
    expect(prom).toContain('troy_tool_calls_total{tool="nonexistent_tool",outcome="error"} 1')
    expect(prom).toContain('troy_tool_duration_seconds_count{tool="page_read"} 1')
    expect(prom).toContain('troy_tool_duration_seconds_count{tool="page_find"} 1')
    expect(prom).toMatch(/troy_process_resident_memory_bytes [1-9]\d*/)

    // POST /metrics returns snapshot + prometheus + ascii
    const postMetricsRes = await fetch(`${baseUrl}/metrics`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ width: 78 }),
    })
    expect(postMetricsRes.status).toBe(200)
    const postMetrics = (await postMetricsRes.json()) as {
      ok: boolean
      prometheus: string
      ascii: string
      snapshot: { tools: { total: number; ok: number; error: number } }
    }
    expect(postMetrics.ok).toBe(true)
    expect(postMetrics.snapshot.tools.total).toBe(3)
    expect(postMetrics.snapshot.tools.ok).toBe(2)
    expect(postMetrics.snapshot.tools.error).toBe(1)
    expect(postMetrics.ascii).toContain('page_read')
    expect(postMetrics.prometheus).toContain('troy_tool_calls_total')

    // GET /health includes enriched uptimeSeconds, memory, and metrics summary
    const healthRes = await fetch(`${baseUrl}/health`, { headers: { 'x-troy-agent': socket.token } })
    expect(healthRes.status).toBe(200)
    const health = (await healthRes.json()) as {
      ok: boolean
      status: string
      uptimeSeconds: number
      memory: { rssBytes: number; rssMb: number }
      metrics: { requestsTotal: number; toolCallsTotal: number; avgToolLatencyMs: number }
    }
    expect(health.ok).toBe(true)
    expect(health.status).toBe('ok')
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(health.memory.rssBytes).toBeGreaterThan(0)
    expect(health.metrics.toolCallsTotal).toBe(3)
    expect(health.metrics.requestsTotal).toBeGreaterThanOrEqual(5)
  })

  it('returns 503 on /readyz when engine crash recovery enters failed state', async () => {
    const { manager, baseUrl } = await startAgent()
    const origGetStats = manager.getCrashRecoveryStats.bind(manager)
    manager.getCrashRecoveryStats = () => ({
      ...origGetStats(),
      status: 'failed',
      lastError: 'chromium_crashed_max_restarts',
    })

    const readyRes = await fetch(`${baseUrl}/readyz`)
    expect(readyRes.status).toBe(503)
    const body = (await readyRes.json()) as { ok: boolean; status: string; reason: string }
    expect(body.ok).toBe(false)
    expect(body.status).toBe('not_ready')
    expect(body.reason).toBe('chromium_crashed_max_restarts')
  })
})
