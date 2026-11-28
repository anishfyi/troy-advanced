// Smart `page_find` engine: fuzzy matching (Damerau-Levenshtein), UI action synonyms,
// weighted multi-field scoring, inline `role:<x>` qualifiers, natural-language role-intent
// boosting, and ARIA role/type/tag filters (`button`, `input`, `link`, `select`, `checkbox`, `radio`, ...).

import type { ElementDescriptor } from '../types.js'

export interface FindElementsOptions {
  /** Free-text search query (supports typos, synonyms, inline `role:button` qualifiers; optional when filtering by role/type/tag). */
  query?: string
  /**
   * Filter by ARIA role or friendly category (`button`, `input`, `link`, `select`,
   * `checkbox`, `radio`, `textbox`, `searchbox`, `combobox`, `tab`, `menuitem`, etc.).
   * Accepts a single role, comma-separated roles, or an array of roles.
   */
  role?: string | string[]
  /** Additional list of ARIA/element roles (OR semantics, merged with `role` and inline `role:` qualifiers). */
  roles?: string[]
  /** Filter by HTML input type (e.g. `email`, `password`, `search`, `submit`, `checkbox`). */
  type?: string
  /** Filter by HTML tag (e.g. `button`, `input`, `a`, `select`, `textarea`). */
  tag?: string
  /** Include disabled elements (default: true). */
  includeDisabled?: boolean
  /** Exclude disabled elements (alias for `includeDisabled: false`). */
  enabledOnly?: boolean
  /** Enable Damerau-Levenshtein fuzzy typo matching (default: true). */
  fuzzy?: boolean
  /** Enable curated UI synonym expansion (default: true). */
  synonyms?: boolean
  /** Maximum results to return (default: 15, clamped 1..100). */
  limit?: number
  /** Optional minimum score threshold (default: > 0 when query is non-empty, 0 otherwise). */
  minScore?: number
  /** Include `score`, `effectiveRole`, and `matchedBy` metadata on each match (default: true). */
  includeScore?: boolean
}

export interface FindElementMatch extends Omit<ElementDescriptor, 'selector'> {
  /** Relevance score (rounded to 2 decimal places). */
  score?: number
  /** Resolved effective ARIA role (explicit role or HTML implicit role). */
  effectiveRole?: string
  /** Human-readable match signals (e.g. `exact:text`, `synonym:label`, `fuzzy:placeholder`, `role:button`). */
  matchedBy?: string[]
}

export interface AppliedFindFilters {
  roles?: string[]
  type?: string
  tag?: string
  enabledOnly?: boolean
}

export interface FindElementsResult {
  ok: true
  query: string
  roles: string[]
  count: number
  totalCandidates: number
  matches: FindElementMatch[]
  filters?: AppliedFindFilters
  appliedFilters?: AppliedFindFilters
}

// ---------------------------------------------------------------------------
// Curated bidirectional UI synonym groups (lowercase normalized phrases)
// ---------------------------------------------------------------------------

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['login', 'log in', 'signin', 'sign in', 'authenticate', 'auth'],
  ['logout', 'log out', 'signout', 'sign out', 'disconnect'],
  ['signup', 'sign up', 'register', 'create account', 'join'],
  ['submit', 'send', 'confirm', 'save', 'apply', 'ok', 'done', 'continue', 'proceed'],
  ['cancel', 'close', 'dismiss', 'abort', 'nevermind'],
  ['search', 'find', 'lookup', 'look up', 'query', 'filter'],
  ['delete', 'remove', 'trash', 'discard', 'erase', 'drop'],
  ['clear', 'reset', 'wipe'],
  ['edit', 'modify', 'update', 'change', 'rename'],
  ['add', 'new', 'create', 'insert', 'compose', 'plus'],
  ['next', 'forward', 'more'],
  ['prev', 'previous', 'back', 'return'],
  ['menu', 'nav', 'navigation', 'hamburger', 'options'],
  ['settings', 'preferences', 'prefs', 'config', 'configuration'],
  ['profile', 'account', 'avatar'],
  ['cart', 'basket', 'bag', 'checkout', 'buy', 'purchase', 'order', 'pay'],
  ['download', 'export', 'fetch'],
  ['upload', 'import', 'attach'],
  ['share', 'copy', 'clipboard'],
  ['help', 'docs', 'documentation', 'support', 'faq', 'guide'],
  ['email', 'e mail', 'mail'],
  ['username', 'user name', 'handle', 'user'],
  ['password', 'passwd', 'pwd', 'passcode', 'secret'],
  ['phone', 'tel', 'telephone', 'mobile'],
  ['address', 'street', 'location'],
  ['refresh', 'reload', 'retry', 'sync'],
  ['expand', 'open', 'show', 'unfold'],
  ['collapse', 'hide', 'fold', 'minimize'],
  ['accept', 'agree', 'allow', 'approve', 'yes'],
  ['reject', 'decline', 'deny', 'disagree', 'no'],
  ['home', 'dashboard', 'overview', 'start'],
  ['subscribe', 'follow', 'notify', 'alerts'],
  ['comment', 'reply', 'post', 'message'],
]

