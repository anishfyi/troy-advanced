// Proxy configuration, environment resolution, Chromium launch flag builder,
// and pure-Node HTTP/HTTPS/SOCKS5 proxy transport for the Lite engine.
// Zero external dependencies — built strictly on Node.js core modules.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import type {
  ProxyEndpoint,
  ProxyInfoSummary,
  ProxyOptions,
  ProxyScheme,
  ResolvedProxyConfig,
} from '../types.js'

const SUPPORTED_SCHEMES = new Set<ProxyScheme>(['http', 'https', 'socks5', 'socks5h'])

const DEFAULT_PORTS: Record<ProxyScheme, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

const SOCKS5_REPLY_MESSAGES: Record<number, string> = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
}

function formatHostForUrl(hostname: string): string {
  const clean = hostname.replace(/^\[|\]$/g, '')
  return clean.includes(':') ? `[${clean}]` : clean
}

function clampTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 15_000
  }
  return Math.max(500, Math.min(120_000, Math.floor(value)))
}

/**
 * Parse and validate a proxy URL (`http://`, `https://`, `socks5://`, `socks5h://`).
 */
export function parseProxyUrl(raw: string): ProxyEndpoint {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Proxy URL must not be empty')
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)
  if (!schemeMatch || !schemeMatch[1]) {
    throw new Error(
      `Invalid proxy URL "${trimmed}": missing scheme. Supported schemes: http://, https://, socks5://, socks5h://`,
    )
  }

  const schemeLower = schemeMatch[1].toLowerCase()
  if (!SUPPORTED_SCHEMES.has(schemeLower as ProxyScheme)) {
    throw new Error(
      `Unsupported proxy scheme "${schemeLower}://". Supported schemes: http://, https://, socks5://, socks5h://`,
    )
  }
  const scheme = schemeLower as ProxyScheme

  // Node's URL parser handles http/https with standard host/port rules; for socks5/socks5h
  // we temporarily normalize to http:// so IPv6/auth/port parsing is 100% consistent.
  const parseInput = scheme === 'http' || scheme === 'https'
    ? trimmed
    : `http://${trimmed.slice(schemeMatch[0].length)}`

  let parsed: URL
  try {
    parsed = new URL(parseInput)
  } catch {
    throw new Error(`Invalid proxy URL "${redactProxyUrl(trimmed)}"`)
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) {
    throw new Error(`Invalid proxy URL "${redactProxyUrl(trimmed)}": missing hostname`)
  }

  let port = DEFAULT_PORTS[scheme]
  if (parsed.port) {
    const parsedPort = Number(parsed.port)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`Invalid proxy port "${parsed.port}" in "${redactProxyUrl(trimmed)}"`)
    }
    port = parsedPort
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined
  const hasAuth = username !== undefined || password !== undefined

  const hostForUrl = formatHostForUrl(hostname)
  const chromiumScheme = scheme === 'socks5h' ? 'socks5' : scheme
  const chromiumServer = `${chromiumScheme}://${hostForUrl}:${port}`

  const authSegment = hasAuth
    ? `${encodeURIComponent(username ?? '')}${password !== undefined ? `:${encodeURIComponent(password)}` : ''}@`
    : ''
  const redactedAuthSegment = hasAuth
    ? `${username ? `${username}:` : ''}***@`
    : ''

  return {
    url: `${scheme}://${authSegment}${hostForUrl}:${port}`,
    displayUrl: `${scheme}://${redactedAuthSegment}${hostForUrl}:${port}`,
    scheme,
    hostname,
    port,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    hasAuth,
    chromiumServer,
  }
}

/**
 * Redact embedded credentials from any proxy URL string without throwing.
 */
export function redactProxyUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return trimmed.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/, (_match, prefix: string, creds: string) => {
    const colon = creds.indexOf(':')
    if (colon > 0) {
      return `${prefix}${creds.slice(0, colon)}:***@`
    }
    return `${prefix}***@`
  })
}

/**
 * Parse a comma/semicolon/whitespace-separated proxy bypass list (`NO_PROXY` / `--proxy-bypass`).
 */
