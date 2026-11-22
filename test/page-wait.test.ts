import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import {
  checkLiteSelectorState,
  matchesText,
  matchesUrlPattern,
  parseWaitState,
  pollUntil,
} from '../src/engine/wait.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'

describe('Wait condition utilities (unit)', () => {
  it('validates wait states strictly', () => {
    expect(parseWaitState(undefined)).toBeUndefined()
    expect(parseWaitState('')).toBeUndefined()
    expect(parseWaitState('visible')).toBe('visible')
    expect(parseWaitState('hidden')).toBe('hidden')
    expect(parseWaitState('attached')).toBe('attached')
    const bad = parseWaitState('detached')
    expect(bad).toEqual({ error: 'invalid wait state "detached" (expected visible, hidden, or attached)' })
  })

  it('matches URL patterns via substring, glob, and regex', () => {
    const url = 'https://app.example.com/users/42/settings?tab=security'
    expect(matchesUrlPattern(url, '/users/42/settings')).toBe(true)
    expect(matchesUrlPattern(url, '/admin')).toBe(false)
    expect(matchesUrlPattern(url, 'https://app.example.com/users/*/settings*')).toBe(true)
    expect(matchesUrlPattern(url, 'https://other.example.com/*')).toBe(false)
    expect(matchesUrlPattern(url, '/\\/users\\/\\d+\\/settings/')).toBe(true)
    expect(matchesUrlPattern(url, '/\\/users\\/[a-z]+\\//')).toBe(false)
  })

  it('matches text with whitespace normalization and case-insensitivity', () => {
    expect(matchesText('Hello   \n  World  Ready', 'hello world')).toBe(true)
    expect(matchesText('Loading...', 'Ready')).toBe(false)
  })

  it('evaluates Lite HTML selectors across visible, hidden, and attached states', () => {
    const html = `<!doctype html>
    <html><body>
      <main id="app" class="container main-view">
        <h1 class="title">Welcome</h1>
        <form id="login">
          <input name="email" type="email" />
          <input name="csrf" type="hidden" value="abc" />
          <button type="submit" data-testid="go-btn">Sign in</button>
        </form>
        <div id="secret" hidden>Hidden attr</div>
        <div id="invisible" style="display: none">Display none</div>
        <div id="transparent" style="opacity: 0">Zero opacity</div>
        <div style="visibility: hidden"><span id="nested-hidden">Inside hidden parent</span></div>
      </main>
    </body></html>`

    expect(checkLiteSelectorState(html, [], '#app .title', 'visible').matched).toBe(true)
    expect(checkLiteSelectorState(html, [], 'form#login > button[data-testid="go-btn"]', 'visible').matched).toBe(true)
    expect(checkLiteSelectorState(html, [], 'input[name="email"]', 'visible').matched).toBe(true)

    // Hidden elements: attached=true, visible=false, hidden=true
    for (const sel of ['#secret', '#invisible', '#transparent', '#nested-hidden', 'input[name="csrf"]']) {
      expect(checkLiteSelectorState(html, [], sel, 'attached').matched).toBe(true)
      expect(checkLiteSelectorState(html, [], sel, 'visible').matched).toBe(false)
      expect(checkLiteSelectorState(html, [], sel, 'hidden').matched).toBe(true)
    }

    // Non-existent element: attached=false, visible=false, hidden=true
    expect(checkLiteSelectorState(html, [], '#does-not-exist', 'attached').matched).toBe(false)
    expect(checkLiteSelectorState(html, [], '#does-not-exist', 'visible').matched).toBe(false)
    expect(checkLiteSelectorState(html, [], '#does-not-exist', 'hidden').matched).toBe(true)

    // Invalid selector fails with error
    expect(checkLiteSelectorState(html, [], '[unclosed', 'visible').error).toBeDefined()
  })

  it('pollUntil resolves when condition turns true and fails fast on fatalError', async () => {
    let calls = 0
    const res = await pollUntil(
      () => {
        calls++
        return { satisfied: calls >= 3, matched: { text: calls >= 3 } }
      },
      { timeoutMs: 1000, pollIntervalMs: 15, description: 'test condition' },
    )
    expect(res.ok).toBe(true)
    expect(calls).toBe(3)

    const fatal = await pollUntil(
      () => ({ satisfied: false, fatalError: 'bad selector' }),
      { timeoutMs: 2000, pollIntervalMs: 50, description: 'fatal' },
    )
    expect(fatal.ok).toBe(false)
    expect(fatal.timedOut).toBeUndefined()
    expect(fatal.error).toBe('bad selector')
    expect(fatal.waitedMs).toBeLessThan(300)
  })
})

