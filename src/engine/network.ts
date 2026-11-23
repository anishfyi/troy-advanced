// Request/Response network recorder and body inspection utilities (M29).
// Shared by Chromium CDP and Lite engines for terminal API debugging (`troy-advanced network --body <reqId>`).

import type {
  NetworkBodyInspectionOptions,
  NetworkBodyPayload,
  NetworkBodyResult,
  NetworkEntry,
  NetworkListOptions,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { redactHeaders } from './emulation.js'

export const DEFAULT_NETWORK_MAX_ENTRIES = 300
export const DEFAULT_MAX_BODY_CHARS = 32_768
export const MIN_MAX_BODY_CHARS = 256
export const MAX_MAX_BODY_CHARS = 262_144

export interface NetworkRecord {
  entry: NetworkEntry
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  requestBody?: string
  hasPostData?: boolean
  cachedResponseBody?: {
    body: string
    base64Encoded: boolean
  }
}

export interface RecordNetworkInput {
  cdpRequestId?: string
  url: string
  method: string
  status?: number
  statusText?: string
  ok: boolean
  resourceType?: string
  mimeType?: string
  encodedDataLength?: number
  durationMs?: number
  ts?: number
  error?: string
  blocked?: boolean
  blockedReason?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody?: string
  hasPostData?: boolean
  cachedResponseBody?: {
    body: string
    base64Encoded: boolean
  }
}

export function clampMaxBodyChars(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_MAX_BODY_CHARS
  return Math.max(MIN_MAX_BODY_CHARS, Math.min(MAX_MAX_BODY_CHARS, Math.floor(n)))
}

export function normalizeMimeType(mimeType?: string): string {
  if (!mimeType) return ''
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
}

export function isJsonMimeType(mimeType?: string): boolean {
  const mt = normalizeMimeType(mimeType)
  if (!mt) return false
  return mt === 'application/json' || mt === 'text/json' || mt.endsWith('+json')
}

export function isTextMimeType(mimeType?: string): boolean {
  const mt = normalizeMimeType(mimeType)
  if (!mt) return true
  if (mt.startsWith('text/')) return true
  if (isJsonMimeType(mt)) return true
  if (
    mt === 'application/xml' ||
    mt.endsWith('+xml') ||
    mt === 'application/javascript' ||
    mt === 'application/x-javascript' ||
    mt === 'application/ecmascript' ||
    mt === 'application/x-www-form-urlencoded' ||
    mt === 'application/graphql' ||
    mt === 'application/graphql+json' ||
    mt === 'application/sql' ||
    mt === 'application/yaml' ||
    mt === 'application/x-yaml' ||
    mt === 'image/svg+xml'
  ) {
    return true
  }
  return false
}

export function normalizeHeadersMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out

  if (typeof Headers !== 'undefined' && raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key] = value
    })
    return out
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2) {
        out[String(item[0])] = String(item[1])
      }
    }
    return out
  }

  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === undefined || v === null) continue
      out[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v)
    }
  }
  return out
}

export function extractHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}

export function serializeRequestInitBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString()
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8')
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf8')
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString('utf8')
  }
  return String(body)
}

function tryPrettyJson(text: string, mimeType?: string): { text: string; prettyPrinted: boolean } {
  const trimmed = text.trim()
  if (!trimmed) return { text, prettyPrinted: false }
  const looksJson =
    isJsonMimeType(mimeType) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  if (!looksJson) return { text, prettyPrinted: false }
  try {
    const parsed = JSON.parse(trimmed)
    return { text: JSON.stringify(parsed, null, 2), prettyPrinted: true }
  } catch {
    return { text, prettyPrinted: false }
  }
}

