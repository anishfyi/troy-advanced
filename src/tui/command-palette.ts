// Command Palette (Ctrl+P) state, fuzzy filtering, and ASCII/ANSI modal renderer
// for the Terminal Browser TUI.

import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'
import type { TabSummary } from '../types.js'
import { cycleViewMode, formatViewModeLabel, type TuiViewMode } from './pixel-preview.js'

export type PaletteCategory = 'Tab' | 'Navigate' | 'Page' | 'Library' | 'Inspector' | 'View' | 'Session'

export type PaletteAction =
  | { type: 'command'; command: string }
  | { type: 'prompt'; prefix: string }
  | { type: 'new-tab' }
  | { type: 'close-tab' }
  | { type: 'switch-tab'; tabId: number; slot: number }
  | { type: 'enter-hint' }
  | { type: 'enter-search' }
  | { type: 'clear-focus' }
  | { type: 'open-sidebar'; tab: 'bookmarks' | 'history' }
  | { type: 'toggle-bookmark' }
  | { type: 'quit' }

export interface PaletteCommand {
  id: string
  label: string
  category: PaletteCategory
  shortcut?: string
  description?: string
  keywords?: string[]
  action: PaletteAction
}

export interface CommandPaletteContext {
  tabs: TabSummary[]
  splitPane: boolean
  asciiOnly: boolean
  hasFocusedRef: boolean
  sidebarOpen?: boolean
  currentPageBookmarked?: boolean
  viewMode?: TuiViewMode
}

export interface CommandPaletteState {
  query: string
  cursor: number
  allCommands: PaletteCommand[]
  filtered: PaletteCommand[]
  selectedIndex: number
  scrollOffset: number
}

export interface CommandPaletteRenderOptions {
  maxWidth: number
  maxHeight: number
  asciiOnly?: boolean
  color?: boolean
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  inverse: '\x1b[7m',
} as const

function visibleLength(str: string): number {
  return stripAnsi(str).length
}

