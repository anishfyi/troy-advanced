// LocalStorage / SessionStorage normalization, filtering, redaction, ASCII inspection,
// and authenticated AES-256-GCM encryption for secure EC2 session hydration.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeAscii } from '../ascii/sanitize.js'
import type {
  EncryptedStorageBundle,
  OriginStorageSnapshot,
  StorageArea,
  StorageExportBundle,
} from '../types.js'
import { domainFilterMatches } from './cookies.js'

const ENCRYPTION_AAD = Buffer.from('troy-advanced:storage:v1', 'utf8')
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }

const SENSITIVE_KEY_RE =
  /(?:token|auth|jwt|secret|pass(?:word|wd)?|api[_-]?key|access[_-]?key|refresh|session|credential|bearer|cookie|private[_-]?key|csrf|xsrf|oauth)/i
const JWT_VALUE_RE = /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/
const AWS_KEY_VALUE_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/

export function normalizeStorageArea(raw: unknown): StorageArea {
  if (raw === 'local' || raw === 'session' || raw === 'both') return raw
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase()
    if (lower === 'local' || lower === 'localstorage') return 'local'
    if (lower === 'session' || lower === 'sessionstorage') return 'session'
  }
  return 'both'
}

/**
 * Normalize an origin or URL string into a canonical `http(s)://host[:port]` origin.
 * Rejects opaque/non-HTTP(S) schemes such as `about:`, `data:`, `javascript:`, `file:`.
 */
export function normalizeStorageOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'null') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  if (!parsed.hostname) return null
  return parsed.origin.toLowerCase()
}

export function normalizeStorageMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue
    if (v === undefined || v === null) continue
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

export function normalizeOriginStorageSnapshot(raw: unknown): OriginStorageSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const origin = normalizeStorageOrigin(obj.origin ?? obj.url)
  if (!origin) return null
  const localStorage = normalizeStorageMap(obj.localStorage ?? obj.local)
  const sessionStorage = normalizeStorageMap(obj.sessionStorage ?? obj.session)
  return { origin, localStorage, sessionStorage }
}

/**
 * Match a snapshot origin against either an exact origin URL (`https://app.example.com`)
 * or a hostname/domain filter (`example.com`, `.example.com`, `app.example.com`).
 */
export function originFilterMatches(snapshotOrigin: string, filter: string): boolean {
  const normSnap = normalizeStorageOrigin(snapshotOrigin)
  if (!normSnap) return false
  const trimmed = filter.trim()
  if (!trimmed) return true

  const normFilterOrigin = normalizeStorageOrigin(trimmed)
  if (normFilterOrigin) {
    return normSnap === normFilterOrigin
  }

  try {
    const snapHost = new URL(normSnap).hostname
    return domainFilterMatches(snapHost, trimmed)
  } catch {
    return false
  }
}

function filterRecordByPrefix(map: Record<string, string>, keyPrefix?: string): Record<string, string> {
  if (!keyPrefix) return { ...map }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(keyPrefix)) out[k] = v
  }
  return out
}

/**
 * Merge duplicate origin entries and apply origin, area (`local`|`session`|`both`),
 * and `keyPrefix` filters.
 */
export function filterStorageSnapshots(
  snapshots: OriginStorageSnapshot[],
  opts: { origin?: string; area?: StorageArea; keyPrefix?: string } = {},
): OriginStorageSnapshot[] {
  const area = normalizeStorageArea(opts.area)
  const byOrigin = new Map<string, OriginStorageSnapshot>()

  for (const raw of snapshots) {
    const snap = normalizeOriginStorageSnapshot(raw)
    if (!snap) continue
    if (opts.origin && !originFilterMatches(snap.origin, opts.origin)) continue

    const localFiltered =
      area === 'session' ? {} : filterRecordByPrefix(snap.localStorage, opts.keyPrefix)
    const sessionFiltered =
      area === 'local' ? {} : filterRecordByPrefix(snap.sessionStorage, opts.keyPrefix)

    const existing = byOrigin.get(snap.origin)
    if (existing) {
      Object.assign(existing.localStorage, localFiltered)
      Object.assign(existing.sessionStorage, sessionFiltered)
    } else {
      byOrigin.set(snap.origin, {
        origin: snap.origin,
        localStorage: localFiltered,
        sessionStorage: sessionFiltered,
      })
    }
  }

  return [...byOrigin.values()].sort((a, b) => a.origin.localeCompare(b.origin))
}

