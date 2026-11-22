// Structural delta computation for `read --since`.
// Returns only what changed between two snapshots to dramatically cut AI token usage.

import type { ElementDescriptor, PageSnapshot } from '../types.js'

export interface PageDelta {
  changed: boolean
  urlChanged: boolean
  titleChanged: boolean
  previousUrl: string
  previousTitle?: string
  url: string
  title: string
  addedElements: ElementDescriptor[]
  removedElements: Array<{ ref?: string; selector: string; text: string; tag: string }>
  changedElements: Array<{
    ref?: string
    selector: string
    tag: string
    before: { text: string; value?: string; checked?: boolean; disabled?: boolean }
    after: { text: string; value?: string; checked?: boolean; disabled?: boolean }
  }>
  addedLines: string[]
  removedLines: string[]
}

function elementKey(el: ElementDescriptor): string {
  return el.selector || `${el.tag}:${el.id ?? ''}:${el.name ?? ''}:${el.text}`
}

export function computePageDelta(prev: PageSnapshot, next: PageSnapshot): PageDelta {
  const urlChanged = prev.url !== next.url
  const titleChanged = prev.title !== next.title

  const prevMap = new Map<string, ElementDescriptor>()
  for (const el of prev.elements) prevMap.set(elementKey(el), el)

  const nextMap = new Map<string, ElementDescriptor>()
  for (const el of next.elements) nextMap.set(elementKey(el), el)

  const addedElements: ElementDescriptor[] = []
  const changedElements: PageDelta['changedElements'] = []
  const removedElements: PageDelta['removedElements'] = []

  for (const [k, el] of nextMap) {
    const old = prevMap.get(k)
    if (!old) {
      addedElements.push(el)
    } else if (
      old.text !== el.text ||
      old.value !== el.value ||
      old.checked !== el.checked ||
      old.disabled !== el.disabled
    ) {
      changedElements.push({
        ref: el.ref,
        selector: el.selector,
        tag: el.tag,
        before: { text: old.text, value: old.value, checked: old.checked, disabled: old.disabled },
        after: { text: el.text, value: el.value, checked: el.checked, disabled: el.disabled },
      })
    }
  }

  for (const [k, old] of prevMap) {
    if (!nextMap.has(k)) {
      removedElements.push({ ref: old.ref, selector: old.selector, text: old.text, tag: old.tag })
    }
  }

  const prevLines = new Set(
    prev.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const nextLinesList = next.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const nextLines = new Set(nextLinesList)

  const addedLines = nextLinesList.filter((l) => !prevLines.has(l)).slice(0, 80)
  const removedLines = [...prevLines].filter((l) => !nextLines.has(l)).slice(0, 80)

  const changed =
    urlChanged ||
    titleChanged ||
    addedElements.length > 0 ||
    removedElements.length > 0 ||
    changedElements.length > 0 ||
    addedLines.length > 0 ||
    removedLines.length > 0

  return {
    changed,
    urlChanged,
    titleChanged,
    previousUrl: prev.url,
    previousTitle: prev.title,
    url: next.url,
    title: next.title,
    addedElements,
    removedElements,
    changedElements,
    addedLines,
    removedLines,
  }
}
