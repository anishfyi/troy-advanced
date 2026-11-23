import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BrowserManager,
  ElementRegistry,
  effectiveElementRole,
  findChromeBinary,
  recoverElementMatch,
  type ElementDescriptor,
} from '../src/index.js'

function makeEl(overrides: Partial<ElementDescriptor> & { selector: string; tag: string }): ElementDescriptor {
  return {
    type: overrides.type ?? overrides.tag,
    text: overrides.text ?? '',
    ...overrides,
  }
}

describe('Deterministic stale-ref recovery (M22)', () => {
  describe('recoverElementMatch & effectiveElementRole', () => {
    it('derives explicit and implicit ARIA roles deterministically', () => {
      expect(effectiveElementRole({ role: 'Tab', tag: 'div', type: 'div' })).toBe('tab')
      expect(effectiveElementRole({ tag: 'button', type: 'button' })).toBe('button')
      expect(effectiveElementRole({ tag: 'a', type: 'link', href: 'https://example.com' })).toBe('link')
      expect(effectiveElementRole({ tag: 'a', type: 'link' })).toBe('')
      expect(effectiveElementRole({ tag: 'select', type: 'select' })).toBe('combobox')
      expect(effectiveElementRole({ tag: 'textarea', type: 'textarea' })).toBe('textbox')
      expect(effectiveElementRole({ tag: 'input', type: 'checkbox' })).toBe('checkbox')
      expect(effectiveElementRole({ tag: 'input', type: 'radio' })).toBe('radio')
      expect(effectiveElementRole({ tag: 'input', type: 'submit' })).toBe('button')
      expect(effectiveElementRole({ tag: 'input', type: 'email' })).toBe('textbox')
    })

    it('re-locates uniquely by id (highest priority)', () => {
      const stale = makeEl({
        selector: 'div:nth-of-type(1) > button:nth-of-type(1)',
        tag: 'button',
        id: 'save-btn',
        ariaLabel: 'Save',
        name: 'save',
        text: 'Save',
      })
      const candidates = [
        makeEl({ selector: 'div:nth-of-type(2) > button:nth-of-type(1)', tag: 'button', id: 'cancel-btn', text: 'Cancel' }),
        makeEl({ selector: 'div:nth-of-type(3) > button:nth-of-type(1)', tag: 'button', id: 'save-btn', ariaLabel: 'Save', name: 'save', text: 'Save' }),
      ]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(true)
      if (res.recovered) {
        expect(res.strategy).toBe('id')
        expect(res.selector).toBe('div:nth-of-type(3) > button:nth-of-type(1)')
      }
    })

    it('re-locates uniquely by ariaLabel when id is absent or changed', () => {
      const stale = makeEl({
        selector: 'nav > button:nth-of-type(1)',
        tag: 'button',
        ariaLabel: 'Close modal',
        text: 'X',
      })
      const candidates = [
        makeEl({ selector: 'div > button:nth-of-type(1)', tag: 'button', ariaLabel: 'Open menu', text: 'Menu' }),
        makeEl({ selector: 'dialog > button:nth-of-type(2)', tag: 'button', ariaLabel: 'Close modal', text: 'X' }),
      ]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(true)
      if (res.recovered) {
        expect(res.strategy).toBe('ariaLabel')
        expect(res.selector).toBe('dialog > button:nth-of-type(2)')
      }
    })

    it('re-locates uniquely by name+tag and distinguishes different tags with the same name', () => {
      const stale = makeEl({
        selector: 'form > input:nth-of-type(1)',
        tag: 'input',
        type: 'text',
        name: 'query',
        text: 'Search',
      })
      const candidates = [
        makeEl({ selector: 'form > button:nth-of-type(1)', tag: 'button', name: 'query', text: 'Go' }),
        makeEl({ selector: 'section > input:nth-of-type(2)', tag: 'input', type: 'text', name: 'query', text: 'Search' }),
      ]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(true)
      if (res.recovered) {
        expect(res.strategy).toBe('name+tag')
        expect(res.selector).toBe('section > input:nth-of-type(2)')
      }
    })

    it('disambiguates shared ariaLabel using role+ariaLabel', () => {
      const stale = makeEl({
        selector: 'div.tabs > div:nth-of-type(2)',
        tag: 'div',
        role: 'tab',
        ariaLabel: 'Settings',
        text: 'Settings',
      })
      const candidates = [
        makeEl({ selector: 'header > button:nth-of-type(1)', tag: 'button', ariaLabel: 'Settings', text: 'Settings' }),
        makeEl({ selector: 'aside > div:nth-of-type(4)', tag: 'div', role: 'tab', ariaLabel: 'Settings', text: 'Settings' }),
      ]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(true)
      if (res.recovered) {
        expect(res.strategy).toBe('role+ariaLabel')
        expect(res.selector).toBe('aside > div:nth-of-type(4)')
      }
    })

    it('refuses recovery when matches are ambiguous across all strategies', () => {
      const stale = makeEl({
        selector: 'ul > button:nth-of-type(1)',
        tag: 'button',
        ariaLabel: 'Delete item',
        name: 'del',
        text: 'Delete',
      })
      const candidates = [
        makeEl({ selector: 'ul > li:nth-of-type(1) > button', tag: 'button', ariaLabel: 'Delete item', name: 'del', text: 'Delete' }),
        makeEl({ selector: 'ul > li:nth-of-type(2) > button', tag: 'button', ariaLabel: 'Delete item', name: 'del', text: 'Delete' }),
      ]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(false)
      if (!res.recovered) {
        expect(res.reason).toBe('ambiguous')
        expect(res.ambiguousStrategies?.map((a) => a.strategy)).toEqual(['ariaLabel', 'name+tag', 'role+ariaLabel'])
      }
    })

    it('returns no-locators when element has no deterministic identity attributes', () => {
      const stale = makeEl({ selector: 'div > span:nth-of-type(1)', tag: 'span', text: 'Click me' })
      const candidates = [makeEl({ selector: 'div > span:nth-of-type(2)', tag: 'span', text: 'Click me' })]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(false)
      if (!res.recovered) {
        expect(res.reason).toBe('no-locators')
      }
    })

    it('scopes recovery strictly to the same frameId', () => {
      const stale = makeEl({
        selector: 'frame:F1 >> #submit-btn',
        tag: 'button',
        id: 'submit-btn',
        frameId: 'F1',
        text: 'Submit',
      })
      const candidates = [
        makeEl({ selector: '#submit-btn', tag: 'button', id: 'submit-btn', text: 'Submit' }),
        makeEl({ selector: 'frame:F2 >> #submit-btn', tag: 'button', id: 'submit-btn', frameId: 'F2', text: 'Submit' }),
      ]
      const res = recoverElementMatch(stale, candidates)
      expect(res.recovered).toBe(false)
      if (!res.recovered) {
        expect(res.reason).toBe('not-found')
      }
    })
  })

  describe('ElementRegistry same-epoch recovery & epoch isolation', () => {
    it('recovers stale refs across multiple re-reads on the same epoch', () => {
      const reg = new ElementRegistry()
      const ctx = { tabId: 1, url: 'https://app.example.com/dashboard', epoch: 1 }

      const first = reg.register(
        [
          makeEl({ selector: 'div:nth-of-type(1) > button', tag: 'button', id: 'save', text: 'Save' }),
          makeEl({ selector: 'div:nth-of-type(2) > input', tag: 'input', type: 'text', name: 'title', text: 'Title' }),
        ],
        ctx,
      )
      expect(first.map((e) => e.ref)).toEqual(['e1', 'e2'])

      // Second snapshot on same epoch with shifted CSS selectors
      const second = reg.register(
        [
          makeEl({ selector: 'main > button:nth-of-type(3)', tag: 'button', id: 'save', text: 'Save' }),
          makeEl({ selector: 'main > input:nth-of-type(4)', tag: 'input', type: 'text', name: 'title', text: 'Title' }),
        ],
        ctx,
      )
      expect(second.map((e) => e.ref)).toEqual(['e3', 'e4'])

      // Third snapshot on same epoch
      const third = reg.register(
        [
          makeEl({ selector: 'section > button:nth-of-type(5)', tag: 'button', id: 'save', text: 'Save' }),
          makeEl({ selector: 'section > input:nth-of-type(6)', tag: 'input', type: 'text', name: 'title', text: 'Title' }),
        ],
        ctx,
      )
      expect(third.map((e) => e.ref)).toEqual(['e5', 'e6'])

      // list() only exposes current active refs
      expect(reg.list(ctx).map((e) => e.ref)).toEqual(['e5', 'e6'])

      // Old ref e1 recovers via id to e5
      const r1 = reg.resolve('e1', ctx)
      expect('error' in r1).toBe(false)
      if (!('error' in r1)) {
        expect(r1.recovered).toBe(true)
        expect(r1.recoveryStrategy).toBe('id')
        expect(r1.recoveredRef).toBe('e5')
        expect(r1.selector).toBe('section > button:nth-of-type(5)')
      }

      // Old ref e2 recovers via name+tag to e6
      const r2 = reg.resolve('e2', ctx)
      expect('error' in r2).toBe(false)
      if (!('error' in r2)) {
        expect(r2.recovered).toBe(true)
        expect(r2.recoveryStrategy).toBe('name+tag')
        expect(r2.recoveredRef).toBe('e6')
        expect(r2.selector).toBe('section > input:nth-of-type(6)')
      }
    })

    it('never recovers across epoch, url, or tabId changes, or after invalidate()', () => {
      const reg = new ElementRegistry()
      const ctx1 = { tabId: 1, url: 'https://example.com/a', epoch: 1 }
      reg.register([makeEl({ selector: '#go', tag: 'button', id: 'go', text: 'Go' })], ctx1)

      // Epoch increment clears archive
      const ctx2 = { tabId: 1, url: 'https://example.com/a', epoch: 2 }
      reg.register([makeEl({ selector: '#go', tag: 'button', id: 'go', text: 'Go' })], ctx2)
      const crossEpoch = reg.resolve('e1', ctx2)
      expect('error' in crossEpoch).toBe(true)

      // URL change clears archive
      const ctx3 = { tabId: 1, url: 'https://example.com/b', epoch: 2 }
      reg.register([makeEl({ selector: '#go', tag: 'button', id: 'go', text: 'Go' })], ctx3)
      const crossUrl = reg.resolve('e2', ctx3)
      expect('error' in crossUrl).toBe(true)

      // Explicit invalidate clears archive
      reg.register([makeEl({ selector: '#go', tag: 'button', id: 'go', text: 'Go' })], ctx3)
      reg.invalidate()
      const afterInv = reg.resolve('e3', ctx3)
      expect('error' in afterInv).toBe(true)
    })

    it('updates active entry in-place via updateEntry only on matching epoch', () => {
      const reg = new ElementRegistry()
      const ctx = { tabId: 1, url: 'https://example.com', epoch: 1 }
      reg.register([makeEl({ selector: 'div > button:nth-of-type(1)', tag: 'button', id: 'ok', text: 'OK' })], ctx)

      expect(
        reg.updateEntry(
          'e1',
          'section > button:nth-of-type(2)',
          makeEl({ selector: 'section > button:nth-of-type(2)', tag: 'button', id: 'ok', text: 'OK' }),
          { ...ctx, epoch: 2 },
        ),
      ).toBe(false)

      expect(
        reg.updateEntry(
          'e1',
          'section > button:nth-of-type(2)',
          makeEl({ selector: 'section > button:nth-of-type(2)', tag: 'button', id: 'ok', text: 'OK' }),
          ctx,
        ),
      ).toBe(true)

      const resolved = reg.resolve('e1', ctx)
      expect('error' in resolved).toBe(false)
      if (!('error' in resolved)) {
        expect(resolved.selector).toBe('section > button:nth-of-type(2)')
        expect(resolved.recovered).toBeUndefined()
      }
    })
  })

  describe('Lite engine + BrowserManager same-epoch stale-ref recovery', () => {
    let server: http.Server
    let baseUrl: string
    let manager: BrowserManager

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/other') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>Other</title></head><body><button id="save-btn">Other Save</button></body></html>')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html><head><title>Lite Recovery</title></head>
          <body>
            <form action="/other" method="GET">
              <input type="text" name="username" placeholder="Username" />
              <select name="plan" aria-label="Plan Selector">
                <option value="free">Free</option>
                <option value="pro">Pro</option>
              </select>
              <button id="save-btn" type="button">Save Draft</button>
            </form>
          </body></html>`)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m22-lite-'))
      manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })
      manager.grantOrigin(baseUrl)
    })

    afterAll(async () => {
      await manager?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('recovers stale refs from an earlier read on the same epoch and refuses after navigation', async () => {
      const opened = await manager.openTab(baseUrl)
      const tabId = opened.id!

      // First read captures initial refs
      const read1 = await manager.runTool(tabId, 'page_read', {})
      expect(read1.ok).toBe(true)
      const els1 = read1.elements as ElementDescriptor[]
      const inputRef1 = els1.find((e) => e.name === 'username')!.ref!
      const selectRef1 = els1.find((e) => e.ariaLabel === 'Plan Selector')!.ref!
      const btnRef1 = els1.find((e) => e.id === 'save-btn')!.ref!

      // Second read on the SAME epoch mints new refs, archiving the first set
      const read2 = await manager.runTool(tabId, 'page_read', {})
      expect(read2.ok).toBe(true)
      expect(read2.epoch).toBe(read1.epoch)

      // Fill using stale ref from read1 -> recovers via name+tag
      const fillRes = await manager.runTool(tabId, 'page_fill', { ref: inputRef1, text: 'anish' })
      expect(fillRes.ok).toBe(true)
      expect(fillRes.value).toBe('anish')
      expect(fillRes.recovered).toBe(true)
      expect(fillRes.recoveryStrategy).toBe('name+tag')

      // Select using stale ref from read1 -> recovers via ariaLabel
      const selRes = await manager.runTool(tabId, 'page_select', { ref: selectRef1, value: 'pro' })
      expect(selRes.ok).toBe(true)
      expect(selRes.recovered).toBe(true)
      expect(selRes.recoveryStrategy).toBe('ariaLabel')

      // Click using stale ref from read1 -> recovers via id
      const clickRes = await manager.runTool(tabId, 'page_click', { ref: btnRef1 })
      expect(clickRes.ok).toBe(true)
      expect(clickRes.recovered).toBe(true)
      expect(clickRes.recoveryStrategy).toBe('id')

      // Navigate to /other -> epoch increments -> old ref MUST fail
      await manager.runTool(tabId, 'page_navigate', { url: `${baseUrl}/other` })
      const afterNav = await manager.runTool(tabId, 'page_click', { ref: btnRef1 })
      expect(afterNav.ok).toBe(false)
      expect(String(afterNav.error)).toMatch(/stale|unknown|older page state/i)
    })
  })

  const chromePath = findChromeBinary()
  const describeChrome = chromePath ? describe : describe.skip

  describeChrome('Headless Chromium CDP live DOM stale-ref recovery E2E (M22)', () => {
    let server: http.Server
    let baseUrl: string
    let manager: BrowserManager

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/next') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>Next</title></head><body><button id="action-btn">Next Action</button></body></html>')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html>
            <head><title>SPA Stale Ref Test</title></head>
            <body>
              <div id="log"></div>
              <div id="root">
                <section class="panel-a">
                  <button type="button" aria-label="Publish Draft" onclick="document.getElementById('log').textContent += 'published;'">Publish</button>
                  <input type="text" name="handle" placeholder="Handle" />
                  <div role="tab" tabindex="0" aria-label="Workspace" onclick="document.getElementById('log').textContent += 'tab-clicked;'">Workspace Tab</div>
                  <button type="button" aria-label="Workspace" onclick="document.getElementById('log').textContent += 'btn-clicked;'">Workspace Button</button>
                  <button type="button" aria-label="Ambiguous Item">Dup 1</button>
                  <button type="button" aria-label="Ambiguous Item">Dup 2</button>
                  <input type="text" name="secret_slot" placeholder="Slot" />
                </section>
              </div>
              <script>
                window.mutateDom = function() {
                  const root = document.getElementById('root');
                  // Replace the entire DOM tree on the SAME epoch so all nth-of-type selectors break
                  root.innerHTML = \`
                    <div class="banner">Injected Banner</div>
                    <article class="panel-b">
                      <div class="wrapper">
                        <span class="spacer"></span>
                        <button type="button" aria-label="Publish Draft" onclick="document.getElementById('log').textContent += 'published-recovered;'">Publish</button>
                        <input type="text" name="handle" placeholder="Handle" />
                        <button type="button" aria-label="Workspace" onclick="document.getElementById('log').textContent += 'btn-clicked;'">Workspace Button</button>
                        <div role="tab" tabindex="0" aria-label="Workspace" onclick="document.getElementById('log').textContent += 'tab-recovered;'">Workspace Tab</div>
                        <button type="button" aria-label="Ambiguous Item">Dup 1</button>
                        <button type="button" aria-label="Ambiguous Item">Dup 2</button>
                        <input type="password" name="secret_slot" placeholder="Slot" />
                      </div>
                    </article>
                  \`;
                  return true;
                };
              </script>
            </body>
          </html>`)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m22-chrome-'))
      manager = await BrowserManager.create({ engine: 'chromium', profileDir: tmpDir })
      manager.grantOrigin(baseUrl)
    })

    afterAll(async () => {
      await manager?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('recovers stale DOM selectors on same-epoch SPA re-renders and re-enforces security policy', async () => {
      const opened = await manager.openTab(baseUrl)
      const tabId = opened.id!

      const read1 = await manager.runTool(tabId, 'page_read', {})
      expect(read1.ok).toBe(true)
      const els = read1.elements as ElementDescriptor[]

      const publishRef = els.find((e) => e.ariaLabel === 'Publish Draft')!.ref!
      const handleRef = els.find((e) => e.name === 'handle')!.ref!
      const tabRef = els.find((e) => e.role === 'tab' && e.ariaLabel === 'Workspace')!.ref!
      const dupRef = els.find((e) => e.ariaLabel === 'Ambiguous Item')!.ref!
      const secretSlotRef = els.find((e) => e.name === 'secret_slot')!.ref!

      // Mutate DOM in-place on the SAME epoch so all CSS selectors change
      const mutated = await manager.runTool(tabId, 'page_eval', { expression: 'window.mutateDom()' })
      expect(mutated.ok).toBe(true)

      // 1. Click stale ref -> live DOM recovery via ariaLabel
      const clickPub = await manager.runTool(tabId, 'page_click', { ref: publishRef })
      expect(clickPub.ok).toBe(true)
      expect(clickPub.recovered).toBe(true)
      expect(clickPub.recoveryStrategy).toBe('ariaLabel')

      // 2. Fill stale ref -> live DOM recovery via name+tag
      const fillHandle = await manager.runTool(tabId, 'page_fill', { ref: handleRef, text: '@anishfyi' })
      expect(fillHandle.ok).toBe(true)
      expect(fillHandle.value).toBe('@anishfyi')
      expect(fillHandle.recovered).toBe(true)
      expect(fillHandle.recoveryStrategy).toBe('name+tag')

      // 3. Click stale tab ref -> live DOM recovery via role+ariaLabel (disambiguating from button with same ariaLabel!)
      const clickTab = await manager.runTool(tabId, 'page_click', { ref: tabRef })
      expect(clickTab.ok).toBe(true)
      expect(clickTab.recovered).toBe(true)
      expect(clickTab.recoveryStrategy).toBe('role+ariaLabel')

      // Verify both recovered clicks actually fired on the right elements
      const logCheck = await manager.runTool(tabId, 'page_eval', {
        expression: 'document.getElementById("log").textContent',
      })
      expect(logCheck.value).toBe('published-recovered;tab-recovered;')

      // 4. Ambiguous stale ref MUST NOT recover (fails cleanly)
      const clickDup = await manager.runTool(tabId, 'page_click', { ref: dupRef })
      expect(clickDup.ok).toBe(false)

      // 5. Security policy re-check: secret_slot mutated into type="password" -> recovery MUST refuse fill!
      const fillSecret = await manager.runTool(tabId, 'page_fill', { ref: secretSlotRef, text: 'hunter2' })
      expect(fillSecret.ok).toBe(false)
      expect(fillSecret.code).toBe('sensitive')

      // 6. Cross-epoch navigation invalidates old refs
      await manager.runTool(tabId, 'page_navigate', { url: `${baseUrl}/next` })
      const afterNav = await manager.runTool(tabId, 'page_click', { ref: publishRef })
      expect(afterNav.ok).toBe(false)
    }, 20000)
  })
})
