// Headless Simulated PTY & Stream Test Harness for Interactive TUI (`TerminalBrowserController`).
// Simulates a POSIX TTY (stdin with setRawMode, VT100/ANSI escape sequences, stdout with
// dynamic columns/rows + 'resize' events, stderr capture, and SIGWINCH signals) as well as
// non-TTY / piped streams without requiring native node-pty bindings or a real terminal.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { stripAnsi } from '../ascii/sanitize.js'
import type { ResizeSignalSource } from './resize.js'
import type { TuiInputStream, TuiOptions, TuiOutputStream } from './terminal-browser.js'
import type { TuiStderrStream } from './tty-fallback.js'

const CLEAR_SCREEN_SEQ = '\x1b[2J\x1b[H'

/**
 * Standard VT100 / xterm raw byte sequences recognized by Node.js `readline.emitKeypressEvents`.
 */
export const VT_KEYS = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  HOME: '\x1b[H',
  END: '\x1b[F',
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',
  TAB: '\t',
  SHIFT_TAB: '\x1b[Z',
  ENTER: '\r',
  ESCAPE: '\x1b',
  BACKSPACE: '\x7f',
  CTRL_C: '\x03',
  CTRL_L: '\x0c',
  CTRL_P: '\x10',
} as const

export type VtKeyName = keyof typeof VT_KEYS

export interface SimulatedPtyFrame {
  /** Zero-based frame index. */
  index: number
  /** Raw output text (may include ANSI escape sequences). */
  raw: string
  /** ANSI-stripped plain text of this frame. */
  plain: string
  /** Timestamp (ms) when this frame was last updated. */
  timestamp: number
}

export interface SimulatedPtyOptions {
  /** Initial terminal width in columns (default: 100). */
  columns?: number
  /** Initial terminal height in rows (default: 26). */
  rows?: number
  /** Whether stdin reports `isTTY = true` (default: true). */
  isInputTTY?: boolean
  /** Whether stdout reports `isTTY = true` (default: true). */
  isOutputTTY?: boolean
  /** Simulated environment variables passed to TUI (default: `{ TERM: 'xterm-256color' }`). */
  env?: Record<string, string | undefined>
}

interface Waiter {
  check: () => boolean
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SimulatedPtySession {
  readonly stdin: PassThrough & TuiInputStream
  readonly stdout: PassThrough & TuiOutputStream
  readonly stderr: PassThrough & TuiStderrStream
  readonly signalSource: EventEmitter & ResizeSignalSource
  readonly env: Record<string, string | undefined>

  readonly rawModeHistory: boolean[] = []
  private _isRawMode = false

  private readonly stdoutChunks: string[] = []
  private readonly stderrChunks: string[] = []
  private readonly frames: SimulatedPtyFrame[] = []
  private readonly waiters = new Set<Waiter>()

  constructor(opts: SimulatedPtyOptions = {}) {
    const isInputTTY = opts.isInputTTY ?? true
    const isOutputTTY = opts.isOutputTTY ?? true
    const columns = opts.columns ?? 100
    const rows = opts.rows ?? 26

    this.env = opts.env ? { ...opts.env } : { TERM: 'xterm-256color' }

    const stdin = new PassThrough() as PassThrough & TuiInputStream
    stdin.isTTY = isInputTTY
    if (isInputTTY) {
      stdin.setRawMode = (mode: boolean) => {
        this._isRawMode = mode
        this.rawModeHistory.push(mode)
        this.notifyWaiters()
      }
    }
    this.stdin = stdin

    const stdout = new PassThrough() as PassThrough & TuiOutputStream
    stdout.isTTY = isOutputTTY
    stdout.columns = columns
    stdout.rows = rows
    stdout.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.handleStdoutChunk(text)
    })
    this.stdout = stdout

