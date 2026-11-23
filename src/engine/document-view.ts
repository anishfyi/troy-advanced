// Plain-text, Markdown, and CSV/TSV document renderer for the Zero-Chrome Lite engine (M41).
// Converts non-HTML text documents into structured ContentBlocks + interactive ElementDescriptors
// (clickable Markdown/text links, aligned ASCII CSV tables with column sorting & pagination,
// and paginated plain-text inspection).

import type { ContentBlock, ElementDescriptor, InlineLink } from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

export type DocumentKind = 'markdown' | 'csv' | 'text'

export type CsvSortDirection = 'asc' | 'desc'

export interface DocumentRenderOptions {
  /** 0-based page index for paginated CSV or plain-text views. Default: 0. */
  page?: number
  /** Rows per page for CSV (default: 50) or lines per page for plain text (default: 120). */
  pageSize?: number
  /** CSV column index to sort by (0-based), or null for original order. */
  sortColumn?: number | null
  /** CSV sort direction when sortColumn is set. Default: 'asc'. */
  sortDirection?: CsvSortDirection
  /** Render raw plain-text source instead of formatted Markdown/CSV. */
  rawView?: boolean
}

export interface RenderedDocumentView {
  kind: DocumentKind
  title: string
  blocks: ContentBlock[]
  elements: ElementDescriptor[]
  text: string
  page: number
  totalPages: number
  meta: {
    lines: number
    words: number
    bytes: number
    rows?: number
    columns?: number
    delimiter?: string
    linksCount: number
  }
}

export interface ParsedCsvData {
  headers: string[]
  rows: string[][]
  delimiter: string
}

const DEFAULT_CSV_PAGE_SIZE = 50
const DEFAULT_TEXT_PAGE_SIZE = 120
const MAX_TEXT_LINKS = 50
const MAX_CSV_SORT_BUTTONS = 12

const MARKDOWN_MIMES = new Set([
  'text/markdown',
  'text/x-markdown',
  'application/markdown',
  'application/x-markdown',
])

const CSV_MIMES = new Set([
  'text/csv',
  'application/csv',
  'text/x-csv',
  'text/tab-separated-values',
  'text/tsv',
])

const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml'])

const MARKDOWN_EXT_RE = /\.(?:md|markdown|mdown|mkd)$/i
const CSV_EXT_RE = /\.(?:csv|tsv)$/i
const TEXT_EXT_RE = /\.(?:txt|text|log|ini|conf|cfg|toml|yaml|yml|env|rst|asc)$/i

function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
}

