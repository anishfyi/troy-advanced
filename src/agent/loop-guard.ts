// Agent Loop Guard (M69):
// Detects repeated identical failing tool calls per (session, tab) scope and
// attaches deterministic, actionable recovery hints (and optional short-circuit
// blocking in `block` mode) so AI agents break out of failure loops immediately.

import { createHash } from 'node:crypto'
import type {
  LoopGuardCategory,
  LoopGuardMode,
  LoopGuardOptions,
  LoopGuardReport,
  LoopGuardSeverity,
  LoopGuardStats,
  LoopGuardSuggestedAction,
} from '../types.js'

const DEFAULT_WARN_THRESHOLD = 2
const DEFAULT_BLOCK_THRESHOLD = 4
const DEFAULT_WINDOW_MS = 120_000
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 32
const MAX_ARG_STRING_LEN = 160

/**
 * Read-only observation tools whose success does NOT prove that the underlying
 * page state changed. Keeping failure streaks alive across read-only checks
 * catches classic A -> read -> A -> read agent loops.
 */
const READ_ONLY_TOOLS = new Set([
  'page_read',
  'page_read_ascii',
  'page_read_visual',
  'page_read_markdown',
  'page_text',
  'page_find',
  'page_extract',
  'page_screenshot',
  'page_screenshot_ascii',
  'page_console',
  'page_network',
  'page_network_body',
  'page_downloads',
  'page_dialogs',
  'page_emulate',
])

/** Formatting-only arguments that do not alter the semantic action being attempted. */
const EPHEMERAL_ARG_KEYS = new Set([
  'width',
  'height',
  'asciiOnly',
  'color',
  'showChrome',
  'density',
  'maxTokens',
  'max_tokens',
  'ascii',
])

export interface LoopGuardConfig {
  enabled: boolean
  mode: LoopGuardMode
  warnThreshold: number
  blockThreshold: number
  windowMs: number
  maxEntriesPerScope: number
}

export interface LoopGuardActionContext {
  tool: string
  args?: Record<string, unknown>
  tabId?: number
  sessionId?: string
  url?: string
  epoch?: number
  nowMs?: number
}

export interface LoopGuardFailureContext extends LoopGuardActionContext {
  error?: string
  code?: string
  status?: string
  origin?: string
}

interface FailureRecord {
  actionKey: string
  signature: string
  tool: string
  args: Record<string, unknown>
  url: string
  epoch: number | undefined
  errorFingerprint: string
  lastError: string
  code?: string
  status?: string
  origin?: string
  category: LoopGuardCategory
  repeatCount: number
  firstSeenMs: number
  lastSeenMs: number
}

interface ScopeState {
  lastUrl?: string
  lastEpoch?: number
  failures: Map<string, FailureRecord>
}

export function parseLoopGuardMode(value: unknown): LoopGuardMode | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'advisory' || normalized === 'block') return normalized
  return undefined
}

function stableNormalizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]'
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > MAX_ARG_STRING_LEN ? trimmed.slice(0, MAX_ARG_STRING_LEN) : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => stableNormalizeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => v !== undefined && !EPHEMERAL_ARG_KEYS.has(k))
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [k, v] of entries) {
      out[k] = stableNormalizeValue(v, depth + 1)
    }
    return out
  }
  return String(value)
}

export function canonicalizeArgs(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '{}'
  try {
    return JSON.stringify(stableNormalizeValue(args))
  } catch {
    return '{}'
  }
}

/**
 * Strip volatile numbers (e.g. durations like `1500ms`, timestamps, port/req IDs)
 * so repeated identical errors hash to the same fingerprint.
 */
export function normalizeErrorFingerprint(code?: string, error?: string): string {
  const cleanCode = (code ?? '').trim().toLowerCase()
  const cleanMsg = (error ?? '')
    .trim()
    .toLowerCase()
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, '<duration>')
    .replace(/\b\d{10,}\b/g, '<ts>')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  return `${cleanCode}|${cleanMsg}`
}

export function buildActionKey(tool: string, args?: Record<string, unknown>): string {
  return `${tool.trim().toLowerCase()}:${canonicalizeArgs(args)}`
}

