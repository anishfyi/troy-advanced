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

const BLOCKED_TRACKER_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'bat.bing.com',
  'segment.io',
  'mixpanel.com',
  'hotjar.com',
  'fullstory.com',
  'clarity.ms',
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

export function isTrackerHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return BLOCKED_TRACKER_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
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
