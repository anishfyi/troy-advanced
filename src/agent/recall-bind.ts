// Deterministic page_recall auto-binding: verifies recalled memory selectors against
// the live DOM of the active tab and immediately issues usable `eN` refs.

import type { ElementDescriptor } from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { effectiveElementRole, type ElementRegistry, type RefContext } from './elements.js'
import type { MemoryAction, MemoryElement, MemoryPage } from './memory.js'

export type RecallBindStrategy =
  | 'selector'
  | 'id'
  | 'ariaLabel'
  | 'name+tag'
  | 'role+ariaLabel'
  | 'tag+text'

export type RecallBindStatus = 'bound' | 'stale' | 'ambiguous' | 'other-origin' | 'unbound'

export interface AmbiguousStrategyDetail {
  strategy: RecallBindStrategy
  count: number
}

export type RecallElementMatch =
  | {
      matched: true
      item: ElementDescriptor
      strategy: RecallBindStrategy
    }
  | {
      matched: false
      status: 'stale' | 'ambiguous' | 'other-origin'
      reason: string
      attemptedStrategies: RecallBindStrategy[]
      ambiguousStrategies?: AmbiguousStrategyDetail[]
    }

export interface BoundRecallElement extends MemoryElement {
  ref?: string
  bound: boolean
  status: RecallBindStatus
  reusedRef?: boolean
  matchStrategy?: RecallBindStrategy
  reason?: string
  ambiguousStrategies?: AmbiguousStrategyDetail[]
  liveText?: string
  liveValue?: string
  liveDisabled?: boolean
}

export interface RecallBindSummary {
  attempted: boolean
  liveUrl?: string
  liveOrigin?: string | null
  total: number
  boundCount: number
  staleCount: number
  ambiguousCount: number
  otherOriginCount: number
  unboundCount: number
  reusedRefCount: number
  freshRefCount: number
}

export interface RecallAutoBindResult {
  pages: MemoryPage[]
  elements: BoundRecallElement[]
  boundElements: BoundRecallElement[]
  actions: MemoryAction[]
  binding: RecallBindSummary
}

function normStr(val?: string): string {
  return typeof val === 'string' ? val.trim() : ''
}

function normLower(val?: string): string {
  return normStr(val).toLowerCase()
}

function normText(val?: string): string {
  return normStr(val).replace(/\s+/g, ' ').toLowerCase()
}

function tagMatches(recalledTag: string, liveTag: string): boolean {
  const r = normLower(recalledTag)
  if (!r) return true
  return normLower(liveTag) === r
}

/**
 * Deterministically verify a recalled MemoryElement against the live DOM elements.
 * Enforces strict origin isolation and strict uniqueness (exactly 1 matching live node)
 * across an ordered cascade of locator strategies:
 *   1. selector (exact CSS selector + compatible tag)
 *   2. id (exact DOM id + compatible tag)
 *   3. ariaLabel (exact aria-label + compatible tag)
 *   4. name+tag (exact form name + tag)
 *   5. role+ariaLabel (effective ARIA role + exact aria-label)
 *   6. tag+text (exact tag + normalized visible text/label)
 */
