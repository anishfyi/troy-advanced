// Deterministic read-only observer mode (`--readonly`).
// When enabled, all mutating tools (click, fill, select, press, hover, eval,
// navigate, history, mutating act steps, and mutating state operations) are
// deterministically refused with `status: 'blocked', code: 'readonly'`.

import type {
  PolicyDecision,
  ReadonlyModeOptions,
  ReadonlyModeStats,
  ReadonlyRefusalEvent,
} from '../types.js'

const MAX_RECENT_REFUSALS = 50

/**
 * Canonical mutating browser tools that are ALWAYS refused in read-only observer mode.
 */
export const READONLY_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'page_click',
  'page_fill',
  'page_select',
  'page_press',
  'page_hover',
  'page_eval',
  'page_navigate',
  'page_history',
  'tab_open',
  'tab_close',
  'origin_grant',
  'memory_forget',
  'cookies_import',
  'cookies_clear',
  'storage_import',
  'storage_clear',
])

/**
 * Short-name aliases mapped to canonical tool names so callers using either
 * `click` or `page_click` (or `troy_click`) are normalized deterministically.
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  click: 'page_click',
  troy_click: 'page_click',
  fill: 'page_fill',
  troy_fill: 'page_fill',
  select: 'page_select',
  troy_select: 'page_select',
  press: 'page_press',
  troy_press: 'page_press',
  hover: 'page_hover',
  troy_hover: 'page_hover',
  eval: 'page_eval',
  troy_eval: 'page_eval',
  navigate: 'page_navigate',
  troy_navigate: 'page_navigate',
  history: 'page_history',
  back: 'page_history',
  forward: 'page_history',
  reload: 'page_history',
  act: 'page_act',
  troy_act: 'page_act',
  open: 'tab_open',
  troy_open: 'tab_open',
  close: 'tab_close',
  troy_close: 'tab_close',
  grant: 'origin_grant',
  troy_grant: 'origin_grant',
  forget: 'memory_forget',
  emulate: 'page_emulate',
  troy_emulate: 'page_emulate',
  dialogs: 'page_dialogs',
  troy_dialogs: 'page_dialogs',
  downloads: 'page_downloads',
  troy_downloads: 'page_downloads',
  console: 'page_console',
  network: 'page_network',
  troy_network: 'page_network',
})

export function normalizeReadonlyToolName(name: string): string {
  const trimmed = String(name ?? '').trim().toLowerCase()
  return TOOL_ALIASES[trimmed] ?? trimmed
}

export function parseReadonlyBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return true
    if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false
  }
  return undefined
}

export interface MutatingToolCheck {
  mutating: boolean
  canonicalTool: string
  reason?: string
}

function hasEmulationMutation(args?: Record<string, unknown>): boolean {
  if (!args) return false
  return (
    args.viewport !== undefined ||
    args.userAgent !== undefined ||
    args.acceptLanguage !== undefined ||
    args.platform !== undefined ||
    args.extraHeaders !== undefined ||
    args.headers !== undefined ||
    Boolean(args.clearHeaders) ||
    (Array.isArray(args.removeHeaders) && args.removeHeaders.length > 0)
  )
}

function hasDialogsMutation(args?: Record<string, unknown>): boolean {
  if (!args) return false
  return (
    Boolean(args.clear) ||
    Boolean(args.clearQueue) ||
    args.mode !== undefined ||
    typeof args.acceptBeforeUnload === 'boolean' ||
    typeof args.defaultPromptText === 'string' ||
    (typeof args.next === 'object' && args.next !== null) ||
    typeof args.queueAccept === 'boolean'
  )
}

function hasDownloadsMutation(args?: Record<string, unknown>): boolean {
  if (!args) return false
  return Boolean(args.clear) || args.mode !== undefined || args.maxBytes !== undefined
}

/**
 * Determine whether a tool invocation is mutating and must be refused in
 * read-only observer mode (`--readonly`).
 */
