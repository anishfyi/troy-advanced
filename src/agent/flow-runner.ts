// Replayable macro/script runner (`troy-advanced run <flow.json>`)
// Executes declarative JSON browsing flows against a local BrowserManager
// or live Agent Socket daemon, evaluates deterministic assertions, supports
// variable interpolation (`{{var}}`) and dynamic `find` -> `eN` ref binding,
// and captures strict 7-bit ASCII failure dumps on any step or assertion failure.

import fs from 'node:fs'
import path from 'node:path'
import type { ActStep } from '../types.js'
import type { BrowserManager } from '../engine/manager.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import { extractRefusalInfo } from './audit.js'
import { SESSION_HEADER } from './sessions.js'

export type FlowOp =
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'grant'
  | 'click'
  | 'fill'
  | 'select'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'act'
  | 'read'
  | 'find'
  | 'extract'
  | 'eval'
  | 'tool'
  | 'assert'

export const VALID_FLOW_OPS: ReadonlySet<FlowOp> = new Set<FlowOp>([
  'open',
  'navigate',
  'back',
  'forward',
  'reload',
  'grant',
  'click',
  'fill',
  'select',
  'press',
  'scroll',
  'wait',
  'act',
  'read',
  'find',
  'extract',
  'eval',
  'tool',
  'assert',
])

export interface FlowAssertion {
  /** Optional description for assertion reporting */
  label?: string
  /** Exact current URL match */
  urlEquals?: string
  /** Substring match on current URL */
  urlContains?: string
  /** RegExp pattern match on current URL */
  urlMatches?: string
  /** Exact page title match */
  titleEquals?: string
  /** Substring match on page title */
  titleContains?: string
  /** RegExp pattern match on page title */
  titleMatches?: string
  /** Page body text must contain substring */
  textContains?: string
  /** Page body text must NOT contain substring */
  textNotContains?: string
  /** Page body text must match RegExp pattern */
  textMatches?: string
  /** Case-insensitive matching for textContains / textNotContains / titleContains */
  caseInsensitive?: boolean
  /** `page_find` query must match at least 1 interactive element (or minCount/maxCount/exactCount) */
  elementExists?: string
  /** `page_find` query must match 0 elements */
  elementNotExists?: string
  /** Minimum count for `elementExists` */
  minCount?: number
  /** Maximum count for `elementExists` */
  maxCount?: number
  /** Exact count for `elementExists` */
  exactCount?: number
  /** Specific `eN` ref must exist in current page snapshot */
  refExists?: string
  /** JS expression must evaluate equal to `expected` */
  evalEquals?: { expression: string; expected: unknown }
  /** JS expression must evaluate truthy */
  evalTruthy?: string
  /** Assert zero `error` console entries */
  consoleNoErrors?: boolean
  /** Check extracted section count (`tables`, `forms`, `links`, `headings`) */
  extractCount?: {
    section: 'tables' | 'forms' | 'links' | 'headings'
    min?: number
    max?: number
    equals?: number
  }
}

export interface FlowStep {
  /** Step operation */
  op: FlowOp
  /** Optional human-readable step label */
  name?: string
  /** Override flow-level stopOnFailure for this step */
  continueOnFailure?: boolean
  /** Save step output value into flow variables map (`{{varName}}`) */
  saveAs?: string
  /** Expect this step to be refused by deterministic safety policy */
  expectRefused?: boolean
  /** Expected refusal code when expectRefused is true (e.g. 'SUBMIT_BLOCKED') */
  refusedCode?: string
  /** Expect this step to return an error */
  expectError?: boolean
  /** Inline assertion(s) evaluated immediately after this step succeeds */
  assert?: FlowAssertion | FlowAssertion[]

  // Navigation & tab args
  url?: string
  origin?: string
  settle?: boolean

  // Interaction args
  ref?: string
  find?: string
  text?: string
  clear?: boolean
  value?: string
  key?: string
  allowSubmit?: boolean
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
  steps?: ActStep[]

  // Wait args
  ms?: number
  selector?: string
  state?: 'visible' | 'hidden' | 'attached'
  timeout?: number
  networkIdleMs?: number
  domQuietMs?: number

  // Read / Find / Extract / Eval / Tool args
  since?: boolean
  ascii?: boolean
  width?: number
  height?: number
  maxTokens?: number
  query?: string
  sections?: string[]
  maxItems?: number
  expression?: string
  tool?: string
  args?: Record<string, unknown>

  // Standalone `assert` step can inline FlowAssertion fields or list `assertions`
  assertions?: FlowAssertion[]
  assertion?: FlowAssertion
}

export interface FlowDefinition {
  name?: string
  description?: string
  baseUrl?: string
  vars?: Record<string, string | number | boolean>
  defaultTimeoutMs?: number
  stopOnFailure?: boolean
  dumpWidth?: number
  dumpHeight?: number
  steps: FlowStep[]
}

export interface FlowAssertionResult {
  kind: string
  label?: string
  passed: boolean
  expected?: unknown
  actual?: unknown
  message: string
}

export interface FlowFailureDump {
  stepIndex: number
  stepName: string
  url: string
  title: string
  reason: string
  ascii: string
  consoleErrors: string[]
  savedPath?: string
}

export interface FlowStepResult {
  index: number
  op: FlowOp
  name: string
  ok: boolean
  skipped?: boolean
  durationMs: number
  url?: string
  title?: string
  resolvedRef?: string
  savedVar?: { name: string; value: unknown }
  refused?: boolean
  refusedCode?: string
  error?: string
  assertions: FlowAssertionResult[]
  failureDump?: FlowFailureDump
}

export interface FlowRunReport {
  ok: boolean
  name: string
  description?: string
  startedAt: string
  finishedAt: string
  durationMs: number
  totalSteps: number
  passedSteps: number
  failedSteps: number
  skippedSteps: number
  totalAssertions: number
  passedAssertions: number
  failedAssertions: number
  finalUrl: string
  finalTitle: string
  vars: Record<string, unknown>
  steps: FlowStepResult[]
  failureDumps: FlowFailureDump[]
}

