import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'
import {
  validateHostHeader,
  validateOriginHeader,
  validateAgentRequestHeaders,
} from '../src/bridge/host-guard.js'

interface RawHttpResponse {
  statusLine: string
  statusCode: number
  headers: Record<string, string>
  body: string
}

/**
 * Send a raw HTTP/1.1 (or HTTP/1.0) request over TCP so we can test forged
 * Host headers, missing Host headers, malicious Origin headers, and CSWSH
 * WebSocket upgrades without fetch() normalizing or blocking headers.
 */
function sendRawHttp(port: number, rawRequest: string): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(rawRequest)
    })

    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new Error('raw HTTP request timed out'))
      }
    }, 3000)

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const raw = Buffer.concat(chunks).toString('utf8')
      const sepIdx = raw.indexOf('\r\n\r\n')
      const head = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw
      const body = sepIdx >= 0 ? raw.slice(sepIdx + 4) : ''
      const lines = head.split('\r\n')
      const statusLine = lines[0] ?? ''
      const statusCode = Number(statusLine.split(' ')[1] ?? 0)
      const headers: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':')
        if (idx > 0) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
        }
      }
      socket.destroy()
      resolve({ statusLine, statusCode, headers, body })
    }

    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      // For 101 Switching Protocols, close immediately once headers arrive
      if (text.startsWith('HTTP/1.1 101 ') && text.includes('\r\n\r\n')) {
        finish()
      }
    })
    socket.on('end', finish)
    socket.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })
  })
}

describe('M72: Strict DNS rebinding & Host/Origin header validation (unit)', () => {
  it('accepts exact loopback Host headers with or without valid port', () => {
    expect(validateHostHeader('127.0.0.1')).toEqual({ ok: true, host: '127.0.0.1' })
    expect(validateHostHeader('127.0.0.1:43210')).toEqual({ ok: true, host: '127.0.0.1', port: 43210 })
    expect(validateHostHeader('localhost')).toEqual({ ok: true, host: 'localhost' })
    expect(validateHostHeader('LOCALHOST:8080')).toEqual({ ok: true, host: 'localhost', port: 8080 })
    expect(validateHostHeader('[::1]')).toEqual({ ok: true, host: '[::1]' })
    expect(validateHostHeader('[::1]:65535')).toEqual({ ok: true, host: '[::1]', port: 65535 })
  })

  it('blocks classic DNS rebinding and prefix-bypass Host headers', () => {
    const attacks = [
      'localhost.evil.com',
      'localhost.evil.com:43210',
      '127.0.0.1.evil.com',
      '127.0.0.1.nip.io:43210',
      '127.0.0.1.xip.io',
      '[::1].evil.com',
      '[::1].evil.com:43210',
      'sub.localhost',
      'localhost.',
      'evil.example.com',
      '169.254.169.254',
      '0.0.0.0',
      '127.0.0.2',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      '[::ffff:127.0.0.1]',
      '::1',
    ]

    for (const host of attacks) {
      const res = validateHostHeader(host)
      expect(res.ok, `expected "${host}" to be rejected`).toBe(false)
    }
  })

  it('blocks malformed, smuggled, and invalid-port Host headers', () => {
    const malformed: Array<[string | string[] | undefined, string]> = [
      [undefined, 'missing_host'],
      ['', 'missing_host'],
      [['127.0.0.1:80', 'evil.com'], 'duplicate_host'],
      ['localhost@evil.com', 'invalid_host'],
      ['127.0.0.1:80@evil.com', 'invalid_host'],
      ['localhost/evil', 'invalid_host'],
      ['localhost?foo=1', 'invalid_host'],
      ['localhost#frag', 'invalid_host'],
      ['localhost\\evil', 'invalid_host'],
      ['127.0.0.1, evil.com', 'invalid_host'],
      ['127.0.0.1 ', 'invalid_host'],
      [' 127.0.0.1', 'invalid_host'],
      ['127.0.0.1\r\nX-Injected: 1', 'invalid_host'],
      ['localhost\x00.evil.com', 'invalid_host'],
      ['[::1', 'invalid_host'],
      ['localhost]', 'invalid_host'],
      ['localhost:80:80', 'invalid_host'],
      ['localhost:', 'invalid_port'],
      ['localhost:0', 'invalid_port'],
      ['localhost:080', 'invalid_port'],
      ['localhost:65536', 'invalid_port'],
      ['localhost:99999', 'invalid_port'],
      ['localhost:abc', 'invalid_port'],
      ['localhost:-80', 'invalid_port'],
      ['localhost:+80', 'invalid_port'],
    ]

    for (const [host, expectedCode] of malformed) {
      const res = validateHostHeader(host)
      expect(res.ok, `expected ${JSON.stringify(host)} to fail`).toBe(false)
      expect(res.code, `unexpected code for ${JSON.stringify(host)}`).toBe(expectedCode)
    }
  })

  it('enforces exact listening port when strictPort is enabled', () => {
    expect(validateHostHeader('127.0.0.1:43210', { expectedPort: 43210, strictPort: true }).ok).toBe(true)
    const mismatch = validateHostHeader('127.0.0.1:9999', { expectedPort: 43210, strictPort: true })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.code).toBe('port_mismatch')
  })

  it('validates Origin headers strictly against loopback origins', () => {
    expect(validateOriginHeader(undefined).ok).toBe(true)
    expect(validateOriginHeader('http://127.0.0.1:43210').ok).toBe(true)
    expect(validateOriginHeader('http://localhost:3000').ok).toBe(true)
    expect(validateOriginHeader('https://[::1]:8443').ok).toBe(true)

    const badOrigins = [
      '',
      'null',
      'NULL',
      'http://evil.com',
      'https://attacker.example',
      'http://localhost.evil.com',
      'http://127.0.0.1.nip.io:8080',
      'http://[::1].evil.com',
      'file:///etc/passwd',
      'chrome-extension://abcdef',
      'ws://127.0.0.1:43210',
      'http://127.0.0.1/path',
      'http://127.0.0.1@evil.com',
      ['http://localhost:3000', 'http://evil.com'],
    ]
    for (const origin of badOrigins) {
      expect(validateOriginHeader(origin).ok, `expected origin ${JSON.stringify(origin)} to be rejected`).toBe(false)
    }
  })

  it('detects duplicate Host and Origin headers in rawHeaders', () => {
    const dupHost = validateAgentRequestHeaders({
      headers: { host: '127.0.0.1:43210' },
      rawHeaders: ['Host', '127.0.0.1:43210', 'host', 'evil.com'],
    })
    expect(dupHost.ok).toBe(false)
    expect(dupHost.status).toBe(403)
    expect(dupHost.code).toBe('duplicate_host')

    const dupOrigin = validateAgentRequestHeaders({
      headers: { host: '127.0.0.1:43210', origin: 'http://localhost:3000' },
      rawHeaders: ['Host', '127.0.0.1:43210', 'Origin', 'http://localhost:3000', 'origin', 'https://evil.com'],
    })
    expect(dupOrigin.ok).toBe(false)
    expect(dupOrigin.status).toBe(403)
    expect(dupOrigin.code).toBe('duplicate_origin')
  })
})

