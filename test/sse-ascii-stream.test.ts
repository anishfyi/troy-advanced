import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'
import { formatSseMessage, parseSseStreamOptions } from '../src/bridge/sse-stream.js'
import { SESSION_HEADER } from '../src/agent/sessions.js'

interface ParsedSseEvent {
  id?: string
  event?: string
  data: Record<string, unknown>
}

interface SseClientHandle {
  events: ParsedSseEvent[]
  waitFor: (predicate: (ev: ParsedSseEvent) => boolean, timeoutMs?: number) => Promise<ParsedSseEvent>
  close: () => Promise<void>
}

async function openSseClient(
  port: number,
  token: string,
  query = '',
  extraHeaders: Record<string, string> = {},
): Promise<SseClientHandle> {
  const events: ParsedSseEvent[] = []
  const waiters: Array<{
    predicate: (ev: ParsedSseEvent) => boolean
    resolve: (ev: ParsedSseEvent) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  const controller = new AbortController()
  const url = `http://127.0.0.1:${port}/stream${query ? `?${query}` : ''}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-troy-agent': token,
      accept: 'text/event-stream',
      ...extraHeaders,
    },
    signal: controller.signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed with HTTP ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  const pump = (async () => {
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')

          const lines = block.split('\n')
          let id: string | undefined
          let event: string | undefined
          const dataLines: string[] = []
          for (const line of lines) {
            if (line.startsWith(':')) continue
            if (line.startsWith('id:')) id = line.slice(3).trim()
            else if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          }
          if (!dataLines.length) continue
          let data: Record<string, unknown>
          try {
            data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
          } catch {
            continue
          }
          const parsed: ParsedSseEvent = { id, event, data }
          events.push(parsed)
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i]!
            if (w.predicate(parsed)) {
              clearTimeout(w.timer)
              waiters.splice(i, 1)
              w.resolve(parsed)
            }
          }
        }
      }
    } catch {
      // AbortError on close is expected
    }
  })()

  return {
    events,
    waitFor(predicate, timeoutMs = 4000) {
      const existing = events.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise<ParsedSseEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error(`Timed out waiting for SSE event after ${timeoutMs}ms (seen ${events.length} events)`))
        }, timeoutMs)
        waiters.push({ predicate, resolve, reject, timer })
      })
    },
    async close() {
      controller.abort()
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      await pump
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer)
        w.reject(new Error('SSE client closed'))
      }
    },
  }
}

describe('SSE /stream option parsing & formatting', () => {
  it('parses defaults and clamps numeric options', () => {
    const res = parseSseStreamOptions(new URLSearchParams())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.options.frames).toBe(true)
    expect(res.options.events).toBe(true)
    expect(res.options.initial).toBe(true)
    expect(res.options.width).toBe(100)
    expect(res.options.since).toBe(false)
    expect(res.options.dedupe).toBe(true)
    expect(res.options.throttleMs).toBe(25)
    expect(res.options.pollMs).toBe(0)
    expect(res.options.heartbeatMs).toBe(15000)
  })

  it('supports mode presets, maxTokens, density, layout, and poll clamping', () => {
    const delta = parseSseStreamOptions(
      new URLSearchParams('mode=delta&width=10&pollMs=50&maxTokens=120&density=compact&layout=spatial&heartbeatMs=0'),
    )
    expect(delta.ok).toBe(true)
    if (!delta.ok) return
    expect(delta.options.frames).toBe(true)
    expect(delta.options.since).toBe(true)
    expect(delta.options.width).toBe(40)
    expect(delta.options.pollMs).toBe(100)
    expect(delta.options.maxTokens).toBe(120)
    expect(delta.options.density).toBe('compact')
    expect(delta.options.layout).toBe('spatial')
    expect(delta.options.heartbeatMs).toBe(0)

    const framesOnly = parseSseStreamOptions(new URLSearchParams('mode=ascii'))
    expect(framesOnly.ok).toBe(true)
    if (framesOnly.ok) {
      expect(framesOnly.options.frames).toBe(true)
      expect(framesOnly.options.events).toBe(false)
    }

    const eventsOnly = parseSseStreamOptions(new URLSearchParams('mode=events'))
    expect(eventsOnly.ok).toBe(true)
    if (eventsOnly.ok) {
      expect(eventsOnly.options.frames).toBe(false)
      expect(eventsOnly.options.events).toBe(true)
    }
  })

  it('rejects invalid tabId and invalid sessionId', () => {
    const badTab = parseSseStreamOptions(new URLSearchParams('tabId=abc'))
    expect(badTab.ok).toBe(false)
    const badSession = parseSseStreamOptions(new URLSearchParams('sessionId=bad session!'))
    expect(badSession.ok).toBe(false)
  })

  it('formats SSE wire frames with id, event, and data', () => {
    const msg = formatSseMessage({ type: 'ascii_frame', seq: 3 }, { event: 'ascii_frame', id: 3 })
    expect(msg).toBe('id: 3\nevent: ascii_frame\ndata: {"type":"ascii_frame","seq":3}\n\n')
  })
})

describe('SSE /stream live ASCII frame broadcasts', () => {
  let siteServer: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let socket: AgentSocketServer
  let tmpDir: string
  let dynamicCounter = 1

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-sse-test-'))
    siteServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (url.pathname === '/second') {
        res.end(`<!doctype html><html><head><title>Second Page</title></head><body>
          <h1>Second Page Heading</h1>
          <p>Arrived on page two.</p>
          <a href="/">Back Home</a>
        </body></html>`)
        return
      }
      if (url.pathname === '/beta') {
        res.end(`<!doctype html><html><head><title>Beta Workspace</title></head><body>
          <h1>Beta Isolated Dashboard</h1>
          <p>Secret beta data.</p>
        </body></html>`)
        return
      }
      if (url.pathname === '/ticker') {
        res.end(`<!doctype html><html><head><title>Live Ticker ${dynamicCounter}</title></head><body>
          <h1>Ticker Value: ${dynamicCounter}</h1>
          <p>Live status tick #${dynamicCounter}</p>
        </body></html>`)
        return
      }
      res.end(`<!doctype html><html><head><title>Home Portal</title></head><body>
        <h1>Home Portal</h1>
        <p>Welcome to streaming ASCII tests.</p>
        <form action="/second" method="GET">
          <label for="query">Search</label>
          <input id="query" name="q" type="text" placeholder="enter text" />
          <label for="env">Environment</label>
          <select id="env" name="env">
            <option value="dev">Development</option>
            <option value="prod">Production</option>
          </select>
          <button id="go" type="submit">Go Second</button>
        </form>
        <a id="nav-second" href="/second">Visit Second Page</a>
      </body></html>`)
    })

    await new Promise<void>((resolve) => siteServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = siteServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`

    manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
    socket = await createAgentSocket(manager)
  })

  afterAll(async () => {
    await socket.close()
    await manager.close()
    siteServer.closeAllConnections?.()
    await new Promise<void>((resolve) => siteServer.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function api(
    route: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`http://127.0.0.1:${socket.port}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-troy-agent': socket.token,
        ...headers,
      },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json()) as Record<string, unknown> }
  }

  it('rejects unauthorized or invalid /stream requests', async () => {
    const unauth = await fetch(`http://127.0.0.1:${socket.port}/stream`)
    expect(unauth.status).toBe(401)

    const badTab = await fetch(`http://127.0.0.1:${socket.port}/stream?tabId=notanumber`, {
      headers: { 'x-troy-agent': socket.token },
    })
    expect(badTab.status).toBe(400)
  })

  it('streams initial ASCII frame, navigation frames, form mutation frames, and history frames', async () => {
    const opened = await api('/open', { url: baseUrl, activate: true })
    expect(opened.data.ok).toBe(true)
    const tabId = Number(opened.data.id)

    const sse = await openSseClient(socket.port, socket.token, 'throttleMs=0&heartbeatMs=0&width=80')
    try {
      const connected = await sse.waitFor((e) => e.data.type === 'connected')
      expect(connected.event).toBe('connected')
      expect(connected.data.activeTabId).toBe(tabId)

      const initial = await sse.waitFor((e) => e.data.type === 'ascii_frame' && e.data.reason === 'initial')
      expect(initial.event).toBe('ascii_frame')
      expect(initial.id).toBe('1')
      expect(initial.data.mode).toBe('full')
      expect(String(initial.data.ascii)).toContain('Home Portal')
      expect(Number(initial.data.refs)).toBeGreaterThan(0)

      // Mutate input via page_fill -> should broadcast mutated:fill ASCII frame
      const filled = await api('/tool', {
        tabId,
        name: 'page_fill',
        args: { ref: 'e1', text: 'ec2-streaming' },
      })
      expect(filled.data.ok).toBe(true)

      const fillFrame = await sse.waitFor(
        (e) => e.data.type === 'ascii_frame' && e.data.reason === 'mutated:fill',
      )
      expect(String(fillFrame.data.ascii)).toContain('ec2-streaming')

      // Mutate select via page_select -> should broadcast mutated:select ASCII frame
      const selected = await api('/tool', {
        tabId,
        name: 'page_select',
        args: { ref: 'e2', value: 'prod' },
      })
      expect(selected.data.ok).toBe(true)

      const selectFrame = await sse.waitFor(
        (e) => e.data.type === 'ascii_frame' && e.data.reason === 'mutated:select',
      )
      expect(String(selectFrame.data.ascii)).toContain('Production')

      // Navigate via page_navigate -> should broadcast navigated ASCII frame
      const nav = await api('/tool', {
        tabId,
        name: 'page_navigate',
        args: { url: `${baseUrl}/second` },
      })
      expect(nav.data.ok).toBe(true)

      const navFrame = await sse.waitFor(
        (e) =>
          e.data.type === 'ascii_frame' &&
          e.data.reason === 'navigated' &&
          String(e.data.url).endsWith('/second'),
      )
      expect(String(navFrame.data.ascii)).toContain('Arrived on page two.')

      // History back -> should broadcast navigated ASCII frame back to Home Portal
      const back = await api('/tool', {
        tabId,
        name: 'page_history',
        args: { direction: 'back' },
      })
      expect(back.data.ok).toBe(true)

      const backFrame = await sse.waitFor(
        (e) =>
          e.data.type === 'ascii_frame' &&
          Number(e.data.seq) > Number(navFrame.data.seq) &&
          String(e.data.ascii).includes('Home Portal'),
      )
      expect(backFrame.data.reason).toBe('navigated')
    } finally {
      await sse.close()
    }
  })

  it('broadcasts frame on tab switch, supports delta mode, token budget, and frames-only mode', async () => {
    const t1 = await api('/open', { url: baseUrl, activate: true })
    const tab1 = Number(t1.data.id)
    const t2 = await api('/open', { url: `${baseUrl}/second`, activate: false })
    const tab2 = Number(t2.data.id)

    const sse = await openSseClient(
      socket.port,
      socket.token,
      'mode=delta&events=false&throttleMs=0&heartbeatMs=0&maxTokens=60&density=compact',
    )
    try {
      const first = await sse.waitFor((e) => e.data.type === 'ascii_frame')
      expect(first.data.mode).toBe('full')
      expect(first.data.tabId).toBe(tab1)
      expect(Number(first.data.estimatedTokens)).toBeLessThanOrEqual(60)

      // Navigate active tab -> delta mode emits mode: 'delta'
      await api('/tool', {
        tabId: tab1,
        name: 'page_navigate',
        args: { url: `${baseUrl}/second` },
      })
      const deltaFrame = await sse.waitFor(
        (e) => e.data.type === 'ascii_frame' && e.data.mode === 'delta',
      )
      expect(deltaFrame.data.delta).toBeTruthy()
      expect(String(deltaFrame.data.ascii)).toContain('DELTA')

      // Switch active tab to tab2 -> forces full frame with reason tab_activated
      await api('/activate', { tabId: tab2 })
      const switched = await sse.waitFor(
        (e) => e.data.type === 'ascii_frame' && e.data.reason === 'tab_activated',
      )
      expect(switched.data.tabId).toBe(tab2)
      expect(switched.data.mode).toBe('full')

      // Verify events=false suppressed raw navigated / tab_activated events
      const rawEvents = sse.events.filter((e) => e.data.type !== 'connected' && e.data.type !== 'ascii_frame')
      expect(rawEvents.length).toBe(0)
    } finally {
      await sse.close()
    }
  })

  it('enforces multi-agent session isolation on /stream', async () => {
    const alphaOpen = await api('/open', { url: baseUrl, activate: true }, { [SESSION_HEADER]: 'alpha' })
    expect(alphaOpen.data.ok).toBe(true)
    const alphaTab = Number(alphaOpen.data.id)

    const betaOpen = await api('/open', { url: `${baseUrl}/beta`, activate: true }, { [SESSION_HEADER]: 'beta' })
    expect(betaOpen.data.ok).toBe(true)
    const betaTab = Number(betaOpen.data.id)

    const alphaStream = await openSseClient(
      socket.port,
      socket.token,
      'throttleMs=0&heartbeatMs=0',
      { [SESSION_HEADER]: 'alpha' },
    )
    try {
      const initial = await alphaStream.waitFor((e) => e.data.type === 'ascii_frame')
      expect(initial.data.tabId).toBe(alphaTab)
      expect(initial.data.sessionId).toBe('alpha')
      expect(String(initial.data.ascii)).toContain('Home Portal')

      // Navigate beta's tab -> alphaStream must NOT receive beta's frame or event
      await api(
        '/tool',
        { tabId: betaTab, name: 'page_navigate', args: { url: `${baseUrl}/second` } },
        { [SESSION_HEADER]: 'beta' },
      )

      // Now navigate alpha's tab -> alphaStream receives alpha's navigation
      await api(
        '/tool',
        { tabId: alphaTab, name: 'page_navigate', args: { url: `${baseUrl}/second` } },
        { [SESSION_HEADER]: 'alpha' },
      )
      const alphaNav = await alphaStream.waitFor(
        (e) => e.data.type === 'ascii_frame' && e.data.reason === 'navigated',
      )
      expect(alphaNav.data.tabId).toBe(alphaTab)

      const leakedBeta = alphaStream.events.filter(
        (e) => e.data.sessionId === 'beta' || e.data.tabId === betaTab,
      )
      expect(leakedBeta.length).toBe(0)
    } finally {
      await alphaStream.close()
    }
  })

  it('supports background pollMs mutation detection and reports stream stats in /health', async () => {
    dynamicCounter = 10
    const opened = await api('/open', { url: `${baseUrl}/ticker`, activate: true })
    const tabId = Number(opened.data.id)

    const sse = await openSseClient(
      socket.port,
      socket.token,
      `tabId=${tabId}&pollMs=100&throttleMs=0&heartbeatMs=0`,
    )
    try {
      const first = await sse.waitFor((e) => e.data.type === 'ascii_frame')
      expect(String(first.data.ascii)).toContain('Live status tick #10')

      const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        headers: { 'x-troy-agent': socket.token },
      })
      const health = (await healthRes.json()) as Record<string, unknown>
      const streamStats = health.stream as { clients: number; framesSent: number }
      expect(streamStats.clients).toBeGreaterThanOrEqual(1)
      expect(streamStats.framesSent).toBeGreaterThanOrEqual(1)

      // Simulate out-of-band page reload/mutation on the server
      dynamicCounter = 42
      await api('/tool', { tabId, name: 'page_history', args: { direction: 'reload' } })

      const updated = await sse.waitFor(
        (e) => e.data.type === 'ascii_frame' && String(e.data.ascii).includes('Live status tick #42'),
      )
      expect(Number(updated.data.seq)).toBeGreaterThan(Number(first.data.seq))
    } finally {
      await sse.close()
    }

    // Verify disconnect cleaned up client registration
    await new Promise((r) => setTimeout(r, 40))
    const afterHealthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
      headers: { 'x-troy-agent': socket.token },
    })
    const afterHealth = (await afterHealthRes.json()) as Record<string, unknown>
    expect((afterHealth.stream as { clients: number }).clients).toBe(0)
  })
})
