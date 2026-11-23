// Robots.txt parser/cache (RFC 9309 + Crawl-delay), per-origin rate-limit awareness,
// and configurable HTTP 429/503 exponential-backoff retry controller for Lite engine.

export interface RobotsRule {
  directive: 'allow' | 'disallow'
  pattern: string
}

export interface RobotsGroup {
  userAgents: string[]
  rules: RobotsRule[]
  crawlDelayMs?: number
}

export interface RobotsDocument {
  groups: RobotsGroup[]
  sitemaps: string[]
}

export interface RobotsDecision {
  allowed: boolean
  matchedAgent?: string
  matchedRule?: RobotsRule
  crawlDelayMs?: number
  source: 'robots.txt' | 'allow-all' | 'bypass' | 'error-fallback'
}

export interface RobotsPolicyOptions {
  /** Enable robots.txt checking & Crawl-delay enforcement (default: false). */
  enabled?: boolean
  /** Override User-Agent token used when evaluating robots.txt rules. */
  userAgent?: string
  /** Cache TTL for fetched robots.txt documents in ms (default: 300000 = 5m). */
  cacheTtlMs?: number
  /** Cap Crawl-delay enforcement in ms so extreme values do not hang requests (default: 10000). */
  maxCrawlDelayMs?: number
  /** Whether to allow requests if fetching /robots.txt fails with 5xx or network error (default: true). */
  failOpen?: boolean
  /** Timeout in ms when fetching /robots.txt (default: 5000). */
  fetchTimeoutMs?: number
}

export interface ResolvedRobotsPolicy {
  enabled: boolean
  userAgent?: string
  cacheTtlMs: number
  maxCrawlDelayMs: number
  failOpen: boolean
  fetchTimeoutMs: number
}

export interface RetryPolicyOptions {
  /** Enable automatic retries on retryable HTTP statuses (default: true). */
  enabled?: boolean
  /** Maximum number of retry attempts after the initial request (default: 3). */
  maxRetries?: number
  /** HTTP status codes eligible for retry (default: [429, 503]). */
  retryStatuses?: number[]
  /** Initial backoff delay in ms before attempt 1 (default: 500). */
  baseDelayMs?: number
  /** Maximum backoff or Retry-After wait delay in ms (default: 15000). */
  maxDelayMs?: number
  /** Exponential multiplier per attempt (default: 2). */
  backoffFactor?: number
  /** Symmetric jitter ratio in [0, 1] applied to exponential backoff (default: 0.2). */
  jitterRatio?: number
  /** Honor HTTP Retry-After headers when computing retry delay (default: true). */
  respectRetryAfter?: boolean
  /** Allow retrying non-idempotent methods like POST/PATCH on 429/503 (default: false). */
  retryNonIdempotent?: boolean
}

export interface ResolvedRetryPolicy {
  enabled: boolean
  maxRetries: number
  retryStatuses: number[]
  baseDelayMs: number
  maxDelayMs: number
  backoffFactor: number
  jitterRatio: number
  respectRetryAfter: boolean
  retryNonIdempotent: boolean
}

export interface RateLimitOptions {
  /** Minimum delay in ms between consecutive requests to the same origin (default: 0). */
  minDelayMs?: number
  /** Maximum delay in ms to honor from Retry-After / X-RateLimit-Reset / Crawl-delay (default: 15000). */
  maxWaitMs?: number
  /** Respect X-RateLimit-Remaining/Reset and RateLimit-Reset headers on responses (default: true). */
  respectRateLimitHeaders?: boolean
}

export interface ResolvedRateLimitPolicy {
  minDelayMs: number
  maxWaitMs: number
  respectRateLimitHeaders: boolean
}

export interface TrackedOriginRateLimit {
  origin: string
  nextAllowedAt: number
  remainingWaitMs: number
  lastReason?: string
}

export interface RateLimitStats {
  totalRetries: number
  totalRetryDelayMs: number
  totalRateLimitWaits: number
  totalRateLimitWaitMs: number
  robotsBlocked: number
  robotsCacheSize: number
  trackedOrigins: TrackedOriginRateLimit[]
}

export class RobotsDisallowedError extends Error {
  readonly url: string
  readonly decision: RobotsDecision

