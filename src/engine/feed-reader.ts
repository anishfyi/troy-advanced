// RSS / Atom feed auto-detection and structured ASCII feed reader rendering for Lite engine (M38).
// Supports RSS 2.0, RSS 1.0 (RDF), Atom 1.0, and HTML `<link rel="alternate">` feed autodiscovery.
// Produces strict-ASCII-friendly ContentBlock[] + ElementDescriptor[] trees that integrate seamlessly
// with BrowserManager eN refs, --since delta reads, Agent Socket, MCP, Pipe REPL, and TUI.

import type { ContentBlock, ElementDescriptor, InlineLink, PageSnapshot } from '../types.js'
import { renderPageAscii } from '../ascii/layout.js'
import { decodeHtmlEntities } from './html-entities.js'

export type FeedKind = 'rss' | 'atom'

export interface DiscoveredFeed {
  url: string
  kind: FeedKind
  title?: string
  mimeType: string
}

export interface FeedEnclosure {
  url: string
  type?: string
  length?: number
}

export interface FeedItem {
  id: string
  index: number
  title: string
  link?: string
  published?: string
  updated?: string
  dateDisplay?: string
  author?: string
  categories: string[]
  summary: string
  content?: string
  enclosures: FeedEnclosure[]
  commentsUrl?: string
}

export interface ParsedFeed {
  kind: FeedKind
  version?: string
  title: string
  subtitle?: string
  siteUrl?: string
  feedUrl: string
  updated?: string
  dateDisplay?: string
  author?: string
  language?: string
  generator?: string
  items: FeedItem[]
  parseError?: string
}

export interface FeedViewOptions {
  /** Set of 0-based item indices currently expanded to show full content. */
  expandedItems?: ReadonlySet<number>
  /** Active category filter (case-insensitive), or null/undefined for all items. */
  categoryFilter?: string | null
  /** 0-based page index for pagination (default: 0). */
  page?: number
  /** Items per page (default: 25). */
  pageSize?: number
  /** Include a "View Raw XML" button to switch to M37 XML view (default: true). */
  includeRawXmlAction?: boolean
}

export interface FeedDocumentResult {
  kind: FeedKind
  feed: ParsedFeed
  title: string
  blocks: Array<ContentBlock & { selector?: string }>
  elements: ElementDescriptor[]
  text: string
  totalItems: number
  filteredItems: number
  page: number
  totalPages: number
  categories: Array<{ name: string; count: number }>
}

interface FeedXmlNode {
  tag: string
  localName: string
  attrs: Record<string, string>
  children: FeedXmlNode[]
  /** Raw concatenated text & CDATA children (entities decoded for text nodes, verbatim for CDATA). */
  text: string
  /** Raw inner XML slice (useful for Atom type="xhtml" content). */
  innerRaw: string
}

const ALLOWED_FEED_LINK_PROTOCOLS = new Set(['http:', 'https:'])
const RSS_MIME_TYPES = new Set(['application/rss+xml', 'text/rss+xml'])
const ATOM_MIME_TYPES = new Set(['application/atom+xml'])
const GENERIC_XML_MIMES = new Set(['application/xml', 'text/xml', 'application/rdf+xml', 'application/octet-stream', ''])

function stripLeadingXmlProlog(raw: string): string {
  let s = raw.replace(/^\uFEFF/, '').trimStart()
  let changed = true
  while (changed) {
    changed = false
    if (s.startsWith('<?')) {
      const end = s.indexOf('?>')
      if (end >= 0) {
        s = s.slice(end + 2).trimStart()
        changed = true
      }
    } else if (s.startsWith('<!--')) {
      const end = s.indexOf('-->')
      if (end >= 0) {
        s = s.slice(end + 3).trimStart()
        changed = true
      }
    } else if (/^<!DOCTYPE\b/i.test(s)) {
      const end = s.indexOf('>')
      if (end >= 0) {
        s = s.slice(end + 1).trimStart()
        changed = true
      }
    }
  }
  return s
}

/**
 * Detect whether an HTTP response is an RSS (2.0 / 1.0 RDF) or Atom (1.0) feed.
 * Explicitly returns null for HTML and JSON responses so HTML pages are parsed normally
 * (with `<link rel="alternate">` feed autodiscovery) and JSON goes to M37 JSON view.
 */
