// Minimal zero-dependency Chrome DevTools Protocol (CDP) WebSocket client
// built directly on Node.js 22+ native WebSocket.

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
}

export class CdpClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
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
                fn(msg.params ?? {})
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

  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
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

      this.ws.send(JSON.stringify({ id, method, params }))
    })
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
