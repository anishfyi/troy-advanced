// Prometheus-compatible metrics collector & health-probe evaluator for Troy Advanced.
// Tracks tabs, HTTP requests, memory RSS/heap, uptime, and per-tool execution latency
// with zero external dependencies and bounded label cardinality.

import { sanitizeAscii } from '../ascii/sanitize.js'

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

export const DEFAULT_HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const

export const DEFAULT_TOOL_DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const

const KNOWN_ROUTES = new Set<string>([
  '/health',
  '/healthz',
  '/livez',
  '/readyz',
  '/metrics',
  '/policy',
  '/origins',
  '/sessions',
  '/tabs',
  '/open',
  '/activate',
  '/close',
  '/grant-origin',
  '/ascii',
  '/markdown',
  '/extract',
  '/tool',
  '/recall',
  '/forget',
  '/memory',
  '/cookies/export',
  '/cookies/import',
  '/cookies/clear',
  '/storage/inspect',
  '/storage/export',
  '/storage/import',
  '/storage/clear',
  '/network',
  '/emulation',
  '/downloads',
  '/dialogs',
  '/audit',
  '/loop-guard',
  '/stream',
  '/ws',
])

export type ToolOutcome = 'ok' | 'error' | 'refused'

export interface MetricsCollectorOptions {
  startedAtMs?: number
  httpBuckets?: readonly number[]
  toolBuckets?: readonly number[]
  maxSamplesPerTool?: number
}

export interface RuntimeMetricsSource {
  version?: string
  engine: string
  tabsTotal: number
  tabsOwned: number
  sessionsActive: number
  sseClients: number
  wsClients: number
  wsRequestsTotal: number
  crashRecoveriesTotal: number
  auditEventsTotal: number
  auditRefusalsTotal: number
  rateLimitBlockedTotal: number
  memoryEntriesTotal: number
  ready: boolean
  readyReason?: string
  memoryWatchdog?: {
    enabled: boolean
    maxRssBytes: number
    pressureEventsTotal: number
    evictedTabsTotal: number
    gcHintsTotal: number
    gcInvokedTotal: number
  }
}

export interface ToolLatencySummary {
  tool: string
  count: number
  ok: number
  error: number
  refused: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p95Ms: number
  lastMs: number
}

export interface MetricsSnapshot {
  timestamp: string
  uptimeSeconds: number
  processUptimeSeconds: number
  version: string
  engine: string
  ready: boolean
  readyReason?: string
  tabs: {
    open: number
    owned: number
  }
  sessions: {
    active: number
  }
  memory: {
    rssBytes: number
    rssMb: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
  }
  requests: {
    total: number
    inFlight: number
    errors4xx: number
    errors5xx: number
    byRoute: Record<string, number>
    byStatus: Record<string, number>
  }
  tools: {
    total: number
    ok: number
    error: number
    refused: number
    avgLatencyMs: number
    byTool: ToolLatencySummary[]
  }
  connections: {
    sseClients: number
    wsClients: number
    wsRequestsTotal: number
  }
  security: {
    auditEventsTotal: number
    auditRefusalsTotal: number
    rateLimitBlockedTotal: number
  }
  memoryWatchdog?: {
    enabled: boolean
    maxRssBytes: number
    pressureEventsTotal: number
    evictedTabsTotal: number
    gcHintsTotal: number
    gcInvokedTotal: number
  }
  reliability: {
    crashRecoveriesTotal: number
  }
  pageMemory: {
    entriesTotal: number
  }
}

export interface HealthProbePayload {
  ok: boolean
  status: 'ok' | 'ready' | 'not_ready'
  uptimeSeconds: number
  engine?: string
  reason?: string
}

interface HistogramState {
  bucketCounts: number[]
  sumSeconds: number
  count: number
}

interface ToolStatsInternal {
  count: number
  ok: number
  error: number
  refused: number
  totalMs: number
  minMs: number
  maxMs: number
  lastMs: number
  samplesMs: number[]
  histogram: HistogramState
}

function escapePromLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return ''
  return `{${entries.map(([k, v]) => `${k}="${escapePromLabelValue(v)}"`).join(',')}}`
}

function formatPromNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Object.is(n, -0)) return '0'
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function createHistogram(buckets: readonly number[]): HistogramState {
  return {
    bucketCounts: new Array<number>(buckets.length).fill(0),
    sumSeconds: 0,
    count: 0,
  }
}

