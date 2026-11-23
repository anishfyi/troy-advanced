import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  BrowserManager,
  ChromiumTab,
  NetworkRecorder,
  findChromeBinary,
  formatBodyPayload,
  formatNetworkBodyAscii,
  formatNetworkListAscii,
  handleMcpRequest,
  executePipeCommand,
  isTextMimeType,
  normalizeHeadersMap,
} from '../src/index.js'
import type { CdpClient } from '../src/engine/cdp-client.js'

const NON_ASCII_RE = /[^\x09\x0a\x0d\x20-\x7e]/

class MockCdpClient extends EventEmitter {
  public sent: Array<{ method: string; params: Record<string, unknown> }> = []
  private handlers = new Map<string, (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>>()

  onSend(
    method: string,
    fn: (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): void {
    this.handlers.set(method, fn)
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.sent.push({ method, params })
    const handler = this.handlers.get(method)
    if (handler) return await handler(params)
    return {}
  }

  close(): void {}
}

describe('M29: Network body inspection utilities', () => {
  it('detects text vs binary MIME types accurately', () => {
    expect(isTextMimeType('application/json; charset=utf-8')).toBe(true)
    expect(isTextMimeType('application/vnd.api+json')).toBe(true)
    expect(isTextMimeType('text/html')).toBe(true)
    expect(isTextMimeType('text/plain')).toBe(true)
    expect(isTextMimeType('application/xml')).toBe(true)
    expect(isTextMimeType('application/x-www-form-urlencoded')).toBe(true)
    expect(isTextMimeType('image/svg+xml')).toBe(true)
    expect(isTextMimeType('image/png')).toBe(false)
    expect(isTextMimeType('application/octet-stream')).toBe(false)
    expect(isTextMimeType('application/pdf')).toBe(false)
  })

  it('normalizes headers from Headers, array pairs, and plain objects', () => {
    const h = new Headers({ 'Content-Type': 'application/json', 'X-Test': '1' })
    expect(normalizeHeadersMap(h)).toEqual({ 'content-type': 'application/json', 'x-test': '1' })
    expect(normalizeHeadersMap([['X-A', 'foo'], ['X-B', 'bar']])).toEqual({ 'X-A': 'foo', 'X-B': 'bar' })
    expect(normalizeHeadersMap({ 'X-Multi': ['a', 'b'], 'X-Num': 42 })).toEqual({
      'X-Multi': 'a, b',
      'X-Num': '42',
    })
  })

  it('pretty-prints JSON, decodes base64 text, omits binary by default, and truncates oversized bodies', () => {
    const jsonPayload = formatBodyPayload({
      body: '{"ok":true,"items":[1,2]}',
      mimeType: 'application/json',
    })
    expect(jsonPayload.prettyPrinted).toBe(true)
    expect(jsonPayload.body).toContain('\n  "ok": true')
    expect(jsonPayload.truncated).toBeUndefined()

    const rawJson = formatBodyPayload(
      { body: '{"ok":true}', mimeType: 'application/json' },
      { prettyJson: false },
    )
    expect(rawJson.prettyPrinted).toBeUndefined()
    expect(rawJson.body).toBe('{"ok":true}')

    const b64Text = formatBodyPayload({
      body: Buffer.from('{"hello":"world"}', 'utf8').toString('base64'),
      base64Encoded: true,
      mimeType: 'application/json',
    })
    expect(b64Text.base64Encoded).toBeUndefined()
    expect(b64Text.prettyPrinted).toBe(true)
    expect(b64Text.body).toContain('"hello": "world"')

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const binOmitted = formatBodyPayload({
      body: pngBytes.toString('base64'),
      base64Encoded: true,
      mimeType: 'image/png',
    })
    expect(binOmitted.isBinary).toBe(true)
    expect(binOmitted.body).toBeUndefined()
    expect(binOmitted.sizeBytes).toBe(8)
    expect(binOmitted.unavailableReason).toContain('binary payload')

    const binIncluded = formatBodyPayload(
      {
        body: pngBytes.toString('base64'),
        base64Encoded: true,
        mimeType: 'image/png',
      },
      { includeBinary: true },
    )
    expect(binIncluded.isBinary).toBe(true)
    expect(binIncluded.base64Encoded).toBe(true)
    expect(binIncluded.body).toBe(pngBytes.toString('base64'))

    const longBody = 'x'.repeat(2000)
    const trunc = formatBodyPayload(
      { body: longBody, mimeType: 'text/plain' },
      { maxBodyChars: 500 },
    )
    expect(trunc.truncated).toBe(true)
    expect(trunc.body?.length).toBe(500)
    expect(trunc.sizeBytes).toBe(2000)
  })

  it('records, filters, looks up by req-N / bare number / cdpRequestId, and formats strict 7-bit ASCII', () => {
    const rec = new NetworkRecorder(50)
    const r1 = rec.record({
      cdpRequestId: 'cdp-100.1',
      url: 'https://api.example.com/v1/users',
      method: 'GET',
      status: 200,
      statusText: 'OK',
      ok: true,
      resourceType: 'Fetch',
      mimeType: 'application/json',
      durationMs: 23,
    })
    const r2 = rec.record({
      cdpRequestId: 'cdp-100.2',
      url: 'https://api.example.com/v1/orders',
      method: 'POST',
      status: 500,
      statusText: 'Internal Server Error',
      ok: false,
      resourceType: 'Fetch',
      mimeType: 'application/json',
      durationMs: 88,
      requestBody: '{"sku":"abc"}',
    })

    expect(r1.entry.requestId).toBe('req-1')
    expect(r2.entry.requestId).toBe('req-2')
    expect(rec.get('req-1')?.entry.url).toContain('/v1/users')
    expect(rec.get('2')?.entry.url).toContain('/v1/orders')
    expect(rec.get('cdp-100.2')?.entry.requestId).toBe('req-2')
    expect(rec.get('req-999')).toBeUndefined()

    expect(rec.list({ failedOnly: true }).map((e) => e.requestId)).toEqual(['req-2'])
    expect(rec.list({ method: 'post' }).map((e) => e.requestId)).toEqual(['req-2'])
    expect(rec.list({ urlFilter: 'users' }).map((e) => e.requestId)).toEqual(['req-1'])

    const listAscii = formatNetworkListAscii(rec.list())
    expect(listAscii).toContain('req-1')
    expect(listAscii).toContain('req-2')
    expect(listAscii).toContain('troy-advanced network --body <reqId>')
    expect(NON_ASCII_RE.test(listAscii)).toBe(false)
  })
})

describe('M29: Lite engine + BrowserManager + MCP + Pipe network body inspection', () => {
  let server: http.Server
  let baseUrl = ''
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m29-'))
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/items') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'sid=supersecretcookie12345; Path=/; HttpOnly',
          'X-Request-Trace': 'trace-99',
        })
        res.end(JSON.stringify({ ok: true, count: 2, items: ['alpha', 'beta'] }))
        return
      }
      if (url.pathname === '/form') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`
          <!doctype html>
          <html>
            <head><title>API Form</title></head>
            <body>
              <form method="POST" action="/api/echo">
                <label for="q">Payload</label>
                <input id="q" name="payload" type="text" value="hello-world" />
                <button type="submit">Send</button>
              </form>
            </body>
          </html>
        `)
        return
      }
      if (url.pathname === '/api/echo' && req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        const bodyText = Buffer.concat(chunks).toString('utf8')
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ echoed: bodyText, authSeen: Boolean(req.headers.authorization) }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('captures JSON API response bodies, redacts sensitive headers by default, and supports reveal/raw options', async () => {
    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: path.join(tmpDir, 'p1'),
      emulation: {
        extraHeaders: {
          Authorization: 'Bearer sk-live-secret-token-987654',
          'X-Client': 'troy-test',
        },
      },
    })
    try {
      await manager.openTab(`${baseUrl}/api/items`)
      const listRes = await manager.runTool(undefined, 'page_network', {})
      expect(listRes.ok).toBe(true)
      expect(listRes.count).toBe(1)
      const entries = listRes.entries as Array<{ requestId: string; status: number; method: string }>
      expect(entries[0]?.requestId).toBe('req-1')
      expect(entries[0]?.status).toBe(200)
      expect(typeof listRes.ascii).toBe('string')
      expect(String(listRes.ascii)).toContain('req-1')

      // Inspect body with default redaction & JSON pretty-printing
      const bodyRes = await manager.runTool(undefined, 'page_network', { body: 'req-1' })
      expect(bodyRes.ok).toBe(true)
      expect(bodyRes.requestId).toBe('req-1')
      const reqHeaders = bodyRes.requestHeaders as Record<string, string>
      const resHeaders = bodyRes.responseHeaders as Record<string, string>
      expect(reqHeaders.authorization).toContain('***')
      expect(reqHeaders.authorization).not.toContain('987654')
      expect(reqHeaders['x-client']).toBe('troy-test')
      expect(resHeaders['set-cookie']).toContain('***')
      expect(resHeaders['x-request-trace']).toBe('trace-99')

      const responseBody = bodyRes.responseBody as { body: string; prettyPrinted?: boolean; mimeType?: string }
      expect(responseBody.prettyPrinted).toBe(true)
      expect(responseBody.mimeType).toBe('application/json')
      expect(responseBody.body).toContain('"alpha"')
      expect(responseBody.body).toContain('\n  "ok": true')
      expect(typeof bodyRes.ascii).toBe('string')
      expect(NON_ASCII_RE.test(String(bodyRes.ascii))).toBe(false)

      // Inspect with revealHeaders: true and prettyJson: false
      const revealedRes = await manager.runTool(undefined, 'page_network_body', {
        requestId: 'req-1',
        revealHeaders: true,
        prettyJson: false,
      })
      expect(revealedRes.ok).toBe(true)
      const revealedReqHeaders = revealedRes.requestHeaders as Record<string, string>
      expect(revealedReqHeaders.authorization).toBe('Bearer sk-live-secret-token-987654')
      const rawBody = revealedRes.responseBody as { body: string; prettyPrinted?: boolean }
      expect(rawBody.prettyPrinted).toBeUndefined()
      expect(rawBody.body).toBe('{"ok":true,"count":2,"items":["alpha","beta"]}')

      // Missing reqId returns clean error
      const missingRes = await manager.runTool(undefined, 'page_network', { body: 'req-999' })
      expect(missingRes.ok).toBe(false)
      expect(String(missingRes.error)).toContain('req-999')
    } finally {
      await manager.close()
    }
  })

  it('captures POST request body and response body via MCP troy_network and Pipe REPL network --body', async () => {
    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: path.join(tmpDir, 'p2'),
    })
    try {
      await manager.openTab(`${baseUrl}/form`)
      // Grant origin so submit click is allowed
      manager.grantOrigin(baseUrl)
      const snap = await manager.runTool(undefined, 'page_read', {})
      const elements = (snap.elements as Array<{ ref: string; tag: string; type?: string }>) ?? []
      const submitBtn = elements.find((e) => e.tag === 'button')
      expect(submitBtn).toBeDefined()
      await manager.runTool(undefined, 'page_click', { ref: submitBtn!.ref, allowSubmit: true })

      // Via MCP troy_network (list)
      const mcpList = await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'troy_network', arguments: { method: 'POST' } },
      })
      const listText = ((mcpList?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const listJson = JSON.parse(listText) as { ok: boolean; entries: Array<{ requestId: string; method: string; status: number }> }
      expect(listJson.ok).toBe(true)
      expect(listJson.entries.length).toBe(1)
      const postReqId = listJson.entries[0]!.requestId
      expect(listJson.entries[0]!.method).toBe('POST')
      expect(listJson.entries[0]!.status).toBe(201)

      // Via MCP troy_network (body)
      const mcpBody = await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'troy_network', arguments: { body: postReqId } },
      })
      const bodyText = ((mcpBody?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const bodyJson = JSON.parse(bodyText) as {
        ok: boolean
        requestBody?: { body?: string }
        responseBody?: { body?: string; prettyPrinted?: boolean }
      }
      expect(bodyJson.ok).toBe(true)
      expect(bodyJson.requestBody?.body).toContain('payload=hello-world')
      expect(bodyJson.responseBody?.prettyPrinted).toBe(true)
      expect(bodyJson.responseBody?.body).toContain('"echoed": "payload=hello-world"')

      // Via Pipe REPL
      const pipeOut = await executePipeCommand(manager, `network --body ${postReqId} --raw`, { jsonMode: true })
      const pipeJson = JSON.parse(pipeOut.output) as {
        ok: boolean
        requestId: string
        responseBody?: { body?: string; prettyPrinted?: boolean }
      }
      expect(pipeJson.ok).toBe(true)
      expect(pipeJson.requestId).toBe(postReqId)
      expect(pipeJson.responseBody?.prettyPrinted).toBeUndefined()
      expect(pipeJson.responseBody?.body).toContain('"echoed":"payload=hello-world"')
    } finally {
      await manager.close()
    }
  })
})

