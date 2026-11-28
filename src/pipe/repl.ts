// Streaming AI Pipe REPL (`troy-advanced pipe`).
// Accepts either plain ASCII commands (`open https://...`, `ascii`, `click e3`, `fill e4 hello`)
// OR structured NDJSON commands (`{"cmd":"read_ascii","width":90}`) on stdin and writes
// clean responses to stdout — ideal for subagents, SSH pipes, and EC2 batch jobs.

import readline from 'node:readline'
import type { BrowserManager } from '../engine/manager.js'
import { parseDialogMode, parseDialogType } from '../engine/dialogs.js'
import { parseDownloadMode } from '../engine/downloads.js'
import { parseHeaderList } from '../engine/emulation.js'

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
      const { cmd: _cmd, tabId: _tabId, ...toolArgs } = req
      res = await manager.runTool(tabId, toolName, toolArgs)
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
          'COMMANDS: open <url> | ascii [width] | markdown [--frontmatter] | visual [width] | read | find <q> | extract [--sections ...]',
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
      let maxTokens: string | undefined
      let crop: string | undefined
      let ref: string | undefined
      let since = false
      let showMediaSummary = false
      let untrustedMarkers = false
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i]!
        if (tok === '--since') {
          since = true
        } else if (tok === '--media') {
          showMediaSummary = true
        } else if (tok === '--untrusted-markers') {
          untrustedMarkers = true
        } else if (tok === '--density' && rest[i + 1]) {
          density = rest[++i]
        } else if (tok.startsWith('--density=')) {
          density = tok.slice('--density='.length)
        } else if (tok === '--max-tokens' && rest[i + 1]) {
          maxTokens = rest[++i]
        } else if (tok.startsWith('--max-tokens=')) {
          maxTokens = tok.slice('--max-tokens='.length)
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
      const res = await manager.runTool(undefined, 'page_read_ascii', {
        width,
        density,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        crop,
        ref,
        since,
        showMediaSummary,
        ...(untrustedMarkers ? { untrustedMarkers: true } : {}),
        asciiOnly: true,
      })
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
      let untrustedMarkers = false
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i]!
        if (tok === '--frontmatter') includeFrontmatter = true
        else if (tok === '--media') includeMediaSummary = true
        else if (tok === '--ascii') asciiOnly = true
        else if (tok === '--no-refs') showRefs = false
        else if (tok === '--no-urls') includeUrls = false
        else if (tok === '--untrusted-markers') untrustedMarkers = true
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
        ...(untrustedMarkers ? { untrustedMarkers: true } : {}),
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
      const untrustedMarkers = rest.includes('--untrusted-markers')
      const res = await manager.runTool(undefined, 'page_read', {
        since,
        ...(untrustedMarkers ? { untrustedMarkers: true } : {}),
      })
      return { output: format(res) }
    }
    case 'find': {
      const tokens = tokenizePipeArgs(argStr)
      const queryParts: string[] = []
      const roles: string[] = []
      let limit: number | undefined
      let fuzzy = true
      let synonyms = true
      let includeDisabled = true
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if (tok === '--role' && tokens[i + 1] !== undefined) roles.push(tokens[++i]!)
        else if (tok.startsWith('--role=')) roles.push(tok.slice('--role='.length))
        else if (tok === '--button') roles.push('button')
        else if (tok === '--input') roles.push('input')
        else if (tok === '--link') roles.push('link')
        else if (tok === '--select') roles.push('select')
        else if (tok === '--checkbox') roles.push('checkbox')
        else if (tok === '--radio') roles.push('radio')
        else if (tok === '--limit' && tokens[i + 1] !== undefined) limit = Number(tokens[++i])
        else if (tok.startsWith('--limit=')) limit = Number(tok.slice('--limit='.length))
        else if (tok === '--no-fuzzy') fuzzy = false
        else if (tok === '--no-synonyms') synonyms = false
        else if (tok === '--enabled-only') includeDisabled = false
        else queryParts.push(tok)
      }
      const res = await manager.runTool(undefined, 'page_find', {
        query: queryParts.join(' '),
        ...(roles.length > 0 ? { roles } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        fuzzy,
        synonyms,
        includeDisabled,
      })
      return { output: format(res) }
    }
    case 'extract': {
      const tokens = tokenizePipeArgs(argStr)
      let sections: string | undefined
      let maxItems: number | undefined
      let ascii = false
      let asciiOnly = false
      let externalLinksOnly = false
      let internalLinksOnly = false
      let includeObjects = true
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if (tok === '--sections' && tokens[i + 1] !== undefined) sections = tokens[++i]
        else if (tok.startsWith('--sections=')) sections = tok.slice('--sections='.length)
        else if (tok === '--max-items' && tokens[i + 1] !== undefined) maxItems = Number(tokens[++i])
        else if (tok.startsWith('--max-items=')) maxItems = Number(tok.slice('--max-items='.length))
        else if (tok === '--ascii') ascii = true
        else if (tok === '--ascii-only') asciiOnly = true
        else if (tok === '--external') externalLinksOnly = true
        else if (tok === '--internal') internalLinksOnly = true
        else if (tok === '--no-objects') includeObjects = false
      }
      const res = await manager.runTool(undefined, 'page_extract', {
        ...(sections ? { sections } : {}),
        ...(maxItems !== undefined && Number.isFinite(maxItems) ? { maxItems } : {}),
        includeObjects,
        ascii,
        asciiOnly,
        externalLinksOnly,
        internalLinksOnly,
      })
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
    case 'recall': {
      const tokens = tokenizePipeArgs(argStr)
      let bind = true
      let boundOnly = false
      let currentOriginOnly = false
      let ascii = false
      const queryParts: string[] = []
      for (const tok of tokens) {
        if (tok === '--no-bind') bind = false
        else if (tok === '--bound-only') boundOnly = true
        else if (tok === '--current-origin') currentOriginOnly = true
        else if (tok === '--ascii') ascii = true
        else queryParts.push(tok)
      }
      const res = await manager.recall({
        query: queryParts.join(' '),
        bind,
        boundOnly,
        currentOriginOnly,
        ascii,
      })
      return { output: format(res) }
    }
    case 'emulate':
    case 'viewport': {
      const tokens = tokenizePipeArgs(argStr)
      let viewport: string | undefined
      let userAgent: string | undefined
      let acceptLanguage: string | undefined
      let platform: string | undefined
      const rawHeaders: string[] = []
      const removeHeaders: string[] = []
      let clearHeaders = false
      let allTabs = false
      let revealHeaders = false

      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if ((tok === '--viewport' || tok === '-v') && tokens[i + 1] !== undefined) viewport = tokens[++i]
        else if (tok.startsWith('--viewport=')) viewport = tok.slice('--viewport='.length)
        else if ((tok === '--user-agent' || tok === '--ua') && tokens[i + 1] !== undefined) userAgent = tokens[++i]
        else if (tok.startsWith('--user-agent=')) userAgent = tok.slice('--user-agent='.length)
        else if (tok.startsWith('--ua=')) userAgent = tok.slice('--ua='.length)
        else if (tok === '--accept-language' && tokens[i + 1] !== undefined) acceptLanguage = tokens[++i]
        else if (tok.startsWith('--accept-language=')) acceptLanguage = tok.slice('--accept-language='.length)
        else if (tok === '--platform' && tokens[i + 1] !== undefined) platform = tokens[++i]
        else if (tok.startsWith('--platform=')) platform = tok.slice('--platform='.length)
        else if ((tok === '--header' || tok === '-H') && tokens[i + 1] !== undefined) rawHeaders.push(tokens[++i]!)
        else if (tok.startsWith('--header=')) rawHeaders.push(tok.slice('--header='.length))
        else if (tok === '--remove-header' && tokens[i + 1] !== undefined) removeHeaders.push(tokens[++i]!)
        else if (tok.startsWith('--remove-header=')) removeHeaders.push(tok.slice('--remove-header='.length))
        else if (tok === '--clear-headers') clearHeaders = true
        else if (tok === '--all-tabs') allTabs = true
        else if (tok === '--reveal') revealHeaders = true
        else if (!tok.startsWith('-') && viewport === undefined) viewport = tok
      }

      const extraHeaders = rawHeaders.length > 0 ? parseHeaderList(rawHeaders) : undefined
      const hasUpdate =
        viewport !== undefined ||
        userAgent !== undefined ||
        acceptLanguage !== undefined ||
        platform !== undefined ||
        extraHeaders !== undefined ||
        clearHeaders ||
        removeHeaders.length > 0

      const res = hasUpdate
        ? await manager.setEmulation({
            allTabs,
            viewport,
            userAgent,
            acceptLanguage,
            platform,
            extraHeaders,
            clearHeaders,
            removeHeaders: removeHeaders.length > 0 ? removeHeaders : undefined,
            revealHeaders,
          })
        : manager.getEmulation(undefined, { revealHeaders })
      return { output: format(res) }
    }
    case 'downloads': {
      const tokens = tokenizePipeArgs(argStr)
      let blockedOnly = false
      let clear = false
      let mode: string | undefined
      let removeId: string | undefined
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if (tok === '--blocked' || tok === 'blocked') blockedOnly = true
        else if (tok === '--clear' || tok === 'clear') clear = true
        else if ((tok === '--mode' || tok === 'mode') && tokens[i + 1]) mode = tokens[++i]
        else if (tok.startsWith('--mode=')) mode = tok.slice('--mode='.length)
        else if ((tok === '--remove' || tok === 'remove') && tokens[i + 1]) removeId = tokens[++i]
        else if (tok.startsWith('--remove=')) removeId = tok.slice('--remove='.length)
        else if (parseDownloadMode(tok)) mode = tok
      }
      const res = await manager.runTool(undefined, 'page_downloads', {
        blockedOnly,
        clear,
        ...(mode ? { mode } : {}),
        ...(removeId ? { removeId } : {}),
      })
      return { output: format(res) }
    }
    case 'dialogs': {
      const tokens = tokenizePipeArgs(argStr)
      let clear = false
      let clearQueue = false
      let allTabs = true
      let mode: string | undefined
      let type: string | undefined
      let queueAccept: boolean | undefined
      let promptText: string | undefined
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if (tok === '--clear' || tok === 'clear') clear = true
        else if (tok === '--clear-queue') clearQueue = true
        else if ((tok === '--mode' || tok === 'mode') && tokens[i + 1]) mode = tokens[++i]
        else if (tok.startsWith('--mode=')) mode = tok.slice('--mode='.length)
        else if ((tok === '--type' || tok === 'type') && tokens[i + 1]) type = tokens[++i]
        else if (tok.startsWith('--type=')) type = tok.slice('--type='.length)
        else if (tok === '--next' && tokens[i + 1]) {
          const val = tokens[++i]!.toLowerCase()
          if (val === 'accept') queueAccept = true
          else if (val === 'dismiss') queueAccept = false
        } else if (tok === '--prompt-text' && tokens[i + 1]) {
          promptText = tokens[++i]
        } else if (tok.startsWith('--prompt-text=')) {
          promptText = tok.slice('--prompt-text='.length)
        } else if (parseDialogMode(tok)) {
          mode = tok
        } else if (parseDialogType(tok)) {
          type = tok
        }
      }
      const res = await manager.runTool(undefined, 'page_dialogs', {
        allTabs,
        clear,
        clearQueue,
        ...(mode ? { mode } : {}),
        ...(type ? { type } : {}),
        ...(queueAccept !== undefined ? { queueAccept } : {}),
        ...(promptText !== undefined ? { promptText } : {}),
      })
      return { output: format(res) }
    }
    case 'network': {
      const tokens = tokenizePipeArgs(argStr)
      let body: string | undefined
      let failedOnly = false
      let blockedOnly = false
      let clear = false
      let method: string | undefined
      let urlFilter: string | undefined
      let prettyJson: boolean | undefined
      let revealHeaders = false
      let includeBinary = false
      let maxBodyChars: number | undefined
      let limit: number | undefined

      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!
        if (tok === '--body' && tokens[i + 1]) body = tokens[++i]
        else if (tok.startsWith('--body=')) body = tok.slice('--body='.length)
        else if (tok === '--failed') failedOnly = true
        else if (tok === '--blocked') blockedOnly = true
        else if (tok === '--clear' || tok === 'clear') clear = true
        else if (tok === '--raw') prettyJson = false
        else if (tok === '--reveal') revealHeaders = true
        else if (tok === '--binary') includeBinary = true
        else if (tok === '--method' && tokens[i + 1]) method = tokens[++i]
        else if (tok.startsWith('--method=')) method = tok.slice('--method='.length)
        else if (tok === '--url-filter' && tokens[i + 1]) urlFilter = tokens[++i]
        else if (tok.startsWith('--url-filter=')) urlFilter = tok.slice('--url-filter='.length)
        else if (tok === '--max-chars' && tokens[i + 1]) maxBodyChars = Number(tokens[++i])
        else if (tok.startsWith('--max-chars=')) maxBodyChars = Number(tok.slice('--max-chars='.length))
        else if (tok === '--limit' && tokens[i + 1]) limit = Number(tokens[++i])
        else if (tok.startsWith('--limit=')) limit = Number(tok.slice('--limit='.length))
      }

      const res = await manager.runTool(
        undefined,
        'page_network',
        body
          ? {
              body,
              ...(prettyJson !== undefined ? { prettyJson } : {}),
              ...(revealHeaders ? { revealHeaders: true } : {}),
              ...(includeBinary ? { includeBinary: true } : {}),
              ...(maxBodyChars !== undefined && Number.isFinite(maxBodyChars) ? { maxBodyChars } : {}),
            }
          : {
              failedOnly,
              blockedOnly,
              clear,
              ...(method ? { method } : {}),
              ...(urlFilter ? { urlFilter } : {}),
              ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
            },
      )
      return { output: format(res) }
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
