// Persistent agent action audit log (`audit.jsonl`).
// Records every tool call, deterministic policy refusal, timing (durationMs),
// and URL transition in append-only JSON Lines format (0o600).

import fs from 'node:fs'
import path from 'node:path'
import type {
  AuditEntry,
  AuditEventKind,
  AuditQueryOptions,
  AuditRefusalInfo,
  AuditStats,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

const SENSITIVE_ARG_KEY_RE =
  /password|passcode|passkey|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credit[-_]?card|card[-_]?number|\bcvv\b|\bcvc\b|\bssn\b|otp|pin/i

const MAX_ARG_STRING_LEN = 200
const MAX_ARG_ARRAY_LEN = 20
const MAX_ARG_DEPTH = 4
const DEFAULT_MAX_MEMORY_ENTRIES = 1000

export interface AuditLoggerConfig {
  filePath: string
  enabled?: boolean
  maxMemoryEntries?: number
  redactArgs?: boolean
}

export interface AuditRecordInput {
  kind: AuditEventKind
  tool: string
  tabId?: number
  ok: boolean
  refused: boolean
  refusal?: AuditRefusalInfo
  durationMs: number
  args?: Record<string, unknown>
  summary?: string
  fromUrl?: string
  toUrl?: string
  urlChanged?: boolean
  error?: string
  tsMs?: number
}

export function parseAuditEventKind(value: unknown): AuditEventKind | undefined {
  if (
    value === 'tool_call' ||
    value === 'refusal' ||
    value === 'url_transition' ||
    value === 'tab_action' ||
    value === 'origin_grant'
  ) {
    return value
  }
  return undefined
}

/**
 * Extract structured refusal metadata from a tool result payload, including
 * direct policy decisions (`blocked` / `boundary`) and nested `page_act` step refusals.
 */
export function extractRefusalInfo(result: Record<string, unknown> | null | undefined): AuditRefusalInfo | undefined {
  if (!result || result.ok === true) return undefined

  const status = result.status
  if (status === 'blocked' || status === 'boundary' || status === 'refused') {
    const reason =
      typeof result.reason === 'string' && result.reason
        ? result.reason
        : typeof result.error === 'string' && result.error
          ? result.error
          : `action ${status}`
    return {
      status,
      ...(typeof result.code === 'string' && result.code ? { code: result.code } : {}),
      reason,
      ...(typeof result.origin === 'string' && result.origin ? { origin: result.origin } : {}),
    }
  }

  if (result.allowed === false) {
    const reason =
      typeof result.reason === 'string' && result.reason
        ? result.reason
        : typeof result.error === 'string' && result.error
          ? result.error
          : 'action refused by policy'
    return {
      status: 'refused',
      ...(typeof result.code === 'string' && result.code ? { code: result.code } : {}),
      reason,
      ...(typeof result.origin === 'string' && result.origin ? { origin: result.origin } : {}),
    }
  }

  // Propagate step-level refusal from `page_act`
  if (typeof result.stoppedAt === 'number' && Array.isArray(result.results)) {
    const failedStep = result.results[result.stoppedAt]
    if (failedStep && typeof failedStep === 'object') {
      return extractRefusalInfo(failedStep as Record<string, unknown>)
    }
  }

  return undefined
}

function sanitizeValue(value: unknown, redactArgs: boolean, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'boolean' || typeof value === 'number') {
    return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
  }
  if (typeof value === 'string') {
    if (value.length <= MAX_ARG_STRING_LEN) return value
    return `${value.slice(0, MAX_ARG_STRING_LEN)}...(${value.length} chars)`
  }
  if (depth >= MAX_ARG_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARG_ARRAY_LEN).map((item) => sanitizeValue(item, redactArgs, depth + 1))
    if (value.length > MAX_ARG_ARRAY_LEN) {
      out.push(`...(${value.length - MAX_ARG_ARRAY_LEN} more)`)
    }
    return out
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      if (redactArgs && SENSITIVE_ARG_KEY_RE.test(k)) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = sanitizeValue(v, redactArgs, depth + 1)
      }
    }
    return out
  }
  return String(value)
}

