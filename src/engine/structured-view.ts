// JSON & XML pretty-formatter views with collapsible path navigation for the Lite engine (M37).
// Produces strict-ASCII-friendly ContentBlock[] + ElementDescriptor[] trees that work seamlessly
// with BrowserManager eN refs, --since delta reads, Agent Socket, MCP, Pipe REPL, and TUI.

import type { ContentBlock, ElementDescriptor, InlineLink } from '../types.js'
import { decodeHtmlEntities } from './html-entities.js'

export type StructuredKind = 'json' | 'xml'

export interface StructuredViewOptions {
  /** Explicit per-path collapse overrides: true = collapsed, false = expanded. */
  collapsedPaths?: ReadonlyMap<string, boolean>
  /** Optional focused path (e.g. `$.users[0]` or `/catalog/book[1]`) to zoom into a subtree. */
  focusPath?: string | null
  /** Relative depth at which containers start collapsed by default (default: 2). */
  defaultExpandDepth?: number
  /** Safety cap on rendered nodes to keep large payloads fast and token-bounded (default: 400). */
  maxNodes?: number
}

export interface StructuredDocumentResult {
  kind: StructuredKind
  title: string
  blocks: Array<ContentBlock & { selector?: string }>
  elements: ElementDescriptor[]
  text: string
  /** All collapsible container paths in the document (used by Expand All / Collapse All). */
  containerPaths: string[]
  /** Effective focused path (`$` for JSON root, `/<root>` for XML root, or the zoomed subpath). */
  activePath: string
  /** Root path of the document (`$` for JSON, `/<root>` for XML). */
  rootPath: string
  /** Parse warning/error message if the payload was malformed. */
  parseError?: string
}

export interface JsonTreeNode {
  path: string
  key: string
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  value?: string | number | boolean | null
  children: JsonTreeNode[]
  depth: number
  parentPath: string | null
  size: number
}

export interface XmlTreeNode {
  path: string
  tag: string
  attributes: Array<{ name: string; value: string }>
  text: string
  children: XmlTreeNode[]
  depth: number
  parentPath: string | null
}

