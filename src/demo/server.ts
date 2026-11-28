import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface DemoTask {
  id: number
  title: string
  done: boolean
  createdAt: string
}

export interface DemoDeployment {
  id: number
  serviceName: string
  ownerEmail: string
  region: string
  instanceType: string
  enableWatchdog: boolean
  notes: string
  submittedAt: string
}

export interface DemoInstanceRow {
  name: string
  arch: 'x86_64' | 'arm64'
  vcpu: number
  ramGb: number
  region: string
  status: 'healthy' | 'degraded' | 'idle'
  latencyMs: number
}

export interface DemoServerOptions {
  host?: string
  port?: number
}

export interface DemoServerState {
  csrfToken: string
  startedAt: number
  requestCount: number
  tasks: DemoTask[]
  deployments: DemoDeployment[]
  nextTaskId: number
  nextDeploymentId: number
}

export interface DemoServerHandle {
  server: http.Server
  state: DemoServerState
  start(): Promise<{ host: string; port: number; url: string }>
  stop(): Promise<void>
  url(): string
  reset(): void
}

export interface DemoCliOptions {
  host: string
  port: number
  help: boolean
}

const DEFAULT_INSTANCES: DemoInstanceRow[] = [
  { name: 'troy-edge-01', arch: 'arm64', vcpu: 2, ramGb: 4, region: 'us-east-1', status: 'healthy', latencyMs: 11 },
  { name: 'troy-edge-02', arch: 'arm64', vcpu: 4, ramGb: 8, region: 'us-west-2', status: 'healthy', latencyMs: 14 },
  { name: 'troy-worker-01', arch: 'x86_64', vcpu: 4, ramGb: 16, region: 'eu-west-1', status: 'healthy', latencyMs: 23 },
  { name: 'troy-worker-02', arch: 'x86_64', vcpu: 8, ramGb: 32, region: 'ap-northeast-1', status: 'degraded', latencyMs: 68 },
  { name: 'troy-graviton-01', arch: 'arm64', vcpu: 2, ramGb: 2, region: 'us-east-1', status: 'healthy', latencyMs: 9 },
  { name: 'troy-staging-01', arch: 'x86_64', vcpu: 2, ramGb: 4, region: 'us-east-2', status: 'idle', latencyMs: 19 },
]

