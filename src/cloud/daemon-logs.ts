// Daemon log rotation, tailing, and live follow utilities for troy-advanced.

import fs from 'node:fs'
import path from 'node:path'
import { defaultEndpointPath } from '../bridge/endpoint.js'

export const DEFAULT_DAEMON_LOG_FILENAME = 'daemon.log'
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB
export const DEFAULT_LOG_MAX_FILES = 5
export const DEFAULT_LOG_TAIL_LINES = 50
export const DEFAULT_LOG_FILE_MODE = 0o600
export const DEFAULT_LOG_POLL_INTERVAL_MS = 150

export interface LogRotationOptions {
  /** Rotate once the active log file reaches or exceeds this many bytes (default: 5 MiB). */
  maxBytes?: number
  /** Maximum number of rotated archive files (.1 .. .N) to keep (default: 5). */
  maxFiles?: number
  /** File permission mode for created/rotated log files (default: 0o600). */
  fileMode?: number
  /**
   * Copy active log to .1 and truncate in place instead of renaming.
   * Useful when an external child process holds an O_APPEND stdout/stderr fd to the active file.
   */
  copyTruncate?: boolean
}

export interface NormalizedLogRotationOptions {
  maxBytes: number
  maxFiles: number
  fileMode: number
  copyTruncate: boolean
}

export interface LogRotateResult {
  rotated: boolean
  logFile: string
  rotatedTo?: string
  sizeBytes?: number
  pruned: string[]
}

export interface LogFileInfo {
  path: string
  name: string
  /** 0 for active daemon.log, 1 for daemon.log.1, etc. */
  index: number
  active: boolean
  sizeBytes: number
  mtimeMs: number
}

export interface ReadLogTailOptions {
  /** Number of trailing lines to return (default: 50; pass Infinity or null for all lines). */
  tail?: number | null
  /** Include rotated archives (.1, .2, ...) if more lines are requested or reading all logs. */
  includeRotated?: boolean
}

export interface ReadLogTailResult {
  exists: boolean
  logFile: string
  lines: string[]
  totalLines: number
  sizeBytes: number
  rotatedFiles: number
  files: LogFileInfo[]
}

export interface FollowLogOptions {
  /** Initial trailing lines to emit before streaming new lines (default: 50). */
  tail?: number
  /** Poll interval in milliseconds (default: 150). */
  pollIntervalMs?: number
  /** Optional AbortSignal to stop following cleanly. */
  signal?: AbortSignal
  /** Invoked for every emitted log line (without trailing newline). */
  onLine: (line: string) => void
  /** Invoked when log rotation or truncation is detected. */
  onRotate?: (info: { logFile: string; reason: 'truncated' | 'replaced' }) => void
  /** Invoked on unexpected non-ENOENT filesystem errors. */
  onError?: (err: Error) => void
}

export interface FollowLogHandle {
  stop: () => void
  done: Promise<void>
}

export function defaultDaemonLogPath(endpointFile?: string): string {
  const ep = endpointFile || defaultEndpointPath()
  return path.join(path.dirname(path.resolve(ep)), DEFAULT_DAEMON_LOG_FILENAME)
}

