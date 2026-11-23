// BrowserManager: orchestrates tabs, engine selection (Chromium or Lite),
// per-tab ElementRegistry, deterministic Policy enforcement, PageMemory,
// Delta reads, and ASCII / Pixel-ASCII rendering.

import path from 'node:path'
import os from 'node:os'
import type {
  ActStep,
  AsciiRenderOptions,
  BrowserCookie,
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
  MarkdownRenderOptions,
  OriginStorageSnapshot,
  PageSnapshot,
  PixelAsciiOptions,
  Rect,
  SettleOptions,
  SettleResult,
  StorageClearOptions,
  StorageClearResult,
  StorageExportOptions,
  StorageImportOptions,
  StorageImportResult,
  TabSummary,
  TrackerBlockingOptions,
} from '../types.js'
import {
  ElementRegistry,
  recoverElementMatch,
  type RefContext,
  type RefRecoveryStrategy,
} from '../agent/elements.js'
import { PageMemory } from '../agent/memory.js'
import { exactOrigin, normalizeOrigin, resolveInput } from '../agent/omnibox.js'
import { authorizeAction } from '../agent/policy.js'
import { computePageDelta, type PageDelta } from '../agent/delta.js'
import {
  extractMediaSummary,
  parseAsciiDensity,
  renderCanvasPreviewAscii,
  renderCompactRefsAscii,
  renderDeltaAscii,
  renderMediaSummaryAscii,
  renderPageAscii,
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
}

export class BrowserManager {
  readonly engine: BrowserEngine
  readonly profileDir: string
  readonly memory: PageMemory | null
  private tabs = new Map<number, TabSession>()
  private activeTabId: number | null = null
  private allowedOrigins = new Set<string>()
  private eventListeners = new Set<(event: Record<string, unknown>) => void>()
  private unsubscribeCrash?: () => void
  private unsubscribeDownloads?: () => void
  private unsubscribeDialogs?: () => void