const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>()
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      let set = map.get(term)
      if (!set) {
        set = new Set<string>()
        map.set(term, set)
      }
      for (const peer of group) {
        if (peer !== term) set.add(peer)
      }
    }
  }
  return map
})()

// Natural-language role hint words inside queries -> canonical role filter
const ROLE_INTENT_WORDS: Record<string, string> = {
  button: 'button',
  btn: 'button',
  cta: 'button',
  link: 'link',
  anchor: 'link',
  input: 'input',
  field: 'input',
  textbox: 'textbox',
  textfield: 'input',
  checkbox: 'checkbox',
  toggle: 'checkbox',
  switch: 'checkbox',
  radio: 'radio',
  select: 'select',
  dropdown: 'select',
  combobox: 'select',
  tab: 'tab',
  menuitem: 'menuitem',
}

// ---------------------------------------------------------------------------
// Text normalization, inline qualifier parsing & Damerau-Levenshtein distance
// ---------------------------------------------------------------------------

/**
 * Split camelCase, snake_case, kebab-case, and punctuation into clean lowercase tokens.
 */
export function tokenizeText(raw: string): string[] {
  if (!raw) return []
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!spaced) return []
  return spaced.split(/\s+/).filter(Boolean)
}

/**
 * Extract inline `role:<value>` qualifiers (e.g. `role:button`, `role:button,link`) from a raw query.
 */
export function extractInlineRoleQualifiers(rawQuery: string): {
  cleanQuery: string
  inlineRoles: string[]
} {
  const inlineRoles: string[] = []
  const cleanQuery = rawQuery
    .replace(/(?:^|\s)role:([a-z0-9_,-]+)/gi, (_match, list: string) => {
      for (const part of list.split(',')) {
        const norm = part.trim().toLowerCase()
        if (norm && !inlineRoles.includes(norm)) inlineRoles.push(norm)
      }
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { cleanQuery, inlineRoles }
}

/**
 * Optimal String Alignment (Damerau-Levenshtein) distance with early-exit maxDist bound.
 * Handles insertions, deletions, substitutions, and adjacent transpositions (e.g. `serach` -> `search` = 1).
 */
export function damerauLevenshtein(a: string, b: string, maxDist = 3): number {
  const lenA = a.length
  const lenB = b.length
  if (a === b) return 0
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1
  if (lenA === 0) return lenB
  if (lenB === 0) return lenA

  const dp: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0))
  for (let i = 0; i <= lenA; i++) dp[i]![0] = i
  for (let j = 0; j <= lenB; j++) dp[0]![j] = j

  for (let i = 1; i <= lenA; i++) {
    let rowMin = maxDist + 1
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let val = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + cost, // substitution
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2]![j - 2]! + 1) // transposition
      }
      dp[i]![j] = val
      if (val < rowMin) rowMin = val
    }
    if (rowMin > maxDist) return maxDist + 1
  }

  return dp[lenA]![lenB]!
}

