// Graceful memory watchdog for Troy Advanced daemon.
// Periodically samples process RSS (or an injected RSS reader) and, when RSS
// exceeds --max-rss-mb, relieves memory pressure by:
//   1. Clearing cached page snapshots on idle background tabs
//   2. Auto-evicting the oldest idle background tabs (never evicting active tabs)
//   3. Triggering a GC hint (global.gc() when exposed via --expose-gc)

import type {
  MemoryWatchdogCheckResult,
  MemoryWatchdogEvent,
  MemoryWatchdogOptions,
  MemoryWatchdogStats,
  WatchdogTabInfo,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

export const DEFAULT_WATCHDOG_INTERVAL_MS = 10_000
export const MIN_WATCHDOG_INTERVAL_MS = 50
export const DEFAULT_IDLE_TAB_TTL_MS = 60_000
export const DEFAULT_MIN_TABS_TO_KEEP = 1
export const DEFAULT_MAX_EVICTIONS_PER_SWEEP = 2
export const DEFAULT_MAX_RECENT_EVENTS = 50
const BYTES_PER_MIB = 1024 * 1024

export interface MemoryWatchdogTarget {
  getTabs(): WatchdogTabInfo[]
  evictTab(tabId: number, reason: string): Promise<boolean>
  clearIdleCaches?(): number
}

export interface MemoryWatchdogHooks {
  /** Custom RSS byte reader (defaults to () => process.memoryUsage().rss). */
  readRssBytes?: () => number
  /** Custom GC trigger returning true if GC was actually invoked (defaults to globalThis.gc). */
  triggerGc?: () => boolean
  /** Custom clock returning epoch ms (defaults to Date.now). */
  now?: () => number
  /** Callback invoked whenever the watchdog takes a pressure-relief action. */
  onEvent?: (event: MemoryWatchdogEvent) => void
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0
  return round3(bytes / BYTES_PER_MIB)
}

function defaultTriggerGc(): boolean {
  const g = globalThis as unknown as { gc?: () => void }
  if (typeof g.gc === 'function') {
    g.gc()
    return true
  }
  return false
}

function hasDefaultGc(): boolean {
  const g = globalThis as unknown as { gc?: () => void }
  return typeof g.gc === 'function'
}

/**
 * Parse a --max-rss-mb CLI value or TROY_ADVANCED_MAX_RSS_MB environment variable.
 * Returns undefined when unset/empty, or throws an Error on invalid non-positive values.
 */
export function parseMaxRssMb(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`Invalid --max-rss-mb value: ${raw} (expected positive number in MiB)`)
    }
    return raw
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --max-rss-mb value: "${raw}" (expected positive number in MiB)`)
    }
    return parsed
  }
  throw new Error(`Invalid --max-rss-mb value: ${String(raw)} (expected positive number in MiB)`)
}

export class MemoryWatchdog {
  private readonly target: MemoryWatchdogTarget
  private readonly readRssBytes: () => number
  private readonly triggerGc: () => boolean
  private readonly hasCustomTriggerGc: boolean
  private readonly now: () => number
  private readonly onEvent?: (event: MemoryWatchdogEvent) => void

  readonly enabled: boolean
  readonly maxRssMb: number
  readonly maxRssBytes: number
  readonly checkIntervalMs: number
  readonly idleTabTtlMs: number
  readonly minTabsToKeep: number
  readonly maxEvictionsPerSweep: number
  readonly evictAnyBackgroundOnPressure: boolean
  readonly clearSnapshotsOnPressure: boolean
  readonly gcHintEnabled: boolean
  private readonly maxRecentEvents: number

  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<MemoryWatchdogCheckResult> | null = null

  private checksTotal = 0
  private pressureEventsTotal = 0
  private evictedTabsTotal = 0
  private cachesClearedTotal = 0
  private gcHintsTotal = 0
  private gcInvokedTotal = 0
  private lastCheckAt: string | null = null
  private lastActionAt: string | null = null
  private lastRssBytes = 0
  private peakRssBytes = 0
  private lastEvictedTabIds: number[] = []
  private recentEvents: MemoryWatchdogEvent[] = []

  constructor(
    target: MemoryWatchdogTarget,
    opts: MemoryWatchdogOptions = {},
    hooks: MemoryWatchdogHooks = {},
  ) {
    this.target = target
    this.readRssBytes = hooks.readRssBytes ?? (() => process.memoryUsage().rss)
    this.hasCustomTriggerGc = typeof hooks.triggerGc === 'function'
    this.triggerGc = hooks.triggerGc ?? defaultTriggerGc
    this.now = hooks.now ?? (() => Date.now())
    this.onEvent = hooks.onEvent

    const rawMax = opts.maxRssMb
    if (typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0) {
      this.enabled = true
      this.maxRssMb = round3(rawMax)
      this.maxRssBytes = Math.round(rawMax * BYTES_PER_MIB)
    } else {
      this.enabled = false
      this.maxRssMb = 0
      this.maxRssBytes = 0
    }

    this.checkIntervalMs =
      typeof opts.checkIntervalMs === 'number' && Number.isFinite(opts.checkIntervalMs)
        ? Math.max(MIN_WATCHDOG_INTERVAL_MS, Math.floor(opts.checkIntervalMs))
        : DEFAULT_WATCHDOG_INTERVAL_MS

    this.idleTabTtlMs =
      typeof opts.idleTabTtlMs === 'number' && Number.isFinite(opts.idleTabTtlMs) && opts.idleTabTtlMs >= 0
        ? Math.floor(opts.idleTabTtlMs)
        : DEFAULT_IDLE_TAB_TTL_MS

    this.minTabsToKeep =
      typeof opts.minTabsToKeep === 'number' && Number.isFinite(opts.minTabsToKeep) && opts.minTabsToKeep >= 0
        ? Math.floor(opts.minTabsToKeep)
        : DEFAULT_MIN_TABS_TO_KEEP

    this.maxEvictionsPerSweep =
      typeof opts.maxEvictionsPerSweep === 'number' &&
      Number.isFinite(opts.maxEvictionsPerSweep) &&
      opts.maxEvictionsPerSweep >= 0
        ? Math.floor(opts.maxEvictionsPerSweep)
        : DEFAULT_MAX_EVICTIONS_PER_SWEEP

    this.evictAnyBackgroundOnPressure = opts.evictAnyBackgroundOnPressure !== false
    this.clearSnapshotsOnPressure = opts.clearSnapshotsOnPressure !== false
    this.gcHintEnabled = opts.gcHint !== false
    this.maxRecentEvents =
      typeof opts.maxRecentEvents === 'number' && Number.isFinite(opts.maxRecentEvents) && opts.maxRecentEvents > 0
        ? Math.floor(opts.maxRecentEvents)
        : DEFAULT_MAX_RECENT_EVENTS
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  start(): boolean {
    if (!this.enabled) return false
    if (this.timer) return true
    this.timer = setInterval(() => {
      void this.checkOnce().catch(() => {
        // Best-effort background watchdog tick
      })
    }, this.checkIntervalMs)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
    return true
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Perform a single RSS inspection and graceful relief sweep.
   * Concurrent calls coalesce onto the in-flight sweep.
   */
  async checkOnce(): Promise<MemoryWatchdogCheckResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private sampleRss(): number {
    const raw = this.readRssBytes()
    const bytes = Number.isFinite(raw) && raw >= 0 ? raw : 0
    this.lastRssBytes = bytes
    if (bytes > this.peakRssBytes) {
      this.peakRssBytes = bytes
    }
    return bytes
  }

  private async runCheck(): Promise<MemoryWatchdogCheckResult> {
    const nowMs = this.now()
    const timestamp = new Date(nowMs).toISOString()
    const rssBytes = this.sampleRss()
    const rssMb = bytesToMb(rssBytes)

    this.checksTotal += 1
    this.lastCheckAt = timestamp

    if (!this.enabled) {
      return {
        enabled: false,
        overLimit: false,
        rssBytes,
        rssMb,
        afterRssBytes: rssBytes,
        afterRssMb: rssMb,
        maxRssMb: 0,
        evictedTabIds: [],
        cachesCleared: 0,
        gcHinted: false,
        gcInvoked: false,
        stillOverLimit: false,
        action: 'disabled',
      }
    }

    if (rssBytes <= this.maxRssBytes) {
      return {
        enabled: true,
        overLimit: false,
        rssBytes,
        rssMb,
        afterRssBytes: rssBytes,
        afterRssMb: rssMb,
        maxRssMb: this.maxRssMb,
        evictedTabIds: [],
        cachesCleared: 0,
        gcHinted: false,
        gcInvoked: false,
        stillOverLimit: false,
        action: 'ok',
      }
    }

    this.pressureEventsTotal += 1
    let currentRssBytes = rssBytes
    let cachesCleared = 0
    const evictedTabIds: number[] = []
    let gcHinted = false
    let gcInvoked = false

    // Step 1: Clear cached snapshots on idle background tabs (lightweight relief).
    if (this.clearSnapshotsOnPressure && typeof this.target.clearIdleCaches === 'function') {
      try {
        cachesCleared = Math.max(0, this.target.clearIdleCaches())
        this.cachesClearedTotal += cachesCleared
      } catch {
        cachesCleared = 0
      }
      if (cachesCleared > 0) {
        currentRssBytes = this.sampleRss()
      }
    }

    // Step 2: Gracefully evict oldest idle background tabs if still over limit.
    if (currentRssBytes > this.maxRssBytes && this.maxEvictionsPerSweep > 0) {
      const tabs = this.target.getTabs()
      const maxRemovable = Math.max(0, tabs.length - this.minTabsToKeep)
      const budget = Math.min(this.maxEvictionsPerSweep, maxRemovable)

      if (budget > 0) {
        const backgroundTabs = tabs
          .filter((t) => !t.active)
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt || a.createdAt - b.createdAt || a.id - b.id)

        const staleCandidates = backgroundTabs.filter((t) => nowMs - t.lastActiveAt >= this.idleTabTtlMs)
        const candidates =
          staleCandidates.length > 0
            ? staleCandidates
            : this.evictAnyBackgroundOnPressure
              ? backgroundTabs
              : []

        for (const tab of candidates.slice(0, budget)) {
          if (currentRssBytes <= this.maxRssBytes) break
          const idleSec = Math.max(0, Math.round((nowMs - tab.lastActiveAt) / 1000))
          const reason = `RSS ${bytesToMb(currentRssBytes)} MiB exceeded limit ${this.maxRssMb} MiB (idle ${idleSec}s)`
          try {
            const evicted = await this.target.evictTab(tab.id, reason)
            if (evicted) {
              evictedTabIds.push(tab.id)
              this.evictedTabsTotal += 1
              currentRssBytes = this.sampleRss()
            }
          } catch {
            // Continue with next candidate if one tab fails to close
          }
        }
      }
    }

    // Step 3: Trigger GC hint if still over limit (or if no tabs could be evicted).
    if (this.gcHintEnabled && (currentRssBytes > this.maxRssBytes || evictedTabIds.length === 0)) {
      gcHinted = true
      this.gcHintsTotal += 1
      try {
        gcInvoked = Boolean(this.triggerGc())
        if (gcInvoked) {
          this.gcInvokedTotal += 1
        }
      } catch {
        gcInvoked = false
      }
      currentRssBytes = this.sampleRss()
    }

    const afterRssBytes = currentRssBytes
    const afterRssMb = bytesToMb(afterRssBytes)
    const stillOverLimit = afterRssBytes > this.maxRssBytes

    let action: MemoryWatchdogCheckResult['action']
    if (evictedTabIds.length > 0 && gcHinted) {
      action = 'evicted_and_gc'
    } else if (evictedTabIds.length > 0) {
      action = 'evicted'
    } else if (gcHinted) {
      action = 'gc_hint'
    } else if (cachesCleared > 0) {
      action = 'cache_cleared'
    } else {
      action = 'over_limit_no_action'
    }

    const reasonParts: string[] = [
      `RSS ${rssMb} MiB > limit ${this.maxRssMb} MiB`,
    ]
    if (cachesCleared > 0) reasonParts.push(`cleared ${cachesCleared} cache(s)`)
    if (evictedTabIds.length > 0) reasonParts.push(`evicted tab(s) [${evictedTabIds.join(', ')}]`)
    if (gcHinted) reasonParts.push(gcInvoked ? 'GC invoked' : 'GC hint (unavailable; run Node with --expose-gc)')

    const event: MemoryWatchdogEvent = {
      type: 'memory_watchdog_action',
      timestamp,
      rssBytes,
      rssMb,
      afterRssBytes,
      afterRssMb,
      maxRssMb: this.maxRssMb,
      evictedTabIds,
      cachesCleared,
      gcHinted,
      gcInvoked,
      stillOverLimit,
      reason: reasonParts.join('; '),
    }

    this.lastActionAt = timestamp
    if (evictedTabIds.length > 0) {
      this.lastEvictedTabIds = [...evictedTabIds]
    }
    this.recentEvents.push(event)
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.splice(0, this.recentEvents.length - this.maxRecentEvents)
    }

    if (this.onEvent) {
      try {
        this.onEvent(event)
      } catch {
        // Never allow observer callback to break watchdog
      }
    }

    return {
      enabled: true,
      overLimit: true,
      rssBytes,
      rssMb,
      afterRssBytes,
      afterRssMb,
      maxRssMb: this.maxRssMb,
      evictedTabIds,
      cachesCleared,
      gcHinted,
      gcInvoked,
      stillOverLimit,
      action,
    }
  }

  getStats(): MemoryWatchdogStats {
    const rssBytes = this.lastRssBytes > 0 ? this.lastRssBytes : this.readRssBytes()
    const peakBytes = Math.max(this.peakRssBytes, rssBytes)
    return {
      enabled: this.enabled,
      running: this.isRunning(),
      maxRssMb: this.maxRssMb,
      maxRssBytes: this.maxRssBytes,
      checkIntervalMs: this.checkIntervalMs,
      idleTabTtlMs: this.idleTabTtlMs,
      minTabsToKeep: this.minTabsToKeep,
      maxEvictionsPerSweep: this.maxEvictionsPerSweep,
      gcHintEnabled: this.gcHintEnabled,
      gcAvailable: this.hasCustomTriggerGc || hasDefaultGc(),
      checksTotal: this.checksTotal,
      pressureEventsTotal: this.pressureEventsTotal,
      evictedTabsTotal: this.evictedTabsTotal,
      cachesClearedTotal: this.cachesClearedTotal,
      gcHintsTotal: this.gcHintsTotal,
      gcInvokedTotal: this.gcInvokedTotal,
      lastCheckAt: this.lastCheckAt,
      lastActionAt: this.lastActionAt,
      lastRssBytes: rssBytes,
      lastRssMb: bytesToMb(rssBytes),
      peakRssBytes: peakBytes,
      peakRssMb: bytesToMb(peakBytes),
      lastEvictedTabIds: [...this.lastEvictedTabIds],
      recentEvents: this.recentEvents.map((ev) => ({
        ...ev,
        evictedTabIds: [...ev.evictedTabIds],
      })),
    }
  }
}

export interface BrowserManagerWatchdogAdapter {
  getWatchdogTabInfo(): WatchdogTabInfo[]
  evictIdleTab(tabId: number, reason: string): Promise<boolean>
  clearIdleTabCaches(): number
}

export function createBrowserMemoryWatchdog(
  manager: BrowserManagerWatchdogAdapter,
  opts: MemoryWatchdogOptions = {},
  hooks: MemoryWatchdogHooks = {},
): MemoryWatchdog {
  return new MemoryWatchdog(
    {
      getTabs: () => manager.getWatchdogTabInfo(),
      evictTab: (tabId, reason) => manager.evictIdleTab(tabId, reason),
      clearIdleCaches: () => manager.clearIdleTabCaches(),
    },
    opts,
    hooks,
  )
}

export function formatMemoryWatchdogAscii(
  stats: MemoryWatchdogStats,
  opts: { width?: number } = {},
): string {
  const width = Math.max(52, Math.min(opts.width ?? 80, 140))
  const hr = '+' + '-'.repeat(width - 2) + '+'
  const title = sanitizeAscii('TROY ADVANCED :: MEMORY WATCHDOG')
  const lines: string[] = [
    hr,
    `| ${title.slice(0, width - 4).padEnd(width - 4)} |`,
    hr,
    `Status        : ${stats.enabled ? (stats.running ? 'ENABLED (running)' : 'ENABLED (stopped)') : 'DISABLED'}`,
    `Limit         : ${stats.enabled ? `${stats.maxRssMb} MiB (${stats.maxRssBytes} bytes)` : '(none; pass --max-rss-mb N)'}`,
    `RSS (now/peak): ${stats.lastRssMb} MiB / ${stats.peakRssMb} MiB`,
    `Poll / TTL    : interval=${stats.checkIntervalMs}ms  idleTtl=${stats.idleTabTtlMs}ms  minTabs=${stats.minTabsToKeep}`,
    `GC Hint       : ${stats.gcHintEnabled ? (stats.gcAvailable ? 'enabled (gc available)' : 'enabled (pass --expose-gc)') : 'disabled'}`,
    `Counters      : checks=${stats.checksTotal}  pressure=${stats.pressureEventsTotal}  evicted=${stats.evictedTabsTotal}  caches=${stats.cachesClearedTotal}  gcHints=${stats.gcHintsTotal}  gcInvoked=${stats.gcInvokedTotal}`,
    `Last Check    : ${stats.lastCheckAt ?? 'never'}`,
    `Last Action   : ${stats.lastActionAt ?? 'none'}`,
  ]
  if (stats.recentEvents.length > 0) {
    lines.push(hr)
    lines.push('Recent Watchdog Actions:')
    for (const ev of stats.recentEvents.slice(-5)) {
      lines.push(
        sanitizeAscii(
          `  [${ev.timestamp}] ${ev.rssMb} -> ${ev.afterRssMb} MiB: ${ev.reason}`,
        ).slice(0, width),
      )
    }
  }
  lines.push(hr)
  return lines.join('\n')
}
