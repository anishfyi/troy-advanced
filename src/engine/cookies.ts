// Cookie normalization, filtering, Set-Cookie parsing, CDP conversion,
// and authenticated AES-256-GCM encryption for secure EC2 session transfer.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  BrowserCookie,
  CookieExportBundle,
  CookieExportOptions,
  CookieSameSite,
  EncryptedCookieBundle,
} from '../types.js'

const ENCRYPTION_AAD = Buffer.from('troy-advanced:cookies:v1', 'utf8')
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }

export function normalizeSameSite(raw: unknown): CookieSameSite | undefined {
  if (typeof raw !== 'string') return undefined
  const lower = raw.trim().toLowerCase()
  if (lower === 'strict') return 'Strict'
  if (lower === 'lax') return 'Lax'
  if (lower === 'none' || lower === 'no_restriction') return 'None'
  return undefined
}

export function normalizeCookie(raw: Partial<BrowserCookie> & Record<string, unknown>): BrowserCookie | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || /[\r\n;=]/.test(name)) return null
  const value = typeof raw.value === 'string' ? raw.value : raw.value !== undefined ? String(raw.value) : ''
  if (/[\r\n]/.test(value)) return null

  let domain = typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : ''
  if (!domain && typeof raw.url === 'string') {
    try {
      domain = new URL(raw.url).hostname.toLowerCase()
    } catch {
      domain = ''
    }
  }
  if (!domain) return null

  const rawPath = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : '/'
  const cookiePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`

  let expires: number | undefined
  const rawExpires = raw.expires ?? raw.expirationDate
  if (typeof rawExpires === 'number' && Number.isFinite(rawExpires) && rawExpires > 0) {
    // Handle milliseconds accidentally supplied by third-party exporters (> year 2286 in seconds)
    expires = rawExpires > 1e12 ? Math.floor(rawExpires / 1000) : Math.floor(rawExpires)
  }

  const sameSite = normalizeSameSite(raw.sameSite)
  const secure = Boolean(raw.secure) || sameSite === 'None'
  const httpOnly = Boolean(raw.httpOnly)

  const cookie: BrowserCookie = {
    name,
    value,
    domain,
    path: cookiePath,
  }
  if (expires !== undefined) cookie.expires = expires
  if (httpOnly) cookie.httpOnly = true
  if (secure) cookie.secure = true
  if (sameSite) cookie.sameSite = sameSite
  return cookie
}

export function cookieStorageKey(cookie: Pick<BrowserCookie, 'domain' | 'path' | 'name'>): string {
  return `${cookie.domain.toLowerCase()}\t${cookie.path || '/'}\t${cookie.name}`
}

export function isCookieExpired(cookie: Pick<BrowserCookie, 'expires'>, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSec
}

export function domainMatches(cookieDomain: string, filterOrHost: string): boolean {
  const cleanCookie = cookieDomain.trim().toLowerCase().replace(/^\./, '')
  const cleanTarget = filterOrHost.trim().toLowerCase().replace(/^\./, '')
  if (!cleanCookie || !cleanTarget) return false
  return cleanTarget === cleanCookie || cleanTarget.endsWith(`.${cleanCookie}`)
}

export function domainFilterMatches(cookieDomain: string, domainFilter: string): boolean {
  const cleanCookie = cookieDomain.trim().toLowerCase().replace(/^\./, '')
  const cleanFilter = domainFilter.trim().toLowerCase().replace(/^\./, '')
  if (!cleanCookie || !cleanFilter) return false
  return (
    cleanCookie === cleanFilter ||
    cleanCookie.endsWith(`.${cleanFilter}`) ||
    cleanFilter.endsWith(`.${cleanCookie}`)
  )
}

export function pathMatches(cookiePath: string, requestPath: string): boolean {
  const normCookie = cookiePath && cookiePath.startsWith('/') ? cookiePath : '/'
  const normReq = requestPath && requestPath.startsWith('/') ? requestPath : '/'
  if (normReq === normCookie) return true
  if (normCookie === '/') return true
  if (normReq.startsWith(normCookie)) {
    if (normCookie.endsWith('/')) return true
    if (normReq[normCookie.length] === '/') return true
  }
  return false
}

export function cookieMatchesUrl(
  cookie: BrowserCookie,
  targetUrl: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (isCookieExpired(cookie, nowSec)) return false
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return false
  }
  if (cookie.secure && parsed.protocol !== 'https:') return false
  if (!domainMatches(cookie.domain, parsed.hostname)) return false
  if (!pathMatches(cookie.path, parsed.pathname || '/')) return false
  return true
}

export function filterCookies(
  cookies: BrowserCookie[],
  opts: CookieExportOptions & { nowSec?: number } = {},
): BrowserCookie[] {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  let out = cookies
  if (!opts.includeExpired) {
    out = out.filter((c) => !isCookieExpired(c, nowSec))
  }
  if (opts.domain && opts.domain.trim()) {
    const dom = opts.domain.trim()
    out = out.filter((c) => domainFilterMatches(c.domain, dom))
  }
  if (opts.url && opts.url.trim()) {
    const url = opts.url.trim()
    out = out.filter((c) => cookieMatchesUrl(c, url, nowSec))
  }
  return out
}

export function parseSetCookieHeader(
  rawHeader: string,
  requestUrl: string,
  nowSec = Math.floor(Date.now() / 1000),
): BrowserCookie | null {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(requestUrl)
  } catch {
    return null
  }
  const parts = rawHeader.split(';').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const first = parts[0]!
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (!name) return null

  let domain = parsedUrl.hostname.toLowerCase()
  let cookiePath = '/'
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
        if (cleaned && domainMatches(cleaned, parsedUrl.hostname)) {
          domain = val.startsWith('.') ? `.${cleaned}` : cleaned
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
          expires = secs <= 0 ? 1 : nowSec + secs
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

  return normalizeCookie({
    name,
    value,
    domain,
    path: cookiePath,
    expires,
    httpOnly,
    secure,
    sameSite,
  })
}

export function fromCdpCookie(raw: Record<string, unknown>): BrowserCookie | null {
  return normalizeCookie({
    name: typeof raw.name === 'string' ? raw.name : '',
    value: typeof raw.value === 'string' ? raw.value : '',
    domain: typeof raw.domain === 'string' ? raw.domain : '',
    path: typeof raw.path === 'string' ? raw.path : '/',
    expires: typeof raw.expires === 'number' && raw.expires > 0 ? raw.expires : undefined,
    httpOnly: Boolean(raw.httpOnly),
    secure: Boolean(raw.secure),
    sameSite: normalizeSameSite(raw.sameSite),
  })
}

export function toCdpCookieParam(cookie: BrowserCookie): Record<string, unknown> {
  const param: Record<string, unknown> = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
  }
  if (typeof cookie.expires === 'number' && cookie.expires > 0) {
    param.expires = cookie.expires
  }
  if (cookie.httpOnly) param.httpOnly = true
  if (cookie.secure || cookie.sameSite === 'None') param.secure = true
  if (cookie.sameSite) param.sameSite = cookie.sameSite
  return param
}

export function createCookieBundle(
  cookies: BrowserCookie[],
  engine: 'chromium' | 'lite',
): CookieExportBundle {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    engine,
    count: cookies.length,
    cookies,
  }
}

export function encryptCookieBundle(
  bundle: CookieExportBundle,
  passphrase: string,
): EncryptedCookieBundle {
  if (!passphrase || passphrase.length < 1) {
    throw new Error('Passphrase is required to encrypt cookie bundle')
  }
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(ENCRYPTION_AAD)
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    version: 1,
    encrypted: true,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    exportedAt: bundle.exportedAt,
  }
}

export function decryptCookieBundle(
  envelope: EncryptedCookieBundle,
  passphrase: string,
): CookieExportBundle {
  if (!passphrase) {
    throw new Error('Encrypted cookie bundle requires a passphrase (--passphrase or TROY_COOKIE_PASSPHRASE)')
  }
  if (envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm') {
    throw new Error(`Unsupported cookie bundle encryption: ${envelope.kdf}/${envelope.cipher}`)
  }
  try {
    const salt = Buffer.from(envelope.salt, 'base64')
    const iv = Buffer.from(envelope.iv, 'base64')
    const authTag = Buffer.from(envelope.authTag, 'base64')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(ENCRYPTION_AAD)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plaintext) as CookieExportBundle
    if (!parsed || !Array.isArray(parsed.cookies)) {
      throw new Error('Decrypted payload is not a valid cookie bundle')
    }
    return parsed
  } catch (err) {
    if ((err as Error).message.includes('Decrypted payload')) throw err
    throw new Error('Failed to decrypt cookie bundle (invalid passphrase or corrupted data)')
  }
}

export function serializeCookieBundle(
  cookies: BrowserCookie[],
  opts: { engine: 'chromium' | 'lite'; passphrase?: string },
): string {
  const bundle = createCookieBundle(cookies, opts.engine)
  if (opts.passphrase) {
    return JSON.stringify(encryptCookieBundle(bundle, opts.passphrase), null, 2)
  }
  return JSON.stringify(bundle, null, 2)
}

export function parseCookieBundle(
  rawJson: string,
  opts: { passphrase?: string } = {},
): { cookies: BrowserCookie[]; encrypted: boolean; skipped: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('Cookie input is not valid JSON')
  }

  let encrypted = false
  let rawCookies: unknown[]

  if (Array.isArray(parsed)) {
    rawCookies = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (obj.encrypted === true) {
      encrypted = true
      const decrypted = decryptCookieBundle(obj as unknown as EncryptedCookieBundle, opts.passphrase ?? '')
      rawCookies = decrypted.cookies
    } else if (Array.isArray(obj.cookies)) {
      rawCookies = obj.cookies
    } else {
      throw new Error('Cookie JSON must be a CookieExportBundle, EncryptedCookieBundle, or array of cookies')
    }
  } else {
    throw new Error('Cookie JSON must be an object or array')
  }

  const cookies: BrowserCookie[] = []
  let skipped = 0
  for (const item of rawCookies) {
    if (!item || typeof item !== 'object') {
      skipped++
      continue
    }
    const normalized = normalizeCookie(item as Partial<BrowserCookie> & Record<string, unknown>)
    if (normalized) cookies.push(normalized)
    else skipped++
  }

  return { cookies, encrypted, skipped }
}

export function writeCookieFile(filePath: string, content: string): { path: string; bytes: number; mode: string } {
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(resolved, 0o600)
  } catch {
    // ignore chmod errors on non-POSIX filesystems
  }
  return { path: resolved, bytes: Buffer.byteLength(content, 'utf8'), mode: '0600' }
}

export function readCookieFile(filePath: string): string {
  const resolved = path.resolve(filePath)
  return fs.readFileSync(resolved, 'utf8')
}
