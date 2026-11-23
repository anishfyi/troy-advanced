// Non-TTY / piped fallback detection and output sanitization for the Terminal Browser TUI.
// Ensures `troy-advanced browse` never corrupts redirected stdout, never hangs in raw mode
// when piped to a file or pager, and respects TERM=dumb, NO_COLOR, FORCE_COLOR, and EPIPE.

export type TuiRuntimeMode = 'interactive-tty' | 'piped-batch' | 'piped-snapshot' | 'dumb-terminal'

export type NonTtyPolicy = 'auto' | 'snapshot' | 'batch' | 'interactive'

export interface TuiStderrStream {
  isTTY?: boolean
  write(chunk: string | Uint8Array): boolean
}

export interface TuiTtyCapabilities {
  mode: TuiRuntimeMode
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  stderrIsTTY: boolean
  isDumbTerm: boolean
  noColor: boolean
  forceColor: boolean
  allowRawMode: boolean
  allowAnsiClear: boolean
  allowColor: boolean
  allowPromptEcho: boolean
  oneShotSnapshot: boolean
  reason: string | null
}

export interface DetectTtyOptions {
  input: { isTTY?: boolean }
  output: { isTTY?: boolean }
  stderr?: { isTTY?: boolean } | null
  env?: Record<string, string | undefined>
  rawMode?: boolean
  asciiOnly?: boolean
  color?: boolean
  nonTtyMode?: NonTtyPolicy
}

// Matches ANSI CSI sequences, OSC sequences, and 2-byte ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function parseNonTtyPolicy(raw: string | undefined): NonTtyPolicy | undefined {
  if (!raw) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'auto' || v === 'snapshot' || v === 'batch' || v === 'interactive') {
    return v
  }
  return undefined
}

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '')
}

export function hasAnsiEscapes(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b/.test(text)
}

/**
 * Sanitizes text emitted to a non-TTY / piped output stream or dumb terminal:
 * strips all ANSI escape sequences, normalizes CRLF to LF, removes stray CR
 * and non-printable C0 control characters (preserving LF and TAB).
 */
export function sanitizeNonTtyOutput(text: string): string {
  return stripAnsiSequences(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(UNSAFE_CONTROL_RE, '')
}

export function detectTtyCapabilities(opts: DetectTtyOptions): TuiTtyCapabilities {
  const env = opts.env ?? process.env
  const stdinIsTTY = Boolean(opts.input.isTTY)
  const stdoutIsTTY = Boolean(opts.output.isTTY)
  const stderrIsTTY = Boolean(opts.stderr?.isTTY)

  const term = (env.TERM ?? '').trim().toLowerCase()
  const isDumbTerm = term === 'dumb' || term === 'unknown'
  const noColor = typeof env.NO_COLOR === 'string' && env.NO_COLOR.length > 0
  const forceColorRaw = (env.FORCE_COLOR ?? '').trim().toLowerCase()
  const forceColor = forceColorRaw.length > 0 && forceColorRaw !== '0' && forceColorRaw !== 'false'

  const policy: NonTtyPolicy = opts.nonTtyMode ?? 'auto'

  let mode: TuiRuntimeMode
  let reason: string | null = null

  if (policy === 'snapshot') {
    mode = 'piped-snapshot'
    reason = 'non-TTY snapshot mode requested; emitting clean ASCII snapshot and exiting'
  } else if (policy === 'batch') {
    mode = 'piped-batch'
    reason = 'non-TTY batch mode requested; running line command loop without raw TTY control'
  } else if (policy === 'interactive') {
    mode = 'interactive-tty'
    reason = null
  } else if (opts.rawMode === true) {
    mode = 'interactive-tty'
    reason = null
  } else if (opts.rawMode === false) {
    mode = isDumbTerm ? 'dumb-terminal' : 'piped-batch'
    reason = isDumbTerm
      ? 'TERM=dumb detected; running line mode without ANSI escapes'
      : 'line mode requested; running without raw TTY control'
  } else if (!stdinIsTTY) {
    mode = 'piped-batch'
    reason = stdoutIsTTY
      ? 'stdin is not a TTY (redirected/piped); running line command mode without raw TTY control'
      : 'stdin and stdout are not TTYs (redirected/piped); running clean non-ANSI batch mode'
  } else if (!stdoutIsTTY) {
    mode = 'piped-snapshot'
    reason = 'stdout is not a TTY (redirected/piped); emitting clean one-shot ASCII snapshot without interactive TUI'
  } else if (isDumbTerm) {
    mode = 'dumb-terminal'
    reason = `TERM=${env.TERM ?? 'dumb'} detected; disabling raw mode and ANSI escape sequences`
  } else {
    mode = 'interactive-tty'
    reason = null
  }

  let allowRawMode: boolean
  if (policy === 'snapshot' || policy === 'batch') {
    allowRawMode = false
  } else if (policy === 'interactive') {
    allowRawMode = true
  } else if (typeof opts.rawMode === 'boolean') {
    allowRawMode = opts.rawMode
  } else {
    allowRawMode = mode === 'interactive-tty' && stdinIsTTY && stdoutIsTTY && !isDumbTerm
  }

  const allowAnsiClear = stdoutIsTTY && !isDumbTerm && mode === 'interactive-tty'

  let allowColor: boolean
  if (opts.asciiOnly) {
    allowColor = false
  } else if (typeof opts.color === 'boolean') {
    allowColor = opts.color
  } else if (!stdoutIsTTY || isDumbTerm || noColor) {
    allowColor = false
  } else {
    allowColor = true || forceColor
  }

  const oneShotSnapshot = mode === 'piped-snapshot'
  const allowPromptEcho = stdoutIsTTY && !oneShotSnapshot

  return {
    mode,
    stdinIsTTY,
    stdoutIsTTY,
    stderrIsTTY,
    isDumbTerm,
    noColor,
    forceColor,
    allowRawMode,
    allowAnsiClear,
    allowColor,
    allowPromptEcho,
    oneShotSnapshot,
    reason,
  }
}

export function formatFallbackNotice(caps: TuiTtyCapabilities): string | null {
  if (!caps.reason || caps.mode === 'interactive-tty') return null
  return `[troy-advanced] non-TTY fallback (${caps.mode}): ${caps.reason}\n`
}

export function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

export function safeWriteStream(stream: Pick<NodeJS.WritableStream, 'write'>, chunk: string): boolean {
  try {
    stream.write(chunk)
    return true
  } catch (err) {
    if (isBrokenPipeError(err)) return false
    throw err
  }
}