function normalizeNewlines(input: string): string {
  return stripBom(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function extractFilename(url: string): string {
  try {
    const parsed = new URL(url)
    const segs = parsed.pathname.split('/').filter(Boolean)
    return segs[segs.length - 1] || parsed.hostname || url
  } catch {
    return url
  }
}

function resolveSafeHttpUrl(rawHref: string, baseUrl: string): string | null {
  const trimmed = rawHref.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  if (/^(?:javascript|vbscript|data):/i.test(trimmed)) return null
  try {
    const resolved = new URL(trimmed, baseUrl)
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return resolved.toString()
    }
    return null
  } catch {
    return null
  }
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

/**
 * Detect whether a non-HTML Lite response should be rendered as Markdown, CSV/TSV, or Plain Text.
 * Returns null for HTML responses or unrecognized MIME types without matching extensions.
 */
export function detectDocumentKind(
  contentType: string,
  _body: string,
  url: string,
): DocumentKind | null {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (HTML_MIMES.has(mime)) return null

  if (MARKDOWN_MIMES.has(mime)) return 'markdown'
  if (CSV_MIMES.has(mime)) return 'csv'

  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url.split('?')[0] ?? ''
  }

  // Raw text hosts (e.g. raw.githubusercontent.com) often serve .md and .csv as text/plain.
  const isPlainOrGeneric =
    mime === 'text/plain' || mime === '' || mime === 'application/octet-stream'

  if (isPlainOrGeneric) {
    if (MARKDOWN_EXT_RE.test(pathname)) return 'markdown'
    if (CSV_EXT_RE.test(pathname)) return 'csv'
    if (mime === 'text/plain' || TEXT_EXT_RE.test(pathname)) return 'text'
  }

  // Other text/* subtypes (e.g. text/calendar, text/css, text/javascript, text/x-log)
  if (mime.startsWith('text/')) {
    return 'text'
  }

  return null
}

/**
 * Detect the delimiter for CSV/TSV content.
 */
export function detectCsvDelimiter(contentType: string, body: string, url: string): string {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime === 'text/tab-separated-values' || mime === 'text/tsv') return '\t'
  try {
    if (/\.tsv$/i.test(new URL(url).pathname)) return '\t'
  } catch {
    if (/\.tsv(?:[?#]|$)/i.test(url)) return '\t'
  }

  const normalized = normalizeNewlines(body)
  const sampleLines = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
  if (sampleLines.length === 0) return ','

  const candidates = [',', '\t', ';'] as const
  let best = ','
  let bestScore = -1

  for (const delim of candidates) {
    const counts = sampleLines.map((line) => countUnquotedDelimiter(line, delim))
    const minCount = Math.min(...counts)
    const totalCount = counts.reduce((a, b) => a + b, 0)
    // Prefer delimiters that appear consistently across sample lines
    const score = minCount > 0 ? totalCount * 2 + (counts.every((c) => c === counts[0]) ? 5 : 0) : totalCount
    if (score > bestScore && totalCount > 0) {
      bestScore = score
      best = delim
    }
  }
  return best
}

function countUnquotedDelimiter(line: string, delimiter: string): number {
  let inQuotes = false
  let count = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (!inQuotes && ch === delimiter) {
      count++
    }
  }
  return count
}

/**
 * RFC 4180 compliant CSV/TSV parser supporting quoted fields, escaped quotes (""),
 * embedded newlines, and CRLF/LF endings.
 */
export function parseCsvRows(raw: string, delimiter = ','): string[][] {
  const text = normalizeNewlines(raw)
  if (!text.trim()) return []

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }

  // Flush final row if non-empty
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  // Drop trailing completely empty rows
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === '')) {
    rows.pop()
  }
  return rows
}

export function parseCsvData(body: string, contentType = 'text/csv', url = ''): ParsedCsvData {
  const delimiter = detectCsvDelimiter(contentType, body, url)
  const allRows = parseCsvRows(body, delimiter)
  if (allRows.length === 0) {
    return { headers: [], rows: [], delimiter }
  }

  const maxCols = allRows.reduce((max, r) => Math.max(max, r.length), 0)
  const rawHeaders = allRows[0] ?? []
  const headers: string[] = []
  for (let c = 0; c < maxCols; c++) {
    const h = (rawHeaders[c] ?? '').replace(/\s+/g, ' ').trim()
    headers.push(h || `col_${c + 1}`)
  }

  const rows = allRows.slice(1).map((r) => {
    const normalized: string[] = []
    for (let c = 0; c < maxCols; c++) {
      normalized.push((r[c] ?? '').replace(/\s+/g, ' ').trim())
    }
    return normalized
  })

  return { headers, rows, delimiter }
}

