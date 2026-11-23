import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  flattenFrameSnapshots,
  isCrossOriginUrl,
  isFrameSelector,
  offsetRect,
  parseFrameIdToken,
  parseFrameSelector,
  prefixFrameSelector,
  splitFrameSelector,
} from '../src/engine/frames.js'
import { findChromeBinary } from '../src/engine/chromium.js'
import { BrowserManager } from '../src/engine/manager.js'

const hasChrome = Boolean(findChromeBinary())

describe('Cross-frame selector parser & snapshot flattener (M21)', () => {
  it('distinguishes CSS >, frame >>, and Shadow DOM >>> combinators cleanly', () => {
    expect(splitFrameSelector('#submit')).toEqual(['#submit'])
    expect(isFrameSelector('#submit')).toBe(false)

    expect(splitFrameSelector('div > span.label')).toEqual(['div > span.label'])
    expect(isFrameSelector('div > span.label')).toBe(false)

    // Shadow DOM >>> must NOT be split as frame >>
    expect(splitFrameSelector('my-app >>> button#ok')).toEqual(['my-app >>> button#ok'])
    expect(isFrameSelector('my-app >>> button#ok')).toBe(false)

    // Frame >> splits cleanly
    expect(splitFrameSelector('iframe#checkout >> button#pay')).toEqual(['iframe#checkout', 'button#pay'])
    expect(isFrameSelector('iframe#checkout >> button#pay')).toBe(true)

    // Nested frames + Shadow DOM combined
    const parsed = parseFrameSelector('app-shell >>> iframe#outer >> iframe#inner >> widget-form >>> input[name="code"]')
    expect(parsed.isFrameSelector).toBe(true)
    expect(parsed.frameSegments).toEqual(['app-shell >>> iframe#outer', 'iframe#inner'])
    expect(parsed.targetSelector).toBe('widget-form >>> input[name="code"]')
  })

  it('ignores >> inside quoted attribute values and escapes', () => {
    expect(splitFrameSelector('button[data-arrow="a >> b"]')).toEqual(['button[data-arrow="a >> b"]'])
    expect(isFrameSelector('button[data-arrow="a >> b"]')).toBe(false)

    expect(splitFrameSelector("iframe#w >> input[placeholder='Type >> here']")).toEqual([
      'iframe#w',
      "input[placeholder='Type >> here']",
    ])
  })

  it('throws on empty or malformed >> selectors and parses frame:<id> tokens', () => {
    expect(() => splitFrameSelector('')).toThrow(/empty/i)
    expect(() => splitFrameSelector('>> #btn')).toThrow(/empty/i)
    expect(() => splitFrameSelector('iframe#a >>')).toThrow(/empty/i)
    expect(() => splitFrameSelector('iframe#a >> >> #btn')).toThrow(/empty/i)
    expect(isFrameSelector('>> #btn')).toBe(false)

    expect(parseFrameIdToken('frame:ABC123')).toBe('ABC123')
    expect(parseFrameIdToken('iframe#checkout')).toBeNull()
    expect(parseFrameIdToken('frame:')).toBeNull()
  })

  it('offsets rects, prefixes selectors, detects cross-origin URLs, and flattens snapshots', () => {
    expect(offsetRect({ x: 10, y: 20, width: 100, height: 30 }, 200, 150)).toEqual({
      x: 210,
      y: 170,
      width: 100,
      height: 30,
    })
    expect(prefixFrameSelector(['#outer', '#inner'], '#submit')).toBe('#outer >> #inner >> #submit')
    expect(isCrossOriginUrl('http://127.0.0.1:4000/page', 'http://127.0.0.1:4000/child')).toBe(false)
    expect(isCrossOriginUrl('http://127.0.0.1:4000/page', 'http://localhost:4001/widget')).toBe(true)
    expect(isCrossOriginUrl('http://127.0.0.1:4000/page', 'about:srcdoc')).toBe(false)

    const flattened = flattenFrameSnapshots(
      {
        url: 'http://127.0.0.1:4000/',
        title: 'Host',
        viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
        elements: [{ selector: '#submit', tag: 'button', type: 'submit', text: 'Host Submit', box: { x: 10, y: 10, width: 80, height: 30 } }],
        blocks: [{ kind: 'button', text: 'Host Submit', selector: '#submit', formId: 'form-1', box: { x: 10, y: 10, width: 80, height: 30 } }],
        text: 'Host Page',
      },
      [
        {
          frameId: 'F2',
          parentFrameId: 'F1',
          url: 'http://localhost:4001/pay',
          name: 'payment',
          selectorChain: ['#pay-frame'],
          offsetX: 100,
          offsetY: 200,
          box: { x: 100, y: 200, width: 400, height: 300 },
          crossOrigin: true,
          snapshot: {
            url: 'http://localhost:4001/pay',
            title: 'Payment Widget',
            elements: [{ selector: '#submit', tag: 'button', type: 'submit', text: 'Pay Now', box: { x: 20, y: 40, width: 90, height: 32 } }],
            blocks: [
              {
                kind: 'paragraph',
                text: 'Read Terms',
                links: [{ text: 'Terms', href: 'http://localhost:4001/terms', selector: 'a#terms' }],
              },
              { kind: 'button', text: 'Pay Now', selector: '#submit', formId: 'form-1', box: { x: 20, y: 40, width: 90, height: 32 } },
            ],
            text: 'Pay Now Widget',
          },
        },
      ],
    )

    expect(flattened.elements).toHaveLength(2)
    expect(flattened.elements[0]!.selector).toBe('#submit')
    expect(flattened.elements[1]!.selector).toBe('#pay-frame >> #submit')
    expect(flattened.elements[1]!.box).toEqual({ x: 120, y: 240, width: 90, height: 32 })
    expect(flattened.elements[1]!.frameId).toBe('F2')
    expect(flattened.elements[1]!.frameName).toBe('payment')

    // Child formId is scoped so it doesn't collide with host form-1
    expect(flattened.blocks[0]!.formId).toBe('form-1')
    expect(flattened.blocks[2]!.formId).toBe('f1-form-1')
    expect(flattened.blocks[1]!.links?.[0]?.selector).toBe('#pay-frame >> a#terms')

    expect(flattened.frames).toHaveLength(1)
    expect(flattened.frames?.[0]).toMatchObject({
      frameId: 'F2',
      name: 'payment',
      selector: '#pay-frame',
      elementCount: 1,
      crossOrigin: true,
    })
    expect(flattened.text).toContain('Host Page')
    expect(flattened.text).toContain('Pay Now Widget')
  })
})

