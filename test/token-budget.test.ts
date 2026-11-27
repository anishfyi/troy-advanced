import http from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, ElementDescriptor, PageSnapshot } from '../src/types.js'
import { isStrictAscii } from '../src/ascii/sanitize.js'
import { renderPageAsciiWithMetrics } from '../src/ascii/layout.js'
import {
  MAX_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET,
  countUniqueRefs,
  estimateTokens,
  parseMaxTokens,
  trimAsciiToTokenBudget,
} from '../src/ascii/token-budget.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { handleMcpRequest, MCP_TOOLS } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'
import { main as runCli } from '../src/cli.js'

function makeLargeSnapshot(): PageSnapshot {
  const blocks: ContentBlock[] = [
    { kind: 'heading', level: 1, text: 'Enterprise Cloud Dashboard' },
    { kind: 'button', text: 'Create Instance', ref: 'e1' },
    { kind: 'input', text: 'Search resources', placeholder: 'Filter by tag or ID...', ref: 'e2' },
    { kind: 'link', text: 'Billing & Cost Explorer', href: '/billing', ref: 'e3' },
    { kind: 'heading', level: 2, text: 'Active Compute Fleet' },
  ]
  const elements: ElementDescriptor[] = [
    { ref: 'e1', selector: '#create', tag: 'button', type: 'button', text: 'Create Instance' },
    { ref: 'e2', selector: '#search', tag: 'input', type: 'search', text: '', placeholder: 'Filter by tag or ID...' },
    { ref: 'e3', selector: 'a.billing', tag: 'a', type: 'link', text: 'Billing & Cost Explorer', href: '/billing' },
  ]

  for (let i = 1; i <= 45; i++) {
    blocks.push({
      kind: 'paragraph',
      text: `Cluster node-${i} in us-east-1a is running kernel 6.8 with 64 vCPU, 256 GiB RAM, and steady network throughput across all availability zones.`,
    })
  }

  blocks.push({ kind: 'heading', level: 2, text: 'Footer Actions' })
  blocks.push({ kind: 'button', text: 'Export Audit Report', ref: 'e4' })
  elements.push({ ref: 'e4', selector: '#export', tag: 'button', type: 'button', text: 'Export Audit Report' })

  return {
    tabId: 1,
    url: 'https://cloud.example.com/dashboard',
    title: 'Enterprise Cloud Dashboard',
    epoch: 1,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 3200 },
    blocks,
    elements,
    text: blocks.map((b) => b.text).join('\n'),
    capturedAt: Date.now(),
  }
}

