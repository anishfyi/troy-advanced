// Automatic CDP tracker & ad-beacon request interception (`Fetch.enable` / `Network.setBlockedURLs`)
// backed by the single-source-of-truth tracker list in `src/agent/omnibox.ts`.

import { buildCdpTrackerUrlPatterns, isTrackerOrBeaconUrl } from '../agent/omnibox.js'
import type { BlockedTrackerStats, TrackerBlockingOptions, TrackerBlockMode } from '../types.js'

export interface CdpLike {
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>
}

export interface BlockedRequestEvent {
  url: string
  method: string
  resourceType?: string
  reason: 'tracker-host' | 'ad-beacon' | 'custom-pattern'
  matched?: string
}

export interface CdpTrackerBlockerCallbacks {
  onBlocked?: (event: BlockedRequestEvent) => void
}

function hostKeyFor(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || 'unknown'
  } catch {
    return 'unknown'
  }
}

export class CdpTrackerBlocker {
  private readonly cdp: CdpLike
  private readonly enabled: boolean
  private readonly mode: TrackerBlockMode
  private readonly extraBlockedHosts: readonly string[]
  private readonly extraBlockedUrlPatterns: readonly string[]
  private readonly includeBeacons: boolean
  private readonly callbacks: CdpTrackerBlockerCallbacks

  private effectiveMode: TrackerBlockMode = 'off'
  private patterns: string[] = []
  private blockedCount = 0
  private continuedCount = 0
  private blockedByHost = new Map<string, number>()
  private offPaused: (() => void) | null = null

  constructor(cdp: CdpLike, opts: TrackerBlockingOptions = {}, callbacks: CdpTrackerBlockerCallbacks = {}) {
    this.cdp = cdp
    const requestedMode: TrackerBlockMode = opts.enabled === false ? 'off' : (opts.mode ?? 'fetch')
    this.enabled = requestedMode !== 'off'
    this.mode = requestedMode
    this.extraBlockedHosts = opts.extraBlockedHosts ?? []
    this.extraBlockedUrlPatterns = opts.extraBlockedUrlPatterns ?? []
    this.includeBeacons = opts.includeBeacons !== false
    this.callbacks = callbacks
  }

  async enable(): Promise<void> {
    if (!this.enabled || this.mode === 'off') {
      this.effectiveMode = 'off'
      return
    }

    this.patterns = buildCdpTrackerUrlPatterns({
      extraHosts: this.extraBlockedHosts,
      extraUrlPatterns: this.extraBlockedUrlPatterns,
      includeBeacons: this.includeBeacons,
    })

    if (this.patterns.length === 0) {
      this.effectiveMode = 'off'
      return
    }

    if (this.mode === 'network') {
      await this.cdp.send('Network.setBlockedURLs', { urls: this.patterns })
      this.effectiveMode = 'network'
      return
    }

    // Register Fetch.requestPaused handler before Fetch.enable so no paused requests can be missed.
    this.offPaused = this.cdp.on('Fetch.requestPaused', (params) => {
      void this.handleRequestPaused(params)
    })

    try {
      await this.cdp.send('Fetch.enable', {
        patterns: this.patterns.map((urlPattern) => ({
          urlPattern,
          requestStage: 'Request',
        })),
      })

      if (this.mode === 'both') {
        await this.cdp.send('Network.setBlockedURLs', { urls: this.patterns })
        this.effectiveMode = 'both'
      } else {
        this.effectiveMode = 'fetch'
      }
    } catch {
      // Graceful fallback to Network.setBlockedURLs if Fetch domain is unavailable on this target.
      this.offPaused?.()
      this.offPaused = null
      await this.cdp.send('Network.setBlockedURLs', { urls: this.patterns })
      this.effectiveMode = 'network'
    }
  }

  private async handleRequestPaused(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? '')
    if (!requestId) return
    const req = (params.request as { url?: string; method?: string } | undefined) ?? {}
    const url = String(req.url ?? '')
    const method = String(req.method ?? 'GET')
    const resourceType = params.resourceType ? String(params.resourceType) : undefined

    const match = this.matchUrl(url)
    if (match.blocked && match.reason) {
      this.recordBlock(url)
      this.callbacks.onBlocked?.({
        url,
        method,
        resourceType,
        reason: match.reason,
        matched: match.matched,
      })
      await this.cdp
        .send('Fetch.failRequest', {
          requestId,
          errorReason: 'BlockedByClient',
        })
        .catch(() => {})
      return
    }

    // False-positive wildcard match (e.g., tracker host appeared in query string, not hostname): continue cleanly.
    this.continuedCount += 1
    await this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
  }

  matchUrl(rawUrl: string) {
    return isTrackerOrBeaconUrl(rawUrl, {
      extraHosts: this.extraBlockedHosts,
      extraUrlPatterns: this.extraBlockedUrlPatterns,
      includeBeacons: this.includeBeacons,
    })
  }

  /**
   * Called by ChromiumTab when `Network.loadingFailed` reports a client-blocked request
   * under `network` mode (where `Fetch.requestPaused` did not fire).
   */
  recordNetworkLevelBlock(rawUrl: string): { blocked: boolean; reason?: string } {
    if (!this.enabled) return { blocked: false }
    const match = this.matchUrl(rawUrl)
    if (!match.blocked) return { blocked: false }
    if (this.effectiveMode === 'network' || this.effectiveMode === 'both') {
      this.recordBlock(rawUrl)
    }
    return { blocked: true, reason: match.reason }
  }

  private recordBlock(rawUrl: string): void {
    this.blockedCount += 1
    const host = hostKeyFor(rawUrl)
    this.blockedByHost.set(host, (this.blockedByHost.get(host) ?? 0) + 1)
  }

  getStats(): BlockedTrackerStats {
    const byHost: Record<string, number> = {}
    for (const [k, v] of this.blockedByHost.entries()) {
      byHost[k] = v
    }
    return {
      enabled: this.enabled,
      mode: this.mode,
      effectiveMode: this.effectiveMode,
      patternCount: this.patterns.length,
      blockedCount: this.blockedCount,
      continuedCount: this.continuedCount,
      blockedByHost: byHost,
    }
  }

  async disable(): Promise<void> {
    this.offPaused?.()
    this.offPaused = null
    if (this.effectiveMode === 'fetch' || this.effectiveMode === 'both') {
      await this.cdp.send('Fetch.disable').catch(() => {})
    }
    if (this.effectiveMode === 'network' || this.effectiveMode === 'both') {
      await this.cdp.send('Network.setBlockedURLs', { urls: [] }).catch(() => {})
    }
    this.effectiveMode = 'off'
  }
}
