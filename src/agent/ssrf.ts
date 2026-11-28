// SSRF protection guard (`--block-private-net`) for multi-tenant & EC2 deployments.
// Blocks AWS/Cloud IMDS (169.254.169.254, fd00:ec2::254, 169.254.170.2),
// RFC1918 private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16),
// loopback (127.0.0.0/8, ::1, localhost), link-local (169.254.0.0/16, fe80::/10),
// CGNAT (100.64.0.0/10), IPv6 ULA (fc00::/7), IPv4-mapped IPv6 bypasses,
// and DNS-rebinding hostnames resolving to private/metadata IPs.

import dns from 'node:dns/promises'
import type {
  SsrfBlockCategory,
  SsrfBlockedEntry,
  SsrfCheckResult,
  SsrfDnsRecord,
  SsrfProtectionOptions,
  SsrfProtectionStats,
} from '../types.js'

const MAX_RECENT_BLOCKED = 50

export const BLOCKED_METADATA_HOSTS: readonly string[] = [
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
]

export class SsrfBlockedError extends Error {
  readonly code = 'ssrf' as const
  readonly status = 'blocked' as const
  readonly category: SsrfBlockCategory
  readonly url: string
  readonly hostname?: string
  readonly ip?: string
  readonly reason: string

  constructor(result: SsrfCheckResult & { category: SsrfBlockCategory; reason: string }) {
    super(result.reason)
    this.name = 'SsrfBlockedError'
    this.category = result.category
    this.url = result.url ?? ''
    this.hostname = result.hostname
    this.ip = result.ip
    this.reason = result.reason
  }
}

export function isSsrfBlockedError(err: unknown): err is SsrfBlockedError {
  return (
    err instanceof SsrfBlockedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'ssrf' &&
      (err as { status?: unknown }).status === 'blocked')
  )
}

function normalizeHostInput(raw: string): string {
  let host = raw.trim().toLowerCase()
  if (!host) return ''
  // If user passed a full URL/origin like "http://127.0.0.1:8080", extract hostname.
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname.toLowerCase()
    } catch {
      // fall through
    }
  }
  // Strip IPv6 brackets and trailing FQDN dot.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  host = host.replace(/\.+$/, '')
  return host
}

function parseIpv4Part(part: string): number | null {
  if (!part) return null
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const n = Number.parseInt(part.slice(2), 16)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  if (/^0[0-7]+$/.test(part)) {
    const n = Number.parseInt(part, 8)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  if (/^(0|[1-9][0-9]*)$/.test(part)) {
    const n = Number.parseInt(part, 10)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  return null
}

/**
 * Parses IPv4 literals including standard dotted-quad (`169.254.169.254`),
 * shorthand (`127.1`, `10.0.1`), single 32-bit decimal (`2852039166`),
 * hex (`0xa9fea9fe`), and octal (`0177.0.0.1`) forms into an unsigned 32-bit int.
 */
export function parseIpv4ToUint32(rawHost: string): number | null {
  const host = rawHost.trim().replace(/\.+$/, '')
  if (!host) return null
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    const n = parseIpv4Part(p)
    if (n === null) return null
    nums.push(n)
  }

  if (nums.length === 1) {
    const a = nums[0]!
    if (a > 0xffffffff) return null
    return a >>> 0
  }
  if (nums.length === 2) {
    const [a, b] = nums as [number, number]
    if (a > 0xff || b > 0xffffff) return null
    return (((a << 24) | b) >>> 0)
  }
  if (nums.length === 3) {
    const [a, b, c] = nums as [number, number, number]
    if (a > 0xff || b > 0xff || c > 0xffff) return null
    return (((a << 24) | (b << 16) | c) >>> 0)
  }
  const [a, b, c, d] = nums as [number, number, number, number]
  if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0)
}