function createInitialState(): DemoServerState {
  return {
    csrfToken: 'troy-demo-csrf-91',
    startedAt: Date.now(),
    requestCount: 0,
    nextTaskId: 4,
    nextDeploymentId: 2,
    tasks: [
      { id: 1, title: 'Inspect ASCII layout tables', done: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, title: 'Submit deployment form via Lite engine', done: false, createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 3, title: 'Render canvas art in Braille and Edge modes', done: false, createdAt: '2026-01-01T00:02:00.000Z' },
    ],
    deployments: [
      {
        id: 1,
        serviceName: 'troy-daemon-prod',
        ownerEmail: 'ops@example.com',
        region: 'us-east-1',
        instanceType: 't4g.medium',
        enableWatchdog: true,
        notes: 'Initial Graviton deployment',
        submittedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderShell(title: string, activePath: string, body: string): string {
  const navItems: Array<{ href: string; label: string }> = [
    { href: '/', label: 'Home' },
    { href: '/forms', label: 'Forms' },
    { href: '/tables', label: 'Tables' },
    { href: '/dynamic', label: 'Dynamic JS' },
    { href: '/canvas', label: 'Canvas Art' },
    { href: '/api/status', label: 'Status JSON' },
  ]
  const navHtml = navItems
    .map((item) => {
      const current = item.href === activePath ? ' aria-current="page"' : ''
      return `<a href="${item.href}"${current}>${escapeHtml(item.label)}</a>`
    })
    .join(' | ')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Troy Advanced Demo</title>
  <style>
    body { font-family: monospace; max-width: 960px; margin: 24px auto; padding: 0 16px; background: #0f172a; color: #e2e8f0; }
    header, main, footer { margin-bottom: 24px; }
    nav a { color: #38bdf8; text-decoration: none; margin-right: 8px; }
    nav a[aria-current="page"] { color: #facc15; font-weight: bold; text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #475569; padding: 6px 10px; text-align: left; }
    th { background: #1e293b; }
    fieldset { border: 1px solid #475569; padding: 14px; margin: 14px 0; }
    label { display: block; margin: 8px 0 4px; }
    input, select, textarea, button { font-family: monospace; padding: 6px 8px; }
    .card { border: 1px solid #334155; padding: 12px; margin: 12px 0; background: #1e293b; }
    .notice { border: 1px solid #22c55e; padding: 10px; margin: 12px 0; background: #052e16; color: #bbf7d0; }
    .error { border: 1px solid #ef4444; padding: 10px; margin: 12px 0; background: #450a0a; color: #fecaca; }
    canvas { border: 2px solid #94a3b8; background: #020617; display: block; margin: 12px 0; }
  </style>
</head>
<body>
  <header>
    <h1>Troy Advanced Interactive Demo</h1>
    <nav aria-label="Demo Navigation">${navHtml}</nav>
  </header>
  <main>
${body}
  </main>
  <footer>
    <p>Troy Advanced Local Demo Server &mdash; Built for ASCII, Braille, Lite, and Chromium CDP testing.</p>
  </footer>
</body>
</html>`
}

function renderHomePage(state: DemoServerState): string {
  const healthyCount = DEFAULT_INSTANCES.filter((r) => r.status === 'healthy').length
  const body = `
    <section class="card">
      <h2>Welcome to the ASCII Browser Playground</h2>
      <p>Use this local server to test forms, aligned ASCII tables, dynamic JavaScript widgets, and HTML5 canvas rendering in both Lite and Chromium engines.</p>
      <form action="/tables" method="get" aria-label="Quick Instance Search">
        <fieldset>
          <legend>Quick Fleet Search</legend>
          <label for="quick-q">Search instances by name, arch, or region</label>
          <input id="quick-q" name="q" type="text" placeholder="e.g. graviton or arm64" />
          <button type="submit">Search Fleet</button>
        </fieldset>
      </form>
    </section>

    <section>
      <h2>Demo Capabilities</h2>
      <table>
        <thead>
          <tr>
            <th>Section</th>
            <th>Route</th>
            <th>Highlights</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Interactive Forms</td>
            <td><a href="/forms">/forms</a></td>
            <td>CSRF hidden fields, select, checkbox, textarea, validation</td>
            <td>${state.deployments.length} submitted</td>
          </tr>
          <tr>
            <td>Data Tables</td>
            <td><a href="/tables">/tables</a></td>
            <td>Auto-aligned columns, query filtering, column sorting</td>
            <td>${healthyCount}/${DEFAULT_INSTANCES.length} healthy</td>
          </tr>
          <tr>
            <td>Dynamic JS</td>
            <td><a href="/dynamic">/dynamic</a></td>
            <td>Live counter, fetch task API, ARIA tabs, async widget</td>
            <td>${state.tasks.length} tasks</td>
          </tr>
          <tr>
            <td>Canvas Art</td>
            <td><a href="/canvas">/canvas</a></td>
            <td>High-contrast geometric scenes for ASCII, Braille, and Edge modes</td>
            <td>4 scenes</td>
          </tr>
        </tbody>
      </table>
    </section>
  `
  return renderShell('Home', '/', body)
}

function renderFormsPage(
  state: DemoServerState,
  feedback?: { kind: 'ok' | 'error'; message: string },
): string {
  const banner = feedback
    ? `<div class="${feedback.kind === 'ok' ? 'notice' : 'error'}" role="status"><p>${escapeHtml(feedback.message)}</p></div>`
    : ''

  const rows = state.deployments
    .map(
      (d) => `<tr>
        <td>#${d.id}</td>
        <td>${escapeHtml(d.serviceName)}</td>
        <td>${escapeHtml(d.ownerEmail)}</td>
        <td>${escapeHtml(d.region)}</td>
        <td>${escapeHtml(d.instanceType)}</td>
        <td>${d.enableWatchdog ? 'enabled' : 'disabled'}</td>
      </tr>`,
    )
    .join('\n')

  const body = `
    <section>
      <h2>Interactive Forms Showcase</h2>
      <p>Submit the deployment configuration form below. Works in both Lite engine (HTTP POST + hidden CSRF token) and Chromium CDP.</p>
      ${banner}
      <form action="/forms" method="post" aria-label="EC2 Deployment Form">
        <fieldset>
          <legend>Deploy Troy Node</legend>
          <input type="hidden" name="csrf_token" value="${escapeHtml(state.csrfToken)}" />

          <label for="service-name">Service Name</label>
          <input id="service-name" name="service_name" type="text" placeholder="troy-agent-01" required />

          <label for="owner-email">Owner Email</label>
          <input id="owner-email" name="owner_email" type="email" placeholder="ops@example.com" required />

          <label for="aws-region">AWS Region</label>
          <select id="aws-region" name="region">
            <option value="us-east-1">us-east-1 (N. Virginia)</option>
            <option value="us-west-2">us-west-2 (Oregon)</option>
            <option value="eu-west-1">eu-west-1 (Ireland)</option>
            <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
          </select>

          <label for="instance-type">Instance Type</label>
          <select id="instance-type" name="instance_type">
            <option value="t4g.small">t4g.small (ARM64 2GB)</option>
            <option value="t4g.medium">t4g.medium (ARM64 4GB)</option>
            <option value="t3.medium">t3.medium (x86_64 4GB)</option>
            <option value="c7g.large">c7g.large (ARM64 4GB)</option>
          </select>

          <label for="enable-watchdog">
            <input id="enable-watchdog" name="enable_watchdog" type="checkbox" value="1" checked />
            Enable memory watchdog (--max-rss-mb)
          </label>

          <label for="deploy-notes">Deployment Notes</label>
          <textarea id="deploy-notes" name="notes" rows="3" placeholder="Optional rollout notes"></textarea>

          <div>
            <button type="submit">Submit Deployment</button>
          </div>
        </fieldset>
      </form>
    </section>

    <section>
      <h2>Safety Guard Showcase (Sensitive Field)</h2>
      <p>Troy refuses automated fills on password/secret inputs by default unless explicitly overridden.</p>
      <form action="/forms" method="post" aria-label="Sensitive Secret Form">
        <fieldset>
          <legend>API Credentials Check</legend>
          <label for="api-secret">API Secret Token</label>
          <input id="api-secret" name="api_secret" type="password" placeholder="Do not auto-fill" />
        </fieldset>
      </form>
    </section>

    <section>
      <h2>Submitted Deployments</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Service</th>
            <th>Owner</th>
            <th>Region</th>
            <th>Instance</th>
            <th>Watchdog</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
  `
  return renderShell('Forms', '/forms', body)
}

function renderTablesPage(query: URLSearchParams): string {
  const q = (query.get('q') ?? '').trim().toLowerCase()
  const statusFilter = (query.get('status') ?? '').trim().toLowerCase()
  const sort = (query.get('sort') ?? 'name').trim().toLowerCase()

  let filtered = DEFAULT_INSTANCES.filter((row) => {
    if (statusFilter && statusFilter !== 'all' && row.status !== statusFilter) {
      return false
    }
    if (!q) return true
    return (
      row.name.toLowerCase().includes(q) ||
      row.arch.toLowerCase().includes(q) ||
      row.region.toLowerCase().includes(q) ||
      row.status.toLowerCase().includes(q)
    )
  })

  filtered = [...filtered].sort((a, b) => {
    if (sort === 'latency') return a.latencyMs - b.latencyMs
    if (sort === 'ram') return b.ramGb - a.ramGb
    if (sort === 'vcpu') return b.vcpu - a.vcpu
    return a.name.localeCompare(b.name)
  })

  const rowsHtml =
    filtered.length > 0
      ? filtered
          .map(
            (r) => `<tr>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.arch)}</td>
            <td>${r.vcpu}</td>
            <td>${r.ramGb} GB</td>
            <td>${escapeHtml(r.region)}</td>
            <td>${escapeHtml(r.status)}</td>
            <td>${r.latencyMs} ms</td>
          </tr>`,
          )
          .join('\n')
      : '<tr><td colspan="7">No matching instances found.</td></tr>'

  const qs = (nextSort: string) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (statusFilter) p.set('status', statusFilter)
    p.set('sort', nextSort)
    return `/tables?${p.toString()}`
  }

  const body = `
    <section>
      <h2>EC2 Fleet Telemetry Table</h2>
      <p>Demonstrates auto-aligned ASCII table borders, query filtering, and server-side sorting.</p>

      <form action="/tables" method="get" aria-label="Filter Instances">
        <fieldset>
          <legend>Filter Fleet</legend>
          <label for="filter-q">Keyword</label>
          <input id="filter-q" name="q" type="text" value="${escapeHtml(q)}" placeholder="graviton, arm64, us-east-1" />

          <label for="filter-status">Status</label>
          <select id="filter-status" name="status">
            <option value="all"${!statusFilter || statusFilter === 'all' ? ' selected' : ''}>All statuses</option>
            <option value="healthy"${statusFilter === 'healthy' ? ' selected' : ''}>healthy</option>
            <option value="degraded"${statusFilter === 'degraded' ? ' selected' : ''}>degraded</option>
            <option value="idle"${statusFilter === 'idle' ? ' selected' : ''}>idle</option>
          </select>

          <input type="hidden" name="sort" value="${escapeHtml(sort)}" />
          <button type="submit">Apply Filter</button>
          <a href="/tables">Reset</a>
        </fieldset>
      </form>

      <p>Sort by:
        <a href="${qs('name')}">Name</a> |
        <a href="${qs('latency')}">Latency (asc)</a> |
        <a href="${qs('ram')}">RAM (desc)</a> |
        <a href="${qs('vcpu')}">vCPU (desc)</a>
      </p>

      <p>Showing ${filtered.length} of ${DEFAULT_INSTANCES.length} nodes (sorted by ${escapeHtml(sort)}).</p>

      <table>
        <thead>
          <tr>
            <th>Instance</th>
            <th>Arch</th>
            <th>vCPU</th>
            <th>RAM</th>
            <th>Region</th>
            <th>Status</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </section>
  `
  return renderShell('Tables', '/tables', body)
}

function renderDynamicPage(state: DemoServerState): string {
  const initialTasksHtml = state.tasks
    .map(
      (t) =>
        `<li data-task-id="${t.id}">[${t.done ? 'x' : ' '}] ${escapeHtml(t.title)}</li>`,
    )
    .join('\n')

  const body = `
    <section class="card">
      <h2>Dynamic JavaScript Playground</h2>
      <p>Test interactive DOM mutations, <code>--since</code> delta snapshots, and <code>page_wait</code> in Chromium CDP mode.</p>
    </section>

    <section class="card">
      <h3>1. Live Counter</h3>
      <p>Current Count: <strong id="counter-value">0</strong></p>
      <button id="btn-dec" type="button">-1 Decrement</button>
      <button id="btn-inc" type="button">+1 Increment</button>
      <button id="btn-reset" type="button">Reset Counter</button>
    </section>

    <section class="card">
      <h3>2. Live API Task Board</h3>
      <form id="task-form" action="/api/tasks" method="post" aria-label="Add Task Form">
        <label for="new-task-input">New Task Title</label>
        <input id="new-task-input" name="title" type="text" placeholder="Run ASCII benchmark" />
        <button id="btn-add-task" type="submit">Add Task</button>
      </form>
      <ul id="task-list">
        ${initialTasksHtml}
      </ul>
    </section>

    <section class="card">
      <h3>3. ARIA Tab Switcher</h3>
      <div role="tablist" aria-label="Diagnostics Tabs">
        <button type="button" role="tab" id="tab-overview" aria-selected="true" data-panel="panel-overview">Overview</button>
        <button type="button" role="tab" id="tab-metrics" aria-selected="false" data-panel="panel-metrics">Metrics</button>
        <button type="button" role="tab" id="tab-logs" aria-selected="false" data-panel="panel-logs">Logs</button>
      </div>
      <div id="panel-overview" role="tabpanel">
        <p>Overview Panel: All subsystems nominal. ASCII layout engine ready.</p>
      </div>
      <div id="panel-metrics" role="tabpanel" hidden>
        <p>Metrics Panel: Median ASCII layout 0.4ms | CDP snapshot 18ms | RSS 64MB.</p>
      </div>
      <div id="panel-logs" role="tabpanel" hidden>
        <p>Logs Panel: [INFO] Demo server listening | [INFO] Agent Socket ready.</p>
      </div>
    </section>

    <section class="card">
      <h3>4. Async Status Loader</h3>
      <button id="btn-load-async" type="button">Load Async Status</button>
      <p id="async-output" aria-live="polite">Idle - click to fetch /api/status</p>
    </section>

    <script>
      (() => {
        let count = 0;
        const counterEl = document.getElementById('counter-value');
        const renderCounter = () => { counterEl.textContent = String(count); };
        document.getElementById('btn-inc').addEventListener('click', () => { count += 1; renderCounter(); });
        document.getElementById('btn-dec').addEventListener('click', () => { count -= 1; renderCounter(); });
        document.getElementById('btn-reset').addEventListener('click', () => { count = 0; renderCounter(); });

        const taskList = document.getElementById('task-list');
        const taskForm = document.getElementById('task-form');
        const taskInput = document.getElementById('new-task-input');

        async function refreshTasks() {
          const res = await fetch('/api/tasks');
          const data = await res.json();
          taskList.innerHTML = '';
          for (const task of data.tasks) {
            const li = document.createElement('li');
            li.dataset.taskId = String(task.id);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = task.done ? '[x] ' + task.title : '[ ] ' + task.title;
            btn.addEventListener('click', async () => {
              await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: task.id, done: !task.done }),
              });
              await refreshTasks();
            });
            li.appendChild(btn);
            taskList.appendChild(li);
          }
        }

        taskForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const title = taskInput.value.trim();
          if (!title) return;
          await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title }),
          });
          taskInput.value = '';
          await refreshTasks();
        });

        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        for (const tab of tabs) {
          tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-panel');
            for (const other of tabs) {
              const selected = other === tab;
              other.setAttribute('aria-selected', selected ? 'true' : 'false');
              const panel = document.getElementById(other.getAttribute('data-panel'));
              if (panel) panel.hidden = !selected;
            }
          });
        }

        const asyncBtn = document.getElementById('btn-load-async');
        const asyncOut = document.getElementById('async-output');
        asyncBtn.addEventListener('click', async () => {
          asyncOut.textContent = 'Loading...';
          await new Promise((r) => setTimeout(r, 120));
          const res = await fetch('/api/status');
          const data = await res.json();
          asyncOut.textContent = 'Status: ' + data.status + ' | Requests: ' + data.requests + ' | Tasks: ' + data.tasksCount;
        });

        refreshTasks().catch(() => {});
      })();
    </script>
  `
  return renderShell('Dynamic JS', '/dynamic', body)
}

function renderCanvasPage(query: URLSearchParams): string {
  const initialScene = ['orbit', 'chart', 'wireframe', 'checker'].includes(query.get('scene') ?? '')
    ? (query.get('scene') as string)
    : 'orbit'

  const body = `
    <section class="card">
      <h2>Canvas Art in ASCII</h2>
      <p>Switch between high-contrast geometric scenes below, then capture with <code>troy-advanced ascii --visual</code>, <code>--mode braille</code>, or <code>--mode edge</code>.</p>
      <div role="group" aria-label="Canvas Scenes">
        <button type="button" id="scene-orbit" data-scene="orbit">Orbit Scene</button>
        <button type="button" id="scene-chart" data-scene="chart">Bar Chart</button>
        <button type="button" id="scene-wireframe" data-scene="wireframe">Wireframe Pyramid</button>
        <button type="button" id="scene-checker" data-scene="checker">Checker Grid</button>
      </div>
      <p>Active Scene: <strong id="active-scene-label">${escapeHtml(initialScene)}</strong></p>
      <canvas id="demo-canvas" width="320" height="180" data-scene="${escapeHtml(initialScene)}" aria-label="Interactive ASCII Art Canvas">
        Canvas fallback: Interactive geometric art (${escapeHtml(initialScene)} scene, 320x180).
      </canvas>
    </section>

    <section>
      <h3>Scene Guide</h3>
      <table>
        <thead>
          <tr><th>Scene</th><th>Best ASCII Mode</th><th>Visual Features</th></tr>
        </thead>
        <tbody>
          <tr><td>orbit</td><td>braille / ascii</td><td>Concentric planetary rings and filled sun</td></tr>
          <tr><td>chart</td><td>halfblock / ascii</td><td>High-contrast vertical benchmark bars</td></tr>
          <tr><td>wireframe</td><td>edge</td><td>Crisp diagonal pyramid and horizon lines</td></tr>
          <tr><td>checker</td><td>ascii / braille</td><td>Alternating high-contrast luminance tiles</td></tr>
        </tbody>
      </table>
    </section>

    <script>
      (() => {
        const canvas = document.getElementById('demo-canvas');
        const ctx = canvas.getContext('2d');
        const label = document.getElementById('active-scene-label');

        function drawScene(scene) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, w, h);

          if (scene === 'orbit') {
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 2;
            for (const r of [35, 58, 82]) {
              ctx.beginPath();
              ctx.ellipse(w / 2, h / 2, r * 1.45, r * 0.72, 0, 0, Math.PI * 2);
              ctx.stroke();
            }
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(w / 2, h / 2, 20, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.arc(w / 2 + 84, h / 2 - 14, 9, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#facc15';
            ctx.beginPath();
            ctx.arc(w / 2 - 115, h / 2 + 12, 7, 0, Math.PI * 2);
            ctx.fill();
          } else if (scene === 'chart') {
            const values = [40, 85, 130, 65, 150, 110];
            const barW = 34;
            const gap = 14;
            const startX = 24;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(16, 16);
            ctx.lineTo(16, h - 18);
            ctx.lineTo(w - 16, h - 18);
            ctx.stroke();

            values.forEach((v, idx) => {
              const x = startX + idx * (barW + gap);
              const y = h - 18 - v;
              ctx.fillStyle = idx % 2 === 0 ? '#ffffff' : '#94a3b8';
              ctx.fillRect(x, y, barW, v);
            });
          } else if (scene === 'wireframe') {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(w / 2, 18);
            ctx.lineTo(44, h - 24);
            ctx.lineTo(w - 44, h - 24);
            ctx.closePath();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(w / 2, 18);
            ctx.lineTo(w / 2, h - 24);
            ctx.moveTo(20, h - 56);
            ctx.lineTo(w - 20, h - 56);
            ctx.stroke();
          } else if (scene === 'checker') {
            const size = 20;
            for (let y = 0; y < h; y += size) {
              for (let x = 0; x < w; x += size) {
                const on = ((x / size) + (y / size)) % 2 === 0;
                ctx.fillStyle = on ? '#ffffff' : '#111827';
                ctx.fillRect(x, y, size, size);
              }
            }
          }

          canvas.setAttribute('data-scene', scene);
          label.textContent = scene;
        }

        for (const btn of document.querySelectorAll('button[data-scene]')) {
          btn.addEventListener('click', () => {
            drawScene(btn.getAttribute('data-scene') || 'orbit');
          });
        }

        drawScene(canvas.getAttribute('data-scene') || 'orbit');
      })();
    </script>
  `
  return renderShell('Canvas Art', '/canvas', body)
}

async function readRequestBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(html)
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload, null, 2))
}

export function createDemoServer(options: DemoServerOptions = {}): DemoServerHandle {
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 4173
  const state = createInitialState()
  let boundPort = requestedPort

  const server = http.createServer(async (req, res) => {
    state.requestCount += 1
    const method = (req.method ?? 'GET').toUpperCase()
    const parsedUrl = new URL(req.url ?? '/', `http://${host}:${boundPort || requestedPort || 80}`)
    const pathname = parsedUrl.pathname

    try {
      if (pathname === '/' && method === 'GET') {
        sendHtml(res, 200, renderHomePage(state))
        return
      }

      if (pathname === '/forms' && method === 'GET') {
        sendHtml(res, 200, renderFormsPage(state))
        return
      }

      if (pathname === '/forms' && method === 'POST') {
        const raw = await readRequestBody(req)
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
        let fields: Record<string, string> = {}

        if (contentType.includes('application/json')) {
          const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
          for (const [k, v] of Object.entries(parsed)) {
            fields[k] = String(v ?? '')
          }
        } else {
          const params = new URLSearchParams(raw)
          for (const [k, v] of params.entries()) {
            fields[k] = v
          }
        }

        if (fields.csrf_token !== state.csrfToken) {
          sendHtml(
            res,
            400,
            renderFormsPage(state, { kind: 'error', message: 'Invalid or missing CSRF token.' }),
          )
          return
        }

        const serviceName = (fields.service_name ?? '').trim()
        const ownerEmail = (fields.owner_email ?? '').trim()
        if (!serviceName || !ownerEmail) {
          sendHtml(
            res,
            400,
            renderFormsPage(state, {
              kind: 'error',
              message: 'Service Name and Owner Email are required.',
            }),
          )
          return
        }

        const entry: DemoDeployment = {
          id: state.nextDeploymentId++,
          serviceName,
          ownerEmail,
          region: (fields.region ?? 'us-east-1').trim() || 'us-east-1',
          instanceType: (fields.instance_type ?? 't4g.medium').trim() || 't4g.medium',
          enableWatchdog: fields.enable_watchdog === '1' || fields.enable_watchdog === 'on' || fields.enable_watchdog === 'true',
          notes: (fields.notes ?? '').trim(),
          submittedAt: new Date().toISOString(),
        }
        state.deployments.unshift(entry)

        sendHtml(
          res,
          200,
          renderFormsPage(state, {
            kind: 'ok',
            message: `Deployment #${entry.id} queued for ${entry.serviceName} in ${entry.region} (${entry.instanceType}).`,
          }),
        )
        return
      }

      if (pathname === '/tables' && method === 'GET') {
        sendHtml(res, 200, renderTablesPage(parsedUrl.searchParams))
        return
      }

      if (pathname === '/dynamic' && method === 'GET') {
        sendHtml(res, 200, renderDynamicPage(state))
        return
      }

      if (pathname === '/canvas' && method === 'GET') {
        sendHtml(res, 200, renderCanvasPage(parsedUrl.searchParams))
        return
      }

      if (pathname === '/api/status' && method === 'GET') {
        sendJson(res, 200, {
          status: 'ok',
          service: 'troy-advanced-demo',
          uptimeMs: Date.now() - state.startedAt,
          requests: state.requestCount,
          tasksCount: state.tasks.length,
          deploymentsCount: state.deployments.length,
          routes: ['/', '/forms', '/tables', '/dynamic', '/canvas', '/api/status', '/api/tasks'],
        })
        return
      }

      if (pathname === '/api/tasks' && method === 'GET') {
        sendJson(res, 200, { tasks: state.tasks })
        return
      }

      if (pathname === '/api/tasks' && method === 'POST') {
        const raw = await readRequestBody(req)
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
        let title = ''
        if (contentType.includes('application/json')) {
          const body = JSON.parse(raw || '{}') as { title?: unknown }
          title = String(body.title ?? '').trim()
        } else {
          title = (new URLSearchParams(raw).get('title') ?? '').trim()
        }

        if (!title) {
          sendJson(res, 400, { error: 'Task title is required' })
          return
        }

        const task: DemoTask = {
          id: state.nextTaskId++,
          title,
          done: false,
          createdAt: new Date().toISOString(),
        }
        state.tasks.push(task)
        sendJson(res, 201, { task, tasks: state.tasks })
        return
      }

      if (pathname === '/api/tasks' && method === 'PATCH') {
        const raw = await readRequestBody(req)
        const body = JSON.parse(raw || '{}') as { id?: number; done?: boolean }
        const task = state.tasks.find((t) => t.id === Number(body.id))
        if (!task) {
          sendJson(res, 404, { error: 'Task not found' })
          return
        }
        if (typeof body.done === 'boolean') {
          task.done = body.done
        }
        sendJson(res, 200, { task, tasks: state.tasks })
        return
      }

      if (pathname === '/api/tasks' && method === 'DELETE') {
        const idParam = parsedUrl.searchParams.get('id')
        const id = Number(idParam)
        const idx = state.tasks.findIndex((t) => t.id === id)
        if (idx === -1) {
          sendJson(res, 404, { error: 'Task not found' })
          return
        }
        const [removed] = state.tasks.splice(idx, 1)
        sendJson(res, 200, { removed, tasks: state.tasks })
        return
      }

      sendHtml(
        res,
        404,
        renderShell('Not Found', '', `<section class="error"><h2>404 Not Found</h2><p>Unknown route: ${escapeHtml(pathname)}</p><p><a href="/">Return Home</a></p></section>`),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
  })

  const url = () => `http://${host}:${boundPort}`

  return {
    server,
    state,
    url,
    reset() {
      const fresh = createInitialState()
      state.csrfToken = fresh.csrfToken
      state.startedAt = fresh.startedAt
      state.requestCount = 0
      state.nextTaskId = fresh.nextTaskId
      state.nextDeploymentId = fresh.nextDeploymentId
      state.tasks.splice(0, state.tasks.length, ...fresh.tasks)
      state.deployments.splice(0, state.deployments.length, ...fresh.deployments)
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(requestedPort, host, () => {
          server.off('error', reject)
          const addr = server.address() as AddressInfo
          boundPort = addr.port
          resolve({ host, port: boundPort, url: url() })
        })
      })
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}

