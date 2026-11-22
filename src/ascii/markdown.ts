// Snapshot-to-Markdown exporter (`renderPageMarkdown`) preserving inline `[eN]` refs
// for hybrid AI workflows (combining clean CommonMark/GFM structure with actionable Troy refs).

import type { ContentBlock, ElementDescriptor, InlineLink, MarkdownRenderOptions, PageSnapshot } from '../types.js'
import { cropPageSnapshot, humanizeFormName } from './layout.js'
import { extractMediaSummary, formatMediaMeta, resolveBlockCanvasPreview } from './media.js'
import { sanitizeAscii, stripAnsi } from './sanitize.js'

function cleanText(text: string, asciiOnly: boolean): string {
  return asciiOnly ? sanitizeAscii(text) : stripAnsi(text)
}

function normalizeInline(text: string, asciiOnly: boolean): string {
  return cleanText(text, asciiOnly).replace(/\s+/g, ' ').trim()
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, '\\$1')
}

function formatMarkdownHref(href: string): string {
  const trimmed = href.trim()
  if (!trimmed) return ''
  if (/[\s()]/.test(trimmed)) {
    return `<${trimmed.replace(/[<>]/g, '')}>`
  }
  return trimmed
}

function escapeTableCell(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim()
}

function escapeYamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

