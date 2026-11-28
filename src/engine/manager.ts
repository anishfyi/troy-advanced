// BrowserManager: orchestrates tabs, engine selection (Chromium or Lite),
// per-tab ElementRegistry, deterministic Policy enforcement, PageMemory,
// Delta reads, and ASCII / Pixel-ASCII rendering.

import path from 'node:path'
import os from 'node:os'
import type {
  ActStep,
  AgentActivityEntry,
  AgentSessionSummary,
  AsciiRenderOptions,
  AuditEntry,
  AuditLogOptions,
  AuditQueryOptions,
  AuditStats,
  BrowserCookie,
  ConsoleEntry,
  CookieExportOptions,
  CookieImportResult,
  CrashRecoveryOptions,
  CrashRecoveryStats,
  DialogEntry,
  DialogPolicyOptions,
  DialogQueuedResponse,
  DialogStats,
  DialogType,
  DownloadEntry,
  DownloadPolicyOptions,
  DownloadStats,
  DownloadStatus,
  ElementDescriptor,
  EmulationOptions,
  EmulationProfile,
  EmulationUpdateMode,
  EngineKind,
  LoopGuardCategory,
  LoopGuardOptions,
  LoopGuardStats,
  MarkdownRenderOptions,
  NetworkEntry,
  OriginStorageSnapshot,
  PageSnapshot,
  PixelAsciiOptions,
  Rect,
  SettleOptions,
  SettleResult,
  SsrfProtectionOptions,
  SsrfProtectionStats,
  StorageClearOptions,
  StorageClearResult,
  StorageExportOptions,
  StorageImportOptions,
  StorageImportResult,
  TabSummary,
  TokenBudgetReport,
  TrackerBlockingOptions,
  UntrustedMarkersOptions,
  UntrustedMarkersStats,
  UntrustedWrapMetadata,
} from '../types.js'
import {
  ElementRegistry,
  recoverElementMatch,
  type RefContext,
  type RefRecoveryStrategy,
} from '../agent/elements.js'
import { findElements } from '../agent/find.js'
import { PageMemory } from '../agent/memory.js'
import {
  bindRecalledElements,
  formatRecallAscii,
  type BoundRecallElement,
  type RecallAutoBindResult,
} from '../agent/recall-bind.js'
import { AuditLogger, extractRefusalInfo } from '../agent/audit.js'
import { AgentLoopGuard, type LoopGuardConfig } from '../agent/loop-guard.js'
import {
  extractStructuredData,
  formatExtractAscii,
  parseExtractSections,
} from '../agent/extract.js'
import { SessionRegistry } from '../agent/sessions.js'
import { exactOrigin, normalizeOrigin, resolveInput } from '../agent/omnibox.js'
import { authorizeAction } from '../agent/policy.js'
import { SsrfGuard, isSsrfBlockedError } from '../agent/ssrf.js'
import {
  UntrustedContentGuard,
  estimateUntrustedWrapperTokenOverhead,
  parseUntrustedMarkersBoolean,
  parseUntrustedMarkersStyle,
} from '../agent/untrusted-markers.js'
import { computePageDelta, type PageDelta } from '../agent/delta.js'
import {
  estimateTokens,
  extractMediaSummary,
  parseAsciiDensity,
  parseMaxTokens,
  renderCanvasPreviewAscii,
  renderCompactRefsAscii,
  renderDeltaAscii,
  renderMediaSummaryAscii,
  renderPageAsciiWithMetrics,
  trimAsciiToTokenBudget,
} from '../ascii/layout.js'
import { renderPageMarkdown } from '../ascii/markdown.js'
import { parseCropRect, renderPngToAscii } from '../ascii/pixels.js'
import { ChromiumBrowserEngine, findChromeBinary } from './chromium.js'
import { formatNetworkListAscii } from './network.js'
import { defaultDisabledCrashRecoveryStats } from './crash-recovery.js'
import { formatDialogsAscii, parseDialogMode, parseDialogType } from './dialogs.js'
import {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  formatDownloadsAscii,
  parseDownloadMode,
} from './downloads.js'
import {
  defaultEmulationProfile,
  formatEmulationAscii,
  redactHeaders,
} from './emulation.js'
import {
  countStorageKeys,
  filterStorageSnapshots,
  formatStorageAscii,
  normalizeOriginStorageSnapshot,
  normalizeStorageArea,
  normalizeStorageOrigin,
  originFilterMatches,
  redactStorageSnapshots,
} from './storage.js'
import { LiteBrowserEngine } from './lite.js'
import type { ResponseCacheHooks, ResponseCacheOptions } from './response-cache.js'
import type {
  RateLimitOptions,
  RetryPolicyOptions,
  RobotsPolicyOptions,
  RobotsRetryHooks,
} from './robots-retry.js'
import type { BrowserEngine, TabDriver } from './types.js'
import { parseWaitState } from './wait.js'

const MAX_TOOL_CHARS = 20000

function capPayload<T extends Record<string, unknown>>(payload: T): T {
  const str = JSON.stringify(payload)
  if (str.length <= MAX_TOOL_CHARS) return payload
  if (typeof payload.content === 'string') {
    return {
      ...payload,
      content: payload.content.slice(0, MAX_TOOL_CHARS - 600),
      truncated: true,
    }
  }
  return payload
}

interface TabSession {
  driver: TabDriver
  elements: ElementRegistry
  lastSnapshot: PageSnapshot | null
  ownedByBridge: boolean
  ownerSession?: string
}

export interface BrowserManagerOptions {
  engine?: EngineKind
  profileDir?: string
  cdpPort?: number
  remoteCdpPort?: number
  cdpUrl?: string
  cdpConnectTimeoutMs?: number
  memoryEnabled?: boolean
  chromeBin?: string
  trackerBlocking?: TrackerBlockingOptions
  emulation?: EmulationOptions
  crashRecovery?: CrashRecoveryOptions
  downloads?: DownloadPolicyOptions
  dialogs?: DialogPolicyOptions
  robots?: RobotsPolicyOptions
  retry?: RetryPolicyOptions
  rateLimit?: RateLimitOptions
  robotsRetryHooks?: RobotsRetryHooks
  cache?: ResponseCacheOptions
  cacheHooks?: ResponseCacheHooks
  audit?: AuditLogOptions
  loopGuard?: LoopGuardOptions
  ssrf?: SsrfProtectionOptions
  untrustedMarkers?: boolean | UntrustedMarkersOptions
}

export class BrowserManager {
  readonly engine: BrowserEngine
  readonly profileDir: string
  readonly memory: PageMemory | null
  readonly audit: AuditLogger
  readonly loopGuard: AgentLoopGuard
  readonly ssrf: SsrfGuard
  readonly untrustedMarkers: UntrustedContentGuard
  private tabs = new Map<number, TabSession>()
  private activeTabId: number | null = null
  private allowedOrigins = new Set<string>()
  private sessions = new SessionRegistry()
  private eventListeners = new Set<(event: Record<string, unknown>) => void>()
  private activityLog: AgentActivityEntry[] = []
  private nextActivityId = 1
  private unsubscribeCrash?: () => void
  private unsubscribeDownloads?: () => void
  private unsubscribeDialogs?: () => void

  private constructor(
    engine: BrowserEngine,
    profileDir: string,
    memory: PageMemory | null,
    audit: AuditLogger,
    loopGuard: AgentLoopGuard,
    ssrf: SsrfGuard,
    untrustedMarkers: UntrustedContentGuard,
  ) {
    this.engine = engine
    this.profileDir = profileDir
    this.memory = memory
    this.audit = audit
    this.loopGuard = loopGuard
    this.ssrf = ssrf
    this.untrustedMarkers = untrustedMarkers
    if (engine.onCrashRecovery) {
      this.unsubscribeCrash = engine.onCrashRecovery((ev) => {
        if (ev.kind === 'chromium_recovered') {
          for (const session of this.tabs.values()) {
            session.lastSnapshot = null
          }
        }
        this.emit({ type: ev.kind, ...ev })
      })
    }
    if (engine.onDownloadEvent) {
      this.unsubscribeDownloads = engine.onDownloadEvent((ev) => {
        this.emit({ type: ev.kind, download: ev.entry })
      })
    }
    if (engine.onDialogEvent) {
      this.unsubscribeDialogs = engine.onDialogEvent((ev) => {
        this.emit({ type: ev.kind, dialog: ev.entry })
      })
    }
  }

  static async create(opts: BrowserManagerOptions = {}): Promise<BrowserManager> {
    const profileDir =
      opts.profileDir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'troy-advanced', 'profile')

    const downloadsOpts: DownloadPolicyOptions = {
      ...opts.downloads,
      quarantineDir: opts.downloads?.quarantineDir || path.join(profileDir, 'quarantine'),
    }
    const ssrfGuard = new SsrfGuard(opts.ssrf)

    let engine: BrowserEngine
    const requested = opts.engine ?? 'auto'
    if (requested === 'lite') {
      engine = new LiteBrowserEngine({
        emulation: opts.emulation,
        profileDir,
        downloads: downloadsOpts,
        dialogs: opts.dialogs,
        robots: opts.robots,
        retry: opts.retry,
        rateLimit: opts.rateLimit,
        robotsRetryHooks: opts.robotsRetryHooks,
        cache: opts.cache,
        cacheHooks: opts.cacheHooks,
        ssrfGuard,
      })
    } else if (requested === 'chromium' || opts.cdpUrl) {
      // Explicit --engine chromium or explicit --cdp-url must fail loudly if unreachable
      engine = await ChromiumBrowserEngine.launch({
        chromeBin: opts.chromeBin,
        cdpPort: opts.cdpPort,
        remoteCdpPort: opts.remoteCdpPort,
        cdpUrl: opts.cdpUrl,
        cdpConnectTimeoutMs: opts.cdpConnectTimeoutMs,
        profileDir: path.join(profileDir, 'chrome-data'),
        trackerBlocking: opts.trackerBlocking,
        emulation: opts.emulation,
        crashRecovery: opts.crashRecovery,
        downloads: downloadsOpts,
        dialogs: opts.dialogs,
        ssrfGuard,
      })
    } else {
      // Auto: prefer Chromium if installed and launchable, gracefully fall back to Lite on minimal EC2/containers
      if (opts.remoteCdpPort || opts.chromeBin || findChromeBinary()) {
        try {
          engine = await ChromiumBrowserEngine.launch({
            chromeBin: opts.chromeBin,
            cdpPort: opts.cdpPort,
            remoteCdpPort: opts.remoteCdpPort,
            profileDir: path.join(profileDir, 'chrome-data'),
            trackerBlocking: opts.trackerBlocking,
            emulation: opts.emulation,
            crashRecovery: opts.crashRecovery,
            downloads: downloadsOpts,
            dialogs: opts.dialogs,
            ssrfGuard,
          })
        } catch {
          engine = new LiteBrowserEngine({
            emulation: opts.emulation,
            profileDir,
            downloads: downloadsOpts,
            dialogs: opts.dialogs,
            robots: opts.robots,
            retry: opts.retry,
            rateLimit: opts.rateLimit,
            robotsRetryHooks: opts.robotsRetryHooks,
            cache: opts.cache,
            cacheHooks: opts.cacheHooks,
            ssrfGuard,
          })
        }
      } else {
        engine = new LiteBrowserEngine({
          emulation: opts.emulation,
          profileDir,
          downloads: downloadsOpts,
          dialogs: opts.dialogs,
          robots: opts.robots,
          retry: opts.retry,
          rateLimit: opts.rateLimit,
          robotsRetryHooks: opts.robotsRetryHooks,
          cache: opts.cache,
          cacheHooks: opts.cacheHooks,
          ssrfGuard,
        })
      }
    }

