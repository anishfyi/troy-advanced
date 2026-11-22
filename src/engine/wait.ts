// Shared wait-condition utilities for Chromium CDP and Zero-Chrome Lite engines.
// Supports waiting on --text, --selector (with --state visible|hidden|attached),
// --url (substring, glob *, or /regex/), and --timeout.

import type { ElementDescriptor, WaitConditionOptions, WaitResult, WaitState } from '../types.js'

export const VALID_WAIT_STATES: readonly WaitState[] = ['visible', 'hidden', 'attached'] as const

export function parseWaitState(raw: unknown): WaitState | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (raw === 'visible' || raw === 'hidden' || raw === 'attached') return raw
  return { error: `invalid wait state "${String(raw)}" (expected visible, hidden, or attached)` }
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function matchesText(haystack: string, needle: string): boolean {
  const normNeedle = normalizeWhitespace(needle).toLowerCase()
  if (!normNeedle) return true
  return normalizeWhitespace(haystack).toLowerCase().includes(normNeedle)
}

export function matchesUrlPattern(currentUrl: string, pattern: string): boolean {
  const trimmed = pattern.trim()
  if (!trimmed) return true

  // Regex literal: /pattern/flags
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(trimmed)
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1]!, regexMatch[2])
      return re.test(currentUrl)
    } catch {
      return currentUrl.includes(trimmed)
    }
  }

  // Glob pattern with *
  if (trimmed.includes('*')) {
    const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    try {
      return new RegExp(`^${escaped}$`, 'i').test(currentUrl)
    } catch {
      return currentUrl.includes(trimmed)
    }
  }

  return currentUrl.includes(trimmed)
}

export function describeWaitCondition(opts: WaitConditionOptions): string {
  const parts: string[] = []
  if (opts.selector) {
    const st = opts.state ?? 'visible'
    parts.push(`selector "${opts.selector}" (state=${st})`)
  }
  if (opts.text) {
    parts.push(`text "${opts.text}"`)
  }
  if (opts.url) {
    parts.push(`url "${opts.url}"`)
  }
  return parts.length > 0 ? parts.join(' and ') : 'condition'
}

export interface WaitProbeResult {
  satisfied: boolean
  fatalError?: string
  matched?: WaitResult['matched']
}

export async function pollUntil(
  probe: () => Promise<WaitProbeResult> | WaitProbeResult,
  opts: { timeoutMs: number; pollIntervalMs?: number; description: string },
): Promise<WaitResult> {
  const timeoutMs = Math.max(0, Math.min(60000, opts.timeoutMs))
  const pollIntervalMs = Math.max(10, Math.min(1000, opts.pollIntervalMs ?? 50))
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  let lastProbe: WaitProbeResult | undefined

  while (true) {
    lastProbe = await probe()
    if (lastProbe.fatalError) {
      return {
        ok: false,
        waitedMs: Date.now() - startedAt,
        error: lastProbe.fatalError,
      }
    }
    if (lastProbe.satisfied) {
      return {
        ok: true,
        waitedMs: Date.now() - startedAt,
        matched: lastProbe.matched,
      }
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return {
        ok: false,
        timedOut: true,
        waitedMs: Date.now() - startedAt,
        matched: lastProbe.matched,
        error: `Timed out after ${timeoutMs}ms waiting for ${opts.description}`,
      }
    }

    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)))
  }
}

// --- Lightweight HTML DOM selector & visibility matcher for Lite engine ---

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

interface LiteDomNode {
  tag: string
  attrs: Record<string, string>
  hidden: boolean
  parent: LiteDomNode | null
}

function decodeBasicEntities(val: string): string {
  return val
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function parseTagAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[key] = decodeBasicEntities(val)
  }
  return attrs
}

function isAttrHidden(tag: string, attrs: Record<string, string>): boolean {
  if ('hidden' in attrs) return true
  if (attrs['aria-hidden']?.toLowerCase() === 'true') return true
  if (tag === 'input' && attrs.type?.toLowerCase() === 'hidden') return true
  const style = attrs.style ?? ''
  if (style) {
    if (/\bdisplay\s*:\s*none\b/i.test(style)) return true
    if (/\bvisibility\s*:\s*(?:hidden|collapse)\b/i.test(style)) return true
    if (/\bopacity\s*:\s*0(?:\.0+)?(?:\s*;|\s*$)/i.test(style)) return true
  }
  return false
}

