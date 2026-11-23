import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LiteBrowserEngine,
  detectCsvDelimiter,
  detectDocumentKind,
  parseCsvData,
  parseCsvRows,
  renderCsvDocument,
  renderMarkdownDocument,
  renderPageAscii,
  renderPlainTextDocument,
} from '../src/index.js'

describe('M41: Plain-text / Markdown / CSV document renderer (unit)', () => {
  describe('detectDocumentKind', () => {
    it('detects markdown, csv/tsv, and plain text by MIME type', () => {
      expect(detectDocumentKind('text/markdown; charset=utf-8', '', 'https://example.com/doc')).toBe('markdown')
      expect(detectDocumentKind('text/x-markdown', '', 'https://example.com/doc')).toBe('markdown')
      expect(detectDocumentKind('text/csv; charset=utf-8', '', 'https://example.com/export')).toBe('csv')
      expect(detectDocumentKind('text/tab-separated-values', '', 'https://example.com/export')).toBe('csv')
      expect(detectDocumentKind('text/plain; charset=utf-8', '', 'https://example.com/robots.txt')).toBe('text')
    })

    it('detects markdown and csv from URL extension when served as text/plain (e.g. raw GitHub)', () => {
      expect(
        detectDocumentKind('text/plain; charset=utf-8', '# Hello', 'https://raw.githubusercontent.com/org/repo/main/README.md'),
      ).toBe('markdown')
      expect(
        detectDocumentKind('text/plain', 'a,b\n1,2', 'https://example.com/files/metrics.csv'),
      ).toBe('csv')
      expect(
        detectDocumentKind('text/plain', 'a\tb\n1\t2', 'https://example.com/files/metrics.tsv'),
      ).toBe('csv')
    })

    it('never hijacks text/html or application/xhtml+xml responses', () => {
      expect(detectDocumentKind('text/html; charset=utf-8', '<h1>Hi</h1>', 'https://example.com/README.md')).toBeNull()
      expect(detectDocumentKind('application/xhtml+xml', '<html/>', 'https://example.com/data.csv')).toBeNull()
    })
  })

  describe('RFC 4180 CSV / TSV parsing', () => {
    it('parses quoted fields, escaped quotes, embedded commas/newlines, CRLF, and BOM', () => {
      const raw = '\uFEFFName,Notes,Score\r\n"Alice, A.","Says ""hello""\nworld",98.5\r\nBob,Plain,100\r\n'
      const rows = parseCsvRows(raw, ',')
      expect(rows).toEqual([
        ['Name', 'Notes', 'Score'],
        ['Alice, A.', 'Says "hello"\nworld', '98.5'],
        ['Bob', 'Plain', '100'],
      ])

      const parsed = parseCsvData(raw, 'text/csv', 'https://example.com/scores.csv')
      expect(parsed.delimiter).toBe(',')
      expect(parsed.headers).toEqual(['Name', 'Notes', 'Score'])
      expect(parsed.rows).toEqual([
        ['Alice, A.', 'Says "hello" world', '98.5'],
        ['Bob', 'Plain', '100'],
      ])
    })

    it('auto-detects tab and semicolon delimiters', () => {
      expect(detectCsvDelimiter('text/tab-separated-values', 'a\tb\n1\t2', 'https://example.com/data')).toBe('\t')
      expect(detectCsvDelimiter('text/plain', 'a\tb\n1\t2', 'https://example.com/data.tsv')).toBe('\t')
      expect(detectCsvDelimiter('text/csv', 'city;pop;rank\nNYC;8800000;1\nLA;3900000;2', 'https://example.com/cities.csv')).toBe(';')
    })

    it('sorts numeric columns numerically and paginates rows', () => {
      const csv = 'item,price\nApple,100\nBanana,20\nCherry,3\nDate,50\n'
      const asc = renderCsvDocument(csv, 'https://example.com/prices.csv', 'text/csv', {
        sortColumn: 1,
        sortDirection: 'asc',
      })
      const ascRows = asc.blocks.filter((b) => b.kind === 'table-row' && !b.isHeader).map((b) => b.cells)
      expect(ascRows).toEqual([
        ['Cherry', '3'],
        ['Banana', '20'],
        ['Date', '50'],
        ['Apple', '100'],
      ])

      const desc = renderCsvDocument(csv, 'https://example.com/prices.csv', 'text/csv', {
        sortColumn: 1,
        sortDirection: 'desc',
      })
      const descRows = desc.blocks.filter((b) => b.kind === 'table-row' && !b.isHeader).map((b) => b.cells)
      expect(descRows[0]).toEqual(['Apple', '100'])
      expect(descRows[3]).toEqual(['Cherry', '3'])

      const paged = renderCsvDocument(csv, 'https://example.com/prices.csv', 'text/csv', {
        page: 1,
        pageSize: 2,
      })
      expect(paged.page).toBe(1)
      expect(paged.totalPages).toBe(2)
      const pagedRows = paged.blocks.filter((b) => b.kind === 'table-row' && !b.isHeader).map((b) => b.cells)
      expect(pagedRows).toEqual([
        ['Cherry', '3'],
        ['Date', '50'],
      ])
    })
  })

  describe('Markdown document rendering', () => {
    it('renders frontmatter, headings, code blocks, GFM tables, lists, tasks, and safe inline links', () => {
      const md = [
        '---',
        'title: "Troy Guide"',
        'author: Anish',
        '---',
        '',
        '# Overview',
        '',
        'Read the [API docs](/docs/api.md) or visit <https://example.org/spec>.',
        'Ignore [evil](javascript:alert(1)) links.',
        '',
        '| Engine | Mode |',
        '| --- | --- |',
        '| Lite | Zero-Chrome |',
        '| Chromium | Full CDP |',
        '',
        '- [x] Ship M40',
        '- [ ] Ship M41',
        '',
        '> Quoted note with **bold** and `code`.',
        '',
        '```ts',
        'const x = 42',
        '```',
      ].join('\n')

      const view = renderMarkdownDocument(md, 'https://example.com/guide/README.md')
      expect(view.kind).toBe('markdown')
      expect(view.title).toBe('Troy Guide')

      const headings = view.blocks.filter((b) => b.kind === 'heading')
      expect(headings.some((h) => h.level === 1 && h.text === 'Overview')).toBe(true)

      const tableRows = view.blocks.filter((b) => b.kind === 'table-row')
      expect(tableRows.length).toBe(3)
      expect(tableRows[0]!.isHeader).toBe(true)
      expect(tableRows[0]!.cells).toEqual(['Engine', 'Mode'])
      expect(tableRows[1]!.cells).toEqual(['Lite', 'Zero-Chrome'])

      const listItems = view.blocks.filter((b) => b.kind === 'list-item').map((b) => b.text)
      expect(listItems).toContain('[x] Ship M40')
      expect(listItems).toContain('[ ] Ship M41')

      const codeBlocks = view.blocks.filter((b) => b.kind === 'code')
      expect(codeBlocks.some((c) => c.text.includes('const x = 42'))).toBe(true)

      const links = view.elements.filter((e) => e.tag === 'a')
      expect(links.map((l) => l.href)).toEqual([
        'https://example.com/docs/api.md',
        'https://example.org/spec',
      ])
      expect(links.some((l) => l.href?.startsWith('javascript:'))).toBe(false)
    })
  })

  describe('Plain-text document rendering', () => {
    it('paginates long plain text, sanitizes ASCII, and auto-detects clickable URLs', () => {
      const lines = Array.from({ length: 150 }, (_, i) => `Line ${i + 1}: hello — world`)
      lines[2] = 'See https://example.com/status and http://example.org/info.'
      const body = lines.join('\n')

      const p0 = renderPlainTextDocument(body, 'https://example.com/notes.txt')
      expect(p0.page).toBe(0)
      expect(p0.totalPages).toBe(2)
      expect(p0.meta.lines).toBe(150)
      expect(p0.elements.some((e) => e.selector === 'doc-page:next')).toBe(true)
      expect(p0.elements.some((e) => e.selector === 'doc-page:prev')).toBe(false)
      expect(p0.elements.filter((e) => e.tag === 'a').map((e) => e.href)).toEqual([
        'https://example.com/status',
        'http://example.org/info',
      ])

      const p1 = renderPlainTextDocument(body, 'https://example.com/notes.txt', { page: 1 })
      expect(p1.page).toBe(1)
      expect(p1.text).toContain('Line 150')
      expect(p1.elements.some((e) => e.selector === 'doc-page:prev')).toBe(true)
      expect(p1.elements.some((e) => e.selector === 'doc-page:next')).toBe(false)
    })
  })
})

