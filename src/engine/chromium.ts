// Headless Chromium / Chrome engine over raw CDP (zero Playwright/Electron needed).
// Hardened for EC2, Docker, SSH terminals, and persistent profile sessions.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ConsoleEntry, ContentBlock, ElementDescriptor, NetworkEntry, PageSnapshot } from '../types.js'
import { CdpClient } from './cdp-client.js'
import type { BrowserEngine, TabDriver } from './types.js'

const SNAPSHOT_SCRIPT = `(() => {
  const roots = [document];
  const seenRoots = new Set([document]);
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    try {
      for (const el of r.querySelectorAll('*')) {
        if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
          seenRoots.add(el.shadowRoot);
          roots.push(el.shadowRoot);
        }
      }
    } catch {}
  }

  function cssEscape(str) {
    return String(str).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\\\]^\`{|}~])/g, '\\\\$1');
  }

  function selectorFor(el) {
    if (el.id) {
      const candidate = '#' + cssEscape(el.id);
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {}
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += '#' + cssEscape(cur.id);
        parts.unshift(part);
        break;
      }
      const name = cur.getAttribute && cur.getAttribute('name');
      if (name && (part === 'input' || part === 'textarea' || part === 'select' || part === 'button')) {
        part += '[name="' + name.replace(/"/g, '\\\\"') + '"]';
      } else if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function labelFor(el) {
    if (el.labels && el.labels.length > 0) {
      const txt = Array.from(el.labels).map((l) => (l.innerText || l.textContent || '').trim()).filter(Boolean).join(' ');
      if (txt) return txt;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ');
      if (t) return t;
    }
    return el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }

  const elements = [];
  const elByNode = new Map();
  const interactiveSel = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="tab"]';

  for (const r of roots) {
    for (const el of r.querySelectorAll(interactiveSel)) {
      if (elements.length >= 250) break;
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || (tag === 'a' ? 'link' : tag)).toLowerCase();
      const isPassword = tag === 'input' && type === 'password';
      const rect = el.getBoundingClientRect();
      const selector = selectorFor(el);
      const text = ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 140);
      const label = labelFor(el);
      const desc = {
        selector,
        tag,
        type,
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        role: el.getAttribute('role') || undefined,
        text: text || label || el.getAttribute('value') || '',
        label: label || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        autocomplete: el.getAttribute('autocomplete') || undefined,
        inputMode: el.getAttribute('inputmode') || undefined,
        value: isPassword ? '' : ('value' in el && el.value !== undefined ? String(el.value).slice(0, 200) : undefined),
        valueRedacted: isPassword || undefined,
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        readOnly: Boolean(el.readOnly),
        editable: tag === 'textarea' || (tag === 'input' && !['submit','button','reset','checkbox','radio','file'].includes(type)) || el.isContentEditable,
        defaultSubmit: (tag === 'button' && (type === 'submit' || !el.getAttribute('type'))) || (tag === 'input' && type === 'submit'),
        checked: 'checked' in el ? Boolean(el.checked) : undefined,
        href: el.href || el.getAttribute('href') || undefined,
        formAction: el.formAction || el.form?.action || undefined,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
      if (tag === 'select') {
        desc.options = Array.from(el.options || []).slice(0, 50).map((o) => ({
          value: o.value,
          label: (o.label || o.text || o.value).trim(),
          selected: Boolean(o.selected),
        }));
        const selOpt = desc.options.find((o) => o.selected) || desc.options[0];
        if (selOpt) desc.value = selOpt.label || selOpt.value;
      }
      elements.push(desc);
      elByNode.set(el, desc);
    }
  }

  const blocks = [];
  const blockSel = 'h1, h2, h3, h4, h5, h6, p, a[href], button, input:not([type="hidden"]), textarea, select, li, pre, tr, img, hr';
  const body = document.body || document.documentElement;
  if (body) {
    for (const el of body.querySelectorAll(blockSel)) {
      if (blocks.length >= 300) break;
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      const tracked = elByNode.get(el);

      if (/^h[1-6]$/.test(tag)) {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt) blocks.push({ kind: 'heading', level: Number(tag[1]), text: txt, tag, box });
      } else if (tag === 'p') {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt) blocks.push({ kind: 'paragraph', text: txt, tag, box });
      } else if (tag === 'a') {
        const txt = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        if (txt) blocks.push({ kind: 'link', text: txt, href: el.href || undefined, tag, box, selector: tracked?.selector });
      } else if (tag === 'button' || (tag === 'input' && ['submit','button','reset'].includes(String(el.type).toLowerCase()))) {
        const txt = (el.innerText || el.value || el.getAttribute('aria-label') || 'Button').replace(/\\s+/g, ' ').trim();
        blocks.push({ kind: 'button', text: txt, tag, box, selector: tracked?.selector });
      } else if (tag === 'input' || tag === 'textarea') {
        const type = String(el.type || 'text').toLowerCase();
        const isPassword = type === 'password';
        blocks.push({
          kind: 'input',
          text: tracked?.label || tracked?.text || type,
          placeholder: el.getAttribute('placeholder') || undefined,
          value: isPassword ? '********' : String(el.value || ''),
          checked: 'checked' in el ? Boolean(el.checked) : undefined,
          tag: type === 'checkbox' || type === 'radio' ? type : tag,
          box,
          selector: tracked?.selector,
        });
      } else if (tag === 'select') {
        blocks.push({
          kind: 'select',
          text: tracked?.label || tracked?.text || 'select',
          value: tracked?.value || '',
          tag,
          box,
          selector: tracked?.selector,
        });
      } else if (tag === 'li') {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt) blocks.push({ kind: 'list-item', text: txt, tag, box });
      } else if (tag === 'pre') {
        const txt = (el.innerText || '').trim();
        if (txt) blocks.push({ kind: 'code', text: txt.slice(0, 2000), tag, box });
      } else if (tag === 'tr') {
        const directCells = Array.from(el.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
        const cellEls = directCells.length > 0 ? directCells : Array.from(el.querySelectorAll('th,td'));
        const cells = cellEls.map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim());
        const isHeader = cellEls.length > 0 && (
          cellEls.every((c) => c.tagName === 'TH') ||
          Boolean(el.closest('thead'))
        );
        if (cells.length > 0 && cells.some(Boolean)) {
          blocks.push({ kind: 'table-row', text: cells.join(' | '), cells, tag, box, isHeader: isHeader || undefined });
        }
      } else if (tag === 'img') {
        const alt = el.getAttribute('alt') || el.getAttribute('title') || '';
        if (alt) blocks.push({ kind: 'image', text: alt, alt, tag, box });
      } else if (tag === 'hr') {
        blocks.push({ kind: 'hr', text: '---', tag, box });
      }
    }
  }

  return {
    url: location.href,
    title: document.title || '',
    viewport: {
      width: window.innerWidth || 1280,
      height: window.innerHeight || 800,
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
      scrollHeight: Math.round(document.documentElement?.scrollHeight || document.body?.scrollHeight || 800),
    },
    blocks,
    elements,
    text: ((document.body?.innerText || '').trim()).slice(0, 30000),
  };
})()`