function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 3)}...`
}

/**
 * Build the context-aware list of commands available in the Command Palette,
 * including dynamic "Switch to Tab N" entries for every currently open tab.
 */
export function buildPaletteCommands(ctx: CommandPaletteContext): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    {
      id: 'tab.new',
      label: 'New Tab',
      category: 'Tab',
      shortcut: 't',
      description: 'Open a new blank browser tab',
      keywords: ['open', 'create', 'blank', 'tab'],
      action: { type: 'new-tab' },
    },
    {
      id: 'tab.close',
      label: 'Close Current Tab',
      category: 'Tab',
      shortcut: 'w',
      description: 'Close the active tab',
      keywords: ['close', 'remove', 'tab'],
      action: { type: 'close-tab' },
    },
  ]

  // Dynamic entries for every open tab (1-based slots)
  ctx.tabs.forEach((tab, idx) => {
    const slot = idx + 1
    const rawTitle = (tab.title || tab.url || 'New Tab').replace(/\s+/g, ' ').trim()
    const shortTitle = truncatePlain(rawTitle, 36)
    const activeSuffix = tab.active ? ' (active)' : ''
    commands.push({
      id: `tab.switch.${tab.id}`,
      label: `Switch to Tab ${slot}: ${shortTitle}${activeSuffix}`,
      category: 'Tab',
      shortcut: slot <= 9 ? String(slot) : undefined,
      description: tab.url || 'about:blank',
      keywords: ['tab', 'switch', String(slot), `#${tab.id}`, tab.url ?? '', tab.title ?? ''],
      action: { type: 'switch-tab', tabId: tab.id, slot },
    })
  })

  commands.push(
    {
      id: 'nav.open',
      label: 'Open URL in New Tab...',
      category: 'Navigate',
      shortcut: ':open',
      description: 'Prompt for a URL to open in a new tab',
      keywords: ['url', 'goto', 'browse', 'visit'],
      action: { type: 'prompt', prefix: 'open ' },
    },
    {
      id: 'nav.navigate',
      label: 'Navigate Current Tab...',
      category: 'Navigate',
      shortcut: ':nav',
      description: 'Prompt for a URL to load in the active tab',
      keywords: ['url', 'goto', 'load', 'address'],
      action: { type: 'prompt', prefix: 'nav ' },
    },
    {
      id: 'nav.back',
      label: 'Go Back',
      category: 'Navigate',
      shortcut: ':back',
      description: 'Navigate back in tab history',
      keywords: ['history', 'previous'],
      action: { type: 'command', command: 'back' },
    },
    {
      id: 'nav.forward',
      label: 'Go Forward',
      category: 'Navigate',
      shortcut: ':forward',
      description: 'Navigate forward in tab history',
      keywords: ['history', 'next'],
      action: { type: 'command', command: 'forward' },
    },
    {
      id: 'nav.reload',
      label: 'Reload Page',
      category: 'Navigate',
      shortcut: ':reload',
      description: 'Reload the active page',
      keywords: ['refresh'],
      action: { type: 'command', command: 'reload' },
    },
    {
      id: 'nav.top',
      label: 'Scroll to Top',
      category: 'Navigate',
      shortcut: 'g',
      description: 'Jump to the top of the page',
      keywords: ['home', 'beginning'],
      action: { type: 'command', command: 'top' },
    },
    {
      id: 'nav.bottom',
      label: 'Scroll to Bottom',
      category: 'Navigate',
      shortcut: 'G',
      description: 'Jump to the bottom of the page',
      keywords: ['end'],
      action: { type: 'command', command: 'bottom' },
    },
    {
      id: 'page.hints',
      label: 'Quick Link Hints',
      category: 'Page',
      shortcut: 'f',
      description: 'Enter Vimium-style link-hint jump mode',
      keywords: ['jump', 'vimium', 'click', 'links', 'refs'],
      action: { type: 'enter-hint' },
    },
    {
      id: 'page.search',
      label: 'Search Page',
      category: 'Page',
      shortcut: '/',
      description: 'Find elements or text on the current page',
      keywords: ['find', 'grep', 'query'],
      action: { type: 'enter-search' },
    },
    {
      id: 'page.clear-focus',
      label: 'Clear Focused Ref',
      category: 'Page',
      shortcut: 'Esc',
      description: ctx.hasFocusedRef ? 'Clear the active focus cursor' : 'No element currently focused',
      keywords: ['unfocus', 'blur', 'cursor'],
      action: { type: 'clear-focus' },
    },
    {
      id: 'library.bookmarks',
      label: 'Open Bookmarks Sidebar',
      category: 'Library',
      shortcut: 'b',
      description: 'Open or switch to the Bookmarks sidebar panel',
      keywords: ['bookmark', 'favorites', 'saved', 'sidebar'],
      action: { type: 'open-sidebar', tab: 'bookmarks' },
    },
    {
      id: 'library.history',
      label: 'Open History Sidebar',
      category: 'Library',
      shortcut: 'H',
      description: 'Open or switch to the Browsing History sidebar panel',
      keywords: ['history', 'recent', 'visited', 'sidebar'],
      action: { type: 'open-sidebar', tab: 'history' },
    },
    {
      id: 'library.toggle-bookmark',
      label: ctx.currentPageBookmarked ? 'Remove Current Page Bookmark' : 'Bookmark Current Page',
      category: 'Library',
      shortcut: 'B',
      description: 'Toggle bookmark for the active page URL',
      keywords: ['bookmark', 'star', 'save', 'favorite'],
      action: { type: 'toggle-bookmark' },
    },
    {
      id: 'library.clear-history',
      label: 'Clear Browsing History',
      category: 'Library',
      shortcut: ':history clear',
      description: 'Clear all recorded browsing history entries',
      keywords: ['history', 'wipe', 'reset', 'clear'],
      action: { type: 'command', command: 'history clear' },
    },
    {
      id: 'inspector.toggle',
      label: ctx.splitPane ? 'Close Split-Pane Inspector' : 'Open Split-Pane Inspector',
      category: 'Inspector',
      shortcut: 'i',
      description: 'Toggle the side-by-side developer inspector pane',
      keywords: ['split', 'devtools', 'pane'],
      action: { type: 'command', command: 'split toggle' },
    },
    {
      id: 'inspector.console',
      label: 'Inspector: Console',
      category: 'Inspector',
      shortcut: ':console',
      description: 'Show browser console output in inspector pane',
      keywords: ['logs', 'errors', 'devtools'],
      action: { type: 'command', command: 'console' },
    },
    {
      id: 'inspector.network',
      label: 'Inspector: Network',
      category: 'Inspector',
      shortcut: ':network',
      description: 'Show HTTP requests in inspector pane',
      keywords: ['http', 'requests', 'xhr', 'fetch'],
      action: { type: 'command', command: 'network' },
    },
    {
      id: 'inspector.refs',
      label: 'Inspector: Refs',
      category: 'Inspector',
      shortcut: ':refs',
      description: 'Show interactive element refs in inspector pane',
      keywords: ['elements', 'dom', 'links'],
      action: { type: 'command', command: 'refs' },
    },
    {
      id: 'inspector.activity',
      label: 'Inspector: Agent Activity',
      category: 'Inspector',
      shortcut: ':activity',
      description: 'Show recent agent tool activity in inspector pane',
      keywords: ['agent', 'audit', 'tools'],
      action: { type: 'command', command: 'activity' },
    },
    {
      id: 'inspector.focus',
      label: 'Switch Active Pane (Page / Inspector)',
      category: 'Inspector',
      shortcut: 'I',
      description: 'Toggle keyboard focus between page and inspector pane',
      keywords: ['pane', 'focus', 'split'],
      action: { type: 'command', command: 'split focus' },
    },
    {
      id: 'inspector.clear',
      label: 'Clear Current Inspector Buffer',
      category: 'Inspector',
      shortcut: ':split clear',
      description: 'Clear logs in the active inspector tab',
      keywords: ['reset', 'wipe', 'logs'],
      action: { type: 'command', command: 'split clear' },
    },
    {
      id: 'view.ascii',
      label: ctx.asciiOnly ? 'Switch to Unicode/ANSI Mode' : 'Switch to Strict 7-bit ASCII Mode',
      category: 'View',
      shortcut: ':ascii',
      description: 'Toggle strict 7-bit ASCII rendering',
      keywords: ['ascii', 'unicode', 'ansi', 'color', 'mode'],
      action: { type: 'command', command: 'ascii' },
    },
    {
      id: 'view.reflow',
      label: 'Reflow / Redraw Viewport',
      category: 'View',
      shortcut: 'Ctrl+L',
      description: 'Re-measure terminal size and reflow TUI panes',
      keywords: ['resize', 'sigwinch', 'tmux', 'screen', 'redraw', 'reflow'],
      action: { type: 'command', command: 'reflow' },
    },
    {
      id: 'view.cycle-preview',
      label: `Cycle Pixel Preview (next: ${formatViewModeLabel(cycleViewMode(ctx.viewMode ?? 'layout', 1))})`,
      category: 'View',
      shortcut: 'v',
      description: 'Cycle live view: Layout ASCII -> Pixel ASCII -> Braille -> Halfblock',
      keywords: ['view', 'pixel', 'preview', 'braille', 'halfblock', 'layout', 'toggle', 'cycle'],
      action: { type: 'command', command: 'view next' },
    },
    {
      id: 'view.mode-layout',
      label: 'View Mode: Layout ASCII',
      category: 'View',
      shortcut: ':view layout',
      description: 'Switch back to interactive DOM Layout ASCII view',
      keywords: ['view', 'layout', 'dom', 'text', 'ascii'],
      action: { type: 'command', command: 'view layout' },
    },
    {
      id: 'view.visual-ascii',
      label: 'View Mode: Pixel ASCII',
      category: 'View',
      shortcut: ':view pixel',
      description: 'Live pixel preview rendered as 7-bit ASCII with [eN] boxes',
      keywords: ['screenshot', 'image', 'pixels', 'view', 'pixel-ascii'],
      action: { type: 'command', command: 'view pixel-ascii' },
    },
    {
      id: 'view.visual-braille',
      label: 'View Mode: Braille',
      category: 'View',
      shortcut: ':view braille',
      description: 'Live pixel preview rendered as high-resolution Unicode Braille dots',
      keywords: ['screenshot', 'image', 'braille', 'view', 'pixels'],
      action: { type: 'command', command: 'view braille' },
    },
    {
      id: 'view.visual-halfblock',
      label: 'View Mode: Halfblock',
      category: 'View',
      shortcut: ':view halfblock',
      description: 'Live pixel preview rendered as ANSI truecolor half-blocks',
      keywords: ['screenshot', 'image', 'halfblock', 'truecolor', 'color', 'view', 'pixels'],
      action: { type: 'command', command: 'view halfblock' },
    },
    {
      id: 'view.visual-edge',
      label: 'Visual Screenshot (Edge Wireframe)',
      category: 'View',
      shortcut: ':visual edge',
      description: 'Render Sobel edge-detected wireframe screenshot',
      keywords: ['screenshot', 'sobel', 'wireframe'],
      action: { type: 'command', command: 'visual edge' },
    },
    {
      id: 'session.quit',
      label: 'Quit Terminal Browser',
      category: 'Session',
      shortcut: 'q',
      description: 'Exit troy-advanced TUI',
      keywords: ['exit', 'close', 'bye'],
      action: { type: 'quit' },
    },
  )

  return commands
}

