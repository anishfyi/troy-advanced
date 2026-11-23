// Terminal resize (SIGWINCH / stdout 'resize') live reflow watcher and viewport dimension resolver.
// Designed for smooth live adaptation inside tmux, GNU screen, SSH panes, and local terminals.

export const MIN_TUI_WIDTH = 40
export const MAX_TUI_WIDTH = 240
export const MIN_TUI_HEIGHT = 14
export const MAX_TUI_HEIGHT = 120
export const DEFAULT_TUI_COLUMNS = 100
export const DEFAULT_TUI_ROWS = 36
export const TUI_PROMPT_ROW_RESERVE = 3
export const DEFAULT_RESIZE_DEBOUNCE_MS = 50

export type ResizeEventSource = 'resize' | 'SIGWINCH' | 'manual'

export interface TerminalSizeLike {
  columns?: number
  rows?: number
}

export interface ResizeOutputLike extends TerminalSizeLike {
  on?(event: 'resize', listener: () => void): unknown
  off?(event: 'resize', listener: () => void): unknown
  removeListener?(event: 'resize', listener: () => void): unknown
}

export interface ResizeSignalSource {
  on(event: 'SIGWINCH', listener: () => void): unknown
  off?(event: 'SIGWINCH', listener: () => void): unknown
  removeListener?(event: 'SIGWINCH', listener: () => void): unknown
}

export interface TuiViewportDimensions {
  width: number
  height: number
  rawColumns: number
  rawRows: number
  clamped: boolean
}

export interface ResizeEvent {
  previous: TuiViewportDimensions | null
  current: TuiViewportDimensions
  source: ResizeEventSource
  resizeCount: number
}

export interface FormatResizeStatusOptions {
  pausedPanes?: string[]
  restoredPanes?: string[]
}

export interface TerminalResizeWatcherOptions {
  output: ResizeOutputLike
  widthOverride?: number
  heightOverride?: number
  /** Debounce delay in ms for coalescing tmux/screen drag-resize bursts (default: 50). Set to 0 for immediate dispatch. */
  debounceMs?: number
  /**
   * Signal emitter for `SIGWINCH`.
   * - `undefined`: automatically attaches to `process` when `output === process.stdout` on non-Windows platforms.
   * - `null`: disables `SIGWINCH` listener (only listens to `output` `'resize'`).
   * - custom emitter: attaches to the supplied emitter (ideal for unit tests).
   */
  signalSource?: ResizeSignalSource | null
  onResize: (event: ResizeEvent) => void | Promise<void>
  onError?: (err: unknown) => void
}

function sanitizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

/**
 * Resolves clamped TUI viewport dimensions from terminal output `columns`/`rows`
 * and optional explicit `width`/`height` overrides.
 */
export function resolveViewportDimensions(
  output: TerminalSizeLike,
  overrides: { width?: number; height?: number } = {},
): TuiViewportDimensions {
  const rawColumns = sanitizePositiveInt(overrides.width ?? output.columns, DEFAULT_TUI_COLUMNS)
  const rawRows = sanitizePositiveInt(overrides.height ?? output.rows, DEFAULT_TUI_ROWS)

  const unclampedHeight =
    overrides.height !== undefined
      ? sanitizePositiveInt(overrides.height, DEFAULT_TUI_ROWS - TUI_PROMPT_ROW_RESERVE)
      : Math.max(MIN_TUI_HEIGHT, rawRows - TUI_PROMPT_ROW_RESERVE)

  const width = Math.max(MIN_TUI_WIDTH, Math.min(MAX_TUI_WIDTH, rawColumns))
  const height = Math.max(MIN_TUI_HEIGHT, Math.min(MAX_TUI_HEIGHT, unclampedHeight))
  const clamped = width !== rawColumns || height !== unclampedHeight

  return {
    width,
    height,
    rawColumns,
    rawRows,
    clamped,
  }
}

export function dimensionsEqual(
  a: Pick<TuiViewportDimensions, 'width' | 'height'> | null | undefined,
  b: Pick<TuiViewportDimensions, 'width' | 'height'> | null | undefined,
): boolean {
  if (!a || !b) return false
  return a.width === b.width && a.height === b.height
}

/**
 * Formats a concise, strict-ASCII status bar message describing a terminal resize/reflow.
 */
export function formatResizeStatus(event: ResizeEvent, opts: FormatResizeStatusOptions = {}): string {
  const { width, height } = event.current
  const unchanged = event.previous !== null && dimensionsEqual(event.previous, event.current)
  const base = unchanged && event.source === 'manual' ? `Reflowed ${width}x${height}` : `Resized to ${width}x${height}`

  const notes: string[] = []
  if (opts.pausedPanes && opts.pausedPanes.length > 0) {
    notes.push(`paused ${opts.pausedPanes.join(', ')}: narrow`)
  }
  if (opts.restoredPanes && opts.restoredPanes.length > 0) {
    notes.push(`restored ${opts.restoredPanes.join(', ')}`)
  }

  return notes.length > 0 ? `${base} (${notes.join('; ')})` : base
}