export function rotatedLogPath(logFile: string, index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Rotated log index must be a positive integer, got ${index}`)
  }
  return `${logFile}.${index}`
}

export function normalizeLogRotationOptions(opts: LogRotationOptions = {}): NormalizedLogRotationOptions {
  const maxBytes =
    typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes >= 1
      ? Math.floor(opts.maxBytes)
      : DEFAULT_LOG_MAX_BYTES
  const maxFiles =
    typeof opts.maxFiles === 'number' && Number.isFinite(opts.maxFiles) && opts.maxFiles >= 0
      ? Math.floor(opts.maxFiles)
      : DEFAULT_LOG_MAX_FILES
  const fileMode =
    typeof opts.fileMode === 'number' && Number.isFinite(opts.fileMode)
      ? opts.fileMode
      : DEFAULT_LOG_FILE_MODE
  const copyTruncate = Boolean(opts.copyTruncate)
  return { maxBytes, maxFiles, fileMode, copyTruncate }
}

/**
 * List the active log file and any rotated archives (`.1`, `.2`, ...), sorted newest-first.
 */
export function listLogFiles(logFile: string): LogFileInfo[] {
  const abs = path.resolve(logFile)
  const dir = path.dirname(abs)
  const base = path.basename(abs)
  if (!fs.existsSync(dir)) return []

  const results: LogFileInfo[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  for (const name of entries) {
    let index: number | null = null
    if (name === base) {
      index = 0
    } else if (name.startsWith(`${base}.`)) {
      const suffix = name.slice(base.length + 1)
      if (/^[1-9]\d*$/.test(suffix)) {
        index = Number(suffix)
      }
    }
    if (index === null) continue
    const fullPath = path.join(dir, name)
    try {
      const st = fs.statSync(fullPath)
      if (!st.isFile()) continue
      results.push({
        path: fullPath,
        name,
        index,
        active: index === 0,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      })
    } catch {
      // Ignore files deleted concurrently
    }
  }

  results.sort((a, b) => a.index - b.index)
  return results
}

/**
 * Rotate `logFile` immediately:
 * - Prunes archives >= maxFiles
 * - Shifts `.i` -> `.{i+1}`
 * - Moves (or copy-truncates) `logFile` -> `.1`
 */
export function rotateLogFile(logFile: string, opts: LogRotationOptions = {}): LogRotateResult {
  const abs = path.resolve(logFile)
  const norm = normalizeLogRotationOptions(opts)
  const pruned: string[] = []

  let activeStat: fs.Stats
  try {
    activeStat = fs.statSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rotated: false, logFile: abs, pruned }
    }
    throw err
  }

  // Prune any rotated files at or beyond maxFiles
  const existing = listLogFiles(abs)
  for (const file of existing) {
    if (file.index >= norm.maxFiles && file.index >= 1) {
      try {
        fs.unlinkSync(file.path)
        pruned.push(file.path)
      } catch {
        // Ignore concurrent unlink
      }
    }
  }

  if (norm.maxFiles === 0) {
    fs.truncateSync(abs, 0)
    return {
      rotated: true,
      logFile: abs,
      sizeBytes: activeStat.size,
      pruned,
    }
  }

  // Shift .maxFiles-1 down to .1
  for (let i = norm.maxFiles - 1; i >= 1; i--) {
    const src = rotatedLogPath(abs, i)
    const dst = rotatedLogPath(abs, i + 1)
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst)
    }
  }

  const dest = rotatedLogPath(abs, 1)
  if (norm.copyTruncate) {
    fs.copyFileSync(abs, dest)
    try {
      fs.chmodSync(dest, norm.fileMode)
    } catch {
      // Best-effort chmod
    }
    fs.truncateSync(abs, 0)
  } else {
    fs.renameSync(abs, dest)
    try {
      fs.chmodSync(dest, norm.fileMode)
    } catch {
      // Best-effort chmod
    }
  }

  return {
    rotated: true,
    logFile: abs,
    rotatedTo: dest,
    sizeBytes: activeStat.size,
    pruned,
  }
}

/**
 * Rotate `logFile` only if it exists and its size is >= `maxBytes`.
 */
export function rotateIfNeeded(logFile: string, opts: LogRotationOptions = {}): LogRotateResult {
  const abs = path.resolve(logFile)
  const norm = normalizeLogRotationOptions(opts)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rotated: false, logFile: abs, pruned: [] }
    }
    throw err
  }
  if (st.size < norm.maxBytes) {
    return { rotated: false, logFile: abs, sizeBytes: st.size, pruned: [] }
  }
  return rotateLogFile(abs, norm)
}

/**
 * Clear the active log file (and optionally all rotated archives).
 */
export function clearLogFiles(
  logFile: string,
  opts: { includeRotated?: boolean } = {},
): { cleared: string[] } {
  const abs = path.resolve(logFile)
  const cleared: string[] = []
  if (fs.existsSync(abs)) {
    fs.truncateSync(abs, 0)
    cleared.push(abs)
  }
  if (opts.includeRotated) {
    for (const file of listLogFiles(abs)) {
      if (!file.active) {
        try {
          fs.unlinkSync(file.path)
          cleared.push(file.path)
        } catch {
          // Ignore concurrent unlink
        }
      }
    }
  }
  return { cleared }
}

/**
 * Size-bounded rotating log writer for daemon and programmatic callers.
 */
export class RotatingLogWriter {
  readonly logFile: string
  readonly options: NormalizedLogRotationOptions
  private totalBytesWritten = 0
  private rotations = 0

  constructor(logFile: string, opts: LogRotationOptions = {}) {
    this.logFile = path.resolve(logFile)
    this.options = normalizeLogRotationOptions(opts)
  }

  write(chunk: string | Buffer): { bytesWritten: number; rotated: boolean } {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true })

    let rotated = false
    let currentSize = 0
    try {
      currentSize = fs.statSync(this.logFile).size
    } catch {
      currentSize = 0
    }

    if (currentSize > 0 && currentSize + buf.length > this.options.maxBytes) {
      const res = rotateLogFile(this.logFile, this.options)
      if (res.rotated) {
        rotated = true
        this.rotations++
      }
    }

    fs.appendFileSync(this.logFile, buf, { mode: this.options.fileMode })
    this.totalBytesWritten += buf.length
    return { bytesWritten: buf.length, rotated }
  }

  writeLine(line: string): { bytesWritten: number; rotated: boolean } {
    return this.write(line.endsWith('\n') ? line : `${line}\n`)
  }

  writeJson(record: Record<string, unknown>): { bytesWritten: number; rotated: boolean } {
    return this.writeLine(JSON.stringify(record))
  }

  rotateNow(): LogRotateResult {
    const res = rotateLogFile(this.logFile, this.options)
    if (res.rotated) this.rotations++
    return res
  }

  getStats(): {
    logFile: string
    currentSizeBytes: number
    totalBytesWritten: number
    rotations: number
    maxBytes: number
    maxFiles: number
    files: LogFileInfo[]
  } {
    let currentSizeBytes = 0
    try {
      currentSizeBytes = fs.statSync(this.logFile).size
    } catch {
      currentSizeBytes = 0
    }
    return {
      logFile: this.logFile,
      currentSizeBytes,
      totalBytesWritten: this.totalBytesWritten,
      rotations: this.rotations,
      maxBytes: this.options.maxBytes,
      maxFiles: this.options.maxFiles,
      files: listLogFiles(this.logFile),
    }
  }
}

function splitLinesUtf8(text: string): string[] {
  if (!text) return []
  const raw = text.split(/\r?\n/)
  if (raw.length > 0 && raw[raw.length - 1] === '') {
    raw.pop()
  }
  return raw
}

/**
 * Read the last `tail` lines from `logFile` (optionally spanning rotated archives).
 */
export function readLogTail(logFile: string, opts: ReadLogTailOptions = {}): ReadLogTailResult {
  const abs = path.resolve(logFile)
  const files = listLogFiles(abs)
  const active = files.find((f) => f.active)
  const rotatedCount = files.filter((f) => !f.active).length

  if (!active && (!opts.includeRotated || files.length === 0)) {
    return {
      exists: false,
      logFile: abs,
      lines: [],
      totalLines: 0,
      sizeBytes: 0,
      rotatedFiles: rotatedCount,
      files,
    }
  }

  const tailLimit =
    opts.tail === null || opts.tail === Infinity
      ? null
      : typeof opts.tail === 'number' && Number.isFinite(opts.tail) && opts.tail >= 0
        ? Math.floor(opts.tail)
        : DEFAULT_LOG_TAIL_LINES

  let allLines: string[] = []
  let totalSize = 0

  if (opts.includeRotated) {
    // Chronological order: oldest rotated archive (.N) -> ... -> .1 -> active (0)
    const chronological = [...files].sort((a, b) => b.index - a.index)
    for (const file of chronological) {
      totalSize += file.sizeBytes
      try {
        const content = fs.readFileSync(file.path, 'utf8')
        allLines.push(...splitLinesUtf8(content))
      } catch {
        // Ignore concurrently removed archive
      }
    }
  } else if (active) {
    totalSize = active.sizeBytes
    const content = fs.readFileSync(active.path, 'utf8')
    allLines = splitLinesUtf8(content)
  }

  const lines =
    tailLimit === null
      ? allLines
      : tailLimit === 0
        ? []
        : allLines.slice(-tailLimit)

  return {
    exists: Boolean(active) || files.length > 0,
    logFile: abs,
    lines,
    totalLines: allLines.length,
    sizeBytes: totalSize,
    rotatedFiles: rotatedCount,
    files,
  }
}

/**
 * Tail and live-follow `logFile`, seamlessly handling log rotation (rename or copy-truncate).
 */
export function followLogFile(logFile: string, opts: FollowLogOptions): FollowLogHandle {
  const abs = path.resolve(logFile)
  const tailLines =
    typeof opts.tail === 'number' && Number.isFinite(opts.tail) && opts.tail >= 0
      ? Math.floor(opts.tail)
      : DEFAULT_LOG_TAIL_LINES
  const pollIntervalMs =
    typeof opts.pollIntervalMs === 'number' && Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs >= 10
      ? Math.floor(opts.pollIntervalMs)
      : DEFAULT_LOG_POLL_INTERVAL_MS

  let offset = 0
  let lastIno: number | null = null
  let partial = ''
  let stopped = false

  // Emit initial tail snapshot if file exists
  try {
    const st = fs.statSync(abs)
    if (st.isFile()) {
      const content = fs.readFileSync(abs, 'utf8')
      const lines = splitLinesUtf8(content)
      const initial = tailLines === 0 ? [] : lines.slice(-tailLines)
      for (const line of initial) {
        opts.onLine(line)
      }
      offset = st.size
      lastIno = st.ino
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      opts.onError?.(err as Error)
    }
  }

  const readAvailable = () => {
    if (stopped) return
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (lastIno !== null) {
          offset = 0
          lastIno = null
          partial = ''
        }
        return
      }
      opts.onError?.(err as Error)
      return
    }

    if (!st.isFile()) return

    if (lastIno !== null && st.ino !== lastIno) {
      offset = 0
      partial = ''
      lastIno = st.ino
      opts.onRotate?.({ logFile: abs, reason: 'replaced' })
    } else if (st.size < offset) {
      offset = 0
      partial = ''
      lastIno = st.ino
      opts.onRotate?.({ logFile: abs, reason: 'truncated' })
    } else if (lastIno === null) {
      lastIno = st.ino
    }

    if (st.size <= offset) return

    const toRead = st.size - offset
    const buf = Buffer.allocUnsafe(toRead)
    let fd: number | null = null
    try {
      fd = fs.openSync(abs, 'r')
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset)
      if (bytesRead <= 0) return
      offset += bytesRead
      const chunk = partial + buf.subarray(0, bytesRead).toString('utf8')
      const parts = chunk.split('\n')
      partial = parts.pop() ?? ''
      for (const rawLine of parts) {
        opts.onLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        opts.onError?.(err as Error)
      }
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const timer = setInterval(readAvailable, pollIntervalMs)

  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (opts.signal) {
      opts.signal.removeEventListener('abort', stop)
    }
    resolveDone()
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      stop()
    } else {
      opts.signal.addEventListener('abort', stop, { once: true })
    }
  }

  return { stop, done }
}

/**
 * Format a compact ASCII summary header for log files.
 */
export function formatDaemonLogInfoAscii(result: ReadLogTailResult): string {
  const lines = [
    `Daemon Log : ${result.logFile}`,
    `Exists     : ${result.exists ? 'yes' : 'no'}`,
    `Size       : ${result.sizeBytes} bytes`,
    `Lines      : ${result.lines.length} shown / ${result.totalLines} total`,
    `Rotated    : ${result.rotatedFiles} archive(s)`,
  ]
  return lines.join('\n')
}