describe('M41: LiteBrowserEngine integration (Markdown, CSV, Plain Text)', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    const bigCsvRows = ['id,name,score']
    for (let i = 1; i <= 65; i++) {
      bigCsvRows.push(`${i},User_${i},${(i * 17) % 100}`)
    }
    const bigTextLines = Array.from({ length: 145 }, (_, i) =>
      i === 3 ? 'Link to Markdown: {{BASE}}/docs/README.md' : `Log entry #${i + 1}: ok`,
    )

    server = http.createServer((req, res) => {
      const reqPath = (req.url ?? '/').split('?')[0]

      if (reqPath === '/docs/README.md') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(
          [
            '# Project README',
            '',
            'Jump to [Metrics CSV](/data/metrics.csv) or [Target HTML](/target.html).',
            '',
            '| Component | Status |',
            '| --- | --- |',
            '| Parser | Ready |',
            '| Renderer | Ready |',
          ].join('\n'),
        )
        return
      }

      if (reqPath === '/data/metrics.csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' })
        res.end(bigCsvRows.join('\n'))
        return
      }

      if (reqPath === '/logs/app.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(bigTextLines.join('\n').replace('{{BASE}}', baseUrl))
        return
      }

      if (reqPath === '/target.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>HTML Target</title></head><body><h1>Reached HTML</h1></body></html>')
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('renders Markdown served as text/plain, supports Raw Text toggle, and navigates via Markdown links', async () => {
    const engine = new LiteBrowserEngine()
    const tab = await engine.createTab(`${baseUrl}/docs/README.md`)
    const snap = await tab.snapshot()

    expect(snap.title).toBe('Project README')
    expect(snap.blocks.some((b) => b.kind === 'table-row' && b.isHeader)).toBe(true)

    const ascii = renderPageAscii(snap, { cols: 90, asciiOnly: true })
    expect(ascii).toContain('Project README')
    expect(ascii).toContain('Component')
    expect(ascii).toContain('Renderer')
    // Ensure strict 7-bit ASCII
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(ascii)).toBe(true)

    // Toggle to Raw Text view and back
    const rawRes = await tab.click('doc-action:raw-text')
    expect(rawRes.ok).toBe(true)
    const rawSnap = await tab.snapshot()
    expect(rawSnap.title).toContain('Raw MARKDOWN')
    expect(rawSnap.text).toContain('# Project README')

    const fmtRes = await tab.click('doc-action:formatted')
    expect(fmtRes.ok).toBe(true)
    const fmtSnap = await tab.snapshot()
    expect(fmtSnap.title).toBe('Project README')

    // Click Markdown link to /target.html
    const htmlLink = fmtSnap.elements.find((e) => e.href === `${baseUrl}/target.html`)
    expect(htmlLink).toBeDefined()
    const navRes = await tab.click(htmlLink!.selector)
    expect(navRes.ok).toBe(true)
    expect(tab.getTitle()).toBe('HTML Target')
  })

  it('renders CSV as aligned ASCII table with interactive sorting and pagination', async () => {
    const engine = new LiteBrowserEngine()
    const tab = await engine.createTab(`${baseUrl}/data/metrics.csv`)
    const snap = await tab.snapshot()

    expect(snap.title).toContain('CSV: metrics.csv (65 rows x 3 cols)')
    const ascii = renderPageAscii(snap, { cols: 90, asciiOnly: true })
    expect(ascii).toContain('+---')
    expect(ascii).toContain('User_1')
    expect(ascii).toContain('User_15')
    expect(snap.text).toContain('User_50')
    expect(snap.text).not.toContain('User_65')

    // Paginate to page 2
    const nextRes = await tab.click('doc-page:next')
    expect(nextRes.ok).toBe(true)
    const page2 = await tab.snapshot()
    expect(page2.text).toContain('User_65')
    expect(page2.text).not.toContain('User_1 |')

    // Sort by score (column index 2) ascending -> descending -> reset
    const sortAsc = await tab.click('doc-csv-sort:2')
    expect(sortAsc.ok).toBe(true)
    const ascSnap = await tab.snapshot()
    const firstAscRow = ascSnap.blocks.find((b) => b.kind === 'table-row' && !b.isHeader)
    expect(firstAscRow?.cells?.[2]).toBe('1')

    const sortDesc = await tab.click('doc-csv-sort:2')
    expect(sortDesc.ok).toBe(true)
    const descSnap = await tab.snapshot()
    const firstDescRow = descSnap.blocks.find((b) => b.kind === 'table-row' && !b.isHeader)
    expect(firstDescRow?.cells?.[2]).toBe('99')

    const resetRes = await tab.click('doc-csv-sort:reset')
    expect(resetRes.ok).toBe(true)
    const resetSnap = await tab.snapshot()
    const firstResetRow = resetSnap.blocks.find((b) => b.kind === 'table-row' && !b.isHeader)
    expect(firstResetRow?.cells?.[0]).toBe('1')
  })

  it('renders plain text with pagination and navigates via auto-detected URLs', async () => {
    const engine = new LiteBrowserEngine()
    const tab = await engine.createTab(`${baseUrl}/logs/app.txt`)
    const snap = await tab.snapshot()

    expect(snap.title).toBe('Text: app.txt')
    expect(snap.text).toContain('Lines 1-120 of 145 (page 1/2)')

    // Paginate to page 2
    const nextRes = await tab.click('doc-page:next')
    expect(nextRes.ok).toBe(true)
    const page2 = await tab.snapshot()
    expect(page2.text).toContain('Log entry #145: ok')

    // Go back to page 1 and follow auto-detected Markdown URL
    const prevRes = await tab.click('doc-page:prev')
    expect(prevRes.ok).toBe(true)
    const page1 = await tab.snapshot()
    const mdLink = page1.elements.find((e) => e.href === `${baseUrl}/docs/README.md`)
    expect(mdLink).toBeDefined()
    const clickRes = await tab.click(mdLink!.selector)
    expect(clickRes.ok).toBe(true)
    expect(tab.getTitle()).toBe('Project README')
  })
})
