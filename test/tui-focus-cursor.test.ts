import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  formatRefTooltip,
  highlightFocusedRefInLines,
  isStrictAscii,
  renderPageAsciiWithMetrics,
  stripAnsi,
} from '../src/ascii/layout.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'
import type { ElementDescriptor, PageSnapshot } from '../src/types.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 110
  stream.rows = opts.rows ?? 24
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

function makeSampleSnapshot(): PageSnapshot {
  const elements: ElementDescriptor[] = [
    {
      ref: 'e1',
      selector: 'a#about',
      tag: 'a',
      type: '',
      text: 'About Troy',
      href: 'https://example.com/about',
    },
    {
      ref: 'e2',
      selector: 'input[name="q"]',
      tag: 'input',
      type: 'text',
      name: 'q',
      text: '',
      placeholder: 'Search docs',
      value: 'ascii',
    },
    {
      ref: 'e10',
      selector: 'button#go',
      tag: 'button',
      type: 'button',
      text: 'Run Query',
    },
  ]
  return {
    tabId: 1,
    epoch: 1,
    url: 'https://example.com/',
    title: 'Focus Cursor Demo',
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
    blocks: [
      { kind: 'heading', level: 1, text: 'Focus Cursor Demo' },
      {
        kind: 'paragraph',
        text: 'Read About Troy for details.',
        links: [{ text: 'About Troy', ref: 'e1', href: 'https://example.com/about' }],
      },
      { kind: 'input', ref: 'e2', text: 'Search docs', placeholder: 'Search docs', value: 'ascii' },
      { kind: 'button', ref: 'e10', text: 'Run Query' },
    ],
    elements,
  }
}

