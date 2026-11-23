import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LiteBrowserEngine,
  extractBaseHref,
  extractMetaRefresh,
  parseHtmlDocument,
  parseMetaRefreshContent,
} from '../src/engine/lite.js'

describe('M34: Lite engine <base href> and <meta http-equiv="refresh">', () => {
  describe('extractBaseHref helper', () => {
    const DOC_URL = 'https://example.test/docs/v1/intro.html'

    it('resolves absolute, root-relative, path-relative, and protocol-relative <base href>', () => {
      expect(extractBaseHref('<head><base href="https://cdn.example.test/assets/"></head>', DOC_URL)).toBe(
        'https://cdn.example.test/assets/',
      )
      expect(extractBaseHref('<head><base href="/docs/v2/"></head>', DOC_URL)).toBe('https://example.test/docs/v2/')
      expect(extractBaseHref('<head><base href="../v3/"></head>', DOC_URL)).toBe('https://example.test/docs/v3/')
      expect(extractBaseHref('<head><base href="//static.example.test/app/"></head>', DOC_URL)).toBe(
        'https://static.example.test/app/',
      )
    })

    it('skips <base target> without href and uses the first <base> with href (HTML5 §4.2.3)', () => {
      const html = `
        <head>
          <base target="_blank">
          <base href="/first/">
          <base href="/second/">
        </head>
      `
      expect(extractBaseHref(html, DOC_URL)).toBe('https://example.test/first/')
    })

    it('ignores <base> in comments, <script>, and <style>, and handles entities and quoted >', () => {
      const html = `
        <!-- <base href="https://ignored.test/comment/"> -->
        <script>const s = '<base href="https://ignored.test/script/">';</script>
        <style>/* <base href="https://ignored.test/style/"> */</style>
        <base title="a > b" href="/search/?a=1&amp;b=2">
      `
      expect(extractBaseHref(html, DOC_URL)).toBe('https://example.test/search/?a=1&b=2')
    })

    it('rejects unsafe schemes in <base href> (javascript:, data:, vbscript:)', () => {
      expect(extractBaseHref('<base href="javascript:alert(1)">', DOC_URL)).toBeUndefined()
      expect(extractBaseHref('<base href="data:text/html,hi">', DOC_URL)).toBeUndefined()
      expect(extractBaseHref('<base href="vbscript:msgbox(1)">', DOC_URL)).toBeUndefined()
    })
  })

  describe('parseMetaRefreshContent & extractMetaRefresh helpers', () => {
    const BASE = 'https://example.test/app/login'

    it('parses standard, quoted, comma-separated, fractional, and keyword-less refresh directives', () => {
      expect(parseMetaRefreshContent('0; url=/dashboard', BASE)).toEqual({
        delaySeconds: 0,
        url: 'https://example.test/dashboard',
        rawContent: '0; url=/dashboard',
      })
      expect(parseMetaRefreshContent("2; URL='next/step'", BASE)).toEqual({
        delaySeconds: 2,
        url: 'https://example.test/app/next/step',
        rawContent: "2; URL='next/step'",
      })
      expect(parseMetaRefreshContent('0.5; url="https://other.test/a?x=1&y=2"', BASE)).toEqual({
        delaySeconds: 0.5,
        url: 'https://other.test/a?x=1&y=2',
        rawContent: '0.5; url="https://other.test/a?x=1&y=2"',
      })
      expect(parseMetaRefreshContent('1, url=/comma', BASE)).toEqual({
        delaySeconds: 1,
        url: 'https://example.test/comma',
        rawContent: '1, url=/comma',
      })
      expect(parseMetaRefreshContent('0; /no-keyword', BASE)).toEqual({
        delaySeconds: 0,
        url: 'https://example.test/no-keyword',
        rawContent: '0; /no-keyword',
      })
      expect(parseMetaRefreshContent('0 url=/space-delim', BASE)).toEqual({
        delaySeconds: 0,
        url: 'https://example.test/space-delim',
        rawContent: '0 url=/space-delim',
      })
    })

    it('parses self-refresh without URL and rejects invalid syntax or unsafe protocols', () => {
      expect(parseMetaRefreshContent('30', BASE)).toEqual({ delaySeconds: 30, rawContent: '30' })
      expect(parseMetaRefreshContent('5;', BASE)).toEqual({ delaySeconds: 5, rawContent: '5;' })
      expect(parseMetaRefreshContent('5; url=', BASE)).toEqual({ delaySeconds: 5, rawContent: '5; url=' })

      expect(parseMetaRefreshContent('', BASE)).toBeUndefined()
      expect(parseMetaRefreshContent('abc', BASE)).toBeUndefined()
      expect(parseMetaRefreshContent('; url=/no-delay', BASE)).toBeUndefined()
      expect(parseMetaRefreshContent('5 seconds', BASE)).toBeUndefined()
      expect(parseMetaRefreshContent('0; url=javascript:alert(1)', BASE)).toBeUndefined()
      expect(parseMetaRefreshContent('0; url=data:text/html,x', BASE)).toBeUndefined()
      expect(parseMetaRefreshContent('0; url=file:///etc/passwd', BASE)).toBeUndefined()
    })

    it('extracts <meta http-equiv="refresh"> including inside <noscript> and decodes HTML entities', () => {
      const html = `
        <html><head>
          <!-- <meta http-equiv="refresh" content="0; url=/commented"> -->
          <noscript>
            <meta content="0; url=/nojs?a=1&amp;b=2" HTTP-EQUIV="Refresh" />
          </noscript>
          <meta http-equiv="refresh" content="0; url=/second">
        </head><body></body></html>
      `
      expect(extractMetaRefresh(html, BASE)).toEqual({
        delaySeconds: 0,
        url: 'https://example.test/nojs?a=1&b=2',
        rawContent: '0; url=/nojs?a=1&b=2',
      })
    })
  })

  describe('parseHtmlDocument <base href> & <meta refresh> integration', () => {
    it('resolves links, inline links, images, forms, and meta refresh against <base href>', () => {
      const html = `
        <!doctype html>
        <html>
          <head>
            <title>Base Test</title>
            <base href="https://cdn.example.test/v2/">
            <meta http-equiv="refresh" content="10; url=next.html">
          </head>
          <body>
            <a href="guide.html">Guide</a>
            <p>Read the <a href="api/ref.html">API reference</a> now.</p>
            <img src="img/logo.png" alt="Logo" width="120" height="40" />
            <form action="submit" method="POST">
              <input type="text" name="q" />
              <button type="submit">Go</button>
            </form>
            <form method="GET">
              <input type="text" name="self" />
              <button type="submit">Self</button>
            </form>
          </body>
        </html>
      `
      const doc = parseHtmlDocument(html, 'https://example.test/old/page.html')
      expect(doc.baseUrl).toBe('https://cdn.example.test/v2/')
      expect(doc.metaRefresh?.url).toBe('https://cdn.example.test/v2/next.html')
      expect(doc.metaRefresh?.delaySeconds).toBe(10)

      const guide = doc.elements.find((e) => e.text === 'Guide')
      const apiRef = doc.elements.find((e) => e.text === 'API reference')
      expect(guide?.href).toBe('https://cdn.example.test/v2/guide.html')
      expect(apiRef?.href).toBe('https://cdn.example.test/v2/api/ref.html')

      const imgBlock = doc.blocks.find((b) => b.kind === 'image')
      expect(imgBlock?.src).toBe('https://cdn.example.test/v2/img/logo.png')

      const form1 = doc.forms.get('form-1')
      const form2 = doc.forms.get('form-2')
      expect(form1?.action).toBe('https://cdn.example.test/v2/submit')
      // Missing/empty form action resolves to the document URL per HTML5 §4.10.21.3
      expect(form2?.action).toBe('https://example.test/old/page.html')
    })

    it('propagates parent <base href> into <iframe srcdoc> unless child defines its own <base href>', () => {
      const html = `
        <html>
          <head><base href="https://example.test/nested/dir/"></head>
          <body>
            <iframe id="inherit" srcdoc="<a href='child.html'>Child Link</a>"></iframe>
            <iframe id="override" srcdoc="<base href='https://other.test/x/'><a href='own.html'>Own Link</a>"></iframe>
          </body>
        </html>
      `
      const doc = parseHtmlDocument(html, 'https://example.test/root.html')
      const childLink = doc.elements.find((e) => e.text === 'Child Link')
      const ownLink = doc.elements.find((e) => e.text === 'Own Link')
      expect(childLink?.href).toBe('https://example.test/nested/dir/child.html')
      expect(ownLink?.href).toBe('https://other.test/x/own.html')
    })
  })

  describe('End-to-end Lite HTTP navigation & redirects', () => {
    let server: http.Server
    let baseUrl = ''
    let tmpDir = ''
    let engine: LiteBrowserEngine

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m34-'))
      server = http.createServer((req, res) => {
        const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1')
        const pathname = urlObj.pathname

        if (pathname === '/meta-start') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!doctype html><html><head>
            <title>Redirecting</title>
            <meta http-equiv="refresh" content="0; url=/meta-dest">
          </head><body><p>Redirecting...</p></body></html>`)
          return
        }

        if (pathname === '/meta-dest') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>Final Destination</title></head><body><h1>Arrived!</h1></body></html>')
          return
        }

        if (pathname === '/chain-302') {
          res.writeHead(302, { location: '/chain-meta' })
          res.end()
          return
        }

        if (pathname === '/chain-meta') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head>
            <base href="/v2/sub/">
            <meta http-equiv="refresh" content="1; url=target">
          </head><body><p>Hop 2</p></body></html>`)
          return
        }

        if (pathname === '/v2/sub/target') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>V2 Sub Target</title></head><body><h1>Base + Meta Worked</h1></body></html>')
          return
        }

        if (pathname === '/noscript-redirect') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head>
            <noscript><meta http-equiv="refresh" content="0; url=/meta-dest"></noscript>
          </head><body><p>Enable JS</p></body></html>`)
          return
        }

        if (pathname === '/header-refresh') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            refresh: '0; url=/meta-dest',
          })
          res.end('<html><body><p>Header refresh</p></body></html>')
          return
        }

        if (pathname === '/long-delay') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head>
            <title>Dashboard</title>
            <meta http-equiv="refresh" content="60; url=/meta-dest">
          </head><body><h1>Live Dashboard</h1></body></html>`)
          return
        }

        if (pathname === '/self-refresh') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head>
            <title>Self Refresh</title>
            <meta http-equiv="refresh" content="0; url=/self-refresh">
          </head><body><h1>No Infinite Loop</h1></body></html>`)
          return
        }

        if (pathname === '/loop-a') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><meta http-equiv="refresh" content="0; url=/loop-b"></head><body>A</body></html>')
          return
        }

        if (pathname === '/loop-b') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><meta http-equiv="refresh" content="0; url=/loop-a"></head><body>B</body></html>')
          return
        }

        if (pathname === '/login-form') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head><base href="/auth/"></head><body>
            <form action="signin" method="POST">
              <label>User <input type="text" name="user" /></label>
              <button type="submit">Sign In</button>
            </form>
          </body></html>`)
          return
        }

        if (pathname === '/auth/signin' && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => {
            body += String(chunk)
          })
          req.on('end', () => {
            const params = new URLSearchParams(body)
            const user = params.get('user') ?? 'anon'
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': `session_user=${encodeURIComponent(user)}; Path=/`,
            })
            res.end(`<html><head>
              <meta http-equiv="refresh" content="0; url=/whoami">
            </head><body>Signing in...</body></html>`)
          })
          return
        }

        if (pathname === '/whoami') {
          const cookie = req.headers.cookie ?? ''
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head><title>WhoAmI</title></head><body><p>Method:${req.method} Cookie:${cookie}</p></body></html>`)
          return
        }

        if (pathname === '/base-nav') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<html><head><base href="/v2/sub/"></head><body>
            <a href="target">Open Target</a>
          </body></html>`)
          return
        }

        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('Failed to bind test server')
      baseUrl = `http://127.0.0.1:${addr.port}`

      engine = new LiteBrowserEngine({
        profileDir: tmpDir,
      })
    })

    afterAll(async () => {
      await engine.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('follows <meta http-equiv="refresh"> automatically on navigate', async () => {
      const tab = await engine.createTab(`${baseUrl}/meta-start`)
      expect(tab.getUrl()).toBe(`${baseUrl}/meta-dest`)
      expect(tab.getTitle()).toBe('Final Destination')
      const snap = await tab.snapshot()
      expect(snap.text).toContain('Arrived!')
    })

    it('follows chained HTTP 302 -> <base href> + <meta http-equiv="refresh">', async () => {
      const tab = await engine.createTab(`${baseUrl}/chain-302`)
      expect(tab.getUrl()).toBe(`${baseUrl}/v2/sub/target`)
      expect(tab.getTitle()).toBe('V2 Sub Target')
    })

    it('follows <noscript><meta http-equiv="refresh"> and HTTP Refresh header', async () => {
      const tab1 = await engine.createTab(`${baseUrl}/noscript-redirect`)
      expect(tab1.getUrl()).toBe(`${baseUrl}/meta-dest`)

      const tab2 = await engine.createTab(`${baseUrl}/header-refresh`)
      expect(tab2.getUrl()).toBe(`${baseUrl}/meta-dest`)
    })

    it('does not auto-follow long-delay or self-referencing meta refreshes', async () => {
      const tab1 = await engine.createTab(`${baseUrl}/long-delay`)
      expect(tab1.getUrl()).toBe(`${baseUrl}/long-delay`)
      expect(tab1.getTitle()).toBe('Dashboard')

      const tab2 = await engine.createTab(`${baseUrl}/self-refresh`)
      expect(tab2.getUrl()).toBe(`${baseUrl}/self-refresh`)
      expect(tab2.getTitle()).toBe('Self Refresh')
    })

    it('detects and aborts meta-refresh redirect loops', async () => {
      const tab = await engine.createTab()
      await expect(tab.navigate(`${baseUrl}/loop-a`)).rejects.toThrow(/Too many redirects/i)
    })

    it('resolves form action via <base href>, switches POST->GET on meta refresh, and carries Set-Cookie', async () => {
      const tab = await engine.createTab(`${baseUrl}/login-form`)
      const snap = await tab.snapshot()
      const userInput = snap.elements.find((e) => e.name === 'user')
      const submitBtn = snap.elements.find((e) => e.tag === 'button')
      expect(userInput).toBeDefined()
      expect(submitBtn).toBeDefined()

      await tab.fill(userInput!.selector, 'anish')
      await tab.click(submitBtn!.selector)

      expect(tab.getUrl()).toBe(`${baseUrl}/whoami`)
      const afterSnap = await tab.snapshot()
      expect(afterSnap.text).toContain('Method:GET')
      expect(afterSnap.text).toContain('session_user=anish')
    })

    it('resolves clicked relative links against <base href>', async () => {
      const tab = await engine.createTab(`${baseUrl}/base-nav`)
      const snap = await tab.snapshot()
      const link = snap.elements.find((e) => e.tag === 'a')
      expect(link?.href).toBe(`${baseUrl}/v2/sub/target`)

      await tab.click(link!.selector)
      expect(tab.getUrl()).toBe(`${baseUrl}/v2/sub/target`)
      expect(tab.getTitle()).toBe('V2 Sub Target')
    })

    it('respects maxMetaRefreshDelaySeconds: -1 to disable auto-following', async () => {
      const noRefreshEngine = new LiteBrowserEngine({ maxMetaRefreshDelaySeconds: -1 })
      try {
        const tab = await noRefreshEngine.createTab(`${baseUrl}/meta-start`)
        expect(tab.getUrl()).toBe(`${baseUrl}/meta-start`)
        expect(tab.getTitle()).toBe('Redirecting')
      } finally {
        await noRefreshEngine.close()
      }
    })
  })
})
