// BrowserManager: orchestrates tabs, engine selection (Chromium or Lite),
// per-tab ElementRegistry, deterministic Policy enforcement, PageMemory,
// Delta reads, and ASCII / Pixel-ASCII rendering.

import path from 'node:path'
import os from 'node:os'
import type { ActStep, AsciiRenderOptions, EngineKind, PageSnapshot, PixelAsciiOptions, TabSummary } from '../types.js'
import { ElementRegistry } from '../agent/elements.js'
import { PageMemory } from '../agent/memory.js'
import { exactOrigin, normalizeOrigin, resolveInput } from '../agent/omnibox.js'
import { authorizeAction } from '../agent/policy.js'
import { computePageDelta } from '../agent/delta.js'
import { renderCompactRefsAscii, renderPageAscii } from '../ascii/layout.js'
import { renderPngToAscii } from '../ascii/pixels.js'
import { ChromiumBrowserEngine, findChromeBinary } from './chromium.js'
import { LiteBrowserEngine } from './lite.js'
import type { BrowserEngine, TabDriver } from './types.js'

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
  memoryEnabled?: boolean
  chromeBin?: string
}

export class BrowserManager {
  readonly engine: BrowserEngine
  readonly profileDir: string
  readonly memory: PageMemory | null
  private tabs = new Map<number, TabSession>()
  private activeTabId: number | null = null
  private allowedOrigins = new Set<string>()
  private eventListeners = new Set<(event: Record<string, unknown>) => void>()

  private constructor(engine: BrowserEngine, profileDir: string, memory: PageMemory | null) {
    this.engine = engine
    this.profileDir = profileDir
    this.memory = memory
  }

  static async create(opts: BrowserManagerOptions = {}): Promise<BrowserManager> {
    const profileDir =
      opts.profileDir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'troy-advanced', 'profile')