describe('M44: Highlighted active element focus cursor & live ref tooltip', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    const spacerParagraphs = Array.from(
      { length: 35 },
      (_, i) => `<p>Spacer paragraph ${i + 1}: ensuring footer link starts offscreen for auto-scroll test.</p>`,
    ).join('\n')

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/footer-target') {
        res.end(`<!doctype html><html><head><title>Footer Target</title></head><body><h1>Reached Footer</h1></body></html>`)
        return
      }
      res.end(`<!doctype html>
<html>
  <head><title>Focus TUI Test</title></head>
  <body>
    <h1>Focus TUI Test</h1>
    <nav>
      <a href="/docs">Documentation</a>
    </nav>
    <form action="/submit">
      <label>Username <input name="user" type="text" placeholder="Enter username" value="anish" /></label>
      <label>Region
        <select name="region">
          <option value="us-east-1" selected>US East</option>
          <option value="eu-west-1">EU West</option>
        </select>
      </label>
      <button type="button">Ping</button>
    </form>
    ${spacerParagraphs}
    <footer>
      <a href="/footer-target">Deep Footer Link</a>
    </footer>
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

  it('highlightFocusedRefInLines highlights exact ref without prefix collisions (e1 vs e10)', () => {
    const lines = [
      'Header text',
      'Inline [e1: About Troy] and [e10] button',
      'Another [e12] ref',
    ]

    const asciiRes = highlightFocusedRefInLines(lines, 'e1', { asciiOnly: true, color: false, maxWidth: 80 })
    expect(asciiRes.focusedLineIndex).toBe(1)
    expect(asciiRes.matchCount).toBe(1)
    expect(asciiRes.lines[1]).toContain('>>[e1: About Troy]<<')
    expect(asciiRes.lines[1]).toContain('[e10]')
    expect(asciiRes.lines[1]).not.toContain('>>[e10]<<')
    expect(asciiRes.lines[2]).toBe('Another [e12] ref')

    const ansiLines = [
      'Inline \x1b[36m[e1: About Troy]\x1b[0m and \x1b[33m[e10]\x1b[0m',
    ]
    const ansiRes = highlightFocusedRefInLines(ansiLines, 'e1', { asciiOnly: false, color: true, maxWidth: 80 })
    expect(ansiRes.focusedLineIndex).toBe(0)
    expect(ansiRes.matchCount).toBe(1)
    expect(ansiRes.lines[0]).toContain('\x1b[1m\x1b[7m\x1b[33m▸ [e1: About Troy] ◂\x1b[0m')
    expect(ansiRes.lines[0]).toContain('\x1b[33m[e10]\x1b[0m')
  })

  it('formatRefTooltip formats links, inputs, redacted values, selects, checkboxes, disabled, and submit buttons', () => {
    const linkTip = formatRefTooltip(
      { ref: 'e1', selector: 'a', tag: 'a', type: '', text: 'Docs — Guide', href: '/docs' },
      'e1',
      { index: 0, total: 5, asciiOnly: true },
    )
    expect(isStrictAscii(linkTip)).toBe(true)
    expect(linkTip).toContain('FOCUS [e1] (1/5) <a>')
    expect(linkTip).toContain('-> /docs')
    expect(linkTip).toContain('Enter:open')

    const redactedInputTip = formatRefTooltip(
      { ref: 'e2', selector: 'input', tag: 'input', type: 'password', text: '', label: 'Password', valueRedacted: true },
      'e2',
      { asciiOnly: true },
    )
    expect(redactedInputTip).toContain('<input:password>')
    expect(redactedInputTip).toContain('val=[REDACTED]')
    expect(redactedInputTip).toContain(':fill e2 <txt>')

    const selectTip = formatRefTooltip(
      {
        ref: 'e3',
        selector: 'select',
        tag: 'select',
        type: '',
        text: '',
        label: 'Region',
        options: [
          { value: 'us', label: 'US East', selected: true },
          { value: 'eu', label: 'EU West' },
        ],
      },
      'e3',
      { asciiOnly: true },
    )
    expect(selectTip).toContain('<select>')
    expect(selectTip).toContain('val="US East"')
    expect(selectTip).toContain('opts:2')
    expect(selectTip).toContain(':select e3 <val>')

    const submitTip = formatRefTooltip(
      { ref: 'e4', selector: 'button', tag: 'button', type: 'submit', text: 'Pay Now', defaultSubmit: true },
      'e4',
      { asciiOnly: true },
    )
    expect(submitTip).toContain('[submit]')
    expect(submitTip).toContain(':click e4 --submit')

    const disabledTip = formatRefTooltip(
      { ref: 'e5', selector: 'button', tag: 'button', type: 'button', text: 'Locked', disabled: true },
      'e5',
      { asciiOnly: true },
    )
    expect(disabledTip).toContain('[disabled]')
    expect(disabledTip).toContain('| disabled')
  })

  it('renderPageAsciiWithMetrics draws left-margin focus cursor, inline highlight, and exact box widths in ASCII and ANSI modes', () => {
    const snap = makeSampleSnapshot()

    // Strict 7-bit ASCII mode
    const asciiOut = renderPageAsciiWithMetrics(snap, {
      width: 100,
      height: 20,
      asciiOnly: true,
      color: false,
      focusedRef: 'e1',
    })
    expect(isStrictAscii(asciiOut.ascii)).toBe(true)
    expect(asciiOut.focusedLineIndex).toBeTypeOf('number')
    expect(asciiOut.ascii).toContain('>>[e1: About Troy]<<')
    expect(asciiOut.ascii).toContain('FOCUS [e1]')
    expect(asciiOut.ascii).toContain('-> https://example.com/about')

    const asciiLines = asciiOut.ascii.split('\n')
    for (const line of asciiLines) {
      expect(line.length).toBe(100)
    }
    // Left-margin focus cursor `|>` appears on the focused row
    expect(asciiLines.some((l) => l.startsWith('|>'))).toBe(true)

    // ANSI color mode
    const ansiOut = renderPageAsciiWithMetrics(snap, {
      width: 100,
      height: 20,
      asciiOnly: false,
      color: true,
      focusedRef: 'e10',
    })
    expect(ansiOut.focusedLineIndex).toBeTypeOf('number')
    expect(ansiOut.ascii).toContain('\x1b[1m\x1b[7m\x1b[33m▸ [e10] ◂\x1b[0m')
    expect(ansiOut.ascii).toContain('\x1b[1m\x1b[7m\x1b[33mFOCUS [e10]\x1b[0m')
    expect(ansiOut.ascii).toContain('\x1b[1m\x1b[33m▸\x1b[0m')

    // Every frame row preserves exact visible width of 100 columns
    for (const line of ansiOut.ascii.split('\n')) {
      expect(stripAnsi(line).length).toBe(100)
    }
  })

  it('TerminalBrowserController highlights focused ref, updates live status tooltip, and auto-scrolls offscreen refs into view', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ isTTY: false, columns: 110, rows: 20 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: true,
        rawMode: true,
        input: inp,
        output: out.stream,
        width: 110,
        height: 18,
      })

      await ctrl.init()
      expect(ctrl.getState().focusedRef).toBeNull()
      expect(ctrl.getState().focusedTooltip).toBeNull()

      // Tab -> focuses first ref (Documentation link)
      out.clear()
      await ctrl.handleKeypress('\t', { name: 'tab' })
      const st1 = ctrl.getState()
      expect(st1.focusedRef).toBe('e1')
      expect(st1.focusedTooltip).toContain('FOCUS [e1]')
      expect(st1.focusedTooltip).toContain('/docs')
      expect(st1.focusedTooltip).toContain('Enter:open')
      expect(st1.focusedLineIndex).toBeTypeOf('number')
      const frame1 = out.getText()
      expect(frame1).toContain('>>[e1')
      expect(frame1).toContain('FOCUS [e1]')

      // Tab -> focuses username input (shows :fill hint and value)
      out.clear()
      await ctrl.handleKeypress('\t', { name: 'tab' })
      const st2 = ctrl.getState()
      expect(st2.focusedRef).toBe('e2')
      expect(st2.focusedTooltip).toContain('<input:text')
      expect(st2.focusedTooltip).toContain('val="anish"')
      expect(st2.focusedTooltip).toContain(':fill e2 <txt>')

      // Tab -> focuses select dropdown (shows opts:2 and :select hint)
      out.clear()
      await ctrl.handleKeypress('\t', { name: 'tab' })
      const st3 = ctrl.getState()
      expect(st3.focusedRef).toBe('e3')
      expect(st3.focusedTooltip).toContain('<select')
      expect(st3.focusedTooltip).toContain('opts:2')
      expect(st3.focusedTooltip).toContain(':select e3 <val>')

      // Shift+Tab from index 0 wraps to the last ref ("Deep Footer Link"), which is offscreen!
      // First return to e1 (index 0), then Shift+Tab to wrap to last ref at bottom of page
      await ctrl.handleKeypress('', { name: 'tab', shift: true }) // e2
      await ctrl.handleKeypress('', { name: 'tab', shift: true }) // e1
      expect(ctrl.getState().scrollOffset).toBe(0)

      out.clear()
      await ctrl.handleKeypress('', { name: 'tab', shift: true }) // wraps to Deep Footer Link
      const footerState = ctrl.getState()
      expect(footerState.focusedTooltip).toContain('Deep Footer Link')
      expect(footerState.focusedTooltip).toContain('/footer-target')
      expect(footerState.scrollOffset).toBeGreaterThan(10)
      expect(footerState.focusedLineIndex).toBeTypeOf('number')
      expect(footerState.focusedLineIndex!).toBeGreaterThanOrEqual(footerState.scrollOffset)
      expect(footerState.focusedLineIndex!).toBeLessThan(footerState.scrollOffset + footerState.viewportRows)

      const footerFrame = out.getText()
      expect(footerFrame).toContain('Deep Footer Link')
      expect(footerFrame).toContain('>>[')

      // Escape clears focus cursor and tooltip
      out.clear()
      await ctrl.handleKeypress('', { name: 'escape' })
      expect(ctrl.getState().focusedRef).toBeNull()
      expect(ctrl.getState().focusedTooltip).toBeNull()
      expect(out.getText()).not.toContain('FOCUS [')
    } finally {
      await manager.close()
    }
  })

  it('renders ANSI color focus cursor and live tooltip in color TTY mode', async () => {
    const manager = await BrowserManager.create({ engine: 'lite' })
    try {
      const out = createMockOutput({ isTTY: true, columns: 110, rows: 20 })
      const inp = createMockTtyInput()
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        asciiOnly: false,
        color: true,
        rawMode: true,
        input: inp,
        output: out.stream,
        width: 110,
        height: 18,
      })

      await ctrl.init()
      out.clear()
      await ctrl.handleKeypress('\t', { name: 'tab' })
      const rendered = out.getText()
      expect(rendered).toContain('\x1b[1m\x1b[7m\x1b[33m▸ [e1')
      expect(rendered).toContain('\x1b[1m\x1b[7m\x1b[33mFOCUS [e1]\x1b[0m')
    } finally {
      await manager.close()
    }
  })
})
