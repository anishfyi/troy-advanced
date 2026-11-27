// Structured data extractor (`page_extract`) for Troy Advanced.
// Extracts tables, forms, links, headings, and JSON-LD / OpenGraph / Twitter / meta metadata
// from live HTML and enriches interactive controls & links with active [eN] snapshot refs.

import { decodeHtmlEntities } from '../engine/html-entities.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { sensitiveElementReason } from './policy.js'
import type { ElementDescriptor, PageSnapshot } from '../types.js'

export type ExtractSection = 'tables' | 'forms' | 'links' | 'headings' | 'metadata'

export const ALL_EXTRACT_SECTIONS: readonly ExtractSection[] = [
  'tables',
  'forms',
  'links',
  'headings',
  'metadata',
] as const

export interface ExtractedTable {
  index: number
  caption?: string
  headers: string[]
  rows: string[][]
  objects?: Array<Record<string, string>>
  rowCount: number
  columnCount: number
}

export interface ExtractedFormField {
  ref?: string
  tag: string
  type: string
  name?: string
  id?: string
  label?: string
  ariaLabel?: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
  readOnly?: boolean
  value?: string
  valueRedacted?: boolean
  checked?: boolean
  options?: Array<{ value: string; label: string; selected?: boolean }>
}

export interface ExtractedFormSubmit {
  ref?: string
  text: string
  name?: string
  value?: string
  disabled?: boolean
}

export interface ExtractedForm {
  index: number
  id?: string
  name?: string
  title?: string
  action?: string
  method: string
  enctype?: string
  fields: ExtractedFormField[]
  submitButtons: ExtractedFormSubmit[]
}

export interface ExtractedLink {
  ref?: string
  text: string
  href: string
  rel?: string
  target?: string
  title?: string
  external: boolean
}

export interface ExtractedHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
  id?: string
}

export interface ExtractedMetadata {
  title: string
  description?: string
  canonical?: string
  lang?: string
  author?: string
  keywords?: string[]
  robots?: string
  openGraph: Record<string, string>
  twitter: Record<string, string>
  jsonLd: unknown[]
  jsonLdErrors?: number
  meta: Record<string, string>
}

export interface PageExtractOptions {
  sections?: ExtractSection[]
  maxItems?: number
  includeObjects?: boolean
  asciiOnly?: boolean
  externalLinksOnly?: boolean
  internalLinksOnly?: boolean
}

export interface PageExtractResult {
  ok: true
  url: string
  title: string
  sections: ExtractSection[]
  counts: {
    tables?: number
    forms?: number
    links?: number
    headings?: number
    jsonLd?: number
    openGraph?: number
  }
  tables?: ExtractedTable[]
  forms?: ExtractedForm[]
  links?: ExtractedLink[]
  headings?: ExtractedHeading[]
  metadata?: ExtractedMetadata
}

export function parseExtractSections(raw: unknown): ExtractSection[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const items: string[] = []
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string') {
        for (const part of v.split(',')) {
          const trimmed = part.trim().toLowerCase()
          if (trimmed) items.push(trimmed)
        }
      }
    }
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed || trimmed === 'all') return [...ALL_EXTRACT_SECTIONS]
    for (const part of trimmed.split(',')) {
      const s = part.trim()
      if (s) items.push(s)
    }
  } else {
    return undefined
  }
  if (items.length === 0) return undefined
  if (items.includes('all')) return [...ALL_EXTRACT_SECTIONS]
  const valid = new Set<ExtractSection>()
  for (const item of items) {
    if (
      item === 'tables' ||
      item === 'forms' ||
      item === 'links' ||
      item === 'headings' ||
      item === 'metadata'
    ) {
      valid.add(item)
    }
  }
  return valid.size > 0 ? Array.from(valid) : undefined
}

function cleanText(raw: string, asciiOnly: boolean): string {
  const decoded = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim()
  return asciiOnly ? sanitizeAscii(decoded) : decoded
}

function stripTagsToText(html: string, asciiOnly: boolean): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const stripped = withoutScripts.replace(/<[^>]+>/g, ' ')
  return cleanText(stripped, asciiOnly)
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrString)) !== null) {
    const key = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[key] = decodeHtmlEntities(val)
  }
  return attrs
}

function resolveUrl(href: string, baseUrl: string): string {
  const trimmed = href.trim()
  if (!trimmed) return ''
  if (/^(mailto:|tel:|data:|blob:)/i.test(trimmed)) return trimmed
  try {
    return new URL(trimmed, baseUrl).href
  } catch {
    return trimmed
  }
}

function getOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin
    }
    return null
  } catch {
    return null
  }
}

function extractBaseHref(html: string, pageUrl: string): string {
  const m = /<base\b([^>]*)>/i.exec(html)
  if (!m) return pageUrl
  const attrs = parseAttrs(m[1] ?? '')
  if (!attrs.href) return pageUrl
  return resolveUrl(attrs.href, pageUrl) || pageUrl
}

