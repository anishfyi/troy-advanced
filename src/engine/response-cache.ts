// HTTP Response Cache for the Zero-Chrome Lite engine (M40).
// Supports ETag / If-None-Match, Last-Modified / If-Modified-Since, Cache-Control
// (no-store, no-cache, max-age, must-revalidate), Expires, Age, Vary matching,
// unsafe-method invalidation (RFC 9111 §4.4), and bounded LRU eviction.

export type CacheStatus = 'hit' | 'revalidated' | 'miss' | 'bypass'

export interface ResponseCacheOptions {
  /** Enable HTTP response caching in Lite mode. Default: true. */
  enabled?: boolean
  /** Maximum number of cached entries before LRU eviction. Default: 200. */
  maxEntries?: number
  /** Maximum aggregate cached body bytes before LRU eviction. Default: 20 MiB. */
  maxTotalBytes?: number
  /** Maximum body size for a single cacheable entry. Default: 2 MiB. */
  maxEntryBytes?: number
  /** Serve fresh max-age / Expires responses without hitting the network. Default: true. */
  respectFreshness?: boolean
  /** Fallback freshness TTL (ms) when no max-age / Expires is sent. Default: 0 (always revalidate via ETag/Last-Modified). */
  defaultTtlMs?: number
}

export interface ResolvedResponseCachePolicy {
  enabled: boolean
  maxEntries: number
  maxTotalBytes: number
  maxEntryBytes: number
  respectFreshness: boolean
  defaultTtlMs: number
}

export interface ResponseCacheHooks {
  /** Clock override for deterministic testing. */
  now?: () => number
}

export interface ParsedCacheControl {
  noStore: boolean
  noCache: boolean
  mustRevalidate: boolean
  isPrivate: boolean
  isPublic: boolean
  maxAge?: number
  sMaxAge?: number
}

export interface ResponseCacheEntry {
  url: string
  status: number
  statusText: string
  contentType: string
  headers: Record<string, string>
  body: string
  sizeBytes: number
  etag?: string
  lastModified?: string
  varyHeaderNames: string[]
  varyValues: Record<string, string>
  authFingerprint: string
  noCache: boolean
  storedAt: number
  expiresAt: number
  hits: number
  revalidations: number
}

export interface ResponseCacheSummaryEntry {
  url: string
  status: number
  contentType: string
  sizeBytes: number
  etag?: string
  lastModified?: string
  noCache: boolean
  storedAt: number
  expiresAt: number
  fresh: boolean
  hits: number
  revalidations: number
}

export interface ResponseCacheStats {
  enabled: boolean
  entries: number
  totalBytes: number
  hits: number
  revalidated: number
  misses: number
  bypasses: number
  stores: number
  evictions: number
  invalidations: number
  bytesSaved: number
}

export type CacheLookupResult =
  | { status: 'fresh'; entry: ResponseCacheEntry }
  | { status: 'stale'; entry: ResponseCacheEntry; conditionalHeaders: Record<string, string> }
  | { status: 'miss' }
  | { status: 'bypass' }

export interface CacheStoreInput {
  url: string
  status: number
  statusText?: string
  headers: Headers | Record<string, string>
  requestHeaders?: Headers | Record<string, string>
  body: string
}

export const DEFAULT_RESPONSE_CACHE_POLICY: ResolvedResponseCachePolicy = {
  enabled: true,
  maxEntries: 200,
  maxTotalBytes: 20 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  respectFreshness: true,
  defaultTtlMs: 0,
}

export function normalizeCacheUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    const hashIdx = rawUrl.indexOf('#')
    return hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl
  }
}

function toHeaderRecord(raw?: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  if (typeof Headers !== 'undefined' && raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) {
      out[k] = String(v)
    }
  }
  return out
}

function getHeaderCI(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}

function setHeaderCI(headers: Record<string, string>, name: string, value: string): void {
  const target = name.toLowerCase()
  for (const existingKey of Object.keys(headers)) {
    if (existingKey.toLowerCase() === target) {
      delete headers[existingKey]
    }
  }
  headers[name] = value
}

