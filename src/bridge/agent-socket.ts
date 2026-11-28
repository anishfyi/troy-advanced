// Token-authenticated loopback HTTP Agent Socket.
// 100% protocol-compatible with velofy/troy and Dexter's built-in `troy` tool,
// extended with `/ascii` (instant pure-ASCII page viewport) and `/stream` (SSE events).

import http from 'node:http'
import type net from 'node:net'
import { randomBytes } from 'node:crypto'
import { parseAsciiDensity, parseMaxTokens } from '../ascii/layout.js'
import type { BrowserCookie, DownloadStatus, EmulationOptions, OriginStorageSnapshot } from '../types.js'
import { formatDialogsAscii, parseDialogMode, parseDialogType } from '../engine/dialogs.js'
import { formatDownloadsAscii, parseDownloadMode } from '../engine/downloads.js'
import { formatAuditAscii, parseAuditEventKind } from '../agent/audit.js'
import { formatLoopGuardAscii, parseLoopGuardMode } from '../agent/loop-guard.js'
import { formatPolicyAscii } from '../agent/policy-profile.js'
import { formatOriginRulesAscii } from '../cloud/daemon-config.js'
import type { OriginRuleAction } from '../types.js'
import { formatSessionsAscii, parseSessionId, SESSION_HEADER } from '../agent/sessions.js'
import { normalizeStorageArea } from '../engine/storage.js'
import type { BrowserManager } from '../engine/manager.js'
import { parseSseStreamOptions, SseStreamHub } from './sse-stream.js'
import { WsBridgeHub } from './ws-bridge.js'
import { validateAgentRequestHeaders } from './host-guard.js'
import { validateAgentTokenRequest } from './auth.js'
import {
  AgentSocketRateLimiter,
  buildRateLimitHeaders,
  type RateLimitConfig,
} from './rate-limit.js'
import {
  AgentMetricsCollector,
  PROMETHEUS_CONTENT_TYPE,
  evaluateLivenessProbe,
  evaluateReadinessProbe,
  formatMetricsAscii,
  type RuntimeMetricsSource,
  type ToolOutcome,
} from './metrics.js'
import {
  formatMemoryWatchdogAscii,
  type MemoryWatchdog,
} from '../cloud/memory-watchdog.js'

export const MAX_BODY = 128 * 1024
export const MAX_IMPORT_BODY = 2 * 1024 * 1024
export const MAX_URL_LENGTH = 8192

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface AgentSocketOptions {
  host?: string
  port?: number
  token?: string
  strictPort?: boolean
  maxBodyBytes?: number
  maxImportBodyBytes?: number
  maxUrlLength?: number
  rateLimit?: RateLimitConfig
  /** Allow unauthenticated loopback GET/HEAD on /healthz, /livez, /readyz (default: true). */
  healthProbeUnauthenticated?: boolean
  /** Allow unauthenticated loopback GET on /metrics for Prometheus scrapers (default: false). */
  metricsUnauthenticated?: boolean
  /** Optional custom metrics collector instance. */
  metrics?: AgentMetricsCollector
  /** Optional daemon memory watchdog instance. */
  memoryWatchdog?: MemoryWatchdog
}

export interface AgentSocketServer {
  port: number
  token: string
  wsUrl: string
  metrics: AgentMetricsCollector
  memoryWatchdog?: MemoryWatchdog
  close: () => Promise<void>
}

function parseContentLengthHeader(
  req: Pick<http.IncomingMessage, 'headers' | 'rawHeaders'>,
): { ok: true; length: number | null } | { ok: false; error: string } {
  if (Array.isArray(req.rawHeaders)) {
    let count = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'content-length') {
        count++
      }
    }
    if (count > 1) {
      return { ok: false, error: 'duplicate content-length header' }
    }
  }

  const raw = req.headers['content-length']
  if (raw === undefined) return { ok: true, length: null }
  if (Array.isArray(raw)) {
    return { ok: false, error: 'duplicate content-length header' }
  }
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: 'invalid content-length header' }
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, error: 'invalid content-length header' }
  }
  return { ok: true, length: parsed }
}

