import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  ReadonlyObserverGuard,
  authorizeAction,
  createAgentSocket,
  executePipeCommand,
  formatReadonlyAscii,
  handleMcpRequest,
  isMutatingEndpoint,
  isMutatingTool,
  normalizeReadonlyToolName,
  parseReadonlyBoolean,
} from '../src/index.js'

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>Observer Dashboard</title></head>
  <body>
    <h1>System Status</h1>
    <p>All metrics nominal.</p>
    <form action="/submit" method="post">
      <label for="note">Note</label>
      <input id="note" name="note" type="text" value="initial" />
      <label for="env">Environment</label>
      <select id="env" name="env">
        <option value="prod" selected>Prod</option>
        <option value="staging">Staging</option>
      </select>
      <button id="save-btn" type="submit">Save Note</button>
    </form>
    <a id="other-link" href="/other">Go Other</a>
  </body>
</html>`

const OTHER_HTML = `<!doctype html>
<html>
  <head><title>Other Page</title></head>
  <body><h1>Other Page</h1></body>
</html>`

let server: http.Server
let baseUrl: string
let postCount = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      postCount += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Submitted</title></head><body><h1>Submitted</h1></body></html>')
      return
    }
    if (req.url === '/other') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(OTHER_HTML)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function tempProfile(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `troy-readonly-${prefix}-`))
}

describe('M78: Read-only observer mode (--readonly) unit classification', () => {
  it('classifies all mutating tools and aliases deterministically', () => {
    const mutatingNames = [
      'page_click',
      'click',
      'troy_click',
      'page_fill',
      'fill',
      'troy_fill',
      'page_select',
      'select',
      'page_press',
      'press',
      'page_hover',
      'hover',
      'page_eval',
      'eval',
      'page_navigate',
      'navigate',
      'page_history',
      'back',
      'forward',
      'reload',
      'tab_open',
      'open',
      'troy_open',
      'tab_close',
      'close',
      'origin_grant',
      'grant',
      'memory_forget',
      'forget',
      'cookies_import',
      'cookies_clear',
      'storage_import',
      'storage_clear',
    ]

    for (const name of mutatingNames) {
      const check = isMutatingTool(name)
      expect(check.mutating, `expected ${name} to be mutating`).toBe(true)
      expect(check.reason).toContain('--readonly')
    }
  })

  it('allows passive read-only observation tools', () => {
    const readonlyNames = [
      'page_read',
      'page_read_visual',
      'page_read_ascii',
      'page_read_markdown',
      'page_find',
      'page_recall',
      'page_text',
      'page_extract',
      'page_screenshot',
      'page_screenshot_ascii',
      'page_scroll',
      'page_wait',
      'page_network_body',
    ]

    for (const name of readonlyNames) {
      const check = isMutatingTool(name)
      expect(check.mutating, `expected ${name} to be read-only`).toBe(false)
    }
  })

  it('distinguishes read-only vs mutating steps inside page_act', () => {
    expect(
      isMutatingTool('page_act', {
        steps: [
          { op: 'scroll', direction: 'down' },
          { op: 'wait', ms: 10 },
          { op: 'read_ascii' },
          { op: 'text' },
        ],
      }).mutating,
    ).toBe(false)

    const withClick = isMutatingTool('page_act', {
      steps: [
        { op: 'scroll', direction: 'down' },
        { op: 'click', ref: 'e1' },
      ],
    })
    expect(withClick.mutating).toBe(true)
    expect(withClick.reason).toContain('step #1')
    expect(withClick.reason).toContain('page_click')

    const withFill = isMutatingTool('page_act', {
      steps: [{ op: 'fill', ref: 'e1', text: 'hello' }],
    })
    expect(withFill.mutating).toBe(true)
    expect(withFill.reason).toContain('page_fill')
  })

  it('distinguishes read-only inspection vs mutating updates on conditional tools', () => {
    expect(isMutatingTool('page_emulate', {}).mutating).toBe(false)
    expect(isMutatingTool('page_emulate', { revealHeaders: false }).mutating).toBe(false)
    expect(isMutatingTool('page_emulate', { viewport: 'mobile' }).mutating).toBe(true)
    expect(isMutatingTool('page_emulate', { clearHeaders: true }).mutating).toBe(true)

    expect(isMutatingTool('page_dialogs', { limit: 10 }).mutating).toBe(false)
    expect(isMutatingTool('page_dialogs', { clear: true }).mutating).toBe(true)
    expect(isMutatingTool('page_dialogs', { mode: 'accept' }).mutating).toBe(true)

    expect(isMutatingTool('page_downloads', { limit: 10 }).mutating).toBe(false)
    expect(isMutatingTool('page_downloads', { clear: true }).mutating).toBe(true)
    expect(isMutatingTool('page_downloads', { mode: 'block' }).mutating).toBe(true)

    expect(isMutatingTool('page_console', { limit: 10 }).mutating).toBe(false)
    expect(isMutatingTool('page_console', { clear: true }).mutating).toBe(true)

    expect(isMutatingTool('page_network', { limit: 10 }).mutating).toBe(false)
    expect(isMutatingTool('page_network', { clear: true }).mutating).toBe(true)
  })

  it('classifies Agent Socket endpoints accurately', () => {
    expect(isMutatingEndpoint('/open').mutating).toBe(true)
    expect(isMutatingEndpoint('/close').mutating).toBe(true)
    expect(isMutatingEndpoint('/grant-origin').mutating).toBe(true)
    expect(isMutatingEndpoint('/forget').mutating).toBe(true)
    expect(isMutatingEndpoint('/cookies/import').mutating).toBe(true)
    expect(isMutatingEndpoint('/cookies/clear').mutating).toBe(true)
    expect(isMutatingEndpoint('/storage/import').mutating).toBe(true)
    expect(isMutatingEndpoint('/storage/clear').mutating).toBe(true)
    expect(isMutatingEndpoint('/audit', { clear: true }).mutating).toBe(true)
    expect(isMutatingEndpoint('/loop-guard', { reset: true }).mutating).toBe(true)
    expect(isMutatingEndpoint('/sessions', { close: true }).mutating).toBe(true)

    expect(isMutatingEndpoint('/health').mutating).toBe(false)
    expect(isMutatingEndpoint('/ascii').mutating).toBe(false)
    expect(isMutatingEndpoint('/markdown').mutating).toBe(false)
    expect(isMutatingEndpoint('/extract').mutating).toBe(false)
    expect(isMutatingEndpoint('/tabs').mutating).toBe(false)
    expect(isMutatingEndpoint('/audit', { limit: 10 }).mutating).toBe(false)
    expect(isMutatingEndpoint('/loop-guard', {}).mutating).toBe(false)
    expect(isMutatingEndpoint('/sessions', {}).mutating).toBe(false)
  })

  it('tracks refusal stats and renders ASCII summary', () => {
    expect(normalizeReadonlyToolName('CLICK')).toBe('page_click')
    expect(parseReadonlyBoolean('true')).toBe(true)
    expect(parseReadonlyBoolean('0')).toBe(false)
    expect(parseReadonlyBoolean('maybe')).toBeUndefined()

    const guard = new ReadonlyObserverGuard(true)
    expect(guard.enabled).toBe(true)
    expect(guard.checkTool('page_read_ascii')).toEqual({ allowed: true })

    const d1 = guard.checkTool('page_click', { ref: 'e1' }, { tabId: 1 })
    expect(d1.allowed).toBe(false)
    if (!d1.allowed) {
      expect(d1.status).toBe('blocked')
      expect(d1.code).toBe('readonly')
    }
    guard.checkTool('page_fill', { ref: 'e2', text: 'x' }, { tabId: 1 })
    guard.checkTool('page_click', { ref: 'e3' }, { tabId: 1 })

    const stats = guard.getStats()
    expect(stats.enabled).toBe(true)
    expect(stats.blockedCount).toBe(3)
    expect(stats.blockedByTool).toEqual({ page_click: 2, page_fill: 1 })
    expect(stats.recentBlocked).toHaveLength(3)

    const ascii = formatReadonlyAscii(stats)
    expect(ascii).toContain('Read-Only Observer Mode')
    expect(ascii).toContain('YES (--readonly)')
    expect(ascii).toContain('page_click=2')
  })

  it('authorizeAction deterministically refuses mutating tools even under permissive policy', () => {
    for (const tool of ['page_click', 'page_fill', 'page_eval', 'page_navigate']) {
      const decision = authorizeAction({
        name: tool,
        targetUrl: 'https://example.com',
        currentUrl: 'https://example.com',
        allowSubmit: true,
        allowedOrigins: ['https://example.com'],
        readonly: true,
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.status).toBe('blocked')
        expect(decision.code).toBe('readonly')
      }
    }
  })
})

describe('M78: Read-only observer mode E2E across BrowserManager, Agent Socket, MCP, and Pipe', () => {
  it('allows read-only observation while refusing all mutating tools and recording audit entries', async () => {
    const profileDir = tempProfile('manager')
    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir,
      readonly: true,
      policy: 'permissive', // Even with permissive policy, --readonly MUST refuse all mutations
    })

    try {
      expect(manager.isReadonly).toBe(true)

      // Daemon/owner initial page load uses bypassReadonly: true
      const opened = await manager.openTab(baseUrl, { activate: true, bypassReadonly: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.id!

      // Read-only tools succeed
      const asciiRes = await manager.runTool(tabId, 'page_read_ascii', { width: 80 })
      expect(asciiRes.ok).toBe(true)
      expect(String(asciiRes.ascii)).toContain('SYSTEM STATUS')

      const readRes = await manager.runTool(tabId, 'page_read', {})
      expect(readRes.ok).toBe(true)

      const mdRes = await manager.runTool(tabId, 'page_read_markdown', {})
      expect(mdRes.ok).toBe(true)

      const findRes = await manager.runTool(tabId, 'page_find', { query: 'Save Note' })
      expect(findRes.ok).toBe(true)

      const extractRes = await manager.runTool(tabId, 'page_extract', { sections: ['headings', 'forms', 'links'] })
      expect(extractRes.ok).toBe(true)

      const textRes = await manager.runTool(tabId, 'page_text', {})
      expect(textRes.ok).toBe(true)

      const scrollRes = await manager.runTool(tabId, 'page_scroll', { direction: 'down' })
      expect(scrollRes.ok).toBe(true)

      const waitRes = await manager.runTool(tabId, 'page_wait', { ms: 5 })
      expect(waitRes.ok).toBe(true)

      const emulateReadRes = await manager.runTool(tabId, 'page_emulate', {})
      expect(emulateReadRes.ok).toBe(true)

      const actReadonlyRes = await manager.runTool(tabId, 'page_act', {
        steps: [{ op: 'scroll', direction: 'top' }, { op: 'read_ascii' }],
      })
      expect(actReadonlyRes.ok).toBe(true)

      const postsBefore = postCount

      // All mutating tools MUST be deterministically refused with status: 'blocked', code: 'readonly'
      const mutatingCalls: Array<[string, Record<string, unknown>]> = [
        ['page_click', { ref: 'e3', allowSubmit: true }],
        ['page_fill', { ref: 'e1', text: 'mutated' }],
        ['page_select', { ref: 'e2', value: 'staging' }],
        ['page_press', { key: 'Enter' }],
        ['page_hover', { ref: 'e3' }],
        ['page_eval', { expression: 'document.title = "pwned"' }],
        ['page_navigate', { url: `${baseUrl}/other` }],
        ['page_history', { action: 'reload' }],
        ['page_act', { steps: [{ op: 'scroll', direction: 'down' }, { op: 'click', ref: 'e3', allowSubmit: true }] }],
        ['page_emulate', { viewport: 'mobile' }],
        ['page_console', { clear: true }],
        ['page_network', { clear: true }],
      ]

      for (const [tool, args] of mutatingCalls) {
        const res = await manager.runTool(tabId, tool, args)
        expect(res.ok, `expected ${tool} to be refused`).toBe(false)
        expect(res.status, `expected ${tool} status=blocked`).toBe('blocked')
        expect(res.code, `expected ${tool} code=readonly`).toBe('readonly')
        expect(String(res.error)).toContain('--readonly')
      }

      // Direct manager state-mutating calls without bypassReadonly are also refused
      const openDenied = await manager.openTab(`${baseUrl}/other`)
      expect(openDenied.ok).toBe(false)
      expect(openDenied.status).toBe('blocked')
      expect(openDenied.code).toBe('readonly')

      const closeDenied = await manager.closeTab(tabId)
      expect(closeDenied.ok).toBe(false)
      expect(closeDenied.status).toBe('blocked')
      expect(closeDenied.code).toBe('readonly')

      const grantDenied = manager.grantOrigin('https://example.com')
      expect(grantDenied.ok).toBe(false)
      expect(grantDenied.status).toBe('blocked')
      expect(grantDenied.code).toBe('readonly')

      // Verify zero side effects occurred
      expect(postCount).toBe(postsBefore)
      expect(manager.listTabs()).toHaveLength(1)
      expect(manager.listTabs()[0]!.url).toBe(`${baseUrl}/`)

      // Verify stats and audit log captured the refusals
      const stats = manager.getReadonlyStats()
      expect(stats.enabled).toBe(true)
      expect(stats.blockedCount).toBe(mutatingCalls.length + 3)

      const auditEntries = manager.getAuditLog({ refusedOnly: true, limit: 50 })
      const readonlyAudit = auditEntries.filter((e) => e.refusal?.code === 'readonly')
      expect(readonlyAudit.length).toBeGreaterThanOrEqual(mutatingCalls.length + 3)
    } finally {
      await manager.close()
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('enforces read-only mode on Agent Socket HTTP, MCP, and Pipe REPL', async () => {
    const profileDir = tempProfile('bridge')
    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir,
      readonly: true,
    })
    const opened = await manager.openTab(baseUrl, { activate: true, bypassReadonly: true })
    const tabId = opened.id!
    const socket = await createAgentSocket(manager, { port: 0 })

    const post = async (pathname: string, body: Record<string, unknown> = {}) => {
      const res = await fetch(`http://127.0.0.1:${socket.port}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-troy-agent': socket.token,
        },
        body: JSON.stringify(body),
      })
      return (await res.json()) as Record<string, unknown>
    }

    try {
      // 1. Agent Socket GET /health exposes readonly stats
      const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        headers: { 'x-troy-agent': socket.token },
      })
      const health = (await healthRes.json()) as Record<string, unknown>
      expect(health.ok).toBe(true)
      expect((health.readonly as { enabled: boolean }).enabled).toBe(true)

      // 2. Agent Socket read endpoints succeed
      const asciiHttp = await post('/ascii', { tabId, width: 80 })
      expect(asciiHttp.ok).toBe(true)
      expect(String(asciiHttp.ascii)).toContain('SYSTEM STATUS')

      const tabsHttp = await post('/tabs', {})
      expect(tabsHttp.ok).toBe(true)

      // 3. Agent Socket mutating /tool calls refused
      for (const tool of ['page_click', 'page_fill', 'page_eval', 'page_navigate']) {
        const res = await post('/tool', {
          tabId,
          name: tool,
          args: { ref: 'e1', text: 'abc', expression: '1+1', url: `${baseUrl}/other` },
        })
        expect(res.ok).toBe(false)
        expect(res.status).toBe('blocked')
        expect(res.code).toBe('readonly')
      }

      // 4. Agent Socket mutating direct endpoints refused
      for (const [pathname, body] of [
        ['/open', { url: `${baseUrl}/other` }],
        ['/close', { tabId }],
        ['/grant-origin', { origin: 'https://example.com' }],
        ['/forget', {}],
        ['/cookies/import', { cookies: [] }],
        ['/cookies/clear', {}],
        ['/storage/import', { origins: [] }],
        ['/storage/clear', {}],
        ['/emulation', { viewport: 'mobile' }],
        ['/audit', { clear: true }],
        ['/loop-guard', { reset: true }],
      ] as Array<[string, Record<string, unknown>]>) {
        const res = await post(pathname, body)
        expect(res.ok, `expected ${pathname} to be refused`).toBe(false)
        expect(res.status, `expected ${pathname} status=blocked`).toBe('blocked')
        expect(res.code, `expected ${pathname} code=readonly`).toBe('readonly')
      }

      // 5. MCP server read succeeds, mutating calls refused
      const mcpRead = await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'troy_read_ascii', arguments: { tabId, width: 80 } },
      })
      expect(mcpRead.error).toBeUndefined()

      for (const [mcpTool, mcpArgs] of [
        ['troy_click', { tabId, ref: 'e3', allowSubmit: true }],
        ['troy_fill', { tabId, ref: 'e1', text: 'nope' }],
        ['troy_open', { url: `${baseUrl}/other` }],
        ['troy_grant', { origin: 'https://example.com' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const resp = await handleMcpRequest(manager, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: mcpTool, arguments: mcpArgs },
        })
        const content = (resp.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? ''
        const parsed = JSON.parse(content) as Record<string, unknown>
        expect(parsed.ok, `expected MCP ${mcpTool} to be refused`).toBe(false)
        expect(parsed.status).toBe('blocked')
        expect(parsed.code).toBe('readonly')
      }

      // 6. Pipe REPL read succeeds, mutating commands refused
      const pipeRead = await executePipeCommand(manager, 'ascii 80', { jsonMode: true })
      expect(JSON.parse(pipeRead.output).ok).toBe(true)

      for (const cmd of ['click e3 --submit', 'fill e1 test', `open ${baseUrl}/other`, 'grant https://example.com']) {
        const pipeMut = await executePipeCommand(manager, cmd, { jsonMode: true })
        const parsed = JSON.parse(pipeMut.output) as Record<string, unknown>
        expect(parsed.ok, `expected pipe "${cmd}" to be refused`).toBe(false)
        expect(parsed.status).toBe('blocked')
        expect(parsed.code).toBe('readonly')
      }
    } finally {
      await socket.close()
      await manager.close()
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })
})