const VALID_JSON_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const HTTP_URL_RE = /^https?:\/\/[^\s<>"{}|\\^`[\]]+$/i

/**
 * Detect whether an HTTP response should be rendered by the JSON or XML structured view.
 * Explicitly excludes HTML (`text/html`, `application/xhtml+xml`) and `text/plain`.
 */
export function detectStructuredKind(contentType: string, body: string, url?: string): StructuredKind | null {
  const mime = (contentType || '').split(';')[0]?.trim().toLowerCase() ?? ''

  if (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'text/plain') {
    return null
  }
  if (mime === 'application/json' || mime === 'text/json' || (mime.startsWith('application/') && mime.endsWith('+json'))) {
    return 'json'
  }
  if (
    mime === 'application/xml' ||
    mime === 'text/xml' ||
    mime === 'image/svg+xml' ||
    (mime.startsWith('application/') && mime.endsWith('+xml'))
  ) {
    return 'xml'
  }

  // Fallback sniffing only when MIME is empty or generic binary/octet-stream
  if (!mime || mime === 'application/octet-stream') {
    const trimmed = body.trimStart()
    if (trimmed.startsWith('<?xml')) return 'xml'
    let pathname = ''
    if (url) {
      try {
        pathname = new URL(url).pathname.toLowerCase()
      } catch {
        pathname = url.toLowerCase()
      }
    }
    if (pathname.endsWith('.json') && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      return 'json'
    }
    if (pathname.endsWith('.xml') && trimmed.startsWith('<')) {
      return 'xml'
    }
  }

  return null
}

/**
 * Format a child JSONPath segment cleanly using dot notation for simple identifiers
 * and bracket notation for array indices or keys containing special characters.
 */
export function formatJsonPathSegment(parentPath: string, key: string | number): string {
  if (typeof key === 'number') {
    return `${parentPath}[${key}]`
  }
  if (VALID_JSON_IDENT.test(key)) {
    return `${parentPath}.${key}`
  }
  return `${parentPath}[${JSON.stringify(key)}]`
}

function buildJsonTree(
  value: unknown,
  path: string,
  key: string,
  depth: number,
  parentPath: string | null,
): JsonTreeNode {
  if (value === null) {
    return { path, key, type: 'null', value: null, children: [], depth, parentPath, size: 0 }
  }
  if (Array.isArray(value)) {
    const children = value.map((item, idx) =>
      buildJsonTree(item, formatJsonPathSegment(path, idx), `[${idx}]`, depth + 1, path),
    )
    return { path, key, type: 'array', children, depth, parentPath, size: value.length }
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const children = entries.map(([k, v]) =>
      buildJsonTree(v, formatJsonPathSegment(path, k), k, depth + 1, path),
    )
    return { path, key, type: 'object', children, depth, parentPath, size: entries.length }
  }
  if (typeof value === 'string') {
    return { path, key, type: 'string', value, children: [], depth, parentPath, size: 0 }
  }
  if (typeof value === 'number') {
    return { path, key, type: 'number', value, children: [], depth, parentPath, size: 0 }
  }
  return { path, key, type: 'boolean', value: Boolean(value), children: [], depth, parentPath, size: 0 }
}

function collectJsonNodesByPath(node: JsonTreeNode, map: Map<string, JsonTreeNode>, containers: string[]): void {
  map.set(node.path, node)
  if ((node.type === 'object' || node.type === 'array') && node.size > 0) {
    containers.push(node.path)
    for (const child of node.children) {
      collectJsonNodesByPath(child, map, containers)
    }
  }
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`
}

function formatJsonPrimitive(node: JsonTreeNode): string {
  if (node.type === 'null') return 'null'
  if (node.type === 'string') {
    const raw = String(node.value ?? '')
    return JSON.stringify(truncateText(raw, 160))
  }
  return String(node.value)
}

function formatJsonContainerSummary(node: JsonTreeNode, collapsed: boolean): string {
  if (node.type === 'array') {
    if (node.size === 0) return '[]'
    return collapsed ? `[${node.size} ${node.size === 1 ? 'item' : 'items'}]` : `[ (${node.size} ${node.size === 1 ? 'item' : 'items'})`
  }
  if (node.size === 0) return '{}'
  if (!collapsed) {
    return `{ (${node.size} ${node.size === 1 ? 'key' : 'keys'})`
  }
  const keyPreview = node.children
    .slice(0, 4)
    .map((c) => c.key)
    .join(', ')
  const suffix = node.size > 4 ? ', ...' : ''
  return `{${node.size} ${node.size === 1 ? 'key' : 'keys'}: ${truncateText(keyPreview + suffix, 48)}}`
}

function makeTitleFromUrl(prefix: string, url: string): string {
  try {
    const parsed = new URL(url)
    const label = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : parsed.host || url
    return `${prefix}: ${label}`
  } catch {
    return `${prefix}: ${url}`
  }
}

function buildTreePrefix(ancestorHasNext: boolean[], isLast: boolean): string {
  if (ancestorHasNext.length === 0) return ''
  let out = ''
  for (let i = 0; i < ancestorHasNext.length - 1; i++) {
    out += ancestorHasNext[i] ? '|  ' : '   '
  }
  out += isLast ? '`- ' : '|- '
  return out
}

function resolveMaybeUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim()
  if (!HTTP_URL_RE.test(trimmed)) return null
  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return null
  }
}

function buildJsonBreadcrumbs(byPath: Map<string, JsonTreeNode>, activeNode: JsonTreeNode): Array<{ label: string; path: string }> {
  const chain: Array<{ label: string; path: string }> = []
  let cur: JsonTreeNode | undefined = activeNode
  while (cur) {
    chain.push({ label: cur.key, path: cur.path })
    cur = cur.parentPath ? byPath.get(cur.parentPath) : undefined
  }
  chain.reverse()
  return chain
}

/**
 * Parse and format a JSON response into a navigable, collapsible Lite document.
 */
export function parseJsonDocument(
  rawBody: string,
  baseUrl: string,
  options?: StructuredViewOptions,
): StructuredDocumentResult {
  const title = makeTitleFromUrl('JSON', baseUrl)
  const blocks: Array<ContentBlock & { selector?: string }> = []
  const elements: ElementDescriptor[] = []
  const textLines: string[] = []

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    const heading = `${title} (Invalid JSON)`
    blocks.push({ kind: 'heading', level: 1, text: heading, tag: 'h1' })
    blocks.push({ kind: 'paragraph', text: `JSON parse error: ${msg}`, tag: 'p' })
    blocks.push({ kind: 'code', text: rawBody.slice(0, 16000), tag: 'pre' })
    return {
      kind: 'json',
      title: heading,
      blocks,
      elements,
      text: `${heading}\nJSON parse error: ${msg}\n${rawBody.slice(0, 4000)}`,
      containerPaths: [],
      activePath: '$',
      rootPath: '$',
      parseError: msg,
    }
  }

  const root = buildJsonTree(parsed, '$', '$', 0, null)
  const byPath = new Map<string, JsonTreeNode>()
  const containerPaths: string[] = []
  collectJsonNodesByPath(root, byPath, containerPaths)

  const requestedFocus = options?.focusPath?.trim()
  const activeRoot = (requestedFocus && byPath.get(requestedFocus)) || root
  const defaultExpandDepth = options?.defaultExpandDepth ?? 2
  const maxNodes = options?.maxNodes ?? 400
  const collapsedPaths = options?.collapsedPaths

  const rootMeta =
    root.type === 'object'
      ? `object, ${root.size} ${root.size === 1 ? 'key' : 'keys'}`
      : root.type === 'array'
        ? `array, ${root.size} ${root.size === 1 ? 'item' : 'items'}`
        : root.type
  const headingText = `${title} (${rootMeta})`
  blocks.push({ kind: 'heading', level: 1, text: headingText, tag: 'h1' })
  textLines.push(headingText)

  // Toolbar with Expand All / Collapse All / Reset to $
  if (containerPaths.length > 0 || activeRoot.path !== '$') {
    const toolbarParts: string[] = []
    const toolbarLinks: InlineLink[] = []
    let cursor = 0

    const pushToolbarButton = (selector: string, label: string, ariaLabel: string) => {
      if (toolbarParts.length > 0) {
        toolbarParts.push('  ')
        cursor += 2
      }
      const start = cursor
      toolbarParts.push(label)
      cursor += label.length
      toolbarLinks.push({ text: label, selector, start, end: cursor })
      elements.push({
        selector,
        tag: 'button',
        type: 'button',
        role: 'button',
        text: label,
        ariaLabel,
      })
    }

    if (containerPaths.length > 0) {
      pushToolbarButton('json-action:expand-all', 'Expand All', 'Expand all JSON containers')
      pushToolbarButton('json-action:collapse-all', 'Collapse All', 'Collapse all JSON containers')
    }
    if (activeRoot.path !== '$') {
      pushToolbarButton('json-focus:$', 'Reset to $', 'Reset JSON focus to root $')
    }

    const toolbarText = toolbarParts.join('')
    blocks.push({ kind: 'paragraph', text: toolbarText, tag: 'div', links: toolbarLinks })
    textLines.push(toolbarText)
  }

  // Path breadcrumbs
  const crumbs = buildJsonBreadcrumbs(byPath, activeRoot)
  if (crumbs.length === 1) {
    const pathLine = `Path: ${activeRoot.path}`
    blocks.push({ kind: 'paragraph', text: pathLine, tag: 'nav' })
    textLines.push(pathLine)
  } else {
    const parts: string[] = ['Path: ']
    const crumbLinks: InlineLink[] = []
    let cursor = parts[0]!.length
    for (let i = 0; i < crumbs.length; i++) {
      const crumb = crumbs[i]!
      if (i > 0) {
        parts.push(' > ')
        cursor += 3
      }
      const isCurrent = i === crumbs.length - 1
      if (isCurrent) {
        parts.push(crumb.label)
        cursor += crumb.label.length
      } else {
        const sel = `json-focus:${crumb.path}`
        const start = cursor
        parts.push(crumb.label)
        cursor += crumb.label.length
        crumbLinks.push({ text: crumb.label, selector: sel, start, end: cursor })
        elements.push({
          selector: sel,
          tag: 'button',
          type: 'button',
          role: 'button',
          text: crumb.label,
          ariaLabel: `Focus JSON path ${crumb.path}`,
        })
      }
    }
    const line = parts.join('')
    blocks.push({ kind: 'paragraph', text: line, tag: 'nav', links: crumbLinks })
    textLines.push(line)
  }

  let renderedCount = 0
  let truncated = false

  const isCollapsed = (node: JsonTreeNode, relDepth: number): boolean => {
    if (collapsedPaths && collapsedPaths.has(node.path)) {
      return Boolean(collapsedPaths.get(node.path))
    }
    return relDepth >= defaultExpandDepth
  }

  const renderNode = (node: JsonTreeNode, relDepth: number, ancestorHasNext: boolean[], isLast: boolean) => {
    if (renderedCount >= maxNodes) {
      truncated = true
      return
    }
    renderedCount += 1

    const prefix = buildTreePrefix(ancestorHasNext, isLast)
    const isContainer = (node.type === 'object' || node.type === 'array') && node.size > 0
    const keyLabel = node.path === activeRoot.path ? node.path : node.key.startsWith('[') ? node.key : `"${node.key}"`

    if (!isContainer) {
      // Primitive or empty container
      const valStr =
        node.type === 'object' || node.type === 'array'
          ? formatJsonContainerSummary(node, true)
          : formatJsonPrimitive(node)

      if (node.type === 'string' && typeof node.value === 'string') {
        const href = resolveMaybeUrl(node.value, baseUrl)
        if (href) {
          const linkText = truncateText(node.value.trim(), 120)
          const sel = `json-link:${node.path}`
          const lead = `${prefix}${keyLabel}: `
          const line = `${lead}${linkText}`
          elements.push({
            selector: sel,
            tag: 'a',
            type: 'link',
            role: 'link',
            text: linkText,
            href,
            ariaLabel: `Open URL at ${node.path}`,
          })
          blocks.push({
            kind: 'paragraph',
            text: line,
            tag: 'div',
            links: [{ text: linkText, href, selector: sel, start: lead.length, end: line.length }],
          })
          textLines.push(line)
          return
        }
      }

      const line = `${prefix}${keyLabel}: ${valStr}`
      blocks.push({ kind: 'paragraph', text: line, tag: 'div' })
      textLines.push(line)
      return
    }

    const collapsed = isCollapsed(node, relDepth)
    const marker = collapsed ? '>' : 'v'
    const summary = formatJsonContainerSummary(node, collapsed)
    const toggleLabel = `${marker} ${keyLabel}: ${summary}`
    const toggleSel = `json-toggle:${node.path}`

    elements.push({
      selector: toggleSel,
      tag: 'button',
      type: 'button',
      role: 'button',
      text: toggleLabel,
      ariaLabel: `${collapsed ? 'Expand' : 'Collapse'} ${node.path}`,
      checked: !collapsed,
    })

    const inlineLinks: InlineLink[] = [
      {
        text: toggleLabel,
        selector: toggleSel,
        start: prefix.length,
        end: prefix.length + toggleLabel.length,
      },
    ]

    let line = `${prefix}${toggleLabel}`

    // Emit clickable path focus action for nested containers
    if (node.path !== activeRoot.path) {
      const focusLabel = `focus ${node.path}`
      const focusSel = `json-focus:${node.path}`
      const start = line.length + 1
      line = `${line} ${focusLabel}`
      elements.push({
        selector: focusSel,
        tag: 'button',
        type: 'button',
        role: 'button',
        text: focusLabel,
        ariaLabel: `Focus JSON path ${node.path}`,
      })
      inlineLinks.push({
        text: focusLabel,
        selector: focusSel,
        start,
        end: line.length,
      })
    }

    blocks.push({ kind: 'paragraph', text: line, tag: 'div', links: inlineLinks })
    textLines.push(line)

    if (!collapsed) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!
        const childIsLast = i === node.children.length - 1
        renderNode(child, relDepth + 1, [...ancestorHasNext, !childIsLast], childIsLast)
        if (truncated) break
      }
    }
  }

  renderNode(activeRoot, 0, [], true)

  if (truncated) {
    const note = `... truncated after ${maxNodes} nodes; use focus or collapse controls to inspect deeper paths`
    blocks.push({ kind: 'paragraph', text: note, tag: 'p' })
    textLines.push(note)
  }

  return {
    kind: 'json',
    title: headingText,
    blocks,
    elements,
    text: textLines.join('\n'),
    containerPaths,
    activePath: activeRoot.path,
    rootPath: '$',
  }
}