  constructor(url: string, decision: RobotsDecision) {
    const agent = decision.matchedAgent ?? '*'
    const pattern = decision.matchedRule?.pattern ?? '/'
    super(`Blocked by robots.txt (${agent}: Disallow ${pattern}): ${url}`)
    this.name = 'RobotsDisallowedError'
    this.url = url
    this.decision = decision
  }
}

const DEFAULT_ROBOTS_POLICY: ResolvedRobotsPolicy = {
  enabled: false,
  cacheTtlMs: 300_000,
  maxCrawlDelayMs: 10_000,
  failOpen: true,
  fetchTimeoutMs: 5_000,
}

const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  enabled: true,
  maxRetries: 3,
  retryStatuses: [429, 503],
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  backoffFactor: 2,
  jitterRatio: 0.2,
  respectRetryAfter: true,
  retryNonIdempotent: false,
}

const DEFAULT_RATE_LIMIT_POLICY: ResolvedRateLimitPolicy = {
  minDelayMs: 0,
  maxWaitMs: 15_000,
  respectRateLimitHeaders: true,
}

const IDEMPOTENT_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])
const MAX_ROBOTS_BYTES = 512 * 1024 // RFC 9309 §2.5

export function resolveRobotsPolicy(
  opts?: RobotsPolicyOptions,
  base: ResolvedRobotsPolicy = DEFAULT_ROBOTS_POLICY,
): ResolvedRobotsPolicy {
  if (!opts) return { ...base }
  return {
    enabled: opts.enabled ?? base.enabled,
    userAgent: opts.userAgent !== undefined ? opts.userAgent : base.userAgent,
    cacheTtlMs: clampNonNegative(opts.cacheTtlMs, base.cacheTtlMs),
    maxCrawlDelayMs: clampNonNegative(opts.maxCrawlDelayMs, base.maxCrawlDelayMs),
    failOpen: opts.failOpen ?? base.failOpen,
    fetchTimeoutMs: clampPositive(opts.fetchTimeoutMs, base.fetchTimeoutMs),
  }
}

export function resolveRetryPolicy(
  opts?: RetryPolicyOptions,
  base: ResolvedRetryPolicy = DEFAULT_RETRY_POLICY,
): ResolvedRetryPolicy {
  if (!opts) return { ...base, retryStatuses: [...base.retryStatuses] }
  const statuses =
    Array.isArray(opts.retryStatuses) && opts.retryStatuses.length > 0
      ? Array.from(new Set(opts.retryStatuses.filter((s) => Number.isInteger(s) && s >= 100 && s <= 599)))
      : [...base.retryStatuses]
  const jitter =
    typeof opts.jitterRatio === 'number' && Number.isFinite(opts.jitterRatio)
      ? Math.max(0, Math.min(1, opts.jitterRatio))
      : base.jitterRatio
  const factor =
    typeof opts.backoffFactor === 'number' && Number.isFinite(opts.backoffFactor) && opts.backoffFactor >= 1
      ? opts.backoffFactor
      : base.backoffFactor
  return {
    enabled: opts.enabled ?? base.enabled,
    maxRetries: Math.floor(clampNonNegative(opts.maxRetries, base.maxRetries)),
    retryStatuses: statuses.length > 0 ? statuses : [...base.retryStatuses],
    baseDelayMs: clampNonNegative(opts.baseDelayMs, base.baseDelayMs),
    maxDelayMs: clampNonNegative(opts.maxDelayMs, base.maxDelayMs),
    backoffFactor: factor,
    jitterRatio: jitter,
    respectRetryAfter: opts.respectRetryAfter ?? base.respectRetryAfter,
    retryNonIdempotent: opts.retryNonIdempotent ?? base.retryNonIdempotent,
  }
}

export function resolveRateLimitPolicy(
  opts?: RateLimitOptions,
  base: ResolvedRateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
): ResolvedRateLimitPolicy {
  if (!opts) return { ...base }
  return {
    minDelayMs: clampNonNegative(opts.minDelayMs, base.minDelayMs),
    maxWaitMs: clampNonNegative(opts.maxWaitMs, base.maxWaitMs),
    respectRateLimitHeaders: opts.respectRateLimitHeaders ?? base.respectRateLimitHeaders,
  }
}

