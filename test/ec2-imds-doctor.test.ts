import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveRegionFromAz,
  formatDoctorAscii,
  probeEc2ImdsV2,
  runDoctor,
  runDoctorAsync,
  sanitizeImdsValue,
} from '../src/index.js'

const activeServers: http.Server[] = []

async function startMockServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler)
  activeServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const s = activeServers.pop()!
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

describe('EC2 IMDSv2 helpers', () => {
  it('derives AWS region from standard, GovCloud, and Local/Wavelength AZs', () => {
    expect(deriveRegionFromAz('us-east-1a')).toBe('us-east-1')
    expect(deriveRegionFromAz('ap-southeast-2c')).toBe('ap-southeast-2')
    expect(deriveRegionFromAz('us-gov-west-1b')).toBe('us-gov-west-1')
    expect(deriveRegionFromAz('cn-north-1a')).toBe('cn-north-1')
    expect(deriveRegionFromAz('us-east-1-wl1-bos-wlz-1')).toBe('us-east-1')
    expect(deriveRegionFromAz('not-an-az')).toBeNull()
    expect(deriveRegionFromAz('')).toBeNull()
    expect(deriveRegionFromAz(null)).toBeNull()
  })

  it('sanitizes control characters, ANSI escapes, and multiline values', () => {
    expect(sanitizeImdsValue('  t4g.medium \nignored-line')).toBe('t4g.medium')
    expect(sanitizeImdsValue('\x1b[31mus-east-1a\x1b[0m')).toBe('[31mus-east-1a[0m')
    expect(sanitizeImdsValue('\x00\x07\x1b\r\n')).toBeNull()
    expect(sanitizeImdsValue('   ')).toBeNull()
    expect(sanitizeImdsValue(null)).toBeNull()
  })
})