// ---------------------------------------------------------------------------
// Zero-dependency XML parser & collapsible XPath tree view
// ---------------------------------------------------------------------------

interface RawXmlNode {
  tag: string
  attributes: Array<{ name: string; value: string }>
  textParts: string[]
  children: RawXmlNode[]
}

function parseXmlAttributes(attrStr: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = []
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    attrs.push({
      name: m[1]!,
      value: decodeHtmlEntities(m[2] ?? m[3] ?? ''),
    })
  }
  return attrs
}

export function parseXmlTree(rawXml: string): { root: XmlTreeNode | null; error?: string } {
  // Strip UTF-8 BOM if present
  const input = rawXml.replace(/^\uFEFF/, '')
  const stack: RawXmlNode[] = []
  let rootRaw: RawXmlNode | null = null
  let parseError: string | undefined

  // Tokenize XML: comments, CDATA, processing instructions, DOCTYPE, closing tags, opening/self-closing tags, text
  const tokenRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE\b[\s\S]*?(?:\[[\s\S]*?\])?\s*>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/gi

  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(input)) !== null) {
    const full = match[0]!
    const cdata = match[1]
    const closeTag = match[2]
    const openTag = match[3]
    const attrStr = match[4] ?? ''
    const selfClosing = match[5] === '/'
    const textChunk = match[6]

    if (cdata !== undefined) {
      const top = stack[stack.length - 1]
      if (top) top.textParts.push(cdata)
      continue
    }

    if (closeTag !== undefined) {
      if (stack.length === 0) {
        parseError ??= `Unexpected closing tag </${closeTag}>`
        continue
      }
      // Find matching tag on stack (best-effort recovery if mismatched)
      let matchIdx = -1
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === closeTag) {
          matchIdx = i
          break
        }
      }
      if (matchIdx === -1) {
        parseError ??= `Mismatched closing tag </${closeTag}>`
        continue
      }
      if (matchIdx !== stack.length - 1) {
        parseError ??= `Unclosed tag <${stack[stack.length - 1]!.tag}> before </${closeTag}>`
      }
      stack.length = matchIdx
      continue
    }

    if (openTag !== undefined) {
      const node: RawXmlNode = {
        tag: openTag,
        attributes: parseXmlAttributes(attrStr),
        textParts: [],
        children: [],
      }
      const parent = stack[stack.length - 1]
      if (parent) {
        parent.children.push(node)
      } else if (!rootRaw) {
        rootRaw = node
      }
      if (!selfClosing) {
        stack.push(node)
      }
      continue
    }

    if (textChunk !== undefined) {
      const top = stack[stack.length - 1]
      if (top) {
        const decoded = decodeHtmlEntities(textChunk).replace(/\s+/g, ' ').trim()
        if (decoded) top.textParts.push(decoded)
      }
      continue
    }

    // Comments, PI, DOCTYPE are intentionally ignored in the tree view
    void full
  }

  if (stack.length > 0 && !parseError) {
    parseError = `Unclosed XML tag <${stack[stack.length - 1]!.tag}>`
  }

  if (!rootRaw) {
    return { root: null, error: parseError ?? 'No root XML element found' }
  }

  const assignPaths = (
    raw: RawXmlNode,
    path: string,
    depth: number,
    parentPath: string | null,
  ): XmlTreeNode => {
    // Count sibling tag frequencies so repeated siblings get 1-based XPath indices
    const tagTotals = new Map<string, number>()
    for (const c of raw.children) {
      tagTotals.set(c.tag, (tagTotals.get(c.tag) ?? 0) + 1)
    }
    const tagSeen = new Map<string, number>()
    const children = raw.children.map((c) => {
      const seen = (tagSeen.get(c.tag) ?? 0) + 1
      tagSeen.set(c.tag, seen)
      const total = tagTotals.get(c.tag) ?? 1
      const segment = total > 1 ? `${c.tag}[${seen}]` : c.tag
      return assignPaths(c, `${path}/${segment}`, depth + 1, path)
    })
    return {
      path,
      tag: raw.tag,
      attributes: raw.attributes,
      text: raw.textParts.join(' ').trim(),
      children,
      depth,
      parentPath,
    }
  }

  const root = assignPaths(rootRaw, `/${rootRaw.tag}`, 0, null)
  return { root, ...(parseError ? { error: parseError } : {}) }
}