function parseSafeJsonObject(
  rawText: string,
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: 'invalid_json' | 'invalid_json_object'; error: string } {
  if (!rawText.trim()) {
    return { ok: true, body: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText, (key, value) => (FORBIDDEN_JSON_KEYS.has(key) ? undefined : value))
  } catch {
    return { ok: false, code: 'invalid_json', error: 'body must be JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'invalid_json_object', error: 'body must be a JSON object' }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}

export async function createAgentSocket(
  manager: BrowserManager,
  opts: AgentSocketOptions = {},
): Promise<AgentSocketServer> {
  const host = opts.host ?? '127.0.0.1'
  const token = opts.token ?? randomBytes(24).toString('hex')
  const strictPort = Boolean(opts.strictPort)
  const maxBodyBytes =
    typeof opts.maxBodyBytes === 'number' && Number.isFinite(opts.maxBodyBytes) && opts.maxBodyBytes > 0
      ? Math.floor(opts.maxBodyBytes)
      : MAX_BODY
  const maxImportBodyBytes =
    typeof opts.maxImportBodyBytes === 'number' &&
    Number.isFinite(opts.maxImportBodyBytes) &&
    opts.maxImportBodyBytes > 0
      ? Math.floor(opts.maxImportBodyBytes)
      : MAX_IMPORT_BODY
  const maxUrlLength =
    typeof opts.maxUrlLength === 'number' && Number.isFinite(opts.maxUrlLength) && opts.maxUrlLength > 0
      ? Math.floor(opts.maxUrlLength)
      : MAX_URL_LENGTH
  const rateLimiter = new AgentSocketRateLimiter(opts.rateLimit)
  const metrics = opts.metrics ?? new AgentMetricsCollector()
  const memoryWatchdog = opts.memoryWatchdog
  const healthProbeUnauthenticated = opts.healthProbeUnauthenticated !== false
  const metricsUnauthenticated = Boolean(opts.metricsUnauthenticated)
  const streamHub = new SseStreamHub(manager)
  let wsHub: WsBridgeHub | null = null
  let boundPort = opts.port ?? 0
  let closing = false

  function classifyToolOutcome(result: Record<string, unknown> | null | undefined): ToolOutcome {
    if (result?.ok === true) return 'ok'
    const status = result?.status
    if (
      status === 'blocked' ||
      status === 'boundary' ||
      status === 'refused' ||
      status === 'needs_confirmation' ||
      status === 'needs_origin_grant'
    ) {
      return 'refused'
    }
    return 'error'
  }

  function buildRuntimeMetricsSource(): RuntimeMetricsSource {
    const tabs = manager.listTabs()
    const sessions = manager.listSessions()
    const crashRecovery = manager.getCrashRecoveryStats()
    const audit = manager.getAuditStats()
    const rateStats = rateLimiter.getStats()
    const sseStats = streamHub.getStats()
    const wsStats = wsHub?.getStats()
    const memStats = manager.memory?.stats()
    const wdStats = memoryWatchdog?.getStats()
    const ownedTabIds = new Set<number>()
    for (const s of sessions) {
      for (const id of s.ownedTabIds) ownedTabIds.add(id)
    }

    let ready = !closing
    let readyReason: string | undefined
    if (closing) {
      ready = false
      readyReason = 'server_closing'
    } else if (crashRecovery.status === 'failed' || crashRecovery.status === 'closed' || crashRecovery.status === 'crashed') {
      ready = false
      readyReason = crashRecovery.lastError || `engine_${crashRecovery.status}`
    }

    return {
      version: '0.1.0',
      engine: manager.engine.kind,
      tabsTotal: tabs.length,
      tabsOwned: ownedTabIds.size,
      sessionsActive: sessions.length,
      sseClients: sseStats.clients,
      wsClients: wsStats?.clients ?? 0,
      wsRequestsTotal: wsStats?.requestsHandled ?? 0,
      crashRecoveriesTotal: crashRecovery.restartCount,
      auditEventsTotal: audit.totalEntries,
      auditRefusalsTotal: audit.refusals,
      rateLimitBlockedTotal: rateStats.totalBlocked + rateStats.authBlocked,
      memoryEntriesTotal: memStats ? memStats.pages + memStats.elements : 0,
      ready,
      ...(readyReason ? { readyReason } : {}),
      ...(wdStats
        ? {
            memoryWatchdog: {
              enabled: wdStats.enabled,
              maxRssBytes: wdStats.maxRssBytes,
              pressureEventsTotal: wdStats.pressureEventsTotal,
              evictedTabsTotal: wdStats.evictedTabsTotal,
              gcHintsTotal: wdStats.gcHintsTotal,
              gcInvokedTotal: wdStats.gcInvokedTotal,
            },
          }
        : {}),
    }
  }

  async function handleRoute(
    pathname: string,
    body: Record<string, unknown>,
    headerSessionId?: string,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    let sessionId = headerSessionId
    if (!sessionId && body.sessionId !== undefined && pathname !== '/sessions' && pathname !== '/audit') {
      const parsedBodySession = parseSessionId(body.sessionId)
      if (!parsedBodySession.ok) {
        return { status: 400, payload: { ok: false, error: parsedBodySession.error } }
      }
      sessionId = parsedBodySession.sessionId
    }

    if (
      manager.readonlyGuard.enabled &&
      pathname !== '/tool' &&
      pathname !== '/open' &&
      pathname !== '/close' &&
      pathname !== '/grant-origin'
    ) {
      const roDecision = manager.readonlyGuard.checkEndpoint(pathname, body, {
        tabId: body.tabId !== undefined && Number.isFinite(Number(body.tabId)) ? Number(body.tabId) : undefined,
        sessionId,
      })
      if (!roDecision.allowed) {
        manager.audit.record({
          tsMs: Date.now(),
          kind: 'refusal',
          tool: pathname,
          ...(sessionId ? { sessionId } : {}),
          ok: false,
          refused: true,
          refusal: { status: roDecision.status, code: roDecision.code, reason: roDecision.reason },
          durationMs: 0,
          args: body,
          summary: pathname,
          error: roDecision.reason,
        })
        return {
          status: 200,
          payload: {
            ok: false,
            status: roDecision.status,
            code: roDecision.code,
            error: roDecision.reason,
          },
        }
      }
    }

    switch (pathname) {
      case '/health': {
        const remoteCdp = manager.engine.getRemoteCdpInfo ? manager.engine.getRemoteCdpInfo() : null
        const runtimeSource = buildRuntimeMetricsSource()
        const snap = metrics.getSnapshot(runtimeSource)
        return {
          status: 200,
          payload: {
            ok: true,
            status: runtimeSource.ready ? 'ok' : 'degraded',
            ...(runtimeSource.readyReason ? { readyReason: runtimeSource.readyReason } : {}),
            uptimeSeconds: snap.uptimeSeconds,
            memory: snap.memory,
            metrics: {
              requestsTotal: snap.requests.total,
              requestsInFlight: snap.requests.inFlight,
              toolCallsTotal: snap.tools.total,
              toolErrorsTotal: snap.tools.error,
              toolRefusalsTotal: snap.tools.refused,
              avgToolLatencyMs: snap.tools.avgLatencyMs,
            },
            engine: manager.engine.kind,
            cdpPort: manager.engine.cdpPort,
            ...(remoteCdp ? { remoteCdp } : {}),
            tabs: manager.listTabs().length,
            sessions: manager.listSessions().length,
            crashRecovery: manager.getCrashRecoveryStats(),
            downloads: manager.getDownloadStats(),
            dialogs: manager.getDialogStats(),
            audit: manager.getAuditStats(),
            loopGuard: manager.getLoopGuardStats(),
            policy: manager.getPolicyStats(),
            originRules: manager.getOriginRules(),
            readonly: manager.getReadonlyStats(),
            ssrf: manager.getSsrfStats(),
            untrustedMarkers: manager.getUntrustedMarkersStats(),
            secretRedaction: manager.getSecretRedactionStats(),
            rateLimit: rateLimiter.getStats(),
            ...(memoryWatchdog ? { memoryWatchdog: memoryWatchdog.getStats() } : {}),
            stream: streamHub.getStats(),
            ws: wsHub?.getStats() ?? {
              clients: 0,
              subscribedClients: 0,
              requestsHandled: 0,
              messagesSent: 0,
              framesSent: 0,
              framesSkippedDuplicate: 0,
              eventsSent: 0,
            },
          },
        }
      }
      case '/metrics': {
        const runtimeSource = buildRuntimeMetricsSource()
        const snapshot = metrics.getSnapshot(runtimeSource)
        const prometheus = metrics.renderPrometheus(runtimeSource)
        return {
          status: 200,
          payload: {
            ok: true,
            contentType: PROMETHEUS_CONTENT_TYPE,
            snapshot,
            prometheus,
            ascii: formatMetricsAscii(snapshot, {
              width: typeof body.width === 'number' ? body.width : undefined,
            }),
          },
        }
      }
      case '/watchdog': {
        if (!memoryWatchdog) {
          return {
            status: 200,
            payload: {
              ok: true,
              enabled: false,
              stats: null,
              ascii: 'Memory watchdog is not configured for this server.',
            },
          }
        }
        const checkResult = body.check === true ? await memoryWatchdog.checkOnce() : undefined
        const stats = memoryWatchdog.getStats()
        return {
          status: 200,
          payload: {
            ok: true,
            enabled: stats.enabled,
            stats,
            ...(checkResult ? { checkResult } : {}),
            ascii: formatMemoryWatchdogAscii(stats, {
              width: typeof body.width === 'number' ? body.width : undefined,
            }),
          },
        }
      }
      case '/policy': {
        const stats = manager.getPolicyStats()
        return {
          status: 200,
          payload: {
            ok: true,
            profile: stats.profile,
            policy: manager.getPolicyProfile(),
            stats,
            ascii: formatPolicyAscii(stats, {
              width: typeof body.width === 'number' ? body.width : undefined,
            }),
          },
        }
      }
      case '/origins': {
        const rawAction = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'list'
        const validActions = new Set<OriginRuleAction>(['list', 'allow', 'deny', 'unallow', 'undeny', 'clear'])
        if (!validActions.has(rawAction as OriginRuleAction)) {
          return {
            status: 400,
            payload: {
              ok: false,
              error: `Invalid action "${rawAction}". Valid actions: list, allow, deny, unallow, undeny, clear`,
            },
          }
        }
        const action = rawAction as OriginRuleAction
        const width = typeof body.width === 'number' ? body.width : undefined
        if (action === 'list') {
          const rules = manager.getOriginRules()
          return {
            status: 200,
            payload: {
              ok: true,
              action,
              ...rules,
              rules,
              ascii: formatOriginRulesAscii(rules, { width }),
            },
          }
        }
        const res = manager.updateOriginRules({
          action,
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          persist: body.persist !== false,
          sessionId: headerSessionId,
        })
        if (!res.ok) {
          return {
            status: res.status === 'blocked' ? 403 : 400,
            payload: res,
          }
        }
        return {
          status: 200,
          payload: {
            ...res,
            ...(res.rules ? { ...res.rules, ascii: formatOriginRulesAscii(res.rules, { width }) } : {}),
          },
        }
      }
      case '/sessions': {
        const targetRaw = body.sessionId !== undefined ? body.sessionId : headerSessionId
        if (body.close) {
          const parsed = parseSessionId(targetRaw)
          if (!parsed.ok) return { status: 400, payload: { ok: false, error: parsed.error } }
          if (!parsed.sessionId) {
            return { status: 400, payload: { ok: false, error: 'close requires a sessionId (or x-troy-session header)' } }
          }
          const closed = await manager.closeSession(parsed.sessionId, {
            closeTabs: body.closeTabs !== false,
          })
          return { status: 200, payload: closed }
        }
        if (body.sessionId !== undefined) {
          const parsed = parseSessionId(body.sessionId)
          if (!parsed.ok) return { status: 400, payload: { ok: false, error: parsed.error } }
          if (parsed.sessionId) {
            const found = manager.getSession(parsed.sessionId)
            if (!found) return { status: 200, payload: { ok: false, error: `no session "${parsed.sessionId}"` } }
            return {
              status: 200,
              payload: {
                ok: true,
                session: found,
                ascii: formatSessionsAscii([found], {
                  width: typeof body.width === 'number' ? body.width : undefined,
                }),
              },
            }
          }
        }
        const sessions = manager.listSessions()
        return {
          status: 200,
          payload: {
            ok: true,
            count: sessions.length,
            sessions,
            ascii: formatSessionsAscii(sessions, {
              width: typeof body.width === 'number' ? body.width : undefined,
            }),
          },
        }
      }
      case '/tabs':
        return {
          status: 200,
          payload: {
            ok: true,
            ...(sessionId ? { sessionId } : {}),
            tabs: manager.listTabs({ sessionId }),
          },
        }
      case '/open': {
        const res = await manager.openTab(typeof body.url === 'string' ? body.url : undefined, {
          activate: Boolean(body.activate),
          ownedByBridge: true,
          sessionId,
        })
        return { status: 200, payload: res }
      }
      case '/activate': {
        const id = Number(body.tabId)
        if (!Number.isFinite(id)) return { status: 200, payload: { ok: false, error: 'no tabId' } }
        return { status: 200, payload: manager.activateTab(id, { sessionId }) }
      }
      case '/close': {
        const id = Number(body.tabId)
        if (!Number.isFinite(id)) return { status: 200, payload: { ok: false, error: 'no tabId' } }
        const res = await manager.closeTab(id, body.force ? false : true, { sessionId })
        return { status: 200, payload: res }
      }
      case '/grant-origin': {
        const origin = String(body.origin ?? '')
        if (!origin) return { status: 200, payload: { ok: false, error: 'grant needs an http(s) origin' } }
        return { status: 200, payload: manager.grantOrigin(origin, { sessionId }) }
      }
      case '/ascii': {
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const layoutOpt =
          body.layout === 'spatial' || body.layout === 'auto' || body.layout === 'flow' ? body.layout : undefined
        const densityOpt = parseAsciiDensity(body.density)
        const maxTokensOpt = parseMaxTokens(body.maxTokens ?? body.max_tokens)
        const untrustedOpt =
          body.untrustedMarkers !== undefined
            ? (body.untrustedMarkers as boolean | Record<string, unknown>)
            : body.untrusted_markers !== undefined
              ? Boolean(body.untrusted_markers)
              : undefined
        const redactOpt =
          body.redactSecrets !== undefined
            ? (body.redactSecrets as boolean | Record<string, unknown>)
            : body.redact_secrets !== undefined
              ? Boolean(body.redact_secrets)
              : undefined
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
          ...(untrustedOpt !== undefined ? { untrustedMarkers: untrustedOpt } : {}),
          ...(redactOpt !== undefined ? { redactSecrets: redactOpt } : {}),
          sessionId,
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
                ...(sessionId ? { sessionId } : {}),
                ...(res.estimatedTokens !== undefined ? { estimatedTokens: res.estimatedTokens } : {}),
                ...(res.tokenBudget ? { tokenBudget: res.tokenBudget } : {}),
                ...(res.secretRedaction ? { secretRedaction: res.secretRedaction } : {}),
                ...(res.untrustedMarkers ? { untrustedMarkers: res.untrustedMarkers } : {}),
                ...(res.settle ? { settle: res.settle } : {}),
                ...(res.crop ? { crop: res.crop } : {}),
                ...(res.cropRef ? { cropRef: res.cropRef } : {}),
                ...(res.delta ? { delta: res.delta } : {}),
              }
            : {
                ok: false,
                ...(res.status ? { status: res.status } : {}),
                ...(res.code ? { code: res.code } : {}),
                error: res.error,
              },
        }
      }
      case '/markdown': {
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const untrustedOpt =
          body.untrustedMarkers !== undefined
            ? (body.untrustedMarkers as boolean | Record<string, unknown>)
            : body.untrusted_markers !== undefined
              ? Boolean(body.untrusted_markers)
              : undefined
        const redactOpt =
          body.redactSecrets !== undefined
            ? (body.redactSecrets as boolean | Record<string, unknown>)
            : body.redact_secrets !== undefined
              ? Boolean(body.redact_secrets)
              : undefined
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
          ...(untrustedOpt !== undefined ? { untrustedMarkers: untrustedOpt } : {}),
          ...(redactOpt !== undefined ? { redactSecrets: redactOpt } : {}),
          sessionId,
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
                ...(sessionId ? { sessionId } : {}),
                ...(res.secretRedaction ? { secretRedaction: res.secretRedaction } : {}),
                ...(res.untrustedMarkers ? { untrustedMarkers: res.untrustedMarkers } : {}),
                ...(res.settle ? { settle: res.settle } : {}),
                ...(res.crop ? { crop: res.crop } : {}),
                ...(res.cropRef ? { cropRef: res.cropRef } : {}),
              }
            : {
                ok: false,
                ...(res.status ? { status: res.status } : {}),
                ...(res.code ? { code: res.code } : {}),
                error: res.error,
              },
        }
      }
      case '/extract': {
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const toolStartMs = performance.now()
        const result = await manager.runTool(
          tabId,
          'page_extract',
          {
            sections: body.sections ?? body.include,
            maxItems: typeof body.maxItems === 'number' ? body.maxItems : undefined,
            includeObjects: body.includeObjects !== false,
            asciiOnly: Boolean(body.asciiOnly),
            externalLinksOnly: Boolean(body.externalLinksOnly ?? body.external),
            internalLinksOnly: Boolean(body.internalLinksOnly ?? body.internal),
            ascii: Boolean(body.ascii),
            width: typeof body.width === 'number' ? body.width : undefined,
            settle: body.settle,
            ...(body.untrustedMarkers !== undefined ? { untrustedMarkers: body.untrustedMarkers } : {}),
            ...(body.untrusted_markers !== undefined ? { untrustedMarkers: body.untrusted_markers } : {}),
            ...(body.redactSecrets !== undefined ? { redactSecrets: body.redactSecrets } : {}),
            ...(body.redact_secrets !== undefined ? { redactSecrets: body.redact_secrets } : {}),
          },
          { sessionId },
        )
        metrics.recordToolCall({
          tool: 'page_extract',
          outcome: classifyToolOutcome(result),
          durationMs: performance.now() - toolStartMs,
        })
        return {
          status: 200,
          payload: sessionId ? { ...result, sessionId } : result,
        }
      }
      case '/tool': {
        const name = String(body.name ?? '')
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const args = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as Record<string, unknown>
        const toolStartMs = performance.now()
        const result = await manager.runTool(tabId, name, args, { sessionId })
        metrics.recordToolCall({
          tool: name || 'unknown',
          outcome: classifyToolOutcome(result),
          durationMs: performance.now() - toolStartMs,
        })
        return { status: 200, payload: result }
      }
      case '/recall': {
        const data = await manager.recall({
          query: String(body.query ?? ''),
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          sessionId,
          bind: body.bind !== false,
          boundOnly: Boolean(body.boundOnly),
          currentOriginOnly: Boolean(body.currentOriginOnly),
          recordVerification: body.recordVerification !== false,
          ascii: Boolean(body.ascii),
        })
        return { status: 200, payload: data }
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
        const auditSessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : body.sessionOnly && headerSessionId
              ? headerSessionId
              : undefined
        const entries = manager.getAuditLog({
          limit: typeof body.limit === 'number' ? body.limit : 100,
          kind: parseAuditEventKind(body.kind),
          tool: typeof body.tool === 'string' && body.tool.trim() ? body.tool.trim() : undefined,
          tabId: body.tabId !== undefined ? Number(body.tabId) : undefined,
          sessionId: auditSessionId,
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
      case '/loop-guard': {
        if (body.reset) {
          const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
          const cleared = manager.resetLoopGuard({
            ...(sessionId ? { sessionId } : {}),
            ...(Number.isFinite(tabId) ? { tabId } : {}),
          })
          const stats = manager.getLoopGuardStats()
          return {
            status: 200,
            payload: {
              ok: true,
              cleared,
              stats,
              patterns: manager.getLoopGuardPatterns({
                ...(sessionId ? { sessionId } : {}),
                ...(Number.isFinite(tabId) ? { tabId } : {}),
              }),
              ascii: formatLoopGuardAscii(stats, []),
            },
          }
        }
        const mode = parseLoopGuardMode(body.mode)
        const hasConfigPatch =
          typeof body.enabled === 'boolean' ||
          Boolean(mode) ||
          typeof body.warnThreshold === 'number' ||
          typeof body.blockThreshold === 'number' ||
          typeof body.windowMs === 'number'
        if (hasConfigPatch) {
          manager.setLoopGuardConfig({
            ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
            ...(mode ? { mode } : {}),
            ...(typeof body.warnThreshold === 'number' ? { warnThreshold: body.warnThreshold } : {}),
            ...(typeof body.blockThreshold === 'number' ? { blockThreshold: body.blockThreshold } : {}),
            ...(typeof body.windowMs === 'number' ? { windowMs: body.windowMs } : {}),
          })
        }
        const tabId = body.tabId !== undefined ? Number(body.tabId) : undefined
        const stats = manager.getLoopGuardStats()
        const patterns = manager.getLoopGuardPatterns({
          ...(sessionId ? { sessionId } : {}),
          ...(Number.isFinite(tabId) ? { tabId } : {}),
        })
        return {
          status: 200,
          payload: {
            ok: true,
            config: manager.getLoopGuardConfig(),
            stats,
            patterns,
            ascii: formatLoopGuardAscii(stats, patterns),
          },
        }
      }
      default:
        return { status: 404, payload: { ok: false, error: `no route ${pathname}` } }
    }
  }

  const server = http.createServer((req, res) => {
    const reqStartMs = performance.now()
    const method = (req.method ?? 'GET').toUpperCase()
    let metricRoute = '/other'
    let metricRecorded = false
    metrics.onHttpRequestStart()

    const recordReqFinished = (status: number) => {
      if (metricRecorded) return
      metricRecorded = true
      metrics.recordHttpRequest({
        method,
        route: metricRoute,
        status,
        durationMs: performance.now() - reqStartMs,
      })
    }

    res.once('close', () => {
      if (!metricRecorded) {
        recordReqFinished(res.statusCode || 499)
      }
    })

    let responded = false
    const respond = (
      status: number,
      payload: Record<string, unknown>,
      extraHeaders: Record<string, string> = {},
    ) => {
      if (responded || res.writableEnded || res.headersSent) return
      responded = true
      const json = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(json),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extraHeaders,
      })
      if (method === 'HEAD') {
        res.end()
      } else {
        res.end(json)
      }
      recordReqFinished(status)
    }

    const respondText = (
      status: number,
      text: string,
      contentType: string,
      extraHeaders: Record<string, string> = {},
    ) => {
      if (responded || res.writableEnded || res.headersSent) return
      responded = true
      res.writeHead(status, {
        'content-type': contentType,
        'content-length': Buffer.byteLength(text, 'utf8'),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extraHeaders,
      })
      if (method === 'HEAD') {
        res.end()
      } else {
        res.end(text)
      }
      recordReqFinished(status)
    }

    const rawUrl = req.url ?? '/'
    if (rawUrl.length > maxUrlLength) {
      return respond(
        414,
        { ok: false, code: 'uri_too_long', error: `request URI exceeds ${maxUrlLength} bytes` },
        { connection: 'close' },
      )
    }

    const headerCheck = validateAgentRequestHeaders(req, {
      expectedPort: boundPort || undefined,
      strictPort,
    })
    if (!headerCheck.ok) {
      return respond(headerCheck.status ?? 403, {
        ok: false,
        code: headerCheck.code,
        error: headerCheck.error ?? 'wrong host',
      })
    }

    let url: URL
    try {
      url = new URL(rawUrl, 'http://127.0.0.1')
    } catch {
      return respond(400, { ok: false, code: 'invalid_url', error: 'malformed request URL' })
    }
    metricRoute = url.pathname

    const isHealthProbePath =
      (method === 'GET' || method === 'HEAD') &&
      (url.pathname === '/healthz' || url.pathname === '/livez' || url.pathname === '/readyz')
    const isGetMetricsPath = (method === 'GET' || method === 'HEAD') && url.pathname === '/metrics'

    const remoteKey = req.socket?.remoteAddress || 'loopback'

    if (isHealthProbePath && healthProbeUnauthenticated) {
      const rateDecision = rateLimiter.consume(`ip:${remoteKey}`)
      const rateHeaders = rateLimiter.config.enabled ? buildRateLimitHeaders(rateDecision) : {}
      if (!rateDecision.allowed) {
        return respond(
          429,
          {
            ok: false,
            code: rateDecision.reason ?? 'rate_limit_exceeded',
            error: 'rate limit exceeded',
            retryAfterSeconds: rateDecision.retryAfterSeconds,
          },
          rateHeaders,
        )
      }
      if (url.pathname === '/readyz') {
        const probe = evaluateReadinessProbe(buildRuntimeMetricsSource(), metrics.uptimeSeconds())
        return respond(probe.status, probe.payload as unknown as Record<string, unknown>, rateHeaders)
      }
      const probe = evaluateLivenessProbe(metrics.uptimeSeconds())
      return respond(probe.status, probe.payload as unknown as Record<string, unknown>, rateHeaders)
    }

    if (!(isGetMetricsPath && metricsUnauthenticated)) {
      const authGate = rateLimiter.checkAuthAllowed(remoteKey)
      if (!authGate.allowed) {
        return respond(
          429,
          {
            ok: false,
            code: authGate.reason ?? 'auth_rate_limit_exceeded',
            error: 'too many failed authentication attempts',
            retryAfterSeconds: authGate.retryAfterSeconds,
          },
          buildRateLimitHeaders(authGate),
        )
      }

      const authCheck = validateAgentTokenRequest(req, token, {
        allowBearer: isGetMetricsPath,
      })
      if (!authCheck.ok) {
        const failureDecision = rateLimiter.recordAuthFailure(remoteKey)
        return respond(
          401,
          { ok: false, error: authCheck.error ?? 'missing or invalid x-troy-agent token' },
          failureDecision.allowed ? {} : buildRateLimitHeaders(failureDecision),
        )
      }
    }

    const parsedHeaderSession = parseSessionId(req.headers[SESSION_HEADER])
    if (!parsedHeaderSession.ok) {
      return respond(400, { ok: false, error: parsedHeaderSession.error })
    }
    const headerSessionId = parsedHeaderSession.sessionId

    const rateKey = headerSessionId ? `session:${headerSessionId}` : `ip:${remoteKey}`
    const rateDecision = rateLimiter.consume(rateKey)
    const rateHeaders = rateLimiter.config.enabled ? buildRateLimitHeaders(rateDecision) : {}
    if (!rateDecision.allowed) {
      return respond(
        429,
        {
          ok: false,
          code: rateDecision.reason ?? 'rate_limit_exceeded',
          error: 'rate limit exceeded',
          retryAfterSeconds: rateDecision.retryAfterSeconds,
        },
        rateHeaders,
      )
    }

    if (isHealthProbePath) {
      if (url.pathname === '/readyz') {
        const probe = evaluateReadinessProbe(buildRuntimeMetricsSource(), metrics.uptimeSeconds())
        return respond(probe.status, probe.payload as unknown as Record<string, unknown>, rateHeaders)
      }
      const probe = evaluateLivenessProbe(metrics.uptimeSeconds())
      return respond(probe.status, probe.payload as unknown as Record<string, unknown>, rateHeaders)
    }

    if (isGetMetricsPath) {
      const format = (url.searchParams.get('format') ?? '').trim().toLowerCase()
      const accept = String(req.headers.accept ?? '').toLowerCase()
      const runtimeSource = buildRuntimeMetricsSource()
      if (format === 'json' || (!format && accept.includes('application/json') && !accept.includes('text/plain'))) {
        return respond(200, { ok: true, metrics: metrics.getSnapshot(runtimeSource) }, rateHeaders)
      }
      const text = metrics.renderPrometheus(runtimeSource)
      return respondText(200, text, PROMETHEUS_CONTENT_TYPE, rateHeaders)
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      handleRoute('/health', {}, headerSessionId)
        .then((r) => respond(r.status, r.payload, rateHeaders))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }, rateHeaders))
      return
    }

    if (req.method === 'GET' && url.pathname === '/watchdog') {
      handleRoute('/watchdog', {}, headerSessionId)
        .then((r) => respond(r.status, r.payload, rateHeaders))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }, rateHeaders))
      return
    }

    if (req.method === 'GET' && url.pathname === '/policy') {
      handleRoute('/policy', {}, headerSessionId)
        .then((r) => respond(r.status, r.payload, rateHeaders))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }, rateHeaders))
      return
    }

    if (req.method === 'GET' && url.pathname === '/origins') {
      handleRoute('/origins', { action: 'list' }, headerSessionId)
        .then((r) => respond(r.status, r.payload, rateHeaders))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }, rateHeaders))
      return
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      handleRoute('/sessions', {}, headerSessionId)
        .then((r) => respond(r.status, r.payload, rateHeaders))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }, rateHeaders))
      return
    }

    if (req.method === 'GET' && url.pathname === '/stream') {
      const parsed = parseSseStreamOptions(url.searchParams, headerSessionId)
      if (!parsed.ok) {
        return respond(400, { ok: false, error: parsed.error }, rateHeaders)
      }
      streamHub.attach(req, res, parsed.options)
      return
    }

    if (req.method !== 'POST') {
      return respond(405, { ok: false, error: 'POST only' }, rateHeaders)
    }

    const maxBody =
      url.pathname === '/cookies/import' || url.pathname === '/storage/import' ? maxImportBodyBytes : maxBodyBytes

    const contentLengthCheck = parseContentLengthHeader(req)
    if (!contentLengthCheck.ok) {
      return respond(
        400,
        { ok: false, code: 'invalid_content_length', error: contentLengthCheck.error },
        { ...rateHeaders, connection: 'close' },
      )
    }
    if (contentLengthCheck.length !== null && contentLengthCheck.length > maxBody) {
      req.pause()
      return respond(
        413,
        {
          ok: false,
          code: 'body_too_large',
          error: 'body too large',
          maxBytes: maxBody,
          receivedBytes: contentLengthCheck.length,
        },
        { ...rateHeaders, connection: 'close' },
      )
    }

    const chunks: Buffer[] = []
    let size = 0
    let bodySettled = false
    req.on('data', (chunk: Buffer) => {
      if (bodySettled) return
      size += chunk.length
      if (size > maxBody) {
        bodySettled = true
        chunks.length = 0
        req.pause()
        respond(
          413,
          {
            ok: false,
            code: 'body_too_large',
            error: 'body too large',
            maxBytes: maxBody,
            receivedBytes: size,
          },
          { ...rateHeaders, connection: 'close' },
        )
        return
      }
      chunks.push(chunk)
    })
    req.on('aborted', () => {
      bodySettled = true
      chunks.length = 0
    })
    req.on('error', () => {
      bodySettled = true
      chunks.length = 0
    })
    req.on('end', () => {
      if (bodySettled) return
      bodySettled = true
      const rawText = chunks.length ? Buffer.concat(chunks).toString('utf8') : ''
      const parsed = parseSafeJsonObject(rawText)
      if (!parsed.ok) {
        return respond(400, { ok: false, code: parsed.code, error: parsed.error }, rateHeaders)
      }
      handleRoute(url.pathname, parsed.body, headerSessionId)
        .then((r) => respond(r.status, r.payload, rateHeaders))
        .catch((e) => respond(500, { ok: false, error: String((e as Error)?.message ?? e) }, rateHeaders))
    })
  })

  const sockets = new Set<net.Socket>()
  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.once('close', () => sockets.delete(sock))
  })

  wsHub = new WsBridgeHub(manager, handleRoute, {
    token,
    getExpectedPort: () => (boundPort || undefined),
    strictPort,
  })
  server.on('upgrade', (req, socket, head) => {
    wsHub?.handleUpgrade(req, socket, head)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  boundPort = port
  const wsUrl = `ws://${host}:${port}/ws`

  return {
    port,
    token,
    wsUrl,
    metrics,
    ...(memoryWatchdog ? { memoryWatchdog } : {}),
    async close() {
      closing = true
      wsHub?.close()
      streamHub.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
        for (const sock of sockets) {
          sock.destroy()
        }
        sockets.clear()
      })
    },
  }
}
