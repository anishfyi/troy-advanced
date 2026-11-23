import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii, stripAnsi } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  createLinkHintState,
  extractHintableRefs,
  formatLinkHintStatus,
  highlightLinkHintsInFrame,
  resolveLinkHintTarget,
  updateLinkHintDigits,
} from '../src/tui/link-hints.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'
import type { ElementDescriptor } from '../src/types.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 110
  stream.rows = opts.rows ?? 30
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

describe('M47: Quick link-hint jump mode (Vimium-style f + digits + Enter)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/empty') {
        res.end(`<!doctype html><html><head><title>Empty</title></head><body><h1>Static Only</h1><p>No links here.</p></body></html>`)
        return
      }
      const pageMatch = req.url?.match(/^\/item\/(\d+)$/)
      if (pageMatch) {
        res.end(`<!doctype html><html><head><title>Item ${pageMatch[1]}</title></head><body><h1>Item ${pageMatch[1]}</h1><p>Reached item ${pageMatch[1]}.</p></body></html>`)
        return
      }
      const links = Array.from({ length: 14 }, (_, i) => {
        const n = i + 1
        return `<p><a href="/item/${n}">Item Link ${n}</a></p>`
      }).join('\n')
      res.end(`<!doctype html>
<html>
  <head><title>Link Hints Directory</title></head>
  <body>
    <h1>Directory</h1>
    ${links}
    <form action="/search" method="get">
      <label>Quick Filter <input name="q" type="text" placeholder="Filter items" /></label>
    </form>
  </body>
</html>`)
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

  describe('link-hints pure helpers', () => {
    it('extracts unique numeric eN refs in order and ignores invalid tokens', () => {
      expect(extractHintableRefs(['e1', 'e2', 'e1', 'bad', 'e12', 'e99', ''])).toEqual([
        'e1',
        'e2',
        'e12',
        'e99',
      ])
    })

    it('filters prefix matches and resolves exact or unique prefix targets', () => {
      const refs = ['e1', 'e2', 'e10', 'e11', 'e12', 'e25']
      const initial = createLinkHintState(refs)
      expect(initial.digits).toBe('')
      expect(initial.matchingRefs).toEqual(refs)
      expect(initial.exactRef).toBeNull()
      expect(resolveLinkHintTarget(initial)).toBeNull()

      // Typing "1" matches e1 (exact) + e10, e11, e12 (prefix)
      const after1 = updateLinkHintDigits(initial, '1')
      expect(after1.matchingRefs).toEqual(['e1', 'e10', 'e11', 'e12'])
      expect(after1.exactRef).toBe('e1')
      expect(resolveLinkHintTarget(after1)).toBe('e1')

      // Typing "12" narrows to exact e12
      const after12 = updateLinkHintDigits(after1, '12')
      expect(after12.matchingRefs).toEqual(['e12'])
      expect(after12.exactRef).toBe('e12')
      expect(resolveLinkHintTarget(after12)).toBe('e12')

      // Typing "2" has exact e2 even though e25 exists
      const after2 = updateLinkHintDigits(initial, '2')
      expect(after2.matchingRefs).toEqual(['e2', 'e25'])
      expect(after2.exactRef).toBe('e2')
      expect(resolveLinkHintTarget(after2)).toBe('e2')

      // Unique prefix match when exact ref doesn't exist (e.g. refs ['e25'], digits '2')
      const solePrefix = createLinkHintState(['e25', 'e30'], '2')
      expect(solePrefix.exactRef).toBeNull()
      expect(solePrefix.matchingRefs).toEqual(['e25'])
      expect(resolveLinkHintTarget(solePrefix)).toBe('e25')

      // Ambiguous prefix without exact match returns null
      const ambiguous = createLinkHintState(['e20', 'e21'], '2')
      expect(ambiguous.exactRef).toBeNull()
      expect(ambiguous.matchingRefs).toEqual(['e20', 'e21'])
      expect(resolveLinkHintTarget(ambiguous)).toBeNull()
    })

    it('highlights matching and exact link hints in strict 7-bit ASCII without shifting borders', () => {
      const frame = [
        '+----------------------------------------------------+',
        '| TROY-ADV [1* Demo]                                 |',
        '| URL: http://example.com                 scroll:0%  |',
        '+----------------------------------------------------+',
        '| [e1: Home]  [e2: Docs]  [e12: Login]               |',
        '| Button [e14]                                       |',
        '+----------------------------------------------------+',
        '| HINT f:1 | -> [e1]                                 |',
        '+----------------------------------------------------+',
      ].join('\n')

      const state = createLinkHintState(['e1', 'e2', 'e12', 'e14'], '1')
      const highlighted = highlightLinkHintsInFrame(frame, state, { asciiOnly: true, color: false })

      expect(isStrictAscii(highlighted)).toBe(true)
      const lines = highlighted.split('\n')
      // Body line 4: e1 is exact [>e1<:, e12 is prefix [*e12:, e2 is plain [e2:
      expect(lines[4]).toContain('[>e1<: Home]')
      expect(lines[4]).toContain('[*e12: Login]')
      expect(lines[4]).toContain('[e2: Docs]')
      // Body line 5: e14 is prefix [*e14]
      expect(lines[5]).toContain('[*e14]')
      // Border width preserved
      expect(lines[4]!.length).toBe(lines[0]!.length)
      expect(lines[5]!.length).toBe(lines[0]!.length)
      // Status line untouched by body highlighter
      expect(lines[7]).toBe('| HINT f:1 | -> [e1]                                 |')
    })

    it('highlights link hints in ANSI color mode with zero visible width change', () => {
      const frame = [
        '+----------------------------------------------------+',
        '| [e1: Home]  [e2: Docs]  [e12: Login]               |',
        '+----------------------------------------------------+',
      ].join('\n')
      const state = createLinkHintState(['e1', 'e2', 'e12'], '1')
      const highlighted = highlightLinkHintsInFrame(frame, state, { asciiOnly: false, color: true })
      const bodyLine = highlighted.split('\n')[1]!

      // Contains ANSI green inverse for exact e1, yellow inverse for prefix e12, dim for non-matching e2
      expect(bodyLine).toContain('\x1b[1m\x1b[7m\x1b[32m[e1\x1b[0m: Home]')
      expect(bodyLine).toContain('\x1b[1m\x1b[7m\x1b[33m[e12\x1b[0m: Login]')
      expect(bodyLine).toContain('\x1b[2m[e2\x1b[0m: Docs]')
      // Visible text identical to original line (zero alignment shift)
      expect(stripAnsi(bodyLine)).toBe('| [e1: Home]  [e2: Docs]  [e12: Login]               |')
    })

    it('formats concise status bar messages for empty, exact, ambiguous, and no-match states', () => {
      const elements: ElementDescriptor[] = [
        { ref: 'e12', tag: 'a', text: 'Item Link 12', clickable: true, editable: false },
      ]
      const empty = formatLinkHintStatus(createLinkHintState(['e1', 'e12']), elements, { asciiOnly: true })
      expect(empty).toContain('HINT f:_')
      expect(empty).toContain('2 refs')

      const exact = formatLinkHintStatus(createLinkHintState(['e1', 'e12'], '12'), elements, { asciiOnly: true })
      expect(exact).toContain('HINT f:12')
      expect(exact).toContain('-> [e12]')
      expect(exact).toContain('Item Link 12')

      const none = formatLinkHintStatus(createLinkHintState(['e1', 'e12'], '99'), elements, { asciiOnly: true })
      expect(none).toContain('no matching ref for e99')
      expect(isStrictAscii(none)).toBe(true)
    })
  })

  describe('TerminalBrowserController integration', () => {
    it('presses f to highlight refs, types multi-digit hint + Enter to click link', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = createMockTtyInput()
      const output = createMockOutput({ isTTY: false, columns: 100, rows: 32 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        asciiOnly: true,
        input,
        output: output.stream,
      })

      await ctrl.init()
      expect(ctrl.getState().mode).toBe('normal')
      expect(ctrl.getState().availableRefs.length).toBeGreaterThanOrEqual(14)

      // Press 'f' to enter link-hint jump mode
      output.clear()
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      const hintState = ctrl.getState()
      expect(hintState.mode).toBe('hint')
      expect(hintState.linkHint).not.toBeNull()
      expect(hintState.linkHint?.digits).toBe('')
      expect(hintState.linkHint?.allRefs.length).toBeGreaterThanOrEqual(14)

      const frameAll = output.getText()
      expect(isStrictAscii(frameAll)).toBe(true)
      expect(frameAll).toContain('[*e1:')
      expect(frameAll).toContain('[*e9:')
      expect(frameAll).toContain('HINT f:_')
      // Verify scrollbar `#` and border `|` rows stay aligned to identical column width
      const framedRows = frameAll.split('\n').filter((l) => l.startsWith('|') || l.startsWith('+'))
      const expectedWidth = framedRows[0]!.length
      for (const row of framedRows) {
        expect(row.length).toBe(expectedWidth)
      }

      // Type '1' -> exact e1 + prefix e10..e14
      output.clear()
      await typeKeys(ctrl, '1')
      const after1 = ctrl.getState()
      expect(after1.mode).toBe('hint')
      expect(after1.linkHint?.digits).toBe('1')
      expect(after1.linkHint?.exactRef).toBe('e1')
      expect(after1.linkHint?.matchingRefs).toContain('e12')
      expect(output.getText()).toContain('[>e1<:')

      // Type '2' -> narrows to e12 and auto-scrolls e12 into view
      output.clear()
      await typeKeys(ctrl, '2')
      const after12 = ctrl.getState()
      expect(after12.linkHint?.digits).toBe('12')
      expect(after12.linkHint?.exactRef).toBe('e12')
      expect(after12.linkHint?.matchingRefs).toEqual(['e12'])
      expect(output.getText()).toContain('[>e12<:')

      // Press Enter -> clicks e12 and navigates to /item/12
      await ctrl.handleKeypress('\r', { name: 'return' })
      const afterJump = ctrl.getState()
      expect(afterJump.mode).toBe('normal')
      expect(afterJump.linkHint).toBeNull()
      expect(afterJump.statusMessage).toContain('Activated e12')
      expect(afterJump.statusMessage).toContain('/item/12')

      await manager.close()
    })

    it('accepts optional leading e (fe3 + Enter) and jumps to input ref opening form modal', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = createMockTtyInput()
      const output = createMockOutput({ isTTY: false, columns: 100, rows: 32 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        asciiOnly: true,
        input,
        output: output.stream,
      })

      await ctrl.init()
      // Find the <input name="q"> ref (should be e15)
      const refs = ctrl.getState().availableRefs
      const inputRef = refs[refs.length - 1]!
      const inputDigits = inputRef.slice(1)

      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      // Reflexive 'e' is ignored gracefully
      await ctrl.handleKeypress('e', { sequence: 'e', name: 'e' })
      expect(ctrl.getState().linkHint?.digits).toBe('')
      await typeKeys(ctrl, inputDigits)
      expect(ctrl.getState().linkHint?.exactRef).toBe(inputRef)

      // Pressing Enter on an <input> ref opens the inline form modal!
      await ctrl.handleKeypress('\r', { name: 'return' })
      const st = ctrl.getState()
      expect(st.mode).toBe('modal')
      expect(st.linkHint).toBeNull()
      expect(st.formModal?.ref).toBe(inputRef)
      expect(st.formModal?.kind).toBe('input')

      await manager.close()
    })

    it('supports Backspace editing, invalid-hint recovery, Escape cancel, and f toggle-off', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = createMockTtyInput()
      const output = createMockOutput({ isTTY: false, columns: 100, rows: 30 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        asciiOnly: true,
        input,
        output: output.stream,
      })

      await ctrl.init()

      // Press f then f again -> toggles off
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      expect(ctrl.getState().mode).toBe('hint')
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      expect(ctrl.getState().mode).toBe('normal')
      expect(ctrl.getState().statusMessage).toContain('cancelled')

      // Press f, type nonexistent '99', press Enter -> stays in hint mode with clear error
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      await typeKeys(ctrl, '99')
      await ctrl.handleKeypress('\r', { name: 'return' })
      expect(ctrl.getState().mode).toBe('hint')
      expect(ctrl.getState().statusMessage).toContain('No ref matching e99')

      // Backspace twice clears digits, third Backspace exits hint mode
      await ctrl.handleKeypress('\x7f', { name: 'backspace' })
      expect(ctrl.getState().linkHint?.digits).toBe('9')
      await ctrl.handleKeypress('\x7f', { name: 'backspace' })
      expect(ctrl.getState().linkHint?.digits).toBe('')
      await ctrl.handleKeypress('\x7f', { name: 'backspace' })
      expect(ctrl.getState().mode).toBe('normal')

      // Press f, type '1', press Escape -> cancels cleanly
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      await typeKeys(ctrl, '1')
      await ctrl.handleKeypress('\x1b', { name: 'escape' })
      expect(ctrl.getState().mode).toBe('normal')
      expect(ctrl.getState().linkHint).toBeNull()

      await manager.close()
    })

    it('stays in normal mode when page has no interactive refs and supports :hint command', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = createMockTtyInput()
      const output = createMockOutput({ isTTY: false, columns: 100, rows: 28 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: `${baseUrl}/empty`,
        rawMode: true,
        asciiOnly: true,
        input,
        output: output.stream,
      })

      await ctrl.init()
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      expect(ctrl.getState().mode).toBe('normal')
      expect(ctrl.getState().statusMessage).toContain('No interactive refs')

      // Navigate to directory and use :hint 5 direct command
      await ctrl.executeCommand(`nav ${baseUrl}`)
      await ctrl.draw({ refresh: true })
      const res = await ctrl.executeCommand('hint 5')
      expect(res.shouldExit).toBe(false)
      expect(res.refresh).toBe(true)
      expect(ctrl.getState().statusMessage).toContain('Activated e5')
      expect(ctrl.getState().statusMessage).toContain('/item/5')

      await manager.close()
    })

    it('renders ANSI link hints cleanly alongside split-pane inspector', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
      const input = createMockTtyInput()
      const output = createMockOutput({ isTTY: true, columns: 120, rows: 30 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        asciiOnly: false,
        color: true,
        splitPane: true,
        inspectorTab: 'refs',
        input,
        output: output.stream,
      })

      await ctrl.init()
      output.clear()
      await ctrl.handleKeypress('f', { sequence: 'f', name: 'f' })
      await typeKeys(ctrl, '3')

      const rendered = output.getText()
      expect(rendered).toContain('\x1b[1m\x1b[7m\x1b[32m[e3\x1b[0m')
      expect(rendered).toContain('HINT f:3')
      expect(ctrl.getState().splitPane).toBe(true)
      expect(ctrl.getState().focusedRef).toBe('e3')

      await manager.close()
    })
  })
})