export function parseCacheControl(header: string | null | undefined): ParsedCacheControl {
  const out: ParsedCacheControl = {
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    isPrivate: false,
    isPublic: false,
  }
  if (!header) return out

  const directiveRe = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|([^\s,]*)))?/g
  let m: RegExpExecArray | null
  while ((m = directiveRe.exec(header)) !== null) {
    const name = (m[1] ?? '').toLowerCase()
    const rawVal = m[2] ?? m[3]
    switch (name) {
      case 'no-store':
        out.noStore = true
        break
      case 'no-cache':
        out.noCache = true
        break
      case 'must-revalidate':
        out.mustRevalidate = true
        break
      case 'private':
        out.isPrivate = true
        break
      case 'public':
        out.isPublic = true
        break
      case 'max-age': {
        if (rawVal !== undefined && /^\d+$/.test(rawVal.trim())) {
          const parsed = Number.parseInt(rawVal.trim(), 10)
          if (Number.isFinite(parsed) && parsed >= 0) {
            out.maxAge = parsed
          }
        }
        break
      }
      case 's-maxage': {
        if (rawVal !== undefined && /^\d+$/.test(rawVal.trim())) {
          const parsed = Number.parseInt(rawVal.trim(), 10)
          if (Number.isFinite(parsed) && parsed >= 0) {
            out.sMaxAge = parsed
          }
        }
        break
      }
      default:
        break
    }
  }
  return out
}

function parseVaryHeader(header: string | undefined): { wildcard: boolean; names: string[] } {
  if (!header) return { wildcard: false, names: [] }
  const names: string[] = []
  const seen = new Set<string>()
  for (const part of header.split(',')) {
    const token = part.trim().toLowerCase()
    if (!token) continue
    if (token === '*') return { wildcard: true, names: [] }
    if (!seen.has(token)) {
      seen.add(token)
      names.push(token)
    }
  }
  return { wildcard: false, names }
}

function computeFreshnessLifetimeMs(
  responseHeaders: Record<string, string>,
  cc: ParsedCacheControl,
  nowMs: number,
  defaultTtlMs: number,
): number {
  if (cc.noCache) return 0

  const ageHeader = getHeaderCI(responseHeaders, 'age')
  let ageMs = 0
  if (ageHeader !== undefined && /^\d+$/.test(ageHeader.trim())) {
    const ageSec = Number.parseInt(ageHeader.trim(), 10)
    if (Number.isFinite(ageSec) && ageSec > 0) {
      ageMs = ageSec * 1000
    }
  }

  if (cc.maxAge !== undefined) {
    return Math.max(0, cc.maxAge * 1000 - ageMs)
  }

  const expiresHeader = getHeaderCI(responseHeaders, 'expires')
  if (expiresHeader !== undefined) {
    const expiresMs = Date.parse(expiresHeader)
    if (!Number.isFinite(expiresMs)) return 0
    const dateHeader = getHeaderCI(responseHeaders, 'date')
    const dateMs = dateHeader ? Date.parse(dateHeader) : Number.NaN
    const baseMs = Number.isFinite(dateMs) ? dateMs : nowMs
    return Math.max(0, expiresMs - baseMs - ageMs)
  }

  const cacheControlRaw = getHeaderCI(responseHeaders, 'cache-control')
  if (!cacheControlRaw) {
    const pragma = getHeaderCI(responseHeaders, 'pragma')
    if (pragma && pragma.toLowerCase().includes('no-cache')) {
      return 0
    }
  }

  return Math.max(0, defaultTtlMs)
}

export function isCacheableMethod(method?: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m === 'GET' || m === 'HEAD'
}

export function isUnsafeMethod(method?: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && m !== 'TRACE'
}

export class ResponseCache {
  private policy: ResolvedResponseCachePolicy
  private entries = new Map<string, ResponseCacheEntry>()
  private totalBytes = 0
  private readonly clockNow: () => number
  private stats = {
    hits: 0,
    revalidated: 0,
    misses: 0,
    bypasses: 0,
    stores: 0,
    evictions: 0,
    invalidations: 0,
    bytesSaved: 0,
  }

