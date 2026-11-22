// Spatial DOM-to-ASCII and ANSI viewport renderer.
// Designed so both AI agents (even in strict 7-bit ASCII mode) and humans over SSH/EC2
// can inspect and drive any live web page directly inside a terminal.

import type { AsciiRenderOptions, ContentBlock, PageSnapshot } from '../types.js'

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
      return wrapText(clean(block.text), innerWidth)
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
      const fieldWidth = Math.max(12, Math.min(36, innerWidth - label.length - 14))
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
      const lines = wrapText(clean(block.text), Math.max(10, innerWidth - 2))
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

export function renderPageAscii(snapshot: PageSnapshot, options: AsciiRenderOptions = {}): string {
  const width = Math.max(40, Math.min(240, options.width ?? 100))
  const height = Math.max(14, Math.min(200, options.height ?? 36))
  const asciiOnly = options.asciiOnly ?? true
  const color = asciiOnly ? false : (options.color ?? false)
  const showRefs = options.showRefs ?? true
  const showChrome = options.showChrome ?? true
  const scrollOffset = Math.max(0, options.scrollOffset ?? 0)

  const box = asciiOnly
    ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' }

  const innerWidth = width - 4 // "| " + content + " |"
  const topBorder = `${box.tl}${box.h.repeat(width - 2)}${box.tr}`
  const midBorder = `${box.ml}${box.h.repeat(width - 2)}${box.mr}`
  const botBorder = `${box.bl}${box.h.repeat(width - 2)}${box.br}`
  const frameLine = (content: string) => `${box.v} ${padLine(content, innerWidth, asciiOnly)} ${box.v}`

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
    const pct =
      snapshot.viewport.scrollHeight > snapshot.viewport.height
        ? Math.min(100, Math.round((snapshot.viewport.scrollY / Math.max(1, snapshot.viewport.scrollHeight - snapshot.viewport.height)) * 100))
        : 100
    const urlLine = `URL: ${urlStr}`
    const posTag = `scroll:${pct}%`
    const spacer = Math.max(1, innerWidth - visibleLength(urlLine) - posTag.length)
    output.push(frameLine(`${truncateVisible(urlLine, innerWidth - posTag.length - 1)}${' '.repeat(spacer)}${posTag}`))
    output.push(midBorder)
  }

  // Render content blocks into lines
  const bodyLines: string[] = []
  if (snapshot.title) {
    const t = asciiOnly ? sanitizeAscii(snapshot.title) : snapshot.title
    bodyLines.push(color ? `${ANSI.bold}${t}${ANSI.reset}` : `TITLE: ${t}`)
    bodyLines.push((asciiOnly ? '-' : '─').repeat(Math.min(innerWidth, Math.max(12, t.length + 7))))
  }

  for (const block of snapshot.blocks) {
    const rendered = formatBlock(block, innerWidth, asciiOnly, color, showRefs)
    if (rendered.length > 0) {
      bodyLines.push(...rendered)
      if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'code') {
        bodyLines.push('')
      }
    }
  }

  // Append interactive refs index if page had elements not already emitted in blocks
  const emittedRefs = new Set(snapshot.blocks.map((b) => b.ref).filter(Boolean))
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

  for (let i = 0; i < viewportRows; i++) {
    const line = visible[i] ?? ''
    output.push(showChrome ? frameLine(line) : padLine(line, innerWidth, asciiOnly))
  }

  if (showChrome) {
    output.push(midBorder)
    const refCount = snapshot.elements.filter((e) => e.ref).length
    const lineRange = `lines ${start + 1}-${Math.min(bodyLines.length, start + viewportRows)}/${bodyLines.length}`
    const status = options.statusMessage
      ? `${options.statusMessage} | refs:${refCount} | ${lineRange}`
      : `refs:${refCount} | epoch:${snapshot.epoch} | ${lineRange} | cmds: open click fill find scroll`
    output.push(frameLine(status))
    output.push(botBorder)
  }

  const result = output.join('\n')
  return asciiOnly ? sanitizeAscii(result) : result
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