function compareCsvValues(a: string, b: string): number {
  const numA = a !== '' ? Number(a.replace(/,/g, '')) : Number.NaN
  const numB = b !== '' ? Number(b.replace(/,/g, '')) : Number.NaN
  if (Number.isFinite(numA) && Number.isFinite(numB)) {
    return numA - numB
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function renderCsvDocument(
  body: string,
  url: string,
  contentType = 'text/csv',
  opts: DocumentRenderOptions = {},
): RenderedDocumentView {
  if (opts.rawView) {
    return renderPlainTextDocument(body, url, { ...opts, rawView: false }, 'csv')
  }

  const bytes = Buffer.byteLength(body, 'utf8')
  const normalized = normalizeNewlines(body)
  const lineCount = normalized ? normalized.split('\n').length : 0
  const wordCount = countWords(normalized)
  const filename = sanitizeAscii(extractFilename(url))
  const parsed = parseCsvData(body, contentType, url)

  const pageSize = Math.max(1, Math.min(500, Math.floor(opts.pageSize ?? DEFAULT_CSV_PAGE_SIZE)))
  const totalRows = parsed.rows.length
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const page = Math.max(0, Math.min(totalPages - 1, Math.floor(opts.page ?? 0)))

  const sortCol =
    typeof opts.sortColumn === 'number' &&
    Number.isInteger(opts.sortColumn) &&
    opts.sortColumn >= 0 &&
    opts.sortColumn < parsed.headers.length
      ? opts.sortColumn
      : null
  const sortDir: CsvSortDirection = opts.sortDirection === 'desc' ? 'desc' : 'asc'

  const orderedRows =
    sortCol !== null
      ? [...parsed.rows].sort((a, b) => {
          const cmp = compareCsvValues(a[sortCol] ?? '', b[sortCol] ?? '')
          return sortDir === 'desc' ? -cmp : cmp
        })
      : parsed.rows

  const startIdx = page * pageSize
  const pageRows = orderedRows.slice(startIdx, startIdx + pageSize)

  const kindLabel = parsed.delimiter === '\t' ? 'TSV' : 'CSV'
  const title = `${kindLabel}: ${filename} (${totalRows} rows x ${parsed.headers.length} cols)`
  const blocks: ContentBlock[] = []
  const elements: ElementDescriptor[] = []
  const textParts: string[] = []

  blocks.push({ kind: 'heading', level: 1, text: title, tag: 'h1' })
  textParts.push(title)

  const rangeStr =
    totalRows === 0
      ? '0 rows'
      : `Showing rows ${startIdx + 1}-${startIdx + pageRows.length} of ${totalRows} (page ${page + 1}/${totalPages})`
  const sortStr =
    sortCol !== null ? ` | Sorted by "${sanitizeAscii(parsed.headers[sortCol]!)}" (${sortDir})` : ''
  const delimLabel = parsed.delimiter === '\t' ? 'tab' : parsed.delimiter === ';' ? 'semicolon' : 'comma'
  const summary = `${rangeStr} | ${parsed.headers.length} columns | delimiter: ${delimLabel} | ${formatByteSize(bytes)}${sortStr}`
  blocks.push({ kind: 'paragraph', text: summary, tag: 'p' })
  textParts.push(summary)

  // Controls: sort buttons (capped), reset sort, pagination, raw view toggle
  const pushButton = (selector: string, label: string) => {
    elements.push({
      selector,
      tag: 'button',
      type: 'button',
      role: 'button',
      text: label,
      label,
    })
    blocks.push({
      kind: 'button',
      text: label,
      tag: 'button',
    })
  }

  const sortableCols = Math.min(parsed.headers.length, MAX_CSV_SORT_BUTTONS)
  for (let c = 0; c < sortableCols; c++) {
    const colName = sanitizeAscii(parsed.headers[c]!)
    const indicator = sortCol === c ? (sortDir === 'asc' ? ' ^' : ' v') : ''
    pushButton(`doc-csv-sort:${c}`, `Sort: ${colName}${indicator}`)
  }
  if (sortCol !== null) {
    pushButton('doc-csv-sort:reset', 'Reset Sort')
  }
  if (page > 0) {
    pushButton('doc-page:prev', `Prev Page (${page}/${totalPages})`)
  }
  if (page + 1 < totalPages) {
    pushButton('doc-page:next', `Next Page (${page + 2}/${totalPages})`)
  }
  pushButton('doc-action:raw-text', 'Raw Text')

  if (parsed.headers.length === 0) {
    blocks.push({ kind: 'paragraph', text: '(empty CSV document)', tag: 'p' })
    textParts.push('(empty CSV document)')
  } else {
    const displayHeaders = parsed.headers.map((h, idx) => {
      const clean = sanitizeAscii(h)
      if (sortCol === idx) return `${clean} ${sortDir === 'asc' ? '^' : 'v'}`
      return clean
    })
    blocks.push({
      kind: 'table-row',
      cells: displayHeaders,
      isHeader: true,
      text: displayHeaders.join(' | '),
      tag: 'tr',
    })
    textParts.push(displayHeaders.join(' | '))

    for (const r of pageRows) {
      const cleanCells = r.map((cell) => sanitizeAscii(cell))
      blocks.push({
        kind: 'table-row',
        cells: cleanCells,
        isHeader: false,
        text: cleanCells.join(' | '),
        tag: 'tr',
      })
      textParts.push(cleanCells.join(' | '))
    }
  }

  return {
    kind: 'csv',
    title,
    blocks,
    elements,
    text: textParts.join('\n'),
    page,
    totalPages,
    meta: {
      lines: lineCount,
      words: wordCount,
      bytes,
      rows: totalRows,
      columns: parsed.headers.length,
      delimiter: parsed.delimiter,
      linksCount: 0,
    },
  }
}

interface InlineParseResult {
  text: string
  links: InlineLink[]
}

function stripInlineFormatting(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
}

function parseMarkdownInline(
  raw: string,
  baseUrl: string,
  registerLink: (label: string, href: string) => InlineLink,
): InlineParseResult {
  const links: InlineLink[] = []
  let out = ''
  let i = 0

  while (i < raw.length) {
    // Inline code span: preserve literally without link parsing inside
    if (raw[i] === '`') {
      const end = raw.indexOf('`', i + 1)
      if (end > i) {
        out += raw.slice(i + 1, end)
        i = end + 1
        continue
      }
    }

    // Image: ![alt](src)
    if (raw[i] === '!' && raw[i + 1] === '[') {
      const closeBracket = raw.indexOf(']', i + 2)
      if (closeBracket > i + 1 && raw[closeBracket + 1] === '(') {
        const closeParen = raw.indexOf(')', closeBracket + 2)
        if (closeParen > closeBracket + 1) {
          const alt = raw.slice(i + 2, closeBracket).trim() || 'image'
          out += `[img: ${alt}]`
          i = closeParen + 1
          continue
        }
      }
    }

    // Link: [label](href "optional title")
    if (raw[i] === '[') {
      const closeBracket = raw.indexOf(']', i + 1)
      if (closeBracket > i && raw[closeBracket + 1] === '(') {
        const closeParen = raw.indexOf(')', closeBracket + 2)
        if (closeParen > closeBracket + 1) {
          const rawLabel = raw.slice(i + 1, closeBracket)
          const rawTarget = raw.slice(closeBracket + 2, closeParen).trim()
          // Strip optional title inside quotes
          const hrefToken = rawTarget.replace(/^<([^>]+)>$/, '$1').split(/\s+/)[0] ?? ''
          const cleanLabel = sanitizeAscii(stripInlineFormatting(rawLabel)).trim() || hrefToken
          const resolved = resolveSafeHttpUrl(hrefToken, baseUrl)
          if (resolved) {
            const start = out.length
            out += cleanLabel
            const link = registerLink(cleanLabel, resolved)
            links.push({ ...link, start, end: start + cleanLabel.length })
          } else {
            out += cleanLabel
          }
          i = closeParen + 1
          continue
        }
      }
    }

    // Autolink: <https://...>
    if (raw[i] === '<') {
      const closeAngle = raw.indexOf('>', i + 1)
      if (closeAngle > i + 1) {
        const candidate = raw.slice(i + 1, closeAngle).trim()
        if (/^https?:\/\/\S+$/i.test(candidate)) {
          const resolved = resolveSafeHttpUrl(candidate, baseUrl)
          if (resolved) {
            const start = out.length
            out += resolved
            const link = registerLink(resolved, resolved)
            links.push({ ...link, start, end: start + resolved.length })
            i = closeAngle + 1
            continue
          }
        }
      }
    }

    out += raw[i]
    i++
  }

  return {
    text: sanitizeAscii(stripInlineFormatting(out)).replace(/\s+/g, ' ').trim(),
    links,
  }
}

function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (trimmed[i] === '|') {
      cells.push(sanitizeAscii(stripInlineFormatting(current)).trim())
      current = ''
      continue
    }
    current += trimmed[i]
  }
  cells.push(sanitizeAscii(stripInlineFormatting(current)).trim())
  return cells
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(trimmed)
}

