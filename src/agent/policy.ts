// Deterministic autonomy policy modeled directly on Troy's refusal rules.
// The AI agent can request an action; only this deterministic code authorizes it.

import type { ElementDescriptor, PolicyDecision, ResolvedPolicyProfile, SsrfProtectionOptions } from '../types.js'
import { detectRefusedScheme, exactOrigin } from './omnibox.js'
import { PolicyProfileGuard, compilePolicyPatterns } from './policy-profile.js'
import { isMutatingTool } from './readonly.js'
import { checkUrlSsrfSync } from './ssrf.js'

export const SENSITIVE_PATTERNS = Object.freeze({
  secret:
    /password|passcode|passkey|one[-_ ]?time(?:[-_ ]?code)?|(?<![a-z0-9])(?:otp|pin)(?![a-z0-9])|verification[-_ ]?code|security[-_ ]?code|recovery[-_ ]?(?:code|phrase)|seed[-_ ]?phrase|private[-_ ]?key|api[-_ ]?key|secret[-_ ]?key|auth[-_ ]?token/i,
  payment:
    /card[-_ ]?number|credit[-_ ]?card|debit[-_ ]?card|(?<![a-z0-9])(?:cvv|cvc)(?![a-z0-9])|expiry|expiration|routing[-_ ]?number|bank[-_ ]?account|account[-_ ]?number|iban|swift|sort[-_ ]?code|payment|billing/i,
  identity:
    /social[-_ ]?security|(?<![a-z0-9])ssn(?![a-z0-9])|national[-_ ]?id|passport|driver'?s?[-_ ]?licen[cs]e|tax[-_ ]?id|aadhaar|government[-_ ]?id|identity[-_ ]?document/i,
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

export function sensitiveElementReason(
  item: Partial<ElementDescriptor>,
  extraPatterns?: readonly RegExp[],
): string | null {
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
  if (extraPatterns && extraPatterns.length > 0) {
    for (const rx of extraPatterns) {
      if (rx.test(words)) {
        return `this control matches a custom sensitive policy pattern (${rx.source})`
      }
    }
  }
  return null
}

export function isCommitLikeElement(
  item: Partial<ElementDescriptor>,
  extraPatterns?: readonly RegExp[],
): boolean {
  if (item.defaultSubmit === true) return true
  if (item.defaultSubmit !== false && String(item.type ?? '').toLowerCase() === 'submit') return true
  const words = [item.text, item.label, item.ariaLabel, item.name, item.value].filter(Boolean).join(' ')
  if (SUBMIT_PATTERN.test(words)) return true
  if (extraPatterns && extraPatterns.length > 0) {
    for (const rx of extraPatterns) {
      if (rx.test(words)) return true
    }
  }
  return false
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
  policy?: ResolvedPolicyProfile | PolicyProfileGuard
  readonly?: boolean
}): PolicyDecision {
  if (request.readonly) {
    const check = isMutatingTool(request.name)
    if (check.mutating) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'readonly',
        reason: check.reason ?? `tool "${check.canonicalTool}" is refused in read-only observer mode (--readonly)`,
      }
    }
  }
  const allowed = new Set(request.allowedOrigins)
  const guard =
    request.policy instanceof PolicyProfileGuard
      ? request.policy
      : request.policy
        ? new PolicyProfileGuard(request.policy)
        : null
  const policy = guard?.resolved
  const ssrfOpts: SsrfProtectionOptions | undefined =
    request.ssrf ?? (request.blockPrivateNet || policy?.blockPrivateNet ? { enabled: true } : undefined)

  const requireOriginGrant = policy ? policy.requireOriginGrant : true
  const requireSubmitConfirmation = policy ? policy.requireSubmitConfirmation : true
  const blockSensitiveFields = policy ? policy.blockSensitiveFields : true
  const extraSensitiveRegexes = guard
    ? guard.extraSensitiveRegexes
    : policy?.extraSensitivePatterns?.length
      ? compilePolicyPatterns(policy.extraSensitivePatterns)
      : undefined
  const extraSubmitRegexes = guard
    ? guard.extraSubmitRegexes
    : policy?.extraSubmitPatterns?.length
      ? compilePolicyPatterns(policy.extraSubmitPatterns)
      : undefined

  if (guard?.isToolBlocked(request.name)) {
    return {
      allowed: false,
      status: 'blocked',
      code: 'policy_tool_blocked',
      reason: `tool "${request.name}" is blocked by the active policy profile (${policy!.profile})`,
    }
  }

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
    if (guard?.isOriginDenied(origin)) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'origin_denied',
        reason: `navigation to ${origin} is denied by policy`,
        origin,
      }
    }
    if (requireOriginGrant && !allowed.has(origin) && !guard?.isOriginAllowed(origin)) {
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
    if (policy && !policy.allowEval) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'policy_eval_disabled',
        reason: `page_eval is disabled by the active policy profile (${policy.profile})`,
      }
    }
    const origin = exactOrigin(request.currentUrl)
    if (!origin) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'scheme',
        reason: 'page_eval may run only on HTTP or HTTPS pages',
      }
    }
    if (guard?.isOriginDenied(origin)) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'origin_denied',
        reason: `page_eval on ${origin} is denied by policy`,
        origin,
      }
    }
    if (requireOriginGrant && !allowed.has(origin) && !guard?.isOriginAllowed(origin)) {
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
  if (blockSensitiveFields) {
    const sensitive = sensitiveElementReason(item, extraSensitiveRegexes)
    if (sensitive) {
      return { allowed: false, status: 'blocked', code: 'sensitive', reason: sensitive }
    }
  }

  // Check `item.href` on any action, and `item.formAction` on `page_click` (where a submitter
  // can actually trigger navigation/submission; filling an input inside a cross-origin iframe
  // does not submit the form).
  const frameOrigin = item.frameUrl ? exactOrigin(item.frameUrl) : null
  const targetAttrs: Array<{ url: string | undefined; isFormAction: boolean }> =
    request.name === 'page_click'
      ? [
          { url: item.href, isFormAction: false },
          { url: item.formAction, isFormAction: true },
        ]
      : [{ url: item.href, isFormAction: false }]

  for (const { url: targetAttr, isFormAction } of targetAttrs) {
    if (!targetAttr) continue
    const refusedScheme = detectRefusedScheme(targetAttr)
    if (refusedScheme) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'scheme',
        reason: `that control targets a refused scheme (${refusedScheme})`,
      }
    }
    if (ssrfOpts?.enabled) {
      const ssrf = checkUrlSsrfSync(targetAttr, ssrfOpts)
      if (ssrf.blocked && ssrf.reason) {
        return {
          allowed: false,
          status: 'blocked',
          code: 'ssrf',
          reason: ssrf.reason,
          origin: exactOrigin(targetAttr) ?? undefined,
        }
      }
    }
    const origin = exactOrigin(targetAttr)
    if (origin && guard?.isOriginDenied(origin)) {
      return {
        allowed: false,
        status: 'blocked',
        code: 'origin_denied',
        reason: `that control targets ${origin}, which is denied by policy`,
        origin,
      }
    }
    // A form inside an embedded cross-origin iframe defaults its `formAction` to its own frame URL;
    // do not block same-frame form submissions as cross-origin, while still blocking external formActions.
    const sameAsEmbeddedFrame = isFormAction && frameOrigin !== null && origin === frameOrigin
    if (
      requireOriginGrant &&
      origin &&
      !sameAsEmbeddedFrame &&
      !allowed.has(origin) &&
      !guard?.isOriginAllowed(origin)
    ) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `that control would leave the session for ${origin}`,
        origin,
      }
    }
  }

  if (
    request.name === 'page_click' &&
    requireSubmitConfirmation &&
    !request.allowSubmit &&
    isCommitLikeElement(item, extraSubmitRegexes)
  ) {
    return {
      allowed: false,
      status: 'boundary',
      code: 'submit',
      reason: `clicking "${item.text || item.label || item.ariaLabel || item.tag}" looks like a commit/submit action; pass allowSubmit: true to confirm`,
    }
  }

  return { allowed: true }
}