export function buildSignatureHash(actionKey: string, errorFingerprint?: string): string {
  const payload = errorFingerprint ? `${actionKey}::${errorFingerprint}` : actionKey
  return createHash('sha256').update(payload).digest('hex').slice(0, 12)
}

export function classifyFailureCategory(ctx: {
  tool: string
  code?: string
  status?: string
  error?: string
}): LoopGuardCategory {
  const code = (ctx.code ?? '').trim().toLowerCase()
  const err = (ctx.error ?? '').trim().toLowerCase()
  const tool = ctx.tool.trim().toLowerCase()

  if (code === 'origin') return 'origin_boundary'
  if (code === 'submit') return 'submit_guard'
  if (code === 'sensitive') return 'sensitive_field'
  if (code === 'scheme') return 'blocked_scheme'
  if (code === 'session_isolation') return 'session_isolation'
  if (code === 'no-tab' || /\bno (open |such )?tab\b|\bno tab \d+/i.test(err)) return 'no_tab'

  if (/\bunknown tool\b/i.test(err)) return 'unknown_tool'

  if (
    code === 'stale-ref' ||
    code === 'unknown-ref' ||
    /\bunknown ref\b|\bstale ref\b|\bno such ref\b|\be\d+\s+is stale\b|\belement reference is missing or malformed\b|\bbelongs to an older page state\b|\bread the page again\b|\bref\b.*\b(not found|stale|expired|missing|invalid)\b|\bbelongs to a different\b|\belement not found\b|\bno element\b/i.test(
      err,
    )
  ) {
    return 'stale_or_unknown_ref'
  }

  if (tool === 'page_wait' || /\btimed?\s*out\b|\btimeout\b/i.test(err)) {
    return 'wait_timeout'
  }

  if (tool === 'page_navigate' || /\benotfound\b|\beconnrefused\b|\bfetch failed\b|\bnet::err_/i.test(err)) {
    return 'navigation_failed'
  }

  if (
    tool === 'page_click' ||
    tool === 'page_fill' ||
    tool === 'page_select' ||
    tool === 'page_press' ||
    tool === 'page_hover'
  ) {
    return 'interaction_failed'
  }

  return 'repeated_failure'
}

