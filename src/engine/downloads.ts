// Download interception, unsafe auto-download blocking, and profile-scoped quarantine (M27).
// Quarantined files are stored under <profileDir>/quarantine using opaque IDs and 0600 permissions
// (never executable, never written to ~/Downloads, and safe from filename path-traversal attacks).

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  DownloadEntry,
  DownloadEvent,
  DownloadPolicyMode,
  DownloadPolicyOptions,
  DownloadStats,
  DownloadStatus,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

export const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024 // 50 MiB
const MAX_DOWNLOAD_ENTRIES = 200

// Bidi override / isolate codepoints used in filename spoofing (e.g. invoice\u202Efdp.exe)
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]+/g

export const UNSAFE_DOWNLOAD_EXTENSIONS = new Set<string>([
  // Windows & native executables / installers / libraries
  '.exe',
  '.msi',
  '.msp',
  '.com',
  '.scr',
  '.pif',
  '.dll',
  '.sys',
  '.drv',
  '.cpl',
  '.ocx',
  '.elf',
  '.so',
  '.dylib',
  '.bin',
  '.run',
  '.out',
  '.appimage',
  // Shell & scripting languages
  '.sh',
  '.bash',
  '.zsh',
  '.csh',
  '.ksh',
  '.fish',
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.psd1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.mjs',
  '.cjs',
  '.wsf',
  '.wsh',
  '.hta',
  '.py',
  '.pyw',
  '.rb',
  '.pl',
  '.php',
  '.lua',
  // OS packages, disk images, browser extensions, Java archives
  '.dmg',
  '.pkg',
  '.app',
  '.command',
  '.deb',
  '.rpm',
  '.apk',
  '.ipa',
  '.jar',
  '.war',
  '.ear',
  '.jnlp',
  '.crx',
  '.xpi',
  // Shortcuts, registry files, disk images, Office macro-enabled docs
  '.lnk',
  '.url',
  '.desktop',
  '.iso',
  '.img',
  '.vhd',
  '.vhdx',
  '.reg',
  '.inf',
  '.docm',
  '.xlsm',
  '.pptm',
  '.dotm',
  '.xltm',
])

export const UNSAFE_DOWNLOAD_MIME_TYPES = new Set<string>([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-elf',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-csh',
  'application/x-apple-diskimage',
  'application/vnd.microsoft.portable-executable',
  'application/java-archive',
  'application/x-dosexec',
  'application/x-msi',
  'application/hta',
  'application/x-debian-package',
  'application/x-rpm',
  'application/vnd.android.package-archive',
  'text/x-shellscript',
])

const INLINE_RENDERABLE_MIME_PREFIXES = [
  'text/html',
  'text/plain',
  'text/css',
  'text/csv',
  'text/markdown',
  'text/xml',
  'application/xhtml+xml',
  'application/json',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'image/svg+xml',
]

export interface ResolvedDownloadPolicy {
  mode: DownloadPolicyMode
  quarantineDir: string
  maxBytes: number
  extraBlockedExtensions: Set<string>
  allowedExtensions: Set<string>
}

export function normalizeExtension(ext: string): string {
  const cleaned = String(ext ?? '')
    .trim()
    .toLowerCase()
  if (!cleaned) return ''
  return cleaned.startsWith('.') ? cleaned : `.${cleaned}`
}

export function parseDownloadMode(raw: unknown): DownloadPolicyMode | undefined {
  if (raw === 'quarantine' || raw === 'deny' || raw === 'allow') return raw
  return undefined
}

export function resolveDownloadPolicy(
  opts: DownloadPolicyOptions | undefined,
  defaultQuarantineDir: string,
): ResolvedDownloadPolicy {
  const mode: DownloadPolicyMode = parseDownloadMode(opts?.mode) ?? 'quarantine'
  const quarantineDir = path.resolve(opts?.quarantineDir || defaultQuarantineDir)
  const maxBytes =
    typeof opts?.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? Math.floor(opts.maxBytes)
      : DEFAULT_DOWNLOAD_MAX_BYTES
  const extraBlockedExtensions = new Set<string>(
    (opts?.extraBlockedExtensions ?? []).map(normalizeExtension).filter(Boolean),
  )
  const allowedExtensions = new Set<string>(
    (opts?.allowedExtensions ?? []).map(normalizeExtension).filter(Boolean),
  )
  return {
    mode,
    quarantineDir,
    maxBytes,
    extraBlockedExtensions,
    allowedExtensions,
  }
}

