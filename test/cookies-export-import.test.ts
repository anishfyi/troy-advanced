import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  BrowserManager,
  createAgentSocket,
  findChromeBinary,
  filterCookies,
  normalizeCookie,
  parseCookieBundle,
  parseSetCookieHeader,
  readCookieFile,
  serializeCookieBundle,
  writeCookieFile,
  type BrowserCookie,
} from '../src/index.js'

const BIN_PATH = path.resolve(process.cwd(), 'bin', 'troy-advanced.mjs')

function runCli(
  args: string[],
  input?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })
    if (input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

function startAuthServer(): Promise<{ server: http.Server; baseUrl: string; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': [
            'session_token=secret-jwt-abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600',
            'theme=dark; Path=/; Max-Age=86400',
            'app_only=scoped42; Path=/app; Max-Age=3600',
          ],
        })
        res.end('<html><head><title>Login</title></head><body><h1>Logged In</h1></body></html>')
        return
      }
      if (url.pathname === '/app/dashboard' || url.pathname === '/dashboard') {
        const cookieHeader = String(req.headers.cookie ?? '')
        const authed = cookieHeader.includes('session_token=secret-jwt-abc123')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<html><head><title>${authed ? 'Dashboard' : 'Unauthorized'}</title></head><body>` +
            `<h1>${authed ? 'Welcome Back' : 'Please Sign In'}</h1>` +
            `<p id="cookies">${cookieHeader || 'NONE'}</p>` +
            `</body></html>`,
        )
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
  })
}

describe('Cookie utilities & AES-256-GCM encryption (M23)', () => {
  it('normalizes cookies, enforces Secure on SameSite=None, and rejects invalid cookies', () => {
    const c = normalizeCookie({
      name: 'sid',
      value: 'xyz',
      domain: 'Example.COM',
      path: 'admin',
      sameSite: 'none' as unknown as 'None',
      expirationDate: 1_900_000_000_000, // ms timestamp
    })
    expect(c).toEqual({
      name: 'sid',
      value: 'xyz',
      domain: 'example.com',
      path: '/admin',
      expires: 1_900_000_000,
      secure: true,
      sameSite: 'None',
    })

    expect(normalizeCookie({ name: '', value: 'x', domain: 'example.com' })).toBeNull()
    expect(normalizeCookie({ name: 'bad;name', value: 'x', domain: 'example.com' })).toBeNull()
    expect(normalizeCookie({ name: 'ok', value: 'x', domain: '' })).toBeNull()
  })

  it('parses Set-Cookie headers with Max-Age precedence, Path, Domain, HttpOnly, Secure, SameSite', () => {
    const now = 1_700_000_000
    const c = parseSetCookieHeader(
      'auth=tok123; Domain=.example.com; Path=/app; Expires=Wed, 21 Oct 2020 07:28:00 GMT; Max-Age=600; HttpOnly; Secure; SameSite=Strict',
      'https://sub.example.com/app/login',
      now,
    )
    expect(c).toEqual({
      name: 'auth',
      value: 'tok123',
      domain: '.example.com',
      path: '/app',
      expires: now + 600,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    })

    // Cross-domain Set-Cookie attribute is ignored and falls back to request host
    const foreign = parseSetCookieHeader('x=1; Domain=evil.com', 'https://good.com/', now)
    expect(foreign?.domain).toBe('good.com')
  })

  it('filters cookies by domain, url, and expiry', () => {
    const now = 1_700_000_000
    const cookies: BrowserCookie[] = [
      { name: 'a', value: '1', domain: '.example.com', path: '/', expires: now + 3600 },
      { name: 'b', value: '2', domain: 'app.example.com', path: '/v1', expires: now + 3600, secure: true },
      { name: 'old', value: '3', domain: 'example.com', path: '/', expires: now - 10 },
      { name: 'other', value: '4', domain: 'other.org', path: '/' },
    ]

    expect(filterCookies(cookies, { nowSec: now }).map((c) => c.name)).toEqual(['a', 'b', 'other'])
    expect(filterCookies(cookies, { includeExpired: true, nowSec: now }).map((c) => c.name)).toEqual([
      'a',
      'b',
      'old',
      'other',
    ])
    expect(filterCookies(cookies, { domain: 'example.com', nowSec: now }).map((c) => c.name)).toEqual(['a', 'b'])
    expect(filterCookies(cookies, { url: 'https://app.example.com/v1/items', nowSec: now }).map((c) => c.name)).toEqual([
      'a',
      'b',
    ])
    // HTTP URL should not match Secure cookie 'b'
    expect(filterCookies(cookies, { url: 'http://app.example.com/v1/items', nowSec: now }).map((c) => c.name)).toEqual([
      'a',
    ])
  })

  it('round-trips plain, raw-array, and AES-256-GCM encrypted bundles and rejects wrong/tampered data', () => {
    const sample: BrowserCookie[] = [
      { name: 'session', value: 'super-secret-token', domain: 'app.example.com', path: '/', httpOnly: true, secure: true },
    ]

    // Plain bundle
    const plainJson = serializeCookieBundle(sample, { engine: 'chromium' })
    const plainParsed = parseCookieBundle(plainJson)
    expect(plainParsed.encrypted).toBe(false)
    expect(plainParsed.cookies).toEqual(sample)

    // Raw array compatibility
    const arrayParsed = parseCookieBundle(JSON.stringify(sample))
    expect(arrayParsed.encrypted).toBe(false)
    expect(arrayParsed.cookies).toEqual(sample)

    // Encrypted bundle
    const encJson = serializeCookieBundle(sample, { engine: 'chromium', passphrase: 'ec2-transfer-password' })
    expect(encJson).not.toContain('super-secret-token')
    expect(JSON.parse(encJson)).toMatchObject({ version: 1, encrypted: true, kdf: 'scrypt', cipher: 'aes-256-gcm' })

    const dec = parseCookieBundle(encJson, { passphrase: 'ec2-transfer-password' })
    expect(dec.encrypted).toBe(true)
    expect(dec.cookies).toEqual(sample)

    // Missing passphrase
    expect(() => parseCookieBundle(encJson)).toThrow(/passphrase/i)
    // Wrong passphrase
    expect(() => parseCookieBundle(encJson, { passphrase: 'wrong-password' })).toThrow(/decrypt/i)
    // Tampered ciphertext
    const tampered = JSON.parse(encJson) as Record<string, string>
    tampered.ciphertext = Buffer.from('corrupted-data').toString('base64')
    expect(() => parseCookieBundle(JSON.stringify(tampered), { passphrase: 'ec2-transfer-password' })).toThrow(/decrypt/i)
  })

  it('writes cookie files with strict 0o600 permissions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-cookies-perm-'))
    const filePath = path.join(tmpDir, 'nested', 'cookies.json')
    try {
      const res = writeCookieFile(filePath, '{"version":1,"cookies":[]}')
      expect(res.mode).toBe('0600')
      const mode = fs.statSync(filePath).mode & 0o777
      expect(mode).toBe(0o600)
      expect(readCookieFile(filePath)).toBe('{"version":1,"cookies":[]}')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Lite engine + Agent Socket + CLI cookies export/import (M23)', () => {
  let authServer: http.Server
  let baseUrl: string
  let tmpDir: string

  beforeAll(async () => {
    const started = await startAuthServer()
    authServer = started.server
    baseUrl = started.baseUrl
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-cookies-cli-'))
  })

  afterAll(async () => {
    authServer.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('transfers signed-in session between two Lite daemons via CLI encrypted file and stdin/stdout pipe', async () => {
    const mgrA = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
    const mgrB = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
    const sockA = await createAgentSocket(mgrA)
    const sockB = await createAgentSocket(mgrB)

    const epA = path.join(tmpDir, 'endpoint-a.json')
    const epB = path.join(tmpDir, 'endpoint-b.json')
    fs.writeFileSync(
      epA,
      JSON.stringify({
        pid: process.pid,
        agentPort: sockA.port,
        agentToken: sockA.token,
        engine: 'lite',
        port: 0,
      }),
    )
    fs.writeFileSync(
      epB,
      JSON.stringify({
        pid: process.pid,
        agentPort: sockB.port,
        agentToken: sockB.token,
        engine: 'lite',
        port: 0,
      }),
    )

    try {
      // 1. Sign in on daemon A
      await mgrA.openTab(`${baseUrl}/login`, { activate: true })

      // Confirm daemon B is NOT signed in yet
      const tabB1 = await mgrB.openTab(`${baseUrl}/app/dashboard`, { activate: true })
      const snapBefore = await mgrB.runTool(tabB1.id!, 'page_text', {})
      expect(String(snapBefore.content)).toContain('Please Sign In')

      // 2. Export encrypted cookies from daemon A to a 0600 file via CLI
      const cookieFile = path.join(tmpDir, 'session.enc.json')
      const exportRun = await runCli([
        'cookies',
        'export',
        cookieFile,
        '--encrypt',
        '--passphrase',
        'my-ec2-pass',
        '--endpoint',
        epA,
      ])
      expect(exportRun.status).toBe(0)
      expect(exportRun.stdout).not.toContain('secret-jwt-abc123')
      const exportSummary = JSON.parse(exportRun.stdout) as Record<string, unknown>
      expect(exportSummary.ok).toBe(true)
      expect(exportSummary.encrypted).toBe(true)
      expect(exportSummary.count).toBe(3)
      expect(exportSummary.mode).toBe('0600')
      expect(fs.statSync(cookieFile).mode & 0o777).toBe(0o600)

      // 3. Import encrypted cookies into daemon B via CLI
      const importRun = await runCli([
        'cookies',
        'import',
        cookieFile,
        '--passphrase',
        'my-ec2-pass',
        '--endpoint',
        epB,
      ])
      expect(importRun.status).toBe(0)
      const importSummary = JSON.parse(importRun.stdout) as Record<string, unknown>
      expect(importSummary.ok).toBe(true)
      expect(importSummary.imported).toBe(3)
      expect(importSummary.encrypted).toBe(true)

      // 4. Daemon B is now signed in and sends scoped /app cookie too!
      const tabB2 = await mgrB.openTab(`${baseUrl}/app/dashboard`, { activate: true })
      const snapAfter = await mgrB.runTool(tabB2.id!, 'page_text', {})
      expect(String(snapAfter.content)).toContain('Welcome Back')
      expect(String(snapAfter.content)).toContain('session_token=secret-jwt-abc123')
      expect(String(snapAfter.content)).toContain('app_only=scoped42')

      // 5. Clear cookies on daemon B via CLI and verify unauthenticated again
      const clearRun = await runCli(['cookies', 'clear', '--endpoint', epB])
      expect(clearRun.status).toBe(0)
      expect(JSON.parse(clearRun.stdout)).toMatchObject({ ok: true, removed: 3 })

      const tabB3 = await mgrB.openTab(`${baseUrl}/dashboard`, { activate: true })
      const snapCleared = await mgrB.runTool(tabB3.id!, 'page_text', {})
      expect(String(snapCleared.content)).toContain('Please Sign In')

      // 6. Stdout -> Stdin pipe transfer (simulating `ssh ec2-user@host 'troy-advanced cookies import'`)
      const pipeExport = await runCli([
        'cookies',
        'export',
        '--encrypt',
        '--passphrase',
        'pipe-secret',
        '--endpoint',
        epA,
      ])
      expect(pipeExport.status).toBe(0)

      const pipeImport = await runCli(
        ['cookies', 'import', '-', '--passphrase', 'pipe-secret', '--endpoint', epB],
        pipeExport.stdout,
      )
      expect(pipeImport.status).toBe(0)
      expect(JSON.parse(pipeImport.stdout)).toMatchObject({ ok: true, imported: 3, encrypted: true })

      const tabB4 = await mgrB.openTab(`${baseUrl}/dashboard`, { activate: true })
      const snapPiped = await mgrB.runTool(tabB4.id!, 'page_text', {})
      expect(String(snapPiped.content)).toContain('Welcome Back')
    } finally {
      await sockA.close()
      await sockB.close()
      await mgrA.close()
      await mgrB.close()
    }
  })
})

const hasChrome = Boolean(findChromeBinary())

describe.skipIf(!hasChrome)('Headless Chromium CDP cookies export/import E2E (M23)', () => {
  let authServer: http.Server
  let baseUrl: string
  let tmpDir: string

  beforeAll(async () => {
    const started = await startAuthServer()
    authServer = started.server
    baseUrl = started.baseUrl
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-cookies-chrome-'))
  })

  afterAll(async () => {
    authServer.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exports HttpOnly & scoped cookies from Chromium Profile A and hydrates fresh Chromium Profile B', async () => {
    const profileA = path.join(tmpDir, 'profile-a')
    const profileB = path.join(tmpDir, 'profile-b')

    const mgrA = await BrowserManager.create({ engine: 'chromium', profileDir: profileA, memoryEnabled: false })
    const mgrB = await BrowserManager.create({ engine: 'chromium', profileDir: profileB, memoryEnabled: false })

    try {
      // 1. Sign in on Chromium A (local laptop)
      await mgrA.openTab(`${baseUrl}/login`, { activate: true })

      const exported = await mgrA.exportCookies({ domain: '127.0.0.1' })
      expect(exported.length).toBeGreaterThanOrEqual(3)
      const sessionCookie = exported.find((c) => c.name === 'session_token')
      expect(sessionCookie).toBeDefined()
      expect(sessionCookie?.value).toBe('secret-jwt-abc123')
      expect(sessionCookie?.httpOnly).toBe(true)

      // Encrypt -> decrypt as would happen over SCP/SSH to EC2
      const enc = serializeCookieBundle(exported, { engine: 'chromium', passphrase: 'ec2-chrome-transfer' })
      expect(enc).not.toContain('secret-jwt-abc123')
      const { cookies: decrypted } = parseCookieBundle(enc, { passphrase: 'ec2-chrome-transfer' })

      // 2. Confirm Chromium B (fresh EC2 instance) is NOT signed in before import
      const tabB1 = await mgrB.openTab(`${baseUrl}/app/dashboard`, { activate: true })
      const beforeText = await mgrB.runTool(tabB1.id!, 'page_text', {})
      expect(String(beforeText.content)).toContain('Please Sign In')

      // 3. Import cookies into Chromium B
      const imported = await mgrB.importCookies(decrypted)
      expect(imported.imported).toBeGreaterThanOrEqual(3)
      expect(imported.errors).toEqual([])

      // 4. Reload / open dashboard on Chromium B -> now authenticated with HttpOnly cookie!
      const tabB2 = await mgrB.openTab(`${baseUrl}/app/dashboard`, { activate: true })
      const afterText = await mgrB.runTool(tabB2.id!, 'page_text', {})
      expect(String(afterText.content)).toContain('Welcome Back')
      expect(String(afterText.content)).toContain('session_token=secret-jwt-abc123')
      expect(String(afterText.content)).toContain('app_only=scoped42')

      // 5. Clear cookies on Chromium B and verify cleared
      const removed = await mgrB.clearCookies({ domain: '127.0.0.1' })
      expect(removed).toBeGreaterThanOrEqual(3)
      const afterClear = await mgrB.exportCookies({ domain: '127.0.0.1' })
      expect(afterClear).toEqual([])
    } finally {
      await mgrA.close()
      await mgrB.close()
    }
  }, 30000)
})