describe('page_wait in Lite engine + MCP + Pipe REPL + page_act', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/dashboard/99') {
        res.end(`<!doctype html><html><head><title>Dashboard 99</title></head><body>
          <h1 id="dash-title">Mission Control</h1>
          <div id="status-banner" class="banner ready">All Systems Go</div>
          <div id="spinner" style="display:none">Loading...</div>
          <p id="secret-box" hidden>Internal Debug</p>
        </body></html>`)
        return
      }
      res.end(`<!doctype html><html><head><title>Home</title></head><body>
        <h1>Home Page</h1>
        <a id="go-dash" href="/dashboard/99">Open Dashboard</a>
      </body></html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    manager = await BrowserManager.create({ engine: 'lite', memory: false })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((r) => server?.close(() => r()))
  })

  it('supports fixed ms delay, text, selector+state, url, combined conditions, and timeout errors', async () => {
    const opened = await manager.openTab(`${baseUrl}/dashboard/99`, { activate: true })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    // Fixed delay
    const fixed = await manager.runTool(tabId, 'page_wait', { ms: 20 })
    expect(fixed.ok).toBe(true)
    expect(fixed.waitedMs).toBe(20)

    // --text match
    const byText = await manager.runTool(tabId, 'page_wait', { text: 'All Systems Go', timeout: 500 })
    expect(byText.ok).toBe(true)
    expect((byText.matched as { text?: boolean }).text).toBe(true)

    // --selector visible / hidden / attached
    const visibleOk = await manager.runTool(tabId, 'page_wait', {
      selector: '#status-banner.ready',
      state: 'visible',
      timeout: 500,
    })
    expect(visibleOk.ok).toBe(true)

    const hiddenSpinner = await manager.runTool(tabId, 'page_wait', {
      selector: '#spinner',
      state: 'hidden',
      timeout: 500,
    })
    expect(hiddenSpinner.ok).toBe(true)

    const attachedSecret = await manager.runTool(tabId, 'page_wait', {
      selector: '#secret-box',
      state: 'attached',
      timeout: 500,
    })
    expect(attachedSecret.ok).toBe(true)

    const secretVisibleFail = await manager.runTool(tabId, 'page_wait', {
      selector: '#secret-box',
      state: 'visible',
      timeout: 80,
      pollIntervalMs: 20,
    })
    expect(secretVisibleFail.ok).toBe(false)
    expect(secretVisibleFail.timedOut).toBe(true)
    expect(String(secretVisibleFail.error)).toContain('Timed out')

    // --url glob & regex
    const byUrlGlob = await manager.runTool(tabId, 'page_wait', { url: '*/dashboard/*', timeout: 500 })
    expect(byUrlGlob.ok).toBe(true)

    const byUrlRegex = await manager.runTool(tabId, 'page_wait', { url: '/\\/dashboard\\/\\d+$/', timeout: 500 })
    expect(byUrlRegex.ok).toBe(true)

    // Combined conditions
    const combined = await manager.runTool(tabId, 'page_wait', {
      url: '/dashboard/99',
      selector: '#dash-title',
      state: 'visible',
      text: 'Mission Control',
      timeout: 500,
    })
    expect(combined.ok).toBe(true)

    // Validation errors
    const badState = await manager.runTool(tabId, 'page_wait', { selector: '#dash-title', state: 'bogus' })
    expect(badState.ok).toBe(false)
    expect(String(badState.error)).toContain('invalid wait state')

    const stateNoSel = await manager.runTool(tabId, 'page_wait', { state: 'hidden' })
    expect(stateNoSel.ok).toBe(false)
    expect(String(stateNoSel.error)).toContain('requires a selector')
  })

  it('works through page_act, MCP troy_wait, and Pipe REPL wait command', async () => {
    const opened = await manager.openTab(`${baseUrl}/dashboard/99`, { activate: true })
    const tabId = opened.id!

    // page_act step
    const actRes = await manager.runTool(tabId, 'page_act', {
      steps: [
        { op: 'wait', selector: '#status-banner', state: 'visible', text: 'All Systems Go', timeout: 500 },
        { op: 'wait', selector: '#spinner', state: 'hidden', timeout: 500 },
      ],
    })
    expect(actRes.ok).toBe(true)

    // MCP troy_wait
    const mcpList = await handleMcpRequest(manager, { id: 1, method: 'tools/list' })
    const tools = (mcpList?.result as { tools: Array<{ name: string }> }).tools
    expect(tools.some((t) => t.name === 'troy_wait')).toBe(true)

    const mcpCall = await handleMcpRequest(manager, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'troy_wait',
        arguments: { tabId, text: 'Mission Control', selector: '#dash-title', state: 'visible', timeout: 500 },
      },
    })
    const mcpText = ((mcpCall?.result as { content: Array<{ text: string }> }).content[0]?.text) ?? ''
    expect(JSON.parse(mcpText).ok).toBe(true)

    // Pipe REPL wait command with quoted args
    const pipeRes = await executePipeCommand(
      manager,
      'wait --text "All Systems Go" --selector "#status-banner" --state visible --timeout 500',
      { jsonMode: true },
    )
    expect(JSON.parse(pipeRes.output).ok).toBe(true)
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('page_wait in Headless Chromium CDP (dynamic DOM & URL transitions)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-wait-chrome-'))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Dynamic Wait E2E</title></head>
        <body style="font-family:sans-serif; padding:16px;">
          <h1>Wait Test Harness</h1>
          <div id="spinner">Loading data...</div>
          <div id="banner" style="display:none; padding:8px;">Hydrated Banner Ready</div>
          <button id="trigger-all" type="button" onclick="
            setTimeout(() => {
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('banner').style.display = 'block';
              const badge = document.createElement('span');
              badge.id = 'async-badge';
              badge.textContent = 'Async Complete 200';
              document.body.appendChild(badge);
              history.pushState({}, '', '/dashboard/42');
            }, 140);
          ">Trigger Async Update</button>
        </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    manager = await BrowserManager.create({ engine: 'chromium', profileDir: tmpDir, memory: false })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((r) => server?.close(() => r()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('waits for dynamic text, selector visible/hidden/attached, and pushState URL transitions', async () => {
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    // Initially: #banner is attached & hidden, #spinner is visible, #async-badge is detached (hidden)
    const bannerAttached = await manager.runTool(tabId, 'page_wait', {
      selector: '#banner',
      state: 'attached',
      timeout: 1000,
    })
    expect(bannerAttached.ok).toBe(true)

    const bannerHidden = await manager.runTool(tabId, 'page_wait', {
      selector: '#banner',
      state: 'hidden',
      timeout: 1000,
    })
    expect(bannerHidden.ok).toBe(true)

    const badgeHiddenInitially = await manager.runTool(tabId, 'page_wait', {
      selector: '#async-badge',
      state: 'hidden',
      timeout: 1000,
    })
    expect(badgeHiddenInitially.ok).toBe(true)

    // Invalid selector fails fast
    const badSel = await manager.runTool(tabId, 'page_wait', {
      selector: 'div[[[invalid',
      timeout: 3000,
    })
    expect(badSel.ok).toBe(false)
    expect(badSel.timedOut).toBeUndefined()
    expect(String(badSel.error)).toContain('invalid selector')
    expect(Number(badSel.waitedMs)).toBeLessThan(1000)

    // Trigger async DOM mutation + URL change via JS click (without blocking click delay)
    await manager.runTool(tabId, 'page_eval', {
      expression: 'document.getElementById("trigger-all").click(); true',
    })

    // Wait for all dynamic transitions together: banner visible + text + URL regex
    const waited = await manager.runTool(tabId, 'page_wait', {
      selector: '#banner',
      state: 'visible',
      text: 'Async Complete 200',
      url: '/\\/dashboard\\/\\d+$/',
      timeout: 3000,
      pollIntervalMs: 25,
    })
    expect(waited.ok).toBe(true)
    expect(waited.matched).toMatchObject({
      selector: true,
      state: 'visible',
      text: true,
      url: true,
    })

    // Spinner should now satisfy state=hidden
    const spinnerGone = await manager.runTool(tabId, 'page_wait', {
      selector: '#spinner',
      state: 'hidden',
      timeout: 1000,
    })
    expect(spinnerGone.ok).toBe(true)

    // Condition that never becomes true times out cleanly
    const timedOut = await manager.runTool(tabId, 'page_wait', {
      text: 'This Text Will Never Appear',
      timeout: 150,
      pollIntervalMs: 25,
    })
    expect(timedOut.ok).toBe(false)
    expect(timedOut.timedOut).toBe(true)
    expect(String(timedOut.error)).toContain('Timed out after 150ms')
  })
})