describe('M72: Agent Socket live DNS rebinding, Host & CSWSH enforcement', () => {
  let manager: BrowserManager
  let agent: AgentSocketServer
  let strictAgent: AgentSocketServer

  beforeAll(async () => {
    manager = await BrowserManager.create({ engine: 'lite', memory: false })
    agent = await createAgentSocket(manager, { host: '127.0.0.1', port: 0 })
    strictAgent = await createAgentSocket(manager, { host: '127.0.0.1', port: 0, strictPort: true })
  })

  afterAll(async () => {
    await strictAgent?.close()
    await agent?.close()
    await manager?.close()
  })

  it('allows valid loopback Host headers on HTTP endpoints and sets hardening headers', async () => {
    for (const hostHeader of [`127.0.0.1:${agent.port}`, `localhost:${agent.port}`, `[::1]:${agent.port}`]) {
      const res = await sendRawHttp(
        agent.port,
        `GET /health HTTP/1.1\r\n` +
          `Host: ${hostHeader}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `Connection: close\r\n\r\n`,
      )
      expect(res.statusCode).toBe(200)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      const json = JSON.parse(res.body) as { ok: boolean }
      expect(json.ok).toBe(true)
    }
  })

  it('rejects DNS rebinding & prefix-bypass Host headers on HTTP GET, POST, and SSE /stream', async () => {
    const evilHosts = [
      `localhost.evil.com:${agent.port}`,
      `127.0.0.1.nip.io:${agent.port}`,
      `[::1].evil.com:${agent.port}`,
      `rebind.attacker.test:${agent.port}`,
      `127.0.0.1@evil.com`,
      `localhost:99999`,
      `127.0.0.2:${agent.port}`,
      `0.0.0.0:${agent.port}`,
    ]

    for (const evilHost of evilHosts) {
      const getRes = await sendRawHttp(
        agent.port,
        `GET /health HTTP/1.1\r\n` +
          `Host: ${evilHost}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `Connection: close\r\n\r\n`,
      )
      expect(getRes.statusCode, `GET /health with Host: ${evilHost}`).toBe(403)
      const getJson = JSON.parse(getRes.body) as { ok: boolean; error: string }
      expect(getJson.ok).toBe(false)
      expect(getJson.error).toContain('wrong host')

      const postRes = await sendRawHttp(
        agent.port,
        `POST /tabs HTTP/1.1\r\n` +
          `Host: ${evilHost}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: 2\r\n` +
          `Connection: close\r\n\r\n{}`,
      )
      expect(postRes.statusCode, `POST /tabs with Host: ${evilHost}`).toBe(403)

      const sseRes = await sendRawHttp(
        agent.port,
        `GET /stream HTTP/1.1\r\n` +
          `Host: ${evilHost}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `Connection: close\r\n\r\n`,
      )
      expect(sseRes.statusCode, `GET /stream with Host: ${evilHost}`).toBe(403)
    }
  })

  it('rejects HTTP/1.0 requests with missing Host header', async () => {
    const res = await sendRawHttp(
      agent.port,
      `GET /health HTTP/1.0\r\n` + `x-troy-agent: ${agent.token}\r\n\r\n`,
    )
    expect(res.statusCode).toBe(403)
    const json = JSON.parse(res.body) as { ok: boolean; code: string }
    expect(json.ok).toBe(false)
    expect(json.code).toBe('missing_host')
  })

  it('rejects cross-origin and null-origin HTTP requests even with valid Host and token', async () => {
    const badOrigins = ['https://evil.example', 'http://localhost.evil.com', 'null', 'file:///tmp/x.html']
    for (const origin of badOrigins) {
      const res = await sendRawHttp(
        agent.port,
        `POST /tabs HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `Origin: ${origin}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: 2\r\n` +
          `Connection: close\r\n\r\n{}`,
      )
      expect(res.statusCode, `Origin: ${origin}`).toBe(403)
      const json = JSON.parse(res.body) as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
      expect(json.error).toContain('forbidden origin')
    }
  })

  it('blocks DNS rebinding Host headers and CSWSH Origins on WebSocket /ws upgrades', async () => {
    const wsKey = randomBytes(16).toString('base64')

    // Prefix-bypass Host on WebSocket upgrade
    for (const evilHost of [`localhost.evil.com:${agent.port}`, `127.0.0.1.nip.io:${agent.port}`, `[::1].evil.com`]) {
      const res = await sendRawHttp(
        agent.port,
        `GET /ws?token=${agent.token} HTTP/1.1\r\n` +
          `Host: ${evilHost}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Key: ${wsKey}\r\n\r\n`,
      )
      expect(res.statusCode, `WS Host: ${evilHost}`).toBe(403)
    }

    // CSWSH: valid Host + valid token, but attacker Origin
    for (const evilOrigin of ['https://evil.example', 'http://127.0.0.1.evil.com', 'null']) {
      const res = await sendRawHttp(
        agent.port,
        `GET /ws?token=${agent.token} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `Origin: ${evilOrigin}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Key: ${wsKey}\r\n\r\n`,
      )
      expect(res.statusCode, `WS Origin: ${evilOrigin}`).toBe(403)
    }

    // Legitimate loopback Origin succeeds with 101 Switching Protocols
    const okRes = await sendRawHttp(
      agent.port,
      `GET /ws?token=${agent.token} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${agent.port}\r\n` +
        `Origin: http://localhost:3000\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\n\r\n`,
    )
    expect(okRes.statusCode).toBe(101)
  })

  it('enforces exact port matching on both HTTP and WS when strictPort is enabled', async () => {
    const wrongPort = strictAgent.port === 65534 ? 65533 : strictAgent.port + 1
    const wsKey = randomBytes(16).toString('base64')

    const httpBad = await sendRawHttp(
      strictAgent.port,
      `GET /health HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${wrongPort}\r\n` +
        `x-troy-agent: ${strictAgent.token}\r\n` +
        `Connection: close\r\n\r\n`,
    )
    expect(httpBad.statusCode).toBe(403)
    expect((JSON.parse(httpBad.body) as { code: string }).code).toBe('port_mismatch')

    const wsBad = await sendRawHttp(
      strictAgent.port,
      `GET /ws?token=${strictAgent.token} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${wrongPort}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\n\r\n`,
    )
    expect(wsBad.statusCode).toBe(403)

    const httpOk = await sendRawHttp(
      strictAgent.port,
      `GET /health HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${strictAgent.port}\r\n` +
        `x-troy-agent: ${strictAgent.token}\r\n` +
        `Connection: close\r\n\r\n`,
    )
    expect(httpOk.statusCode).toBe(200)
  })
})