export function buildRecoveryHints(params: {
  category: LoopGuardCategory
  tool: string
  args?: Record<string, unknown>
  error?: string
  origin?: string
  repeatCount: number
}): { hint: string; recoveryHints: string[]; suggestedAction?: LoopGuardSuggestedAction } {
  const args = params.args ?? {}
  const ref = typeof args.ref === 'string' ? args.ref : undefined
  const url = typeof args.url === 'string' ? args.url : undefined
  const origin = params.origin || extractOriginFromError(params.error)

  switch (params.category) {
    case 'origin_boundary': {
      const target = origin ?? 'the target origin'
      return {
        hint: `Repeated origin refusal for ${target}. Grant the origin before retrying.`,
        recoveryHints: [
          `Origin ${target} is outside the authorized origins for this session.`,
          origin
            ? `Call /grant-origin with { origin: "${origin}" } (or troy grant) before retrying ${params.tool}.`
            : `Call /grant-origin with the target http(s) origin before retrying ${params.tool}.`,
          'Alternatively, stay within origins already authorized for this session.',
        ],
        suggestedAction: origin
          ? { endpoint: '/grant-origin', args: { origin }, reason: 'authorize_origin' }
          : { endpoint: '/grant-origin', reason: 'authorize_origin' },
      }
    }

    case 'submit_guard': {
      return {
        hint: `Repeated submit-guard refusal on ${params.tool}. Pass allowSubmit: true to confirm.`,
        recoveryHints: [
          'This element is classified as a form submit or destructive commit control.',
          `Re-run ${params.tool} with { allowSubmit: true } once you have verified the form fields are correct.`,
          'Use page_read_ascii or page_extract first if you need to double-check field values before submitting.',
        ],
        suggestedAction: {
          tool: params.tool,
          args: { ...args, allowSubmit: true },
          reason: 'confirm_submit_action',
        },
      }
    }

    case 'sensitive_field': {
      return {
        hint: 'Sensitive field is permanently blocked for autonomous agents. Do not retry; ask the user.',
        recoveryHints: [
          'Password, OTP/2FA, payment card, file upload, and government ID fields are deterministically blocked.',
          'Stop retrying this action — ask the user to complete the field manually or import a pre-authenticated session via cookies/storage.',
        ],
        suggestedAction: {
          action: 'ask_user',
          reason: 'sensitive_field_requires_human',
        },
      }
    }

    case 'blocked_scheme': {
      return {
        hint: 'Blocked URL scheme. Only http:// and https:// URLs are allowed.',
        recoveryHints: [
          'Non-HTTP(S) schemes (javascript:, file:, data:, chrome:, about:) are blocked by policy.',
          'Navigate to a valid http:// or https:// URL instead.',
        ],
      }
    }

    case 'session_isolation': {
      return {
        hint: 'Target tab belongs to another agent session. List your session tabs or open a new tab.',
        recoveryHints: [
          'Multi-agent session isolation prevents operating on tabs owned by another x-troy-session.',
          'Call /tabs with your x-troy-session header to see your own tabs, or call /open to create a tab owned by your session.',
        ],
        suggestedAction: {
          endpoint: '/tabs',
          reason: 'list_session_tabs',
        },
      }
    }

    case 'stale_or_unknown_ref': {
      return {
        hint: `Ref ${ref ? `"${ref}"` : ''} is stale or unknown. Refresh the page snapshot and re-locate the element.`.replace(
          /\s+/g,
          ' ',
        ),
        recoveryHints: [
          ref
            ? `Ref "${ref}" is not valid in the current DOM epoch.`
            : 'The requested element ref is not valid in the current DOM epoch.',
          'Call page_read_ascii (or page_read) to capture fresh eN refs.',
          'Use page_find with text, label, or ARIA role filters (e.g. role: "button" | "input" | "link") to locate the target element.',
        ],
        suggestedAction: {
          tool: 'page_read_ascii',
          args: {},
          reason: 'refresh_stale_refs',
        },
      }
    }

    case 'wait_timeout': {
      return {
        hint: 'Wait condition repeatedly timed out. Inspect the live page and console before waiting again.',
        recoveryHints: [
          'The expected text, selector, URL, or state did not appear before the timeout expired.',
          'Call page_read_ascii to inspect what is currently rendered (e.g. an error banner, modal, or login wall).',
          'Check page_console and page_dialogs for JavaScript errors or blocking browser dialogs, or adjust the wait condition/timeoutMs.',
        ],
        suggestedAction: {
          tool: 'page_read_ascii',
          args: {},
          reason: 'inspect_page_after_timeout',
        },
      }
    }

    case 'no_tab': {
      return {
        hint: 'No valid target tab is open. Open a tab or list available tabs first.',
        recoveryHints: [
          'The referenced tabId does not exist or has already been closed.',
          'Call /tabs to list open tabs or /open with a URL to open a new tab before calling page tools.',
        ],
        suggestedAction: {
          endpoint: '/open',
          reason: 'open_new_tab',
        },
      }
    }

    case 'navigation_failed': {
      return {
        hint: `Navigation repeatedly failed${url ? ` for "${url}"` : ''}. Check URL and network diagnostics.`,
        recoveryHints: [
          url ? `Navigation to "${url}" failed repeatedly.` : 'Navigation failed repeatedly.',
          'Verify the hostname, port, and path, and inspect page_network for HTTP status codes or connection errors.',
          'Avoid blind retries if the server is unreachable or returning a deterministic 4xx/5xx error.',
        ],
        suggestedAction: {
          tool: 'page_network',
          args: { limit: 20 },
          reason: 'inspect_network_errors',
        },
      }
    }

    case 'interaction_failed': {
      const specificHint =
        params.tool === 'page_select'
          ? 'Use page_extract or page_read_ascii to inspect the valid <option> values and labels before calling page_select.'
          : params.tool === 'page_fill'
            ? 'Verify the target ref is an editable <input> or <textarea> (not disabled or read-only).'
            : 'Verify the element is visible, enabled, and not covered by a modal or offscreen; try page_scroll or page_read_ascii.'
      return {
        hint: `${params.tool}${ref ? `(${ref})` : ''} failed ${params.repeatCount} times. Refresh refs and verify element state.`,
        recoveryHints: [
          `Repeated ${params.tool} failure${ref ? ` on ref "${ref}"` : ''}${params.error ? `: ${params.error}` : ''}.`,
          specificHint,
          'Call page_read_ascii or page_find to confirm the element still matches what you intend to operate.',
        ],
        suggestedAction: {
          tool: 'page_read_ascii',
          args: {},
          reason: 'refresh_and_verify_element',
        },
      }
    }

    case 'unknown_tool': {
      return {
        hint: `Tool "${params.tool}" does not exist. Use a supported troy-advanced tool name.`,
        recoveryHints: [
          `"${params.tool}" is not a registered tool.`,
          'Common tools: page_read_ascii, page_read, page_find, page_extract, page_click, page_fill, page_select, page_press, page_navigate, page_wait, page_act.',
        ],
      }
    }

    default: {
      return {
        hint: `Action "${params.tool}" failed ${params.repeatCount} times identically. Change strategy instead of retrying.`,
        recoveryHints: [
          `Identical call to "${params.tool}" has failed ${params.repeatCount} times with the same error.`,
          'Inspect page_read_ascii, page_console, or page_network to diagnose the root cause before trying a different action.',
        ],
        suggestedAction: {
          tool: 'page_read_ascii',
          args: {},
          reason: 'diagnose_repeated_failure',
        },
      }
    }
  }
}

