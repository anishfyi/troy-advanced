// Pure-Node.js PNG decoder (IHDR, PLTE, tRNS, IDAT, IEND) using built-in node:zlib.
// Supports Grayscale (0), RGB (2), Indexed Palette (3), Grayscale+Alpha (4), RGBA (6)
// across 1/2/4-bit sub-byte depths, 8-bit, and 16-bit channels (downsampled to 8-bit),
// tRNS transparency chunks, and all 5 PNG scanline filters (None, Sub, Up, Average, Paeth).
// Zero native dependencies — runs cleanly on any EC2 instance (x86_64 or Graviton ARM64).

import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** Tightly packed RGBA bytes, length = width * height * 4 */
  rgba: Uint8Array
  /** Source PNG bit depth (1, 2, 4, 8, or 16) */
  bitDepth?: number
  /** Source PNG color type (0, 2, 3, 4, or 6) */
  colorType?: number
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const ALLOWED_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16], // Grayscale
  2: [8, 16], // Truecolour (RGB)
  3: [1, 2, 4, 8], // Indexed-colour (Palette)
  4: [8, 16], // Grayscale + Alpha
  6: [8, 16], // Truecolour + Alpha (RGBA)
}

const CHANNELS_BY_TYPE: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
}

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
  let trns: Buffer | null = null
  const idatChunks: Buffer[] = []

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) break

    const chunkData = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      if (chunkData.length < 13) throw new Error('Invalid PNG IHDR chunk length')
      width = chunkData.readUInt32BE(0)
      height = chunkData.readUInt32BE(4)
      bitDepth = chunkData[8] ?? 0
      colorType = chunkData[9] ?? 0
      interlace = chunkData[12] ?? 0
    } else if (type === 'PLTE') {
      palette = Buffer.from(chunkData)
    } else if (type === 'tRNS') {
      trns = Buffer.from(chunkData)
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData)
    } else if (type === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  if (width <= 0 || height <= 0) throw new Error('PNG missing valid IHDR dimensions')
  const allowedDepths = ALLOWED_BIT_DEPTHS[colorType]
  if (!allowedDepths) throw new Error(`Unsupported PNG color type: ${colorType}`)
  if (!allowedDepths.includes(bitDepth)) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} for color type ${colorType}`)
  }
  if (interlace !== 0) throw new Error('Interlaced Adam7 PNGs are not supported')
  if (colorType === 3 && !palette) {
    throw new Error('PNG color type 3 (indexed) missing PLTE chunk')
  }

  const channels = CHANNELS_BY_TYPE[colorType]!
  const bitsPerPixel = channels * bitDepth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const filterBpp = Math.max(1, Math.ceil(bitsPerPixel / 8))

  const raw = inflateSync(Buffer.concat(idatChunks))
  const expected = height * (stride + 1)
  if (raw.length < expected) {
    throw new Error(`Truncated PNG IDAT stream: got ${raw.length}, expected ${expected}`)
  }

  const recon = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    if (filter > 4) throw new Error(`Unsupported PNG filter type: ${filter}`)
    const rowIn = y * (stride + 1) + 1
    const rowOut = y * stride
    const prevOut = (y - 1) * stride

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rowIn + x] ?? 0
      const a = x >= filterBpp ? (recon[rowOut + x - filterBpp] ?? 0) : 0
      const b = y > 0 ? (recon[prevOut + x] ?? 0) : 0
      const c = x >= filterBpp && y > 0 ? (recon[prevOut + x - filterBpp] ?? 0) : 0

      let val = rawByte
      if (filter === 1) val = (rawByte + a) & 0xff
      else if (filter === 2) val = (rawByte + b) & 0xff
      else if (filter === 3) val = (rawByte + ((a + b) >> 1)) & 0xff
      else if (filter === 4) val = (rawByte + paeth(a, b, c)) & 0xff
      recon[rowOut + x] = val
    }
  }

  // Parse tRNS chunk values according to PNG spec Section 11.3.2.1
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1
  const trnsRgb =
    colorType === 2 && trns && trns.length >= 6
      ? ([trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] as const)
      : null

  const rgba = new Uint8Array(width * height * 4)

  if (bitDepth < 8) {
    // 1-, 2-, or 4-bit sub-byte packed samples (MSB-first within each byte, padded per scanline)
    const mask = (1 << bitDepth) - 1
    const grayScale = bitDepth === 1 ? 255 : bitDepth === 2 ? 85 : 17

    for (let y = 0; y < height; y++) {
      const rowStart = y * stride
      for (let x = 0; x < width; x++) {
        const bitPos = x * bitDepth
        const byteVal = recon[rowStart + (bitPos >> 3)] ?? 0
        const shift = 8 - bitDepth - (bitPos & 7)
        const sample = (byteVal >> shift) & mask
        const dst = (y * width + x) * 4

        if (colorType === 0) {
          const g = sample * grayScale
          rgba[dst] = g
          rgba[dst + 1] = g
          rgba[dst + 2] = g
          rgba[dst + 3] = sample === trnsGray ? 0 : 255
        } else if (colorType === 3 && palette) {
          const pIdx = sample * 3
          rgba[dst] = palette[pIdx] ?? 0
          rgba[dst + 1] = palette[pIdx + 1] ?? 0
          rgba[dst + 2] = palette[pIdx + 2] ?? 0
          rgba[dst + 3] = trns && sample < trns.length ? (trns[sample] ?? 255) : 255
        }
      }
    }
  } else if (bitDepth === 8) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * stride
      for (let x = 0; x < width; x++) {
        const dst = (y * width + x) * 4
        if (colorType === 6) {
          const src = rowStart + x * 4
          rgba[dst] = recon[src] ?? 0
          rgba[dst + 1] = recon[src + 1] ?? 0
          rgba[dst + 2] = recon[src + 2] ?? 0
          rgba[dst + 3] = recon[src + 3] ?? 255
        } else if (colorType === 2) {
          const src = rowStart + x * 3
          const r = recon[src] ?? 0
          const g = recon[src + 1] ?? 0
          const b = recon[src + 2] ?? 0
          rgba[dst] = r
          rgba[dst + 1] = g
          rgba[dst + 2] = b
          rgba[dst + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255
        } else if (colorType === 0) {
          const g = recon[rowStart + x] ?? 0
          rgba[dst] = g
          rgba[dst + 1] = g
          rgba[dst + 2] = g
          rgba[dst + 3] = g === trnsGray ? 0 : 255
        } else if (colorType === 4) {
          const src = rowStart + x * 2
          const g = recon[src] ?? 0
          rgba[dst] = g
          rgba[dst + 1] = g
          rgba[dst + 2] = g
          rgba[dst + 3] = recon[src + 1] ?? 255
        } else if (colorType === 3 && palette) {
          const idx = recon[rowStart + x] ?? 0
          const pIdx = idx * 3
          rgba[dst] = palette[pIdx] ?? 0
          rgba[dst + 1] = palette[pIdx + 1] ?? 0
          rgba[dst + 2] = palette[pIdx + 2] ?? 0
          rgba[dst + 3] = trns && idx < trns.length ? (trns[idx] ?? 255) : 255
        }
      }
    }
  } else {
    // 16-bit big-endian channels downsampled to 8-bit via MSB (sample16 >> 8)
    for (let y = 0; y < height; y++) {
      const rowStart = y * stride
      for (let x = 0; x < width; x++) {
        const dst = (y * width + x) * 4
        if (colorType === 6) {
          const src = rowStart + x * 8
          rgba[dst] = recon[src] ?? 0
          rgba[dst + 1] = recon[src + 2] ?? 0
          rgba[dst + 2] = recon[src + 4] ?? 0
          rgba[dst + 3] = recon[src + 6] ?? 255
        } else if (colorType === 2) {
          const src = rowStart + x * 6
          const rHi = recon[src] ?? 0
          const rLo = recon[src + 1] ?? 0
          const gHi = recon[src + 2] ?? 0
          const gLo = recon[src + 3] ?? 0
          const bHi = recon[src + 4] ?? 0
          const bLo = recon[src + 5] ?? 0
          const r16 = (rHi << 8) | rLo
          const g16 = (gHi << 8) | gLo
          const b16 = (bHi << 8) | bLo
          rgba[dst] = rHi
          rgba[dst + 1] = gHi
          rgba[dst + 2] = bHi
          rgba[dst + 3] = trnsRgb && r16 === trnsRgb[0] && g16 === trnsRgb[1] && b16 === trnsRgb[2] ? 0 : 255
        } else if (colorType === 0) {
          const src = rowStart + x * 2
          const gHi = recon[src] ?? 0
          const gLo = recon[src + 1] ?? 0
          const g16 = (gHi << 8) | gLo
          rgba[dst] = gHi
          rgba[dst + 1] = gHi
          rgba[dst + 2] = gHi
          rgba[dst + 3] = g16 === trnsGray ? 0 : 255
        } else if (colorType === 4) {
          const src = rowStart + x * 4
          const gHi = recon[src] ?? 0
          rgba[dst] = gHi
          rgba[dst + 1] = gHi
          rgba[dst + 2] = gHi
          rgba[dst + 3] = recon[src + 2] ?? 255
        }
      }
    }
  }

  return { width, height, rgba, bitDepth, colorType }
}
