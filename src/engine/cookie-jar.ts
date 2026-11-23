// Persistent file-backed RFC 6265 CookieJar for the Zero-Chrome Lite engine.
// Stores cookies in `<profileDir>/cookies.json` with strict 0o600 permissions,
// handling Domain (host-only vs domain-scoped), Path (including RFC 6265 default-path
// and longest-path-first ordering), Expires/Max-Age, Secure, HttpOnly, and cookie prefixes.

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type {
  BrowserCookie,
  CookieExportOptions,
  CookieImportResult,
  CookieSameSite,
} from '../types.js'
import {
  cookieStorageKey,
  domainFilterMatches,
  domainMatches,
  filterCookies,
  isCookieExpired,
  normalizeCookie,
  normalizeSameSite,
  pathMatches,
} from './cookies.js'

export interface StoredCookie extends BrowserCookie {
  /** True when set without an explicit Domain attribute (RFC 6265 host-only). */
  hostOnly?: boolean
  /** Creation timestamp in epoch ms for RFC 6265 §5.4 tie-breaking order. */
  createdAt?: number
}

export interface CookieJarOptions {
  /** Backing file path (e.g. `<profileDir>/cookies.json`). Null/undefined = in-memory only. */
  filePath?: string | null
  /** Whether to persist session cookies (without Expires/Max-Age) to disk. Default: false (RFC 6265). */
  persistSessionCookies?: boolean
  /** Optional clock returning epoch seconds (useful for deterministic tests). */
  nowSec?: () => number
}

interface PersistedCookieJarFile {
  version: 1
  updatedAt: string
  cookies: StoredCookie[]
}

/**
 * RFC 6265 §5.1.4 default-path algorithm.
 * Given a request URI path, computes the default Path when Set-Cookie omits Path=.
 */
export function computeDefaultCookiePath(requestPathname: string): string {
  if (!requestPathname || !requestPathname.startsWith('/')) return '/'
  const lastSlash = requestPathname.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return requestPathname.slice(0, lastSlash)
}

function isIpAddress(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return net.isIP(bare) !== 0
}

function toPublicBrowserCookie(cookie: StoredCookie): BrowserCookie {
  const out: BrowserCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
  }
  if (cookie.expires !== undefined) out.expires = cookie.expires
  if (cookie.httpOnly) out.httpOnly = true
  if (cookie.secure) out.secure = true
  if (cookie.sameSite) out.sameSite = cookie.sameSite
  return out
}

function cookieMatchesHost(cookie: StoredCookie, requestHost: string): boolean {
  const cleanHost = requestHost.trim().toLowerCase()
  const cleanDomain = cookie.domain.trim().toLowerCase().replace(/^\./, '')
  if (!cleanHost || !cleanDomain) return false

  // Host-only cookies match ONLY the exact hostname.
  // If hostOnly is explicitly false or the domain has a leading dot, allow subdomain suffix match.
  const isHostOnly = cookie.hostOnly ?? !cookie.domain.startsWith('.')
  if (isHostOnly || isIpAddress(cleanHost) || isIpAddress(cleanDomain)) {
    return cleanHost === cleanDomain
  }
  return domainMatches(cleanDomain, cleanHost)
}

export class CookieJar {
  readonly filePath: string | null
  readonly persistSessionCookies: boolean
  private readonly clock: () => number
  private cookies = new Map<string, StoredCookie>()
  private creationSeq = 0

  constructor(opts: CookieJarOptions = {}) {
    this.filePath = opts.filePath ? path.resolve(opts.filePath) : null
    this.persistSessionCookies = Boolean(opts.persistSessionCookies)
    this.clock = opts.nowSec ?? (() => Math.floor(Date.now() / 1000))
    if (this.filePath) {
      this.load()
    }
  }

  get size(): number {
    return this.cookies.size
  }

  private nowSec(override?: number): number {
    return override ?? this.clock()
  }

