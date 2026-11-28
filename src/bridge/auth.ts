// Timing-safe token authentication for the Agent Socket (`x-troy-agent` header
// and WebSocket upgrade query fallback).
//
// Uses `crypto.timingSafeEqual` over fixed-length SHA-256 digests (plus a direct
// `timingSafeEqual` check when byte lengths match) so that:
//   1. Different-length tokens never short-circuit before constant-time comparison
//      (preventing secret-length timing oracles) and never throw RangeError.
//   2. Multi-byte UTF-8 inputs are compared safely by byte length, not JS string length.
//   3. Duplicate `x-troy-agent` headers (smuggling / comma-joining) are rejected.

import { createHash, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

export const AGENT_TOKEN_HEADER = 'x-troy-agent'
export const MAX_TOKEN_BYTES = 4096

export type TokenValidationErrorCode =
  | 'empty_expected_token'
  | 'missing_token'
  | 'duplicate_token'
  | 'invalid_token'
  | 'token_mismatch'

export interface TokenHeaderExtractionResult {
  ok: boolean
  present: boolean
  token?: string
  code?: TokenValidationErrorCode
  error?: string
}

export interface TokenValidationResult {
  ok: boolean
  code?: TokenValidationErrorCode
  error?: string
}

export interface TokenValidationOptions {
  /** Optional query-string token fallback (used by WebSocket `/ws?token=...`). */
  queryToken?: string | null
}

/**
 * Constant-time comparison of two secret tokens using `crypto.timingSafeEqual`.
 *
 * Always hashes both inputs with SHA-256 to 32-byte digests before invoking
 * `crypto.timingSafeEqual`, preventing both `RangeError` on unequal lengths and
 * early-return length-oracle timing leaks. When byte lengths match, also runs
 * `crypto.timingSafeEqual` directly on the raw UTF-8 buffers.
 */
export function timingSafeTokenEqual(supplied: string, expected: string): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (expected.length === 0) return false

  const suppliedBuf = Buffer.from(supplied, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')

  if (suppliedBuf.length > MAX_TOKEN_BYTES || expectedBuf.length > MAX_TOKEN_BYTES) {
    return false
  }

  const suppliedDigest = createHash('sha256').update(suppliedBuf).digest()
  const expectedDigest = createHash('sha256').update(expectedBuf).digest()
  const digestsMatch = timingSafeEqual(suppliedDigest, expectedDigest)

  const exactMatch =
    suppliedBuf.length === expectedBuf.length
      ? timingSafeEqual(suppliedBuf, expectedBuf)
      : false

  return digestsMatch && exactMatch && suppliedBuf.length > 0
}

/**
 * Extract and structurally validate the `x-troy-agent` header from an incoming
 * HTTP request, rejecting duplicate headers and control characters.
 */
export function extractAgentTokenHeader(
  req: Pick<http.IncomingMessage, 'headers'> & { rawHeaders?: string[] },
): TokenHeaderExtractionResult {
  if (Array.isArray(req.rawHeaders)) {
    let headerCount = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === AGENT_TOKEN_HEADER) {
        headerCount++
      }
    }
    if (headerCount > 1) {
      return {
        ok: false,
        present: true,
        code: 'duplicate_token',
        error: 'duplicate x-troy-agent header',
      }
    }
  }

  const raw = req.headers[AGENT_TOKEN_HEADER]
  if (raw === undefined) {
    return {
      ok: false,
      present: false,
      code: 'missing_token',
      error: 'missing or invalid x-troy-agent token',
    }
  }
  if (Array.isArray(raw)) {
    return {
      ok: false,
      present: true,
      code: 'duplicate_token',
      error: 'duplicate x-troy-agent header',
    }
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      ok: false,
      present: true,
      code: 'missing_token',
      error: 'missing or invalid x-troy-agent token',
    }
  }
  if (/[\x00-\x1f\x7f]/.test(raw) || Buffer.byteLength(raw, 'utf8') > MAX_TOKEN_BYTES) {
    return {
      ok: false,
      present: true,
      code: 'invalid_token',
      error: 'invalid x-troy-agent header',
    }
  }

  return { ok: true, present: true, token: raw }
}

/**
 * Validate authentication on an incoming Agent Socket HTTP or WebSocket request.
 * Uses `timingSafeTokenEqual` for all secret comparisons.
 */
export function validateAgentTokenRequest(
  req: Pick<http.IncomingMessage, 'headers'> & { rawHeaders?: string[] },
  expectedToken: string,
  opts: TokenValidationOptions = {},
): TokenValidationResult {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    return {
      ok: false,
      code: 'empty_expected_token',
      error: 'missing or invalid x-troy-agent token',
    }
  }

  const extracted = extractAgentTokenHeader(req)
  const queryToken = typeof opts.queryToken === 'string' && opts.queryToken.length > 0 ? opts.queryToken : undefined

  if (extracted.present) {
    if (!extracted.ok || !extracted.token) {
      return {
        ok: false,
        code: extracted.code ?? 'invalid_token',
        error: 'missing or invalid x-troy-agent token',
      }
    }
    const headerMatches = timingSafeTokenEqual(extracted.token, expectedToken)
    if (!headerMatches) {
      return {
        ok: false,
        code: 'token_mismatch',
        error: 'missing or invalid x-troy-agent token',
      }
    }
    if (queryToken !== undefined && !timingSafeTokenEqual(queryToken, expectedToken)) {
      return {
        ok: false,
        code: 'token_mismatch',
        error: 'missing or invalid x-troy-agent token',
      }
    }
    return { ok: true }
  }

  if (queryToken !== undefined) {
    if (/[\x00-\x1f\x7f]/.test(queryToken) || Buffer.byteLength(queryToken, 'utf8') > MAX_TOKEN_BYTES) {
      return {
        ok: false,
        code: 'invalid_token',
        error: 'missing or invalid x-troy-agent token',
      }
    }
    if (timingSafeTokenEqual(queryToken, expectedToken)) {
      return { ok: true }
    }
    return {
      ok: false,
      code: 'token_mismatch',
      error: 'missing or invalid x-troy-agent token',
    }
  }

  return {
    ok: false,
    code: 'missing_token',
    error: 'missing or invalid x-troy-agent token',
  }
}
