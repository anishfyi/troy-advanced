import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import { buildPaletteCommands, filterPaletteCommands } from '../src/tui/command-palette.js'
import {
  buildPageExportContent,
  exportPageViewToFile,
  formatExportByteSize,
  formatExportStatusMessage,
  inferExportFormat,
  parseExportFormat,
  parseSaveCommandArgs,
  resolveExportPath,
  tokenizeSaveArgs,
} from '../src/tui/page-export.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'
import { hasAnsiEscapes } from '../src/tui/tty-fallback.js'
import type { PageSnapshot } from '../src/types.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? true
  stream.columns = opts.columns ?? 100
  stream.rows = opts.rows ?? 26
  stream.on('data', (chunk) => {
    chunks.push(chunk.toString('utf8'))
  })
  return {
    stream,
    chunks,
    getText: () => chunks.join(''),
    clear: () => {
      chunks.length = 0
    },
  }
}

function createMockInput(opts: { isTTY?: boolean } = {}) {
  const stream = new PassThrough() as unknown as TuiInputStream & PassThrough
  stream.isTTY = opts.isTTY ?? true
  stream.setRawMode = () => {}
  return { stream }
}

function makeSampleSnapshot(extraBlocks = 0): PageSnapshot {
  const blocks: PageSnapshot['blocks'] = [
    { kind: 'heading', level: 1, text: 'Troy Export Demo' },
    {
      kind: 'paragraph',
      text: 'Visit Documentation or Pricing for full details.',
      links: [
        { text: 'Documentation', href: 'https://example.com/docs', ref: 'e1' },
        { text: 'Pricing', href: 'https://example.com/pricing', ref: 'e2' },
      ],
    },
    { kind: 'table-row', cells: ['Plan', 'Price'], isHeader: true },
    { kind: 'table-row', cells: ['Starter', '$0'] },
    { kind: 'table-row', cells: ['Pro', '$29'] },
    {
      kind: 'input',
      text: 'Email',
      ref: 'e3',
      formId: 'signup',
      formTitle: 'Newsletter',
      value: 'dev@example.com',
    },
    {
      kind: 'button',
      text: 'Subscribe',
      ref: 'e4',
      formId: 'signup',
      formTitle: 'Newsletter',
    },
  ]

  for (let i = 0; i < extraBlocks; i++) {
    blocks.push({
      kind: 'paragraph',
      text: `Long page section line number ${i + 1} with deterministic marker LONG_LINE_${i + 1}.`,
    })
  }

  return {
    tabId: 7,
    epoch: 3,
    url: 'https://example.com/demo',
    title: 'Troy Export Demo',
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
    blocks,
    elements: [
      {
        ref: 'e1',
        tag: 'a',
        role: 'link',
        text: 'Documentation',
        href: 'https://example.com/docs',
        box: { x: 20, y: 80, width: 140, height: 24 },
      },
      {
        ref: 'e2',
        tag: 'a',
        role: 'link',
        text: 'Pricing',
        href: 'https://example.com/pricing',
        box: { x: 180, y: 80, width: 90, height: 24 },
      },
      {
        ref: 'e3',
        tag: 'input',
        type: 'email',
        role: 'textbox',
        name: 'email',
        text: 'Email',
        value: 'dev@example.com',
        box: { x: 20, y: 200, width: 240, height: 32 },
      },
      {
        ref: 'e4',
        tag: 'button',
        role: 'button',
        text: 'Subscribe',
        box: { x: 270, y: 200, width: 110, height: 32 },
      },
    ],
  }
}

