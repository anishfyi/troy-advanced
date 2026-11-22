import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/ascii/png-decoder.js'
import { renderPngToAscii } from '../src/ascii/pixels.js'

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

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

function buildPng(opts: {
  width: number
  height: number
  bitDepth: number
  colorType: number
  scanlines: Buffer
  plte?: Buffer
  trns?: Buffer
}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(opts.width, 0)
  ihdr.writeUInt32BE(opts.height, 4)
  ihdr[8] = opts.bitDepth
  ihdr[9] = opts.colorType
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace none

  const chunks: Buffer[] = [PNG_SIG, pngChunk('IHDR', ihdr)]
  if (opts.plte) chunks.push(pngChunk('PLTE', opts.plte))
  if (opts.trns) chunks.push(pngChunk('tRNS', opts.trns))
  chunks.push(pngChunk('IDAT', deflateSync(opts.scanlines)))
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function pixelAt(rgba: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!]
}

describe('PNG decoder: 16-bit channels, tRNS transparency, and 1/2/4-bit sub-byte depths (M08)', () => {
  describe('16-bit channels (downsampled to 8-bit)', () => {
    it('decodes 16-bit RGBA (colorType 6) including Sub filter with bpp=8', () => {
      // 2x1 16-bit RGBA image, stride = 2 * 8 = 16 bytes
      // Pixel 0: R=0x1234, G=0x5678, B=0x9abc, A=0xdef0
      // Pixel 1: R=0xffff, G=0x0000, B=0x8080, A=0x4000
      const p0 = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]
      const p1 = [0xff, 0xff, 0x00, 0x00, 0x80, 0x80, 0x40, 0x00]
      // Encode with Sub filter (filter=1, bpp=8): raw[x] = (recon[x] - recon[x-8]) & 0xff
      const filteredRow = Buffer.alloc(1 + 16)
      filteredRow[0] = 1 // Sub filter
      for (let i = 0; i < 8; i++) {
        filteredRow[1 + i] = p0[i]!
        filteredRow[1 + 8 + i] = (p1[i]! - p0[i]!) & 0xff
      }

      const png = buildPng({ width: 2, height: 1, bitDepth: 16, colorType: 6, scanlines: filteredRow })
      const decoded = decodePng(png)
      expect(decoded.width).toBe(2)
      expect(decoded.height).toBe(1)
      expect(decoded.bitDepth).toBe(16)
      expect(decoded.colorType).toBe(6)
      expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([0x12, 0x56, 0x9a, 0xde])
      expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([0xff, 0x00, 0x80, 0x40])
    })

    it('decodes 16-bit RGB (colorType 2) with exact 16-bit tRNS matching', () => {
      // 2x1 16-bit RGB:
      // Pixel 0: (0x1001, 0x2002, 0x3003) -> matches tRNS -> alpha = 0
      // Pixel 1: (0x1002, 0x2002, 0x3003) -> same MSB 0x10, different LSB -> opaque (alpha = 255)
      const row = Buffer.from([
        0, // filter None
        0x10, 0x01, 0x20, 0x02, 0x30, 0x03,
        0x10, 0x02, 0x20, 0x02, 0x30, 0x03,
      ])
      const trns = Buffer.from([0x10, 0x01, 0x20, 0x02, 0x30, 0x03])

      const png = buildPng({ width: 2, height: 1, bitDepth: 16, colorType: 2, scanlines: row, trns })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([0x10, 0x20, 0x30, 0])
      expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([0x10, 0x20, 0x30, 255])
    })

    it('decodes 16-bit Grayscale (colorType 0) with tRNS transparency', () => {
      const row = Buffer.from([
        0, // filter None
        0x00, 0x00, // black (matches tRNS)
        0x80, 0x80, // mid-gray
        0xff, 0xff, // white
      ])
      const trns = Buffer.from([0x00, 0x00])

      const png = buildPng({ width: 3, height: 1, bitDepth: 16, colorType: 0, scanlines: row, trns })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 3, 0, 0)).toEqual([0, 0, 0, 0])
      expect(pixelAt(decoded.rgba, 3, 1, 0)).toEqual([128, 128, 128, 255])
      expect(pixelAt(decoded.rgba, 3, 2, 0)).toEqual([255, 255, 255, 255])
    })

    it('decodes 16-bit Grayscale + Alpha (colorType 4)', () => {
      const row = Buffer.from([
        0, // filter None
        0xaa, 0x11, 0x33, 0x99, // gray=0xaa, alpha=0x33
        0x55, 0x00, 0xff, 0xff, // gray=0x55, alpha=0xff
      ])
      const png = buildPng({ width: 2, height: 1, bitDepth: 16, colorType: 4, scanlines: row })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([0xaa, 0xaa, 0xaa, 0x33])
      expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([0x55, 0x55, 0x55, 0xff])
    })
  })

  describe('tRNS transparency chunks (8-bit)', () => {
    it('applies per-entry tRNS alpha for 8-bit Indexed Palette (colorType 3) with default 255 for trailing entries', () => {
      const plte = Buffer.from([
        255, 0, 0, // idx 0: red
        0, 255, 0, // idx 1: green
        0, 0, 255, // idx 2: blue
      ])
      // Only 2 tRNS entries provided; idx 2 must default to 255
      const trns = Buffer.from([0, 128])
      const row = Buffer.from([0, 0, 1, 2])

      const png = buildPng({ width: 3, height: 1, bitDepth: 8, colorType: 3, scanlines: row, plte, trns })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 3, 0, 0)).toEqual([255, 0, 0, 0])
      expect(pixelAt(decoded.rgba, 3, 1, 0)).toEqual([0, 255, 0, 128])
      expect(pixelAt(decoded.rgba, 3, 2, 0)).toEqual([0, 0, 255, 255])
    })

    it('applies tRNS transparent color key for 8-bit RGB (colorType 2)', () => {
      const row = Buffer.from([
        0,
        255, 0, 255, // magenta -> transparent
        10, 20, 30, // opaque
      ])
      const trns = Buffer.from([0, 255, 0, 0, 0, 255])
      const png = buildPng({ width: 2, height: 1, bitDepth: 8, colorType: 2, scanlines: row, trns })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([255, 0, 255, 0])
      expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([10, 20, 30, 255])
    })

    it('applies tRNS transparent level for 8-bit Grayscale (colorType 0)', () => {
      const row = Buffer.from([0, 42, 200])
      const trns = Buffer.from([0, 42])
      const png = buildPng({ width: 2, height: 1, bitDepth: 8, colorType: 0, scanlines: row, trns })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([42, 42, 42, 0])
      expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([200, 200, 200, 255])
    })
  })

  describe('1-, 2-, and 4-bit sub-byte depths', () => {
    it('decodes 1-bit Grayscale (colorType 0) with non-byte-aligned width (5x2) and tRNS', () => {
      // 5 pixels per row -> 1 byte per scanline, MSB-first, low 3 bits are padding
      // Row 0: 1, 0, 1, 0, 1 -> 0b10101_000 = 0xa8
      // Row 1: 0, 1, 1, 0, 0 -> 0b01100_000 = 0x60
      const scanlines = Buffer.from([
        0, 0xa8,
        0, 0x60,
      ])
      const trns = Buffer.from([0x00, 0x00]) // sample 0 is transparent

      const png = buildPng({ width: 5, height: 2, bitDepth: 1, colorType: 0, scanlines, trns })
      const decoded = decodePng(png)
      expect(decoded.bitDepth).toBe(1)
      expect(pixelAt(decoded.rgba, 5, 0, 0)).toEqual([255, 255, 255, 255])
      expect(pixelAt(decoded.rgba, 5, 1, 0)).toEqual([0, 0, 0, 0])
      expect(pixelAt(decoded.rgba, 5, 2, 0)).toEqual([255, 255, 255, 255])
      expect(pixelAt(decoded.rgba, 5, 3, 0)).toEqual([0, 0, 0, 0])
      expect(pixelAt(decoded.rgba, 5, 4, 0)).toEqual([255, 255, 255, 255])

      expect(pixelAt(decoded.rgba, 5, 0, 1)).toEqual([0, 0, 0, 0])
      expect(pixelAt(decoded.rgba, 5, 1, 1)).toEqual([255, 255, 255, 255])
      expect(pixelAt(decoded.rgba, 5, 2, 1)).toEqual([255, 255, 255, 255])
      expect(pixelAt(decoded.rgba, 5, 3, 1)).toEqual([0, 0, 0, 0])
      expect(pixelAt(decoded.rgba, 5, 4, 1)).toEqual([0, 0, 0, 0])
    })

    it('decodes 2-bit Grayscale (colorType 0) scaling 0..3 to 0, 85, 170, 255 with tRNS', () => {
      // 4x1 -> 1 byte: samples [0, 1, 2, 3] = 0b00_01_10_11 = 0x1b
      const scanlines = Buffer.from([0, 0x1b])
      const trns = Buffer.from([0x00, 0x02]) // sample 2 is transparent

      const png = buildPng({ width: 4, height: 1, bitDepth: 2, colorType: 0, scanlines, trns })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 4, 0, 0)).toEqual([0, 0, 0, 255])
      expect(pixelAt(decoded.rgba, 4, 1, 0)).toEqual([85, 85, 85, 255])
      expect(pixelAt(decoded.rgba, 4, 2, 0)).toEqual([170, 170, 170, 0])
      expect(pixelAt(decoded.rgba, 4, 3, 0)).toEqual([255, 255, 255, 255])
    })

    it('decodes 4-bit Grayscale (colorType 0) with odd width (3x2) and Sub scanline filter', () => {
      // 3 pixels at 4-bit = 12 bits -> stride = 2 bytes per row
      // Row 0 (None): samples [0, 8, 15] -> bytes [0x08, 0xf0]
      // Row 1 (Sub, bpp=1): desired bytes [0x12, 0x30] -> raw [0x12, (0x30 - 0x12) & 0xff = 0x1e]
      const scanlines = Buffer.from([
        0, 0x08, 0xf0,
        1, 0x12, 0x1e,
      ])

      const png = buildPng({ width: 3, height: 2, bitDepth: 4, colorType: 0, scanlines })
      const decoded = decodePng(png)
      expect(pixelAt(decoded.rgba, 3, 0, 0)).toEqual([0, 0, 0, 255])
      expect(pixelAt(decoded.rgba, 3, 1, 0)).toEqual([8 * 17, 8 * 17, 8 * 17, 255])
      expect(pixelAt(decoded.rgba, 3, 2, 0)).toEqual([255, 255, 255, 255])

      expect(pixelAt(decoded.rgba, 3, 0, 1)).toEqual([17, 17, 17, 255])
      expect(pixelAt(decoded.rgba, 3, 1, 1)).toEqual([34, 34, 34, 255])
      expect(pixelAt(decoded.rgba, 3, 2, 1)).toEqual([51, 51, 51, 255])
    })

    it('decodes 1-bit, 2-bit, and 4-bit Indexed Palette (colorType 3) with PLTE + tRNS', () => {
      const plte = Buffer.from([
        10, 20, 30, // 0
        40, 50, 60, // 1
        70, 80, 90, // 2
        100, 110, 120, // 3
        130, 140, 150, // 4
        160, 170, 180, // 5
      ])
      const trns = Buffer.from([0, 200, 100])

      // 1-bit indexed (width=3): [1, 0, 1] -> 0b101_00000 = 0xa0
      const png1 = buildPng({ width: 3, height: 1, bitDepth: 1, colorType: 3, scanlines: Buffer.from([0, 0xa0]), plte, trns })
      const d1 = decodePng(png1)
      expect(pixelAt(d1.rgba, 3, 0, 0)).toEqual([40, 50, 60, 200])
      expect(pixelAt(d1.rgba, 3, 1, 0)).toEqual([10, 20, 30, 0])
      expect(pixelAt(d1.rgba, 3, 2, 0)).toEqual([40, 50, 60, 200])

      // 2-bit indexed (width=3): [3, 2, 0] -> 0b11_10_00_00 = 0xe0
      const png2 = buildPng({ width: 3, height: 1, bitDepth: 2, colorType: 3, scanlines: Buffer.from([0, 0xe0]), plte, trns })
      const d2 = decodePng(png2)
      expect(pixelAt(d2.rgba, 3, 0, 0)).toEqual([100, 110, 120, 255]) // idx 3 past tRNS -> 255
      expect(pixelAt(d2.rgba, 3, 1, 0)).toEqual([70, 80, 90, 100])
      expect(pixelAt(d2.rgba, 3, 2, 0)).toEqual([10, 20, 30, 0])

      // 4-bit indexed (width=3): [5, 0, 4] -> [0x50, 0x40]
      const png4 = buildPng({ width: 3, height: 1, bitDepth: 4, colorType: 3, scanlines: Buffer.from([0, 0x50, 0x40]), plte, trns })
      const d4 = decodePng(png4)
      expect(pixelAt(d4.rgba, 3, 0, 0)).toEqual([160, 170, 180, 255])
      expect(pixelAt(d4.rgba, 3, 1, 0)).toEqual([10, 20, 30, 0])
      expect(pixelAt(d4.rgba, 3, 2, 0)).toEqual([130, 140, 150, 255])
    })
  })

  describe('integration & validation', () => {
    it('renders 16-bit and 1-bit PNGs cleanly via renderPngToAscii', () => {
      // 8x4 1-bit checkerboard
      const rows1 = Buffer.from([
        0, 0b10101010,
        0, 0b01010101,
        0, 0b10101010,
        0, 0b01010101,
      ])
      const png1 = buildPng({ width: 8, height: 4, bitDepth: 1, colorType: 0, scanlines: rows1 })
      const ascii1 = renderPngToAscii(png1, { width: 16, height: 8, mode: 'ascii' })
      expect(/^[\x20-\x7e\n]+$/.test(ascii1)).toBe(true)
      expect(ascii1.split('\n').length).toBe(10) // 8 rows + top/bottom border

      // 4x2 16-bit grayscale gradient
      const rows16 = Buffer.from([
        0, 0x00, 0x00, 0x55, 0x55, 0xaa, 0xaa, 0xff, 0xff,
        0, 0x00, 0x00, 0x55, 0x55, 0xaa, 0xaa, 0xff, 0xff,
      ])
      const png16 = buildPng({ width: 4, height: 2, bitDepth: 16, colorType: 0, scanlines: rows16 })
      const ascii16 = renderPngToAscii(png16, { width: 16, height: 8, mode: 'ascii' })
      expect(/^[\x20-\x7e\n]+$/.test(ascii16)).toBe(true)
      expect(ascii16.split('\n').length).toBe(10)
    })

    it('rejects invalid colorType/bitDepth combinations and missing PLTE', () => {
      // Indexed (3) cannot be 16-bit
      const badIndexed = buildPng({
        width: 1,
        height: 1,
        bitDepth: 16,
        colorType: 3,
        scanlines: Buffer.from([0, 0, 0]),
        plte: Buffer.from([0, 0, 0]),
      })
      expect(() => decodePng(badIndexed)).toThrow(/Unsupported PNG bit depth 16 for color type 3/)

      // RGB (2) cannot be 4-bit
      const badRgb = buildPng({
        width: 1,
        height: 1,
        bitDepth: 4,
        colorType: 2,
        scanlines: Buffer.from([0, 0]),
      })
      expect(() => decodePng(badRgb)).toThrow(/Unsupported PNG bit depth 4 for color type 2/)

      // Indexed (3) missing PLTE
      const noPlte = buildPng({
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 3,
        scanlines: Buffer.from([0, 0]),
      })
      expect(() => decodePng(noPlte)).toThrow(/missing PLTE/)

      // Unsupported filter type 5
      const badFilter = buildPng({
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 0,
        scanlines: Buffer.from([5, 0]),
      })
      expect(() => decodePng(badFilter)).toThrow(/Unsupported PNG filter type: 5/)
    })
  })
})