function clampNonNegative(val: number | undefined, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return fallback
  return val
}

function clampPositive(val: number | undefined, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return fallback
  return val
}

/**
 * Parse a `robots.txt` document following RFC 9309 plus the `Crawl-delay` extension.
 */
export function parseRobotsTxt(content: string): RobotsDocument {
  const cleaned = content.replace(/^\uFEFF/, '')
  const lines = cleaned.split(/\r\n|\n|\r/)

  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []

  let currentGroup: RobotsGroup | null = null
  let sawNonAgentDirective = false

  for (const rawLine of lines) {
    const hashIdx = rawLine.indexOf('#')
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim()
    if (!line) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue

    const field = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()

    if (field === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }

    if (field === 'user-agent') {
      if (!value) continue
      if (!currentGroup || sawNonAgentDirective) {
        currentGroup = { userAgents: [], rules: [] }
        groups.push(currentGroup)
        sawNonAgentDirective = false
      }
      currentGroup.userAgents.push(value.toLowerCase())
      continue
    }

    if (!currentGroup) continue
    sawNonAgentDirective = true

    if (field === 'disallow') {
      // RFC 9309: empty Disallow value means no restriction
      if (!value) continue
      currentGroup.rules.push({ directive: 'disallow', pattern: value })
    } else if (field === 'allow') {
      if (!value) continue
      currentGroup.rules.push({ directive: 'allow', pattern: value })
    } else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value)
      if (Number.isFinite(seconds) && seconds >= 0) {
        currentGroup.crawlDelayMs = Math.round(seconds * 1000)
      }
    }
  }

  return { groups, sitemaps }
}

function escapeRegexLiteral(str: string): string {
  return str.replace(/[.+?^()|[\]{}\\]/g, '\\$&')
}

function robotsPatternMatches(pattern: string, pathWithQuery: string): boolean {
  if (!pattern) return false
  const hasEndAnchor = pattern.endsWith('$')
  const core = hasEndAnchor ? pattern.slice(0, -1) : pattern
  const parts = core.split('*').map(escapeRegexLiteral)
  const regexStr = `^${parts.join('.*')}${hasEndAnchor ? '$' : ''}`
  try {
    return new RegExp(regexStr).test(pathWithQuery)
  } catch {
    return pathWithQuery.startsWith(pattern)
  }
}

function normalizeAgentToken(agent: string): string {
  const lower = agent.trim().toLowerCase()
  const slashIdx = lower.indexOf('/')
  return slashIdx > 0 ? lower.slice(0, slashIdx) : lower
}

/**
 * Evaluate a parsed `RobotsDocument` against a URL path+query and User-Agent string.
 * Implements RFC 9309 longest-match-wins precedence with `Allow` breaking ties over `Disallow`.
 */
