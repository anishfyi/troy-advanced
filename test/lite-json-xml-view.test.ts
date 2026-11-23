import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  detectStructuredKind,
  formatJsonPathSegment,
  parseJsonDocument,
  parseXmlDocument,
  parseXmlTree,
  type ElementDescriptor,
} from '../src/index.js'

describe('M37: JSON & XML pretty-formatter views in Lite engine with collapsible path navigation', () => {
  describe('detectStructuredKind', () => {
    it('detects JSON and XML MIME types while excluding HTML and plain text', () => {
      expect(detectStructuredKind('application/json', '{}')).toBe('json')
      expect(detectStructuredKind('application/json; charset=utf-8', '[]')).toBe('json')
      expect(detectStructuredKind('application/vnd.api+json', '{}')).toBe('json')
      expect(detectStructuredKind('application/ld+json', '{}')).toBe('json')
      expect(detectStructuredKind('text/json', '{}')).toBe('json')

      expect(detectStructuredKind('application/xml', '<a/>')).toBe('xml')
      expect(detectStructuredKind('text/xml; charset=utf-8', '<a/>')).toBe('xml')
      expect(detectStructuredKind('application/atom+xml', '<feed/>')).toBe('xml')
      expect(detectStructuredKind('application/rss+xml', '<rss/>')).toBe('xml')
      expect(detectStructuredKind('image/svg+xml', '<svg/>')).toBe('xml')

      // Exclusions
      expect(detectStructuredKind('text/html', '<html></html>')).toBeNull()
      expect(detectStructuredKind('application/xhtml+xml', '<html/>')).toBeNull()
      expect(detectStructuredKind('text/plain', '{"a":1}')).toBeNull()
    })

    it('falls back to sniffing <?xml or .json/.xml extensions when MIME is absent or generic', () => {
      expect(detectStructuredKind('', '<?xml version="1.0"?><root/>')).toBe('xml')
      expect(detectStructuredKind('application/octet-stream', '{"ok":true}', 'https://example.com/data.json')).toBe('json')
      expect(detectStructuredKind('', '<catalog></catalog>', 'https://example.com/feed.xml')).toBe('xml')
      expect(detectStructuredKind('', 'plain text without xml', 'https://example.com/readme.txt')).toBeNull()
    })
  })

  describe('parseJsonDocument', () => {
    const sampleJson = JSON.stringify({
      service: 'troy-advanced',
      version: 2,
      active: true,
      notes: null,
      'api-meta': {
        region: 'us-east-1',
        limits: {
          rpm: 120,
          burst: 30,
        },
      },
      users: [
        { id: 1, name: 'Ada', profile: 'https://example.com/users/ada' },
        { id: 2, name: 'Grace', profile: 'https://example.com/users/grace' },
      ],
      emptyObj: {},
      emptyArr: [],
    })

    it('formats JSONPath segments cleanly for identifiers, array indices, and special keys', () => {
      expect(formatJsonPathSegment('$', 'users')).toBe('$.users')
      expect(formatJsonPathSegment('$.users', 0)).toBe('$.users[0]')
      expect(formatJsonPathSegment('$', 'api-meta')).toBe('$["api-meta"]')
    })

    it('renders tree with default expand depth = 2 (collapsing depth >= 2 containers)', () => {
      const doc = parseJsonDocument(sampleJson, 'https://api.example.com/v1/status')
      expect(doc.kind).toBe('json')
      expect(doc.title).toContain('JSON: /v1/status')
      expect(doc.text).toContain('"service": "troy-advanced"')
      expect(doc.text).toContain('"version": 2')
      expect(doc.text).toContain('"active": true')
      expect(doc.text).toContain('"notes": null')
      expect(doc.text).toContain('"emptyObj": {}')
      expect(doc.text).toContain('"emptyArr": []')

      // Level 1 containers (`$.users`, `$["api-meta"]`) are expanded by default
      const usersToggle = doc.elements.find((e) => e.selector === 'json-toggle:$.users')
      expect(usersToggle?.checked).toBe(true)
      expect(usersToggle?.text).toContain('v "users": [ (2 items)')

      // Level 2 containers (`$.users[0]`, `$["api-meta"].limits`) start collapsed by default
      const user0Toggle = doc.elements.find((e) => e.selector === 'json-toggle:$.users[0]')
      expect(user0Toggle?.checked).toBe(false)
      expect(user0Toggle?.text).toContain('> [0]: {3 keys:')
      expect(doc.text).not.toContain('"name": "Ada"')
    })

    it('respects collapsedPaths overrides, focusPath zooming, breadcrumbs, and URL links', () => {
      const collapsed = new Map<string, boolean>([['$.users[0]', false]])
      const doc = parseJsonDocument(sampleJson, 'https://api.example.com/v1/status', {
        collapsedPaths: collapsed,
        focusPath: '$.users[0]',
      })

      expect(doc.activePath).toBe('$.users[0]')
      expect(doc.text).toContain('"name": "Ada"')
      // Breadcrumbs allow jumping back to `$` and `$.users`
      expect(doc.elements.some((e) => e.selector === 'json-focus:$')).toBe(true)
      expect(doc.elements.some((e) => e.selector === 'json-focus:$.users')).toBe(true)
      // URL string value becomes a clickable link
      const profileLink = doc.elements.find((e) => e.selector === 'json-link:$.users[0].profile')
      expect(profileLink?.role).toBe('link')
      expect(profileLink?.href).toBe('https://example.com/users/ada')
    })

    it('handles invalid JSON and maxNodes cap gracefully', () => {
      const bad = parseJsonDocument('{ invalid json', 'https://api.example.com/broken')
      expect(bad.parseError).toBeTruthy()
      expect(bad.title).toContain('Invalid JSON')
      expect(bad.blocks.some((b) => b.kind === 'code' && b.text.includes('{ invalid json'))).toBe(true)

      const huge = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ idx: i })))
      const capped = parseJsonDocument(huge, 'https://api.example.com/huge', {
        defaultExpandDepth: 5,
        maxNodes: 10,
      })
      expect(capped.text).toContain('truncated after 10 nodes')
    })
  })

  describe('parseXmlDocument & parseXmlTree', () => {
    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
    <!-- Library Catalog -->
    <catalog version="1.0">
      <metadata>
        <owner>Troy &amp; Co.</owner>
        <homepage>https://example.com/library</homepage>
      </metadata>
      <book id="bk101" lang="en">
        <title>XML Developer's Guide</title>
        <summary><![CDATA[Fast <raw> XML & JSON guide]]></summary>
        <details>
          <pages>320</pages>
        </details>
      </book>
      <book id="bk102" lang="en">
        <title>Terminal Browsers</title>
        <link href="https://example.com/books/bk102" />
      </book>
    </catalog>`

    it('parses XML prolog, comments, CDATA, entities, attributes, and indexed XPaths', () => {
      const { root, error } = parseXmlTree(sampleXml)
      expect(error).toBeUndefined()
      expect(root?.path).toBe('/catalog')
      expect(root?.children.map((c) => c.path)).toEqual([
        '/catalog/metadata',
        '/catalog/book[1]',
        '/catalog/book[2]',
      ])
      expect(root?.children[0]?.children[0]?.text).toBe('Troy & Co.')
      expect(root?.children[1]?.children[1]?.text).toBe('Fast <raw> XML & JSON guide')
    })

    it('renders collapsible XML view with breadcrumbs and clickable URLs', () => {
      const doc = parseXmlDocument(sampleXml, 'https://example.com/catalog.xml')
      expect(doc.kind).toBe('xml')
      expect(doc.rootPath).toBe('/catalog')
      expect(doc.text).toContain('<owner>Troy & Co.</owner>')

      // Depth 2 container `/catalog/book[1]/details` starts collapsed by default
      const detailsToggle = doc.elements.find((e) => e.selector === 'xml-toggle:/catalog/book[1]/details')
      expect(detailsToggle?.checked).toBe(false)
      expect(doc.text).not.toContain('<pages>320</pages>')

      // URLs in leaf text and href attribute become clickable links
      const homeLink = doc.elements.find((e) => e.selector === 'xml-link:/catalog/metadata/homepage')
      expect(homeLink?.href).toBe('https://example.com/library')
      const bookLink = doc.elements.find((e) => e.selector === 'xml-link:/catalog/book[2]/link')
      expect(bookLink?.href).toBe('https://example.com/books/bk102')

      // Focusing `/catalog/book[1]` shows breadcrumbs and expands its direct child `details`
      const focused = parseXmlDocument(sampleXml, 'https://example.com/catalog.xml', {
        focusPath: '/catalog/book[1]',
      })
      expect(focused.activePath).toBe('/catalog/book[1]')
      expect(focused.text).toContain('<pages>320</pages>')
      expect(focused.elements.some((e) => e.selector === 'xml-focus:/catalog')).toBe(true)
    })

    it('recovers gracefully from malformed XML', () => {
      const partial = parseXmlDocument('<root><item>unclosed</root>', 'https://example.com/bad.xml')
      expect(partial.parseError).toBeTruthy()
      expect(partial.text).toContain('XML warning:')
      expect(partial.text).toContain('<item>unclosed</item>')

      const empty = parseXmlDocument('not xml at all', 'https://example.com/empty.xml')
      expect(empty.parseError).toBeTruthy()
      expect(empty.title).toContain('Invalid XML')
    })
  })

  describe('Interactive LiteTab + BrowserManager E2E', () => {
    let server: http.Server
    let baseUrl: string
    let tmpDir: string
    let manager: BrowserManager

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-m37-structured-'))
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

        if (url.pathname === '/api/data') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(
            JSON.stringify({
              service: 'troy-api',
              catalogUrl: `${origin}/catalog.xml`,
              teams: [
                {
                  name: 'Core',
                  lead: { handle: 'ada', role: 'architect' },
                },
                {
                  name: 'Infra',
                  lead: { handle: 'grace', role: 'sre' },
                },
              ],
            }),
          )
          return
        }

        if (url.pathname === '/catalog.xml') {
          res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
          res.end(`<?xml version="1.0"?>
          <catalog>
            <book id="b1">
              <title>ASCII Mastery</title>
              <meta>
                <edition>3rd</edition>
              </meta>
              <link href="${origin}/book-page" />
            </book>
            <book id="b2">
              <title>Lite Engine Internals</title>
            </book>
          </catalog>`)
          return
        }

        if (url.pathname === '/book-page') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>Book Page</title></head><body><h1>ASCII Mastery Book</h1></body></html>')
          return
        }

        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
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

    it('supports collapsible JSON tree, path focus/breadcrumbs, Expand/Collapse All, and navigating into XML & HTML', async () => {
      const tab = await manager.openTab(`${baseUrl}/api/data`, true)
      const tabId = tab.id

      type ReadResult = {
        ok: boolean
        url: string
        title: string
        ascii: string
        elements: ElementDescriptor[]
      }
      const readAscii = async () =>
        (await manager.runTool(tabId, 'page_read_ascii', { width: 100, height: 60 })) as ReadResult

      // 1. Initial JSON view: $.teams[0] starts collapsed (depth 2)
      const r1 = await readAscii()
      expect(r1.title).toContain('JSON: /api/data')
      expect(r1.ascii).toContain('"service": "troy-api"')
      expect(r1.ascii).not.toContain('"name": "Core"')

      // 2. Click toggle on $.teams[0] -> expands it
      const team0Toggle = r1.elements.find((e) => e.ariaLabel === 'Expand $.teams[0]')!
      expect(team0Toggle).toBeDefined()
      const toggleRes = (await manager.runTool(tabId, 'page_click', { ref: team0Toggle.ref })) as {
        ok: boolean
        note?: string
      }
      expect(toggleRes.ok).toBe(true)
      expect(toggleRes.note).toBe('expanded $.teams[0]')

      const r2 = await readAscii()
      expect(r2.ascii).toContain('"name": "Core"')
      // Nested lead at depth 3 is still collapsed until expanded or focused
      expect(r2.ascii).not.toContain('"handle": "ada"')

      // 3. Focus into $.teams[0] via focus button -> zooms in & shows breadcrumbs
      const team0Focus = r2.elements.find((e) => e.ariaLabel === 'Focus JSON path $.teams[0]')!
      expect(team0Focus).toBeDefined()
      const focusRes = (await manager.runTool(tabId, 'page_click', { ref: team0Focus.ref })) as {
        ok: boolean
        note?: string
      }
      expect(focusRes.ok).toBe(true)
      expect(focusRes.note).toBe('focused $.teams[0]')

      const r3 = await readAscii()
      expect(r3.ascii).toContain('Path:')
      expect(r3.ascii).toContain('"handle": "ada"')
      expect(r3.ascii).not.toContain('"service": "troy-api"')

      // 4. Click Reset to $ breadcrumb/button to return to root
      const resetBtn = r3.elements.find((e) => e.text === 'Reset to $')!
      expect(resetBtn).toBeDefined()
      await manager.runTool(tabId, 'page_click', { ref: resetBtn.ref })

      // 5. Click Expand All -> reveals deep leaf `"handle": "grace"`
      const r4 = await readAscii()
      const expandAll = r4.elements.find((e) => e.text === 'Expand All')!
      expect(expandAll).toBeDefined()
      await manager.runTool(tabId, 'page_click', { ref: expandAll.ref })
      const r5 = await readAscii()
      expect(r5.ascii).toContain('"handle": "grace"')

      // 6. Click Collapse All -> hides `"name": "Core"` again while keeping root open
      const collapseAll = r5.elements.find((e) => e.text === 'Collapse All')!
      expect(collapseAll).toBeDefined()
      await manager.runTool(tabId, 'page_click', { ref: collapseAll.ref })
      const r6 = await readAscii()
      expect(r6.ascii).not.toContain('"name": "Core"')
      expect(r6.ascii).toContain('"service": "troy-api"')

      // 7. Click the HATEOAS catalogUrl link inside the JSON -> navigates to /catalog.xml
      const xmlLink = r6.elements.find((e) => e.ariaLabel === 'Open URL at $.catalogUrl')!
      expect(xmlLink).toBeDefined()
      const navXml = (await manager.runTool(tabId, 'page_click', { ref: xmlLink.ref })) as { ok: boolean }
      expect(navXml.ok).toBe(true)

      const x1 = await readAscii()
      expect(x1.title).toContain('XML: /catalog.xml')
      expect(x1.ascii).toContain('<title>ASCII Mastery</title>')
      // Depth 2 `/catalog/book[1]/meta` starts collapsed
      expect(x1.ascii).not.toContain('<edition>3rd</edition>')

      // 8. Expand `/catalog/book[1]/meta`
      const metaToggle = x1.elements.find((e) => e.ariaLabel === 'Expand /catalog/book[1]/meta')!
      expect(metaToggle).toBeDefined()
      const metaRes = (await manager.runTool(tabId, 'page_click', { ref: metaToggle.ref })) as {
        ok: boolean
        note?: string
      }
      expect(metaRes.ok).toBe(true)
      expect(metaRes.note).toBe('expanded /catalog/book[1]/meta')

      const x2 = await readAscii()
      expect(x2.ascii).toContain('<edition>3rd</edition>')

      // 9. Focus `/catalog/book[1]`, verify book[2] is hidden, then follow XML link to HTML page
      const bookFocus = x2.elements.find((e) => e.ariaLabel === 'Focus XML path /catalog/book[1]')!
      expect(bookFocus).toBeDefined()
      await manager.runTool(tabId, 'page_click', { ref: bookFocus.ref })
      const x3 = await readAscii()
      expect(x3.ascii).not.toContain('Lite Engine Internals')
      expect(x3.ascii).toContain('ASCII Mastery')

      const htmlLink = x3.elements.find((e) => e.ariaLabel === 'Open URL at /catalog/book[1]/link')!
      expect(htmlLink).toBeDefined()
      await manager.runTool(tabId, 'page_click', { ref: htmlLink.ref })
      const finalPage = await readAscii()
      expect(finalPage.title).toBe('Book Page')
      expect(finalPage.ascii).toContain('ASCII MASTERY BOOK')
    })
  })
})
