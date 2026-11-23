// Split-pane right-hand Inspector renderer for the Terminal Browser TUI.
// Displays live Console, Network, Refs, and Agent Activity panes side-by-side
// with the left ASCII page viewport.

import { computeScrollbarGutter } from '../ascii/layout.js'
import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'
import type {
  AgentActivityEntry,
  ConsoleEntry,
  ElementDescriptor,
  NetworkEntry,
} from '../types.js'

export type InspectorTab = 'console' | 'network' | 'refs' | 'activity'

export const INSPECTOR_TABS: readonly InspectorTab[] = ['console', 'network', 'refs', 'activity']

export type ActivePane = 'page' | 'inspector'

export interface InspectorData {
  consoleEntries: ConsoleEntry[]
  networkEntries: NetworkEntry[]
  elements: ElementDescriptor[]
  activityEntries: AgentActivityEntry[]
  focusedRef?: string | null
}

export interface InspectorRenderOptions {
  width: number
  height: number
  activeTab: InspectorTab
  scrollOffset?: number
  asciiOnly?: boolean
  color?: boolean
  activePane?: ActivePane
}

export interface InspectorRenderResult {
  lines: string[]
  scrollOffset: number
  maxScrollOffset: number
  totalLines: number
  viewportRows: number
  counts: Record<InspectorTab, number>
}

export interface SplitPaneLayout {
  canSplit: boolean
  leftWidth: number
  rightWidth: number
  gapWidth: number
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  inverse: '\x1b[7m',
} as const

const MIN_SPLIT_TOTAL_WIDTH = 72
const MIN_LEFT_WIDTH = 42
const MIN_RIGHT_WIDTH = 28
const MAX_RIGHT_WIDTH = 72

export function parseInspectorTab(raw: string | undefined): InspectorTab | undefined {
  if (!raw) return undefined
  const norm = raw.trim().toLowerCase()
  if (norm === 'console' || norm === 'con' || norm === 'logs' || norm === '1') return 'console'
  if (norm === 'network' || norm === 'net' || norm === 'http' || norm === '2') return 'network'
  if (norm === 'refs' || norm === 'ref' || norm === 'elements' || norm === 'dom' || norm === '3') return 'refs'
  if (norm === 'activity' || norm === 'act' || norm === 'agent' || norm === '4') return 'activity'
  return undefined
}

export function cycleInspectorTab(current: InspectorTab, delta: 1 | -1): InspectorTab {
  const idx = INSPECTOR_TABS.indexOf(current)
  const safeIdx = idx >= 0 ? idx : 0
  return INSPECTOR_TABS[(safeIdx + delta + INSPECTOR_TABS.length) % INSPECTOR_TABS.length]!
}

export function computeSplitPaneWidths(totalWidth: number, leftRatio = 0.62): SplitPaneLayout {
  const clampedTotal = Math.max(40, Math.floor(totalWidth))
  if (clampedTotal < MIN_SPLIT_TOTAL_WIDTH) {
    return { canSplit: false, leftWidth: clampedTotal, rightWidth: 0, gapWidth: 0 }
  }
  const gapWidth = 1
  const ratio = Math.max(0.45, Math.min(0.75, leftRatio))
  const desiredRight = Math.round(clampedTotal * (1 - ratio))
  let rightWidth = Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, desiredRight))
  let leftWidth = clampedTotal - rightWidth - gapWidth
  if (leftWidth < MIN_LEFT_WIDTH) {
    leftWidth = MIN_LEFT_WIDTH
    rightWidth = clampedTotal - leftWidth - gapWidth
  }
  if (rightWidth < MIN_RIGHT_WIDTH) {
    return { canSplit: false, leftWidth: clampedTotal, rightWidth: 0, gapWidth: 0 }
  }
  return { canSplit: true, leftWidth, rightWidth, gapWidth }
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

function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '--:--:--'
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function shortenUrlForInspector(rawUrl: string, maxLen: number): string {
  const cleaned = rawUrl.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  try {
    const u = new URL(cleaned)
    const compact = `${u.pathname}${u.search}` || '/'
    if (compact.length <= maxLen) return compact
    return truncateVisible(compact, maxLen)
  } catch {
    return truncateVisible(cleaned, maxLen)
  }
}

