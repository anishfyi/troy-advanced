// Spatial DOM-to-ASCII and ANSI viewport renderer.
// Designed so both AI agents (even in strict 7-bit ASCII mode) and humans over SSH/EC2
// can inspect and drive any live web page directly inside a terminal.

import type { AsciiLayoutMode, AsciiRenderOptions, ContentBlock, InlineLink, PageSnapshot, Rect } from '../types.js'

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  inverse: '\x1b[7m',
}

export function sanitizeAscii(input: string): string {
  return input
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function visibleLength(s: string): number {
  return stripAnsi(s).length
}

function truncateVisible(text: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 3)}...`
}

function wrapText(text: string, maxWidth: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (maxWidth <= 8) return [clean.slice(0, maxWidth)]
  const words = clean.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      if (word.length <= maxWidth) {
        current = word
      } else {
        for (let i = 0; i < word.length; i += maxWidth) {
          lines.push(word.slice(i, i + maxWidth))
        }
      }
    } else if (current.length + 1 + word.length <= maxWidth) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      if (word.length <= maxWidth) {
        current = word
      } else {
        for (let i = 0; i < word.length; i += maxWidth) {
          const slice = word.slice(i, i + maxWidth)
          if (slice.length === maxWidth) lines.push(slice)
          else current = slice
        }
        if (word.length % maxWidth === 0) current = ''
      }
    }
  }
  if (current) lines.push(current)
  return lines
}

type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; ref?: string }

/**
 * Wraps paragraph text with inline `[eN: link text]` (or `[link text]`) tokens
 * so links flow inline inside the paragraph without forcing line breaks.
 * Keeps each inline link token (and immediately trailing punctuation) together
 * on a line whenever it fits within `maxWidth`.
 */
export function wrapInlineParagraph(
  text: string,
  links: InlineLink[] | undefined,
  maxWidth: number,
  options: { asciiOnly?: boolean; color?: boolean; showRefs?: boolean } = {},
): string[] {
  const asciiOnly = options.asciiOnly ?? true
  const color = asciiOnly ? false : (options.color ?? false)
  const showRefs = options.showRefs ?? true
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : s)

  if (!links || links.length === 0) {
    return wrapText(clean(text), maxWidth)
  }

  const segments: InlineSegment[] = []
  const unmatched: InlineLink[] = []
  let cursor = 0

  for (const link of links) {
    const rawLabel = link.text || link.href || ''
    if (!rawLabel) continue

    let idx = -1
    let endIdx = -1

    if (
      link.start !== undefined &&
      link.end !== undefined &&
      link.start >= cursor &&
      link.end <= text.length &&
      link.end > link.start
    ) {
      idx = link.start
      endIdx = link.end
    } else {
      const exactIdx = text.indexOf(rawLabel, cursor)
      if (exactIdx !== -1) {
        idx = exactIdx
        endIdx = exactIdx + rawLabel.length
      } else {
        const lowerIdx = text.toLowerCase().indexOf(rawLabel.toLowerCase(), cursor)
        if (lowerIdx !== -1) {
          idx = lowerIdx
          endIdx = lowerIdx + rawLabel.length
        }
      }
    }

    if (idx !== -1 && endIdx > idx) {
      if (idx > cursor) {
        segments.push({ type: 'text', text: text.slice(cursor, idx) })
      }
      segments.push({ type: 'link', text: rawLabel, ref: link.ref })
      cursor = endIdx
    } else {
      unmatched.push(link)
    }
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) })
  }
  for (const link of unmatched) {
    const rawLabel = link.text || link.href || ''
    if (!rawLabel) continue
    if (segments.length > 0) segments.push({ type: 'text', text: ' ' })
    segments.push({ type: 'link', text: rawLabel, ref: link.ref })
  }

  const tokens: Array<{ plain: string; rendered: string; isLink: boolean }> = []
  let startNewToken = true

  for (const seg of segments) {
    if (seg.type === 'text') {
      const normalized = clean(seg.text).replace(/\s+/g, ' ')
      if (!normalized) continue
      const parts = normalized.split(' ')
      for (let p = 0; p < parts.length; p++) {
        const word = parts[p]!
        if (word.length > 0) {
          if (startNewToken || tokens.length === 0) {
            tokens.push({ plain: word, rendered: word, isLink: false })
          } else {
            const last = tokens[tokens.length - 1]!
            last.plain += word
            last.rendered += word
          }
          startNewToken = false
        }
        if (p < parts.length - 1) {
          startNewToken = true
        }
      }
    } else {
      const label = clean(seg.text).replace(/\s+/g, ' ').trim()
      if (!label) continue
      const plainBadge = showRefs && seg.ref ? `[${seg.ref}: ${label}]` : `[${label}]`
      const renderedBadge = color
        ? showRefs && seg.ref
          ? `${ANSI.cyan}[${ANSI.yellow}${seg.ref}${ANSI.cyan}: ${label}]${ANSI.reset}`
          : `${ANSI.cyan}[${label}]${ANSI.reset}`
        : plainBadge
      if (startNewToken || tokens.length === 0) {
        tokens.push({ plain: plainBadge, rendered: renderedBadge, isLink: true })
      } else {
        const last = tokens[tokens.length - 1]!
        last.plain += plainBadge
        last.rendered += renderedBadge
        last.isLink = true
      }
      startNewToken = false
    }
  }

  if (tokens.length === 0) return []
  if (maxWidth <= 8) {
    const joined = tokens.map((t) => t.plain).join(' ')
    return [joined.slice(0, maxWidth)]
  }

  const lines: string[] = []
  let currentPlainLen = 0
  let currentRendered = ''

  for (const token of tokens) {
    const tokLen = token.plain.length
    if (tokLen <= maxWidth) {
      if (currentPlainLen === 0) {
        currentPlainLen = tokLen
        currentRendered = token.rendered
      } else if (currentPlainLen + 1 + tokLen <= maxWidth) {
        currentPlainLen += 1 + tokLen
        currentRendered = `${currentRendered} ${token.rendered}`
      } else {
        lines.push(currentRendered)
        currentPlainLen = tokLen
        currentRendered = token.rendered
      }
    } else {
      if (currentPlainLen > 0) {
        lines.push(currentRendered)
        currentPlainLen = 0
        currentRendered = ''
      }
      const wrappedParts = wrapText(token.plain, maxWidth)
      for (let i = 0; i < wrappedParts.length; i++) {
        const part = wrappedParts[i]!
        const styledPart = color && token.isLink ? `${ANSI.cyan}${part}${ANSI.reset}` : part
        if (i < wrappedParts.length - 1) {
          lines.push(styledPart)
        } else {
          currentPlainLen = part.length
          currentRendered = styledPart
        }
      }
    }
  }

  if (currentPlainLen > 0) {
    lines.push(currentRendered)
  }

  return lines
}

function wrapCellText(text: string, width: number, maxLines = 3): string[] {
  if (width <= 0) return ['']
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return ['']
  if (clean.length <= width) return [clean]

  const words = clean.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (!current) {
      if (word.length <= width) {
        current = word
      } else {
        for (let i = 0; i < word.length; i += width) {
          const slice = word.slice(i, i + width)
          if (slice.length === width && i + width < word.length) {
            lines.push(slice)
          } else {
            current = slice
          }
        }
      }
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = ''
      if (word.length <= width) {
        current = word
      } else {
        for (let i = 0; i < word.length; i += width) {
          const slice = word.slice(i, i + width)
          if (slice.length === width && i + width < word.length) {
            lines.push(slice)
          } else {
            current = slice
          }
        }
      }
    }
  }
  if (current) lines.push(current)

  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const overflow = lines.slice(maxLines - 1).join(' ')
  kept[maxLines - 1] = truncateVisible(overflow, width)
  return kept
}

/**
 * Renders a sequence of `table-row` blocks as an auto-aligned ASCII (or Unicode)
 * table with `+---+---+` borders and `+===+===+` header separator rows.
 */
export function renderAsciiTable(
  rows: ContentBlock[],
  maxWidth: number,
  options: { asciiOnly?: boolean; color?: boolean } = {},
): string[] {
  if (rows.length === 0 || maxWidth <= 0) return []
  const asciiOnly = options.asciiOnly ?? true
  const color = asciiOnly ? false : (options.color ?? false)
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : s).replace(/\s+/g, ' ').trim()

  const normalized = rows.map((row) => ({
    cells: (row.cells && row.cells.length > 0 ? row.cells : [row.text]).map(clean),
    isHeader: Boolean(row.isHeader),
  }))

  const colCount = Math.max(0, ...normalized.map((r) => r.cells.length))
  if (colCount === 0) return []

  for (const r of normalized) {
    while (r.cells.length < colCount) r.cells.push('')
  }

  // Border overhead: "| " + " | " * (colCount - 1) + " |" = 3 * colCount + 1
  const borderOverhead = 3 * colCount + 1
  const available = maxWidth - borderOverhead

  if (available < colCount) {
    const sep = asciiOnly ? ' | ' : ' │ '
    return normalized.map((r) => truncateVisible(r.cells.join(sep), maxWidth))
  }

  const naturalWidths = new Array<number>(colCount).fill(1)
  for (const r of normalized) {
    for (let c = 0; c < colCount; c++) {
      naturalWidths[c] = Math.max(naturalWidths[c]!, r.cells[c]!.length)
    }
  }

  const widths = [...naturalWidths]
  let total = widths.reduce((sum, w) => sum + w, 0)
  while (total > available) {
    // Shrink widest column first so narrow columns (IDs, status, numbers) stay intact
    let widestIdx = -1
    let widestVal = 1
    for (let c = 0; c < colCount; c++) {
      if (widths[c]! > widestVal) {
        widestVal = widths[c]!
        widestIdx = c
      }
    }
    if (widestIdx === -1) break
    widths[widestIdx] = widths[widestIdx]! - 1
    total--
  }

  const chars = asciiOnly
    ? {
        tl: '+',
        tm: '+',
        tr: '+',
        hl: '+',
        hm: '+',
        hr: '+',
        bl: '+',
        bm: '+',
        br: '+',
        h: '-',
        hh: '=',
        v: '|',
      }
    : {
        tl: '┌',
        tm: '┬',
        tr: '┐',
        hl: '╞',
        hm: '╪',
        hr: '╡',
        bl: '└',
        bm: '┴',
        br: '┘',
        h: '─',
        hh: '═',
        v: '│',
      }

  const makeRule = (left: string, mid: string, right: string, fill: string) =>
    `${left}${widths.map((w) => fill.repeat(w + 2)).join(mid)}${right}`

  const topRule = makeRule(chars.tl, chars.tm, chars.tr, chars.h)
  const headerRule = makeRule(chars.hl, chars.hm, chars.hr, chars.hh)
  const bottomRule = makeRule(chars.bl, chars.bm, chars.br, chars.h)

  const lines: string[] = [topRule]

  for (let rowIdx = 0; rowIdx < normalized.length; rowIdx++) {
    const row = normalized[rowIdx]!
    const wrappedCells = row.cells.map((cell, c) => wrapCellText(cell, widths[c]!, 3))
    const rowHeight = Math.max(1, ...wrappedCells.map((wc) => wc.length))

    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
      const renderedCells = widths.map((w, c) => {
        const chunk = (wrappedCells[c]![lineIdx] ?? '').padEnd(w, ' ')
        return row.isHeader && color ? `${ANSI.bold}${chunk}${ANSI.reset}` : chunk
      })
      lines.push(`${chars.v} ${renderedCells.join(` ${chars.v} `)} ${chars.v}`)
    }

    const nextRow = normalized[rowIdx + 1]
    if (row.isHeader && nextRow && !nextRow.isHeader) {
      lines.push(headerRule)
    }
  }

  lines.push(bottomRule)
  return lines
}

function renderFlowBlocks(
  blocks: ContentBlock[],
  innerWidth: number,
  asciiOnly: boolean,
  color: boolean,
  showRefs: boolean,
  addSpacing: boolean,
): string[] {
  const lines: string[] = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]!
    if (block.kind === 'table-row') {
      const tableRows: ContentBlock[] = []
      while (i < blocks.length && blocks[i]!.kind === 'table-row') {
        tableRows.push(blocks[i]!)
        i++
      }
      const rendered = renderAsciiTable(tableRows, innerWidth, { asciiOnly, color })
      if (rendered.length > 0) {
        lines.push(...rendered)
        if (addSpacing) lines.push('')
      }
      continue
    }
    const rendered = formatBlock(block, innerWidth, asciiOnly, color, showRefs)
    if (rendered.length > 0) {
      lines.push(...rendered)
      if (addSpacing && (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'code')) {
        lines.push('')
      }
    }
    i++
  }
  return lines
}

function padLine(line: string, width: number, asciiOnly: boolean): string {
  const cleaned = asciiOnly ? sanitizeAscii(stripAnsi(line)) : line
  const vLen = visibleLength(cleaned)
  if (vLen === width) return cleaned
  if (vLen < width) return cleaned + ' '.repeat(width - vLen)
  // Truncate cleanly when exceeding width
  const plain = stripAnsi(cleaned)
  return truncateVisible(asciiOnly ? sanitizeAscii(plain) : plain, width)
}

function formatBlock(block: ContentBlock, innerWidth: number, asciiOnly: boolean, color: boolean, showRefs: boolean): string[] {
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : s)
  const refBadge = (ref?: string) => {
    if (!showRefs || !ref) return ''
    return color ? `${ANSI.yellow}[${ref}]${ANSI.reset} ` : `[${ref}] `
  }

  switch (block.kind) {
    case 'heading': {
      const level = Math.max(1, Math.min(6, block.level ?? 1))
      const text = clean(block.text)
      if (level === 1) {
        const prefix = color ? ANSI.bold + ANSI.cyan : ''
        const suffix = color ? ANSI.reset : ''
        const bar = (asciiOnly ? '=' : '━').repeat(Math.min(innerWidth, Math.max(8, text.length + 2)))
        return [
          ...wrapText(text.toUpperCase(), innerWidth).map((l) => `${prefix}${l}${suffix}`),
          bar,
        ]
      }
      const hashes = '#'.repeat(level)
      const prefix = color ? ANSI.bold : ''
      const suffix = color ? ANSI.reset : ''
      return wrapText(`${hashes} ${text}`, innerWidth).map((l) => `${prefix}${l}${suffix}`)
    }

    case 'paragraph': {
      return wrapInlineParagraph(block.text, block.links, innerWidth, { asciiOnly, color, showRefs })
    }

    case 'link': {
      const label = clean(block.text || block.href || 'link')
      const arrow = asciiOnly ? '->' : '→'
      const badge = refBadge(block.ref)
      const formatted = color
        ? `${badge}${ANSI.cyan}${label} ${arrow}${ANSI.reset}`
        : `${badge}[${label} ${arrow}]`
      return [formatted]
    }

    case 'button': {
      const label = clean(block.text || 'Button')
      const badge = refBadge(block.ref)
      const formatted = color
        ? `${badge}${ANSI.green}< ${label} >${ANSI.reset}`
        : `${badge}< ${label} >`
      return [formatted]
    }

    case 'input': {
      const label = clean(block.text || block.placeholder || 'input')
      const val = block.value ? clean(block.value) : ''
      const badge = refBadge(block.ref)
      if (block.tag === 'checkbox' || block.tag === 'radio') {
        const mark = block.checked ? 'x' : ' '
        const box = block.tag === 'radio' ? `(${mark})` : `[${mark}]`
        return [`${badge}${box} ${label}`]
      }
      const fieldWidth = Math.max(4, Math.min(36, innerWidth - label.length - 10))
      const displayVal = val ? truncateVisible(val, fieldWidth) : '_'.repeat(Math.min(16, fieldWidth))
      const field = color
        ? `${ANSI.magenta}[${displayVal.padEnd(Math.min(16, fieldWidth), ' ')}]${ANSI.reset}`
        : `[${displayVal.padEnd(Math.min(16, fieldWidth), ' ')}]`
      return [`${badge}${label}: ${field}`]
    }

    case 'select': {
      const label = clean(block.text || 'select')
      const val = clean(block.value || 'choose...')
      const badge = refBadge(block.ref)
      const caret = asciiOnly ? 'v' : '▾'
      return [`${badge}${label}: [ ${val} ${caret} ]`]
    }

    case 'list-item': {
      const bullet = asciiOnly ? '* ' : '• '
      const lines = wrapInlineParagraph(block.text, block.links, Math.max(10, innerWidth - 2), {
        asciiOnly,
        color,
        showRefs,
      })
      return lines.map((l, idx) => `${idx === 0 ? bullet : '  '}${l}`)
    }

    case 'code': {
      const rawLines = clean(block.text).split('\n').slice(0, 12)
      const border = asciiOnly ? '| ' : '│ '
      return rawLines.map((l) => `${border}${truncateVisible(l, Math.max(8, innerWidth - 2))}`)
    }

    case 'table-row': {
      const cells = (block.cells ?? [block.text]).map((c) => clean(c).trim())
      const sep = asciiOnly ? ' | ' : ' │ '
      return [truncateVisible(cells.join(sep), innerWidth)]
    }

    case 'image': {
      const alt = clean(block.alt || block.text || 'image')
      return [`[IMG: ${truncateVisible(alt, Math.max(8, innerWidth - 8))}]`]
    }

    case 'hr': {
      return [(asciiOnly ? '-' : '─').repeat(innerWidth)]
    }

    default:
      return wrapText(clean(block.text), innerWidth)
  }
}

interface PositionedBlock {
  block: ContentBlock
  tableRows?: ContentBlock[]
  box: Rect
  order: number
}

function isValidBox(box?: Rect): box is Rect {
  return Boolean(
    box &&
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 0 &&
      box.height > 0,
  )
}

function resolvePositionedBlocks(snapshot: PageSnapshot): {
  positioned: PositionedBlock[]
  unpositioned: ContentBlock[]
} {
  const boxByRef = new Map<string, Rect>()
  for (const el of snapshot.elements) {
    if (el.ref && isValidBox(el.box)) {
      boxByRef.set(el.ref, el.box)
    }
  }

  const positioned: PositionedBlock[] = []
  const unpositioned: ContentBlock[] = []

  for (let i = 0; i < snapshot.blocks.length; i++) {
    const block = snapshot.blocks[i]!
    const box = isValidBox(block.box) ? block.box : block.ref ? boxByRef.get(block.ref) : undefined
    if (box) {
      positioned.push({ block, box, order: i })
    } else {
      unpositioned.push(block)
    }
  }

  return { positioned, unpositioned }
}

/**
 * Returns true if the snapshot contains at least two positioned blocks
 * occupying overlapping vertical bands in separate horizontal columns
 * (e.g. sidebar + main content, horizontal nav bar, or multi-column card grid).
 */
export function hasMultiColumnLayout(snapshot: PageSnapshot): boolean {
  const { positioned } = resolvePositionedBlocks(snapshot)
  if (positioned.length < 2) return false

  for (let i = 0; i < positioned.length; i++) {
    const a = positioned[i]!.box
    const aRight = a.x + a.width
    const aBottom = a.y + a.height
    for (let j = i + 1; j < positioned.length; j++) {
      const b = positioned[j]!.box
      const bRight = b.x + b.width
      const bBottom = b.y + b.height
      const yOverlap = Math.min(aBottom, bBottom) - Math.max(a.y, b.y)
      if (yOverlap > 2 && (aRight <= b.x + 4 || bRight <= a.x + 4)) {
        return true
      }
    }
  }
  return false
}

function blockAnsiStyle(block: ContentBlock): string | null {
  switch (block.kind) {
    case 'heading':
      return (block.level ?? 1) === 1 ? ANSI.bold + ANSI.cyan : ANSI.bold
    case 'link':
      return ANSI.cyan
    case 'button':
      return ANSI.green
    case 'input':
      return ANSI.magenta
    default:
      return null
  }
}

/**
 * Renders snapshot blocks onto a true 2D spatial ASCII character canvas using
 * element `box` coordinates (`x, y, width, height`), preserving multi-column
 * sidebars, headers, nav bars, and card grids without overlapping text.
 * Returns null if no blocks have usable bounding boxes.
 */
export function renderSpatialBlocks(
  snapshot: PageSnapshot,
  innerWidth: number,
  asciiOnly: boolean,
  color: boolean,
  showRefs: boolean,
): string[] | null {
  const { positioned, unpositioned } = resolvePositionedBlocks(snapshot)
  if (positioned.length === 0) return null

  const minX = Math.min(...positioned.map((p) => p.box.x))
  const originX = minX < 0 ? minX : 0
  const maxRight = Math.max(snapshot.viewport.width || 1280, ...positioned.map((p) => p.box.x + p.box.width))
  const spanX = Math.max(1, maxRight - originX)
  const minY = Math.min(...positioned.map((p) => p.box.y))
  const pxPerRow = 20

  // Sort top-to-bottom, left-to-right, preserving DOM order on exact ties
  const sortedRaw = [...positioned].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || a.order - b.order)

  // Group table-row blocks that share horizontal extent and are vertically adjacent into unified tables
  const sorted: PositionedBlock[] = []
  for (const item of sortedRaw) {
    if (item.block.kind === 'table-row') {
      let matched: PositionedBlock | undefined
      for (let k = sorted.length - 1; k >= 0; k--) {
        const candidate = sorted[k]!
        if (candidate.block.kind !== 'table-row') continue
        const xOverlap =
          Math.min(candidate.box.x + candidate.box.width, item.box.x + item.box.width) -
          Math.max(candidate.box.x, item.box.x)
        const yGap = item.box.y - (candidate.box.y + candidate.box.height)
        if (xOverlap > 0 && yGap >= -4 && yGap <= 40) {
          matched = candidate
          break
        }
      }
      if (matched) {
        if (!matched.tableRows) matched.tableRows = [matched.block]
        matched.tableRows.push(item.block)
        const minBoxX = Math.min(matched.box.x, item.box.x)
        const minBoxY = Math.min(matched.box.y, item.box.y)
        const maxBoxR = Math.max(matched.box.x + matched.box.width, item.box.x + item.box.width)
        const maxBoxB = Math.max(matched.box.y + matched.box.height, item.box.y + item.box.height)
        matched.box = { x: minBoxX, y: minBoxY, width: maxBoxR - minBoxX, height: maxBoxB - minBoxY }
        continue
      }
      sorted.push({ ...item, tableRows: [item.block] })
    } else {
      sorted.push(item)
    }
  }

  const projected = sorted.map((item) => {
    const colStart = Math.max(0, Math.min(innerWidth - 1, Math.round(((item.box.x - originX) / spanX) * innerWidth)))
    const colEnd = Math.max(
      colStart + 1,
      Math.min(innerWidth, Math.round(((item.box.x + item.box.width - originX) / spanX) * innerWidth)),
    )
    return { ...item, colStart, colEnd }
  })

  const grid: string[][] = []
  const styleGrid: (string | null)[][] | null = color && !asciiOnly ? [] : null

  const ensureRows = (count: number) => {
    while (grid.length < count) {
      grid.push(new Array<string>(innerWidth).fill(' '))
      if (styleGrid) styleGrid.push(new Array<string | null>(innerWidth).fill(null))
    }
  }

  const canPlace = (startRow: number, colStart: number, lines: string[]): boolean => {
    for (let dy = 0; dy < lines.length; dy++) {
      const r = startRow + dy
      if (r >= grid.length) continue
      const row = grid[r]!
      const line = lines[dy]!
      for (let dx = 0; dx < line.length; dx++) {
        const c = colStart + dx
        if (c >= innerWidth) break
        if (line[dx] !== ' ' && row[c] !== ' ') {
          return false
        }
      }
    }
    return true
  }

  let yShift = 0
  let maxOccupiedRow = -1

  for (let i = 0; i < projected.length; i++) {
    const item = projected[i]!
    const aBottom = item.box.y + item.box.height
    const aRight = item.box.x + item.box.width

    // Find closest right-hand neighbor on an overlapping vertical band to reserve a 1-char gutter
    let maxRightCol = innerWidth
    for (let j = 0; j < projected.length; j++) {
      if (i === j) continue
      const other = projected[j]!
      if (other.colStart <= item.colStart) continue
      if (other.box.x < aRight - 4) continue
      const yOverlap = Math.min(aBottom, other.box.y + other.box.height) - Math.max(item.box.y, other.box.y)
      if (yOverlap > 2) {
        maxRightCol = Math.min(maxRightCol, Math.max(item.colStart + 1, other.colStart - 1))
      }
    }

    const availableSpan = Math.max(1, maxRightCol - item.colStart)
    const boxSpan = Math.max(1, Math.min(item.colEnd, maxRightCol) - item.colStart)
    const isCompactInline =
      item.block.kind === 'link' ||
      item.block.kind === 'button' ||
      item.block.kind === 'input' ||
      item.block.kind === 'select' ||
      item.block.kind === 'image'

    const drawWidth = isCompactInline ? availableSpan : Math.min(availableSpan, Math.max(boxSpan, Math.min(availableSpan, 8)))

    // Format without ANSI codes so character positions align 1:1 with grid columns
    const rawFormatted = item.tableRows
      ? renderAsciiTable(item.tableRows, drawWidth, { asciiOnly, color: false })
      : formatBlock(item.block, drawWidth, asciiOnly, false, showRefs)
    const formatted = rawFormatted
      .map((l) => {
        const plain = asciiOnly ? sanitizeAscii(stripAnsi(l)) : stripAnsi(l)
        return plain.length > drawWidth ? truncateVisible(plain, drawWidth) : plain
      })
      .filter((l) => l.length > 0)

    if (formatted.length === 0) continue

    const rawRow = Math.max(0, Math.round((item.box.y - minY) / pxPerRow))
    let targetRow = Math.max(0, rawRow - yShift)

    // Compress full-width blank gaps larger than 1 empty line
    if (maxOccupiedRow >= 0 && targetRow > maxOccupiedRow + 2) {
      yShift += targetRow - (maxOccupiedRow + 2)
      targetRow = maxOccupiedRow + 2
    }

    // Resolve any vertical collision inside these columns
    let row = targetRow
    while (!canPlace(row, item.colStart, formatted)) {
      row++
    }

    ensureRows(row + formatted.length)
    const style = styleGrid ? blockAnsiStyle(item.block) : null

    for (let dy = 0; dy < formatted.length; dy++) {
      const line = formatted[dy]!
      const gridRow = grid[row + dy]!
      const sRow = styleGrid ? styleGrid[row + dy]! : null
      for (let dx = 0; dx < line.length; dx++) {
        const c = item.colStart + dx
        if (c >= innerWidth) break
        gridRow[c] = line[dx]!
        if (sRow && style) sRow[c] = style
      }
    }

    maxOccupiedRow = Math.max(maxOccupiedRow, row + formatted.length - 1)
  }

  // Trim trailing all-space rows
  let lastNonEmpty = grid.length - 1
  while (lastNonEmpty >= 0 && grid[lastNonEmpty]!.every((ch) => ch === ' ')) {
    lastNonEmpty--
  }

  const resultLines: string[] = []
  for (let r = 0; r <= lastNonEmpty; r++) {
    const chars = grid[r]!
    if (!styleGrid) {
      resultLines.push(chars.join('').replace(/\s+$/, ''))
    } else {
      const styles = styleGrid[r]!
      let line = ''
      let activeStyle: string | null = null
      let endCol = chars.length - 1
      while (endCol >= 0 && chars[endCol] === ' ') endCol--
      for (let c = 0; c <= endCol; c++) {
        const st = styles[c]!
        if (st !== activeStyle) {
          if (activeStyle) line += ANSI.reset
          if (st) line += st
          activeStyle = st
        }
        line += chars[c]!
      }
      if (activeStyle) line += ANSI.reset
      resultLines.push(line)
    }
  }

  // Append any unpositioned blocks below the spatial canvas
  if (unpositioned.length > 0) {
    if (resultLines.length > 0) resultLines.push('')
    resultLines.push(...renderFlowBlocks(unpositioned, innerWidth, asciiOnly, color, showRefs, false))
  }

  return resultLines
}

export interface ScrollbarGutter {
  scrollable: boolean
  thumbStart: number
  thumbSize: number
  percent: number
  chars: string[]
}

/**
 * Computes a vertical ASCII/Unicode scrollbar gutter (`#` thumb on `|` track in 7-bit ASCII,
 * or `█` thumb on `│` track in Unicode mode) for a viewport of `trackHeight` rows.
 */
