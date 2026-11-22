// Strict 7-bit ASCII sanitizer and ANSI escape sequence stripper.
// Neutralizes terminal escape injections (CSI, OSC, DCS/APC/PM/SOS, 2-byte ESC, 8-bit C1),
// bidi/RTL spoofing marks, zero-width/invisible formatting characters, and normalizes
// typographic punctuation, smart quotes, fullwidth ASCII, Latin diacritics, emoji, and CJK
// into guaranteed printable 7-bit ASCII (0x20..0x7E).

export interface SanitizeAsciiOptions {
  /** Preserve LF (`\n`) line breaks instead of collapsing them to spaces. Default: false. */
  preserveNewlines?: boolean
}

// Comprehensive terminal escape sequence pattern:
// 1. 7-bit OSC: ESC ] ... (BEL | ST | end-of-string)
// 2. 8-bit OSC: 0x9D ... (BEL | ST | 0x9C | end-of-string)
// 3. 7-bit DCS / SOS / PM / APC: ESC (P|X|^|_) ... (ST | BEL | end-of-string)
// 4. 8-bit DCS / SOS / PM / APC: (0x90|0x98|0x9E|0x9F) ... (ST | 0x9C | BEL | end-of-string)
// 5. 7-bit CSI: ESC [ params intermediates final
// 6. 8-bit CSI: 0x9B params intermediates final
// 7. 2-byte / nF ESC sequences: ESC intermediates final (e.g. ESC c, ESC ( B, ESC 7, ESC 8, ESC =, ESC M)
// 8. Any stray lone ESC byte
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x1b[PX^_][^\x1b\x07]*(?:\x1b\\|\x07|$)|[\x90\x98\x9e\x9f][^\x1b\x9c\x07]*(?:\x1b\\|\x9c|\x07|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|\x1b/g

// ZWJ emoji sequences (e.g. 👨‍👩‍👧‍👦, 👩‍💻) -> single placeholder
const EMOJI_ZWJ_SEQ_RE =
  /\p{Extended_Pictographic}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})?)+/gu

// Regional indicator flag pairs (e.g. 🇺🇸, 🇯🇵) -> single placeholder
const EMOJI_FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu

// Keycap emoji sequences (e.g. 1️⃣, #️⃣, *️⃣) -> preserve base ASCII digit/symbol
const EMOJI_KEYCAP_RE = /([0-9#*])\uFE0F?\u20E3/gu

// Single emoji with optional variation selector / skin-tone modifier
const EMOJI_SINGLE_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})?/gu

// Bidi/RTL marks, overrides, isolates, zero-width & invisible format chars,
// variation selectors, combining enclosing keycap, skin-tone modifiers, and Unicode tag chars
const INVISIBLE_AND_BIDI_RE =
  /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u20E3\uFE00-\uFE0F\uFEFF\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

// Combining diacritical marks (also neutralizes Zalgo stacked combining chars)
const COMBINING_MARKS_RE = /[\u0300-\u036f]+/g

// Latin-1 Supplement + Latin Extended-A/B + Latin Extended Additional
const LATIN_EXTENDED_RE = /[\u00C0-\u024F\u1E00-\u1EFF]/g

const SPECIAL_LATIN_MAP: Record<string, string> = {
  '\u00DF': 'ss', // ß
  '\u00C6': 'AE', // Æ
  '\u00E6': 'ae', // æ
  '\u00D8': 'O',  // Ø
  '\u00F8': 'o',  // ø
  '\u0141': 'L',  // Ł
  '\u0142': 'l',  // ł
  '\u0110': 'D',  // Đ
  '\u0111': 'd',  // đ
  '\u0152': 'OE', // Œ
  '\u0153': 'oe', // œ
  '\u00DE': 'TH', // Þ
  '\u00FE': 'th', // þ
  '\u00D0': 'D',  // Ð
  '\u00F0': 'd',  // ð
}

/**
 * Strip all ANSI/VT100/VT220/xterm terminal escape sequences (CSI, OSC 0/2/8/52,
 * DCS/SOS/PM/APC, 2-byte ESC, 8-bit C1 sequences, and stray ESC bytes).
 */