export function evaluateRobots(
  doc: RobotsDocument,
  pathWithQuery: string,
  userAgent: string,
  maxCrawlDelayMs = DEFAULT_ROBOTS_POLICY.maxCrawlDelayMs,
): RobotsDecision {
  const uaLower = userAgent.toLowerCase()

  let bestSpecificLen = -1
  let bestSpecificToken: string | undefined
  const matchedSpecificGroups: RobotsGroup[] = []
  const wildcardGroups: RobotsGroup[] = []

  for (const group of doc.groups) {
    let groupBestLen = -1
    let groupBestToken: string | undefined
    let hasWildcard = false

    for (const rawAgent of group.userAgents) {
      if (rawAgent === '*') {
        hasWildcard = true
        continue
      }
      const token = normalizeAgentToken(rawAgent)
      if (!token) continue
      if (uaLower.includes(token)) {
        if (token.length > groupBestLen) {
          groupBestLen = token.length
          groupBestToken = rawAgent
        }
      }
    }

    if (groupBestLen > 0) {
      if (groupBestLen > bestSpecificLen) {
        bestSpecificLen = groupBestLen
        bestSpecificToken = groupBestToken
        matchedSpecificGroups.length = 0
        matchedSpecificGroups.push(group)
      } else if (groupBestLen === bestSpecificLen) {
        matchedSpecificGroups.push(group)
      }
    } else if (hasWildcard) {
      wildcardGroups.push(group)
    }
  }

  const activeGroups = matchedSpecificGroups.length > 0 ? matchedSpecificGroups : wildcardGroups
  const matchedAgent = matchedSpecificGroups.length > 0 ? bestSpecificToken : wildcardGroups.length > 0 ? '*' : undefined

  if (activeGroups.length === 0) {
    return { allowed: true, source: 'robots.txt' }
  }

  const normalizedPath = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  let bestRule: RobotsRule | undefined
  let crawlDelayMs: number | undefined

  for (const group of activeGroups) {
    if (group.crawlDelayMs !== undefined) {
      const capped = Math.min(group.crawlDelayMs, maxCrawlDelayMs)
      crawlDelayMs = crawlDelayMs === undefined ? capped : Math.max(crawlDelayMs, capped)
    }
    for (const rule of group.rules) {
      if (!robotsPatternMatches(rule.pattern, normalizedPath)) continue
      if (!bestRule) {
        bestRule = rule
      } else if (rule.pattern.length > bestRule.pattern.length) {
        bestRule = rule
      } else if (rule.pattern.length === bestRule.pattern.length && rule.directive === 'allow') {
        // RFC 9309 §2.2.2: on equal pattern length, Allow wins over Disallow
        bestRule = rule
      }
    }
  }

  return {
    allowed: bestRule ? bestRule.directive === 'allow' : true,
    matchedAgent,
    matchedRule: bestRule,
    ...(crawlDelayMs !== undefined ? { crawlDelayMs } : {}),
    source: 'robots.txt',
  }
}

/**
 * Parse an HTTP `Retry-After` header value (either delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  if (!trimmed) return undefined

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000)
    }
    return undefined
  }

  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs)
  }
  return undefined
}

/**
 * Extract a rate-limit cooldown duration (in ms) from standard HTTP headers:
 * `Retry-After`, `X-RateLimit-Remaining` + `X-RateLimit-Reset`, or `RateLimit-Remaining` + `RateLimit-Reset`.
 */
export function extractRateLimitDelayMs(
  headers: Headers,
  nowMs = Date.now(),
): { delayMs: number; reason: string } | undefined {
  const retryAfter = parseRetryAfterMs(headers.get('retry-after'), nowMs)
  if (retryAfter !== undefined) {
    return { delayMs: retryAfter, reason: 'Retry-After' }
  }

  const remainingRaw = headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining')
  if (remainingRaw !== null) {
    const remaining = Number.parseFloat(remainingRaw.trim())
    if (Number.isFinite(remaining) && remaining <= 0) {
      const resetRaw = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset')
      if (resetRaw !== null) {
        const resetNum = Number.parseFloat(resetRaw.trim())
        if (Number.isFinite(resetNum) && resetNum >= 0) {
          // Heuristic: values > 1e9 are Unix epoch seconds; smaller values are delta-seconds (IETF draft).
          const delayMs =
            resetNum > 1_000_000_000
              ? Math.max(0, Math.round(resetNum * 1000 - nowMs))
              : Math.max(0, Math.round(resetNum * 1000))
          return { delayMs, reason: 'RateLimit-Reset' }
        }
      }
    }
  }

  return undefined
}

