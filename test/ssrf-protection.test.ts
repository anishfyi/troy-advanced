import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import {
  SsrfGuard,
  checkUrlSsrf,
  checkUrlSsrfSync,
  classifyIp,
  parseIpv4ToUint32,
  parseIpv6ToGroups,
} from '../src/agent/ssrf.js'
import { authorizeAction } from '../src/agent/policy.js'
import { BrowserManager } from '../src/engine/manager.js'
import { CdpTrackerBlocker, type CdpLike } from '../src/engine/tracker-blocker.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'

const execFileAsync = promisify(execFile)

describe('SSRF protection (`--block-private-net`)', () => {
  const servers: http.Server[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-ssrf-test-'))
    tempDirs.push(dir)
    return dir
  }

  it('classifies AWS IMDS, loopback, RFC1918, link-local, CGNAT, ULA, and bypass encodings', () => {
    // AWS / Cloud IMDS
    expect(classifyIp('169.254.169.254')).toMatchObject({ blocked: true, category: 'imds' })
    expect(classifyIp('169.254.170.2')).toMatchObject({ blocked: true, category: 'imds' })
    expect(classifyIp('169.254.169.253')).toMatchObject({ blocked: true, category: 'imds' })
    expect(classifyIp('fd00:ec2::254')).toMatchObject({ blocked: true, category: 'imds' })

    // Classic SSRF IPv4 bypass encodings
    expect(parseIpv4ToUint32('2852039166')).toBe(0xa9fea9fe)
    expect(classifyIp('2852039166')).toMatchObject({ blocked: true, category: 'imds', normalizedIp: '169.254.169.254' })
    expect(classifyIp('0xa9fea9fe')).toMatchObject({ blocked: true, category: 'imds', normalizedIp: '169.254.169.254' })
    expect(classifyIp('0251.0376.0251.0376')).toMatchObject({ blocked: true, category: 'imds', normalizedIp: '169.254.169.254' })
    expect(classifyIp('2130706433')).toMatchObject({ blocked: true, category: 'loopback', normalizedIp: '127.0.0.1' })
    expect(classifyIp('0177.0.0.1')).toMatchObject({ blocked: true, category: 'loopback', normalizedIp: '127.0.0.1' })
    expect(classifyIp('127.1')).toMatchObject({ blocked: true, category: 'loopback', normalizedIp: '127.0.0.1' })
    expect(classifyIp('10.1')).toMatchObject({ blocked: true, category: 'private-ipv4', normalizedIp: '10.0.0.1' })

    // RFC1918, loopback, unspecified, link-local, CGNAT, multicast
    expect(classifyIp('10.0.0.1')).toMatchObject({ blocked: true, category: 'private-ipv4' })
    expect(classifyIp('172.16.0.1')).toMatchObject({ blocked: true, category: 'private-ipv4' })
    expect(classifyIp('172.31.255.254')).toMatchObject({ blocked: true, category: 'private-ipv4' })
    expect(classifyIp('192.168.1.1')).toMatchObject({ blocked: true, category: 'private-ipv4' })
    expect(classifyIp('127.0.0.1')).toMatchObject({ blocked: true, category: 'loopback' })
    expect(classifyIp('0.0.0.0')).toMatchObject({ blocked: true, category: 'unspecified' })
    expect(classifyIp('169.254.1.2')).toMatchObject({ blocked: true, category: 'link-local' })
    expect(classifyIp('100.64.0.1')).toMatchObject({ blocked: true, category: 'cgnat' })
    expect(classifyIp('100.100.100.200')).toMatchObject({ blocked: true, category: 'cgnat' })
    expect(classifyIp('224.0.0.1')).toMatchObject({ blocked: true, category: 'multicast-reserved' })

    // IPv6 loopback, ULA, link-local, IPv4-mapped, NAT64
    expect(parseIpv6ToGroups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(classifyIp('::1')).toMatchObject({ blocked: true, category: 'loopback' })
    expect(classifyIp('::')).toMatchObject({ blocked: true, category: 'unspecified' })
    expect(classifyIp('fc00::1')).toMatchObject({ blocked: true, category: 'ipv6-private' })
    expect(classifyIp('fd12:3456::1')).toMatchObject({ blocked: true, category: 'ipv6-private' })
    expect(classifyIp('fe80::1%eth0')).toMatchObject({ blocked: true, category: 'link-local' })
    expect(classifyIp('::ffff:169.254.169.254')).toMatchObject({ blocked: true, category: 'imds' })
    expect(classifyIp('::ffff:a9fe:a9fe')).toMatchObject({ blocked: true, category: 'imds' })
    expect(classifyIp('::ffff:127.0.0.1')).toMatchObject({ blocked: true, category: 'ipv6-mapped-ipv4' })
    expect(classifyIp('::ffff:10.0.0.1')).toMatchObject({ blocked: true, category: 'ipv6-mapped-ipv4' })
    expect(classifyIp('64:ff9b::169.254.169.254')).toMatchObject({ blocked: true, category: 'imds' })

    // Public IPs are allowed
    expect(classifyIp('1.1.1.1')).toMatchObject({ isIpLiteral: true, blocked: false })
    expect(classifyIp('8.8.8.8')).toMatchObject({ isIpLiteral: true, blocked: false })
    expect(classifyIp('93.184.216.34')).toMatchObject({ isIpLiteral: true, blocked: false })
    expect(classifyIp('172.15.0.1')).toMatchObject({ isIpLiteral: true, blocked: false })
    expect(classifyIp('172.32.0.1')).toMatchObject({ isIpLiteral: true, blocked: false })
    expect(classifyIp('192.167.1.1')).toMatchObject({ isIpLiteral: true, blocked: false })
    expect(classifyIp('2606:2800:220:1:248:1893:25c8:1946')).toMatchObject({ isIpLiteral: true, blocked: false })
  })

  it('blocks cloud metadata & localhost hostnames and respects disabled/allowHosts options', () => {
    // Disabled by default
    expect(checkUrlSsrfSync('http://169.254.169.254/latest/meta-data/').allowed).toBe(true)
    expect(checkUrlSsrfSync('http://127.0.0.1:8080/').allowed).toBe(true)

    const opts = { enabled: true }
    expect(checkUrlSsrfSync('http://169.254.169.254/latest/meta-data/', opts)).toMatchObject({
      blocked: true,
      category: 'imds',
    })
    expect(checkUrlSsrfSync('http://[::ffff:169.254.169.254]/latest/meta-data/', opts)).toMatchObject({
      blocked: true,
      category: 'imds',
    })
    expect(checkUrlSsrfSync('http://[fd00:ec2::254]/latest/meta-data/', opts)).toMatchObject({
      blocked: true,
      category: 'imds',
    })
    expect(checkUrlSsrfSync('http://localhost:3000/', opts)).toMatchObject({
      blocked: true,
      category: 'loopback',
    })
    expect(checkUrlSsrfSync('http://app.localhost./', opts)).toMatchObject({
      blocked: true,
      category: 'loopback',
    })
    expect(checkUrlSsrfSync('http://metadata.google.internal/computeMetadata/v1/', opts)).toMatchObject({
      blocked: true,
      category: 'metadata-host',
    })
    expect(checkUrlSsrfSync('http://instance-data.ec2.internal/', opts)).toMatchObject({
      blocked: true,
      category: 'metadata-host',
    })
    expect(checkUrlSsrfSync('https://example.com/docs', opts)).toMatchObject({
      allowed: true,
      blocked: false,
    })

    // allowHosts bypass
    expect(
      checkUrlSsrfSync('http://127.0.0.1:8080/test', { enabled: true, allowHosts: ['127.0.0.1'] }),
    ).toMatchObject({ allowed: true, blocked: false })
  })

  it('blocks DNS-rebinding hostnames resolving to IMDS or private IPs', async () => {
    const mockLookup = async (hostname: string) => {
      if (hostname === 'rebind-imds.example') {
        return [{ address: '169.254.169.254', family: 4 as const }]
      }
      if (hostname === 'dual-stack.example') {
        return [
          { address: '93.184.216.34', family: 4 as const },
          { address: '10.0.0.42', family: 4 as const },
        ]
      }
      return [{ address: '93.184.216.34', family: 4 as const }]
    }

    const r1 = await checkUrlSsrf('http://rebind-imds.example/latest/meta-data/', {
      enabled: true,
      dnsLookup: mockLookup,
    })
    expect(r1).toMatchObject({ blocked: true, category: 'imds', ip: '169.254.169.254' })

    const r2 = await checkUrlSsrf('https://dual-stack.example/api', {
      enabled: true,
      dnsLookup: mockLookup,
    })
    expect(r2).toMatchObject({ blocked: true, category: 'dns-rebinding', ip: '10.0.0.42' })

    const r3 = await checkUrlSsrf('https://public.example/page', {
      enabled: true,
      dnsLookup: mockLookup,
    })
    expect(r3).toMatchObject({ allowed: true, blocked: false })
  })

  it('enforces SSRF checks in authorizeAction policy for navigate and link clicks', () => {
    const navImds = authorizeAction({
      name: 'page_navigate',
      targetUrl: 'http://169.254.169.254/latest/meta-data/',
      allowedOrigins: ['http://169.254.169.254'],
      blockPrivateNet: true,
    })
    expect(navImds).toMatchObject({ allowed: false, status: 'blocked', code: 'ssrf' })

    const clickPrivate = authorizeAction({
      name: 'page_click',
      item: { tag: 'a', text: 'Internal Admin', href: 'http://10.0.0.5/admin' },
      allowedOrigins: ['http://10.0.0.5'],
      blockPrivateNet: true,
    })
    expect(clickPrivate).toMatchObject({ allowed: false, status: 'blocked', code: 'ssrf' })
  })

  it('blocks direct private/IMDS tabs, 302 redirects, meta-refresh redirects, and origin grants in BrowserManager + Lite', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/public') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><html><head><title>Public</title></head><body>
          <h1>Public Page</h1>
          <a href="http://169.254.169.254/latest/meta-data/">IMDS Link</a>
          <a href="/redir-imds">Redirect to IMDS</a>
        </body></html>`)
        return
      }
      if (req.url === '/redir-imds') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' })
        res.end()
        return
      }
      if (req.url === '/meta-redir') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><html><head>
          <meta http-equiv="refresh" content="0;url=http://10.0.0.1/secret">
          <title>Meta Redirect</title>
        </head><body>Redirecting...</body></html>`)
        return
      }
      res.writeHead(404)
      res.end('Not found')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const baseUrl = `http://127.0.0.1:${port}`

    // 1. Strict block-private-net blocks loopback & IMDS directly
    const strictMgr = await BrowserManager.create({
      engine: 'lite',
      profileDir: makeTmpDir(),
      memoryEnabled: false,
      ssrf: { enabled: true },
    })
    try {
      const blockedLocal = await strictMgr.openTab(`${baseUrl}/public`, { activate: true })
      expect(blockedLocal).toMatchObject({ ok: false, status: 'blocked', code: 'ssrf' })

      const blockedImds = await strictMgr.openTab('http://169.254.169.254/latest/meta-data/', { activate: true })
      expect(blockedImds).toMatchObject({ ok: false, status: 'blocked', code: 'ssrf', category: 'imds' })

      const blockedGrant = strictMgr.grantOrigin('http://169.254.169.254')
      expect(blockedGrant).toMatchObject({ ok: false, status: 'blocked', code: 'ssrf' })

      const stats = strictMgr.getSsrfStats()
      expect(stats.enabled).toBe(true)
      expect(stats.blockedCount).toBeGreaterThanOrEqual(3)
      expect(stats.blockedByCategory.imds).toBeGreaterThanOrEqual(2)
      expect(stats.blockedByCategory.loopback).toBeGreaterThanOrEqual(1)
    } finally {
      await strictMgr.close()
    }

    // 2. Allow the test server host, verify 302 redirect & meta-refresh & click to IMDS/RFC1918 are blocked
    const mgr = await BrowserManager.create({
      engine: 'lite',
      profileDir: makeTmpDir(),
      memoryEnabled: false,
      ssrf: { enabled: true, allowHosts: ['127.0.0.1'] },
    })
    try {
      const opened = await mgr.openTab(`${baseUrl}/public`, { activate: true })
      expect(opened.ok).toBe(true)

      // Direct click on IMDS link refused by policy
      const readRes = await mgr.runTool(opened.id, 'page_read', {})
      expect(readRes.ok).toBe(true)
      const elements = (readRes.elements as Array<{ ref: string; text: string }>) ?? []
      const imdsLink = elements.find((e) => e.text.includes('IMDS Link'))
      expect(imdsLink).toBeDefined()
      const clickImds = await mgr.runTool(opened.id, 'page_click', { ref: imdsLink!.ref })
      expect(clickImds).toMatchObject({ ok: false, status: 'blocked', code: 'ssrf' })

      // 302 redirect to AWS IMDS blocked mid-flight by LiteTab
      const redirRes = await mgr.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/redir-imds` })
      expect(redirRes).toMatchObject({ ok: false, status: 'blocked', code: 'ssrf', category: 'imds' })

      // <meta http-equiv="refresh"> to RFC1918 10.0.0.1 blocked mid-flight
      const metaRes = await mgr.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/meta-redir` })
      expect(metaRes).toMatchObject({ ok: false, status: 'blocked', code: 'ssrf', category: 'private-ipv4' })

      // Verify network logs recorded blockedReason: 'ssrf:imds'
      const netRes = await mgr.runTool(opened.id, 'page_network', { blockedOnly: true })
      expect(netRes.ok).toBe(true)
      const entries = (netRes.entries as Array<{ blocked?: boolean; blockedReason?: string }>) ?? []
      expect(entries.some((e) => e.blocked && e.blockedReason === 'ssrf:imds')).toBe(true)
      expect(entries.some((e) => e.blocked && e.blockedReason === 'ssrf:private-ipv4')).toBe(true)

      // Verify /health exposes ssrf stats
      const socket = await createAgentSocket(mgr, { port: 0 })
      try {
        const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
          headers: { 'x-troy-agent': socket.token },
        })
        const health = (await healthRes.json()) as { ok: boolean; ssrf?: { enabled: boolean; blockedCount: number } }
        expect(health.ok).toBe(true)
        expect(health.ssrf?.enabled).toBe(true)
        expect(health.ssrf!.blockedCount).toBeGreaterThanOrEqual(2)
      } finally {
        await socket.close()
      }
    } finally {
      await mgr.close()
    }
  })

  it('intercepts and fails private/IMDS requests in CdpTrackerBlocker when ssrfGuard is enabled', async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => void>()
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
    const mockCdp: CdpLike = {
      on(method, handler) {
        handlers.set(method, handler)
        return () => handlers.delete(method)
      },
      async send(method, params) {
        sent.push({ method, params })
        return {}
      },
    }

    const ssrfBlockedEvents: Array<{ url: string; category: string }> = []
    const ssrfGuard = new SsrfGuard({
      enabled: true,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    const blocker = new CdpTrackerBlocker(
      mockCdp,
      { enabled: false },
      { onSsrfBlocked: (ev) => ssrfBlockedEvents.push({ url: ev.url, category: ev.category }) },
      ssrfGuard,
    )

    await blocker.enable()
    expect(sent[0]).toEqual({
      method: 'Fetch.enable',
      params: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
    })

    const onPaused = handlers.get('Fetch.requestPaused')
    expect(onPaused).toBeDefined()

    // Trigger IMDS request
    onPaused!({ requestId: 'r-imds', request: { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' } })
    // Trigger RFC1918 request
    onPaused!({ requestId: 'r-priv', request: { url: 'http://10.0.0.1/internal', method: 'GET' } })
    // Trigger public request
    onPaused!({ requestId: 'r-pub', request: { url: 'https://example.com/app.js', method: 'GET' } })

    await new Promise((r) => setTimeout(r, 30))

    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'r-imds', errorReason: 'BlockedByClient' },
    })
    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'r-priv', errorReason: 'BlockedByClient' },
    })
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: 'r-pub' },
    })
    expect(ssrfBlockedEvents).toEqual([
      { url: 'http://169.254.169.254/latest/meta-data/', category: 'imds' },
      { url: 'http://10.0.0.1/internal', category: 'private-ipv4' },
    ])
  })

  it('refuses IMDS URL via CLI --block-private-net flag', async () => {
    const binPath = path.resolve('bin/troy-advanced.mjs')
    let stderr = ''
    let exitCode = 0
    try {
      await execFileAsync(process.execPath, [
        binPath,
        'ascii',
        'http://169.254.169.254/latest/meta-data/',
        '--engine',
        'lite',
        '--block-private-net',
        '--endpoint',
        path.join(makeTmpDir(), 'nonexistent-endpoint.json'),
      ])
    } catch (err) {
      const e = err as { code?: number; stderr?: string }
      exitCode = e.code ?? 1
      stderr = e.stderr ?? ''
    }
    expect(exitCode).toBe(1)
    expect(stderr).toContain('"code": "ssrf"')
    expect(stderr).toContain('"category": "imds"')
  })
})
