import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'
import { clearEndpoint, readLiveEndpoint, writeEndpoint } from '../src/bridge/endpoint.js'
import {
  McpStdioFrameParser,
  encodeMcpMessage,
  runMcpStdioServer,
  type ResolvedMcpFraming,
} from '../src/mcp/server.js'
import { runPipeRepl } from '../src/pipe/repl.js'
import { SESSION_HEADER } from '../src/agent/sessions.js'

/**
 * Dexter-style HTTP client that discovers the running Troy Agent Socket via
 * `agent-endpoint.json`, authenticates with `x-troy-agent`, and supports
 * optional `x-troy-session` multi-agent isolation and SSE `/stream`.
 */
class DexterHttpClient {
  readonly port: number
  readonly token: string
  readonly endpointFile: string

  private constructor(port: number, token: string, endpointFile: string) {
    this.port = port
    this.token = token
    this.endpointFile = endpointFile
  }

  static fromEndpointFile(endpointFile: string): DexterHttpClient {
    const live = readLiveEndpoint(endpointFile)
    if (!live) {
      throw new Error(`No live Troy endpoint found at ${endpointFile}`)
    }
    return new DexterHttpClient(live.endpoint.agentPort, live.endpoint.agentToken, live.endpoint.file)
  }

  async post(
    route: string,
    body: Record<string, unknown> = {},
    opts: { token?: string | null; sessionId?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (opts.token !== null) {
      headers['x-troy-agent'] = opts.token ?? this.token
    }
    if (opts.sessionId) {
      headers[SESSION_HEADER] = opts.sessionId
    }
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as Record<string, unknown>
    return { status: res.status, json }
  }

  openSseStream(query = ''): {
    events: Array<{ event: string; data: Record<string, unknown> }>
    waitForEvent: (predicate: (ev: { event: string; data: Record<string, unknown> }) => boolean, timeoutMs?: number) => Promise<{ event: string; data: Record<string, unknown> }>
    close: () => void
  } {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const waiters: Array<{
      predicate: (ev: { event: string; data: Record<string, unknown> }) => boolean
      resolve: (ev: { event: string; data: Record<string, unknown> }) => void
    }> = []

    let buffer = ''
    const req = http.request(
      {
        host: '127.0.0.1',
        port: this.port,
        path: `/stream${query}`,
        method: 'GET',
        headers: { 'x-troy-agent': this.token },
      },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawBlock = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            let eventName = 'message'
            const dataLines: string[] = []
            for (const line of rawBlock.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            if (dataLines.length === 0) continue
            try {
              const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
              const ev = { event: eventName, data }
              events.push(ev)
              for (let i = waiters.length - 1; i >= 0; i--) {
                const w = waiters[i]!
                if (w.predicate(ev)) {
                  waiters.splice(i, 1)
                  w.resolve(ev)
                }
              }
            } catch {
              // ignore non-JSON keepalive comments
            }
          }
        })
      },
    )
    req.end()

    return {
      events,
      waitForEvent(predicate, timeoutMs = 4000) {
        const existing = events.find(predicate)
        if (existing) return Promise.resolve(existing)
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for SSE event after ${timeoutMs}ms (received ${events.length} events)`))
          }, timeoutMs)
          waiters.push({
            predicate,
            resolve: (ev) => {
              clearTimeout(timer)
              resolve(ev)
            },
          })
        })
      },
      close() {
        req.destroy()
      },
    }
  }
}

/**
 * Real wire-level MCP stdio client over PassThrough streams.
 * Supports both Content-Length and NDJSON framing modes.
 */
class McpStdioClient {
  private readonly stdin = new PassThrough()
  private readonly stdout = new PassThrough()
  private readonly parser: McpStdioFrameParser
  private readonly framing: ResolvedMcpFraming
  private readonly serverDone: Promise<void>
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private nextId = 1

  constructor(manager: BrowserManager, framing: ResolvedMcpFraming) {
    this.framing = framing
    this.parser = new McpStdioFrameParser(framing)
    this.serverDone = runMcpStdioServer(manager, this.stdin, this.stdout, { framing: 'auto' })

    this.stdout.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      const frames = this.parser.push(buf)
      for (const frame of frames) {
        if (!frame.ok) continue
        const msg = JSON.parse(frame.raw) as Record<string, unknown>
        if (typeof msg.id === 'number') {
          const resolver = this.pending.get(msg.id)
          if (resolver) {
            this.pending.delete(msg.id)
            resolver(msg)
          }
        }
      }
    })
  }

  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" (id=${id}) timed out`))
      }, 5000)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.stdin.write(encodeMcpMessage(payload, this.framing))
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    this.stdin.write(encodeMcpMessage(payload, this.framing))
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    raw: Record<string, unknown>
    text: string
    isError: boolean
    parsedJson: Record<string, unknown> | null
  }> {
    const raw = await this.request('tools/call', { name, arguments: args })
    const result = (raw.result ?? {}) as {
      content?: Array<{ type: string; text: string }>
      isError?: boolean
    }
    const text = result.content?.[0]?.text ?? ''
    let parsedJson: Record<string, unknown> | null = null
    try {
      parsedJson = JSON.parse(text) as Record<string, unknown>
    } catch {
      parsedJson = null
    }
    return {
      raw,
      text,
      isError: Boolean(result.isError),
      parsedJson,
    }
  }

  async close(): Promise<void> {
    this.stdin.end()
    await this.serverDone
  }
}

