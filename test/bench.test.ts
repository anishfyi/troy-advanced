import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeLatencyStats,
  createBenchFixtureHtml,
  formatBenchAscii,
  parseBenchFloat,
  parseBenchInt,
  runBench,
  startBenchFixtureServer,
} from '../src/cloud/bench.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import { isStrictAscii } from '../src/ascii/sanitize.js'

const hasChrome = Boolean(findChromeBinary())

describe('computeLatencyStats', () => {
  it('handles empty and invalid sample arrays cleanly', () => {
    const empty = computeLatencyStats([])
    expect(empty.count).toBe(0)
    expect(empty.minMs).toBe(0)
    expect(empty.medianMs).toBe(0)
    expect(empty.avgMs).toBe(0)
    expect(empty.opsPerSec).toBe(0)

    const filtered = computeLatencyStats([Number.NaN, -5, Number.POSITIVE_INFINITY])
    expect(filtered.count).toBe(0)
  })

  it('computes min, median, avg, p95, p99, max, and ops/sec accurately', () => {
    const odd = computeLatencyStats([10, 2, 4, 8, 6])
    expect(odd.count).toBe(5)
    expect(odd.minMs).toBe(2)
    expect(odd.medianMs).toBe(6)
    expect(odd.avgMs).toBe(6)
    expect(odd.maxMs).toBe(10)
    expect(odd.p95Ms).toBe(10)
    expect(odd.opsPerSec).toBeCloseTo(1000 / 6, 3)

    const even = computeLatencyStats([1, 2, 3, 4])
    expect(even.medianMs).toBe(2.5)
    expect(even.avgMs).toBe(2.5)
    expect(even.opsPerSec).toBeCloseTo(400, 3)
  })
})

describe('bench CLI flag parsers', () => {
  it('validates integer and float bounds cleanly', () => {
    expect(parseBenchInt(undefined, '--iterations', { min: 1, max: 100, fallback: 30 })).toBe(30)
    expect(parseBenchInt('15', '--iterations', { min: 1, max: 100, fallback: 30 })).toBe(15)
    expect(() => parseBenchInt('0', '--iterations', { min: 1, max: 100, fallback: 30 })).toThrow(/Invalid --iterations/)
    expect(() => parseBenchInt('1.5', '--iterations', { min: 1, max: 100, fallback: 30 })).toThrow(/Invalid --iterations/)

    expect(parseBenchFloat(undefined, '--budget-ms', { min: 0.1, max: 100, fallback: 5 })).toBe(5)
    expect(parseBenchFloat('12.5', '--budget-ms', { min: 0.1, max: 100, fallback: 5 })).toBe(12.5)
    expect(() => parseBenchFloat('0', '--budget-ms', { min: 0.1, max: 100, fallback: 5 })).toThrow(/Invalid --budget-ms/)
  })
})

describe('bench fixture server', () => {
  it('serves deterministic benchmark HTML on localhost and closes cleanly', async () => {
    const html = createBenchFixtureHtml()
    expect(html).toContain('Troy Advanced Performance Benchmark')
    expect(html).toContain('Cluster Latency Table')
    expect(html).toContain('id="bench-form"')

    const server = await startBenchFixtureServer()
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bench$/)
      const res = await fetch(server.url)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe(html)
    } finally {
      await server.close()
    }
  })
})