export function detectFeedKind(contentType: string, body: string, url?: string): FeedKind | null {
  const mime = (contentType || '').split(';')[0]?.trim().toLowerCase() ?? ''

  if (
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/json' ||
    mime === 'text/json' ||
    (mime.startsWith('application/') && mime.endsWith('+json'))
  ) {
    return null
  }

  if (RSS_MIME_TYPES.has(mime)) return 'rss'
  if (ATOM_MIME_TYPES.has(mime)) return 'atom'

  const trimmed = stripLeadingXmlProlog(body)
  const lowerMimeAllowed =
    GENERIC_XML_MIMES.has(mime) ||
    (mime === 'text/plain' &&
      Boolean(url && /\.(rss|atom|xml)(?:[?#]|$)/i.test(url)))

  if (!lowerMimeAllowed) {
    return null
  }

  // Sniff root XML element
  const rootMatch = /^<([A-Za-z_][\w:.-]*)\b([^>]*)>/.exec(trimmed)
  if (!rootMatch) return null

  const rootTag = rootMatch[1]!.toLowerCase()
  const rootAttrs = rootMatch[2] ?? ''

  if (rootTag === 'rss') {
    return 'rss'
  }
  if (rootTag === 'feed' || rootTag.endsWith(':feed')) {
    if (
      /http:\/\/www\.w3\.org\/2005\/atom/i.test(rootAttrs) ||
      /purl\.org\/atom/i.test(rootAttrs) ||
      /<(?:[a-z0-9_-]+:)?entry\b/i.test(trimmed) ||
      /<(?:[a-z0-9_-]+:)?title\b/i.test(trimmed)
    ) {
      return 'atom'
    }
  }
  if (rootTag === 'rdf:rdf' || rootTag === 'rdf') {
    if (
      /purl\.org\/rss/i.test(rootAttrs) ||
      /<(?:[a-z0-9_-]+:)?channel\b/i.test(trimmed) ||
      /<(?:[a-z0-9_-]+:)?item\b/i.test(trimmed)
    ) {
      return 'rss'
    }
  }

  return null
}

function parseXmlAttrs(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rawAttrs)) !== null) {
    const name = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[name] = decodeHtmlEntities(val)
  }
  return attrs
}

function resolveSafeUrl(rawHref: string | undefined, baseUrl: string): string | undefined {
  if (!rawHref) return undefined
  const trimmed = rawHref.trim()
  if (!trimmed) return undefined
  try {
    const resolved = new URL(trimmed, baseUrl)
    if (!ALLOWED_FEED_LINK_PROTOCOLS.has(resolved.protocol.toLowerCase())) {
      return undefined
    }
    return resolved.toString()
  } catch {
    return undefined
  }
}

/**
 * Discover RSS/Atom `<link rel="alternate" type="application/rss+xml|application/atom+xml">`
 * declarations inside an HTML document.
 */
export function discoverFeedsInHtml(html: string, baseUrl: string): DiscoveredFeed[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')

  const linkRe = /<link\b((?:"[^"]*"|'[^']*'|[^>])*)\/?>/gi
  const seen = new Set<string>()
  const feeds: DiscoveredFeed[] = []

  let m: RegExpExecArray | null
  while ((m = linkRe.exec(cleaned)) !== null) {
    const attrs = parseXmlAttrs(m[1] ?? '')
    const relTokens = (attrs.rel ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (!relTokens.includes('alternate')) continue

    const mime = (attrs.type ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    let kind: FeedKind | null = null
    if (RSS_MIME_TYPES.has(mime) || mime === 'application/rdf+xml') {
      kind = 'rss'
    } else if (ATOM_MIME_TYPES.has(mime)) {
      kind = 'atom'
    }
    if (!kind) continue

    const resolvedUrl = resolveSafeUrl(attrs.href, baseUrl)
    if (!resolvedUrl || seen.has(resolvedUrl)) continue
    seen.add(resolvedUrl)

    const title = attrs.title?.trim() || undefined
    feeds.push({
      url: resolvedUrl,
      kind,
      ...(title ? { title } : {}),
      mimeType: mime,
    })
  }

  return feeds
}

function localTagName(tag: string): string {
  const lower = tag.toLowerCase()
  const idx = lower.indexOf(':')
  return idx >= 0 ? lower.slice(idx + 1) : lower
}

/**
 * Lightweight, resilient XML tree parser for RSS/Atom documents.
 * Handles CDATA, comments, processing instructions, DOCTYPE, namespaces, and self-closing tags.
 */
function parseFeedXmlTree(raw: string): { root: FeedXmlNode | null; error?: string } {
  const src = raw.replace(/^\uFEFF/, '')
  const len = src.length
  let pos = 0

  interface StackFrame {
    node: FeedXmlNode
    contentStart: number
  }

  const stack: StackFrame[] = []
  let root: FeedXmlNode | null = null

  while (pos < len) {
    const lt = src.indexOf('<', pos)
    if (lt < 0) {
      if (stack.length > 0) {
        stack[stack.length - 1]!.node.text += decodeHtmlEntities(src.slice(pos))
      }
      break
    }

    if (lt > pos && stack.length > 0) {
      stack[stack.length - 1]!.node.text += decodeHtmlEntities(src.slice(pos, lt))
    }

    // Comment
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      pos = end >= 0 ? end + 3 : len
      continue
    }

    // CDATA
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      const cdata = end >= 0 ? src.slice(lt + 9, end) : src.slice(lt + 9)
      if (stack.length > 0) {
        stack[stack.length - 1]!.node.text += cdata
      }
      pos = end >= 0 ? end + 3 : len
      continue
    }

    // Processing instruction <?...?>
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      pos = end >= 0 ? end + 2 : len
      continue
    }

    // DOCTYPE / other declaration <!...>
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2)
      pos = end >= 0 ? end + 1 : len
      continue
    }

    // Closing tag </...>
    if (src.startsWith('</', lt)) {
      const gt = src.indexOf('>', lt + 2)
      if (gt < 0) {
        pos = len
        break
      }
      const closeTag = src.slice(lt + 2, gt).trim().toLowerCase()
      // Find matching open tag on stack (tolerates unclosed inner tags)
      let matchIdx = -1
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.node.tag === closeTag) {
          matchIdx = i
          break
        }
      }
      if (matchIdx >= 0) {
        while (stack.length - 1 > matchIdx) {
          const popped = stack.pop()!
          popped.node.innerRaw = src.slice(popped.contentStart, lt)
        }
        const matched = stack.pop()!
        matched.node.innerRaw = src.slice(matched.contentStart, lt)
      }
      pos = gt + 1
      continue
    }

    // Opening tag <tag ...> or <tag .../>
    // Scan past quoted attribute values to find closing '>'
    let cursor = lt + 1
    let inQuote: string | null = null
    while (cursor < len) {
      const ch = src[cursor]!
      if (inQuote) {
        if (ch === inQuote) inQuote = null
      } else if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === '>') {
        break
      }
      cursor++
    }
    if (cursor >= len) {
      pos = len
      break
    }

    const inside = src.slice(lt + 1, cursor)
    const selfClosing = inside.trimEnd().endsWith('/')
    const cleanInside = selfClosing ? inside.trimEnd().slice(0, -1) : inside
    const nameMatch = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(cleanInside.trimStart())
    if (!nameMatch) {
      pos = cursor + 1
      continue
    }

    const rawTag = nameMatch[1]!.toLowerCase()
    const rawAttrStr = nameMatch[2] ?? ''
    const node: FeedXmlNode = {
      tag: rawTag,
      localName: localTagName(rawTag),
      attrs: parseXmlAttrs(rawAttrStr),
      children: [],
      text: '',
      innerRaw: '',
    }

    if (stack.length > 0) {
      stack[stack.length - 1]!.node.children.push(node)
    } else if (!root) {
      root = node
    }

    if (!selfClosing) {
      stack.push({ node, contentStart: cursor + 1 })
    }

    pos = cursor + 1
  }

  // Close any unclosed tags gracefully
  while (stack.length > 0) {
    const popped = stack.pop()!
    popped.node.innerRaw = src.slice(popped.contentStart)
  }

  if (!root) {
    return { root: null, error: 'Empty or malformed XML feed document' }
  }
  return { root }
}