describe('M29: ChromiumTab CDP Network.getResponseBody & Network.getRequestPostData', () => {
  it('fetches and caches CDP response body + postData, and handles CDP eviction errors cleanly', async () => {
    const cdp = new MockCdpClient()
    let getResponseBodyCalls = 0
    let getPostDataCalls = 0

    cdp.onSend('Network.getResponseBody', (params) => {
      getResponseBodyCalls += 1
      if (params.requestId === 'cdp-1') {
        return { body: '{"status":"created","id":42}', base64Encoded: false }
      }
      if (params.requestId === 'cdp-evicted') {
        throw new Error('No resource with given identifier found')
      }
      return { body: '', base64Encoded: false }
    })

    cdp.onSend('Network.getRequestPostData', (params) => {
      getPostDataCalls += 1
      if (params.requestId === 'cdp-1') {
        return { postData: '{"name":"widget"}' }
      }
      return { postData: '' }
    })

    const tab = new ChromiumTab(1, 'target-1', cdp as unknown as CdpClient, 9222)

    // Simulate CDP Network events for a POST API call where postData was omitted (hasPostData: true)
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'cdp-1',
      type: 'Fetch',
      request: {
        url: 'https://api.example.com/widgets',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer topsecret-cdp-token',
        },
        hasPostData: true,
      },
    })
    cdp.emit('Network.responseReceived', {
      requestId: 'cdp-1',
      type: 'Fetch',
      response: {
        url: 'https://api.example.com/widgets',
        status: 201,
        statusText: 'Created',
        mimeType: 'application/json',
        headers: { 'Content-Type': 'application/json' },
      },
    })
    cdp.emit('Network.loadingFinished', {
      requestId: 'cdp-1',
      encodedDataLength: 28,
    })

    // Simulate a second request whose body gets evicted from Chrome's buffer
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'cdp-evicted',
      type: 'XHR',
      request: {
        url: 'https://api.example.com/old',
        method: 'GET',
        headers: {},
      },
    })
    cdp.emit('Network.responseReceived', {
      requestId: 'cdp-evicted',
      type: 'XHR',
      response: {
        url: 'https://api.example.com/old',
        status: 200,
        statusText: 'OK',
        mimeType: 'text/plain',
        headers: {},
      },
    })

    const list = tab.getNetwork()
    expect(list.length).toBe(2)
    expect(list[0]?.requestId).toBe('req-1')
    expect(list[0]?.encodedDataLength).toBe(28)
    expect(list[1]?.requestId).toBe('req-2')

    // First inspection hits CDP Network.getResponseBody + Network.getRequestPostData
    const res1 = await tab.getNetworkBody('req-1')
    expect(res1.ok).toBe(true)
    expect(res1.requestHeaders?.Authorization).toContain('***')
    expect(res1.requestBody?.prettyPrinted).toBe(true)
    expect(res1.requestBody?.body).toContain('"name": "widget"')
    expect(res1.responseBody?.prettyPrinted).toBe(true)
    expect(res1.responseBody?.body).toContain('"id": 42')
    expect(getResponseBodyCalls).toBe(1)
    expect(getPostDataCalls).toBe(1)

    // Second inspection uses cache (no extra CDP round-trips)
    const res1Cached = await tab.getNetworkBody('req-1', { revealHeaders: true })
    expect(res1Cached.ok).toBe(true)
    expect(res1Cached.requestHeaders?.Authorization).toBe('Bearer topsecret-cdp-token')
    expect(getResponseBodyCalls).toBe(1)
    expect(getPostDataCalls).toBe(1)

    // Evicted request returns ok:true with clear unavailableReason instead of throwing
    const resEvicted = await tab.getNetworkBody('req-2')
    expect(resEvicted.ok).toBe(true)
    expect(resEvicted.responseBody?.body).toBeUndefined()
    expect(resEvicted.responseBody?.unavailableReason).toContain('No resource with given identifier found')
    expect(formatNetworkBodyAscii(resEvicted)).toContain('No resource with given identifier found')
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('M29: Headless Chromium CDP real API request/response body inspection E2E', () => {
  let server: http.Server
  let baseUrl = ''
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m29-chrome-'))
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/app') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`
          <!doctype html>
          <html>
            <head><title>API Debugger App</title></head>
            <body>
              <h1>API Test</h1>
              <div id="status">loading</div>
              <script>
                fetch('/api/submit', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': 'secret-chrome-key-99999'
                  },
                  body: JSON.stringify({ action: 'ping', count: 7 })
                })
                  .then((r) => r.json())
                  .then((d) => {
                    document.getElementById('status').textContent = 'done:' + d.echo.action;
                  });
              </script>
            </body>
          </html>
        `)
        return
      }
      if (url.pathname === '/api/submit' && req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Backend': 'troy-e2e',
        })
        res.end(JSON.stringify({ received: true, echo: parsed }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('inspects real Chromium fetch() POST request body and JSON response body via page_network --body', async () => {
    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: path.join(tmpDir, 'chrome-profile'),
    })
    try {
      await manager.openTab(`${baseUrl}/app`)
      await manager.runTool(undefined, 'page_wait', { text: 'done:ping', timeout: 5000 })

      const listRes = await manager.runTool(undefined, 'page_network', { method: 'POST', urlFilter: '/api/submit' })
      expect(listRes.ok).toBe(true)
      const entries = listRes.entries as Array<{ requestId: string; method: string; status: number }>
      expect(entries.length).toBe(1)
      const reqId = entries[0]!.requestId
      expect(entries[0]!.status).toBe(200)

      const bodyRes = await manager.runTool(undefined, 'page_network', { body: reqId })
      expect(bodyRes.ok).toBe(true)
      const reqHeaders = bodyRes.requestHeaders as Record<string, string>
      // X-API-Key should be redacted by default (case-insensitive key check)
      const apiKeyEntry = Object.entries(reqHeaders).find(([k]) => k.toLowerCase() === 'x-api-key')
      expect(apiKeyEntry).toBeDefined()
      expect(apiKeyEntry![1]).toContain('***')
      expect(apiKeyEntry![1]).not.toContain('99999')

      const reqBody = bodyRes.requestBody as { body?: string; prettyPrinted?: boolean }
      expect(reqBody.prettyPrinted).toBe(true)
      expect(reqBody.body).toContain('"action": "ping"')
      expect(reqBody.body).toContain('"count": 7')

      const resBody = bodyRes.responseBody as { body?: string; prettyPrinted?: boolean }
      expect(resBody.prettyPrinted).toBe(true)
      expect(resBody.body).toContain('"received": true')
      expect(resBody.body).toContain('"action": "ping"')
      expect(NON_ASCII_RE.test(String(bodyRes.ascii ?? ''))).toBe(false)
    } finally {
      await manager.close()
    }
  }, 20_000)
})
