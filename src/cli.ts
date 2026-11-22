// CLI entrypoint for `troy-advanced`.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { EngineKind, TrackerBlockingOptions, TrackerBlockMode } from './types.js'
import { BrowserManager } from './engine/manager.js'
import { readLiveEndpoint } from './bridge/endpoint.js'
import { runDaemonForeground, startDaemonDetached, stopDaemon } from './cloud/daemon.js'
import { formatDoctorAscii, runDoctor } from './cloud/doctor.js'
import { runMcpStdioServer } from './mcp/server.js'
import { runPipeRepl } from './pipe/repl.js'
import { runTerminalBrowser } from './tui/terminal-browser.js'

const USAGE = `troy-advanced — terminal-native, EC2-ready, ASCII-rendered AI browser

Usage: troy-advanced <command> [args] [flags]

Daemon & Modes:
  daemon start [--engine auto|chromium|lite] [--compat-troy] [--port N] [--url U]
  daemon run   (foreground daemon for systemd / Docker)
  daemon stop | status
  browse [url] [--ascii] [--engine auto|chromium|lite]   Interactive ASCII terminal browser
  mcp          [--engine auto|chromium|lite]             Model Context Protocol stdio server
  pipe         [--json] [--engine auto|chromium|lite]    Streaming stdin/stdout AI REPL
  doctor       [--json]                                  EC2 / Linux / Chrome environment check
  ec2 setup                                              Print EC2 systemd & SSH forwarding guide

Client Commands (talk to running daemon, or use --oneshot):
  status                                  Daemon health + memory stats
  tabs                                    List open tabs
  open <url|query>                        Open tab; prints id (or ASCII with --ascii)
  ascii [--since] [--width N] [--height N] [--density compact|normal|wide] [--layout flow|spatial|auto] [--crop x,y,w,h] [--ref eN]
                                          Render tab as strict 7-bit ASCII viewport (or diff with --since)
  markdown [--frontmatter] [--no-refs] [--no-urls] [--media] [--ascii] [--crop x,y,w,h] [--ref eN]
                                          Export tab as CommonMark/GFM Markdown preserving inline [eN] refs
  visual [--mode ascii|edge|braille|halfblock] [--annotate] [--crop x,y,w,h] [--ref eN]
                                          Render Chromium PNG screenshot (or cropped region) as ASCII
  read [--since] [--ascii] [--visual] [--crop x,y,w,h] [--ref eN] [--json]
                                          Read page structure or ASCII/JSON delta
  find <query>                            Find interactive elements as eN refs
  click <ref> [--allow-submit]            Click element ref
  fill <ref> <text> [--clear]             Fill input ref
  select <ref> <value>                    Select dropdown option
  press <key> [--ref eN]                  Press key
  scroll [up|down|top|bottom] [amount]    Scroll page
  wait [ms] [--text <str>] [--selector <css>] [--url <pattern>] [--state visible|hidden|attached] [--timeout <ms>]
                                          Wait for page condition or fixed delay
  back | forward | reload                 History navigation
  console | network | eval <expr>         Inspect tab diagnostics or evaluate JS
  act <json-steps> [--allow-submit]       Run batched action list
  grant <origin>                          Extend origin autonomy boundary
  recall <query> | forget [origin]        Query or clear persistent page memory

Global Flags:
  --tab <id>  --endpoint <file>  --engine <auto|chromium|lite>  --json  --ascii  --width <n>
`

const VALUE_FLAGS = new Set([
  '--tab',
  '--endpoint',
  '--engine',
  '--port',
  '--cdp-port',
  '--remote-cdp-port',
  '--profile',
  '--url',
  '--width',
  '--height',
  '--layout',
  '--density',
  '--mode',
  '--crop',
  '--ref',
  '--amount',
  '--limit',
  '--level',
  '--origin',
  '--tracker-mode',
  '--text',
  '--selector',
  '--state',
  '--timeout',
  '--ms',
])

function parseArgv(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      if (eq > 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1)
      } else if (VALUE_FLAGS.has(tok) && i + 1 < argv.length) {
        flags[tok.slice(2)] = argv[++i]!
      } else {
        flags[tok.slice(2)] = true
      }
    } else {
      positional.push(tok)
    }
  }
  return { positional, flags }
}

