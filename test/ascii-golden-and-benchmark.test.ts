import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computePageDelta } from '../src/agent/delta.js'
import {
  benchmarkAsciiCase,
  createAsciiBenchmarkFixtures,
  formatAsciiBenchmarkReport,
  runDefaultAsciiBenchmarkSuite,
} from '../src/ascii/benchmark.js'
import { renderDeltaAscii } from '../src/ascii/delta.js'
import { renderPageAscii } from '../src/ascii/layout.js'
import { renderPageMarkdown } from '../src/ascii/markdown.js'
import { isStrictAscii } from '../src/ascii/sanitize.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = path.join(__dirname, 'golden')

function readGolden(filename: string): string {
  const fullPath = path.join(GOLDEN_DIR, filename)
  return fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('ASCII layout golden snapshots & determinism (M15)', () => {
  const fixtures = createAsciiBenchmarkFixtures()

  const goldenCases: Array<{ name: string; file: string; render: () => string }> = [
    {
      name: 'docs flow normal with inline links, table, media, and scrollbar',
      file: 'docs-flow-normal.golden.txt',
      render: () =>
        renderPageAscii(fixtures.docsFlow, {
          width: 100,
          height: 36,
          asciiOnly: true,
          showChrome: true,
          layout: 'flow',
          density: 'normal',
        }),
    },
    {
      name: 'dashboard 2D spatial layout with multi-column header, sidebar, and action rail',
      file: 'dashboard-spatial-2d.golden.txt',
      render: () =>
        renderPageAscii(fixtures.dashboardSpatial, {
          width: 110,
          height: 28,
          asciiOnly: true,
          showChrome: true,
          layout: 'spatial',
          density: 'normal',
        }),
    },
    {
      name: 'login forms compact density with grouped form box',
      file: 'login-forms-compact.golden.txt',
      render: () =>
        renderPageAscii(fixtures.loginForms, {
          width: 80,
          height: 26,
          asciiOnly: true,
          density: 'compact',
        }),
    },
    {
      name: 'delta diff ASCII output with +, -, and ~ markers',
      file: 'delta-diff-ascii.golden.txt',
      render: () =>
        renderDeltaAscii(computePageDelta(fixtures.deltaPrev, fixtures.deltaNext), {
          width: 96,
          asciiOnly: true,
          showChrome: true,
        }),
    },
    {
      name: 'snapshot-to-markdown export with inline [eN] refs and strict ASCII',
      file: 'markdown-export.golden.txt',
      render: () =>
        renderPageMarkdown(fixtures.docsFlow, {
          asciiOnly: true,
          includeFrontmatter: true,
          includeMediaSummary: true,
        }),
    },
  ]

  for (const gc of goldenCases) {
    it(`matches golden snapshot byte-for-byte: ${gc.name}`, () => {
      const actual = gc.render()
      if (process.env.UPDATE_GOLDEN === '1') {
        fs.writeFileSync(path.join(GOLDEN_DIR, gc.file), `${actual}\n`, 'utf8')
      }
      const expected = readGolden(gc.file)
      expect(isStrictAscii(actual)).toBe(true)
      expect(actual).toBe(expected)
    })
  }

  it('produces identical output and SHA-256 across repeated invocations and different capturedAt timestamps', () => {
    const snapA = structuredClone(fixtures.docsFlow)
    const snapB = structuredClone(fixtures.docsFlow)
    snapA.capturedAt = 1000000000000
    snapB.capturedAt = 1999999999999

    const opts = { width: 100, height: 36, asciiOnly: true, showChrome: true, layout: 'flow' as const }
    const baseline = renderPageAscii(snapA, opts)
    const baselineHash = sha256(baseline)

    for (let i = 0; i < 20; i++) {
      const out = renderPageAscii(i % 2 === 0 ? snapA : snapB, opts)
      expect(out).toBe(baseline)
      expect(sha256(out)).toBe(baselineHash)
    }

    // Spatial layout determinism across fresh clones
    const spatialA = structuredClone(fixtures.dashboardSpatial)
    const spatialB = structuredClone(fixtures.dashboardSpatial)
    spatialB.capturedAt = 2222222222222
    const spatialOpts = { width: 110, height: 28, asciiOnly: true, showChrome: true, layout: 'spatial' as const }
    expect(renderPageAscii(spatialA, spatialOpts)).toBe(renderPageAscii(spatialB, spatialOpts))
  })

  it('does not mutate input PageSnapshot during ASCII, delta, or Markdown rendering', () => {
    const original = structuredClone(fixtures.docsFlow)
    const copy = structuredClone(fixtures.docsFlow)

    renderPageAscii(copy, { width: 100, height: 36, asciiOnly: true, showChrome: true })
    renderPageMarkdown(copy, { asciiOnly: true, includeFrontmatter: true, includeMediaSummary: true })
    expect(copy).toEqual(original)

    const spatialOrig = structuredClone(fixtures.dashboardSpatial)
    const spatialCopy = structuredClone(fixtures.dashboardSpatial)
    renderPageAscii(spatialCopy, { width: 110, height: 28, asciiOnly: true, layout: 'spatial' })
    expect(spatialCopy).toEqual(spatialOrig)
  })
})

describe('ASCII layout speed benchmarks (<5ms per page) (M15)', () => {
  it('renders every standard and 150-block stress page under 5ms median and average', () => {
    const suite = runDefaultAsciiBenchmarkSuite({
      warmupIterations: 15,
      iterations: 50,
      budgetMs: 5.0,
    })

    expect(suite.cases.length).toBeGreaterThanOrEqual(6)
    for (const c of suite.cases) {
      expect(c.deterministic, `${c.name} must be deterministic`).toBe(true)
      expect(c.strictAscii, `${c.name} must be strict 7-bit ASCII`).toBe(true)
      expect(c.medianMs, `${c.name} median ${c.medianMs.toFixed(3)}ms exceeded 5ms`).toBeLessThan(5.0)
      expect(c.avgMs, `${c.name} avg ${c.avgMs.toFixed(3)}ms exceeded 5ms`).toBeLessThan(5.0)
      expect(c.passed, `${c.name} failed benchmark gate`).toBe(true)
    }
    expect(suite.allPassed).toBe(true)

    const report = formatAsciiBenchmarkReport(suite)
    expect(isStrictAscii(report)).toBe(true)
    expect(report).toContain('Overall: PASS')
    expect(report).toContain('large-catalog-150-blocks')
  })

  it('detects budget violations and non-deterministic renderers in benchmarkAsciiCase', () => {
    let counter = 0
    const nondet = benchmarkAsciiCase(
      {
        name: 'non-deterministic-case',
        budgetMs: 50,
        run: () => `frame-${counter++}`,
      },
      { warmupIterations: 0, iterations: 5 },
    )
    expect(nondet.deterministic).toBe(false)
    expect(nondet.passed).toBe(false)

    const overBudget = benchmarkAsciiCase(
      {
        name: 'impossible-budget-case',
        budgetMs: 0.000001,
        run: () => 'hello ascii',
      },
      { warmupIterations: 2, iterations: 10 },
    )
    expect(overBudget.deterministic).toBe(true)
    expect(overBudget.strictAscii).toBe(true)
    expect(overBudget.passed).toBe(false)
  })
})