describe('Token-Budget Estimator & Auto-Trimmer (M61)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('parseMaxTokens', () => {
    it('parses numbers, strings, comma-separated values, and k shorthand', () => {
      expect(parseMaxTokens(500)).toBe(500)
      expect(parseMaxTokens('800')).toBe(800)
      expect(parseMaxTokens('1,500')).toBe(1500)
      expect(parseMaxTokens('2k')).toBe(2000)
      expect(parseMaxTokens('1.5K')).toBe(1500)
      expect(parseMaxTokens(' 4_000 ')).toBe(4000)
    })

    it('clamps to safe bounds and rejects invalid inputs', () => {
      expect(parseMaxTokens(5)).toBe(MIN_TOKEN_BUDGET)
      expect(parseMaxTokens(99_999_999)).toBe(MAX_TOKEN_BUDGET)
      expect(parseMaxTokens(0)).toBeUndefined()
      expect(parseMaxTokens(-100)).toBeUndefined()
      expect(parseMaxTokens('abc')).toBeUndefined()
      expect(parseMaxTokens('')).toBeUndefined()
      expect(parseMaxTokens(undefined)).toBeUndefined()
      expect(parseMaxTokens(false)).toBeUndefined()
    })
  })

  describe('estimateTokens', () => {
    it('handles empty text and basic prose accurately', () => {
      expect(estimateTokens('')).toEqual({ tokens: 0, chars: 0, lines: 0, words: 0, bytes: 0 })

      const prose = 'The quick brown fox jumps over the lazy dog in 2025.'
      const est = estimateTokens(prose)
      expect(est.words).toBe(11)
      expect(est.lines).toBe(1)
      expect(est.chars).toBe(prose.length)
      expect(est.tokens).toBeGreaterThanOrEqual(10)
      expect(est.tokens).toBeLessThanOrEqual(20)
    })

    it('strips ANSI escape sequences before estimating tokens', () => {
      const plain = 'TITLE: Dashboard [e1: Launch]'
      const ansi = '\x1b[1m\x1b[36mTITLE: Dashboard \x1b[33m[e1: Launch]\x1b[0m'
      expect(estimateTokens(ansi).tokens).toBe(estimateTokens(plain).tokens)
      expect(estimateTokens(ansi).chars).toBe(plain.length)
    })

    it('compresses repeated ASCII border characters and spaces like BPE', () => {
      const border = '+------------------------------------------------------------------------------+'
      const est = estimateTokens(border)
      // 80 chars of repeated dashes should be far fewer than 80 tokens
      expect(est.tokens).toBeLessThan(30)
    })

    it('is monotonic as text grows', () => {
      const a = 'Hello world'
      const b = 'Hello world from Troy Advanced'
      const c = `${b}\n[e1: Click me]\nMore lines here.`
      expect(estimateTokens(b).tokens).toBeGreaterThanOrEqual(estimateTokens(a).tokens)
      expect(estimateTokens(c).tokens).toBeGreaterThanOrEqual(estimateTokens(b).tokens)
    })
  })

  describe('trimAsciiToTokenBudget', () => {
    it('returns text untouched when already within budget', () => {
      const text = 'TITLE: Small Page\n[e1: Home]\nHello world.'
      const est = estimateTokens(text)
      const res = trimAsciiToTokenBudget(text, est.tokens + 50)
      expect(res.text).toBe(text)
      expect(res.report.trimmed).toBe(false)
      expect(res.report.strategy).toBe('none')
      expect(res.report.finalTokens).toBe(est.tokens)
      expect(res.report.droppedLines).toBe(0)
    })

    it('prioritizes headers and interactive [eN] refs while keeping document order', () => {
      const lines = [
        'TITLE: Account Settings',
        'URL: https://app.example.com/settings',
        ...Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}: verbose description of settings and defaults.`),
        '[e1: Save Changes]',
        ...Array.from({ length: 20 }, (_, i) => `More prose ${i + 1}: additional notes about retention policy and quotas.`),
        '[e2: Delete Account]',
      ]
      const input = lines.join('\n')
      const res = trimAsciiToTokenBudget(input, 120)

      expect(res.report.trimmed).toBe(true)
      expect(res.report.finalTokens).toBeLessThanOrEqual(120)
      expect(estimateTokens(res.text).tokens).toBeLessThanOrEqual(120)
      expect(isStrictAscii(res.text)).toBe(true)

      // Header and interactive refs should be preserved in document order
      expect(res.text).toContain('TITLE: Account Settings')
      expect(res.text).toContain('[e1: Save Changes]')
      expect(res.text).toContain('[e2: Delete Account]')
      expect(res.text.indexOf('[e1: Save Changes]')).toBeLessThan(res.text.indexOf('[e2: Delete Account]'))
      expect(res.report.preservedRefs).toBe(2)
      expect(res.report.totalRefs).toBe(2)
      expect(res.text).toContain('trimmed')
    })

    it('strictly respects every budget size down to MIN_TOKEN_BUDGET', () => {
      const input = Array.from(
        { length: 40 },
        (_, i) => `Line ${i + 1}: [e${i + 1}: Action ${i + 1}] Detailed description of item ${i + 1} with extra text.`,
      ).join('\n')

      for (const budget of [16, 24, 40, 60, 100, 200, 400]) {
        const res = trimAsciiToTokenBudget(input, budget)
        expect(res.report.finalTokens).toBeLessThanOrEqual(budget)
        expect(estimateTokens(res.text).tokens).toBeLessThanOrEqual(budget)
        expect(isStrictAscii(res.text)).toBe(true)
      }
    })

    it('falls back to hard-truncate when a single giant line exceeds a tiny budget', () => {
      const giantLine = 'supercalifragilistic '.repeat(200)
      const res = trimAsciiToTokenBudget(giantLine, 20)
      expect(res.report.trimmed).toBe(true)
      expect(res.report.strategy).toBe('hard-truncate')
      expect(res.report.finalTokens).toBeLessThanOrEqual(20)
      expect(estimateTokens(res.text).tokens).toBeLessThanOrEqual(20)
      expect(res.text.endsWith('...')).toBe(true)
    })
  })

  describe('renderPageAsciiWithMetrics progressive compaction & auto-trim', () => {
    it('leaves output untouched and omits tokenBudget when maxTokens is not specified', () => {
      const snap = makeLargeSnapshot()
      const res = renderPageAsciiWithMetrics(snap, { width: 100, height: 36 })
      expect(res.tokenBudget).toBeUndefined()
    })

    it('uses progressive compaction first before dropping lines when compact mode fits', () => {
      const snap = makeLargeSnapshot()
      const normal = renderPageAsciiWithMetrics(snap, { width: 100, height: 36, showChrome: true })
      const compact = renderPageAsciiWithMetrics(snap, {
        width: 80,
        height: 36,
        density: 'compact',
        showChrome: false,
        showScrollbar: false,
      })
      const normalTokens = estimateTokens(normal.ascii).tokens
      const compactTokens = estimateTokens(compact.ascii).tokens
      expect(compactTokens).toBeLessThan(normalTokens)

      // Pick a budget strictly between compactTokens and normalTokens
      const midBudget = Math.floor((compactTokens + normalTokens) / 2)
      const fitted = renderPageAsciiWithMetrics(snap, {
        width: 100,
        height: 36,
        showChrome: true,
        maxTokens: midBudget,
      })

      expect(fitted.tokenBudget).toBeDefined()
      expect(fitted.tokenBudget!.trimmed).toBe(true)
      expect(fitted.tokenBudget!.strategy).toBe('compact')
      expect(fitted.tokenBudget!.finalTokens).toBeLessThanOrEqual(midBudget)
      expect(estimateTokens(fitted.ascii).tokens).toBeLessThanOrEqual(midBudget)
    })

    it('combines compaction and trimming on tight budgets while preserving [eN] refs', () => {
      const snap = makeLargeSnapshot()
      const fitted = renderPageAsciiWithMetrics(snap, {
        width: 100,
        height: 60,
        showChrome: true,
        maxTokens: 120,
      })

      expect(fitted.tokenBudget).toBeDefined()
      expect(fitted.tokenBudget!.trimmed).toBe(true)
      expect(fitted.tokenBudget!.strategy).toBe('compact+trim')
      expect(fitted.tokenBudget!.finalTokens).toBeLessThanOrEqual(120)
      expect(estimateTokens(fitted.ascii).tokens).toBeLessThanOrEqual(120)
      expect(isStrictAscii(fitted.ascii)).toBe(true)
      expect(countUniqueRefs(fitted.ascii)).toBeGreaterThanOrEqual(2)
    })
  })

  describe('End-to-End Integration (Manager, Agent Socket, MCP, Pipe REPL, CLI)', () => {
    let server: http.Server
    let baseUrl = ''
    let toggleVersion = 1

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        const paragraphs = Array.from(
          { length: 35 },
          (_, i) =>
            `<p>Section ${i + 1} (v${toggleVersion}): Detailed operational telemetry for EC2 worker pool ${i + 1} across us-east-1 and eu-west-1 regions.</p>`,
        ).join('\n')
        res.end(`<!doctype html>
          <html>
            <head><title>Token Budget Test Page v${toggleVersion}</title></head>
            <body>
              <h1>Token Budget Control Panel</h1>
              <button id="deploy">Deploy Release</button>
              <a href="/logs">Inspect Logs</a>
              ${paragraphs}
            </body>
          </html>`)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as { port: number }
      baseUrl = `http://127.0.0.1:${addr.port}`
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('enforces maxTokens across BrowserManager, Agent Socket /ascii, MCP, and Pipe REPL', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
      const socket = await createAgentSocket(manager)
      try {
        const opened = await manager.openTab(baseUrl, { activate: true })
        expect(opened.ok).toBe(true)

        // 1. BrowserManager.renderAscii with maxTokens
        const rendered = await manager.renderAscii(opened.id, { maxTokens: 110, height: 60 })
        expect(rendered.ok).toBe(true)
        expect(rendered.tokenBudget).toBeDefined()
        expect(rendered.tokenBudget!.finalTokens).toBeLessThanOrEqual(110)
        expect(rendered.estimatedTokens).toBeLessThanOrEqual(110)
        expect(estimateTokens(rendered.ascii!).tokens).toBeLessThanOrEqual(110)

        // 2. Delta mode (--since) with maxTokens
        toggleVersion = 2
        await manager.runTool(opened.id, 'page_history', { direction: 'reload' })
        const deltaRes = await manager.renderAscii(opened.id, { since: true, maxTokens: 70 })
        expect(deltaRes.ok).toBe(true)
        expect(deltaRes.mode).toBe('delta')
        expect(deltaRes.tokenBudget).toBeDefined()
        expect(deltaRes.tokenBudget!.finalTokens).toBeLessThanOrEqual(70)
        expect(estimateTokens(deltaRes.ascii!).tokens).toBeLessThanOrEqual(70)

        // 3. Agent Socket HTTP /ascii with maxTokens
        const httpRes = await fetch(`http://127.0.0.1:${socket.port}/ascii`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-troy-agent': socket.token,
          },
          body: JSON.stringify({ tabId: opened.id, height: 60, maxTokens: 95 }),
        })
        const httpJson = (await httpRes.json()) as Record<string, unknown>
        expect(httpJson.ok).toBe(true)
        expect(typeof httpJson.ascii).toBe('string')
        expect(estimateTokens(String(httpJson.ascii)).tokens).toBeLessThanOrEqual(95)
        const httpBudget = httpJson.tokenBudget as { finalTokens: number; maxTokens: number; trimmed: boolean }
        expect(httpBudget.maxTokens).toBe(95)
        expect(httpBudget.finalTokens).toBeLessThanOrEqual(95)
        expect(httpBudget.trimmed).toBe(true)

        // 4. MCP troy_read_ascii schema & execution with maxTokens
        const mcpReadTool = MCP_TOOLS.find((t) => t.name === 'troy_read_ascii')!
        expect(mcpReadTool.inputSchema.properties).toHaveProperty('maxTokens')

        const mcpRes = (await handleMcpRequest(manager, {
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: {
            name: 'troy_read_ascii',
            arguments: { tabId: opened.id, height: 60, maxTokens: 90 },
          },
        })) as { result: { content: Array<{ text: string }> } }
        const mcpAscii = mcpRes.result.content[0]!.text
        expect(estimateTokens(mcpAscii).tokens).toBeLessThanOrEqual(90)

        // 5. Pipe REPL `ascii --max-tokens 85`
        const pipeRes = await executePipeCommand(manager, 'ascii --max-tokens 85', { jsonMode: true })
        const pipeJson = JSON.parse(pipeRes.output) as {
          ok: boolean
          ascii: string
          tokenBudget: { maxTokens: number; finalTokens: number }
        }
        expect(pipeJson.ok).toBe(true)
        expect(pipeJson.tokenBudget.maxTokens).toBe(85)
        expect(pipeJson.tokenBudget.finalTokens).toBeLessThanOrEqual(85)
        expect(estimateTokens(pipeJson.ascii).tokens).toBeLessThanOrEqual(85)
      } finally {
        await socket.close()
        await manager.close()
      }
    })

    it('supports CLI one-shot `ascii <url> --max-tokens 100 --json`', async () => {
      const logs: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(' '))
      })

      await runCli(['ascii', baseUrl, '--engine', 'lite', '--height', '60', '--max-tokens', '100', '--json'])

      expect(logs.length).toBeGreaterThan(0)
      const parsed = JSON.parse(logs[logs.length - 1]!) as {
        ok: boolean
        ascii: string
        estimatedTokens: number
        tokenBudget: { maxTokens: number; finalTokens: number; trimmed: boolean }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.tokenBudget.maxTokens).toBe(100)
      expect(parsed.tokenBudget.finalTokens).toBeLessThanOrEqual(100)
      expect(parsed.estimatedTokens).toBeLessThanOrEqual(100)
      expect(estimateTokens(parsed.ascii).tokens).toBeLessThanOrEqual(100)
    })
  })
})
