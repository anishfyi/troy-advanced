// Zero-Chrome pure-Node HTML/DOM + CookieJar engine ("lite" engine).
// Runs anywhere Node.js runs — even tiny 512MB EC2 t4g.nano instances, Alpine containers,
// or offline tests without Chromium installed.

import os from 'node:os'
import path from 'node:path'
import type {
  BrowserCookie,
  ConsoleEntry,
  ContentBlock,
  CookieExportOptions,
  CookieImportResult,
  DialogEntry,
  DialogEvent,
  DialogPolicyOptions,
  DialogQueuedResponse,
  DialogStats,
  DialogType,
  DownloadEntry,
  DownloadEvent,
  DownloadPolicyOptions,
  DownloadStats,
  DownloadStatus,
  ElementDescriptor,
  EmulationOptions,
  EmulationProfile,
  EmulationUpdateMode,
  FrameSummary,
  InlineLink,
  NetworkBodyInspectionOptions,
  NetworkBodyResult,
  NetworkEntry,
  NetworkListOptions,
  OriginStorageSnapshot,
  PageSnapshot,
  SettleOptions,
  SettleResult,
  StorageArea,
  StorageClearResult,
  StorageImportResult,
  WaitConditionOptions,
  WaitResult,
  WaitState,
} from '../types.js'
import { humanizeFormName } from '../ascii/layout.js'
import { isTrackerHost } from '../agent/omnibox.js'
import { CookieJar } from './cookie-jar.js'
import { DialogManager } from './dialogs.js'
import {
  NetworkRecorder,
  buildNetworkBodyResult,
  normalizeHeadersMap,
  serializeRequestInitBody,
} from './network.js'
import {
  DownloadQuarantineManager,
  isDownloadResponse,
  parseContentDispositionFilename,
} from './downloads.js'
import { cloneEmulationProfile, defaultEmulationProfile, resolveEmulationProfile } from './emulation.js'
import { flattenFrameSnapshots, prefixFrameSelector, type ChildFrameSnapshotInput } from './frames.js'
import { decodeHtmlEntities } from './html-entities.js'
import { parseKeyChord } from './keyboard.js'
import { waitForPageSettle } from './settle.js'
import {
  filterStorageSnapshots,
  normalizeOriginStorageSnapshot,
  normalizeStorageArea,
  normalizeStorageMap,
  normalizeStorageOrigin,
  originFilterMatches,
} from './storage.js'
import type { BrowserEngine, TabDriver } from './types.js'
import {
  checkLiteSelectorState,
  describeWaitCondition,
  extractLitePageText,
  matchesText,
  matchesUrlPattern,
  pollUntil,
} from './wait.js'

function decodeEntities(text: string): string {
  return decodeHtmlEntities(text)
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract the accessible label text from inside a `<label>...</label>` element,
 * excluding embedded form controls (such as `<select><option>...</option></select>`,
 * `<textarea>default</textarea>`, `<button>...</button>`, `<input .../>`, etc.)
 * so option labels and default values never pollute the label text.
 */
export function extractLabelText(innerHtml: string): string {
  const withoutControls = innerHtml
    .replace(/<select\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?<\/select>/gi, ' ')
    .replace(/<textarea\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?<\/textarea>/gi, ' ')
    .replace(/<button\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?<\/button>/gi, ' ')
    .replace(/<meter\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?<\/meter>/gi, ' ')
    .replace(/<output\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?<\/output>/gi, ' ')
    .replace(/<progress\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?<\/progress>/gi, ' ')
    .replace(/<input\b(?:"[^"]*"|'[^']*'|[^>])*\/?>/gi, ' ')
  return stripTags(withoutControls)
}

interface ImplicitLabelSpan {
  start: number
  end: number
  text: string
  consumed: boolean
}

function resolveImplicitLabel(controlOffset: number, spans: ImplicitLabelSpan[]): string | undefined {
  for (const span of spans) {
    if (controlOffset > span.start && controlOffset < span.end) {
      if (span.consumed) return undefined
      span.consumed = true
      return span.text
    }
    if (span.start > controlOffset) break
  }
  return undefined
}

function containsVisibleFormControl(innerHtml: string): boolean {
  if (/<(?:textarea|select|button)\b/i.test(innerHtml)) return true
  const inputRe = /<input\b([^>]*)\/?>/gi
  let im: RegExpExecArray | null
  while ((im = inputRe.exec(innerHtml)) !== null) {
    const attrs = parseAttrs(im[1] ?? '')
    if ((attrs.type || 'text').toLowerCase() !== 'hidden') return true
  }
  return false
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(attrString)) !== null) {
    const key = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[key] = decodeHtmlEntities(val, { attributeMode: true })
  }
  return attrs
}

function parsePositiveDim(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function resolveHref(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}

const UNSAFE_BASE_PROTOCOLS = new Set(['javascript:', 'vbscript:', 'data:'])
const ALLOWED_REFRESH_PROTOCOLS = new Set(['http:', 'https:'])

function stripIgnoredHtmlBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
}

export interface MetaRefreshDirective {
  delaySeconds: number
  url?: string
  rawContent: string
}

/**
 * Extract the effective document base URL from the first `<base href="...">` element
 * per HTML5 §4.2.3. Returns `undefined` when no valid `<base href>` is present.
 * `<base target="...">` elements without `href` are skipped.
 */
