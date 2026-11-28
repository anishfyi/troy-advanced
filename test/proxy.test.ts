import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import {
  BrowserManager,
  ChromiumBrowserEngine,
  LiteBrowserEngine,
  buildChromiumProxyArgs,
  findChromeBinary,
  openHttpConnectTunnel,
  parseBypassList,
  parseProxyUrl,
  proxiedFetch,
  redactProxyUrl,
  resolveProxyConfig,
  selectProxyForUrl,
  shouldBypassProxy,
  summarizeProxyConfig,
} from '../src/index.js'

const closers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (closers.length > 0) {
    const fn = closers.pop()
    try {
      await fn?.()
    } catch {
      // ignore cleanup errors
    }
  }
})

function startHttpServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      closers.push(
        () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          }),
      )
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

/**
 * Minimal RFC 1928 + RFC 1929 SOCKS5 proxy server for deterministic local testing.
 */
function startSocks5Server(opts: {
  username?: string
  password?: string
} = {}): Promise<{
  server: net.Server
  port: number
  connections: Array<{ host: string; port: number; authedUser?: string }>
}> {
  const requireAuth = opts.username !== undefined || opts.password !== undefined
  const connections: Array<{ host: string; port: number; authedUser?: string }> = []

  return new Promise((resolve, reject) => {
    const activeSockets = new Set<net.Socket>()
    const server = net.createServer((client) => {
      activeSockets.add(client)
      client.on('close', () => activeSockets.delete(client))
      let state: 'greeting' | 'auth' | 'request' | 'relay' = 'greeting'
      let buf = Buffer.alloc(0)
      let upstream: net.Socket | null = null
      let authedUser: string | undefined

      const processBuffer = () => {
        if (state === 'greeting') {
          if (buf.length < 2) return
          const nMethods = buf[1] ?? 0
          if (buf.length < 2 + nMethods) return
          const methods = Array.from(buf.subarray(2, 2 + nMethods))
          buf = buf.subarray(2 + nMethods)

          if (requireAuth) {
            if (!methods.includes(0x02)) {
              client.end(Buffer.from([0x05, 0xff]))
              return
            }
            client.write(Buffer.from([0x05, 0x02]))
            state = 'auth'
          } else {
            if (!methods.includes(0x00)) {
              client.end(Buffer.from([0x05, 0xff]))
              return
            }
            client.write(Buffer.from([0x05, 0x00]))
            state = 'request'
          }
          processBuffer()
          return
        }

        if (state === 'auth') {
          if (buf.length < 2) return
          const uLen = buf[1] ?? 0
          if (buf.length < 2 + uLen + 1) return
          const pLen = buf[2 + uLen] ?? 0
          if (buf.length < 3 + uLen + pLen) return
          const user = buf.subarray(2, 2 + uLen).toString('utf8')
          const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8')
          buf = buf.subarray(3 + uLen + pLen)

          if (user === (opts.username ?? '') && pass === (opts.password ?? '')) {
            authedUser = user
            client.write(Buffer.from([0x01, 0x00]))
            state = 'request'
            processBuffer()
          } else {
            client.end(Buffer.from([0x01, 0x01]))
          }
          return
        }

        if (state === 'request') {
          if (buf.length < 4) return
          const atyp = buf[3] ?? 0
          let targetHost = ''
          let offset = 4
          if (atyp === 0x01) {
            if (buf.length < 10) return
            targetHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
            offset = 8
          } else if (atyp === 0x03) {
            if (buf.length < 5) return
            const len = buf[4] ?? 0
            if (buf.length < 5 + len + 2) return
            targetHost = buf.subarray(5, 5 + len).toString('utf8')
            offset = 5 + len
          } else {
            client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            return
          }
          const targetPort = buf.readUInt16BE(offset)
          buf = buf.subarray(offset + 2)
          state = 'relay'

          connections.push({ host: targetHost, port: targetPort, authedUser })
          upstream = net.connect({ host: targetHost, port: targetPort }, () => {
            activeSockets.add(upstream!)
            upstream!.on('close', () => activeSockets.delete(upstream!))
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
            if (buf.length > 0) {
              upstream?.write(buf)
              buf = Buffer.alloc(0)
            }
            client.pipe(upstream!)
            upstream!.pipe(client)
          })
          upstream.on('error', () => {
            try {
              client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            } catch {
              // ignore
            }
          })
        }
      }

      client.on('data', (chunk) => {
        if (state === 'relay') return
        buf = Buffer.concat([buf, chunk])
        processBuffer()
      })
      client.on('error', () => {
        upstream?.destroy()
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      closers.push(
        () =>
          new Promise<void>((r) => {
            for (const s of activeSockets) s.destroy()
            server.close(() => r())
          }),
      )
      resolve({ server, port: addr.port, connections })
    })
  })
}

describe('Proxy URL parsing, env resolution & Chromium args (M89)', () => {
  it('parses http, https, socks5, socks5h URLs with defaults, IPv6, and redacted displayUrl', () => {
    const httpEp = parseProxyUrl('http://proxy.internal:8080')
    expect(httpEp.scheme).toBe('http')
    expect(httpEp.hostname).toBe('proxy.internal')
    expect(httpEp.port).toBe(8080)
    expect(httpEp.hasAuth).toBe(false)
    expect(httpEp.chromiumServer).toBe('http://proxy.internal:8080')
    expect(httpEp.displayUrl).toBe('http://proxy.internal:8080')

    const authed = parseProxyUrl('https://alice:s3cr3t%21@proxy.corp.local:8443')
    expect(authed.scheme).toBe('https')
    expect(authed.username).toBe('alice')
    expect(authed.password).toBe('s3cr3t!')
    expect(authed.hasAuth).toBe(true)
    expect(authed.displayUrl).toBe('https://alice:***@proxy.corp.local:8443')
    expect(authed.chromiumServer).toBe('https://proxy.corp.local:8443')

    const socks5h = parseProxyUrl('socks5h://127.0.0.1')
    expect(socks5h.scheme).toBe('socks5h')
    expect(socks5h.port).toBe(1080)
    expect(socks5h.chromiumServer).toBe('socks5://127.0.0.1:1080')

    const ipv6 = parseProxyUrl('socks5://[::1]:1081')
    expect(ipv6.hostname).toBe('::1')
    expect(ipv6.port).toBe(1081)
    expect(ipv6.chromiumServer).toBe('socks5://[::1]:1081')

    expect(redactProxyUrl('http://bob:hunter2@proxy.local:3128')).toBe('http://bob:***@proxy.local:3128')
  })

  it('rejects empty, scheme-less, unsupported, and malformed proxy URLs', () => {
    expect(() => parseProxyUrl('')).toThrow(/empty/i)
    expect(() => parseProxyUrl('proxy.local:8080')).toThrow(/missing scheme/i)
    expect(() => parseProxyUrl('ftp://proxy.local:21')).toThrow(/unsupported proxy scheme/i)
    expect(() => parseProxyUrl('http://:8080')).toThrow(/invalid proxy url/i)
  })

  it('resolves HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY, and explicit --proxy override', () => {
    const env = {
      HTTP_PROXY: 'http://http-proxy.local:8080',
      HTTPS_PROXY: 'http://https-proxy.local:8443',
      NO_PROXY: 'localhost, 127.0.0.1, .internal.corp, api.example.com:9000',
    }

    const fromEnv = resolveProxyConfig(undefined, env)
    expect(fromEnv.enabled).toBe(true)
    expect(fromEnv.source).toBe('env')
    expect(selectProxyForUrl('http://example.com/page', fromEnv)?.hostname).toBe('http-proxy.local')
    expect(selectProxyForUrl('https://example.com/page', fromEnv)?.hostname).toBe('https-proxy.local')
    expect(selectProxyForUrl('http://localhost:3000', fromEnv)).toBeNull()
    expect(selectProxyForUrl('https://svc.internal.corp/health', fromEnv)).toBeNull()
    expect(selectProxyForUrl('http://api.example.com:9000/v1', fromEnv)).toBeNull()
    expect(selectProxyForUrl('http://api.example.com:8080/v1', fromEnv)?.hostname).toBe('http-proxy.local')
    expect(selectProxyForUrl('data:text/html,hi', fromEnv)).toBeNull()

    // Explicit --proxy overrides env vars for both HTTP and HTTPS
    const overridden = resolveProxyConfig({ server: 'socks5://127.0.0.1:1080' }, env)
    expect(overridden.source).toBe('cli')
    expect(selectProxyForUrl('http://example.com', overridden)?.scheme).toBe('socks5')
    expect(selectProxyForUrl('https://example.com', overridden)?.scheme).toBe('socks5')

    // useEnv: false ignores env vars completely
    const disabled = resolveProxyConfig({ useEnv: false }, env)
    expect(disabled.enabled).toBe(false)
    expect(disabled.source).toBe('none')
    expect(selectProxyForUrl('http://example.com', disabled)).toBeNull()
  })

  it('builds accurate Chromium --proxy-server and --proxy-bypass-list arguments', () => {
    const single = resolveProxyConfig({
      server: 'socks5h://user:pass@127.0.0.1:1080',
      bypass: ['localhost', '*.internal'],
      useEnv: false,
    })
    expect(buildChromiumProxyArgs(single)).toEqual([
      '--proxy-server=socks5://127.0.0.1:1080',
      '--proxy-bypass-list=localhost;*.internal',
    ])

    const split = resolveProxyConfig(undefined, {
      HTTP_PROXY: 'http://p1.local:8080',
      HTTPS_PROXY: 'http://p2.local:8443',
      NO_PROXY: '127.0.0.1,localhost',
    })
    expect(buildChromiumProxyArgs(split)).toEqual([
      '--proxy-server=http=http://p1.local:8080;https=http://p2.local:8443',
      '--proxy-bypass-list=127.0.0.1;localhost',
    ])

    expect(buildChromiumProxyArgs(resolveProxyConfig({ useEnv: false }, {}))).toEqual([])
    expect(parseBypassList('a.com, b.com; c.com a.com')).toEqual(['a.com', 'b.com', 'c.com'])
    expect(shouldBypassProxy('http://sub.example.com', ['*.example.com'])).toBe(true)
    expect(shouldBypassProxy('http://anything.test', ['*'])).toBe(true)
  })
})

describe('Lite engine HTTP forward proxy, gzip, cookies & bypass (M89)', () => {
  it('routes Lite requests through an authenticated HTTP proxy, preserves cookies, decompresses gzip, and redacts credentials', async () => {
    const target = await startHttpServer((req, res) => {
      if (req.url === '/gzip') {
        const html = '<html><head><title>Proxied Gzip</title></head><body><h1>Via HTTP Proxy</h1><a href="/next">Next</a></body></html>'
        const compressed = zlib.gzipSync(Buffer.from(html, 'utf8'))
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Set-Cookie': 'sid=proxied123; Path=/',
        })
        res.end(compressed)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><head><title>Echo</title></head><body><p>cookie=${req.headers.cookie ?? 'none'}</p></body></html>`)
    })

    const proxySeen: Array<{ url: string; auth?: string }> = []
    const proxyServer = await startHttpServer((req, res) => {
      proxySeen.push({
        url: req.url ?? '',
        auth: req.headers['proxy-authorization'],
      })
      const expectedAuth = `Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`
      if (req.headers['proxy-authorization'] !== expectedAuth) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' })
        res.end('Proxy Auth Required')
        return
      }
      const upstreamUrl = new URL(req.url!)
      const forwardHeaders = { ...req.headers }
      delete forwardHeaders['proxy-authorization']
      const upstreamReq = http.request(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port,
          path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
          method: req.method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
        },
      )
      req.pipe(upstreamReq)
    })

    const manager = await BrowserManager.create({
      engine: 'lite',
      memoryEnabled: false,
      proxy: {
        server: `http://alice:s3cr3t@127.0.0.1:${proxyServer.port}`,
        useEnv: false,
      },
    })
    closers.push(() => manager.close())

    const info = manager.getProxyInfo()
    expect(info.enabled).toBe(true)
    expect(info.hasAuth).toBe(true)
    expect(info.server).toBe(`http://alice:***@127.0.0.1:${proxyServer.port}`)
    expect(info.server).not.toContain('s3cr3t')

    const tab = await manager.openTab(`${target.url}/gzip`)
    const read = await manager.renderAscii(tab.id)
    expect(read.ascii).toContain('VIA HTTP PROXY')
    expect(proxySeen).toHaveLength(1)
    expect(proxySeen[0]?.url).toBe(`${target.url}/gzip`)

    // Follow-up navigation in a second tab shares CookieJar and sends stored cookie through the proxy
    const tab2 = await manager.openTab(`${target.url}/echo`)
    const read2 = await manager.renderAscii(tab2.id)
    expect(read2.ascii).toContain('cookie=sid=proxied123')
    expect(proxySeen).toHaveLength(2)
  })

  it('automatically honors HTTP_PROXY environment variable in Lite engine', async () => {
    const target = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title>Env Proxy</title></head><body><p>env-proxy-works</p></body></html>')
    })

    let envProxyHits = 0
    const proxyServer = await startHttpServer((req, res) => {
      envProxyHits += 1
      const upstreamUrl = new URL(req.url!)
      const upstreamReq = http.request(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port,
          path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
        },
      )
      req.pipe(upstreamReq)
    })

    const prevHttpProxy = process.env.HTTP_PROXY
    const prevNoProxy = process.env.NO_PROXY
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyServer.port}`
    delete process.env.NO_PROXY
    closers.push(() => {
      if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = prevHttpProxy
      if (prevNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = prevNoProxy
    })

    const engine = new LiteBrowserEngine()
    closers.push(() => engine.close())
    expect(engine.getProxyInfo().source).toBe('env')

    const tab = await engine.createTab(`${target.url}/from-env`)
    const snap = await tab.snapshot()
    expect(snap.title).toBe('Env Proxy')
    expect(envProxyHits).toBe(1)
  })

  it('bypasses the proxy when target matches --proxy-bypass / NO_PROXY', async () => {
    const target = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title>Direct</title></head><body><h1>Direct Bypass OK</h1></body></html>')
    })

    let proxyHits = 0
    const proxyServer = await startHttpServer((_req, res) => {
      proxyHits += 1
      res.writeHead(500)
      res.end('Should not have been called')
    })

    const engine = new LiteBrowserEngine({
      proxy: {
        server: `http://127.0.0.1:${proxyServer.port}`,
        bypass: ['127.0.0.1'],
        useEnv: false,
      },
    })
    closers.push(() => engine.close())

    const tab = await engine.createTab(`${target.url}/`)
    const snap = await tab.snapshot()
    expect(snap.title).toBe('Direct')
    expect(proxyHits).toBe(0)
  })

  it('establishes HTTP CONNECT tunnels and reports non-200 CONNECT failures clearly', async () => {
    const target = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('connect-ok')
    })

    const connectProxy = await startHttpServer((_req, res) => {
      res.writeHead(405)
      res.end()
    })
    connectProxy.server.on('connect', (req, clientSocket, head) => {
      if (req.headers['proxy-authorization'] === 'Basic YmFkOmNyZWRz') {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        clientSocket.end()
        return
      }
      const [host, portStr] = (req.url ?? '').split(':')
      const upstream = net.connect(Number(portStr), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
    })

    const ep = parseProxyUrl(`http://127.0.0.1:${connectProxy.port}`)
    const sock = await openHttpConnectTunnel(ep, '127.0.0.1', target.port, 5000)
    const responseText = await new Promise<string>((resolve, reject) => {
      let data = ''
      sock.on('data', (chunk) => {
        data += chunk.toString('utf8')
      })
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: close\r\n\r\n`)
    })
    expect(responseText).toContain('connect-ok')

    const badEp = parseProxyUrl(`http://bad:creds@127.0.0.1:${connectProxy.port}`)
    await expect(openHttpConnectTunnel(badEp, '127.0.0.1', target.port, 5000)).rejects.toThrow(/status 407/)
  })
})