/**
 * Compute retry delay in ms using exponential backoff with bounded jitter,
 * honoring `Retry-After` when configured.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: ResolvedRetryPolicy,
  retryAfterMs?: number,
  randomFn: () => number = Math.random,
): number {
  if (policy.respectRetryAfter && retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    return Math.round(Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs)))
  }

  const safeAttempt = Math.max(0, Math.floor(attempt))
  const expDelay = policy.baseDelayMs * Math.pow(policy.backoffFactor, safeAttempt)
  const clamped = Math.min(policy.maxDelayMs, expDelay)

  if (policy.jitterRatio <= 0 || clamped <= 0) {
    return Math.round(clamped)
  }

  const r = Math.max(0, Math.min(1, randomFn()))
  const factor = 1 + (r * 2 - 1) * policy.jitterRatio
  return Math.round(Math.max(0, Math.min(policy.maxDelayMs, clamped * factor)))
}

export function isRetryableMethod(method: string | undefined, policy: ResolvedRetryPolicy): boolean {
  const upper = (method ?? 'GET').toUpperCase()
  if (IDEMPOTENT_RETRY_METHODS.has(upper)) return true
  return policy.retryNonIdempotent
}

export function isRetryableStatus(status: number, policy: ResolvedRetryPolicy): boolean {
  return policy.retryStatuses.includes(status)
}

interface RobotsCacheEntry {
  doc: RobotsDocument | null
  source: 'robots.txt' | 'allow-all' | 'error-fallback'
  expiresAt: number
}

interface OriginRateState {
  nextAllowedAt: number
  lastReason?: string
}

export interface RobotsRetryHooks {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  fetchFn?: typeof fetch
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Combined controller for robots.txt caching/evaluation, per-origin rate limiting,
 * and HTTP 429/503 exponential-backoff retry accounting.
 */
export class RobotsRetryController {
  private robotsPolicy: ResolvedRobotsPolicy
  private retryPolicy: ResolvedRetryPolicy
  private rateLimitPolicy: ResolvedRateLimitPolicy
  private robotsCache = new Map<string, RobotsCacheEntry>()
  private inFlightRobots = new Map<string, Promise<RobotsCacheEntry>>()
  private originRates = new Map<string, OriginRateState>()

  private totalRetries = 0
  private totalRetryDelayMs = 0
  private totalRateLimitWaits = 0
  private totalRateLimitWaitMs = 0
  private robotsBlocked = 0

  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly random: () => number
  private readonly fetchFn: typeof fetch

  constructor(
    opts: {
      robots?: RobotsPolicyOptions
      retry?: RetryPolicyOptions
      rateLimit?: RateLimitOptions
      hooks?: RobotsRetryHooks
    } = {},
  ) {
    this.robotsPolicy = resolveRobotsPolicy(opts.robots)
    this.retryPolicy = resolveRetryPolicy(opts.retry)
    this.rateLimitPolicy = resolveRateLimitPolicy(opts.rateLimit)
    this.sleep = opts.hooks?.sleep ?? defaultSleep
    this.now = opts.hooks?.now ?? (() => Date.now())
    this.random = opts.hooks?.random ?? Math.random
    this.fetchFn = opts.hooks?.fetchFn ?? fetch
  }

  getRobotsPolicy(): ResolvedRobotsPolicy {
    return { ...this.robotsPolicy }
  }

  setRobotsPolicy(opts: RobotsPolicyOptions): ResolvedRobotsPolicy {
    this.robotsPolicy = resolveRobotsPolicy(opts, this.robotsPolicy)
    return this.getRobotsPolicy()
  }

  getRetryPolicy(): ResolvedRetryPolicy {
    return { ...this.retryPolicy, retryStatuses: [...this.retryPolicy.retryStatuses] }
  }

  setRetryPolicy(opts: RetryPolicyOptions): ResolvedRetryPolicy {
    this.retryPolicy = resolveRetryPolicy(opts, this.retryPolicy)
    return this.getRetryPolicy()
  }

  getRateLimitPolicy(): ResolvedRateLimitPolicy {
    return { ...this.rateLimitPolicy }
  }

  setRateLimitPolicy(opts: RateLimitOptions): ResolvedRateLimitPolicy {
    this.rateLimitPolicy = resolveRateLimitPolicy(opts, this.rateLimitPolicy)
    return this.getRateLimitPolicy()
  }

  /** Pre-populate or override cached robots.txt for an origin (useful for tests/offline). */
  setCachedRobots(origin: string, content: string, ttlMs?: number): void {
    const normalized = new URL(origin).origin
    this.robotsCache.set(normalized, {
      doc: parseRobotsTxt(content),
      source: 'robots.txt',
      expiresAt: this.now() + (ttlMs ?? this.robotsPolicy.cacheTtlMs),
    })
  }

  clearRobotsCache(origin?: string): void {
    if (origin) {
      try {
        this.robotsCache.delete(new URL(origin).origin)
      } catch {
        this.robotsCache.delete(origin)
      }
    } else {
      this.robotsCache.clear()
    }
  }