export function sanitizeAuditArgs(
  args: Record<string, unknown> | undefined,
  redactArgs = true,
): Record<string, unknown> | undefined {
  if (!args) return undefined
  const entries = Object.entries(args).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    if (redactArgs && SENSITIVE_ARG_KEY_RE.test(k)) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = sanitizeValue(v, redactArgs, 1)
    }
  }
  return out
}

export function readAuditJsonl(filePath: string): AuditEntry[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const entries: AuditEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as AuditEntry
      if (parsed && typeof parsed.tool === 'string' && typeof parsed.ts === 'string') {
        entries.push(parsed)
      }
    } catch {
      // Skip partial/corrupt lines gracefully
    }
  }
  return entries
}

export function filterAuditEntries(entries: AuditEntry[], opts: AuditQueryOptions = {}): AuditEntry[] {
  let filtered = entries
  if (opts.kind) {
    filtered = filtered.filter((e) => e.kind === opts.kind)
  }
  if (opts.tool) {
    filtered = filtered.filter((e) => e.tool === opts.tool)
  }
  if (opts.tabId !== undefined) {
    filtered = filtered.filter((e) => e.tabId === opts.tabId)
  }
  if (opts.refusedOnly) {
    filtered = filtered.filter((e) => e.refused || e.kind === 'refusal')
  }
  if (opts.urlChangedOnly) {
    filtered = filtered.filter((e) => Boolean(e.urlChanged))
  }
  if (opts.failedOnly) {
    filtered = filtered.filter((e) => !e.ok)
  }
  if (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) {
    filtered = filtered.filter((e) => e.tsMs >= opts.sinceMs!)
  }
  if (typeof opts.limit === 'number' && opts.limit > 0 && filtered.length > opts.limit) {
    filtered = filtered.slice(-opts.limit)
  }
  return filtered.map((e) => ({ ...e }))
}

export function computeAuditStats(
  entries: AuditEntry[],
  meta: { enabled: boolean; filePath: string },
): AuditStats {
  let toolCalls = 0
  let refusals = 0
  let errors = 0
  let urlTransitions = 0
  let totalDurationMs = 0
  let maxDurationMs = 0
  const byTool: Record<string, number> = {}
  const byRefusalCode: Record<string, number> = {}

  for (const entry of entries) {
    if (entry.kind === 'tool_call') toolCalls++
    if (entry.refused || entry.kind === 'refusal') {
      refusals++
      const code = entry.refusal?.code || entry.refusal?.status || 'refused'
      byRefusalCode[code] = (byRefusalCode[code] ?? 0) + 1
    }
    if (!entry.ok && !entry.refused) errors++
    if (entry.urlChanged || entry.kind === 'url_transition') urlTransitions++
    const dur = Math.max(0, Number(entry.durationMs) || 0)
    totalDurationMs += dur
    if (dur > maxDurationMs) maxDurationMs = dur
    byTool[entry.tool] = (byTool[entry.tool] ?? 0) + 1
  }

  return {
    enabled: meta.enabled,
    filePath: meta.filePath,
    totalEntries: entries.length,
    toolCalls,
    refusals,
    errors,
    urlTransitions,
    avgDurationMs: entries.length > 0 ? Math.round((totalDurationMs / entries.length) * 100) / 100 : 0,
    maxDurationMs,
    byTool,
    byRefusalCode,
  }
}

