import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { renderPngToAscii, renderRgbaToAscii, sobelEdgeChar } from '../src/ascii/pixels.js'
import type { DecodedPng } from '../src/ascii/png-decoder.js'

function makeRgba(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number, number],
): DecodedPng {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const idx = (y * width + x) * 4
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = a
    }
  }
  return { width, height, rgba }
}

function innerLines(framedAscii: string): string[] {
  const lines = framedAscii.split('\n')
  return lines.slice(1, -1).map((line) => line.slice(1, -1))
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function encodeRgbaPng(img: DecodedPng): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const rawRows: Buffer[] = []
  for (let y = 0; y < img.height; y++) {
    const row = Buffer.alloc(1 + img.width * 4)
    row[0] = 0
    for (let x = 0; x < img.width; x++) {
      const src = (y * img.width + x) * 4
      const dst = 1 + x * 4
      row[dst] = img.rgba[src]!
      row[dst + 1] = img.rgba[src + 1]!
      row[dst + 2] = img.rgba[src + 2]!
      row[dst + 3] = img.rgba[src + 3]!
    }
    rawRows.push(row)
  }
  const idat = deflateSync(Buffer.concat(rawRows))
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

describe('Sobel edge-detection ASCII mode (M09)', () => {
  it('maps Sobel gradient vectors to directional /\\-| glyphs', () => {
    expect(sobelEdgeChar(0, 0)).toBe(' ')
    expect(sobelEdgeChar(0.2, 0.2, 0.2)).toBe(' ')

    // Horizontal gradient -> vertical edge '|'
    expect(sobelEdgeChar(4, 0)).toBe('|')
    expect(sobelEdgeChar(-4, 0)).toBe('|')

    // Vertical gradient -> horizontal edge '-'
    expect(sobelEdgeChar(0, 4)).toBe('-')
    expect(sobelEdgeChar(0, -4)).toBe('-')

    // +45 / -135 deg gradient -> rising diagonal edge '/'
    expect(sobelEdgeChar(3, 3)).toBe('/')
    expect(sobelEdgeChar(-3, -3)).toBe('/')

    // -45 / +135 deg gradient -> falling diagonal edge '\'
    expect(sobelEdgeChar(3, -3)).toBe('\\')
    expect(sobelEdgeChar(-3, 3)).toBe('\\')
  })

  it('produces an empty interior for uniform solid images without border artifacts', () => {
    const solidWhite = makeRgba(64, 32, () => [255, 255, 255, 255])
    const out = renderRgbaToAscii(solidWhite, { width: 32, height: 12, mode: 'edge' })
    expect(/^[\x20-\x7e\n]+$/.test(out)).toBe(true)

    const lines = out.split('\n')
    expect(lines.length).toBe(14)
    expect(lines[0]).toBe(`+${'-'.repeat(32)}+`)
    expect(lines[lines.length - 1]).toBe(`+${'-'.repeat(32)}+`)

    for (const row of innerLines(out)) {
      expect(row).toBe(' '.repeat(32))
    }
  })

  it('detects a vertical step edge with | glyphs', () => {
    const img = makeRgba(64, 32, (x) => (x < 32 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const out = renderRgbaToAscii(img, { width: 32, height: 12, mode: 'edge' })
    const inner = innerLines(out)

    for (const row of inner) {
      expect(row).toContain('|')
      // Far left and far right remain flat spaces
      expect(row.slice(0, 8)).toBe(' '.repeat(8))
      expect(row.slice(-8)).toBe(' '.repeat(8))
    }
  })

  it('detects a horizontal step edge with - glyphs', () => {
    const img = makeRgba(64, 32, (_x, y) => (y < 16 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const out = renderRgbaToAscii(img, { width: 32, height: 12, mode: 'edge' })
    const inner = innerLines(out)

    const joined = inner.join('\n')
    expect(joined).toContain('----------')
    // Top and bottom rows away from seam are empty
    expect(inner[0]).toBe(' '.repeat(32))
    expect(inner[inner.length - 1]).toBe(' '.repeat(32))
  })

  it('detects rising (/) and falling (\\) diagonal edges', () => {
    // Rising diagonal: top-left white, bottom-right black
    const rising = makeRgba(40, 40, (x, y) => (x + y < 40 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const risingOut = innerLines(renderRgbaToAscii(rising, { width: 20, height: 20, mode: 'edge' })).join('')
    expect(risingOut).toContain('/')

    // Falling diagonal: top-right white, bottom-left black
    const falling = makeRgba(40, 40, (x, y) => (x >= y ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const fallingOut = innerLines(renderRgbaToAscii(falling, { width: 20, height: 20, mode: 'edge' })).join('')
    expect(fallingOut).toContain('\\')
  })

  it('renders a filled UI card/button as a crisp hollow wireframe outline', () => {
    // 100x50 white canvas with a solid dark rectangle in the center (x: 20..80, y: 12..38)
    const card = makeRgba(100, 50, (x, y) =>
      x >= 20 && x < 80 && y >= 12 && y < 38 ? [20, 20, 30, 255] : [255, 255, 255, 255],
    )
    const out = renderRgbaToAscii(card, { width: 50, height: 20, mode: 'edge' })
    expect(/^[\x20-\x7e\n]+$/.test(out)).toBe(true)

    const inner = innerLines(out)
    const body = inner.join('\n')
    expect(body).toContain('-')
    expect(body).toContain('|')

    // The center of the filled card (row 10, cols 18..32) must be hollow (spaces)
    const centerRow = inner[10]!
    expect(centerRow.slice(18, 32)).toBe(' '.repeat(14))
  })

  it('respects edgeThreshold for low-contrast UI borders', () => {
    // Subtle light-gray box (#e0e0e0 -> lum ~0.878) on white (#ffffff -> lum 1.0)
    const subtle = makeRgba(60, 30, (x, y) =>
      x >= 15 && x < 45 && y >= 8 && y < 22 ? [224, 224, 224, 255] : [255, 255, 255, 255],
    )

    const strict = innerLines(renderRgbaToAscii(subtle, { width: 30, height: 14, mode: 'edge', edgeThreshold: 0.5 })).join('')
    expect(strict.trim()).toBe('')

    const sensitive = innerLines(
      renderRgbaToAscii(subtle, { width: 30, height: 14, mode: 'edge', edgeThreshold: 0.05 }),
    ).join('')
    expect(sensitive).toContain('-')
    expect(sensitive).toContain('|')
  })

  it('stamps Set-of-Marks [eN] overlays onto edge wireframes and works via renderPngToAscii', () => {
    const img = makeRgba(80, 40, (x, y) =>
      x >= 16 && x < 64 && y >= 10 && y < 30 ? [30, 30, 30, 255] : [255, 255, 255, 255],
    )
    const png = encodeRgbaPng(img)
    const out = renderPngToAscii(png, {
      width: 40,
      height: 16,
      mode: 'edge',
      overlays: [
        { ref: 'e3', box: { x: 20, y: 12, width: 20, height: 8 } },
        { ref: 'e12', box: { x: 44, y: 20, width: 16, height: 8 } },
      ],
      viewport: { width: 80, height: 40 },
    })

    expect(/^[\x20-\x7e\n]+$/.test(out)).toBe(true)
    expect(out).toContain('[e3]')
    expect(out).toContain('[e12]')
    expect(out).toContain('-')
    expect(out).toContain('|')
  })
})