  clearRateLimits(origin?: string): void {
    if (origin) {
      try {
        this.originRates.delete(new URL(origin).origin)
      } catch {
        this.originRates.delete(origin)
      }
    } else {
      this.originRates.clear()
    }
  }

  getStats(): RateLimitStats {
    const currentNow = this.now()
    const trackedOrigins: TrackedOriginRateLimit[] = []
    for (const [origin, state] of this.originRates) {
      trackedOrigins.push({
        origin,
        nextAllowedAt: state.nextAllowedAt,
        remainingWaitMs: Math.max(0, state.nextAllowedAt - currentNow),
        ...(state.lastReason ? { lastReason: state.lastReason } : {}),
      })
    }
    return {
      totalRetries: this.totalRetries,
      totalRetryDelayMs: this.totalRetryDelayMs,
      totalRateLimitWaits: this.totalRateLimitWaits,
      totalRateLimitWaitMs: this.totalRateLimitWaitMs,
      robotsBlocked: this.robotsBlocked,
      robotsCacheSize: this.robotsCache.size,
      trackedOrigins,
    }
  }

  recordRobotsBlocked(): void {
    this.robotsBlocked += 1
  }

  recordRetry(delayMs: number): void {
    this.totalRetries += 1
    this.totalRetryDelayMs += Math.max(0, delayMs)
  }

  /**
   * Check whether `targetUrl` is allowed by the origin's `/robots.txt`.
   * Always fetches and caches `/robots.txt` when `forceCheck` is true or `robotsPolicy.enabled` is true.
   */
  async checkRobots(targetUrl: string, userAgent: string, forceCheck = false): Promise<RobotsDecision> {
    if (!forceCheck && !this.robotsPolicy.enabled) {
      return { allowed: true, source: 'bypass' }
    }

    let parsed: URL
    try {
      parsed = new URL(targetUrl)
    } catch {
      return { allowed: true, source: 'bypass' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: true, source: 'bypass' }
    }

    // Never block /robots.txt itself
    if (parsed.pathname === '/robots.txt') {
      return { allowed: true, source: 'bypass' }
    }

    const effectiveUa = this.robotsPolicy.userAgent || userAgent
    const entry = await this.getOrFetchRobots(parsed.origin, effectiveUa)
    if (!entry.doc) {
      if (entry.source === 'error-fallback' && !this.robotsPolicy.failOpen) {
        return {
          allowed: false,
          matchedAgent: '*',
          matchedRule: { directive: 'disallow', pattern: '/' },
          source: 'error-fallback',
        }
      }
      return { allowed: true, source: entry.source }
    }

    return evaluateRobots(
      entry.doc,
      `${parsed.pathname}${parsed.search}`,
      effectiveUa,
      this.robotsPolicy.maxCrawlDelayMs,
    )
  }

  private async getOrFetchRobots(origin: string, userAgent: string): Promise<RobotsCacheEntry> {
    const currentNow = this.now()
    const cached = this.robotsCache.get(origin)
    if (cached && cached.expiresAt > currentNow) {
      return cached
    }

    const existing = this.inFlightRobots.get(origin)
    if (existing) return existing

    const promise = this.fetchRobotsEntry(origin, userAgent).finally(() => {
      this.inFlightRobots.delete(origin)
    })
    this.inFlightRobots.set(origin, promise)
    return promise
  }

  private async fetchRobotsEntry(origin: string, userAgent: string): Promise<RobotsCacheEntry> {
    const robotsUrl = `${origin}/robots.txt`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.robotsPolicy.fetchTimeoutMs)

    try {
      let currentUrl = robotsUrl
      let res: Response | null = null
      for (let hop = 0; hop <= 5; hop++) {
        res = await this.fetchFn(currentUrl, {
          method: 'GET',
          headers: {
            'user-agent': userAgent,
            accept: 'text/plain,*/*;q=0.5',
          },
          redirect: 'manual',
          signal: controller.signal,
        })
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location')
          if (loc && hop < 5) {
            try {
              await res.body?.cancel()
            } catch {
              // ignore
            }
            currentUrl = new URL(loc, currentUrl).toString()
            continue
          }
        }
        break
      }

