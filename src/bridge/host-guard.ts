// Strict DNS rebinding, Host header, and Origin header guard for the Agent Socket.
// Protects HTTP, SSE (/stream), and WebSocket (/ws) endpoints from DNS rebinding,
// Host header prefix-bypass attacks (e.g. localhost.evil.com, 127.0.0.1.nip.io),
// duplicate Host smuggling, and Cross-Site WebSocket Hijacking (CSWSH).

import type http from 'node:http'

export const LOOPBACK_HOSTS = new Set<string>(['127.0.0.1', 'localhost', '[::1]'])

export type HostValidationErrorCode =
  | 'missing_host'
  | 'duplicate_host'
  | 'invalid_host'
  | 'disallowed_host'
  | 'invalid_port'
  | 'port_mismatch'

export type OriginValidationErrorCode =
  | 'duplicate_origin'
  | 'invalid_origin'
  | 'disallowed_origin'

export interface HostValidationOptions {
  /** Expected listening port of the Agent Socket (used when strictPort is true). */
  expectedPort?: number
  /** When true, any port present in Host must exactly match expectedPort. */
  strictPort?: boolean
  /** Optional additional allowed hostnames (normalized to lowercase). */
  allowedHosts?: string[]
}

export interface HostValidationResult {
  ok: boolean
  host?: string
  port?: number
  code?: HostValidationErrorCode
  error?: string
}

export interface OriginValidationResult {
  ok: boolean
  origin?: string
  host?: string
  port?: number
  code?: OriginValidationErrorCode
  error?: string
}

export interface RequestHeaderGuardResult {
  ok: boolean
  status?: number
  code?: HostValidationErrorCode | OriginValidationErrorCode
  error?: string
  host?: string
  port?: number
  origin?: string
}

function buildAllowedHostSet(extra?: string[]): Set<string> {
  if (!extra || extra.length === 0) return LOOPBACK_HOSTS
  const allowed = new Set<string>(LOOPBACK_HOSTS)
  for (const h of extra) {
    const norm = h.trim().toLowerCase()
    if (norm) allowed.add(norm)
  }
  return allowed
}

/**
 * Strictly validate an HTTP `Host` header against RFC 9110 `uri-host [ ":" port ]`
 * and an exact loopback allowlist (`127.0.0.1`, `localhost`, `[::1]`).
 */
export function validateHostHeader(
  rawHost: string | string[] | undefined,
  opts: HostValidationOptions = {},
): HostValidationResult {
  if (rawHost === undefined || rawHost === null) {
    return { ok: false, code: 'missing_host', error: 'wrong host: missing Host header' }
  }
  if (Array.isArray(rawHost)) {
    return { ok: false, code: 'duplicate_host', error: 'wrong host: multiple Host headers' }
  }
  if (typeof rawHost !== 'string' || rawHost.length === 0) {
    return { ok: false, code: 'missing_host', error: 'wrong host: empty Host header' }
  }

  // Reject whitespace, control chars, CRLF, null bytes, and non-ASCII bytes.
  if (/[^\x21-\x7e]/.test(rawHost)) {
    return { ok: false, code: 'invalid_host', error: 'wrong host: invalid characters in Host header' }
  }

  // Reject userinfo, path, query, fragment, comma-separated lists, and backslashes.
  if (/[@/?#,\\]/.test(rawHost)) {
    return { ok: false, code: 'invalid_host', error: 'wrong host: forbidden delimiter in Host header' }
  }

  let hostPart: string
  let portPart: string | undefined

  if (rawHost.startsWith('[')) {
    const closeIdx = rawHost.indexOf(']')
    if (closeIdx === -1) {
      return { ok: false, code: 'invalid_host', error: 'wrong host: unclosed IPv6 literal' }
    }
    hostPart = rawHost.slice(0, closeIdx + 1).toLowerCase()
    const rest = rawHost.slice(closeIdx + 1)
    if (rest.length > 0) {
      if (!rest.startsWith(':')) {
        return { ok: false, code: 'invalid_host', error: 'wrong host: trailing characters after IPv6 literal' }
      }
      portPart = rest.slice(1)
    }
  } else {
    if (rawHost.includes('[') || rawHost.includes(']')) {
      return { ok: false, code: 'invalid_host', error: 'wrong host: malformed bracket in Host header' }
    }
    const firstColon = rawHost.indexOf(':')
    const lastColon = rawHost.lastIndexOf(':')
    if (firstColon !== lastColon) {
      return { ok: false, code: 'invalid_host', error: 'wrong host: multiple colons in Host header' }
    }
    if (firstColon === -1) {
      hostPart = rawHost.toLowerCase()
    } else {
      hostPart = rawHost.slice(0, firstColon).toLowerCase()
      portPart = rawHost.slice(firstColon + 1)
    }
  }

  const allowed = buildAllowedHostSet(opts.allowedHosts)
  if (!allowed.has(hostPart)) {
    return { ok: false, code: 'disallowed_host', error: `wrong host: "${hostPart}" is not an allowed loopback host` }
  }

  let port: number | undefined
  if (portPart !== undefined) {
    if (!/^[1-9]\d{0,4}$/.test(portPart)) {
      return { ok: false, code: 'invalid_port', error: 'wrong host: invalid port in Host header' }
    }
    const parsedPort = Number(portPart)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return { ok: false, code: 'invalid_port', error: 'wrong host: port out of range' }
    }
    if (opts.strictPort && opts.expectedPort !== undefined && parsedPort !== opts.expectedPort) {
      return {
        ok: false,
        code: 'port_mismatch',
        error: `wrong host: port ${parsedPort} does not match listening port ${opts.expectedPort}`,
      }
    }
    port = parsedPort
  }

  return { ok: true, host: hostPart, ...(port !== undefined ? { port } : {}) }
}