export function uint32ToIpv4(ip: number): string {
  return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`
}

/**
 * Parses an IPv6 literal (with or without brackets, optional `%zone` suffix,
 * `::` compression, or embedded IPv4 suffix like `::ffff:169.254.169.254`)
 * into 8 16-bit unsigned groups.
 */
export function parseIpv6ToGroups(rawHost: string): number[] | null {
  let host = rawHost.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  // Strip IPv6 zone identifier (e.g. fe80::1%eth0 or fe80::1%25eth0)
  const zoneIdx = host.indexOf('%')
  if (zoneIdx >= 0) {
    host = host.slice(0, zoneIdx)
  }
  if (!host.includes(':')) return null

  // Handle embedded IPv4 tail (e.g. ::ffff:169.254.169.254)
  let tailGroups: number[] = []
  const lastColon = host.lastIndexOf(':')
  const maybeIpv4 = host.slice(lastColon + 1)
  if (maybeIpv4.includes('.')) {
    const ipv4 = parseIpv4ToUint32(maybeIpv4)
    if (ipv4 === null) return null
    tailGroups = [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff]
    host = host.slice(0, lastColon)
    if (host.endsWith(':')) {
      // e.g. `::127.0.0.1` -> host became `:` -> restore `::`
      host = `${host}:`
    }
  }

  const doubleColonParts = host.split('::')
  if (doubleColonParts.length > 2) return null

  const parseSegment = (seg: string): number[] | null => {
    if (!seg) return []
    const items = seg.split(':')
    const out: number[] = []
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      out.push(Number.parseInt(item, 16))
    }
    return out
  }

  if (doubleColonParts.length === 1) {
    const head = parseSegment(doubleColonParts[0]!)
    if (!head) return null
    const all = [...head, ...tailGroups]
    return all.length === 8 ? all : null
  }

  const left = parseSegment(doubleColonParts[0]!)
  const right = parseSegment(doubleColonParts[1]!)
  if (!left || !right) return null
  const missing = 8 - (left.length + right.length + tailGroups.length)
  if (missing < 0) return null
  return [...left, ...new Array<number>(missing).fill(0), ...right, ...tailGroups]
}

export interface IpClassification {
  isIpLiteral: boolean
  family?: 4 | 6
  normalizedIp?: string
  blocked: boolean
  category?: SsrfBlockCategory
  reason?: string
}

function classifyIpv4Uint32(ip: number): {
  blocked: boolean
  category?: SsrfBlockCategory
  reason?: string
} {
  const dotted = uint32ToIpv4(ip)
  const o1 = (ip >>> 24) & 0xff
  const o2 = (ip >>> 16) & 0xff
  const o3 = (ip >>> 8) & 0xff
  const o4 = ip & 0xff

  // Cloud IMDS endpoints (checked first for explicit, actionable diagnostics)
  if (o1 === 169 && o2 === 254 && o3 === 169 && o4 === 254) {
    return {
      blocked: true,
      category: 'imds',
      reason: `SSRF protection blocked cloud Instance Metadata Service (${dotted})`,
    }
  }
  if (o1 === 169 && o2 === 254 && o3 === 170 && o4 === 2) {
    return {
      blocked: true,
      category: 'imds',
      reason: `SSRF protection blocked AWS ECS Task Metadata endpoint (${dotted})`,
    }
  }
  if (o1 === 169 && o2 === 254 && o3 === 169 && o4 === 253) {
    return {
      blocked: true,
      category: 'imds',
      reason: `SSRF protection blocked AWS VPC metadata/DNS endpoint (${dotted})`,
    }
  }

  // Loopback: 127.0.0.0/8
  if (o1 === 127) {
    return {
      blocked: true,
      category: 'loopback',
      reason: `SSRF protection blocked loopback IPv4 address (${dotted} in 127.0.0.0/8)`,
    }
  }

  // Unspecified / "this network": 0.0.0.0/8 (routes to localhost on Linux)
  if (o1 === 0) {
    return {
      blocked: true,
      category: 'unspecified',
      reason: `SSRF protection blocked unspecified IPv4 address (${dotted} in 0.0.0.0/8)`,
    }
  }

  // RFC1918 Private IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (o1 === 10) {
    return {
      blocked: true,
      category: 'private-ipv4',
      reason: `SSRF protection blocked private IPv4 address (${dotted} in 10.0.0.0/8)`,
    }
  }
  if (o1 === 172 && o2 >= 16 && o2 <= 31) {
    return {
      blocked: true,
      category: 'private-ipv4',
      reason: `SSRF protection blocked private IPv4 address (${dotted} in 172.16.0.0/12)`,
    }
  }
  if (o1 === 192 && o2 === 168) {
    return {
      blocked: true,
      category: 'private-ipv4',
      reason: `SSRF protection blocked private IPv4 address (${dotted} in 192.168.0.0/16)`,
    }
  }

  // Link-local: 169.254.0.0/16
  if (o1 === 169 && o2 === 254) {
    return {
      blocked: true,
      category: 'link-local',
      reason: `SSRF protection blocked link-local IPv4 address (${dotted} in 169.254.0.0/16)`,
    }
  }

  // Carrier-Grade NAT (RFC 6598): 100.64.0.0/10 (also covers Alibaba IMDS 100.100.100.200 & Tailscale)
  if (o1 === 100 && o2 >= 64 && o2 <= 127) {
    return {
      blocked: true,
      category: 'cgnat',
      reason: `SSRF protection blocked shared/CGNAT IPv4 address (${dotted} in 100.64.0.0/10)`,
    }
  }

  // IETF Protocol Assignments (192.0.0.0/24), Benchmarking (198.18.0.0/15), Multicast (224.0.0.0/4), Reserved (240.0.0.0/4)
  if (
    (o1 === 192 && o2 === 0 && o3 === 0) ||
    (o1 === 198 && (o2 === 18 || o2 === 19)) ||
    o1 >= 224
  ) {
    return {
      blocked: true,
      category: 'multicast-reserved',
      reason: `SSRF protection blocked reserved/multicast IPv4 address (${dotted})`,
    }
  }

  return { blocked: false }
}

export function classifyIp(rawIp: string): IpClassification {
  const trimmed = rawIp.trim()
  if (!trimmed) return { isIpLiteral: false, blocked: false }

  const v4 = parseIpv4ToUint32(trimmed)
  if (v4 !== null) {
    const res = classifyIpv4Uint32(v4)
    return {
      isIpLiteral: true,
      family: 4,
      normalizedIp: uint32ToIpv4(v4),
      ...res,
    }
  }

  const v6 = parseIpv6ToGroups(trimmed)
  if (v6 !== null) {
    const normalized = v6.map((g) => g.toString(16)).join(':')
    const [g0, g1, g2, g3, g4, g5, g6, g7] = v6 as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]

    // Unspecified ::/128
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: '::',
        blocked: true,
        category: 'unspecified',
        reason: 'SSRF protection blocked unspecified IPv6 address (::)',
      }
    }

    // Loopback ::1/128
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: '::1',
        blocked: true,
        category: 'loopback',
        reason: 'SSRF protection blocked loopback IPv6 address (::1)',
      }
    }

    // IPv4-mapped IPv6 ::ffff:0:0/96 (e.g. ::ffff:169.254.169.254 or ::ffff:a9fe:a9fe)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      const embeddedV4 = (((g6 << 16) | g7) >>> 0)
      const inner = classifyIpv4Uint32(embeddedV4)
      if (inner.blocked) {
        return {
          isIpLiteral: true,
          family: 6,
          normalizedIp: `::ffff:${uint32ToIpv4(embeddedV4)}`,
          blocked: true,
          category: inner.category === 'imds' ? 'imds' : 'ipv6-mapped-ipv4',
          reason: `SSRF protection blocked IPv4-mapped IPv6 address (::ffff:${uint32ToIpv4(embeddedV4)}): ${inner.reason}`,
        }
      }
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: `::ffff:${uint32ToIpv4(embeddedV4)}`,
        blocked: false,
      }
    }

    // IPv4-compatible IPv6 ::0:0/96 (deprecated, still accepted by some stacks)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && (g6 !== 0 || g7 > 1)) {
      const embeddedV4 = (((g6 << 16) | g7) >>> 0)
      const inner = classifyIpv4Uint32(embeddedV4)
      if (inner.blocked) {
        return {
          isIpLiteral: true,
          family: 6,
          normalizedIp: `::${uint32ToIpv4(embeddedV4)}`,
          blocked: true,
          category: inner.category === 'imds' ? 'imds' : 'ipv6-mapped-ipv4',
          reason: `SSRF protection blocked IPv4-compatible IPv6 address (::${uint32ToIpv4(embeddedV4)}): ${inner.reason}`,
        }
      }
    }

    // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052)
    if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      const embeddedV4 = (((g6 << 16) | g7) >>> 0)
      const inner = classifyIpv4Uint32(embeddedV4)
      if (inner.blocked) {
        return {
          isIpLiteral: true,
          family: 6,
          normalizedIp: normalized,
          blocked: true,
          category: inner.category === 'imds' ? 'imds' : 'ipv6-mapped-ipv4',
          reason: `SSRF protection blocked NAT64 IPv6 address mapping to ${uint32ToIpv4(embeddedV4)}`,
        }
      }
    }

    // AWS EC2 IPv6 IMDS endpoint: fd00:ec2::254
    if (g0 === 0xfd00 && g1 === 0x0ec2 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x0254) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: 'fd00:ec2::254',
        blocked: true,
        category: 'imds',
        reason: 'SSRF protection blocked AWS EC2 IPv6 Instance Metadata Service (fd00:ec2::254)',
      }
    }

    // Unique Local Address (ULA) fc00::/7
    if ((g0 & 0xfe00) === 0xfc00) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: normalized,
        blocked: true,
        category: 'ipv6-private',
        reason: `SSRF protection blocked private IPv6 ULA address (${normalized} in fc00::/7)`,
      }
    }

    // Link-local fe80::/10
    if ((g0 & 0xffc0) === 0xfe80) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: normalized,
        blocked: true,
        category: 'link-local',
        reason: `SSRF protection blocked link-local IPv6 address (${normalized} in fe80::/10)`,
      }
    }

    // Deprecated site-local fec0::/10
    if ((g0 & 0xffc0) === 0xfec0) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: normalized,
        blocked: true,
        category: 'ipv6-private',
        reason: `SSRF protection blocked site-local IPv6 address (${normalized} in fec0::/10)`,
      }
    }

    // Multicast ff00::/8
    if ((g0 & 0xff00) === 0xff00) {
      return {
        isIpLiteral: true,
        family: 6,
        normalizedIp: normalized,
        blocked: true,
        category: 'multicast-reserved',
        reason: `SSRF protection blocked multicast IPv6 address (${normalized} in ff00::/8)`,
      }
    }

    return {
      isIpLiteral: true,
      family: 6,
      normalizedIp: normalized,
      blocked: false,
    }
  }

  return { isIpLiteral: false, blocked: false }
}

function hostMatchesList(hostname: string, list: readonly string[]): boolean {
  const norm = normalizeHostInput(hostname)
  if (!norm) return false
  for (const rawEntry of list) {
    const entry = normalizeHostInput(rawEntry)
    if (!entry) continue
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2)
      if (norm === suffix || norm.endsWith(`.${suffix}`)) return true
    } else if (norm === entry) {
      return true
    }
  }
  return false
}

function isBlockedMetadataHostname(hostname: string): { blocked: boolean; category?: SsrfBlockCategory; reason?: string } {
  const norm = normalizeHostInput(hostname)
  if (!norm) return { blocked: false }
  if (norm === 'localhost' || norm.endsWith('.localhost') || norm === 'ip6-localhost' || norm === 'ip6-loopback') {
    return {
      blocked: true,
      category: 'loopback',
      reason: `SSRF protection blocked loopback hostname (${norm})`,
    }
  }
  for (const h of BLOCKED_METADATA_HOSTS) {
    if (norm === h || norm.endsWith(`.${h}`)) {
      return {
        blocked: true,
        category: 'metadata-host',
        reason: `SSRF protection blocked cloud metadata hostname (${norm})`,
      }
    }
  }
  return { blocked: false }
}

function extractHostname(rawUrl: string): { hostname: string; protocol: string } | null {
  try {
    const parsed = new URL(rawUrl)
    return {
      hostname: normalizeHostInput(parsed.hostname),
      protocol: parsed.protocol.toLowerCase(),
    }
  } catch {
    return null
  }
}

/**
 * Synchronous SSRF check on URL hostname, IP literals (IPv4/IPv6/hex/octal/mapped),
 * metadata hostnames, and custom blocklists. Does not perform DNS resolution.
 */
export function checkUrlSsrfSync(rawUrl: string, opts: SsrfProtectionOptions = {}): SsrfCheckResult {
  if (!opts.enabled) {
    return { allowed: true, blocked: false, url: rawUrl }
  }
  const parsed = extractHostname(rawUrl)
  if (!parsed) {
    return { allowed: true, blocked: false, url: rawUrl }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: true, blocked: false, url: rawUrl, hostname: parsed.hostname }
  }

  const { hostname } = parsed
  if (opts.allowHosts && opts.allowHosts.length > 0 && hostMatchesList(hostname, opts.allowHosts)) {
    return { allowed: true, blocked: false, url: rawUrl, hostname }
  }

  if (opts.extraBlockedHosts && opts.extraBlockedHosts.length > 0 && hostMatchesList(hostname, opts.extraBlockedHosts)) {
    return {
      allowed: false,
      blocked: true,
      url: rawUrl,
      hostname,
      category: 'custom-blocked',
      reason: `SSRF protection blocked configured host (${hostname})`,
    }
  }

  const metaCheck = isBlockedMetadataHostname(hostname)
  if (metaCheck.blocked && metaCheck.category && metaCheck.reason) {
    return {
      allowed: false,
      blocked: true,
      url: rawUrl,
      hostname,
      category: metaCheck.category,
      reason: metaCheck.reason,
    }
  }

  const ipCheck = classifyIp(hostname)
  if (ipCheck.isIpLiteral) {
    if (ipCheck.blocked && ipCheck.category && ipCheck.reason) {
      return {
        allowed: false,
        blocked: true,
        url: rawUrl,
        hostname,
        ip: ipCheck.normalizedIp,
        category: ipCheck.category,
        reason: ipCheck.reason,
      }
    }
    return {
      allowed: true,
      blocked: false,
      url: rawUrl,
      hostname,
      ip: ipCheck.normalizedIp,
    }
  }

  return { allowed: true, blocked: false, url: rawUrl, hostname }
}

async function defaultDnsLookup(hostname: string): Promise<SsrfDnsRecord[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }))
}

/**
 * Full async SSRF check: runs synchronous literal/hostname checks first,
 * then resolves DNS (when `resolveDns !== false`) and blocks if ANY resolved IP
 * belongs to IMDS, loopback, RFC1918 private, link-local, CGNAT, or ULA ranges.
 */
export async function checkUrlSsrf(rawUrl: string, opts: SsrfProtectionOptions = {}): Promise<SsrfCheckResult> {
  const syncRes = checkUrlSsrfSync(rawUrl, opts)
  if (!opts.enabled || syncRes.blocked) return syncRes
  if (opts.resolveDns === false) return syncRes

  const hostname = syncRes.hostname
  if (!hostname) return syncRes
  if (opts.allowHosts && opts.allowHosts.length > 0 && hostMatchesList(hostname, opts.allowHosts)) {
    return syncRes
  }

  // Already an IP literal and allowed by sync check -> no DNS lookup needed.
  if (classifyIp(hostname).isIpLiteral) {
    return syncRes
  }

  const lookup = opts.dnsLookup ?? defaultDnsLookup
  let records: SsrfDnsRecord[]
  try {
    records = await lookup(hostname)
  } catch {
    // Unresolvable public hostnames will fail naturally in the network stack.
    return syncRes
  }

  for (const rec of records) {
    const ipCheck = classifyIp(rec.address)
    if (ipCheck.blocked && ipCheck.category && ipCheck.reason) {
      const category: SsrfBlockCategory =
        ipCheck.category === 'imds' ? 'imds' : 'dns-rebinding'
      return {
        allowed: false,
        blocked: true,
        url: rawUrl,
        hostname,
        ip: ipCheck.normalizedIp ?? rec.address,
        category,
        reason: `SSRF protection blocked ${hostname} resolving to ${ipCheck.normalizedIp ?? rec.address} (${ipCheck.category})`,
      }
    }
  }

  return syncRes
}

export class SsrfGuard {
  readonly enabled: boolean
  readonly resolveDns: boolean
  readonly allowHosts: readonly string[]
  readonly extraBlockedHosts: readonly string[]
  private readonly dnsLookup?: (hostname: string) => Promise<SsrfDnsRecord[]>

  private checkedCount = 0
  private blockedCount = 0
  private blockedByCategory = new Map<string, number>()
  private recentBlocked: SsrfBlockedEntry[] = []

  constructor(opts: SsrfProtectionOptions = {}) {
    this.enabled = Boolean(opts.enabled)
    this.resolveDns = opts.resolveDns !== false
    this.allowHosts = (opts.allowHosts ?? []).map((h) => h.trim()).filter(Boolean)
    this.extraBlockedHosts = (opts.extraBlockedHosts ?? []).map((h) => h.trim()).filter(Boolean)
    this.dnsLookup = opts.dnsLookup
  }

  getOptions(): SsrfProtectionOptions {
    return {
      enabled: this.enabled,
      resolveDns: this.resolveDns,
      allowHosts: [...this.allowHosts],
      extraBlockedHosts: [...this.extraBlockedHosts],
      ...(this.dnsLookup ? { dnsLookup: this.dnsLookup } : {}),
    }
  }

  private recordResult(res: SsrfCheckResult): SsrfCheckResult {
    this.checkedCount += 1
    if (res.blocked && res.category && res.reason) {
      this.blockedCount += 1
      this.blockedByCategory.set(res.category, (this.blockedByCategory.get(res.category) ?? 0) + 1)
      this.recentBlocked.push({
        ts: Date.now(),
        url: res.url ?? '',
        ...(res.hostname ? { hostname: res.hostname } : {}),
        ...(res.ip ? { ip: res.ip } : {}),
        category: res.category,
        reason: res.reason,
      })
      if (this.recentBlocked.length > MAX_RECENT_BLOCKED) {
        this.recentBlocked.shift()
      }
    }
    return res
  }

  checkSync(rawUrl: string): SsrfCheckResult {
    if (!this.enabled) return { allowed: true, blocked: false, url: rawUrl }
    return this.recordResult(checkUrlSsrfSync(rawUrl, this.getOptions()))
  }

  async checkAsync(rawUrl: string): Promise<SsrfCheckResult> {
    if (!this.enabled) return { allowed: true, blocked: false, url: rawUrl }
    return this.recordResult(await checkUrlSsrf(rawUrl, this.getOptions()))
  }

  async assertAllowed(rawUrl: string): Promise<void> {
    const res = await this.checkAsync(rawUrl)
    if (res.blocked && res.category && res.reason) {
      throw new SsrfBlockedError({
        ...res,
        category: res.category,
        reason: res.reason,
      })
    }
  }

  getStats(): SsrfProtectionStats {
    const byCat: Record<string, number> = {}
    for (const [k, v] of this.blockedByCategory.entries()) {
      byCat[k] = v
    }
    return {
      enabled: this.enabled,
      resolveDns: this.resolveDns,
      allowHosts: [...this.allowHosts],
      extraBlockedHosts: [...this.extraBlockedHosts],
      checkedCount: this.checkedCount,
      blockedCount: this.blockedCount,
      blockedByCategory: byCat,
      recentBlocked: [...this.recentBlocked],
    }
  }
}

export function parseSsrfAllowHosts(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((v) => parseSsrfAllowHosts(v))
  }
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
