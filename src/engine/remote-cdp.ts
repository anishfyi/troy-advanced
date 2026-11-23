// Remote CDP proxy support (`--cdp-url ws://...` or `http://...`)
// Enables driving Chrome running on another EC2 node, Docker container,
// reverse proxy, or SSH local port-forward tunnel.

export type RemoteCdpProtocol = 'http' | 'https' | 'ws' | 'wss'

export interface ParsedRemoteCdpUrl {
  /** Original trimmed input string */
  raw: string
  /** Canonical URL string (without trailing slash on HTTP base) */
  normalized: string
  protocol: RemoteCdpProtocol
  /** 'http' for http/https DevTools discovery endpoints, 'ws' for direct WebSocket endpoints */
  transport: 'http' | 'ws'
  hostname: string
  port: number
  /** Effective host[:port] (as formatted by URL.host) */
  host: string
  /** Normalized HTTP(S) base URL without credentials or /json/* suffix (present when transport === 'http') */
  httpBaseUrl?: string
  /** Direct WebSocket URL (present when transport === 'ws') */
  wsUrl?: string
  /** True if a ws(s) URL points at a single page target (/devtools/page/...) rather than browser target */
  isPageTargetWs?: boolean
  /** Optional path prefix on HTTP(S) reverse proxies (e.g. '/cdp') */
  basePath: string
  /** Raw query string (including leading '?' when non-empty) */
  search: string
  /** Optional HTTP Basic Authorization header derived from userinfo */
  authHeader?: string
  /** Safe display string with credentials and secret query params redacted */
  displayUrl: string
}

export interface DiscoveredRemoteCdp {
  configured: ParsedRemoteCdpUrl
  /** Browser-level WebSocket debugger URL (rewritten to target the configured proxy host/port/scheme) */
  browserWsUrl: string
  /** HTTP base URL if discovery used http/https */
  httpBaseUrl?: string
  browserVersion?: string
  protocolVersion?: string
  userAgent?: string
  v8Version?: string
}

export interface RemoteCdpInfo {
  displayUrl: string
  transport: 'http' | 'ws'
  httpBaseUrl?: string
  browserWsUrl: string
  browserVersion?: string
  protocolVersion?: string
}

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'auth',
  'key',
  'apikey',
  'api_key',
  'secret',
  'password',
  'pass',
])

function defaultPortForProtocol(protocol: RemoteCdpProtocol): number {
  return protocol === 'https' || protocol === 'wss' ? 443 : 80
}

function redactUrlForDisplay(parsed: URL): string {
  const clone = new URL(parsed.toString())
  clone.username = ''
  clone.password = ''
  if (clone.searchParams.size > 0) {
    const redacted = new URLSearchParams()
    for (const [k, v] of clone.searchParams.entries()) {
      redacted.append(k, SENSITIVE_QUERY_KEYS.has(k.toLowerCase()) ? '***' : v)
    }
    clone.search = redacted.toString() ? `?${redacted.toString()}` : ''
  }
  return clone.toString().replace(/\/+$/, '')
}

function stripTrailingJsonEndpoint(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '')
  if (!trimmed || trimmed === '/') return ''
  const stripped = trimmed.replace(/\/json(?:\/(?:version|list|protocol|new))?$/i, '')
  return stripped === '/' ? '' : stripped
}

export function parseRemoteCdpUrl(input: string): ParsedRemoteCdpUrl {
  const raw = String(input ?? '').trim()
  if (!raw) {
    throw new Error('Remote CDP URL cannot be empty. Expected http(s)://host:port or ws(s)://host:port/devtools/browser/...')
  }

  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(
      `Invalid remote CDP URL "${raw}". Expected http(s)://host:port or ws(s)://host:port/devtools/browser/...`,
    )
  }

  const protoRaw = u.protocol.replace(/:$/, '').toLowerCase()
  if (protoRaw !== 'http' && protoRaw !== 'https' && protoRaw !== 'ws' && protoRaw !== 'wss') {
    throw new Error(
      `Unsupported remote CDP URL scheme "${u.protocol}". Expected http://, https://, ws://, or wss://`,
    )
  }
  const protocol = protoRaw as RemoteCdpProtocol

  if (!u.hostname) {
    throw new Error(`Remote CDP URL "${raw}" is missing a hostname`)
  }

  const port = u.port ? Number(u.port) : defaultPortForProtocol(protocol)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port in remote CDP URL "${raw}"`)
  }

  let authHeader: string | undefined
  if (u.username || u.password) {
    const user = decodeURIComponent(u.username)
    const pass = decodeURIComponent(u.password)
    authHeader = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
  }

  const displayUrl = redactUrlForDisplay(u)

  if (protocol === 'http' || protocol === 'https') {
    const basePath = stripTrailingJsonEndpoint(u.pathname)
    const clean = new URL(u.toString())
    clean.username = ''
    clean.password = ''
    clean.pathname = basePath || '/'
    clean.search = ''
    clean.hash = ''
    const httpBaseUrl = clean.toString().replace(/\/+$/, '')

    return {
      raw,
      normalized: `${httpBaseUrl}${u.search}`,
      protocol,
      transport: 'http',
      hostname: u.hostname,
      port,
      host: u.host,
      httpBaseUrl,
      basePath,
      search: u.search,
      authHeader,
      displayUrl,
    }
  }

  // ws:// or wss://
  const wsClean = new URL(u.toString())
  wsClean.hash = ''
  const wsUrl = wsClean.toString()
  const isPageTargetWs = /\/devtools\/page\//i.test(wsClean.pathname)

  return {
    raw,
    normalized: wsUrl,
    protocol,
    transport: 'ws',
    hostname: u.hostname,
    port,
    host: u.host,
    wsUrl,
    isPageTargetWs,
    basePath: '',
    search: wsClean.search,
    authHeader,
    displayUrl,
  }
}

/**
 * Rewrite a Chrome-reported `webSocketDebuggerUrl` (e.g. `ws://127.0.0.1:9222/devtools/browser/abc`)
 * so that it connects through the user's configured remote CDP host, port, scheme, and proxy prefix
 * (essential for SSH tunnels like `ssh -L 19222:127.0.0.1:9222`, Docker bridges, and TLS reverse proxies).
 */
