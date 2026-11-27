// Streaming SSE `/stream` hub for live ASCII frame broadcasts whenever
// the active (or watched) tab navigates or mutates.

import type http from 'node:http'
import { createHash } from 'node:crypto'
import { parseAsciiDensity, parseMaxTokens } from '../ascii/layout.js'
import { parseSessionId } from '../agent/sessions.js'
import type { AsciiDensity, TokenBudgetReport } from '../types.js'
import type { PageDelta } from '../agent/delta.js'
import type { BrowserManager } from '../engine/manager.js'

export interface SseStreamOptions {
  /** Emit `ascii_frame` events when the watched tab navigates or mutates (default: true). */
  frames: boolean
  /** Forward raw manager events (navigated, page_mutated, tab_opened, etc.) (default: true). */
  events: boolean
  /** Emit an initial `ascii_frame` immediately on connect if a tab is available (default: true). */
  initial: boolean
  /** Specific tabId to watch; undefined means follow the active tab (or session's active tab). */
  tabId?: number
  /** Optional multi-agent session scope (`x-troy-session` header or `?sessionId=`). */
  sessionId?: string
  /** ASCII viewport width (default: 100, clamped 40..240). */
  width: number
  /** Optional ASCII viewport height (clamped 10..200). */
  height?: number
  /** ASCII density profile (`compact` | `normal` | `wide`). */
  density?: AsciiDensity
  /** ASCII layout mode (`auto` | `spatial` | `flow`). */
  layout?: 'auto' | 'spatial' | 'flow'
  /** Optional token budget for auto-trimming frames. */
  maxTokens?: number
  /** Strict 7-bit ASCII output (default: true). */
  asciiOnly: boolean
  /** Include ASCII browser chrome header/footer (default: true). */
  showChrome: boolean
  /** Emit delta ASCII frames after the first full frame (default: false). */
  since: boolean
  /** Suppress consecutive identical ASCII frames (default: true). */
  dedupe: boolean
  /** Coalesce rapid consecutive triggers in ms (default: 25, 0 = immediate). */
  throttleMs: number
  /** Optional background DOM mutation polling interval in ms (default: 0 = disabled, min 100 when enabled). */
  pollMs: number
  /** SSE keep-alive heartbeat comment interval in ms (default: 15000, 0 = disabled). */
  heartbeatMs: number
}

export interface AsciiFramePayload {
  type: 'ascii_frame'
  seq: number
  ts: number
  reason: string
  tabId: number
  url: string
  title: string
  mode: 'full' | 'delta'
  refs: number
  estimatedTokens: number
  tokenBudget?: TokenBudgetReport
  delta?: PageDelta
  hash: string
  ascii: string
  sessionId?: string
}

export interface SseStreamStats {
  clients: number
  framesSent: number
  framesSkippedDuplicate: number
  eventsSent: number
}

