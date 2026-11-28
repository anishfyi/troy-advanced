// AWS EC2 Instance Metadata Service v2 (IMDSv2) detector.
// Strictly uses IMDSv2 session tokens (PUT /latest/api/token -> GET /latest/meta-data/*)
// with tight timeouts and zero failure outside AWS.

import http from 'node:http'
import https from 'node:https'

export const DEFAULT_IMDS_BASE_URL = 'http://169.254.169.254'
export const DEFAULT_IMDS_TIMEOUT_MS = 400
export const DEFAULT_IMDS_TOKEN_TTL_SECONDS = 60
const MAX_IMDS_BODY_BYTES = 4096

export type ImdsStatus = 'available' | 'unavailable' | 'timeout' | 'disabled' | 'skipped'

export interface ImdsProbeOptions {
  /** Base URL for IMDSv2. Defaults to AWS_EC2_METADATA_SERVICE_ENDPOINT or http://169.254.169.254. */
  baseUrl?: string
  /** Per-request timeout in milliseconds (default: 400). */
  timeoutMs?: number
  /** IMDSv2 session token TTL in seconds (default: 60). */
  tokenTtlSeconds?: number
  /** Skip probing altogether and return status: 'skipped'. */
  skip?: boolean
  /** Optional environment variable map override for testing (defaults to process.env). */
  env?: NodeJS.ProcessEnv
}

export interface Ec2ImdsMetadata {
  available: boolean
  imdsVersion: 'v2' | null
  status: ImdsStatus
  instanceType: string | null
  region: string | null
  availabilityZone: string | null
  instanceId: string | null
  amiId: string | null
  latencyMs: number
  error?: string
}

interface ImdsHttpResult {
  ok: boolean
  timedOut: boolean
  statusCode?: number
  body?: string
  error?: string
}

/**
 * Strip control characters / non-7-bit-ASCII bytes and return the first trimmed line,
 * or null if empty. Prevents terminal escape injection from untrusted metadata endpoints.
 */
export function sanitizeImdsValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? ''
  const cleaned = firstLine.replace(/[^\x20-\x7e]/g, '').trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Derive an AWS region (e.g. "us-east-1") from an availability zone name
 * (e.g. "us-east-1a", "us-gov-west-1b", or a Local/Wavelength Zone like "us-east-1-wl1-bos-wlz-1").
 */
export function deriveRegionFromAz(az: string | null | undefined): string | null {
  const cleaned = sanitizeImdsValue(az)
  if (!cleaned) return null
  const standard = /^([a-z]{2}(?:-[a-z]+)+-\d+)[a-z]+$/.exec(cleaned)
  if (standard?.[1]) return standard[1]
  const extended = /^([a-z]{2}(?:-[a-z]+)+-\d+)-[a-z0-9-]+$/.exec(cleaned)
  if (extended?.[1]) return extended[1]
  return null
}

function emptyMetadata(status: ImdsStatus, latencyMs: number, error?: string): Ec2ImdsMetadata {
  return {
    available: false,
    imdsVersion: null,
    status,
    instanceType: null,
    region: null,
    availabilityZone: null,
    instanceId: null,
    amiId: null,
    latencyMs,
    ...(error ? { error } : {}),
  }
}

function imdsRequest(
  baseUrl: string,
  method: 'PUT' | 'GET',
  pathname: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ImdsHttpResult> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(pathname, baseUrl)
    } catch (err) {
      resolve({
        ok: false,
        timedOut: false,
        error: `Invalid IMDS URL: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      resolve({
        ok: false,
        timedOut: false,
        error: `Unsupported IMDS protocol: ${url.protocol}`,
      })
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    let settled = false
    const finish = (res: ImdsHttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }

    const req = transport.request(
      url,
      {
        method,
        headers: {
          connection: 'close',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        let totalBytes = 0
        res.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
          if (totalBytes + buf.length > MAX_IMDS_BODY_BYTES) {
            const remaining = MAX_IMDS_BODY_BYTES - totalBytes
            if (remaining > 0) chunks.push(buf.subarray(0, remaining))
            totalBytes = MAX_IMDS_BODY_BYTES
            res.destroy()
            finish({
              ok: true,
              timedOut: false,
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
            return
          }
          chunks.push(buf)
          totalBytes += buf.length
        })
        res.on('end', () => {
          finish({
            ok: true,
            timedOut: false,
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', (err) => {
          finish({
            ok: false,
            timedOut: false,
            error: err.message,
          })
        })
      },
    )

    const timer = setTimeout(() => {
      req.destroy()
      finish({
        ok: false,
        timedOut: true,
        error: `IMDSv2 request timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    req.on('timeout', () => {
      req.destroy()
      finish({
        ok: false,
        timedOut: true,
        error: `IMDSv2 request timed out after ${timeoutMs}ms`,
      })
    })

    req.on('error', (err) => {
      finish({
        ok: false,
        timedOut: false,
        error: err.message,
      })
    })

    req.end()
  })
}