export function formatBodyPayload(
  raw: {
    body?: string
    base64Encoded?: boolean
    mimeType?: string
    unavailableReason?: string
  },
  opts: NetworkBodyInspectionOptions = {},
): NetworkBodyPayload {
  const maxChars = clampMaxBodyChars(opts.maxBodyChars)
  const prettyJson = opts.prettyJson !== false
  const includeBinary = Boolean(opts.includeBinary)
  const mimeType = raw.mimeType ? normalizeMimeType(raw.mimeType) : undefined

  if (raw.unavailableReason && raw.body === undefined) {
    return {
      ...(mimeType ? { mimeType } : {}),
      unavailableReason: raw.unavailableReason,
    }
  }

  if (raw.body === undefined) {
    return {
      ...(mimeType ? { mimeType } : {}),
      unavailableReason: 'no body',
    }
  }

  let text = raw.body
  let base64Encoded = Boolean(raw.base64Encoded)
  let sizeBytes = base64Encoded
    ? Buffer.from(text, 'base64').byteLength
    : Buffer.byteLength(text, 'utf8')
  let isBinary = !isTextMimeType(mimeType)

  if (base64Encoded) {
    const buf = Buffer.from(text, 'base64')
    sizeBytes = buf.byteLength
    if (!isBinary) {
      // Decode text-like MIME types from base64 to UTF-8 so terminal users can read them directly.
      text = buf.toString('utf8')
      base64Encoded = false
    } else if (!includeBinary) {
      return {
        isBinary: true,
        sizeBytes,
        ...(mimeType ? { mimeType } : {}),
        unavailableReason: `binary payload (${sizeBytes} bytes, ${mimeType ?? 'unknown'}); pass --binary / includeBinary:true to inspect base64`,
      }
    }
  }

  let prettyPrinted = false
  if (!base64Encoded && !isBinary && prettyJson) {
    const formatted = tryPrettyJson(text, mimeType)
    text = formatted.text
    prettyPrinted = formatted.prettyPrinted
  }

  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }

  return {
    body: text,
    ...(base64Encoded ? { base64Encoded: true } : {}),
    sizeBytes,
    ...(truncated ? { truncated: true } : {}),
    ...(isBinary ? { isBinary: true } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(prettyPrinted ? { prettyPrinted: true } : {}),
  }
}

export class NetworkRecorder {
  private maxEntries: number
  private seq = 0
  private records: NetworkRecord[] = []

  constructor(maxEntries = DEFAULT_NETWORK_MAX_ENTRIES) {
    this.maxEntries = Math.max(10, Math.min(5000, Math.floor(maxEntries)))
  }

  record(input: RecordNetworkInput): NetworkRecord {
    this.seq += 1
    const requestId = `req-${this.seq}`
    const requestHeaders = input.requestHeaders ? { ...input.requestHeaders } : {}
    const responseHeaders = input.responseHeaders ? { ...input.responseHeaders } : {}
    const mimeType =
      input.mimeType ??
      normalizeMimeType(extractHeader(responseHeaders, 'content-type')) ??
      undefined
    const hasRequestBody =
      (typeof input.requestBody === 'string' && input.requestBody.length > 0) || Boolean(input.hasPostData)
    const hasResponseBody =
      input.cachedResponseBody !== undefined
        ? input.cachedResponseBody.body.length > 0
        : Boolean(input.cdpRequestId && !input.error && !input.blocked && input.status !== 204 && input.status !== 304)

    const entry: NetworkEntry = {
      requestId,
      ...(input.cdpRequestId ? { cdpRequestId: input.cdpRequestId } : {}),
      url: input.url,
      method: (input.method || 'GET').toUpperCase(),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.statusText ? { statusText: input.statusText } : {}),
      ok: input.ok,
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(input.encodedDataLength !== undefined ? { encodedDataLength: input.encodedDataLength } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ts: input.ts ?? Date.now(),
      ...(input.error ? { error: input.error } : {}),
      ...(input.blocked ? { blocked: true } : {}),
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      ...(hasRequestBody ? { hasRequestBody: true } : {}),
      ...(hasResponseBody ? { hasResponseBody: true } : {}),
    }

    const rec: NetworkRecord = {
      entry,
      requestHeaders,
      responseHeaders,
      ...(input.requestBody !== undefined ? { requestBody: input.requestBody } : {}),
      ...(input.hasPostData ? { hasPostData: true } : {}),
      ...(input.cachedResponseBody ? { cachedResponseBody: input.cachedResponseBody } : {}),
    }

    this.records.push(rec)
    if (this.records.length > this.maxEntries) {
      this.records.shift()
    }
    return rec
  }

