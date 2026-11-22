// Benchmark harness and deterministic synthetic page fixtures for the ASCII layout engine.
// Verifies sub-5ms per-page rendering speed, deterministic output, and strict 7-bit ASCII compliance.

import { createHash } from 'node:crypto'
import { computePageDelta } from '../agent/delta.js'
import type { AsciiRenderOptions, ContentBlock, ElementDescriptor, MarkdownRenderOptions, PageSnapshot } from '../types.js'
import { renderDeltaAscii, type DeltaAsciiOptions } from './delta.js'
import { renderPageAscii } from './layout.js'
import { renderPageMarkdown } from './markdown.js'
import { isStrictAscii } from './sanitize.js'

export interface AsciiBenchmarkFixtures {
  docsFlow: PageSnapshot
  dashboardSpatial: PageSnapshot
  loginForms: PageSnapshot
  largeCatalog: PageSnapshot
  deltaPrev: PageSnapshot
  deltaNext: PageSnapshot
}

export interface AsciiBenchmarkCase {
  name: string
  budgetMs?: number
  run: () => string
}

export interface AsciiBenchmarkOptions {
  warmupIterations?: number
  iterations?: number
  budgetMs?: number
}

export interface AsciiBenchmarkCaseResult {
  name: string
  iterations: number
  budgetMs: number
  minMs: number
  medianMs: number
  avgMs: number
  p95Ms: number
  maxMs: number
  opsPerSec: number
  outputChars: number
  outputLines: number
  sha256: string
  deterministic: boolean
  strictAscii: boolean
  passed: boolean
}

export interface AsciiBenchmarkSuiteResult {
  budgetMs: number
  iterations: number
  warmupIterations: number
  allPassed: boolean
  cases: AsciiBenchmarkCaseResult[]
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function createDocsFlowFixture(): PageSnapshot {
  const elements: ElementDescriptor[] = [
    {
      ref: 'e1',
      selector: 'a#nav-guide',
      tag: 'a',
      type: '',
      id: 'nav-guide',
      text: 'Guide',
      href: 'https://docs.troy.local/guide',
      box: { x: 20, y: 20, width: 60, height: 22 },
    },
    {
      ref: 'e2',
      selector: 'a#nav-api',
      tag: 'a',
      type: '',
      id: 'nav-api',
      text: 'API Reference',
      href: 'https://docs.troy.local/api',
      box: { x: 100, y: 20, width: 110, height: 22 },
    },
    {
      ref: 'e3',
      selector: 'a#link-quickstart',
      tag: 'a',
      type: '',
      id: 'link-quickstart',
      text: 'Quickstart Guide',
      href: 'https://docs.troy.local/quickstart',
      box: { x: 180, y: 120, width: 130, height: 20 },
    },
    {
      ref: 'e4',
      selector: 'a#link-cdp',
      tag: 'a',
      type: '',
      id: 'link-cdp',
      text: 'CDP Bridge',
      href: 'https://docs.troy.local/cdp',
      box: { x: 380, y: 120, width: 90, height: 20 },
    },
    {
      ref: 'e5',
      selector: 'button#copy-snippet',
      tag: 'button',
      type: 'button',
      id: 'copy-snippet',
      text: 'Copy Snippet',
      box: { x: 20, y: 310, width: 120, height: 30 },
    },
    {
      ref: 'e6',
      selector: 'a#next-page',
      tag: 'a',
      type: '',
      id: 'next-page',
      text: 'Next: Spatial Layout',
      href: 'https://docs.troy.local/spatial',
      box: { x: 20, y: 680, width: 180, height: 24 },
    },
  ]

  const blocks: ContentBlock[] = [
    { kind: 'heading', level: 1, text: 'Troy Advanced Architecture', box: { x: 20, y: 60, width: 760, height: 36 } },
    {
      kind: 'paragraph',
      text: 'Read the Quickstart Guide and explore the CDP Bridge to connect terminal agents with live Chromium tabs.',
      links: [
        { text: 'Quickstart Guide', ref: 'e3', href: 'https://docs.troy.local/quickstart', start: 9, end: 25 },
        { text: 'CDP Bridge', ref: 'e4', href: 'https://docs.troy.local/cdp', start: 42, end: 52 },
      ],
      box: { x: 20, y: 110, width: 760, height: 48 },
    },
    { kind: 'heading', level: 2, text: 'Engine Comparison', box: { x: 20, y: 180, width: 760, height: 28 } },
    { kind: 'table-row', isHeader: true, text: 'Engine | Startup | JS | Footprint', cells: ['Engine', 'Startup', 'JS', 'Footprint'] },
    { kind: 'table-row', text: 'Chromium CDP | 450ms | Full | 180MB', cells: ['Chromium CDP', '450ms', 'Full', '180MB'] },
    { kind: 'table-row', text: 'Lite Engine | 12ms | Static | 24MB', cells: ['Lite Engine', '12ms', 'Static', '24MB'] },
    { kind: 'heading', level: 2, text: 'Quick CLI Usage', box: { x: 20, y: 340, width: 760, height: 28 } },
    {
      kind: 'code',
      text: 'troy-advanced daemon start\ntroy-advanced open https://example.com\ntroy-advanced read --density compact',
      box: { x: 20, y: 380, width: 760, height: 80 },
    },
    { kind: 'button', text: 'Copy Snippet', ref: 'e5', box: { x: 20, y: 470, width: 120, height: 30 } },
    { kind: 'list-item', text: 'Strict 7-bit ASCII output with zero Unicode drift' },
    { kind: 'list-item', text: 'Deterministic opaque [eN] refs bound to live DOM elements' },
    { kind: 'list-item', text: 'Sub-5ms spatial layout rendering for high-frequency loops' },
    { kind: 'hr', text: '' },
    {
      kind: 'image',
      text: 'Architecture Diagram',
      alt: 'Architecture Diagram',
      src: 'https://docs.troy.local/img/arch.png',
      naturalWidth: 1280,
      naturalHeight: 720,
      box: { x: 20, y: 560, width: 640, height: 360 },
    },
    { kind: 'link', text: 'Next: Spatial Layout', ref: 'e6', href: 'https://docs.troy.local/spatial' },
  ]

  return {
    tabId: 1,
    url: 'https://docs.troy.local/architecture',
    title: 'Troy Advanced Architecture',
    epoch: 3,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 180, scrollHeight: 1640 },
    blocks,
    elements,
    text: blocks.map((b) => b.text).filter(Boolean).join('\n'),
    capturedAt: 1700000000000,
  }
}