export interface FlowRunOptions {
  /** Override or extend flow.vars */
  vars?: Record<string, string | number | boolean>
  /** Override flow.baseUrl */
  baseUrl?: string
  /** Override flow.stopOnFailure */
  stopOnFailure?: boolean
  /** Directory to write ASCII failure dump files (optional) */
  dumpDir?: string
  /** Override ASCII failure dump width */
  dumpWidth?: number
  /** Override ASCII failure dump height */
  dumpHeight?: number
}

export interface FlowExecutor {
  /** Open a new tab or navigate the active tab */
  openOrNavigate(url: string, options?: { settle?: boolean }): Promise<Record<string, unknown>>
  /** Grant origin autonomy boundary */
  grantOrigin(origin: string): Promise<Record<string, unknown>>
  /** Call a named browser tool (page_click, page_fill, page_find, page_read, etc.) */
  callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Render current active tab as strict 7-bit ASCII */
  renderAscii(options?: { width?: number; height?: number }): Promise<{
    ascii: string
    url: string
    title: string
  }>
}

/**
 * Parse CLI `--var key=value` entries into a key/value map.
 */
export function parseVarOverrides(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of entries) {
    const idx = raw.indexOf('=')
    if (idx <= 0) {
      throw new Error(`Invalid --var "${raw}": expected key=value`)
    }
    const key = raw.slice(0, idx).trim()
    const value = raw.slice(idx + 1)
    if (!key) {
      throw new Error(`Invalid --var "${raw}": variable name cannot be empty`)
    }
    out[key] = value
  }
  return out
}

/**
 * Resolve a step URL against an optional flow `baseUrl`.
 */
export function resolveFlowUrl(rawUrl: string, baseUrl?: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed
  }
  if (baseUrl) {
    try {
      return new URL(trimmed, baseUrl).toString()
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/**
 * Recursively interpolate `{{varName}}` placeholders using `vars`.
 * If a string is purely `{{varName}}` and the variable exists, preserves its value as string;
 * unknown variables are left untouched so callers can spot typos clearly.
 */
export function interpolateString(input: string, vars: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined) {
      return String(vars[key])
    }
    return match
  })
}

export function interpolateValue<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    return interpolateString(value, vars) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, vars)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateValue(v, vars)
    }
    return out as T
  }
  return value
}

const ASSERTION_KEYS: ReadonlySet<string> = new Set([
  'label',
  'urlEquals',
  'urlContains',
  'urlMatches',
  'titleEquals',
  'titleContains',
  'titleMatches',
  'textContains',
  'textNotContains',
  'textMatches',
  'caseInsensitive',
  'elementExists',
  'elementNotExists',
  'minCount',
  'maxCount',
  'exactCount',
  'refExists',
  'evalEquals',
  'evalTruthy',
  'consoleNoErrors',
  'extractCount',
])

function extractInlineAssertionFromStep(raw: Record<string, unknown>): FlowAssertion | null {
  const assertion: Record<string, unknown> = {}
  let found = false
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'label') continue
    if (ASSERTION_KEYS.has(k) && v !== undefined) {
      assertion[k] = v
      found = true
    }
  }
  if (found && typeof raw.label === 'string') {
    assertion.label = raw.label
  }
  return found ? (assertion as FlowAssertion) : null
}

/**
 * Parse and validate a JSON flow definition string.
 */
export function parseFlowJson(rawJson: string): FlowDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`Invalid flow JSON: ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Flow JSON must be an object with a "steps" array')
  }

  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error('Flow JSON must contain a non-empty "steps" array')
  }

  const steps: FlowStep[] = obj.steps.map((rawStep, idx) => {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      throw new Error(`Flow step #${idx + 1} must be an object`)
    }
    const s = rawStep as Record<string, unknown>
    const rawOp = (typeof s.op === 'string' ? s.op : typeof s.action === 'string' ? s.action : '').trim()
    if (!rawOp) {
      throw new Error(`Flow step #${idx + 1} is missing required "op" field`)
    }
    if (!VALID_FLOW_OPS.has(rawOp as FlowOp)) {
      throw new Error(
        `Flow step #${idx + 1} has unsupported op "${rawOp}". Valid ops: ${[...VALID_FLOW_OPS].join(', ')}`,
      )
    }

    const op = rawOp as FlowOp
    if ((op === 'open' || op === 'navigate') && typeof s.url !== 'string') {
      throw new Error(`Flow step #${idx + 1} (${op}) requires a string "url"`)
    }
    if (op === 'grant' && typeof s.origin !== 'string') {
      throw new Error(`Flow step #${idx + 1} (grant) requires a string "origin"`)
    }
    if (op === 'click' && typeof s.ref !== 'string' && typeof s.find !== 'string') {
      throw new Error(`Flow step #${idx + 1} (click) requires "ref" or "find"`)
    }
    if (op === 'fill' && ((typeof s.ref !== 'string' && typeof s.find !== 'string') || typeof s.text !== 'string')) {
      throw new Error(`Flow step #${idx + 1} (fill) requires ("ref" or "find") and string "text"`)
    }
    if (op === 'select' && ((typeof s.ref !== 'string' && typeof s.find !== 'string') || typeof s.value !== 'string')) {
      throw new Error(`Flow step #${idx + 1} (select) requires ("ref" or "find") and string "value"`)
    }
    if (op === 'press' && typeof s.key !== 'string') {
      throw new Error(`Flow step #${idx + 1} (press) requires a string "key"`)
    }
    if (op === 'find' && typeof s.query !== 'string') {
      throw new Error(`Flow step #${idx + 1} (find) requires a string "query"`)
    }
    if (op === 'eval' && typeof s.expression !== 'string') {
      throw new Error(`Flow step #${idx + 1} (eval) requires a string "expression"`)
    }
    if (op === 'tool' && typeof s.tool !== 'string') {
      throw new Error(`Flow step #${idx + 1} (tool) requires a string "tool"`)
    }
    if (op === 'act' && !Array.isArray(s.steps)) {
      throw new Error(`Flow step #${idx + 1} (act) requires a "steps" array`)
    }

    const normalized: FlowStep = {
      ...(s as unknown as FlowStep),
      op,
    }

    if (op === 'assert') {
      const list: FlowAssertion[] = []
      if (Array.isArray(s.assertions)) {
        list.push(...(s.assertions as FlowAssertion[]))
      }
      if (s.assertion && typeof s.assertion === 'object') {
        list.push(s.assertion as FlowAssertion)
      }
      if (s.assert) {
        if (Array.isArray(s.assert)) list.push(...(s.assert as FlowAssertion[]))
        else if (typeof s.assert === 'object') list.push(s.assert as FlowAssertion)
      }
      const inline = extractInlineAssertionFromStep(s)
      if (inline) list.push(inline)
      if (list.length === 0) {
        throw new Error(`Flow step #${idx + 1} (assert) must specify at least one assertion`)
      }
      normalized.assertions = list
    }

    return normalized
  })

  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
    vars:
      obj.vars && typeof obj.vars === 'object' && !Array.isArray(obj.vars)
        ? (obj.vars as Record<string, string | number | boolean>)
        : undefined,
    defaultTimeoutMs: typeof obj.defaultTimeoutMs === 'number' ? obj.defaultTimeoutMs : undefined,
    stopOnFailure: typeof obj.stopOnFailure === 'boolean' ? obj.stopOnFailure : true,
    dumpWidth: typeof obj.dumpWidth === 'number' ? obj.dumpWidth : undefined,
    dumpHeight: typeof obj.dumpHeight === 'number' ? obj.dumpHeight : undefined,
    steps,
  }
}

