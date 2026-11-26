// MCP stdio transport framing: supports both Content-Length framed messages
// (LSP / legacy MCP stdio clients) and NDJSON line-delimited messages (MCP 2024-11-05+),
// plus automatic per-stream framing detection ('auto').

export type McpFramingMode = 'auto' | 'ndjson' | 'content-length'
export type ResolvedMcpFraming = 'ndjson' | 'content-length'

export interface McpFrameOk {
  ok: true
  raw: string
  framing: ResolvedMcpFraming
}

export interface McpFrameError {
  ok: false
  error: string
  framing: ResolvedMcpFraming
}

export type ParsedMcpFrame = McpFrameOk | McpFrameError

export interface McpFrameParserOptions {
  /** Maximum allowed Content-Length payload in bytes (default: 16 MiB). */
  maxFrameBytes?: number
  /** Maximum allowed header section size in bytes before rejecting (default: 16 KiB). */
  maxHeaderBytes?: number
}

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024

const CRLF_CRLF = Buffer.from('\r\n\r\n', 'ascii')
const LF_LF = Buffer.from('\n\n', 'ascii')

const HEADER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*\s*:/
const HEADER_PREFIX_RE = /^[A-Za-z][A-Za-z0-9-]*(?:\s*:.*)?$/

export function parseMcpFramingMode(raw: unknown): McpFramingMode {
  if (raw === undefined || raw === null || raw === '') return 'auto'
  const norm = String(raw).trim().toLowerCase()
  if (norm === 'auto' || norm === 'detect') return 'auto'
  if (norm === 'ndjson' || norm === 'line' || norm === 'lines' || norm === 'jsonl') return 'ndjson'
  if (norm === 'content-length' || norm === 'content_length' || norm === 'contentlength' || norm === 'lsp' || norm === 'framed') {
    return 'content-length'
  }
  throw new Error(`Invalid MCP framing mode "${String(raw)}". Expected: auto, ndjson, or content-length.`)
}

/**
 * Serialize a JSON-RPC message using either NDJSON (`<json>\n`) or
 * byte-accurate `Content-Length: <utf8-bytes>\r\n\r\n<json>` framing.
 */
export function encodeMcpMessage(message: unknown, framing: ResolvedMcpFraming): string {
  const body = JSON.stringify(message)
  if (framing === 'content-length') {
    const byteLength = Buffer.byteLength(body, 'utf8')
    return `Content-Length: ${byteLength}\r\n\r\n${body}`
  }
  return `${body}\n`
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a
}

function trimLeadingAsciiWhitespace(buf: Buffer): Buffer {
  let start = 0
  while (start < buf.length && isAsciiWhitespace(buf[start]!)) {
    start++
  }
  return start === 0 ? buf : buf.subarray(start)
}

function findHeaderTerminator(buf: Buffer): { index: number; length: number } | null {
  const crlfIdx = buf.indexOf(CRLF_CRLF)
  const lfIdx = buf.indexOf(LF_LF)
  if (crlfIdx === -1 && lfIdx === -1) return null
  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
    return { index: crlfIdx, length: 4 }
  }
  return { index: lfIdx, length: 2 }
}

/**
 * Incremental byte-accurate MCP stdio frame parser supporting:
 * - `ndjson`: newline-delimited JSON messages
 * - `content-length`: `Content-Length: <bytes>\r\n\r\n<utf8-body>` framed messages
 * - `auto`: automatically detects framing from incoming bytes (supports mixed or single-mode streams)
 */
export class McpStdioFrameParser {
  readonly mode: McpFramingMode
  readonly maxFrameBytes: number
  readonly maxHeaderBytes: number

  private buffer: Buffer = Buffer.alloc(0)
  private detected: ResolvedMcpFraming | null = null

  constructor(mode: McpFramingMode = 'auto', options: McpFrameParserOptions = {}) {
    this.mode = mode
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES
    if (mode !== 'auto') {
      this.detected = mode
    }
  }

  get detectedFraming(): ResolvedMcpFraming | null {
    return this.detected
  }

