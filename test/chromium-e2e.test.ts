import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { findChromeBinary } from '../src/engine/chromium.js'

const hasChrome = Boolean(findChromeBinary())
const requireChrome = process.env.TROY_REQUIRE_CHROME === '1' || process.env.TROY_REQUIRE_CHROME === 'true'

if (requireChrome && !hasChrome) {
  throw new Error(
    'TROY_REQUIRE_CHROME is enabled, but no Chrome/Chromium binary was found (set TROY_CHROME_BIN or install Chrome/Chromium).',
  )
}

describe.skipIf(!hasChrome)('Headless Chromium CDP E2E + PNG-to-ASCII screenshot', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-chrome-'))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Chromium ASCII E2E</title></head>
        <body style="font-family:sans-serif; padding:24px; background:#fff; color:#111;">
          <h1 id="heading">Headless Chrome Ready</h1>
          <p>Dynamic counter: <span id="count">0</span> — see <a id="docs" href="#docs">Chrome Docs</a> inline.</p>
          <input id="note" type="text" placeholder="Enter note" />
          <button id="inc" type="button" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1); console.log('clicked inc');">Increment</button>
        </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    manager = await BrowserManager.create({ engine: 'chromium', profileDir: tmpDir })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((r) => server?.close(() => r()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs real JS, captures console logs, renders ASCII layout, and converts PNG screenshot to ASCII with [eN] overlays', async () => {
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    const read1 = await manager.runTool(tabId, 'page_read_ascii', { width: 90, height: 26 })
    expect(read1.ok).toBe(true)
    expect(read1.engine).toBe('chromium')
    expect(String(read1.ascii)).toContain('HEADLESS CHROME READY')
    expect(String(read1.ascii)).toMatch(/Dynamic counter: 0 - see \[e\d+: Chrome Docs\] inline\./)

    // Click dynamic JS button via ref
    const found = await manager.runTool(tabId, 'page_find', { query: 'Increment' })
    const btnRef = (found.matches as Array<{ ref: string }>)[0]!.ref
    const clicked = await manager.runTool(tabId, 'page_click', { ref: btnRef })
    expect(clicked.ok).toBe(true)

    const evalCount = await manager.runTool(tabId, 'page_eval', { expression: 'document.getElementById("count").textContent' })
    expect(evalCount.ok).toBe(true)
    expect(evalCount.value).toBe('1')

    const logs = await manager.runTool(tabId, 'page_console', {})
    expect(JSON.stringify(logs.entries)).toContain('clicked inc')

    // Capture real Chromium PNG screenshot and render as strict 7-bit ASCII art with Set-of-Marks
    const visual = await manager.runTool(tabId, 'page_screenshot_ascii', { width: 64, height: 20, annotate: true })
    expect(visual.ok).toBe(true)
    expect(Number(visual.bytes)).toBeGreaterThan(500)
    expect(/^[\x20-\x7e\n]+$/.test(String(visual.ascii))).toBe(true)
    expect(String(visual.ascii)).toContain('[e')
  })
})
