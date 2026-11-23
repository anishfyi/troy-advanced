// Interactive ASCII/ANSI Terminal Browser TUI (`troy-advanced browse [url]`).
// Works over plain SSH, tmux, EC2 serial console, or local terminals.
// Supports raw-mode single-key navigation (j/k, g/G, /, :, Tab, Enter, q)
// as well as line-based fallback when stdin is non-TTY / piped.

import readline from 'node:readline'
import { formatRefTooltip, renderPageAsciiWithMetrics } from '../ascii/layout.js'
import type { BrowserManager } from '../engine/manager.js'
import type { ElementDescriptor, PageSnapshot } from '../types.js'
import {
  cloneFormModalState,
  createFormModalState,
  isFormModalElement,
  overlayModalOnFrame,
  renderFormModalBox,
  type FormModalState,
} from './form-modal.js'
import {
  composeSplitPaneFrame,
  computeSplitPaneWidths,
  cycleInspectorTab,
  parseInspectorTab,
  renderInspectorPane,
  type ActivePane,
  type InspectorData,
  type InspectorTab,
} from './inspector.js'

export type TuiMode = 'normal' | 'search' | 'command' | 'modal'

export interface TuiKeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

export interface TuiInputStream extends NodeJS.ReadableStream {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => void
}

export interface TuiOutputStream extends NodeJS.WritableStream {
  isTTY?: boolean
  columns?: number
  rows?: number
}

export interface TuiOptions {
  initialUrl?: string
  asciiOnly?: boolean
  color?: boolean
  /** Force raw keypress mode (true) or line-based readline mode (false). Defaults to Boolean(input.isTTY). */
  rawMode?: boolean
  /** Injectable input stream (defaults to process.stdin). */
  input?: TuiInputStream
  /** Injectable output stream (defaults to process.stdout). */
  output?: TuiOutputStream
  /** Override viewport width (otherwise derived from output.columns or 100). */
  width?: number
  /** Override viewport height (otherwise derived from output.rows or 36). */
  height?: number
  /** Lines scrolled per j/k keypress (default: 1). */
  scrollStep?: number
  /** Start with split-pane inspector open (default: false). */
  splitPane?: boolean
  /** Initial inspector tab when split-pane is open (default: 'console'). */
  inspectorTab?: InspectorTab
}

export interface TuiSearchMatch {
  ref: string
  text: string
}

export interface TuiState {
  mode: TuiMode
  scrollOffset: number
  maxScrollOffset: number
  totalLines: number
  viewportRows: number
  asciiOnly: boolean
  color: boolean
  statusMessage: string
  inputBuffer: string
  focusedRef: string | null
  focusedRefIndex: number
  focusedTooltip: string | null
  focusedLineIndex: number | null
  availableRefs: string[]
  searchQuery: string
  searchMatches: TuiSearchMatch[]
  searchMatchIndex: number
  splitPane: boolean
  inspectorTab: InspectorTab
  activePane: ActivePane
  inspectorScrollOffset: number
  inspectorMaxScrollOffset: number
  formModal: FormModalState | null
  exited: boolean
}

export class TerminalBrowserController {
  private readonly manager: BrowserManager
  private readonly input: TuiInputStream
  private readonly output: TuiOutputStream
  private readonly opts: TuiOptions
  private readonly scrollStep: number

  private mode: TuiMode = 'normal'
  private scrollOffset = 0
  private maxScrollOffset = 0
  private totalLines = 0
  private viewportRows = 20
  private asciiOnly: boolean
  private color: boolean
  private statusMessage: string
  private inputBuffer = ''
  private focusedRef: string | null = null
  private focusedRefIndex = -1
  private focusedLineIndex: number | null = null
  private availableRefs: string[] = []
  private lastSnapshot: PageSnapshot | undefined
  private searchQuery = ''
  private searchMatches: TuiSearchMatch[] = []
  private searchMatchIndex = -1
  private splitPane: boolean
  private inspectorTab: InspectorTab
  private activePane: ActivePane = 'page'
  private inspectorScrollOffset = 0
  private inspectorMaxScrollOffset = 0
  private inspectorViewportRows = 12
  private formModal: FormModalState | null = null
  private exited = false

  constructor(manager: BrowserManager, opts: TuiOptions = {}) {
    this.manager = manager
    this.opts = opts
    this.input = opts.input ?? (process.stdin as TuiInputStream)
    this.output = opts.output ?? (process.stdout as TuiOutputStream)
    this.scrollStep = Math.max(1, opts.scrollStep ?? 1)
    this.asciiOnly = opts.asciiOnly ?? false
    this.color = this.asciiOnly ? false : (opts.color ?? Boolean(this.output.isTTY))
    this.splitPane = Boolean(opts.splitPane)
    this.inspectorTab = opts.inspectorTab ?? 'console'
    this.statusMessage = this.isRawModeEnabled()
      ? 'Keys: j/k scroll | g/G top/bottom | / search | : cmd | Tab focus | Enter act | i inspector | q quit'
      : 'Type a command (open <url>, click e1, fill e2 txt, split, console, network, refs, activity, quit)'
  }

  isRawModeEnabled(): boolean {
    if (typeof this.opts.rawMode === 'boolean') return this.opts.rawMode
    return Boolean(this.input.isTTY)
  }

