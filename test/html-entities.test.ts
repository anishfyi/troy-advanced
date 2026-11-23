import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HTML5_LEGACY_NAMED_ENTITIES,
  HTML5_NAMED_ENTITIES,
  decodeHtmlEntities,
  decodeNumericEntity,
  lookupNamedEntity,
} from '../src/engine/html-entities.js'
import { LiteBrowserEngine } from '../src/engine/lite.js'
import { extractLitePageText } from '../src/engine/wait.js'

describe('HTML5 entity decoding (M32)', () => {
  it('decodes core XML/HTML entities including uppercase HTML5 variants', () => {
    expect(decodeHtmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'')
    expect(decodeHtmlEntities('&AMP;&LT;&GT;&QUOT;')).toBe('&<>"')
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a\u00a0b')
    expect(decodeHtmlEntities('&NonBreakingSpace;&Tab;&NewLine;')).toBe('\u00a0\t\n')
    expect(decodeHtmlEntities('&copy; &COPY; &reg; &REG; &trade; &TRADE;')).toBe(
      '\u00a9 \u00a9 \u00ae \u00ae \u2122 \u2122',
    )
  })

  it('enforces case sensitivity for HTML5 named entities', () => {
    expect(decodeHtmlEntities('&Agrave; &agrave;')).toBe('\u00c0 \u00e0')
    expect(decodeHtmlEntities('&Oslash; &oslash;')).toBe('\u00d8 \u00f8')
    expect(decodeHtmlEntities('&Alpha; &alpha; &Omega; &omega;')).toBe(
      '\u0391 \u03b1 \u03a9 \u03c9',
    )
    expect(decodeHtmlEntities('&Prime; &prime;')).toBe('\u2033 \u2032')
    expect(decodeHtmlEntities('&rarr; &rArr;')).toBe('\u2192 \u21d2')
    expect(decodeHtmlEntities('&Dagger; &dagger;')).toBe('\u2021 \u2020')
    // Non-existent case variant stays untouched
    expect(decodeHtmlEntities('&NBSP; &Emdash; &Apos;')).toBe('&NBSP; &Emdash; &Apos;')
  })

  it('decodes typography, currency, Latin-1/Extended, math, arrows, and symbols', () => {
    expect(
      decodeHtmlEntities('&lsquo;hi&rsquo; &ldquo;yo&rdquo; &ndash; &mdash; &hellip; &bull;'),
    ).toBe('\u2018hi\u2019 \u201cyo\u201d \u2013 \u2014 \u2026 \u2022')
    expect(decodeHtmlEntities('&euro;10 &pound;20 &yen;30 &cent;40')).toBe(
      '\u20ac10 \u00a320 \u00a530 \u00a240',
    )
    expect(decodeHtmlEntities('caf&eacute; na&iuml;ve &OElig;uvre &szlig; &ntilde;')).toBe(
      'caf\u00e9 na\u00efve \u0152uvre \u00df \u00f1',
    )
    expect(decodeHtmlEntities('&forall;x &isin; &real;: x &ne; &infin; &rArr; x &le; y &plusmn; 1')).toBe(
      '\u2200x \u2208 \u211c: x \u2260 \u221e \u21d2 x \u2264 y \u00b1 1',
    )
    expect(decodeHtmlEntities('&check; &cross; &hearts; &spades; &starf; &fjlig;')).toBe(
      '\u2713 \u2717 \u2665 \u2660 \u2605 fj',
    )
    expect(decodeHtmlEntities('a&ThickSpace;b')).toBe('a\u205f\u200ab')
  })

  it('decodes decimal and hexadecimal numeric entities including astral code points', () => {
    expect(decodeHtmlEntities('&#65;&#0066;&#x43;&#X44;')).toBe('ABCD')
    expect(decodeHtmlEntities('&#8364; &#x20ac; &#X20AC;')).toBe('\u20ac \u20ac \u20ac')
    // Astral plane (> 0xFFFF) via String.fromCodePoint
    expect(decodeHtmlEntities('&#128512; &#x1F680; &#x1d400;')).toBe('\u{1f600} \u{1f680} \u{1d400}')
    // Semicolon-less numeric entities
    expect(decodeHtmlEntities('&#65 &#x42')).toBe('A B')
  })

  it('remaps Windows-1252 C1 numeric references (0x80..0x9F) per WHATWG HTML5', () => {
    expect(decodeHtmlEntities('&#128;')).toBe('\u20ac') // €
    expect(decodeHtmlEntities('&#x80;')).toBe('\u20ac') // €
    expect(decodeHtmlEntities('&#133;')).toBe('\u2026') // …
    expect(decodeHtmlEntities('&#145;&#146;')).toBe('\u2018\u2019') // ‘’
    expect(decodeHtmlEntities('&#147;&#148;')).toBe('\u201c\u201d') // “”
    expect(decodeHtmlEntities('&#150;&#151;')).toBe('\u2013\u2014') // –—
    expect(decodeHtmlEntities('&#153;')).toBe('\u2122') // ™
    expect(decodeHtmlEntities('&#159;')).toBe('\u0178') // Ÿ
  })

  it('replaces null, surrogate, and out-of-range numeric code points with U+FFFD', () => {
    expect(decodeHtmlEntities('&#0;')).toBe('\ufffd')
    expect(decodeHtmlEntities('&#x0;')).toBe('\ufffd')
    expect(decodeHtmlEntities('&#55296;')).toBe('\ufffd') // 0xD800
    expect(decodeHtmlEntities('&#xDFFF;')).toBe('\ufffd')
    expect(decodeHtmlEntities('&#1114112;')).toBe('\ufffd') // 0x110000
    expect(decodeHtmlEntities('&#x110000;')).toBe('\ufffd')
    expect(decodeHtmlEntities('&#99999999999999999;')).toBe('\ufffd')
    expect(decodeHtmlEntities('&#xFFFFFFFFFFFFFFFF;')).toBe('\ufffd')
    expect(decodeNumericEntity(-1)).toBe('\ufffd')
    expect(decodeNumericEntity(Number.NaN)).toBe('\ufffd')
  })

  it('never double-decodes entities (single-pass)', () => {
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
    expect(decodeHtmlEntities('&amp;#65;')).toBe('&#65;')
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;')
    expect(decodeHtmlEntities('&amp;copy;')).toBe('&copy;')
  })

  it('preserves unknown, malformed, and prototype-property entity names untouched', () => {
    expect(decodeHtmlEntities('&unknownEntity; &foo;')).toBe('&unknownEntity; &foo;')
    expect(decodeHtmlEntities('&; &#; &#x; &#X; &#xZZ;')).toBe('&; &#; &#x; &#X; &#xZZ;')
    expect(decodeHtmlEntities('a & b &')).toBe('a & b &')
    expect(decodeHtmlEntities('&__proto__; &constructor; &toString; &hasOwnProperty;')).toBe(
      '&__proto__; &constructor; &toString; &hasOwnProperty;',
    )
    expect(lookupNamedEntity('__proto__')).toBeUndefined()
    expect(lookupNamedEntity('constructor')).toBeUndefined()
    expect(lookupNamedEntity('toString')).toBeUndefined()
  })

  it('handles legacy semicolon-less named entities in text vs attribute mode', () => {
    expect(HTML5_LEGACY_NAMED_ENTITIES.size).toBe(106)
    expect(Object.keys(HTML5_NAMED_ENTITIES).length).toBeGreaterThan(350)

    // Text mode: legacy entities delimited by non-alphanumeric decode
    expect(decodeHtmlEntities('&copy 2026')).toBe('\u00a9 2026')
    expect(decodeHtmlEntities('5 &lt 10 &amp 10 &gt 5')).toBe('5 < 10 & 10 > 5')
    expect(decodeHtmlEntities('caf&eacute!')).toBe('caf\u00e9!')

    // Non-legacy entities without semicolon do NOT decode
    expect(decodeHtmlEntities('&mdash &euro &check')).toBe('&mdash &euro &check')

    // Attribute mode: query params like &copy=2 and &reg=3 must NOT be mangled
    expect(
      decodeHtmlEntities('/search?a=1&copy=2&reg=3&amp;b=4', { attributeMode: true }),
    ).toBe('/search?a=1&copy=2&reg=3&b=4')
    expect(
      decodeHtmlEntities('/search?a=1&region=us&timestamp=99', { attributeMode: true }),
    ).toBe('/search?a=1&region=us&timestamp=99')
  })

  it('extractLitePageText decodes full HTML5 named and numeric entities', () => {
    const html = '<p>Price: &euro;49 &mdash; Caf&eacute; &#x1F680; &amp; Co.</p>'
    expect(extractLitePageText(html)).toBe('Price: \u20ac49 \u2014 Caf\u00e9 \u{1f680} & Co.')
  })

  describe('LiteBrowserEngine integration', () => {
    let server: http.Server | null = null
    let engine: LiteBrowserEngine | null = null

    afterEach(async () => {
      await engine?.close()
      engine = null
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        server = null
      }
    })

    it('decodes HTML5 entities in titles, blocks, links, attributes, textarea, and pre', async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Caf&eacute; &mdash; Pricing &amp; FAQ</title></head>
  <body>
    <h1>Plans &ndash; &euro;19/mo &copy; 2026</h1>
    <p>Visit <a href="/search?q=coffee&copy=1&amp;lang=en">Caf&eacute; Menu &rarr;</a> for &ldquo;fresh&rdquo; brews &#x1F680;.</p>
    <form action="/submit">
      <input name="note" value="A &amp; B &mdash; &#128;5" />
      <textarea name="bio">Line 1 &mdash; &lsquo;quoted&rsquo;&#10;Line 2 &check;</textarea>
    </form>
    <pre>&lt;div&gt;a &amp;&amp; b &le; c&lt;/div&gt;</pre>
  </body>
</html>`)
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as { port: number }
      const baseUrl = `http://127.0.0.1:${addr.port}`

      engine = new LiteBrowserEngine()
      const tab = await engine.createTab(`${baseUrl}/`)
      const snap = await tab.snapshot()

      expect(snap.title).toBe('Caf\u00e9 \u2014 Pricing & FAQ')
      expect(snap.blocks.some((b) => b.kind === 'heading' && b.text === 'Plans \u2013 \u20ac19/mo \u00a9 2026')).toBe(true)

      const link = snap.elements.find((e) => e.tag === 'a')
      expect(link?.text).toBe('Caf\u00e9 Menu \u2192')
      // Attribute-mode decoding preserved &copy=1 while decoding &amp;lang=en
      expect(link?.href).toBe(`${baseUrl}/search?q=coffee&copy=1&lang=en`)

      const input = snap.elements.find((e) => e.tag === 'input')
      expect(input?.value).toBe('A & B \u2014 \u20ac5')

      const textarea = snap.elements.find((e) => e.tag === 'textarea')
      expect(textarea?.value).toBe('Line 1 \u2014 \u2018quoted\u2019\nLine 2 \u2713')

      const codeBlock = snap.blocks.find((b) => b.kind === 'code')
      expect(codeBlock?.text).toBe('<div>a && b \u2264 c</div>')

      // waitFor text matching works with decoded HTML5 entities
      const waitRes = await tab.waitFor({ text: '\u20ac19/mo', timeoutMs: 500 })
      expect(waitRes.ok).toBe(true)
    })
  })
})