export function stripAnsi(input: string): string {
  if (!input) return ''
  return input.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Sanitize arbitrary untrusted Unicode/HTML/terminal text into strict printable 7-bit ASCII
 * (`0x20..0x7E`, plus `\n` when `preserveNewlines: true`).
 *
 * - Strips ANSI/terminal injection sequences cleanly (no leftover `[31m` fragments)
 * - Strips RTL/bidi spoofing marks (LRM/RLM/LRO/RLO/LRI/RLI/FSI/PDI) and zero-width chars
 * - Normalizes smart quotes, guillemets, dashes, ellipses, Unicode spaces, and fullwidth ASCII
 * - Transliterates Latin diacritics (`café` -> `cafe`) and strips Zalgo combining marks
 * - Collapses multi-codepoint emoji (ZWJ families, flags, skin tones) into a single `?`
 * - Replaces remaining non-ASCII code points (e.g. CJK ideographs, Kana, Hangul) with one `?` per code point
 */
export function sanitizeAscii(input: string, options: SanitizeAsciiOptions = {}): string {
  if (!input) return ''

  let out = stripAnsi(input)

  // Handle keycap emoji before stripping variation selectors / keycap combining mark
  out = out.replace(EMOJI_KEYCAP_RE, '$1')

  // Collapse multi-codepoint emoji clusters (ZWJ sequences, flags) into a single placeholder
  // before stripping ZWJ/variation selectors so 👨‍👩‍👧‍👦 becomes '?' instead of '????'.
  out = out.replace(EMOJI_ZWJ_SEQ_RE, '?')
  out = out.replace(EMOJI_FLAG_RE, '?')

  // Strip bidi/RTL overrides, zero-width chars, variation selectors, and Unicode tag chars
  out = out.replace(INVISIBLE_AND_BIDI_RE, '')

  // Normalize line breaks and control characters
  if (options.preserveNewlines) {
    out = out
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
  } else {
    out = out
      .replace(/[\r\n\t]+/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
  }

  // Normalize typographic punctuation, smart quotes, dashes, spaces, symbols, and CJK punctuation
  out = out
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/\u2039/g, '<')
    .replace(/\u203A/g, '>')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '*')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    // Fullwidth ASCII (U+FF01..U+FF5E) -> standard printable ASCII (0x21..0x7E)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // Common CJK punctuation
    .replace(/\u3001/g, ',')
    .replace(/\u3002/g, '.')
    .replace(/[\u300C\u300D\u300E\u300F]/g, '"')
    .replace(/\u3010/g, '[')
    .replace(/\u3011/g, ']')
    .replace(/[\u3008\u300A]/g, '<')
    .replace(/[\u3009\u300B]/g, '>')
    // Common typographic symbols
    .replace(/\u00A9/g, '(c)')
    .replace(/\u00AE/g, '(R)')
    .replace(/\u2122/g, '(TM)')
    .replace(/\u00D7/g, 'x')
    .replace(/\u00F7/g, '/')
    .replace(/\u2190/g, '<-')
    .replace(/\u2192/g, '->')
    .replace(/\u2194/g, '<->')

  // Transliterate Latin diacritics without touching CJK/Hangul
  out = out.replace(LATIN_EXTENDED_RE, (ch) => {
    const special = SPECIAL_LATIN_MAP[ch]
    if (special) return special
    return ch.normalize('NFKD').replace(COMBINING_MARKS_RE, '')
  })

  // Strip any remaining standalone combining diacritical marks (e.g. Zalgo text)
  out = out.replace(COMBINING_MARKS_RE, '')

  // Collapse remaining single emoji (including astral code points) into a single '?'
  out = out.replace(EMOJI_SINGLE_RE, '?')

  // Replace any remaining non-7-bit-ASCII Unicode code point (CJK, Kana, Hangul, Cyrillic,
  // Arabic, Hebrew, math symbols, etc.) with a single '?' per code point (not per UTF-16 surrogate).
  if (options.preserveNewlines) {
    out = out.replace(/[^\x20-\x7e\n]/gu, '?')
  } else {
    out = out.replace(/[^\x20-\x7e]/gu, '?')
  }

  return out
}

/**
 * Returns true if `input` contains exclusively printable 7-bit ASCII characters
 * (`0x20..0x7E`, plus `\n` when `allowNewlines` is true).
 */
export function isStrictAscii(input: string, options: { allowNewlines?: boolean } = {}): boolean {
  const allowNewlines = options.allowNewlines ?? true
  return allowNewlines ? /^[\x20-\x7e\n]*$/.test(input) : /^[\x20-\x7e]*$/.test(input)
}
