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
        showMediaSummary: { type: 'boolean', description: 'Append Image/Canvas extraction summary with dimensions, bounding boxes, and <canvas> ASCII previews' },
        since: { type: 'boolean', description: 'Return only structural delta since previous read' },
      },
    },
  },
  {
    name: 'troy_read_markdown',
    description: 'Export the active or target tab as clean CommonMark/GFM Markdown while preserving inline [eN] interactive element refs for hybrid AI workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        showRefs: { type: 'boolean', description: 'Include inline [eN] interactive refs (default true)' },
        includeUrls: { type: 'boolean', description: 'Include link and image URLs (default true)' },
        includeFrontmatter: { type: 'boolean', description: 'Prepend YAML frontmatter with title, url, tabId, epoch, and ref count' },
        includeMediaSummary: { type: 'boolean', description: 'Append Image/Canvas summary with dimensions and <canvas> ASCII previews' },
        asciiOnly: { type: 'boolean', description: 'Sanitize output to strict 7-bit ASCII (default false)' },
        crop: { type: 'string', description: 'Region crop in viewport pixels: "x,y,w,h"' },
        ref: { type: 'string', description: 'Element ref (e.g. "e5") whose bounding box to zoom into' },
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
    name: 'troy_wait',
    description: 'Wait for a page condition (text, CSS selector with state visible|hidden|attached, URL pattern, or network+DOM settle) or a fixed delay in milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        ms: { type: 'number', description: 'Fixed delay in milliseconds when no condition is specified (default 300)' },
        text: { type: 'string', description: 'Wait until page contains this text' },
        selector: { type: 'string', description: 'Wait until CSS selector matches the target state' },
        url: { type: 'string', description: 'Wait until tab URL matches this substring, glob (*), or /regex/' },
        state: { type: 'string', enum: ['visible', 'hidden', 'attached'], description: 'Target state for selector (default visible)' },
        settle: { type: 'boolean', description: 'Wait for network idle and DOM mutations to settle (SPA hydration)' },
        networkIdleMs: { type: 'number', description: 'Network quiet window in ms for settle (default 250)' },
        domQuietMs: { type: 'number', description: 'DOM mutation quiet window in ms for settle (default 200)' },
        timeout: { type: 'number', description: 'Maximum wait time in milliseconds (default 5000)' },
      },
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
  {
    name: 'troy_emulate',
    description:
      'Inspect or configure viewport presets (desktop, mobile, terminal, or custom WxH), User-Agent, Accept-Language, platform, and custom HTTP headers.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        allTabs: { type: 'boolean', description: 'Apply to engine defaults and all open tabs' },
        viewport: {
          type: 'string',
          description: 'Viewport preset ("desktop", "mobile", "terminal") or custom "WxH" (e.g. "1440x900", "390x844@3m")',
        },
        userAgent: { type: 'string', description: 'Custom User-Agent header & navigator.userAgent override' },
        acceptLanguage: { type: 'string', description: 'Custom Accept-Language override (e.g. "en-US,en;q=0.9")' },
        platform: { type: 'string', description: 'Optional navigator.platform override' },
        extraHeaders: {
          type: 'object',
          description: 'Custom HTTP headers object sent on every request',
          additionalProperties: { type: 'string' },
        },
        mergeHeaders: { type: 'boolean', description: 'Merge with existing custom headers (default: true)' },
        clearHeaders: { type: 'boolean', description: 'Clear existing custom headers before applying new ones' },
        removeHeaders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Header names to remove',
        },
        revealHeaders: { type: 'boolean', description: 'Include unmasked sensitive header values in output' },
      },
    },
  },
  {
    name: 'troy_downloads',
    description:
      'Inspect intercepted, quarantined, or blocked auto-downloads (including suggested filenames and quarantine paths), update download policy mode (quarantine|deny|allow), or purge quarantined files.',
    inputSchema: {
      type: 'object',
      properties: {
        blockedOnly: { type: 'boolean', description: 'Only return downloads blocked by policy' },
        status: {
          type: 'string',
          enum: ['in_progress', 'quarantined', 'blocked', 'canceled', 'failed'],
          description: 'Filter downloads by status',
        },
        mode: {
          type: 'string',
          enum: ['quarantine', 'deny', 'allow'],
          description: 'Update download interception policy mode',
        },
        maxBytes: { type: 'number', description: 'Update maximum permitted download size in bytes' },
        clear: { type: 'boolean', description: 'Clear download history and delete quarantined files' },
        removeId: { type: 'string', description: 'Remove a single download entry and its quarantined file by ID' },
        limit: { type: 'number', description: 'Maximum entries to return (default 50)' },
      },
    },
  },
  {
    name: 'troy_dialogs',
    description:
      'Inspect captured JavaScript dialogs (alert/confirm/prompt/beforeunload), update auto-handle policy (dismiss|accept), or queue a one-shot response for the next dialog so headless runs never hang.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        allTabs: { type: 'boolean', description: 'Return dialogs from all tabs instead of just the target tab' },
        type: {
          type: 'string',
          enum: ['alert', 'confirm', 'prompt', 'beforeunload'],
          description: 'Filter captured dialogs by dialog type',
        },
        mode: {
          type: 'string',
          enum: ['dismiss', 'accept'],
          description: 'Update default dialog auto-handling mode',
        },
        acceptBeforeUnload: {
          type: 'boolean',
          description: 'Whether to auto-accept beforeunload dialogs (default true)',
        },
        defaultPromptText: {
          type: 'string',
          description: 'Default text supplied when accepting prompt() dialogs',
        },
        queueAccept: {
          type: 'boolean',
          description: 'Queue a one-shot accept (true) or dismiss (false) response for the next dialog',
        },
        promptText: {
          type: 'string',
          description: 'Prompt input text paired with queueAccept=true',
        },
        queueType: {
          type: 'string',
          enum: ['alert', 'confirm', 'prompt', 'beforeunload'],
          description: 'Optional dialog type filter for the queued one-shot response',
        },
        clearQueue: { type: 'boolean', description: 'Clear all queued one-shot dialog responses' },
        clear: { type: 'boolean', description: 'Clear captured dialog history after returning' },
        limit: { type: 'number', description: 'Maximum entries to return (default 100)' },
      },
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
          showMediaSummary: args.showMediaSummary,
          since: args.since,
          settle: args.settle,
          asciiOnly: true,
        })
        break
      case 'troy_read_markdown':
        result = await manager.runTool(tabId, 'page_read_markdown', {
          showRefs: args.showRefs,
          includeUrls: args.includeUrls,
          includeFrontmatter: args.includeFrontmatter,
          includeMediaSummary: args.includeMediaSummary,
          asciiOnly: args.asciiOnly,
          crop: args.crop,
          ref: args.ref,
          settle: args.settle,
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
      case 'troy_wait':
        result = await manager.runTool(tabId, 'page_wait', {
          ms: args.ms,
          text: args.text,
          selector: args.selector,
          url: args.url,
          state: args.state,
          settle: args.settle,
          networkIdleMs: args.networkIdleMs,
          domQuietMs: args.domQuietMs,
          timeout: args.timeout,
        })
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
      case 'troy_emulate': {
        const hasUpdate =
          args.viewport !== undefined ||
          args.userAgent !== undefined ||
          args.acceptLanguage !== undefined ||
          args.platform !== undefined ||
          args.extraHeaders !== undefined ||
          args.headers !== undefined ||
          Boolean(args.clearHeaders) ||
          (Array.isArray(args.removeHeaders) && args.removeHeaders.length > 0)
        if (!hasUpdate) {
          result = manager.getEmulation(tabId, { revealHeaders: Boolean(args.revealHeaders) })
        } else {
          result = await manager.setEmulation({
            tabId,
            allTabs: Boolean(args.allTabs),
            viewport: typeof args.viewport === 'string' ? args.viewport : undefined,
            userAgent: typeof args.userAgent === 'string' ? args.userAgent : undefined,
            acceptLanguage: typeof args.acceptLanguage === 'string' ? args.acceptLanguage : undefined,
            platform: typeof args.platform === 'string' ? args.platform : undefined,
            extraHeaders:
              typeof args.extraHeaders === 'object' && args.extraHeaders !== null
                ? (args.extraHeaders as Record<string, string>)
                : typeof args.headers === 'object' && args.headers !== null
                  ? (args.headers as Record<string, string>)
                  : undefined,
            mergeHeaders: typeof args.mergeHeaders === 'boolean' ? args.mergeHeaders : undefined,
            clearHeaders: Boolean(args.clearHeaders),
            removeHeaders: Array.isArray(args.removeHeaders) ? args.removeHeaders.map(String) : undefined,
            revealHeaders: Boolean(args.revealHeaders),
          })
        }
        break
      }
      case 'troy_downloads':
        result = await manager.runTool(tabId, 'page_downloads', {
          blockedOnly: args.blockedOnly,
          status: args.status,
          mode: args.mode,
          maxBytes: args.maxBytes,
          clear: args.clear,
          removeId: args.removeId,
          limit: args.limit,
        })
        break
      case 'troy_dialogs':
        result = await manager.runTool(tabId, 'page_dialogs', {
          allTabs: args.allTabs,
          type: args.type,
          mode: args.mode,
          acceptBeforeUnload: args.acceptBeforeUnload,
          defaultPromptText: args.defaultPromptText,
          queueAccept: args.queueAccept,
          promptText: args.promptText,
          queueType: args.queueType,
          clearQueue: args.clearQueue,
          clear: args.clear,
          limit: args.limit,
        })
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
        : name === 'troy_read_markdown' && typeof result.markdown === 'string'
          ? result.markdown
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