describe('Lite engine SOCKS5 & SOCKS5h proxy transport (M89)', () => {
  it('routes Lite requests through a no-auth SOCKS5 proxy', async () => {
    const target = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title>SOCKS5 Page</title></head><body><h1>Hello over SOCKS5</h1></body></html>')
    })

    const socks = await startSocks5Server()
    const engine = new LiteBrowserEngine({
      proxy: { server: `socks5://127.0.0.1:${socks.port}`, useEnv: false },
    })
    closers.push(() => engine.close())

    const tab = await engine.createTab(`${target.url}/hello`)
    const snap = await tab.snapshot()
    expect(snap.title).toBe('SOCKS5 Page')
    expect(socks.connections).toHaveLength(1)
    expect(socks.connections[0]?.port).toBe(target.port)
  })

  it('supports RFC 1929 username/password auth over socks5h:// and rejects wrong credentials', async () => {
    const target = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title>Authed SOCKS5h</title></head><body><h1>Authenticated Tunnel</h1></body></html>')
    })

    const socks = await startSocks5Server({ username: 'bob', password: 'secret-password' })

    const okConfig = resolveProxyConfig({
      server: `socks5h://bob:secret-password@127.0.0.1:${socks.port}`,
      useEnv: false,
    })
    const res = await proxiedFetch(`${target.url}/`, { method: 'GET' }, okConfig)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Authenticated Tunnel')
    expect(socks.connections[0]?.authedUser).toBe('bob')
    expect(summarizeProxyConfig(okConfig).server).toBe(`socks5h://bob:***@127.0.0.1:${socks.port}`)

    const badConfig = resolveProxyConfig({
      server: `socks5h://bob:wrong-pass@127.0.0.1:${socks.port}`,
      useEnv: false,
    })
    await expect(proxiedFetch(`${target.url}/`, { method: 'GET' }, badConfig)).rejects.toThrow(
      /authentication failed/i,
    )
  })
})

