import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii, stripAnsi } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  buildPaletteCommands,
  createCommandPaletteState,
  filterPaletteCommands,
  formatCommandPaletteStatus,
  moveCommandPaletteSelection,
  renderCommandPaletteBox,
  scorePaletteMatch,
  updateCommandPaletteQuery,
} from '../src/tui/command-palette.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'
import type { TabSummary } from '../src/types.js'

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

async function typeKeys(ctrl: TerminalBrowserController, text: string): Promise<void> {
  for (const ch of text) {
    await ctrl.handleKeypress(ch, { sequence: ch })
  }
}

describe('M48: Tab bar switching (1-9, t, w) and Command Palette (Ctrl+P)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/alpha') {
        res.end(
          `<!doctype html><html><head><title>Alpha Page</title></head><body><h1>Alpha Heading</h1><p><a href="/beta">Go Beta</a></p></body></html>`,
        )
        return
      }
      if (req.url === '/beta') {
        res.end(
          `<!doctype html><html><head><title>Beta Page</title></head><body><h1>Beta Heading</h1><p><a href="/gamma">Go Gamma</a></p></body></html>`,
        )
        return
      }
      if (req.url === '/gamma') {
        res.end(
          `<!doctype html><html><head><title>Gamma Page</title></head><body><h1>Gamma Heading</h1><p>Gamma body text.</p></body></html>`,
        )
        return
      }
      res.end(
        `<!doctype html><html><head><title>Home Page</title></head><body><h1>Home</h1><p><a href="/alpha">Alpha</a></p></body></html>`,
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

  describe('command-palette pure helpers', () => {
    const sampleTabs: TabSummary[] = [
      { id: 1, url: 'https://alpha.example', title: 'Alpha Docs', active: true, loading: false, engine: 'lite' },
      { id: 2, url: 'https://beta.example', title: 'Beta Console', active: false, loading: false, engine: 'lite' },
    ]

    it('builds context-aware commands including dynamic tab switch entries', () => {
      const cmds = buildPaletteCommands({
        tabs: sampleTabs,
        splitPane: false,
        asciiOnly: true,
        hasFocusedRef: false,
      })

      expect(cmds.some((c) => c.id === 'tab.new')).toBe(true)
      expect(cmds.some((c) => c.id === 'tab.close')).toBe(true)
      expect(cmds.some((c) => c.id === 'tab.switch.1' && c.shortcut === '1' && c.label.includes('Alpha Docs'))).toBe(true)
      expect(cmds.some((c) => c.id === 'tab.switch.2' && c.shortcut === '2' && c.label.includes('Beta Console'))).toBe(true)
      expect(cmds.find((c) => c.id === 'inspector.toggle')?.label).toContain('Open Split-Pane Inspector')
      expect(cmds.find((c) => c.id === 'view.ascii')?.label).toContain('Unicode/ANSI')
    })

    it('scores and filters commands deterministically with prefix, substring, and fuzzy subsequence matching', () => {
      const cmds = buildPaletteCommands({
        tabs: sampleTabs,
        splitPane: false,
        asciiOnly: false,
        hasFocusedRef: true,
      })

      // Exact prefix ranks highest
      const newTabMatches = filterPaletteCommands(cmds, 'new tab')
      expect(newTabMatches[0]?.id).toBe('tab.new')

      // Fuzzy subsequence: "ic" matches "Inspector: Console"
      const fuzzyMatches = filterPaletteCommands(cmds, 'ic')
      expect(fuzzyMatches.some((c) => c.id === 'inspector.console')).toBe(true)

      // Multi-token query across category + label
      const multiToken = filterPaletteCommands(cmds, 'inspector network')
      expect(multiToken[0]?.id).toBe('inspector.network')

      // Tab title search finds dynamic tab entry
      const betaTab = filterPaletteCommands(cmds, 'beta console')
      expect(betaTab[0]?.id).toBe('tab.switch.2')

      // Non-matching query returns empty list
      expect(filterPaletteCommands(cmds, 'zzzz-nonexistent-xyz')).toEqual([])
      expect(scorePaletteMatch(cmds[0]!, 'zzzz-nonexistent-xyz')).toBe(0)
    })

    it('supports selection wrap-around and query updates', () => {
      const state = createCommandPaletteState({
        tabs: sampleTabs,
        splitPane: false,
        asciiOnly: false,
        hasFocusedRef: false,
      })
      const movedUp = moveCommandPaletteSelection(state, -1)
      expect(movedUp.selectedIndex).toBe(state.filtered.length - 1)

      const wrappedDown = moveCommandPaletteSelection(movedUp, 1)
      expect(wrappedDown.selectedIndex).toBe(0)

      const filtered = updateCommandPaletteQuery(wrappedDown, 'reload')
      expect(filtered.filtered[0]?.id).toBe('nav.reload')
      expect(filtered.selectedIndex).toBe(0)
      expect(filtered.cursor).toBe(6)
    })

    it('renders strict 7-bit ASCII palette box and status line without ANSI or non-ASCII characters', () => {
      const state = createCommandPaletteState({
        tabs: sampleTabs,
        splitPane: false,
        asciiOnly: true,
        hasFocusedRef: false,
      })
      const lines = renderCommandPaletteBox(state, {
        maxWidth: 80,
        maxHeight: 24,
        asciiOnly: true,
        color: false,
      })
      const rendered = lines.join('\n')
      expect(isStrictAscii(rendered)).toBe(true)
      expect(rendered).toContain('Command Palette (Ctrl+P)')
      expect(rendered).toContain('New Tab')
      expect(rendered).toContain('Showing 1-')

      const status = formatCommandPaletteStatus(state, { asciiOnly: true })
      expect(isStrictAscii(status)).toBe(true)
      expect(status).toContain('PALETTE')
    })

    it('renders empty state cleanly when query matches no commands', () => {
      const state = createCommandPaletteState(
        { tabs: sampleTabs, splitPane: false, asciiOnly: true, hasFocusedRef: false },
        'no-such-cmd',
      )
      const lines = renderCommandPaletteBox(state, {
        maxWidth: 70,
        maxHeight: 20,
        asciiOnly: true,
        color: false,
      })
      const rendered = lines.join('\n')
      expect(rendered).toContain('No commands match "no-such-cmd"')
      expect(isStrictAscii(rendered)).toBe(true)
    })
  })

  describe('Tab bar switching (1-9, t new tab, w close tab)', () => {
    it('opens new tabs with t, switches tabs with 1-9, and closes tabs with w', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ columns: 100, rows: 28 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/alpha`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: true,
      })

      try {
        await ctrl.init()
        expect(manager.listTabs()).toHaveLength(1)
        const tab1Id = manager.listTabs()[0]!.id

        // Open a second tab via command and a third via `t` key
        await ctrl.executeCommand(`open ${baseUrl}/beta`)
        await ctrl.draw({ refresh: true })
        expect(manager.listTabs()).toHaveLength(2)
        const tab2Id = manager.listTabs()[1]!.id
        expect(manager.listTabs().find((t) => t.active)?.id).toBe(tab2Id)

        // Press `t` to open a new blank tab (slot 3)
        output.clear()
        await ctrl.handleKeypress('t', { name: 't', sequence: 't' })
        expect(manager.listTabs()).toHaveLength(3)
        const tab3Id = manager.listTabs()[2]!.id
        expect(manager.listTabs().find((t) => t.active)?.id).toBe(tab3Id)
        expect(ctrl.getState().statusMessage).toContain('Opened new tab')

        // Press `1` to switch to slot 1 (Alpha Page)
        output.clear()
        await ctrl.handleKeypress('1', { name: '1', sequence: '1' })
        expect(manager.listTabs().find((t) => t.active)?.id).toBe(tab1Id)
        expect(ctrl.getState().statusMessage).toContain('Switched to tab 1/3')
        expect(output.getText()).toContain('ALPHA HEADING')

        // Pressing `1` again while already on slot 1 reports already active
        await ctrl.handleKeypress('1', { name: '1', sequence: '1' })
        expect(ctrl.getState().statusMessage).toContain('Already on tab 1/3')

        // Press `2` to switch to slot 2 (Beta Page)
        output.clear()
        await ctrl.handleKeypress('2', { name: '2', sequence: '2' })
        expect(manager.listTabs().find((t) => t.active)?.id).toBe(tab2Id)
        expect(output.getText()).toContain('BETA HEADING')

        // Press `9` (out of range) -> friendly status message, active tab unchanged
        await ctrl.handleKeypress('9', { name: '9', sequence: '9' })
        expect(ctrl.getState().statusMessage).toContain('No tab at slot 9 (3 open)')
        expect(manager.listTabs().find((t) => t.active)?.id).toBe(tab2Id)

        // Press `w` to close slot 2 (Beta) -> switches to adjacent remaining tab
        await ctrl.handleKeypress('w', { name: 'w', sequence: 'w' })
        expect(manager.listTabs()).toHaveLength(2)
        expect(manager.listTabs().some((t) => t.id === tab2Id)).toBe(false)
        expect(ctrl.getState().statusMessage).toContain(`Closed tab #${tab2Id}`)

        // Close remaining tabs down to the last one, then press `w` on the last tab
        await ctrl.handleKeypress('w', { name: 'w', sequence: 'w' })
        expect(manager.listTabs()).toHaveLength(1)
        const lastId = manager.listTabs()[0]!.id

        await ctrl.handleKeypress('w', { name: 'w', sequence: 'w' })
        // Closing the last tab opens a fresh blank tab so TUI stays alive
        expect(manager.listTabs()).toHaveLength(1)
        expect(manager.listTabs()[0]!.id).not.toBe(lastId)
        expect(ctrl.getState().statusMessage).toContain('Closed last tab')
      } finally {
        await manager.close()
      }
    })

    it('keeps 1-4 switching inspector tabs when split-pane inspector is the active pane', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ columns: 120, rows: 30 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/alpha`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: true,
        splitPane: true,
        inspectorTab: 'console',
      })

      try {
        await ctrl.init()
        await ctrl.handleKeypress('t', { name: 't', sequence: 't' })
        expect(manager.listTabs()).toHaveLength(2)
        const activeBefore = manager.listTabs().find((t) => t.active)!.id

        // Focus inspector pane with Shift+I
        await ctrl.handleKeypress('I', { name: 'i', shift: true, sequence: 'I' })
        expect(ctrl.getState().activePane).toBe('inspector')

        // Pressing `2` should switch inspector tab to 'network', NOT browser tab
        await ctrl.handleKeypress('2', { name: '2', sequence: '2' })
        expect(ctrl.getState().inspectorTab).toBe('network')
        expect(manager.listTabs().find((t) => t.active)!.id).toBe(activeBefore)
      } finally {
        await manager.close()
      }
    })

    it('supports :newtab, :tabs, and :close command-bar commands', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ columns: 100, rows: 28 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/alpha`,
        output: output.stream,
        rawMode: false,
        asciiOnly: true,
      })

      try {
        await ctrl.init()
        const opened = await ctrl.executeCommand(`newtab ${baseUrl}/gamma`)
        expect(opened.refresh).toBe(true)
        expect(manager.listTabs()).toHaveLength(2)

        await ctrl.executeCommand('tabs')
        expect(ctrl.getState().statusMessage).toContain('Tabs (2):')
        expect(ctrl.getState().statusMessage).toContain('Gamma Page')

        const closed = await ctrl.executeCommand('close')
        expect(closed.refresh).toBe(true)
        expect(manager.listTabs()).toHaveLength(1)
      } finally {
        await manager.close()
      }
    })
  })

  describe('Command Palette (Ctrl+P)', () => {
    it('opens on Ctrl+P, filters live, navigates with arrows/Tab, and executes commands', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ columns: 110, rows: 30 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/alpha`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: true,
      })

      try {
        await ctrl.init()

        // Open command palette with Ctrl+P
        output.clear()
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        expect(ctrl.getState().mode).toBe('palette')
        expect(ctrl.getState().palette).not.toBeNull()
        const paletteFrame = output.getText()
        expect(paletteFrame).toContain('Command Palette (Ctrl+P)')
        expect(isStrictAscii(paletteFrame)).toBe(true)

        // Pressing Ctrl+P again toggles it closed
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().palette).toBeNull()

        // Reopen and type "new tab", then press Enter to open a new tab
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        await typeKeys(ctrl, 'new tab')
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('tab.new')

        await ctrl.handleKeypress('\r', { name: 'return', sequence: '\r' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(manager.listTabs()).toHaveLength(2)

        // Reopen palette, filter for "alpha", and switch back to Tab 1
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        await typeKeys(ctrl, 'alpha')
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('tab.switch.1')
        await ctrl.handleKeypress('\r', { name: 'return', sequence: '\r' })
        expect(manager.listTabs().find((t) => t.active)?.id).toBe(1)

        // Reopen palette, navigate with Down / Tab / Up, clear with Ctrl+U, dismiss with Escape
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        await ctrl.handleKeypress('', { name: 'down' })
        expect(ctrl.getState().palette?.selectedIndex).toBe(1)
        await ctrl.handleKeypress('\t', { name: 'tab' })
        expect(ctrl.getState().palette?.selectedIndex).toBe(2)
        await ctrl.handleKeypress('', { name: 'up' })
        expect(ctrl.getState().palette?.selectedIndex).toBe(1)

        await typeKeys(ctrl, 'xyz')
        expect(ctrl.getState().palette?.query).toBe('xyz')
        await ctrl.handleKeypress('\x15', { name: 'u', ctrl: true })
        expect(ctrl.getState().palette?.query).toBe('')

        await ctrl.handleKeypress('\x1b', { name: 'escape' })
        expect(ctrl.getState().mode).toBe('normal')
      } finally {
        await manager.close()
      }
    })

    it('supports prompt, inspector, hint, search, and quit palette actions', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ isTTY: true, columns: 110, rows: 30 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/alpha`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: false,
        color: true,
      })

      try {
        await ctrl.init()

        // Prompt action: "Open URL in New Tab..." -> enters command mode with "open "
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
        await typeKeys(ctrl, 'open url')
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('nav.open')
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('command')
        expect(ctrl.getState().inputBuffer).toBe('open ')
        await ctrl.handleKeypress('\x1b', { name: 'escape' })

        // Inspector action: "Inspector: Console" -> opens split-pane on console tab
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
        await typeKeys(ctrl, 'inspector: console')
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().splitPane).toBe(true)
        expect(ctrl.getState().inspectorTab).toBe('console')

        // Link hints action via :palette command with initial query
        await ctrl.executeCommand('palette quick link hints')
        expect(ctrl.getState().mode).toBe('palette')
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('page.hints')
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('hint')
        await ctrl.handleKeypress('\x1b', { name: 'escape' })

        // Non-matching query keeps palette open on Enter
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
        await typeKeys(ctrl, 'no-match-xyz')
        output.clear()
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('palette')
        expect(stripAnsi(output.getText())).toContain('No commands match "no-match-xyz"')
        await ctrl.handleKeypress('\x1b', { name: 'escape' })

        // Quit action exits cleanly
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
        await typeKeys(ctrl, 'quit terminal')
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('session.quit')
        const res = await ctrl.handleKeypress('\r', { name: 'return' })
        expect(res.shouldExit).toBe(true)
        expect(ctrl.getState().exited).toBe(true)
      } finally {
        await manager.close()
      }
    })
  })
})