export function extractBaseHref(html: string, documentUrl: string): string | undefined {
  const cleaned = stripIgnoredHtmlBlocks(html)
  const baseRe = /<base\b((?:"[^"]*"|'[^']*'|[^>])*)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = baseRe.exec(cleaned)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    if (!('href' in attrs)) continue
    const rawHref = attrs.href.trim()
    try {
      const resolved = new URL(rawHref, documentUrl)
      if (UNSAFE_BASE_PROTOCOLS.has(resolved.protocol.toLowerCase())) {
        return undefined
      }
      return resolved.toString()
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Parse the `content` attribute of `<meta http-equiv="refresh" content="...">`
 * (or an HTTP `Refresh` header) following WHATWG HTML5 shared declarative refresh steps.
 */
export function parseMetaRefreshContent(content: string, baseUrl: string): MetaRefreshDirective | undefined {
  const trimmed = content.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
  if (!trimmed) return undefined

  const numMatch = /^(\d+(?:\.\d*)?)/.exec(trimmed)
  if (!numMatch) return undefined

  const delaySeconds = Number.parseFloat(numMatch[1]!)
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) return undefined

  let rest = trimmed.slice(numMatch[0].length).replace(/^[\t\n\f\r ]+/, '')
  if (!rest) {
    return { delaySeconds, rawContent: content }
  }

  if (rest[0] === ';' || rest[0] === ',') {
    rest = rest.slice(1).replace(/^[\t\n\f\r ]+/, '')
  } else if (!/^url[\t\n\f\r ]*=/i.test(rest)) {
    return undefined
  }

  if (!rest) {
    return { delaySeconds, rawContent: content }
  }

  const urlPrefix = /^url[\t\n\f\r ]*=[\t\n\f\r ]*/i.exec(rest)
  if (urlPrefix) {
    rest = rest.slice(urlPrefix[0].length)
  }

  let rawUrl = rest
  if (rawUrl.startsWith('"') || rawUrl.startsWith("'")) {
    const quote = rawUrl[0]!
    const closingIdx = rawUrl.indexOf(quote, 1)
    rawUrl = closingIdx >= 0 ? rawUrl.slice(1, closingIdx) : rawUrl.slice(1)
  }

  rawUrl = rawUrl.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
  if (!rawUrl) {
    return { delaySeconds, rawContent: content }
  }

  try {
    const resolved = new URL(rawUrl, baseUrl)
    if (!ALLOWED_REFRESH_PROTOCOLS.has(resolved.protocol.toLowerCase())) {
      return undefined
    }
    return {
      delaySeconds,
      url: resolved.toString(),
      rawContent: content,
    }
  } catch {
    return undefined
  }
}

/**
 * Extract the first valid `<meta http-equiv="refresh" content="...">` directive from HTML.
 */
export function extractMetaRefresh(html: string, baseUrl: string): MetaRefreshDirective | undefined {
  const cleaned = stripIgnoredHtmlBlocks(html)
  const metaRe = /<meta\b((?:"[^"]*"|'[^']*'|[^>])*)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(cleaned)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    if ((attrs['http-equiv'] ?? '').trim().toLowerCase() !== 'refresh') continue
    if (!('content' in attrs)) continue
    const parsed = parseMetaRefreshContent(attrs.content, baseUrl)
    if (parsed) return parsed
  }
  return undefined
}

export interface ParsedDoc {
  title: string
  baseUrl?: string
  metaRefresh?: MetaRefreshDirective
  blocks: Array<ContentBlock & { selector?: string }>
  elements: ElementDescriptor[]
  frames?: FrameSummary[]
  text: string
  forms: Map<string, { action: string; method: string; fieldSelectors: string[] }>
}

export function parseHtmlDocument(html: string, baseUrl: string, depth = 0): ParsedDoc {
  // Remove scripts, styles, comments, and inline SVG before scanning
  const cleaned = stripIgnoredHtmlBlocks(html)
  const documentUrl = baseUrl
  const resolvedBaseHref = extractBaseHref(cleaned, documentUrl)
  const effectiveBaseUrl = resolvedBaseHref ?? documentUrl
  const metaRefresh = extractMetaRefresh(cleaned, effectiveBaseUrl)

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned)
  const title = titleMatch ? stripTags(titleMatch[1]!) : ''

  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)
  let bodyHtml = bodyMatch ? bodyMatch[1]! : cleaned

  // Extract <iframe ...> tags with quote-aware attribute matching BEFORE main linear scan
  // so `srcdoc="..."` HTML is never double-parsed as top-level elements.
  const extractedIframes: Array<Record<string, string>> = []
  if (depth < 4 && /<iframe\b/i.test(bodyHtml)) {
    const iframeTagRe = /<iframe\b((?:"[^"]*"|'[^']*'|[^>])*)(?:\/>|>[\s\S]*?<\/iframe>)/gi
    bodyHtml = bodyHtml.replace(iframeTagRe, (_match, attrStr: string) => {
      extractedIframes.push(parseAttrs(attrStr ?? ''))
      return ''
    })
  }

  // Extract explicit `<label for="...">` associations AND implicit `<label><input .../></label>` spans.
  // Per HTML5 (4.10.4):
  // - If `for` is present and non-empty, the label associates explicitly with the element having that `id`.
  // - Otherwise, the label associates implicitly with its first labelable descendant (`<input>` except
  //   `type="hidden"`, `<textarea>`, `<select>`, `<button>`).
  const labelsByFor = new Map<string, string>()
  const implicitLabelSpans: ImplicitLabelSpan[] = []
  const labelRe = /<label\b((?:"[^"]*"|'[^']*'|[^>])*)>([\s\S]*?)<\/label>/gi
  let lm: RegExpExecArray | null
  while ((lm = labelRe.exec(bodyHtml)) !== null) {
    const attrs = parseAttrs(lm[1] ?? '')
    const text = extractLabelText(lm[2] ?? '')
    if (!text) continue
    const forId = attrs.for?.trim()
    if (forId) {
      const existing = labelsByFor.get(forId)
      labelsByFor.set(forId, existing && existing !== text ? `${existing} ${text}` : text)
    } else {
      implicitLabelSpans.push({
        start: lm.index,
        end: lm.index + lm[0].length,
        text,
        consumed: false,
      })
    }
  }

  const blocks: ContentBlock[] = []
  const elements: ElementDescriptor[] = []
  const forms = new Map<string, { action: string; method: string; fieldSelectors: string[]; title?: string }>()
  const usedSelectors = new Set<string>()
  let elIndex = 0
  let currentFormId = ''

  const claimSelector = (primary: string, fallbackTag: string, attrs?: Record<string, string>): string => {
    if (!usedSelectors.has(primary)) {
      usedSelectors.add(primary)
      return primary
    }
    if (attrs?.name && attrs.value) {
      const byValue = `${fallbackTag}[name="${attrs.name}"][value="${attrs.value}"]`
      if (!usedSelectors.has(byValue)) {
        usedSelectors.add(byValue)
        return byValue
      }
    }
    const disambiguated = `${fallbackTag}:nth-of-type(${++elIndex})`
    usedSelectors.add(disambiguated)
    return disambiguated
  }

  const pushBlock = (block: ContentBlock) => {
    if (currentFormId) {
      const formMeta = forms.get(currentFormId)
      blocks.push({
        ...block,
        formId: currentFormId,
        ...(formMeta?.title ? { formTitle: formMeta.title } : {}),
      })
    } else {
      blocks.push(block)
    }
  }

  // Better linear scan: handle paired and void tags cleanly
  const linearRe =
    /<form\b([^>]*)>|<\/form>|<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\2>|<p\b([^>]*)>([\s\S]*?)<\/p>|<a\b([^>]*)>([\s\S]*?)<\/a>|<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*)\/?>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>|<select\b([^>]*)>([\s\S]*?)<\/select>|<li\b([^>]*)>([\s\S]*?)<\/li>|<pre\b([^>]*)>([\s\S]*?)<\/pre>|<tr\b([^>]*)>([\s\S]*?)<\/tr>|<img\b([^>]*)\/?>|<hr\b[^>]*\/?>|<legend\b[^>]*>([\s\S]*?)<\/legend>|<canvas\b([^>]*)>([\s\S]*?)<\/canvas>|<canvas\b([^>]*)\/?>/gi

  let m: RegExpExecArray | null
  while ((m = linearRe.exec(bodyHtml)) !== null) {
    const full = m[0]

    if (/^<form\b/i.test(full)) {
      const attrs = parseAttrs(m[1] ?? '')
      currentFormId = `form-${forms.size + 1}`
      const formTitle =
        attrs['aria-label']?.trim() ||
        attrs.title?.trim() ||
        humanizeFormName(attrs.name || attrs.id)
      forms.set(currentFormId, {
        action: attrs.action?.trim() ? (resolveHref(attrs.action.trim(), effectiveBaseUrl) ?? documentUrl) : documentUrl,
        method: (attrs.method ?? 'GET').toUpperCase(),
        fieldSelectors: [],
        title: formTitle,
      })
      continue
    }
    if (/^<\/form>/i.test(full)) {
      currentFormId = ''
      continue
    }

    if (m[23] !== undefined) {
      // <legend> inside a form sets the form container title if not already explicitly labeled
      const legendText = stripTags(m[23])
      if (currentFormId && legendText) {
        const formMeta = forms.get(currentFormId)
        if (formMeta && !formMeta.title) {
          formMeta.title = legendText
        }
      }
      continue
    }

    if (m[2]) {
      // Heading h1..h6
      const level = Number(m[2].slice(1))
      const text = stripTags(m[4] ?? '')
      if (text) pushBlock({ kind: 'heading', level, text, tag: m[2].toLowerCase() })
      continue
    }

    if (m[6] !== undefined) {
      // Paragraph <p>: if it wraps visible form controls (e.g. `<p><label>Email <input .../></label></p>`),
      // descend into its inner HTML so controls and implicit <label> spans are parsed at their real offsets.
      const inner = m[6]
      if (containsVisibleFormControl(inner)) {
        const openTagLen = full.length - inner.length - 4 // '</p>'.length
        linearRe.lastIndex = m.index + Math.max(1, openTagLen)
        continue
      }
      // Otherwise capture inline <a> links in place so they render inline as [eN: link text]
      const inlineLinks: InlineLink[] = []
      const innerLinkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
      let textParts = ''
      let lastIdx = 0
      let alm: RegExpExecArray | null
      while ((alm = innerLinkRe.exec(inner)) !== null) {
        const beforeRaw = inner.slice(lastIdx, alm.index)
        const beforeClean = stripTags(beforeRaw)
        if (beforeClean) {
          if (textParts && !/\s$/.test(textParts) && !/^[.,;:!?)}\]]/.test(beforeClean)) {
            if (/^\s/.test(beforeRaw) || (lastIdx > 0 && /\s$/.test(inner.slice(0, lastIdx)))) {
              textParts += ' '
            }
          }
          textParts += beforeClean
        }
        const hadSpaceBeforeLink = /\s$/.test(beforeRaw)
        const attrs = parseAttrs(alm[1] ?? '')
        const lText = stripTags(alm[2] ?? '') || attrs['aria-label'] || attrs.href || ''
        if (lText) {
          const selector = attrs.id ? `#${attrs.id}` : `a:nth-of-type(${++elIndex})`
          const href = resolveHref(attrs.href, effectiveBaseUrl)
          const el: ElementDescriptor = {
            selector,
            tag: 'a',
            type: 'link',
            id: attrs.id,
            role: attrs.role || 'link',
            text: lText,
            ariaLabel: attrs['aria-label'],
            href,
          }
          elements.push(el)
          if (textParts && (hadSpaceBeforeLink || !/[(\[{'"\/-]$/.test(textParts))) {
            textParts += ' '
          }
          const start = textParts.length
          textParts += lText
          const end = textParts.length
          inlineLinks.push({ text: lText, href, selector, start, end })
        }
        lastIdx = alm.index + alm[0].length
      }
      const tailRaw = inner.slice(lastIdx)
      const tailClean = stripTags(tailRaw)
      if (tailClean) {
        if (textParts && (/^\s/.test(tailRaw) || (!/^[.,;:!?)}\]]/.test(tailClean) && !/\s$/.test(textParts)))) {
          textParts += ' '
        }
        textParts += tailClean
      }
      const text = textParts.trim() || stripTags(inner)
      if (text) {
        pushBlock({
          kind: 'paragraph',
          text,
          tag: 'p',
          ...(inlineLinks.length > 0 ? { links: inlineLinks } : {}),
        })
      }
      continue
    }

    if (m[8] !== undefined) {
      // Anchor <a>
      const attrs = parseAttrs(m[7] ?? '')
      const text = stripTags(m[8]) || attrs['aria-label'] || attrs.href || ''
      if (!text) continue
      const selector = attrs.id ? `#${attrs.id}` : `a:nth-of-type(${++elIndex})`
      const href = resolveHref(attrs.href, effectiveBaseUrl)
      elements.push({
        selector,
        tag: 'a',
        type: 'link',
        id: attrs.id,
        role: attrs.role || 'link',
        text,
        ariaLabel: attrs['aria-label'],
        href,
      })
      pushBlock({ kind: 'link', text, href, tag: 'a' })
      continue
    }

    if (m[10] !== undefined) {
      // <button>
      const attrs = parseAttrs(m[9] ?? '')
      const explicitLabel = attrs.id ? labelsByFor.get(attrs.id) : undefined
      const implicitLabel = resolveImplicitLabel(m.index, implicitLabelSpans)
      const associatedLabel = explicitLabel || implicitLabel
      const text = stripTags(m[10]) || attrs['aria-label'] || associatedLabel || attrs.value || 'Button'
      const type = (attrs.type || 'submit').toLowerCase()
      const selector = claimSelector(
        attrs.id ? `#${attrs.id}` : `button:nth-of-type(${++elIndex})`,
        'button',
        attrs,
      )
      const formAction = currentFormId ? forms.get(currentFormId)?.action : undefined
      elements.push({
        selector,
        tag: 'button',
        type,
        id: attrs.id,
        name: attrs.name,
        role: attrs.role || 'button',
        text,
        ...(associatedLabel ? { label: associatedLabel } : {}),
        ariaLabel: attrs['aria-label'],
        disabled: 'disabled' in attrs,
        defaultSubmit: type === 'submit' && Boolean(currentFormId),
        formAction,
      })
      pushBlock({ kind: 'button', text, tag: 'button' })
      if (currentFormId) forms.get(currentFormId)?.fieldSelectors.push(selector)
      continue
    }

    if (m[11] !== undefined) {
      // <input>
      const attrs = parseAttrs(m[11])
      const type = (attrs.type || 'text').toLowerCase()
      if (type === 'hidden') continue
      const selector = claimSelector(
        attrs.id
          ? `#${attrs.id}`
          : attrs.name
            ? `input[name="${attrs.name}"]`
            : `input:nth-of-type(${++elIndex})`,
        'input',
        attrs,
      )
      const explicitLabel = attrs.id ? labelsByFor.get(attrs.id) : undefined
      const implicitLabel = resolveImplicitLabel(m.index, implicitLabelSpans)
      const label = explicitLabel || implicitLabel || attrs['aria-label'] || attrs.placeholder || attrs.name || type
      const isBtn = type === 'submit' || type === 'button' || type === 'reset'
      const isPassword = type === 'password'
      const value = isPassword ? '' : (attrs.value ?? '')
      const formAction = currentFormId ? forms.get(currentFormId)?.action : undefined
      elements.push({
        selector,
        tag: 'input',
        type,
        id: attrs.id,
        name: attrs.name,
        role: attrs.role || (isBtn ? 'button' : 'textbox'),
        text: isBtn ? (attrs.value || label) : label,
        label,
        ariaLabel: attrs['aria-label'],
        placeholder: attrs.placeholder,
        autocomplete: attrs.autocomplete,
        value,
        valueRedacted: isPassword,
        disabled: 'disabled' in attrs,
        readOnly: 'readonly' in attrs,
        editable: !isBtn && type !== 'checkbox' && type !== 'radio' && type !== 'file',
        checked: 'checked' in attrs,
        defaultSubmit: type === 'submit',
        formAction,
      })
      if (isBtn) {
        pushBlock({ kind: 'button', text: attrs.value || label, tag: 'input' })
      } else {
        pushBlock({
          kind: 'input',
          text: label,
          placeholder: attrs.placeholder,
          value: isPassword ? '********' : value,
          checked: 'checked' in attrs,
          tag: type === 'checkbox' || type === 'radio' ? type : 'input',
        })
      }
      if (currentFormId) forms.get(currentFormId)?.fieldSelectors.push(selector)
      continue
    }

    if (m[13] !== undefined) {
      // <textarea>
      const attrs = parseAttrs(m[12] ?? '')
      const selector = claimSelector(
        attrs.id
          ? `#${attrs.id}`
          : attrs.name
            ? `textarea[name="${attrs.name}"]`
            : `textarea:nth-of-type(${++elIndex})`,
        'textarea',
        attrs,
      )
      const explicitLabel = attrs.id ? labelsByFor.get(attrs.id) : undefined
      const implicitLabel = resolveImplicitLabel(m.index, implicitLabelSpans)
      const label = explicitLabel || implicitLabel || attrs['aria-label'] || attrs.placeholder || attrs.name || 'textarea'
      const value = decodeEntities(m[13]).trim()
      elements.push({
        selector,
        tag: 'textarea',
        type: 'textarea',
        id: attrs.id,
        name: attrs.name,
        role: 'textbox',
        text: label,
        label,
        ariaLabel: attrs['aria-label'],
        placeholder: attrs.placeholder,
        value,
        disabled: 'disabled' in attrs,
        readOnly: 'readonly' in attrs,
        editable: true,
      })
      pushBlock({ kind: 'input', text: label, placeholder: attrs.placeholder, value, tag: 'textarea' })
      if (currentFormId) forms.get(currentFormId)?.fieldSelectors.push(selector)
      continue
    }

    if (m[15] !== undefined) {
      // <select>
      const attrs = parseAttrs(m[14] ?? '')
      const selector = claimSelector(
        attrs.id
          ? `#${attrs.id}`
          : attrs.name
            ? `select[name="${attrs.name}"]`
            : `select:nth-of-type(${++elIndex})`,
        'select',
        attrs,
      )
      const explicitLabel = attrs.id ? labelsByFor.get(attrs.id) : undefined
      const implicitLabel = resolveImplicitLabel(m.index, implicitLabelSpans)
      const label = explicitLabel || implicitLabel || attrs['aria-label'] || attrs.name || 'select'
      const options: Array<{ value: string; label: string; selected?: boolean }> = []
      const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
      let om: RegExpExecArray | null
      while ((om = optRe.exec(m[15])) !== null) {
        const oAttrs = parseAttrs(om[1] ?? '')
        const oLabel = stripTags(om[2] ?? '')
        options.push({
          value: oAttrs.value ?? oLabel,
          label: oLabel,
          selected: 'selected' in oAttrs,
        })
      }
      const selected = options.find((o) => o.selected) ?? options[0]
      elements.push({
        selector,
        tag: 'select',
        type: 'select',
        id: attrs.id,
        name: attrs.name,
        role: 'combobox',
        text: label,
        label,
        ariaLabel: attrs['aria-label'],
        value: selected?.label ?? selected?.value ?? '',
        options,
      })
      pushBlock({ kind: 'select', text: label, value: selected?.label ?? selected?.value ?? '', tag: 'select' })
      if (currentFormId) forms.get(currentFormId)?.fieldSelectors.push(selector)
      continue
    }

    if (m[17] !== undefined) {
      // <li>: descend if it wraps visible form controls (e.g. `<li><label><input type="radio"> Plan</label></li>`)
      const inner = m[17]
      if (containsVisibleFormControl(inner)) {
        const openTagLen = full.length - inner.length - 5 // '</li>'.length
        linearRe.lastIndex = m.index + Math.max(1, openTagLen)
        continue
      }
      const text = stripTags(inner)
      if (text) pushBlock({ kind: 'list-item', text, tag: 'li' })
      continue
    }

    if (m[19] !== undefined) {
      // <pre>
      const text = decodeEntities(m[19].replace(/<[^>]+>/g, '')).trim()
      if (text) pushBlock({ kind: 'code', text, tag: 'pre' })
      continue
    }

    if (m[21] !== undefined) {
      // <tr>
      const cells: string[] = []
      let thCount = 0
      const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cm: RegExpExecArray | null
      while ((cm = cellRe.exec(m[21])) !== null) {
        if ((cm[1] ?? '').toLowerCase() === 'th') thCount++
        cells.push(stripTags(cm[2] ?? ''))
      }
      if (cells.length > 0) {
        const isHeader = thCount > 0 && thCount === cells.length
        pushBlock({ kind: 'table-row', text: cells.join(' | '), cells, tag: 'tr', isHeader: isHeader || undefined })
      }
      continue
    }

    if (m[22] !== undefined) {
      // <img>
      const attrs = parseAttrs(m[22])
      const alt = attrs.alt || attrs.title || attrs.src || 'image'
      const src = resolveHref(attrs.src, effectiveBaseUrl)
      const naturalWidth = parsePositiveDim(attrs.width)
      const naturalHeight = parsePositiveDim(attrs.height)
      pushBlock({
        kind: 'image',
        text: alt,
        alt,
        ...(src ? { src } : {}),
        ...(naturalWidth ? { naturalWidth } : {}),
        ...(naturalHeight ? { naturalHeight } : {}),
        tag: 'img',
      })
      continue
    }

    if (m[24] !== undefined || m[26] !== undefined) {
      // <canvas>
      const attrs = parseAttrs(m[24] ?? m[26] ?? '')
      const fallbackText = m[25] ? stripTags(m[25]) : ''
      const label = attrs['aria-label'] || attrs.title || fallbackText || attrs.id || 'canvas'
      const naturalWidth = parsePositiveDim(attrs.width)
      const naturalHeight = parsePositiveDim(attrs.height)
      pushBlock({
        kind: 'canvas',
        text: label,
        alt: label,
        ...(naturalWidth ? { naturalWidth } : {}),
        ...(naturalHeight ? { naturalHeight } : {}),
        tag: 'canvas',
      })
      continue
    }

    if (/^<hr\b/i.test(full)) {
      pushBlock({ kind: 'hr', text: '---', tag: 'hr' })
    }
  }

  // Back-fill formTitle on any blocks whose form discovered its title via <legend> after opening
  for (const b of blocks) {
    if (b.formId && !b.formTitle) {
      const titleFromForm = forms.get(b.formId)?.title
      if (titleFromForm) b.formTitle = titleFromForm
    }
  }

  const text = blocks
    .map((b) => b.text)
    .filter(Boolean)
    .join('\n')

  if (depth < 4 && extractedIframes.length > 0) {
    const childInputs: ChildFrameSnapshotInput[] = []
    let iframeCount = 0
    for (const attrs of extractedIframes) {
      if (childInputs.length >= 10) break
      iframeCount += 1
      if (!attrs.srcdoc) continue
      const frameSeg = attrs.id
        ? `#${attrs.id}`
        : attrs.name
          ? `iframe[name="${attrs.name}"]`
          : `iframe:nth-of-type(${iframeCount})`
      const childDoc = parseHtmlDocument(attrs.srcdoc, effectiveBaseUrl, depth + 1)
      if (childDoc.elements.length === 0 && childDoc.blocks.length === 0 && !childDoc.text.trim()) {
        continue
      }
      const frameId = `lite-frame-${depth + 1}-${iframeCount}`
      // Merge child forms with prefixed fieldSelectors so form submit works in Lite mode
      for (const [fId, fMeta] of childDoc.forms) {
        forms.set(`f${iframeCount}-${fId}`, {
          action: fMeta.action,
          method: fMeta.method,
          fieldSelectors: fMeta.fieldSelectors.map((s) => prefixFrameSelector([frameSeg], s)),
        })
      }
      childInputs.push({
        frameId,
        url: 'about:srcdoc',
        name: attrs.name || undefined,
        title: attrs.title || attrs['aria-label'] || childDoc.title || undefined,
        selectorChain: [frameSeg],
        offsetX: 0,
        offsetY: 0,
        crossOrigin: false,
        snapshot: {
          url: 'about:srcdoc',
          title: childDoc.title,
          blocks: childDoc.blocks,
          elements: childDoc.elements,
          text: childDoc.text,
        },
      })
    }

    if (childInputs.length > 0) {
      const flattened = flattenFrameSnapshots(
        {
          url: baseUrl,
          title,
          viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
          blocks,
          elements,
          text,
        },
        childInputs,
      )
      return {
        title,
        ...(resolvedBaseHref ? { baseUrl: resolvedBaseHref } : {}),
        ...(metaRefresh ? { metaRefresh } : {}),
        blocks: flattened.blocks,
        elements: flattened.elements,
        frames: flattened.frames,
        text: flattened.text,
        forms,
      }
    }
  }

  return {
    title,
    ...(resolvedBaseHref ? { baseUrl: resolvedBaseHref } : {}),
    ...(metaRefresh ? { metaRefresh } : {}),
    blocks,
    elements,
    text,
    forms,
  }
}

