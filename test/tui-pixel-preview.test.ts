import http from 'node:http'
import { PassThrough } from 'node:stream'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import {
  cycleViewMode,
  formatViewModeLabel,
  formatViewModeShortTag,
  isPixelViewMode,
  parseViewMode,
  renderPixelPreviewFrame,
  synthesizeSnapshotPreview,
  synthesizeSnapshotRaster,
  TUI_VIEW_MODES,
  viewModeToPixelMode,
} from '../src/tui/pixel-preview.js'
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

// Minimal deterministic RGBA PNG encoder for real Chromium screenshot testing
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodeTestPng(width: number, height: number, fillPixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rawRows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4)
    row[0] = 0 // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fillPixel(x, y)
      const off = 1 + x * 4
      row[off] = r
      row[off + 1] = g
      row[off + 2] = b
      row[off + 3] = a
    }
    rawRows.push(row)
  }
  const compressed = zlib.deflateSync(Buffer.concat(rawRows))
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

describe('M52: Live pixel-preview toggle (v cycles Layout -> Pixel ASCII -> Braille -> Halfblock)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/about') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>About Pixel Preview</title></head><body>
          <h1>ABOUT PAGE PIXEL PREVIEW</h1>
          <p>Second page for tab and navigation cache testing.</p>
          <a href="/">Return Home</a>
        </body></html>`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Pixel Preview Home</title></head><body>
        <h1>TUI PIXEL PREVIEW HOME</h1>
        <p>Live terminal visual preview across Layout, Pixel ASCII, Braille, and Halfblock.</p>
        <form action="/search">
          <label for="q">Search Query</label>
          <input id="q" name="q" type="text" placeholder="Type query..." />
          <button type="submit">Run Search</button>
        </form>
        <a href="/about">About Page</a>
      </body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('failed to bind test server')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('Pure helpers: cycleViewMode, parseViewMode, labels', () => {
    it('cycles forward through Layout ASCII -> Pixel ASCII -> Braille -> Halfblock -> Layout ASCII', () => {
      expect(TUI_VIEW_MODES).toEqual(['layout', 'pixel-ascii', 'braille', 'halfblock'])
      let mode = TUI_VIEW_MODES[0]!
      mode = cycleViewMode(mode, 1)
      expect(mode).toBe('pixel-ascii')
      mode = cycleViewMode(mode, 1)
      expect(mode).toBe('braille')
      mode = cycleViewMode(mode, 1)
      expect(mode).toBe('halfblock')
      mode = cycleViewMode(mode, 1)
      expect(mode).toBe('layout')
    })

    it('cycles backward with delta -1', () => {
      expect(cycleViewMode('layout', -1)).toBe('halfblock')
      expect(cycleViewMode('halfblock', -1)).toBe('braille')
      expect(cycleViewMode('braille', -1)).toBe('pixel-ascii')
      expect(cycleViewMode('pixel-ascii', -1)).toBe('layout')
    })

    it('parses aliases and rejects unknown modes', () => {
      expect(parseViewMode('layout')).toBe('layout')
      expect(parseViewMode('dom')).toBe('layout')
      expect(parseViewMode('pixel')).toBe('pixel-ascii')
      expect(parseViewMode('pixel-ascii')).toBe('pixel-ascii')
      expect(parseViewMode('ascii')).toBe('pixel-ascii')
      expect(parseViewMode('braille')).toBe('braille')
      expect(parseViewMode('halfblock')).toBe('halfblock')
      expect(parseViewMode('truecolor')).toBe('halfblock')
      expect(parseViewMode('invalid-mode')).toBeNull()
      expect(parseViewMode(undefined)).toBeNull()
    })

    it('formats human labels, short tags, and pixel modes accurately', () => {
      expect(formatViewModeLabel('layout')).toBe('Layout ASCII')
      expect(formatViewModeLabel('pixel-ascii')).toBe('Pixel ASCII')
      expect(formatViewModeLabel('braille')).toBe('Braille')
      expect(formatViewModeLabel('halfblock')).toBe('Halfblock')

      expect(formatViewModeShortTag('layout')).toBe('LAYOUT')
      expect(formatViewModeShortTag('pixel-ascii')).toBe('PIXEL')
      expect(formatViewModeShortTag('braille')).toBe('BRAILLE')
      expect(formatViewModeShortTag('halfblock')).toBe('HALFBLOCK')

      expect(isPixelViewMode('layout')).toBe(false)
      expect(isPixelViewMode('pixel-ascii')).toBe(true)
      expect(viewModeToPixelMode('pixel-ascii')).toBe('ascii')
      expect(viewModeToPixelMode('braille')).toBe('braille')
      expect(viewModeToPixelMode('halfblock')).toBe('halfblock')
    })
  })

  describe('Synthetic raster & renderPixelPreviewFrame', () => {
    const sampleSnapshot: PageSnapshot = {
      tabId: 1,
      url: 'http://127.0.0.1/demo',
      title: 'Demo Page',
      epoch: 1,
      capturedAt: Date.now(),
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, scrollHeight: 600 },
      blocks: [
        { kind: 'heading', level: 1, text: 'Welcome', box: { x: 20, y: 20, width: 300, height: 40 } },
        { kind: 'input', text: 'Search', ref: 'e1', box: { x: 20, y: 90, width: 260, height: 36 } },
        { kind: 'button', text: 'Submit', ref: 'e2', box: { x: 300, y: 90, width: 120, height: 36 } },
      ],
      elements: [
        {
          ref: 'e1',
          tag: 'input',
          type: 'text',
          name: 'q',
          text: '',
          selector: '#q',
          box: { x: 20, y: 90, width: 260, height: 36 },
        },
        {
          ref: 'e2',
          tag: 'button',
          type: 'submit',
          text: 'Submit',
          selector: 'button',
          box: { x: 300, y: 90, width: 120, height: 36 },
        },
      ],
      text: 'Welcome Search Submit',
    }

    it('synthesizes non-blank raster & overlays for snapshots with or without boxes', () => {
      const withBoxes = synthesizeSnapshotPreview(sampleSnapshot, 160, 100)
      expect(withBoxes.image.width).toBe(160)
      expect(withBoxes.image.height).toBe(100)
      expect(withBoxes.overlays.map((o) => o.ref)).toEqual(['e1', 'e2'])

      const flowOnly: PageSnapshot = {
        ...sampleSnapshot,
        blocks: sampleSnapshot.blocks.map((b) => ({ ...b, box: undefined })),
        elements: sampleSnapshot.elements.map((e) => ({ ...e, box: undefined })),
      }
      const synthFlow = synthesizeSnapshotPreview(flowOnly, 160, 100)
      expect(synthFlow.overlays.length).toBeGreaterThanOrEqual(2)

      const emptyRaster = synthesizeSnapshotRaster(undefined, 120, 80)
      expect(emptyRaster.width).toBe(120)
      expect(emptyRaster.height).toBe(80)
    })

    it('renders Pixel ASCII, Braille, and Halfblock frames from a real PNG screenshot', () => {
      const png = encodeTestPng(32, 20, (x, y) => {
        if (y < 10) return x < 16 ? [220, 40, 40, 255] : [40, 180, 70, 255]
        return [30, 80, 210, 255]
      })

      const pixelRes = renderPixelPreviewFrame({
        snapshot: sampleSnapshot,
        pngBuffer: png,
        viewMode: 'pixel-ascii',
        width: 80,
        height: 22,
        asciiOnly: true,
        color: false,
      })
      expect(pixelRes.source).toBe('chromium')
      expect(pixelRes.frame).toContain('[VIEW:PIXEL]')
      expect(pixelRes.frame).toContain('Pixel ASCII (live)')
      expect(pixelRes.frame).toContain('[e1]')
      expect(pixelRes.frame).toContain('[e2]')
      expect(hasAnsiEscapes(pixelRes.frame)).toBe(false)

      const brailleRes = renderPixelPreviewFrame({
        snapshot: sampleSnapshot,
        pngBuffer: png,
        viewMode: 'braille',
        width: 80,
        height: 22,
        asciiOnly: false,
        color: true,
      })
      expect(brailleRes.source).toBe('chromium')
      expect(brailleRes.frame).toContain('[VIEW:BRAILLE]')
      expect(/[\u2800-\u28ff]/.test(brailleRes.frame)).toBe(true)

      const halfRes = renderPixelPreviewFrame({
        snapshot: sampleSnapshot,
        pngBuffer: png,
        viewMode: 'halfblock',
        width: 80,
        height: 22,
        asciiOnly: false,
        color: true,
      })
      expect(halfRes.source).toBe('chromium')
      expect(halfRes.frame).toContain('[VIEW:HALFBLOCK]')
      expect(halfRes.frame).toContain('▀')
      expect(halfRes.frame).toContain('\x1b[38;2;')
    })

    it('gracefully falls back to synthetic preview when PNG buffer is corrupted', () => {
      const res = renderPixelPreviewFrame({
        snapshot: sampleSnapshot,
        pngBuffer: Buffer.from('not-a-valid-png'),
        viewMode: 'pixel-ascii',
        width: 80,
        height: 20,
        asciiOnly: true,
        color: false,
      })
      expect(res.source).toBe('synthetic')
      expect(res.frame).toContain('Pixel ASCII (synthetic)')
    })
  })

  describe('TerminalBrowserController live cycling, commands, palette & caching', () => {
    it('presses v to cycle Layout ASCII -> Pixel ASCII -> Braille -> Halfblock -> Layout ASCII', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', headless: true })
      try {
        const input = createMockInput({ isTTY: true })
        const output = createMockOutput({ isTTY: true, columns: 96, rows: 24 })
        const controller = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input: input.stream,
          output: output.stream,
          rawMode: true,
          color: true,
          asciiOnly: false,
          libraryPath: null,
        })

        await controller.init()
        expect(controller.getState().viewMode).toBe('layout')
        expect(controller.getState().pixelPreviewSource).toBeNull()
        expect(output.getText()).toContain('TUI PIXEL PREVIEW HOME')

        // 1st `v`: Layout ASCII -> Pixel ASCII
        output.clear()
        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('pixel-ascii')
        expect(controller.getState().pixelPreviewSource).toBe('synthetic')
        const pixelOut = output.getText()
        expect(pixelOut).toContain('[VIEW:PIXEL]')
        expect(pixelOut).toContain('[e1]')

        // 2nd `v`: Pixel ASCII -> Braille
        output.clear()
        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('braille')
        const brailleOut = output.getText()
        expect(brailleOut).toContain('[VIEW:BRAILLE]')
        expect(/[\u2800-\u28ff]/.test(brailleOut)).toBe(true)

        // 3rd `v`: Braille -> Halfblock
        output.clear()
        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('halfblock')
        const halfOut = output.getText()
        expect(halfOut).toContain('[VIEW:HALFBLOCK]')
        expect(halfOut).toContain('▀')
        expect(halfOut).toContain('\x1b[38;2;')

        // 4th `v`: Halfblock -> Layout ASCII
        output.clear()
        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('layout')
        expect(controller.getState().pixelPreviewSource).toBeNull()
        expect(output.getText()).toContain('TUI PIXEL PREVIEW HOME')

        // Shift+V cycles backward: Layout ASCII -> Halfblock
        output.clear()
        await controller.handleKeypress('V', { name: 'v', shift: true, sequence: 'V' })
        expect(controller.getState().viewMode).toBe('halfblock')
      } finally {
        await manager.close()
      }
    })

    it('supports :view and :visual commands and Command Palette entries', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', headless: true })
      try {
        const input = createMockInput({ isTTY: true })
        const output = createMockOutput({ isTTY: true, columns: 96, rows: 24 })
        const controller = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input: input.stream,
          output: output.stream,
          rawMode: true,
          color: true,
          asciiOnly: false,
          libraryPath: null,
        })
        await controller.init()

        await controller.executeCommand('view braille')
        await controller.draw()
        expect(controller.getState().viewMode).toBe('braille')

        await controller.executeCommand('visual halfblock')
        await controller.draw()
        expect(controller.getState().viewMode).toBe('halfblock')

        await controller.executeCommand('view prev')
        await controller.draw()
        expect(controller.getState().viewMode).toBe('braille')

        await controller.executeCommand('view bogus')
        expect(controller.getState().statusMessage).toContain('Unknown view mode')

        // Command palette Ctrl+P -> search "Cycle Pixel Preview" -> Enter
        await controller.handleKeypress('\x10', { name: 'p', ctrl: true, sequence: '\x10' })
        expect(controller.getState().mode).toBe('palette')
        const paletteCmds = controller.getState().palette?.allCommands ?? []
        expect(paletteCmds.some((c) => c.id === 'view.cycle-preview')).toBe(true)
        expect(paletteCmds.some((c) => c.id === 'view.visual-halfblock')).toBe(true)

        for (const ch of 'Cycle Pixel') {
          await controller.handleKeypress(ch, { name: ch.toLowerCase(), sequence: ch })
        }
        await controller.handleKeypress('\r', { name: 'return', sequence: '\r' })
        expect(controller.getState().mode).toBe('normal')
        expect(controller.getState().viewMode).toBe('halfblock')
      } finally {
        await manager.close()
      }
    })

    it('uses and caches live Chromium PNG screenshot across pixel modes and invalidates on navigation', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', headless: true })
      try {
        const fakePng = encodeTestPng(24, 16, (x, y) => [x * 10, y * 15, 180, 255])
        const origRunTool = manager.runTool.bind(manager)
        let screenshotCalls = 0
        vi.spyOn(manager, 'runTool').mockImplementation(async (tabId, toolName, args) => {
          if (toolName === 'page_screenshot') {
            screenshotCalls++
            return {
              ok: true,
              mimeType: 'image/png',
              dataBase64: fakePng.toString('base64'),
              bytes: fakePng.length,
            }
          }
          return origRunTool(tabId, toolName, args)
        })

        const input = createMockInput({ isTTY: true })
        const output = createMockOutput({ isTTY: true, columns: 96, rows: 24 })
        const controller = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input: input.stream,
          output: output.stream,
          rawMode: true,
          color: true,
          asciiOnly: false,
          libraryPath: null,
        })
        await controller.init()

        // Cycle through all 3 pixel modes: should only capture 1 screenshot for the same (tabId, epoch)
        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('pixel-ascii')
        expect(controller.getState().pixelPreviewSource).toBe('chromium')
        expect(screenshotCalls).toBe(1)

        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('braille')
        expect(screenshotCalls).toBe(1)

        await controller.handleKeypress('v', { name: 'v', sequence: 'v' })
        expect(controller.getState().viewMode).toBe('halfblock')
        expect(screenshotCalls).toBe(1)

        // Navigating to /about refreshes and captures a fresh screenshot
        const navRes = await controller.executeCommand(`open ${baseUrl}/about`)
        await controller.draw({ refresh: navRes.refresh })
        expect(controller.getState().viewMode).toBe('halfblock')
        expect(screenshotCalls).toBe(2)
      } finally {
        vi.restoreAllMocks()
        await manager.close()
      }
    })

    it('composes cleanly with split-pane inspector, terminal resize, and non-TTY sanitization', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', headless: true })
      try {
        const input = createMockInput({ isTTY: false })
        const output = createMockOutput({ isTTY: false, columns: 110, rows: 24 })
        const controller = new TerminalBrowserController(manager, {
          initialUrl: baseUrl,
          input: input.stream,
          output: output.stream,
          rawMode: false,
          viewMode: 'halfblock',
          splitPane: true,
          libraryPath: null,
        })
        await controller.init()

        const initialText = output.getText()
        expect(initialText).toContain('[VIEW:HALFBLOCK]')
        expect(initialText).toContain('INSPECTOR')
        // Non-TTY stream must remain completely free of ANSI escape sequences even in halfblock mode
        expect(hasAnsiEscapes(initialText)).toBe(false)

        // Resize to a different terminal geometry and reflow
        output.clear()
        output.stream.columns = 92
        output.stream.rows = 20
        await controller.handleResize({ source: 'sigwinch', force: true })
        expect(controller.getState().viewportWidth).toBe(92)
        expect(controller.getState().viewportHeight).toBe(17)
        expect(output.getText()).toContain('[VIEW:HALFBLOCK]')
      } finally {
        await manager.close()
      }
    })
  })
})