function findBalancedBlocks(html: string, tagName: string): Array<{ attrs: Record<string, string>; innerHtml: string }> {
  const results: Array<{ attrs: Record<string, string>; innerHtml: string }> = []
  const re = new RegExp(`<(\\/?)${tagName}\\b([^>]*)>`, 'gi')
  let depth = 0
  let openStart = -1
  let openAttrs: Record<string, string> = {}
  let m: RegExpExecArray | null

  while ((m = re.exec(html)) !== null) {
    const isClose = m[1] === '/'
    const isSelfClose = !isClose && /\/\s*$/.test(m[2] ?? '')
    if (!isClose) {
      if (isSelfClose) continue
      if (depth === 0) {
        openStart = re.lastIndex
        openAttrs = parseAttrs(m[2] ?? '')
      }
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0 && openStart >= 0) {
        results.push({
          attrs: openAttrs,
          innerHtml: html.slice(openStart, m.index),
        })
        openStart = -1
      }
    }
  }
  return results
}

function extractMetadata(
  html: string,
  pageUrl: string,
  baseUrl: string,
  fallbackTitle: string,
  asciiOnly: boolean,
): ExtractedMetadata {
  const openGraph: Record<string, string> = {}
  const twitter: Record<string, string> = {}
  const meta: Record<string, string> = {}
  const jsonLd: unknown[] = []
  let jsonLdErrors = 0

  // 1. Extract JSON-LD before stripping scripts
  const jsonLdRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let scriptMatch: RegExpExecArray | null
  while ((scriptMatch = jsonLdRe.exec(html)) !== null) {
    const attrs = parseAttrs(scriptMatch[1] ?? '')
    const type = (attrs.type ?? '').toLowerCase().split(';')[0]!.trim()
    if (type !== 'application/ld+json') continue
    let rawJson = (scriptMatch[2] ?? '').trim()
    if (!rawJson) continue
    // Strip optional CDATA or HTML comment wrappers
    rawJson = rawJson
      .replace(/^\/\*\s*<!\[CDATA\[\s*\*\/\s*/i, '')
      .replace(/\s*\/\*\s*\]\]>\s*\*\/$/i, '')
      .replace(/^<!--\s*/, '')
      .replace(/\s*-->$/, '')
      .trim()
    try {
      const parsed = JSON.parse(rawJson)
      if (Array.isArray(parsed)) {
        for (const item of parsed) jsonLd.push(item)
      } else {
        jsonLd.push(parsed)
      }
    } catch {
      jsonLdErrors++
    }
  }

  // Strip comments and scripts for metadata tag scanning
  const cleanHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  // <html lang="...">
  let lang: string | undefined
  const htmlTagMatch = /<html\b([^>]*)>/i.exec(cleanHtml)
  if (htmlTagMatch) {
    const attrs = parseAttrs(htmlTagMatch[1] ?? '')
    if (attrs.lang) lang = cleanText(attrs.lang, asciiOnly)
  }

  // <title>
  let title = cleanText(fallbackTitle, asciiOnly)
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleanHtml)
  if (titleMatch) {
    const parsedTitle = stripTagsToText(titleMatch[1] ?? '', asciiOnly)
    if (parsedTitle) title = parsedTitle
  }

  // <link rel="canonical" href="...">
  let canonical: string | undefined
  const linkRe = /<link\b([^>]*)>/gi
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkRe.exec(cleanHtml)) !== null) {
    const attrs = parseAttrs(linkMatch[1] ?? '')
    const relTokens = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (relTokens.includes('canonical') && attrs.href) {
      canonical = resolveUrl(attrs.href, baseUrl || pageUrl)
      break
    }
  }

  // <meta ...>
  let description: string | undefined
  let author: string | undefined
  let robots: string | undefined
  let keywords: string[] | undefined

  const metaRe = /<meta\b([^>]*)>/gi
  let metaMatch: RegExpExecArray | null
  while ((metaMatch = metaRe.exec(cleanHtml)) !== null) {
    const attrs = parseAttrs(metaMatch[1] ?? '')
    const contentRaw = attrs.content
    if (contentRaw === undefined) continue
    const content = cleanText(contentRaw, asciiOnly)
    if (!content) continue

    const prop = (attrs.property ?? '').trim().toLowerCase()
    const name = (attrs.name ?? '').trim().toLowerCase()
    const key = prop || name
    if (!key) continue

    if (key.startsWith('og:')) {
      const ogKey = key.slice(3)
      if (ogKey) openGraph[ogKey] = content
    } else if (key.startsWith('twitter:')) {
      const twKey = key.slice(8)
      if (twKey) twitter[twKey] = content
    } else if (key === 'description') {
      if (!description) description = content
    } else if (key === 'author') {
      if (!author) author = content
    } else if (key === 'robots') {
      if (!robots) robots = content
    } else if (key === 'keywords') {
      const parsed = content
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
      if (parsed.length > 0) keywords = parsed
    } else if (name && !name.startsWith('og:') && !name.startsWith('twitter:')) {
      meta[name] = content
    }
  }

  return {
    title,
    ...(description ? { description } : {}),
    ...(canonical ? { canonical } : {}),
    ...(lang ? { lang } : {}),
    ...(author ? { author } : {}),
    ...(keywords ? { keywords } : {}),
    ...(robots ? { robots } : {}),
    openGraph,
    twitter,
    jsonLd,
    ...(jsonLdErrors > 0 ? { jsonLdErrors } : {}),
    meta,
  }
}

