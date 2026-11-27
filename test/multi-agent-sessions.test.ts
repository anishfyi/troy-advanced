import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  createAgentSocket,
  formatSessionsAscii,
  parseSessionId,
  SESSION_HEADER,
  SessionRegistry,
} from '../src/index.js'

function startSite(name: string, getOtherOrigin: () => string) {
  let server: http.Server
  return new Promise<{ url: string; origin: string; close: () => Promise<void> }>((resolve) => {
    server = http.createServer((req, res) => {
      const other = getOtherOrigin()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/page2') {
        res.end(`<html><head><title>${name} Page 2</title></head><body><h1>${name} Second</h1><p>Content on ${name} page 2</p></body></html>`)
        return
      }
      res.end(`<html>
        <head><title>${name} Home</title></head>
        <body>
          <h1>Welcome to ${name}</h1>
          <a id="local-link" href="/page2">Go to ${name} page 2</a>
          ${other ? `<a id="cross-link" href="${other}/">Go to other origin</a>` : ''}
        </body>
      </html>`)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const origin = `http://127.0.0.1:${port}`
      resolve({
        url: `${origin}/`,
        origin,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

async function socketPost(
  port: number,
  token: string,
  route: string,
  body: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-troy-agent': token,
  }
  if (sessionId !== undefined) {
    headers[SESSION_HEADER] = sessionId
  }
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as Record<string, unknown>
  return { status: res.status, data }
}

async function socketGet(
  port: number,
  token: string,
  route: string,
  sessionId?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'x-troy-agent': token,
  }
  if (sessionId !== undefined) {
    headers[SESSION_HEADER] = sessionId
  }
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'GET',
    headers,
  })
  const data = (await res.json()) as Record<string, unknown>
  return { status: res.status, data }
}

describe('parseSessionId & SessionRegistry (unit)', () => {
  it('validates and normalizes session IDs', () => {
    expect(parseSessionId(undefined)).toEqual({ ok: true, sessionId: undefined })
    expect(parseSessionId('')).toEqual({ ok: true, sessionId: undefined })
    expect(parseSessionId('   ')).toEqual({ ok: true, sessionId: undefined })
    expect(parseSessionId('planner')).toEqual({ ok: true, sessionId: 'planner' })
    expect(parseSessionId('  agent-1_run:2/a.b  ')).toEqual({ ok: true, sessionId: 'agent-1_run:2/a.b' })
    expect(parseSessionId(['worker-1'])).toEqual({ ok: true, sessionId: 'worker-1' })

    expect(parseSessionId('bad session').ok).toBe(false)
    expect(parseSessionId('-leading-dash').ok).toBe(false)
    expect(parseSessionId('a'.repeat(65)).ok).toBe(false)
    expect(parseSessionId(['a', 'b']).ok).toBe(false)
    expect(parseSessionId(123).ok).toBe(false)
  })

  it('tracks per-session owned tabs, active tab pointer, and origin scopes', () => {
    const reg = new SessionRegistry()
    reg.addOwnedTab('alpha', 1, true)
    reg.addOwnedTab('alpha', 2, false)
    reg.addOwnedTab('beta', 3, true)
    reg.grantOrigin('alpha', 'https://alpha.example')
    reg.grantOrigin('beta', 'https://beta.example')

    expect(reg.getOwnedTabIds('alpha')).toEqual([1, 2])
    expect(reg.getActiveTabId('alpha')).toBe(1)
    expect(reg.isTabOwnedBy(1, 'alpha')).toBe(true)
    expect(reg.isTabOwnedBy(3, 'alpha')).toBe(false)
    expect(reg.getTabOwner(3)).toBe('beta')

    expect(reg.setActiveTabId('alpha', 2)).toBe(true)
    expect(reg.setActiveTabId('alpha', 3)).toBe(false)
    expect(reg.getActiveTabId('alpha')).toBe(2)

    expect([...reg.getAllowedOrigins('alpha')]).toEqual(['https://alpha.example'])
    expect([...reg.getAllowedOrigins('beta')]).toEqual(['https://beta.example'])

    // Removing active tab advances pointer to remaining owned tab
    expect(reg.removeTab(2)).toBe('alpha')
    expect(reg.getActiveTabId('alpha')).toBe(1)

    const ascii = formatSessionsAscii(reg.list())
    expect(ascii).toContain('AGENT SESSIONS (2)')
    expect(ascii).toContain('alpha')
    expect(ascii).toContain('beta')
    expect(ascii).toContain('https://alpha.example')
  })
})

describe('Multi-agent tab & origin isolation via Agent Socket (M62)', () => {
  let siteA: { url: string; origin: string; close: () => Promise<void> }
  let siteB: { url: string; origin: string; close: () => Promise<void> }
  let manager: BrowserManager
  let socket: Awaited<ReturnType<typeof createAgentSocket>>
  let tmpDir: string

  beforeAll(async () => {
    let originB = ''
    siteA = await startSite('AlphaSite', () => originB)
    siteB = await startSite('BetaSite', () => siteA.origin)
    originB = siteB.origin

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m62-'))
    manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: tmpDir,
      memoryEnabled: false,
    })
    socket = await createAgentSocket(manager, { port: 0 })
  })

  afterAll(async () => {
    await socket.close()
    await manager.close()
    await siteA.close()
    await siteB.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects malformed x-troy-session headers with HTTP 400', async () => {
    const res = await socketPost(socket.port, socket.token, '/tabs', {}, 'invalid session!')
    expect(res.status).toBe(400)
    expect(res.data.ok).toBe(false)
    expect(String(res.data.error)).toContain('invalid x-troy-session')
  })

  it('isolates owned tabs, active tab pointers, and cross-session access', async () => {
    // Agent A opens two tabs on siteA
    const openA1 = await socketPost(socket.port, socket.token, '/open', { url: siteA.url, activate: true }, 'agent-a')
    expect(openA1.data.ok).toBe(true)
    expect(openA1.data.sessionId).toBe('agent-a')
    const tabA1 = Number(openA1.data.id)

    const openA2 = await socketPost(socket.port, socket.token, '/open', { url: `${siteA.origin}/page2`, activate: false }, 'agent-a')
    expect(openA2.data.ok).toBe(true)
    const tabA2 = Number(openA2.data.id)

    // Agent B opens one tab on siteB
    const openB1 = await socketPost(socket.port, socket.token, '/open', { url: siteB.url, activate: true }, 'agent-b')
    expect(openB1.data.ok).toBe(true)
    expect(openB1.data.sessionId).toBe('agent-b')
    const tabB1 = Number(openB1.data.id)

    // /tabs is scoped per session
    const tabsA = await socketPost(socket.port, socket.token, '/tabs', {}, 'agent-a')
    expect(tabsA.data.ok).toBe(true)
    expect(tabsA.data.sessionId).toBe('agent-a')
    const listA = tabsA.data.tabs as Array<{ id: number; active: boolean; ownerSession?: string }>
    expect(listA.map((t) => t.id)).toEqual([tabA1, tabA2])
    expect(listA.find((t) => t.id === tabA1)?.active).toBe(true)
    expect(listA.every((t) => t.ownerSession === 'agent-a')).toBe(true)

    const tabsB = await socketPost(socket.port, socket.token, '/tabs', {}, 'agent-b')
    const listB = tabsB.data.tabs as Array<{ id: number; active: boolean; ownerSession?: string }>
    expect(listB.map((t) => t.id)).toEqual([tabB1])
    expect(listB[0].active).toBe(true)

    // Unscoped /tabs sees all tabs with ownerSession metadata
    const tabsAll = await socketPost(socket.port, socket.token, '/tabs', {})
    const listAll = tabsAll.data.tabs as Array<{ id: number; ownerSession?: string }>
    expect(listAll.length).toBe(3)
    expect(listAll.find((t) => t.id === tabA1)?.ownerSession).toBe('agent-a')
    expect(listAll.find((t) => t.id === tabB1)?.ownerSession).toBe('agent-b')

    // Default /ascii (without tabId) uses each session's own active tab pointer
    const asciiA = await socketPost(socket.port, socket.token, '/ascii', {}, 'agent-a')
    expect(asciiA.data.ok).toBe(true)
    expect(String(asciiA.data.ascii)).toContain('WELCOME TO ALPHASITE')
    expect(String(asciiA.data.ascii)).not.toContain('BetaSite')

    const asciiB = await socketPost(socket.port, socket.token, '/ascii', {}, 'agent-b')
    expect(asciiB.data.ok).toBe(true)
    expect(String(asciiB.data.ascii)).toContain('WELCOME TO BETASITE')
    expect(String(asciiB.data.ascii)).not.toContain('AlphaSite')

    // Brand-new session agent-c has no open tabs and does NOT fall back to A or B
    const asciiC = await socketPost(socket.port, socket.token, '/ascii', {}, 'agent-c')
    expect(asciiC.data.ok).toBe(false)
    expect(String(asciiC.data.error)).toContain('no open tab in session "agent-c"')

    // Cross-session access refusals (ascii, markdown, tool, activate, close even with force)
    const crossAscii = await socketPost(socket.port, socket.token, '/ascii', { tabId: tabB1 }, 'agent-a')
    expect(crossAscii.data.ok).toBe(false)
    expect(crossAscii.data.code).toBe('session_isolation')
    expect(crossAscii.data.status).toBe('blocked')

    const crossMd = await socketPost(socket.port, socket.token, '/markdown', { tabId: tabB1 }, 'agent-a')
    expect(crossMd.data.ok).toBe(false)
    expect(crossMd.data.code).toBe('session_isolation')

    const crossTool = await socketPost(
      socket.port,
      socket.token,
      '/tool',
      { tabId: tabB1, name: 'page_text', args: {} },
      'agent-a',
    )
    expect(crossTool.data.ok).toBe(false)
    expect(crossTool.data.code).toBe('session_isolation')

    const crossActivate = await socketPost(socket.port, socket.token, '/activate', { tabId: tabB1 }, 'agent-a')
    expect(crossActivate.data.ok).toBe(false)
    expect(crossActivate.data.code).toBe('session_isolation')

    const crossClose = await socketPost(
      socket.port,
      socket.token,
      '/close',
      { tabId: tabB1, force: true },
      'agent-a',
    )
    expect(crossClose.data.ok).toBe(false)
    expect(crossClose.data.code).toBe('session_isolation')

    // Agent A CAN activate its own second tab without affecting Agent B
    const actA2 = await socketPost(socket.port, socket.token, '/activate', { tabId: tabA2 }, 'agent-a')
    expect(actA2.data.ok).toBe(true)
    const asciiA2 = await socketPost(socket.port, socket.token, '/ascii', {}, 'agent-a')
    expect(asciiA2.data.ok).toBe(true)
    expect(String(asciiA2.data.ascii)).toContain('ALPHASITE SECOND')

    // Agent B's active tab is still tabB1
    const asciiBStill = await socketPost(socket.port, socket.token, '/ascii', {}, 'agent-b')
    expect(asciiBStill.data.ok).toBe(true)
    expect(String(asciiBStill.data.ascii)).toContain('WELCOME TO BETASITE')

    // Agent A can close its own second tab
    const closeA2 = await socketPost(socket.port, socket.token, '/close', { tabId: tabA2 }, 'agent-a')
    expect(closeA2.data.ok).toBe(true)
  })

  it('isolates origin scopes per session so grants in one session never leak to another', async () => {
    // Agent A has siteA in its scope, NOT siteB (even though Agent B has siteB)
    const navAtoB = await socketPost(
      socket.port,
      socket.token,
      '/tool',
      { name: 'page_navigate', args: { url: siteB.url } },
      'agent-a',
    )
    expect(navAtoB.data.ok).toBe(false)
    expect(navAtoB.data.status).toBe('boundary')
    expect(navAtoB.data.code).toBe('origin')

    // Agent B has siteB in its scope, NOT siteA
    const navBtoA = await socketPost(
      socket.port,
      socket.token,
      '/tool',
      { name: 'page_navigate', args: { url: siteA.url } },
      'agent-b',
    )
    expect(navBtoA.data.ok).toBe(false)
    expect(navBtoA.data.status).toBe('boundary')
    expect(navBtoA.data.code).toBe('origin')

    // Granting siteA ONLY to agent-b allows agent-b to navigate to siteA
    const grantB = await socketPost(socket.port, socket.token, '/grant-origin', { origin: siteA.origin }, 'agent-b')
    expect(grantB.data.ok).toBe(true)
    expect(grantB.data.sessionId).toBe('agent-b')

    const navBtoAAfterGrant = await socketPost(
      socket.port,
      socket.token,
      '/tool',
      { name: 'page_navigate', args: { url: siteA.url } },
      'agent-b',
    )
    expect(navBtoAAfterGrant.data.ok).toBe(true)
    expect(navBtoAAfterGrant.data.url).toBe(siteA.url)

    // Meanwhile agent-a STILL cannot click a cross-origin link to siteB
    const readA = await socketPost(socket.port, socket.token, '/tool', { name: 'page_read', args: {} }, 'agent-a')
    expect(readA.data.ok).toBe(true)
    const elements = readA.data.elements as Array<{ ref?: string; id?: string }>
    const crossLink = elements.find((e) => e.id === 'cross-link')
    expect(crossLink?.ref).toBeTruthy()

    const clickCross = await socketPost(
      socket.port,
      socket.token,
      '/tool',
      { name: 'page_click', args: { ref: crossLink!.ref } },
      'agent-a',
    )
    expect(clickCross.data.ok).toBe(false)
    expect(clickCross.data.status).toBe('boundary')
    expect(clickCross.data.code).toBe('origin')
  })

  it('records sessionId in audit.jsonl and supports /sessions list, inspect, and close', async () => {
    const health = await socketGet(socket.port, socket.token, '/health')
    expect(health.data.ok).toBe(true)
    expect(Number(health.data.sessions)).toBeGreaterThanOrEqual(2)

    const sessionsGet = await socketGet(socket.port, socket.token, '/sessions')
    expect(sessionsGet.data.ok).toBe(true)
    expect(String(sessionsGet.data.ascii)).toContain('agent-a')
    expect(String(sessionsGet.data.ascii)).toContain('agent-b')

    // Audit log filtered by sessionId
    const auditA = await socketPost(socket.port, socket.token, '/audit', { sessionId: 'agent-a', refusedOnly: true })
    expect(auditA.data.ok).toBe(true)
    const entriesA = auditA.data.entries as Array<{ sessionId?: string; refused: boolean; refusal?: { code?: string } }>
    expect(entriesA.length).toBeGreaterThan(0)
    expect(entriesA.every((e) => e.sessionId === 'agent-a' && e.refused)).toBe(true)
    expect(entriesA.some((e) => e.refusal?.code === 'session_isolation')).toBe(true)

    // Close agent-a session and verify its tabs are closed while agent-b remains intact
    const closeA = await socketPost(socket.port, socket.token, '/sessions', { sessionId: 'agent-a', close: true })
    expect(closeA.data.ok).toBe(true)
    expect(closeA.data.removed).toBe(true)
    expect((closeA.data.closedTabIds as number[]).length).toBe(1)

    const tabsBAfter = await socketPost(socket.port, socket.token, '/tabs', {}, 'agent-b')
    expect((tabsBAfter.data.tabs as unknown[]).length).toBe(1)

    const inspectGone = await socketPost(socket.port, socket.token, '/sessions', { sessionId: 'agent-a' })
    expect(inspectGone.data.ok).toBe(false)
  })
})
