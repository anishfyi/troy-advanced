// Zero-Chrome pure-Node HTML/DOM + CookieJar engine ("lite" engine).
// Runs anywhere Node.js runs — even tiny 512MB EC2 t4g.nano instances, Alpine containers,
// or offline tests without Chromium installed.

import fs from 'node:fs'
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
import { SsrfBlockedError, SsrfGuard, isSsrfBlockedError } from '../agent/ssrf.js'
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
import {
  encodeMultipartFormData,
  encodeTextPlainFormData,
  encodeUrlEncodedFormData,
  guessMimeTypeFromFilename,
  normalizeFormEnctype,
  type FormDataEntry,
  type FormEnctype,
} from './form-encoding.js'
import { decodeHtmlEntities } from './html-entities.js'
import { parseKeyChord } from './keyboard.js'
import { waitForPageSettle } from './settle.js'
import {
  detectStructuredKind,
  parseStructuredDocument,
  type StructuredKind,
} from './structured-view.js'
import {
  buildFeedReaderDocument,
  detectFeedKind,
  discoverFeedsInHtml,
  parseFeedXml,
  type DiscoveredFeed,
  type ParsedFeed,
} from './feed-reader.js'
import {
  detectDocumentKind,
  renderDocumentView,
  type CsvSortDirection,
  type DocumentKind,
} from './document-view.js'
import {
  ResponseCache,
  isCacheableMethod,
  isUnsafeMethod,
  type CacheStatus,
  type ResolvedResponseCachePolicy,
  type ResponseCacheEntry,
  type ResponseCacheHooks,
  type ResponseCacheOptions,
  type ResponseCacheStats,
} from './response-cache.js'
import {
  RobotsDisallowedError,
  RobotsRetryController,
  computeBackoffDelayMs,
  isRetryableMethod,
  isRetryableStatus,
  parseRetryAfterMs,
  type RateLimitOptions,
  type RateLimitStats,
  type ResolvedRateLimitPolicy,
  type ResolvedRetryPolicy,
  type ResolvedRobotsPolicy,
  type RetryPolicyOptions,
  type RobotsDecision,
  type RobotsPolicyOptions,
  type RobotsRetryHooks,
} from './robots-retry.js'
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
    .replace(/<select\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/select>/gi, ' ')
    .replace(/<textarea\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/textarea>/gi, ' ')
    .replace(/<button\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/button>/gi, ' ')
    .replace(/<meter\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/meter>/gi, ' ')
    .replace(/<output\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/output>/gi, ' ')
    .replace(/<progress\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/progress>/gi, ' ')
    .replace(/<input\b(?:"[^"]*"|'[^']*'|[^>"'])*\/?>/gi, ' ')
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

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

function getInteractiveAriaRole(roleAttr: string | undefined): 'button' | 'link' | undefined {
  if (!roleAttr) return undefined
  for (const token of roleAttr.trim().toLowerCase().split(/\s+/)) {
    if (token === 'button' || token === 'link') return token
  }
  return undefined
}

function containsInteractiveAriaRole(innerHtml: string, roles: ReadonlyArray<'button' | 'link'>): boolean {
  if (!/\brole\s*=/i.test(innerHtml)) return false
  const tagRe = /<[a-z][a-z0-9-]*\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(innerHtml)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    const role = getInteractiveAriaRole(attrs.role)
    if (role && roles.includes(role)) return true
  }
  return false
}

