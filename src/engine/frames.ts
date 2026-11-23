// Cross-frame <iframe> selector parsing, coordinate translation, and snapshot flattening (M21).
//
// Selector syntax:
//   - Frame boundaries use `>>` (e.g. `iframe#checkout >> button#pay`,
//     `iframe#outer >> iframe#inner >> input[name="code"]`,
//     `app-shell >>> iframe#widget >> my-form >>> button#submit`,
//     or fallback `frame:<frameId> >> button#pay`).
//   - Single `>` remains the standard CSS child combinator.
//   - Triple `>>>` remains the Shadow DOM deep combinator (M20).

import type { ContentBlock, ElementDescriptor, FrameSummary, PageSnapshot, Rect } from '../types.js'

export const FRAME_COMBINATOR = '>>'
export const FRAME_ID_PREFIX = 'frame:'

export interface ParsedFrameSelector {
  frameSegments: string[]
  targetSelector: string
  isFrameSelector: boolean
}

/**
 * Splits a selector string on unquoted `>>` frame-piercing combinators while:
 * - preserving `>>>` (Shadow DOM combinator) intact inside segments
 * - preserving single `>` (CSS child combinator) intact inside segments
 * - ignoring `>>` inside quoted attribute values (`"..."` or `'...'`) and escapes
 */
export function splitFrameSelector(selector: string): string[] {
  const raw = String(selector ?? '')
  if (!raw.trim()) {
    throw new Error('Empty selector')
  }

  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }

    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    if (ch === '>') {
      // Count consecutive '>' characters
      let run = 1
      while (raw[i + run] === '>') run += 1

      if (run === 2) {
        const seg = current.trim()
        if (!seg) {
          throw new Error(`Invalid frame selector "${selector}": empty segment before ">>"`)
        }
        segments.push(seg)
        current = ''
        i += 1
        continue
      }

      // run === 1 (CSS child combinator) or run >= 3 (Shadow DOM '>>>' combinator)
      current += raw.slice(i, i + run)
      i += run - 1
      continue
    }

    current += ch
  }

  const tail = current.trim()
  if (!tail) {
    throw new Error(`Invalid frame selector "${selector}": trailing ">>" with empty segment`)
  }
  segments.push(tail)
  return segments
}

export function parseFrameSelector(selector: string): ParsedFrameSelector {
  const segments = splitFrameSelector(selector)
  if (segments.length <= 1) {
    return {
      frameSegments: [],
      targetSelector: segments[0]!,
      isFrameSelector: false,
    }
  }
  return {
    frameSegments: segments.slice(0, -1),
    targetSelector: segments[segments.length - 1]!,
    isFrameSelector: true,
  }
}

export function isFrameSelector(selector: string): boolean {
  try {
    return splitFrameSelector(selector).length > 1
  } catch {
    return false
  }
}

/**
 * Extracts a CDP frameId if a frame segment uses the `frame:<id>` fallback token.
 */
export function parseFrameIdToken(segment: string): string | null {
  const trimmed = segment.trim()
  if (!trimmed.startsWith(FRAME_ID_PREFIX)) return null
  const id = trimmed.slice(FRAME_ID_PREFIX.length).trim()
  return id || null
}

/**
 * Builds a unique cross-frame selector by joining the frame chain and local selector with ` >> `.
 */
export function prefixFrameSelector(frameChain: readonly string[], localSelector: string): string {
  const cleanChain = frameChain.map((s) => s.trim()).filter(Boolean)
  const local = localSelector.trim()
  if (cleanChain.length === 0) return local
  return `${cleanChain.join(` ${FRAME_COMBINATOR} `)} ${FRAME_COMBINATOR} ${local}`
}

/**
 * Offsets a bounding rect from a child frame's local viewport into top-level viewport coordinates.
 */
