import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PageSnapshot } from '../src/types.js'
import {
  decodeCanvasDataUrl,
  extractMediaSummary,
  formatMediaMeta,
  renderCanvasPreviewAscii,
  renderMediaSummaryAscii,
  renderPageAscii,
} from '../src/ascii/layout.js'
import { BrowserManager } from '../src/engine/manager.js'
import { findChromeBinary } from '../src/engine/chromium.js'

const hasChrome = Boolean(findChromeBinary())

// Minimal valid RGBA PNG encoder for deterministic unit tests (zero external deps)
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
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

function encodeRgbaPng(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = 1 + width * 4
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const off = y * stride + 1 + x * 4
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = a
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function makeCanvasDataUrl(width: number, height: number): string {
  const png = encodeRgbaPng(width, height, (x, y) => {
    // Draw a dark centered bar/box on white background
    if (x >= Math.floor(width * 0.25) && x <= Math.floor(width * 0.75) && y >= Math.floor(height * 0.25) && y <= Math.floor(height * 0.75)) {
      return [16, 16, 16, 255]
    }
    return [255, 255, 255, 255]
  })
  return `data:image/png;base64,${png.toString('base64')}`
}

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    tabId: 1,
    url: 'https://example.com/dashboard',
    title: 'Analytics Dashboard',
    epoch: 1,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
    blocks: [],
    elements: [],
    text: '',
    capturedAt: Date.now(),
    ...overrides,
  }
}