export function rewriteCdpWebSocketUrl(reportedWsUrl: string, configured: ParsedRemoteCdpUrl): string {
  const reported = new URL(reportedWsUrl)
  const wsProtocol = configured.protocol === 'https' || configured.protocol === 'wss' ? 'wss:' : 'ws:'

  let pathname = reported.pathname || '/'
  if (configured.basePath) {
    const prefix = configured.basePath.replace(/\/+$/, '')
    if (prefix && !pathname.startsWith(`${prefix}/`) && pathname !== prefix) {
      pathname = `${prefix}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
    }
  }

  const out = new URL(`${wsProtocol}//${configured.host}${pathname}`)

  // Preserve reported query params first, then overlay any missing configured proxy params (e.g. ?token=...)
  for (const [k, v] of reported.searchParams.entries()) {
    out.searchParams.append(k, v)
  }
  if (configured.search) {
    const cfgParams = new URLSearchParams(configured.search)
    for (const [k, v] of cfgParams.entries()) {
      if (!out.searchParams.has(k)) {
        out.searchParams.set(k, v)
      }
    }
  }

  return out.toString()
}

export async function discoverRemoteCdp(
  cdpUrl: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<DiscoveredRemoteCdp> {
  const configured = parseRemoteCdpUrl(cdpUrl)
  const timeoutMs = opts.timeoutMs ?? 10000

  if (configured.transport === 'ws') {
    if (configured.isPageTargetWs) {
      throw new Error(
        `Remote CDP URL "${configured.displayUrl}" points to a single page target (/devtools/page/...). ` +
          `Pass the browser-level WebSocket URL (ws://host:port/devtools/browser/<id>) or HTTP base URL (http://host:port).`,
      )
    }
    return {
      configured,
      browserWsUrl: configured.wsUrl!,
    }
  }

  const versionUrl = `${configured.httpBaseUrl}/json/version${configured.search}`
  const reqHeaders: Record<string, string> = {
    ...(opts.headers ?? {}),
  }
  if (configured.authHeader && !reqHeaders.Authorization && !reqHeaders.authorization) {
    reqHeaders.Authorization = configured.authHeader
  }

  const deadline = Date.now() + timeoutMs
  let lastErr: string | null = null

  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(500, deadline - Date.now())
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(remaining, 4000))
      try {
        const res = await fetch(versionUrl, {
          headers: Object.keys(reqHeaders).length > 0 ? reqHeaders : undefined,
          signal: controller.signal,
        })
        if (res.ok) {
          const data = (await res.json()) as {
            webSocketDebuggerUrl?: string
            Browser?: string
            'Protocol-Version'?: string
            'User-Agent'?: string
            'V8-Version'?: string
          }
          if (data.webSocketDebuggerUrl) {
            const browserWsUrl = rewriteCdpWebSocketUrl(data.webSocketDebuggerUrl, configured)
            return {
              configured,
              browserWsUrl,
              httpBaseUrl: configured.httpBaseUrl,
              browserVersion: data.Browser,
              protocolVersion: data['Protocol-Version'],
              userAgent: data['User-Agent'],
              v8Version: data['V8-Version'],
            }
          }
          lastErr = 'Remote /json/version response did not include webSocketDebuggerUrl'
        } else {
          lastErr = `HTTP ${res.status} ${res.statusText}`
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  throw new Error(
    `Remote CDP endpoint ${configured.displayUrl} did not respond within ${timeoutMs}ms` +
      (lastErr ? ` (${lastErr})` : ''),
  )
}
