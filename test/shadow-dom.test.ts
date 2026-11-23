import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isDeepSelector, splitDeepSelector } from '../src/engine/shadow-dom.js'
import { ChromiumBrowserEngine, findChromeBinary } from '../src/engine/chromium.js'
import { BrowserManager } from '../src/engine/manager.js'

const hasChrome = Boolean(findChromeBinary())

describe('Shadow DOM deep selector parser (M20)', () => {
  it('parses plain selectors and multi-level >>> chains', () => {
    expect(splitDeepSelector('#submit')).toEqual(['#submit'])
    expect(isDeepSelector('#submit')).toBe(false)

    expect(splitDeepSelector('div > span.label')).toEqual(['div > span.label'])
    expect(isDeepSelector('div > span.label')).toBe(false)

    expect(splitDeepSelector('my-app >>> button#save')).toEqual(['my-app', 'button#save'])
    expect(isDeepSelector('my-app >>> button#save')).toBe(true)

    expect(splitDeepSelector('app-shell >>> profile-editor >>> div.row > input[name="user"]')).toEqual([
      'app-shell',
      'profile-editor',
      'div.row > input[name="user"]',
    ])
  })

  it('ignores >>> inside single-quoted, double-quoted, and escaped attribute values', () => {
    expect(splitDeepSelector('button[data-arrow="a >>> b"]')).toEqual(['button[data-arrow="a >>> b"]'])
    expect(isDeepSelector('button[data-arrow="a >>> b"]')).toBe(false)

    expect(splitDeepSelector("my-app >>> input[placeholder='Type >>> here']")).toEqual([
      'my-app',
      "input[placeholder='Type >>> here']",
    ])

    expect(splitDeepSelector('my-app >>> input[title="a \\" >>> b"] >>> span')).toEqual([
      'my-app',
      'input[title="a \\" >>> b"]',
      'span',
    ])
  })

  it('throws on empty or malformed >>> selectors', () => {
    expect(() => splitDeepSelector('')).toThrow(/empty/i)
    expect(() => splitDeepSelector('   ')).toThrow(/empty/i)
    expect(() => splitDeepSelector('>>> button')).toThrow(/empty/i)
    expect(() => splitDeepSelector('my-app >>>')).toThrow(/empty/i)
    expect(() => splitDeepSelector('my-app >>> >>> button')).toThrow(/empty/i)
    expect(isDeepSelector('>>> button')).toBe(false)
  })
})

const SHADOW_TEST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Shadow DOM Deep Traversal Test</title>
  <style>
    body { font-family: sans-serif; margin: 16px; }
    app-shell { display: block; }
  </style>
