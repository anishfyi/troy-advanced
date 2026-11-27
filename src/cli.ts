// CLI entrypoint for `troy-advanced`.

import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AuditLogOptions,
  BrowserCookie,
  CrashRecoveryOptions,
  DialogPolicyOptions,
  DownloadPolicyOptions,
  EmulationOptions,
  EngineKind,
  OriginStorageSnapshot,
  TrackerBlockingOptions,
  TrackerBlockMode,
} from './types.js'
import { BrowserManager } from './engine/manager.js'
import {
  computeAuditStats,
  filterAuditEntries,
  formatAuditAscii,
  parseAuditEventKind,
  readAuditJsonl,
} from './agent/audit.js'
import {
  createDaemonFlowExecutor,
  createManagerFlowExecutor,
  formatFlowReportAscii,
  parseFlowJson,
  parseVarOverrides,
  runFlow,
} from './agent/flow-runner.js'
import { parseSessionId, SESSION_HEADER } from './agent/sessions.js'
import { parseDialogMode, parseDialogType } from './engine/dialogs.js'
import { parseDownloadMode } from './engine/downloads.js'
import { parseHeaderList } from './engine/emulation.js'
import {
  filterCookies,
  parseCookieBundle,
  readCookieFile,
  serializeCookieBundle,
  writeCookieFile,
} from './engine/cookies.js'
import {
  countStorageKeys,
  filterStorageSnapshots,
  normalizeStorageArea,
  parseStorageBundle,
  readStorageFile,
  serializeStorageBundle,
  writeStorageFile,
} from './engine/storage.js'
import { readLiveEndpoint } from './bridge/endpoint.js'
import { runDaemonForeground, startDaemonDetached, stopDaemon } from './cloud/daemon.js'
import { formatDoctorAscii, runDoctor } from './cloud/doctor.js'
import { parseMcpFramingMode, runMcpStdioServer } from './mcp/server.js'
import {
  TOOL_SCHEMA_FORMATS,
  formatToolSchemasJson,
  parseToolSchemaFormat,
} from './mcp/schema.js'
import { runPipeRepl } from './pipe/repl.js'
import { runTerminalBrowser } from './tui/terminal-browser.js'
import { parseMaxTokens } from './ascii/token-budget.js'
import { parseInspectorTab } from './tui/inspector.js'
import { parseViewMode } from './tui/pixel-preview.js'
import { parseNonTtyPolicy } from './tui/tty-fallback.js'

const USAGE = `troy-advanced — terminal-native, EC2-ready, ASCII-rendered AI browser

Usage: troy-advanced <command> [args] [flags]

Daemon & Modes:
  daemon start [--engine auto|chromium|lite] [--cdp-url ws://...|http://...] [--compat-troy] [--port N] [--url U]
  daemon run   (foreground daemon for systemd / Docker)
  daemon stop | status
  browse [url] [--ascii] [--view layout|pixel-ascii|braille|halfblock] [--split] [--inspector console|network|refs|activity] [--non-tty auto|snapshot|batch|interactive] [--engine auto|chromium|lite] [--cdp-url ws://...|http://...]
                                                         Interactive ASCII terminal browser (auto-detects piped/non-TTY fallback)
  mcp          [--framing auto|ndjson|content-length] [--engine auto|chromium|lite] [--cdp-url ws://...|http://...]
                                                         Model Context Protocol stdio server (auto-detects NDJSON & Content-Length framing)
  schema       [--format openai|anthropic|gemini|mcp] [--tools a,b] [--prefix <str>] [--strict] [--compact] [--out <file>]
                                                         Generate provider-ready JSON tool schemas for OpenAI, Anthropic, Gemini, or MCP
  run          <flow.json|-> [--var k=v] [--base-url <url>] [--dump-dir <dir>] [--continue-on-error] [--oneshot] [--width N] [--height N] [--json]
                                                         Execute a replayable JSON macro/flow with assertions and ASCII failure dumps
  pipe         [--json] [--engine auto|chromium|lite] [--cdp-url ws://...|http://...]
                                                         Streaming stdin/stdout AI REPL
  doctor       [--json]                                  EC2 / Linux / Chrome environment check
  ec2 setup                                              Print EC2 systemd & SSH forwarding guide

Client Commands (talk to running daemon, or use --oneshot):
  status                                  Daemon health + memory stats
  tabs                                    List open tabs
  open <url|query>                        Open tab; prints id (or ASCII with --ascii)
  ascii [--since] [--width N] [--height N] [--density compact|normal|wide] [--layout flow|spatial|auto] [--max-tokens N] [--crop x,y,w,h] [--ref eN]
                                          Render tab as strict 7-bit ASCII viewport (auto-trimmed to --max-tokens N, or diff with --since)
  stream [--since] [--width N] [--height N] [--density compact|normal|wide] [--layout flow|spatial|auto] [--max-tokens N] [--poll-ms N] [--throttle-ms N] [--max-frames N] [--mode ascii|delta|events] [--json]
                                          Subscribe to SSE /stream for live ASCII frame broadcasts on navigation & mutation
  markdown [--frontmatter] [--no-refs] [--no-urls] [--media] [--ascii] [--crop x,y,w,h] [--ref eN]
                                          Export tab as CommonMark/GFM Markdown preserving inline [eN] refs
  visual [--mode ascii|edge|braille|halfblock] [--annotate] [--crop x,y,w,h] [--ref eN]
                                          Render Chromium PNG screenshot (or cropped region) as ASCII
  read [--since] [--ascii] [--visual] [--max-tokens N] [--crop x,y,w,h] [--ref eN] [--json]
                                          Read page structure or ASCII/JSON delta
  find <query>                            Find interactive elements as eN refs
  extract [url] [--sections tables,forms,links,headings,metadata] [--max-items N] [--external|--internal] [--ascii]
                                          Extract structured tables, forms (with eN refs), links, headings, and JSON-LD/OpenGraph metadata
  click <ref> [--allow-submit]            Click element ref
  fill <ref> <text> [--clear]             Fill input ref
  select <ref> <value>                    Select dropdown option
  press <key> [--ref eN]                  Press key or chord (e.g. Control+A, Shift+Tab, Escape, ArrowDown, Meta+K)
  scroll [up|down|top|bottom] [amount]    Scroll page
  wait [ms] [--text <str>] [--selector <css>] [--url <pattern>] [--state visible|hidden|attached] [--timeout <ms>]
                                          Wait for page condition or fixed delay
  back | forward | reload                 History navigation
  console | eval <expr>                   Inspect console logs or evaluate JS
  network [--body <reqId>] [--failed] [--blocked] [--method <M>] [--url-filter <str>] [--reveal] [--raw] [--binary] [--max-chars <N>] [--clear] [--ascii] [--json]
                                          List network requests or inspect request/response headers & body by reqId
  downloads [--blocked] [--clear] [--mode quarantine|deny|allow] [--remove <id>] [--json]
                                          Inspect intercepted/quarantined/blocked auto-downloads or update policy
  dialogs [--type alert|confirm|prompt|beforeunload] [--mode dismiss|accept] [--next accept|dismiss] [--prompt-text <str>] [--clear] [--clear-queue] [--json]
                                          Inspect captured JS dialogs, configure auto-dismiss/accept policy, or queue next response
  audit [--limit N] [--tool <name>] [--kind <k>] [--refused] [--transitions] [--failed] [--tab <id>] [--session <id>] [--disk] [--file <path>] [--clear] [--truncate] [--json]
                                          Inspect persistent agent action audit log (audit.jsonl) with refusals, timing, and URL transitions
  sessions [id | close <id> [--keep-tabs]] [--json]
                                          List, inspect, or close isolated multi-agent sessions (x-troy-session)
  act <json-steps> [--allow-submit]       Run batched action list
  grant <origin>                          Extend origin autonomy boundary
  recall <query> | forget [origin]        Query or clear persistent page memory
  cookies export [file] [--domain <host>] [--url <url>] [--include-expired] [--encrypt] [--passphrase <pass>]
                                          Export cookies (0600 file or stdout) for secure EC2 transfer
  cookies import [file|-] [--domain <host>] [--passphrase <pass>]
                                          Import plain or AES-256-GCM encrypted cookies into daemon or profile
  cookies clear [--domain <host>]         Clear cookies from daemon or profile
  storage inspect [--origin <origin|host>] [--area local|session|both] [--prefix <str>] [--reveal] [--json]
                                          Inspect localStorage/sessionStorage (redacted by default)
  storage export [file] [--origin <origin|host>] [--area local|session|both] [--prefix <str>] [--encrypt] [--passphrase <pass>]
                                          Export web storage (0600 file or stdout) for EC2 session hydration
  storage import [file|-] [--origin <origin|host>] [--area local|session|both] [--clear] [--passphrase <pass>]
                                          Import plain or AES-256-GCM encrypted web storage into daemon or profile
  storage clear [--origin <origin|host>] [--area local|session|both] [--keys k1,k2]
                                          Clear localStorage/sessionStorage from daemon or profile
  emulate [desktop|mobile|terminal|WxH] [--user-agent <ua>] [--accept-language <lang>] [--platform <p>] [--header "K: V"] [--remove-header <k>] [--clear-headers] [--all-tabs] [--reveal]
                                          Inspect or configure viewport presets, User-Agent, and custom HTTP headers

Global Flags:
  --tab <id>  --session <id>  --endpoint <file>  --engine <auto|chromium|lite>  --cdp-url <ws://...|http://...>  --viewport <preset|WxH>  --user-agent <ua>  --header "K: V"  --json  --ascii  --width <n>
`

