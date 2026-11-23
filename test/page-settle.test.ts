import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  NetworkIdleTracker,
  executePipeCommand,
  findChromeBinary,
  handleMcpRequest,
  normalizeSettleOptions,
  waitForPageSettle,
} from '../src/index.js'

describe('NetworkIdleTracker unit tests (M18)', () => {
  it('tracks request lifecycle and enforces quiet window after completion', () => {
    const tracker = new NetworkIdleTracker(1000)

    // Already quiet for 300ms
    expect(tracker.getStatus({ quietMs: 250, now: 1300 })).toEqual({
      idle: true,
      inflightCount: 0,
      quietForMs: 300,
    })

    // Start two requests
    tracker.onRequestStart('r1', 'https://app.example/api/user', 'Fetch', 1300)
    tracker.onRequestStart('r2', 'https://app.example/api/feed', 'XHR', 1350)
    expect(tracker.getStatus({ quietMs: 250, now: 1400 })).toEqual({
      idle: false,
      inflightCount: 2,
      quietForMs: 0,
    })

    // Finish first request -> still 1 inflight
    tracker.onRequestFinish('r1', 1420)
    expect(tracker.getStatus({ quietMs: 250, now: 1500 })).toEqual({
      idle: false,
      inflightCount: 1,
      quietForMs: 0,
    })

    // Finish second request at 1500 -> quiet window starts at 1500
    tracker.onRequestFinish('r2', 1500)
    expect(tracker.getStatus({ quietMs: 250, now: 1700 })).toEqual({
      idle: false,
      inflightCount: 0,
      quietForMs: 200,
    })
    expect(tracker.getStatus({ quietMs: 250, now: 1750 })).toEqual({
      idle: true,
      inflightCount: 0,
      quietForMs: 250,
    })
  })

  it('ignores streaming connections (EventSource/WebSocket) and data/blob/about URLs', () => {
    const tracker = new NetworkIdleTracker(0)
    tracker.onRequestStart('sse', 'https://app.example/events', 'EventSource', 100)
    tracker.onRequestStart('ws', 'wss://app.example/socket', 'WebSocket', 100)
    tracker.onRequestStart('data', 'data:image/png;base64,AAAA', 'Image', 100)
    tracker.onRequestStart('blob', 'blob:https://app.example/1234', 'Other', 100)
    tracker.onRequestStart('blank', 'about:blank', 'Document', 100)

    expect(tracker.getInflightCount(150)).toBe(0)
    expect(tracker.getStatus({ quietMs: 100, now: 150 }).idle).toBe(true)
  })

  it('respects maxInflightRequests and prunes stale hanging requests', () => {
    const tracker = new NetworkIdleTracker(0)
    tracker.onRequestStart('hang', 'https://app.example/long-poll', 'Fetch', 1000)

    // With maxInflight=0 it is busy
    expect(tracker.getStatus({ quietMs: 200, maxInflight: 0, staleRequestMs: 2000, now: 1500 }).idle).toBe(false)

    // With maxInflight=1 it can be idle once quietMs passes after start
    expect(tracker.getStatus({ quietMs: 200, maxInflight: 1, staleRequestMs: 2000, now: 1500 })).toEqual({
      idle: true,
      inflightCount: 1,
      quietForMs: 500,
    })

    // After staleRequestMs (1000 + 2000 = 3000), request is pruned and quiet window counts from 3000
    expect(tracker.getInflightCount(3000, 2000)).toBe(0)
    expect(tracker.getStatus({ quietMs: 200, maxInflight: 0, staleRequestMs: 2000, now: 3100 }).idle).toBe(false)
    expect(tracker.getStatus({ quietMs: 200, maxInflight: 0, staleRequestMs: 2000, now: 3250 }).idle).toBe(true)
  })

  it('resets inflight state on navigation', () => {
    const tracker = new NetworkIdleTracker(0)
    tracker.onRequestStart('old', 'https://old.example/api', 'Fetch', 100)
    expect(tracker.getInflightCount(120)).toBe(1)
    tracker.onNavigationReset(200)
    expect(tracker.getInflightCount(210)).toBe(0)
    expect(tracker.getStatus({ quietMs: 100, now: 250 }).idle).toBe(false)
    expect(tracker.getStatus({ quietMs: 100, now: 300 }).idle).toBe(true)
  })
})