function collectXmlNodesByPath(node: XmlTreeNode, map: Map<string, XmlTreeNode>, containers: string[]): void {
  map.set(node.path, node)
  if (node.children.length > 0) {
    containers.push(node.path)
    for (const child of node.children) {
      collectXmlNodesByPath(child, map, containers)
    }
  }
}

function formatXmlOpenTag(node: XmlTreeNode): string {
  if (node.attributes.length === 0) return `<${node.tag}>`
  const attrsStr = node.attributes
    .slice(0, 4)
    .map((a) => `${a.name}="${truncateText(a.value, 36)}"`)
    .join(' ')
  const more = node.attributes.length > 4 ? ' ...' : ''
  return `<${node.tag} ${attrsStr}${more}>`
}

function buildXmlBreadcrumbs(byPath: Map<string, XmlTreeNode>, activeNode: XmlTreeNode): Array<{ label: string; path: string }> {
  const chain: Array<{ label: string; path: string }> = []
  let cur: XmlTreeNode | undefined = activeNode
  while (cur) {
    const seg = cur.path.split('/').filter(Boolean).pop() ?? cur.tag
    chain.push({ label: seg, path: cur.path })
    cur = cur.parentPath ? byPath.get(cur.parentPath) : undefined
  }
  chain.reverse()
  return chain
}