    const memory = opts.memoryEnabled === false ? null : new PageMemory(path.join(profileDir, 'memory.json'))
    const audit = new AuditLogger({
      filePath: opts.audit?.filePath || path.join(profileDir, 'audit.jsonl'),
      enabled: opts.audit?.enabled !== false,
      maxMemoryEntries: opts.audit?.maxMemoryEntries,
      redactArgs: opts.audit?.redactArgs,
    })
    const loopGuard = new AgentLoopGuard(opts.loopGuard)
    const untrustedMarkersGuard = new UntrustedContentGuard(opts.untrustedMarkers)
    return new BrowserManager(engine, profileDir, memory, audit, loopGuard, ssrfGuard, untrustedMarkersGuard)
  }

  getSsrfStats(): SsrfProtectionStats {
    return this.ssrf.getStats()
  }

  getUntrustedMarkersStats(): UntrustedMarkersStats {
    return this.untrustedMarkers.getStats()
  }

  private resolveUntrustedOverride(
    rawFlag: unknown,
    rawStyle?: unknown,
  ): boolean | UntrustedMarkersOptions | undefined {
    const style = parseUntrustedMarkersStyle(rawStyle)
    if (rawFlag && typeof rawFlag === 'object' && !Array.isArray(rawFlag)) {
      const obj = rawFlag as UntrustedMarkersOptions
      return style ? { ...obj, style } : obj
    }
    const parsedBool = parseUntrustedMarkersBoolean(rawFlag)
    if (parsedBool === undefined) {
      return style ? { enabled: this.untrustedMarkers.enabled, style } : undefined
    }
    if (style) {
      return { enabled: parsedBool, style }
    }
    return parsedBool
  }

  getLoopGuardStats(): LoopGuardStats {
    return this.loopGuard.getStats()
  }

  getLoopGuardConfig(): LoopGuardConfig {
    return this.loopGuard.getConfig()
  }

  setLoopGuardConfig(patch: LoopGuardOptions): LoopGuardConfig {
    return this.loopGuard.setConfig(patch)
  }

  getLoopGuardPatterns(filter?: { sessionId?: string; tabId?: number }) {
    return this.loopGuard.getActivePatterns(filter)
  }

  resetLoopGuard(filter?: { sessionId?: string; tabId?: number; category?: LoopGuardCategory }): number {
    return this.loopGuard.reset(filter)
  }

  getAuditLog(opts?: AuditQueryOptions): AuditEntry[] {
    return this.audit.query(opts)
  }

  getAuditStats(): AuditStats {
    return this.audit.stats()
  }

  clearAuditLog(opts?: { truncateFile?: boolean }): { clearedMemory: number; truncatedFile: boolean } {
    return this.audit.clear(opts)
  }

  onEvent(fn: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  private emit(event: Record<string, unknown>): void {
    for (const fn of this.eventListeners) {
      try {
        fn({ ts: Date.now(), ...event })
      } catch {
        // ignore listener failure
      }
    }
  }

  private recordActivity(entry: Omit<AgentActivityEntry, 'id'>): void {
    const item: AgentActivityEntry = { id: this.nextActivityId++, ...entry }
    this.activityLog.push(item)
    if (this.activityLog.length > 200) {
      this.activityLog.splice(0, this.activityLog.length - 200)
    }
    this.emit({ type: 'agent_activity', activity: item })
  }

  private summarizeToolArgs(name: string, args: Record<string, unknown>): string {
    const parts: string[] = []
    if (typeof args.ref === 'string' && args.ref) parts.push(`ref=${args.ref}`)
    if (typeof args.url === 'string' && args.url) parts.push(`url=${args.url}`)
    if (typeof args.query === 'string' && args.query) parts.push(`q="${args.query}"`)
    if (typeof args.selector === 'string' && args.selector) parts.push(`sel="${args.selector}"`)
    if (typeof args.direction === 'string' && args.direction) parts.push(args.direction)
    if (typeof args.key === 'string' && args.key) parts.push(`key=${args.key}`)
    if (typeof args.value === 'string' && args.value) parts.push(`val="${args.value.slice(0, 24)}"`)
    if (typeof args.text === 'string' && args.text) parts.push(`text="${args.text.slice(0, 24)}"`)
    if (Array.isArray(args.steps)) parts.push(`steps=${args.steps.length}`)
    if (parts.length === 0) return name
    return parts.join(' ')
  }

  getAgentActivity(opts: { limit?: number; tabId?: number; clear?: boolean } = {}): AgentActivityEntry[] {
    let entries = opts.tabId !== undefined
      ? this.activityLog.filter((e) => e.tabId === opts.tabId)
      : [...this.activityLog]
    if (typeof opts.limit === 'number' && opts.limit > 0 && entries.length > opts.limit) {
      entries = entries.slice(-opts.limit)
    }
    const snapshot = entries.map((e) => ({ ...e }))
    if (opts.clear) {
      if (opts.tabId !== undefined) {
        this.activityLog = this.activityLog.filter((e) => e.tabId !== opts.tabId)
      } else {
        this.activityLog = []
      }
    }
    return snapshot
  }

  getTabConsole(
    tabId?: number,
    opts: { limit?: number; level?: string; clear?: boolean } = {},
  ): ConsoleEntry[] {
    const session = this.resolveSession(tabId)
    if (!session) return []
    return session.driver.getConsole({
      clear: Boolean(opts.clear),
      level: opts.level,
      limit: opts.limit ?? 100,
    })
  }

  getTabNetwork(
    tabId?: number,
    opts: { limit?: number; failedOnly?: boolean; blockedOnly?: boolean; method?: string; urlFilter?: string; clear?: boolean } = {},
  ): NetworkEntry[] {
    const session = this.resolveSession(tabId)
    if (!session) return []
    return session.driver.getNetwork({
      clear: Boolean(opts.clear),
      failedOnly: Boolean(opts.failedOnly),
      blockedOnly: Boolean(opts.blockedOnly),
      method: opts.method,
      urlFilter: opts.urlFilter,
      limit: opts.limit ?? 100,
    })
  }

  listSessions(): AgentSessionSummary[] {
    return this.sessions.list()
  }

  getSession(sessionId: string): AgentSessionSummary | null {
    return this.sessions.get(sessionId)
  }

  async closeSession(
    sessionId: string,
    opts: { closeTabs?: boolean } = {},
  ): Promise<{ ok: boolean; sessionId: string; closedTabIds: number[]; removed: boolean; error?: string }> {
    const startedAt = Date.now()
    const summary = this.sessions.get(sessionId)
    if (!summary) {
      return { ok: false, sessionId, closedTabIds: [], removed: false, error: `no session "${sessionId}"` }
    }
    const closeTabs = opts.closeTabs !== false
    const closedTabIds: number[] = []
    if (closeTabs) {
      for (const tabId of [...summary.ownedTabIds]) {
        const tab = this.tabs.get(tabId)
        if (!tab) continue
        await tab.driver.close()
        this.tabs.delete(tabId)
        closedTabIds.push(tabId)
        if (this.activeTabId === tabId) {
          const next = this.tabs.keys().next()
          this.activeTabId = next.done ? null : next.value
        }
        this.emit({ type: 'tab_closed', tabId, sessionId })
      }
    } else {
      for (const tabId of summary.ownedTabIds) {
        const tab = this.tabs.get(tabId)
        if (tab) tab.ownerSession = undefined
      }
    }
    const del = this.sessions.delete(sessionId)
    this.loopGuard.reset({ sessionId })
    this.emit({ type: 'session_closed', sessionId, closedTabIds })
    this.audit.record({
      tsMs: startedAt,
      kind: 'tab_action',
      tool: 'session_close',
      sessionId,
      ok: true,
      refused: false,
      durationMs: Date.now() - startedAt,
      args: { sessionId, closeTabs },
      summary: `closed session "${sessionId}" (${closedTabIds.length} tabs)`,
    })
    return { ok: true, sessionId, closedTabIds, removed: del.removed }
  }

  listTabs(opts: { sessionId?: string } = {}): TabSummary[] {
    const sessionId = opts.sessionId
    if (sessionId) {
      const ownedSet = new Set(this.sessions.getOwnedTabIds(sessionId))
      const sessionActive = this.sessions.getActiveTabId(sessionId)
      return [...this.tabs.values()]
        .filter((s) => ownedSet.has(s.driver.id))
        .map((s) => ({
          id: s.driver.id,
          url: s.driver.getUrl(),
          title: s.driver.getTitle(),
          active: s.driver.id === sessionActive,
          loading: s.driver.isLoading(),
          engine: s.driver.engine,
          ...(s.ownerSession ? { ownerSession: s.ownerSession } : {}),
        }))
    }
    return [...this.tabs.values()].map((s) => ({
      id: s.driver.id,
      url: s.driver.getUrl(),
      title: s.driver.getTitle(),
      active: s.driver.id === this.activeTabId,
      loading: s.driver.isLoading(),
      engine: s.driver.engine,
      ...(s.ownerSession ? { ownerSession: s.ownerSession } : {}),
    }))
  }

  private refreshOrigins(): void {
    for (const s of this.tabs.values()) {
      const origin = exactOrigin(s.driver.getUrl())
      if (!origin) continue
      if (s.ownerSession) {
        this.sessions.grantOrigin(s.ownerSession, origin)
      } else {
        this.allowedOrigins.add(origin)
      }
    }
  }

  private getAllowedOrigins(sessionId?: string): Set<string> {
    if (sessionId) {
      return this.sessions.getAllowedOrigins(sessionId)
    }
    return this.allowedOrigins
  }

  grantOrigin(
    originOrUrl: string,
    opts: { sessionId?: string } = {},
  ): { ok: boolean; origin?: string; sessionId?: string; error?: string } {
    const startedAt = Date.now()
    const sessionId = opts.sessionId
    const origin = normalizeOrigin(originOrUrl)
    if (!origin) {
      const durationMs = Date.now() - startedAt
      this.recordActivity({
        ts: startedAt,
        ...(sessionId ? { sessionId } : {}),
        tool: 'origin_grant',
        summary: originOrUrl || '(empty)',
        ok: false,
        durationMs,
        error: 'grant needs an http(s) origin',
      })
      this.audit.record({
        tsMs: startedAt,
        kind: 'refusal',
        tool: 'origin_grant',
        ...(sessionId ? { sessionId } : {}),
        ok: false,
        refused: true,
        refusal: { status: 'blocked', code: 'origin', reason: 'grant needs an http(s) origin' },
        durationMs,
        args: { origin: originOrUrl },
        summary: originOrUrl || '(empty)',
        error: 'grant needs an http(s) origin',
      })
      return { ok: false, error: 'grant needs an http(s) origin' }
    }
    if (this.ssrf.enabled) {
      const ssrfRes = this.ssrf.checkSync(origin)
      if (ssrfRes.blocked && ssrfRes.reason) {
        const durationMs = Date.now() - startedAt
        this.recordActivity({
          ts: startedAt,
          ...(sessionId ? { sessionId } : {}),
          tool: 'origin_grant',
          summary: origin,
          ok: false,
          durationMs,
          error: ssrfRes.reason,
        })
        this.audit.record({
          tsMs: startedAt,
          kind: 'refusal',
          tool: 'origin_grant',
          ...(sessionId ? { sessionId } : {}),
          ok: false,
          refused: true,
          refusal: { status: 'blocked', code: 'ssrf', reason: ssrfRes.reason },
          durationMs,
          args: { origin: originOrUrl },
          summary: origin,
          error: ssrfRes.reason,
        })
        return { ok: false, status: 'blocked', code: 'ssrf', error: ssrfRes.reason } as {
          ok: boolean
          origin?: string
          sessionId?: string
          error?: string
        }
      }
    }
    if (sessionId) {
      this.sessions.grantOrigin(sessionId, origin)
    } else {
      this.allowedOrigins.add(origin)
    }
    this.loopGuard.reset({ sessionId, category: 'origin_boundary' })
    this.emit({ type: 'origin_granted', origin, ...(sessionId ? { sessionId } : {}) })
    const durationMs = Date.now() - startedAt
    this.recordActivity({
      ts: startedAt,
      ...(sessionId ? { sessionId } : {}),
      tool: 'origin_grant',
      summary: origin,
      ok: true,
      durationMs,
      url: origin,
    })
    this.audit.record({
      tsMs: startedAt,
      kind: 'origin_grant',
      tool: 'origin_grant',
      ...(sessionId ? { sessionId } : {}),
      ok: true,
      refused: false,
      durationMs,
      args: { origin },
      summary: origin,
      toUrl: origin,
    })
    return { ok: true, origin, ...(sessionId ? { sessionId } : {}) }
  }

  async openTab(
    inputUrl?: string,
    opts: { activate?: boolean; ownedByBridge?: boolean; sessionId?: string } = {},
  ): Promise<{ ok: boolean; id?: number; url?: string; title?: string; sessionId?: string; error?: string }> {
    const startedAt = Date.now()
    const sessionId = opts.sessionId
    let targetUrl: string | undefined
    if (inputUrl && inputUrl.trim()) {
      const resolved = resolveInput(inputUrl)
      if (resolved.kind === 'refused') {
        const error = `${inputUrl} refused (${resolved.reason})`
        const durationMs = Date.now() - startedAt
        this.recordActivity({
          ts: startedAt,
          ...(sessionId ? { sessionId } : {}),
          tool: 'tab_open',
          summary: inputUrl,
          ok: false,
          durationMs,
          error,
        })
        this.audit.record({
          tsMs: startedAt,
          kind: 'refusal',
          tool: 'tab_open',
          ...(sessionId ? { sessionId } : {}),
          ok: false,
          refused: true,
          refusal: { status: 'blocked', code: 'scheme', reason: resolved.reason },
          durationMs,
          args: { url: inputUrl },
          summary: inputUrl,
          error,
        })
        return { ok: false, error }
      }
      targetUrl = resolved.url
      if (this.ssrf.enabled) {
        const ssrfRes = await this.ssrf.checkAsync(targetUrl)
        if (ssrfRes.blocked && ssrfRes.reason) {
          const durationMs = Date.now() - startedAt
          this.recordActivity({
            ts: startedAt,
            ...(sessionId ? { sessionId } : {}),
            tool: 'tab_open',
            summary: targetUrl,
            ok: false,
            durationMs,
            error: ssrfRes.reason,
          })
          this.audit.record({
            tsMs: startedAt,
            kind: 'refusal',
            tool: 'tab_open',
            ...(sessionId ? { sessionId } : {}),
            ok: false,
            refused: true,
            refusal: { status: 'blocked', code: 'ssrf', reason: ssrfRes.reason },
            durationMs,
            args: { url: inputUrl },
            summary: targetUrl,
            error: ssrfRes.reason,
          })
          return {
            ok: false,
            status: 'blocked',
            code: 'ssrf',
            category: ssrfRes.category,
            error: ssrfRes.reason,
          } as { ok: boolean; id?: number; url?: string; title?: string; sessionId?: string; error?: string }
        }
      }
      const origin = exactOrigin(targetUrl)
      if (origin) {
        if (sessionId) {
          this.sessions.grantOrigin(sessionId, origin)
        } else {
          this.allowedOrigins.add(origin)
        }
      }
    }

    let driver: TabDriver
    try {
      driver = await this.engine.createTab(targetUrl)
    } catch (err) {
      if (isSsrfBlockedError(err)) {
        const durationMs = Date.now() - startedAt
        this.recordActivity({
          ts: startedAt,
          ...(sessionId ? { sessionId } : {}),
          tool: 'tab_open',
          summary: targetUrl ?? inputUrl ?? '',
          ok: false,
          durationMs,
          error: err.reason,
        })
        this.audit.record({
          tsMs: startedAt,
          kind: 'refusal',
          tool: 'tab_open',
          ...(sessionId ? { sessionId } : {}),
          ok: false,
          refused: true,
          refusal: { status: 'blocked', code: 'ssrf', reason: err.reason },
          durationMs,
          args: { url: inputUrl },
          summary: targetUrl ?? inputUrl ?? '',
          error: err.reason,
        })
        return {
          ok: false,
          status: 'blocked',
          code: 'ssrf',
          category: err.category,
          error: err.reason,
        } as { ok: boolean; id?: number; url?: string; title?: string; sessionId?: string; error?: string }
      }
      throw err
    }
    const session: TabSession = {
      driver,
      elements: new ElementRegistry(),
      lastSnapshot: null,
      ownedByBridge: opts.ownedByBridge ?? true,
      ...(sessionId ? { ownerSession: sessionId } : {}),
    }
    this.tabs.set(driver.id, session)
    if (sessionId) {
      this.sessions.addOwnedTab(sessionId, driver.id, Boolean(opts.activate))
      if (this.activeTabId === null) {
        this.activeTabId = driver.id
      }
    } else if (this.activeTabId === null || opts.activate) {
      this.activeTabId = driver.id
    }
    const finalUrl = driver.getUrl()
    const finalOrigin = exactOrigin(finalUrl)
    if (finalOrigin) {
      if (sessionId) {
        this.sessions.grantOrigin(sessionId, finalOrigin)
      } else {
        this.allowedOrigins.add(finalOrigin)
      }
    }
    this.emit({ type: 'tab_opened', tabId: driver.id, url: finalUrl, ...(sessionId ? { sessionId } : {}) })
    const durationMs = Date.now() - startedAt
    this.recordActivity({
      ts: startedAt,
      tabId: driver.id,
      ...(sessionId ? { sessionId } : {}),
      tool: 'tab_open',
      summary: finalUrl,
      ok: true,
      durationMs,
      url: finalUrl,
    })
    this.audit.record({
      tsMs: startedAt,
      kind: 'tab_action',
      tool: 'tab_open',
      tabId: driver.id,
      ...(sessionId ? { sessionId } : {}),
      ok: true,
      refused: false,
      durationMs,
      ...(inputUrl ? { args: { url: inputUrl } } : {}),
      summary: finalUrl,
      toUrl: finalUrl,
      urlChanged: Boolean(finalUrl && finalUrl !== 'about:blank'),
    })
    return {
      ok: true,
      id: driver.id,
      url: finalUrl,
      title: driver.getTitle(),
      ...(sessionId ? { sessionId } : {}),
    }
  }

  activateTab(
    tabId: number,
    opts: { sessionId?: string } = {},
  ): { ok: boolean; status?: 'blocked'; code?: string; error?: string } {
    const startedAt = Date.now()
    const sessionId = opts.sessionId
    if (!this.tabs.has(tabId)) return { ok: false, error: `no tab ${tabId}` }
    if (sessionId) {
      this.sessions.touch(sessionId)
      if (!this.sessions.isTabOwnedBy(tabId, sessionId)) {
        const owner = this.sessions.getTabOwner(tabId)
        const error = owner
          ? `tab ${tabId} is owned by session "${owner}"; session "${sessionId}" cannot activate it`
          : `tab ${tabId} is not owned by session "${sessionId}"`
        this.audit.record({
          tsMs: startedAt,
          kind: 'refusal',
          tool: 'tab_activate',
          tabId,
          sessionId,
          ok: false,
          refused: true,
          refusal: { status: 'blocked', code: 'session_isolation', reason: error },
          durationMs: Date.now() - startedAt,
          error,
        })
        return { ok: false, status: 'blocked', code: 'session_isolation', error }
      }
      this.sessions.setActiveTabId(sessionId, tabId)
      this.emit({ type: 'tab_activated', tabId, sessionId })
      return { ok: true }
    }
    this.activeTabId = tabId
    this.emit({ type: 'tab_activated', tabId })
    return { ok: true }
  }

  async closeTab(
    tabId: number,
    requireOwned = false,
    opts: { sessionId?: string } = {},
  ): Promise<{ ok: boolean; status?: 'blocked'; code?: string; error?: string }> {
    const startedAt = Date.now()
    const sessionId = opts.sessionId
    const session = this.tabs.get(tabId)
    if (!session) return { ok: false, error: `no tab ${tabId}` }
    const fromUrl = session.driver.getUrl()
    if (sessionId) {
      this.sessions.touch(sessionId)
      if (!this.sessions.isTabOwnedBy(tabId, sessionId)) {
        const owner = this.sessions.getTabOwner(tabId)
        const error = owner
          ? `tab ${tabId} is owned by session "${owner}"; session "${sessionId}" cannot close it`
          : `tab ${tabId} is not owned by session "${sessionId}"`
        this.audit.record({
          tsMs: startedAt,
          kind: 'refusal',
          tool: 'tab_close',
          tabId,
          sessionId,
          ok: false,
          refused: true,
          refusal: { status: 'blocked', code: 'session_isolation', reason: error },
          durationMs: Date.now() - startedAt,
          fromUrl,
          error,
        })
        return { ok: false, status: 'blocked', code: 'session_isolation', error }
      }
    } else if (requireOwned && !session.ownedByBridge) {
      const error = 'this bridge session did not open that tab; refusing to close it'
      this.audit.record({
        tsMs: startedAt,
        kind: 'refusal',
        tool: 'tab_close',
        tabId,
        ok: false,
        refused: true,
        refusal: { status: 'blocked', code: 'owned_tab', reason: error },
        durationMs: Date.now() - startedAt,
        fromUrl,
        error,
      })
      return { ok: false, error }
    }
    await session.driver.close()
    this.tabs.delete(tabId)
    this.sessions.removeTab(tabId)
    this.loopGuard.reset({ tabId })
    if (this.activeTabId === tabId) {
      const next = this.tabs.keys().next()
      this.activeTabId = next.done ? null : next.value
    }
    this.emit({ type: 'tab_closed', tabId, ...(sessionId ? { sessionId } : {}) })
    this.audit.record({
      tsMs: startedAt,
      kind: 'tab_action',
      tool: 'tab_close',
      tabId,
      ...(sessionId ? { sessionId } : {}),
      ok: true,
      refused: false,
      durationMs: Date.now() - startedAt,
      fromUrl,
    })
    return { ok: true }
  }

  getActiveTabId(sessionId?: string): number | null {
    if (sessionId) {
      const sid = this.sessions.getActiveTabId(sessionId)
      return sid !== null && this.tabs.has(sid) ? sid : null
    }
    if (this.activeTabId !== null && this.tabs.has(this.activeTabId)) return this.activeTabId
    const first = this.tabs.keys().next()
    return first.done ? null : first.value
  }

  private resolveSession(tabId?: number): TabSession | null {
    if (tabId !== undefined) return this.tabs.get(tabId) ?? null
    if (this.activeTabId !== null) return this.tabs.get(this.activeTabId) ?? null
    const first = this.tabs.values().next()
    return first.done ? null : first.value
  }

  private resolveTabForSession(
    tabId: number | undefined,
    sessionId?: string,
  ): { ok: true; session: TabSession } | { ok: false; error: string; status?: 'blocked'; code?: string } {
    if (!sessionId) {
      const s = this.resolveSession(tabId)
      if (!s) return { ok: false, error: tabId !== undefined ? `no tab ${tabId}` : 'no open tab' }
      return { ok: true, session: s }
    }
    this.sessions.touch(sessionId)
    if (tabId !== undefined) {
      const s = this.tabs.get(tabId)
      if (!s) return { ok: false, error: `no tab ${tabId}` }
      if (!this.sessions.isTabOwnedBy(tabId, sessionId)) {
        const owner = this.sessions.getTabOwner(tabId)
        return {
          ok: false,
          status: 'blocked',
          code: 'session_isolation',
          error: owner
            ? `tab ${tabId} is owned by session "${owner}"; session "${sessionId}" cannot access it`
            : `tab ${tabId} is not owned by session "${sessionId}"`,
        }
      }
      return { ok: true, session: s }
    }
    const activeId = this.sessions.getActiveTabId(sessionId)
    if (activeId !== null) {
      const s = this.tabs.get(activeId)
      if (s) return { ok: true, session: s }
    }
    return { ok: false, error: `no open tab in session "${sessionId}"` }
  }

  async recall(opts: {
    query?: string
    origin?: string
    limit?: number
    tabId?: number
    sessionId?: string
    bind?: boolean
    boundOnly?: boolean
    currentOriginOnly?: boolean
    recordVerification?: boolean
    ascii?: boolean
  } = {}): Promise<Record<string, unknown>> {
    if (!this.memory) {
      return { ok: false, error: 'page memory is not enabled' }
    }

    const query = String(opts.query ?? '')
    const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? opts.limit : undefined
    const shouldBind = opts.bind !== false

    let session: TabSession | null = null
    if (shouldBind) {
      const resolved = this.resolveTabForSession(opts.tabId, opts.sessionId)
      if (!resolved.ok) {
        if (resolved.status === 'blocked') {
          return {
            ok: false,
            status: resolved.status,
            code: resolved.code,
            error: resolved.error,
          }
        }
        // If caller explicitly passed a non-existent tabId, fail deterministically
        if (opts.tabId !== undefined) {
          return { ok: false, error: resolved.error }
        }
      } else {
        session = resolved.session
      }
    }

    if (session) {
      const snap = await session.driver.snapshot()
      const liveOrigin = exactOrigin(snap.url)
      const effectiveOrigin =
        typeof opts.origin === 'string' && opts.origin.trim()
          ? opts.origin.trim()
          : opts.currentOriginOnly && liveOrigin
            ? liveOrigin
            : undefined

      const raw = this.memory.recall(query, { origin: effectiveOrigin, limit })
      const ctx: RefContext = { tabId: session.driver.id, url: snap.url, epoch: snap.epoch }
      const bound = bindRecalledElements(raw.elements, {
        liveElements: snap.elements,
        liveUrl: snap.url,
        liveOrigin,
        registry: session.elements,
        context: ctx,
        onVerify:
          opts.recordVerification === false
            ? undefined
            : (el, matched) => {
                this.memory?.recordVerification(el.key, matched)
              },
      })

      const elements = opts.boundOnly ? bound.boundElements : bound.elements
      const payload: RecallAutoBindResult = {
        pages: raw.pages,
        elements,
        boundElements: bound.boundElements,
        actions: raw.actions,
        binding: bound.binding,
      }
      const ascii = opts.ascii ? formatRecallAscii(payload, query) : undefined
      return {
        ok: true,
        query,
        tabId: session.driver.id,
        url: snap.url,
        ...payload,
        ...(ascii ? { ascii } : {}),
      }
    }

    const raw = this.memory.recall(query, {
      origin: typeof opts.origin === 'string' && opts.origin.trim() ? opts.origin.trim() : undefined,
      limit,
    })
    const elements: BoundRecallElement[] = raw.elements.map((el) => ({
      ...el,
      bound: false,
      status: 'unbound',
    }))
    const payload: RecallAutoBindResult = {
      pages: raw.pages,
      elements: opts.boundOnly ? [] : elements,
      boundElements: [],
      actions: raw.actions,
      binding: {
        attempted: false,
        total: raw.elements.length,
        boundCount: 0,
        staleCount: 0,
        ambiguousCount: 0,
        otherOriginCount: 0,
        unboundCount: raw.elements.length,
        reusedRefCount: 0,
        freshRefCount: 0,
      },
    }
    const ascii = opts.ascii ? formatRecallAscii(payload, query) : undefined
    return {
      ok: true,
      query,
      ...payload,
      ...(ascii ? { ascii } : {}),
    }
  }

  private async takeIndexedSnapshot(session: TabSession): Promise<PageSnapshot> {
    const snap = await session.driver.snapshot()
    const ctx = { tabId: session.driver.id, url: snap.url, epoch: snap.epoch }
    const registered = session.elements.register(snap.elements, ctx)
    const refBySelector = new Map<string, string>()
    for (const el of registered) {
      if (el.ref) refBySelector.set(el.selector, el.ref)
    }

    // Bind refs onto content blocks for seamless inline [eN] ASCII rendering
    // and auto-generate strict 7-bit ASCII previews for <canvas> blocks.
    const blocks = snap.blocks.map((b) => {
      let next = b
      if (next.kind === 'canvas' && !next.asciiPreview && next.canvasDataUrl) {
        const preview = renderCanvasPreviewAscii(next.canvasDataUrl)
        if (preview) {
          next = { ...next, asciiPreview: preview }
        }
      }
      if (b.links && b.links.length > 0) {
        const boundLinks = b.links.map((lnk) => {
          if (lnk.ref) return lnk
          if (lnk.selector && refBySelector.has(lnk.selector)) {
            return { ...lnk, ref: refBySelector.get(lnk.selector) }
          }
          const match = registered.find(
            (e) => (e.tag === 'a' || e.role === 'link') && e.text === lnk.text && (!lnk.href || e.href === lnk.href),
          )
          return match?.ref ? { ...lnk, ref: match.ref } : lnk
        })
        next = { ...next, links: boundLinks }
      }

      const maybeSel = (next as { selector?: string }).selector
      if (maybeSel && refBySelector.has(maybeSel)) {
        return { ...next, ref: refBySelector.get(maybeSel) }
      }
      // Fallback match by text+kind for Lite engine
      if (next.kind === 'link' || next.kind === 'button' || next.kind === 'input' || next.kind === 'select') {
        const match = registered.find((e) => {
          if (next.kind === 'link') return (e.tag === 'a' || e.role === 'link') && e.text === next.text && (!next.href || e.href === next.href)
          if (next.kind === 'button') return (e.tag === 'button' || e.role === 'button') && e.text === next.text
          if (next.kind === 'select') return e.tag === 'select' && (e.label === next.text || e.text === next.text)
          return (e.tag === 'input' || e.tag === 'textarea') && (e.label === next.text || e.text === next.text)
        })
        if (match?.ref) return { ...next, ref: match.ref }
      }
      return next
    })

    const indexed: PageSnapshot = { ...snap, elements: registered, blocks }
    this.memory?.recordRead(indexed.url, indexed.title, indexed.text, registered)
    return indexed
  }

  private resolveCropArgs(
    session: TabSession,
    args: { crop?: unknown; ref?: unknown },
  ): { crop?: Rect; cropRef?: string } | { error: string } {
    if (args.crop !== undefined && args.crop !== null && args.crop !== '' && args.crop !== false) {
      const parsed = parseCropRect(args.crop)
      if (!parsed) {
        return {
          error: 'invalid crop region; expected "x,y,w,h" or {x,y,width,height} with non-negative x,y and positive width,height',
        }
      }
      return { crop: parsed }
    }
    if (args.ref !== undefined && args.ref !== null && args.ref !== '') {
      const ctx = { tabId: session.driver.id, url: session.driver.getUrl(), epoch: session.driver.getEpoch() }
      const resolved = session.elements.resolve(args.ref, ctx)
      if ('error' in resolved) return { error: resolved.error }
      const box = resolved.item.box
      if (!box || box.width <= 0 || box.height <= 0) {
        return { error: `element ${String(args.ref).trim()} has no bounding box to crop` }
      }
      return { crop: { ...box }, cropRef: String(args.ref).trim() }
    }
    return {}
  }

  private extractSettleOptions(args: Record<string, unknown>): SettleOptions | undefined {
    const raw = args.settle
    if (!raw) return undefined
    const base: SettleOptions = typeof raw === 'object' && raw !== null ? { ...(raw as SettleOptions) } : {}
    if (typeof args.settleTimeout === 'number' && Number.isFinite(args.settleTimeout)) {
      base.timeoutMs = args.settleTimeout
    }
    if (typeof args.networkIdleMs === 'number' && Number.isFinite(args.networkIdleMs)) {
      base.networkIdleMs = args.networkIdleMs
    }
    if (typeof args.domQuietMs === 'number' && Number.isFinite(args.domQuietMs)) {
      base.domQuietMs = args.domQuietMs
    }
    if (typeof args.maxInflightRequests === 'number' && Number.isFinite(args.maxInflightRequests)) {
      base.maxInflightRequests = args.maxInflightRequests
    }
    return base
  }

  async waitForSettle(tabId?: number, opts: SettleOptions = {}): Promise<SettleResult> {
    const session = this.resolveSession(tabId)
    if (!session) {
      return {
        ok: false,
        settled: false,
        timedOut: false,
        waitedMs: 0,
        networkIdle: false,
        domQuiet: false,
        inflightCount: 0,
        mutationCount: 0,
        reason: 'error',
        error: 'no open tab',
      }
    }
    return session.driver.waitForSettle(opts)
  }

  async renderAscii(
    tabId?: number,
    opts: Omit<AsciiRenderOptions, 'crop'> & {
      since?: boolean
      crop?: Rect | string
      ref?: string
      settle?: boolean | SettleOptions
      sessionId?: string
      untrustedMarkers?: boolean | UntrustedMarkersOptions
    } = {},
  ): Promise<{
    ok: boolean
    ascii?: string
    snapshot?: PageSnapshot
    delta?: PageDelta
    settle?: SettleResult
    crop?: Rect
    cropRef?: string
    mode?: 'full' | 'delta'
    scroll?: {
      offset: number
      maxOffset: number
      totalLines: number
      viewportRows: number
    }
    focusedLineIndex?: number
    estimatedTokens?: number
    tokenBudget?: TokenBudgetReport
    untrustedMarkers?: UntrustedWrapMetadata
    status?: 'blocked'
    code?: string
    error?: string
  }> {
    const resolvedTab = this.resolveTabForSession(tabId, opts.sessionId)
    if (!resolvedTab.ok) {
      return {
        ok: false,
        ...(resolvedTab.status ? { status: resolvedTab.status } : {}),
        ...(resolvedTab.code ? { code: resolvedTab.code } : {}),
        error: resolvedTab.error,
      }
    }
    const session = resolvedTab.session
    const settleOpts = this.extractSettleOptions(opts as Record<string, unknown>)
    const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined
    const cropRes = this.resolveCropArgs(session, { crop: opts.crop, ref: opts.ref })
    if ('error' in cropRes) return { ok: false, error: cropRes.error }
    const prev = session.lastSnapshot
    const snap = await this.takeIndexedSnapshot(session)
    session.lastSnapshot = snap
    const maxTokens = parseMaxTokens(opts.maxTokens)
    const wrapUntrusted = this.untrustedMarkers.shouldWrap(opts.untrustedMarkers)
    const innerMaxTokens =
      maxTokens && wrapUntrusted && maxTokens > 64
        ? Math.max(32, maxTokens - estimateUntrustedWrapperTokenOverhead(this.untrustedMarkers.includeNotice))
        : maxTokens

    if (opts.since && prev) {
      const delta = computePageDelta(prev, snap)
      let ascii = renderDeltaAscii(delta, {
        width: opts.width,
        asciiOnly: opts.asciiOnly,
        color: opts.color,
        showChrome: opts.showChrome,
        density: opts.density,
      })
      let tokenBudget: TokenBudgetReport | undefined
      if (innerMaxTokens) {
        const trimmed = trimAsciiToTokenBudget(ascii, innerMaxTokens, {
          preserveRefs: true,
          preserveHeadings: true,
          asciiOnly: opts.asciiOnly !== false,
          width: opts.width,
        })
        ascii = trimmed.text
        tokenBudget = trimmed.report
      }
      let untrustedMeta: UntrustedWrapMetadata | undefined
      if (wrapUntrusted) {
        const wrapped = this.untrustedMarkers.wrap(ascii, {
          source: snap.url,
          kind: 'page_ascii_delta',
          override: opts.untrustedMarkers,
        })
        ascii = wrapped.text
        untrustedMeta = wrapped.meta
      }
      const estimatedTokens = estimateTokens(ascii).tokens
      return {
        ok: true,
        mode: 'delta',
        ascii,
        snapshot: snap,
        delta,
        estimatedTokens,
        ...(tokenBudget ? { tokenBudget } : {}),
        ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
        ...(settleRes ? { settle: settleRes } : {}),
      }
    }
    const {
      crop: _rawCrop,
      ref: _rawRef,
      since: _since,
      settle: _settle,
      sessionId: _sessionId,
      untrustedMarkers: _untrustedMarkers,
      ...renderOpts
    } = opts
    const rendered = renderPageAsciiWithMetrics(snap, {
      ...renderOpts,
      maxTokens: innerMaxTokens,
      crop: cropRes.crop,
      cropLabel: cropRes.cropRef ?? opts.cropLabel,
      tabs: this.listTabs({ sessionId: opts.sessionId }),
      activeTabId: (opts.sessionId ? this.sessions.getActiveTabId(opts.sessionId) : this.activeTabId) ?? snap.tabId,
    })
    let finalAscii = rendered.ascii
    let untrustedMeta: UntrustedWrapMetadata | undefined
    if (wrapUntrusted) {
      const wrapped = this.untrustedMarkers.wrap(finalAscii, {
        source: snap.url,
        kind: 'page_ascii',
        override: opts.untrustedMarkers,
      })
      finalAscii = wrapped.text
      untrustedMeta = wrapped.meta
    }
    const estimatedTokens = untrustedMeta
      ? estimateTokens(finalAscii).tokens
      : rendered.tokenBudget
        ? rendered.tokenBudget.finalTokens
        : estimateTokens(finalAscii).tokens
    return {
      ok: true,
      mode: 'full',
      ascii: finalAscii,
      snapshot: snap,
      scroll: {
        offset: rendered.scrollOffset,
        maxOffset: rendered.maxScrollOffset,
        totalLines: rendered.totalLines,
        viewportRows: rendered.viewportRows,
      },
      estimatedTokens,
      ...(rendered.tokenBudget ? { tokenBudget: rendered.tokenBudget } : {}),
      ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
      ...(rendered.focusedLineIndex !== undefined ? { focusedLineIndex: rendered.focusedLineIndex } : {}),
      ...(settleRes ? { settle: settleRes } : {}),
      ...(cropRes.crop ? { crop: cropRes.crop } : {}),
      ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
    }
  }

  async renderMarkdown(
    tabId?: number,
    opts: Omit<MarkdownRenderOptions, 'crop'> & {
      crop?: Rect | string
      ref?: string
      settle?: boolean | SettleOptions
      sessionId?: string
      untrustedMarkers?: boolean | UntrustedMarkersOptions
    } = {},
  ): Promise<{
    ok: boolean
    markdown?: string
    snapshot?: PageSnapshot
    settle?: SettleResult
    crop?: Rect
    cropRef?: string
    untrustedMarkers?: UntrustedWrapMetadata
    status?: 'blocked'
    code?: string
    error?: string
  }> {
    const resolvedTab = this.resolveTabForSession(tabId, opts.sessionId)
    if (!resolvedTab.ok) {
      return {
        ok: false,
        ...(resolvedTab.status ? { status: resolvedTab.status } : {}),
        ...(resolvedTab.code ? { code: resolvedTab.code } : {}),
        error: resolvedTab.error,
      }
    }
    const session = resolvedTab.session
    const settleOpts = this.extractSettleOptions(opts as Record<string, unknown>)
    const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined
    const cropRes = this.resolveCropArgs(session, { crop: opts.crop, ref: opts.ref })
    if ('error' in cropRes) return { ok: false, error: cropRes.error }
    const snap = await this.takeIndexedSnapshot(session)
    session.lastSnapshot = snap
    const {
      crop: _rawCrop,
      ref: _rawRef,
      settle: _settle,
      sessionId: _sessionId,
      untrustedMarkers: _untrustedMarkers,
      ...renderOpts
    } = opts
    let markdown = renderPageMarkdown(snap, {
      ...renderOpts,
      crop: cropRes.crop,
      cropLabel: cropRes.cropRef ?? opts.cropLabel,
    })
    let untrustedMeta: UntrustedWrapMetadata | undefined
    if (this.untrustedMarkers.shouldWrap(opts.untrustedMarkers)) {
      const wrapped = this.untrustedMarkers.wrap(markdown, {
        source: snap.url,
        kind: 'page_markdown',
        override: opts.untrustedMarkers,
      })
      markdown = wrapped.text
      untrustedMeta = wrapped.meta
    }
    return {
      ok: true,
      markdown,
      snapshot: snap,
      ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
      ...(settleRes ? { settle: settleRes } : {}),
      ...(cropRes.crop ? { crop: cropRes.crop } : {}),
      ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
    }
  }

  private async trySameEpochDomRecovery(
    session: TabSession,
    refName: string,
    staleItem: ElementDescriptor,
    staleSelector: string,
    startCtx: RefContext,
  ): Promise<
    | { recovered: true; selector: string; item: ElementDescriptor; strategy: RefRecoveryStrategy }
    | { recovered: false }
  > {
    if (
      session.driver.id !== startCtx.tabId ||
      session.driver.getUrl() !== startCtx.url ||
      session.driver.getEpoch() !== startCtx.epoch
    ) {
      return { recovered: false }
    }

    const freshSnap = await session.driver.snapshot()
    if (
      freshSnap.tabId !== startCtx.tabId ||
      freshSnap.url !== startCtx.url ||
      freshSnap.epoch !== startCtx.epoch
    ) {
      return { recovered: false }
    }

    const match = recoverElementMatch(staleItem, freshSnap.elements)
    if (!match.recovered || match.selector === staleSelector) {
      return { recovered: false }
    }

    session.elements.updateEntry(refName, match.selector, match.item, startCtx)
    return {
      recovered: true,
      selector: match.selector,
      item: match.item,
      strategy: match.strategy,
    }
  }

  async runTool(
    tabId: number | undefined,
    name: string,
    args: Record<string, unknown> = {},
    opts: { sessionId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now()
    const sessionId = opts.sessionId
    const beforeResolved = this.resolveTabForSession(tabId, sessionId)
    const sessionBefore = beforeResolved.ok ? beforeResolved.session : null
    const resolvedTabId = sessionBefore?.driver.id ?? tabId
    const fromUrl = sessionBefore?.driver.getUrl()
    const fromEpoch = sessionBefore?.driver.getEpoch()
    const summary = this.summarizeToolArgs(name, args)

    const preBlocked = this.loopGuard.checkBeforeExecution({
      tool: name,
      args,
      tabId: resolvedTabId,
      sessionId,
      url: fromUrl,
      epoch: fromEpoch,
      nowMs: startedAt,
    })
    if (preBlocked) {
      const durationMs = Date.now() - startedAt
      const error = `Agent loop guard blocked repeated failing "${name}" (${preBlocked.repeatCount}x): ${preBlocked.hint}`
      const blockedRes: Record<string, unknown> = {
        ok: false,
        status: 'blocked',
        code: 'loop_guard',
        error,
        loopGuard: preBlocked,
      }
      this.emit({
        type: 'loop_detected',
        blocked: true,
        tool: name,
        tabId: resolvedTabId,
        ...(sessionId ? { sessionId } : {}),
        loopGuard: preBlocked,
      })
      this.recordActivity({
        ts: startedAt,
        tabId: resolvedTabId,
        ...(sessionId ? { sessionId } : {}),
        tool: name,
        summary,
        ok: false,
        durationMs,
        url: fromUrl,
        error,
      })
      this.audit.record({
        tsMs: startedAt,
        kind: 'tool_call',
        tool: name,
        tabId: resolvedTabId,
        ...(sessionId ? { sessionId } : {}),
        ok: false,
        refused: true,
        refusal: { status: 'blocked', code: 'loop_guard', reason: error },
        durationMs,
        args,
        summary,
        fromUrl,
        toUrl: fromUrl,
        urlChanged: false,
        error,
      })
      return blockedRes
    }

    try {
      const res = await this.runToolImpl(tabId, name, args, sessionId)
      const afterResolved = this.resolveTabForSession(tabId, sessionId)
      const sessionAfter = afterResolved.ok ? afterResolved.session : null
      const durationMs = Date.now() - startedAt
      const toUrl = typeof res.url === 'string' ? res.url : sessionAfter?.driver.getUrl()
      const toEpoch = sessionAfter?.driver.getEpoch()
      const finalTabId = sessionAfter?.driver.id ?? resolvedTabId
      const ok = Boolean(res.ok)
      const error = !ok && typeof res.error === 'string' ? res.error : undefined
      const refusal = extractRefusalInfo(res)
      const urlChanged = Boolean(fromUrl && toUrl && fromUrl !== toUrl)

      let finalRes = res
      if (ok) {
        this.loopGuard.recordSuccess({
          tool: name,
          args,
          tabId: finalTabId,
          sessionId,
          url: toUrl,
          epoch: toEpoch,
          nowMs: Date.now(),
        })
      } else if (!(name === 'page_act' && res.loopGuard)) {
        const loopReport = this.loopGuard.recordFailure({
          tool: name,
          args,
          tabId: finalTabId,
          sessionId,
          url: toUrl ?? fromUrl,
          epoch: toEpoch ?? fromEpoch,
          error,
          code: typeof res.code === 'string' ? res.code : undefined,
          status: typeof res.status === 'string' ? res.status : undefined,
          origin: typeof res.origin === 'string' ? res.origin : undefined,
          nowMs: Date.now(),
        })
        if (loopReport) {
          finalRes = { ...res, loopGuard: loopReport }
          this.emit({
            type: 'loop_detected',
            blocked: false,
            tool: name,
            tabId: finalTabId,
            ...(sessionId ? { sessionId } : {}),
            loopGuard: loopReport,
          })
        }
      }

      this.recordActivity({
        ts: startedAt,
        tabId: finalTabId,
        ...(sessionId ? { sessionId } : {}),
        tool: name,
        summary,
        ok,
        durationMs,
        url: toUrl,
        error,
      })
      this.audit.record({
        tsMs: startedAt,
        kind: 'tool_call',
        tool: name,
        tabId: finalTabId,
        ...(sessionId ? { sessionId } : {}),
        ok,
        refused: Boolean(refusal),
        refusal,
        durationMs,
        args,
        summary,
        fromUrl,
        toUrl,
        urlChanged,
        error,
      })
      return finalRes
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - startedAt
      if (isSsrfBlockedError(err)) {
        this.loopGuard.recordFailure({
          tool: name,
          args,
          tabId: resolvedTabId,
          sessionId,
          url: fromUrl,
          epoch: fromEpoch,
          error: err.reason,
          code: 'ssrf',
          status: 'blocked',
          nowMs: Date.now(),
        })
        this.recordActivity({
          ts: startedAt,
          tabId: resolvedTabId,
          ...(sessionId ? { sessionId } : {}),
          tool: name,
          summary,
          ok: false,
          durationMs,
          error: err.reason,
        })
        this.audit.record({
          tsMs: startedAt,
          kind: 'refusal',
          tool: name,
          tabId: resolvedTabId,
          ...(sessionId ? { sessionId } : {}),
          ok: false,
          refused: true,
          refusal: { status: 'blocked', code: 'ssrf', reason: err.reason },
          durationMs,
          args,
          summary,
          fromUrl,
          error: err.reason,
        })
        return {
          ok: false,
          status: 'blocked',
          code: 'ssrf',
          category: err.category,
          error: err.reason,
        }
      }
      this.loopGuard.recordFailure({
        tool: name,
        args,
        tabId: resolvedTabId,
        sessionId,
        url: fromUrl,
        epoch: fromEpoch,
        error: message,
        nowMs: Date.now(),
      })
      this.recordActivity({
        ts: startedAt,
        tabId: resolvedTabId,
        ...(sessionId ? { sessionId } : {}),
        tool: name,
        summary,
        ok: false,
        durationMs,
        error: message,
      })
      this.audit.record({
        tsMs: startedAt,
        kind: 'tool_call',
        tool: name,
        tabId: resolvedTabId,
        ...(sessionId ? { sessionId } : {}),
        ok: false,
        refused: false,
        durationMs,
        args,
        summary,
        fromUrl,
        error: message,
      })
      throw err
    }
  }

  private async runToolImpl(
    tabId: number | undefined,
    name: string,
    args: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const resolvedTab = this.resolveTabForSession(tabId, sessionId)
    const session = resolvedTab.ok ? resolvedTab.session : null
    if (name === 'page_dialogs') {
      if (!resolvedTab.ok && resolvedTab.code === 'session_isolation') {
        return { ok: false, status: resolvedTab.status, code: resolvedTab.code, error: resolvedTab.error }
      }
      if (args.clearQueue) {
        this.clearDialogQueue()
      }
      const mode = parseDialogMode(args.mode)
      const hasPolicyUpdate =
        Boolean(mode) ||
        typeof args.acceptBeforeUnload === 'boolean' ||
        typeof args.defaultPromptText === 'string'
      if (hasPolicyUpdate) {
        this.setDialogPolicy({
          ...(mode ? { mode } : {}),
          ...(typeof args.acceptBeforeUnload === 'boolean' ? { acceptBeforeUnload: args.acceptBeforeUnload } : {}),
          ...(typeof args.defaultPromptText === 'string' ? { defaultPromptText: args.defaultPromptText } : {}),
        })
      }
      if (args.next && typeof args.next === 'object') {
        const nextObj = args.next as Record<string, unknown>
        if (typeof nextObj.accept === 'boolean') {
          this.queueDialogResponse({
            accept: nextObj.accept,
            ...(typeof nextObj.promptText === 'string' ? { promptText: nextObj.promptText } : {}),
            ...(parseDialogType(nextObj.type) ? { type: parseDialogType(nextObj.type) } : {}),
          })
        }
      } else if (typeof args.queueAccept === 'boolean') {
        this.queueDialogResponse({
          accept: args.queueAccept,
          ...(typeof args.promptText === 'string' ? { promptText: args.promptText } : {}),
          ...(parseDialogType(args.queueType) ? { type: parseDialogType(args.queueType) } : {}),
        })
      }
      const dialogType = parseDialogType(args.type)
      const filterTabId = args.allTabs === true ? undefined : session?.driver.id
      const entries = this.getDialogs({
        tabId: filterTabId,
        type: dialogType,
        limit: typeof args.limit === 'number' ? args.limit : 100,
        clear: Boolean(args.clear),
      })
      const stats = this.getDialogStats()
      const queue = this.getDialogQueue()
      return {
        ok: true,
        count: entries.length,
        entries,
        stats,
        queue,
        ascii: formatDialogsAscii(entries, stats, queue),
      }
    }
    if (!resolvedTab.ok) {
      return {
        ok: false,
        ...(resolvedTab.status ? { status: resolvedTab.status } : {}),
        code: resolvedTab.code ?? 'no-tab',
        error: resolvedTab.error,
      }
    }
    if (!session) return { ok: false, error: 'no such tab', code: 'no-tab' }
    this.refreshOrigins()
    const allowedOrigins = this.getAllowedOrigins(sessionId)
    const ctx = () => ({ tabId: session.driver.id, url: session.driver.getUrl(), epoch: session.driver.getEpoch() })
    const untrustedOverride = this.resolveUntrustedOverride(
      args.untrustedMarkers ?? args.untrusted_markers,
      args.untrustedStyle ?? args.untrusted_style,
    )
    const wrapUntrusted = this.untrustedMarkers.shouldWrap(untrustedOverride)

    switch (name) {
      case 'page_read':
      case 'page_read_visual':
      case 'page_read_ascii': {
        const settleOpts = this.extractSettleOptions(args)
        const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined

        const cropRes = this.resolveCropArgs(session, { crop: args.crop, ref: args.ref })
        if ('error' in cropRes) return { ok: false, error: cropRes.error }

        const prev = session.lastSnapshot
        const snap = await this.takeIndexedSnapshot(session)
        session.lastSnapshot = snap

        const maxTokens = parseMaxTokens(args.maxTokens ?? args.max_tokens)
        const innerMaxTokens =
          maxTokens && wrapUntrusted && maxTokens > 64
            ? Math.max(32, maxTokens - estimateUntrustedWrapperTokenOverhead(this.untrustedMarkers.includeNotice))
            : maxTokens

        if (args.since && prev) {
          const delta = computePageDelta(prev, snap)
          let ascii = renderDeltaAscii(delta, {
            width: typeof args.width === 'number' ? args.width : undefined,
            asciiOnly: args.asciiOnly !== false,
            color: Boolean(args.color),
            showChrome: typeof args.showChrome === 'boolean' ? args.showChrome : undefined,
            density: parseAsciiDensity(args.density),
          })
          let tokenBudget: TokenBudgetReport | undefined
          if (innerMaxTokens) {
            const trimmed = trimAsciiToTokenBudget(ascii, innerMaxTokens, {
              preserveRefs: true,
              preserveHeadings: true,
              asciiOnly: args.asciiOnly !== false,
              width: typeof args.width === 'number' ? args.width : undefined,
            })
            ascii = trimmed.text
            tokenBudget = trimmed.report
          }
          let untrustedMeta: UntrustedWrapMetadata | undefined
          if (wrapUntrusted) {
            const wrapped = this.untrustedMarkers.wrap(ascii, {
              source: snap.url,
              kind: 'page_ascii_delta',
              override: untrustedOverride,
            })
            ascii = wrapped.text
            untrustedMeta = wrapped.meta
          }
          const estimatedTokens = untrustedMeta
            ? estimateTokens(ascii).tokens
            : tokenBudget
              ? tokenBudget.finalTokens
              : estimateTokens(ascii).tokens
          return capPayload({
            ok: true,
            mode: 'delta',
            ...delta,
            ascii,
            estimatedTokens,
            ...(tokenBudget ? { tokenBudget } : {}),
            ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
            ...(settleRes ? { settle: settleRes } : {}),
            ...(name === 'page_read_ascii' ? { content: ascii } : {}),
          })
        }

        const layoutOpt =
          args.layout === 'spatial' || args.layout === 'auto' || args.layout === 'flow' ? args.layout : undefined
        const densityOpt = parseAsciiDensity(args.density)
        const renderedAscii = renderPageAsciiWithMetrics(snap, {
          width: typeof args.width === 'number' ? args.width : undefined,
          height: typeof args.height === 'number' ? args.height : undefined,
          asciiOnly: args.asciiOnly !== false,
          color: Boolean(args.color),
          showChrome: typeof args.showChrome === 'boolean' ? args.showChrome : undefined,
          showMediaSummary: Boolean(args.showMediaSummary),
          layout: layoutOpt,
          density: densityOpt,
          maxTokens: innerMaxTokens,
          crop: cropRes.crop,
          cropLabel: cropRes.cropRef,
          tabs: this.listTabs({ sessionId }),
          activeTabId: (sessionId ? this.sessions.getActiveTabId(sessionId) : this.activeTabId) ?? snap.tabId,
        })
        let ascii = renderedAscii.ascii
        const tokenBudget = renderedAscii.tokenBudget

        let pixelAscii: string | undefined
        if (name === 'page_read_visual') {
          const png = await session.driver.screenshot()
          if (png) {
            const overlays = snap.elements
              .filter((e) => e.ref && e.box)
              .slice(0, 40)
              .map((e) => ({ ref: e.ref!, box: e.box! }))
            pixelAscii = renderPngToAscii(png, {
              width: typeof args.width === 'number' ? args.width : 80,
              mode: (args.pixelMode as PixelAsciiOptions['mode']) || 'ascii',
              edgeThreshold: typeof args.edgeThreshold === 'number' ? args.edgeThreshold : undefined,
              crop: cropRes.crop,
              overlays,
              overlayStyle:
                args.overlayStyle === 'badge' || args.overlayStyle === 'box' ? args.overlayStyle : undefined,
              viewport: snap.viewport,
            })
          }
        }

        let contentText: string
        let untrustedMeta: UntrustedWrapMetadata | undefined
        if (wrapUntrusted) {
          const wrappedAscii = this.untrustedMarkers.wrap(ascii, {
            source: snap.url,
            kind: 'page_ascii',
            override: untrustedOverride,
          })
          ascii = wrappedAscii.text
          untrustedMeta = wrappedAscii.meta
          if (name === 'page_read_ascii') {
            contentText = ascii
          } else {
            const wrappedContent = this.untrustedMarkers.wrap(snap.text, {
              source: snap.url,
              kind: 'page_text',
              override: untrustedOverride,
            })
            contentText = wrappedContent.text
          }
          if (pixelAscii) {
            pixelAscii = this.untrustedMarkers.wrap(pixelAscii, {
              source: snap.url,
              kind: 'page_visual',
              override: untrustedOverride,
            }).text
          }
        } else {
          contentText = name === 'page_read_ascii' ? ascii : snap.text
        }
        const estimatedTokens = untrustedMeta
          ? estimateTokens(ascii).tokens
          : tokenBudget
            ? tokenBudget.finalTokens
            : estimateTokens(ascii).tokens

        const media = extractMediaSummary(snap)
        const mediaSummaryAscii = media.length > 0 ? renderMediaSummaryAscii(snap) : undefined

        return capPayload({
          ok: true,
          tabId: snap.tabId,
          url: snap.url,
          title: snap.title,
          epoch: snap.epoch,
          engine: session.driver.engine,
          elementCount: snap.elements.length,
          elements: snap.elements.map(({ selector: _s, ...pub }) => pub),
          ascii,
          estimatedTokens,
          ...(tokenBudget ? { tokenBudget } : {}),
          ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
          compactRefs: renderCompactRefsAscii(snap),
          ...(media.length > 0 ? { media, mediaSummaryAscii } : {}),
          ...(pixelAscii ? { pixelAscii } : {}),
          ...(settleRes ? { settle: settleRes } : {}),
          ...(cropRes.crop ? { crop: cropRes.crop } : {}),
          ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
          content: contentText,
        })
      }

      case 'page_read_markdown': {
        const settleOpts = this.extractSettleOptions(args)
        const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined
        const cropRes = this.resolveCropArgs(session, { crop: args.crop, ref: args.ref })
        if ('error' in cropRes) return { ok: false, error: cropRes.error }
        const snap = await this.takeIndexedSnapshot(session)
        session.lastSnapshot = snap
        let markdown = renderPageMarkdown(snap, {
          showRefs: args.showRefs !== false,
          includeUrls: args.includeUrls !== false,
          asciiOnly: Boolean(args.asciiOnly),
          includeFrontmatter: Boolean(args.includeFrontmatter),
          includeHeader: typeof args.includeHeader === 'boolean' ? args.includeHeader : undefined,
          includeForms: typeof args.includeForms === 'boolean' ? args.includeForms : undefined,
          includeCanvasPreview: typeof args.includeCanvasPreview === 'boolean' ? args.includeCanvasPreview : undefined,
          includeMediaSummary: Boolean(args.includeMediaSummary),
          includeRefsIndex:
            args.includeRefsIndex === 'always'
              ? 'always'
              : typeof args.includeRefsIndex === 'boolean'
                ? args.includeRefsIndex
                : undefined,
          canvasPreviewWidth: typeof args.canvasPreviewWidth === 'number' ? args.canvasPreviewWidth : undefined,
          canvasPreviewHeight: typeof args.canvasPreviewHeight === 'number' ? args.canvasPreviewHeight : undefined,
          crop: cropRes.crop,
          cropLabel: cropRes.cropRef,
        })
        let untrustedMeta: UntrustedWrapMetadata | undefined
        if (wrapUntrusted) {
          const wrapped = this.untrustedMarkers.wrap(markdown, {
            source: snap.url,
            kind: 'page_markdown',
            override: untrustedOverride,
          })
          markdown = wrapped.text
          untrustedMeta = wrapped.meta
        }
        return capPayload({
          ok: true,
          tabId: snap.tabId,
          url: snap.url,
          title: snap.title,
          epoch: snap.epoch,
          engine: session.driver.engine,
          elementCount: snap.elements.length,
          markdown,
          content: markdown,
          ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
          ...(settleRes ? { settle: settleRes } : {}),
          ...(cropRes.crop ? { crop: cropRes.crop } : {}),
          ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
        })
      }

      case 'page_find': {
        if (!session.lastSnapshot) {
          session.lastSnapshot = await this.takeIndexedSnapshot(session)
        }
        const registered = session.elements.list(ctx()).map((entry) => entry.item)
        const combinedRoles: string[] = []
        if (typeof args.role === 'string') combinedRoles.push(args.role)
        else if (Array.isArray(args.role)) combinedRoles.push(...args.role.map(String))
        if (Array.isArray(args.roles)) combinedRoles.push(...args.roles.map(String))

        const result = findElements(registered, {
          query: String(args.query ?? ''),
          role: combinedRoles.length > 0 ? combinedRoles : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          tag: typeof args.tag === 'string' ? args.tag : undefined,
          enabledOnly: Boolean(args.enabledOnly) || args.includeDisabled === false,
          fuzzy: args.fuzzy !== false,
          synonyms: args.synonyms !== false,
          limit: typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined,
          minScore: typeof args.minScore === 'number' && Number.isFinite(args.minScore) ? args.minScore : undefined,
        })
        return {
          ok: true,
          query: result.query,
          count: result.matches.length,
          totalCandidates: result.totalCandidates,
          ...(result.appliedFilters ? { appliedFilters: result.appliedFilters } : {}),
          matches: result.matches,
        }
      }

      case 'page_recall': {
        return this.recall({
          query: String(args.query ?? ''),
          origin: typeof args.origin === 'string' ? args.origin : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          tabId: session.driver.id,
          sessionId,
          bind: args.bind !== false,
          boundOnly: Boolean(args.boundOnly),
          currentOriginOnly: Boolean(args.currentOriginOnly),
          recordVerification: args.recordVerification !== false,
          ascii: Boolean(args.ascii),
        })
      }

      case 'page_text': {
        if (args.ref) {
          const resolved = session.elements.resolve(args.ref, ctx())
          if ('error' in resolved) return { ok: false, error: resolved.error }
          let textOut = resolved.item.text
          let valueOut = resolved.item.value
          let untrustedMeta: UntrustedWrapMetadata | undefined
          if (wrapUntrusted) {
            const sourceUrl = session.driver.getUrl()
            const wrappedText = this.untrustedMarkers.wrap(textOut ?? '', {
              source: sourceUrl,
              kind: 'element_text',
              override: untrustedOverride,
            })
            textOut = wrappedText.text
            untrustedMeta = wrappedText.meta
            if (typeof valueOut === 'string' && valueOut.length > 0) {
              valueOut = this.untrustedMarkers.wrap(valueOut, {
                source: sourceUrl,
                kind: 'element_value',
                override: untrustedOverride,
              }).text
            }
          }
          return {
            ok: true,
            ref: args.ref,
            text: textOut,
            value: valueOut,
            ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
            ...(resolved.recovered
              ? {
                  recovered: true,
                  recoveryStrategy: resolved.recoveryStrategy,
                  ...(resolved.recoveredRef ? { recoveredRef: resolved.recoveredRef } : {}),
                }
              : {}),
          }
        }
        const snap = await session.driver.snapshot()
        let contentOut = snap.text
        let untrustedMeta: UntrustedWrapMetadata | undefined
        if (wrapUntrusted) {
          const wrapped = this.untrustedMarkers.wrap(snap.text, {
            source: snap.url,
            kind: 'page_text',
            override: untrustedOverride,
          })
          contentOut = wrapped.text
          untrustedMeta = wrapped.meta
        }
        return capPayload({
          ok: true,
          url: snap.url,
          title: snap.title,
          content: contentOut,
          ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
        })
      }

      case 'page_extract': {
        const settleOpts = this.extractSettleOptions(args)
        const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined

        // Ensure fresh indexed snapshot so forms & links are enriched with active [eN] refs
        const snap = await this.takeIndexedSnapshot(session)
        session.lastSnapshot = snap

        const html = session.driver.getHtml ? await session.driver.getHtml() : ''
        const sections = parseExtractSections(args.sections ?? args.include)
        const maxItems =
          typeof args.maxItems === 'number' && Number.isFinite(args.maxItems)
            ? Math.max(1, Math.min(1000, Math.floor(args.maxItems)))
            : undefined

        const extracted = extractStructuredData({
          html,
          snapshot: snap,
          url: snap.url,
          title: snap.title,
          options: {
            sections,
            maxItems,
            includeObjects: args.includeObjects !== false,
            asciiOnly: Boolean(args.asciiOnly),
            externalLinksOnly: Boolean(args.externalLinksOnly ?? args.external),
            internalLinksOnly: Boolean(args.internalLinksOnly ?? args.internal),
          },
        })

        const includeAscii = Boolean(args.ascii)
        let ascii = includeAscii
          ? formatExtractAscii(extracted, {
              width: typeof args.width === 'number' ? args.width : undefined,
            })
          : undefined
        let untrustedMeta: UntrustedWrapMetadata | undefined
        if (ascii && wrapUntrusted) {
          const wrapped = this.untrustedMarkers.wrap(ascii, {
            source: snap.url,
            kind: 'page_extract',
            override: untrustedOverride,
          })
          ascii = wrapped.text
          untrustedMeta = wrapped.meta
        }

        return capPayload({
          ...extracted,
          ...(ascii ? { ascii } : {}),
          ...(untrustedMeta ? { untrustedMarkers: untrustedMeta } : {}),
          ...(settleRes ? { settle: settleRes } : {}),
        })
      }

      case 'page_navigate': {
        const input = String(args.url ?? '').trim()
        const resolved = resolveInput(input)
        if (resolved.kind === 'refused') {
          return { ok: false, status: 'blocked', code: 'scheme', error: resolved.reason }
        }
        const decision = authorizeAction({
          name: 'page_navigate',
          targetUrl: resolved.url,
          allowedOrigins,
          ssrf: this.ssrf.getOptions(),
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        if (this.ssrf.enabled) {
          const ssrfRes = await this.ssrf.checkAsync(resolved.url)
          if (ssrfRes.blocked && ssrfRes.reason) {
            return {
              ok: false,
              status: 'blocked',
              code: 'ssrf',
              category: ssrfRes.category,
              error: ssrfRes.reason,
            }
          }
        }
        const fromUrl = session.driver.getUrl()
        const nav = await session.driver.navigate(resolved.url)
        session.elements.invalidate()
        this.memory?.recordAction({ kind: 'navigate', selector: '', text: input, fromUrl, toUrl: nav.url, ok: true })
        this.emit({ type: 'navigated', tabId: session.driver.id, url: nav.url, title: nav.title, ...(sessionId ? { sessionId } : {}) })
        return { ok: true, ...nav }
      }

      case 'page_click': {
        const startCtx = ctx()
        const resolved = session.elements.resolve(args.ref, startCtx)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const decision = authorizeAction({
          name: 'page_click',
          item: resolved.item,
          allowSubmit: Boolean(args.allowSubmit),
          allowedOrigins,
          ssrf: this.ssrf.getOptions(),
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        const fromUrl = session.driver.getUrl()
        let activeSelector = resolved.selector
        let activeItem = resolved.item
        let recovered = Boolean(resolved.recovered)
        let recoveryStrategy = resolved.recoveryStrategy
        const recoveredRef = resolved.recoveredRef

        let result = await session.driver.click(activeSelector)
        if (!result.ok && (!result.note || /not found/i.test(result.note))) {
          const domRec = await this.trySameEpochDomRecovery(
            session,
            String(args.ref ?? '').trim(),
            activeItem,
            activeSelector,
            startCtx,
          )
          if (domRec.recovered) {
            const reDecision = authorizeAction({
              name: 'page_click',
              item: domRec.item,
              allowSubmit: Boolean(args.allowSubmit),
              allowedOrigins,
              ssrf: this.ssrf.getOptions(),
            })
            if (!reDecision.allowed) {
              return { ok: false, ...reDecision, error: reDecision.reason }
            }
            activeSelector = domRec.selector
            activeItem = domRec.item
            recovered = true
            recoveryStrategy = domRec.strategy
            result = await session.driver.click(activeSelector)
          }
        }

        const toUrl = session.driver.getUrl()
        this.memory?.recordAction({
          kind: 'click',
          selector: activeSelector,
          text: activeItem.text,
          fromUrl,
          toUrl,
          ok: result.ok,
        })
        if (result.ok) {
          this.emit({
            type: 'page_mutated',
            reason: 'click',
            tabId: session.driver.id,
            url: toUrl,
            title: session.driver.getTitle(),
            navigated: fromUrl !== toUrl,
            ...(sessionId ? { sessionId } : {}),
          })
        }
        return {
          ...result,
          url: toUrl,
          title: session.driver.getTitle(),
          ...(recovered
            ? {
                recovered: true,
                recoveryStrategy,
                ...(recoveredRef ? { recoveredRef } : {}),
              }
            : {}),
        }
      }

      case 'page_fill': {
        const startCtx = ctx()
        const resolved = session.elements.resolve(args.ref, startCtx)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const decision = authorizeAction({
          name: 'page_fill',
          item: resolved.item,
          allowedOrigins,
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        const text = String(args.text ?? args.value ?? '')
        const clear = args.clear !== undefined ? Boolean(args.clear) : true
        let activeSelector = resolved.selector
        let activeItem = resolved.item
        let recovered = Boolean(resolved.recovered)
        let recoveryStrategy = resolved.recoveryStrategy
        const recoveredRef = resolved.recoveredRef

        let result = await session.driver.fill(activeSelector, text, clear)
        if (!result.ok) {
          const domRec = await this.trySameEpochDomRecovery(
            session,
            String(args.ref ?? '').trim(),
            activeItem,
            activeSelector,
            startCtx,
          )
          if (domRec.recovered) {
            const reDecision = authorizeAction({
              name: 'page_fill',
              item: domRec.item,
              allowedOrigins,
            })
            if (!reDecision.allowed) {
              return { ok: false, ...reDecision, error: reDecision.reason }
            }
            activeSelector = domRec.selector
            activeItem = domRec.item
            recovered = true
            recoveryStrategy = domRec.strategy
            result = await session.driver.fill(activeSelector, text, clear)
          }
        }

        this.memory?.recordAction({
          kind: 'fill',
          selector: activeSelector,
          text: activeItem.text,
          fromUrl: session.driver.getUrl(),
          toUrl: session.driver.getUrl(),
          ok: result.ok,
        })
        if (result.ok) {
          this.emit({
            type: 'page_mutated',
            reason: 'fill',
            tabId: session.driver.id,
            url: session.driver.getUrl(),
            title: session.driver.getTitle(),
            ...(sessionId ? { sessionId } : {}),
          })
        }
        return {
          ...result,
          ref: args.ref,
          ...(recovered
            ? {
                recovered: true,
                recoveryStrategy,
                ...(recoveredRef ? { recoveredRef } : {}),
              }
            : {}),
        }
      }

      case 'page_select': {
        const startCtx = ctx()
        const resolved = session.elements.resolve(args.ref, startCtx)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const decision = authorizeAction({
          name: 'page_select',
          item: resolved.item,
          allowedOrigins,
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        let activeSelector = resolved.selector
        let activeItem = resolved.item
        let recovered = Boolean(resolved.recovered)
        let recoveryStrategy = resolved.recoveryStrategy
        const recoveredRef = resolved.recoveredRef

        let result = await session.driver.select(activeSelector, String(args.value ?? ''))
        if (!result.ok) {
          const domRec = await this.trySameEpochDomRecovery(
            session,
            String(args.ref ?? '').trim(),
            activeItem,
            activeSelector,
            startCtx,
          )
          if (domRec.recovered) {
            const reDecision = authorizeAction({
              name: 'page_select',
              item: domRec.item,
              allowedOrigins,
            })
            if (!reDecision.allowed) {
              return { ok: false, ...reDecision, error: reDecision.reason }
            }
            activeSelector = domRec.selector
            activeItem = domRec.item
            recovered = true
            recoveryStrategy = domRec.strategy
            result = await session.driver.select(activeSelector, String(args.value ?? ''))
          }
        }
        if (result.ok) {
          this.emit({
            type: 'page_mutated',
            reason: 'select',
            tabId: session.driver.id,
            url: session.driver.getUrl(),
            title: session.driver.getTitle(),
            ...(sessionId ? { sessionId } : {}),
          })
        }
        return {
          ...result,
          ref: args.ref,
          ...(recovered
            ? {
                recovered: true,
                recoveryStrategy,
                ...(recoveredRef ? { recoveredRef } : {}),
              }
            : {}),
        }
      }

      case 'page_press': {
        const startCtx = ctx()
        let selector: string | undefined
        let activeItem: ElementDescriptor | undefined
        let recovered = false
        let recoveryStrategy: RefRecoveryStrategy | undefined
        let recoveredRef: string | undefined
        if (args.ref) {
          const resolved = session.elements.resolve(args.ref, startCtx)
          if ('error' in resolved) return { ok: false, error: resolved.error }
          selector = resolved.selector
          activeItem = resolved.item
          recovered = Boolean(resolved.recovered)
          recoveryStrategy = resolved.recoveryStrategy
          recoveredRef = resolved.recoveredRef
        }
        let result = await session.driver.press(String(args.key ?? 'Enter'), selector)
        if (!result.ok && selector && activeItem && typeof result.error === 'string' && /not found/i.test(result.error)) {
          const domRec = await this.trySameEpochDomRecovery(
            session,
            String(args.ref ?? '').trim(),
            activeItem,
            selector,
            startCtx,
          )
          if (domRec.recovered) {
            selector = domRec.selector
            recovered = true
            recoveryStrategy = domRec.strategy
            result = await session.driver.press(String(args.key ?? 'Enter'), selector)
          }
        }
        if (result.ok) {
          this.emit({
            type: 'page_mutated',
            reason: 'press',
            tabId: session.driver.id,
            url: session.driver.getUrl(),
            title: session.driver.getTitle(),
            key: args.key,
            ...(sessionId ? { sessionId } : {}),
          })
        }
        return {
          ...result,
          key: args.key,
          ...(recovered
            ? {
                recovered: true,
                recoveryStrategy,
                ...(recoveredRef ? { recoveredRef } : {}),
              }
            : {}),
        }
      }

      case 'page_hover': {
        const startCtx = ctx()
        const resolved = session.elements.resolve(args.ref, startCtx)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        let activeSelector = resolved.selector
        let activeItem = resolved.item
        let recovered = Boolean(resolved.recovered)
        let recoveryStrategy = resolved.recoveryStrategy
        const recoveredRef = resolved.recoveredRef

        let result = await session.driver.hover(activeSelector)
        if (!result.ok) {
          const domRec = await this.trySameEpochDomRecovery(
            session,
            String(args.ref ?? '').trim(),
            activeItem,
            activeSelector,
            startCtx,
          )
          if (domRec.recovered) {
            activeSelector = domRec.selector
            recovered = true
            recoveryStrategy = domRec.strategy
            result = await session.driver.hover(activeSelector)
          }
        }
        return {
          ...result,
          ref: args.ref,
          ...(recovered
            ? {
                recovered: true,
                recoveryStrategy,
                ...(recoveredRef ? { recoveredRef } : {}),
              }
            : {}),
        }
      }

      case 'page_scroll': {
        const dir = (args.direction as 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom') || 'down'
        const amount = typeof args.amount === 'number' ? args.amount : 450
        const pos = await session.driver.scroll(dir, amount)
        this.emit({
          type: 'page_mutated',
          reason: 'scroll',
          tabId: session.driver.id,
          url: session.driver.getUrl(),
          title: session.driver.getTitle(),
          ...pos,
          ...(sessionId ? { sessionId } : {}),
        })
        return { ok: true, direction: dir, ...pos }
      }

      case 'page_wait': {
        const stateParsed = parseWaitState(args.state)
        if (stateParsed && typeof stateParsed === 'object' && 'error' in stateParsed) {
          return { ok: false, error: stateParsed.error }
        }
        const text = typeof args.text === 'string' && args.text.length > 0 ? args.text : undefined
        const selector = typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : undefined
        const url = typeof args.url === 'string' && args.url.length > 0 ? args.url : undefined
        const settle = Boolean(args.settle)
        const state = stateParsed

        if (state && !selector) {
          return { ok: false, error: 'wait state requires a selector' }
        }

        const hasCondition = Boolean(text || selector || url || settle)
        if (!hasCondition) {
          const ms = Math.max(0, Math.min(30000, Number(args.ms ?? 300)))
          await new Promise((r) => setTimeout(r, ms))
          return { ok: true, waitedMs: ms }
        }

        const timeout =
          args.timeout !== undefined && Number.isFinite(Number(args.timeout))
            ? Math.max(0, Math.min(60000, Number(args.timeout)))
            : 5000
        const pollIntervalMs =
          args.pollIntervalMs !== undefined && Number.isFinite(Number(args.pollIntervalMs))
            ? Math.max(10, Math.min(1000, Number(args.pollIntervalMs)))
            : 50
        const networkIdleMs =
          args.networkIdleMs !== undefined && Number.isFinite(Number(args.networkIdleMs))
            ? Number(args.networkIdleMs)
            : undefined
        const domQuietMs =
          args.domQuietMs !== undefined && Number.isFinite(Number(args.domQuietMs))
            ? Number(args.domQuietMs)
            : undefined
        const maxInflightRequests =
          args.maxInflightRequests !== undefined && Number.isFinite(Number(args.maxInflightRequests))
            ? Number(args.maxInflightRequests)
            : undefined

        const prevUrl = session.driver.getUrl()
        const result = await session.driver.waitFor({
          text,
          selector,
          url,
          state: state ?? (selector ? 'visible' : undefined),
          settle: settle || undefined,
          networkIdleMs,
          domQuietMs,
          maxInflightRequests,
          timeout,
          pollIntervalMs,
        })
        if (session.driver.getUrl() !== prevUrl) {
          session.elements.invalidate()
          this.emit({
            type: 'navigated',
            reason: 'wait',
            tabId: session.driver.id,
            url: session.driver.getUrl(),
            title: session.driver.getTitle(),
            ...(sessionId ? { sessionId } : {}),
          })
        }
        return { ...result }
      }

      case 'page_history': {
        const dir = (args.direction as 'back' | 'forward' | 'reload') || 'reload'
        const res = await session.driver.history(dir)
        session.elements.invalidate()
        this.emit({
          type: 'navigated',
          direction: dir,
          tabId: session.driver.id,
          url: res.url,
          title: res.title,
          ...(sessionId ? { sessionId } : {}),
        })
        return { ok: true, direction: dir, ...res }
      }

      case 'page_screenshot':
      case 'page_screenshot_ascii': {
        const cropRes = this.resolveCropArgs(session, { crop: args.crop, ref: args.ref })
        if ('error' in cropRes) return { ok: false, error: cropRes.error }

        const png = await session.driver.screenshot({ fullPage: Boolean(args.fullPage) })
        if (!png) {
          return {
            ok: false,
            error: 'screenshots require the chromium engine (currently using lite engine)',
          }
        }
        if (name === 'page_screenshot_ascii' || args.ascii) {
          const snap = session.lastSnapshot ?? (await this.takeIndexedSnapshot(session))
          const overlays = args.annotate
            ? snap.elements
                .filter((e) => e.ref && e.box)
                .slice(0, 40)
                .map((e) => ({ ref: e.ref!, box: e.box! }))
            : undefined
          const ascii = renderPngToAscii(png, {
            width: typeof args.width === 'number' ? args.width : 80,
            height: typeof args.height === 'number' ? args.height : undefined,
            mode: (args.mode as PixelAsciiOptions['mode']) || 'ascii',
            edgeThreshold: typeof args.edgeThreshold === 'number' ? args.edgeThreshold : undefined,
            crop: cropRes.crop,
            overlays,
            overlayStyle:
              args.overlayStyle === 'badge' || args.overlayStyle === 'box' ? args.overlayStyle : undefined,
            viewport: snap.viewport,
          })
          return {
            ok: true,
            ascii,
            bytes: png.length,
            ...(cropRes.crop ? { crop: cropRes.crop } : {}),
            ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
          }
        }
        return { ok: true, mimeType: 'image/png', dataBase64: png.toString('base64'), bytes: png.length }
      }

      case 'page_console': {
        const entries = session.driver.getConsole({
          clear: Boolean(args.clear),
          level: typeof args.level === 'string' ? args.level : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 50,
        })
        return { ok: true, count: entries.length, entries }
      }

      case 'page_network': {
        const bodyReqId =
          typeof args.body === 'string' && args.body.trim()
            ? args.body.trim()
            : typeof args.requestId === 'string' && args.requestId.trim()
              ? args.requestId.trim()
              : undefined
        if (bodyReqId) {
          if (!session.driver.getNetworkBody) {
            return { ok: false, requestId: bodyReqId, error: 'Network body inspection is not supported by this engine.' }
          }
          const result = await session.driver.getNetworkBody(bodyReqId, {
            ...(typeof args.maxBodyChars === 'number' ? { maxBodyChars: args.maxBodyChars } : {}),
            ...(typeof args.prettyJson === 'boolean' ? { prettyJson: args.prettyJson } : {}),
            ...(typeof args.revealHeaders === 'boolean' ? { revealHeaders: args.revealHeaders } : {}),
            ...(typeof args.includeBinary === 'boolean' ? { includeBinary: args.includeBinary } : {}),
          })
          return result as unknown as Record<string, unknown>
        }
        const entries = session.driver.getNetwork({
          clear: Boolean(args.clear),
          failedOnly: Boolean(args.failedOnly),
          blockedOnly: Boolean(args.blockedOnly),
          method: typeof args.method === 'string' ? args.method : undefined,
          urlFilter: typeof args.urlFilter === 'string' ? args.urlFilter : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 50,
        })
        const trackerBlocking = session.driver.getBlockedTrackerStats?.()
        return {
          ok: true,
          count: entries.length,
          entries,
          ascii: formatNetworkListAscii(entries),
          ...(trackerBlocking ? { trackerBlocking } : {}),
        }
      }

      case 'page_network_body': {
        const bodyReqId =
          typeof args.requestId === 'string' && args.requestId.trim()
            ? args.requestId.trim()
            : typeof args.body === 'string' && args.body.trim()
              ? args.body.trim()
              : ''
        if (!bodyReqId) {
          return { ok: false, error: 'Missing required parameter: requestId' }
        }
        if (!session.driver.getNetworkBody) {
          return { ok: false, requestId: bodyReqId, error: 'Network body inspection is not supported by this engine.' }
        }
        const result = await session.driver.getNetworkBody(bodyReqId, {
          ...(typeof args.maxBodyChars === 'number' ? { maxBodyChars: args.maxBodyChars } : {}),
          ...(typeof args.prettyJson === 'boolean' ? { prettyJson: args.prettyJson } : {}),
          ...(typeof args.revealHeaders === 'boolean' ? { revealHeaders: args.revealHeaders } : {}),
          ...(typeof args.includeBinary === 'boolean' ? { includeBinary: args.includeBinary } : {}),
        })
        return result as unknown as Record<string, unknown>
      }

      case 'page_downloads': {
        if (typeof args.removeId === 'string' && args.removeId.trim()) {
          const removed = this.removeDownload(args.removeId.trim())
          return { ...removed, stats: this.getDownloadStats() }
        }
        if (args.clear) {
          const cleared = this.clearDownloads({ deleteFiles: args.deleteFiles !== false })
          return { ok: true, ...cleared, stats: this.getDownloadStats() }
        }
        const mode = parseDownloadMode(args.mode)
        if (mode || typeof args.maxBytes === 'number') {
          this.setDownloadPolicy({
            ...(mode ? { mode } : {}),
            ...(typeof args.maxBytes === 'number' ? { maxBytes: args.maxBytes } : {}),
          })
        }
        const status =
          args.status === 'in_progress' ||
          args.status === 'quarantined' ||
          args.status === 'blocked' ||
          args.status === 'canceled' ||
          args.status === 'failed'
            ? args.status
            : undefined
        const entries = this.getDownloads({
          status,
          blockedOnly: Boolean(args.blockedOnly),
          limit: typeof args.limit === 'number' ? args.limit : 50,
        })
        const stats = this.getDownloadStats()
        return {
          ok: true,
          count: entries.length,
          entries,
          stats,
          ascii: formatDownloadsAscii(entries, stats),
        }
      }

      case 'page_eval': {
        const decision = authorizeAction({
          name: 'page_eval',
          currentUrl: session.driver.getUrl(),
          allowedOrigins,
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        const value = await session.driver.evaluate(String(args.expression ?? ''))
        this.emit({
          type: 'page_mutated',
          reason: 'eval',
          tabId: session.driver.id,
          url: session.driver.getUrl(),
          title: session.driver.getTitle(),
          ...(sessionId ? { sessionId } : {}),
        })
        return capPayload({ ok: true, value })
      }

      case 'page_act': {
        const steps = Array.isArray(args.steps) ? (args.steps as ActStep[]).slice(0, 20) : []
        const results: Array<Record<string, unknown>> = []
        const startUrl = session.driver.getUrl()
        for (const step of steps) {
          const toolName = step.op === 'read_ascii' ? 'page_read_ascii' : `page_${step.op}`
          const stepRes = await this.runTool(
            session.driver.id,
            toolName,
            {
              ...step,
              allowSubmit: step.allowSubmit ?? args.allowSubmit,
            },
            { sessionId },
          )
          results.push({ op: step.op, ref: step.ref, ...stepRes })
          if (!stepRes.ok) {
            return {
              ok: false,
              stoppedAt: results.length - 1,
              results,
              error: stepRes.error,
              ...(stepRes.code ? { code: stepRes.code } : {}),
              ...(stepRes.status ? { status: stepRes.status } : {}),
              ...(stepRes.loopGuard ? { loopGuard: stepRes.loopGuard } : {}),
            }
          }
          if (session.driver.getUrl() !== startUrl) {
            return { ok: true, navigated: true, url: session.driver.getUrl(), results }
          }
        }
        return { ok: true, results }
      }

      case 'page_emulate': {
        const hasUpdate =
          args.viewport !== undefined ||
          args.userAgent !== undefined ||
          args.acceptLanguage !== undefined ||
          args.platform !== undefined ||
          args.extraHeaders !== undefined ||
          args.headers !== undefined ||
          Boolean(args.clearHeaders) ||
          (Array.isArray(args.removeHeaders) && args.removeHeaders.length > 0)

        if (!hasUpdate) {
          return this.getEmulation(session.driver.id, { revealHeaders: Boolean(args.revealHeaders) })
        }

        const extraHeaders =
          (typeof args.extraHeaders === 'object' && args.extraHeaders !== null
            ? (args.extraHeaders as Record<string, string>)
            : typeof args.headers === 'object' && args.headers !== null
              ? (args.headers as Record<string, string>)
              : undefined)

        return this.setEmulation({
          tabId: args.allTabs ? undefined : session.driver.id,
          allTabs: Boolean(args.allTabs),
          viewport: args.viewport as EmulationOptions['viewport'],
          userAgent: typeof args.userAgent === 'string' ? args.userAgent : undefined,
          acceptLanguage: typeof args.acceptLanguage === 'string' ? args.acceptLanguage : undefined,
          platform: typeof args.platform === 'string' ? args.platform : undefined,
          extraHeaders,
          mergeHeaders: typeof args.mergeHeaders === 'boolean' ? args.mergeHeaders : undefined,
          clearHeaders: Boolean(args.clearHeaders),
          removeHeaders: Array.isArray(args.removeHeaders) ? args.removeHeaders.map(String) : undefined,
          revealHeaders: Boolean(args.revealHeaders),
        })
      }

      default:
        return { ok: false, error: `unknown tool: ${name}` }
    }
  }

  async exportCookies(opts: CookieExportOptions = {}): Promise<BrowserCookie[]> {
    const cookies = await this.engine.exportCookies(opts)
    this.emit({ type: 'cookies_exported', count: cookies.length, domain: opts.domain })
    return cookies
  }

  async importCookies(cookies: BrowserCookie[]): Promise<CookieImportResult> {
    const result = await this.engine.importCookies(cookies)
    this.emit({ type: 'cookies_imported', imported: result.imported, skipped: result.skipped })
    return result
  }

  async clearCookies(opts: { domain?: string } = {}): Promise<number> {
    if (!this.engine.clearCookies) return 0
    const removed = await this.engine.clearCookies(opts)
    this.emit({ type: 'cookies_cleared', removed, domain: opts.domain })
    return removed
  }

  async exportStorage(opts: StorageExportOptions = {}): Promise<OriginStorageSnapshot[]> {
    const collected: OriginStorageSnapshot[] = []
    if (opts.tabId !== undefined) {
      const session = this.resolveSession(opts.tabId)
      if (!session) throw new Error(`Tab ${opts.tabId} not found`)
      const snap = await session.driver.getStorage({ area: opts.area, keyPrefix: opts.keyPrefix })
      if (snap.origin) collected.push(snap)
    } else {
      if (this.engine.getEngineStorage) {
        collected.push(
          ...this.engine.getEngineStorage({
            origin: opts.origin,
            area: opts.area,
            keyPrefix: opts.keyPrefix,
          }),
        )
      }
      for (const session of this.tabs.values()) {
        const snap = await session.driver.getStorage({ area: opts.area, keyPrefix: opts.keyPrefix })
        if (snap.origin) collected.push(snap)
      }
    }

    const filtered = filterStorageSnapshots(collected, {
      origin: opts.origin,
      area: opts.area,
      keyPrefix: opts.keyPrefix,
    })
    const counts = countStorageKeys(filtered)
    this.emit({ type: 'storage_exported', origins: filtered.length, totalKeys: counts.totalKeys })
    return filtered
  }

  async inspectStorage(
    opts: StorageExportOptions & { revealValues?: boolean; width?: number } = {},
  ): Promise<{
    engine: 'chromium' | 'lite'
    origins: OriginStorageSnapshot[]
    counts: { localKeys: number; sessionKeys: number; totalKeys: number }
    ascii: string
  }> {
    const rawOrigins = await this.exportStorage(opts)
    const counts = countStorageKeys(rawOrigins)
    const displayOrigins = redactStorageSnapshots(rawOrigins, { revealValues: Boolean(opts.revealValues) })
    const ascii = formatStorageAscii(rawOrigins, {
      revealValues: Boolean(opts.revealValues),
      width: opts.width,
    })
    return {
      engine: this.engine.kind,
      origins: displayOrigins,
      counts,
      ascii,
    }
  }

  async importStorage(
    snapshots: OriginStorageSnapshot[],
    opts: StorageImportOptions = {},
  ): Promise<StorageImportResult> {
    const area = normalizeStorageArea(opts.area)
    const importedOriginSet = new Set<string>()
    let localKeys = 0
    let sessionKeys = 0
    let skipped = 0
    const errors: string[] = []

    const normalized: OriginStorageSnapshot[] = []
    for (const raw of snapshots) {
      const snap = normalizeOriginStorageSnapshot(raw)
      if (!snap) {
        skipped++
        errors.push(`Invalid storage snapshot skipped: ${String((raw as { origin?: unknown })?.origin ?? '<unknown>')}`)
        continue
      }
      if (opts.origin && !originFilterMatches(snap.origin, opts.origin)) {
        skipped++
        continue
      }
      normalized.push(snap)
    }

    for (const snap of normalized) {
      const localData = area === 'session' ? undefined : snap.localStorage
      const sessionData = area === 'local' ? undefined : snap.sessionStorage

      if (this.engine.importEngineStorage) {
        let touched = false
        if (localData !== undefined) {
          const engRes = this.engine.importEngineStorage([snap], {
            area: 'local',
            clearBeforeImport: opts.clearBeforeImport,
          })
          localKeys += engRes.localKeys
          errors.push(...engRes.errors)
          if (engRes.importedOrigins > 0) touched = true
        }
        if (sessionData !== undefined) {
          const targetTabs: TabSession[] = []
          if (opts.tabId !== undefined) {
            const found = this.resolveSession(opts.tabId)
            if (!found) {
              errors.push(`Tab ${opts.tabId} not found`)
            } else {
              targetTabs.push(found)
            }
          } else {
            for (const s of this.tabs.values()) {
              if (normalizeStorageOrigin(s.driver.getUrl()) === snap.origin) {
                targetTabs.push(s)
              }
            }
          }
          for (const tab of targetTabs) {
            if (normalizeStorageOrigin(tab.driver.getUrl()) === snap.origin) {
              const tabRes = await tab.driver.setStorage(
                { sessionStorage: sessionData },
                { clearBeforeImport: opts.clearBeforeImport },
              )
              sessionKeys += tabRes.sessionKeys
              touched = true
            }
          }
        }
        if (touched) importedOriginSet.add(snap.origin)
        else skipped++
        continue
      }

      // Chromium (or tab-backed engine) hydration path
      try {
        if (opts.tabId !== undefined) {
          const session = this.resolveSession(opts.tabId)
          if (!session) {
            skipped++
            errors.push(`Tab ${opts.tabId} not found`)
            continue
          }
          const currentOrigin = normalizeStorageOrigin(session.driver.getUrl())
          if (!currentOrigin) {
            await session.driver.navigate(snap.origin)
          } else if (currentOrigin !== snap.origin) {
            skipped++
            errors.push(`Tab ${opts.tabId} is on ${currentOrigin}, expected ${snap.origin}`)
            continue
          }
          const res = await session.driver.setStorage(
            { localStorage: localData, sessionStorage: sessionData },
            { clearBeforeImport: opts.clearBeforeImport },
          )
          localKeys += res.localKeys
          sessionKeys += res.sessionKeys
          importedOriginSet.add(snap.origin)
        } else {
          const existing = [...this.tabs.values()].find(
            (s) => normalizeStorageOrigin(s.driver.getUrl()) === snap.origin,
          )
          if (existing) {
            const res = await existing.driver.setStorage(
              { localStorage: localData, sessionStorage: sessionData },
              { clearBeforeImport: opts.clearBeforeImport },
            )
            localKeys += res.localKeys
            sessionKeys += res.sessionKeys
            importedOriginSet.add(snap.origin)
          } else {
            const tempTab = await this.engine.createTab(snap.origin)
            try {
              const res = await tempTab.setStorage(
                { localStorage: localData, sessionStorage: sessionData },
                { clearBeforeImport: opts.clearBeforeImport },
              )
              localKeys += res.localKeys
              sessionKeys += res.sessionKeys
              importedOriginSet.add(snap.origin)
            } finally {
              await tempTab.close().catch(() => {})
            }
          }
        }
      } catch (err) {
        skipped++
        errors.push(`${snap.origin}: ${String((err as Error)?.message ?? err)}`)
      }
    }

    const result: StorageImportResult = {
      importedOrigins: importedOriginSet.size,
      localKeys,
      sessionKeys,
      skipped,
      errors,
    }
    this.emit({ type: 'storage_imported', ...result })
    return result
  }

  async clearStorage(opts: StorageClearOptions = {}): Promise<StorageClearResult> {
    const area = normalizeStorageArea(opts.area)
    let removedLocal = 0
    let removedSession = 0
    const origins = new Set<string>()

    if (opts.tabId !== undefined) {
      const session = this.resolveSession(opts.tabId)
      if (!session) throw new Error(`Tab ${opts.tabId} not found`)
      const res = await session.driver.clearStorage({ area, keys: opts.keys })
      removedLocal += res.removedLocal
      removedSession += res.removedSession
      if (res.origin && (res.removedLocal > 0 || res.removedSession > 0)) {
        origins.add(res.origin)
      }
    } else {
      for (const session of this.tabs.values()) {
        const tabOrigin = normalizeStorageOrigin(session.driver.getUrl())
        if (!tabOrigin) continue
        if (opts.origin && !originFilterMatches(tabOrigin, opts.origin)) continue
        const res = await session.driver.clearStorage({ area, keys: opts.keys })
        removedLocal += res.removedLocal
        removedSession += res.removedSession
        if (res.origin && (res.removedLocal > 0 || res.removedSession > 0)) {
          origins.add(res.origin)
        }
      }
      if (this.engine.clearEngineStorage) {
        const engRes = this.engine.clearEngineStorage({
          origin: opts.origin,
          area,
          keys: opts.keys,
        })
        removedLocal += engRes.removedLocal
        removedSession += engRes.removedSession
        for (const o of engRes.origins) origins.add(o)
      }
    }

    const result: StorageClearResult = {
      removedLocal,
      removedSession,
      origins: [...origins].sort(),
    }
    this.emit({ type: 'storage_cleared', ...result })
    return result
  }

  getEmulation(
    tabId?: number,
    opts: { revealHeaders?: boolean } = {},
  ): {
    ok: boolean
    tabId?: number
    emulation?: EmulationProfile
    defaultEmulation?: EmulationProfile
    ascii?: string
    error?: string
  } {
    const defaultProfile = this.engine.getDefaultEmulation
      ? this.engine.getDefaultEmulation()
      : defaultEmulationProfile()
    const reveal = Boolean(opts.revealHeaders)

    const maskProfile = (p: EmulationProfile): EmulationProfile => ({
      ...p,
      viewport: { ...p.viewport },
      extraHeaders: redactHeaders(p.extraHeaders, reveal),
    })

    if (tabId !== undefined) {
      const session = this.tabs.get(tabId)
      if (!session) return { ok: false, error: `no tab ${tabId}` }
      const prof = session.driver.getEmulation()
      return {
        ok: true,
        tabId: session.driver.id,
        emulation: maskProfile(prof),
        defaultEmulation: maskProfile(defaultProfile),
        ascii: formatEmulationAscii(prof, { revealHeaders: reveal, tabId: session.driver.id }),
      }
    }

    const active = this.resolveSession()
    if (active) {
      const prof = active.driver.getEmulation()
      return {
        ok: true,
        tabId: active.driver.id,
        emulation: maskProfile(prof),
        defaultEmulation: maskProfile(defaultProfile),
        ascii: formatEmulationAscii(prof, { revealHeaders: reveal, tabId: active.driver.id }),
      }
    }

    return {
      ok: true,
      emulation: maskProfile(defaultProfile),
      defaultEmulation: maskProfile(defaultProfile),
      ascii: formatEmulationAscii(defaultProfile, { revealHeaders: reveal }),
    }
  }

  async setEmulation(
    opts: EmulationOptions &
      EmulationUpdateMode & {
        tabId?: number
        allTabs?: boolean
        revealHeaders?: boolean
      },
  ): Promise<{
    ok: boolean
    tabId?: number
    updatedTabs?: number[]
    emulation?: EmulationProfile
    ascii?: string
    error?: string
  }> {
    const emuOpts: EmulationOptions = {
      viewport: opts.viewport,
      userAgent: opts.userAgent,
      acceptLanguage: opts.acceptLanguage,
      platform: opts.platform,
      extraHeaders: opts.extraHeaders,
    }
    const mode: EmulationUpdateMode = {
      mergeHeaders: opts.mergeHeaders,
      clearHeaders: opts.clearHeaders,
      removeHeaders: opts.removeHeaders,
    }
    const reveal = Boolean(opts.revealHeaders)
    const maskProfile = (p: EmulationProfile): EmulationProfile => ({
      ...p,
      viewport: { ...p.viewport },
      extraHeaders: redactHeaders(p.extraHeaders, reveal),
    })

    try {
      if (opts.allTabs || (opts.tabId === undefined && this.tabs.size === 0)) {
        const defaultProf = this.engine.setDefaultEmulation
          ? this.engine.setDefaultEmulation(emuOpts, mode)
          : defaultEmulationProfile()
        const updatedTabs: number[] = []
        let lastProf = defaultProf
        for (const session of this.tabs.values()) {
          lastProf = await session.driver.setEmulation(emuOpts, mode)
          updatedTabs.push(session.driver.id)
        }
        this.emit({
          type: 'emulation_updated',
          allTabs: true,
          updatedTabs,
          preset: lastProf.preset,
          viewport: lastProf.viewport,
        })
        return {
          ok: true,
          updatedTabs,
          emulation: maskProfile(lastProf),
          ascii: formatEmulationAscii(lastProf, { revealHeaders: reveal }),
        }
      }

      const session = this.resolveSession(opts.tabId)
      if (!session) {
        return { ok: false, error: opts.tabId !== undefined ? `no tab ${opts.tabId}` : 'no active tab' }
      }
      const updated = await session.driver.setEmulation(emuOpts, mode)
      this.emit({
        type: 'emulation_updated',
        tabId: session.driver.id,
        preset: updated.preset,
        viewport: updated.viewport,
      })
      return {
        ok: true,
        tabId: session.driver.id,
        updatedTabs: [session.driver.id],
        emulation: maskProfile(updated),
        ascii: formatEmulationAscii(updated, { revealHeaders: reveal, tabId: session.driver.id }),
      }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) }
    }
  }

  getCrashRecoveryStats(): CrashRecoveryStats {
    return this.engine.getCrashRecoveryStats
      ? this.engine.getCrashRecoveryStats()
      : defaultDisabledCrashRecoveryStats(this.engine.cdpPort)
  }

  getDownloads(opts?: { status?: DownloadStatus; blockedOnly?: boolean; limit?: number }): DownloadEntry[] {
    return this.engine.getDownloads ? this.engine.getDownloads(opts) : []
  }

  getDownloadStats(): DownloadStats {
    if (this.engine.getDownloadStats) {
      return this.engine.getDownloadStats()
    }
    return {
      mode: 'quarantine',
      quarantineDir: path.join(this.profileDir, 'quarantine'),
      maxBytes: DEFAULT_DOWNLOAD_MAX_BYTES,
      total: 0,
      quarantined: 0,
      blocked: 0,
      inProgress: 0,
      failed: 0,
    }
  }

  setDownloadPolicy(opts: DownloadPolicyOptions): DownloadStats {
    if (this.engine.setDownloadPolicy) {
      const stats = this.engine.setDownloadPolicy(opts)
      this.emit({ type: 'download_policy_updated', stats })
      return stats
    }
    return this.getDownloadStats()
  }

  clearDownloads(opts?: { deleteFiles?: boolean }): { cleared: number; removedFiles: number } {
    return this.engine.clearDownloads ? this.engine.clearDownloads(opts) : { cleared: 0, removedFiles: 0 }
  }

  removeDownload(id: string): { ok: boolean; removedFile: boolean; error?: string } {
    return this.engine.removeDownload
      ? this.engine.removeDownload(id)
      : { ok: false, removedFile: false, error: 'downloads not supported by engine' }
  }

  getDialogs(opts?: { tabId?: number; type?: DialogType; limit?: number; clear?: boolean }): DialogEntry[] {
    return this.engine.getDialogs ? this.engine.getDialogs(opts) : []
  }

  getDialogStats(): DialogStats {
    if (this.engine.getDialogStats) {
      return this.engine.getDialogStats()
    }
    return {
      mode: 'dismiss',
      acceptBeforeUnload: true,
      queuedCount: 0,
      total: 0,
      alerts: 0,
      confirms: 0,
      prompts: 0,
      beforeUnloads: 0,
      accepted: 0,
      dismissed: 0,
    }
  }

  setDialogPolicy(opts: DialogPolicyOptions): DialogStats {
    if (this.engine.setDialogPolicy) {
      const stats = this.engine.setDialogPolicy(opts)
      this.emit({ type: 'dialog_policy_updated', stats })
      return stats
    }
    return this.getDialogStats()
  }

  queueDialogResponse(resp: DialogQueuedResponse): DialogStats {
    if (this.engine.queueDialogResponse) {
      const stats = this.engine.queueDialogResponse(resp)
      this.emit({ type: 'dialog_response_queued', response: resp, stats })
      return stats
    }
    return this.getDialogStats()
  }

  getDialogQueue(): DialogQueuedResponse[] {
    return this.engine.getDialogQueue ? this.engine.getDialogQueue() : []
  }

  clearDialogQueue(): number {
    return this.engine.clearDialogQueue ? this.engine.clearDialogQueue() : 0
  }

  clearDialogs(opts?: { tabId?: number }): number {
    return this.engine.clearDialogs ? this.engine.clearDialogs(opts) : 0
  }

  async close(): Promise<void> {
    this.unsubscribeCrash?.()
    this.unsubscribeCrash = undefined
    this.unsubscribeDownloads?.()
    this.unsubscribeDownloads = undefined
    this.unsubscribeDialogs?.()
    this.unsubscribeDialogs = undefined
    for (const s of this.tabs.values()) {
      await s.driver.close().catch(() => {})
    }
    this.tabs.clear()
    this.memory?.flush()
    await this.engine.close()
  }
}