const VALUE_FLAGS = new Set([
  '--tab',
  '--session',
  '--endpoint',
  '--engine',
  '--port',
  '--cdp-port',
  '--remote-cdp-port',
  '--cdp-url',
  '--profile',
  '--url',
  '--width',
  '--height',
  '--layout',
  '--density',
  '--max-tokens',
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
  '--domain',
  '--passphrase',
  '--out',
  '--in',
  '--area',
  '--prefix',
  '--keys',
  '--viewport',
  '--user-agent',
  '--ua',
  '--accept-language',
  '--platform',
  '--header',
  '--remove-header',
  '--body',
  '--max-chars',
  '--method',
  '--url-filter',
  '--framing',
  '--format',
  '--tools',
  '--audit-file',
  '--file',
  '--kind',
  '--tool',
  '--var',
  '--base-url',
  '--dump-dir',
  '--throttle-ms',
  '--poll-ms',
  '--heartbeat-ms',
  '--max-frames',
])

const REPEATABLE_FLAGS = new Set(['--header', '--remove-header', '--var'])

async function readStdinUtf8(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseArgv(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  const multiFlags: Record<string, string[]> = {}
  const pushMulti = (key: string, val: string) => {
    if (!multiFlags[key]) multiFlags[key] = []
    multiFlags[key]!.push(val)
    flags[key] = val
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (tok === '-H' && i + 1 < argv.length) {
      pushMulti('header', argv[++i]!)
      continue
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      if (eq > 0) {
        const flagName = tok.slice(0, eq)
        const key = tok.slice(2, eq)
        const val = tok.slice(eq + 1)
        if (REPEATABLE_FLAGS.has(flagName)) pushMulti(key, val)
        else flags[key] = val
      } else if (VALUE_FLAGS.has(tok) && i + 1 < argv.length) {
        const key = tok.slice(2)
        const val = argv[++i]!
        if (REPEATABLE_FLAGS.has(tok)) pushMulti(key, val)
        else flags[key] = val
      } else {
        flags[tok.slice(2)] = true
      }
    } else {
      positional.push(tok)
    }
  }
  return { positional, flags, multiFlags }
}

async function callDaemon(
  endpoint: { agentPort: number; agentToken: string; sessionId?: string },
  route: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-troy-agent': endpoint.agentToken,
  }
  if (endpoint.sessionId) {
    headers[SESSION_HEADER] = endpoint.sessionId
  }
  const res = await fetch(`http://127.0.0.1:${endpoint.agentPort}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags, multiFlags } = parseArgv(argv)
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
  const crashRecovery: CrashRecoveryOptions | undefined =
    flags['no-crash-recovery'] || flags['max-restarts'] !== undefined
      ? {
          enabled: !flags['no-crash-recovery'],
          maxRestarts: flags['max-restarts'] !== undefined ? Number(flags['max-restarts']) : undefined,
        }
      : undefined
  const downloadModeFlag = parseDownloadMode(flags['download-mode'])
  const downloadMaxBytesFlag =
    flags['download-max-bytes'] !== undefined ? Number(flags['download-max-bytes']) : undefined
  const downloadsOpts: DownloadPolicyOptions | undefined =
    downloadModeFlag || downloadMaxBytesFlag !== undefined
      ? {
          ...(downloadModeFlag ? { mode: downloadModeFlag } : {}),
          ...(downloadMaxBytesFlag !== undefined && Number.isFinite(downloadMaxBytesFlag)
            ? { maxBytes: downloadMaxBytesFlag }
            : {}),
        }
      : undefined
  const dialogModeFlag = parseDialogMode(flags['dialog-mode'])
  const dialogPromptFlag =
    typeof flags['dialog-prompt-text'] === 'string' ? flags['dialog-prompt-text'] : undefined
  const dialogDismissBeforeUnloadFlag = Boolean(flags['dialog-dismiss-beforeunload'])
  const dialogsOpts: DialogPolicyOptions | undefined =
    dialogModeFlag || dialogPromptFlag !== undefined || dialogDismissBeforeUnloadFlag
      ? {
          ...(dialogModeFlag ? { mode: dialogModeFlag } : {}),
          ...(dialogPromptFlag !== undefined ? { defaultPromptText: dialogPromptFlag } : {}),
          ...(dialogDismissBeforeUnloadFlag ? { acceptBeforeUnload: false } : {}),
        }
      : undefined
  const auditOpts: AuditLogOptions | undefined =
    flags['no-audit'] || typeof flags['audit-file'] === 'string'
      ? {
          ...(flags['no-audit'] ? { enabled: false } : {}),
          ...(typeof flags['audit-file'] === 'string' && flags['audit-file'].trim()
            ? { filePath: path.resolve(flags['audit-file'].trim()) }
            : {}),
        }
      : undefined
  const rawHeaderArgs = multiFlags.header ?? []
  const cliUserAgent =
    typeof flags['user-agent'] === 'string'
      ? flags['user-agent']
      : typeof flags.ua === 'string'
        ? flags.ua
        : undefined
  const cliEmulation: EmulationOptions | undefined =
    typeof flags.viewport === 'string' ||
    cliUserAgent !== undefined ||
    typeof flags['accept-language'] === 'string' ||
    typeof flags.platform === 'string' ||
    rawHeaderArgs.length > 0
      ? {
          ...(typeof flags.viewport === 'string' ? { viewport: flags.viewport } : {}),
          ...(cliUserAgent !== undefined ? { userAgent: cliUserAgent } : {}),
          ...(typeof flags['accept-language'] === 'string' ? { acceptLanguage: flags['accept-language'] } : {}),
          ...(typeof flags.platform === 'string' ? { platform: flags.platform } : {}),
          ...(rawHeaderArgs.length > 0 ? { extraHeaders: parseHeaderList(rawHeaderArgs) } : {}),
        }
      : undefined

  const cdpUrlFlag =
    typeof flags['cdp-url'] === 'string' && flags['cdp-url'].trim()
      ? flags['cdp-url'].trim()
      : process.env.TROY_CDP_URL?.trim() || undefined
  const remoteCdpPortFlag = flags['remote-cdp-port'] ? Number(flags['remote-cdp-port']) : undefined

  if (cmd === 'doctor') {
    const report = runDoctor()
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatDoctorAscii(report))
    return
  }

  if (cmd === 'audit' && typeof flags.file === 'string' && flags.file.trim()) {
    const filePath = path.resolve(flags.file.trim())
    const allEntries = readAuditJsonl(filePath)
    const filtered = filterAuditEntries(allEntries, {
      limit: flags.limit !== undefined ? Number(flags.limit) : 100,
      kind: parseAuditEventKind(flags.kind),
      tool: typeof flags.tool === 'string' && flags.tool.trim() ? flags.tool.trim() : undefined,
      tabId: flags.tab !== undefined ? Number(flags.tab) : undefined,
      refusedOnly: Boolean(flags.refused),
      urlChangedOnly: Boolean(flags.transitions),
      failedOnly: Boolean(flags.failed),
    })
    const stats = computeAuditStats(allEntries, { enabled: true, filePath })
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, count: filtered.length, entries: filtered, stats }, null, 2))
    } else {
      console.log(
        formatAuditAscii(filtered, stats, {
          width: flags.width !== undefined ? Number(flags.width) : undefined,
        }),
      )
    }
    return
  }

  if (cmd === 'run') {
    const flowPath = positional[1]
    if (!flowPath) {
      console.error(
        JSON.stringify(
          { ok: false, error: 'Usage: troy-advanced run <flow.json|-> [--var k=v] [--base-url <url>] [--dump-dir <dir>] [--continue-on-error] [--oneshot] [--json]' },
          null,
          2,
        ),
      )
      process.exit(1)
    }

    let rawFlow: string
    try {
      rawFlow = flowPath === '-' ? await readStdinUtf8() : fs.readFileSync(path.resolve(flowPath), 'utf8')
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: `Failed to read flow "${flowPath}": ${(err as Error).message}` }, null, 2))
      process.exit(1)
    }

    let flow
    let varOverrides: Record<string, string>
    try {
      flow = parseFlowJson(rawFlow)
      varOverrides = parseVarOverrides(multiFlags.var ?? [])
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2))
      process.exit(1)
    }

    const runOpts = {
      vars: varOverrides,
      baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
      stopOnFailure: flags['continue-on-error'] ? false : undefined,
      dumpDir: typeof flags['dump-dir'] === 'string' ? path.resolve(flags['dump-dir']) : undefined,
      dumpWidth: flags.width !== undefined ? Number(flags.width) : undefined,
      dumpHeight: flags.height !== undefined ? Number(flags.height) : undefined,
    }

    const rawSession = typeof flags.session === 'string' ? flags.session : process.env.TROY_SESSION
    const parsedSession = parseSessionId(rawSession)
    if (!parsedSession.ok) {
      console.error(JSON.stringify({ ok: false, error: parsedSession.error }, null, 2))
      process.exit(1)
    }
    const sessionId = parsedSession.sessionId
    const explicitTabId = flags.tab !== undefined ? Number(flags.tab) : undefined
    const live = flags.oneshot ? null : readLiveEndpoint(endpointFlag)

    let report
    if (live) {
      const executor = createDaemonFlowExecutor(
        { ...live.endpoint, sessionId },
        { tabId: explicitTabId },
      )
      report = await runFlow(flow, executor, runOpts)
    } else {
      const manager = await BrowserManager.create({
        engine,
        profileDir: typeof flags.profile === 'string' ? path.resolve(flags.profile) : undefined,
        remoteCdpPort: remoteCdpPortFlag,
        cdpUrl: cdpUrlFlag,
        trackerBlocking,
        crashRecovery,
        downloads: downloadsOpts,
        dialogs: dialogsOpts,
        audit: auditOpts,
        emulation: cliEmulation,
        memoryEnabled: false,
      })
      try {
        const executor = createManagerFlowExecutor(manager, {
          tabId: explicitTabId,
          sessionId,
        })
        report = await runFlow(flow, executor, runOpts)
      } finally {
        await manager.close()
      }
    }

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(
        formatFlowReportAscii(report, {
          width: flags.width !== undefined ? Number(flags.width) : undefined,
        }),
      )
    }
    if (!report.ok) {
      process.exitCode = 1
    }
    return
  }

  if (cmd === 'schema') {
    const rawFormat =
      typeof flags.format === 'string'
        ? flags.format
        : typeof positional[1] === 'string'
          ? positional[1]
          : 'mcp'
    const format = parseToolSchemaFormat(rawFormat)
    if (!format) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: `Invalid schema format: "${rawFormat}". Expected one of: ${TOOL_SCHEMA_FORMATS.join(', ')}`,
          },
          null,
          2,
        ),
      )
      process.exit(1)
    }

    const toolsFilter =
      typeof flags.tools === 'string'
        ? flags.tools
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    const prefix = typeof flags.prefix === 'string' ? flags.prefix : undefined
    const strict = Boolean(flags.strict)
    const compact = Boolean(flags.compact)

    try {
      const json = formatToolSchemasJson({
        format,
        tools: toolsFilter,
        prefix,
        strict,
        compact,
      })
      if (typeof flags.out === 'string' && flags.out.trim()) {
        const outPath = path.resolve(flags.out.trim())
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, `${json}\n`, 'utf8')
        console.log(JSON.stringify({ ok: true, format, out: outPath }, null, 2))
      } else {
        console.log(json)
      }
    } catch (err) {
      console.error(
        JSON.stringify(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          null,
          2,
        ),
      )
      process.exit(1)
    }
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

4. Or drive Chrome on another EC2 node over an SSH tunnel using --cdp-url:
   ssh -f -N -L 19222:127.0.0.1:9222 ec2-user@<chrome-node>
   troy-advanced daemon start --cdp-url http://127.0.0.1:19222

5. Or run AI agents directly on the EC2 host over SSH/tmux:
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
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      endpointFile: endpointFlag,
      compatTroy: Boolean(flags['compat-troy']),
      initialUrl: typeof flags.url === 'string' ? flags.url : undefined,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
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
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
    })
    try {
      const inspectorTabFlag =
        typeof flags.inspector === 'string' ? parseInspectorTab(flags.inspector) : undefined
      const splitPaneFlag = Boolean(flags.split) || Boolean(flags.inspector)
      const nonTtyModeFlag =
        typeof flags['non-tty'] === 'string' ? parseNonTtyPolicy(flags['non-tty']) : undefined
      const viewModeFlag =
        typeof flags.view === 'string' ? (parseViewMode(flags.view) ?? undefined) : undefined
      await runTerminalBrowser(manager, {
        initialUrl: positional[1],
        asciiOnly: flags.ascii !== undefined ? Boolean(flags.ascii) : undefined,
        splitPane: splitPaneFlag,
        inspectorTab: inspectorTabFlag,
        nonTtyMode: nonTtyModeFlag,
        viewMode: viewModeFlag,
      })
    } finally {
      await manager.close()
    }
    return
  }

  if (cmd === 'mcp') {
    const rawFraming =
      typeof flags.framing === 'string'
        ? flags.framing
        : flags['content-length']
          ? 'content-length'
          : flags.ndjson
            ? 'ndjson'
            : process.env.TROY_MCP_FRAMING
    const framing = parseMcpFramingMode(rawFraming)
    const manager = await BrowserManager.create({
      engine,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
    })
    try {
      await runMcpStdioServer(manager, process.stdin, process.stdout, { framing })
    } finally {
      await manager.close()
    }
    return
  }

  if (cmd === 'pipe') {
    const manager = await BrowserManager.create({
      engine,
      profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
    })
    try {
      await runPipeRepl(manager, { jsonMode: Boolean(flags.json) })
    } finally {
      await manager.close()
    }
    return
  }

  if (cmd === 'cookies') {
    const sub = positional[1]
    if (sub !== 'export' && sub !== 'import' && sub !== 'clear') {
      console.error('Usage: troy-advanced cookies <export|import|clear> [file] [flags]')
      process.exit(1)
    }

    const explicitProfile = typeof flags.profile === 'string' ? flags.profile : undefined
    const useDaemon = !explicitProfile && !flags.oneshot
    const live = useDaemon ? readLiveEndpoint(endpointFlag) : null
    const domainFilter = typeof flags.domain === 'string' ? flags.domain : undefined
    const urlFilter = typeof flags.url === 'string' ? flags.url : undefined

    if (sub === 'export') {
      const passphrase =
        typeof flags.passphrase === 'string'
          ? flags.passphrase
          : flags.encrypt
            ? process.env.TROY_COOKIE_PASSPHRASE
            : undefined
      if (flags.encrypt && !passphrase) {
        console.error(
          JSON.stringify(
            { ok: false, error: '--encrypt requires --passphrase <pass> or TROY_COOKIE_PASSPHRASE env var' },
            null,
            2,
          ),
        )
        process.exit(1)
      }

      let cookies: BrowserCookie[]
      let exportEngine: 'chromium' | 'lite'
      if (live) {
        const res = await callDaemon(live.endpoint, '/cookies/export', {
          domain: domainFilter,
          url: urlFilter,
          includeExpired: Boolean(flags['include-expired']),
        })
        if (!res.ok) {
          console.error(JSON.stringify(res, null, 2))
          process.exit(1)
        }
        cookies = Array.isArray(res.cookies) ? (res.cookies as BrowserCookie[]) : []
        exportEngine = res.engine === 'lite' ? 'lite' : 'chromium'
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          cookies = await manager.exportCookies({
            domain: domainFilter,
            url: urlFilter,
            includeExpired: Boolean(flags['include-expired']),
          })
          exportEngine = manager.engine.kind
        } finally {
          await manager.close()
        }
      }

      const serialized = serializeCookieBundle(cookies, { engine: exportEngine, passphrase })
      const outFile = typeof flags.out === 'string' ? flags.out : positional[2]
      if (outFile && outFile !== '-') {
        const written = writeCookieFile(outFile, serialized)
        console.log(
          JSON.stringify(
            {
              ok: true,
              file: written.path,
              bytes: written.bytes,
              mode: written.mode,
              engine: exportEngine,
              count: cookies.length,
              encrypted: Boolean(passphrase),
            },
            null,
            2,
          ),
        )
      } else {
        process.stdout.write(`${serialized}\n`)
      }
      return
    }

    if (sub === 'import') {
      const inFile = typeof flags.in === 'string' ? flags.in : positional[2]
      let rawJson: string
      try {
        rawJson = inFile && inFile !== '-' ? readCookieFile(inFile) : await readStdinUtf8()
      } catch (err) {
        console.error(JSON.stringify({ ok: false, error: `Failed to read cookie input: ${(err as Error).message}` }, null, 2))
        process.exit(1)
      }

      const passphrase =
        typeof flags.passphrase === 'string' ? flags.passphrase : process.env.TROY_COOKIE_PASSPHRASE

      let parsed: { cookies: BrowserCookie[]; encrypted: boolean; skipped: number }
      try {
        parsed = parseCookieBundle(rawJson, { passphrase })
      } catch (err) {
        console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2))
        process.exit(1)
      }

      const cookiesToImport = domainFilter
        ? filterCookies(parsed.cookies, { domain: domainFilter, includeExpired: true })
        : parsed.cookies

      if (live) {
        const res = await callDaemon(live.endpoint, '/cookies/import', { cookies: cookiesToImport })
        const merged = {
          ...res,
          skipped: Number(res.skipped ?? 0) + parsed.skipped,
          encrypted: parsed.encrypted,
        }
        console.log(JSON.stringify(merged, null, 2))
        if (!res.ok) process.exit(1)
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          const res = await manager.importCookies(cookiesToImport)
          console.log(
            JSON.stringify(
              {
                ok: true,
                engine: manager.engine.kind,
                imported: res.imported,
                skipped: res.skipped + parsed.skipped,
                encrypted: parsed.encrypted,
                errors: res.errors,
              },
              null,
              2,
            ),
          )
        } finally {
          await manager.close()
        }
      }
      return
    }

    if (sub === 'clear') {
      if (live) {
        const res = await callDaemon(live.endpoint, '/cookies/clear', { domain: domainFilter })
        console.log(JSON.stringify(res, null, 2))
        if (!res.ok) process.exit(1)
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          const removed = await manager.clearCookies({ domain: domainFilter })
          console.log(JSON.stringify({ ok: true, engine: manager.engine.kind, removed }, null, 2))
        } finally {
          await manager.close()
        }
      }
      return
    }
  }

  if (cmd === 'storage') {
    const sub = positional[1]
    if (sub !== 'inspect' && sub !== 'export' && sub !== 'import' && sub !== 'clear') {
      console.error('Usage: troy-advanced storage <inspect|export|import|clear> [file] [flags]')
      process.exit(1)
    }

    const explicitProfile = typeof flags.profile === 'string' ? flags.profile : undefined
    const useDaemon = !explicitProfile && !flags.oneshot
    const live = useDaemon ? readLiveEndpoint(endpointFlag) : null
    const originFilter = typeof flags.origin === 'string' ? flags.origin : undefined
    const area = typeof flags.area === 'string' ? normalizeStorageArea(flags.area) : undefined
    const keyPrefix = typeof flags.prefix === 'string' ? flags.prefix : undefined
    const tabId = flags.tab ? Number(flags.tab) : undefined

    if (sub === 'inspect') {
      const revealValues = Boolean(flags.reveal)
      const width = flags.width ? Number(flags.width) : undefined
      let result: Record<string, unknown>

      if (live) {
        result = await callDaemon(live.endpoint, '/storage/inspect', {
          tabId,
          origin: originFilter,
          area,
          keyPrefix,
          revealValues,
          width,
        })
        if (!result.ok) {
          console.error(JSON.stringify(result, null, 2))
          process.exit(1)
        }
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          const inspected = await manager.inspectStorage({
            tabId,
            origin: originFilter,
            area,
            keyPrefix,
            revealValues,
            width,
          })
          result = { ok: true, ...inspected }
        } finally {
          await manager.close()
        }
      }

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        process.stdout.write(`${String(result.ascii ?? '')}\n`)
      }
      return
    }

    if (sub === 'export') {
      const passphrase =
        typeof flags.passphrase === 'string'
          ? flags.passphrase
          : flags.encrypt
            ? process.env.TROY_STORAGE_PASSPHRASE || process.env.TROY_COOKIE_PASSPHRASE
            : undefined
      if (flags.encrypt && !passphrase) {
        console.error(
          JSON.stringify(
            { ok: false, error: '--encrypt requires --passphrase <pass> or TROY_STORAGE_PASSPHRASE env var' },
            null,
            2,
          ),
        )
        process.exit(1)
      }

      let origins: OriginStorageSnapshot[]
      let exportEngine: 'chromium' | 'lite'
      if (live) {
        const res = await callDaemon(live.endpoint, '/storage/export', {
          tabId,
          origin: originFilter,
          area,
          keyPrefix,
        })
        if (!res.ok) {
          console.error(JSON.stringify(res, null, 2))
          process.exit(1)
        }
        origins = Array.isArray(res.origins) ? (res.origins as OriginStorageSnapshot[]) : []
        exportEngine = res.engine === 'lite' ? 'lite' : 'chromium'
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          origins = await manager.exportStorage({
            tabId,
            origin: originFilter,
            area,
            keyPrefix,
          })
          exportEngine = manager.engine.kind
        } finally {
          await manager.close()
        }
      }

      const serialized = serializeStorageBundle(origins, { engine: exportEngine, passphrase })
      const counts = countStorageKeys(origins)
      const outFile = typeof flags.out === 'string' ? flags.out : positional[2]
      if (outFile && outFile !== '-') {
        const written = writeStorageFile(outFile, serialized)
        console.log(
          JSON.stringify(
            {
              ok: true,
              file: written.path,
              bytes: written.bytes,
              mode: written.mode,
              engine: exportEngine,
              originCount: origins.length,
              localKeys: counts.localKeys,
              sessionKeys: counts.sessionKeys,
              totalKeys: counts.totalKeys,
              encrypted: Boolean(passphrase),
            },
            null,
            2,
          ),
        )
      } else {
        process.stdout.write(`${serialized}\n`)
      }
      return
    }

    if (sub === 'import') {
      const inFile = typeof flags.in === 'string' ? flags.in : positional[2]
      let rawJson: string
      try {
        rawJson = inFile && inFile !== '-' ? readStorageFile(inFile) : await readStdinUtf8()
      } catch (err) {
        console.error(JSON.stringify({ ok: false, error: `Failed to read storage input: ${(err as Error).message}` }, null, 2))
        process.exit(1)
      }

      const passphrase =
        typeof flags.passphrase === 'string'
          ? flags.passphrase
          : process.env.TROY_STORAGE_PASSPHRASE || process.env.TROY_COOKIE_PASSPHRASE

      let parsed: { origins: OriginStorageSnapshot[]; encrypted: boolean; skipped: number }
      try {
        parsed = parseStorageBundle(rawJson, { passphrase })
      } catch (err) {
        console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2))
        process.exit(1)
      }

      const originsToImport = filterStorageSnapshots(parsed.origins, {
        origin: originFilter,
        area,
        keyPrefix,
      })

      if (live) {
        const res = await callDaemon(live.endpoint, '/storage/import', {
          origins: originsToImport,
          tabId,
          origin: originFilter,
          area,
          clearBeforeImport: Boolean(flags.clear),
        })
        const merged = {
          ...res,
          skipped: Number(res.skipped ?? 0) + parsed.skipped,
          encrypted: parsed.encrypted,
        }
        console.log(JSON.stringify(merged, null, 2))
        if (!res.ok) process.exit(1)
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          const res = await manager.importStorage(originsToImport, {
            tabId,
            origin: originFilter,
            area,
            clearBeforeImport: Boolean(flags.clear),
          })
          console.log(
            JSON.stringify(
              {
                ok: true,
                engine: manager.engine.kind,
                importedOrigins: res.importedOrigins,
                localKeys: res.localKeys,
                sessionKeys: res.sessionKeys,
                skipped: res.skipped + parsed.skipped,
                encrypted: parsed.encrypted,
                errors: res.errors,
              },
              null,
              2,
            ),
          )
        } finally {
          await manager.close()
        }
      }
      return
    }

    if (sub === 'clear') {
      const keys =
        typeof flags.keys === 'string'
          ? flags.keys
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean)
          : undefined

      if (live) {
        const res = await callDaemon(live.endpoint, '/storage/clear', {
          tabId,
          origin: originFilter,
          area,
          keys,
        })
        console.log(JSON.stringify(res, null, 2))
        if (!res.ok) process.exit(1)
      } else {
        const manager = await BrowserManager.create({
          engine,
          profileDir: explicitProfile,
          remoteCdpPort: remoteCdpPortFlag,
          cdpUrl: cdpUrlFlag,
          trackerBlocking,
          memoryEnabled: false,
        })
        try {
          const res = await manager.clearStorage({
            tabId,
            origin: originFilter,
            area,
            keys,
          })
          console.log(JSON.stringify({ ok: true, engine: manager.engine.kind, ...res }, null, 2))
        } finally {
          await manager.close()
        }
      }
      return
    }
  }

  // One-shot ASCII / Markdown / Visual / Extract fetch without needing a running daemon
  if ((cmd === 'ascii' || cmd === 'visual' || cmd === 'markdown' || cmd === 'md' || cmd === 'extract') && positional[1] && !readLiveEndpoint(endpointFlag)) {
    const manager = await BrowserManager.create({
      engine,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      trackerBlocking,
      emulation: cliEmulation,
    })
    try {
      const opened = await manager.openTab(positional[1], { activate: true })
      if (!opened.ok) {
        console.error(JSON.stringify(opened, null, 2))
        process.exit(1)
      }
      if (cmd === 'extract') {
        const res = await manager.runTool(opened.id, 'page_extract', {
          sections: typeof flags.sections === 'string' ? flags.sections : undefined,
          maxItems: flags['max-items'] ? Number(flags['max-items']) : undefined,
          includeObjects: !flags['no-objects'],
          asciiOnly: Boolean(flags['ascii-only']),
          externalLinksOnly: Boolean(flags.external),
          internalLinksOnly: Boolean(flags.internal),
          ascii: Boolean(flags.ascii),
          width: flags.width ? Number(flags.width) : undefined,
          settle: Boolean(flags.settle),
        })
        if (flags.ascii && !flags.json && typeof res.ascii === 'string') console.log(res.ascii)
        else console.log(JSON.stringify(res, null, 2))
        return
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
      const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
      const res = await manager.runTool(opened.id, toolName, {
        width: flags.width ? Number(flags.width) : cmd === 'visual' ? 80 : undefined,
        height: flags.height ? Number(flags.height) : undefined,
        layout: typeof flags.layout === 'string' ? flags.layout : undefined,
        density: typeof flags.density === 'string' ? flags.density : undefined,
        ...(maxTokensOpt !== undefined ? { maxTokens: maxTokensOpt } : {}),
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

  const rawSession = typeof flags.session === 'string' ? flags.session : process.env.TROY_SESSION
  const parsedSession = parseSessionId(rawSession)
  if (!parsedSession.ok) {
    console.error(JSON.stringify({ ok: false, error: parsedSession.error }, null, 2))
    process.exit(1)
  }
  const sessionId = parsedSession.sessionId
  const daemonEndpoint = sessionId ? { ...live.endpoint, sessionId } : live.endpoint

  const tabId = flags.tab !== undefined ? Number(flags.tab) : undefined
  const args = positional.slice(1)
  let res: Record<string, unknown>

  switch (cmd) {
    case 'stream': {
      const params = new URLSearchParams()
      if (tabId !== undefined) params.set('tabId', String(tabId))
      if (flags.width !== undefined) params.set('width', String(flags.width))
      if (flags.height !== undefined) params.set('height', String(flags.height))
      if (typeof flags.density === 'string') params.set('density', flags.density)
      if (typeof flags.layout === 'string') params.set('layout', flags.layout)
      if (flags['max-tokens'] !== undefined) params.set('maxTokens', String(flags['max-tokens']))
      if (flags.since) params.set('since', 'true')
      if (typeof flags.mode === 'string') params.set('mode', flags.mode)
      if (flags['throttle-ms'] !== undefined) params.set('throttleMs', String(flags['throttle-ms']))
      if (flags['poll-ms'] !== undefined) params.set('pollMs', String(flags['poll-ms']))
      if (flags['heartbeat-ms'] !== undefined) params.set('heartbeatMs', String(flags['heartbeat-ms']))
      if (flags['no-initial']) params.set('initial', 'false')
      if (flags['no-dedupe']) params.set('dedupe', 'false')
      const maxFrames = flags['max-frames'] !== undefined ? Number(flags['max-frames']) : undefined

      const qs = params.toString()
      const streamUrl = `http://127.0.0.1:${daemonEndpoint.agentPort}/stream${qs ? `?${qs}` : ''}`
      const controller = new AbortController()
      const onSig = () => controller.abort()
      process.once('SIGINT', onSig)
      process.once('SIGTERM', onSig)

      try {
        const resp = await fetch(streamUrl, {
          method: 'GET',
          headers: {
            'x-troy-agent': daemonEndpoint.agentToken,
            ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
            accept: 'text/event-stream',
          },
          signal: controller.signal,
        })
        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => '')
          console.error(text || JSON.stringify({ ok: false, error: `HTTP ${resp.status}` }))
          process.exit(1)
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let framesSeen = 0

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')

            const dataLines = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
            if (!dataLines.length) continue
            const rawJson = dataLines.join('\n')
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(rawJson) as Record<string, unknown>
            } catch {
              continue
            }

            if (flags.json) {
              console.log(JSON.stringify(parsed))
            } else if (parsed.type === 'ascii_frame' && typeof parsed.ascii === 'string') {
              console.log(
                `--- [frame #${parsed.seq ?? '?'} | ${parsed.reason ?? 'update'} | tab ${parsed.tabId ?? '?'} | ${parsed.mode ?? 'full'}] ---`,
              )
              console.log(parsed.ascii)
            }

            if (parsed.type === 'ascii_frame') {
              framesSeen++
              if (maxFrames !== undefined && Number.isFinite(maxFrames) && framesSeen >= maxFrames) {
                controller.abort()
                break
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          console.error(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }))
          process.exit(1)
        }
      } finally {
        process.off('SIGINT', onSig)
        process.off('SIGTERM', onSig)
      }
      return
    }
    case 'status': {
      const health = await callDaemon(daemonEndpoint, '/health')
      const memory = await callDaemon(daemonEndpoint, '/memory')
      res = { ok: true, endpoint: live.endpoint.file, pid: live.endpoint.pid, health, memory }
      break
    }
    case 'sessions': {
      if (args[0] === 'close') {
        const targetId = args[1] || sessionId
        res = await callDaemon(daemonEndpoint, '/sessions', {
          sessionId: targetId,
          close: true,
          closeTabs: !flags['keep-tabs'],
        })
      } else if (args[0]) {
        res = await callDaemon(daemonEndpoint, '/sessions', {
          sessionId: args[0],
          ...(flags.width !== undefined ? { width: Number(flags.width) } : {}),
        })
      } else {
        res = await callDaemon(daemonEndpoint, '/sessions', {
          ...(flags.width !== undefined ? { width: Number(flags.width) } : {}),
        })
      }
      break
    }
    case 'tabs':
      res = await callDaemon(daemonEndpoint, '/tabs')
      break
    case 'open':
      res = await callDaemon(daemonEndpoint, '/open', { url: args.join(' '), activate: true })
      if (res.ok && flags.ascii) {
        const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
        res = await callDaemon(daemonEndpoint, '/ascii', {
          tabId: res.id,
          width: flags.width ? Number(flags.width) : undefined,
          height: flags.height ? Number(flags.height) : undefined,
          layout: typeof flags.layout === 'string' ? flags.layout : undefined,
          density: typeof flags.density === 'string' ? flags.density : undefined,
          ...(maxTokensOpt !== undefined ? { maxTokens: maxTokensOpt } : {}),
        })
      }
      break
    case 'focus':
      res = await callDaemon(daemonEndpoint, '/activate', { tabId: Number(args[0]) })
      break
    case 'close':
      res = await callDaemon(daemonEndpoint, '/close', { tabId: Number(args[0]) })
      break
    case 'grant':
      res = await callDaemon(daemonEndpoint, '/grant-origin', { origin: args[0], tabId })
      break
    case 'ascii': {
      const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
      res = await callDaemon(daemonEndpoint, '/ascii', {
        tabId,
        width: flags.width ? Number(flags.width) : undefined,
        height: flags.height ? Number(flags.height) : undefined,
        layout: typeof flags.layout === 'string' ? flags.layout : undefined,
        density: typeof flags.density === 'string' ? flags.density : undefined,
        ...(maxTokensOpt !== undefined ? { maxTokens: maxTokensOpt } : {}),
        crop: typeof flags.crop === 'string' ? flags.crop : undefined,
        ref: typeof flags.ref === 'string' ? flags.ref : undefined,
        showMediaSummary: Boolean(flags.media),
        since: Boolean(flags.since),
        settle: Boolean(flags.settle),
        asciiOnly: true,
      })
      break
    }
    case 'markdown':
    case 'md':
      res = await callDaemon(daemonEndpoint, '/markdown', {
        tabId,
        includeFrontmatter: Boolean(flags.frontmatter),
        includeMediaSummary: Boolean(flags.media),
        asciiOnly: Boolean(flags.ascii),
        showRefs: !flags['no-refs'],
        includeUrls: !flags['no-urls'],
        crop: typeof flags.crop === 'string' ? flags.crop : undefined,
        ref: typeof flags.ref === 'string' ? flags.ref : undefined,
        settle: Boolean(flags.settle),
      })
      break
    case 'visual':
      res = await callDaemon(daemonEndpoint, '/tool', {
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
    case 'read': {
      const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: flags.visual ? 'page_read_visual' : flags.ascii ? 'page_read_ascii' : 'page_read',
        args: {
          since: Boolean(flags.since),
          width: flags.width ? Number(flags.width) : undefined,
          height: flags.height ? Number(flags.height) : undefined,
          layout: typeof flags.layout === 'string' ? flags.layout : undefined,
          density: typeof flags.density === 'string' ? flags.density : undefined,
          ...(maxTokensOpt !== undefined ? { maxTokens: maxTokensOpt } : {}),
          crop: typeof flags.crop === 'string' ? flags.crop : undefined,
          ref: typeof flags.ref === 'string' ? flags.ref : undefined,
          showMediaSummary: Boolean(flags.media),
          settle: Boolean(flags.settle),
        },
      })
      break
    }
    case 'find':
      res = await callDaemon(daemonEndpoint, '/tool', { tabId, name: 'page_find', args: { query: args.join(' ') } })
      break
    case 'text':
      res = await callDaemon(daemonEndpoint, '/tool', { tabId, name: 'page_text', args: args[0] ? { ref: args[0] } : {} })
      break
    case 'extract':
      res = await callDaemon(daemonEndpoint, '/extract', {
        tabId,
        sections: typeof flags.sections === 'string' ? flags.sections : undefined,
        maxItems: flags['max-items'] ? Number(flags['max-items']) : undefined,
        includeObjects: !flags['no-objects'],
        asciiOnly: Boolean(flags['ascii-only']),
        externalLinksOnly: Boolean(flags.external),
        internalLinksOnly: Boolean(flags.internal),
        ascii: Boolean(flags.ascii),
        width: flags.width ? Number(flags.width) : undefined,
        settle: Boolean(flags.settle),
      })
      break
    case 'click':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_click',
        args: { ref: args[0], allowSubmit: Boolean(flags['allow-submit'] || flags.submit) },
      })
      break
    case 'fill':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_fill',
        args: { ref: args[0], text: args.slice(1).join(' '), clear: flags.clear !== undefined ? Boolean(flags.clear) : true },
      })
      break
    case 'select':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_select',
        args: { ref: args[0], value: args.slice(1).join(' ') },
      })
      break
    case 'press':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_press',
        args: { key: args[0] ?? 'Enter', ref: typeof flags.ref === 'string' ? flags.ref : undefined },
      })
      break
    case 'scroll':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_scroll',
        args: { direction: args[0] || 'down', amount: args[1] ? Number(args[1]) : 450 },
      })
      break
    case 'wait':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_wait',
        args: {
          ...(args[0] && /^\d+$/.test(args[0]) ? { ms: Number(args[0]) } : {}),
          ...(flags.ms !== undefined ? { ms: Number(flags.ms) } : {}),
          ...(typeof flags.text === 'string' ? { text: flags.text } : {}),
          ...(typeof flags.selector === 'string' ? { selector: flags.selector } : {}),
          ...(typeof flags.url === 'string' ? { url: flags.url } : {}),
          ...(typeof flags.state === 'string' ? { state: flags.state } : {}),
          ...(flags.settle ? { settle: true } : {}),
          ...(flags['network-idle-ms'] !== undefined ? { networkIdleMs: Number(flags['network-idle-ms']) } : {}),
          ...(flags['dom-quiet-ms'] !== undefined ? { domQuietMs: Number(flags['dom-quiet-ms']) } : {}),
          ...(flags.timeout !== undefined ? { timeout: Number(flags.timeout) } : {}),
        },
      })
      break
    case 'back':
    case 'forward':
    case 'reload':
      res = await callDaemon(daemonEndpoint, '/tool', { tabId, name: 'page_history', args: { direction: cmd } })
      break
    case 'console':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_console',
        args: { clear: Boolean(flags.clear), level: flags.level, limit: flags.limit ? Number(flags.limit) : 50 },
      })
      break
    case 'network': {
      const bodyReqId = typeof flags.body === 'string' ? flags.body : undefined
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_network',
        args: bodyReqId
          ? {
              body: bodyReqId,
              ...(flags['max-chars'] !== undefined ? { maxBodyChars: Number(flags['max-chars']) } : {}),
              ...(flags.raw ? { prettyJson: false } : {}),
              ...(flags.reveal ? { revealHeaders: true } : {}),
              ...(flags.binary ? { includeBinary: true } : {}),
            }
          : {
              clear: Boolean(flags.clear),
              failedOnly: Boolean(flags.failed),
              blockedOnly: Boolean(flags.blocked),
              ...(typeof flags.method === 'string' ? { method: flags.method } : {}),
              ...(typeof flags['url-filter'] === 'string' ? { urlFilter: flags['url-filter'] } : {}),
              limit: flags.limit ? Number(flags.limit) : 50,
            },
      })
      break
    }
    case 'eval':
      res = await callDaemon(daemonEndpoint, '/tool', { tabId, name: 'page_eval', args: { expression: args.join(' ') } })
      break
    case 'act':
      res = await callDaemon(daemonEndpoint, '/tool', {
        tabId,
        name: 'page_act',
        args: { steps: JSON.parse(args.join(' ')), allowSubmit: Boolean(flags['allow-submit']) },
      })
      break
    case 'recall':
      res = await callDaemon(daemonEndpoint, '/recall', {
        tabId,
        query: args.join(' '),
        origin: flags.origin,
        limit: flags.limit ? Number(flags.limit) : 10,
        bind: !flags['no-bind'],
        boundOnly: Boolean(flags['bound-only']),
        currentOriginOnly: Boolean(flags['current-origin']),
        ascii: Boolean(flags.ascii),
      })
      break
    case 'forget':
      res = await callDaemon(daemonEndpoint, '/forget', { origin: args[0] })
      break
    case 'emulate':
    case 'viewport': {
      const viewportArg = typeof flags.viewport === 'string' ? flags.viewport : args[0]
      const extraHeaders = rawHeaderArgs.length > 0 ? parseHeaderList(rawHeaderArgs) : undefined
      const removeHeaders = multiFlags['remove-header']
      res = await callDaemon(daemonEndpoint, '/emulation', {
        tabId,
        allTabs: Boolean(flags['all-tabs']),
        ...(viewportArg !== undefined ? { viewport: viewportArg } : {}),
        ...(cliUserAgent !== undefined ? { userAgent: cliUserAgent } : {}),
        ...(typeof flags['accept-language'] === 'string' ? { acceptLanguage: flags['accept-language'] } : {}),
        ...(typeof flags.platform === 'string' ? { platform: flags.platform } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
        ...(flags['replace-headers'] ? { mergeHeaders: false } : {}),
        ...(flags['clear-headers'] ? { clearHeaders: true } : {}),
        ...(removeHeaders && removeHeaders.length > 0 ? { removeHeaders } : {}),
        revealHeaders: Boolean(flags.reveal),
      })
      break
    }
    case 'downloads': {
      const modeArg = parseDownloadMode(flags.mode) ?? parseDownloadMode(args[0])
      res = await callDaemon(daemonEndpoint, '/downloads', {
        blockedOnly: Boolean(flags.blocked),
        clear: Boolean(flags.clear),
        ...(typeof flags.status === 'string' ? { status: flags.status } : {}),
        ...(modeArg ? { mode: modeArg } : {}),
        ...(typeof flags.remove === 'string' ? { removeId: flags.remove } : {}),
        ...(flags['max-bytes'] !== undefined ? { maxBytes: Number(flags['max-bytes']) } : {}),
        ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
      })
      break
    }
    case 'dialogs': {
      const modeArg = parseDialogMode(flags.mode) ?? parseDialogMode(args[0])
      const typeArg = parseDialogType(flags.type) ?? parseDialogType(args[0])
      const nextRaw = typeof flags.next === 'string' ? flags.next.trim().toLowerCase() : undefined
      const queueAccept =
        nextRaw === 'accept' ? true : nextRaw === 'dismiss' ? false : undefined
      res = await callDaemon(daemonEndpoint, '/dialogs', {
        ...(tabId !== undefined ? { tabId } : {}),
        ...(typeArg ? { type: typeArg } : {}),
        ...(modeArg ? { mode: modeArg } : {}),
        ...(typeof flags['default-prompt-text'] === 'string'
          ? { defaultPromptText: flags['default-prompt-text'] }
          : {}),
        ...(flags['dismiss-beforeunload'] ? { acceptBeforeUnload: false } : {}),
        ...(flags['accept-beforeunload'] ? { acceptBeforeUnload: true } : {}),
        ...(queueAccept !== undefined ? { queueAccept } : {}),
        ...(typeof flags['prompt-text'] === 'string' ? { promptText: flags['prompt-text'] } : {}),
        ...(parseDialogType(flags['queue-type']) ? { queueType: parseDialogType(flags['queue-type']) } : {}),
        clearQueue: Boolean(flags['clear-queue']),
        clear: Boolean(flags.clear),
        ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
      })
      break
    }
    case 'audit': {
      res = await callDaemon(daemonEndpoint, '/audit', {
        ...(tabId !== undefined ? { tabId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(typeof flags.kind === 'string' ? { kind: flags.kind } : {}),
        ...(typeof flags.tool === 'string' ? { tool: flags.tool } : {}),
        refusedOnly: Boolean(flags.refused),
        urlChangedOnly: Boolean(flags.transitions),
        failedOnly: Boolean(flags.failed),
        fromDisk: Boolean(flags.disk),
        clear: Boolean(flags.clear),
        truncateFile: Boolean(flags.truncate),
        ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
        ...(flags.width !== undefined ? { width: Number(flags.width) } : {}),
      })
      break
    }
    default:
      console.error(`Unknown command: ${cmd}\nRun "troy-advanced help" for usage.`)
      process.exit(1)
  }

  if (
    !flags.json &&
    (cmd === 'ascii' ||
      cmd === 'visual' ||
      cmd === 'emulate' ||
      cmd === 'viewport' ||
      cmd === 'downloads' ||
      cmd === 'dialogs' ||
      cmd === 'audit' ||
      cmd === 'sessions' ||
      (cmd === 'network' && Boolean(flags.body)) ||
      flags.ascii) &&
    typeof res.ascii === 'string'
  ) {
    console.log(res.ascii)
  } else if (!flags.json && (cmd === 'markdown' || cmd === 'md') && typeof res.markdown === 'string') {
    console.log(res.markdown)
  } else {
    console.log(JSON.stringify(res, null, 2))
  }
  if (res.ok === false) process.exit(1)
}