function observeHistogram(state: HistogramState, buckets: readonly number[], seconds: number): void {
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0
  state.count += 1
  state.sumSeconds += safeSeconds
  for (let i = 0; i < buckets.length; i++) {
    if (safeSeconds <= buckets[i]!) {
      state.bucketCounts[i]! += 1
    }
  }
}

export function normalizeMetricsRoute(pathname: string): string {
  if (KNOWN_ROUTES.has(pathname)) return pathname
  return '/other'
}

export function normalizeToolLabel(tool: string): string {
  const cleaned = String(tool ?? '').trim().slice(0, 64)
  if (!cleaned) return 'unknown'
  return cleaned.replace(/[^a-zA-Z0-9_:-]/g, '_')
}

export function evaluateLivenessProbe(uptimeSeconds: number): { status: number; payload: HealthProbePayload } {
  return {
    status: 200,
    payload: {
      ok: true,
      status: 'ok',
      uptimeSeconds: round3(Math.max(0, uptimeSeconds)),
    },
  }
}

export function evaluateReadinessProbe(
  source: Pick<RuntimeMetricsSource, 'ready' | 'readyReason' | 'engine'>,
  uptimeSeconds: number,
): { status: number; payload: HealthProbePayload } {
  if (source.ready) {
    return {
      status: 200,
      payload: {
        ok: true,
        status: 'ready',
        engine: source.engine,
        uptimeSeconds: round3(Math.max(0, uptimeSeconds)),
      },
    }
  }
  return {
    status: 503,
    payload: {
      ok: false,
      status: 'not_ready',
      engine: source.engine,
      reason: source.readyReason ?? 'engine_not_ready',
      uptimeSeconds: round3(Math.max(0, uptimeSeconds)),
    },
  }
}

export class AgentMetricsCollector {
  private readonly startedAtMs: number
  private readonly httpBuckets: readonly number[]
  private readonly toolBuckets: readonly number[]
  private readonly maxSamplesPerTool: number

  private httpInFlight = 0
  private httpRequestsTotal = 0
  private httpErrors4xx = 0
  private httpErrors5xx = 0
  private readonly httpByKey = new Map<string, { method: string; route: string; status: string; count: number }>()
  private readonly httpByRoute = new Map<string, number>()
  private readonly httpByStatus = new Map<string, number>()
  private readonly httpDurationByRoute = new Map<string, HistogramState>()

  private toolCallsTotal = 0
  private toolOkTotal = 0
  private toolErrorTotal = 0
  private toolRefusedTotal = 0
  private toolTotalMs = 0
  private readonly tools = new Map<string, ToolStatsInternal>()

  constructor(opts: MetricsCollectorOptions = {}) {
    this.startedAtMs = typeof opts.startedAtMs === 'number' ? opts.startedAtMs : Date.now()
    this.httpBuckets = opts.httpBuckets?.length ? [...opts.httpBuckets].sort((a, b) => a - b) : DEFAULT_HTTP_DURATION_BUCKETS
    this.toolBuckets = opts.toolBuckets?.length ? [...opts.toolBuckets].sort((a, b) => a - b) : DEFAULT_TOOL_DURATION_BUCKETS
    this.maxSamplesPerTool = Math.max(16, Math.min(2000, opts.maxSamplesPerTool ?? 256))
  }

  uptimeSeconds(nowMs = Date.now()): number {
    return Math.max(0, (nowMs - this.startedAtMs) / 1000)
  }

  onHttpRequestStart(): void {
    this.httpInFlight += 1
  }

  recordHttpRequest(params: {
    method: string
    route: string
    status: number
    durationMs: number
    decrementInFlight?: boolean
  }): void {
    if (params.decrementInFlight !== false && this.httpInFlight > 0) {
      this.httpInFlight -= 1
    }
    const method = (params.method || 'GET').toUpperCase()
    const route = normalizeMetricsRoute(params.route)
    const statusNum = Number.isFinite(params.status) ? Math.floor(params.status) : 0
    const statusStr = String(statusNum)
    const durationMs = Number.isFinite(params.durationMs) && params.durationMs >= 0 ? params.durationMs : 0

    this.httpRequestsTotal += 1
    if (statusNum >= 400 && statusNum < 500) this.httpErrors4xx += 1
    if (statusNum >= 500) this.httpErrors5xx += 1

    const key = `${method}\0${route}\0${statusStr}`
    const existing = this.httpByKey.get(key)
    if (existing) {
      existing.count += 1
    } else {
      this.httpByKey.set(key, { method, route, status: statusStr, count: 1 })
    }

    this.httpByRoute.set(route, (this.httpByRoute.get(route) ?? 0) + 1)
    this.httpByStatus.set(statusStr, (this.httpByStatus.get(statusStr) ?? 0) + 1)

    let hist = this.httpDurationByRoute.get(route)
    if (!hist) {
      hist = createHistogram(this.httpBuckets)
      this.httpDurationByRoute.set(route, hist)
    }
    observeHistogram(hist, this.httpBuckets, durationMs / 1000)
  }