export function parseBypassList(input?: string | string[]): string[] {
  if (!input) return []
  const rawList = Array.isArray(input) ? input : [input]
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (typeof item !== 'string') continue
    for (const token of item.split(/[,;\s]+/)) {
      const normalized = token.trim().toLowerCase()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

function readEnvProxy(env: NodeJS.ProcessEnv, lowerKey: string, upperKey: string): string | undefined {
  const v = env[lowerKey] ?? env[upperKey]
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve effective proxy configuration from explicit CLI/programmatic options and environment variables.
 *
 * Precedence:
 * 1. Explicit `opts.server` (`--proxy`) overrides env vars for all schemes.
 * 2. Explicit `opts.httpProxy` / `opts.httpsProxy` / `opts.allProxy`.
 * 3. Environment variables (unless `opts.useEnv === false`):
 *    - `TROY_ADVANCED_PROXY` (all schemes)
 *    - `http_proxy` / `HTTP_PROXY`
 *    - `https_proxy` / `HTTPS_PROXY`
 *    - `all_proxy` / `ALL_PROXY`
 *    - `no_proxy` / `NO_PROXY` / `TROY_ADVANCED_PROXY_BYPASS`
 */
export function resolveProxyConfig(
  opts?: string | ProxyOptions | ResolvedProxyConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyConfig {
  if (opts && typeof opts === 'object' && 'source' in opts && 'bypassList' in opts && 'enabled' in opts) {
    return opts as ResolvedProxyConfig
  }

  const normalizedOpts: ProxyOptions =
    typeof opts === 'string'
      ? { server: opts }
      : opts ?? {}

  const useEnv = normalizedOpts.useEnv !== false
  const timeoutMs = clampTimeoutMs(normalizedOpts.timeoutMs)

  let source: 'cli' | 'env' | 'none' = 'none'
  let server: ProxyEndpoint | null = null
  let httpProxy: ProxyEndpoint | null = null
  let httpsProxy: ProxyEndpoint | null = null
  let allProxy: ProxyEndpoint | null = null

  if (normalizedOpts.server && normalizedOpts.server.trim()) {
    server = parseProxyUrl(normalizedOpts.server)
    source = 'cli'
  } else {
    const cliHttp = normalizedOpts.httpProxy?.trim()
    const cliHttps = normalizedOpts.httpsProxy?.trim()
    const cliAll = normalizedOpts.allProxy?.trim()

    if (cliHttp || cliHttps || cliAll) {
      source = 'cli'
      if (cliHttp) httpProxy = parseProxyUrl(cliHttp)
      if (cliHttps) httpsProxy = parseProxyUrl(cliHttps)
      if (cliAll) allProxy = parseProxyUrl(cliAll)
    }

    if (useEnv) {
      const envGlobal = readEnvProxy(env, 'troy_advanced_proxy', 'TROY_ADVANCED_PROXY')
      if (envGlobal && !cliHttp && !cliHttps && !cliAll) {
        server = parseProxyUrl(envGlobal)
        source = 'env'
      } else {
        const envHttp = readEnvProxy(env, 'http_proxy', 'HTTP_PROXY')
        const envHttps = readEnvProxy(env, 'https_proxy', 'HTTPS_PROXY')
        const envAll = readEnvProxy(env, 'all_proxy', 'ALL_PROXY')
        if (!httpProxy && envHttp) {
          httpProxy = parseProxyUrl(envHttp)
          if (source === 'none') source = 'env'
        }
        if (!httpsProxy && envHttps) {
          httpsProxy = parseProxyUrl(envHttps)
          if (source === 'none') source = 'env'
        }
        if (!allProxy && envAll) {
          allProxy = parseProxyUrl(envAll)
          if (source === 'none') source = 'env'
        }
      }
    }
  }

  const bypassInputs: string[] = []
  if (normalizedOpts.bypass) {
    bypassInputs.push(...parseBypassList(normalizedOpts.bypass))
  }
  if (useEnv) {
    const envNoProxy = readEnvProxy(env, 'no_proxy', 'NO_PROXY')
    if (envNoProxy) bypassInputs.push(...parseBypassList(envNoProxy))
    const envTroyBypass = readEnvProxy(env, 'troy_advanced_proxy_bypass', 'TROY_ADVANCED_PROXY_BYPASS')
    if (envTroyBypass) bypassInputs.push(...parseBypassList(envTroyBypass))
  }
  const bypassList = parseBypassList(bypassInputs)

  const enabled = Boolean(server || httpProxy || httpsProxy || allProxy)

  return {
    enabled,
    server,
    httpProxy,
    httpsProxy,
    allProxy,
    bypassList,
    source: enabled ? source : 'none',
    timeoutMs,
  }
}

function splitBypassHostPort(pattern: string): { host: string; port?: number } {
  // Bracketed IPv6 with optional port: [::1] or [::1]:8080
  if (pattern.startsWith('[')) {
    const closeIdx = pattern.indexOf(']')
    if (closeIdx > 0) {
      const host = pattern.slice(1, closeIdx)
      const rest = pattern.slice(closeIdx + 1)
      if (rest.startsWith(':')) {
        const p = Number(rest.slice(1))
        if (Number.isInteger(p) && p > 0) return { host, port: p }
      }
      return { host }
    }
  }
  // Unbracketed IPv6 literal (multiple colons): ::1
  if (pattern.indexOf(':') !== pattern.lastIndexOf(':')) {
    return { host: pattern }
  }
  const colonIdx = pattern.lastIndexOf(':')
  if (colonIdx > 0) {
    const maybePort = Number(pattern.slice(colonIdx + 1))
    if (Number.isInteger(maybePort) && maybePort > 0 && maybePort <= 65535) {
      return { host: pattern.slice(0, colonIdx), port: maybePort }
    }
  }
  return { host: pattern }
}

/**
 * Determine whether a target URL should bypass the proxy based on `NO_PROXY` / `--proxy-bypass` patterns.
 */
export function shouldBypassProxy(targetUrl: string | URL, bypassList: string[]): boolean {
  if (!bypassList.length) return false
  let parsed: URL
  try {
    parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl
  } catch {
    return false
  }

  const targetHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const targetPort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80
  const targetIsIp = net.isIP(targetHost) !== 0

  for (const rawPattern of bypassList) {
    const pattern = rawPattern.trim().toLowerCase()
    if (!pattern) continue
    if (pattern === '*') return true

    const { host: patternHostRaw, port: patternPort } = splitBypassHostPort(pattern)
    if (patternPort !== undefined && patternPort !== targetPort) {
      continue
    }

    if (patternHostRaw === '*') return true

    let patternHost = patternHostRaw
    let isWildcard = false
    if (patternHost.startsWith('*.')) {
      patternHost = patternHost.slice(2)
      isWildcard = true
    } else if (patternHost.startsWith('.')) {
      patternHost = patternHost.slice(1)
      isWildcard = true
    }
    if (!patternHost) continue

    if (targetHost === patternHost) return true
    if (!targetIsIp && net.isIP(patternHost) === 0) {
      if (isWildcard || patternHost.includes('.')) {
        if (targetHost.endsWith(`.${patternHost}`)) return true
      }
    }
  }

  return false
}

/**
 * Select the effective proxy endpoint for a given target URL, or `null` if direct connection should be used.
 */
export function selectProxyForUrl(
  targetUrl: string | URL,
  config: ResolvedProxyConfig,
): ProxyEndpoint | null {
  if (!config.enabled) return null

  let parsed: URL
  try {
    parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }

  if (shouldBypassProxy(parsed, config.bypassList)) {
    return null
  }

  if (config.server) return config.server
  if (parsed.protocol === 'https:') {
    return config.httpsProxy ?? config.allProxy ?? null
  }
  return config.httpProxy ?? config.allProxy ?? null
}

/**
 * Build Chromium CLI arguments (`--proxy-server`, `--proxy-bypass-list`) for a resolved proxy config.
 */
export function buildChromiumProxyArgs(config: ResolvedProxyConfig): string[] {
  if (!config.enabled) return []

  const args: string[] = []
  let proxyServerArg: string | null = null

  if (config.server) {
    proxyServerArg = config.server.chromiumServer
  } else if (config.httpProxy && config.httpsProxy) {
    if (config.httpProxy.chromiumServer === config.httpsProxy.chromiumServer) {
      proxyServerArg = config.httpProxy.chromiumServer
    } else {
      proxyServerArg = `http=${config.httpProxy.chromiumServer};https=${config.httpsProxy.chromiumServer}`
    }
  } else if (config.httpProxy) {
    proxyServerArg = config.allProxy
      ? `http=${config.httpProxy.chromiumServer};https=${config.allProxy.chromiumServer}`
      : `http=${config.httpProxy.chromiumServer}`
  } else if (config.httpsProxy) {
    proxyServerArg = config.allProxy
      ? `http=${config.allProxy.chromiumServer};https=${config.httpsProxy.chromiumServer}`
      : `https=${config.httpsProxy.chromiumServer}`
  } else if (config.allProxy) {
    proxyServerArg = config.allProxy.chromiumServer
  }

  if (proxyServerArg) {
    args.push(`--proxy-server=${proxyServerArg}`)
  }

  if (config.bypassList.length > 0) {
    args.push(`--proxy-bypass-list=${config.bypassList.join(';')}`)
  }

  return args
}

/**
 * Return a credential-safe summary of the resolved proxy configuration.
 */
export function summarizeProxyConfig(config: ResolvedProxyConfig): ProxyInfoSummary {
  const hasAuth = Boolean(
    config.server?.hasAuth ||
      config.httpProxy?.hasAuth ||
      config.httpsProxy?.hasAuth ||
      config.allProxy?.hasAuth,
  )
  return {
    enabled: config.enabled,
    source: config.source,
    server: config.server?.displayUrl ?? null,
    httpProxy: config.httpProxy?.displayUrl ?? null,
    httpsProxy: config.httpsProxy?.displayUrl ?? null,
    allProxy: config.allProxy?.displayUrl ?? null,
    bypassList: [...config.bypassList],
    hasAuth,
  }
}

function buildBasicProxyAuthHeader(proxy: ProxyEndpoint): string | undefined {
  if (!proxy.hasAuth) return undefined
  const token = Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

/**
 * Parse an IPv6 address literal into a 16-byte buffer for SOCKS5 ATYP=0x04.
 */
function encodeIpv6Bytes(ip: string): Buffer {
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const parts = clean.split('::')
  const left = parts[0] ? parts[0].split(':').filter(Boolean) : []
  const right = parts.length > 1 && parts[1] ? parts[1].split(':').filter(Boolean) : []
  const missing = 8 - (left.length + right.length)
  if (missing < 0) {
    throw new Error(`Invalid IPv6 address: ${ip}`)
  }
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right]
  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2)
  }
  return buf
}

/**
 * Buffered exact-byte reader over a net.Socket for binary protocol handshakes (SOCKS5).
 */
class SocketByteReader {
  private buffer: Buffer = Buffer.alloc(0)
  private closedError: Error | null = null
  private waiter: {
    needed: number
    resolve: (buf: Buffer) => void
    reject: (err: Error) => void
  } | null = null
  private readonly onData: (chunk: Buffer) => void
  private readonly onError: (err: Error) => void
  private readonly onClose: () => void

  constructor(private readonly socket: net.Socket) {
    this.onData = (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.flush()
    }
    this.onError = (err: Error) => {
      this.fail(err)
    }
    this.onClose = () => {
      this.fail(new Error('SOCKS5 proxy closed connection unexpectedly during handshake'))
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private flush(): void {
    if (!this.waiter) return
    if (this.buffer.length >= this.waiter.needed) {
      const { needed, resolve } = this.waiter
      this.waiter = null
      const out = this.buffer.subarray(0, needed)
      this.buffer = this.buffer.subarray(needed)
      resolve(out)
    }
  }

  private fail(err: Error): void {
    if (!this.closedError) {
      this.closedError = err
    }
    if (this.waiter) {
      const { reject } = this.waiter
      this.waiter = null
      reject(this.closedError)
    }
  }

  readExact(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0))
    if (this.buffer.length >= n) {
      const out = this.buffer.subarray(0, n)
      this.buffer = this.buffer.subarray(n)
      return Promise.resolve(out)
    }
    if (this.closedError) {
      return Promise.reject(this.closedError)
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.waiter = { needed: n, resolve, reject }
    })
  }

  detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    if (this.buffer.length > 0) {
      this.socket.unshift(this.buffer)
      this.buffer = Buffer.alloc(0)
    }
  }
}