function detachListener(
  target: { off?: (ev: any, fn: any) => unknown; removeListener?: (ev: any, fn: any) => unknown } | null | undefined,
  event: string,
  fn: () => void,
): void {
  if (!target) return
  try {
    if (typeof target.off === 'function') {
      target.off(event, fn)
    } else if (typeof target.removeListener === 'function') {
      target.removeListener(event, fn)
    }
  } catch {
    // ignore cleanup errors on closed/mocked emitters
  }
}

/**
 * Watches terminal resize events (`stdout` `'resize'` and POSIX `SIGWINCH`),
 * debounces rapid tmux/screen pane-drag bursts, deduplicates identical sizes,
 * and cleans up all listeners and timers deterministically on `stop()`.
 */
export class TerminalResizeWatcher {
  private readonly output: ResizeOutputLike
  private readonly widthOverride?: number
  private readonly heightOverride?: number
  private readonly debounceMs: number
  private readonly signalSource: ResizeSignalSource | null
  private readonly onResize: (event: ResizeEvent) => void | Promise<void>
  private readonly onError?: (err: unknown) => void

  private running = false
  private lastDimensions: TuiViewportDimensions
  private resizeCount = 0
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSource: ResizeEventSource = 'resize'
  private pendingForce = false
  private sigwinchAttached = false

  private readonly onOutputResize = () => {
    this.trigger('resize')
  }

  private readonly onSigwinch = () => {
    this.trigger('SIGWINCH')
  }

  constructor(opts: TerminalResizeWatcherOptions) {
    this.output = opts.output
    this.widthOverride = opts.widthOverride
    this.heightOverride = opts.heightOverride
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS)
    this.onResize = opts.onResize
    this.onError = opts.onError

    if (opts.signalSource !== undefined) {
      this.signalSource = opts.signalSource
    } else if (opts.output === (process.stdout as unknown as ResizeOutputLike) && process.platform !== 'win32') {
      this.signalSource = process as unknown as ResizeSignalSource
    } else {
      this.signalSource = null
    }

    this.lastDimensions = this.measure()
  }

  private measure(): TuiViewportDimensions {
    return resolveViewportDimensions(this.output, {
      width: this.widthOverride,
      height: this.heightOverride,
    })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastDimensions = this.measure()

    if (typeof this.output.on === 'function') {
      this.output.on('resize', this.onOutputResize)
    }

    if (this.signalSource && typeof this.signalSource.on === 'function') {
      try {
        this.signalSource.on('SIGWINCH', this.onSigwinch)
        this.sigwinchAttached = true
      } catch {
        this.sigwinchAttached = false
      }
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    detachListener(this.output, 'resize', this.onOutputResize)
    if (this.sigwinchAttached && this.signalSource) {
      detachListener(this.signalSource, 'SIGWINCH', this.onSigwinch)
      this.sigwinchAttached = false
    }
  }

  isRunning(): boolean {
    return this.running
  }

  getDimensions(): TuiViewportDimensions {
    return { ...this.lastDimensions }
  }

  getResizeCount(): number {
    return this.resizeCount
  }

  /** Updates the baseline dimensions without firing `onResize`. */
  syncDimensions(): TuiViewportDimensions {
    this.lastDimensions = this.measure()
    return { ...this.lastDimensions }
  }

  /**
   * Schedules (or immediately dispatches) a resize check.
   * Rapid events within `debounceMs` are coalesced into a single `onResize` call.
   */
  trigger(
    source: ResizeEventSource = 'manual',
    opts: { immediate?: boolean; force?: boolean } = {},
  ): void {
    if (!this.running && source !== 'manual') return

    // Preserve SIGWINCH attribution if both SIGWINCH and 'resize' arrive in the same burst
    if (source === 'SIGWINCH' || this.debounceTimer === null) {
      this.pendingSource = source
    }
    if (opts.force) {
      this.pendingForce = true
    }

    if (opts.immediate || this.debounceMs === 0) {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      this.flush()
      return
    }

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (!this.running) return
      this.flush()
    }, this.debounceMs)

    if (typeof (this.debounceTimer as { unref?: () => void }).unref === 'function') {
      ;(this.debounceTimer as { unref: () => void }).unref()
    }
  }

  private flush(): void {
    const source = this.pendingSource
    const force = this.pendingForce
    this.pendingForce = false

    const next = this.measure()
    if (!force && dimensionsEqual(this.lastDimensions, next)) {
      return
    }

    const previous = { ...this.lastDimensions }
    this.lastDimensions = next
    this.resizeCount += 1

    const event: ResizeEvent = {
      previous,
      current: { ...next },
      source,
      resizeCount: this.resizeCount,
    }

    try {
      const result = this.onResize(event)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch((err) => {
          this.onError?.(err)
        })
      }
    } catch (err) {
      this.onError?.(err)
    }
  }
}