describe('page-export helpers', () => {
  it('parses and infers export formats accurately', () => {
    expect(parseExportFormat('txt')).toBe('txt')
    expect(parseExportFormat('.ascii')).toBe('txt')
    expect(parseExportFormat('TEXT')).toBe('txt')
    expect(parseExportFormat('md')).toBe('md')
    expect(parseExportFormat('.markdown')).toBe('md')
    expect(parseExportFormat('json')).toBe('json')
    expect(parseExportFormat('pdf')).toBeNull()

    expect(inferExportFormat('out.txt')).toBe('txt')
    expect(inferExportFormat('out.md')).toBe('md')
    expect(inferExportFormat('out.markdown')).toBe('md')
    expect(inferExportFormat('out.json')).toBe('json')
    expect(inferExportFormat('README')).toBe('txt')
    expect(inferExportFormat('dump.raw', 'json')).toBe('json')
  })

  it('tokenizes quoted paths and parses :save flags cleanly', () => {
    const tok = tokenizeSaveArgs('"my folder/page view.md" --frontmatter --no-refs --width 88')
    expect(tok.ok).toBe(true)
    expect(tok.tokens).toEqual(['my folder/page view.md', '--frontmatter', '--no-refs', '--width', '88'])

    const parsed = parseSaveCommandArgs("'nested/file name.json' --compact --format=json")
    expect(parsed.ok).toBe(true)
    expect(parsed.filePath).toBe('nested/file name.json')
    expect(parsed.format).toBe('json')
    expect(parsed.compact).toBe(true)

    const withWidth = parseSaveCommandArgs('report.txt --viewport --ansi --ascii -w 90')
    expect(withWidth.ok).toBe(true)
    expect(withWidth.viewportOnly).toBe(true)
    expect(withWidth.preserveAnsi).toBe(true)
    expect(withWidth.forceAscii).toBe(true)
    expect(withWidth.width).toBe(90)
  })

  it('reports clear errors for malformed :save arguments', () => {
    expect(parseSaveCommandArgs('').ok).toBe(false)
    expect(parseSaveCommandArgs('"unterminated.md').error).toContain('Unterminated')
    expect(parseSaveCommandArgs('--format xml out.xml').error).toContain('Invalid format')
    expect(parseSaveCommandArgs('out.txt --bogus').error).toContain('Unknown option')
    expect(parseSaveCommandArgs('a.txt b.txt').error).toContain('Unexpected extra argument')
    expect(parseSaveCommandArgs('out.txt --width 10').error).toContain('Invalid width')
    expect(parseSaveCommandArgs('--frontmatter').error).toContain('Missing output file path')
  })

  it('expands ~ and resolves relative paths against cwd', () => {
    const homeExpanded = resolveExportPath('~/exports/page.md', '/tmp/work')
    expect(homeExpanded).toBe(path.join(os.homedir(), 'exports/page.md'))

    const rel = resolveExportPath('out/view.txt', '/tmp/work')
    expect(rel).toBe(path.resolve('/tmp/work', 'out/view.txt'))

    const abs = resolveExportPath('/var/tmp/view.json', '/tmp/work')
    expect(abs).toBe(path.normalize('/var/tmp/view.json'))
  })

  it('formats byte sizes and status messages cleanly', () => {
    expect(formatExportByteSize(512)).toBe('512 B')
    expect(formatExportByteSize(2048)).toBe('2.0 KB')
    expect(formatExportByteSize(2 * 1024 * 1024)).toBe('2.00 MB')

    const msg = formatExportStatusMessage({
      ok: true,
      format: 'txt',
      filePath: '/tmp/art.txt',
      bytes: 1536,
      lines: 30,
      viewMode: 'braille',
      exportedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(msg).toContain('Saved TXT [braille]')
    expect(msg).toContain('/tmp/art.txt')
    expect(msg).toContain('30 lines')
    expect(msg).toContain('1.5 KB')

    const errMsg = formatExportStatusMessage({
      ok: false,
      format: 'md',
      filePath: '/tmp',
      bytes: 0,
      lines: 0,
      viewMode: 'layout',
      exportedAt: '2026-01-01T00:00:00.000Z',
      error: 'Target path is a directory: /tmp',
    })
    expect(errMsg).toContain('Save failed: Target path is a directory')
  })
})

describe('buildPageExportContent', () => {
  const fixedDate = new Date('2026-04-15T12:00:00.000Z')

  it('builds clean plain-text .txt output for layout view and handles long pages without truncation', () => {
    const snapshot = makeSampleSnapshot(0)
    const built = buildPageExportContent({
      snapshot,
      format: 'txt',
      width: 90,
      asciiOnly: true,
      now: fixedDate,
    })
    expect(built.format).toBe('txt')
    expect(hasAnsiEscapes(built.content)).toBe(false)
    expect(built.content).toContain('Troy Export Demo')
    expect(built.content).toContain('[e1')
    expect(built.content).toContain('Subscribe')
    expect(built.lines).toBeGreaterThan(5)

    // Long page (>200 lines) should preserve both the first and last lines
    const longSnapshot = makeSampleSnapshot(220)
    const longBuilt = buildPageExportContent({
      snapshot: longSnapshot,
      format: 'txt',
      width: 90,
      asciiOnly: true,
      now: fixedDate,
    })
    expect(longBuilt.content).toContain('LONG_LINE_1.')
    expect(longBuilt.content).toContain('LONG_LINE_220.')
  })

  it('builds .txt output for active pixel-preview modes (pixel-ascii, braille, halfblock)', () => {
    const snapshot = makeSampleSnapshot(0)

    const braille = buildPageExportContent({
      snapshot,
      format: 'txt',
      viewMode: 'braille',
      width: 80,
      height: 24,
      now: fixedDate,
    })
    expect(hasAnsiEscapes(braille.content)).toBe(false)
    expect(braille.content).toMatch(/[\u2800-\u28ff]/)

    const halfblockPlain = buildPageExportContent({
      snapshot,
      format: 'txt',
      viewMode: 'halfblock',
      width: 80,
      height: 24,
      preserveAnsi: false,
      now: fixedDate,
    })
    expect(hasAnsiEscapes(halfblockPlain.content)).toBe(false)

    const halfblockAnsi = buildPageExportContent({
      snapshot,
      format: 'txt',
      viewMode: 'halfblock',
      width: 80,
      height: 24,
      preserveAnsi: true,
      now: fixedDate,
    })
    expect(hasAnsiEscapes(halfblockAnsi.content)).toBe(true)
  })

  it('builds structured .md output with optional YAML frontmatter and --no-refs', () => {
    const snapshot = makeSampleSnapshot(0)
    const md = buildPageExportContent({
      snapshot,
      format: 'md',
      frontmatter: true,
      showRefs: true,
      now: fixedDate,
    })
    expect(md.content).toContain('---')
    expect(md.content).toContain('title: "Troy Export Demo"')
    expect(md.content).toContain('url: "https://example.com/demo"')
    expect(md.content).toContain('[Documentation](https://example.com/docs) [e1]')
    expect(md.content).toContain('| Plan | Price |')

    const noRefs = buildPageExportContent({
      snapshot,
      format: 'md',
      showRefs: false,
      now: fixedDate,
    })
    expect(noRefs.content).not.toContain('[e1]')
    expect(noRefs.content).toContain('[Documentation](https://example.com/docs)')
  })

  it('builds valid .json export in pretty and --compact modes', () => {
    const snapshot = makeSampleSnapshot(0)
    const pretty = buildPageExportContent({
      snapshot,
      format: 'json',
      now: fixedDate,
    })
    const parsed = JSON.parse(pretty.content) as Record<string, unknown>
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.exportedAt).toBe('2026-04-15T12:00:00.000Z')
    expect(parsed.viewMode).toBe('layout')
    expect(parsed.url).toBe('https://example.com/demo')
    expect(parsed.elementCount).toBe(4)
    expect(Array.isArray(parsed.elements)).toBe(true)
    expect(Array.isArray(parsed.blocks)).toBe(true)
    const rendered = parsed.rendered as { ascii: string; markdown: string }
    expect(rendered.ascii).toContain('Troy Export Demo')
    expect(rendered.markdown).toContain('[Documentation](https://example.com/docs)')

    const compact = buildPageExportContent({
      snapshot,
      format: 'json',
      compact: true,
      now: fixedDate,
    })
    expect(compact.lines).toBe(1)
    expect(JSON.parse(compact.content).title).toBe('Troy Export Demo')
  })
})

describe('exportPageViewToFile', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-export-unit-'))
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates missing parent directories and refuses to overwrite a directory', () => {
    const snapshot = makeSampleSnapshot(0)
    const nested = exportPageViewToFile({
      snapshot,
      rawFilePath: 'deep/nested/dir/page.md',
      cwd: tmpDir,
    })
    expect(nested.ok).toBe(true)
    expect(nested.format).toBe('md')
    expect(fs.existsSync(nested.filePath)).toBe(true)
    expect(nested.bytes).toBeGreaterThan(20)

    const dirErr = exportPageViewToFile({
      snapshot,
      rawFilePath: 'deep/nested/dir',
      cwd: tmpDir,
    })
    expect(dirErr.ok).toBe(false)
    expect(dirErr.error).toContain('directory')
  })
})

