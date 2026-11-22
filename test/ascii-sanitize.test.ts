import { describe, expect, it } from 'vitest'
import { isStrictAscii, sanitizeAscii, stripAnsi } from '../src/ascii/sanitize.js'
import { renderPageAscii } from '../src/ascii/layout.js'
import { renderDeltaAscii } from '../src/ascii/delta.js'
import { renderMediaSummaryAscii } from '../src/ascii/media.js'
import { renderRgbaToAscii } from '../src/ascii/pixels.js'
import type { PageSnapshot } from '../src/types.js'
import type { PageDelta } from '../src/agent/delta.js'

describe('Strict 7-bit ASCII sanitizer (M13)', () => {
  describe('CJK, Hangul, Kana, fullwidth ASCII, and CJK punctuation', () => {
    it('replaces CJK ideographs, Hiragana, Katakana, and Hangul with 1 ? per code point', () => {
      // Chinese (4 code points)
      const zh = sanitizeAscii('你好世界')
      expect(zh).toBe('????')
      expect(isStrictAscii(zh, { allowNewlines: false })).toBe(true)

      // Japanese Kanji + Hiragana + Katakana
      const ja = sanitizeAscii('東京テストかな')
      expect(ja).toBe('???????')
      expect(isStrictAscii(ja, { allowNewlines: false })).toBe(true)

      // Korean Hangul must NOT explode via NFKD into Jamo (2 chars -> 2 ?, not 6 ?)
      const ko = sanitizeAscii('한글')
      expect(ko).toBe('??')
      expect(isStrictAscii(ko, { allowNewlines: false })).toBe(true)
    })

    it('normalizes fullwidth ASCII, ideographic space, and common CJK punctuation', () => {
      expect(sanitizeAscii('ＡＢＣ１２３！＠＃')).toBe('ABC123!@#')
      expect(sanitizeAscii('Hello\u3000World')).toBe('Hello World')
      expect(sanitizeAscii('「重要」、完了。')).toBe('"??",??.')
      expect(sanitizeAscii('【AWS】〈EC2〉')).toBe('[AWS]<EC2>')
      expect(isStrictAscii(sanitizeAscii('（テスト）：１００％'))).toBe(true)
      expect(sanitizeAscii('（テスト）：１００％')).toBe('(???):100%')
    })
  })

  describe('Emoji (astral surrogates, ZWJ sequences, flags, skin tones, keycaps)', () => {
    it('collapses single astral emoji to a single ? instead of UTF-16 surrogate pair ??', () => {
      expect(sanitizeAscii('Launch 🚀 now')).toBe('Launch ? now')
      expect(sanitizeAscii('🔥🎉✨')).toBe('???')
      expect(isStrictAscii(sanitizeAscii('Launch 🚀 now 🔥'))).toBe(true)
    })

    it('collapses ZWJ multi-person/profession emoji sequences to a single ?', () => {
      // Family ZWJ (11 UTF-16 code units) -> single '?'
      expect(sanitizeAscii('Family: 👨‍👩‍👧‍👦')).toBe('Family: ?')
      // Woman technologist ZWJ
      expect(sanitizeAscii('Dev: 👩‍💻')).toBe('Dev: ?')
      // Rainbow flag ZWJ
      expect(sanitizeAscii('Flag: 🏳️‍🌈')).toBe('Flag: ?')
    })

    it('handles skin-tone modifiers, regional flags, variation selectors, and keycaps', () => {
      expect(sanitizeAscii('OK 👍🏽')).toBe('OK ?')
      expect(sanitizeAscii('US 🇺🇸 JP 🇯🇵')).toBe('US ? JP ?')
      expect(sanitizeAscii('Love ❤️')).toBe('Love ?')
      expect(sanitizeAscii('Steps: 1️⃣ 2️⃣ #️⃣ *️⃣')).toBe('Steps: 1 2 # *')
    })
  })

  describe('RTL / Bidi control marks and Trojan Source spoofing', () => {
    it('strips LRM, RLM, ALM, bidi overrides (RLO/LRO), and bidi isolates without ? artifacts', () => {
      // Classic Trojan Source / filename spoofing using RLO (U+202E)
      const spoofed = 'invoice_\u202Efdp.exe'
      expect(sanitizeAscii(spoofed)).toBe('invoice_fdp.exe')

      // LRM, RLM, ALM
      expect(sanitizeAscii('left\u200Eright\u200Farabic\u061Cend')).toBe('leftrightarabicend')

      // LRE, RLE, PDF, LRO, RLO
      expect(sanitizeAscii('\u202Ahello\u202Bworld\u202C\u202D!\u202E')).toBe('helloworld!')

      // Bidi isolates LRI, RLI, FSI, PDI
      expect(sanitizeAscii('\u2066user\u2069 \u2067admin\u2069 \u2068ok\u2069')).toBe('user admin ok')
    })

    it('handles mixed RTL Arabic/Hebrew with ASCII and bidi marks cleanly', () => {
      const mixed = 'Status: \u200Fمرحبا\u200E (OK) \u202Bשלום\u202C'
      const out = sanitizeAscii(mixed)
      expect(isStrictAscii(out, { allowNewlines: false })).toBe(true)
      expect(out).toBe('Status: ????? (OK) ????')
    })
  })

  describe('Smart quotes, typographic punctuation, Latin diacritics, and Zalgo', () => {
    it('normalizes smart quotes, guillemets, dashes, ellipses, bullets, and spaces', () => {
      expect(sanitizeAscii('“Hello” — ‘world’…')).toBe('"Hello" - \'world\'...')
      expect(sanitizeAscii('«Bonjour» ‹ami›')).toBe('"Bonjour" <ami>')
      expect(sanitizeAscii('a\u2010b\u2011c\u2012d\u2013e\u2014f\u2212g')).toBe('a-b-c-d-e-f-g')
      expect(sanitizeAscii('• Item 1\u00A0\u2009\u200A\u202FItem 2')).toBe('* Item 1    Item 2')
      expect(sanitizeAscii('© 2026 Troy™ ® 2×3÷1 ← → ↔')).toBe('(c) 2026 Troy(TM) (R) 2x3/1 <- -> <->')
    })

    it('transliterates Latin diacritics and strips Zalgo combining marks', () => {
      expect(sanitizeAscii('café naïve über résumé')).toBe('cafe naive uber resume')
      expect(sanitizeAscii('Straße Æther œuvre Łódź')).toBe('Strasse AEther oeuvre Lodz')
      // Zalgo text with stacked combining marks
      const zalgo = 'h\u0337\u0301e\u0338\u0308l\u0336l\u0335o\u0334\u0303'
      expect(sanitizeAscii(zalgo)).toBe('hello')
    })
  })

  describe('Zero-width characters and invisible Unicode smuggling', () => {
    it('strips ZWSP, ZWNJ, ZWJ, BOM, soft hyphen, word joiner, variation selectors, and Unicode tags', () => {
      const invisible =
        '\uFEFFhe\u200Bll\u200Co\u200D\u00AD\u2060\u2061\u2062\u2063\u2064\u034F\u180E\uFE0F world'
      expect(sanitizeAscii(invisible)).toBe('hello world')

      // Unicode Tag characters (U+E0020..U+E007F) used for invisible prompt-injection smuggling
      const smuggled = 'Safe text\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} end'
      expect(sanitizeAscii(smuggled)).toBe('Safe text end')
    })
  })

  describe('ANSI & terminal escape sequence injection stripping', () => {
    it('strips SGR colors, cursor controls, screen clears, and private modes with zero leftover fragments', () => {
      expect(stripAnsi('\x1b[31mRED\x1b[0m')).toBe('RED')
      expect(sanitizeAscii('\x1b[1;38;2;255;0;0mAlert\x1b[0m')).toBe('Alert')
      expect(sanitizeAscii('\x1b[2J\x1b[H\x1b[?25lHidden\x1b[?1049h')).toBe('Hidden')
      expect(sanitizeAscii('Query\x1b[6n\x1b[cDone')).toBe('QueryDone')
    })

    it('strips OSC 0/2 title spoofing, OSC 8 hyperlinks, OSC 52 clipboard exfiltration, and unterminated OSC', () => {
      expect(sanitizeAscii('\x1b]0;PWNED TITLE\x07Normal')).toBe('Normal')
      expect(sanitizeAscii('\x1b]2;EVIL\x1b\\Normal')).toBe('Normal')
      expect(sanitizeAscii('\x1b]8;;https://evil.example\x07Click Here\x1b]8;;\x07')).toBe('Click Here')
      expect(sanitizeAscii('Before\x1b]52;c;cHduZWQ=\x07After')).toBe('BeforeAfter')
      // Unterminated OSC at end of string
      expect(sanitizeAscii('Safe\x1b]0;unterminated')).toBe('Safe')
    })

    it('strips DCS/APC/PM/SOS, 2-byte ESC, 8-bit C1 CSI/OSC, stray ESC, and C0/C1 control bytes', () => {
      expect(sanitizeAscii('\x1bP1$r0m\x1b\\OK')).toBe('OK')
      expect(sanitizeAscii('\x1b_Gpayload\x1b\\OK')).toBe('OK')
      expect(sanitizeAscii('\x1bcReset\x1b7\x1b8\x1b(B')).toBe('Reset')
      expect(sanitizeAscii('\x9b31mC1-CSI\x9b0m')).toBe('C1-CSI')
      expect(sanitizeAscii('\x9d0;C1-OSC\x9cClean')).toBe('Clean')
      expect(sanitizeAscii('a\x00b\x07c\x08d\x7fe\x1b')).toBe('abcde')
    })

    it('supports preserveNewlines option cleanly', () => {
      expect(sanitizeAscii('line1\r\nline2\tcol')).toBe('line1 line2 col')
      expect(sanitizeAscii('line1\r\nline2\tcol', { preserveNewlines: true })).toBe('line1\nline2 col')
      expect(isStrictAscii('line1\nline2', { allowNewlines: true })).toBe(true)
      expect(isStrictAscii('line1\nline2', { allowNewlines: false })).toBe(false)
    })
  })

  describe('End-to-end strict 7-bit ASCII invariants across all renderers', () => {
    const hostileSnapshot: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/\x1b]0;PWNED\x07café/東京',
      title: '\x1b[31m“Troy” — 日本語 🚀\u202E\u200B\x1b[0m',
      epoch: 1,
      viewport: { width: 1024, height: 768, scrollX: 0, scrollY: 0, scrollHeight: 768 },
      blocks: [
        { kind: 'heading', level: 1, text: '\x1b[2J\x1b[HWelcome 👨‍👩‍👧‍👦 café\u200B' },
        {
          kind: 'paragraph',
          text: 'Visit \x1b]8;;https://evil.test\x07“Docs”\x1b]8;;\x07 — 東京 1️⃣\u202E',
          inlineLinks: [{ text: '“Docs”', href: 'https://example.com/docs', ref: 'e1' }],
        },
        { kind: 'input', text: 'Search\u200B', value: 'ＡＢＣ\x1b]52;c;ZGF0YQ==\x07', ref: 'e2' },
        { kind: 'button', text: 'Go 🚀\uFEFF', ref: 'e3' },
        {
          kind: 'image',
          text: 'Chart \x1b[31m売上\x1b[0m 👍🏽',
          src: 'https://example.com/chart.png',
          width: 400,
          height: 200,
          box: { x: 10, y: 200, width: 400, height: 200 },
        },
      ],
      elements: [
        { ref: 'e1', selector: 'a', tag: 'a', type: 'link', text: '“Docs”' },
        { ref: 'e2', selector: 'input', tag: 'input', type: 'text', text: 'Search', value: 'ＡＢＣ' },
        { ref: 'e3', selector: 'button', tag: 'button', type: 'button', text: 'Go 🚀' },
      ],
      text: 'Hostile page',
      capturedAt: Date.now(),
    }

    it('renders hostile snapshot in strict 7-bit ASCII via renderPageAscii with zero ANSI residue', () => {
      const out = renderPageAscii(hostileSnapshot, { width: 92, height: 28, asciiOnly: true })
      expect(isStrictAscii(out)).toBe(true)
      expect(out).not.toContain('\x1b')
      expect(out).not.toContain('[31m')
      expect(out).not.toContain('[2J')
      expect(out).not.toContain('PWNED')
      expect(out).not.toContain('ZGF0YQ==')
      expect(out).toContain('WELCOME ? CAFE')
      expect(out).toContain('ABC')
      expect(out).toContain('[e1]')
      expect(out).toContain('[e2]')
      expect(out).toContain('[e3]')
    })

    it('strips hostile page ANSI injections even when asciiOnly is false and color is true', () => {
      const out = renderPageAscii(hostileSnapshot, { width: 92, height: 28, asciiOnly: false, color: true })
      // Our own SGR color codes may be present, but hostile OSC 0 / OSC 52 / CSI 2J from page must be gone
      expect(out).not.toContain('PWNED')
      expect(out).not.toContain('ZGF0YQ==')
      expect(out).not.toContain('\x1b[2J')
      expect(out).not.toContain('\x1b]8;;')
    })

    it('renders hostile delta and media summary in strict 7-bit ASCII', () => {
      const delta: PageDelta = {
        changed: true,
        tabId: 1,
        url: hostileSnapshot.url,
        title: hostileSnapshot.title,
        epoch: 2,
        previousEpoch: 1,
        urlChanged: true,
        titleChanged: true,
        addedElements: [
          { ref: 'e4', selector: '#x', tag: 'button', type: 'button', text: '\x1b[31mSave 🚀\u202E\x1b[0m' },
        ],
        removedElements: [],
        changedElements: [],
        addedLines: ['\x1b]0;EVIL\x07New “item” — 東京\u200B'],
        removedLines: [],
        summary: 'updated',
      }

      const deltaOut = renderDeltaAscii(delta, { width: 88, asciiOnly: true })
      expect(isStrictAscii(deltaOut)).toBe(true)
      expect(deltaOut).not.toContain('EVIL')
      expect(deltaOut).not.toContain('[31m')
      expect(deltaOut).toContain('Save ?')

      const mediaOut = renderMediaSummaryAscii(hostileSnapshot, { width: 88, asciiOnly: true })
      expect(isStrictAscii(mediaOut)).toBe(true)
      expect(mediaOut).not.toContain('[31m')
      expect(mediaOut).toContain('Chart ?? ?')
    })

    it('strips ANSI injection from Set-of-Marks overlay refs in renderRgbaToAscii', () => {
      const rgba = new Uint8Array(30 * 10 * 4).fill(255)
      const out = renderRgbaToAscii(
        { width: 30, height: 10, rgba },
        {
          width: 30,
          height: 10,
          mode: 'ascii',
          viewport: { width: 30, height: 10 },
          overlays: [{ ref: 'e9\x1b[31m🚀', box: { x: 4, y: 2, width: 12, height: 4 } }],
        },
      )
      expect(isStrictAscii(out)).toBe(true)
      expect(out).not.toContain('[31m')
      expect(out).toContain('+---[e9]---+')
    })
  })
})
