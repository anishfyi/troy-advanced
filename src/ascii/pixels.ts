// Pixel-to-ASCII / Unicode Braille / ANSI Truecolor Half-Block renderer
// with optional Set-of-Marks [eN] overlay stamped onto the ASCII canvas.
// Allows text-only AI models and SSH terminals to "see" screenshots & canvases.

import type { PixelAsciiOptions, Rect } from '../types.js'
import { decodePng, type DecodedPng } from './png-decoder.js'

const LUMINANCE_RAMP = ' .:-=+*#%@'
const DEFAULT_EDGE_THRESHOLD = 0.18

/**
 * Parse a crop region from either a "x,y,w,h" string or a Rect-like object
 * ({ x, y, width, height } or { x, y, w, h }). Returns undefined if invalid.
 */
export function parseCropRect(input: unknown): Rect | undefined {
  if (input === undefined || input === null || input === '') return undefined

  if (typeof input === 'string') {
    const parts = input.split(',')
    if (parts.length !== 4) return undefined
    const nums = parts.map((p) => {
      const trimmed = p.trim()
      if (!trimmed) return Number.NaN
      return Number(trimmed)
    })
    const [x, y, width, height] = nums as [number, number, number, number]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return undefined
    }
    if (x < 0 || y < 0 || width <= 0 || height <= 0) return undefined
    return { x, y, width, height }
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const x = Number(obj.x)
    const y = Number(obj.y)
    const width = Number(obj.width ?? obj.w)
    const height = Number(obj.height ?? obj.h)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return undefined
    }
    if (x < 0 || y < 0 || width <= 0 || height <= 0) return undefined
    return { x, y, width, height }
  }

  return undefined
}

/**
 * Crop a DecodedPng to the specified region. When `viewport` is supplied,
 * `crop` is interpreted in viewport (CSS pixel) coordinates and scaled to
 * the underlying PNG pixel dimensions (supporting HiDPI screenshots).
 */
export function cropRgba(
  img: DecodedPng,
  crop: Rect,
  viewport?: { width: number; height: number },
): DecodedPng {
  const vpW = viewport && viewport.width > 0 ? viewport.width : img.width
  const vpH = viewport && viewport.height > 0 ? viewport.height : img.height
  const scaleX = img.width / vpW
  const scaleY = img.height / vpH

  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(crop.x * scaleX)))
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(crop.y * scaleY)))
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((crop.x + Math.max(1, crop.width)) * scaleX)))
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((crop.y + Math.max(1, crop.height)) * scaleY)))

  const outW = x1 - x0
  const outH = y1 - y0
  const rgba = new Uint8Array(outW * outH * 4)
  for (let row = 0; row < outH; row++) {
    const srcStart = ((y0 + row) * img.width + x0) * 4
    const srcEnd = srcStart + outW * 4
    rgba.set(img.rgba.subarray(srcStart, srcEnd), row * outW * 4)
  }
  return { width: outW, height: outH, rgba }
}

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

/**
 * Map a Sobel gradient vector (gx, gy) to a directional 7-bit ASCII edge glyph.
 * The edge tangent is perpendicular to the gradient:
 *   - horizontal gradient (0° / 180°) -> vertical edge '|'
 *   - +45° gradient                   -> rising diagonal edge '/'
 *   - vertical gradient (90°)         -> horizontal edge '-'
 *   - +135° gradient                  -> falling diagonal edge '\'
 */
export function sobelEdgeChar(gx: number, gy: number, threshold = DEFAULT_EDGE_THRESHOLD): string {
  const mag = Math.hypot(gx, gy) / 4
  if (mag < threshold) return ' '
  const deg = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180
  if (deg < 22.5 || deg >= 157.5) return '|'
  if (deg < 67.5) return '/'
  if (deg < 112.5) return '-'
  return '\\'
}