/**
 * Convert HTML markup embedded inside RSS/Atom `<description>`, `<summary>`, or `<content>`
 * into clean, readable plain text preserving paragraph breaks and list structure.
 */
export function htmlFragmentToPlainText(raw: string): string {
  if (!raw) return ''
  let text = raw
  // Strip script/style blocks if any HTML was embedded
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // Convert block/break tags to newlines
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|blockquote|pre|tr|section|article)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode HTML entities (handles double-encoded entities inside CDATA or XML text)
  text = decodeHtmlEntities(text)

  // Normalize line whitespace
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())

  const collapsed: string[] = []
  let prevBlank = true
  for (const line of lines) {
    if (!line) {
      if (!prevBlank) {
        collapsed.push('')
        prevBlank = true
      }
    } else {
      collapsed.push(line)
      prevBlank = false
    }
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') {
    collapsed.pop()
  }
  return collapsed.join('\n')
}

export function formatFeedDate(raw?: string): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const ms = Date.parse(trimmed)
  if (!Number.isFinite(ms)) return trimmed
  const d = new Date(ms)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  if (hh === '00' && min === '00' && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${yyyy}-${mm}-${dd}`
  }
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`
}

export function formatByteSize(bytes?: number): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function firstChild(node: FeedXmlNode, ...names: string[]): FeedXmlNode | undefined {
  const lowerNames = names.map((n) => n.toLowerCase())
  for (const child of node.children) {
    if (lowerNames.includes(child.tag) || lowerNames.includes(child.localName)) {
      return child
    }
  }
  return undefined
}