function fuzzyTokenSimilarity(queryToken: string, candidateToken: string): number {
  const qLen = queryToken.length
  const cLen = candidateToken.length
  if (qLen < 3 || cLen < 3) return 0

  const maxLen = Math.max(qLen, cLen)
  const maxDist = qLen <= 4 ? 1 : qLen <= 8 ? 2 : 3
  if (Math.abs(qLen - cLen) > maxDist) return 0

  const dist = damerauLevenshtein(queryToken, candidateToken, maxDist)
  if (dist > maxDist) return 0

  // For short tokens (len 3-4) with distance 1, require first char match or adjacent transposition
  // to avoid noisy matches like "cat" <-> "bat" when a 3-letter word has an unrelated prefix.
  if (qLen <= 4 && dist === 1) {
    const sameFirst = queryToken[0] === candidateToken[0]
    const transposedFirst =
      qLen >= 2 && cLen >= 2 && queryToken[0] === candidateToken[1] && queryToken[1] === candidateToken[0]
    if (!sameFirst && !transposedFirst) return 0
  }

  const similarity = 1 - dist / maxLen
  return similarity >= 0.65 ? similarity : 0
}

// ---------------------------------------------------------------------------
// Effective ARIA role resolution & category filters
// ---------------------------------------------------------------------------

const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image'])
const INPUT_ARIA_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'listbox',
])

/**
 * Resolve the effective ARIA role for an ElementDescriptor (explicit role or HTML implicit role).
 */
export function resolveEffectiveRole(
  el: Pick<ElementDescriptor, 'role' | 'tag' | 'type' | 'href' | 'editable'>,
): string {
  const explicit = (el.role ?? '').trim().toLowerCase()
  if (explicit) return explicit

  const tag = (el.tag ?? '').trim().toLowerCase()
  const type = (el.type ?? '').trim().toLowerCase()

  if (tag === 'button' || tag === 'summary') return 'button'
  if (tag === 'a') return 'link'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'dialog') return 'dialog'
  if (tag === 'input') {
    if (BUTTON_INPUT_TYPES.has(type)) return 'button'
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'search') return 'searchbox'
    if (type === 'number') return 'spinbutton'
    if (type === 'range') return 'slider'
    return 'textbox'
  }
  if (el.editable) return 'textbox'
  return ''
}

/**
 * Normalize role filter inputs (string, comma-separated string, or string[]) into lowercase unique tokens.
 */
export function parseRoleFilters(...inputs: Array<string | string[] | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    if (!input) continue
    const items = Array.isArray(input) ? input : [input]
    for (const item of items) {
      for (const part of String(item ?? '').split(',')) {
        const clean = part.trim().toLowerCase()
        if (clean && !seen.has(clean)) {
          seen.add(clean)
          out.push(clean)
        }
      }
    }
  }
  return out
}

/**
 * Check whether an element satisfies a single role or category filter (`button`, `input`, `link`, etc.).
 */
export function matchesRoleFilter(
  el: Pick<ElementDescriptor, 'role' | 'tag' | 'type' | 'href' | 'editable'>,
  filter: string,
): boolean {
  const f = filter.trim().toLowerCase()
  if (!f) return true

  const eff = resolveEffectiveRole(el)
  const explicit = (el.role ?? '').trim().toLowerCase()
  const tag = (el.tag ?? '').trim().toLowerCase()
  const type = (el.type ?? '').trim().toLowerCase()

  switch (f) {
    case 'button':
    case 'btn':
      return eff === 'button' || tag === 'button' || (tag === 'input' && BUTTON_INPUT_TYPES.has(type))
    case 'input':
    case 'field':
      return (
        tag === 'textarea' ||
        tag === 'select' ||
        (tag === 'input' && !BUTTON_INPUT_TYPES.has(type)) ||
        Boolean(el.editable) ||
        INPUT_ARIA_ROLES.has(eff)
      )
    case 'link':
    case 'anchor':
      return eff === 'link' || (tag === 'a' && eff !== 'button')
    case 'select':
    case 'dropdown':
      return tag === 'select' || eff === 'combobox' || eff === 'listbox'
    case 'checkbox':
    case 'toggle':
      return eff === 'checkbox' || eff === 'switch' || (tag === 'input' && type === 'checkbox')
    case 'radio':
      return eff === 'radio' || (tag === 'input' && type === 'radio')
    case 'textbox':
      return eff === 'textbox' || eff === 'searchbox' || tag === 'textarea'
    default:
      return eff === f || explicit === f
  }
}

// ---------------------------------------------------------------------------
// Weighted multi-field scoring
// ---------------------------------------------------------------------------

