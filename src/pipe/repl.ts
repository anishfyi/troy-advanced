// Streaming AI Pipe REPL (`troy-advanced pipe`).
// Accepts either plain ASCII commands (`open https://...`, `ascii`, `click e3`, `fill e4 hello`)
// OR structured NDJSON commands (`{"cmd":"read_ascii","width":90}`) on stdin and writes
// clean responses to stdout — ideal for subagents, SSH pipes, and EC2 batch jobs.

import readline from 'node:readline'
import type { BrowserManager } from '../engine/manager.js'

export async function executePipeCommand(
  manager: BrowserManager,
  rawLine: string,
  opts: { jsonMode?: boolean } = {},
): Promise<{ output: string; quit?: boolean }> {
  const trimmed = rawLine.trim()
  if (!trimmed) return { output: '' }

  // Structured JSON command mode
  if (trimmed.startsWith('{')) {
    const req = JSON.parse(trimmed) as { cmd: string; tabId?: number; [k: string]: unknown }
    const cmd = String(req.cmd ?? '').toLowerCase()
    const tabId = typeof req.tabId === 'number' ? req.tabId : undefined
    if (cmd === 'quit' || cmd === 'exit') {
      return { output: JSON.stringify({ ok: true, bye: true }), quit: true }
    }
    let res: Record<string, unknown>
    if (cmd === 'open') res = await manager.openTab(String(req.url ?? ''), { activate: true })
    else if (cmd === 'tabs') res = { ok: true, tabs: manager.listTabs() }
    else if (cmd === 'grant') res = manager.grantOrigin(String(req.origin ?? ''))
    else if (cmd === 'activate') res = manager.activateTab(Number(req.tabId))
    else if (cmd === 'close') res = await manager.closeTab(Number(req.tabId))
    else {
      const toolName = cmd.startsWith('page_') ? cmd : `page_${cmd}`
      res = await manager.runTool(tabId, toolName, req)
    }
    return { output: JSON.stringify(res) }
  }

  // Plain ASCII command mode
  const [verbRaw, ...rest] = trimmed.split(/\s+/)
  const verb = (verbRaw ?? '').toLowerCase()
  const argStr = rest.join(' ')

  if (verb === 'quit' || verb === 'exit' || verb === 'q') {
    return { output: opts.jsonMode ? JSON.stringify({ ok: true, bye: true }) : 'BYE', quit: true }
  }

  const format = (res: Record<string, unknown>) => {
    if (opts.jsonMode) return JSON.stringify(res)
    if (typeof res.ascii === 'string') return res.ascii
    if (res.ok === false) return `ERR: ${res.error ?? 'failed'}`
    return JSON.stringify(res)
  }

  switch (verb) {
    case 'help':
      return {
        output: [
          'COMMANDS: open <url> | ascii [width] | visual [width] | read | find <q> | click <ref> [--submit]',
          '          fill <ref> <text> | select <ref> <val> | press <key> | scroll <dir> | tabs | tab <id>',
          '          back | forward | reload | grant <origin> | recall <q> | quit',
        ].join('\n'),
      }
    case 'open':
    case 'go':
    case 'goto': {
      const res = await manager.openTab(argStr, { activate: true })
      if (!res.ok) return { output: format(res) }
      if (!opts.jsonMode) {
        const rendered = await manager.renderAscii(res.id, { asciiOnly: true })
        return { output: rendered.ascii ?? format(res) }
      }
      return { output: format(res) }
    }
    case 'ascii':
    case 'render': {
      const width = rest[0] ? Number(rest[0]) : 100
      const res = await manager.runTool(undefined, 'page_read_ascii', { width: Number.isFinite(width) ? width : 100, asciiOnly: true })
      return { output: format(res) }
    }
    case 'visual': {
      const width = rest[0] ? Number(rest[0]) : 80
      const res = await manager.runTool(undefined, 'page_screenshot_ascii', {
        width: Number.isFinite(width) ? width : 80,
        annotate: true,
      })
      return { output: format(res) }
    }
    case 'read': {
      const since = rest.includes('--since')
      const res = await manager.runTool(undefined, 'page_read', { since })
      return { output: format(res) }
    }
    case 'find': {
      const res = await manager.runTool(undefined, 'page_find', { query: argStr })
      return { output: format(res) }
    }
    case 'click': {
      const allowSubmit = rest.includes('--submit') || rest.includes('--allow-submit')
      const res = await manager.runTool(undefined, 'page_click', { ref: rest[0], allowSubmit })
      return { output: format(res) }
    }
    case 'fill': {
      const ref = rest[0]
      const text = rest.slice(1).join(' ')
      const res = await manager.runTool(undefined, 'page_fill', { ref, text })
      return { output: format(res) }
    }
    case 'select': {
      const res = await manager.runTool(undefined, 'page_select', { ref: rest[0], value: rest.slice(1).join(' ') })
      return { output: format(res) }
    }
    case 'press': {
      const res = await manager.runTool(undefined, 'page_press', { key: rest[0] ?? 'Enter', ref: rest[1] })
      return { output: format(res) }
    }
    case 'scroll': {
      const res = await manager.runTool(undefined, 'page_scroll', {
        direction: rest[0] || 'down',
        amount: rest[1] ? Number(rest[1]) : 450,
      })
      return { output: format(res) }
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const res = await manager.runTool(undefined, 'page_history', { direction: verb })
      return { output: format(res) }
    }
    case 'tabs':
      return { output: format({ ok: true, tabs: manager.listTabs() }) }
    case 'tab':
    case 'focus':
      return { output: format(manager.activateTab(Number(rest[0]))) }
    case 'grant':
      return { output: format(manager.grantOrigin(argStr)) }
    case 'recall':
      return {
        output: format(manager.memory ? { ok: true, ...manager.memory.recall(argStr) } : { ok: false, error: 'memory disabled' }),
      }
    default:
      return { output: opts.jsonMode ? JSON.stringify({ ok: false, error: `unknown command: ${verb}` }) : `ERR: unknown command "${verb}" (try "help")` }
  }
}

export async function runPipeRepl(
  manager: BrowserManager,
  opts: { jsonMode?: boolean; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  for await (const line of rl) {
    try {
      const { output: out, quit } = await executePipeCommand(manager, line, { jsonMode: opts.jsonMode })
      if (out) output.write(`${out}\n`)
      if (quit) {
        rl.close()
        return
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      output.write(opts.jsonMode ? `${JSON.stringify({ ok: false, error: msg })}\n` : `ERR: ${msg}\n`)
    }
  }
}