describe('Image/Canvas extraction summary & auto-ASCII preview (M12)', () => {
  it('decodes valid PNG data URLs and safely rejects invalid/corrupt data URLs', () => {
    const validUrl = makeCanvasDataUrl(24, 16)
    const buf = decodeCanvasDataUrl(validUrl)
    expect(buf).not.toBeNull()
    expect(buf!.length).toBeGreaterThan(24)

    expect(decodeCanvasDataUrl(undefined)).toBeNull()
    expect(decodeCanvasDataUrl('')).toBeNull()
    expect(decodeCanvasDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBeNull()
    expect(decodeCanvasDataUrl('data:image/png;base64,bm90LWEtcG5n')).toBeNull()
    expect(renderCanvasPreviewAscii('data:image/png;base64,bm90LWEtcG5n')).toBeNull()
  })

  it('renders strict 7-bit ASCII preview from a <canvas> PNG data URL', () => {
    const dataUrl = makeCanvasDataUrl(32, 16)
    const preview = renderCanvasPreviewAscii(dataUrl, { width: 24, height: 8 })
    expect(preview).not.toBeNull()
    expect(/^[\x20-\x7e\n]+$/.test(preview!)).toBe(true)
    // Framed box with dark pixels (@ or #) in the center
    expect(preview!).toContain('+------------------------+')
    expect(preview!).toMatch(/[@#%]/)
  })

  it('formats dimensions, natural dimensions, and bounding box coordinates cleanly', () => {
    expect(formatMediaMeta({ box: { x: 20, y: 80, width: 640, height: 360 } })).toBe('640x360 @(20,80)')
    expect(
      formatMediaMeta({
        naturalWidth: 1280,
        naturalHeight: 720,
        box: { x: 20, y: 80, width: 640, height: 360 },
      }),
    ).toBe('640x360 (natural 1280x720) @(20,80)')
    expect(formatMediaMeta({ naturalWidth: 400, naturalHeight: 200 })).toBe('400x200')
    expect(formatMediaMeta({})).toBe('')
  })

  it('extracts structured media summary and renders MEDIA SUMMARY ASCII with auto-ASCII canvas preview', () => {
    const dataUrl = makeCanvasDataUrl(40, 20)
    const snap = makeSnapshot({
      blocks: [
        { kind: 'heading', level: 1, text: 'Metrics', tag: 'h1' },
        {
          kind: 'image',
          text: 'Hero Banner',
          alt: 'Hero Banner',
          src: 'https://example.com/hero.png',
          naturalWidth: 1200,
          naturalHeight: 600,
          box: { x: 10, y: 60, width: 600, height: 300 },
          tag: 'img',
        },
        {
          kind: 'canvas',
          text: 'Revenue Chart',
          alt: 'Revenue Chart',
          naturalWidth: 400,
          naturalHeight: 200,
          box: { x: 10, y: 380, width: 400, height: 200 },
          canvasDataUrl: dataUrl,
          tag: 'canvas',
        },
      ],
    })

    const items = extractMediaSummary(snap, { previewWidth: 28, previewHeight: 8 })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      kind: 'image',
      label: 'Hero Banner',
      src: 'https://example.com/hero.png',
      width: 600,
      height: 300,
      naturalWidth: 1200,
      naturalHeight: 600,
      box: { x: 10, y: 60, width: 600, height: 300 },
    })
    expect(items[1]).toMatchObject({
      kind: 'canvas',
      label: 'Revenue Chart',
      width: 400,
      height: 200,
      box: { x: 10, y: 380, width: 400, height: 200 },
    })
    expect(items[1]!.asciiPreview).toBeTruthy()
    expect(items[1]!.asciiPreview!).toMatch(/[@#%]/)

    const summary = renderMediaSummaryAscii(snap, { width: 96, previewWidth: 28, previewHeight: 8 })
    expect(/^[\x20-\x7e\n]+$/.test(summary)).toBe(true)
    expect(summary).toContain('MEDIA SUMMARY (2 items: 1 img, 1 canvas):')
    expect(summary).toContain('[IMG] "Hero Banner" 600x300 (natural 1200x600) @(10,60)')
    expect(summary).toContain('[CANVAS] "Revenue Chart" 400x200 @(10,380)')
    expect(summary).toContain('+----------------------------+')

    // Inline rendering in renderPageAscii + showMediaSummary option
    const pageAscii = renderPageAscii(snap, {
      width: 100,
      height: 45,
      showMediaSummary: true,
      canvasPreviewWidth: 24,
      canvasPreviewHeight: 8,
    })
    expect(/^[\x20-\x7e\n]+$/.test(pageAscii)).toBe(true)
    expect(pageAscii).toContain('[IMG: Hero Banner (600x300 (natural 1200x600) @(10,60))]')
    expect(pageAscii).toContain('[CANVAS: Revenue Chart (400x200 @(10,380))]')
    expect(pageAscii).toContain('MEDIA SUMMARY (2 items: 1 img, 1 canvas):')
  })

  it('extracts <img> and <canvas> dimensions in Lite engine and returns media summary in page_read_ascii', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Lite Media Test</title></head>
        <body>
          <h1>Charts &amp; Assets</h1>
          <img src="/logo.png" alt="Company Logo" width="240" height="80" />
          <canvas id="sparkline" aria-label="CPU Usage Sparkline" width="320" height="120">Fallback chart text</canvas>
          <canvas id="mini" width="100" height="50" />
        </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-lite-media-'))

    try {
      const manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
      try {
        const opened = await manager.openTab(baseUrl, { activate: true })
        expect(opened.ok).toBe(true)

        const res = await manager.runTool(opened.id, 'page_read_ascii', {
          width: 96,
          height: 36,
          showMediaSummary: true,
        })
        expect(res.ok).toBe(true)
        const media = res.media as Array<Record<string, unknown>>
        expect(media).toHaveLength(3)
        expect(media[0]).toMatchObject({
          kind: 'image',
          label: 'Company Logo',
          src: `${baseUrl}/logo.png`,
          naturalWidth: 240,
          naturalHeight: 80,
        })
        expect(media[1]).toMatchObject({
          kind: 'canvas',
          label: 'CPU Usage Sparkline',
          naturalWidth: 320,
          naturalHeight: 120,
        })
        expect(media[2]).toMatchObject({
          kind: 'canvas',
          label: 'mini',
          naturalWidth: 100,
          naturalHeight: 50,
        })

        expect(String(res.mediaSummaryAscii)).toContain('MEDIA SUMMARY (3 items: 1 img, 2 canvas):')
        expect(String(res.ascii)).toContain('[IMG: Company Logo (240x80)]')
        expect(String(res.ascii)).toContain('[CANVAS: CPU Usage Sparkline (320x120)]')
        expect(String(res.ascii)).toContain('MEDIA SUMMARY (3 items: 1 img, 2 canvas):')
      } finally {
        await manager.close()
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasChrome)('Chromium E2E Image/Canvas extraction & auto-ASCII <canvas> preview (M12)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-adv-chrome-media-'))
    const samplePng = encodeRgbaPng(40, 20, () => [40, 120, 220, 255])
    server = http.createServer((req, res) => {
      if (req.url === '/badge.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(samplePng)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
        <head><title>Canvas Auto-ASCII E2E</title></head>
        <body style="margin:20px; background:#fff; color:#111;">
          <h1>Live Canvas Preview</h1>
          <img src="/badge.png" alt="Status Badge" width="80" height="40" style="display:block; margin-bottom:16px;" />
          <canvas id="barChart" aria-label="Traffic Bar Chart" width="240" height="100" style="display:block; border:1px solid #000;"></canvas>
          <script>
            const c = document.getElementById('barChart');
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 240, 100);
            ctx.fillStyle = '#000000';
            ctx.fillRect(20, 20, 60, 70);
            ctx.fillRect(100, 10, 60, 80);
            ctx.fillRect(180, 40, 40, 50);
          </script>
        </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    manager = await BrowserManager.create({ engine: 'chromium', profileDir: tmpDir })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((r) => server?.close(() => r()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('captures real <img> and <canvas> dimensions, bounding boxes, and auto-ASCII <canvas> preview in Chromium', async () => {
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)

    const read = await manager.runTool(opened.id, 'page_read_ascii', {
      width: 100,
      height: 50,
      showMediaSummary: true,
    })
    expect(read.ok).toBe(true)
    expect(read.engine).toBe('chromium')

    const media = read.media as Array<{
      kind: string
      label: string
      width?: number
      height?: number
      box?: { x: number; y: number; width: number; height: number }
      asciiPreview?: string
    }>
    expect(media).toHaveLength(2)

    const imgItem = media.find((m) => m.kind === 'image')!
    expect(imgItem.label).toBe('Status Badge')
    expect(imgItem.width).toBe(80)
    expect(imgItem.height).toBe(40)
    expect(imgItem.box).toBeDefined()
    expect(imgItem.box!.width).toBe(80)

    const canvasItem = media.find((m) => m.kind === 'canvas')!
    expect(canvasItem.label).toBe('Traffic Bar Chart')
    expect(canvasItem.width).toBeGreaterThanOrEqual(240)
    expect(canvasItem.height).toBeGreaterThanOrEqual(100)
    expect(canvasItem.box).toBeDefined()
    expect(canvasItem.asciiPreview).toBeTruthy()
    expect(/^[\x20-\x7e\n]+$/.test(canvasItem.asciiPreview!)).toBe(true)
    // Drawn dark bars should produce dark ASCII glyphs (@, #, %)
    expect(canvasItem.asciiPreview!).toMatch(/[@#%]/)

    const ascii = String(read.ascii)
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('[IMG: Status Badge')
    expect(ascii).toContain('[CANVAS: Traffic Bar Chart')
    expect(ascii).toContain('MEDIA SUMMARY (2 items: 1 img, 1 canvas):')
  })
})
