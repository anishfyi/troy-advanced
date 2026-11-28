// Sliding-window rate limiter for the Agent Socket HTTP server.
//
// Provides two independent protections:
//   1. Request rate limiting per client/session key (`maxRequests` per `windowMs`)
//   2. Auth-failure rate limiting per remote address (`maxAuthFailures` per `authWindowMs`)
//      to mitigate brute-force token guessing even on loopback or forwarded ports.
//
// Memory is strictly bounded via `maxBuckets` (LRU-style oldest-bucket eviction)
// so fuzzing random session IDs or keys cannot exhaust memory.

export interface RateLimitConfig {
  /** Enable or disable rate limiting (default: true). */
  enabled?: boolean
  /** Maximum requests allowed per key within `windowMs` (default: 600). */
  maxRequests?: number
  /** Sliding window duration in milliseconds for normal requests (default: 10_000). */
  windowMs?: number
  /** Maximum failed auth attempts per client within `authWindowMs` (default: 30). */
  maxAuthFailures?: number
  /** Sliding window duration in milliseconds for auth failures (default: 60_000). */
  authWindowMs?: number
  /** Hard cap on tracked bucket keys to prevent memory exhaustion (default: 1024). */
  maxBuckets?: number
  /** Injectable monotonic/wall clock for deterministic tests. */
  now?: () => number
}

export interface ResolvedRateLimitConfig {
  enabled: boolean
  maxRequests: number
  windowMs: number
  maxAuthFailures: number
  authWindowMs: number
  maxBuckets: number
}

export type RateLimitBlockReason = 'rate_limit_exceeded' | 'auth_rate_limit_exceeded'

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  resetAtMs: number
  retryAfterSeconds: number
  reason?: RateLimitBlockReason
}

export interface AgentSocketRateLimitStats {
  enabled: boolean
  maxRequests: number
  windowMs: number
  maxAuthFailures: number
  authWindowMs: number
  maxBuckets: number
  activeBuckets: number
  activeAuthBuckets: number
  totalAllowed: number
  totalBlocked: number
  authBlocked: number
}

export const DEFAULT_RATE_LIMIT_CONFIG: ResolvedRateLimitConfig = {
  enabled: true,
  maxRequests: 600,
  windowMs: 10_000,
  maxAuthFailures: 30,
  authWindowMs: 60_000,
  maxBuckets: 1024,
}

