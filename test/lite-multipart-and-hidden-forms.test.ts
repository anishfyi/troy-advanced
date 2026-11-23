import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  encodeMultipartFormData,
  encodeTextPlainFormData,
  encodeUrlEncodedFormData,
  escapeMultipartParam,
  generateMultipartBoundary,
  guessMimeTypeFromFilename,
  normalizeFormEnctype,
} from '../src/engine/form-encoding.js'
import { LiteBrowserEngine, parseHtmlDocument } from '../src/engine/lite.js'
import { BrowserManager } from '../src/engine/manager.js'
import { isTextMimeType } from '../src/engine/network.js'

interface ParsedMultipartPart {
  name: string
  filename?: string
  contentType?: string
  body: Buffer
}

/** Minimal RFC 7578 multipart parser for test assertions. */
function parseMultipartBody(raw: Buffer, contentTypeHeader: string): ParsedMultipartPart[] {
  const match = /boundary=([^\s;]+)/i.exec(contentTypeHeader)
  if (!match) throw new Error(`Missing boundary in content-type: ${contentTypeHeader}`)
  const boundary = match[1]!.replace(/^"|"$/g, '')
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: ParsedMultipartPart[] = []

  let pos = raw.indexOf(delimiter)
  while (pos >= 0) {
    pos += delimiter.length
    // Check for closing `--`
    if (raw.subarray(pos, pos + 2).toString('utf8') === '--') break
    // Skip CRLF after boundary
    if (raw.subarray(pos, pos + 2).toString('utf8') === '\r\n') pos += 2

    const nextIdx = raw.indexOf(delimiter, pos)
    if (nextIdx < 0) break

    // Part ends with `\r\n` right before the next boundary
    let partEnd = nextIdx
    if (partEnd >= 2 && raw[partEnd - 2] === 0x0d && raw[partEnd - 1] === 0x0a) {
      partEnd -= 2
    }

    const partBuf = raw.subarray(pos, partEnd)
    const headerSep = partBuf.indexOf(Buffer.from('\r\n\r\n'))
    if (headerSep < 0) {
      pos = nextIdx
      continue
    }

    const headerStr = partBuf.subarray(0, headerSep).toString('utf8')
    const body = Buffer.from(partBuf.subarray(headerSep + 4))
    const headers: Record<string, string> = {}
    for (const line of headerStr.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
    }

    const disp = headers['content-disposition'] ?? ''
    const nameMatch = /\bname="([^"]*)"/i.exec(disp)
    const fileMatch = /\bfilename="([^"]*)"/i.exec(disp)
    parts.push({
      name: nameMatch?.[1] ?? '',
      ...(fileMatch ? { filename: fileMatch[1] } : {}),
      ...(headers['content-type'] ? { contentType: headers['content-type'] } : {}),
      body,
    })

    pos = nextIdx
  }

  return parts
}