function formatConsoleLines(
  entries: ConsoleEntry[],
  innerWidth: number,
  asciiOnly: boolean,
  color: boolean,
): string[] {
  if (entries.length === 0) {
    return [color ? `${ANSI.dim}(no console messages)${ANSI.reset}` : '(no console messages)']
  }
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s)).replace(/\s+/g, ' ').trim()
  const lines: string[] = []
  for (const entry of entries) {
    const tagMap: Record<ConsoleEntry['level'], string> = {
      error: 'ERR',
      warning: 'WRN',
      info: 'INF',
      debug: 'DBG',
      log: 'LOG',
    }
    const tag = tagMap[entry.level] ?? 'LOG'
    const time = formatClock(entry.ts)
    const prefixPlain = `[${tag}] ${time} `
    const msgBudget = Math.max(8, innerWidth - prefixPlain.length)
    const msg = truncateVisible(clean(entry.text || ''), msgBudget)
    if (!color) {
      lines.push(`${prefixPlain}${msg}`)
    } else {
      const levelColor =
        entry.level === 'error'
          ? ANSI.red
          : entry.level === 'warning'
            ? ANSI.yellow
            : entry.level === 'info'
              ? ANSI.cyan
              : ANSI.dim
      lines.push(`${levelColor}[${tag}]${ANSI.reset} ${ANSI.dim}${time}${ANSI.reset} ${msg}`)
    }
  }
  return lines
}

function formatNetworkLines(
  entries: NetworkEntry[],
  innerWidth: number,
  asciiOnly: boolean,
  color: boolean,
): string[] {
  if (entries.length === 0) {
    return [color ? `${ANSI.dim}(no network requests)${ANSI.reset}` : '(no network requests)']
  }
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s)).replace(/\s+/g, ' ').trim()
  const lines: string[] = []
  for (const entry of entries) {
    const method = clean(entry.method || 'GET').toUpperCase().slice(0, 6)
    const statusStr = entry.blocked
      ? 'BLK'
      : entry.status !== undefined
        ? String(entry.status)
        : entry.ok
          ? 'OK'
          : 'ERR'
    const flags: string[] = []
    if (entry.fromCache || entry.cacheStatus === 'hit') flags.push('CACHE')
    else if (entry.cacheStatus === 'revalidated') flags.push('304')
    if (entry.blocked) flags.push('BLOCKED')
    if (typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)) {
      flags.push(`${Math.round(entry.durationMs)}ms`)
    }
    const suffix = flags.length > 0 ? ` (${flags.join(',')})` : ''
    const headPlain = `${method} ${statusStr} `
    const urlBudget = Math.max(8, innerWidth - headPlain.length - suffix.length)
    const urlStr = shortenUrlForInspector(clean(entry.url || ''), urlBudget)
    if (!color) {
      lines.push(`${headPlain}${urlStr}${suffix}`)
    } else {
      const statusColor = entry.blocked
        ? ANSI.magenta
        : !entry.ok || (entry.status !== undefined && entry.status >= 400)
          ? ANSI.red
          : entry.status !== undefined && entry.status >= 300
            ? ANSI.yellow
            : ANSI.green
      lines.push(
        `${ANSI.bold}${method}${ANSI.reset} ${statusColor}${statusStr}${ANSI.reset} ${urlStr}${ANSI.dim}${suffix}${ANSI.reset}`,
      )
    }
  }
  return lines
}

function formatRefsLines(
  elements: ElementDescriptor[],
  focusedRef: string | null | undefined,
  innerWidth: number,
  asciiOnly: boolean,
  color: boolean,
): string[] {
  const withRefs = elements.filter((el) => typeof el.ref === 'string' && el.ref.length > 0)
  if (withRefs.length === 0) {
    return [color ? `${ANSI.dim}(no interactive refs)${ANSI.reset}` : '(no interactive refs)']
  }
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s)).replace(/\s+/g, ' ').trim()
  const lines: string[] = []
  for (const el of withRefs) {
    const ref = el.ref!
    const isFocused = Boolean(focusedRef && ref === focusedRef)
    const marker = isFocused ? '>' : ' '
    const tagDesc = el.type && el.type !== el.tag ? `${el.tag}:${el.type}` : el.tag
    const label = clean(el.text || el.label || el.ariaLabel || el.placeholder || el.name || el.href || '')
    const headPlain = `${marker}[${ref}] <${tagDesc}> `
    const labelBudget = Math.max(6, innerWidth - headPlain.length)
    const labelText = label ? truncateVisible(label, labelBudget) : ''
    if (!color) {
      lines.push(`${headPlain}${labelText}`)
    } else if (isFocused) {
      lines.push(`${ANSI.bold}${ANSI.inverse}${truncateVisible(`${headPlain}${labelText}`, innerWidth)}${ANSI.reset}`)
    } else {
      lines.push(` ${ANSI.yellow}[${ref}]${ANSI.reset} ${ANSI.dim}<${tagDesc}>${ANSI.reset} ${labelText}`)
    }
  }
  return lines
}

