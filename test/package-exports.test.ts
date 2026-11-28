import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PKG_PATH = path.join(REPO_ROOT, 'package.json')

interface ConditionalExport {
  types: string
  import: string
}

interface PackageJson {
  name: string
  version: string
  type: string
  main: string
  types: string
  exports: Record<string, string | ConditionalExport>
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as PackageJson
}

function runNodeEsm(code: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

describe('Package export map (M97)', () => {
  const REQUIRED_SUBPATHS = [
    '.',
    './ascii',
    './engine',
    './mcp',
    './agent',
    './bridge',
    './pipe',
    './tui',
    './cloud',
    './types',
    './package.json',
  ] as const

  it('declares a valid exports map in package.json with types before import', () => {
    const pkg = readPackageJson()
    expect(pkg.name).toBe('@anishfyi/troy-advanced')
    expect(pkg.type).toBe('module')
    expect(pkg.exports).toBeDefined()

    for (const subpath of REQUIRED_SUBPATHS) {
      expect(pkg.exports[subpath], `missing export entry for "${subpath}"`).toBeDefined()
    }

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') {
        const resolved = path.resolve(REPO_ROOT, target)
        expect(fs.existsSync(resolved), `missing file for "${subpath}": ${target}`).toBe(true)
        continue
      }

      const keys = Object.keys(target)
      expect(keys[0], `"types" must be first condition in exports["${subpath}"]`).toBe('types')
      expect(keys).toContain('import')

      const typesPath = path.resolve(REPO_ROOT, target.types)
      const importPath = path.resolve(REPO_ROOT, target.import)
      expect(fs.existsSync(typesPath), `missing built .d.ts for "${subpath}": ${target.types}`).toBe(true)
      expect(fs.existsSync(importPath), `missing built .js for "${subpath}": ${target.import}`).toBe(true)
    }
  })

  it('resolves root and core subpath ESM imports via native Node.js resolution', () => {
    const script = `
      const root = await import('@anishfyi/troy-advanced')
      const ascii = await import('@anishfyi/troy-advanced/ascii')
      const engine = await import('@anishfyi/troy-advanced/engine')
      const mcp = await import('@anishfyi/troy-advanced/mcp')
      const agent = await import('@anishfyi/troy-advanced/agent')
      const bridge = await import('@anishfyi/troy-advanced/bridge')
      const pipe = await import('@anishfyi/troy-advanced/pipe')
      const tui = await import('@anishfyi/troy-advanced/tui')
      const cloud = await import('@anishfyi/troy-advanced/cloud')
      const types = await import('@anishfyi/troy-advanced/types')
      const pkg = (await import('@anishfyi/troy-advanced/package.json', { with: { type: 'json' } })).default

      const summary = {
        pkgName: pkg.name,
        rootKeys: [
          typeof root.BrowserManager,
          typeof root.renderPageAscii,
          typeof root.handleMcpRequest,
          typeof root.createAgentSocket,
        ],
        asciiKeys: [
          typeof ascii.renderPageAscii,
          typeof ascii.renderDeltaAscii,
          typeof ascii.renderPageMarkdown,
          typeof ascii.renderRgbaToAscii,
          typeof ascii.sanitizeAscii,
          typeof ascii.decodePng,
          typeof ascii.trimAsciiToTokenBudget,
        ],
        engineKeys: [
          typeof engine.BrowserManager,
          typeof engine.LiteBrowserEngine,
          typeof engine.ChromiumBrowserEngine,
          typeof engine.CookieJar,
          typeof engine.CdpClient,
          typeof engine.parseProxyUrl,
          typeof engine.CdpTrackerBlocker,
        ],
        mcpKeys: [
          Array.isArray(mcp.MCP_TOOLS),
          Array.isArray(mcp.MCP_RESOURCES),
          Array.isArray(mcp.MCP_PROMPTS),
          typeof mcp.handleMcpRequest,
          typeof mcp.runMcpStdioServer,
          typeof mcp.generateToolSchemas,
          typeof mcp.McpStdioFrameParser,
          typeof mcp.encodeMcpMessage,
        ],
        agentKeys: [
          typeof agent.resolveInput,
          typeof agent.PageMemory,
          typeof agent.extractStructuredData,
          typeof agent.redactSensitiveText,
          typeof agent.wrapUntrustedText,
          typeof agent.checkUrlSsrfSync,
        ],
        bridgeKeys: [
          typeof bridge.createAgentSocket,
          typeof bridge.writeEndpoint,
          typeof bridge.readLiveEndpoint,
          typeof bridge.timingSafeTokenEqual,
          typeof bridge.validateHostHeader,
          typeof bridge.AgentMetricsCollector,
        ],
        pipeKeys: [typeof pipe.runPipeRepl],
        tuiKeys: [
          typeof tui.TerminalBrowserController,
          typeof tui.runTerminalBrowser,
          typeof tui.renderHelpOverlayBox,
          typeof tui.exportPageViewToFile,
        ],
        cloudKeys: [
          typeof cloud.runDoctor,
          typeof cloud.runDaemonForeground,
          typeof cloud.probeEc2ImdsV2,
          typeof cloud.buildEc2TunnelPlan,
          typeof cloud.renderDockerComposeYaml,
        ],
        typesLoaded: typeof types === 'object' && types !== null,
      }
      console.log(JSON.stringify(summary))
    `

    const res = runNodeEsm(script)
    expect(res.status, res.stderr).toBe(0)

    const summary = JSON.parse(res.stdout.trim()) as Record<string, unknown>
    expect(summary.pkgName).toBe('@anishfyi/troy-advanced')
    expect(summary.rootKeys).toEqual(['function', 'function', 'function', 'function'])
    expect(summary.asciiKeys).toEqual([
      'function',
      'function',
      'function',
      'function',
      'function',
      'function',
      'function',
    ])
    expect(summary.engineKeys).toEqual([
      'function',
      'function',
      'function',
      'function',
      'function',
      'function',
      'function',
    ])
    expect(summary.mcpKeys).toEqual([
      true,
      true,
      true,
      'function',
      'function',
      'function',
      'function',
      'function',
    ])
    expect(summary.agentKeys).toEqual([
      'function',
      'function',
      'function',
      'function',
      'function',
      'function',
    ])
    expect(summary.bridgeKeys).toEqual([
      'function',
      'function',
      'function',
      'function',
      'function',
      'function',
    ])
    expect(summary.pipeKeys).toEqual(['function'])
    expect(summary.tuiKeys).toEqual(['function', 'function', 'function', 'function'])
    expect(summary.cloudKeys).toEqual(['function', 'function', 'function', 'function', 'function'])
    expect(summary.typesLoaded).toBe(true)
  })

  it('executes real functionality via /ascii, /engine, and /mcp subpath imports', () => {
    const script = `
      const { sanitizeAscii, renderPageAscii } = await import('@anishfyi/troy-advanced/ascii')
      const { parseProxyUrl, decodeHtmlEntities } = await import('@anishfyi/troy-advanced/engine')
      const { generateToolSchemas, MCP_TOOLS } = await import('@anishfyi/troy-advanced/mcp')

      const clean = sanitizeAscii('Hello “Troy” — 🚀')
      const rendered = renderPageAscii({
        tabId: 1,
        url: 'https://example.com',
        title: 'Example',
        epoch: 1,
        timestamp: Date.now(),
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, scrollHeight: 720 },
        elements: [
          {
            ref: 'e1',
            tag: 'a',
            role: 'link',
            text: 'Docs',
            href: 'https://example.com/docs',
            selector: 'a',
            visible: true,
            enabled: true,
          },
        ],
        blocks: [{ type: 'heading', level: 1, text: 'Welcome' }],
        text: 'Welcome',
      })
      const proxy = parseProxyUrl('http://127.0.0.1:8080')
      const decoded = decodeHtmlEntities('Tom &amp; Jerry &#x2605;')
      const openaiSchemas = generateToolSchemas({ format: 'openai' })

      console.log(JSON.stringify({
        clean,
        hasWelcome: rendered.includes('Welcome'),
        hasRef: rendered.includes('[e1'),
        proxyHost: proxy.hostname,
        proxyPort: proxy.port,
        decoded,
        mcpToolCount: MCP_TOOLS.length,
        openaiToolCount: openaiSchemas.length,
      }))
    `

    const res = runNodeEsm(script)
    expect(res.status, res.stderr).toBe(0)

    const out = JSON.parse(res.stdout.trim()) as {
      clean: string
      hasWelcome: boolean
      hasRef: boolean
      proxyHost: string
      proxyPort: number
      decoded: string
      mcpToolCount: number
      openaiToolCount: number
    }
    expect(out.clean).toContain('Hello')
    expect(out.clean).toContain('Troy')
    expect(/^[\x20-\x7e]*$/.test(out.clean)).toBe(true)
    expect(out.hasWelcome).toBe(true)
    expect(out.hasRef).toBe(true)
    expect(out.proxyHost).toBe('127.0.0.1')
    expect(out.proxyPort).toBe(8080)
    expect(out.decoded).toContain('Tom & Jerry')
    expect(out.mcpToolCount).toBeGreaterThan(10)
    expect(out.openaiToolCount).toBe(out.mcpToolCount)
  })

  it('rejects unexported internal subpaths with ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    const script = `
      const blocked = []
      for (const spec of [
        '@anishfyi/troy-advanced/dist/cli.js',
        '@anishfyi/troy-advanced/internal',
        '@anishfyi/troy-advanced/src/index.ts',
      ]) {
        try {
          await import(spec)
          blocked.push({ spec, code: 'UNEXPECTED_SUCCESS' })
        } catch (err) {
          blocked.push({ spec, code: err && err.code ? err.code : String(err) })
        }
      }
      console.log(JSON.stringify(blocked))
    `

    const res = runNodeEsm(script)
    expect(res.status, res.stderr).toBe(0)

    const results = JSON.parse(res.stdout.trim()) as Array<{ spec: string; code: string }>
    expect(results).toHaveLength(3)
    for (const item of results) {
      expect(item.code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    }
  })

  it('typechecks TypeScript NodeNext consumer imports across all subpaths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-exports-tsc-'))
    try {
      const consumerFile = path.join(tmpDir, 'consumer.ts')
      const tsconfigFile = path.join(tmpDir, 'tsconfig.json')
      const nodeModulesScope = path.join(tmpDir, 'node_modules', '@anishfyi')
      fs.mkdirSync(nodeModulesScope, { recursive: true })
      fs.symlinkSync(REPO_ROOT, path.join(nodeModulesScope, 'troy-advanced'), 'dir')

      fs.writeFileSync(
        consumerFile,
        `import type { PageSnapshot, TabSummary } from '@anishfyi/troy-advanced/types'
import { BrowserManager } from '@anishfyi/troy-advanced'
import { renderPageAscii, sanitizeAscii, type AsciiRenderOptions } from '@anishfyi/troy-advanced/ascii'
import { LiteBrowserEngine, ChromiumBrowserEngine, CookieJar } from '@anishfyi/troy-advanced/engine'
import { MCP_TOOLS, handleMcpRequest, generateToolSchemas } from '@anishfyi/troy-advanced/mcp'
import { PageMemory, resolveInput } from '@anishfyi/troy-advanced/agent'
import { createAgentSocket, timingSafeTokenEqual, type AgentSocketServer } from '@anishfyi/troy-advanced/bridge'
import { runPipeRepl } from '@anishfyi/troy-advanced/pipe'
import { TerminalBrowserController, runTerminalBrowser } from '@anishfyi/troy-advanced/tui'
import { runDoctor } from '@anishfyi/troy-advanced/cloud'

const opts: AsciiRenderOptions = { width: 80, density: 'compact' }
const clean: string = sanitizeAscii('hello')
const schemas = generateToolSchemas({ format: 'openai' })
const nav = resolveInput('example.com')

export const check = {
  BrowserManager,
  LiteBrowserEngine,
  ChromiumBrowserEngine,
  CookieJar,
  MCP_TOOLS,
  handleMcpRequest,
  PageMemory,
  createAgentSocket,
  timingSafeTokenEqual,
  runPipeRepl,
  TerminalBrowserController,
  runTerminalBrowser,
  runDoctor,
  renderPageAscii,
  opts,
  clean,
  schemas,
  nav,
}
export type CheckTypes = [PageSnapshot, TabSummary, AgentSocketServer]
`,
        'utf8',
      )

      fs.writeFileSync(
        tsconfigFile,
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2023',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
            },
            include: ['consumer.ts'],
          },
          null,
          2,
        ),
        'utf8',
      )

      const tscBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
      const res = spawnSync(tscBin, ['-p', tsconfigFile], {
        cwd: tmpDir,
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
