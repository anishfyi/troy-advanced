// Opaque element capabilities (e1, e2, ...).
// Bound to (tabId, url, epoch); expires cleanly when the document navigates.

import type { ElementDescriptor } from '../types.js'

export interface RefContext {
  tabId: number
  url: string
  epoch: number
}

interface StoredRef {
  ref: string
  selector: string
  item: ElementDescriptor
  tabId: number
  url: string
  epoch: number
}

export class ElementRegistry {
  private entries = new Map<string, StoredRef>()
  private counter = 0

  invalidate(): void {
    this.entries.clear()
  }

  register(items: ElementDescriptor[], context: RefContext): ElementDescriptor[] {
    this.invalidate()
    return this.add(items, context)
  }

  add(items: ElementDescriptor[], context: RefContext): ElementDescriptor[] {
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

  resolve(ref: unknown, context: RefContext): { selector: string; item: ElementDescriptor } | { error: string } {
    const name = String(ref ?? '').trim()
    if (!/^e\d+$/.test(name)) {
      return { error: 'the element reference is missing or malformed; read the page again' }
    }
    const entry = this.entries.get(name)
    if (!entry) {
      return { error: `${name} is stale or unknown; read the page again` }
    }
    if (entry.tabId !== context.tabId || entry.url !== context.url || entry.epoch !== context.epoch) {
      this.invalidate()
      return { error: `${name} belongs to an older page state; read the page again` }
    }
    return { selector: entry.selector, item: { ...entry.item } }
  }

  list(context: RefContext): Array<{ ref: string; selector: string; item: ElementDescriptor }> {
    const out: Array<{ ref: string; selector: string; item: ElementDescriptor }> = []
    for (const entry of this.entries.values()) {
      if (entry.tabId === context.tabId && entry.url === context.url && entry.epoch === context.epoch) {
        out.push({ ref: entry.ref, selector: entry.selector, item: { ...entry.item } })
      }
    }
    return out
  }
}