class LiteTab implements TabDriver {
  readonly id: number
  readonly engine = 'lite' as const
  private url = 'about:blank'
  private title = 'New Tab'
  private loading = false
  private epoch = 0
  private scrollY = 0
  private rawHtml = ''
  private doc: ParsedDoc = { title: 'New Tab', blocks: [], elements: [], text: '', forms: new Map() }
  private historyStack: string[] = []
  private historyIndex = -1
  private consoleLogs: ConsoleEntry[] = []
  private networkRecorder = new NetworkRecorder()
  private cookieJar: CookieJar
  private localStorageByOrigin: Map<string, Map<string, string>>
  private sessionStorageByOrigin = new Map<string, Map<string, string>>()
  private emulation: EmulationProfile
  private downloads?: DownloadQuarantineManager
  private dialogs?: DialogManager
  private maxMetaRefreshDelaySeconds: number

  constructor(
    id: number,
    cookieJar: CookieJar,
    localStorageByOrigin: Map<string, Map<string, string>>,
    initialEmulation?: EmulationProfile,
    downloads?: DownloadQuarantineManager,
    dialogs?: DialogManager,
    maxMetaRefreshDelaySeconds = 5,
  ) {
    this.id = id
    this.cookieJar = cookieJar
    this.localStorageByOrigin = localStorageByOrigin
    this.emulation = initialEmulation ? cloneEmulationProfile(initialEmulation) : defaultEmulationProfile()
    this.downloads = downloads
    this.dialogs = dialogs
    this.maxMetaRefreshDelaySeconds = maxMetaRefreshDelaySeconds
  }

