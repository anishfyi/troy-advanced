// Custom HTTP headers, User-Agent, and viewport preset profiles
// (desktop, mobile, terminal, and custom WxH) shared across Chromium CDP & Lite engines.

import type {
  EmulationOptions,
  EmulationProfile,
  EmulationUpdateMode,
  ViewportConfig,
  ViewportPresetName,
} from '../types.js'
import { sanitizeAscii } from '../ascii/sanitize.js'

export const MIN_VIEWPORT_WIDTH = 200
export const MAX_VIEWPORT_WIDTH = 7680
export const MIN_VIEWPORT_HEIGHT = 200
export const MAX_VIEWPORT_HEIGHT = 4320
export const MIN_DEVICE_SCALE_FACTOR = 0.5
export const MAX_DEVICE_SCALE_FACTOR = 4

export const VIEWPORT_PRESETS: Record<ViewportPresetName, Readonly<EmulationProfile>> = {
  desktop: {
    preset: 'desktop',
    viewport: {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      hasTouch: false,
    },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    extraHeaders: {},
  },
  mobile: {
    preset: 'mobile',
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      hasTouch: true,
    },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    extraHeaders: {},
  },
  terminal: {
    preset: 'terminal',
    viewport: {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
      hasTouch: false,
    },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64; TroyAdvanced/0.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    extraHeaders: {},
  },
}

const VALID_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const SENSITIVE_HEADER_NAME_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-secret|x-csrf-token|api-key)$/i

export function isViewportPresetName(value: unknown): value is ViewportPresetName {
  if (typeof value !== 'string') return false
  const lower = value.trim().toLowerCase()
  return lower === 'desktop' || lower === 'mobile' || lower === 'terminal'
}

export function cloneEmulationProfile(profile: EmulationProfile): EmulationProfile {
  return {
    preset: profile.preset,
    viewport: { ...profile.viewport },
    userAgent: profile.userAgent,
    ...(profile.acceptLanguage !== undefined ? { acceptLanguage: profile.acceptLanguage } : {}),
    ...(profile.platform !== undefined ? { platform: profile.platform } : {}),
    extraHeaders: { ...profile.extraHeaders },
  }
}

