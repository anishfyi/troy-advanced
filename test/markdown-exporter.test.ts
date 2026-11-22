import http from 'node:http'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderInlineMarkdown, renderMarkdownTable, renderPageMarkdown } from '../src/ascii/markdown.js'
import { isStrictAscii } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'
import type { PageSnapshot } from '../src/types.js'

/** Minimal valid PNG encoder for testing `<canvas>` data URLs in Markdown. */
function makeTestPngDataUrl(width: number, height: number): string {
  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crcBuf])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = 1 + width * 4
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const idx = y * stride + 1 + x * 4
      const v = (x + y) % 2 === 0 ? 240 : 20
      raw[idx] = v
      raw[idx + 1] = v
      raw[idx + 2] = v
      raw[idx + 3] = 255
    }
  }

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    tabId: 1,
    url: 'https://example.com/docs',
    title: 'Troy Docs',
    epoch: 2,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 1600 },
    blocks: [],
    elements: [],
    text: '',
    capturedAt: 1700000000000,
    ...overrides,
  }
}

describe('renderInlineMarkdown', () => {
  it('preserves inline [eN] refs and hrefs inside prose', () => {
    const out = renderInlineMarkdown(
      'Read the API Guide and Quickstart before deploying.',
      [
        { text: 'API Guide', ref: 'e1', href: 'https://example.com/api' },
        { text: 'Quickstart', ref: 'e2', href: 'https://example.com/start' },
      ],
    )
    expect(out).toBe(
      'Read the [API Guide](https://example.com/api) [e1] and [Quickstart](https://example.com/start) [e2] before deploying.',
    )
  })

  it('supports includeUrls: false and showRefs: false', () => {
    const noUrls = renderInlineMarkdown(
      'Visit Docs now.',
      [{ text: 'Docs', ref: 'e3', href: 'https://example.com/docs' }],
      { includeUrls: false },
    )
    expect(noUrls).toBe('Visit [Docs] [e3] now.')

    const noRefs = renderInlineMarkdown(
      'Visit Docs now.',
      [{ text: 'Docs', ref: 'e3', href: 'https://example.com/docs' }],
      { showRefs: false },
    )
    expect(noRefs).toBe('Visit [Docs](https://example.com/docs) now.')
  })

  it('escapes brackets in labels, wraps URLs with parens/spaces, and appends unmatched links', () => {
    const out = renderInlineMarkdown('Intro paragraph.', [
      { text: 'Spec [v2]', ref: 'e4', href: 'https://example.com/spec (v2).pdf' },
    ])
    expect(out).toBe('Intro paragraph. [Spec \\[v2\\]](<https://example.com/spec (v2).pdf>) [e4]')
  })
})

describe('renderMarkdownTable', () => {
  it('renders a valid GFM table with escaped pipes and uniform columns', () => {
    const lines = renderMarkdownTable([
      { kind: 'table-row', text: 'Name | Status', cells: ['Name', 'Status'], isHeader: true },
      { kind: 'table-row', text: 'Alpha | OK', cells: ['Alpha | Beta', 'OK\nReady'] },
      { kind: 'table-row', text: 'Gamma', cells: ['Gamma'] },
    ])
    expect(lines).toEqual([
      '| Name | Status |',
      '| --- | --- |',
      '| Alpha \\| Beta | OK Ready |',
      '| Gamma |  |',
    ])
  })
})

