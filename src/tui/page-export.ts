// Page view exporter for the Terminal Browser TUI (`:save <file>` / `:export <file>`).
// Supports `.txt` (Layout ASCII or active Pixel Preview), `.md` (structured Markdown with [eN] refs),
// and `.json` (full snapshot + rendered views) with automatic extension inference, quoted paths,
// `~/` expansion, parent directory creation, and optional flags.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPageAsciiWithMetrics } from '../ascii/layout.js'
import { renderPageMarkdown } from '../ascii/markdown.js'
import { sanitizeAscii, stripAnsi } from '../ascii/sanitize.js'
import type { PageSnapshot, TabSummary } from '../types.js'
import {
  isPixelViewMode,
  renderPixelPreviewFrame,
  type TuiViewMode,
} from './pixel-preview.js'

export type PageExportFormat = 'txt' | 'md' | 'json'

export interface ParsedSaveCommand {
  ok: boolean
  filePath?: string
  format?: PageExportFormat
  frontmatter: boolean
  showRefs: boolean
  viewportOnly: boolean
  preserveAnsi: boolean
  forceAscii: boolean
  compact: boolean
  width?: number
  error?: string
}

export interface TuiExportSummary {
  format: PageExportFormat
  filePath: string
  bytes: number
  lines: number
  viewMode: TuiViewMode
  exportedAt: string
}

export interface PageExportResult {
  ok: boolean
  format: PageExportFormat
  filePath: string
  bytes: number
  lines: number
  viewMode: TuiViewMode
  exportedAt: string
  error?: string
}

export interface BuildPageExportOptions {
  snapshot: PageSnapshot
  format: PageExportFormat
  viewMode?: TuiViewMode
  pngBuffer?: Buffer | null
  width?: number
  height?: number
  scrollOffset?: number
  asciiOnly?: boolean
  tabs?: TabSummary[]
  activeTabId?: number
  frontmatter?: boolean
  showRefs?: boolean
  viewportOnly?: boolean
  preserveAnsi?: boolean
  compact?: boolean
  now?: Date
}

export interface ExportPageToFileOptions extends Omit<BuildPageExportOptions, 'format'> {
  rawFilePath: string
  explicitFormat?: PageExportFormat
  cwd?: string
}

export const SAVE_COMMAND_USAGE =
  'Usage: :save <file.{txt|md|json}> [--format txt|md|json] [--frontmatter] [--no-refs] [--viewport] [--ansi] [--ascii] [--compact] [--width N]'

/**
 * Normalize an explicit format string (e.g. from `--format`) into a canonical PageExportFormat.
 */
export function parseExportFormat(raw: string | undefined): PageExportFormat | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase().replace(/^\./, '')
  if (normalized === 'txt' || normalized === 'text' || normalized === 'ascii') {
    return 'txt'
  }
  if (normalized === 'md' || normalized === 'markdown') {
    return 'md'
  }
  if (normalized === 'json') {
    return 'json'
  }
  return null
}

/**
 * Infer export format from an explicit override or file extension. Defaults to `'txt'`.
 */
export function inferExportFormat(filePath: string, explicitFormat?: PageExportFormat): PageExportFormat {
  if (explicitFormat) return explicitFormat
  const ext = path.extname(filePath).toLowerCase()
  const fromExt = parseExportFormat(ext)
  return fromExt ?? 'txt'
}

/**
 * Tokenize a `:save` argument string supporting single quotes, double quotes, and backslash escapes.
 */
export function tokenizeSaveArgs(rawArgs: string): { ok: boolean; tokens: string[]; error?: string } {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false

  for (let i = 0; i < rawArgs.length; i++) {
    const ch = rawArgs[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < rawArgs.length) {
        current += rawArgs[i + 1]!
        i++
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      hasToken = true
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }

    if (ch === '\\' && i + 1 < rawArgs.length) {
      current += rawArgs[i + 1]!
      i++
      hasToken = true
      continue
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }

    current += ch
    hasToken = true
  }

  if (quote) {
    return { ok: false, tokens: [], error: `Unterminated ${quote} quote in :save arguments` }
  }
  if (hasToken) {
    tokens.push(current)
  }
  return { ok: true, tokens }
}