function createDashboardSpatialFixture(): PageSnapshot {
  const elements: ElementDescriptor[] = [
    {
      ref: 'e1',
      selector: 'a#nav-overview',
      tag: 'a',
      type: '',
      text: 'Overview',
      href: 'https://ops.troy.local/',
      box: { x: 24, y: 90, width: 160, height: 28 },
    },
    {
      ref: 'e2',
      selector: 'a#nav-clusters',
      tag: 'a',
      type: '',
      text: 'Clusters',
      href: 'https://ops.troy.local/clusters',
      box: { x: 24, y: 126, width: 160, height: 28 },
    },
    {
      ref: 'e3',
      selector: 'a#nav-alerts',
      tag: 'a',
      type: '',
      text: 'Alerts (2)',
      href: 'https://ops.troy.local/alerts',
      box: { x: 24, y: 162, width: 160, height: 28 },
    },
    {
      ref: 'e4',
      selector: 'input#global-search',
      tag: 'input',
      type: 'search',
      name: 'q',
      placeholder: 'Filter nodes...',
      text: '',
      editable: true,
      box: { x: 860, y: 18, width: 320, height: 32 },
    },
    {
      ref: 'e5',
      selector: 'button#deploy-now',
      tag: 'button',
      type: 'button',
      text: 'Deploy',
      box: { x: 960, y: 160, width: 180, height: 34 },
    },
    {
      ref: 'e6',
      selector: 'button#drain-node',
      tag: 'button',
      type: 'button',
      text: 'Drain Node',
      box: { x: 960, y: 204, width: 180, height: 34 },
    },
  ]

  const blocks: ContentBlock[] = [
    // Top header bar
    { kind: 'heading', level: 1, text: 'Ops Console', box: { x: 24, y: 16, width: 300, height: 36 } },
    {
      kind: 'input',
      text: 'Search',
      placeholder: 'Filter nodes...',
      ref: 'e4',
      box: { x: 860, y: 18, width: 320, height: 32 },
    },
    // Left sidebar
    { kind: 'heading', level: 3, text: 'Navigation', box: { x: 24, y: 62, width: 180, height: 24 } },
    { kind: 'link', text: 'Overview', ref: 'e1', box: { x: 24, y: 90, width: 160, height: 28 } },
    { kind: 'link', text: 'Clusters', ref: 'e2', box: { x: 24, y: 126, width: 160, height: 28 } },
    { kind: 'link', text: 'Alerts (2)', ref: 'e3', box: { x: 24, y: 162, width: 160, height: 28 } },
    // Main center column
    { kind: 'heading', level: 2, text: 'Cluster Health', box: { x: 260, y: 68, width: 620, height: 30 } },
    {
      kind: 'paragraph',
      text: 'us-east-1 production fleet is healthy. P95 render latency is 1.4ms across 12 workers.',
      box: { x: 260, y: 108, width: 620, height: 52 },
    },
    {
      kind: 'paragraph',
      text: 'Active tabs: 18 | Memory RSS: 142MB | Blocked trackers: 412',
      box: { x: 260, y: 170, width: 620, height: 40 },
    },
    // Right action column
    { kind: 'heading', level: 3, text: 'Quick Actions', box: { x: 960, y: 68, width: 240, height: 24 } },
    { kind: 'paragraph', text: 'Release v2.4.1 ready', box: { x: 960, y: 108, width: 240, height: 32 } },
    { kind: 'button', text: 'Deploy', ref: 'e5', box: { x: 960, y: 160, width: 180, height: 34 } },
    { kind: 'button', text: 'Drain Node', ref: 'e6', box: { x: 960, y: 204, width: 180, height: 34 } },
  ]

  return {
    tabId: 2,
    url: 'https://ops.troy.local/dashboard',
    title: 'Ops Console - Cluster Health',
    epoch: 7,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, scrollHeight: 720 },
    blocks,
    elements,
    text: blocks.map((b) => b.text).filter(Boolean).join('\n'),
    capturedAt: 1700000001000,
  }
}