export function isMutatingTool(
  name: string,
  args?: Record<string, unknown>,
): MutatingToolCheck {
  const canonicalTool = normalizeReadonlyToolName(name)

  if (READONLY_MUTATING_TOOLS.has(canonicalTool)) {
    return {
      mutating: true,
      canonicalTool,
      reason: `tool "${canonicalTool}" is refused in read-only observer mode (--readonly)`,
    }
  }

  if (canonicalTool === 'page_act') {
    const rawSteps = Array.isArray(args?.steps) ? args.steps : []
    for (let i = 0; i < rawSteps.length; i++) {
      const step = rawSteps[i] as Record<string, unknown> | null | undefined
      const op = typeof step?.op === 'string' ? step.op.trim().toLowerCase() : ''
      if (!op) continue
      const stepTool = op === 'read_ascii' ? 'page_read_ascii' : normalizeReadonlyToolName(`page_${op}`)
      if (READONLY_MUTATING_TOOLS.has(stepTool)) {
        return {
          mutating: true,
          canonicalTool: 'page_act',
          reason: `page_act step #${i} ("${op}" -> ${stepTool}) is refused in read-only observer mode (--readonly)`,
        }
      }
    }
    return { mutating: false, canonicalTool: 'page_act' }
  }

  if (canonicalTool === 'page_emulate') {
    if (hasEmulationMutation(args)) {
      return {
        mutating: true,
        canonicalTool: 'page_emulate',
        reason: 'modifying emulation settings via page_emulate is refused in read-only observer mode (--readonly)',
      }
    }
    return { mutating: false, canonicalTool: 'page_emulate' }
  }

  if (canonicalTool === 'page_dialogs') {
    if (hasDialogsMutation(args)) {
      return {
        mutating: true,
        canonicalTool: 'page_dialogs',
        reason: 'mutating dialog policy/queue via page_dialogs is refused in read-only observer mode (--readonly)',
      }
    }
    return { mutating: false, canonicalTool: 'page_dialogs' }
  }

  if (canonicalTool === 'page_downloads') {
    if (hasDownloadsMutation(args)) {
      return {
        mutating: true,
        canonicalTool: 'page_downloads',
        reason: 'mutating download policy/history via page_downloads is refused in read-only observer mode (--readonly)',
      }
    }
    return { mutating: false, canonicalTool: 'page_downloads' }
  }

  if (canonicalTool === 'page_console' || canonicalTool === 'page_network') {
    if (args?.clear) {
      return {
        mutating: true,
        canonicalTool,
        reason: `clearing ${canonicalTool} buffer is refused in read-only observer mode (--readonly)`,
      }
    }
    return { mutating: false, canonicalTool }
  }

  return { mutating: false, canonicalTool }
}

/**
 * Check whether an Agent Socket HTTP/WS endpoint call is mutating.
 * Note: `/tool`, `/open`, `/close`, `/grant-origin` are enforced directly by
 * `BrowserManager`, so this covers both those and direct state endpoints.
 */
export function isMutatingEndpoint(
  pathname: string,
  body?: Record<string, unknown>,
): MutatingToolCheck {
  switch (pathname) {
    case '/open':
      return {
        mutating: true,
        canonicalTool: 'tab_open',
        reason: 'POST /open is refused in read-only observer mode (--readonly)',
      }
    case '/close':
      return {
        mutating: true,
        canonicalTool: 'tab_close',
        reason: 'POST /close is refused in read-only observer mode (--readonly)',
      }
    case '/grant-origin':
      return {
        mutating: true,
        canonicalTool: 'origin_grant',
        reason: 'POST /grant-origin is refused in read-only observer mode (--readonly)',
      }
    case '/forget':
      return {
        mutating: true,
        canonicalTool: 'memory_forget',
        reason: 'POST /forget is refused in read-only observer mode (--readonly)',
      }
    case '/cookies/import':
      return {
        mutating: true,
        canonicalTool: 'cookies_import',
        reason: 'POST /cookies/import is refused in read-only observer mode (--readonly)',
      }
    case '/cookies/clear':
      return {
        mutating: true,
        canonicalTool: 'cookies_clear',
        reason: 'POST /cookies/clear is refused in read-only observer mode (--readonly)',
      }
    case '/storage/import':
      return {
        mutating: true,
        canonicalTool: 'storage_import',
        reason: 'POST /storage/import is refused in read-only observer mode (--readonly)',
      }
    case '/storage/clear':
      return {
        mutating: true,
        canonicalTool: 'storage_clear',
        reason: 'POST /storage/clear is refused in read-only observer mode (--readonly)',
      }
    case '/emulation':
      return isMutatingTool('page_emulate', body)
    case '/downloads':
      return isMutatingTool('page_downloads', body)
    case '/dialogs':
      return isMutatingTool('page_dialogs', body)
    case '/audit':
      if (body?.clear) {
        return {
          mutating: true,
          canonicalTool: 'audit_clear',
          reason: 'clearing audit log is refused in read-only observer mode (--readonly)',
        }
      }
      return { mutating: false, canonicalTool: 'audit' }
    case '/loop-guard':
      if (body?.reset) {
        return {
          mutating: true,
          canonicalTool: 'loop_guard_reset',
          reason: 'resetting loop guard is refused in read-only observer mode (--readonly)',
        }
      }
      return { mutating: false, canonicalTool: 'loop_guard' }
    case '/sessions':
      if (body?.close) {
        return {
          mutating: true,
          canonicalTool: 'session_close',
          reason: 'closing sessions is refused in read-only observer mode (--readonly)',
        }
      }
      return { mutating: false, canonicalTool: 'sessions' }
    default:
      return { mutating: false, canonicalTool: pathname }
  }
}

