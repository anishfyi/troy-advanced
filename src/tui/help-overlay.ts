// Built-in TUI Help Overlay (`?`) state, keybinding catalog, and ASCII/ANSI modal renderer
// for the Terminal Browser TUI (`troy-advanced browse`).

import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'

export interface HelpBinding {
  keys: string
  description: string
}

export interface HelpSection {
  id: string
  title: string
  bindings: HelpBinding[]
}

export interface HelpOverlayState {
  scrollOffset: number
  maxScrollOffset: number
  totalLines: number
  viewportRows: number
  sectionCount: number
  bindingCount: number
}

export interface HelpOverlayRenderOptions {
  maxWidth: number
  maxHeight: number
  asciiOnly?: boolean
  color?: boolean
}

export interface HelpOverlayRenderResult {
  lines: string[]
  scrollOffset: number
  maxScrollOffset: number
  totalLines: number
  viewportRows: number
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
} as const

const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'navigation',
    title: 'Navigation & Scrolling',
    bindings: [
      { keys: 'j / Down', description: 'Scroll down (page or focused inspector)' },
      { keys: 'k / Up', description: 'Scroll up (page or focused inspector)' },
      { keys: 'Ctrl+D / PgDn', description: 'Scroll half-page down' },
      { keys: 'Ctrl+U / PgUp', description: 'Scroll half-page up' },
      { keys: 'g / Home', description: 'Jump to top of page' },
      { keys: 'G / End', description: 'Jump to bottom of page' },
      { keys: 'Ctrl+L', description: 'Force terminal reflow / redraw' },
    ],
  },
  {
    id: 'elements',
    title: 'Elements, Focus & Forms',
    bindings: [
      { keys: 'Tab / Shift+Tab', description: 'Focus next / previous [eN] ref' },
      { keys: 'Enter', description: 'Activate focused ref (click or open form modal)' },
      { keys: 'f', description: 'Quick link-hint jump mode (type digits + Enter)' },
      { keys: 'Esc', description: 'Clear focus or close active modal / overlay' },
    ],
  },
  {
    id: 'search-commands',
    title: 'Search & Command Modes',
    bindings: [
      { keys: '/', description: 'Search page text and refs' },
      { keys: 'n / N', description: 'Jump to next / previous search match' },
      { keys: ':', description: 'Open command bar (:open, :save, :view, :quit)' },
      { keys: 'Ctrl+P', description: 'Open fuzzy Command Palette' },
    ],
  },
  {
    id: 'tabs-library',
    title: 'Tabs, Bookmarks & History',
    bindings: [
      { keys: '1 - 9', description: 'Switch to tab slot 1..9' },
      { keys: 't', description: 'Open a new browser tab' },
      { keys: 'w', description: 'Close the active tab' },
      { keys: 'b', description: 'Open Bookmarks sidebar panel' },
      { keys: 'H', description: 'Open History sidebar panel' },
      { keys: 'B', description: 'Toggle bookmark for current page' },
    ],
  },
  {
    id: 'view-inspector',
    title: 'View Modes & Split-Pane Inspector',
    bindings: [
      { keys: 'v / V', description: 'Cycle view: Layout -> Pixel -> Braille -> Halfblock' },
      { keys: 'i', description: 'Toggle split-pane inspector (Console/Net/Refs/Act)' },
      { keys: 'I', description: 'Switch active scroll focus (Page <-> Inspector)' },
      { keys: '[ / ]', description: 'Cycle inspector tabs (opens inspector if closed)' },
      { keys: '1 - 4', description: 'Jump inspector tab when inspector pane is active' },
    ],
  },
  {
    id: 'commands-session',
    title: 'Colon Commands & Session',
    bindings: [
      { keys: ':open <url>', description: 'Navigate active tab to URL or search query' },
      { keys: ':save <file>', description: 'Export page to .txt, .md, or .json' },
      { keys: ':view [mode]', description: 'Set layout | pixel-ascii | braille | halfblock' },
      { keys: ':ascii', description: 'Toggle strict 7-bit ASCII vs Unicode/ANSI' },
      { keys: '?', description: 'Open / close this Help Overlay' },
      { keys: 'q / Ctrl+C', description: 'Quit troy-advanced terminal browser' },
    ],
  },
] as const

/**
 * Return a cloned catalog of all TUI keybinding sections.
 */
export function getHelpSections(): HelpSection[] {
  return HELP_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    bindings: section.bindings.map((b) => ({ ...b })),
  }))
}

/**
 * Count total bindings across all help sections.
 */
export function countHelpBindings(sections: readonly HelpSection[] = HELP_SECTIONS): number {
  return sections.reduce((sum, s) => sum + s.bindings.length, 0)
}

/**
 * Create initial state for the Help Overlay modal.
 */
export function createHelpOverlayState(sections: readonly HelpSection[] = HELP_SECTIONS): HelpOverlayState {
  return {
    scrollOffset: 0,
    maxScrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    sectionCount: sections.length,
    bindingCount: countHelpBindings(sections),
  }
}

