// URL resolution, scheme refusal, and tracker-parameter stripping.
// Mirrors Troy's refusal guarantees in code so javascript:, data:, file:,
// blob:, and browser-internal schemes never execute from omnibox or agent calls.

const REFUSED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'blob:',
  'filesystem:',
  'file:',
  'vbscript:',
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'view-source:',
  'devtools:',
])

const TRACKER_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_cid',
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'yclid',
  'igshid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
])

export const BLOCKED_TRACKER_HOSTS: readonly string[] = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'adservice.google.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'bat.bing.com',
  'segment.io',
  'cdn.segment.com',
  'mixpanel.com',
  'hotjar.com',
  'fullstory.com',
  'clarity.ms',
  'scorecardresearch.com',
  'quantserve.com',
  'ads-twitter.com',
  'px.ads.linkedin.com',
  'tr.snapchat.com',
  'mc.yandex.ru',
]

export const AD_BEACON_URL_PATTERNS: readonly string[] = [
  '*://*/__utm.gif*',
  '*://*/pagead/1p-conversion*',
  '*://*/pagead/viewthroughconversion*',
  '*://*/g/collect?*',
]

export type ResolveResult =
  | { kind: 'url'; url: string; strippedParams: number }
  | { kind: 'search'; url: string; query: string }
  | { kind: 'refused'; reason: string; scheme?: string }

export function stripTrackingParams(rawUrl: string): { url: string; strippedParams: number } {
  try {
    const parsed = new URL(rawUrl)
    let stripped = 0
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase()
      if (TRACKER_PARAMS.has(lower) || lower.startsWith('utm_')) {
        parsed.searchParams.delete(key)
        stripped++
      }
    }
    return { url: parsed.toString(), strippedParams: stripped }
  } catch {
    return { url: rawUrl, strippedParams: 0 }
  }
}

export function isTrackerHost(rawUrl: string, extraHosts?: readonly string[]): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    const check = (d: string) => {
      const norm = d.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '')
      return Boolean(norm) && (host === norm || host.endsWith(`.${norm}`))
    }
    if (BLOCKED_TRACKER_HOSTS.some(check)) return true
    if (extraHosts && extraHosts.length > 0 && extraHosts.some(check)) return true
    return false
  } catch {
    return false
  }
}

export function matchesUrlWildcard(rawUrl: string, pattern: string): boolean {
  if (!pattern) return false
  // Escape regex metacharacters except `*`, which maps to `.*`
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${escaped}$`, 'i').test(rawUrl)
  } catch {
    return false
  }
}

export interface TrackerMatchResult {
  blocked: boolean
  reason?: 'tracker-host' | 'ad-beacon' | 'custom-pattern'
  matched?: string
}

export function isTrackerOrBeaconUrl(
  rawUrl: string,
  opts: {
    extraHosts?: readonly string[]
    extraUrlPatterns?: readonly string[]
    includeBeacons?: boolean
  } = {},
): TrackerMatchResult {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    for (const d of BLOCKED_TRACKER_HOSTS) {
      if (host === d || host.endsWith(`.${d}`)) {
        return { blocked: true, reason: 'tracker-host', matched: d }
      }
    }
    if (opts.extraHosts) {
      for (const raw of opts.extraHosts) {
        const d = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '')
        if (d && (host === d || host.endsWith(`.${d}`))) {
          return { blocked: true, reason: 'tracker-host', matched: d }
        }
      }
    }
  } catch {
    // non-URL strings still checked against custom patterns below
  }

  if (opts.includeBeacons !== false) {
    for (const pat of AD_BEACON_URL_PATTERNS) {
      if (matchesUrlWildcard(rawUrl, pat)) {
        return { blocked: true, reason: 'ad-beacon', matched: pat }
      }
    }
  }

  if (opts.extraUrlPatterns) {
    for (const pat of opts.extraUrlPatterns) {
      if (pat && matchesUrlWildcard(rawUrl, pat)) {
        return { blocked: true, reason: 'custom-pattern', matched: pat }
      }
    }
  }

  return { blocked: false }
}

export function buildCdpTrackerUrlPatterns(
  opts: {
    extraHosts?: readonly string[]
    extraUrlPatterns?: readonly string[]
    includeBeacons?: boolean
  } = {},
): string[] {
  const patterns = new Set<string>()
  const addHost = (rawHost: string) => {
    const host = rawHost.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '')
    if (!host) return
    patterns.add(`*://${host}/*`)
    patterns.add(`*://*.${host}/*`)
    patterns.add(`*://${host}`)
    patterns.add(`*://*.${host}`)
  }

  for (const h of BLOCKED_TRACKER_HOSTS) addHost(h)
  if (opts.extraHosts) {
    for (const h of opts.extraHosts) addHost(h)
  }
  if (opts.includeBeacons !== false) {
    for (const p of AD_BEACON_URL_PATTERNS) patterns.add(p)
  }
  if (opts.extraUrlPatterns) {
    for (const p of opts.extraUrlPatterns) {
      const trimmed = p.trim()
      if (trimmed) patterns.add(trimmed)
    }
  }

  return [...patterns]
}

export function exactOrigin(value: unknown): string | null {
  try {
    const parsed = new URL(String(value ?? ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export function normalizeOrigin(value: unknown): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    return exactOrigin(candidate) ?? ''
  } catch {
    return ''
  }
}

export function resolveInput(rawInput: string, searchEngine = 'https://duckduckgo.com/html/?q='): ResolveResult {
  // Strip ASCII control chars (like \n or \t) used to disguise javascript:\n...
  const trimmed = String(rawInput ?? '').trim()
  if (!trimmed) {
    return { kind: 'refused', reason: 'empty address' }
  }

  const normalizedForScheme = trimmed.replace(/[\u0000-\u001f\u007f]+/g, '')
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalizedForScheme)
  if (schemeMatch) {
    const scheme = `${schemeMatch[1]!.toLowerCase()}:`
    if (REFUSED_SCHEMES.has(scheme)) {
      return { kind: 'refused', reason: `scheme ${scheme} is refused`, scheme }
    }
    if (scheme === 'http:' || scheme === 'https:') {
      try {
        const parsed = new URL(normalizedForScheme)
        const { url, strippedParams } = stripTrackingParams(parsed.toString())
        return { kind: 'url', url, strippedParams }
      } catch {
        return { kind: 'refused', reason: 'malformed http(s) URL', scheme }
      }
    }
    // Check if it looks like host:port (e.g. localhost:3000 or 127.0.0.1:8080)
    if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,}):\d{1,5}(\/|$)/i.test(normalizedForScheme)) {
      const candidate = `http://${normalizedForScheme}`
      const { url, strippedParams } = stripTrackingParams(candidate)
      return { kind: 'url', url, strippedParams }
    }
    return { kind: 'refused', reason: `unsupported scheme ${scheme}`, scheme }
  }

  // Domain or localhost without scheme
  if (!/\s/.test(trimmed)) {
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(trimmed)) {
      const { url, strippedParams } = stripTrackingParams(`http://${trimmed}`)
      return { kind: 'url', url, strippedParams }
    }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)) {
      const { url, strippedParams } = stripTrackingParams(`https://${trimmed}`)
      return { kind: 'url', url, strippedParams }
    }
  }

  const query = trimmed
  return { kind: 'search', url: `${searchEngine}${encodeURIComponent(query)}`, query }
}
