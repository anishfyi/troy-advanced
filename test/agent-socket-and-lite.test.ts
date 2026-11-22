import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'

describe('Lite engine + Agent Socket + MCP + Pipe REPL integration', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let socket: AgentSocketServer
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-test-'))
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/search') {
        const q = url.searchParams.get('q') ?? ''
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><head><title>Results for ${q}</title></head><body><h1>Results: ${q}</h1><a href="/">Home</a></body></html>`)
        return
      }
      if (url.pathname === '/table') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><head><title>EC2 Fleet</title></head><body>
          <h1>EC2 Fleet</h1>
          <table>
            <thead><tr><th>Host</th><th>Zone</th><th>State</th></tr></thead>
            <tbody>
              <tr><td>app-1</td><td>us-east-1a</td><td>ok</td></tr>
              <tr><td>app-2</td><td>us-east-1b</td><td>warm</td></tr>
            </tbody>
          </table>
        </body></html>`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html>
      <html>
        <head><title>Troy Test Portal</title></head>
        <body>
          <h1>Troy Advanced Portal</h1>
          <p>Welcome to the terminal browser test page.</p>
          <form action="/search" method="GET">
            <label for="q">Search Box</label>
            <input id="q" name="q" type="text" placeholder="type query" />
            <input id="pw" name="password" type="password" />
            <button id="go" type="submit">Submit Query</button>
          </form>
          <a href="/search?q=docs">Read Docs</a>
        </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`

    manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
    socket = await createAgentSocket(manager)
  })

  afterAll(async () => {
    await socket.close()
    await manager.close()
    await new Promise<void>((r) => server.close(() => r()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function api(route: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`http://127.0.0.1:${socket.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-troy-agent': socket.token },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json()) as Record<string, unknown> }
  }

  it('enforces x-troy-agent bearer token and drives tabs + forms + ASCII over Agent Socket', async () => {
    const unauth = await fetch(`http://127.0.0.1:${socket.port}/health`)
    expect(unauth.status).toBe(401)

    const opened = await api('/open', { url: baseUrl, activate: true })
    expect(opened.data.ok).toBe(true)
    const tabId = Number(opened.data.id)

    const asciiRes = await api('/ascii', { tabId, width: 90, height: 28 })
    expect(asciiRes.data.ok).toBe(true)
    expect(String(asciiRes.data.ascii)).toContain('TROY ADVANCED PORTAL')
    expect(/^[\x20-\x7e\n]+$/.test(String(asciiRes.data.ascii))).toBe(true)

    // Find search box and fill it
    const found = await api('/tool', { tabId, name: 'page_find', args: { query: 'Search Box' } })
    const matches = found.data.matches as Array<{ ref: string }>
    expect(matches.length).toBeGreaterThan(0)
    const searchRef = matches[0]!.ref

    const filled = await api('/tool', { tabId, name: 'page_fill', args: { ref: searchRef, text: 'ec2-ascii' } })
    expect(filled.data.ok).toBe(true)

    // Password field must be deterministically blocked!
    const foundPw = await api('/tool', { tabId, name: 'page_find', args: { query: 'password' } })
    const pwMatches = foundPw.data.matches as Array<{ ref: string }>
    if (pwMatches[0]) {
      const pwFill = await api('/tool', { tabId, name: 'page_fill', args: { ref: pwMatches[0].ref, text: 'secret' } })
      expect(pwFill.data.ok).toBe(false)
      expect(pwFill.data.code).toBe('sensitive')
    }

    // Submit button blocked without allowSubmit, allowed with allowSubmit
    const foundSubmit = await api('/tool', { tabId, name: 'page_find', args: { query: 'Submit Query' } })
    const submitRef = (foundSubmit.data.matches as Array<{ ref: string }>)[0]!.ref

    const blockedSubmit = await api('/tool', { tabId, name: 'page_click', args: { ref: submitRef } })
    expect(blockedSubmit.data.ok).toBe(false)
    expect(blockedSubmit.data.code).toBe('submit')

    const allowedSubmit = await api('/tool', { tabId, name: 'page_click', args: { ref: submitRef, allowSubmit: true } })
    expect(allowedSubmit.data.ok).toBe(true)
    expect(String(allowedSubmit.data.url)).toContain('/search?q=ec2-ascii')

    // Delta read shows URL change
    const delta = await api('/tool', { tabId, name: 'page_read', args: { since: true } })
    expect(delta.data.ok).toBe(true)
    expect(delta.data.mode).toBe('delta')
    expect(delta.data.urlChanged).toBe(true)

    // Memory recall finds what we read
    const recalled = await api('/recall', { query: 'Portal' })
    expect(recalled.data.ok).toBe(true)
    expect((recalled.data.pages as unknown[]).length).toBeGreaterThan(0)
  })

  it('serves MCP JSON-RPC tools and streaming Pipe REPL commands', async () => {
    const init = await handleMcpRequest(manager, { id: 1, method: 'initialize' })
    expect(init?.result).toBeTruthy()

    const list = await handleMcpRequest(manager, { id: 2, method: 'tools/list' })
    expect(((list?.result as { tools: unknown[] }).tools).length).toBeGreaterThanOrEqual(8)

    const call = await handleMcpRequest(manager, {
      id: 3,
      method: 'tools/call',
      params: { name: 'troy_read_ascii', arguments: { width: 80, height: 24 } },
    })
    const text = ((call?.result as { content: Array<{ text: string }> }).content[0]?.text) ?? ''
    expect(text).toContain('TROY-ADV')

    const pipeOut = await executePipeCommand(manager, 'ascii 80')
    expect(pipeOut.output).toContain('TROY-ADV')
    const jsonPipeOut = await executePipeCommand(manager, '{"cmd":"tabs"}')
    expect(JSON.parse(jsonPipeOut.output).ok).toBe(true)
  })

  it('parses HTML tables in Lite engine and renders aligned ASCII borders with header separator', async () => {
    const opened = await api('/open', { url: `${baseUrl}/table`, activate: true })
    expect(opened.data.ok).toBe(true)
    const tabId = Number(opened.data.id)

    const asciiRes = await api('/ascii', { tabId, width: 80, height: 24 })
    expect(asciiRes.data.ok).toBe(true)
    const ascii = String(asciiRes.data.ascii)
    expect(ascii).toContain('+-------+------------+-------+')
    expect(ascii).toContain('| Host  | Zone       | State |')
    expect(ascii).toContain('+=======+============+=======+')
    expect(ascii).toContain('| app-1 | us-east-1a | ok    |')
    expect(ascii).toContain('| app-2 | us-east-1b | warm  |')
  })
})
