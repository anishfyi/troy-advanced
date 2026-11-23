import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { ChromiumBrowserEngine, findChromeBinary } from '../src/engine/chromium.js'
import {
  cleanupStaleProfileLocks,
  computeRecoveryBackoffMs,
  isCdpDisconnectError,
  resolveCrashRecoveryOptions,
  shouldRestoreTabUrl,
} from '../src/engine/crash-recovery.js'
import { BrowserManager } from '../src/engine/manager.js'

const hasChrome = Boolean(findChromeBinary())

describe('Crash recovery utilities (M26)', () => {
  it('resolves and clamps crash recovery options safely', () => {
    const defaults = resolveCrashRecoveryOptions()
    expect(defaults).toEqual({
      enabled: true,
      maxRestarts: 5,
      backoffMs: 250,
      maxBackoffMs: 5000,
      resetWindowMs: 60_000,
      restoreTabs: true,
    })

    const custom = resolveCrashRecoveryOptions({
      enabled: false,
      maxRestarts: -3,
      backoffMs: 600,
      maxBackoffMs: 200, // should clamp up to backoffMs
      resetWindowMs: -10,
      restoreTabs: false,
    })
    expect(custom).toEqual({
      enabled: false,
      maxRestarts: 0,
      backoffMs: 600,
      maxBackoffMs: 600,
      resetWindowMs: 0,
      restoreTabs: false,
    })
  })

  it('computes capped exponential backoff delays', () => {
    const opts = { backoffMs: 100, maxBackoffMs: 500 }
    expect(computeRecoveryBackoffMs(0, opts)).toBe(100)
    expect(computeRecoveryBackoffMs(1, opts)).toBe(200)
    expect(computeRecoveryBackoffMs(2, opts)).toBe(400)
    expect(computeRecoveryBackoffMs(3, opts)).toBe(500)
    expect(computeRecoveryBackoffMs(10, opts)).toBe(500)
    expect(computeRecoveryBackoffMs(0, { backoffMs: 0, maxBackoffMs: 500 })).toBe(0)
  })

  it('classifies CDP disconnect errors accurately without false positives', () => {
    expect(isCdpDisconnectError(new Error('CDP WebSocket closed'))).toBe(true)
    expect(isCdpDisconnectError(new Error('CDP client is closed'))).toBe(true)
    expect(isCdpDisconnectError(new Error('fetch failed'))).toBe(true)
    expect(isCdpDisconnectError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isCdpDisconnectError(new Error('Navigation failed: net::ERR_NAME_NOT_RESOLVED'))).toBe(false)
    expect(isCdpDisconnectError(new Error('element not found'))).toBe(false)
  })

  it('removes stale Chromium singleton lock files & broken symlinks while preserving profile data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m26-locks-'))
    try {
      fs.writeFileSync(path.join(dir, 'Preferences'), '{"ok":true}')
      fs.writeFileSync(path.join(dir, 'SingletonCookie'), 'cookie')
      fs.symlinkSync('dead-host-999999', path.join(dir, 'SingletonLock'))

      const removed = cleanupStaleProfileLocks(dir)
      expect(removed).toContain('SingletonLock')
      expect(removed).toContain('SingletonCookie')
      expect(fs.existsSync(path.join(dir, 'Preferences'))).toBe(true)
      expect(() => fs.lstatSync(path.join(dir, 'SingletonLock'))).toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('only restores http(s) URLs after crash recovery', () => {
    expect(shouldRestoreTabUrl('http://127.0.0.1:8080/dashboard')).toBe(true)
    expect(shouldRestoreTabUrl('https://example.com/app')).toBe(true)
    expect(shouldRestoreTabUrl('about:blank')).toBe(false)
    expect(shouldRestoreTabUrl('chrome://settings')).toBe(false)
    expect(shouldRestoreTabUrl('')).toBe(false)
    expect(shouldRestoreTabUrl(undefined)).toBe(false)
  })
})