  /** Load persisted cookies from disk (pruning expired entries). */
  load(): void {
    if (!this.filePath) return
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? ((parsed as { cookies: unknown[] }).cookies)
        : []

    const now = this.nowSec()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Partial<StoredCookie> & Record<string, unknown>
      const normalized = normalizeCookie(rec)
      if (!normalized) continue
      if (isCookieExpired(normalized, now)) continue
      const stored: StoredCookie = {
        ...normalized,
        hostOnly: typeof rec.hostOnly === 'boolean' ? rec.hostOnly : !normalized.domain.startsWith('.'),
        createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt)
          ? rec.createdAt
          : Date.now() + this.creationSeq++,
      }
      this.cookies.set(cookieStorageKey(stored), stored)
    }
  }

  /** Atomically persist cookies to disk with 0o600 permissions. */
  flush(nowSecOverride?: number): void {
    if (!this.filePath) return
    const now = this.nowSec(nowSecOverride)
    const persisted: StoredCookie[] = []

    for (const [key, cookie] of this.cookies) {
      if (isCookieExpired(cookie, now)) {
        this.cookies.delete(key)
        continue
      }
      // RFC 6265: only persist cookies with an expiry unless persistSessionCookies is enabled
      if (cookie.expires !== undefined || this.persistSessionCookies) {
        persisted.push({ ...cookie })
      }
    }

    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload: PersistedCookieJarFile = {
      version: 1,
      updatedAt: new Date(now * 1000).toISOString(),
      cookies: persisted,
    }
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      // ignore chmod failures on non-POSIX filesystems
    }
    fs.renameSync(tmp, this.filePath)
  }

  /**
   * Store or delete a normalized cookie directly.
   * Respects HttpOnly protection when `fromHttp === false` and Secure overwrite protection when `secureContext === false`.
   */
  set(
    raw: Partial<StoredCookie> & Record<string, unknown>,
    opts: {
      hostOnly?: boolean
      nowSec?: number
      fromHttp?: boolean
      secureContext?: boolean
      skipFlush?: boolean
    } = {},
  ): boolean {
    const normalized = normalizeCookie(raw)
    if (!normalized) return false

    const fromHttp = opts.fromHttp ?? true
    const secureContext = opts.secureContext ?? true
    const now = this.nowSec(opts.nowSec)

    // Non-HTTP APIs (e.g. document.cookie) cannot set HttpOnly cookies
    if (!fromHttp && normalized.httpOnly) return false

    const key = cookieStorageKey(normalized)
    const existing = this.cookies.get(key)

    // Non-HTTP APIs cannot overwrite an existing HttpOnly cookie (RFC 6265 §5.3 step 11.2)
    if (!fromHttp && existing?.httpOnly) return false

    // Insecure origin cannot overwrite an existing Secure cookie (RFC 6265bis)
    if (!secureContext && existing?.secure) return false

    if (isCookieExpired(normalized, now)) {
      const deleted = this.cookies.delete(key)
      if (deleted && !opts.skipFlush) this.flush(now)
      return true
    }

    const hostOnly =
      opts.hostOnly ??
      (typeof raw.hostOnly === 'boolean' ? raw.hostOnly : !normalized.domain.startsWith('.'))

    const stored: StoredCookie = {
      ...normalized,
      hostOnly,
      createdAt:
        existing?.createdAt ??
        (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
          ? raw.createdAt
          : Date.now() + this.creationSeq++),
    }

    this.cookies.set(key, stored)
    if (!opts.skipFlush) this.flush(now)
    return true
  }

  /**
   * Parse and store a single Set-Cookie header according to RFC 6265 / 6265bis.
   * Rejects foreign Domain attributes, invalid __Secure-/__Host- prefixes,
   * HttpOnly mutations from non-HTTP contexts, and Secure overwrites from HTTP.
   */
  setFromHeader(
    rawHeader: string,
    requestUrl: string,
    opts: { fromHttp?: boolean; nowSec?: number; skipFlush?: boolean } = {},
  ): StoredCookie | null {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(requestUrl)
    } catch {
      return null
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null

    const fromHttp = opts.fromHttp ?? true
    const secureContext = parsedUrl.protocol === 'https:'
    const now = this.nowSec(opts.nowSec)

    const parts = rawHeader.split(';').map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) return null
    const first = parts[0]!
    const eq = first.indexOf('=')
    if (eq <= 0) return null
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name || /[\r\n;=]/.test(name) || /[\r\n]/.test(value)) return null

    const reqHost = parsedUrl.hostname.toLowerCase()
    let domain = reqHost
    let hostOnly = true
    let hasExplicitDomain = false
    let cookiePath = computeDefaultCookiePath(parsedUrl.pathname || '/')
    let expires: number | undefined
    let hasMaxAge = false
    let httpOnly = false
    let secure = false
    let sameSite: CookieSameSite | undefined

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i]!
      const attrEq = attr.indexOf('=')
      const key = (attrEq >= 0 ? attr.slice(0, attrEq) : attr).trim().toLowerCase()
      const val = attrEq >= 0 ? attr.slice(attrEq + 1).trim() : ''

      switch (key) {
        case 'domain': {
          const cleaned = val.toLowerCase().replace(/^\./, '')
          if (!cleaned) break
          // Reject foreign domains (RFC 6265 §5.3 step 6)
          if (isIpAddress(reqHost) || isIpAddress(cleaned)) {
            if (cleaned !== reqHost) return null
            domain = reqHost
            hostOnly = true
            hasExplicitDomain = true
          } else {
            if (!domainMatches(cleaned, reqHost)) return null
            domain = `.${cleaned}`
            hostOnly = false
            hasExplicitDomain = true
          }
          break
        }
        case 'path':
          if (val.startsWith('/')) cookiePath = val
          break
        case 'max-age': {
          const secs = Number.parseInt(val, 10)
          if (Number.isFinite(secs)) {
            hasMaxAge = true
            expires = secs <= 0 ? 1 : now + secs
          }
          break
        }
        case 'expires': {
          if (!hasMaxAge) {
            const ts = Date.parse(val)
            if (Number.isFinite(ts)) {
              expires = Math.floor(ts / 1000)
            }
          }
          break
        }
        case 'httponly':
          httpOnly = true
          break
        case 'secure':
          secure = true
          break
        case 'samesite':
          sameSite = normalizeSameSite(val)
          break
      }
    }

    // RFC 6265bis Cookie Prefixes
    if (name.startsWith('__Secure-')) {
      if (!secure || !secureContext) return null
    }
    if (name.startsWith('__Host-')) {
      if (!secure || !secureContext || hasExplicitDomain || cookiePath !== '/') return null
    }

    // SameSite=None requires Secure
    if (sameSite === 'None' && !secure) {
      secure = true
    }

    const candidate: StoredCookie = {
      name,
      value,
      domain,
      path: cookiePath,
      hostOnly,
    }
    if (expires !== undefined) candidate.expires = expires
    if (httpOnly) candidate.httpOnly = true
    if (secure) candidate.secure = true
    if (sameSite) candidate.sameSite = sameSite

    const accepted = this.set(candidate as unknown as Partial<StoredCookie> & Record<string, unknown>, {
      hostOnly,
      nowSec: now,
      fromHttp,
      secureContext,
      skipFlush: opts.skipFlush,
    })
    if (!accepted) return null
    return this.cookies.get(cookieStorageKey(candidate)) ?? null
  }

  /** Parse and store all Set-Cookie headers from a Fetch Headers object or string array. */
  setFromHeaders(
    headers: Headers | string[],
    requestUrl: string,
    opts: { fromHttp?: boolean; nowSec?: number } = {},
  ): StoredCookie[] {
    const rawList = Array.isArray(headers)
      ? headers
      : typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : []
    if (rawList.length === 0) return []

    const stored: StoredCookie[] = []
    for (const raw of rawList) {
      const c = this.setFromHeader(raw, requestUrl, { ...opts, skipFlush: true })
      if (c) stored.push(c)
    }
    this.flush(opts.nowSec)
    return stored
  }

  /**
   * Return all cookies matching `targetUrl`, ordered per RFC 6265 §5.4
   * (longest Path first, then earliest creation time).
   * Pass `{ http: false }` to simulate `document.cookie` (excludes HttpOnly cookies).
   */
  getCookiesForUrl(
    targetUrl: string,
    opts: { http?: boolean; nowSec?: number } = {},
  ): StoredCookie[] {
    let parsed: URL
    try {
      parsed = new URL(targetUrl)
    } catch {
      return []
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return []

    const isHttpApi = opts.http ?? true
    const now = this.nowSec(opts.nowSec)
    const isSecureReq = parsed.protocol === 'https:'
    const reqPath = parsed.pathname || '/'

    let pruned = false
    const matched: StoredCookie[] = []

    for (const [key, cookie] of this.cookies) {
      if (isCookieExpired(cookie, now)) {
        this.cookies.delete(key)
        pruned = true
        continue
      }
      if (cookie.secure && !isSecureReq) continue
      if (!isHttpApi && cookie.httpOnly) continue
      if (!cookieMatchesHost(cookie, parsed.hostname)) continue
      if (!pathMatches(cookie.path, reqPath)) continue
      matched.push({ ...cookie })
    }

    if (pruned) this.flush(now)

    // RFC 6265 §5.4 step 2: longer paths first, then earlier creation time
    matched.sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length
      return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    })

    return matched
  }

  /** Build the HTTP `Cookie` header string for `targetUrl`, or `undefined` if none match. */
  getCookieHeader(targetUrl: string, opts: { http?: boolean; nowSec?: number } = {}): string | undefined {
    const matched = this.getCookiesForUrl(targetUrl, opts)
    if (matched.length === 0) return undefined
    return matched.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  /** Simulate non-HTTP `document.cookie` getter (omits HttpOnly cookies). */
  getDocumentCookie(targetUrl: string, nowSec?: number): string {
    return this.getCookieHeader(targetUrl, { http: false, nowSec }) ?? ''
  }

  /** Simulate non-HTTP `document.cookie = ...` setter (cannot set or overwrite HttpOnly cookies). */
  setDocumentCookie(rawCookie: string, targetUrl: string, nowSec?: number): StoredCookie | null {
    return this.setFromHeader(rawCookie, targetUrl, { fromHttp: false, nowSec })
  }

  /** Remove all expired cookies and flush if any were removed. */
  pruneExpired(nowSecOverride?: number): number {
    const now = this.nowSec(nowSecOverride)
    let removed = 0
    for (const [key, cookie] of this.cookies) {
      if (isCookieExpired(cookie, now)) {
        this.cookies.delete(key)
        removed++
      }
    }
    if (removed > 0) this.flush(now)
    return removed
  }

  /** Return all stored cookies (optionally including expired). */
  getAll(opts: { includeExpired?: boolean; nowSec?: number } = {}): StoredCookie[] {
    const now = this.nowSec(opts.nowSec)
    const out: StoredCookie[] = []
    for (const cookie of this.cookies.values()) {
      if (!opts.includeExpired && isCookieExpired(cookie, now)) continue
      out.push({ ...cookie })
    }
    return out
  }

  /** Export cookies as clean `BrowserCookie[]` with optional domain/url/expiry filtering. */
  exportCookies(opts: CookieExportOptions = {}): BrowserCookie[] {
    const now = this.nowSec()
    const filtered = filterCookies([...this.cookies.values()], { ...opts, nowSec: now })
    return filtered.map((c) => toPublicBrowserCookie(c as StoredCookie))
  }

  /** Import cookies into the jar and persist to disk. */
  importCookies(cookies: BrowserCookie[], nowSecOverride?: number): CookieImportResult {
    let imported = 0
    let skipped = 0
    const errors: string[] = []
    const now = this.nowSec(nowSecOverride)

    for (const raw of cookies) {
      const normalized = normalizeCookie(raw as unknown as Partial<BrowserCookie> & Record<string, unknown>)
      if (!normalized) {
        skipped++
        errors.push(`Invalid cookie skipped: ${String((raw as { name?: unknown })?.name ?? '<unnamed>')}`)
        continue
      }
      const key = cookieStorageKey(normalized)
      if (isCookieExpired(normalized, now)) {
        this.cookies.delete(key)
        skipped++
        continue
      }
      const existing = this.cookies.get(key)
      const stored: StoredCookie = {
        ...normalized,
        hostOnly: !normalized.domain.startsWith('.'),
        createdAt: existing?.createdAt ?? Date.now() + this.creationSeq++,
      }
      this.cookies.set(key, stored)
      imported++
    }

    if (imported > 0 || skipped > 0) {
      this.flush(now)
    }

    return { imported, skipped, errors }
  }

  /** Clear all cookies (or cookies matching `domain`) and persist the change. */
  clear(opts: { domain?: string } = {}): number {
    if (!opts.domain) {
      const count = this.cookies.size
      this.cookies.clear()
      this.flush()
      return count
    }
    let removed = 0
    for (const [key, cookie] of this.cookies) {
      if (domainFilterMatches(cookie.domain, opts.domain)) {
        this.cookies.delete(key)
        removed++
      }
    }
    if (removed > 0) this.flush()
    return removed
  }

  /** Flush persisted cookies to disk, then release in-memory references without deleting the file. */
  close(): void {
    this.flush()
    this.cookies.clear()
  }
}
