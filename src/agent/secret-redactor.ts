// Sensitive output redaction filter (`--redact-secrets`).
// Automatically masks JWTs, AWS access & secret keys (`AKIA...`), Luhn-validated credit card
// numbers, PEM private keys, provider API keys, and Bearer tokens in `page_text`, `ascii`,
// `markdown`, and `extract` outputs so secrets on web pages do not leak into LLM context windows.

import type {
  SecretRedactionCategory,
  SecretRedactionCustomPattern,
  SecretRedactionEvent,
  SecretRedactionMetadata,
  SecretRedactionMode,
  SecretRedactionOptions,
  SecretRedactionResult,
  SecretRedactionStats,
} from '../types.js'

const MAX_RECENT_REDACTIONS = 50
const MAX_SOURCE_LEN = 240

export const DEFAULT_SECRET_CATEGORIES: readonly SecretRedactionCategory[] = [
  'private-key',
  'jwt',
  'aws-access-key',
  'aws-secret-key',
  'provider-api-key',
  'bearer-token',
  'credit-card',
]

export const ALL_SECRET_CATEGORIES: readonly SecretRedactionCategory[] = [
  ...DEFAULT_SECRET_CATEGORIES,
  'custom',
]

const VALID_CATEGORY_SET = new Set<string>(ALL_SECRET_CATEGORIES)

// 1. Multi-line PEM private key blocks
const PEM_PRIVATE_KEY_RE =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{16,8192}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g

// 2. JSON Web Tokens (3 base64url segments, header & payload typically start with "eyJ" = '{"')
const JWT_CANDIDATE_RE =
  /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{4,512}\.eyJ[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{8,1024})(?![A-Za-z0-9_-])/g

// 3. AWS Access Key IDs (AKIA = long-term IAM, ASIA = STS temporary, ABIA/ACCA = AWS internal/context)
const AWS_ACCESS_KEY_RE = /(?<![A-Z0-9])((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})(?![A-Z0-9])/g

// 4. Contextual AWS Secret Access Key (40-char base64-like secret following an explicit key name)
const AWS_SECRET_KEY_RE =
  /(\b(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?access[_-]?key|secretAccessKey)\b[\s"'`]*[:=][\s"'`]*)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi

// 5. Well-known vendor / provider API keys
const PROVIDER_API_KEY_PATTERNS: readonly RegExp[] = [
  // GitHub classic & fine-grained PATs
  /(?<![A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{36,255})(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])(github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g,
  // OpenAI / Anthropic keys (sk-proj-..., sk-ant-api03-..., sk-...)
  /(?<![A-Za-z0-9_-])(sk-(?:proj-|ant-api\d{2}-|svcacct-|live-|test-)?[A-Za-z0-9_-]{20,255})(?![A-Za-z0-9_-])/g,
  // Stripe secret & restricted keys
  /(?<![A-Za-z0-9_])((?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,128})(?![A-Za-z0-9_])/g,
  // Slack bot/user/app/refresh tokens
  /(?<![A-Za-z0-9-])(xox[baprs]-[0-9]{8,16}-[0-9A-Za-z-]{10,128})(?![A-Za-z0-9-])/g,
  // Google API keys
  /(?<![A-Za-z0-9_-])(AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/g,
  // SendGrid API keys
  /(?<![A-Za-z0-9_.-])(SG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128})(?![A-Za-z0-9_.-])/g,
]

// 6. Authorization Bearer tokens (20+ chars, skips already-redacted placeholders)
const BEARER_TOKEN_RE =
  /(\bBearer\s+)(?!\[REDACTED:)([A-Za-z0-9._~+/-]{20,1024}={0,2})(?![A-Za-z0-9._~+/-])/g

// 7. Credit card candidate (13-19 digits, optionally grouped with single space or hyphen)
// Lookbehind/lookahead prevent matching inside longer numbers, hex strings, or decimal fractions.
const CREDIT_CARD_CANDIDATE_RE =
  /(?<![0-9A-Za-z._-])(\d(?:[ -]?\d){12,18})(?![0-9A-Za-z._-])/g

function sanitizeSource(raw: string | undefined): string {
  if (!raw) return 'unknown'
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'unknown'
  return cleaned.length > MAX_SOURCE_LEN ? `${cleaned.slice(0, MAX_SOURCE_LEN - 3)}...` : cleaned
}

export function parseSecretRedactionMode(raw: unknown): SecretRedactionMode | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'tag' || v === 'partial') return v
  return undefined
}

export function parseSecretRedactionBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase()
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  }
  return undefined
}

