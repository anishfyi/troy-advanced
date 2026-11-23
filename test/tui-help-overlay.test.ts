import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stripAnsi } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import { buildPaletteCommands } from '../src/tui/command-palette.js'
import {
  buildHelpBodyLines,
  cloneHelpOverlayState,
  countHelpBindings,
  createHelpOverlayState,
  formatHelpOverlayStatus,
  getHelpSections,
  renderHelpOverlayBox,
  scrollHelpOverlay,
} from '../src/tui/help-overlay.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const stream = new PassThrough() as PassThrough & TuiOutputStream
  stream.isTTY = opts.isTTY ?? true
  stream.columns = opts.columns ?? 100
  stream.rows = opts.rows ?? 26
  const chunks: string[] = []
  stream.on('data', (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  })
  return {
    stream,
    chunks,
    getLastChunk: () => chunks[chunks.length - 1] ?? '',
    getAllOutput: () => chunks.join(''),
    clear: () => {
      chunks.length = 0
    },
  }
}

function createMockInput(opts: { isTTY?: boolean } = {}) {
  const stream = new PassThrough() as PassThrough & TuiInputStream
  stream.isTTY = opts.isTTY ?? true
  stream.setRawMode = () => {}
  return stream
}

function isStrictPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

describe('TUI Help Overlay (?) (M54)', () => {
  let server: http.Server
  let baseUrl = ''
  let tempRoot = ''

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-tui-help-'))
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head><title>Troy Help Overlay Demo</title></head>
  <body>
    <header>
      <h1>Troy Terminal Browser</h1>
      <nav>
        <a href="/docs">Documentation</a>
        <a href="/about">About</a>
      </nav>
    </header>
    <main>
      <p>Press ? at any time to view all keyboard shortcuts and colon commands.</p>
      <form action="/search">
        <label for="q">Search</label>
        <input id="q" name="q" type="text" placeholder="Search docs" />
        <button type="submit">Go</button>
      </form>
    </main>
  </body>
</html>`)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  describe('Pure helpers in src/tui/help-overlay.ts', () => {
    it('catalogs all TUI keybinding sections and major shortcuts', () => {
      const sections = getHelpSections()
      expect(sections.length).toBeGreaterThanOrEqual(6)
      expect(countHelpBindings(sections)).toBeGreaterThanOrEqual(25)

      const allKeys = sections.flatMap((s) => s.bindings.map((b) => b.keys)).join(' | ')
      expect(allKeys).toContain('j / Down')
      expect(allKeys).toContain('k / Up')
      expect(allKeys).toContain('Tab / Shift+Tab')
      expect(allKeys).toContain('Enter')
      expect(allKeys).toContain('f')
      expect(allKeys).toContain('/')
      expect(allKeys).toContain(':')
      expect(allKeys).toContain('Ctrl+P')
      expect(allKeys).toContain('1 - 9')
      expect(allKeys).toContain('b')
      expect(allKeys).toContain('H')
      expect(allKeys).toContain('v / V')
      expect(allKeys).toContain('i')
      expect(allKeys).toContain(':save <file>')
      expect(allKeys).toContain('?')
      expect(allKeys).toContain('q / Ctrl+C')

      // Returns fresh clones so caller mutations cannot corrupt the catalog
      sections[0]!.title = 'MUTATED'
      expect(getHelpSections()[0]!.title).not.toBe('MUTATED')
    })

    it('creates, clones, and clamps scroll offsets cleanly', () => {
      const initial = createHelpOverlayState()
      expect(initial.scrollOffset).toBe(0)
      expect(initial.sectionCount).toBeGreaterThanOrEqual(6)
      expect(initial.bindingCount).toBeGreaterThanOrEqual(25)
      expect(cloneHelpOverlayState(null)).toBeNull()
      expect(cloneHelpOverlayState(initial)).toEqual(initial)

      const withBounds = { ...initial, maxScrollOffset: 12, totalLines: 30, viewportRows: 18 }
      expect(scrollHelpOverlay(withBounds, 5).scrollOffset).toBe(5)
      expect(scrollHelpOverlay(withBounds, 99).scrollOffset).toBe(12)
      expect(scrollHelpOverlay(withBounds, -5).scrollOffset).toBe(0)
    })

    it('renders a strict 7-bit ASCII modal box with scrollbar when content exceeds viewport', () => {
      const state = createHelpOverlayState()
      const rendered = renderHelpOverlayBox(state, {
        maxWidth: 80,
        maxHeight: 16,
        asciiOnly: true,
        color: false,
      })

      expect(rendered.lines.length).toBeGreaterThanOrEqual(7)
      expect(rendered.lines.length).toBeLessThanOrEqual(16)
      expect(rendered.totalLines).toBeGreaterThan(rendered.viewportRows)
      expect(rendered.maxScrollOffset).toBe(rendered.totalLines - rendered.viewportRows)

      const joined = rendered.lines.join('\n')
      expect(isStrictPrintableAscii(joined)).toBe(true)
      expect(joined).toContain('Help: Keybindings & Commands')
      expect(joined).toContain('[Navigation & Scrolling]')
      expect(joined).toContain('j / Down')
      expect(joined).toContain('?/Esc/q close')

      // Top and bottom borders use ASCII + and -
      expect(rendered.lines[0]!.startsWith('+-')).toBe(true)
      expect(rendered.lines[0]!.endsWith('-+')).toBe(true)
      expect(rendered.lines[rendered.lines.length - 1]!.startsWith('+-')).toBe(true)

      // Uniform box width across every row
      const widths = new Set(rendered.lines.map((l) => l.length))
      expect(widths.size).toBe(1)

      // Scrollbar gutter (# thumb on | track) appears inside body rows
      const bodyRows = rendered.lines.slice(1, 1 + rendered.viewportRows)
      expect(bodyRows.some((r) => r.endsWith('# |'))).toBe(true)
      expect(bodyRows.some((r) => r.endsWith('| |'))).toBe(true)
    })

    it('renders ANSI-colored Unicode box borders when asciiOnly is false and color is true', () => {
      const state = createHelpOverlayState()
      const rendered = renderHelpOverlayBox(state, {
        maxWidth: 90,
        maxHeight: 24,
        asciiOnly: false,
        color: true,
      })

      const joined = rendered.lines.join('\n')
      expect(joined).toContain('\x1b[')
      const plain = stripAnsi(joined)
      expect(plain).toContain('┌')
      expect(plain).toContain('└')
      expect(plain).toContain('Help: Keybindings & Commands')
      const plainWidths = new Set(rendered.lines.map((l) => stripAnsi(l).length))
      expect(plainWidths.size).toBe(1)
    })

    it('gracefully fits narrow and short viewports without overflowing or throwing', () => {
      const state = createHelpOverlayState()
      const rendered = renderHelpOverlayBox(state, {
        maxWidth: 38,
        maxHeight: 9,
        asciiOnly: true,
        color: false,
      })

      expect(rendered.viewportRows).toBeGreaterThanOrEqual(3)
      for (const line of rendered.lines) {
        expect(line.length).toBeLessThanOrEqual(38)
      }
      expect(isStrictPrintableAscii(rendered.lines.join('\n'))).toBe(true)
    })

    it('formats body lines and status bar cleanly', () => {
      const body = buildHelpBodyLines(getHelpSections(), 64, { asciiOnly: true, color: false })
      expect(body.length).toBeGreaterThan(25)
      expect(isStrictPrintableAscii(body.join('\n'))).toBe(true)

      const status = formatHelpOverlayStatus(
        {
          scrollOffset: 4,
          maxScrollOffset: 18,
          totalLines: 32,
          viewportRows: 14,
          sectionCount: 6,
          bindingCount: 30,
        },
        { asciiOnly: true },
      )
      expect(status).toContain('HELP (5-18/32)')
      expect(status).toContain('?/Esc/q close')
    })

    it('registers Keyboard Shortcuts & Help in command palette commands', () => {
      const cmds = buildPaletteCommands({
        tabs: [],
        splitPane: false,
        asciiOnly: true,
        hasFocusedRef: false,
      })
      const helpCmd = cmds.find((c) => c.id === 'session.help')
      expect(helpCmd).toBeDefined()
      expect(helpCmd?.shortcut).toBe('?')
      expect(helpCmd?.action).toEqual({ type: 'open-help' })
    })
  })

  describe('TerminalBrowserController integration', () => {
    async function createController(opts: {
      columns?: number
      rows?: number
      asciiOnly?: boolean
      color?: boolean
      rawMode?: boolean
    } = {}) {
      const profileDir = fs.mkdtempSync(path.join(tempRoot, 'prof-'))
      const manager = await BrowserManager.create({ engine: 'lite', profileDir })
      const output = createMockOutput({
        isTTY: opts.rawMode ?? true,
        columns: opts.columns ?? 100,
        rows: opts.rows ?? 22,
      })
      const input = createMockInput({ isTTY: opts.rawMode ?? true })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        input,
        output: output.stream,
        asciiOnly: opts.asciiOnly ?? true,
        color: opts.color ?? false,
        rawMode: opts.rawMode ?? true,
        libraryPath: null,
      })
      await ctrl.init()
      return { manager, ctrl, output }
    }

    it('opens help overlay on ? key, scrolls through all bindings, and closes on Esc / ? / q / Enter', async () => {
      const { manager, ctrl, output } = await createController({ rows: 18, columns: 96, asciiOnly: true, color: false })
      try {
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().helpOverlay).toBeNull()

        // Press ? to open help overlay
        output.clear()
        const openRes = await ctrl.handleKeypress('?', { sequence: '?' })
        expect(openRes.shouldExit).toBe(false)
        expect(openRes.drawn).toBe(true)

        const openState = ctrl.getState()
        expect(openState.mode).toBe('help')
        expect(openState.helpOverlay).not.toBeNull()
        expect(openState.helpOverlay!.scrollOffset).toBe(0)
        expect(openState.helpOverlay!.maxScrollOffset).toBeGreaterThan(0)
        expect(openState.helpOverlay!.totalLines).toBeGreaterThan(openState.helpOverlay!.viewportRows)

        const frame1 = stripAnsi(output.getLastChunk())
        expect(frame1).toContain('Help: Keybindings & Commands')
        expect(frame1).toContain('[Navigation & Scrolling]')
        expect(frame1).toContain('HELP (1-')
        expect(isStrictPrintableAscii(frame1)).toBe(true)

        // Scroll down with j and down arrow
        await ctrl.handleKeypress('j', { name: 'j', sequence: 'j' })
        expect(ctrl.getState().helpOverlay?.scrollOffset).toBe(1)
        await ctrl.handleKeypress(undefined, { name: 'down' })
        expect(ctrl.getState().helpOverlay?.scrollOffset).toBe(2)

        // Scroll up with k
        await ctrl.handleKeypress('k', { name: 'k', sequence: 'k' })
        expect(ctrl.getState().helpOverlay?.scrollOffset).toBe(1)

        // Half-page down with Ctrl+D and jump to bottom with G
        await ctrl.handleKeypress('\x04', { name: 'd', ctrl: true })
        expect(ctrl.getState().helpOverlay!.scrollOffset).toBeGreaterThan(1)

        output.clear()
        await ctrl.handleKeypress('G', { name: 'g', shift: true, sequence: 'G' })
        const bottomState = ctrl.getState().helpOverlay!
        expect(bottomState.scrollOffset).toBe(bottomState.maxScrollOffset)
        const bottomFrame = stripAnsi(output.getLastChunk())
        expect(bottomFrame).toContain('[Colon Commands & Session]')
        expect(bottomFrame).toContain('q / Ctrl+C')

        // Jump back to top with g
        await ctrl.handleKeypress('g', { name: 'g', sequence: 'g' })
        expect(ctrl.getState().helpOverlay?.scrollOffset).toBe(0)

        // Pressing q inside help overlay closes help WITHOUT exiting the browser
        const closeByQ = await ctrl.handleKeypress('q', { name: 'q', sequence: 'q' })
        expect(closeByQ.shouldExit).toBe(false)
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().helpOverlay).toBeNull()
        expect(ctrl.getState().exited).toBe(false)

        // Re-open with ? and close with ?
        await ctrl.handleKeypress('?', { sequence: '?' })
        expect(ctrl.getState().mode).toBe('help')
        await ctrl.handleKeypress('?', { sequence: '?' })
        expect(ctrl.getState().mode).toBe('normal')

        // Re-open with ? and close with Escape
        await ctrl.handleKeypress('?', { sequence: '?' })
        expect(ctrl.getState().mode).toBe('help')
        await ctrl.handleKeypress('\x1b', { name: 'escape' })
        expect(ctrl.getState().mode).toBe('normal')

        // Re-open with ? and close with Enter
        await ctrl.handleKeypress('?', { sequence: '?' })
        expect(ctrl.getState().mode).toBe('help')
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('normal')
      } finally {
        await manager.close()
      }
    })

    it('still exits cleanly on Ctrl+C while help overlay is open', async () => {
      const { manager, ctrl } = await createController()
      try {
        await ctrl.handleKeypress('?', { sequence: '?' })
        expect(ctrl.getState().mode).toBe('help')
        const res = await ctrl.handleKeypress('\x03', { name: 'c', ctrl: true })
        expect(res.shouldExit).toBe(true)
        expect(ctrl.getState().exited).toBe(true)
      } finally {
        await manager.close()
      }
    })

    it('opens help overlay via :help command in raw mode and via Ctrl+P Command Palette', async () => {
      const { manager, ctrl } = await createController()
      try {
        // Via :help command
        const cmdRes = await ctrl.executeCommand('help')
        expect(cmdRes.shouldExit).toBe(false)
        expect(ctrl.getState().mode).toBe('help')
        await ctrl.handleKeypress('\x1b', { name: 'escape' })
        expect(ctrl.getState().mode).toBe('normal')

        // Via Ctrl+P Command Palette -> type "shortcuts" -> Enter
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
        expect(ctrl.getState().mode).toBe('palette')
        for (const ch of 'shortcuts') {
          await ctrl.handleKeypress(ch, { name: ch, sequence: ch })
        }
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('session.help')
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('help')
        expect(ctrl.getState().helpOverlay).not.toBeNull()
      } finally {
        await manager.close()
      }
    })

    it('keeps text summary behavior for help command in non-raw line mode', async () => {
      const { manager, ctrl } = await createController({ rawMode: false })
      try {
        expect(ctrl.isRawModeEnabled()).toBe(false)
        await ctrl.executeCommand('help')
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().helpOverlay).toBeNull()
        expect(ctrl.getState().statusMessage).toContain('Keys:')
        expect(ctrl.getState().statusMessage).toContain('?')
      } finally {
        await manager.close()
      }
    })

    it('reflows and clamps scrollOffset when terminal resizes while help overlay is open', async () => {
      const { manager, ctrl, output } = await createController({ rows: 14, columns: 84 })
      try {
        await ctrl.handleKeypress('?', { sequence: '?' })
        await ctrl.handleKeypress('G', { name: 'g', shift: true, sequence: 'G' })
        const beforeMax = ctrl.getState().helpOverlay!.maxScrollOffset
        expect(beforeMax).toBeGreaterThan(0)
        expect(ctrl.getState().helpOverlay!.scrollOffset).toBe(beforeMax)

        // Expand terminal height so maxScrollOffset shrinks
        output.stream.columns = 110
        output.stream.rows = 34
        await ctrl.handleResize({ source: 'sigwinch', force: true })

        const after = ctrl.getState().helpOverlay!
        expect(ctrl.getState().mode).toBe('help')
        expect(after.maxScrollOffset).toBeLessThan(beforeMax)
        expect(after.scrollOffset).toBeLessThanOrEqual(after.maxScrollOffset)
      } finally {
        await manager.close()
      }
    })
  })
})