describe('waitForPageSettle orchestrator unit tests (M18)', () => {
  it('normalizes and clamps settle options', () => {
    const opts = normalizeSettleOptions({
      timeoutMs: 999999,
      networkIdleMs: -5,
      domQuietMs: 150,
      maxInflightRequests: 50,
      pollIntervalMs: 1,
    })
    expect(opts.timeoutMs).toBe(30000)
    expect(opts.networkIdleMs).toBe(0)
    expect(opts.domQuietMs).toBe(150)
    expect(opts.maxInflightRequests).toBe(20)
    expect(opts.pollIntervalMs).toBe(10)
  })

  it('waits until both network idle and DOM quiet are satisfied and recovers from transient DOM errors', async () => {
    let clock = 0
    let domCalls = 0

    const res = await waitForPageSettle(
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
        checkNetwork: (now) => ({
          idle: now >= 200,
          inflightCount: now >= 200 ? 0 : 1,
        }),
        checkDom: (now) => {
          domCalls += 1
          if (domCalls === 1) {
            throw new Error('Execution context was destroyed')
          }
          return {
            quiet: now >= 320,
            mutationCount: now >= 320 ? 7 : 3,
            quietForMs: now >= 320 ? 200 : 40,
            readyState: 'complete',
          }
        },
      },
      { timeoutMs: 2000, pollIntervalMs: 40, networkIdleMs: 100, domQuietMs: 100 },
    )

    expect(res.ok).toBe(true)
    expect(res.settled).toBe(true)
    expect(res.timedOut).toBe(false)
    expect(res.reason).toBe('settled')
    expect(res.networkIdle).toBe(true)
    expect(res.domQuiet).toBe(true)
    expect(res.mutationCount).toBe(7)
    expect(res.waitedMs).toBe(320)
  })

  it('returns skipped immediately when both network and DOM settle checks are disabled', async () => {
    const res = await waitForPageSettle({}, { waitForNetworkIdle: false, waitForDomQuiet: false })
    expect(res.ok).toBe(true)
    expect(res.settled).toBe(true)
    expect(res.reason).toBe('skipped')
    expect(res.waitedMs).toBe(0)
  })

  it('times out cleanly with actionable diagnostics when page never settles', async () => {
    let clock = 0
    const res = await waitForPageSettle(
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
        checkNetwork: () => ({ idle: false, inflightCount: 2 }),
        checkDom: () => ({ quiet: false, mutationCount: 42, quietForMs: 5 }),
      },
      { timeoutMs: 200, pollIntervalMs: 50 },
    )

    expect(res.ok).toBe(false)
    expect(res.settled).toBe(false)
    expect(res.timedOut).toBe(true)
    expect(res.reason).toBe('timeout')
    expect(res.inflightCount).toBe(2)
    expect(res.mutationCount).toBe(42)
    expect(res.error).toContain('2 inflight')
    expect(res.error).toContain('42 mutations')
  })
})

describe('waitForPageSettle in Lite engine + BrowserManager + MCP + Pipe (M18)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Lite Settle</title></head><body><h1>Ready</h1><button>Go</button></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`

    manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: path.join(os.tmpdir(), `troy-settle-lite-${Date.now()}`),
      memoryEnabled: false,
    })
    await manager.openTab(baseUrl)
  })

  afterAll(async () => {
    await manager.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('settles immediately on Lite engine via manager, page_wait, page_read_ascii, MCP, and Pipe', async () => {
    const direct = await manager.waitForSettle(undefined, { timeoutMs: 1000 })
    expect(direct.ok).toBe(true)
    expect(direct.settled).toBe(true)
    expect(direct.networkIdle).toBe(true)
    expect(direct.domQuiet).toBe(true)

    const waitRes = await manager.runTool(undefined, 'page_wait', { settle: true, timeout: 1000 })
    expect(waitRes.ok).toBe(true)
    expect((waitRes.matched as { settled?: boolean }).settled).toBe(true)

    const readRes = await manager.runTool(undefined, 'page_read_ascii', { settle: true, width: 70 })
    expect(readRes.ok).toBe(true)
    expect((readRes.settle as { settled?: boolean }).settled).toBe(true)
    expect(String(readRes.ascii)).toContain('READY')

    const mcpRes = (await handleMcpRequest(manager, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'troy_wait', arguments: { settle: true, timeout: 1000 } },
    })) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(mcpRes.result.isError).toBe(false)
    expect(JSON.parse(mcpRes.result.content[0]!.text).ok).toBe(true)

    const pipeRes = await executePipeCommand(manager, 'wait --settle --timeout 1000', { jsonMode: true })
    expect(JSON.parse(pipeRes.output).ok).toBe(true)
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('waitForPageSettle in Headless Chromium CDP (SPA Hydration E2E) (M18)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/api/hydrate') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ items: ['Alpha', 'Beta', 'Gamma'], readyLabel: 'Hydrated Dashboard' }))
        }, 180)
        return
      }

      if (url.pathname === '/api/more') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ extra: 'Delta Loaded' }))
        }, 200)
        return
      }

      if (url.pathname === '/spa') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>SPA Hydration Test</title></head>
  <body>
    <h1 id="title">Loading Skeleton...</h1>
    <ul id="list"></ul>
    <button id="load-more" type="button" style="display:none">Load More</button>
    <p id="extra"></p>
    <script>
      fetch('/api/hydrate')
        .then((r) => r.json())
        .then((data) => {
          // Staggered DOM mutations simulating framework hydration
          setTimeout(() => {
            document.getElementById('title').textContent = data.readyLabel;
          }, 40);
          setTimeout(() => {
            const ul = document.getElementById('list');
            data.items.forEach((item) => {
              const li = document.createElement('li');
              li.textContent = item;
              ul.appendChild(li);
            });
            document.getElementById('load-more').style.display = 'inline-block';
          }, 110);
        });

      document.getElementById('load-more').addEventListener('click', () => {
        document.getElementById('extra').textContent = 'Fetching...';
        fetch('/api/more')
          .then((r) => r.json())
          .then((d) => {
            setTimeout(() => {
              document.getElementById('extra').textContent = d.extra;
            }, 60);
          });
      });
    </script>
  </body>