export function parseSecretRedactionCategories(raw: unknown): SecretRedactionCategory[] | undefined {
  if (Array.isArray(raw)) {
    const out: SecretRedactionCategory[] = []
    for (const item of raw) {
      if (typeof item === 'string' && VALID_CATEGORY_SET.has(item.trim().toLowerCase())) {
        const cat = item.trim().toLowerCase() as SecretRedactionCategory
        if (!out.includes(cat)) out.push(cat)
      }
    }
    return out.length > 0 ? out : undefined
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => VALID_CATEGORY_SET.has(s)) as SecretRedactionCategory[]
    const deduped = Array.from(new Set(parts))
    return deduped.length > 0 ? deduped : undefined
  }
  return undefined
}

export interface NormalizedSecretRedactionOptions {
  enabled: boolean
  mode: SecretRedactionMode
  categories: SecretRedactionCategory[]
  customPatterns: SecretRedactionCustomPattern[]
}

export function normalizeSecretRedactionOptions(
  input?: boolean | SecretRedactionOptions,
): NormalizedSecretRedactionOptions {
  if (typeof input === 'boolean') {
    return {
      enabled: input,
      mode: 'tag',
      categories: [...DEFAULT_SECRET_CATEGORIES],
      customPatterns: [],
    }
  }
  const customPatterns = Array.isArray(input?.customPatterns) ? input.customPatterns : []
  const baseCategories =
    Array.isArray(input?.categories) && input.categories.length > 0
      ? input.categories.filter((c): c is SecretRedactionCategory => VALID_CATEGORY_SET.has(c))
      : [...DEFAULT_SECRET_CATEGORIES]
  if (customPatterns.length > 0 && !baseCategories.includes('custom')) {
    baseCategories.push('custom')
  }
  return {
    enabled: Boolean(input?.enabled),
    mode: input?.mode === 'partial' ? 'partial' : 'tag',
    categories: baseCategories.length > 0 ? Array.from(new Set(baseCategories)) : [...DEFAULT_SECRET_CATEGORIES],
    customPatterns,
  }
}

/**
 * Standard Luhn checksum validation for payment card numbers.
 */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let shouldDouble = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48
    if (shouldDouble) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    shouldDouble = !shouldDouble
  }
  return sum % 10 === 0
}

/**
 * Checks whether a digit string is a plausible payment card number:
 * valid length (13..19), known major card network IIN prefix, non-trivial digits, and valid Luhn checksum.
 */