  getEmulation(): EmulationProfile {
    return cloneEmulationProfile(this.emulation)
  }

  async setEmulation(opts: EmulationOptions, mode?: EmulationUpdateMode): Promise<EmulationProfile> {
    this.emulation = resolveEmulationProfile(opts, this.emulation, mode)
    return cloneEmulationProfile(this.emulation)
  }

  getUrl(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isLoading(): boolean {
    return this.loading
  }

  getEpoch(): number {
    return this.epoch
  }

  private cookieHeaderFor(targetUrl: string): string | undefined {
    return this.cookieJar.getCookieHeader(targetUrl)
  }

  private storeCookies(targetUrl: string, headers: Headers): void {
    this.cookieJar.setFromHeaders(headers, targetUrl)
  }

  private async fetchPage(targetUrl: string, init?: RequestInit, pushHistory = true): Promise<{ url: string; title: string }> {
    if (isTrackerHost(targetUrl)) {
      throw new Error(`Blocked tracker host: ${targetUrl}`)
    }
    this.loading = true
    const started = Date.now()
    const MAX_REDIRECTS = 10
    let currentUrl = targetUrl
    let currentInit: RequestInit = { ...init }
    let requestHeadersMap: Record<string, string> = {}
    let requestBodyStr = serializeRequestInitBody(currentInit.body)

    try {
      let res: Response | null = null
      let preReadBody: string | null = null
      let preParsedDoc: ParsedDoc | null = null

      const buildGetRedirectInit = (prevUrl: string, nextUrl: string, prevInit: RequestInit): RequestInit => {
        const prevOrigin = new URL(prevUrl).origin
        const nextOrigin = new URL(nextUrl).origin
        const nextInit: RequestInit = { ...prevInit, method: 'GET' }
        delete nextInit.body
        if (nextInit.headers) {
          const cleaned = new Headers(nextInit.headers)
          cleaned.delete('cookie')
          cleaned.delete('content-type')
          cleaned.delete('content-length')
          if (prevOrigin !== nextOrigin) {
            cleaned.delete('authorization')
          }
          nextInit.headers = cleaned
        }
        return nextInit
      }

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        preReadBody = null
        preParsedDoc = null
        if (isTrackerHost(currentUrl)) {
          throw new Error(`Blocked tracker host: ${currentUrl}`)
        }
        const hopHeaders = new Headers()
        for (const [k, v] of Object.entries(this.emulation.extraHeaders)) {
          hopHeaders.set(k, v)
        }
        if (currentInit.headers) {
          const initHeaders = new Headers(currentInit.headers)
          initHeaders.forEach((v, k) => hopHeaders.set(k, v))
        }
        if (!hopHeaders.has('user-agent')) {
          hopHeaders.set('user-agent', this.emulation.userAgent)
        }
        if (this.emulation.acceptLanguage && !hopHeaders.has('accept-language')) {
          hopHeaders.set('accept-language', this.emulation.acceptLanguage)
        }
        if (!hopHeaders.has('accept')) {
          hopHeaders.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
        }
        const cookie = this.cookieHeaderFor(currentUrl)
        if (cookie) {
          hopHeaders.set('cookie', cookie)
        } else {
          hopHeaders.delete('cookie')
        }

        requestHeadersMap = normalizeHeadersMap(hopHeaders)
        requestBodyStr = serializeRequestInitBody(currentInit.body)

        res = await fetch(currentUrl, { ...currentInit, headers: hopHeaders, redirect: 'manual' })
        this.storeCookies(currentUrl, res.headers)

        const isRedirect = res.status >= 300 && res.status < 400
        const location = res.headers.get('location')
        if (isRedirect && location) {
          if (hop === MAX_REDIRECTS) {
            throw new Error(`Too many redirects (>${MAX_REDIRECTS}) while fetching ${targetUrl}`)
          }
          const prevOrigin = new URL(currentUrl).origin
          const nextUrl = new URL(location, currentUrl).toString()
          const nextOrigin = new URL(nextUrl).origin

          try {
            await res.body?.cancel()
          } catch {
            // ignore body cancellation errors
          }

          const prevMethod = (currentInit.method ?? 'GET').toUpperCase()
          const nextInit: RequestInit = { ...currentInit }
          if (nextInit.headers) {
            const cleaned = new Headers(nextInit.headers)
            cleaned.delete('cookie')
            if (prevOrigin !== nextOrigin) {
              cleaned.delete('authorization')
            }
            nextInit.headers = cleaned
          }
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && prevMethod === 'POST')) {
            nextInit.method = 'GET'
            delete nextInit.body
            if (nextInit.headers) {
              const cleaned = new Headers(nextInit.headers)
              cleaned.delete('content-type')
              cleaned.delete('content-length')
              nextInit.headers = cleaned
            }
          }
          currentUrl = nextUrl
          currentInit = nextInit
          continue
        }

        // Check HTTP Refresh header (shared declarative refresh semantics)
        const refreshHeader = res.headers.get('refresh')
        if (refreshHeader && this.maxMetaRefreshDelaySeconds >= 0) {
          const headerRefresh = parseMetaRefreshContent(refreshHeader, currentUrl)
          if (
            headerRefresh?.url &&
            headerRefresh.delaySeconds <= this.maxMetaRefreshDelaySeconds &&
            headerRefresh.url !== currentUrl
          ) {
            if (hop === MAX_REDIRECTS) {
              throw new Error(`Too many redirects (>${MAX_REDIRECTS}) while fetching ${targetUrl}`)
            }
            try {
              await res.body?.cancel()
            } catch {
              // ignore body cancellation errors
            }
            currentInit = buildGetRedirectInit(currentUrl, headerRefresh.url, currentInit)
            currentUrl = headerRefresh.url
            continue
          }
        }

        // Check HTML <meta http-equiv="refresh"> for non-download HTML responses
        const hopContentType = res.headers.get('content-type') ?? ''
        const hopContentDisp = res.headers.get('content-disposition')
        const isDownload = Boolean(this.downloads && isDownloadResponse(hopContentDisp, hopContentType))
        const isPlainOrJson = hopContentType.includes('application/json') || hopContentType.includes('text/plain')
        if (!isDownload && !isPlainOrJson) {
          preReadBody = await res.text()
          preParsedDoc = parseHtmlDocument(preReadBody, currentUrl)
          const mr = preParsedDoc.metaRefresh
          if (
            this.maxMetaRefreshDelaySeconds >= 0 &&
            mr?.url &&
            mr.delaySeconds <= this.maxMetaRefreshDelaySeconds &&
            mr.url !== currentUrl
          ) {
            if (hop === MAX_REDIRECTS) {
              throw new Error(`Too many redirects (>${MAX_REDIRECTS}) while fetching ${targetUrl}`)
            }
            currentInit = buildGetRedirectInit(currentUrl, mr.url, currentInit)
            currentUrl = mr.url
            continue
          }
        }

        break
      }

