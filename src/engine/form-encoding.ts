// Form encoding helpers for Lite engine (M35):
// - RFC 7578 / WHATWG HTML5 `multipart/form-data` serialization (text & file fields)
// - `application/x-www-form-urlencoded` serialization
// - `text/plain` serialization

import crypto from 'node:crypto'
import path from 'node:path'

export type FormEnctype = 'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain'

export interface FormDataEntry {
  name: string
  value: string | Buffer | Uint8Array
  /** When defined, encodes the part as a file upload (`filename="..."` + `Content-Type`). */
  filename?: string
  /** Optional MIME type for file upload parts (defaults to `application/octet-stream`). */
  contentType?: string
}

export interface EncodedMultipartFormData {
  body: Buffer
  contentType: string
  boundary: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

/**
 * Normalize an HTML `<form enctype="...">` or `<button formenctype="...">` attribute
 * per HTML5 §4.10.18.6. Unknown/empty values fall back to `application/x-www-form-urlencoded`.
 */
export function normalizeFormEnctype(raw?: string): FormEnctype {
  const normalized = (raw ?? '').trim().toLowerCase()
  if (normalized === 'multipart/form-data') return 'multipart/form-data'
  if (normalized === 'text/plain') return 'text/plain'
  return 'application/x-www-form-urlencoded'
}

/**
 * Escape a `name` or `filename` parameter in a `Content-Disposition` header
 * per WHATWG HTML5 §4.10.21.8 (percent-encode CR, LF, and double quotes).
 */
export function escapeMultipartParam(value: string): string {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
}

/**
 * Generate a collision-resistant ASCII multipart boundary string (<= 70 chars per RFC 2046).
 */
export function generateMultipartBoundary(): string {
  return `----TroyFormBoundary${crypto.randomBytes(12).toString('hex')}`
}

/**
 * Guess a MIME type from a filename extension, falling back to `application/octet-stream`.
 */
export function guessMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Encode form entries as RFC 7578 `multipart/form-data` with CRLF framing.
 * Preserves entry order, duplicate field names, binary file payloads, and UTF-8 text.
 */
export function encodeMultipartFormData(
  entries: readonly FormDataEntry[],
  boundary?: string,
): EncodedMultipartFormData {
  const activeBoundary = boundary && boundary.trim().length > 0 ? boundary.trim() : generateMultipartBoundary()
  const chunks: Buffer[] = []

  for (const entry of entries) {
    const escapedName = escapeMultipartParam(entry.name)
    if (entry.filename !== undefined) {
      const escapedFilename = escapeMultipartParam(entry.filename)
      const contentType = entry.contentType?.trim() || 'application/octet-stream'
      chunks.push(
        Buffer.from(
          `--${activeBoundary}\r\n` +
            `Content-Disposition: form-data; name="${escapedName}"; filename="${escapedFilename}"\r\n` +
            `Content-Type: ${contentType}\r\n\r\n`,
          'utf8',
        ),
      )
      if (Buffer.isBuffer(entry.value)) {
        chunks.push(entry.value)
      } else if (typeof entry.value === 'string') {
        chunks.push(Buffer.from(entry.value, 'utf8'))
      } else {
        chunks.push(Buffer.from(entry.value))
      }
      chunks.push(Buffer.from('\r\n', 'utf8'))
    } else {
      const textVal =
        typeof entry.value === 'string'
          ? entry.value
          : Buffer.isBuffer(entry.value)
            ? entry.value.toString('utf8')
            : Buffer.from(entry.value).toString('utf8')
      chunks.push(
        Buffer.from(
          `--${activeBoundary}\r\n` +
            `Content-Disposition: form-data; name="${escapedName}"\r\n\r\n`,
          'utf8',
        ),
      )
      chunks.push(Buffer.from(textVal, 'utf8'))
      chunks.push(Buffer.from('\r\n', 'utf8'))
    }
  }

  chunks.push(Buffer.from(`--${activeBoundary}--\r\n`, 'utf8'))

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${activeBoundary}`,
    boundary: activeBoundary,
  }
}

/**
 * Encode form entries as `application/x-www-form-urlencoded` preserving order and duplicate keys.
 */
export function encodeUrlEncodedFormData(entries: readonly FormDataEntry[]): string {
  const params = new URLSearchParams()
  for (const entry of entries) {
    const val =
      entry.filename !== undefined
        ? entry.filename
        : typeof entry.value === 'string'
          ? entry.value
          : Buffer.isBuffer(entry.value)
            ? entry.value.toString('utf8')
            : Buffer.from(entry.value).toString('utf8')
    params.append(entry.name, val)
  }
  return params.toString()
}

/**
 * Encode form entries as HTML5 `text/plain` (`name=value\r\n` per entry).
 */
export function encodeTextPlainFormData(entries: readonly FormDataEntry[]): string {
  return entries
    .map((entry) => {
      const val =
        entry.filename !== undefined
          ? entry.filename
          : typeof entry.value === 'string'
            ? entry.value
            : Buffer.isBuffer(entry.value)
              ? entry.value.toString('utf8')
              : Buffer.from(entry.value).toString('utf8')
      return `${entry.name}=${val}\r\n`
    })
    .join('')
}