  push(chunk: Buffer | string): ParsedMcpFrame[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (incoming.length === 0) return []
    this.buffer = this.buffer.length === 0 ? Buffer.from(incoming) : Buffer.concat([this.buffer, incoming])

    const frames: ParsedMcpFrame[] = []
    while (true) {
      this.buffer = trimLeadingAsciiWhitespace(this.buffer)
      if (this.buffer.length === 0) break

      const nextFraming = this.resolveNextFraming()
      if (nextFraming === null) break

      if (nextFraming === 'ndjson') {
        const nlIdx = this.buffer.indexOf(0x0a)
        if (nlIdx === -1) break
        const raw = this.buffer.subarray(0, nlIdx).toString('utf8').replace(/\r$/, '').trim()
        this.buffer = this.buffer.subarray(nlIdx + 1)
        if (raw.length > 0) {
          this.detected ??= 'ndjson'
          frames.push({ ok: true, raw, framing: 'ndjson' })
        }
        continue
      }

      // Content-Length framed message
      const term = findHeaderTerminator(this.buffer)
      if (!term) {
        if (this.buffer.length > this.maxHeaderBytes) {
          this.buffer = Buffer.alloc(0)
          this.detected ??= 'content-length'
          frames.push({
            ok: false,
            error: `MCP header block exceeds maximum size (${this.maxHeaderBytes} bytes)`,
            framing: 'content-length',
          })
        }
        break
      }

      const headerText = this.buffer.subarray(0, term.index).toString('utf8')
      const bodyStart = term.index + term.length
      const contentLength = this.parseContentLengthHeader(headerText)

      if (contentLength === null) {
        this.buffer = this.buffer.subarray(bodyStart)
        this.detected ??= 'content-length'
        frames.push({
          ok: false,
          error: 'Missing or invalid Content-Length header in framed MCP message',
          framing: 'content-length',
        })
        continue
      }

      if (contentLength > this.maxFrameBytes) {
        this.buffer = this.buffer.subarray(bodyStart)
        this.detected ??= 'content-length'
        frames.push({
          ok: false,
          error: `MCP Content-Length (${contentLength} bytes) exceeds maximum allowed (${this.maxFrameBytes} bytes)`,
          framing: 'content-length',
        })
        continue
      }

      if (this.buffer.length < bodyStart + contentLength) {
        // Wait for remaining payload bytes
        break
      }

      const bodyBuf = this.buffer.subarray(bodyStart, bodyStart + contentLength)
      this.buffer = this.buffer.subarray(bodyStart + contentLength)
      this.detected ??= 'content-length'
      frames.push({
        ok: true,
        raw: bodyBuf.toString('utf8'),
        framing: 'content-length',
      })
    }

    return frames
  }

  /**
   * Flush any remaining buffered bytes at stream EOF.
   * Handles NDJSON messages without a trailing newline and reports truncated Content-Length frames.
   */
  flush(): ParsedMcpFrame[] {
    this.buffer = trimLeadingAsciiWhitespace(this.buffer)
    if (this.buffer.length === 0) return []

    const rem = this.buffer
    this.buffer = Buffer.alloc(0)

    if (this.mode === 'ndjson') {
      const raw = rem.toString('utf8').replace(/\r$/, '').trim()
      if (!raw) return []
      this.detected ??= 'ndjson'
      return [{ ok: true, raw, framing: 'ndjson' }]
    }

    if (this.mode === 'content-length') {
      this.detected ??= 'content-length'
      return [{ ok: false, error: 'Unexpected EOF while reading Content-Length framed MCP message', framing: 'content-length' }]
    }

    // Auto mode at EOF: check if it looks like an incomplete Content-Length header/frame or a trailing NDJSON line
    const firstByte = rem[0]!
    if (firstByte === 0x7b || firstByte === 0x5b) {
      const raw = rem.toString('utf8').replace(/\r$/, '').trim()
      this.detected ??= 'ndjson'
      return [{ ok: true, raw, framing: 'ndjson' }]
    }

    const text = rem.toString('utf8')
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
    if (HEADER_LINE_RE.test(firstLine)) {
      this.detected ??= 'content-length'
      return [{ ok: false, error: 'Unexpected EOF while reading Content-Length framed MCP message', framing: 'content-length' }]
    }

    const raw = text.replace(/\r$/, '').trim()
    this.detected ??= 'ndjson'
    return raw ? [{ ok: true, raw, framing: 'ndjson' }] : []
  }

  private resolveNextFraming(): ResolvedMcpFraming | null {
    if (this.mode === 'ndjson') return 'ndjson'
    if (this.mode === 'content-length') return 'content-length'

    const firstByte = this.buffer[0]!
    // JSON object '{' or array '[' -> NDJSON
    if (firstByte === 0x7b || firstByte === 0x5b) {
      return 'ndjson'
    }

    const nlIdx = this.buffer.indexOf(0x0a)
    if (nlIdx !== -1) {
      const firstLine = this.buffer.subarray(0, nlIdx).toString('utf8').replace(/\r$/, '')
      return HEADER_LINE_RE.test(firstLine) ? 'content-length' : 'ndjson'
    }

    // No newline yet: if buffer could still be the start of a header line (e.g. "Content-Len"), wait for more bytes
    if (this.buffer.length <= this.maxHeaderBytes) {
      const partial = this.buffer.toString('utf8').replace(/\r$/, '')
      if (HEADER_PREFIX_RE.test(partial)) {
        return null
      }
    }

    return 'ndjson'
  }

  private parseContentLengthHeader(headerText: string): number | null {
    const lines = headerText.split(/\r?\n/)
    for (const line of lines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim().toLowerCase()
      if (key === 'content-length') {
        const val = line.slice(colonIdx + 1).trim()
        if (!/^\d+$/.test(val)) return null
        const parsed = Number.parseInt(val, 10)
        if (!Number.isSafeInteger(parsed) || parsed < 0) return null
        return parsed
      }
    }
    return null
  }
}
