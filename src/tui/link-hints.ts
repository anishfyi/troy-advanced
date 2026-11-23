// Vimium-style quick link-hint jump mode for the Terminal Browser TUI (`f` key).
// Highlights [e1]..[e99]+ interactive refs in the rendered ASCII/ANSI viewport,
// filters candidates live as digits are typed, and resolves the target ref on Enter.

import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'
import type { ElementDescriptor } from '../types.js'

export interface LinkHintState {
  /** Digits typed so far (without the leading 'e'), e.g. "", "1", "12". */
  digits: string
  /** All hintable `eN` refs currently on the page. */
  allRefs: string[]
  /** Candidate refs whose numeric part starts with `digits` (all refs when `digits === ''`). */
  matchingRefs: string[]
  /** Exact matching ref (`e${digits}`) if present in `allRefs`, otherwise null. */
  exactRef: string | null
}

export interface HighlightLinkHintsOptions {
  asciiOnly?: boolean
  color?: boolean
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  inverse: '\x1b[7m',
} as const

const NUMERIC_REF_RE = /^e(\d+)$/

/**
 * Extract unique numeric `eN` refs (e.g. `e1`..`e99`+) preserving page order.
 */
export function extractHintableRefs(availableRefs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of availableRefs) {
    if (typeof ref !== 'string') continue
    const trimmed = ref.trim()
    if (!NUMERIC_REF_RE.test(trimmed)) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Create a new LinkHintState from available page refs and optional initial digits.
 */
export function createLinkHintState(availableRefs: readonly string[], rawDigits = ''): LinkHintState {
  const allRefs = extractHintableRefs(availableRefs)
  return computeLinkHintState(allRefs, rawDigits)
}

/**
 * Return a new LinkHintState with updated digit input (non-digit chars are stripped).
 */
export function updateLinkHintDigits(state: LinkHintState, rawDigits: string): LinkHintState {
  return computeLinkHintState(state.allRefs, rawDigits)
}

function computeLinkHintState(allRefs: readonly string[], rawDigits: string): LinkHintState {
  const digits = rawDigits.replace(/\D+/g, '')
  const refsCopy = [...allRefs]
  const matchingRefs =
    digits.length === 0
      ? [...refsCopy]
      : refsCopy.filter((ref) => {
          const num = ref.slice(1)
          return num.startsWith(digits)
        })
  const candidateExact = digits.length > 0 ? `e${digits}` : null
  const exactRef = candidateExact && refsCopy.includes(candidateExact) ? candidateExact : null

  return {
    digits,
    allRefs: refsCopy,
    matchingRefs,
    exactRef,
  }
}

/**
 * Deep-clone a LinkHintState for immutable `getState()` snapshots.
 */
export function cloneLinkHintState(state: LinkHintState | null): LinkHintState | null {
  if (!state) return null
  return {
    digits: state.digits,
    allRefs: [...state.allRefs],
    matchingRefs: [...state.matchingRefs],
    exactRef: state.exactRef,
  }
}

/**
 * Resolve the jump target ref when the user presses Enter in hint mode.
 * Prefers an exact `e${digits}` match; falls back to the sole remaining prefix match.
 */
export function resolveLinkHintTarget(state: LinkHintState): string | null {
  if (state.digits.length === 0) return null
  if (state.exactRef) return state.exactRef
  if (state.matchingRefs.length === 1) return state.matchingRefs[0] ?? null
  return null
}

/**
 * Format the status-bar line displayed while link-hint jump mode is active.
 */
export function formatLinkHintStatus(
  state: LinkHintState,
  elements: readonly ElementDescriptor[] = [],
  options: { asciiOnly?: boolean } = {},
): string {
  const asciiOnly = options.asciiOnly ?? false
  const prompt = state.digits.length > 0 ? `f:${state.digits}` : 'f:_'
  const targetRef = resolveLinkHintTarget(state)

  let detail: string
  if (state.digits.length === 0) {
    detail = `${state.allRefs.length} refs | type digits + Enter to jump | Esc cancel`
  } else if (state.matchingRefs.length === 0) {
    detail = `no matching ref for e${state.digits} | Backspace edit | Esc cancel`
  } else if (targetRef) {
    const el = elements.find((e) => e.ref === targetRef)
    const tag = el?.tag ? `<${el.tag.toLowerCase()}>` : ''
    const rawLabel = el?.label || el?.ariaLabel || el?.text || el?.placeholder || el?.name || ''
    const cleanLabel = rawLabel.replace(/\s+/g, ' ').trim()
    const clippedLabel = cleanLabel.length > 26 ? `${cleanLabel.slice(0, 23)}...` : cleanLabel
    const targetDesc = [tag, clippedLabel ? `"${clippedLabel}"` : ''].filter(Boolean).join(' ')
    const extraCount = state.matchingRefs.length > 1 ? ` (+${state.matchingRefs.length - 1} prefix)` : ''
    detail = `-> [${targetRef}]${targetDesc ? ` ${targetDesc}` : ''}${extraCount} | Enter jump | Esc cancel`
  } else {
    const sample = state.matchingRefs.slice(0, 4).join(', ')
    const more = state.matchingRefs.length > 4 ? ', ...' : ''
    detail = `${state.matchingRefs.length} matches (${sample}${more}) | keep typing | Esc cancel`
  }

  const raw = `HINT ${prompt} | ${detail}`
  return asciiOnly ? sanitizeAscii(raw) : raw
}

function isChromeStatusOrHeaderLine(plainLine: string): boolean {
  const trimmed = plainLine.trim()
  if (!trimmed) return true
  if (/^[+\-┌┐└┘├┤─═]+$/.test(trimmed)) return true
  if (/^[|│]\s*(?:TROY-ADV\s|URL:\s|HINT\s)/.test(trimmed)) return true
  return false
}

/**
 * Highlight `[eN]` / `[eN: ...]` link hints across a rendered page frame.
 * - In ANSI color mode (`color: true, asciiOnly: false`), wraps badges with inverse
 *   green (exact match), inverse yellow (matching candidate), or dim (non-matching)
 *   with zero visible width change.
 * - In strict 7-bit ASCII mode (`asciiOnly: true` or `color: false`), marks exact
 *   matches as `[>eN<]` / `[>eN<:` and matching candidates as `[*eN]` / `[*eN:`,
 *   trimming trailing spaces before the right frame border to preserve alignment.
 */
export function highlightLinkHintsInFrame(
  frame: string,
  state: LinkHintState,
  options: HighlightLinkHintsOptions = {},
): string {
  const asciiOnly = options.asciiOnly ?? false
  const color = asciiOnly ? false : (options.color ?? false)
  const matchingSet = new Set(state.matchingRefs)
  const exactRef = state.exactRef
  const hasDigits = state.digits.length > 0

  // Matches [eN] or [eN: even when ANSI color codes appear between '[', 'eN', and ':'/']'
  const refTokenRe =
    /(?:\x1b\[[0-9;]*m)*\[(?:\x1b\[[0-9;]*m)*e(\d+)(?:\x1b\[[0-9;]*m)*(\]|:)(?:\x1b\[[0-9;]*m)*/g

  const lines = frame.split('\n')
  const out = lines.map((line) => {
    const plain = stripAnsi(line)
    if (isChromeStatusOrHeaderLine(plain)) return line
    if (!plain.includes('[e')) return line

    if (color) {
      return line.replace(refTokenRe, (match, num: string, sep: string) => {
        const ref = `e${num}`
        const isExact = exactRef === ref
        const isMatch = matchingSet.has(ref)
        const badge = sep === ']' ? `[${ref}]` : `[${ref}`
        const trail = sep === ':' ? ':' : ''

        if (isExact) {
          return `${ANSI.bold}${ANSI.inverse}${ANSI.green}${badge}${ANSI.reset}${trail}`
        }
        if (isMatch) {
          return `${ANSI.bold}${ANSI.inverse}${ANSI.yellow}${badge}${ANSI.reset}${trail}`
        }
        if (hasDigits) {
          return `${ANSI.dim}${badge}${ANSI.reset}${trail}`
        }
        return match
      })
    }

    // Strict 7-bit ASCII / monochrome mode
    let addedChars = 0
    const replaced = plain.replace(refTokenRe, (match, num: string, sep: string) => {
      const ref = `e${num}`
      const isExact = exactRef === ref
      const isMatch = matchingSet.has(ref)

      if (isExact) {
        addedChars += 2
        return sep === ']' ? `[>${ref}<]` : `[>${ref}<:`
      }
      if (isMatch) {
        addedChars += 1
        return sep === ']' ? `[*${ref}]` : `[*${ref}:`
      }
      return match
    })

    let finalLine = replaced
    if (addedChars > 0) {
      // Preserve right-edge border/scrollbar alignment by consuming trailing padding spaces
      // immediately before the rightmost border or scrollbar character (`|`, `#`, `│`, `█`, etc.).
      const rightBorderMatch = finalLine.match(/^(.*?)( +)([|#│█░▒▓])$/)
      if (rightBorderMatch) {
        const prefix = rightBorderMatch[1] ?? ''
        const spaces = rightBorderMatch[2] ?? ''
        const border = rightBorderMatch[3] ?? ''
        const keepSpaces = Math.max(1, spaces.length - addedChars)
        finalLine = `${prefix}${' '.repeat(keepSpaces)}${border}`
      }
    }

    return asciiOnly ? sanitizeAscii(finalLine) : finalLine
  })

  return out.join('\n')
}
