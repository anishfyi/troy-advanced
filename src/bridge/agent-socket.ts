// Token-authenticated loopback HTTP Agent Socket.
// 100% protocol-compatible with velofy/troy and Dexter's built-in `troy` tool,
// extended with `/ascii` (instant pure-ASCII page viewport) and `/stream` (SSE events).

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { parseAsciiDensity, parseMaxTokens } from '../ascii/layout.js'
import type { BrowserCookie, DownloadStatus, EmulationOptions, OriginStorageSnapshot } from '../types.js'
import { formatDialogsAscii, parseDialogMode, parseDialogType } from '../engine/dialogs.js'
import { formatDownloadsAscii, parseDownloadMode } from '../engine/downloads.js'
import { formatAuditAscii, parseAuditEventKind } from '../agent/audit.js'
import { normalizeStorageArea } from '../engine/storage.js'
import type { BrowserManager } from '../engine/manager.js'

const MAX_BODY = 128 * 1024
const MAX_IMPORT_BODY = 2 * 1024 * 1024

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
      case '/health': {
        const remoteCdp = manager.engine.getRemoteCdpInfo ? manager.engine.getRemoteCdpInfo() : null
        return {
          status: 200,
          payload: {
            ok: true,
            engine: manager.engine.kind,
            cdpPort: manager.engine.cdpPort,
            ...(remoteCdp ? { remoteCdp } : {}),
            tabs: manager.listTabs().length,
            crashRecovery: manager.getCrashRecoveryStats(),
            downloads: manager.getDownloadStats(),
            dialogs: manager.getDialogStats(),
            audit: manager.getAuditStats(),
          },
        }
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
        const densityOpt = parseAsciiDensity(body.density)
        const maxTokensOpt = parseMaxTokens(body.maxTokens ?? body.max_tokens)
        const res = await manager.renderAscii(tabId, {
          width: typeof body.width === 'number' ? body.width : undefined,
          height: typeof body.height === 'number' ? body.height : undefined,
          asciiOnly: body.asciiOnly !== false,
          color: Boolean(body.color),
          showChrome: typeof body.showChrome === 'boolean' ? body.showChrome : undefined,
          showMediaSummary: Boolean(body.showMediaSummary),
          scrollOffset: typeof body.scrollOffset === 'number' ? body.scrollOffset : 0,
          layout: layoutOpt,
          density: densityOpt,
          maxTokens: maxTokensOpt,
          crop: body.crop as string | { x: number; y: number; width: number; height: number } | undefined,
          ref: typeof body.ref === 'string' ? body.ref : undefined,
          since: Boolean(body.since),
          settle: body.settle as boolean | Record<string, unknown> | undefined,
        })
        return {
          status: 200,
          payload: res.ok
            ? {
                ok: true,
                mode: res.mode ?? 'full',
                ascii: res.ascii,
                url: res.snapshot?.url,
                title: res.snapshot?.title,
                refs: res.snapshot?.elements.length,
                ...(res.estimatedTokens !== undefined ? { estimatedTokens: res.estimatedTokens } : {}),
                ...(res.tokenBudget ? { tokenBudget: res.tokenBudget } : {}),
                ...(res.settle ? { settle: res.settle } : {}),
                ...(res.crop ? { crop: res.crop } : {}),
                ...(res.cropRef ? { cropRef: res.cropRef } : {}),
                ...(res.delta ? { delta: res.delta } : {}),
              }
            : { ok: false, error: res.error },
        }
      }
      case '/markdown': {
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const res = await manager.renderMarkdown(tabId, {
          showRefs: body.showRefs !== false,
          includeUrls: body.includeUrls !== false,
          asciiOnly: Boolean(body.asciiOnly),
          includeFrontmatter: Boolean(body.includeFrontmatter),
          includeHeader: typeof body.includeHeader === 'boolean' ? body.includeHeader : undefined,
          includeForms: typeof body.includeForms === 'boolean' ? body.includeForms : undefined,
          includeCanvasPreview: typeof body.includeCanvasPreview === 'boolean' ? body.includeCanvasPreview : undefined,
          includeMediaSummary: Boolean(body.includeMediaSummary),
          includeRefsIndex:
            body.includeRefsIndex === 'always'
              ? 'always'
              : typeof body.includeRefsIndex === 'boolean'
                ? body.includeRefsIndex
                : undefined,
          crop: body.crop as string | { x: number; y: number; width: number; height: number } | undefined,
          ref: typeof body.ref === 'string' ? body.ref : undefined,
          settle: body.settle as boolean | Record<string, unknown> | undefined,
        })
        return {
          status: 200,
          payload: res.ok
            ? {
                ok: true,
                markdown: res.markdown,
                url: res.snapshot?.url,
                title: res.snapshot?.title,
                refs: res.snapshot?.elements.length,
                ...(res.settle ? { settle: res.settle } : {}),
                ...(res.crop ? { crop: res.crop } : {}),
                ...(res.cropRef ? { cropRef: res.cropRef } : {}),
              }
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
      case '/cookies/export': {
        const cookies = await manager.exportCookies({
          domain: typeof body.domain === 'string' ? body.domain : undefined,
          url: typeof body.url === 'string' ? body.url : undefined,
          includeExpired: Boolean(body.includeExpired),
        })
        return {
          status: 200,
          payload: {
            ok: true,
            engine: manager.engine.kind,
            count: cookies.length,
            cookies,
          },
        }
      }
      case '/cookies/import': {
        if (!Array.isArray(body.cookies)) {
          return { status: 400, payload: { ok: false, error: 'cookies must be an array' } }
        }
        const result = await manager.importCookies(body.cookies as BrowserCookie[])
        return {
          status: 200,
          payload: { ok: true, ...result },
        }
      }
      case '/cookies/clear': {
        const removed = await manager.clearCookies({
          domain: typeof body.domain === 'string' ? body.domain : undefined,
        })
        return { status: 200, payload: { ok: true, removed } }
      }
      case '/storage/inspect': {
        const inspection = await manager.inspectStorage({
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          area: body.area !== undefined ? normalizeStorageArea(body.area) : undefined,
          keyPrefix: typeof body.keyPrefix === 'string' ? body.keyPrefix : undefined,
          revealValues: Boolean(body.revealValues),
          width: body.width !== undefined ? Number(body.width) : undefined,
        })
        return {
          status: 200,
          payload: { ok: true, ...inspection },
        }
      }
      case '/storage/export': {
        const origins = await manager.exportStorage({
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          area: body.area !== undefined ? normalizeStorageArea(body.area) : undefined,
          keyPrefix: typeof body.keyPrefix === 'string' ? body.keyPrefix : undefined,
        })
        return {
          status: 200,
          payload: {
            ok: true,
            engine: manager.engine.kind,
            originCount: origins.length,
            origins,
          },
        }
      }
      case '/storage/import': {
        if (!Array.isArray(body.origins)) {
          return { status: 400, payload: { ok: false, error: 'origins must be an array' } }
        }
        const result = await manager.importStorage(body.origins as OriginStorageSnapshot[], {
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          area: body.area !== undefined ? normalizeStorageArea(body.area) : undefined,
          clearBeforeImport: Boolean(body.clearBeforeImport),
        })
        return {
          status: 200,
          payload: { ok: true, ...result },
        }
      }
      case '/storage/clear': {
        const result = await manager.clearStorage({
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          area: body.area !== undefined ? normalizeStorageArea(body.area) : undefined,
          keys: Array.isArray(body.keys) ? body.keys.map((k) => String(k)) : undefined,
        })
        return { status: 200, payload: { ok: true, ...result } }
      }
      case '/emulation': {
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const hasUpdate =
          body.viewport !== undefined ||
          body.userAgent !== undefined ||
          body.acceptLanguage !== undefined ||
          body.platform !== undefined ||
          body.extraHeaders !== undefined ||
          body.headers !== undefined ||
          Boolean(body.clearHeaders) ||
          (Array.isArray(body.removeHeaders) && body.removeHeaders.length > 0)

        if (!hasUpdate) {
          return {
            status: 200,
            payload: manager.getEmulation(tabId, { revealHeaders: Boolean(body.revealHeaders) }),
          }
        }

        const extraHeaders =
          typeof body.extraHeaders === 'object' && body.extraHeaders !== null
            ? (body.extraHeaders as Record<string, string>)
            : typeof body.headers === 'object' && body.headers !== null
              ? (body.headers as Record<string, string>)
              : undefined

        const result = await manager.setEmulation({
          tabId,
          allTabs: Boolean(body.allTabs),
          viewport: body.viewport as EmulationOptions['viewport'],
          userAgent: typeof body.userAgent === 'string' ? body.userAgent : undefined,
          acceptLanguage: typeof body.acceptLanguage === 'string' ? body.acceptLanguage : undefined,
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          extraHeaders,
          mergeHeaders: typeof body.mergeHeaders === 'boolean' ? body.mergeHeaders : undefined,
          clearHeaders: Boolean(body.clearHeaders),
          removeHeaders: Array.isArray(body.removeHeaders) ? body.removeHeaders.map(String) : undefined,
          revealHeaders: Boolean(body.revealHeaders),
        })
        return { status: 200, payload: result }
      }
      case '/downloads': {
        if (typeof body.removeId === 'string' && body.removeId.trim()) {
          const removed = manager.removeDownload(body.removeId.trim())
          return { status: 200, payload: { ...removed, stats: manager.getDownloadStats() } }
        }
        if (body.clear) {
          const cleared = manager.clearDownloads({ deleteFiles: body.deleteFiles !== false })
          return { status: 200, payload: { ok: true, ...cleared, stats: manager.getDownloadStats() } }
        }
        const mode = parseDownloadMode(body.mode)
        const hasPolicyUpdate =
          Boolean(mode) ||
          typeof body.maxBytes === 'number' ||
          Array.isArray(body.extraBlockedExtensions) ||
          Array.isArray(body.allowedExtensions)
        if (hasPolicyUpdate) {
          manager.setDownloadPolicy({
            ...(mode ? { mode } : {}),
            ...(typeof body.maxBytes === 'number' ? { maxBytes: body.maxBytes } : {}),
            ...(Array.isArray(body.extraBlockedExtensions)
              ? { extraBlockedExtensions: body.extraBlockedExtensions.map(String) }
              : {}),
            ...(Array.isArray(body.allowedExtensions)
              ? { allowedExtensions: body.allowedExtensions.map(String) }
              : {}),
          })
        }
        const status =
          body.status === 'in_progress' ||
          body.status === 'quarantined' ||
          body.status === 'blocked' ||
          body.status === 'canceled' ||
          body.status === 'failed'
            ? (body.status as DownloadStatus)
            : undefined
        const entries = manager.getDownloads({
          status,
          blockedOnly: Boolean(body.blockedOnly),
          limit: typeof body.limit === 'number' ? body.limit : 100,
        })
        const stats = manager.getDownloadStats()
        return {
          status: 200,
          payload: {
            ok: true,
            count: entries.length,
            entries,
            stats,
            ascii: formatDownloadsAscii(entries, stats),
          },
        }
      }
      case '/dialogs': {
        if (body.clearQueue) {
          manager.clearDialogQueue()
        }
        const mode = parseDialogMode(body.mode)
        const hasPolicyUpdate =
          Boolean(mode) ||
          typeof body.acceptBeforeUnload === 'boolean' ||
          typeof body.defaultPromptText === 'string'
        if (hasPolicyUpdate) {
          manager.setDialogPolicy({
            ...(mode ? { mode } : {}),
            ...(typeof body.acceptBeforeUnload === 'boolean' ? { acceptBeforeUnload: body.acceptBeforeUnload } : {}),
            ...(typeof body.defaultPromptText === 'string' ? { defaultPromptText: body.defaultPromptText } : {}),
          })
        }
        if (body.next && typeof body.next === 'object') {
          const nextObj = body.next as Record<string, unknown>
          if (typeof nextObj.accept === 'boolean') {
            manager.queueDialogResponse({
              accept: nextObj.accept,
              ...(typeof nextObj.promptText === 'string' ? { promptText: nextObj.promptText } : {}),
              ...(parseDialogType(nextObj.type) ? { type: parseDialogType(nextObj.type) } : {}),
            })
          }
        } else if (typeof body.queueAccept === 'boolean') {
          manager.queueDialogResponse({
            accept: body.queueAccept,
            ...(typeof body.promptText === 'string' ? { promptText: body.promptText } : {}),
            ...(parseDialogType(body.queueType) ? { type: parseDialogType(body.queueType) } : {}),
          })
        }
        const tabId = typeof body.tabId === 'number' ? body.tabId : undefined
        const type = parseDialogType(body.type)
        const entries = manager.getDialogs({
          tabId,
          type,
          limit: typeof body.limit === 'number' ? body.limit : 100,
          clear: Boolean(body.clear),
        })
        const stats = manager.getDialogStats()
        const queue = manager.getDialogQueue()
        return {
          status: 200,
          payload: {
            ok: true,
            count: entries.length,
            entries,
            stats,
            queue,
            ascii: formatDialogsAscii(entries, stats, queue),
          },
        }
      }
      case '/audit': {
        if (body.clear) {
          const cleared = manager.clearAuditLog({ truncateFile: Boolean(body.truncateFile) })
          return {
            status: 200,
            payload: {
              ok: true,
              ...cleared,
              stats: manager.getAuditStats(),
            },
          }
        }
        const entries = manager.getAuditLog({
          limit: typeof body.limit === 'number' ? body.limit : 100,
          kind: parseAuditEventKind(body.kind),
          tool: typeof body.tool === 'string' && body.tool.trim() ? body.tool.trim() : undefined,
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          refusedOnly: Boolean(body.refusedOnly),
          urlChangedOnly: Boolean(body.urlChangedOnly),
          failedOnly: Boolean(body.failedOnly),
          sinceMs: typeof body.sinceMs === 'number' ? body.sinceMs : undefined,
          fromDisk: Boolean(body.fromDisk),
        })
        const stats = manager.getAuditStats()
        return {
          status: 200,
          payload: {
            ok: true,
            count: entries.length,
            entries,
            stats,
            ascii: formatAuditAscii(entries, stats, {
              width: typeof body.width === 'number' ? body.width : undefined,
            }),
          },
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

    const maxBody =
      url.pathname === '/cookies/import' || url.pathname === '/storage/import' ? MAX_IMPORT_BODY : MAX_BODY
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBody) {
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