describe('Lite engine <iframe srcdoc> flattening (M21)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir = ''

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-lite-iframe-'))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
        <html>
          <head><title>Lite Host</title></head>
          <body>
            <h1>Main Host</h1>
            <iframe id="embed-box" name="embed" srcdoc="
              <h2>Embedded Support Form</h2>
              <form id='support-form' action='/submit'>
                <label for='msg'>Message</label>
                <input id='msg' name='msg' type='text' placeholder='Say hi' />
                <button id='send' type='button'>Send Note</button>
              </form>
            "></iframe>
          </body>
        </html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
    manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
  })

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('flattens srcdoc iframe forms with real eN refs and supports fill via eN', async () => {
    const opened = await manager.openTab(baseUrl)
    expect(opened.ok).toBe(true)

    const read = await manager.renderAscii(opened.id)
    expect(read.ok).toBe(true)
    expect(read.snapshot?.frames?.length).toBe(1)
    expect(read.ascii).toContain('Embedded Support Form')

    const msgEl = read.snapshot?.elements.find((e) => e.id === 'msg')
    expect(msgEl?.ref).toMatch(/^e\d+$/)
    expect(msgEl?.selector).toBe('#embed-box >> #msg')
    expect(msgEl?.frameName).toBe('embed')

    const fillRes = await manager.runTool(opened.id, 'page_fill', {
      ref: msgEl!.ref!,
      text: 'Hello from Lite iframe',
    })
    expect(fillRes.ok).toBe(true)
  })
})