  constructor(opts: ResponseCacheOptions = {}, hooks: ResponseCacheHooks = {}) {
    this.policy = this.resolvePolicy(opts)
    this.clockNow = hooks.now ?? (() => Date.now())
  }

  private resolvePolicy(opts: ResponseCacheOptions, base: ResolvedResponseCachePolicy = DEFAULT_RESPONSE_CACHE_POLICY): ResolvedResponseCachePolicy {
    return {
      enabled: opts.enabled ?? base.enabled,
      maxEntries:
        typeof opts.maxEntries === 'number' && Number.isFinite(opts.maxEntries)
          ? Math.max(1, Math.min(10_000, Math.floor(opts.maxEntries)))
          : base.maxEntries,
      maxTotalBytes:
        typeof opts.maxTotalBytes === 'number' && Number.isFinite(opts.maxTotalBytes)
          ? Math.max(64, Math.floor(opts.maxTotalBytes))
          : base.maxTotalBytes,
      maxEntryBytes:
        typeof opts.maxEntryBytes === 'number' && Number.isFinite(opts.maxEntryBytes)
          ? Math.max(64, Math.floor(opts.maxEntryBytes))
          : base.maxEntryBytes,
      respectFreshness: opts.respectFreshness ?? base.respectFreshness,
      defaultTtlMs:
        typeof opts.defaultTtlMs === 'number' && Number.isFinite(opts.defaultTtlMs)
          ? Math.max(0, Math.floor(opts.defaultTtlMs))
          : base.defaultTtlMs,
    }
  }

  getPolicy(): ResolvedResponseCachePolicy {
    return { ...this.policy }
  }

  setPolicy(opts: ResponseCacheOptions): ResolvedResponseCachePolicy {
    this.policy = this.resolvePolicy(opts, this.policy)
    this.evictIfNeeded()
    return this.getPolicy()
  }

  getStats(): ResponseCacheStats {
    return {
      enabled: this.policy.enabled,
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      ...this.stats,
    }
  }

  now(): number {
    return this.clockNow()
  }

  recordMiss(): void {
    this.stats.misses += 1
  }

