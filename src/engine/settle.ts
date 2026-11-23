// Network idle + DOM mutation settle detector (waitForPageSettle)
// Ensures SPAs finish async data fetching and DOM hydration before snapshots.

import type { SettleOptions, SettleResult } from '../types.js'

export interface RequiredSettleOptions {
  timeoutMs: number
  networkIdleMs: number
  domQuietMs: number
  maxInflightRequests: number
  waitForNetworkIdle: boolean
  waitForDomQuiet: boolean
  staleRequestMs: number
  pollIntervalMs: number
}

export const DEFAULT_SETTLE_OPTIONS: RequiredSettleOptions = {
  timeoutMs: 3000,
  networkIdleMs: 250,
  domQuietMs: 200,
  maxInflightRequests: 0,
  waitForNetworkIdle: true,
  waitForDomQuiet: true,
  staleRequestMs: 5000,
  pollIntervalMs: 40,
}

const IGNORED_RESOURCE_TYPES = new Set(['eventsource', 'websocket'])

function clamp(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback
  return Math.max(min, Math.min(max, Math.round(val)))
}

export function normalizeSettleOptions(opts: SettleOptions = {}): RequiredSettleOptions {
  return {
    timeoutMs: clamp(opts.timeoutMs ?? DEFAULT_SETTLE_OPTIONS.timeoutMs, 0, 30000, DEFAULT_SETTLE_OPTIONS.timeoutMs),
    networkIdleMs: clamp(
      opts.networkIdleMs ?? DEFAULT_SETTLE_OPTIONS.networkIdleMs,
      0,
      15000,
      DEFAULT_SETTLE_OPTIONS.networkIdleMs,
    ),
    domQuietMs: clamp(
      opts.domQuietMs ?? DEFAULT_SETTLE_OPTIONS.domQuietMs,
      0,
      15000,
      DEFAULT_SETTLE_OPTIONS.domQuietMs,
    ),
    maxInflightRequests: clamp(
      opts.maxInflightRequests ?? DEFAULT_SETTLE_OPTIONS.maxInflightRequests,
      0,
      20,
      DEFAULT_SETTLE_OPTIONS.maxInflightRequests,
    ),
    waitForNetworkIdle: opts.waitForNetworkIdle !== false,
    waitForDomQuiet: opts.waitForDomQuiet !== false,
    staleRequestMs: clamp(
      opts.staleRequestMs ?? DEFAULT_SETTLE_OPTIONS.staleRequestMs,
      500,
      60000,
      DEFAULT_SETTLE_OPTIONS.staleRequestMs,
    ),
    pollIntervalMs: clamp(
      opts.pollIntervalMs ?? DEFAULT_SETTLE_OPTIONS.pollIntervalMs,
      10,
      500,
      DEFAULT_SETTLE_OPTIONS.pollIntervalMs,
    ),
  }
}

interface TrackedRequest {
  url: string
  resourceType?: string
  startedAt: number
}

export interface NetworkIdleStatus {
  idle: boolean
  inflightCount: number
  quietForMs: number
}

/**
 * Tracks inflight network requests (CDP Network.* or synthetic) and determines
 * when the network has been quiet (<= maxInflightRequests) for at least `quietMs`.
 * Automatically ignores long-lived streaming connections (EventSource/WebSocket)
 * and non-network URLs (data:/blob:/about:) as well as stale hanging requests.
 */
export class NetworkIdleTracker {
  private inflight = new Map<string, TrackedRequest>()
  private lastActivityAt: number

  constructor(initialNow: number = Date.now()) {
    this.lastActivityAt = initialNow
  }

  private shouldIgnore(url: string, resourceType?: string): boolean {
    if (resourceType && IGNORED_RESOURCE_TYPES.has(resourceType.toLowerCase())) {
      return true
    }
    const lower = url.trim().toLowerCase()
    if (!lower || lower.startsWith('data:') || lower.startsWith('blob:') || lower.startsWith('about:')) {
      return true
    }
    return false
  }

  onRequestStart(requestId: string, url: string, resourceType?: string, now: number = Date.now()): void {
    if (!requestId || this.shouldIgnore(url, resourceType)) return
    this.inflight.set(requestId, { url, resourceType, startedAt: now })
    this.lastActivityAt = Math.max(this.lastActivityAt, now)
  }

  onRequestFinish(requestId: string, now: number = Date.now()): void {
    if (!requestId) return
    if (this.inflight.delete(requestId)) {
      this.lastActivityAt = Math.max(this.lastActivityAt, now)
    }
  }

  onNavigationReset(now: number = Date.now()): void {
    this.inflight.clear()
    this.lastActivityAt = Math.max(this.lastActivityAt, now)
  }

  pruneStale(now: number = Date.now(), staleRequestMs: number = DEFAULT_SETTLE_OPTIONS.staleRequestMs): number {
    let pruned = 0
    for (const [id, req] of this.inflight) {
      if (now - req.startedAt >= staleRequestMs) {
        this.inflight.delete(id)
        this.lastActivityAt = Math.max(this.lastActivityAt, req.startedAt + staleRequestMs)
        pruned += 1
      }
    }
    return pruned
  }

  getInflightCount(now: number = Date.now(), staleRequestMs: number = DEFAULT_SETTLE_OPTIONS.staleRequestMs): number {
    this.pruneStale(now, staleRequestMs)
    return this.inflight.size
  }