</head>
<body>
  <h1>Web Components Harness</h1>
  <app-shell id="shell"></app-shell>
  <script>
    window.__events = {
      cardClicks: [],
      inputChanges: [],
      composedInputCount: 0,
      selectChanges: [],
      hoverCount: 0,
      keyEvents: [],
      applyCount: 0,
    };

    // Listen at document level for composed input/change events from Shadow DOM
    document.addEventListener('input', () => {
      window.__events.composedInputCount += 1;
    });

    class ActionCard extends HTMLElement {
      connectedCallback() {
        const cardId = this.getAttribute('data-card') || 'unknown';
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <style>
            .card { border: 1px solid #888; padding: 8px; margin: 6px 0; }
            button { padding: 6px 12px; }
          </style>
          <div class="card">
            <h3 id="card-title">Card \${cardId}</h3>
            <button id="save-btn" type="button">Save Card \${cardId}</button>
          </div>
        \`;
        root.querySelector('#save-btn').addEventListener('click', () => {
          window.__events.cardClicks.push(cardId);
        });
      }
    }
    customElements.define('action-card', ActionCard);

    class ProfileEditor extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <style>
            .editor { border: 1px solid #444; padding: 10px; margin-top: 10px; display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
            input, select, button { padding: 6px; font-size: 14px; }
          </style>
          <div class="editor">
            <h2 id="editor-heading">Profile Editor</h2>
            <label for="username">Username</label>
            <input id="username" name="username" type="text" placeholder="Enter username" />
            <label for="role-select">Role</label>
            <select id="role-select" name="role">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Administrator</option>
            </select>
            <input id="shortcut-input" name="shortcut" type="text" value="hello shadow" placeholder="Shortcut field" />
            <button id="hover-target" type="button">Hover Me</button>
            <button id="apply-btn" type="button">Apply Profile</button>
            <div id="status-slot"></div>
          </div>
        \`;

        const userInput = root.querySelector('#username');
        userInput.addEventListener('input', (e) => {
          window.__events.inputChanges.push(e.target.value);
        });

        const roleSelect = root.querySelector('#role-select');
        roleSelect.addEventListener('change', (e) => {
          window.__events.selectChanges.push(e.target.value);
        });

        const hoverBtn = root.querySelector('#hover-target');
        hoverBtn.addEventListener('mouseenter', () => {
          window.__events.hoverCount += 1;
        });

        const shortcutInput = root.querySelector('#shortcut-input');
        shortcutInput.addEventListener('keydown', (e) => {
          window.__events.keyEvents.push({
            key: e.key,
            ctrlKey: e.ctrlKey,
            targetId: e.target.id,
          });
        });

        const applyBtn = root.querySelector('#apply-btn');
        applyBtn.addEventListener('click', () => {
          window.__events.applyCount += 1;
          const slot = root.querySelector('#status-slot');
          slot.innerHTML = '<p class="saved-banner">Profile Saved #' + window.__events.applyCount + '</p>';
        });
      }
    }
    customElements.define('profile-editor', ProfileEditor);

    class AppShell extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <div class="shell">
            <action-card data-card="alpha"></action-card>
            <action-card data-card="beta"></action-card>
            <profile-editor id="editor"></profile-editor>
          </div>
        \`;
      }
    }
    customElements.define('app-shell', AppShell);
  </script>
</body>
</html>`

describe.skipIf(!hasChrome)('Headless Chromium E2E Shadow DOM deep traversal (M20)', () => {
  let server: http.Server
  let baseUrl = ''
  let manager: BrowserManager
  let tmpDir = ''

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SHADOW_TEST_HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-shadow-m20-'))
    manager = await BrowserManager.create({
      engine: 'chromium',
      profileDir: tmpDir,
    })
    manager.grantOrigin(baseUrl)
  }, 30000)

  afterAll(async () => {
    await manager?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('snapshots nested Shadow DOM elements with distinct >>> selectors and executes click, fill, select, hover, press, and waitFor', async () => {
    const opened = await manager.openTab(baseUrl, { activate: true })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    const read = (await manager.runTool(tabId, 'page_read_ascii', { width: 100 })) as {
      ok: boolean
      ascii: string
      elements: Array<{ ref: string; text: string; tag: string; id?: string }>
    }
    expect(read.ok).toBe(true)

    // Shadow DOM content should appear in ASCII layout as well as elements list
    expect(read.ascii).toContain('Profile Editor')
    expect(read.ascii).toContain('Save Card alpha')
    expect(read.ascii).toContain('Save Card beta')

    const alphaBtn = read.elements.find((e) => e.text.includes('Save Card alpha'))
    const betaBtn = read.elements.find((e) => e.text.includes('Save Card beta'))
    const usernameInput = read.elements.find((e) => e.id === 'username')
    const roleSelect = read.elements.find((e) => e.id === 'role-select')
    const shortcutInput = read.elements.find((e) => e.id === 'shortcut-input')
    const hoverBtn = read.elements.find((e) => e.id === 'hover-target')
    const applyBtn = read.elements.find((e) => e.id === 'apply-btn')

    expect(alphaBtn).toBeDefined()
    expect(betaBtn).toBeDefined()
    expect(usernameInput).toBeDefined()
    expect(roleSelect).toBeDefined()
    expect(shortcutInput).toBeDefined()
    expect(hoverBtn).toBeDefined()
    expect(applyBtn).toBeDefined()

    // 1. Click both sibling shadow cards and verify each triggers the exact right component
    const clickBeta = (await manager.runTool(tabId, 'page_click', { ref: betaBtn!.ref })) as { ok: boolean }
    const clickAlpha = (await manager.runTool(tabId, 'page_click', { ref: alphaBtn!.ref })) as { ok: boolean }
    expect(clickBeta.ok).toBe(true)
    expect(clickAlpha.ok).toBe(true)

    // 2. Fill deeply nested Shadow DOM input
    const fillRes = (await manager.runTool(tabId, 'page_fill', { ref: usernameInput!.ref, text: 'anish_shadow' })) as {
      ok: boolean
      value?: string
    }
    expect(fillRes.ok).toBe(true)
    expect(fillRes.value).toBe('anish_shadow')

    // 3. Select option inside deeply nested Shadow DOM <select>
    const selRes = (await manager.runTool(tabId, 'page_select', { ref: roleSelect!.ref, value: 'Administrator' })) as {
      ok: boolean
      value?: string
    }
    expect(selRes.ok).toBe(true)
    expect(selRes.value).toBe('Administrator')

    // 4. Hover deeply nested Shadow DOM button
    const hoverRes = (await manager.runTool(tabId, 'page_hover', { ref: hoverBtn!.ref })) as { ok: boolean }
    expect(hoverRes.ok).toBe(true)

    // 5. Press key chord targeting deeply nested Shadow DOM input
    const pressRes = (await manager.runTool(tabId, 'page_press', { ref: shortcutInput!.ref, key: 'Control+A' })) as {
      ok: boolean
      normalized?: string
    }
    expect(pressRes.ok).toBe(true)
    expect(pressRes.normalized).toBe('Control+A')

    const pressEnter = (await manager.runTool(tabId, 'page_press', { ref: shortcutInput!.ref, key: 'Enter' })) as {
      ok: boolean
    }
    expect(pressEnter.ok).toBe(true)

    // 6. Click deeply nested Apply button and wait for dynamic Shadow DOM element via >>> and plain selector
    const clickApply = (await manager.runTool(tabId, 'page_click', { ref: applyBtn!.ref })) as { ok: boolean }
    expect(clickApply.ok).toBe(true)

    const waitDeep = (await manager.runTool(tabId, 'page_wait', {
      selector: '#shell >>> #editor >>> .saved-banner',
      state: 'visible',
      timeout: 3000,
    })) as { ok: boolean }
    expect(waitDeep.ok).toBe(true)

    const waitPlain = (await manager.runTool(tabId, 'page_wait', {
      selector: '.saved-banner',
      state: 'visible',
      timeout: 3000,
    })) as { ok: boolean }
    expect(waitPlain.ok).toBe(true)

    // Verify all real DOM events fired inside Shadow DOM
    const events = (await manager.runTool(tabId, 'page_eval', { expression: 'window.__events' })) as {
      ok: boolean
      value: {
        cardClicks: string[]
        inputChanges: string[]
        composedInputCount: number
        selectChanges: string[]
        hoverCount: number
        keyEvents: Array<{ key: string; ctrlKey: boolean; targetId: string }>
        applyCount: number
      }
    }
    expect(events.ok).toBe(true)
    expect(events.value.cardClicks).toEqual(['beta', 'alpha'])
    expect(events.value.inputChanges).toContain('anish_shadow')
    expect(events.value.composedInputCount).toBeGreaterThanOrEqual(1)
    expect(events.value.selectChanges).toEqual(['admin'])
    expect(events.value.hoverCount).toBeGreaterThanOrEqual(1)
    expect(events.value.keyEvents.some((k) => k.key.toLowerCase() === 'a' && k.ctrlKey && k.targetId === 'shortcut-input')).toBe(true)
    expect(events.value.keyEvents.some((k) => k.key === 'Enter' && k.targetId === 'shortcut-input')).toBe(true)
    expect(events.value.applyCount).toBe(1)
  }, 25000)

  it('emits distinct >>> selectors in snapshot, supports plain selectors on ChromiumTabDriver, and fails cleanly on missing/invalid selectors', async () => {
    const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-shadow-driver-'))
    const engine = await ChromiumBrowserEngine.launch({ profileDir: engineDir })
    try {
      const driver = await engine.createTab(baseUrl)
      const snap = await driver.snapshot()

      const alphaBtn = snap.elements.find((e) => e.text.includes('Save Card alpha'))
      const betaBtn = snap.elements.find((e) => e.text.includes('Save Card beta'))
      const usernameInput = snap.elements.find((e) => e.id === 'username')

      expect(alphaBtn).toBeDefined()
      expect(betaBtn).toBeDefined()
      expect(usernameInput).toBeDefined()

      // Disambiguated shadow-piercing selectors for duplicate #save-btn IDs across sibling hosts
      expect(alphaBtn!.selector).toContain('>>>')
      expect(betaBtn!.selector).toContain('>>>')
      expect(alphaBtn!.selector).not.toBe(betaBtn!.selector)
      expect(usernameInput!.selector).toContain('>>>')
      expect(usernameInput!.selector.split('>>>').length).toBe(3)

      // Plain selectors without >>> should transparently pierce Shadow DOM
      const fillPlain = await driver.fill('#username', 'plain_deep_user')
      expect(fillPlain.ok).toBe(true)
      expect(fillPlain.value).toBe('plain_deep_user')

      const selectPlain = await driver.select('#role-select', 'editor')
      expect(selectPlain.ok).toBe(true)
      expect(selectPlain.value).toBe('Editor')

      const hoverPlain = await driver.hover('#hover-target')
      expect(hoverPlain.ok).toBe(true)

      const pressPlain = await driver.press('Escape', '#shortcut-input')
      expect(pressPlain.ok).toBe(true)

      const clickPlain = await driver.click('#apply-btn')
      expect(clickPlain.ok).toBe(true)

      // Missing and invalid selectors should fail cleanly without throwing
      const missingClick = await driver.click('#shell >>> #does-not-exist')
      expect(missingClick.ok).toBe(false)

      const invalidClick = await driver.click('#shell >>> >>> button')
      expect(invalidClick.ok).toBe(false)

      const missingPress = await driver.press('Enter', '#shell >>> #nope')
      expect(missingPress.ok).toBe(false)

      const invalidWait = await driver.waitFor({ selector: '#shell >>> :not(', timeout: 500 })
      expect(invalidWait.ok).toBe(false)
      expect(invalidWait.error).toMatch(/invalid selector/i)

      const malformedDeepWait = await driver.waitFor({ selector: '#shell >>> >>> button', timeout: 500 })
      expect(malformedDeepWait.ok).toBe(false)
      expect(malformedDeepWait.error).toMatch(/invalid selector/i)
    } finally {
      await engine.close()
      fs.rmSync(engineDir, { recursive: true, force: true })
    }
  }, 25000)
})
