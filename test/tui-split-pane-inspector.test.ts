import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii, stripAnsi } from '../src/ascii/layout.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  INSPECTOR_TABS,
  composeSplitPaneFrame,
  computeSplitPaneWidths,
  cycleInspectorTab,
  parseInspectorTab,
  renderInspectorPane,
  type InspectorData,
} from '../src/tui/inspector.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 120
  stream.rows = opts.rows ?? 26
  stream.on('data', (chunk) => {
    chunks.push(chunk.toString('utf8'))
  })
  return {
    stream,
    getText: () => chunks.join(''),
    getLastChunk: () => chunks[chunks.length - 1] ?? '',
    clear: () => {
      chunks.length = 0
    },
  }
}

function createMockTtyInput() {
  const stream = new PassThrough() as unknown as TuiInputStream & PassThrough
  stream.isTTY = true
  stream.setRawMode = () => {}
  return stream
}

function makeSampleInspectorData(): InspectorData {
  return {
    consoleEntries: [
      { level: 'log', text: 'App initialized cleanly', ts: 1700000001000 },
      { level: 'warning', text: 'Deprecated API called', ts: 1700000002000 },
      { level: 'error', text: 'Uncaught TypeError: boom 💥', ts: 1700000003000 },
    ],
    networkEntries: [
      {
        requestId: 'req-1',
        url: 'https://example.com/dashboard',
        method: 'GET',
        status: 200,
        ok: true,
        durationMs: 42,
        ts: 1700000001000,
      },
      {
        requestId: 'req-2',
        url: 'https://example.com/api/items?limit=10',
        method: 'GET',
        status: 304,
        ok: true,
        cacheStatus: 'revalidated',
        durationMs: 12,
        ts: 1700000002000,
      },
      {
        requestId: 'req-3',
        url: 'https://tracker.doubleclick.net/beacon',
        method: 'POST',
        ok: false,
        blocked: true,
        blockedReason: 'tracker',
        ts: 1700000003000,
      },
    ],
    elements: [
      { ref: 'e1', selector: 'a#home', tag: 'a', type: '', text: 'Home', href: '/home' },
      { ref: 'e2', selector: 'input#q', tag: 'input', type: 'text', text: '', placeholder: 'Search' },
      { ref: 'e3', selector: 'button#go', tag: 'button', type: 'button', text: 'Submit' },
    ],
    activityEntries: [
      { id: 1, ts: 1700000001000, tabId: 1, tool: 'tab_open', summary: 'https://example.com/', ok: true, durationMs: 35 },
      { id: 2, ts: 1700000002000, tabId: 1, tool: 'page_find', summary: 'q="Search"', ok: true, durationMs: 4 },
      { id: 3, ts: 1700000003000, tabId: 1, tool: 'page_click', summary: 'ref=e99', ok: false, durationMs: 2, error: 'stale ref' },
    ],
    focusedRef: 'e2',
  }
}

