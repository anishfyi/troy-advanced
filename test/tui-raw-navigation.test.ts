import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import {
  TerminalBrowserController,
  runTerminalBrowser,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 100
  stream.rows = opts.rows ?? 24
  stream.on('data', (chunk) => {
    chunks.push(chunk.toString('utf8'))
  })
  return {
    stream,
    getText: () => chunks.join(''),
    clear: () => {
      chunks.length = 0
    },
  }
}

function createMockTtyInput() {
  const stream = new PassThrough() as unknown as TuiInputStream & PassThrough
  const rawModeCalls: boolean[] = []
  stream.isTTY = true
  stream.setRawMode = (mode: boolean) => {
    rawModeCalls.push(mode)
  }
  return { stream, rawModeCalls }
}

describe('M43: TUI Raw-mode keypress navigation (terminal-browser.ts)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `<p>Paragraph line ${i + 1}: Lorem ipsum dolor sit amet for scrolling verification.</p>`,
    ).join('\n')

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/about') {
        res.end(`<!doctype html>
<html>
  <head><title>About Troy</title></head>
  <body>
    <h1>About Troy Advanced</h1>
    <p>Welcome to the About page reached via Enter on a focused ref.</p>
    <a href="/">Back Home</a>
  </body>
</html>`)
        return
      }
      res.end(`<!doctype html>
<html>
  <head><title>TUI Nav Demo</title></head>
  <body>
    <h1>TUI Navigation Home</h1>
    <nav>
      <a href="/about">About Page</a>
      <a href="/docs">Documentation Guide</a>
      <a href="/contact">Contact Support</a>
    </nav>
    <form action="/search">
      <label>Query <input name="q" type="text" placeholder="Search docs" /></label>
      <button type="button">Quick Action</button>
    </form>
    ${paragraphs}
    <footer><p>End of long page marker</p></footer>
  </body>
</html>`)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('supports single-key j/k scrolling, PageDown/PageUp, and g/G top/bottom with exact clamping', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ columns: 90, rows: 20 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp.stream,
        output: out.stream,
        width: 90,
        height: 18,
      })

      await ctrl.init()
      const initState = ctrl.getState()
      expect(initState.scrollOffset).toBe(0)
      expect(initState.maxScrollOffset).toBeGreaterThan(10)

      // j scrolls down by 1
      await ctrl.handleKeypress('j', { name: 'j' })
      expect(ctrl.getState().scrollOffset).toBe(1)

      await ctrl.handleKeypress('j', { name: 'j' })
      expect(ctrl.getState().scrollOffset).toBe(2)

      // k scrolls up by 1 and clamps at 0
      await ctrl.handleKeypress('k', { name: 'k' })
      expect(ctrl.getState().scrollOffset).toBe(1)

      await ctrl.handleKeypress('k', { name: 'k' })
      await ctrl.handleKeypress('k', { name: 'k' })
      expect(ctrl.getState().scrollOffset).toBe(0)

      // G jumps to exact bottom
      await ctrl.handleKeypress('G', { name: 'g', shift: true })
      const bottomState = ctrl.getState()
      expect(bottomState.scrollOffset).toBe(bottomState.maxScrollOffset)
      expect(bottomState.scrollOffset).toBeGreaterThan(10)

      // k right after G immediately scrolls up 1 line from bottom
      await ctrl.handleKeypress('k', { name: 'k' })
      expect(ctrl.getState().scrollOffset).toBe(bottomState.maxScrollOffset - 1)

      // g jumps back to top
      await ctrl.handleKeypress('g', { name: 'g' })
      expect(ctrl.getState().scrollOffset).toBe(0)

      // PageDown / PageUp move by half-page
      await ctrl.handleKeypress('', { name: 'pagedown' })
      const afterPgDn = ctrl.getState().scrollOffset
      expect(afterPgDn).toBeGreaterThanOrEqual(5)

      await ctrl.handleKeypress('', { name: 'pageup' })
      expect(ctrl.getState().scrollOffset).toBe(0)
    } finally {
      await manager.close()
    }
  })

  it('supports Tab / Shift+Tab focus cycling and Enter to activate the focused ref', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ columns: 90, rows: 22 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp.stream,
        output: out.stream,
        width: 90,
        height: 20,
      })

      await ctrl.init()
      const refs = ctrl.getState().availableRefs
      expect(refs.length).toBeGreaterThanOrEqual(4)

      // Enter with no focused ref shows helpful message
      await ctrl.handleKeypress('\r', { name: 'return' })
      expect(ctrl.getState().statusMessage).toContain('No focused ref')

      // Tab focuses first ref (e1: About Page link)
      await ctrl.handleKeypress('\t', { name: 'tab' })
      expect(ctrl.getState().focusedRef).toBe(refs[0])
      expect(ctrl.getState().focusedRefIndex).toBe(0)

      // Tab again focuses second ref
      await ctrl.handleKeypress('\t', { name: 'tab' })
      expect(ctrl.getState().focusedRef).toBe(refs[1])
      expect(ctrl.getState().focusedRefIndex).toBe(1)

      // Shift+Tab moves back to first ref
      await ctrl.handleKeypress('', { name: 'tab', shift: true })
      expect(ctrl.getState().focusedRef).toBe(refs[0])

      // Shift+Tab from index 0 wraps to last ref
      await ctrl.handleKeypress('', { name: 'tab', shift: true })
      expect(ctrl.getState().focusedRef).toBe(refs[refs.length - 1])

      // Tab wraps forward back to index 0 (About Page)
      await ctrl.handleKeypress('\t', { name: 'tab' })
      expect(ctrl.getState().focusedRef).toBe(refs[0])

      // Scroll down slightly, then press Enter to activate e1 (/about)
      await ctrl.handleKeypress('j', { name: 'j' })
      expect(ctrl.getState().scrollOffset).toBe(1)

      await ctrl.handleKeypress('\r', { name: 'return' })
      const afterNav = ctrl.getState()
      expect(afterNav.statusMessage).toContain('Activated')
      expect(afterNav.statusMessage).toContain('/about')
      expect(afterNav.scrollOffset).toBe(0)

      // Verify output rendered the About page
      expect(out.getText()).toContain('ABOUT TROY ADVANCED')
    } finally {
      await manager.close()
    }
  })

  it('supports / search mode with typing, backspace, cancel, submit, and n/N cycling', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ columns: 100, rows: 22 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp.stream,
        output: out.stream,
        width: 100,
        height: 20,
      })

      await ctrl.init()

      // Enter search mode and cancel with Escape
      await ctrl.handleKeypress('/', { sequence: '/' })
      expect(ctrl.getState().mode).toBe('search')
      await ctrl.handleKeypress('a', { name: 'a' })
      expect(ctrl.getState().inputBuffer).toBe('a')
      await ctrl.handleKeypress('', { name: 'escape' })
      expect(ctrl.getState().mode).toBe('normal')
      expect(ctrl.getState().inputBuffer).toBe('')

      // Enter search mode, type "docz", backspace -> "doc", press Enter
      await ctrl.handleKeypress('/', { sequence: '/' })
      for (const ch of 'docz') {
        await ctrl.handleKeypress(ch, { name: ch })
      }
      expect(ctrl.getState().inputBuffer).toBe('docz')
      await ctrl.handleKeypress('', { name: 'backspace' })
      expect(ctrl.getState().inputBuffer).toBe('doc')

      await ctrl.handleKeypress('\r', { name: 'return' })
      const searched = ctrl.getState()
      expect(searched.mode).toBe('normal')
      expect(searched.searchQuery).toBe('doc')
      expect(searched.searchMatches.length).toBeGreaterThanOrEqual(1)
      expect(searched.focusedRef).toBe(searched.searchMatches[0].ref)

      // Search for a broader term matching multiple links ("a" matches About, Contact, Action)
      await ctrl.handleKeypress('/', { sequence: '/' })
      await ctrl.handleKeypress('a', { name: 'a' })
      await ctrl.handleKeypress('\r', { name: 'return' })
      const multi = ctrl.getState()
      expect(multi.searchMatches.length).toBeGreaterThanOrEqual(2)
      const firstRef = multi.focusedRef

      await ctrl.handleKeypress('n', { name: 'n' })
      expect(ctrl.getState().searchMatchIndex).toBe(1)
      expect(ctrl.getState().focusedRef).toBe(multi.searchMatches[1].ref)
      expect(ctrl.getState().focusedRef).not.toBe(firstRef)

      await ctrl.handleKeypress('N', { name: 'n', shift: true })
      expect(ctrl.getState().searchMatchIndex).toBe(0)
      expect(ctrl.getState().focusedRef).toBe(firstRef)
    } finally {
      await manager.close()
    }
  })

  it('supports : command bar mode for executing commands and quitting', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ columns: 100, rows: 22 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp.stream,
        output: out.stream,
        width: 100,
        height: 20,
      })

      await ctrl.init()

      // Enter command mode and run `:nav <baseUrl>/about`
      await ctrl.handleKeypress(':', { sequence: ':' })
      expect(ctrl.getState().mode).toBe('command')
      const cmdStr = `nav ${baseUrl}/about`
      for (const ch of cmdStr) {
        await ctrl.handleKeypress(ch, { name: ch })
      }
      expect(ctrl.getState().inputBuffer).toBe(cmdStr)

      const navRes = await ctrl.handleKeypress('\r', { name: 'return' })
      expect(navRes.shouldExit).toBe(false)
      expect(ctrl.getState().mode).toBe('normal')
      expect(ctrl.getState().statusMessage).toContain('Navigated:')
      expect(out.getText()).toContain('ABOUT TROY ADVANCED')

      // Enter command mode and run `:q`
      await ctrl.handleKeypress(':', { sequence: ':' })
      await ctrl.handleKeypress('q', { name: 'q' })
      const quitRes = await ctrl.handleKeypress('\r', { name: 'return' })
      expect(quitRes.shouldExit).toBe(true)
      expect(ctrl.getState().exited).toBe(true)
    } finally {
      await manager.close()
    }
  })

  it('drives runTerminalBrowser over a real raw-mode stream and restores setRawMode(false) on exit', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ isTTY: true, columns: 90, rows: 20 })
      const inp = createMockTtyInput()

      const runPromise = runTerminalBrowser(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp.stream,
        output: out.stream,
        width: 90,
        height: 18,
      })

      // Allow init() to finish and attach keypress listeners
      await new Promise((r) => setTimeout(r, 80))

      // Send raw keypress bytes: j, G, g, Tab, Enter (navigates to /about), then q to quit
      inp.stream.write('j')
      inp.stream.write('G')
      inp.stream.write('g')
      inp.stream.write('\t')
      inp.stream.write('\r')
      await new Promise((r) => setTimeout(r, 120))
      inp.stream.write('q')

      await runPromise

      // Raw mode must have been enabled and cleanly restored
      expect(inp.rawModeCalls).toEqual([true, false])
      const rendered = out.getText()
      expect(rendered).toContain('TUI NAVIGATION HOME')
      expect(rendered).toContain('ABOUT TROY ADVANCED')
    } finally {
      await manager.close()
    }
  })

  it('falls back cleanly to line-based readline mode when stdin is non-TTY', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ isTTY: false, columns: 90, rows: 20 })
      const inp = new PassThrough() as unknown as TuiInputStream & PassThrough
      inp.isTTY = false

      const runPromise = runTerminalBrowser(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        input: inp,
        output: out.stream,
        width: 90,
        height: 18,
      })

      await new Promise((r) => setTimeout(r, 80))
      inp.write('j 5\n')
      inp.write('top\n')
      inp.write('quit\n')
      inp.end()

      await runPromise

      const rendered = out.getText()
      expect(rendered).toContain('TUI NAVIGATION HOME')
      expect(rendered).toContain('Top of page')
    } finally {
      await manager.close()
    }
  })

  it('exits cleanly on Ctrl+C, clears focus on Escape, and keeps refs stable during navigation', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ isTTY: true, columns: 90, rows: 20 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp.stream,
        output: out.stream,
        width: 90,
        height: 18,
      })

      await ctrl.init()
      const initialRefs = ctrl.getState().availableRefs

      // Scroll, focus, escape — refs must not churn
      await ctrl.handleKeypress('j', { name: 'j' })
      await ctrl.handleKeypress('k', { name: 'k' })
      await ctrl.handleKeypress('\t', { name: 'tab' })
      expect(ctrl.getState().focusedRef).toBe(initialRefs[0])
      expect(ctrl.getState().availableRefs).toEqual(initialRefs)

      await ctrl.handleKeypress('', { name: 'escape' })
      expect(ctrl.getState().focusedRef).toBeNull()
      expect(ctrl.getState().focusedRefIndex).toBe(-1)

      // Ctrl+C exits raw-mode run loop cleanly and restores raw mode
      const inp2 = createMockTtyInput()
      const out2 = createMockOutput({ isTTY: true, columns: 90, rows: 20 })
      const runPromise = runTerminalBrowser(manager, {
        asciiOnly: true,
        rawMode: true,
        input: inp2.stream,
        output: out2.stream,
        width: 90,
        height: 18,
      })
      await new Promise((r) => setTimeout(r, 60))
      inp2.stream.write('\x03')
      await runPromise
      expect(inp2.rawModeCalls).toEqual([true, false])
    } finally {
      await manager.close()
    }
  })
})
