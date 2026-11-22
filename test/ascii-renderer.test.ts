import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { renderPageAscii, sanitizeAscii } from '../src/ascii/layout.js'
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
})
