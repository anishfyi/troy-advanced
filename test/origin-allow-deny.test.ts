import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  authorizeAction,
  BrowserManager,
  createAgentSocket,
  defaultDaemonConfigPath,
  formatOriginRulesAscii,
  isWildcardOriginRule,
  matchesOriginRule,
  mergeOriginRuleLists,
  normalizeOriginRule,
  parseOriginFlagValues,
  persistDaemonOriginRules,
  PolicyProfileGuard,
  readDaemonConfig,
  resolvePolicyProfile,
  validateDaemonConfig,
  writeDaemonConfig,
} from '../src/index.js'

function mkTmpDir(prefix = 'troy-origins-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('M79: Origin allowlist / denylist CLI flags (--allow-origin, --deny-origin) & daemon.json persistence', () => {
  let serverA: http.Server
  let serverB: http.Server
  let serverC: http.Server
  let originA = ''
  let originB = ''
  let originC = ''

  beforeAll(async () => {
    const startServer = (label: string, linkTo?: () => string) =>
      new Promise<{ server: http.Server; origin: string }>((resolve) => {
        const srv = http.createServer((_req, res) => {
          const linkHtml = linkTo ? `<a href="${linkTo()}/target">External Link</a>` : ''
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!doctype html><html><head><title>${label}</title></head><body><h1>${label}</h1>${linkHtml}</body></html>`)
        })
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as { port: number }
          resolve({ server: srv, origin: `http://127.0.0.1:${addr.port}` })
        })
      })

    const c = await startServer('Site C (Denied)')
    serverC = c.server
    originC = c.origin

    const b = await startServer('Site B (Allowed)')
    serverB = b.server
    originB = b.origin

    const a = await startServer('Site A (Home)', () => originC)
    serverA = a.server
    originA = a.origin
  })

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => serverA.close(() => r())),
      new Promise<void>((r) => serverB.close(() => r())),
      new Promise<void>((r) => serverC.close(() => r())),
    ])
  })

  describe('Origin rule normalization & wildcard matching', () => {
    it('normalizes exact origins, bare hosts, URLs with paths, and wildcard subdomain rules', () => {
      expect(normalizeOriginRule('https://Example.COM/docs/start')).toBe('https://example.com')
      expect(normalizeOriginRule('example.com')).toBe('https://example.com')
      expect(normalizeOriginRule('http://127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080')
      expect(normalizeOriginRule('https://*.Example.COM/path')).toBe('https://*.example.com')
      expect(normalizeOriginRule('https://*.example.com:443')).toBe('https://*.example.com')
      expect(normalizeOriginRule('http://*.internal.corp:8080')).toBe('http://*.internal.corp:8080')
      expect(normalizeOriginRule('*.tracker.net')).toBe('*.tracker.net')

      expect(isWildcardOriginRule('https://*.example.com')).toBe(true)
      expect(isWildcardOriginRule('*.tracker.net')).toBe(true)
      expect(isWildcardOriginRule('https://example.com')).toBe(false)
    })

    it('rejects non-http(s) schemes, bare wildcards, and malformed rules', () => {
      expect(normalizeOriginRule('javascript:alert(1)')).toBeNull()
      expect(normalizeOriginRule('file:///etc/passwd')).toBeNull()
      expect(normalizeOriginRule('data:text/html,<h1>x</h1>')).toBeNull()
      expect(normalizeOriginRule('ftp://files.example.com')).toBeNull()
      expect(normalizeOriginRule('*')).toBeNull()
      expect(normalizeOriginRule('https://*')).toBeNull()
      expect(normalizeOriginRule('*.localhost')).toBeNull()
      expect(normalizeOriginRule('https://*.example.com:99999')).toBeNull()
      expect(normalizeOriginRule('')).toBeNull()
    })

    it('matches exact and wildcard subdomain rules strictly without suffix-confusion bypasses', () => {
      // Exact match
      expect(matchesOriginRule('https://example.com', 'https://example.com/page')).toBe(true)
      expect(matchesOriginRule('https://example.com', 'http://example.com/page')).toBe(false)

      // Scheme-pinned wildcard
      expect(matchesOriginRule('https://*.example.com', 'https://docs.example.com/a')).toBe(true)
      expect(matchesOriginRule('https://*.example.com', 'https://a.b.example.com')).toBe(true)
      expect(matchesOriginRule('https://*.example.com', 'https://example.com')).toBe(false)
      expect(matchesOriginRule('https://*.example.com', 'http://docs.example.com')).toBe(false)
      expect(matchesOriginRule('https://*.example.com', 'https://notexample.com')).toBe(false)
      expect(matchesOriginRule('https://*.example.com', 'https://docs.example.com:8443')).toBe(false)

      // Port-pinned wildcard
      expect(matchesOriginRule('http://*.internal.test:8080', 'http://api.internal.test:8080/v1')).toBe(true)
      expect(matchesOriginRule('http://*.internal.test:8080', 'http://api.internal.test:9090/v1')).toBe(false)

      // Scheme-agnostic wildcard
      expect(matchesOriginRule('*.evil.test', 'https://ad.evil.test')).toBe(true)
      expect(matchesOriginRule('*.evil.test', 'http://ad.evil.test')).toBe(true)
      expect(matchesOriginRule('*.evil.test', 'https://evil.test')).toBe(false)
    })

    it('parses repeated and comma-separated CLI flag values and reports invalid entries', () => {
      const parsed = parseOriginFlagValues([
        'https://a.example.com, https://*.b.example.com/foo',
        'https://a.example.com',
        'javascript:alert(1)',
        'file:///etc/hosts',
      ])
      expect(parsed.valid).toEqual(['https://a.example.com', 'https://*.b.example.com'])
      expect(parsed.invalid).toEqual(['javascript:alert(1)', 'file:///etc/hosts'])

      expect(mergeOriginRuleLists(['https://a.example.com'], ['https://a.example.com', 'https://b.example.com'])).toEqual([
        'https://a.example.com',
        'https://b.example.com',
      ])
    })
  })

  describe('daemon.json config persistence & validation', () => {
    it('writes daemon.json atomically with 0600 permissions and merges/removes/clears rules', () => {
      const dir = mkTmpDir()
      try {
        const cfgPath = defaultDaemonConfigPath({ profileDir: dir })
        expect(cfgPath).toBe(path.join(dir, 'daemon.json'))
        expect(readDaemonConfig(cfgPath)).toBeNull()

        const written = writeDaemonConfig(cfgPath, {
          allowedOrigins: ['https://docs.example.com/guide', 'https://*.trusted.example'],
          deniedOrigins: ['https://evil.example/login'],
        })
        expect(written.version).toBe(1)
        expect(written.allowedOrigins).toEqual(['https://docs.example.com', 'https://*.trusted.example'])
        expect(written.deniedOrigins).toEqual(['https://evil.example'])

        if (process.platform !== 'win32') {
          expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600)
        }

        // Merge additional rules via persistDaemonOriginRules
        const merged = persistDaemonOriginRules(cfgPath, {
          allowOrigins: ['https://api.example.com'],
          denyOrigins: ['*.tracker.net'],
        })
        expect(merged.allowedOrigins).toEqual([
          'https://docs.example.com',
          'https://*.trusted.example',
          'https://api.example.com',
        ])
        expect(merged.deniedOrigins).toEqual(['https://evil.example', '*.tracker.net'])

        // Remove individual rules
        const afterRemove = persistDaemonOriginRules(cfgPath, {
          removeAllowed: ['https://docs.example.com'],
          removeDenied: ['https://evil.example'],
        })
        expect(afterRemove.allowedOrigins).toEqual(['https://*.trusted.example', 'https://api.example.com'])
        expect(afterRemove.deniedOrigins).toEqual(['*.tracker.net'])

        // Clear allowed only
        const afterClear = persistDaemonOriginRules(cfgPath, { clearAllowed: true })
        expect(afterClear.allowedOrigins).toEqual([])
        expect(afterClear.deniedOrigins).toEqual(['*.tracker.net'])

        const ascii = formatOriginRulesAscii({
          allowedOrigins: afterClear.allowedOrigins,
          deniedOrigins: afterClear.deniedOrigins,
          persistedAllowedOrigins: afterClear.allowedOrigins,
          persistedDeniedOrigins: afterClear.deniedOrigins,
          configFile: cfgPath,
          configExists: true,
        })
        expect(ascii).toContain('ORIGIN ALLOWLIST / DENYLIST')
        expect(ascii).toContain('*.tracker.net')
        expect(/^[\x09\x0a\x20-\x7e]+$/.test(ascii)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('rejects malformed daemon.json payloads cleanly', () => {
      const bad = validateDaemonConfig({
        version: 99,
        allowedOrigins: ['javascript:alert(1)'],
        deniedOrigins: 'not-an-array',
      })
      expect(bad.ok).toBe(false)
      expect(bad.errors.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('PolicyProfileGuard & authorizeAction wildcard allow/deny precedence', () => {
    it('authorizes wildcard allowedOrigins and always enforces deniedOrigins precedence', () => {
      const guard = new PolicyProfileGuard(
        resolvePolicyProfile({
          profile: 'standard',
          allowedOrigins: ['https://*.corp.example'],
          deniedOrigins: ['https://admin.corp.example', '*.evil.example'],
        }),
      )

      // Subdomain matching wildcard allowlist is authorized without manual grant
      const navOk = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'https://docs.corp.example/handbook',
        allowedOrigins: [],
        policy: guard,
      })
      expect(navOk.allowed).toBe(true)

      // Denied subdomain overrides wildcard allowlist
      const navDenied = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'https://admin.corp.example/secrets',
        allowedOrigins: ['https://admin.corp.example'],
        policy: guard,
      })
      expect(navDenied.allowed).toBe(false)
      if (!navDenied.allowed) {
        expect(navDenied.status).toBe('blocked')
        expect(navDenied.code).toBe('origin_denied')
      }

      // Wildcard denylist blocks links in page_click
      const linkDenied = authorizeAction({
        name: 'page_click',
        item: { tag: 'a', text: 'Click', href: 'https://track.evil.example/pixel' },
        allowedOrigins: ['https://track.evil.example'],
        policy: guard,
      })
      expect(linkDenied.allowed).toBe(false)
      if (!linkDenied.allowed) {
        expect(linkDenied.status).toBe('blocked')
        expect(linkDenied.code).toBe('origin_denied')
      }

      // Unlisted origin still hits origin boundary
      const navBoundary = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'https://other.example.org/',
        allowedOrigins: [],
        policy: guard,
      })
      expect(navBoundary.allowed).toBe(false)
      if (!navBoundary.allowed) {
        expect(navBoundary.status).toBe('boundary')
        expect(navBoundary.code).toBe('origin')
      }
    })
  })

  describe('BrowserManager & AgentSocket persistence across restarts', () => {
    it('auto-loads persisted daemon.json allowlist/denylist across manager restarts and enforces them', async () => {
      const profileDir = mkTmpDir('troy-mgr-origins-')
      const configFile = defaultDaemonConfigPath({ profileDir })
      try {
        // Simulate daemon started earlier with --allow-origin originB --deny-origin originC
        persistDaemonOriginRules(configFile, {
          allowOrigins: [originB],
          denyOrigins: [originC],
        })

        // Fresh BrowserManager (simulating daemon restart without passing CLI flags again)
        const manager = await BrowserManager.create({
          engine: 'lite',
          profileDir,
          memoryEnabled: false,
        })
        try {
          const rules = manager.getOriginRules()
          expect(rules.allowedOrigins).toContain(originB)
          expect(rules.deniedOrigins).toContain(originC)
          expect(rules.configExists).toBe(true)

          // Open tab on originA
          const opened = await manager.openTab(originA)
          expect(opened.ok).toBe(true)
          const tabId = opened.id!

          // Cross-origin navigation to originB succeeds because originB was persisted in daemon.json!
          const navB = await manager.runTool(tabId, 'page_navigate', { url: originB })
          expect(navB.ok).toBe(true)

          // Cross-origin navigation to originC is blocked with origin_denied
          const navC = await manager.runTool(tabId, 'page_navigate', { url: originC })
          expect(navC.ok).toBe(false)
          expect(navC.code).toBe('origin_denied')

          // openTab and grantOrigin on originC are also deterministically refused
          const openC = await manager.openTab(originC)
          expect(openC.ok).toBe(false)
          expect((openC as Record<string, unknown>).code).toBe('origin_denied')

          const grantC = manager.grantOrigin(originC)
          expect(grantC.ok).toBe(false)
          expect(grantC.code).toBe('origin_denied')
        } finally {
          await manager.close()
        }
      } finally {
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    })

    it('supports GET /origins, POST /origins mutations with persistence, and --readonly refusal', async () => {
      const profileDir = mkTmpDir('troy-sock-origins-')
      const manager = await BrowserManager.create({
        engine: 'lite',
        profileDir,
        memoryEnabled: false,
        allowOrigins: [originB],
      })
      const socket = await createAgentSocket(manager, { port: 0 })
      const base = `http://127.0.0.1:${socket.port}`
      const headers = { 'x-troy-agent': socket.token, 'content-type': 'application/json' }

      try {
        // GET /health includes originRules
        const healthRes = await fetch(`${base}/health`, { headers: { 'x-troy-agent': socket.token } })
        expect(healthRes.status).toBe(200)
        const healthJson = (await healthRes.json()) as Record<string, unknown>
        expect((healthJson.originRules as Record<string, unknown>).allowedOrigins).toContain(originB)

        // GET /origins lists rules + ASCII summary
        const listRes = await fetch(`${base}/origins`, { headers: { 'x-troy-agent': socket.token } })
        expect(listRes.status).toBe(200)
        const listJson = (await listRes.json()) as Record<string, unknown>
        expect(listJson.ok).toBe(true)
        expect(listJson.allowedOrigins).toContain(originB)
        expect(typeof listJson.ascii).toBe('string')

        // POST /origins deny originB immediately revokes it and persists to daemon.json
        const denyRes = await fetch(`${base}/origins`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'deny', origin: originB }),
        })
        expect(denyRes.status).toBe(200)
        const denyJson = (await denyRes.json()) as Record<string, unknown>
        expect(denyJson.ok).toBe(true)
        expect(denyJson.deniedOrigins).toContain(originB)

        // Verify persisted on disk
        const onDisk = readDaemonConfig(manager.daemonConfigFile)
        expect(onDisk?.deniedOrigins).toContain(originB)

        // Verify originB is now blocked immediately
        const openB = await manager.openTab(originB)
        expect(openB.ok).toBe(false)
        expect((openB as Record<string, unknown>).code).toBe('origin_denied')

        // Undeny originB
        const undenyRes = await fetch(`${base}/origins`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'undeny', origin: originB }),
        })
        expect(undenyRes.status).toBe(200)
        const onDiskAfter = readDaemonConfig(manager.daemonConfigFile)
        expect(onDiskAfter?.deniedOrigins).not.toContain(originB)
      } finally {
        await socket.close()
        await manager.close()
      }

      // Now verify --readonly mode refuses mutating /origins while permitting GET /origins
      const roManager = await BrowserManager.create({
        engine: 'lite',
        profileDir,
        memoryEnabled: false,
        readonly: true,
      })
      const roSocket = await createAgentSocket(roManager, { port: 0 })
      const roBase = `http://127.0.0.1:${roSocket.port}`
      try {
        const roList = await fetch(`${roBase}/origins`, {
          headers: { 'x-troy-agent': roSocket.token },
        })
        expect(roList.status).toBe(200)

        const roMutate = await fetch(`${roBase}/origins`, {
          method: 'POST',
          headers: { 'x-troy-agent': roSocket.token, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'allow', origin: 'https://new.example.com' }),
        })
        expect(roMutate.status).toBe(200)
        const roMutateJson = (await roMutate.json()) as Record<string, unknown>
        expect(roMutateJson.ok).toBe(false)
        expect(roMutateJson.status).toBe('blocked')
        expect(roMutateJson.code).toBe('readonly')
      } finally {
        await roSocket.close()
        await roManager.close()
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    })
  })

  describe('CLI origins command & flag validation', () => {
    it('persists allow/deny rules via CLI `origins` command and rejects invalid --allow-origin flags', () => {
      const dir = mkTmpDir('troy-cli-origins-')
      const cfgFile = path.join(dir, 'daemon.json')
      const bin = path.resolve('bin/troy-advanced.mjs')
      try {
        const allowOut = execFileSync(
          process.execPath,
          [bin, 'origins', 'allow', 'https://docs.example.com', '--daemon-config', cfgFile, '--json'],
          { encoding: 'utf8' },
        )
        const allowParsed = JSON.parse(allowOut) as Record<string, unknown>
        expect(allowParsed.ok).toBe(true)
        expect(allowParsed.allowedOrigins).toEqual(['https://docs.example.com'])

        const denyOut = execFileSync(
          process.execPath,
          [bin, 'origins', 'deny', 'https://*.evil.test', '--daemon-config', cfgFile, '--json'],
          { encoding: 'utf8' },
        )
        const denyParsed = JSON.parse(denyOut) as Record<string, unknown>
        expect(denyParsed.ok).toBe(true)
        expect(denyParsed.deniedOrigins).toEqual(['https://*.evil.test'])

        const listAscii = execFileSync(
          process.execPath,
          [bin, 'origins', 'list', '--daemon-config', cfgFile],
          { encoding: 'utf8' },
        )
        expect(listAscii).toContain('https://docs.example.com')
        expect(listAscii).toContain('https://*.evil.test')
        expect(/^[\x09\x0a\x20-\x7e]+$/.test(listAscii)).toBe(true)

        // Invalid --allow-origin flag fails cleanly with non-zero exit
        let failed = false
        try {
          execFileSync(
            process.execPath,
            [bin, 'origins', 'list', '--allow-origin', 'javascript:alert(1)', '--daemon-config', cfgFile],
            { encoding: 'utf8', stdio: 'pipe' },
          )
        } catch {
          failed = true
        }
        expect(failed).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
