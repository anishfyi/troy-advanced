import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DialogManager,
  formatDialogsAscii,
  parseDialogMode,
  parseDialogType,
} from '../src/engine/dialogs.js'
import { BrowserManager } from '../src/engine/manager.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'
import type { DialogEvent } from '../src/types.js'

const tempDirs: string[] = []

function makeTempProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-dialogs-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // ignore transient Chromium profile cleanup race
    }
  }
})

describe('DialogManager unit behavior (M28)', () => {
  it('parses dialog modes and types case-insensitively', () => {
    expect(parseDialogMode('dismiss')).toBe('dismiss')
    expect(parseDialogMode('ACCEPT')).toBe('accept')
    expect(parseDialogMode('invalid')).toBeUndefined()
    expect(parseDialogMode(123)).toBeUndefined()

    expect(parseDialogType('alert')).toBe('alert')
    expect(parseDialogType('CONFIRM')).toBe('confirm')
    expect(parseDialogType('prompt')).toBe('prompt')
    expect(parseDialogType('beforeunload')).toBe('beforeunload')
    expect(parseDialogType('unknown')).toBeUndefined()
  })

  it('defaults to dismiss mode for alert/confirm/prompt while accepting beforeunload so navigation never hangs', () => {
    const mgr = new DialogManager()
    const events: DialogEvent[] = []
    const unsub = mgr.onEvent((ev) => events.push(ev))

    const d1 = mgr.handleOpening({ tabId: 1, type: 'alert', message: 'Hello world', url: 'https://example.com' })
    expect(d1.accept).toBe(false)
    expect(d1.entry.action).toBe('dismissed')
    expect(d1.entry.handledBy).toBe('policy')

    const d2 = mgr.handleOpening({ tabId: 1, type: 'confirm', message: 'Delete item?', url: 'https://example.com' })
    expect(d2.accept).toBe(false)
    expect(d2.entry.type).toBe('confirm')

    const d3 = mgr.handleOpening({
      tabId: 1,
      type: 'prompt',
      message: 'Enter name',
      defaultPrompt: 'guest',
      url: 'https://example.com',
    })
    expect(d3.accept).toBe(false)
    expect(d3.promptText).toBeUndefined()

    const d4 = mgr.handleOpening({ tabId: 1, type: 'beforeunload', message: 'Leave site?', url: 'https://example.com' })
    expect(d4.accept).toBe(true)
    expect(d4.entry.action).toBe('accepted')

    const stats = mgr.getStats()
    expect(stats.mode).toBe('dismiss')
    expect(stats.acceptBeforeUnload).toBe(true)
    expect(stats.total).toBe(4)
    expect(stats.alerts).toBe(1)
    expect(stats.confirms).toBe(1)
    expect(stats.prompts).toBe(1)
    expect(stats.beforeUnloads).toBe(1)
    expect(stats.accepted).toBe(1)
    expect(stats.dismissed).toBe(3)
    expect(events.length).toBe(4)
    unsub()
  })

  it('supports accept mode, defaultPromptText, and acceptBeforeUnload=false', () => {
    const mgr = new DialogManager({
      mode: 'accept',
      defaultPromptText: 'auto-input',
      acceptBeforeUnload: false,
    })

    const p1 = mgr.handleOpening({ tabId: 2, type: 'prompt', message: 'API key?', defaultPrompt: 'fallback' })
    expect(p1.accept).toBe(true)
    expect(p1.promptText).toBe('auto-input')
    expect(p1.entry.promptText).toBe('auto-input')

    const bu = mgr.handleOpening({ tabId: 2, type: 'beforeunload', message: 'Unsaved changes' })
    expect(bu.accept).toBe(false)

    // Clearing defaultPromptText falls back to page's defaultPrompt
    mgr.setPolicy({ defaultPromptText: undefined })
    const p2 = mgr.handleOpening({ tabId: 2, type: 'prompt', message: 'Name?', defaultPrompt: 'alice' })
    expect(p2.accept).toBe(true)
    expect(p2.promptText).toBe('alice')
  })

  it('applies FIFO queued one-shot responses with optional type matching', () => {
    const mgr = new DialogManager({ mode: 'dismiss' })
    mgr.queueResponse({ accept: true, type: 'prompt', promptText: 'secret-token' })
    mgr.queueResponse({ accept: true })

    expect(mgr.getQueue().length).toBe(2)

    // First dialog is an alert: skips type='prompt' rule, consumes the generic accept rule
    const a = mgr.handleOpening({ tabId: 1, type: 'alert', message: 'Notice' })
    expect(a.accept).toBe(true)
    expect(a.entry.handledBy).toBe('queue')
    expect(mgr.getQueue().length).toBe(1)

    // Second dialog is a prompt: consumes the type='prompt' rule
    const p = mgr.handleOpening({ tabId: 1, type: 'prompt', message: 'Token?' })
    expect(p.accept).toBe(true)
    expect(p.promptText).toBe('secret-token')
    expect(p.entry.handledBy).toBe('queue')
    expect(mgr.getQueue().length).toBe(0)

    // Third dialog falls back to policy ('dismiss')
    const c = mgr.handleOpening({ tabId: 1, type: 'confirm', message: 'Proceed?' })
    expect(c.accept).toBe(false)
    expect(c.entry.handledBy).toBe('policy')
  })

  it('tracks dialog closed timestamps, bounded history, filtering, and strict 7-bit ASCII formatting', () => {
    const mgr = new DialogManager({ maxHistory: 3 })
    const events: DialogEvent[] = []
    mgr.onEvent((ev) => events.push(ev))

    mgr.handleOpening({ tabId: 1, type: 'alert', message: 'First', url: 'https://a.test' })
    const closed = mgr.recordClosed({ tabId: 1, result: false })
    expect(closed?.closedAt).toBeTypeOf('number')
    expect(events.some((e) => e.kind === 'dialog_closed')).toBe(true)

    mgr.handleOpening({ tabId: 2, type: 'confirm', message: 'Second \x1b[31mANSI\x1b[0m 🚀', url: 'https://b.test' })
    mgr.handleOpening({ tabId: 1, type: 'prompt', message: 'Third', url: 'https://c.test' })
    mgr.handleOpening({ tabId: 2, type: 'alert', message: 'Fourth', url: 'https://d.test' })

    // maxHistory=3 evicted 'First', while stats.total retains 4
    expect(mgr.list().length).toBe(3)
    expect(mgr.getStats().total).toBe(4)
    expect(mgr.list({ tabId: 2 }).length).toBe(2)
    expect(mgr.list({ type: 'prompt' }).length).toBe(1)

    const ascii = formatDialogsAscii(mgr.list(), mgr.getStats(), mgr.getQueue())
    expect(ascii).toContain('DIALOG HANDLER')
    expect(ascii).toContain('mode=dismiss')
    expect(ascii).toContain('Fourth')
    // Verify strict 7-bit printable ASCII + newline only
    expect(/^[\x0a\x20-\x7e]*$/.test(ascii)).toBe(true)
    expect(ascii).not.toContain('\x1b')

    const removed = mgr.clear({ tabId: 2 })
    expect(removed).toBe(2)
    expect(mgr.list().length).toBe(1)
  })
})