/**
 * Create an in-process FlowExecutor backed by a BrowserManager.
 */
export function createManagerFlowExecutor(
  manager: BrowserManager,
  options: { tabId?: number; sessionId?: string } = {},
): FlowExecutor {
  let activeTabId = options.tabId
  const sessionId = options.sessionId
  const toolOpts = sessionId ? { sessionId } : {}

  return {
    async openOrNavigate(url, opts) {
      if (activeTabId === undefined) {
        const opened = await manager.openTab(url, {
          ownedByBridge: true,
          sessionId,
        })
        if (typeof opened.id === 'number') {
          activeTabId = opened.id
        }
        if (opts?.settle && opened.ok) {
          await manager.runTool(activeTabId, 'page_wait', { settle: true }, toolOpts)
        }
        return opened as unknown as Record<string, unknown>
      }
      const res = await manager.runTool(activeTabId, 'page_navigate', { url }, toolOpts)
      if (opts?.settle && res.ok !== false && !extractRefusalInfo(res)) {
        await manager.runTool(activeTabId, 'page_wait', { settle: true }, toolOpts)
      }
      return res
    },

    async grantOrigin(origin) {
      return manager.grantOrigin(origin, toolOpts) as unknown as Record<string, unknown>
    },

    async callTool(name, args = {}) {
      return manager.runTool(activeTabId, name, args, toolOpts)
    },

    async renderAscii(opts) {
      const rendered = await manager.renderAscii(activeTabId, {
        width: opts?.width ?? 88,
        height: opts?.height ?? 30,
        asciiOnly: true,
        ...(sessionId ? { sessionId } : {}),
      })
      return {
        ascii: sanitizeAscii(rendered.ascii ?? String(rendered.error ?? '(no ascii)')),
        url: rendered.snapshot?.url ?? '',
        title: rendered.snapshot?.title ?? '',
      }
    },
  }
}

/**
 * Create an HTTP FlowExecutor backed by a live `troy-advanced` Agent Socket daemon.
 */
export function createDaemonFlowExecutor(
  endpoint: { agentPort: number; agentToken: string; sessionId?: string },
  options: { tabId?: number } = {},
): FlowExecutor {
  let activeTabId = options.tabId

  async function post(route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-troy-agent': endpoint.agentToken,
    }
    if (endpoint.sessionId) {
      headers[SESSION_HEADER] = endpoint.sessionId
    }
    const res = await fetch(`http://127.0.0.1:${endpoint.agentPort}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return (await res.json()) as Record<string, unknown>
  }

  return {
    async openOrNavigate(url, opts) {
      if (activeTabId === undefined) {
        const opened = await post('/open', { url })
        if (typeof opened.id === 'number') {
          activeTabId = opened.id
        } else if (typeof opened.tabId === 'number') {
          activeTabId = opened.tabId
        }
        if (opts?.settle && opened.ok !== false && !extractRefusalInfo(opened)) {
          await post('/tool', { tabId: activeTabId, name: 'page_wait', args: { settle: true } })
        }
        return opened
      }
      const res = await post('/tool', {
        tabId: activeTabId,
        name: 'page_navigate',
        args: { url },
      })
      if (opts?.settle && res.ok !== false && !extractRefusalInfo(res)) {
        await post('/tool', { tabId: activeTabId, name: 'page_wait', args: { settle: true } })
      }
      return res
    },

    async grantOrigin(origin) {
      return post('/grant-origin', { origin, tabId: activeTabId })
    },

    async callTool(name, args = {}) {
      return post('/tool', { tabId: activeTabId, name, args })
    },

    async renderAscii(opts) {
      const res = await post('/ascii', {
        tabId: activeTabId,
        width: opts?.width ?? 88,
        height: opts?.height ?? 30,
        asciiOnly: true,
      })
      return {
        ascii: sanitizeAscii(typeof res.ascii === 'string' ? res.ascii : String(res.error ?? '(no ascii)')),
        url: typeof res.url === 'string' ? res.url : '',
        title: typeof res.title === 'string' ? res.title : '',
      }
    },
  }
}

function stepLabel(step: FlowStep, index: number): string {
  if (step.name) return step.name
  switch (step.op) {
    case 'open':
    case 'navigate':
      return `${step.op} ${step.url ?? ''}`.trim()
    case 'click':
      return `click ${step.ref ?? `find:${step.find}`}`
    case 'fill':
      return `fill ${step.ref ?? `find:${step.find}`}`
    case 'select':
      return `select ${step.ref ?? `find:${step.find}`}=${step.value ?? ''}`
    case 'press':
      return `press ${step.key ?? ''}`
    case 'find':
      return `find "${step.query ?? ''}"`
    case 'eval':
      return `eval ${(step.expression ?? '').slice(0, 32)}`
    case 'tool':
      return `tool ${step.tool ?? ''}`
    case 'assert':
      return `assert (${(step.assertions?.length ?? 1)} checks)`
    default:
      return `${step.op} #${index + 1}`
  }
}