/**
 * Real wire-level Pipe REPL client over PassThrough streams.
 * In JSON mode, each command emits exactly one newline-delimited JSON object.
 */
class PipeJsonClient {
  private readonly stdin = new PassThrough()
  private readonly stdout = new PassThrough()
  private readonly replDone: Promise<void>
  private readonly queue: string[] = []
  private readonly waiters: Array<(line: string) => void> = []
  private buffer = ''

  constructor(manager: BrowserManager) {
    this.replDone = runPipeRepl(manager, {
      jsonMode: true,
      input: this.stdin,
      output: this.stdout,
    })
    this.stdout.setEncoding('utf8')
    this.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        const waiter = this.waiters.shift()
        if (waiter) waiter(line)
        else this.queue.push(line)
      }
    })
  }

  private nextLine(timeoutMs = 5000): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PipeJsonClient timed out after ${timeoutMs}ms`)), timeoutMs)
      this.waiters.push((line) => {
        clearTimeout(timer)
        resolve(line)
      })
    })
  }

  async send(lineOrObj: string | Record<string, unknown>): Promise<Record<string, unknown>> {
    const wire = typeof lineOrObj === 'string' ? lineOrObj : JSON.stringify(lineOrObj)
    this.stdin.write(`${wire}\n`)
    const out = await this.nextLine()
    return JSON.parse(out) as Record<string, unknown>
  }

  async close(): Promise<Record<string, unknown>> {
    const bye = await this.send('quit')
    await this.replDone
    return bye
  }
}

describe('M70: End-to-end multi-client interop (Dexter HTTP + MCP stdio + Pipe REPL)', () => {
  let fixtureServer: http.Server
  let baseUrl = ''
  let origin = ''
  let tmpDir = ''
  let endpointFile = ''
  let manager: BrowserManager
  let socket: AgentSocketServer
  let dexter: DexterHttpClient
  let mcpFramed: McpStdioClient
  let mcpNdjson: McpStdioClient
  let pipeJson: PipeJsonClient

  const savedConfigs: Array<{ project: string; env: string }> = []

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m70-interop-'))
    endpointFile = path.join(tmpDir, 'agent-endpoint.json')

    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/workspace/save' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf8')
          const params = new URLSearchParams(bodyStr)
          const project = params.get('project') ?? ''
          const env = params.get('env') ?? ''
          savedConfigs.push({ project, env })
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!doctype html>
          <html>
            <head><title>Config Saved</title></head>
            <body>
              <h1>Deployment Config Saved</h1>
              <p id="summary">Saved project ${project} for environment ${env}.</p>
              <a id="back-home" href="/">Back to Dashboard</a>
              <a id="back-workspace" href="/workspace">Back to Workspace</a>
            </body>
          </html>`)
        })
        return
      }

      if (url.pathname === '/workspace') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
        <html>
          <head>
            <title>Ops Workspace</title>
            <meta property="og:title" content="Troy Ops Workspace" />
            <meta property="og:type" content="website" />
          </head>
          <body>
            <h1>Ops Workspace</h1>
            <p>Configure deployment target and inspect active EC2 nodes.</p>
            <form aria-label="Deploy Config" action="/workspace/save" method="POST">
              <label for="project">Project Name</label>
              <input id="project" name="project" type="text" placeholder="atlas-api" />
              <label for="env">Target Environment</label>
              <select id="env" name="env">
                <option value="dev">Development</option>
                <option value="staging">Staging</option>
                <option value="prod">Production</option>
              </select>
              <button id="save-btn" type="submit">Save Config</button>
            </form>
            <table>
              <thead><tr><th>Service</th><th>Region</th><th>Status</th></tr></thead>
              <tbody>
                <tr><td>edge-proxy</td><td>us-east-1</td><td>healthy</td></tr>
                <tr><td>worker-pool</td><td>us-west-2</td><td>draining</td></tr>
              </tbody>
            </table>
            <a id="dash-link" href="/">Return Dashboard</a>
          </body>
        </html>`)
        return
      }

      if (url.pathname === '/search') {
        const q = url.searchParams.get('q') ?? ''
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
        <html>
          <head><title>Search: ${q}</title></head>
          <body>
            <h1>Search Results for ${q}</h1>
            <p>Found 1 matching runbook for ${q}.</p>
            <a href="/workspace">Open Ops Workspace</a>
          </body>
        </html>`)
        return
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Control Plane Dashboard</title></head>
        <body>
          <h1>Control Plane Dashboard</h1>
          <p>Unified portal for HTTP, MCP, and Pipe agents.</p>
          <nav>
            <a id="ws-link" href="/workspace">Open Ops Workspace</a>
            <a id="docs-link" href="/search?q=runbook">Browse Runbooks</a>
          </nav>
          <form aria-label="Quick Auth" action="/workspace/save" method="POST">
            <label for="pin">Secret PIN</label>
            <input id="pin" name="password" type="password" />
            <button id="auth-btn" type="submit">Unlock</button>
          </form>
        </body>
      </html>`)
    })

    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = fixtureServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    origin = `http://127.0.0.1:${port}`
    baseUrl = origin

    manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: tmpDir,
      audit: { enabled: true },
    })
    socket = await createAgentSocket(manager)

    writeEndpoint(endpointFile, {
      version: 1,
      pid: process.pid,
      engine: manager.engine.kind,
      cdpPort: 0,
      httpEndpoint: '',
      webSocketDebuggerUrlHint: '',
      agentPort: socket.port,
      agentToken: socket.token,
      profileDir: tmpDir,
      startedAt: new Date().toISOString(),
    })

    dexter = DexterHttpClient.fromEndpointFile(endpointFile)
    mcpFramed = new McpStdioClient(manager, 'content-length')
    mcpNdjson = new McpStdioClient(manager, 'ndjson')
    pipeJson = new PipeJsonClient(manager)
  })

  afterAll(async () => {
    await pipeJson.close()
    await mcpFramed.close()
    await mcpNdjson.close()
    await socket.close()
    clearEndpoint(endpointFile)
    await manager.close()
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('1. Dexter HTTP client discovers agent-endpoint.json (0o600), enforces auth, and opens the dashboard', async () => {
    const stat = fs.statSync(endpointFile)
    expect(stat.mode & 0o777).toBe(0o600)

    // Missing or wrong token must be rejected
    const noAuth = await dexter.post('/health', {}, { token: null })
    expect(noAuth.status).toBe(401)
    const badAuth = await dexter.post('/health', {}, { token: 'wrong-token' })
    expect(badAuth.status).toBe(401)

    // Valid token succeeds
    const health = await dexter.post('/health')
    expect(health.status).toBe(200)
    expect(health.json.ok).toBe(true)
    expect(health.json.engine).toBe('lite')

    // Open dashboard via Dexter HTTP client
    const opened = await dexter.post('/open', { url: `${baseUrl}/`, activate: true })
    expect(opened.status).toBe(200)
    expect(opened.json.ok).toBe(true)
    expect(typeof opened.json.id).toBe('number')

    const asciiRes = await dexter.post('/ascii', { width: 90 })
    expect(asciiRes.status).toBe(200)
    expect(asciiRes.json.ok).toBe(true)
    expect(String(asciiRes.json.ascii)).toContain('Control Plane Dashboard')
    expect(String(asciiRes.json.ascii)).toContain('Open Ops Workspace')
  })

  it('2. MCP stdio clients (both Content-Length & NDJSON) handshake and share live state with Dexter HTTP', async () => {
    // Content-Length framed MCP client handshake
    const initFramed = await mcpFramed.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'dexter-mcp-framed', version: '1.0.0' },
      capabilities: {},
    })
    expect((initFramed.result as Record<string, unknown>).protocolVersion).toBeTruthy()
    mcpFramed.notify('notifications/initialized')

    // NDJSON framed MCP client handshake
    const initNdjson = await mcpNdjson.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'dexter-mcp-ndjson', version: '1.0.0' },
      capabilities: {},
    })
    expect((initNdjson.result as Record<string, unknown>).protocolVersion).toBeTruthy()

    // MCP tools/list, resources/list, prompts/list all advertise capabilities
    const toolsList = await mcpFramed.request('tools/list')
    const tools = (toolsList.result as { tools: Array<{ name: string }> }).tools
    expect(tools.some((t) => t.name === 'troy_read_ascii')).toBe(true)
    expect(tools.some((t) => t.name === 'troy_find')).toBe(true)
    expect(tools.some((t) => t.name === 'troy_extract')).toBe(true)

    // MCP sees the exact tab opened by Dexter HTTP client via both tool and resource
    const mcpTabs = await mcpFramed.callTool('troy_tabs')
    expect(mcpTabs.isError).toBe(false)
    const tabs = (mcpTabs.parsedJson?.tabs ?? []) as Array<{ id: number; url: string; active: boolean }>
    expect(tabs.length).toBeGreaterThanOrEqual(1)
    expect(tabs.some((t) => t.url === `${baseUrl}/` && t.active)).toBe(true)

    const tabsResource = await mcpNdjson.request('resources/read', { uri: 'troy://tabs' })
    const resContents = (tabsResource.result as { contents: Array<{ text: string }> }).contents
    expect(resContents[0]?.text).toContain(`${baseUrl}/`)

    const asciiResource = await mcpFramed.request('resources/read', { uri: 'troy://active/ascii' })
    const activeAsciiText = (asciiResource.result as { contents: Array<{ text: string }> }).contents[0]?.text ?? ''
    expect(activeAsciiText).toContain('Control Plane Dashboard')
  })

  it('3. Cross-client navigation & SSE live broadcast: MCP clicks link -> Pipe & Dexter HTTP observe /workspace', async () => {
    // Attach an SSE stream subscriber from Dexter HTTP client before MCP navigates
    const sse = dexter.openSseStream('?width=90')
    try {
      await sse.waitForEvent((ev) => ev.event === 'ascii_frame' || ev.event === 'connected')

      // MCP finds the "Open Ops Workspace" link with smart role filter and clicks it
      const found = await mcpFramed.callTool('troy_find', { query: 'Ops Workspace', role: 'link' })
      expect(found.isError).toBe(false)
      const matches = (found.parsedJson?.matches ?? []) as Array<{ ref: string; text: string }>
      expect(matches.length).toBeGreaterThan(0)
      const wsRef = matches[0]!.ref

      // Grant origin via Pipe REPL (plain command over JSON-mode stream)
      const grantRes = await pipeJson.send(`grant ${origin}`)
      expect(grantRes.ok).toBe(true)

      // MCP clicks the workspace link
      const clicked = await mcpFramed.callTool('troy_click', { ref: wsRef })
      expect(clicked.isError).toBe(false)
      expect(clicked.parsedJson?.ok).toBe(true)

      // SSE subscriber receives live ASCII frame for /workspace triggered by MCP's click
      const frameEv = await sse.waitForEvent(
        (ev) => ev.event === 'ascii_frame' && String(ev.data.url ?? '').includes('/workspace'),
      )
      expect(String(frameEv.data.ascii ?? '')).toContain('Ops Workspace')

      // Pipe REPL immediately sees /workspace via structured NDJSON command
      const pipeAscii = await pipeJson.send({ cmd: 'read_ascii', width: 90 })
      expect(pipeAscii.ok).toBe(true)
      expect(String(pipeAscii.ascii)).toContain('Ops Workspace')
      expect(String(pipeAscii.ascii)).toContain('edge-proxy')

      // Dexter HTTP delta read (`since: true`) observes the synchronized snapshot state cleanly
      const deltaRes = await dexter.post('/ascii', { since: true, width: 90 })
      expect(deltaRes.status).toBe(200)
      expect(deltaRes.json.ok).toBe(true)
      expect(String(deltaRes.json.ascii)).toContain('TROY-ADV DELTA')
      expect(String(deltaRes.json.ascii)).toContain('/workspace')
    } finally {
      sse.close()
    }
  })

  it('4. Cross-client form fill + select + submit guard handoff (MCP fill -> Pipe select -> Dexter HTTP submit)', async () => {
    // MCP extracts structured data (tables, forms, OpenGraph) from /workspace
    const extracted = await mcpNdjson.callTool('troy_extract', { sections: ['tables', 'forms', 'metadata'] })
    expect(extracted.isError).toBe(false)
    const tables = (extracted.parsedJson?.tables ?? []) as Array<{ headers: string[]; rows: string[][] }>
    expect(tables.length).toBe(1)
    expect(tables[0]?.headers).toEqual(['Service', 'Region', 'Status'])

    // MCP locates the Project Name input and fills it
    const findProject = await mcpFramed.callTool('troy_find', { query: 'Project Name', role: 'input' })
    const projectRef = ((findProject.parsedJson?.matches ?? []) as Array<{ ref: string }>)[0]?.ref
    expect(projectRef).toMatch(/^e\d+$/)

    const fillProject = await mcpFramed.callTool('troy_fill', { ref: projectRef, text: 'hyperion-core' })
    expect(fillProject.isError).toBe(false)
    expect(fillProject.parsedJson?.ok).toBe(true)

    // Pipe REPL finds the Target Environment <select> and selects 'prod'
    const findEnv = await pipeJson.send('find Target Environment --select')
    expect(findEnv.ok).toBe(true)
    const envRef = ((findEnv.matches ?? []) as Array<{ ref: string }>)[0]?.ref
    expect(envRef).toMatch(/^e\d+$/)

    const selectEnv = await pipeJson.send({ cmd: 'select', ref: envRef, value: 'prod' })
    expect(selectEnv.ok).toBe(true)

    // Dexter HTTP client finds the submit button and verifies submit guard refusal without allowSubmit
    const findSave = await dexter.post('/tool', {
      name: 'page_find',
      args: { query: 'Save Config', role: 'button' },
    })
    expect(findSave.json.ok).toBe(true)
    const saveRef = ((findSave.json.matches ?? []) as Array<{ ref: string }>)[0]?.ref
    expect(saveRef).toMatch(/^e\d+$/)

    const refusedSubmit = await dexter.post('/tool', {
      name: 'page_click',
      args: { ref: saveRef },
    })
    expect(refusedSubmit.json.ok).toBe(false)
    expect(String(refusedSubmit.json.error ?? '')).toMatch(/submit/i)

    // Dexter HTTP client retries with allowSubmit: true -> form submits to server
    const allowedSubmit = await dexter.post('/tool', {
      name: 'page_click',
      args: { ref: saveRef, allowSubmit: true },
    })
    expect(allowedSubmit.json.ok).toBe(true)
    expect(savedConfigs).toEqual([{ project: 'hyperion-core', env: 'Production' }])

    // All three clients observe the confirmation page
    const httpConfirm = await dexter.post('/ascii', { width: 90 })
    const mcpConfirm = await mcpFramed.callTool('troy_read_ascii', { width: 90 })
    const pipeConfirm = await pipeJson.send('ascii 90')

    expect(String(httpConfirm.json.ascii)).toContain('Saved project hyperion-core for environment Production.')
    expect(mcpConfirm.text).toContain('Saved project hyperion-core for environment Production.')
    expect(String(pipeConfirm.ascii)).toContain('Saved project hyperion-core for environment Production.')
  })

  it('5. Consistent safety refusals (password field) across HTTP, MCP, and Pipe REPL', async () => {
    // Navigate back to dashboard via Pipe REPL (plain text command)
    const openDash = await pipeJson.send(`open ${baseUrl}/`)
    expect(openDash.ok).toBe(true)

    const foundPw = await dexter.post('/tool', {
      name: 'page_find',
      args: { query: 'Secret PIN' },
    })
    const pwRef = ((foundPw.json.matches ?? []) as Array<{ ref: string }>)[0]?.ref
    expect(pwRef).toMatch(/^e\d+$/)

    // 1) Dexter HTTP refusal
    const httpPw = await dexter.post('/tool', {
      name: 'page_fill',
      args: { ref: pwRef, text: '123456' },
    })
    expect(httpPw.json.ok).toBe(false)
    expect(String(httpPw.json.error ?? '')).toMatch(/sensitive|password/i)

    // 2) MCP refusal
    const mcpPw = await mcpFramed.callTool('troy_fill', { ref: pwRef, text: '123456' })
    expect(mcpPw.isError).toBe(true)
    expect(String(mcpPw.parsedJson?.error ?? '')).toMatch(/sensitive|password/i)

    // 3) Pipe REPL refusal
    const pipePw = await pipeJson.send(`fill ${pwRef} 123456`)
    expect(pipePw.ok).toBe(false)
    expect(String(pipePw.error ?? '')).toMatch(/sensitive|password/i)
  })

  it('6. Shared Page Memory recall, multi-agent session isolation, unified audit log, and plain-ASCII Pipe REPL', async () => {
    // Navigate to /workspace so live DOM matches remembered elements from earlier
    const openWs = await dexter.post('/open', { url: `${baseUrl}/workspace`, activate: true })
    expect(openWs.json.ok).toBe(true)
    const wsTabId = Number(openWs.json.id)

    // MCP reads troy://memory/stats resource and sees recorded pages/elements/actions
    const memStatsRes = await mcpFramed.request('resources/read', { uri: 'troy://memory/stats' })
    const memStatsJson = JSON.parse(
      (memStatsRes.result as { contents: Array<{ text: string }> }).contents[0]?.text ?? '{}',
    ) as { enabled?: boolean; pages?: number; elements?: number; actions?: number }
    expect(memStatsJson.enabled).toBe(true)
    expect((memStatsJson.pages ?? 0)).toBeGreaterThanOrEqual(1)

    // Dexter HTTP recalls with live auto-binding on the workspace tab
    const httpRecall = await dexter.post('/recall', {
      query: 'project',
      origin,
      tabId: wsTabId,
      bind: true,
    })
    expect(httpRecall.status).toBe(200)
    expect(httpRecall.json.ok).toBe(true)

    // MCP recalls from the exact same memory store
    const mcpRecall = await mcpNdjson.callTool('troy_recall', {
      query: 'project',
      origin,
      tabId: wsTabId,
    })
    expect(mcpRecall.isError).toBe(false)
    expect(mcpRecall.parsedJson?.ok).toBe(true)

    // Multi-agent session isolation via Dexter HTTP `x-troy-session`
    const sessOpen = await dexter.post(
      '/open',
      { url: `${baseUrl}/search?q=isolation`, activate: false },
      { sessionId: 'dexter-worker-alpha' },
    )
    expect(sessOpen.status).toBe(200)
    expect(sessOpen.json.ok).toBe(true)
    const sessTabId = Number(sessOpen.json.id)

    const sessList = await dexter.post('/sessions')
    expect(sessList.json.ok).toBe(true)
    const sessions = (sessList.json.sessions ?? []) as Array<{ id: string; ownedTabIds: number[] }>
    const alpha = sessions.find((s) => s.id === 'dexter-worker-alpha')
    expect(alpha).toBeTruthy()
    expect(alpha?.ownedTabIds).toContain(sessTabId)

    // Unified audit log captures actions across HTTP, MCP, and Pipe
    const audit = await dexter.post('/audit', { limit: 100 })
    expect(audit.status).toBe(200)
    expect(audit.json.ok).toBe(true)
    const entries = (audit.json.entries ?? []) as Array<{ kind: string; tool?: string; ok: boolean }>
    expect(entries.length).toBeGreaterThanOrEqual(5)
    expect(entries.some((e) => e.tool === 'page_fill' && e.ok === true)).toBe(true)
    expect(entries.some((e) => e.tool === 'page_fill' && e.ok === false)).toBe(true)
    expect(entries.some((e) => e.tool === 'page_click' && e.ok === true)).toBe(true)

    // Close the isolated session cleanly
    const sessClose = await dexter.post('/sessions', { sessionId: 'dexter-worker-alpha', close: true })
    expect(sessClose.json.ok).toBe(true)

    // Verify plain-ASCII (non-JSON) Pipe REPL stream also works cleanly on the shared manager
    const plainIn = new PassThrough()
    const plainOut = new PassThrough()
    const chunks: string[] = []
    plainOut.setEncoding('utf8')
    plainOut.on('data', (c: string) => chunks.push(c))

    const plainDone = runPipeRepl(manager, { jsonMode: false, input: plainIn, output: plainOut })
    plainIn.write('help\n')
    plainIn.write('ascii 80\n')
    plainIn.write('quit\n')
    plainIn.end()
    await plainDone

    const plainOutput = chunks.join('')
    expect(plainOutput).toContain('COMMANDS:')
    expect(plainOutput).toContain('Ops Workspace')
    expect(plainOutput).toContain('BYE')
  })

  it('7. Cross-client loop guard consistency, MCP prompts, and per-tab resource templates', async () => {
    // Open a fresh search tab via Dexter HTTP
    const opened = await dexter.post('/open', { url: `${baseUrl}/search?q=interop`, activate: true })
    expect(opened.json.ok).toBe(true)
    const searchTabId = Number(opened.json.id)

    // MCP reads the parameterized resource template troy://tabs/{tabId}/ascii for that exact HTTP-opened tab
    const tabAsciiRes = await mcpFramed.request('resources/read', {
      uri: `troy://tabs/${searchTabId}/ascii`,
    })
    const tabAsciiText = (tabAsciiRes.result as { contents: Array<{ text: string }> }).contents[0]?.text ?? ''
    expect(tabAsciiText).toContain('SEARCH RESULTS FOR INTEROP')
    expect(tabAsciiText).toContain('Found 1 matching runbook for interop.')

    // MCP prompts/get returns structured workflow instructions
    const promptRes = await mcpNdjson.request('prompts/get', {
      name: 'browse_and_extract',
      arguments: { url: `${baseUrl}/workspace`, goal: 'Extract active services table' },
    })
    const messages = (promptRes.result as { messages: Array<{ role: string; content: { text: string } }> }).messages
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0]?.content.text).toContain(`${baseUrl}/workspace`)

    // Trigger identical failing clicks on a non-existent ref across HTTP -> MCP -> Pipe
    // to prove the shared loop guard detects repeated failures across clients
    const fail1 = await dexter.post('/tool', { name: 'page_click', args: { ref: 'e9999' }, tabId: searchTabId })
    expect(fail1.json.ok).toBe(false)

    const fail2 = await mcpFramed.callTool('troy_click', { ref: 'e9999', tabId: searchTabId })
    expect(fail2.isError).toBe(true)

    const fail3 = await pipeJson.send({ cmd: 'click', ref: 'e9999', tabId: searchTabId })
    expect(fail3.ok).toBe(false)
    expect(fail3.loopGuard).toBeTruthy()
    const lg = fail3.loopGuard as { detected: boolean; repeatCount: number; recoveryHints: string[] }
    expect(lg.detected).toBe(true)
    expect(lg.repeatCount).toBeGreaterThanOrEqual(3)
    expect(lg.recoveryHints.length).toBeGreaterThan(0)

    // Loop guard status is visible via Agent Socket /loop-guard and /health
    const lgStatus = await dexter.post('/loop-guard')
    expect(lgStatus.status).toBe(200)
    expect(lgStatus.json.ok).toBe(true)
    const stats = lgStatus.json.stats as { trackedPatterns: number; warningsIssued: number }
    expect(stats.trackedPatterns).toBeGreaterThanOrEqual(1)
    expect(stats.warningsIssued).toBeGreaterThanOrEqual(1)
  })
})