      if (!res) {
        throw new Error(`No response received while fetching ${targetUrl}`)
      }
      const finalUrl = currentUrl
      const contentType = res.headers.get('content-type') ?? ''
      const contentDisposition = res.headers.get('content-disposition')
      const responseHeadersMap = normalizeHeadersMap(res.headers)
      const mimeType = contentType.split(';')[0]?.trim() || undefined

      if (this.downloads && isDownloadResponse(contentDisposition, contentType)) {
        const data = Buffer.from(await res.arrayBuffer())
        const parsedDisp = parseContentDispositionFilename(contentDisposition)
        const entry = this.downloads.recordDirectBuffer({
          tabId: this.id,
          url: finalUrl,
          suggestedFilename: parsedDisp.filename,
          mimeType,
          data,
        })
        this.networkRecorder.record({
          url: finalUrl,
          method: init?.method ?? 'GET',
          status: res.status,
          statusText: res.statusText || undefined,
          ok: res.ok && !entry.blocked,
          resourceType: 'download',
          mimeType,
          encodedDataLength: data.byteLength,
          durationMs: Date.now() - started,
          ts: Date.now(),
          ...(entry.blocked ? { blocked: true, blockedReason: entry.blockedReason } : {}),
          requestHeaders: requestHeadersMap,
          responseHeaders: responseHeadersMap,
          requestBody: requestBodyStr,
          cachedResponseBody: { body: data.toString('base64'), base64Encoded: true },
        })
        const summary = entry.blocked
          ? `Download blocked (${entry.blockedReason ?? 'policy'}): ${entry.suggestedFilename}`
          : `Download quarantined (${entry.bytesReceived} bytes): ${entry.suggestedFilename} -> ${entry.quarantinePath ?? ''}`
        this.rawHtml = ''
        this.doc = {
          title: entry.blocked ? `Blocked Download: ${entry.suggestedFilename}` : `Quarantined Download: ${entry.suggestedFilename}`,
          blocks: [
            { kind: 'heading', level: 1, text: entry.blocked ? 'Download Blocked' : 'Download Quarantined', tag: 'h1' },
            { kind: 'paragraph', text: summary, tag: 'p' },
          ],
          elements: [],
          text: summary,
          forms: new Map(),
        }
        this.url = finalUrl
        this.title = this.doc.title
        this.epoch += 1
        this.scrollY = 0
        return { url: this.url, title: this.title }
      }

