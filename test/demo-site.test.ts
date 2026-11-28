import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createDemoServer,
  escapeHtml,
  formatDemoBanner,
  parseDemoCliArgs,
  type DemoServerHandle,
} from '../src/demo/server.js'
import { LiteBrowserEngine } from '../src/engine/lite.js'
import { renderPageAscii } from '../src/ascii/layout.js'
import { isStrictAscii } from '../src/ascii/sanitize.js'

describe('Interactive Demo Server (M91)', () => {
  let demo: DemoServerHandle
  let baseUrl: string

  beforeAll(async () => {
    demo = createDemoServer({ host: '127.0.0.1', port: 0 })
    const started = await demo.start()
    baseUrl = started.url
  })

  beforeEach(() => {
    demo.reset()
  })

  afterAll(async () => {
    await demo.stop()
  })

  it('serves all demo HTML pages and 404 fallback cleanly', async () => {
    const routes = [
      { path: '/', expected: 'Welcome to the ASCII Browser Playground' },
      { path: '/forms', expected: 'Interactive Forms Showcase' },
      { path: '/tables', expected: 'EC2 Fleet Telemetry Table' },
      { path: '/dynamic', expected: 'Dynamic JavaScript Playground' },
      { path: '/canvas', expected: 'Canvas Art in ASCII' },
    ]

    for (const r of routes) {
      const res = await fetch(`${baseUrl}${r.path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain(r.expected)
    }

    const notFound = await fetch(`${baseUrl}/does-not-exist`)
    expect(notFound.status).toBe(404)
    expect(await notFound.text()).toContain('404 Not Found')
  })

  it('validates CSRF and required fields on POST /forms and escapes HTML', async () => {
    // Missing CSRF token
    const badCsrf = await fetch(`${baseUrl}/forms`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        service_name: 'test-svc',
        owner_email: 'a@example.com',
      }).toString(),
    })
    expect(badCsrf.status).toBe(400)
    expect(await badCsrf.text()).toContain('Invalid or missing CSRF token')

    // Missing required fields
    const missingFields = await fetch(`${baseUrl}/forms`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf_token: demo.state.csrfToken,
        service_name: '',
        owner_email: '',
      }).toString(),
    })
    expect(missingFields.status).toBe(400)
    expect(await missingFields.text()).toContain('Service Name and Owner Email are required')

    // Valid submission with HTML characters to verify escaping
    const ok = await fetch(`${baseUrl}/forms`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf_token: demo.state.csrfToken,
        service_name: 'troy-<script>alert(1)</script>',
        owner_email: 'ops@example.com',
        region: 'us-west-2',
        instance_type: 't4g.small',
        enable_watchdog: '1',
        notes: 'Canary rollout',
      }).toString(),
    })
    expect(ok.status).toBe(200)
    const body = await ok.text()
    expect(body).toContain('Deployment #2 queued')
    expect(body).toContain('troy-&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('troy-<script>alert(1)</script>')
    expect(demo.state.deployments.length).toBe(2)
  })

  it('filters and sorts /tables by query, status, and latency', async () => {
    const res = await fetch(`${baseUrl}/tables?q=arm64&status=healthy&sort=latency`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Showing 3 of 6 nodes (sorted by latency)')
    const idxGraviton = html.indexOf('troy-graviton-01')
    const idxEdge1 = html.indexOf('troy-edge-01')
    const idxEdge2 = html.indexOf('troy-edge-02')
    expect(idxGraviton).toBeGreaterThan(-1)
    expect(idxEdge1).toBeGreaterThan(idxGraviton)
    expect(idxEdge2).toBeGreaterThan(idxEdge1)
    expect(html).not.toContain('troy-worker-01')
  })

  it('supports /api/status and full CRUD on /api/tasks', async () => {
    const statusRes = await fetch(`${baseUrl}/api/status`)
    expect(statusRes.status).toBe(200)
    const statusJson = (await statusRes.json()) as { status: string; tasksCount: number }
    expect(statusJson.status).toBe('ok')
    expect(statusJson.tasksCount).toBe(3)

    // Create task
    const postRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Verify demo canvas' }),
    })
    expect(postRes.status).toBe(201)
    const created = (await postRes.json()) as { task: { id: number; title: string; done: boolean } }
    expect(created.task.title).toBe('Verify demo canvas')
    expect(created.task.done).toBe(false)

    // Toggle task
    const patchRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.task.id, done: true }),
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { task: { done: boolean } }
    expect(patched.task.done).toBe(true)

    // Delete task
    const delRes = await fetch(`${baseUrl}/api/tasks?id=${created.task.id}`, {
      method: 'DELETE',
    })
    expect(delRes.status).toBe(200)
    expect(demo.state.tasks.some((t) => t.id === created.task.id)).toBe(false)
  })

  it('renders forms, tables, dynamic page, canvas, and JSON cleanly via LiteBrowserEngine + ASCII', async () => {
    const engine = new LiteBrowserEngine()
    try {
      // 1. Tables page renders aligned ASCII table
      const tab = await engine.createTab(`${baseUrl}/tables`)
      const tablesSnap = await tab.snapshot()
      const tablesAscii = renderPageAscii(tablesSnap, { width: 100, height: 80 })
      expect(isStrictAscii(tablesAscii)).toBe(true)
      expect(tablesAscii).toContain('EC2 Fleet Telemetry Table')
      expect(tablesAscii).toContain('+---')
      expect(tablesAscii).toContain('troy-graviton-01')

      // 2. Forms page: fill & submit via LiteBrowserEngine (hidden CSRF token auto-included!)
      await tab.navigate(`${baseUrl}/forms`)
      const formsSnap = await tab.snapshot()
      const formsAscii = renderPageAscii(formsSnap, { width: 100, height: 80 })
      expect(isStrictAscii(formsAscii)).toBe(true)
      expect(formsAscii).toContain('Deploy Troy Node')

      const serviceInput = formsSnap.elements.find((e) => e.name === 'service_name')
      const emailInput = formsSnap.elements.find((e) => e.name === 'owner_email')
      const submitBtn = formsSnap.elements.find(
        (e) => e.tag === 'button' && e.text.includes('Submit Deployment'),
      )
      expect(serviceInput).toBeDefined()
      expect(emailInput).toBeDefined()
      expect(submitBtn).toBeDefined()

      await tab.fill(serviceInput!.selector, 'troy-lite-demo')
      await tab.fill(emailInput!.selector, 'lite@example.com')
      await tab.click(submitBtn!.selector)

      const afterSubmitSnap = await tab.snapshot()
      const afterSubmitAscii = renderPageAscii(afterSubmitSnap, { width: 100, height: 80 })
      expect(afterSubmitAscii).toContain('Deployment #2 queued for troy-lite-demo')
      expect(afterSubmitAscii).toContain('lite@example.com')

      // 3. Canvas page renders scene guide and canvas element info
      await tab.navigate(`${baseUrl}/canvas?scene=wireframe`)
      const canvasSnap = await tab.snapshot()
      const canvasAscii = renderPageAscii(canvasSnap, { width: 100, height: 80 })
      expect(isStrictAscii(canvasAscii)).toBe(true)
      expect(canvasAscii).toContain('Canvas Art in ASCII')
      expect(canvasAscii).toContain('wireframe')

      // 4. JSON status endpoint renders cleanly in LiteBrowserEngine
      await tab.navigate(`${baseUrl}/api/status`)
      const statusSnap = await tab.snapshot()
      const statusAscii = renderPageAscii(statusSnap, { width: 100, height: 80 })
      expect(isStrictAscii(statusAscii)).toBe(true)
      expect(statusAscii).toContain('troy-advanced-demo')
    } finally {
      await engine.close()
    }
  })

  it('parses CLI arguments and formats the startup banner', () => {
    expect(parseDemoCliArgs([])).toMatchObject({ host: '127.0.0.1', port: 4173, help: false })
    expect(parseDemoCliArgs(['--host', '0.0.0.0', '-p', '8080'])).toEqual({
      host: '0.0.0.0',
      port: 8080,
      help: false,
    })
    expect(parseDemoCliArgs(['--host=127.0.0.1', '--port=0', '--help'])).toEqual({
      host: '127.0.0.1',
      port: 0,
      help: true,
    })

    const banner = formatDemoBanner('http://127.0.0.1:4173')
    expect(isStrictAscii(banner)).toBe(true)
    expect(banner).toContain('http://127.0.0.1:4173/forms')
    expect(banner).toContain('http://127.0.0.1:4173/canvas')
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