function findMatchingCloseTag(
  html: string,
  tagName: string,
  contentStart: number,
): { inner: string; endIndex: number } {
  const lower = tagName.toLowerCase()
  if (VOID_HTML_TAGS.has(lower)) {
    return { inner: '', endIndex: contentStart }
  }
  const tagRe = new RegExp(`<(\\/?)${lower}\\b(?:"[^"]*"|'[^']*'|[^>"'])*(\\/?)>`, 'gi')
  tagRe.lastIndex = contentStart
  let depth = 1
  let tm: RegExpExecArray | null
  while ((tm = tagRe.exec(html)) !== null) {
    const isClose = tm[1] === '/'
    const isSelfClosing = tm[2] === '/'
    if (isClose) {
      depth -= 1
      if (depth === 0) {
        return {
          inner: html.slice(contentStart, tm.index),
          endIndex: tm.index + tm[0].length,
        }
      }
    } else if (!isSelfClosing) {
      depth += 1
    }
  }
  return {
    inner: html.slice(contentStart),
    endIndex: html.length,
  }
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs = Object.create(null) as Record<string, string>
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

const ALLOWED_REFRESH_PROTOCOLS = new Set(['http:', 'https:'])

function stripIgnoredHtmlBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, '')
    .replace(/<svg\b[^>]*\/>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?(?:<\/svg\s*>|$)/gi, '')
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
  const baseRe = /<base\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = baseRe.exec(cleaned)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    if (!('href' in attrs)) continue
    const rawHref = attrs.href.trim()
    try {
      const resolved = new URL(rawHref, documentUrl)
      if (!ALLOWED_REFRESH_PROTOCOLS.has(resolved.protocol.toLowerCase())) {
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
  const metaRe = /<meta\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi
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

export interface LiteHiddenField {
  name: string
  value: string
  disabled?: boolean
}

export type LiteFormFieldRef =
  | { kind: 'element'; selector: string }
  | { kind: 'hidden'; name: string; value: string; disabled?: boolean }

export interface LiteFormMeta {
  action: string
  method: string
  enctype: FormEnctype
  fieldSelectors: string[]
  hiddenFields: LiteHiddenField[]
  fieldOrder?: LiteFormFieldRef[]
  title?: string
  dialogKey?: string
}

export interface LiteParseOptions {
  detailsOpen?: ReadonlyMap<string, boolean>
  dialogOpen?: ReadonlyMap<string, boolean>
}

export interface ParsedDoc {
  title: string
  baseUrl?: string
  metaRefresh?: MetaRefreshDirective
  feeds?: DiscoveredFeed[]
  blocks: Array<ContentBlock & { selector?: string }>
  elements: ElementDescriptor[]
  frames?: FrameSummary[]
  text: string
  forms: Map<string, LiteFormMeta>
  detailsBySummarySelector?: Map<string, string>
}

export function parseHtmlDocument(
  html: string,
  baseUrl: string,
  depth = 0,
  options?: LiteParseOptions,
): ParsedDoc {
  // Remove scripts, styles, comments, and inline SVG before scanning
  const cleaned = stripIgnoredHtmlBlocks(html)
  const documentUrl = baseUrl
  const resolvedBaseHref = extractBaseHref(cleaned, documentUrl)
  const effectiveBaseUrl = resolvedBaseHref ?? documentUrl
  const metaRefresh = extractMetaRefresh(cleaned, effectiveBaseUrl)
  const discoveredFeeds = depth === 0 ? discoverFeedsInHtml(cleaned, effectiveBaseUrl) : []

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned)
  const title = titleMatch ? stripTags(titleMatch[1]!) : ''

  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)
  let bodyHtml = bodyMatch ? bodyMatch[1]! : cleaned

  // Extract <iframe ...> tags with quote-aware attribute matching BEFORE main linear scan
  // so `srcdoc="..."` HTML is never double-parsed as top-level elements.
  const extractedIframes: Array<Record<string, string>> = []
  if (depth < 4 && /<iframe\b/i.test(bodyHtml)) {
    const iframeTagRe = /<iframe\b((?:"[^"]*"|'[^']*'|[^>"'])*)(?:\/>|>[\s\S]*?<\/iframe>)/gi
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
  const labelRe = /<label\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/label>/gi
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

  const blocks: Array<ContentBlock & { selector?: string }> = []
  const elements: ElementDescriptor[] = []
  const forms = new Map<string, LiteFormMeta>()
  const formIdsByHtmlId = new Map<string, string>()
  const detailsBySummarySelector = new Map<string, string>()
  const usedSelectors = new Set<string>()
  let elIndex = 0
  let detailsIndex = 0
  let dialogIndex = 0
  let currentFormId = ''

  interface FieldsetFrame {
    disabled: boolean
    legendSeen: boolean
    inFirstLegend: boolean
  }
  interface DetailsFrame {
    key: string
    open: boolean
    summarySeen: boolean
    hiddenByAncestor: boolean
  }
  interface DialogFrame {
    key: string
    open: boolean
    hiddenByAncestor: boolean
  }

  const fieldsetStack: FieldsetFrame[] = []
  const detailsStack: DetailsFrame[] = []
  const dialogStack: DialogFrame[] = []

  const isHiddenByDialog = (): boolean => dialogStack.some((d) => !d.open)
  const isContentHidden = (): boolean => isHiddenByDialog() || detailsStack.some((d) => !d.open)
  const isDisabledByFieldset = (): boolean => fieldsetStack.some((f) => f.disabled && !f.inFirstLegend)

  const resolveTargetFormId = (formAttr?: string): string => {
    const trimmed = formAttr?.trim()
    if (trimmed) {
      return formIdsByHtmlId.get(trimmed) ?? ''
    }
    return currentFormId
  }

  const recordFormElement = (targetFormId: string, selector: string): void => {
    if (!targetFormId) return
    const formMeta = forms.get(targetFormId)
    if (!formMeta) return
    formMeta.fieldSelectors.push(selector)
    formMeta.fieldOrder?.push({ kind: 'element', selector })
  }

  const recordHiddenInput = (targetFormId: string, attrs: Record<string, string>): void => {
    if (!targetFormId) return
    const formMeta = forms.get(targetFormId)
    if (!formMeta) return
    const name = attrs.name
    if (!name) return
    const disabled = 'disabled' in attrs || isDisabledByFieldset() ? true : undefined
    const hidden: LiteHiddenField = {
      name,
      value: attrs.value ?? '',
      ...(disabled ? { disabled } : {}),
    }
    formMeta.hiddenFields.push(hidden)
    formMeta.fieldOrder?.push({ kind: 'hidden', ...hidden })
  }

  const extractHiddenInputsFromFragment = (fragment: string): void => {
    if (!/<input\b/i.test(fragment)) return
    const hiddenInputRe = /<input\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi
    let hm: RegExpExecArray | null
    while ((hm = hiddenInputRe.exec(fragment)) !== null) {
      const attrs = parseAttrs(hm[1] ?? '')
      if ((attrs.type || 'text').toLowerCase() !== 'hidden') continue
      const targetFormId = resolveTargetFormId(attrs.form)
      if (targetFormId) {
        recordHiddenInput(targetFormId, attrs)
      }
    }
  }

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

  const pushBlock = (block: ContentBlock & { selector?: string }) => {
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

  const emitAriaInteractiveElement = (
    tag: string,
    attrs: Record<string, string>,
    role: 'button' | 'link',
    innerHtml: string,
  ): void => {
    extractHiddenInputsFromFragment(innerHtml)
    const isDisabled = 'disabled' in attrs || attrs['aria-disabled']?.trim().toLowerCase() === 'true'
    if (role === 'link') {
      const rawHref = attrs.href || attrs['data-href']
      const href = resolveHref(rawHref, effectiveBaseUrl)
      const text = attrs['aria-label']?.trim() || stripTags(innerHtml) || attrs.alt?.trim() || attrs.title?.trim() || rawHref || ''
      if (!text) return
      const selector = claimSelector(
        attrs.id ? `#${attrs.id}` : `${tag}[role="link"]:nth-of-type(${++elIndex})`,
        tag,
        attrs,
      )
      elements.push({
        selector,
        tag,
        type: 'link',
        id: attrs.id,
        role: 'link',
        text,
        ariaLabel: attrs['aria-label'],
        ...(isDisabled ? { disabled: true } : {}),
        href,
      })
      pushBlock({ kind: 'link', text, href, tag, selector })
    } else {
      const text = attrs['aria-label']?.trim() || stripTags(innerHtml) || attrs.alt?.trim() || attrs.title?.trim() || 'Button'
      const selector = claimSelector(
        attrs.id ? `#${attrs.id}` : `${tag}[role="button"]:nth-of-type(${++elIndex})`,
        tag,
        attrs,
      )
      elements.push({
        selector,
        tag,
        type: 'button',
        id: attrs.id,
        role: 'button',
        text,
        ariaLabel: attrs['aria-label'],
        ...(isDisabled ? { disabled: true } : {}),
      })
      pushBlock({ kind: 'button', text, tag, selector })
    }
  }

  // Linear scan handling container open/close tags (<form>, <fieldset>, <details>, <dialog>),
  // paired & void HTML elements, and ARIA role="button" / role="link" elements.
  const linearRe =
    /<form\b(?<formAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>|<\/form>|<fieldset\b(?<fieldsetAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>|<\/fieldset>|<\/legend>|<details\b(?<detailsAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>|<\/details>|<summary\b(?<summaryAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<summaryInner>[\s\S]*?)<\/summary>|<dialog\b(?<dialogAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>|<\/dialog>|<(?:(?<hTag>h[1-6]))\b(?<hAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<hInner>[\s\S]*?)<\/\k<hTag>>|<p\b(?<pAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<pInner>[\s\S]*?)<\/p>|<a\b(?<aAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<aInner>[\s\S]*?)<\/a>|<button\b(?<btnAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<btnInner>[\s\S]*?)<\/button>|<input\b(?<inputAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|<textarea\b(?<taAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<taInner>[\s\S]*?)<\/textarea>|<select\b(?<selAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<selInner>[\s\S]*?)<\/select>|<li\b(?<liAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<liInner>[\s\S]*?)<\/li>|<pre\b(?<preAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<preInner>[\s\S]*?)<\/pre>|<tr\b(?<trAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<trInner>[\s\S]*?)<\/tr>|<img\b(?<imgAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|<hr\b(?:"[^"]*"|'[^']*'|[^>"'])*\/?>|<legend\b(?<legendAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<legendInner>[\s\S]*?)<\/legend>|<canvas\b(?<canvasAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<canvasInner>[\s\S]*?)<\/canvas>|<canvas\b(?<canvasVoidAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|<(?<ariaTag>[a-z][a-z0-9-]*)\b(?<ariaAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*\brole\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:"[^"]*"|'[^']*'|[^>"'])*)(?<ariaSelf>\/?)>/gi

  let m: RegExpExecArray | null
  while ((m = linearRe.exec(bodyHtml)) !== null) {
    const full = m[0]
    const g = m.groups ?? {}

    // --- <dialog> / </dialog> ---
    if (g.dialogAttrs !== undefined) {
      const attrs = parseAttrs(g.dialogAttrs)
      dialogIndex += 1
      const key = attrs.id?.trim() ? `#${attrs.id.trim()}` : `dialog:nth-of-type(${dialogIndex})`
      const open = options?.dialogOpen?.has(key) ? Boolean(options.dialogOpen.get(key)) : 'open' in attrs
      const hiddenByAncestor = isContentHidden()
      dialogStack.push({ key, open, hiddenByAncestor })
      if (open && !hiddenByAncestor) {
        const dialogTitle = attrs['aria-label']?.trim() || attrs.title?.trim()
        pushBlock({
          kind: 'heading',
          level: 2,
          text: dialogTitle ? `[Dialog: ${dialogTitle}]` : '[Dialog]',
          tag: 'dialog',
        })
      }
      continue
    }
    if (/^<\/dialog>/i.test(full)) {
      const closed = dialogStack.pop()
      if (closed?.open && !closed.hiddenByAncestor) {
        pushBlock({ kind: 'hr', text: '---', tag: 'dialog' })
      }
      continue
    }

    // --- <details> / </details> ---
    if (g.detailsAttrs !== undefined) {
      const attrs = parseAttrs(g.detailsAttrs)
      detailsIndex += 1
      const key = attrs.id?.trim() ? `#${attrs.id.trim()}` : `details:nth-of-type(${detailsIndex})`
      const open = options?.detailsOpen?.has(key) ? Boolean(options.detailsOpen.get(key)) : 'open' in attrs
      const hiddenByAncestor = isContentHidden()
      detailsStack.push({ key, open, summarySeen: false, hiddenByAncestor })
      continue
    }
    if (/^<\/details>/i.test(full)) {
      const closed = detailsStack.pop()
      if (closed && !closed.summarySeen && !closed.hiddenByAncestor && !isHiddenByDialog()) {
        // HTML5 default disclosure summary when <details> has no <summary> child
        const selector = claimSelector(`${closed.key} > summary`, 'summary')
        detailsBySummarySelector.set(selector, closed.key)
        elements.push({
          selector,
          tag: 'summary',
          type: 'summary',
          role: 'button',
          text: 'Details',
          checked: closed.open,
        })
        pushBlock({
          kind: 'button',
          text: `${closed.open ? 'v' : '>'} Details`,
          tag: 'summary',
          checked: closed.open,
          selector,
        })
      }
      continue
    }

    // --- <summary> ---
    if (g.summaryInner !== undefined) {
      if (isHiddenByDialog()) continue
      const topDetails = detailsStack[detailsStack.length - 1]
      if (topDetails) {
        if (topDetails.hiddenByAncestor) continue
        if (!topDetails.summarySeen) {
          topDetails.summarySeen = true
          const attrs = parseAttrs(g.summaryAttrs ?? '')
          const summaryText = stripTags(g.summaryInner) || attrs['aria-label']?.trim() || 'Details'
          const selector = claimSelector(
            attrs.id?.trim() ? `#${attrs.id.trim()}` : `${topDetails.key} > summary`,
            'summary',
            attrs,
          )
          detailsBySummarySelector.set(selector, topDetails.key)
          elements.push({
            selector,
            tag: 'summary',
            type: 'summary',
            id: attrs.id,
            role: attrs.role || 'button',
            text: summaryText,
            ariaLabel: attrs['aria-label'],
            checked: topDetails.open,
          })
          pushBlock({
            kind: 'button',
            text: `${topDetails.open ? 'v' : '>'} ${summaryText}`,
            tag: 'summary',
            checked: topDetails.open,
            selector,
          })
          continue
        }
        // Subsequent <summary> inside the same <details> is ordinary body content
        if (!topDetails.open) continue
        const text = stripTags(g.summaryInner)
        if (text) pushBlock({ kind: 'paragraph', text, tag: 'summary' })
        continue
      }
      // Orphan <summary> outside <details>
      if (isContentHidden()) continue
      const text = stripTags(g.summaryInner)
      if (text) pushBlock({ kind: 'paragraph', text, tag: 'summary' })
      continue
    }

    // Everything below is skipped when inside a closed <dialog> or closed <details>
    if (isContentHidden()) {
      continue
    }

    // --- <fieldset> / </fieldset> / </legend> ---
    if (g.fieldsetAttrs !== undefined) {
      const attrs = parseAttrs(g.fieldsetAttrs)
      fieldsetStack.push({
        disabled: 'disabled' in attrs,
        legendSeen: false,
        inFirstLegend: false,
      })
      continue
    }
    if (/^<\/fieldset>/i.test(full)) {
      fieldsetStack.pop()
      continue
    }
    if (/^<\/legend>/i.test(full)) {
      const topFieldset = fieldsetStack[fieldsetStack.length - 1]
      if (topFieldset) {
        topFieldset.inFirstLegend = false
      }
      continue
    }

    // --- <form> / </form> ---
    if (g.formAttrs !== undefined) {
      const attrs = parseAttrs(g.formAttrs)
      currentFormId = `form-${forms.size + 1}`
      if (attrs.id?.trim()) {
        formIdsByHtmlId.set(attrs.id.trim(), currentFormId)
      }
      const formTitle =
        attrs['aria-label']?.trim() ||
        attrs.title?.trim() ||
        humanizeFormName(attrs.name || attrs.id)
      const method = (attrs.method ?? 'GET').toUpperCase()
      const activeDialog = dialogStack[dialogStack.length - 1]
      forms.set(currentFormId, {
        action: attrs.action?.trim() ? (resolveHref(attrs.action.trim(), effectiveBaseUrl) ?? documentUrl) : documentUrl,
        method,
        enctype: normalizeFormEnctype(attrs.enctype),
        fieldSelectors: [],
        hiddenFields: [],
        fieldOrder: [],
        title: formTitle,
        ...(method === 'DIALOG' && activeDialog ? { dialogKey: activeDialog.key } : {}),
      })
      continue
    }
    if (/^<\/form>/i.test(full)) {
      currentFormId = ''
      continue
    }

    // --- <legend> ---
    if (g.legendInner !== undefined) {
      const inner = g.legendInner
      const topFieldset = fieldsetStack[fieldsetStack.length - 1]
      const isFirstLegend = Boolean(topFieldset && !topFieldset.legendSeen)
      if (topFieldset && !topFieldset.legendSeen) {
        topFieldset.legendSeen = true
      }

      if (containsVisibleFormControl(inner)) {
        if (topFieldset && isFirstLegend) {
          topFieldset.inFirstLegend = true
        }
        const legendText = extractLabelText(inner)
        if (currentFormId && legendText) {
          const formMeta = forms.get(currentFormId)
          if (formMeta && !formMeta.title) {
            formMeta.title = legendText
          }
        }
        const openTagLen = full.length - inner.length - 9 // '</legend>'.length
        linearRe.lastIndex = m.index + Math.max(1, openTagLen)
        continue
      }

      const legendText = stripTags(inner)
      if (legendText) {
        let usedAsFormTitle = false
        if (currentFormId) {
          const formMeta = forms.get(currentFormId)
          if (formMeta && !formMeta.title) {
            formMeta.title = legendText
            usedAsFormTitle = true
          }
        }
        if (!usedAsFormTitle) {
          pushBlock({ kind: 'heading', level: 3, text: legendText, tag: 'legend' })
        }
      }
      continue
    }

    // --- Generic ARIA role="button" / role="link" on non-native elements ---
    if (g.ariaTag !== undefined) {
      const tag = g.ariaTag.toLowerCase()
      const attrs = parseAttrs(g.ariaAttrs ?? '')
      const ariaRole = getInteractiveAriaRole(attrs.role)
      if (!ariaRole) {
        continue
      }
      const isSelfClosing = g.ariaSelf === '/' || VOID_HTML_TAGS.has(tag)
      let inner = ''
      if (!isSelfClosing) {
        const closed = findMatchingCloseTag(bodyHtml, tag, m.index + full.length)
        inner = closed.inner
        linearRe.lastIndex = closed.endIndex
      }
      emitAriaInteractiveElement(tag, attrs, ariaRole, inner)
      continue
    }

    if (g.hTag !== undefined) {
      // Heading h1..h6
      const hAttrs = parseAttrs(g.hAttrs ?? '')
      const ariaRole = getInteractiveAriaRole(hAttrs.role)
      if (ariaRole) {
        emitAriaInteractiveElement(g.hTag.toLowerCase(), hAttrs, ariaRole, g.hInner ?? '')
        continue
      }
      const level = Number(g.hTag.slice(1))
      const text = stripTags(g.hInner ?? '')
      if (text) pushBlock({ kind: 'heading', level, text, tag: g.hTag.toLowerCase() })
      continue
    }

    if (g.pInner !== undefined) {
      // Paragraph <p>: check if <p> itself carries an interactive ARIA role
      const pAttrs = parseAttrs(g.pAttrs ?? '')
      const pAriaRole = getInteractiveAriaRole(pAttrs.role)
      if (pAriaRole) {
        emitAriaInteractiveElement('p', pAttrs, pAriaRole, g.pInner)
        continue
      }
      // If it wraps visible form controls or ARIA role="button", descend into its inner HTML
      // so controls and implicit <label> spans are parsed at their real offsets.
      const inner = g.pInner
      if (containsVisibleFormControl(inner) || containsInteractiveAriaRole(inner, ['button'])) {
        const openTagLen = full.length - inner.length - 4 // '</p>'.length
        linearRe.lastIndex = m.index + Math.max(1, openTagLen)
        continue
      }
      extractHiddenInputsFromFragment(inner)
      // Otherwise capture inline <a> and inline [role="link"] elements in place so they render inline as [eN: link text]
      const inlineLinks: InlineLink[] = []
      const innerLinkRe =
        /<a\b(?<laAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<laInner>[\s\S]*?)<\/a>|<(?<lrTag>[a-z][a-z0-9-]*)\b(?<lrAttrs>(?:"[^"]*"|'[^']*'|[^>"'])*\brole\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:"[^"]*"|'[^']*'|[^>"'])*)>(?<lrInner>[\s\S]*?)<\/\k<lrTag>>/gi
      let textParts = ''
      let lastIdx = 0
      let alm: RegExpExecArray | null
      while ((alm = innerLinkRe.exec(inner)) !== null) {
        const lg = alm.groups ?? {}
        const isAriaInline = lg.lrTag !== undefined
        const attrs = parseAttrs((isAriaInline ? lg.lrAttrs : lg.laAttrs) ?? '')
        if (isAriaInline && getInteractiveAriaRole(attrs.role) !== 'link') {
          continue
        }
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
        const linkTag = isAriaInline ? lg.lrTag!.toLowerCase() : 'a'
        const rawHref = isAriaInline ? attrs.href || attrs['data-href'] : attrs.href
        const lInner = (isAriaInline ? lg.lrInner : lg.laInner) ?? ''
        const lText = stripTags(lInner) || attrs['aria-label'] || rawHref || ''
        if (lText) {
          const selector = claimSelector(
            attrs.id
              ? `#${attrs.id}`
              : isAriaInline
                ? `${linkTag}[role="link"]:nth-of-type(${++elIndex})`
                : `a:nth-of-type(${++elIndex})`,
            linkTag,
            attrs,
          )
          const href = resolveHref(rawHref, effectiveBaseUrl)
          const isDisabled = attrs['aria-disabled']?.trim().toLowerCase() === 'true'
          const el: ElementDescriptor = {
            selector,
            tag: linkTag,
            type: 'link',
            id: attrs.id,
            role: isAriaInline ? 'link' : attrs.role || 'link',
            text: lText,
            ariaLabel: attrs['aria-label'],
            ...(isDisabled ? { disabled: true } : {}),
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

    if (g.aInner !== undefined) {
      // Anchor <a>
      const attrs = parseAttrs(g.aAttrs ?? '')
      const text = stripTags(g.aInner) || attrs['aria-label'] || attrs.href || ''
      if (!text) continue
      const selector = claimSelector(attrs.id ? `#${attrs.id}` : `a:nth-of-type(${++elIndex})`, 'a', attrs)
      const href = resolveHref(attrs.href, effectiveBaseUrl)
      const role = attrs.role || 'link'
      const isDisabled = attrs['aria-disabled']?.trim().toLowerCase() === 'true'
      elements.push({
        selector,
        tag: 'a',
        type: 'link',
        id: attrs.id,
        role,
        text,
        ariaLabel: attrs['aria-label'],
        ...(isDisabled ? { disabled: true } : {}),
        href,
      })
      pushBlock({ kind: 'link', text, href, tag: 'a', selector })
      continue
    }

    if (g.btnInner !== undefined) {
      // <button>
      const attrs = parseAttrs(g.btnAttrs ?? '')
      const explicitLabel = attrs.id ? labelsByFor.get(attrs.id) : undefined
      const implicitLabel = resolveImplicitLabel(m.index, implicitLabelSpans)
      const associatedLabel = explicitLabel || implicitLabel
      const text = stripTags(g.btnInner) || attrs['aria-label'] || associatedLabel || attrs.value || 'Button'
      const type = (attrs.type || 'submit').toLowerCase()
      const selector = claimSelector(
        attrs.id ? `#${attrs.id}` : `button:nth-of-type(${++elIndex})`,
        'button',
        attrs,
      )
      const targetFormId = resolveTargetFormId(attrs.form)
      const formAction = attrs.formaction?.trim()
        ? resolveHref(attrs.formaction.trim(), effectiveBaseUrl)
        : targetFormId
          ? forms.get(targetFormId)?.action
          : undefined
      const formMethod = attrs.formmethod?.trim() ? attrs.formmethod.trim().toUpperCase() : undefined
      const effectiveFormMethod = (formMethod || (targetFormId ? forms.get(targetFormId)?.method : undefined) || 'GET').toUpperCase()
      const formEnctype = attrs.formenctype?.trim() ? normalizeFormEnctype(attrs.formenctype) : undefined
      const disabled = 'disabled' in attrs || isDisabledByFieldset()
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
        ...('value' in attrs ? { value: attrs.value } : {}),
        disabled,
        defaultSubmit: type === 'submit' && Boolean(targetFormId) && effectiveFormMethod !== 'DIALOG',
        formAction,
        ...(formMethod ? { formMethod } : {}),
        ...(formEnctype ? { formEnctype } : {}),
      })
      pushBlock({ kind: 'button', text, tag: 'button', selector })
      recordFormElement(targetFormId, selector)
      continue
    }

    if (g.inputAttrs !== undefined) {
      // <input>
      const attrs = parseAttrs(g.inputAttrs)
      const type = (attrs.type || 'text').toLowerCase()
      const targetFormId = resolveTargetFormId(attrs.form)
      if (type === 'hidden') {
        recordHiddenInput(targetFormId, attrs)
        continue
      }
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
      const formAction = attrs.formaction?.trim()
        ? resolveHref(attrs.formaction.trim(), effectiveBaseUrl)
        : targetFormId
          ? forms.get(targetFormId)?.action
          : undefined
      const formMethod = attrs.formmethod?.trim() ? attrs.formmethod.trim().toUpperCase() : undefined
      const effectiveFormMethod = (formMethod || (targetFormId ? forms.get(targetFormId)?.method : undefined) || 'GET').toUpperCase()
      const formEnctype = attrs.formenctype?.trim() ? normalizeFormEnctype(attrs.formenctype) : undefined
      const disabled = 'disabled' in attrs || isDisabledByFieldset()
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
        disabled,
        readOnly: 'readonly' in attrs,
        editable: !isBtn && type !== 'checkbox' && type !== 'radio' && type !== 'file',
        checked: 'checked' in attrs,
        defaultSubmit: type === 'submit' && effectiveFormMethod !== 'DIALOG',
        formAction,
        ...(formMethod ? { formMethod } : {}),
        ...(formEnctype ? { formEnctype } : {}),
      })
      if (isBtn) {
        pushBlock({ kind: 'button', text: attrs.value || label, tag: 'input', selector })
      } else {
        pushBlock({
          kind: 'input',
          text: label,
          placeholder: attrs.placeholder,
          value: isPassword ? '********' : value,
          checked: 'checked' in attrs,
          tag: type === 'checkbox' || type === 'radio' ? type : 'input',
          selector,
        })
      }
      recordFormElement(targetFormId, selector)
      continue
    }

    if (g.taInner !== undefined) {
      // <textarea>
      const attrs = parseAttrs(g.taAttrs ?? '')
      const targetFormId = resolveTargetFormId(attrs.form)
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
      const value = decodeEntities(g.taInner).trim()
      const disabled = 'disabled' in attrs || isDisabledByFieldset()
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
        disabled,
        readOnly: 'readonly' in attrs,
        editable: true,
      })
      pushBlock({ kind: 'input', text: label, placeholder: attrs.placeholder, value, tag: 'textarea', selector })
      recordFormElement(targetFormId, selector)
      continue
    }

    if (g.selInner !== undefined) {
      // <select>
      const attrs = parseAttrs(g.selAttrs ?? '')
      const targetFormId = resolveTargetFormId(attrs.form)
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
      while ((om = optRe.exec(g.selInner)) !== null) {
        const oAttrs = parseAttrs(om[1] ?? '')
        const oLabel = stripTags(om[2] ?? '')
        options.push({
          value: oAttrs.value ?? oLabel,
          label: oLabel,
          selected: 'selected' in oAttrs,
        })
      }
      const selected = options.find((o) => o.selected) ?? options[0]
      const disabled = 'disabled' in attrs || isDisabledByFieldset()
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
        disabled,
        options,
      })
      pushBlock({ kind: 'select', text: label, value: selected?.label ?? selected?.value ?? '', tag: 'select', selector })
      recordFormElement(targetFormId, selector)
      continue
    }

    if (g.liInner !== undefined) {
      // <li>: check if <li> itself carries an interactive ARIA role
      const liAttrs = parseAttrs(g.liAttrs ?? '')
      const liAriaRole = getInteractiveAriaRole(liAttrs.role)
      if (liAriaRole) {
        emitAriaInteractiveElement('li', liAttrs, liAriaRole, g.liInner)
        continue
      }
      // Descend if it wraps visible form controls or ARIA interactive controls
      const inner = g.liInner
      if (containsVisibleFormControl(inner) || containsInteractiveAriaRole(inner, ['button', 'link'])) {
        const openTagLen = full.length - inner.length - 5 // '</li>'.length
        linearRe.lastIndex = m.index + Math.max(1, openTagLen)
        continue
      }
      extractHiddenInputsFromFragment(inner)
      const text = stripTags(inner)
      if (text) pushBlock({ kind: 'list-item', text, tag: 'li' })
      continue
    }

    if (g.preInner !== undefined) {
      // <pre>
      const text = decodeEntities(g.preInner.replace(/<[^>]+>/g, '')).trim()
      if (text) pushBlock({ kind: 'code', text, tag: 'pre' })
      continue
    }

    if (g.trInner !== undefined) {
      // <tr>
      extractHiddenInputsFromFragment(g.trInner)
      const cells: string[] = []
      let thCount = 0
      const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cm: RegExpExecArray | null
      while ((cm = cellRe.exec(g.trInner)) !== null) {
        if ((cm[1] ?? '').toLowerCase() === 'th') thCount++
        cells.push(stripTags(cm[2] ?? ''))
      }
      if (cells.length > 0) {
        const isHeader = thCount > 0 && thCount === cells.length
        pushBlock({ kind: 'table-row', text: cells.join(' | '), cells, tag: 'tr', isHeader: isHeader || undefined })
      }
      continue
    }

    if (g.imgAttrs !== undefined) {
      // <img>
      const attrs = parseAttrs(g.imgAttrs)
      const imgAriaRole = getInteractiveAriaRole(attrs.role)
      if (imgAriaRole) {
        emitAriaInteractiveElement('img', attrs, imgAriaRole, '')
        continue
      }
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

    if (g.canvasAttrs !== undefined || g.canvasVoidAttrs !== undefined) {
      // <canvas>
      const attrs = parseAttrs(g.canvasAttrs ?? g.canvasVoidAttrs ?? '')
      const fallbackText = g.canvasInner ? stripTags(g.canvasInner) : ''
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

  if (discoveredFeeds.length > 0) {
    const feedInlineLinks: InlineLink[] = []
    const segments: string[] = []
    let cursor = 'Feeds: '.length
    for (let i = 0; i < discoveredFeeds.length; i++) {
      const feed = discoveredFeeds[i]!
      const feedSelector = `feed-autodiscover:${i}`
      const badge = feed.kind === 'atom' ? 'Atom' : 'RSS'
      const label = feed.title ? `[${badge}] ${feed.title}` : `[${badge}] ${feed.url}`
      if (i > 0) {
        cursor += 2 // ', '
      }
      feedInlineLinks.push({
        text: label,
        href: feed.url,
        selector: feedSelector,
        start: cursor,
        end: cursor + label.length,
      })
      elements.push({
        selector: feedSelector,
        tag: 'a',
        type: 'link',
        role: 'link',
        text: label,
        ariaLabel: `Subscribe to ${badge} feed: ${feed.title ?? feed.url}`,
        href: feed.url,
      })
      segments.push(label)
      cursor += label.length
    }
    const feedLine = `Feeds: ${segments.join(', ')}`
    blocks.push({ kind: 'hr', text: '---', tag: 'hr' })
    blocks.push({ kind: 'paragraph', text: feedLine, tag: 'p', links: feedInlineLinks })
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
          enctype: fMeta.enctype,
          fieldSelectors: fMeta.fieldSelectors.map((s) => prefixFrameSelector([frameSeg], s)),
          hiddenFields: fMeta.hiddenFields.map((h) => ({ ...h })),
          fieldOrder: fMeta.fieldOrder?.map((item) =>
            item.kind === 'element'
              ? { kind: 'element', selector: prefixFrameSelector([frameSeg], item.selector) }
              : { ...item },
          ),
          ...(fMeta.title ? { title: fMeta.title } : {}),
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
        ...(discoveredFeeds.length > 0 ? { feeds: discoveredFeeds } : {}),
        blocks: flattened.blocks,
        elements: flattened.elements,
        frames: flattened.frames,
        text: flattened.text,
        forms,
        ...(detailsBySummarySelector.size > 0 ? { detailsBySummarySelector } : {}),
      }
    }
  }

  return {
    title,
    ...(resolvedBaseHref ? { baseUrl: resolvedBaseHref } : {}),
    ...(metaRefresh ? { metaRefresh } : {}),
    ...(discoveredFeeds.length > 0 ? { feeds: discoveredFeeds } : {}),
    blocks,
    elements,
    text,
    forms,
    ...(detailsBySummarySelector.size > 0 ? { detailsBySummarySelector } : {}),
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
  private detailsOpenOverrides = new Map<string, boolean>()
  private dialogOpenOverrides = new Map<string, boolean>()
  private structuredKind: StructuredKind | null = null
  private structuredCollapsed = new Map<string, boolean>()
  private structuredFocusPath: string | null = null
  private structuredContainerPaths: string[] = []
  private structuredRootPath = '$'
  private parsedFeed: ParsedFeed | null = null
  private feedExpandedItems = new Set<number>()
  private feedCategoryFilter: string | null = null
  private feedPage = 0
  private docKind: DocumentKind | null = null
  private docContentType = ''
  private docPage = 0
  private docCsvSortCol: number | null = null
  private docCsvSortDir: CsvSortDirection = 'asc'
  private docRawView = false
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
  private robotsRetry: RobotsRetryController
  private responseCache: ResponseCache
  private ssrfGuard?: SsrfGuard

  constructor(
    id: number,
    cookieJar: CookieJar,
    localStorageByOrigin: Map<string, Map<string, string>>,
    initialEmulation?: EmulationProfile,
    downloads?: DownloadQuarantineManager,
    dialogs?: DialogManager,
    maxMetaRefreshDelaySeconds = 5,
    robotsRetry?: RobotsRetryController,
    responseCache?: ResponseCache,
    ssrfGuard?: SsrfGuard,
  ) {
    this.id = id
    this.cookieJar = cookieJar
    this.localStorageByOrigin = localStorageByOrigin
    this.emulation = initialEmulation ? cloneEmulationProfile(initialEmulation) : defaultEmulationProfile()
    this.downloads = downloads
    this.dialogs = dialogs
    this.maxMetaRefreshDelaySeconds = maxMetaRefreshDelaySeconds
    this.robotsRetry = robotsRetry ?? new RobotsRetryController()
    this.responseCache = responseCache ?? new ResponseCache()
    this.ssrfGuard = ssrfGuard
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

  private async fetchPage(
    targetUrl: string,
    init?: RequestInit,
    pushHistory = true,
    forceRevalidate = false,
  ): Promise<{ url: string; title: string }> {
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
    let totalRetriesForPage = 0

    try {
      let res: Response | null = null
      let preReadBody: string | null = null
      let preParsedDoc: ParsedDoc | null = null
      let cachedEntryHit: ResponseCacheEntry | null = null
      let finalCacheStatus: CacheStatus = 'bypass'
      let finalFromCache = false

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
        cachedEntryHit = null
        finalCacheStatus = 'bypass'
        finalFromCache = false
        if (this.ssrfGuard?.enabled) {
          await this.ssrfGuard.assertAllowed(currentUrl)
        }
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

        const hopOrigin = new URL(currentUrl).origin
        const hopUserAgent = hopHeaders.get('user-agent') ?? this.emulation.userAgent
        const robotsDecision = await this.robotsRetry.checkRobots(currentUrl, hopUserAgent)
        if (!robotsDecision.allowed) {
          this.robotsRetry.recordRobotsBlocked()
          throw new RobotsDisallowedError(currentUrl, robotsDecision)
        }

        const hopMethod = (currentInit.method ?? 'GET').toUpperCase()
        let staleEntryForHop: ResponseCacheEntry | null = null
        if (isCacheableMethod(hopMethod)) {
          const cacheLookup = this.responseCache.lookup(currentUrl, hopHeaders, { forceRevalidate })
          if (cacheLookup.status === 'fresh') {
            cachedEntryHit = cacheLookup.entry
            finalCacheStatus = 'hit'
            finalFromCache = true
            res = null
            break
          }
          if (cacheLookup.status === 'stale') {
            staleEntryForHop = cacheLookup.entry
            finalCacheStatus = 'miss'
            for (const [hk, hv] of Object.entries(cacheLookup.conditionalHeaders)) {
              hopHeaders.set(hk, hv)
            }
            requestHeadersMap = normalizeHeadersMap(hopHeaders)
          } else {
            finalCacheStatus = cacheLookup.status
          }
        } else {
          finalCacheStatus = 'bypass'
        }

        await this.robotsRetry.acquireOriginSlot(hopOrigin, robotsDecision.crawlDelayMs)

        const retryPolicy = this.robotsRetry.getRetryPolicy()
        const maxAttempts = retryPolicy.enabled && isRetryableMethod(currentInit.method, retryPolicy)
          ? retryPolicy.maxRetries + 1
          : 1

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          res = await fetch(currentUrl, { ...currentInit, headers: hopHeaders, redirect: 'manual' })
          this.storeCookies(currentUrl, res.headers)

          if (
            retryPolicy.enabled &&
            isRetryableStatus(res.status, retryPolicy) &&
            isRetryableMethod(currentInit.method, retryPolicy) &&
            attempt < retryPolicy.maxRetries
          ) {
            const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), this.robotsRetry.now())
            const delayMs = computeBackoffDelayMs(attempt, retryPolicy, retryAfterMs, this.robotsRetry.random)
            this.robotsRetry.recordRetry(delayMs)
            totalRetriesForPage += 1
            this.consoleLogs.push({
              level: 'warning',
              text: `[retry] HTTP ${res.status} on ${currentUrl}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${retryPolicy.maxRetries})`,
              ts: this.robotsRetry.now(),
              url: currentUrl,
            })
            try {
              await res.body?.cancel()
            } catch {
              // ignore body cancellation errors
            }
            await this.robotsRetry.sleep(delayMs)
            continue
          }

          this.robotsRetry.recordResponseHeaders(hopOrigin, res.headers)
          break
        }
        if (!res) {
          throw new Error(`No response received while fetching ${currentUrl}`)
        }

        if (isUnsafeMethod(hopMethod) && res.status >= 200 && res.status < 400) {
          this.responseCache.invalidate(currentUrl)
          const locHeader = res.headers.get('location')
          if (locHeader) {
            try {
              this.responseCache.invalidate(new URL(locHeader, currentUrl).toString())
            } catch {
              // ignore invalid location URL
            }
          }
        }

        if (res.status === 304 && staleEntryForHop) {
          try {
            await res.body?.cancel()
          } catch {
            // ignore body cancellation errors
          }
          const revalidated = this.responseCache.revalidate304(currentUrl, hopHeaders, res.headers)
          cachedEntryHit = revalidated ?? staleEntryForHop
          finalCacheStatus = 'revalidated'
          finalFromCache = true
          break
        }

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
        const isDocumentByMime = detectDocumentKind(hopContentType, '', currentUrl) !== null
        const isStructuredByMime = detectStructuredKind(hopContentType, '', currentUrl) !== null
        if (!isDownload && !isDocumentByMime && !isStructuredByMime) {
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

      if (!cachedEntryHit && !res) {
        throw new Error(`No response received while fetching ${targetUrl}`)
      }
      const finalUrl = currentUrl
      const contentType = cachedEntryHit ? cachedEntryHit.contentType : (res!.headers.get('content-type') ?? '')
      const contentDisposition = cachedEntryHit ? null : res!.headers.get('content-disposition')
      const responseHeadersMap = cachedEntryHit ? { ...cachedEntryHit.headers } : normalizeHeadersMap(res!.headers)
      const mimeType = contentType.split(';')[0]?.trim() || undefined

      if (!cachedEntryHit && res && this.downloads && isDownloadResponse(contentDisposition, contentType)) {
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

      const body = cachedEntryHit ? cachedEntryHit.body : (preReadBody ?? (await res!.text()))
      if (!cachedEntryHit && res && isCacheableMethod(currentInit.method ?? init?.method)) {
        this.responseCache.store({
          url: finalUrl,
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          requestHeaders: requestHeadersMap,
          body,
        })
      }

      this.networkRecorder.record({
        url: finalUrl,
        method: currentInit.method ?? init?.method ?? 'GET',
        status: cachedEntryHit
          ? (finalCacheStatus === 'revalidated' ? 304 : cachedEntryHit.status)
          : res!.status,
        statusText: cachedEntryHit
          ? (finalCacheStatus === 'revalidated' ? 'Not Modified' : cachedEntryHit.statusText || undefined)
          : res!.statusText || undefined,
        ok: cachedEntryHit ? true : res!.ok,
        resourceType: contentType.includes('application/json') ? 'fetch' : 'document',
        mimeType,
        encodedDataLength: finalFromCache ? 0 : Buffer.byteLength(body, 'utf8'),
        durationMs: Date.now() - started,
        ts: Date.now(),
        ...(totalRetriesForPage > 0 ? { retries: totalRetriesForPage } : {}),
        ...(finalFromCache ? { fromCache: true } : {}),
        cacheStatus: finalCacheStatus,
        requestHeaders: requestHeadersMap,
        responseHeaders: responseHeadersMap,
        requestBody: requestBodyStr,
        cachedResponseBody: { body, base64Encoded: false },
      })

      this.rawHtml = body
      this.detailsOpenOverrides.clear()
      this.dialogOpenOverrides.clear()
      this.structuredKind = null
      this.structuredCollapsed.clear()
      this.structuredFocusPath = null
      this.structuredContainerPaths = []
      this.structuredRootPath = '$'
      this.parsedFeed = null
      this.feedExpandedItems.clear()
      this.feedCategoryFilter = null
      this.feedPage = 0
      this.docKind = null
      this.docContentType = ''
      this.docPage = 0
      this.docCsvSortCol = null
      this.docCsvSortDir = 'asc'
      this.docRawView = false

      const feedKind = detectFeedKind(contentType, body, finalUrl)
      if (feedKind) {
        this.parsedFeed = parseFeedXml(body, finalUrl, feedKind)
        this.reparseFeedView()
      } else {
        const structuredKind = detectStructuredKind(contentType, body, finalUrl)
        if (structuredKind) {
          this.structuredKind = structuredKind
          const parsed = parseStructuredDocument(structuredKind, body, finalUrl, {
            collapsedPaths: this.structuredCollapsed,
            focusPath: this.structuredFocusPath,
          })
          this.structuredContainerPaths = parsed.containerPaths
          this.structuredRootPath = parsed.rootPath
          this.doc = {
            title: parsed.title,
            blocks: parsed.blocks,
            elements: parsed.elements,
            text: parsed.text,
            forms: new Map(),
          }
        } else {
          const docKind = detectDocumentKind(contentType, body, finalUrl)
          if (docKind) {
            this.docKind = docKind
            this.docContentType = contentType
            this.url = finalUrl
            this.reparseDocumentView()
          } else {
            this.doc = preParsedDoc ?? parseHtmlDocument(body, finalUrl)
          }
        }
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
      const isRobotsBlocked = err instanceof RobotsDisallowedError
      const isSsrfBlocked = isSsrfBlockedError(err)
      this.networkRecorder.record({
        url: isRobotsBlocked ? err.url : isSsrfBlocked && err.url ? err.url : targetUrl,
        method: init?.method ?? 'GET',
        ok: false,
        durationMs: Date.now() - started,
        ts: Date.now(),
        ...(totalRetriesForPage > 0 ? { retries: totalRetriesForPage } : {}),
        ...(isRobotsBlocked
          ? { blocked: true, blockedReason: 'robots.txt' }
          : isSsrfBlocked
            ? { blocked: true, blockedReason: `ssrf:${err.category}` }
            : {}),
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
      return this.fetchPage(this.url, undefined, false, true)
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

  private buildFormSubmissionEntries(
    form: LiteFormMeta,
    submitter: ElementDescriptor | undefined,
    enctype: FormEnctype,
  ): FormDataEntry[] {
    const entries: FormDataEntry[] = []
    const order: LiteFormFieldRef[] =
      form.fieldOrder && form.fieldOrder.length > 0
        ? form.fieldOrder
        : [
            ...form.hiddenFields.map((h): LiteFormFieldRef => ({ kind: 'hidden', ...h })),
            ...form.fieldSelectors.map((selector): LiteFormFieldRef => ({ kind: 'element', selector })),
          ]

    for (const item of order) {
      if (item.kind === 'hidden') {
        if (item.disabled || !item.name) continue
        entries.push({ name: item.name, value: item.value })
        continue
      }
      const field = this.doc.elements.find((e) => e.selector === item.selector)
      if (!field || field.disabled || !field.name) continue
      const isButtonLike =
        field.tag === 'button' || field.type === 'submit' || field.type === 'button' || field.type === 'reset'
      if (isButtonLike) {
        if (submitter && field.selector === submitter.selector && field.type !== 'button' && field.type !== 'reset') {
          entries.push({ name: field.name, value: field.value ?? '' })
        }
        continue
      }
      if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) continue
      if (field.type === 'file') {
        const rawPath = (field.value ?? '').trim()
        if (enctype === 'multipart/form-data') {
          if (rawPath) {
            const filename = path.basename(rawPath)
            let data: Buffer = Buffer.alloc(0)
            let contentType = 'application/octet-stream'
            try {
              if (fs.statSync(rawPath).isFile()) {
                data = fs.readFileSync(rawPath)
                contentType = guessMimeTypeFromFilename(filename)
              }
            } catch {
              // File path not readable on disk; send empty file part with filename
            }
            entries.push({ name: field.name, value: data, filename, contentType })
          } else {
            entries.push({
              name: field.name,
              value: Buffer.alloc(0),
              filename: '',
              contentType: 'application/octet-stream',
            })
          }
        } else {
          entries.push({ name: field.name, value: rawPath ? path.basename(rawPath) : '' })
        }
        continue
      }
      entries.push({ name: field.name, value: field.value ?? '' })
    }
    return entries
  }

  private async submitForm(form: LiteFormMeta, submitter?: ElementDescriptor): Promise<void> {
    const action = submitter?.formAction || form.action
    const method = (submitter?.formMethod || form.method || 'GET').toUpperCase()
    const enctype = normalizeFormEnctype(submitter?.formEnctype || form.enctype)
    const entries = this.buildFormSubmissionEntries(form, submitter, enctype)

    if (method === 'POST') {
      if (enctype === 'multipart/form-data') {
        const encoded = encodeMultipartFormData(entries)
        await this.fetchPage(
          action,
          {
            method: 'POST',
            headers: { 'content-type': encoded.contentType },
            body: new Uint8Array(encoded.body),
          },
          true,
        )
      } else if (enctype === 'text/plain') {
        const body = encodeTextPlainFormData(entries)
        await this.fetchPage(
          action,
          {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body,
          },
          true,
        )
      } else {
        const body = encodeUrlEncodedFormData(entries)
        await this.fetchPage(
          action,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          },
          true,
        )
      }
    } else {
      const target = new URL(action)
      const query = encodeUrlEncodedFormData(entries)
      target.search = query
      await this.fetchPage(target.toString(), undefined, true)
    }
  }

  private reparseCurrentHtml(): void {
    if (!this.rawHtml) return
    const prevValues = new Map<string, { value?: string; checked?: boolean; selectedValue?: string }>()
    for (const el of this.doc.elements) {
      if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') {
        prevValues.set(el.selector, {
          value: el.value,
          checked: el.checked,
          selectedValue: el.options?.find((o) => o.selected)?.value,
        })
      }
    }

    this.doc = parseHtmlDocument(this.rawHtml, this.url, 0, {
      detailsOpen: this.detailsOpenOverrides,
      dialogOpen: this.dialogOpenOverrides,
    })

    for (const el of this.doc.elements) {
      const prev = prevValues.get(el.selector)
      if (!prev) continue
      if (el.tag === 'select' && prev.selectedValue !== undefined && el.options) {
        for (const o of el.options) {
          o.selected = o.value === prev.selectedValue
        }
        el.value = prev.value
      } else if (el.tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        el.checked = prev.checked
      } else if (el.tag === 'input' || el.tag === 'textarea') {
        el.value = prev.value
      }
      this.syncBlockForElement(el)
    }
  }

  private reparseFeedView(): void {
    if (!this.parsedFeed) return
    const rendered = buildFeedReaderDocument(this.parsedFeed, {
      expandedItems: this.feedExpandedItems,
      categoryFilter: this.feedCategoryFilter,
      page: this.feedPage,
    })
    this.feedPage = rendered.page
    this.doc = {
      title: rendered.title,
      blocks: rendered.blocks,
      elements: rendered.elements,
      text: rendered.text,
      forms: new Map(),
    }
    this.title = this.doc.title || this.url
  }

  private reparseDocumentView(): void {
    if (!this.docKind) return
    const rendered = renderDocumentView(this.docKind, this.rawHtml, this.url, this.docContentType, {
      page: this.docPage,
      sortColumn: this.docCsvSortCol,
      sortDirection: this.docCsvSortDir,
      rawView: this.docRawView,
    })
    this.docPage = rendered.page
    this.doc = {
      title: rendered.title,
      blocks: rendered.blocks,
      elements: rendered.elements,
      text: rendered.text,
      forms: new Map(),
    }
    this.title = this.doc.title || this.url
  }

  private reparseStructuredView(): void {
    if (!this.structuredKind) return
    const parsed = parseStructuredDocument(this.structuredKind, this.rawHtml, this.url, {
      collapsedPaths: this.structuredCollapsed,
      focusPath: this.structuredFocusPath,
    })
    this.structuredContainerPaths = parsed.containerPaths
    this.structuredRootPath = parsed.rootPath
    this.doc = {
      title: parsed.title,
      blocks: parsed.blocks,
      elements: parsed.elements,
      text: parsed.text,
      forms: new Map(),
    }
    this.title = this.doc.title || this.url
  }

  async click(selector: string): Promise<{ ok: boolean; note?: string }> {
    const el = this.doc.elements.find((e) => e.selector === selector)
    if (!el) return { ok: false, note: `element ${selector} not found` }
    if (el.disabled) return { ok: false, note: `element ${selector} is disabled` }

    if (this.parsedFeed) {
      if (selector.startsWith('feed-toggle:')) {
        const idx = Number.parseInt(selector.slice('feed-toggle:'.length), 10)
        if (Number.isFinite(idx)) {
          if (this.feedExpandedItems.has(idx)) {
            this.feedExpandedItems.delete(idx)
            this.reparseFeedView()
            return { ok: true, note: `collapsed feed item ${idx + 1}` }
          }
          this.feedExpandedItems.add(idx)
          this.reparseFeedView()
          return { ok: true, note: `expanded feed item ${idx + 1}` }
        }
      }
      if (selector === 'feed-action:expand-all') {
        for (const item of this.parsedFeed.items) {
          this.feedExpandedItems.add(item.index)
        }
        this.reparseFeedView()
        return { ok: true, note: 'expanded all feed items' }
      }
      if (selector === 'feed-action:collapse-all') {
        this.feedExpandedItems.clear()
        this.reparseFeedView()
        return { ok: true, note: 'collapsed all feed items' }
      }
      if (selector.startsWith('feed-filter:')) {
        const cat = selector.slice('feed-filter:'.length)
        this.feedCategoryFilter = cat === 'all' ? null : cat
        this.feedPage = 0
        this.scrollY = 0
        this.reparseFeedView()
        return {
          ok: true,
          note: this.feedCategoryFilter ? `filtered feed by #${this.feedCategoryFilter}` : 'cleared feed filter',
        }
      }
      if (selector === 'feed-page:next') {
        this.feedPage += 1
        this.scrollY = 0
        this.reparseFeedView()
        return { ok: true, note: `feed page ${this.feedPage + 1}` }
      }
      if (selector === 'feed-page:prev') {
        this.feedPage = Math.max(0, this.feedPage - 1)
        this.scrollY = 0
        this.reparseFeedView()
        return { ok: true, note: `feed page ${this.feedPage + 1}` }
      }
      if (selector === 'feed-action:raw-xml') {
        this.parsedFeed = null
        this.structuredKind = 'xml'
        this.structuredCollapsed.clear()
        this.structuredFocusPath = null
        this.scrollY = 0
        this.reparseStructuredView()
        return { ok: true, note: 'switched to raw XML view' }
      }
    }

    if (this.structuredKind) {
      if (selector.startsWith('json-toggle:') || selector.startsWith('xml-toggle:')) {
        const targetPath = selector.slice(selector.indexOf(':') + 1)
        const currentlyExpanded = Boolean(el.checked)
        this.structuredCollapsed.set(targetPath, currentlyExpanded)
        this.reparseStructuredView()
        return { ok: true, note: currentlyExpanded ? `collapsed ${targetPath}` : `expanded ${targetPath}` }
      }
      if (selector.startsWith('json-focus:') || selector.startsWith('xml-focus:')) {
        const targetPath = selector.slice(selector.indexOf(':') + 1)
        this.structuredFocusPath = targetPath === this.structuredRootPath ? null : targetPath
        this.scrollY = 0
        this.reparseStructuredView()
        return { ok: true, note: `focused ${targetPath}` }
      }
      if (selector === 'json-action:expand-all' || selector === 'xml-action:expand-all') {
        for (const p of this.structuredContainerPaths) {
          this.structuredCollapsed.set(p, false)
        }
        this.reparseStructuredView()
        return { ok: true, note: 'expanded all nodes' }
      }
      if (selector === 'json-action:collapse-all' || selector === 'xml-action:collapse-all') {
        const activeRoot = this.structuredFocusPath ?? this.structuredRootPath
        for (const p of this.structuredContainerPaths) {
          this.structuredCollapsed.set(p, p !== activeRoot)
        }
        this.reparseStructuredView()
        return { ok: true, note: 'collapsed all nodes' }
      }
    }

    if (this.docKind) {
      if (selector === 'doc-page:next') {
        this.docPage += 1
        this.scrollY = 0
        this.reparseDocumentView()
        return { ok: true, note: `document page ${this.docPage + 1}` }
      }
      if (selector === 'doc-page:prev') {
        this.docPage = Math.max(0, this.docPage - 1)
        this.scrollY = 0
        this.reparseDocumentView()
        return { ok: true, note: `document page ${this.docPage + 1}` }
      }
      if (selector === 'doc-csv-sort:reset') {
        this.docCsvSortCol = null
        this.docCsvSortDir = 'asc'
        this.docPage = 0
        this.scrollY = 0
        this.reparseDocumentView()
        return { ok: true, note: 'reset CSV sort order' }
      }
      if (selector.startsWith('doc-csv-sort:')) {
        const colIdx = Number.parseInt(selector.slice('doc-csv-sort:'.length), 10)
        if (Number.isFinite(colIdx) && colIdx >= 0) {
          if (this.docCsvSortCol === colIdx) {
            if (this.docCsvSortDir === 'asc') {
              this.docCsvSortDir = 'desc'
            } else {
              this.docCsvSortCol = null
              this.docCsvSortDir = 'asc'
            }
          } else {
            this.docCsvSortCol = colIdx
            this.docCsvSortDir = 'asc'
          }
          this.docPage = 0
          this.scrollY = 0
          this.reparseDocumentView()
          return {
            ok: true,
            note:
              this.docCsvSortCol !== null
                ? `sorted column ${this.docCsvSortCol + 1} (${this.docCsvSortDir})`
                : 'reset CSV sort order',
          }
        }
      }
      if (selector === 'doc-action:raw-text') {
        this.docRawView = true
        this.docPage = 0
        this.scrollY = 0
        this.reparseDocumentView()
        return { ok: true, note: 'switched to raw text view' }
      }
      if (selector === 'doc-action:formatted') {
        this.docRawView = false
        this.docPage = 0
        this.scrollY = 0
        this.reparseDocumentView()
        return { ok: true, note: `switched to formatted ${this.docKind} view` }
      }
    }

    const detailsKey = this.doc.detailsBySummarySelector?.get(selector)
    if (detailsKey) {
      const nextOpen = !Boolean(el.checked)
      this.detailsOpenOverrides.set(detailsKey, nextOpen)
      this.reparseCurrentHtml()
      return { ok: true, note: nextOpen ? 'details expanded' : 'details collapsed' }
    }

    if ((el.tag === 'a' || el.role === 'link') && el.href) {
      await this.navigate(el.href)
      return { ok: true, note: `navigated to ${this.url}` }
    }
    if (el.tag === 'input' && el.type === 'checkbox') {
      el.checked = !el.checked
      this.syncBlockForElement(el)
      return { ok: true, note: `checked=${el.checked}` }
    }
    if (el.tag === 'input' && el.type === 'radio') {
      if (el.name) {
        const ownerForm = [...this.doc.forms.values()].find((f) => f.fieldSelectors.includes(selector))
        const candidates = ownerForm
          ? ownerForm.fieldSelectors
              .map((s) => this.doc.elements.find((e) => e.selector === s))
              .filter((e): e is ElementDescriptor => Boolean(e))
          : this.doc.elements
        for (const other of candidates) {
          if (other !== el && other.tag === 'input' && other.type === 'radio' && other.name === el.name && other.checked) {
            other.checked = false
            this.syncBlockForElement(other)
          }
        }
      }
      el.checked = true
      this.syncBlockForElement(el)
      return { ok: true, note: `checked=${el.checked}` }
    }
    // Check if submit button belongs to a form
    for (const form of this.doc.forms.values()) {
      if (
        form.fieldSelectors.includes(selector) &&
        (el.defaultSubmit || ((el.tag === 'button' || el.tag === 'input') && el.type === 'submit'))
      ) {
        const effectiveMethod = (el.formMethod || form.method || 'GET').toUpperCase()
        if (effectiveMethod === 'DIALOG') {
          if (form.dialogKey) {
            this.dialogOpenOverrides.set(form.dialogKey, false)
            this.reparseCurrentHtml()
          }
          return {
            ok: true,
            note: el.value ? `closed dialog (returnValue=${el.value})` : 'closed dialog',
          }
        }
        await this.submitForm(form, el)
        return { ok: true, note: `submitted form to ${this.url}` }
      }
    }

    return { ok: true, note: 'clicked' }
  }

  private syncBlockForElement(el: ElementDescriptor): void {
    const idx = this.doc.elements.indexOf(el)
    if (idx < 0) return
    const matchingBlock =
      this.doc.blocks.find((b) => b.selector === el.selector) ??
      this.doc.blocks.find((b) => (b.kind === 'input' || b.kind === 'select') && b.text === (el.label || el.text))
    if (matchingBlock) {
      matchingBlock.value = el.valueRedacted ? '********' : el.value
      matchingBlock.checked = el.checked
    }
  }

  async fill(selector: string, text: string, clear = true): Promise<{ ok: boolean; value?: string }> {
    const el = this.doc.elements.find((e) => e.selector === selector)
    if (!el || el.disabled) return { ok: false }
    el.value = clear ? text : `${el.value ?? ''}${text}`
    this.syncBlockForElement(el)
    return { ok: true, value: el.value }
  }

  async select(selector: string, value: string): Promise<{ ok: boolean; value?: string }> {
    const el = this.doc.elements.find((e) => e.selector === selector)
    if (!el || el.tag !== 'select' || el.disabled) return { ok: false }
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
            .find((e) => e && !e.disabled && (e.defaultSubmit || (e.tag === 'button' && e.type === 'submit')))
          if (submitBtn) {
            await this.click(submitBtn.selector)
          } else if (form.method.toUpperCase() === 'DIALOG') {
            if (form.dialogKey) {
              this.dialogOpenOverrides.set(form.dialogKey, false)
              this.reparseCurrentHtml()
            }
          } else {
            await this.submitForm(form)
          }
          return { ok: true, normalized: chord.normalized, modifiers: chord.modifiersBitmask }
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

  async getHtml(): Promise<string> {
    return this.rawHtml
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
  /** Robots.txt compliance & Crawl-delay awareness options (default: disabled). */
  robots?: RobotsPolicyOptions
  /** Exponential backoff retry policy on HTTP 429/503 (default: enabled, maxRetries=3). */
  retry?: RetryPolicyOptions
  /** Per-origin rate-limit awareness options (Retry-After, X-RateLimit-Reset, minDelayMs). */
  rateLimit?: RateLimitOptions
  /** Optional clock/sleep/random/fetch hooks for deterministic testing. */
  robotsRetryHooks?: RobotsRetryHooks
  /** HTTP response cache options (ETag / If-None-Match / Cache-Control). Default: enabled. */
  cache?: ResponseCacheOptions
  /** Optional clock hook for deterministic cache testing. */
  cacheHooks?: ResponseCacheHooks
  /** Optional SSRF protection guard (`--block-private-net`). */
  ssrfGuard?: SsrfGuard
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
  private robotsRetry: RobotsRetryController
  private responseCache: ResponseCache
  private ssrfGuard?: SsrfGuard

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
    this.robotsRetry = new RobotsRetryController({
      robots: opts.robots,
      retry: opts.retry,
      rateLimit: opts.rateLimit,
      hooks: opts.robotsRetryHooks,
    })
    this.responseCache = new ResponseCache(opts.cache, opts.cacheHooks)
    this.ssrfGuard = opts.ssrfGuard
  }

  getCachePolicy(): ResolvedResponseCachePolicy {
    return this.responseCache.getPolicy()
  }

  setCachePolicy(opts: ResponseCacheOptions): ResolvedResponseCachePolicy {
    return this.responseCache.setPolicy(opts)
  }

  getCacheStats(): ResponseCacheStats {
    return this.responseCache.getStats()
  }

  clearCache(origin?: string): number {
    return this.responseCache.clear(origin)
  }

  getResponseCache(): ResponseCache {
    return this.responseCache
  }

  getRobotsPolicy(): ResolvedRobotsPolicy {
    return this.robotsRetry.getRobotsPolicy()
  }

  setRobotsPolicy(opts: RobotsPolicyOptions): ResolvedRobotsPolicy {
    return this.robotsRetry.setRobotsPolicy(opts)
  }

  clearRobotsCache(origin?: string): void {
    this.robotsRetry.clearRobotsCache(origin)
  }

  async checkRobots(url: string, userAgent?: string): Promise<RobotsDecision> {
    return this.robotsRetry.checkRobots(url, userAgent ?? this.defaultEmulation.userAgent, true)
  }

  getRetryPolicy(): ResolvedRetryPolicy {
    return this.robotsRetry.getRetryPolicy()
  }

  setRetryPolicy(opts: RetryPolicyOptions): ResolvedRetryPolicy {
    return this.robotsRetry.setRetryPolicy(opts)
  }

  getRateLimitPolicy(): ResolvedRateLimitPolicy {
    return this.robotsRetry.getRateLimitPolicy()
  }

  setRateLimitPolicy(opts: RateLimitOptions): ResolvedRateLimitPolicy {
    return this.robotsRetry.setRateLimitPolicy(opts)
  }

  getRateLimitStats(): RateLimitStats {
    return this.robotsRetry.getStats()
  }

  clearRateLimits(origin?: string): void {
    this.robotsRetry.clearRateLimits(origin)
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
      this.robotsRetry,
      this.responseCache,
      this.ssrfGuard,
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