function normalizeStr(s: string, caseInsensitive?: boolean): string {
  return caseInsensitive ? s.toLowerCase() : s
}

async function evaluateAssertions(
  assertions: FlowAssertion[],
  executor: FlowExecutor,
): Promise<{ results: FlowAssertionResult[]; url: string; title: string }> {
  const results: FlowAssertionResult[] = []

  // Lazily fetch page_read / page_text / page_console / page_extract only if needed
  let cachedRead: Record<string, unknown> | null = null
  let cachedText: string | null = null
  let cachedConsole: Record<string, unknown> | null = null
  let cachedExtract: Record<string, unknown> | null = null

  const getRead = async (): Promise<Record<string, unknown>> => {
    if (!cachedRead) {
      cachedRead = await executor.callTool('page_read', {})
    }
    return cachedRead
  }

  const getText = async (): Promise<string> => {
    if (cachedText === null) {
      const res = await executor.callTool('page_text', {})
      cachedText =
        typeof res.content === 'string'
          ? res.content
          : typeof res.text === 'string'
            ? res.text
            : ''
    }
    return cachedText
  }

  for (const a of assertions) {
    const ci = Boolean(a.caseInsensitive)

    if (a.urlEquals !== undefined) {
      const read = await getRead()
      const actual = String(read.url ?? '')
      const passed = actual === a.urlEquals
      results.push({
        kind: 'urlEquals',
        label: a.label,
        passed,
        expected: a.urlEquals,
        actual,
        message: passed
          ? `URL equals "${a.urlEquals}"`
          : `Expected URL "${a.urlEquals}", got "${actual}"`,
      })
    }

    if (a.urlContains !== undefined) {
      const read = await getRead()
      const actual = String(read.url ?? '')
      const passed = normalizeStr(actual, ci).includes(normalizeStr(a.urlContains, ci))
      results.push({
        kind: 'urlContains',
        label: a.label,
        passed,
        expected: a.urlContains,
        actual,
        message: passed
          ? `URL contains "${a.urlContains}"`
          : `Expected URL to contain "${a.urlContains}", got "${actual}"`,
      })
    }

    if (a.urlMatches !== undefined) {
      const read = await getRead()
      const actual = String(read.url ?? '')
      const re = new RegExp(a.urlMatches, ci ? 'i' : '')
      const passed = re.test(actual)
      results.push({
        kind: 'urlMatches',
        label: a.label,
        passed,
        expected: a.urlMatches,
        actual,
        message: passed
          ? `URL matches /${a.urlMatches}/`
          : `Expected URL to match /${a.urlMatches}/, got "${actual}"`,
      })
    }

    if (a.titleEquals !== undefined) {
      const read = await getRead()
      const actual = String(read.title ?? '')
      const passed = actual === a.titleEquals
      results.push({
        kind: 'titleEquals',
        label: a.label,
        passed,
        expected: a.titleEquals,
        actual,
        message: passed
          ? `Title equals "${a.titleEquals}"`
          : `Expected title "${a.titleEquals}", got "${actual}"`,
      })
    }

    if (a.titleContains !== undefined) {
      const read = await getRead()
      const actual = String(read.title ?? '')
      const passed = normalizeStr(actual, ci).includes(normalizeStr(a.titleContains, ci))
      results.push({
        kind: 'titleContains',
        label: a.label,
        passed,
        expected: a.titleContains,
        actual,
        message: passed
          ? `Title contains "${a.titleContains}"`
          : `Expected title to contain "${a.titleContains}", got "${actual}"`,
      })
    }

    if (a.titleMatches !== undefined) {
      const read = await getRead()
      const actual = String(read.title ?? '')
      const re = new RegExp(a.titleMatches, ci ? 'i' : '')
      const passed = re.test(actual)
      results.push({
        kind: 'titleMatches',
        label: a.label,
        passed,
        expected: a.titleMatches,
        actual,
        message: passed
          ? `Title matches /${a.titleMatches}/`
          : `Expected title to match /${a.titleMatches}/, got "${actual}"`,
      })
    }

    if (a.textContains !== undefined) {
      const text = await getText()
      const passed = normalizeStr(text, ci).includes(normalizeStr(a.textContains, ci))
      results.push({
        kind: 'textContains',
        label: a.label,
        passed,
        expected: a.textContains,
        actual: text.slice(0, 200),
        message: passed
          ? `Page text contains "${a.textContains}"`
          : `Expected page text to contain "${a.textContains}"`,
      })
    }

    if (a.textNotContains !== undefined) {
      const text = await getText()
      const passed = !normalizeStr(text, ci).includes(normalizeStr(a.textNotContains, ci))
      results.push({
        kind: 'textNotContains',
        label: a.label,
        passed,
        expected: `not "${a.textNotContains}"`,
        actual: passed ? '(absent)' : '(present)',
        message: passed
          ? `Page text does not contain "${a.textNotContains}"`
          : `Expected page text NOT to contain "${a.textNotContains}", but it was found`,
      })
    }

    if (a.textMatches !== undefined) {
      const text = await getText()
      const re = new RegExp(a.textMatches, ci ? 'is' : 's')
      const passed = re.test(text)
      results.push({
        kind: 'textMatches',
        label: a.label,
        passed,
        expected: a.textMatches,
        actual: text.slice(0, 200),
        message: passed
          ? `Page text matches /${a.textMatches}/`
          : `Expected page text to match /${a.textMatches}/`,
      })
    }

    if (a.elementExists !== undefined) {
      const found = await executor.callTool('page_find', { query: a.elementExists })
      const matches = Array.isArray(found.matches) ? found.matches : []
      const count = matches.length
      let passed = count > 0
      if (a.exactCount !== undefined) passed = count === a.exactCount
      else {
        if (a.minCount !== undefined && count < a.minCount) passed = false
        if (a.maxCount !== undefined && count > a.maxCount) passed = false
      }
      results.push({
        kind: 'elementExists',
        label: a.label,
        passed,
        expected:
          a.exactCount !== undefined
            ? `exact ${a.exactCount} match(es) for "${a.elementExists}"`
            : `>= ${a.minCount ?? 1} match(es) for "${a.elementExists}"`,
        actual: count,
        message: passed
          ? `Found ${count} element(s) matching "${a.elementExists}"`
          : `Element assertion failed for "${a.elementExists}": found ${count} match(es)`,
      })
    }

    if (a.elementNotExists !== undefined) {
      const found = await executor.callTool('page_find', { query: a.elementNotExists })
      const matches = Array.isArray(found.matches) ? found.matches : []
      const count = matches.length
      const passed = count === 0
      results.push({
        kind: 'elementNotExists',
        label: a.label,
        passed,
        expected: 0,
        actual: count,
        message: passed
          ? `No elements matching "${a.elementNotExists}"`
          : `Expected 0 elements matching "${a.elementNotExists}", found ${count}`,
      })
    }

    if (a.refExists !== undefined) {
      const read = await getRead()
      const elements = Array.isArray(read.elements) ? (read.elements as Array<{ ref?: string }>) : []
      const passed = elements.some((el) => el.ref === a.refExists)
      results.push({
        kind: 'refExists',
        label: a.label,
        passed,
        expected: a.refExists,
        actual: passed ? a.refExists : '(missing)',
        message: passed
          ? `Ref ${a.refExists} exists on page`
          : `Expected ref ${a.refExists} to exist in current snapshot`,
      })
    }

    if (a.evalEquals !== undefined) {
      const evalRes = await executor.callTool('page_eval', { expression: a.evalEquals.expression })
      const actual = evalRes.value
      const passed = !evalRes.error && JSON.stringify(actual) === JSON.stringify(a.evalEquals.expected)
      results.push({
        kind: 'evalEquals',
        label: a.label,
        passed,
        expected: a.evalEquals.expected,
        actual: evalRes.error ? `ERROR: ${evalRes.error}` : actual,
        message: passed
          ? `eval(${a.evalEquals.expression}) === ${JSON.stringify(a.evalEquals.expected)}`
          : `Expected eval(${a.evalEquals.expression}) to equal ${JSON.stringify(a.evalEquals.expected)}, got ${JSON.stringify(evalRes.error ?? actual)}`,
      })
    }

    if (a.evalTruthy !== undefined) {
      const evalRes = await executor.callTool('page_eval', { expression: a.evalTruthy })
      const passed = !evalRes.error && Boolean(evalRes.value)
      results.push({
        kind: 'evalTruthy',
        label: a.label,
        passed,
        expected: true,
        actual: evalRes.error ? `ERROR: ${evalRes.error}` : evalRes.value,
        message: passed
          ? `eval(${a.evalTruthy}) is truthy`
          : `Expected eval(${a.evalTruthy}) to be truthy, got ${JSON.stringify(evalRes.error ?? evalRes.value)}`,
      })
    }

    if (a.consoleNoErrors) {
      if (!cachedConsole) {
        cachedConsole = await executor.callTool('page_console', { level: 'error', limit: 20 })
      }
      const entries = Array.isArray(cachedConsole.entries) ? cachedConsole.entries : []
      const passed = entries.length === 0
      results.push({
        kind: 'consoleNoErrors',
        label: a.label,
        passed,
        expected: 0,
        actual: entries.length,
        message: passed
          ? 'No console errors recorded'
          : `Expected 0 console errors, found ${entries.length}`,
      })
    }

    if (a.extractCount !== undefined) {
      if (!cachedExtract) {
        cachedExtract = await executor.callTool('page_extract', {})
      }
      const sectionData = cachedExtract[a.extractCount.section]
      const count = Array.isArray(sectionData) ? sectionData.length : 0
      let passed = true
      if (a.extractCount.equals !== undefined) passed = count === a.extractCount.equals
      else {
        if (a.extractCount.min !== undefined && count < a.extractCount.min) passed = false
        if (a.extractCount.max !== undefined && count > a.extractCount.max) passed = false
      }
      results.push({
        kind: 'extractCount',
        label: a.label,
        passed,
        expected: a.extractCount,
        actual: count,
        message: passed
          ? `Extracted ${count} ${a.extractCount.section}`
          : `Expected ${a.extractCount.section} count ${JSON.stringify(a.extractCount)}, got ${count}`,
      })
    }
  }

  const read = cachedRead ?? (await getRead().catch(() => ({} as Record<string, unknown>)))
  return {
    results,
    url: typeof read.url === 'string' ? read.url : '',
    title: typeof read.title === 'string' ? read.title : '',
  }
}