function buildLuminanceGrid(img: DecodedPng, cols: number, rows: number): Float32Array {
  const lumGrid = new Float32Array(rows * cols)
  for (let row = 0; row < rows; row++) {
    const y0 = (row / rows) * img.height
    const y1 = ((row + 1) / rows) * img.height
    const stepsY = Math.min(4, Math.max(1, Math.ceil(y1 - y0)))
    for (let col = 0; col < cols; col++) {
      const x0 = (col / cols) * img.width
      const x1 = ((col + 1) / cols) * img.width
      const stepsX = Math.min(4, Math.max(1, Math.ceil(x1 - x0)))
      let sum = 0
      const count = stepsX * stepsY
      for (let sy = 0; sy < stepsY; sy++) {
        const py = y0 + ((sy + 0.5) / stepsY) * (y1 - y0)
        for (let sx = 0; sx < stepsX; sx++) {
          const px = x0 + ((sx + 0.5) / stepsX) * (x1 - x0)
          const [r, g, b, a] = sampleRgba(img, px, py)
          sum += luma(r, g, b, a)
        }
      }
      lumGrid[row * cols + col] = sum / count
    }
  }
  return lumGrid
}

interface MappedOverlay {
  badge: string
  x0: number
  y0: number
  x1: number
  y1: number
  topVisible: boolean
  botVisible: boolean
  leftVisible: boolean
  rightVisible: boolean
  area: number
  isPoint: boolean
}

function stampBadge(grid: string[][], cols: number, row: number, startCol: number, badge: string): void {
  if (row < 0 || row >= grid.length) return
  const clampedStart =
    cols >= badge.length ? Math.max(0, Math.min(cols - badge.length, startCol)) : Math.max(0, startCol)
  for (let i = 0; i < badge.length; i++) {
    const px = clampedStart + i
    if (px >= 0 && px < cols) {
      grid[row]![px] = badge[i]!
    }
  }
}