/**
 * Parse `:save <file> [flags...]` arguments cleanly.
 */
export function parseSaveCommandArgs(rawArgs: string): ParsedSaveCommand {
  const base: ParsedSaveCommand = {
    ok: false,
    frontmatter: false,
    showRefs: true,
    viewportOnly: false,
    preserveAnsi: false,
    forceAscii: false,
    compact: false,
  }

  const trimmed = rawArgs.trim()
  if (!trimmed) {
    return { ...base, error: SAVE_COMMAND_USAGE }
  }

  const tokenized = tokenizeSaveArgs(trimmed)
  if (!tokenized.ok) {
    return { ...base, error: tokenized.error }
  }

  const positional: string[] = []
  const tokens = tokenized.tokens
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === '--format' || tok === '-f') {
      const next = tokens[i + 1]
      const parsed = parseExportFormat(next)
      if (!parsed) {
        return { ...base, error: `Invalid format "${next ?? ''}". Use txt, md, or json.` }
      }
      base.format = parsed
      i++
    } else if (tok.startsWith('--format=')) {
      const val = tok.slice('--format='.length)
      const parsed = parseExportFormat(val)
      if (!parsed) {
        return { ...base, error: `Invalid format "${val}". Use txt, md, or json.` }
      }
      base.format = parsed
    } else if (tok === '--frontmatter') {
      base.frontmatter = true
    } else if (tok === '--no-refs') {
      base.showRefs = false
    } else if (tok === '--viewport') {
      base.viewportOnly = true
    } else if (tok === '--ansi') {
      base.preserveAnsi = true
    } else if (tok === '--ascii') {
      base.forceAscii = true
    } else if (tok === '--compact') {
      base.compact = true
    } else if (tok === '--width' || tok === '-w') {
      const next = Number(tokens[i + 1])
      if (!Number.isFinite(next) || next < 40 || next > 240) {
        return { ...base, error: `Invalid width "${tokens[i + 1] ?? ''}". Expected 40..240.` }
      }
      base.width = Math.floor(next)
      i++
    } else if (tok.startsWith('--width=')) {
      const val = Number(tok.slice('--width='.length))
      if (!Number.isFinite(val) || val < 40 || val > 240) {
        return { ...base, error: `Invalid width "${tok.slice('--width='.length)}". Expected 40..240.` }
      }
      base.width = Math.floor(val)
    } else if (tok.startsWith('-')) {
      return { ...base, error: `Unknown option "${tok}". ${SAVE_COMMAND_USAGE}` }
    } else {
      positional.push(tok)
    }
  }

  if (positional.length === 0) {
    return { ...base, error: `Missing output file path. ${SAVE_COMMAND_USAGE}` }
  }
  if (positional.length > 1) {
    return { ...base, error: `Unexpected extra argument "${positional[1]}". Quote paths containing spaces.` }
  }

  const filePath = positional[0]!.trim()
  if (!filePath) {
    return { ...base, error: `Output file path cannot be empty. ${SAVE_COMMAND_USAGE}` }
  }

  return {
    ...base,
    ok: true,
    filePath,
  }
}

/**
 * Expand leading `~` / `~/` and resolve relative paths against `cwd`.
 */
export function resolveExportPath(rawFilePath: string, cwd: string = process.cwd()): string {
  const trimmed = rawFilePath.trim()
  let expanded = trimmed
  if (trimmed === '~') {
    expanded = os.homedir()
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    expanded = path.join(os.homedir(), trimmed.slice(2))
  }
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)
}

