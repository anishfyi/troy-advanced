import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  ElementRegistry,
  bindRecalledElements,
  createAgentSocket,
  formatRecallAscii,
  matchRecalledElementOnLiveDom,
  type BoundRecallElement,
  type ElementDescriptor,
  type MemoryElement,
  type RecallAutoBindResult,
} from '../src/index.js'
import { executePipeCommand } from '../src/pipe/repl.js'
import { handleMcpRequest } from '../src/mcp/server.js'

function makeMemoryElement(overrides: Partial<MemoryElement> = {}): MemoryElement {
  return {
    key: 'https://app.example\0#submit-btn',
    origin: 'https://app.example',
    selector: '#submit-btn',
    id: 'submit-btn',
    tag: 'button',
    type: 'button',
    role: 'button',
    text: 'Save Profile',
    label: '',
    ariaLabel: 'Save Profile',
    name: '',
    pageUrl: 'https://app.example/profile',
    verified: 1,
    failed: 0,
    lastSeenAt: Date.now(),
    ...overrides,
  }
}

function makeLiveElement(overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    selector: '#submit-btn',
    id: 'submit-btn',
    tag: 'button',
    type: 'button',
    role: 'button',
    text: 'Save Profile',
    label: '',
    ariaLabel: 'Save Profile',
    name: '',
    ...overrides,
  }
}