describe('runBench (Lite engine + ASCII throughput)', () => {
  it('measures startup latency, ASCII render throughput, and snapshot latency end-to-end', async () => {
    const report = await runBench({
      engine: 'lite',
      asciiIterations: 6,
      asciiWarmup: 1,
      asciiBudgetMs: 50,
      startupRuns: 2,
      snapshotIterations: 3,
      snapshotWarmup: 1,
    })

    expect(report.ok).toBe(true)
    expect(report.environment.requestedEngine).toBe('lite')
    expect(report.environment.resolvedEngine).toBe('lite')
    expect(report.environment.usedLocalFixture).toBe(true)
    expect(report.totalDurationMs).toBeGreaterThan(0)
    expect(report.memoryRssMb).toBeGreaterThan(0)

    // Startup latency
    expect(report.startup).not.toBeNull()
    expect(report.startup!.engine).toBe('lite')
    expect(report.startup!.transport).toBe('lite-http')
    expect(report.startup!.runs).toBe(2)
    expect(report.startup!.engineCreateMs.count).toBe(2)
    expect(report.startup!.firstNavigationMs.count).toBe(2)
    expect(report.startup!.totalReadyMs.count).toBe(2)
    expect(report.startup!.closeMs.count).toBe(2)
    expect(report.startup!.totalReadyMs.avgMs).toBeGreaterThan(0)

    // ASCII render throughput
    expect(report.ascii).not.toBeNull()
    expect(report.ascii!.cases.length).toBe(6)
    expect(report.ascii!.allPassed).toBe(true)
    expect(report.ascii!.aggregateOpsPerSec).toBeGreaterThan(0)
    expect(report.ascii!.throughputCharsPerSec).toBeGreaterThan(0)

    // Snapshot latency
    expect(report.snapshot).not.toBeNull()
    expect(report.snapshot!.engine).toBe('lite')
    expect(report.snapshot!.transport).toBe('lite-http')
    expect(report.snapshot!.iterations).toBe(3)
    expect(report.snapshot!.elementsCount).toBeGreaterThan(10)
    expect(report.snapshot!.asciiBytes).toBeGreaterThan(100)
    expect(report.snapshot!.pageReadMs.count).toBe(3)
    expect(report.snapshot!.pageReadAsciiMs.count).toBe(3)
    expect(report.snapshot!.pageReadMs.opsPerSec).toBeGreaterThan(0)

    // Strict 7-bit ASCII formatted report
    const ascii = formatBenchAscii(report)
    expect(isStrictAscii(ascii)).toBe(true)
    expect(ascii).toContain('troy-advanced benchmark report')
    expect(ascii).toContain('[1] Startup Latency')
    expect(ascii).toContain('[2] ASCII Render Throughput')
    expect(ascii).toContain('[3] Snapshot Latency')
    expect(ascii).toContain('Summary: status=PASS')
  })

  it('supports selective section skips (--skip-startup, --skip-snapshot, --skip-ascii)', async () => {
    const asciiOnly = await runBench({
      engine: 'lite',
      asciiIterations: 4,
      asciiWarmup: 1,
      asciiBudgetMs: 50,
      skipStartup: true,
      skipSnapshot: true,
    })
    expect(asciiOnly.ok).toBe(true)
    expect(asciiOnly.ascii).not.toBeNull()
    expect(asciiOnly.startup).toBeNull()
    expect(asciiOnly.snapshot).toBeNull()

    const snapshotOnly = await runBench({
      engine: 'lite',
      skipAscii: true,
      skipStartup: true,
      snapshotIterations: 2,
      snapshotWarmup: 0,
    })
    expect(snapshotOnly.ok).toBe(true)
    expect(snapshotOnly.ascii).toBeNull()
    expect(snapshotOnly.startup).toBeNull()
    expect(snapshotOnly.snapshot).not.toBeNull()
    expect(snapshotOnly.snapshot!.pageReadMs.count).toBe(2)
  })
})

describe.skipIf(!hasChrome)('runBench (Chromium CDP)', () => {
  it('measures real Chromium startup, CDP snapshot latency, and optional screenshot ASCII latency', async () => {
    const report = await runBench({
      engine: 'chromium',
      asciiIterations: 4,
      asciiWarmup: 1,
      asciiBudgetMs: 50,
      startupRuns: 1,
      snapshotIterations: 2,
      snapshotWarmup: 1,
      includeScreenshot: true,
    })

    expect(report.ok).toBe(true)
    expect(report.environment.resolvedEngine).toBe('chromium')
    expect(report.startup!.engine).toBe('chromium')
    expect(report.startup!.transport).toBe('cdp')
    expect(report.startup!.totalReadyMs.avgMs).toBeGreaterThan(0)
    expect(report.snapshot!.engine).toBe('chromium')
    expect(report.snapshot!.transport).toBe('cdp')
    expect(report.snapshot!.elementsCount).toBeGreaterThan(10)
    expect(report.snapshot!.pageReadMs.count).toBe(2)
    expect(report.snapshot!.pageReadAsciiMs.count).toBe(2)
    expect(report.snapshot!.screenshotAsciiMs).not.toBeNull()
    expect(report.snapshot!.screenshotBytes).toBeGreaterThan(500)

    const ascii = formatBenchAscii(report)
    expect(isStrictAscii(ascii)).toBe(true)
    expect(ascii).toContain('page_screenshot_ascii')
  })
})

describe('CLI `troy-advanced bench`', () => {
  it('runs `bench --engine lite --json --out <file>` cleanly via CLI entrypoint', () => {
    const cliPath = path.resolve('bin/troy-advanced.mjs')
    const distCliPath = path.resolve('dist/cli.js')
    if (!fs.existsSync(cliPath) || !fs.existsSync(distCliPath)) return

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-bench-cli-'))
    const outFile = path.join(tmpDir, 'bench-report.json')
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          cliPath,
          'bench',
          '--engine',
          'lite',
          '--iterations',
          '4',
          '--warmup',
          '1',
          '--budget-ms',
          '50',
          '--snapshot-iterations',
          '2',
          '--snapshot-warmup',
          '0',
          '--out',
          outFile,
          '--json',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      )
      const parsed = JSON.parse(stdout)
      expect(parsed.ok).toBe(true)
      expect(parsed.environment.resolvedEngine).toBe('lite')
      expect(parsed.startup.runs).toBe(1)
      expect(parsed.ascii.cases.length).toBe(6)
      expect(parsed.snapshot.iterations).toBe(2)
      expect(fs.existsSync(outFile)).toBe(true)
      const fileParsed = JSON.parse(fs.readFileSync(outFile, 'utf8'))
      expect(fileParsed.ok).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
