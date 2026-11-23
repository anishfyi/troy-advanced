import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii } from '../src/ascii/sanitize.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import {
  VIEWPORT_PRESETS,
  formatEmulationAscii,
  mergeHeaders,
  parseHeaderArg,
  parseHeaderList,
  parseViewportSpec,
  redactHeaders,
  resolveEmulationProfile,
  sanitizeHeaders,
} from '../src/engine/emulation.js'
import { BrowserManager } from '../src/engine/manager.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'

const hasChrome = Boolean(findChromeBinary())

describe('Emulation profiles, viewport presets & custom headers (M25)', () => {
  it('parses built-in presets (desktop, mobile, terminal) and custom WxH specs', () => {
    const desktop = parseViewportSpec('desktop')
    expect(desktop.preset).toBe('desktop')
    expect(desktop.width).toBe(1280)
    expect(desktop.height).toBe(800)
    expect(desktop.mobile).toBe(false)

    const mobile = parseViewportSpec('MOBILE')
    expect(mobile.preset).toBe('mobile')
    expect(mobile.width).toBe(390)
    expect(mobile.height).toBe(844)
    expect(mobile.deviceScaleFactor).toBe(3)
    expect(mobile.mobile).toBe(true)
    expect(mobile.hasTouch).toBe(true)

    const terminal = parseViewportSpec('terminal')
    expect(terminal.preset).toBe('terminal')
    expect(terminal.width).toBe(800)
    expect(terminal.height).toBe(600)

    const custom = parseViewportSpec('1440x900')
    expect(custom.preset).toBe('custom')
    expect(custom.width).toBe(1440)
    expect(custom.height).toBe(900)

    const retinaMobile = parseViewportSpec('375X812@3m')
    expect(retinaMobile.width).toBe(375)
    expect(retinaMobile.height).toBe(812)
    expect(retinaMobile.deviceScaleFactor).toBe(3)
    expect(retinaMobile.mobile).toBe(true)
    expect(retinaMobile.hasTouch).toBe(true)

    const fromObj = parseViewportSpec({ width: 1024, height: 768, deviceScaleFactor: 2 })
    expect(fromObj.width).toBe(1024)
    expect(fromObj.height).toBe(768)
    expect(fromObj.deviceScaleFactor).toBe(2)

    expect(() => parseViewportSpec('')).toThrow()
    expect(() => parseViewportSpec('not-a-viewport')).toThrow()
    expect(() => parseViewportSpec('50x50')).toThrow()
  })

  it('sanitizes, deduplicates, merges, redacts headers and blocks CRLF injection', () => {
    expect(parseHeaderArg('X-Tenant: prod-us-east-1')).toEqual(['X-Tenant', 'prod-us-east-1'])
    expect(parseHeaderArg('X-Env=staging')).toEqual(['X-Env', 'staging'])

    const list = parseHeaderList(['x-trace: 111', 'X-Trace: 222', 'Authorization: Bearer supersecret123'])
    expect(list).toEqual({
      'X-Trace': '222',
      Authorization: 'Bearer supersecret123',
    })

    const merged = mergeHeaders(list, { 'X-Extra': 'ok', 'x-trace': '333' }, ['authorization'])
    expect(merged).toEqual({
      'x-trace': '333',
      'X-Extra': 'ok',
    })

    const masked = redactHeaders({ Authorization: 'Bearer supersecret123', 'X-Public': 'visible' }, false)
    expect(masked.Authorization).not.toContain('supersecret123')
    expect(masked.Authorization).toContain('***')
    expect(masked['X-Public']).toBe('visible')

    expect(() => parseHeaderArg('X-Bad: val\r\nInjected: yes')).toThrow()
    expect(() => sanitizeHeaders({ 'Bad Header': '1' })).toThrow()
    expect(() => sanitizeHeaders({ 'X-Null': 'abc\0def' })).toThrow()
  })

  it('resolves emulation profiles cleanly across preset switches and custom WxH overrides', () => {
    const base = resolveEmulationProfile({
      viewport: 'mobile',
      extraHeaders: { 'X-Tenant': 'alpha' },
      acceptLanguage: 'en-GB,en;q=0.8',
    })
    expect(base.preset).toBe('mobile')
    expect(base.viewport.width).toBe(390)
    expect(base.userAgent).toBe(VIEWPORT_PRESETS.mobile.userAgent)
    expect(base.platform).toBe('iPhone')
    expect(base.acceptLanguage).toBe('en-GB,en;q=0.8')

    // Custom WxH preserves UA & platform while updating dimensions
    const resized = resolveEmulationProfile({ viewport: '1600x900' }, base)
    expect(resized.preset).toBe('custom')
    expect(resized.viewport.width).toBe(1600)
    expect(resized.viewport.height).toBe(900)
    expect(resized.userAgent).toBe(base.userAgent)
    expect(resized.extraHeaders).toEqual({ 'X-Tenant': 'alpha' })

    // Explicit UA overrides preset default UA
    const customUa = resolveEmulationProfile(
      { viewport: 'terminal', userAgent: 'MyAgent/9.9', extraHeaders: { 'X-Api-Key': 'sk-secret-value-999' } },
      resized,
    )
    expect(customUa.preset).toBe('terminal')
    expect(customUa.viewport.width).toBe(800)
    expect(customUa.userAgent).toBe('MyAgent/9.9')
    expect(customUa.extraHeaders).toEqual({ 'X-Tenant': 'alpha', 'X-Api-Key': 'sk-secret-value-999' })

    const ascii = formatEmulationAscii(customUa, { tabId: 1 })
    expect(isStrictAscii(ascii, { allowNewlines: true })).toBe(true)
    expect(ascii).toContain('terminal (800x600')
    expect(ascii).toContain('MyAgent/9.9')
    expect(ascii).toContain('X-Tenant: alpha')
    expect(ascii).not.toContain('sk-secret-value-999')
  })
})