function stampOverlays(grid: string[][], cols: number, rows: number, img: DecodedPng, options: PixelAsciiOptions): void {
  if (!options.overlays || options.overlays.length === 0) return
  const vpW = Math.max(1, options.viewport?.width || img.width)
  const vpH = Math.max(1, options.viewport?.height || img.height)
  const style = options.overlayStyle ?? 'box'

  if (style === 'badge') {
    for (const overlay of options.overlays) {
      const cx = Math.floor((overlay.box.x / vpW) * cols)
      const cy = Math.floor((overlay.box.y / vpH) * rows)
      if (cy < 0 || cy >= rows) continue
      const badge = `[${overlay.ref.replace(/[^\x20-\x7e]/g, '')}]`
      for (let i = 0; i < badge.length; i++) {
        const px = cx + i
        if (px >= 0 && px < cols) {
          grid[cy]![px] = badge[i]!
        }
      }
    }
    return
  }

  const mapped: MappedOverlay[] = []
  for (const overlay of options.overlays) {
    const { x, y, width, height } = overlay.box
    const safeW = Math.max(0, width)
    const safeH = Math.max(0, height)
    const rawX0 = Math.floor((x / vpW) * cols)
    const rawY0 = Math.floor((y / vpH) * rows)
    const isPoint = safeW === 0 || safeH === 0
    const rawX1 = isPoint ? rawX0 : Math.max(rawX0, Math.ceil(((x + safeW) / vpW) * cols) - 1)
    const rawY1 = isPoint ? rawY0 : Math.max(rawY0, Math.ceil(((y + safeH) / vpH) * rows) - 1)

    if (rawX1 < 0 || rawX0 >= cols || rawY1 < 0 || rawY0 >= rows) continue

    const x0 = Math.max(0, rawX0)
    const x1 = Math.min(cols - 1, rawX1)
    const y0 = Math.max(0, rawY0)
    const y1 = Math.min(rows - 1, rawY1)

    mapped.push({
      badge: `[${overlay.ref.replace(/[^\x20-\x7e]/g, '')}]`,
      x0,
      y0,
      x1,
      y1,
      topVisible: rawY0 >= 0 && rawY0 < rows,
      botVisible: rawY1 >= 0 && rawY1 < rows,
      leftVisible: rawX0 >= 0 && rawX0 < cols,
      rightVisible: rawX1 >= 0 && rawX1 < cols,
      area: (x1 - x0 + 1) * (y1 - y0 + 1),
      isPoint,
    })
  }

  // Larger containers draw first so nested interactive elements sit cleanly on top
  mapped.sort((a, b) => b.area - a.area)

  // Pass 1: Draw wireframe bounding boxes (+, -, |) while preserving box interiors
  for (const m of mapped) {
    if (m.isPoint) continue
    const boxW = m.x1 - m.x0 + 1
    const boxH = m.y1 - m.y0 + 1
    if (boxW < 3) continue

    const hStart = m.leftVisible ? m.x0 + 1 : m.x0
    const hEnd = m.rightVisible ? m.x1 - 1 : m.x1

    if (boxH === 1) {
      if (boxW >= m.badge.length + 2) {
        for (let x = hStart; x <= hEnd; x++) grid[m.y0]![x] = '-'
        if (m.leftVisible) grid[m.y0]![m.x0] = '+'
        if (m.rightVisible) grid[m.y0]![m.x1] = '+'
      }
      continue
    }

    const vStart = m.topVisible ? m.y0 + 1 : m.y0
    const vEnd = m.botVisible ? m.y1 - 1 : m.y1

    if (m.topVisible) {
      for (let x = hStart; x <= hEnd; x++) grid[m.y0]![x] = '-'
      if (m.leftVisible) grid[m.y0]![m.x0] = '+'
      if (m.rightVisible) grid[m.y0]![m.x1] = '+'
    }
    if (m.botVisible) {
      for (let x = hStart; x <= hEnd; x++) grid[m.y1]![x] = '-'
      if (m.leftVisible) grid[m.y1]![m.x0] = '+'
      if (m.rightVisible) grid[m.y1]![m.x1] = '+'
    }
    if (m.leftVisible) {
      for (let y = vStart; y <= vEnd; y++) grid[y]![m.x0] = '|'
    }
    if (m.rightVisible) {
      for (let y = vStart; y <= vEnd; y++) grid[y]![m.x1] = '|'
    }
  }

  // Pass 2: Stamp [eN] badges on top of wireframes so borders never corrupt ref labels
  for (const m of mapped) {
    const boxW = m.x1 - m.x0 + 1
    const innerW = boxW - 2
    if (!m.isPoint && innerW >= m.badge.length) {
      const padLeft = Math.floor((innerW - m.badge.length) / 2)
      stampBadge(grid, cols, m.y0, m.x0 + 1 + padLeft, m.badge)
    } else {
      stampBadge(grid, cols, m.y0, m.x0, m.badge)
    }
  }
}

function frameAsciiGrid(grid: string[][], cols: number): string {
  const border = `+${'-'.repeat(cols)}+`
  return [border, ...grid.map((row) => `|${row.join('')}|`), border].join('\n')
}

