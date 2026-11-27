import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import {
  BrowserManager,
  createAgentSocket,
  encodeWsFrame,
  computeWebSocketAccept,
  TroyWsClient,
  WS_OPCODE_CONTINUATION,
  WS_OPCODE_PING,
  WS_OPCODE_PONG,
  WS_OPCODE_TEXT,
  type AgentSocketServer,
  type AsciiFramePayload,
  type WsEventMessage,
} from '../src/index.js'

function maskClientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4)
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 0x80 | len
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i]! ^ mask[i & 3]!
  }
  return Buffer.concat([header, mask, masked])
}

async function rawUpgradeRequest(
  port: number,
  reqPath: string,
  headers: Record<string, string>,
): Promise<{ statusLine: string; rawHead: string; socket: net.Socket; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    let done = false

    const finish = (headStr: string, leftover: Buffer) => {
      if (done) return
      done = true
      const statusLine = headStr.split('\r\n')[0] ?? ''
      resolve({ statusLine, rawHead: headStr, socket, leftover })
    }

    socket.once('error', (err) => {
      if (!done) {
        done = true
        reject(err)
      }
    })

    socket.on('data', (chunk) => {
      if (done) return
      chunks.push(chunk)
      const buf = Buffer.concat(chunks)
      const idx = buf.indexOf('\r\n\r\n')
      if (idx !== -1) {
        const headStr = buf.subarray(0, idx).toString('utf8')
        const leftover = buf.subarray(idx + 4)
        finish(headStr, leftover)
      }
    })

    socket.once('connect', () => {
      const lines = [`GET ${reqPath} HTTP/1.1`]
      for (const [k, v] of Object.entries(headers)) {
        lines.push(`${k}: ${v}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
  })
}

function readServerFrame(socket: net.Socket, initial: Buffer = Buffer.alloc(0)): Promise<{ opcode: number; payload: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = initial
    const tryParse = () => {
      if (buf.length < 2) return false
      const opcode = buf[0]! & 0x0f
      let len = buf[1]! & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return false
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return false
        len = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      if (buf.length < offset + len) return false
      const payload = buf.subarray(offset, offset + len)
      const rest = buf.subarray(offset + len)
      cleanup()
      resolve({ opcode, payload, rest })
      return true
    }

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      tryParse()
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('socket closed before frame'))
    }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    if (!tryParse()) {
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
    }
  })
}

async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = check()
    if (val) return val
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe('WebSocket bridge (/ws) on Agent Socket (M66)', () => {
  let siteServer: http.Server
  let siteUrl = ''
  let manager: BrowserManager
  let agent: AgentSocketServer

  beforeAll(async () => {
    siteServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (reqUrl.pathname === '/second') {
        res.end(`<!doctype html><html><head><title>WS Page Two</title></head><body>
          <h1>Second Page</h1>
          <p>Arrived on page two via WebSocket bridge.</p>
          <a href="/">Back Home</a>
        </body></html>`)
        return
      }
      if (reqUrl.pathname === '/alpha') {
        res.end(`<!doctype html><html><head><title>Alpha View</title></head><body><h1>Alpha Workspace</h1></body></html>`)
        return
      }
      if (reqUrl.pathname === '/beta') {
        res.end(`<!doctype html><html><head><title>Beta View</title></head><body><h1>Beta Workspace</h1></body></html>`)
        return
      }
      res.end(`<!doctype html><html><head><title>WS Home</title></head><body>
        <h1>Welcome to WS Bridge</h1>
        <p>Ultra-low-latency bidirectional AI control.</p>
        <a href="/second">Go Second</a>
        <table><tr><th>Item</th><th>Status</th></tr><tr><td>WS</td><td>Ready</td></tr></table>
      </body></html>`)
    })

    await new Promise<void>((resolve) => siteServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = siteServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    siteUrl = `http://127.0.0.1:${port}`

    manager = await BrowserManager.create({ engine: 'lite', memory: false })
    agent = await createAgentSocket(manager)
  })

  afterAll(async () => {
    await agent.close()
    await manager.close()
    await new Promise<void>((resolve) => siteServer.close(() => resolve()))
  })

  it('encodes RFC 6455 frames cleanly across 7-bit, 16-bit, and 64-bit lengths', () => {
    const small = encodeWsFrame(WS_OPCODE_TEXT, 'hello')
    expect(small[0]).toBe(0x81)
    expect(small[1]).toBe(5)
    expect(small.subarray(2).toString('utf8')).toBe('hello')

    const mediumPayload = Buffer.alloc(300, 0x61)
    const medium = encodeWsFrame(WS_OPCODE_TEXT, mediumPayload)
    expect(medium[0]).toBe(0x81)
    expect(medium[1]).toBe(126)
    expect(medium.readUInt16BE(2)).toBe(300)
    expect(medium.length).toBe(4 + 300)

    const largePayload = Buffer.alloc(70_000, 0x62)
    const large = encodeWsFrame(WS_OPCODE_TEXT, largePayload)
    expect(large[0]).toBe(0x81)
    expect(large[1]).toBe(127)
    expect(Number(large.readBigUInt64BE(2))).toBe(70_000)
    expect(large.length).toBe(10 + 70_000)

    // RFC 6455 §1.3 test vector
    expect(computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('enforces loopback host, token auth, route path, and sessionId validation on upgrade', async () => {
    const key = randomBytes(16).toString('base64')

    // Missing token -> 401
    const noToken = await rawUpgradeRequest(agent.port, '/ws', {
      Host: `127.0.0.1:${agent.port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    })
    expect(noToken.statusLine).toContain('401')
    noToken.socket.destroy()

    // Wrong host -> 403
    const badHost = await rawUpgradeRequest(agent.port, `/ws?token=${agent.token}`, {
      Host: 'evil.example.com',
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    })
    expect(badHost.statusLine).toContain('403')
    badHost.socket.destroy()

    // Wrong path -> 404
    const badPath = await rawUpgradeRequest(agent.port, `/not-ws?token=${agent.token}`, {
      Host: `127.0.0.1:${agent.port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    })
    expect(badPath.statusLine).toContain('404')
    badPath.socket.destroy()

    // Invalid sessionId -> 400
    const badSession = await rawUpgradeRequest(agent.port, `/ws?token=${agent.token}&sessionId=${encodeURIComponent('bad session!')}`, {
      Host: `127.0.0.1:${agent.port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    })
    expect(badSession.statusLine).toContain('400')
    badSession.socket.destroy()
  })

  it('supports x-troy-agent header auth, RFC 6455 Ping/Pong, fragmented frames, and rejects unmasked frames', async () => {
    const key = randomBytes(16).toString('base64')
    const upgraded = await rawUpgradeRequest(agent.port, '/ws', {
      Host: `127.0.0.1:${agent.port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      'x-troy-agent': agent.token,
    })
    expect(upgraded.statusLine).toContain('101')
    expect(upgraded.rawHead).toContain(`Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}`)

    // Consume initial hello frame
    const helloFrame = await readServerFrame(upgraded.socket, upgraded.leftover)
    expect(helloFrame.opcode).toBe(WS_OPCODE_TEXT)
    const hello = JSON.parse(helloFrame.payload.toString('utf8')) as { type: string; protocol: string }
    expect(hello.type).toBe('hello')
    expect(hello.protocol).toBe('troy-ws-v1')

    // Send RFC 6455 Ping -> expect Pong with identical payload
    const pingPayload = Buffer.from('hb-123')
    upgraded.socket.write(maskClientFrame(WS_OPCODE_PING, pingPayload, true))
    const pongFrame = await readServerFrame(upgraded.socket, helloFrame.rest)
    expect(pongFrame.opcode).toBe(WS_OPCODE_PONG)
    expect(pongFrame.payload.toString('utf8')).toBe('hb-123')

    // Send fragmented JSON request across two frames (FIN=0 then CONTINUATION FIN=1)
    const fullReq = Buffer.from(JSON.stringify({ id: 'frag-1', op: 'ping' }), 'utf8')
    const mid = Math.floor(fullReq.length / 2)
    upgraded.socket.write(maskClientFrame(WS_OPCODE_TEXT, fullReq.subarray(0, mid), false))
    upgraded.socket.write(maskClientFrame(WS_OPCODE_CONTINUATION, fullReq.subarray(mid), true))

    const fragRespFrame = await readServerFrame(upgraded.socket, pongFrame.rest)
    const fragResp = JSON.parse(fragRespFrame.payload.toString('utf8')) as { type: string; id: string }
    expect(fragResp.type).toBe('pong')
    expect(fragResp.id).toBe('frag-1')

    // Sending an unmasked client frame must trigger protocol close (1002)
    upgraded.socket.write(encodeWsFrame(WS_OPCODE_TEXT, '{"op":"ping"}'))
    const closeFrame = await readServerFrame(upgraded.socket, fragRespFrame.rest)
    expect(closeFrame.opcode).toBe(0x8)
    expect(closeFrame.payload.readUInt16BE(0)).toBe(1002)
    upgraded.socket.destroy()
  })

  it('supports bidirectional control, pipelining, tool calls, batching, and /health stats', async () => {
    const client = await TroyWsClient.connect({ port: agent.port, token: agent.token })
    expect(client.hello.protocol).toBe('troy-ws-v1')
    expect(client.hello.engine).toBe('lite')

    const pong = await client.ping()
    expect(pong.type).toBe('pong')

    // Open a tab and render ASCII + extract via pipelined requests
    const opened = await client.request({ op: 'open', url: siteUrl, activate: true })
    expect(opened.ok).toBe(true)
    const tabId = Number(opened.result?.id ?? opened.result?.tabId)
    expect(tabId).toBeGreaterThan(0)

    // Pipeline 3 concurrent requests on the same socket
    const [healthRes, asciiRes, extractRes] = await Promise.all([
      client.route('/health'),
      client.request({ op: 'ascii', tabId, width: 80 }),
      client.request({ op: 'extract', tabId, sections: ['tables', 'links'] }),
    ])

    expect(healthRes.ok).toBe(true)
    expect((healthRes.result?.ws as { clients: number }).clients).toBeGreaterThanOrEqual(1)

    expect(asciiRes.ok).toBe(true)
    expect(String(asciiRes.result?.ascii)).toContain('WELCOME TO WS BRIDGE')

    expect(extractRes.ok).toBe(true)
    expect(Array.isArray(extractRes.result?.tables)).toBe(true)

    // Tool shorthand
    const readRes = await client.tool('page_read', { ascii: false }, tabId)
    expect(readRes.ok).toBe(true)
    expect(readRes.result?.title).toBe('WS Home')

    // Batch execution with stopOnError
    const batchOk = await client.batch([
      { op: 'tabs' },
      { tool: 'page_extract', tabId, args: { sections: ['headings'] } },
    ])
    expect(batchOk.ok).toBe(true)
    expect(batchOk.results?.length).toBe(2)
    expect(batchOk.results?.[0]?.ok).toBe(true)
    expect(batchOk.results?.[1]?.ok).toBe(true)

    const batchStop = await client.batch(
      [
        { route: '/does-not-exist' },
        { op: 'tabs' },
      ],
      { stopOnError: true },
    )
    expect(batchStop.ok).toBe(false)
    expect(batchStop.results?.length).toBe(1)

    // Unknown op returns structured 400 without dropping socket
    const badOp = await client.request({ op: 'unknown_op' })
    expect(badOp.ok).toBe(false)
    expect(badOp.status).toBe(400)

    await client.close()
  })

  it('pushes live ASCII frames and manager events over subscribed WebSocket (including delta mode)', async () => {
    const client = await TroyWsClient.connect({ port: agent.port, token: agent.token })
    const frames: AsciiFramePayload[] = []
    const events: WsEventMessage[] = []
    client.onFrame((f) => frames.push(f))
    client.onEvent((e) => events.push(e))

    const opened = await client.request({ op: 'open', url: siteUrl, activate: true })
    const tabId = Number(opened.result?.id ?? opened.result?.tabId)

    const sub = await client.subscribe({ tabId, width: 80, since: true, throttleMs: 0 })
    expect(sub.ok).toBe(true)

    // Initial full frame
    const initial = await waitFor(() => frames.find((f) => f.reason === 'initial'))
    expect(initial.mode).toBe('full')
    expect(initial.ascii).toContain('WELCOME TO WS BRIDGE')

    // Navigate to /second -> expect navigated event + delta frame
    const navRes = await client.tool('page_navigate', { url: `${siteUrl}/second` }, tabId)
    expect(navRes.ok).toBe(true)

    const navEvent = await waitFor(() => events.find((e) => e.event === 'navigated'))
    expect(navEvent.data.tabId).toBe(tabId)

    const secondFrame = await waitFor(() => frames.find((f) => f.url.endsWith('/second')))
    expect(secondFrame.mode).toBe('delta')
    expect(secondFrame.ascii).toContain('Second Page')

    // Unsubscribe stops further pushes
    const unsub = await client.unsubscribe()
    expect(unsub.ok).toBe(true)
    const countBefore = frames.length
    await client.tool('page_navigate', { url: siteUrl }, tabId)
    await new Promise((r) => setTimeout(r, 60))
    expect(frames.length).toBe(countBefore)

    await client.close()
  })

  it('isolates tabs and pushed events across named multi-agent WebSocket sessions', async () => {
    const alpha = await TroyWsClient.connect({
      port: agent.port,
      token: agent.token,
      sessionId: 'ws-alpha',
      subscribe: true,
    })
    const beta = await TroyWsClient.connect({
      port: agent.port,
      token: agent.token,
      sessionId: 'ws-beta',
      subscribe: true,
    })

    const alphaFrames: AsciiFramePayload[] = []
    const betaFrames: AsciiFramePayload[] = []
    alpha.onFrame((f) => alphaFrames.push(f))
    beta.onFrame((f) => betaFrames.push(f))

    const openAlpha = await alpha.request({ op: 'open', url: `${siteUrl}/alpha`, activate: true })
    const openBeta = await beta.request({ op: 'open', url: `${siteUrl}/beta`, activate: true })
    expect(openAlpha.ok).toBe(true)
    expect(openBeta.ok).toBe(true)

    const alphaTabId = Number(openAlpha.result?.id ?? openAlpha.result?.tabId)
    const betaTabId = Number(openBeta.result?.id ?? openBeta.result?.tabId)

    const alphaTabs = await alpha.request({ op: 'tabs' })
    const betaTabs = await beta.request({ op: 'tabs' })

    const alphaIds = (alphaTabs.result?.tabs as Array<{ id: number }>).map((t) => t.id)
    const betaIds = (betaTabs.result?.tabs as Array<{ id: number }>).map((t) => t.id)
    expect(alphaIds).toContain(alphaTabId)
    expect(alphaIds).not.toContain(betaTabId)
    expect(betaIds).toContain(betaTabId)
    expect(betaIds).not.toContain(alphaTabId)

    await waitFor(() => alphaFrames.find((f) => f.url.endsWith('/alpha')))
    await waitFor(() => betaFrames.find((f) => f.url.endsWith('/beta')))
    expect(alphaFrames.some((f) => f.url.endsWith('/beta'))).toBe(false)
    expect(betaFrames.some((f) => f.url.endsWith('/alpha'))).toBe(false)

    await alpha.close()
    await beta.close()
  })
})
