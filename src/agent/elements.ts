// Opaque element capabilities (e1, e2, ...).
// Bound to (tabId, url, epoch); expires cleanly when the document navigates.
// Supports deterministic same-epoch stale-ref recovery by id, ariaLabel, name+tag, role+ariaLabel.

import type { ElementDescriptor } from '../types.js'

export interface RefContext {
  tabId: number
  url: string
  epoch: number
}

export type RefRecoveryStrategy = 'id' | 'ariaLabel' | 'name+tag' | 'role+ariaLabel'

export interface RefRecoveryMatch {
  item: ElementDescriptor
  selector: string
  strategy: RefRecoveryStrategy
}

export interface RefRecoveryFailure {
  recovered: false
  reason: 'no-locators' | 'not-found' | 'ambiguous'
  attemptedStrategies: RefRecoveryStrategy[]
  ambiguousStrategies?: Array<{ strategy: RefRecoveryStrategy; count: number }>
}

export type RefRecoveryResult = ({ recovered: true } & RefRecoveryMatch) | RefRecoveryFailure

export type ResolvedRef =
  | {
      selector: string
      item: ElementDescriptor
      recovered?: boolean
      recoveryStrategy?: RefRecoveryStrategy
      recoveredRef?: string
    }
  | { error: string }

interface StoredRef {
  ref: string
  selector: string
  item: ElementDescriptor
  tabId: number
  url: string
  epoch: number
}

function normStr(val?: string): string {
  return typeof val === 'string' ? val.trim() : ''
}

function sameContext(a: Pick<RefContext, 'tabId' | 'url' | 'epoch'>, b: RefContext): boolean {
  return a.tabId === b.tabId && a.url === b.url && a.epoch === b.epoch
}

/**
 * Derive a deterministic effective ARIA role for an ElementDescriptor.
 * Prefers explicit `role` attribute; falls back to standard HTML implicit roles.
 */
export function effectiveElementRole(el: Pick<ElementDescriptor, 'role' | 'tag' | 'type' | 'href'>): string {
  const explicit = normStr(el.role).toLowerCase()
  if (explicit) return explicit
  const tag = normStr(el.tag).toLowerCase()
  const type = normStr(el.type).toLowerCase()
  if (tag === 'a' && el.href) return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
    return 'textbox'
  }
  return ''
}

/**
 * Deterministically re-locate a stale ElementDescriptor among candidate elements
 * from the same epoch. Requires a strictly unique match (exactly 1 candidate)
 * scoped to the same frameId, evaluated in priority order:
 *   1. id
 *   2. ariaLabel
 *   3. name + tag
 *   4. role + ariaLabel
 */
export function recoverElementMatch(
  stale: ElementDescriptor,
  candidates: ElementDescriptor[],
): RefRecoveryResult {
  const staleFrame = stale.frameId ?? ''
  const scoped = candidates.filter((c) => (c.frameId ?? '') === staleFrame)

  const attemptedStrategies: RefRecoveryStrategy[] = []
  const ambiguousStrategies: Array<{ strategy: RefRecoveryStrategy; count: number }> = []

  const tryStrategy = (
    strategy: RefRecoveryStrategy,
    predicate: (c: ElementDescriptor) => boolean,
  ): RefRecoveryMatch | null => {
    attemptedStrategies.push(strategy)
    const matches = scoped.filter(predicate)
    if (matches.length === 1) {
      const match = matches[0]!
      return { item: match, selector: match.selector, strategy }
    }
    if (matches.length > 1) {
      ambiguousStrategies.push({ strategy, count: matches.length })
    }
    return null
  }

  const staleId = normStr(stale.id)
  if (staleId) {
    const hit = tryStrategy('id', (c) => normStr(c.id) === staleId)
    if (hit) return { recovered: true, ...hit }
  }

  const staleAriaLabel = normStr(stale.ariaLabel)
  if (staleAriaLabel) {
    const hit = tryStrategy('ariaLabel', (c) => normStr(c.ariaLabel) === staleAriaLabel)
    if (hit) return { recovered: true, ...hit }
  }

  const staleName = normStr(stale.name)
  const staleTag = normStr(stale.tag).toLowerCase()
  if (staleName && staleTag) {
    const hit = tryStrategy(
      'name+tag',
      (c) => normStr(c.name) === staleName && normStr(c.tag).toLowerCase() === staleTag,
    )
    if (hit) return { recovered: true, ...hit }
  }

  const staleRole = effectiveElementRole(stale)
  if (staleRole && staleAriaLabel) {
    const hit = tryStrategy(
      'role+ariaLabel',
      (c) => effectiveElementRole(c) === staleRole && normStr(c.ariaLabel) === staleAriaLabel,
    )
    if (hit) return { recovered: true, ...hit }
  }

  if (attemptedStrategies.length === 0) {
    return { recovered: false, reason: 'no-locators', attemptedStrategies }
  }
  if (ambiguousStrategies.length > 0) {
    return { recovered: false, reason: 'ambiguous', attemptedStrategies, ambiguousStrategies }
  }
  return { recovered: false, reason: 'not-found', attemptedStrategies }
}