function createLoginFormsFixture(): PageSnapshot {
  const elements: ElementDescriptor[] = [
    {
      ref: 'e1',
      selector: 'input#email',
      tag: 'input',
      type: 'email',
      id: 'email',
      name: 'email',
      label: 'Work Email',
      placeholder: 'engineer@company.com',
      text: '',
      value: 'ops@troy.local',
      editable: true,
    },
    {
      ref: 'e2',
      selector: 'input#token',
      tag: 'input',
      type: 'text',
      id: 'token',
      name: 'workspace',
      label: 'Workspace',
      placeholder: 'prod-us-east',
      text: '',
      editable: true,
    },
    {
      ref: 'e3',
      selector: 'select#region',
      tag: 'select',
      type: 'select-one',
      id: 'region',
      name: 'region',
      label: 'Region',
      text: 'us-east-1',
      value: 'us-east-1',
      options: [
        { value: 'us-east-1', label: 'us-east-1', selected: true },
        { value: 'eu-west-1', label: 'eu-west-1' },
      ],
    },
    {
      ref: 'e4',
      selector: 'input#remember',
      tag: 'input',
      type: 'checkbox',
      id: 'remember',
      name: 'remember',
      label: 'Keep session active',
      text: '',
      checked: true,
    },
    {
      ref: 'e5',
      selector: 'button#signin-submit',
      tag: 'button',
      type: 'submit',
      id: 'signin-submit',
      text: 'Sign In',
      defaultSubmit: true,
    },
    {
      ref: 'e6',
      selector: 'a#forgot-link',
      tag: 'a',
      type: '',
      id: 'forgot-link',
      text: 'Reset access key',
      href: 'https://auth.troy.local/reset',
    },
  ]

  const blocks: ContentBlock[] = [
    { kind: 'heading', level: 1, text: 'Workspace Access' },
    { kind: 'paragraph', text: 'Authenticate your terminal session to attach to remote clusters.' },
    {
      kind: 'input',
      text: 'Work Email',
      value: 'ops@troy.local',
      placeholder: 'engineer@company.com',
      ref: 'e1',
      formId: 'login-form',
      formTitle: 'Sign In',
    },
    {
      kind: 'input',
      text: 'Workspace',
      placeholder: 'prod-us-east',
      ref: 'e2',
      formId: 'login-form',
      formTitle: 'Sign In',
    },
    {
      kind: 'select',
      text: 'Region',
      value: 'us-east-1',
      ref: 'e3',
      formId: 'login-form',
      formTitle: 'Sign In',
    },
    {
      kind: 'input',
      text: 'Keep session active',
      checked: true,
      ref: 'e4',
      formId: 'login-form',
      formTitle: 'Sign In',
    },
    {
      kind: 'button',
      text: 'Sign In',
      ref: 'e5',
      formId: 'login-form',
      formTitle: 'Sign In',
    },
    { kind: 'link', text: 'Reset access key', ref: 'e6', href: 'https://auth.troy.local/reset' },
  ]

  return {
    tabId: 3,
    url: 'https://auth.troy.local/login',
    title: 'Workspace Access',
    epoch: 1,
    viewport: { width: 1024, height: 768, scrollX: 0, scrollY: 0, scrollHeight: 768 },
    blocks,
    elements,
    text: blocks.map((b) => b.text).filter(Boolean).join('\n'),
    capturedAt: 1700000002000,
  }
}

