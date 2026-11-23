import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElementDescriptor } from '../src/types.js'
import { parseHtmlDocument } from '../src/engine/lite.js'
import { BrowserManager } from '../src/engine/manager.js'

describe('M36: Lite parser support for fieldset/legend, details/summary, dialog, and ARIA button/link', () => {
  describe('<fieldset> and <legend>', () => {
    it('propagates disabled from <fieldset disabled> to descendant controls except the first <legend>', () => {
      const html = `<!doctype html>
      <html><body>
        <form action="/checkout" method="POST" aria-label="Checkout">
          <fieldset disabled>
            <legend><label><input id="toggle-ship" type="checkbox" name="ship_enabled" value="1" checked /> Enable Shipping</label></legend>
            <label for="addr">Address</label>
            <input id="addr" name="address" type="text" value="123 Main St" />
            <textarea name="notes">Leave at porch</textarea>
            <select name="speed">
              <option value="std" selected>Standard</option>
              <option value="exp">Express</option>
            </select>
            <input type="hidden" name="disabled_token" value="secret" />
            <legend><input id="second-legend-cb" type="checkbox" name="second_leg" value="1" /> Second Legend</legend>
            <button id="disabled-btn" type="submit">Disabled Save</button>
          </fieldset>
          <fieldset>
            <legend>Billing Info</legend>
            <label for="card">Cardholder</label>
            <input id="card" name="cardholder" type="text" value="Ada" />
            <input type="hidden" name="active_token" value="ok-token" />
            <button id="submit-btn" type="submit">Pay Now</button>
          </fieldset>
        </form>
      </body></html>`

      const doc = parseHtmlDocument(html, 'https://shop.example/checkout')

      // First <legend> checkbox is EXEMPT from <fieldset disabled> per HTML5 §4.10.16
      const toggleShip = doc.elements.find((e) => e.id === 'toggle-ship')
      expect(toggleShip).toBeDefined()
      expect(toggleShip?.disabled).toBe(false)

      // Controls inside the disabled fieldset body are disabled
      expect(doc.elements.find((e) => e.id === 'addr')?.disabled).toBe(true)
      expect(doc.elements.find((e) => e.tag === 'textarea')?.disabled).toBe(true)
      expect(doc.elements.find((e) => e.tag === 'select')?.disabled).toBe(true)
      expect(doc.elements.find((e) => e.id === 'disabled-btn')?.disabled).toBe(true)

      // Second <legend> inside disabled fieldset is NOT exempt
      expect(doc.elements.find((e) => e.id === 'second-legend-cb')?.disabled).toBe(true)

      // Hidden input inside disabled fieldset is marked disabled; active fieldset hidden input is not
      const formMeta = [...doc.forms.values()][0]!
      expect(formMeta.hiddenFields).toEqual([
        { name: 'disabled_token', value: 'secret', disabled: true },
        { name: 'active_token', value: 'ok-token' },
      ])

      // Controls inside the enabled second fieldset are enabled
      expect(doc.elements.find((e) => e.id === 'card')?.disabled).toBe(false)
      expect(doc.elements.find((e) => e.id === 'submit-btn')?.disabled).toBe(false)

      // Second fieldset legend emits a heading block because the form already has title "Checkout"
      expect(doc.blocks.some((b) => b.kind === 'heading' && b.tag === 'legend' && b.text === 'Billing Info')).toBe(true)
    })

    it('handles nested fieldsets and standalone fieldsets outside forms', () => {
      const html = `<!doctype html>
      <html><body>
        <fieldset>
          <legend>Standalone Preferences</legend>
          <input id="outside-ok" type="text" name="pref" />
          <fieldset disabled>
            <legend>Locked Group</legend>
            <fieldset>
              <legend>Inner Unlocked Tag Inside Disabled Ancestor</legend>
              <input id="nested-locked" type="text" name="locked" />
            </fieldset>
          </fieldset>
          <input id="after-locked" type="text" name="after" />
        </fieldset>
      </body></html>`

      const doc = parseHtmlDocument(html, 'https://example.com/')
      expect(doc.blocks.some((b) => b.kind === 'heading' && b.tag === 'legend' && b.text === 'Standalone Preferences')).toBe(true)
      expect(doc.blocks.some((b) => b.kind === 'heading' && b.tag === 'legend' && b.text === 'Locked Group')).toBe(true)
      expect(doc.elements.find((e) => e.id === 'outside-ok')?.disabled).toBe(false)
      expect(doc.elements.find((e) => e.id === 'nested-locked')?.disabled).toBe(true)
      expect(doc.elements.find((e) => e.id === 'after-locked')?.disabled).toBe(false)
    })
  })

  describe('<details> and <summary>', () => {
    it('hides body of collapsed <details>, renders expanded <details open>, and synthesizes default summary', () => {
      const html = `<!doctype html>
      <html><body>
        <h1>FAQ</h1>
        <details id="faq-closed">
          <summary>How does pricing work?</summary>
          <p>Hidden pricing answer.</p>
          <a href="/pricing">Secret Pricing Link</a>
        </details>
        <details id="faq-open" open>
          <summary><strong>What</strong> is supported?</summary>
          <p>Pure Node HTML parsing.</p>
          <a href="/docs">Read Docs</a>
        </details>
        <details id="no-summary">
          <p>Hidden default summary body.</p>
        </details>
      </body></html>`

      const doc = parseHtmlDocument(html, 'https://example.com/')

      // Collapsed details: summary visible with '>' marker, body hidden
      const closedSummary = doc.elements.find((e) => e.tag === 'summary' && e.text === 'How does pricing work?')
      expect(closedSummary).toBeDefined()
      expect(closedSummary?.role).toBe('button')
      expect(closedSummary?.checked).toBe(false)
      expect(doc.blocks.some((b) => b.tag === 'summary' && b.text === '> How does pricing work?')).toBe(true)
      expect(doc.text).not.toContain('Hidden pricing answer.')
      expect(doc.elements.some((e) => e.text === 'Secret Pricing Link')).toBe(false)

      // Expanded details: summary visible with 'v' marker, body & link visible
      const openSummary = doc.elements.find((e) => e.tag === 'summary' && e.text === 'What is supported?')
      expect(openSummary).toBeDefined()
      expect(openSummary?.checked).toBe(true)
      expect(doc.blocks.some((b) => b.tag === 'summary' && b.text === 'v What is supported?')).toBe(true)
      expect(doc.text).toContain('Pure Node HTML parsing.')
      expect(doc.elements.some((e) => e.tag === 'a' && e.text === 'Read Docs')).toBe(true)

      // Missing <summary>: synthesizes default "Details" toggle
      const defaultSummary = doc.elements.find((e) => e.tag === 'summary' && e.text === 'Details')
      expect(defaultSummary).toBeDefined()
      expect(defaultSummary?.checked).toBe(false)
      expect(doc.text).not.toContain('Hidden default summary body.')

      // Toggle map populated for all three <details>
      expect(doc.detailsBySummarySelector?.get(closedSummary!.selector)).toBe('#faq-closed')
      expect(doc.detailsBySummarySelector?.get(openSummary!.selector)).toBe('#faq-open')
      expect(doc.detailsBySummarySelector?.get(defaultSummary!.selector)).toBe('#no-summary')
    })

    it('respects nested <details> visibility and detailsOpen overrides', () => {
      const html = `<!doctype html>
      <html><body>
        <details id="outer">
          <summary>Outer</summary>
          <p>Outer body</p>
          <details id="inner">
            <summary>Inner</summary>
            <p>Inner secret</p>
          </details>
        </details>
      </body></html>`

      // Both closed: only Outer summary visible
      const d0 = parseHtmlDocument(html, 'https://example.com/')
      expect(d0.elements.map((e) => e.text)).toEqual(['Outer'])
      expect(d0.text).not.toContain('Outer body')
      expect(d0.text).not.toContain('Inner')

      // Outer open, inner closed: Outer + Outer body + Inner summary visible, Inner secret hidden
      const d1 = parseHtmlDocument(html, 'https://example.com/', 0, {
        detailsOpen: new Map([['#outer', true]]),
      })
      expect(d1.elements.map((e) => e.text)).toEqual(['Outer', 'Inner'])
      expect(d1.text).toContain('Outer body')
      expect(d1.text).not.toContain('Inner secret')

      // Both open: everything visible
      const d2 = parseHtmlDocument(html, 'https://example.com/', 0, {
        detailsOpen: new Map([
          ['#outer', true],
          ['#inner', true],
        ]),
      })
      expect(d2.text).toContain('Inner secret')
    })
  })

  describe('<dialog>', () => {
    it('hides closed <dialog> content and renders open <dialog> with heading, controls, and method="dialog" binding', () => {
      const html = `<!doctype html>
      <html><body>
        <h1>Dashboard</h1>
        <dialog id="closed-dlg" aria-label="Hidden Modal">
          <h2>Should Not Appear</h2>
          <p>Invisible modal text</p>
          <button>Hidden Button</button>
        </dialog>
        <dialog id="open-dlg" open aria-label="Delete Cluster">
          <p>Are you sure you want to delete prod-1?</p>
          <form method="dialog">
            <button id="dlg-confirm" type="submit" value="confirm">Confirm Delete</button>
            <button id="dlg-cancel" type="submit" value="cancel">Cancel</button>
          </form>
        </dialog>
      </body></html>`

      const doc = parseHtmlDocument(html, 'https://example.com/')

      // Closed dialog completely excluded
      expect(doc.text).not.toContain('Should Not Appear')
      expect(doc.text).not.toContain('Invisible modal text')
      expect(doc.elements.some((e) => e.text === 'Hidden Button')).toBe(false)

      // Open dialog visible with heading & divider
      expect(doc.blocks.some((b) => b.kind === 'heading' && b.tag === 'dialog' && b.text === '[Dialog: Delete Cluster]')).toBe(true)
      expect(doc.text).toContain('Are you sure you want to delete prod-1?')
      expect(doc.elements.some((e) => e.id === 'dlg-confirm')).toBe(true)
      expect(doc.elements.some((e) => e.id === 'dlg-cancel')).toBe(true)

      // Form with method="dialog" binds dialogKey
      const dlgForm = [...doc.forms.values()][0]
      expect(dlgForm?.method).toBe('DIALOG')
      expect(dlgForm?.dialogKey).toBe('#open-dlg')

      // Overriding dialogOpen to false hides the open dialog
      const closedDoc = parseHtmlDocument(html, 'https://example.com/', 0, {
        dialogOpen: new Map([['#open-dlg', false]]),
      })
      expect(closedDoc.text).not.toContain('Are you sure you want to delete prod-1?')
      expect(closedDoc.elements.some((e) => e.id === 'dlg-confirm')).toBe(false)
    })
  })

  describe('ARIA role="button" and role="link"', () => {
    it('parses ARIA buttons and links on non-native elements including nested divs, inline links, and aria-disabled', () => {
      const html = `<!doctype html>
      <html>
        <head><base href="https://app.example/v2/" /></head>
        <body>
          <div role="navigation">
            <a href="home">Home</a>
          </div>
          <div id="deploy-btn" role="button" tabindex="0">
            <div class="icon">+</div>
            <div class="text">Deploy Release</div>
          </div>
          <span id="disabled-aria" role="button" aria-disabled="true">Locked Action</span>
          <span id="docs-link" role="link" data-href="docs/start">Getting Started</span>
          <p>Read the <span id="inline-aria-link" role="link" data-href="api">API Reference</span> for details.</p>
          <ul>
            <li id="li-aria-link" role="link" href="changelog">Changelog</li>
            <li><div id="li-inner-btn" role="switch button" aria-label="Toggle Dark Mode"><span>Off</span></div></li>
          </ul>
          <img id="gear-btn" role="button" alt="Open Settings" src="/gear.png" />
        </body>
      </html>`

      const doc = parseHtmlDocument(html, 'https://app.example/index.html')

      // role="navigation" does NOT swallow its child <a>
      expect(doc.elements.some((e) => e.tag === 'a' && e.text === 'Home' && e.href === 'https://app.example/v2/home')).toBe(true)

      // Nested <div> inside <div role="button"> extracted with balanced tags
      const deployBtn = doc.elements.find((e) => e.id === 'deploy-btn')
      expect(deployBtn).toBeDefined()
      expect(deployBtn?.tag).toBe('div')
      expect(deployBtn?.role).toBe('button')
      expect(deployBtn?.type).toBe('button')
      expect(deployBtn?.text).toBe('+ Deploy Release')
      expect(deployBtn?.disabled).toBeUndefined()

      // aria-disabled="true"
      const disabledBtn = doc.elements.find((e) => e.id === 'disabled-aria')
      expect(disabledBtn?.disabled).toBe(true)

      // <span role="link" data-href="..."> resolves against <base href>
      const docsLink = doc.elements.find((e) => e.id === 'docs-link')
      expect(docsLink?.tag).toBe('span')
      expect(docsLink?.role).toBe('link')
      expect(docsLink?.type).toBe('link')
      expect(docsLink?.text).toBe('Getting Started')
      expect(docsLink?.href).toBe('https://app.example/v2/docs/start')

      // Inline <span role="link"> inside <p>
      const inlineLink = doc.elements.find((e) => e.id === 'inline-aria-link')
      expect(inlineLink?.role).toBe('link')
      expect(inlineLink?.href).toBe('https://app.example/v2/api')
      const paraBlock = doc.blocks.find((b) => b.kind === 'paragraph' && b.text.includes('API Reference'))
      expect(paraBlock?.links?.some((l) => l.text === 'API Reference' && l.selector === '#inline-aria-link')).toBe(true)

      // <li role="link"> and nested fallback role="switch button"
      const liLink = doc.elements.find((e) => e.id === 'li-aria-link')
      expect(liLink?.role).toBe('link')
      expect(liLink?.href).toBe('https://app.example/v2/changelog')

      const switchBtn = doc.elements.find((e) => e.id === 'li-inner-btn')
      expect(switchBtn?.role).toBe('button')
      expect(switchBtn?.text).toBe('Toggle Dark Mode')

      // <img role="button" alt="Open Settings" />
      const imgBtn = doc.elements.find((e) => e.id === 'gear-btn')
      expect(imgBtn?.tag).toBe('img')
      expect(imgBtn?.role).toBe('button')
      expect(imgBtn?.text).toBe('Open Settings')
    })
  })

  describe('Interactive LiteTab + BrowserManager E2E', () => {
    let server: http.Server
    let baseUrl = ''
    let tmpDir = ''
    let manager: BrowserManager
    let submitCount = 0
    let lastFormBody = ''

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m36-lite-'))
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/submit' && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => {
            body += String(chunk)
          })
          req.on('end', () => {
            submitCount += 1
            lastFormBody = body
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<html><head><title>Submitted</title></head><body><h1>Submitted</h1><p>${body}</p></body></html>`)
          })
          return
        }
        if (url.pathname === '/aria-target') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<html><head><title>ARIA Target</title></head><body><h1>Arrived via ARIA Link</h1></body></html>`)
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html>
        <html>
          <head><title>Semantic Interactive Page</title></head>
          <body>
            <h1>Semantic Demo</h1>
            <details id="more-info">
              <summary id="toggle-info">Show Secret Section</summary>
              <p>Revealed secret content!</p>
              <span id="secret-aria-link" role="link" data-href="/aria-target">Jump to ARIA Target</span>
            </details>

            <dialog id="welcome-modal" open aria-label="Welcome">
              <p>Welcome modal body</p>
              <form method="dialog">
                <button id="dismiss-modal" type="submit" value="ack">Got it</button>
              </form>
            </dialog>

            <form action="/submit" method="POST" aria-label="Order">
              <fieldset disabled>
                <legend><label><input id="opt-in" type="checkbox" name="opt_in" value="yes" checked /> Opt-In</label></legend>
                <input id="locked-field" name="locked" type="text" value="nope" />
              </fieldset>
              <fieldset>
                <legend>Active Fields</legend>
                <label for="buyer">Buyer</label>
                <input id="buyer" name="buyer" type="text" value="Grace" />
                <button id="order-submit" type="submit">Place Order</button>
              </fieldset>
            </form>

            <div id="custom-btn" role="button" tabindex="0">Run Custom Action</div>
            <div id="disabled-btn" role="button" aria-disabled="true">Cannot Click</div>
          </body>
        </html>`)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://127.0.0.1:${port}`
      manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
    })

    afterAll(async () => {
      await manager.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('toggles <details>, closes <dialog> via method="dialog", enforces <fieldset disabled>, and clicks ARIA buttons/links', async () => {
      const tab = await manager.openTab(baseUrl, true)
      const tabId = tab.id

      type ReadResult = {
        ok: boolean
        url: string
        title: string
        ascii: string
        content: string
        elements: ElementDescriptor[]
      }
      const readAscii = async () =>
        (await manager.runTool(tabId, 'page_read_ascii', { width: 90 })) as ReadResult

      // Initial read
      const r1 = await readAscii()
      const ascii1 = r1.ascii

      // 1. Collapsed <details> shows '>' summary, hides secret content
      expect(ascii1).toContain('> Show Secret Section')
      expect(ascii1).not.toContain('Revealed secret content!')
      expect(ascii1).toContain('[Dialog: Welcome]')
      expect(ascii1).toContain('Welcome modal body')

      // Fill buyer input before toggling <details> to verify form state preservation
      const buyerEl = r1.elements.find((e) => e.id === 'buyer')!
      await manager.runTool(tabId, 'page_fill', { ref: buyerEl.ref, value: 'Linus' })

      // 2. Click <summary> to expand <details>
      const summaryEl = r1.elements.find((e) => e.id === 'toggle-info')!
      const expandRes = (await manager.runTool(tabId, 'page_click', { ref: summaryEl.ref })) as {
        ok: boolean
        note?: string
      }
      expect(expandRes.ok).toBe(true)
      expect(expandRes.note).toBe('details expanded')

      const r2 = await readAscii()
      const ascii2 = r2.ascii
      expect(ascii2).toContain('v Show Secret Section')
      expect(ascii2).toContain('Revealed secret content!')
      expect(ascii2).toContain('Jump to ARIA Target')
      // Buyer value preserved across details re-parse!
      expect(r2.elements.find((e) => e.id === 'buyer')?.value).toBe('Linus')

      // 3. Click <form method="dialog"> submit button -> closes dialog without HTTP request
      const dismissEl = r2.elements.find((e) => e.id === 'dismiss-modal')!
      const closeDlgRes = (await manager.runTool(tabId, 'page_click', { ref: dismissEl.ref })) as {
        ok: boolean
        note?: string
      }
      expect(closeDlgRes.ok).toBe(true)
      expect(closeDlgRes.note).toContain('closed dialog')
      expect(submitCount).toBe(0)

      const r3 = await readAscii()
      expect(r3.ascii).not.toContain('Welcome modal body')
      expect(r3.elements.some((e) => e.id === 'dismiss-modal')).toBe(false)

      // 4. Disabled ARIA button refuses click; enabled ARIA button succeeds
      const disabledAriaEl = r3.elements.find((e) => e.id === 'disabled-btn')!
      const disabledClick = (await manager.runTool(tabId, 'page_click', { ref: disabledAriaEl.ref })) as {
        ok: boolean
        note?: string
      }
      expect(disabledClick.ok).toBe(false)
      expect(disabledClick.note).toContain('disabled')

      const customBtnEl = r3.elements.find((e) => e.id === 'custom-btn')!
      const customClick = (await manager.runTool(tabId, 'page_click', { ref: customBtnEl.ref })) as {
        ok: boolean
      }
      expect(customClick.ok).toBe(true)

      // 5. Clicking ARIA role="link" revealed inside <details> navigates to /aria-target
      const ariaLinkEl = r3.elements.find((e) => e.id === 'secret-aria-link')!
      expect(ariaLinkEl.role).toBe('link')
      expect(ariaLinkEl.ref).toBeTruthy()
      const navClick = (await manager.runTool(tabId, 'page_click', { ref: ariaLinkEl.ref })) as {
        ok: boolean
      }
      expect(navClick.ok).toBe(true)
      const afterNav = await readAscii()
      expect(afterNav.title).toBe('ARIA Target')
      expect(afterNav.ascii).toContain('ARRIVED VIA ARIA LINK')

      // 6. Navigate back and submit form: verifies <fieldset disabled> excludes locked field while keeping first <legend> checkbox
      await manager.runTool(tabId, 'page_navigate', { url: baseUrl })
      const rForm = await readAscii()
      const submitEl = rForm.elements.find((e) => e.id === 'order-submit')!
      await manager.runTool(tabId, 'page_click', { ref: submitEl.ref, allowSubmit: true })

      expect(submitCount).toBe(1)
      const params = new URLSearchParams(lastFormBody)
      expect(params.get('opt_in')).toBe('yes')
      expect(params.get('buyer')).toBe('Grace')
      expect(params.has('locked')).toBe(false)
    })
  })
})