function formatActivityLines(
  entries: AgentActivityEntry[],
  innerWidth: number,
  asciiOnly: boolean,
  color: boolean,
): string[] {
  if (entries.length === 0) {
    return [color ? `${ANSI.dim}(no agent activity yet)${ANSI.reset}` : '(no agent activity yet)']
  }
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s)).replace(/\s+/g, ' ').trim()
  const lines: string[] = []
  // Newest first so live activity is immediately visible at the top of the pane
  const ordered = [...entries].reverse()
  for (const entry of ordered) {
    const status = entry.ok ? 'OK' : 'ERR'
    const dur = `${Math.max(0, Math.round(entry.durationMs))}ms`
    const headPlain = `#${entry.id} [${status}] ${clean(entry.tool)} `
    const tailPlain = ` (${dur})`
    const detailSource = entry.error ? `err: ${entry.error}` : entry.summary
    const detailClean = clean(detailSource || '')
    const detailBudget = Math.max(4, innerWidth - headPlain.length - tailPlain.length)
    const detail = detailClean && detailClean !== entry.tool ? truncateVisible(detailClean, detailBudget) : ''
    if (!color) {
      lines.push(`${headPlain}${detail}${tailPlain}`)
    } else {
      const statusColor = entry.ok ? ANSI.green : ANSI.red
      lines.push(
        `${ANSI.dim}#${entry.id}${ANSI.reset} ${statusColor}[${status}]${ANSI.reset} ${ANSI.cyan}${clean(entry.tool)}${ANSI.reset} ${detail}${ANSI.dim}${tailPlain}${ANSI.reset}`,
      )
    }
  }
  return lines
}

function renderTabBar(
  activeTab: InspectorTab,
  counts: Record<InspectorTab, number>,
  innerWidth: number,
  color: boolean,
): string {
  const fullLabels: Record<InspectorTab, string> = {
    console: 'Console',
    network: 'Network',
    refs: 'Refs',
    activity: 'Activity',
  }
  const shortLabels: Record<InspectorTab, string> = {
    console: 'Con',
    network: 'Net',
    refs: 'Ref',
    activity: 'Act',
  }

  const buildPlain = (labels: Record<InspectorTab, string>) =>
    INSPECTOR_TABS.map((tab, idx) => {
      const label = `${idx + 1}:${labels[tab]}(${counts[tab]})`
      return tab === activeTab ? `[${label}]` : label
    }).join(' ')

  const useFull = buildPlain(fullLabels).length <= innerWidth
  const labels = useFull ? fullLabels : shortLabels

  if (!color) {
    return truncateVisible(buildPlain(labels), innerWidth)
  }

  const colored = INSPECTOR_TABS.map((tab, idx) => {
    const label = `${idx + 1}:${labels[tab]}(${counts[tab]})`
    if (tab === activeTab) {
      return `${ANSI.bold}${ANSI.cyan}[${label}]${ANSI.reset}`
    }
    return `${ANSI.dim}${label}${ANSI.reset}`
  }).join(' ')

  if (visibleLength(colored) > innerWidth) {
    return truncateVisible(buildPlain(labels), innerWidth)
  }
  return colored
}