function createLargeCatalogFixture(): PageSnapshot {
  const blocks: ContentBlock[] = []
  const elements: ElementDescriptor[] = []
  let refIdx = 1

  const nextRef = (): string => `e${refIdx++}`

  blocks.push({ kind: 'heading', level: 1, text: 'Cloud Instance & Benchmark Catalog' })
  blocks.push({
    kind: 'paragraph',
    text: 'Compare EC2 Graviton and x86_64 instance profiles for headless browser farms and ASCII agent workloads.',
  })

  // Search/filter form
  const searchRef = nextRef()
  elements.push({
    ref: searchRef,
    selector: 'input#catalog-search',
    tag: 'input',
    type: 'search',
    name: 'q',
    placeholder: 'Search instance families...',
    text: '',
    editable: true,
  })
  blocks.push({
    kind: 'input',
    text: 'Filter',
    placeholder: 'Search instance families...',
    ref: searchRef,
    formId: 'filter-form',
    formTitle: 'Catalog Filter',
  })

  const applyRef = nextRef()
  elements.push({
    ref: applyRef,
    selector: 'button#apply-filter',
    tag: 'button',
    type: 'submit',
    text: 'Apply Filters',
  })
  blocks.push({
    kind: 'button',
    text: 'Apply Filters',
    ref: applyRef,
    formId: 'filter-form',
    formTitle: 'Catalog Filter',
  })

  // 25-row structured table
  blocks.push({ kind: 'heading', level: 2, text: 'Instance Matrix' })
  blocks.push({
    kind: 'table-row',
    isHeader: true,
    text: 'Instance | Arch | vCPU | RAM | Cost/hr',
    cells: ['Instance', 'Arch', 'vCPU', 'RAM', 'Cost/hr'],
  })
  const families = ['c7g', 'm7g', 'r7g', 't4g', 'c7i']
  const sizes = ['medium', 'large', 'xlarge', '2xlarge', '4xlarge']
  for (let i = 0; i < 25; i++) {
    const fam = families[i % families.length]!
    const sz = sizes[Math.floor(i / families.length) % sizes.length]!
    const arch = fam.endsWith('g') ? 'arm64' : 'x86_64'
    const vcpu = String(2 ** ((i % 4) + 1))
    const ram = `${2 ** ((i % 4) + 2)} GiB`
    const cost = `$0.${String(18 + i * 3).padStart(2, '0')}`
    blocks.push({
      kind: 'table-row',
      text: `${fam}.${sz} | ${arch} | ${vcpu} | ${ram} | ${cost}`,
      cells: [`${fam}.${sz}`, arch, vcpu, ram, cost],
    })
  }

  // 30 rich sections with paragraphs, inline links, list items, and action buttons (~130 more blocks)
  for (let s = 1; s <= 30; s++) {
    blocks.push({ kind: 'heading', level: 3, text: `Region Cluster Group ${s}` })
    const docRef = nextRef()
    const btnRef = nextRef()
    const linkText = `Cluster ${s} Spec`
    elements.push(
      {
        ref: docRef,
        selector: `a#spec-${s}`,
        tag: 'a',
        type: '',
        text: linkText,
        href: `https://catalog.troy.local/specs/${s}`,
      },
      {
        ref: btnRef,
        selector: `button#launch-${s}`,
        tag: 'button',
        type: 'button',
        text: `Launch Group ${s}`,
      },
    )
    const pText = `Review the ${linkText} before allocating dedicated headless Chromium workers in zone-${s}.`
    const start = pText.indexOf(linkText)
    blocks.push({
      kind: 'paragraph',
      text: pText,
      links: [{ text: linkText, ref: docRef, href: `https://catalog.troy.local/specs/${s}`, start, end: start + linkText.length }],
    })
    blocks.push({ kind: 'list-item', text: `Zone-${s}: 99.99% uptime SLA, NVMe scratch disk, low-latency CDP socket` })
    blocks.push({ kind: 'button', text: `Launch Group ${s}`, ref: btnRef })
  }

  return {
    tabId: 4,
    url: 'https://catalog.troy.local/instances',
    title: 'Cloud Instance & Benchmark Catalog',
    epoch: 2,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 6400 },
    blocks,
    elements,
    text: blocks.map((b) => b.text).filter(Boolean).join('\n'),
    capturedAt: 1700000003000,
  }
}