const MAX_SAME_EPOCH_ARCHIVE = 500

export class ElementRegistry {
  private entries = new Map<string, StoredRef>()
  private sameEpochArchive = new Map<string, StoredRef>()
  private lastContext: RefContext | null = null
  private counter = 0

  invalidate(): void {
    this.entries.clear()
    this.sameEpochArchive.clear()
    this.lastContext = null
  }

  register(items: ElementDescriptor[], context: RefContext): ElementDescriptor[] {
    if (this.lastContext && sameContext(this.lastContext, context)) {
      for (const [k, v] of this.entries.entries()) {
        this.sameEpochArchive.set(k, v)
      }
      while (this.sameEpochArchive.size > MAX_SAME_EPOCH_ARCHIVE) {
        const oldest = this.sameEpochArchive.keys().next()
        if (oldest.done) break
        this.sameEpochArchive.delete(oldest.value)
      }
      this.entries.clear()
    } else {
      this.invalidate()
    }
    this.lastContext = { ...context }
    return this.add(items, context)
  }

  add(items: ElementDescriptor[], context: RefContext): ElementDescriptor[] {
    this.lastContext = { ...context }
    return items.map((raw) => {
      const ref = `e${++this.counter}`
      const publicItem: ElementDescriptor = { ...raw, ref }
      this.entries.set(ref, {
        ref,
        selector: raw.selector,
        item: publicItem,
        tabId: context.tabId,
        url: context.url,
        epoch: context.epoch,
      })
      return publicItem
    })
  }

  updateEntry(ref: string, selector: string, item: ElementDescriptor, context: RefContext): boolean {
    const name = ref.trim()
    const entry = this.entries.get(name)
    if (!entry || !sameContext(entry, context)) return false
    const updatedItem: ElementDescriptor = { ...item, ref: name }
    this.entries.set(name, {
      ...entry,
      selector,
      item: updatedItem,
    })
    return true
  }

  resolve(ref: unknown, context: RefContext): ResolvedRef {
    const name = String(ref ?? '').trim()
    if (!/^e\d+$/.test(name)) {
      return { error: 'the element reference is missing or malformed; read the page again' }
    }
    const entry = this.entries.get(name)
    if (entry) {
      if (!sameContext(entry, context)) {
        this.invalidate()
        return { error: `${name} belongs to an older page state; read the page again` }
      }
      return { selector: entry.selector, item: { ...entry.item } }
    }

    const archived = this.sameEpochArchive.get(name)
    if (!archived) {
      return { error: `${name} is stale or unknown; read the page again` }
    }
    if (!sameContext(archived, context)) {
      this.invalidate()
      return { error: `${name} belongs to an older page state; read the page again` }
    }

    const activeItems = this.list(context).map((e) => e.item)
    const recovery = recoverElementMatch(archived.item, activeItems)
    if (recovery.recovered) {
      return {
        selector: recovery.selector,
        item: { ...recovery.item },
        recovered: true,
        recoveryStrategy: recovery.strategy,
        recoveredRef: recovery.item.ref,
      }
    }
    if (recovery.reason === 'ambiguous') {
      const detail = recovery.ambiguousStrategies?.map((a) => `${a.strategy}:${a.count}`).join(', ')
      return {
        error: `${name} is stale and could not be uniquely re-located (ambiguous match on ${detail}); read the page again`,
      }
    }
    return { error: `${name} is stale and could not be re-located on the current page; read the page again` }
  }

  list(context: RefContext): Array<{ ref: string; selector: string; item: ElementDescriptor }> {
    const out: Array<{ ref: string; selector: string; item: ElementDescriptor }> = []
    for (const entry of this.entries.values()) {
      if (sameContext(entry, context)) {
        out.push({ ref: entry.ref, selector: entry.selector, item: { ...entry.item } })
      }
    }
    return out
  }
}