export function renderInspectorPane(
  data: InspectorData,
  opts: InspectorRenderOptions,
): InspectorRenderResult {
  const width = Math.max(24, Math.floor(opts.width))
  const height = Math.max(12, Math.floor(opts.height))
  const asciiOnly = opts.asciiOnly ?? false
  const color = asciiOnly ? false : (opts.color ?? false)
  const activePane = opts.activePane ?? 'page'
  const activeTab = opts.activeTab

  const counts: Record<InspectorTab, number> = {
    console: data.consoleEntries.length,
    network: data.networkEntries.length,
    refs: data.elements.filter((el) => typeof el.ref === 'string' && el.ref.length > 0).length,
    activity: data.activityEntries.length,
  }

  const box = asciiOnly
    ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' }

  const innerWidth = Math.max(16, width - 4)
  const topBorder = `${box.tl}${box.h.repeat(width - 2)}${box.tr}`
  const midBorder = `${box.ml}${box.h.repeat(width - 2)}${box.mr}`
  const botBorder = `${box.bl}${box.h.repeat(width - 2)}${box.br}`
  const frameLine = (content: string, rightEdge: string = box.v) =>
    `${box.v} ${padLine(content, innerWidth, asciiOnly)} ${rightEdge}`

  let bodyLines: string[]
  switch (activeTab) {
    case 'console':
      bodyLines = formatConsoleLines(data.consoleEntries, innerWidth, asciiOnly, color)
      break
    case 'network':
      bodyLines = formatNetworkLines(data.networkEntries, innerWidth, asciiOnly, color)
      break
    case 'refs':
      bodyLines = formatRefsLines(data.elements, data.focusedRef, innerWidth, asciiOnly, color)
      break
    case 'activity':
      bodyLines = formatActivityLines(data.activityEntries, innerWidth, asciiOnly, color)
      break
  }

  // Chrome rows: topBorder, header, tabBar, midBorder, footerDivider, footer, botBorder -> 7 rows
  // Wait: renderPageAsciiWithMetrics uses 6 chrome rows (top, tabbar, url, mid, body..., mid, status, bot = 7? Let's match exact height!).
  // Actually, chrome lines here: topBorder (1) + header (1) + tabBar (1) + midBorder (1) + midBorder (1) + footer (1) + botBorder (1) = 7.
  // So viewportRows = Math.max(4, height - 7) and total output lines = viewportRows + 7 = Math.max(11, height).
  const chromeRows = 7
  const viewportRows = Math.max(4, height - chromeRows)
  const maxScrollOffset = Math.max(0, bodyLines.length - viewportRows)
  const scrollOffset = Math.max(0, Math.min(opts.scrollOffset ?? 0, maxScrollOffset))
  const visible = bodyLines.slice(scrollOffset, scrollOffset + viewportRows)

  const scrollbar = computeScrollbarGutter(viewportRows, bodyLines.length, viewportRows, scrollOffset, {
    asciiOnly,
    color,
  })

  const focusBadge = activePane === 'inspector' ? ' [ACTIVE]' : ''
  const scrollInfo = bodyLines.length > viewportRows ? ` ${scrollbar.percent}%` : ''
  const titlePlain = `INSPECTOR${focusBadge} (${counts[activeTab]})${scrollInfo}`
  const titleLine =
    color && activePane === 'inspector'
      ? `${ANSI.bold}${ANSI.cyan}${truncateVisible(titlePlain, innerWidth)}${ANSI.reset}`
      : color
        ? `${ANSI.bold}${truncateVisible(titlePlain, innerWidth)}${ANSI.reset}`
        : truncateVisible(titlePlain, innerWidth)

  const tabBarLine = renderTabBar(activeTab, counts, innerWidth, color)

  const footerText =
    activePane === 'inspector'
      ? 'j/k:scroll 1-4/[:]:tab I:page i:close'
      : 'i:close [:prev ]:next I:focus'
  const footerLine = color
    ? `${ANSI.dim}${truncateVisible(footerText, innerWidth)}${ANSI.reset}`
    : truncateVisible(footerText, innerWidth)

  const lines: string[] = [
    topBorder,
    frameLine(titleLine),
    frameLine(tabBarLine),
    midBorder,
  ]

  for (let row = 0; row < viewportRows; row++) {
    const content = visible[row] ?? ''
    const rightEdge = scrollbar.chars[row] ?? box.v
    lines.push(frameLine(content, rightEdge))
  }

  lines.push(midBorder)
  lines.push(frameLine(footerLine))
  lines.push(botBorder)

  return {
    lines,
    scrollOffset,
    maxScrollOffset,
    totalLines: bodyLines.length,
    viewportRows,
    counts,
  }
}

export function composeSplitPaneFrame(
  leftFrame: string,
  rightLines: string[],
  opts: { leftWidth: number; rightWidth: number; gapWidth?: number; asciiOnly?: boolean },
): string {
  const leftLines = leftFrame.split('\n')
  const gap = ' '.repeat(Math.max(0, opts.gapWidth ?? 1))
  const asciiOnly = opts.asciiOnly ?? false
  const totalRows = Math.max(leftLines.length, rightLines.length)
  const composed: string[] = []

  for (let i = 0; i < totalRows; i++) {
    const left = padLine(leftLines[i] ?? '', opts.leftWidth, asciiOnly)
    const right = padLine(rightLines[i] ?? '', opts.rightWidth, asciiOnly)
    composed.push(`${left}${gap}${right}`)
  }

  return composed.join('\n')
}