function extractTablesFromHtml(
  html: string,
  asciiOnly: boolean,
  includeObjects: boolean,
  maxItems: number,
): ExtractedTable[] {
  const cleanHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  const tableBlocks = findBalancedBlocks(cleanHtml, 'table')
  const tables: ExtractedTable[] = []

  for (let idx = 0; idx < tableBlocks.length && tables.length < maxItems; idx++) {
    const inner = tableBlocks[idx]!.innerHtml
    // Strip nested tables so we don't duplicate inner rows into the outer table
    const flatInner = inner.replace(/<table\b[\s\S]*?<\/table>/gi, '')

    const captionMatch = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(flatInner)
    const caption = captionMatch ? stripTagsToText(captionMatch[1] ?? '', asciiOnly) : undefined

    const headers: string[] = []
    const rows: string[][] = []

    // Identify thead ranges if present
    const theadMatch = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(flatInner)
    const theadHtml = theadMatch ? theadMatch[1] ?? '' : ''
    const bodyHtml = theadMatch
      ? flatInner.slice(0, theadMatch.index) + flatInner.slice(theadMatch.index + theadMatch[0].length)
      : flatInner

    const parseRow = (trHtml: string): { cells: string[]; allTh: boolean } => {
      const cells: string[] = []
      let thCount = 0
      const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cm: RegExpExecArray | null
      while ((cm = cellRe.exec(trHtml)) !== null) {
        if (cm[1]!.toLowerCase() === 'th') thCount++
        cells.push(stripTagsToText(cm[2] ?? '', asciiOnly))
      }
      return { cells, allTh: cells.length > 0 && thCount === cells.length }
    }

    if (theadHtml) {
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
      let trm: RegExpExecArray | null
      while ((trm = trRe.exec(theadHtml)) !== null) {
        const { cells } = parseRow(trm[1] ?? '')
        if (cells.length > 0 && headers.length === 0) {
          headers.push(...cells)
        }
      }
    }

    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let trm: RegExpExecArray | null
    while ((trm = trRe.exec(bodyHtml)) !== null) {
      const { cells, allTh } = parseRow(trm[1] ?? '')
      if (cells.length === 0) continue
      if (headers.length === 0 && allTh && rows.length === 0) {
        headers.push(...cells)
      } else {
        rows.push(cells)
      }
    }

    if (headers.length === 0 && rows.length === 0) continue

    const columnCount = Math.max(headers.length, ...rows.map((r) => r.length), 0)
    let objects: Array<Record<string, string>> | undefined
    if (includeObjects && headers.length > 0 && rows.length > 0) {
      objects = rows.map((row) => {
        const obj: Record<string, string> = {}
        const cols = Math.max(headers.length, row.length)
        for (let c = 0; c < cols; c++) {
          const key = headers[c] && headers[c]!.length > 0 ? headers[c]! : `col_${c + 1}`
          obj[key] = row[c] ?? ''
        }
        return obj
      })
    }

    tables.push({
      index: tables.length,
      ...(caption ? { caption } : {}),
      headers,
      rows,
      ...(objects ? { objects } : {}),
      rowCount: rows.length,
      columnCount,
    })
  }

  return tables
}

function extractTablesFromSnapshot(
  snapshot: PageSnapshot | undefined,
  asciiOnly: boolean,
  includeObjects: boolean,
  maxItems: number,
): ExtractedTable[] {
  if (!snapshot) return []
  const tables: ExtractedTable[] = []
  let currentHeaders: string[] = []
  let currentRows: string[][] = []

  const flush = () => {
    if (currentHeaders.length === 0 && currentRows.length === 0) return
    if (tables.length >= maxItems) {
      currentHeaders = []
      currentRows = []
      return
    }
    const columnCount = Math.max(currentHeaders.length, ...currentRows.map((r) => r.length), 0)
    let objects: Array<Record<string, string>> | undefined
    if (includeObjects && currentHeaders.length > 0 && currentRows.length > 0) {
      objects = currentRows.map((row) => {
        const obj: Record<string, string> = {}
        const cols = Math.max(currentHeaders.length, row.length)
        for (let c = 0; c < cols; c++) {
          const key = currentHeaders[c] || `col_${c + 1}`
          obj[key] = row[c] ?? ''
        }
        return obj
      })
    }
    tables.push({
      index: tables.length,
      headers: currentHeaders,
      rows: currentRows,
      ...(objects ? { objects } : {}),
      rowCount: currentRows.length,
      columnCount,
    })
    currentHeaders = []
    currentRows = []
  }

  for (const block of snapshot.blocks) {
    if (block.kind === 'table-row' && block.cells && block.cells.length > 0) {
      const cells = block.cells.map((c) => cleanText(c, asciiOnly))
      if (block.isHeader && currentHeaders.length === 0 && currentRows.length === 0) {
        currentHeaders = cells
      } else {
        currentRows.push(cells)
      }
    } else {
      flush()
    }
  }
  flush()
  return tables
}