export function computeScrollbarGutter(
  trackHeight: number,
  totalContent: number,
  visibleContent: number,
  scrollOffset: number,
  options: { asciiOnly?: boolean; color?: boolean } = {},
): ScrollbarGutter {
  const asciiOnly = options.asciiOnly ?? true
  const color = asciiOnly ? false : (options.color ?? false)
  const trackChar = asciiOnly ? '|' : '│'
  const thumbChar = asciiOnly ? '#' : color ? `${ANSI.cyan}█${ANSI.reset}` : '█'

  if (trackHeight <= 0) {
    return { scrollable: false, thumbStart: -1, thumbSize: 0, percent: 100, chars: [] }
  }

  if (visibleContent <= 0 || totalContent <= visibleContent) {
    return {
      scrollable: false,
      thumbStart: -1,
      thumbSize: 0,
      percent: 100,
      chars: Array.from({ length: trackHeight }, () => trackChar),
    }
  }

  const maxScroll = totalContent - visibleContent
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll))
  const ratio = clampedOffset / maxScroll
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)))
  const rawThumb = Math.round((visibleContent / totalContent) * trackHeight)
  const thumbSize = trackHeight === 1 ? 1 : Math.max(1, Math.min(trackHeight - 1, rawThumb))
  const maxThumbStart = trackHeight - thumbSize
  const thumbStart = Math.round(ratio * maxThumbStart)

  const chars: string[] = []
  for (let row = 0; row < trackHeight; row++) {
    chars.push(row >= thumbStart && row < thumbStart + thumbSize ? thumbChar : trackChar)
  }

  return { scrollable: true, thumbStart, thumbSize, percent, chars }
}