interface SearchField {
  name: string
  weight: number
  phrase: string
  tokens: string[]
  isPrimary: boolean
}

function buildSearchFields(el: ElementDescriptor, effectiveRole: string): SearchField[] {
  const rawFields: Array<{ name: string; weight: number; value?: string; isPrimary: boolean }> = [
    { name: 'text', weight: 1.0, value: el.text, isPrimary: true },
    { name: 'label', weight: 1.0, value: el.label, isPrimary: true },
    { name: 'ariaLabel', weight: 1.0, value: el.ariaLabel, isPrimary: true },
    { name: 'placeholder', weight: 0.85, value: el.placeholder, isPrimary: false },
    { name: 'name', weight: 0.85, value: el.name, isPrimary: false },
    { name: 'id', weight: 0.8, value: el.id, isPrimary: false },
    {
      name: 'options',
      weight: 0.65,
      value: el.options?.map((o) => `${o.label} ${o.value}`).join(' '),
      isPrimary: false,
    },
    { name: 'href', weight: 0.55, value: el.href, isPrimary: false },
    { name: 'role', weight: 0.55, value: `${el.role ?? ''} ${effectiveRole}`, isPrimary: false },
    { name: 'type', weight: 0.55, value: `${el.type ?? ''} ${el.autocomplete ?? ''}`, isPrimary: false },
    { name: 'tag', weight: 0.45, value: el.tag, isPrimary: false },
  ]

  const out: SearchField[] = []
  for (const rf of rawFields) {
    if (!rf.value) continue
    const tokens = tokenizeText(rf.value)
    if (tokens.length === 0) continue
    out.push({
      name: rf.name,
      weight: rf.weight,
      phrase: tokens.join(' '),
      tokens,
      isPrimary: rf.isPrimary,
    })
  }
  return out
}

function getSynonymsFor(term: string): Set<string> | undefined {
  return SYNONYM_INDEX.get(term)
}

function scoreTokenAgainstFields(
  token: string,
  fields: SearchField[],
  enableFuzzy: boolean,
  enableSynonyms: boolean,
): { score: number; reason?: string } {
  let bestScore = 0
  let bestReason: string | undefined

  const consider = (score: number, reason: string) => {
    if (score > bestScore) {
      bestScore = score
      bestReason = reason
    }
  }

  // 1. Direct token / prefix / substring matches across fields
  for (const field of fields) {
    for (const ft of field.tokens) {
      if (ft === token) {
        consider(20 * field.weight, `word:${field.name}`)
      } else if (ft.startsWith(token) && token.length >= 2) {
        consider(14 * field.weight, `prefix:${field.name}`)
      } else if (token.length >= 3 && ft.includes(token)) {
        consider(10 * field.weight, `substring:${field.name}`)
      }
    }
  }

  // 2. Fuzzy Damerau-Levenshtein matching
  if (enableFuzzy && bestScore < 14 && token.length >= 3) {
    for (const field of fields) {
      for (const ft of field.tokens) {
        const sim = fuzzyTokenSimilarity(token, ft)
        if (sim > 0) {
          consider(12 * sim * field.weight, `fuzzy:${field.name}`)
        }
      }
    }
  }

  // 3. Synonym expansion (single-word or multi-word synonyms)
  if (enableSynonyms && bestScore < 12) {
    const syns = getSynonymsFor(token)
    if (syns) {
      for (const syn of syns) {
        for (const field of fields) {
          if (field.phrase === syn) {
            consider(11.5 * field.weight, `synonym:${field.name}`)
          } else if (
            syn.includes(' ')
              ? ` ${field.phrase} `.includes(` ${syn} `)
              : field.tokens.includes(syn)
          ) {
            consider(9.5 * field.weight, `synonym:${field.name}`)
          }
        }
      }
    }
  }

  return { score: bestScore, reason: bestReason }
}

/**
 * Score and filter a list of ElementDescriptors using fuzzy matching, synonyms,
 * weighted fields, inline `role:` qualifiers, and ARIA role/type/tag filters.
 */
