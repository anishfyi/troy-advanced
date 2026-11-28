// RFC 6455 zero-dependency WebSocket bridge (`/ws`) on Agent Socket
// for ultra-low-latency bidirectional AI control, pipelined requests,
// batch execution, and real-time event + ASCII frame streaming.

import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { parseAsciiDensity, parseMaxTokens } from '../ascii/layout.js'
import { parseSessionId, SESSION_HEADER } from '../agent/sessions.js'
import type { AsciiDensity } from '../types.js'
import type { BrowserManager } from '../engine/manager.js'
import type { AsciiFramePayload } from './sse-stream.js'
import { validateAgentRequestHeaders } from './host-guard.js'
import { validateAgentTokenRequest } from './auth.js'

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024

export const WS_OPCODE_CONTINUATION = 0x0
export const WS_OPCODE_TEXT = 0x1
export const WS_OPCODE_BINARY = 0x2
export const WS_OPCODE_CLOSE = 0x8
export const WS_OPCODE_PING = 0x9
export const WS_OPCODE_PONG = 0xa

export type AgentRouteHandler = (
  pathname: string,
  body: Record<string, unknown>,
  headerSessionId?: string,
) => Promise<{ status: number; payload: Record<string, unknown> }>

export interface WsSubscribeOptions {
  /** Forward raw manager events (default: true). */
  events: boolean
  /** Emit `ascii_frame` messages when watched tab navigates/mutates (default: true). */
  frames: boolean
  /** Emit an initial `ascii_frame` right after subscribing (default: true). */
  initial: boolean
  /** Optional specific tabId to watch; undefined follows active tab. */
  tabId?: number
  /** ASCII viewport width (default: 100, clamped 40..240). */
  width: number
  /** Optional ASCII viewport height (clamped 10..200). */
  height?: number
  /** ASCII density profile. */
  density?: AsciiDensity
  /** ASCII layout mode. */
  layout?: 'auto' | 'spatial' | 'flow'
  /** Optional token budget for auto-trimming frames. */
  maxTokens?: number
  /** Strict 7-bit ASCII output (default: true). */
  asciiOnly: boolean
  /** Include ASCII browser chrome (default: true). */
  showChrome: boolean
  /** Emit delta ASCII frames after the first full frame (default: false). */
  since: boolean
  /** Suppress consecutive identical frames (default: true). */
  dedupe: boolean
  /** Coalesce rapid triggers in ms (default: 25). */
  throttleMs: number
}

export interface WsBridgeStats {
  clients: number
  subscribedClients: number
  requestsHandled: number
  messagesSent: number
  framesSent: number
  framesSkippedDuplicate: number
  eventsSent: number
}

export interface WsHelloMessage {
  type: 'hello'
  protocol: 'troy-ws-v1'
  engine: string
  tabs: number
  sessionId?: string
  ts: number
}

export interface WsResponseMessage {
  type: 'response'
  id: string | number | null
  status: number
  ok: boolean
  result?: Record<string, unknown>
  results?: Array<{ status: number; ok: boolean; result?: Record<string, unknown>; error?: string }>
  error?: string
  durationMs: number
}

export interface WsPongMessage {
  type: 'pong'
  id: string | number | null
  ts: number
}

export interface WsEventMessage {
  type: 'event'
  event: string
  data: Record<string, unknown>
  ts: number
}

export type WsServerMessage = WsHelloMessage | WsResponseMessage | WsPongMessage | WsEventMessage | AsciiFramePayload

const OP_TO_ROUTE: Record<string, string> = {
  health: '/health',
  tabs: '/tabs',
  open: '/open',
  activate: '/activate',
  close: '/close',
  grant: '/grant-origin',
  'grant-origin': '/grant-origin',
  ascii: '/ascii',
  markdown: '/markdown',
  extract: '/extract',
  tool: '/tool',
  recall: '/recall',
  forget: '/forget',
  memory: '/memory',
  sessions: '/sessions',
  emulation: '/emulation',
  downloads: '/downloads',
  dialogs: '/dialogs',
  audit: '/audit',
}

