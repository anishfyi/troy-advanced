// Live pixel-preview view mode cycling and framed canvas rendering for the Terminal Browser TUI.
// Cycles: Layout ASCII -> Pixel ASCII -> Braille -> Halfblock -> Layout ASCII (`v` / `V`).
// Uses real Chromium PNG screenshots when available and synthesizes a deterministic wireframe
// raster from the PageSnapshot when running on the zero-Chrome Lite engine.

import { renderRgbaToAscii } from '../ascii/pixels.js'
import { decodePng, type DecodedPng } from '../ascii/png-decoder.js'
import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'
import type { PageSnapshot, Rect, TabSummary } from '../types.js'

export type TuiViewMode = 'layout' | 'pixel-ascii' | 'braille' | 'halfblock'

export type PixelViewMode = Exclude<TuiViewMode, 'layout'>

export type PixelPreviewSource = 'chromium' | 'synthetic'

export const TUI_VIEW_MODES: readonly TuiViewMode[] = [
  'layout',
  'pixel-ascii',
  'braille',
  'halfblock',
] as const

export function cycleViewMode(current: TuiViewMode, delta: 1 | -1 = 1): TuiViewMode {
  const idx = TUI_VIEW_MODES.indexOf(current)
  const base = idx >= 0 ? idx : 0
  const nextIdx = (base + delta + TUI_VIEW_MODES.length) % TUI_VIEW_MODES.length
  return TUI_VIEW_MODES[nextIdx]!
}

export function parseViewMode(raw: string | undefined): TuiViewMode | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'layout' || normalized === 'dom' || normalized === 'text' || normalized === 'off') {
    return 'layout'
  }
  if (normalized === 'pixel-ascii' || normalized === 'pixel' || normalized === 'ascii') {
    return 'pixel-ascii'
  }
  if (normalized === 'braille') {
    return 'braille'
  }
  if (normalized === 'halfblock' || normalized === 'half' || normalized === 'truecolor' || normalized === 'color') {
    return 'halfblock'
  }
  return null
}

export function isPixelViewMode(mode: TuiViewMode): mode is PixelViewMode {
  return mode !== 'layout'
}

export function viewModeToPixelMode(mode: PixelViewMode): 'ascii' | 'braille' | 'halfblock' {
  if (mode === 'pixel-ascii') return 'ascii'
  return mode
}

export function formatViewModeLabel(mode: TuiViewMode): string {
  switch (mode) {
    case 'layout':
      return 'Layout ASCII'
    case 'pixel-ascii':
      return 'Pixel ASCII'
    case 'braille':
      return 'Braille'
    case 'halfblock':
      return 'Halfblock'
  }
}

export function formatViewModeShortTag(mode: TuiViewMode): string {
  switch (mode) {
    case 'layout':
      return 'LAYOUT'
    case 'pixel-ascii':
      return 'PIXEL'
    case 'braille':
      return 'BRAILLE'
    case 'halfblock':
      return 'HALFBLOCK'
  }
}

function fillRect(
  rgba: Uint8Array,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): void {
  const x0 = Math.max(0, Math.min(imgW, Math.floor(x)))
  const y0 = Math.max(0, Math.min(imgH, Math.floor(y)))
  const x1 = Math.max(x0, Math.min(imgW, Math.ceil(x + w)))
  const y1 = Math.max(y0, Math.min(imgH, Math.ceil(y + h)))
  for (let py = y0; py < y1; py++) {
    let idx = (py * imgW + x0) * 4
    for (let px = x0; px < x1; px++) {
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = a
      idx += 4
    }
  }
}

function strokeRect(
  rgba: Uint8Array,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  thickness = 2,
): void {
  if (w <= 0 || h <= 0) return
  fillRect(rgba, imgW, imgH, x, y, w, thickness, r, g, b)
  fillRect(rgba, imgW, imgH, x, y + h - thickness, w, thickness, r, g, b)
  fillRect(rgba, imgW, imgH, x, y, thickness, h, r, g, b)
  fillRect(rgba, imgW, imgH, x + w - thickness, y, thickness, h, r, g, b)
}

export interface SyntheticPreviewData {
  image: DecodedPng
  overlays: Array<{ ref: string; box: Rect }>
  viewport: { width: number; height: number }
}

