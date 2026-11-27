// Token-budget estimator & auto-trimmer (`--max-tokens N`) for ASCII page output.
// Fits any rendered ASCII viewport, delta, or document cleanly into any LLM context window
// while preserving page identity (title/URL), interactive [eN] refs, and structural headings.

import type { TokenBudgetOptions, TokenBudgetReport, TokenBudgetStrategy, TokenEstimate } from '../types.js'
import { sanitizeAscii, stripAnsi } from './sanitize.js'

export const MIN_TOKEN_BUDGET = 16
export const MAX_TOKEN_BUDGET = 2_000_000

const REF_TOKEN_RE = /\[e(\d+)(?::|\])/g
const DECORATIVE_LINE_RE = /^[\s+\-=|┌┐└┘├┤─│#]+$/

/**
 * Parses a `--max-tokens` CLI/API value (e.g. `500`, `"1000"`, `"2k"`, `"1.5k"`).
 * Returns `undefined` when absent or invalid; clamps valid positive values to `[MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET]`.
 */
export function parseMaxTokens(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === false || raw === '') return undefined
  let value: number
  if (typeof raw === 'number') {
    value = raw
  } else if (typeof raw === 'string') {
    const cleaned = raw.trim().toLowerCase().replace(/,/g, '').replace(/_/g, '')
    if (!cleaned) return undefined
    const kMatch = /^(\d+(?:\.\d+)?)k$/.exec(cleaned)
    if (kMatch) {
      value = Number(kMatch[1]) * 1000
    } else if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
      value = Number(cleaned)
    } else {
      return undefined
    }
  } else {
    return undefined
  }
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.max(MIN_TOKEN_BUDGET, Math.min(MAX_TOKEN_BUDGET, Math.floor(value)))
}

/**
 * Counts unique interactive `[eN]` refs present in a string.
 */
export function countUniqueRefs(text: string): number {
  const refs = new Set<string>()
  const plain = stripAnsi(text)
  REF_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = REF_TOKEN_RE.exec(plain)) !== null) {
    refs.add(`e${match[1]}`)
  }
  return refs.size
}

/**
 * Fast, deterministic, zero-dependency BPE-calibrated token estimator for ASCII/text content.
 * Designed to be slightly conservative relative to cl100k_base / o200k_base / Claude / Gemini
 * tokenizers so outputs trimmed to `maxTokens` safely fit within real LLM context windows.
 */
export function estimateTokens(text: string): TokenEstimate {
  const plain = stripAnsi(text)
  if (!plain) {
    return { tokens: 0, chars: 0, lines: 0, words: 0, bytes: 0 }
  }

  let tokens = 0
  let words = 0
  let lines = 1
  const len = plain.length
  let i = 0

  while (i < len) {
    const ch = plain.charCodeAt(i)

    // Newline (\n or \r\n)
    if (ch === 10 || ch === 13) {
      if (ch === 13 && i + 1 < len && plain.charCodeAt(i + 1) === 10) i++
      lines++
      tokens += 1
      i++
      continue
    }

    // Horizontal whitespace (spaces / tabs)
    if (ch === 32 || ch === 9) {
      let run = 0
      while (i < len && (plain.charCodeAt(i) === 32 || plain.charCodeAt(i) === 9)) {
        run++
        i++
      }
      // Single space before a word usually merges into the next BPE token;
      // padding runs of 2+ spaces cost ~1 token per 4 spaces in BPE.
      if (run >= 2) {
        tokens += Math.ceil(run / 4)
      }
      continue
    }

    // ASCII letters (words / identifiers)
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
      let run = 0
      while (i < len) {
        const c = plain.charCodeAt(i)
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 39) {
          run++
          i++
        } else {
          break
        }
      }
      words++
      tokens += run <= 5 ? 1 : Math.ceil(run / 4)
      continue
    }

    // ASCII digits (numbers)
    if (ch >= 48 && ch <= 57) {
      let run = 0
      while (i < len && plain.charCodeAt(i) >= 48 && plain.charCodeAt(i) <= 57) {
        run++
        i++
      }
      words++
      tokens += Math.ceil(run / 3)
      continue
    }

    // Non-ASCII / Unicode characters (UTF-8 multi-byte)
    if (ch > 127) {
      const codePoint = plain.codePointAt(i) ?? ch
      const charLen = codePoint > 0xffff ? 2 : 1
      const utf8Bytes = codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
      tokens += Math.ceil(utf8Bytes / 1.5)
      i += charLen
      continue
    }

    // ASCII punctuation / symbols — compress identical repeated runs (e.g. `--------`, `========`)
    let run = 1
    while (i + run < len && plain.charCodeAt(i + run) === ch) {
      run++
    }
    if (run >= 2) {
      tokens += Math.ceil(run / 4)
      i += run
    } else {
      tokens += 1
      i++
    }
  }

  return {
    tokens: Math.max(1, tokens),
    chars: plain.length,
    lines,
    words,
    bytes: Buffer.byteLength(plain, 'utf8'),
  }
}

