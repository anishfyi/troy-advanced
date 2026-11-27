import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import {
  BrowserManager,
  createAgentSocket,
  executePipeCommand,
  extractStructuredData,
  formatExtractAscii,
  generateToolSchemas,
  handleMcpRequest,
  parseExtractSections,
  type PageExtractResult,
  type PageSnapshot,
} from '../src/index.js'

const RICH_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Acme Cloud &amp; Pricing</title>
  <meta name="description" content="Fast cloud servers &amp; GPUs for AI teams." />
  <meta name="author" content="Acme Corp" />
  <meta name="keywords" content="cloud, gpu, ai, servers" />
  <meta name="robots" content="index,follow" />
  <meta name="theme-color" content="#112233" />
  <link rel="canonical" href="https://acme.example/pricing" />
  <meta property="og:title" content="Acme Cloud Pricing" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://acme.example/pricing" />
  <meta property="og:image" content="https://acme.example/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@acmecloud" />
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Acme GPU Cluster",
      "offers": { "@type": "Offer", "price": "99.00", "priceCurrency": "USD" }
    }
  </script>
  <script type="application/ld+json">
    [
      { "@type": "BreadcrumbList", "name": "Pricing Breadcrumb" },
      { "@type": "Organization", "name": "Acme Corp" }
    ]
  </script>
  <script type="application/ld+json">{ invalid json here </script>
</head>
<body>
  <header>
    <h1 id="top">Acme Cloud Pricing</h1>
    <nav>
      <a href="/docs" title="Documentation">Docs</a>
      <a href="https://status.other.dev/uptime" rel="noopener" target="_blank">External Status</a>
      <a href="javascript:void(0)">Ignore JS Link</a>
    </nav>
  </header>
  <main>
    <h2 id="plans">Compute Plans</h2>
    <table>
      <caption>Monthly Server Rates</caption>
      <thead>
        <tr><th>Plan</th><th>vCPU</th><th>Price</th></tr>
      </thead>
      <tbody>
        <tr><td>Starter</td><td>2</td><td>$10 &amp; up</td></tr>
        <tr><td>Pro</td><td>8</td><td>$40</td></tr>
      </tbody>
    </table>

    <h3 id="signup">Start Free Trial</h3>
    <form id="trial-form" name="trial" action="/api/trial" method="post" enctype="application/x-www-form-urlencoded">
      <fieldset>
        <legend>Create Workspace</legend>
        <input type="hidden" name="csrf_token" value="tok_12345" />
        <label for="email-input">Work Email</label>
        <input id="email-input" name="email" type="email" placeholder="you@company.com" required />
        <label>
          Account Password
          <input id="pw-input" name="password" type="password" value="super-secret-pw" />
        </label>
        <label for="region-select">Region</label>
        <select id="region-select" name="region">
          <option value="us-east-1">US East</option>
          <option value="eu-west-1" selected>EU West</option>
        </select>
        <label>
          <input type="checkbox" name="newsletter" checked />
          Subscribe to updates
        </label>
        <label for="notes-box">Notes</label>
        <textarea id="notes-box" name="notes" placeholder="Optional notes">Hello team</textarea>
        <button type="submit" name="go">Launch Trial</button>
      </fieldset>
    </form>
  </main>
</body>
</html>`

const servers: http.Server[] = []
const managers: BrowserManager[] = []

afterEach(async () => {
  while (managers.length > 0) {
    const m = managers.pop()!
    await m.close().catch(() => {})
  }
  while (servers.length > 0) {
    const s = servers.pop()!
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

async function startHtmlServer(html: string): Promise<string> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  servers.push(srv)
  const addr = srv.address() as { port: number }
  return `http://127.0.0.1:${addr.port}/pricing`
}