export function isPlausibleCreditCard(rawCandidate: string): boolean {
  // Reject mixed separators like "4111-1111 1111-1111"
  const hasSpace = rawCandidate.includes(' ')
  const hasHyphen = rawCandidate.includes('-')
  if (hasSpace && hasHyphen) return false

  const digits = rawCandidate.replace(/[ -]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  // Reject trivial all-identical digits (e.g. 0000000000000000)
  if (/^(\d)\1+$/.test(digits)) return false

  // Major card network IIN prefixes:
  // - Visa: 4 (13, 16, 19 digits)
  // - Mastercard: 51-55 or 2221-2720 (16 digits)
  // - Amex: 34 or 37 (15 digits)
  // - Discover: 6011, 622126-622925, 644-649, 65 (16-19 digits)
  // - Diners Club: 300-305, 36, 38-39 (14-16 digits)
  // - JCB: 3528-3589 (16-19 digits)
  // - UnionPay: 62 (16-19 digits)
  const d2 = Number(digits.slice(0, 2))
  const d3 = Number(digits.slice(0, 3))
  const d4 = Number(digits.slice(0, 4))
  const d6 = Number(digits.slice(0, 6))

  const isVisa = digits.startsWith('4') && (digits.length === 13 || digits.length === 16 || digits.length === 19)
  const isMastercard =
    digits.length === 16 && ((d2 >= 51 && d2 <= 55) || (d4 >= 2221 && d4 <= 2720))
  const isAmex = digits.length === 15 && (d2 === 34 || d2 === 37)
  const isDiscover =
    digits.length >= 16 &&
    digits.length <= 19 &&
    (d4 === 6011 || (d6 >= 622126 && d6 <= 622925) || (d3 >= 644 && d3 <= 649) || d2 === 65)
  const isDiners =
    digits.length >= 14 &&
    digits.length <= 16 &&
    ((d3 >= 300 && d3 <= 305) || d2 === 36 || d2 === 38 || d2 === 39)
  const isJcb = digits.length >= 16 && digits.length <= 19 && d4 >= 3528 && d4 <= 3589
  const isUnionPay = digits.length >= 16 && digits.length <= 19 && d2 === 62

  if (!(isVisa || isMastercard || isAmex || isDiscover || isDiners || isJcb || isUnionPay)) {
    return false
  }

  return isValidLuhn(digits)
}

function decodeBase64UrlToUtf8(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (normalized.length % 4)) % 4
    const padded = normalized + '='.repeat(padLen)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Validates that a 3-part dot-separated token is a structurally valid JWT
 * whose header and payload decode to JSON objects.
 */
export function isPlausibleJwt(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [headerSeg, payloadSeg, sigSeg] = parts
  if (!headerSeg || !payloadSeg || !sigSeg || sigSeg.length < 8) return false
  const headerStr = decodeBase64UrlToUtf8(headerSeg)
  const payloadStr = decodeBase64UrlToUtf8(payloadSeg)
  if (!headerStr || !payloadStr) return false
  if (!headerStr.trim().startsWith('{') || !payloadStr.trim().startsWith('{')) return false
  try {
    const header = JSON.parse(headerStr)
    const payload = JSON.parse(payloadStr)
    if (!header || typeof header !== 'object' || Array.isArray(header)) return false
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    return true
  } catch {
    return false
  }
}

function maskJwt(mode: SecretRedactionMode): string {
  return mode === 'partial' ? 'eyJ...[REDACTED:JWT]' : '[REDACTED:JWT]'
}

function maskAwsAccessKey(raw: string, mode: SecretRedactionMode): string {
  if (mode === 'partial') {
    return `${raw.slice(0, 4)}****[REDACTED:AWS_KEY]`
  }
  return '[REDACTED:AWS_KEY]'
}

function maskCreditCard(raw: string, mode: SecretRedactionMode): string {
  if (mode === 'partial') {
    const digits = raw.replace(/[ -]/g, '')
    const last4 = digits.slice(-4)
    return `****-****-****-${last4}`
  }
  return '[REDACTED:CREDIT_CARD]'
}

function compileCustomPattern(entry: SecretRedactionCustomPattern): RegExp | null {
  try {
    if (entry.pattern instanceof RegExp) {
      const flags = entry.pattern.flags.includes('g') ? entry.pattern.flags : `${entry.pattern.flags}g`
      return new RegExp(entry.pattern.source, flags)
    }
    if (typeof entry.pattern === 'string' && entry.pattern.trim()) {
      return new RegExp(entry.pattern, 'g')
    }
  } catch {
    return null
  }
  return null
}

/**
 * Pure function that scans and redacts sensitive secrets from text.
 */
export function redactSensitiveText(
  input: string,
  opts: {
    source?: string
    kind?: string
    options?: boolean | SecretRedactionOptions
  } = {},
): SecretRedactionResult {
  const norm = normalizeSecretRedactionOptions(opts.options ?? { enabled: true })
  const source = sanitizeSource(opts.source)
  const kind = opts.kind || 'text'
  const enabledCats = new Set<SecretRedactionCategory>(norm.categories)
  const countsByCategory: Record<string, number> = {}
  let totalRedactions = 0

  const bump = (cat: SecretRedactionCategory): void => {
    countsByCategory[cat] = (countsByCategory[cat] ?? 0) + 1
    totalRedactions += 1
  }

  let text = input

  // 1. PEM private keys (multi-line blocks first)
  if (enabledCats.has('private-key')) {
    text = text.replace(PEM_PRIVATE_KEY_RE, () => {
      bump('private-key')
      return '[REDACTED:PRIVATE_KEY]'
    })
  }

  // 2. JWTs (before bearer-token so `Bearer eyJ...` gets tagged as JWT)
  if (enabledCats.has('jwt')) {
    text = text.replace(JWT_CANDIDATE_RE, (match) => {
      if (!isPlausibleJwt(match)) return match
      bump('jwt')
      return maskJwt(norm.mode)
    })
  }

  // 3. AWS Access Key IDs (AKIA..., ASIA..., ABIA..., ACCA...)
  if (enabledCats.has('aws-access-key')) {
    text = text.replace(AWS_ACCESS_KEY_RE, (match) => {
      bump('aws-access-key')
      return maskAwsAccessKey(match, norm.mode)
    })
  }

  // 4. Contextual AWS Secret Access Keys
  if (enabledCats.has('aws-secret-key')) {
    text = text.replace(AWS_SECRET_KEY_RE, (_full, prefix: string) => {
      bump('aws-secret-key')
      return `${prefix}[REDACTED:AWS_SECRET]`
    })
  }

  // 5. Well-known provider API keys (GitHub, OpenAI, Anthropic, Stripe, Slack, Google, SendGrid)
  if (enabledCats.has('provider-api-key')) {
    for (const re of PROVIDER_API_KEY_PATTERNS) {
      re.lastIndex = 0
      text = text.replace(re, () => {
        bump('provider-api-key')
        return '[REDACTED:API_KEY]'
      })
    }
  }

  // 6. Authorization Bearer tokens (skips already-redacted `[REDACTED:...`)
  if (enabledCats.has('bearer-token')) {
    text = text.replace(BEARER_TOKEN_RE, (_full, prefix: string) => {
      bump('bearer-token')
      return `${prefix}[REDACTED:BEARER_TOKEN]`
    })
  }

  // 7. Credit card numbers (Luhn-validated + major network IIN prefixes)
  if (enabledCats.has('credit-card')) {
    text = text.replace(CREDIT_CARD_CANDIDATE_RE, (match) => {
      if (!isPlausibleCreditCard(match)) return match
      bump('credit-card')
      return maskCreditCard(match, norm.mode)
    })
  }

  // 8. Custom user-defined patterns
  if (enabledCats.has('custom') && norm.customPatterns.length > 0) {
    for (const custom of norm.customPatterns) {
      const re = compileCustomPattern(custom)
      if (!re) continue
      const replacement = custom.replacement || `[REDACTED:${(custom.name || 'CUSTOM').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}]`
      text = text.replace(re, (match) => {
        if (!match) return match
        bump('custom')
        return replacement
      })
    }
  }

  const categories = Object.keys(countsByCategory) as SecretRedactionCategory[]
  const meta: SecretRedactionMetadata = {
    redacted: totalRedactions > 0,
    totalRedactions,
    countsByCategory,
    categories,
    source,
    kind,
    mode: norm.mode,
  }
  return { text, meta }
}

/**
 * Stateful guard attached to BrowserManager for `--redact-secrets`.
 * Tracks aggregate redaction metrics without ever storing raw secret values.
 */
export class SecretRedactorGuard {
  private readonly defaults: NormalizedSecretRedactionOptions
  private scansCount = 0
  private pagesWithRedactions = 0
  private totalRedactions = 0
  private redactionsByCategory: Record<string, number> = {}
  private recentRedactions: SecretRedactionEvent[] = []

  constructor(opts?: boolean | SecretRedactionOptions) {
    this.defaults = normalizeSecretRedactionOptions(opts)
  }

  get enabled(): boolean {
    return this.defaults.enabled
  }

  get mode(): SecretRedactionMode {
    return this.defaults.mode
  }

  get categories(): SecretRedactionCategory[] {
    return [...this.defaults.categories]
  }

  shouldRedact(override?: boolean | SecretRedactionOptions): boolean {
    if (override === undefined) return this.defaults.enabled
    if (typeof override === 'boolean') return override
    if (override.enabled !== undefined) return Boolean(override.enabled)
    return this.defaults.enabled
  }

  private mergeOptions(override?: boolean | SecretRedactionOptions): NormalizedSecretRedactionOptions {
    if (override === undefined || typeof override === 'boolean') {
      return {
        ...this.defaults,
        enabled: override === undefined ? this.defaults.enabled : override,
      }
    }
    return normalizeSecretRedactionOptions({
      enabled: override.enabled ?? this.defaults.enabled,
      mode: override.mode ?? this.defaults.mode,
      categories: override.categories ?? this.defaults.categories,
      customPatterns: override.customPatterns ?? this.defaults.customPatterns,
    })
  }

  redact(
    input: string,
    ctx: {
      source?: string
      kind?: string
      override?: boolean | SecretRedactionOptions
    } = {},
  ): SecretRedactionResult {
    const merged = this.mergeOptions(ctx.override)
    const res = redactSensitiveText(input, {
      source: ctx.source,
      kind: ctx.kind,
      options: merged,
    })
    this.scansCount += 1
    if (res.meta.totalRedactions > 0) {
      this.pagesWithRedactions += 1
      this.totalRedactions += res.meta.totalRedactions
      for (const [cat, count] of Object.entries(res.meta.countsByCategory)) {
        this.redactionsByCategory[cat] = (this.redactionsByCategory[cat] ?? 0) + count
      }
      this.recentRedactions.push({
        ts: Date.now(),
        source: res.meta.source,
        kind: res.meta.kind,
        totalRedactions: res.meta.totalRedactions,
        countsByCategory: { ...res.meta.countsByCategory },
        categories: [...res.meta.categories],
      })
      if (this.recentRedactions.length > MAX_RECENT_REDACTIONS) {
        this.recentRedactions.splice(0, this.recentRedactions.length - MAX_RECENT_REDACTIONS)
      }
    }
    return res
  }

  getStats(): SecretRedactionStats {
    return {
      enabled: this.defaults.enabled,
      mode: this.defaults.mode,
      categories: [...this.defaults.categories],
      scansCount: this.scansCount,
      pagesWithRedactions: this.pagesWithRedactions,
      totalRedactions: this.totalRedactions,
      redactionsByCategory: { ...this.redactionsByCategory },
      recentRedactions: this.recentRedactions.map((e) => ({
        ...e,
        countsByCategory: { ...e.countsByCategory },
        categories: [...e.categories],
      })),
    }
  }

  resetStats(): void {
    this.scansCount = 0
    this.pagesWithRedactions = 0
    this.totalRedactions = 0
    this.redactionsByCategory = {}
    this.recentRedactions = []
  }
}