export interface SanitizedFilenameInfo {
  displayFilename: string
  safeFilename: string
  extension: string
  hadPathTraversal: boolean
  hadRtlSpoof: boolean
}

function filenameFromUrl(url: string | undefined): string {
  if (!url) return 'download'
  try {
    const parsed = new URL(url)
    const seg = parsed.pathname.split('/').filter(Boolean).pop()
    if (seg) {
      return decodeURIComponent(seg)
    }
  } catch {
    // ignore malformed URL
  }
  return 'download'
}

/**
 * Sanitize a server-supplied or <a download> filename.
 * Detects path traversal and Unicode Bidi/RTL spoofing attacks while preserving
 * a human-inspectable filename.
 */
export function sanitizeSuggestedFilename(raw: string | undefined, fallbackUrl?: string): SanitizedFilenameInfo {
  const source = (raw && raw.trim()) || filenameFromUrl(fallbackUrl)
  const hadRtlSpoof = BIDI_CONTROL_RE.test(source)
  const hadPathTraversal =
    source.includes('..') ||
    source.includes('/') ||
    source.includes('\\') ||
    source.includes('\0')

  // Strip control characters and bidi overrides
  const stripped = source.replace(CONTROL_CHARS_RE, '').replace(new RegExp(BIDI_CONTROL_RE.source, 'g'), '')
  // Take final path segment across both POSIX and Windows separators
  const basePosix = path.posix.basename(stripped)
  const baseWin = path.win32.basename(basePosix)
  const trimmed = baseWin.replace(/^\.+/, '').trim()
  const displayFilename = (trimmed || 'download').slice(0, 200)
  const safeFilename = displayFilename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'download'
  const ext = path.posix.extname(displayFilename).toLowerCase()

  return {
    displayFilename,
    safeFilename,
    extension: ext,
    hadPathTraversal,
    hadRtlSpoof,
  }
}

/**
 * Parse Content-Disposition header for attachment flag and filename (RFC 6266 / RFC 5987).
 */
