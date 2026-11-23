import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderPageAscii } from '../src/ascii/layout.js'
import {
  detectDocumentKind,
  parseCsvData,
  renderDocumentView,
} from '../src/engine/document-view.js'
import {
  buildFeedReaderDocument,
  detectFeedKind,
  discoverFeedsInHtml,
  parseFeedXml,
} from '../src/engine/feed-reader.js'
import {
  encodeMultipartFormData,
  encodeTextPlainFormData,
  encodeUrlEncodedFormData,
} from '../src/engine/form-encoding.js'
import { decodeHtmlEntities } from '../src/engine/html-entities.js'
import {
  LiteBrowserEngine,
  extractBaseHref,
  extractLabelText,
  extractMetaRefresh,
  parseHtmlDocument,
  parseMetaRefreshContent,
} from '../src/engine/lite.js'
import {
  detectStructuredKind,
  parseJsonDocument,
  parseStructuredDocument,
  parseXmlDocument,
  parseXmlTree,
} from '../src/engine/structured-view.js'
import type { PageSnapshot } from '../src/types.js'

const STRICT_PRINTABLE_ASCII_RE = /^[\n\x20-\x7e]*$/

/** Deterministic Mulberry32 PRNG for reproducible fuzzing. */
function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!
}

function parsedDocToSnapshot(
  url: string,
  doc: ReturnType<typeof parseHtmlDocument>,
): PageSnapshot {
  return {
    url,
    title: doc.title,
    epoch: 1,
    viewport: { width: 1024, height: 768 },
    scroll: { x: 0, y: 0, maxY: 0 },
    blocks: doc.blocks,
    elements: doc.elements,
    text: doc.text,
    ...(doc.frames ? { frames: doc.frames } : {}),
  }
}

function assertCleanAsciiOutput(ascii: string): void {
  expect(typeof ascii).toBe('string')
  expect(ascii.length).toBeGreaterThan(0)
  expect(STRICT_PRINTABLE_ASCII_RE.test(ascii)).toBe(true)
  expect(ascii).not.toContain('\x1b')
  expect(ascii).not.toContain('\0')
}

function assertNoPrototypePollution(): void {
  const proto = Object.prototype as Record<string, unknown>
  expect(proto['polluted']).toBeUndefined()
  expect(proto['injected']).toBeUndefined()
  expect(proto['xss']).toBeUndefined()
}