  getStatus(opts: {
    quietMs: number
    maxInflight?: number
    staleRequestMs?: number
    now?: number
  }): NetworkIdleStatus {
    const now = opts.now ?? Date.now()
    const maxInflight = opts.maxInflight ?? 0
    const staleRequestMs = opts.staleRequestMs ?? DEFAULT_SETTLE_OPTIONS.staleRequestMs
    const inflightCount = this.getInflightCount(now, staleRequestMs)
    const quietForMs = inflightCount <= maxInflight ? Math.max(0, now - this.lastActivityAt) : 0
    return {
      idle: inflightCount <= maxInflight && quietForMs >= opts.quietMs,
      inflightCount,
      quietForMs,
    }
  }
}

export interface DomQuietStatus {
  quiet: boolean
  mutationCount: number
  quietForMs: number
  readyState?: string
}

/**
 * In-page script for Chromium Runtime.evaluate:
 * Idempotently installs a MutationObserver on document.documentElement (or document)
 * and reports how long the DOM has been free of mutations along with document.readyState.
 */
export const DOM_SETTLE_PROBE_SCRIPT = `(() => {
  const root = document.documentElement || document;
  const now = performance.now();
  let state = window.__troySettle;
  if (!state || state.root !== root) {
    if (state && state.observer) {
      try { state.observer.disconnect(); } catch {}
    }
    state = {
      root,
      installedAt: now,
      lastMutationAt: now,
      mutationCount: 0,
      observer: null,
    };
    if (typeof MutationObserver === 'function' && root) {
      const obs = new MutationObserver((records) => {
        state.mutationCount += records.length || 1;
        state.lastMutationAt = performance.now();
      });
      try {
        obs.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        state.observer = obs;
      } catch {}
    }
    const bump = () => {
      state.lastMutationAt = performance.now();
    };
    window.addEventListener('DOMContentLoaded', bump, { once: true });
    window.addEventListener('load', bump, { once: true });
    window.__troySettle = state;
  }
  const quietForMs = Math.max(0, Math.round(performance.now() - state.lastMutationAt));
  return {
    readyState: String(document.readyState || 'complete'),
    mutationCount: state.mutationCount,
    quietForMs,
  };
})()`

export interface PageSettleProbes {
  checkNetwork?: (
    now: number,
    opts: RequiredSettleOptions,
  ) => Promise<{ idle: boolean; inflightCount: number }> | { idle: boolean; inflightCount: number }
  checkDom?: (
    now: number,
    opts: RequiredSettleOptions,
  ) => Promise<DomQuietStatus> | DomQuietStatus
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export async function waitForPageSettle(
  probes: PageSettleProbes,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const opts = normalizeSettleOptions(options)
  const nowFn = probes.now ?? Date.now
  const sleepFn = probes.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  if (!opts.waitForNetworkIdle && !opts.waitForDomQuiet) {
    return {
      ok: true,
      settled: true,
      timedOut: false,
      waitedMs: 0,
      networkIdle: true,
      domQuiet: true,
      inflightCount: 0,
      mutationCount: 0,
      reason: 'skipped',
    }
  }

  const startedAt = nowFn()
  const deadline = startedAt + opts.timeoutMs

  let networkIdle = !opts.waitForNetworkIdle
  let domQuiet = !opts.waitForDomQuiet
  let inflightCount = 0
  let mutationCount = 0

  while (true) {
    const currentNow = nowFn()

    if (opts.waitForNetworkIdle) {
      if (probes.checkNetwork) {
        try {
          const net = await probes.checkNetwork(currentNow, opts)
          networkIdle = Boolean(net.idle)
          inflightCount = net.inflightCount
        } catch {
          networkIdle = false
        }
      } else {
        networkIdle = true
        inflightCount = 0
      }
    }

    if (opts.waitForDomQuiet) {
      if (probes.checkDom) {
        try {
          const dom = await probes.checkDom(currentNow, opts)
          domQuiet = Boolean(dom.quiet)
          mutationCount = dom.mutationCount
        } catch {
          // Transient navigation / destroyed execution context: keep polling.
          domQuiet = false
        }
      } else {
        domQuiet = true
      }
    }

    if (networkIdle && domQuiet) {
      return {
        ok: true,
        settled: true,
        timedOut: false,
        waitedMs: Math.max(0, nowFn() - startedAt),
        networkIdle: true,
        domQuiet: true,
        inflightCount,
        mutationCount,
        reason: 'settled',
      }
    }

    const remaining = deadline - nowFn()
    if (remaining <= 0) {
      const pendingParts: string[] = []
      if (!networkIdle) pendingParts.push(`network idle (${inflightCount} inflight)`)
      if (!domQuiet) pendingParts.push(`DOM quiet (${mutationCount} mutations)`)
      return {
        ok: false,
        settled: false,
        timedOut: true,
        waitedMs: Math.max(0, nowFn() - startedAt),
        networkIdle,
        domQuiet,
        inflightCount,
        mutationCount,
        reason: 'timeout',
        error: `Timed out after ${opts.timeoutMs}ms waiting for page settle (${pendingParts.join(', ')})`,
      }
    }

    await sleepFn(Math.min(opts.pollIntervalMs, remaining))
  }
}
