// JavaScript dialog handling (alert/confirm/prompt/beforeunload) for headless runs (M28).
// Captures and auto-dismisses/accepts `Page.javascriptDialogOpening` events so headless
// automation never hangs waiting for interactive modal dismissal.

import type {
  DialogEntry,
  DialogEvent,
  DialogPolicyMode,
  DialogPolicyOptions,
  DialogQueuedResponse,
  DialogStats,
  DialogType,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

export const DEFAULT_DIALOG_MAX_HISTORY = 200
export const MAX_DIALOG_MESSAGE_LEN = 4096
export const MAX_DIALOG_QUEUE_LEN = 100

export function parseDialogMode(value: unknown): DialogPolicyMode | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === 'dismiss' || v === 'accept') return v
  return undefined
}

export function parseDialogType(value: unknown): DialogType | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === 'alert' || v === 'confirm' || v === 'prompt' || v === 'beforeunload') return v
  return undefined
}

function normalizeDialogType(value: unknown): DialogType {
  return parseDialogType(value) ?? 'alert'
}

export interface DialogOpeningInput {
  tabId?: number
  type?: string
  message?: string
  url?: string
  defaultPrompt?: string
  hasBrowserHandler?: boolean
}

export interface DialogDecision {
  entry: DialogEntry
  accept: boolean
  promptText?: string
}

export class DialogManager {
  private mode: DialogPolicyMode
  private defaultPromptText: string | undefined
  private acceptBeforeUnload: boolean
  private maxHistory: number
  private entries: DialogEntry[] = []
  private queue: DialogQueuedResponse[] = []
  private listeners = new Set<(ev: DialogEvent) => void>()
  private seq = 0

  // Cumulative counters (independent of maxHistory eviction)
  private totalCount = 0
  private alertCount = 0
  private confirmCount = 0
  private promptCount = 0
  private beforeUnloadCount = 0
  private acceptedCount = 0
  private dismissedCount = 0

  constructor(opts: DialogPolicyOptions = {}) {
    this.mode = opts.mode ?? 'dismiss'
    this.defaultPromptText = opts.defaultPromptText
    this.acceptBeforeUnload = opts.acceptBeforeUnload ?? true
    this.maxHistory = this.clampHistory(opts.maxHistory)
  }

  private clampHistory(n: number | undefined): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_DIALOG_MAX_HISTORY
    return Math.max(1, Math.min(5000, Math.floor(n)))
  }

  onEvent(fn: (ev: DialogEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(ev: DialogEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev)
      } catch {
        // ignore listener errors
      }
    }
  }

  getStats(): DialogStats {
    return {
      mode: this.mode,
      acceptBeforeUnload: this.acceptBeforeUnload,
      ...(this.defaultPromptText !== undefined ? { defaultPromptText: this.defaultPromptText } : {}),
      queuedCount: this.queue.length,
      total: this.totalCount,
      alerts: this.alertCount,
      confirms: this.confirmCount,
      prompts: this.promptCount,
      beforeUnloads: this.beforeUnloadCount,
      accepted: this.acceptedCount,
      dismissed: this.dismissedCount,
    }
  }

  setPolicy(opts: DialogPolicyOptions): DialogStats {
    if (opts.mode) this.mode = opts.mode
    if ('defaultPromptText' in opts) {
      this.defaultPromptText = opts.defaultPromptText
    }
    if (typeof opts.acceptBeforeUnload === 'boolean') {
      this.acceptBeforeUnload = opts.acceptBeforeUnload
    }
    if (typeof opts.maxHistory === 'number') {
      this.maxHistory = this.clampHistory(opts.maxHistory)
      while (this.entries.length > this.maxHistory) {
        this.entries.shift()
      }
    }
    return this.getStats()
  }

  queueResponse(resp: DialogQueuedResponse): DialogStats {
    if (this.queue.length >= MAX_DIALOG_QUEUE_LEN) {
      this.queue.shift()
    }
    this.queue.push({
      accept: Boolean(resp.accept),
      ...(resp.promptText !== undefined ? { promptText: String(resp.promptText) } : {}),
      ...(resp.type ? { type: normalizeDialogType(resp.type) } : {}),
    })
    return this.getStats()
  }

  getQueue(): DialogQueuedResponse[] {
    return this.queue.map((q) => ({ ...q }))
  }

  clearQueue(): number {
    const count = this.queue.length
    this.queue = []
    return count
  }

  /**
   * Process an incoming `Page.javascriptDialogOpening` event, decide whether to
   * accept or dismiss (consulting the FIFO queued overrides first, then policy),
   * record the captured message, and return the CDP response parameters.
   */
  handleOpening(input: DialogOpeningInput): DialogDecision {
    const type = normalizeDialogType(input.type)
    const rawMessage = typeof input.message === 'string' ? input.message : ''
    const message = rawMessage.length > MAX_DIALOG_MESSAGE_LEN
      ? `${rawMessage.slice(0, MAX_DIALOG_MESSAGE_LEN)}...`
      : rawMessage
    const url = typeof input.url === 'string' ? input.url.slice(0, 2048) : ''
    const defaultPrompt = typeof input.defaultPrompt === 'string' ? input.defaultPrompt : undefined

    // Check FIFO queue for a matching one-shot override
    const queueIdx = this.queue.findIndex((q) => !q.type || q.type === type)
    let queued: DialogQueuedResponse | undefined
    if (queueIdx >= 0) {
      queued = this.queue.splice(queueIdx, 1)[0]
    }

    let accept: boolean
    let handledBy: 'policy' | 'queue'
    if (queued) {
      accept = queued.accept
      handledBy = 'queue'
    } else if (type === 'beforeunload') {
      accept = this.acceptBeforeUnload
      handledBy = 'policy'
    } else {
      accept = this.mode === 'accept'
      handledBy = 'policy'
    }

    let promptText: string | undefined
    if (type === 'prompt' && accept) {
      promptText = queued?.promptText ?? this.defaultPromptText ?? defaultPrompt ?? ''
    }

    const entry: DialogEntry = {
      id: `dlg_${++this.seq}`,
      ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      type,
      message,
      url,
      ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
      action: accept ? 'accepted' : 'dismissed',
      accepted: accept,
      ...(promptText !== undefined ? { promptText } : {}),
      handledBy,
      ...(typeof input.hasBrowserHandler === 'boolean' ? { hasBrowserHandler: input.hasBrowserHandler } : {}),
      ts: Date.now(),
    }

    this.entries.push(entry)
    while (this.entries.length > this.maxHistory) {
      this.entries.shift()
    }

    this.totalCount++
    if (type === 'alert') this.alertCount++
    else if (type === 'confirm') this.confirmCount++
    else if (type === 'prompt') this.promptCount++
    else if (type === 'beforeunload') this.beforeUnloadCount++

    if (accept) this.acceptedCount++
    else this.dismissedCount++

    this.emit({ kind: 'dialog_handled', entry: { ...entry } })

    return {
      entry: { ...entry },
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    }
  }

  /**
   * Record `Page.javascriptDialogClosed` for the most recent unclosed dialog
   * on the given tab (or globally if tabId is omitted).
   */
  recordClosed(input: { tabId?: number; result?: boolean; userInput?: string }): DialogEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (!e || e.closedAt !== undefined) continue
      if (input.tabId !== undefined && e.tabId !== input.tabId) continue
      e.closedAt = Date.now()
      const snapshot: DialogEntry = { ...e }
      this.emit({ kind: 'dialog_closed', entry: snapshot })
      return snapshot
    }
    return undefined
  }

  list(opts?: { tabId?: number; type?: DialogType; limit?: number; clear?: boolean }): DialogEntry[] {
    let out = this.entries
    if (opts?.tabId !== undefined) {
      out = out.filter((e) => e.tabId === opts.tabId)
    }
    if (opts?.type) {
      out = out.filter((e) => e.type === opts.type)
    }
    const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, 1000) : 100
    const result = out.slice(-limit).map((e) => ({ ...e }))
    if (opts?.clear) {
      this.clear({ tabId: opts.tabId })
    }
    return result
  }

  clear(opts?: { tabId?: number }): number {
    if (opts?.tabId === undefined) {
      const count = this.entries.length
      this.entries = []
      return count
    }
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.tabId !== opts.tabId)
    return before - this.entries.length
  }
}