/**
 * Validate an optional HTTP `Origin` header.
 * Non-browser clients omit `Origin` and are allowed; if `Origin` is present,
 * it must be an explicit `http:` or `https:` loopback origin (rejects `null`,
 * `file:`, `evil.com`, `localhost.evil.com`, etc.).
 */
export function validateOriginHeader(
  rawOrigin: string | string[] | undefined,
  opts: Pick<HostValidationOptions, 'allowedHosts'> = {},
): OriginValidationResult {
  if (rawOrigin === undefined) {
    return { ok: true }
  }
  if (Array.isArray(rawOrigin)) {
    return { ok: false, code: 'duplicate_origin', error: 'forbidden origin: multiple Origin headers' }
  }
  if (typeof rawOrigin !== 'string' || rawOrigin.length === 0) {
    return { ok: false, code: 'invalid_origin', error: 'forbidden origin: empty Origin header' }
  }
  if (/[^\x21-\x7e]/.test(rawOrigin)) {
    return { ok: false, code: 'invalid_origin', error: 'forbidden origin: invalid characters in Origin header' }
  }
  if (rawOrigin.toLowerCase() === 'null') {
    return { ok: false, code: 'disallowed_origin', error: 'forbidden origin: null origin is not allowed' }
  }

  const match = /^https?:\/\/([^\s/?#@\\]+)$/i.exec(rawOrigin)
  if (!match) {
    return { ok: false, code: 'invalid_origin', error: 'forbidden origin: malformed or unsupported Origin scheme' }
  }

  const hostCheck = validateHostHeader(match[1], { allowedHosts: opts.allowedHosts })
  if (!hostCheck.ok) {
    return {
      ok: false,
      code: hostCheck.code === 'disallowed_host' ? 'disallowed_origin' : 'invalid_origin',
      error: `forbidden origin: ${hostCheck.error?.replace(/^wrong host:\s*/, '') ?? 'not a loopback origin'}`,
    }
  }

  return {
    ok: true,
    origin: rawOrigin,
    host: hostCheck.host,
    ...(hostCheck.port !== undefined ? { port: hostCheck.port } : {}),
  }
}

/**
 * Full request-level DNS rebinding guard checking rawHeaders for duplicate Host/Origin
 * headers, then strictly validating both `Host` and optional `Origin`.
 */
export function validateAgentRequestHeaders(
  req: Pick<http.IncomingMessage, 'headers'> & { rawHeaders?: string[] },
  opts: HostValidationOptions = {},
): RequestHeaderGuardResult {
  if (Array.isArray(req.rawHeaders)) {
    let hostCount = 0
    let originCount = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]?.toLowerCase()
      if (name === 'host') hostCount++
      else if (name === 'origin') originCount++
    }
    if (hostCount > 1) {
      return {
        ok: false,
        status: 403,
        code: 'duplicate_host',
        error: 'wrong host: multiple Host headers',
      }
    }
    if (originCount > 1) {
      return {
        ok: false,
        status: 403,
        code: 'duplicate_origin',
        error: 'forbidden origin: multiple Origin headers',
      }
    }
  }

  const hostRes = validateHostHeader(req.headers.host, opts)
  if (!hostRes.ok) {
    return {
      ok: false,
      status: 403,
      code: hostRes.code,
      error: hostRes.error ?? 'wrong host',
    }
  }

  const originRes = validateOriginHeader(req.headers.origin, { allowedHosts: opts.allowedHosts })
  if (!originRes.ok) {
    return {
      ok: false,
      status: 403,
      code: originRes.code,
      error: originRes.error ?? 'forbidden origin',
    }
  }

  return {
    ok: true,
    host: hostRes.host,
    ...(hostRes.port !== undefined ? { port: hostRes.port } : {}),
    ...(originRes.origin !== undefined ? { origin: originRes.origin } : {}),
  }
}