interface SseClientState {
  res: http.ServerResponse
  options: SseStreamOptions
  closed: boolean
  seq: number
  lastHash: string | null
  lastTabId: number | null
  hasSentInitialFrame: boolean
  inFlight: boolean
  pendingTimer: ReturnType<typeof setTimeout> | null
  pendingReason: string | null
  pendingForce: boolean
  rescheduleReason: string | null
  rescheduleForce: boolean
  pollTimer: ReturnType<typeof setInterval> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

function parseBoolParam(raw: string | null, defaultValue: boolean): boolean {
  if (raw === null) return defaultValue
  const norm = raw.trim().toLowerCase()
  if (norm === '' || norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on') return true
  if (norm === '0' || norm === 'false' || norm === 'no' || norm === 'off') return false
  return defaultValue
}

function parseIntParam(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const num = Number(raw)
  if (!Number.isFinite(num)) return undefined
  return Math.max(min, Math.min(max, Math.floor(num)))
}

export function parseSseStreamOptions(
  searchParams: URLSearchParams,
  headerSessionId?: string,
): { ok: true; options: SseStreamOptions } | { ok: false; error: string } {
  let sessionId = headerSessionId
  const querySession = searchParams.get('sessionId') ?? searchParams.get('session')
  if (!sessionId && querySession !== null) {
    const parsed = parseSessionId(querySession)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    sessionId = parsed.sessionId
  }

  let tabId: number | undefined
  const rawTabId = searchParams.get('tabId') ?? searchParams.get('tab')
  if (rawTabId !== null && rawTabId.trim() !== '') {
    const parsedTab = Number(rawTabId)
    if (!Number.isInteger(parsedTab) || parsedTab <= 0) {
      return { ok: false, error: `invalid tabId "${rawTabId}"` }
    }
    tabId = parsedTab
  }

  const width = parseIntParam(searchParams.get('width'), 40, 240) ?? 100
  const height = parseIntParam(searchParams.get('height'), 10, 200)
  const density = parseAsciiDensity(searchParams.get('density') ?? undefined)
  const rawLayout = searchParams.get('layout')
  const layout =
    rawLayout === 'auto' || rawLayout === 'spatial' || rawLayout === 'flow' ? rawLayout : undefined
  const maxTokens = parseMaxTokens(searchParams.get('maxTokens') ?? searchParams.get('max_tokens') ?? undefined)

  const modeParam = (searchParams.get('mode') ?? '').trim().toLowerCase()
  let frames = parseBoolParam(searchParams.get('frames'), true)
  let events = parseBoolParam(searchParams.get('events'), true)
  let since = parseBoolParam(searchParams.get('since'), false)

  if (modeParam === 'events') {
    frames = false
    events = true
  } else if (modeParam === 'frames' || modeParam === 'ascii') {
    frames = true
    if (searchParams.get('events') === null) events = false
  } else if (modeParam === 'delta') {
    frames = true
    since = true
  }

  const throttleMs = parseIntParam(searchParams.get('throttleMs'), 0, 5000) ?? 25
  const rawPollMs = parseIntParam(searchParams.get('pollMs'), 0, 60000) ?? 0
  const pollMs = rawPollMs > 0 ? Math.max(100, rawPollMs) : 0
  const rawHeartbeatMs = parseIntParam(searchParams.get('heartbeatMs'), 0, 120000)
  const heartbeatMs =
    rawHeartbeatMs === undefined ? 15000 : rawHeartbeatMs === 0 ? 0 : Math.max(1000, rawHeartbeatMs)

  return {
    ok: true,
    options: {
      frames,
      events,
      initial: parseBoolParam(searchParams.get('initial'), true),
      tabId,
      sessionId,
      width,
      height,
      density,
      layout,
      maxTokens,
      asciiOnly: parseBoolParam(searchParams.get('asciiOnly'), true),
      showChrome: parseBoolParam(searchParams.get('showChrome'), true),
      since,
      dedupe: parseBoolParam(searchParams.get('dedupe'), true),
      throttleMs,
      pollMs,
      heartbeatMs,
    },
  }
}

export function formatSseMessage(
  payload: Record<string, unknown>,
  opts: { event?: string; id?: number | string } = {},
): string {
  const lines: string[] = []
  if (opts.id !== undefined) lines.push(`id: ${opts.id}`)
  if (opts.event) lines.push(`event: ${opts.event}`)
  lines.push(`data: ${JSON.stringify(payload)}`)
  return `${lines.join('\n')}\n\n`
}

function hashFrame(tabId: number, url: string, title: string, mode: string, ascii: string): string {
  return createHash('sha1').update(`${tabId}\0${url}\0${title}\0${mode}\0${ascii}`).digest('hex').slice(0, 16)
}

function isEmptyDelta(delta: PageDelta | undefined): boolean {
  if (!delta) return false
  return !delta.changed
}

export class SseStreamHub {
  private readonly clients = new Set<SseClientState>()
  private readonly unsubscribe: () => void
  private framesSent = 0
  private framesSkippedDuplicate = 0
  private eventsSent = 0

  constructor(private readonly manager: BrowserManager) {
    this.unsubscribe = this.manager.onEvent((ev) => this.handleManagerEvent(ev))
  }

  getStats(): SseStreamStats {
    return {
      clients: this.clients.size,
      framesSent: this.framesSent,
      framesSkippedDuplicate: this.framesSkippedDuplicate,
      eventsSent: this.eventsSent,
    }
  }

  attach(req: http.IncomingMessage, res: http.ServerResponse, options: SseStreamOptions): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const client: SseClientState = {
      res,
      options,
      closed: false,
      seq: 0,
      lastHash: null,
      lastTabId: null,
      hasSentInitialFrame: false,
      inFlight: false,
      pendingTimer: null,
      pendingReason: null,
      pendingForce: false,
      rescheduleReason: null,
      rescheduleForce: false,
      pollTimer: null,
      heartbeatTimer: null,
    }

    this.clients.add(client)

    const cleanup = () => this.detach(client)
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)

    const activeTabId = this.getWatchedTabId(client)
    this.writeRaw(
      client,
      formatSseMessage(
        {
          type: 'connected',
          engine: this.manager.engine.kind,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(activeTabId !== null ? { activeTabId } : {}),
          options: {
            frames: options.frames,
            events: options.events,
            since: options.since,
            width: options.width,
            ...(options.height !== undefined ? { height: options.height } : {}),
            ...(options.density ? { density: options.density } : {}),
            ...(options.layout ? { layout: options.layout } : {}),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
            pollMs: options.pollMs,
            throttleMs: options.throttleMs,
          },
        },
        { event: 'connected' },
      ),
    )

    if (options.heartbeatMs > 0) {
      client.heartbeatTimer = setInterval(() => {
        if (client.closed) return
        this.writeRaw(client, `: heartbeat ${Date.now()}\n\n`)
      }, options.heartbeatMs)
      client.heartbeatTimer.unref?.()
    }

    if (options.frames && options.pollMs > 0) {
      client.pollTimer = setInterval(() => {
        if (client.closed) return
        this.scheduleFrame(client, 'dom_mutation', false)
      }, options.pollMs)
      client.pollTimer.unref?.()
    }

    if (options.frames && options.initial) {
      this.scheduleFrame(client, 'initial', true, true)
    }
  }

