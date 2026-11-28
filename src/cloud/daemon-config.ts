// Persistent daemon configuration (daemon.json) and origin allowlist/denylist rule matching.
// Supports exact http(s) origins (https://example.com, http://127.0.0.1:8080) and
// wildcard subdomain patterns (https://*.example.com, http://*.internal:8080, *.example.com).

import fs from 'node:fs'
import path from 'node:path'
import type {
  DaemonConfigFile,
  DaemonConfigValidationResult,
  OriginRulesSummary,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { exactOrigin, normalizeOrigin } from '../agent/omnibox.js'
import { defaultEndpointPath } from '../bridge/endpoint.js'

export const DEFAULT_DAEMON_CONFIG_FILENAME = 'daemon.json'

const KNOWN_DAEMON_CONFIG_KEYS = new Set<string>([
  'version',
  'updatedAt',
  'allowedOrigins',
  'deniedOrigins',
])

const WILDCARD_RULE_RE = /^(?:(https?):\/\/)?\*\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::(\d{1,5}))?(?:\/.*)?$/i

export interface ParsedWildcardOriginRule {
  protocol?: 'http:' | 'https:'
  suffix: string
  port?: string
  canonical: string
}

function defaultPortForProtocol(protocol: 'http:' | 'https:'): string {
  return protocol === 'https:' ? '443' : '80'
}

function parseWildcardOriginRule(raw: string): ParsedWildcardOriginRule | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const m = WILDCARD_RULE_RE.exec(trimmed)
  if (!m) return null

  const schemeRaw = m[1]?.toLowerCase()
  const protocol = schemeRaw ? (`${schemeRaw}:` as 'http:' | 'https:') : undefined
  const suffix = m[2]!.toLowerCase()
  const portRaw = m[3]

  let port: string | undefined
  if (portRaw !== undefined) {
    const portNum = Number(portRaw)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null
    if (!protocol || portRaw !== defaultPortForProtocol(protocol)) {
      port = String(portNum)
    }
  }

  const canonical = `${protocol ? `${protocol}//` : ''}*.${suffix}${port ? `:${port}` : ''}`
  return { protocol, suffix, port, canonical }
}

export function isWildcardOriginRule(rule: string): boolean {
  return parseWildcardOriginRule(rule) !== null
}

/**
 * Normalize an origin rule string for allowlist/denylist storage.
 * Accepts:
 *   - Exact http(s) origins or URLs (normalized via `normalizeOrigin`, e.g. `https://example.com`)
 *   - Wildcard subdomain rules (`https://*.example.com`, `http://*.internal:8080`, `*.example.com`)
 * Rejects non-http(s) schemes (`javascript:`, `file:`, `data:`), bare `*`, and malformed hosts.
 */
export function normalizeOriginRule(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Reject explicit non-http(s) schemes immediately
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null
  }

  // Check wildcard subdomain syntax first
  if (trimmed.includes('*')) {
    const parsed = parseWildcardOriginRule(trimmed)
    return parsed ? parsed.canonical : null
  }

  return normalizeOrigin(trimmed)
}

/**
 * Test whether a concrete URL or origin matches a normalized origin rule
 * (either exact origin match or wildcard subdomain match).
 */
export function matchesOriginRule(rule: string, urlOrOrigin?: string | null): boolean {
  if (!urlOrOrigin) return false
  const targetOrigin = exactOrigin(urlOrOrigin) ?? normalizeOrigin(urlOrOrigin)
  if (!targetOrigin) return false

  const normalizedRule = normalizeOriginRule(rule)
  if (!normalizedRule) return false

  const wildcard = parseWildcardOriginRule(normalizedRule)
  if (!wildcard) {
    return normalizedRule === targetOrigin
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(targetOrigin)
  } catch {
    return false
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return false
  if (wildcard.protocol && targetUrl.protocol !== wildcard.protocol) return false

  const targetHost = targetUrl.hostname.toLowerCase()
  // Strict subdomain match: `sub.example.com` matches `*.example.com`,
  // while `example.com` and `notexample.com` do NOT.
  if (!targetHost.endsWith(`.${wildcard.suffix}`) || targetHost.length <= wildcard.suffix.length + 1) {
    return false
  }

  if (wildcard.port) {
    const effectiveTargetPort =
      targetUrl.port || defaultPortForProtocol(targetUrl.protocol as 'http:' | 'https:')
    if (effectiveTargetPort !== wildcard.port) return false
  } else if (wildcard.protocol) {
    // Explicit scheme without explicit port means default port for that scheme
    if (targetUrl.port && targetUrl.port !== defaultPortForProtocol(wildcard.protocol)) {
      return false
    }
  }

  return true
}

export function dedupeOriginRules(rules: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rules) {
    if (!seen.has(r)) {
      seen.add(r)
      out.push(r)
    }
  }
  return out
}

