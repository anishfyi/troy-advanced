import { describe, expect, it } from 'vitest'
import { renderRgbaToAscii } from '../src/ascii/pixels.js'
import type { DecodedPng } from '../src/ascii/png-decoder.js'

function makeRgba(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number, number],
): DecodedPng {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const idx = (y * width + x) * 4
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = a
    }
  }
  return { width, height, rgba }
}

function innerLines(framedAscii: string): string[] {
  const lines = framedAscii.split('\n')
  return lines.slice(1, -1).map((line) => line.slice(1, -1))
}

describe('Set-of-Marks bounding-box wireframe drawing (M10)', () => {
  it('draws a +--[e3]--+ wireframe rectangle around a clickable element while preserving interior pixels', () => {
    // 40x20 image, 1:1 with cols=40, rows=20: dark button interior at x=11..18, y=5..7
    const img = makeRgba(40, 20, (x, y) =>
      x >= 11 && x <= 18 && y >= 5 && y <= 7 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    )

    // Bounding box x=10..19 (width 10), y=4..8 (height 5)
    const out = renderRgbaToAscii(img, {
      width: 40,
      height: 20,
      mode: 'ascii',
      viewport: { width: 40, height: 20 },
      overlays: [{ ref: 'e3', box: { x: 10, y: 4, width: 10, height: 5 } }],
    })

    expect(/^[\x20-\x7e\n]+$/.test(out)).toBe(true)
    const rows = innerLines(out)

    expect(rows[4]!.slice(10, 20)).toBe('+--[e3]--+')
    expect(rows[5]!.slice(10, 20)).toBe('|@@@@@@@@|')
    expect(rows[6]!.slice(10, 20)).toBe('|@@@@@@@@|')
    expect(rows[7]!.slice(10, 20)).toBe('|@@@@@@@@|')
    expect(rows[8]!.slice(10, 20)).toBe('+--------+')

    // Exterior remains untouched white spaces
    expect(rows[3]!.trim()).toBe('')
    expect(rows[9]!.trim()).toBe('')
  })

  it('draws wireframe bounding boxes in Sobel edge mode as well', () => {
    const img = makeRgba(40, 16, () => [255, 255, 255, 255])
    const out = renderRgbaToAscii(img, {
      width: 40,
      height: 16,
      mode: 'edge',
      viewport: { width: 40, height: 16 },
      overlays: [{ ref: 'e5', box: { x: 4, y: 2, width: 10, height: 4 } }],
    })

    const rows = innerLines(out)
    expect(rows[2]!.slice(4, 14)).toBe('+--[e5]--+')
    expect(rows[3]!.slice(4, 14)).toBe('|        |')
    expect(rows[4]!.slice(4, 14)).toBe('|        |')
    expect(rows[5]!.slice(4, 14)).toBe('+--------+')
  })

  it('renders single-row elements as inline +--[eN]--+ bars when wide enough and keeps narrow badges intact', () => {
    const img = makeRgba(40, 12, () => [255, 255, 255, 255])
    const out = renderRgbaToAscii(img, {
      width: 40,
      height: 12,
      mode: 'ascii',
      viewport: { width: 40, height: 12 },
      overlays: [
        { ref: 'e1', box: { x: 2, y: 2, width: 10, height: 1 } },
        { ref: 'e12', box: { x: 20, y: 5, width: 2, height: 1 } },
        { ref: 'e99', box: { x: 38, y: 8, width: 2, height: 1 } },
      ],
    })

    const rows = innerLines(out)
    expect(rows[2]!.slice(2, 12)).toBe('+--[e1]--+')
    expect(rows[5]).toContain('[e12]')
    // Clamped inside right edge so [e99] is not truncated
    expect(rows[8]!.endsWith('[e99]')).toBe(true)
  })

  it('layers nested boxes largest-first and protects [eN] badges from overlapping borders', () => {
    const img = makeRgba(40, 16, () => [255, 255, 255, 255])
    // Pass small box first in input array to verify area sorting draws container first
    const out = renderRgbaToAscii(img, {
      width: 40,
      height: 16,
      mode: 'ascii',
      viewport: { width: 40, height: 16 },
      overlays: [
        { ref: 'e2', box: { x: 6, y: 4, width: 10, height: 4 } },
        { ref: 'e1', box: { x: 2, y: 2, width: 22, height: 10 } },
      ],
    })

    const rows = innerLines(out)
    expect(rows[2]).toContain('[e1]')
    expect(rows[2]![2]).toBe('+')
    expect(rows[2]![23]).toBe('+')
    expect(rows[4]!.slice(6, 16)).toBe('+--[e2]--+')
    expect(rows[7]!.slice(6, 16)).toBe('+--------+')
    expect(rows[11]![2]).toBe('+')
    expect(rows[11]![23]).toBe('+')
  })

  it('handles partially clipped viewport boxes cleanly and ignores completely off-screen overlays', () => {
    const img = makeRgba(30, 12, () => [255, 255, 255, 255])
    const out = renderRgbaToAscii(img, {
      width: 30,
      height: 12,
      mode: 'ascii',
      viewport: { width: 30, height: 12 },
      overlays: [
        // Partially off left edge: x=-4, width=14 => visible cols 0..9
        { ref: 'e4', box: { x: -4, y: 2, width: 14, height: 4 } },
        // Completely off-screen
        { ref: 'e9', box: { x: 40, y: 2, width: 10, height: 4 } },
        { ref: 'e8', box: { x: 5, y: -10, width: 10, height: 4 } },
      ],
    })

    const rows = innerLines(out)
    // Left edge was clipped so col 0 is '-', right corner at col 9 is '+'
    expect(rows[2]![0]).toBe('-')
    expect(rows[2]![9]).toBe('+')
    expect(rows[2]).toContain('[e4]')
    expect(rows[3]![9]).toBe('|')
    expect(rows[5]![0]).toBe('-')
    expect(rows[5]![9]).toBe('+')
    expect(out).not.toContain('[e9]')
    expect(out).not.toContain('[e8]')
  })

  it('supports overlayStyle="badge" for badge-only rendering without wireframe borders', () => {
    const img = makeRgba(30, 12, () => [255, 255, 255, 255])
    const out = renderRgbaToAscii(img, {
      width: 30,
      height: 12,
      mode: 'ascii',
      overlayStyle: 'badge',
      viewport: { width: 30, height: 12 },
      overlays: [{ ref: 'e3', box: { x: 6, y: 3, width: 12, height: 5 } }],
    })

    const rows = innerLines(out)
    expect(rows[3]!.slice(6, 10)).toBe('[e3]')
    // No box corners or borders drawn in badge mode
    expect(rows.join('')).not.toContain('+')
    expect(rows.join('')).not.toContain('|')
  })

  it('enforces strict 7-bit ASCII output even if overlay ref has non-ASCII characters', () => {
    const img = makeRgba(30, 10, () => [255, 255, 255, 255])
    const out = renderRgbaToAscii(img, {
      width: 30,
      height: 10,
      mode: 'ascii',
      viewport: { width: 30, height: 10 },
      overlays: [{ ref: 'e7\u2605', box: { x: 4, y: 2, width: 12, height: 4 } }],
    })

    expect(/^[\x20-\x7e\n]+$/.test(out)).toBe(true)
    expect(out).toContain('+---[e7]---+')
  })
})