export function smartFindElements(
  elements: ElementDescriptor[],
  options: FindElementsOptions = {},
): FindElementsResult {
  const rawInput = String(options.query ?? '').trim()
  const { cleanQuery, inlineRoles } = extractInlineRoleQualifiers(rawInput)
  const roles = parseRoleFilters(options.role, options.roles, inlineRoles)
  const typeFilter = options.type ? String(options.type).trim().toLowerCase() : undefined
  const tagFilter = options.tag ? String(options.tag).trim().toLowerCase() : undefined
  const enabledOnly = Boolean(options.enabledOnly) || options.includeDisabled === false
  const enableFuzzy = options.fuzzy !== false
  const enableSynonyms = options.synonyms !== false
  const includeScore = options.includeScore !== false
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(100, Math.floor(options.limit)))
      : 15

  const appliedFilters: AppliedFindFilters = {}
  if (roles.length > 0) appliedFilters.roles = roles
  if (typeFilter) appliedFilters.type = typeFilter
  if (tagFilter) appliedFilters.tag = tagFilter
  if (enabledOnly) appliedFilters.enabledOnly = true
  const hasFilters = Object.keys(appliedFilters).length > 0

  // Step 1: Hard attribute/role filters
  const candidates = elements.filter((el) => {
    if (enabledOnly && el.disabled) return false
    if (tagFilter && (el.tag ?? '').trim().toLowerCase() !== tagFilter) return false
    if (typeFilter && (el.type ?? '').trim().toLowerCase() !== typeFilter) return false
    if (roles.length > 0 && !roles.some((r) => matchesRoleFilter(el, r))) return false
    return true
  })

  const queryTokens = tokenizeText(cleanQuery)
  const normalizedQuery = queryTokens.join(' ')

  // No query tokens: return filtered candidates in DOM order with base scores
  if (queryTokens.length === 0) {
    const minScore = typeof options.minScore === 'number' ? options.minScore : 0
    const matches: FindElementMatch[] = []
    for (const el of candidates) {
      const effectiveRole = resolveEffectiveRole(el)
      const score = el.disabled ? 0.5 : 1
      if (score < minScore) continue
      const { selector: _s, ...pub } = el
      const matchedBy: string[] = []
      if (roles.length > 0) matchedBy.push(`role:${effectiveRole || roles[0]}`)
      if (typeFilter) matchedBy.push(`type:${typeFilter}`)
      if (tagFilter) matchedBy.push(`tag:${tagFilter}`)
      matches.push(includeScore ? { ...pub, score, effectiveRole, matchedBy } : pub)
      if (matches.length >= limit) break
    }
    return {
      ok: true,
      query: cleanQuery,
      roles,
      count: matches.length,
      totalCandidates: candidates.length,
      matches,
      ...(hasFilters ? { filters: appliedFilters, appliedFilters } : {}),
    }
  }

  // Separate natural-language role-intent tokens from content tokens (e.g. "login button")
  const roleHints: string[] = []
  const contentTokens: string[] = []
  for (const tok of queryTokens) {
    const mappedRole = ROLE_INTENT_WORDS[tok]
    if (mappedRole) {
      if (!roleHints.includes(mappedRole)) roleHints.push(mappedRole)
    } else {
      contentTokens.push(tok)
    }
  }

  const effectiveContentTokens = contentTokens.length > 0 ? contentTokens : queryTokens
  const contentPhrase = effectiveContentTokens.join(' ')
  const wholeQuerySynonyms = enableSynonyms
    ? getSynonymsFor(contentPhrase) ?? getSynonymsFor(normalizedQuery)
    : undefined

  const minScore = typeof options.minScore === 'number' ? options.minScore : 0.01

  const scored: Array<{ match: FindElementMatch; score: number; index: number }> = []

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]!
    const effectiveRole = resolveEffectiveRole(el)
    const fields = buildSearchFields(el, effectiveRole)
    const reasons = new Set<string>()

    let score = 0
    let matchedContentCount = 0

    // A. Full-phrase bonuses on primary & secondary fields (take best across all fields)
    let phraseBestScore = 0
    let phraseBestReason: string | undefined
    for (const field of fields) {
      let candidate = 0
      let reason: string | undefined
      if (field.phrase === normalizedQuery) {
        candidate = (field.isPrimary ? 55 : 42) * field.weight
        reason = `exact:${field.name}`
      } else if (contentPhrase && contentPhrase !== normalizedQuery && field.phrase === contentPhrase) {
        candidate = (field.isPrimary ? 28 : 18) * field.weight
        reason = `exact:${field.name}`
      } else if (
        field.phrase.startsWith(normalizedQuery) ||
        (contentPhrase.length >= 2 && field.phrase.startsWith(contentPhrase))
      ) {
        candidate = (field.isPrimary ? 30 : 18) * field.weight
        reason = `prefix:${field.name}`
      } else if (contentPhrase.length >= 3 && field.phrase.includes(contentPhrase)) {
        candidate = (field.isPrimary ? 20 : 12) * field.weight
        reason = `phrase:${field.name}`
      }
      if (candidate > phraseBestScore && reason) {
        phraseBestScore = candidate
        phraseBestReason = reason
      }
    }
    const phraseMatched = phraseBestScore > 0
    if (phraseMatched && phraseBestReason) {
      score += phraseBestScore
      reasons.add(phraseBestReason)
    }

    // B. Whole-phrase synonym matching (e.g. "sign in" <-> "Login", "create account" <-> "Register")
    // Take the highest-scoring synonym/field combination rather than stopping at the first hit.
    let synBestScore = 0
    let synBestReason: string | undefined
    if (wholeQuerySynonyms && !phraseMatched) {
      for (const syn of wholeQuerySynonyms) {
        for (const field of fields) {
          const isExact = field.phrase === syn
          const hit =
            isExact ||
            (syn.includes(' ')
              ? ` ${field.phrase} `.includes(` ${syn} `)
              : field.tokens.includes(syn))
          if (hit) {
            const candidate = (isExact ? 24 : 16) * field.weight
            if (candidate > synBestScore) {
              synBestScore = candidate
              synBestReason = `synonym:${field.name}`
            }
          }
        }
      }
    }
    const wholePhraseSynonymMatched = synBestScore > 0
    if (wholePhraseSynonymMatched && synBestReason) {
      score += synBestScore
      reasons.add(synBestReason)
    }

    // C. Per-token scoring for all content tokens
    for (const token of effectiveContentTokens) {
      const tokRes = scoreTokenAgainstFields(token, fields, enableFuzzy, enableSynonyms)
      if (tokRes.score > 0) {
        score += tokRes.score
        matchedContentCount++
        if (tokRes.reason) reasons.add(tokRes.reason)
      }
    }

    // D. Role-intent scoring
    let roleIntentMatched = false
    if (roleHints.length > 0) {
      for (const hint of roleHints) {
        if (matchesRoleFilter(el, hint)) {
          roleIntentMatched = true
          reasons.add(`role:${hint}`)
          break
        }
      }
    }

    // Guard: when content tokens are present alongside a role hint (e.g. "login button"),
    // require at least one content match so unrelated buttons do not flood results.
    const hasContentMatch = phraseMatched || wholePhraseSynonymMatched || matchedContentCount > 0
    if (contentTokens.length > 0 && !hasContentMatch) {
      continue
    }

    if (roleIntentMatched) {
      score += contentTokens.length > 0 ? 14 : 22
    }

    // E. Full coverage bonus when every content token matched
    if (effectiveContentTokens.length > 1 && matchedContentCount === effectiveContentTokens.length) {
      score += 15
      reasons.add('all-tokens')
    }

    if (score < minScore) continue

    // F. Subtle deterministic tie-breakers
    if (!el.disabled) score += 0.5
    if (roles.length > 0 && roles.some((r) => matchesRoleFilter(el, r))) {
      reasons.add('filter:role')
    }

    const roundedScore = Math.round(score * 100) / 100
    const { selector: _s, ...pub } = el
    scored.push({
      index: i,
      score: roundedScore,
      match: includeScore
        ? {
            ...pub,
            score: roundedScore,
            effectiveRole,
            matchedBy: [...reasons],
          }
        : pub,
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })

  const matches = scored.slice(0, limit).map((s) => s.match)
  return {
    ok: true,
    query: cleanQuery,
    roles,
    count: matches.length,
    totalCandidates: candidates.length,
    matches,
    ...(hasFilters ? { filters: appliedFilters, appliedFilters } : {}),
  }
}

export const findElements = smartFindElements