export function defaultEmulationProfile(): EmulationProfile {
  return cloneEmulationProfile(VIEWPORT_PRESETS.desktop)
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampScale(n: number): number {
  const clamped = Math.max(MIN_DEVICE_SCALE_FACTOR, Math.min(MAX_DEVICE_SCALE_FACTOR, n))
  return Math.round(clamped * 100) / 100
}

export interface ParsedViewportSpec {
  preset: ViewportPresetName | 'custom'
  width: number
  height: number
  deviceScaleFactor?: number
  mobile?: boolean
  hasTouch?: boolean
  /** True if the input was a named preset (desktop/mobile/terminal). */
  isNamedPreset: boolean
  presetName?: ViewportPresetName
}

/**
 * Parse a viewport specification:
 * - Named presets: 'desktop', 'mobile', 'terminal'
 * - Custom dimensions: '1440x900', '1920X1080', '1024,768', '375x812@3', '375x812@2m'
 * - Structured ViewportConfig object
 */
export function parseViewportSpec(input: string | ViewportConfig): ParsedViewportSpec {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) {
      throw new Error('Viewport specification cannot be empty')
    }
    const lower = trimmed.toLowerCase()
    if (isViewportPresetName(lower)) {
      const p = VIEWPORT_PRESETS[lower]
      return {
        preset: lower,
        presetName: lower,
        isNamedPreset: true,
        width: p.viewport.width,
        height: p.viewport.height,
        deviceScaleFactor: p.viewport.deviceScaleFactor,
        mobile: p.viewport.mobile,
        hasTouch: p.viewport.hasTouch,
      }
    }

    // Match WxH or W,H with optional @scale and optional m (mobile) suffix
    const m = /^(\d{2,5})\s*[xX,]\s*(\d{2,5})(?:@(\d+(?:\.\d+)?))?(m)?$/.exec(trimmed)
    if (!m) {
      throw new Error(
        `Invalid viewport "${input}". Expected preset (desktop, mobile, terminal) or WxH (e.g. 1440x900, 390x844@3m).`,
      )
    }
    const width = Number(m[1])
    const height = Number(m[2])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_VIEWPORT_WIDTH || height < MIN_VIEWPORT_HEIGHT) {
      throw new Error(
        `Viewport dimensions "${input}" out of range (min ${MIN_VIEWPORT_WIDTH}x${MIN_VIEWPORT_HEIGHT}, max ${MAX_VIEWPORT_WIDTH}x${MAX_VIEWPORT_HEIGHT}).`,
      )
    }
    const scale = m[3] !== undefined ? clampScale(Number(m[3])) : undefined
    const mobile = m[4] === 'm' ? true : undefined
    return {
      preset: 'custom',
      isNamedPreset: false,
      width: clampInt(width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
      height: clampInt(height, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
      ...(scale !== undefined ? { deviceScaleFactor: scale } : {}),
      ...(mobile !== undefined ? { mobile, hasTouch: mobile } : {}),
    }
  }

  if (!input || typeof input !== 'object') {
    throw new Error('Viewport specification must be a preset name, WxH string, or ViewportConfig object')
  }

  const width = Number(input.width)
  const height = Number(input.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_VIEWPORT_WIDTH || height < MIN_VIEWPORT_HEIGHT) {
    throw new Error(
      `Invalid viewport dimensions (${String(input.width)}x${String(input.height)}). Min ${MIN_VIEWPORT_WIDTH}x${MIN_VIEWPORT_HEIGHT}.`,
    )
  }

  const presetName = isViewportPresetName(input.preset) ? (input.preset.toLowerCase() as ViewportPresetName) : undefined
  return {
    preset: presetName ?? 'custom',
    presetName,
    isNamedPreset: false,
    width: clampInt(width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
    height: clampInt(height, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
    ...(input.deviceScaleFactor !== undefined && Number.isFinite(input.deviceScaleFactor)
      ? { deviceScaleFactor: clampScale(input.deviceScaleFactor) }
      : {}),
    ...(typeof input.mobile === 'boolean' ? { mobile: input.mobile } : {}),
    ...(typeof input.hasTouch === 'boolean' ? { hasTouch: input.hasTouch } : {}),
  }
}

export function tryParseViewportSpec(input: unknown): ParsedViewportSpec | null {
  if (typeof input !== 'string' && (!input || typeof input !== 'object')) return null
  try {
    return parseViewportSpec(input as string | ViewportConfig)
  } catch {
    return null
  }
}

/**
 * Parse a single CLI header argument ("Header-Name: value" or "Header-Name=value").
 */
export function parseHeaderArg(raw: string): [string, string] {
  const str = String(raw ?? '')
  if (/[\r\n\0]/.test(str)) {
    throw new Error('Header must not contain CR, LF, or NUL characters')
  }
  const colonIdx = str.indexOf(':')
  const eqIdx = colonIdx === -1 ? str.indexOf('=') : -1
  const sepIdx = colonIdx !== -1 ? colonIdx : eqIdx
  if (sepIdx <= 0) {
    throw new Error(`Invalid header "${raw}". Expected "Header-Name: value".`)
  }
  const name = str.slice(0, sepIdx).trim()
  const value = str.slice(sepIdx + 1).trim()
  if (!VALID_HEADER_NAME_RE.test(name)) {
    throw new Error(`Invalid HTTP header name "${name}"`)
  }
  return [name, value]
}

/**
 * Parse an array of "Header-Name: value" strings into a sanitized header map.
 */
export function parseHeaderList(rawList: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const lowerToKey = new Map<string, string>()
  for (const raw of rawList) {
    const [name, value] = parseHeaderArg(raw)
    const lower = name.toLowerCase()
    const prev = lowerToKey.get(lower)
    if (prev && prev !== name) delete out[prev]
    lowerToKey.set(lower, name)
    out[name] = value
  }
  return out
}

/**
 * Validate and normalize an HTTP header map.
 * Rejects CR/LF/NUL injection and invalid RFC 7230 token names; deduplicates case-insensitively.
 */
export function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {}
  const out: Record<string, string> = {}
  const lowerToKey = new Map<string, string>()

  for (const [rawName, rawVal] of Object.entries(headers)) {
    const name = String(rawName ?? '').trim()
    const value = String(rawVal ?? '').trim()
    if (!name) continue
    if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) {
      throw new Error(`Header "${name}" contains illegal CR/LF/NUL characters`)
    }
    if (!VALID_HEADER_NAME_RE.test(name)) {
      throw new Error(`Invalid HTTP header name "${name}"`)
    }
    const lower = name.toLowerCase()
    const prev = lowerToKey.get(lower)
    if (prev && prev !== name) delete out[prev]
    lowerToKey.set(lower, name)
    out[name] = value
  }
  return out
}

/**
 * Case-insensitive header merge with optional removal keys.
 */
export function mergeHeaders(
  base: Record<string, string>,
  patch: Record<string, string>,
  removeKeys?: string[],
): Record<string, string> {
  const result: Record<string, string> = {}
  const lowerToKey = new Map<string, string>()

  const put = (k: string, v: string) => {
    const lower = k.toLowerCase()
    const prev = lowerToKey.get(lower)
    if (prev && prev !== k) delete result[prev]
    lowerToKey.set(lower, k)
    result[k] = v
  }

  for (const [k, v] of Object.entries(sanitizeHeaders(base))) put(k, v)
  for (const [k, v] of Object.entries(sanitizeHeaders(patch))) put(k, v)

  if (removeKeys && removeKeys.length > 0) {
    for (const rawKey of removeKeys) {
      const lower = String(rawKey ?? '').trim().toLowerCase()
      const existing = lowerToKey.get(lower)
      if (existing) {
        delete result[existing]
        lowerToKey.delete(lower)
      }
    }
  }

  return result
}