  recordToolCall(params: { tool: string; outcome: ToolOutcome; durationMs: number }): void {
    const tool = normalizeToolLabel(params.tool)
    const durationMs = Number.isFinite(params.durationMs) && params.durationMs >= 0 ? params.durationMs : 0

    this.toolCallsTotal += 1
    this.toolTotalMs += durationMs
    if (params.outcome === 'ok') this.toolOkTotal += 1
    else if (params.outcome === 'refused') this.toolRefusedTotal += 1
    else this.toolErrorTotal += 1

    let entry = this.tools.get(tool)
    if (!entry) {
      entry = {
        count: 0,
        ok: 0,
        error: 0,
        refused: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
        lastMs: 0,
        samplesMs: [],
        histogram: createHistogram(this.toolBuckets),
      }
      this.tools.set(tool, entry)
    }

    entry.count += 1
    if (params.outcome === 'ok') entry.ok += 1
    else if (params.outcome === 'refused') entry.refused += 1
    else entry.error += 1
    entry.totalMs += durationMs
    if (durationMs < entry.minMs) entry.minMs = durationMs
    if (durationMs > entry.maxMs) entry.maxMs = durationMs
    entry.lastMs = durationMs
    entry.samplesMs.push(durationMs)
    if (entry.samplesMs.length > this.maxSamplesPerTool) {
      entry.samplesMs.shift()
    }
    observeHistogram(entry.histogram, this.toolBuckets, durationMs / 1000)
  }