  private constructor(engine: BrowserEngine, profileDir: string, memory: PageMemory | null) {
    this.engine = engine
    this.profileDir = profileDir
    this.memory = memory
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

    let engine: BrowserEngine
    const requested = opts.engine ?? 'auto'
    if (requested === 'lite') {
      engine = new LiteBrowserEngine({
        emulation: opts.emulation,
        profileDir,
        downloads: downloadsOpts,
        dialogs: opts.dialogs,
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
          })
        } catch {
          engine = new LiteBrowserEngine({
            emulation: opts.emulation,
            profileDir,
            downloads: downloadsOpts,
            dialogs: opts.dialogs,
          })
        }
      } else {
        engine = new LiteBrowserEngine({
          emulation: opts.emulation,
          profileDir,
          downloads: downloadsOpts,
          dialogs: opts.dialogs,
        })
      }
    }

    const memory = opts.memoryEnabled === false ? null : new PageMemory(path.join(profileDir, 'memory.json'))
    return new BrowserManager(engine, profileDir, memory)
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

  listTabs(): TabSummary[] {
    return [...this.tabs.values()].map((s) => ({
      id: s.driver.id,
      url: s.driver.getUrl(),
      title: s.driver.getTitle(),
      active: s.driver.id === this.activeTabId,
      loading: s.driver.isLoading(),
      engine: s.driver.engine,
    }))
  }

  private refreshOrigins(): void {
    for (const s of this.tabs.values()) {
      const origin = exactOrigin(s.driver.getUrl())
      if (origin) this.allowedOrigins.add(origin)
    }
  }

  grantOrigin(originOrUrl: string): { ok: boolean; origin?: string; error?: string } {
    const origin = normalizeOrigin(originOrUrl)
    if (!origin) return { ok: false, error: 'grant needs an http(s) origin' }
    this.allowedOrigins.add(origin)
    this.emit({ type: 'origin_granted', origin })
    return { ok: true, origin }
  }

  async openTab(inputUrl?: string, opts: { activate?: boolean; ownedByBridge?: boolean } = {}) {
    let targetUrl: string | undefined
    if (inputUrl && inputUrl.trim()) {
      const resolved = resolveInput(inputUrl)
      if (resolved.kind === 'refused') {
        return { ok: false, error: `${inputUrl} refused (${resolved.reason})` }
      }
      targetUrl = resolved.url
      const origin = exactOrigin(targetUrl)
      if (origin) this.allowedOrigins.add(origin)
    }

    const driver = await this.engine.createTab(targetUrl)
    const session: TabSession = {
      driver,
      elements: new ElementRegistry(),
      lastSnapshot: null,
      ownedByBridge: opts.ownedByBridge ?? true,
    }
    this.tabs.set(driver.id, session)
    if (this.activeTabId === null || opts.activate) {
      this.activeTabId = driver.id
    }
    const finalOrigin = exactOrigin(driver.getUrl())
    if (finalOrigin) this.allowedOrigins.add(finalOrigin)
    this.emit({ type: 'tab_opened', tabId: driver.id, url: driver.getUrl() })
    return { ok: true, id: driver.id, url: driver.getUrl(), title: driver.getTitle() }
  }

  activateTab(tabId: number): { ok: boolean; error?: string } {
    if (!this.tabs.has(tabId)) return { ok: false, error: `no tab ${tabId}` }
    this.activeTabId = tabId
    this.emit({ type: 'tab_activated', tabId })
    return { ok: true }
  }

  async closeTab(tabId: number, requireOwned = false): Promise<{ ok: boolean; error?: string }> {
    const session = this.tabs.get(tabId)
    if (!session) return { ok: false, error: `no tab ${tabId}` }
    if (requireOwned && !session.ownedByBridge) {
      return { ok: false, error: 'this bridge session did not open that tab; refusing to close it' }
    }
    await session.driver.close()
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) {
      const next = this.tabs.keys().next()
      this.activeTabId = next.done ? null : next.value
    }
    this.emit({ type: 'tab_closed', tabId })
    return { ok: true }
  }

  private resolveSession(tabId?: number): TabSession | null {
    if (tabId !== undefined) return this.tabs.get(tabId) ?? null
    if (this.activeTabId !== null) return this.tabs.get(this.activeTabId) ?? null
    const first = this.tabs.values().next()
    return first.done ? null : first.value
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
    error?: string
  }> {
    const session = this.resolveSession(tabId)
    if (!session) return { ok: false, error: 'no open tab' }
    const settleOpts = this.extractSettleOptions(opts as Record<string, unknown>)
    const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined
    const cropRes = this.resolveCropArgs(session, { crop: opts.crop, ref: opts.ref })
    if ('error' in cropRes) return { ok: false, error: cropRes.error }
    const prev = session.lastSnapshot
    const snap = await this.takeIndexedSnapshot(session)
    session.lastSnapshot = snap
    if (opts.since && prev) {
      const delta = computePageDelta(prev, snap)
      const ascii = renderDeltaAscii(delta, {
        width: opts.width,
        asciiOnly: opts.asciiOnly,
        color: opts.color,
        showChrome: opts.showChrome,
        density: opts.density,
      })
      return { ok: true, mode: 'delta', ascii, snapshot: snap, delta, ...(settleRes ? { settle: settleRes } : {}) }
    }
    const { crop: _rawCrop, ref: _rawRef, since: _since, settle: _settle, ...renderOpts } = opts
    const ascii = renderPageAscii(snap, {
      ...renderOpts,
      crop: cropRes.crop,
      cropLabel: cropRes.cropRef ?? opts.cropLabel,
      tabs: this.listTabs(),
      activeTabId: this.activeTabId ?? snap.tabId,
    })
    return {
      ok: true,
      mode: 'full',
      ascii,
      snapshot: snap,
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
    } = {},
  ): Promise<{
    ok: boolean
    markdown?: string
    snapshot?: PageSnapshot
    settle?: SettleResult
    crop?: Rect
    cropRef?: string
    error?: string
  }> {
    const session = this.resolveSession(tabId)
    if (!session) return { ok: false, error: 'no open tab' }
    const settleOpts = this.extractSettleOptions(opts as Record<string, unknown>)
    const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined
    const cropRes = this.resolveCropArgs(session, { crop: opts.crop, ref: opts.ref })
    if ('error' in cropRes) return { ok: false, error: cropRes.error }
    const snap = await this.takeIndexedSnapshot(session)
    session.lastSnapshot = snap
    const { crop: _rawCrop, ref: _rawRef, settle: _settle, ...renderOpts } = opts
    const markdown = renderPageMarkdown(snap, {
      ...renderOpts,
      crop: cropRes.crop,
      cropLabel: cropRes.cropRef ?? opts.cropLabel,
    })
    return {
      ok: true,
      markdown,
      snapshot: snap,
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

  async runTool(tabId: number | undefined, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const session = this.resolveSession(tabId)
    if (name === 'page_dialogs') {
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
    if (!session) return { ok: false, error: 'no such tab', code: 'no-tab' }
    this.refreshOrigins()
    const ctx = () => ({ tabId: session.driver.id, url: session.driver.getUrl(), epoch: session.driver.getEpoch() })

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

        if (args.since && prev) {
          const delta = computePageDelta(prev, snap)
          const ascii = renderDeltaAscii(delta, {
            width: typeof args.width === 'number' ? args.width : undefined,
            asciiOnly: args.asciiOnly !== false,
            color: Boolean(args.color),
            showChrome: typeof args.showChrome === 'boolean' ? args.showChrome : undefined,
            density: parseAsciiDensity(args.density),
          })
          return capPayload({
            ok: true,
            mode: 'delta',
            ...delta,
            ascii,
            ...(settleRes ? { settle: settleRes } : {}),
            ...(name === 'page_read_ascii' ? { content: ascii } : {}),
          })
        }

        const layoutOpt =
          args.layout === 'spatial' || args.layout === 'auto' || args.layout === 'flow' ? args.layout : undefined
        const densityOpt = parseAsciiDensity(args.density)
        const ascii = renderPageAscii(snap, {
          width: typeof args.width === 'number' ? args.width : undefined,
          height: typeof args.height === 'number' ? args.height : undefined,
          asciiOnly: args.asciiOnly !== false,
          color: Boolean(args.color),
          showChrome: typeof args.showChrome === 'boolean' ? args.showChrome : undefined,
          showMediaSummary: Boolean(args.showMediaSummary),
          layout: layoutOpt,
          density: densityOpt,
          crop: cropRes.crop,
          cropLabel: cropRes.cropRef,
          tabs: this.listTabs(),
          activeTabId: this.activeTabId ?? snap.tabId,
        })

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
          compactRefs: renderCompactRefsAscii(snap),
          ...(media.length > 0 ? { media, mediaSummaryAscii } : {}),
          ...(pixelAscii ? { pixelAscii } : {}),
          ...(settleRes ? { settle: settleRes } : {}),
          ...(cropRes.crop ? { crop: cropRes.crop } : {}),
          ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
          content: name === 'page_read_ascii' ? ascii : snap.text,
        })
      }

      case 'page_read_markdown': {
        const settleOpts = this.extractSettleOptions(args)
        const settleRes = settleOpts ? await session.driver.waitForSettle(settleOpts) : undefined
        const cropRes = this.resolveCropArgs(session, { crop: args.crop, ref: args.ref })
        if ('error' in cropRes) return { ok: false, error: cropRes.error }
        const snap = await this.takeIndexedSnapshot(session)
        session.lastSnapshot = snap
        const markdown = renderPageMarkdown(snap, {
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
          ...(settleRes ? { settle: settleRes } : {}),
          ...(cropRes.crop ? { crop: cropRes.crop } : {}),
          ...(cropRes.cropRef ? { cropRef: cropRes.cropRef } : {}),
        })
      }

      case 'page_find': {
        const query = String(args.query ?? '').trim().toLowerCase()
        if (!session.lastSnapshot) {
          session.lastSnapshot = await this.takeIndexedSnapshot(session)
        }
        const tokens = query.split(/\s+/).filter(Boolean)
        const matches = session.elements
          .list(ctx())
          .map((entry) => {
            const hay = `${entry.item.text} ${entry.item.label ?? ''} ${entry.item.ariaLabel ?? ''} ${entry.item.placeholder ?? ''} ${entry.item.name ?? ''} ${entry.item.role ?? ''} ${entry.item.href ?? ''}`.toLowerCase()
            const score = tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0)
            return { item: entry.item, score }
          })
          .filter((x) => (tokens.length === 0 ? true : x.score > 0))
          .sort((a, b) => b.score - a.score)
          .slice(0, 15)
          .map(({ item }) => {
            const { selector: _s, ...pub } = item
            return pub
          })
        return { ok: true, query, count: matches.length, matches }
      }

      case 'page_text': {
        if (args.ref) {
          const resolved = session.elements.resolve(args.ref, ctx())
          if ('error' in resolved) return { ok: false, error: resolved.error }
          return {
            ok: true,
            ref: args.ref,
            text: resolved.item.text,
            value: resolved.item.value,
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
        return capPayload({ ok: true, url: snap.url, title: snap.title, content: snap.text })
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
          allowedOrigins: this.allowedOrigins,
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        const fromUrl = session.driver.getUrl()
        const nav = await session.driver.navigate(resolved.url)
        session.elements.invalidate()
        this.memory?.recordAction({ kind: 'navigate', selector: '', text: input, fromUrl, toUrl: nav.url, ok: true })
        this.emit({ type: 'navigated', tabId: session.driver.id, url: nav.url, title: nav.title })
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
          allowedOrigins: this.allowedOrigins,
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
              allowedOrigins: this.allowedOrigins,
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
          allowedOrigins: this.allowedOrigins,
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
              allowedOrigins: this.allowedOrigins,
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
          allowedOrigins: this.allowedOrigins,
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
              allowedOrigins: this.allowedOrigins,
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
        }
        return { ...result }
      }

      case 'page_history': {
        const dir = (args.direction as 'back' | 'forward' | 'reload') || 'reload'
        const res = await session.driver.history(dir)
        session.elements.invalidate()
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
          allowedOrigins: this.allowedOrigins,
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        const value = await session.driver.evaluate(String(args.expression ?? ''))
        return capPayload({ ok: true, value })
      }

      case 'page_act': {
        const steps = Array.isArray(args.steps) ? (args.steps as ActStep[]).slice(0, 20) : []
        const results: Array<Record<string, unknown>> = []
        const startUrl = session.driver.getUrl()
        for (const step of steps) {
          const toolName = step.op === 'read_ascii' ? 'page_read_ascii' : `page_${step.op}`
          const stepRes = await this.runTool(session.driver.id, toolName, {
            ...step,
            allowSubmit: step.allowSubmit ?? args.allowSubmit,
          })
          results.push({ op: step.op, ref: step.ref, ...stepRes })
          if (!stepRes.ok) {
            return { ok: false, stoppedAt: results.length - 1, results, error: stepRes.error }
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