function truncateAscii(str: string, maxLen: number): string {
  const clean = sanitizeAscii(str).replace(/[\r\n]+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  if (maxLen <= 3) return clean.slice(0, maxLen)
  return `${clean.slice(0, maxLen - 3)}...`
}

export function formatAuditAscii(
  entries: AuditEntry[],
  stats: AuditStats,
  opts: { width?: number } = {},
): string {
  const width = Math.max(60, Math.min(200, opts.width ?? 100))
  const lines: string[] = []
  const rule = '-'.repeat(width)

  lines.push(sanitizeAscii(`AUDIT LOG (${stats.enabled ? 'enabled' : 'disabled'}) ${stats.filePath}`))
  lines.push(
    sanitizeAscii(
      `Total: ${stats.totalEntries} | Tools: ${stats.toolCalls} | Refusals: ${stats.refusals} | Errors: ${stats.errors} | Transitions: ${stats.urlTransitions} | Avg: ${stats.avgDurationMs}ms | Max: ${stats.maxDurationMs}ms`,
    ),
  )
  lines.push(rule)

  if (entries.length === 0) {
    lines.push('(no audit entries)')
    lines.push(rule)
    return lines.join('\n')
  }

  lines.push('SEQ  TIME         STATUS   MS     TAB  TOOL               DETAIL')
  lines.push(rule)

  const detailWidth = Math.max(20, width - 58)
  for (const e of entries) {
    const seq = String(e.seq).padEnd(4)
    const time = (e.ts.slice(11, 23) || e.ts.slice(0, 12)).padEnd(12)
    const status = (e.refused ? 'REFUSED' : e.ok ? 'OK' : 'ERROR').padEnd(8)
    const ms = `${Math.max(0, Math.round(e.durationMs))}ms`.padEnd(6)
    const tab = (e.tabId !== undefined ? `t${e.tabId}` : '-').padEnd(4)
    const tool = truncateAscii(e.tool, 18).padEnd(18)

    let detail = ''
    if (e.refused && e.refusal) {
      const code = e.refusal.code ? `[${e.refusal.code}] ` : ''
      detail = `${code}${e.refusal.reason}`
    } else if (e.urlChanged && e.fromUrl && e.toUrl) {
      detail = `${e.fromUrl} -> ${e.toUrl}`
    } else if (!e.ok && e.error) {
      detail = `err: ${e.error}`
    } else if (e.toUrl && e.tool === 'tab_open') {
      detail = `-> ${e.toUrl}`
    } else if (e.summary) {
      detail = e.summary
    } else if (e.toUrl) {
      detail = e.toUrl
    }

    lines.push(sanitizeAscii(`${seq} ${time} ${status} ${ms} ${tab} ${tool} ${truncateAscii(detail, detailWidth)}`))
  }
  lines.push(rule)
  return lines.join('\n')
}

export class AuditLogger {
  readonly enabled: boolean
  readonly filePath: string
  private readonly maxMemoryEntries: number
  private readonly redactArgs: boolean
  private entries: AuditEntry[] = []
  private nextSeq = 1
  private dirReady = false
  private totalEntries = 0
  private toolCalls = 0
  private refusals = 0
  private errors = 0
  private urlTransitions = 0
  private totalDurationMs = 0
  private maxDurationMs = 0
  private byTool: Record<string, number> = {}
  private byRefusalCode: Record<string, number> = {}

  constructor(config: AuditLoggerConfig) {
    this.filePath = config.filePath
    this.enabled = config.enabled !== false
    this.maxMemoryEntries = Math.max(10, config.maxMemoryEntries ?? DEFAULT_MAX_MEMORY_ENTRIES)
    this.redactArgs = config.redactArgs !== false

    // Resume sequence numbering cleanly if an audit.jsonl file already exists
    if (this.enabled) {
      try {
        if (fs.existsSync(this.filePath)) {
          const existing = readAuditJsonl(this.filePath)
          if (existing.length > 0) {
            const lastSeq = existing[existing.length - 1]?.seq ?? existing.length
            this.nextSeq = Math.max(existing.length, lastSeq) + 1
          }
        }
      } catch {
        // Ignore read error on startup
      }
    }
  }

  private ensureDir(): void {
    if (this.dirReady) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.dirReady = true
  }

  record(input: AuditRecordInput): AuditEntry | null {
    if (!this.enabled) return null

    const tsMs = input.tsMs ?? Date.now()
    const durationMs = Math.max(0, Number(input.durationMs) || 0)
    const cleanArgs = sanitizeAuditArgs(input.args, this.redactArgs)

    const entry: AuditEntry = {
      seq: this.nextSeq++,
      ts: new Date(tsMs).toISOString(),
      tsMs,
      kind: input.kind,
      tool: input.tool,
      ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      ok: input.ok,
      refused: input.refused,
      ...(input.refusal ? { refusal: input.refusal } : {}),
      durationMs,
      ...(cleanArgs ? { args: cleanArgs } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.fromUrl ? { fromUrl: input.fromUrl } : {}),
      ...(input.toUrl ? { toUrl: input.toUrl } : {}),
      ...(input.urlChanged ? { urlChanged: true } : {}),
      ...(input.error ? { error: input.error } : {}),
    }

    this.entries.push(entry)
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.splice(0, this.entries.length - this.maxMemoryEntries)
    }

    this.totalEntries++
    if (entry.kind === 'tool_call') this.toolCalls++
    if (entry.refused || entry.kind === 'refusal') {
      this.refusals++
      const code = entry.refusal?.code || entry.refusal?.status || 'refused'
      this.byRefusalCode[code] = (this.byRefusalCode[code] ?? 0) + 1
    }
    if (!entry.ok && !entry.refused) this.errors++
    if (entry.urlChanged || entry.kind === 'url_transition') this.urlTransitions++
    this.totalDurationMs += durationMs
    if (durationMs > this.maxDurationMs) this.maxDurationMs = durationMs
    this.byTool[entry.tool] = (this.byTool[entry.tool] ?? 0) + 1

    try {
      this.ensureDir()
      const existed = fs.existsSync(this.filePath)
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
      if (!existed) {
        try {
          fs.chmodSync(this.filePath, 0o600)
        } catch {
          // Windows or restricted FS
        }
      }
    } catch {
      // Never crash a browser action if audit file cannot be written
    }

    return entry
  }

  query(opts: AuditQueryOptions = {}): AuditEntry[] {
    const source = opts.fromDisk ? readAuditJsonl(this.filePath) : this.entries
    return filterAuditEntries(source, opts)
  }

  stats(): AuditStats {
    return {
      enabled: this.enabled,
      filePath: this.filePath,
      totalEntries: this.totalEntries,
      toolCalls: this.toolCalls,
      refusals: this.refusals,
      errors: this.errors,
      urlTransitions: this.urlTransitions,
      avgDurationMs:
        this.totalEntries > 0 ? Math.round((this.totalDurationMs / this.totalEntries) * 100) / 100 : 0,
      maxDurationMs: this.maxDurationMs,
      byTool: { ...this.byTool },
      byRefusalCode: { ...this.byRefusalCode },
    }
  }

  clear(opts: { truncateFile?: boolean } = {}): { clearedMemory: number; truncatedFile: boolean } {
    const clearedMemory = this.entries.length
    this.entries = []
    this.totalEntries = 0
    this.toolCalls = 0
    this.refusals = 0
    this.errors = 0
    this.urlTransitions = 0
    this.totalDurationMs = 0
    this.maxDurationMs = 0
    this.byTool = {}
    this.byRefusalCode = {}

    let truncatedFile = false
    if (opts.truncateFile) {
      try {
        if (fs.existsSync(this.filePath)) {
          fs.writeFileSync(this.filePath, '', { encoding: 'utf8', mode: 0o600 })
          truncatedFile = true
        }
        this.nextSeq = 1
      } catch {
        // ignore
      }
    }
    return { clearedMemory, truncatedFile }
  }
}