describe('probeEc2ImdsV2', () => {
  it('obtains IMDSv2 session token via PUT and reads instance type, region, AZ, instance ID, and AMI ID', async () => {
    const seenRequests: Array<{ method: string; url: string; ttl?: string; token?: string }> = []
    const expectedToken = 'AQAEAA-mock-imds-v2-session-token'

    const { baseUrl } = await startMockServer((req, res) => {
      const ttl = req.headers['x-aws-ec2-metadata-token-ttl-seconds']
      const token = req.headers['x-aws-ec2-metadata-token']
      seenRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        ttl: typeof ttl === 'string' ? ttl : undefined,
        token: typeof token === 'string' ? token : undefined,
      })

      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        if (!ttl) {
          res.writeHead(400)
          res.end('missing ttl')
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(expectedToken)
        return
      }

      if (req.method === 'GET' && token === expectedToken) {
        const routes: Record<string, string> = {
          '/latest/meta-data/instance-type': 't4g.medium',
          '/latest/meta-data/placement/region': 'us-east-1',
          '/latest/meta-data/placement/availability-zone': 'us-east-1a',
          '/latest/meta-data/instance-id': 'i-0123456789abcdef0',
          '/latest/meta-data/ami-id': 'ami-0abcdef1234567890',
        }
        const value = routes[req.url ?? '']
        if (value) {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end(value)
          return
        }
      }

      res.writeHead(404)
      res.end('not found')
    })

    const meta = await probeEc2ImdsV2({ baseUrl, timeoutMs: 1000, tokenTtlSeconds: 120 })
    expect(meta.available).toBe(true)
    expect(meta.imdsVersion).toBe('v2')
    expect(meta.status).toBe('available')
    expect(meta.instanceType).toBe('t4g.medium')
    expect(meta.region).toBe('us-east-1')
    expect(meta.availabilityZone).toBe('us-east-1a')
    expect(meta.instanceId).toBe('i-0123456789abcdef0')
    expect(meta.amiId).toBe('ami-0abcdef1234567890')
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0)

    const tokenReq = seenRequests.find((r) => r.method === 'PUT' && r.url === '/latest/api/token')
    expect(tokenReq?.ttl).toBe('120')

    const getReqs = seenRequests.filter((r) => r.method === 'GET')
    expect(getReqs.length).toBe(5)
    for (const r of getReqs) {
      expect(r.token).toBe(expectedToken)
    }
  })

  it('derives region from availability zone when /placement/region returns 404', async () => {
    const { baseUrl } = await startMockServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        res.writeHead(200)
        res.end('tok-fallback')
        return
      }
      if (req.headers['x-aws-ec2-metadata-token'] !== 'tok-fallback') {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      if (req.url === '/latest/meta-data/instance-type') {
        res.writeHead(200)
        res.end('c7g.large')
        return
      }
      if (req.url === '/latest/meta-data/placement/availability-zone') {
        res.writeHead(200)
        res.end('eu-central-1b')
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    const meta = await probeEc2ImdsV2({ baseUrl, timeoutMs: 1000 })
    expect(meta.available).toBe(true)
    expect(meta.instanceType).toBe('c7g.large')
    expect(meta.availabilityZone).toBe('eu-central-1b')
    expect(meta.region).toBe('eu-central-1')
    expect(meta.instanceId).toBeNull()
    expect(meta.amiId).toBeNull()
  })

  it('strictly enforces IMDSv2 and never falls back to unauthenticated IMDSv1 GET requests', async () => {
    let getCount = 0
    const { baseUrl } = await startMockServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        res.writeHead(405)
        res.end('Method Not Allowed')
        return
      }
      getCount++
      res.writeHead(200)
      res.end('t3.micro')
    })

    const meta = await probeEc2ImdsV2({ baseUrl, timeoutMs: 1000 })
    expect(meta.available).toBe(false)
    expect(meta.imdsVersion).toBeNull()
    expect(meta.status).toBe('unavailable')
    expect(getCount).toBe(0)
  })

  it('reports disabled cleanly when IMDSv2 returns HTTP 403', async () => {
    const { baseUrl } = await startMockServer((_req, res) => {
      res.writeHead(403)
      res.end('Forbidden')
    })

    const meta = await probeEc2ImdsV2({ baseUrl, timeoutMs: 1000 })
    expect(meta.available).toBe(false)
    expect(meta.status).toBe('disabled')
    expect(meta.error).toContain('403')
  })

  it('times out cleanly without throwing when metadata service hangs', async () => {
    const { baseUrl } = await startMockServer((_req, _res) => {
      // Intentionally hang without responding.
    })

    const started = Date.now()
    const meta = await probeEc2ImdsV2({ baseUrl, timeoutMs: 80 })
    const elapsed = Date.now() - started

    expect(meta.available).toBe(false)
    expect(meta.status).toBe('timeout')
    expect(elapsed).toBeLessThan(1500)
  })

  it('returns unavailable cleanly outside AWS (closed port or invalid protocol)', async () => {
    // Bind and immediately close a port so connections fail with ECONNREFUSED.
    const { server, baseUrl } = await startMockServer((_req, res) => res.end(''))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    activeServers.pop()

    const refused = await probeEc2ImdsV2({ baseUrl, timeoutMs: 500 })
    expect(refused.available).toBe(false)
    expect(refused.status).toBe('unavailable')
    expect(refused.instanceType).toBeNull()

    const badProto = await probeEc2ImdsV2({ baseUrl: 'file:///etc/passwd', timeoutMs: 500 })
    expect(badProto.available).toBe(false)
    expect(badProto.status).toBe('unavailable')
    expect(badProto.error).toContain('Unsupported IMDS protocol')
  })

  it('respects skip option, AWS_EC2_METADATA_DISABLED, and AWS_EC2_METADATA_SERVICE_ENDPOINT', async () => {
    let hitCount = 0
    const { baseUrl } = await startMockServer((req, res) => {
      hitCount++
      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        res.writeHead(200)
        res.end('env-tok')
        return
      }
      if (req.url === '/latest/meta-data/instance-type') {
        res.writeHead(200)
        res.end('t3.small')
        return
      }
      res.writeHead(404)
      res.end()
    })

    const skipped = await probeEc2ImdsV2({ baseUrl, skip: true })
    expect(skipped.status).toBe('skipped')
    expect(skipped.available).toBe(false)
    expect(hitCount).toBe(0)

    const disabled = await probeEc2ImdsV2({
      baseUrl,
      env: { AWS_EC2_METADATA_DISABLED: 'true' },
    })
    expect(disabled.status).toBe('disabled')
    expect(disabled.available).toBe(false)
    expect(hitCount).toBe(0)

    const fromEnv = await probeEc2ImdsV2({
      env: { AWS_EC2_METADATA_SERVICE_ENDPOINT: baseUrl },
      timeoutMs: 1000,
    })
    expect(fromEnv.available).toBe(true)
    expect(fromEnv.instanceType).toBe('t3.small')
    expect(hitCount).toBeGreaterThan(0)
  })

  it('caps oversized metadata responses safely without crashing', async () => {
    const { baseUrl } = await startMockServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        res.writeHead(200)
        res.end('tok-cap')
        return
      }
      if (req.url === '/latest/meta-data/instance-type') {
        res.writeHead(200)
        res.end('a'.repeat(50_000))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const meta = await probeEc2ImdsV2({ baseUrl, timeoutMs: 1000 })
    expect(meta.available).toBe(true)
    expect(meta.instanceType?.length).toBeLessThanOrEqual(4096)
  })
})