async function captureFailureDump(
  executor: FlowExecutor,
  info: {
    stepIndex: number
    stepName: string
    reason: string
    width: number
    height: number
    dumpDir?: string
  },
): Promise<FlowFailureDump> {
  let ascii = '(failed to render ASCII dump)'
  let url = ''
  let title = ''
  const consoleErrors: string[] = []

  try {
    const rendered = await executor.renderAscii({ width: info.width, height: info.height })
    ascii = rendered.ascii
    url = rendered.url
    title = rendered.title
  } catch (err) {
    ascii = sanitizeAscii(`(ASCII dump unavailable: ${(err as Error).message})`)
  }

  try {
    const con = await executor.callTool('page_console', { level: 'error', limit: 10 })
    if (Array.isArray(con.entries)) {
      for (const entry of con.entries as Array<{ text?: string }>) {
        if (typeof entry?.text === 'string' && entry.text) {
          consoleErrors.push(sanitizeAscii(entry.text))
        }
      }
    }
  } catch {
    // ignore console errors during dump capture
  }

  const dump: FlowFailureDump = {
    stepIndex: info.stepIndex,
    stepName: info.stepName,
    url,
    title,
    reason: sanitizeAscii(info.reason),
    ascii: sanitizeAscii(ascii),
    consoleErrors,
  }

  if (info.dumpDir) {
    try {
      fs.mkdirSync(info.dumpDir, { recursive: true })
      const safeName = info.stepName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'step'
      const filename = `step-${String(info.stepIndex + 1).padStart(2, '0')}-${safeName}-failure.txt`
      const fullPath = path.join(info.dumpDir, filename)
      const content = [
        `=== TROY FLOW FAILURE DUMP ===`,
        `Step:   #${info.stepIndex + 1} (${sanitizeAscii(info.stepName)})`,
        `URL:    ${sanitizeAscii(url || '(none)')}`,
        `Title:  ${sanitizeAscii(title || '(none)')}`,
        `Reason: ${dump.reason}`,
        ...(consoleErrors.length > 0
          ? [`Console Errors:`, ...consoleErrors.map((e) => `  - ${e}`)]
          : []),
        ``,
        dump.ascii,
        ``,
      ].join('\n')
      fs.writeFileSync(fullPath, content, 'utf8')
      dump.savedPath = fullPath
    } catch {
      // do not mask original failure if dump file write fails
    }
  }

  return dump
}

