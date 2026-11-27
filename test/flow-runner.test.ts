import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  createAgentSocket,
  createDaemonFlowExecutor,
  createManagerFlowExecutor,
  formatFlowReportAscii,
  interpolateString,
  interpolateValue,
  parseFlowJson,
  parseVarOverrides,
  resolveFlowUrl,
  runFlow,
} from '../src/index.js'

const execFileAsync = promisify(execFile)

function isStrict7BitAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code === 10 || code === 13 || code === 9) continue
    if (code < 32 || code > 126) return false
  }
  return true
}

describe('M64: Replayable macro/script runner (troy-advanced run <flow.json>)', () => {
  let server: http.Server
  let baseUrl: string
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-flow-runner-'))

    server = http.createServer((req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1')

      if (urlObj.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Acme Portal — Login</title></head>
  <body>
    <h1>Sign In to Acme</h1>
    <p>Enter your workspace handle and role to continue.</p>
    <form action="/welcome" method="get">
      <label for="user">Username</label>
      <input id="user" name="user" type="text" placeholder="alice" />
      <label for="role">Role</label>
      <select id="role" name="role">
        <option value="viewer">Viewer</option>
        <option value="admin">Admin</option>
      </select>
      <button type="submit">Continue</button>
    </form>
    <nav>
      <a href="/catalog">Browse Catalog</a>
    </nav>
  </body>
</html>`)
        return
      }

      if (urlObj.pathname === '/welcome') {
        const user = urlObj.searchParams.get('user') || 'guest'
        const role = urlObj.searchParams.get('role') || 'viewer'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Welcome ${user}</title></head>
  <body>
    <h1>Welcome, ${user}!</h1>
    <p>Assigned role: ${role}</p>
    <p>Status: Active workspace session.</p>
    <a href="/catalog">Open Product Catalog</a>
  </body>
</html>`)
        return
      }

      if (urlObj.pathname === '/catalog') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Acme Catalog</title></head>
  <body>
    <h1>Product Catalog</h1>
    <table>
      <thead><tr><th>SKU</th><th>Product</th><th>Price</th></tr></thead>
      <tbody>
        <tr><td>A-100</td><td>Terminal Widget</td><td>$19</td></tr>
        <tr><td>B-200</td><td>ASCII Monitor</td><td>$49</td></tr>
      </tbody>
    </table>
    <a href="/login">Back to Login</a>
  </body>
</html>`)
        return
      }

      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Not Found</title></head><body><h1>404 Missing</h1></body></html>')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind test HTTP server')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('Flow parser & interpolation helpers', () => {
    it('parses valid flows, supports action alias, and normalizes inline assert steps', () => {
      const flow = parseFlowJson(
        JSON.stringify({
          name: 'Smoke Test',
          baseUrl: 'http://127.0.0.1:8080',
          vars: { user: 'alice' },
          steps: [
            { action: 'open', url: '/login' },
            { op: 'assert', titleContains: 'Login', textContains: 'Sign In' },
          ],
        }),
      )
      expect(flow.name).toBe('Smoke Test')
      expect(flow.steps).toHaveLength(2)
      expect(flow.steps[0]!.op).toBe('open')
      expect(flow.steps[1]!.assertions).toHaveLength(1)
      expect(flow.steps[1]!.assertions![0]!.titleContains).toBe('Login')
    })

    it('rejects malformed JSON and invalid steps with descriptive errors', () => {
      expect(() => parseFlowJson('{bad json')).toThrow(/Invalid flow JSON/)
      expect(() => parseFlowJson('[]')).toThrow(/must be an object/)
      expect(() => parseFlowJson('{"steps":[]}')).toThrow(/non-empty "steps"/)
      expect(() => parseFlowJson('{"steps":[{"op":"teleport"}]}')).toThrow(/unsupported op "teleport"/)
      expect(() => parseFlowJson('{"steps":[{"op":"open"}]}')).toThrow(/requires a string "url"/)
      expect(() => parseFlowJson('{"steps":[{"op":"click"}]}')).toThrow(/requires "ref" or "find"/)
      expect(() => parseFlowJson('{"steps":[{"op":"fill","ref":"e1"}]}')).toThrow(/requires.*string "text"/)
      expect(() => parseFlowJson('{"steps":[{"op":"assert"}]}')).toThrow(/at least one assertion/)
    })

    it('interpolates {{var}} placeholders and resolves relative URLs', () => {
      const vars = { handle: 'bob', role: 'admin' }
      expect(interpolateString('Hello {{handle}} ({{role}}) {{unknown}}', vars)).toBe(
        'Hello bob (admin) {{unknown}}',
      )
      expect(interpolateValue({ a: '{{handle}}', nested: ['{{role}}', 42] }, vars)).toEqual({
        a: 'bob',
        nested: ['admin', 42],
      })
      expect(resolveFlowUrl('/login', 'http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999/login')
      expect(resolveFlowUrl('https://example.com/x', 'http://127.0.0.1:9999')).toBe(
        'https://example.com/x',
      )
      expect(parseVarOverrides(['user=alice', 'token=a=b=c'])).toEqual({
        user: 'alice',
        token: 'a=b=c',
      })
      expect(() => parseVarOverrides(['missingEquals'])).toThrow(/expected key=value/)
    })
  })

  describe('In-process BrowserManager execution (Lite engine)', () => {
    it('replays a multi-step login + catalog flow with variable binding, policy refusal checks, and assertions', async () => {
      const manager = await BrowserManager.create({
        engine: 'lite',
        memoryEnabled: false,
      })

      try {
        const flow = parseFlowJson(
          JSON.stringify({
            name: 'Login & Catalog Flow',
            baseUrl,
            vars: { username: 'anish', role: 'admin' },
            steps: [
              {
                op: 'open',
                name: 'Open login page',
                url: '/login',
                assert: [
                  { urlContains: '/login' },
                  { titleContains: 'Login' },
                  { textContains: 'Sign In to Acme' },
                  { elementExists: 'Username', minCount: 1 },
                  { elementNotExists: 'NonExistentWidget' },
                ],
              },
              {
                op: 'fill',
                name: 'Fill username',
                find: 'Username',
                text: '{{username}}',
              },
              {
                op: 'select',
                name: 'Select admin role',
                find: 'Role',
                value: '{{role}}',
              },
              {
                op: 'click',
                name: 'Verify submit guard blocks accidental submit',
                find: 'Continue',
                expectRefused: true,
                refusedCode: 'submit',
              },
              {
                op: 'click',
                name: 'Submit login form explicitly',
                find: 'Continue',
                allowSubmit: true,
                assert: [
                  { urlContains: '/welcome' },
                  { urlMatches: 'user=anish.*role=admin', caseInsensitive: true },
                  { titleEquals: 'Welcome anish' },
                  { textContains: 'Assigned role: admin', caseInsensitive: true },
                  { textNotContains: '404 Missing' },
                ],
              },
              {
                op: 'find',
                name: 'Capture catalog link ref',
                query: 'Open Product Catalog',
                saveAs: 'catalogRef',
              },
              {
                op: 'click',
                name: 'Navigate via saved ref',
                ref: '{{catalogRef}}',
              },
              {
                op: 'assert',
                name: 'Verify catalog table & headings',
                assertions: [
                  { urlEquals: `${baseUrl}/catalog` },
                  { titleContains: 'Catalog' },
                  { textMatches: 'Terminal Widget.*\\$19' },
                  { extractCount: { section: 'tables', equals: 1 } },
                  { extractCount: { section: 'headings', min: 1 } },
                  { consoleNoErrors: true },
                ],
              },
            ],
          }),
        )

        const executor = createManagerFlowExecutor(manager)
        const report = await runFlow(flow, executor)

        expect(report.ok).toBe(true)
        expect(report.failedSteps).toBe(0)
        expect(report.skippedSteps).toBe(0)
        expect(report.passedSteps).toBe(8)
        expect(report.failedAssertions).toBe(0)
        expect(report.passedAssertions).toBeGreaterThanOrEqual(15)
        expect(report.failureDumps).toHaveLength(0)
        expect(typeof report.vars.catalogRef).toBe('string')
        expect(String(report.vars.catalogRef)).toMatch(/^e\d+$/)

        const asciiReport = formatFlowReportAscii(report)
        expect(isStrict7BitAscii(asciiReport)).toBe(true)
        expect(asciiReport).toContain('FLOW [PASS] Login & Catalog Flow')
        expect(asciiReport).toContain('-> $catalogRef')
      } finally {
        await manager.close()
      }
    })

    it('captures strict 7-bit ASCII failure dumps, writes dump files, and stops on failure by default', async () => {
      const manager = await BrowserManager.create({
        engine: 'lite',
        memoryEnabled: false,
      })
      const dumpDir = path.join(tmpDir, 'dumps')

      try {
        const flow = parseFlowJson(
          JSON.stringify({
            name: 'Failing Assertion Flow',
            baseUrl,
            steps: [
              { op: 'open', url: '/catalog' },
              {
                op: 'assert',
                name: 'Expect wrong title',
                titleEquals: 'Totally Different Title',
                textContains: 'Nonexistent Phrase',
              },
              { op: 'open', name: 'Should be skipped', url: '/login' },
            ],
          }),
        )

        const report = await runFlow(flow, createManagerFlowExecutor(manager), {
          dumpDir,
          dumpWidth: 80,
          dumpHeight: 24,
        })

        expect(report.ok).toBe(false)
        expect(report.passedSteps).toBe(1)
        expect(report.failedSteps).toBe(1)
        expect(report.skippedSteps).toBe(1)
        expect(report.steps[2]!.skipped).toBe(true)
        expect(report.failureDumps).toHaveLength(1)

        const dump = report.failureDumps[0]!
        expect(dump.stepIndex).toBe(1)
        expect(dump.url).toBe(`${baseUrl}/catalog`)
        expect(dump.title).toBe('Acme Catalog')
        expect(dump.ascii).toContain('PRODUCT CATALOG')
        expect(isStrict7BitAscii(dump.ascii)).toBe(true)
        expect(dump.savedPath).toBeTruthy()
        expect(fs.existsSync(dump.savedPath!)).toBe(true)

        const savedText = fs.readFileSync(dump.savedPath!, 'utf8')
        expect(savedText).toContain('=== TROY FLOW FAILURE DUMP ===')
        expect(savedText).toContain('PRODUCT CATALOG')
        expect(isStrict7BitAscii(savedText)).toBe(true)

        const asciiReport = formatFlowReportAscii(report)
        expect(isStrict7BitAscii(asciiReport)).toBe(true)
        expect(asciiReport).toContain('FLOW [FAIL] Failing Assertion Flow')
        expect(asciiReport).toContain('[SKIP] #03 Should be skipped')
        expect(asciiReport).toContain('ASCII FAILURE DUMP: step #2')
        expect(asciiReport).toContain('PRODUCT CATALOG')
      } finally {
        await manager.close()
      }
    })

    it('supports stopOnFailure: false to collect all failures across a flow', async () => {
      const manager = await BrowserManager.create({
        engine: 'lite',
        memoryEnabled: false,
      })

      try {
        const flow = parseFlowJson(
          JSON.stringify({
            name: 'Continue On Error Flow',
            baseUrl,
            stopOnFailure: false,
            steps: [
              { op: 'open', url: '/login' },
              { op: 'assert', name: 'First bad check', textContains: 'MISSING_ONE' },
              { op: 'open', url: '/catalog' },
              { op: 'assert', name: 'Second bad check', textContains: 'MISSING_TWO' },
            ],
          }),
        )

        const report = await runFlow(flow, createManagerFlowExecutor(manager))
        expect(report.ok).toBe(false)
        expect(report.passedSteps).toBe(2)
        expect(report.failedSteps).toBe(2)
        expect(report.skippedSteps).toBe(0)
        expect(report.failureDumps).toHaveLength(2)
        expect(report.failureDumps[0]!.url).toContain('/login')
        expect(report.failureDumps[1]!.url).toContain('/catalog')
      } finally {
        await manager.close()
      }
    })
  })

  describe('Live Agent Socket daemon execution', () => {
    it('executes flows over HTTP against AgentSocketServer with session isolation', async () => {
      const manager = await BrowserManager.create({
        engine: 'lite',
        memoryEnabled: false,
      })
      const socket = await createAgentSocket(manager, { port: 0 })

      try {
        const flow = parseFlowJson(
          JSON.stringify({
            name: 'Daemon Flow',
            baseUrl,
            steps: [
              { op: 'open', url: '/catalog' },
              {
                op: 'assert',
                urlEquals: `${baseUrl}/catalog`,
                textContains: 'ASCII Monitor',
              },
            ],
          }),
        )

        const executor = createDaemonFlowExecutor({
          agentPort: socket.port,
          agentToken: socket.token,
          sessionId: 'flow-bot-1',
        })
        const report = await runFlow(flow, executor)
        expect(report.ok).toBe(true)
        expect(report.passedSteps).toBe(2)

        const sessions = manager.listSessions()
        expect(sessions.some((s) => s.id === 'flow-bot-1')).toBe(true)
      } finally {
        await socket.close()
        await manager.close()
      }
    })
  })

  describe('CLI `troy-advanced run <flow.json>` integration', () => {
    it('runs a passing flow with --oneshot --var --base-url --json and exits 0', async () => {
      const flowFile = path.join(tmpDir, 'pass-flow.json')
      fs.writeFileSync(
        flowFile,
        JSON.stringify({
          name: 'CLI Pass Flow',
          steps: [
            { op: 'open', url: '/welcome?user={{who}}&role=admin' },
            { op: 'assert', titleEquals: 'Welcome {{who}}', textContains: 'Assigned role: admin' },
          ],
        }),
        'utf8',
      )

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          path.resolve('bin/troy-advanced.mjs'),
          'run',
          flowFile,
          '--oneshot',
          '--engine',
          'lite',
          '--base-url',
          baseUrl,
          '--var',
          'who=dexter',
          '--json',
        ],
        { cwd: process.cwd() },
      )

      const parsed = JSON.parse(stdout)
      expect(parsed.ok).toBe(true)
      expect(parsed.name).toBe('CLI Pass Flow')
      expect(parsed.passedSteps).toBe(2)
      expect(parsed.passedAssertions).toBe(2)
    })

    it('exits with code 1 and prints strict 7-bit ASCII failure dump on failed flow', async () => {
      const flowFile = path.join(tmpDir, 'fail-flow.json')
      fs.writeFileSync(
        flowFile,
        JSON.stringify({
          name: 'CLI Fail Flow',
          baseUrl,
          steps: [
            { op: 'open', url: '/catalog' },
            { op: 'assert', textContains: 'THIS_WILL_FAIL' },
          ],
        }),
        'utf8',
      )

      let exitCode = 0
      let stdout = ''
      try {
        const res = await execFileAsync(
          process.execPath,
          [path.resolve('bin/troy-advanced.mjs'), 'run', flowFile, '--oneshot', '--engine', 'lite'],
          { cwd: process.cwd() },
        )
        stdout = res.stdout
      } catch (err) {
        const e = err as { code?: number; stdout?: string }
        exitCode = e.code ?? 1
        stdout = e.stdout ?? ''
      }

      expect(exitCode).toBe(1)
      expect(stdout).toContain('FLOW [FAIL] CLI Fail Flow')
      expect(stdout).toContain('ASCII FAILURE DUMP')
      expect(stdout).toContain('PRODUCT CATALOG')
      expect(isStrict7BitAscii(stdout)).toBe(true)
    })
  })
})
