import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  MemoryWatchdog,
  createAgentSocket,
  createBrowserMemoryWatchdog,
  formatMemoryWatchdogAscii,
  parseMaxRssMb,
  type MemoryWatchdogEvent,
  type MemoryWatchdogTarget,
  type WatchdogTabInfo,
} from '../src/index.js'

const MIB = 1024 * 1024

function makeMockTarget(initialTabs: WatchdogTabInfo[], opts: { onEvict?: (id: number) => void; cachesCount?: number } = {}) {
  const tabs = initialTabs.map((t) => ({ ...t }))
  const evicted: Array<{ id: number; reason: string }> = []
  let caches = opts.cachesCount ?? 0

  const target: MemoryWatchdogTarget = {
    getTabs: () => tabs.map((t) => ({ ...t })),
    evictTab: async (tabId: number, reason: string) => {
      const idx = tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return false
      tabs.splice(idx, 1)
      evicted.push({ id: tabId, reason })
      opts.onEvict?.(tabId)
      return true
    },
    clearIdleCaches: () => {
      const n = caches
      caches = 0
      return n
    },
  }

  return { target, tabs, evicted }
}

describe('M88: Graceful memory watchdog', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!
      await fn()
    }
  })

  it('parseMaxRssMb validates positive MiB values and rejects invalid input', () => {
    expect(parseMaxRssMb(undefined)).toBeUndefined()
    expect(parseMaxRssMb('')).toBeUndefined()
    expect(parseMaxRssMb('  ')).toBeUndefined()
    expect(parseMaxRssMb(512)).toBe(512)
    expect(parseMaxRssMb('256.5')).toBe(256.5)

    expect(() => parseMaxRssMb(0)).toThrow(/Invalid --max-rss-mb/)
    expect(() => parseMaxRssMb(-100)).toThrow(/Invalid --max-rss-mb/)
    expect(() => parseMaxRssMb('0')).toThrow(/Invalid --max-rss-mb/)
    expect(() => parseMaxRssMb('abc')).toThrow(/Invalid --max-rss-mb/)
    expect(() => parseMaxRssMb(Number.POSITIVE_INFINITY)).toThrow(/Invalid --max-rss-mb/)
  })

  it('stays disabled when maxRssMb is omitted or <= 0', async () => {
    const { target } = makeMockTarget([])
    const wd = new MemoryWatchdog(target, {}, { readRssBytes: () => 200 * MIB })
    expect(wd.enabled).toBe(false)
    expect(wd.start()).toBe(false)
    expect(wd.isRunning()).toBe(false)

    const res = await wd.checkOnce()
    expect(res.enabled).toBe(false)
    expect(res.overLimit).toBe(false)
    expect(res.action).toBe('disabled')
  })

  it('reports ok without evicting or triggering GC when RSS is within limit', async () => {
    const now = 1_700_000_000_000
    const { target, evicted } = makeMockTarget([
      { id: 1, url: 'https://a.test', title: 'A', active: true, createdAt: now - 10_000, lastActiveAt: now },
      { id: 2, url: 'https://b.test', title: 'B', active: false, createdAt: now - 200_000, lastActiveAt: now - 120_000 },
    ])
    let gcCalls = 0
    const wd = new MemoryWatchdog(
      target,
      { maxRssMb: 512, idleTabTtlMs: 60_000 },
      {
        readRssBytes: () => 300 * MIB,
        triggerGc: () => {
          gcCalls++
          return true
        },
        now: () => now,
      },
    )

    const res = await wd.checkOnce()
    expect(res.overLimit).toBe(false)
    expect(res.action).toBe('ok')
    expect(res.rssMb).toBe(300)
    expect(evicted).toHaveLength(0)
    expect(gcCalls).toBe(0)

    const stats = wd.getStats()
    expect(stats.checksTotal).toBe(1)
    expect(stats.pressureEventsTotal).toBe(0)
    expect(stats.peakRssMb).toBe(300)
  })

  it('gracefully evicts oldest idle background tabs first and stops once RSS drops below limit', async () => {
    const now = 1_700_000_000_000
    let currentRss = 600 * MIB
    const events: MemoryWatchdogEvent[] = []

    const { target, tabs, evicted } = makeMockTarget(
      [
        { id: 1, url: 'https://active.test', title: 'Active', active: true, createdAt: now - 500_000, lastActiveAt: now - 500_000 },
        { id: 2, url: 'https://recent.test', title: 'Recent', active: false, createdAt: now - 20_000, lastActiveAt: now - 10_000 },
        { id: 3, url: 'https://oldest.test', title: 'Oldest', active: false, createdAt: now - 300_000, lastActiveAt: now - 240_000 },
        { id: 4, url: 'https://middle.test', title: 'Middle', active: false, createdAt: now - 200_000, lastActiveAt: now - 120_000 },
      ],
      {
        onEvict: () => {
          // Each evicted tab frees 120 MiB
          currentRss -= 120 * MIB
        },
      },
    )

    let gcCalls = 0
    const wd = new MemoryWatchdog(
      target,
      { maxRssMb: 500, idleTabTtlMs: 60_000, maxEvictionsPerSweep: 3 },
      {
        readRssBytes: () => currentRss,
        triggerGc: () => {
          gcCalls++
          return true
        },
        now: () => now,
        onEvent: (ev) => events.push(ev),
      },
    )

    const res = await wd.checkOnce()
    // 600 - 120 = 480 <= 500, so ONLY tab 3 (oldest idle) should be evicted!
    expect(res.overLimit).toBe(true)
    expect(res.evictedTabIds).toEqual([3])
    expect(res.afterRssMb).toBe(480)
    expect(res.stillOverLimit).toBe(false)
    expect(res.gcHinted).toBe(false)
    expect(res.action).toBe('evicted')
    expect(gcCalls).toBe(0)
    expect(evicted).toHaveLength(1)
    expect(tabs.map((t) => t.id)).toEqual([1, 2, 4])
    expect(events).toHaveLength(1)
    expect(events[0]!.evictedTabIds).toEqual([3])
  })

  it('never evicts the active tab and triggers GC hint when no background tabs are evictable', async () => {
    const now = 1_700_000_000_000
    let currentRss = 700 * MIB
    const { target, tabs } = makeMockTarget([
      { id: 1, url: 'https://active.test', title: 'Active', active: true, createdAt: now - 900_000, lastActiveAt: now - 900_000 },
    ])

    let gcCalls = 0
    const wd = new MemoryWatchdog(
      target,
      { maxRssMb: 500, minTabsToKeep: 0 },
      {
        readRssBytes: () => currentRss,
        triggerGc: () => {
          gcCalls++
          currentRss = 420 * MIB
          return true
        },
        now: () => now,
      },
    )

    const res = await wd.checkOnce()
    expect(res.evictedTabIds).toEqual([])
    expect(tabs.map((t) => t.id)).toEqual([1])
    expect(res.gcHinted).toBe(true)
    expect(res.gcInvoked).toBe(true)
    expect(res.afterRssMb).toBe(420)
    expect(res.stillOverLimit).toBe(false)
    expect(res.action).toBe('gc_hint')
    expect(gcCalls).toBe(1)

    const stats = wd.getStats()
    expect(stats.gcHintsTotal).toBe(1)
    expect(stats.gcInvokedTotal).toBe(1)
    expect(stats.evictedTabsTotal).toBe(0)
  })

  it('clears idle caches first and skips tab eviction if cache clearing relieves pressure', async () => {
    const now = 1_700_000_000_000
    let currentRss = 520 * MIB
    const { target, tabs } = makeMockTarget(
      [
        { id: 1, url: 'https://a.test', title: 'A', active: true, createdAt: now - 10_000, lastActiveAt: now },
        { id: 2, url: 'https://b.test', title: 'B', active: false, createdAt: now - 200_000, lastActiveAt: now - 120_000 },
      ],
      { cachesCount: 1 },
    )
    const origClear = target.clearIdleCaches!
    target.clearIdleCaches = () => {
      const n = origClear()
      if (n > 0) currentRss = 460 * MIB
      return n
    }

    const wd = new MemoryWatchdog(
      target,
      { maxRssMb: 500, gcHint: false },
      {
        readRssBytes: () => currentRss,
        now: () => now,
      },
    )

    const res = await wd.checkOnce()
    expect(res.cachesCleared).toBe(1)
    expect(res.evictedTabIds).toEqual([])
    expect(res.afterRssMb).toBe(460)
    expect(res.stillOverLimit).toBe(false)
    expect(res.action).toBe('cache_cleared')
    expect(tabs).toHaveLength(2)
  })

  it('respects evictAnyBackgroundOnPressure=false and maxEvictionsPerSweep', async () => {
    const now = 1_700_000_000_000
    const { target, tabs } = makeMockTarget([
      { id: 1, url: 'https://a.test', title: 'A', active: true, createdAt: now - 10_000, lastActiveAt: now },
      { id: 2, url: 'https://b.test', title: 'B', active: false, createdAt: now - 5_000, lastActiveAt: now - 5_000 },
    ])

    const wd = new MemoryWatchdog(
      target,
      {
        maxRssMb: 100,
        idleTabTtlMs: 60_000,
        evictAnyBackgroundOnPressure: false,
        gcHint: true,
      },
      {
        readRssBytes: () => 250 * MIB,
        triggerGc: () => false,
        now: () => now,
      },
    )

    const res = await wd.checkOnce()
    expect(res.evictedTabIds).toEqual([])
    expect(tabs).toHaveLength(2)
    expect(res.gcHinted).toBe(true)
    expect(res.gcInvoked).toBe(false)
    expect(res.stillOverLimit).toBe(true)
    expect(res.action).toBe('gc_hint')
  })

  it('runs periodic checks when started and stops cleanly', async () => {
    const { target } = makeMockTarget([])
    const wd = new MemoryWatchdog(
      target,
      { maxRssMb: 512, checkIntervalMs: 50 },
      { readRssBytes: () => 100 * MIB },
    )
    cleanups.push(() => wd.stop())

    expect(wd.start()).toBe(true)
    expect(wd.isRunning()).toBe(true)

    await new Promise((r) => setTimeout(r, 140))
    wd.stop()
    expect(wd.isRunning()).toBe(false)

    const checksAfterStop = wd.getStats().checksTotal
    expect(checksAfterStop).toBeGreaterThanOrEqual(2)

    await new Promise((r) => setTimeout(r, 120))
    expect(wd.getStats().checksTotal).toBe(checksAfterStop)
  })

  it('integrates end-to-end with BrowserManager (Lite), AgentSocket /health, /watchdog, and /metrics', async () => {
    const server = http.createServer((req, res) => {
      const page = req.url || '/'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Page ${page}</title></head><body><h1>Hello ${page}</h1><a href="/next">Next</a></body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const port = (server.address() as { port: number }).port
    const baseUrl = `http://127.0.0.1:${port}`

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-wd-test-'))
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: tmpDir,
      memoryEnabled: false,
    })
    cleanups.push(() => manager.close())

    // Open 3 tabs; tab 3 becomes active, tabs 1 and 2 are background tabs
    const t1 = await manager.openTab(`${baseUrl}/tab1`, { activate: true })
    await manager.runTool(t1.id, 'page_read', {})
    await new Promise((r) => setTimeout(r, 15))
    const t2 = await manager.openTab(`${baseUrl}/tab2`, { activate: true })
    await manager.runTool(t2.id, 'page_read', {})
    await new Promise((r) => setTimeout(r, 15))
    const t3 = await manager.openTab(`${baseUrl}/tab3`, { activate: true })
    await manager.runTool(t3.id, 'page_read', {})

    expect(manager.listTabs()).toHaveLength(3)

    const managerEvents: Array<Record<string, unknown>> = []
    const off = manager.onEvent((ev) => managerEvents.push(ev))
    cleanups.push(off)

    let fakeRss = 600 * MIB
    const watchdog = createBrowserMemoryWatchdog(
      manager,
      {
        maxRssMb: 512,
        idleTabTtlMs: 0,
        maxEvictionsPerSweep: 1,
      },
      {
        readRssBytes: () => fakeRss,
        triggerGc: () => {
          fakeRss = 450 * MIB
          return true
        },
      },
    )

    const socket = await createAgentSocket(manager, {
      port: 0,
      memoryWatchdog: watchdog,
    })
    cleanups.push(() => socket.close())

    // Trigger check via POST /watchdog
    const wdRes = await fetch(`http://127.0.0.1:${socket.port}/watchdog`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-troy-agent': socket.token,
      },
      body: JSON.stringify({ check: true }),
    })
    expect(wdRes.status).toBe(200)
    const wdJson = (await wdRes.json()) as {
      ok: boolean
      enabled: boolean
      checkResult: { evictedTabIds: number[]; cachesCleared: number; gcInvoked: boolean; action: string }
      stats: { evictedTabsTotal: number; cachesClearedTotal: number; pressureEventsTotal: number }
      ascii: string
    }
    expect(wdJson.ok).toBe(true)
    expect(wdJson.enabled).toBe(true)
    // Tab 1 was the oldest background tab and must be evicted first; active tab 3 must remain
    expect(wdJson.checkResult.evictedTabIds).toEqual([t1.id])
    expect(wdJson.checkResult.cachesCleared).toBe(2) // both background tabs had cached snapshots
    expect(wdJson.checkResult.gcInvoked).toBe(true)
    expect(wdJson.checkResult.action).toBe('evicted_and_gc')
    expect(wdJson.stats.evictedTabsTotal).toBe(1)
    expect(wdJson.stats.pressureEventsTotal).toBe(1)

    // Verify remaining tabs: tab 1 gone, tab 3 still active
    const remainingIds = manager.listTabs().map((t) => t.id)
    expect(remainingIds).not.toContain(t1.id)
    expect(remainingIds).toContain(t3.id)

    // Verify tab_evicted event & audit record
    expect(managerEvents.some((e) => e.type === 'tab_evicted' && e.tabId === t1.id)).toBe(true)
    const auditEntries = manager.getAuditLog({ tool: 'memory_watchdog_evict' })
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)

    // Verify /health includes memoryWatchdog stats
    const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
      headers: { 'x-troy-agent': socket.token },
    })
    expect(healthRes.status).toBe(200)
    const healthJson = (await healthRes.json()) as {
      memoryWatchdog?: { enabled: boolean; maxRssMb: number; evictedTabsTotal: number }
    }
    expect(healthJson.memoryWatchdog?.enabled).toBe(true)
    expect(healthJson.memoryWatchdog?.maxRssMb).toBe(512)
    expect(healthJson.memoryWatchdog?.evictedTabsTotal).toBe(1)

    // Verify Prometheus /metrics exports troy_memory_watchdog_* metrics
    const metricsRes = await fetch(`http://127.0.0.1:${socket.port}/metrics`, {
      headers: { 'x-troy-agent': socket.token },
    })
    expect(metricsRes.status).toBe(200)
    const promText = await metricsRes.text()
    expect(promText).toContain('troy_memory_watchdog_limit_bytes 536870912')
    expect(promText).toContain('troy_memory_watchdog_evictions_total 1')
    expect(promText).toContain('troy_memory_watchdog_pressure_events_total 1')
    expect(promText).toContain('troy_memory_watchdog_gc_hints_total 1')

    // Verify ASCII formatter produces clean 7-bit ASCII
    const ascii = formatMemoryWatchdogAscii(watchdog.getStats())
    expect(ascii).toContain('TROY ADVANCED :: MEMORY WATCHDOG')
    expect(ascii).toContain('512 MiB')
    // eslint-disable-next-line no-control-regex
    expect(/^[\x09\x0a\x20-\x7e]+$/.test(ascii)).toBe(true)
  })
})