  getSnapshot(source: RuntimeMetricsSource, nowMs = Date.now()): MetricsSnapshot {
    const mem = process.memoryUsage()
    const uptimeSec = round3(this.uptimeSeconds(nowMs))
    const procUptimeSec = round3(process.uptime())

    const byRoute: Record<string, number> = {}
    for (const [route, count] of [...this.httpByRoute.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      byRoute[route] = count
    }

    const byStatus: Record<string, number> = {}
    for (const [status, count] of [...this.httpByStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      byStatus[status] = count
    }

    const byTool: ToolLatencySummary[] = [...this.tools.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tool, st]) => {
        const sorted = [...st.samplesMs].sort((a, b) => a - b)
        return {
          tool,
          count: st.count,
          ok: st.ok,
          error: st.error,
          refused: st.refused,
          totalMs: round3(st.totalMs),
          avgMs: st.count > 0 ? round3(st.totalMs / st.count) : 0,
          minMs: Number.isFinite(st.minMs) ? round3(st.minMs) : 0,
          maxMs: round3(st.maxMs),
          p50Ms: round3(percentile(sorted, 50)),
          p95Ms: round3(percentile(sorted, 95)),
          lastMs: round3(st.lastMs),
        }
      })

    return {
      timestamp: new Date(nowMs).toISOString(),
      uptimeSeconds: uptimeSec,
      processUptimeSeconds: procUptimeSec,
      version: source.version ?? '0.1.0',
      engine: source.engine,
      ready: source.ready,
      ...(source.readyReason ? { readyReason: source.readyReason } : {}),
      tabs: {
        open: source.tabsTotal,
        owned: source.tabsOwned,
      },
      sessions: {
        active: source.sessionsActive,
      },
      memory: {
        rssBytes: mem.rss,
        rssMb: round3(mem.rss / (1024 * 1024)),
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      requests: {
        total: this.httpRequestsTotal,
        inFlight: this.httpInFlight,
        errors4xx: this.httpErrors4xx,
        errors5xx: this.httpErrors5xx,
        byRoute,
        byStatus,
      },
      tools: {
        total: this.toolCallsTotal,
        ok: this.toolOkTotal,
        error: this.toolErrorTotal,
        refused: this.toolRefusedTotal,
        avgLatencyMs: this.toolCallsTotal > 0 ? round3(this.toolTotalMs / this.toolCallsTotal) : 0,
        byTool,
      },
      connections: {
        sseClients: source.sseClients,
        wsClients: source.wsClients,
        wsRequestsTotal: source.wsRequestsTotal,
      },
      security: {
        auditEventsTotal: source.auditEventsTotal,
        auditRefusalsTotal: source.auditRefusalsTotal,
        rateLimitBlockedTotal: source.rateLimitBlockedTotal,
      },
      reliability: {
        crashRecoveriesTotal: source.crashRecoveriesTotal,
      },
      pageMemory: {
        entriesTotal: source.memoryEntriesTotal,
      },
      ...(source.memoryWatchdog ? { memoryWatchdog: source.memoryWatchdog } : {}),
    }
  }

  renderPrometheus(source: RuntimeMetricsSource, nowMs = Date.now()): string {
    const snap = this.getSnapshot(source, nowMs)
    const lines: string[] = []

    const addMetric = (
      name: string,
      type: 'gauge' | 'counter' | 'histogram',
      help: string,
      samples: string[],
    ) => {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} ${type}`)
      for (const s of samples) lines.push(s)
    }

    addMetric('troy_info', 'gauge', 'Static metadata about the Troy Advanced instance.', [
      `troy_info${formatLabels({ version: snap.version, engine: snap.engine, node_version: process.version })} 1`,
    ])

    addMetric('troy_up', 'gauge', 'Whether Troy Advanced is ready to serve requests (1 = ready, 0 = not ready).', [
      `troy_up ${snap.ready ? 1 : 0}`,
    ])

    addMetric('troy_uptime_seconds', 'gauge', 'Seconds since the Troy Advanced Agent Socket started.', [
      `troy_uptime_seconds ${formatPromNumber(snap.uptimeSeconds)}`,
    ])

    addMetric('troy_process_uptime_seconds', 'gauge', 'Node.js process uptime in seconds.', [
      `troy_process_uptime_seconds ${formatPromNumber(snap.processUptimeSeconds)}`,
    ])

    addMetric('troy_process_resident_memory_bytes', 'gauge', 'Resident set size (RSS) memory in bytes.', [
      `troy_process_resident_memory_bytes ${formatPromNumber(snap.memory.rssBytes)}`,
    ])

    addMetric('troy_process_heap_used_bytes', 'gauge', 'V8 heap used memory in bytes.', [
      `troy_process_heap_used_bytes ${formatPromNumber(snap.memory.heapUsedBytes)}`,
    ])

    addMetric('troy_process_heap_total_bytes', 'gauge', 'V8 heap total memory in bytes.', [
      `troy_process_heap_total_bytes ${formatPromNumber(snap.memory.heapTotalBytes)}`,
    ])

    addMetric('troy_process_external_memory_bytes', 'gauge', 'V8 external memory in bytes.', [
      `troy_process_external_memory_bytes ${formatPromNumber(snap.memory.externalBytes)}`,
    ])

    if (snap.memoryWatchdog) {
      addMetric('troy_memory_watchdog_limit_bytes', 'gauge', 'Configured memory watchdog RSS limit in bytes (0 if disabled).', [
        `troy_memory_watchdog_limit_bytes ${formatPromNumber(snap.memoryWatchdog.maxRssBytes)}`,
      ])
      addMetric('troy_memory_watchdog_pressure_events_total', 'counter', 'Total memory watchdog RSS over-limit events.', [
        `troy_memory_watchdog_pressure_events_total ${formatPromNumber(snap.memoryWatchdog.pressureEventsTotal)}`,
      ])
      addMetric('troy_memory_watchdog_evictions_total', 'counter', 'Total idle background tabs evicted by the memory watchdog.', [
        `troy_memory_watchdog_evictions_total ${formatPromNumber(snap.memoryWatchdog.evictedTabsTotal)}`,
      ])
      addMetric('troy_memory_watchdog_gc_hints_total', 'counter', 'Total GC hint triggers attempted by the memory watchdog.', [
        `troy_memory_watchdog_gc_hints_total ${formatPromNumber(snap.memoryWatchdog.gcHintsTotal)}`,
      ])
    }

    addMetric('troy_tabs_open', 'gauge', 'Total number of currently open browser tabs.', [
      `troy_tabs_open ${formatPromNumber(snap.tabs.open)}`,
    ])

    addMetric('troy_tabs_owned', 'gauge', 'Number of currently open agent-owned tabs.', [
      `troy_tabs_owned ${formatPromNumber(snap.tabs.owned)}`,
    ])

    addMetric('troy_sessions_active', 'gauge', 'Number of active multi-agent sessions.', [
      `troy_sessions_active ${formatPromNumber(snap.sessions.active)}`,
    ])

    addMetric('troy_sse_clients_connected', 'gauge', 'Number of connected SSE /stream clients.', [
      `troy_sse_clients_connected ${formatPromNumber(snap.connections.sseClients)}`,
    ])

    addMetric('troy_ws_clients_connected', 'gauge', 'Number of connected WebSocket /ws clients.', [
      `troy_ws_clients_connected ${formatPromNumber(snap.connections.wsClients)}`,
    ])

    addMetric('troy_ws_requests_total', 'counter', 'Total WebSocket bridge requests handled.', [
      `troy_ws_requests_total ${formatPromNumber(snap.connections.wsRequestsTotal)}`,
    ])

    addMetric('troy_crash_recoveries_total', 'counter', 'Total browser crash recovery attempts.', [
      `troy_crash_recoveries_total ${formatPromNumber(snap.reliability.crashRecoveriesTotal)}`,
    ])

    addMetric('troy_audit_events_total', 'counter', 'Total recorded agent audit events.', [
      `troy_audit_events_total ${formatPromNumber(snap.security.auditEventsTotal)}`,
    ])

    addMetric('troy_audit_refusals_total', 'counter', 'Total security/policy refusals recorded.', [
      `troy_audit_refusals_total ${formatPromNumber(snap.security.auditRefusalsTotal)}`,
    ])

    addMetric('troy_rate_limit_blocked_total', 'counter', 'Total HTTP requests blocked by rate limiting.', [
      `troy_rate_limit_blocked_total ${formatPromNumber(snap.security.rateLimitBlockedTotal)}`,
    ])

    addMetric('troy_memory_entries_total', 'gauge', 'Total persisted page memory entries.', [
      `troy_memory_entries_total ${formatPromNumber(snap.pageMemory.entriesTotal)}`,
    ])

    addMetric('troy_http_requests_in_flight', 'gauge', 'Number of HTTP requests currently being processed.', [
      `troy_http_requests_in_flight ${formatPromNumber(snap.requests.inFlight)}`,
    ])

    const httpReqSamples = [...this.httpByKey.values()]
      .sort((a, b) =>
        a.route.localeCompare(b.route) || a.method.localeCompare(b.method) || a.status.localeCompare(b.status),
      )
      .map(
        (entry) =>
          `troy_http_requests_total${formatLabels({
            method: entry.method,
            route: entry.route,
            status: entry.status,
          })} ${formatPromNumber(entry.count)}`,
      )
    addMetric('troy_http_requests_total', 'counter', 'Total HTTP requests handled by the Agent Socket.', httpReqSamples)

    const httpHistSamples: string[] = []
    for (const [route, hist] of [...this.httpDurationByRoute.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (let i = 0; i < this.httpBuckets.length; i++) {
        httpHistSamples.push(
          `troy_http_request_duration_seconds_bucket${formatLabels({
            route,
            le: String(this.httpBuckets[i]),
          })} ${formatPromNumber(hist.bucketCounts[i] ?? 0)}`,
        )
      }
      httpHistSamples.push(
        `troy_http_request_duration_seconds_bucket${formatLabels({ route, le: '+Inf' })} ${formatPromNumber(hist.count)}`,
      )
      httpHistSamples.push(
        `troy_http_request_duration_seconds_sum${formatLabels({ route })} ${formatPromNumber(hist.sumSeconds)}`,
      )
      httpHistSamples.push(
        `troy_http_request_duration_seconds_count${formatLabels({ route })} ${formatPromNumber(hist.count)}`,
      )
    }
    addMetric(
      'troy_http_request_duration_seconds',
      'histogram',
      'HTTP request duration in seconds by normalized route.',
      httpHistSamples,
    )

    const toolCallSamples: string[] = []
    const toolHistSamples: string[] = []
    for (const [tool, st] of [...this.tools.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (st.ok > 0) {
        toolCallSamples.push(
          `troy_tool_calls_total${formatLabels({ tool, outcome: 'ok' })} ${formatPromNumber(st.ok)}`,
        )
      }
      if (st.error > 0) {
        toolCallSamples.push(
          `troy_tool_calls_total${formatLabels({ tool, outcome: 'error' })} ${formatPromNumber(st.error)}`,
        )
      }
      if (st.refused > 0) {
        toolCallSamples.push(
          `troy_tool_calls_total${formatLabels({ tool, outcome: 'refused' })} ${formatPromNumber(st.refused)}`,
        )
      }

      for (let i = 0; i < this.toolBuckets.length; i++) {
        toolHistSamples.push(
          `troy_tool_duration_seconds_bucket${formatLabels({
            tool,
            le: String(this.toolBuckets[i]),
          })} ${formatPromNumber(st.histogram.bucketCounts[i] ?? 0)}`,
        )
      }
      toolHistSamples.push(
        `troy_tool_duration_seconds_bucket${formatLabels({ tool, le: '+Inf' })} ${formatPromNumber(st.histogram.count)}`,
      )
      toolHistSamples.push(
        `troy_tool_duration_seconds_sum${formatLabels({ tool })} ${formatPromNumber(st.histogram.sumSeconds)}`,
      )
      toolHistSamples.push(
        `troy_tool_duration_seconds_count${formatLabels({ tool })} ${formatPromNumber(st.histogram.count)}`,
      )
    }

    addMetric('troy_tool_calls_total', 'counter', 'Total agent tool invocations by tool name and outcome.', toolCallSamples)
    addMetric('troy_tool_duration_seconds', 'histogram', 'Agent tool execution latency in seconds by tool name.', toolHistSamples)

    return `${lines.join('\n')}\n`
  }
}

export function formatMetricsAscii(snapshot: MetricsSnapshot, opts: { width?: number } = {}): string {
  const width = Math.max(56, Math.min(120, Math.floor(opts.width ?? 80)))
  const inner = width - 2
  const border = `+${'-'.repeat(inner)}+`
  const pad = (text: string) => {
    const clean = sanitizeAscii(text)
    if (clean.length >= inner) return `|${clean.slice(0, inner)}|`
    return `|${clean}${' '.repeat(inner - clean.length)}|`
  }

  const lines: string[] = [
    border,
    pad(` TROY ADVANCED METRICS (${snapshot.ready ? 'READY' : 'NOT_READY'}) | engine=${snapshot.engine}`),
    border,
    pad(
      ` Uptime: ${snapshot.uptimeSeconds.toFixed(1)}s | RSS: ${snapshot.memory.rssMb.toFixed(1)} MB | Heap: ${(snapshot.memory.heapUsedBytes / (1024 * 1024)).toFixed(1)} MB`,
    ),
    pad(
      ` Tabs: ${snapshot.tabs.open} open (${snapshot.tabs.owned} owned) | Sessions: ${snapshot.sessions.active} | SSE: ${snapshot.connections.sseClients} | WS: ${snapshot.connections.wsClients}`,
    ),
    pad(
      ` HTTP: ${snapshot.requests.total} reqs (${snapshot.requests.inFlight} in-flight, ${snapshot.requests.errors4xx} 4xx, ${snapshot.requests.errors5xx} 5xx)`,
    ),
    pad(
      ` Tools: ${snapshot.tools.total} calls (${snapshot.tools.ok} ok, ${snapshot.tools.error} err, ${snapshot.tools.refused} refused, avg ${snapshot.tools.avgLatencyMs.toFixed(1)}ms)`,
    ),
  ]

  if (snapshot.tools.byTool.length > 0) {
    lines.push(border)
    lines.push(pad(' Tool Latency (ms):'))
    lines.push(pad('  tool                  calls   ok  err  ref    avg    p95    max'))
    for (const t of snapshot.tools.byTool) {
      const name = t.tool.slice(0, 20).padEnd(20)
      const row = `  ${name} ${String(t.count).padStart(5)} ${String(t.ok).padStart(4)} ${String(t.error).padStart(4)} ${String(t.refused).padStart(4)} ${t.avgMs.toFixed(1).padStart(6)} ${t.p95Ms.toFixed(1).padStart(6)} ${t.maxMs.toFixed(1).padStart(6)}`
      lines.push(pad(row))
    }
  }

  lines.push(border)
  return lines.join('\n')
}