function renderFullLayoutAscii(
  snapshot: PageSnapshot,
  opts: {
    width: number
    height: number
    scrollOffset: number
    asciiOnly: boolean
    preserveAnsi: boolean
    showRefs: boolean
    viewportOnly: boolean
    tabs?: TabSummary[]
    activeTabId?: number
  },
): string {
  const color = opts.preserveAnsi && !opts.asciiOnly

  if (opts.viewportOnly) {
    const rendered = renderPageAsciiWithMetrics(snapshot, {
      width: opts.width,
      height: opts.height,
      scrollOffset: opts.scrollOffset,
      asciiOnly: opts.asciiOnly,
      color,
      showRefs: opts.showRefs,
      tabs: opts.tabs,
      activeTabId: opts.activeTabId,
    })
    return opts.preserveAnsi ? rendered.ascii : stripAnsi(rendered.ascii)
  }

  // Probe total body line count so we render the entire page cleanly without truncation
  // or excessive empty padding.
  const probe = renderPageAsciiWithMetrics(snapshot, {
    width: opts.width,
    height: 200,
    scrollOffset: 0,
    asciiOnly: opts.asciiOnly,
    color: false,
    showRefs: opts.showRefs,
    showScrollbar: false,
  })

  if (probe.totalLines <= probe.viewportRows) {
    const chromeRows = 200 - probe.viewportRows
    const exactHeight = Math.max(14, Math.min(200, probe.totalLines + chromeRows))
    const exact = renderPageAsciiWithMetrics(snapshot, {
      width: opts.width,
      height: exactHeight,
      scrollOffset: 0,
      asciiOnly: opts.asciiOnly,
      color,
      showRefs: opts.showRefs,
      showScrollbar: false,
    })
    return opts.preserveAnsi ? exact.ascii : stripAnsi(exact.ascii)
  }

  // Long page (> ~190 lines): render without fixed viewport chrome slicing by stitching
  // contiguous showChrome:false slices so every line is preserved in order.
  const collected: string[] = []
  const headerTitle = opts.asciiOnly ? sanitizeAscii(snapshot.title || 'Untitled') : stripAnsi(snapshot.title || 'Untitled')
  const headerUrl = opts.asciiOnly ? sanitizeAscii(snapshot.url || '') : stripAnsi(snapshot.url || '')
  if (headerTitle) collected.push(`# ${headerTitle}`)
  if (headerUrl) collected.push(`URL: ${headerUrl}`)
  collected.push((opts.asciiOnly ? '-' : '─').repeat(Math.min(opts.width, 80)))

  const chunkHeight = 180
  let offset = 0
  let guard = 0
  while (guard < 200) {
    guard++
    const slice = renderPageAsciiWithMetrics(snapshot, {
      width: opts.width,
      height: chunkHeight,
      scrollOffset: offset,
      asciiOnly: opts.asciiOnly,
      color,
      showRefs: opts.showRefs,
      showChrome: false,
      showScrollbar: false,
    })
    const sliceLines = slice.ascii.split('\n')
    const startIdx = Math.max(0, offset - slice.scrollOffset)
    const available = Math.max(0, Math.min(slice.viewportRows, sliceLines.length) - startIdx)
    const remaining = Math.max(0, slice.totalLines - offset)
    const takeCount = Math.min(available, remaining)
    for (let i = 0; i < takeCount; i++) {
      collected.push(sliceLines[startIdx + i]!)
    }
    offset += takeCount
    if (offset >= slice.totalLines || takeCount === 0) break
  }

  const joined = collected.join('\n')
  return opts.preserveAnsi ? joined : stripAnsi(joined)
}

/**
 * Build the serialized export content for `.txt`, `.md`, or `.json` without touching disk.
 */