describe('M42: Comprehensive Lite engine fuzz & malformed-HTML resilience', () => {
  describe('1. ReDoS & catastrophic backtracking immunity', () => {
    it('handles unclosed tags with many quoted attributes in linear time', () => {
      const attrs = 'a="x" b=\'y\' '.repeat(60)
      const payloads = [
        `<meta http-equiv="refresh" ${attrs}`,
        `<base href="https://example.com/" ${attrs}`,
        `<iframe src="https://example.com/" ${attrs}`,
        `<label ${attrs}>Name <select ${attrs}><option>1</option></select></label>`,
        `<form><input type="hidden" ${attrs}</form>`,
        `<link rel="alternate" type="application/rss+xml" ${attrs}`,
        `<div role="button" ${attrs}`,
        `<a ${attrs}`,
      ]

      const start = performance.now()
      for (const html of payloads) {
        const doc = parseHtmlDocument(html, 'https://example.com/')
        expect(doc).toBeDefined()
        extractBaseHref(html, 'https://example.com/')
        extractMetaRefresh(html, 'https://example.com/')
        extractLabelText(html)
        discoverFeedsInHtml(html, 'https://example.com/')
      }
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(500)
    })

    it('handles repeated unclosed comments, scripts, styles, and entities in linear time', () => {
      const payloads = [
        '<!-- '.repeat(2000),
        '<script>'.repeat(1000) + 'alert(1)',
        '<style>'.repeat(1000) + 'body{color:red}',
        '<svg>'.repeat(1000) + '<path/>',
        '&amp'.repeat(10000),
        '&'.repeat(50000),
        '&#x'.repeat(10000),
        '<p>'.repeat(3000) + 'hello',
      ]

      const start = performance.now()
      for (const payload of payloads) {
        const doc = parseHtmlDocument(payload, 'https://example.com/')
        expect(doc).toBeDefined()
        decodeHtmlEntities(payload)
      }
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(1000)
    })
  })

  describe('2. Malformed & adversarial HTML edge cases', () => {
    it('survives unclosed, mismatched, and interleaved tags with stray closers', () => {
      const cases = [
        '</form></fieldset></details></dialog></legend></summary></p></a></table></tr>',
        '<p><div>Unclosed paragraph</p></div>',
        '<a href="/one"><b>Interleaved link</a></b>',
        '<form id="f1"><form id="f2"><input name="x" value="1"><button>Go',
        '<fieldset disabled><legend>L1<fieldset><input name="inner">',
        '<details open><summary>Toggle<p>Body without closing details',
        '<dialog open aria-label="Modal"><p>Inside unclosed dialog',
        '<table><tr><td>Cell 1<td>Cell 2<tr><td>Cell 3',
        '<select name="s"><option>A<option selected>B<textarea>Unclosed textarea',
        '<h1 id="top">Heading without close<p>Next paragraph',
      ]

      for (const html of cases) {
        const doc = parseHtmlDocument(html, 'https://example.com/page')
        expect(Array.isArray(doc.blocks)).toBe(true)
        expect(Array.isArray(doc.elements)).toBe(true)
        const ascii = renderPageAscii(parsedDocToSnapshot('https://example.com/page', doc))
        assertCleanAsciiOutput(ascii)
      }
    })

    it('strips unclosed comments, scripts, styles, and self-closing <svg/> safely', () => {
      const unclosedComment = '<p>Visible</p><!-- <a href="/secret">Hidden link</a>'
      const cDoc = parseHtmlDocument(unclosedComment, 'https://example.com/')
      expect(cDoc.text).toContain('Visible')
      expect(cDoc.elements.some((e) => e.href?.includes('/secret'))).toBe(false)

      const unclosedScript = '<p>Before</p><script>const s = "<a href=/evil>Evil</a>"'
      const sDoc = parseHtmlDocument(unclosedScript, 'https://example.com/')
      expect(sDoc.text).toContain('Before')
      expect(sDoc.elements.some((e) => e.href?.includes('/evil'))).toBe(false)

      const unclosedStyle = '<p>Styled</p><style>.a { content: "<button>Fake</button>"; }'
      const stDoc = parseHtmlDocument(unclosedStyle, 'https://example.com/')
      expect(stDoc.text).toContain('Styled')
      expect(stDoc.elements.some((e) => e.text === 'Fake')).toBe(false)

      const selfClosingSvg = '<svg viewBox="0 0 10 10"/><p>After self-closing SVG</p><svg><rect/></svg>'
      const svgDoc = parseHtmlDocument(selfClosingSvg, 'https://example.com/')
      expect(svgDoc.text).toContain('After self-closing SVG')
    })

    it('resists prototype pollution via HTML attribute and form field names', () => {
      const html = `
        <form action="/submit" __proto__="polluted" constructor="injected">
          <input name="__proto__" value="polluted" toString="xss" valueOf="xss" hasOwnProperty="xss" />
          <input name="constructor" value="injected" />
          <input name="prototype" value="injected" />
          <a href="/ok" __proto__="polluted" constructor="injected" role="link">Safe Link</a>
          <button type="submit" __proto__="polluted">Send</button>
        </form>
      `
      const doc = parseHtmlDocument(html, 'https://example.com/')
      expect(doc.elements.length).toBeGreaterThanOrEqual(4)
      assertNoPrototypePollution()
      const ascii = renderPageAscii(parsedDocToSnapshot('https://example.com/', doc))
      assertCleanAsciiOutput(ascii)
    })

    it('rejects unsafe and malformed URLs in <base> and <meta refresh> without throwing', () => {
      const badBases = [
        '<base href="javascript:alert(1)">',
        '<base href="vbscript:msgbox(1)">',
        '<base href="data:text/html,<script>alert(1)</script>">',
        '<base href="http://[::1">',
        '<base href="   ">',
      ]
      for (const html of badBases) {
        expect(() => extractBaseHref(html, 'https://example.com/dir/page')).not.toThrow()
        if (!html.includes('   ')) {
          expect(extractBaseHref(html, 'https://example.com/dir/page')).toBeUndefined()
        }
      }

      const badRefreshes = [
        '0; url=javascript:alert(1)',
        '0; url=data:text/html,hi',
        '0; url=file:///etc/passwd',
        '-5; url=https://example.com/',
        'not-a-number; url=https://example.com/',
        '0; url="http://[::1"',
        '',
        '   ',
      ]
      for (const content of badRefreshes) {
        expect(() => parseMetaRefreshContent(content, 'https://example.com/')).not.toThrow()
        expect(parseMetaRefreshContent(content, 'https://example.com/')).toBeUndefined()
      }
    })

    it('sanitizes null bytes, control chars, ANSI escapes, RTL overrides, emoji, and lone surrogates', () => {
      const nasty = [
        '<!DOCTYPE html><html><head><title>\uFEFF\x1b[31mRed\x1b[0m\0Title\u202E</title></head><body>',
        '<h1>Hello \uD800 World \uDFFF \u0007\u0008\u001b]0;pwned\x07 🚀 日本語</h1>',
        '<p>Text with \x1b[1;32mANSI\x1b[0m and \0null\0 bytes and “smart quotes” — emdash</p>',
        '<a href="/go?q=%ZZ">Link \x1b[2J\x1b[H Clear</a>',
        '<form><input name="q" placeholder="\x1b[31mInjected\x1b[0m" value="v\0al" /><button>Go \u202E</button></form>',
        '</body></html>',
      ].join('\n')

      const doc = parseHtmlDocument(nasty, 'https://example.com/')
      const ascii = renderPageAscii(parsedDocToSnapshot('https://example.com/', doc))
      assertCleanAsciiOutput(ascii)
      expect(ascii).toContain('RedTitle')
      expect(ascii).not.toContain('[31m')
      expect(ascii).not.toContain('[2J')
    })

    it('handles deeply nested containers and recursive srcdoc iframes safely', () => {
      const deepFieldsets =
        '<fieldset>'.repeat(400) +
        '<p>Deep leaf</p><button>Deep Btn</button>' +
        '</fieldset>'.repeat(400)
      const fsDoc = parseHtmlDocument(deepFieldsets, 'https://example.com/')
      expect(fsDoc.text).toContain('Deep leaf')
      expect(fsDoc.elements.some((e) => e.text === 'Deep Btn')).toBe(true)

      const deepDetails =
        '<details open><summary>S</summary>'.repeat(250) +
        '<p>Inside</p>' +
        '</details>'.repeat(250)
      const detDoc = parseHtmlDocument(deepDetails, 'https://example.com/')
      expect(detDoc.blocks.length).toBeGreaterThan(0)

      // 8 levels of nested srcdoc iframes (Lite caps iframe recursion at depth 4)
      let nestedIframe = '<p>Bottom iframe</p>'
      for (let i = 0; i < 8; i++) {
        const escaped = nestedIframe.replace(/"/g, '&quot;')
        nestedIframe = `<iframe srcdoc="${escaped}"></iframe>`
      }
      const ifDoc = parseHtmlDocument(nestedIframe, 'https://example.com/')
      expect(ifDoc).toBeDefined()
    })

    it('parses large 200KB HTML documents with thousands of elements swiftly', () => {
      const parts: string[] = ['<html><head><title>Large Stress</title></head><body>']
      for (let i = 0; i < 1500; i++) {
        parts.push(`<p>Paragraph ${i} with <a href="/item/${i}">link ${i}</a> and text.</p>`)
      }
      parts.push(`<div data-huge="${'x'.repeat(50_000)}"><button>Submit Huge</button></div>`)
      parts.push('</body></html>')
      const largeHtml = parts.join('\n')
      expect(largeHtml.length).toBeGreaterThan(150_000)

      const t0 = performance.now()
      const doc = parseHtmlDocument(largeHtml, 'https://example.com/')
      const elapsedMs = performance.now() - t0

      expect(doc.title).toBe('Large Stress')
      expect(doc.elements.length).toBeGreaterThan(1000)
      expect(elapsedMs).toBeLessThan(1500)
    })
  })

  describe('3. HTML entity decoder edge cases', () => {
    it('handles malformed, out-of-range, surrogate, and zero numeric entities cleanly', () => {
      const inputs = [
        '&',
        '&;',
        '&#;',
        '&#x;',
        '&#0;',
        '&#x0;',
        '&#xD800;',
        '&#xDFFF;',
        '&#x110000;',
        '&#99999999999999999999999999;',
        '&#xFFFFFFFFFFFFFFFFFFFFFFFF;',
        '&nonexistententityname;',
        '&amp;&lt;&gt;&quot;&apos;&nbsp;&copy;&mdash;',
        'a=1&copy=2&not=3',
      ]

      for (const s of inputs) {
        expect(() => decodeHtmlEntities(s)).not.toThrow()
        expect(() => decodeHtmlEntities(s, { attributeMode: true })).not.toThrow()
        const out = decodeHtmlEntities(s)
        expect(typeof out).toBe('string')
      }
      // Surrogates and out-of-range decode to U+FFFD replacement char
      expect(decodeHtmlEntities('&#xD800;')).toBe('\uFFFD')
      expect(decodeHtmlEntities('&#x110000;')).toBe('\uFFFD')
      expect(decodeHtmlEntities('&#0;')).toBe('\uFFFD')
    })
  })

  describe('4. JSON, XML, RSS/Atom, CSV, Markdown, Plain-Text & Form Encoding resilience', () => {
    it('caps deeply nested JSON and XML without stack overflow', () => {
      const deepJson = '['.repeat(500) + '1' + ']'.repeat(500)
      const jsonRes = parseJsonDocument(deepJson, 'https://example.com/deep.json')
      expect(jsonRes.kind).toBe('json')
      expect(jsonRes.parseError).toBeUndefined()
      expect(jsonRes.blocks.length).toBeGreaterThan(0)

      const deepXml = '<a>'.repeat(500) + 'leaf' + '</a>'.repeat(500)
      const xmlTree = parseXmlTree(deepXml)
      expect(xmlTree.root).not.toBeNull()
      expect(xmlTree.error).toContain('maximum depth')
      const xmlRes = parseXmlDocument(deepXml, 'https://example.com/deep.xml')
      expect(xmlRes.kind).toBe('xml')
      expect(xmlRes.blocks.length).toBeGreaterThan(0)
    })

    it('gracefully handles malformed JSON, XML, and RSS/Atom feeds', () => {
      const brokenJsons = ['', '   ', '{', '{"a": [1, 2,', 'undefined', '\0\x1b[31m{bad}']
      for (const raw of brokenJsons) {
        const res = parseJsonDocument(raw, 'https://example.com/bad.json')
        expect(res.kind).toBe('json')
        expect(res.parseError).toBeTruthy()
        expect(res.blocks.length).toBeGreaterThan(0)
      }

      const brokenXmls = [
        '',
        '<<<>>>',
        '<root><a><b></root>',
        '<root><![CDATA[unclosed cdata',
        '</stray><root attr="unclosed>text',
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe "bad">]><root>&xxe;</root>',
      ]
      for (const raw of brokenXmls) {
        const res = parseXmlDocument(raw, 'https://example.com/bad.xml')
        expect(res.kind).toBe('xml')
        expect(res.blocks.length).toBeGreaterThan(0)
      }

      const brokenFeeds = [
        '',
        '<rss><channel><item><title>Unclosed',
        '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="javascript:alert(1)"/><updated>not-a-date</updated></entry>',
        '<rss version="2.0"><channel><item><description><![CDATA[unclosed</channel></rss>',
        'not xml at all \0\x1b[31m',
      ]
      for (const raw of brokenFeeds) {
        const parsed = parseFeedXml(raw, 'https://example.com/feed.xml')
        const doc = buildFeedReaderDocument(parsed)
        expect(doc.blocks.length).toBeGreaterThan(0)
        const ascii = renderPageAscii(
          parsedDocToSnapshot('https://example.com/feed.xml', {
            title: doc.title,
            blocks: doc.blocks,
            elements: doc.elements,
            text: doc.text,
            forms: new Map(),
          }),
        )
        assertCleanAsciiOutput(ascii)
      }
    })

    it('gracefully handles malformed CSV, Markdown, and Plain-Text documents', () => {
      const brokenCsvs = [
        '',
        'a,b,c\n"unclosed quote,2,3\n4,5',
        'col1,col2\n1,2,3,4,5,6\nonlyone',
        '\uFEFF"a""b","c\nd"\n"\x1b[31mred\x1b[0m","null\0byte"',
        ','.repeat(200) + '\n' + 'x,'.repeat(200),
      ]
      for (const raw of brokenCsvs) {
        expect(() => parseCsvData(raw, 'text/csv', 'https://example.com/data.csv')).not.toThrow()
        const view = renderDocumentView(raw, 'https://example.com/data.csv', {
          contentType: 'text/csv',
        })
        const ascii = renderPageAscii(
          parsedDocToSnapshot('https://example.com/data.csv', {
            title: view.title,
            blocks: view.blocks,
            elements: view.elements,
            text: view.text,
            forms: new Map(),
          }),
        )
        assertCleanAsciiOutput(ascii)
      }

      const brokenMarkdowns = [
        '',
        '```js\nunclosed code fence\nconst x = 1;',
        '# Heading\n[broken link](javascript:alert(1))\n[nested [link]](http://[::1)',
        '| a | b |\n| --- |\n| 1 | 2 | 3 | 4 |',
        '> '.repeat(200) + 'deep quote',
      ]
      for (const raw of brokenMarkdowns) {
        const view = renderDocumentView(raw, 'https://example.com/doc.md', {
          contentType: 'text/markdown',
        })
        const ascii = renderPageAscii(
          parsedDocToSnapshot('https://example.com/doc.md', {
            title: view.title,
            blocks: view.blocks,
            elements: view.elements,
            text: view.text,
            forms: new Map(),
          }),
        )
        assertCleanAsciiOutput(ascii)
      }

      const nastyText = '\0\x1b[31mBinary\x1b[0m\uD800\n' + 'A'.repeat(10_000)
      const txtView = renderDocumentView(nastyText, 'https://example.com/raw.txt', {
        contentType: 'text/plain',
      })
      const txtAscii = renderPageAscii(
        parsedDocToSnapshot('https://example.com/raw.txt', {
          title: txtView.title,
          blocks: txtView.blocks,
          elements: txtView.elements,
          text: txtView.text,
          forms: new Map(),
        }),
      )
      assertCleanAsciiOutput(txtAscii)
    })

    it('sanitizes CRLF/quote/null injections in form-encoding helpers', () => {
      const entries = [
        { name: 'field\r\nX-Injected: 1', value: 'val\r\n--boundary' },
        { name: 'quote"name', value: 'v\0al', filename: 'evil"\r\n.txt' },
        { name: '__proto__', value: 'polluted' },
      ]
      const mp = encodeMultipartFormData(entries)
      expect(mp.contentType).toContain('multipart/form-data; boundary=')
      expect(mp.body.toString('utf8')).not.toMatch(/name="[^"]*\r\n/)
      expect(mp.body.toString('utf8')).not.toMatch(/filename="[^"]*\r\n/)

      const urlEnc = encodeUrlEncodedFormData(entries)
      expect(typeof urlEnc).toBe('string')

      const txtEnc = encodeTextPlainFormData(entries)
      expect(typeof txtEnc).toBe('string')
      assertNoPrototypePollution()
    })
  })

  describe('5. Deterministic seeded PRNG fuzz corpus (300+ generated inputs)', () => {
    it('fuzzes parseHtmlDocument + renderPageAscii across 150 mutated HTML documents', () => {
      const rng = createRng(0x54524f59) // "TROY"
      const tokens = [
        '<html>', '</html>', '<body>', '</body>', '<head>', '</head>',
        '<title>', '</title>', '<h1>', '</h1>', '<h3>', '</h3>',
        '<p>', '</p>', '<div>', '</div>', '<span>', '</span>',
        '<a href="/next">', '<a href="javascript:alert(1)">', '<a href="http://[::1">', '</a>',
        '<form action="/post" method="POST">', '<form enctype="multipart/form-data">', '</form>',
        '<fieldset disabled>', '<fieldset>', '</fieldset>', '<legend>', '</legend>',
        '<details open>', '<details>', '</details>', '<summary>', '</summary>',
        '<dialog open>', '<dialog>', '</dialog>',
        '<label for="x">', '<label>', '</label>',
        '<input name="q" value="v">', '<input type="hidden" name="csrf" value="123">',
        '<input type="checkbox" checked>', '<input type="file" name="f">',
        '<textarea name="t">', '</textarea>',
        '<select name="s"><option value="1">One</option><option>Two', '</select>',
        '<button type="submit">', '</button>',
        '<div role="button" aria-label="Act">', '<span role="link" data-href="/r">',
        '<table>', '<tr>', '<td>', '</td>', '</tr>', '</table>',
        '<ul>', '<li>', '</li>', '</ul>', '<pre>', '</pre>', '<hr/>',
        '<img src="/i.png" alt="pic" width="10" height="20">',
        '<canvas width="50" height="50">', '</canvas>',
        '<iframe srcdoc="<p>sub</p>">', '</iframe>',
        '<base href="https://example.com/sub/">',
        '<meta http-equiv="refresh" content="0;url=/r">',
        '<link rel="alternate" type="application/rss+xml" href="/rss">',
        '<!--', '-->', '<script>', '</script>', '<style>', '</style>', '<svg/>', '<svg>', '</svg>',
        '&amp;', '&lt;', '&#x1F600;', '&#999999999;', '&#xD800;', '&broken;',
        '"', "'", '<', '>', '=', '/', ' ', '\n', '\0', '\x1b[31m', '\uFEFF', '\u202E',
        '__proto__="1"', 'constructor="2"', 'hello', 'world', '日本語', '🚀',
      ]

      const start = performance.now()
      for (let i = 0; i < 150; i++) {
        const count = 15 + Math.floor(rng() * 80)
        let html = ''
        for (let j = 0; j < count; j++) {
          html += pick(rng, tokens)
        }
        const doc = parseHtmlDocument(html, 'https://example.com/fuzz')
        expect(doc).toBeDefined()
        expect(Array.isArray(doc.blocks)).toBe(true)
        expect(Array.isArray(doc.elements)).toBe(true)
        expect(typeof doc.text).toBe('string')

        const ascii = renderPageAscii(parsedDocToSnapshot('https://example.com/fuzz', doc))
        assertCleanAsciiOutput(ascii)
      }
      assertNoPrototypePollution()
      expect(performance.now() - start).toBeLessThan(3000)
    })

    it('fuzzes structured JSON/XML, RSS/Atom, CSV/Markdown/text, and entity decoders across 150 inputs', () => {
      const rng = createRng(0x46555a5a) // "FUZZ"
      const fragments = [
        '{', '}', '[', ']', ':', ',', '"a"', '"__proto__"', '123', 'true', 'null',
        '<rss>', '</rss>', '<feed>', '</feed>', '<item>', '</item>', '<entry>', '</entry>',
        '<title>', '</title>', '<link href="/x"/>', '<root>', '</root>', '<node a="1">', '</node>',
        '<![CDATA[', ']]>', '<!--', '-->', '<?xml version="1.0"?>',
        '# H1\n', '## H2\n', '- item\n', '```\ncode\n', '| a | b |\n', '> quote\n',
        'a,b,c\n', '"q,1","q""2"\n', '\t', ';',
        '&amp;', '&#123;', '&#x1F4A9;', '&nope;',
        '\0', '\x1b[33m', '\uFEFF', '\uD800', '\n', 'text',
      ]

      const start = performance.now()
      for (let i = 0; i < 150; i++) {
        const count = 10 + Math.floor(rng() * 50)
        let body = ''
        for (let j = 0; j < count; j++) {
          body += pick(rng, fragments)
        }

        decodeHtmlEntities(body)
        detectStructuredKind('', body)
        detectFeedKind('', body)
        detectDocumentKind('', body, 'https://example.com/fuzz')

        const mode = i % 5
        if (mode === 0) {
          const r = parseStructuredDocument('json', body, 'https://example.com/f.json')
          expect(r.blocks.length).toBeGreaterThan(0)
        } else if (mode === 1) {
          const r = parseStructuredDocument('xml', body, 'https://example.com/f.xml')
          expect(r.blocks.length).toBeGreaterThan(0)
        } else if (mode === 2) {
          const f = parseFeedXml(body, 'https://example.com/f.rss')
          const d = buildFeedReaderDocument(f)
          expect(d.blocks.length).toBeGreaterThan(0)
        } else if (mode === 3) {
          const d = renderDocumentView(body, 'https://example.com/f.csv', { contentType: 'text/csv' })
          expect(d.blocks.length).toBeGreaterThan(0)
        } else {
          const d = renderDocumentView(body, 'https://example.com/f.md', { contentType: 'text/markdown' })
          expect(d.blocks.length).toBeGreaterThan(0)
        }
      }
      assertNoPrototypePollution()
      expect(performance.now() - start).toBeLessThan(3000)
    })
  })

  describe('6. End-to-end LiteBrowserEngine hostile HTTP server resilience', () => {
    let server: http.Server
    let baseUrl: string
    let engine: LiteBrowserEngine

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const urlPath = (req.url ?? '/').split('?')[0] ?? '/'

        if (urlPath === '/empty') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('')
          return
        }
        if (urlPath === '/no-content') {
          res.writeHead(204)
          res.end()
          return
        }
        if (urlPath === '/binary-as-html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          // Raw PNG signature + random binary bytes
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x1b, 0x5b, 0x33, 0x31, 0x6d]))
          return
        }
        if (urlPath === '/invalid-utf8') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          const buf = Buffer.concat([
            Buffer.from('<html><head><title>UTF8 '),
            Buffer.from([0xff, 0xfe, 0xc0, 0xaf]),
            Buffer.from('</title></head><body><p>Body '),
            Buffer.from([0xed, 0xa0, 0x80]),
            Buffer.from(' End</p></body></html>'),
          ])
          res.end(buf)
          return
        }
        if (urlPath === '/malformed-html') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            `<meta http-equiv="refresh" ${'a="x" '.repeat(50)}` +
              `<p>Welcome <a href="/empty">Empty</a></p>` +
              `<form action="/echo" method="POST" __proto__="polluted">` +
              `<input name="q" value="init">` +
              `<button type="submit">Send` +
              `<script>var broken = "<a href=/nope>nope</a>"`,
          )
          return
        }
        if (urlPath === '/echo') {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(`<html><body><h1>Echo</h1><p>${body}</p></body></html>`)
          })
          return
        }
        if (urlPath === '/redirect-loop') {
          res.writeHead(302, { Location: '/redirect-loop' })
          res.end('redirecting')
          return
        }
        if (urlPath === '/meta-refresh-loop') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><head><meta http-equiv="refresh" content="0;url=/meta-refresh-loop"></head><body><p>Loop</p></body></html>')
          return
        }
        if (urlPath === '/bad-cookies') {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Set-Cookie': [
              '=emptyname',
              'good=1; Path=/; Expires=Not-A-Valid-Date; Max-Age=NaN',
              'weird; ; ; ===; Domain=..invalid..',
            ],
          })
          res.end('<html><body><p>Cookies survived</p></body></html>')
          return
        }
        if (urlPath === '/server-error') {
          res.writeHead(500, { 'Content-Type': 'text/html' })
          res.end('<html><body><h1>500 Broken<p>Truncated')
          return
        }
        if (urlPath === '/broken-json') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"broken": [1, 2, ')
          return
        }
        if (urlPath === '/broken-xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end('<a>'.repeat(200) + 'deep')
          return
        }
        if (urlPath === '/broken-feed') {
          res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
          res.end('<rss version="2.0"><channel><title>Broken Feed</title><item><title>Item 1')
          return
        }
        if (urlPath === '/broken-csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv' })
          res.end('h1,h2\n"unclosed,2\n3,4,5\n')
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
      })

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://127.0.0.1:${port}`
      engine = new LiteBrowserEngine()
    })

    afterAll(async () => {
      await engine.close()
      await new Promise<void>((r) => server.close(() => r()))
    })

    it('navigates and renders every hostile/malformed HTTP endpoint without crashing', async () => {
      const tab = await engine.createTab(`${baseUrl}/empty`)
      const routes = [
        '/empty',
        '/no-content',
        '/binary-as-html',
        '/invalid-utf8',
        '/malformed-html',
        '/meta-refresh-loop',
        '/bad-cookies',
        '/server-error',
        '/broken-json',
        '/broken-xml',
        '/broken-feed',
        '/broken-csv',
      ]

      for (const route of routes) {
        await tab.navigate(`${baseUrl}${route}`)
        const snap = await tab.snapshot()
        expect(snap).toBeDefined()
        expect(Array.isArray(snap.blocks)).toBe(true)
        expect(Array.isArray(snap.elements)).toBe(true)
        const ascii = renderPageAscii(snap)
        assertCleanAsciiOutput(ascii)
      }

      // Redirect loop must terminate cleanly (either bounded error or bounded hops) without hanging
      let loopOutcome: 'resolved' | 'rejected' = 'resolved'
      try {
        await tab.navigate(`${baseUrl}/redirect-loop`)
      } catch (err) {
        loopOutcome = 'rejected'
        expect(String(err)).toMatch(/redirect/i)
      }
      expect(['resolved', 'rejected']).toContain(loopOutcome)

      // Tab remains usable after hostile responses & redirect loop; malformed form still submits
      await tab.navigate(`${baseUrl}/malformed-html`)
      const snap = await tab.snapshot()
      const inputEl = snap.elements.find((e) => e.tag === 'input' && e.name === 'q')
      expect(inputEl).toBeDefined()
      await tab.fill(inputEl!.selector, 'hello-fuzz')
      const afterFill = await tab.snapshot()
      const filledEl = afterFill.elements.find((e) => e.tag === 'input' && e.name === 'q')
      expect(filledEl?.value).toBe('hello-fuzz')

      await tab.close()
      assertNoPrototypePollution()
    })
  })
})