function buildElementMatcher(snapshot?: PageSnapshot) {
  const elements = snapshot?.elements ?? []
  const used = new Set<string>()

  const findControlRef = (opts: {
    tag: string
    type?: string
    id?: string
    name?: string
    label?: string
    text?: string
  }): string | undefined => {
    const tagLower = opts.tag.toLowerCase()
    const typeLower = (opts.type ?? '').toLowerCase()
    const candidates = elements.filter((el) => el.ref && !used.has(el.ref))

    const pick = (el: ElementDescriptor | undefined): string | undefined => {
      if (!el?.ref) return undefined
      used.add(el.ref)
      return el.ref
    }

    if (opts.id) {
      const byId = candidates.find((el) => el.id === opts.id && el.tag.toLowerCase() === tagLower)
      if (byId) return pick(byId)
    }
    if (opts.name) {
      const byNameAndType = candidates.find(
        (el) =>
          el.name === opts.name &&
          el.tag.toLowerCase() === tagLower &&
          (!typeLower || el.type.toLowerCase() === typeLower),
      )
      if (byNameAndType) return pick(byNameAndType)
    }
    if (opts.label) {
      const norm = opts.label.toLowerCase()
      const byLabel = candidates.find(
        (el) =>
          el.tag.toLowerCase() === tagLower &&
          ((el.label ?? '').toLowerCase() === norm || (el.ariaLabel ?? '').toLowerCase() === norm),
      )
      if (byLabel) return pick(byLabel)
    }
    if (opts.text) {
      const norm = opts.text.toLowerCase()
      const byText = candidates.find(
        (el) =>
          (el.tag.toLowerCase() === tagLower || (tagLower === 'input' && el.tag.toLowerCase() === 'button')) &&
          el.text.toLowerCase() === norm,
      )
      if (byText) return pick(byText)
    }
    return undefined
  }

  const findLinkRef = (href: string, text: string, baseUrl: string): string | undefined => {
    const candidates = elements.filter((el) => el.ref && !used.has(el.ref) && (el.tag.toLowerCase() === 'a' || Boolean(el.href)))
    const normText = text.toLowerCase()
    const pick = (el: ElementDescriptor | undefined): string | undefined => {
      if (!el?.ref) return undefined
      used.add(el.ref)
      return el.ref
    }

    const exact = candidates.find((el) => {
      const elHref = el.href ? resolveUrl(el.href, baseUrl) : ''
      return elHref === href && el.text.toLowerCase() === normText
    })
    if (exact) return pick(exact)

    const byHref = candidates.find((el) => {
      const elHref = el.href ? resolveUrl(el.href, baseUrl) : ''
      return elHref === href
    })
    if (byHref) return pick(byHref)

    return undefined
  }

  return { findControlRef, findLinkRef }
}