/**
 * Synthesizes a deterministic RGBA wireframe bitmap from a PageSnapshot so live
 * Pixel ASCII, Braille, and Halfblock previews work even on the zero-Chrome Lite engine.
 */
export function synthesizeSnapshotPreview(
  snapshot: PageSnapshot | undefined,
  width = 320,
  height = 200,
): SyntheticPreviewData {
  const w = Math.max(64, Math.min(640, Math.round(width)))
  const h = Math.max(48, Math.min(480, Math.round(height)))
  const rgba = new Uint8Array(w * h * 4)

  // White page canvas background
  fillRect(rgba, w, h, 0, 0, w, h, 248, 249, 251, 255)

  if (!snapshot) {
    strokeRect(rgba, w, h, 12, 12, w - 24, h - 24, 160, 170, 185, 2)
    fillRect(rgba, w, h, Math.floor(w * 0.25), Math.floor(h * 0.45), Math.floor(w * 0.5), 10, 120, 130, 145)
    return {
      image: { width: w, height: h, rgba },
      overlays: [],
      viewport: { width: w, height: h },
    }
  }

  // Top header accent banner
  const headerH = Math.max(16, Math.round(h * 0.11))
  fillRect(rgba, w, h, 0, 0, w, headerH, 28, 42, 68)
  fillRect(rgba, w, h, 10, Math.floor(headerH * 0.35), Math.min(w - 20, Math.max(40, (snapshot.title?.length ?? 12) * 5)), 5, 230, 238, 250)

  const elementsWithBoxes = snapshot.elements.filter(
    (el) => el.box && el.box.width > 0 && el.box.height > 0,
  )

  if (elementsWithBoxes.length > 0) {
    const vpW = Math.max(1, snapshot.viewport?.width || 1280)
    const vpH = Math.max(1, snapshot.viewport?.height || 800)
    const overlays: Array<{ ref: string; box: Rect }> = []

    // Draw subtle block backgrounds first
    for (const block of snapshot.blocks.slice(0, 32)) {
      if (!block.box || block.box.width <= 0 || block.box.height <= 0) continue
      const bx = (block.box.x / vpW) * w
      const by = (block.box.y / vpH) * h
      const bw = Math.max(4, (block.box.width / vpW) * w)
      const bh = Math.max(3, (block.box.height / vpH) * h)
      if (block.kind === 'heading') {
        fillRect(rgba, w, h, bx, by, bw, bh, 35, 45, 65)
      } else if (block.kind === 'image' || block.kind === 'canvas') {
        fillRect(rgba, w, h, bx, by, bw, bh, 190, 205, 222)
        strokeRect(rgba, w, h, bx, by, bw, bh, 70, 95, 130, 2)
      } else {
        fillRect(rgba, w, h, bx, by, bw, Math.min(bh, 8), 115, 125, 140)
      }
    }

    // Draw interactive elements
    for (const el of elementsWithBoxes.slice(0, 40)) {
      const box = el.box!
      const ex = (box.x / vpW) * w
      const ey = (box.y / vpH) * h
      const ew = Math.max(8, (box.width / vpW) * w)
      const eh = Math.max(6, (box.height / vpH) * h)
      if (el.tag === 'button' || el.type === 'submit') {
        fillRect(rgba, w, h, ex, ey, ew, eh, 38, 128, 86)
        strokeRect(rgba, w, h, ex, ey, ew, eh, 18, 72, 48, 1)
      } else if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') {
        fillRect(rgba, w, h, ex, ey, ew, eh, 255, 255, 255)
        strokeRect(rgba, w, h, ex, ey, ew, eh, 60, 82, 118, 2)
      } else {
        fillRect(rgba, w, h, ex, ey, ew, eh, 46, 102, 204)
      }
      if (el.ref) {
        overlays.push({ ref: el.ref, box })
      }
    }

    return {
      image: { width: w, height: h, rgba },
      overlays,
      viewport: { width: vpW, height: vpH },
    }
  }

  // Flow-based synthetic layout for Lite snapshots without CSS bounding boxes
  const overlays: Array<{ ref: string; box: Rect }> = []
  let cursorY = headerH + 10
  const marginX = 12
  const contentW = w - marginX * 2

  for (const block of snapshot.blocks.slice(0, 24)) {
    if (cursorY >= h - 10) break
    const textLen = Math.max(8, Math.min(60, (block.text ?? '').length))
    const barW = Math.max(24, Math.min(contentW, Math.round((textLen / 60) * contentW)))

    if (block.kind === 'heading') {
      const bh = 12
      fillRect(rgba, w, h, marginX, cursorY, barW, bh, 32, 42, 64)
      cursorY += bh + 6
    } else if (block.kind === 'button') {
      const bw = Math.max(48, Math.min(130, barW))
      const bh = 14
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 38, 128, 86)
      strokeRect(rgba, w, h, marginX, cursorY, bw, bh, 18, 72, 48, 1)
      if (block.ref) {
        overlays.push({ ref: block.ref, box: { x: marginX, y: cursorY, width: bw, height: bh } })
      }
      cursorY += bh + 6
    } else if (block.kind === 'input') {
      const bw = Math.max(80, Math.min(contentW, 180))
      const bh = 14
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 255, 255, 255)
      strokeRect(rgba, w, h, marginX, cursorY, bw, bh, 55, 78, 115, 2)
      if (block.ref) {
        overlays.push({ ref: block.ref, box: { x: marginX, y: cursorY, width: bw, height: bh } })
      }
      cursorY += bh + 6
    } else if (block.kind === 'link') {
      const bw = Math.max(40, Math.min(contentW, barW))
      const bh = 10
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 46, 102, 204)
      if (block.ref) {
        overlays.push({ ref: block.ref, box: { x: marginX, y: cursorY, width: bw, height: bh } })
      }
      cursorY += bh + 5
    } else if (block.kind === 'image' || block.kind === 'canvas') {
      const bw = Math.min(contentW, 140)
      const bh = 28
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 188, 204, 224)
      strokeRect(rgba, w, h, marginX, cursorY, bw, bh, 64, 92, 130, 2)
      cursorY += bh + 6
    } else {
      const bh = 7
      fillRect(rgba, w, h, marginX, cursorY, barW, bh, 108, 118, 134)
      if (block.ref) {
        overlays.push({ ref: block.ref, box: { x: marginX, y: cursorY, width: barW, height: bh } })
      }
      cursorY += bh + 5
    }
  }

  // Ensure remaining interactive refs also appear if blocks didn't include them
  const seenRefs = new Set(overlays.map((o) => o.ref))
  for (const el of snapshot.elements) {
    if (!el.ref || seenRefs.has(el.ref)) continue
    if (cursorY >= h - 10) break
    const bw = Math.min(contentW, 120)
    const bh = 12
    const isBtn = el.tag === 'button' || el.type === 'submit'
    const isInput = el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select'
    if (isBtn) {
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 38, 128, 86)
    } else if (isInput) {
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 255, 255, 255)
      strokeRect(rgba, w, h, marginX, cursorY, bw, bh, 55, 78, 115, 2)
    } else {
      fillRect(rgba, w, h, marginX, cursorY, bw, bh, 46, 102, 204)
    }
    overlays.push({ ref: el.ref, box: { x: marginX, y: cursorY, width: bw, height: bh } })
    seenRefs.add(el.ref)
    cursorY += bh + 5
  }

  return {
    image: { width: w, height: h, rgba },
    overlays,
    viewport: { width: w, height: h },
  }
}