function pickCodeFence(code: string): string {
  const matches = code.match(/`{3,}/g)
  if (!matches) return '```'
  const longest = matches.reduce((max, m) => Math.max(max, m.length), 3)
  return '`'.repeat(longest + 1)
}

function formatInlineLinkToken(
  label: string,
  ref: string | undefined,
  href: string | undefined,
  opts: { showRefs: boolean; includeUrls: boolean; asciiOnly: boolean },
): string {
  const cleanLabel = normalizeInline(label, opts.asciiOnly)
  const cleanHref = href ? cleanText(href, opts.asciiOnly).trim() : ''
  const refSuffix = opts.showRefs && ref ? ` [${ref}]` : ''

  if (opts.includeUrls && cleanHref) {
    const escapedLabel = escapeMarkdownLinkLabel(cleanLabel || cleanHref)
    return `[${escapedLabel}](${formatMarkdownHref(cleanHref)})${refSuffix}`
  }
  if (cleanLabel) {
    return `[${escapeMarkdownLinkLabel(cleanLabel)}]${refSuffix}`
  }
  return refSuffix.trim()
}

/**
 * Render paragraph or list-item text with inline `[label](href) [eN]` tokens
 * while preserving surrounding prose and punctuation.
 */
export function renderInlineMarkdown(
  text: string,
  links: InlineLink[] | undefined,
  options: { showRefs?: boolean; includeUrls?: boolean; asciiOnly?: boolean } = {},
): string {
  const showRefs = options.showRefs ?? true
  const includeUrls = options.includeUrls ?? true
  const asciiOnly = options.asciiOnly ?? false

  if (!links || links.length === 0) {
    return normalizeInline(text, asciiOnly)
  }

  const parts: string[] = []
  const unmatched: InlineLink[] = []
  let cursor = 0

  for (const link of links) {
    const rawLabel = link.text || link.href || ''
    if (!rawLabel) continue

    let idx = -1
    let endIdx = -1

    if (
      link.start !== undefined &&
      link.end !== undefined &&
      link.start >= cursor &&
      link.end <= text.length &&
      link.end > link.start
    ) {
      idx = link.start
      endIdx = link.end
    } else {
      const exactIdx = text.indexOf(rawLabel, cursor)
      if (exactIdx !== -1) {
        idx = exactIdx
        endIdx = exactIdx + rawLabel.length
      } else {
        const lowerIdx = text.toLowerCase().indexOf(rawLabel.toLowerCase(), cursor)
        if (lowerIdx !== -1) {
          idx = lowerIdx
          endIdx = lowerIdx + rawLabel.length
        }
      }
    }

    if (idx !== -1 && endIdx > idx) {
      if (idx > cursor) {
        parts.push(cleanText(text.slice(cursor, idx), asciiOnly))
      }
      parts.push(formatInlineLinkToken(rawLabel, link.ref, link.href, { showRefs, includeUrls, asciiOnly }))
      cursor = endIdx
    } else {
      unmatched.push(link)
    }
  }

  if (cursor < text.length) {
    parts.push(cleanText(text.slice(cursor), asciiOnly))
  }

  let combined = parts.join('').replace(/\s+/g, ' ').trim()

  if (unmatched.length > 0) {
    const extras = unmatched
      .map((link) => formatInlineLinkToken(link.text || link.href || '', link.ref, link.href, { showRefs, includeUrls, asciiOnly }))
      .filter(Boolean)
    if (extras.length > 0) {
      combined = combined ? `${combined} ${extras.join(' ')}` : extras.join(' ')
    }
  }

  return combined
}

/**
 * Render a contiguous sequence of `table-row` blocks as a GFM Markdown table.
 */
export function renderMarkdownTable(
  rows: ContentBlock[],
  options: { asciiOnly?: boolean } = {},
): string[] {
  const asciiOnly = options.asciiOnly ?? false
  if (rows.length === 0) return []

  const parsedRows = rows.map((row) => {
    const rawCells = row.cells && row.cells.length > 0 ? row.cells : [row.text]
    return rawCells.map((c) => escapeTableCell(cleanText(c, asciiOnly)))
  })

  const colCount = Math.max(1, ...parsedRows.map((r) => r.length))
  const padRow = (cells: string[]): string[] => {
    const out = cells.slice()
    while (out.length < colCount) out.push('')
    return out
  }

  const normalized = parsedRows.map(padRow)
  const header = normalized[0]!
  const body = normalized.slice(1)

  const lines: string[] = [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
  ]
  for (const row of body) {
    lines.push(`| ${row.join(' | ')} |`)
  }
  return lines
}

function renderControlMarkdown(
  block: ContentBlock,
  opts: { showRefs: boolean; asciiOnly: boolean },
): string {
  const refPrefix = opts.showRefs && block.ref ? `[${block.ref}] ` : ''
  const label = normalizeInline(block.text || block.placeholder || block.kind, opts.asciiOnly)

  if (block.kind === 'input') {
    if (block.checked !== undefined) {
      const box = block.checked ? '[x]' : '[ ]'
      return `- ${box} ${refPrefix}**${label}**`
    }
    const val = block.value ? normalizeInline(block.value, opts.asciiOnly) : ''
    const placeholder = block.placeholder ? normalizeInline(block.placeholder, opts.asciiOnly) : ''
    if (val) {
      return `- ${refPrefix}**${label}** (input): \`${val.replace(/`/g, '\\`')}\``
    }
    if (placeholder) {
      return `- ${refPrefix}**${label}** (input): *(${placeholder})*`
    }
    return `- ${refPrefix}**${label}** (input)`
  }

  if (block.kind === 'select') {
    const val = block.value ? normalizeInline(block.value, opts.asciiOnly) : ''
    return val
      ? `- ${refPrefix}**${label}** (select): \`${val.replace(/`/g, '\\`')}\``
      : `- ${refPrefix}**${label}** (select)`
  }

  // button
  return `- ${refPrefix}**[${label || 'Button'}]**`
}

function renderElementRefLine(
  el: ElementDescriptor,
  opts: { showRefs: boolean; includeUrls: boolean; asciiOnly: boolean },
): string {
  const refPrefix = opts.showRefs && el.ref ? `[${el.ref}] ` : ''
  const label = normalizeInline(
    el.label || el.ariaLabel || el.text || el.placeholder || el.name || el.id || el.tag,
    opts.asciiOnly,
  )
  const roleTag = el.tag === 'a' ? 'link' : el.tag === 'button' || el.role === 'button' ? 'button' : el.type || el.tag
  const extras: string[] = []
  if (el.value !== undefined && el.value !== '') {
    extras.push(`value=\`${normalizeInline(el.value, opts.asciiOnly).replace(/`/g, '\\`')}\``)
  }
  if (opts.includeUrls && el.href) {
    extras.push(formatMarkdownHref(cleanText(el.href, opts.asciiOnly)))
  }
  const suffix = extras.length > 0 ? ` — ${extras.join(' | ')}` : ''
  return `- ${refPrefix}\`${roleTag}\` ${label}${suffix}`
}