function allChildren(node: FeedXmlNode, ...names: string[]): FeedXmlNode[] {
  const lowerNames = names.map((n) => n.toLowerCase())
  return node.children.filter((c) => lowerNames.includes(c.tag) || lowerNames.includes(c.localName))
}

function childText(node: FeedXmlNode, ...names: string[]): string | undefined {
  const child = firstChild(node, ...names)
  if (!child) return undefined
  const t = child.text.trim()
  return t || undefined
}

function extractAtomTextNode(node: FeedXmlNode | undefined): string {
  if (!node) return ''
  const type = (node.attrs.type ?? 'text').toLowerCase()
  if (type === 'xhtml') {
    return htmlFragmentToPlainText(node.innerRaw || node.text)
  }
  if (type === 'html' || /<[a-z][\s\S]*>/i.test(node.text)) {
    return htmlFragmentToPlainText(node.text)
  }
  return decodeHtmlEntities(node.text).replace(/\r\n?/g, '\n').trim()
}

function truncateSummary(text: string, maxLen = 220): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLen) return singleLine
  return `${singleLine.slice(0, maxLen - 3).trimEnd()}...`
}

function parseRssFeed(root: FeedXmlNode, feedUrl: string): ParsedFeed {
  const isRdf = root.localName === 'rdf'
  const channel = firstChild(root, 'channel') ?? root
  const version = root.attrs.version || (isRdf ? '1.0' : '2.0')

  const title = htmlFragmentToPlainText(childText(channel, 'title') ?? '') || 'Untitled RSS Feed'
  const subtitle = htmlFragmentToPlainText(childText(channel, 'description', 'subtitle') ?? '') || undefined
  const siteUrl = resolveSafeUrl(childText(channel, 'link'), feedUrl)
  const effectiveBase = siteUrl ?? feedUrl
  const updated = childText(channel, 'lastbuilddate', 'pubdate', 'dc:date', 'updated')
  const language = childText(channel, 'language', 'dc:language')
  const generator = childText(channel, 'generator')
  const author = childText(channel, 'managingeditor', 'dc:creator', 'author')

  // RSS 2.0 puts <item> inside <channel>; RSS 1.0 (RDF) puts <item> as sibling of <channel> under <rdf:RDF>
  const itemNodes = isRdf
    ? [...allChildren(channel, 'item'), ...allChildren(root, 'item')]
    : allChildren(channel, 'item')

  const items: FeedItem[] = itemNodes.map((itemNode, index) => {
    const itemTitle = htmlFragmentToPlainText(childText(itemNode, 'title') ?? '') || `(Untitled item ${index + 1})`
    const rawLink = childText(itemNode, 'link')
    const guidNode = firstChild(itemNode, 'guid')
    const guidText = guidNode?.text.trim()
    const guidIsPermalink =
      guidNode &&
      guidText &&
      (guidNode.attrs.ispermalink ?? 'true').toLowerCase() !== 'false' &&
      /^https?:\/\//i.test(guidText)

    const link = resolveSafeUrl(rawLink ?? (guidIsPermalink ? guidText : undefined), effectiveBase)
    const published = childText(itemNode, 'pubdate', 'dc:date', 'published', 'updated')
    const itemAuthor = childText(itemNode, 'dc:creator', 'author', 'creator')
    const commentsUrl = resolveSafeUrl(childText(itemNode, 'comments'), effectiveBase)

    const categories: string[] = []
    const seenCats = new Set<string>()
    for (const catNode of allChildren(itemNode, 'category')) {
      const cat = decodeHtmlEntities(catNode.text || catNode.attrs.term || '').trim()
      if (cat && !seenCats.has(cat.toLowerCase())) {
        seenCats.add(cat.toLowerCase())
        categories.push(cat)
      }
    }

    const rawDesc = childText(itemNode, 'description') ?? ''
    const rawEncoded = childText(itemNode, 'content:encoded', 'encoded') ?? ''
    const descPlain = htmlFragmentToPlainText(rawDesc)
    const encodedPlain = htmlFragmentToPlainText(rawEncoded)

    const summary = descPlain || encodedPlain
    const content = encodedPlain && encodedPlain.length > descPlain.length ? encodedPlain : descPlain || undefined

    const enclosures: FeedEnclosure[] = []
    for (const encNode of allChildren(itemNode, 'enclosure', 'media:content')) {
      const encUrl = resolveSafeUrl(encNode.attrs.url, effectiveBase)
      if (!encUrl) continue
      const lengthNum = encNode.attrs.length ? Number.parseInt(encNode.attrs.length, 10) : undefined
      enclosures.push({
        url: encUrl,
        ...(encNode.attrs.type ? { type: encNode.attrs.type } : {}),
        ...(lengthNum !== undefined && Number.isFinite(lengthNum) && lengthNum >= 0 ? { length: lengthNum } : {}),
      })
    }

    return {
      id: guidText || link || `rss-item-${index + 1}`,
      index,
      title: itemTitle,
      ...(link ? { link } : {}),
      ...(published ? { published } : {}),
      ...(published ? { dateDisplay: formatFeedDate(published) } : {}),
      ...(itemAuthor ? { author: itemAuthor } : {}),
      categories,
      summary,
      ...(content ? { content } : {}),
      enclosures,
      ...(commentsUrl ? { commentsUrl } : {}),
    }
  })

  return {
    kind: 'rss',
    version,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(siteUrl ? { siteUrl } : {}),
    feedUrl,
    ...(updated ? { updated, dateDisplay: formatFeedDate(updated) } : {}),
    ...(author ? { author } : {}),
    ...(language ? { language } : {}),
    ...(generator ? { generator } : {}),
    items,
  }
}