/**
 * Deterministic case-insensitive fuzzy/substring match score.
 * Higher score = stronger match; 0 = no match.
 */
export function scorePaletteMatch(cmd: PaletteCommand, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return 1

  const label = cmd.label.toLowerCase()
  const category = cmd.category.toLowerCase()
  const shortcut = (cmd.shortcut ?? '').toLowerCase()
  const description = (cmd.description ?? '').toLowerCase()
  const keywords = (cmd.keywords ?? []).join(' ').toLowerCase()

  if (label === query) return 1000
  if (label.startsWith(query)) return 800 - Math.min(200, label.length - query.length)

  // Word-boundary prefix match in label
  const words = label.split(/[\s:/()-]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.startsWith(query)) {
      return 650 - i * 10
    }
  }

  // Substring in label
  const labelIdx = label.indexOf(query)
  if (labelIdx >= 0) {
    return 500 - Math.min(100, labelIdx)
  }

  // Category or shortcut match
  if (category.startsWith(query) || shortcut === query) {
    return 420
  }

  // Multi-token match across all searchable fields
  const haystack = `${category} ${label} ${shortcut} ${description} ${keywords}`
  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every((tok) => haystack.includes(tok))) {
    return 360
  }

  if (keywords.includes(query) || description.includes(query)) {
    return 300
  }

  // Fuzzy subsequence match on label (e.g. "nt" -> "New Tab", "ic" -> "Inspector: Console")
  let qi = 0
  let consecutiveBonus = 0
  let boundaryBonus = 0
  let lastMatchIdx = -2
  for (let li = 0; li < label.length && qi < query.length; li++) {
    if (label[li] === query[qi]) {
      if (li === lastMatchIdx + 1) consecutiveBonus += 12
      if (li === 0 || /[\s:/()-]/.test(label[li - 1]!)) boundaryBonus += 20
      lastMatchIdx = li
      qi++
    }
  }
  if (qi === query.length) {
    return 150 + consecutiveBonus + boundaryBonus - Math.min(80, label.length)
  }

  return 0
}