function parseLiteDomNodes(html: string): LiteDomNode[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')

  const nodes: LiteDomNode[] = []
  const stack: LiteDomNode[] = []
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/)?>/g
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(cleaned)) !== null) {
    const isClose = Boolean(m[1])
    const tag = m[2]!.toLowerCase()
    const attrStr = m[3] ?? ''
    const selfClosing = Boolean(m[4]) || VOID_TAGS.has(tag)

    if (isClose) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }

    const attrs = parseTagAttrs(attrStr)
    const parent = stack.length > 0 ? stack[stack.length - 1]! : null
    const hidden = Boolean(parent?.hidden) || isAttrHidden(tag, attrs)
    const node: LiteDomNode = { tag, attrs, hidden, parent }
    nodes.push(node)
    if (!selfClosing) {
      stack.push(node)
    }
  }

  return nodes
}

interface SimpleSelectorPart {
  tag?: string
  id?: string
  classes: string[]
  attrs: Array<{ name: string; op?: '=' | '*=' | '^=' | '$='; value?: string }>
}

function parseSimpleSelector(raw: string): SimpleSelectorPart | null {
  const s = raw.trim()
  if (!s) return null
  const part: SimpleSelectorPart = { classes: [], attrs: [] }
  let i = 0

  // Optional tag or *
  const tagMatch = /^(\*|[a-zA-Z][a-zA-Z0-9:-]*)/.exec(s)
  if (tagMatch) {
    if (tagMatch[1] !== '*') part.tag = tagMatch[1]!.toLowerCase()
    i += tagMatch[0].length
  }

  while (i < s.length) {
    const ch = s[i]!
    if (ch === '#') {
      const idMatch = /^#([a-zA-Z0-9_:-]+)/.exec(s.slice(i))
      if (!idMatch) return null
      part.id = idMatch[1]
      i += idMatch[0].length
    } else if (ch === '.') {
      const clsMatch = /^\.([a-zA-Z0-9_:-]+)/.exec(s.slice(i))
      if (!clsMatch) return null
      part.classes.push(clsMatch[1]!)
      i += clsMatch[0].length
    } else if (ch === '[') {
      const attrMatch =
        /^\[\s*([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:(\*=|\^=|\$=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\s*\]/.exec(
          s.slice(i),
        )
      if (!attrMatch) return null
      const name = attrMatch[1]!.toLowerCase()
      const op = attrMatch[2] as '=' | '*=' | '^=' | '$=' | undefined
      const value = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5]?.trim()
      part.attrs.push({ name, op, value })
      i += attrMatch[0].length
    } else if (ch === ':') {
      // Ignore pseudo-classes like :nth-of-type(2) or :first-child for simple matching fallback
      const pseudoMatch = /^:[a-zA-Z-]+(?:\([^)]*\))?/.exec(s.slice(i))
      if (!pseudoMatch) return null
      i += pseudoMatch[0].length
    } else {
      return null
    }
  }

  return part
}

function matchesSimple(node: LiteDomNode, part: SimpleSelectorPart): boolean {
  if (part.tag && node.tag !== part.tag) return false
  if (part.id && node.attrs.id !== part.id) return false
  if (part.classes.length > 0) {
    const nodeClasses = new Set((node.attrs.class ?? '').split(/\s+/).filter(Boolean))
    for (const cls of part.classes) {
      if (!nodeClasses.has(cls)) return false
    }
  }
  for (const attr of part.attrs) {
    if (!(attr.name in node.attrs)) return false
    const actual = node.attrs[attr.name] ?? ''
    if (attr.op === '=' && actual !== (attr.value ?? '')) return false
    if (attr.op === '*=' && !actual.includes(attr.value ?? '')) return false
    if (attr.op === '^=' && !actual.startsWith(attr.value ?? '')) return false
    if (attr.op === '$=' && !actual.endsWith(attr.value ?? '')) return false
  }
  return true
}

function matchesComplexSelector(node: LiteDomNode, selector: string): boolean {
  // Split by combinators ('>' or whitespace) while preserving attribute brackets
  const tokens: Array<{ combinator: ' ' | '>'; part: SimpleSelectorPart }> = []
  const rawTokens: string[] = []
  let buf = ''
  let inBracket = 0
  let inQuote: string | null = null

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!
    if (inQuote) {
      buf += ch
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      buf += ch
      continue
    }
    if (ch === '[') {
      inBracket++
      buf += ch
      continue
    }
    if (ch === ']') {
      inBracket = Math.max(0, inBracket - 1)
      buf += ch
      continue
    }
    if (inBracket === 0 && (ch === '>' || /\s/.test(ch))) {
      if (buf.trim()) {
        rawTokens.push(buf.trim())
        buf = ''
      }
      if (ch === '>') rawTokens.push('>')
      continue
    }
    buf += ch
  }
  if (buf.trim()) rawTokens.push(buf.trim())
  if (rawTokens.length === 0) return false

  let pendingCombinator: ' ' | '>' = ' '
  for (const tok of rawTokens) {
    if (tok === '>') {
      pendingCombinator = '>'
      continue
    }
    const parsed = parseSimpleSelector(tok)
    if (!parsed) return false
    tokens.push({ combinator: pendingCombinator, part: parsed })
    pendingCombinator = ' '
  }
  if (tokens.length === 0) return false

  const last = tokens[tokens.length - 1]!
  if (!matchesSimple(node, last.part)) return false

  let currentNode: LiteDomNode | null = node
  for (let idx = tokens.length - 2; idx >= 0; idx--) {
    const comb = tokens[idx + 1]!.combinator
    const target = tokens[idx]!.part
    if (comb === '>') {
      currentNode = currentNode?.parent ?? null
      if (!currentNode || !matchesSimple(currentNode, target)) return false
    } else {
      let ancestor: LiteDomNode | null = currentNode?.parent ?? null
      while (ancestor && !matchesSimple(ancestor, target)) {
        ancestor = ancestor.parent
      }
      if (!ancestor) return false
      currentNode = ancestor
    }
  }
  return true
}