describe('page_recall deterministic auto-binding unit tests (M67)', () => {
  it('matches by exact selector first', () => {
    const recalled = makeMemoryElement()
    const live = [makeLiveElement()]
    const res = matchRecalledElementOnLiveDom(recalled, live, 'https://app.example')
    expect(res.matched).toBe(true)
    if (res.matched) {
      expect(res.strategy).toBe('selector')
      expect(res.item.selector).toBe('#submit-btn')
    }
  })

  it('falls back deterministically to id, ariaLabel, name+tag, role+ariaLabel, and tag+text when selector drifts', () => {
    // 1. id fallback
    const byId = matchRecalledElementOnLiveDom(
      makeMemoryElement({ selector: 'div:nth-of-type(1) > button', id: 'save-btn', ariaLabel: '' }),
      [makeLiveElement({ selector: 'div:nth-of-type(3) > button', id: 'save-btn', ariaLabel: '' })],
      'https://app.example',
    )
    expect(byId.matched).toBe(true)
    if (byId.matched) expect(byId.strategy).toBe('id')

    // 2. ariaLabel fallback
    const byAria = matchRecalledElementOnLiveDom(
      makeMemoryElement({ selector: 'button.old', id: undefined, ariaLabel: 'Open Settings' }),
      [makeLiveElement({ selector: 'button.new', id: undefined, ariaLabel: 'Open Settings' })],
      'https://app.example',
    )
    expect(byAria.matched).toBe(true)
    if (byAria.matched) expect(byAria.strategy).toBe('ariaLabel')

    // 3. name+tag fallback
    const byNameTag = matchRecalledElementOnLiveDom(
      makeMemoryElement({
        selector: 'form > input:nth-of-type(1)',
        id: undefined,
        ariaLabel: '',
        tag: 'input',
        type: 'text',
        role: 'textbox',
        name: 'workspace_slug',
        text: '',
      }),
      [
        makeLiveElement({
          selector: 'form > div > input',
          id: undefined,
          ariaLabel: '',
          tag: 'input',
          type: 'text',
          role: 'textbox',
          name: 'workspace_slug',
          text: '',
        }),
      ],
      'https://app.example',
    )
    expect(byNameTag.matched).toBe(true)
    if (byNameTag.matched) expect(byNameTag.strategy).toBe('name+tag')

    // 4. tag+text fallback
    const byTagText = matchRecalledElementOnLiveDom(
      makeMemoryElement({
        selector: 'nav > a:nth-of-type(2)',
        id: undefined,
        ariaLabel: '',
        name: '',
        tag: 'a',
        role: 'link',
        text: 'Billing Overview',
      }),
      [
        makeLiveElement({
          selector: 'nav > ul > li > a',
          id: undefined,
          ariaLabel: '',
          name: '',
          tag: 'a',
          role: 'link',
          text: '  Billing   Overview  ',
          href: '/billing',
        }),
      ],
      'https://app.example',
    )
    expect(byTagText.matched).toBe(true)
    if (byTagText.matched) expect(byTagText.strategy).toBe('tag+text')
  })

  it('refuses cross-origin binding deterministically', () => {
    const recalled = makeMemoryElement({ origin: 'https://other.example' })
    const res = matchRecalledElementOnLiveDom(recalled, [makeLiveElement()], 'https://app.example')
    expect(res.matched).toBe(false)
    if (!res.matched) {
      expect(res.status).toBe('other-origin')
    }
  })

  it('refuses ambiguous matches when multiple live elements share the same locator', () => {
    const recalled = makeMemoryElement({
      selector: 'ul > li:nth-of-type(1) > button',
      id: undefined,
      ariaLabel: '',
      name: '',
      tag: 'button',
      text: 'Delete',
    })
    const live = [
      makeLiveElement({ selector: 'ul > li:nth-of-type(2) > button', id: undefined, ariaLabel: '', text: 'Delete' }),
      makeLiveElement({ selector: 'ul > li:nth-of-type(3) > button', id: undefined, ariaLabel: '', text: 'Delete' }),
    ]
    const res = matchRecalledElementOnLiveDom(recalled, live, 'https://app.example')
    expect(res.matched).toBe(false)
    if (!res.matched) {
      expect(res.status).toBe('ambiguous')
      expect(res.ambiguousStrategies?.[0]).toEqual({ strategy: 'tag+text', count: 2 })
    }
  })

  it('respects frameId scoping when verifying recalled elements', () => {
    const recalled = makeMemoryElement({ selector: '#frame-btn', id: 'frame-btn', frameId: 'frame-2' })
    const liveWrongFrame = [makeLiveElement({ selector: '#frame-btn', id: 'frame-btn', frameId: 'frame-1' })]
    const miss = matchRecalledElementOnLiveDom(recalled, liveWrongFrame, 'https://app.example')
    expect(miss.matched).toBe(false)
    if (!miss.matched) expect(miss.status).toBe('stale')

    const liveRightFrame = [
      makeLiveElement({ selector: '#frame-btn', id: 'frame-btn', frameId: 'frame-1' }),
      makeLiveElement({ selector: '#frame-btn', id: 'frame-btn', frameId: 'frame-2' }),
    ]
    const hit = matchRecalledElementOnLiveDom(recalled, liveRightFrame, 'https://app.example')
    expect(hit.matched).toBe(true)
    if (hit.matched) expect(hit.item.frameId).toBe('frame-2')
  })

  it('binds fresh refs and reuses existing same-epoch refs without invalidating other refs', () => {
    const registry = new ElementRegistry()
    const ctx = { tabId: 1, url: 'https://app.example/profile', epoch: 1 }

    // Pre-register two elements (e1 and e2)
    const initial = registry.register(
      [
        makeLiveElement({ selector: '#name-input', id: 'name-input', tag: 'input', text: '' }),
        makeLiveElement({ selector: '#submit-btn', id: 'submit-btn', tag: 'button', text: 'Save Profile' }),
      ],
      ctx,
    )
    expect(initial[0]!.ref).toBe('e1')
    expect(initial[1]!.ref).toBe('e2')

    const liveElements = [
      makeLiveElement({ selector: '#name-input', id: 'name-input', tag: 'input', text: '' }),
      makeLiveElement({ selector: '#submit-btn', id: 'submit-btn', tag: 'button', text: 'Save Profile' }),
      makeLiveElement({ selector: '#help-link', id: 'help-link', tag: 'a', text: 'Help', href: '/help' }),
    ]

    const bound = bindRecalledElements(
      [
        makeMemoryElement({ selector: '#submit-btn', id: 'submit-btn', text: 'Save Profile' }),
        makeMemoryElement({
          key: 'https://app.example\0#help-link',
          selector: '#help-link',
          id: 'help-link',
          tag: 'a',
          role: 'link',
          text: 'Help',
          ariaLabel: '',
        }),
        makeMemoryElement({
          key: 'https://app.example\0#gone',
          selector: '#gone',
          id: 'gone',
          text: 'Removed Button',
          ariaLabel: '',
        }),
      ],
      {
        liveElements,
        liveUrl: ctx.url,
        liveOrigin: 'https://app.example',
        registry,
        context: ctx,
      },
    )

    expect(bound.binding.boundCount).toBe(2)
    expect(bound.binding.reusedRefCount).toBe(1)
    expect(bound.binding.freshRefCount).toBe(1)
    expect(bound.binding.staleCount).toBe(1)

    // #submit-btn reused e2
    expect(bound.boundElements[0]!.ref).toBe('e2')
    expect(bound.boundElements[0]!.reusedRef).toBe(true)

    // #help-link minted fresh e3
    expect(bound.boundElements[1]!.ref).toBe('e3')
    expect(bound.boundElements[1]!.reusedRef).toBe(false)

    // Original e1 is still valid and untouched
    const resolvedE1 = registry.resolve('e1', ctx)
    expect('error' in resolvedE1).toBe(false)
    const resolvedE3 = registry.resolve('e3', ctx)
    expect('error' in resolvedE3).toBe(false)

    // ASCII formatter produces strict 7-bit ASCII with [e2] and [e3]
    const ascii = formatRecallAscii(
      {
        pages: [],
        elements: bound.elements,
        boundElements: bound.boundElements,
        actions: [],
        binding: bound.binding,
      } satisfies RecallAutoBindResult,
      'Save',
    )
    expect(ascii).toContain('[e2]')
    expect(ascii).toContain('[e3]')
    expect(ascii).toContain('stale')
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(ascii)).toBe(true)
  })
})