export function findChromeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = [env.TROY_CHROME_BIN, env.CHROME_PATH, env.PUPPETEER_EXECUTABLE_PATH].filter(Boolean) as string[]
  for (const p of explicit) {
    if (fs.existsSync(p)) return p
  }

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/local/bin/chromium',
          ]

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const res = spawnSync(whichCmd, [name], { encoding: 'utf8', timeout: 2000 })
    if (res.status === 0 && res.stdout.trim()) {
      const first = res.stdout.trim().split(/\r?\n/)[0]?.trim()
      if (first && fs.existsSync(first)) return first
    }
  }
  return null
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function waitForCdp(port: number, timeoutMs = 15000): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string }
        if (data.webSocketDebuggerUrl) return { webSocketDebuggerUrl: data.webSocketDebuggerUrl }
      }
    } catch {
      // Chrome still booting
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`Chromium CDP did not become ready on port ${port} within ${timeoutMs}ms`)
}

class ChromiumTab implements TabDriver {
  readonly id: number
  readonly engine = 'chromium' as const
  readonly targetId: string
  private cdp: CdpClient
  private cdpPort: number
  private url = 'about:blank'
  private title = 'New Tab'
  private loading = false
  private epoch = 0
  private consoleLogs: ConsoleEntry[] = []
  private networkLogs: NetworkEntry[] = []
  private reqStart = new Map<string, { url: string; method: string; ts: number }>()