export function parseContentDispositionFilename(header: string | null | undefined): {
  isAttachment: boolean
  filename?: string
} {
  if (!header) return { isAttachment: false }
  const isAttachment = /^\s*attachment\b/i.test(header)

  // Prefer RFC 5987 filename*=UTF-8''...
  const extMatch = /filename\*\s*=\s*([^;]+)/i.exec(header)
  if (extMatch) {
    const rawVal = extMatch[1]!.trim().replace(/^["']|["']$/g, '')
    const parts = rawVal.split("''")
    const encoded = parts.length >= 2 ? parts.slice(1).join("''") : rawVal
    try {
      const decoded = decodeURIComponent(encoded).trim()
      if (decoded) return { isAttachment, filename: decoded }
    } catch {
      if (encoded) return { isAttachment, filename: encoded }
    }
  }

  // Standard filename="..." or filename=...
  const quotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(header)
  if (quotedMatch && quotedMatch[1]) {
    return { isAttachment, filename: quotedMatch[1].trim() }
  }
  const bareMatch = /filename\s*=\s*([^;\s]+)/i.exec(header)
  if (bareMatch && bareMatch[1]) {
    return { isAttachment, filename: bareMatch[1].trim().replace(/^["']|["']$/g, '') }
  }

  return { isAttachment }
}

/**
 * Determine whether an HTTP response in Lite engine should be intercepted as a download
 * rather than rendered as an HTML/text document.
 */
export function isDownloadResponse(
  contentDisposition: string | null | undefined,
  contentType: string | null | undefined,
): boolean {
  const disp = parseContentDispositionFilename(contentDisposition)
  if (disp.isAttachment) return true
  if (!contentType) return false
  const mime = contentType.split(';')[0]!.trim().toLowerCase()
  if (!mime) return false
  if (INLINE_RENDERABLE_MIME_PREFIXES.some((prefix) => mime === prefix || mime.startsWith(`${prefix}+`))) {
    return false
  }
  if (mime.startsWith('text/')) return false
  if (
    UNSAFE_DOWNLOAD_MIME_TYPES.has(mime) ||
    mime === 'application/octet-stream' ||
    mime === 'application/pdf' ||
    mime === 'application/zip' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    mime === 'application/x-tar' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/vnd.rar'
  ) {
    return true
  }
  return false
}

export interface DownloadClassification {
  allowed: boolean
  blockedReason?: string
  displayFilename: string
  safeFilename: string
  extension: string
}

export function classifyDownload(
  input: {
    suggestedFilename?: string
    url: string
    mimeType?: string
    totalBytes?: number
  },
  policy: ResolvedDownloadPolicy,
): DownloadClassification {
  const info = sanitizeSuggestedFilename(input.suggestedFilename, input.url)
  const mime = input.mimeType ? input.mimeType.split(';')[0]!.trim().toLowerCase() : undefined

  if (policy.mode === 'deny') {
    return {
      allowed: false,
      blockedReason: 'downloads_denied_by_policy',
      displayFilename: info.displayFilename,
      safeFilename: info.safeFilename,
      extension: info.extension,
    }
  }

  if (typeof input.totalBytes === 'number' && input.totalBytes > policy.maxBytes) {
    return {
      allowed: false,
      blockedReason: `exceeds_max_size:${input.totalBytes}>${policy.maxBytes}`,
      displayFilename: info.displayFilename,
      safeFilename: info.safeFilename,
      extension: info.extension,
    }
  }

  if (policy.mode === 'allow') {
    return {
      allowed: true,
      displayFilename: info.displayFilename,
      safeFilename: info.safeFilename,
      extension: info.extension,
    }
  }

  // 'quarantine' mode: block unsafe auto-downloads, quarantine safe files
  if (info.hadRtlSpoof) {
    return {
      allowed: false,
      blockedReason: 'unsafe_rtl_filename_spoof',
      displayFilename: info.displayFilename,
      safeFilename: info.safeFilename,
      extension: info.extension,
    }
  }

  const ext = info.extension
  const explicitlyAllowed = Boolean(ext && policy.allowedExtensions.has(ext))

  if (!explicitlyAllowed && ext && (UNSAFE_DOWNLOAD_EXTENSIONS.has(ext) || policy.extraBlockedExtensions.has(ext))) {
    return {
      allowed: false,
      blockedReason: `unsafe_extension:${ext}`,
      displayFilename: info.displayFilename,
      safeFilename: info.safeFilename,
      extension: ext,
    }
  }

  if (!explicitlyAllowed && mime && UNSAFE_DOWNLOAD_MIME_TYPES.has(mime)) {
    return {
      allowed: false,
      blockedReason: `unsafe_mime_type:${mime}`,
      displayFilename: info.displayFilename,
      safeFilename: info.safeFilename,
      extension: ext,
    }
  }

  return {
    allowed: true,
    displayFilename: info.displayFilename,
    safeFilename: info.safeFilename,
    extension: ext,
  }
}

function safeUnlink(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

function computeFileSha256(filePath: string): string | undefined {
  try {
    const data = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(data).digest('hex')
  } catch {
    return undefined
  }
}

export class DownloadQuarantineManager {
  private policy: ResolvedDownloadPolicy
  private entries: DownloadEntry[] = []
  private byId = new Map<string, DownloadEntry>()
  private listeners = new Set<(ev: DownloadEvent) => void>()

  constructor(opts?: DownloadPolicyOptions, defaultQuarantineDir?: string) {
    const fallbackDir =
      defaultQuarantineDir || path.join(os.tmpdir(), `troy-advanced-quarantine-${process.pid}`)
    this.policy = resolveDownloadPolicy(opts, fallbackDir)
    this.ensureQuarantineDir()
  }

  ensureQuarantineDir(): string {
    fs.mkdirSync(this.policy.quarantineDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(this.policy.quarantineDir, 0o700)
    } catch {
      // Ignore chmod errors on platforms/filesystems that do not support POSIX modes
    }
    return this.policy.quarantineDir
  }

  getQuarantineDir(): string {
    return this.policy.quarantineDir
  }

  getPolicy(): ResolvedDownloadPolicy {
    return {
      ...this.policy,
      extraBlockedExtensions: new Set(this.policy.extraBlockedExtensions),
      allowedExtensions: new Set(this.policy.allowedExtensions),
    }
  }

  setPolicy(opts: DownloadPolicyOptions): DownloadStats {
    this.policy = resolveDownloadPolicy(
      {
        mode: opts.mode ?? this.policy.mode,
        quarantineDir: opts.quarantineDir ?? this.policy.quarantineDir,
        maxBytes: opts.maxBytes ?? this.policy.maxBytes,
        extraBlockedExtensions: opts.extraBlockedExtensions ?? [...this.policy.extraBlockedExtensions],
        allowedExtensions: opts.allowedExtensions ?? [...this.policy.allowedExtensions],
      },
      this.policy.quarantineDir,
    )
    this.ensureQuarantineDir()
    return this.getStats()
  }

  onEvent(fn: (ev: DownloadEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(ev: DownloadEvent): void {
    for (const fn of this.listeners) {
      try {
        fn({ kind: ev.kind, entry: { ...ev.entry } })
      } catch {
        // ignore listener failure
      }
    }
  }

  private pushEntry(entry: DownloadEntry): void {
    this.entries.push(entry)
    this.byId.set(entry.id, entry)
    while (this.entries.length > MAX_DOWNLOAD_ENTRIES) {
      const oldest = this.entries.shift()
      if (oldest) this.byId.delete(oldest.id)
    }
  }

  private quarantineFilePathFor(id: string): string {
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_') || crypto.randomUUID()
    return path.join(this.policy.quarantineDir, safeId)
  }

  private cleanupQuarantineArtifacts(id: string): boolean {
    const base = this.quarantineFilePathFor(id)
    const a = safeUnlink(base)
    const b = safeUnlink(`${base}.crdownload`)
    return a || b
  }

  /**
   * Handle CDP `Browser.downloadWillBegin` event.
   * Returns `shouldCancel: true` when the download must be canceled immediately.
   */
  recordWillBegin(input: {
    id: string
    tabId?: number
    url: string
    suggestedFilename?: string
    mimeType?: string
    totalBytes?: number
  }): { entry: DownloadEntry; shouldCancel: boolean } {
    const existing = this.byId.get(input.id)
    if (existing) {
      return { entry: { ...existing }, shouldCancel: existing.blocked }
    }

    const decision = classifyDownload(
      {
        suggestedFilename: input.suggestedFilename,
        url: input.url,
        mimeType: input.mimeType,
        totalBytes: input.totalBytes,
      },
      this.policy,
    )

    const now = Date.now()
    const entry: DownloadEntry = {
      id: input.id,
      ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      url: input.url,
      suggestedFilename: decision.displayFilename,
      safeFilename: decision.safeFilename,
      extension: decision.extension,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      status: decision.allowed ? 'in_progress' : 'blocked',
      blocked: !decision.allowed,
      ...(decision.blockedReason ? { blockedReason: decision.blockedReason } : {}),
      bytesReceived: 0,
      ...(typeof input.totalBytes === 'number' && input.totalBytes >= 0 ? { totalBytes: input.totalBytes } : {}),
      startedAt: now,
      ...(decision.allowed ? {} : { completedAt: now }),
    }

    this.pushEntry(entry)

    if (!decision.allowed) {
      this.cleanupQuarantineArtifacts(entry.id)
      this.emit({ kind: 'download_blocked', entry })
      return { entry: { ...entry }, shouldCancel: true }
    }

    this.emit({ kind: 'download_started', entry })
    return { entry: { ...entry }, shouldCancel: false }
  }

  /**
   * Handle CDP `Browser.downloadProgress` event.
   */
  recordProgress(input: {
    id: string
    state: 'inProgress' | 'completed' | 'canceled' | string
    receivedBytes?: number
    totalBytes?: number
  }): { entry?: DownloadEntry; shouldCancel: boolean } {
    const entry = this.byId.get(input.id)
    if (!entry) return { shouldCancel: false }

    if (typeof input.receivedBytes === 'number' && input.receivedBytes >= 0) {
      entry.bytesReceived = input.receivedBytes
    }
    if (typeof input.totalBytes === 'number' && input.totalBytes >= 0) {
      entry.totalBytes = input.totalBytes
    }

    // If already blocked, ensure any partial/completed artifact is purged
    if (entry.blocked) {
      this.cleanupQuarantineArtifacts(entry.id)
      return { entry: { ...entry }, shouldCancel: input.state === 'inProgress' }
    }

    // Enforce maxBytes dynamically during download
    const observedSize = Math.max(entry.bytesReceived, entry.totalBytes ?? 0)
    if (observedSize > this.policy.maxBytes) {
      entry.blocked = true
      entry.status = 'blocked'
      entry.blockedReason = `exceeds_max_size:${observedSize}>${this.policy.maxBytes}`
      entry.completedAt = Date.now()
      this.cleanupQuarantineArtifacts(entry.id)
      this.emit({ kind: 'download_blocked', entry })
      return { entry: { ...entry }, shouldCancel: true }
    }

    if (input.state === 'completed') {
      const qPath = this.quarantineFilePathFor(entry.id)
      if (fs.existsSync(qPath)) {
        try {
          fs.chmodSync(qPath, 0o600)
        } catch {
          // ignore
        }
        try {
          const st = fs.statSync(qPath)
          if (st.size > this.policy.maxBytes) {
            safeUnlink(qPath)
            entry.blocked = true
            entry.status = 'blocked'
            entry.blockedReason = `exceeds_max_size:${st.size}>${this.policy.maxBytes}`
            entry.completedAt = Date.now()
            this.emit({ kind: 'download_blocked', entry })
            return { entry: { ...entry }, shouldCancel: false }
          }
          entry.bytesReceived = st.size
          if (entry.totalBytes === undefined || entry.totalBytes < st.size) {
            entry.totalBytes = st.size
          }
        } catch {
          // ignore
        }
        entry.quarantinePath = qPath
        entry.sha256 = computeFileSha256(qPath)
      }
      entry.status = 'quarantined'
      entry.completedAt = Date.now()
      this.emit({ kind: 'download_quarantined', entry })
      return { entry: { ...entry }, shouldCancel: false }
    }

    if (input.state === 'canceled') {
      this.cleanupQuarantineArtifacts(entry.id)
      entry.status = 'canceled'
      entry.completedAt = Date.now()
      this.emit({ kind: 'download_canceled', entry })
      return { entry: { ...entry }, shouldCancel: false }
    }

    return { entry: { ...entry }, shouldCancel: false }
  }

  /**
   * Direct buffer interception for Lite engine (and unit tests).
   * Blocked downloads are never written to disk; allowed downloads are written to
   * `<quarantineDir>/<id>` with `0o600` non-executable permissions.
   */
  recordDirectBuffer(input: {
    id?: string
    tabId?: number
    url: string
    suggestedFilename?: string
    mimeType?: string
    data: Buffer
  }): DownloadEntry {
    const id = input.id || crypto.randomUUID()
    const totalBytes = input.data.length
    const decision = classifyDownload(
      {
        suggestedFilename: input.suggestedFilename,
        url: input.url,
        mimeType: input.mimeType,
        totalBytes,
      },
      this.policy,
    )

    const now = Date.now()
    const entry: DownloadEntry = {
      id,
      ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      url: input.url,
      suggestedFilename: decision.displayFilename,
      safeFilename: decision.safeFilename,
      extension: decision.extension,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      status: decision.allowed ? 'quarantined' : 'blocked',
      blocked: !decision.allowed,
      ...(decision.blockedReason ? { blockedReason: decision.blockedReason } : {}),
      bytesReceived: decision.allowed ? totalBytes : 0,
      totalBytes,
      startedAt: now,
      completedAt: now,
    }

    if (decision.allowed) {
      this.ensureQuarantineDir()
      const qPath = this.quarantineFilePathFor(id)
      fs.writeFileSync(qPath, input.data, { mode: 0o600 })
      try {
        fs.chmodSync(qPath, 0o600)
      } catch {
        // ignore
      }
      entry.quarantinePath = qPath
      entry.sha256 = crypto.createHash('sha256').update(input.data).digest('hex')
    }

    this.pushEntry(entry)
    this.emit({
      kind: decision.allowed ? 'download_quarantined' : 'download_blocked',
      entry,
    })
    return { ...entry }
  }

  list(opts?: { status?: DownloadStatus; blockedOnly?: boolean; limit?: number }): DownloadEntry[] {
    let items = this.entries.map((e) => ({ ...e }))
    if (opts?.blockedOnly) {
      items = items.filter((e) => e.blocked)
    }
    if (opts?.status) {
      items = items.filter((e) => e.status === opts.status)
    }
    const limit = opts?.limit ?? 100
    if (limit > 0 && items.length > limit) {
      items = items.slice(-limit)
    }
    return items
  }

  get(id: string): DownloadEntry | undefined {
    const found = this.byId.get(id)
    return found ? { ...found } : undefined
  }

  getStats(): DownloadStats {
    let quarantined = 0
    let blocked = 0
    let inProgress = 0
    let failed = 0
    for (const e of this.entries) {
      if (e.status === 'quarantined') quarantined++
      else if (e.status === 'blocked') blocked++
      else if (e.status === 'in_progress') inProgress++
      else failed++
    }
    return {
      mode: this.policy.mode,
      quarantineDir: this.policy.quarantineDir,
      maxBytes: this.policy.maxBytes,
      total: this.entries.length,
      quarantined,
      blocked,
      inProgress,
      failed,
    }
  }

  remove(id: string): { ok: boolean; removedFile: boolean; error?: string } {
    const entry = this.byId.get(id)
    if (!entry) {
      return { ok: false, removedFile: false, error: `download not found: ${id}` }
    }
    const removedFile =
      (entry.quarantinePath ? safeUnlink(entry.quarantinePath) : false) ||
      this.cleanupQuarantineArtifacts(entry.id)
    this.byId.delete(id)
    this.entries = this.entries.filter((e) => e.id !== id)
    return { ok: true, removedFile }
  }

  clear(opts?: { deleteFiles?: boolean }): { cleared: number; removedFiles: number } {
    const deleteFiles = opts?.deleteFiles !== false
    let removedFiles = 0
    if (deleteFiles) {
      for (const e of this.entries) {
        if ((e.quarantinePath && safeUnlink(e.quarantinePath)) || this.cleanupQuarantineArtifacts(e.id)) {
          removedFiles++
        }
      }
    }
    const cleared = this.entries.length
    this.entries = []
    this.byId.clear()
    return { cleared, removedFiles }
  }
}

export function formatBytesCompact(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function formatDownloadsAscii(entries: DownloadEntry[], stats: DownloadStats): string {
  const lines: string[] = [
    `=== Downloads (mode=${stats.mode} | total=${stats.total} | quarantined=${stats.quarantined} | blocked=${stats.blocked}) ===`,
    `Quarantine Dir: ${sanitizeAscii(stats.quarantineDir)}`,
    `Max Size:       ${formatBytesCompact(stats.maxBytes)}`,
  ]
  if (entries.length === 0) {
    lines.push('(no downloads recorded)')
    return lines.join('\n')
  }
  lines.push('')
  for (const e of entries) {
    const tag =
      e.status === 'blocked'
        ? '[BLOCKED]'
        : e.status === 'quarantined'
          ? '[QUARANTINED]'
          : e.status === 'in_progress'
            ? '[IN_PROGRESS]'
            : `[${e.status.toUpperCase()}]`
    const size = formatBytesCompact(e.bytesReceived || e.totalBytes)
    const detail = e.blocked
      ? `reason=${e.blockedReason ?? 'blocked'}`
      : e.quarantinePath
        ? `path=${e.quarantinePath}`
        : ''
    lines.push(
      sanitizeAscii(
        `${tag.padEnd(13)} ${e.suggestedFilename} (${size}) id=${e.id.slice(0, 12)} ${detail}`.trim(),
      ),
    )
    lines.push(sanitizeAscii(`              url=${e.url}`))
  }
  return lines.join('\n')
}