describe('M45: Split-pane TUI mode & live Inspector (Console / Network / Refs / Agent Activity)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    const extraLinks = Array.from(
      { length: 24 },
      (_, i) => `<p><a href="/item-${i + 1}">Item Link ${i + 1}</a></p>`,
    ).join('\n')

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/about') {
        res.end(`<!doctype html><html><head><title>About Page</title></head><body><h1>About Troy</h1><a href="/">Back Home</a></body></html>`)
        return
      }
      res.end(`<!doctype html>
<html>
  <head><title>Split Pane Demo</title></head>
  <body>
    <h1>Split Pane Demo</h1>
    <p>Inspect live Console, Network, Refs, and Agent Activity side-by-side.</p>
    <nav>
      <a href="/about">About Page</a>
    </nav>
    <form action="/search">
      <label>Query <input name="q" type="text" placeholder="Type query" /></label>
      <button type="button">Search Now</button>
    </form>
    <ul>
      ${extraLinks}
    </ul>
  </body>
</html>`)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('Pure inspector layout & rendering (src/tui/inspector.ts)', () => {
    it('computes split-pane widths accurately and rejects narrow terminals (< 72 cols)', () => {
      expect(computeSplitPaneWidths(60).canSplit).toBe(false)
      expect(computeSplitPaneWidths(71).canSplit).toBe(false)

      for (const total of [72, 100, 120, 160, 220]) {
        const layout = computeSplitPaneWidths(total)
        expect(layout.canSplit).toBe(true)
        expect(layout.leftWidth).toBeGreaterThanOrEqual(42)
        expect(layout.rightWidth).toBeGreaterThanOrEqual(28)
        expect(layout.leftWidth + layout.gapWidth + layout.rightWidth).toBe(total)
      }
    })

    it('parses inspector tab names/aliases and cycles cleanly', () => {
      expect(parseInspectorTab('console')).toBe('console')
      expect(parseInspectorTab('con')).toBe('console')
      expect(parseInspectorTab('1')).toBe('console')
      expect(parseInspectorTab('net')).toBe('network')
      expect(parseInspectorTab('2')).toBe('network')
      expect(parseInspectorTab('elements')).toBe('refs')
      expect(parseInspectorTab('3')).toBe('refs')
      expect(parseInspectorTab('agent')).toBe('activity')
      expect(parseInspectorTab('4')).toBe('activity')
      expect(parseInspectorTab('unknown')).toBeUndefined()

      expect(INSPECTOR_TABS).toEqual(['console', 'network', 'refs', 'activity'])
      expect(cycleInspectorTab('console', 1)).toBe('network')
      expect(cycleInspectorTab('activity', 1)).toBe('console')
      expect(cycleInspectorTab('console', -1)).toBe('activity')
    })

    it('renders all 4 inspector tabs with exact dimensions, counts, and strict 7-bit ASCII when asciiOnly=true', () => {
      const data = makeSampleInspectorData()
      for (const tab of INSPECTOR_TABS) {
        const rendered = renderInspectorPane(data, {
          width: 48,
          height: 18,
          activeTab: tab,
          asciiOnly: true,
          color: false,
          activePane: tab === 'refs' ? 'inspector' : 'page',
        })

        expect(rendered.lines.length).toBe(18)
        for (const line of rendered.lines) {
          expect(stripAnsi(line).length).toBe(48)
          expect(isStrictAscii(line)).toBe(true)
        }
        expect(rendered.counts).toEqual({ console: 3, network: 3, refs: 3, activity: 3 })

        const joined = rendered.lines.join('\n')
        if (tab === 'console') {
          expect(joined).toContain('[ERR]')
          expect(joined).toContain('[WRN]')
          expect(joined).toContain('App initialized cleanly')
        } else if (tab === 'network') {
          expect(joined).toContain('GET 200')
          expect(joined).toContain('GET 304')
          expect(joined).toContain('POST BLK')
          expect(joined).toContain('BLOCKED')
        } else if (tab === 'refs') {
          expect(joined).toContain('INSPECTOR [ACTIVE]')
          expect(joined).toContain('>[e2] <input:text>')
          expect(joined).toContain(' [e1] <a>')
        } else if (tab === 'activity') {
          // Newest first (#3 before #1)
          const idx3 = joined.indexOf('#3 [ERR] page_click')
          const idx1 = joined.indexOf('#1 [OK] tab_open')
          expect(idx3).toBeGreaterThan(-1)
          expect(idx1).toBeGreaterThan(idx3)
        }
      }
    })

    it('renders empty state placeholders cleanly for all 4 tabs', () => {
      const empty: InspectorData = {
        consoleEntries: [],
        networkEntries: [],
        elements: [],
        activityEntries: [],
      }
      expect(renderInspectorPane(empty, { width: 40, height: 14, activeTab: 'console', asciiOnly: true }).lines.join('\n')).toContain('(no console messages)')
      expect(renderInspectorPane(empty, { width: 40, height: 14, activeTab: 'network', asciiOnly: true }).lines.join('\n')).toContain('(no network requests)')
      expect(renderInspectorPane(empty, { width: 40, height: 14, activeTab: 'refs', asciiOnly: true }).lines.join('\n')).toContain('(no interactive refs)')
      expect(renderInspectorPane(empty, { width: 40, height: 14, activeTab: 'activity', asciiOnly: true }).lines.join('\n')).toContain('(no agent activity yet)')
    })

    it('composes left and right panes side-by-side with exact total row widths', () => {
      const leftLines = Array.from({ length: 14 }, (_, i) => `+${'-'.repeat(48)}+`.replace('-', String(i % 10)))
      const rightRendered = renderInspectorPane(makeSampleInspectorData(), {
        width: 40,
        height: 14,
        activeTab: 'network',
        asciiOnly: true,
      })
      const composed = composeSplitPaneFrame(leftLines.join('\n'), rightRendered.lines, {
        leftWidth: 50,
        rightWidth: 40,
        gapWidth: 1,
        asciiOnly: true,
      })
      const rows = composed.split('\n')
      expect(rows.length).toBe(14)
      for (const row of rows) {
        expect(stripAnsi(row).length).toBe(91)
        expect(isStrictAscii(row)).toBe(true)
      }
    })
  })

  describe('BrowserManager live Agent Activity & inspector getters', () => {
    it('records tab_open, origin_grant, and runTool calls without polling getters polluting the log', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
      try {
        await manager.openTab(baseUrl, { activate: true })
        manager.grantOrigin(baseUrl)
        const findRes = await manager.runTool(undefined, 'page_find', { query: 'About' })
        expect(findRes.ok).toBe(true)

        const badClick = await manager.runTool(undefined, 'page_click', { ref: 'e9999' })
        expect(badClick.ok).toBe(false)

        const activity1 = manager.getAgentActivity()
        const activity2 = manager.getAgentActivity()
        expect(activity1.length).toBe(activity2.length)
        expect(activity1.map((a) => a.tool)).toEqual(['tab_open', 'origin_grant', 'page_find', 'page_click'])
        expect(activity1[2]?.ok).toBe(true)
        expect(activity1[2]?.summary).toContain('q="About"')
        expect(activity1[3]?.ok).toBe(false)
        expect(activity1[3]?.error).toBeTruthy()

        const net = manager.getTabNetwork()
        expect(net.length).toBeGreaterThanOrEqual(1)
        expect(net[0]?.url).toContain('127.0.0.1')

        // Clear activity buffer
        manager.getAgentActivity({ clear: true })
        expect(manager.getAgentActivity().length).toBe(0)
      } finally {
        await manager.close()
      }
    })
  })

  describe('Interactive TerminalBrowserController split-pane workflow', () => {
    it('toggles split-pane with i, cycles tabs with ]/[, switches pane focus with I, and scrolls inspector independently', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
      try {
        const input = createMockTtyInput()
        const out = createMockOutput({ isTTY: false, columns: 120, rows: 24 })
        const ctrl = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input,
          output: out.stream,
          rawMode: true,
          asciiOnly: true,
          width: 120,
          height: 20,
        })

        await ctrl.init()
        expect(ctrl.getState().splitPane).toBe(false)
        expect(out.getLastChunk()).not.toContain('INSPECTOR')

        // Press `i` to open split-pane inspector (default tab: console)
        out.clear()
        await ctrl.handleKeypress('i', { name: 'i', sequence: 'i' })
        expect(ctrl.getState().splitPane).toBe(true)
        expect(ctrl.getState().inspectorTab).toBe('console')
        const consoleFrame = out.getLastChunk()
        expect(consoleFrame).toContain('INSPECTOR')
        expect(consoleFrame).toContain('[1:Con(')
        expect(consoleFrame).toContain('Split Pane Demo')

        // Verify every composed line has exact total width 120 and strict ASCII
        const frameLines = consoleFrame.trimEnd().split('\n')
        for (const line of frameLines) {
          expect(stripAnsi(line).length).toBe(120)
          expect(isStrictAscii(line)).toBe(true)
        }

        // Press `]` to cycle to Network tab -> should show live GET 200 request
        out.clear()
        await ctrl.handleKeypress(']', { sequence: ']' })
        expect(ctrl.getState().inspectorTab).toBe('network')
        const netFrame = out.getLastChunk()
        expect(netFrame).toContain('[2:Net(')
        expect(netFrame).toContain('GET 200')

        // Press `]` to cycle to Refs tab, then press Tab to focus e1 -> Refs pane highlights >[e1]
        out.clear()
        await ctrl.handleKeypress(']', { sequence: ']' })
        expect(ctrl.getState().inspectorTab).toBe('refs')
        await ctrl.handleKeypress(undefined, { name: 'tab' })
        const refsFrame = out.getLastChunk()
        expect(ctrl.getState().focusedRef).toBe('e1')
        expect(refsFrame).toContain('>[e1]')

        // Press `I` (Shift+I) to focus the inspector pane and scroll down with `j` without scrolling the page
        const pageScrollBefore = ctrl.getState().scrollOffset
        out.clear()
        await ctrl.handleKeypress('I', { name: 'i', shift: true, sequence: 'I' })
        expect(ctrl.getState().activePane).toBe('inspector')
        expect(out.getLastChunk()).toContain('INSPECTOR [ACTIVE]')

        await ctrl.handleKeypress('j', { name: 'j', sequence: 'j' })
        await ctrl.handleKeypress('j', { name: 'j', sequence: 'j' })
        expect(ctrl.getState().inspectorScrollOffset).toBe(2)
        expect(ctrl.getState().scrollOffset).toBe(pageScrollBefore)

        // Jump to bottom (`G`) and top (`g`) inside inspector
        await ctrl.handleKeypress('G', { name: 'g', shift: true, sequence: 'G' })
        expect(ctrl.getState().inspectorScrollOffset).toBe(ctrl.getState().inspectorMaxScrollOffset)
        expect(ctrl.getState().inspectorScrollOffset).toBeGreaterThan(0)
        await ctrl.handleKeypress('g', { name: 'g', sequence: 'g' })
        expect(ctrl.getState().inspectorScrollOffset).toBe(0)

        // Press `4` while inspector is active to jump straight to Agent Activity tab
        out.clear()
        await ctrl.handleKeypress('4', { sequence: '4' })
        expect(ctrl.getState().inspectorTab).toBe('activity')
        expect(out.getLastChunk()).toContain('tab_open')

        // Press `i` to close split-pane -> activePane resets to 'page'
        out.clear()
        await ctrl.handleKeypress('i', { name: 'i', sequence: 'i' })
        expect(ctrl.getState().splitPane).toBe(false)
        expect(ctrl.getState().activePane).toBe('page')
        expect(out.getLastChunk()).not.toContain('INSPECTOR')
      } finally {
        await manager.close()
      }
    })

    it('supports colon/line commands (:split, :network, :activity, :inspector off, :inspector clear) and initial splitPane option', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
      try {
        const input = createMockTtyInput()
        const out = createMockOutput({ isTTY: false, columns: 116, rows: 22 })
        const ctrl = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input,
          output: out.stream,
          rawMode: false,
          asciiOnly: true,
          width: 116,
          height: 18,
          splitPane: true,
          inspectorTab: 'activity',
        })

        await ctrl.init()
        expect(ctrl.getState().splitPane).toBe(true)
        expect(ctrl.getState().inspectorTab).toBe('activity')
        expect(out.getLastChunk()).toContain('tab_open')

        await ctrl.executeCommand('network')
        expect(ctrl.getState().inspectorTab).toBe('network')

        await ctrl.executeCommand('inspector clear')
        expect(manager.getTabNetwork().length).toBe(0)

        await ctrl.executeCommand('inspector off')
        expect(ctrl.getState().splitPane).toBe(false)

        await ctrl.executeCommand('split')
        expect(ctrl.getState().splitPane).toBe(true)
      } finally {
        await manager.close()
      }
    })

    it('gracefully refuses split-pane on narrow terminals (< 72 cols) without corrupting layout', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
      try {
        const input = createMockTtyInput()
        const out = createMockOutput({ isTTY: false, columns: 64, rows: 20 })
        const ctrl = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input,
          output: out.stream,
          rawMode: true,
          asciiOnly: true,
          width: 64,
          height: 18,
        })

        await ctrl.init()
        await ctrl.handleKeypress('i', { name: 'i', sequence: 'i' })
        expect(ctrl.getState().splitPane).toBe(false)
        expect(ctrl.getState().statusMessage).toContain('too narrow')
      } finally {
        await manager.close()
      }
    })
  })
})
