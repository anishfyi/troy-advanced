// One-command benchmark harness (`troy-advanced bench`) measuring:
//   1. Engine startup latency (BrowserManager.create + first tab navigation + close)
//   2. ASCII render throughput (reusing the deterministic 6-case ASCII layout/delta/markdown suite)
//   3. CDP / engine live snapshot latency (`page_read`, `page_read_ascii`, optional `page_screenshot_ascii`)

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { EngineKind, ProxyOptions } from '../types.js'
import {
  runDefaultAsciiBenchmarkSuite,
  type AsciiBenchmarkCaseResult,
  type AsciiBenchmarkSuiteResult,
} from '../ascii/benchmark.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { findChromeBinary } from '../engine/chromium.js'
import { BrowserManager } from '../engine/manager.js'

export interface LatencyStats {
  count: number
  minMs: number
  medianMs: number
  avgMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  opsPerSec: number
}

export interface BenchOptions {
  engine?: EngineKind
  cdpUrl?: string
  chromeBin?: string
  proxy?: ProxyOptions
  /** Optional target URL to benchmark against. Defaults to a built-in local 127.0.0.1 HTML fixture server. */
  url?: string
  /** Number of timed iterations per ASCII benchmark case (default: 30). */
  asciiIterations?: number
  /** Warmup iterations per ASCII benchmark case (default: 5). */
  asciiWarmup?: number
  /** Per-page ASCII latency budget in ms (default: 5.0). */
  asciiBudgetMs?: number
  /** Number of cold startup cycles to measure (default: 1). */
  startupRuns?: number
  /** Number of timed snapshot iterations for `page_read` and `page_read_ascii` (default: 5). */
  snapshotIterations?: number
  /** Warmup snapshot iterations before timing (default: 1). */
  snapshotWarmup?: number
  /** Also benchmark `page_screenshot_ascii` when running on Chromium (default: false). */
  includeScreenshot?: boolean
  /** Skip the ASCII render throughput section. */
  skipAscii?: boolean
  /** Skip the startup latency section. */
  skipStartup?: boolean
  /** Skip the live snapshot latency section. */
  skipSnapshot?: boolean
}

export interface BenchEnvironment {
  timestamp: string
  nodeVersion: string
  platform: string
  arch: string
  cpus: number
  totalMemMb: number
  requestedEngine: EngineKind
  resolvedEngine: 'chromium' | 'lite' | null
  chromeBinary: string | null
  remoteCdp: boolean
  targetUrl: string
  usedLocalFixture: boolean
}

export interface StartupBenchResult {
  engine: 'chromium' | 'lite'
  transport: 'cdp' | 'remote-cdp' | 'lite-http'
  runs: number
  engineCreateMs: LatencyStats
  firstNavigationMs: LatencyStats
  totalReadyMs: LatencyStats
  closeMs: LatencyStats
}

export interface AsciiThroughputBenchResult extends AsciiBenchmarkSuiteResult {
  totalRenders: number
  avgMedianMs: number
  worstP95Ms: number
  aggregateOpsPerSec: number
  throughputCharsPerSec: number
}

export interface SnapshotBenchResult {
  engine: 'chromium' | 'lite'
  transport: 'cdp' | 'remote-cdp' | 'lite-http'
  warmupIterations: number
  iterations: number
  elementsCount: number
  asciiBytes: number
  asciiLines: number
  pageReadMs: LatencyStats
  pageReadAsciiMs: LatencyStats
  screenshotAsciiMs: LatencyStats | null
  screenshotBytes: number | null
}

export interface BenchReport {
  ok: boolean
  environment: BenchEnvironment
  startup: StartupBenchResult | null
  ascii: AsciiThroughputBenchResult | null
  snapshot: SnapshotBenchResult | null
  totalDurationMs: number
  memoryRssMb: number
  notes: string[]
}

export interface BenchFixtureServer {
  url: string
  port: number
  close: () => Promise<void>
}

