// Zero-Chrome pure-Node HTML/DOM + CookieJar engine ("lite" engine).
// Runs anywhere Node.js runs — even tiny 512MB EC2 t4g.nano instances, Alpine containers,
// or offline tests without Chromium installed.

import type { ConsoleEntry, ContentBlock, ElementDescriptor, InlineLink, NetworkEntry, PageSnapshot } from '../types.js'
import { humanizeFormName } from '../ascii/layout.js'
import { isTrackerHost } from '../agent/omnibox.js'
import type { BrowserEngine, TabDriver } from './types.js'

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(attrString)) !== null) {
    const key = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[key] = decodeEntities(val)
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

interface ParsedDoc {
  title: string
  blocks: ContentBlock[]
  elements: ElementDescriptor[]
  text: string
  forms: Map<string, { action: string; method: string; fieldSelectors: string[] }>
}

function parseHtmlDocument(html: string, baseUrl: string): ParsedDoc {
  // Remove scripts, styles, noscript, comments
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned)
  const title = titleMatch ? stripTags(titleMatch[1]!) : ''

  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)
  const bodyHtml = bodyMatch ? bodyMatch[1]! : cleaned

  // Extract <label for="..."> map
  const labelsByFor = new Map<string, string>()
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi
  let lm: RegExpExecArray | null
  while ((lm = labelRe.exec(bodyHtml)) !== null) {
    const attrs = parseAttrs(lm[1] ?? '')
    const text = stripTags(lm[2] ?? '')
    if (attrs.for && text) labelsByFor.set(attrs.for, text)
  }

  const blocks: ContentBlock[] = []
  const elements: ElementDescriptor[] = []
  const forms = new Map<string, { action: string; method: string; fieldSelectors: string[]; title?: string }>()
  let elIndex = 0
  let currentFormId = ''

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
        action: resolveHref(attrs.action, baseUrl) ?? baseUrl,
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
      // Paragraph <p>: capture inline <a> links in place so they render inline as [eN: link text]
      const inner = m[6]
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
          const href = resolveHref(attrs.href, baseUrl)
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
      const href = resolveHref(attrs.href, baseUrl)
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
      const text = stripTags(m[10]) || attrs['aria-label'] || attrs.value || 'Button'
      const type = (attrs.type || 'submit').toLowerCase()
      const selector = attrs.id ? `#${attrs.id}` : `button:nth-of-type(${++elIndex})`
      const formAction = currentFormId ? forms.get(currentFormId)?.action : undefined
      elements.push({
        selector,
        tag: 'button',
        type,
        id: attrs.id,
        name: attrs.name,
        role: attrs.role || 'button',
        text,
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
      const selector = attrs.id
        ? `#${attrs.id}`
        : attrs.name
          ? `input[name="${attrs.name}"]`
          : `input:nth-of-type(${++elIndex})`
      const label = (attrs.id && labelsByFor.get(attrs.id)) || attrs['aria-label'] || attrs.placeholder || attrs.name || type
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
      const selector = attrs.id
        ? `#${attrs.id}`
        : attrs.name
          ? `textarea[name="${attrs.name}"]`
          : `textarea:nth-of-type(${++elIndex})`
      const label = (attrs.id && labelsByFor.get(attrs.id)) || attrs['aria-label'] || attrs.placeholder || attrs.name || 'textarea'
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
      const selector = attrs.id
        ? `#${attrs.id}`
        : attrs.name
          ? `select[name="${attrs.name}"]`
          : `select:nth-of-type(${++elIndex})`
      const label = (attrs.id && labelsByFor.get(attrs.id)) || attrs['aria-label'] || attrs.name || 'select'
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
      // <li>
      const text = stripTags(m[17])
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
      const src = resolveHref(attrs.src, baseUrl)
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

  return { title, blocks, elements, text, forms }
}

class LiteTab implements TabDriver {
  readonly id: number
  readonly engine = 'lite' as const
  private url = 'about:blank'
  private title = 'New Tab'
  private loading = false
  private epoch = 0
  private scrollY = 0
  private doc: ParsedDoc = { title: 'New Tab', blocks: [], elements: [], text: '', forms: new Map() }
  private historyStack: string[] = []
  private historyIndex = -1
  private consoleLogs: ConsoleEntry[] = []
  private networkLogs: NetworkEntry[] = []
  private cookies: Map<string, string>

  constructor(id: number, cookies: Map<string, string>) {
    this.id = id
    this.cookies = cookies
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
    try {
      const host = new URL(targetUrl).hostname
      const pairs: string[] = []
      for (const [k, v] of this.cookies) {
        if (k.startsWith(`${host}:`)) {
          pairs.push(`${k.slice(host.length + 1)}=${v}`)
        }
      }
      return pairs.length > 0 ? pairs.join('; ') : undefined
    } catch {
      return undefined
    }
  }

  private storeCookies(targetUrl: string, headers: Headers): void {
    try {
      const host = new URL(targetUrl).hostname
      const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
      for (const raw of setCookies) {
        const pair = raw.split(';')[0]?.trim()
        if (!pair) continue
        const eq = pair.indexOf('=')
        if (eq > 0) {
          this.cookies.set(`${host}:${pair.slice(0, eq).trim()}`, pair.slice(eq + 1).trim())
        }
      }
    } catch {
      // ignore invalid cookies
    }
  }

  private async fetchPage(targetUrl: string, init?: RequestInit, pushHistory = true): Promise<{ url: string; title: string }> {
    if (isTrackerHost(targetUrl)) {
      throw new Error(`Blocked tracker host: ${targetUrl}`)
    }
    this.loading = true
    const started = Date.now()
    const headers = new Headers(init?.headers)
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) TroyAdvanced/0.1 Safari/537.36')
    }
    if (!headers.has('accept')) {
      headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    }
    const cookie = this.cookieHeaderFor(targetUrl)
    if (cookie) headers.set('cookie', cookie)

    try {
      const res = await fetch(targetUrl, { ...init, headers, redirect: 'follow' })
      this.storeCookies(res.url || targetUrl, res.headers)
      const body = await res.text()
      const finalUrl = res.url || targetUrl
      this.networkLogs.push({
        url: finalUrl,
        method: init?.method ?? 'GET',
        status: res.status,
        ok: res.ok,
        resourceType: 'document',
        durationMs: Date.now() - started,
        ts: Date.now(),
      })

      const contentType = res.headers.get('content-type') ?? ''
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
        this.doc = parseHtmlDocument(body, finalUrl)
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
      this.networkLogs.push({
        url: targetUrl,
        method: init?.method ?? 'GET',
        ok: false,
        durationMs: Date.now() - started,
        ts: Date.now(),
        error: String((err as Error)?.message ?? err),
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
        width: 1280,
        height: 800,
        scrollX: 0,
        scrollY: this.scrollY,
        scrollHeight: Math.max(800, this.doc.blocks.length * 40),
      },
      blocks: this.doc.blocks.map((b) => ({ ...b })),
      elements: this.doc.elements.map((e) => ({ ...e })),
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

  async press(key: string, selector?: string): Promise<{ ok: boolean }> {
    if (key === 'Enter' && selector) {
      for (const form of this.doc.forms.values()) {
        if (form.fieldSelectors.includes(selector)) {
          const submitBtn = form.fieldSelectors
            .map((s) => this.doc.elements.find((e) => e.selector === s))
            .find((e) => e && (e.defaultSubmit || e.tag === 'button'))
          if (submitBtn) {
            await this.click(submitBtn.selector)
            return { ok: true }
          }
        }
      }
    }
    return { ok: true }
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

  getNetwork(opts: { clear?: boolean; failedOnly?: boolean; limit?: number } = {}): NetworkEntry[] {
    let items = [...this.networkLogs]
    if (opts.failedOnly) items = items.filter((i) => !i.ok)
    if (opts.clear) this.networkLogs = []
    return items.slice(-(opts.limit ?? 50))
  }

  async close(): Promise<void> {
    // nothing to dispose
  }
}

export class LiteBrowserEngine implements BrowserEngine {
  readonly kind = 'lite' as const
  readonly cdpPort = 0
  private nextId = 1
  private cookies = new Map<string, string>()

  async createTab(initialUrl?: string): Promise<TabDriver> {
    const tab = new LiteTab(this.nextId++, this.cookies)
    if (initialUrl) {
      await tab.navigate(initialUrl)
    }
    return tab
  }

  async close(): Promise<void> {
    this.cookies.clear()
  }
}