export function mergeOriginRuleLists(
  ...lists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const merged: string[] = []
  for (const list of lists) {
    if (!list) continue
    for (const item of list) {
      const normalized = normalizeOriginRule(item)
      if (normalized) merged.push(normalized)
    }
  }
  return dedupeOriginRules(merged)
}

/**
 * Parse repeatable and/or comma-separated CLI flag or env-var values into
 * normalized origin rules, collecting any invalid inputs for fail-loud reporting.
 */
export function parseOriginFlagValues(
  values: readonly string[] | string | undefined,
): { valid: string[]; invalid: string[] } {
  const rawList =
    values === undefined
      ? []
      : typeof values === 'string'
        ? [values]
        : values

  const valid: string[] = []
  const invalid: string[] = []

  for (const entry of rawList) {
    const parts = entry.split(',')
    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const normalized = normalizeOriginRule(trimmed)
      if (normalized) {
        valid.push(normalized)
      } else {
        invalid.push(trimmed)
      }
    }
  }

  return { valid: dedupeOriginRules(valid), invalid }
}

export function defaultDaemonConfigPath(opts: {
  configFile?: string
  profileDir?: string
  endpointFile?: string
  env?: NodeJS.ProcessEnv
} = {}): string {
  const env = opts.env ?? process.env
  if (opts.configFile?.trim()) return path.resolve(opts.configFile.trim())
  if (env.TROY_ADVANCED_DAEMON_CONFIG?.trim()) return path.resolve(env.TROY_ADVANCED_DAEMON_CONFIG.trim())
  if (opts.profileDir?.trim()) return path.join(path.resolve(opts.profileDir.trim()), DEFAULT_DAEMON_CONFIG_FILENAME)
  if (opts.endpointFile?.trim()) {
    return path.join(path.dirname(path.resolve(opts.endpointFile.trim())), DEFAULT_DAEMON_CONFIG_FILENAME)
  }
  return path.join(path.dirname(defaultEndpointPath(env)), DEFAULT_DAEMON_CONFIG_FILENAME)
}