  private touchLru(key: string, entry: ResponseCacheEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private deleteKey(key: string): boolean {
    const existing = this.entries.get(key)
    if (!existing) return false
    this.entries.delete(key)
    this.totalBytes = Math.max(0, this.totalBytes - existing.sizeBytes)
    return true
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.policy.maxEntries || this.totalBytes > this.policy.maxTotalBytes) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      if (this.deleteKey(oldestKey)) {
        this.stats.evictions += 1
      }
    }
  }

  private matchesRequest(entry: ResponseCacheEntry, reqHeaders: Record<string, string>): boolean {
    const reqAuth = getHeaderCI(reqHeaders, 'authorization') ?? ''
    if (entry.authFingerprint !== reqAuth) return false
    for (const name of entry.varyHeaderNames) {
      const currentVal = (getHeaderCI(reqHeaders, name) ?? '').trim()
      const storedVal = entry.varyValues[name] ?? ''
      if (currentVal !== storedVal) return false
    }
    return true
  }

  lookup(
    rawUrl: string,
    requestHeaders?: Headers | Record<string, string>,
    opts: { forceRevalidate?: boolean; recordStats?: boolean } = {},
  ): CacheLookupResult {
    const recordStats = opts.recordStats !== false
    if (!this.policy.enabled) {
      if (recordStats) this.stats.bypasses += 1
      return { status: 'bypass' }
    }

    const reqHeaders = toHeaderRecord(requestHeaders)
    const reqCc = parseCacheControl(getHeaderCI(reqHeaders, 'cache-control'))
    if (reqCc.noStore) {
      if (recordStats) this.stats.bypasses += 1
      return { status: 'bypass' }
    }

    const key = normalizeCacheUrl(rawUrl)
    const entry = this.entries.get(key)
    if (!entry || !this.matchesRequest(entry, reqHeaders)) {
      if (recordStats) this.stats.misses += 1
      return { status: 'miss' }
    }

    const nowMs = this.clockNow()
    const forceRevalidate =
      Boolean(opts.forceRevalidate) ||
      reqCc.noCache ||
      reqCc.maxAge === 0 ||
      Boolean(getHeaderCI(reqHeaders, 'pragma')?.toLowerCase().includes('no-cache'))

    const isFresh =
      this.policy.respectFreshness &&
      !forceRevalidate &&
      !entry.noCache &&
      nowMs < entry.expiresAt

    if (isFresh) {
      this.touchLru(key, entry)
      if (recordStats) {
        entry.hits += 1
        this.stats.hits += 1
        this.stats.bytesSaved += entry.sizeBytes
      }
      return { status: 'fresh', entry }
    }

    const conditionalHeaders: Record<string, string> = {}
    if (entry.etag && !getHeaderCI(reqHeaders, 'if-none-match')) {
      conditionalHeaders['if-none-match'] = entry.etag
    }
    if (entry.lastModified && !getHeaderCI(reqHeaders, 'if-modified-since')) {
      conditionalHeaders['if-modified-since'] = entry.lastModified
    }

    if (Object.keys(conditionalHeaders).length > 0) {
      return { status: 'stale', entry, conditionalHeaders }
    }

    if (recordStats) this.stats.misses += 1
    return { status: 'miss' }
  }

  store(input: CacheStoreInput): boolean {
    if (!this.policy.enabled) return false

    const key = normalizeCacheUrl(input.url)
    const resHeaders = toHeaderRecord(input.headers)
    const reqHeaders = toHeaderRecord(input.requestHeaders)
    const reqCc = parseCacheControl(getHeaderCI(reqHeaders, 'cache-control'))
    const resCc = parseCacheControl(getHeaderCI(resHeaders, 'cache-control'))

    if (reqCc.noStore || resCc.noStore) {
      if (this.deleteKey(key)) {
        this.stats.invalidations += 1
      }
      return false
    }

    // Only cache 200 OK responses for Lite pages
    if (input.status !== 200) {
      return false
    }

    const vary = parseVaryHeader(getHeaderCI(resHeaders, 'vary'))
    if (vary.wildcard) {
      this.deleteKey(key)
      return false
    }

    const sizeBytes = Buffer.byteLength(input.body, 'utf8')
    if (sizeBytes > this.policy.maxEntryBytes) {
      return false
    }

    const nowMs = this.clockNow()
    const etag = getHeaderCI(resHeaders, 'etag')?.trim() || undefined
    const lastModified = getHeaderCI(resHeaders, 'last-modified')?.trim() || undefined
    const freshnessMs = computeFreshnessLifetimeMs(resHeaders, resCc, nowMs, this.policy.defaultTtlMs)

    // Store only if we have a validator (ETag/Last-Modified) or positive freshness TTL
    if (!etag && !lastModified && freshnessMs <= 0) {
      return false
    }

    const varyValues: Record<string, string> = {}
    for (const name of vary.names) {
      varyValues[name] = (getHeaderCI(reqHeaders, name) ?? '').trim()
    }

    const entry: ResponseCacheEntry = {
      url: key,
      status: input.status,
      statusText: input.statusText ?? 'OK',
      contentType: getHeaderCI(resHeaders, 'content-type') ?? '',
      headers: resHeaders,
      body: input.body,
      sizeBytes,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      varyHeaderNames: vary.names,
      varyValues,
      authFingerprint: getHeaderCI(reqHeaders, 'authorization') ?? '',
      noCache: resCc.noCache,
      storedAt: nowMs,
      expiresAt: freshnessMs > 0 ? nowMs + freshnessMs : nowMs,
      hits: 0,
      revalidations: 0,
    }

    this.deleteKey(key)
    this.entries.set(key, entry)
    this.totalBytes += sizeBytes
    this.stats.stores += 1
    this.evictIfNeeded()
    return true
  }

  revalidate304(
    rawUrl: string,
    requestHeaders: Headers | Record<string, string> | undefined,
    responseHeaders: Headers | Record<string, string>,
  ): ResponseCacheEntry | null {
    const key = normalizeCacheUrl(rawUrl)
    const entry = this.entries.get(key)
    if (!entry) return null

    const reqHeaders = toHeaderRecord(requestHeaders)
    const res304Headers = toHeaderRecord(responseHeaders)
    const resCc = parseCacheControl(getHeaderCI(res304Headers, 'cache-control'))

    const mergedHeaders: Record<string, string> = { ...entry.headers }
    for (const [k, v] of Object.entries(res304Headers)) {
      const lower = k.toLowerCase()
      if (lower === 'content-length' || lower === 'connection' || lower === 'transfer-encoding') continue
      setHeaderCI(mergedHeaders, k, v)
    }

    const nowMs = this.clockNow()
    const mergedCc = parseCacheControl(getHeaderCI(mergedHeaders, 'cache-control'))
    const etag = getHeaderCI(mergedHeaders, 'etag')?.trim() || entry.etag
    const lastModified = getHeaderCI(mergedHeaders, 'last-modified')?.trim() || entry.lastModified
    const freshnessMs = computeFreshnessLifetimeMs(mergedHeaders, mergedCc, nowMs, this.policy.defaultTtlMs)
    const vary = parseVaryHeader(getHeaderCI(mergedHeaders, 'vary'))
    const varyValues: Record<string, string> = {}
    for (const name of vary.names) {
      varyValues[name] = (getHeaderCI(reqHeaders, name) ?? '').trim()
    }

    const updated: ResponseCacheEntry = {
      ...entry,
      contentType: getHeaderCI(mergedHeaders, 'content-type') ?? entry.contentType,
      headers: mergedHeaders,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      varyHeaderNames: vary.names,
      varyValues,
      noCache: mergedCc.noCache,
      storedAt: nowMs,
      expiresAt: freshnessMs > 0 ? nowMs + freshnessMs : nowMs,
      revalidations: entry.revalidations + 1,
    }

    this.stats.revalidated += 1
    this.stats.bytesSaved += entry.sizeBytes

    if (resCc.noStore || vary.wildcard) {
      this.deleteKey(key)
      this.stats.invalidations += 1
      return updated
    }

    this.touchLru(key, updated)
    return updated
  }

  invalidate(rawUrl: string): boolean {
    const key = normalizeCacheUrl(rawUrl)
    if (this.deleteKey(key)) {
      this.stats.invalidations += 1
      return true
    }
    return false
  }

  clear(origin?: string): number {
    if (!origin) {
      const count = this.entries.size
      this.entries.clear()
      this.totalBytes = 0
      return count
    }
    let normalizedOrigin = origin
    try {
      normalizedOrigin = new URL(origin).origin
    } catch {
      // keep as-is
    }
    let removed = 0
    for (const key of Array.from(this.entries.keys())) {
      try {
        if (new URL(key).origin === normalizedOrigin) {
          if (this.deleteKey(key)) removed += 1
        }
      } catch {
        // ignore malformed keys
      }
    }
    return removed
  }

  has(rawUrl: string): boolean {
    return this.entries.has(normalizeCacheUrl(rawUrl))
  }

  list(): ResponseCacheSummaryEntry[] {
    const nowMs = this.clockNow()
    const out: ResponseCacheSummaryEntry[] = []
    for (const entry of this.entries.values()) {
      out.push({
        url: entry.url,
        status: entry.status,
        contentType: entry.contentType,
        sizeBytes: entry.sizeBytes,
        ...(entry.etag ? { etag: entry.etag } : {}),
        ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
        noCache: entry.noCache,
        storedAt: entry.storedAt,
        expiresAt: entry.expiresAt,
        fresh: !entry.noCache && nowMs < entry.expiresAt,
        hits: entry.hits,
        revalidations: entry.revalidations,
      })
    }
    return out
  }
}
