// Shadow DOM deep selector parsing and browser-side traversal helpers (M20).
// Supports both explicit shadow-piercing chains (`host >>> inner >>> target`)
// and plain CSS selectors (`#btn`, `input[name="email"]`) that transparently
// fall back to traversing open ShadowRoot trees in document order.

export const DEEP_COMBINATOR = '>>>'

/**
 * Splits a selector string on `>>>` shadow-piercing combinators while ignoring
 * `>>>` occurrences inside quoted attribute values (`"..."` or `'...'`).
 * Throws if the selector or any segment is empty.
 */
export function splitDeepSelector(selector: string): string[] {
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

    if (ch === '>' && raw[i + 1] === '>' && raw[i + 2] === '>') {
      const seg = current.trim()
      if (!seg) {
        throw new Error(`Invalid deep selector "${selector}": empty segment before ">>>"`)
      }
      segments.push(seg)
      current = ''
      i += 2
      continue
    }

    current += ch
  }

  const tail = current.trim()
  if (!tail) {
    throw new Error(`Invalid deep selector "${selector}": trailing ">>>" with empty segment`)
  }
  segments.push(tail)
  return segments
}

/**
 * Returns true if the selector contains an unquoted `>>>` shadow-piercing combinator.
 */
export function isDeepSelector(selector: string): boolean {
  try {
    return splitDeepSelector(selector).length > 1
  } catch {
    return false
  }
}

/**
 * Browser-injectable JS helper defining:
 * - `splitDeepSelector(selector)`
 * - `querySelectorDeep(selector, root = document)`
 * - `querySelectorAllDeep(selector, root = document)`
 *
 * Light-DOM fast path: for single-segment selectors in `querySelectorDeep`,
 * `root.querySelector(selector)` runs first with zero shadow traversal overhead.
 * Invalid CSS syntax re-throws DOMException/SyntaxError so callers can report it.
 */
export const SHADOW_DOM_QUERY_HELPER = `
function splitDeepSelector(selector) {
  const raw = String(selector ?? '');
  if (!raw.trim()) throw new Error('Empty selector');
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '>' && raw[i + 1] === '>' && raw[i + 2] === '>') {
      const seg = current.trim();
      if (!seg) throw new Error('Invalid deep selector "' + selector + '": empty segment');
      segments.push(seg);
      current = '';
      i += 2;
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (!tail) throw new Error('Invalid deep selector "' + selector + '": empty trailing segment');
  segments.push(tail);
  return segments;
}

function collectShadowRoots(rootNode, out, seen) {
  let children;
  try {
    children = rootNode.querySelectorAll('*');
  } catch {
    return;
  }
  for (const el of children) {
    if (el.shadowRoot && !seen.has(el.shadowRoot)) {
      seen.add(el.shadowRoot);
      out.push(el.shadowRoot);
      collectShadowRoots(el.shadowRoot, out, seen);
    }
  }
}

function querySegmentInRoot(rootNode, cssSelector, firstOnly) {
  if (firstOnly) {
    const direct = rootNode.querySelector(cssSelector);
    if (direct) return [direct];
    const nestedRoots = [];
    collectShadowRoots(rootNode, nestedRoots, new Set([rootNode]));
    for (const sr of nestedRoots) {
      const found = sr.querySelector(cssSelector);
      if (found) return [found];
    }
    return [];
  }
  const results = [];
  const seenEls = new Set();
  const addFrom = (r) => {
    for (const el of r.querySelectorAll(cssSelector)) {
      if (!seenEls.has(el)) {
        seenEls.add(el);
        results.push(el);
      }
    }
  };
  addFrom(rootNode);
  const nestedRoots = [];
  collectShadowRoots(rootNode, nestedRoots, new Set([rootNode]));
  for (const sr of nestedRoots) {
    addFrom(sr);
  }
  return results;
}

function querySelectorAllDeep(selector, root = document) {
  const segments = splitDeepSelector(selector);
  if (segments.length === 1) {
    return querySegmentInRoot(root, segments[0], false);
  }
  let roots = [root];
  for (let i = 0; i < segments.length - 1; i++) {
    const nextRoots = [];
    const seenShadows = new Set();
    for (const r of roots) {
      const hosts = querySegmentInRoot(r, segments[i], false);
      for (const host of hosts) {
        if (host.shadowRoot && !seenShadows.has(host.shadowRoot)) {
          seenShadows.add(host.shadowRoot);
          nextRoots.push(host.shadowRoot);
        }
      }
    }
    roots = nextRoots;
    if (roots.length === 0) return [];
  }
  const lastSeg = segments[segments.length - 1];
  const results = [];
  const seenEls = new Set();
  for (const r of roots) {
    for (const el of querySegmentInRoot(r, lastSeg, false)) {
      if (!seenEls.has(el)) {
        seenEls.add(el);
        results.push(el);
      }
    }
  }
  return results;
}

function querySelectorDeep(selector, root = document) {
  const segments = splitDeepSelector(selector);
  if (segments.length === 1) {
    const found = querySegmentInRoot(root, segments[0], true);
    return found[0] || null;
  }
  let roots = [root];
  for (let i = 0; i < segments.length - 1; i++) {
    const nextRoots = [];
    const seenShadows = new Set();
    for (const r of roots) {
      const hosts = querySegmentInRoot(r, segments[i], false);
      for (const host of hosts) {
        if (host.shadowRoot && !seenShadows.has(host.shadowRoot)) {
          seenShadows.add(host.shadowRoot);
          nextRoots.push(host.shadowRoot);
        }
      }
    }
    roots = nextRoots;
    if (roots.length === 0) return null;
  }
  const lastSeg = segments[segments.length - 1];
  for (const r of roots) {
    const found = querySegmentInRoot(r, lastSeg, true);
    if (found.length > 0) return found[0];
  }
  return null;
}
`