function parseAtomFeed(root: FeedXmlNode, feedUrl: string): ParsedFeed {
  const xmlBase = root.attrs['xml:base'] ? resolveSafeUrl(root.attrs['xml:base'], feedUrl) ?? feedUrl : feedUrl
  const title = extractAtomTextNode(firstChild(root, 'title')) || 'Untitled Atom Feed'
  const subtitle = extractAtomTextNode(firstChild(root, 'subtitle', 'tagline')) || undefined
  const updated = childText(root, 'updated', 'modified')
  const generator = childText(root, 'generator')

  const authorNode = firstChild(root, 'author')
  const author = authorNode ? childText(authorNode, 'name', 'email') : undefined

  let siteUrl: string | undefined
  for (const linkNode of allChildren(root, 'link')) {
    const rel = (linkNode.attrs.rel ?? 'alternate').toLowerCase()
    if (rel === 'alternate') {
      siteUrl = resolveSafeUrl(linkNode.attrs.href, xmlBase)
      if (siteUrl) break
    }
  }
  const effectiveBase = siteUrl ?? xmlBase

  const entryNodes = allChildren(root, 'entry')
  const items: FeedItem[] = entryNodes.map((entryNode, index) => {
    const entryBase = entryNode.attrs['xml:base']
      ? resolveSafeUrl(entryNode.attrs['xml:base'], effectiveBase) ?? effectiveBase
      : effectiveBase

    const itemTitle = extractAtomTextNode(firstChild(entryNode, 'title')) || `(Untitled entry ${index + 1})`
    const id = childText(entryNode, 'id') || `atom-entry-${index + 1}`
    const published = childText(entryNode, 'published', 'issued')
    const itemUpdated = childText(entryNode, 'updated', 'modified')
    const dateRaw = published ?? itemUpdated

    const entryAuthorNode = firstChild(entryNode, 'author')
    const itemAuthor = entryAuthorNode ? childText(entryAuthorNode, 'name', 'email') : author

    let link: string | undefined
    let fallbackLink: string | undefined
    const enclosures: FeedEnclosure[] = []

    for (const linkNode of allChildren(entryNode, 'link')) {
      const rel = (linkNode.attrs.rel ?? 'alternate').toLowerCase()
      const href = resolveSafeUrl(linkNode.attrs.href, entryBase)
      if (!href) continue
      if (rel === 'enclosure') {
        const lengthNum = linkNode.attrs.length ? Number.parseInt(linkNode.attrs.length, 10) : undefined
        enclosures.push({
          url: href,
          ...(linkNode.attrs.type ? { type: linkNode.attrs.type } : {}),
          ...(lengthNum !== undefined && Number.isFinite(lengthNum) && lengthNum >= 0 ? { length: lengthNum } : {}),
        })
      } else if (rel === 'alternate' && !link) {
        link = href
      } else if (rel !== 'self' && !fallbackLink) {
        fallbackLink = href
      }
    }
    if (!link) link = fallbackLink

    const categories: string[] = []
    const seenCats = new Set<string>()
    for (const catNode of allChildren(entryNode, 'category')) {
      const cat = (catNode.attrs.label || catNode.attrs.term || catNode.text || '').trim()
      if (cat && !seenCats.has(cat.toLowerCase())) {
        seenCats.add(cat.toLowerCase())
        categories.push(cat)
      }
    }

    const summaryText = extractAtomTextNode(firstChild(entryNode, 'summary'))
    const contentText = extractAtomTextNode(firstChild(entryNode, 'content'))
    const summary = summaryText || contentText
    const content = contentText && contentText.length >= summaryText.length ? contentText : summaryText || undefined

    return {
      id,
      index,
      title: itemTitle,
      ...(link ? { link } : {}),
      ...(published ? { published } : {}),
      ...(itemUpdated ? { updated: itemUpdated } : {}),
      ...(dateRaw ? { dateDisplay: formatFeedDate(dateRaw) } : {}),
      ...(itemAuthor ? { author: itemAuthor } : {}),
      categories,
      summary,
      ...(content ? { content } : {}),
      enclosures,
    }
  })

  return {
    kind: 'atom',
    version: '1.0',
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(siteUrl ? { siteUrl } : {}),
    feedUrl,
    ...(updated ? { updated, dateDisplay: formatFeedDate(updated) } : {}),
    ...(author ? { author } : {}),
    ...(generator ? { generator } : {}),
    items,
  }
}