export function renderMarkdownDocument(
  body: string,
  url: string,
  opts: DocumentRenderOptions = {},
): RenderedDocumentView {
  if (opts.rawView) {
    return renderPlainTextDocument(body, url, { ...opts, rawView: false }, 'markdown')
  }

  const bytes = Buffer.byteLength(body, 'utf8')
  const normalized = normalizeNewlines(body)
  const lines = normalized.split('\n')
  const wordCount = countWords(normalized)
  const filename = sanitizeAscii(extractFilename(url))

  const blocks: ContentBlock[] = []
  const elements: ElementDescriptor[] = []
  const textParts: string[] = []
  let linkCounter = 0

  const registerLink = (label: string, href: string): InlineLink => {
    linkCounter += 1
    const selector = `doc-md-link:${linkCounter}`
    elements.push({
      selector,
      tag: 'a',
      type: 'link',
      role: 'link',
      text: label,
      href,
    })
    return {
      text: label,
      href,
      selector,
    }
  }

  let idx = 0
  let titleFromFrontmatter: string | null = null
  let firstH1: string | null = null

  // Optional YAML frontmatter at very top of document
  if (lines[0]?.trim() === '---') {
    let endIdx = -1
    for (let j = 1; j < Math.min(lines.length, 40); j++) {
      if (lines[j]!.trim() === '---' || lines[j]!.trim() === '...') {
        endIdx = j
        break
      }
    }
    if (endIdx > 1) {
      const metaEntries: string[] = []
      for (let j = 1; j < endIdx; j++) {
        const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(lines[j]!)
        if (m) {
          const key = m[1]!.toLowerCase()
          const val = sanitizeAscii(m[2]!.replace(/^["']|["']$/g, ''))
          if (key === 'title' && val) titleFromFrontmatter = val
          metaEntries.push(`${m[1]}: ${val}`)
        }
      }
      if (metaEntries.length > 0) {
        const metaLine = metaEntries.join(' | ')
        blocks.push({ kind: 'paragraph', text: metaLine, tag: 'p' })
        textParts.push(metaLine)
      }
      idx = endIdx + 1
    }
  }

  // Raw Text toggle button
  elements.push({
    selector: 'doc-action:raw-text',
    tag: 'button',
    type: 'button',
    role: 'button',
    text: 'Raw Text',
    label: 'Raw Text',
  })
  blocks.push({ kind: 'button', text: 'Raw Text', tag: 'button' })

  while (idx < lines.length) {
    const line = lines[idx]!
    const trimmed = line.trim()

    if (!trimmed) {
      idx++
      continue
    }

    // Fenced code block (``` or ~~~)
    const fenceMatch = /^(`{3,}|~{3,})\s*([^\s`~]*)/.exec(trimmed)
    if (fenceMatch) {
      const fenceChar = fenceMatch[1]![0]!
      const fenceLen = fenceMatch[1]!.length
      const lang = sanitizeAscii(fenceMatch[2] ?? '').trim()
      const codeLines: string[] = []
      if (lang) codeLines.push(`[${lang}]`)
      idx++
      while (idx < lines.length) {
        const closeLine = lines[idx]!.trim()
        if (closeLine.startsWith(fenceChar.repeat(fenceLen)) && closeLine.replace(new RegExp(`\\${fenceChar}`, 'g'), '').trim() === '') {
          idx++
          break
        }
        codeLines.push(sanitizeAscii(lines[idx]!))
        idx++
      }
      const codeText = codeLines.join('\n')
      blocks.push({ kind: 'code', text: codeText, tag: 'pre' })
      textParts.push(codeText)
      continue
    }

    // ATX Heading (# ... ######)
    const atxMatch = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(trimmed)
    if (atxMatch) {
      const level = atxMatch[1]!.length
      const parsed = parseMarkdownInline(atxMatch[2]!, url, registerLink)
      if (level === 1 && !firstH1 && parsed.text) firstH1 = parsed.text
      blocks.push({
        kind: 'heading',
        level,
        text: parsed.text,
        tag: `h${level}`,
        ...(parsed.links.length > 0 ? { links: parsed.links } : {}),
      })
      textParts.push(parsed.text)
      idx++
      continue
    }

    // Setext Heading (next line is === or ---)
    if (idx + 1 < lines.length) {
      const nextTrimmed = lines[idx + 1]!.trim()
      if (/^={3,}$/.test(nextTrimmed) || /^-{3,}$/.test(nextTrimmed)) {
        const level = nextTrimmed.startsWith('=') ? 1 : 2
        const parsed = parseMarkdownInline(trimmed, url, registerLink)
        if (level === 1 && !firstH1 && parsed.text) firstH1 = parsed.text
        blocks.push({
          kind: 'heading',
          level,
          text: parsed.text,
          tag: `h${level}`,
          ...(parsed.links.length > 0 ? { links: parsed.links } : {}),
        })
        textParts.push(parsed.text)
        idx += 2
        continue
      }
    }

    // Horizontal rule
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      blocks.push({ kind: 'hr', text: '---', tag: 'hr' })
      idx++
      continue
    }

    // GFM Pipe Table
    if (trimmed.includes('|') && idx + 1 < lines.length && isMarkdownTableSeparator(lines[idx + 1]!)) {
      const headerCells = splitMarkdownTableRow(line)
      blocks.push({
        kind: 'table-row',
        cells: headerCells,
        isHeader: true,
        text: headerCells.join(' | '),
        tag: 'tr',
      })
      textParts.push(headerCells.join(' | '))
      idx += 2
      while (idx < lines.length && lines[idx]!.trim().includes('|')) {
        const rowCells = splitMarkdownTableRow(lines[idx]!)
        while (rowCells.length < headerCells.length) rowCells.push('')
        blocks.push({
          kind: 'table-row',
          cells: rowCells.slice(0, Math.max(headerCells.length, rowCells.length)),
          isHeader: false,
          text: rowCells.join(' | '),
          tag: 'tr',
        })
        textParts.push(rowCells.join(' | '))
        idx++
      }
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (idx < lines.length && lines[idx]!.trim().startsWith('>')) {
        quoteLines.push(lines[idx]!.trim().replace(/^>\s?/, ''))
        idx++
      }
      const parsed = parseMarkdownInline(quoteLines.join(' '), url, registerLink)
      const quoteText = `> ${parsed.text}`
      blocks.push({
        kind: 'paragraph',
        text: quoteText,
        tag: 'blockquote',
        ...(parsed.links.length > 0
          ? {
              links: parsed.links.map((l) => ({
                ...l,
                start: (l.start ?? 0) + 2,
                end: (l.end ?? 0) + 2,
              })),
            }
          : {}),
      })
      textParts.push(quoteText)
      continue
    }

    // Unordered or ordered list item (including GFM task checkboxes)
    const listMatch = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line)
    if (listMatch) {
      const orderedNum = listMatch[2]
      let itemBody = listMatch[3]!
      let prefix = orderedNum ? `${orderedNum}. ` : ''
      const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemBody)
      if (taskMatch) {
        const checked = taskMatch[1]!.toLowerCase() === 'x'
        prefix += checked ? '[x] ' : '[ ] '
        itemBody = taskMatch[2]!
      }
      const parsed = parseMarkdownInline(itemBody, url, registerLink)
      const fullText = `${prefix}${parsed.text}`
      blocks.push({
        kind: 'list-item',
        text: fullText,
        tag: 'li',
        ...(parsed.links.length > 0
          ? {
              links: parsed.links.map((l) => ({
                ...l,
                start: (l.start ?? 0) + prefix.length,
                end: (l.end ?? 0) + prefix.length,
              })),
            }
          : {}),
      })
      textParts.push(fullText)
      idx++
      continue
    }

    // Paragraph (collect consecutive non-special lines)
    const paraLines: string[] = [trimmed]
    idx++
    while (idx < lines.length) {
      const next = lines[idx]!
      const nt = next.trim()
      if (!nt) break
      if (
        /^(#{1,6})\s+/.test(nt) ||
        /^(`{3,}|~{3,})/.test(nt) ||
        nt.startsWith('>') ||
        /^\s*(?:[-*+]|\d+\.)\s+/.test(next) ||
        /^(?:[-*_]\s*){3,}$/.test(nt) ||
        (nt.includes('|') && idx + 1 < lines.length && isMarkdownTableSeparator(lines[idx + 1]!))
      ) {
        break
      }
      paraLines.push(nt)
      idx++
    }
    const parsed = parseMarkdownInline(paraLines.join(' '), url, registerLink)
    if (parsed.text) {
      blocks.push({
        kind: 'paragraph',
        text: parsed.text,
        tag: 'p',
        ...(parsed.links.length > 0 ? { links: parsed.links } : {}),
      })
      textParts.push(parsed.text)
    }
  }

  const title = titleFromFrontmatter || firstH1 || filename

  return {
    kind: 'markdown',
    title,
    blocks,
    elements,
    text: textParts.join('\n'),
    page: 0,
    totalPages: 1,
    meta: {
      lines: lines.length,
      words: wordCount,
      bytes,
      linksCount: linkCounter,
    },
  }
}

export function renderPlainTextDocument(
  body: string,
  url: string,
  opts: DocumentRenderOptions = {},
  sourceKind: DocumentKind = 'text',
): RenderedDocumentView {
  const bytes = Buffer.byteLength(body, 'utf8')
  const normalized = normalizeNewlines(body)
  const allLines = normalized.length === 0 ? [] : normalized.split('\n')
  const wordCount = countWords(normalized)
  const filename = sanitizeAscii(extractFilename(url))

  const pageSize = Math.max(10, Math.min(1000, Math.floor(opts.pageSize ?? DEFAULT_TEXT_PAGE_SIZE)))
  const totalPages = Math.max(1, Math.ceil(allLines.length / pageSize))
  const page = Math.max(0, Math.min(totalPages - 1, Math.floor(opts.page ?? 0)))

  const startLine = page * pageSize
  const pageLines = allLines.slice(startLine, startLine + pageSize)

  const titlePrefix = sourceKind === 'text' ? 'Text' : `Raw ${sourceKind.toUpperCase()}`
  const title = `${titlePrefix}: ${filename}`
  const blocks: ContentBlock[] = []
  const elements: ElementDescriptor[] = []
  const textParts: string[] = []

  blocks.push({ kind: 'heading', level: 1, text: title, tag: 'h1' })
  textParts.push(title)

  const lineRange =
    allLines.length === 0
      ? '0 lines'
      : `Lines ${startLine + 1}-${startLine + pageLines.length} of ${allLines.length} (page ${page + 1}/${totalPages})`
  const summary = `${lineRange} | ${wordCount} words | ${formatByteSize(bytes)}`
  blocks.push({ kind: 'paragraph', text: summary, tag: 'p' })
  textParts.push(summary)

  const pushButton = (selector: string, label: string) => {
    elements.push({
      selector,
      tag: 'button',
      type: 'button',
      role: 'button',
      text: label,
      label,
    })
    blocks.push({ kind: 'button', text: label, tag: 'button' })
  }

  if (sourceKind !== 'text') {
    pushButton('doc-action:formatted', `Formatted ${sourceKind.toUpperCase()} View`)
  }
  if (page > 0) {
    pushButton('doc-page:prev', `Prev Page (${page}/${totalPages})`)
  }
  if (page + 1 < totalPages) {
    pushButton('doc-page:next', `Next Page (${page + 2}/${totalPages})`)
  }

  const pageText = pageLines.map((l) => sanitizeAscii(l)).join('\n')
  blocks.push({
    kind: 'code',
    text: pageText || '(empty document)',
    tag: 'pre',
  })
  textParts.push(pageText || '(empty document)')

  // Auto-detect HTTP/HTTPS URLs on the current page and expose them as clickable links
  const seenUrls = new Set<string>()
  const urlRe = /https?:\/\/[^\s<>"'`)\]]+/gi
  let linkCounter = 0
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(pageText)) !== null && linkCounter < MAX_TEXT_LINKS) {
    const cleaned = m[0]!.replace(/[.,;:!?]+$/, '')
    const resolved = resolveSafeHttpUrl(cleaned, url)
    if (!resolved || seenUrls.has(resolved)) continue
    seenUrls.add(resolved)
    linkCounter += 1
    const selector = `doc-text-link:${linkCounter}`
    elements.push({
      selector,
      tag: 'a',
      type: 'link',
      role: 'link',
      text: resolved,
      href: resolved,
    })
    blocks.push({
      kind: 'link',
      text: resolved,
      href: resolved,
      tag: 'a',
    })
  }

  return {
    kind: sourceKind,
    title,
    blocks,
    elements,
    text: textParts.join('\n'),
    page,
    totalPages,
    meta: {
      lines: allLines.length,
      words: wordCount,
      bytes,
      linksCount: linkCounter,
    },
  }
}

export function renderDocumentView(
  kind: DocumentKind,
  body: string,
  url: string,
  contentType = '',
  opts: DocumentRenderOptions = {},
): RenderedDocumentView {
  if (kind === 'markdown') {
    return renderMarkdownDocument(body, url, opts)
  }
  if (kind === 'csv') {
    return renderCsvDocument(body, url, contentType, opts)
  }
  return renderPlainTextDocument(body, url, opts, 'text')
}