describe('page_recall auto-binding end-to-end (Lite + Agent Socket + MCP + Pipe)', () => {
  let server1: http.Server
  let server2: http.Server
  let baseUrl1 = ''
  let baseUrl2 = ''
  let tmpDir = ''
  let useDriftedDom = false

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-recall-bind-'))

    server1 = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/submitted') {
        res.end('<html><head><title>Submitted</title></head><body><h1>Form Received</h1></body></html>')
        return
      }
      if (useDriftedDom) {
        // Wrapper divs inserted so positional CSS selectors drift, while id & name stay unique
        res.end(`
          <html>
            <head><title>Workspace Portal</title></head>
            <body>
              <div class="banner"><p>Notice banner</p></div>
              <section class="wrapper">
                <div>
                  <form action="/submitted" method="get">
                    <label for="project-title">Project Title</label>
                    <input id="project-title" name="project_title" type="text" value="" />
                    <button id="launch-btn" type="button" aria-label="Launch Workspace">Launch Workspace</button>
                  </form>
                </div>
              </section>
            </body>
          </html>
        `)
        return
      }
      res.end(`
        <html>
          <head><title>Workspace Portal</title></head>
          <body>
            <h1>Workspace Portal</h1>
            <form action="/submitted" method="get">
              <label for="project-title">Project Title</label>
              <input id="project-title" name="project_title" type="text" value="" />
              <button id="launch-btn" type="button" aria-label="Launch Workspace">Launch Workspace</button>
              <a id="docs-link" href="/submitted">Open Docs</a>
            </form>
          </body>
        </html>
      `)
    })

    server2 = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <html>
          <head><title>Other Origin</title></head>
          <body>
            <button id="launch-btn" type="button" aria-label="Launch Workspace">Launch Workspace</button>
          </body>
        </html>
      `)
    })

    await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()))
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()))
    const addr1 = server1.address()
    const addr2 = server2.address()
    if (typeof addr1 === 'object' && addr1) baseUrl1 = `http://127.0.0.1:${addr1.port}`
    if (typeof addr2 === 'object' && addr2) baseUrl2 = `http://127.0.0.1:${addr2.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server1.close(() => resolve()))
    await new Promise<void>((resolve) => server2.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('auto-binds recalled selectors on a fresh tab without prior page_read and allows immediate page_fill + page_click', async () => {
    useDriftedDom = false
    const profileDir = path.join(tmpDir, 'profile-1')
    const manager = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: true })

    try {
      // Session 1: open & read the page to populate persistent PageMemory
      const tab1 = await manager.openTab(baseUrl1)
      const readRes = await manager.runTool(tab1.id, 'page_read', {})
      expect(readRes.ok).toBe(true)

      // Open a brand new tab to the same URL — NO page_read called on tab2!
      const tab2 = await manager.openTab(baseUrl1)

      // Call page_recall on tab2 -> should verify on live DOM & issue immediate eN refs
      const recallRes = await manager.runTool(tab2.id, 'page_recall', {
        query: 'Project Title',
        ascii: true,
      })
      expect(recallRes.ok).toBe(true)
      const boundEls = recallRes.boundElements as BoundRecallElement[]
      expect(boundEls.length).toBeGreaterThan(0)
      const inputEl = boundEls.find((e) => e.tag === 'input' && e.name === 'project_title')
      expect(inputEl).toBeDefined()
      expect(inputEl?.bound).toBe(true)
      expect(inputEl?.ref).toMatch(/^e\d+$/)
      expect(typeof recallRes.ascii).toBe('string')
      expect(recallRes.ascii as string).toContain(`[${inputEl!.ref}]`)

      // Immediately use that recalled eN ref with page_fill (no page_read needed!)
      const fillRes = await manager.runTool(tab2.id, 'page_fill', {
        ref: inputEl!.ref,
        value: 'Apollo Mission',
      })
      expect(fillRes.ok).toBe(true)
      expect(fillRes.value).toBe('Apollo Mission')

      // Recall the docs link and click it immediately
      const linkRecall = await manager.runTool(tab2.id, 'page_recall', {
        query: 'Open Docs',
        boundOnly: true,
      })
      expect(linkRecall.ok).toBe(true)
      const docsEl = (linkRecall.boundElements as BoundRecallElement[]).find((e) => e.tag === 'a')
      expect(docsEl?.ref).toMatch(/^e\d+$/)

      const clickRes = await manager.runTool(tab2.id, 'page_click', { ref: docsEl!.ref })
      expect(clickRes.ok).toBe(true)
      expect(String(clickRes.url)).toContain('/submitted')
    } finally {
      await manager.close()
    }
  })

  it('recovers and binds drifted selectors across sessions and refuses cross-origin binding', async () => {
    useDriftedDom = false
    const profileDir = path.join(tmpDir, 'profile-2')

    // First manager learns the original DOM
    const m1 = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: true })
    try {
      const t1 = await m1.openTab(baseUrl1)
      await m1.runTool(t1.id, 'page_read', {})
    } finally {
      await m1.close()
    }

    // Now DOM structure drifts (extra wrapper divs added) and a fresh manager loads persisted memory
    useDriftedDom = true
    const m2 = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: true })
    try {
      const t2 = await m2.openTab(baseUrl1)
      const recalled = await m2.runTool(t2.id, 'page_recall', { query: 'Launch Workspace' })
      expect(recalled.ok).toBe(true)
      const boundEls = recalled.boundElements as BoundRecallElement[]
      const launchBtn = boundEls.find((e) => e.tag === 'button')
      expect(launchBtn).toBeDefined()
      expect(launchBtn?.bound).toBe(true)
      expect(launchBtn?.ref).toMatch(/^e\d+$/)

      // Verify clicking the bound ref works
      const clickRes = await m2.runTool(t2.id, 'page_click', { ref: launchBtn!.ref })
      expect(clickRes.ok).toBe(true)

      // Open a tab on a different origin (server2) with identical id/ariaLabel -> MUST NOT bind!
      const tOther = await m2.openTab(baseUrl2)
      const crossOriginRecall = await m2.runTool(tOther.id, 'page_recall', { query: 'Launch Workspace' })
      expect(crossOriginRecall.ok).toBe(true)
      expect((crossOriginRecall.boundElements as BoundRecallElement[]).length).toBe(0)
      const allEls = crossOriginRecall.elements as BoundRecallElement[]
      expect(allEls.length).toBeGreaterThan(0)
      expect(allEls.every((e) => e.status === 'other-origin' && !e.bound && !e.ref)).toBe(true)
    } finally {
      useDriftedDom = false
      await m2.close()
    }
  })

  it('works seamlessly across Agent Socket /recall, MCP troy_recall, and Pipe REPL recall', async () => {
    useDriftedDom = false
    const profileDir = path.join(tmpDir, 'profile-3')
    const manager = await BrowserManager.create({ engine: 'lite', profileDir, memoryEnabled: true })
    const bridge = await createAgentSocket(manager)

    try {
      const tab = await manager.openTab(baseUrl1)
      await manager.runTool(tab.id, 'page_read', {})

      // 1. Agent Socket POST /recall
      const httpRes = await fetch(`http://127.0.0.1:${bridge.port}/recall`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-troy-agent': bridge.token,
        },
        body: JSON.stringify({ query: 'Launch Workspace', tabId: tab.id }),
      })
      const httpJson = (await httpRes.json()) as Record<string, unknown>
      expect(httpJson.ok).toBe(true)
      const httpBound = httpJson.boundElements as BoundRecallElement[]
      expect(httpBound.length).toBeGreaterThan(0)
      expect(httpBound[0]!.ref).toMatch(/^e\d+$/)
      expect(httpBound[0]!.reusedRef).toBe(true)

      // 2. MCP troy_recall
      const mcpResp = await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'troy_recall',
          arguments: { query: 'Launch Workspace', tabId: tab.id, boundOnly: true },
        },
      })
      const mcpContent = (mcpResp?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '{}'
      const mcpParsed = JSON.parse(mcpContent) as Record<string, unknown>
      expect(mcpParsed.ok).toBe(true)
      expect((mcpParsed.boundElements as BoundRecallElement[])[0]!.ref).toBe(httpBound[0]!.ref)

      // 3. Pipe REPL recall
      const pipeOut = await executePipeCommand(manager, 'recall Launch Workspace --bound-only', { json: true })
      const pipeParsed = JSON.parse(pipeOut.output) as Record<string, unknown>
      expect(pipeParsed.ok).toBe(true)
      expect((pipeParsed.boundElements as BoundRecallElement[])[0]!.ref).toBe(httpBound[0]!.ref)

      // 4. bind: false skips live DOM binding cleanly
      const unboundOut = await executePipeCommand(manager, 'recall Launch Workspace --no-bind', { json: true })
      const unboundParsed = JSON.parse(unboundOut.output) as Record<string, unknown>
      expect(unboundParsed.ok).toBe(true)
      expect((unboundParsed.binding as { attempted: boolean }).attempted).toBe(false)
      expect((unboundParsed.boundElements as unknown[]).length).toBe(0)
    } finally {
      await bridge.close()
      await manager.close()
    }
  })
})
