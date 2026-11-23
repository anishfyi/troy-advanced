// Streaming AI Pipe REPL (`troy-advanced pipe`).
// Accepts either plain ASCII commands (`open https://...`, `ascii`, `click e3`, `fill e4 hello`)
// OR structured NDJSON commands (`{"cmd":"read_ascii","width":90}`) on stdin and writes
// clean responses to stdout — ideal for subagents, SSH pipes, and EC2 batch jobs.

import readline from 'node:readline'
import type { BrowserManager } from '../engine/manager.js'

function tokenizePipeArgs(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === '\\' && i + 1 < input.length) {
        cur += input[++i]!
      } else if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur.length > 0) tokens.push(cur)
  return tokens
}

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
    if (typeof res.markdown === 'string') return res.markdown
    if (res.ok === false) return `ERR: ${res.error ?? 'failed'}`
    return JSON.stringify(res)
  }

  switch (verb) {
    case 'help':
      return {
        output: [
          'COMMANDS: open <url> | ascii [width] | markdown [--frontmatter] | visual [width] | read | find <q>',
          '          click <ref> [--submit] | fill <ref> <text> | select <ref> <val> | press <key> | scroll <dir>',
          '          wait [ms] [--text <str>] [--selector <css>] [--url <pat>] [--state visible|hidden|attached] [--timeout <ms>]',
          '          tabs | tab <id> | back | forward | reload | grant <origin> | recall <q> | quit',
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
      let width: number | undefined
      let density: string | undefined
      let crop: string | undefined
      let ref: string | undefined
      let since = false
      let showMediaSummary = false
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i]!
        if (tok === '--since') {
          since = true
        } else if (tok === '--media') {
          showMediaSummary = true
        } else if (tok === '--density' && rest[i + 1]) {
          density = rest[++i]
        } else if (tok.startsWith('--density=')) {
          density = tok.slice('--density='.length)
        } else if (tok === '--crop' && rest[i + 1]) {
          crop = rest[++i]
        } else if (tok.startsWith('--crop=')) {
          crop = tok.slice('--crop='.length)
        } else if (tok === '--ref' && rest[i + 1]) {
          ref = rest[++i]
        } else if (tok.startsWith('--ref=')) {
          ref = tok.slice('--ref='.length)
        } else if (tok === 'compact' || tok === 'normal' || tok === 'wide') {
          density = tok
        } else if (/^\d+$/.test(tok)) {
          width = Number(tok)
        }
      }
      const res = await manager.runTool(undefined, 'page_read_ascii', { width, density, crop, ref, since, showMediaSummary, asciiOnly: true })
      return { output: format(res) }
    }
    case 'markdown':
    case 'md': {
      let includeFrontmatter = false
      let includeMediaSummary = false
      let asciiOnly = false
      let showRefs = true
      let includeUrls = true
      let crop: string | undefined
      let ref: string | undefined
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i]!
        if (tok === '--frontmatter') includeFrontmatter = true
        else if (tok === '--media') includeMediaSummary = true
        else if (tok === '--ascii') asciiOnly = true
        else if (tok === '--no-refs') showRefs = false
        else if (tok === '--no-urls') includeUrls = false
        else if (tok === '--crop' && rest[i + 1]) crop = rest[++i]
        else if (tok.startsWith('--crop=')) crop = tok.slice('--crop='.length)
        else if (tok === '--ref' && rest[i + 1]) ref = rest[++i]
        else if (tok.startsWith('--ref=')) ref = tok.slice('--ref='.length)
      }
      const res = await manager.runTool(undefined, 'page_read_markdown', {
        includeFrontmatter,
        includeMediaSummary,
        asciiOnly,
        showRefs,
        includeUrls,
        crop,
        ref,
      })
      return { output: format(res) }
    }
    case 'visual': {
      let width = 80
      let mode: string | undefined
      let crop: string | undefined
      let ref: string | undefined
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i]!
        if (tok === '--crop' && rest[i + 1]) {
          crop = rest[++i]
        } else if (tok.startsWith('--crop=')) {
          crop = tok.slice('--crop='.length)
        } else if (tok === '--ref' && rest[i + 1]) {
          ref = rest[++i]
        } else if (tok.startsWith('--ref=')) {
          ref = tok.slice('--ref='.length)
        } else if (tok === '--mode' && rest[i + 1]) {
          mode = rest[++i]
        } else if (tok.startsWith('--mode=')) {
          mode = tok.slice('--mode='.length)
        } else if (/^\d+$/.test(tok)) {
          width = Number(tok)
        }
      }
      const res = await manager.runTool(undefined, 'page_screenshot_ascii', {
        width: Number.isFinite(width) ? width : 80,
        mode,
        crop,
        ref,
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
    case 'wait': {
      const tokens = tokenizePipeArgs(argStr)
      const waitArgs: Record<string, unknown> = {}
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if (tok === '--text' && tokens[i + 1] !== undefined) waitArgs.text = tokens[++i]
        else if (tok.startsWith('--text=')) waitArgs.text = tok.slice('--text='.length)
        else if (tok === '--selector' && tokens[i + 1] !== undefined) waitArgs.selector = tokens[++i]
        else if (tok.startsWith('--selector=')) waitArgs.selector = tok.slice('--selector='.length)
        else if (tok === '--url' && tokens[i + 1] !== undefined) waitArgs.url = tokens[++i]
        else if (tok.startsWith('--url=')) waitArgs.url = tok.slice('--url='.length)
        else if (tok === '--state' && tokens[i + 1] !== undefined) waitArgs.state = tokens[++i]
        else if (tok.startsWith('--state=')) waitArgs.state = tok.slice('--state='.length)
        else if (tok === '--timeout' && tokens[i + 1] !== undefined) waitArgs.timeout = Number(tokens[++i])
        else if (tok.startsWith('--timeout=')) waitArgs.timeout = Number(tok.slice('--timeout='.length))
        else if (tok === '--settle') waitArgs.settle = true
        else if (tok === '--network-idle-ms' && tokens[i + 1] !== undefined) waitArgs.networkIdleMs = Number(tokens[++i])
        else if (tok.startsWith('--network-idle-ms=')) waitArgs.networkIdleMs = Number(tok.slice('--network-idle-ms='.length))
        else if (tok === '--dom-quiet-ms' && tokens[i + 1] !== undefined) waitArgs.domQuietMs = Number(tokens[++i])
        else if (tok.startsWith('--dom-quiet-ms=')) waitArgs.domQuietMs = Number(tok.slice('--dom-quiet-ms='.length))
        else if (tok === '--ms' && tokens[i + 1] !== undefined) waitArgs.ms = Number(tokens[++i])
        else if (tok.startsWith('--ms=')) waitArgs.ms = Number(tok.slice('--ms='.length))
        else if (/^\d+$/.test(tok) && waitArgs.ms === undefined) waitArgs.ms = Number(tok)
      }
      const res = await manager.runTool(undefined, 'page_wait', waitArgs)
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