  updateEncodedDataLength(cdpRequestId: string, bytes: number): void {
    if (!cdpRequestId || !Number.isFinite(bytes)) return
    for (let i = this.records.length - 1; i >= 0; i--) {
      const rec = this.records[i]!
      if (rec.entry.cdpRequestId === cdpRequestId) {
        rec.entry.encodedDataLength = bytes
        return
      }
    }
  }

  list(opts: NetworkListOptions = {}): NetworkEntry[] {
    let items = this.records.map((r) => ({ ...r.entry }))
    if (opts.failedOnly) items = items.filter((i) => !i.ok)
    if (opts.blockedOnly) items = items.filter((i) => Boolean(i.blocked))
    if (opts.method) {
      const m = opts.method.trim().toUpperCase()
      if (m) items = items.filter((i) => i.method.toUpperCase() === m)
    }
    if (opts.urlFilter) {
      const q = opts.urlFilter.trim().toLowerCase()
      if (q) items = items.filter((i) => i.url.toLowerCase().includes(q))
    }
    if (opts.clear) {
      this.records = []
    }
    const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50
    return items.slice(-limit)
  }

  get(reqId: string): NetworkRecord | undefined {
    const raw = String(reqId ?? '').trim()
    if (!raw) return undefined
    const lower = raw.toLowerCase()
    const normalizedReqId = /^\d+$/.test(lower) ? `req-${lower}` : lower

    for (let i = this.records.length - 1; i >= 0; i--) {
      const rec = this.records[i]!
      if (rec.entry.requestId?.toLowerCase() === normalizedReqId) return rec
      if (rec.entry.cdpRequestId && rec.entry.cdpRequestId === raw) return rec
    }
    return undefined
  }

  clear(): void {
    this.records = []
  }

  size(): number {
    return this.records.length
  }
}