export function formatDialogsAscii(
  entries: DialogEntry[],
  stats: DialogStats,
  queue: DialogQueuedResponse[] = [],
): string {
  const lines: string[] = []
  const rule = '+------------------------------------------------------------------------------+'
  lines.push(rule)
  lines.push(
    `| DIALOG HANDLER | mode=${stats.mode} | beforeunload=${stats.acceptBeforeUnload ? 'accept' : 'dismiss'} | queued=${stats.queuedCount}`,
  )
  lines.push(
    `| totals: total=${stats.total} alert=${stats.alerts} confirm=${stats.confirms} prompt=${stats.prompts} beforeunload=${stats.beforeUnloads} (accepted=${stats.accepted}, dismissed=${stats.dismissed})`,
  )
  if (stats.defaultPromptText !== undefined) {
    lines.push(`| defaultPromptText: ${sanitizeAscii(stats.defaultPromptText).slice(0, 60)}`)
  }
  if (queue.length > 0) {
    const qDesc = queue
      .slice(0, 5)
      .map((q) => `${q.type ?? 'any'}:${q.accept ? 'accept' : 'dismiss'}${q.promptText !== undefined ? `("${sanitizeAscii(q.promptText).slice(0, 20)}")` : ''}`)
      .join(', ')
    lines.push(`| next queue: ${qDesc}${queue.length > 5 ? ` (+${queue.length - 5} more)` : ''}`)
  }
  lines.push(rule)

  if (entries.length === 0) {
    lines.push('(no dialogs captured)')
  } else {
    for (const e of entries) {
      const actionTag = e.accepted ? 'ACCEPTED' : 'DISMISSED'
      const viaTag = e.handledBy === 'queue' ? 'queue' : 'policy'
      const tabTag = e.tabId !== undefined ? ` tab=${e.tabId}` : ''
      const msg = sanitizeAscii(e.message.replace(/\s+/g, ' ').trim()).slice(0, 120)
      const promptSuffix =
        e.type === 'prompt' && e.promptText !== undefined
          ? ` -> input="${sanitizeAscii(e.promptText).slice(0, 40)}"`
          : ''
      lines.push(`[${e.id}] [${e.type}] ${actionTag} (${viaTag})${tabTag}: "${msg}"${promptSuffix}`)
      if (e.url) {
        lines.push(`    url: ${sanitizeAscii(e.url).slice(0, 120)}`)
      }
    }
  }

  return sanitizeAscii(lines.join('\n'))
}
