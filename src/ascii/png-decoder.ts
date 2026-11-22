// Pure-Node.js PNG decoder (IHDR, PLTE, IDAT, IEND) using built-in node:zlib.
// Supports 8-bit Grayscale (0), RGB (2), Indexed Palette (3), Grayscale+Alpha (4), RGBA (6)
// and all 5 PNG scanline filters (None, Sub, Up, Average, Paeth).
// Zero native dependencies — runs cleanly on any EC2 instance (x86_64 or Graviton ARM64).

import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** Tightly packed RGBA bytes, length = width * height * 4 */
  rgba: Uint8Array
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | null = null
  const idatChunks: Buffer[] = []

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) break

    const chunkData = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0)
      height = chunkData.readUInt32BE(4)
      bitDepth = chunkData[8] ?? 0
      colorType = chunkData[9] ?? 0
      interlace = chunkData[12] ?? 0
    } else if (type === 'PLTE') {
      palette = Buffer.from(chunkData)
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData)
    } else if (type === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  if (width <= 0 || height <= 0) throw new Error('PNG missing valid IHDR dimensions')
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth} (expected 8)`)
  if (interlace !== 0) throw new Error('Interlaced Adam7 PNGs are not supported')

  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const bpp = channelsByType[colorType]
  if (!bpp) throw new Error(`Unsupported PNG color type: ${colorType}`)

  const raw = inflateSync(Buffer.concat(idatChunks))
  const stride = width * bpp
  const expected = height * (stride + 1)
  if (raw.length < expected) {
    throw new Error(`Truncated PNG IDAT stream: got ${raw.length}, expected ${expected}`)
  }

  const recon = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const rowIn = y * (stride + 1) + 1
    const rowOut = y * stride
    const prevOut = (y - 1) * stride

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rowIn + x] ?? 0
      const a = x >= bpp ? (recon[rowOut + x - bpp] ?? 0) : 0
      const b = y > 0 ? (recon[prevOut + x] ?? 0) : 0
      const c = x >= bpp && y > 0 ? (recon[prevOut + x - bpp] ?? 0) : 0

      let val = rawByte
      if (filter === 1) val = (rawByte + a) & 0xff
      else if (filter === 2) val = (rawByte + b) & 0xff
      else if (filter === 3) val = (rawByte + ((a + b) >> 1)) & 0xff
      else if (filter === 4) val = (rawByte + paeth(a, b, c)) & 0xff
      recon[rowOut + x] = val
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const dst = i * 4
    if (colorType === 6) {
      rgba[dst] = recon[dst] ?? 0
      rgba[dst + 1] = recon[dst + 1] ?? 0
      rgba[dst + 2] = recon[dst + 2] ?? 0
      rgba[dst + 3] = recon[dst + 3] ?? 255
    } else if (colorType === 2) {
      const src = i * 3
      rgba[dst] = recon[src] ?? 0
      rgba[dst + 1] = recon[src + 1] ?? 0
      rgba[dst + 2] = recon[src + 2] ?? 0
      rgba[dst + 3] = 255
    } else if (colorType === 0) {
      const g = recon[i] ?? 0
      rgba[dst] = g
      rgba[dst + 1] = g
      rgba[dst + 2] = g
      rgba[dst + 3] = 255
    } else if (colorType === 4) {
      const src = i * 2
      const g = recon[src] ?? 0
      rgba[dst] = g
      rgba[dst + 1] = g
      rgba[dst + 2] = g
      rgba[dst + 3] = recon[src + 1] ?? 255
    } else if (colorType === 3 && palette) {
      const idx = (recon[i] ?? 0) * 3
      rgba[dst] = palette[idx] ?? 0
      rgba[dst + 1] = palette[idx + 1] ?? 0
      rgba[dst + 2] = palette[idx + 2] ?? 0
      rgba[dst + 3] = 255
    }
  }

  return { width, height, rgba }
}