export function buildNetworkBodyResult(
  record: NetworkRecord,
  resolved: {
    requestBody?: string
    requestBodyUnavailableReason?: string
    responseBody?: string
    responseBase64Encoded?: boolean
    responseBodyUnavailableReason?: string
  },
  opts: NetworkBodyInspectionOptions = {},
): NetworkBodyResult {
  const reveal = Boolean(opts.revealHeaders)
  const requestHeaders = redactHeaders(record.requestHeaders, reveal)
  const responseHeaders = redactHeaders(record.responseHeaders, reveal)

  const reqMime = extractHeader(record.requestHeaders, 'content-type')
  const resMime = record.entry.mimeType ?? extractHeader(record.responseHeaders, 'content-type')

  const requestBody =
    resolved.requestBody !== undefined || resolved.requestBodyUnavailableReason
      ? formatBodyPayload(
          {
            body: resolved.requestBody,
            base64Encoded: false,
            mimeType: reqMime,
            unavailableReason: resolved.requestBodyUnavailableReason,
          },
          opts,
        )
      : undefined

  const responseBody = formatBodyPayload(
    {
      body: resolved.responseBody,
      base64Encoded: resolved.responseBase64Encoded,
      mimeType: resMime,
      unavailableReason: resolved.responseBodyUnavailableReason,
    },
    opts,
  )

  const result: NetworkBodyResult = {
    ok: true,
    requestId: record.entry.requestId ?? record.entry.cdpRequestId ?? 'unknown',
    entry: { ...record.entry },
    requestHeaders,
    responseHeaders,
    ...(requestBody ? { requestBody } : {}),
    responseBody,
  }
  result.ascii = formatNetworkBodyAscii(result)
  return result
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(1, max - 3))}...`
}

export function formatNetworkListAscii(entries: NetworkEntry[]): string {
  const lines: string[] = []
  lines.push(`=== Network Requests (${entries.length}) ===`)
  if (entries.length === 0) {
    lines.push('  (no network requests captured)')
    return lines.join('\n')
  }
  lines.push('ID       METHOD  STATUS  TYPE        TIME    URL')
  lines.push('-------  ------  ------  ----------  ------  ----------------------------------------')
  for (const e of entries) {
    const id = sanitizeAscii(e.requestId ?? '-').padEnd(7)
    const method = sanitizeAscii(e.method).padEnd(6)
    const statusStr = e.blocked
      ? 'BLOCK'
      : e.status !== undefined
        ? String(e.status)
        : e.error
          ? 'ERR'
          : '-'
    const status = statusStr.padEnd(6)
    const type = truncateText(sanitizeAscii(e.resourceType ?? e.mimeType ?? '-'), 10).padEnd(10)
    const dur = e.durationMs !== undefined ? `${e.durationMs}ms` : '-'
    const time = dur.padEnd(6)
    const url = truncateText(sanitizeAscii(e.url), 72)
    lines.push(`${id}  ${method}  ${status}  ${type}  ${time}  ${url}`)
  }
  lines.push('')
  lines.push('Tip: inspect request/response body with: troy-advanced network --body <reqId>')
  return lines.join('\n')
}

export function formatNetworkBodyAscii(result: NetworkBodyResult): string {
  if (!result.ok || !result.entry) {
    return `ERROR: ${sanitizeAscii(result.error ?? `Request "${result.requestId}" not found`)}`
  }
  const e = result.entry
  const lines: string[] = []
  const statusPart = e.blocked
    ? `BLOCKED (${e.blockedReason ?? 'policy'})`
    : e.status !== undefined
      ? `${e.status}${e.statusText ? ` ${e.statusText}` : ''}`
      : e.error
        ? `ERROR (${e.error})`
        : 'PENDING'
  const durPart = e.durationMs !== undefined ? `  (${e.durationMs}ms)` : ''
  lines.push(`=== Network Body: ${sanitizeAscii(result.requestId)} ===`)
  lines.push(`${sanitizeAscii(e.method)} ${sanitizeAscii(e.url)}`)
  lines.push(
    `Status : ${sanitizeAscii(statusPart)}${durPart}${e.mimeType ? `  [${sanitizeAscii(e.mimeType)}]` : ''}`,
  )

  const reqHeaders = Object.entries(result.requestHeaders ?? {})
  lines.push('')
  lines.push(`--- Request Headers (${reqHeaders.length}) ---`)
  if (reqHeaders.length === 0) {
    lines.push('  (none)')
  } else {
    for (const [k, v] of reqHeaders) {
      lines.push(`  ${sanitizeAscii(k)}: ${sanitizeAscii(v)}`)
    }
  }

  if (result.requestBody) {
    const rb = result.requestBody
    const meta = [
      rb.mimeType ? rb.mimeType : null,
      rb.sizeBytes !== undefined ? `${rb.sizeBytes} bytes` : null,
      rb.prettyPrinted ? 'pretty-json' : null,
      rb.truncated ? 'TRUNCATED' : null,
    ]
      .filter(Boolean)
      .join(', ')
    lines.push('')
    lines.push(`--- Request Body${meta ? ` (${sanitizeAscii(meta)})` : ''} ---`)
    if (rb.body !== undefined) {
      lines.push(sanitizeAscii(rb.body))
    } else {
      lines.push(`  (${sanitizeAscii(rb.unavailableReason ?? 'empty')})`)
    }
  }

  const resHeaders = Object.entries(result.responseHeaders ?? {})
  lines.push('')
  lines.push(`--- Response Headers (${resHeaders.length}) ---`)
  if (resHeaders.length === 0) {
    lines.push('  (none)')
  } else {
    for (const [k, v] of resHeaders) {
      lines.push(`  ${sanitizeAscii(k)}: ${sanitizeAscii(v)}`)
    }
  }

  if (result.responseBody) {
    const rb = result.responseBody
    const meta = [
      rb.mimeType ? rb.mimeType : null,
      rb.sizeBytes !== undefined ? `${rb.sizeBytes} bytes` : null,
      rb.prettyPrinted ? 'pretty-json' : null,
      rb.base64Encoded ? 'base64' : null,
      rb.truncated ? 'TRUNCATED' : null,
    ]
      .filter(Boolean)
      .join(', ')
    lines.push('')
    lines.push(`--- Response Body${meta ? ` (${sanitizeAscii(meta)})` : ''} ---`)
    if (rb.body !== undefined) {
      lines.push(sanitizeAscii(rb.body))
    } else {
      lines.push(`  (${sanitizeAscii(rb.unavailableReason ?? 'unavailable')})`)
    }
  }

  return lines.join('\n')
}