function classifyLineTier(
  line: string,
  index: number,
  options: { preserveRefs: boolean; preserveHeadings: boolean },
): number {
  const trimmed = stripAnsi(line).trim()
  if (!trimmed || DECORATIVE_LINE_RE.test(trimmed)) return 4

  // Strip optional box frame prefix/suffix (`| ... |` or `│ ... │`) for semantic classification
  const inner = trimmed.replace(/^[|│]\s*/, '').replace(/\s*[|│#]$/, '').trim()
  if (!inner || DECORATIVE_LINE_RE.test(inner)) return 4

  // Tier 0: Essential top header / URL / title / delta header
  if (
    index <= 3 &&
    (/^(?:TROY-ADV|URL:|TITLE:|PAGE:|DELTA\b|https?:\/\/|\[1\*?\s)/i.test(inner) || index === 0)
  ) {
    return 0
  }

  // Tier 1: Interactive [eN] refs
  if (options.preserveRefs && /\[e\d+(?::|\])/.test(inner)) {
    return 1
  }

  // Tier 2: Headings, form headers, section markers
  if (
    options.preserveHeadings &&
    (/^(?:#{1,6}\s|TITLE:|URL:|FORM:|REFS:|INTERACTIVE REFS:|MEDIA SUMMARY|\+--\s*Form:|\+\s*Added|\-\s*Removed|~\s*Changed)/i.test(
      inner,
    ) ||
      /^\[.*\]$/.test(inner))
  ) {
    return 2
  }

  // Tier 3: Standard body lines
  return 3
}

function formatTrimMarker(droppedLines: number, droppedTokens: number, maxTokens: number, asciiOnly: boolean, width?: number): string {
  const full = `[... trimmed ${droppedLines} lines (~${droppedTokens} tokens) to fit ${maxTokens}-token budget; scroll or raise --max-tokens ...]`
  const medium = `[... trimmed ${droppedLines} lines to fit ${maxTokens}-token budget ...]`
  const short = `[... trimmed (${maxTokens} tok max) ...]`
  const clean = (s: string) => (asciiOnly ? sanitizeAscii(s) : s)
  const candidates = [clean(full), clean(medium), clean(short)]
  if (width && width > 20) {
    const fitsWidth = candidates.find((c) => c.length <= width)
    if (fitsWidth) return fitsWidth
  }
  return candidates[0]!
}

function hardTruncateToBudget(text: string, maxTokens: number, asciiOnly: boolean): string {
  const plain = asciiOnly ? sanitizeAscii(text) : stripAnsi(text)
  if (estimateTokens(plain).tokens <= maxTokens) return plain

  const suffix = '...'
  let lo = 0
  let hi = plain.length
  let best = ''
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const candidate = mid > 0 ? `${plain.slice(0, mid).trimEnd()}${suffix}` : ''
    if (estimateTokens(candidate).tokens <= maxTokens) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export interface TokenBudgetTrimResult {
  text: string
  report: TokenBudgetReport
}

/**
 * Trims any rendered ASCII string to fit strictly within `maxTokens`.
 * Prioritizes header/URL lines, interactive `[eN]` refs, and headings, then fills remaining
 * budget with body lines in original document order. Always guarantees `finalTokens <= maxTokens`.
 */
export function trimAsciiToTokenBudget(
  text: string,
  maxTokensRaw: number,
  options: TokenBudgetOptions = {},
): TokenBudgetTrimResult {
  const maxTokens = Math.max(MIN_TOKEN_BUDGET, Math.floor(maxTokensRaw))
  const preserveRefs = options.preserveRefs ?? true
  const preserveHeadings = options.preserveHeadings ?? true
  const asciiOnly = options.asciiOnly ?? true

  const origEstimate = estimateTokens(text)
  const totalRefs = countUniqueRefs(text)

  if (origEstimate.tokens <= maxTokens) {
    return {
      text,
      report: {
        maxTokens,
        originalTokens: origEstimate.tokens,
        finalTokens: origEstimate.tokens,
        trimmed: false,
        strategy: 'none',
        droppedLines: 0,
        preservedRefs: totalRefs,
        totalRefs,
        originalChars: text.length,
        finalChars: text.length,
      },
    }
  }

  const rawLines = text.split('\n')
  const classified = rawLines.map((line, index) => ({
    index,
    line,
    tier: classifyLineTier(line, index, { preserveRefs, preserveHeadings }),
    tokens: estimateTokens(line).tokens + 1, // +1 for joining newline
  }))

  // Reserve space for truncation marker when budget permits
  const markerReserve = maxTokens >= 60 ? 22 : maxTokens >= 32 ? 12 : 0
  const targetContentBudget = Math.max(8, maxTokens - markerReserve)

  const selectedIndices = new Set<number>()
  let usedTokens = 0

  // Greedily pick lines by priority tier (0 -> 1 -> 2 -> 3), preserving document order inside each tier
  for (let tier = 0; tier <= 3; tier++) {
    for (const item of classified) {
      if (item.tier !== tier) continue
      if (usedTokens + item.tokens <= targetContentBudget) {
        selectedIndices.add(item.index)
        usedTokens += item.tokens
      }
    }
  }

  // If no single line fit (e.g. very tight budget or a single giant line), hard-truncate
  if (selectedIndices.size === 0) {
    const firstNonDecorative = classified.find((c) => c.tier < 4)?.line ?? text
    const truncated = hardTruncateToBudget(firstNonDecorative, maxTokens, asciiOnly)
    const finalEst = estimateTokens(truncated)
    return {
      text: truncated,
      report: {
        maxTokens,
        originalTokens: origEstimate.tokens,
        finalTokens: finalEst.tokens,
        trimmed: true,
        strategy: 'hard-truncate',
        droppedLines: Math.max(0, rawLines.length - truncated.split('\n').length),
        preservedRefs: countUniqueRefs(truncated),
        totalRefs,
        originalChars: text.length,
        finalChars: truncated.length,
      },
    }
  }

  // Reconstruct in original document order
  const orderedSelected = Array.from(selectedIndices)
    .sort((a, b) => a - b)
    .map((idx) => classified[idx]!)

  const buildOutput = (items: typeof orderedSelected, includeMarker: boolean): string => {
    const body = items.map((it) => it.line)
    const droppedLines = Math.max(0, rawLines.length - items.length)
    if (includeMarker && droppedLines > 0) {
      const bodyEst = estimateTokens(body.join('\n')).tokens
      const droppedTokens = Math.max(1, origEstimate.tokens - bodyEst)
      const marker = formatTrimMarker(droppedLines, droppedTokens, maxTokens, asciiOnly, options.width)
      body.push(marker)
    }
    return body.join('\n')
  }

  let currentItems = [...orderedSelected]
  let includeMarker = markerReserve > 0
  let candidate = buildOutput(currentItems, includeMarker)
  let strategy: TokenBudgetStrategy = 'trim'

  // Strict enforcement loop: guarantee finalTokens <= maxTokens
  while (estimateTokens(candidate).tokens > maxTokens) {
    if (currentItems.length > 1) {
      // Drop the lowest-priority (highest tier, then latest in document) line
      let dropPos = currentItems.length - 1
      let worstTier = -1
      for (let i = currentItems.length - 1; i >= 0; i--) {
        if (currentItems[i]!.tier > worstTier) {
          worstTier = currentItems[i]!.tier
          dropPos = i
        }
      }
      currentItems.splice(dropPos, 1)
      candidate = buildOutput(currentItems, includeMarker)
    } else if (includeMarker) {
      includeMarker = false
      candidate = buildOutput(currentItems, false)
    } else {
      candidate = hardTruncateToBudget(candidate, maxTokens, asciiOnly)
      strategy = 'hard-truncate'
      break
    }
  }

  const finalEst = estimateTokens(candidate)
  const droppedLines = Math.max(0, rawLines.length - currentItems.length)

  return {
    text: candidate,
    report: {
      maxTokens,
      originalTokens: origEstimate.tokens,
      finalTokens: finalEst.tokens,
      trimmed: true,
      strategy,
      droppedLines,
      preservedRefs: countUniqueRefs(candidate),
      totalRefs,
      originalChars: text.length,
      finalChars: candidate.length,
    },
  }
}