  constructor(id: number, targetId: string, cdp: CdpClient, cdpPort: number) {
    this.id = id
    this.targetId = targetId
    this.cdp = cdp
    this.cdpPort = cdpPort

    this.cdp.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { parentId?: string; url?: string } | undefined
      if (frame && !frame.parentId && frame.url) {
        this.url = frame.url
        this.epoch += 1
      }
    })
    this.cdp.on('Page.loadEventFired', () => {
      this.loading = false
    })
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      const levelRaw = String(params.type ?? 'log')
      const level = (['log', 'info', 'warning', 'error', 'debug'].includes(levelRaw) ? levelRaw : 'log') as ConsoleEntry['level']
      const args = Array.isArray(params.args) ? params.args : []
      const text = args
        .map((a: Record<string, unknown>) => String(a.value ?? a.description ?? ''))
        .filter(Boolean)
        .join(' ')
      this.consoleLogs.push({ level, text, ts: Date.now(), url: this.url })
      if (this.consoleLogs.length > 200) this.consoleLogs.shift()
    })
    this.cdp.on('Network.requestWillBeSent', (params) => {
      const idStr = String(params.requestId ?? '')
      const req = params.request as { url?: string; method?: string } | undefined
      if (idStr && req?.url) {
        this.reqStart.set(idStr, { url: req.url, method: req.method ?? 'GET', ts: Date.now() })
      }
    })
    this.cdp.on('Network.responseReceived', (params) => {
      const idStr = String(params.requestId ?? '')
      const res = params.response as { url?: string; status?: number } | undefined
      const started = this.reqStart.get(idStr)
      this.reqStart.delete(idStr)
      const status = Number(res?.status ?? 0)
      this.networkLogs.push({
        url: res?.url ?? started?.url ?? '',
        method: started?.method ?? 'GET',
        status,
        ok: status >= 200 && status < 400,
        resourceType: String(params.type ?? ''),
        durationMs: started ? Date.now() - started.ts : undefined,
        ts: Date.now(),
      })
      if (this.networkLogs.length > 300) this.networkLogs.shift()
    })
    this.cdp.on('Network.loadingFailed', (params) => {
      const idStr = String(params.requestId ?? '')
      const started = this.reqStart.get(idStr)
      this.reqStart.delete(idStr)
      this.networkLogs.push({
        url: started?.url ?? '',
        method: started?.method ?? 'GET',
        ok: false,
        durationMs: started ? Date.now() - started.ts : undefined,
        ts: Date.now(),
        error: String(params.errorText ?? 'failed'),
      })
      if (this.networkLogs.length > 300) this.networkLogs.shift()
    })
  }

  async init(): Promise<void> {
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Network.enable'),
      this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ])
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

  private async evalJson<T>(expression: string): Promise<T> {
    const res = await this.cdp.send<{
      result?: { value?: T; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate exception')
    }
    return res.result?.value as T
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    this.loading = true
    const loadPromise = new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        off()
        clearTimeout(timer)
        resolve()
      }
      const off = this.cdp.on('Page.loadEventFired', finish)
      const timer = setTimeout(finish, 8000)
    })

    const nav = await this.cdp.send<{ errorText?: string }>('Page.navigate', { url })
    if (nav.errorText) {
      this.loading = false
      throw new Error(`Navigation failed: ${nav.errorText}`)
    }
    await loadPromise
    // Small settle delay for initial SPA render
    await new Promise((r) => setTimeout(r, 150))
    const meta = await this.evalJson<{ url: string; title: string }>('({ url: location.href, title: document.title || "" })')
    this.url = meta?.url || url
    this.title = meta?.title || this.url
    this.epoch += 1
    this.loading = false
    return { url: this.url, title: this.title }
  }

  async history(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }> {
    if (direction === 'reload') {
      await this.cdp.send('Page.reload')
    } else {
      const hist = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory')
      const nextIdx = direction === 'back' ? hist.currentIndex - 1 : hist.currentIndex + 1
      const entry = hist.entries[nextIdx]
      if (entry) {
        await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id })
      }
    }
    await new Promise((r) => setTimeout(r, 250))
    const meta = await this.evalJson<{ url: string; title: string }>('({ url: location.href, title: document.title || "" })')
    this.url = meta?.url || this.url
    this.title = meta?.title || this.title
    this.epoch += 1
    return { url: this.url, title: this.title }
  }

  async snapshot(): Promise<PageSnapshot> {
    const raw = await this.evalJson<{
      url: string
      title: string
      viewport: PageSnapshot['viewport']
      blocks: Array<ContentBlock & { selector?: string }>
      elements: ElementDescriptor[]
      text: string
    }>(SNAPSHOT_SCRIPT)

    this.url = raw.url || this.url
    this.title = raw.title || this.title

    return {
      tabId: this.id,
      url: this.url,
      title: this.title,
      epoch: this.epoch,
      viewport: raw.viewport,
      blocks: raw.blocks,
      elements: raw.elements,
      text: raw.text,
      capturedAt: Date.now(),
    }
  }

  async click(selector: string): Promise<{ ok: boolean; note?: string }> {
    const res = await this.evalJson<{ ok: boolean; x?: number; y?: number; note?: string }>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, note: 'element not found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    )
    if (!res?.ok) return { ok: false, note: res?.note ?? 'not found' }

    const x = Math.round(res.x ?? 0)
    const y = Math.round(res.y ?? 0)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 200))
    const meta = await this.evalJson<{ url: string; title: string }>('({ url: location.href, title: document.title || "" })')
    if (meta?.url && meta.url !== this.url) {
      this.url = meta.url
      this.title = meta.title
      this.epoch += 1
    }
    return { ok: true }
  }

  async fill(selector: string, text: string, clear = true): Promise<{ ok: boolean; value?: string }> {
    const res = await this.evalJson<{ ok: boolean; value?: string }>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        el.focus();
        const nextVal = ${clear ? '""' : 'String(el.value ?? "")'} + ${JSON.stringify(text)};
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, nextVal);
        else el.value = nextVal;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: String(el.value ?? '') };
      })()`,
    )
    return res ?? { ok: false }
  }

  async select(selector: string, value: string): Promise<{ ok: boolean; value?: string }> {
    const res = await this.evalJson<{ ok: boolean; value?: string }>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return { ok: false };
        const target = ${JSON.stringify(value)}.toLowerCase();
        const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === target || (o.text || '').trim().toLowerCase() === target);
        if (!opt) return { ok: false };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: opt.text || opt.value };
      })()`,
    )
    return res ?? { ok: false }
  }

  async press(key: string, selector?: string): Promise<{ ok: boolean }> {
    if (selector) {
      await this.evalJson(`document.querySelector(${JSON.stringify(selector)})?.focus()`)
    }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
    await new Promise((r) => setTimeout(r, 120))
    return { ok: true }
  }

  async hover(selector: string): Promise<{ ok: boolean }> {
    const res = await this.evalJson<{ ok: boolean; x?: number; y?: number }>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    )
    if (!res?.ok) return { ok: false }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(res.x ?? 0), y: Math.round(res.y ?? 0) })
    return { ok: true }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount = 450) {
    return this.evalJson<{ scrollX: number; scrollY: number }>(
      `(() => {
        const dir = ${JSON.stringify(direction)};
        const amt = ${Number(amount)};
        if (dir === 'top') window.scrollTo(0, 0);
        else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
        else if (dir === 'up') window.scrollBy(0, -amt);
        else if (dir === 'down') window.scrollBy(0, amt);
        else if (dir === 'left') window.scrollBy(-amt, 0);
        else if (dir === 'right') window.scrollBy(amt, 0);
        return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
      })()`,
    )
  }

  async evaluate(expression: string): Promise<unknown> {
    return this.evalJson(expression)
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer | null> {
    const res = await this.cdp.send<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: Boolean(opts.fullPage),
    })
    return res.data ? Buffer.from(res.data, 'base64') : null
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
    await this.cdp.close()
    try {
      await fetch(`http://127.0.0.1:${this.cdpPort}/json/close/${this.targetId}`)
    } catch {
      // ignore if browser already exited
    }
  }
}