function extractFormsFromHtml(
  html: string,
  baseUrl: string,
  snapshot: PageSnapshot | undefined,
  asciiOnly: boolean,
  maxItems: number,
): ExtractedForm[] {
  const cleanHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  // Build explicit label map (<label for="id">text</label>)
  const labelForMap = new Map<string, string>()
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi
  let lm: RegExpExecArray | null
  while ((lm = labelRe.exec(cleanHtml)) !== null) {
    const attrs = parseAttrs(lm[1] ?? '')
    if (attrs.for) {
      const text = stripTagsToText(lm[2] ?? '', asciiOnly)
      if (text) labelForMap.set(attrs.for, text)
    }
  }

  const matcher = buildElementMatcher(snapshot)
  const formBlocks = findBalancedBlocks(cleanHtml, 'form')
  const forms: ExtractedForm[] = []

  for (let idx = 0; idx < formBlocks.length && forms.length < maxItems; idx++) {
    const { attrs: formAttrs, innerHtml } = formBlocks[idx]!
    const action = formAttrs.action ? resolveUrl(formAttrs.action, baseUrl) : undefined
    const method = (formAttrs.method || 'GET').trim().toUpperCase()
    const enctype = formAttrs.enctype ? formAttrs.enctype.trim() : undefined

    // Determine form title
    let title: string | undefined
    if (formAttrs['aria-label']) {
      title = cleanText(formAttrs['aria-label'], asciiOnly)
    } else if (formAttrs.title) {
      title = cleanText(formAttrs.title, asciiOnly)
    } else {
      const legendMatch = /<legend\b[^>]*>([\s\S]*?)<\/legend>/i.exec(innerHtml)
      if (legendMatch) {
        const legendText = stripTagsToText(legendMatch[1] ?? '', asciiOnly)
        if (legendText) title = legendText
      } else {
        const headingMatch = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(innerHtml)
        if (headingMatch) {
          const hText = stripTagsToText(headingMatch[1] ?? '', asciiOnly)
          if (hText) title = hText
        }
      }
    }

    // Build implicit label lookup inside this form
    const implicitLabels = new Map<number, string>()
    const innerLabelRe = /<label\b[^>]*>([\s\S]*?)<\/label>/gi
    let ilm: RegExpExecArray | null
    while ((ilm = innerLabelRe.exec(innerHtml)) !== null) {
      const labelInner = ilm[1] ?? ''
      const labelText = stripTagsToText(
        labelInner
          .replace(/<input\b[^>]*>/gi, ' ')
          .replace(/<select\b[\s\S]*?<\/select>/gi, ' ')
          .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, ' '),
        asciiOnly,
      )
      if (labelText) {
        const start = ilm.index
        const end = innerLabelRe.lastIndex
        for (let pos = start; pos < end; pos++) {
          if (!implicitLabels.has(pos)) implicitLabels.set(pos, labelText)
        }
      }
    }

    const fields: ExtractedFormField[] = []
    const submitButtons: ExtractedFormSubmit[] = []

    const controlRe = /<(input)\b([^>]*)\/?>|<(textarea)\b([^>]*)>([\s\S]*?)<\/textarea>|<(select)\b([^>]*)>([\s\S]*?)<\/select>|<(button)\b([^>]*)>([\s\S]*?)<\/button>/gi
    let cm: RegExpExecArray | null
    while ((cm = controlRe.exec(innerHtml)) !== null) {
      const tag = (cm[1] ?? cm[3] ?? cm[6] ?? cm[9] ?? '').toLowerCase()
      const attrStr = cm[2] ?? cm[4] ?? cm[7] ?? cm[10] ?? ''
      const attrs = parseAttrs(attrStr)
      const id = attrs.id || undefined
      const name = attrs.name || undefined
      const ariaLabel = attrs['aria-label'] ? cleanText(attrs['aria-label'], asciiOnly) : undefined
      const label = (id ? labelForMap.get(id) : undefined) ?? implicitLabels.get(cm.index) ?? ariaLabel

      if (tag === 'button') {
        const type = (attrs.type ?? 'submit').toLowerCase()
        const text = stripTagsToText(cm[11] ?? '', asciiOnly) || ariaLabel || attrs.value || 'Button'
        if (type === 'submit') {
          const ref = matcher.findControlRef({ tag: 'button', type, id, name, text })
          submitButtons.push({
            ...(ref ? { ref } : {}),
            text,
            ...(name ? { name } : {}),
            ...(attrs.value ? { value: cleanText(attrs.value, asciiOnly) } : {}),
            ...('disabled' in attrs ? { disabled: true } : {}),
          })
        }
        continue
      }

      if (tag === 'input') {
        const type = (attrs.type ?? 'text').toLowerCase()
        if (type === 'reset') continue
        if (type === 'submit' || type === 'image') {
          const text = cleanText(attrs.value || attrs.alt || ariaLabel || 'Submit', asciiOnly)
          const ref = matcher.findControlRef({ tag: 'input', type, id, name, text })
          submitButtons.push({
            ...(ref ? { ref } : {}),
            text,
            ...(name ? { name } : {}),
            ...(attrs.value ? { value: cleanText(attrs.value, asciiOnly) } : {}),
            ...('disabled' in attrs ? { disabled: true } : {}),
          })
          continue
        }

        const placeholder = attrs.placeholder ? cleanText(attrs.placeholder, asciiOnly) : undefined
        const sensitive = sensitiveElementReason({
          tag: 'input',
          type,
          id,
          name,
          label,
          ariaLabel,
          placeholder,
          autocomplete: attrs.autocomplete,
        })
        const rawValue = attrs.value !== undefined ? cleanText(attrs.value, asciiOnly) : undefined
        const ref =
          type === 'hidden'
            ? undefined
            : matcher.findControlRef({ tag: 'input', type, id, name, label })

        fields.push({
          ...(ref ? { ref } : {}),
          tag: 'input',
          type,
          ...(name ? { name } : {}),
          ...(id ? { id } : {}),
          ...(label ? { label } : {}),
          ...(ariaLabel && ariaLabel !== label ? { ariaLabel } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...('required' in attrs ? { required: true } : {}),
          ...('disabled' in attrs ? { disabled: true } : {}),
          ...('readonly' in attrs ? { readOnly: true } : {}),
          ...(type === 'checkbox' || type === 'radio' ? { checked: 'checked' in attrs } : {}),
          ...(sensitive
            ? { valueRedacted: true }
            : rawValue !== undefined && rawValue.length > 0
              ? { value: rawValue }
              : {}),
        })
        continue
      }

      if (tag === 'textarea') {
        const placeholder = attrs.placeholder ? cleanText(attrs.placeholder, asciiOnly) : undefined
        const sensitive = sensitiveElementReason({
          tag: 'textarea',
          type: 'textarea',
          id,
          name,
          label,
          ariaLabel,
          placeholder,
          autocomplete: attrs.autocomplete,
        })
        const rawValue = cleanText(cm[5] ?? '', asciiOnly)
        const ref = matcher.findControlRef({ tag: 'textarea', type: 'textarea', id, name, label })
        fields.push({
          ...(ref ? { ref } : {}),
          tag: 'textarea',
          type: 'textarea',
          ...(name ? { name } : {}),
          ...(id ? { id } : {}),
          ...(label ? { label } : {}),
          ...(ariaLabel && ariaLabel !== label ? { ariaLabel } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...('required' in attrs ? { required: true } : {}),
          ...('disabled' in attrs ? { disabled: true } : {}),
          ...('readonly' in attrs ? { readOnly: true } : {}),
          ...(sensitive ? { valueRedacted: true } : rawValue ? { value: rawValue } : {}),
        })
        continue
      }

      if (tag === 'select') {
        const options: Array<{ value: string; label: string; selected?: boolean }> = []
        const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
        let om: RegExpExecArray | null
        let selectedValue: string | undefined
        while ((om = optRe.exec(cm[8] ?? '')) !== null) {
          const oAttrs = parseAttrs(om[1] ?? '')
          const optLabel = stripTagsToText(om[2] ?? '', asciiOnly)
          const optValue = oAttrs.value !== undefined ? cleanText(oAttrs.value, asciiOnly) : optLabel
          const selected = 'selected' in oAttrs
          if (selected && selectedValue === undefined) selectedValue = optValue
          options.push({
            value: optValue,
            label: optLabel,
            ...(selected ? { selected: true } : {}),
          })
        }
        if (selectedValue === undefined && options.length > 0) {
          selectedValue = options[0]!.value
        }
        const ref = matcher.findControlRef({ tag: 'select', type: 'select', id, name, label })
        fields.push({
          ...(ref ? { ref } : {}),
          tag: 'select',
          type: 'select',
          ...(name ? { name } : {}),
          ...(id ? { id } : {}),
          ...(label ? { label } : {}),
          ...(ariaLabel && ariaLabel !== label ? { ariaLabel } : {}),
          ...('required' in attrs ? { required: true } : {}),
          ...('disabled' in attrs ? { disabled: true } : {}),
          ...(selectedValue !== undefined ? { value: selectedValue } : {}),
          ...(options.length > 0 ? { options } : {}),
        })
      }
    }

    forms.push({
      index: forms.length,
      ...(formAttrs.id ? { id: formAttrs.id } : {}),
      ...(formAttrs.name ? { name: formAttrs.name } : {}),
      ...(title ? { title } : {}),
      ...(action ? { action } : {}),
      method,
      ...(enctype ? { enctype } : {}),
      fields,
      submitButtons,
    })
  }

  return forms
}

function extractFormsFromSnapshot(
  snapshot: PageSnapshot | undefined,
  asciiOnly: boolean,
  maxItems: number,
): ExtractedForm[] {
  if (!snapshot || maxItems <= 0) return []
  const fields: ExtractedFormField[] = []
  const submitButtons: ExtractedFormSubmit[] = []
  let action: string | undefined
  let method = 'GET'

  for (const el of snapshot.elements) {
    const tag = el.tag.toLowerCase()
    if (el.formAction && !action) action = el.formAction
    if (el.formMethod) method = el.formMethod.toUpperCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type === 'submit' || el.defaultSubmit) {
        submitButtons.push({
          ...(el.ref ? { ref: el.ref } : {}),
          text: cleanText(el.text || 'Submit', asciiOnly),
          ...(el.name ? { name: el.name } : {}),
          ...(el.disabled ? { disabled: true } : {}),
        })
      } else {
        fields.push({
          ...(el.ref ? { ref: el.ref } : {}),
          tag,
          type: el.type,
          ...(el.name ? { name: el.name } : {}),
          ...(el.id ? { id: el.id } : {}),
          ...(el.label ? { label: cleanText(el.label, asciiOnly) } : {}),
          ...(el.placeholder ? { placeholder: cleanText(el.placeholder, asciiOnly) } : {}),
          ...(el.disabled ? { disabled: true } : {}),
          ...(el.readOnly ? { readOnly: true } : {}),
          ...(el.checked !== undefined ? { checked: el.checked } : {}),
          ...(el.valueRedacted
            ? { valueRedacted: true }
            : el.value !== undefined
              ? { value: cleanText(el.value, asciiOnly) }
              : {}),
          ...(el.options ? { options: el.options } : {}),
        })
      }
    } else if (tag === 'button' && el.defaultSubmit) {
      submitButtons.push({
        ...(el.ref ? { ref: el.ref } : {}),
        text: cleanText(el.text || 'Submit', asciiOnly),
        ...(el.name ? { name: el.name } : {}),
        ...(el.disabled ? { disabled: true } : {}),
      })
    }
  }

  if (fields.length === 0 && submitButtons.length === 0) return []
  return [
    {
      index: 0,
      ...(action ? { action } : {}),
      method,
      fields,
      submitButtons,
    },
  ]
}