export function extractLitePageText(rawHtml: string): string {
  const cleaned = rawHtml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  return normalizeWhitespace(decodeBasicEntities(cleaned))
}

export function checkLiteSelectorState(
  rawHtml: string,
  elements: ElementDescriptor[],
  selector: string,
  state: WaitState,
): { matched: boolean; error?: string } {
  const trimmed = selector.trim()
  if (!trimmed) {
    return { matched: false, error: 'selector must be a non-empty string' }
  }

  const branches = trimmed.split(',').map((b) => b.trim()).filter(Boolean)
  if (branches.length === 0) {
    return { matched: false, error: `invalid selector "${selector}"` }
  }

  // Validate at least simple syntax (reject obviously broken selectors like '###' or '[unclosed')
  if (/\[[^\]]*$/.test(trimmed) || /^##/.test(trimmed) || /\.\./.test(trimmed)) {
    return { matched: false, error: `invalid selector "${selector}"` }
  }

  const nodes = parseLiteDomNodes(rawHtml)
  const matchedNodes = nodes.filter((n) => branches.some((branch) => matchesComplexSelector(n, branch)))

  // Fallback: also check exact synthetic element selectors from Lite parser (e.g. a:nth-of-type(2))
  const exactElementMatch = elements.some((e) => e.selector === trimmed)

  if (state === 'attached') {
    return { matched: matchedNodes.length > 0 || exactElementMatch }
  }
  if (state === 'visible') {
    const anyVisible = matchedNodes.some((n) => !n.hidden)
    return { matched: anyVisible || (matchedNodes.length === 0 && exactElementMatch) }
  }
  // state === 'hidden': satisfied if detached OR all matched nodes are hidden
  if (matchedNodes.length === 0) {
    return { matched: !exactElementMatch }
  }
  return { matched: matchedNodes.every((n) => n.hidden) }
}