export function offsetRect(rect: Rect | undefined, offsetX: number, offsetY: number): Rect | undefined {
  if (!rect) return undefined
  return {
    x: Math.round(rect.x + offsetX),
    y: Math.round(rect.y + offsetY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/**
 * Determines whether two URLs have different origins (treating about:blank / about:srcdoc as same-origin).
 */
export function isCrossOriginUrl(parentUrl: string, childUrl: string): boolean {
  if (!childUrl || childUrl.startsWith('about:') || childUrl.startsWith('javascript:')) return false
  try {
    const p = new URL(parentUrl)
    const c = new URL(childUrl)
    if (p.origin === 'null' || c.origin === 'null') return false
    return p.origin !== c.origin
  } catch {
    return false
  }
}

export interface RawFrameSnapshot {
  url: string
  title: string
  viewport: PageSnapshot['viewport']
  blocks: Array<ContentBlock & { selector?: string }>
  elements: ElementDescriptor[]
  text: string
}

export interface ChildFrameSnapshotInput {
  frameId: string
  parentFrameId?: string
  url: string
  name?: string
  title?: string
  selectorChain: string[]
  offsetX: number
  offsetY: number
  box?: Rect
  crossOrigin?: boolean
  snapshot: Pick<RawFrameSnapshot, 'blocks' | 'elements' | 'text' | 'title' | 'url'>
}

export interface FlattenFramesOptions {
  maxElements?: number
  maxBlocks?: number
  maxTextChars?: number
}

export interface FlattenedSnapshotResult {
  blocks: Array<ContentBlock & { selector?: string }>
  elements: ElementDescriptor[]
  frames?: FrameSummary[]
  text: string
}

/**
 * Flattens child frame snapshots into the top-level document snapshot:
 * - Prefixes every child element and block selector with its `frameChain >> localSelector`
 * - Translates every child `box` into top-level viewport coordinates
 * - Scopes `formId` per frame so embedded forms never collide with top-level forms
 * - Attaches `frameId`, `frameUrl`, and `frameName` metadata to child elements/blocks
 * - Appends child frame text so `page_text` and `waitFor({ text })` see embedded content
 */
export function flattenFrameSnapshots(
  main: RawFrameSnapshot,
  children: ChildFrameSnapshotInput[],
  options: FlattenFramesOptions = {},
): FlattenedSnapshotResult {
  const maxElements = options.maxElements ?? 350
  const maxBlocks = options.maxBlocks ?? 400
  const maxTextChars = options.maxTextChars ?? 30000

  const elements: ElementDescriptor[] = [...main.elements].slice(0, maxElements)
  const blocks: Array<ContentBlock & { selector?: string }> = [...main.blocks].slice(0, maxBlocks)
  const textParts: string[] = main.text.trim() ? [main.text.trim()] : []
  const frames: FrameSummary[] = []

  let frameIndex = 0
  for (const child of children) {
    frameIndex += 1
    const frameUrl = child.snapshot.url || child.url || 'about:blank'
    const frameName = child.name || child.title || child.snapshot.title || undefined
    const frameSelector = child.selectorChain.join(` ${FRAME_COMBINATOR} `)
    const formPrefix = `f${frameIndex}-`

    let addedElements = 0
    for (const rawEl of child.snapshot.elements) {
      if (elements.length >= maxElements) break
      const prefixedSelector = prefixFrameSelector(child.selectorChain, rawEl.selector)
      const translated: ElementDescriptor = {
        ...rawEl,
        selector: prefixedSelector,
        ...(rawEl.box ? { box: offsetRect(rawEl.box, child.offsetX, child.offsetY) } : {}),
        frameId: child.frameId,
        frameUrl,
        ...(frameName ? { frameName } : {}),
      }
      elements.push(translated)
      addedElements += 1
    }

    for (const rawBlock of child.snapshot.blocks) {
      if (blocks.length >= maxBlocks) break
      const nextBlock: ContentBlock & { selector?: string } = {
        ...rawBlock,
        ...(rawBlock.box ? { box: offsetRect(rawBlock.box, child.offsetX, child.offsetY) } : {}),
        ...(rawBlock.selector ? { selector: prefixFrameSelector(child.selectorChain, rawBlock.selector) } : {}),
        ...(rawBlock.formId ? { formId: `${formPrefix}${rawBlock.formId}` } : {}),
        frameId: child.frameId,
        frameUrl,
        ...(frameName ? { frameName } : {}),
      }
      if (rawBlock.links && rawBlock.links.length > 0) {
        nextBlock.links = rawBlock.links.map((lnk) => ({
          ...lnk,
          ...(lnk.selector ? { selector: prefixFrameSelector(child.selectorChain, lnk.selector) } : {}),
        }))
      }
      blocks.push(nextBlock)
    }

    const childText = (child.snapshot.text || '').trim()
    if (childText) {
      textParts.push(childText)
    }

    frames.push({
      frameId: child.frameId,
      ...(child.parentFrameId ? { parentFrameId: child.parentFrameId } : {}),
      ...(child.name ? { name: child.name } : {}),
      ...(child.title || child.snapshot.title ? { title: child.title || child.snapshot.title } : {}),
      url: frameUrl,
      ...(frameSelector ? { selector: frameSelector } : {}),
      ...(child.box ? { box: child.box } : {}),
      elementCount: addedElements,
      ...(child.crossOrigin !== undefined ? { crossOrigin: child.crossOrigin } : {}),
    })
  }

  return {
    blocks,
    elements,
    ...(frames.length > 0 ? { frames } : {}),
    text: textParts.join('\n\n').slice(0, maxTextChars),
  }
}

/**
 * Browser-side functionDeclaration passed to CDP `Runtime.callFunctionOn` on an
 * `<iframe>` owner element to compute its visibility, content-box viewport offset,
 * bounding box, title/name, and Shadow-DOM-aware CSS selector inside its parent document.
 */
export const IFRAME_OWNER_INFO_FUNCTION = `function() {
  const el = this;
  if (!el || el.nodeType !== 1) return { visible: false };
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const visible = Boolean(
    style &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) !== 0 &&
    (rect.width > 0 || rect.height > 0)
  );
  const bl = parseFloat(style ? style.borderLeftWidth : '0') || 0;
  const bt = parseFloat(style ? style.borderTopWidth : '0') || 0;
  const pl = parseFloat(style ? style.paddingLeft : '0') || 0;
  const pt = parseFloat(style ? style.paddingTop : '0') || 0;

  function cssEscape(str) {
    return String(str).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\\\]^\`{|}~])/g, '\\\\$1');
  }

  function localSelectorInRoot(node, root) {
    if (node.id) {
      const candidate = '#' + cssEscape(node.id);
      try {
        if (root.querySelectorAll(candidate).length === 1) return candidate;
      } catch {}
    }
    const nameAttr = node.getAttribute && node.getAttribute('name');
    if (nameAttr && node.tagName.toLowerCase() === 'iframe') {
      const candidate = 'iframe[name="' + nameAttr.replace(/"/g, '\\\\"') + '"]';
      try {
        if (root.querySelectorAll(candidate).length === 1) return candidate;
      } catch {}
    }
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += '#' + cssEscape(cur.id);
        parts.unshift(part);
        break;
      }
      const n = cur.getAttribute && cur.getAttribute('name');
      if (n && part === 'iframe') {
        part += '[name="' + n.replace(/"/g, '\\\\"') + '"]';
      } else {
        const parent = cur.parentElement || (cur.parentNode && cur.parentNode.nodeType === 11 ? cur.parentNode : null);
        if (parent && parent.children) {
          const siblings = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
          if (siblings.length > 1) {
            part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
          }
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function selectorFor(node) {
    const segments = [];
    let cur = node;
    let guard = 0;
    while (cur && guard < 12) {
      guard += 1;
      const root = cur.getRootNode ? cur.getRootNode() : document;
      const queryRoot = root && typeof root.querySelectorAll === 'function' ? root : document;
      segments.unshift(localSelectorInRoot(cur, queryRoot));
      if (root && root !== document && root.host) {
        cur = root.host;
      } else {
        break;
      }
    }
    return segments.join(' >>> ');
  }

  return {
    visible,
    contentX: rect.left + bl + pl,
    contentY: rect.top + bt + pt,
    box: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    selector: selectorFor(el),
    name: el.getAttribute('name') || '',
    title: el.getAttribute('title') || el.getAttribute('aria-label') || '',
  };
}`
