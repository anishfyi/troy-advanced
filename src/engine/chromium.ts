// Headless Chromium / Chrome engine over raw CDP (zero Playwright/Electron needed).
// Hardened for EC2, Docker, SSH terminals, and persistent profile sessions.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type {
  BlockedTrackerStats,
  BrowserCookie,
  ConsoleEntry,
  ContentBlock,
  CookieExportOptions,
  CookieImportResult,
  CrashRecoveryEvent,
  CrashRecoveryOptions,
  CrashRecoveryStats,
  CrashRecoveryStatus,
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
  NetworkBodyInspectionOptions,
  NetworkBodyResult,
  NetworkEntry,
  NetworkListOptions,
  OriginStorageSnapshot,
  PageSnapshot,
  SettleOptions,
  SettleResult,
  StorageArea,
  TrackerBlockingOptions,
  WaitConditionOptions,
  WaitResult,
  WaitState,
} from '../types.js'
import { CdpClient, type CdpConnection } from './cdp-client.js'
import { discoverRemoteCdp, type RemoteCdpInfo } from './remote-cdp.js'
import {
  domainFilterMatches,
  filterCookies,
  fromCdpCookie,
  isCookieExpired,
  normalizeCookie,
  toCdpCookieParam,
} from './cookies.js'
import {
  cleanupStaleProfileLocks,
  computeRecoveryBackoffMs,
  isCdpDisconnectError,
  resolveCrashRecoveryOptions,
  shouldRestoreTabUrl,
} from './crash-recovery.js'
import { DialogManager } from './dialogs.js'
import { DownloadQuarantineManager } from './downloads.js'
import { cloneEmulationProfile, defaultEmulationProfile, resolveEmulationProfile } from './emulation.js'
import { NetworkRecorder, buildNetworkBodyResult, normalizeHeadersMap } from './network.js'
import {
  IFRAME_OWNER_INFO_FUNCTION,
  flattenFrameSnapshots,
  isCrossOriginUrl,
  offsetRect,
  parseFrameIdToken,
  parseFrameSelector,
  type ChildFrameSnapshotInput,
  type RawFrameSnapshot,
} from './frames.js'
import { dispatchKeyChord } from './keyboard.js'
import { normalizeStorageArea, normalizeStorageMap, normalizeStorageOrigin } from './storage.js'
import { DOM_SETTLE_PROBE_SCRIPT, NetworkIdleTracker, waitForPageSettle } from './settle.js'
import { SHADOW_DOM_QUERY_HELPER } from './shadow-dom.js'
import { CdpTrackerBlocker } from './tracker-blocker.js'
import type { BrowserEngine, TabDriver } from './types.js'
import { describeWaitCondition, matchesText, matchesUrlPattern, pollUntil } from './wait.js'

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

  function localSelectorInRoot(el, root) {
    if (el.id) {
      const candidate = '#' + cssEscape(el.id);
      try {
        if (root.querySelectorAll(candidate).length === 1) return candidate;
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
      } else {
        const parent = cur.parentElement || (cur.parentNode && cur.parentNode.nodeType === 11 ? cur.parentNode : null);
        if (parent && parent.children) {
          const siblings = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
          if (siblings.length > 1) {
            part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
          }
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function selectorFor(el) {
    const segments = [];
    let cur = el;
    let guard = 0;
    while (cur && guard < 12) {
      guard += 1;
      const root = cur.getRootNode ? cur.getRootNode() : document;
      const queryRoot = root && typeof root.querySelectorAll === 'function' ? root : document;
      segments.unshift(localSelectorInRoot(cur, queryRoot));
      if (root && root !== document && root.host) {
        cur = root.host;
      } else {
        break;
      }
    }
    return segments.join(' >>> ');
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
      const root = el.getRootNode ? el.getRootNode() : document;
      const t = labelledBy
        .split(/\\s+/)
        .map((id) => ((root && typeof root.getElementById === 'function' ? root.getElementById(id) : null) || document.getElementById(id))?.textContent?.trim() || '')
        .filter(Boolean)
        .join(' ');
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
  const consumedLinks = new Set();
  const formMetaMap = new WeakMap();
  let formCounter = 0;

  function formInfoFor(el) {
    const form = el.closest ? el.closest('form') : null;
    if (!form) return null;
    let info = formMetaMap.get(form);
    if (!info) {
      formCounter += 1;
      const id = 'form-' + formCounter;
      let title = (form.getAttribute('aria-label') || '').trim();
      if (!title) {
        const labelledBy = form.getAttribute('aria-labelledby');
        if (labelledBy) {
          const root = form.getRootNode ? form.getRootNode() : document;
          title = labelledBy
            .split(/\\s+/)
            .map((refId) => ((root && typeof root.getElementById === 'function' ? root.getElementById(refId) : null) || document.getElementById(refId))?.textContent?.trim() || '')
            .filter(Boolean)
            .join(' ');
        }
      }
      if (!title) title = (form.getAttribute('title') || '').trim();
      if (!title) {
        const legend = form.querySelector('legend');
        if (legend) title = (legend.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      if (!title) {
        const rawName = (form.getAttribute('name') || form.id || '').trim();
        if (rawName && !/^(?:form[-_\\s]?\\d+|f\\d+)$/i.test(rawName)) {
          const stripped = rawName.replace(/(?:[-_\\s]?form)$/i, '').trim() || rawName;
          title = stripped.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\\s+/g, ' ').trim()
            .split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : '')).join(' ');
        }
      }
      info = { formId: id, ...(title ? { formTitle: title } : {}) };
      formMetaMap.set(form, info);
    }
    return info;
  }

  function pushBlock(el, block) {
    const fInfo = formInfoFor(el);
    blocks.push(fInfo ? { ...block, ...fInfo } : block);
  }

  const blockSel = 'h1, h2, h3, h4, h5, h6, p, a[href], button, input:not([type="hidden"]), textarea, select, li, pre, tr, img, canvas, hr';
  let capturedCanvasCount = 0;
  const body = document.body || document.documentElement;
  const blockNodes = [];
  if (body) {
    const visitBlocks = (root) => {
      const kids = root.children || [];
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.matches && child.matches(blockSel)) {
          blockNodes.push(child);
        }
        if (child.shadowRoot) {
          visitBlocks(child.shadowRoot);
        }
        if (child.children && child.children.length > 0) {
          visitBlocks(child);
        }
      }
    };
    visitBlocks(body);
    for (const el of blockNodes) {
      if (blocks.length >= 300) break;
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      const tracked = elByNode.get(el);

      if (/^h[1-6]$/.test(tag)) {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt) pushBlock(el, { kind: 'heading', level: Number(tag[1]), text: txt, tag, box });
      } else if (tag === 'p') {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt) {
          const inlineLinks = [];
          let cursor = 0;
          for (const a of el.querySelectorAll('a[href]')) {
            if (!isVisible(a)) continue;
            const lText = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
            if (!lText) continue;
            consumedLinks.add(a);
            const aTracked = elByNode.get(a);
            const idx = txt.indexOf(lText, cursor);
            const entry = {
              text: lText,
              href: a.href || undefined,
              selector: aTracked?.selector,
            };
            if (idx !== -1) {
              entry.start = idx;
              entry.end = idx + lText.length;
              cursor = entry.end;
            }
            inlineLinks.push(entry);
          }
          pushBlock(el, {
            kind: 'paragraph',
            text: txt,
            tag,
            box,
            ...(inlineLinks.length > 0 ? { links: inlineLinks } : {}),
          });
        }
      } else if (tag === 'a') {
        if (consumedLinks.has(el)) continue;
        const txt = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        if (txt) pushBlock(el, { kind: 'link', text: txt, href: el.href || undefined, tag, box, selector: tracked?.selector });
      } else if (tag === 'button' || (tag === 'input' && ['submit','button','reset'].includes(String(el.type).toLowerCase()))) {
        const txt = (el.innerText || el.value || el.getAttribute('aria-label') || 'Button').replace(/\\s+/g, ' ').trim();
        pushBlock(el, { kind: 'button', text: txt, tag, box, selector: tracked?.selector });
      } else if (tag === 'input' || tag === 'textarea') {
        const type = String(el.type || 'text').toLowerCase();
        const isPassword = type === 'password';
        pushBlock(el, {
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
        pushBlock(el, {
          kind: 'select',
          text: tracked?.label || tracked?.text || 'select',
          value: tracked?.value || '',
          tag,
          box,
          selector: tracked?.selector,
        });
      } else if (tag === 'li') {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt) pushBlock(el, { kind: 'list-item', text: txt, tag, box });
      } else if (tag === 'pre') {
        const txt = (el.innerText || '').trim();
        if (txt) pushBlock(el, { kind: 'code', text: txt.slice(0, 2000), tag, box });
      } else if (tag === 'tr') {
        const directCells = Array.from(el.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
        const cellEls = directCells.length > 0 ? directCells : Array.from(el.querySelectorAll('th,td'));
        const cells = cellEls.map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim());
        const isHeader = cellEls.length > 0 && (
          cellEls.every((c) => c.tagName === 'TH') ||
          Boolean(el.closest('thead'))
        );
        if (cells.length > 0 && cells.some(Boolean)) {
          pushBlock(el, { kind: 'table-row', text: cells.join(' | '), cells, tag, box, isHeader: isHeader || undefined });
        }
      } else if (tag === 'img') {
        const alt = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
        const src = el.currentSrc || el.getAttribute('src') || undefined;
        const naturalWidth = Number(el.naturalWidth) || Number(el.getAttribute('width')) || undefined;
        const naturalHeight = Number(el.naturalHeight) || Number(el.getAttribute('height')) || undefined;
        let label = alt;
        if (!label && src && !/^data:/i.test(src)) {
          try {
            const pathname = new URL(src, location.href).pathname;
            label = pathname.split('/').filter(Boolean).pop() || '';
          } catch {}
        }
        if (label || (box.width > 0 && box.height > 0)) {
          const finalLabel = label || 'image';
          pushBlock(el, {
            kind: 'image',
            text: finalLabel,
            alt: alt || finalLabel,
            src,
            naturalWidth: naturalWidth && naturalWidth > 0 ? naturalWidth : undefined,
            naturalHeight: naturalHeight && naturalHeight > 0 ? naturalHeight : undefined,
            tag,
            box,
          });
        }
      } else if (tag === 'canvas') {
        const label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          (el.textContent || '').replace(/\\s+/g, ' ').trim() ||
          el.id ||
          'canvas'
        ).slice(0, 120);
        const naturalWidth = Number(el.width) || undefined;
        const naturalHeight = Number(el.height) || undefined;
        let canvasDataUrl;
        if (capturedCanvasCount < 6 && el.width > 0 && el.height > 0 && typeof el.toDataURL === 'function') {
          try {
            const url = el.toDataURL('image/png');
            if (typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length <= 524288) {
              canvasDataUrl = url;
              capturedCanvasCount += 1;
            }
          } catch {}
        }
        pushBlock(el, {
          kind: 'canvas',
          text: label,
          alt: label,
          naturalWidth,
          naturalHeight,
          ...(canvasDataUrl ? { canvasDataUrl } : {}),
          tag,
          box,
        });
      } else if (tag === 'hr') {
        pushBlock(el, { kind: 'hr', text: '---', tag, box });
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

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
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

interface CdpFrameTreeNode {
  frame: {
    id: string
    parentId?: string
    name?: string
    url?: string
    securityOrigin?: string
  }
  childFrames?: CdpFrameTreeNode[]
}

interface FrameOwnerInfo {
  visible: boolean
  contentX?: number
  contentY?: number
  box?: { x: number; y: number; width: number; height: number }
  selector?: string
  name?: string
  title?: string
}

interface DiscoveredFrame {
  frameId: string
  parentFrameId?: string
  url: string
  name?: string
  title?: string
  selectorChain: string[]
  offsetX: number
  offsetY: number
  box?: { x: number; y: number; width: number; height: number }
  sessionId?: string
  parentSessionId?: string
  depth: number
  crossOrigin: boolean
}

const MAX_FRAME_DEPTH = 5
const MAX_DISCOVERED_FRAMES = 20

interface ChromiumTabRecoveryHost {
  withRecovery<T>(fn: () => Promise<T>): Promise<T>
  onTabClosed(tab: ChromiumTab): void
  closeTarget?: (targetId: string) => Promise<void>
}

export class ChromiumTab implements TabDriver {
  readonly id: number
  readonly engine = 'chromium' as const
  private targetId: string
  private cdp: CdpConnection
  private cdpPort: number
  private url = 'about:blank'
  private title = 'New Tab'
  private loading = false
  private epoch = 0
  private mainFrameId: string | null = null
  private frameContexts = new Map<string, number>()
  private oopifSessions = new Map<string, string>()
  private consoleLogs: ConsoleEntry[] = []
  private networkRecorder = new NetworkRecorder()
  private reqStart = new Map<
    string,
    {
      url: string
      method: string
      ts: number
      requestHeaders: Record<string, string>
      postData?: string
      hasPostData?: boolean
    }
  >()
  private blockedByFetch = new Map<string, string>()
  private networkIdle = new NetworkIdleTracker()
  private trackerBlocking?: TrackerBlockingOptions
  private trackerBlocker: CdpTrackerBlocker
  private emulation: EmulationProfile
  private recoveryHost?: ChromiumTabRecoveryHost
  private downloads?: DownloadQuarantineManager
  private dialogs?: DialogManager

  constructor(
    id: number,
    targetId: string,
    cdp: CdpConnection,
    cdpPort: number,
    trackerBlocking?: TrackerBlockingOptions,
    initialEmulation?: EmulationProfile,
    recoveryHost?: ChromiumTabRecoveryHost,
    downloads?: DownloadQuarantineManager,
    dialogs?: DialogManager,
  ) {
    this.id = id
    this.targetId = targetId
    this.cdp = cdp
    this.cdpPort = cdpPort
    this.trackerBlocking = trackerBlocking
    this.recoveryHost = recoveryHost
    this.downloads = downloads
    this.dialogs = dialogs
    this.emulation = initialEmulation ? cloneEmulationProfile(initialEmulation) : defaultEmulationProfile()
    this.trackerBlocker = this.createTrackerBlocker(cdp)
    this.bindCdpListeners()
  }

  private createTrackerBlocker(cdp: CdpConnection): CdpTrackerBlocker {
    return new CdpTrackerBlocker(cdp, this.trackerBlocking, {
      onBlocked: (ev) => {
        this.blockedByFetch.set(ev.url, ev.reason)
        if (this.blockedByFetch.size > 200) {
          const first = this.blockedByFetch.keys().next().value
          if (first !== undefined) this.blockedByFetch.delete(first)
        }
      },
    })
  }

  private runWithRecovery<T>(fn: () => Promise<T>): Promise<T> {
    return this.recoveryHost ? this.recoveryHost.withRecovery(fn) : fn()
  }

  private bindCdpListeners(): void {
    this.cdp.on('Page.frameNavigated', (params, sessionId) => {
      if (sessionId) return
      const frame = params.frame as { id?: string; parentId?: string; url?: string } | undefined
      if (frame && !frame.parentId && frame.url) {
        if (frame.id) this.mainFrameId = frame.id
        this.url = frame.url
        this.epoch += 1
        this.networkIdle.onNavigationReset()
      }
    })
    this.cdp.on('Page.loadEventFired', (_params, sessionId) => {
      if (!sessionId) this.loading = false
    })
    this.cdp.on('Runtime.executionContextCreated', (params, sessionId) => {
      const ctx = params.context as
        | { id?: number; auxData?: { frameId?: string; isDefault?: boolean; type?: string } }
        | undefined
      if (typeof ctx?.id === 'number' && ctx.auxData?.frameId && ctx.auxData.isDefault) {
        this.frameContexts.set(`${sessionId ?? ''}:${ctx.auxData.frameId}`, ctx.id)
      }
    })
    this.cdp.on('Runtime.executionContextDestroyed', (params, sessionId) => {
      const destroyedId = params.executionContextId
      const prefix = `${sessionId ?? ''}:`
      for (const [key, val] of this.frameContexts) {
        if (key.startsWith(prefix) && val === destroyedId) {
          this.frameContexts.delete(key)
        }
      }
    })
    this.cdp.on('Runtime.executionContextsCleared', (_params, sessionId) => {
      const prefix = `${sessionId ?? ''}:`
      for (const key of [...this.frameContexts.keys()]) {
        if (key.startsWith(prefix)) this.frameContexts.delete(key)
      }
    })
    this.cdp.on('Target.attachedToTarget', (params) => {
      const childSessionId = String(params.sessionId ?? '')
      const targetInfo = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined
      if (childSessionId && targetInfo?.targetId && targetInfo.type === 'iframe') {
        this.oopifSessions.set(targetInfo.targetId, childSessionId)
        void Promise.all([
          this.cdp.sendToSession(childSessionId, 'Runtime.enable').catch(() => {}),
          this.cdp.sendToSession(childSessionId, 'Page.enable').catch(() => {}),
          this.cdp.sendToSession(childSessionId, 'DOM.enable').catch(() => {}),
        ])
      }
    })
    this.cdp.on('Target.detachedFromTarget', (params) => {
      const detachedSessionId = String(params.sessionId ?? '')
      if (!detachedSessionId) return
      for (const [frameId, sid] of this.oopifSessions) {
        if (sid === detachedSessionId) this.oopifSessions.delete(frameId)
      }
      const prefix = `${detachedSessionId}:`
      for (const key of [...this.frameContexts.keys()]) {
        if (key.startsWith(prefix)) this.frameContexts.delete(key)
      }
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
      const req = params.request as
        | {
            url?: string
            method?: string
            headers?: Record<string, unknown>
            postData?: string
            hasPostData?: boolean
          }
        | undefined
      if (idStr && req?.url) {
        this.reqStart.set(idStr, {
          url: req.url,
          method: req.method ?? 'GET',
          ts: Date.now(),
          requestHeaders: normalizeHeadersMap(req.headers),
          ...(typeof req.postData === 'string' ? { postData: req.postData } : {}),
          ...(req.hasPostData ? { hasPostData: true } : {}),
        })
        this.networkIdle.onRequestStart(idStr, req.url, params.type ? String(params.type) : undefined)
      }
    })
    this.cdp.on('Network.loadingFinished', (params) => {
      const idStr = String(params.requestId ?? '')
      if (idStr) {
        this.networkIdle.onRequestFinish(idStr)
        if (typeof params.encodedDataLength === 'number') {
          this.networkRecorder.updateEncodedDataLength(idStr, params.encodedDataLength)
        }
      }
    })
    this.cdp.on('Network.requestServedFromCache', (params) => {
      const idStr = String(params.requestId ?? '')
      if (idStr) {
        this.networkIdle.onRequestFinish(idStr)
      }
    })
    this.cdp.on('Network.responseReceived', (params) => {
      const idStr = String(params.requestId ?? '')
      const res = params.response as
        | {
            url?: string
            status?: number
            statusText?: string
            headers?: Record<string, unknown>
            mimeType?: string
            encodedDataLength?: number
          }
        | undefined
      const started = this.reqStart.get(idStr)
      this.reqStart.delete(idStr)
      const status = Number(res?.status ?? 0)
      this.networkRecorder.record({
        cdpRequestId: idStr || undefined,
        url: res?.url ?? started?.url ?? '',
        method: started?.method ?? 'GET',
        status,
        statusText: typeof res?.statusText === 'string' && res.statusText ? res.statusText : undefined,
        ok: status >= 200 && status < 400,
        resourceType: params.type ? String(params.type) : undefined,
        mimeType: typeof res?.mimeType === 'string' && res.mimeType ? res.mimeType : undefined,
        encodedDataLength: typeof res?.encodedDataLength === 'number' ? res.encodedDataLength : undefined,
        durationMs: started ? Date.now() - started.ts : undefined,
        ts: Date.now(),
        requestHeaders: started?.requestHeaders,
        responseHeaders: normalizeHeadersMap(res?.headers),
        requestBody: started?.postData,
        hasPostData: started?.hasPostData,
      })
    })
    this.cdp.on('Network.loadingFailed', (params) => {
      const idStr = String(params.requestId ?? '')
      if (idStr) {
        this.networkIdle.onRequestFinish(idStr)
      }
      const started = this.reqStart.get(idStr)
      this.reqStart.delete(idStr)
      const url = started?.url ?? ''
      const errorText = String(params.errorText ?? 'failed')
      let blocked = false
      let blockedReason: string | undefined

      if (url && this.blockedByFetch.has(url)) {
        blocked = true
        blockedReason = this.blockedByFetch.get(url)
        this.blockedByFetch.delete(url)
      } else if (url && (params.blockedReason === 'inspector' || errorText === 'net::ERR_BLOCKED_BY_CLIENT')) {
        const netMatch = this.trackerBlocker.recordNetworkLevelBlock(url)
        if (netMatch.blocked) {
          blocked = true
          blockedReason = netMatch.reason ?? 'tracker'
        }
      }

      this.networkRecorder.record({
        cdpRequestId: idStr || undefined,
        url,
        method: started?.method ?? 'GET',
        ok: false,
        resourceType: params.type ? String(params.type) : undefined,
        durationMs: started ? Date.now() - started.ts : undefined,
        ts: Date.now(),
        error: errorText,
        ...(blocked ? { blocked: true, blockedReason } : {}),
        requestHeaders: started?.requestHeaders,
        requestBody: started?.postData,
        hasPostData: started?.hasPostData,
      })
    })
    this.cdp.on('Browser.downloadWillBegin', (params) => {
      if (!this.downloads) return
      const guid = String(params.guid ?? '')
      if (!guid) return
      const url = String(params.url ?? '')
      const suggestedFilename =
        typeof params.suggestedFilename === 'string' ? params.suggestedFilename : undefined
      const { shouldCancel } = this.downloads.recordWillBegin({
        id: guid,
        tabId: this.id,
        url,
        suggestedFilename,
      })
      if (shouldCancel) {
        void this.cdp.send('Browser.cancelDownload', { guid }).catch(() => {})
      }
    })
    this.cdp.on('Browser.downloadProgress', (params) => {
      if (!this.downloads) return
      const guid = String(params.guid ?? '')
      if (!guid) return
      const state = String(params.state ?? 'inProgress')
      const receivedBytes = typeof params.receivedBytes === 'number' ? params.receivedBytes : undefined
      const totalBytes = typeof params.totalBytes === 'number' ? params.totalBytes : undefined
      const { shouldCancel } = this.downloads.recordProgress({
        id: guid,
        state,
        receivedBytes,
        totalBytes,
      })
      if (shouldCancel) {
        void this.cdp.send('Browser.cancelDownload', { guid }).catch(() => {})
      }
    })
    this.cdp.on('Page.javascriptDialogOpening', (params) => {
      const type = typeof params.type === 'string' ? params.type : 'alert'
      const message = typeof params.message === 'string' ? params.message : ''
      const url = typeof params.url === 'string' ? params.url : this.url
      const defaultPrompt = typeof params.defaultPrompt === 'string' ? params.defaultPrompt : undefined
      const hasBrowserHandler = typeof params.hasBrowserHandler === 'boolean' ? params.hasBrowserHandler : undefined

      if (this.dialogs) {
        const decision = this.dialogs.handleOpening({
          tabId: this.id,
          type,
          message,
          url,
          defaultPrompt,
          hasBrowserHandler,
        })
        const cdpParams: Record<string, unknown> = { accept: decision.accept }
        if (decision.entry.type === 'prompt' && decision.accept) {
          cdpParams.promptText = decision.promptText ?? ''
        }
        void this.cdp.send('Page.handleJavaScriptDialog', cdpParams).catch(() => {})
      } else {
        // Safety fallback: never allow a modal dialog to hang headless execution
        void this.cdp
          .send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' })
          .catch(() => {})
      }
    })
    this.cdp.on('Page.javascriptDialogClosed', (params) => {
      if (!this.dialogs) return
      this.dialogs.recordClosed({
        tabId: this.id,
        result: typeof params.result === 'boolean' ? params.result : undefined,
        userInput: typeof params.userInput === 'string' ? params.userInput : undefined,
      })
    })
  }

  async applyDownloadBehavior(): Promise<void> {
    if (!this.downloads) return
    const downloadPath = this.downloads.ensureQuarantineDir()
    try {
      await this.cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath,
        eventsEnabled: true,
      })
    } catch {
      await this.cdp
        .send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath,
        })
        .catch(() => {})
    }
  }

  async init(): Promise<void> {
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Network.enable'),
      this.cdp.send('DOM.enable').catch(() => {}),
    ])
    await this.applyEmulation()
    await this.applyDownloadBehavior()
    await this.cdp
      .send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {})
    await this.trackerBlocker.enable()
  }

  /**
   * Transparently reattach this tab to a newly launched Chromium process after crash recovery.
   */
  async reattach(
    newTargetId: string,
    newCdp: CdpConnection,
    newCdpPort: number,
    opts: { restoreUrl?: boolean } = {},
  ): Promise<boolean> {
    const prevUrl = this.url
    const oldCdp = this.cdp
    this.targetId = newTargetId
    this.cdp = newCdp
    this.cdpPort = newCdpPort
    this.mainFrameId = null
    this.frameContexts.clear()
    this.oopifSessions.clear()
    this.reqStart.clear()
    this.blockedByFetch.clear()
    this.networkIdle.onNavigationReset()
    this.loading = false
    this.epoch += 1
    this.trackerBlocker = this.createTrackerBlocker(newCdp)
    this.bindCdpListeners()

    await oldCdp.close().catch(() => {})
    await this.init()

    if (opts.restoreUrl !== false && shouldRestoreTabUrl(prevUrl)) {
      try {
        await this.navigateDirect(prevUrl)
        return true
      } catch {
        // Page may be temporarily unreachable; tab is still attached and usable
        return false
      }
    }
    return false
  }

  private async applyEmulation(): Promise<void> {
    const { viewport, userAgent, acceptLanguage, platform, extraHeaders } = this.emulation
    const ops: Array<Promise<unknown>> = [
      this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: viewport.mobile,
      }),
      this.cdp
        .send('Emulation.setTouchEmulationEnabled', {
          enabled: viewport.hasTouch,
          maxTouchPoints: viewport.hasTouch ? 5 : 1,
        })
        .catch(() => {}),
      this.cdp.send('Network.setExtraHTTPHeaders', {
        headers: extraHeaders,
      }),
    ]
    if (userAgent) {
      ops.push(
        this.cdp.send('Network.setUserAgentOverride', {
          userAgent,
          ...(acceptLanguage ? { acceptLanguage } : {}),
          ...(platform ? { platform } : {}),
        }),
      )
    }
    await Promise.all(ops)
  }

  getEmulation(): EmulationProfile {
    return cloneEmulationProfile(this.emulation)
  }

  async setEmulation(opts: EmulationOptions, mode?: EmulationUpdateMode): Promise<EmulationProfile> {
    this.emulation = resolveEmulationProfile(opts, this.emulation, mode)
    await this.runWithRecovery(() => this.applyEmulation())
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

  private async evalJson<T>(expression: string, sessionId?: string, contextId?: number): Promise<T> {
    const params: Record<string, unknown> = {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }
    if (contextId !== undefined) params.contextId = contextId
    const res = await this.cdp.sendToSession<{
      result?: { value?: T; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(sessionId, 'Runtime.evaluate', params)
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate exception')
    }
    return res.result?.value as T
  }

  private async evalInFrame<T>(frameId: string | undefined, sessionId: string | undefined, expression: string): Promise<T> {
    if (!frameId || (frameId === this.mainFrameId && !sessionId)) {
      return this.evalJson<T>(expression)
    }

    const oopifSession = this.oopifSessions.get(frameId)
    const targetSessionId = sessionId ?? oopifSession

    // If this frame is the root of an OOPIF target, evaluate directly in its session's default context
    if (oopifSession && targetSessionId === oopifSession) {
      return this.evalJson<T>(expression, oopifSession)
    }

    // Same-process child frame (either on main session or nested inside an OOPIF session)
    const ctxKey = `${targetSessionId ?? ''}:${frameId}`
    const knownCtx = this.frameContexts.get(ctxKey)
    if (knownCtx !== undefined) {
      try {
        return await this.evalJson<T>(expression, targetSessionId, knownCtx)
      } catch {
        this.frameContexts.delete(ctxKey)
      }
    }

    const world = await this.cdp.sendToSession<{ executionContextId: number }>(
      targetSessionId,
      'Page.createIsolatedWorld',
      { frameId, worldName: 'troy-advanced' },
    )
    return this.evalJson<T>(expression, targetSessionId, world.executionContextId)
  }

  private async getFrameOwnerInfo(frameId: string, parentSessionId?: string): Promise<FrameOwnerInfo | null> {
    try {
      const owner = await this.cdp.sendToSession<{ backendNodeId?: number }>(
        parentSessionId,
        'DOM.getFrameOwner',
        { frameId },
      )
      if (!owner.backendNodeId) return null
      const resolved = await this.cdp.sendToSession<{ object?: { objectId?: string } }>(
        parentSessionId,
        'DOM.resolveNode',
        { backendNodeId: owner.backendNodeId },
      )
      const objectId = resolved.object?.objectId
      if (!objectId) return null
      try {
        const res = await this.cdp.sendToSession<{ result?: { value?: FrameOwnerInfo } }>(
          parentSessionId,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: IFRAME_OWNER_INFO_FUNCTION,
            returnByValue: true,
          },
        )
        return res.result?.value ?? null
      } finally {
        void this.cdp.sendToSession(parentSessionId, 'Runtime.releaseObject', { objectId }).catch(() => {})
      }
    } catch {
      return null
    }
  }

  private async discoverFrames(): Promise<DiscoveredFrame[]> {
    let rootTree: CdpFrameTreeNode | undefined
    try {
      const res = await this.cdp.send<{ frameTree?: CdpFrameTreeNode }>('Page.getFrameTree')
      rootTree = res.frameTree
    } catch {
      return []
    }
    if (!rootTree?.frame?.id) return []
    this.mainFrameId = rootTree.frame.id
    const mainUrl = rootTree.frame.url || this.url

    const discovered: DiscoveredFrame[] = []
    const seen = new Set<string>([rootTree.frame.id])

    const walkChildren = async (
      children: CdpFrameTreeNode[] | undefined,
      parent: {
        frameId: string
        url: string
        offsetX: number
        offsetY: number
        selectorChain: string[]
        sessionId?: string
        depth: number
      },
    ): Promise<void> => {
      if (!children || children.length === 0) return
      if (parent.depth >= MAX_FRAME_DEPTH || discovered.length >= MAX_DISCOVERED_FRAMES) return

      for (const node of children) {
        if (discovered.length >= MAX_DISCOVERED_FRAMES) break
        const fid = node.frame?.id
        if (!fid || seen.has(fid)) continue
        seen.add(fid)

        const owner = await this.getFrameOwnerInfo(fid, parent.sessionId)
        if (owner && !owner.visible) continue

        const offsetX = parent.offsetX + (owner?.contentX ?? 0)
        const offsetY = parent.offsetY + (owner?.contentY ?? 0)
        const box = owner?.box ? offsetRect(owner.box, parent.offsetX, parent.offsetY) : undefined
        const seg = owner?.selector || `frame:${fid}`
        const selectorChain = [...parent.selectorChain, seg]
        const frameUrl = node.frame.url || 'about:blank'
        const oopifSid = this.oopifSessions.get(fid)
        const childSessionId = oopifSid ?? parent.sessionId

        const entry: DiscoveredFrame = {
          frameId: fid,
          parentFrameId: parent.frameId,
          url: frameUrl,
          name: node.frame.name || owner?.name || undefined,
          title: owner?.title || undefined,
          selectorChain,
          offsetX,
          offsetY,
          box,
          sessionId: childSessionId,
          parentSessionId: parent.sessionId,
          depth: parent.depth + 1,
          crossOrigin: isCrossOriginUrl(mainUrl, frameUrl),
        }
        discovered.push(entry)

        let nestedChildren = node.childFrames
        // For OOPIFs, query the OOPIF's own Page.getFrameTree if main tree didn't include its nested children
        if (oopifSid && (!nestedChildren || nestedChildren.length === 0)) {
          try {
            const subTree = await this.cdp.sendToSession<{ frameTree?: CdpFrameTreeNode }>(oopifSid, 'Page.getFrameTree')
            nestedChildren = subTree.frameTree?.childFrames
          } catch {
            // ignore
          }
        }

        await walkChildren(nestedChildren, {
          frameId: fid,
          url: frameUrl,
          offsetX,
          offsetY,
          selectorChain,
          sessionId: childSessionId,
          depth: parent.depth + 1,
        })
      }
    }

    await walkChildren(rootTree.childFrames, {
      frameId: rootTree.frame.id,
      url: mainUrl,
      offsetX: 0,
      offsetY: 0,
      selectorChain: [],
      sessionId: undefined,
      depth: 0,
    })

    // Site Isolation (OOPIF): cross-site iframes live in their own CDP target sessions
    // and are omitted from the main session's Page.getFrameTree. Merge any attached OOPIF
    // targets via their own Page.getFrameTree + parent DOM.getFrameOwner.
    if (this.oopifSessions.size > 0 && discovered.length < MAX_DISCOVERED_FRAMES) {
      const parentById = new Map<
        string,
        {
          frameId: string
          url: string
          offsetX: number
          offsetY: number
          selectorChain: string[]
          sessionId?: string
          depth: number
        }
      >()
      parentById.set(rootTree.frame.id, {
        frameId: rootTree.frame.id,
        url: mainUrl,
        offsetX: 0,
        offsetY: 0,
        selectorChain: [],
        sessionId: undefined,
        depth: 0,
      })
      for (const f of discovered) {
        parentById.set(f.frameId, {
          frameId: f.frameId,
          url: f.url,
          offsetX: f.offsetX,
          offsetY: f.offsetY,
          selectorChain: f.selectorChain,
          sessionId: f.sessionId,
          depth: f.depth,
        })
      }

      const pendingOopifs: Array<{ targetId: string; sessionId: string; subTree: CdpFrameTreeNode }> = []
      for (const [targetId, sid] of this.oopifSessions) {
        if (seen.has(targetId)) continue
        try {
          const res = await this.cdp.sendToSession<{ frameTree?: CdpFrameTreeNode }>(sid, 'Page.getFrameTree')
          if (res.frameTree?.frame?.id) {
            pendingOopifs.push({ targetId, sessionId: sid, subTree: res.frameTree })
          }
        } catch {
          // OOPIF may have detached
        }
      }

      let progress = true
      while (progress && pendingOopifs.length > 0 && discovered.length < MAX_DISCOVERED_FRAMES) {
        progress = false
        for (let i = 0; i < pendingOopifs.length; i++) {
          const item = pendingOopifs[i]!
          const fid = item.subTree.frame.id
          if (seen.has(fid)) {
            pendingOopifs.splice(i, 1)
            i -= 1
            continue
          }
          const parentId = item.subTree.frame.parentId || rootTree.frame.id
          const parent = parentById.get(parentId)
          if (!parent) continue

          progress = true
          pendingOopifs.splice(i, 1)
          i -= 1
          seen.add(fid)

          if (parent.depth >= MAX_FRAME_DEPTH) continue

          const owner = await this.getFrameOwnerInfo(fid, parent.sessionId)
          if (owner && !owner.visible) continue

          const offsetX = parent.offsetX + (owner?.contentX ?? 0)
          const offsetY = parent.offsetY + (owner?.contentY ?? 0)
          const box = owner?.box ? offsetRect(owner.box, parent.offsetX, parent.offsetY) : undefined
          const seg = owner?.selector || `frame:${fid}`
          const selectorChain = [...parent.selectorChain, seg]
          const frameUrl = item.subTree.frame.url || 'about:blank'

          const entry: DiscoveredFrame = {
            frameId: fid,
            parentFrameId: parent.frameId,
            url: frameUrl,
            name: item.subTree.frame.name || owner?.name || undefined,
            title: owner?.title || undefined,
            selectorChain,
            offsetX,
            offsetY,
            box,
            sessionId: item.sessionId,
            parentSessionId: parent.sessionId,
            depth: parent.depth + 1,
            crossOrigin: isCrossOriginUrl(mainUrl, frameUrl),
          }
          discovered.push(entry)
          parentById.set(fid, {
            frameId: fid,
            url: frameUrl,
            offsetX,
            offsetY,
            selectorChain,
            sessionId: item.sessionId,
            depth: parent.depth + 1,
          })

          await walkChildren(item.subTree.childFrames, {
            frameId: fid,
            url: frameUrl,
            offsetX,
            offsetY,
            selectorChain,
            sessionId: item.sessionId,
            depth: parent.depth + 1,
          })
        }
      }
    }

    return discovered
  }

  private async resolveFrameElementId(
    segment: string,
    parentFrameId: string | undefined,
    parentSessionId: string | undefined,
  ): Promise<string | null> {
    const expr = `(() => {
      ${SHADOW_DOM_QUERY_HELPER}
      try {
        return querySelectorDeep(${JSON.stringify(segment)});
      } catch {
        return null;
      }
    })()`

    const oopifSession = parentFrameId ? this.oopifSessions.get(parentFrameId) : undefined
    const targetSessionId = parentSessionId ?? oopifSession

    const params: Record<string, unknown> = { expression: expr, returnByValue: false }
    if (parentFrameId && parentFrameId !== this.mainFrameId && (!oopifSession || targetSessionId !== oopifSession)) {
      const ctxKey = `${targetSessionId ?? ''}:${parentFrameId}`
      const knownCtx = this.frameContexts.get(ctxKey)
      if (knownCtx !== undefined) {
        params.contextId = knownCtx
      } else {
        try {
          const world = await this.cdp.sendToSession<{ executionContextId: number }>(
            targetSessionId,
            'Page.createIsolatedWorld',
            { frameId: parentFrameId, worldName: 'troy-advanced' },
          )
          params.contextId = world.executionContextId
        } catch {
          return null
        }
      }
    }

    try {
      const res = await this.cdp.sendToSession<{ result?: { objectId?: string } }>(
        targetSessionId,
        'Runtime.evaluate',
        params,
      )
      const objectId = res.result?.objectId
      if (!objectId) return null
      try {
        const desc = await this.cdp.sendToSession<{
          node?: { frameId?: string; contentDocument?: { frameId?: string } }
        }>(targetSessionId, 'DOM.describeNode', { objectId })
        return desc.node?.frameId || desc.node?.contentDocument?.frameId || null
      } finally {
        void this.cdp.sendToSession(targetSessionId, 'Runtime.releaseObject', { objectId }).catch(() => {})
      }
    } catch {
      return null
    }
  }

  private async resolveFrameTarget(
    selector: string,
  ): Promise<{ ok: true; frame: DiscoveredFrame | null; targetSelector: string } | { ok: false; error: string }> {
    let parsed: ReturnType<typeof parseFrameSelector>
    try {
      parsed = parseFrameSelector(selector)
    } catch (err) {
      return { ok: false, error: `invalid selector: ${err instanceof Error ? err.message : String(err)}` }
    }

    if (!parsed.isFrameSelector) {
      return { ok: true, frame: null, targetSelector: parsed.targetSelector }
    }

    const frames = await this.discoverFrames()

    // Fast path 1: direct frame:<id> token
    if (parsed.frameSegments.length === 1) {
      const tokenFrameId = parseFrameIdToken(parsed.frameSegments[0]!)
      if (tokenFrameId) {
        const byId = frames.find((f) => f.frameId === tokenFrameId)
        if (byId) return { ok: true, frame: byId, targetSelector: parsed.targetSelector }
        return { ok: false, error: `iframe "${tokenFrameId}" not found` }
      }
    }

    // Fast path 2: exact selectorChain match (all snapshot-generated eN refs hit this)
    const exact = frames.find(
      (f) =>
        f.selectorChain.length === parsed.frameSegments.length &&
        f.selectorChain.every((seg, i) => seg === parsed.frameSegments[i]),
    )
    if (exact) {
      return { ok: true, frame: exact, targetSelector: parsed.targetSelector }
    }

    // Fallback: walk human-authored iframe CSS selectors step by step
    let currentFrame: DiscoveredFrame | null = null
    for (const seg of parsed.frameSegments) {
      const tokenId = parseFrameIdToken(seg)
      if (tokenId) {
        const next = frames.find((f) => f.frameId === tokenId)
        if (!next) return { ok: false, error: `iframe "${tokenId}" not found` }
        currentFrame = next
        continue
      }

      const childFrameId = await this.resolveFrameElementId(seg, currentFrame?.frameId, currentFrame?.sessionId)
      if (!childFrameId) {
        return { ok: false, error: `iframe matching "${seg}" not found` }
      }
      const next = frames.find((f) => f.frameId === childFrameId)
      if (!next) {
        return { ok: false, error: `iframe "${seg}" is hidden or detached` }
      }
      currentFrame = next
    }

    if (!currentFrame) {
      return { ok: false, error: 'iframe not found' }
    }
    return { ok: true, frame: currentFrame, targetSelector: parsed.targetSelector }
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    return this.runWithRecovery(() => this.navigateDirect(url))
  }

  private async navigateDirect(url: string): Promise<{ url: string; title: string }> {
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
    // Wait for initial SPA hydration (network idle + DOM mutation settle)
    await this.waitForSettleDirect({ timeoutMs: 1500, networkIdleMs: 200, domQuietMs: 150 })
    const meta = await this.evalJson<{ url: string; title: string }>('({ url: location.href, title: document.title || "" })')
    this.url = meta?.url || url
    this.title = meta?.title || this.url
    this.epoch += 1
    this.loading = false
    return { url: this.url, title: this.title }
  }

  async history(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }> {
    return this.runWithRecovery(() => this.historyDirect(direction))
  }

  private async historyDirect(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }> {
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
    return this.runWithRecovery(() => this.snapshotDirect())
  }

  private async snapshotDirect(): Promise<PageSnapshot> {
    const mainRaw = await this.evalJson<RawFrameSnapshot>(SNAPSHOT_SCRIPT)
    this.url = mainRaw.url || this.url
    this.title = mainRaw.title || this.title

    const childFrames = await this.discoverFrames()
    if (childFrames.length === 0) {
      return {
        tabId: this.id,
        url: this.url,
        title: this.title,
        epoch: this.epoch,
        viewport: mainRaw.viewport,
        blocks: mainRaw.blocks,
        elements: mainRaw.elements,
        text: mainRaw.text,
        capturedAt: Date.now(),
      }
    }

    const childInputs: ChildFrameSnapshotInput[] = []
    for (const frame of childFrames) {
      try {
        const sub = await this.evalInFrame<RawFrameSnapshot>(frame.frameId, frame.sessionId, SNAPSHOT_SCRIPT)
        if (!sub) continue
        if (sub.elements.length === 0 && sub.blocks.length === 0 && !(sub.text || '').trim()) {
          continue
        }
        childInputs.push({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.url,
          name: frame.name,
          title: frame.title,
          selectorChain: frame.selectorChain,
          offsetX: frame.offsetX,
          offsetY: frame.offsetY,
          box: frame.box,
          crossOrigin: frame.crossOrigin,
          snapshot: sub,
        })
      } catch {
        // Ignore detached or inaccessible child frames so the snapshot stays resilient
      }
    }

    const flattened = flattenFrameSnapshots(mainRaw, childInputs)
    return {
      tabId: this.id,
      url: this.url,
      title: this.title,
      epoch: this.epoch,
      viewport: mainRaw.viewport,
      blocks: flattened.blocks,
      elements: flattened.elements,
      ...(flattened.frames ? { frames: flattened.frames } : {}),
      text: flattened.text,
      capturedAt: Date.now(),
    }
  }

  async click(selector: string): Promise<{ ok: boolean; note?: string }> {
    return this.runWithRecovery(() => this.clickDirect(selector))
  }

  private async clickDirect(selector: string): Promise<{ ok: boolean; note?: string }> {
    const target = await this.resolveFrameTarget(selector)
    if (!target.ok) return { ok: false, note: target.error }

    const res = await this.evalInFrame<{ ok: boolean; x?: number; y?: number; note?: string }>(
      target.frame?.frameId,
      target.frame?.sessionId,
      `(() => {
        ${SHADOW_DOM_QUERY_HELPER}
        let el;
        try {
          el = querySelectorDeep(${JSON.stringify(target.targetSelector)});
        } catch (err) {
          return { ok: false, note: 'invalid selector: ' + String((err && err.message) || err) };
        }
        if (!el) return { ok: false, note: 'element not found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    )
    if (!res?.ok) return { ok: false, note: res?.note ?? 'not found' }

    const x = Math.round((target.frame?.offsetX ?? 0) + (res.x ?? 0))
    const y = Math.round((target.frame?.offsetY ?? 0) + (res.y ?? 0))
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
    return this.runWithRecovery(() => this.fillDirect(selector, text, clear))
  }

  private async fillDirect(selector: string, text: string, clear = true): Promise<{ ok: boolean; value?: string }> {
    const target = await this.resolveFrameTarget(selector)
    if (!target.ok) return { ok: false }

    const res = await this.evalInFrame<{ ok: boolean; value?: string }>(
      target.frame?.frameId,
      target.frame?.sessionId,
      `(() => {
        ${SHADOW_DOM_QUERY_HELPER}
        let el;
        try {
          el = querySelectorDeep(${JSON.stringify(target.targetSelector)});
        } catch {
          return { ok: false };
        }
        if (!el) return { ok: false };
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof el.focus === 'function') el.focus();
        if (el.isContentEditable) {
          const nextVal = ${clear ? '""' : 'String(el.textContent ?? "")'} + ${JSON.stringify(text)};
          el.textContent = nextVal;
          el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
          return { ok: true, value: String(el.textContent ?? '') };
        }
        const nextVal = ${clear ? '""' : 'String(el.value ?? "")'} + ${JSON.stringify(text)};
        const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, nextVal);
        else el.value = nextVal;
        el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        return { ok: true, value: String(el.value ?? '') };
      })()`,
    )
    return res ?? { ok: false }
  }

  async select(selector: string, value: string): Promise<{ ok: boolean; value?: string }> {
    return this.runWithRecovery(() => this.selectDirect(selector, value))
  }

  private async selectDirect(selector: string, value: string): Promise<{ ok: boolean; value?: string }> {
    const target = await this.resolveFrameTarget(selector)
    if (!target.ok) return { ok: false }

    const res = await this.evalInFrame<{ ok: boolean; value?: string }>(
      target.frame?.frameId,
      target.frame?.sessionId,
      `(() => {
        ${SHADOW_DOM_QUERY_HELPER}
        let el;
        try {
          el = querySelectorDeep(${JSON.stringify(target.targetSelector)});
        } catch {
          return { ok: false };
        }
        if (!el || el.tagName !== 'SELECT') return { ok: false };
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        const targetVal = ${JSON.stringify(value)}.toLowerCase();
        const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === targetVal || (o.text || '').trim().toLowerCase() === targetVal);
        if (!opt) return { ok: false };
        el.value = opt.value;
        el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        return { ok: true, value: opt.text || opt.value };
      })()`,
    )
    return res ?? { ok: false }
  }

  async press(key: string, selector?: string): Promise<{ ok: boolean; normalized?: string; modifiers?: number; error?: string }> {
    return this.runWithRecovery(() => this.pressDirect(key, selector))
  }

  private async pressDirect(key: string, selector?: string): Promise<{ ok: boolean; normalized?: string; modifiers?: number; error?: string }> {
    if (selector) {
      const target = await this.resolveFrameTarget(selector)
      if (!target.ok) {
        return { ok: false, error: target.error }
      }
      const focusRes = await this.evalInFrame<{ ok: boolean; error?: string }>(
        target.frame?.frameId,
        target.frame?.sessionId,
        `(() => {
          ${SHADOW_DOM_QUERY_HELPER}
          let el;
          try {
            el = querySelectorDeep(${JSON.stringify(target.targetSelector)});
          } catch (err) {
            return { ok: false, error: 'invalid selector: ' + String((err && err.message) || err) };
          }
          if (!el) return { ok: false, error: 'element not found' };
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
          if (typeof el.focus === 'function') el.focus();
          return { ok: true };
        })()`,
      )
      if (!focusRes?.ok) {
        return { ok: false, error: focusRes?.error ?? 'element not found' }
      }
    }
    try {
      const { chord } = await dispatchKeyChord((method, params) => this.cdp.send(method, params), key)
      await new Promise((r) => setTimeout(r, 120))
      return { ok: true, normalized: chord.normalized, modifiers: chord.modifiersBitmask }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async hover(selector: string): Promise<{ ok: boolean }> {
    return this.runWithRecovery(() => this.hoverDirect(selector))
  }

  private async hoverDirect(selector: string): Promise<{ ok: boolean }> {
    const target = await this.resolveFrameTarget(selector)
    if (!target.ok) return { ok: false }

    const res = await this.evalInFrame<{ ok: boolean; x?: number; y?: number }>(
      target.frame?.frameId,
      target.frame?.sessionId,
      `(() => {
        ${SHADOW_DOM_QUERY_HELPER}
        let el;
        try {
          el = querySelectorDeep(${JSON.stringify(target.targetSelector)});
        } catch {
          return { ok: false };
        }
        if (!el) return { ok: false };
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    )
    if (!res?.ok) return { ok: false }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round((target.frame?.offsetX ?? 0) + (res.x ?? 0)),
      y: Math.round((target.frame?.offsetY ?? 0) + (res.y ?? 0)),
    })
    return { ok: true }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount = 450) {
    return this.runWithRecovery(() => this.scrollDirect(direction, amount))
  }

  private async scrollDirect(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount = 450) {
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

  async waitForSettle(options: SettleOptions = {}): Promise<SettleResult> {
    return this.runWithRecovery(() => this.waitForSettleDirect(options))
  }

  private async waitForSettleDirect(options: SettleOptions = {}): Promise<SettleResult> {
    return waitForPageSettle(
      {
        checkNetwork: (now, opts) => {
          const status = this.networkIdle.getStatus({
            quietMs: opts.networkIdleMs,
            maxInflight: opts.maxInflightRequests,
            staleRequestMs: opts.staleRequestMs,
            now,
          })
          return { idle: status.idle, inflightCount: status.inflightCount }
        },
        checkDom: async (_now, opts) => {
          const dom = await this.evalJson<{ readyState: string; mutationCount: number; quietForMs: number }>(
            DOM_SETTLE_PROBE_SCRIPT,
          )
          const ready = dom.readyState !== 'loading'
          return {
            quiet: ready && dom.quietForMs >= opts.domQuietMs,
            mutationCount: dom.mutationCount,
            quietForMs: dom.quietForMs,
            readyState: dom.readyState,
          }
        },
      },
      options,
    )
  }

  async waitFor(options: WaitConditionOptions): Promise<WaitResult> {
    return this.runWithRecovery(() => this.waitForDirect(options))
  }

  private async waitForDirect(options: WaitConditionOptions): Promise<WaitResult> {
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

    let parsedSel: ReturnType<typeof parseFrameSelector> | null = null
    if (options.selector) {
      try {
        parsedSel = parseFrameSelector(options.selector)
      } catch (err) {
        return {
          ok: false,
          waitedMs: 0,
          error: `invalid selector "${options.selector}": ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    const buildSelectorProbeExpr = (sel: string, targetState: WaitState) => `(() => {
      ${SHADOW_DOM_QUERY_HELPER}
      let els;
      try {
        els = querySelectorAllDeep(${JSON.stringify(sel)});
      } catch (err) {
        return { selectorError: String((err && err.message) || err) };
      }
      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        if (el.hasAttribute('hidden')) return false;
        if (el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
        const st = window.getComputedStyle(el);
        if (!st) return false;
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
        if (Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
      };
      const target = ${JSON.stringify(targetState)};
      if (target === 'attached') {
        return { selectorMatched: els.length > 0 };
      }
      if (target === 'visible') {
        return { selectorMatched: els.some(isVisible) };
      }
      return { selectorMatched: els.length === 0 || els.every((el) => !isVisible(el)) };
    })()`

    const condRes = await pollUntil(
      async () => {
        let probe: {
          url: string
          title: string
          bodyText?: string
          selectorMatched?: boolean
          selectorError?: string
        }
        try {
          const checkMainSelector = Boolean(parsedSel && !parsedSel.isFrameSelector)
          probe = await this.evalJson(
            `(() => {
              const out = { url: String(location.href || ''), title: String(document.title || '') };
              const needText = ${JSON.stringify(Boolean(options.text))};
              if (needText) {
                const raw = (document.body && typeof document.body.innerText === 'string' ? document.body.innerText : '') ||
                  (document.documentElement && document.documentElement.textContent) || '';
                out.bodyText = raw + '\\n' + out.title;
              }
              const selector = ${JSON.stringify(checkMainSelector ? (parsedSel?.targetSelector ?? '') : '')};
              const targetState = ${JSON.stringify(state)};
              if (selector) {
                ${SHADOW_DOM_QUERY_HELPER}
                let els;
                try {
                  els = querySelectorAllDeep(selector);
                } catch (err) {
                  out.selectorError = String((err && err.message) || err);
                  return out;
                }
                const isVisible = (el) => {
                  if (!el || !el.isConnected) return false;
                  if (el.hasAttribute('hidden')) return false;
                  if (el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
                  const st = window.getComputedStyle(el);
                  if (!st) return false;
                  if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
                  if (Number(st.opacity) === 0) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
                };
                if (targetState === 'attached') {
                  out.selectorMatched = els.length > 0;
                } else if (targetState === 'visible') {
                  out.selectorMatched = els.some(isVisible);
                } else {
                  out.selectorMatched = els.length === 0 || els.every((el) => !isVisible(el));
                }
              }
              return out;
            })()`,
          )
        } catch {
          // Transient navigation / context-destroyed error: keep polling until timeout.
          return { satisfied: false }
        }

        if (probe.selectorError) {
          return { satisfied: false, fatalError: `invalid selector "${options.selector}": ${probe.selectorError}` }
        }

        if (probe.url && probe.url !== this.url) {
          this.url = probe.url
          this.title = probe.title || this.title
          this.epoch += 1
        }

        const urlOk = options.url ? matchesUrlPattern(probe.url || this.url, options.url) : true
        let textOk = options.text ? matchesText(probe.bodyText ?? '', options.text) : true
        let selectorOk = parsedSel ? Boolean(probe.selectorMatched) : true

        // Cross-frame selector check when explicit `iframe >> selector` is given
        if (parsedSel && parsedSel.isFrameSelector) {
          const target = await this.resolveFrameTarget(options.selector!)
          if (!target.ok || !target.frame) {
            selectorOk = state === 'hidden'
          } else {
            try {
              const subProbe = await this.evalInFrame<{ selectorMatched?: boolean; selectorError?: string }>(
                target.frame.frameId,
                target.frame.sessionId,
                buildSelectorProbeExpr(target.targetSelector, state),
              )
              if (subProbe?.selectorError) {
                return { satisfied: false, fatalError: `invalid selector "${options.selector}": ${subProbe.selectorError}` }
              }
              selectorOk = Boolean(subProbe?.selectorMatched)
            } catch {
              selectorOk = state === 'hidden'
            }
          }
        } else if (parsedSel && !parsedSel.isFrameSelector) {
          // Plain selector fallback into child frames when needed
          const needChildCheck = (state !== 'hidden' && !selectorOk) || (state === 'hidden' && selectorOk)
          if (needChildCheck) {
            const frames = await this.discoverFrames()
            for (const f of frames) {
              try {
                const subProbe = await this.evalInFrame<{ selectorMatched?: boolean; selectorError?: string }>(
                  f.frameId,
                  f.sessionId,
                  buildSelectorProbeExpr(parsedSel.targetSelector, state),
                )
                if (state === 'hidden') {
                  if (!subProbe?.selectorMatched) {
                    selectorOk = false
                    break
                  }
                } else if (subProbe?.selectorMatched) {
                  selectorOk = true
                  break
                }
              } catch {
                // ignore detached frame
              }
            }
          }
        }

        // Cross-frame text check if main frame didn't match yet
        if (options.text && !textOk) {
          const frames = await this.discoverFrames()
          for (const f of frames) {
            try {
              const subText = await this.evalInFrame<string>(
                f.frameId,
                f.sessionId,
                `(() => ((document.body && typeof document.body.innerText === 'string' ? document.body.innerText : '') || (document.documentElement && document.documentElement.textContent) || '') + '\\n' + String(document.title || ''))()`,
              )
              if (matchesText(subText ?? '', options.text)) {
                textOk = true
                break
              }
            } catch {
              // ignore detached frame
            }
          }
        }

        return {
          satisfied: urlOk && textOk && selectorOk,
          matched: {
            ...(options.text ? { text: textOk } : {}),
            ...(options.selector ? { selector: selectorOk, state } : {}),
            ...(options.url ? { url: urlOk, currentUrl: probe.url || this.url } : {}),
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

  async evaluate(expression: string): Promise<unknown> {
    return this.runWithRecovery(() => this.evalJson(expression))
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer | null> {
    return this.runWithRecovery(async () => {
      const res = await this.cdp.send<{ data?: string }>('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: Boolean(opts.fullPage),
      })
      return res.data ? Buffer.from(res.data, 'base64') : null
    })
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

    let requestBody = record.requestBody
    let requestBodyUnavailableReason: string | undefined
    if (requestBody === undefined && record.hasPostData && record.entry.cdpRequestId) {
      try {
        const postRes = await this.cdp.send('Network.getRequestPostData', {
          requestId: record.entry.cdpRequestId,
        })
        if (typeof postRes.postData === 'string') {
          requestBody = postRes.postData
          record.requestBody = requestBody
        }
      } catch (err) {
        requestBodyUnavailableReason = `CDP Network.getRequestPostData unavailable: ${String((err as Error)?.message ?? err)}`
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
    } else if (record.entry.status === 204 || record.entry.status === 304) {
      responseBodyUnavailableReason = `HTTP ${record.entry.status} has no response body`
    } else if (record.entry.cdpRequestId) {
      try {
        const bodyRes = await this.cdp.send('Network.getResponseBody', {
          requestId: record.entry.cdpRequestId,
        })
        const rawBody = typeof bodyRes.body === 'string' ? bodyRes.body : ''
        const isBase64 = Boolean(bodyRes.base64Encoded)
        record.cachedResponseBody = { body: rawBody, base64Encoded: isBase64 }
        responseBody = rawBody
        responseBase64Encoded = isBase64
      } catch (err) {
        responseBodyUnavailableReason = `CDP Network.getResponseBody unavailable: ${String((err as Error)?.message ?? err)}`
      }
    } else {
      responseBodyUnavailableReason = 'response body unavailable'
    }

    return buildNetworkBodyResult(
      record,
      {
        requestBody,
        requestBodyUnavailableReason,
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

  getBlockedTrackerStats(): BlockedTrackerStats {
    return this.trackerBlocker.getStats()
  }

  async getStorage(opts: { area?: StorageArea; keyPrefix?: string } = {}): Promise<OriginStorageSnapshot> {
    return this.runWithRecovery(() => this.getStorageDirect(opts))
  }

  private async getStorageDirect(opts: { area?: StorageArea; keyPrefix?: string } = {}): Promise<OriginStorageSnapshot> {
    const area = normalizeStorageArea(opts.area)
    const keyPrefix = typeof opts.keyPrefix === 'string' ? opts.keyPrefix : ''
    const payload = JSON.stringify({ area, keyPrefix })
    const raw = (await this.evalJson(`(() => {
      const cfg = ${payload};
      const origin = typeof window.location?.origin === 'string' ? window.location.origin : '';
      const readArea = (store) => {
        const out = {};
        if (!store) return out;
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (typeof k !== 'string') continue;
            if (cfg.keyPrefix && !k.startsWith(cfg.keyPrefix)) continue;
            const v = store.getItem(k);
            if (typeof v === 'string') out[k] = v;
          }
        } catch {}
        return out;
      };
      return {
        origin,
        localStorage: cfg.area === 'session' ? {} : readArea(window.localStorage),
        sessionStorage: cfg.area === 'local' ? {} : readArea(window.sessionStorage),
      };
    })()`)) as { origin?: string; localStorage?: Record<string, string>; sessionStorage?: Record<string, string> } | null

    const origin = normalizeStorageOrigin(raw?.origin ?? this.url) ?? ''
    if (!origin) {
      return { origin: '', localStorage: {}, sessionStorage: {} }
    }
    return {
      origin,
      localStorage: normalizeStorageMap(raw?.localStorage),
      sessionStorage: normalizeStorageMap(raw?.sessionStorage),
    }
  }

  async setStorage(
    data: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> },
    opts: { clearBeforeImport?: boolean } = {},
  ): Promise<{ origin: string; localKeys: number; sessionKeys: number }> {
    return this.runWithRecovery(() => this.setStorageDirect(data, opts))
  }

  private async setStorageDirect(
    data: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> },
    opts: { clearBeforeImport?: boolean } = {},
  ): Promise<{ origin: string; localKeys: number; sessionKeys: number }> {
    const payload = JSON.stringify({
      localStorage: data.localStorage ? normalizeStorageMap(data.localStorage) : null,
      sessionStorage: data.sessionStorage ? normalizeStorageMap(data.sessionStorage) : null,
      clearBeforeImport: Boolean(opts.clearBeforeImport),
    })
    const res = (await this.evalJson(`(() => {
      const cfg = ${payload};
      const origin = typeof window.location?.origin === 'string' ? window.location.origin : '';
      if (!origin || origin === 'null') {
        return { origin: '', localKeys: 0, sessionKeys: 0, error: 'opaque origin' };
      }
      let localKeys = 0;
      let sessionKeys = 0;
      if (cfg.localStorage !== null) {
        if (cfg.clearBeforeImport) window.localStorage.clear();
        for (const [k, v] of Object.entries(cfg.localStorage)) {
          window.localStorage.setItem(k, String(v));
          localKeys++;
        }
      }
      if (cfg.sessionStorage !== null) {
        if (cfg.clearBeforeImport) window.sessionStorage.clear();
        for (const [k, v] of Object.entries(cfg.sessionStorage)) {
          window.sessionStorage.setItem(k, String(v));
          sessionKeys++;
        }
      }
      return { origin, localKeys, sessionKeys };
    })()`)) as { origin?: string; localKeys?: number; sessionKeys?: number; error?: string } | null

    if (res?.error) {
      throw new Error(`Cannot set web storage on current tab (${res.error})`)
    }
    return {
      origin: normalizeStorageOrigin(res?.origin ?? this.url) ?? '',
      localKeys: Number(res?.localKeys ?? 0),
      sessionKeys: Number(res?.sessionKeys ?? 0),
    }
  }

  async clearStorage(opts: { area?: StorageArea; keys?: string[] } = {}): Promise<{
    origin: string
    removedLocal: number
    removedSession: number
  }> {
    return this.runWithRecovery(() => this.clearStorageDirect(opts))
  }

  private async clearStorageDirect(opts: { area?: StorageArea; keys?: string[] } = {}): Promise<{
    origin: string
    removedLocal: number
    removedSession: number
  }> {
    const area = normalizeStorageArea(opts.area)
    const keys = Array.isArray(opts.keys) && opts.keys.length > 0 ? opts.keys : null
    const payload = JSON.stringify({ area, keys })
    const res = (await this.evalJson(`(() => {
      const cfg = ${payload};
      const origin = typeof window.location?.origin === 'string' ? window.location.origin : '';
      if (!origin || origin === 'null') {
        return { origin: '', removedLocal: 0, removedSession: 0 };
      }
      const clearStore = (store) => {
        let removed = 0;
        try {
          if (cfg.keys) {
            for (const k of cfg.keys) {
              if (store.getItem(k) !== null) {
                store.removeItem(k);
                removed++;
              }
            }
          } else {
            removed = store.length;
            store.clear();
          }
        } catch {}
        return removed;
      };
      return {
        origin,
        removedLocal: cfg.area === 'session' ? 0 : clearStore(window.localStorage),
        removedSession: cfg.area === 'local' ? 0 : clearStore(window.sessionStorage),
      };
    })()`)) as { origin?: string; removedLocal?: number; removedSession?: number } | null

    return {
      origin: normalizeStorageOrigin(res?.origin ?? this.url) ?? '',
      removedLocal: Number(res?.removedLocal ?? 0),
      removedSession: Number(res?.removedSession ?? 0),
    }
  }

  async close(): Promise<void> {
    this.recoveryHost?.onTabClosed(this)
    await this.cdp.close()
    if (this.recoveryHost?.closeTarget) {
      await this.recoveryHost.closeTarget(this.targetId).catch(() => {})
      return
    }
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
  cdpUrl?: string
  cdpConnectTimeoutMs?: number
  trackerBlocking?: TrackerBlockingOptions
  emulation?: EmulationOptions
  crashRecovery?: CrashRecoveryOptions
  downloads?: DownloadPolicyOptions
  dialogs?: DialogPolicyOptions
}

export class ChromiumBrowserEngine implements BrowserEngine {
  readonly kind = 'chromium' as const
  private _cdpPort: number
  private preferredCdpPort?: number
  private chromeBin: string | null
  private profileDir: string | null
  private proc: ChildProcess | null
  private browserCdp: CdpClient | null
  private remoteCdpInfo: RemoteCdpInfo | null
  private nextTabId = 1
  private trackerBlocking?: TrackerBlockingOptions
  private defaultEmulation: EmulationProfile
  private recoveryOpts: Required<CrashRecoveryOptions>
  private downloads: DownloadQuarantineManager
  private dialogs: DialogManager
  private closing = false
  private status: CrashRecoveryStatus = 'healthy'
  private restartCount = 0
  private consecutiveRestarts = 0
  private totalCrashes = 0
  private startedAt = Date.now()
  private lastCrashAt: number | null = null
  private lastRecoveredAt: number | null = null
  private lastExitCode: number | null = null
  private lastExitSignal: string | null = null
  private lastError: string | null = null
  private recoveryPromise: Promise<void> | null = null
  private liveTabs = new Set<ChromiumTab>()
  private crashListeners = new Set<(ev: CrashRecoveryEvent) => void>()

  private constructor(cfg: {
    cdpPort: number
    preferredCdpPort?: number
    chromeBin: string | null
    profileDir: string | null
    proc: ChildProcess | null
    browserCdp?: CdpClient | null
    remoteCdpInfo?: RemoteCdpInfo | null
    trackerBlocking?: TrackerBlockingOptions
    defaultEmulation?: EmulationProfile
    crashRecovery?: CrashRecoveryOptions
    downloads?: DownloadPolicyOptions
    dialogs?: DialogPolicyOptions
  }) {
    this._cdpPort = cfg.cdpPort
    this.preferredCdpPort = cfg.preferredCdpPort
    this.chromeBin = cfg.chromeBin
    this.profileDir = cfg.profileDir
    this.proc = cfg.proc
    this.browserCdp = cfg.browserCdp ?? null
    this.remoteCdpInfo = cfg.remoteCdpInfo ?? null
    this.trackerBlocking = cfg.trackerBlocking
    this.defaultEmulation = cfg.defaultEmulation ? cloneEmulationProfile(cfg.defaultEmulation) : defaultEmulationProfile()
    this.recoveryOpts = resolveCrashRecoveryOptions(cfg.crashRecovery)
    const defaultQuarantineDir = cfg.profileDir
      ? path.join(cfg.profileDir, 'quarantine')
      : path.join(os.tmpdir(), `troy-advanced-quarantine-${process.pid}`)
    this.downloads = new DownloadQuarantineManager(cfg.downloads, defaultQuarantineDir)
    this.dialogs = new DialogManager(cfg.dialogs)
    if (this.proc) {
      this.attachProcessExitHandler(this.proc)
    }
  }

  get cdpPort(): number {
    return this._cdpPort
  }

  get remoteCdpUrl(): string | undefined {
    return this.remoteCdpInfo?.displayUrl
  }

  getRemoteCdpInfo(): RemoteCdpInfo | null {
    return this.remoteCdpInfo ? { ...this.remoteCdpInfo } : null
  }

  get canRecover(): boolean {
    return this.chromeBin !== null && this.profileDir !== null
  }

  getPid(): number | null {
    return this.proc?.pid ?? null
  }

  getProfileDir(): string | null {
    return this.profileDir
  }

  private isProcessDead(): boolean {
    if (!this.canRecover) return false
    if (!this.proc) return true
    return this.proc.exitCode !== null || this.proc.signalCode !== null
  }

  onCrashRecovery(fn: (ev: CrashRecoveryEvent) => void): () => void {
    this.crashListeners.add(fn)
    return () => this.crashListeners.delete(fn)
  }

  private emitCrashEvent(ev: CrashRecoveryEvent): void {
    for (const fn of this.crashListeners) {
      try {
        fn(ev)
      } catch {
        // ignore listener failure
      }
    }
  }

  getCrashRecoveryStats(): CrashRecoveryStats {
    return {
      enabled: this.canRecover && this.recoveryOpts.enabled,
      canRecover: this.canRecover,
      status: this.status,
      pid: this.proc?.pid ?? null,
      cdpPort: this._cdpPort,
      profileDir: this.profileDir,
      restartCount: this.restartCount,
      consecutiveRestarts: this.consecutiveRestarts,
      totalCrashes: this.totalCrashes,
      maxRestarts: this.recoveryOpts.maxRestarts,
      lastCrashAt: this.lastCrashAt,
      lastRecoveredAt: this.lastRecoveredAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastError: this.lastError,
    }
  }

  private attachProcessExitHandler(proc: ChildProcess): void {
    proc.once('exit', (code, signal) => {
      this.handleProcessExit(proc, code, signal)
    })
  }

  private handleProcessExit(exitedProc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closing || this.proc !== exitedProc) return
    this.totalCrashes += 1
    this.lastCrashAt = Date.now()
    this.lastExitCode = code
    this.lastExitSignal = signal
    this.status = 'crashed'
    this.emitCrashEvent({
      kind: 'chromium_crashed',
      ts: this.lastCrashAt,
      pid: exitedProc.pid,
      exitCode: code,
      signal,
      restartCount: this.restartCount,
      maxRestarts: this.recoveryOpts.maxRestarts,
      cdpPort: this._cdpPort,
      profileDir: this.profileDir ?? undefined,
    })

    if (this.recoveryOpts.enabled && this.canRecover) {
      void this.recover().catch(() => {
        // Error recorded in stats and emitted via chromium_recovery_failed
      })
    }
  }

  private static async spawnChromiumProcess(
    chromeBin: string,
    profileDir: string,
    viewport: { width: number; height: number },
    preferredPort?: number,
    cleanLocks = false,
  ): Promise<{ proc: ChildProcess; port: number }> {
    fs.mkdirSync(profileDir, { recursive: true })
    if (cleanLocks) {
      cleanupStaleProfileLocks(profileDir)
    }

    let port: number
    if (preferredPort && preferredPort > 0 && (await isPortAvailable(preferredPort))) {
      port = preferredPort
    } else {
      port = await allocateFreePort()
    }

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
      `--window-size=${viewport.width},${viewport.height}`,
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
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }
      throw new Error(`${(err as Error).message}${stderrTail ? `\nChrome stderr: ${stderrTail}` : ''}`)
    }

    return { proc, port }
  }

  static async launch(opts: ChromiumLaunchOptions = {}): Promise<ChromiumBrowserEngine> {
    const initialEmulation = resolveEmulationProfile(opts.emulation)

    if (opts.cdpUrl && opts.cdpUrl.trim()) {
      const timeoutMs = opts.cdpConnectTimeoutMs ?? 10000
      const discovered = await discoverRemoteCdp(opts.cdpUrl, { timeoutMs })
      const browserCdp = await CdpClient.connect(discovered.browserWsUrl, timeoutMs)

      let browserVersion = discovered.browserVersion
      let protocolVersion = discovered.protocolVersion
      if (!browserVersion) {
        try {
          const ver = await browserCdp.send<{ product?: string; protocolVersion?: string }>(
            'Browser.getVersion',
            {},
            3000,
          )
          if (ver.product) browserVersion = ver.product
          if (ver.protocolVersion) protocolVersion = ver.protocolVersion
        } catch {
          // Some minimal CDP proxies do not implement Browser.getVersion; ignore.
        }
      }

      const remoteCdpInfo: RemoteCdpInfo = {
        displayUrl: discovered.configured.displayUrl,
        transport: discovered.configured.transport,
        httpBaseUrl: discovered.httpBaseUrl,
        browserWsUrl: discovered.browserWsUrl,
        browserVersion,
        protocolVersion,
      }

      return new ChromiumBrowserEngine({
        cdpPort: discovered.configured.port,
        chromeBin: null,
        profileDir: null,
        proc: null,
        browserCdp,
        remoteCdpInfo,
        trackerBlocking: opts.trackerBlocking,
        defaultEmulation: initialEmulation,
        crashRecovery: { ...opts.crashRecovery, enabled: false },
        downloads: opts.downloads,
        dialogs: opts.dialogs,
      })
    }

    if (opts.remoteCdpPort && opts.remoteCdpPort > 0) {
      await waitForCdp(opts.remoteCdpPort, 5000)
      return new ChromiumBrowserEngine({
        cdpPort: opts.remoteCdpPort,
        chromeBin: null,
        profileDir: null,
        proc: null,
        trackerBlocking: opts.trackerBlocking,
        defaultEmulation: initialEmulation,
        crashRecovery: { ...opts.crashRecovery, enabled: false },
        downloads: opts.downloads,
        dialogs: opts.dialogs,
      })
    }

    const chromeBin = opts.chromeBin || findChromeBinary()
    if (!chromeBin) {
      throw new Error('No Chrome/Chromium binary found. Install chromium/google-chrome or use --engine lite.')
    }

    const profileDir = opts.profileDir || path.join(os.tmpdir(), `troy-advanced-chrome-${process.pid}`)
    const preferredCdpPort = opts.cdpPort && opts.cdpPort > 0 ? opts.cdpPort : undefined
    const { proc, port } = await ChromiumBrowserEngine.spawnChromiumProcess(
      chromeBin,
      profileDir,
      initialEmulation.viewport,
      preferredCdpPort,
      false,
    )

    return new ChromiumBrowserEngine({
      cdpPort: port,
      preferredCdpPort,
      chromeBin,
      profileDir,
      proc,
      trackerBlocking: opts.trackerBlocking,
      defaultEmulation: initialEmulation,
      crashRecovery: opts.crashRecovery,
      downloads: opts.downloads,
      dialogs: opts.dialogs,
    })
  }

  async recover(): Promise<void> {
    if (this.closing) return
    if (this.recoveryPromise) return this.recoveryPromise
    if (!this.canRecover || !this.recoveryOpts.enabled) {
      this.status = 'failed'
      this.lastError = 'Chromium crash recovery is disabled'
      throw new Error(this.lastError)
    }

    this.recoveryPromise = this.performRecovery().finally(() => {
      this.recoveryPromise = null
    })
    return this.recoveryPromise
  }

  private async performRecovery(): Promise<void> {
    const healthySince = this.lastRecoveredAt ?? this.startedAt
    if (this.recoveryOpts.resetWindowMs > 0 && Date.now() - healthySince >= this.recoveryOpts.resetWindowMs) {
      this.consecutiveRestarts = 0
    }

    if (this.consecutiveRestarts >= this.recoveryOpts.maxRestarts) {
      this.status = 'failed'
      this.lastError = `Chromium exceeded max crash restarts (${this.recoveryOpts.maxRestarts})`
      this.emitCrashEvent({
        kind: 'chromium_recovery_failed',
        ts: Date.now(),
        restartCount: this.restartCount,
        maxRestarts: this.recoveryOpts.maxRestarts,
        cdpPort: this._cdpPort,
        profileDir: this.profileDir ?? undefined,
        error: this.lastError,
      })
      throw new Error(this.lastError)
    }

    const attempt = this.consecutiveRestarts
    this.status = 'recovering'
    this.emitCrashEvent({
      kind: 'chromium_relaunching',
      ts: Date.now(),
      restartCount: this.restartCount,
      maxRestarts: this.recoveryOpts.maxRestarts,
      cdpPort: this._cdpPort,
      profileDir: this.profileDir ?? undefined,
    })

    const delayMs = computeRecoveryBackoffMs(attempt, this.recoveryOpts)
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
    if (this.closing) return

    try {
      const { proc: nextProc, port: nextPort } = await ChromiumBrowserEngine.spawnChromiumProcess(
        this.chromeBin!,
        this.profileDir!,
        this.defaultEmulation.viewport,
        this.preferredCdpPort,
        true,
      )

      if (this.closing) {
        try {
          nextProc.kill('SIGTERM')
        } catch {
          // ignore
        }
        return
      }

      this.proc = nextProc
      this._cdpPort = nextPort
      this.attachProcessExitHandler(nextProc)

      let restoredTabs = 0
      for (const tab of [...this.liveTabs]) {
        if (this.closing) break
        const target = await this.openNewTarget(this._cdpPort)
        const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
        const restored = await tab.reattach(target.id, cdp, this._cdpPort, {
          restoreUrl: this.recoveryOpts.restoreTabs,
        })
        if (restored) restoredTabs += 1
      }

      this.restartCount += 1
      this.consecutiveRestarts += 1
      this.lastRecoveredAt = Date.now()
      this.lastError = null
      this.status = 'healthy'

      this.emitCrashEvent({
        kind: 'chromium_recovered',
        ts: this.lastRecoveredAt,
        pid: nextProc.pid,
        restartCount: this.restartCount,
        maxRestarts: this.recoveryOpts.maxRestarts,
        cdpPort: this._cdpPort,
        profileDir: this.profileDir ?? undefined,
        restoredTabs,
      })
    } catch (err) {
      this.consecutiveRestarts += 1
      this.status = 'failed'
      this.lastError = String((err as Error)?.message ?? err)
      this.emitCrashEvent({
        kind: 'chromium_recovery_failed',
        ts: Date.now(),
        restartCount: this.restartCount,
        maxRestarts: this.recoveryOpts.maxRestarts,
        cdpPort: this._cdpPort,
        profileDir: this.profileDir ?? undefined,
        error: this.lastError,
      })
      throw err
    }
  }

  async ensureReady(): Promise<void> {
    if (this.closing) {
      throw new Error('Chromium engine is closed')
    }
    if (this.recoveryPromise) {
      await this.recoveryPromise
      return
    }
    if (this.status === 'crashed' || this.isProcessDead()) {
      await this.recover()
      return
    }
    if (this.status === 'failed') {
      throw new Error(this.lastError ?? 'Chromium crash recovery failed')
    }
  }

  async withRecovery<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureReady()
    try {
      return await fn()
    } catch (err) {
      if (!this.closing && this.canRecover && this.recoveryOpts.enabled && isCdpDisconnectError(err)) {
        if (!this.recoveryPromise && this.status === 'healthy' && !this.isProcessDead()) {
          // Give the child process exit event a brief moment to propagate
          await new Promise((r) => setTimeout(r, 100))
        }
        if (this.recoveryPromise || this.status === 'crashed' || this.isProcessDead()) {
          await this.recover()
          return await fn()
        }
      }
      throw err
    }
  }

  private async openNewTarget(port: number): Promise<{ id: string; webSocketDebuggerUrl: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() =>
      fetch(`http://127.0.0.1:${port}/json/new?about:blank`),
    )
    if (!res.ok) {
      throw new Error(`Failed to open Chromium tab (HTTP ${res.status})`)
    }
    return (await res.json()) as { id: string; webSocketDebuggerUrl: string }
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
    const prevDir = this.downloads.getQuarantineDir()
    const stats = this.downloads.setPolicy(opts)
    if (stats.quarantineDir !== prevDir) {
      for (const tab of this.liveTabs) {
        void tab.applyDownloadBehavior().catch(() => {})
      }
    }
    return stats
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
    const tab = await this.withRecovery(async () => {
      if (this.browserCdp) {
        if (this.browserCdp.isClosed()) {
          throw new Error(`Remote CDP WebSocket connection (${this.remoteCdpInfo?.displayUrl ?? 'remote'}) is closed`)
        }
        const createdTarget = await this.browserCdp.send<{ targetId?: string }>('Target.createTarget', {
          url: 'about:blank',
        })
        const targetId = createdTarget.targetId
        if (!targetId) {
          throw new Error('Remote CDP Target.createTarget did not return a targetId')
        }
        const attached = await this.browserCdp.send<{ sessionId?: string }>('Target.attachToTarget', {
          targetId,
          flatten: true,
        })
        const sessionId = attached.sessionId
        if (!sessionId) {
          await this.browserCdp.send('Target.closeTarget', { targetId }).catch(() => {})
          throw new Error('Remote CDP Target.attachToTarget did not return a sessionId')
        }
        const sessionCdp = this.browserCdp.createSession(sessionId)
        const created = new ChromiumTab(
          this.nextTabId++,
          targetId,
          sessionCdp,
          this._cdpPort,
          this.trackerBlocking,
          this.defaultEmulation,
          {
            withRecovery: (fn) => this.withRecovery(fn),
            onTabClosed: (t) => {
              this.liveTabs.delete(t)
            },
            closeTarget: async (tid) => {
              if (this.browserCdp && !this.browserCdp.isClosed()) {
                await this.browserCdp.send('Target.closeTarget', { targetId: tid }).catch(() => {})
              }
            },
          },
          this.downloads,
          this.dialogs,
        )
        await created.init()
        this.liveTabs.add(created)
        return created
      }

      const target = await this.openNewTarget(this._cdpPort)
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
      const created = new ChromiumTab(
        this.nextTabId++,
        target.id,
        cdp,
        this._cdpPort,
        this.trackerBlocking,
        this.defaultEmulation,
        {
          withRecovery: (fn) => this.withRecovery(fn),
          onTabClosed: (t) => {
            this.liveTabs.delete(t)
          },
        },
        this.downloads,
        this.dialogs,
      )
      await created.init()
      this.liveTabs.add(created)
      return created
    })
    if (initialUrl) {
      await tab.navigate(initialUrl)
    }
    return tab
  }

  private async withBrowserCdp<T>(fn: (cdp: CdpClient) => Promise<T>): Promise<T> {
    return this.withRecovery(async () => {
      if (this.browserCdp) {
        if (this.browserCdp.isClosed()) {
          throw new Error(`Remote CDP WebSocket connection (${this.remoteCdpInfo?.displayUrl ?? 'remote'}) is closed`)
        }
        return await fn(this.browserCdp)
      }
      const res = await fetch(`http://127.0.0.1:${this._cdpPort}/json/version`)
      if (!res.ok) {
        throw new Error(`Failed to query Chromium CDP version (HTTP ${res.status})`)
      }
      const info = (await res.json()) as { webSocketDebuggerUrl?: string }
      if (!info.webSocketDebuggerUrl) {
        throw new Error('Chromium /json/version did not return webSocketDebuggerUrl')
      }
      const cdp = await CdpClient.connect(info.webSocketDebuggerUrl)
      try {
        return await fn(cdp)
      } finally {
        await cdp.close()
      }
    })
  }

  async exportCookies(opts: CookieExportOptions = {}): Promise<BrowserCookie[]> {
    const rawCookies = await this.withBrowserCdp(async (cdp) => {
      const res = await cdp.send<{ cookies?: Array<Record<string, unknown>> }>('Storage.getCookies')
      return res.cookies ?? []
    })
    const normalized: BrowserCookie[] = []
    for (const raw of rawCookies) {
      const c = fromCdpCookie(raw)
      if (c) normalized.push(c)
    }
    return filterCookies(normalized, opts)
  }

  async importCookies(cookies: BrowserCookie[]): Promise<CookieImportResult> {
    const valid: BrowserCookie[] = []
    let skipped = 0
    const errors: string[] = []
    const nowSec = Math.floor(Date.now() / 1000)

    for (const raw of cookies) {
      const normalized = normalizeCookie(raw as unknown as Partial<BrowserCookie> & Record<string, unknown>)
      if (!normalized) {
        skipped++
        errors.push(`Invalid cookie skipped: ${String((raw as { name?: unknown })?.name ?? '<unnamed>')}`)
        continue
      }
      if (isCookieExpired(normalized, nowSec)) {
        skipped++
        continue
      }
      valid.push(normalized)
    }

    if (valid.length === 0) {
      return { imported: 0, skipped, errors }
    }

    return this.withBrowserCdp(async (cdp) => {
      try {
        await cdp.send('Storage.setCookies', { cookies: valid.map(toCdpCookieParam) })
        return { imported: valid.length, skipped, errors }
      } catch {
        // Fallback to per-cookie import so one rejected cookie does not block the rest
        let imported = 0
        for (const c of valid) {
          try {
            await cdp.send('Storage.setCookies', { cookies: [toCdpCookieParam(c)] })
            imported++
          } catch (err) {
            skipped++
            errors.push(`${c.name}@${c.domain}: ${String((err as Error)?.message ?? err)}`)
          }
        }
        return { imported, skipped, errors }
      }
    })
  }

  async clearCookies(opts: { domain?: string } = {}): Promise<number> {
    const all = await this.exportCookies({ includeExpired: true })
    if (!opts.domain) {
      await this.withBrowserCdp(async (cdp) => {
        await cdp.send('Storage.clearCookies')
      })
      return all.length
    }
    const keep = all.filter((c) => !domainFilterMatches(c.domain, opts.domain!))
    const removed = all.length - keep.length
    if (removed > 0) {
      await this.withBrowserCdp(async (cdp) => {
        await cdp.send('Storage.clearCookies')
        if (keep.length > 0) {
          await cdp.send('Storage.setCookies', { cookies: keep.map(toCdpCookieParam) })
        }
      })
    }
    return removed
  }

  async close(): Promise<void> {
    this.closing = true
    this.status = 'closed'
    if (this.browserCdp) {
      const tabsToClose = [...this.liveTabs]
      this.liveTabs.clear()
      for (const tab of tabsToClose) {
        await tab.close().catch(() => {})
      }
      await this.browserCdp.close().catch(() => {})
      this.browserCdp = null
      return
    }
    this.liveTabs.clear()
    if (this.proc && !this.proc.killed && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 200))
      if (!this.proc.killed && this.proc.exitCode === null && this.proc.signalCode === null) {
        this.proc.kill('SIGKILL')
      }
    }
  }
}
