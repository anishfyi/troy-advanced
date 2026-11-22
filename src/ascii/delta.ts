// ASCII diff renderer for `--since` structural page deltas.
// Renders added (+), removed (-), and changed (~) elements, metadata, and text lines
// in strict 7-bit ASCII (or optional ANSI color) with density profile support.

import type { PageDelta } from '../agent/delta.js'
import type { AsciiDensity, ElementDescriptor } from '../types.js'
import { resolveDensityProfile } from './layout.js'
import { sanitizeAscii, stripAnsi } from './sanitize.js'

export interface DeltaAsciiOptions {
  width?: number
  asciiOnly?: boolean
  color?: boolean
  showChrome?: boolean
  density?: AsciiDensity
  maxElements?: number
  maxLines?: number
  previousTitle?: string
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
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

function wrapPrefixed(prefix: string, content: string, maxWidth: number): string[] {
  const clean = content.replace(/\s+/g, ' ').trim()
  const firstAvail = Math.max(12, maxWidth - prefix.length)
  if (clean.length <= firstAvail) {
    return [`${prefix}${clean}`]
  }
  const contPrefix = ' '.repeat(prefix.length)
  const words = clean.split(' ')
  const lines: string[] = []
  let current = ''
  let isFirst = true

  const flush = () => {
    lines.push(`${isFirst ? prefix : contPrefix}${current}`)
    current = ''
    isFirst = false
  }

  for (const word of words) {
    const limit = firstAvail
    if (!current) {
      if (word.length <= limit) {
        current = word
      } else {
        for (let i = 0; i < word.length; i += limit) {
          const chunk = word.slice(i, i + limit)
          if (i + limit < word.length) {
            lines.push(`${isFirst ? prefix : contPrefix}${chunk}`)
            isFirst = false
          } else {
            current = chunk
          }
        }
      }
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`
    } else {
      flush()
      if (word.length <= limit) {
        current = word
      } else {
        for (let i = 0; i < word.length; i += limit) {
          const chunk = word.slice(i, i + limit)
          if (i + limit < word.length) {
            lines.push(`${isFirst ? prefix : contPrefix}${chunk}`)
            isFirst = false
          } else {
            current = chunk
          }
        }
      }
    }
  }
  if (current) flush()
  return lines
}

function formatElementLabel(el: ElementDescriptor, asciiOnly: boolean): string {
  const raw = el.text || el.label || el.ariaLabel || el.placeholder || el.name || ''
  const label = (asciiOnly ? sanitizeAscii(raw) : raw).replace(/\s+/g, ' ').trim()
  const refPart = el.ref ? `[${el.ref}] ` : ''
  const tagPart = `<${el.tag}${el.type && el.type !== el.tag ? `:${el.type}` : ''}>`
  const textPart = label ? ` "${truncateVisible(label, 52)}"` : ''
  const extras: string[] = []
  if (el.value !== undefined && el.value !== '') {
    const val = (asciiOnly ? sanitizeAscii(el.value) : el.value).replace(/\s+/g, ' ').trim()
    extras.push(`val="${truncateVisible(val, 28)}"`)
  }
  if (el.href) {
    const href = asciiOnly ? sanitizeAscii(el.href) : el.href
    extras.push(`href="${truncateVisible(href, 36)}"`)
  }
  if (el.checked === true) extras.push('checked')
  if (el.disabled === true) extras.push('disabled')
  return `${refPart}${tagPart}${textPart}${extras.length ? ` ${extras.join(' ')}` : ''}`
}

function formatRemovedElement(
  el: PageDelta['removedElements'][number],
  asciiOnly: boolean,
): string {
  const raw = el.text || ''
  const label = (asciiOnly ? sanitizeAscii(raw) : raw).replace(/\s+/g, ' ').trim()
  const refPart = el.ref ? `[${el.ref}] ` : ''
  const textPart = label ? ` "${truncateVisible(label, 52)}"` : ''
  return `${refPart}<${el.tag}>${textPart}`
}

function formatChangedElement(
  el: PageDelta['changedElements'][number],
  asciiOnly: boolean,
): string {
  const clean = (s: string | undefined) => {
    const v = (s ?? '').replace(/\s+/g, ' ').trim()
    return asciiOnly ? sanitizeAscii(v) : v
  }
  const refPart = el.ref ? `[${el.ref}] ` : ''
  const diffs: string[] = []
  if (el.before.text !== el.after.text) {
    diffs.push(`text:"${truncateVisible(clean(el.before.text), 24)}"->"${truncateVisible(clean(el.after.text), 24)}"`)
  }
  if (el.before.value !== el.after.value) {
    diffs.push(`val:"${truncateVisible(clean(el.before.value), 24)}"->"${truncateVisible(clean(el.after.value), 24)}"`)
  }
  if (el.before.checked !== el.after.checked) {
    diffs.push(`checked:${Boolean(el.before.checked)}->${Boolean(el.after.checked)}`)
  }
  if (el.before.disabled !== el.after.disabled) {
    diffs.push(`disabled:${Boolean(el.before.disabled)}->${Boolean(el.after.disabled)}`)
  }
  return `${refPart}<${el.tag}> ${diffs.join(', ')}`
}

export function renderDeltaAscii(delta: PageDelta, options: DeltaAsciiOptions = {}): string {
  const profile = resolveDensityProfile(options.density)
  const width = Math.max(40, Math.min(200, options.width ?? profile.defaultWidth))
  const asciiOnly = options.asciiOnly !== false
  const color = Boolean(options.color) && !asciiOnly
  const showChrome = options.showChrome ?? profile.defaultShowChrome
  const innerWidth = showChrome ? width - 4 : width

  const defaultMaxElements = profile.name === 'compact' ? 12 : profile.name === 'wide' ? 80 : 40
  const defaultMaxLines = profile.name === 'compact' ? 10 : profile.name === 'wide' ? 60 : 30
  const maxElements = Math.max(1, options.maxElements ?? defaultMaxElements)
  const maxLines = Math.max(1, options.maxLines ?? defaultMaxLines)

  const paint = (text: string, code: string) => (color ? `${code}${text}${ANSI.reset}` : text)
  const cleanText = (s: string) => (asciiOnly ? sanitizeAscii(s) : stripAnsi(s))

  const summaryStats = `+${delta.addedElements.length} -${delta.removedElements.length} ~${delta.changedElements.length} elems | +${delta.addedLines.length} -${delta.removedLines.length} lines`

  const bodyLines: string[] = []

  if (!delta.changed) {
    bodyLines.push(paint('(no changes since previous snapshot)', ANSI.dim))
  } else {
    // Metadata changes
    if (delta.urlChanged) {
      const prevUrl = cleanText(delta.previousUrl || 'about:blank')
      const nextUrl = cleanText(delta.url || 'about:blank')
      const oneLine = `~ URL: ${prevUrl} -> ${nextUrl}`
      if (oneLine.length <= innerWidth) {
        bodyLines.push(paint(oneLine, ANSI.yellow))
      } else {
        bodyLines.push(paint(`- URL: ${truncateVisible(prevUrl, innerWidth - 7)}`, ANSI.red))
        bodyLines.push(paint(`+ URL: ${truncateVisible(nextUrl, innerWidth - 7)}`, ANSI.green))
      }
    }

    if (delta.titleChanged) {
      const prevTitle = options.previousTitle ?? delta.previousTitle
      const nextTitle = cleanText(delta.title || '(untitled)')
      if (prevTitle !== undefined) {
        const cleanPrev = cleanText(prevTitle || '(untitled)')
        const line = `~ TITLE: "${truncateVisible(cleanPrev, 32)}" -> "${truncateVisible(nextTitle, 32)}"`
        bodyLines.push(paint(truncateVisible(line, innerWidth), ANSI.yellow))
      } else {
        const line = `~ TITLE: "${truncateVisible(nextTitle, innerWidth - 11)}"`
        bodyLines.push(paint(line, ANSI.yellow))
      }
    }

    // Elements section
    const hasElemChanges =
      delta.addedElements.length > 0 ||
      delta.removedElements.length > 0 ||
      delta.changedElements.length > 0

    if (hasElemChanges) {
      if (bodyLines.length > 0 && profile.addSpacing) bodyLines.push('')
      bodyLines.push(
        paint(
          `ELEMENTS (+${delta.addedElements.length} -${delta.removedElements.length} ~${delta.changedElements.length}):`,
          ANSI.bold + ANSI.cyan,
        ),
      )

      const addedSlice = delta.addedElements.slice(0, maxElements)
      for (const el of addedSlice) {
        const formatted = formatElementLabel(el, asciiOnly)
        for (const line of wrapPrefixed('+ ', formatted, innerWidth)) {
          bodyLines.push(paint(line, ANSI.green))
        }
      }
      if (delta.addedElements.length > maxElements) {
        bodyLines.push(paint(`+ ... (+${delta.addedElements.length - maxElements} more added elements)`, ANSI.dim))
      }

      const changedSlice = delta.changedElements.slice(0, maxElements)
      for (const el of changedSlice) {
        const formatted = formatChangedElement(el, asciiOnly)
        for (const line of wrapPrefixed('~ ', formatted, innerWidth)) {
          bodyLines.push(paint(line, ANSI.yellow))
        }
      }
      if (delta.changedElements.length > maxElements) {
        bodyLines.push(paint(`~ ... (+${delta.changedElements.length - maxElements} more changed elements)`, ANSI.dim))
      }

      const removedSlice = delta.removedElements.slice(0, maxElements)
      for (const el of removedSlice) {
        const formatted = formatRemovedElement(el, asciiOnly)
        for (const line of wrapPrefixed('- ', formatted, innerWidth)) {
          bodyLines.push(paint(line, ANSI.red))
        }
      }
      if (delta.removedElements.length > maxElements) {
        bodyLines.push(paint(`- ... (+${delta.removedElements.length - maxElements} more removed elements)`, ANSI.dim))
      }
    }

    // Text lines section
    const hasTextChanges = delta.addedLines.length > 0 || delta.removedLines.length > 0
    if (hasTextChanges) {
      if (bodyLines.length > 0 && profile.addSpacing) bodyLines.push('')
      bodyLines.push(
        paint(
          `TEXT (+${delta.addedLines.length} -${delta.removedLines.length}):`,
          ANSI.bold + ANSI.cyan,
        ),
      )

      const addedLinesSlice = delta.addedLines.slice(0, maxLines)
      for (const l of addedLinesSlice) {
        const clean = cleanText(l)
        for (const line of wrapPrefixed('+ ', clean, innerWidth)) {
          bodyLines.push(paint(line, ANSI.green))
        }
      }
      if (delta.addedLines.length > maxLines) {
        bodyLines.push(paint(`+ ... (+${delta.addedLines.length - maxLines} more added lines)`, ANSI.dim))
      }

      const removedLinesSlice = delta.removedLines.slice(0, maxLines)
      for (const l of removedLinesSlice) {
        const clean = cleanText(l)
        for (const line of wrapPrefixed('- ', clean, innerWidth)) {
          bodyLines.push(paint(line, ANSI.red))
        }
      }
      if (delta.removedLines.length > maxLines) {
        bodyLines.push(paint(`- ... (+${delta.removedLines.length - maxLines} more removed lines)`, ANSI.dim))
      }
    }
  }

  const output: string[] = []
  if (showChrome) {
    const border = `+${'-'.repeat(width - 2)}+`
    const padFrame = (content: string) => {
      const cleaned = asciiOnly ? sanitizeAscii(stripAnsi(content)) : content
      const vlen = visibleLength(cleaned)
      if (vlen > innerWidth) {
        const cut = truncateVisible(stripAnsi(cleaned), innerWidth)
        return `| ${cut}${' '.repeat(Math.max(0, innerWidth - cut.length))} |`
      }
      return `| ${cleaned}${' '.repeat(Math.max(0, innerWidth - vlen))} |`
    }

    output.push(border)
    const statusBadge = delta.changed ? 'CHANGED' : 'NO CHANGES'
    const headerTitle = `TROY-ADV DELTA [${statusBadge}]`
    const urlTag = truncateVisible(cleanText(delta.url || 'about:blank'), Math.max(12, innerWidth - headerTitle.length - 3))
    const spacer = Math.max(1, innerWidth - headerTitle.length - urlTag.length)
    output.push(padFrame(`${headerTitle}${' '.repeat(spacer)}${urlTag}`))
    output.push(border)

    for (const line of bodyLines) {
      output.push(padFrame(line))
    }

    output.push(border)
    const densityTag = profile.name !== 'normal' ? ` | density:${profile.name}` : ''
    output.push(padFrame(`delta: ${summaryStats}${densityTag}`))
    output.push(border)
  } else {
    const statusBadge = delta.changed ? 'CHANGED' : 'NO CHANGES'
    const header = truncateVisible(
      `[delta:${statusBadge}] ${truncateVisible(cleanText(delta.url || 'about:blank'), 40)} | ${summaryStats}`,
      innerWidth,
    )
    output.push(header)
    for (const line of bodyLines) {
      const cleaned = asciiOnly ? sanitizeAscii(stripAnsi(line)) : line
      const trimmed = visibleLength(cleaned) > innerWidth ? truncateVisible(stripAnsi(cleaned), innerWidth) : cleaned
      output.push(trimmed.replace(/\s+$/, ''))
    }
  }

  return asciiOnly ? output.map((line) => sanitizeAscii(line)).join('\n') : output.join('\n')
}
