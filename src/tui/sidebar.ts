// Bookmark & History sidebar panel for the Terminal Browser TUI.
// Provides a persistent (optional JSON file-backed) Bookmark & History store,
// sidebar layout calculation, scrollable ASCII/ANSI pane rendering, and
// side-by-side frame composition with the main ASCII page viewport.

import fs from 'node:fs'
import path from 'node:path'
import { computeScrollbarGutter } from '../ascii/layout.js'
import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'

export type SidebarTab = 'bookmarks' | 'history'

export const SIDEBAR_TABS: readonly SidebarTab[] = ['bookmarks', 'history']

export interface BookmarkEntry {
  id: string
  url: string
  title: string
  addedAt: number
  tags?: string[]
}

export interface HistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: number
  visitCount: number
}

export interface SidebarState {
  tab: SidebarTab
  selectedIndex: number
  scrollOffset: number
  filterQuery: string
  filtering: boolean
}

export interface SidebarLayout {
  canShow: boolean
  sidebarWidth: number
  pageWidth: number
  gapWidth: number
}

export interface SidebarItem {
  id: string
  url: string
  title: string
  timestamp: number
  visitCount?: number
  tags?: string[]
}

export interface SidebarData {
  bookmarks: BookmarkEntry[]
  history: HistoryEntry[]
  currentUrl?: string
}

export interface SidebarRenderOptions {
  width: number
  height: number
  asciiOnly?: boolean
  color?: boolean
}

export interface SidebarRenderResult {
  lines: string[]
  items: SidebarItem[]
  selectedIndex: number
  scrollOffset: number
  maxScrollOffset: number
  viewportRows: number
  counts: Record<SidebarTab, number>
}

export interface BookmarkHistoryStoreOptions {
  /** Optional path to persist JSON (mode 0o600). Pass null for purely in-memory storage. */
  filePath?: string | null
  initialBookmarks?: BookmarkEntry[]
  initialHistory?: HistoryEntry[]
  maxHistory?: number
}

const DEFAULT_MAX_HISTORY = 500
const MIN_SIDEBAR_TOTAL_WIDTH = 72
const MIN_SIDEBAR_WIDTH = 28
const MAX_SIDEBAR_WIDTH = 44
const MIN_PAGE_WIDTH = 42

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  inverse: '\x1b[7m',
} as const

