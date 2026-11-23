import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { SimulatedPtySession, VT_KEYS } from '../src/tui/pty-simulator.js'
import { runTerminalBrowser } from '../src/tui/terminal-browser.js'

function isStrictPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

describe('M55: Headless PTY / simulated stream unit tests covering every TUI interaction', () => {
  let server: http.Server
  let baseUrl = ''
  let tempDir = ''

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-pty-e2e-'))
    const longParagraphs = Array.from(
      { length: 40 },
      (_, idx) =>
        `<p>Section ${idx + 1}: Terminal native browser verification paragraph for scrolling and search.${
          idx === 18 ? ' UNIQUE_NEEDLE_ALPHA' : idx === 34 ? ' UNIQUE_NEEDLE_BETA' : ''
        }</p>`,
    ).join('\n')

    server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })

      if (url === '/about') {
        res.end(`<!doctype html>
<html>
  <head><title>About Troy PTY</title></head>
  <body>
    <h1>About Troy Advanced</h1>
    <p>You reached the About page via PTY interaction.</p>
    <a href="/">Return Home</a>
    <a href="/docs">Read Docs</a>
  </body>
</html>`)
        return
      }

      if (url === '/docs') {
        res.end(`<!doctype html>
<html>
  <head><title>Troy Docs</title></head>
  <body>
    <h1>Documentation Portal</h1>
    <p>Full terminal browser documentation and keyboard reference.</p>
    <a href="/">Back to Home</a>
  </body>
</html>`)
        return
      }

      res.end(`<!doctype html>
<html>
  <head><title>PTY Home</title></head>
  <body>
    <header>
      <h1>Troy PTY Test Home</h1>
      <nav>
        <a href="/about">About Link</a>
        <a href="/docs">Docs Link</a>
      </nav>
    </header>
    <main>
      <form action="/submit" method="get">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" placeholder="Enter handle" />
        <label for="role">Role</label>
        <select id="role" name="role">
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Save Profile</button>
      </form>
      <canvas width="120" height="60"></canvas>
      ${longParagraphs}
      <footer><p>FOOTER_SENTINEL_END</p></footer>
    </main>
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
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('1. manages PTY raw-mode lifecycle cleanly across q, Ctrl+C, :quit, and stdin EOF', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      // Exit via 'q'
      {
        const pty = new SimulatedPtySession({ columns: 100, rows: 24 })
        const runPromise = runTerminalBrowser(
          manager,
          pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
        )
        await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'init-q' })
        await pty.waitForRawMode(true)
        expect(pty.rawModeHistory).toEqual([true])
        expect(pty.isRawMode).toBe(true)

        pty.sendKey('q')
        await runPromise
        expect(pty.rawModeHistory).toEqual([true, false])
        expect(pty.isRawMode).toBe(false)
      }

      // Exit via Ctrl+C raw byte (\x03)
      {
        const pty = new SimulatedPtySession({ columns: 100, rows: 24 })
        const runPromise = runTerminalBrowser(
          manager,
          pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
        )
        await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'init-ctrlc' })
        pty.sendKey('CTRL_C')
        await runPromise
        expect(pty.rawModeHistory).toEqual([true, false])
      }

      // Exit via stdin EOF
      {
        const pty = new SimulatedPtySession({ columns: 100, rows: 24 })
        const runPromise = runTerminalBrowser(
          manager,
          pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
        )
        await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'init-eof' })
        pty.endInput()
        await runPromise
        expect(pty.rawModeHistory).toEqual([true, false])
      }
    } finally {
      await manager.close()
    }
  })

  it('2. drives scrolling & navigation via raw VT100 keys (j/k, arrows, PageDown/Up, G/g, r)', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 22 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      const f0 = await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'home' })
      expect(isStrictPrintableAscii(f0.plain)).toBe(true)

      // j scrolls down to line 1
      let idx = pty.getFrameCount()
      pty.sendKey('j')
      const fDown1 = await pty.waitForFrame((f) => f.plain.includes('Scrolled down to line 1/'), {
        fromIndex: idx,
        label: 'j',
      })
      expect(fDown1.plain).toContain('Scrolled down to line 1/')

      // VT100 ArrowDown (\x1b[B) scrolls down to line 2
      idx = pty.getFrameCount()
      pty.sendKey('DOWN')
      await pty.waitForFrame((f) => f.plain.includes('Scrolled down to line 2/'), {
        fromIndex: idx,
        label: 'arrow-down',
      })

      // VT100 ArrowUp (\x1b[A) scrolls up to line 1
      idx = pty.getFrameCount()
      pty.sendKey('UP')
      await pty.waitForFrame((f) => f.plain.includes('Scrolled up to line 1/'), {
        fromIndex: idx,
        label: 'arrow-up',
      })

      // PageDown (\x1b[6~) jumps down a page
      idx = pty.getFrameCount()
      pty.sendKey('PAGE_DOWN')
      const fPgDn = await pty.waitForFrame((f) => /Page down to line \d+\//.test(f.plain), {
        fromIndex: idx,
        label: 'page-down',
      })
      expect(fPgDn.plain).toMatch(/Page down to line [1-9]\d*\//)

      // PageUp (\x1b[5~) jumps back up to line 1
      idx = pty.getFrameCount()
      pty.sendKey('PAGE_UP')
      await pty.waitForFrame((f) => f.plain.includes('Page up to line 1/'), {
        fromIndex: idx,
        label: 'page-up',
      })

      // G jumps to bottom (shows footer sentinel)
      idx = pty.getFrameCount()
      pty.sendKey('G')
      const fBottom = await pty.waitForFrame((f) => f.plain.includes('FOOTER_SENTINEL_END'), {
        fromIndex: idx,
        label: 'bottom-G',
      })
      expect(fBottom.plain).toContain('FOOTER_SENTINEL_END')

      // g jumps back to top
      idx = pty.getFrameCount()
      pty.sendKey('g')
      const fTop = await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), {
        fromIndex: idx,
        label: 'top-g',
      })
      expect(fTop.plain).toContain('TROY PTY TEST HOME')

      // :reload refreshes the page via command bar
      idx = pty.getFrameCount()
      pty.sendKey(':')
      pty.typeText('reload')
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Reloaded') || f.plain.includes('TROY PTY TEST HOME'), {
        fromIndex: idx + 6,
        label: 'reload',
      })

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('3. drives focus cursor (Tab, Shift+Tab) and Enter activation across links', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 26 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      await pty.waitForFrame((f) => f.plain.includes('About Link'), { label: 'home' })

      // Tab focuses e1 (About Link)
      let idx = pty.getFrameCount()
      pty.sendKey('TAB')
      const fTab1 = await pty.waitForFrame((f) => f.plain.includes('[e1]') && f.plain.includes('About Link'), {
        fromIndex: idx,
        label: 'tab-e1',
      })
      expect(fTab1.plain).toContain('About Link')

      // Tab again focuses e2 (Docs Link)
      idx = pty.getFrameCount()
      pty.sendKey('TAB')
      await pty.waitForFrame((f) => f.plain.includes('[e2]') && f.plain.includes('Docs Link'), {
        fromIndex: idx,
        label: 'tab-e2',
      })

      // Shift+Tab (\x1b[Z) moves focus back to e1 (About Link)
      idx = pty.getFrameCount()
      pty.sendKey('SHIFT_TAB')
      await pty.waitForFrame((f) => f.plain.includes('[e1]') && f.plain.includes('About Link'), {
        fromIndex: idx,
        label: 'shift-tab-e1',
      })

      // Enter activates e1 -> navigates to /about
      idx = pty.getFrameCount()
      pty.sendKey('ENTER')
      const fAbout = await pty.waitForFrame(
        (f) => f.plain.includes('ABOUT TROY ADVANCED') && f.plain.includes('PTY interaction'),
        { fromIndex: idx, label: 'enter-about' },
      )
      expect(fAbout.plain).toContain('ABOUT TROY ADVANCED')

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('4. drives inline form-filling modal for <input> and <select> with typing, backspace, arrow selection, and Escape cancel', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 26 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'home' })

      // Tab 3 times: e1 (About), e2 (Docs), e3 (Username input)
      let idx = pty.getFrameCount()
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      await pty.waitForFrame((f) => f.plain.includes('FOCUS [e3]'), { fromIndex: idx, label: 'focus-input' })

      // Press Enter to open text input modal
      idx = pty.getFrameCount()
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Edit') && f.plain.includes('e3'), {
        fromIndex: idx,
        label: 'open-input-modal',
      })

      // Type "alix", Backspace to "ali", type "ce" -> "alice", then Enter to commit
      idx = pty.getFrameCount()
      pty.typeText('alix')
      pty.sendKey('BACKSPACE')
      pty.typeText('ce')
      pty.sendKey('ENTER')
      const fFilled = await pty.waitForFrame((f) => f.plain.includes('Filled e3') && f.plain.includes('alice'), {
        fromIndex: idx,
        label: 'filled-input',
      })
      expect(fFilled.plain).toContain('Filled e3')

      // After fill refresh, refs advance monotonically (e6..e10); tab to (4/5) <select>
      idx = pty.getFrameCount()
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      const fFocusSelect = await pty.waitForFrame((f) => f.plain.includes('(4/5) <select'), {
        fromIndex: idx,
        label: 'focus-select',
      })
      const selectRefMatch = fFocusSelect.plain.match(/FOCUS \[(e\d+)\]/)
      expect(selectRefMatch).not.toBeNull()
      const selectRef = selectRefMatch![1]!

      idx = pty.getFrameCount()
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Viewer') && f.plain.includes('Editor'), {
        fromIndex: idx,
        label: 'open-select-modal',
      })

      // Move down to "Editor" with VT100 ArrowDown and confirm with Enter
      idx = pty.getFrameCount()
      pty.sendKey('DOWN')
      pty.sendKey('ENTER')
      const fSelected = await pty.waitForFrame(
        (f) => f.plain.includes(`FOCUS [${selectRef}]`) && f.plain.includes('val="Editor"'),
        { fromIndex: idx, label: 'selected-option' },
      )
      expect(fSelected.plain).toContain('val="Editor"')

      // Refocus <select> after select-refresh (refs advance monotonically), open modal, and cancel with Escape
      idx = pty.getFrameCount()
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      pty.sendKey('TAB')
      await pty.waitForFrame((f) => f.plain.includes('(4/5) <select'), {
        fromIndex: idx,
        label: 'refocus-select',
      })

      idx = pty.getFrameCount()
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Viewer') && f.plain.includes('Admin'), {
        fromIndex: idx,
        label: 'reopen-select',
      })

      idx = pty.getFrameCount()
      pty.sendKey('ESCAPE')
      await pty.waitForFrame((f) => f.plain.includes('val="Editor"') && !f.plain.includes('Use Up/Down'), {
        fromIndex: idx,
        label: 'cancel-modal',
      })

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('5. drives vimium-style quick link-hint jump mode (f + digits + Enter and Escape cancel)', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 26 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      await pty.waitForFrame((f) => f.plain.includes('Docs Link'), { label: 'home' })

      // Press 'f' to enter hint mode, then cancel with Escape
      let idx = pty.getFrameCount()
      pty.sendKey('f')
      await pty.waitForFrame((f) => f.plain.includes('HINT') || f.plain.includes('hint'), {
        fromIndex: idx,
        label: 'hint-open',
      })

      idx = pty.getFrameCount()
      pty.sendKey('ESCAPE')
      await pty.waitForFrame((f) => f.plain.includes('Link-hint jump cancelled'), {
        fromIndex: idx,
        label: 'hint-cancel',
      })

      // Press 'f', type '2' (e2 = Docs Link), then Enter to navigate to /docs
      idx = pty.getFrameCount()
      pty.sendKey('f')
      await pty.waitForFrame((f) => f.plain.includes('HINT') || f.plain.includes('hint'), {
        fromIndex: idx,
        label: 'hint-reopen',
      })

      idx = pty.getFrameCount()
      pty.typeText('2')
      pty.sendKey('ENTER')
      const fDocs = await pty.waitForFrame((f) => f.plain.includes('DOCUMENTATION PORTAL'), {
        fromIndex: idx,
        label: 'hint-jump-docs',
      })
      expect(fDocs.plain).toContain('DOCUMENTATION PORTAL')

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('6. drives search mode (/, query, Enter, n/N, Escape) and command bar (:open, :scroll, :quit)', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 24 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'home' })

      // Start search with '/', type 'Link' (matches e1 About Link and e2 Docs Link), press Enter
      let idx = pty.getFrameCount()
      pty.sendKey('/')
      pty.typeText('Link')
      pty.sendKey('ENTER')
      const fMatch1 = await pty.waitForFrame(
        (f) => f.plain.includes('FOCUS [e1]') && f.plain.includes('About Link'),
        { fromIndex: idx, label: 'search-first' },
      )
      expect(fMatch1.plain).toContain('About Link')

      // Press 'n' to jump to second match (e2 Docs Link)
      idx = pty.getFrameCount()
      pty.sendKey('n')
      await pty.waitForFrame((f) => f.plain.includes('FOCUS [e2]') && f.plain.includes('Docs Link'), {
        fromIndex: idx,
        label: 'search-next',
      })

      // Press 'N' to jump back to first match (e1 About Link)
      idx = pty.getFrameCount()
      pty.sendKey('N')
      await pty.waitForFrame((f) => f.plain.includes('FOCUS [e1]') && f.plain.includes('About Link'), {
        fromIndex: idx,
        label: 'search-prev',
      })

      // Open command bar ':', verify prompt echo, then cancel with Escape
      idx = pty.getFrameCount()
      pty.sendKey(':')
      pty.typeText('nope')
      await pty.waitForFrame((f) => f.plain.includes(':nope'), {
        fromIndex: idx,
        label: 'cmd-typed',
      })
      idx = pty.getFrameCount()
      pty.sendKey('ESCAPE')
      await pty.waitForFrame((f) => !f.plain.includes(':nope') && f.plain.includes('TROY PTY TEST HOME'), {
        fromIndex: idx,
        label: 'cmd-cancel',
      })

      // Run ':open <baseUrl>/about'
      idx = pty.getFrameCount()
      pty.sendKey(':')
      pty.typeText(`open ${baseUrl}/about`)
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('ABOUT TROY ADVANCED'), {
        fromIndex: idx,
        label: 'cmd-open',
      })

      // Exit via ':quit'
      pty.sendKey(':')
      pty.typeText('quit')
      pty.sendKey('ENTER')
      await runPromise
      expect(pty.rawModeHistory).toEqual([true, false])
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('7. drives tabs (t, 1-9, w) and Command Palette (Ctrl+P, filter, Enter, Escape)', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 26 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'home' })

      // Open a new tab with 't'
      let idx = pty.getFrameCount()
      pty.sendKey('t')
      await pty.waitForFrame((f) => f.plain.includes('[2* New Tab]'), {
        fromIndex: idx,
        label: 'new-tab',
      })

      // Switch back to tab 1 with '1'
      idx = pty.getFrameCount()
      pty.sendKey('1')
      await pty.waitForFrame((f) => f.plain.includes('Switched to tab 1/2'), {
        fromIndex: idx,
        label: 'switch-tab-1',
      })

      // Switch to tab 2 with '2' and close it with 'w'
      idx = pty.getFrameCount()
      pty.sendKey('2')
      await pty.waitForFrame((f) => f.plain.includes('Switched to tab 2/2'), {
        fromIndex: idx,
        label: 'switch-tab-2',
      })

      idx = pty.getFrameCount()
      pty.sendKey('w')
      await pty.waitForFrame((f) => f.plain.includes('Closed tab'), {
        fromIndex: idx,
        label: 'close-tab-2',
      })

      // Open Command Palette with Ctrl+P (\x10), filter for 'help', execute with Enter
      idx = pty.getFrameCount()
      pty.sendKey('CTRL_P')
      await pty.waitForFrame((f) => f.plain.includes('Command Palette'), {
        fromIndex: idx,
        label: 'palette-open',
      })

      idx = pty.getFrameCount()
      pty.typeText('help')
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Help: Keybindings & Commands'), {
        fromIndex: idx,
        label: 'palette-exec-help',
      })

      // Close help overlay with Escape
      idx = pty.getFrameCount()
      pty.sendKey('ESCAPE')
      await pty.waitForFrame((f) => f.plain.includes('Help closed'), {
        fromIndex: idx,
        label: 'close-help',
      })

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('8. drives split-pane inspector (i, ], [, I, 1-4, j/k) and Bookmark/History sidebar (B, b, H, Escape)', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 120, rows: 28 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({ initialUrl: baseUrl, asciiOnly: true }),
      )

      await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'home' })

      // Toggle split-pane inspector open with 'i'
      let idx = pty.getFrameCount()
      pty.sendKey('i')
      await pty.waitForFrame((f) => f.plain.includes('Split-pane inspector open'), {
        fromIndex: idx,
        label: 'inspector-open',
      })

      // Cycle inspector tab forward with ']' -> network
      idx = pty.getFrameCount()
      pty.sendKey(']')
      await pty.waitForFrame((f) => f.plain.includes('Inspector tab: network'), {
        fromIndex: idx,
        label: 'inspector-next',
      })

      // Focus inspector pane with 'I' and jump directly to Refs tab with '3'
      idx = pty.getFrameCount()
      pty.sendKey('I')
      await pty.waitForFrame((f) => f.plain.includes('Active pane: inspector'), {
        fromIndex: idx,
        label: 'inspector-focus',
      })

      idx = pty.getFrameCount()
      pty.sendKey('3')
      await pty.waitForFrame((f) => f.plain.includes('Inspector tab: refs'), {
        fromIndex: idx,
        label: 'inspector-refs',
      })

      // Close split-pane inspector with 'i'
      idx = pty.getFrameCount()
      pty.sendKey('i')
      await pty.waitForFrame((f) => f.plain.includes('Split-pane inspector closed'), {
        fromIndex: idx,
        label: 'inspector-close',
      })

      // Bookmark current page with 'B'
      idx = pty.getFrameCount()
      pty.sendKey('B')
      await pty.waitForFrame((f) => f.plain.includes('Bookmarked'), {
        fromIndex: idx,
        label: 'bookmark-add',
      })

      // Open Bookmarks sidebar with 'b'
      idx = pty.getFrameCount()
      pty.sendKey('b')
      const fSidebar = await pty.waitForFrame(
        (f) => f.plain.includes('BOOKMARKS') && f.plain.includes('PTY Home'),
        { fromIndex: idx, label: 'sidebar-bookmarks' },
      )
      expect(fSidebar.plain).toContain('BOOKMARKS')

      // Switch to History tab inside sidebar with 'H'
      idx = pty.getFrameCount()
      pty.sendKey('H')
      await pty.waitForFrame((f) => f.plain.includes('HISTORY'), {
        fromIndex: idx,
        label: 'sidebar-history',
      })

      // Close sidebar with Escape
      idx = pty.getFrameCount()
      pty.sendKey('ESCAPE')
      await pty.waitForFrame((f) => f.plain.includes('Sidebar closed') || f.plain.includes('Closed sidebar'), {
        fromIndex: idx,
        label: 'sidebar-close',
      })

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('9. drives pixel-preview cycling (v/V), SIGWINCH + stdout resize + Ctrl+L reflow, :save export, and ? help overlay', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    const pty = new SimulatedPtySession({ columns: 100, rows: 26 })
    try {
      const runPromise = runTerminalBrowser(
        manager,
        pty.createTuiOptions({
          initialUrl: baseUrl,
          asciiOnly: true,
          exportDir: tempDir,
        }),
      )

      await pty.waitForFrame((f) => f.plain.includes('TROY PTY TEST HOME'), { label: 'home' })

      // Cycle view mode with 'v': Layout -> Pixel ASCII -> Braille -> Halfblock -> Layout
      let idx = pty.getFrameCount()
      pty.sendKey('v')
      await pty.waitForFrame((f) => f.plain.includes('Pixel ASCII'), {
        fromIndex: idx,
        label: 'view-pixel-ascii',
      })

      idx = pty.getFrameCount()
      pty.sendKey('v')
      await pty.waitForFrame((f) => f.plain.includes('Braille'), {
        fromIndex: idx,
        label: 'view-braille',
      })

      idx = pty.getFrameCount()
      pty.sendKey('V')
      await pty.waitForFrame((f) => f.plain.includes('Pixel ASCII'), {
        fromIndex: idx,
        label: 'view-reverse',
      })

      idx = pty.getFrameCount()
      pty.sendKey('V')
      await pty.waitForFrame((f) => f.plain.includes('Layout ASCII'), {
        fromIndex: idx,
        label: 'view-layout',
      })

      // Resize via SIGWINCH from 100x26 -> 84x22
      idx = pty.getFrameCount()
      pty.resize(84, 22, 'sigwinch')
      const fSigwinch = await pty.waitForFrame((f) => f.plain.includes('Resized to 84x'), {
        fromIndex: idx,
        label: 'resize-sigwinch',
      })
      expect(fSigwinch.plain.split('\n')[0]!.length).toBe(84)

      // Resize via stdout 'resize' event from 84x22 -> 110x28
      idx = pty.getFrameCount()
      pty.resize(110, 28, 'stdout')
      const fStdoutResize = await pty.waitForFrame((f) => f.plain.includes('Resized to 110x'), {
        fromIndex: idx,
        label: 'resize-stdout',
      })
      expect(fStdoutResize.plain.split('\n')[0]!.length).toBe(110)

      // Manual redraw via Ctrl+L (\x0c)
      idx = pty.getFrameCount()
      pty.sendKey('CTRL_L')
      await pty.waitForNextFrame(idx - 1)

      // Export page to .md and .json via ':save'
      idx = pty.getFrameCount()
      pty.sendKey(':')
      pty.typeText('save pty-export.md')
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Saved MD') && f.plain.includes('pty-export.md'), {
        fromIndex: idx,
        label: 'save-md',
      })
      const mdPath = path.join(tempDir, 'pty-export.md')
      expect(fs.existsSync(mdPath)).toBe(true)
      expect(fs.readFileSync(mdPath, 'utf8')).toContain('Troy PTY Test Home')

      idx = pty.getFrameCount()
      pty.sendKey(':')
      pty.typeText('save pty-export.json')
      pty.sendKey('ENTER')
      await pty.waitForFrame((f) => f.plain.includes('Saved JSON') && f.plain.includes('pty-export.json'), {
        fromIndex: idx,
        label: 'save-json',
      })
      const jsonPath = path.join(tempDir, 'pty-export.json')
      const exportedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      expect(exportedJson.url).toContain('127.0.0.1')

      // Open help overlay '?' and scroll with 'j' then close with '?'
      idx = pty.getFrameCount()
      pty.sendKey('?')
      const fHelp = await pty.waitForFrame((f) => f.plain.includes('TUI Help') || f.plain.includes('Navigation'), {
        fromIndex: idx,
        label: 'help-open',
      })
      expect(isStrictPrintableAscii(fHelp.plain)).toBe(true)

      idx = pty.getFrameCount()
      pty.sendKey('j')
      await pty.waitForNextFrame(idx - 1)

      idx = pty.getFrameCount()
      pty.sendKey('?')
      await pty.waitForFrame((f) => f.plain.includes('Help closed'), {
        fromIndex: idx,
        label: 'help-close',
      })

      pty.sendKey('q')
      await runPromise
    } finally {
      pty.dispose()
      await manager.close()
    }
  })

  it('10. handles non-TTY / piped batch mode, one-shot snapshot mode, TERM=dumb, and EPIPE broken pipe safely', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      // A) Non-TTY piped batch commands (stdin/stdout both non-TTY)
      {
        const pty = new SimulatedPtySession({
          isInputTTY: false,
          isOutputTTY: false,
          columns: 90,
          rows: 24,
        })
        const runPromise = runTerminalBrowser(
          manager,
          pty.createTuiOptions({
            initialUrl: baseUrl,
            asciiOnly: true,
            nonTtyMode: 'batch',
            exportDir: tempDir,
          }),
        )

        pty.sendLine(`open ${baseUrl}/about`)
        pty.sendLine('save piped-about.txt')
        pty.sendLine('quit')
        await runPromise

        const rawOut = pty.getAllStdout()
        // Never emits raw clear-screen escape sequences in non-TTY mode
        expect(rawOut).not.toContain('\x1b[2J')
        expect(rawOut).toContain('ABOUT TROY ADVANCED')
        expect(pty.rawModeHistory).toEqual([])
        expect(fs.existsSync(path.join(tempDir, 'piped-about.txt'))).toBe(true)
        expect(pty.getStderr()).toContain('non-TTY')
      }

      // B) One-shot snapshot mode exits immediately after rendering a single frame
      {
        const pty = new SimulatedPtySession({
          isInputTTY: false,
          isOutputTTY: false,
          columns: 90,
          rows: 24,
        })
        await runTerminalBrowser(
          manager,
          pty.createTuiOptions({
            initialUrl: baseUrl,
            asciiOnly: true,
            nonTtyMode: 'snapshot',
          }),
        )
        const out = pty.getAllStdout()
        expect(out).not.toContain('\x1b[2J')
        expect(out).toContain('TROY PTY TEST HOME')
        expect(isStrictPrintableAscii(out)).toBe(true)
      }

      // C) TERM=dumb falls back cleanly without raw mode
      {
        const pty = new SimulatedPtySession({
          isInputTTY: true,
          isOutputTTY: true,
          env: { TERM: 'dumb' },
        })
        const runPromise = runTerminalBrowser(
          manager,
          pty.createTuiOptions({
            initialUrl: baseUrl,
            asciiOnly: true,
          }),
        )
        pty.sendLine('quit')
        await runPromise
        expect(pty.rawModeHistory).toEqual([])
        expect(pty.getAllStdout()).not.toContain('\x1b[2J')
      }

      // D) EPIPE error on stdout exits cleanly without throwing
      {
        const pty = new SimulatedPtySession({
          isInputTTY: false,
          isOutputTTY: false,
        })
        const runPromise = runTerminalBrowser(
          manager,
          pty.createTuiOptions({
            initialUrl: baseUrl,
            asciiOnly: true,
            nonTtyMode: 'batch',
          }),
        )
        await pty.waitForStdout((plain) => plain.includes('TROY PTY TEST HOME'), 3000, 'epipe-init')
        const epipeErr = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        pty.emitOutputError(epipeErr)
        pty.sendLine('help')
        pty.endInput()
        await expect(runPromise).resolves.toBeUndefined()
      }
    } finally {
      await manager.close()
    }
  })
})