function createDeltaPairFixtures(): { prev: PageSnapshot; next: PageSnapshot } {
  const prev: PageSnapshot = {
    tabId: 5,
    url: 'https://app.troy.local/tasks',
    title: 'Task Queue (2)',
    epoch: 1,
    viewport: { width: 1200, height: 720, scrollX: 0, scrollY: 0, scrollHeight: 720 },
    blocks: [
      { kind: 'heading', level: 1, text: 'Task Queue' },
      { kind: 'paragraph', text: 'Pending jobs: 2' },
    ],
    elements: [
      { ref: 'e1', selector: 'input#job-name', tag: 'input', type: 'text', text: '', value: '' },
      { ref: 'e2', selector: 'button#run-job', tag: 'button', type: 'button', text: 'Run Job' },
      { ref: 'e3', selector: 'button#cancel-old', tag: 'button', type: 'button', text: 'Cancel Old' },
    ],
    text: 'Task Queue\nPending jobs: 2\nWorker status: idle',
    capturedAt: 1700000004000,
  }

  const next: PageSnapshot = {
    tabId: 5,
    url: 'https://app.troy.local/tasks?status=active',
    title: 'Task Queue (3)',
    epoch: 2,
    viewport: { width: 1200, height: 720, scrollX: 0, scrollY: 0, scrollHeight: 720 },
    blocks: [
      { kind: 'heading', level: 1, text: 'Task Queue' },
      { kind: 'paragraph', text: 'Pending jobs: 3' },
    ],
    elements: [
      { ref: 'e1', selector: 'input#job-name', tag: 'input', type: 'text', text: '', value: 'nightly-eval' },
      { ref: 'e2', selector: 'button#run-job', tag: 'button', type: 'button', text: 'Running...', disabled: true },
      { ref: 'e4', selector: 'a#view-logs', tag: 'a', type: '', text: 'View Live Logs', href: 'https://app.troy.local/logs' },
    ],
    text: 'Task Queue\nPending jobs: 3\nWorker status: running\nJob nightly-eval queued',
    capturedAt: 1700000005000,
  }

  return { prev, next }
}

export function createAsciiBenchmarkFixtures(): AsciiBenchmarkFixtures {
  const { prev, next } = createDeltaPairFixtures()
  return {
    docsFlow: createDocsFlowFixture(),
    dashboardSpatial: createDashboardSpatialFixture(),
    loginForms: createLoginFormsFixture(),
    largeCatalog: createLargeCatalogFixture(),
    deltaPrev: prev,
    deltaNext: next,
  }
}

export function benchmarkAsciiCase(
  benchCase: AsciiBenchmarkCase,
  options: AsciiBenchmarkOptions = {},
): AsciiBenchmarkCaseResult {
  const warmupIterations = Math.max(0, options.warmupIterations ?? 10)
  const iterations = Math.max(1, options.iterations ?? 50)
  const budgetMs = benchCase.budgetMs ?? options.budgetMs ?? 5.0

  // Warmup JIT
  for (let i = 0; i < warmupIterations; i++) {
    benchCase.run()
  }

  const samplesMs: number[] = []
  let firstOutput = ''
  let firstHash = ''
  let deterministic = true

  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint()
    const output = benchCase.run()
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    samplesMs.push(elapsedMs)

    if (i === 0) {
      firstOutput = output
      firstHash = sha256Hex(output)
    } else if (output !== firstOutput) {
      deterministic = false
    }
  }

  const sorted = [...samplesMs].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const minMs = sorted[0] ?? 0
  const maxMs = sorted[sorted.length - 1] ?? 0
  const avgMs = sum / sorted.length
  const medianMs = percentile(sorted, 50)
  const p95Ms = percentile(sorted, 95)
  const opsPerSec = avgMs > 0 ? 1000 / avgMs : Number.POSITIVE_INFINITY
  const strictAscii = isStrictAscii(firstOutput)
  const outputLines = firstOutput.length === 0 ? 0 : firstOutput.split('\n').length

  return {
    name: benchCase.name,
    iterations,
    budgetMs,
    minMs,
    medianMs,
    avgMs,
    p95Ms,
    maxMs,
    opsPerSec,
    outputChars: firstOutput.length,
    outputLines,
    sha256: firstHash,
    deterministic,
    strictAscii,
    passed: medianMs < budgetMs && avgMs < budgetMs && deterministic && strictAscii,
  }
}