export function computeLatencyStats(samplesMs: number[]): LatencyStats {
  const valid = samplesMs.filter((v) => Number.isFinite(v) && v >= 0)
  if (valid.length === 0) {
    return {
      count: 0,
      minMs: 0,
      medianMs: 0,
      avgMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      opsPerSec: 0,
    }
  }
  const sorted = [...valid].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const avgMs = sum / sorted.length
  const mid = Math.floor(sorted.length / 2)
  const medianMs =
    sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  const pct = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[idx] ?? 0
  }
  const p95Ms = pct(95)
  const p99Ms = pct(99)
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    medianMs,
    avgMs,
    p95Ms,
    p99Ms,
    maxMs: sorted[sorted.length - 1]!,
    opsPerSec: avgMs > 0 ? 1000 / avgMs : 0,
  }
}

export function parseBenchInt(
  raw: unknown,
  flagName: string,
  bounds: { min: number; max: number; fallback: number },
): number {
  if (raw === undefined || raw === null || raw === '') return bounds.fallback
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    throw new Error(`Invalid ${flagName}: expected an integer between ${bounds.min} and ${bounds.max}`)
  }
  return n
}

export function parseBenchFloat(
  raw: unknown,
  flagName: string,
  bounds: { min: number; max: number; fallback: number },
): number {
  if (raw === undefined || raw === null || raw === '') return bounds.fallback
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
    throw new Error(`Invalid ${flagName}: expected a number between ${bounds.min} and ${bounds.max}`)
  }
  return n
}