describe('M35: multipart/form-data & hidden form fields (CSRF tokens) in Lite engine', () => {
  describe('form-encoding utilities', () => {
    it('normalizes form enctype values per HTML5 §4.10.18.6', () => {
      expect(normalizeFormEnctype(undefined)).toBe('application/x-www-form-urlencoded')
      expect(normalizeFormEnctype('')).toBe('application/x-www-form-urlencoded')
      expect(normalizeFormEnctype('  MULTIPART/FORM-DATA  ')).toBe('multipart/form-data')
      expect(normalizeFormEnctype('Text/Plain')).toBe('text/plain')
      expect(normalizeFormEnctype('application/json')).toBe('application/x-www-form-urlencoded')
    })

    it('escapes quotes, CR, and LF in multipart Content-Disposition parameters', () => {
      expect(escapeMultipartParam('a"b\rc\nd')).toBe('a%22b%0Dc%0Ad')
      expect(escapeMultipartParam('normal_field')).toBe('normal_field')
    })

    it('generates RFC 2046 compliant unique ASCII boundaries', () => {
      const b1 = generateMultipartBoundary()
      const b2 = generateMultipartBoundary()
      expect(b1.length).toBeLessThanOrEqual(70)
      expect(b1).toMatch(/^[\x21-\x7e]+$/)
      expect(b1).not.toBe(b2)
    })

    it('guesses MIME types from filename extensions', () => {
      expect(guessMimeTypeFromFilename('notes.txt')).toBe('text/plain')
      expect(guessMimeTypeFromFilename('payload.JSON')).toBe('application/json')
      expect(guessMimeTypeFromFilename('avatar.png')).toBe('image/png')
      expect(guessMimeTypeFromFilename('archive.bin')).toBe('application/octet-stream')
    })

    it('encodes multipart/form-data with text fields, duplicate names, and binary file payloads', () => {
      const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
      const encoded = encodeMultipartFormData(
        [
          { name: '_csrf', value: 'tok_123&456' },
          { name: 'tag', value: 'alpha' },
          { name: 'tag', value: 'beta' },
          { name: 'avatar', value: binBytes, filename: 'pic"1.png', contentType: 'image/png' },
          { name: 'empty_file', value: Buffer.alloc(0), filename: '' },
        ],
        'TestBoundary123',
      )

      expect(encoded.boundary).toBe('TestBoundary123')
      expect(encoded.contentType).toBe('multipart/form-data; boundary=TestBoundary123')

      const parts = parseMultipartBody(encoded.body, encoded.contentType)
      expect(parts).toHaveLength(5)
      expect(parts[0]).toEqual({ name: '_csrf', body: Buffer.from('tok_123&456', 'utf8') })
      expect(parts[1]).toEqual({ name: 'tag', body: Buffer.from('alpha', 'utf8') })
      expect(parts[2]).toEqual({ name: 'tag', body: Buffer.from('beta', 'utf8') })
      expect(parts[3]).toEqual({
        name: 'avatar',
        filename: 'pic%221.png',
        contentType: 'image/png',
        body: binBytes,
      })
      expect(parts[4]).toEqual({
        name: 'empty_file',
        filename: '',
        contentType: 'application/octet-stream',
        body: Buffer.alloc(0),
      })
    })

    it('encodes urlencoded and text/plain form payloads preserving duplicates', () => {
      const entries = [
        { name: '_csrf', value: 'abc 123' },
        { name: 'item', value: 'one' },
        { name: 'item', value: 'two' },
      ]
      expect(encodeUrlEncodedFormData(entries)).toBe('_csrf=abc+123&item=one&item=two')
      expect(encodeTextPlainFormData(entries)).toBe('_csrf=abc 123\r\nitem=one\r\nitem=two\r\n')
      expect(isTextMimeType('multipart/form-data')).toBe(true)
    })
  })

  describe('parseHtmlDocument hidden fields & form metadata', () => {
    const BASE = 'https://app.example.test/settings'

    it('extracts hidden inputs (including CSRF tokens) without polluting visible elements or blocks', () => {
      const html = `
        <form id="profile-form" action="/save" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="_csrf" value="tok&amp;123&quot;x" />
          <input type="hidden" name="ignored_disabled" value="nope" disabled />
          <p><input type="hidden" name="in_p" value="p_val" />Update your display name</p>
          <ul><li><input type="hidden" name="in_li" value="li_val" />Notice</li></ul>
          <table><tr><td><input type="hidden" name="in_tr" value="tr_val" />Row</td></tr></table>
          <label>Name <input type="text" name="display_name" value="Anish" /></label>
          <button type="submit" name="intent" value="save_profile">Save</button>
        </form>
        <input type="hidden" form="profile-form" name="external_csrf" value="ext_999" />
      `
      const doc = parseHtmlDocument(html, BASE)

      // Hidden inputs must NEVER appear in visible elements or rendered blocks
      expect(doc.elements.some((e) => e.type === 'hidden')).toBe(false)
      expect(doc.blocks.some((b) => b.text.includes('tok&123'))).toBe(false)

      const form = doc.forms.get('form-1')
      expect(form).toBeDefined()
      expect(form?.method).toBe('POST')
      expect(form?.enctype).toBe('multipart/form-data')
      expect(form?.action).toBe('https://app.example.test/save')

      expect(form?.hiddenFields).toEqual([
        { name: '_csrf', value: 'tok&123"x' },
        { name: 'ignored_disabled', value: 'nope', disabled: true },
        { name: 'in_p', value: 'p_val' },
        { name: 'in_li', value: 'li_val' },
        { name: 'in_tr', value: 'tr_val' },
        { name: 'external_csrf', value: 'ext_999' },
      ])

      const submitBtn = doc.elements.find((e) => e.tag === 'button')
      expect(submitBtn?.name).toBe('intent')
      expect(submitBtn?.value).toBe('save_profile')
    })

    it('parses formaction, formmethod, and formenctype overrides on submit buttons', () => {
      const html = `
        <form action="/default" method="POST">
          <input type="hidden" name="_csrf" value="secret" />
          <input type="text" name="title" value="Draft" />
          <button type="submit" name="op" value="publish">Publish</button>
          <button type="submit" name="op" value="upload" formaction="/upload" formmethod="POST" formenctype="multipart/form-data">Upload</button>
          <button type="button" name="cancel" value="1">Cancel</button>
        </form>
      `
      const doc = parseHtmlDocument(html, BASE)
      const uploadBtn = doc.elements.find((e) => e.text === 'Upload')
      const cancelBtn = doc.elements.find((e) => e.text === 'Cancel')
      expect(uploadBtn?.formAction).toBe('https://app.example.test/upload')
      expect(uploadBtn?.formMethod).toBe('POST')
      expect(uploadBtn?.formEnctype).toBe('multipart/form-data')
      expect(uploadBtn?.defaultSubmit).toBe(true)
      expect(cancelBtn?.defaultSubmit).toBe(false)
    })

    it('preserves hidden fields and enctype when flattening srcdoc iframe forms', () => {
      const html = `
        <iframe id="csrf-frame" srcdoc='<form action="/iframe-post" method="POST" enctype="multipart/form-data"><input type="hidden" name="frame_csrf" value="f_tok" /><input type="text" name="note" value="hi" /><button type="submit">Send</button></form>'></iframe>
      `
      const doc = parseHtmlDocument(html, BASE)
      const iframeForm = doc.forms.get('f1-form-1')
      expect(iframeForm).toBeDefined()
      expect(iframeForm?.enctype).toBe('multipart/form-data')
      expect(iframeForm?.hiddenFields).toEqual([{ name: 'frame_csrf', value: 'f_tok' }])
    })
  })

  describe('end-to-end LiteBrowserEngine & BrowserManager form submissions', () => {
    let server: http.Server
    let baseUrl: string
    let tmpDir: string
    let lastRequest: {
      method: string
      url: string
      contentType: string
      cookie: string
      rawBody: Buffer
    } | null = null

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m35-test-'))
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks)
          const contentType = String(req.headers['content-type'] ?? '')
          const cookie = String(req.headers.cookie ?? '')

          if (url.pathname === '/echo' || url.pathname === '/upload' || url.pathname === '/search') {
            lastRequest = {
              method: req.method ?? 'GET',
              url: req.url ?? '/',
              contentType,
              cookie,
              rawBody,
            }
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<html><head><title>Submitted ${url.pathname}</title></head><body><h1>OK</h1></body></html>`)
            return
          }

          if (url.pathname === '/csrf-urlencoded') {
            res.writeHead(200, {
              'content-type': 'text/html',
              'set-cookie': 'sid=sess_42; Path=/; HttpOnly',
            })
            res.end(`<!doctype html><html><head><title>CSRF Form</title></head><body>
              <form action="/echo" method="POST">
                <input type="hidden" name="authenticity_token" value="csrf_token_abc123" />
                <input type="hidden" name="disabled_hidden" value="should_not_send" disabled />
                <label>Username <input type="text" name="username" /></label>
                <input type="text" name="disabled_text" value="nope" disabled />
                <button type="submit" name="action" value="save">Save</button>
                <button type="submit" name="action" value="delete">Delete</button>
                <button type="button" name="noop" value="1">Cancel</button>
              </form>
            </body></html>`)
            return
          }

          if (url.pathname === '/multipart-form') {
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<!doctype html><html><head><title>Multipart Form</title></head><body>
              <form action="/upload" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="_csrf" value="mp_csrf_987" />
                <input type="hidden" name="subscribe" value="0" />
                <label><input type="checkbox" name="subscribe" value="1" /> Subscribe</label>
                <label>Title <input type="text" name="title" /></label>
                <label>Attachment <input type="file" name="attachment" /></label>
                <label><input type="radio" name="tier" value="free" checked /> Free</label>
                <label><input type="radio" name="tier" value="pro" /> Pro</label>
                <button type="submit" name="submit_btn" value="go">Upload Now</button>
              </form>
            </body></html>`)
            return
          }

          if (url.pathname === '/overrides-form') {
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<!doctype html><html><head><title>Overrides</title></head><body>
              <form action="/echo" method="GET">
                <input type="hidden" name="_csrf" value="ov_tok" />
                <input type="hidden" name="tag" value="a" />
                <input type="hidden" name="tag" value="b" />
                <label>Query <input type="text" name="q" value="hello" /></label>
                <button type="submit" id="get-btn">Search GET</button>
                <button type="submit" id="mp-btn" formaction="/upload" formmethod="POST" formenctype="multipart/form-data" name="mode" value="mp">Post Multipart</button>
                <button type="submit" id="txt-btn" formaction="/echo" formmethod="POST" formenctype="text/plain" name="mode" value="txt">Post Plain</button>
              </form>
            </body></html>`)
            return
          }

          if (url.pathname === '/implicit-enter-form') {
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<!doctype html><html><head><title>Enter Submit</title></head><body>
              <form action="/echo" method="POST">
                <input type="hidden" name="_csrf" value="enter_tok" />
                <input type="text" id="q-input" name="q" value="typed" />
              </form>
            </body></html>`)
            return
          }

          res.writeHead(404)
          res.end('Not Found')
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('submits hidden CSRF token, excludes disabled fields & non-clicked buttons, and ignores type="button"', async () => {
      const manager = await BrowserManager.create({ engine: 'lite', profileDir: path.join(tmpDir, 'p1') })
      try {
        lastRequest = null
        const tab = await manager.openTab(`${baseUrl}/csrf-urlencoded`, { activate: true, agentOwned: true })
        const read = await manager.runTool(tab.id, 'page_read', { ascii: true, ansi: false })
        // Hidden CSRF token must not leak into ASCII view
        expect(String(read.ascii)).not.toContain('csrf_token_abc123')

        const findRef = async (q: string) => {
          const r = await manager.runTool(tab.id, 'page_find', { query: q })
          return ((r.matches as Array<{ ref?: string }>) ?? [])[0]?.ref
        }

        const userRef = await findRef('Username')
        const cancelRef = await findRef('Cancel')
        const saveRef = await findRef('Save')
        expect(userRef).toBeTruthy()
        expect(cancelRef).toBeTruthy()
        expect(saveRef).toBeTruthy()

        await manager.runTool(tab.id, 'page_fill', { ref: userRef!, text: 'anish' })

        // Clicking <button type="button">Cancel</button> must NOT submit the form
        await manager.runTool(tab.id, 'page_click', { ref: cancelRef! })
        expect(lastRequest).toBeNull()

        // Clicking Save submits with hidden CSRF token, cookie, and only action=save
        await manager.runTool(tab.id, 'page_click', { ref: saveRef!, allowSubmit: true })
        expect(lastRequest).not.toBeNull()
        expect(lastRequest!.method).toBe('POST')
        expect(lastRequest!.contentType).toContain('application/x-www-form-urlencoded')
        expect(lastRequest!.cookie).toContain('sid=sess_42')

        const params = new URLSearchParams(lastRequest!.rawBody.toString('utf8'))
        expect(params.get('authenticity_token')).toBe('csrf_token_abc123')
        expect(params.get('username')).toBe('anish')
        expect(params.get('action')).toBe('save')
        expect(params.getAll('action')).toEqual(['save'])
        expect(params.has('disabled_hidden')).toBe(false)
        expect(params.has('disabled_text')).toBe(false)
        expect(params.has('noop')).toBe(false)
      } finally {
        await manager.close()
      }
    })

    it('submits multipart/form-data with hidden CSRF token, tree-ordered fields, radio group exclusivity, and file upload', async () => {
      const sampleFile = path.join(tmpDir, 'report.json')
      const sampleContent = JSON.stringify({ ok: true, iter: 40 })
      fs.writeFileSync(sampleFile, sampleContent, 'utf8')

      const engine = new LiteBrowserEngine({ profileDir: path.join(tmpDir, 'p2') })
      try {
        lastRequest = null
        const tab = await engine.createTab(`${baseUrl}/multipart-form`)
        const snap = await tab.snapshot()

        const titleEl = snap.elements.find((e) => e.name === 'title')!
        const fileEl = snap.elements.find((e) => e.type === 'file')!
        const subEl = snap.elements.find((e) => e.name === 'subscribe')!
        const proRadio = snap.elements.find((e) => e.type === 'radio' && e.value === 'pro')!
        const submitBtn = snap.elements.find((e) => e.tag === 'button')!

        await tab.fill(titleEl.selector, 'Quarterly Report')
        await tab.fill(fileEl.selector, sampleFile)
        await tab.click(subEl.selector) // check subscribe=1
        await tab.click(proRadio.selector) // switch radio from free -> pro
        await tab.click(submitBtn.selector)

        expect(lastRequest).not.toBeNull()
        expect(lastRequest!.method).toBe('POST')
        expect(lastRequest!.contentType).toMatch(/^multipart\/form-data; boundary=----TroyFormBoundary[0-9a-f]+$/)

        const parts = parseMultipartBody(lastRequest!.rawBody, lastRequest!.contentType)
        expect(parts.map((p) => p.name)).toEqual([
          '_csrf',
          'subscribe',
          'subscribe',
          'title',
          'attachment',
          'tier',
          'submit_btn',
        ])
        expect(parts[0]!.body.toString('utf8')).toBe('mp_csrf_987')
        // Hidden fallback 0 comes before checked checkbox 1 in exact DOM tree order
        expect(parts[1]!.body.toString('utf8')).toBe('0')
        expect(parts[2]!.body.toString('utf8')).toBe('1')
        expect(parts[3]!.body.toString('utf8')).toBe('Quarterly Report')
        expect(parts[4]!.filename).toBe('report.json')
        expect(parts[4]!.contentType).toBe('application/json')
        expect(parts[4]!.body.toString('utf8')).toBe(sampleContent)
        // Radio exclusivity: only 'pro' submitted, not 'free'
        expect(parts[5]!.body.toString('utf8')).toBe('pro')
        expect(parts[6]!.body.toString('utf8')).toBe('go')

        // Verify network body inspection exposes the multipart POST request body cleanly
        const netList = tab.getNetwork({ method: 'POST' })
        expect(netList.length).toBeGreaterThanOrEqual(1)
        const netBody = await tab.getNetworkBody(netList[netList.length - 1]!.requestId!)
        expect(netBody.ok).toBe(true)
        expect(netBody.requestBody?.body).toContain('mp_csrf_987')
        expect(netBody.requestBody?.body).toContain('filename="report.json"')
      } finally {
        await engine.close()
      }
    })

    it('submits empty <input type="file"> as an empty filename="" multipart part per HTML5', async () => {
      const engine = new LiteBrowserEngine({ profileDir: path.join(tmpDir, 'p3') })
      try {
        lastRequest = null
        const tab = await engine.createTab(`${baseUrl}/multipart-form`)
        const snap = await tab.snapshot()
        const submitBtn = snap.elements.find((e) => e.tag === 'button')!
        await tab.click(submitBtn.selector)

        const parts = parseMultipartBody(lastRequest!.rawBody, lastRequest!.contentType)
        const filePart = parts.find((p) => p.name === 'attachment')
        expect(filePart).toBeDefined()
        expect(filePart?.filename).toBe('')
        expect(filePart?.contentType).toBe('application/octet-stream')
        expect(filePart?.body.byteLength).toBe(0)
      } finally {
        await engine.close()
      }
    })

    it('supports GET hidden fields with duplicates and submitter formaction/formmethod/formenctype overrides', async () => {
      const engine = new LiteBrowserEngine({ profileDir: path.join(tmpDir, 'p4') })
      try {
        // 1. Default GET with duplicate hidden fields
        lastRequest = null
        const tab = await engine.createTab(`${baseUrl}/overrides-form`)
        await tab.click('#get-btn')
        expect(lastRequest?.method).toBe('GET')
        const parsedGet = new URL(lastRequest!.url, 'http://127.0.0.1')
        expect(parsedGet.pathname).toBe('/echo')
        expect(parsedGet.searchParams.get('_csrf')).toBe('ov_tok')
        expect(parsedGet.searchParams.getAll('tag')).toEqual(['a', 'b'])
        expect(parsedGet.searchParams.get('q')).toBe('hello')

        // 2. Submitter override to POST multipart/form-data at /upload
        await tab.navigate(`${baseUrl}/overrides-form`)
        lastRequest = null
        await tab.click('#mp-btn')
        expect(lastRequest?.method).toBe('POST')
        expect(lastRequest?.url).toBe('/upload')
        expect(lastRequest?.contentType).toMatch(/^multipart\/form-data; boundary=/)
        const mpParts = parseMultipartBody(lastRequest!.rawBody, lastRequest!.contentType)
        expect(mpParts.find((p) => p.name === '_csrf')?.body.toString('utf8')).toBe('ov_tok')
        expect(mpParts.find((p) => p.name === 'mode')?.body.toString('utf8')).toBe('mp')

        // 3. Submitter override to POST text/plain
        await tab.navigate(`${baseUrl}/overrides-form`)
        lastRequest = null
        await tab.click('#txt-btn')
        expect(lastRequest?.method).toBe('POST')
        expect(lastRequest?.contentType).toBe('text/plain')
        expect(lastRequest?.rawBody.toString('utf8')).toBe('_csrf=ov_tok\r\ntag=a\r\ntag=b\r\nq=hello\r\nmode=txt\r\n')
      } finally {
        await engine.close()
      }
    })

    it('submits hidden CSRF tokens on Enter keypress even when form has no submit button', async () => {
      const engine = new LiteBrowserEngine({ profileDir: path.join(tmpDir, 'p5') })
      try {
        lastRequest = null
        const tab = await engine.createTab(`${baseUrl}/implicit-enter-form`)
        await tab.press('Enter', '#q-input')
        expect(lastRequest).not.toBeNull()
        expect(lastRequest!.method).toBe('POST')
        const params = new URLSearchParams(lastRequest!.rawBody.toString('utf8'))
        expect(params.get('_csrf')).toBe('enter_tok')
        expect(params.get('q')).toBe('typed')
      } finally {
        await engine.close()
      }
    })
  })
})