    let engine: BrowserEngine
    const requested = opts.engine ?? 'auto'
    if (requested === 'lite') {
      engine = new LiteBrowserEngine()
    } else if (requested === 'chromium') {
      engine = await ChromiumBrowserEngine.launch({
        chromeBin: opts.chromeBin,
        cdpPort: opts.cdpPort,
        remoteCdpPort: opts.remoteCdpPort,
        profileDir: path.join(profileDir, 'chrome-data'),
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
          })
        } catch {
          engine = new LiteBrowserEngine()
        }
      } else {
        engine = new LiteBrowserEngine()
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
    const blocks = snap.blocks.map((b) => {
      let next = b
      if (b.links && b.links.length > 0) {
        const boundLinks = b.links.map((lnk) => {
          if (lnk.ref) return lnk
          if (lnk.selector && refBySelector.has(lnk.selector)) {
            return { ...lnk, ref: refBySelector.get(lnk.selector) }
          }
          const match = registered.find(
            (e) => e.tag === 'a' && e.text === lnk.text && (!lnk.href || e.href === lnk.href),
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
          if (next.kind === 'link') return e.tag === 'a' && e.text === next.text && (!next.href || e.href === next.href)
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

  async renderAscii(tabId?: number, opts: AsciiRenderOptions = {}): Promise<{ ok: boolean; ascii?: string; snapshot?: PageSnapshot; error?: string }> {
    const session = this.resolveSession(tabId)
    if (!session) return { ok: false, error: 'no open tab' }
    const snap = await this.takeIndexedSnapshot(session)
    session.lastSnapshot = snap
    const ascii = renderPageAscii(snap, {
      ...opts,
      tabs: this.listTabs(),
      activeTabId: this.activeTabId ?? snap.tabId,
    })
    return { ok: true, ascii, snapshot: snap }
  }

  async runTool(tabId: number | undefined, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const session = this.resolveSession(tabId)
    if (!session) return { ok: false, error: 'no such tab', code: 'no-tab' }
    this.refreshOrigins()
    const ctx = () => ({ tabId: session.driver.id, url: session.driver.getUrl(), epoch: session.driver.getEpoch() })

    switch (name) {
      case 'page_read':
      case 'page_read_visual':
      case 'page_read_ascii': {
        const prev = session.lastSnapshot
        const snap = await this.takeIndexedSnapshot(session)
        session.lastSnapshot = snap

        if (args.since && prev) {
          const delta = computePageDelta(prev, snap)
          return capPayload({ ok: true, mode: 'delta', ...delta })
        }

        const layoutOpt =
          args.layout === 'spatial' || args.layout === 'auto' || args.layout === 'flow' ? args.layout : undefined
        const ascii = renderPageAscii(snap, {
          width: typeof args.width === 'number' ? args.width : 100,
          height: typeof args.height === 'number' ? args.height : 36,
          asciiOnly: args.asciiOnly !== false,
          color: Boolean(args.color),
          showChrome: args.showChrome !== false,
          layout: layoutOpt,
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
              overlays,
              viewport: snap.viewport,
            })
          }
        }

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
          ...(pixelAscii ? { pixelAscii } : {}),
          content: name === 'page_read_ascii' ? ascii : snap.text,
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
          return { ok: true, ref: args.ref, text: resolved.item.text, value: resolved.item.value }
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
        const resolved = session.elements.resolve(args.ref, ctx())
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
        const result = await session.driver.click(resolved.selector)
        const toUrl = session.driver.getUrl()
        this.memory?.recordAction({
          kind: 'click',
          selector: resolved.selector,
          text: resolved.item.text,
          fromUrl,
          toUrl,
          ok: result.ok,
        })
        return { ...result, url: toUrl, title: session.driver.getTitle() }
      }

      case 'page_fill': {
        const resolved = session.elements.resolve(args.ref, ctx())
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
        const result = await session.driver.fill(resolved.selector, text, clear)
        this.memory?.recordAction({
          kind: 'fill',
          selector: resolved.selector,
          text: resolved.item.text,
          fromUrl: session.driver.getUrl(),
          toUrl: session.driver.getUrl(),
          ok: result.ok,
        })
        return { ...result, ref: args.ref }
      }

      case 'page_select': {
        const resolved = session.elements.resolve(args.ref, ctx())
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const decision = authorizeAction({
          name: 'page_select',
          item: resolved.item,
          allowedOrigins: this.allowedOrigins,
        })
        if (!decision.allowed) {
          return { ok: false, ...decision, error: decision.reason }
        }
        const result = await session.driver.select(resolved.selector, String(args.value ?? ''))
        return { ...result, ref: args.ref }
      }

      case 'page_press': {
        let selector: string | undefined
        if (args.ref) {
          const resolved = session.elements.resolve(args.ref, ctx())
          if ('error' in resolved) return { ok: false, error: resolved.error }
          selector = resolved.selector
        }
        const result = await session.driver.press(String(args.key ?? 'Enter'), selector)
        return { ...result, key: args.key }
      }

      case 'page_hover': {
        const resolved = session.elements.resolve(args.ref, ctx())
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const result = await session.driver.hover(resolved.selector)
        return { ...result, ref: args.ref }
      }

      case 'page_scroll': {
        const dir = (args.direction as 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom') || 'down'
        const amount = typeof args.amount === 'number' ? args.amount : 450
        const pos = await session.driver.scroll(dir, amount)
        return { ok: true, direction: dir, ...pos }
      }

      case 'page_wait': {
        const ms = Math.max(0, Math.min(30000, Number(args.ms ?? 300)))
        await new Promise((r) => setTimeout(r, ms))
        return { ok: true, waitedMs: ms }
      }

      case 'page_history': {
        const dir = (args.direction as 'back' | 'forward' | 'reload') || 'reload'
        const res = await session.driver.history(dir)
        session.elements.invalidate()
        return { ok: true, direction: dir, ...res }
      }

      case 'page_screenshot':
      case 'page_screenshot_ascii': {
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
            overlays,
            viewport: snap.viewport,
          })
          return { ok: true, ascii, bytes: png.length }
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
        const entries = session.driver.getNetwork({
          clear: Boolean(args.clear),
          failedOnly: Boolean(args.failedOnly),
          limit: typeof args.limit === 'number' ? args.limit : 50,
        })
        return { ok: true, count: entries.length, entries }
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

      default:
        return { ok: false, error: `unknown tool: ${name}` }
    }
  }

  async close(): Promise<void> {
    for (const s of this.tabs.values()) {
      await s.driver.close().catch(() => {})
    }
    this.tabs.clear()
    this.memory?.flush()
    await this.engine.close()
  }
}