      if (!res) {
        return this.cacheRobotsEntry(origin, {
          doc: null,
          source: 'error-fallback',
          expiresAt: this.now() + Math.min(this.robotsPolicy.cacheTtlMs, 30_000),
        })
      }

      // RFC 9309 §2.3.1: 4xx means unavailable -> allow all
      if (res.status >= 400 && res.status < 500) {
        try {
          await res.body?.cancel()
        } catch {
          // ignore
        }
        return this.cacheRobotsEntry(origin, {
          doc: null,
          source: 'allow-all',
          expiresAt: this.now() + this.robotsPolicy.cacheTtlMs,
        })
      }

      // 5xx -> temporary error fallback
      if (res.status >= 500 || !res.ok) {
        try {
          await res.body?.cancel()
        } catch {
          // ignore
        }
        return this.cacheRobotsEntry(origin, {
          doc: null,
          source: 'error-fallback',
          expiresAt: this.now() + Math.min(this.robotsPolicy.cacheTtlMs, 30_000),
        })
      }

      const rawText = await res.text()
      const bounded = rawText.length > MAX_ROBOTS_BYTES ? rawText.slice(0, MAX_ROBOTS_BYTES) : rawText
      return this.cacheRobotsEntry(origin, {
        doc: parseRobotsTxt(bounded),
        source: 'robots.txt',
        expiresAt: this.now() + this.robotsPolicy.cacheTtlMs,
      })
    } catch {
      return this.cacheRobotsEntry(origin, {
        doc: null,
        source: 'error-fallback',
        expiresAt: this.now() + Math.min(this.robotsPolicy.cacheTtlMs, 30_000),
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private cacheRobotsEntry(origin: string, entry: RobotsCacheEntry): RobotsCacheEntry {
    this.robotsCache.set(origin, entry)
    return entry
  }

  /**
   * Wait if the origin is currently under a rate-limit or Crawl-delay cooldown,
   * then reserve the next slot for this origin.
   */
  async acquireOriginSlot(origin: string, crawlDelayMs?: number): Promise<number> {
    const currentNow = this.now()
    const state = this.originRates.get(origin)
    let waitedMs = 0

    if (state && state.nextAllowedAt > currentNow) {
      waitedMs = Math.min(this.rateLimitPolicy.maxWaitMs, state.nextAllowedAt - currentNow)
      if (waitedMs > 0) {
        this.totalRateLimitWaits += 1
        this.totalRateLimitWaitMs += waitedMs
        await this.sleep(waitedMs)
      }
    }

    const afterNow = this.now()
    const spacingMs = Math.min(
      this.rateLimitPolicy.maxWaitMs,
      Math.max(this.rateLimitPolicy.minDelayMs, crawlDelayMs ?? 0),
    )

    if (spacingMs > 0) {
      this.originRates.set(origin, {
        nextAllowedAt: afterNow + spacingMs,
        lastReason: crawlDelayMs && crawlDelayMs >= this.rateLimitPolicy.minDelayMs ? 'Crawl-delay' : 'minDelayMs',
      })
    } else if (state && state.nextAllowedAt <= afterNow) {
      this.originRates.delete(origin)
    }

    return waitedMs
  }

  /**
   * Inspect response headers for `Retry-After` or `X-RateLimit-Remaining: 0` + `Reset`
   * and update the per-origin cooldown window.
   */
  recordResponseHeaders(origin: string, headers: Headers): { delayMs: number; reason: string } | undefined {
    if (!this.rateLimitPolicy.respectRateLimitHeaders) return undefined
    const currentNow = this.now()
    const extracted = extractRateLimitDelayMs(headers, currentNow)
    if (!extracted) return undefined

    const clamped = Math.min(this.rateLimitPolicy.maxWaitMs, Math.max(0, extracted.delayMs))
    if (clamped > 0) {
      const existing = this.originRates.get(origin)
      const target = currentNow + clamped
      if (!existing || target > existing.nextAllowedAt) {
        this.originRates.set(origin, { nextAllowedAt: target, lastReason: extracted.reason })
      }
    }
    return { delayMs: clamped, reason: extracted.reason }
  }
}
