import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BrowserManager,
  CookieJar,
  LiteBrowserEngine,
  computeDefaultCookiePath,
} from '../src/index.js'

describe('CookieJar RFC 6265 core & file persistence (M31)', () => {
  it('computes RFC 6265 §5.1.4 default cookie paths accurately', () => {
    expect(computeDefaultCookiePath('')).toBe('/')
    expect(computeDefaultCookiePath('/')).toBe('/')
    expect(computeDefaultCookiePath('/login')).toBe('/')
    expect(computeDefaultCookiePath('/app/login')).toBe('/app')
    expect(computeDefaultCookiePath('/app/v1/auth/login')).toBe('/app/v1/auth')
    expect(computeDefaultCookiePath('/app/v1/')).toBe('/app/v1')
    expect(computeDefaultCookiePath('relative/path')).toBe('/')
  })

  it('enforces host-only vs domain-scoped matching and rejects foreign domains', () => {
    const jar = new CookieJar({ nowSec: () => 1_700_000_000 })

    // No Domain attribute -> host-only (only matches example.com, NOT sub.example.com)
    const hostCookie = jar.setFromHeader('host_id=h1; Path=/; Max-Age=3600', 'https://example.com/')
    expect(hostCookie?.hostOnly).toBe(true)

    // Explicit Domain attribute -> matches example.com AND subdomains
    const domCookie = jar.setFromHeader('dom_id=d1; Domain=example.com; Path=/; Max-Age=3600', 'https://app.example.com/')
    expect(domCookie?.hostOnly).toBe(false)
    expect(domCookie?.domain).toBe('.example.com')

    // Foreign Domain attribute MUST be rejected
    const rejected = jar.setFromHeader('evil=1; Domain=evil.com; Path=/', 'https://example.com/')
    expect(rejected).toBeNull()

    expect(jar.getCookieHeader('https://example.com/')).toBe('host_id=h1; dom_id=d1')
    expect(jar.getCookieHeader('https://sub.example.com/')).toBe('dom_id=d1')
    expect(jar.getCookieHeader('https://a.b.example.com/')).toBe('dom_id=d1')
    expect(jar.getCookieHeader('https://notexample.com/')).toBeUndefined()

    // IP address host-only enforcement
    jar.setFromHeader('ip_tok=ok; Path=/; Max-Age=3600', 'http://127.0.0.1:8080/')
    expect(jar.getCookieHeader('http://127.0.0.1:9999/')).toBe('ip_tok=ok')
    expect(jar.getCookieHeader('http://127.0.0.2:8080/')).toBeUndefined()
    // Foreign IP domain rejected
    expect(jar.setFromHeader('bad_ip=1; Domain=127.0.0.2', 'http://127.0.0.1/')).toBeNull()
  })

  it('enforces path boundaries, default-path, and longest-path-first ordering', () => {
    const jar = new CookieJar({ nowSec: () => 1_700_000_000 })

    // Default path from /app/v1/login -> /app/v1
    const def = jar.setFromHeader('scoped=v1; Max-Age=3600', 'https://example.com/app/v1/login')
    expect(def?.path).toBe('/app/v1')

    jar.setFromHeader('root=r; Path=/; Max-Age=3600', 'https://example.com/')
    jar.setFromHeader('app=a; Path=/app; Max-Age=3600', 'https://example.com/')
    jar.setFromHeader('deep=d; Path=/app/v1/admin; Max-Age=3600', 'https://example.com/')

    // Longest path first: /app/v1/admin -> /app/v1 -> /app -> /
    expect(jar.getCookieHeader('https://example.com/app/v1/admin/users')).toBe(
      'deep=d; scoped=v1; app=a; root=r',
    )
    // Path boundary check: /app MUST NOT match /apple
    expect(jar.getCookieHeader('https://example.com/apple')).toBe('root=r')
    expect(jar.getCookieHeader('https://example.com/app')).toBe('app=a; root=r')
  })

  it('handles Max-Age precedence, expiry pruning, and deletion via Max-Age=0', () => {
    let now = 1_700_000_000
    const jar = new CookieJar({ nowSec: () => now })

    // Max-Age overrides past Expires
    jar.setFromHeader(
      'a=1; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=100',
      'https://example.com/',
    )
    // Expires-only cookie (valid for 50s)
    const expDate = new Date((now + 50) * 1000).toUTCString()
    jar.setFromHeader(`b=2; Path=/; Expires=${expDate}`, 'https://example.com/')

    expect(jar.getCookieHeader('https://example.com/')).toBe('a=1; b=2')

    // Advance 60s -> b expires, a still valid
    now += 60
    expect(jar.getCookieHeader('https://example.com/')).toBe('a=1')
    expect(jar.size).toBe(1)

    // Delete 'a' with Max-Age=0
    jar.setFromHeader('a=deleted; Path=/; Max-Age=0', 'https://example.com/')
    expect(jar.getCookieHeader('https://example.com/')).toBeUndefined()
    expect(jar.size).toBe(0)
  })

  it('enforces Secure transport, Secure overwrite protection, and __Secure-/__Host- prefixes', () => {
    const jar = new CookieJar({ nowSec: () => 1_700_000_000 })

    jar.setFromHeader('sec=secret; Path=/; Secure; Max-Age=3600', 'https://example.com/')
    jar.setFromHeader('pub=plain; Path=/; Max-Age=3600', 'https://example.com/')

    // HTTPS receives both; HTTP receives only non-Secure cookie
    expect(jar.getCookieHeader('https://example.com/')).toBe('sec=secret; pub=plain')
    expect(jar.getCookieHeader('http://example.com/')).toBe('pub=plain')

    // Insecure HTTP response MUST NOT overwrite existing Secure cookie
    const overwriteAttempt = jar.setFromHeader('sec=hijacked; Path=/; Max-Age=3600', 'http://example.com/')
    expect(overwriteAttempt).toBeNull()
    expect(jar.getCookieHeader('https://example.com/')).toBe('sec=secret; pub=plain')

    // __Secure- prefix checks
    expect(jar.setFromHeader('__Secure-tok=1; Path=/', 'https://example.com/')).toBeNull() // missing Secure
    expect(jar.setFromHeader('__Secure-tok=1; Path=/; Secure', 'http://example.com/')).toBeNull() // http origin
    expect(jar.setFromHeader('__Secure-tok=1; Path=/; Secure; Max-Age=3600', 'https://example.com/')?.value).toBe('1')

    // __Host- prefix checks (requires Secure, https:, Path=/, and NO Domain attribute)
    expect(jar.setFromHeader('__Host-id=1; Path=/; Secure; Domain=example.com', 'https://example.com/')).toBeNull()
    expect(jar.setFromHeader('__Host-id=1; Path=/sub; Secure', 'https://example.com/')).toBeNull()
    expect(jar.setFromHeader('__Host-id=1; Path=/; Secure', 'http://example.com/')).toBeNull()
    expect(jar.setFromHeader('__Host-id=1; Path=/; Secure; Max-Age=3600', 'https://example.com/')?.value).toBe('1')
  })

  it('enforces HttpOnly visibility and mutation protection for document.cookie vs HTTP headers', () => {
    const jar = new CookieJar({ nowSec: () => 1_700_000_000 })

    jar.setFromHeader('sid=http-only-secret; Path=/; HttpOnly; Max-Age=3600', 'https://example.com/')
    jar.setFromHeader('theme=dark; Path=/; Max-Age=3600', 'https://example.com/')

    // HTTP Cookie header includes both
    expect(jar.getCookieHeader('https://example.com/')).toBe('sid=http-only-secret; theme=dark')

    // document.cookie omits HttpOnly
    expect(jar.getDocumentCookie('https://example.com/')).toBe('theme=dark')

    // document.cookie cannot set HttpOnly or overwrite an existing HttpOnly cookie
    expect(jar.setDocumentCookie('sid=evil; Path=/', 'https://example.com/')).toBeNull()
    expect(jar.setDocumentCookie('js_http=1; Path=/; HttpOnly', 'https://example.com/')).toBeNull()
    expect(jar.getCookieHeader('https://example.com/')).toBe('sid=http-only-secret; theme=dark')

    // document.cookie CAN set normal cookies
    expect(jar.setDocumentCookie('theme=light; Path=/; Max-Age=3600', 'https://example.com/')?.value).toBe('light')
    expect(jar.getDocumentCookie('https://example.com/')).toBe('theme=light')
  })

  it('persists cookies to cookies.json with 0o600 permissions, respects session vs persistent cookies, and handles corrupt files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-cookie-jar-'))
    const filePath = path.join(tmpDir, 'cookies.json')
    try {
      const now = 1_700_000_000
      const jar1 = new CookieJar({ filePath, nowSec: () => now })
      jar1.setFromHeader('persist_me=yes; Path=/; HttpOnly; Max-Age=3600', 'https://example.com/')
      jar1.setFromHeader('session_only=temp; Path=/', 'https://example.com/')

      // Both are available in memory during the session
      expect(jar1.getCookieHeader('https://example.com/')).toBe('persist_me=yes; session_only=temp')

      // File exists with strict 0o600 permissions
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)

      jar1.close()

      // Reopen fresh CookieJar from same file -> persistent cookie survives, session cookie does not
      const jar2 = new CookieJar({ filePath, nowSec: () => now + 10 })
      expect(jar2.getCookieHeader('https://example.com/')).toBe('persist_me=yes')
      expect(jar2.getDocumentCookie('https://example.com/')).toBe('') // still HttpOnly!

      // Clear updates disk so cleared cookies don't come back
      jar2.clear()
      jar2.close()
      const jar3 = new CookieJar({ filePath, nowSec: () => now + 20 })
      expect(jar3.size).toBe(0)

      // persistSessionCookies: true saves session cookies too
      const jar4 = new CookieJar({ filePath, persistSessionCookies: true, nowSec: () => now + 20 })
      jar4.setFromHeader('sess_keep=alive; Path=/', 'https://example.com/')
      jar4.close()
      const jar5 = new CookieJar({ filePath, persistSessionCookies: true, nowSec: () => now + 30 })
      expect(jar5.getCookieHeader('https://example.com/')).toBe('sess_keep=alive')

      // Corrupt JSON file is handled gracefully without throwing
      fs.writeFileSync(filePath, '{not valid json!!!', { mode: 0o600 })
      const jarCorrupt = new CookieJar({ filePath, nowSec: () => now + 40 })
      expect(jarCorrupt.size).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Lite engine persistent CookieJar & 302 redirect E2E (M31)', () => {
  let server: http.Server
  let baseUrl: string
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-lite-jar-e2e-'))
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const cookieHeader = String(req.headers.cookie ?? '')

        if (url.pathname === '/login-redirect') {
          res.writeHead(302, {
            location: '/dashboard',
            'set-cookie': [
              'auth_session=tok-redirect-999; Path=/; HttpOnly; Max-Age=7200',
              'admin_only=secret-admin; Path=/admin; Max-Age=7200',
              'ephemeral=once; Path=/',
            ],
          })
          res.end()
          return
        }

        if (url.pathname === '/logout') {
          res.writeHead(302, {
            location: '/dashboard',
            'set-cookie': ['auth_session=; Path=/; Max-Age=0'],
          })
          res.end()
          return
        }

        if (url.pathname === '/dashboard' || url.pathname === '/admin/panel') {
          const authed = cookieHeader.includes('auth_session=tok-redirect-999')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(
            `<html><head><title>${authed ? 'Authed' : 'Guest'}</title></head>` +
              `<body><h1>${authed ? 'Signed In' : 'Logged Out'}</h1>` +
              `<p id="cookies">${cookieHeader || 'NONE'}</p></body></html>`,
          )
          return
        }

        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(() => {
    server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('captures Set-Cookie on 302 redirects, persists to <profileDir>/cookies.json (0o600), and restores session on engine restart', async () => {
    const profileDir = path.join(tmpDir, 'profile-1')
    const cookiesFile = path.join(profileDir, 'cookies.json')

    // 1. First Lite engine instance logs in via 302 redirect
    const mgr1 = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: false })
    try {
      const tab1 = await mgr1.openTab(`${baseUrl}/login-redirect`, { activate: true })
      const dash1 = await mgr1.runTool(tab1.id!, 'page_text', {})
      expect(tab1.url).toBe(`${baseUrl}/dashboard`)
      expect(String(dash1.content)).toContain('Signed In')
      expect(String(dash1.content)).toContain('auth_session=tok-redirect-999')
      expect(String(dash1.content)).toContain('ephemeral=once')
      // /admin scoped cookie must NOT be sent to /dashboard
      expect(String(dash1.content)).not.toContain('admin_only=secret-admin')

      // /admin/panel DOES receive admin_only (and longer-path admin_only appears before root auth_session)
      const tabAdmin = await mgr1.openTab(`${baseUrl}/admin/panel`, { activate: true })
      const adminText = await mgr1.runTool(tabAdmin.id!, 'page_text', {})
      expect(String(adminText.content)).toContain('admin_only=secret-admin')
      const idxAdmin = String(adminText.content).indexOf('admin_only=secret-admin')
      const idxAuth = String(adminText.content).indexOf('auth_session=tok-redirect-999')
      expect(idxAdmin).toBeLessThan(idxAuth)
    } finally {
      await mgr1.close()
    }

    // Verify cookies.json was written with 0o600 permissions
    expect(fs.existsSync(cookiesFile)).toBe(true)
    expect(fs.statSync(cookiesFile).mode & 0o777).toBe(0o600)

    // 2. Brand new Lite engine instance with same profileDir is STILL signed in!
    const mgr2 = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: false })
    try {
      const tab2 = await mgr2.openTab(`${baseUrl}/dashboard`, { activate: true })
      const dash2 = await mgr2.runTool(tab2.id!, 'page_text', {})
      expect(String(dash2.content)).toContain('Signed In')
      expect(String(dash2.content)).toContain('auth_session=tok-redirect-999')
      // Session-only cookie was not persisted across restart
      expect(String(dash2.content)).not.toContain('ephemeral=once')

      // 3. Logout via 302 with Max-Age=0 deletes cookie and persists deletion
      await mgr2.openTab(`${baseUrl}/logout`, { activate: true })
    } finally {
      await mgr2.close()
    }

    // 4. Third Lite engine instance confirms logout persisted to cookies.json
    const mgr3 = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: false })
    try {
      const tab3 = await mgr3.openTab(`${baseUrl}/dashboard`, { activate: true })
      const dash3 = await mgr3.runTool(tab3.id!, 'page_text', {})
      expect(String(dash3.content)).toContain('Logged Out')
      expect(String(dash3.content)).not.toContain('auth_session=tok-redirect-999')
    } finally {
      await mgr3.close()
    }
  })

  it('supports in-memory mode when cookieJarPath is null', async () => {
    const engine = new LiteBrowserEngine({ cookieJarPath: null })
    expect(engine.getCookieJar().filePath).toBeNull()
    const tab = await engine.createTab(`${baseUrl}/login-redirect`)
    expect(tab.getUrl()).toBe(`${baseUrl}/dashboard`)
    expect(engine.getCookieJar().size).toBe(3)
    await engine.close()
    expect(engine.getCookieJar().size).toBe(0)
  })
})