/**
 * Filter and rank commands against `query` with deterministic tie-breaking by original index.
 */
export function filterPaletteCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const trimmed = query.trim()
  if (!trimmed) return [...commands]

  const scored: Array<{ cmd: PaletteCommand; score: number; index: number }> = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    const score = scorePaletteMatch(cmd, trimmed)
    if (score > 0) {
      scored.push({ cmd, score, index: i })
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })
  return scored.map((entry) => entry.cmd)
}

export function createCommandPaletteState(
  ctx: CommandPaletteContext,
  initialQuery = '',
): CommandPaletteState {
  const allCommands = buildPaletteCommands(ctx)
  const filtered = filterPaletteCommands(allCommands, initialQuery)
  return {
    query: initialQuery,
    cursor: initialQuery.length,
    allCommands,
    filtered,
    selectedIndex: 0,
    scrollOffset: 0,
  }
}

export function updateCommandPaletteQuery(
  state: CommandPaletteState,
  nextQuery: string,
  nextCursor?: number,
): CommandPaletteState {
  const filtered = filterPaletteCommands(state.allCommands, nextQuery)
  const cursor = Math.max(0, Math.min(nextQuery.length, nextCursor ?? nextQuery.length))
  return {
    ...state,
    query: nextQuery,
    cursor,
    filtered,
    selectedIndex: 0,
    scrollOffset: 0,
  }
}