describe('renderPageMarkdown', () => {
  it('exports headings, inline links, lists, tables, forms, code fences, and hr with [eN] refs', () => {
    const snap = makeSnapshot({
      title: 'Troy Docs',
      blocks: [
        { kind: 'heading', level: 1, text: 'Troy Docs' },
        {
          kind: 'paragraph',
          text: 'Welcome to the CLI Reference for terminal browsing.',
          links: [{ text: 'CLI Reference', ref: 'e1', href: 'https://example.com/cli' }],
        },
        { kind: 'heading', level: 2, text: 'Features' },
        {
          kind: 'list-item',
          text: 'Fast ASCII viewports',
        },
        {
          kind: 'list-item',
          text: 'See Pricing for details',
          links: [{ text: 'Pricing', ref: 'e2', href: 'https://example.com/pricing' }],
        },
        { kind: 'table-row', text: 'Mode | Speed', cells: ['Mode', 'Speed'], isHeader: true },
        { kind: 'table-row', text: 'Lite | 1ms', cells: ['Lite', '1ms'] },
        { kind: 'code', text: 'const x = `hello`\n```nested```' },
        { kind: 'hr', text: '' },
        { kind: 'input', text: 'Email', ref: 'e3', placeholder: 'you@example.com', formId: 'sign_in', formTitle: 'Sign In' },
        { kind: 'input', text: 'Remember me', ref: 'e4', checked: true, formId: 'sign_in' },
        { kind: 'select', text: 'Region', ref: 'e5', value: 'us-east-1', formId: 'sign_in' },
        { kind: 'button', text: 'Continue', ref: 'e6', formId: 'sign_in' },
      ],
      elements: [
        { ref: 'e1', selector: 'a#cli', tag: 'a', type: 'link', text: 'CLI Reference', href: 'https://example.com/cli' },
        { ref: 'e2', selector: 'a#price', tag: 'a', type: 'link', text: 'Pricing', href: 'https://example.com/pricing' },
        { ref: 'e3', selector: 'input#email', tag: 'input', type: 'email', text: 'Email', label: 'Email' },
        { ref: 'e4', selector: 'input#rem', tag: 'input', type: 'checkbox', text: 'Remember me', checked: true },
        { ref: 'e5', selector: 'select#reg', tag: 'select', type: 'select', text: 'Region', value: 'us-east-1' },
        { ref: 'e6', selector: 'button#go', tag: 'button', type: 'submit', text: 'Continue' },
      ],
    })

    const md = renderPageMarkdown(snap)

    // Should not duplicate H1 when first block already matches title
    expect(md.match(/^# Troy Docs$/gm)?.length).toBe(1)
    expect(md).toContain('> URL: https://example.com/docs')
    expect(md).toContain('Welcome to the [CLI Reference](https://example.com/cli) [e1] for terminal browsing.')
    expect(md).toContain('## Features')
    expect(md).toContain('- Fast ASCII viewports\n- See [Pricing](https://example.com/pricing) [e2] for details')
    expect(md).toContain('| Mode | Speed |\n| --- | --- |\n| Lite | 1ms |')
    // Uses 4-backtick fence because code contains triple backticks
    expect(md).toContain('````\nconst x = `hello`\n```nested```\n````')
    expect(md).toContain('---')
    expect(md).toContain('### Form: Sign In')
    expect(md).toContain('- [e3] **Email** (input): *(you@example.com)*')
    expect(md).toContain('- [x] [e4] **Remember me**')
    expect(md).toContain('- [e5] **Region** (select): `us-east-1`')
    expect(md).toContain('- [e6] **[Continue]**')
    // All refs were rendered inline, so no redundant Additional Interactive Elements section
    expect(md).not.toContain('## Additional Interactive Elements')
  })

  it('supports YAML frontmatter and interactive elements index', () => {
    const snap = makeSnapshot({
      title: 'Quote "Test"',
      blocks: [{ kind: 'paragraph', text: 'Body text.' }],
      elements: [
        { ref: 'e1', selector: 'button#help', tag: 'button', type: 'button', text: 'Help' },
      ],
    })

    const md = renderPageMarkdown(snap, { includeFrontmatter: true })
    expect(md).toContain('---\ntitle: "Quote \\"Test\\""\nurl: "https://example.com/docs"\ntabId: 1\nepoch: 2\nrefs: 1\n---')
    expect(md).toContain('## Additional Interactive Elements')
    expect(md).toContain('- [e1] `button` Help')

    const alwaysMd = renderPageMarkdown(snap, { includeRefsIndex: 'always' })
    expect(alwaysMd).toContain('## Interactive Elements')

    const noIndexMd = renderPageMarkdown(snap, { includeRefsIndex: false })
    expect(noIndexMd).not.toContain('Interactive Elements')
  })

  it('renders images, canvas ASCII previews, and optional media summary', () => {
    const dataUrl = makeTestPngDataUrl(16, 16)
    const snap = makeSnapshot({
      blocks: [
        {
          kind: 'image',
          text: 'Hero Logo',
          alt: 'Hero Logo',
          src: 'https://example.com/logo.png',
          naturalWidth: 640,
          naturalHeight: 360,
          box: { x: 10, y: 20, width: 320, height: 180 },
        },
        {
          kind: 'canvas',
          text: 'Sales Chart',
          canvasDataUrl: dataUrl,
          box: { x: 10, y: 220, width: 400, height: 200 },
        },
      ],
    })

    const md = renderPageMarkdown(snap, { includeMediaSummary: true })
    expect(md).toContain('![Hero Logo](https://example.com/logo.png) *(320x180 (natural 640x360) @(10,20))*')
    expect(md).toContain('**Canvas: Sales Chart** *(400x200 @(10,220))*')
    expect(md).toContain('```text\n')
    expect(md).toContain('## Media Summary (2)')
  })

  it('enforces strict 7-bit ASCII when asciiOnly: true', () => {
    const snap = makeSnapshot({
      title: 'Café — 日本語 🚀',
      blocks: [
        {
          kind: 'paragraph',
          text: '\x1b[31m“Smart quotes”\x1b[0m and emoji 🎉 with link.',
          links: [{ text: 'link', ref: 'e1', href: 'https://example.com' }],
        },
      ],
    })

    const md = renderPageMarkdown(snap, { asciiOnly: true })
    expect(isStrictAscii(md, { allowNewlines: true })).toBe(true)
    expect(md).toContain('"Smart quotes"')
    expect(md).toContain('[link](https://example.com) [e1]')
  })

  it('supports crop filtering and empty-blocks text fallback', () => {
    const croppedSnap = makeSnapshot({
      blocks: [
        { kind: 'heading', level: 2, text: 'Inside Crop', box: { x: 20, y: 20, width: 200, height: 40 } },
        { kind: 'paragraph', text: 'Outside Crop', box: { x: 900, y: 900, width: 200, height: 40 } },
      ],
    })
    const croppedMd = renderPageMarkdown(croppedSnap, {
      crop: { x: 0, y: 0, width: 300, height: 100 },
      cropLabel: 'e9',
    })
    expect(croppedMd).toContain('> Crop: e9 (0,0 300x100)')
    expect(croppedMd).toContain('## Inside Crop')
    expect(croppedMd).not.toContain('Outside Crop')

    const textOnlySnap = makeSnapshot({
      blocks: [],
      text: 'First raw paragraph.\n\nSecond raw paragraph.',
    })
    const fallbackMd = renderPageMarkdown(textOnlySnap)
    expect(fallbackMd).toContain('First raw paragraph.\n\nSecond raw paragraph.')
  })
})

describe('Markdown end-to-end integration (Manager, Agent Socket, MCP, Pipe)', () => {
  let server: http.Server
  let baseUrl: string
  let manager: BrowserManager
  let socket: AgentSocketServer

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head><title>Hybrid AI Page</title></head>
  <body>
    <h1>Hybrid AI Page</h1>
    <p>Explore the <a href="/docs">Documentation</a> right away.</p>
    <form id="search-form" aria-label="Search">
      <label for="q">Query</label>
      <input id="q" name="q" placeholder="Search docs..." />
      <button type="submit">Go</button>
    </form>
  </body>
</html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('failed to bind test server')
    baseUrl = `http://127.0.0.1:${addr.port}`

    manager = await BrowserManager.create({ engine: 'lite', memory: false })
    socket = await createAgentSocket(manager, { host: '127.0.0.1', port: 0 })
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)
  })

  afterAll(async () => {
    await socket.close()
    await manager.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('exports Markdown via BrowserManager.renderMarkdown and page_read_markdown tool', async () => {
    const res = await manager.renderMarkdown(undefined, { includeFrontmatter: true })
    expect(res.ok).toBe(true)
    expect(res.markdown).toContain('title: "Hybrid AI Page"')
    expect(res.markdown).toContain('[Documentation](')
    expect(res.markdown).toMatch(/\[e\d+\]/)

    const toolRes = await manager.runTool(undefined, 'page_read_markdown', { asciiOnly: true })
    expect(toolRes.ok).toBe(true)
    expect(typeof toolRes.markdown).toBe('string')
    expect(isStrictAscii(String(toolRes.markdown), { allowNewlines: true })).toBe(true)
  })

  it('serves /markdown over the Agent Socket', async () => {
    const httpRes = await fetch(`http://127.0.0.1:${socket.port}/markdown`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-troy-agent': socket.token,
      },
      body: JSON.stringify({ includeFrontmatter: true }),
    })
    expect(httpRes.status).toBe(200)
    const body = (await httpRes.json()) as { ok: boolean; markdown?: string; title?: string }
    expect(body.ok).toBe(true)
    expect(body.title).toBe('Hybrid AI Page')
    expect(body.markdown).toContain('[Documentation](')
    expect(body.markdown).toMatch(/\[e\d+\]/)
  })

  it('exposes troy_read_markdown over MCP and markdown command over Pipe REPL', async () => {
    const listRes = await handleMcpRequest(manager, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = ((listRes?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name)
    expect(tools).toContain('troy_read_markdown')

    const callRes = await handleMcpRequest(manager, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'troy_read_markdown', arguments: { includeFrontmatter: true } },
    })
    const content = (callRes?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? ''
    expect(content).toContain('# Hybrid AI Page')
    expect(content).toMatch(/\[e\d+\]/)

    const pipeRes = await executePipeCommand(manager, 'markdown --frontmatter')
    expect(pipeRes.output).toContain('title: "Hybrid AI Page"')
    expect(pipeRes.output).toContain('[Documentation](')
  })
})