  getState(): TuiState {
    return {
      mode: this.mode,
      scrollOffset: this.scrollOffset,
      maxScrollOffset: this.maxScrollOffset,
      totalLines: this.totalLines,
      viewportRows: this.viewportRows,
      asciiOnly: this.asciiOnly,
      color: this.color,
      statusMessage: this.statusMessage,
      inputBuffer: this.inputBuffer,
      focusedRef: this.focusedRef,
      focusedRefIndex: this.focusedRefIndex,
      focusedTooltip: this.getFocusedTooltip(),
      focusedLineIndex: this.focusedLineIndex,
      availableRefs: [...this.availableRefs],
      searchQuery: this.searchQuery,
      searchMatches: this.searchMatches.map((m) => ({ ...m })),
      searchMatchIndex: this.searchMatchIndex,
      splitPane: this.splitPane,
      inspectorTab: this.inspectorTab,
      activePane: this.activePane,
      inspectorScrollOffset: this.inspectorScrollOffset,
      inspectorMaxScrollOffset: this.inspectorMaxScrollOffset,
      formModal: cloneFormModalState(this.formModal),
      exited: this.exited,
    }
  }

  async init(): Promise<void> {
    if (this.opts.initialUrl) {
      const opened = await this.manager.openTab(this.opts.initialUrl, { activate: true })
      if (!opened.ok) {
        this.statusMessage = `Error: ${opened.error}`
      }
    } else if (this.manager.listTabs().length === 0) {
      await this.manager.openTab(undefined, { activate: true })
    }
    await this.draw({ refresh: true })
  }

  private resolveDimensions(): { width: number; height: number } {
    const rawCols = this.opts.width ?? this.output.columns ?? 100
    const rawRows = this.opts.height ?? Math.max(14, (this.output.rows ?? 36) - 3)
    const width = Math.max(60, Math.min(240, rawCols))
    const height = Math.max(14, Math.min(80, rawRows))
    return { width, height }
  }

  private collectInspectorData(activeTabId?: number): InspectorData {
    return {
      consoleEntries: this.manager.getTabConsole(activeTabId, { limit: 100 }),
      networkEntries: this.manager.getTabNetwork(activeTabId, { limit: 100 }),
      elements: this.lastSnapshot?.elements ?? [],
      activityEntries: this.manager.getAgentActivity({ limit: 100 }),
      focusedRef: this.focusedRef,
    }
  }

  private setSplitPane(enabled: boolean, customMessage?: string): void {
    if (!enabled) {
      this.splitPane = false
      this.activePane = 'page'
      this.inspectorScrollOffset = 0
      this.statusMessage = customMessage ?? 'Split-pane inspector closed'
      return
    }
    const { width } = this.resolveDimensions()
    const layout = computeSplitPaneWidths(width)
    if (!layout.canSplit) {
      this.splitPane = false
      this.activePane = 'page'
      this.statusMessage = `Terminal too narrow for split-pane (${width} cols; need >= 72)`
      return
    }
    this.splitPane = true
    this.statusMessage = customMessage ?? `Split-pane inspector open (${this.inspectorTab})`
  }

  private toggleSplitPane(): void {
    this.setSplitPane(!this.splitPane)
  }

  private toggleActivePane(): void {
    if (!this.splitPane) {
      this.setSplitPane(true)
      if (!this.splitPane) return
      this.activePane = 'inspector'
      this.statusMessage = `Active pane: inspector (${this.inspectorTab})`
      return
    }
    this.activePane = this.activePane === 'page' ? 'inspector' : 'page'
    this.statusMessage =
      this.activePane === 'inspector'
        ? `Active pane: inspector (${this.inspectorTab})`
        : 'Active pane: page viewport'
  }

  private clearCurrentInspectorBuffer(): void {
    const activeTabId = this.manager.listTabs().find((t) => t.active)?.id ?? this.lastSnapshot?.tabId
    if (this.inspectorTab === 'console') {
      this.manager.getTabConsole(activeTabId, { clear: true })
      this.inspectorScrollOffset = 0
      this.statusMessage = 'Cleared console log'
    } else if (this.inspectorTab === 'network') {
      this.manager.getTabNetwork(activeTabId, { clear: true })
      this.inspectorScrollOffset = 0
      this.statusMessage = 'Cleared network log'
    } else if (this.inspectorTab === 'activity') {
      this.manager.getAgentActivity({ clear: true })
      this.inspectorScrollOffset = 0
      this.statusMessage = 'Cleared agent activity log'
    } else {
      this.statusMessage = 'Refs list reflects live DOM (cannot clear)'
    }
  }

  getFocusedTooltip(): string | null {
    if (!this.focusedRef) return null
    const el = this.findElementByRef(this.focusedRef)
    return formatRefTooltip(el, this.focusedRef, {
      index: this.focusedRefIndex >= 0 ? this.focusedRefIndex : undefined,
      total: this.availableRefs.length > 0 ? this.availableRefs.length : undefined,
      asciiOnly: this.asciiOnly,
    })
  }

  private buildStatusLine(): string {
    if (this.mode === 'modal' && this.formModal) {
      const action = this.formModal.kind === 'select' ? 'Select' : 'Edit'
      return `MODAL ${action} [${this.formModal.ref}] <${this.formModal.tag}> | Enter: submit | Esc: cancel`
    }
    if (this.mode === 'search') {
      return `SEARCH /${this.inputBuffer}`
    }
    if (this.mode === 'command') {
      return `CMD :${this.inputBuffer}`
    }
    const tooltip = this.getFocusedTooltip()
    if (tooltip) {
      if (!this.statusMessage || this.statusMessage === tooltip) {
        return tooltip
      }
      return `${tooltip} | ${this.statusMessage}`
    }
    return this.statusMessage
  }

