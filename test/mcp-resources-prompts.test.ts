import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_RESOURCE_TEMPLATES,
  handleMcpRequest,
  runMcpStdioServer,
} from '../src/mcp/server.js'

function isStrict7BitAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) return false
  }
  return true
}

describe('M56: Full MCP resources and prompts', () => {
  let server: http.Server
  let baseUrl: string
  let tmpRoot: string

  const freshProfile = () => fs.mkdtempSync(path.join(tmpRoot, 'prof-'))

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-mcp-m56-'))
    server = http.createServer((req, res) => {
      if (req.url === '/page-a') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html>
            <head><title>Page Alpha</title></head>
            <body>
              <h1>Alpha Dashboard</h1>
              <p>Welcome to Troy MCP resource test.</p>
              <a href="/page-b">Go to Beta</a>
              <form action="/submit" method="post">
                <label for="q">Query</label>
                <input id="q" name="q" type="text" placeholder="Search items" />
                <button type="submit">Submit Search</button>
              </form>
            </body>
          </html>`)
        return
      }
      if (req.url === '/page-b') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html>
            <head><title>Page Beta</title></head>
            <body>
              <h1>Beta Report</h1>
              <p>Second tab content for template URI verification.</p>
              <button type="button">Refresh Metrics</button>
            </body>
          </html>`)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('announces resources and prompts capabilities on initialize and responds to ping', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const init = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      })) as { result: { capabilities: Record<string, unknown>; serverInfo: { name: string } } }

      expect(init.result.serverInfo.name).toBe('troy-advanced')
      expect(init.result.capabilities).toMatchObject({
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      })

      const pong = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 2,
        method: 'ping',
      })) as { result: Record<string, unknown> }
      expect(pong.result).toEqual({})
    } finally {
      await manager.close()
    }
  })

  it('lists all static MCP resources and resource templates', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const listRes = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 10,
        method: 'resources/list',
      })) as { result: { resources: typeof MCP_RESOURCES } }

      const uris = listRes.result.resources.map((r) => r.uri)
      expect(uris).toEqual(['troy://tabs', 'troy://active/ascii', 'troy://memory/stats'])
      expect(listRes.result.resources[0].mimeType).toBe('application/json')
      expect(listRes.result.resources[1].mimeType).toBe('text/plain')
      expect(listRes.result.resources[2].mimeType).toBe('application/json')

      const tplRes = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 11,
        method: 'resources/templates/list',
      })) as { result: { resourceTemplates: typeof MCP_RESOURCE_TEMPLATES } }

      expect(tplRes.result.resourceTemplates).toHaveLength(1)
      expect(tplRes.result.resourceTemplates[0].uriTemplate).toBe('troy://tabs/{tabId}/ascii')
    } finally {
      await manager.close()
    }
  })

  it('reads troy://tabs, troy://active/ascii, and troy://tabs/{tabId}/ascii across empty and multi-tab states', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: true, profileDir: freshProfile() })
    try {
      // 1. Empty state
      const emptyTabs = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 20,
        method: 'resources/read',
        params: { uri: 'troy://tabs' },
      })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }

      expect(emptyTabs.result.contents).toHaveLength(1)
      const parsedEmpty = JSON.parse(emptyTabs.result.contents[0].text)
      expect(parsedEmpty).toMatchObject({ activeTabId: null, count: 0, engine: 'lite', tabs: [] })

      const emptyAscii = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 21,
        method: 'resources/read',
        params: { uri: 'troy://active/ascii' },
      })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }

      expect(emptyAscii.result.contents[0].mimeType).toBe('text/plain')
      expect(emptyAscii.result.contents[0].text).toContain('no active tab')

      // 2. Open two tabs (Alpha then Beta; Beta becomes active)
      const tabA = await manager.openTab(`${baseUrl}/page-a`, { activate: true })
      const tabB = await manager.openTab(`${baseUrl}/page-b`, { activate: true })
      expect(tabA.ok).toBe(true)
      expect(tabB.ok).toBe(true)

      const tabsRead = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 22,
        method: 'resources/read',
        params: { uri: 'troy://tabs' },
      })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }

      const tabsData = JSON.parse(tabsRead.result.contents[0].text)
      expect(tabsData.count).toBe(2)
      expect(tabsData.activeTabId).toBe(tabB.id)
      expect(tabsData.tabs.map((t: { title: string }) => t.title)).toEqual(['Page Alpha', 'Page Beta'])

      // 3. Active tab ASCII (Page Beta)
      const activeAscii = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 23,
        method: 'resources/read',
        params: { uri: 'troy://active/ascii' },
      })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }

      const activeText = activeAscii.result.contents[0].text
      expect(isStrict7BitAscii(activeText)).toBe(true)
      expect(activeText).toContain('BETA REPORT')
      expect(activeText).toMatch(/\[e\d+/)

      // 4. Specific background tab ASCII via template URI (Page Alpha)
      const tabAAscii = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 24,
        method: 'resources/read',
        params: { uri: `troy://tabs/${tabA.id}/ascii` },
      })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }

      const tabAText = tabAAscii.result.contents[0].text
      expect(isStrict7BitAscii(tabAText)).toBe(true)
      expect(tabAText).toContain('ALPHA DASHBOARD')
      expect(tabAText).toContain('Go to Beta')

      // 5. Nonexistent tab returns -32002
      const missingTab = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 25,
        method: 'resources/read',
        params: { uri: 'troy://tabs/9999/ascii' },
      })) as { error: { code: number; message: string } }
      expect(missingTab.error.code).toBe(-32002)
      expect(missingTab.error.message).toContain('9999')
    } finally {
      await manager.close()
    }
  })

  it('reads troy://memory/stats for both disabled and live populated PageMemory', async () => {
    const disabledMgr = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const res = (await handleMcpRequest(disabledMgr, {
        jsonrpc: '2.0',
        id: 30,
        method: 'resources/read',
        params: { uri: 'troy://memory/stats' },
      })) as { result: { contents: Array<{ text: string }> } }

      expect(JSON.parse(res.result.contents[0].text)).toEqual({
        enabled: false,
        pages: 0,
        elements: 0,
        actions: 0,
        origins: 0,
      })
    } finally {
      await disabledMgr.close()
    }

    const enabledMgr = await BrowserManager.create({ engine: 'lite', memoryEnabled: true, profileDir: freshProfile() })
    try {
      const before = (await handleMcpRequest(enabledMgr, {
        jsonrpc: '2.0',
        id: 31,
        method: 'resources/read',
        params: { uri: 'troy://memory/stats' },
      })) as { result: { contents: Array<{ text: string }> } }
      expect(JSON.parse(before.result.contents[0].text)).toEqual({
        enabled: true,
        pages: 0,
        elements: 0,
        actions: 0,
        origins: 0,
      })

      await enabledMgr.openTab(`${baseUrl}/page-a`, { activate: true })
      await enabledMgr.runTool(undefined, 'page_read_ascii', { asciiOnly: true })

      const after = (await handleMcpRequest(enabledMgr, {
        jsonrpc: '2.0',
        id: 32,
        method: 'resources/read',
        params: { uri: 'troy://memory/stats' },
      })) as { result: { contents: Array<{ text: string }> } }
      const stats = JSON.parse(after.result.contents[0].text)
      expect(stats.enabled).toBe(true)
      expect(stats.pages).toBe(1)
      expect(stats.origins).toBe(1)
      expect(stats.elements).toBeGreaterThanOrEqual(2)
    } finally {
      await enabledMgr.close()
    }
  })

  it('returns proper JSON-RPC errors for invalid or unknown resource URIs', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const missing = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 40,
        method: 'resources/read',
        params: {},
      })) as { error: { code: number; message: string } }
      expect(missing.error.code).toBe(-32602)

      const unknown = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 41,
        method: 'resources/read',
        params: { uri: 'troy://unknown/thing' },
      })) as { error: { code: number; message: string } }
      expect(unknown.error.code).toBe(-32002)
      expect(unknown.error.message).toContain('troy://unknown/thing')
    } finally {
      await manager.close()
    }
  })

  it('lists and renders browse_and_extract and fill_form_safely MCP prompts with validation', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const list = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 50,
        method: 'prompts/list',
      })) as { result: { prompts: typeof MCP_PROMPTS } }

      expect(list.result.prompts.map((p) => p.name)).toEqual(['browse_and_extract', 'fill_form_safely'])

      // browse_and_extract
      const browseRes = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 51,
        method: 'prompts/get',
        params: {
          name: 'browse_and_extract',
          arguments: {
            url: 'https://example.com/pricing',
            goal: 'Extract plan names and monthly prices',
            density: 'compact',
          },
        },
      })) as { result: { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> } }

      expect(browseRes.result.messages).toHaveLength(1)
      expect(browseRes.result.messages[0].role).toBe('user')
      const browseText = browseRes.result.messages[0].content.text
      expect(browseText).toContain('https://example.com/pricing')
      expect(browseText).toContain('Extract plan names and monthly prices')
      expect(browseText).toContain('density: "compact"')
      expect(browseText).toContain('troy_open')
      expect(browseText).toContain('troy_read_ascii')
      expect(browseText).toContain('troy://active/ascii')

      // fill_form_safely (default allowSubmit = false)
      const fillSafe = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 52,
        method: 'prompts/get',
        params: {
          name: 'fill_form_safely',
          arguments: {
            url: 'https://example.com/contact',
            fields: '{"name":"Ada","email":"ada@example.com"}',
          },
        },
      })) as { result: { messages: Array<{ role: string; content: { type: string; text: string } }> } }

      const fillSafeText = fillSafe.result.messages[0].content.text
      expect(fillSafeText).toContain('https://example.com/contact')
      expect(fillSafeText).toContain('ada@example.com')
      expect(fillSafeText).toContain('DO NOT click Submit')
      expect(fillSafeText).toContain('NEVER fill password')

      // fill_form_safely with allowSubmit = true
      const fillSubmit = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 53,
        method: 'prompts/get',
        params: {
          name: 'fill_form_safely',
          arguments: {
            url: 'https://example.com/contact',
            allowSubmit: 'true',
          },
        },
      })) as { result: { messages: Array<{ role: string; content: { type: string; text: string } }> } }

      expect(fillSubmit.result.messages[0].content.text).toContain('allowSubmit: true')

      // Validation errors
      const missingUrl = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 54,
        method: 'prompts/get',
        params: { name: 'browse_and_extract', arguments: {} },
      })) as { error: { code: number; message: string } }
      expect(missingUrl.error.code).toBe(-32602)
      expect(missingUrl.error.message).toContain('url')

      const unknownPrompt = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 55,
        method: 'prompts/get',
        params: { name: 'nonexistent_prompt' },
      })) as { error: { code: number; message: string } }
      expect(unknownPrompt.error.code).toBe(-32602)
    } finally {
      await manager.close()
    }
  })

  it('serves resources and prompts end-to-end over stdio NDJSON transport', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: true, profileDir: freshProfile() })
    try {
      await manager.openTab(`${baseUrl}/page-a`, { activate: true })

      const input = new PassThrough()
      const output = new PassThrough()
      let rawOut = ''
      output.on('data', (chunk) => {
        rawOut += chunk.toString('utf8')
      })

      const serverDone = runMcpStdioServer(manager, input, output)

      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'resources/list' },
        { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'troy://active/ascii' } },
        { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'troy://memory/stats' } },
        { jsonrpc: '2.0', id: 5, method: 'prompts/list' },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'prompts/get',
          params: { name: 'fill_form_safely', arguments: { url: `${baseUrl}/page-a` } },
        },
      ]
      for (const req of requests) {
        input.write(`${JSON.stringify(req)}\n`)
      }
      input.end()
      await serverDone

      const responses = rawOut
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))

      expect(responses).toHaveLength(6)
      expect(responses[0].result.capabilities.resources).toBeDefined()
      expect(responses[0].result.capabilities.prompts).toBeDefined()
      expect(responses[1].result.resources).toHaveLength(3)
      expect(responses[2].result.contents[0].text).toContain('ALPHA DASHBOARD')
      expect(JSON.parse(responses[3].result.contents[0].text).pages).toBe(1)
      expect(responses[4].result.prompts).toHaveLength(2)
      expect(responses[5].result.messages[0].content.text).toContain(`${baseUrl}/page-a`)
    } finally {
      await manager.close()
    }
  })
})
