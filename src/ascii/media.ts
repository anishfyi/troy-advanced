// Image & Canvas extraction summary and auto-ASCII preview renderer.
// Extracts dimensions, bounding boxes, and strict 7-bit ASCII previews of <canvas> elements.

import type { ContentBlock, MediaSummaryItem, PageSnapshot, Rect } from '../types.js'
import { renderPngToAscii } from './pixels.js'
import { sanitizeAscii, stripAnsi } from './sanitize.js'

const PNG_DATA_URL_PREFIX = /^data:image\/png;base64,/i

function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 3)}...`
}

export interface CanvasPreviewOptions {
  width?: number
  height?: number
  mode?: 'ascii' | 'edge'
  invert?: boolean
}

export interface MediaSummaryOptions {
  previewWidth?: number
  previewHeight?: number
  includeCanvasPreview?: boolean
}

export interface MediaSummaryRenderOptions extends MediaSummaryOptions {
  width?: number
  asciiOnly?: boolean
}

/**
 * Decode a `data:image/png;base64,...` URL into a raw PNG Buffer.
 * Returns null if the string is not a valid base64 PNG data URL.
 */
export function decodeCanvasDataUrl(dataUrl: string | undefined): Buffer | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null
  if (!PNG_DATA_URL_PREFIX.test(dataUrl)) return null
  const b64 = dataUrl.replace(PNG_DATA_URL_PREFIX, '').trim()
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    // Must start with the 8-byte PNG signature
    if (
      buf.length < 24 ||
      buf[0] !== 0x89 ||
      buf[1] !== 0x50 ||
      buf[2] !== 0x4e ||
      buf[3] !== 0x47
    ) {
      return null
    }
    return buf
  } catch {
    return null
  }
}

/**
 * Convert a `<canvas>` PNG data URL into a compact, strict 7-bit ASCII preview.
 * Returns null if decoding fails or the data URL is invalid.
 */
export function renderCanvasPreviewAscii(
  dataUrl: string | undefined,
  options: CanvasPreviewOptions = {},
): string | null {
  const png = decodeCanvasDataUrl(dataUrl)
  if (!png) return null
  const width = Math.max(16, Math.min(80, options.width ?? 36))
  const height = options.height !== undefined ? Math.max(8, Math.min(32, options.height)) : 10
  try {
    return renderPngToAscii(png, {
      width,
      height,
      mode: options.mode ?? 'ascii',
      invert: options.invert,
    })
  } catch {
    return null
  }
}

/**
 * Format concise dimensions and bounding box metadata for an image or canvas.
 * Examples:
 *   "640x360 @(20,80)"
 *   "320x180 (natural 640x360) @(20,80)"
 *   "400x200"
 */
export function formatMediaMeta(item: {
  width?: number
  height?: number
  naturalWidth?: number
  naturalHeight?: number
  box?: Rect
}): string {
  const parts: string[] = []
  const boxW = item.box && item.box.width > 0 ? Math.round(item.box.width) : undefined
  const boxH = item.box && item.box.height > 0 ? Math.round(item.box.height) : undefined
  const w = boxW ?? (item.width && item.width > 0 ? Math.round(item.width) : item.naturalWidth)
  const h = boxH ?? (item.height && item.height > 0 ? Math.round(item.height) : item.naturalHeight)

  if (w && h) {
    parts.push(`${w}x${h}`)
    if (
      item.naturalWidth &&
      item.naturalHeight &&
      (Math.round(item.naturalWidth) !== w || Math.round(item.naturalHeight) !== h)
    ) {
      parts.push(`(natural ${Math.round(item.naturalWidth)}x${Math.round(item.naturalHeight)})`)
    }
  } else if (item.naturalWidth && item.naturalHeight) {
    parts.push(`${Math.round(item.naturalWidth)}x${Math.round(item.naturalHeight)}`)
  }

  if (item.box) {
    parts.push(`@(${Math.round(item.box.x)},${Math.round(item.box.y)})`)
  }

  return parts.join(' ')
}

export function resolveBlockCanvasPreview(
  block: ContentBlock,
  options: CanvasPreviewOptions = {},
): string | undefined {
  if (block.kind !== 'canvas') return undefined
  if (block.asciiPreview) return block.asciiPreview
  if (block.canvasDataUrl) {
    return renderCanvasPreviewAscii(block.canvasDataUrl, options) ?? undefined
  }
  return undefined
}

/**
 * Extract structured Image and Canvas metadata (dimensions, bounding boxes, src,
 * and auto-ASCII previews for `<canvas>` elements) from a PageSnapshot.
 */
export function extractMediaSummary(
  snapshot: PageSnapshot,
  options: MediaSummaryOptions = {},
): MediaSummaryItem[] {
  const includePreview = options.includeCanvasPreview ?? true
  const items: MediaSummaryItem[] = []

  for (const block of snapshot.blocks) {
    if (block.kind !== 'image' && block.kind !== 'canvas') continue
    const label = (block.alt || block.text || (block.kind === 'canvas' ? 'canvas' : 'image')).trim()
    const width = block.box && block.box.width > 0 ? Math.round(block.box.width) : block.naturalWidth
    const height = block.box && block.box.height > 0 ? Math.round(block.box.height) : block.naturalHeight

    let asciiPreview: string | undefined
    if (block.kind === 'canvas' && includePreview) {
      asciiPreview = resolveBlockCanvasPreview(block, {
        width: options.previewWidth,
        height: options.previewHeight,
      })
    }

    items.push({
      kind: block.kind,
      label,
      tag: block.tag || (block.kind === 'canvas' ? 'canvas' : 'img'),
      ...(block.src ? { src: block.src } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(block.naturalWidth ? { naturalWidth: block.naturalWidth } : {}),
      ...(block.naturalHeight ? { naturalHeight: block.naturalHeight } : {}),
      ...(block.box ? { box: block.box } : {}),
      ...(asciiPreview ? { asciiPreview } : {}),
    })
  }

  return items
}

/**
 * Render an ASCII extraction summary of all `<img>` and `<canvas>` elements
 * showing dimensions, bounding boxes, sources, and auto-ASCII `<canvas>` previews.
 * Returns an empty string if the snapshot contains no images or canvases.
 */
export function renderMediaSummaryAscii(
  snapshot: PageSnapshot,
  options: MediaSummaryRenderOptions = {},
): string {
  const asciiOnly = options.asciiOnly ?? true
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s))
  const maxWidth = Math.max(40, Math.min(200, options.width ?? 96))
  const previewWidth = options.previewWidth ?? Math.max(16, Math.min(44, maxWidth - 8))
  const previewHeight = options.previewHeight ?? 10

  const items = extractMediaSummary(snapshot, {
    previewWidth,
    previewHeight,
    includeCanvasPreview: options.includeCanvasPreview ?? true,
  })

  if (items.length === 0) return ''

  const imgCount = items.filter((i) => i.kind === 'image').length
  const canvasCount = items.filter((i) => i.kind === 'canvas').length
  const counts: string[] = []
  if (imgCount > 0) counts.push(`${imgCount} img`)
  if (canvasCount > 0) counts.push(`${canvasCount} canvas`)

  const lines: string[] = [`MEDIA SUMMARY (${items.length} ${items.length === 1 ? 'item' : 'items'}: ${counts.join(', ')}):`]

  items.forEach((item, idx) => {
    const tagBadge = item.kind === 'canvas' ? '[CANVAS]' : '[IMG]'
    const meta = formatMediaMeta(item)
    const labelStr = clean(item.label)
    const srcPart = item.src ? ` src=${clean(item.src)}` : ''
    const header = `  ${idx + 1}. ${tagBadge} "${labelStr}"${meta ? ` ${meta}` : ''}${srcPart}`
    lines.push(truncate(header, maxWidth))

    if (item.asciiPreview) {
      const previewLines = item.asciiPreview.split('\n')
      for (const pl of previewLines) {
        lines.push(truncate(`     ${clean(pl)}`, maxWidth))
      }
    }
  })

  return lines.join('\n')
}