  private syncSnapshotRefs(snapshot: PageSnapshot | undefined): void {
    this.lastSnapshot = snapshot
    const refs = (snapshot?.elements ?? [])
      .map((el) => el.ref)
      .filter((r): r is string => typeof r === 'string' && r.length > 0)
    this.availableRefs = refs
    if (this.focusedRef) {
      const idx = refs.indexOf(this.focusedRef)
      if (idx >= 0) {
        this.focusedRefIndex = idx
      } else {
        this.focusedRef = null
        this.focusedRefIndex = -1
      }
    }
  }

  private findElementByRef(ref: string | null): ElementDescriptor | undefined {
    if (!ref || !this.lastSnapshot) return undefined
    return this.lastSnapshot.elements.find((e) => e.ref === ref)
  }

  async draw(opts: { refresh?: boolean; ensureFocusVisible?: boolean } = {}): Promise<string> {
    const { width, height } = this.resolveDimensions()
    const splitLayout = this.splitPane
      ? computeSplitPaneWidths(width)
      : { canSplit: false, leftWidth: width, rightWidth: 0, gapWidth: 0 }
    const pageWidth = splitLayout.leftWidth
    const shouldRefresh = opts.refresh ?? !this.lastSnapshot
    let leftFrame: string

    if (!shouldRefresh && this.lastSnapshot) {
      const tabs = this.manager.listTabs()
      const activeTab = tabs.find((t) => t.active)
      let rendered = renderPageAsciiWithMetrics(this.lastSnapshot, {
        width: pageWidth,
        height,
        asciiOnly: this.asciiOnly,
        color: this.color,
        scrollOffset: this.scrollOffset,
        statusMessage: this.buildStatusLine(),
        focusedRef: this.focusedRef ?? undefined,
        tabs,
        activeTabId: activeTab?.id ?? this.lastSnapshot.tabId,
      })
      this.focusedLineIndex = rendered.focusedLineIndex ?? null
      if (
        opts.ensureFocusVisible &&
        rendered.focusedLineIndex !== undefined &&
        (rendered.focusedLineIndex < rendered.scrollOffset ||
          rendered.focusedLineIndex >= rendered.scrollOffset + rendered.viewportRows)
      ) {
        const targetOffset = Math.max(
          0,
          Math.min(rendered.maxScrollOffset, rendered.focusedLineIndex - Math.floor(rendered.viewportRows / 3)),
        )
        rendered = renderPageAsciiWithMetrics(this.lastSnapshot, {
          width: pageWidth,
          height,
          asciiOnly: this.asciiOnly,
          color: this.color,
          scrollOffset: targetOffset,
          statusMessage: this.buildStatusLine(),
          focusedRef: this.focusedRef ?? undefined,
          tabs,
          activeTabId: activeTab?.id ?? this.lastSnapshot.tabId,
        })
      }
      this.scrollOffset = rendered.scrollOffset
      this.maxScrollOffset = rendered.maxScrollOffset
      this.totalLines = rendered.totalLines
      this.viewportRows = rendered.viewportRows
      leftFrame = rendered.ascii
    } else {
      const res = await this.manager.renderAscii(undefined, {
        width: pageWidth,
        height,
        asciiOnly: this.asciiOnly,
        color: this.color,
        scrollOffset: this.scrollOffset,
        statusMessage: this.buildStatusLine(),
        focusedRef: this.focusedRef ?? undefined,
      })

      if (res.ok) {
        this.syncSnapshotRefs(res.snapshot)
        this.focusedLineIndex = res.focusedLineIndex ?? null
        if (res.scroll) {
          this.scrollOffset = res.scroll.offset
          this.maxScrollOffset = res.scroll.maxOffset
          this.totalLines = res.scroll.totalLines
          this.viewportRows = res.scroll.viewportRows
        }
      }
      leftFrame = res.ascii ?? res.error ?? '(no tab)'
    }

    let frame = leftFrame
    if (splitLayout.canSplit) {
      const activeTabId = this.manager.listTabs().find((t) => t.active)?.id ?? this.lastSnapshot?.tabId
      const inspectorData = this.collectInspectorData(activeTabId)
      const leftRowCount = leftFrame.split('\n').length
      const inspectorRendered = renderInspectorPane(inspectorData, {
        width: splitLayout.rightWidth,
        height: leftRowCount,
        activeTab: this.inspectorTab,
        scrollOffset: this.inspectorScrollOffset,
        asciiOnly: this.asciiOnly,
        color: this.color,
        activePane: this.activePane,
      })
      this.inspectorScrollOffset = inspectorRendered.scrollOffset
      this.inspectorMaxScrollOffset = inspectorRendered.maxScrollOffset
      this.inspectorViewportRows = inspectorRendered.viewportRows
      frame = composeSplitPaneFrame(leftFrame, inspectorRendered.lines, {
        leftWidth: splitLayout.leftWidth,
        rightWidth: splitLayout.rightWidth,
        gapWidth: splitLayout.gapWidth,
        asciiOnly: this.asciiOnly,
      })
    } else {
      this.inspectorScrollOffset = 0
      this.inspectorMaxScrollOffset = 0
    }

    if (this.mode === 'modal' && this.formModal) {
      const modalLines = renderFormModalBox(this.formModal, {
        maxWidth: width,
        maxHeight: height,
        asciiOnly: this.asciiOnly,
        color: this.color,
      })
      frame = overlayModalOnFrame(frame, modalLines, { asciiOnly: this.asciiOnly })
    }

    if (this.output.isTTY) {
      this.output.write('\x1b[2J\x1b[H')
    }
    this.output.write(`${frame}\n`)

    if (this.isRawModeEnabled()) {
      if (this.mode === 'search') {
        this.output.write(`/${this.inputBuffer}`)
      } else if (this.mode === 'command') {
        this.output.write(`:${this.inputBuffer}`)
      }
    }

    return frame
  }

