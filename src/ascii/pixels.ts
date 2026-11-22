// Pixel-to-ASCII / Unicode Braille / ANSI Truecolor Half-Block renderer
// with optional Set-of-Marks [eN] overlay stamped onto the ASCII canvas.
// Allows text-only AI models and SSH terminals to "see" screenshots & canvases.

import type { PixelAsciiOptions } from '../types.js'
import { decodePng, type DecodedPng } from './png-decoder.js'

const LUMINANCE_RAMP = ' .:-=+*#%@'

function sampleRgba(img: DecodedPng, x: number, y: number): [number, number, number, number] {
  const cx = Math.max(0, Math.min(img.width - 1, Math.floor(x)))
  const cy = Math.max(0, Math.min(img.height - 1, Math.floor(y)))
  const idx = (cy * img.width + cx) * 4
  return [img.rgba[idx] ?? 0, img.rgba[idx + 1] ?? 0, img.rgba[idx + 2] ?? 0, img.rgba[idx + 3] ?? 255]
}

function luma(r: number, g: number, b: number, a: number): number {
  const alpha = a / 255
  // Blend over white background (web pages default to white)
  const rr = r * alpha + 255 * (1 - alpha)
  const gg = g * alpha + 255 * (1 - alpha)
  const bb = b * alpha + 255 * (1 - alpha)
  return (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255
}

export function renderRgbaToAscii(img: DecodedPng, options: PixelAsciiOptions = {}): string {
  const cols = Math.max(16, Math.min(200, options.width ?? 80))
  const aspect = img.height / Math.max(1, img.width)
  // Terminal character cells are ~2x taller than wide
  const rows = Math.max(8, Math.min(100, options.height ?? Math.round(cols * aspect * 0.5)))
  const mode = options.mode ?? 'ascii'
  const invert = options.invert ?? false

  if (mode === 'halfblock') {
    const lines: string[] = []
    for (let row = 0; row < rows; row++) {
      let line = ''
      for (let col = 0; col < cols; col++) {
        const sx = (col / cols) * img.width
        const syTop = ((row * 2) / (rows * 2)) * img.height
        const syBot = ((row * 2 + 1) / (rows * 2)) * img.height
        const [r1, g1, b1] = sampleRgba(img, sx, syTop)
        const [r2, g2, b2] = sampleRgba(img, sx, syBot)
        line += `\x1b[38;2;${r1};${g1};${b1}m\x1b[48;2;${r2};${g2};${b2}m▀`
      }
      lines.push(`${line}\x1b[0m`)
    }
    return lines.join('\n')
  }

  if (mode === 'braille') {
    const dotBits = [
      [0x01, 0x08],
      [0x02, 0x10],
      [0x04, 0x20],
      [0x40, 0x80],
    ]
    const lines: string[] = []
    for (let row = 0; row < rows; row++) {
      let line = ''
      for (let col = 0; col < cols; col++) {
        let bits = 0
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = ((col * 2 + dx) / (cols * 2)) * img.width
            const sy = ((row * 4 + dy) / (rows * 4)) * img.height
            const [r, g, b, a] = sampleRgba(img, sx, sy)
            const lum = luma(r, g, b, a)
            const lit = invert ? lum > 0.55 : lum < 0.55
            if (lit) bits |= dotBits[dy]![dx]!
          }
        }
        line += String.fromCharCode(0x2800 + bits)
      }
      lines.push(line)
    }
    return lines.join('\n')
  }

  // Strict 7-bit ASCII luminance grid with optional Set-of-Marks [eN] overlays
  const grid: string[][] = []
  for (let row = 0; row < rows; row++) {
    const line: string[] = []
    for (let col = 0; col < cols; col++) {
      const sx = ((col + 0.5) / cols) * img.width
      const sy = ((row + 0.5) / rows) * img.height
      const [r, g, b, a] = sampleRgba(img, sx, sy)
      const lum = luma(r, g, b, a)
      const intensity = invert ? lum : 1 - lum
      const idx = Math.max(0, Math.min(LUMINANCE_RAMP.length - 1, Math.round(intensity * (LUMINANCE_RAMP.length - 1))))
      line.push(LUMINANCE_RAMP[idx]!)
    }
    grid.push(line)
  }

  // Stamp Set-of-Marks [eN] badges directly onto the ASCII grid
  if (options.overlays && options.overlays.length > 0) {
    const vpW = options.viewport?.width || img.width
    const vpH = options.viewport?.height || img.height
    for (const overlay of options.overlays) {
      const cx = Math.floor((overlay.box.x / Math.max(1, vpW)) * cols)
      const cy = Math.floor((overlay.box.y / Math.max(1, vpH)) * rows)
      if (cy < 0 || cy >= rows) continue
      const badge = `[${overlay.ref}]`
      for (let i = 0; i < badge.length; i++) {
        const px = cx + i
        if (px >= 0 && px < cols) {
          grid[cy]![px] = badge[i]!
        }
      }
    }
  }

  const border = `+${'-'.repeat(cols)}+`
  return [border, ...grid.map((row) => `|${row.join('')}|`), border].join('\n')
}

export function renderPngToAscii(pngBuffer: Buffer, options: PixelAsciiOptions = {}): string {
  const decoded = decodePng(pngBuffer)
  return renderRgbaToAscii(decoded, options)
}