function extractLinksFromHtml(
  html: string,
  pageUrl: string,
  baseUrl: string,
  snapshot: PageSnapshot | undefined,
  asciiOnly: boolean,
  maxItems: number,
  opts: { externalLinksOnly?: boolean; internalLinksOnly?: boolean },
): ExtractedLink[] {
  const cleanHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  const pageOrigin = getOrigin(pageUrl)
  const matcher = buildElementMatcher(snapshot)
  const links: ExtractedLink[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = re.exec(cleanHtml)) !== null && links.length < maxItems) {
    const attrs = parseAttrs(m[1] ?? '')
    const rawHref = (attrs.href ?? '').trim()
    if (!rawHref || /^javascript:/i.test(rawHref)) continue
    const href = resolveUrl(rawHref, baseUrl)
    if (!href) continue

    const linkOrigin = getOrigin(href)
    const external = Boolean(pageOrigin && linkOrigin && linkOrigin !== pageOrigin)
    if (opts.externalLinksOnly && !external) continue
    if (opts.internalLinksOnly && external) continue

    const text =
      stripTagsToText(m[2] ?? '', asciiOnly) ||
      (attrs['aria-label'] ? cleanText(attrs['aria-label'], asciiOnly) : '') ||
      (attrs.title ? cleanText(attrs.title, asciiOnly) : '')

    const ref = matcher.findLinkRef(href, text, baseUrl)

    links.push({
      ...(ref ? { ref } : {}),
      text,
      href,
      ...(attrs.rel ? { rel: cleanText(attrs.rel, asciiOnly) } : {}),
      ...(attrs.target ? { target: cleanText(attrs.target, asciiOnly) } : {}),
      ...(attrs.title ? { title: cleanText(attrs.title, asciiOnly) } : {}),
      external,
    })
  }

  return links
}