  private focusRefByName(ref: string): void {
    const idx = this.availableRefs.indexOf(ref)
    if (idx >= 0) {
      this.focusedRefIndex = idx
      this.focusedRef = ref
    } else {
      this.focusedRefIndex = -1
      this.focusedRef = ref
    }
  }

  private cycleFocus(delta: 1 | -1): void {
    if (this.availableRefs.length === 0) {
      this.focusedRef = null
      this.focusedRefIndex = -1
      this.statusMessage = 'No interactive refs on page'
      return
    }
    const len = this.availableRefs.length
    if (this.focusedRefIndex < 0) {
      this.focusedRefIndex = delta > 0 ? 0 : len - 1
    } else {
      this.focusedRefIndex = (this.focusedRefIndex + delta + len) % len
    }
    this.focusedRef = this.availableRefs[this.focusedRefIndex] ?? null
    this.statusMessage = this.getFocusedTooltip() ?? 'No interactive refs on page'
  }

  private async activateFocusedRef(): Promise<{ refresh: boolean }> {
    if (!this.focusedRef) {
      this.statusMessage = 'No focused ref (press Tab to focus a ref)'
      return { refresh: false }
    }
    const ref = this.focusedRef
    const prevUrl = this.lastSnapshot?.url
    const el = this.findElementByRef(ref)

    const modalKind = isFormModalElement(el)
    if (modalKind && el) {
      if (el.disabled) {
        this.statusMessage = `Cannot edit ${ref}: field is disabled`
        return { refresh: false }
      }
      if (el.readOnly) {
        this.statusMessage = `Cannot edit ${ref}: field is read-only`
        return { refresh: false }
      }
      this.formModal = createFormModalState(ref, el)
      this.mode = 'modal'
      this.statusMessage =
        modalKind === 'select'
          ? `Select option for ${ref} (Enter confirm, Esc cancel)`
          : `Editing ${ref} (Enter submit, Esc cancel)`
      return { refresh: false }
    }

    const res = await this.manager.runTool(undefined, 'page_click', { ref })
    if (res.ok) {
      const nextUrl = typeof res.url === 'string' ? res.url : undefined
      if (nextUrl && nextUrl !== prevUrl) {
        this.scrollOffset = 0
        this.focusedRef = null
        this.focusedRefIndex = -1
      }
      this.statusMessage = `Activated ${ref}${nextUrl ? ` -> ${nextUrl}` : ''}`
      return { refresh: true }
    }
    this.statusMessage = `Refused ${ref}: ${res.error}`
    return { refresh: false }
  }

  private async submitFormModal(): Promise<{ refresh: boolean }> {
    const modal = this.formModal
    this.formModal = null
    this.mode = 'normal'
    if (!modal) {
      return { refresh: false }
    }

    if (modal.kind === 'select') {
      const chosen = modal.options[modal.selectedIndex]
      const value = chosen ? chosen.value : modal.value
      const displayLabel = chosen ? chosen.label : value
      const res = await this.manager.runTool(undefined, 'page_select', {
        ref: modal.ref,
        value,
      })
      if (res.ok) {
        this.statusMessage = `Selected ${modal.ref} = ${displayLabel}`
        return { refresh: true }
      }
      this.statusMessage = `Refused ${modal.ref}: ${res.error}`
      return { refresh: false }
    }

    const res = await this.manager.runTool(undefined, 'page_fill', {
      ref: modal.ref,
      text: modal.value,
      clear: true,
    })
    if (res.ok) {
      const preview = modal.masked
        ? ' (masked)'
        : ` = "${modal.value.length > 32 ? `${modal.value.slice(0, 29)}...` : modal.value}"`
      this.statusMessage = `Filled ${modal.ref}${preview}`
      return { refresh: true }
    }
    this.statusMessage = `Refused ${modal.ref}: ${res.error}`
    return { refresh: false }
  }

