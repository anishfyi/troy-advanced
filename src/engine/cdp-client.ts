// Minimal zero-dependency Chrome DevTools Protocol (CDP) WebSocket client
// built directly on Node.js 22+ native WebSocket.

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export interface CdpConnection {
  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<T>
  sendToSession<T extends Record<string, unknown> = Record<string, unknown>>(
    sessionId: string | undefined,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>
  isClosed(): boolean
  close(): Promise<void>
}

export class CdpClient implements CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>()
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          id?: number
          result?: Record<string, unknown>
          error?: { message?: string; code?: number }
          method?: string
          params?: Record<string, unknown>
          sessionId?: string
        }
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id)
          if (entry) {
            clearTimeout(entry.timer)
            this.pending.delete(msg.id)
            if (msg.error) {
              entry.reject(new Error(`CDP error (${msg.error.code ?? '?'}): ${msg.error.message ?? 'unknown'}`))
            } else {
              entry.resolve(msg.result ?? {})
            }
          }
        } else if (msg.method) {
          const set = this.listeners.get(msg.method)
          if (set) {
            for (const fn of set) {
              try {
                fn(msg.params ?? {}, msg.sessionId)
              } catch {
                // listener error should not break CDP dispatch
              }
            }
          }
        }
      } catch {
        // ignore malformed frames
      }
    })

    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('CDP WebSocket closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(wsUrl: string, timeoutMs = 10000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to CDP at ${wsUrl}`))
      }, timeoutMs)

      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve(new CdpClient(ws))
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        (ev) => {
          clearTimeout(timer)
          reject(new Error(`CDP WebSocket connection failed: ${String((ev as { message?: string }).message ?? wsUrl)}`))
        },
        { once: true },
      )
    })
  }

  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP client is closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })

      const payload: Record<string, unknown> = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
    })
  }

  sendToSession<T extends Record<string, unknown> = Record<string, unknown>>(
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<T> {
    return this.send<T>(method, params, timeoutMs, sessionId)
  }

  createSession(sessionId: string): CdpSessionClient {
    return new CdpSessionClient(this, sessionId)
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Session-scoped CDP connection multiplexed over a shared Browser-level WebSocket.
 * Presents the same `CdpConnection` contract as a dedicated per-target WebSocket:
 * - Commands without an explicit sessionId target `rootSessionId` (except `Browser.*` commands).
 * - Events on `rootSessionId` are delivered with `sessionId = undefined`.
 * - Child OOPIF sessions attached under `rootSessionId` are tracked and delivered with their child `sessionId`.
 * - Events belonging to sibling tabs on the same browser WebSocket are filtered out.
 * - `close()` detaches listeners and this session without closing the shared browser WebSocket.
 */
export class CdpSessionClient implements CdpConnection {
  private readonly parent: CdpClient
  readonly sessionId: string
  private readonly childSessions = new Set<string>()
  private readonly unsubscribers = new Set<() => void>()
  private closed = false

  constructor(parent: CdpClient, sessionId: string) {
    this.parent = parent
    this.sessionId = sessionId

    const offAttach = parent.on('Target.attachedToTarget', (params, eventSessionId) => {
      if (eventSessionId === this.sessionId || (eventSessionId && this.childSessions.has(eventSessionId))) {
        const childSid = typeof params.sessionId === 'string' ? params.sessionId : ''
        if (childSid) this.childSessions.add(childSid)
      }
    })
    const offDetach = parent.on('Target.detachedFromTarget', (params) => {
      const detachedSid = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (detachedSid) this.childSessions.delete(detachedSid)
    })
    this.unsubscribers.add(offAttach)
    this.unsubscribers.add(offDetach)
  }

  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    const off = this.parent.on(method, (params, eventSessionId) => {
      if (this.closed) return
      if (eventSessionId === this.sessionId) {
        handler(params, undefined)
      } else if (eventSessionId && this.childSessions.has(eventSessionId)) {
        handler(params, eventSessionId)
      } else if (!eventSessionId && method.startsWith('Browser.')) {
        handler(params, undefined)
      }
    })
    this.unsubscribers.add(off)
    return () => {
      off()
      this.unsubscribers.delete(off)
    }
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP session is closed'))
    if (sessionId) {
      return this.parent.send<T>(method, params, timeoutMs, sessionId)
    }
    if (method.startsWith('Browser.')) {
      return this.parent.send<T>(method, params, timeoutMs)
    }
    return this.parent.send<T>(method, params, timeoutMs, this.sessionId)
  }

  sendToSession<T extends Record<string, unknown> = Record<string, unknown>>(
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<T> {
    return this.send<T>(method, params, timeoutMs, sessionId)
  }

  isClosed(): boolean {
    return this.closed || this.parent.isClosed()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const off of this.unsubscribers) {
      try {
        off()
      } catch {
        // ignore
      }
    }
    this.unsubscribers.clear()
    this.childSessions.clear()
    if (!this.parent.isClosed()) {
      await this.parent.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {})
    }
  }
}
