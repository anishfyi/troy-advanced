// Multi-profile management: list, create, delete, export, and import isolated browser profiles.
// Profiles store cookies, page memory, policy.json, daemon.json, audit logs, and chrome-data
// in owner-only (0700) directories. Export/import uses a portable, zero-dependency,
// integrity-checked (SHA-256) bundle with optional gzip compression and AES-256-GCM encryption.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type {
  EncryptedProfileBundle,
  EngineKind,
  PolicyProfileName,
  ProfileExportBundle,
  ProfileExportFileEntry,
  ProfileMetadata,
  ProfileSummary,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { readLiveEndpoint } from '../bridge/endpoint.js'

export const PROFILE_METADATA_FILENAME = 'profile.json'
export const PROFILE_BUNDLE_FORMAT = 'troy-advanced-profile-bundle'
export const ENCRYPTED_PROFILE_BUNDLE_FORMAT = 'troy-advanced-profile-bundle-encrypted'

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const PROFILE_ENCRYPTION_AAD = Buffer.from('troy-advanced:profile:v1', 'utf8')
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32 }

// Safety limits on import to guard against malformed or zip-bomb bundles
const MAX_IMPORT_FILES = 10_000
const MAX_IMPORT_TOTAL_BYTES = 512 * 1024 * 1024 // 512 MiB

// Runtime / lock files that should never be cloned or exported
const VOLATILE_BASENAMES = new Set([
  'agent-endpoint.json',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
  'LOCK',
])

// Chrome cache directory segments skipped during export unless includeCache: true
const CHROME_CACHE_SEGMENTS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'Crashpad',
  'BrowserMetrics',
  'OptimizationGuidePredictionModels',
  'component_crx_cache',
])

export interface ProfileManagerOptions {
  /** Explicit root directory for named profiles. Defaults to TROY_PROFILES_DIR or ~/.config/troy-advanced/profiles. */
  profilesDir?: string
  /** Include the legacy/built-in default profile (~/.config/troy-advanced/profile) when listing without explicit profilesDir. */
  includeDefault?: boolean
}

export interface ProfileNameValidation {
  ok: boolean
  error?: string
}

export interface CreateProfileOptions extends ProfileManagerOptions {
  description?: string
  engine?: EngineKind
  policy?: PolicyProfileName
  tags?: string[]
  /** Clone files from an existing profile name. */
  from?: string
}

export interface CreateProfileResult {
  ok: boolean
  profile?: ProfileSummary
  clonedFrom?: string
  copiedFiles?: number
  error?: string
}

export interface DeleteProfileOptions extends ProfileManagerOptions {
  /** Allow deleting the built-in default profile or a profile with a running daemon. */
  force?: boolean
}

export interface DeleteProfileResult {
  ok: boolean
  name: string
  dir?: string
  removedFiles?: number
  freedBytes?: number
  error?: string
}

export interface ExportProfileOptions extends ProfileManagerOptions {
  /** Destination file path. If omitted, bundle is returned in result.data without writing to disk. */
  outFile?: string
  /** Encrypt the bundle using AES-256-GCM + scrypt. */
  encrypt?: boolean
  /** Passphrase for AES-256-GCM encryption (implies encrypt: true). */
  passphrase?: string
  /** Gzip-compress plain JSON output (auto-enabled when outFile ends with .gz). */
  gzip?: boolean
  /** Include Chrome cache directories (default: false). */
  includeCache?: boolean
  /** Exclude chrome-data/ directory for lightweight config+cookies+memory exports (default: false). */
  excludeChromeData?: boolean
  /** Exclude audit.jsonl from export (default: false). */
  excludeAudit?: boolean
}

export interface ExportProfileResult {
  ok: boolean
  name: string
  outFile?: string
  encrypted: boolean
  compressed: boolean
  totalFiles: number
  totalBytes: number
  outputBytes: number
  manifestSha256?: string
  bundle?: ProfileExportBundle
  data?: Buffer
  error?: string
}

export interface ImportProfileOptions extends ProfileManagerOptions {
  /** Override the target profile name (defaults to bundle.profileName). */
  name?: string
  /** Passphrase to decrypt an encrypted profile bundle. */
  passphrase?: string
  /** Overwrite an existing profile with the same name. */
  overwrite?: boolean
  /** Allow overwriting even if a daemon appears to be running for the target profile. */
  force?: boolean
}