  private async handleModalKeypress(
    seq: string,
    k: TuiKeyEvent,
  ): Promise<{ shouldExit: boolean; drawn: boolean }> {
    const modal = this.formModal
    if (!modal) {
      this.mode = 'normal'
      return { shouldExit: false, drawn: false }
    }
    const name = k.name ?? ''

    if (name === 'escape') {
      const ref = modal.ref
      this.formModal = null
      this.mode = 'normal'
      this.statusMessage = `Cancelled editing ${ref}`
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (name === 'return' || name === 'enter') {
      const { refresh } = await this.submitFormModal()
      await this.draw({ refresh })
      return { shouldExit: false, drawn: true }
    }

    // Select picker modal with parsed <option> list
    if (modal.kind === 'select' && modal.options.length > 0) {
      const len = modal.options.length
      if ((!k.ctrl && !k.meta && seq === 'j') || name === 'down') {
        modal.selectedIndex = (modal.selectedIndex + 1) % len
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
      if ((!k.ctrl && !k.meta && seq === 'k') || name === 'up') {
        modal.selectedIndex = (modal.selectedIndex - 1 + len) % len
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
      if ((!k.ctrl && !k.meta && !k.shift && seq === 'g') || name === 'home') {
        modal.selectedIndex = 0
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
      if ((!k.ctrl && !k.meta && (seq === 'G' || (k.shift && name === 'g'))) || name === 'end') {
        modal.selectedIndex = len - 1
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
      if (!k.ctrl && !k.meta && /^[1-9]$/.test(seq)) {
        const idx = Number(seq) - 1
        if (idx < len) {
          modal.selectedIndex = idx
          await this.draw()
          return { shouldExit: false, drawn: true }
        }
      }
      return { shouldExit: false, drawn: false }
    }

    // Text input modal editing (<input>, <textarea>, or <select> with empty options)
    if (name === 'left') {
      modal.cursor = Math.max(0, modal.cursor - 1)
      await this.draw()
      return { shouldExit: false, drawn: true }
    }
    if (name === 'right') {
      modal.cursor = Math.min(modal.value.length, modal.cursor + 1)
      await this.draw()
      return { shouldExit: false, drawn: true }
    }
    if (name === 'home' || (k.ctrl && name === 'a')) {
      modal.cursor = 0
      await this.draw()
      return { shouldExit: false, drawn: true }
    }
    if (name === 'end' || (k.ctrl && name === 'e')) {
      modal.cursor = modal.value.length
      await this.draw()
      return { shouldExit: false, drawn: true }
    }
    if (k.ctrl && name === 'u') {
      modal.value = ''
      modal.cursor = 0
      await this.draw()
      return { shouldExit: false, drawn: true }
    }
    if (k.ctrl && name === 'w') {
      const before = modal.value.slice(0, modal.cursor)
      const after = modal.value.slice(modal.cursor)
      const trimmed = before.replace(/\S+\s*$/, '')
      modal.value = trimmed + after
      modal.cursor = trimmed.length
      await this.draw()
      return { shouldExit: false, drawn: true }
    }
    if (name === 'backspace') {
      if (modal.cursor > 0) {
        modal.value = modal.value.slice(0, modal.cursor - 1) + modal.value.slice(modal.cursor)
        modal.cursor -= 1
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
      return { shouldExit: false, drawn: false }
    }
    if (name === 'delete') {
      if (modal.cursor < modal.value.length) {
        modal.value = modal.value.slice(0, modal.cursor) + modal.value.slice(modal.cursor + 1)
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
      return { shouldExit: false, drawn: false }
    }
    if (!k.ctrl && !k.meta && seq.length > 0 && seq >= ' ' && seq !== '\x7f') {
      modal.value = modal.value.slice(0, modal.cursor) + seq + modal.value.slice(modal.cursor)
      modal.cursor += seq.length
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    return { shouldExit: false, drawn: false }
  }

  private async runSearch(query: string): Promise<void> {
    const trimmed = query.trim()
    this.searchQuery = trimmed
    if (!trimmed) {
      this.searchMatches = []
      this.searchMatchIndex = -1
      this.statusMessage = 'Search cleared'
      return
    }
    const res = await this.manager.runTool(undefined, 'page_find', { query: trimmed })
    const rawMatches = Array.isArray(res.matches) ? (res.matches as Array<{ ref?: string; text?: string }>) : []
    this.searchMatches = rawMatches
      .filter((m): m is { ref: string; text?: string } => typeof m.ref === 'string' && m.ref.length > 0)
      .map((m) => ({ ref: m.ref, text: m.text ?? '' }))

    if (this.searchMatches.length === 0) {
      this.searchMatchIndex = -1
      this.statusMessage = `No matches for "${trimmed}"`
      return
    }

    this.searchMatchIndex = 0
    const first = this.searchMatches[0]
    if (first) {
      this.focusRefByName(first.ref)
    }
    const preview = this.searchMatches
      .slice(0, 4)
      .map((m) => `[${m.ref}] ${m.text}`)
      .join(', ')
    this.statusMessage = `Found ${this.searchMatches.length} for "${trimmed}": ${preview}`
  }

  private cycleSearchMatch(delta: 1 | -1): void {
    if (this.searchMatches.length === 0) {
      this.statusMessage = this.searchQuery
        ? `No matches for "${this.searchQuery}"`
        : 'No active search (press / to search)'
      return
    }
    const len = this.searchMatches.length
    this.searchMatchIndex = (this.searchMatchIndex + delta + len) % len
    const match = this.searchMatches[this.searchMatchIndex]
    if (!match) return
    this.focusRefByName(match.ref)
    this.statusMessage = `Match ${this.searchMatchIndex + 1}/${len} for "${this.searchQuery}": [${match.ref}] ${match.text}`
  }

  async executeCommand(rawLine: string): Promise<{ shouldExit: boolean; skipDraw?: boolean; refresh?: boolean }> {
    const line = rawLine.trim()
    if (!line) {
      return { shouldExit: false }
    }

    const [cmdRaw, ...rest] = line.split(/\s+/)
    const cmd = (cmdRaw ?? '').toLowerCase()
    const arg = rest.join(' ')
    let refresh = false

    try {
      if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
        this.exited = true
        return { shouldExit: true }
      } else if (cmd === 'j' || cmd === 'down') {
        const delta = Number(rest[0] || 10)
        this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + (Number.isFinite(delta) ? delta : 10))
        this.statusMessage = `Scrolled down to line ${this.scrollOffset}`
      } else if (cmd === 'k' || cmd === 'up') {
        const delta = Number(rest[0] || 10)
        this.scrollOffset = Math.max(0, this.scrollOffset - (Number.isFinite(delta) ? delta : 10))
        this.statusMessage = `Scrolled up to line ${this.scrollOffset}`
      } else if (cmd === 'top' || cmd === 'g') {
        this.scrollOffset = 0
        this.statusMessage = 'Top of page'
      } else if (cmd === 'bottom') {
        this.scrollOffset = this.maxScrollOffset
        this.statusMessage = `Bottom of page (line ${this.scrollOffset})`
      } else if (cmd === 'ascii') {
        this.asciiOnly = !this.asciiOnly
        this.color = !this.asciiOnly && Boolean(this.output.isTTY)
        this.statusMessage = `Mode: ${this.asciiOnly ? 'strict 7-bit ASCII' : 'Unicode/ANSI'}`
      } else if (cmd === 'open' || cmd === 'go' || cmd === 'o') {
        const res = await this.manager.openTab(arg, { activate: true })
        this.scrollOffset = 0
        this.focusedRef = null
        this.focusedRefIndex = -1
        this.statusMessage = res.ok ? `Opened tab ${res.id}: ${res.url}` : `Refused: ${res.error}`
        refresh = true
      } else if (cmd === 'nav' || cmd === 'navigate') {
        const res = await this.manager.runTool(undefined, 'page_navigate', { url: arg })
        this.scrollOffset = 0
        this.focusedRef = null
        this.focusedRefIndex = -1
        this.statusMessage = res.ok ? `Navigated: ${res.url}` : `Error: ${res.error}`
        refresh = true
      } else if (cmd === 'click' || cmd === 'c') {
        const allowSubmit = rest.includes('--submit') || rest.includes('--allow-submit')
        const res = await this.manager.runTool(undefined, 'page_click', { ref: rest[0], allowSubmit })
        this.statusMessage = res.ok ? `Clicked ${rest[0]} -> ${res.url ?? ''}` : `Refused: ${res.error}`
        refresh = Boolean(res.ok)
      } else if (cmd === 'fill' || cmd === 'f') {
        const res = await this.manager.runTool(undefined, 'page_fill', {
          ref: rest[0],
          text: rest.slice(1).join(' '),
        })
        this.statusMessage = res.ok ? `Filled ${rest[0]}` : `Error: ${res.error}`
        refresh = Boolean(res.ok)
      } else if (cmd === 'select') {
        const res = await this.manager.runTool(undefined, 'page_select', {
          ref: rest[0],
          value: rest.slice(1).join(' '),
        })
        this.statusMessage = res.ok ? `Selected ${rest[0]} = ${res.value}` : `Error: ${res.error}`
        refresh = Boolean(res.ok)
      } else if (cmd === 'find' || cmd === '/') {
        await this.runSearch(arg)
      } else if (cmd === 'back' || cmd === 'forward' || cmd === 'reload') {
        const res = await this.manager.runTool(undefined, 'page_history', { direction: cmd })
        this.scrollOffset = 0
        this.focusedRef = null
        this.focusedRefIndex = -1
        this.statusMessage = res.ok ? `${cmd}: ${res.url}` : `Error: ${res.error}`
        refresh = true
      } else if (cmd === 'grant') {
        const res = this.manager.grantOrigin(arg)
        this.statusMessage = res.ok ? `Granted ${res.origin}` : `Error: ${res.error}`
      } else if (cmd === 'tab' || cmd === 't') {
        const res = this.manager.activateTab(Number(rest[0]))
        this.scrollOffset = 0
        this.focusedRef = null
        this.focusedRefIndex = -1
        this.statusMessage = res.ok ? `Switched to tab ${rest[0]}` : `Error: ${res.error}`
        refresh = true
      } else if (cmd === 'visual' || cmd === 'v') {
        const res = await this.manager.runTool(undefined, 'page_screenshot_ascii', {
          width: Math.max(40, Math.min(120, (this.output.columns || 80) - 4)),
          mode:
            rest[0] === 'braille'
              ? 'braille'
              : rest[0] === 'halfblock'
                ? 'halfblock'
                : rest[0] === 'edge'
                  ? 'edge'
                  : 'ascii',
          annotate: true,
        })
        if (res.ok && typeof res.ascii === 'string') {
          this.output.write(`\n${res.ascii}\n`)
          return { shouldExit: false, skipDraw: true }
        }
        this.statusMessage = `Visual error: ${res.error}`
      } else if (cmd === 'split' || cmd === 'inspector') {
        const sub = (rest[0] ?? '').toLowerCase()
        if (!sub || sub === 'toggle') {
          this.toggleSplitPane()
        } else if (sub === 'on' || sub === 'open') {
          this.setSplitPane(true)
        } else if (sub === 'off' || sub === 'close') {
          this.setSplitPane(false)
        } else if (sub === 'focus') {
          this.toggleActivePane()
        } else if (sub === 'clear') {
          this.clearCurrentInspectorBuffer()
        } else {
          const parsedTab = parseInspectorTab(sub)
          if (parsedTab) {
            this.inspectorTab = parsedTab
            this.inspectorScrollOffset = 0
            this.setSplitPane(true, `Inspector: ${parsedTab}`)
          } else {
            this.statusMessage = `Unknown inspector arg "${sub}". Use on|off|console|network|refs|activity|focus|clear`
          }
        }
      } else if (cmd === 'console' || cmd === 'network' || cmd === 'refs' || cmd === 'activity') {
        const targetTab = parseInspectorTab(cmd)!
        this.inspectorTab = targetTab
        this.inspectorScrollOffset = 0
        this.setSplitPane(true, `Inspector: ${targetTab}`)
      } else if (cmd === 'help' || cmd === '?') {
        this.statusMessage =
          'Keys: j/k g/G / : Tab Enter i [/] I q | Cmds: open <url> | click eN | fill eN <txt> | split | console|network|refs|activity | quit'
      } else if (/^e\d+$/.test(cmd)) {
        const res = await this.manager.runTool(undefined, 'page_click', { ref: cmd })
        this.statusMessage = res.ok ? `Clicked ${cmd}` : `Refused: ${res.error}`
        refresh = Boolean(res.ok)
      } else {
        this.statusMessage = `Unknown cmd "${cmd}". Type "help" for commands.`
      }
    } catch (err) {
      this.statusMessage = `Error: ${(err as Error).message}`
    }

    return { shouldExit: false, refresh }
  }

  async handleKeypress(
    str: string | undefined,
    key: TuiKeyEvent | undefined,
  ): Promise<{ shouldExit: boolean; drawn: boolean }> {
    const k: TuiKeyEvent = key ?? {}
    const seq = str ?? k.sequence ?? ''
    const name = k.name ?? ''

    // Ctrl+C always exits cleanly
    if (k.ctrl && name === 'c') {
      this.exited = true
      return { shouldExit: true, drawn: false }
    }

    // Inline form-filling modal mode
    if (this.mode === 'modal') {
      return this.handleModalKeypress(seq, k)
    }

    // Search or Command input mode
    if (this.mode === 'search' || this.mode === 'command') {
      if (name === 'escape') {
        const cancelledMode = this.mode
        this.mode = 'normal'
        this.inputBuffer = ''
        this.statusMessage = cancelledMode === 'search' ? 'Search cancelled' : 'Command cancelled'
        await this.draw()
        return { shouldExit: false, drawn: true }
      }

      if (name === 'return' || name === 'enter') {
        const activeMode = this.mode
        const text = this.inputBuffer
        this.mode = 'normal'
        this.inputBuffer = ''
        if (activeMode === 'search') {
          await this.runSearch(text)
          await this.draw({ ensureFocusVisible: true })
          return { shouldExit: false, drawn: true }
        } else {
          const result = await this.executeCommand(text)
          if (result.shouldExit) {
            return { shouldExit: true, drawn: false }
          }
          if (!result.skipDraw) {
            await this.draw({ refresh: result.refresh })
          }
          return { shouldExit: false, drawn: !result.skipDraw }
        }
      }

      if (name === 'backspace') {
        if (this.inputBuffer.length === 0) {
          this.mode = 'normal'
          this.statusMessage = 'Cancelled'
        } else {
          this.inputBuffer = this.inputBuffer.slice(0, -1)
        }
        await this.draw()
        return { shouldExit: false, drawn: true }
      }

      if (!k.ctrl && !k.meta && seq.length > 0 && seq >= ' ' && seq !== '\x7f') {
        this.inputBuffer += seq
        await this.draw()
        return { shouldExit: false, drawn: true }
      }

      return { shouldExit: false, drawn: false }
    }

    // Normal mode single-key bindings
    if (!k.ctrl && !k.meta && seq === 'q') {
      this.exited = true
      return { shouldExit: true, drawn: false }
    }

    if (!k.ctrl && !k.meta && !k.shift && seq === 'i') {
      this.toggleSplitPane()
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (!k.ctrl && !k.meta && (seq === 'I' || (k.shift && name === 'i'))) {
      this.toggleActivePane()
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (!k.ctrl && !k.meta && (seq === '[' || seq === ']')) {
      const delta: 1 | -1 = seq === ']' ? 1 : -1
      this.inspectorTab = cycleInspectorTab(this.inspectorTab, delta)
      this.inspectorScrollOffset = 0
      if (!this.splitPane) {
        this.setSplitPane(true, `Inspector: ${this.inspectorTab}`)
      } else {
        this.statusMessage = `Inspector tab: ${this.inspectorTab}`
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (this.splitPane && this.activePane === 'inspector' && !k.ctrl && !k.meta && ['1', '2', '3', '4'].includes(seq)) {
      const tab = parseInspectorTab(seq)
      if (tab) {
        this.inspectorTab = tab
        this.inspectorScrollOffset = 0
        this.statusMessage = `Inspector tab: ${tab}`
        await this.draw()
        return { shouldExit: false, drawn: true }
      }
    }

    if ((!k.ctrl && !k.meta && seq === 'j') || name === 'down') {
      if (this.splitPane && this.activePane === 'inspector') {
        this.inspectorScrollOffset = Math.min(this.inspectorMaxScrollOffset, this.inspectorScrollOffset + this.scrollStep)
        this.statusMessage = `Inspector scrolled to line ${this.inspectorScrollOffset}/${this.inspectorMaxScrollOffset}`
      } else {
        this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + this.scrollStep)
        this.statusMessage = `Scrolled down to line ${this.scrollOffset}/${this.maxScrollOffset}`
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if ((!k.ctrl && !k.meta && seq === 'k') || name === 'up') {
      if (this.splitPane && this.activePane === 'inspector') {
        this.inspectorScrollOffset = Math.max(0, this.inspectorScrollOffset - this.scrollStep)
        this.statusMessage = `Inspector scrolled to line ${this.inspectorScrollOffset}/${this.inspectorMaxScrollOffset}`
      } else {
        this.scrollOffset = Math.max(0, this.scrollOffset - this.scrollStep)
        this.statusMessage = `Scrolled up to line ${this.scrollOffset}/${this.maxScrollOffset}`
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (name === 'pagedown' || (k.ctrl && name === 'd')) {
      if (this.splitPane && this.activePane === 'inspector') {
        const halfPage = Math.max(4, Math.floor(this.inspectorViewportRows / 2))
        this.inspectorScrollOffset = Math.min(this.inspectorMaxScrollOffset, this.inspectorScrollOffset + halfPage)
        this.statusMessage = `Inspector page down to line ${this.inspectorScrollOffset}/${this.inspectorMaxScrollOffset}`
      } else {
        const halfPage = Math.max(5, Math.floor(this.viewportRows / 2))
        this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + halfPage)
        this.statusMessage = `Page down to line ${this.scrollOffset}/${this.maxScrollOffset}`
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (name === 'pageup' || (k.ctrl && name === 'u')) {
      if (this.splitPane && this.activePane === 'inspector') {
        const halfPage = Math.max(4, Math.floor(this.inspectorViewportRows / 2))
        this.inspectorScrollOffset = Math.max(0, this.inspectorScrollOffset - halfPage)
        this.statusMessage = `Inspector page up to line ${this.inspectorScrollOffset}/${this.inspectorMaxScrollOffset}`
      } else {
        const halfPage = Math.max(5, Math.floor(this.viewportRows / 2))
        this.scrollOffset = Math.max(0, this.scrollOffset - halfPage)
        this.statusMessage = `Page up to line ${this.scrollOffset}/${this.maxScrollOffset}`
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if ((!k.ctrl && !k.meta && !k.shift && seq === 'g') || name === 'home') {
      if (this.splitPane && this.activePane === 'inspector') {
        this.inspectorScrollOffset = 0
        this.statusMessage = 'Inspector top (line 0)'
      } else {
        this.scrollOffset = 0
        this.statusMessage = 'Top of page (line 0)'
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if ((!k.ctrl && !k.meta && (seq === 'G' || (k.shift && name === 'g'))) || name === 'end') {
      if (this.splitPane && this.activePane === 'inspector') {
        this.inspectorScrollOffset = this.inspectorMaxScrollOffset
        this.statusMessage = `Inspector bottom (line ${this.inspectorScrollOffset}/${this.inspectorMaxScrollOffset})`
      } else {
        this.scrollOffset = this.maxScrollOffset
        this.statusMessage = `Bottom of page (line ${this.scrollOffset}/${this.maxScrollOffset})`
      }
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (!k.ctrl && !k.meta && seq === '/') {
      this.mode = 'search'
      this.inputBuffer = ''
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (!k.ctrl && !k.meta && seq === ':') {
      this.mode = 'command'
      this.inputBuffer = ''
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    if (!k.ctrl && !k.meta && !k.shift && seq === 'n') {
      this.cycleSearchMatch(1)
      await this.draw({ ensureFocusVisible: true })
      return { shouldExit: false, drawn: true }
    }

    if (!k.ctrl && !k.meta && (seq === 'N' || (k.shift && name === 'n'))) {
      this.cycleSearchMatch(-1)
      await this.draw({ ensureFocusVisible: true })
      return { shouldExit: false, drawn: true }
    }

    if (name === 'tab') {
      this.cycleFocus(k.shift ? -1 : 1)
      await this.draw({ ensureFocusVisible: true })
      return { shouldExit: false, drawn: true }
    }

    if (name === 'return' || name === 'enter') {
      const { refresh } = await this.activateFocusedRef()
      await this.draw({ refresh })
      return { shouldExit: false, drawn: true }
    }

    if (name === 'escape') {
      this.focusedRef = null
      this.focusedRefIndex = -1
      this.statusMessage = 'Focus cleared'
      await this.draw()
      return { shouldExit: false, drawn: true }
    }

    return { shouldExit: false, drawn: false }
  }

  async run(): Promise<void> {
    await this.init()
    if (this.isRawModeEnabled()) {
      await this.runRawLoop()
    } else {
      await this.runLineLoop()
    }
  }

  private async runRawLoop(): Promise<void> {
    readline.emitKeypressEvents(this.input)
    let rawEnabled = false
    if (typeof this.input.setRawMode === 'function') {
      try {
        this.input.setRawMode(true)
        rawEnabled = true
      } catch {
        rawEnabled = false
      }
    }
    this.input.resume?.()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let queue: Promise<void> = Promise.resolve()

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        this.input.off('keypress', onKeypress)
        this.input.off('end', onEnd)
        this.input.off('close', onEnd)
        if (rawEnabled && typeof this.input.setRawMode === 'function') {
          try {
            this.input.setRawMode(false)
          } catch {
            // ignore restore errors on closed stream
          }
        }
        this.input.pause?.()
        if (err) reject(err)
        else resolve()
      }

      const onEnd = () => finish()

      const onKeypress = (str: string | undefined, key: TuiKeyEvent | undefined) => {
        queue = queue
          .then(async () => {
            if (settled) return
            const res = await this.handleKeypress(str, key)
            if (res.shouldExit) {
              finish()
            }
          })
          .catch((err) => finish(err as Error))
      }

      this.input.on('keypress', onKeypress)
      this.input.once('end', onEnd)
      this.input.once('close', onEnd)
    })
  }

  private async runLineLoop(): Promise<void> {
    const rl = readline.createInterface({
      input: this.input,
      output: this.output,
      prompt: 'troy-adv> ',
    })

    rl.prompt()

    for await (const raw of rl) {
      const line = raw.trim()
      if (!line) {
        await this.draw()
        rl.prompt()
        continue
      }

      const result = await this.executeCommand(line)
      if (result.shouldExit) {
        rl.close()
        return
      }
      if (!result.skipDraw) {
        await this.draw({ refresh: result.refresh })
      }
      rl.prompt()
    }
  }
}

export async function runTerminalBrowser(manager: BrowserManager, opts: TuiOptions = {}): Promise<void> {
  const controller = new TerminalBrowserController(manager, opts)
  await controller.run()
}