function makeId(prefix: 'bm' | 'hist', url: string, ts: number): string {
  let hash = 2166136261
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}-${ts.toString(36)}`
}

function normalizeUrl(raw: string): string {
  return String(raw ?? '').trim()
}

function isRecordableUrl(url: string): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  if (lower === 'about:blank' || lower === 'about:newtab') return false
  return true
}

function defaultTitleForUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname && u.pathname !== '/' ? `${u.host}${u.pathname}` : u.host || url
  } catch {
    return url
  }
}

function matchesQuery(fields: Array<string | undefined>, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return true
  const haystack = fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .join(' ')
    .toLowerCase()
  return tokens.every((tok) => haystack.includes(tok))
}

export class BookmarkHistoryStore {
  private bookmarks: BookmarkEntry[] = []
  private history: HistoryEntry[] = []
  private readonly filePath: string | null
  private readonly maxHistory: number

  constructor(opts: BookmarkHistoryStoreOptions = {}) {
    this.filePath = opts.filePath ?? null
    this.maxHistory = Math.max(10, opts.maxHistory ?? DEFAULT_MAX_HISTORY)
    if (this.filePath) {
      this.load()
    }
    if (opts.initialBookmarks) {
      for (const bm of opts.initialBookmarks) {
        if (bm?.url && !this.bookmarks.some((b) => b.url === bm.url)) {
          this.bookmarks.push({ ...bm, tags: bm.tags ? [...bm.tags] : undefined })
        }
      }
    }
    if (opts.initialHistory) {
      for (const h of opts.initialHistory) {
        if (h?.url && !this.history.some((e) => e.url === h.url)) {
          this.history.push({ ...h })
        }
      }
      this.history = this.history.slice(0, this.maxHistory)
    }
  }

  private load(): void {
    if (!this.filePath) return
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as {
        bookmarks?: unknown[]
        history?: unknown[]
      }
      if (Array.isArray(parsed.bookmarks)) {
        this.bookmarks = parsed.bookmarks
          .filter(
            (b): b is BookmarkEntry =>
              Boolean(b) &&
              typeof (b as BookmarkEntry).url === 'string' &&
              (b as BookmarkEntry).url.length > 0,
          )
          .map((b) => ({
            id: typeof b.id === 'string' && b.id ? b.id : makeId('bm', b.url, b.addedAt || Date.now()),
            url: b.url,
            title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : defaultTitleForUrl(b.url),
            addedAt: Number.isFinite(b.addedAt) ? b.addedAt : Date.now(),
            tags: Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string') : undefined,
          }))
      }
      if (Array.isArray(parsed.history)) {
        this.history = parsed.history
          .filter(
            (h): h is HistoryEntry =>
              Boolean(h) &&
              typeof (h as HistoryEntry).url === 'string' &&
              (h as HistoryEntry).url.length > 0,
          )
          .map((h) => ({
            id: typeof h.id === 'string' && h.id ? h.id : makeId('hist', h.url, h.visitedAt || Date.now()),
            url: h.url,
            title: typeof h.title === 'string' && h.title.trim() ? h.title.trim() : defaultTitleForUrl(h.url),
            visitedAt: Number.isFinite(h.visitedAt) ? h.visitedAt : Date.now(),
            visitCount: Number.isFinite(h.visitCount) && h.visitCount > 0 ? Math.floor(h.visitCount) : 1,
          }))
          .slice(0, this.maxHistory)
      }
    } catch {
      // Fresh profile or unreadable file; start empty
    }
  }

  save(): void {
    if (!this.filePath) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const payload = JSON.stringify(
        {
          version: 1,
          bookmarks: this.bookmarks,
          history: this.history,
        },
        null,
        2,
      )
      fs.writeFileSync(this.filePath, payload, { mode: 0o600 })
    } catch {
      // Ignore write failures in read-only or ephemeral environments
    }
  }

  listBookmarks(query = ''): BookmarkEntry[] {
    return this.bookmarks
      .filter((b) => matchesQuery([b.title, b.url, ...(b.tags ?? [])], query))
      .map((b) => ({ ...b, tags: b.tags ? [...b.tags] : undefined }))
  }

  isBookmarked(url: string): boolean {
    const norm = normalizeUrl(url)
    if (!norm) return false
    return this.bookmarks.some((b) => b.url === norm)
  }

  addBookmark(
    rawUrl: string,
    rawTitle?: string,
    tags?: string[],
    now = Date.now(),
  ): { entry: BookmarkEntry | null; added: boolean } {
    const url = normalizeUrl(rawUrl)
    if (!isRecordableUrl(url)) {
      return { entry: null, added: false }
    }
    const cleanTitle = (rawTitle ?? '').replace(/\s+/g, ' ').trim() || defaultTitleForUrl(url)
    const cleanTags = tags?.map((t) => t.trim()).filter(Boolean)
    const existingIdx = this.bookmarks.findIndex((b) => b.url === url)
    if (existingIdx >= 0) {
      const existing = this.bookmarks[existingIdx]!
      existing.title = cleanTitle
      if (cleanTags && cleanTags.length > 0) {
        existing.tags = Array.from(new Set([...(existing.tags ?? []), ...cleanTags]))
      }
      this.save()
      return { entry: { ...existing, tags: existing.tags ? [...existing.tags] : undefined }, added: false }
    }
    const entry: BookmarkEntry = {
      id: makeId('bm', url, now),
      url,
      title: cleanTitle,
      addedAt: now,
      tags: cleanTags && cleanTags.length > 0 ? cleanTags : undefined,
    }
    this.bookmarks.unshift(entry)
    this.save()
    return { entry: { ...entry, tags: entry.tags ? [...entry.tags] : undefined }, added: true }
  }

  removeBookmark(urlOrId: string): boolean {
    const key = normalizeUrl(urlOrId)
    if (!key) return false
    const idx = this.bookmarks.findIndex((b) => b.id === key || b.url === key)
    if (idx < 0) return false
    this.bookmarks.splice(idx, 1)
    this.save()
    return true
  }

  toggleBookmark(
    rawUrl: string,
    rawTitle?: string,
    now = Date.now(),
  ): { bookmarked: boolean; entry?: BookmarkEntry } {
    const url = normalizeUrl(rawUrl)
    if (!isRecordableUrl(url)) {
      return { bookmarked: false }
    }
    if (this.isBookmarked(url)) {
      this.removeBookmark(url)
      return { bookmarked: false }
    }
    const { entry } = this.addBookmark(url, rawTitle, undefined, now)
    return { bookmarked: Boolean(entry), entry: entry ?? undefined }
  }

  clearBookmarks(): void {
    this.bookmarks = []
    this.save()
  }

  recordHistory(rawUrl: string, rawTitle?: string, visitedAt = Date.now()): HistoryEntry | null {
    const url = normalizeUrl(rawUrl)
    if (!isRecordableUrl(url)) return null
    const cleanTitle = (rawTitle ?? '').replace(/\s+/g, ' ').trim() || defaultTitleForUrl(url)
    const existingIdx = this.history.findIndex((h) => h.url === url)
    if (existingIdx >= 0) {
      const existing = this.history.splice(existingIdx, 1)[0]!
      existing.title = cleanTitle || existing.title
      existing.visitedAt = visitedAt
      existing.visitCount += 1
      this.history.unshift(existing)
      this.save()
      return { ...existing }
    }
    const entry: HistoryEntry = {
      id: makeId('hist', url, visitedAt),
      url,
      title: cleanTitle,
      visitedAt,
      visitCount: 1,
    }
    this.history.unshift(entry)
    if (this.history.length > this.maxHistory) {
      this.history.length = this.maxHistory
    }
    this.save()
    return { ...entry }
  }

  listHistory(query = ''): HistoryEntry[] {
    return this.history
      .filter((h) => matchesQuery([h.title, h.url], query))
      .map((h) => ({ ...h }))
  }

  removeHistory(urlOrId: string): boolean {
    const key = normalizeUrl(urlOrId)
    if (!key) return false
    const idx = this.history.findIndex((h) => h.id === key || h.url === key)
    if (idx < 0) return false
    this.history.splice(idx, 1)
    this.save()
    return true
  }

  clearHistory(): void {
    this.history = []
    this.save()
  }

  getCounts(): Record<SidebarTab, number> {
    return {
      bookmarks: this.bookmarks.length,
      history: this.history.length,
    }
  }
}

export function parseSidebarTab(raw: string | undefined): SidebarTab | undefined {
  if (!raw) return undefined
  const norm = raw.trim().toLowerCase()
  if (norm === 'bookmarks' || norm === 'bookmark' || norm === 'bm' || norm === 'b') return 'bookmarks'
  if (norm === 'history' || norm === 'hist' || norm === 'h') return 'history'
  return undefined
}

export function toggleSidebarTab(current: SidebarTab): SidebarTab {
  return current === 'bookmarks' ? 'history' : 'bookmarks'
}

export function createSidebarState(tab: SidebarTab = 'bookmarks'): SidebarState {
  return {
    tab,
    selectedIndex: 0,
    scrollOffset: 0,
    filterQuery: '',
    filtering: false,
  }
}

export function cloneSidebarState(state: SidebarState | null): SidebarState | null {
  if (!state) return null
  return { ...state }
}

export function computeSidebarLayout(totalWidth: number, sidebarRatio = 0.3): SidebarLayout {
  const clampedTotal = Math.max(40, Math.floor(totalWidth))
  if (clampedTotal < MIN_SIDEBAR_TOTAL_WIDTH) {
    return { canShow: false, sidebarWidth: 0, pageWidth: clampedTotal, gapWidth: 0 }
  }
  const gapWidth = 1
  const ratio = Math.max(0.22, Math.min(0.45, sidebarRatio))
  const desiredSidebar = Math.round(clampedTotal * ratio)
  let sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, desiredSidebar))
  let pageWidth = clampedTotal - sidebarWidth - gapWidth
  if (pageWidth < MIN_PAGE_WIDTH) {
    pageWidth = MIN_PAGE_WIDTH
    sidebarWidth = clampedTotal - pageWidth - gapWidth
  }
  if (sidebarWidth < MIN_SIDEBAR_WIDTH) {
    return { canShow: false, sidebarWidth: 0, pageWidth: clampedTotal, gapWidth: 0 }
  }
  return { canShow: true, sidebarWidth, pageWidth, gapWidth }
}

export function getSidebarItems(state: SidebarState, data: SidebarData): SidebarItem[] {
  if (state.tab === 'bookmarks') {
    return data.bookmarks
      .filter((b) => matchesQuery([b.title, b.url, ...(b.tags ?? [])], state.filterQuery))
      .map((b) => ({
        id: b.id,
        url: b.url,
        title: b.title,
        timestamp: b.addedAt,
        tags: b.tags,
      }))
  }
  return data.history
    .filter((h) => matchesQuery([h.title, h.url], state.filterQuery))
    .map((h) => ({
      id: h.id,
      url: h.url,
      title: h.title,
      timestamp: h.visitedAt,
      visitCount: h.visitCount,
    }))
}

export function moveSidebarSelection(
  state: SidebarState,
  itemCount: number,
  delta: number,
  wrap = true,
): SidebarState {
  if (itemCount <= 0) {
    return { ...state, selectedIndex: 0, scrollOffset: 0 }
  }
  let nextIndex = state.selectedIndex + delta
  if (wrap) {
    nextIndex = ((nextIndex % itemCount) + itemCount) % itemCount
  } else {
    nextIndex = Math.max(0, Math.min(itemCount - 1, nextIndex))
  }
  return {
    ...state,
    selectedIndex: nextIndex,
  }
}

function visibleLength(s: string): number {
  return stripAnsi(s).length
}

function truncateVisible(text: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  const plain = stripAnsi(text)
  if (plain.length <= maxLen) return plain
  if (maxLen <= 3) return plain.slice(0, maxLen)
  return `${plain.slice(0, maxLen - 3)}...`
}

function padLine(line: string, width: number, asciiOnly: boolean): string {
  const cleaned = asciiOnly ? sanitizeAscii(stripAnsi(line)) : line
  const vLen = visibleLength(cleaned)
  if (vLen === width) return cleaned
  if (vLen < width) return cleaned + ' '.repeat(width - vLen)
  const plain = stripAnsi(cleaned)
  return truncateVisible(asciiOnly ? sanitizeAscii(plain) : plain, width)
}

function formatShortTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '--:--'
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function shortenUrl(rawUrl: string, maxLen: number): string {
  const cleaned = rawUrl.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  try {
    const u = new URL(cleaned)
    const compact = u.pathname && u.pathname !== '/' ? `${u.host}${u.pathname}` : u.host
    if (compact.length <= maxLen) return compact
    return truncateVisible(compact, maxLen)
  } catch {
    return truncateVisible(cleaned, maxLen)
  }
}

function buildRow(
  box: { v: string },
  content: string,
  innerWidth: number,
  gutterChar: string | null,
  asciiOnly: boolean,
): string {
  const textWidth = gutterChar !== null ? Math.max(1, innerWidth - 1) : innerWidth
  const padded = padLine(content, textWidth, asciiOnly)
  if (gutterChar !== null) {
    return `${box.v} ${padded}${gutterChar} ${box.v}`
  }
  return `${box.v} ${padded} ${box.v}`
}

export function renderSidebarPane(
  state: SidebarState,
  data: SidebarData,
  opts: SidebarRenderOptions,
): SidebarRenderResult {
  const width = Math.max(MIN_SIDEBAR_WIDTH, Math.floor(opts.width))
  const height = Math.max(10, Math.floor(opts.height))
  const asciiOnly = Boolean(opts.asciiOnly)
  const color = asciiOnly ? false : Boolean(opts.color)

  const box = asciiOnly
    ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' }

  const innerWidth = Math.max(16, width - 4)
  const items = getSidebarItems(state, data)
  const counts: Record<SidebarTab, number> = {
    bookmarks: data.bookmarks.length,
    history: data.history.length,
  }

  const selectedIndex = items.length === 0 ? 0 : Math.max(0, Math.min(items.length - 1, state.selectedIndex))

  // Layout rows:
  // 1 top border
  // 1 tab bar row
  // 1 filter row (only if filtering or filterQuery non-empty)
  // 1 divider
  // N viewport rows
  // 1 divider
  // 1 detail URL row
  // 1 hint footer row
  // 1 bottom border
  const showFilterRow = state.filtering || state.filterQuery.length > 0
  const overhead = showFilterRow ? 8 : 7
  const viewportRows = Math.max(3, height - overhead)
  const maxScrollOffset = Math.max(0, items.length - viewportRows)

  let scrollOffset = Math.max(0, Math.min(maxScrollOffset, state.scrollOffset))
  if (items.length > 0) {
    if (selectedIndex < scrollOffset) {
      scrollOffset = selectedIndex
    } else if (selectedIndex >= scrollOffset + viewportRows) {
      scrollOffset = Math.min(maxScrollOffset, selectedIndex - viewportRows + 1)
    }
  }

  const scrollbar = computeScrollbarGutter(
    viewportRows,
    Math.max(1, items.length),
    viewportRows,
    scrollOffset,
    { asciiOnly, color },
  )
  const contentWidth = Math.max(8, innerWidth - 1)
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s)).replace(/\s+/g, ' ').trim()

  const lines: string[] = []
  const topTitle = state.tab === 'bookmarks' ? ' Bookmarks ' : ' History '
  const topDashBudget = Math.max(0, width - 2 - topTitle.length)
  const leftDash = Math.min(2, topDashBudget)
  const rightDash = Math.max(0, topDashBudget - leftDash)
  lines.push(`${box.tl}${box.h.repeat(leftDash)}${topTitle}${box.h.repeat(rightDash)}${box.tr}`)

  // Tab switcher row
  const bmLabel = `Bookmarks(${counts.bookmarks})`
  const histLabel = `History(${counts.history})`
  const bmCell =
    state.tab === 'bookmarks'
      ? color
        ? `${ANSI.bold}${ANSI.cyan}[${bmLabel}]${ANSI.reset}`
        : `[${bmLabel}]`
      : color
        ? `${ANSI.dim} ${bmLabel} ${ANSI.reset}`
        : ` ${bmLabel} `
  const histCell =
    state.tab === 'history'
      ? color
        ? `${ANSI.bold}${ANSI.cyan}[${histLabel}]${ANSI.reset}`
        : `[${histLabel}]`
      : color
        ? `${ANSI.dim} ${histLabel} ${ANSI.reset}`
        : ` ${histLabel} `
  lines.push(buildRow(box, `${bmCell} ${histCell}`, innerWidth, null, asciiOnly))

  if (showFilterRow) {
    const cursorMark = state.filtering ? '_' : ''
    const filterText = `/${clean(state.filterQuery)}${cursorMark}`
    const filterLine = color ? `${ANSI.yellow}${filterText}${ANSI.reset}` : filterText
    lines.push(buildRow(box, filterLine, innerWidth, null, asciiOnly))
  }

  lines.push(`${box.ml}${box.h.repeat(Math.max(1, width - 2))}${box.mr}`)

  // Viewport rows
  if (items.length === 0) {
    const emptyMsg = state.filterQuery
      ? `(no matches for "${truncateVisible(clean(state.filterQuery), Math.max(6, contentWidth - 18))}")`
      : state.tab === 'bookmarks'
        ? "(no bookmarks - press 'a')"
        : '(no history yet)'
    for (let r = 0; r < viewportRows; r += 1) {
      const text = r === 0 ? (color ? `${ANSI.dim}${emptyMsg}${ANSI.reset}` : emptyMsg) : ''
      lines.push(buildRow(box, text, innerWidth, scrollbar.chars[r] ?? ' ', asciiOnly))
    }
  } else {
    const visibleItems = items.slice(scrollOffset, scrollOffset + viewportRows)
    for (let r = 0; r < viewportRows; r += 1) {
      const item = visibleItems[r]
      const gutterChar = scrollbar.chars[r] ?? ' '
      if (!item) {
        lines.push(buildRow(box, '', innerWidth, gutterChar, asciiOnly))
        continue
      }
      const absIdx = scrollOffset + r
      const isSelected = absIdx === selectedIndex
      const isCurrent = Boolean(data.currentUrl && item.url === data.currentUrl)
      const pointer = isSelected ? '>' : isCurrent ? '*' : ' '

      let rowText: string
      if (state.tab === 'history') {
        const time = formatShortTime(item.timestamp)
        const countBadge = item.visitCount && item.visitCount > 1 ? ` x${item.visitCount}` : ''
        const titleBudget = Math.max(6, contentWidth - pointer.length - 1 - time.length - 1 - countBadge.length)
        const title = truncateVisible(clean(item.title || item.url), titleBudget)
        if (color) {
          if (isSelected) {
            const plain = truncateVisible(`${pointer} ${time} ${title}${countBadge}`, contentWidth)
            rowText = `${ANSI.inverse}${ANSI.bold}${plain}${ANSI.reset}`
          } else {
            rowText = `${pointer} ${ANSI.dim}${time}${ANSI.reset} ${title}${ANSI.dim}${countBadge}${ANSI.reset}`
          }
        } else {
          rowText = `${pointer} ${time} ${title}${countBadge}`
        }
      } else {
        const titleBudget = Math.max(6, contentWidth - pointer.length - 1)
        const title = truncateVisible(clean(item.title || item.url), titleBudget)
        if (color) {
          if (isSelected) {
            const plain = truncateVisible(`${pointer} ${title}`, contentWidth)
            rowText = `${ANSI.inverse}${ANSI.bold}${plain}${ANSI.reset}`
          } else if (isCurrent) {
            rowText = `${ANSI.green}${pointer}${ANSI.reset} ${title}`
          } else {
            rowText = `${pointer} ${title}`
          }
        } else {
          rowText = `${pointer} ${title}`
        }
      }
      lines.push(buildRow(box, rowText, innerWidth, gutterChar, asciiOnly))
    }
  }

  // Footer divider + selected URL detail + key hints
  lines.push(`${box.ml}${box.h.repeat(Math.max(1, width - 2))}${box.mr}`)
  const selectedItem = items[selectedIndex]
  const detailText = selectedItem
    ? shortenUrl(clean(selectedItem.url), innerWidth)
    : data.currentUrl
      ? shortenUrl(clean(data.currentUrl), innerWidth)
      : '(none selected)'
  lines.push(
    buildRow(
      box,
      color ? `${ANSI.cyan}${detailText}${ANSI.reset}` : detailText,
      innerWidth,
      null,
      asciiOnly,
    ),
  )

  const hintsText = state.filtering
    ? 'Type filter | Ent done | Esc clear'
    : 'Ent go | o tab | a add | d del | / flt'
  lines.push(
    buildRow(
      box,
      color ? `${ANSI.dim}${truncateVisible(hintsText, innerWidth)}${ANSI.reset}` : truncateVisible(hintsText, innerWidth),
      innerWidth,
      null,
      asciiOnly,
    ),
  )

  lines.push(`${box.bl}${box.h.repeat(Math.max(1, width - 2))}${box.br}`)

  return {
    lines,
    items,
    selectedIndex,
    scrollOffset,
    maxScrollOffset,
    viewportRows,
    counts,
  }
}

export function composeSidebarFrame(
  sidebarLines: string[],
  pageFrame: string,
  opts: { sidebarWidth: number; pageWidth: number; gapWidth?: number; asciiOnly?: boolean; color?: boolean },
): string {
  const asciiOnly = Boolean(opts.asciiOnly)
  const color = asciiOnly ? false : Boolean(opts.color)
  const gapChar = asciiOnly ? '|' : '│'
  const divider = (opts.gapWidth ?? 1) > 0 ? (color ? `${ANSI.dim}${gapChar}${ANSI.reset}` : gapChar) : ''
  const rightLines = pageFrame.split('\n')
  const totalRows = Math.max(sidebarLines.length, rightLines.length)
  const out: string[] = []
  for (let i = 0; i < totalRows; i += 1) {
    const left = padLine(sidebarLines[i] ?? '', opts.sidebarWidth, asciiOnly)
    const right = padLine(rightLines[i] ?? '', opts.pageWidth, asciiOnly)
    out.push(`${left}${divider}${right}`)
  }
  return out.join('\n')
}

export function formatSidebarStatus(
  state: SidebarState,
  items: SidebarItem[],
  opts: { asciiOnly?: boolean } = {},
): string {
  const label = state.tab === 'bookmarks' ? 'BOOKMARKS' : 'HISTORY'
  const count = items.length
  const pos = count > 0 ? `${Math.min(state.selectedIndex + 1, count)}/${count}` : '0/0'
  const filterInfo = state.filtering
    ? ` /${state.filterQuery}_`
    : state.filterQuery
      ? ` filter:"${state.filterQuery}"`
      : ''
  const raw = `SIDEBAR ${label} (${pos})${filterInfo} | j/k move | Enter open | o new tab | a add | d del | Tab switch | Esc close`
  return opts.asciiOnly ? sanitizeAscii(raw) : raw
}