describe.skipIf(!hasChrome)('Headless Chromium CDP Cross-Frame <iframe> E2E (M21)', () => {
  let hostServer: http.Server
  let crossServer: http.Server
  let hostUrl = ''
  let crossUrl = ''
  let tmpDir = ''
  let manager: BrowserManager

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-chrome-iframe-'))

    // Cross-origin server (bound on loopback, accessed via http://localhost:<port> so Chrome treats it as cross-site OOPIF!)
    crossServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/widget') {
        res.end(`<!doctype html>
          <html>
            <head>
              <title>Promo Widget</title>
              <style>
                body { font-family: sans-serif; margin: 12px; }
                input, button { padding: 6px; margin: 4px 0; display: block; }
              </style>
            </head>
            <body>
              <h2>Cross-Origin Promo Widget</h2>
              <form id="promo-form" onsubmit="event.preventDefault()">
                <label for="promo-code">Promo Code</label>
                <input id="promo-code" name="promo" type="text" placeholder="Enter promo" />
                <button id="apply-promo" type="button">Apply Promo</button>
              </form>
              <div id="promo-status"></div>
              <script>
                document.getElementById('apply-promo').addEventListener('click', () => {
                  const code = document.getElementById('promo-code').value;
                  document.getElementById('promo-status').textContent = 'Promo applied: ' + code;
                });
              </script>
            </body>
          </html>`)
        return
      }
      res.end('<html><body>Not found</body></html>')
    })
    await new Promise<void>((resolve) => crossServer.listen(0, '127.0.0.1', resolve))
    const crossPort = (crossServer.address() as { port: number }).port
    crossUrl = `http://localhost:${crossPort}`

    // Host server (accessed via http://127.0.0.1:<port>)
    hostServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/same-origin-frame') {
        res.end(`<!doctype html>
          <html>
            <head>
              <title>Profile Form</title>
              <style>
                body { font-family: sans-serif; margin: 10px; }
                input, select, button { padding: 5px; margin: 4px 0; display: block; }
              </style>
            </head>
            <body>
              <h2>Profile Details</h2>
              <form id="profile-form" onsubmit="event.preventDefault()">
                <label for="customer-email">Email</label>
                <input id="customer-email" name="email" type="text" placeholder="you@example.com" />
                <label for="plan-select">Plan</label>
                <select id="plan-select" name="plan">
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                  <option value="enterprise">Enterprise</option>
                </select>
                <button id="save-btn" type="button">Save Profile</button>
                <button id="hover-btn" type="button">Hover Info</button>
              </form>
              <div id="profile-status"></div>
              <script>
                window.__frameEvents = { hovered: 0, saved: null };
                document.getElementById('hover-btn').addEventListener('mouseenter', () => {
                  window.__frameEvents.hovered += 1;
                });
                document.getElementById('save-btn').addEventListener('click', () => {
                  const email = document.getElementById('customer-email').value;
                  const plan = document.getElementById('plan-select').value;
                  window.__frameEvents.saved = { email, plan };
                  document.getElementById('profile-status').textContent = 'Saved ' + email + ' (' + plan + ')';
                });
              </script>
            </body>
          </html>`)
        return
      }

      if (req.url === '/outer-frame') {
        res.end(`<!doctype html>
          <html>
            <head><title>Outer Frame</title></head>
            <body style="margin:8px">
              <h3>Outer Frame</h3>
              <iframe id="inner-frame" name="inner" src="/inner-frame" width="320" height="120" style="border:1px solid #888"></iframe>
            </body>
          </html>`)
        return
      }

      if (req.url === '/inner-frame') {
        res.end(`<!doctype html>
          <html>
            <head><title>Inner Frame</title></head>
            <body style="margin:8px">
              <button id="nested-btn" type="button">Nested Action</button>
              <div id="nested-status">idle</div>
              <script>
                document.getElementById('nested-btn').addEventListener('click', () => {
                  document.getElementById('nested-status').textContent = 'nested-clicked';
                });
              </script>
            </body>
          </html>`)
        return
      }

      if (req.url === '/hidden-frame') {
        res.end(`<!doctype html>
          <html><body><button id="secret-hidden-btn">Should Never Appear</button></body></html>`)
        return
      }

      res.end(`<!doctype html>
        <html>
          <head>
            <title>Cross-Frame Host</title>
            <style>
              body { font-family: sans-serif; margin: 16px; }
              .grid { display: flex; gap: 16px; margin-top: 12px; }
              iframe { border: 2px solid #444; }
            </style>
          </head>
          <body>
            <h1>Host Workspace Page</h1>
            <button id="save-btn" type="button">Host Save</button>
            <div class="grid">
              <iframe id="profile-frame" name="profile" src="/same-origin-frame" width="360" height="280"></iframe>
              <iframe id="promo-frame" name="promo" src="${crossUrl}/widget" width="360" height="280"></iframe>
            </div>
            <div style="margin-top: 12px;">
              <iframe id="outer-frame" name="outer" src="/outer-frame" width="380" height="190"></iframe>
            </div>
            <iframe id="hidden-frame" src="/hidden-frame" style="display:none" width="100" height="100"></iframe>
          </body>
        </html>`)
    })
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
    const hostPort = (hostServer.address() as { port: number }).port
    hostUrl = `http://127.0.0.1:${hostPort}`

    manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: tmpDir,
      memoryEnabled: false,
    })
  }, 30000)

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((resolve) => hostServer?.close(() => resolve()))
    await new Promise<void>((resolve) => crossServer?.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it(
    'discovers same-origin, nested, and cross-origin OOPIF iframes, flattens refs, translates boxes, and executes interactions',
    async () => {
      const opened = await manager.openTab(hostUrl)
      expect(opened.ok).toBe(true)

      // Allow cross-origin OOPIF to finish loading & attaching
      const readyPromo = await manager.runTool(opened.id, 'page_wait', {
        selector: '#promo-frame >> #promo-code',
        state: 'visible',
        timeout: 5000,
      })
      expect(readyPromo.ok).toBe(true)

      const read = await manager.renderAscii(opened.id)
      expect(read.ok).toBe(true)
      const snap = read.snapshot!

      // 1. Discovered frames summary: profile, promo (cross-origin), outer, inner — hidden frame excluded!
      expect(snap.frames).toBeDefined()
      expect(snap.frames!.length).toBeGreaterThanOrEqual(4)
      const promoFrame = snap.frames!.find((f) => f.name === 'promo')
      const profileFrame = snap.frames!.find((f) => f.name === 'profile')
      expect(promoFrame?.crossOrigin).toBe(true)
      expect(profileFrame?.crossOrigin).toBe(false)

      // Hidden iframe button must NOT be in flattened elements
      expect(snap.elements.find((e) => e.id === 'secret-hidden-btn')).toBeUndefined()

      // 2. Host #save-btn and Profile iframe #save-btn get DISTINCT selectors & DISTINCT eN refs
      const hostSave = snap.elements.find((e) => e.id === 'save-btn' && !e.frameId)
      const profileSave = snap.elements.find((e) => e.id === 'save-btn' && e.frameName === 'profile')
      expect(hostSave?.ref).toMatch(/^e\d+$/)
      expect(profileSave?.ref).toMatch(/^e\d+$/)
      expect(hostSave!.ref).not.toBe(profileSave!.ref)
      expect(hostSave!.selector).toBe('#save-btn')
      expect(profileSave!.selector).toBe('#profile-frame >> #save-btn')

      // 3. Coordinate translation: promo-frame is to the right of profile-frame (x > 360)
      const promoInput = snap.elements.find((e) => e.id === 'promo-code')
      const promoBtn = snap.elements.find((e) => e.id === 'apply-promo')
      expect(promoInput?.ref).toMatch(/^e\d+$/)
      expect(promoBtn?.ref).toMatch(/^e\d+$/)
      expect(promoInput!.box!.x).toBeGreaterThan(360)
      expect(promoBtn!.box!.x).toBeGreaterThan(360)

      // 4. ASCII rendering includes embedded form content and [eN] refs
      expect(read.ascii).toContain('Profile Details')
      expect(read.ascii).toContain('Cross-Origin Promo Widget')
      expect(read.ascii).toContain(`[${promoBtn!.ref}] < Apply Promo >`)

      // 5. Same-origin iframe interactions: fill, select, hover, click
      const emailEl = snap.elements.find((e) => e.id === 'customer-email')!
      const planEl = snap.elements.find((e) => e.id === 'plan-select')!
      const hoverEl = snap.elements.find((e) => e.id === 'hover-btn')!

      expect((await manager.runTool(opened.id, 'page_fill', { ref: emailEl.ref!, text: 'alice@velofy.co' })).ok).toBe(true)
      expect((await manager.runTool(opened.id, 'page_select', { ref: planEl.ref!, value: 'pro' })).ok).toBe(true)
      expect((await manager.runTool(opened.id, 'page_hover', { ref: hoverEl.ref! })).ok).toBe(true)
      expect((await manager.runTool(opened.id, 'page_click', { ref: profileSave!.ref!, allowSubmit: true })).ok).toBe(true)

      const waitProfile = await manager.runTool(opened.id, 'page_wait', {
        text: 'Saved alice@velofy.co (pro)',
        timeout: 3000,
      })
      expect(waitProfile.ok).toBe(true)

      // 6. Nested iframe interaction (#outer-frame >> #inner-frame >> #nested-btn)
      const nestedBtn = snap.elements.find((e) => e.id === 'nested-btn')
      expect(nestedBtn?.ref).toMatch(/^e\d+$/)
      expect(nestedBtn!.selector).toBe('#outer-frame >> #inner-frame >> #nested-btn')
      expect((await manager.runTool(opened.id, 'page_click', { ref: nestedBtn!.ref! })).ok).toBe(true)

      const waitNested = await manager.runTool(opened.id, 'page_wait', {
        text: 'nested-clicked',
        timeout: 3000,
      })
      expect(waitNested.ok).toBe(true)

      // 7. Cross-origin OOPIF interactions: fill + click + cross-frame waitFor
      expect((await manager.runTool(opened.id, 'page_fill', { ref: promoInput!.ref!, text: 'SAVE20' })).ok).toBe(true)
      expect((await manager.runTool(opened.id, 'page_click', { ref: promoBtn!.ref!, allowSubmit: true })).ok).toBe(true)

      const waitPromo = await manager.runTool(opened.id, 'page_wait', {
        selector: '#promo-frame >> #promo-status',
        text: 'Promo applied: SAVE20',
        timeout: 3000,
      })
      expect(waitPromo.ok).toBe(true)
    },
    30000,
  )
})