export function synthesizeSnapshotRaster(
  snapshot: PageSnapshot | undefined,
  width = 320,
  height = 200,
): DecodedPng {
  return synthesizeSnapshotPreview(snapshot, width, height).image
}

export interface RenderPixelPreviewFrameOptions {
  snapshot: PageSnapshot | undefined
  pngBuffer?: Buffer | null
  viewMode: PixelViewMode
  width: number
  height: number
  asciiOnly: boolean
  color: boolean
  scrollOffset?: number
  tabs?: TabSummary[]
  activeTabId?: number
  statusMessage?: string
  annotate?: boolean
}

export interface PixelPreviewFrameResult {
  frame: string
  source: PixelPreviewSource
  totalLines: number
  viewportRows: number
  scrollOffset: number
  maxScrollOffset: number
}

function visibleLength(text: string): number {
  return stripAnsi(text).length
}

function truncateVisible(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  const plain = stripAnsi(text)
  if (plain.length <= maxWidth) return plain
  if (maxWidth <= 3) return plain.slice(0, maxWidth)
  return `${plain.slice(0, maxWidth - 3)}...`
}

function padRawCanvasLine(line: string, targetWidth: number): string {
  const vis = visibleLength(line)
  if (vis >= targetWidth) return line
  return line + ' '.repeat(targetWidth - vis)
}

