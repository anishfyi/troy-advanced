// Multi-agent tab isolation: named agent sessions (`x-troy-session`)
// with per-session owned-tab tracking, active-tab pointer, and origin scopes.

import type { AgentSessionSummary } from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

export const SESSION_HEADER = 'x-troy-session'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/

export type SessionIdParseResult =
  | { ok: true; sessionId?: string }
  | { ok: false; error: string }

/**
 * Parse and validate an optional agent session identifier (from `x-troy-session`
 * header, request body, or CLI `--session`).
 *
 * Empty / omitted values resolve to `{ ok: true, sessionId: undefined }`
 * (the legacy/default unscoped session).
 */
export function parseSessionId(raw: unknown): SessionIdParseResult {
  if (raw === undefined || raw === null) return { ok: true, sessionId: undefined }
  if (Array.isArray(raw)) {
    const nonEmpty = raw.map((v) => String(v ?? '').trim()).filter(Boolean)
    if (nonEmpty.length === 0) return { ok: true, sessionId: undefined }
    if (nonEmpty.length > 1) {
      return { ok: false, error: `multiple ${SESSION_HEADER} values are not allowed` }
    }
    return parseSessionId(nonEmpty[0])
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${SESSION_HEADER} must be a string` }
  }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, sessionId: undefined }
  if (!SESSION_ID_RE.test(trimmed)) {
    return {
      ok: false,
      error: `invalid ${SESSION_HEADER} "${trimmed.slice(0, 32)}": must be 1-64 chars matching [A-Za-z0-9][A-Za-z0-9._:@/-]*`,
    }
  }
  return { ok: true, sessionId: trimmed }
}

interface AgentSessionRecord {
  id: string
  createdAt: number
  lastActiveAt: number
  ownedTabIds: Set<number>
  activeTabId: number | null
  allowedOrigins: Set<string>
}

export class SessionRegistry {
  private sessions = new Map<string, AgentSessionRecord>()
  private tabOwners = new Map<number, string>()

  ensure(sessionId: string): AgentSessionRecord {
    const now = Date.now()
    let rec = this.sessions.get(sessionId)
    if (!rec) {
      rec = {
        id: sessionId,
        createdAt: now,
        lastActiveAt: now,
        ownedTabIds: new Set(),
        activeTabId: null,
        allowedOrigins: new Set(),
      }
      this.sessions.set(sessionId, rec)
    } else {
      rec.lastActiveAt = now
    }
    return rec
  }

  touch(sessionId: string): void {
    this.ensure(sessionId)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  get(sessionId: string): AgentSessionSummary | null {
    const rec = this.sessions.get(sessionId)
    return rec ? this.toSummary(rec) : null
  }

  list(): AgentSessionSummary[] {
    return [...this.sessions.values()].map((rec) => this.toSummary(rec))
  }

  addOwnedTab(sessionId: string, tabId: number, activate = false): void {
    const rec = this.ensure(sessionId)
    const prevOwner = this.tabOwners.get(tabId)
    if (prevOwner && prevOwner !== sessionId) {
      this.detachTabFromOwner(tabId, prevOwner)
    }
    rec.ownedTabIds.add(tabId)
    this.tabOwners.set(tabId, sessionId)
    if (rec.activeTabId === null || activate) {
      rec.activeTabId = tabId
    }
  }

  private detachTabFromOwner(tabId: number, ownerId: string): void {
    const rec = this.sessions.get(ownerId)
    if (!rec) return
    rec.ownedTabIds.delete(tabId)
    if (rec.activeTabId === tabId) {
      const next = rec.ownedTabIds.values().next()
      rec.activeTabId = next.done ? null : next.value
    }
  }

  removeTab(tabId: number): string | undefined {
    const owner = this.tabOwners.get(tabId)
    if (!owner) return undefined
    this.tabOwners.delete(tabId)
    this.detachTabFromOwner(tabId, owner)
    return owner
  }

  getTabOwner(tabId: number): string | undefined {
    return this.tabOwners.get(tabId)
  }

  isTabOwnedBy(tabId: number, sessionId: string): boolean {
    return this.tabOwners.get(tabId) === sessionId
  }

  getOwnedTabIds(sessionId: string): number[] {
    const rec = this.sessions.get(sessionId)
    return rec ? [...rec.ownedTabIds] : []
  }

  getActiveTabId(sessionId: string): number | null {
    const rec = this.sessions.get(sessionId)
    if (!rec) return null
    if (rec.activeTabId !== null && rec.ownedTabIds.has(rec.activeTabId)) {
      return rec.activeTabId
    }
    const first = rec.ownedTabIds.values().next()
    return first.done ? null : first.value
  }

  setActiveTabId(sessionId: string, tabId: number): boolean {
    const rec = this.sessions.get(sessionId)
    if (!rec || !rec.ownedTabIds.has(tabId)) return false
    rec.activeTabId = tabId
    rec.lastActiveAt = Date.now()
    return true
  }

  grantOrigin(sessionId: string, origin: string): void {
    const rec = this.ensure(sessionId)
    rec.allowedOrigins.add(origin)
  }

  getAllowedOrigins(sessionId: string): Set<string> {
    const rec = this.sessions.get(sessionId)
    return rec ? new Set(rec.allowedOrigins) : new Set()
  }

  delete(sessionId: string): { removed: boolean; ownedTabIds: number[] } {
    const rec = this.sessions.get(sessionId)
    if (!rec) return { removed: false, ownedTabIds: [] }
    const ownedTabIds = [...rec.ownedTabIds]
    for (const tabId of ownedTabIds) {
      this.tabOwners.delete(tabId)
    }
    this.sessions.delete(sessionId)
    return { removed: true, ownedTabIds }
  }

  private toSummary(rec: AgentSessionRecord): AgentSessionSummary {
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      lastActiveAt: rec.lastActiveAt,
      ownedTabIds: [...rec.ownedTabIds],
      activeTabId: rec.activeTabId,
      allowedOrigins: [...rec.allowedOrigins],
    }
  }
}

export function formatSessionsAscii(
  sessions: AgentSessionSummary[],
  opts: { width?: number } = {},
): string {
  const width = Math.max(60, Math.min(200, opts.width ?? 96))
  const rule = '-'.repeat(width)
  const lines: string[] = []
  lines.push(sanitizeAscii(`AGENT SESSIONS (${sessions.length})`))
  lines.push(rule)
  if (sessions.length === 0) {
    lines.push('(no named agent sessions)')
    lines.push(rule)
    return lines.join('\n')
  }
  lines.push('SESSION              TABS             ACTIVE  ORIGINS')
  lines.push(rule)
  for (const s of sessions) {
    const id = sanitizeAscii(s.id).slice(0, 20).padEnd(20)
    const tabs = (s.ownedTabIds.length > 0 ? s.ownedTabIds.map((t) => `t${t}`).join(',') : '-').slice(0, 16).padEnd(16)
    const active = (s.activeTabId !== null ? `t${s.activeTabId}` : '-').padEnd(7)
    const origins = s.allowedOrigins.length > 0 ? s.allowedOrigins.join(', ') : '(none)'
    const maxOrigins = Math.max(12, width - 47)
    const originsClean = sanitizeAscii(origins)
    const originsCell = originsClean.length > maxOrigins ? `${originsClean.slice(0, maxOrigins - 3)}...` : originsClean
    lines.push(sanitizeAscii(`${id} ${tabs} ${active} ${originsCell}`))
  }
  lines.push(rule)
  return lines.join('\n')
}
