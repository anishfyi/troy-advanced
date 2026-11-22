// Token-authenticated loopback HTTP Agent Socket.
// 100% protocol-compatible with velofy/troy and Dexter's built-in `troy` tool,
// extended with `/ascii` (instant pure-ASCII page viewport) and `/stream` (SSE events).

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { BrowserManager } from '../engine/manager.js'

const MAX_BODY = 128 * 1024

export interface AgentSocketServer {
  port: number
  token: string
  close: () => Promise<void>
}

export async function createAgentSocket(
  manager: BrowserManager,
  opts: { host?: string; port?: number; token?: string } = {},
): Promise<AgentSocketServer> {
  const host = opts.host ?? '127.0.0.1'
  const token = opts.token ?? randomBytes(24).toString('hex')
  const sseClients = new Set<http.ServerResponse>()

  const unsubscribe = manager.onEvent((ev) => {
    const chunk = `data: ${JSON.stringify(ev)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(chunk)
      } catch {
        sseClients.delete(res)
      }
    }
  })

  async function handleRoute(pathname: string, body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> }> {
    switch (pathname) {
      case '/health':
        return {
          status: 200,
          payload: {
            ok: true,
            engine: manager.engine.kind,
            cdpPort: manager.engine.cdpPort,
            tabs: manager.listTabs().length,
          },
        }
      case '/tabs':
        return { status: 200, payload: { ok: true, tabs: manager.listTabs() } }
      case '/open': {
        const res = await manager.openTab(typeof body.url === 'string' ? body.url : undefined, {
          activate: Boolean(body.activate),
          ownedByBridge: true,
        })
        return { status: 200, payload: res }
      }
      case '/activate': {
        const id = Number(body.tabId)
        if (!Number.isFinite(id)) return { status: 200, payload: { ok: false, error: 'no tabId' } }
        return { status: 200, payload: manager.activateTab(id) }
      }
      case '/close': {
        const id = Number(body.tabId)
        if (!Number.isFinite(id)) return { status: 200, payload: { ok: false, error: 'no tabId' } }
        const res = await manager.closeTab(id, body.force ? false : true)
        return { status: 200, payload: res }
      }
      case '/grant-origin': {
        const origin = String(body.origin ?? '')
        if (!origin) return { status: 200, payload: { ok: false, error: 'grant needs an http(s) origin' } }
        return { status: 200, payload: manager.grantOrigin(origin) }
      }
      case '/ascii': {
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const layoutOpt =
          body.layout === 'spatial' || body.layout === 'auto' || body.layout === 'flow' ? body.layout : undefined
        const res = await manager.renderAscii(tabId, {
          width: typeof body.width === 'number' ? body.width : 100,
          height: typeof body.height === 'number' ? body.height : 36,
          asciiOnly: body.asciiOnly !== false,
          color: Boolean(body.color),
          scrollOffset: typeof body.scrollOffset === 'number' ? body.scrollOffset : 0,
          layout: layoutOpt,
        })
        return {
          status: 200,
          payload: res.ok
            ? { ok: true, ascii: res.ascii, url: res.snapshot?.url, title: res.snapshot?.title, refs: res.snapshot?.elements.length }
            : { ok: false, error: res.error },
        }
      }
      case '/tool': {
        const name = String(body.name ?? '')
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const args = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as Record<string, unknown>
        const result = await manager.runTool(tabId, name, args)
        return { status: 200, payload: result }
      }
      case '/recall': {
        if (!manager.memory) return { status: 200, payload: { ok: false, error: 'page memory is not enabled' } }
        const data = manager.memory.recall(String(body.query ?? ''), {
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
        return { status: 200, payload: { ok: true, ...data } }
      }
      case '/forget': {
        if (!manager.memory) return { status: 200, payload: { ok: false, error: 'page memory is not enabled' } }
        const data = manager.memory.forget(typeof body.origin === 'string' ? body.origin : undefined)
        return { status: 200, payload: { ok: true, ...data } }
      }
      case '/memory': {
        return {
          status: 200,
          payload: { ok: true, enabled: Boolean(manager.memory), ...(manager.memory?.stats() ?? {}) },
        }
      }
      default:
        return { status: 404, payload: { ok: false, error: `no route ${pathname}` } }
    }
  }

  const server = http.createServer((req, res) => {
    const respond = (status: number, payload: Record<string, unknown>) => {
      const json = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(json),
        'cache-control': 'no-store',
      })
      res.end(json)
    }

    const reqHost = String(req.headers.host ?? '')
    if (!reqHost.startsWith('127.0.0.1') && !reqHost.startsWith('localhost') && !reqHost.startsWith('[::1]')) {
      return respond(403, { ok: false, error: 'wrong host' })
    }
    if (req.headers['x-troy-agent'] !== token) {
      return respond(401, { ok: false, error: 'missing or invalid x-troy-agent token' })
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/health') {
      handleRoute('/health', {})
        .then((r) => respond(r.status, r.payload))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected', engine: manager.engine.kind })}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (req.method !== 'POST') {
      return respond(405, { ok: false, error: 'POST only' })
    }

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        respond(413, { ok: false, error: 'body too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
      } catch {
        return respond(400, { ok: false, error: 'body must be JSON' })
      }
      handleRoute(url.pathname, body)
        .then((r) => respond(r.status, r.payload))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  return {
    port,
    token,
    async close() {
      unsubscribe()
      for (const client of sseClients) {
        try {
          client.end()
        } catch {
          // ignore
        }
      }
      sseClients.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
