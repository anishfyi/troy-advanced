// CLI runtime helpers: global --quiet / --verbose / --timeout flags,
// deterministic exit code classification (0 ok, 1 error, 2 policy refusal, 3 daemon offline),
// timeout enforcement, and secret-safe verbose diagnostics.

export const CLI_EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  POLICY_REFUSAL: 2,
  DAEMON_OFFLINE: 3,
} as const)

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES]
export type CliExitCategory = 'ok' | 'error' | 'policy_refusal' | 'daemon_offline'
export type CliVerbosity = 'quiet' | 'normal' | 'verbose'

export const DEFAULT_CLI_TIMEOUT_MS = 30_000
export const MAX_CLI_TIMEOUT_MS = 600_000

/**
 * Deterministic set of refusal codes emitted by troy-advanced policy guards
 * (readonly, SSRF, origin allow/deny, sensitive fields, submit guard, scheme guard,
 * policy profile rules, and session isolation).
 */
export const POLICY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'readonly',
  'ssrf',
  'origin',
  'origin_denied',
  'origin_not_allowed',
  'sensitive',
  'submit',
  'scheme',
  'tool_blocked',
  'eval_disabled',
  'max_act_steps',
  'session_isolation',
  'policy',
  'refused',
  'download_denied',
])

const DAEMON_OFFLINE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'EPIPE',
])

const SENSITIVE_META_KEYS = new Set([
  'token',
  'agenttoken',
  'passphrase',
  'password',
  'authorization',
  'x-troy-agent',
  'secret',
  'apikey',
])

export function exitCodeToCategory(code: CliExitCode): CliExitCategory {
  switch (code) {
    case CLI_EXIT_CODES.OK:
      return 'ok'
    case CLI_EXIT_CODES.POLICY_REFUSAL:
      return 'policy_refusal'
    case CLI_EXIT_CODES.DAEMON_OFFLINE:
      return 'daemon_offline'
    default:
      return 'error'
  }
}

export interface CliExitErrorOptions {
  exitCode: CliExitCode
  code?: string
  payload?: Record<string, unknown>
  alreadyPrinted?: boolean
  cause?: unknown
}

export class CliExitError extends Error {
  readonly exitCode: CliExitCode
  readonly category: CliExitCategory
  readonly code?: string
  readonly payload?: Record<string, unknown>
  readonly alreadyPrinted: boolean

  constructor(message: string, opts: CliExitErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'CliExitError'
    this.exitCode = opts.exitCode
    this.category = exitCodeToCategory(opts.exitCode)
    this.code = opts.code
    this.payload = opts.payload
    this.alreadyPrinted = Boolean(opts.alreadyPrinted)
  }
}

export function isPolicyRefusalResponse(res: unknown, httpStatus?: number): boolean {
  if (httpStatus === 403) return true
  if (!res || typeof res !== 'object') return false
  const rec = res as Record<string, unknown>
  if (rec.ok !== false) return false

  const status = typeof rec.status === 'string' ? rec.status.toLowerCase() : ''
  if (status === 'blocked' || status === 'boundary') return true

  const code = typeof rec.code === 'string' ? rec.code.toLowerCase() : ''
  if (code && POLICY_REFUSAL_CODES.has(code)) return true

  // Check nested refusal object (e.g. audit or flow step refusal)
  if (rec.refusal && typeof rec.refusal === 'object') return true

  return false
}

export function isDaemonOfflineResponse(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const rec = res as Record<string, unknown>
  if (rec.ok !== false) return false
  const code = typeof rec.code === 'string' ? rec.code.toLowerCase() : ''
  if (code === 'daemon_offline') return true
  if (rec.running === false) return true
  const err = typeof rec.error === 'string' ? rec.error.toLowerCase() : ''
  if (err.includes('daemon is not running') || err.includes('daemon offline')) return true
  return false
}