export function cloneHelpOverlayState(state: HelpOverlayState | null): HelpOverlayState | null {
  if (!state) return null
  return { ...state }
}

/**
 * Scroll the help overlay by `delta` lines, clamped to `[0, maxScrollOffset]`.
 */
export function scrollHelpOverlay(state: HelpOverlayState, delta: number): HelpOverlayState {
  const max = Math.max(0, state.maxScrollOffset)
  const nextOffset = Math.max(0, Math.min(max, state.scrollOffset + delta))
  return {
    ...state,
    scrollOffset: nextOffset,
  }
}

function visibleLength(s: string): number {
  return stripAnsi(s).length
}

function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  const plain = stripAnsi(text)
  if (plain.length <= maxLen) return plain
  if (maxLen <= 3) return plain.slice(0, maxLen)
  return `${plain.slice(0, maxLen - 3)}...`
}

function padVisible(text: string, width: number, asciiOnly: boolean): string {
  const safe = asciiOnly ? sanitizeAscii(stripAnsi(text)) : text
  const len = visibleLength(safe)
  if (len === width) return safe
  if (len < width) return `${safe}${' '.repeat(width - len)}`
  return truncatePlain(safe, width)
}

/**
 * Build formatted body lines for all keybinding sections constrained to `contentWidth`.
 */
export function buildHelpBodyLines(
  sections: readonly HelpSection[],
  contentWidth: number,
  opts: { asciiOnly?: boolean; color?: boolean } = {},
): string[] {
  const asciiOnly = Boolean(opts.asciiOnly)
  const useColor = Boolean(opts.color) && !asciiOnly
  const width = Math.max(20, Math.floor(contentWidth))

  const paint = (text: string, code: string) => (useColor ? `${code}${text}${ANSI.reset}` : text)
  const clean = (text: string) => (asciiOnly ? sanitizeAscii(text) : text)

  // Compute key column width proportionally while remaining readable on narrow screens.
  const longestKey = sections.reduce((max, s) => {
    for (const b of s.bindings) {
      if (b.keys.length > max) max = b.keys.length
    }
    return max
  }, 8)
  const keyColWidth = Math.max(10, Math.min(longestKey, Math.max(10, Math.floor(width * 0.34))))
  const descWidth = Math.max(8, width - 2 - keyColWidth - 2)

  const lines: string[] = []
  sections.forEach((section, idx) => {
    if (idx > 0) lines.push('')
    const headerText = truncatePlain(`[${clean(section.title)}]`, width)
    lines.push(paint(headerText, ANSI.bold + ANSI.yellow))

    for (const binding of section.bindings) {
      const keyPlain = truncatePlain(clean(binding.keys), keyColWidth)
      const keyPadded = keyPlain + ' '.repeat(Math.max(0, keyColWidth - keyPlain.length))
      const descPlain = truncatePlain(clean(binding.description), descWidth)
      lines.push(`  ${paint(keyPadded, ANSI.bold + ANSI.green)}  ${descPlain}`)
    }
  })

  return lines
}

function computeScrollThumbRange(
  scrollOffset: number,
  totalLines: number,
  viewportRows: number,
): { start: number; end: number } {
  if (viewportRows <= 0 || totalLines <= viewportRows) {
    return { start: 0, end: Math.max(0, viewportRows - 1) }
  }
  const thumbSize = Math.max(1, Math.round((viewportRows / totalLines) * viewportRows))
  const maxOffset = Math.max(1, totalLines - viewportRows)
  const maxStart = Math.max(0, viewportRows - thumbSize)
  const start = Math.min(maxStart, Math.round((scrollOffset / maxOffset) * maxStart))
  return { start, end: Math.min(viewportRows - 1, start + thumbSize - 1) }
}

/**
 * Format the status-bar line displayed while the Help Overlay is open.
 */
export function formatHelpOverlayStatus(
  state: HelpOverlayState,
  opts: { asciiOnly?: boolean } = {},
): string {
  const total = Math.max(0, state.totalLines)
  const first = total === 0 ? 0 : Math.min(total, state.scrollOffset + 1)
  const last = total === 0 ? 0 : Math.min(total, state.scrollOffset + Math.max(1, state.viewportRows))
  const rangeStr = total > 0 ? ` (${first}-${last}/${total})` : ''
  const raw = `HELP${rangeStr} | j/k scroll | PgUp/PgDn | g/G top/end | ?/Esc/q close`
  return opts.asciiOnly ? sanitizeAscii(raw) : raw
}

/**
 * Render the Help Overlay as a centered ASCII/ANSI bordered modal box
 * ready to be composited via `overlayModalOnFrame`.
 */
