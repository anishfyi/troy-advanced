// Inline form-filling modal prompt renderer and state helpers for the Terminal Browser TUI.
// Triggered when pressing Enter on a focused <input>, <textarea>, or <select> ref.

import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'
import type { ElementDescriptor } from '../types.js'

export type FormModalKind = 'input' | 'select'

export interface FormModalOption {
  value: string
  label: string
  selected?: boolean
}

export interface FormModalState {
  kind: FormModalKind
  ref: string
  tag: string
  inputType: string
  label: string
  placeholder?: string
  /** Current text buffer (used for kind === 'input' or fallback select without options). */
  value: string
  /** Caret position inside `value` (0..value.length). */
  cursor: number
  /** Mask characters with '*' when true (e.g., password or redacted inputs). */
  masked: boolean
  /** Selectable options when kind === 'select'. */
  options: FormModalOption[]
  /** Highlighted option index when kind === 'select'. */
  selectedIndex: number
  /** Scroll offset inside options list when options exceed visible modal rows. */
  optionScrollOffset: number
}

export interface FormModalRenderOptions {
  maxWidth: number
  maxHeight: number
  asciiOnly?: boolean
  color?: boolean
}

export interface OverlayModalOptions {
  asciiOnly?: boolean
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

const NON_TEXT_INPUT_TYPES = new Set([
  'submit',
  'button',
  'reset',
  'image',
  'checkbox',
  'radio',
  'file',
  'hidden',
])

/**
 * Determine whether pressing Enter on `el` should open an inline form modal
 * (`'input'` or `'select'`) instead of issuing a direct `page_click`.
 */
export function isFormModalElement(el: ElementDescriptor | undefined): FormModalKind | null {
  if (!el) return null
  const tag = (el.tag ?? '').toLowerCase()
  if (tag === 'select') return 'select'
  if (tag === 'textarea') return 'input'
  if (tag === 'input') {
    const inputType = (el.type ?? 'text').toLowerCase()
    if (NON_TEXT_INPUT_TYPES.has(inputType)) return null
    return 'input'
  }
  if (el.editable) return 'input'
  return null
}

/**
 * Create initial modal state for a focused `<input>`, `<textarea>`, or `<select>` element.
 */
export function createFormModalState(ref: string, el: ElementDescriptor): FormModalState {
  const kind: FormModalKind = isFormModalElement(el) ?? 'input'
  const tag = (el.tag ?? 'input').toLowerCase()
  const inputType = (el.type ?? (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'text')).toLowerCase()
  const rawLabel = el.label || el.ariaLabel || el.placeholder || el.name || el.id || el.text || tag
  const label = rawLabel.replace(/\s+/g, ' ').trim() || tag
  const masked = inputType === 'password' || Boolean(el.valueRedacted)
  const initialValue = el.valueRedacted ? '' : (el.value ?? '')

  const options: FormModalOption[] =
    kind === 'select' && Array.isArray(el.options)
      ? el.options.map((opt) => ({
          value: String(opt.value ?? ''),
          label: String(opt.label ?? opt.value ?? '').replace(/\s+/g, ' ').trim() || String(opt.value ?? ''),
          selected: Boolean(opt.selected),
        }))
      : []

  let selectedIndex = 0
  if (options.length > 0) {
    const bySelected = options.findIndex((o) => o.selected)
    if (bySelected >= 0) {
      selectedIndex = bySelected
    } else if (initialValue) {
      const byValue = options.findIndex((o) => o.value === initialValue || o.label === initialValue)
      if (byValue >= 0) selectedIndex = byValue
    }
  }

  return {
    kind,
    ref,
    tag,
    inputType,
    label,
    placeholder: el.placeholder,
    value: initialValue,
    cursor: initialValue.length,
    masked,
    options,
    selectedIndex,
    optionScrollOffset: 0,
  }
}

export function cloneFormModalState(modal: FormModalState | null): FormModalState | null {
  if (!modal) return null
  return {
    ...modal,
    options: modal.options.map((o) => ({ ...o })),
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

function padVisible(line: string, width: number, asciiOnly: boolean): string {
  const normalized = asciiOnly ? sanitizeAscii(stripAnsi(line)) : line
  const vlen = visibleLength(normalized)
  if (vlen === width) return normalized
  if (vlen < width) return normalized + ' '.repeat(width - vlen)
  return truncatePlain(normalized, width)
}

/**
 * Render an inline form-filling modal box (array of fixed-width lines).
 */
export function renderFormModalBox(modal: FormModalState, opts: FormModalRenderOptions): string[] {
  const asciiOnly = Boolean(opts.asciiOnly)
  const useColor = Boolean(opts.color) && !asciiOnly

  const maxW = Math.max(30, Math.floor(opts.maxWidth))
  const maxH = Math.max(7, Math.floor(opts.maxHeight))
  const boxWidth = Math.max(30, Math.min(68, maxW - 4))
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
  const borderTop = paint(`${tl}${h.repeat(boxWidth - 2)}${tr}`, ANSI.cyan)
  const borderMid = paint(`${ml}${h.repeat(boxWidth - 2)}${mr}`, ANSI.cyan)
  const borderBot = paint(`${bl}${h.repeat(boxWidth - 2)}${br}`, ANSI.cyan)
  const row = (content: string) =>
    `${paint(v, ANSI.cyan)} ${padVisible(content, innerWidth, asciiOnly)} ${paint(v, ANSI.cyan)}`

  const lines: string[] = [borderTop]

  const isSelectList = modal.kind === 'select' && modal.options.length > 0
  const tagSummary =
    modal.tag === 'input' && modal.inputType
      ? `<input:${modal.inputType}>`
      : `<${modal.tag}>`
  const titlePrefix = isSelectList ? 'Select' : 'Edit'
  const titleRaw = `${titlePrefix} [${modal.ref}] ${tagSummary} - ${modal.label}`
  lines.push(row(paint(truncatePlain(titleRaw, innerWidth), ANSI.bold + ANSI.yellow)))
  lines.push(borderMid)

  if (isSelectList) {
    const maxVisibleOptions = Math.max(2, Math.min(modal.options.length, maxH - 6, 10))
    let scrollOffset = modal.optionScrollOffset
    if (modal.selectedIndex < scrollOffset) {
      scrollOffset = modal.selectedIndex
    } else if (modal.selectedIndex >= scrollOffset + maxVisibleOptions) {
      scrollOffset = modal.selectedIndex - maxVisibleOptions + 1
    }
    scrollOffset = Math.max(0, Math.min(Math.max(0, modal.options.length - maxVisibleOptions), scrollOffset))
    modal.optionScrollOffset = scrollOffset

    const visibleSlice = modal.options.slice(scrollOffset, scrollOffset + maxVisibleOptions)
    for (let i = 0; i < visibleSlice.length; i++) {
      const optIndex = scrollOffset + i
      const opt = visibleSlice[i]!
      const isFocused = optIndex === modal.selectedIndex
      const numBadge = optIndex < 9 ? `${optIndex + 1}. ` : '   '
      const pointer = isFocused ? '>' : ' '
      const currentMark = opt.selected ? (asciiOnly ? '(*)' : '(●)') : '( )'
      const valueSuffix =
        opt.value && opt.value !== opt.label ? ` [${opt.value}]` : ''
      const text = `${pointer} ${numBadge}${currentMark} ${opt.label}${valueSuffix}`
      const fitted = truncatePlain(text, innerWidth)
      if (isFocused && useColor) {
        lines.push(row(paint(fitted.padEnd(innerWidth, ' '), ANSI.inverse + ANSI.bold)))
      } else {
        lines.push(row(fitted))
      }
    }

    if (modal.options.length > maxVisibleOptions) {
      const rangeText = `Options ${scrollOffset + 1}-${scrollOffset + visibleSlice.length} of ${modal.options.length}`
      lines.push(row(paint(truncatePlain(rangeText, innerWidth), ANSI.dim)))
    }

    lines.push(borderMid)
    const hint = 'j/k or Up/Down: move | 1-9: jump | Enter: select | Esc: cancel'
    lines.push(row(paint(truncatePlain(hint, innerWidth), ANSI.dim)))
  } else {
    // Text input modal (for <input>, <textarea>, contenteditable, or <select> with no parsed options)
    const displayText = modal.masked ? '*'.repeat(modal.value.length) : modal.value
    const cursorPos = Math.max(0, Math.min(displayText.length, modal.cursor))

    if (modal.placeholder) {
      const hintLine = modal.masked
        ? `Placeholder: ${modal.placeholder} (masked)`
        : `Placeholder: ${modal.placeholder}`
      lines.push(row(paint(truncatePlain(hintLine, innerWidth), ANSI.dim)))
    } else if (modal.masked) {
      lines.push(row(paint(truncatePlain('Masked input (characters hidden)', innerWidth), ANSI.dim)))
    }

    // Input field with horizontal scrolling window so long text stays visible around cursor
    const promptPrefix = '> '
    const fieldWidth = Math.max(8, innerWidth - promptPrefix.length)
    // Reserve 1 cell for trailing cursor glyph
    const maxVisibleChars = Math.max(4, fieldWidth - 1)
    let windowStart = 0
    if (cursorPos >= maxVisibleChars) {
      windowStart = cursorPos - maxVisibleChars + 1
    }
    const windowText = displayText.slice(windowStart, windowStart + maxVisibleChars)
    const relCursor = cursorPos - windowStart

    let renderedInput: string
    if (useColor) {
      const before = windowText.slice(0, relCursor)
      const atChar = windowText[relCursor] ?? ' '
      const after = windowText.slice(relCursor + 1)
      renderedInput = `${paint(promptPrefix, ANSI.green)}${before}${paint(atChar, ANSI.inverse)}${after}`
    } else {
      const before = windowText.slice(0, relCursor)
      const after = windowText.slice(relCursor)
      const caret = relCursor >= windowText.length ? '_' : '|'
      renderedInput = `${promptPrefix}${before}${caret}${after}`
    }
    lines.push(row(renderedInput))

    lines.push(borderMid)
    const hint = 'Enter: submit | Esc: cancel | Ctrl+U: clear | Left/Right: move'
    lines.push(row(paint(truncatePlain(hint, innerWidth), ANSI.dim)))
  }

  lines.push(borderBot)
  return lines
}

/**
 * Extract a visible column slice `[startCol, endCol)` from a line that may contain ANSI SGR sequences.
 */
function sliceVisibleColumns(line: string, startCol: number, endCol?: number): string {
  const targetStart = Math.max(0, startCol)
  const targetEnd = endCol === undefined ? Number.POSITIVE_INFINITY : Math.max(targetStart, endCol)
  let visCol = 0
  let out = ''
  let i = 0
  let sawAnsi = false

  while (i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      let j = i + 2
      while (j < line.length && !/[A-Za-z]/.test(line[j]!)) {
        j++
      }
      if (j < line.length) j++
      const seq = line.slice(i, j)
      sawAnsi = true
      if (visCol >= targetStart && visCol < targetEnd) {
        out += seq
      }
      i = j
      continue
    }

    if (visCol >= targetStart && visCol < targetEnd) {
      out += line[i]
    }
    visCol++
    i++
  }

  if (sawAnsi && out.length > 0 && !out.endsWith(ANSI.reset)) {
    out += ANSI.reset
  }
  return out
}

/**
 * Center a modal box over an existing rendered terminal frame.
 */
export function overlayModalOnFrame(
  frame: string,
  modalLines: string[],
  opts: OverlayModalOptions = {},
): string {
  if (modalLines.length === 0) return frame
  const asciiOnly = Boolean(opts.asciiOnly)
  const baseLines = frame.split('\n')
  if (baseLines.length === 0) return modalLines.join('\n')

  const frameWidth = baseLines.reduce((max, l) => Math.max(max, visibleLength(l)), 0)
  const modalWidth = modalLines.reduce((max, l) => Math.max(max, visibleLength(l)), 0)
  const startRow = Math.max(0, Math.floor((baseLines.length - modalLines.length) / 2))
  const startCol = Math.max(0, Math.floor((frameWidth - modalWidth) / 2))

  const result = [...baseLines]
  for (let i = 0; i < modalLines.length; i++) {
    const rowIdx = startRow + i
    if (rowIdx < 0 || rowIdx >= result.length) continue
    const bgRaw = result[rowIdx] ?? ''
    const bgLine = asciiOnly ? sanitizeAscii(stripAnsi(bgRaw)) : bgRaw
    const bgVisLen = visibleLength(bgLine)
    const modalLine = asciiOnly ? sanitizeAscii(stripAnsi(modalLines[i]!)) : modalLines[i]!

    const leftPart = sliceVisibleColumns(bgLine, 0, startCol)
    const leftPad = Math.max(0, startCol - visibleLength(leftPart))
    const rightStart = startCol + modalWidth
    const rightPart = rightStart < bgVisLen ? sliceVisibleColumns(bgLine, rightStart) : ''
    const resetPrefix = !asciiOnly && bgLine.includes('\x1b[') ? ANSI.reset : ''

    result[rowIdx] = `${leftPart}${' '.repeat(leftPad)}${resetPrefix}${modalLine}${resetPrefix}${rightPart}`
  }

  return result.join('\n')
}
