import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  POLICY_PROFILE_PRESETS,
  PolicyProfileGuard,
  authorizeAction,
  createAgentSocket,
  createPolicyTemplate,
  defaultPolicyFilePath,
  formatPolicyAscii,
  loadPolicyFile,
  parsePolicyProfileName,
  resolvePolicyProfile,
  validatePolicyConfig,
  writePolicyFile,
} from '../src/index.js'

function mkTmpDir(prefix = 'troy-policy-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('M75: Configurable policy profiles (strict, standard, permissive) via policy.json', () => {
  describe('presets, parsing, validation, and policy.json persistence', () => {
    it('parses valid profile names case-insensitively and rejects invalid ones', () => {
      expect(parsePolicyProfileName('strict')).toBe('strict')
      expect(parsePolicyProfileName('STANDARD')).toBe('standard')
      expect(parsePolicyProfileName(' Permissive ')).toBe('permissive')
      expect(parsePolicyProfileName('yolo')).toBeUndefined()
      expect(parsePolicyProfileName(123)).toBeUndefined()
    })

    it('defines distinct security postures for strict, standard, and permissive presets', () => {
      expect(POLICY_PROFILE_PRESETS.strict.allowEval).toBe(false)
      expect(POLICY_PROFILE_PRESETS.strict.blockPrivateNet).toBe(true)
      expect(POLICY_PROFILE_PRESETS.strict.untrustedMarkers).toBe(true)
      expect(POLICY_PROFILE_PRESETS.strict.downloadMode).toBe('deny')
      expect(POLICY_PROFILE_PRESETS.strict.maxActSteps).toBe(10)
      expect(POLICY_PROFILE_PRESETS.strict.blockedTools).toContain('page_eval')

      expect(POLICY_PROFILE_PRESETS.standard.allowEval).toBe(true)
      expect(POLICY_PROFILE_PRESETS.standard.requireOriginGrant).toBe(true)
      expect(POLICY_PROFILE_PRESETS.standard.requireSubmitConfirmation).toBe(true)
      expect(POLICY_PROFILE_PRESETS.standard.blockPrivateNet).toBe(false)
      expect(POLICY_PROFILE_PRESETS.standard.untrustedMarkers).toBe(false)
      expect(POLICY_PROFILE_PRESETS.standard.downloadMode).toBe('quarantine')

      expect(POLICY_PROFILE_PRESETS.permissive.allowEval).toBe(true)
      expect(POLICY_PROFILE_PRESETS.permissive.requireOriginGrant).toBe(false)
      expect(POLICY_PROFILE_PRESETS.permissive.requireSubmitConfirmation).toBe(false)
      expect(POLICY_PROFILE_PRESETS.permissive.blockSensitiveFields).toBe(true)
      expect(POLICY_PROFILE_PRESETS.permissive.blockTrackers).toBe(false)
      expect(POLICY_PROFILE_PRESETS.permissive.downloadMode).toBe('allow')
      expect(POLICY_PROFILE_PRESETS.permissive.maxActSteps).toBe(100)
    })

    it('validates custom policy.json overrides, normalizes origins, and reports warnings', () => {
      const res = validatePolicyConfig({
        profile: 'strict',
        allowEval: true,
        maxActSteps: 25,
        allowedOrigins: ['https://Example.com/docs', 'https://example.com/other'],
        deniedOrigins: ['https://example.com', 'http://evil.test:8080/path'],
        extraSensitivePatterns: ['internal[- ]?token'],
        extraSubmitPatterns: ['publish now'],
        unknownFutureKey: true,
      })

      expect(res.ok).toBe(true)
      expect(res.resolved).toBeDefined()
      const r = res.resolved!
      expect(r.profile).toBe('strict')
      expect(r.allowEval).toBe(true)
      // Explicitly setting allowEval: true on strict removes default page_eval from blockedTools
      expect(r.blockedTools).not.toContain('page_eval')
      expect(r.maxActSteps).toBe(25)
      expect(r.allowedOrigins).toEqual(['https://example.com'])
      expect(r.deniedOrigins).toEqual(['https://example.com', 'http://evil.test:8080'])
      expect(r.customized).toBe(true)
      expect(r.warnings.some((w) => w.includes('unknownFutureKey'))).toBe(true)
      expect(r.warnings.some((w) => w.includes('deniedOrigins takes precedence'))).toBe(true)
    })

    it('rejects malformed policy configs with clear field errors', () => {
      const bad = validatePolicyConfig({
        profile: 'ultra',
        allowEval: 'yes',
        downloadMode: 'yeet',
        maxActSteps: 0,
        allowedOrigins: ['javascript:alert(1)'],
        extraSensitivePatterns: ['[unclosed'],
      })
      expect(bad.ok).toBe(false)
      expect(bad.errors.length).toBeGreaterThanOrEqual(6)
      expect(bad.errors.join('\n')).toContain('"profile"')
      expect(bad.errors.join('\n')).toContain('"allowEval"')
      expect(bad.errors.join('\n')).toContain('"downloadMode"')
      expect(bad.errors.join('\n')).toContain('"maxActSteps"')
      expect(bad.errors.join('\n')).toContain('"allowedOrigins[0]"')
      expect(bad.errors.join('\n')).toContain('"extraSensitivePatterns[0]"')
    })

    it('writes policy.json with 0600 permissions and auto-loads from profileDir', () => {
      const dir = mkTmpDir()
      try {
        const policyPath = defaultPolicyFilePath(dir)
        const template = createPolicyTemplate('strict')
        template.allowedOrigins = ['https://docs.example.com']
        writePolicyFile(policyPath, template)

        const stat = fs.statSync(policyPath)
        if (process.platform !== 'win32') {
          expect(stat.mode & 0o777).toBe(0o600)
        }

        const loaded = loadPolicyFile(policyPath)
        expect(loaded.profile).toBe('strict')
        expect(loaded.sourceFile).toBe(policyPath)
        expect(loaded.allowedOrigins).toEqual(['https://docs.example.com'])

        // Auto-discovery from profileDir
        const auto = resolvePolicyProfile(undefined, { profileDir: dir })
        expect(auto.profile).toBe('strict')
        expect(auto.sourceFile).toBe(policyPath)

        // Programmatic override on top of file
        const overridden = resolvePolicyProfile({ maxActSteps: 15 }, { profileDir: dir })
        expect(overridden.profile).toBe('strict')
        expect(overridden.maxActSteps).toBe(15)
        expect(overridden.allowedOrigins).toEqual(['https://docs.example.com'])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('formats strict 7-bit ASCII policy summary', () => {
      const resolved = resolvePolicyProfile('strict')
      const ascii = formatPolicyAscii(new PolicyProfileGuard(resolved).getStats(), { width: 72 })
      expect(ascii).toContain('POLICY PROFILE: STRICT')
      expect(ascii).toContain('allowEval')
      expect(ascii).toContain('blockPrivateNet (SSRF)')
      expect(ascii).toContain('untrustedMarkers')
      // Strict 7-bit ASCII check
      expect(/^[\x09\x0a\x20-\x7e]+$/.test(ascii)).toBe(true)
    })
  })

  describe('authorizeAction enforcement across profiles', () => {
    it('strict profile blocks page_eval, private net, ungranted origins, and submit clicks', () => {
      const strictGuard = new PolicyProfileGuard(resolvePolicyProfile('strict'))
      const allowedOrigins = ['https://app.example.com']

      const evalDecision = authorizeAction({
        name: 'page_eval',
        currentUrl: 'https://app.example.com/dashboard',
        allowedOrigins,
        policy: strictGuard,
      })
      expect(evalDecision.allowed).toBe(false)
      if (!evalDecision.allowed) {
        expect(evalDecision.status).toBe('blocked')
        expect(evalDecision.code).toBe('policy_tool_blocked')
      }

      const imdsDecision = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'http://169.254.169.254/latest/meta-data/',
        allowedOrigins: ['http://169.254.169.254'],
        policy: strictGuard,
      })
      expect(imdsDecision.allowed).toBe(false)
      if (!imdsDecision.allowed) {
        expect(imdsDecision.code).toBe('ssrf')
      }

      const submitDecision = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', text: 'Place order' },
        allowedOrigins,
        policy: strictGuard,
      })
      expect(submitDecision.allowed).toBe(false)
      if (!submitDecision.allowed) {
        expect(submitDecision.code).toBe('submit')
      }
    })

    it('permissive profile relaxes origin grant and submit confirmation while still blocking deniedOrigins and sensitive fields', () => {
      const permissiveGuard = new PolicyProfileGuard(
        resolvePolicyProfile({
          profile: 'permissive',
          deniedOrigins: ['https://forbidden.example.com'],
        }),
      )

      // Cross-origin navigation allowed without grant
      const navOk = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'https://other.example.org/page',
        allowedOrigins: ['https://start.example.com'],
        policy: permissiveGuard,
      })
      expect(navOk.allowed).toBe(true)

      // Denied origin still deterministically blocked
      const navDenied = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'https://forbidden.example.com/admin',
        allowedOrigins: ['https://forbidden.example.com'],
        policy: permissiveGuard,
      })
      expect(navDenied.allowed).toBe(false)
      if (!navDenied.allowed) {
        expect(navDenied.status).toBe('blocked')
        expect(navDenied.code).toBe('origin_denied')
      }

      // Commit/submit click allowed without allowSubmit: true
      const submitOk = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', text: 'Submit Order', defaultSubmit: true },
        allowedOrigins: [],
        policy: permissiveGuard,
      })
      expect(submitOk.allowed).toBe(true)

      // Password field STILL blocked by default in permissive
      const pwBlocked = authorizeAction({
        name: 'page_fill',
        item: { tag: 'input', type: 'password', name: 'pwd' },
        allowedOrigins: [],
        policy: permissiveGuard,
      })
      expect(pwBlocked.allowed).toBe(false)
      if (!pwBlocked.allowed) {
        expect(pwBlocked.code).toBe('sensitive')
      }

      // Non-HTTP scheme STILL blocked in permissive
      const schemeBlocked = authorizeAction({
        name: 'page_navigate',
        targetUrl: 'javascript:alert(1)',
        allowedOrigins: [],
        policy: permissiveGuard,
      })
      expect(schemeBlocked.allowed).toBe(false)
      if (!schemeBlocked.allowed) {
        expect(schemeBlocked.code).toBe('scheme')
      }
    })

    it('enforces custom extraSensitivePatterns and extraSubmitPatterns from policy.json', () => {
      const customGuard = new PolicyProfileGuard(
        resolvePolicyProfile({
          profile: 'standard',
          extraSensitivePatterns: ['internal[- ]?deploy[- ]?key'],
          extraSubmitPatterns: ['launch production'],
        }),
      )

      const sens = authorizeAction({
        name: 'page_fill',
        item: { tag: 'input', type: 'text', label: 'Internal Deploy Key' },
        allowedOrigins: ['https://ops.example.com'],
        policy: customGuard,
      })
      expect(sens.allowed).toBe(false)
      if (!sens.allowed) {
        expect(sens.code).toBe('sensitive')
      }

      const sub = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', text: 'Launch Production' },
        allowedOrigins: ['https://ops.example.com'],
        policy: customGuard,
      })
      expect(sub.allowed).toBe(false)
      if (!sub.allowed) {
        expect(sub.code).toBe('submit')
      }
    })
  })

  describe('BrowserManager + Agent Socket integration', () => {
    let serverA: http.Server
    let serverB: http.Server
    let urlA: string
    let urlB: string

    beforeAll(async () => {
      serverA = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html><head><title>Site A</title></head>
          <body>
            <h1>Site A</h1>
            <form action="/done" method="get">
              <label for="q">Query</label>
              <input id="q" name="q" type="text" />
              <button type="submit">Submit Order</button>
            </form>
            <a href="${urlB}/">Go to Site B</a>
          </body></html>`)
      })
      serverB = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><title>Site B</title></head><body><h1>Site B</h1></body></html>')
      })

      await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', () => resolve()))
      await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', () => resolve()))
      const addrA = serverA.address() as { port: number }
      const addrB = serverB.address() as { port: number }
      urlA = `http://127.0.0.1:${addrA.port}`
      urlB = `http://127.0.0.1:${addrB.port}`
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => serverA.close(() => resolve()))
      await new Promise<void>((resolve) => serverB.close(() => resolve()))
    })

    it('auto-loads strict policy.json, applies defaults (SSRF, untrustedMarkers, downloadMode, blockedTools, maxActSteps), and exposes /policy & /health', async () => {
      const profileDir = mkTmpDir('troy-policy-strict-')
      const policyPath = defaultPolicyFilePath(profileDir)
      writePolicyFile(policyPath, {
        profile: 'strict',
        maxActSteps: 2,
      })

      const manager = await BrowserManager.create({
        engine: 'lite',
        profileDir,
        memoryEnabled: false,
      })
      const socket = await createAgentSocket(manager, { port: 0 })

      try {
        expect(manager.policy.profile).toBe('strict')
        expect(manager.ssrf.enabled).toBe(true)
        expect(manager.untrustedMarkers.enabled).toBe(true)
        expect(manager.getDownloadStats().mode).toBe('deny')

        // /health includes policy stats
        const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
          headers: { 'x-troy-agent': socket.token },
        })
        const health = (await healthRes.json()) as Record<string, any>
        expect(health.ok).toBe(true)
        expect(health.policy.profile).toBe('strict')
        expect(health.policy.sourceFile).toBe(policyPath)
        expect(health.policy.maxActSteps).toBe(2)

        // /policy returns full policy profile + ASCII view
        const policyRes = await fetch(`http://127.0.0.1:${socket.port}/policy`, {
          headers: { 'x-troy-agent': socket.token },
        })
        const policyPayload = (await policyRes.json()) as Record<string, any>
        expect(policyPayload.ok).toBe(true)
        expect(policyPayload.profile).toBe('strict')
        expect(policyPayload.ascii).toContain('POLICY PROFILE: STRICT')

        // page_eval is deterministically blocked by strict profile
        const evalRes = await manager.runTool(undefined, 'page_eval', { expression: '1 + 1' })
        expect(evalRes.ok).toBe(false)
        expect(evalRes.code).toBe('policy_tool_blocked')

        // page_act exceeding maxActSteps (2) is deterministically refused
        await manager.openTab()
        const actRes = await manager.runTool(undefined, 'page_act', {
          steps: [{ op: 'wait', ms: 1 }, { op: 'wait', ms: 1 }, { op: 'wait', ms: 1 }],
        })
        expect(actRes.ok).toBe(false)
        expect(actRes.code).toBe('policy_act_limit')

        // Audit log captures policy refusals
        const refusals = manager.getAuditLog({ refusedOnly: true })
        expect(refusals.some((e) => e.refusal?.code === 'policy_tool_blocked')).toBe(true)
        expect(refusals.some((e) => e.refusal?.code === 'policy_act_limit')).toBe(true)
      } finally {
        await socket.close()
        await manager.close()
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    })

    it('permissive profile allows cross-origin navigation and submit clicks while enforcing deniedOrigins', async () => {
      const profileDir = mkTmpDir('troy-policy-perm-')
      const manager = await BrowserManager.create({
        engine: 'lite',
        profileDir,
        memoryEnabled: false,
        policy: {
          profile: 'permissive',
          deniedOrigins: ['https://blocked.example.com'],
        },
      })

      try {
        expect(manager.policy.profile).toBe('permissive')
        expect(manager.ssrf.enabled).toBe(false)
        expect(manager.untrustedMarkers.enabled).toBe(false)
        expect(manager.getDownloadStats().mode).toBe('allow')

        const opened = await manager.openTab(urlA, { activate: true })
        expect(opened.ok).toBe(true)
        const tabId = opened.id!

        // Read snapshot and click submit button WITHOUT allowSubmit: true
        const readRes = await manager.runTool(tabId, 'page_read', {})
        expect(readRes.ok).toBe(true)
        const elements = readRes.elements as Array<{ ref: string; text: string; tag: string }>
        const submitBtn = elements.find((e) => e.tag === 'button')
        expect(submitBtn).toBeDefined()

        const clickRes = await manager.runTool(tabId, 'page_click', { ref: submitBtn!.ref })
        expect(clickRes.ok).toBe(true)

        // Cross-origin navigation to urlB succeeds without grantOrigin
        const navRes = await manager.runTool(tabId, 'page_navigate', { url: urlB })
        expect(navRes.ok).toBe(true)
        expect(String(navRes.url)).toContain(urlB)

        // deniedOrigins is still enforced in openTab, grantOrigin, and page_navigate
        const grantDenied = manager.grantOrigin('https://blocked.example.com')
        expect(grantDenied.ok).toBe(false)
        expect((grantDenied as Record<string, unknown>).code).toBe('origin_denied')

        const openDenied = await manager.openTab('https://blocked.example.com/secret')
        expect(openDenied.ok).toBe(false)
        expect((openDenied as Record<string, unknown>).code).toBe('origin_denied')

        const navDenied = await manager.runTool(tabId, 'page_navigate', {
          url: 'https://blocked.example.com/secret',
        })
        expect(navDenied.ok).toBe(false)
        expect(navDenied.code).toBe('origin_denied')
      } finally {
        await manager.close()
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    })

    it('pre-seeds allowedOrigins from policy.json so cross-origin navigation works in standard profile', async () => {
      const profileDir = mkTmpDir('troy-policy-std-')
      const policyPath = path.join(profileDir, 'custom-policy.json')
      writePolicyFile(policyPath, {
        profile: 'standard',
        allowedOrigins: [urlB],
      })

      const manager = await BrowserManager.create({
        engine: 'lite',
        profileDir,
        policyFile: policyPath,
        memoryEnabled: false,
      })

      try {
        const opened = await manager.openTab(urlA, { activate: true })
        expect(opened.ok).toBe(true)
        const navRes = await manager.runTool(opened.id!, 'page_navigate', { url: urlB })
        expect(navRes.ok).toBe(true)
        expect(String(navRes.url)).toContain(urlB)
      } finally {
        await manager.close()
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    })
  })
})
