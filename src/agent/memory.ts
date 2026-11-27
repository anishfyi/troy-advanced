// Persistent cross-session origin-scoped page memory (pages, elements, actions).

import fs from 'node:fs'
import path from 'node:path'
import type { ElementDescriptor } from '../types.js'
import { exactOrigin } from './omnibox.js'

const MAX_PAGES = 500
const MAX_ELEMENTS = 2000
const MAX_ACTIONS = 500
const MAX_EXCERPT = 3000

export interface MemoryPage {
  url: string
  origin: string
  title: string
  excerpt: string
  reads: number
  lastReadAt: number
}

export interface MemoryElement {
  key: string
  origin: string
  selector: string
  id?: string
  frameId?: string
  tag: string
  type: string
  role: string
  text: string
  label: string
  ariaLabel: string
  name: string
  pageUrl: string
  verified: number
  failed: number
  lastSeenAt: number
}

export interface MemoryAction {
  kind: string
  selector: string
  text: string
  fromUrl: string
  toUrl: string
  ok: boolean
  at: number
}

function tokenize(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

export class PageMemory {
  private pages = new Map<string, MemoryPage>()
  private elements = new Map<string, MemoryElement>()
  private actions: MemoryAction[] = []
  private readonly file: string | null

  constructor(file: string | null = null) {
    this.file = file
    if (file) this.load(file)
  }

  private load(file: string): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      for (const p of parsed.pages ?? []) {
        if (p?.url) this.pages.set(p.url, p)
      }
      for (const e of parsed.elements ?? []) {
        if (e?.key) this.elements.set(e.key, e)
      }
      if (Array.isArray(parsed.actions)) {
        this.actions = parsed.actions.slice(-MAX_ACTIONS)
      }
    } catch {
      // Fresh store
    }
  }

  flush(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const payload = JSON.stringify(
      {
        pages: [...this.pages.values()],
        elements: [...this.elements.values()],
        actions: this.actions,
      },
      null,
      2,
    )
    fs.writeFileSync(tmp, payload, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  recordRead(url: string, title: string, text: string, elements: ElementDescriptor[]): void {
    const origin = exactOrigin(url)
    if (!origin) return
    const now = Date.now()
    const existing = this.pages.get(url)
    this.pages.set(url, {
      url,
      origin,
      title,
      excerpt: text.slice(0, MAX_EXCERPT),
      reads: (existing?.reads ?? 0) + 1,
      lastReadAt: now,
    })

    for (const el of elements) {
      if (!el.selector) continue
      const key = `${origin}\0${el.selector}`
      const prev = this.elements.get(key)
      this.elements.set(key, {
        key,
        origin,
        selector: el.selector,
        ...(el.id ? { id: el.id } : {}),
        ...(el.frameId ? { frameId: el.frameId } : {}),
        tag: el.tag,
        type: el.type,
        role: el.role ?? '',
        text: el.text,
        label: el.label ?? '',
        ariaLabel: el.ariaLabel ?? '',
        name: el.name ?? '',
        pageUrl: url,
        verified: prev?.verified ?? 0,
        failed: prev?.failed ?? 0,
        lastSeenAt: now,
      })
    }

    this.trim()
    this.flush()
  }

  recordAction(entry: Omit<MemoryAction, 'at'>): void {
    const origin = exactOrigin(entry.fromUrl)
    const now = Date.now()
    this.actions.push({ ...entry, at: now })
    if (this.actions.length > MAX_ACTIONS) {
      this.actions = this.actions.slice(-MAX_ACTIONS)
    }
    if (origin && entry.selector) {
      const key = `${origin}\0${entry.selector}`
      const el = this.elements.get(key)
      if (el) {
        if (entry.ok) el.verified += 1
        else el.failed += 1
        el.lastSeenAt = now
      }
    }
    this.flush()
  }

  recordVerification(key: string, matched: boolean): void {
    const el = this.elements.get(key)
    if (!el) return
    if (matched) el.verified += 1
    else el.failed += 1
    el.lastSeenAt = Date.now()
    this.flush()
  }

  recall(query: string, opts: { origin?: string; limit?: number } = {}) {
    const qTokens = tokenize(query)
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10))
    const filterOrigin = opts.origin ? exactOrigin(opts.origin) || opts.origin : null

    const scoreText = (haystack: string): number => {
      if (qTokens.length === 0) return 1
      const lower = haystack.toLowerCase()
      let score = 0
      for (const t of qTokens) {
        if (lower.includes(t)) score += 1
      }
      return score
    }

    const matchedPages = [...this.pages.values()]
      .filter((p) => !filterOrigin || p.origin === filterOrigin)
      .map((p) => ({ page: p, score: scoreText(`${p.title} ${p.url} ${p.excerpt}`) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.page.lastReadAt - a.page.lastReadAt)
      .slice(0, limit)
      .map((x) => x.page)

    const matchedElements = [...this.elements.values()]
      .filter((e) => !filterOrigin || e.origin === filterOrigin)
      .map((e) => ({
        el: e,
        score: scoreText(`${e.text} ${e.label} ${e.ariaLabel} ${e.name} ${e.role} ${e.selector}`) + e.verified * 0.25,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.el.lastSeenAt - a.el.lastSeenAt)
      .slice(0, limit)
      .map((x) => x.el)

    const matchedActions = this.actions
      .filter((a) => !filterOrigin || exactOrigin(a.fromUrl) === filterOrigin)
      .filter((a) => scoreText(`${a.kind} ${a.text} ${a.fromUrl} ${a.toUrl}`) > 0)
      .slice(-limit)
      .reverse()

    return { pages: matchedPages, elements: matchedElements, actions: matchedActions }
  }

  forget(origin?: string): { removedPages: number; removedElements: number; removedActions: number } {
    if (!origin) {
      const res = {
        removedPages: this.pages.size,
        removedElements: this.elements.size,
        removedActions: this.actions.length,
      }
      this.pages.clear()
      this.elements.clear()
      this.actions = []
      this.flush()
      return res
    }
    const target = exactOrigin(origin) || origin
    let removedPages = 0
    let removedElements = 0
    for (const [k, p] of this.pages) {
      if (p.origin === target) {
        this.pages.delete(k)
        removedPages++
      }
    }
    for (const [k, e] of this.elements) {
      if (e.origin === target) {
        this.elements.delete(k)
        removedElements++
      }
    }
    const before = this.actions.length
    this.actions = this.actions.filter((a) => exactOrigin(a.fromUrl) !== target)
    this.flush()
    return { removedPages, removedElements, removedActions: before - this.actions.length }
  }

  stats() {
    return {
      pages: this.pages.size,
      elements: this.elements.size,
      actions: this.actions.length,
      origins: new Set([...this.pages.values()].map((p) => p.origin)).size,
    }
  }

  private trim(): void {
    if (this.pages.size > MAX_PAGES) {
      const sorted = [...this.pages.entries()].sort((a, b) => b[1].lastReadAt - a[1].lastReadAt)
      this.pages = new Map(sorted.slice(0, MAX_PAGES))
    }
    if (this.elements.size > MAX_ELEMENTS) {
      const sorted = [...this.elements.entries()].sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
      this.elements = new Map(sorted.slice(0, MAX_ELEMENTS))
    }
  }
}