describe.skipIf(!hasChrome)('Headless Chromium automatic crash recovery E2E (M26)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/set-cookie') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'session_id=persist-m26; Path=/; Max-Age=3600',
        })
        res.end(`<!doctype html>
          <html>
            <head><title>Crash Recovery Lab</title></head>
            <body>
              <h1>Crash Recovery Lab</h1>
              <p id="status">Session initialized</p>
              <a href="/check" id="check-link">Check Session</a>
            </body>
          </html>`)
        return
      }
      if (req.url === '/check') {
        const cookieHeader = String(req.headers.cookie ?? '')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html>
            <head><title>Session Check</title></head>
            <body>
              <h1>Session Check</h1>
              <p id="cookie-val">Cookie: ${cookieHeader}</p>
              <p id="ls-val">LS: loading</p>
              <script>
                document.getElementById('ls-val').textContent = 'LS: ' + (localStorage.getItem('user_note') || 'missing');
              </script>
            </body>
          </html>`)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('detects Chromium SIGKILL exit, transparently relaunches with same profile, preserves cookies/localStorage, and restores open tabs', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m26-profile-'))
    const events: Array<Record<string, unknown>> = []

    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir,
      memoryEnabled: false,
      crashRecovery: {
        enabled: true,
        maxRestarts: 3,
        backoffMs: 100,
        restoreTabs: true,
      },
    })
    const socket = await createAgentSocket(manager)

    try {
      manager.onEvent((ev) => events.push(ev))
      const engine = manager.engine as ChromiumBrowserEngine
      const initialPid = engine.getPid()
      const initialProfileDir = engine.getProfileDir()
      expect(initialPid).toBeTypeOf('number')
      expect(initialProfileDir).toBe(path.join(profileDir, 'chrome-data'))

      // Open page, set persistent cookie + localStorage
      const opened = await manager.openTab(`${baseUrl}/set-cookie`, { activate: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.tabId!

      const evalWrite = await manager.runTool(tabId, 'page_eval', {
        expression: `(() => { localStorage.setItem('user_note', 'survived-crash-m26'); return localStorage.getItem('user_note'); })()`,
      })
      expect(evalWrite.ok).toBe(true)
      expect(evalWrite.value).toBe('survived-crash-m26')

      // Navigate to /check so the tab's restored URL will verify both cookie and localStorage
      const nav = await manager.runTool(tabId, 'page_navigate', { url: `${baseUrl}/check` })
      expect(nav.ok).toBe(true)

      const beforeAscii = await manager.renderAscii(tabId, { width: 80, height: 24 })
      expect(beforeAscii.ok).toBe(true)
      expect(beforeAscii.ascii).toContain('session_id=persist-m26')
      expect(beforeAscii.ascii).toContain('survived-crash-m26')

      // Simulate sudden Chromium OOM / crash via SIGKILL
      process.kill(initialPid!, 'SIGKILL')

      // Immediately issue a normal renderAscii call without manual intervention:
      // BrowserManager/ChromiumTab must transparently await relaunch and succeed!
      const afterAscii = await manager.renderAscii(tabId, { width: 80, height: 24 })
      expect(afterAscii.ok).toBe(true)
      expect(afterAscii.snapshot?.url).toBe(`${baseUrl}/check`)
      expect(afterAscii.ascii).toContain('Session Check')
      // Persistent cookie survived SIGKILL because Chromium relaunched with the exact same profileDir
      expect(afterAscii.ascii).toContain('session_id=persist-m26')

      // Verify JS execution & DOM/storage remain fully functional on the transparently recovered tab
      const postCrashEval = await manager.runTool(tabId, 'page_eval', {
        expression: `(() => { localStorage.setItem('post_recovery', 'ok-m26'); return localStorage.getItem('post_recovery'); })()`,
      })
      expect(postCrashEval.ok).toBe(true)
      expect(postCrashEval.value).toBe('ok-m26')

      // Verify new Chromium PID, same profileDir, and recovery stats
      const recoveredPid = engine.getPid()
      expect(recoveredPid).toBeTypeOf('number')
      expect(recoveredPid).not.toBe(initialPid)
      expect(engine.getProfileDir()).toBe(initialProfileDir)

      const stats = manager.getCrashRecoveryStats()
      expect(stats.status).toBe('healthy')
      expect(stats.restartCount).toBe(1)
      expect(stats.totalCrashes).toBe(1)
      expect(stats.lastExitSignal).toBe('SIGKILL')
      expect(stats.profileDir).toBe(initialProfileDir)

      // Verify crash lifecycle events emitted in order
      const kinds = events.map((e) => e.type).filter((t) => String(t).startsWith('chromium_'))
      expect(kinds).toEqual(['chromium_crashed', 'chromium_relaunching', 'chromium_recovered'])

      // Verify /health exposes crashRecovery telemetry
      const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        headers: { 'x-troy-agent': socket.token },
      })
      expect(healthRes.ok).toBe(true)
      const health = (await healthRes.json()) as {
        ok: boolean
        crashRecovery?: { status: string; restartCount: number; pid: number }
      }
      expect(health.ok).toBe(true)
      expect(health.crashRecovery?.status).toBe('healthy')
      expect(health.crashRecovery?.restartCount).toBe(1)
      expect(health.crashRecovery?.pid).toBe(recoveredPid)

      // Intentional close must not trigger crash recovery
      await socket.close()
      await manager.close()
      expect(manager.getCrashRecoveryStats().status).toBe('closed')
      expect(manager.getCrashRecoveryStats().totalCrashes).toBe(1)
    } finally {
      await socket.close().catch(() => {})
      await manager.close().catch(() => {})
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  }, 30000)

  it('enforces maxRestarts limit and surfaces clean failure after exhausting recovery budget', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m26-maxrestarts-'))
    const events: string[] = []

    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir,
      memoryEnabled: false,
      crashRecovery: {
        enabled: true,
        maxRestarts: 1,
        backoffMs: 50,
        resetWindowMs: 60_000,
        restoreTabs: false,
      },
    })

    try {
      manager.onEvent((ev) => {
        if (typeof ev.type === 'string' && ev.type.startsWith('chromium_')) {
          events.push(ev.type)
        }
      })

      const engine = manager.engine as ChromiumBrowserEngine
      const opened = await manager.openTab(`${baseUrl}/set-cookie`, { activate: true })
      expect(opened.ok).toBe(true)
      const tabId = opened.tabId!

      // First crash -> recovers cleanly (1 / 1)
      const pid1 = engine.getPid()!
      process.kill(pid1, 'SIGKILL')

      const eval1 = await manager.runTool(tabId, 'page_eval', { expression: '1 + 1' })
      expect(eval1.ok).toBe(true)
      expect(eval1.value).toBe(2)
      expect(manager.getCrashRecoveryStats().restartCount).toBe(1)

      // Second crash within resetWindowMs -> exceeds maxRestarts (1)
      const pid2 = engine.getPid()!
      expect(pid2).not.toBe(pid1)
      process.kill(pid2, 'SIGKILL')

      // Wait for failure event to settle
      const deadline = Date.now() + 5000
      while (manager.getCrashRecoveryStats().status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }

      const stats = manager.getCrashRecoveryStats()
      expect(stats.status).toBe('failed')
      expect(stats.totalCrashes).toBe(2)
      expect(stats.restartCount).toBe(1)
      expect(stats.lastError).toContain('max crash restarts')
      expect(events).toContain('chromium_recovery_failed')

      await expect(manager.runTool(tabId, 'page_eval', { expression: '2 + 2' })).rejects.toThrow('max crash restarts')
    } finally {
      await manager.close()
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  }, 30000)
})