export function classifyResponseExitCode(res: unknown, httpStatus?: number): CliExitCode {
  if (!res || typeof res !== 'object') return CLI_EXIT_CODES.OK
  const rec = res as Record<string, unknown>
  if (rec.ok !== false) return CLI_EXIT_CODES.OK
  if (isPolicyRefusalResponse(rec, httpStatus)) return CLI_EXIT_CODES.POLICY_REFUSAL
  if (isDaemonOfflineResponse(rec)) return CLI_EXIT_CODES.DAEMON_OFFLINE
  return CLI_EXIT_CODES.ERROR
}

export function isPolicyRefusalError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if (err instanceof CliExitError) return err.exitCode === CLI_EXIT_CODES.POLICY_REFUSAL
  const rec = err as Record<string, unknown>
  const status = typeof rec.status === 'string' ? rec.status.toLowerCase() : ''
  if (status === 'blocked' || status === 'boundary') return true
  const code = typeof rec.code === 'string' ? rec.code.toLowerCase() : ''
  if (code && POLICY_REFUSAL_CODES.has(code)) return true
  const name = typeof rec.name === 'string' ? rec.name : ''
  if (name === 'SsrfBlockedError') return true
  return false
}

function extractErrnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const rec = err as Record<string, unknown>
  if (typeof rec.code === 'string') return rec.code
  if (rec.cause && typeof rec.cause === 'object') {
    const causeCode = (rec.cause as Record<string, unknown>).code
    if (typeof causeCode === 'string') return causeCode
  }
  return undefined
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const rec = err as Record<string, unknown>
  if (rec.name === 'TimeoutError' || rec.name === 'AbortError') return true
  if (rec.code === 'timeout' || rec.code === 'ABORT_ERR' || rec.code === 'ETIMEDOUT') return true
  if (rec.cause && isTimeoutError(rec.cause)) return true
  return false
}

export function isDaemonOfflineError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if (err instanceof CliExitError) return err.exitCode === CLI_EXIT_CODES.DAEMON_OFFLINE
  if (isTimeoutError(err)) return false
  const errno = extractErrnoCode(err)
  if (errno && DAEMON_OFFLINE_ERROR_CODES.has(errno)) return true
  const rec = err as Record<string, unknown>
  if (rec.code === 'daemon_offline') return true
  const msg = typeof rec.message === 'string' ? rec.message.toLowerCase() : ''
  if (
    msg.includes('econnrefused') ||
    msg.includes('daemon is not running') ||
    msg.includes('daemon offline') ||
    msg.includes('unable to connect to daemon')
  ) {
    return true
  }
  return false
}

export function classifyErrorExitCode(err: unknown): CliExitCode {
  if (err instanceof CliExitError) return err.exitCode
  if (isPolicyRefusalError(err)) return CLI_EXIT_CODES.POLICY_REFUSAL
  if (isDaemonOfflineError(err)) return CLI_EXIT_CODES.DAEMON_OFFLINE
  return CLI_EXIT_CODES.ERROR
}

export type ParseTimeoutResult =
  | { ok: true; timeoutMs?: number }
  | { ok: false; error: string }

/**
 * Parse `--timeout` flag value as milliseconds.
 * Accepts positive numbers or duration suffixes (`ms`, `s`, `m`), e.g.:
 * `5000`, `500ms`, `5s`, `1.5s`, `2m`.
 */
export function parseTimeoutMs(raw: unknown): ParseTimeoutResult {
  if (raw === undefined || raw === false) return { ok: true, timeoutMs: undefined }
  if (raw === true || raw === null) {
    return { ok: false, error: '--timeout requires a positive duration in ms (e.g. 5000, 500ms, 5s)' }
  }

  let ms: number
  if (typeof raw === 'number') {
    ms = raw
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed) {
      return { ok: false, error: '--timeout requires a positive duration in ms (e.g. 5000, 500ms, 5s)' }
    }
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(trimmed)
    if (!match) {
      return {
        ok: false,
        error: `Invalid --timeout value "${raw}". Expected a positive number or duration (e.g. 5000, 500ms, 5s, 1m)`,
      }
    }
    const value = Number(match[1])
    const unit = match[2] ?? 'ms'
    ms = unit === 'm' ? value * 60_000 : unit === 's' ? value * 1_000 : value
  } else {
    return { ok: false, error: '--timeout must be a positive number or duration string' }
  }

  if (!Number.isFinite(ms) || ms <= 0) {
    return { ok: false, error: `--timeout must be > 0 ms (got "${String(raw)}")` }
  }
  const rounded = Math.round(ms)
  if (rounded > MAX_CLI_TIMEOUT_MS) {
    return {
      ok: false,
      error: `--timeout exceeds maximum of ${MAX_CLI_TIMEOUT_MS}ms (got ${rounded}ms)`,
    }
  }
  return { ok: true, timeoutMs: rounded }
}

