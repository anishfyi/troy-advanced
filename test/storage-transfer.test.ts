import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { isStrictAscii } from '../src/ascii/sanitize.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  countStorageKeys,
  decryptStorageBundle,
  encryptStorageBundle,
  filterStorageSnapshots,
  formatStorageAscii,
  isSensitiveStorageKeyOrValue,
  normalizeOriginStorageSnapshot,
  normalizeStorageOrigin,
  originFilterMatches,
  parseStorageBundle,
  readStorageFile,
  redactStorageSnapshots,
  serializeStorageBundle,
  writeStorageFile,
  createStorageBundle,
} from '../src/engine/storage.js'
import type { EncryptedStorageBundle, OriginStorageSnapshot } from '../src/types.js'

const tempDirs: string[] = []
const servers: http.Server[] = []

function makeTempDir(prefix = 'troy-storage-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function startTestServer(): Promise<{ url: string; origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Storage Test</title></head><body><h1>Storage Page ${req.url}</h1></body></html>`)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  const origin = `http://127.0.0.1:${addr.port}`
  return {
    url: `${origin}/app`,
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('storage normalization, filtering, redaction & ASCII formatting', () => {
  it('normalizes valid HTTP(S) origins and rejects opaque/unsafe schemes', () => {
    expect(normalizeStorageOrigin('https://APP.Example.COM:443/dashboard?a=1')).toBe('https://app.example.com')
    expect(normalizeStorageOrigin('http://127.0.0.1:8080/foo')).toBe('http://127.0.0.1:8080')
    expect(normalizeStorageOrigin('about:blank')).toBeNull()
    expect(normalizeStorageOrigin('data:text/html,hi')).toBeNull()
    expect(normalizeStorageOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeStorageOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeStorageOrigin('null')).toBeNull()
    expect(normalizeStorageOrigin('not-a-url')).toBeNull()
  })

  it('normalizes snapshots including url/local/session aliases and skips invalid entries', () => {
    const snap = normalizeOriginStorageSnapshot({
      url: 'https://portal.example.com/home',
      local: { theme: 'dark', count: 42, '': 'ignored', empty: undefined, nil: null },
      session: { step: '2' },
    })
    expect(snap).toEqual({
      origin: 'https://portal.example.com',
      localStorage: { theme: 'dark', count: '42' },
      sessionStorage: { step: '2' },
    })
    expect(normalizeOriginStorageSnapshot({ origin: 'about:blank', localStorage: { a: '1' } })).toBeNull()
  })

  it('matches origins by exact origin or domain suffix and filters by area & keyPrefix', () => {
    expect(originFilterMatches('https://app.example.com', 'https://app.example.com')).toBe(true)
    expect(originFilterMatches('https://app.example.com', 'example.com')).toBe(true)
    expect(originFilterMatches('https://app.example.com', 'other.com')).toBe(false)

    const snapshots: OriginStorageSnapshot[] = [
      {
        origin: 'https://app.example.com',
        localStorage: { 'app:theme': 'dark', 'other:x': '1' },
        sessionStorage: { 'app:tab': 'overview' },
      },
      {
        origin: 'https://app.example.com',
        localStorage: { 'app:lang': 'en' },
        sessionStorage: {},
      },
      {
        origin: 'https://billing.other.io',
        localStorage: { 'app:plan': 'pro' },
        sessionStorage: {},
      },
    ]

    const merged = filterStorageSnapshots(snapshots, {
      origin: 'example.com',
      area: 'local',
      keyPrefix: 'app:',
    })
    expect(merged).toEqual([
      {
        origin: 'https://app.example.com',
        localStorage: { 'app:theme': 'dark', 'app:lang': 'en' },
        sessionStorage: {},
      },
    ])
    expect(countStorageKeys(merged)).toEqual({ localKeys: 2, sessionKeys: 0, totalKeys: 2 })
  })

  it('redacts sensitive keys, JWTs, and AWS keys by default and formats strict 7-bit ASCII', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123'
    expect(isSensitiveStorageKeyOrValue('auth_token', 'abc')).toBe(true)
    expect(isSensitiveStorageKeyOrValue('profile', jwt)).toBe(true)
    expect(isSensitiveStorageKeyOrValue('note', 'AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(isSensitiveStorageKeyOrValue('theme', 'dark')).toBe(false)

    const snapshots: OriginStorageSnapshot[] = [
      {
        origin: 'https://app.example.com',
        localStorage: {
          theme: 'dark \x1b[31mred\x1b[0m café 🚀',
          auth_token: 'super-secret-value',
          raw_jwt: jwt,
        },
        sessionStorage: {
          wizard_step: '3',
        },
      },
    ]

    const redacted = redactStorageSnapshots(snapshots, { revealValues: false })
    expect(redacted[0]!.localStorage.auth_token).toBe('<redacted:18 chars>')
    expect(redacted[0]!.localStorage.raw_jwt).toMatch(/^<redacted:\d+ chars>$/)
    expect(redacted[0]!.localStorage.theme).toContain('dark red cafe ?')

    const ascii = formatStorageAscii(snapshots, { revealValues: false, width: 90 })
    expect(isStrictAscii(ascii)).toBe(true)
    expect(ascii).toContain('mode=redacted')
    expect(ascii).not.toContain('super-secret-value')
    expect(ascii).not.toContain('signature123')
    expect(ascii).toContain('wizard_step')

    const revealedAscii = formatStorageAscii(snapshots, { revealValues: true, width: 90 })
    expect(isStrictAscii(revealedAscii)).toBe(true)
    expect(revealedAscii).toContain('mode=revealed')
    expect(revealedAscii).toContain('super-secret-value')
  })

  it('encrypts/decrypts storage bundles with AES-256-GCM, detects tampering, and writes 0600 files', () => {
    const snapshots: OriginStorageSnapshot[] = [
      {
        origin: 'https://ec2.example.com',
        localStorage: { sessionToken: 'tok_abc123', sidebar: 'collapsed' },
        sessionStorage: { draft: 'hello world' },
      },
    ]

    const encryptedJson = serializeStorageBundle(snapshots, {
      engine: 'chromium',
      passphrase: 'ec2-hydration-passphrase',
    })
    expect(encryptedJson).not.toContain('tok_abc123')
    expect(encryptedJson).not.toContain('ec2.example.com')

    const parsed = parseStorageBundle(encryptedJson, { passphrase: 'ec2-hydration-passphrase' })
    expect(parsed.encrypted).toBe(true)
    expect(parsed.skipped).toBe(0)
    expect(parsed.origins).toEqual(snapshots)

    // Wrong passphrase must fail
    expect(() => parseStorageBundle(encryptedJson, { passphrase: 'wrong-passphrase' })).toThrow(/decrypt/i)
    expect(() => parseStorageBundle(encryptedJson)).toThrow(/passphrase/i)

    // Tampered ciphertext must fail authentication
    const envelope = encryptStorageBundle(createStorageBundle(snapshots, 'chromium'), 'pass123')
    const tampered: EncryptedStorageBundle = {
      ...envelope,
      ciphertext: Buffer.from('tampered-bytes').toString('base64'),
    }
    expect(() => decryptStorageBundle(tampered, 'pass123')).toThrow(/decrypt/i)

    // File write uses strict 0600 permissions
    const dir = makeTempDir()
    const filePath = path.join(dir, 'storage.enc.json')
    const written = writeStorageFile(filePath, encryptedJson)
    expect(written.mode).toBe('0600')
    if (process.platform !== 'win32') {
      const stat = fs.statSync(filePath)
      expect(stat.mode & 0o777).toBe(0o600)
    }
    expect(readStorageFile(filePath)).toBe(encryptedJson)
  })
})

describe('Lite engine & Agent Socket storage transfer', () => {
  it('supports shared localStorage, per-tab sessionStorage, offline hydration, and clearing', async () => {
    const srv = await startTestServer()
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
    try {
      // Offline hydration before any tab navigates to the origin
      const preHydrate = await manager.importStorage([
        {
          origin: srv.origin,
          localStorage: { theme: 'solarized', api_token: 'secret_lite_token' },
          sessionStorage: { ignored_until_tab: '1' },
        },
        {
          origin: 'https://offline-only.example.com',
          localStorage: { region: 'us-east-1' },
          sessionStorage: {},
        },
      ])
      expect(preHydrate.importedOrigins).toBe(2)
      expect(preHydrate.localKeys).toBe(3)

      // Open two tabs to srv.url
      const tab1 = await manager.openTab(srv.url)
      const tab2 = await manager.openTab(srv.url)

      // Hydrate sessionStorage specifically on tab1
      const tab1Hydrate = await manager.importStorage(
        [
          {
            origin: srv.origin,
            localStorage: {},
            sessionStorage: { tab_marker: 'tab-one-only' },
          },
        ],
        { tabId: tab1.id, area: 'session' },
      )
      expect(tab1Hydrate.sessionKeys).toBe(1)

      // Tab 1 sees both localStorage and its sessionStorage
      const snap1 = await manager.exportStorage({ tabId: tab1.id })
      expect(snap1).toEqual([
        {
          origin: srv.origin,
          localStorage: { theme: 'solarized', api_token: 'secret_lite_token' },
          sessionStorage: { tab_marker: 'tab-one-only' },
        },
      ])

      // Tab 2 sees the shared localStorage, NOT tab 1's sessionStorage
      const snap2 = await manager.exportStorage({ tabId: tab2.id })
      expect(snap2).toEqual([
        {
          origin: srv.origin,
          localStorage: { theme: 'solarized', api_token: 'secret_lite_token' },
          sessionStorage: {},
        },
      ])

      // Inspect redacts api_token by default
      const inspected = await manager.inspectStorage({ origin: srv.origin })
      expect(inspected.origins[0]!.localStorage.api_token).toMatch(/^<redacted:/)
      expect(inspected.ascii).not.toContain('secret_lite_token')

      // Clear a single key from localStorage
      const clearedKey = await manager.clearStorage({
        origin: srv.origin,
        area: 'local',
        keys: ['theme'],
      })
      expect(clearedKey.removedLocal).toBe(1)
      expect(clearedKey.removedSession).toBe(0)

      const afterKeyClear = await manager.exportStorage({ tabId: tab1.id })
      expect(afterKeyClear[0]!.localStorage).toEqual({ api_token: 'secret_lite_token' })
      expect(afterKeyClear[0]!.sessionStorage).toEqual({ tab_marker: 'tab-one-only' })

      // Clear everything across all origins
      const clearedAll = await manager.clearStorage()
      expect(clearedAll.removedLocal).toBe(2) // api_token + region
      expect(clearedAll.removedSession).toBe(1) // tab_marker
    } finally {
      await manager.close()
    }
  })

  it('exposes /storage/inspect, /storage/export, /storage/import, and /storage/clear on Agent Socket', async () => {
    const srv = await startTestServer()
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
    const socket = await createAgentSocket(manager, { port: 0 })
    const post = async (route: string, body: Record<string, unknown> = {}) => {
      const res = await fetch(`http://127.0.0.1:${socket.port}${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-troy-agent': socket.token,
        },
        body: JSON.stringify(body),
      })
      return { status: res.status, json: (await res.json()) as Record<string, unknown> }
    }

    try {
      const tab = await manager.openTab(srv.url)

      // Bad payload rejected with 400
      const bad = await post('/storage/import', { origins: 'not-an-array' })
      expect(bad.status).toBe(400)
      expect(bad.json.ok).toBe(false)

      // Import storage via socket
      const imp = await post('/storage/import', {
        tabId: tab.id,
        origins: [
          {
            origin: srv.origin,
            localStorage: { user: 'alice', access_token: 'tok_socket_secret' },
            sessionStorage: { flow: 'checkout' },
          },
        ],
      })
      expect(imp.status).toBe(200)
      expect(imp.json.ok).toBe(true)
      expect(imp.json.localKeys).toBe(2)
      expect(imp.json.sessionKeys).toBe(1)

      // Inspect (redacted)
      const insp = await post('/storage/inspect', { tabId: tab.id })
      expect(insp.status).toBe(200)
      expect(String(insp.json.ascii)).not.toContain('tok_socket_secret')

      // Export (unredacted for transfer)
      const exp = await post('/storage/export', { tabId: tab.id })
      expect(exp.status).toBe(200)
      const origins = exp.json.origins as OriginStorageSnapshot[]
      expect(origins).toHaveLength(1)
      expect(origins[0]!.localStorage.access_token).toBe('tok_socket_secret')
      expect(origins[0]!.sessionStorage.flow).toBe('checkout')

      // Clear
      const clr = await post('/storage/clear', { tabId: tab.id })
      expect(clr.status).toBe(200)
      expect(clr.json.removedLocal).toBe(2)
      expect(clr.json.removedSession).toBe(1)
    } finally {
      await socket.close()
      await manager.close()
    }
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('Chromium real localStorage & sessionStorage hydration E2E', () => {
  it('inspects, exports encrypted bundle, clears, and re-hydrates localStorage + sessionStorage in Chromium', async () => {
    const srv = await startTestServer()
    const profileDir = makeTempDir('troy-chrome-storage-')
    const outFile = path.join(makeTempDir('troy-storage-bundle-'), 'session-storage.enc.json')
    const manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir,
      memoryEnabled: false,
    })

    try {
      const tab = await manager.openTab(srv.url)
      await manager.runTool(tab.id, 'page_eval', {
        expression: `(() => {
          localStorage.setItem('theme', 'midnight');
          localStorage.setItem('auth_token', 'chrome-secret-token-999');
          sessionStorage.setItem('draft_id', 'draft-42');
          return true;
        })()`,
      })

      // Inspect should redact auth_token by default
      const inspected = await manager.inspectStorage({ tabId: tab.id })
      expect(inspected.counts).toEqual({ localKeys: 2, sessionKeys: 1, totalKeys: 3 })
      expect(inspected.origins[0]!.localStorage.auth_token).toMatch(/^<redacted:/)
      expect(inspected.ascii).not.toContain('chrome-secret-token-999')

      // Export & encrypt to 0600 file
      const exported = await manager.exportStorage({ tabId: tab.id })
      const serialized = serializeStorageBundle(exported, {
        engine: 'chromium',
        passphrase: 'ec2-chrome-password',
      })
      writeStorageFile(outFile, serialized)

      // Clear storage on the live Chromium tab
      const cleared = await manager.clearStorage({ tabId: tab.id })
      expect(cleared.removedLocal).toBe(2)
      expect(cleared.removedSession).toBe(1)

      const emptyAfterClear = await manager.exportStorage({ tabId: tab.id })
      expect(emptyAfterClear[0]!.localStorage).toEqual({})
      expect(emptyAfterClear[0]!.sessionStorage).toEqual({})

      // Decrypt & re-hydrate into Chromium tab
      const parsed = parseStorageBundle(readStorageFile(outFile), { passphrase: 'ec2-chrome-password' })
      const hydrated = await manager.importStorage(parsed.origins, { tabId: tab.id })
      expect(hydrated.importedOrigins).toBe(1)
      expect(hydrated.localKeys).toBe(2)
      expect(hydrated.sessionKeys).toBe(1)

      // Verify inside real browser JS context
      const verified = (await manager.runTool(tab.id, 'page_eval', {
        expression: `({
          theme: localStorage.getItem('theme'),
          auth: localStorage.getItem('auth_token'),
          draft: sessionStorage.getItem('draft_id'),
        })`,
      })) as { ok: boolean; value: { theme: string; auth: string; draft: string } }
      expect(verified.ok).toBe(true)
      expect(verified.value).toEqual({
        theme: 'midnight',
        auth: 'chrome-secret-token-999',
        draft: 'draft-42',
      })
    } finally {
      await manager.close()
    }
  }, 30000)
})