async function resolveTargetRef(
  step: FlowStep,
  executor: FlowExecutor,
): Promise<{ ref?: string; error?: string }> {
  if (step.ref) return { ref: step.ref }
  if (!step.find) return { error: `Step "${step.op}" missing both "ref" and "find"` }
  const found = await executor.callTool('page_find', { query: step.find })
  if (found.error) return { error: String(found.error) }
  const matches = Array.isArray(found.matches) ? (found.matches as Array<{ ref?: string }>) : []
  if (matches.length === 0 || !matches[0]?.ref) {
    return { error: `No interactive element matched find query "${step.find}"` }
  }
  return { ref: matches[0].ref }
}

/**
 * Execute a parsed `FlowDefinition` step-by-step against the provided `FlowExecutor`.
 */
export async function runFlow(
  flow: FlowDefinition,
  executor: FlowExecutor,
  options: FlowRunOptions = {},
): Promise<FlowRunReport> {
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const vars: Record<string, unknown> = {
    ...(flow.vars ?? {}),
    ...(options.vars ?? {}),
  }
  const baseUrl = options.baseUrl ?? flow.baseUrl
  const stopOnFailure = options.stopOnFailure ?? flow.stopOnFailure ?? true
  const dumpWidth = options.dumpWidth ?? flow.dumpWidth ?? 88
  const dumpHeight = options.dumpHeight ?? flow.dumpHeight ?? 30

  const stepResults: FlowStepResult[] = []
  const failureDumps: FlowFailureDump[] = []
  let aborted = false
  let lastUrl = ''
  let lastTitle = ''

  for (let i = 0; i < flow.steps.length; i++) {
    const rawStep = flow.steps[i]!
    const step = interpolateValue(rawStep, vars)
    const label = stepLabel(step, i)

    if (aborted) {
      stepResults.push({
        index: i,
        op: step.op,
        name: label,
        ok: false,
        skipped: true,
        durationMs: 0,
        assertions: [],
      })
      continue
    }

    const stepStart = Date.now()
    let stepOk = true
    let stepError: string | undefined
    let refused = false
    let refusedCode: string | undefined
    let resolvedRef: string | undefined
    let savedVar: { name: string; value: unknown } | undefined
    let res: Record<string, unknown> = {}
    let stepAssertions: FlowAssertionResult[] = []

    try {
      switch (step.op) {
        case 'open':
        case 'navigate': {
          const targetUrl = resolveFlowUrl(step.url ?? '', baseUrl)
          res = await executor.openOrNavigate(targetUrl, { settle: step.settle })
          if (step.saveAs && typeof res.url === 'string') {
            vars[step.saveAs] = res.url
            savedVar = { name: step.saveAs, value: res.url }
          }
          break
        }

        case 'back':
        case 'forward':
        case 'reload':
          res = await executor.callTool('page_history', { direction: step.op })
          break

        case 'grant':
          res = await executor.grantOrigin(step.origin ?? '')
          break

        case 'click': {
          const target = await resolveTargetRef(step, executor)
          if (target.error || !target.ref) {
            stepOk = false
            stepError = target.error ?? 'Failed to resolve click target'
          } else {
            resolvedRef = target.ref
            res = await executor.callTool('page_click', {
              ref: target.ref,
              allowSubmit: Boolean(step.allowSubmit),
            })
          }
          break
        }

        case 'fill': {
          const target = await resolveTargetRef(step, executor)
          if (target.error || !target.ref) {
            stepOk = false
            stepError = target.error ?? 'Failed to resolve fill target'
          } else {
            resolvedRef = target.ref
            res = await executor.callTool('page_fill', {
              ref: target.ref,
              text: step.text ?? '',
              clear: step.clear !== undefined ? step.clear : true,
            })
          }
          break
        }

        case 'select': {
          const target = await resolveTargetRef(step, executor)
          if (target.error || !target.ref) {
            stepOk = false
            stepError = target.error ?? 'Failed to resolve select target'
          } else {
            resolvedRef = target.ref
            res = await executor.callTool('page_select', {
              ref: target.ref,
              value: step.value ?? '',
            })
          }
          break
        }

        case 'press': {
          if (step.ref || step.find) {
            const target = await resolveTargetRef(step, executor)
            if (target.error || !target.ref) {
              stepOk = false
              stepError = target.error ?? 'Failed to resolve press target'
              break
            }
            resolvedRef = target.ref
          }
          res = await executor.callTool('page_press', {
            key: step.key ?? 'Enter',
            ...(resolvedRef ? { ref: resolvedRef } : {}),
          })
          break
        }

        case 'scroll':
          res = await executor.callTool('page_scroll', {
            direction: step.direction ?? 'down',
            amount: step.amount ?? 450,
          })
          break

        case 'wait':
          res = await executor.callTool('page_wait', {
            ...(step.ms !== undefined ? { ms: step.ms } : {}),
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.selector !== undefined ? { selector: step.selector } : {}),
            ...(step.url !== undefined ? { url: step.url } : {}),
            ...(step.state !== undefined ? { state: step.state } : {}),
            ...(step.settle ? { settle: true } : {}),
            ...(step.networkIdleMs !== undefined ? { networkIdleMs: step.networkIdleMs } : {}),
            ...(step.domQuietMs !== undefined ? { domQuietMs: step.domQuietMs } : {}),
            ...(step.timeout !== undefined
              ? { timeout: step.timeout }
              : flow.defaultTimeoutMs !== undefined
                ? { timeout: flow.defaultTimeoutMs }
                : {}),
          })
          break

        case 'act':
          res = await executor.callTool('page_act', {
            steps: step.steps ?? [],
            allowSubmit: Boolean(step.allowSubmit),
          })
          break

        case 'read':
          res = await executor.callTool(step.ascii ? 'page_read_ascii' : 'page_read', {
            since: Boolean(step.since),
            ...(step.width !== undefined ? { width: step.width } : {}),
            ...(step.height !== undefined ? { height: step.height } : {}),
            ...(step.maxTokens !== undefined ? { maxTokens: step.maxTokens } : {}),
          })
          if (step.saveAs) {
            const val = step.ascii ? res.ascii : res.url
            vars[step.saveAs] = val
            savedVar = { name: step.saveAs, value: val }
          }
          break

        case 'find': {
          res = await executor.callTool('page_find', { query: step.query ?? '' })
          const matches = Array.isArray(res.matches) ? (res.matches as Array<{ ref?: string }>) : []
          if (matches[0]?.ref) {
            resolvedRef = matches[0].ref
            if (step.saveAs) {
              vars[step.saveAs] = matches[0].ref
              savedVar = { name: step.saveAs, value: matches[0].ref }
            }
          } else if (step.saveAs) {
            stepOk = false
            stepError = `find "${step.query}" matched 0 elements; cannot bind saveAs "${step.saveAs}"`
          }
          break
        }

        case 'extract':
          res = await executor.callTool('page_extract', {
            ...(step.sections ? { sections: step.sections } : {}),
            ...(step.maxItems !== undefined ? { maxItems: step.maxItems } : {}),
          })
          if (step.saveAs) {
            vars[step.saveAs] = res
            savedVar = { name: step.saveAs, value: res }
          }
          break

        case 'eval':
          res = await executor.callTool('page_eval', { expression: step.expression ?? '' })
          if (step.saveAs && !res.error) {
            vars[step.saveAs] = res.value
            savedVar = { name: step.saveAs, value: res.value }
          }
          break

        case 'tool':
          res = await executor.callTool(step.tool ?? '', step.args ?? {})
          if (step.saveAs) {
            vars[step.saveAs] = res
            savedVar = { name: step.saveAs, value: res }
          }
          break

        case 'assert': {
          const list = step.assertions ?? []
          const evaluated = await evaluateAssertions(list, executor)
          stepAssertions = evaluated.results
          if (evaluated.url) lastUrl = evaluated.url
          if (evaluated.title) lastTitle = evaluated.title
          const failed = stepAssertions.filter((a) => !a.passed)
          if (failed.length > 0) {
            stepOk = false
            stepError = failed.map((f) => f.message).join('; ')
          }
          break
        }
      }

      // Check tool refusal / error semantics for non-assert steps
      if (step.op !== 'assert' && stepOk) {
        const refusalInfo = extractRefusalInfo(res)
        refused = Boolean(refusalInfo || res.refused)
        if (refusalInfo?.code) refusedCode = refusalInfo.code
        else if (typeof res.code === 'string') refusedCode = res.code
        const hasError = Boolean(res.error) || res.ok === false

        if (step.expectRefused) {
          if (!refused) {
            stepOk = false
            stepError = `Expected step to be refused${step.refusedCode ? ` (${step.refusedCode})` : ''}, but it succeeded`
          } else if (step.refusedCode && refusedCode !== step.refusedCode) {
            stepOk = false
            stepError = `Expected refusal code "${step.refusedCode}", got "${refusedCode ?? '(none)'}"`
          }
        } else if (step.expectError) {
          if (!hasError) {
            stepOk = false
            stepError = 'Expected step to return an error, but it succeeded'
          }
        } else {
          if (refused) {
            stepOk = false
            stepError = `Refused (${refusedCode ?? 'POLICY'}): ${String(refusalInfo?.reason ?? res.reason ?? res.error ?? 'blocked by policy')}`
          } else if (hasError) {
            stepOk = false
            stepError = String(res.error ?? 'Step failed')
          }
        }
      }

      if (typeof res.url === 'string' && res.url) lastUrl = res.url
      if (typeof res.title === 'string' && res.title) lastTitle = res.title

      // Run inline `step.assert` assertions when the step action succeeded
      if (step.op !== 'assert' && stepOk && step.assert) {
        const inlineList = Array.isArray(step.assert) ? step.assert : [step.assert]
        const evaluated = await evaluateAssertions(inlineList, executor)
        stepAssertions = evaluated.results
        if (evaluated.url) lastUrl = evaluated.url
        if (evaluated.title) lastTitle = evaluated.title
        const failed = stepAssertions.filter((a) => !a.passed)
        if (failed.length > 0) {
          stepOk = false
          stepError = failed.map((f) => f.message).join('; ')
        }
      }
    } catch (err) {
      stepOk = false
      stepError = (err as Error).message
    }

    let failureDump: FlowFailureDump | undefined
    if (!stepOk) {
      failureDump = await captureFailureDump(executor, {
        stepIndex: i,
        stepName: label,
        reason: stepError ?? 'Step failed',
        width: dumpWidth,
        height: dumpHeight,
        dumpDir: options.dumpDir,
      })
      if (failureDump.url) lastUrl = failureDump.url
      if (failureDump.title) lastTitle = failureDump.title
      failureDumps.push(failureDump)

      const shouldStop = step.continueOnFailure === true ? false : stopOnFailure
      if (shouldStop) aborted = true
    }

    stepResults.push({
      index: i,
      op: step.op,
      name: label,
      ok: stepOk,
      durationMs: Date.now() - stepStart,
      url: lastUrl || undefined,
      title: lastTitle || undefined,
      resolvedRef,
      savedVar,
      refused: refused || undefined,
      refusedCode,
      error: stepError,
      assertions: stepAssertions,
      failureDump,
    })
  }

  const passedSteps = stepResults.filter((s) => s.ok).length
  const skippedSteps = stepResults.filter((s) => s.skipped).length
  const failedSteps = stepResults.filter((s) => !s.ok && !s.skipped).length

  let totalAssertions = 0
  let passedAssertions = 0
  let failedAssertions = 0
  for (const s of stepResults) {
    for (const a of s.assertions) {
      totalAssertions++
      if (a.passed) passedAssertions++
      else failedAssertions++
    }
  }

  return {
    ok: failedSteps === 0,
    name: flow.name ?? 'unnamed-flow',
    description: flow.description,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    totalSteps: flow.steps.length,
    passedSteps,
    failedSteps,
    skippedSteps,
    totalAssertions,
    passedAssertions,
    failedAssertions,
    finalUrl: lastUrl,
    finalTitle: lastTitle,
    vars,
    steps: stepResults,
    failureDumps,
  }
}