function renderSingleBlock(
  block: ContentBlock,
  opts: {
    showRefs: boolean
    includeUrls: boolean
    asciiOnly: boolean
    includeCanvasPreview: boolean
    canvasPreviewWidth?: number
    canvasPreviewHeight?: number
  },
): string[] {
  switch (block.kind) {
    case 'heading': {
      const level = Math.max(1, Math.min(6, block.level ?? 2))
      const text = normalizeInline(block.text, opts.asciiOnly)
      const refSuffix = opts.showRefs && block.ref ? ` [${block.ref}]` : ''
      return [`${'#'.repeat(level)} ${text}${refSuffix}`]
    }
    case 'paragraph': {
      const rendered = renderInlineMarkdown(block.text, block.links, {
        showRefs: opts.showRefs,
        includeUrls: opts.includeUrls,
        asciiOnly: opts.asciiOnly,
      })
      return rendered ? [rendered] : []
    }
    case 'link': {
      const token = formatInlineLinkToken(block.text || block.href || 'link', block.ref, block.href, {
        showRefs: opts.showRefs,
        includeUrls: opts.includeUrls,
        asciiOnly: opts.asciiOnly,
      })
      return token ? [token] : []
    }
    case 'list-item': {
      const rendered = renderInlineMarkdown(block.text, block.links, {
        showRefs: opts.showRefs,
        includeUrls: opts.includeUrls,
        asciiOnly: opts.asciiOnly,
      })
      return rendered ? [`- ${rendered}`] : []
    }
    case 'code': {
      const code = cleanText(block.text, opts.asciiOnly).replace(/\r\n/g, '\n').trimEnd()
      const fence = pickCodeFence(code)
      return [fence, code, fence]
    }
    case 'input':
    case 'select':
    case 'button': {
      return [renderControlMarkdown(block, opts)]
    }
    case 'image': {
      const alt = normalizeInline(block.alt || block.text || 'image', opts.asciiOnly)
      const src = block.src ? cleanText(block.src, opts.asciiOnly).trim() : ''
      const meta = formatMediaMeta({
        width: block.box?.width,
        height: block.box?.height,
        naturalWidth: block.naturalWidth,
        naturalHeight: block.naturalHeight,
        box: block.box,
      })
      const refSuffix = opts.showRefs && block.ref ? ` [${block.ref}]` : ''
      const metaSuffix = meta ? ` *(${meta})*` : ''
      if (opts.includeUrls && src) {
        return [`![${escapeMarkdownLinkLabel(alt)}](${formatMarkdownHref(src)})${metaSuffix}${refSuffix}`]
      }
      return [`![${escapeMarkdownLinkLabel(alt)}]()${metaSuffix}${refSuffix}`]
    }
    case 'canvas': {
      const label = normalizeInline(block.alt || block.text || 'canvas', opts.asciiOnly)
      const meta = formatMediaMeta({
        width: block.box?.width,
        height: block.box?.height,
        naturalWidth: block.naturalWidth,
        naturalHeight: block.naturalHeight,
        box: block.box,
      })
      const refSuffix = opts.showRefs && block.ref ? ` [${block.ref}]` : ''
      const header = `**Canvas: ${label}**${meta ? ` *(${meta})*` : ''}${refSuffix}`
      if (!opts.includeCanvasPreview) return [header]
      const preview = resolveBlockCanvasPreview(block, {
        width: opts.canvasPreviewWidth ?? 48,
        height: opts.canvasPreviewHeight ?? 12,
      })
      if (!preview) return [header]
      const fence = pickCodeFence(preview)
      return [header, '', `${fence}text`, preview, fence]
    }
    case 'hr':
      return ['---']
    case 'table-row': {
      return renderMarkdownTable([block], { asciiOnly: opts.asciiOnly })
    }
  }
}