    const stderr = new PassThrough() as PassThrough & TuiStderrStream
    stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.stderrChunks.push(text)
    })
    this.stderr = stderr

    this.signalSource = new EventEmitter() as EventEmitter & ResizeSignalSource
  }

  get isRawMode(): boolean {
    return this._isRawMode
  }

  private handleStdoutChunk(text: string): void {
    this.stdoutChunks.push(text)

    if (text.includes(CLEAR_SCREEN_SEQ)) {
      const parts = text.split(CLEAR_SCREEN_SEQ)
      // Any text before the first clear belongs to the previous frame (if one exists)
      if (parts[0] && parts[0].length > 0) {
        this.appendToCurrentFrame(parts[0])
      }
      for (let i = 1; i < parts.length; i++) {
        const raw = parts[i] ?? ''
        this.frames.push({
          index: this.frames.length,
          raw,
          plain: stripAnsi(raw),
          timestamp: Date.now(),
        })
      }
    } else if (text.length > 0) {
      this.appendToCurrentFrame(text)
    }

    this.notifyWaiters()
  }

  private appendToCurrentFrame(text: string): void {
    if (this.frames.length === 0) {
      this.frames.push({
        index: 0,
        raw: text,
        plain: stripAnsi(text),
        timestamp: Date.now(),
      })
      return
    }
    const current = this.frames[this.frames.length - 1]!
    current.raw += text
    current.plain = stripAnsi(current.raw)
    current.timestamp = Date.now()
  }

  private notifyWaiters(): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.check()) {
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  /** Number of rendered frames captured so far. */
  getFrameCount(): number {
    return this.frames.length
  }

  /** Snapshot copies of all captured frames. */
  getFrames(): SimulatedPtyFrame[] {
    return this.frames.map((f) => ({ ...f }))
  }

  /** Most recent rendered frame, if any. */
  getLastFrame(): SimulatedPtyFrame | undefined {
    const last = this.frames[this.frames.length - 1]
    return last ? { ...last } : undefined
  }

  /** Full concatenated raw stdout output. */
  getAllStdout(): string {
    return this.stdoutChunks.join('')
  }

  /** Full concatenated ANSI-stripped stdout output. */
  getAllStdoutPlain(): string {
    return stripAnsi(this.stdoutChunks.join(''))
  }

  /** Full concatenated stderr output. */
  getStderr(): string {
    return this.stderrChunks.join('')
  }

  /** Write raw bytes or UTF-8 string directly into the simulated PTY stdin. */
  sendBytes(bytes: string | Buffer): void {
    this.stdin.write(bytes)
  }

  /** Send a named VT100 key (from `VT_KEYS`) or a literal character/escape sequence. */
  sendKey(key: VtKeyName | (string & {})): void {
    const seq = Object.prototype.hasOwnProperty.call(VT_KEYS, key)
      ? VT_KEYS[key as VtKeyName]
      : key
    this.stdin.write(seq)
  }

  /** Type a string one character at a time into stdin (simulating real human/PTY typing). */
  typeText(text: string): void {
    for (const ch of text) {
      this.stdin.write(ch)
    }
  }

  /** Send a full line terminated by `\n` (useful for non-TTY/batch line mode). */
  sendLine(line: string): void {
    this.stdin.write(`${line}\n`)
  }

  /** Close stdin cleanly (EOF). */
  endInput(): void {
    this.stdin.end()
  }

  /** Simulate a terminal resize by updating stdout dimensions and firing stdout `'resize'` and/or `SIGWINCH`. */
  resize(columns: number, rows: number, trigger: 'stdout' | 'sigwinch' | 'both' = 'sigwinch'): void {
    this.stdout.columns = columns
    this.stdout.rows = rows
    if (trigger === 'stdout' || trigger === 'both') {
      this.stdout.emit('resize')
    }
    if (trigger === 'sigwinch' || trigger === 'both') {
      this.signalSource.emit('SIGWINCH')
    }
  }

  /** Inject an output stream error (e.g. `EPIPE`) to verify broken-pipe handling. */
  emitOutputError(err: NodeJS.ErrnoException): void {
    this.stdout.emit('error', err)
  }

  /**
   * Wait until a frame at or after `fromIndex` satisfies `predicate`.
   * Checks already-captured frames first so there are no race conditions.
   */
  waitForFrame(
    predicate: (frame: SimulatedPtyFrame) => boolean,
    opts: { fromIndex?: number; timeoutMs?: number; label?: string } = {},
  ): Promise<SimulatedPtyFrame> {
    const fromIndex = opts.fromIndex ?? 0
    const timeoutMs = opts.timeoutMs ?? 4000

    const findMatch = (): SimulatedPtyFrame | undefined => {
      for (let i = Math.max(0, fromIndex); i < this.frames.length; i++) {
        const frame = this.frames[i]!
        if (predicate(frame)) {
          return { ...frame }
        }
      }
      return undefined
    }

    const immediate = findMatch()
    if (immediate) return Promise.resolve(immediate)

    return new Promise<SimulatedPtyFrame>((resolve, reject) => {
      let matched: SimulatedPtyFrame | undefined
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        const lastPlain = this.getLastFrame()?.plain ?? '(no frames)'
        const preview =
          lastPlain.length > 600
            ? `${lastPlain.slice(0, 260)}\n...\n${lastPlain.slice(-300)}`
            : lastPlain
        reject(
          new Error(
            `SimulatedPtySession.waitForFrame timed out after ${timeoutMs}ms` +
              (opts.label ? ` (${opts.label})` : '') +
              ` [frames=${this.frames.length}, fromIndex=${fromIndex}]. Last frame preview:\n${preview}`,
          ),
        )
      }, timeoutMs)

      const waiter: Waiter = {
        check: () => {
          matched = findMatch()
          return matched !== undefined
        },
        resolve: () => {
          resolve(matched!)
        },
        reject,
        timer,
      }
      this.waiters.add(waiter)
    })
  }

  /** Wait for a new frame whose index is strictly greater than `afterIndex` (or current last index). */
  waitForNextFrame(afterIndex?: number, timeoutMs = 4000): Promise<SimulatedPtyFrame> {
    const targetIndex = afterIndex !== undefined ? afterIndex + 1 : this.frames.length
    return this.waitForFrame((frame) => frame.index >= targetIndex && frame.plain.trim().length > 0, {
      fromIndex: targetIndex,
      timeoutMs,
      label: `nextFrame>=${targetIndex}`,
    })
  }

  /** Wait until concatenated stdout satisfies `predicate`. */
  waitForStdout(
    predicate: (allPlain: string, allRaw: string) => boolean,
    timeoutMs = 4000,
    label?: string,
  ): Promise<string> {
    const rawNow = this.getAllStdout()
    const plainNow = stripAnsi(rawNow)
    if (predicate(plainNow, rawNow)) {
      return Promise.resolve(plainNow)
    }

    return new Promise<string>((resolve, reject) => {
      let latestPlain = plainNow
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(
          new Error(
            `SimulatedPtySession.waitForStdout timed out after ${timeoutMs}ms` +
              (label ? ` (${label})` : '') +
              `. Output length=${this.getAllStdout().length}`,
          ),
        )
      }, timeoutMs)

      const waiter: Waiter = {
        check: () => {
          const raw = this.getAllStdout()
          const plain = stripAnsi(raw)
          if (predicate(plain, raw)) {
            latestPlain = plain
            return true
          }
          return false
        },
        resolve: () => resolve(latestPlain),
        reject,
        timer,
      }
      this.waiters.add(waiter)
    })
  }

  /** Wait until `isRawMode` equals `expected` (useful right after `runTerminalBrowser` starts). */
  waitForRawMode(expected: boolean, timeoutMs = 4000): Promise<void> {
    if (this._isRawMode === expected) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`SimulatedPtySession.waitForRawMode(${expected}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const waiter: Waiter = {
        check: () => this._isRawMode === expected,
        resolve,
        reject,
        timer,
      }
      this.waiters.add(waiter)
    })
  }

  /** Build ready-to-use `TuiOptions` wired to this simulated PTY session. */
  createTuiOptions(overrides: Partial<TuiOptions> = {}): TuiOptions {
    return {
      input: this.stdin,
      output: this.stdout,
      stderr: this.stderr,
      env: this.env,
      resizeSignalSource: this.signalSource,
      resizeDebounceMs: 10,
      libraryPath: null,
      ...overrides,
    }
  }

  /** Clean up any pending waiters. */
  dispose(): void {
    for (const waiter of Array.from(this.waiters)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('SimulatedPtySession disposed'))
    }
    this.waiters.clear()
  }
}