/**
 * Resolve a full EmulationProfile from options, optionally building on a base profile.
 * - If `opts.viewport` is a named preset ('desktop'|'mobile'|'terminal'), its viewport,
 *   userAgent, and platform become the new baseline (unless explicitly overridden in opts).
 * - If `opts.viewport` is a custom WxH or ViewportConfig, only viewport fields change;
 *   existing userAgent and platform are preserved.
 * - By default `extraHeaders` merges into `base.extraHeaders` when `mode.mergeHeaders !== false`,
 *   or replaces when `mode.mergeHeaders === false` / `mode.clearHeaders === true`.
 */
export function resolveEmulationProfile(
  opts: EmulationOptions = {},
  base?: EmulationProfile,
  mode: EmulationUpdateMode = {},
): EmulationProfile {
  let next = base ? cloneEmulationProfile(base) : defaultEmulationProfile()

  if (opts.viewport !== undefined) {
    const parsed = parseViewportSpec(opts.viewport)
    if (parsed.isNamedPreset && parsed.presetName) {
      const presetProfile = VIEWPORT_PRESETS[parsed.presetName]
      next = {
        ...next,
        preset: parsed.presetName,
        viewport: { ...presetProfile.viewport },
        userAgent: presetProfile.userAgent,
        platform: presetProfile.platform,
      }
    } else {
      next = {
        ...next,
        preset: parsed.preset,
        viewport: {
          width: parsed.width,
          height: parsed.height,
          deviceScaleFactor: parsed.deviceScaleFactor ?? next.viewport.deviceScaleFactor,
          mobile: parsed.mobile ?? next.viewport.mobile,
          hasTouch: parsed.hasTouch ?? (parsed.mobile !== undefined ? parsed.mobile : next.viewport.hasTouch),
        },
      }
    }
  }

  if (opts.userAgent !== undefined) {
    const ua = String(opts.userAgent).trim()
    if (/[\r\n\0]/.test(ua)) {
      throw new Error('User-Agent must not contain CR, LF, or NUL characters')
    }
    if (ua) next.userAgent = ua
  }

  if (opts.acceptLanguage !== undefined) {
    const lang = String(opts.acceptLanguage).trim()
    if (/[\r\n\0]/.test(lang)) {
      throw new Error('Accept-Language must not contain CR, LF, or NUL characters')
    }
    if (lang) {
      next.acceptLanguage = lang
    } else {
      delete next.acceptLanguage
    }
  }

  if (opts.platform !== undefined) {
    const plat = String(opts.platform).trim()
    if (/[\r\n\0]/.test(plat)) {
      throw new Error('Platform must not contain CR, LF, or NUL characters')
    }
    if (plat) {
      next.platform = plat
    } else {
      delete next.platform
    }
  }

  if (mode.clearHeaders) {
    next.extraHeaders = opts.extraHeaders ? sanitizeHeaders(opts.extraHeaders) : {}
  } else if (opts.extraHeaders !== undefined) {
    if (mode.mergeHeaders === false) {
      next.extraHeaders = sanitizeHeaders(opts.extraHeaders)
    } else {
      next.extraHeaders = mergeHeaders(next.extraHeaders, opts.extraHeaders, mode.removeHeaders)
    }
  } else if (mode.removeHeaders && mode.removeHeaders.length > 0) {
    next.extraHeaders = mergeHeaders(next.extraHeaders, {}, mode.removeHeaders)
  }

  return next
}

export function maskHeaderValue(name: string, value: string, reveal = false): string {
  if (reveal) return value
  if (!SENSITIVE_HEADER_NAME_RE.test(name.trim())) return value
  if (value.length <= 6) return '***'
  return `${value.slice(0, 4)}***(${value.length}ch)`
}

export function redactHeaders(headers: Record<string, string>, reveal = false): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = maskHeaderValue(k, v, reveal)
  }
  return out
}

export function formatEmulationAscii(
  profile: EmulationProfile,
  opts: { revealHeaders?: boolean; tabId?: number } = {},
): string {
  const lines: string[] = []
  const headerTitle =
    opts.tabId !== undefined
      ? `Emulation Profile (tab ${opts.tabId})`
      : 'Emulation Profile (default)'
  lines.push(`=== ${headerTitle} ===`)
  lines.push(
    `Preset   : ${profile.preset} (${profile.viewport.width}x${profile.viewport.height} @${profile.viewport.deviceScaleFactor}x, mobile=${profile.viewport.mobile}, touch=${profile.viewport.hasTouch})`,
  )
  lines.push(`UA       : ${sanitizeAscii(profile.userAgent)}`)
  if (profile.platform) {
    lines.push(`Platform : ${sanitizeAscii(profile.platform)}`)
  }
  if (profile.acceptLanguage) {
    lines.push(`Lang     : ${sanitizeAscii(profile.acceptLanguage)}`)
  }
  const entries = Object.entries(profile.extraHeaders)
  if (entries.length === 0) {
    lines.push('Headers  : (none)')
  } else {
    lines.push(`Headers  : (${entries.length})`)
    for (const [k, v] of entries) {
      lines.push(`  ${sanitizeAscii(k)}: ${sanitizeAscii(maskHeaderValue(k, v, Boolean(opts.revealHeaders)))}`)
    }
  }
  return lines.join('\n')
}