export function countStorageKeys(snapshots: OriginStorageSnapshot[]): {
  localKeys: number
  sessionKeys: number
  totalKeys: number
} {
  let localKeys = 0
  let sessionKeys = 0
  for (const s of snapshots) {
    localKeys += Object.keys(s.localStorage).length
    sessionKeys += Object.keys(s.sessionStorage).length
  }
  return { localKeys, sessionKeys, totalKeys: localKeys + sessionKeys }
}

export function isSensitiveStorageKeyOrValue(key: string, value: string): boolean {
  if (SENSITIVE_KEY_RE.test(key)) return true
  const trimmed = value.trim()
  if (JWT_VALUE_RE.test(trimmed)) return true
  if (AWS_KEY_VALUE_RE.test(trimmed)) return true
  return false
}

function formatPreviewValue(key: string, value: string, revealValues: boolean, maxValueLen: number): string {
  if (!revealValues && isSensitiveStorageKeyOrValue(key, value)) {
    return `<redacted:${value.length} chars>`
  }
  const clean = sanitizeAscii(value.replace(/\r?\n/g, '\\n'))
  if (clean.length <= maxValueLen) return clean
  return `${clean.slice(0, Math.max(0, maxValueLen - 3))}...`
}

export function redactStorageSnapshots(
  snapshots: OriginStorageSnapshot[],
  opts: { revealValues?: boolean; maxValueLen?: number } = {},
): OriginStorageSnapshot[] {
  const revealValues = Boolean(opts.revealValues)
  const maxValueLen = opts.maxValueLen ?? 120
  return snapshots.map((snap) => {
    const localStorage: Record<string, string> = {}
    const sessionStorage: Record<string, string> = {}
    for (const [k, v] of Object.entries(snap.localStorage)) {
      localStorage[k] = revealValues ? v : formatPreviewValue(k, v, false, maxValueLen)
    }
    for (const [k, v] of Object.entries(snap.sessionStorage)) {
      sessionStorage[k] = revealValues ? v : formatPreviewValue(k, v, false, maxValueLen)
    }
    return { origin: snap.origin, localStorage, sessionStorage }
  })
}

export function formatStorageAscii(
  snapshots: OriginStorageSnapshot[],
  opts: { revealValues?: boolean; width?: number } = {},
): string {
  const revealValues = Boolean(opts.revealValues)
  const width = Math.max(50, Math.min(160, opts.width ?? 96))
  const counts = countStorageKeys(snapshots)
  const lines: string[] = []
  const rule = '='.repeat(width)
  const subRule = '-'.repeat(width)

  lines.push(rule)
  lines.push(
    sanitizeAscii(
      `WEB STORAGE INSPECTION | origins=${snapshots.length} local=${counts.localKeys} session=${counts.sessionKeys} mode=${revealValues ? 'revealed' : 'redacted'}`,
    ),
  )
  lines.push(rule)

  if (snapshots.length === 0) {
    lines.push('(no web storage origins found)')
    return lines.join('\n')
  }

  for (const snap of snapshots) {
    const localEntries = Object.entries(snap.localStorage).sort(([a], [b]) => a.localeCompare(b))
    const sessionEntries = Object.entries(snap.sessionStorage).sort(([a], [b]) => a.localeCompare(b))
    lines.push(
      sanitizeAscii(
        `Origin: ${snap.origin} (localStorage=${localEntries.length}, sessionStorage=${sessionEntries.length})`,
      ),
    )

    const renderSection = (label: string, entries: Array<[string, string]>) => {
      lines.push(`  [${label}]`)
      if (entries.length === 0) {
        lines.push('    (empty)')
        return
      }
      const keyCol = Math.min(28, Math.max(12, ...entries.map(([k]) => sanitizeAscii(k).length)))
      const valCol = Math.max(20, width - keyCol - 9)
      for (const [k, v] of entries) {
        const cleanKey = sanitizeAscii(k)
        const displayKey = cleanKey.length > keyCol ? `${cleanKey.slice(0, keyCol - 3)}...` : cleanKey.padEnd(keyCol)
        const displayVal = formatPreviewValue(k, v, revealValues, valCol)
        lines.push(`    ${displayKey} = ${displayVal}`)
      }
    }

    renderSection('localStorage', localEntries)
    renderSection('sessionStorage', sessionEntries)
    lines.push(subRule)
  }

  return lines.join('\n')
}

