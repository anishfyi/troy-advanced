import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentLoopGuard,
  BrowserManager,
  buildRecoveryHints,
  canonicalizeArgs,
  classifyFailureCategory,
  createAgentSocket,
  formatLoopGuardAscii,
  normalizeErrorFingerprint,
  type AgentSocketServer,
  type LoopGuardReport,
} from '../src/index.js'

describe('AgentLoopGuard unit tests (M69)', () => {
  it('canonicalizes args deterministically regardless of key order and ignores ephemeral formatting keys', () => {
    const a = canonicalizeArgs({ ref: 'e4', text: 'hello', width: 80, asciiOnly: true })
    const b = canonicalizeArgs({ text: 'hello', ref: 'e4', width: 120, color: true })
    expect(a).toBe(b)
  })

  it('normalizes volatile durations in error messages to the same fingerprint', () => {
    const f1 = normalizeErrorFingerprint('timeout', 'Timed out waiting for selector ".spinner" after 1500ms')
    const f2 = normalizeErrorFingerprint('timeout', 'Timed out waiting for selector ".spinner" after 2450ms')
    expect(f1).toBe(f2)
  })

  it('detects repeated identical failures in advisory mode and escalates warning -> critical', () => {
    const guard = new AgentLoopGuard({ warnThreshold: 2, blockThreshold: 4, mode: 'advisory' })
    const base = {
      tool: 'page_click',
      args: { ref: 'e99' },
      tabId: 1,
      url: 'http://example.test/app',
      epoch: 1,
      error: 'unknown ref e99',
    }

    const r1 = guard.recordFailure({ ...base, nowMs: 1000 })
    expect(r1).toBeNull()

    const r2 = guard.recordFailure({ ...base, nowMs: 2000 })
    expect(r2).not.toBeNull()
    expect(r2?.detected).toBe(true)
    expect(r2?.blocked).toBe(false)
    expect(r2?.severity).toBe('warning')
    expect(r2?.repeatCount).toBe(2)
    expect(r2?.category).toBe('stale_or_unknown_ref')
    expect(r2?.suggestedAction?.tool).toBe('page_read_ascii')
    expect(r2?.recoveryHints.length).toBeGreaterThanOrEqual(2)

    const r3 = guard.recordFailure({ ...base, nowMs: 3000 })
    expect(r3?.severity).toBe('warning')
    expect(r3?.repeatCount).toBe(3)

    const r4 = guard.recordFailure({ ...base, nowMs: 4000 })
    expect(r4?.severity).toBe('critical')
    expect(r4?.repeatCount).toBe(4)
  })

  it('preserves failure streaks across read-only observations on the same URL+epoch, but resets on mutating success or URL/epoch change', () => {
    const guard = new AgentLoopGuard({ warnThreshold: 2, blockThreshold: 4 })
    const failCtx = {
      tool: 'page_click',
      args: { ref: 'e42' },
      tabId: 1,
      url: 'http://example.test/form',
      epoch: 1,
      error: 'unknown ref e42',
    }

    expect(guard.recordFailure({ ...failCtx, nowMs: 1000 })).toBeNull()

    // Classic A -> read -> A loop: read-only success on same URL+epoch must NOT erase streak
    guard.recordSuccess({
      tool: 'page_read_ascii',
      tabId: 1,
      url: 'http://example.test/form',
      epoch: 1,
      nowMs: 1500,
    })

    const r2 = guard.recordFailure({ ...failCtx, nowMs: 2000 })
    expect(r2?.detected).toBe(true)
    expect(r2?.repeatCount).toBe(2)

    // Mutating success resets the streak
    guard.recordSuccess({
      tool: 'page_fill',
      args: { ref: 'e2', text: 'ok' },
      tabId: 1,
      url: 'http://example.test/form',
      epoch: 1,
      nowMs: 2500,
    })

    expect(guard.recordFailure({ ...failCtx, nowMs: 3000 })).toBeNull()

    // URL change also resets the streak
    const rAfterUrl = guard.recordFailure({ ...failCtx, url: 'http://example.test/other', nowMs: 3500 })
    expect(rAfterUrl).toBeNull()
  })

  it('short-circuits repeated failing actions in block mode once blockThreshold is reached', () => {
    const guard = new AgentLoopGuard({ mode: 'block', warnThreshold: 2, blockThreshold: 3 })
    const ctx = {
      tool: 'page_click',
      args: { ref: 'e5' },
      tabId: 2,
      url: 'http://example.test/checkout',
      epoch: 1,
      code: 'submit',
      error: 'clicking "Place Order" looks like a commit/submit action; pass allowSubmit: true to confirm',
    }

    expect(guard.checkBeforeExecution({ ...ctx, nowMs: 1000 })).toBeNull()
    expect(guard.recordFailure({ ...ctx, nowMs: 1000 })).toBeNull()

    expect(guard.checkBeforeExecution({ ...ctx, nowMs: 2000 })).toBeNull()
    const r2 = guard.recordFailure({ ...ctx, nowMs: 2000 })
    expect(r2?.severity).toBe('warning')
    expect(r2?.repeatCount).toBe(2)

    // 3rd attempt is blocked BEFORE execution
    const blocked = guard.checkBeforeExecution({ ...ctx, nowMs: 3000 })
    expect(blocked).not.toBeNull()
    expect(blocked?.blocked).toBe(true)
    expect(blocked?.severity).toBe('critical')
    expect(blocked?.repeatCount).toBe(3)
    expect(blocked?.category).toBe('submit_guard')
    expect(blocked?.suggestedAction?.args?.allowSubmit).toBe(true)

    const stats = guard.getStats()
    expect(stats.actionsBlocked).toBe(1)
    expect(stats.criticalDetected).toBe(1)
  })

  it('isolates failure streaks per session and per tab, and expires streaks outside windowMs', () => {
    const guard = new AgentLoopGuard({ warnThreshold: 2, windowMs: 5000 })

    expect(
      guard.recordFailure({
        tool: 'page_click',
        args: { ref: 'e9' },
        sessionId: 'agent-a',
        tabId: 1,
        error: 'unknown ref e9',
        nowMs: 1000,
      }),
    ).toBeNull()

    // Different session does not trigger warning
    expect(
      guard.recordFailure({
        tool: 'page_click',
        args: { ref: 'e9' },
        sessionId: 'agent-b',
        tabId: 1,
        error: 'unknown ref e9',
        nowMs: 1500,
      }),
    ).toBeNull()

    // Same session after windowMs expired starts fresh
    expect(
      guard.recordFailure({
        tool: 'page_click',
        args: { ref: 'e9' },
        sessionId: 'agent-a',
        tabId: 1,
        error: 'unknown ref e9',
        nowMs: 10_000,
      }),
    ).toBeNull()
  })

  it('classifies all refusal/error categories and generates tailored recovery hints + ASCII report', () => {
    expect(classifyFailureCategory({ tool: 'page_navigate', code: 'origin', error: 'outside origin' })).toBe(
      'origin_boundary',
    )
    expect(classifyFailureCategory({ tool: 'page_click', code: 'submit', error: 'commit' })).toBe('submit_guard')
    expect(classifyFailureCategory({ tool: 'page_fill', code: 'sensitive', error: 'password' })).toBe('sensitive_field')
    expect(classifyFailureCategory({ tool: 'page_navigate', code: 'scheme', error: 'javascript:' })).toBe(
      'blocked_scheme',
    )
    expect(classifyFailureCategory({ tool: 'page_read', code: 'session_isolation', error: 'owned by another' })).toBe(
      'session_isolation',
    )
    expect(classifyFailureCategory({ tool: 'page_wait', error: 'Timed out after 1000ms' })).toBe('wait_timeout')
    expect(classifyFailureCategory({ tool: 'page_click', code: 'no-tab', error: 'no open tab' })).toBe('no_tab')
    expect(classifyFailureCategory({ tool: 'page_magic', error: 'unknown tool: page_magic' })).toBe('unknown_tool')

    const originHint = buildRecoveryHints({
      category: 'origin_boundary',
      tool: 'page_navigate',
      args: { url: 'https://other.example/path' },
      origin: 'https://other.example',
      repeatCount: 2,
    })
    expect(originHint.suggestedAction?.endpoint).toBe('/grant-origin')
    expect(originHint.suggestedAction?.args?.origin).toBe('https://other.example')

    const sensitiveHint = buildRecoveryHints({
      category: 'sensitive_field',
      tool: 'page_fill',
      args: { ref: 'e2', text: 'secret' },
      repeatCount: 2,
    })
    expect(sensitiveHint.suggestedAction?.action).toBe('ask_user')

    const guard = new AgentLoopGuard()
    const ascii = formatLoopGuardAscii(guard.getStats(), guard.getActivePatterns())
    expect(ascii).toContain('Agent Loop Guard')
    expect(ascii).toContain('ENABLED')
    expect(ascii).toMatch(/^[\x20-\x7e\n]+$/)
  })
})