describe('TerminalBrowserController :save integration', () => {
  let server: http.Server
  let baseUrl: string
  let tmpDir: string
  let manager: BrowserManager

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-tui-save-'))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head><title>Export Integration Page</title></head>
  <body>
    <main>
      <h1>Export Integration Page</h1>
      <p>Read the <a href="/guide">Quickstart Guide</a> or inspect the <a href="/api">API Reference</a>.</p>
      <table>
        <thead><tr><th>Format</th><th>Extension</th></tr></thead>
        <tbody>
          <tr><td>Text</td><td>.txt</td></tr>
          <tr><td>Markdown</td><td>.md</td></tr>
          <tr><td>JSON</td><td>.json</td></tr>
        </tbody>
      </table>
      <form aria-label="Feedback">
        <label>Comment <input type="text" name="comment" value="Great TUI" /></label>
        <button type="submit">Send</button>
      </form>
    </main>
  </body>
</html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`

    manager = await BrowserManager.create({
      engine: 'lite',
      headless: true,
      profileDir: path.join(tmpDir, 'profile'),
    })
    await manager.openTab(baseUrl, { activate: true })
  })

  afterAll(async () => {
    await manager.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exports .txt, .md, and .json via :save and :export commands', async () => {
    const exportDir = path.join(tmpDir, 'exports-cmd')
    const out = createMockOutput({ columns: 100, rows: 26 })
    const inp = createMockInput()
    const ctrl = new TerminalBrowserController(manager, {
      input: inp.stream,
      output: out.stream,
      rawMode: true,
      libraryPath: null,
      exportDir,
    })

    await ctrl.draw({ refresh: true })

    // 1. Save as .txt
    await ctrl.executeCommand('save view.txt')
    let state = ctrl.getState()
    expect(state.lastExport?.format).toBe('txt')
    expect(state.lastExport?.filePath).toBe(path.join(exportDir, 'view.txt'))
    expect(state.statusMessage).toContain('Saved TXT')
    const txtContent = fs.readFileSync(path.join(exportDir, 'view.txt'), 'utf8')
    expect(txtContent).toContain('Export Integration Page')
    expect(txtContent).toContain('Quickstart Guide')
    expect(hasAnsiEscapes(txtContent)).toBe(false)

    // 2. Save as .md with --frontmatter
    await ctrl.executeCommand('save docs/page.md --frontmatter')
    state = ctrl.getState()
    expect(state.lastExport?.format).toBe('md')
    expect(state.statusMessage).toContain('Saved MD')
    const mdContent = fs.readFileSync(path.join(exportDir, 'docs/page.md'), 'utf8')
    expect(mdContent).toContain('---')
    expect(mdContent).toContain('title: "Export Integration Page"')
    expect(mdContent).toContain('Quickstart Guide')
    expect(mdContent).toContain('| Format | Extension |')

    // 3. Save as .json via :export alias
    await ctrl.executeCommand('export snapshot.json')
    state = ctrl.getState()
    expect(state.lastExport?.format).toBe('json')
    expect(state.statusMessage).toContain('Saved JSON')
    const jsonParsed = JSON.parse(fs.readFileSync(path.join(exportDir, 'snapshot.json'), 'utf8'))
    expect(jsonParsed.schemaVersion).toBe(1)
    expect(jsonParsed.title).toBe('Export Integration Page')
    expect(jsonParsed.elementCount).toBeGreaterThanOrEqual(3)
    expect(jsonParsed.rendered.markdown).toContain('Export Integration Page')

    // 4. Explicit --format override on non-standard extension
    await ctrl.executeCommand('save custom.dump --format json --compact')
    const dumpContent = fs.readFileSync(path.join(exportDir, 'custom.dump'), 'utf8')
    expect(dumpContent.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(dumpContent).title).toBe('Export Integration Page')
  })

  it('supports interactive : command bar typing with quoted paths and exports active pixel preview', async () => {
    const exportDir = path.join(tmpDir, 'exports-keys')
    const out = createMockOutput({ columns: 100, rows: 26 })
    const inp = createMockInput()
    const ctrl = new TerminalBrowserController(manager, {
      input: inp.stream,
      output: out.stream,
      rawMode: true,
      libraryPath: null,
      exportDir,
    })

    await ctrl.draw({ refresh: true })

    // Switch to Braille pixel-preview mode (`v` twice: layout -> pixel-ascii -> braille)
    await ctrl.handleKeypress('v', { name: 'v', sequence: 'v' })
    await ctrl.handleKeypress('v', { name: 'v', sequence: 'v' })
    expect(ctrl.getState().viewMode).toBe('braille')

    // Press ':' to enter command bar, type `save "my dir/braille view.txt"`, press Enter
    await ctrl.handleKeypress(':', { sequence: ':' })
    expect(ctrl.getState().mode).toBe('command')
    const typed = 'save "my dir/braille view.txt"'
    for (const ch of typed) {
      await ctrl.handleKeypress(ch, { sequence: ch })
    }
    await ctrl.handleKeypress('\r', { name: 'return', sequence: '\r' })

    const state = ctrl.getState()
    expect(state.mode).toBe('normal')
    expect(state.lastExport?.viewMode).toBe('braille')
    expect(state.statusMessage).toContain('Saved TXT [braille]')
    const saved = fs.readFileSync(path.join(exportDir, 'my dir/braille view.txt'), 'utf8')
    expect(saved).toMatch(/[\u2800-\u28ff]/)
  })

  it('handles missing args gracefully without crashing or clearing previous export', async () => {
    const exportDir = path.join(tmpDir, 'exports-err')
    const out = createMockOutput()
    const inp = createMockInput()
    const ctrl = new TerminalBrowserController(manager, {
      input: inp.stream,
      output: out.stream,
      rawMode: true,
      libraryPath: null,
      exportDir,
    })

    await ctrl.draw({ refresh: true })
    await ctrl.executeCommand('save')
    expect(ctrl.getState().statusMessage).toContain('Usage: :save')
    expect(ctrl.getState().lastExport).toBeNull()
  })

  it('exposes Save Page commands in the Ctrl+P Command Palette', async () => {
    const cmds = buildPaletteCommands({
      tabs: manager.listTabs(),
      splitPane: false,
      asciiOnly: true,
      hasFocusedRef: false,
      viewMode: 'layout',
    })
    const matches = filterPaletteCommands(cmds, 'save')
    const ids = matches.map((m) => m.id)
    expect(ids).toContain('page.save-txt')
    expect(ids).toContain('page.save-md')
    expect(ids).toContain('page.save-json')

    const exportDir = path.join(tmpDir, 'exports-palette')
    const out = createMockOutput()
    const inp = createMockInput()
    const ctrl = new TerminalBrowserController(manager, {
      input: inp.stream,
      output: out.stream,
      rawMode: true,
      libraryPath: null,
      exportDir,
    })
    await ctrl.draw({ refresh: true })

    // Open palette, search "save markdown", hit Enter -> pre-fills command bar with `save page.md`
    await ctrl.handleKeypress('\x10', { name: 'p', ctrl: true })
    for (const ch of 'save markdown') {
      await ctrl.handleKeypress(ch, { sequence: ch })
    }
    await ctrl.handleKeypress('\r', { name: 'return', sequence: '\r' })
    expect(ctrl.getState().mode).toBe('command')
    expect(ctrl.getState().inputBuffer).toBe('save page.md')

    // Hit Enter again to immediately execute `:save page.md`
    await ctrl.handleKeypress('\r', { name: 'return', sequence: '\r' })
    expect(ctrl.getState().mode).toBe('normal')
    expect(fs.existsSync(path.join(exportDir, 'page.md'))).toBe(true)
  })
})