/**
 * Establish a TCP tunnel through a SOCKS5 / SOCKS5h proxy (RFC 1928 + RFC 1929).
 */
export async function openSocks5Tunnel(
  proxy: ProxyEndpoint,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const socket = net.connect({ host: proxy.hostname, port: proxy.port })
  socket.setNoDelay(true)

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`SOCKS5 proxy handshake timed out after ${timeoutMs}ms (${proxy.displayUrl})`))
    }, timeoutMs)
  })

  const handshake = async (): Promise<net.Socket> => {
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onErr)
        resolve()
      }
      const onErr = (err: Error) => {
        socket.off('connect', onConnect)
        reject(new Error(`Failed to connect to SOCKS5 proxy ${proxy.displayUrl}: ${err.message}`))
      }
      socket.once('connect', onConnect)
      socket.once('error', onErr)
    })

    const reader = new SocketByteReader(socket)
    try {
      // 1. Greeting: VER=5, NMETHODS, METHODS
      const methods = proxy.hasAuth ? [0x00, 0x02] : [0x00]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))

      const methodReply = await reader.readExact(2)
      const replyVer = methodReply[0] ?? 0
      const chosenMethod = methodReply[1] ?? 0xff
      if (replyVer !== 0x05) {
        throw new Error(`Invalid SOCKS5 greeting version: 0x${replyVer.toString(16)}`)
      }
      if (chosenMethod === 0xff) {
        throw new Error(`SOCKS5 proxy ${proxy.displayUrl} rejected all authentication methods`)
      }

      // 2. Optional RFC 1929 Username/Password authentication
      if (chosenMethod === 0x02) {
        if (!proxy.hasAuth) {
          throw new Error(`SOCKS5 proxy ${proxy.displayUrl} requires username/password authentication`)
        }
        const userBuf = Buffer.from(proxy.username ?? '', 'utf8')
        const passBuf = Buffer.from(proxy.password ?? '', 'utf8')
        if (userBuf.length > 255 || passBuf.length > 255) {
          throw new Error('SOCKS5 username/password exceeds 255-byte protocol limit')
        }
        socket.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]))

        const authReply = await reader.readExact(2)
        if (authReply[1] !== 0x00) {
          throw new Error(`SOCKS5 proxy authentication failed (${proxy.displayUrl})`)
        }
      } else if (chosenMethod !== 0x00) {
        throw new Error(`SOCKS5 proxy selected unsupported auth method: 0x${chosenMethod.toString(16)}`)
      }

      // 3. CONNECT request: VER=5, CMD=1 (CONNECT), RSV=0, ATYP, DST.ADDR, DST.PORT
      const cleanHost = targetHost.replace(/^\[|\]$/g, '')
      let addrPacket: Buffer
      if (net.isIPv4(cleanHost)) {
        const octets = cleanHost.split('.').map((n) => Number(n))
        addrPacket = Buffer.from([0x01, ...octets])
      } else if (net.isIPv6(cleanHost)) {
        addrPacket = Buffer.concat([Buffer.from([0x04]), encodeIpv6Bytes(cleanHost)])
      } else {
        const hostBuf = Buffer.from(cleanHost, 'utf8')
        if (hostBuf.length > 255) {
          throw new Error(`Target hostname too long for SOCKS5: ${cleanHost}`)
        }
        addrPacket = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf])
      }

      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(targetPort, 0)
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPacket, portBuf]))

      // 4. Read CONNECT reply: VER, REP, RSV, ATYP, BND.ADDR, BND.PORT
      const replyHeader = await reader.readExact(4)
      const connectVer = replyHeader[0] ?? 0
      const connectRep = replyHeader[1] ?? 0x01
      const atyp = replyHeader[3] ?? 0
      if (connectVer !== 0x05) {
        throw new Error(`Invalid SOCKS5 reply version: 0x${connectVer.toString(16)}`)
      }
      if (connectRep !== 0x00) {
        const reason = SOCKS5_REPLY_MESSAGES[connectRep] ?? `code 0x${connectRep.toString(16)}`
        throw new Error(`SOCKS5 CONNECT to ${targetHost}:${targetPort} failed: ${reason}`)
      }

      if (atyp === 0x01) {
        await reader.readExact(4 + 2)
      } else if (atyp === 0x04) {
        await reader.readExact(16 + 2)
      } else if (atyp === 0x03) {
        const lenBuf = await reader.readExact(1)
        const domainLen = lenBuf[0] ?? 0
        await reader.readExact(domainLen + 2)
      } else {
        throw new Error(`Unsupported SOCKS5 reply address type: 0x${atyp.toString(16)}`)
      }

      reader.detach()
      return socket
    } catch (err) {
      reader.detach()
      socket.destroy()
      throw err
    }
  }

  try {
    return await Promise.race([handshake(), timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Establish an HTTP CONNECT tunnel through an `http://` or `https://` proxy.
 */
export async function openHttpConnectTunnel(
  proxy: ProxyEndpoint,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const authority = `${formatHostForUrl(targetHost)}:${targetPort}`
  const headers: Record<string, string> = {
    Host: authority,
    'Proxy-Connection': 'Keep-Alive',
  }
  const authHeader = buildBasicProxyAuthHeader(proxy)
  if (authHeader) {
    headers['Proxy-Authorization'] = authHeader
  }

  return new Promise<net.Socket>((resolve, reject) => {
    const reqModule = proxy.scheme === 'https' ? https : http
    let settled = false
    const finish = (err: Error | null, sock?: net.Socket) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(sock!)
    }

    const req = reqModule.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      timeout: timeoutMs,
    })

    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        finish(new Error(`HTTP proxy CONNECT to ${authority} failed with status ${res.statusCode ?? 0} (${proxy.displayUrl})`))
        return
      }
      if (head && head.length > 0) {
        socket.unshift(head)
      }
      finish(null, socket)
    })

    req.on('timeout', () => {
      req.destroy()
      finish(new Error(`HTTP proxy CONNECT timed out after ${timeoutMs}ms (${proxy.displayUrl})`))
    })

    req.on('error', (err) => {
      finish(new Error(`HTTP proxy CONNECT error (${proxy.displayUrl}): ${err.message}`))
    })

    req.end()
  })
}

