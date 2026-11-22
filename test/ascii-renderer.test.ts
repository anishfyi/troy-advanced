import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { hasMultiColumnLayout, renderPageAscii, renderSpatialBlocks, sanitizeAscii } from '../src/ascii/layout.js'
import { decodePng } from '../src/ascii/png-decoder.js'
import { renderPngToAscii } from '../src/ascii/pixels.js'
import type { PageSnapshot } from '../src/types.js'

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function makeTestPng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 8-bit
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0 // filter None
    for (let x = 0; x < width; x++) {
      const dark = x < width / 2 ? 20 : 240
      const p = row + 1 + x * 4
      raw[p] = dark
      raw[p + 1] = dark
      raw[p + 2] = dark
      raw[p + 3] = 255
    }
  }
  const idat = deflateSync(raw)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

describe('ASCII spatial renderer & pure-Node PNG-to-ASCII', () => {
  it('renders strict 7-bit ASCII viewport with inline [eN] refs', () => {
    const snap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/dashboard',
      title: 'EC2 Ops — “Live”',
      epoch: 1,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 1600 },
      blocks: [
        { kind: 'heading', level: 1, text: 'Welcome to Troy Advanced' },
        { kind: 'paragraph', text: 'Run your AI browser right inside an SSH terminal.' },
        { kind: 'input', text: 'Query', value: 'us-east-1', ref: 'e1' },
        { kind: 'button', text: 'Run Check', ref: 'e2' },
        { kind: 'link', text: 'Docs', href: 'https://example.com/docs', ref: 'e3' },
      ],
      elements: [
        { ref: 'e1', selector: '#q', tag: 'input', type: 'text', text: 'Query', value: 'us-east-1' },
        { ref: 'e2', selector: '#go', tag: 'button', type: 'button', text: 'Run Check' },
        { ref: 'e3', selector: 'a.docs', tag: 'a', type: 'link', text: 'Docs', href: 'https://example.com/docs' },
      ],
      text: 'Welcome to Troy Advanced',
      capturedAt: Date.now(),
    }

    const ascii = renderPageAscii(snap, { width: 88, height: 26, asciiOnly: true })
    // Must contain only printable 7-bit ASCII and newlines
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('[e1]')
    expect(ascii).toContain('[e2]')
    expect(ascii).toContain('[e3]')
    expect(ascii).toContain('TROY-ADV')
    expect(sanitizeAscii('“Hello” — world…')).toBe('"Hello" - world...')
  })

  it('decodes synthetic PNG and renders ASCII, Braille, Halfblock, and Set-of-Marks overlays', () => {
    const png = makeTestPng(40, 20)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(40)
    expect(decoded.height).toBe(20)
    expect(decoded.rgba.length).toBe(40 * 20 * 4)

    const ascii = renderPngToAscii(png, {
      width: 30,
      height: 10,
      mode: 'ascii',
      overlays: [{ ref: 'e7', box: { x: 4, y: 4, width: 10, height: 4 } }],
      viewport: { width: 40, height: 20 },
    })
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('[e7]')

    const braille = renderPngToAscii(png, { width: 20, height: 8, mode: 'braille' })
    expect(braille.split('\n').length).toBe(8)

    const half = renderPngToAscii(png, { width: 16, height: 6, mode: 'halfblock' })
    expect(half).toContain('\x1b[38;2;')
  })

  it('renders true 2D spatial layout preserving header, sidebar, main content, and 3-column grid', () => {
    const snap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/app',
      title: 'Cloud Console',
      epoch: 2,
      viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        // Full-width top header
        { kind: 'heading', level: 1, text: 'Cloud Console', box: { x: 0, y: 0, width: 1200, height: 48 } },
        // Left sidebar links (x: 0..260)
        { kind: 'link', text: 'Instances', ref: 'e1', box: { x: 10, y: 80, width: 240, height: 28 } },
        { kind: 'link', text: 'Storage', ref: 'e2', box: { x: 10, y: 120, width: 240, height: 28 } },
        { kind: 'link', text: 'Billing', ref: 'e3', box: { x: 10, y: 160, width: 240, height: 28 } },
        // Main content column (x: 320..1180)
        { kind: 'heading', level: 2, text: 'Active Fleet', box: { x: 320, y: 80, width: 860, height: 32 } },
        {
          kind: 'paragraph',
          text: 'All production EC2 instances are healthy across us-east-1 and eu-west-1.',
          box: { x: 320, y: 120, width: 860, height: 48 },
        },
        // 3-column grid row (y: 220)
        { kind: 'button', text: 'CPU 12%', ref: 'e4', box: { x: 320, y: 220, width: 260, height: 36 } },
        { kind: 'button', text: 'MEM 44%', ref: 'e5', box: { x: 620, y: 220, width: 260, height: 36 } },
        { kind: 'button', text: 'DISK 8%', ref: 'e6', box: { x: 920, y: 220, width: 260, height: 36 } },
      ],
      elements: [
        { ref: 'e1', selector: '#nav1', tag: 'a', type: 'link', text: 'Instances' },
        { ref: 'e2', selector: '#nav2', tag: 'a', type: 'link', text: 'Storage' },
        { ref: 'e3', selector: '#nav3', tag: 'a', type: 'link', text: 'Billing' },
        { ref: 'e4', selector: '#c1', tag: 'button', type: 'button', text: 'CPU 12%' },
        { ref: 'e5', selector: '#c2', tag: 'button', type: 'button', text: 'MEM 44%' },
        { ref: 'e6', selector: '#c3', tag: 'button', type: 'button', text: 'DISK 8%' },
      ],
      text: 'Cloud Console',
      capturedAt: Date.now(),
    }

    expect(hasMultiColumnLayout(snap)).toBe(true)

    const ascii = renderPageAscii(snap, { width: 104, height: 30, asciiOnly: true, layout: 'spatial' })
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('layout:2d')

    const lines = ascii.split('\n')
    // Sidebar [e1] Instances and Main heading ## Active Fleet should be on the same row
    const sidebarMainLine = lines.find((l) => l.includes('[e1]') && l.includes('Active Fleet'))
    expect(sidebarMainLine).toBeDefined()
    expect(sidebarMainLine!.indexOf('[e1]')).toBeLessThan(sidebarMainLine!.indexOf('Active Fleet'))

    // All 3 grid cards should be placed side-by-side on the same row in left-to-right order
    const gridLine = lines.find((l) => l.includes('CPU 12%') && l.includes('MEM 44%') && l.includes('DISK 8%'))
    expect(gridLine).toBeDefined()
    expect(gridLine!.indexOf('CPU 12%')).toBeLessThan(gridLine!.indexOf('MEM 44%'))
    expect(gridLine!.indexOf('MEM 44%')).toBeLessThan(gridLine!.indexOf('DISK 8%'))

    // layout: 'auto' should also activate spatial mode for this multi-column page
    const autoAscii = renderPageAscii(snap, { width: 104, height: 30, asciiOnly: true, layout: 'auto' })
    expect(autoAscii).toContain('layout:2d')
    expect(autoAscii).toBe(ascii)
  })

  it('handles spatial fallback, element box inheritance, collision avoidance, and vertical gap compression', () => {
    // Single-column stacked blocks should NOT trigger auto spatial mode
    const singleCol: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/article',
      title: 'Article',
      epoch: 1,
      viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 2000 },
      blocks: [
        { kind: 'heading', level: 1, text: 'First', box: { x: 40, y: 20, width: 600, height: 32 } },
        // Intentionally overlapping Y in same column -> collision avoidance must push it below, not overwrite
        { kind: 'paragraph', text: 'Overlapping paragraph text', box: { x: 40, y: 24, width: 600, height: 32 } },
        // Huge 1200px vertical gap -> should be compressed, not 60 blank lines
        { kind: 'button', text: 'Footer Action', ref: 'e1' },
      ],
      elements: [
        // Block above has no box, so spatial renderer should inherit box from element e1
        { ref: 'e1', selector: '#f', tag: 'button', type: 'button', text: 'Footer Action', box: { x: 40, y: 1260, width: 200, height: 32 } },
      ],
      text: 'Article',
      capturedAt: Date.now(),
    }

    expect(hasMultiColumnLayout(singleCol)).toBe(false)
    const autoOut = renderPageAscii(singleCol, { width: 80, height: 24, asciiOnly: true, layout: 'auto' })
    expect(autoOut).not.toContain('layout:2d')

    const spatialLines = renderSpatialBlocks(singleCol, 76, true, false, true)
    expect(spatialLines).not.toBeNull()
    const joined = spatialLines!.join('\n')
    expect(joined).toContain('FIRST')
    expect(joined).toContain('Overlapping paragraph text')
    expect(joined).toContain('[e1] < Footer Action >')
    // Compressed output must stay compact (well under 15 rows despite y=1260)
    expect(spatialLines!.length).toBeLessThan(15)

    // Snapshot with zero boxes gracefully falls back to flow mode even when layout: 'spatial' is requested
    const noBoxSnap: PageSnapshot = {
      ...singleCol,
      blocks: [{ kind: 'paragraph', text: 'Plain flow text' }],
      elements: [],
    }
    expect(renderSpatialBlocks(noBoxSnap, 76, true, false, true)).toBeNull()
    const fallbackOut = renderPageAscii(noBoxSnap, { width: 80, height: 20, asciiOnly: true, layout: 'spatial' })
    expect(fallbackOut).toContain('Plain flow text')
    expect(fallbackOut).not.toContain('layout:2d')
  })
})