describe('Chromium engine proxy E2E (M89)', () => {
  const hasChrome = Boolean(findChromeBinary())

  it.skipIf(!hasChrome)('launches Chromium with --proxy-server and routes page traffic through local HTTP proxy', async () => {
    const target = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title>Chromium Proxied</title></head><body><h1>Chrome Via Proxy</h1></body></html>')
    })

    const proxiedUrls: string[] = []
    const proxyServer = await startHttpServer((req, res) => {
      proxiedUrls.push(req.url ?? '')
      const upstreamUrl = new URL(req.url!)
      const upstreamReq = http.request(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port,
          path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
        },
      )
      req.pipe(upstreamReq)
    })

    const engine = await ChromiumBrowserEngine.launch({
      proxy: {
        server: `http://127.0.0.1:${proxyServer.port}`,
        bypass: ['<-loopback>'],
        useEnv: false,
      },
    })
    closers.push(() => engine.close())

    expect(engine.getProxyInfo().enabled).toBe(true)
    expect(engine.getProxyInfo().server).toBe(`http://127.0.0.1:${proxyServer.port}`)

    const tab = await engine.createTab(`${target.url}/chrome-proxy-test`)
    const snap = await tab.snapshot()
    expect(snap.title).toBe('Chromium Proxied')
    expect(proxiedUrls.some((u) => u.includes('/chrome-proxy-test'))).toBe(true)
  }, 20000)
})