      const body = preReadBody ?? (await res.text())
      this.networkRecorder.record({
        url: finalUrl,
        method: currentInit.method ?? init?.method ?? 'GET',
        status: res.status,
        statusText: res.statusText || undefined,
        ok: res.ok,
        resourceType: contentType.includes('application/json') ? 'fetch' : 'document',
        mimeType,
        encodedDataLength: Buffer.byteLength(body, 'utf8'),
        durationMs: Date.now() - started,
        ts: Date.now(),
        requestHeaders: requestHeadersMap,
        responseHeaders: responseHeadersMap,
        requestBody: requestBodyStr,
        cachedResponseBody: { body, base64Encoded: false },
      })

      this.rawHtml = body
      if (contentType.includes('application/json') || contentType.includes('text/plain')) {
        const title = new URL(finalUrl).pathname || finalUrl
        this.doc = {
          title,
          blocks: [{ kind: 'code', text: body.slice(0, 16000), tag: 'pre' }],
          elements: [],
          text: body.slice(0, 16000),
          forms: new Map(),
        }
      } else {
        this.doc = preParsedDoc ?? parseHtmlDocument(body, finalUrl)
      }

      this.url = finalUrl
      this.title = this.doc.title || finalUrl
      this.epoch += 1
      this.scrollY = 0
      if (pushHistory) {
        this.historyStack = this.historyStack.slice(0, this.historyIndex + 1)
        this.historyStack.push(finalUrl)
        this.historyIndex = this.historyStack.length - 1
      }
      return { url: this.url, title: this.title }
    } catch (err) {
      this.networkRecorder.record({
        url: targetUrl,
        method: init?.method ?? 'GET',
        ok: false,
        durationMs: Date.now() - started,
        ts: Date.now(),
        error: String((err as Error)?.message ?? err),
        requestHeaders: requestHeadersMap,
        requestBody: requestBodyStr,
      })
      throw err
    } finally {
      this.loading = false
    }
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    return this.fetchPage(url, undefined, true)
  }

  async history(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }> {
    if (direction === 'reload') {
      if (!this.url || this.url === 'about:blank') return { url: this.url, title: this.title }
      return this.fetchPage(this.url, undefined, false)
    }
    if (direction === 'back') {
      if (this.historyIndex <= 0) return { url: this.url, title: this.title }
      this.historyIndex -= 1
      return this.fetchPage(this.historyStack[this.historyIndex]!, undefined, false)
    }
    if (this.historyIndex >= this.historyStack.length - 1) return { url: this.url, title: this.title }
    this.historyIndex += 1
    return this.fetchPage(this.historyStack[this.historyIndex]!, undefined, false)
  }

  async snapshot(): Promise<PageSnapshot> {
    return {
      tabId: this.id,
      url: this.url,
      title: this.title,
      epoch: this.epoch,
      viewport: {
        width: this.emulation.viewport.width,
        height: this.emulation.viewport.height,
        scrollX: 0,
        scrollY: this.scrollY,
        scrollHeight: Math.max(this.emulation.viewport.height, this.doc.blocks.length * 40),
      },
      blocks: this.doc.blocks.map((b) => ({ ...b })),
      elements: this.doc.elements.map((e) => ({ ...e })),
      ...(this.doc.frames ? { frames: this.doc.frames.map((f) => ({ ...f })) } : {}),
      text: this.doc.text,
      capturedAt: Date.now(),
    }
  }

  async click(selector: string): Promise<{ ok: boolean; note?: string }> {
    const el = this.doc.elements.find((e) => e.selector === selector)
    if (!el) return { ok: false, note: `element ${selector} not found` }

    if (el.tag === 'a' && el.href) {
      await this.navigate(el.href)
      return { ok: true, note: `navigated to ${this.url}` }
    }
    if (el.tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      el.checked = !el.checked
      this.syncBlockForElement(el)
      return { ok: true, note: `checked=${el.checked}` }
    }
    // Check if button/submit belongs to a form
    for (const form of this.doc.forms.values()) {
      if (form.fieldSelectors.includes(selector) && (el.defaultSubmit || el.tag === 'button')) {
        const params = new URLSearchParams()
        for (const fSel of form.fieldSelectors) {
          const field = this.doc.elements.find((e) => e.selector === fSel)
          if (field?.name) {
            if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) continue
            params.append(field.name, field.value ?? '')
          }
        }
        if (form.method === 'POST') {
          await this.fetchPage(
            form.action,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: params.toString(),
            },
            true,
          )
        } else {
          const target = new URL(form.action)
          for (const [k, v] of params) target.searchParams.set(k, v)
          await this.fetchPage(target.toString(), undefined, true)
        }
        return { ok: true, note: `submitted form to ${this.url}` }
      }
    }

    return { ok: true, note: 'clicked' }
  }

  private syncBlockForElement(el: ElementDescriptor): void {
    const idx = this.doc.elements.indexOf(el)
    if (idx < 0) return
    const matchingBlock = this.doc.blocks.find(
      (b) => (b.kind === 'input' || b.kind === 'select') && b.text === (el.label || el.text),
    )
    if (matchingBlock) {
      matchingBlock.value = el.valueRedacted ? '********' : el.value
      matchingBlock.checked = el.checked
    }
  }

  async fill(selector: string, text: string, clear = true): Promise<{ ok: boolean; value?: string }> {
    const el = this.doc.elements.find((e) => e.selector === selector)
    if (!el) return { ok: false }
    el.value = clear ? text : `${el.value ?? ''}${text}`
    this.syncBlockForElement(el)
    return { ok: true, value: el.value }
  }

  async select(selector: string, value: string): Promise<{ ok: boolean; value?: string }> {
    const el = this.doc.elements.find((e) => e.selector === selector)
    if (!el || el.tag !== 'select') return { ok: false }
    const opt = el.options?.find(
      (o) => o.value.toLowerCase() === value.toLowerCase() || o.label.toLowerCase() === value.toLowerCase(),
    )
    if (!opt) return { ok: false }
    for (const o of el.options ?? []) o.selected = o === opt
    el.value = opt.label || opt.value
    this.syncBlockForElement(el)
    return { ok: true, value: el.value }
  }

  async press(key: string, selector?: string): Promise<{ ok: boolean; normalized?: string; modifiers?: number; error?: string }> {
    let chord
    try {
      chord = parseKeyChord(key)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const mainKey = chord.mainKey?.key
    if (mainKey === 'Enter' && chord.modifiersBitmask === 0 && selector) {
      for (const form of this.doc.forms.values()) {
        if (form.fieldSelectors.includes(selector)) {
          const submitBtn = form.fieldSelectors
            .map((s) => this.doc.elements.find((e) => e.selector === s))
            .find((e) => e && (e.defaultSubmit || e.tag === 'button'))
          if (submitBtn) {
            await this.click(submitBtn.selector)
            return { ok: true, normalized: chord.normalized, modifiers: chord.modifiersBitmask }
          }
        }
      }
    }
    if (chord.modifiersBitmask === 0 && !selector) {
      if (mainKey === 'PageDown' || mainKey === 'ArrowDown') {
        await this.scroll('down', mainKey === 'PageDown' ? 400 : 80)
      } else if (mainKey === 'PageUp' || mainKey === 'ArrowUp') {
        await this.scroll('up', mainKey === 'PageUp' ? 400 : 80)
      } else if (mainKey === 'Home') {
        await this.scroll('top')
      } else if (mainKey === 'End') {
        await this.scroll('bottom')
      }
    }
    return { ok: true, normalized: chord.normalized, modifiers: chord.modifiersBitmask }
  }

  async hover(_selector: string): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount = 400) {
    const maxScroll = Math.max(0, this.doc.blocks.length * 40 - 800)
    if (direction === 'top') this.scrollY = 0
    else if (direction === 'bottom') this.scrollY = maxScroll
    else if (direction === 'up') this.scrollY = Math.max(0, this.scrollY - amount)
    else if (direction === 'down') this.scrollY = Math.min(maxScroll, this.scrollY + amount)
    return { scrollX: 0, scrollY: this.scrollY }
  }

  async waitForSettle(options: SettleOptions = {}): Promise<SettleResult> {
    return waitForPageSettle(
      {
        checkNetwork: () => ({
          idle: !this.loading,
          inflightCount: this.loading ? 1 : 0,
        }),
        checkDom: () => ({
          quiet: !this.loading,
          mutationCount: 0,
          quietForMs: this.loading ? 0 : options.domQuietMs ?? 200,
          readyState: this.loading ? 'loading' : 'complete',
        }),
      },
      options,
    )
  }

  async waitFor(options: WaitConditionOptions): Promise<WaitResult> {
    const hasCondition = Boolean(options.text || options.selector || options.url)
    const wantSettle = Boolean(options.settle)

    if (!hasCondition && !wantSettle) {
      const ms = Math.max(0, Math.min(30000, Number(options.ms ?? 300)))
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, waitedMs: ms }
    }

    const timeoutMs = options.timeout !== undefined ? Number(options.timeout) : 5000
    const pollIntervalMs = options.pollIntervalMs !== undefined ? Number(options.pollIntervalMs) : 50

    if (!hasCondition && wantSettle) {
      const settle = await this.waitForSettle({
        timeoutMs,
        networkIdleMs: options.networkIdleMs,
        domQuietMs: options.domQuietMs,
        maxInflightRequests: options.maxInflightRequests,
        pollIntervalMs,
      })
      return {
        ok: settle.ok,
        waitedMs: settle.waitedMs,
        timedOut: settle.timedOut || undefined,
        matched: { settled: settle.settled, currentUrl: this.url },
        settle,
        ...(settle.error ? { error: settle.error } : {}),
      }
    }

    const state: WaitState = options.state ?? 'visible'
    const description = describeWaitCondition({ ...options, state: options.selector ? state : undefined })
    const startedAt = Date.now()

    const condRes = await pollUntil(
      () => {
        const urlOk = options.url ? matchesUrlPattern(this.url, options.url) : true
        const pageText = `${this.doc.text}\n${this.title}\n${extractLitePageText(this.rawHtml)}`
        const textOk = options.text ? matchesText(pageText, options.text) : true
        let selectorOk = true
        if (options.selector) {
          const selRes = checkLiteSelectorState(this.rawHtml, this.doc.elements, options.selector, state)
          if (selRes.error) {
            return { satisfied: false, fatalError: selRes.error }
          }
          selectorOk = selRes.matched
        }
        return {
          satisfied: urlOk && textOk && selectorOk,
          matched: {
            ...(options.text ? { text: textOk } : {}),
            ...(options.selector ? { selector: selectorOk, state } : {}),
            ...(options.url ? { url: urlOk, currentUrl: this.url } : {}),
          },
        }
      },
      { timeoutMs, pollIntervalMs, description },
    )

    if (!condRes.ok || !wantSettle) {
      return condRes
    }

    const remainingTimeout = Math.max(0, timeoutMs - (Date.now() - startedAt))
    const settle = await this.waitForSettle({
      timeoutMs: remainingTimeout,
      networkIdleMs: options.networkIdleMs,
      domQuietMs: options.domQuietMs,
      maxInflightRequests: options.maxInflightRequests,
      pollIntervalMs,
    })
    return {
      ok: settle.ok,
      waitedMs: Date.now() - startedAt,
      timedOut: settle.timedOut || undefined,
      matched: { ...condRes.matched, settled: settle.settled },
      settle,
      ...(settle.error ? { error: settle.error } : {}),
    }
  }

  async evaluate(_expression: string): Promise<unknown> {
    throw new Error('page_eval requires the chromium engine (launch with --engine chromium)')
  }

  async screenshot(): Promise<Buffer | null> {
    return null
  }

  getConsole(opts: { clear?: boolean; level?: string; limit?: number } = {}): ConsoleEntry[] {
    let items = [...this.consoleLogs]
    if (opts.level && opts.level !== 'all') items = items.filter((i) => i.level === opts.level)
    if (opts.clear) this.consoleLogs = []
    return items.slice(-(opts.limit ?? 50))
  }

  getNetwork(opts: NetworkListOptions = {}): NetworkEntry[] {
    return this.networkRecorder.list(opts)
  }

  async getNetworkBody(reqId: string, opts: NetworkBodyInspectionOptions = {}): Promise<NetworkBodyResult> {
    const record = this.networkRecorder.get(reqId)
    if (!record) {
      return {
        ok: false,
        requestId: reqId,
        error: `Network request "${reqId}" not found. Run "network" to list captured request IDs.`,
      }
    }

    let responseBody: string | undefined
    let responseBase64Encoded = false
    let responseBodyUnavailableReason: string | undefined

    if (record.cachedResponseBody) {
      responseBody = record.cachedResponseBody.body
      responseBase64Encoded = record.cachedResponseBody.base64Encoded
    } else if (record.entry.blocked) {
      responseBodyUnavailableReason = `request blocked (${record.entry.blockedReason ?? 'policy'})`
    } else if (record.entry.error) {
      responseBodyUnavailableReason = `request failed (${record.entry.error})`
    } else {
      responseBodyUnavailableReason = 'response body unavailable'
    }

    return buildNetworkBodyResult(
      record,
      {
        requestBody: record.requestBody,
        responseBody,
        responseBase64Encoded,
        responseBodyUnavailableReason,
      },
      opts,
    )
  }

  getDialogs(opts: { type?: DialogType; limit?: number; clear?: boolean } = {}): DialogEntry[] {
    return this.dialogs ? this.dialogs.list({ ...opts, tabId: this.id }) : []
  }

  async getStorage(opts: { area?: StorageArea; keyPrefix?: string } = {}): Promise<OriginStorageSnapshot> {
    const origin = normalizeStorageOrigin(this.url)
    if (!origin) return { origin: '', localStorage: {}, sessionStorage: {} }
    const area = normalizeStorageArea(opts.area)
    const keyPrefix = typeof opts.keyPrefix === 'string' ? opts.keyPrefix : ''

    const readMap = (store?: Map<string, string>): Record<string, string> => {
      if (!store) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of store) {
        if (!keyPrefix || k.startsWith(keyPrefix)) out[k] = v
      }
      return out
    }

    return {
      origin,
      localStorage: area === 'session' ? {} : readMap(this.localStorageByOrigin.get(origin)),
      sessionStorage: area === 'local' ? {} : readMap(this.sessionStorageByOrigin.get(origin)),
    }
  }

  async setStorage(
    data: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> },
    opts: { clearBeforeImport?: boolean } = {},
  ): Promise<{ origin: string; localKeys: number; sessionKeys: number }> {
    const origin = normalizeStorageOrigin(this.url)
    if (!origin) {
      throw new Error('Cannot set web storage on current tab (opaque origin)')
    }
    let localKeys = 0
    let sessionKeys = 0

    if (data.localStorage) {
      const normalized = normalizeStorageMap(data.localStorage)
      let store = this.localStorageByOrigin.get(origin)
      if (!store) {
        store = new Map<string, string>()
        this.localStorageByOrigin.set(origin, store)
      }
      if (opts.clearBeforeImport) store.clear()
      for (const [k, v] of Object.entries(normalized)) {
        store.set(k, v)
        localKeys++
      }
    }

    if (data.sessionStorage) {
      const normalized = normalizeStorageMap(data.sessionStorage)
      let store = this.sessionStorageByOrigin.get(origin)
      if (!store) {
        store = new Map<string, string>()
        this.sessionStorageByOrigin.set(origin, store)
      }
      if (opts.clearBeforeImport) store.clear()
      for (const [k, v] of Object.entries(normalized)) {
        store.set(k, v)
        sessionKeys++
      }
    }

    return { origin, localKeys, sessionKeys }
  }

  async clearStorage(opts: { area?: StorageArea; keys?: string[] } = {}): Promise<{
    origin: string
    removedLocal: number
    removedSession: number
  }> {
    const origin = normalizeStorageOrigin(this.url)
    if (!origin) return { origin: '', removedLocal: 0, removedSession: 0 }
    const area = normalizeStorageArea(opts.area)
    const keys = Array.isArray(opts.keys) && opts.keys.length > 0 ? opts.keys : null

    const clearMap = (store?: Map<string, string>): number => {
      if (!store) return 0
      if (keys) {
        let removed = 0
        for (const k of keys) {
          if (store.delete(k)) removed++
        }
        return removed
      }
      const size = store.size
      store.clear()
      return size
    }

    const removedLocal = area === 'session' ? 0 : clearMap(this.localStorageByOrigin.get(origin))
    const removedSession = area === 'local' ? 0 : clearMap(this.sessionStorageByOrigin.get(origin))
    return { origin, removedLocal, removedSession }
  }

  async close(): Promise<void> {
    this.sessionStorageByOrigin.clear()
  }
}