function padChromeLine(text: string, targetWidth: number, asciiOnly: boolean): string {
  const cleaned = asciiOnly ? sanitizeAscii(stripAnsi(text)) : stripAnsi(text)
  const truncated = truncateVisible(cleaned, targetWidth)
  const vis = visibleLength(truncated)
  return vis >= targetWidth ? truncated : truncated + ' '.repeat(targetWidth - vis)
}

function computeSimpleScrollbar(
  viewportRows: number,
  totalLines: number,
  scrollOffset: number,
  asciiOnly: boolean,
): { chars: string[]; percent: number } {
  const maxOffset = Math.max(0, totalLines - viewportRows)
  const percent = maxOffset === 0 ? 100 : Math.round((scrollOffset / maxOffset) * 100)
  const trackChar = asciiOnly ? '|' : '│'
  const thumbChar = asciiOnly ? '#' : '█'
  if (maxOffset === 0 || viewportRows <= 0) {
    return { chars: Array(viewportRows).fill(trackChar), percent }
  }
  const thumbSize = Math.max(1, Math.min(viewportRows, Math.round((viewportRows / Math.max(1, totalLines)) * viewportRows)))
  const maxThumbTop = Math.max(0, viewportRows - thumbSize)
  const thumbTop = Math.round((scrollOffset / maxOffset) * maxThumbTop)
  const chars: string[] = []
  for (let i = 0; i < viewportRows; i++) {
    chars.push(i >= thumbTop && i < thumbTop + thumbSize ? thumbChar : trackChar)
  }
  return { chars, percent }
}

/**
 * Renders a live pixel preview (`pixel-ascii`, `braille`, or `halfblock`) framed
 * inside the standard TROY-ADV TUI chrome so tab bar, URL bar, scrollbar, split-pane
 * inspector, sidebar, and modals compose seamlessly.
 */
