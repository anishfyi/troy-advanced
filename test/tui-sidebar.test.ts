import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii, stripAnsi } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  BookmarkHistoryStore,
  composeSidebarFrame,
  computeSidebarLayout,
  createSidebarState,
  formatSidebarStatus,
  getSidebarItems,
  moveSidebarSelection,
  parseSidebarTab,
  renderSidebarPane,
  toggleSidebarTab,
} from '../src/tui/sidebar.js'
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

describe('M49: Bookmark & History sidebar panel inside TUI (b bookmarks, H history)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/docs') {
        res.end(
          `<!doctype html><html><head><title>Docs Guide</title></head><body><h1>Docs Guide</h1><p><a href="/api">API Reference</a></p></body></html>`,
        )
        return
      }
      if (req.url === '/api') {
        res.end(
          `<!doctype html><html><head><title>API Reference</title></head><body><h1>API Reference</h1><p><a href="/changelog">Changelog</a></p></body></html>`,
        )
        return
      }
      if (req.url === '/changelog') {
        res.end(
          `<!doctype html><html><head><title>Release Changelog</title></head><body><h1>Release Changelog</h1><p>Version 1.0 notes.</p></body></html>`,
        )
        return
      }
      res.end(
        `<!doctype html><html><head><title>Landing Home</title></head><body><h1>Landing Home</h1><p><a href="/docs">Read Docs</a></p></body></html>`,
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

  describe('BookmarkHistoryStore & pure sidebar helpers', () => {
    it('manages bookmarks, history deduplication, visit counts, filtering, and JSON persistence', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-sidebar-'))
      const filePath = path.join(tmpDir, 'tui-library.json')

      try {
        const store = new BookmarkHistoryStore({ filePath, maxHistory: 20 })

        // Ignores about:blank
        expect(store.addBookmark('about:blank', 'Blank').entry).toBeNull()
        expect(store.recordHistory('about:blank', 'Blank')).toBeNull()

        // Add & update bookmarks
        const first = store.addBookmark('https://example.com/docs', 'Example Docs', ['ref'], 1000)
        expect(first.added).toBe(true)
        expect(store.isBookmarked('https://example.com/docs')).toBe(true)

        const updated = store.addBookmark('https://example.com/docs', 'Updated Docs', ['guide'], 2000)
        expect(updated.added).toBe(false)
        expect(updated.entry?.title).toBe('Updated Docs')
        expect(updated.entry?.tags).toEqual(['ref', 'guide'])

        store.addBookmark('https://news.ycombinator.com', 'Hacker News', ['news'], 3000)
        expect(store.listBookmarks()).toHaveLength(2)
        expect(store.listBookmarks('guide')).toHaveLength(1)
        expect(store.listBookmarks('hacker')).toHaveLength(1)

        // Toggle bookmark
        const toggledOff = store.toggleBookmark('https://news.ycombinator.com')
        expect(toggledOff.bookmarked).toBe(false)
        expect(store.listBookmarks()).toHaveLength(1)

        // Record history & visitCount bump + recency ordering
        store.recordHistory('https://a.example', 'Site A', 1000)
        store.recordHistory('https://b.example', 'Site B', 2000)
        const revisit = store.recordHistory('https://a.example', 'Site A Reloaded', 3000)
        expect(revisit?.visitCount).toBe(2)
        const history = store.listHistory()
        expect(history[0]?.url).toBe('https://a.example')
        expect(history[0]?.title).toBe('Site A Reloaded')
        expect(history[1]?.url).toBe('https://b.example')

        // File exists on disk with restricted permissions and reloads cleanly
        expect(fs.existsSync(filePath)).toBe(true)
        const reloaded = new BookmarkHistoryStore({ filePath })
        expect(reloaded.listBookmarks()).toHaveLength(1)
        expect(reloaded.listBookmarks()[0]?.title).toBe('Updated Docs')
        expect(reloaded.listHistory()).toHaveLength(2)
        expect(reloaded.listHistory()[0]?.visitCount).toBe(2)

        // Delete & clear
        expect(reloaded.removeHistory('https://b.example')).toBe(true)
        expect(reloaded.listHistory()).toHaveLength(1)
        reloaded.clearHistory()
        expect(reloaded.listHistory()).toHaveLength(0)
        reloaded.clearBookmarks()
        expect(reloaded.listBookmarks()).toHaveLength(0)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('computes layout widths, renders strict 7-bit ASCII sidebar, and composes side-by-side frame', () => {
      expect(computeSidebarLayout(60).canShow).toBe(false)
      const layout = computeSidebarLayout(100)
      expect(layout.canShow).toBe(true)
      expect(layout.sidebarWidth + layout.gapWidth + layout.pageWidth).toBe(100)

      expect(parseSidebarTab('bm')).toBe('bookmarks')
      expect(parseSidebarTab('hist')).toBe('history')
      expect(toggleSidebarTab('bookmarks')).toBe('history')
      expect(toggleSidebarTab('history')).toBe('bookmarks')

      const state = createSidebarState('history')
      const data = {
        bookmarks: [
          { id: 'bm-1', url: 'https://docs.example/start', title: 'Getting Started', addedAt: 1700000000000 },
        ],
        history: [
          { id: 'h-1', url: 'https://api.example/v1', title: 'API v1', visitedAt: 1700000100000, visitCount: 3 },
          { id: 'h-2', url: 'https://blog.example/post', title: 'Launch Post', visitedAt: 1700000050000, visitCount: 1 },
        ],
        currentUrl: 'https://api.example/v1',
      }

      const items = getSidebarItems(state, data)
      expect(items).toHaveLength(2)
      const moved = moveSidebarSelection(state, items.length, 1)
      expect(moved.selectedIndex).toBe(1)
      const wrapped = moveSidebarSelection(moved, items.length, 1)
      expect(wrapped.selectedIndex).toBe(0)

      const rendered = renderSidebarPane(state, data, {
        width: layout.sidebarWidth,
        height: 18,
        asciiOnly: true,
        color: false,
      })
      const sidebarText = rendered.lines.join('\n')
      expect(isStrictAscii(sidebarText)).toBe(true)
      expect(sidebarText).toContain('History')
      expect(sidebarText).toContain('API v1')
      expect(sidebarText).toContain('x3')

      const pageFrame = Array.from({ length: 18 }, (_, i) => `PAGE LINE ${i}`).join('\n')
      const composed = composeSidebarFrame(rendered.lines, pageFrame, {
        sidebarWidth: layout.sidebarWidth,
        pageWidth: layout.pageWidth,
        gapWidth: layout.gapWidth,
        asciiOnly: true,
        color: false,
      })
      expect(isStrictAscii(composed)).toBe(true)
      expect(composed).toContain('PAGE LINE 0')
      expect(composed).toContain('API v1')

      const status = formatSidebarStatus(state, items, { asciiOnly: true })
      expect(isStrictAscii(status)).toBe(true)
      expect(status).toContain('SIDEBAR HISTORY (1/2)')
    })
  })

  describe('TUI interactive Bookmark & History sidebar integration', () => {
    it('opens bookmarks with b, adds with a, navigates with Enter, opens in new tab with o, and deletes with d', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ columns: 110, rows: 30 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/docs`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: true,
        libraryPath: null,
      })

      try {
        await ctrl.init()
        // History automatically recorded the initial page
        expect(ctrl.getState().historyCount).toBe(1)
        expect(ctrl.getState().bookmarkCount).toBe(0)

        // Press `b` to open Bookmarks sidebar
        output.clear()
        await ctrl.handleKeypress('b', { name: 'b', sequence: 'b' })
        expect(ctrl.getState().mode).toBe('sidebar')
        expect(ctrl.getState().sidebarOpen).toBe(true)
        expect(ctrl.getState().sidebarTab).toBe('bookmarks')
        const bmFrame = output.getText()
        expect(isStrictAscii(bmFrame)).toBe(true)
        expect(bmFrame).toContain('Bookmarks')
        expect(bmFrame).toContain("(no bookmarks - press 'a')")

        // Press `a` inside sidebar to bookmark current page (/docs)
        await ctrl.handleKeypress('a', { name: 'a', sequence: 'a' })
        expect(ctrl.getState().bookmarkCount).toBe(1)
        expect(ctrl.getState().currentPageBookmarked).toBe(true)

        // Close sidebar with `b` again, navigate to /api, and quick-bookmark with Shift+B
        await ctrl.handleKeypress('b', { name: 'b', sequence: 'b' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().sidebarOpen).toBe(false)

        await ctrl.executeCommand(`nav ${baseUrl}/api`)
        await ctrl.draw({ refresh: true })
        expect(ctrl.getState().historyCount).toBe(2)

        await ctrl.handleKeypress('B', { name: 'b', shift: true, sequence: 'B' })
        expect(ctrl.getState().bookmarkCount).toBe(2)
        expect(ctrl.getState().currentPageBookmarked).toBe(true)

        // Reopen bookmarks with `b`, move down with `j` to Docs Guide (index 1), press Enter to navigate
        await ctrl.handleKeypress('b', { name: 'b', sequence: 'b' })
        await ctrl.handleKeypress('j', { name: 'j', sequence: 'j' })
        expect(ctrl.getState().sidebar?.selectedIndex).toBe(1)

        output.clear()
        await ctrl.handleKeypress('\r', { name: 'return', sequence: '\r' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(ctrl.getState().sidebarOpen).toBe(false)
        expect(output.getText()).toContain('DOCS GUIDE')

        // Reopen bookmarks, press `o` on first bookmark (API Reference) to open it in a new tab
        await ctrl.handleKeypress('b', { name: 'b', sequence: 'b' })
        expect(ctrl.getState().sidebar?.selectedIndex).toBe(0)
        await ctrl.handleKeypress('o', { name: 'o', sequence: 'o' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(manager.listTabs()).toHaveLength(2)
        expect(manager.listTabs().find((t) => t.active)?.url).toBe(`${baseUrl}/api`)

        // Reopen bookmarks and delete selected bookmark with `d`
        await ctrl.handleKeypress('b', { name: 'b', sequence: 'b' })
        await ctrl.handleKeypress('d', { name: 'd', sequence: 'd' })
        expect(ctrl.getState().bookmarkCount).toBe(1)

        // Escape closes sidebar
        await ctrl.handleKeypress('\x1b', { name: 'escape' })
        expect(ctrl.getState().mode).toBe('normal')
      } finally {
        await manager.close()
      }
    })

    it('opens History sidebar with H, switches tabs with Tab, and supports live / filtering', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ isTTY: true, columns: 110, rows: 30 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/docs`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: false,
        color: true,
        libraryPath: null,
      })

      try {
        await ctrl.init()
        await ctrl.executeCommand(`nav ${baseUrl}/api`)
        await ctrl.draw({ refresh: true })
        await ctrl.executeCommand(`nav ${baseUrl}/changelog`)
        await ctrl.draw({ refresh: true })
        expect(ctrl.getState().historyCount).toBe(3)

        // Press `H` (Shift+H) to open History sidebar
        output.clear()
        await ctrl.handleKeypress('H', { name: 'h', shift: true, sequence: 'H' })
        expect(ctrl.getState().mode).toBe('sidebar')
        expect(ctrl.getState().sidebarTab).toBe('history')
        const histFrame = stripAnsi(output.getText())
        expect(histFrame).toContain('History')
        expect(histFrame).toContain('Release Changelog')
        expect(histFrame).toContain('API Reference')

        // Tab switches to bookmarks and back to history
        await ctrl.handleKeypress('\t', { name: 'tab' })
        expect(ctrl.getState().sidebarTab).toBe('bookmarks')
        await ctrl.handleKeypress('\t', { name: 'tab' })
        expect(ctrl.getState().sidebarTab).toBe('history')

        // Press `/` to filter history for "docs", Enter to confirm filter, Enter to navigate
        await ctrl.handleKeypress('/', { sequence: '/' })
        expect(ctrl.getState().sidebar?.filtering).toBe(true)
        await typeKeys(ctrl, 'docs')
        expect(ctrl.getState().sidebar?.filterQuery).toBe('docs')
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().sidebar?.filtering).toBe(false)

        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('normal')
        expect(manager.listTabs().find((t) => t.active)?.url).toBe(`${baseUrl}/docs`)
      } finally {
        await manager.close()
      }
    })

    it('supports :bookmarks / :history commands, Ctrl+P palette entries, narrow-terminal refusal, and 3-pane layout', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const output = createMockOutput({ columns: 130, rows: 30 })
      const input = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/docs`,
        input,
        output: output.stream,
        rawMode: true,
        asciiOnly: true,
        splitPane: true,
        inspectorTab: 'refs',
        libraryPath: null,
      })

      try {
        await ctrl.init()

        // Command-bar :bookmark toggles bookmark on current page
        await ctrl.executeCommand('bookmark')
        expect(ctrl.getState().bookmarkCount).toBe(1)

        // Command-bar :bookmarks list & :history list
        await ctrl.executeCommand('bookmarks list')
        expect(ctrl.getState().statusMessage).toContain('Bookmarks (1):')
        await ctrl.executeCommand('history list')
        expect(ctrl.getState().statusMessage).toContain('History (1):')

        // Open bookmarks sidebar via Command Palette (Ctrl+P) while split-pane inspector is ALSO open (3-pane!)
        await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
        await typeKeys(ctrl, 'open bookmarks sidebar')
        expect(ctrl.getState().palette?.filtered[0]?.id).toBe('library.bookmarks')
        output.clear()
        await ctrl.handleKeypress('\r', { name: 'return' })
        expect(ctrl.getState().mode).toBe('sidebar')
        expect(ctrl.getState().sidebarOpen).toBe(true)
        expect(ctrl.getState().splitPane).toBe(true)
        const threePaneFrame = output.getText()
        expect(isStrictAscii(threePaneFrame)).toBe(true)
        expect(threePaneFrame).toContain('Bookmarks')
        expect(threePaneFrame).toContain('DOCS GUIDE')
        expect(threePaneFrame).toContain('INSPECTOR')

        // Close sidebar and clear history via :history clear
        await ctrl.handleKeypress('\x1b', { name: 'escape' })
        await ctrl.executeCommand('history clear')
        expect(ctrl.getState().historyCount).toBe(0)

        // Narrow terminal refuses sidebar cleanly without crashing
        const narrowOut = createMockOutput({ columns: 64, rows: 24 })
        const narrowCtrl = new TerminalBrowserController(manager, {
          output: narrowOut.stream,
          rawMode: true,
          asciiOnly: true,
          libraryPath: null,
        })
        await narrowCtrl.init()
        await narrowCtrl.handleKeypress('b', { name: 'b', sequence: 'b' })
        expect(narrowCtrl.getState().sidebarOpen).toBe(false)
        expect(narrowCtrl.getState().statusMessage).toContain('Terminal too narrow for sidebar')
      } finally {
        await manager.close()
      }
    })
  })
})