/**
 * Stateful guard attached to BrowserManager for read-only observer mode (`--readonly`).
 */
export class ReadonlyObserverGuard {
  readonly enabled: boolean
  private blockedCount = 0
  private blockedByTool = new Map<string, number>()
  private recentBlocked: ReadonlyRefusalEvent[] = []

  constructor(opts?: boolean | ReadonlyModeOptions) {
    if (typeof opts === 'boolean') {
      this.enabled = opts
    } else if (opts && typeof opts === 'object') {
      this.enabled = Boolean(opts.enabled)
    } else {
      this.enabled = false
    }
  }

  private recordRefusal(
    tool: string,
    reason: string,
    ctx?: { tabId?: number; sessionId?: string; url?: string },
  ): void {
    this.blockedCount += 1
    this.blockedByTool.set(tool, (this.blockedByTool.get(tool) ?? 0) + 1)
    this.recentBlocked.push({
      ts: Date.now(),
      tool,
      reason,
      ...(ctx?.tabId !== undefined ? { tabId: ctx.tabId } : {}),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.url ? { url: ctx.url } : {}),
    })
    if (this.recentBlocked.length > MAX_RECENT_REFUSALS) {
      this.recentBlocked.splice(0, this.recentBlocked.length - MAX_RECENT_REFUSALS)
    }
  }

  checkTool(
    name: string,
    args?: Record<string, unknown>,
    ctx?: { tabId?: number; sessionId?: string; url?: string },
  ): PolicyDecision {
    if (!this.enabled) return { allowed: true }
    const check = isMutatingTool(name, args)
    if (!check.mutating) return { allowed: true }
    const reason = check.reason ?? `tool "${check.canonicalTool}" is refused in read-only observer mode (--readonly)`
    this.recordRefusal(check.canonicalTool, reason, ctx)
    return {
      allowed: false,
      status: 'blocked',
      code: 'readonly',
      reason,
    }
  }

  checkEndpoint(
    pathname: string,
    body?: Record<string, unknown>,
    ctx?: { tabId?: number; sessionId?: string; url?: string },
  ): PolicyDecision {
    if (!this.enabled) return { allowed: true }
    const check = isMutatingEndpoint(pathname, body)
    if (!check.mutating) return { allowed: true }
    const reason = check.reason ?? `endpoint "${pathname}" is refused in read-only observer mode (--readonly)`
    this.recordRefusal(check.canonicalTool, reason, ctx)
    return {
      allowed: false,
      status: 'blocked',
      code: 'readonly',
      reason,
    }
  }

  getStats(): ReadonlyModeStats {
    const blockedByTool: Record<string, number> = {}
    for (const [k, v] of this.blockedByTool.entries()) {
      blockedByTool[k] = v
    }
    return {
      enabled: this.enabled,
      mutatingTools: [...READONLY_MUTATING_TOOLS],
      blockedCount: this.blockedCount,
      blockedByTool,
      recentBlocked: [...this.recentBlocked],
    }
  }
}

export function formatReadonlyAscii(stats: ReadonlyModeStats): string {
  const lines = [
    '+-- Read-Only Observer Mode --+',
    `| Enabled      : ${stats.enabled ? 'YES (--readonly)' : 'NO'}`,
    `| Blocked Calls: ${stats.blockedCount}`,
    `| Refused Tools: ${stats.mutatingTools.join(', ')}`,
  ]
  const entries = Object.entries(stats.blockedByTool)
  if (entries.length > 0) {
    lines.push(`| By Tool      : ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  lines.push('+-----------------------------+')
  return lines.join('\n')
}
