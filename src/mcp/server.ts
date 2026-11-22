// Native Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio.
// Enables Claude Code, Dexter, Codex, Cursor, and any MCP client to drive
// Troy Advanced in pure ASCII or structured JSON directly on EC2 or local terminals.

import readline from 'node:readline'
import type { BrowserManager } from '../engine/manager.js'

const MCP_TOOLS = [
  {
    name: 'troy_open',
    description: 'Open a new browser tab at a URL or search query.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL or search query to open' } },
      required: ['url'],
    },
  },
  {
    name: 'troy_tabs',
    description: 'List open browser tabs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'troy_read_ascii',
    description: 'Render the active or target tab as a strict 7-bit ASCII viewport with inline [eN] interactive element refs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        width: { type: 'number', description: 'Viewport character width (default depends on density: 80 compact / 100 normal / 140 wide)' },
        height: { type: 'number', description: 'Viewport row height (default depends on density: 28 compact / 36 normal / 48 wide)' },
        layout: { type: 'string', enum: ['flow', 'spatial', 'auto'], description: 'Layout mode: flow (linear), spatial (2D box coordinates), or auto' },
        density: { type: 'string', enum: ['compact', 'normal', 'wide'], description: 'Density profile: compact (small LLM token budgets), normal (default), or wide (140-col)' },
        crop: { type: 'string', description: 'Region crop in viewport pixels: "x,y,w,h"' },
        ref: { type: 'string', description: 'Element ref (e.g. "e5") whose bounding box to zoom into' },
        since: { type: 'boolean', description: 'Return only structural delta since previous read' },
      },
    },
  },
  {
    name: 'troy_screenshot_ascii',
    description: 'Capture a Chromium screenshot and render it as ASCII, Sobel edge wireframe, Braille, or halfblock art with optional [eN] overlays and region crop for text-only AIs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        mode: { type: 'string', enum: ['ascii', 'edge', 'braille', 'halfblock'] },
        edgeThreshold: { type: 'number', description: 'Sobel edge magnitude threshold (0..1, default 0.18) for mode=edge' },
        crop: { type: 'string', description: 'Region crop in viewport pixels: "x,y,w,h"' },
        ref: { type: 'string', description: 'Element ref (e.g. "e5") whose bounding box to crop/zoom into' },
        overlayStyle: { type: 'string', enum: ['box', 'badge'] },
        annotate: { type: 'boolean' },
      },
    },
  },
  {
    name: 'troy_find',
    description: 'Find interactive elements matching a query and return their eN refs.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, tabId: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'troy_click',
    description: 'Click an element by ref (e.g. e3). Pass allowSubmit: true for commit/submit actions.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, tabId: { type: 'number' }, allowSubmit: { type: 'boolean' } },
      required: ['ref'],
    },
  },
  {
    name: 'troy_fill',
    description: 'Fill a text field by ref.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' }, tabId: { type: 'number' }, clear: { type: 'boolean' } },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'troy_act',
    description: 'Execute a batch of actions (click/fill/select/press/scroll/wait/read_ascii).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        allowSubmit: { type: 'boolean' },
        steps: { type: 'array', items: { type: 'object' } },
      },
      required: ['steps'],
    },
  },
  {
    name: 'troy_grant',
    description: 'Grant an http(s) origin to the session autonomy boundary.',
    inputSchema: {
      type: 'object',
      properties: { origin: { type: 'string' } },
      required: ['origin'],
    },
  },
  {
    name: 'troy_recall',
    description: 'Search persistent cross-session page memory.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, origin: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
]

export async function handleMcpRequest(
  manager: BrowserManager,
  req: { jsonrpc?: string; id?: string | number | null; method: string; params?: Record<string, unknown> },
): Promise<Record<string, unknown> | null> {
  const id = req.id ?? null

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'troy-advanced', version: '0.1.0' },
      },
    }
  }

  if (req.method === 'notifications/initialized') {
    return null
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }
  }

  if (req.method === 'tools/call') {
    const params = req.params ?? {}
    const name = String(params.name ?? '')
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>
    const tabId = typeof args.tabId === 'number' ? args.tabId : undefined

    let result: Record<string, unknown>
    switch (name) {
      case 'troy_open':
        result = await manager.openTab(String(args.url ?? ''), { activate: true })
        break
      case 'troy_tabs':
        result = { ok: true, tabs: manager.listTabs() }
        break
      case 'troy_read_ascii':
        result = await manager.runTool(tabId, 'page_read_ascii', {
          width: args.width,
          height: args.height,
          layout: args.layout,
          density: args.density,
          crop: args.crop,
          ref: args.ref,
          since: args.since,
          asciiOnly: true,
        })
        break
      case 'troy_screenshot_ascii':
        result = await manager.runTool(tabId, 'page_screenshot_ascii', {
          width: args.width,
          height: args.height,
          mode: args.mode,
          edgeThreshold: args.edgeThreshold,
          crop: args.crop,
          ref: args.ref,
          overlayStyle: args.overlayStyle,
          annotate: args.annotate,
        })
        break
      case 'troy_find':
        result = await manager.runTool(tabId, 'page_find', { query: args.query })
        break
      case 'troy_click':
        result = await manager.runTool(tabId, 'page_click', { ref: args.ref, allowSubmit: args.allowSubmit })
        break
      case 'troy_fill':
        result = await manager.runTool(tabId, 'page_fill', { ref: args.ref, text: args.text, clear: args.clear })
        break
      case 'troy_act':
        result = await manager.runTool(tabId, 'page_act', { steps: args.steps, allowSubmit: args.allowSubmit })
        break
      case 'troy_grant':
        result = manager.grantOrigin(String(args.origin ?? ''))
        break
      case 'troy_recall':
        result = manager.memory
          ? {
              ok: true,
              ...manager.memory.recall(String(args.query ?? ''), {
                origin: typeof args.origin === 'string' ? args.origin : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
              }),
            }
          : { ok: false, error: 'memory disabled' }
        break
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown MCP tool: ${name}` },
        }
    }

    const text =
      (name === 'troy_read_ascii' || name === 'troy_screenshot_ascii') && typeof result.ascii === 'string'
        ? result.ascii
        : JSON.stringify(result, null, 2)

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text }],
        isError: result.ok === false,
      },
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  }
}

export async function runMcpStdioServer(
  manager: BrowserManager,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const rawLine of rl) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const req = JSON.parse(line) as { jsonrpc?: string; id?: string | number | null; method: string; params?: Record<string, unknown> }
      const res = await handleMcpRequest(manager, req)
      if (res) {
        output.write(`${JSON.stringify(res)}\n`)
      }
    } catch (err) {
      output.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: String((err as Error)?.message ?? err) },
        })}\n`,
      )
    }
  }
}