describe('AgentLoopGuard E2E integration with BrowserManager & Agent Socket (M69)', () => {
  let siteServer: http.Server
  let siteBaseUrl = ''
  let otherSiteServer: http.Server
  let otherSiteBaseUrl = ''
  let tmpProfileDir = ''
  let manager: BrowserManager
  let socket: AgentSocketServer

  async function post(pathname: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${socket.port}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-troy-agent': socket.token,
        ...headers,
      },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  beforeAll(async () => {
    tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-loop-guard-'))

    siteServer = http.createServer((req, res) => {
      if (req.url === '/submitted') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Order Confirmed</h1><p>Done</p></body></html>')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <html>
          <head><title>Loop Guard Test Page</title></head>
          <body>
            <h1>Checkout</h1>
            <form action="/submitted" method="GET">
              <label for="email">Email</label>
              <input id="email" name="email" type="text" value="" />
              <label for="pwd">Password</label>
              <input id="pwd" name="password" type="password" value="" />
              <button type="submit">Place Order</button>
            </form>
          </body>
        </html>
      `)
    })
    await new Promise<void>((resolve) => siteServer.listen(0, '127.0.0.1', resolve))
    const siteAddr = siteServer.address() as { port: number }
    siteBaseUrl = `http://127.0.0.1:${siteAddr.port}`

    otherSiteServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>External Origin</h1></body></html>')
    })
    await new Promise<void>((resolve) => otherSiteServer.listen(0, '127.0.0.1', resolve))
    const otherAddr = otherSiteServer.address() as { port: number }
    otherSiteBaseUrl = `http://127.0.0.1:${otherAddr.port}`

    manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: tmpProfileDir,
      memoryEnabled: false,
    })
    socket = await createAgentSocket(manager, { port: 0 })
  })

  afterAll(async () => {
    await socket.close()
    await manager.close()
    await new Promise<void>((resolve) => siteServer.close(() => resolve()))
    await new Promise<void>((resolve) => otherSiteServer.close(() => resolve()))
    fs.rmSync(tmpProfileDir, { recursive: true, force: true })
  })

  it('detects repeated unknown-ref clicks across interleaved page_read_ascii calls and suggests refreshing refs', async () => {
    const opened = await post('/open', { url: siteBaseUrl, activate: true })
    expect(opened.json.ok).toBe(true)
    const tabId = opened.json.id as number

    // Populate initial snapshot
    const read1 = await post('/tool', { tabId, name: 'page_read_ascii', args: {} })
    expect(read1.json.ok).toBe(true)

    // 1st failed click on unknown ref -> no loopGuard yet
    const fail1 = await post('/tool', { tabId, name: 'page_click', args: { ref: 'e999' } })
    expect(fail1.json.ok).toBe(false)
    expect(fail1.json.loopGuard).toBeUndefined()

    // Interleaved read-only observation
    const read2 = await post('/tool', { tabId, name: 'page_read_ascii', args: {} })
    expect(read2.json.ok).toBe(true)

    // 2nd identical failed click -> loopGuard warning with recovery hint
    const fail2 = await post('/tool', { tabId, name: 'page_click', args: { ref: 'e999' } })
    expect(fail2.json.ok).toBe(false)
    const lg = fail2.json.loopGuard as LoopGuardReport
    expect(lg).toBeDefined()
    expect(lg.detected).toBe(true)
    expect(lg.severity).toBe('warning')
    expect(lg.repeatCount).toBe(2)
    expect(lg.category).toBe('stale_or_unknown_ref')
    expect(lg.suggestedAction?.tool).toBe('page_read_ascii')
  })

  it('guides the agent out of repeated submit-guard refusals and resets once allowSubmit succeeds', async () => {
    const opened = await post('/open', { url: siteBaseUrl, activate: true })
    const tabId = opened.json.id as number
    await post('/tool', { tabId, name: 'page_read_ascii', args: {} })

    const found = await post('/tool', { tabId, name: 'page_find', args: { query: 'Place Order', role: 'button' } })
    const matches = (found.json.matches as Array<{ ref: string }>) ?? []
    expect(matches.length).toBeGreaterThan(0)
    const submitRef = matches[0].ref

    // 1st click without allowSubmit -> boundary refusal
    const c1 = await post('/tool', { tabId, name: 'page_click', args: { ref: submitRef } })
    expect(c1.json.ok).toBe(false)
    expect(c1.json.code).toBe('submit')
    expect(c1.json.loopGuard).toBeUndefined()

    // 2nd identical click -> loopGuard suggests allowSubmit: true
    const c2 = await post('/tool', { tabId, name: 'page_click', args: { ref: submitRef } })
    expect(c2.json.ok).toBe(false)
    expect(c2.json.code).toBe('submit')
    const lg = c2.json.loopGuard as LoopGuardReport
    expect(lg?.detected).toBe(true)
    expect(lg?.category).toBe('submit_guard')
    expect(lg?.suggestedAction?.args?.allowSubmit).toBe(true)

    // Follow recovery hint -> succeeds
    const c3 = await post('/tool', { tabId, name: 'page_click', args: { ref: submitRef, allowSubmit: true } })
    expect(c3.json.ok).toBe(true)
  })

  it('detects repeated origin-boundary refusals and clears the streak when /grant-origin is called', async () => {
    const opened = await post('/open', { url: siteBaseUrl, activate: true })
    const tabId = opened.json.id as number

    const n1 = await post('/tool', { tabId, name: 'page_navigate', args: { url: otherSiteBaseUrl } })
    expect(n1.json.ok).toBe(false)
    expect(n1.json.code).toBe('origin')
    expect(n1.json.loopGuard).toBeUndefined()

    const n2 = await post('/tool', { tabId, name: 'page_navigate', args: { url: otherSiteBaseUrl } })
    expect(n2.json.ok).toBe(false)
    expect(n2.json.code).toBe('origin')
    const lg = n2.json.loopGuard as LoopGuardReport
    expect(lg?.detected).toBe(true)
    expect(lg?.category).toBe('origin_boundary')
    expect(lg?.suggestedAction?.endpoint).toBe('/grant-origin')
    expect(lg?.suggestedAction?.args?.origin).toBe(otherSiteBaseUrl)

    // Grant origin -> retries cleanly and navigates
    const grant = await post('/grant-origin', { origin: otherSiteBaseUrl })
    expect(grant.json.ok).toBe(true)

    const n3 = await post('/tool', { tabId, name: 'page_navigate', args: { url: otherSiteBaseUrl } })
    expect(n3.json.ok).toBe(true)
  })

  it('propagates inner step loopGuard on page_act and supports block mode + /loop-guard + /health inspection', async () => {
    const opened = await post('/open', { url: siteBaseUrl, activate: true })
    const tabId = opened.json.id as number
    await post('/tool', { tabId, name: 'page_read_ascii', args: {} })

    // Switch to block mode with blockThreshold: 3
    const cfgRes = await post('/loop-guard', { mode: 'block', warnThreshold: 2, blockThreshold: 3 })
    expect(cfgRes.json.ok).toBe(true)
    expect((cfgRes.json.config as { mode: string }).mode).toBe('block')

    const events: Array<Record<string, unknown>> = []
    const unsub = manager.onEvent((ev) => {
      if (ev.type === 'loop_detected') events.push(ev)
    })

    try {
      const a1 = await post('/tool', {
        tabId,
        name: 'page_act',
        args: { steps: [{ op: 'click', ref: 'e888' }] },
      })
      expect(a1.json.ok).toBe(false)
      expect(a1.json.loopGuard).toBeUndefined()

      const a2 = await post('/tool', {
        tabId,
        name: 'page_act',
        args: { steps: [{ op: 'click', ref: 'e888' }] },
      })
      expect(a2.json.ok).toBe(false)
      const lg2 = a2.json.loopGuard as LoopGuardReport
      expect(lg2?.detected).toBe(true)
      expect(lg2?.blocked).toBe(false)
      expect(lg2?.repeatCount).toBe(2)

      // 3rd attempt is blocked directly by loop_guard
      const a3 = await post('/tool', {
        tabId,
        name: 'page_act',
        args: { steps: [{ op: 'click', ref: 'e888' }] },
      })
      expect(a3.json.ok).toBe(false)
      expect(a3.json.code).toBe('loop_guard')
      expect(a3.json.status).toBe('blocked')
      const lg3 = a3.json.loopGuard as LoopGuardReport
      expect(lg3?.blocked).toBe(true)
      expect(lg3?.severity).toBe('critical')
      expect(lg3?.repeatCount).toBe(3)

      expect(events.some((e) => e.blocked === true)).toBe(true)

      // Verify /health and /loop-guard report stats + ASCII
      const health = await post('/health', {})
      expect(health.json.ok).toBe(true)
      expect((health.json.loopGuard as { actionsBlocked: number }).actionsBlocked).toBeGreaterThanOrEqual(1)

      const lgInfo = await post('/loop-guard', {})
      expect(lgInfo.json.ok).toBe(true)
      expect(typeof lgInfo.json.ascii).toBe('string')
      expect(String(lgInfo.json.ascii)).toContain('Agent Loop Guard')

      // Reset loop guard clears active patterns
      const resetRes = await post('/loop-guard', { reset: true, tabId })
      expect(resetRes.json.ok).toBe(true)
      expect((resetRes.json.cleared as number) >= 1).toBe(true)
    } finally {
      unsub()
      await post('/loop-guard', { mode: 'advisory', warnThreshold: 2, blockThreshold: 4 })
    }
  })
})