export function parseDemoCliArgs(argv: string[]): DemoCliOptions {
  let host = process.env.DEMO_HOST ?? '127.0.0.1'
  let port = Number.parseInt(process.env.DEMO_PORT ?? '4173', 10)
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    port = 4173
  }
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '--host') {
      const next = argv[i + 1]
      if (next) {
        host = next
        i++
      }
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length)
    } else if (arg === '-p' || arg === '--port') {
      const next = argv[i + 1]
      if (next !== undefined) {
        i++
        const parsed = Number.parseInt(next, 10)
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
          port = parsed
        }
      }
    } else if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10)
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed
      }
    }
  }

  return { host, port, help }
}

export function formatDemoBanner(baseUrl: string): string {
  return [
    '+------------------------------------------------------------------+',
    '|              TROY ADVANCED INTERACTIVE DEMO SERVER               |',
    '+------------------------------------------------------------------+',
    `  URL:        ${baseUrl}`,
    `  Forms:      ${baseUrl}/forms`,
    `  Tables:     ${baseUrl}/tables`,
    `  Dynamic JS: ${baseUrl}/dynamic`,
    `  Canvas Art: ${baseUrl}/canvas`,
    `  Status API: ${baseUrl}/api/status`,
    '',
    '  Try with troy-advanced:',
    `    troy-advanced browse ${baseUrl}`,
    `    troy-advanced ascii ${baseUrl}/tables`,
    `    troy-advanced ascii ${baseUrl}/forms`,
    `    troy-advanced ascii ${baseUrl}/canvas --visual --mode braille`,
    '',
    '  Press Ctrl+C to stop.',
  ].join('\n')
}