describe('M63: Structured data extractor (page_extract)', () => {
  it('parses section filters cleanly', () => {
    expect(parseExtractSections('tables,metadata')).toEqual(['tables', 'metadata'])
    expect(parseExtractSections(['forms', 'LINKS', 'unknown'])).toEqual(['forms', 'links'])
    expect(parseExtractSections('all')).toEqual(['tables', 'forms', 'links', 'headings', 'metadata'])
    expect(parseExtractSections(undefined)).toBeUndefined()
  })

  it('extracts tables, forms, links, headings, and JSON-LD/OpenGraph/Twitter metadata from HTML', () => {
    const result = extractStructuredData({
      html: RICH_HTML,
      url: 'https://acme.example/pricing',
    })

    expect(result.ok).toBe(true)
    expect(result.title).toBe('Acme Cloud & Pricing')
    expect(result.counts).toEqual({
      tables: 1,
      forms: 1,
      links: 2,
      headings: 3,
      jsonLd: 3,
      openGraph: 4,
    })

    // Metadata
    expect(result.metadata).toBeDefined()
    expect(result.metadata!.lang).toBe('en')
    expect(result.metadata!.description).toBe('Fast cloud servers & GPUs for AI teams.')
    expect(result.metadata!.canonical).toBe('https://acme.example/pricing')
    expect(result.metadata!.author).toBe('Acme Corp')
    expect(result.metadata!.keywords).toEqual(['cloud', 'gpu', 'ai', 'servers'])
    expect(result.metadata!.robots).toBe('index,follow')
    expect(result.metadata!.meta['theme-color']).toBe('#112233')
    expect(result.metadata!.openGraph).toEqual({
      title: 'Acme Cloud Pricing',
      type: 'website',
      url: 'https://acme.example/pricing',
      image: 'https://acme.example/og.png',
    })
    expect(result.metadata!.twitter).toEqual({
      card: 'summary_large_image',
      site: '@acmecloud',
    })
    expect(result.metadata!.jsonLd).toHaveLength(3)
    expect((result.metadata!.jsonLd[0] as Record<string, unknown>)['@type']).toBe('Product')
    expect(result.metadata!.jsonLdErrors).toBe(1)

    // Tables
    expect(result.tables).toHaveLength(1)
    const tbl = result.tables![0]!
    expect(tbl.caption).toBe('Monthly Server Rates')
    expect(tbl.headers).toEqual(['Plan', 'vCPU', 'Price'])
    expect(tbl.rows).toEqual([
      ['Starter', '2', '$10 & up'],
      ['Pro', '8', '$40'],
    ])
    expect(tbl.objects).toEqual([
      { Plan: 'Starter', vCPU: '2', Price: '$10 & up' },
      { Plan: 'Pro', vCPU: '8', Price: '$40' },
    ])
    expect(tbl.rowCount).toBe(2)
    expect(tbl.columnCount).toBe(3)

    // Forms (including sensitive field redaction!)
    expect(result.forms).toHaveLength(1)
    const form = result.forms![0]!
    expect(form.id).toBe('trial-form')
    expect(form.title).toBe('Create Workspace')
    expect(form.method).toBe('POST')
    expect(form.action).toBe('https://acme.example/api/trial')
    expect(form.submitButtons).toEqual([{ text: 'Launch Trial', name: 'go' }])

    const csrfField = form.fields.find((f) => f.name === 'csrf_token')
    expect(csrfField?.type).toBe('hidden')
    expect(csrfField?.value).toBe('tok_12345')

    const emailField = form.fields.find((f) => f.name === 'email')
    expect(emailField?.label).toBe('Work Email')
    expect(emailField?.required).toBe(true)

    const pwField = form.fields.find((f) => f.name === 'password')
    expect(pwField?.valueRedacted).toBe(true)
    expect(pwField?.value).toBeUndefined()

    const regionField = form.fields.find((f) => f.name === 'region')
    expect(regionField?.tag).toBe('select')
    expect(regionField?.value).toBe('eu-west-1')
    expect(regionField?.options).toHaveLength(2)

    const cbField = form.fields.find((f) => f.name === 'newsletter')
    expect(cbField?.checked).toBe(true)

    // Links (javascript: skipped, relative resolved, external detected)
    expect(result.links).toHaveLength(2)
    expect(result.links![0]).toMatchObject({
      text: 'Docs',
      href: 'https://acme.example/docs',
      title: 'Documentation',
      external: false,
    })
    expect(result.links![1]).toMatchObject({
      text: 'External Status',
      href: 'https://status.other.dev/uptime',
      rel: 'noopener',
      target: '_blank',
      external: true,
    })

    // Headings
    expect(result.headings).toEqual([
      { level: 1, text: 'Acme Cloud Pricing', id: 'top' },
      { level: 2, text: 'Compute Plans', id: 'plans' },
      { level: 3, text: 'Start Free Trial', id: 'signup' },
    ])
  })

  it('supports section filtering, external/internal link filters, includeObjects=false, and ASCII formatting', () => {
    const extOnly = extractStructuredData({
      html: RICH_HTML,
      url: 'https://acme.example/pricing',
      options: { sections: ['links', 'tables'], externalLinksOnly: true, includeObjects: false },
    })
    expect(extOnly.sections).toEqual(['links', 'tables'])
    expect(extOnly.forms).toBeUndefined()
    expect(extOnly.headings).toBeUndefined()
    expect(extOnly.metadata).toBeUndefined()
    expect(extOnly.links).toHaveLength(1)
    expect(extOnly.links![0]!.external).toBe(true)
    expect(extOnly.tables![0]!.objects).toBeUndefined()

    const ascii = formatExtractAscii(extOnly, { width: 80 })
    expect(ascii).toContain('[TABLES] (1)')
    expect(ascii).toContain('[LINKS] (1)')
    expect(ascii).toContain('(ext)')
    // Strict 7-bit ASCII check
    expect(/^[\x09\x0a\x20-\x7e]+$/.test(ascii)).toBe(true)
  })

  it('falls back to PageSnapshot when raw HTML is empty', () => {
    const snap: PageSnapshot = {
      tabId: 1,
      url: 'https://snap.example/page',
      title: 'Snapshot Page',
      epoch: 1,
      viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 },
      blocks: [
        { kind: 'heading', level: 1, text: 'Main Heading' },
        { kind: 'table-row', text: 'A | B', cells: ['A', 'B'], isHeader: true },
        { kind: 'table-row', text: '1 | 2', cells: ['1', '2'], isHeader: false },
      ],
      elements: [
        {
          ref: 'e1',
          selector: 'a',
          tag: 'a',
          type: 'link',
          text: 'Home',
          href: '/home',
        },
        {
          ref: 'e2',
          selector: 'input[name=q]',
          tag: 'input',
          type: 'text',
          name: 'q',
          text: '',
          label: 'Search',
          formAction: '/search',
          formMethod: 'GET',
        },
      ],
      text: 'Main Heading',
      capturedAt: Date.now(),
    }

    const res = extractStructuredData({ snapshot: snap })
    expect(res.headings).toEqual([{ level: 1, text: 'Main Heading' }])
    expect(res.tables![0]!.objects).toEqual([{ A: '1', B: '2' }])
    expect(res.links![0]).toMatchObject({ ref: 'e1', href: 'https://snap.example/home', external: false })
    expect(res.forms![0]!.fields[0]).toMatchObject({ ref: 'e2', name: 'q', label: 'Search' })
  })

  it('integrates live with BrowserManager, Agent Socket (/extract + /tool), MCP (troy_extract), schema generator, and Pipe REPL', async () => {
    const url = await startHtmlServer(RICH_HTML)
    const manager = await BrowserManager.create({ engine: 'lite', memory: false })
    managers.push(manager)

    const opened = await manager.openTab(url, { activate: true })
    expect(opened.ok).toBe(true)

    // 1. Direct BrowserManager runTool('page_extract') enriches live [eN] refs
    const direct = (await manager.runTool(opened.id, 'page_extract', { ascii: true })) as PageExtractResult & {
      ascii?: string
    }
    expect(direct.ok).toBe(true)
    expect(direct.tables).toHaveLength(1)
    expect(direct.forms).toHaveLength(1)
    expect(direct.metadata?.jsonLd).toHaveLength(3)
    expect(direct.ascii).toContain('EXTRACT: Acme Cloud & Pricing')

    const emailRef = direct.forms![0]!.fields.find((f) => f.name === 'email')?.ref
    expect(emailRef).toMatch(/^e\d+$/)
    const docsLinkRef = direct.links!.find((l) => l.text === 'Docs')?.ref
    expect(docsLinkRef).toMatch(/^e\d+$/)

    // Verify the extracted ref is immediately usable in page_fill!
    manager.grantOrigin(new URL(url).origin)
    const fillRes = await manager.runTool(opened.id, 'page_fill', {
      ref: emailRef,
      text: 'agent@acme.example',
    })
    expect(fillRes.ok).toBe(true)

    // 2. Agent Socket /extract endpoint
    const socket = await createAgentSocket(manager, { port: 0 })
    try {
      const resp = await fetch(`http://127.0.0.1:${socket.port}/extract`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-troy-agent': socket.token,
        },
        body: JSON.stringify({ tabId: opened.id, sections: ['tables', 'metadata'] }),
      })
      expect(resp.status).toBe(200)
      const data = (await resp.json()) as PageExtractResult
      expect(data.ok).toBe(true)
      expect(data.tables).toHaveLength(1)
      expect(data.metadata?.openGraph.title).toBe('Acme Cloud Pricing')
      expect(data.forms).toBeUndefined()
    } finally {
      await socket.close()
    }

    // 3. MCP server troy_extract + schema generator
    const mcpResp = await handleMcpRequest(manager, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'troy_extract',
        arguments: { tabId: opened.id, sections: ['headings', 'metadata'] },
      },
    })
    expect(mcpResp?.error).toBeUndefined()
    const mcpContent = (mcpResp?.result as { content: Array<{ text: string }> }).content[0]!.text
    const mcpParsed = JSON.parse(mcpContent) as PageExtractResult
    expect(mcpParsed.ok).toBe(true)
    expect(mcpParsed.headings).toHaveLength(3)
    expect(mcpParsed.metadata?.twitter.site).toBe('@acmecloud')

    const openaiSchemas = generateToolSchemas({ format: 'openai', tools: ['troy_extract'] })
    expect(openaiSchemas).toHaveLength(1)
    expect((openaiSchemas[0] as { function: { name: string } }).function.name).toBe('troy_extract')

    // 4. Pipe REPL (plain + JSON)
    const pipePlain = await executePipeCommand(manager, 'extract --sections tables,headings --ascii')
    expect(pipePlain.output).toContain('[TABLES] (1)')
    expect(pipePlain.output).toContain('[HEADINGS] (3)')

    const pipeJson = await executePipeCommand(
      manager,
      JSON.stringify({ cmd: 'extract', sections: ['links'], externalLinksOnly: true }),
      { jsonMode: true },
    )
    const pipeParsed = JSON.parse(pipeJson.output) as PageExtractResult
    expect(pipeParsed.ok).toBe(true)
    expect(pipeParsed.links).toHaveLength(1)
    expect(pipeParsed.links![0]!.external).toBe(true)
  })
})