async function normalizeRequestBody(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  if (typeof (body as Blob).arrayBuffer === 'function') {
    const ab = await (body as Blob).arrayBuffer()
    return Buffer.from(ab)
  }
  return Buffer.from(String(body), 'utf8')
}

function normalizeInitHeaders(input?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input) return out
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      out[key] = value
    }
    return out
  }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = String(value)
    }
  }
  return out
}

function maybeDecompressBody(body: Buffer, contentEncoding: string | undefined): { body: Buffer; decompressed: boolean } {
  if (!contentEncoding || body.length === 0) return { body, decompressed: false }
  const enc = contentEncoding.trim().toLowerCase()
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return { body: zlib.gunzipSync(body), decompressed: true }
    }
    if (enc === 'deflate') {
      return { body: zlib.inflateSync(body), decompressed: true }
    }
    if (enc === 'br') {
      return { body: zlib.brotliDecompressSync(body), decompressed: true }
    }
  } catch {
    // If upstream sent malformed/uncompressed payload with a misleading header, return raw bytes
  }
  return { body, decompressed: false }
}

function buildFetchResponse(res: http.IncomingMessage, rawBody: Buffer): Response {
  const status = res.statusCode ?? 200
  const statusText = res.statusMessage ?? ''
  const headers = new Headers()

  const contentEncoding = typeof res.headers['content-encoding'] === 'string'
    ? res.headers['content-encoding']
    : undefined
  const { body, decompressed } = NULL_BODY_STATUSES.has(status)
    ? { body: Buffer.alloc(0), decompressed: false }
    : maybeDecompressBody(rawBody, contentEncoding)

  for (const [key, val] of Object.entries(res.headers)) {
    if (val === undefined) continue
    const lower = key.toLowerCase()
    if (decompressed && (lower === 'content-encoding' || lower === 'content-length')) {
      continue
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        headers.append(key, item)
      }
    } else {
      headers.set(key, val)
    }
  }

  if (NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status, statusText, headers })
  }
  return new Response(new Uint8Array(body), { status, statusText, headers })
}

