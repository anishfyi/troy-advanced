// Deterministic autonomy policy modeled directly on Troy's refusal rules.
// The AI agent can request an action; only this deterministic code authorizes it.

import type { ElementDescriptor, PolicyDecision, SsrfProtectionOptions } from '../types.js'
import { exactOrigin } from './omnibox.js'
import { checkUrlSsrfSync } from './ssrf.js'

export const SENSITIVE_PATTERNS = Object.freeze({
  secret:
    /password|passcode|passkey|one[- ]?time(?: code)?|\botp\b|\bpin\b|verification[- ]?code|security[- ]?code|recovery[- ]?(?:code|phrase)|seed[- ]?phrase|private[- ]?key|api[- ]?key|secret[- ]?key|auth[- ]?token/i,
  payment:
    /card[- ]?number|credit[- ]?card|debit[- ]?card|\bcvv\b|\bcvc\b|expiry|expiration|routing[- ]?number|bank[- ]?account|account[- ]?number|iban|swift|sort[- ]?code|payment|billing/i,
  identity:
    /social[- ]security|\bssn\b|national[- ]id|passport|driver'?s?[- ]?licen[cs]e|tax[- ]id|aadhaar|government[- ]id|identity[- ]?document/i,
})

const SUBMIT_PATTERN =
  /submit|commit|place (the )?order|checkout|pay\b|purchase|send\b|confirm|delete account|remove permanently|wire|transfer/i

function descriptorText(item: Partial<ElementDescriptor>): string {
  return [
    item.text,
    item.label,
    item.ariaLabel,
    item.name,
    item.id,
    item.role,
    item.autocomplete,
    item.inputMode,
    item.placeholder,
    item.href,
    item.formAction,
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' | ')
}

export function sensitiveElementReason(item: Partial<ElementDescriptor>): string | null {
  const type = String(item.type ?? '').toLowerCase()
  const tag = String(item.tag ?? '').toLowerCase()
  const autocomplete = String(item.autocomplete ?? '').toLowerCase()
  const words = descriptorText(item)

  if (type === 'password') return 'password fields are never operated by the agent'
  if (tag === 'input' && type === 'file') return 'file uploads are never operated by the agent'
  if (/cc-|one-time-code|new-password|current-password/.test(autocomplete)) {
    return 'this field is marked for a credential, verification code, or payment card'
  }
  if (SENSITIVE_PATTERNS.secret.test(words)) return 'this control appears to contain a credential, code, or secret'
  if (SENSITIVE_PATTERNS.payment.test(words)) return 'payment and bank fields are never operated by the agent'
  if (SENSITIVE_PATTERNS.identity.test(words)) return 'government identity fields are never operated by the agent'
  return null
}

export function isCommitLikeElement(item: Partial<ElementDescriptor>): boolean {
  if (item.defaultSubmit) return true
  const words = [item.text, item.label, item.ariaLabel, item.name, item.value].filter(Boolean).join(' ')
  return SUBMIT_PATTERN.test(words)
}

export function authorizeAction(request: {
  name: string
  item?: Partial<ElementDescriptor>
  targetUrl?: string
  currentUrl?: string
  allowSubmit?: boolean
  allowedOrigins: Iterable<string>
  blockPrivateNet?: boolean
  ssrf?: SsrfProtectionOptions
}): PolicyDecision {
  const allowed = new Set(request.allowedOrigins)
  const ssrfOpts: SsrfProtectionOptions | undefined =
    request.ssrf ?? (request.blockPrivateNet ? { enabled: true } : undefined)

  if (request.name === 'page_navigate') {
    const origin = exactOrigin(request.targetUrl)
    if (!origin) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'scheme',
        reason: 'the agent may navigate only to HTTP or HTTPS pages',
      }
    }
    if (ssrfOpts?.enabled && request.targetUrl) {
      const ssrf = checkUrlSsrfSync(request.targetUrl, ssrfOpts)
      if (ssrf.blocked && ssrf.reason) {
        return {
          allowed: false,
          status: 'blocked',
          code: 'ssrf',
          reason: ssrf.reason,
          origin,
        }
      }
    }
    if (!allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `navigation requested an origin outside this session: ${origin}`,
        origin,
      }
    }
    return { allowed: true }
  }

  if (request.name === 'page_eval') {
    const origin = exactOrigin(request.currentUrl)
    if (!origin) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'scheme',
        reason: 'page_eval may run only on HTTP or HTTPS pages',
      }
    }
    if (!allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `page_eval requested on an origin outside this session: ${origin}`,
        origin,
      }
    }
    return { allowed: true }
  }

  const item = request.item ?? {}
  const sensitive = sensitiveElementReason(item)
  if (sensitive) {
    return { allowed: false, status: 'blocked', code: 'sensitive', reason: sensitive }
  }

  if (item.href) {
    if (ssrfOpts?.enabled) {
      const ssrf = checkUrlSsrfSync(item.href, ssrfOpts)
      if (ssrf.blocked && ssrf.reason) {
        return {
          allowed: false,
          status: 'blocked',
          code: 'ssrf',
          reason: ssrf.reason,
          origin: exactOrigin(item.href) ?? undefined,
        }
      }
    }
    const origin = exactOrigin(item.href)
    if (origin && !allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `that control would leave the session for ${origin}`,
        origin,
      }
    }
  }

  if (request.name === 'page_click' && !request.allowSubmit && isCommitLikeElement(item)) {
    return {
      allowed: false,
      status: 'boundary',
      code: 'submit',
      reason: `clicking "${item.text || item.label || item.ariaLabel || item.tag}" looks like a commit/submit action; pass allowSubmit: true to confirm`,
    }
  }

  return { allowed: true }
}
