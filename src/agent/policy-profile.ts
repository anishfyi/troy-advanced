// Configurable policy profiles ('strict' | 'standard' | 'permissive') loaded from policy.json.
// Provides deterministic rule presets, strict JSON validation, safe 0o600 persistence,
// and strict 7-bit ASCII formatting for terminal/agent inspection.

import fs from 'node:fs'
import path from 'node:path'
import type {
  DownloadPolicyMode,
  PolicyFileConfig,
  PolicyProfileInput,
  PolicyProfileName,
  PolicyProfileStats,
  PolicyValidationResult,
  ResolvedPolicyProfile,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { exactOrigin, normalizeOrigin } from './omnibox.js'
import {
  isWildcardOriginRule,
  matchesOriginRule,
  mergeOriginRuleLists,
  normalizeOriginRule,
} from '../cloud/daemon-config.js'

export const POLICY_PROFILE_NAMES: readonly PolicyProfileName[] = Object.freeze([
  'strict',
  'standard',
  'permissive',
])

export const DEFAULT_POLICY_FILENAME = 'policy.json'

const VALID_DOWNLOAD_MODES = new Set<DownloadPolicyMode>(['deny', 'quarantine', 'allow'])

const KNOWN_POLICY_KEYS = new Set<string>([
  'profile',
  'allowEval',
  'requireOriginGrant',
  'requireSubmitConfirmation',
  'blockSensitiveFields',
  'blockPrivateNet',
  'untrustedMarkers',
  'blockTrackers',
  'downloadMode',
  'maxActSteps',
  'blockedTools',
  'allowedOrigins',
  'deniedOrigins',
  'extraSensitivePatterns',
  'extraSubmitPatterns',
])

export interface PolicyPresetDefaults {
  profile: PolicyProfileName
  allowEval: boolean
  requireOriginGrant: boolean
  requireSubmitConfirmation: boolean
  blockSensitiveFields: boolean
  blockPrivateNet: boolean
  untrustedMarkers: boolean
  blockTrackers: boolean
  downloadMode: DownloadPolicyMode
  maxActSteps: number
  blockedTools: readonly string[]
}

export const POLICY_PROFILE_PRESETS: Readonly<Record<PolicyProfileName, PolicyPresetDefaults>> = Object.freeze({
  strict: Object.freeze({
    profile: 'strict' as const,
    allowEval: false,
    requireOriginGrant: true,
    requireSubmitConfirmation: true,
    blockSensitiveFields: true,
    blockPrivateNet: true,
    untrustedMarkers: true,
    blockTrackers: true,
    downloadMode: 'deny' as const,
    maxActSteps: 10,
    blockedTools: Object.freeze(['page_eval']),
  }),
  standard: Object.freeze({
    profile: 'standard' as const,
    allowEval: true,
    requireOriginGrant: true,
    requireSubmitConfirmation: true,
    blockSensitiveFields: true,
    blockPrivateNet: false,
    untrustedMarkers: false,
    blockTrackers: true,
    downloadMode: 'quarantine' as const,
    maxActSteps: 50,
    blockedTools: Object.freeze([]),
  }),
  permissive: Object.freeze({
    profile: 'permissive' as const,
    allowEval: true,
    requireOriginGrant: false,
    requireSubmitConfirmation: false,
    blockSensitiveFields: true,
    blockPrivateNet: false,
    untrustedMarkers: false,
    blockTrackers: false,
    downloadMode: 'allow' as const,
    maxActSteps: 100,
    blockedTools: Object.freeze([]),
  }),
})

export function parsePolicyProfileName(raw: unknown): PolicyProfileName | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'strict' || v === 'standard' || v === 'permissive') return v
  return undefined
}