</html>`)
        return
      }

      if (url.pathname === '/noisy') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Noisy Ticker</title></head>
  <body>
    <div id="tick">0</div>
    <script>
      let n = 0;
      setInterval(() => {
        n += 1;
        document.getElementById('tick').textContent = String(n);
      }, 25);
    </script>
  </body>
</html>`)
        return
      }

      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`

    manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: path.join(os.tmpdir(), `troy-settle-chromium-${Date.now()}`),
      memoryEnabled: false,
    })
  }, 20000)

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  it('automatically waits for SPA network + DOM hydration on navigate and after dynamic click', async () => {
    const opened = await manager.openTab(`${baseUrl}/spa`)
    expect(opened.ok).toBe(true)

    // Because navigate() uses waitForSettle(), the very first snapshot should see the hydrated SPA!
    const snap1 = await manager.runTool(opened.id, 'page_read_ascii', { width: 80 })
    expect(snap1.ok).toBe(true)
    expect(String(snap1.ascii)).toContain('HYDRATED DASHBOARD')
    expect(String(snap1.ascii)).toContain('Gamma')
    expect(String(snap1.ascii)).toContain('Load More')

    // Click "Load More", then use page_wait --settle and verify async fetch + DOM update completed
    const findBtn = await manager.runTool(opened.id, 'page_find', { query: 'Load More' })
    const btnRef = (findBtn.matches as Array<{ ref: string }>)[0]?.ref
    expect(btnRef).toBeTruthy()

    const clicked = await manager.runTool(opened.id, 'page_click', { ref: btnRef })
    expect(clicked.ok).toBe(true)

    const settled = await manager.runTool(opened.id, 'page_wait', {
      settle: true,
      networkIdleMs: 150,
      domQuietMs: 150,
      timeout: 3000,
    })
    expect(settled.ok).toBe(true)
    expect((settled.settle as { settled: boolean; mutationCount: number }).settled).toBe(true)
    expect((settled.settle as { mutationCount: number }).mutationCount).toBeGreaterThan(0)

    const snap2 = await manager.runTool(opened.id, 'page_read_ascii', { width: 80 })
    expect(String(snap2.ascii)).toContain('Delta Loaded')
  }, 20000)

  it('times out cleanly on a page with continuous DOM mutations without hanging', async () => {
    const opened = await manager.openTab(`${baseUrl}/noisy`)
    expect(opened.ok).toBe(true)

    const res = await manager.waitForSettle(opened.id, {
      timeoutMs: 260,
      domQuietMs: 150,
      networkIdleMs: 100,
      pollIntervalMs: 30,
    })
    expect(res.ok).toBe(false)
    expect(res.settled).toBe(false)
    expect(res.timedOut).toBe(true)
    expect(res.domQuiet).toBe(false)
    expect(res.mutationCount).toBeGreaterThan(0)
  }, 20000)
})