  close(): void {
    this.unsubscribe()
    for (const client of Array.from(this.clients)) {
      this.detach(client, true)
    }
    this.clients.clear()
  }

  private detach(client: SseClientState, endResponse = false): void {
    if (client.closed) return
    client.closed = true
    if (client.pendingTimer) {
      clearTimeout(client.pendingTimer)
      client.pendingTimer = null
    }
    if (client.pollTimer) {
      clearInterval(client.pollTimer)
      client.pollTimer = null
    }
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer)
      client.heartbeatTimer = null
    }
    this.clients.delete(client)
    if (endResponse) {
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
  }

  private writeRaw(client: SseClientState, chunk: string): boolean {
    if (client.closed || client.res.writableEnded || client.res.destroyed) {
      this.detach(client)
      return false
    }
    try {
      client.res.write(chunk)
      return true
    } catch {
      this.detach(client)
      return false
    }
  }

  private getWatchedTabId(client: SseClientState): number | null {
    if (client.options.tabId !== undefined) return client.options.tabId
    return this.manager.getActiveTabId(client.options.sessionId)
  }

  private eventVisibleToClient(ev: Record<string, unknown>, client: SseClientState): boolean {
    const clientSession = client.options.sessionId
    const evSession = typeof ev.sessionId === 'string' && ev.sessionId.trim() ? ev.sessionId.trim() : undefined

    if (clientSession) {
      if (evSession && evSession !== clientSession) return false
      if (!evSession && typeof ev.tabId === 'number') {
        const ownedTabs = this.manager.listTabs({ sessionId: clientSession })
        if (!ownedTabs.some((t) => t.id === ev.tabId)) return false
      }
    }

    return true
  }

  private classifyFrameTrigger(
    ev: Record<string, unknown>,
    client: SseClientState,
  ): { trigger: boolean; reason: string; force: boolean } {
    const type = String(ev.type ?? '')
    const evTabId = typeof ev.tabId === 'number' ? ev.tabId : undefined
    const watchedTabId = this.getWatchedTabId(client)

    switch (type) {
      case 'navigated': {
        if (watchedTabId === null) return { trigger: false, reason: '', force: false }
        if (evTabId !== undefined && evTabId !== watchedTabId) return { trigger: false, reason: '', force: false }
        return { trigger: true, reason: 'navigated', force: false }
      }
      case 'page_mutated': {
        if (watchedTabId === null) return { trigger: false, reason: '', force: false }
        if (evTabId !== undefined && evTabId !== watchedTabId) return { trigger: false, reason: '', force: false }
        const subReason = typeof ev.reason === 'string' && ev.reason ? `mutated:${ev.reason}` : 'page_mutated'
        return { trigger: true, reason: subReason, force: false }
      }
      case 'tab_opened': {
        if (watchedTabId === null) return { trigger: false, reason: '', force: false }
        if (evTabId !== undefined && evTabId !== watchedTabId) return { trigger: false, reason: '', force: false }
        return { trigger: true, reason: 'tab_opened', force: false }
      }
      case 'tab_activated': {
        if (client.options.tabId !== undefined && evTabId !== client.options.tabId) {
          return { trigger: false, reason: '', force: false }
        }
        return { trigger: true, reason: 'tab_activated', force: true }
      }
      case 'tab_closed': {
        if (client.options.tabId !== undefined && evTabId === client.options.tabId) {
          return { trigger: false, reason: '', force: false }
        }
        if (watchedTabId !== null && watchedTabId !== client.lastTabId) {
          return { trigger: true, reason: 'tab_switched', force: true }
        }
        return { trigger: false, reason: '', force: false }
      }
      case 'emulation_updated': {
        if (watchedTabId === null) return { trigger: false, reason: '', force: false }
        if (!ev.allTabs && evTabId !== undefined && evTabId !== watchedTabId) {
          return { trigger: false, reason: '', force: false }
        }
        return { trigger: true, reason: 'emulation_updated', force: false }
      }
      default:
        return { trigger: false, reason: '', force: false }
    }
  }

  private handleManagerEvent(ev: Record<string, unknown>): void {
    const evType = typeof ev.type === 'string' && ev.type ? ev.type : undefined
    for (const client of Array.from(this.clients)) {
      if (client.closed) continue
      if (!this.eventVisibleToClient(ev, client)) continue

      if (client.options.events) {
        if (this.writeRaw(client, formatSseMessage(ev, { event: evType }))) {
          this.eventsSent++
        }
      }

      if (client.options.frames) {
        const decision = this.classifyFrameTrigger(ev, client)
        if (decision.trigger) {
          this.scheduleFrame(client, decision.reason, decision.force)
        }
      }
    }
  }

  private scheduleFrame(
    client: SseClientState,
    reason: string,
    force: boolean,
    immediate = false,
  ): void {
    if (client.closed) return

    if (client.inFlight) {
      client.rescheduleReason = reason
      client.rescheduleForce = client.rescheduleForce || force
      return
    }

    client.pendingReason = reason
    client.pendingForce = client.pendingForce || force

    if (immediate || client.options.throttleMs <= 0) {
      if (client.pendingTimer) {
        clearTimeout(client.pendingTimer)
        client.pendingTimer = null
      }
      const nextReason = client.pendingReason ?? reason
      const nextForce = client.pendingForce
      client.pendingReason = null
      client.pendingForce = false
      void this.flushFrame(client, nextReason, nextForce)
      return
    }

    if (client.pendingTimer) {
      clearTimeout(client.pendingTimer)
    }
    client.pendingTimer = setTimeout(() => {
      client.pendingTimer = null
      if (client.closed) return
      const nextReason = client.pendingReason ?? reason
      const nextForce = client.pendingForce
      client.pendingReason = null
      client.pendingForce = false
      void this.flushFrame(client, nextReason, nextForce)
    }, client.options.throttleMs)
  }

  private async flushFrame(client: SseClientState, reason: string, force: boolean): Promise<void> {
    if (client.closed) return
    const targetTabId = this.getWatchedTabId(client)
    if (targetTabId === null) return

    client.inFlight = true
    try {
      const useSince =
        client.options.since && client.hasSentInitialFrame && client.lastTabId === targetTabId && !force
      const res = await this.manager.renderAscii(targetTabId, {
        width: client.options.width,
        height: client.options.height,
        density: client.options.density,
        layout: client.options.layout,
        maxTokens: client.options.maxTokens,
        asciiOnly: client.options.asciiOnly,
        showChrome: client.options.showChrome,
        since: useSince,
        sessionId: client.options.sessionId,
      })

      if (client.closed || !res.ok || !res.ascii || !res.snapshot) {
        return
      }

      const mode: 'full' | 'delta' = res.mode ?? 'full'
      if (mode === 'delta' && client.options.dedupe && !force && isEmptyDelta(res.delta)) {
        this.framesSkippedDuplicate++
        return
      }

      const url = res.snapshot.url
      const title = res.snapshot.title
      const hash = hashFrame(targetTabId, url, title, mode, res.ascii)

      if (client.options.dedupe && !force && hash === client.lastHash && targetTabId === client.lastTabId) {
        this.framesSkippedDuplicate++
        return
      }

      client.lastHash = hash
      client.lastTabId = targetTabId
      client.hasSentInitialFrame = true
      client.seq += 1

      const payload: AsciiFramePayload = {
        type: 'ascii_frame',
        seq: client.seq,
        ts: Date.now(),
        reason,
        tabId: targetTabId,
        url,
        title,
        mode,
        refs: res.snapshot.elements.length,
        estimatedTokens: res.estimatedTokens ?? 0,
        ...(res.tokenBudget ? { tokenBudget: res.tokenBudget } : {}),
        ...(res.delta ? { delta: res.delta } : {}),
        hash,
        ascii: res.ascii,
        ...(client.options.sessionId ? { sessionId: client.options.sessionId } : {}),
      }

      if (
        this.writeRaw(
          client,
          formatSseMessage(payload as unknown as Record<string, unknown>, {
            event: 'ascii_frame',
            id: client.seq,
          }),
        )
      ) {
        this.framesSent++
      }
    } catch {
      // Tab may have closed mid-render; ignore transient render errors
    } finally {
      client.inFlight = false
      if (!client.closed && client.rescheduleReason) {
        const nextReason = client.rescheduleReason
        const nextForce = client.rescheduleForce
        client.rescheduleReason = null
        client.rescheduleForce = false
        this.scheduleFrame(client, nextReason, nextForce)
      }
    }
  }
}