export interface CliIoStreams {
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export interface CliRuntimeInit {
  quiet?: boolean
  verbose?: boolean
  timeoutMs?: number
  io?: CliIoStreams
}

function sanitizeMetaValue(key: string, value: unknown): string {
  if (SENSITIVE_META_KEYS.has(key.toLowerCase())) return '[REDACTED]'
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return String(value)
  try {
    const s = JSON.stringify(value)
    return s.length > 160 ? `${s.slice(0, 157)}...` : s
  } catch {
    return '[object]'
  }
}

export class CliRuntime {
  readonly quiet: boolean
  readonly verbose: boolean
  readonly verbosity: CliVerbosity
  readonly timeoutMs?: number
  readonly startedAt: number
  private readonly stdoutFn: (line: string) => void
  private readonly stderrFn: (line: string) => void

  constructor(init: CliRuntimeInit = {}) {
    // --quiet takes precedence over --verbose so scripted silent invocations stay silent
    this.quiet = Boolean(init.quiet)
    this.verbose = !this.quiet && Boolean(init.verbose)
    this.verbosity = this.quiet ? 'quiet' : this.verbose ? 'verbose' : 'normal'
    this.timeoutMs = init.timeoutMs
    this.startedAt = Date.now()
    this.stdoutFn = init.io?.stdout ?? ((line) => console.log(line))
    this.stderrFn = init.io?.stderr ?? ((line) => console.error(line))
  }

  elapsedMs(): number {
    return Math.max(0, Date.now() - this.startedAt)
  }

  effectiveTimeoutMs(fallbackMs: number = DEFAULT_CLI_TIMEOUT_MS): number {
    return this.timeoutMs ?? fallbackMs
  }

  /** Write primary output to stdout unless `--quiet` is active. */
  out(text: string): void {
    if (this.quiet) return
    this.stdoutFn(text)
  }

  /** Write pretty JSON to stdout unless `--quiet` is active. */
  json(value: unknown): void {
    if (this.quiet) return
    this.stdoutFn(JSON.stringify(value, null, 2))
  }

  /** Write an error message to stderr unless `--quiet` is active. */
  error(text: string): void {
    if (this.quiet) return
    this.stderrFn(text)
  }

  /** Write a pretty JSON error payload to stderr unless `--quiet` is active. */
  errorJson(value: unknown): void {
    if (this.quiet) return
    this.stderrFn(JSON.stringify(value, null, 2))
  }