/**
 * Export a `PageSnapshot` as clean, deterministic CommonMark/GFM Markdown while
 * preserving inline `[eN]` interactive element refs for hybrid AI workflows.
 */
export function renderPageMarkdown(
  rawSnapshot: PageSnapshot,
  options: MarkdownRenderOptions = {},
): string {
  const snapshot = options.crop ? cropPageSnapshot(rawSnapshot, options.crop) : rawSnapshot
  const showRefs = options.showRefs ?? true
  const includeUrls = options.includeUrls ?? true
  const asciiOnly = options.asciiOnly ?? false
  const includeFrontmatter = options.includeFrontmatter ?? false
  const includeHeader = options.includeHeader ?? !includeFrontmatter
  const includeForms = options.includeForms ?? true
  const includeCanvasPreview = options.includeCanvasPreview ?? true
  const includeMediaSummary = options.includeMediaSummary ?? false
  const includeRefsIndex = options.includeRefsIndex ?? true

  const sections: string[] = []
  const title = normalizeInline(snapshot.title || 'Untitled', asciiOnly)
  const url = cleanText(snapshot.url || '', asciiOnly).trim()

  if (includeFrontmatter) {
    const fmLines = [
      '---',
      `title: ${escapeYamlString(title)}`,
      `url: ${escapeYamlString(url)}`,
      `tabId: ${snapshot.tabId}`,
      `epoch: ${snapshot.epoch}`,
      `refs: ${snapshot.elements.length}`,
      '---',
    ]
    sections.push(fmLines.join('\n'))
  }

  if (includeHeader) {
    const firstBlock = snapshot.blocks[0]
    const firstIsSameH1 =
      firstBlock?.kind === 'heading' &&
      (firstBlock.level ?? 2) === 1 &&
      normalizeInline(firstBlock.text, asciiOnly).toLowerCase() === title.toLowerCase()
    const headerLines: string[] = []
    if (!firstIsSameH1 && title) {
      headerLines.push(`# ${title}`)
    }
    if (url) {
      headerLines.push(`> URL: ${url}`)
    }
    if (options.crop) {
      const c = options.crop
      const cropLabel = options.cropLabel ? `${options.cropLabel} ` : ''
      headerLines.push(`> Crop: ${cropLabel}(${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.width)}x${Math.round(c.height)})`)
    }
    if (headerLines.length > 0) {
      sections.push(headerLines.join('\n\n'))
    }
  }

  // Render structured blocks
  const blocks = snapshot.blocks
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]!

    // Group contiguous table rows into a single GFM table
    if (block.kind === 'table-row') {
      const tableRows: ContentBlock[] = []
      while (i < blocks.length && blocks[i]!.kind === 'table-row') {
        tableRows.push(blocks[i]!)
        i++
      }
      sections.push(renderMarkdownTable(tableRows, { asciiOnly }).join('\n'))
      continue
    }

    // Group form controls sharing formId when includeForms is enabled
    if (includeForms && block.formId) {
      const formId = block.formId
      const formBlocks: ContentBlock[] = []
      while (i < blocks.length && blocks[i]!.formId === formId) {
        formBlocks.push(blocks[i]!)
        i++
      }
      const rawTitle =
        formBlocks.find((b) => b.formTitle)?.formTitle ??
        humanizeFormName(formId) ??
        'Form'
      const formHeading = `### Form: ${normalizeInline(rawTitle, asciiOnly)}`
      const lines: string[] = [formHeading, '']
      for (const fb of formBlocks) {
        const rendered = renderSingleBlock(fb, {
          showRefs,
          includeUrls,
          asciiOnly,
          includeCanvasPreview,
          canvasPreviewWidth: options.canvasPreviewWidth,
          canvasPreviewHeight: options.canvasPreviewHeight,
        })
        lines.push(...rendered)
      }
      sections.push(lines.join('\n'))
      continue
    }

    // Group consecutive list items tightly without blank lines between bullets
    if (block.kind === 'list-item') {
      const listLines: string[] = []
      while (i < blocks.length && blocks[i]!.kind === 'list-item' && !blocks[i]!.formId) {
        listLines.push(
          ...renderSingleBlock(blocks[i]!, {
            showRefs,
            includeUrls,
            asciiOnly,
            includeCanvasPreview,
            canvasPreviewWidth: options.canvasPreviewWidth,
            canvasPreviewHeight: options.canvasPreviewHeight,
          }),
        )
        i++
      }
      if (listLines.length > 0) sections.push(listLines.join('\n'))
      continue
    }

    // Group consecutive form controls (input/select/button) without blank lines between bullets
    if (block.kind === 'input' || block.kind === 'select' || block.kind === 'button') {
      const ctrlLines: string[] = []
      while (
        i < blocks.length &&
        !blocks[i]!.formId &&
        (blocks[i]!.kind === 'input' || blocks[i]!.kind === 'select' || blocks[i]!.kind === 'button')
      ) {
        ctrlLines.push(renderControlMarkdown(blocks[i]!, { showRefs, asciiOnly }))
        i++
      }
      if (ctrlLines.length > 0) sections.push(ctrlLines.join('\n'))
      continue
    }

    const rendered = renderSingleBlock(block, {
      showRefs,
      includeUrls,
      asciiOnly,
      includeCanvasPreview,
      canvasPreviewWidth: options.canvasPreviewWidth,
      canvasPreviewHeight: options.canvasPreviewHeight,
    })
    if (rendered.length > 0) {
      sections.push(rendered.join('\n'))
    }
    i++
  }

  // Fallback to raw snapshot.text if no blocks were extracted
  if (blocks.length === 0 && snapshot.text.trim()) {
    const rawParas = cleanText(snapshot.text, asciiOnly)
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (rawParas.length > 0) {
      sections.push(rawParas.join('\n\n'))
    }
  }

  // Optional Media & Canvas summary section
  if (includeMediaSummary) {
    const media = extractMediaSummary(snapshot, {
      includeCanvasPreview,
      previewWidth: options.canvasPreviewWidth ?? 48,
      previewHeight: options.canvasPreviewHeight ?? 12,
    })
    if (media.length > 0) {
      const mediaLines: string[] = [`## Media Summary (${media.length})`, '']
      for (const item of media) {
        const meta = formatMediaMeta(item)
        const label = normalizeInline(item.label, asciiOnly)
        const srcSuffix = includeUrls && item.src ? ` — ${formatMarkdownHref(cleanText(item.src, asciiOnly))}` : ''
        mediaLines.push(`- **${item.kind === 'canvas' ? 'Canvas' : 'Image'}**: ${label}${meta ? ` *(${meta})*` : ''}${srcSuffix}`)
        if (item.asciiPreview) {
          const fence = pickCodeFence(item.asciiPreview)
          mediaLines.push('', `${fence}text`, item.asciiPreview, fence, '')
        }
      }
      sections.push(mediaLines.join('\n').trimEnd())
    }
  }

  // Interactive Elements Index (orphan refs by default, or all refs when includeRefsIndex === 'always')
  if (showRefs && includeRefsIndex !== false && snapshot.elements.length > 0) {
    const renderedRefs = new Set<string>()
    for (const b of snapshot.blocks) {
      if (b.ref) renderedRefs.add(b.ref)
      if (b.links) {
        for (const lnk of b.links) {
          if (lnk.ref) renderedRefs.add(lnk.ref)
        }
      }
    }

    const indexElements =
      includeRefsIndex === 'always'
        ? snapshot.elements.filter((e) => e.ref)
        : snapshot.elements.filter((e) => e.ref && !renderedRefs.has(e.ref))

    if (indexElements.length > 0) {
      const heading = includeRefsIndex === 'always' ? '## Interactive Elements' : '## Additional Interactive Elements'
      const lines = [
        heading,
        '',
        ...indexElements.map((el) => renderElementRefLine(el, { showRefs, includeUrls, asciiOnly })),
      ]
      sections.push(lines.join('\n'))
    }
  }

  return sections.filter((s) => s.length > 0).join('\n\n')
}