describe('Lite engine + Agent Socket + MCP + Pipe emulation integration (M25)', () => {
  let server: http.Server
  let baseUrl = ''
  let lastHeaders: http.IncomingHttpHeaders = {}
  const tempDirs: string[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastHeaders = { ...req.headers }
      const body = JSON.stringify({
        url: req.url,
        headers: req.headers,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
  })

  it('applies initial and runtime viewport, UA, Accept-Language, and custom headers across Lite, Agent Socket, MCP, and Pipe', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m25-lite-'))
    tempDirs.push(profileDir)

    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir,
      emulation: {
        viewport: 'mobile',
        acceptLanguage: 'fr-FR,fr;q=0.9',
        extraHeaders: {
          'X-Tenant': 'ec2-mobile',
          Authorization: 'Bearer topsecret-token-42',
        },
      },
    })
    const socket = await createAgentSocket(manager)

    try {
      const opened = await manager.openTab(`${baseUrl}/initial`, { activate: true })
      expect(opened.ok).toBe(true)
      expect(lastHeaders['user-agent']).toContain('iPhone')
      expect(lastHeaders['accept-language']).toBe('fr-FR,fr;q=0.9')
      expect(lastHeaders['x-tenant']).toBe('ec2-mobile')
      expect(lastHeaders.authorization).toBe('Bearer topsecret-token-42')

      // Snapshot reflects mobile viewport
      const readRes = await manager.runTool(opened.id, 'page_read', {})
      expect(readRes.ok).toBe(true)
      const emuGet = manager.getEmulation(opened.id)
      expect(emuGet.ok).toBe(true)
      expect(emuGet.emulation?.viewport.width).toBe(390)
      expect(emuGet.emulation?.viewport.height).toBe(844)
      // Authorization is masked by default
      expect(emuGet.emulation?.extraHeaders.Authorization).not.toContain('topsecret-token-42')

      // Update via Agent Socket /emulation
      const sockRes = await fetch(`http://127.0.0.1:${socket.port}/emulation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-troy-agent': socket.token },
        body: JSON.stringify({
          tabId: opened.id,
          viewport: '1440x900',
          userAgent: 'TroyAudit/1.5',
          extraHeaders: { 'X-Socket': 'yes' },
          removeHeaders: ['Authorization'],
        }),
      })
      const sockJson = (await sockRes.json()) as { ok: boolean; emulation?: { viewport: { width: number; height: number }; userAgent: string; extraHeaders: Record<string, string> } }
      expect(sockJson.ok).toBe(true)
      expect(sockJson.emulation?.viewport.width).toBe(1440)
      expect(sockJson.emulation?.viewport.height).toBe(900)
      expect(sockJson.emulation?.userAgent).toBe('TroyAudit/1.5')
      expect(sockJson.emulation?.extraHeaders['X-Socket']).toBe('yes')
      expect(sockJson.emulation?.extraHeaders.Authorization).toBeUndefined()

      await manager.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/after-socket` })
      expect(lastHeaders['user-agent']).toBe('TroyAudit/1.5')
      expect(lastHeaders['x-socket']).toBe('yes')
      expect(lastHeaders['x-tenant']).toBe('ec2-mobile')
      expect(lastHeaders.authorization).toBeUndefined()

      // Update via MCP troy_emulate
      const mcpRes = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'troy_emulate',
          arguments: {
            tabId: opened.id,
            viewport: 'terminal',
            extraHeaders: { 'X-Mcp': 'true' },
            clearHeaders: true,
          },
        },
      })) as { result?: { content?: Array<{ text: string }>; isError?: boolean } }
      expect(mcpRes.result?.isError).toBe(false)
      const mcpParsed = JSON.parse(mcpRes.result?.content?.[0]?.text ?? '{}') as {
        ok: boolean
        emulation: { preset: string; viewport: { width: number; height: number } }
      }
      expect(mcpParsed.ok).toBe(true)
      expect(mcpParsed.emulation.preset).toBe('terminal')
      expect(mcpParsed.emulation.viewport.width).toBe(800)

      await manager.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/after-mcp` })
      expect(lastHeaders['x-mcp']).toBe('true')
      expect(lastHeaders['x-tenant']).toBeUndefined()

      // Update via Pipe REPL
      const pipeOut = await executePipeCommand(manager, 'emulate 1024x768 --ua "PipeBot/3.0" --header "X-Pipe: ok"', {
        jsonMode: true,
      })
      const pipeJson = JSON.parse(pipeOut.output) as { ok: boolean; emulation: { viewport: { width: number; height: number }; userAgent: string } }
      expect(pipeJson.ok).toBe(true)
      expect(pipeJson.emulation.viewport.width).toBe(1024)
      expect(pipeJson.emulation.viewport.height).toBe(768)
      expect(pipeJson.emulation.userAgent).toBe('PipeBot/3.0')

      await manager.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/after-pipe` })
      expect(lastHeaders['user-agent']).toBe('PipeBot/3.0')
      expect(lastHeaders['x-pipe']).toBe('ok')
    } finally {
      await socket.close()
      await manager.close()
    }
  })
})