async function fetchImdsField(
  baseUrl: string,
  pathname: string,
  token: string,
  timeoutMs: number,
): Promise<string | null> {
  const res = await imdsRequest(
    baseUrl,
    'GET',
    pathname,
    { 'X-aws-ec2-metadata-token': token },
    timeoutMs,
  )
  if (!res.ok || res.statusCode !== 200) return null
  return sanitizeImdsValue(res.body)
}

/**
 * Probe AWS EC2 Instance Metadata Service v2 (IMDSv2).
 * Never throws; returns `available: false` cleanly when running outside AWS or when IMDS is unreachable/disabled.
 */
export async function probeEc2ImdsV2(options: ImdsProbeOptions = {}): Promise<Ec2ImdsMetadata> {
  const startedAt = Date.now()
  const env = options.env ?? process.env

  if (options.skip) {
    return emptyMetadata('skipped', 0)
  }

  const disabledEnv = env.AWS_EC2_METADATA_DISABLED?.trim().toLowerCase()
  if (disabledEnv === 'true' || disabledEnv === '1') {
    return emptyMetadata('disabled', 0, 'AWS_EC2_METADATA_DISABLED is enabled')
  }

  const baseUrl =
    options.baseUrl?.trim() ||
    env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.trim() ||
    DEFAULT_IMDS_BASE_URL

  const timeoutMs = Math.max(
    20,
    Math.min(10_000, Math.round(options.timeoutMs ?? DEFAULT_IMDS_TIMEOUT_MS)),
  )
  const tokenTtlSeconds = Math.max(
    1,
    Math.min(21_600, Math.round(options.tokenTtlSeconds ?? DEFAULT_IMDS_TOKEN_TTL_SECONDS)),
  )

  // Step 1: Obtain IMDSv2 session token (strictly PUT /latest/api/token; never fall back to IMDSv1).
  const tokenRes = await imdsRequest(
    baseUrl,
    'PUT',
    '/latest/api/token',
    { 'X-aws-ec2-metadata-token-ttl-seconds': String(tokenTtlSeconds) },
    timeoutMs,
  )

  if (!tokenRes.ok) {
    return emptyMetadata(
      tokenRes.timedOut ? 'timeout' : 'unavailable',
      Date.now() - startedAt,
      tokenRes.error,
    )
  }

  if (tokenRes.statusCode === 403) {
    return emptyMetadata('disabled', Date.now() - startedAt, 'IMDSv2 disabled (HTTP 403)')
  }

  if (tokenRes.statusCode !== 200) {
    return emptyMetadata(
      'unavailable',
      Date.now() - startedAt,
      `IMDSv2 token endpoint returned HTTP ${tokenRes.statusCode ?? 0}`,
    )
  }

  const token = sanitizeImdsValue(tokenRes.body)
  if (!token) {
    return emptyMetadata('unavailable', Date.now() - startedAt, 'IMDSv2 returned empty session token')
  }

  // Step 2: Query core EC2 instance metadata in parallel using the session token.
  const [instanceType, availabilityZone, rawRegion, instanceId, amiId] = await Promise.all([
    fetchImdsField(baseUrl, '/latest/meta-data/instance-type', token, timeoutMs),
    fetchImdsField(baseUrl, '/latest/meta-data/placement/availability-zone', token, timeoutMs),
    fetchImdsField(baseUrl, '/latest/meta-data/placement/region', token, timeoutMs),
    fetchImdsField(baseUrl, '/latest/meta-data/instance-id', token, timeoutMs),
    fetchImdsField(baseUrl, '/latest/meta-data/ami-id', token, timeoutMs),
  ])

  const region = rawRegion ?? deriveRegionFromAz(availabilityZone)
  const latencyMs = Date.now() - startedAt

  if (!instanceType && !region && !availabilityZone && !instanceId && !amiId) {
    return emptyMetadata('unavailable', latencyMs, 'IMDSv2 metadata endpoints returned no EC2 attributes')
  }

  return {
    available: true,
    imdsVersion: 'v2',
    status: 'available',
    instanceType,
    region,
    availabilityZone,
    instanceId,
    amiId,
    latencyMs,
  }
}