export function renderRgbaToAscii(img: DecodedPng, options: PixelAsciiOptions = {}): string {
  let activeImg = img
  let activeOptions = options

  if (options.crop && options.crop.width > 0 && options.crop.height > 0) {
    const vpW = options.viewport && options.viewport.width > 0 ? options.viewport.width : img.width
    const vpH = options.viewport && options.viewport.height > 0 ? options.viewport.height : img.height
    const scaleX = img.width / vpW
    const scaleY = img.height / vpH

    const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(options.crop.x * scaleX)))
    const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(options.crop.y * scaleY)))
    activeImg = cropRgba(img, options.crop, options.viewport)

    const actualX = x0 / scaleX
    const actualY = y0 / scaleY
    const actualW = activeImg.width / scaleX
    const actualH = activeImg.height / scaleY

    activeOptions = {
      ...options,
      crop: undefined,
      viewport: { width: actualW, height: actualH },
      overlays: options.overlays?.map((ov) => ({
        ref: ov.ref,
        box: {
          x: ov.box.x - actualX,
          y: ov.box.y - actualY,
          width: ov.box.width,
          height: ov.box.height,
        },
      })),
    }
  }

  const cols = Math.max(16, Math.min(200, activeOptions.width ?? 80))
  const aspect = activeImg.height / Math.max(1, activeImg.width)
  // Terminal character cells are ~2x taller than wide
  const rows = Math.max(8, Math.min(100, activeOptions.height ?? Math.round(cols * aspect * 0.5)))
  const mode = activeOptions.mode ?? 'ascii'
  const invert = activeOptions.invert ?? false

  if (mode === 'halfblock') {
    const lines: string[] = []
    for (let row = 0; row < rows; row++) {
      let line = ''
      for (let col = 0; col < cols; col++) {
        const sx = (col / cols) * activeImg.width
        const syTop = ((row * 2) / (rows * 2)) * activeImg.height
        const syBot = ((row * 2 + 1) / (rows * 2)) * activeImg.height
        const [r1, g1, b1] = sampleRgba(activeImg, sx, syTop)
        const [r2, g2, b2] = sampleRgba(activeImg, sx, syBot)
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
            const sx = ((col * 2 + dx) / (cols * 2)) * activeImg.width
            const sy = ((row * 4 + dy) / (rows * 4)) * activeImg.height
            const [r, g, b, a] = sampleRgba(activeImg, sx, sy)
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

  if (mode === 'edge') {
    const threshold = activeOptions.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD
    const lumGrid = buildLuminanceGrid(activeImg, cols, rows)
    const sampleLum = (r: number, c: number): number => {
      const cr = Math.max(0, Math.min(rows - 1, r))
      const cc = Math.max(0, Math.min(cols - 1, c))
      return lumGrid[cr * cols + cc] ?? 0
    }

    const grid: string[][] = []
    for (let row = 0; row < rows; row++) {
      const line: string[] = []
      for (let col = 0; col < cols; col++) {
        const tl = sampleLum(row - 1, col - 1)
        const tc = sampleLum(row - 1, col)
        const tr = sampleLum(row - 1, col + 1)
        const ml = sampleLum(row, col - 1)
        const mr = sampleLum(row, col + 1)
        const bl = sampleLum(row + 1, col - 1)
        const bc = sampleLum(row + 1, col)
        const br = sampleLum(row + 1, col + 1)

        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br
        const gy = -tl - 2 * tc - tr + bl + 2 * bc + br
        line.push(sobelEdgeChar(gx, gy, threshold))
      }
      grid.push(line)
    }

    stampOverlays(grid, cols, rows, activeImg, activeOptions)
    return frameAsciiGrid(grid, cols)
  }

  // Strict 7-bit ASCII luminance grid with optional Set-of-Marks [eN] overlays
  const grid: string[][] = []
  for (let row = 0; row < rows; row++) {
    const line: string[] = []
    for (let col = 0; col < cols; col++) {
      const sx = ((col + 0.5) / cols) * activeImg.width
      const sy = ((row + 0.5) / rows) * activeImg.height
      const [r, g, b, a] = sampleRgba(activeImg, sx, sy)
      const lum = luma(r, g, b, a)
      const intensity = invert ? lum : 1 - lum
      const idx = Math.max(0, Math.min(LUMINANCE_RAMP.length - 1, Math.round(intensity * (LUMINANCE_RAMP.length - 1))))
      line.push(LUMINANCE_RAMP[idx]!)
    }
    grid.push(line)
  }

  // Stamp Set-of-Marks [eN] badges directly onto the ASCII grid
  stampOverlays(grid, cols, rows, activeImg, activeOptions)
  return frameAsciiGrid(grid, cols)
}

export function renderPngToAscii(pngBuffer: Buffer, options: PixelAsciiOptions = {}): string {
  const decoded = decodePng(pngBuffer)
  return renderRgbaToAscii(decoded, options)
}