export function renderPixelPreviewFrame(opts: RenderPixelPreviewFrameOptions): PixelPreviewFrameResult {
  const width = Math.max(40, Math.min(240, opts.width))
  const height = Math.max(14, Math.min(200, opts.height))
  const asciiOnly = opts.asciiOnly
  const innerWidth = width - 4
  const viewportRows = Math.max(6, height - 6)
  const annotate = opts.annotate ?? true

  const box = asciiOnly
    ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' }

  const topBorder = `${box.tl}${box.h.repeat(width - 2)}${box.tr}`
  const midBorder = `${box.ml}${box.h.repeat(width - 2)}${box.mr}`
  const botBorder = `${box.bl}${box.h.repeat(width - 2)}${box.br}`

  let decodedImg: DecodedPng
  let overlays: Array<{ ref: string; box: Rect }> | undefined
  let viewport: { width: number; height: number } | undefined
  let source: PixelPreviewSource = 'synthetic'

  if (opts.pngBuffer && opts.pngBuffer.length > 0) {
    try {
      decodedImg = decodePng(opts.pngBuffer)
      source = 'chromium'
      viewport = opts.snapshot?.viewport
      if (annotate && opts.snapshot) {
        overlays = opts.snapshot.elements
          .filter((e) => e.ref && e.box && e.box.width > 0 && e.box.height > 0)
          .slice(0, 40)
          .map((e) => ({ ref: e.ref!, box: e.box! }))
      }
    } catch {
      const synth = synthesizeSnapshotPreview(opts.snapshot)
      decodedImg = synth.image
      overlays = annotate ? synth.overlays : undefined
      viewport = synth.viewport
      source = 'synthetic'
    }
  } else {
    const synth = synthesizeSnapshotPreview(opts.snapshot)
    decodedImg = synth.image
    overlays = annotate ? synth.overlays : undefined
    viewport = synth.viewport
    source = 'synthetic'
  }

  const pixelMode = viewModeToPixelMode(opts.viewMode)
  // `pixel-ascii` wraps the grid in a 2-column, 2-row `+---+` border; reserve space so it fits cleanly.
  const canvasCols = pixelMode === 'ascii' ? Math.max(16, innerWidth - 2) : Math.max(16, innerWidth)
  const canvasRows = pixelMode === 'ascii' ? Math.max(8, viewportRows - 2) : Math.max(8, viewportRows)

  const renderedCanvas = renderRgbaToAscii(decodedImg, {
    width: canvasCols,
    height: canvasRows,
    mode: pixelMode,
    overlays: pixelMode === 'ascii' ? overlays : undefined,
    overlayStyle: 'box',
    viewport,
  })

  const bodyLines = renderedCanvas.split('\n')
  const totalLines = bodyLines.length
  const maxScrollOffset = Math.max(0, totalLines - viewportRows)
  const scrollOffset = Math.max(0, Math.min(maxScrollOffset, opts.scrollOffset ?? 0))
  const visible = bodyLines.slice(scrollOffset, scrollOffset + viewportRows)
  const scrollbar = computeSimpleScrollbar(viewportRows, totalLines, scrollOffset, asciiOnly)

  const output: string[] = [topBorder]

  // Tab strip
  const tabs: TabSummary[] =
    opts.tabs && opts.tabs.length > 0
      ? opts.tabs
      : [
          {
            id: opts.snapshot?.tabId ?? 1,
            url: opts.snapshot?.url ?? 'about:blank',
            title: opts.snapshot?.title || opts.snapshot?.url || 'New Tab',
            active: true,
            loading: false,
            engine: source === 'chromium' ? 'chromium' : 'lite',
          },
        ]
  const tabStr = tabs
    .map((t) => {
      const mark = t.id === (opts.activeTabId ?? opts.snapshot?.tabId) || t.active ? '*' : ''
      const label = truncateVisible(
        asciiOnly ? sanitizeAscii(t.title || t.url || 'tab') : stripAnsi(t.title || t.url || 'tab'),
        18,
      )
      return `[${t.id}${mark} ${label}]`
    })
    .join(' ')
  const modeBadge = `[VIEW:${formatViewModeShortTag(opts.viewMode)}]`
  const headerLeft = truncateVisible(`TROY-ADV ${tabStr}`, Math.max(10, innerWidth - modeBadge.length - 1))
  const headerSpacer = Math.max(1, innerWidth - visibleLength(headerLeft) - modeBadge.length)
  output.push(`${box.v} ${padChromeLine(`${headerLeft}${' '.repeat(headerSpacer)}${modeBadge}`, innerWidth, asciiOnly)} ${box.v}`)

  // URL + mode/source bar
  const modeTag = `${formatViewModeLabel(opts.viewMode)} (${source === 'chromium' ? 'live' : 'synthetic'})`
  const rawUrl = opts.snapshot?.url || 'about:blank'
  const urlClean = asciiOnly ? sanitizeAscii(rawUrl) : stripAnsi(rawUrl)
  const urlMax = Math.max(10, innerWidth - modeTag.length - 6)
  const urlLine = `URL: ${truncateVisible(urlClean, urlMax)}`
  const urlSpacer = Math.max(1, innerWidth - visibleLength(urlLine) - modeTag.length)
  output.push(`${box.v} ${padChromeLine(`${urlLine}${' '.repeat(urlSpacer)}${modeTag}`, innerWidth, asciiOnly)} ${box.v}`)
  output.push(midBorder)

  // Viewport body rows (preserve Braille/Halfblock characters and ANSI truecolor sequences)
  for (let i = 0; i < viewportRows; i++) {
    const line = visible[i] ?? ''
    const gutterChar = scrollbar.chars[i] ?? box.v
    output.push(`${box.v} ${padRawCanvasLine(line, innerWidth)} ${gutterChar}`)
  }

  output.push(midBorder)
  const refCount = opts.snapshot?.elements.filter((e) => e.ref).length ?? 0
  const baseStatus = opts.statusMessage
    ? `${opts.statusMessage} | view:${formatViewModeLabel(opts.viewMode)} | src:${source} | refs:${refCount} | v:cycle`
    : `VIEW: ${formatViewModeLabel(opts.viewMode)} (${source}) | refs:${refCount} | v:cycle mode | V:prev | q:quit`
  output.push(`${box.v} ${padChromeLine(baseStatus, innerWidth, asciiOnly)} ${box.v}`)
  output.push(botBorder)

  return {
    frame: output.join('\n'),
    source,
    totalLines,
    viewportRows,
    scrollOffset,
    maxScrollOffset,
  }
}