  /** Write a structured diagnostic line to stderr ONLY when `--verbose` is active. */
  debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.verbose) return
    const prefix = `[troy-advanced +${this.elapsedMs()}ms]`
    if (!meta || Object.keys(meta).length === 0) {
      this.stderrFn(`${prefix} ${message}`)
      return
    }
    const pairs = Object.entries(meta)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${sanitizeMetaValue(k, v)}`)
    this.stderrFn(pairs.length > 0 ? `${prefix} ${message} (${pairs.join(' ')})` : `${prefix} ${message}`)
  }

  /** Create an AbortSignal that fires after `overrideMs ?? this.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS`. */
  createTimeoutSignal(overrideMs?: number): {
    signal: AbortSignal
    timeoutMs: number
    clear: () => void
  } {
    const timeoutMs = overrideMs ?? this.effectiveTimeoutMs()
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(
        new CliExitError(`Command timed out after ${timeoutMs}ms`, {
          exitCode: CLI_EXIT_CODES.ERROR,
          code: 'timeout',
          payload: { ok: false, code: 'timeout', error: `Command timed out after ${timeoutMs}ms`, timeoutMs },
        }),
      )
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    return {
      signal: controller.signal,
      timeoutMs,
      clear: () => clearTimeout(timer),
    }
  }

  /** Race an async operation against the configured timeout (if set or overridden). */
  async withTimeout<T>(promise: Promise<T>, label: string, overrideMs?: number): Promise<T> {
    const ms = overrideMs ?? this.timeoutMs
    if (ms === undefined) return promise
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new CliExitError(`${label} timed out after ${ms}ms`, {
            exitCode: CLI_EXIT_CODES.ERROR,
            code: 'timeout',
            payload: { ok: false, code: 'timeout', error: `${label} timed out after ${ms}ms`, timeoutMs: ms },
          }),
        )
      }, ms)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Build a standardized daemon-offline CliExitError (exit code 3). */
  daemonOfflineError(
    message = 'troy-advanced daemon is not running. Start it with: troy-advanced daemon start',
    extra?: Record<string, unknown>,
  ): CliExitError {
    return new CliExitError(message, {
      exitCode: CLI_EXIT_CODES.DAEMON_OFFLINE,
      code: 'daemon_offline',
      payload: { ok: false, code: 'daemon_offline', error: message, ...extra },
    })
  }

  /** Classify a daemon/manager response into an exit code and log verbose summary. */
  classifyResponse(res: Record<string, unknown>, httpStatus?: number): CliExitCode {
    const code = classifyResponseExitCode(res, httpStatus)
    if (code !== CLI_EXIT_CODES.OK) {
      this.debug('command failed', {
        exitCode: code,
        category: exitCodeToCategory(code),
        status: typeof res.status === 'string' ? res.status : undefined,
        code: typeof res.code === 'string' ? res.code : undefined,
        httpStatus,
      })
    }
    return code
  }
}

export function resolveCliRuntime(
  flags: Record<string, string | boolean>,
  io?: CliIoStreams,
): { ok: true; runtime: CliRuntime } | { ok: false; error: string } {
  const parsedTimeout = parseTimeoutMs(flags.timeout)
  if (!parsedTimeout.ok) {
    return { ok: false, error: parsedTimeout.error }
  }
  return {
    ok: true,
    runtime: new CliRuntime({
      quiet: Boolean(flags.quiet),
      verbose: Boolean(flags.verbose),
      timeoutMs: parsedTimeout.timeoutMs,
      io,
    }),
  }
}

/**
 * Format a top-level uncaught CLI error for `bin/troy-advanced.mjs` and return
 * the clean process exit code (`1` error, `2` policy refusal, `3` daemon offline).
 */
export function handleTopLevelCliError(
  err: unknown,
  opts: { quiet?: boolean; verbose?: boolean; stderr?: (line: string) => void } = {},
): CliExitCode {
  const stderr = opts.stderr ?? ((line: string) => console.error(line))
  const exitCode = classifyErrorExitCode(err)
  const category = exitCodeToCategory(exitCode)
  const alreadyPrinted = err instanceof CliExitError && err.alreadyPrinted

  if (!opts.quiet && !alreadyPrinted) {
    const payload =
      err instanceof CliExitError && err.payload
        ? err.payload
        : {
            ok: false,
            code:
              err instanceof CliExitError && err.code
                ? err.code
                : typeof (err as { code?: unknown })?.code === 'string'
                  ? (err as { code: string }).code
                  : category,
            error: String((err as { message?: unknown })?.message ?? err),
          }
    stderr(JSON.stringify(payload, null, 2))
  }
  if (opts.verbose && !opts.quiet) {
    stderr(`[troy-advanced] exit=${exitCode} (${category})`)
  }
  return exitCode
}