export function defaultPolicyFilePath(profileDir: string): string {
  return path.join(profileDir, DEFAULT_POLICY_FILENAME)
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

function normalizeOriginList(raw: unknown, fieldName: string, errors: string[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push(`"${fieldName}" must be an array of http(s) origin strings`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push(`"${fieldName}[${i}]" must be a non-empty string`)
      continue
    }
    const normalized = normalizeOriginRule(entry)
    if (!normalized) {
      errors.push(`"${fieldName}[${i}]" is not a valid http(s) origin: ${JSON.stringify(entry)}`)
      continue
    }
    out.push(normalized)
  }
  return dedupeStrings(out)
}

function validateRegexList(raw: unknown, fieldName: string, errors: string[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push(`"${fieldName}" must be an array of regex pattern strings`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push(`"${fieldName}[${i}]" must be a non-empty regex string`)
      continue
    }
    try {
      // Validate compilation with case-insensitive flag
      new RegExp(entry, 'i')
      out.push(entry)
    } catch (err) {
      errors.push(`"${fieldName}[${i}]" is not a valid regular expression: ${(err as Error).message}`)
    }
  }
  return dedupeStrings(out)
}

function validateToolNameList(raw: unknown, fieldName: string, errors: string[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push(`"${fieldName}" must be an array of tool name strings`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push(`"${fieldName}[${i}]" must be a non-empty string`)
      continue
    }
    out.push(entry.trim())
  }
  return dedupeStrings(out)
}

export function validatePolicyConfig(
  raw: unknown,
  opts: { sourceFile?: string; overrideProfile?: PolicyProfileName } = {},
): PolicyValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ['policy configuration must be a JSON object'],
      warnings,
    }
  }

  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!KNOWN_POLICY_KEYS.has(key)) {
      warnings.push(`unknown policy key "${key}" will be ignored`)
    }
  }

  let profile: PolicyProfileName = 'standard'
  if (obj.profile !== undefined) {
    const parsed = parsePolicyProfileName(obj.profile)
    if (!parsed) {
      errors.push(
        `"profile" must be one of: ${POLICY_PROFILE_NAMES.join(', ')} (got ${JSON.stringify(obj.profile)})`,
      )
    } else {
      profile = parsed
    }
  }
  if (opts.overrideProfile) {
    profile = opts.overrideProfile
  }

  const preset = POLICY_PROFILE_PRESETS[profile]
  let customized = false

  const readBool = (key: keyof PolicyPresetDefaults & keyof PolicyFileConfig, fallback: boolean): boolean => {
    const val = obj[key]
    if (val === undefined) return fallback
    if (typeof val !== 'boolean') {
      errors.push(`"${key}" must be a boolean`)
      return fallback
    }
    if (val !== fallback) customized = true
    return val
  }

  const allowEval = readBool('allowEval', preset.allowEval)
  const requireOriginGrant = readBool('requireOriginGrant', preset.requireOriginGrant)
  const requireSubmitConfirmation = readBool('requireSubmitConfirmation', preset.requireSubmitConfirmation)
  const blockSensitiveFields = readBool('blockSensitiveFields', preset.blockSensitiveFields)
  const blockPrivateNet = readBool('blockPrivateNet', preset.blockPrivateNet)
  const untrustedMarkers = readBool('untrustedMarkers', preset.untrustedMarkers)
  const blockTrackers = readBool('blockTrackers', preset.blockTrackers)

  let downloadMode: DownloadPolicyMode = preset.downloadMode
  if (obj.downloadMode !== undefined) {
    if (typeof obj.downloadMode !== 'string' || !VALID_DOWNLOAD_MODES.has(obj.downloadMode as DownloadPolicyMode)) {
      errors.push(`"downloadMode" must be one of: deny, quarantine, allow (got ${JSON.stringify(obj.downloadMode)})`)
    } else {
      downloadMode = obj.downloadMode as DownloadPolicyMode
      if (downloadMode !== preset.downloadMode) customized = true
    }
  }

  let maxActSteps = preset.maxActSteps
  if (obj.maxActSteps !== undefined) {
    if (typeof obj.maxActSteps !== 'number' || !Number.isInteger(obj.maxActSteps) || obj.maxActSteps < 1 || obj.maxActSteps > 200) {
      errors.push(`"maxActSteps" must be an integer between 1 and 200 (got ${JSON.stringify(obj.maxActSteps)})`)
    } else {
      maxActSteps = obj.maxActSteps
      if (maxActSteps !== preset.maxActSteps) customized = true
    }
  }

  let blockedTools = [...preset.blockedTools]
  if (obj.blockedTools !== undefined) {
    blockedTools = validateToolNameList(obj.blockedTools, 'blockedTools', errors)
    const presetTools = [...preset.blockedTools]
    if (
      blockedTools.length !== presetTools.length ||
      blockedTools.some((t, idx) => t !== presetTools[idx])
    ) {
      customized = true
    }
  }
  // Keep allowEval=false and blockedTools consistent if user explicitly sets allowEval: true on strict
  if (obj.allowEval === true && obj.blockedTools === undefined) {
    blockedTools = blockedTools.filter((t) => t !== 'page_eval')
  }

  let allowedOrigins: string[] = []
  if (obj.allowedOrigins !== undefined) {
    allowedOrigins = normalizeOriginList(obj.allowedOrigins, 'allowedOrigins', errors)
    if (allowedOrigins.length > 0) customized = true
  }

  let deniedOrigins: string[] = []
  if (obj.deniedOrigins !== undefined) {
    deniedOrigins = normalizeOriginList(obj.deniedOrigins, 'deniedOrigins', errors)
    if (deniedOrigins.length > 0) customized = true
  }

  // Warn if an origin appears in both allowedOrigins and deniedOrigins (deniedOrigins wins)
  const deniedSet = new Set(deniedOrigins)
  for (const origin of allowedOrigins) {
    if (deniedSet.has(origin)) {
      warnings.push(`origin ${origin} appears in both allowedOrigins and deniedOrigins; deniedOrigins takes precedence`)
    }
  }

  let extraSensitivePatterns: string[] = []
  if (obj.extraSensitivePatterns !== undefined) {
    extraSensitivePatterns = validateRegexList(obj.extraSensitivePatterns, 'extraSensitivePatterns', errors)
    if (extraSensitivePatterns.length > 0) customized = true
  }

  let extraSubmitPatterns: string[] = []
  if (obj.extraSubmitPatterns !== undefined) {
    extraSubmitPatterns = validateRegexList(obj.extraSubmitPatterns, 'extraSubmitPatterns', errors)
    if (extraSubmitPatterns.length > 0) customized = true
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  const resolved: ResolvedPolicyProfile = {
    profile,
    allowEval,
    requireOriginGrant,
    requireSubmitConfirmation,
    blockSensitiveFields,
    blockPrivateNet,
    untrustedMarkers,
    blockTrackers,
    downloadMode,
    maxActSteps,
    blockedTools,
    allowedOrigins,
    deniedOrigins,
    extraSensitivePatterns,
    extraSubmitPatterns,
    ...(opts.sourceFile ? { sourceFile: opts.sourceFile } : {}),
    customized,
    warnings,
  }

  return { ok: true, resolved, errors: [], warnings }
}