async function callDaemon(
  endpoint: { agentPort: number; agentToken: string },
  route: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${endpoint.agentPort}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-troy-agent': endpoint.agentToken },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags } = parseArgv(argv)
  const cmd = positional[0]

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(USAGE)
    return
  }

  const engine = (typeof flags.engine === 'string' ? flags.engine : 'auto') as EngineKind
  const endpointFlag = typeof flags.endpoint === 'string' ? flags.endpoint : undefined
  const trackerBlocking: TrackerBlockingOptions | undefined =
    flags['no-block-trackers'] || typeof flags['tracker-mode'] === 'string'
      ? {
          enabled: !flags['no-block-trackers'],
          mode: typeof flags['tracker-mode'] === 'string' ? (flags['tracker-mode'] as TrackerBlockMode) : undefined,
        }
      : undefined

  if (cmd === 'doctor') {
    const report = runDoctor()
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatDoctorAscii(report))
    return
  }

  if (cmd === 'ec2' && positional[1] === 'setup') {
    console.log(`=== Troy Advanced EC2 Setup ===
1. Bootstrap Chromium + Node on Ubuntu / Amazon Linux 2023:
   bash deploy/ec2-bootstrap.sh

2. Install persistent systemd daemon:
   sudo cp deploy/troy-advanced.service /etc/systemd/system/
   sudo systemctl enable --now troy-advanced

3. Tunnel the loopback Agent Socket securely from your laptop (optional):
   AGENT_PORT=$(jq -r .agentPort ~/.config/troy-advanced/agent-endpoint.json)
   ssh -L $AGENT_PORT:127.0.0.1:$AGENT_PORT ec2-user@<ec2-host>

4. Or run AI agents directly on the EC2 host over SSH/tmux:
   troy-advanced daemon start --compat-troy
   troy-advanced open https://example.com
   troy-advanced ascii
   troy-advanced mcp       # Wire into Dexter / Claude Code / Codex MCP config
`)
    return
  }

  if (cmd === 'daemon') {
    const sub = positional[1] || 'status'
    const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'troy-advanced.mjs')
    const daemonOpts = {
      engine,
      port: flags.port ? Number(flags.port) : undefined,
      cdpPort: flags['cdp-port'] ? Number(flags['cdp-port']) : undefined,
      remoteCdpPort: flags['remote-cdp-port'] ? Number(flags['remote-cdp-port']) : undefined,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      endpointFile: endpointFlag,
      compatTroy: Boolean(flags['compat-troy']),
      initialUrl: typeof flags.url === 'string' ? flags.url : undefined,
      trackerBlocking,
    }

    if (sub === 'run') {
      await runDaemonForeground(daemonOpts)
      return
    }
    if (sub === 'start') {
      const res = await startDaemonDetached(binPath, daemonOpts)
      console.log(JSON.stringify(res, null, 2))
      if (!res.ok) process.exit(1)
      return
    }
    if (sub === 'stop') {
      const res = stopDaemon(endpointFlag)
      console.log(JSON.stringify(res, null, 2))
      return
    }
    if (sub === 'status') {
      const live = readLiveEndpoint(endpointFlag)
      if (!live) {
        console.log(JSON.stringify({ ok: false, running: false }, null, 2))
        process.exit(1)
      }
      const health = await callDaemon(live.endpoint, '/health')
      console.log(JSON.stringify({ ok: true, running: true, endpoint: live.endpoint, health }, null, 2))
      return
    }
  }

  if (cmd === 'browse') {
    const manager = await BrowserManager.create({
      engine,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      remoteCdpPort: flags['remote-cdp-port'] ? Number(flags['remote-cdp-port']) : undefined,
      trackerBlocking,
    })
    try {
      await runTerminalBrowser(manager, {
        initialUrl: positional[1],
        asciiOnly: Boolean(flags.ascii),
      })
    } finally {
      await manager.close()
    }
    return
  }

  if (cmd === 'mcp') {
    const manager = await BrowserManager.create({
      engine,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      remoteCdpPort: flags['remote-cdp-port'] ? Number(flags['remote-cdp-port']) : undefined,
      trackerBlocking,
    })
    try {
      await runMcpStdioServer(manager)
    } finally {
      await manager.close()
    }
    return
  }

  if (cmd === 'pipe') {
    const manager = await BrowserManager.create({
      engine,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      remoteCdpPort: flags['remote-cdp-port'] ? Number(flags['remote-cdp-port']) : undefined,
      trackerBlocking,
    })
    try {
      await runPipeRepl(manager, { jsonMode: Boolean(flags.json) })
    } finally {
      await manager.close()
    }
    return
  }

  // One-shot ASCII / Markdown / Visual fetch without needing a running daemon
  if ((cmd === 'ascii' || cmd === 'visual' || cmd === 'markdown' || cmd === 'md') && positional[1] && !readLiveEndpoint(endpointFlag)) {
    const manager = await BrowserManager.create({ engine, trackerBlocking })
    try {
      const opened = await manager.openTab(positional[1], { activate: true })
      if (!opened.ok) {
        console.error(JSON.stringify(opened, null, 2))
        process.exit(1)
      }
      if (cmd === 'markdown' || cmd === 'md') {
        const res = await manager.runTool(opened.id, 'page_read_markdown', {
          includeFrontmatter: Boolean(flags.frontmatter),
          includeMediaSummary: Boolean(flags.media),
          asciiOnly: Boolean(flags.ascii),
          showRefs: !flags['no-refs'],
          includeUrls: !flags['no-urls'],
          crop: typeof flags.crop === 'string' ? flags.crop : undefined,
          ref: typeof flags.ref === 'string' ? flags.ref : undefined,
        })
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else if (typeof res.markdown === 'string') console.log(res.markdown)
        else console.log(JSON.stringify(res, null, 2))
        return
      }
      const toolName = cmd === 'visual' ? 'page_screenshot_ascii' : 'page_read_ascii'
      const res = await manager.runTool(opened.id, toolName, {
        width: flags.width ? Number(flags.width) : cmd === 'visual' ? 80 : undefined,
        height: flags.height ? Number(flags.height) : undefined,
        layout: typeof flags.layout === 'string' ? flags.layout : undefined,
        density: typeof flags.density === 'string' ? flags.density : undefined,
        mode: typeof flags.mode === 'string' ? flags.mode : 'ascii',
        crop: typeof flags.crop === 'string' ? flags.crop : undefined,
        ref: typeof flags.ref === 'string' ? flags.ref : undefined,
        showMediaSummary: Boolean(flags.media),
        annotate: Boolean(flags.annotate),
      })
      if (flags.json) console.log(JSON.stringify(res, null, 2))
      else if (typeof res.ascii === 'string') console.log(res.ascii)
      else console.log(JSON.stringify(res, null, 2))
    } finally {
      await manager.close()
    }
    return
  }

  // Daemon client commands
  const live = readLiveEndpoint(endpointFlag)
  if (!live) {
    console.error(
      JSON.stringify(
        { ok: false, error: 'troy-advanced daemon is not running. Start it with: troy-advanced daemon start' },
        null,
        2,
      ),
    )
    process.exit(1)
  }

  const tabId = flags.tab !== undefined ? Number(flags.tab) : undefined
  const args = positional.slice(1)
  let res: Record<string, unknown>

  switch (cmd) {
    case 'status': {
      const health = await callDaemon(live.endpoint, '/health')
      const memory = await callDaemon(live.endpoint, '/memory')
      res = { ok: true, endpoint: live.endpoint.file, pid: live.endpoint.pid, health, memory }
      break
    }
    case 'tabs':
      res = await callDaemon(live.endpoint, '/tabs')
      break
    case 'open':
      res = await callDaemon(live.endpoint, '/open', { url: args.join(' '), activate: true })
      if (res.ok && flags.ascii) {
        res = await callDaemon(live.endpoint, '/ascii', {
          tabId: res.id,
          width: flags.width ? Number(flags.width) : undefined,
          height: flags.height ? Number(flags.height) : undefined,
          layout: typeof flags.layout === 'string' ? flags.layout : undefined,
          density: typeof flags.density === 'string' ? flags.density : undefined,
        })
      }
      break
    case 'focus':
      res = await callDaemon(live.endpoint, '/activate', { tabId: Number(args[0]) })
      break
    case 'close':
      res = await callDaemon(live.endpoint, '/close', { tabId: Number(args[0]) })
      break
    case 'grant':
      res = await callDaemon(live.endpoint, '/grant-origin', { origin: args[0], tabId })
      break
    case 'ascii':
      res = await callDaemon(live.endpoint, '/ascii', {
        tabId,
        width: flags.width ? Number(flags.width) : undefined,
        height: flags.height ? Number(flags.height) : undefined,
        layout: typeof flags.layout === 'string' ? flags.layout : undefined,
        density: typeof flags.density === 'string' ? flags.density : undefined,
        crop: typeof flags.crop === 'string' ? flags.crop : undefined,
        ref: typeof flags.ref === 'string' ? flags.ref : undefined,
        showMediaSummary: Boolean(flags.media),
        since: Boolean(flags.since),
        asciiOnly: true,
      })
      break
    case 'markdown':
    case 'md':
      res = await callDaemon(live.endpoint, '/markdown', {
        tabId,
        includeFrontmatter: Boolean(flags.frontmatter),
        includeMediaSummary: Boolean(flags.media),
        asciiOnly: Boolean(flags.ascii),
        showRefs: !flags['no-refs'],
        includeUrls: !flags['no-urls'],
        crop: typeof flags.crop === 'string' ? flags.crop : undefined,
        ref: typeof flags.ref === 'string' ? flags.ref : undefined,
      })
      break
    case 'visual':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_screenshot_ascii',
        args: {
          width: flags.width ? Number(flags.width) : 80,
          height: flags.height ? Number(flags.height) : undefined,
          mode: typeof flags.mode === 'string' ? flags.mode : 'ascii',
          crop: typeof flags.crop === 'string' ? flags.crop : undefined,
          ref: typeof flags.ref === 'string' ? flags.ref : undefined,
          annotate: Boolean(flags.annotate),
        },
      })
      break
    case 'read':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: flags.visual ? 'page_read_visual' : flags.ascii ? 'page_read_ascii' : 'page_read',
        args: {
          since: Boolean(flags.since),
          width: flags.width ? Number(flags.width) : undefined,
          height: flags.height ? Number(flags.height) : undefined,
          layout: typeof flags.layout === 'string' ? flags.layout : undefined,
          density: typeof flags.density === 'string' ? flags.density : undefined,
          crop: typeof flags.crop === 'string' ? flags.crop : undefined,
          ref: typeof flags.ref === 'string' ? flags.ref : undefined,
          showMediaSummary: Boolean(flags.media),
        },
      })
      break
    case 'find':
      res = await callDaemon(live.endpoint, '/tool', { tabId, name: 'page_find', args: { query: args.join(' ') } })
      break
    case 'text':
      res = await callDaemon(live.endpoint, '/tool', { tabId, name: 'page_text', args: args[0] ? { ref: args[0] } : {} })
      break
    case 'click':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_click',
        args: { ref: args[0], allowSubmit: Boolean(flags['allow-submit'] || flags.submit) },
      })
      break
    case 'fill':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_fill',
        args: { ref: args[0], text: args.slice(1).join(' '), clear: flags.clear !== undefined ? Boolean(flags.clear) : true },
      })
      break
    case 'select':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_select',
        args: { ref: args[0], value: args.slice(1).join(' ') },
      })
      break
    case 'press':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_press',
        args: { key: args[0] ?? 'Enter', ref: typeof flags.ref === 'string' ? flags.ref : undefined },
      })
      break
    case 'scroll':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_scroll',
        args: { direction: args[0] || 'down', amount: args[1] ? Number(args[1]) : 450 },
      })
      break
    case 'wait':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_wait',
        args: {
          ...(args[0] && /^\d+$/.test(args[0]) ? { ms: Number(args[0]) } : {}),
          ...(flags.ms !== undefined ? { ms: Number(flags.ms) } : {}),
          ...(typeof flags.text === 'string' ? { text: flags.text } : {}),
          ...(typeof flags.selector === 'string' ? { selector: flags.selector } : {}),
          ...(typeof flags.url === 'string' ? { url: flags.url } : {}),
          ...(typeof flags.state === 'string' ? { state: flags.state } : {}),
          ...(flags.timeout !== undefined ? { timeout: Number(flags.timeout) } : {}),
        },
      })
      break
    case 'back':
    case 'forward':
    case 'reload':
      res = await callDaemon(live.endpoint, '/tool', { tabId, name: 'page_history', args: { direction: cmd } })
      break
    case 'console':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_console',
        args: { clear: Boolean(flags.clear), level: flags.level, limit: flags.limit ? Number(flags.limit) : 50 },
      })
      break
    case 'network':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_network',
        args: {
          clear: Boolean(flags.clear),
          failedOnly: Boolean(flags.failed),
          blockedOnly: Boolean(flags.blocked),
          limit: flags.limit ? Number(flags.limit) : 50,
        },
      })
      break
    case 'eval':
      res = await callDaemon(live.endpoint, '/tool', { tabId, name: 'page_eval', args: { expression: args.join(' ') } })
      break
    case 'act':
      res = await callDaemon(live.endpoint, '/tool', {
        tabId,
        name: 'page_act',
        args: { steps: JSON.parse(args.join(' ')), allowSubmit: Boolean(flags['allow-submit']) },
      })
      break
    case 'recall':
      res = await callDaemon(live.endpoint, '/recall', { query: args.join(' '), origin: flags.origin, limit: flags.limit ? Number(flags.limit) : 10 })
      break
    case 'forget':
      res = await callDaemon(live.endpoint, '/forget', { origin: args[0] })
      break
    default:
      console.error(`Unknown command: ${cmd}\nRun "troy-advanced help" for usage.`)
      process.exit(1)
  }

  if (!flags.json && (cmd === 'ascii' || cmd === 'visual' || flags.ascii) && typeof res.ascii === 'string') {
    console.log(res.ascii)
  } else if (!flags.json && (cmd === 'markdown' || cmd === 'md') && typeof res.markdown === 'string') {
    console.log(res.markdown)
  } else {
    console.log(JSON.stringify(res, null, 2))
  }
  if (res.ok === false) process.exit(1)
}