export interface ImportProfileResult {
  ok: boolean
  profile?: ProfileSummary
  importedFiles?: number
  importedBytes?: number
  encrypted?: boolean
  overwritten?: boolean
  manifestSha256?: string
  error?: string
}

export function defaultConfigRoot(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'troy-advanced')
}

export function defaultProfileDir(): string {
  return path.join(defaultConfigRoot(), 'profile')
}

export function resolveProfilesRoot(opts: ProfileManagerOptions = {}): string {
  if (opts.profilesDir && opts.profilesDir.trim()) {
    return path.resolve(opts.profilesDir.trim())
  }
  if (process.env.TROY_PROFILES_DIR && process.env.TROY_PROFILES_DIR.trim()) {
    return path.resolve(process.env.TROY_PROFILES_DIR.trim())
  }
  return path.join(defaultConfigRoot(), 'profiles')
}

export function validateProfileName(name: string): ProfileNameValidation {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Profile name must be a non-empty string' }
  }
  if (name !== name.trim()) {
    return { ok: false, error: 'Profile name must not have leading or trailing whitespace' }
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
    return { ok: false, error: `Invalid profile name "${name}": path separators and ".." are not allowed` }
  }
  if (!PROFILE_NAME_RE.test(name)) {
    return {
      ok: false,
      error: `Invalid profile name "${name}": must start with alphanumeric and contain only [a-zA-Z0-9._-] (max 64 chars)`,
    }
  }
  return { ok: true }
}

export function isValidProfileName(name: string): boolean {
  return validateProfileName(name).ok
}

function usesDefaultLegacyRoot(opts: ProfileManagerOptions = {}): boolean {
  return !(opts.profilesDir && opts.profilesDir.trim()) && !(process.env.TROY_PROFILES_DIR && process.env.TROY_PROFILES_DIR.trim())
}

/**
 * Resolve a validated profile name to its absolute directory path.
 * Throws if the name is invalid or would escape the profiles root.
 */