export function renderPageAscii(snapshot: PageSnapshot, options: AsciiRenderOptions = {}): string {
  const width = Math.max(40, Math.min(240, options.width ?? 100))
  const height = Math.max(14, Math.min(200, options.height ?? 36))
  const asciiOnly = options.asciiOnly ?? true
  const color = asciiOnly ? false : (options.color ?? false)
  const showRefs = options.showRefs ?? true
  const showChrome = options.showChrome ?? true
  const showScrollbar = options.showScrollbar ?? showChrome
  const scrollOffset = Math.max(0, options.scrollOffset ?? 0)
  const requestedLayout: AsciiLayoutMode = options.layout ?? 'flow'

  const box = asciiOnly
    ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' }

  const innerWidth = width - 4 // "| " + content + " |"
  const topBorder = `${box.tl}${box.h.repeat(width - 2)}${box.tr}`
  const midBorder = `${box.ml}${box.h.repeat(width - 2)}${box.mr}`
  const botBorder = `${box.bl}${box.h.repeat(width - 2)}${box.br}`
  const frameLine = (content: string, rightEdge: string = box.v) =>
    `${box.v} ${padLine(content, innerWidth, asciiOnly)} ${rightEdge}`

  // Render content blocks into lines first so header scroll% and right-edge scrollbar stay in sync
  const bodyLines: string[] = []
  if (snapshot.title) {
    const t = asciiOnly ? sanitizeAscii(snapshot.title) : snapshot.title
    bodyLines.push(color ? `${ANSI.bold}${t}${ANSI.reset}` : `TITLE: ${t}`)
    bodyLines.push((asciiOnly ? '-' : '─').repeat(Math.min(innerWidth, Math.max(12, t.length + 7))))
  }

  const useSpatial =
    requestedLayout === 'spatial' || (requestedLayout === 'auto' && hasMultiColumnLayout(snapshot))
  const spatialLines = useSpatial ? renderSpatialBlocks(snapshot, innerWidth, asciiOnly, color, showRefs) : null
  const activeLayout: 'spatial' | 'flow' = spatialLines ? 'spatial' : 'flow'

  if (spatialLines) {
    bodyLines.push(...spatialLines)
  } else {
    bodyLines.push(...renderFlowBlocks(snapshot.blocks, innerWidth, asciiOnly, color, showRefs, true))
  }

  // Append interactive refs index if page had elements not already emitted in blocks
  const emittedRefs = new Set<string>()
  for (const b of snapshot.blocks) {
    if (b.ref) emittedRefs.add(b.ref)
    if (b.links) {
      for (const lnk of b.links) {
        if (lnk.ref) emittedRefs.add(lnk.ref)
      }
    }
  }
  const orphanElements = snapshot.elements.filter((el) => el.ref && !emittedRefs.has(el.ref))
  if (showRefs && orphanElements.length > 0) {
    bodyLines.push((asciiOnly ? '-' : '─').repeat(innerWidth))
    bodyLines.push('INTERACTIVE REFS:')
    for (const el of orphanElements.slice(0, 40)) {
      const desc = el.text || el.label || el.ariaLabel || el.placeholder || el.name || el.tag
      bodyLines.push(`  [${el.ref}] (${el.tag}${el.type ? `:${el.type}` : ''}) ${truncateVisible(desc, innerWidth - 22)}`)
    }
  }

  if (bodyLines.length === 0) {
    bodyLines.push('(empty page)')
  }

  const chromeOverhead = showChrome ? 6 : 0
  const viewportRows = Math.max(6, height - chromeOverhead)
  const maxOffset = Math.max(0, bodyLines.length - viewportRows)
  const start = Math.min(scrollOffset, maxOffset)
  const visible = bodyLines.slice(start, start + viewportRows)

  const bodyOverflows = bodyLines.length > viewportRows
  const domOverflows = snapshot.viewport.scrollHeight > snapshot.viewport.height
  const scrollbar = bodyOverflows
    ? computeScrollbarGutter(viewportRows, bodyLines.length, viewportRows, start, { asciiOnly, color })
    : domOverflows
      ? computeScrollbarGutter(
          viewportRows,
          snapshot.viewport.scrollHeight,
          Math.max(1, snapshot.viewport.height),
          snapshot.viewport.scrollY,
          { asciiOnly, color },
        )
      : computeScrollbarGutter(viewportRows, bodyLines.length, viewportRows, 0, { asciiOnly, color })

  const output: string[] = []

  if (showChrome) {
    output.push(topBorder)
    // Tab strip
    const tabs = options.tabs ?? [
      {
        id: snapshot.tabId,
        url: snapshot.url,
        title: snapshot.title || snapshot.url || 'New Tab',
        active: true,
        loading: false,
        engine: 'lite',
      },
    ]
    const tabStr = tabs
      .map((t) => {
        const mark = t.id === (options.activeTabId ?? snapshot.tabId) || t.active ? '*' : ''
        const label = truncateVisible(asciiOnly ? sanitizeAscii(t.title || t.url || 'tab') : t.title || t.url || 'tab', 18)
        return `[${t.id}${mark} ${label}]`
      })
      .join(' ')
    const headerLeft = `TROY-ADV ${tabStr}`
    output.push(frameLine(headerLeft))

    // URL + Title bar
    const urlStr = truncateVisible(asciiOnly ? sanitizeAscii(snapshot.url || 'about:blank') : snapshot.url || 'about:blank', innerWidth - 16)
    const urlLine = `URL: ${urlStr}`
    const posTag = `scroll:${scrollbar.percent}%`
    const spacer = Math.max(1, innerWidth - visibleLength(urlLine) - posTag.length)
    output.push(frameLine(`${truncateVisible(urlLine, innerWidth - posTag.length - 1)}${' '.repeat(spacer)}${posTag}`))
    output.push(midBorder)
  }

  for (let i = 0; i < viewportRows; i++) {
    const line = visible[i] ?? ''
    const gutterChar = showScrollbar ? (scrollbar.chars[i] ?? box.v) : box.v
    if (showChrome) {
      output.push(frameLine(line, gutterChar))
    } else if (showScrollbar) {
      output.push(`${padLine(line, innerWidth, asciiOnly)} ${gutterChar}`)
    } else {
      output.push(padLine(line, innerWidth, asciiOnly))
    }
  }

  if (showChrome) {
    output.push(midBorder)
    const refCount = snapshot.elements.filter((e) => e.ref).length
    const lineRange = `lines ${start + 1}-${Math.min(bodyLines.length, start + viewportRows)}/${bodyLines.length}`
    const layoutTag = activeLayout === 'spatial' ? ' | layout:2d' : ''
    const status = options.statusMessage
      ? `${options.statusMessage} | refs:${refCount}${layoutTag} | ${lineRange}`
      : `refs:${refCount} | epoch:${snapshot.epoch}${layoutTag} | ${lineRange} | cmds: open click fill find scroll`
    output.push(frameLine(status))
    output.push(botBorder)
  }

  return asciiOnly ? output.map((line) => sanitizeAscii(line)).join('\n') : output.join('\n')
}

export function renderCompactRefsAscii(snapshot: PageSnapshot, limit = 60): string {
  const lines: string[] = [
    `PAGE: ${sanitizeAscii(snapshot.title || '(untitled)')}`,
    `URL:  ${sanitizeAscii(snapshot.url)}`,
    `REFS (${snapshot.elements.length}):`,
  ]
  for (const el of snapshot.elements.slice(0, limit)) {
    const label = sanitizeAscii(el.text || el.label || el.ariaLabel || el.placeholder || el.name || '')
    const valPart = el.value ? ` val="${sanitizeAscii(el.value.slice(0, 40))}"` : ''
    const hrefPart = el.href ? ` href="${sanitizeAscii(el.href.slice(0, 60))}"` : ''
    lines.push(`  [${el.ref ?? '?'}] <${el.tag}${el.type ? `:${el.type}` : ''}> "${label.slice(0, 60)}"${valPart}${hrefPart}`)
  }
  return lines.join('\n')
}
