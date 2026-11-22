import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { computePageDelta } from '../src/agent/delta.js'
import {
  computeScrollbarGutter,
  hasMultiColumnLayout,
  humanizeFormName,
  parseAsciiDensity,
  renderAsciiForm,
  renderAsciiTable,
  renderDeltaAscii,
  renderPageAscii,
  renderSpatialBlocks,
  resolveDensityProfile,
  sanitizeAscii,
  wrapInlineParagraph,
} from '../src/ascii/layout.js'
import { decodePng } from '../src/ascii/png-decoder.js'
import { renderPngToAscii } from '../src/ascii/pixels.js'
import type { PageSnapshot } from '../src/types.js'

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function makeTestPng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 8-bit
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0 // filter None
    for (let x = 0; x < width; x++) {
      const dark = x < width / 2 ? 20 : 240
      const p = row + 1 + x * 4
      raw[p] = dark
      raw[p + 1] = dark
      raw[p + 2] = dark
      raw[p + 3] = 255
    }
  }
  const idat = deflateSync(raw)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

describe('ASCII spatial renderer & pure-Node PNG-to-ASCII', () => {
  it('renders strict 7-bit ASCII viewport with inline [eN] refs', () => {
    const snap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/dashboard',
      title: 'EC2 Ops — “Live”',
      epoch: 1,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 1600 },
      blocks: [
        { kind: 'heading', level: 1, text: 'Welcome to Troy Advanced' },
        { kind: 'paragraph', text: 'Run your AI browser right inside an SSH terminal.' },
        { kind: 'input', text: 'Query', value: 'us-east-1', ref: 'e1' },
        { kind: 'button', text: 'Run Check', ref: 'e2' },
        { kind: 'link', text: 'Docs', href: 'https://example.com/docs', ref: 'e3' },
      ],
      elements: [
        { ref: 'e1', selector: '#q', tag: 'input', type: 'text', text: 'Query', value: 'us-east-1' },
        { ref: 'e2', selector: '#go', tag: 'button', type: 'button', text: 'Run Check' },
        { ref: 'e3', selector: 'a.docs', tag: 'a', type: 'link', text: 'Docs', href: 'https://example.com/docs' },
      ],
      text: 'Welcome to Troy Advanced',
      capturedAt: Date.now(),
    }

    const ascii = renderPageAscii(snap, { width: 88, height: 26, asciiOnly: true })
    // Must contain only printable 7-bit ASCII and newlines
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('[e1]')
    expect(ascii).toContain('[e2]')
    expect(ascii).toContain('[e3]')
    expect(ascii).toContain('TROY-ADV')
    expect(sanitizeAscii('“Hello” — world…')).toBe('"Hello" - world...')
  })

  it('decodes synthetic PNG and renders ASCII, Braille, Halfblock, and Set-of-Marks overlays', () => {
    const png = makeTestPng(40, 20)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(40)
    expect(decoded.height).toBe(20)
    expect(decoded.rgba.length).toBe(40 * 20 * 4)

    const ascii = renderPngToAscii(png, {
      width: 30,
      height: 10,
      mode: 'ascii',
      overlays: [{ ref: 'e7', box: { x: 4, y: 4, width: 10, height: 4 } }],
      viewport: { width: 40, height: 20 },
    })
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('[e7]')

    const braille = renderPngToAscii(png, { width: 20, height: 8, mode: 'braille' })
    expect(braille.split('\n').length).toBe(8)

    const half = renderPngToAscii(png, { width: 16, height: 6, mode: 'halfblock' })
    expect(half).toContain('\x1b[38;2;')
  })

  it('renders true 2D spatial layout preserving header, sidebar, main content, and 3-column grid', () => {
    const snap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/app',
      title: 'Cloud Console',
      epoch: 2,
      viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        // Full-width top header
        { kind: 'heading', level: 1, text: 'Cloud Console', box: { x: 0, y: 0, width: 1200, height: 48 } },
        // Left sidebar links (x: 0..260)
        { kind: 'link', text: 'Instances', ref: 'e1', box: { x: 10, y: 80, width: 240, height: 28 } },
        { kind: 'link', text: 'Storage', ref: 'e2', box: { x: 10, y: 120, width: 240, height: 28 } },
        { kind: 'link', text: 'Billing', ref: 'e3', box: { x: 10, y: 160, width: 240, height: 28 } },
        // Main content column (x: 320..1180)
        { kind: 'heading', level: 2, text: 'Active Fleet', box: { x: 320, y: 80, width: 860, height: 32 } },
        {
          kind: 'paragraph',
          text: 'All production EC2 instances are healthy across us-east-1 and eu-west-1.',
          box: { x: 320, y: 120, width: 860, height: 48 },
        },
        // 3-column grid row (y: 220)
        { kind: 'button', text: 'CPU 12%', ref: 'e4', box: { x: 320, y: 220, width: 260, height: 36 } },
        { kind: 'button', text: 'MEM 44%', ref: 'e5', box: { x: 620, y: 220, width: 260, height: 36 } },
        { kind: 'button', text: 'DISK 8%', ref: 'e6', box: { x: 920, y: 220, width: 260, height: 36 } },
      ],
      elements: [
        { ref: 'e1', selector: '#nav1', tag: 'a', type: 'link', text: 'Instances' },
        { ref: 'e2', selector: '#nav2', tag: 'a', type: 'link', text: 'Storage' },
        { ref: 'e3', selector: '#nav3', tag: 'a', type: 'link', text: 'Billing' },
        { ref: 'e4', selector: '#c1', tag: 'button', type: 'button', text: 'CPU 12%' },
        { ref: 'e5', selector: '#c2', tag: 'button', type: 'button', text: 'MEM 44%' },
        { ref: 'e6', selector: '#c3', tag: 'button', type: 'button', text: 'DISK 8%' },
      ],
      text: 'Cloud Console',
      capturedAt: Date.now(),
    }

    expect(hasMultiColumnLayout(snap)).toBe(true)

    const ascii = renderPageAscii(snap, { width: 104, height: 30, asciiOnly: true, layout: 'spatial' })
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('layout:2d')

    const lines = ascii.split('\n')
    // Sidebar [e1] Instances and Main heading ## Active Fleet should be on the same row
    const sidebarMainLine = lines.find((l) => l.includes('[e1]') && l.includes('Active Fleet'))
    expect(sidebarMainLine).toBeDefined()
    expect(sidebarMainLine!.indexOf('[e1]')).toBeLessThan(sidebarMainLine!.indexOf('Active Fleet'))

    // All 3 grid cards should be placed side-by-side on the same row in left-to-right order
    const gridLine = lines.find((l) => l.includes('CPU 12%') && l.includes('MEM 44%') && l.includes('DISK 8%'))
    expect(gridLine).toBeDefined()
    expect(gridLine!.indexOf('CPU 12%')).toBeLessThan(gridLine!.indexOf('MEM 44%'))
    expect(gridLine!.indexOf('MEM 44%')).toBeLessThan(gridLine!.indexOf('DISK 8%'))

    // layout: 'auto' should also activate spatial mode for this multi-column page
    const autoAscii = renderPageAscii(snap, { width: 104, height: 30, asciiOnly: true, layout: 'auto' })
    expect(autoAscii).toContain('layout:2d')
    expect(autoAscii).toBe(ascii)
  })

  it('handles spatial fallback, element box inheritance, collision avoidance, and vertical gap compression', () => {
    // Single-column stacked blocks should NOT trigger auto spatial mode
    const singleCol: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/article',
      title: 'Article',
      epoch: 1,
      viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 2000 },
      blocks: [
        { kind: 'heading', level: 1, text: 'First', box: { x: 40, y: 20, width: 600, height: 32 } },
        // Intentionally overlapping Y in same column -> collision avoidance must push it below, not overwrite
        { kind: 'paragraph', text: 'Overlapping paragraph text', box: { x: 40, y: 24, width: 600, height: 32 } },
        // Huge 1200px vertical gap -> should be compressed, not 60 blank lines
        { kind: 'button', text: 'Footer Action', ref: 'e1' },
      ],
      elements: [
        // Block above has no box, so spatial renderer should inherit box from element e1
        { ref: 'e1', selector: '#f', tag: 'button', type: 'button', text: 'Footer Action', box: { x: 40, y: 1260, width: 200, height: 32 } },
      ],
      text: 'Article',
      capturedAt: Date.now(),
    }

    expect(hasMultiColumnLayout(singleCol)).toBe(false)
    const autoOut = renderPageAscii(singleCol, { width: 80, height: 24, asciiOnly: true, layout: 'auto' })
    expect(autoOut).not.toContain('layout:2d')

    const spatialLines = renderSpatialBlocks(singleCol, 76, true, false, true)
    expect(spatialLines).not.toBeNull()
    const joined = spatialLines!.join('\n')
    expect(joined).toContain('FIRST')
    expect(joined).toContain('Overlapping paragraph text')
    expect(joined).toContain('[e1] < Footer Action >')
    // Compressed output must stay compact (well under 15 rows despite y=1260)
    expect(spatialLines!.length).toBeLessThan(15)

    // Snapshot with zero boxes gracefully falls back to flow mode even when layout: 'spatial' is requested
    const noBoxSnap: PageSnapshot = {
      ...singleCol,
      blocks: [{ kind: 'paragraph', text: 'Plain flow text' }],
      elements: [],
    }
    expect(renderSpatialBlocks(noBoxSnap, 76, true, false, true)).toBeNull()
    const fallbackOut = renderPageAscii(noBoxSnap, { width: 80, height: 20, asciiOnly: true, layout: 'spatial' })
    expect(fallbackOut).toContain('Plain flow text')
    expect(fallbackOut).not.toContain('layout:2d')
  })

  it('renders ASCII tables with auto-column width alignment, borders (+---+), and header separator rows', () => {
    const rows = [
      { kind: 'table-row' as const, text: 'Instance | Region | Status', cells: ['Instance', 'Region', 'Status'], isHeader: true },
      { kind: 'table-row' as const, text: 'i-01a | us-east-1 | running', cells: ['i-01a', 'us-east-1', 'running'] },
      { kind: 'table-row' as const, text: 'i-02b | eu-west-1 | stopped', cells: ['i-02b', 'eu-west-1', 'stopped'] },
      // Ragged row with only 2 cells should be padded cleanly to 3 columns
      { kind: 'table-row' as const, text: 'i-03c | ap-south-1', cells: ['i-03c', 'ap-south-1'] },
    ]

    const lines = renderAsciiTable(rows, 80, { asciiOnly: true })
    expect(lines).toEqual([
      '+----------+------------+---------+',
      '| Instance | Region     | Status  |',
      '+==========+============+=========+',
      '| i-01a    | us-east-1  | running |',
      '| i-02b    | eu-west-1  | stopped |',
      '| i-03c    | ap-south-1 |         |',
      '+----------+------------+---------+',
    ])

    // Every line must be identical width and strict 7-bit ASCII
    const widths = new Set(lines.map((l) => l.length))
    expect(widths.size).toBe(1)
    expect(/^[\x20-\x7e\n]+$/.test(lines.join('\n'))).toBe(true)

    // Wide table shrinks widest column to fit maxWidth while wrapping cleanly
    const wideRows = [
      { kind: 'table-row' as const, text: 'ID | Description', cells: ['ID', 'Description'], isHeader: true },
      {
        kind: 'table-row' as const,
        text: '1 | Very long server description that must wrap cleanly inside narrow viewport',
        cells: ['1', 'Very long server description that must wrap cleanly inside narrow viewport'],
      },
    ]
    const narrowLines = renderAsciiTable(wideRows, 36, { asciiOnly: true })
    for (const line of narrowLines) {
      expect(line.length).toBeLessThanOrEqual(36)
    }
    expect(narrowLines[0]).toMatch(/^\+-+\+-+\+$/)
    expect(narrowLines[2]).toMatch(/^\+=+\+=+\+$/)
    // ID column stays intact (width 2) while Description wraps across multiple lines
    expect(narrowLines.some((l) => l.startsWith('| 1  |'))).toBe(true)
    expect(narrowLines.length).toBeGreaterThan(5)

    // Unicode box-drawing mode (asciiOnly: false)
    const uniLines = renderAsciiTable(rows.slice(0, 2), 60, { asciiOnly: false, color: false })
    expect(uniLines[0]).toMatch(/^┌─+┬─+┬─+┐$/)
    expect(uniLines[2]).toMatch(/^╞═+╪═+╪═+╡$/)
    expect(uniLines[uniLines.length - 1]).toMatch(/^└─+┴─+┴─+┘$/)

    // Flow page integration + Spatial 2D sidebar + table integration
    const spatialTableSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/fleet',
      title: 'Fleet Status',
      epoch: 1,
      viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, scrollHeight: 600 },
      blocks: [
        { kind: 'link', text: 'Overview', ref: 'e1', box: { x: 10, y: 40, width: 180, height: 28 } },
        { kind: 'link', text: 'Nodes', ref: 'e2', box: { x: 10, y: 80, width: 180, height: 28 } },
        { kind: 'table-row', text: 'Node | CPU', cells: ['Node', 'CPU'], isHeader: true, box: { x: 260, y: 40, width: 680, height: 28 } },
        { kind: 'table-row', text: 'web-1 | 18%', cells: ['web-1', '18%'], box: { x: 260, y: 70, width: 680, height: 28 } },
        { kind: 'table-row', text: 'web-2 | 42%', cells: ['web-2', '42%'], box: { x: 260, y: 100, width: 680, height: 28 } },
      ],
      elements: [
        { ref: 'e1', selector: '#a1', tag: 'a', type: 'link', text: 'Overview' },
        { ref: 'e2', selector: '#a2', tag: 'a', type: 'link', text: 'Nodes' },
      ],
      text: 'Fleet Status',
      capturedAt: Date.now(),
    }

    const spatialAscii = renderPageAscii(spatialTableSnap, { width: 92, height: 24, asciiOnly: true, layout: 'spatial' })
    expect(spatialAscii).toContain('+-------+-----+')
    expect(spatialAscii).toContain('| Node  | CPU |')
    expect(spatialAscii).toContain('+=======+=====+')
    expect(spatialAscii).toContain('| web-1 | 18% |')
    expect(spatialAscii).toContain('| web-2 | 42% |')
    expect(spatialAscii).toContain('[e1]')
  })

  it('wraps inline links inside paragraphs as [eN: link text] without forcing line breaks', () => {
    const lines = wrapInlineParagraph(
      'See the Troy Docs, or check the API Reference.',
      [
        { text: 'Troy Docs', ref: 'e1', href: 'https://example.com/docs' },
        { text: 'API Reference', ref: 'e2', href: 'https://example.com/api' },
      ],
      80,
      { asciiOnly: true, showRefs: true },
    )
    expect(lines).toEqual(['See the [e1: Troy Docs], or check the [e2: API Reference].'])

    // Narrow width wraps cleanly without splitting [e2: API Reference]. across lines
    const narrow = wrapInlineParagraph(
      'See the Troy Docs, or check the API Reference.',
      [
        { text: 'Troy Docs', ref: 'e1' },
        { text: 'API Reference', ref: 'e2' },
      ],
      36,
      { asciiOnly: true, showRefs: true },
    )
    expect(narrow).toEqual([
      'See the [e1: Troy Docs], or check',
      'the [e2: API Reference].',
    ])
    for (const l of narrow) expect(l.length).toBeLessThanOrEqual(36)

    // Duplicate link labels resolve sequentially to distinct refs
    const dupes = wrapInlineParagraph(
      'Click here for A or click here for B.',
      [
        { text: 'here', ref: 'e4' },
        { text: 'here', ref: 'e5' },
      ],
      80,
      { asciiOnly: true, showRefs: true },
    )
    expect(dupes).toEqual(['Click [e4: here] for A or click [e5: here] for B.'])

    // showRefs: false omits eN prefix
    const noRefs = wrapInlineParagraph(
      'Visit Troy Docs now.',
      [{ text: 'Troy Docs', ref: 'e1' }],
      80,
      { asciiOnly: true, showRefs: false },
    )
    expect(noRefs).toEqual(['Visit [Troy Docs] now.'])

    // Oversized link wider than maxWidth wraps cleanly without overflowing maxWidth
    const oversized = wrapInlineParagraph(
      'Read this extremely verbose documentation link carefully.',
      [{ text: 'this extremely verbose documentation link', ref: 'e9' }],
      24,
      { asciiOnly: true, showRefs: true },
    )
    expect(oversized.length).toBeGreaterThan(2)
    for (const l of oversized) expect(l.length).toBeLessThanOrEqual(24)

    // Full page render: inline links stay inline and are not duplicated under INTERACTIVE REFS
    const snap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/article',
      title: 'Inline Links',
      epoch: 1,
      viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, scrollHeight: 600 },
      blocks: [
        {
          kind: 'paragraph',
          text: 'Read the Troy Docs and API Reference to get started.',
          links: [
            { text: 'Troy Docs', ref: 'e1', href: 'https://example.com/docs' },
            { text: 'API Reference', ref: 'e2', href: 'https://example.com/api' },
          ],
        },
      ],
      elements: [
        { ref: 'e1', selector: 'a#docs', tag: 'a', type: 'link', text: 'Troy Docs', href: 'https://example.com/docs' },
        { ref: 'e2', selector: 'a#api', tag: 'a', type: 'link', text: 'API Reference', href: 'https://example.com/api' },
      ],
      text: 'Read the Troy Docs and API Reference to get started.',
      capturedAt: Date.now(),
    }

    const ascii = renderPageAscii(snap, { width: 88, height: 20, asciiOnly: true })
    expect(/^[\x20-\x7e\n]+$/.test(ascii)).toBe(true)
    expect(ascii).toContain('Read the [e1: Troy Docs] and [e2: API Reference] to get started.')
    expect(ascii).not.toContain('INTERACTIVE REFS:')
  })

  it('renders an ASCII scrollbar gutter (# thumb on | track) on the right edge of the viewport frame', () => {
    // 1. Direct unit checks on computeScrollbarGutter
    const fits = computeScrollbarGutter(10, 8, 10, 0, { asciiOnly: true })
    expect(fits.scrollable).toBe(false)
    expect(fits.thumbStart).toBe(-1)
    expect(fits.thumbSize).toBe(0)
    expect(fits.percent).toBe(100)
    expect(fits.chars.join('')).toBe('||||||||||')

    const top = computeScrollbarGutter(10, 50, 10, 0, { asciiOnly: true })
    expect(top.scrollable).toBe(true)
    expect(top.thumbStart).toBe(0)
    expect(top.thumbSize).toBe(2)
    expect(top.percent).toBe(0)
    expect(top.chars.join('')).toBe('##||||||||')

    const mid = computeScrollbarGutter(10, 50, 10, 20, { asciiOnly: true })
    expect(mid.thumbStart).toBe(4)
    expect(mid.thumbSize).toBe(2)
    expect(mid.percent).toBe(50)
    expect(mid.chars.join('')).toBe('||||##||||')

    const bot = computeScrollbarGutter(10, 50, 10, 40, { asciiOnly: true })
    expect(bot.thumbStart).toBe(8)
    expect(bot.thumbSize).toBe(2)
    expect(bot.percent).toBe(100)
    expect(bot.chars.join('')).toBe('||||||||##')

    // Extreme overflow clamps thumbSize to >= 1
    const huge = computeScrollbarGutter(10, 5000, 10, 0, { asciiOnly: true })
    expect(huge.thumbSize).toBe(1)
    expect(huge.chars.join('')).toBe('#|||||||||')

    // Barely overflowing clamps thumbSize to trackHeight - 1 so track stays visible
    const barely = computeScrollbarGutter(10, 11, 10, 0, { asciiOnly: true })
    expect(barely.thumbSize).toBe(9)
    expect(barely.chars.join('')).toBe('#########|')

    // Unicode mode uses full-block thumb on box-drawing track
    const uni = computeScrollbarGutter(6, 18, 6, 6, { asciiOnly: false, color: false })
    expect(uni.chars.join('')).toBe('││██││')

    // 2. Full renderPageAscii integration on a scrollable multi-screen page
    const longSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/long-doc',
      title: 'Long Document',
      epoch: 1,
      viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, scrollHeight: 600 },
      blocks: Array.from({ length: 40 }, (_, i) => ({
        kind: 'paragraph' as const,
        text: `Section line ${i + 1} with operational notes.`,
      })),
      elements: [],
      text: 'Long Document',
      capturedAt: Date.now(),
    }

    const extractViewportRightEdge = (rendered: string): string => {
      const lines = rendered.split('\n')
      // Chrome header is 4 lines (topBorder, tab, url, midBorder), footer is 3 lines (midBorder, status, botBorder)
      const viewportLines = lines.slice(4, lines.length - 3)
      return viewportLines.map((l) => l[l.length - 1] ?? '').join('')
    }

    const atTop = renderPageAscii(longSnap, { width: 80, height: 18, asciiOnly: true, scrollOffset: 0 })
    expect(/^[\x20-\x7e\n]+$/.test(atTop)).toBe(true)
    for (const line of atTop.split('\n')) expect(line.length).toBe(80)
    expect(atTop).toContain('scroll:0%')
    const topEdge = extractViewportRightEdge(atTop)
    expect(topEdge.length).toBe(12) // height 18 - 6 chrome rows
    expect(topEdge.startsWith('#')).toBe(true)
    expect(topEdge.endsWith('|')).toBe(true)
    expect(topEdge).toMatch(/^#+\|+$/)

    const atMid = renderPageAscii(longSnap, { width: 80, height: 18, asciiOnly: true, scrollOffset: 35 })
    const midEdge = extractViewportRightEdge(atMid)
    expect(midEdge.startsWith('|')).toBe(true)
    expect(midEdge.endsWith('|')).toBe(true)
    expect(midEdge).toContain('#')

    const atBottom = renderPageAscii(longSnap, { width: 80, height: 18, asciiOnly: true, scrollOffset: 999 })
    expect(atBottom).toContain('scroll:100%')
    const botEdge = extractViewportRightEdge(atBottom)
    expect(botEdge.startsWith('|')).toBe(true)
    expect(botEdge.endsWith('#')).toBe(true)
    expect(botEdge).toMatch(/^\|+#+$/)

    // Disabling scrollbar explicitly restores plain '|' frame border
    const noScrollbar = renderPageAscii(longSnap, {
      width: 80,
      height: 18,
      asciiOnly: true,
      scrollOffset: 0,
      showScrollbar: false,
    })
    expect(extractViewportRightEdge(noScrollbar)).toBe('|'.repeat(12))

    // 3. Short page that fits completely shows plain '|' track (no thumb)
    const shortSnap: PageSnapshot = {
      ...longSnap,
      blocks: [{ kind: 'paragraph', text: 'Fits in one screen.' }],
    }
    const shortOut = renderPageAscii(shortSnap, { width: 80, height: 18, asciiOnly: true })
    expect(shortOut).toContain('scroll:100%')
    expect(extractViewportRightEdge(shortOut)).toBe('|'.repeat(12))

    // 4. Browser DOM overflow fallback (e.g. Chromium page scrolled to 50%)
    const domScrollSnap: PageSnapshot = {
      ...shortSnap,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 400, scrollHeight: 1600 },
    }
    const domOut = renderPageAscii(domScrollSnap, { width: 80, height: 18, asciiOnly: true })
    expect(domOut).toContain('scroll:50%')
    const domEdge = extractViewportRightEdge(domOut)
    expect(domEdge).toContain('#')
    expect(domEdge).toContain('|')
    expect(domEdge.startsWith('|')).toBe(true)
    expect(domEdge.endsWith('|')).toBe(true)
  })

  it('renders form container grouping boxes (+-- Form: Login --+) in flow, spatial, and Unicode modes', () => {
    expect(humanizeFormName('login-form')).toBe('Login')
    expect(humanizeFormName('userSignupForm')).toBe('User Signup')
    expect(humanizeFormName('form-1')).toBeUndefined()

    // 1. Direct renderAsciiForm with explicit title
    const loginBlocks: PageSnapshot['blocks'] = [
      { kind: 'input', text: 'Email', value: 'ops@example.com', ref: 'e1', formId: 'form-1', formTitle: 'Login' },
      { kind: 'input', text: 'Password', value: '********', ref: 'e2', formId: 'form-1', formTitle: 'Login' },
      { kind: 'input', text: 'Remember me', tag: 'checkbox', checked: true, ref: 'e3', formId: 'form-1', formTitle: 'Login' },
      { kind: 'button', text: 'Sign In', ref: 'e4', formId: 'form-1', formTitle: 'Login' },
    ]
    const boxLines = renderAsciiForm(loginBlocks, 64, { asciiOnly: true })
    expect(boxLines.length).toBe(6) // top + 4 controls + bottom
    expect(boxLines[0]).toMatch(/^\+-- Form: Login -+\+$/)
    expect(boxLines[boxLines.length - 1]).toMatch(/^\+-+\+$/)
    const boxWidth = boxLines[0]!.length
    for (const line of boxLines) {
      expect(line.length).toBe(boxWidth)
      expect(/^[\x20-\x7e]+$/.test(line)).toBe(true)
    }
    expect(boxLines.join('\n')).toContain('[e1] Email:')
    expect(boxLines.join('\n')).toContain('[e2] Password:')
    expect(boxLines.join('\n')).toContain('[e3] [x] Remember me')
    expect(boxLines.join('\n')).toContain('[e4] < Sign In >')

    // 2. Title inference from submit button and untitled fallback
    const inferredLines = renderAsciiForm(
      [
        { kind: 'input', text: 'Query', ref: 'e1' },
        { kind: 'button', text: 'Search', ref: 'e2' },
      ],
      60,
      { asciiOnly: true },
    )
    expect(inferredLines[0]).toMatch(/^\+-- Form: Search -+\+$/)

    const untitledLines = renderAsciiForm(
      [
        { kind: 'input', text: 'First Name', ref: 'e1' },
        { kind: 'input', text: 'Last Name', ref: 'e2' },
      ],
      60,
      { asciiOnly: true },
    )
    expect(untitledLines[0]).toMatch(/^\+-- Form -+\+$/)

    // 3. Unicode mode
    const unicodeBox = renderAsciiForm(loginBlocks, 64, { asciiOnly: false, color: false })
    expect(unicodeBox[0]).toMatch(/^┌── Form: Login ─+┐$/)
    expect(unicodeBox[unicodeBox.length - 1]).toMatch(/^└─+┘$/)

    // 4. Flow page with two separate forms + standalone button (which must NOT be boxed)
    const flowSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/auth',
      title: 'Auth',
      epoch: 1,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        { kind: 'heading', level: 1, text: 'Account Access' },
        ...loginBlocks,
        { kind: 'input', text: 'Invite Code', ref: 'e5', formId: 'form-2', formTitle: 'Redeem' },
        { kind: 'button', text: 'Apply', ref: 'e6', formId: 'form-2', formTitle: 'Redeem' },
        { kind: 'button', text: 'Help', ref: 'e7' },
      ],
      elements: [],
      text: 'Account Access',
      capturedAt: Date.now(),
    }
    const flowAscii = renderPageAscii(flowSnap, { width: 84, height: 32, asciiOnly: true })
    expect(/^[\x20-\x7e\n]+$/.test(flowAscii)).toBe(true)
    expect(flowAscii).toContain('+-- Form: Login -')
    expect(flowAscii).toContain('+-- Form: Redeem -')
    expect(flowAscii).toContain('[e7] < Help >')
    expect(flowAscii).not.toContain('Form: Help')

    // 5. 2D spatial layout with hero column on left and Login form box on right
    const spatialSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://example.com/login',
      title: 'Portal Login',
      epoch: 1,
      viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        { kind: 'heading', level: 2, text: 'Welcome Back', box: { x: 20, y: 40, width: 420, height: 32 } },
        { kind: 'paragraph', text: 'Sign in to manage EC2 nodes.', box: { x: 20, y: 80, width: 420, height: 40 } },
        { kind: 'input', text: 'User', ref: 'e1', formId: 'form-1', formTitle: 'Login', box: { x: 540, y: 40, width: 520, height: 32 } },
        { kind: 'button', text: 'Login', ref: 'e2', formId: 'form-1', formTitle: 'Login', box: { x: 540, y: 80, width: 160, height: 32 } },
      ],
      elements: [],
      text: 'Portal Login',
      capturedAt: Date.now(),
    }
    const spatialAscii = renderPageAscii(spatialSnap, { width: 100, height: 24, asciiOnly: true, layout: 'spatial' })
    expect(/^[\x20-\x7e\n]+$/.test(spatialAscii)).toBe(true)
    expect(spatialAscii).toContain('layout:2d')
    const heroAndFormRow = spatialAscii.split('\n').find((l) => l.includes('Welcome Back') && l.includes('+-- Form: Login'))
    expect(heroAndFormRow).toBeDefined()
    expect(heroAndFormRow!.indexOf('Welcome Back')).toBeLessThan(heroAndFormRow!.indexOf('+-- Form: Login'))
  })

  it('supports compact, normal, and wide ASCII density profiles for LLM token budgets', () => {
    expect(parseAsciiDensity('compact')).toBe('compact')
    expect(parseAsciiDensity('normal')).toBe('normal')
    expect(parseAsciiDensity('wide')).toBe('wide')
    expect(parseAsciiDensity('huge')).toBeUndefined()
    expect(resolveDensityProfile('compact').defaultWidth).toBe(80)
    expect(resolveDensityProfile('normal').defaultWidth).toBe(100)
    expect(resolveDensityProfile('wide').defaultWidth).toBe(140)

    const richSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://ops.example.com/cluster',
      title: 'Cluster Ops',
      epoch: 3,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        { kind: 'heading', level: 1, text: 'Cluster Control' },
        {
          kind: 'paragraph',
          text:
            'This long operational overview explains multi-region failover across availability zones, ' +
            'automated health checks, zero-downtime rolling restarts, and detailed audit trails. ' +
            'See the Runbook and Escalation Policy for emergency procedures.',
          links: [
            { text: 'Runbook', ref: 'e1', href: 'https://ops.example.com/runbook' },
            { text: 'Escalation Policy', ref: 'e2', href: 'https://ops.example.com/escalation' },
          ],
        },
        { kind: 'table-row', isHeader: true, text: 'Node | State', cells: ['Node', 'State'] },
        { kind: 'table-row', text: 'ec2-1 | healthy', cells: ['ec2-1', 'healthy'] },
        { kind: 'input', text: 'Filter', value: 'prod', ref: 'e3', formId: 'form-1', formTitle: 'Filter Nodes' },
        { kind: 'button', text: 'Apply', ref: 'e4', formId: 'form-1', formTitle: 'Filter Nodes' },
        { kind: 'code', text: 'line1\nline2\nline3\nline4\nline5\nline6\nline7' },
      ],
      elements: [
        { ref: 'e1', selector: 'a.rb', tag: 'a', type: 'link', text: 'Runbook' },
        { ref: 'e2', selector: 'a.ep', tag: 'a', type: 'link', text: 'Escalation Policy' },
        { ref: 'e3', selector: '#flt', tag: 'input', type: 'text', text: 'Filter', value: 'prod' },
        { ref: 'e4', selector: '#go', tag: 'button', type: 'submit', text: 'Apply' },
      ],
      text: 'Cluster Control',
      capturedAt: Date.now(),
    }

    const compactOut = renderPageAscii(richSnap, { density: 'compact', asciiOnly: true })
    const normalOut = renderPageAscii(richSnap, { density: 'normal', asciiOnly: true })
    const defaultOut = renderPageAscii(richSnap, { asciiOnly: true })
    const wideOut = renderPageAscii(richSnap, { density: 'wide', asciiOnly: true })

    // Normal is 100% identical to default
    expect(normalOut).toBe(defaultOut)

    // Compact is strict 7-bit ASCII, drastically smaller for small LLM token budgets
    expect(/^[\x20-\x7e\n]+$/.test(compactOut)).toBe(true)
    expect(compactOut.length).toBeLessThan(normalOut.length * 0.4)
    expect(compactOut).toContain('[compact]')
    expect(compactOut).not.toContain('TROY-ADV')
    expect(compactOut).toContain('# Cluster Control')
    expect(compactOut).not.toContain('================')
    expect(compactOut).toContain('Node | State')
    expect(compactOut).not.toContain('+=======+')
    expect(compactOut).toContain('[Form: Filter Nodes]')
    expect(compactOut).not.toContain('+-- Form: Filter Nodes')
    // Code block truncated to 4 lines in compact mode
    expect(compactOut).toContain('| line4')
    expect(compactOut).not.toContain('| line5')
    // All interactive refs preserved even when long paragraph is collapsed
    expect(compactOut).toContain('[e1: Runbook]')
    expect(compactOut).toContain('[e2: Escalation Policy]')
    expect(compactOut).toContain('[e3]')
    expect(compactOut).toContain('[e4]')
    // No trailing spaces on any line in unframed compact mode
    for (const line of compactOut.split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''))
    }

    // Explicit showChrome: true with compact density keeps frame + density:compact status tag
    const framedCompact = renderPageAscii(richSnap, { density: 'compact', showChrome: true, asciiOnly: true })
    expect(framedCompact).toContain('TROY-ADV')
    expect(framedCompact).toContain('density:compact')
    expect(framedCompact).toContain('[Form: Filter Nodes]')

    // Wide density uses 140-col frame, taller viewport than normal, and density:wide status tag
    const wideLines = wideOut.split('\n')
    expect(wideLines[0]!.length).toBe(140)
    expect(wideLines.length).toBeGreaterThan(normalOut.split('\n').length)
    expect(wideOut).toContain('density:wide')
    expect(wideOut).toContain('| line7')

    // Wide density auto-enables 2D spatial layout on multi-column pages
    const multiColSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://ops.example.com/grid',
      title: 'Grid',
      epoch: 1,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        { kind: 'link', text: 'Nav', ref: 'e1', box: { x: 10, y: 20, width: 200, height: 30 } },
        { kind: 'heading', level: 2, text: 'Main Pane', box: { x: 300, y: 20, width: 600, height: 30 } },
      ],
      elements: [{ ref: 'e1', selector: 'a.nav', tag: 'a', type: 'link', text: 'Nav', box: { x: 10, y: 20, width: 200, height: 30 } }],
      text: 'Nav Main Pane',
      capturedAt: Date.now(),
    }
    const wideAuto = renderPageAscii(multiColSnap, { density: 'wide', asciiOnly: true })
    expect(wideAuto).toContain('layout:2d')
    expect(wideAuto).toContain('density:wide')
  })

  it('renders --since page deltas with +, -, and ~ markers in strict ASCII, compact, wide, and color modes', () => {
    const prevSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://ops.example.com/jobs',
      title: 'Jobs — Queue',
      epoch: 1,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [],
      elements: [
        { ref: 'e1', selector: '#status', tag: 'button', type: 'button', text: 'Idle', disabled: false },
        { ref: 'e2', selector: '#filter', tag: 'input', type: 'text', text: 'Filter', value: 'pending' },
        { ref: 'e3', selector: '#auto', tag: 'input', type: 'checkbox', text: 'Auto', checked: false },
        { ref: 'e4', selector: 'a.old', tag: 'a', type: 'link', text: 'Deprecated Link' },
      ],
      text: 'Jobs Queue\n2 pending jobs\nOld notice',
      capturedAt: 1000,
    }

    const nextSnap: PageSnapshot = {
      tabId: 1,
      url: 'https://ops.example.com/jobs?active=1',
      title: 'Jobs — Active',
      epoch: 2,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [],
      elements: [
        { ref: 'e1', selector: '#status', tag: 'button', type: 'button', text: 'Running', disabled: true },
        { ref: 'e2', selector: '#filter', tag: 'input', type: 'text', text: 'Filter', value: 'active' },
        { ref: 'e3', selector: '#auto', tag: 'input', type: 'checkbox', text: 'Auto', checked: true },
        { ref: 'e5', selector: 'button.cancel', tag: 'button', type: 'button', text: 'Cancel All 🚀' },
      ],
      text: 'Jobs Queue\n1 active job\nAll workers healthy',
      capturedAt: 2000,
    }

    // 1. Unchanged delta
    const unchangedDelta = computePageDelta(prevSnap, prevSnap)
    const unchangedAscii = renderDeltaAscii(unchangedDelta, { width: 84, asciiOnly: true })
    expect(/^[\x20-\x7e\n]+$/.test(unchangedAscii)).toBe(true)
    expect(unchangedAscii).toContain('TROY-ADV DELTA [NO CHANGES]')
    expect(unchangedAscii).toContain('(no changes since previous snapshot)')
    expect(unchangedAscii).toContain('+0 -0 ~0 elems | +0 -0 lines')

    // 2. Changed delta (normal framed mode)
    const delta = computePageDelta(prevSnap, nextSnap)
    expect(delta.changed).toBe(true)
    expect(delta.previousTitle).toBe('Jobs — Queue')

    const framed = renderDeltaAscii(delta, { width: 92, asciiOnly: true })
    expect(/^[\x20-\x7e\n]+$/.test(framed)).toBe(true)
    expect(framed).toContain('TROY-ADV DELTA [CHANGED]')
    expect(framed).toContain('~ URL: https://ops.example.com/jobs -> https://ops.example.com/jobs?active=1')
    expect(framed).toContain('~ TITLE: "Jobs - Queue" -> "Jobs - Active"')
    expect(framed).toContain('ELEMENTS (+1 -1 ~3):')
    expect(framed).toContain('+ [e5] <button> "Cancel All ??"')
    expect(framed).toContain('~ [e1] <button> text:"Idle"->"Running", disabled:false->true')
    expect(framed).toContain('~ [e2] <input> val:"pending"->"active"')
    expect(framed).toContain('~ [e3] <input> checked:false->true')
    expect(framed).toContain('- [e4] <a> "Deprecated Link"')
    expect(framed).toContain('TEXT (+2 -2):')
    expect(framed).toContain('+ 1 active job')
    expect(framed).toContain('+ All workers healthy')
    expect(framed).toContain('- 2 pending jobs')
    expect(framed).toContain('- Old notice')
    expect(framed).toContain('delta: +1 -1 ~3 elems | +2 -2 lines')

    // Every framed row matches exact requested width
    for (const line of framed.split('\n')) {
      expect(line.length).toBe(92)
    }

    // 3. Compact density (unframed, token-efficient)
    const compact = renderDeltaAscii(delta, { density: 'compact', asciiOnly: true })
    expect(/^[\x20-\x7e\n]+$/.test(compact)).toBe(true)
    expect(compact).toContain('[delta:CHANGED]')
    expect(compact).not.toContain('TROY-ADV DELTA')
    expect(compact.length).toBeLessThan(framed.length * 0.7)

    // 4. Truncation caps for large deltas
    const capped = renderDeltaAscii(delta, { width: 88, maxElements: 1, maxLines: 1, asciiOnly: true })
    expect(capped).toContain('~ ... (+2 more changed elements)')
    expect(capped).toContain('+ ... (+1 more added lines)')
    expect(capped).toContain('- ... (+1 more removed lines)')

    // 5. ANSI color mode (when asciiOnly: false)
    const colored = renderDeltaAscii(delta, { width: 92, asciiOnly: false, color: true })
    expect(colored).toContain('\x1b[32m') // green for +
    expect(colored).toContain('\x1b[31m') // red for -
    expect(colored).toContain('\x1b[33m') // yellow for ~
  })
})