export function createStorageBundle(
  origins: OriginStorageSnapshot[],
  engine: 'chromium' | 'lite',
): StorageExportBundle {
  const counts = countStorageKeys(origins)
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    engine,
    originCount: origins.length,
    totalKeys: counts.totalKeys,
    origins,
  }
}

export function encryptStorageBundle(
  bundle: StorageExportBundle,
  passphrase: string,
): EncryptedStorageBundle {
  if (!passphrase || passphrase.length < 1) {
    throw new Error('Passphrase is required to encrypt storage bundle')
  }
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(ENCRYPTION_AAD)
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    version: 1,
    encrypted: true,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    exportedAt: bundle.exportedAt,
  }
}

export function decryptStorageBundle(
  envelope: EncryptedStorageBundle,
  passphrase: string,
): StorageExportBundle {
  if (!passphrase) {
    throw new Error('Encrypted storage bundle requires a passphrase (--passphrase or TROY_STORAGE_PASSPHRASE)')
  }
  if (envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm') {
    throw new Error(`Unsupported storage bundle encryption: ${envelope.kdf}/${envelope.cipher}`)
  }
  try {
    const salt = Buffer.from(envelope.salt, 'base64')
    const iv = Buffer.from(envelope.iv, 'base64')
    const authTag = Buffer.from(envelope.authTag, 'base64')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(ENCRYPTION_AAD)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plaintext) as StorageExportBundle
    if (!parsed || !Array.isArray(parsed.origins)) {
      throw new Error('Decrypted payload is not a valid storage bundle')
    }
    return parsed
  } catch (err) {
    if ((err as Error).message.includes('Decrypted payload')) throw err
    throw new Error('Failed to decrypt storage bundle (invalid passphrase or corrupted data)')
  }
}

export function serializeStorageBundle(
  origins: OriginStorageSnapshot[],
  opts: { engine: 'chromium' | 'lite'; passphrase?: string },
): string {
  const bundle = createStorageBundle(origins, opts.engine)
  if (opts.passphrase) {
    return JSON.stringify(encryptStorageBundle(bundle, opts.passphrase), null, 2)
  }
  return JSON.stringify(bundle, null, 2)
}

export function parseStorageBundle(
  rawJson: string,
  opts: { passphrase?: string } = {},
): { origins: OriginStorageSnapshot[]; encrypted: boolean; skipped: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('Storage input is not valid JSON')
  }

  let encrypted = false
  let rawOrigins: unknown[]

  if (Array.isArray(parsed)) {
    rawOrigins = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (obj.encrypted === true) {
      encrypted = true
      const decrypted = decryptStorageBundle(obj as unknown as EncryptedStorageBundle, opts.passphrase ?? '')
      rawOrigins = decrypted.origins
    } else if (Array.isArray(obj.origins)) {
      rawOrigins = obj.origins
    } else if (typeof obj.origin === 'string' || typeof obj.url === 'string') {
      rawOrigins = [obj]
    } else {
      throw new Error(
        'Storage JSON must be a StorageExportBundle, EncryptedStorageBundle, OriginStorageSnapshot, or array of snapshots',
      )
    }
  } else {
    throw new Error('Storage JSON must be an object or array')
  }

  const origins: OriginStorageSnapshot[] = []
  let skipped = 0
  for (const item of rawOrigins) {
    const normalized = normalizeOriginStorageSnapshot(item)
    if (normalized) origins.push(normalized)
    else skipped++
  }

  return { origins, encrypted, skipped }
}

export function writeStorageFile(filePath: string, content: string): { path: string; bytes: number; mode: string } {
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(resolved, 0o600)
  } catch {
    // ignore chmod errors on non-POSIX filesystems
  }
  return { path: resolved, bytes: Buffer.byteLength(content, 'utf8'), mode: '0600' }
}

export function readStorageFile(filePath: string): string {
  const resolved = path.resolve(filePath)
  return fs.readFileSync(resolved, 'utf8')
}