export function computeWebSocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WS_MAGIC_GUID}`).digest('base64')
}

export function encodeWsFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const len = data.length
  let header: Buffer

  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = len
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }

  return Buffer.concat([header, data])
}

export function encodeWsClose(code = 1000, reason = ''): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  return encodeWsFrame(WS_OPCODE_CLOSE, payload)
}

function writeHttpRejection(socket: Duplex, status: number, statusText: string, error: string): void {
  const body = JSON.stringify({ ok: false, error })
  const resp =
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n` +
    body
  try {
    socket.end(resp, () => {
      socket.destroy()
    })
  } catch {
    socket.destroy()
  }
}

function clampInt(val: unknown, min: number, max: number): number | undefined {
  if (val === undefined || val === null || val === '') return undefined
  const n = Number(val)
  if (!Number.isFinite(n)) return undefined
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function parseBool(val: unknown, fallback: boolean): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'string') {
    const norm = val.trim().toLowerCase()
    if (norm === '' || norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on') return true
    if (norm === '0' || norm === 'false' || norm === 'no' || norm === 'off') return false
  }
  return fallback
}

function parseSubscribeOptions(input: Record<string, unknown>): WsSubscribeOptions {
  const layoutRaw = typeof input.layout === 'string' ? input.layout.trim().toLowerCase() : ''
  const layout = layoutRaw === 'auto' || layoutRaw === 'spatial' || layoutRaw === 'flow' ? layoutRaw : undefined
  const tabId = clampInt(input.tabId ?? input.tab, 1, Number.MAX_SAFE_INTEGER)

  return {
    events: parseBool(input.events, true),
    frames: parseBool(input.frames, true),
    initial: parseBool(input.initial, true),
    tabId,
    width: clampInt(input.width, 40, 240) ?? 100,
    height: clampInt(input.height, 10, 200),
    density: parseAsciiDensity(input.density),
    layout,
    maxTokens: parseMaxTokens(input.maxTokens ?? input.max_tokens),
    asciiOnly: parseBool(input.asciiOnly ?? input.ascii_only, true),
    showChrome: parseBool(input.showChrome ?? input.chrome, true),
    since: parseBool(input.since, false),
    dedupe: parseBool(input.dedupe, true),
    throttleMs: clampInt(input.throttleMs ?? input.throttle, 0, 10_000) ?? 25,
  }
}