describe('Dialog integration across BrowserManager, Agent Socket, MCP, and Pipe REPL', () => {
  it('exposes /dialogs, /health dialog stats, troy_dialogs MCP tool, and pipe dialogs command', async () => {
    const profileDir = makeTempProfile()
    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir,
      dialogs: { mode: 'dismiss' },
    })
    const socket = await createAgentSocket(manager, { port: 0 })

    try {
      // 1. /health includes dialog stats
      const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        headers: { 'x-troy-agent': socket.token },
      })
      const healthJson = (await healthRes.json()) as { ok: boolean; dialogs: { mode: string } }
      expect(healthJson.ok).toBe(true)
      expect(healthJson.dialogs.mode).toBe('dismiss')

      // 2. /dialogs updates policy and queues a one-shot response
      const dlgRes = await fetch(`http://127.0.0.1:${socket.port}/dialogs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-troy-agent': socket.token,
        },
        body: JSON.stringify({
          mode: 'accept',
          queueAccept: true,
          promptText: 'agent-reply',
          queueType: 'prompt',
        }),
      })
      const dlgJson = (await dlgRes.json()) as {
        ok: boolean
        stats: { mode: string; queuedCount: number }
        queue: Array<{ accept: boolean; promptText?: string; type?: string }>
        ascii: string
      }
      expect(dlgJson.ok).toBe(true)
      expect(dlgJson.stats.mode).toBe('accept')
      expect(dlgJson.stats.queuedCount).toBe(1)
      expect(dlgJson.queue[0]).toEqual({ accept: true, promptText: 'agent-reply', type: 'prompt' })
      expect(dlgJson.ascii).toContain('mode=accept')

      // 3. MCP troy_dialogs tool
      const mcpList = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      })) as { result: { tools: Array<{ name: string }> } }
      expect(mcpList.result.tools.some((t) => t.name === 'troy_dialogs')).toBe(true)

      const mcpCall = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'troy_dialogs',
          arguments: { clearQueue: true, mode: 'dismiss' },
        },
      })) as { result: { content: Array<{ text: string }> } }
      const parsedMcp = JSON.parse(mcpCall.result.content[0]!.text) as {
        ok: boolean
        stats: { mode: string; queuedCount: number }
      }
      expect(parsedMcp.ok).toBe(true)
      expect(parsedMcp.stats.mode).toBe('dismiss')
      expect(parsedMcp.stats.queuedCount).toBe(0)

      // 4. Pipe REPL dialogs command
      const pipeRes = await executePipeCommand(
        manager,
        'dialogs --next accept --prompt-text hello-pipe',
        { jsonMode: true },
      )
      const parsedPipe = JSON.parse(pipeRes.output) as {
        ok: boolean
        stats: { queuedCount: number }
        queue: Array<{ accept: boolean; promptText?: string }>
      }
      expect(parsedPipe.ok).toBe(true)
      expect(parsedPipe.stats.queuedCount).toBe(1)
      expect(parsedPipe.queue[0]?.promptText).toBe('hello-pipe')
    } finally {
      await socket.close()
      await manager.close()
    }
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('Chromium CDP real JavaScript dialog handling (M28)', () => {
  it(
    'auto-dismisses and captures alert/confirm/prompt without hanging, and supports queued overrides + accept mode',
    async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Dialog Test</title></head>
  <body>
    <button id="btn-alert" onclick="window.alert('Alert from page!'); document.getElementById('out').textContent = 'alert-done';">Alert</button>
    <button id="btn-confirm" onclick="const r = window.confirm('Confirm action?'); document.getElementById('out').textContent = 'confirm:' + r;">Confirm</button>
    <button id="btn-prompt" onclick="const v = window.prompt('Enter code:', 'default-code'); document.getElementById('out').textContent = 'prompt:' + String(v);">Prompt</button>
    <div id="out">idle</div>
  </body>
</html>`)
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as { port: number }
      const url = `http://127.0.0.1:${addr.port}/`

      const profileDir = makeTempProfile()
      const manager = await BrowserManager.create({
        engine: 'chromium',
        profileDir,
        dialogs: { mode: 'dismiss' },
      })

      try {
        const opened = await manager.openTab(url, { activate: true })
        const tabId = opened.tabId
        manager.grantOrigin(url)

        // 1. Trigger alert — must not hang!
        await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('btn-alert').click(); document.getElementById('out').textContent`,
        })
        const out1 = await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('out').textContent`,
        })
        expect(out1.value).toBe('alert-done')

        // 2. Trigger confirm under default 'dismiss' mode -> returns false
        await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('btn-confirm').click()`,
        })
        const out2 = await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('out').textContent`,
        })
        expect(out2.value).toBe('confirm:false')

        // 3. Trigger prompt under default 'dismiss' mode -> returns null
        await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('btn-prompt').click()`,
        })
        const out3 = await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('out').textContent`,
        })
        expect(out3.value).toBe('prompt:null')

        // 4. Queue one-shot prompt response -> returns custom text
        manager.queueDialogResponse({ accept: true, type: 'prompt', promptText: 'ec2-admin-42' })
        await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('btn-prompt').click()`,
        })
        const out4 = await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('out').textContent`,
        })
        expect(out4.value).toBe('prompt:ec2-admin-42')

        // 5. Switch policy to 'accept' -> confirm returns true
        manager.setDialogPolicy({ mode: 'accept' })
        await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('btn-confirm').click()`,
        })
        const out5 = await manager.runTool(tabId, 'page_eval', {
          expression: `document.getElementById('out').textContent`,
        })
        expect(out5.value).toBe('confirm:true')

        // Verify captured dialog history
        const captured = manager.getDialogs({ tabId })
        expect(captured.length).toBe(5)
        expect(captured[0]?.type).toBe('alert')
        expect(captured[0]?.message).toBe('Alert from page!')
        expect(captured[1]?.type).toBe('confirm')
        expect(captured[1]?.accepted).toBe(false)
        expect(captured[2]?.type).toBe('prompt')
        expect(captured[2]?.accepted).toBe(false)
        expect(captured[3]?.type).toBe('prompt')
        expect(captured[3]?.accepted).toBe(true)
        expect(captured[3]?.promptText).toBe('ec2-admin-42')
        expect(captured[3]?.handledBy).toBe('queue')
        expect(captured[4]?.type).toBe('confirm')
        expect(captured[4]?.accepted).toBe(true)
        expect(captured[4]?.handledBy).toBe('policy')
      } finally {
        await manager.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    30_000,
  )
})