/**
 * Format a `FlowRunReport` as strict 7-bit ASCII, including full ASCII failure dumps
 * whenever any step or assertion fails.
 */
export function formatFlowReportAscii(
  report: FlowRunReport,
  options: { width?: number; includeDumps?: boolean } = {},
): string {
  const width = Math.max(48, Math.min(140, options.width ?? 88))
  const includeDumps = options.includeDumps !== false
  const hr = '+' + '-'.repeat(width - 2) + '+'
  const statusTag = report.ok ? 'PASS' : 'FAIL'

  const lines: string[] = [
    hr,
    `| FLOW [${statusTag}] ${sanitizeAscii(report.name)}`.padEnd(width - 1).slice(0, width - 1) + '|',
    hr,
    `Steps:      ${report.passedSteps}/${report.totalSteps} passed, ${report.failedSteps} failed, ${report.skippedSteps} skipped`,
    `Assertions: ${report.passedAssertions}/${report.totalAssertions} passed, ${report.failedAssertions} failed`,
    `Duration:   ${report.durationMs}ms`,
    `Final URL:  ${sanitizeAscii(report.finalUrl || '(none)')}`,
    '',
  ]

  for (const step of report.steps) {
    const tag = step.skipped ? 'SKIP' : step.ok ? 'PASS' : 'FAIL'
    const num = String(step.index + 1).padStart(2, '0')
    const refPart = step.resolvedRef ? ` [${step.resolvedRef}]` : ''
    const savePart = step.savedVar ? ` -> $${step.savedVar.name}` : ''
    lines.push(
      `[${tag}] #${num} ${sanitizeAscii(step.name)}${refPart}${savePart} (${step.durationMs}ms)`,
    )
    if (step.error) {
      lines.push(`       error: ${sanitizeAscii(step.error)}`)
    }
    for (const a of step.assertions) {
      const atag = a.passed ? 'ok' : 'FAIL'
      const lbl = a.label ? `${sanitizeAscii(a.label)}: ` : ''
      lines.push(`       assert [${atag}] ${lbl}${sanitizeAscii(a.message)}`)
    }
  }

  if (includeDumps && report.failureDumps.length > 0) {
    lines.push('')
    for (const dump of report.failureDumps) {
      lines.push(hr)
      lines.push(
        `| ASCII FAILURE DUMP: step #${dump.stepIndex + 1} (${sanitizeAscii(dump.stepName)})`
          .padEnd(width - 1)
          .slice(0, width - 1) + '|',
      )
      lines.push(hr)
      lines.push(`URL:    ${sanitizeAscii(dump.url || '(none)')}`)
      lines.push(`Title:  ${sanitizeAscii(dump.title || '(none)')}`)
      lines.push(`Reason: ${sanitizeAscii(dump.reason)}`)
      if (dump.savedPath) {
        lines.push(`Saved:  ${sanitizeAscii(dump.savedPath)}`)
      }
      if (dump.consoleErrors.length > 0) {
        lines.push(`Console Errors (${dump.consoleErrors.length}):`)
        for (const err of dump.consoleErrors) {
          lines.push(`  - ${sanitizeAscii(err)}`)
        }
      }
      lines.push('')
      lines.push(sanitizeAscii(dump.ascii))
      lines.push('')
    }
  }

  return sanitizeAscii(lines.join('\n'))
}