function hashAscii(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

interface WsClientState {
  socket: Duplex
  sessionId?: string
  closed: boolean
  recvBuffer: Buffer
  fragmentOpcode: number | null
  fragmentChunks: Buffer[]
  fragmentSize: number
  subscription: WsSubscribeOptions | null
  frameSeq: number
  lastFrameHash: string | null
  lastFrameTabId: number | null
  hasSentInitialFrame: boolean
  frameInFlight: boolean
  pendingTimer: ReturnType<typeof setTimeout> | null
  pendingReason: string | null
  pendingForce: boolean
  rescheduleReason: string | null
  rescheduleForce: boolean
}

export class WsBridgeHub {
  private readonly manager: BrowserManager
  private readonly handleRoute: AgentRouteHandler
  private readonly token: string
  private readonly getExpectedPort?: () => number | undefined
  private readonly strictPort: boolean
  private readonly clients = new Set<WsClientState>()
  private offManagerEvent: (() => void) | null = null
  private requestsHandled = 0
  private messagesSent = 0
  private framesSent = 0
  private framesSkippedDuplicate = 0
  private eventsSent = 0

  constructor(
    manager: BrowserManager,
    handleRoute: AgentRouteHandler,
    opts: { token: string; getExpectedPort?: () => number | undefined; strictPort?: boolean },
  ) {
    this.manager = manager
    this.handleRoute = handleRoute
    this.token = opts.token
    this.getExpectedPort = opts.getExpectedPort
    this.strictPort = Boolean(opts.strictPort)
  }

  getStats(): WsBridgeStats {
    let subscribedClients = 0
    for (const client of this.clients) {
      if (!client.closed && client.subscription) subscribedClients++
    }
    return {
      clients: this.clients.size,
      subscribedClients,
      requestsHandled: this.requestsHandled,
      messagesSent: this.messagesSent,
      framesSent: this.framesSent,
      framesSkippedDuplicate: this.framesSkippedDuplicate,
      eventsSent: this.eventsSent,
    }
  }

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const headerCheck = validateAgentRequestHeaders(req, {
      expectedPort: this.getExpectedPort?.(),
      strictPort: this.strictPort,
    })
    if (!headerCheck.ok) {
      writeHttpRejection(socket, headerCheck.status ?? 403, 'Forbidden', headerCheck.error ?? 'wrong host')
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws') {
      writeHttpRejection(socket, 404, 'Not Found', `no websocket route ${url.pathname}`)
      return
    }

    if (req.method !== 'GET') {
      writeHttpRejection(socket, 405, 'Method Not Allowed', 'GET upgrade required')
      return
    }

    const queryToken = url.searchParams.get('token')
    const authCheck = validateAgentTokenRequest(req, this.token, { queryToken })
    if (!authCheck.ok) {
      writeHttpRejection(socket, 401, 'Unauthorized', authCheck.error ?? 'missing or invalid x-troy-agent token')
      return
    }

    const rawSession = req.headers[SESSION_HEADER] ?? url.searchParams.get('sessionId') ?? url.searchParams.get('session') ?? undefined
    const parsedSession = parseSessionId(rawSession)
    if (!parsedSession.ok) {
      writeHttpRejection(socket, 400, 'Bad Request', parsedSession.error)
      return
    }

    const upgradeHeader = String(req.headers.upgrade ?? '').toLowerCase()
    const wsVersion = String(req.headers['sec-websocket-version'] ?? '')
    const wsKey = String(req.headers['sec-websocket-key'] ?? '').trim()
    if (upgradeHeader !== 'websocket' || wsVersion !== '13' || !wsKey) {
      writeHttpRejection(socket, 400, 'Bad Request', 'invalid websocket upgrade headers')
      return
    }

    const accept = computeWebSocketAccept(wsKey)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    if ('setNoDelay' in socket && typeof (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay === 'function') {
      ;(socket as { setNoDelay: (v: boolean) => void }).setNoDelay(true)
    }

    const client: WsClientState = {
      socket,
      sessionId: parsedSession.sessionId,
      closed: false,
      recvBuffer: Buffer.alloc(0),
      fragmentOpcode: null,
      fragmentChunks: [],
      fragmentSize: 0,
      subscription: null,
      frameSeq: 0,
      lastFrameHash: null,
      lastFrameTabId: null,
      hasSentInitialFrame: false,
      frameInFlight: false,
      pendingTimer: null,
      pendingReason: null,
      pendingForce: false,
      rescheduleReason: null,
      rescheduleForce: false,
    }

    this.clients.add(client)
    this.ensureManagerListener()

    socket.on('data', (chunk: Buffer) => this.onSocketData(client, chunk))
    socket.on('close', () => this.cleanupClient(client))
    socket.on('end', () => this.cleanupClient(client))
    socket.on('error', () => this.cleanupClient(client))

    const hello: WsHelloMessage = {
      type: 'hello',
      protocol: 'troy-ws-v1',
      engine: this.manager.engine.kind,
      tabs: this.manager.listTabs({ sessionId: client.sessionId }).length,
      ...(client.sessionId ? { sessionId: client.sessionId } : {}),
      ts: Date.now(),
    }
    this.sendJson(client, hello)

    // Optional query-string auto-subscribe (?subscribe=1&frames=1&width=80)
    if (parseBool(url.searchParams.get('subscribe'), false)) {
      const subInput: Record<string, unknown> = {}
      for (const [k, v] of url.searchParams.entries()) {
        subInput[k] = v
      }
      client.subscription = parseSubscribeOptions(subInput)
      if (client.subscription.frames && client.subscription.initial) {
        this.scheduleFrame(client, 'initial', true)
      }
    }

    if (head && head.length > 0) {
      this.onSocketData(client, head)
    }
  }

  close(): void {
    for (const client of Array.from(this.clients)) {
      this.closeClient(client, 1001, 'server shutting down')
    }
    this.clients.clear()
    if (this.offManagerEvent) {
      this.offManagerEvent()
      this.offManagerEvent = null
    }
  }

  private ensureManagerListener(): void {
    if (this.offManagerEvent) return
    this.offManagerEvent = this.manager.onEvent((ev) => {
      this.onManagerEvent(ev)
    })
  }

  private cleanupClient(client: WsClientState): void {
    if (client.closed) return
    client.closed = true
    if (client.pendingTimer) {
      clearTimeout(client.pendingTimer)
      client.pendingTimer = null
    }
    this.clients.delete(client)
    if (this.clients.size === 0 && this.offManagerEvent) {
      this.offManagerEvent()
      this.offManagerEvent = null
    }
  }

  private closeClient(client: WsClientState, code = 1000, reason = ''): void {
    if (client.closed) return
    try {
      client.socket.write(encodeWsClose(code, reason))
      client.socket.end(() => {
        client.socket.destroy()
      })
    } catch {
      client.socket.destroy()
    }
    this.cleanupClient(client)
  }

  private sendJson(client: WsClientState, payload: WsServerMessage): void {
    if (client.closed || client.socket.destroyed) return
    try {
      client.socket.write(encodeWsFrame(WS_OPCODE_TEXT, JSON.stringify(payload)))
      this.messagesSent++
    } catch {
      this.cleanupClient(client)
    }
  }

  private onSocketData(client: WsClientState, chunk: Buffer): void {
    if (client.closed || chunk.length === 0) return
    client.recvBuffer = client.recvBuffer.length > 0 ? Buffer.concat([client.recvBuffer, chunk]) : chunk

    while (!client.closed && client.recvBuffer.length >= 2) {
      const b0 = client.recvBuffer[0]!
      const b1 = client.recvBuffer[1]!
      const fin = (b0 & 0x80) !== 0
      const rsv = b0 & 0x70
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0

      if (rsv !== 0) {
        this.closeClient(client, 1002, 'non-zero RSV bits')
        return
      }
      if (!masked) {
        this.closeClient(client, 1002, 'client frames must be masked')
        return
      }

      let payloadLen = b1 & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (client.recvBuffer.length < 4) return
        payloadLen = client.recvBuffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (client.recvBuffer.length < 10) return
        const hi = client.recvBuffer.readUInt32BE(2)
        const lo = client.recvBuffer.readUInt32BE(6)
        payloadLen = hi * 0x100000000 + lo
        offset = 10
      }

      if (payloadLen > MAX_WS_MESSAGE_BYTES) {
        this.closeClient(client, 1009, 'message too large')
        return
      }

      const isControl = opcode >= 0x8
      if (isControl && (!fin || payloadLen > 125)) {
        this.closeClient(client, 1002, 'invalid control frame')
        return
      }

      const totalLen = offset + 4 + payloadLen
      if (client.recvBuffer.length < totalLen) return

      const mask0 = client.recvBuffer[offset]!
      const mask1 = client.recvBuffer[offset + 1]!
      const mask2 = client.recvBuffer[offset + 2]!
      const mask3 = client.recvBuffer[offset + 3]!
      const payloadStart = offset + 4

      const payload = Buffer.allocUnsafe(payloadLen)
      for (let i = 0; i < payloadLen; i++) {
        const m = (i & 3) === 0 ? mask0 : (i & 3) === 1 ? mask1 : (i & 3) === 2 ? mask2 : mask3
        payload[i] = client.recvBuffer[payloadStart + i]! ^ m
      }

      client.recvBuffer = client.recvBuffer.subarray(totalLen)

      if (opcode === WS_OPCODE_CLOSE) {
        this.closeClient(client, 1000, '')
        return
      }
      if (opcode === WS_OPCODE_PING) {
        try {
          client.socket.write(encodeWsFrame(WS_OPCODE_PONG, payload))
        } catch {
          this.cleanupClient(client)
        }
        continue
      }
      if (opcode === WS_OPCODE_PONG) {
        continue
      }

      if (opcode === WS_OPCODE_TEXT || opcode === WS_OPCODE_BINARY) {
        if (client.fragmentOpcode !== null) {
          this.closeClient(client, 1002, 'interleaved data frame during fragmentation')
          return
        }
        if (fin) {
          void this.handleClientMessage(client, payload.toString('utf8'))
        } else {
          client.fragmentOpcode = opcode
          client.fragmentChunks = [payload]
          client.fragmentSize = payload.length
        }
        continue
      }

      if (opcode === WS_OPCODE_CONTINUATION) {
        if (client.fragmentOpcode === null) {
          this.closeClient(client, 1002, 'unexpected continuation frame')
          return
        }
        client.fragmentSize += payload.length
        if (client.fragmentSize > MAX_WS_MESSAGE_BYTES) {
          this.closeClient(client, 1009, 'fragmented message too large')
          return
        }
        client.fragmentChunks.push(payload)
        if (fin) {
          const full = Buffer.concat(client.fragmentChunks)
          client.fragmentOpcode = null
          client.fragmentChunks = []
          client.fragmentSize = 0
          void this.handleClientMessage(client, full.toString('utf8'))
        }
        continue
      }

      this.closeClient(client, 1002, `unsupported opcode 0x${opcode.toString(16)}`)
      return
    }
  }

  private async dispatchSingle(
    client: WsClientState,
    msg: Record<string, unknown>,
  ): Promise<{ status: number; ok: boolean; result?: Record<string, unknown>; error?: string }> {
    const op = typeof msg.op === 'string' ? msg.op.trim().toLowerCase() : undefined
    const route = typeof msg.route === 'string' ? msg.route.trim() : undefined

    // Shorthand: { tool: "page_read", args: {...}, tabId?: 1 }
    if (typeof msg.tool === 'string' && msg.tool.trim()) {
      const body: Record<string, unknown> = {
        name: msg.tool.trim(),
        ...(msg.tabId !== undefined ? { tabId: msg.tabId } : {}),
        ...(typeof msg.args === 'object' && msg.args !== null ? { args: msg.args } : { args: {} }),
        ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
      }
      const res = await this.handleRoute('/tool', body, client.sessionId)
      const ok = res.status >= 200 && res.status < 300 && res.payload.ok !== false
      return {
        status: res.status,
        ok,
        result: res.payload,
        ...(!ok && typeof res.payload.error === 'string' ? { error: res.payload.error } : {}),
      }
    }

    let targetRoute: string | undefined
    if (route) {
      targetRoute = route.startsWith('/') ? route : `/${route}`
    } else if (op && OP_TO_ROUTE[op]) {
      targetRoute = OP_TO_ROUTE[op]
    }

    if (!targetRoute) {
      return {
        status: 400,
        ok: false,
        error: 'request must specify "op", "route", or "tool"',
      }
    }

    let body: Record<string, unknown>
    if (typeof msg.body === 'object' && msg.body !== null && !Array.isArray(msg.body)) {
      body = msg.body as Record<string, unknown>
    } else {
      body = {}
      for (const [k, v] of Object.entries(msg)) {
        if (k === 'id' || k === 'op' || k === 'route' || k === 'type') continue
        body[k] = v
      }
    }

    const res = await this.handleRoute(targetRoute, body, client.sessionId)
    const ok = res.status >= 200 && res.status < 300 && res.payload.ok !== false
    return {
      status: res.status,
      ok,
      result: res.payload,
      ...(!ok && typeof res.payload.error === 'string' ? { error: res.payload.error } : {}),
    }
  }

  private async handleClientMessage(client: WsClientState, rawText: string): Promise<void> {
    const started = Date.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      this.sendJson(client, {
        type: 'response',
        id: null,
        status: 400,
        ok: false,
        error: 'message must be valid JSON',
        durationMs: Date.now() - started,
      })
      return
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.sendJson(client, {
        type: 'response',
        id: null,
        status: 400,
        ok: false,
        error: 'message must be a JSON object',
        durationMs: Date.now() - started,
      })
      return
    }

    const msg = parsed as Record<string, unknown>
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
    const op = typeof msg.op === 'string' ? msg.op.trim().toLowerCase() : typeof msg.type === 'string' ? msg.type.trim().toLowerCase() : undefined

    this.requestsHandled++

    if (op === 'ping') {
      this.sendJson(client, { type: 'pong', id, ts: Date.now() })
      return
    }

    if (op === 'subscribe') {
      const opts = parseSubscribeOptions(msg)
      client.subscription = opts
      client.lastFrameHash = null
      client.hasSentInitialFrame = false
      this.sendJson(client, {
        type: 'response',
        id,
        status: 200,
        ok: true,
        result: {
          ok: true,
          subscribed: true,
          options: opts,
        },
        durationMs: Date.now() - started,
      })
      if (opts.frames && opts.initial) {
        this.scheduleFrame(client, 'initial', true)
      }
      return
    }

    if (op === 'unsubscribe') {
      client.subscription = null
      if (client.pendingTimer) {
        clearTimeout(client.pendingTimer)
        client.pendingTimer = null
      }
      this.sendJson(client, {
        type: 'response',
        id,
        status: 200,
        ok: true,
        result: { ok: true, subscribed: false },
        durationMs: Date.now() - started,
      })
      return
    }

    if (op === 'batch') {
      if (!Array.isArray(msg.steps)) {
        this.sendJson(client, {
          type: 'response',
          id,
          status: 400,
          ok: false,
          error: 'batch requires a "steps" array',
          durationMs: Date.now() - started,
        })
        return
      }
      const stopOnError = parseBool(msg.stopOnError, false)
      const results: Array<{ status: number; ok: boolean; result?: Record<string, unknown>; error?: string }> = []
      let allOk = true
      for (const rawStep of msg.steps) {
        if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) {
          const errStep = { status: 400, ok: false, error: 'batch step must be a JSON object' }
          results.push(errStep)
          allOk = false
          if (stopOnError) break
          continue
        }
        try {
          const stepRes = await this.dispatchSingle(client, rawStep as Record<string, unknown>)
          results.push(stepRes)
          if (!stepRes.ok) {
            allOk = false
            if (stopOnError) break
          }
        } catch (err) {
          results.push({ status: 500, ok: false, error: String((err as Error)?.message ?? err) })
          allOk = false
          if (stopOnError) break
        }
      }
      this.sendJson(client, {
        type: 'response',
        id,
        status: 200,
        ok: allOk,
        results,
        durationMs: Date.now() - started,
      })
      return
    }

    try {
      const res = await this.dispatchSingle(client, msg)
      this.sendJson(client, {
        type: 'response',
        id,
        status: res.status,
        ok: res.ok,
        ...(res.result ? { result: res.result } : {}),
        ...(res.error ? { error: res.error } : {}),
        durationMs: Date.now() - started,
      })
    } catch (err) {
      this.sendJson(client, {
        type: 'response',
        id,
        status: 500,
        ok: false,
        error: String((err as Error)?.message ?? err),
        durationMs: Date.now() - started,
      })
    }
  }

  private resolveTargetTabId(client: WsClientState): number | undefined {
    const sub = client.subscription
    if (!sub) return undefined
    const visibleTabs = this.manager.listTabs({ sessionId: client.sessionId })
    if (visibleTabs.length === 0) return undefined
    if (sub.tabId !== undefined) {
      const match = visibleTabs.find((t) => t.id === sub.tabId)
      return match ? match.id : undefined
    }
    const active = visibleTabs.find((t) => t.active) ?? visibleTabs[0]
    return active?.id
  }

  private isEventRelevantToClient(client: WsClientState, ev: Record<string, unknown>): boolean {
    const sub = client.subscription
    if (!sub) return false
    const evType = typeof ev.type === 'string' ? ev.type : ''
    const evTabId = typeof ev.tabId === 'number' ? ev.tabId : undefined
    if (sub.tabId !== undefined && evTabId !== undefined && evTabId !== sub.tabId) {
      return false
    }
    if (client.sessionId) {
      const evSession = typeof ev.sessionId === 'string' && ev.sessionId.trim() ? ev.sessionId.trim() : undefined
      if (evSession && evSession !== client.sessionId) return false
      if (!evSession && evTabId !== undefined && evType !== 'tab_closed') {
        const visible = this.manager.listTabs({ sessionId: client.sessionId })
        if (!visible.some((t) => t.id === evTabId)) return false
      }
    }
    return true
  }

  private onManagerEvent(ev: Record<string, unknown>): void {
    const evType = typeof ev.type === 'string' && ev.type ? ev.type : 'event'
    const frameTriggerEvents = new Set([
      'navigated',
      'page_mutated',
      'tab_activated',
      'tab_opened',
      'tab_closed',
      'emulation_updated',
      'chromium_recovered',
    ])

    for (const client of this.clients) {
      if (client.closed || !client.subscription) continue
      if (!this.isEventRelevantToClient(client, ev)) continue

      if (client.subscription.events) {
        this.sendJson(client, {
          type: 'event',
          event: evType,
          data: ev,
          ts: Date.now(),
        })
        this.eventsSent++
      }

      if (client.subscription.frames && frameTriggerEvents.has(evType)) {
        const force = evType === 'navigated' || evType === 'tab_activated'
        this.scheduleFrame(client, evType, force)
      }
    }
  }

  private scheduleFrame(client: WsClientState, reason: string, force = false): void {
    if (client.closed || !client.subscription || !client.subscription.frames) return

    if (client.frameInFlight) {
      client.rescheduleReason = reason
      client.rescheduleForce = client.rescheduleForce || force
      return
    }

    if (client.subscription.throttleMs <= 0) {
      void this.emitFrame(client, reason, force)
      return
    }

    client.pendingReason = reason
    client.pendingForce = client.pendingForce || force
    if (client.pendingTimer) return

    client.pendingTimer = setTimeout(() => {
      client.pendingTimer = null
      const r = client.pendingReason ?? reason
      const f = client.pendingForce
      client.pendingReason = null
      client.pendingForce = false
      void this.emitFrame(client, r, f)
    }, client.subscription.throttleMs)
  }

  private async emitFrame(client: WsClientState, reason: string, force: boolean): Promise<void> {
    if (client.closed || !client.subscription || !client.subscription.frames) return
    const tabId = this.resolveTargetTabId(client)
    if (tabId === undefined) return

    const sub = client.subscription
    client.frameInFlight = true
    try {
      const useSince = sub.since && client.hasSentInitialFrame && client.lastFrameTabId === tabId
      const res = await this.manager.renderAscii(tabId, {
        width: sub.width,
        height: sub.height,
        density: sub.density,
        layout: sub.layout,
        maxTokens: sub.maxTokens,
        asciiOnly: sub.asciiOnly,
        showChrome: sub.showChrome,
        since: useSince,
        sessionId: client.sessionId,
      })

      if (client.closed || !client.subscription || !res.ok || typeof res.ascii !== 'string') return

      const hash = hashAscii(`${tabId}\n${res.snapshot?.url ?? ''}\n${res.ascii}`)
      if (sub.dedupe && !force && client.lastFrameHash === hash && client.lastFrameTabId === tabId) {
        this.framesSkippedDuplicate++
        return
      }

      client.lastFrameHash = hash
      client.lastFrameTabId = tabId
      client.hasSentInitialFrame = true
      client.frameSeq++

      const payload: AsciiFramePayload = {
        type: 'ascii_frame',
        seq: client.frameSeq,
        ts: Date.now(),
        reason,
        tabId,
        url: res.snapshot?.url ?? '',
        title: res.snapshot?.title ?? '',
        mode: res.mode ?? 'full',
        refs: res.snapshot?.elements.length ?? 0,
        estimatedTokens: res.estimatedTokens ?? 0,
        ...(res.tokenBudget ? { tokenBudget: res.tokenBudget } : {}),
        ...(res.delta ? { delta: res.delta } : {}),
        hash,
        ascii: res.ascii,
        ...(client.sessionId ? { sessionId: client.sessionId } : {}),
      }

      this.sendJson(client, payload)
      this.framesSent++
    } catch {
      // Ignore transient errors during tab navigation/close
    } finally {
      client.frameInFlight = false
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

export interface TroyWsClientOptions {
  port: number
  token: string
  host?: string
  sessionId?: string
  subscribe?: boolean
  timeoutMs?: number
}

/**
 * Lightweight zero-dependency WebSocket client for `/ws` on Agent Socket,
 * built on Node.js 22+ native WebSocket.
 */
export class TroyWsClient {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<
    string | number,
    { resolve: (msg: WsResponseMessage | WsPongMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly messageListeners = new Set<(msg: WsServerMessage) => void>()
  private readonly eventListeners = new Set<(ev: WsEventMessage) => void>()
  private readonly frameListeners = new Set<(frame: AsciiFramePayload) => void>()
  public readonly hello: WsHelloMessage
  private closed = false

  private constructor(ws: WebSocket, hello: WsHelloMessage) {
    this.ws = ws
    this.hello = hello

    ws.addEventListener('message', (ev) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage
      } catch {
        return
      }
      for (const fn of this.messageListeners) fn(msg)

      if (msg.type === 'response' || msg.type === 'pong') {
        if (msg.id !== null && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          clearTimeout(entry.timer)
          entry.resolve(msg)
        }
        return
      }
      if (msg.type === 'event') {
        for (const fn of this.eventListeners) fn(msg)
        return
      }
      if (msg.type === 'ascii_frame') {
        for (const fn of this.frameListeners) fn(msg)
      }
    })

    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('WebSocket closed'))
      }
      this.pending.clear()
    })
  }

  static connect(opts: TroyWsClientOptions): Promise<TroyWsClient> {
    const host = opts.host ?? '127.0.0.1'
    const params = new URLSearchParams()
    params.set('token', opts.token)
    if (opts.sessionId) params.set('sessionId', opts.sessionId)
    if (opts.subscribe) params.set('subscribe', '1')
    const url = `ws://${host}:${opts.port}/ws?${params.toString()}`
    const timeoutMs = opts.timeoutMs ?? 5000

    return new Promise<TroyWsClient>((resolve, reject) => {
      const ws = new WebSocket(url)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const onHello = (ev: MessageEvent) => {
        if (settled) return
        try {
          const msg = JSON.parse(String(ev.data)) as WsServerMessage
          if (msg.type === 'hello') {
            settled = true
            clearTimeout(timer)
            ws.removeEventListener('message', onHello)
            resolve(new TroyWsClient(ws, msg))
          }
        } catch {
          // ignore
        }
      }

      ws.addEventListener('message', onHello)
      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`WebSocket connection failed (${url})`))
      })
      ws.addEventListener('close', (ev) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`WebSocket closed before hello (code=${ev.code})`))
      })
    })
  }

  request(msg: Record<string, unknown>, timeoutMs = 15_000): Promise<WsResponseMessage> {
    if (this.closed) return Promise.reject(new Error('WebSocket is closed'))
    const id = this.nextId++
    return new Promise<WsResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`WebSocket request ${id} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (resp) => resolve(resp as WsResponseMessage),
        reject,
        timer,
      })
      this.ws.send(JSON.stringify({ id, ...msg }))
    })
  }

  ping(timeoutMs = 5000): Promise<WsPongMessage> {
    if (this.closed) return Promise.reject(new Error('WebSocket is closed'))
    const id = this.nextId++
    return new Promise<WsPongMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`WebSocket ping timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (resp) => resolve(resp as WsPongMessage),
        reject,
        timer,
      })
      this.ws.send(JSON.stringify({ id, op: 'ping' }))
    })
  }

  route(pathname: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<WsResponseMessage> {
    return this.request({ route: pathname, body }, timeoutMs)
  }

  tool(name: string, args: Record<string, unknown> = {}, tabId?: number, timeoutMs?: number): Promise<WsResponseMessage> {
    return this.request({ op: 'tool', name, args, ...(tabId !== undefined ? { tabId } : {}) }, timeoutMs)
  }

  batch(
    steps: Array<Record<string, unknown>>,
    opts: { stopOnError?: boolean; timeoutMs?: number } = {},
  ): Promise<WsResponseMessage> {
    return this.request({ op: 'batch', steps, stopOnError: opts.stopOnError ?? false }, opts.timeoutMs)
  }

  subscribe(opts: Partial<WsSubscribeOptions> = {}): Promise<WsResponseMessage> {
    return this.request({ op: 'subscribe', ...opts })
  }

  unsubscribe(): Promise<WsResponseMessage> {
    return this.request({ op: 'unsubscribe' })
  }

  onMessage(fn: (msg: WsServerMessage) => void): () => void {
    this.messageListeners.add(fn)
    return () => this.messageListeners.delete(fn)
  }

  onEvent(fn: (ev: WsEventMessage) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  onFrame(fn: (frame: AsciiFramePayload) => void): () => void {
    this.frameListeners.add(fn)
    return () => this.frameListeners.delete(fn)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      this.ws.addEventListener('close', done, { once: true })
      try {
        this.ws.close(1000, 'client close')
      } catch {
        resolve()
      }
      setTimeout(resolve, 250)
    })
  }
}