export function runDefaultAsciiBenchmarkSuite(options: AsciiBenchmarkOptions = {}): AsciiBenchmarkSuiteResult {
  const fixtures = createAsciiBenchmarkFixtures()
  const warmupIterations = Math.max(0, options.warmupIterations ?? 10)
  const iterations = Math.max(1, options.iterations ?? 50)
  const budgetMs = options.budgetMs ?? 5.0

  const docsFlowOpts: AsciiRenderOptions = {
    width: 100,
    height: 36,
    asciiOnly: true,
    showChrome: true,
    layout: 'flow',
    density: 'normal',
  }
  const spatialOpts: AsciiRenderOptions = {
    width: 110,
    height: 28,
    asciiOnly: true,
    showChrome: true,
    layout: 'spatial',
    density: 'normal',
  }
  const compactOpts: AsciiRenderOptions = {
    width: 80,
    height: 26,
    asciiOnly: true,
    density: 'compact',
  }
  const largeOpts: AsciiRenderOptions = {
    width: 120,
    height: 44,
    asciiOnly: true,
    showChrome: true,
    layout: 'flow',
    density: 'normal',
  }
  const deltaOpts: DeltaAsciiOptions = {
    width: 96,
    asciiOnly: true,
    showChrome: true,
  }
  const mdOpts: MarkdownRenderOptions = {
    asciiOnly: true,
    includeFrontmatter: true,
    includeMediaSummary: true,
  }

  const delta = computePageDelta(fixtures.deltaPrev, fixtures.deltaNext)

  const cases: AsciiBenchmarkCase[] = [
    {
      name: 'docs-flow-normal',
      run: () => renderPageAscii(fixtures.docsFlow, docsFlowOpts),
    },
    {
      name: 'dashboard-spatial-2d',
      run: () => renderPageAscii(fixtures.dashboardSpatial, spatialOpts),
    },
    {
      name: 'login-forms-compact',
      run: () => renderPageAscii(fixtures.loginForms, compactOpts),
    },
    {
      name: 'large-catalog-150-blocks',
      run: () => renderPageAscii(fixtures.largeCatalog, largeOpts),
    },
    {
      name: 'delta-diff-ascii',
      run: () => renderDeltaAscii(delta, deltaOpts),
    },
    {
      name: 'markdown-export',
      run: () => renderPageMarkdown(fixtures.docsFlow, mdOpts),
    },
  ]

  const results = cases.map((c) => benchmarkAsciiCase(c, { warmupIterations, iterations, budgetMs }))
  return {
    budgetMs,
    iterations,
    warmupIterations,
    allPassed: results.every((r) => r.passed),
    cases: results,
  }
}

export function formatAsciiBenchmarkReport(suite: AsciiBenchmarkSuiteResult): string {
  const headers = ['Case', 'Median(ms)', 'Avg(ms)', 'P95(ms)', 'Ops/s', 'Lines', 'Det', 'ASCII', 'Status']
  const rows = suite.cases.map((c) => [
    c.name,
    c.medianMs.toFixed(3),
    c.avgMs.toFixed(3),
    c.p95Ms.toFixed(3),
    Math.round(c.opsPerSec).toString(),
    String(c.outputLines),
    c.deterministic ? 'OK' : 'FAIL',
    c.strictAscii ? 'OK' : 'FAIL',
    c.passed ? 'PASS' : 'FAIL',
  ])

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const sep = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`
  const formatRow = (cols: string[]) => `| ${cols.map((v, i) => v.padEnd(widths[i] ?? v.length)).join(' | ')} |`

  const lines = [
    `ASCII Layout Benchmark Suite (budget < ${suite.budgetMs.toFixed(1)}ms, warmup=${suite.warmupIterations}, iters=${suite.iterations})`,
    sep,
    formatRow(headers),
    sep,
    ...rows.map(formatRow),
    sep,
    `Overall: ${suite.allPassed ? 'PASS' : 'FAIL'}`,
  ]
  return lines.join('\n')
}