export function moveCommandPaletteSelection(
  state: CommandPaletteState,
  delta: number,
): CommandPaletteState {
  const len = state.filtered.length
  if (len === 0) return state
  const nextIndex = ((state.selectedIndex + delta) % len + len) % len
  return {
    ...state,
    selectedIndex: nextIndex,
  }
}

export function cloneCommandPaletteState(
  state: CommandPaletteState | null,
): CommandPaletteState | null {
  if (!state) return null
  return {
    query: state.query,
    cursor: state.cursor,
    allCommands: state.allCommands.map((c) => ({
      ...c,
      keywords: c.keywords ? [...c.keywords] : undefined,
      action: { ...c.action },
    })),
    filtered: state.filtered.map((c) => ({
      ...c,
      keywords: c.keywords ? [...c.keywords] : undefined,
      action: { ...c.action },
    })),
    selectedIndex: state.selectedIndex,
    scrollOffset: state.scrollOffset,
  }
}

export function formatCommandPaletteStatus(
  state: CommandPaletteState,
  opts: { asciiOnly?: boolean } = {},
): string {
  const countStr = `${state.filtered.length}/${state.allCommands.length}`
  const selected = state.filtered[state.selectedIndex]
  const raw = selected
    ? `PALETTE (${countStr}) > ${state.query} | ${selected.label} | Enter: run | Esc: close`
    : `PALETTE (0/${state.allCommands.length}) > ${state.query} | No matching command | Esc: close`
  return opts.asciiOnly ? sanitizeAscii(raw) : raw
}

/**
 * Render the Command Palette as a bordered modal box ready for `overlayModalOnFrame`.
 */
