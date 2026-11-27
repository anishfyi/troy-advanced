import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AuditLogger,
  computeAuditStats,
  extractRefusalInfo,
  filterAuditEntries,
  formatAuditAscii,
  parseAuditEventKind,
  readAuditJsonl,
  sanitizeAuditArgs,
} from '../src/agent/audit.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { isStrictAscii } from '../src/ascii/sanitize.js'
import { main as cliMain } from '../src/cli.js'

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('M60: Agent action audit log (audit.jsonl)', () => {
  describe('AuditLogger unit & helpers', () => {
    it('appends JSONL entries with 0600 permissions, redacts sensitive args, and resumes seq across restarts', () => {
      const dir = mkTmpDir('troy-audit-unit-')
      const filePath = path.join(dir, 'audit.jsonl')
      try {
        const logger = new AuditLogger({ filePath, maxMemoryEntries: 10 })
        const e1 = logger.record({
          kind: 'tool_call',
          tool: 'page_fill',
          tabId: 1,
          ok: true,
          refused: false,
          durationMs: 12,
          args: {
            ref: 'e2',
            password: 'super-secret-password',
            nested: { apiKey: 'sk-123', safe: 'ok' },
            longText: 'x'.repeat(250),
          },
          summary: 'fill e2',
          fromUrl: 'https://example.com/login',
          toUrl: 'https://example.com/login',
        })
        expect(e1).not.toBeNull()
        expect(e1!.seq).toBe(1)
        expect(e1!.args?.password).toBe('[REDACTED]')
        expect((e1!.args?.nested as Record<string, unknown>)?.apiKey).toBe('[REDACTED]')
        expect((e1!.args?.nested as Record<string, unknown>)?.safe).toBe('ok')
        expect(String(e1!.args?.longText)).toContain('...(250 chars)')

        const e2 = logger.record({
          kind: 'tool_call',
          tool: 'page_navigate',
          tabId: 1,
          ok: false,
          refused: true,
          refusal: {
            status: 'boundary',
            code: 'origin',
            reason: 'target origin not granted',
            origin: 'https://other.example',
          },
          durationMs: 4,
          fromUrl: 'https://example.com/login',
          toUrl: 'https://example.com/login',
          error: 'target origin not granted',
        })
        expect(e2!.seq).toBe(2)

        const e3 = logger.record({
          kind: 'tool_call',
          tool: 'page_click',
          tabId: 1,
          ok: true,
          refused: false,
          durationMs: 25,
          fromUrl: 'https://example.com/login',
          toUrl: 'https://example.com/dashboard',
          urlChanged: true,
        })
        expect(e3!.seq).toBe(3)

        // Check file exists and has 0600 permissions on POSIX
        expect(fs.existsSync(filePath)).toBe(true)
        if (process.platform !== 'win32') {
          const mode = fs.statSync(filePath).mode & 0o777
          expect(mode).toBe(0o600)
        }

        // Verify JSONL on disk
        const diskEntries = readAuditJsonl(filePath)
        expect(diskEntries).toHaveLength(3)
        expect(diskEntries.map((e) => e.seq)).toEqual([1, 2, 3])
        expect(diskEntries[1]!.refused).toBe(true)
        expect(diskEntries[1]!.refusal?.code).toBe('origin')
        expect(diskEntries[2]!.urlChanged).toBe(true)

        // Verify stats
        const stats = logger.stats()
        expect(stats.totalEntries).toBe(3)
        expect(stats.toolCalls).toBe(3)
        expect(stats.refusals).toBe(1)
        expect(stats.errors).toBe(0)
        expect(stats.urlTransitions).toBe(1)
        expect(stats.maxDurationMs).toBe(25)
        expect(stats.byTool.page_fill).toBe(1)
        expect(stats.byRefusalCode.origin).toBe(1)

        // Verify ASCII formatter produces strict 7-bit ASCII
        const ascii = formatAuditAscii(diskEntries, stats, { width: 130 })
        expect(isStrictAscii(ascii)).toBe(true)
        expect(ascii).toContain('AUDIT LOG (enabled)')
        expect(ascii).toContain('REFUSED')
        expect(ascii).toContain('[origin] target origin not granted')
        expect(ascii).toContain('https://example.com/login -> https://example.com/dashboard')

        // Restarting AuditLogger on same file resumes seq from 4
        const restarted = new AuditLogger({ filePath })
        const e4 = restarted.record({
          kind: 'tab_action',
          tool: 'tab_close',
          tabId: 1,
          ok: true,
          refused: false,
          durationMs: 2,
          fromUrl: 'https://example.com/dashboard',
        })
        expect(e4!.seq).toBe(4)
        expect(readAuditJsonl(filePath)).toHaveLength(4)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('supports ring-buffer rollover with fromDisk query, filtering, clear/truncate, and disabled mode', () => {
      const dir = mkTmpDir('troy-audit-ring-')
      const filePath = path.join(dir, 'audit.jsonl')
      const disabledPath = path.join(dir, 'disabled.jsonl')
      try {
        const disabled = new AuditLogger({ filePath: disabledPath, enabled: false })
        expect(
          disabled.record({
            kind: 'tool_call',
            tool: 'page_read',
            ok: true,
            refused: false,
            durationMs: 1,
          }),
        ).toBeNull()
        expect(fs.existsSync(disabledPath)).toBe(false)

        const logger = new AuditLogger({ filePath, maxMemoryEntries: 10, redactArgs: false })
        for (let i = 1; i <= 15; i++) {
          logger.record({
            kind: i % 5 === 0 ? 'refusal' : 'tool_call',
            tool: i % 2 === 0 ? 'page_click' : 'page_read',
            tabId: i % 3,
            ok: i % 5 !== 0 && i !== 7,
            refused: i % 5 === 0,
            refusal: i % 5 === 0 ? { status: 'blocked', code: 'submit', reason: 'blocked submit' } : undefined,
            durationMs: i,
            args: { token: `raw-${i}` },
            urlChanged: i === 6 || i === 12,
            tsMs: 1_700_000_000_000 + i * 1000,
          })
        }

        // Memory holds only the last 10 entries; disk holds all 15
        expect(logger.query()).toHaveLength(10)
        expect(logger.query({ fromDisk: true })).toHaveLength(15)
        expect(logger.query({ fromDisk: true, refusedOnly: true })).toHaveLength(3)
        expect(logger.query({ fromDisk: true, urlChangedOnly: true })).toHaveLength(2)
        expect(logger.query({ fromDisk: true, failedOnly: true })).toHaveLength(4)
        expect(logger.query({ fromDisk: true, tool: 'page_click', limit: 3 })).toHaveLength(3)
        expect(logger.query({ fromDisk: true, sinceMs: 1_700_000_012_000 })).toHaveLength(4)
        expect(logger.query({ fromDisk: true })[0]!.args?.token).toBe('raw-1')

        // Append a corrupt line and verify readAuditJsonl ignores it gracefully
        fs.appendFileSync(filePath, 'not-valid-json\n\n', 'utf8')
        expect(readAuditJsonl(filePath)).toHaveLength(15)

        // Clear memory only
        const c1 = logger.clear({ truncateFile: false })
        expect(c1.clearedMemory).toBe(10)
        expect(c1.truncatedFile).toBe(false)
        expect(logger.query()).toHaveLength(0)
        expect(logger.query({ fromDisk: true })).toHaveLength(15)

        // Clear + truncate file
        const c2 = logger.clear({ truncateFile: true })
        expect(c2.truncatedFile).toBe(true)
        expect(readAuditJsonl(filePath)).toHaveLength(0)
        const next = logger.record({
          kind: 'tool_call',
          tool: 'page_read',
          ok: true,
          refused: false,
          durationMs: 3,
        })
        expect(next!.seq).toBe(1)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('extracts refusal info from direct policy responses and nested page_act step refusals', () => {
      expect(extractRefusalInfo({ ok: true })).toBeUndefined()
      expect(
        extractRefusalInfo({
          ok: false,
          status: 'blocked',
          code: 'sensitive_field',
          reason: 'refusing to fill password field',
        }),
      ).toEqual({
        status: 'blocked',
        code: 'sensitive_field',
        reason: 'refusing to fill password field',
      })
      expect(
        extractRefusalInfo({
          ok: false,
          allowed: false,
          code: 'origin',
          origin: 'https://evil.example',
          reason: 'origin not granted',
        }),
      ).toEqual({
        status: 'refused',
        code: 'origin',
        origin: 'https://evil.example',
        reason: 'origin not granted',
      })
      expect(
        extractRefusalInfo({
          ok: false,
          stoppedAt: 1,
          results: [
            { ok: true, op: 'fill', ref: 'e1' },
            { ok: false, status: 'blocked', code: 'submit', reason: 'submit requires allowSubmit' },
          ],
        }),
      ).toEqual({
        status: 'blocked',
        code: 'submit',
        reason: 'submit requires allowSubmit',
      })

      expect(parseAuditEventKind('tool_call')).toBe('tool_call')
      expect(parseAuditEventKind('origin_grant')).toBe('origin_grant')
      expect(parseAuditEventKind('unknown')).toBeUndefined()
      expect(sanitizeAuditArgs({ a: 1, secretKey: 'abc' })).toEqual({ a: 1, secretKey: '[REDACTED]' })
    })
  })

  describe('BrowserManager + Agent Socket + CLI integration', () => {
    let serverA: http.Server
    let serverB: http.Server
    let urlA: string
    let urlB: string

    beforeAll(async () => {
      serverA = http.createServer((req, res) => {
        if (req.url === '/next') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>Next Page</title></head><body><h1>Arrived</h1></body></html>')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html>
            <head><title>Audit Home</title></head>
            <body>
              <h1>Home</h1>
              <a href="/next">Go Next</a>
              <form action="/submit" method="post">
                <input name="q" type="text" aria-label="Search" />
                <button type="submit">Submit Order</button>
              </form>
            </body>
          </html>`)
      })
      serverB = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>Origin B</title></head><body><h1>Cross Origin</h1></body></html>')
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

    it('records tool calls, refusals, timing, and URL transitions to audit.jsonl across BrowserManager and Agent Socket', async () => {
      const profileDir = mkTmpDir('troy-audit-e2e-')
      const manager = await BrowserManager.create({
        engine: 'lite',
        profileDir,
      })
      const socket = await createAgentSocket(manager)

      async function post(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const res = await fetch(`http://127.0.0.1:${socket.port}${route}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-troy-agent': socket.token,
          },
          body: JSON.stringify(body),
        })
        return (await res.json()) as Record<string, unknown>
      }

      try {
        // 1. Open tab (urlA)
        const opened = await post('/open', { url: urlA })
        expect(opened.ok).toBe(true)
        const tabId = Number(opened.id)

        // 2. Read page to bind refs
        const readRes = await post('/tool', { tabId, name: 'page_read', args: {} })
        expect(readRes.ok).toBe(true)
        const elements = readRes.elements as Array<{ ref: string; tag: string; label?: string; text?: string }>
        const nextLink = elements.find((e) => e.tag === 'a')
        const submitBtn = elements.find((e) => e.tag === 'button')
        expect(nextLink).toBeDefined()
        expect(submitBtn).toBeDefined()

        // 3. Refused submit click (missing allowSubmit)
        const refusedSubmit = await post('/tool', {
          tabId,
          name: 'page_click',
          args: { ref: submitBtn!.ref },
        })
        expect(refusedSubmit.ok).toBe(false)

        // 4. Click link -> URL transition (urlA -> urlA/next)
        const clicked = await post('/tool', {
          tabId,
          name: 'page_click',
          args: { ref: nextLink!.ref },
        })
        expect(clicked.ok).toBe(true)

        // 5. Cross-origin navigate refused by origin boundary
        const refusedNav = await post('/tool', {
          tabId,
          name: 'page_navigate',
          args: { url: urlB },
        })
        expect(refusedNav.ok).toBe(false)

        // 6. Grant origin B and navigate -> succeeds with URL transition
        const granted = await post('/grant-origin', { origin: urlB })
        expect(granted.ok).toBe(true)
        const navOk = await post('/tool', {
          tabId,
          name: 'page_navigate',
          args: { url: urlB },
        })
        expect(navOk.ok).toBe(true)

        // 7. Dangerous scheme refused
        const refusedScheme = await post('/tool', {
          tabId,
          name: 'page_navigate',
          args: { url: 'javascript:alert(1)' },
        })
        expect(refusedScheme.ok).toBe(false)

        // 8. Query /health and /audit
        const healthRes = await fetch(`http://127.0.0.1:${socket.port}/health`, {
          headers: { 'x-troy-agent': socket.token },
        })
        const health = (await healthRes.json()) as { ok: boolean; audit: { totalEntries: number; refusals: number; urlTransitions: number } }
        expect(health.ok).toBe(true)
        expect(health.audit.totalEntries).toBeGreaterThanOrEqual(8)
        expect(health.audit.refusals).toBeGreaterThanOrEqual(3)
        expect(health.audit.urlTransitions).toBeGreaterThanOrEqual(3)

        const allAudit = await post('/audit', { fromDisk: true })
        expect(allAudit.ok).toBe(true)
        expect(typeof allAudit.ascii).toBe('string')
        expect(isStrictAscii(String(allAudit.ascii))).toBe(true)

        const refusedAudit = await post('/audit', { refusedOnly: true, fromDisk: true })
        const refusedEntries = refusedAudit.entries as Array<{ tool: string; refused: boolean; refusal?: { code?: string } }>
        expect(refusedEntries.length).toBeGreaterThanOrEqual(3)
        expect(refusedEntries.every((e) => e.refused)).toBe(true)
        expect(refusedEntries.some((e) => e.refusal?.code === 'scheme')).toBe(true)

        const transitionsAudit = await post('/audit', { urlChangedOnly: true, fromDisk: true })
        const transitionEntries = transitionsAudit.entries as Array<{ tool: string; fromUrl?: string; toUrl?: string; urlChanged?: boolean }>
        expect(transitionEntries.some((e) => e.tool === 'page_click' && e.toUrl?.endsWith('/next'))).toBe(true)
        expect(transitionEntries.some((e) => e.tool === 'page_navigate' && e.toUrl?.startsWith(urlB))).toBe(true)

        // 9. Verify audit.jsonl on disk + CLI offline inspection (--file)
        const auditFile = path.join(profileDir, 'audit.jsonl')
        expect(fs.existsSync(auditFile)).toBe(true)
        const diskEntries = readAuditJsonl(auditFile)
        const diskStats = computeAuditStats(diskEntries, { enabled: true, filePath: auditFile })
        expect(diskStats.refusals).toBeGreaterThanOrEqual(3)
        expect(filterAuditEntries(diskEntries, { tool: 'origin_grant' })).toHaveLength(1)

        // CLI offline audit --file --json
        const captured: string[] = []
        const origLog = console.log
        console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '))
        try {
          await cliMain(['audit', '--file', auditFile, '--refused', '--json'])
        } finally {
          console.log = origLog
        }
        const cliJson = JSON.parse(captured.join('\n')) as { ok: boolean; count: number; entries: unknown[] }
        expect(cliJson.ok).toBe(true)
        expect(cliJson.count).toBeGreaterThanOrEqual(3)

        // 10. Clear & truncate via /audit
        const cleared = await post('/audit', { clear: true, truncateFile: true })
        expect(cleared.ok).toBe(true)
        expect(cleared.truncatedFile).toBe(true)
        expect(readAuditJsonl(auditFile)).toHaveLength(0)
      } finally {
        await socket.close()
        await manager.close()
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    })
  })
})