function clampPositiveInt(value: number | undefined, fallback: number, min = 1, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

interface SlidingBucket {
  timestamps: number[]
  lastSeen: number
}

export class AgentSocketRateLimiter {
  private readonly cfg: ResolvedRateLimitConfig
  private readonly nowFn: () => number
  private readonly buckets = new Map<string, SlidingBucket>()
  private readonly authBuckets = new Map<string, SlidingBucket>()

  private totalAllowed = 0
  private totalBlocked = 0
  private authBlocked = 0

  constructor(config: RateLimitConfig = {}) {
    this.cfg = {
      enabled: config.enabled ?? DEFAULT_RATE_LIMIT_CONFIG.enabled,
      maxRequests: clampPositiveInt(config.maxRequests, DEFAULT_RATE_LIMIT_CONFIG.maxRequests, 1, 1_000_000),
      windowMs: clampPositiveInt(config.windowMs, DEFAULT_RATE_LIMIT_CONFIG.windowMs, 10, 3_600_000),
      maxAuthFailures: clampPositiveInt(config.maxAuthFailures, DEFAULT_RATE_LIMIT_CONFIG.maxAuthFailures, 1, 100_000),
      authWindowMs: clampPositiveInt(config.authWindowMs, DEFAULT_RATE_LIMIT_CONFIG.authWindowMs, 10, 3_600_000),
      maxBuckets: clampPositiveInt(config.maxBuckets, DEFAULT_RATE_LIMIT_CONFIG.maxBuckets, 1, 100_000),
    }
    this.nowFn = config.now ?? (() => Date.now())
  }

  get config(): ResolvedRateLimitConfig {
    return { ...this.cfg }
  }

  /**
   * Check and consume 1 request token for `key` in the sliding window.
   */
  consume(key: string): RateLimitDecision {
    const now = this.nowFn()
    if (!this.cfg.enabled) {
      this.totalAllowed++
      return {
        allowed: true,
        limit: this.cfg.maxRequests,
        remaining: this.cfg.maxRequests,
        resetAtMs: now + this.cfg.windowMs,
        retryAfterSeconds: 0,
      }
    }

    const bucket = this.getOrCreateBucket(this.buckets, key, now)
    this.pruneTimestamps(bucket, now, this.cfg.windowMs)

    if (bucket.timestamps.length >= this.cfg.maxRequests) {
      const oldest = bucket.timestamps[0] ?? now
      const resetAtMs = oldest + this.cfg.windowMs
      const retryAfterMs = Math.max(1, resetAtMs - now)
      this.totalBlocked++
      return {
        allowed: false,
        limit: this.cfg.maxRequests,
        remaining: 0,
        resetAtMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        reason: 'rate_limit_exceeded',
      }
    }

    bucket.timestamps.push(now)
    bucket.lastSeen = now
    this.totalAllowed++

    const oldest = bucket.timestamps[0] ?? now
    return {
      allowed: true,
      limit: this.cfg.maxRequests,
      remaining: Math.max(0, this.cfg.maxRequests - bucket.timestamps.length),
      resetAtMs: oldest + this.cfg.windowMs,
      retryAfterSeconds: 0,
    }
  }

  /**
   * Check whether `clientKey` is currently locked out due to excessive failed auth attempts.
   */
  checkAuthAllowed(clientKey: string): RateLimitDecision {
    const now = this.nowFn()
    if (!this.cfg.enabled) {
      return {
        allowed: true,
        limit: this.cfg.maxAuthFailures,
        remaining: this.cfg.maxAuthFailures,
        resetAtMs: now + this.cfg.authWindowMs,
        retryAfterSeconds: 0,
      }
    }

    const bucket = this.authBuckets.get(clientKey)
    if (!bucket) {
      return {
        allowed: true,
        limit: this.cfg.maxAuthFailures,
        remaining: this.cfg.maxAuthFailures,
        resetAtMs: now + this.cfg.authWindowMs,
        retryAfterSeconds: 0,
      }
    }

    this.pruneTimestamps(bucket, now, this.cfg.authWindowMs)
    if (bucket.timestamps.length === 0) {
      this.authBuckets.delete(clientKey)
      return {
        allowed: true,
        limit: this.cfg.maxAuthFailures,
        remaining: this.cfg.maxAuthFailures,
        resetAtMs: now + this.cfg.authWindowMs,
        retryAfterSeconds: 0,
      }
    }

    if (bucket.timestamps.length >= this.cfg.maxAuthFailures) {
      const oldest = bucket.timestamps[0] ?? now
      const resetAtMs = oldest + this.cfg.authWindowMs
      const retryAfterMs = Math.max(1, resetAtMs - now)
      this.authBlocked++
      this.totalBlocked++
      return {
        allowed: false,
        limit: this.cfg.maxAuthFailures,
        remaining: 0,
        resetAtMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        reason: 'auth_rate_limit_exceeded',
      }
    }

    const oldest = bucket.timestamps[0] ?? now
    return {
      allowed: true,
      limit: this.cfg.maxAuthFailures,
      remaining: Math.max(0, this.cfg.maxAuthFailures - bucket.timestamps.length),
      resetAtMs: oldest + this.cfg.authWindowMs,
      retryAfterSeconds: 0,
    }
  }

  /**
   * Record a failed authentication attempt for `clientKey`.
   */
  recordAuthFailure(clientKey: string): RateLimitDecision {
    const now = this.nowFn()
    if (!this.cfg.enabled) {
      return {
        allowed: true,
        limit: this.cfg.maxAuthFailures,
        remaining: this.cfg.maxAuthFailures,
        resetAtMs: now + this.cfg.authWindowMs,
        retryAfterSeconds: 0,
      }
    }

    const bucket = this.getOrCreateBucket(this.authBuckets, clientKey, now)
    this.pruneTimestamps(bucket, now, this.cfg.authWindowMs)
    bucket.timestamps.push(now)
    bucket.lastSeen = now

    const oldest = bucket.timestamps[0] ?? now
    const remaining = Math.max(0, this.cfg.maxAuthFailures - bucket.timestamps.length)
    return {
      allowed: bucket.timestamps.length < this.cfg.maxAuthFailures,
      limit: this.cfg.maxAuthFailures,
      remaining,
      resetAtMs: oldest + this.cfg.authWindowMs,
      retryAfterSeconds: remaining === 0 ? Math.max(1, Math.ceil((oldest + this.cfg.authWindowMs - now) / 1000)) : 0,
      ...(remaining === 0 ? { reason: 'auth_rate_limit_exceeded' as const } : {}),
    }
  }

  getStats(): AgentSocketRateLimitStats {
    return {
      enabled: this.cfg.enabled,
      maxRequests: this.cfg.maxRequests,
      windowMs: this.cfg.windowMs,
      maxAuthFailures: this.cfg.maxAuthFailures,
      authWindowMs: this.cfg.authWindowMs,
      maxBuckets: this.cfg.maxBuckets,
      activeBuckets: this.buckets.size,
      activeAuthBuckets: this.authBuckets.size,
      totalAllowed: this.totalAllowed,
      totalBlocked: this.totalBlocked,
      authBlocked: this.authBlocked,
    }
  }

  reset(): void {
    this.buckets.clear()
    this.authBuckets.clear()
    this.totalAllowed = 0
    this.totalBlocked = 0
    this.authBlocked = 0
  }

  private pruneTimestamps(bucket: SlidingBucket, now: number, windowMs: number): void {
    const cutoff = now - windowMs
    let drop = 0
    while (drop < bucket.timestamps.length && bucket.timestamps[drop]! <= cutoff) {
      drop++
    }
    if (drop > 0) {
      bucket.timestamps.splice(0, drop)
    }
  }

  private getOrCreateBucket(map: Map<string, SlidingBucket>, key: string, now: number): SlidingBucket {
    const existing = map.get(key)
    if (existing) {
      // Refresh insertion order for LRU eviction.
      map.delete(key)
      map.set(key, existing)
      existing.lastSeen = now
      return existing
    }

    if (map.size >= this.cfg.maxBuckets) {
      const oldestKey = map.keys().next().value
      if (oldestKey !== undefined) {
        map.delete(oldestKey)
      }
    }

    const created: SlidingBucket = { timestamps: [], lastSeen: now }
    map.set(key, created)
    return created
  }
}

/**
 * Format standard HTTP rate-limit headers from a decision.
 */
export function buildRateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-reset': String(Math.ceil(decision.resetAtMs / 1000)),
  }
  if (!decision.allowed && decision.retryAfterSeconds > 0) {
    headers['retry-after'] = String(decision.retryAfterSeconds)
  }
  return headers
}