export function renderCommandPaletteBox(
  state: CommandPaletteState,
  opts: CommandPaletteRenderOptions,
): string[] {
  const asciiOnly = Boolean(opts.asciiOnly)
  const useColor = !asciiOnly && Boolean(opts.color)

  const boxWidth = Math.max(40, Math.min(72, opts.maxWidth - 4))
  const innerWidth = boxWidth - 4 // "| " + content + " |"

  const hBar = asciiOnly ? '-' : '─'
  const vBar = asciiOnly ? '|' : '│'
  const tl = asciiOnly ? '+' : '╭'
  const tr = asciiOnly ? '+' : '╮'
  const bl = asciiOnly ? '+' : '╰'
  const br = asciiOnly ? '+' : '╯'
  const ml = asciiOnly ? '+' : '├'
  const mr = asciiOnly ? '+' : '┤'

  const paint = (text: string, code: string): string => (useColor ? `${code}${text}${ANSI.reset}` : text)
  const clean = (text: string): string => (asciiOnly ? sanitizeAscii(text) : stripAnsi(text))

  const row = (content: string): string => {
    const safeContent = asciiOnly ? sanitizeAscii(stripAnsi(content)) : content
    const visLen = visibleLength(safeContent)
    const pad = Math.max(0, innerWidth - visLen)
    return `${vBar} ${safeContent}${' '.repeat(pad)} ${vBar}`
  }

  const titleText = ' Command Palette (Ctrl+P) '
  const titleLen = titleText.length
  const rightRule = Math.max(1, boxWidth - 3 - titleLen)
  const borderTop = `${tl}${hBar}${paint(titleText, ANSI.bold + ANSI.cyan)}${hBar.repeat(rightRule)}${tr}`
  const borderMid = `${ml}${hBar.repeat(boxWidth - 2)}${mr}`
  const borderBot = `${bl}${hBar.repeat(boxWidth - 2)}${br}`

  const lines: string[] = [borderTop]

  // Search input row with match counter on the right
  const countBadge = `${state.filtered.length}/${state.allCommands.length}`
  const promptPrefix = '> '
  const maxQueryArea = Math.max(8, innerWidth - promptPrefix.length - countBadge.length - 2)
  const queryClean = clean(state.query)
  const cursorPos = Math.max(0, Math.min(queryClean.length, state.cursor))
  const maxVisibleChars = Math.max(4, maxQueryArea - 1)
  let windowStart = 0
  if (cursorPos >= maxVisibleChars) {
    windowStart = cursorPos - maxVisibleChars + 1
  }
  const windowText = queryClean.slice(windowStart, windowStart + maxVisibleChars)
  const relCursor = cursorPos - windowStart

  let inputVisual: string
  if (useColor) {
    const before = windowText.slice(0, relCursor)
    const atChar = windowText[relCursor] ?? ' '
    const after = windowText.slice(relCursor + 1)
    inputVisual = `${paint(promptPrefix, ANSI.green)}${before}${paint(atChar, ANSI.inverse)}${after}`
  } else {
    const before = windowText.slice(0, relCursor)
    const after = windowText.slice(relCursor)
    const caret = relCursor >= windowText.length ? '_' : '|'
    inputVisual = `${promptPrefix}${before}${caret}${after}`
  }
  const gapToBadge = Math.max(1, innerWidth - visibleLength(inputVisual) - countBadge.length)
  lines.push(row(`${inputVisual}${' '.repeat(gapToBadge)}${paint(countBadge, ANSI.dim)}`))
  lines.push(borderMid)

  // Command list viewport
  const maxVisibleItems = Math.max(4, Math.min(10, opts.maxHeight - 8))
  const total = state.filtered.length

  if (total === 0) {
    const emptyMsg = truncatePlain(`No commands match "${queryClean}"`, innerWidth)
    lines.push(row(paint(emptyMsg, ANSI.dim)))
  } else {
    let scrollOffset = state.scrollOffset
    if (state.selectedIndex < scrollOffset) {
      scrollOffset = state.selectedIndex
    } else if (state.selectedIndex >= scrollOffset + maxVisibleItems) {
      scrollOffset = state.selectedIndex - maxVisibleItems + 1
    }
    scrollOffset = Math.max(0, Math.min(Math.max(0, total - maxVisibleItems), scrollOffset))
    state.scrollOffset = scrollOffset

    const end = Math.min(total, scrollOffset + maxVisibleItems)
    for (let i = scrollOffset; i < end; i++) {
      const cmd = state.filtered[i]!
      const isSelected = i === state.selectedIndex
      const pointer = isSelected ? '>' : ' '
      const catTag = `[${cmd.category}]`
      const shortcutTag = cmd.shortcut ? `[${clean(cmd.shortcut)}]` : ''
      const reservedRight = shortcutTag ? shortcutTag.length + 1 : 0
      const labelBudget = Math.max(8, innerWidth - 2 - catTag.length - 1 - reservedRight)
      const labelText = truncatePlain(clean(cmd.label), labelBudget)

      const leftPlain = `${pointer} ${catTag} ${labelText}`
      const spacer = Math.max(1, innerWidth - leftPlain.length - shortcutTag.length)
      const fullPlain = shortcutTag ? `${leftPlain}${' '.repeat(spacer)}${shortcutTag}` : leftPlain

      if (isSelected && useColor) {
        lines.push(row(paint(fullPlain.padEnd(innerWidth, ' '), ANSI.inverse + ANSI.bold)))
      } else if (isSelected) {
        lines.push(row(fullPlain))
      } else if (useColor) {
        const styledLeft = `${pointer} ${paint(catTag, ANSI.yellow)} ${labelText}`
        const styledRight = shortcutTag ? paint(shortcutTag, ANSI.dim) : ''
        lines.push(row(`${styledLeft}${' '.repeat(spacer)}${styledRight}`))
      } else {
        lines.push(row(fullPlain))
      }
    }

    if (total > maxVisibleItems) {
      const upInd = scrollOffset > 0 ? (asciiOnly ? '^' : '▲') : ' '
      const downInd = end < total ? (asciiOnly ? 'v' : '▼') : ' '
      const scrollInfo = `${upInd}${downInd} Showing ${scrollOffset + 1}-${end} of ${total}`
      lines.push(row(paint(truncatePlain(scrollInfo, innerWidth), ANSI.dim)))
    }
  }

  lines.push(borderMid)
  const hint = 'Enter: run | Up/Down/Tab: select | Ctrl+U: clear | Esc: close'
  lines.push(row(paint(truncatePlain(hint, innerWidth), ANSI.dim)))
  lines.push(borderBot)

  return lines
}