export interface LiteEngineOptions {
  emulation?: EmulationOptions
  profileDir?: string
  /** Custom path for persistent cookies.json (default: `<profileDir>/cookies.json`). Pass `null` to disable disk persistence. */
  cookieJarPath?: string | null
  /** Whether to persist session cookies (without Expires/Max-Age) to cookies.json. Default: false. */
  persistSessionCookies?: boolean
  downloads?: DownloadPolicyOptions
  dialogs?: DialogPolicyOptions
  /** Maximum delay in seconds for auto-following `<meta http-equiv="refresh">` / HTTP `Refresh` redirects. Default: 5. Set to -1 to disable. */
  maxMetaRefreshDelaySeconds?: number
}

export class LiteBrowserEngine implements BrowserEngine {
  readonly kind = 'lite' as const
  readonly cdpPort = 0
  private nextId = 1
  private cookieJar: CookieJar
  private localStorageByOrigin = new Map<string, Map<string, string>>()
  private defaultEmulation: EmulationProfile
  private downloads: DownloadQuarantineManager
  private dialogs: DialogManager
  private maxMetaRefreshDelaySeconds: number

  constructor(opts: LiteEngineOptions = {}) {
    this.defaultEmulation = resolveEmulationProfile(opts.emulation)
    const cookieJarPath =
      opts.cookieJarPath !== undefined
        ? opts.cookieJarPath
        : opts.profileDir
          ? path.join(opts.profileDir, 'cookies.json')
          : null
    this.cookieJar = new CookieJar({
      filePath: cookieJarPath,
      persistSessionCookies: opts.persistSessionCookies,
    })
    const defaultQuarantineDir = opts.profileDir
      ? path.join(opts.profileDir, 'quarantine')
      : path.join(os.tmpdir(), `troy-advanced-lite-quarantine-${process.pid}`)
    this.downloads = new DownloadQuarantineManager(opts.downloads, defaultQuarantineDir)
    this.dialogs = new DialogManager(opts.dialogs)
    this.maxMetaRefreshDelaySeconds = opts.maxMetaRefreshDelaySeconds ?? 5
  }