export function resolveProfileDir(name: string, opts: ProfileManagerOptions = {}): string {
  const check = validateProfileName(name)
  if (!check.ok) {
    throw new Error(check.error)
  }
  if (name === 'default' && usesDefaultLegacyRoot(opts)) {
    return defaultProfileDir()
  }
  const root = resolveProfilesRoot(opts)
  const resolved = path.resolve(root, name)
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Resolved profile path escapes profiles root: ${name}`)
  }
  return resolved
}

/**
 * Resolve a CLI `--profile <name|path>` value.
 * - Paths (containing `/`, `\`, starting with `.` or `~`, or absolute) resolve as filesystem paths.
 * - Bare valid profile names (e.g. `work`, `default`, `ec2-prod`) resolve to the managed profile directory.
 */
export function resolveProfileFlag(raw: string, opts: ProfileManagerOptions = {}): string {
  const trimmed = raw.trim()
  if (!trimmed) return defaultProfileDir()
  if (trimmed.startsWith('~/') || trimmed === '~') {
    return path.resolve(path.join(os.homedir(), trimmed.slice(1)))
  }
  const looksLikePath =
    path.isAbsolute(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.')
  if (looksLikePath) {
    return path.resolve(trimmed)
  }
  if (isValidProfileName(trimmed)) {
    return resolveProfileDir(trimmed, opts)
  }
  return path.resolve(trimmed)
}

function isVolatileFile(relPosixPath: string): boolean {
  const base = path.posix.basename(relPosixPath)
  if (VOLATILE_BASENAMES.has(base)) return true
  if (base.endsWith('.lock') || base.startsWith('daemon.log')) return true
  return false
}

function isChromeCachePath(relPosixPath: string): boolean {
  const segments = relPosixPath.split('/')
  if (segments[0] !== 'chrome-data') return false
  for (let i = 1; i < segments.length; i++) {
    if (CHROME_CACHE_SEGMENTS.has(segments[i]!)) return true
  }
  return false
}

function computeDirStats(dir: string): { fileCount: number; sizeBytes: number } {
  let fileCount = 0
  let sizeBytes = 0
  if (!fs.existsSync(dir)) return { fileCount, sizeBytes }

  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        fileCount += 1
        try {
          sizeBytes += fs.statSync(full).size
        } catch {
          // ignore race
        }
      }
    }
  }
  return { fileCount, sizeBytes }
}

function readProfileMetadata(dir: string): ProfileMetadata | undefined {
  const metaPath = path.join(dir, PROFILE_METADATA_FILENAME)
  if (!fs.existsSync(metaPath)) return undefined
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<ProfileMetadata>
    if (!raw || typeof raw !== 'object') return undefined
    if (typeof raw.name !== 'string') return undefined
    return {
      version: 1,
      name: raw.name,
      ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
      ...(raw.engine === 'auto' || raw.engine === 'chromium' || raw.engine === 'lite' ? { engine: raw.engine } : {}),
      ...(raw.policy === 'strict' || raw.policy === 'standard' || raw.policy === 'permissive'
        ? { policy: raw.policy }
        : {}),
      ...(Array.isArray(raw.tags) ? { tags: raw.tags.filter((t): t is string => typeof t === 'string') } : {}),
    }
  } catch {
    return undefined
  }
}

function writeProfileMetadata(dir: string, meta: ProfileMetadata): void {
  const metaPath = path.join(dir, PROFILE_METADATA_FILENAME)
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(metaPath, 0o600)
  } catch {
    // ignore on platforms without POSIX chmod
  }
}

function isProfileDaemonRunning(dir: string): boolean {
  const epPath = path.join(dir, 'agent-endpoint.json')
  if (!fs.existsSync(epPath)) return false
  return readLiveEndpoint(epPath) !== null
}

export function inspectProfile(name: string, dir: string, isDefault = false): ProfileSummary {
  const meta = readProfileMetadata(dir)
  const { fileCount, sizeBytes } = computeDirStats(dir)
  let fallbackMtime: string | undefined
  try {
    fallbackMtime = fs.statSync(dir).mtime.toISOString()
  } catch {
    fallbackMtime = undefined
  }

  return {
    name,
    dir,
    isDefault,
    ...(meta?.description ? { description: meta.description } : {}),
    createdAt: meta?.createdAt ?? fallbackMtime,
    updatedAt: meta?.updatedAt ?? fallbackMtime,
    ...(meta?.engine ? { engine: meta.engine } : {}),
    ...(meta?.policy ? { policy: meta.policy } : {}),
    ...(meta?.tags && meta.tags.length > 0 ? { tags: meta.tags } : {}),
    fileCount,
    sizeBytes,
    hasCookies: fs.existsSync(path.join(dir, 'cookies.json')),
    hasMemory: fs.existsSync(path.join(dir, 'memory.json')),
    hasPolicy: fs.existsSync(path.join(dir, 'policy.json')),
    hasDaemonConfig: fs.existsSync(path.join(dir, 'daemon.json')),
    hasChromeData: fs.existsSync(path.join(dir, 'chrome-data')),
    hasAuditLog: fs.existsSync(path.join(dir, 'audit.jsonl')),
    daemonRunning: isProfileDaemonRunning(dir),
  }
}

export function listProfiles(opts: ProfileManagerOptions = {}): ProfileSummary[] {
  const profiles: ProfileSummary[] = []
  const seen = new Set<string>()

  const includeDefault = opts.includeDefault ?? usesDefaultLegacyRoot(opts)
  if (includeDefault) {
    const defDir = defaultProfileDir()
    if (fs.existsSync(defDir) && fs.statSync(defDir).isDirectory()) {
      profiles.push(inspectProfile('default', defDir, true))
      seen.add('default')
    }
  }

  const root = resolveProfilesRoot(opts)
  if (fs.existsSync(root)) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!isValidProfileName(entry.name)) continue
      if (seen.has(entry.name)) continue
      const dir = path.join(root, entry.name)
      profiles.push(inspectProfile(entry.name, dir, entry.name === 'default'))
      seen.add(entry.name)
    }
  }

  profiles.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return profiles
}

export function getProfile(name: string, opts: ProfileManagerOptions = {}): ProfileSummary | null {
  const check = validateProfileName(name)
  if (!check.ok) return null
  const dir = resolveProfileDir(name, opts)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null
  return inspectProfile(name, dir, name === 'default')
}

function collectProfileFiles(
  dir: string,
  opts: { includeCache?: boolean; excludeChromeData?: boolean; excludeAudit?: boolean } = {},
): Array<{ relPosix: string; absPath: string; mode: number }> {
  const results: Array<{ relPosix: string; absPath: string; mode: number }> = []
  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const absPath = path.join(currentDir, entry.name)

      if (opts.excludeChromeData && (relPosix === 'chrome-data' || relPosix.startsWith('chrome-data/'))) {
        continue
      }
      if (!opts.includeCache && isChromeCachePath(relPosix)) {
        continue
      }
      if (opts.excludeAudit && (relPosix === 'audit.jsonl' || relPosix.startsWith('audit.jsonl.'))) {
        continue
      }

      if (entry.isDirectory()) {
        walk(absPath, relPosix)
      } else if (entry.isFile()) {
        if (isVolatileFile(relPosix)) continue
        let mode = 0o600
        try {
          mode = fs.statSync(absPath).mode & 0o777
        } catch {
          mode = 0o600
        }
        results.push({ relPosix, absPath, mode })
      }
    }
  }
  walk(dir, '')
  return results
}

export function createProfile(name: string, opts: CreateProfileOptions = {}): CreateProfileResult {
  const check = validateProfileName(name)
  if (!check.ok) {
    return { ok: false, error: check.error }
  }

  const targetDir = resolveProfileDir(name, opts)
  if (fs.existsSync(targetDir)) {
    return { ok: false, error: `Profile "${name}" already exists at ${targetDir}` }
  }

  let sourceDir: string | undefined
  if (opts.from) {
    const srcCheck = validateProfileName(opts.from)
    if (!srcCheck.ok) {
      return { ok: false, error: `Invalid --from profile name: ${srcCheck.error}` }
    }
    const candidate = resolveProfileDir(opts.from, opts)
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      return { ok: false, error: `Source profile "${opts.from}" does not exist` }
    }
    sourceDir = candidate
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(targetDir, 0o700)
  } catch {
    // ignore
  }

  let copiedFiles = 0
  if (sourceDir) {
    const files = collectProfileFiles(sourceDir, { includeCache: false })
    for (const file of files) {
      if (file.relPosix === PROFILE_METADATA_FILENAME) continue
      const destPath = path.join(targetDir, ...file.relPosix.split('/'))
      fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 })
      fs.copyFileSync(file.absPath, destPath)
      try {
        fs.chmodSync(destPath, file.mode & 0o600 ? file.mode : 0o600)
      } catch {
        // ignore
      }
      copiedFiles += 1
    }
  }

  const now = new Date().toISOString()
  const sourceMeta = sourceDir ? readProfileMetadata(sourceDir) : undefined
  const tags = opts.tags
    ? Array.from(new Set(opts.tags.map((t) => t.trim()).filter(Boolean)))
    : sourceMeta?.tags

  const meta: ProfileMetadata = {
    version: 1,
    name,
    ...(opts.description?.trim()
      ? { description: opts.description.trim() }
      : sourceMeta?.description
        ? { description: sourceMeta.description }
        : {}),
    createdAt: now,
    updatedAt: now,
    ...(opts.engine ? { engine: opts.engine } : sourceMeta?.engine ? { engine: sourceMeta.engine } : {}),
    ...(opts.policy ? { policy: opts.policy } : sourceMeta?.policy ? { policy: sourceMeta.policy } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
  }
  writeProfileMetadata(targetDir, meta)

  const summary = inspectProfile(name, targetDir, name === 'default')
  return {
    ok: true,
    profile: summary,
    ...(opts.from ? { clonedFrom: opts.from, copiedFiles } : {}),
  }
}

export function deleteProfile(name: string, opts: DeleteProfileOptions = {}): DeleteProfileResult {
  const check = validateProfileName(name)
  if (!check.ok) {
    return { ok: false, name, error: check.error }
  }

  if (name === 'default' && !opts.force) {
    return {
      ok: false,
      name,
      error: 'Refusing to delete the "default" profile without --force',
    }
  }

  const targetDir = resolveProfileDir(name, opts)
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return { ok: false, name, error: `Profile "${name}" does not exist` }
  }

  if (isProfileDaemonRunning(targetDir) && !opts.force) {
    return {
      ok: false,
      name,
      dir: targetDir,
      error: `Profile "${name}" has a running daemon; stop it first or pass --force`,
    }
  }

  const { fileCount, sizeBytes } = computeDirStats(targetDir)
  fs.rmSync(targetDir, { recursive: true, force: true })

  return {
    ok: true,
    name,
    dir: targetDir,
    removedFiles: fileCount,
    freedBytes: sizeBytes,
  }
}

function computeManifestSha256(files: ProfileExportFileEntry[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const hash = crypto.createHash('sha256')
  for (const entry of sorted) {
    hash.update(`${entry.path}\0${entry.sha256}\n`)
  }
  return hash.digest('hex')
}

function encryptProfileBundle(bundle: ProfileExportBundle, passphrase: string): EncryptedProfileBundle {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  })
  const plaintext = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'))
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(PROFILE_ENCRYPTION_AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    format: ENCRYPTED_PROFILE_BUNDLE_FORMAT,
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { ...SCRYPT_PARAMS },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function decryptProfileBundle(encrypted: EncryptedProfileBundle, passphrase: string): ProfileExportBundle {
  if (encrypted.algorithm !== 'aes-256-gcm' || encrypted.kdf !== 'scrypt') {
    throw new Error(`Unsupported profile encryption parameters: ${encrypted.algorithm}/${encrypted.kdf}`)
  }
  const salt = Buffer.from(encrypted.salt, 'base64')
  const iv = Buffer.from(encrypted.iv, 'base64')
  const tag = Buffer.from(encrypted.tag, 'base64')
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64')
  const kdf = encrypted.kdfParams || SCRYPT_PARAMS
  const key = crypto.scryptSync(passphrase, salt, kdf.keyLen || 32, {
    N: kdf.N || SCRYPT_PARAMS.N,
    r: kdf.r || SCRYPT_PARAMS.r,
    p: kdf.p || SCRYPT_PARAMS.p,
  })
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(PROFILE_ENCRYPTION_AAD)
  decipher.setAuthTag(tag)
  let compressed: Buffer
  try {
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('Failed to decrypt profile bundle: invalid passphrase or tampered data')
  }
  const jsonText = zlib.gunzipSync(compressed).toString('utf8')
  return JSON.parse(jsonText) as ProfileExportBundle
}

export function exportProfile(name: string, opts: ExportProfileOptions = {}): ExportProfileResult {
  const check = validateProfileName(name)
  if (!check.ok) {
    return {
      ok: false,
      name,
      encrypted: false,
      compressed: false,
      totalFiles: 0,
      totalBytes: 0,
      outputBytes: 0,
      error: check.error,
    }
  }

  const passphrase = opts.passphrase?.trim() ? opts.passphrase : undefined
  const encrypt = Boolean(opts.encrypt || passphrase)
  if (encrypt && !passphrase) {
    return {
      ok: false,
      name,
      encrypted: true,
      compressed: false,
      totalFiles: 0,
      totalBytes: 0,
      outputBytes: 0,
      error: 'Encryption requires a non-empty passphrase',
    }
  }

  const sourceDir = resolveProfileDir(name, opts)
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return {
      ok: false,
      name,
      encrypted: encrypt,
      compressed: false,
      totalFiles: 0,
      totalBytes: 0,
      outputBytes: 0,
      error: `Profile "${name}" does not exist`,
    }
  }

  const collected = collectProfileFiles(sourceDir, {
    includeCache: opts.includeCache,
    excludeChromeData: opts.excludeChromeData,
    excludeAudit: opts.excludeAudit,
  })

  const entries: ProfileExportFileEntry[] = []
  let totalBytes = 0
  for (const file of collected) {
    const content = fs.readFileSync(file.absPath)
    const sha256 = crypto.createHash('sha256').update(content).digest('hex')
    totalBytes += content.length
    entries.push({
      path: file.relPosix,
      mode: file.mode,
      contentBase64: content.toString('base64'),
      sizeBytes: content.length,
      sha256,
    })
  }

  const manifestSha256 = computeManifestSha256(entries)
  const metadata = readProfileMetadata(sourceDir)
  const bundle: ProfileExportBundle = {
    format: PROFILE_BUNDLE_FORMAT,
    version: 1,
    profileName: name,
    exportedAt: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
    files: entries,
    totalFiles: entries.length,
    totalBytes,
    manifestSha256,
  }

  const shouldGzip = Boolean(
    opts.gzip ?? (opts.outFile && opts.outFile !== '-' && opts.outFile.toLowerCase().endsWith('.gz')),
  )

  let outputBuf: Buffer
  if (encrypt && passphrase) {
    const encryptedPayload = encryptProfileBundle(bundle, passphrase)
    const serialized = Buffer.from(JSON.stringify(encryptedPayload, null, 2) + '\n', 'utf8')
    outputBuf = shouldGzip ? zlib.gzipSync(serialized) : serialized
  } else {
    const serialized = Buffer.from(JSON.stringify(bundle, null, 2) + '\n', 'utf8')
    outputBuf = shouldGzip ? zlib.gzipSync(serialized) : serialized
  }

  let resolvedOutFile: string | undefined
  if (opts.outFile && opts.outFile !== '-') {
    resolvedOutFile = path.resolve(opts.outFile)
    fs.mkdirSync(path.dirname(resolvedOutFile), { recursive: true })
    fs.writeFileSync(resolvedOutFile, outputBuf, { mode: 0o600 })
    try {
      fs.chmodSync(resolvedOutFile, 0o600)
    } catch {
      // ignore
    }
  }

  return {
    ok: true,
    name,
    ...(resolvedOutFile ? { outFile: resolvedOutFile } : {}),
    encrypted: encrypt,
    compressed: shouldGzip || encrypt,
    totalFiles: entries.length,
    totalBytes,
    outputBytes: outputBuf.length,
    manifestSha256,
    bundle,
    data: outputBuf,
  }
}

function validateSafeRelativeBundlePath(relPath: string): string | null {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return 'Empty file path in bundle'
  }
  if (relPath.includes('\0') || relPath.includes('\\')) {
    return `Unsafe file path in bundle: "${relPath}"`
  }
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) {
    return `Absolute file path not allowed in bundle: "${relPath}"`
  }
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return `Invalid path segment in bundle entry: "${relPath}"`
    }
  }
  return null
}

function isGzipBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
}

export function importProfile(
  source: string | Buffer,
  opts: ImportProfileOptions = {},
): ImportProfileResult {
  let rawBuf: Buffer
  if (Buffer.isBuffer(source)) {
    rawBuf = source
  } else {
    const trimmed = source.trim()
    if (trimmed.startsWith('{')) {
      rawBuf = Buffer.from(source, 'utf8')
    } else {
      const resolvedPath = path.resolve(source)
      if (!fs.existsSync(resolvedPath)) {
        return { ok: false, error: `Import file not found: ${resolvedPath}` }
      }
      rawBuf = fs.readFileSync(resolvedPath)
    }
  }

  let jsonText: string
  try {
    const uncompressed = isGzipBuffer(rawBuf) ? zlib.gunzipSync(rawBuf) : rawBuf
    jsonText = uncompressed.toString('utf8')
  } catch (err) {
    return { ok: false, error: `Failed to decompress profile bundle: ${(err as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    return { ok: false, error: `Invalid JSON in profile bundle: ${(err as Error).message}` }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Profile bundle must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>
  let bundle: ProfileExportBundle
  let wasEncrypted = false

  if (obj.format === ENCRYPTED_PROFILE_BUNDLE_FORMAT) {
    wasEncrypted = true
    const passphrase = opts.passphrase?.trim() ? opts.passphrase : undefined
    if (!passphrase) {
      return { ok: false, error: 'Passphrase required to decrypt encrypted profile bundle (--passphrase)' }
    }
    try {
      bundle = decryptProfileBundle(obj as unknown as EncryptedProfileBundle, passphrase)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  } else if (obj.format === PROFILE_BUNDLE_FORMAT) {
    bundle = obj as unknown as ProfileExportBundle
  } else {
    return { ok: false, error: `Unrecognized profile bundle format: ${String(obj.format ?? 'missing')}` }
  }

  if (bundle.format !== PROFILE_BUNDLE_FORMAT || bundle.version !== 1 || !Array.isArray(bundle.files)) {
    return { ok: false, error: 'Invalid or unsupported profile bundle structure/version' }
  }

  if (bundle.files.length > MAX_IMPORT_FILES) {
    return { ok: false, error: `Profile bundle exceeds maximum file limit (${MAX_IMPORT_FILES})` }
  }

  const targetName = opts.name?.trim() || bundle.profileName
  const nameCheck = validateProfileName(targetName)
  if (!nameCheck.ok) {
    return { ok: false, error: nameCheck.error }
  }

  // Validate all entries and verify integrity before touching disk
  const decodedEntries: Array<{ relPath: string; content: Buffer; mode: number }> = []
  let totalDecodedBytes = 0
  const seenPaths = new Set<string>()

  for (const entry of bundle.files) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Malformed file entry in profile bundle' }
    }
    const pathErr = validateSafeRelativeBundlePath(entry.path)
    if (pathErr) {
      return { ok: false, error: pathErr }
    }
    if (seenPaths.has(entry.path)) {
      return { ok: false, error: `Duplicate file path in profile bundle: "${entry.path}"` }
    }
    seenPaths.add(entry.path)

    if (typeof entry.contentBase64 !== 'string') {
      return { ok: false, error: `Missing contentBase64 for "${entry.path}"` }
    }
    const content = Buffer.from(entry.contentBase64, 'base64')
    totalDecodedBytes += content.length
    if (totalDecodedBytes > MAX_IMPORT_TOTAL_BYTES) {
      return { ok: false, error: `Profile bundle exceeds maximum size limit (${MAX_IMPORT_TOTAL_BYTES} bytes)` }
    }

    const actualSha = crypto.createHash('sha256').update(content).digest('hex')
    if (entry.sha256 && actualSha !== entry.sha256) {
      return {
        ok: false,
        error: `SHA-256 integrity mismatch for "${entry.path}": expected ${entry.sha256}, got ${actualSha}`,
      }
    }

    decodedEntries.push({
      relPath: entry.path,
      content,
      mode: typeof entry.mode === 'number' ? entry.mode & 0o777 : 0o600,
    })
  }

  if (bundle.manifestSha256) {
    const expectedManifest = computeManifestSha256(bundle.files)
    if (expectedManifest !== bundle.manifestSha256) {
      return {
        ok: false,
        error: `Bundle manifest SHA-256 mismatch: expected ${bundle.manifestSha256}, got ${expectedManifest}`,
      }
    }
  }

  const targetDir = resolveProfileDir(targetName, opts)
  const existed = fs.existsSync(targetDir)
  if (existed) {
    if (!opts.overwrite) {
      return {
        ok: false,
        error: `Profile "${targetName}" already exists; pass --overwrite (or --force) to replace it`,
      }
    }
    if (isProfileDaemonRunning(targetDir) && !opts.force) {
      return {
        ok: false,
        error: `Profile "${targetName}" has a running daemon; stop it first or pass --force`,
      }
    }
    fs.rmSync(targetDir, { recursive: true, force: true })
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(targetDir, 0o700)
  } catch {
    // ignore
  }

  for (const item of decodedEntries) {
    const destPath = path.resolve(targetDir, ...item.relPath.split('/'))
    if (!destPath.startsWith(targetDir + path.sep)) {
      return { ok: false, error: `Resolved destination escapes profile directory: "${item.relPath}"` }
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 })
    const safeMode = item.mode & 0o700 ? item.mode & 0o777 : 0o600
    fs.writeFileSync(destPath, item.content, { mode: safeMode })
    try {
      fs.chmodSync(destPath, safeMode)
    } catch {
      // ignore
    }
  }

  // Ensure profile.json reflects the imported target name & timestamp
  const existingMeta = readProfileMetadata(targetDir) ?? bundle.metadata
  const now = new Date().toISOString()
  writeProfileMetadata(targetDir, {
    version: 1,
    name: targetName,
    ...(existingMeta?.description ? { description: existingMeta.description } : {}),
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now,
    ...(existingMeta?.engine ? { engine: existingMeta.engine } : {}),
    ...(existingMeta?.policy ? { policy: existingMeta.policy } : {}),
    ...(existingMeta?.tags && existingMeta.tags.length > 0 ? { tags: existingMeta.tags } : {}),
  })

  const summary = inspectProfile(targetName, targetDir, targetName === 'default')
  return {
    ok: true,
    profile: summary,
    importedFiles: decodedEntries.length,
    importedBytes: totalDecodedBytes,
    encrypted: wasEncrypted,
    overwritten: existed,
    manifestSha256: bundle.manifestSha256,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

function profileFeaturesList(p: ProfileSummary): string {
  const feats: string[] = []
  if (p.hasCookies) feats.push('cookies')
  if (p.hasMemory) feats.push('memory')
  if (p.hasPolicy) feats.push('policy')
  if (p.hasDaemonConfig) feats.push('daemon-cfg')
  if (p.hasChromeData) feats.push('chrome')
  if (p.hasAuditLog) feats.push('audit')
  return feats.length > 0 ? feats.join(',') : '-'
}

export function formatProfilesAscii(profiles: ProfileSummary[], opts: { width?: number } = {}): string {
  const width = Math.max(60, opts.width ?? 100)
  const lines: string[] = []
  const rule = '='.repeat(Math.min(width, 96))
  lines.push(rule)
  lines.push(`TROY-ADVANCED PROFILES (${profiles.length})`)
  lines.push(rule)

  if (profiles.length === 0) {
    lines.push('(no profiles found -- create one with: troy-advanced profile create <name>)')
    lines.push(rule)
    return sanitizeAscii(lines.join('\n'))
  }

  const headers = ['NAME', 'FILES', 'SIZE', 'DAEMON', 'FEATURES', 'POLICY']
  const rows = profiles.map((p) => [
    p.isDefault ? `${p.name} (default)` : p.name,
    String(p.fileCount),
    formatBytes(p.sizeBytes),
    p.daemonRunning ? 'running' : 'stopped',
    profileFeaturesList(p),
    p.policy ?? '-',
  ])

  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...rows.map((r) => (r[idx] ?? '').length)),
  )
  const pad = (val: string, len: number) => val + ' '.repeat(Math.max(0, len - val.length))
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+'

  lines.push(sep)
  lines.push('| ' + headers.map((h, i) => pad(h, widths[i]!)).join(' | ') + ' |')
  lines.push(sep)
  for (const row of rows) {
    lines.push('| ' + row.map((c, i) => pad(c, widths[i]!)).join(' | ') + ' |')
  }
  lines.push(sep)

  for (const p of profiles) {
    if (p.description) {
      lines.push(`  ${p.name}: ${p.description}`)
    }
  }

  return sanitizeAscii(lines.join('\n'))
}

export function formatProfileDetailAscii(profile: ProfileSummary): string {
  const lines = [
    '================================================================',
    `PROFILE: ${profile.name}${profile.isDefault ? ' (default)' : ''}`,
    '================================================================',
    `  Directory   : ${profile.dir}`,
    `  Daemon      : ${profile.daemonRunning ? 'running' : 'stopped'}`,
    `  Files       : ${profile.fileCount} (${formatBytes(profile.sizeBytes)})`,
    `  Features    : ${profileFeaturesList(profile)}`,
    ...(profile.description ? [`  Description : ${profile.description}`] : []),
    ...(profile.engine ? [`  Engine      : ${profile.engine}`] : []),
    ...(profile.policy ? [`  Policy      : ${profile.policy}`] : []),
    ...(profile.tags && profile.tags.length > 0 ? [`  Tags        : ${profile.tags.join(', ')}`] : []),
    ...(profile.createdAt ? [`  Created     : ${profile.createdAt}`] : []),
    ...(profile.updatedAt ? [`  Updated     : ${profile.updatedAt}`] : []),
    '================================================================',
  ]
  return sanitizeAscii(lines.join('\n'))
}