function extractLinksFromSnapshot(
  snapshot: PageSnapshot | undefined,
  pageUrl: string,
  asciiOnly: boolean,
  maxItems: number,
  opts: { externalLinksOnly?: boolean; internalLinksOnly?: boolean },
): ExtractedLink[] {
  if (!snapshot) return []
  const pageOrigin = getOrigin(pageUrl)
  const links: ExtractedLink[] = []
  for (const el of snapshot.elements) {
    if (links.length >= maxItems) break
    if (!el.href) continue
    const href = resolveUrl(el.href, pageUrl)
    if (!href || /^javascript:/i.test(href)) continue
    const linkOrigin = getOrigin(href)
    const external = Boolean(pageOrigin && linkOrigin && linkOrigin !== pageOrigin)
    if (opts.externalLinksOnly && !external) continue
    if (opts.internalLinksOnly && external) continue
    links.push({
      ...(el.ref ? { ref: el.ref } : {}),
      text: cleanText(el.text || el.ariaLabel || '', asciiOnly),
      href,
      external,
    })
  }
  return links
}

function extractHeadingsFromHtml(html: string, asciiOnly: boolean, maxItems: number): ExtractedHeading[] {
  const cleanHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  const headings: ExtractedHeading[] = []
  const re = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cleanHtml)) !== null && headings.length < maxItems) {
    const level = Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6
    const attrs = parseAttrs(m[2] ?? '')
    const text = stripTagsToText(m[3] ?? '', asciiOnly)
    if (!text) continue
    headings.push({
      level,
      text,
      ...(attrs.id ? { id: attrs.id } : {}),
    })
  }
  return headings
}