describe.skipIf(!hasChrome)('Headless Chromium CDP emulation E2E (M25)', () => {
  let server: http.Server
  let baseUrl = ''
  let lastRequestHeaders: http.IncomingHttpHeaders = {}
  const tempDirs: string[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastRequestHeaders = { ...req.headers }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Emulation Probe</title>
  </head>
  <body>
    <h1>Emulation Probe</h1>
    <pre id="server-headers" style="white-space: pre-wrap; word-break: break-all;">${JSON.stringify(req.headers)}</pre>
  </body>
</html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
  })

  it(
    'applies terminal, mobile, and custom WxH viewports, UA overrides, and custom HTTP headers in real Chromium CDP',
    async () => {
      const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m25-chrome-'))
      tempDirs.push(profileDir)

      const manager = await BrowserManager.create({
        engine: 'chromium',
        profileDir,
        emulation: {
          viewport: 'terminal',
          extraHeaders: { 'X-Troy-Env': 'ec2-terminal' },
        },
      })

      try {
        const opened = await manager.openTab(`${baseUrl}/terminal`, { activate: true })
        expect(opened.ok).toBe(true)

        // 1. Verify initial terminal preset (800x600) + custom header + UA
        expect(lastRequestHeaders['x-troy-env']).toBe('ec2-terminal')
        expect(lastRequestHeaders['user-agent']).toContain('TroyAdvanced/0.1')

        const termMetrics = (await manager.runTool(opened.id, 'page_eval', {
          expression:
            '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints })',
        })) as { ok: boolean; value: { w: number; h: number; dpr: number; ua: string; touch: number } }
        expect(termMetrics.ok).toBe(true)
        expect(termMetrics.value.w).toBe(800)
        expect(termMetrics.value.h).toBe(600)
        expect(termMetrics.value.ua).toContain('TroyAdvanced/0.1')

        // 2. Dynamically switch to mobile preset + extra header + Accept-Language
        const mobRes = await manager.setEmulation({
          tabId: opened.id,
          viewport: 'mobile',
          acceptLanguage: 'de-DE,de;q=0.9',
          extraHeaders: { 'X-Device-Mode': 'mobile-check' },
        })
        expect(mobRes.ok).toBe(true)
        expect(mobRes.emulation?.preset).toBe('mobile')

        await manager.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/mobile` })
        expect(lastRequestHeaders['x-troy-env']).toBe('ec2-terminal')
        expect(lastRequestHeaders['x-device-mode']).toBe('mobile-check')
        expect(lastRequestHeaders['user-agent']).toContain('iPhone')
        expect(lastRequestHeaders['accept-language']).toContain('de-DE')

        const mobMetrics = (await manager.runTool(opened.id, 'page_eval', {
          expression:
            '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, ua: navigator.userAgent, lang: navigator.language, touch: navigator.maxTouchPoints })',
        })) as {
          ok: boolean
          value: { w: number; h: number; dpr: number; ua: string; lang: string; touch: number }
        }
        expect(mobMetrics.ok).toBe(true)
        expect(mobMetrics.value.w).toBe(390)
        expect(mobMetrics.value.h).toBe(844)
        expect(mobMetrics.value.dpr).toBe(3)
        expect(mobMetrics.value.ua).toContain('iPhone')
        expect(mobMetrics.value.touch).toBeGreaterThan(0)

        // 3. Dynamically switch to custom 1440x900 + custom UA + clear custom headers
        const custRes = await manager.setEmulation({
          tabId: opened.id,
          viewport: '1440x900',
          userAgent: 'CustomCrawler/4.2',
          clearHeaders: true,
        })
        expect(custRes.ok).toBe(true)
        expect(custRes.emulation?.viewport.width).toBe(1440)
        expect(custRes.emulation?.viewport.height).toBe(900)

        await manager.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/custom` })
        expect(lastRequestHeaders['user-agent']).toBe('CustomCrawler/4.2')
        expect(lastRequestHeaders['x-troy-env']).toBeUndefined()
        expect(lastRequestHeaders['x-device-mode']).toBeUndefined()

        const custMetrics = (await manager.runTool(opened.id, 'page_eval', {
          expression: '({ w: window.innerWidth, h: window.innerHeight, ua: navigator.userAgent })',
        })) as { ok: boolean; value: { w: number; h: number; ua: string } }
        expect(custMetrics.ok).toBe(true)
        expect(custMetrics.value.w).toBe(1440)
        expect(custMetrics.value.h).toBe(900)
        expect(custMetrics.value.ua).toBe('CustomCrawler/4.2')
      } finally {
        await manager.close()
      }
    },
    30000,
  )
})