/**
 * Parse an RSS (2.0 / 1.0 RDF) or Atom (1.0) XML payload into a normalized `ParsedFeed`.
 */
export function parseFeedXml(rawXml: string, feedUrl: string, kindHint?: FeedKind): ParsedFeed {
  const { root, error } = parseFeedXmlTree(rawXml)
  if (!root) {
    const kind: FeedKind = kindHint ?? 'rss'
    return {
      kind,
      title: feedUrl,
      feedUrl,
      items: [],
      parseError: error ?? 'Failed to parse feed XML',
    }
  }

  const rootLocal = root.localName
  const effectiveKind: FeedKind =
    rootLocal === 'feed'
      ? 'atom'
      : rootLocal === 'rss' || rootLocal === 'rdf'
        ? 'rss'
        : kindHint ?? 'rss'

  if (effectiveKind === 'atom') {
    return parseAtomFeed(root, feedUrl)
  }
  return parseRssFeed(root, feedUrl)
}

/**
 * Build structured `ContentBlock[]`, interactive `ElementDescriptor[]`, and plain text
 * for rendering a parsed RSS/Atom feed inside LiteTab / `renderPageAscii`.
 */
export function buildFeedReaderDocument(feed: ParsedFeed, opts: FeedViewOptions = {}): FeedDocumentResult {
  const expandedItems = opts.expandedItems ?? new Set<number>()
  const categoryFilter = opts.categoryFilter?.trim() || null
  const pageSize = Math.max(1, opts.pageSize ?? 25)
  const includeRawXmlAction = opts.includeRawXmlAction !== false

  // Aggregate categories sorted by descending frequency
  const catCounts = new Map<string, { name: string; count: number }>()
  for (const item of feed.items) {
    for (const cat of item.categories) {
      const key = cat.toLowerCase()
      const existing = catCounts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        catCounts.set(key, { name: cat, count: 1 })
      }
    }
  }
  const categories = [...catCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const filtered = categoryFilter
    ? feed.items.filter((item) => item.categories.some((c) => c.toLowerCase() === categoryFilter.toLowerCase()))
    : feed.items

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(0, opts.page ?? 0), totalPages - 1)
  const startIdx = page * pageSize
  const pageItems = filtered.slice(startIdx, startIdx + pageSize)

  const blocks: Array<ContentBlock & { selector?: string }> = []
  const elements: ElementDescriptor[] = []
  const textParts: string[] = []

  const kindLabel =
    feed.kind === 'atom'
      ? 'Atom Feed'
      : feed.version
        ? `RSS ${feed.version} Feed`
        : 'RSS Feed'

  const headingText = `[${kindLabel}] ${feed.title}`
  blocks.push({ kind: 'heading', level: 1, text: headingText, tag: 'h1' })
  textParts.push(headingText)

  if (feed.subtitle) {
    blocks.push({ kind: 'paragraph', text: feed.subtitle, tag: 'p' })
    textParts.push(feed.subtitle)
  }

  // Metadata summary line (with clickable site link if present)
  const metaParts: string[] = [
    categoryFilter
      ? `Items: ${filtered.length} of ${feed.items.length} (filter: #${categoryFilter})`
      : `Items: ${feed.items.length}`,
  ]
  if (feed.dateDisplay) metaParts.push(`Updated: ${feed.dateDisplay}`)
  if (feed.author) metaParts.push(`Author: ${feed.author}`)
  if (feed.language) metaParts.push(`Lang: ${feed.language}`)

  const inlineLinks: InlineLink[] = []
  let metaLine = metaParts.join(' | ')
  if (feed.siteUrl) {
    const siteSelector = 'feed-site-link'
    const siteLabel = feed.siteUrl
    const prefix = `${metaLine} | Site: `
    const start = prefix.length
    metaLine = `${prefix}${siteLabel}`
    inlineLinks.push({
      text: siteLabel,
      href: feed.siteUrl,
      selector: siteSelector,
      start,
      end: start + siteLabel.length,
    })
    elements.push({
      selector: siteSelector,
      tag: 'a',
      type: 'link',
      role: 'link',
      text: siteLabel,
      ariaLabel: `Feed website: ${siteLabel}`,
      href: feed.siteUrl,
    })
  }
  blocks.push({
    kind: 'paragraph',
    text: metaLine,
    tag: 'p',
    ...(inlineLinks.length > 0 ? { links: inlineLinks } : {}),
  })
  textParts.push(metaLine)

  if (feed.parseError) {
    const errText = `Parse warning: ${feed.parseError}`
    blocks.push({ kind: 'paragraph', text: errText, tag: 'p' })
    textParts.push(errText)
  }

  // Toolbar controls
  const addActionButton = (selector: string, label: string, disabled = false) => {
    elements.push({
      selector,
      tag: 'button',
      type: 'button',
      role: 'button',
      text: label,
      ariaLabel: label,
      ...(disabled ? { disabled: true } : {}),
    })
    blocks.push({
      kind: 'button',
      text: label,
      tag: 'button',
      selector,
    })
  }

  if (filtered.length > 0) {
    addActionButton('feed-action:expand-all', 'Expand All')
    addActionButton('feed-action:collapse-all', 'Collapse All')
  }
  if (includeRawXmlAction) {
    addActionButton('feed-action:raw-xml', 'View Raw XML')
  }

  // Category filter buttons (top 6 categories)
  if (categories.length > 0) {
    addActionButton(
      'feed-filter:all',
      categoryFilter ? `Filter: All (${feed.items.length})` : `Filter: All (${feed.items.length}) *`,
    )
    for (const cat of categories.slice(0, 6)) {
      const isActive = categoryFilter?.toLowerCase() === cat.name.toLowerCase()
      addActionButton(
        `feed-filter:${cat.name}`,
        `#${cat.name} (${cat.count})${isActive ? ' *' : ''}`,
      )
    }
  }

  blocks.push({ kind: 'hr', text: '---', tag: 'hr' })

  if (pageItems.length === 0) {
    const emptyMsg = categoryFilter
      ? `No feed items match category "#${categoryFilter}".`
      : 'This feed currently has no items.'
    blocks.push({ kind: 'paragraph', text: emptyMsg, tag: 'p' })
    textParts.push(emptyMsg)
  } else {
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i]!
      const displayNum = startIdx + i + 1
      const isExpanded = expandedItems.has(item.index)
      const toggleSelector = `feed-toggle:${item.index}`
      const toggleMarker = isExpanded ? '[-]' : '[+]'
      const toggleLabel = `${toggleMarker} ${displayNum}. ${item.title}`

      elements.push({
        selector: toggleSelector,
        tag: 'button',
        type: 'button',
        role: 'button',
        text: toggleLabel,
        ariaLabel: `${isExpanded ? 'Collapse' : 'Expand'} feed item ${displayNum}: ${item.title}`,
        checked: isExpanded,
      })
      blocks.push({
        kind: 'button',
        text: toggleLabel,
        tag: 'button',
        checked: isExpanded,
        selector: toggleSelector,
      })
      textParts.push(toggleLabel)

      // Metadata line for item
      const itemMeta: string[] = []
      if (item.dateDisplay) itemMeta.push(item.dateDisplay)
      if (item.author) itemMeta.push(`by ${item.author}`)
      if (item.categories.length > 0) itemMeta.push(`[${item.categories.join(', ')}]`)
      if (itemMeta.length > 0) {
        const metaStr = `  ${itemMeta.join(' | ')}`
        blocks.push({ kind: 'paragraph', text: metaStr, tag: 'p' })
        textParts.push(metaStr)
      }

      // Direct article link
      if (item.link) {
        const linkSelector = `feed-link:${item.index}`
        const linkLabel = `Open: ${item.title}`
        elements.push({
          selector: linkSelector,
          tag: 'a',
          type: 'link',
          role: 'link',
          text: linkLabel,
          ariaLabel: `Open article: ${item.title}`,
          href: item.link,
        })
        blocks.push({
          kind: 'link',
          text: linkLabel,
          href: item.link,
          tag: 'a',
          selector: linkSelector,
        })
      }

      if (isExpanded) {
        const fullText = (item.content || item.summary || '(No content)').slice(0, 4000)
        const paragraphs = fullText.split(/\n{2,}/).filter((p) => p.trim().length > 0)
        for (const para of paragraphs) {
          const cleanPara = para.replace(/\n/g, ' ').trim()
          blocks.push({ kind: 'paragraph', text: `  ${cleanPara}`, tag: 'p' })
          textParts.push(cleanPara)
        }

        // Enclosures (podcasts, videos, images)
        for (let encIdx = 0; encIdx < item.enclosures.length; encIdx++) {
          const enc = item.enclosures[encIdx]!
          const encSelector = `feed-enclosure:${item.index}:${encIdx}`
          const sizeStr = formatByteSize(enc.length)
          const encMeta = [enc.type, sizeStr].filter(Boolean).join(', ')
          const encLabel = encMeta ? `Enclosure (${encMeta}): ${enc.url}` : `Enclosure: ${enc.url}`
          elements.push({
            selector: encSelector,
            tag: 'a',
            type: 'link',
            role: 'link',
            text: encLabel,
            ariaLabel: encLabel,
            href: enc.url,
          })
          blocks.push({
            kind: 'link',
            text: encLabel,
            href: enc.url,
            tag: 'a',
            selector: encSelector,
          })
          textParts.push(encLabel)
        }

        if (item.commentsUrl) {
          const commentsSelector = `feed-comments:${item.index}`
          const commentsLabel = `Comments: ${item.commentsUrl}`
          elements.push({
            selector: commentsSelector,
            tag: 'a',
            type: 'link',
            role: 'link',
            text: commentsLabel,
            ariaLabel: `Comments for ${item.title}`,
            href: item.commentsUrl,
          })
          blocks.push({
            kind: 'link',
            text: commentsLabel,
            href: item.commentsUrl,
            tag: 'a',
            selector: commentsSelector,
          })
        }
      } else if (item.summary) {
        const preview = truncateSummary(item.summary, 220)
        blocks.push({ kind: 'paragraph', text: `  ${preview}`, tag: 'p' })
        textParts.push(preview)
      }
    }
  }

  // Pagination footer
  if (totalPages > 1) {
    blocks.push({ kind: 'hr', text: '---', tag: 'hr' })
    const rangeStart = startIdx + 1
    const rangeEnd = startIdx + pageItems.length
    const pageInfo = `Page ${page + 1} of ${totalPages} (showing ${rangeStart}-${rangeEnd} of ${filtered.length} items)`
    blocks.push({ kind: 'paragraph', text: pageInfo, tag: 'p' })
    textParts.push(pageInfo)
    addActionButton('feed-page:prev', 'Prev Page', page <= 0)
    addActionButton('feed-page:next', 'Next Page', page >= totalPages - 1)
  }

  return {
    kind: feed.kind,
    feed,
    title: feed.title,
    blocks,
    elements,
    text: textParts.join('\n'),
    totalItems: feed.items.length,
    filteredItems: filtered.length,
    page,
    totalPages,
    categories,
  }
}