/**
 * Parse and format an XML response into a navigable, collapsible Lite document.
 */
export function parseXmlDocument(
  rawBody: string,
  baseUrl: string,
  options?: StructuredViewOptions,
): StructuredDocumentResult {
  const title = makeTitleFromUrl('XML', baseUrl)
  const blocks: Array<ContentBlock & { selector?: string }> = []
  const elements: ElementDescriptor[] = []
  const textLines: string[] = []

  const { root, error: parseError } = parseXmlTree(rawBody)
  if (!root) {
    const heading = `${title} (Invalid XML)`
    blocks.push({ kind: 'heading', level: 1, text: heading, tag: 'h1' })
    blocks.push({ kind: 'paragraph', text: `XML parse error: ${parseError ?? 'invalid XML'}`, tag: 'p' })
    blocks.push({ kind: 'code', text: rawBody.slice(0, 16000), tag: 'pre' })
    return {
      kind: 'xml',
      title: heading,
      blocks,
      elements,
      text: `${heading}\nXML parse error: ${parseError ?? 'invalid XML'}\n${rawBody.slice(0, 4000)}`,
      containerPaths: [],
      activePath: '/',
      rootPath: '/',
      parseError: parseError ?? 'invalid XML',
    }
  }

  const byPath = new Map<string, XmlTreeNode>()
  const containerPaths: string[] = []
  collectXmlNodesByPath(root, byPath, containerPaths)

  const requestedFocus = options?.focusPath?.trim()
  const activeRoot = (requestedFocus && byPath.get(requestedFocus)) || root
  const defaultExpandDepth = options?.defaultExpandDepth ?? 2
  const maxNodes = options?.maxNodes ?? 400
  const collapsedPaths = options?.collapsedPaths

  const headingText = `${title} (<${root.tag}>, ${root.children.length} ${root.children.length === 1 ? 'child' : 'children'})`
  blocks.push({ kind: 'heading', level: 1, text: headingText, tag: 'h1' })
  textLines.push(headingText)

  if (parseError) {
    const warn = `XML warning: ${parseError}`
    blocks.push({ kind: 'paragraph', text: warn, tag: 'p' })
    textLines.push(warn)
  }

  // Toolbar
  if (containerPaths.length > 0 || activeRoot.path !== root.path) {
    const toolbarParts: string[] = []
    const toolbarLinks: InlineLink[] = []
    let cursor = 0

    const pushToolbarButton = (selector: string, label: string, ariaLabel: string) => {
      if (toolbarParts.length > 0) {
        toolbarParts.push('  ')
        cursor += 2
      }
      const start = cursor
      toolbarParts.push(label)
      cursor += label.length
      toolbarLinks.push({ text: label, selector, start, end: cursor })
      elements.push({
        selector,
        tag: 'button',
        type: 'button',
        role: 'button',
        text: label,
        ariaLabel,
      })
    }

    if (containerPaths.length > 0) {
      pushToolbarButton('xml-action:expand-all', 'Expand All', 'Expand all XML elements')
      pushToolbarButton('xml-action:collapse-all', 'Collapse All', 'Collapse all XML elements')
    }
    if (activeRoot.path !== root.path) {
      pushToolbarButton(`xml-focus:${root.path}`, `Reset to ${root.path}`, `Reset XML focus to ${root.path}`)
    }

    const toolbarText = toolbarParts.join('')
    blocks.push({ kind: 'paragraph', text: toolbarText, tag: 'div', links: toolbarLinks })
    textLines.push(toolbarText)
  }

  // Breadcrumbs
  const crumbs = buildXmlBreadcrumbs(byPath, activeRoot)
  if (crumbs.length === 1) {
    const pathLine = `Path: ${activeRoot.path}`
    blocks.push({ kind: 'paragraph', text: pathLine, tag: 'nav' })
    textLines.push(pathLine)
  } else {
    const parts: string[] = ['Path: ']
    const crumbLinks: InlineLink[] = []
    let cursor = parts[0]!.length
    for (let i = 0; i < crumbs.length; i++) {
      const crumb = crumbs[i]!
      if (i > 0) {
        parts.push(' / ')
        cursor += 3
      }
      const isCurrent = i === crumbs.length - 1
      if (isCurrent) {
        parts.push(crumb.label)
        cursor += crumb.label.length
      } else {
        const sel = `xml-focus:${crumb.path}`
        const start = cursor
        parts.push(crumb.label)
        cursor += crumb.label.length
        crumbLinks.push({ text: crumb.label, selector: sel, start, end: cursor })
        elements.push({
          selector: sel,
          tag: 'button',
          type: 'button',
          role: 'button',
          text: crumb.label,
          ariaLabel: `Focus XML path ${crumb.path}`,
        })
      }
    }
    const line = parts.join('')
    blocks.push({ kind: 'paragraph', text: line, tag: 'nav', links: crumbLinks })
    textLines.push(line)
  }

  let renderedCount = 0
  let truncated = false

  const isCollapsed = (node: XmlTreeNode, relDepth: number): boolean => {
    if (collapsedPaths && collapsedPaths.has(node.path)) {
      return Boolean(collapsedPaths.get(node.path))
    }
    return relDepth >= defaultExpandDepth
  }

  const renderNode = (node: XmlTreeNode, relDepth: number, ancestorHasNext: boolean[], isLast: boolean) => {
    if (renderedCount >= maxNodes) {
      truncated = true
      return
    }
    renderedCount += 1

    const prefix = buildTreePrefix(ancestorHasNext, isLast)
    const openTag = formatXmlOpenTag(node)
    const isContainer = node.children.length > 0

    if (!isContainer) {
      // Check for navigable URL in leaf text or href/url attribute
      const urlAttr = node.attributes.find((a) => /^(href|url|src|link)$/i.test(a.name))
      const textUrl = node.text ? resolveMaybeUrl(node.text, baseUrl) : null
      const attrUrl = !textUrl && urlAttr ? resolveMaybeUrl(urlAttr.value, baseUrl) : null
      const resolvedUrl = textUrl || attrUrl

      if (resolvedUrl) {
        const displayUrl = truncateText(textUrl ? node.text : urlAttr!.value, 120)
        const sel = `xml-link:${node.path}`
        const lead = `${prefix}${openTag} `
        const tail = ` </${node.tag}>`
        const line = `${lead}${displayUrl}${tail}`
        elements.push({
          selector: sel,
          tag: 'a',
          type: 'link',
          role: 'link',
          text: displayUrl,
          href: resolvedUrl,
          ariaLabel: `Open URL at ${node.path}`,
        })
        blocks.push({
          kind: 'paragraph',
          text: line,
          tag: 'div',
          links: [{ text: displayUrl, href: resolvedUrl, selector: sel, start: lead.length, end: lead.length + displayUrl.length }],
        })
        textLines.push(line)
        return
      }

      const line = node.text
        ? `${prefix}${openTag}${truncateText(node.text, 160)}</${node.tag}>`
        : `${prefix}${openTag.slice(0, -1)} />`
      blocks.push({ kind: 'paragraph', text: line, tag: 'div' })
      textLines.push(line)
      return
    }

    const collapsed = isCollapsed(node, relDepth)
    const marker = collapsed ? '>' : 'v'
    const childCountLabel = `${node.children.length} ${node.children.length === 1 ? 'child' : 'children'}`
    const toggleLabel = `${marker} ${openTag} (${childCountLabel})`
    const toggleSel = `xml-toggle:${node.path}`

    elements.push({
      selector: toggleSel,
      tag: 'button',
      type: 'button',
      role: 'button',
      text: toggleLabel,
      ariaLabel: `${collapsed ? 'Expand' : 'Collapse'} ${node.path}`,
      checked: !collapsed,
    })

    const inlineLinks: InlineLink[] = [
      {
        text: toggleLabel,
        selector: toggleSel,
        start: prefix.length,
        end: prefix.length + toggleLabel.length,
      },
    ]

    let line = `${prefix}${toggleLabel}`

    if (node.path !== activeRoot.path) {
      const focusLabel = `focus ${node.path}`
      const focusSel = `xml-focus:${node.path}`
      const start = line.length + 1
      line = `${line} ${focusLabel}`
      elements.push({
        selector: focusSel,
        tag: 'button',
        type: 'button',
        role: 'button',
        text: focusLabel,
        ariaLabel: `Focus XML path ${node.path}`,
      })
      inlineLinks.push({
        text: focusLabel,
        selector: focusSel,
        start,
        end: line.length,
      })
    }

    blocks.push({ kind: 'paragraph', text: line, tag: 'div', links: inlineLinks })
    textLines.push(line)

    if (!collapsed) {
      if (node.text) {
        const textPrefix = buildTreePrefix([...ancestorHasNext, true], false)
        const textLine = `${textPrefix}#text: ${truncateText(node.text, 160)}`
        blocks.push({ kind: 'paragraph', text: textLine, tag: 'div' })
        textLines.push(textLine)
      }
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!
        const childIsLast = i === node.children.length - 1
        renderNode(child, relDepth + 1, [...ancestorHasNext, !childIsLast], childIsLast)
        if (truncated) break
      }
    }
  }

  renderNode(activeRoot, 0, [], true)

  if (truncated) {
    const note = `... truncated after ${maxNodes} nodes; use focus or collapse controls to inspect deeper paths`
    blocks.push({ kind: 'paragraph', text: note, tag: 'p' })
    textLines.push(note)
  }

  return {
    kind: 'xml',
    title: headingText,
    blocks,
    elements,
    text: textLines.join('\n'),
    containerPaths,
    activePath: activeRoot.path,
    rootPath: root.path,
    ...(parseError ? { parseError } : {}),
  }
}

/**
 * Unified entry point to parse a JSON or XML payload into a navigable Lite document.
 */
export function parseStructuredDocument(
  kind: StructuredKind,
  rawBody: string,
  baseUrl: string,
  options?: StructuredViewOptions,
): StructuredDocumentResult {
  return kind === 'json'
    ? parseJsonDocument(rawBody, baseUrl, options)
    : parseXmlDocument(rawBody, baseUrl, options)
}