export function loadPolicyFile(
  filePath: string,
  opts: { overrideProfile?: PolicyProfileName } = {},
): ResolvedPolicyProfile {
  const absPath = path.resolve(filePath)
  let rawText: string
  try {
    rawText = fs.readFileSync(absPath, 'utf8')
  } catch (err) {
    throw new Error(`Failed to read policy file "${absPath}": ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (err) {
    throw new Error(`Invalid JSON in policy file "${absPath}": ${(err as Error).message}`)
  }

  const validation = validatePolicyConfig(parsed, {
    sourceFile: absPath,
    overrideProfile: opts.overrideProfile,
  })
  if (!validation.ok || !validation.resolved) {
    throw new Error(`Invalid policy file "${absPath}": ${validation.errors.join('; ')}`)
  }
  return validation.resolved
}

export function resolvePolicyProfile(
  input?: PolicyProfileInput,
  opts: {
    policyFile?: string
    profileDir?: string
    autoLoadPolicyFile?: boolean
    overrideProfile?: PolicyProfileName
  } = {},
): ResolvedPolicyProfile {
  let fileConfig: PolicyFileConfig | undefined
  let sourceFile: string | undefined

  if (opts.policyFile) {
    const absPath = path.resolve(opts.policyFile)
    const loaded = loadPolicyFile(absPath)
    sourceFile = loaded.sourceFile
    // Re-read raw JSON object so programmatic overrides merge cleanly
    fileConfig = JSON.parse(fs.readFileSync(absPath, 'utf8')) as PolicyFileConfig
  } else if (opts.autoLoadPolicyFile !== false && opts.profileDir) {
    const candidate = defaultPolicyFilePath(opts.profileDir)
    if (fs.existsSync(candidate)) {
      const loaded = loadPolicyFile(candidate)
      sourceFile = loaded.sourceFile
      fileConfig = JSON.parse(fs.readFileSync(candidate, 'utf8')) as PolicyFileConfig
    }
  }

  let merged: PolicyFileConfig = { ...(fileConfig ?? {}) }
  if (typeof input === 'string') {
    const parsedName = parsePolicyProfileName(input)
    if (!parsedName) {
      throw new Error(
        `Invalid policy profile "${input}". Valid profiles: ${POLICY_PROFILE_NAMES.join(', ')}`,
      )
    }
    merged.profile = parsedName
  } else if (input && typeof input === 'object') {
    merged = { ...merged, ...input }
  }

  if (opts.overrideProfile) {
    merged.profile = opts.overrideProfile
  }

  const validation = validatePolicyConfig(merged, { sourceFile })
  if (!validation.ok || !validation.resolved) {
    throw new Error(`Invalid policy configuration: ${validation.errors.join('; ')}`)
  }
  return validation.resolved
}

export function createPolicyTemplate(profile: PolicyProfileName = 'standard'): PolicyFileConfig {
  const preset = POLICY_PROFILE_PRESETS[profile]
  return {
    profile: preset.profile,
    allowEval: preset.allowEval,
    requireOriginGrant: preset.requireOriginGrant,
    requireSubmitConfirmation: preset.requireSubmitConfirmation,
    blockSensitiveFields: preset.blockSensitiveFields,
    blockPrivateNet: preset.blockPrivateNet,
    untrustedMarkers: preset.untrustedMarkers,
    blockTrackers: preset.blockTrackers,
    downloadMode: preset.downloadMode,
    maxActSteps: preset.maxActSteps,
    blockedTools: [...preset.blockedTools],
    allowedOrigins: [],
    deniedOrigins: [],
    extraSensitivePatterns: [],
    extraSubmitPatterns: [],
  }
}

export function writePolicyFile(filePath: string, config: PolicyFileConfig): ResolvedPolicyProfile {
  const absPath = path.resolve(filePath)
  const validation = validatePolicyConfig(config, { sourceFile: absPath })
  if (!validation.ok || !validation.resolved) {
    throw new Error(`Cannot write invalid policy config: ${validation.errors.join('; ')}`)
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const payload = JSON.stringify(config, null, 2) + '\n'
  fs.writeFileSync(absPath, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(absPath, 0o600)
  } catch {
    // ignore on filesystems that don't support POSIX chmod
  }
  return validation.resolved
}

export function compilePolicyPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'))
}

export class PolicyProfileGuard {
  readonly resolved: ResolvedPolicyProfile
  readonly blockedToolSet: ReadonlySet<string>
  readonly extraSensitiveRegexes: readonly RegExp[]
  readonly extraSubmitRegexes: readonly RegExp[]
  private allowedOriginExactSet: Set<string>
  private allowedOriginWildcardRules: string[]
  private deniedOriginExactSet: Set<string>
  private deniedOriginWildcardRules: string[]

  constructor(resolved: ResolvedPolicyProfile) {
    this.resolved = resolved
    this.blockedToolSet = new Set(resolved.blockedTools)
    this.extraSensitiveRegexes = compilePolicyPatterns(resolved.extraSensitivePatterns)
    this.extraSubmitRegexes = compilePolicyPatterns(resolved.extraSubmitPatterns)
    this.allowedOriginExactSet = new Set<string>()
    this.allowedOriginWildcardRules = []
    this.deniedOriginExactSet = new Set<string>()
    this.deniedOriginWildcardRules = []
    this.rebuildOriginIndexes()
  }

  private rebuildOriginIndexes(): void {
    this.allowedOriginExactSet = new Set<string>()
    this.allowedOriginWildcardRules = []
    for (const rule of this.resolved.allowedOrigins) {
      if (isWildcardOriginRule(rule)) {
        this.allowedOriginWildcardRules.push(rule)
      } else {
        this.allowedOriginExactSet.add(rule)
      }
    }

    this.deniedOriginExactSet = new Set<string>()
    this.deniedOriginWildcardRules = []
    for (const rule of this.resolved.deniedOrigins) {
      if (isWildcardOriginRule(rule)) {
        this.deniedOriginWildcardRules.push(rule)
      } else {
        this.deniedOriginExactSet.add(rule)
      }
    }
  }

  get deniedOriginSet(): ReadonlySet<string> {
    return this.deniedOriginExactSet
  }

  get profile(): PolicyProfileName {
    return this.resolved.profile
  }

  isToolBlocked(toolName: string): boolean {
    return this.blockedToolSet.has(toolName)
  }

  isOriginDenied(urlOrOrigin?: string | null): string | null {
    if (!urlOrOrigin) return null
    if (this.deniedOriginExactSet.size === 0 && this.deniedOriginWildcardRules.length === 0) {
      return null
    }
    const origin = exactOrigin(urlOrOrigin) ?? normalizeOrigin(urlOrOrigin)
    if (!origin) return null
    if (this.deniedOriginExactSet.has(origin)) return origin
    for (const rule of this.deniedOriginWildcardRules) {
      if (matchesOriginRule(rule, origin)) return origin
    }
    return null
  }

  isOriginAllowed(urlOrOrigin?: string | null): string | null {
    if (!urlOrOrigin) return null
    if (this.allowedOriginExactSet.size === 0 && this.allowedOriginWildcardRules.length === 0) {
      return null
    }
    const origin = exactOrigin(urlOrOrigin) ?? normalizeOrigin(urlOrOrigin)
    if (!origin) return null
    // Deny always takes precedence over allow
    if (this.isOriginDenied(origin)) return null
    if (this.allowedOriginExactSet.has(origin)) return origin
    for (const rule of this.allowedOriginWildcardRules) {
      if (matchesOriginRule(rule, origin)) return origin
    }
    return null
  }

  setOriginLists(allowedOrigins: readonly string[], deniedOrigins: readonly string[]): void {
    this.resolved.allowedOrigins = mergeOriginRuleLists(allowedOrigins)
    this.resolved.deniedOrigins = mergeOriginRuleLists(deniedOrigins)
    if (this.resolved.allowedOrigins.length > 0 || this.resolved.deniedOrigins.length > 0) {
      this.resolved.customized = true
    }
    this.rebuildOriginIndexes()
  }

  getStats(): PolicyProfileStats {
    const r = this.resolved
    return {
      profile: r.profile,
      ...(r.sourceFile ? { sourceFile: r.sourceFile } : {}),
      customized: r.customized,
      allowEval: r.allowEval,
      requireOriginGrant: r.requireOriginGrant,
      requireSubmitConfirmation: r.requireSubmitConfirmation,
      blockSensitiveFields: r.blockSensitiveFields,
      blockPrivateNet: r.blockPrivateNet,
      untrustedMarkers: r.untrustedMarkers,
      blockTrackers: r.blockTrackers,
      downloadMode: r.downloadMode,
      maxActSteps: r.maxActSteps,
      blockedTools: [...r.blockedTools],
      allowedOrigins: [...r.allowedOrigins],
      deniedOrigins: [...r.deniedOrigins],
      extraSensitivePatternCount: r.extraSensitivePatterns.length,
      extraSubmitPatternCount: r.extraSubmitPatterns.length,
      warnings: [...r.warnings],
    }
  }

  formatAscii(opts: { width?: number } = {}): string {
    return formatPolicyAscii(this.getStats(), opts)
  }
}

export function formatPolicyAscii(stats: PolicyProfileStats, opts: { width?: number } = {}): string {
  const width = Math.max(48, Math.min(120, Math.floor(opts.width ?? 76)))
  const inner = width - 4
  const hr = '+' + '-'.repeat(width - 2) + '+'
  const row = (text: string): string => {
    const clean = sanitizeAscii(text)
    const clipped = clean.length > inner ? clean.slice(0, Math.max(0, inner - 3)) + '...' : clean
    return `| ${clipped.padEnd(inner, ' ')} |`
  }

  const lines: string[] = [
    hr,
    row(`POLICY PROFILE: ${stats.profile.toUpperCase()}${stats.customized ? ' (customized)' : ''}`),
    hr,
    row(`sourceFile                : ${stats.sourceFile ?? '(built-in preset)'}`),
    row(`allowEval                 : ${stats.allowEval ? 'yes' : 'no'}`),
    row(`requireOriginGrant        : ${stats.requireOriginGrant ? 'yes' : 'no'}`),
    row(`requireSubmitConfirmation : ${stats.requireSubmitConfirmation ? 'yes' : 'no'}`),
    row(`blockSensitiveFields      : ${stats.blockSensitiveFields ? 'yes' : 'no'}`),
    row(`blockPrivateNet (SSRF)    : ${stats.blockPrivateNet ? 'yes' : 'no'}`),
    row(`untrustedMarkers          : ${stats.untrustedMarkers ? 'yes' : 'no'}`),
    row(`blockTrackers             : ${stats.blockTrackers ? 'yes' : 'no'}`),
    row(`downloadMode              : ${stats.downloadMode}`),
    row(`maxActSteps               : ${stats.maxActSteps}`),
    row(`blockedTools              : ${stats.blockedTools.length > 0 ? stats.blockedTools.join(', ') : '(none)'}`),
    row(`allowedOrigins            : ${stats.allowedOrigins.length > 0 ? stats.allowedOrigins.join(', ') : '(none)'}`),
    row(`deniedOrigins             : ${stats.deniedOrigins.length > 0 ? stats.deniedOrigins.join(', ') : '(none)'}`),
    row(`extraSensitivePatterns    : ${stats.extraSensitivePatternCount}`),
    row(`extraSubmitPatterns       : ${stats.extraSubmitPatternCount}`),
  ]

  if (stats.warnings.length > 0) {
    lines.push(hr)
    for (const w of stats.warnings) {
      lines.push(row(`WARN: ${w}`))
    }
  }

  lines.push(hr)
  return lines.join('\n')
}