describe('doctor IMDSv2 integration', () => {
  it('includes IMDSv2 metadata in runDoctorAsync report and strict 7-bit ASCII output', async () => {
    const { baseUrl } = await startMockServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        res.writeHead(200)
        res.end('doc-tok')
        return
      }
      if (req.headers['x-aws-ec2-metadata-token'] !== 'doc-tok') {
        res.writeHead(401)
        res.end()
        return
      }
      const map: Record<string, string> = {
        '/latest/meta-data/instance-type': 't4g.small',
        '/latest/meta-data/placement/region': 'us-west-2',
        '/latest/meta-data/placement/availability-zone': 'us-west-2a',
        '/latest/meta-data/instance-id': 'i-0987654321fedcba0',
        '/latest/meta-data/ami-id': 'ami-0123456789abcdef0',
      }
      const body = map[req.url ?? '']
      if (body) {
        res.writeHead(200)
        res.end(body)
        return
      }
      res.writeHead(404)
      res.end()
    })

    const report = await runDoctorAsync({ imds: { baseUrl, timeoutMs: 1000 } })
    expect(report.ec2Hint).toBe(true)
    expect(report.ec2Imds?.available).toBe(true)
    expect(report.ec2Imds?.instanceType).toBe('t4g.small')
    expect(report.ec2Imds?.region).toBe('us-west-2')
    expect(report.ec2Imds?.availabilityZone).toBe('us-west-2a')

    const ascii = formatDoctorAscii(report)
    expect(ascii).toContain('EC2 IMDSv2')
    expect(ascii).toContain('t4g.small | us-west-2 | AZ us-west-2a')
    expect(ascii).toContain('i-0987654321fedcba0 (ami-0123456789abcdef0)')
    // Strict 7-bit ASCII check
    expect(/^[\x09\x0a\x0d\x20-\x7e]+$/.test(ascii)).toBe(true)
  })

  it('succeeds cleanly outside AWS when IMDSv2 is skipped or unreachable', async () => {
    const skippedReport = await runDoctorAsync({ imds: { skip: true } })
    expect(skippedReport.ec2Imds?.available).toBe(false)
    expect(skippedReport.ec2Imds?.status).toBe('skipped')

    const ascii = formatDoctorAscii(skippedReport)
    expect(ascii).toContain('EC2 IMDSv2    : not available (skipped)')
    expect(/^[\x09\x0a\x0d\x20-\x7e]+$/.test(ascii)).toBe(true)

    const syncReport = runDoctor()
    expect(syncReport.ec2Imds).toBeNull()
    expect(formatDoctorAscii(syncReport)).not.toContain('EC2 IMDSv2')
  })
})