export function buildPageExportContent(options: BuildPageExportOptions): {
  content: string
  format: PageExportFormat
  lines: number
} {
  const {
    snapshot,
    format,
    viewMode = 'layout',
    pngBuffer = null,
    width = 100,
    height = 36,
    scrollOffset = 0,
    asciiOnly = false,
    tabs,
    activeTabId,
    frontmatter = false,
    showRefs = true,
    viewportOnly = false,
    preserveAnsi = false,
    compact = false,
    now = new Date(),
  } = options

  let content: string

  if (format === 'md') {
    content = renderPageMarkdown(snapshot, {
      includeFrontmatter: frontmatter,
      includeHeader: true,
      showRefs,
      includeUrls: true,
      asciiOnly,
      includeForms: true,
      includeCanvasPreview: true,
      includeRefsIndex: showRefs,
    })
  } else if (format === 'json') {
    const asciiText = isPixelViewMode(viewMode)
      ? stripAnsi(
          renderPixelPreviewFrame({
            snapshot,
            pngBuffer,
            viewMode,
            width,
            height,
            asciiOnly,
            color: false,
            scrollOffset: viewportOnly ? scrollOffset : 0,
            tabs,
            activeTabId,
            annotate: showRefs,
          }).frame,
        )
      : renderFullLayoutAscii(snapshot, {
          width,
          height,
          scrollOffset,
          asciiOnly: true,
          preserveAnsi: false,
          showRefs,
          viewportOnly,
          tabs,
          activeTabId,
        })

    const markdownText = renderPageMarkdown(snapshot, {
      includeFrontmatter: frontmatter,
      includeHeader: true,
      showRefs,
      includeUrls: true,
      asciiOnly,
      includeForms: true,
      includeCanvasPreview: true,
      includeRefsIndex: showRefs,
    })

    const payload: Record<string, unknown> = {
      schemaVersion: 1,
      exportedAt: now.toISOString(),
      viewMode,
      tabId: snapshot.tabId,
      epoch: snapshot.epoch,
      url: snapshot.url,
      title: snapshot.title,
      viewport: snapshot.viewport,
      elementCount: snapshot.elements.length,
      blockCount: snapshot.blocks.length,
      elements: snapshot.elements,
      blocks: snapshot.blocks,
      ...(tabs && tabs.length > 0 ? { tabs } : {}),
      rendered: {
        ascii: asciiText,
        markdown: markdownText,
      },
    }

    content = JSON.stringify(payload, null, compact ? 0 : 2)
  } else {
    // `.txt`
    if (isPixelViewMode(viewMode)) {
      const pixelFrame = renderPixelPreviewFrame({
        snapshot,
        pngBuffer,
        viewMode,
        width,
        height,
        asciiOnly: asciiOnly && viewMode === 'pixel-ascii',
        color: preserveAnsi && viewMode === 'halfblock',
        scrollOffset: viewportOnly ? scrollOffset : 0,
        tabs,
        activeTabId,
        annotate: showRefs,
      })
      content = preserveAnsi ? pixelFrame.frame : stripAnsi(pixelFrame.frame)
    } else {
      content = renderFullLayoutAscii(snapshot, {
        width,
        height,
        scrollOffset,
        asciiOnly,
        preserveAnsi,
        showRefs,
        viewportOnly,
        tabs,
        activeTabId,
      })
    }
  }

  const normalized = content.endsWith('\n') ? content : `${content}\n`
  const lines = normalized.split('\n').length - 1
  return { content: normalized, format, lines }
}

/**
 * Write the current page view to `.txt`, `.md`, or `.json` on disk.
 */
export function exportPageViewToFile(options: ExportPageToFileOptions): PageExportResult {
  const now = options.now ?? new Date()
  const exportedAt = now.toISOString()
  const viewMode = options.viewMode ?? 'layout'
  const resolvedPath = resolveExportPath(options.rawFilePath, options.cwd)
  const format = inferExportFormat(resolvedPath, options.explicitFormat)

  try {
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      return {
        ok: false,
        format,
        filePath: resolvedPath,
        bytes: 0,
        lines: 0,
        viewMode,
        exportedAt,
        error: `Target path is a directory: ${resolvedPath}`,
      }
    }

    const parentDir = path.dirname(resolvedPath)
    fs.mkdirSync(parentDir, { recursive: true })

    const built = buildPageExportContent({
      ...options,
      format,
      now,
    })

    fs.writeFileSync(resolvedPath, built.content, 'utf8')
    const bytes = Buffer.byteLength(built.content, 'utf8')

    return {
      ok: true,
      format,
      filePath: resolvedPath,
      bytes,
      lines: built.lines,
      viewMode,
      exportedAt,
    }
  } catch (err) {
    return {
      ok: false,
      format,
      filePath: resolvedPath,
      bytes: 0,
      lines: 0,
      viewMode,
      exportedAt,
      error: (err as Error).message,
    }
  }
}

export function formatExportByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatExportStatusMessage(result: PageExportResult): string {
  if (!result.ok) {
    return `Save failed: ${result.error ?? 'unknown error'}`
  }
  const fmtTag = result.format.toUpperCase()
  const modeSuffix =
    result.format === 'txt' && isPixelViewMode(result.viewMode) ? ` [${result.viewMode}]` : ''
  return `Saved ${fmtTag}${modeSuffix} -> ${result.filePath} (${result.lines} lines, ${formatExportByteSize(result.bytes)})`
}
