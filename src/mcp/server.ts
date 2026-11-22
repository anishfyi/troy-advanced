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
        width: { type: 'number', description: 'Viewport character width (default 100)' },
        height: { type: 'number', description: 'Viewport row height (default 36)' },
        since: { type: 'boolean', description: 'Return only structural delta since previous read' },
      },
    },
  },
  {
    name: 'troy_screenshot_ascii',
    description: 'Capture a Chromium screenshot and render it as ASCII or Braille art with optional [eN] overlays for text-only AIs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        width: { type: 'number' },
        mode: { type: 'string', enum: ['ascii', 'braille', 'halfblock'] },
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
          since: args.since,
          asciiOnly: true,
        })
        break
      case 'troy_screenshot_ascii':
        result = await manager.runTool(tabId, 'page_screenshot_ascii', {
          width: args.width,
          mode: args.mode,
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
