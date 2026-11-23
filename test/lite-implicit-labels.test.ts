import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractLabelText, parseHtmlDocument } from '../src/engine/lite.js'
import { BrowserManager } from '../src/engine/manager.js'

describe('M33: Lite HTML parser implicit <label> association', () => {
  describe('extractLabelText helper', () => {
    it('extracts text before, after, and around nested <input> elements', () => {
      expect(extractLabelText('Email address <input type="email" name="email" />')).toBe('Email address')
      expect(extractLabelText('<input type="checkbox" name="tos" /> I agree to the Terms &amp; Conditions')).toBe(
        'I agree to the Terms & Conditions',
      )
      expect(extractLabelText('Amount: <input type="number" name="amt" /> USD')).toBe('Amount: USD')
    })

    it('preserves inline formatting text and decodes HTML5 entities while stripping embedded controls', () => {
      expect(
        extractLabelText(
          '<span class="req">*</span> <strong>Full Name</strong> &mdash; <input type="text" placeholder="a > b" name="full" />',
        ),
      ).toBe('* Full Name \u2014')
    })

    it('excludes <select> options, <textarea> default text, and <button> text from label text', () => {
      expect(
        extractLabelText(
          'Country <select name="country"><option value="us">United States</option><option value="uk">United Kingdom</option></select>',
        ),
      ).toBe('Country')
      expect(extractLabelText('Short Bio <textarea name="bio">Hello world</textarea>')).toBe('Short Bio')
      expect(extractLabelText('Action <button type="button">Run</button>')).toBe('Action')
    })
  })

  describe('parseHtmlDocument implicit & explicit <label> rules', () => {
    const BASE = 'https://example.test/form'

    it('associates nested <input> (text, email, password, checkbox) implicitly with enclosing <label>', () => {
      const doc = parseHtmlDocument(
        `<!doctype html><html><body>
          <form action="/register" method="POST">
            <label>Work Email <input type="email" name="email" placeholder="you@corp.com" /></label>
            <label>Passphrase <input type="password" name="pw" /></label>
            <label><input type="checkbox" name="updates" checked /> Send weekly changelog</label>
          </form>
        </body></html>`,
        BASE,
      )

      const email = doc.elements.find((e) => e.name === 'email')
      const pw = doc.elements.find((e) => e.name === 'pw')
      const updates = doc.elements.find((e) => e.name === 'updates')

      expect(email?.label).toBe('Work Email')
      expect(email?.text).toBe('Work Email')
      expect(pw?.label).toBe('Passphrase')
      expect(pw?.valueRedacted).toBe(true)
      expect(updates?.label).toBe('Send weekly changelog')
      expect(updates?.checked).toBe(true)
    })

    it('associates nested <textarea>, <select>, and <button> without polluting label with inner control text', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <form action="/profile" method="POST">
            <label>Bio <textarea name="bio">Existing bio text</textarea></label>
            <label>AWS Region
              <select name="region">
                <option value="us-east-1">US East (N. Virginia)</option>
                <option value="eu-west-1" selected>EU West (Ireland)</option>
              </select>
            </label>
            <label>Save Profile <button type="submit"></button></label>
            <label>Danger Zone <button type="button">Reset</button></label>
          </form>
        </body></html>`,
        BASE,
      )

      const bio = doc.elements.find((e) => e.tag === 'textarea')
      const region = doc.elements.find((e) => e.tag === 'select')
      const buttons = doc.elements.filter((e) => e.tag === 'button')

      expect(bio?.label).toBe('Bio')
      expect(bio?.value).toBe('Existing bio text')

      expect(region?.label).toBe('AWS Region')
      expect(region?.value).toBe('EU West (Ireland)')
      expect(region?.options).toHaveLength(2)

      expect(buttons[0]?.text).toBe('Save Profile')
      expect(buttons[0]?.label).toBe('Save Profile')
      expect(buttons[1]?.text).toBe('Reset')
      expect(buttons[1]?.label).toBe('Danger Zone')
    })

    it('skips non-labelable <input type="hidden"> so the next visible control receives the implicit label', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <label>
            <input type="hidden" name="optin" value="0" />
            <input type="checkbox" name="optin" value="1" />
            Enable notifications
          </label>
        </body></html>`,
        BASE,
      )

      expect(doc.elements).toHaveLength(1)
      expect(doc.elements[0]?.type).toBe('checkbox')
      expect(doc.elements[0]?.label).toBe('Enable notifications')
    })

    it('associates only the FIRST labelable descendant per HTML5 spec', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <label>
            Phone Number
            <input type="text" name="area" placeholder="Area" />
            <input type="text" name="local" placeholder="Local" />
          </label>
        </body></html>`,
        BASE,
      )

      const area = doc.elements.find((e) => e.name === 'area')
      const local = doc.elements.find((e) => e.name === 'local')

      expect(area?.label).toBe('Phone Number')
      expect(local?.label).toBe('Local')
    })

    it('honors explicit for="..." over implicit nesting and does not mis-label unrelated nested inputs', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <input id="target" name="target" type="text" />
          <label for="target">Explicit Target <input id="bystander" name="bystander" type="text" /></label>
          <label for="both">Same Control <input id="both" name="both" type="text" /></label>
        </body></html>`,
        BASE,
      )

      const target = doc.elements.find((e) => e.id === 'target')
      const bystander = doc.elements.find((e) => e.id === 'bystander')
      const both = doc.elements.find((e) => e.id === 'both')

      expect(target?.label).toBe('Explicit Target')
      expect(bystander?.label).toBe('bystander')
      expect(both?.label).toBe('Same Control')
    })

    it('joins multiple explicit <label for="id"> elements targeting the same control', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <label for="code">Verification</label>
          <input id="code" name="code" type="text" />
          <label for="code">(6 digits)</label>
        </body></html>`,
        BASE,
      )

      const code = doc.elements.find((e) => e.id === 'code')
      expect(code?.label).toBe('Verification (6 digits)')
    })

    it('discovers implicit <label><input .../></label> wrapped inside <p> and <li> elements', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <form action="/signup" method="POST">
            <p><label>Username <input type="text" name="user" /></label></p>
            <p>Regular paragraph with <input type="hidden" name="csrf" value="abc" /> hidden token.</p>
            <ul>
              <li><label><input type="radio" name="plan" value="starter" /> Starter ($0)</label></li>
              <li><label><input type="radio" name="plan" value="pro" checked /> Pro ($20)</label></li>
            </ul>
          </form>
        </body></html>`,
        BASE,
      )

      const user = doc.elements.find((e) => e.name === 'user')
      const radios = doc.elements.filter((e) => e.type === 'radio')
      const paragraph = doc.blocks.find((b) => b.kind === 'paragraph')

      expect(user?.label).toBe('Username')
      expect(radios).toHaveLength(2)
      expect(radios[0]?.label).toBe('Starter ($0)')
      expect(radios[1]?.label).toBe('Pro ($20)')
      expect(radios[1]?.checked).toBe(true)
      // Radio buttons with the same `name` get disambiguated selectors
      expect(radios[0]?.selector).not.toBe(radios[1]?.selector)
      // Paragraph with only a hidden input is preserved intact
      expect(paragraph?.text).toBe('Regular paragraph with hidden token.')
    })

    it('supports nested <label><input .../></label> inside iframe srcdoc documents', () => {
      const doc = parseHtmlDocument(
        `<html><body>
          <h1>Outer</h1>
          <iframe id="embed" srcdoc="<form><label>Promo Code <input type='text' name='promo' /></label></form>"></iframe>
        </body></html>`,
        BASE,
      )

      const promo = doc.elements.find((e) => e.name === 'promo')
      expect(promo).toBeDefined()
      expect(promo?.label).toBe('Promo Code')
    })
  })

  describe('end-to-end LiteBrowserEngine form interaction with implicit labels', () => {
    let server: http.Server
    let baseUrl = ''
    let manager: BrowserManager
    let tmpDir: string
    let lastSubmission = ''

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m33-test-'))
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/submit' && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => {
            body += String(chunk)
          })
          req.on('end', () => {
            lastSubmission = body
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<html><head><title>Submitted</title></head><body><h1>Done</h1><p>Payload: ${body}</p></body></html>`)
          })
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html>
        <html>
          <head><title>Implicit Labels Demo</title></head>
          <body>
            <h1>Deploy Settings</h1>
            <form aria-label="Deploy" action="/submit" method="POST">
              <p><label>Service Name <input type="text" name="service" /></label></p>
              <p><label>Instance Size
                <select name="size">
                  <option value="nano">t4g.nano</option>
                  <option value="small">t4g.small</option>
                </select>
              </label></p>
              <ul>
                <li><label><input type="radio" name="env" value="staging" /> Staging Cluster</label></li>
                <li><label><input type="radio" name="env" value="prod" /> Production Cluster</label></li>
              </ul>
              <label><input type="checkbox" name="autoscale" /> Enable Autoscaling</label>
              <button type="submit">Apply Config</button>
            </form>
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

    it('renders implicit labels in ASCII, finds refs by label text, fills/selects/clicks, and submits cleanly', async () => {
      const tab = await manager.openTab(baseUrl, { activate: true, agentOwned: true })
      const read = await manager.runTool(tab.id, 'page_read', { ascii: true, ansi: false, width: 90 })
      const ascii = String(read.ascii ?? '')

      expect(ascii).toContain('Service Name')
      expect(ascii).toContain('Instance Size')
      expect(ascii).toContain('Staging Cluster')
      expect(ascii).toContain('Production Cluster')
      expect(ascii).toContain('Enable Autoscaling')

      const findRef = async (query: string): Promise<string | undefined> => {
        const res = await manager.runTool(tab.id, 'page_find', { query })
        const matches = (res.matches as Array<{ ref?: string }> | undefined) ?? []
        return matches[0]?.ref
      }

      const serviceRef = await findRef('Service Name')
      const sizeRef = await findRef('Instance Size')
      const prodRef = await findRef('Production Cluster')
      const autoscaleRef = await findRef('Enable Autoscaling')
      const submitRef = await findRef('Apply Config')

      expect(serviceRef).toBeTruthy()
      expect(sizeRef).toBeTruthy()
      expect(prodRef).toBeTruthy()
      expect(autoscaleRef).toBeTruthy()
      expect(submitRef).toBeTruthy()

      await manager.runTool(tab.id, 'page_fill', { ref: serviceRef!, text: 'troy-api' })
      await manager.runTool(tab.id, 'page_select', { ref: sizeRef!, value: 'small' })
      await manager.runTool(tab.id, 'page_click', { ref: prodRef! })
      await manager.runTool(tab.id, 'page_click', { ref: autoscaleRef! })
      await manager.runTool(tab.id, 'page_click', { ref: submitRef!, allowSubmit: true })

      const params = new URLSearchParams(lastSubmission)
      expect(params.get('service')).toBe('troy-api')
      expect(params.get('size')).toBe('t4g.small')
      expect(params.get('env')).toBe('prod')
      expect(params.get('autoscale')).toBe('')
    })
  })
})