  getCookieJar(): CookieJar {
    return this.cookieJar
  }

  getDefaultEmulation(): EmulationProfile {
    return cloneEmulationProfile(this.defaultEmulation)
  }

  setDefaultEmulation(opts: EmulationOptions, mode?: EmulationUpdateMode): EmulationProfile {
    this.defaultEmulation = resolveEmulationProfile(opts, this.defaultEmulation, mode)
    return cloneEmulationProfile(this.defaultEmulation)
  }

  getDownloads(opts?: { status?: DownloadStatus; blockedOnly?: boolean; limit?: number }): DownloadEntry[] {
    return this.downloads.list(opts)
  }

  getDownloadStats(): DownloadStats {
    return this.downloads.getStats()
  }

  setDownloadPolicy(opts: DownloadPolicyOptions): DownloadStats {
    return this.downloads.setPolicy(opts)
  }

  clearDownloads(opts?: { deleteFiles?: boolean }): { cleared: number; removedFiles: number } {
    return this.downloads.clear(opts)
  }

  removeDownload(id: string): { ok: boolean; removedFile: boolean; error?: string } {
    return this.downloads.remove(id)
  }

  onDownloadEvent(fn: (ev: DownloadEvent) => void): () => void {
    return this.downloads.onEvent(fn)
  }

  getDialogs(opts?: { tabId?: number; type?: DialogType; limit?: number; clear?: boolean }): DialogEntry[] {
    return this.dialogs.list(opts)
  }

  getDialogStats(): DialogStats {
    return this.dialogs.getStats()
  }

  setDialogPolicy(opts: DialogPolicyOptions): DialogStats {
    return this.dialogs.setPolicy(opts)
  }

  queueDialogResponse(resp: DialogQueuedResponse): DialogStats {
    return this.dialogs.queueResponse(resp)
  }

  getDialogQueue(): DialogQueuedResponse[] {
    return this.dialogs.getQueue()
  }

  clearDialogQueue(): number {
    return this.dialogs.clearQueue()
  }

  clearDialogs(opts?: { tabId?: number }): number {
    return this.dialogs.clear(opts)
  }

  onDialogEvent(fn: (ev: DialogEvent) => void): () => void {
    return this.dialogs.onEvent(fn)
  }

  async createTab(initialUrl?: string): Promise<TabDriver> {
    const tab = new LiteTab(
      this.nextId++,
      this.cookieJar,
      this.localStorageByOrigin,
      this.defaultEmulation,
      this.downloads,
      this.dialogs,
      this.maxMetaRefreshDelaySeconds,
    )
    if (initialUrl) {
      await tab.navigate(initialUrl)
    }
    return tab
  }

  async exportCookies(opts: CookieExportOptions = {}): Promise<BrowserCookie[]> {
    return this.cookieJar.exportCookies(opts)
  }

  async importCookies(cookies: BrowserCookie[]): Promise<CookieImportResult> {
    return this.cookieJar.importCookies(cookies)
  }

  async clearCookies(opts: { domain?: string } = {}): Promise<number> {
    return this.cookieJar.clear(opts)
  }

  getEngineStorage(opts: { origin?: string; area?: StorageArea; keyPrefix?: string } = {}): OriginStorageSnapshot[] {
    const snapshots: OriginStorageSnapshot[] = []
    for (const [origin, map] of this.localStorageByOrigin) {
      snapshots.push({
        origin,
        localStorage: Object.fromEntries(map.entries()),
        sessionStorage: {},
      })
    }
    return filterStorageSnapshots(snapshots, opts)
  }

  importEngineStorage(
    snapshots: OriginStorageSnapshot[],
    opts: { area?: StorageArea; clearBeforeImport?: boolean } = {},
  ): StorageImportResult {
    const area = normalizeStorageArea(opts.area)
    let importedOrigins = 0
    let localKeys = 0
    let skipped = 0
    const errors: string[] = []

    for (const raw of snapshots) {
      const snap = normalizeOriginStorageSnapshot(raw)
      if (!snap) {
        skipped++
        errors.push(`Invalid storage snapshot skipped: ${String((raw as { origin?: unknown })?.origin ?? '<unknown>')}`)
        continue
      }
      if (area === 'session') continue

      let store = this.localStorageByOrigin.get(snap.origin)
      if (!store) {
        store = new Map<string, string>()
        this.localStorageByOrigin.set(snap.origin, store)
      }
      if (opts.clearBeforeImport) store.clear()
      for (const [k, v] of Object.entries(snap.localStorage)) {
        store.set(k, v)
        localKeys++
      }
      importedOrigins++
    }

    return { importedOrigins, localKeys, sessionKeys: 0, skipped, errors }
  }

  clearEngineStorage(opts: { origin?: string; area?: StorageArea; keys?: string[] } = {}): StorageClearResult {
    const area = normalizeStorageArea(opts.area)
    if (area === 'session') {
      return { removedLocal: 0, removedSession: 0, origins: [] }
    }
    const keys = Array.isArray(opts.keys) && opts.keys.length > 0 ? opts.keys : null
    let removedLocal = 0
    const origins: string[] = []

    for (const [origin, store] of this.localStorageByOrigin) {
      if (opts.origin && !originFilterMatches(origin, opts.origin)) continue
      if (keys) {
        let removedHere = 0
        for (const k of keys) {
          if (store.delete(k)) removedHere++
        }
        if (removedHere > 0) {
          removedLocal += removedHere
          origins.push(origin)
        }
      } else {
        if (store.size > 0) {
          removedLocal += store.size
          origins.push(origin)
        }
        store.clear()
      }
    }

    return { removedLocal, removedSession: 0, origins }
  }

  async close(): Promise<void> {
    this.cookieJar.close()
    this.localStorageByOrigin.clear()
  }
}