export function matchRecalledElementOnLiveDom(
  recalled: MemoryElement,
  liveElements: ElementDescriptor[],
  liveOrigin: string | null,
): RecallElementMatch {
  if (!liveOrigin || recalled.origin !== liveOrigin) {
    return {
      matched: false,
      status: 'other-origin',
      reason: liveOrigin
        ? `recalled element origin (${recalled.origin}) does not match live tab origin (${liveOrigin})`
        : 'live tab does not have an HTTP(S) origin',
      attemptedStrategies: [],
    }
  }

  const recalledFrame = normStr(recalled.frameId)
  const scoped = recalledFrame
    ? liveElements.filter((c) => normStr(c.frameId) === recalledFrame)
    : liveElements

  const attemptedStrategies: RecallBindStrategy[] = []
  const ambiguousStrategies: AmbiguousStrategyDetail[] = []

  const tryStrategy = (
    strategy: RecallBindStrategy,
    predicate: (c: ElementDescriptor) => boolean,
  ): ElementDescriptor | null => {
    attemptedStrategies.push(strategy)
    const matches = scoped.filter(predicate)
    if (matches.length === 1) {
      return matches[0]!
    }
    if (matches.length > 1) {
      // If recalled element had no frameId and multiple frames match, prefer unique main-frame hit
      if (!recalledFrame) {
        const mainFrameMatches = matches.filter((m) => !normStr(m.frameId))
        if (mainFrameMatches.length === 1) {
          return mainFrameMatches[0]!
        }
      }
      ambiguousStrategies.push({ strategy, count: matches.length })
    }
    return null
  }

  const recalledSelector = normStr(recalled.selector)
  if (recalledSelector) {
    const hit = tryStrategy(
      'selector',
      (c) => normStr(c.selector) === recalledSelector && tagMatches(recalled.tag, c.tag),
    )
    if (hit) return { matched: true, item: hit, strategy: 'selector' }
  }

  const recalledId = normStr(recalled.id)
  if (recalledId) {
    const hit = tryStrategy(
      'id',
      (c) => normStr(c.id) === recalledId && tagMatches(recalled.tag, c.tag),
    )
    if (hit) return { matched: true, item: hit, strategy: 'id' }
  }

  const recalledAria = normStr(recalled.ariaLabel)
  if (recalledAria) {
    const hit = tryStrategy(
      'ariaLabel',
      (c) => normStr(c.ariaLabel) === recalledAria && tagMatches(recalled.tag, c.tag),
    )
    if (hit) return { matched: true, item: hit, strategy: 'ariaLabel' }
  }

  const recalledName = normStr(recalled.name)
  const recalledTag = normLower(recalled.tag)
  if (recalledName && recalledTag) {
    const hit = tryStrategy(
      'name+tag',
      (c) => normStr(c.name) === recalledName && normLower(c.tag) === recalledTag,
    )
    if (hit) return { matched: true, item: hit, strategy: 'name+tag' }
  }

  const recalledRole = effectiveElementRole({
    role: recalled.role,
    tag: recalled.tag,
    type: recalled.type,
    href: recalledTag === 'a' ? '#' : undefined,
  })
  if (recalledRole && recalledAria) {
    const hit = tryStrategy(
      'role+ariaLabel',
      (c) => effectiveElementRole(c) === recalledRole && normStr(c.ariaLabel) === recalledAria,
    )
    if (hit) return { matched: true, item: hit, strategy: 'role+ariaLabel' }
  }

  const recalledText = normText(recalled.text || recalled.label)
  if (recalledTag && recalledText) {
    const hit = tryStrategy(
      'tag+text',
      (c) =>
        normLower(c.tag) === recalledTag &&
        normText(c.text || c.label) === recalledText,
    )
    if (hit) return { matched: true, item: hit, strategy: 'tag+text' }
  }

  if (ambiguousStrategies.length > 0) {
    const detail = ambiguousStrategies.map((a) => `${a.strategy}:${a.count}`).join(', ')
    return {
      matched: false,
      status: 'ambiguous',
      reason: `recalled element matched multiple live DOM nodes (${detail}); refusing ambiguous bind`,
      attemptedStrategies,
      ambiguousStrategies,
    }
  }

  return {
    matched: false,
    status: 'stale',
    reason: 'recalled selector did not match any element on the live DOM',
    attemptedStrategies,
  }
}

export interface BindRecalledOptions {
  liveElements: ElementDescriptor[]
  liveUrl: string
  liveOrigin: string | null
  registry: ElementRegistry
  context: RefContext
  onVerify?: (el: MemoryElement, matched: boolean) => void
}

/**
 * Verify a batch of recalled MemoryElements against the live DOM and bind each
 * uniquely verified element into the tab's ElementRegistry with an immediate `eN` ref.
 */