export function createBenchFixtureHtml(): string {
  const rows = Array.from({ length: 12 }, (_, idx) => {
    const id = idx + 1
    const region = idx % 3 === 0 ? 'us-east-1' : idx % 3 === 1 ? 'us-west-2' : 'eu-central-1'
    const instance = idx % 2 === 0 ? 't4g.small' : 't3.medium'
    const latency = (1.2 + idx * 0.35).toFixed(2)
    return `<tr><td>node-${String(id).padStart(2, '0')}</td><td>${region}</td><td>${instance}</td><td>${latency} ms</td><td><a href="#node-${id}">Inspect</a></td></tr>`
  }).join('\n          ')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>troy-advanced Benchmark Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 20px; color: #111; background: #fff; }
      header { display: flex; gap: 16px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
      main { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-top: 16px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
      form { border: 1px solid #ccc; padding: 12px; }
    </style>
  </head>
  <body>
    <header>
      <a id="nav-home" href="#home">Home</a>
      <a id="nav-docs" href="#docs">Docs</a>
      <a id="nav-bench" href="#bench">Benchmarks</a>
      <a id="nav-metrics" href="#metrics">Metrics</a>
    </header>
    <h1>Troy Advanced Performance Benchmark</h1>
    <p>Deterministic local page fixture for measuring startup, CDP DOM extraction, and <a id="inline-ascii" href="#ascii">ASCII layout rendering</a>.</p>
    <main>
      <section>
        <h2>Cluster Latency Table</h2>
        <table>
          <thead>
            <tr><th>Node</th><th>Region</th><th>Instance</th><th>Median</th><th>Action</th></tr>
          </thead>
          <tbody>
          ${rows}
          </tbody>
        </table>
      </section>
      <aside>
        <form id="bench-form" action="#submit" method="get">
          <h3>Quick Filter</h3>
          <label for="query">Search nodes</label>
          <input id="query" name="q" type="text" placeholder="us-east-1" />
          <label for="engine">Engine</label>
          <select id="engine" name="engine">
            <option value="chromium">Chromium CDP</option>
            <option value="lite">Lite Zero-Chrome</option>
          </select>
          <label><input id="strict" type="checkbox" checked /> Strict 7-bit ASCII</label>
          <button id="apply-btn" type="submit">Apply Filter</button>
        </form>
        <p>Dynamic counter: <span id="counter">0</span> <button id="inc-btn" type="button" onclick="document.getElementById('counter').textContent = String(Number(document.getElementById('counter').textContent) + 1)">Increment</button></p>
      </aside>
    </main>
    <footer>
      <a id="footer-status" href="#status">Status</a>
      <a id="footer-health" href="#health">Health</a>
    </footer>
  </body>
</html>`
}

export async function startBenchFixtureServer(): Promise<BenchFixtureServer> {
  const html = createBenchFixtureHtml()
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(html)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}/bench`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function summarizeAsciiSuite(suite: AsciiBenchmarkSuiteResult): AsciiThroughputBenchResult {
  const totalRenders = suite.cases.reduce((acc, c) => acc + c.iterations, 0)
  const totalTimeSec = suite.cases.reduce((acc, c) => acc + (c.avgMs * c.iterations) / 1000, 0)
  const totalChars = suite.cases.reduce((acc, c) => acc + c.outputChars * c.iterations, 0)
  const avgMedianMs =
    suite.cases.length > 0 ? suite.cases.reduce((acc, c) => acc + c.medianMs, 0) / suite.cases.length : 0
  const worstP95Ms = suite.cases.reduce((acc, c) => Math.max(acc, c.p95Ms), 0)
  const aggregateOpsPerSec = totalTimeSec > 0 ? totalRenders / totalTimeSec : 0
  const throughputCharsPerSec = totalTimeSec > 0 ? totalChars / totalTimeSec : 0

  return {
    ...suite,
    totalRenders,
    avgMedianMs,
    worstP95Ms,
    aggregateOpsPerSec,
    throughputCharsPerSec,
  }
}

function classifyTransport(engine: 'chromium' | 'lite', cdpUrl?: string): 'cdp' | 'remote-cdp' | 'lite-http' {
  if (engine === 'lite') return 'lite-http'
  return cdpUrl ? 'remote-cdp' : 'cdp'
}

export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
  const startedAt = performance.now()
  const requestedEngine: EngineKind = options.engine ?? 'auto'
  const asciiIterations = parseBenchInt(options.asciiIterations, '--iterations', {
    min: 1,
    max: 5000,
    fallback: 30,
  })
  const asciiWarmup = parseBenchInt(options.asciiWarmup, '--warmup', {
    min: 0,
    max: 500,
    fallback: 5,
  })
  const asciiBudgetMs = parseBenchFloat(options.asciiBudgetMs, '--budget-ms', {
    min: 0.1,
    max: 1000,
    fallback: 5.0,
  })
  const startupRuns = parseBenchInt(options.startupRuns, '--startup-runs', {
    min: 1,
    max: 10,
    fallback: 1,
  })
  const snapshotIterations = parseBenchInt(options.snapshotIterations, '--snapshot-iterations', {
    min: 1,
    max: 200,
    fallback: 5,
  })
  const snapshotWarmup = parseBenchInt(options.snapshotWarmup, '--snapshot-warmup', {
    min: 0,
    max: 20,
    fallback: 1,
  })

  const chromeBinary = options.chromeBin || findChromeBinary()
  const notes: string[] = []

  // 1. ASCII render throughput benchmark (pure in-memory, deterministic)
  let asciiResult: AsciiThroughputBenchResult | null = null
  if (!options.skipAscii) {
    const suite = runDefaultAsciiBenchmarkSuite({
      iterations: asciiIterations,
      warmupIterations: asciiWarmup,
      budgetMs: asciiBudgetMs,
    })
    asciiResult = summarizeAsciiSuite(suite)
  }

  // 2. Startup latency + 3. CDP / engine snapshot latency
  let startupResult: StartupBenchResult | null = null
  let snapshotResult: SnapshotBenchResult | null = null
  let resolvedEngine: 'chromium' | 'lite' | null = null

  const needBrowser = !options.skipStartup || !options.skipSnapshot
  let fixtureServer: BenchFixtureServer | null = null
  let targetUrl = options.url?.trim() || ''
  let usedLocalFixture = false

  if (needBrowser) {
    if (!targetUrl) {
      fixtureServer = await startBenchFixtureServer()
      targetUrl = fixtureServer.url
      usedLocalFixture = true
    }

    const createSamples: number[] = []
    const navSamples: number[] = []
    const totalReadySamples: number[] = []
    const closeSamples: number[] = []

    const tempDirs: string[] = []
    let activeManager: BrowserManager | null = null
    let activeTabId: number | null = null

    try {
      const runsToExecute = options.skipStartup ? 1 : startupRuns
      for (let i = 0; i < runsToExecute; i++) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-bench-'))
        tempDirs.push(tmpDir)

        const tCreateStart = performance.now()
        const manager = await BrowserManager.create({
          engine: requestedEngine,
          cdpUrl: options.cdpUrl,
          chromeBin: options.chromeBin,
          proxy: options.proxy,
          profileDir: tmpDir,
          autoLoadDaemonConfig: false,
          autoLoadPolicyFile: false,
        })
        const createMs = performance.now() - tCreateStart
        resolvedEngine = manager.engine.kind

        const tNavStart = performance.now()
        const opened = await manager.openTab(targetUrl, { activate: true })
        const navMs = performance.now() - tNavStart
        if (!opened.ok || !opened.id) {
          await manager.close()
          throw new Error(`Benchmark navigation failed for ${targetUrl}: ${opened.error || 'unknown error'}`)
        }

        if (!options.skipStartup) {
          createSamples.push(createMs)
          navSamples.push(navMs)
          totalReadySamples.push(createMs + navMs)
        }

        const isLastRun = i === runsToExecute - 1
        if (isLastRun && !options.skipSnapshot) {
          activeManager = manager
          activeTabId = opened.id
        } else {
          const tCloseStart = performance.now()
          await manager.close()
          const closeMs = performance.now() - tCloseStart
          if (!options.skipStartup) {
            closeSamples.push(closeMs)
          }
        }
      }

      if (!options.skipSnapshot && activeManager && activeTabId !== null) {
        const transport = classifyTransport(activeManager.engine.kind, options.cdpUrl)

        // Warmup snapshots
        for (let w = 0; w < snapshotWarmup; w++) {
          const r1 = await activeManager.runTool(activeTabId, 'page_read', {})
          if (!r1.ok) throw new Error(`Snapshot warmup page_read failed: ${String(r1.error || 'unknown')}`)
          const r2 = await activeManager.runTool(activeTabId, 'page_read_ascii', { width: 100, height: 32 })
          if (!r2.ok) throw new Error(`Snapshot warmup page_read_ascii failed: ${String(r2.error || 'unknown')}`)
        }

        const readSamples: number[] = []
        const readAsciiSamples: number[] = []
        let elementsCount = 0
        let asciiBytes = 0
        let asciiLines = 0

        for (let i = 0; i < snapshotIterations; i++) {
          const tReadStart = performance.now()
          const r1 = await activeManager.runTool(activeTabId, 'page_read', {})
          const readMs = performance.now() - tReadStart
          if (!r1.ok) throw new Error(`Snapshot page_read failed: ${String(r1.error || 'unknown')}`)
          readSamples.push(readMs)
          if (Array.isArray(r1.elements)) {
            elementsCount = r1.elements.length
          }

          const tAsciiStart = performance.now()
          const r2 = await activeManager.runTool(activeTabId, 'page_read_ascii', { width: 100, height: 32 })
          const readAsciiMs = performance.now() - tAsciiStart
          if (!r2.ok) throw new Error(`Snapshot page_read_ascii failed: ${String(r2.error || 'unknown')}`)
          readAsciiSamples.push(readAsciiMs)
          const asciiText = String(r2.ascii ?? '')
          asciiBytes = Buffer.byteLength(asciiText, 'utf8')
          asciiLines = asciiText ? asciiText.split('\n').length : 0
        }

        let screenshotAsciiMs: LatencyStats | null = null
        let screenshotBytes: number | null = null
        if (options.includeScreenshot && activeManager.engine.kind === 'chromium') {
          const shotSamples: number[] = []
          for (let i = 0; i < Math.max(1, Math.min(3, snapshotIterations)); i++) {
            const tShotStart = performance.now()
            const shot = await activeManager.runTool(activeTabId, 'page_screenshot_ascii', {
              width: 64,
              height: 20,
              annotate: true,
            })
            const shotMs = performance.now() - tShotStart
            if (shot.ok) {
              shotSamples.push(shotMs)
              screenshotBytes = Number(shot.bytes ?? 0)
            }
          }
          if (shotSamples.length > 0) {
            screenshotAsciiMs = computeLatencyStats(shotSamples)
          }
        }

        snapshotResult = {
          engine: activeManager.engine.kind,
          transport,
          warmupIterations: snapshotWarmup,
          iterations: snapshotIterations,
          elementsCount,
          asciiBytes,
          asciiLines,
          pageReadMs: computeLatencyStats(readSamples),
          pageReadAsciiMs: computeLatencyStats(readAsciiSamples),
          screenshotAsciiMs,
          screenshotBytes,
        }

        const tCloseStart = performance.now()
        await activeManager.close()
        const closeMs = performance.now() - tCloseStart
        activeManager = null
        if (!options.skipStartup) {
          closeSamples.push(closeMs)
        }
      }

      if (!options.skipStartup && resolvedEngine) {
        startupResult = {
          engine: resolvedEngine,
          transport: classifyTransport(resolvedEngine, options.cdpUrl),
          runs: createSamples.length,
          engineCreateMs: computeLatencyStats(createSamples),
          firstNavigationMs: computeLatencyStats(navSamples),
          totalReadyMs: computeLatencyStats(totalReadySamples),
          closeMs: computeLatencyStats(closeSamples),
        }
      }
    } finally {
      if (activeManager) {
        try {
          await activeManager.close()
        } catch {
          // ignore cleanup errors
        }
      }
      if (fixtureServer) {
        await fixtureServer.close()
      }
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  if (requestedEngine === 'auto' && resolvedEngine === 'lite' && !chromeBinary) {
    notes.push('No Chrome/Chromium binary detected; auto engine benchmarked Lite (zero-Chrome) engine.')
  }
  if (options.cdpUrl) {
    notes.push(`Remote CDP target: ${options.cdpUrl}`)
  }
  if (usedLocalFixture) {
    notes.push('Used built-in local 127.0.0.1 HTML fixture server for reproducible zero-network timings.')
  }

  const totalDurationMs = performance.now() - startedAt
  const memoryRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10
  const ok = asciiResult ? asciiResult.allPassed : true

  return {
    ok,
    environment: {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
      requestedEngine,
      resolvedEngine,
      chromeBinary,
      remoteCdp: Boolean(options.cdpUrl),
      targetUrl: usedLocalFixture ? 'local-fixture (127.0.0.1)' : targetUrl || 'n/a',
      usedLocalFixture,
    },
    startup: startupResult,
    ascii: asciiResult,
    snapshot: snapshotResult,
    totalDurationMs,
    memoryRssMb,
    notes,
  }
}

function renderAsciiTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const sep = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`
  const formatRow = (cols: string[]) =>
    `| ${cols.map((v, i) => (v ?? '').padEnd(widths[i] ?? 0)).join(' | ')} |`
  return [sep, formatRow(headers), sep, ...rows.map(formatRow), sep]
}

function fmtMs(v: number): string {
  return v >= 100 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toFixed(3)
}

function fmtOps(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)
}

export function formatBenchAscii(report: BenchReport): string {
  const env = report.environment
  const lines: string[] = [
    '+======================================================================+',
    '|                   troy-advanced benchmark report                     |',
    '+======================================================================+',
    `  Timestamp : ${env.timestamp}`,
    `  Runtime   : Node ${env.nodeVersion} (${env.platform}/${env.arch}, ${env.cpus} CPUs, ${env.totalMemMb} MB RAM)`,
    `  Engine    : requested=${env.requestedEngine}, resolved=${env.resolvedEngine ?? 'skipped'}${env.remoteCdp ? ' (remote CDP)' : ''}`,
    `  Chrome    : ${env.chromeBinary ?? 'not found'}`,
    `  Target    : ${env.targetUrl}`,
    '',
  ]

  if (report.startup) {
    const s = report.startup
    lines.push(`[1] Startup Latency (engine=${s.engine}, transport=${s.transport}, runs=${s.runs})`)
    const rows = [
      [
        'engine.create',
        fmtMs(s.engineCreateMs.minMs),
        fmtMs(s.engineCreateMs.medianMs),
        fmtMs(s.engineCreateMs.avgMs),
        fmtMs(s.engineCreateMs.p95Ms),
        fmtMs(s.engineCreateMs.maxMs),
      ],
      [
        'first.openTab',
        fmtMs(s.firstNavigationMs.minMs),
        fmtMs(s.firstNavigationMs.medianMs),
        fmtMs(s.firstNavigationMs.avgMs),
        fmtMs(s.firstNavigationMs.p95Ms),
        fmtMs(s.firstNavigationMs.maxMs),
      ],
      [
        'total.ready',
        fmtMs(s.totalReadyMs.minMs),
        fmtMs(s.totalReadyMs.medianMs),
        fmtMs(s.totalReadyMs.avgMs),
        fmtMs(s.totalReadyMs.p95Ms),
        fmtMs(s.totalReadyMs.maxMs),
      ],
      [
        'engine.close',
        fmtMs(s.closeMs.minMs),
        fmtMs(s.closeMs.medianMs),
        fmtMs(s.closeMs.avgMs),
        fmtMs(s.closeMs.p95Ms),
        fmtMs(s.closeMs.maxMs),
      ],
    ]
    lines.push(...renderAsciiTable(['Phase', 'Min(ms)', 'Median(ms)', 'Avg(ms)', 'P95(ms)', 'Max(ms)'], rows))
    lines.push('')
  }

  if (report.ascii) {
    const a = report.ascii
    lines.push(
      `[2] ASCII Render Throughput (budget < ${a.budgetMs.toFixed(1)}ms, warmup=${a.warmupIterations}, iters=${a.iterations})`,
    )
    const rows = a.cases.map((c: AsciiBenchmarkCaseResult) => [
      c.name,
      fmtMs(c.medianMs),
      fmtMs(c.avgMs),
      fmtMs(c.p95Ms),
      fmtOps(c.opsPerSec),
      String(c.outputLines),
      c.passed ? 'PASS' : 'FAIL',
    ])
    lines.push(
      ...renderAsciiTable(['Case', 'Median(ms)', 'Avg(ms)', 'P95(ms)', 'Ops/s', 'Lines', 'Status'], rows),
    )
    lines.push(
      `  Aggregate : ${fmtOps(a.aggregateOpsPerSec)} renders/s | ${(a.throughputCharsPerSec / 1_000_000).toFixed(2)} Mchars/s | avg-median=${fmtMs(a.avgMedianMs)}ms | worst-p95=${fmtMs(a.worstP95Ms)}ms`,
    )
    lines.push('')
  }

  if (report.snapshot) {
    const sn = report.snapshot
    lines.push(
      `[3] Snapshot Latency (engine=${sn.engine}, transport=${sn.transport}, warmup=${sn.warmupIterations}, iters=${sn.iterations})`,
    )
    const rows: string[][] = [
      [
        'page_read (DOM)',
        fmtMs(sn.pageReadMs.minMs),
        fmtMs(sn.pageReadMs.medianMs),
        fmtMs(sn.pageReadMs.avgMs),
        fmtMs(sn.pageReadMs.p95Ms),
        fmtOps(sn.pageReadMs.opsPerSec),
        `${sn.elementsCount} refs`,
      ],
      [
        'page_read_ascii',
        fmtMs(sn.pageReadAsciiMs.minMs),
        fmtMs(sn.pageReadAsciiMs.medianMs),
        fmtMs(sn.pageReadAsciiMs.avgMs),
        fmtMs(sn.pageReadAsciiMs.p95Ms),
        fmtOps(sn.pageReadAsciiMs.opsPerSec),
        `${sn.asciiBytes} B / ${sn.asciiLines} lines`,
      ],
    ]
    if (sn.screenshotAsciiMs) {
      rows.push([
        'page_screenshot_ascii',
        fmtMs(sn.screenshotAsciiMs.minMs),
        fmtMs(sn.screenshotAsciiMs.medianMs),
        fmtMs(sn.screenshotAsciiMs.avgMs),
        fmtMs(sn.screenshotAsciiMs.p95Ms),
        fmtOps(sn.screenshotAsciiMs.opsPerSec),
        `${sn.screenshotBytes ?? 0} B PNG`,
      ])
    }
    lines.push(
      ...renderAsciiTable(['Operation', 'Min(ms)', 'Median(ms)', 'Avg(ms)', 'P95(ms)', 'Ops/s', 'Output'], rows),
    )
    lines.push('')
  }

  lines.push(
    `Summary: status=${report.ok ? 'PASS' : 'FAIL'} | total=${fmtMs(report.totalDurationMs)}ms | rss=${report.memoryRssMb.toFixed(1)} MB`,
  )
  if (report.notes.length > 0) {
    lines.push('Notes:')
    for (const note of report.notes) {
      lines.push(`  - ${note}`)
    }
  }

  return sanitizeAscii(lines.join('\n'), { preserveNewlines: true })
}