export function validateDaemonConfig(raw: unknown): DaemonConfigValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ['daemon configuration must be a JSON object'],
      warnings,
    }
  }

  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!KNOWN_DAEMON_CONFIG_KEYS.has(key)) {
      warnings.push(`unknown daemon config key "${key}" will be ignored`)
    }
  }

  if (obj.version !== undefined && obj.version !== 1) {
    errors.push(`"version" must be 1 (got ${JSON.stringify(obj.version)})`)
  }

  const validateList = (field: 'allowedOrigins' | 'deniedOrigins'): string[] => {
    const val = obj[field]
    if (val === undefined) return []
    if (!Array.isArray(val)) {
      errors.push(`"${field}" must be an array of origin rules`)
      return []
    }
    const out: string[] = []
    for (let i = 0; i < val.length; i++) {
      const entry = val[i]
      const normalized = normalizeOriginRule(entry)
      if (!normalized) {
        errors.push(`"${field}[${i}]" is not a valid http(s) origin or wildcard rule: ${JSON.stringify(entry)}`)
      } else {
        out.push(normalized)
      }
    }
    return dedupeOriginRules(out)
  }

  const allowedOrigins = validateList('allowedOrigins')
  const deniedOrigins = validateList('deniedOrigins')

  const deniedSet = new Set(deniedOrigins)
  for (const origin of allowedOrigins) {
    if (deniedSet.has(origin)) {
      warnings.push(`origin ${origin} appears in both allowedOrigins and deniedOrigins; deniedOrigins takes precedence`)
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  const updatedAt =
    typeof obj.updatedAt === 'string' && obj.updatedAt.trim()
      ? obj.updatedAt
      : new Date().toISOString()

  return {
    ok: true,
    config: {
      version: 1,
      updatedAt,
      allowedOrigins,
      deniedOrigins,
    },
    errors: [],
    warnings,
  }
}

export function readDaemonConfig(filePath: string): DaemonConfigFile | null {
  const absPath = path.resolve(filePath)
  if (!fs.existsSync(absPath)) return null

  let rawText: string
  try {
    rawText = fs.readFileSync(absPath, 'utf8')
  } catch (err) {
    throw new Error(`Failed to read daemon config "${absPath}": ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (err) {
    throw new Error(`Invalid JSON in daemon config "${absPath}": ${(err as Error).message}`)
  }

  const validation = validateDaemonConfig(parsed)
  if (!validation.ok || !validation.config) {
    throw new Error(`Invalid daemon config "${absPath}": ${validation.errors.join('; ')}`)
  }
  return validation.config
}

export function writeDaemonConfig(
  filePath: string,
  config: { allowedOrigins?: readonly string[]; deniedOrigins?: readonly string[] },
): DaemonConfigFile {
  const absPath = path.resolve(filePath)
  const payloadObj: DaemonConfigFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    allowedOrigins: mergeOriginRuleLists(config.allowedOrigins),
    deniedOrigins: mergeOriginRuleLists(config.deniedOrigins),
  }

  const validation = validateDaemonConfig(payloadObj)
  if (!validation.ok || !validation.config) {
    throw new Error(`Cannot write invalid daemon config: ${validation.errors.join('; ')}`)
  }

  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(validation.config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    // ignore on filesystems without POSIX chmod
  }
  fs.renameSync(tmp, absPath)
  return validation.config
}

export interface PersistDaemonOriginUpdate {
  allowOrigins?: readonly string[]
  denyOrigins?: readonly string[]
  removeAllowed?: readonly string[]
  removeDenied?: readonly string[]
  clearAllowed?: boolean
  clearDenied?: boolean
}

export function persistDaemonOriginRules(
  filePath: string,
  update: PersistDaemonOriginUpdate,
): DaemonConfigFile {
  const existing = readDaemonConfig(filePath)
  let allowed = update.clearAllowed ? [] : [...(existing?.allowedOrigins ?? [])]
  let denied = update.clearDenied ? [] : [...(existing?.deniedOrigins ?? [])]

  if (update.allowOrigins?.length) {
    allowed = mergeOriginRuleLists(allowed, update.allowOrigins)
  }
  if (update.denyOrigins?.length) {
    denied = mergeOriginRuleLists(denied, update.denyOrigins)
  }

  if (update.removeAllowed?.length) {
    const toRemove = new Set(mergeOriginRuleLists(update.removeAllowed))
    allowed = allowed.filter((o) => !toRemove.has(o))
  }
  if (update.removeDenied?.length) {
    const toRemove = new Set(mergeOriginRuleLists(update.removeDenied))
    denied = denied.filter((o) => !toRemove.has(o))
  }

  return writeDaemonConfig(filePath, {
    allowedOrigins: allowed,
    deniedOrigins: denied,
  })
}

export function formatOriginRulesAscii(
  summary: OriginRulesSummary,
  opts: { width?: number } = {},
): string {
  const width = Math.max(48, Math.min(opts.width ?? 80, 140))
  const hr = '+' + '-'.repeat(width - 2) + '+'
  const lines: string[] = [
    hr,
    `| ${sanitizeAscii('TROY ADVANCED :: ORIGIN ALLOWLIST / DENYLIST').slice(0, width - 4).padEnd(width - 4)} |`,
    hr,
    `Config File : ${sanitizeAscii(summary.configFile)} (${summary.configExists ? 'persisted' : 'not yet created'})`,
    `Allowlist   : ${summary.allowedOrigins.length > 0 ? sanitizeAscii(summary.allowedOrigins.join(', ')) : '(none)'}`,
    `Denylist    : ${summary.deniedOrigins.length > 0 ? sanitizeAscii(summary.deniedOrigins.join(', ')) : '(none)'}`,
    `Precedence  : deniedOrigins ALWAYS overrides allowedOrigins`,
    hr,
  ]
  return lines.join('\n')
}
