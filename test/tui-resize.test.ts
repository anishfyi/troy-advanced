import { EventEmitter } from 'node:events'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii, stripAnsi } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  DEFAULT_TUI_COLUMNS,
  MAX_TUI_HEIGHT,
  MAX_TUI_WIDTH,
  MIN_TUI_HEIGHT,
  MIN_TUI_WIDTH,
  TerminalResizeWatcher,
  dimensionsEqual,
  formatResizeStatus,
  resolveViewportDimensions,
  type ResizeEvent,
} from '../src/tui/resize.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 110
  stream.rows = opts.rows ?? 32
  stream.on('data', (chunk) => {
    chunks.push(chunk.toString('utf8'))
  })
  return {
    stream,
    getText: () => chunks.join(''),
    getChunks: () => [...chunks],
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

async function waitFor(predicate: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe('M50: Terminal resize (SIGWINCH) live reflow handler', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      const paragraphs = Array.from({ length: 18 }, (_, i) => {
        const num = i + 1
        return `<p>Section ${num}: Terminal browsers inside tmux and GNU screen panes need smooth live reflow whenever SIGWINCH arrives. <a href="/sec-${num}">Open Section ${num}</a></p>`
      }).join('\n')
      res.end(
        `<!doctype html>
        <html>
          <head><title>Tmux Reflow Demo</title></head>
          <body>
            <h1>Tmux Reflow Demo</h1>
            <form action="/search">
              <label>Query <input type="text" name="q" value="tmux" /></label>
              <button type="submit">Search</button>
            </form>
            ${paragraphs}
          </body>
        </html>`,
      )
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('resolveViewportDimensions & formatResizeStatus', () => {
    it('clamps ultra-narrow and ultra-wide terminal sizes cleanly', () => {
      const tiny = resolveViewportDimensions({ columns: 24, rows: 8 })
      expect(tiny.width).toBe(MIN_TUI_WIDTH)
      expect(tiny.height).toBe(MIN_TUI_HEIGHT)
      expect(tiny.clamped).toBe(true)

      const huge = resolveViewportDimensions({ columns: 400, rows: 200 })
      expect(huge.width).toBe(MAX_TUI_WIDTH)
      expect(huge.height).toBe(MAX_TUI_HEIGHT)
      expect(huge.clamped).toBe(true)

      const normal = resolveViewportDimensions({ columns: 104, rows: 35 })
      expect(normal.width).toBe(104)
      expect(normal.height).toBe(32)
      expect(normal.clamped).toBe(false)

      const fallback = resolveViewportDimensions({ columns: Number.NaN, rows: 0 })
      expect(fallback.width).toBe(DEFAULT_TUI_COLUMNS)
      expect(fallback.height).toBe(33)
    })

    it('respects explicit width/height overrides and compares dimensions', () => {
      const dims = resolveViewportDimensions({ columns: 120, rows: 40 }, { width: 80, height: 22 })
      expect(dims.width).toBe(80)
      expect(dims.height).toBe(22)
      expect(dimensionsEqual(dims, { width: 80, height: 22 })).toBe(true)
      expect(dimensionsEqual(dims, { width: 82, height: 22 })).toBe(false)
      expect(dimensionsEqual(null, dims)).toBe(false)
    })

    it('formats concise strict-ASCII status messages for resize and pane adaptation', () => {
      const prev = resolveViewportDimensions({ columns: 120, rows: 32 })
      const next = resolveViewportDimensions({ columns: 64, rows: 24 })
      const msg = formatResizeStatus(
        { previous: prev, current: next, source: 'SIGWINCH', resizeCount: 1 },
        { pausedPanes: ['sidebar', 'split-pane'] },
      )
      expect(msg).toBe('Resized to 64x21 (paused sidebar, split-pane: narrow)')
      expect(isStrictAscii(msg)).toBe(true)

      const manual = formatResizeStatus({
        previous: prev,
        current: prev,
        source: 'manual',
        resizeCount: 2,
      })
      expect(manual).toBe('Reflowed 120x29')
      expect(isStrictAscii(manual)).toBe(true)
    })
  })

  describe('TerminalResizeWatcher', () => {
    it('debounces rapid tmux pane-drag bursts and deduplicates SIGWINCH + stdout resize', async () => {
      const out = createMockOutput({ isTTY: true, columns: 120, rows: 36 })
      const signals = new EventEmitter()
      const events: ResizeEvent[] = []

      const watcher = new TerminalResizeWatcher({
        output: out.stream,
        signalSource: signals,
        debounceMs: 25,
        onResize: (ev) => {
          events.push(ev)
        },
      })

      watcher.start()
      expect(watcher.isRunning()).toBe(true)
      expect(signals.listenerCount('SIGWINCH')).toBe(1)
      expect(out.stream.listenerCount('resize')).toBe(1)

      // Simulate rapid drag resize firing both SIGWINCH and output 'resize'
      out.stream.columns = 105
      out.stream.rows = 30
      signals.emit('SIGWINCH')
      out.stream.emit('resize')

      out.stream.columns = 92
      out.stream.rows = 26
      signals.emit('SIGWINCH')
      out.stream.emit('resize')

      out.stream.columns = 80
      out.stream.rows = 24
      out.stream.emit('resize')

      // Not yet fired during debounce window
      expect(events).toHaveLength(0)

      await waitFor(() => events.length === 1)
      expect(events).toHaveLength(1)
      expect(events[0]!.current.width).toBe(80)
      expect(events[0]!.current.height).toBe(21)
      expect(events[0]!.source).toBe('SIGWINCH')
      expect(watcher.getResizeCount()).toBe(1)

      // Duplicate resize with identical dimensions is ignored
      signals.emit('SIGWINCH')
      out.stream.emit('resize')
      await new Promise((r) => setTimeout(r, 45))
      expect(events).toHaveLength(1)

      // Stop detaches all listeners and cancels pending timers
      out.stream.columns = 140
      signals.emit('SIGWINCH')
      watcher.stop()
      expect(watcher.isRunning()).toBe(false)
      expect(signals.listenerCount('SIGWINCH')).toBe(0)
      expect(out.stream.listenerCount('resize')).toBe(0)

      await new Promise((r) => setTimeout(r, 45))
      expect(events).toHaveLength(1)
    })
  })

  describe('TerminalBrowserController live reflow integration', () => {
    it('reflows viewport width/height, clamps scroll offset, and preserves strict ASCII', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const out = createMockOutput({ isTTY: false, columns: 120, rows: 30 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input: createMockTtyInput(),
        output: out.stream,
        rawMode: true,
        asciiOnly: true,
        libraryPath: null,
      })

      try {
        await ctrl.init()
        expect(ctrl.getState().viewportWidth).toBe(120)
        expect(ctrl.getState().viewportHeight).toBe(27)
        expect(ctrl.getState().resizeCount).toBe(0)

        // Scroll to bottom at 120 cols
        await ctrl.handleKeypress('G', { name: 'g', shift: true, sequence: 'G' })
        const bottomBefore = ctrl.getState().scrollOffset
        expect(bottomBefore).toBeGreaterThan(0)

        // Shrink terminal to a narrow 54-col tmux pane
        out.clear()
        out.stream.columns = 54
        out.stream.rows = 20
        const redrawn = await ctrl.handleResize({ source: 'SIGWINCH' })
        expect(redrawn).toBe(true)

        const state = ctrl.getState()
        expect(state.viewportWidth).toBe(54)
        expect(state.viewportHeight).toBe(17)
        expect(state.resizeCount).toBe(1)
        expect(state.statusMessage).toBe('Resized to 54x17')
        expect(state.scrollOffset).toBeLessThanOrEqual(state.maxScrollOffset)

        const frame = out.getText()
        expect(isStrictAscii(frame)).toBe(true)
        const nonEmptyLines = frame.split('\n').filter((l) => l.length > 0)
        for (const line of nonEmptyLines) {
          expect(stripAnsi(line).length).toBeLessThanOrEqual(54)
        }
      } finally {
        await manager.close()
      }
    })

    it('gracefully pauses sidebar and split-pane on narrow tmux split and restores on widen', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const out = createMockOutput({ isTTY: false, columns: 132, rows: 30 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input: createMockTtyInput(),
        output: out.stream,
        rawMode: true,
        asciiOnly: true,
        splitPane: true,
        sidebarOpen: true,
        libraryPath: null,
      })

      try {
        await ctrl.init()
        // Focus inspector pane (or sidebar is active initially)
        expect(ctrl.getState().sidebarOpen).toBe(true)
        expect(ctrl.getState().splitPane).toBe(true)
        expect(ctrl.getState().mode).toBe('sidebar')
        expect(ctrl.getState().sidebarSuspendedByWidth).toBe(false)
        expect(ctrl.getState().splitPaneSuspendedByWidth).toBe(false)

        // Shrink tmux pane to 58 cols (< 72 threshold)
        out.clear()
        out.stream.columns = 58
        out.stream.rows = 22
        await ctrl.handleResize({ source: 'SIGWINCH' })

        const narrowState = ctrl.getState()
        expect(narrowState.sidebarSuspendedByWidth).toBe(true)
        expect(narrowState.splitPaneSuspendedByWidth).toBe(true)
        expect(narrowState.mode).toBe('normal')
        expect(narrowState.activePane).toBe('page')
        expect(narrowState.statusMessage).toContain('paused sidebar, split-pane: narrow')

        // Every line fits inside 58 columns cleanly without wrapping corruption
        const narrowLines = out.getText().split('\n').filter((l) => l.length > 0)
        for (const line of narrowLines) {
          expect(stripAnsi(line).length).toBeLessThanOrEqual(58)
        }

        // Expand tmux pane back to 136 cols (e.g., tmux Ctrl-b z zoom)
        out.clear()
        out.stream.columns = 136
        out.stream.rows = 32
        await ctrl.handleResize({ source: 'SIGWINCH' })

        const wideState = ctrl.getState()
        expect(wideState.sidebarSuspendedByWidth).toBe(false)
        expect(wideState.splitPaneSuspendedByWidth).toBe(false)
        expect(wideState.statusMessage).toContain('restored sidebar, split-pane')
        expect(out.getText()).toContain('Bookmarks')
        expect(out.getText()).toContain('INSPECTOR')
      } finally {
        await manager.close()
      }
    })

    it('keeps focused ref visible when terminal height shrinks and supports Ctrl+L / :reflow', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const out = createMockOutput({ isTTY: false, columns: 100, rows: 34 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input: createMockTtyInput(),
        output: out.stream,
        rawMode: true,
        asciiOnly: true,
        libraryPath: null,
      })

      try {
        await ctrl.init()
        // Tab forward several times to focus a ref lower on the page
        for (let i = 0; i < 10; i++) {
          await ctrl.handleKeypress('\t', { name: 'tab', sequence: '\t' })
        }
        const focusedBefore = ctrl.getState().focusedRef
        expect(focusedBefore).toBeTruthy()

        // Shrink height dramatically
        out.stream.rows = 18
        await ctrl.handleResize({ source: 'resize' })

        const state = ctrl.getState()
        expect(state.focusedRef).toBe(focusedBefore)
        expect(state.focusedLineIndex).not.toBeNull()
        expect(state.focusedLineIndex!).toBeGreaterThanOrEqual(state.scrollOffset)
        expect(state.focusedLineIndex!).toBeLessThan(state.scrollOffset + state.viewportRows)

        // Ctrl+L forces a manual reflow even when dimensions are unchanged
        const prevCount = state.resizeCount
        const keyRes = await ctrl.handleKeypress('\x0c', { name: 'l', ctrl: true, sequence: '\x0c' })
        expect(keyRes.drawn).toBe(true)
        expect(ctrl.getState().resizeCount).toBe(prevCount + 1)
        expect(ctrl.getState().statusMessage).toMatch(/^Reflowed 100x15/)

        // :reflow command also triggers manual reflow
        const cmdRes = await ctrl.executeCommand('reflow')
        expect(cmdRes.shouldExit).toBe(false)
        expect(ctrl.getState().resizeCount).toBe(prevCount + 2)
      } finally {
        await manager.close()
      }
    })

    it('reflows live overlays (command palette) cleanly on resize', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const out = createMockOutput({ isTTY: false, columns: 110, rows: 30 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input: createMockTtyInput(),
        output: out.stream,
        rawMode: true,
        asciiOnly: true,
        libraryPath: null,
      })

      try {
        await ctrl.init()
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        expect(ctrl.getState().mode).toBe('palette')

        out.clear()
        out.stream.columns = 66
        out.stream.rows = 22
        await ctrl.handleResize({ source: 'SIGWINCH' })

        expect(ctrl.getState().mode).toBe('palette')
        const rendered = out.getText()
        expect(rendered).toContain('Command Palette (Ctrl+P)')
        for (const line of rendered.split('\n').filter((l) => l.length > 0)) {
          expect(stripAnsi(line).length).toBeLessThanOrEqual(66)
        }
      } finally {
        await manager.close()
      }
    })

    it('handles live SIGWINCH in run() raw-mode loop and detaches all listeners on exit', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = createMockTtyInput()
      const out = createMockOutput({ isTTY: true, columns: 112, rows: 30 })
      const signals = new EventEmitter()

      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input,
        output: out.stream,
        rawMode: true,
        asciiOnly: true,
        resizeDebounceMs: 15,
        resizeSignalSource: signals,
        libraryPath: null,
      })

      try {
        const runPromise = ctrl.run()
        await waitFor(() => signals.listenerCount('SIGWINCH') === 1)

        out.clear()
        out.stream.columns = 74
        out.stream.rows = 22
        signals.emit('SIGWINCH')
        out.stream.emit('resize')

        await waitFor(() => ctrl.getState().resizeCount === 1)
        expect(ctrl.getState().viewportWidth).toBe(74)
        expect(ctrl.getState().viewportHeight).toBe(19)
        const plain = stripAnsi(out.getText())
        expect(plain).toContain('Resized to 74x19')

        // Quit cleanly via 'q'
        input.write('q')
        await runPromise

        expect(ctrl.getState().exited).toBe(true)
        expect(signals.listenerCount('SIGWINCH')).toBe(0)
        expect(out.stream.listenerCount('resize')).toBe(0)
      } finally {
        await manager.close()
      }
    })

    it('handles live SIGWINCH in run() line-mode loop on TTY and cleans up on quit', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = new PassThrough() as unknown as TuiInputStream & PassThrough
      input.isTTY = false
      const out = createMockOutput({ isTTY: true, columns: 100, rows: 28 })
      const signals = new EventEmitter()

      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input,
        output: out.stream,
        rawMode: false,
        asciiOnly: true,
        resizeDebounceMs: 10,
        resizeSignalSource: signals,
        libraryPath: null,
      })

      try {
        const runPromise = ctrl.run()
        await waitFor(() => signals.listenerCount('SIGWINCH') === 1)

        out.stream.columns = 82
        out.stream.rows = 24
        signals.emit('SIGWINCH')

        await waitFor(() => ctrl.getState().resizeCount === 1)
        expect(ctrl.getState().viewportWidth).toBe(82)
        expect(ctrl.getState().viewportHeight).toBe(21)

        input.write('quit\n')
        await runPromise

        expect(signals.listenerCount('SIGWINCH')).toBe(0)
        expect(out.stream.listenerCount('resize')).toBe(0)
      } finally {
        await manager.close()
      }
    })
  })
})