export interface ChromiumLaunchOptions {
  chromeBin?: string
  cdpPort?: number
  profileDir?: string
  remoteCdpPort?: number
}

export class ChromiumBrowserEngine implements BrowserEngine {
  readonly kind = 'chromium' as const
  readonly cdpPort: number
  private proc: ChildProcess | null
  private nextTabId = 1

  private constructor(cdpPort: number, proc: ChildProcess | null) {
    this.cdpPort = cdpPort
    this.proc = proc
  }

  static async launch(opts: ChromiumLaunchOptions = {}): Promise<ChromiumBrowserEngine> {
    if (opts.remoteCdpPort && opts.remoteCdpPort > 0) {
      await waitForCdp(opts.remoteCdpPort, 5000)
      return new ChromiumBrowserEngine(opts.remoteCdpPort, null)
    }

    const chromeBin = opts.chromeBin || findChromeBinary()
    if (!chromeBin) {
      throw new Error('No Chrome/Chromium binary found. Install chromium/google-chrome or use --engine lite.')
    }

    const port = opts.cdpPort && opts.cdpPort > 0 ? opts.cdpPort : await allocateFreePort()
    const profileDir = opts.profileDir || path.join(os.tmpdir(), `troy-advanced-chrome-${process.pid}`)
    fs.mkdirSync(profileDir, { recursive: true })

    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ]

    const proc = spawn(chromeBin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    })

    let stderrTail = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
    })

    try {
      await waitForCdp(port, 15000)
    } catch (err) {
      proc.kill('SIGTERM')
      throw new Error(`${(err as Error).message}${stderrTail ? `\nChrome stderr: ${stderrTail}` : ''}`)
    }

    return new ChromiumBrowserEngine(port, proc)
  }

  async createTab(initialUrl?: string): Promise<TabDriver> {
    const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/new?about:blank`, { method: 'PUT' }).catch(() =>
      fetch(`http://127.0.0.1:${this.cdpPort}/json/new?about:blank`),
    )
    if (!res.ok) {
      throw new Error(`Failed to open Chromium tab (HTTP ${res.status})`)
    }
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string }
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
    const tab = new ChromiumTab(this.nextTabId++, target.id, cdp, this.cdpPort)
    await tab.init()
    if (initialUrl) {
      await tab.navigate(initialUrl)
    }
    return tab
  }

  async close(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 200))
      if (!this.proc.killed) this.proc.kill('SIGKILL')
    }
  }
}