function extractHeadingsFromSnapshot(
  snapshot: PageSnapshot | undefined,
  asciiOnly: boolean,
  maxItems: number,
): ExtractedHeading[] {
  if (!snapshot) return []
  const headings: ExtractedHeading[] = []
  for (const block of snapshot.blocks) {
    if (headings.length >= maxItems) break
    if (block.kind !== 'heading') continue
    const level = Math.min(6, Math.max(1, block.level ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6
    const text = cleanText(block.text, asciiOnly)
    if (!text) continue
    headings.push({ level, text })
  }
  return headings
}

export function extractStructuredData(input: {
  html?: string
  snapshot?: PageSnapshot
  url?: string
  title?: string
  options?: PageExtractOptions
}): PageExtractResult {
  const opts = input.options ?? {}
  const sections: ExtractSection[] =
    opts.sections && opts.sections.length > 0 ? [...opts.sections] : [...ALL_EXTRACT_SECTIONS]
  const sectionSet = new Set<ExtractSection>(sections)
  const asciiOnly = Boolean(opts.asciiOnly)
  const includeObjects = opts.includeObjects !== false
  const maxItems = Math.max(1, Math.min(1000, opts.maxItems ?? 200))

  const html = input.html ?? ''
  const hasHtml = html.trim().length > 0
  const pageUrl = input.url || input.snapshot?.url || 'about:blank'
  const fallbackTitle = input.title || input.snapshot?.title || ''
  const baseUrl = hasHtml ? extractBaseHref(html, pageUrl) : pageUrl

  const metadata = sectionSet.has('metadata')
    ? extractMetadata(html, pageUrl, baseUrl, fallbackTitle, asciiOnly)
    : undefined

  const title = metadata?.title || cleanText(fallbackTitle, asciiOnly)

  const tables = sectionSet.has('tables')
    ? hasHtml
      ? extractTablesFromHtml(html, asciiOnly, includeObjects, Math.min(maxItems, 50))
      : extractTablesFromSnapshot(input.snapshot, asciiOnly, includeObjects, Math.min(maxItems, 50))
    : undefined

  const forms = sectionSet.has('forms')
    ? hasHtml
      ? extractFormsFromHtml(html, baseUrl, input.snapshot, asciiOnly, Math.min(maxItems, 50))
      : extractFormsFromSnapshot(input.snapshot, asciiOnly, Math.min(maxItems, 50))
    : undefined

  const links = sectionSet.has('links')
    ? hasHtml
      ? extractLinksFromHtml(html, pageUrl, baseUrl, input.snapshot, asciiOnly, maxItems, {
          externalLinksOnly: opts.externalLinksOnly,
          internalLinksOnly: opts.internalLinksOnly,
        })
      : extractLinksFromSnapshot(input.snapshot, pageUrl, asciiOnly, maxItems, {
          externalLinksOnly: opts.externalLinksOnly,
          internalLinksOnly: opts.internalLinksOnly,
        })
    : undefined

  const headings = sectionSet.has('headings')
    ? hasHtml
      ? extractHeadingsFromHtml(html, asciiOnly, Math.min(maxItems, 100))
      : extractHeadingsFromSnapshot(input.snapshot, asciiOnly, Math.min(maxItems, 100))
    : undefined

  const counts: PageExtractResult['counts'] = {}
  if (tables) counts.tables = tables.length
  if (forms) counts.forms = forms.length
  if (links) counts.links = links.length
  if (headings) counts.headings = headings.length
  if (metadata) {
    counts.jsonLd = metadata.jsonLd.length
    counts.openGraph = Object.keys(metadata.openGraph).length
  }

  return {
    ok: true,
    url: pageUrl,
    title,
    sections,
    counts,
    ...(tables ? { tables } : {}),
    ...(forms ? { forms } : {}),
    ...(links ? { links } : {}),
    ...(headings ? { headings } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

export function formatExtractAscii(result: PageExtractResult, opts: { width?: number } = {}): string {
  const width = Math.max(40, Math.min(160, opts.width ?? 100))
  const hr = '+' + '-'.repeat(width - 2) + '+'
  const lines: string[] = []
  const push = (s: string) => lines.push(sanitizeAscii(s))

  push(hr)
  push(`| EXTRACT: ${result.title || '(untitled)'} (${result.url})`)
  const summaryParts: string[] = []
  if (result.counts.tables !== undefined) summaryParts.push(`tables=${result.counts.tables}`)
  if (result.counts.forms !== undefined) summaryParts.push(`forms=${result.counts.forms}`)
  if (result.counts.links !== undefined) summaryParts.push(`links=${result.counts.links}`)
  if (result.counts.headings !== undefined) summaryParts.push(`headings=${result.counts.headings}`)
  if (result.counts.jsonLd !== undefined) summaryParts.push(`jsonLd=${result.counts.jsonLd}`)
  if (result.counts.openGraph !== undefined) summaryParts.push(`og=${result.counts.openGraph}`)
  push(`| Sections: ${result.sections.join(', ')} | ${summaryParts.join(' ')}`)
  push(hr)

  if (result.metadata) {
    const m = result.metadata
    push('[METADATA]')
    if (m.description) push(`  description: ${m.description}`)
    if (m.canonical) push(`  canonical: ${m.canonical}`)
    if (m.lang) push(`  lang: ${m.lang}`)
    if (m.author) push(`  author: ${m.author}`)
    if (m.keywords && m.keywords.length > 0) push(`  keywords: ${m.keywords.join(', ')}`)
    const ogEntries = Object.entries(m.openGraph)
    if (ogEntries.length > 0) {
      push(`  OpenGraph (${ogEntries.length}):`)
      for (const [k, v] of ogEntries.slice(0, 12)) {
        push(`    og:${k} = ${v}`)
      }
    }
    const twEntries = Object.entries(m.twitter)
    if (twEntries.length > 0) {
      push(`  Twitter (${twEntries.length}):`)
      for (const [k, v] of twEntries.slice(0, 8)) {
        push(`    twitter:${k} = ${v}`)
      }
    }
    if (m.jsonLd.length > 0) {
      push(`  JSON-LD (${m.jsonLd.length} item${m.jsonLd.length === 1 ? '' : 's'}):`)
      for (let i = 0; i < Math.min(5, m.jsonLd.length); i++) {
        const item = m.jsonLd[i] as Record<string, unknown> | undefined
        const typeStr = item && typeof item === 'object' && '@type' in item ? String(item['@type']) : typeof item
        const nameStr = item && typeof item === 'object' && 'name' in item ? ` - ${String(item.name)}` : ''
        push(`    [${i}] @type=${typeStr}${nameStr}`)
      }
    }
  }

  if (result.headings) {
    push(`[HEADINGS] (${result.headings.length})`)
    for (const h of result.headings.slice(0, 30)) {
      const indent = '  '.repeat(h.level)
      push(`${indent}H${h.level}: ${h.text}${h.id ? ` (#${h.id})` : ''}`)
    }
  }

  if (result.tables) {
    push(`[TABLES] (${result.tables.length})`)
    for (const t of result.tables.slice(0, 10)) {
      push(`  Table #${t.index}${t.caption ? `: ${t.caption}` : ''} (${t.rowCount} rows x ${t.columnCount} cols)`)
      if (t.headers.length > 0) {
        push(`    Headers: ${t.headers.join(' | ')}`)
      }
      for (const row of t.rows.slice(0, 5)) {
        push(`    Row: ${row.join(' | ')}`)
      }
      if (t.rows.length > 5) {
        push(`    ... (+${t.rows.length - 5} more rows)`)
      }
    }
  }

  if (result.forms) {
    push(`[FORMS] (${result.forms.length})`)
    for (const f of result.forms.slice(0, 10)) {
      push(`  Form #${f.index}${f.title ? ` (${f.title})` : ''}: ${f.method} ${f.action ?? '(current)'}`)
      for (const field of f.fields.slice(0, 15)) {
        const refTag = field.ref ? `[${field.ref}] ` : ''
        const valStr = field.valueRedacted
          ? ' [REDACTED]'
          : field.value !== undefined
            ? ` = ${field.value}`
            : ''
        push(`    ${refTag}${field.tag}[${field.type}] name=${field.name ?? '-'} label=${field.label ?? '-'}${valStr}`)
      }
      for (const btn of f.submitButtons.slice(0, 5)) {
        const refTag = btn.ref ? `[${btn.ref}] ` : ''
        push(`    ${refTag}SUBMIT: ${btn.text}`)
      }
    }
  }

  if (result.links) {
    push(`[LINKS] (${result.links.length})`)
    for (const l of result.links.slice(0, 30)) {
      const refTag = l.ref ? `[${l.ref}] ` : ''
      const extTag = l.external ? ' (ext)' : ''
      push(`  ${refTag}${l.text || '(no text)'} -> ${l.href}${extTag}`)
    }
    if (result.links.length > 30) {
      push(`  ... (+${result.links.length - 30} more links)`)
    }
  }

  push(hr)
  return lines.join('\n')
}