export function bindRecalledElements(
  recalledElements: MemoryElement[],
  opts: BindRecalledOptions,
): {
  elements: BoundRecallElement[]
  boundElements: BoundRecallElement[]
  binding: RecallBindSummary
} {
  let boundCount = 0
  let staleCount = 0
  let ambiguousCount = 0
  let otherOriginCount = 0
  let reusedRefCount = 0
  let freshRefCount = 0

  const elements: BoundRecallElement[] = []
  const boundElements: BoundRecallElement[] = []

  for (const recalled of recalledElements) {
    const match = matchRecalledElementOnLiveDom(recalled, opts.liveElements, opts.liveOrigin)
    if (match.matched) {
      const { item: liveBound, reused } = opts.registry.bindOrFind(match.item, opts.context)
      boundCount += 1
      if (reused) reusedRefCount += 1
      else freshRefCount += 1

      opts.onVerify?.(recalled, true)

      const entry: BoundRecallElement = {
        ...recalled,
        ref: liveBound.ref,
        bound: true,
        status: 'bound',
        reusedRef: reused,
        matchStrategy: match.strategy,
        liveText: liveBound.text,
        ...(liveBound.value !== undefined ? { liveValue: liveBound.value } : {}),
        ...(liveBound.disabled !== undefined ? { liveDisabled: liveBound.disabled } : {}),
      }
      elements.push(entry)
      boundElements.push(entry)
    } else {
      if (match.status === 'other-origin') otherOriginCount += 1
      else if (match.status === 'ambiguous') ambiguousCount += 1
      else staleCount += 1

      // Only penalize memory failure count when we are on the exact same pageUrl
      if (match.status === 'stale' && opts.liveUrl && recalled.pageUrl === opts.liveUrl) {
        opts.onVerify?.(recalled, false)
      }

      elements.push({
        ...recalled,
        bound: false,
        status: match.status,
        reason: match.reason,
        ...(match.ambiguousStrategies ? { ambiguousStrategies: match.ambiguousStrategies } : {}),
      })
    }
  }

  return {
    elements,
    boundElements,
    binding: {
      attempted: true,
      liveUrl: opts.liveUrl,
      liveOrigin: opts.liveOrigin,
      total: recalledElements.length,
      boundCount,
      staleCount,
      ambiguousCount,
      otherOriginCount,
      unboundCount: 0,
      reusedRefCount,
      freshRefCount,
    },
  }
}

/**
 * Format a RecallAutoBindResult as a clean strict 7-bit ASCII summary showing
 * immediate `[eN]` refs for bound elements and statuses for unbound/stale items.
 */
export function formatRecallAscii(result: RecallAutoBindResult, query = ''): string {
  const lines: string[] = []
  const b = result.binding
  const qLabel = query ? ` "${sanitizeAscii(query)}"` : ''
  lines.push(`=== PAGE RECALL${qLabel} ===`)
  if (b.attempted) {
    lines.push(
      `Live: ${sanitizeAscii(b.liveUrl || '(none)')} | Bound: ${b.boundCount}/${b.total} (fresh:${b.freshRefCount}, reused:${b.reusedRefCount}, stale:${b.staleCount}, ambiguous:${b.ambiguousCount}, other-origin:${b.otherOriginCount})`,
    )
  } else {
    lines.push(`Binding: disabled/no-tab | Elements: ${result.elements.length}`)
  }

  if (result.elements.length > 0) {
    lines.push('')
    lines.push('Elements:')
    for (const el of result.elements) {
      const label = sanitizeAscii(el.liveText || el.text || el.label || el.ariaLabel || el.name || el.selector)
      const tag = sanitizeAscii(el.tag || 'el')
      if (el.bound && el.ref) {
        lines.push(`  [${el.ref}] <${tag}> ${label} (bound via ${el.matchStrategy}${el.reusedRef ? ', reused' : ''})`)
      } else {
        lines.push(`  [--] <${tag}> ${label} (${el.status}${el.reason ? `: ${sanitizeAscii(el.reason)}` : ''})`)
      }
    }
  }

  if (result.pages.length > 0) {
    lines.push('')
    lines.push('Pages:')
    for (const p of result.pages) {
      lines.push(`  - ${sanitizeAscii(p.title || '(untitled)')} <${sanitizeAscii(p.url)}> (reads:${p.reads})`)
    }
  }

  return sanitizeAscii(lines.join('\n'))
}
