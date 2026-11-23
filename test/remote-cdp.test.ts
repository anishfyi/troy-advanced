import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  BrowserManager,
  CdpClient,
  CdpSessionClient,
  ChromiumBrowserEngine,
  createAgentSocket,
  discoverRemoteCdp,
  findChromeBinary,
  parseRemoteCdpUrl,
  rewriteCdpWebSocketUrl,
} from '../src/index.js'

describe('M30: Remote CDP proxy URL parsing & rewriting', () => {
  it('parses http:// and https:// base URLs and strips /json/version or /json/list', () => {
    const a = parseRemoteCdpUrl('http://10.0.1.42:9222/')
    expect(a.transport).toBe('http')
    expect(a.protocol).toBe('http')
    expect(a.hostname).toBe('10.0.1.42')
    expect(a.port).toBe(9222)
    expect(a.httpBaseUrl).toBe('http://10.0.1.42:9222')
    expect(a.displayUrl).toBe('http://10.0.1.42:9222')

    const b = parseRemoteCdpUrl('http://127.0.0.1:19222/json/version')
    expect(b.httpBaseUrl).toBe('http://127.0.0.1:19222')
    expect(b.basePath).toBe('')

    const c = parseRemoteCdpUrl('https://chrome.internal/cdp/json/list?token=supersecret&env=prod')
    expect(c.transport).toBe('http')
    expect(c.port).toBe(443)
    expect(c.httpBaseUrl).toBe('https://chrome.internal/cdp')
    expect(c.basePath).toBe('/cdp')
    expect(c.search).toBe('?token=supersecret&env=prod')
    expect(c.displayUrl).toContain('token=***')
    expect(c.displayUrl).toContain('env=prod')
    expect(c.displayUrl).not.toContain('supersecret')
  })

  it('extracts Basic auth credentials without leaking them in httpBaseUrl or displayUrl', () => {
    const parsed = parseRemoteCdpUrl('http://ec2user:s3cr3t@10.0.2.5:9222')
    expect(parsed.authHeader).toBe(`Basic ${Buffer.from('ec2user:s3cr3t', 'utf8').toString('base64')}`)
    expect(parsed.httpBaseUrl).toBe('http://10.0.2.5:9222')
    expect(parsed.displayUrl).toBe('http://10.0.2.5:9222')
    expect(parsed.displayUrl).not.toContain('s3cr3t')
  })

  it('parses ws:// and wss:// URLs and detects single-page /devtools/page/ targets', () => {
    const browserWs = parseRemoteCdpUrl('ws://10.0.1.42:9222/devtools/browser/1111-2222')
    expect(browserWs.transport).toBe('ws')
    expect(browserWs.port).toBe(9222)
    expect(browserWs.wsUrl).toBe('ws://10.0.1.42:9222/devtools/browser/1111-2222')
    expect(browserWs.isPageTargetWs).toBe(false)

    const secureWs = parseRemoteCdpUrl('wss://proxy.example.com/devtools/browser/abc?api_key=topsecret')
    expect(secureWs.transport).toBe('ws')
    expect(secureWs.port).toBe(443)
    expect(secureWs.displayUrl).not.toContain('topsecret')
    expect(secureWs.displayUrl).toContain('api_key=***')

    const pageWs = parseRemoteCdpUrl('ws://127.0.0.1:9222/devtools/page/TARGET123')
    expect(pageWs.isPageTargetWs).toBe(true)
  })

  it('rejects empty, malformed, and unsupported schemes', () => {
    expect(() => parseRemoteCdpUrl('')).toThrow(/cannot be empty/i)
    expect(() => parseRemoteCdpUrl('not a url')).toThrow(/Invalid remote CDP URL/i)
    expect(() => parseRemoteCdpUrl('ftp://10.0.1.42:9222')).toThrow(/Unsupported remote CDP URL scheme/i)
    expect(() => parseRemoteCdpUrl('file:///tmp/chrome')).toThrow(/Unsupported remote CDP URL scheme/i)
  })

  it('rewrites Chrome-reported webSocketDebuggerUrl for SSH tunnels and TLS reverse proxies', () => {
    // SSH tunnel: ssh -L 19222:127.0.0.1:9222 ec2-user@remote-node
    const tunnelCfg = parseRemoteCdpUrl('http://127.0.0.1:19222')
    expect(
      rewriteCdpWebSocketUrl('ws://127.0.0.1:9222/devtools/browser/abc-123', tunnelCfg),
    ).toBe('ws://127.0.0.1:19222/devtools/browser/abc-123')

    // HTTPS reverse proxy with path prefix + token query param
    const proxyCfg = parseRemoteCdpUrl('https://chrome.example.com:8443/cdp?token=tok123')
    expect(
      rewriteCdpWebSocketUrl('ws://172.17.0.2:9222/devtools/browser/xyz-999', proxyCfg),
    ).toBe('wss://chrome.example.com:8443/cdp/devtools/browser/xyz-999?token=tok123')

    // Avoids duplicating prefix if upstream already included it
    expect(
      rewriteCdpWebSocketUrl('ws://172.17.0.2:9222/cdp/devtools/browser/xyz-999', proxyCfg),
    ).toBe('wss://chrome.example.com:8443/cdp/devtools/browser/xyz-999?token=tok123')
  })

  it('discovers remote CDP over HTTP with auth header and rejects /devtools/page/ WS URLs', async () => {
    await expect(discoverRemoteCdp('ws://127.0.0.1:9222/devtools/page/PAGE1')).rejects.toThrow(
      /single page target/i,
    )

    const wsDirect = await discoverRemoteCdp('ws://10.0.1.99:9222/devtools/browser/direct-id')
    expect(wsDirect.browserWsUrl).toBe('ws://10.0.1.99:9222/devtools/browser/direct-id')
    expect(wsDirect.httpBaseUrl).toBeUndefined()

    // Mock HTTP /json/version endpoint behind a simulated proxy
    let receivedAuth: string | undefined
    const srv = http.createServer((req, res) => {
      receivedAuth = req.headers.authorization
      if (req.url?.startsWith('/cdp/json/version')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            Browser: 'Chrome/135.0.0.0',
            'Protocol-Version': '1.3',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock-uuid',
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as net.AddressInfo).port

    try {
      const discovered = await discoverRemoteCdp(`http://alice:pw@127.0.0.1:${port}/cdp`, { timeoutMs: 2000 })
      expect(receivedAuth).toBe(`Basic ${Buffer.from('alice:pw', 'utf8').toString('base64')}`)
      expect(discovered.browserWsUrl).toBe(`ws://127.0.0.1:${port}/cdp/devtools/browser/mock-uuid`)
      expect(discovered.browserVersion).toBe('Chrome/135.0.0.0')
      expect(discovered.protocolVersion).toBe('1.3')
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })
})

describe('M30: CdpSessionClient multiplexing and event isolation', () => {
  it('routes commands with sessionId, keeps Browser.* at root, isolates events, and tracks child OOPIF sessions', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
    const listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>()
    let parentClosed = false

    const fakeParent = {
      on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void) {
        let set = listeners.get(method)
        if (!set) {
          set = new Set()
          listeners.set(method, set)
        }
        set.add(handler)
        return () => set?.delete(handler)
      },
      async send<T extends Record<string, unknown>>(
        method: string,
        params: Record<string, unknown> = {},
        _timeoutMs?: number,
        sessionId?: string,
      ): Promise<T> {
        sent.push({ method, params, sessionId })
        return {} as T
      },
      sendToSession<T extends Record<string, unknown>>(
        sessionId: string | undefined,
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number,
      ): Promise<T> {
        return this.send<T>(method, params, timeoutMs, sessionId)
      },
      isClosed: () => parentClosed,
      close: async () => {
        parentClosed = true
      },
    } as unknown as CdpClient

    const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => {
      for (const fn of listeners.get(method) ?? []) {
        fn(params, sessionId)
      }
    }

    const s1 = new CdpSessionClient(fakeParent, 'SID-1')
    const s2 = new CdpSessionClient(fakeParent, 'SID-2')

    const s1Events: Array<{ method: string; sid?: string; url?: string }> = []
    const s2Events: Array<{ method: string; sid?: string; url?: string }> = []

    s1.on('Page.frameNavigated', (p, sid) => s1Events.push({ method: 'nav', sid, url: String(p.url) }))
    s2.on('Page.frameNavigated', (p, sid) => s2Events.push({ method: 'nav', sid, url: String(p.url) }))
    s1.on('Browser.downloadWillBegin', (p, sid) => s1Events.push({ method: 'dl', sid, url: String(p.url) }))

    await s1.send('Page.navigate', { url: 'https://a.test' })
    await s2.send('Page.navigate', { url: 'https://b.test' })
    await s1.send('Browser.setDownloadBehavior', { behavior: 'deny' })

    expect(sent).toEqual([
      { method: 'Page.navigate', params: { url: 'https://a.test' }, sessionId: 'SID-1' },
      { method: 'Page.navigate', params: { url: 'https://b.test' }, sessionId: 'SID-2' },
      { method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' }, sessionId: undefined },
    ])

    // Events for SID-1 must only reach s1 (with sessionId normalized to undefined)
    emit('Page.frameNavigated', { url: 'https://a.test' }, 'SID-1')
    emit('Page.frameNavigated', { url: 'https://b.test' }, 'SID-2')
    // Attach an OOPIF child session under SID-1
    emit('Target.attachedToTarget', { sessionId: 'OOPIF-1' }, 'SID-1')
    emit('Page.frameNavigated', { url: 'https://iframe.a.test' }, 'OOPIF-1')
    // Browser-level download event reaches listener
    emit('Browser.downloadWillBegin', { url: 'https://a.test/file.zip' }, undefined)

    expect(s1Events).toEqual([
      { method: 'nav', sid: undefined, url: 'https://a.test' },
      { method: 'nav', sid: 'OOPIF-1', url: 'https://iframe.a.test' },
      { method: 'dl', sid: undefined, url: 'https://a.test/file.zip' },
    ])
    expect(s2Events).toEqual([{ method: 'nav', sid: undefined, url: 'https://b.test' }])

    // Closing s1 detaches s1 without closing fakeParent or breaking s2
    await s1.close()
    expect(parentClosed).toBe(false)
    expect(s1.isClosed()).toBe(true)
    expect(s2.isClosed()).toBe(false)
    expect(sent.at(-1)).toEqual({
      method: 'Target.detachFromTarget',
      params: { sessionId: 'SID-1' },
      sessionId: undefined,
    })

    // Further events on SID-1 are ignored, while SID-2 still works
    emit('Page.frameNavigated', { url: 'https://a2.test' }, 'SID-1')
    emit('Page.frameNavigated', { url: 'https://b2.test' }, 'SID-2')
    expect(s1Events).toHaveLength(3)
    expect(s2Events).toHaveLength(2)
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('M30: Remote CDP proxy E2E (real Chrome behind SSH-style TCP tunnel)', () => {
  let hostChrome: ChromiumBrowserEngine
  let testSite: http.Server
  let testSiteUrl: string
  let tcpProxy: net.Server
  let tcpProxyPort: number
  let tempDir: string
  const proxySockets = new Set<net.Socket>()

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m30-remote-cdp-'))

    // Local test web app
    testSite = http.createServer((req, res) => {
      if (req.url === '/page-a') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html><head><title>Remote Alpha</title></head>
          <body>
            <h1>Alpha Node</h1>
            <form>
              <label for="note">Note</label>
              <input id="note" name="note" type="text" />
              <button type="button" id="apply" onclick="document.getElementById('out').textContent = 'Applied:' + document.getElementById('note').value">Apply</button>
            </form>
            <p id="out">Waiting</p>
          </body></html>`)
        return
      }
      if (req.url === '/page-b') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html><head><title>Remote Beta</title></head>
          <body><h1>Beta Node</h1><p>Isolated sibling tab over shared Browser WS</p></body></html>`)
        return
      }
      res.writeHead(404).end('not found')
    })
    await new Promise<void>((resolve) => testSite.listen(0, '127.0.0.1', resolve))
    testSiteUrl = `http://127.0.0.1:${(testSite.address() as net.AddressInfo).port}`

    // Launch a real "remote" Chrome instance
    hostChrome = await ChromiumBrowserEngine.launch({
      profileDir: path.join(tempDir, 'remote-chrome-profile'),
    })

    // Start a raw TCP port-forward proxy simulating `ssh -L <tcpProxyPort>:127.0.0.1:<chromePort>`
    // Crucially, Chrome still believes it is listening on hostChrome.cdpPort, NOT tcpProxyPort!
    tcpProxy = net.createServer((clientSocket) => {
      const upstream = net.connect(hostChrome.cdpPort, '127.0.0.1')
      proxySockets.add(clientSocket)
      proxySockets.add(upstream)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
      const cleanup = () => {
        proxySockets.delete(clientSocket)
        proxySockets.delete(upstream)
        clientSocket.destroy()
        upstream.destroy()
      }
      clientSocket.on('error', cleanup)
      upstream.on('error', cleanup)
      clientSocket.on('close', cleanup)
      upstream.on('close', cleanup)
    })
    await new Promise<void>((resolve) => tcpProxy.listen(0, '127.0.0.1', resolve))
    tcpProxyPort = (tcpProxy.address() as net.AddressInfo).port
  }, 30000)

  afterAll(async () => {
    for (const sock of proxySockets) {
      sock.destroy()
    }
    await new Promise<void>((resolve) => tcpProxy?.close(() => resolve()))
    await hostChrome?.close()
    await new Promise<void>((resolve) => testSite?.close(() => resolve()))
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('drives remote Chrome via --cdp-url http://127.0.0.1:<proxyPort> with WebSocket URL rewriting, multi-tab isolation, cookies, and /health metadata', async () => {
    const manager = await BrowserManager.create({
      cdpUrl: `http://127.0.0.1:${tcpProxyPort}`,
      profileDir: path.join(tempDir, 'client-http'),
      memoryEnabled: false,
    })

    const socket = await createAgentSocket(manager, { port: 0 })

    try {
      expect(manager.engine.kind).toBe('chromium')
      const remoteInfo = manager.engine.getRemoteCdpInfo?.()
      expect(remoteInfo).toBeTruthy()
      expect(remoteInfo?.transport).toBe('http')
      expect(remoteInfo?.displayUrl).toBe(`http://127.0.0.1:${tcpProxyPort}`)
      // Rewritten WS URL MUST go through the tunnel proxy port, not hostChrome.cdpPort
      expect(remoteInfo?.browserWsUrl).toContain(`ws://127.0.0.1:${tcpProxyPort}/devtools/browser/`)
      expect(remoteInfo?.browserVersion).toBeTruthy()

      // /health exposes remoteCdp metadata
      const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        method: 'POST',
        headers: { 'x-troy-agent': socket.token, 'content-type': 'application/json' },
        body: '{}',
      })
      const health = (await healthRes.json()) as { ok: boolean; remoteCdp?: { displayUrl?: string; transport?: string } }
      expect(health.ok).toBe(true)
      expect(health.remoteCdp?.displayUrl).toBe(`http://127.0.0.1:${tcpProxyPort}`)
      expect(health.remoteCdp?.transport).toBe('http')

      // Open two sibling tabs over the same remote Browser WebSocket
      const tabA = await manager.openTab(`${testSiteUrl}/page-a`, { activate: true })
      const tabB = await manager.openTab(`${testSiteUrl}/page-b`, { activate: false })
      expect(tabA.ok).toBe(true)
      expect(tabB.ok).toBe(true)

      const asciiA = await manager.runTool(tabA.id!, 'page_read_ascii', { width: 80 })
      const asciiB = await manager.runTool(tabB.id!, 'page_read_ascii', { width: 80 })
      expect(String(asciiA.ascii)).toContain('ALPHA NODE')
      expect(String(asciiA.ascii)).not.toContain('BETA NODE')
      expect(String(asciiB.ascii)).toContain('BETA NODE')
      expect(String(asciiB.ascii)).not.toContain('ALPHA NODE')

      // Interact with tabA via eN refs
      const foundInput = await manager.runTool(tabA.id!, 'page_find', { query: 'Note' })
      const inputRef = (foundInput.matches as Array<{ ref: string }>)[0]?.ref
      const foundBtn = await manager.runTool(tabA.id!, 'page_find', { query: 'Apply' })
      const btnRef = (foundBtn.matches as Array<{ ref: string }>)[0]?.ref
      expect(inputRef).toBeTruthy()
      expect(btnRef).toBeTruthy()

      await manager.runTool(tabA.id!, 'page_fill', { ref: inputRef, text: 'ec2-tunnel-ok' })
      await manager.runTool(tabA.id!, 'page_click', { ref: btnRef })

      const afterClick = await manager.runTool(tabA.id!, 'page_read_ascii', { width: 80 })
      expect(String(afterClick.ascii)).toContain('Applied:ec2-tunnel-ok')

      // Cookie import + export works over the persistent browserCdp WebSocket
      const imp = await manager.importCookies([
        { name: 'remote_session', value: 'tok_m30', domain: '127.0.0.1', path: '/' },
      ])
      expect(imp.imported).toBe(1)
      const exported = await manager.exportCookies({ domain: '127.0.0.1' })
      expect(exported.some((c) => c.name === 'remote_session' && c.value === 'tok_m30')).toBe(true)
    } finally {
      await socket.close()
      await manager.close()
    }

    // Remote Chrome MUST still be alive after client manager closes!
    const verRes = await fetch(`http://127.0.0.1:${hostChrome.cdpPort}/json/version`)
    expect(verRes.ok).toBe(true)
  }, 30000)

  it('drives remote Chrome via direct --cdp-url ws://127.0.0.1:<proxyPort>/devtools/browser/<id>', async () => {
    // Obtain the browser WebSocket path from Chrome and point it through tcpProxyPort
    const verRes = await fetch(`http://127.0.0.1:${hostChrome.cdpPort}/json/version`)
    const verJson = (await verRes.json()) as { webSocketDebuggerUrl: string }
    const directWsUrl = rewriteCdpWebSocketUrl(
      verJson.webSocketDebuggerUrl,
      parseRemoteCdpUrl(`http://127.0.0.1:${tcpProxyPort}`),
    )
    expect(directWsUrl.startsWith(`ws://127.0.0.1:${tcpProxyPort}/devtools/browser/`)).toBe(true)

    const manager = await BrowserManager.create({
      cdpUrl: directWsUrl,
      profileDir: path.join(tempDir, 'client-ws'),
      memoryEnabled: false,
    })

    try {
      expect(manager.engine.kind).toBe('chromium')
      const info = manager.engine.getRemoteCdpInfo?.()
      expect(info?.transport).toBe('ws')
      expect(info?.httpBaseUrl).toBeUndefined()
      expect(info?.browserWsUrl).toBe(directWsUrl)

      const opened = await manager.openTab(`${testSiteUrl}/page-b`, { activate: true })
      expect(opened.ok).toBe(true)
      const res = await manager.runTool(opened.id!, 'page_read_ascii', { width: 80 })
      expect(String(res.ascii)).toContain('BETA NODE')
    } finally {
      await manager.close()
    }

    // Remote Chrome MUST still be alive
    const stillUp = await fetch(`http://127.0.0.1:${hostChrome.cdpPort}/json/version`)
    expect(stillUp.ok).toBe(true)
  }, 30000)

  it('fails loudly instead of silently falling back to Lite when an explicit --cdp-url is unreachable', async () => {
    await expect(
      BrowserManager.create({
        engine: 'auto',
        cdpUrl: 'http://127.0.0.1:1',
        cdpConnectTimeoutMs: 400,
        profileDir: path.join(tempDir, 'client-fail'),
        memoryEnabled: false,
      }),
    ).rejects.toThrow(/did not respond/i)
  })
})