function executeNodeHttpRequest(
  reqModule: typeof http | typeof https,
  options: http.RequestOptions,
  body: Buffer | undefined,
  signal?: AbortSignal | null,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'))
      return
    }

    let settled = false
    const finish = (err: Error | null, response?: Response) => {
      if (settled) return
      settled = true
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
      }
      if (err) reject(err)
      else resolve(response!)
    }

    const req = reqModule.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })
      res.on('end', () => {
        const rawBody = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)
        try {
          finish(null, buildFetchResponse(res, rawBody))
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)))
        }
      })
      res.on('error', (err) => finish(err))
    })

    const onAbort = () => {
      req.destroy()
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'))
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('timeout', () => {
      req.destroy()
      finish(new Error(`Proxied HTTP request timed out after ${options.timeout ?? 15000}ms`))
    })

    req.on('error', (err) => finish(err))

    if (body && body.length > 0) {
      req.write(body)
    }
    req.end()
  })
}

/**
 * Perform a Fetch-API-compatible HTTP(S) request routed through the configured HTTP/HTTPS/SOCKS5 proxy.
 * Falls back directly to `globalThis.fetch` when no proxy applies or the target host is bypassed.
 */
export async function proxiedFetch(
  input: string | URL | Request,
  init?: RequestInit,
  config?: ResolvedProxyConfig | null,
): Promise<Response> {
  if (!config || !config.enabled) {
    return globalThis.fetch(input, init)
  }

  const targetUrlStr = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
  const proxy = selectProxyForUrl(targetUrlStr, config)
  if (!proxy) {
    return globalThis.fetch(input, init)
  }

  const targetUrl = new URL(targetUrlStr)
  const isHttpsTarget = targetUrl.protocol === 'https:'
  const targetPort = targetUrl.port ? Number(targetUrl.port) : isHttpsTarget ? 443 : 80
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = normalizeInitHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const body = await normalizeRequestBody(init?.body)
  const signal = init?.signal

  // Ensure Host header targets the destination origin, not the proxy host
  const hasHostHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'host')
  if (!hasHostHeader) {
    headers['Host'] = targetUrl.host
  }
  if (body && body.length > 0 && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = String(body.length)
  }

  // Case 1: HTTP/HTTPS forward proxy for plain http:// target
  if ((proxy.scheme === 'http' || proxy.scheme === 'https') && !isHttpsTarget) {
    const authHeader = buildBasicProxyAuthHeader(proxy)
    if (authHeader) {
      headers['Proxy-Authorization'] = authHeader
    }
    const reqModule = proxy.scheme === 'https' ? https : http
    return executeNodeHttpRequest(
      reqModule,
      {
        hostname: proxy.hostname,
        port: proxy.port,
        method,
        path: targetUrl.toString(),
        headers,
        agent: false,
        timeout: config.timeoutMs,
      },
      body,
      signal,
    )
  }

  // Case 2 & 3: Tunnel via HTTP CONNECT (for https:// targets) or SOCKS5/SOCKS5h (for http:// or https:// targets)
  const rawTunnel =
    proxy.scheme === 'socks5' || proxy.scheme === 'socks5h'
      ? await openSocks5Tunnel(proxy, targetUrl.hostname, targetPort, config.timeoutMs)
      : await openHttpConnectTunnel(proxy, targetUrl.hostname, targetPort, config.timeoutMs)

  let transportSocket: net.Socket = rawTunnel
  if (isHttpsTarget) {
    const servername = targetUrl.hostname.replace(/^\[|\]$/g, '')
    transportSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tlsSock = tls.connect({
        socket: rawTunnel,
        servername: net.isIP(servername) ? undefined : servername,
      })
      const onSecure = () => {
        tlsSock.off('error', onErr)
        resolve(tlsSock)
      }
      const onErr = (err: Error) => {
        tlsSock.off('secureConnect', onSecure)
        tlsSock.destroy()
        reject(new Error(`TLS handshake over proxy ${proxy.displayUrl} failed: ${err.message}`))
      }
      tlsSock.once('secureConnect', onSecure)
      tlsSock.once('error', onErr)
    })
  }

  // Speak HTTP/1.1 directly over the established (optionally TLS-wrapped) tunnel socket.
  // Because each tunnel is single-use (`agent: false`), request `Connection: close` and
  // always clean up the tunnel socket after the response completes so no sockets leak.
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'connection')) {
    headers['Connection'] = 'close'
  }
  try {
    return await executeNodeHttpRequest(
      http,
      {
        hostname: targetUrl.hostname,
        port: targetPort,
        method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
        agent: false,
        timeout: config.timeoutMs,
        createConnection: () => transportSocket,
      },
      body,
      signal,
    )
  } finally {
    if (!transportSocket.destroyed) {
      transportSocket.destroy()
    }
  }
}

/**
 * Create a `fetch`-compatible function bound to a resolved proxy configuration.
 */
export function createProxiedFetch(config: ResolvedProxyConfig): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    proxiedFetch(input, init, config)) as typeof fetch
}