export function renderHelpOverlayBox(
  state: HelpOverlayState,
  opts: HelpOverlayRenderOptions,
  sections: readonly HelpSection[] = HELP_SECTIONS,
): HelpOverlayRenderResult {
  const asciiOnly = Boolean(opts.asciiOnly)
  const useColor = Boolean(opts.color) && !asciiOnly

  const maxW = Math.max(32, Math.floor(opts.maxWidth))
  const maxH = Math.max(8, Math.floor(opts.maxHeight))
  const boxWidth = Math.max(32, Math.min(76, maxW - 4))
  const innerWidth = boxWidth - 4 // "| " + content + " |"

  const h = asciiOnly ? '-' : '─'
  const v = asciiOnly ? '|' : '│'
  const tl = asciiOnly ? '+' : '┌'
  const tr = asciiOnly ? '+' : '┐'
  const bl = asciiOnly ? '+' : '└'
  const br = asciiOnly ? '+' : '┘'
  const ml = asciiOnly ? '+' : '├'
  const mr = asciiOnly ? '+' : '┤'

  const paint = (text: string, code: string) => (useColor ? `${code}${text}${ANSI.reset}` : text)
  const borderMid = paint(`${ml}${h.repeat(boxWidth - 2)}${mr}`, ANSI.cyan)
  const borderBot = paint(`${bl}${h.repeat(boxWidth - 2)}${br}`, ANSI.cyan)

  const titleLabel = ' Help: Keybindings & Commands '
  const maxTitleLen = Math.max(6, boxWidth - 4)
  const safeTitle = truncatePlain(asciiOnly ? sanitizeAscii(titleLabel) : titleLabel, maxTitleLen)
  const rightRule = Math.max(1, boxWidth - 3 - safeTitle.length)
  const borderTop = `${paint(`${tl}${h}`, ANSI.cyan)}${paint(safeTitle, ANSI.bold + ANSI.cyan)}${paint(`${h.repeat(rightRule)}${tr}`, ANSI.cyan)}`

  const row = (content: string) =>
    `${paint(v, ANSI.cyan)} ${padVisible(content, innerWidth, asciiOnly)} ${paint(v, ANSI.cyan)}`

  // Reserve 4 chrome rows: top border, mid separator, footer row, bottom border.
  const maxViewportRows = Math.max(3, Math.min(26, maxH - 4))

  // First pass without scrollbar to know if scrolling is required.
  const fullBodyWithoutScroll = buildHelpBodyLines(sections, innerWidth, { asciiOnly, color: useColor })
  const needsScrollbar = fullBodyWithoutScroll.length > maxViewportRows
  const contentWidth = needsScrollbar ? Math.max(20, innerWidth - 2) : innerWidth
  const bodyLines = needsScrollbar
    ? buildHelpBodyLines(sections, contentWidth, { asciiOnly, color: useColor })
    : fullBodyWithoutScroll

  const totalLines = bodyLines.length
  const viewportRows = Math.min(maxViewportRows, Math.max(3, totalLines))
  const maxScrollOffset = Math.max(0, totalLines - viewportRows)
  const scrollOffset = Math.max(0, Math.min(maxScrollOffset, state.scrollOffset))

  const visibleSlice = bodyLines.slice(scrollOffset, scrollOffset + viewportRows)
  const thumb = computeScrollThumbRange(scrollOffset, totalLines, viewportRows)

  const lines: string[] = [borderTop]
  for (let i = 0; i < viewportRows; i++) {
    const bodyLine = visibleSlice[i] ?? ''
    if (needsScrollbar) {
      const gutterChar = i >= thumb.start && i <= thumb.end ? '#' : '|'
      const paddedBody = padVisible(bodyLine, contentWidth, asciiOnly)
      lines.push(row(`${paddedBody} ${paint(gutterChar, ANSI.dim)}`))
    } else {
      lines.push(row(bodyLine))
    }
  }

  lines.push(borderMid)

  const first = totalLines === 0 ? 0 : scrollOffset + 1
  const last = totalLines === 0 ? 0 : Math.min(totalLines, scrollOffset + viewportRows)
  const posTag = totalLines > viewportRows ? `[${first}-${last}/${totalLines}]` : `[${totalLines} lines]`
  const hintBase = totalLines > viewportRows
    ? 'j/k scroll | PgUp/PgDn | g/G top/end | ?/Esc/q close'
    : 'Press ?, Esc, Enter, or q to close'
  const availForHint = Math.max(0, innerWidth - posTag.length - 1)
  const footerLine =
    availForHint >= 12
      ? `${truncatePlain(hintBase, availForHint)}${' '.repeat(Math.max(1, innerWidth - Math.min(hintBase.length, availForHint) - posTag.length))}${posTag}`
      : truncatePlain(`${hintBase} ${posTag}`, innerWidth)

  lines.push(row(paint(footerLine, ANSI.dim)))
  lines.push(borderBot)

  return {
    lines,
    scrollOffset,
    maxScrollOffset,
    totalLines,
    viewportRows,
  }
}