/**
 * Render a parsed RSS/Atom feed directly to a strict 7-bit ASCII feed reader string.
 */
export function renderFeedAscii(
  feed: ParsedFeed,
  opts: FeedViewOptions & { width?: number; height?: number } = {},
): string {
  const doc = buildFeedReaderDocument(feed, opts)
  const refBySelector = new Map<string, string>()
  const elements = doc.elements.map((el, i) => {
    const ref = `e${i + 1}`
    refBySelector.set(el.selector, ref)
    return { ...el, ref }
  })
  const blocks: ContentBlock[] = doc.blocks.map((b) => {
    const ref = b.selector ? refBySelector.get(b.selector) : undefined
    const links = b.links?.map((link) => ({
      ...link,
      ref: link.selector ? refBySelector.get(link.selector) : link.ref,
    }))
    return {
      ...b,
      ...(ref ? { ref } : {}),
      ...(links ? { links } : {}),
    }
  })

  const snapshot: PageSnapshot = {
    tabId: 1,
    url: feed.feedUrl,
    title: doc.title,
    epoch: 1,
    capturedAt: Date.now(),
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
    blocks,
    elements,
    text: doc.text,
  }

  return renderPageAscii(snapshot, {
    width: opts.width ?? 100,
    ...(opts.height !== undefined ? { height: opts.height } : {}),
    color: false,
  })
}