function extractOriginFromError(error?: string): string | undefined {
  if (!error) return undefined
  const m = error.match(/https?:\/\/[^\s"'<>]+/i)
  if (!m) return undefined
  try {
    return new URL(m[0]).origin
  } catch {
    return undefined
  }
}

function makeScopeKey(sessionId?: string, tabId?: number): string {
  const s = sessionId && sessionId.trim() ? sessionId.trim() : 'default'
  const t = typeof tabId === 'number' && Number.isFinite(tabId) ? String(tabId) : 'none'
  return `${s}::${t}`
}

export class AgentLoopGuard {
  private config: LoopGuardConfig
  private scopes = new Map<string, ScopeState>()
  private warningsIssued = 0
  private criticalDetected = 0
  private actionsBlocked = 0
  private byCategory = new Map<string, number>()
  private byTool = new Map<string, number>()

  constructor(opts: LoopGuardOptions = {}) {
    this.config = this.normalizeConfig({
      enabled: opts.enabled ?? true,
      mode: opts.mode ?? 'advisory',
      warnThreshold: opts.warnThreshold ?? DEFAULT_WARN_THRESHOLD,
      blockThreshold: opts.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD,
      windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
      maxEntriesPerScope: opts.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE,
    })
  }

  private normalizeConfig(cfg: LoopGuardConfig): LoopGuardConfig {
    const warnThreshold = Math.max(2, Math.floor(Number.isFinite(cfg.warnThreshold) ? cfg.warnThreshold : DEFAULT_WARN_THRESHOLD))
    const rawBlock = Math.floor(Number.isFinite(cfg.blockThreshold) ? cfg.blockThreshold : DEFAULT_BLOCK_THRESHOLD)
    const blockThreshold = Math.max(warnThreshold, rawBlock)
    const windowMs = Math.max(1000, Math.floor(Number.isFinite(cfg.windowMs) ? cfg.windowMs : DEFAULT_WINDOW_MS))
    const maxEntriesPerScope = Math.max(
      4,
      Math.floor(Number.isFinite(cfg.maxEntriesPerScope) ? cfg.maxEntriesPerScope : DEFAULT_MAX_ENTRIES_PER_SCOPE),
    )
    const mode: LoopGuardMode = cfg.mode === 'block' ? 'block' : 'advisory'
    return {
      enabled: Boolean(cfg.enabled),
      mode,
      warnThreshold,
      blockThreshold,
      windowMs,
      maxEntriesPerScope,
    }
  }

  getConfig(): LoopGuardConfig {
    return { ...this.config }
  }

  setConfig(patch: LoopGuardOptions): LoopGuardConfig {
    this.config = this.normalizeConfig({
      enabled: patch.enabled ?? this.config.enabled,
      mode: patch.mode ?? this.config.mode,
      warnThreshold: patch.warnThreshold ?? this.config.warnThreshold,
      blockThreshold: patch.blockThreshold ?? this.config.blockThreshold,
      windowMs: patch.windowMs ?? this.config.windowMs,
      maxEntriesPerScope: patch.maxEntriesPerScope ?? this.config.maxEntriesPerScope,
    })
    return this.getConfig()
  }

  private getOrCreateScope(scopeKey: string): ScopeState {
    let scope = this.scopes.get(scopeKey)
    if (!scope) {
      scope = { failures: new Map() }
      this.scopes.set(scopeKey, scope)
    }
    return scope
  }

  private pruneExpired(scope: ScopeState, nowMs: number): void {
    const cutoff = nowMs - this.config.windowMs
    for (const [k, rec] of scope.failures.entries()) {
      if (rec.lastSeenMs < cutoff) {
        scope.failures.delete(k)
      }
    }
    while (scope.failures.size > this.config.maxEntriesPerScope) {
      const oldestKey = scope.failures.keys().next().value
      if (oldestKey === undefined) break
      scope.failures.delete(oldestKey)
    }
  }

  private hasPageStateChanged(scope: ScopeState, url?: string, epoch?: number): boolean {
    if (url !== undefined && scope.lastUrl !== undefined && url !== scope.lastUrl) {
      return true
    }
    if (epoch !== undefined && scope.lastEpoch !== undefined && epoch !== scope.lastEpoch) {
      return true
    }
    return false
  }

  /**
   * Pre-execution guard check.
   * Only short-circuits when `enabled === true` AND `mode === 'block'` AND the
   * exact same action at the exact same URL+epoch has already failed
   * `blockThreshold - 1` times within `windowMs`.
   */
  checkBeforeExecution(ctx: LoopGuardActionContext): LoopGuardReport | null {
    if (!this.config.enabled || this.config.mode !== 'block') return null
    const nowMs = ctx.nowMs ?? Date.now()
    const scopeKey = makeScopeKey(ctx.sessionId, ctx.tabId)
    const scope = this.scopes.get(scopeKey)
    if (!scope) return null

    if (this.hasPageStateChanged(scope, ctx.url, ctx.epoch)) {
      scope.failures.clear()
      scope.lastUrl = ctx.url
      scope.lastEpoch = ctx.epoch
      return null
    }

    this.pruneExpired(scope, nowMs)
    const actionKey = buildActionKey(ctx.tool, ctx.args)

    // Find the highest-count active failure record matching this exact actionKey
    let match: FailureRecord | null = null
    for (const rec of scope.failures.values()) {
      if (rec.actionKey === actionKey) {
        if (!match || rec.repeatCount > match.repeatCount) {
          match = rec
        }
      }
    }

    if (!match) return null
    // Already failed (blockThreshold - 1) times -> this attempt is the blockThreshold-th attempt
    if (match.repeatCount + 1 < this.config.blockThreshold) return null

    match.repeatCount += 1
    match.lastSeenMs = nowMs
    this.actionsBlocked += 1
    this.criticalDetected += 1
    this.byCategory.set(match.category, (this.byCategory.get(match.category) ?? 0) + 1)
    this.byTool.set(match.tool, (this.byTool.get(match.tool) ?? 0) + 1)

    const { hint, recoveryHints, suggestedAction } = buildRecoveryHints({
      category: match.category,
      tool: match.tool,
      args: ctx.args,
      error: match.lastError,
      origin: match.origin,
      repeatCount: match.repeatCount,
    })

    return {
      detected: true,
      blocked: true,
      severity: 'critical',
      repeatCount: match.repeatCount,
      warnThreshold: this.config.warnThreshold,
      blockThreshold: this.config.blockThreshold,
      category: match.category,
      tool: match.tool,
      signature: match.signature,
      hint,
      recoveryHints,
      ...(suggestedAction ? { suggestedAction } : {}),
      firstSeenMs: match.firstSeenMs,
      lastSeenMs: match.lastSeenMs,
    }
  }

  /**
   * Record a failed tool execution and return a LoopGuardReport when
   * `repeatCount >= warnThreshold`.
   */
  recordFailure(ctx: LoopGuardFailureContext): LoopGuardReport | null {
    if (!this.config.enabled) return null
    const nowMs = ctx.nowMs ?? Date.now()
    const scopeKey = makeScopeKey(ctx.sessionId, ctx.tabId)
    const scope = this.getOrCreateScope(scopeKey)

    if (this.hasPageStateChanged(scope, ctx.url, ctx.epoch)) {
      scope.failures.clear()
    }
    scope.lastUrl = ctx.url
    scope.lastEpoch = ctx.epoch
    this.pruneExpired(scope, nowMs)

    const actionKey = buildActionKey(ctx.tool, ctx.args)
    const errorFingerprint = normalizeErrorFingerprint(ctx.code, ctx.error)
    const bucketKey = `${actionKey}::${errorFingerprint}`
    const existing = scope.failures.get(bucketKey)
    const category = classifyFailureCategory({
      tool: ctx.tool,
      code: ctx.code,
      status: ctx.status,
      error: ctx.error,
    })

    let rec: FailureRecord
    if (existing) {
      existing.repeatCount += 1
      existing.lastSeenMs = nowMs
      existing.lastError = ctx.error ?? existing.lastError
      existing.origin = ctx.origin ?? existing.origin
      existing.category = category
      // Refresh insertion order for LRU eviction
      scope.failures.delete(bucketKey)
      scope.failures.set(bucketKey, existing)
      rec = existing
    } else {
      rec = {
        actionKey,
        signature: buildSignatureHash(actionKey, errorFingerprint),
        tool: ctx.tool,
        args: ctx.args ? { ...ctx.args } : {},
        url: ctx.url ?? '',
        epoch: ctx.epoch,
        errorFingerprint,
        lastError: ctx.error ?? '',
        code: ctx.code,
        status: ctx.status,
        origin: ctx.origin,
        category,
        repeatCount: 1,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
      }
      scope.failures.set(bucketKey, rec)
      this.pruneExpired(scope, nowMs)
    }

    if (rec.repeatCount < this.config.warnThreshold) {
      return null
    }

    const severity: LoopGuardSeverity = rec.repeatCount >= this.config.blockThreshold ? 'critical' : 'warning'
    this.warningsIssued += 1
    if (severity === 'critical') {
      this.criticalDetected += 1
    }
    this.byCategory.set(rec.category, (this.byCategory.get(rec.category) ?? 0) + 1)
    this.byTool.set(rec.tool, (this.byTool.get(rec.tool) ?? 0) + 1)

    const { hint, recoveryHints, suggestedAction } = buildRecoveryHints({
      category: rec.category,
      tool: rec.tool,
      args: ctx.args,
      error: rec.lastError,
      origin: rec.origin,
      repeatCount: rec.repeatCount,
    })

    return {
      detected: true,
      blocked: false,
      severity,
      repeatCount: rec.repeatCount,
      warnThreshold: this.config.warnThreshold,
      blockThreshold: this.config.blockThreshold,
      category: rec.category,
      tool: rec.tool,
      signature: rec.signature,
      hint,
      recoveryHints,
      ...(suggestedAction ? { suggestedAction } : {}),
      firstSeenMs: rec.firstSeenMs,
      lastSeenMs: rec.lastSeenMs,
    }
  }

  /**
   * Record a successful tool execution.
   * - If the page URL/epoch changed OR the tool is a mutating action, reset the
   *   failure streaks for this scope because the underlying state progressed.
   * - If the tool is a read-only observation on the same URL+epoch, keep prior
   *   failure streaks intact so A -> read -> A -> read loops are still caught.
   */
  recordSuccess(ctx: LoopGuardActionContext): void {
    const scopeKey = makeScopeKey(ctx.sessionId, ctx.tabId)
    const scope = this.scopes.get(scopeKey)
    if (!scope) return

    const stateChanged = this.hasPageStateChanged(scope, ctx.url, ctx.epoch)
    const isReadOnly = READ_ONLY_TOOLS.has(ctx.tool.trim().toLowerCase())

    if (stateChanged || !isReadOnly) {
      scope.failures.clear()
    }
    scope.lastUrl = ctx.url
    scope.lastEpoch = ctx.epoch
  }

  /** Clear tracked failure streaks for a specific tab, session, or all scopes. */
  reset(filter?: { sessionId?: string; tabId?: number; category?: LoopGuardCategory }): number {
    if (!filter || (filter.sessionId === undefined && filter.tabId === undefined && filter.category === undefined)) {
      let cleared = 0
      for (const s of this.scopes.values()) cleared += s.failures.size
      this.scopes.clear()
      return cleared
    }

    let cleared = 0
    for (const [key, scope] of this.scopes.entries()) {
      const [sId, tId] = key.split('::')
      const sessionMatches =
        filter.sessionId === undefined || sId === (filter.sessionId.trim() || 'default')
      const tabMatches =
        filter.tabId === undefined || tId === String(filter.tabId)
      if (!sessionMatches || !tabMatches) continue

      if (filter.category) {
        for (const [bk, rec] of scope.failures.entries()) {
          if (rec.category === filter.category) {
            scope.failures.delete(bk)
            cleared += 1
          }
        }
      } else {
        cleared += scope.failures.size
        scope.failures.clear()
      }

      if (scope.failures.size === 0) {
        this.scopes.delete(key)
      }
    }
    return cleared
  }

  getActivePatterns(filter?: { sessionId?: string; tabId?: number }): Array<{
    scope: string
    tool: string
    category: LoopGuardCategory
    repeatCount: number
    signature: string
    lastError: string
    url: string
    firstSeenMs: number
    lastSeenMs: number
  }> {
    const nowMs = Date.now()
    const out: Array<{
      scope: string
      tool: string
      category: LoopGuardCategory
      repeatCount: number
      signature: string
      lastError: string
      url: string
      firstSeenMs: number
      lastSeenMs: number
    }> = []

    for (const [scopeKey, scope] of this.scopes.entries()) {
      const [sId, tId] = scopeKey.split('::')
      if (filter?.sessionId !== undefined && sId !== (filter.sessionId.trim() || 'default')) continue
      if (filter?.tabId !== undefined && tId !== String(filter.tabId)) continue
      this.pruneExpired(scope, nowMs)
      for (const rec of scope.failures.values()) {
        out.push({
          scope: scopeKey,
          tool: rec.tool,
          category: rec.category,
          repeatCount: rec.repeatCount,
          signature: rec.signature,
          lastError: rec.lastError,
          url: rec.url,
          firstSeenMs: rec.firstSeenMs,
          lastSeenMs: rec.lastSeenMs,
        })
      }
    }
    return out.sort((a, b) => b.repeatCount - a.repeatCount || b.lastSeenMs - a.lastSeenMs)
  }

  getStats(): LoopGuardStats {
    const nowMs = Date.now()
    let trackedPatterns = 0
    for (const scope of this.scopes.values()) {
      this.pruneExpired(scope, nowMs)
      trackedPatterns += scope.failures.size
    }
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      warnThreshold: this.config.warnThreshold,
      blockThreshold: this.config.blockThreshold,
      windowMs: this.config.windowMs,
      activeScopes: this.scopes.size,
      trackedPatterns,
      warningsIssued: this.warningsIssued,
      criticalDetected: this.criticalDetected,
      actionsBlocked: this.actionsBlocked,
      byCategory: Object.fromEntries(this.byCategory.entries()),
      byTool: Object.fromEntries(this.byTool.entries()),
    }
  }
}

export function formatLoopGuardAscii(
  stats: LoopGuardStats,
  patterns: Array<{
    scope: string
    tool: string
    category: LoopGuardCategory
    repeatCount: number
    signature: string
    lastError: string
  }> = [],
): string {
  const lines: string[] = []
  lines.push('+-- Agent Loop Guard ----------------------------------------+')
  lines.push(
    `| Status: ${stats.enabled ? 'ENABLED' : 'DISABLED'} | Mode: ${stats.mode.toUpperCase()} | Warn: >=${stats.warnThreshold} | Block: >=${stats.blockThreshold}`,
  )
  lines.push(
    `| Warnings: ${stats.warningsIssued} | Critical: ${stats.criticalDetected} | Blocked: ${stats.actionsBlocked} | Active Patterns: ${stats.trackedPatterns}`,
  )
  if (patterns.length > 0) {
    lines.push('+-- Active Failure Patterns ---------------------------------+')
    for (const p of patterns.slice(0, 10)) {
      const errShort = p.lastError.replace(/\s+/g, ' ').slice(0, 48)
      lines.push(`| [${p.repeatCount}x] ${p.tool} (${p.category}) #${p.signature} :: ${errShort}`)
    }
  } else {
    lines.push('| No active repeating failure patterns.')
  }
  lines.push('+------------------------------------------------------------+')
  return lines.join('\n')
}
