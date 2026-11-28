// CLI entrypoint for `troy-advanced`.

import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
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
  PolicyProfileName,
  ProxyOptions,
  SecretRedactionOptions,
  SsrfProtectionOptions,
  TrackerBlockingOptions,
  TrackerBlockMode,
  UntrustedMarkersOptions,
} from './types.js'
import {
  POLICY_PROFILE_NAMES,
  PolicyProfileGuard,
  createPolicyTemplate,
  defaultPolicyFilePath,
  formatPolicyAscii,
  parsePolicyProfileName,
  resolvePolicyProfile,
  validatePolicyConfig,
  writePolicyFile,
} from './agent/policy-profile.js'
import { parseSsrfAllowHosts } from './agent/ssrf.js'
import { parseUntrustedMarkersStyle } from './agent/untrusted-markers.js'
import { parseSecretRedactionMode } from './agent/secret-redactor.js'
import { BrowserManager } from './engine/manager.js'
import { parseProxyUrl } from './engine/proxy.js'
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
import {
  createProfile,
  defaultProfileDir as getDefaultProfileDir,
  deleteProfile,
  exportProfile,
  formatProfileDetailAscii,
  formatProfilesAscii,
  getProfile,
  importProfile,
  listProfiles,
  resolveProfileFlag,
} from './cloud/profiles.js'
import { runDaemonForeground, startDaemonDetached, stopDaemon } from './cloud/daemon.js'
import {
  defaultDaemonConfigPath,
  formatOriginRulesAscii,
  parseOriginFlagValues,
  persistDaemonOriginRules,
  readDaemonConfig,
} from './cloud/daemon-config.js'
import {
  DEFAULT_LOG_TAIL_LINES,
  clearLogFiles,
  defaultDaemonLogPath,
  followLogFile,
  readLogTail,
  rotateLogFile,
} from './cloud/daemon-logs.js'
import { formatDoctorAscii, runDoctorAsync } from './cloud/doctor.js'
import {
  buildEc2TunnelPlan,
  discoverRemoteEndpoint,
  establishEc2Tunnel,
  formatEc2TunnelAscii,
  writeTunneledEndpointFile,
  type StrictHostKeyMode,
} from './cloud/ec2-tunnel.js'
import {
  renderDockerComposeYaml,
  validateDockerComposeFile,
} from './cloud/docker-compose.js'
import { parseMaxRssMb } from './cloud/memory-watchdog.js'
import {
  formatBenchAscii,
  parseBenchFloat,
  parseBenchInt,
  runBench,
} from './cloud/bench.js'
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
import {
  COMPLETION_SHELLS,
  formatInstallHint,
  generateShellCompletion,
  parseCompletionShell,
} from './completions.js'
import {
  CLI_EXIT_CODES,
  CliExitError,
  CliRuntime,
  isDaemonOfflineError,
  isTimeoutError,
  resolveCliRuntime,
} from './cli-runtime.js'

const USAGE = `troy-advanced — terminal-native, EC2-ready, ASCII-rendered AI browser

Usage: troy-advanced <command> [args] [flags]

Daemon & Modes:
  daemon start [--engine auto|chromium|lite] [--cdp-url ws://...|http://...] [--proxy http://...|socks5://...] [--proxy-bypass <hosts>] [--no-env-proxy] [--compat-troy] [--policy strict|standard|permissive] [--policy-file <path>] [--allow-origin <origin>] [--deny-origin <origin>] [--daemon-config <path>] [--log-file <path>] [--log-max-bytes N] [--log-max-files N] [--max-rss-mb N] [--watchdog-interval-ms N] [--watchdog-idle-ttl-ms N] [--public-metrics] [--no-health-probe] [--readonly] [--block-private-net] [--ssrf-allow-host <host>] [--untrusted-markers] [--untrusted-style banner|xml] [--redact-secrets] [--redact-mode tag|partial] [--port N] [--url U]
  daemon run   (foreground daemon for systemd / Docker)
  daemon stop | status
  daemon logs  [--tail N | -n N] [--follow | -f] [--all] [--rotate] [--clear] [--log-file <path>] [--log-max-files N] [--json]
                                                         View, tail, follow, rotate, or clear daemon logs
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
  doctor       [--json] [--no-imds] [--imds-timeout <ms>] [--imds-endpoint <url>]
                                                         EC2 (IMDSv2) / Linux / Chrome environment check
  bench        [--engine auto|chromium|lite] [--cdp-url ws://...|http://...] [--url <url>] [--iterations N] [--warmup N] [--budget-ms N] [--startup-runs N] [--snapshot-iterations N] [--snapshot-warmup N] [--screenshot] [--skip-ascii] [--skip-startup] [--skip-snapshot] [--out <file>] [--json]
                                                         Measure engine startup latency, ASCII render throughput, and CDP snapshot latency
  profile      <list|show|create|delete|export|import> [args] [--profiles-dir <dir>] [--json]
                                                         Manage isolated multi-profile directories (list, create/clone, delete, export/import)
  ec2 setup                                              Print EC2 Docker Compose, systemd & SSH forwarding guide
  ec2 compose  [--port N] [--engine auto|chromium|lite] [--policy strict|standard|permissive] [--shm-size 1gb] [--volume <name>] [--bind-dir <dir>] [--memory <limit>] [--cpus N] [--readonly] [--public-metrics] [--write <file>] [--validate <file>] [--json]
                                                         Generate or validate a hardened EC2 docker-compose.yml manifest
  ec2 tunnel   <user@host> [--local-port N] [--remote-port N] [--cdp] [--cdp-only] [--cdp-port N] [--remote-cdp-port N] [-i <key>] [--ssh-port N] [--jump <bastion>] [--discover] [--write-endpoint <file>] [--connect] [--background] [--json]
                                                         Print or establish secure 127.0.0.1 SSH loopback forwarding to an EC2 host
  completions  <bash|zsh|fish> [--bin <name>] [--out <file>] [--install-hint] [--json]
                                                         Generate shell completion script for bash, zsh, or fish

Client Commands (talk to running daemon, or use --oneshot):
  status                                  Daemon health + memory stats
  health [--json]                         Run HTTP health-check probes (/healthz, /readyz, /health)
  metrics [--prometheus|--json|--ascii]   Fetch Prometheus /metrics or ASCII metrics dashboard (tabs, requests, RSS, uptime, tool latency)
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
  find <query> [--role button|input|link]  Smart fuzzy+synonym+ARIA find as eN refs
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
  policy [show|init|validate] [--policy strict|standard|permissive] [--file <path>] [--force] [--json]
                                          Inspect active policy profile, generate policy.json template, or validate policy.json
  origins [list|allow <origin>|deny <origin>|unallow <origin>|undeny <origin>|clear] [--daemon-config <path>] [--json]
                                          Inspect or update persisted origin allowlist / denylist rules in daemon.json
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
  --tab <id>  --session <id>  --endpoint <file>  --engine <auto|chromium|lite>  --cdp-url <ws://...|http://...>  --proxy <http://...|socks5://...>  --proxy-bypass <hosts>  --no-env-proxy  --policy <strict|standard|permissive>  --policy-file <path>  --allow-origin <origin>  --deny-origin <origin>  --daemon-config <path>  --readonly  --viewport <preset|WxH>  --user-agent <ua>  --header "K: V"  --untrusted-markers  --untrusted-style <banner|xml>  --redact-secrets  --redact-mode <tag|partial>  --json  --ascii  --width <n>  --quiet (-q)  --verbose (-v)  --timeout <ms|5s|1m>

Exit Codes:
  0  OK
  1  General error / timeout / invalid arguments
  2  Policy refusal (readonly, SSRF, origin boundary, sensitive field, submit guard)
  3  Daemon offline / unreachable
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
  '--proxy',
  '--proxy-bypass',
  '--profile',
  '--policy',
  '--policy-file',
  '--allow-origin',
  '--deny-origin',
  '--daemon-config',
  '--url',
  '--width',
  '--height',
  '--layout',
  '--density',
  '--max-tokens',
  '--untrusted-style',
  '--redact-mode',
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
  '--ssrf-allow-host',
  '--imds-timeout',
  '--imds-endpoint',
  '--tail',
  '--log-file',
  '--log-max-bytes',
  '--log-max-files',
  '--max-rss-mb',
  '--watchdog-interval-ms',
  '--watchdog-idle-ttl-ms',
  '--profiles-dir',
  '--from',
  '--description',
  '--tag',
  '--name',
  '--local-port',
  '--remote-port',
  '--local-cdp-port',
  '--ssh-port',
  '--identity',
  '--jump',
  '--keepalive',
  '--keepalive-count',
  '--strict-host-key',
  '--remote-endpoint',
  '--write-endpoint',
  '--ssh-bin',
  '--shm-size',
  '--volume',
  '--bind-dir',
  '--memory',
  '--cpus',
  '--write',
  '--validate',
  '--image',
  '--tz',
  '--iterations',
  '--warmup',
  '--budget-ms',
  '--startup-runs',
  '--snapshot-iterations',
  '--snapshot-warmup',
  '--chrome-bin',
  '--bin',
])

const REPEATABLE_FLAGS = new Set([
  '--header',
  '--remove-header',
  '--var',
  '--ssrf-allow-host',
  '--allow-origin',
  '--deny-origin',
  '--proxy-bypass',
  '--tag',
  '--bin',
])

async function readStdinBuffer(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  return Buffer.concat(chunks)
}

async function readStdinUtf8(): Promise<string> {
  return (await readStdinBuffer()).toString('utf8')
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
    if (tok === '-i' && i + 1 < argv.length) {
      flags.identity = argv[++i]!
      continue
    }
    if (tok === '-f') {
      flags.follow = true
      continue
    }
    if (tok === '-q') {
      flags.quiet = true
      continue
    }
    if (tok === '-v') {
      flags.verbose = true
      continue
    }
    if (tok === '-n' && i + 1 < argv.length) {
      flags.tail = argv[++i]!
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

const daemonHttpStatus = new WeakMap<object, number>()

async function callDaemon(
  endpoint: { agentPort: number; agentToken: string; sessionId?: string },
  route: string,
  body: Record<string, unknown> = {},
  runtime?: CliRuntime,
  timeoutOverrideMs?: number,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-troy-agent': endpoint.agentToken,
  }
  if (endpoint.sessionId) {
    headers[SESSION_HEADER] = endpoint.sessionId
  }
  const url = `http://127.0.0.1:${endpoint.agentPort}${route}`
  const timeoutCtl = runtime?.createTimeoutSignal(timeoutOverrideMs)
  const startedAt = Date.now()
  runtime?.debug(`POST ${route}`, {
    port: endpoint.agentPort,
    session: endpoint.sessionId,
    timeoutMs: timeoutCtl?.timeoutMs,
  })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(timeoutCtl ? { signal: timeoutCtl.signal } : {}),
    })
    const payload = (await res.json()) as Record<string, unknown>
    if (payload && typeof payload === 'object') {
      daemonHttpStatus.set(payload, res.status)
    }
    runtime?.debug(`POST ${route} -> ${res.status}`, {
      ok: payload.ok !== false,
      elapsedMs: Date.now() - startedAt,
    })
    return payload
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    if (err instanceof CliExitError) throw err
    if (timeoutCtl?.signal.aborted || isTimeoutError(err)) {
      const ms = timeoutCtl?.timeoutMs ?? runtime?.effectiveTimeoutMs() ?? 30_000
      runtime?.debug(`POST ${route} timed out`, { elapsedMs, timeoutMs: ms })
      throw new CliExitError(`Daemon request ${route} timed out after ${ms}ms`, {
        exitCode: CLI_EXIT_CODES.ERROR,
        code: 'timeout',
        payload: { ok: false, code: 'timeout', error: `Daemon request ${route} timed out after ${ms}ms`, timeoutMs: ms },
        cause: err,
      })
    }
    if (isDaemonOfflineError(err) || (err instanceof TypeError && /fetch failed/i.test(err.message))) {
      runtime?.debug(`POST ${route} daemon unreachable`, { elapsedMs, port: endpoint.agentPort })
      throw new CliExitError(
        `Unable to reach troy-advanced daemon on 127.0.0.1:${endpoint.agentPort}. Start it with: troy-advanced daemon start`,
        {
          exitCode: CLI_EXIT_CODES.DAEMON_OFFLINE,
          code: 'daemon_offline',
          payload: {
            ok: false,
            code: 'daemon_offline',
            error: `Unable to reach troy-advanced daemon on 127.0.0.1:${endpoint.agentPort}. Start it with: troy-advanced daemon start`,
          },
          cause: err,
        },
      )
    }
    throw err
  } finally {
    timeoutCtl?.clear()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags, multiFlags } = parseArgv(argv)
  const cmd = positional[0]

  const runtimeRes = resolveCliRuntime(flags)
  if (!runtimeRes.ok) {
    if (!flags.quiet) {
      console.error(JSON.stringify({ ok: false, code: 'invalid_argument', error: runtimeRes.error }, null, 2))
    }
    process.exit(CLI_EXIT_CODES.ERROR)
  }
  const cli = runtimeRes.runtime

  if (!cmd || cmd === 'help' || flags.help) {
    cli.out(USAGE)
    return
  }

  cli.debug('cli invoke', {
    cmd,
    verbosity: cli.verbosity,
    timeoutMs: cli.timeoutMs,
  })

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
  const envBlockPrivateNet =
    process.env.TROY_BLOCK_PRIVATE_NET === '1' ||
    process.env.TROY_BLOCK_PRIVATE_NET?.toLowerCase() === 'true'
  const blockPrivateNetFlag = Boolean(flags['block-private-net']) || envBlockPrivateNet
  const ssrfAllowHosts = parseSsrfAllowHosts(multiFlags['ssrf-allow-host'] ?? [])
  const ssrfOpts: SsrfProtectionOptions | undefined = blockPrivateNetFlag
    ? {
        enabled: true,
        ...(ssrfAllowHosts.length > 0 ? { allowHosts: ssrfAllowHosts } : {}),
      }
    : undefined
  const envUntrustedMarkers =
    process.env.TROY_UNTRUSTED_MARKERS === '1' ||
    process.env.TROY_UNTRUSTED_MARKERS?.toLowerCase() === 'true'
  const untrustedMarkersFlag = Boolean(flags['untrusted-markers']) || envUntrustedMarkers
  const untrustedStyleFlag = parseUntrustedMarkersStyle(flags['untrusted-style'] ?? process.env.TROY_UNTRUSTED_STYLE)
  const untrustedMarkersOpts: UntrustedMarkersOptions | undefined = untrustedMarkersFlag
    ? {
        enabled: true,
        ...(untrustedStyleFlag ? { style: untrustedStyleFlag } : {}),
      }
    : undefined
  const envRedactSecrets =
    process.env.TROY_REDACT_SECRETS === '1' ||
    process.env.TROY_REDACT_SECRETS?.toLowerCase() === 'true'
  const redactSecretsFlag = Boolean(flags['redact-secrets']) || envRedactSecrets
  const redactModeFlag = parseSecretRedactionMode(flags['redact-mode'] ?? process.env.TROY_REDACT_MODE)
  const redactSecretsOpts: SecretRedactionOptions | undefined = redactSecretsFlag
    ? {
        enabled: true,
        ...(redactModeFlag ? { mode: redactModeFlag } : {}),
      }
    : undefined
  const envReadonly =
    process.env.TROY_READONLY === '1' ||
    process.env.TROY_READONLY?.toLowerCase() === 'true'
  const readonlyFlag = Boolean(flags.readonly) || envReadonly
  const rawPolicyFlag =
    typeof flags.policy === 'string' && flags.policy.trim()
      ? flags.policy.trim()
      : process.env.TROY_POLICY_PROFILE?.trim() || undefined
  let policyProfileFlag: PolicyProfileName | undefined
  if (rawPolicyFlag) {
    const parsedPolicy = parsePolicyProfileName(rawPolicyFlag)
    if (!parsedPolicy) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: `Invalid --policy "${rawPolicyFlag}". Valid profiles: ${POLICY_PROFILE_NAMES.join(', ')}`,
          },
          null,
          2,
        ),
      )
      process.exit(1)
    }
    policyProfileFlag = parsedPolicy
  }
  const policyFileFlag =
    typeof flags['policy-file'] === 'string' && flags['policy-file'].trim()
      ? path.resolve(flags['policy-file'].trim())
      : process.env.TROY_POLICY_FILE?.trim()
        ? path.resolve(process.env.TROY_POLICY_FILE.trim())
        : undefined
  const profilesDirFlag =
    typeof flags['profiles-dir'] === 'string' && flags['profiles-dir'].trim()
      ? path.resolve(flags['profiles-dir'].trim())
      : undefined
  const resolvedProfileFlag =
    typeof flags.profile === 'string' && flags.profile.trim()
      ? resolveProfileFlag(flags.profile, { profilesDir: profilesDirFlag })
      : undefined
  const daemonConfigFileFlag =
    typeof flags['daemon-config'] === 'string' && flags['daemon-config'].trim()
      ? path.resolve(flags['daemon-config'].trim())
      : process.env.TROY_ADVANCED_DAEMON_CONFIG?.trim()
        ? path.resolve(process.env.TROY_ADVANCED_DAEMON_CONFIG.trim())
        : undefined
  const envAllowOrigins = process.env.TROY_ADVANCED_ALLOW_ORIGINS || process.env.TROY_ALLOW_ORIGINS || ''
  const envDenyOrigins = process.env.TROY_ADVANCED_DENY_ORIGINS || process.env.TROY_DENY_ORIGINS || ''
  const parsedAllowOrigins = parseOriginFlagValues([
    ...(envAllowOrigins ? [envAllowOrigins] : []),
    ...(multiFlags['allow-origin'] ?? []),
  ])
  if (parsedAllowOrigins.invalid.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: `Invalid --allow-origin value(s): ${parsedAllowOrigins.invalid.join(', ')}. Expected http(s) origin or wildcard subdomain (e.g. https://example.com or https://*.example.com).`,
        },
        null,
        2,
      ),
    )
    process.exit(1)
  }
  const parsedDenyOrigins = parseOriginFlagValues([
    ...(envDenyOrigins ? [envDenyOrigins] : []),
    ...(multiFlags['deny-origin'] ?? []),
  ])
  if (parsedDenyOrigins.invalid.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: `Invalid --deny-origin value(s): ${parsedDenyOrigins.invalid.join(', ')}. Expected http(s) origin or wildcard subdomain (e.g. https://evil.com or https://*.evil.com).`,
        },
        null,
        2,
      ),
    )
    process.exit(1)
  }
  const allowOriginsFlag = parsedAllowOrigins.valid.length > 0 ? parsedAllowOrigins.valid : undefined
  const denyOriginsFlag = parsedDenyOrigins.valid.length > 0 ? parsedDenyOrigins.valid : undefined
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

  const rawProxyFlag = typeof flags.proxy === 'string' && flags.proxy.trim() ? flags.proxy.trim() : undefined
  if (rawProxyFlag) {
    // Fail fast on malformed proxy URL before launching daemon or browser
    parseProxyUrl(rawProxyFlag)
  }
  const rawProxyBypass = multiFlags['proxy-bypass'] ?? []
  const noEnvProxyFlag = Boolean(flags['no-env-proxy'])
  const proxyFlag: ProxyOptions | undefined =
    rawProxyFlag || rawProxyBypass.length > 0 || noEnvProxyFlag
      ? {
          ...(rawProxyFlag ? { server: rawProxyFlag } : {}),
          ...(rawProxyBypass.length > 0 ? { bypass: rawProxyBypass } : {}),
          ...(noEnvProxyFlag ? { useEnv: false } : {}),
        }
      : undefined

  if (cmd === 'completions' || cmd === 'completion') {
    const rawShell = typeof positional[1] === 'string' ? positional[1] : ''
    if (flags['install-hint']) {
      if (!rawShell) {
        console.log(formatInstallHint())
        return
      }
      const parsedShell = parseCompletionShell(rawShell)
      if (!parsedShell) {
        console.error(
          `Invalid shell "${rawShell}": expected one of ${COMPLETION_SHELLS.join(', ')}`,
        )
        process.exit(1)
      }
      console.log(formatInstallHint(parsedShell))
      return
    }

    if (!rawShell) {
      console.error(
        `Usage: troy-advanced completions <${COMPLETION_SHELLS.join('|')}> [--bin <name>] [--out <file>] [--install-hint] [--json]`,
      )
      process.exit(1)
    }

    const shell = parseCompletionShell(rawShell)
    if (!shell) {
      console.error(
        `Invalid shell "${rawShell}": expected one of ${COMPLETION_SHELLS.join(', ')}`,
      )
      process.exit(1)
    }

    const binNames =
      multiFlags.bin && multiFlags.bin.length > 0
        ? multiFlags.bin
        : typeof flags.bin === 'string' && flags.bin.trim()
          ? [flags.bin.trim()]
          : undefined

    try {
      const script = generateShellCompletion(shell, {
        ...(binNames ? { binNames } : {}),
        includeHeader: !flags['no-header'],
      })

      if (typeof flags.out === 'string' && flags.out.trim()) {
        const outPath = path.resolve(flags.out.trim())
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, script, 'utf8')
        if (flags.json) {
          console.log(
            JSON.stringify({ ok: true, shell, out: outPath, bytes: Buffer.byteLength(script, 'utf8') }, null, 2),
          )
        } else {
          console.log(`Wrote ${shell} completions to ${outPath}`)
        }
      } else if (flags.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              shell,
              binNames: binNames ?? ['troy-advanced', 'troya'],
              script,
            },
            null,
            2,
          ),
        )
      } else {
        process.stdout.write(script)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    return
  }

  if (cmd === 'doctor') {
    const imdsTimeoutRaw =
      typeof flags['imds-timeout'] === 'string' && flags['imds-timeout'].trim()
        ? Number(flags['imds-timeout'].trim())
        : undefined
    const report = await runDoctorAsync({
      imds: {
        skip: Boolean(flags['no-imds']),
        ...(typeof flags['imds-endpoint'] === 'string' && flags['imds-endpoint'].trim()
          ? { baseUrl: flags['imds-endpoint'].trim() }
          : {}),
        ...(imdsTimeoutRaw !== undefined && Number.isFinite(imdsTimeoutRaw)
          ? { timeoutMs: imdsTimeoutRaw }
          : {}),
      },
    })
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatDoctorAscii(report))
    return
  }

  if (cmd === 'bench') {
    const rawEngine = typeof flags.engine === 'string' ? flags.engine.trim().toLowerCase() : 'auto'
    if (rawEngine !== 'auto' && rawEngine !== 'chromium' && rawEngine !== 'lite') {
      console.error(`Invalid --engine "${rawEngine}": expected auto, chromium, or lite`)
      process.exit(1)
    }
    const benchEngine: EngineKind = rawEngine
    const benchUrl =
      typeof flags.url === 'string' && flags.url.trim()
        ? flags.url.trim()
        : typeof positional[1] === 'string' && positional[1].trim()
          ? positional[1].trim()
          : undefined
    const report = await runBench({
      engine: benchEngine,
      cdpUrl: typeof flags['cdp-url'] === 'string' && flags['cdp-url'].trim() ? flags['cdp-url'].trim() : undefined,
      chromeBin:
        typeof flags['chrome-bin'] === 'string' && flags['chrome-bin'].trim() ? flags['chrome-bin'].trim() : undefined,
      proxy: proxyFlag,
      url: benchUrl,
      asciiIterations: parseBenchInt(flags.iterations, '--iterations', { min: 1, max: 5000, fallback: 30 }),
      asciiWarmup: parseBenchInt(flags.warmup, '--warmup', { min: 0, max: 500, fallback: 5 }),
      asciiBudgetMs: parseBenchFloat(flags['budget-ms'], '--budget-ms', { min: 0.1, max: 1000, fallback: 5.0 }),
      startupRuns: parseBenchInt(flags['startup-runs'], '--startup-runs', { min: 1, max: 10, fallback: 1 }),
      snapshotIterations: parseBenchInt(flags['snapshot-iterations'], '--snapshot-iterations', {
        min: 1,
        max: 200,
        fallback: 5,
      }),
      snapshotWarmup: parseBenchInt(flags['snapshot-warmup'], '--snapshot-warmup', {
        min: 0,
        max: 20,
        fallback: 1,
      }),
      includeScreenshot: Boolean(flags.screenshot),
      skipAscii: Boolean(flags['skip-ascii']),
      skipStartup: Boolean(flags['skip-startup']),
      skipSnapshot: Boolean(flags['skip-snapshot']),
    })
    const formatted = flags.json ? JSON.stringify(report, null, 2) : formatBenchAscii(report)
    if (typeof flags.out === 'string' && flags.out.trim()) {
      const outPath = path.resolve(flags.out.trim())
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, `${formatted}\n`, 'utf8')
    }
    console.log(formatted)
    if (!report.ok) {
      process.exit(1)
    }
    return
  }

  if (cmd === 'profile') {
    const sub = (positional[1] || 'list').toLowerCase()
    const profileOpts = { profilesDir: profilesDirFlag }

    if (sub === 'list' || sub === 'ls') {
      const profiles = listProfiles(profileOpts)
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, count: profiles.length, profiles }, null, 2))
      } else {
        console.log(
          formatProfilesAscii(profiles, {
            width: flags.width !== undefined ? Number(flags.width) : undefined,
          }),
        )
      }
      return
    }

    if (sub === 'show' || sub === 'info') {
      const name = positional[2]
      if (!name) {
        console.error('Usage: troy-advanced profile show <name> [--profiles-dir <dir>] [--json]')
        process.exit(1)
      }
      const profile = getProfile(name, profileOpts)
      if (!profile) {
        const payload = { ok: false, name, error: `Profile "${name}" not found` }
        console.error(flags.json ? JSON.stringify(payload, null, 2) : payload.error)
        process.exit(1)
      }
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, profile }, null, 2))
      } else {
        console.log(formatProfileDetailAscii(profile))
      }
      return
    }

    if (sub === 'create') {
      const name = positional[2]
      if (!name) {
        console.error(
          'Usage: troy-advanced profile create <name> [--from <src>] [--description <text>] [--engine auto|chromium|lite] [--policy strict|standard|permissive] [--tag <tag>] [--profiles-dir <dir>] [--json]',
        )
        process.exit(1)
      }
      const rawEngine = typeof flags.engine === 'string' ? flags.engine : undefined
      const profileEngine: EngineKind | undefined =
        rawEngine === 'auto' || rawEngine === 'chromium' || rawEngine === 'lite' ? rawEngine : undefined
      const res = createProfile(name, {
        ...profileOpts,
        description: typeof flags.description === 'string' ? flags.description : undefined,
        engine: profileEngine,
        policy: policyProfileFlag,
        tags: multiFlags.tag,
        from: typeof flags.from === 'string' ? flags.from : undefined,
      })
      if (!res.ok || !res.profile) {
        console.error(flags.json ? JSON.stringify(res, null, 2) : res.error || 'Failed to create profile')
        process.exit(1)
      }
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        const cloneNote = res.clonedFrom ? ` (cloned from "${res.clonedFrom}", ${res.copiedFiles ?? 0} files)` : ''
        console.log(`Created profile "${res.profile.name}"${cloneNote} at ${res.profile.dir}`)
        console.log(formatProfileDetailAscii(res.profile))
      }
      return
    }

    if (sub === 'delete' || sub === 'rm' || sub === 'remove') {
      const name = positional[2]
      if (!name) {
        console.error('Usage: troy-advanced profile delete <name> [--force] [--profiles-dir <dir>] [--json]')
        process.exit(1)
      }
      const res = deleteProfile(name, {
        ...profileOpts,
        force: Boolean(flags.force),
      })
      if (!res.ok) {
        console.error(flags.json ? JSON.stringify(res, null, 2) : res.error || 'Failed to delete profile')
        process.exit(1)
      }
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(
          `Deleted profile "${res.name}" (${res.removedFiles ?? 0} files, ${res.freedBytes ?? 0} bytes freed)`,
        )
      }
      return
    }

    if (sub === 'export') {
      const name = positional[2]
      if (!name) {
        console.error(
          'Usage: troy-advanced profile export <name> [file|-] [--encrypt] [--passphrase <pass>] [--gzip] [--include-cache] [--exclude-chrome-data] [--exclude-audit] [--profiles-dir <dir>] [--json]',
        )
        process.exit(1)
      }
      const outArg = typeof flags.out === 'string' ? flags.out : positional[3]
      const passphrase =
        typeof flags.passphrase === 'string'
          ? flags.passphrase
          : flags.encrypt
            ? process.env.TROY_PROFILE_PASSPHRASE
            : undefined
      if (flags.encrypt && !passphrase) {
        const errPayload = {
          ok: false,
          error: '--encrypt requires --passphrase <pass> or TROY_PROFILE_PASSPHRASE env var',
        }
        console.error(flags.json ? JSON.stringify(errPayload, null, 2) : errPayload.error)
        process.exit(1)
      }

      const toStdout = !outArg || outArg === '-'
      const res = exportProfile(name, {
        ...profileOpts,
        outFile: toStdout ? undefined : outArg,
        encrypt: Boolean(flags.encrypt || passphrase),
        passphrase,
        gzip: flags.gzip ? true : undefined,
        includeCache: Boolean(flags['include-cache']),
        excludeChromeData: Boolean(flags['exclude-chrome-data']),
        excludeAudit: Boolean(flags['exclude-audit']),
      })
      if (!res.ok || !res.data) {
        console.error(flags.json ? JSON.stringify(res, null, 2) : res.error || 'Failed to export profile')
        process.exit(1)
      }
      if (toStdout) {
        process.stdout.write(res.data)
      } else if (flags.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              name: res.name,
              outFile: res.outFile,
              encrypted: res.encrypted,
              compressed: res.compressed,
              totalFiles: res.totalFiles,
              totalBytes: res.totalBytes,
              outputBytes: res.outputBytes,
              manifestSha256: res.manifestSha256,
            },
            null,
            2,
          ),
        )
      } else {
        console.log(
          `Exported profile "${res.name}" to ${res.outFile} (${res.totalFiles} files, ${res.outputBytes} bytes, encrypted=${res.encrypted}, compressed=${res.compressed}, sha256=${res.manifestSha256?.slice(0, 12)})`,
        )
      }
      return
    }

    if (sub === 'import') {
      const inArg = typeof flags.in === 'string' ? flags.in : positional[2]
      if (!inArg) {
        console.error(
          'Usage: troy-advanced profile import <file|-> [--name <target>] [--passphrase <pass>] [--overwrite] [--force] [--profiles-dir <dir>] [--json]',
        )
        process.exit(1)
      }
      const passphrase =
        typeof flags.passphrase === 'string' ? flags.passphrase : process.env.TROY_PROFILE_PASSPHRASE
      const source: string | Buffer = inArg === '-' ? await readStdinBuffer() : inArg
      const res = importProfile(source, {
        ...profileOpts,
        name: typeof flags.name === 'string' ? flags.name : undefined,
        passphrase,
        overwrite: Boolean(flags.overwrite || flags.force),
        force: Boolean(flags.force),
      })
      if (!res.ok || !res.profile) {
        console.error(flags.json ? JSON.stringify(res, null, 2) : res.error || 'Failed to import profile')
        process.exit(1)
      }
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(
          `Imported profile "${res.profile.name}" (${res.importedFiles ?? 0} files, ${res.importedBytes ?? 0} bytes, encrypted=${Boolean(res.encrypted)}, overwritten=${Boolean(res.overwritten)})`,
        )
        console.log(formatProfileDetailAscii(res.profile))
      }
      return
    }

    console.error(
      'Usage: troy-advanced profile <list|show|create|delete|export|import> [args] [--profiles-dir <dir>] [--json]',
    )
    process.exit(1)
  }

  if (cmd === 'policy') {
    const sub = positional[1] ?? 'show'
    const defaultProfileDir = resolvedProfileFlag ?? getDefaultProfileDir()
    const explicitFile =
      typeof flags.file === 'string' && flags.file.trim()
        ? path.resolve(flags.file.trim())
        : policyFileFlag

    if (sub === 'init') {
      const targetPath = explicitFile ?? defaultPolicyFilePath(defaultProfileDir)
      const targetProfile: PolicyProfileName = policyProfileFlag ?? 'standard'
      if (fs.existsSync(targetPath) && !flags.force) {
        console.error(
          JSON.stringify(
            { ok: false, error: `Policy file already exists at "${targetPath}". Pass --force to overwrite.` },
            null,
            2,
          ),
        )
        process.exit(1)
      }
      const template = createPolicyTemplate(targetProfile)
      const resolved = writePolicyFile(targetPath, template)
      const guard = new PolicyProfileGuard(resolved)
      const stats = guard.getStats()
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, path: targetPath, policy: resolved, stats }, null, 2))
      } else {
        console.log(`Wrote ${targetProfile} policy template to ${targetPath} (0600)`)
        console.log(
          formatPolicyAscii(stats, {
            width: flags.width !== undefined ? Number(flags.width) : undefined,
          }),
        )
      }
      return
    }

    if (sub === 'validate') {
      const targetPath = explicitFile ?? defaultPolicyFilePath(defaultProfileDir)
      let rawText: string
      try {
        rawText = fs.readFileSync(targetPath, 'utf8')
      } catch (err) {
        console.error(
          JSON.stringify({ ok: false, path: targetPath, error: `Failed to read "${targetPath}": ${(err as Error).message}` }, null, 2),
        )
        process.exit(1)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch (err) {
        console.error(
          JSON.stringify({ ok: false, path: targetPath, error: `Invalid JSON in "${targetPath}": ${(err as Error).message}` }, null, 2),
        )
        process.exit(1)
      }
      const validation = validatePolicyConfig(parsed, {
        sourceFile: targetPath,
        overrideProfile: policyProfileFlag,
      })
      if (!validation.ok || !validation.resolved) {
        console.error(
          JSON.stringify({ ok: false, path: targetPath, errors: validation.errors, warnings: validation.warnings }, null, 2),
        )
        process.exit(1)
      }
      const stats = new PolicyProfileGuard(validation.resolved).getStats()
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, path: targetPath, policy: validation.resolved, stats, warnings: validation.warnings }, null, 2))
      } else {
        console.log(`Valid policy file: ${targetPath}`)
        console.log(
          formatPolicyAscii(stats, {
            width: flags.width !== undefined ? Number(flags.width) : undefined,
          }),
        )
      }
      return
    }

    if (sub === 'show') {
      const live = !explicitFile && !policyProfileFlag && !flags.oneshot ? readLiveEndpoint(endpointFlag) : null
      if (live) {
        const res = await callDaemon(
          live.endpoint,
          '/policy',
          {
            width: flags.width !== undefined ? Number(flags.width) : undefined,
          },
          cli,
        )
        if (flags.json) {
          cli.json(res)
        } else if (typeof res.ascii === 'string') {
          cli.out(res.ascii)
        } else {
          cli.json(res)
        }
        const exitCode = cli.classifyResponse(res, daemonHttpStatus.get(res))
        if (exitCode !== CLI_EXIT_CODES.OK) process.exit(exitCode)
        return
      }
      const resolved = resolvePolicyProfile(policyProfileFlag, {
        policyFile: explicitFile,
        profileDir: defaultProfileDir,
      })
      const stats = new PolicyProfileGuard(resolved).getStats()
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, profile: stats.profile, policy: resolved, stats }, null, 2))
      } else {
        console.log(
          formatPolicyAscii(stats, {
            width: flags.width !== undefined ? Number(flags.width) : undefined,
          }),
        )
      }
      return
    }

    console.error('Usage: troy-advanced policy [show|init|validate] [--policy strict|standard|permissive] [--file <path>] [--force] [--json]')
    process.exit(1)
  }

  if (cmd === 'origins') {
    const sub = (positional[1] || 'list').toLowerCase()
    const targetArg = positional[2]
    const validSubs = new Set(['list', 'allow', 'deny', 'unallow', 'undeny', 'clear'])
    if (!validSubs.has(sub)) {
      console.error(
        'Usage: troy-advanced origins [list|allow <origin>|deny <origin>|unallow <origin>|undeny <origin>|clear] [--daemon-config <path>] [--json]',
      )
      process.exit(1)
    }

    const explicitConfig =
      daemonConfigFileFlag ??
      (typeof flags.file === 'string' && flags.file.trim() ? path.resolve(flags.file.trim()) : undefined)
    const live = !explicitConfig && !flags.oneshot ? readLiveEndpoint(endpointFlag) : null
    if (live) {
      const res = await callDaemon(
        live.endpoint,
        '/origins',
        {
          action: sub,
          ...(targetArg !== undefined ? { origin: targetArg } : {}),
          width: flags.width !== undefined ? Number(flags.width) : undefined,
        },
        cli,
      )
      if (flags.json || !res.ok || typeof res.ascii !== 'string') {
        cli.json(res)
      } else {
        cli.out(res.ascii)
      }
      const exitCode = cli.classifyResponse(res, daemonHttpStatus.get(res))
      if (exitCode !== CLI_EXIT_CODES.OK) process.exit(exitCode)
      return
    }

    const configFile = defaultDaemonConfigPath({
      configFile: explicitConfig,
      profileDir: resolvedProfileFlag,
      endpointFile: endpointFlag,
    })

    if (sub !== 'list') {
      if (sub === 'clear') {
        const target = (targetArg ?? '').trim().toLowerCase()
        persistDaemonOriginRules(configFile, {
          clearAllowed: !target || target === 'all' || target === 'allow' || target === 'allowed',
          clearDenied: !target || target === 'all' || target === 'deny' || target === 'denied',
        })
      } else {
        const parsed = parseOriginFlagValues(targetArg ? [targetArg] : [])
        if (parsed.valid.length === 0 || parsed.invalid.length > 0) {
          console.error(
            JSON.stringify(
              {
                ok: false,
                error: `Invalid origin rule for "${sub}": ${JSON.stringify(targetArg ?? '')}`,
              },
              null,
              2,
            ),
          )
          process.exit(1)
        }
        persistDaemonOriginRules(configFile, {
          ...(sub === 'allow' ? { allowOrigins: parsed.valid } : {}),
          ...(sub === 'deny' ? { denyOrigins: parsed.valid } : {}),
          ...(sub === 'unallow' ? { removeAllowed: parsed.valid } : {}),
          ...(sub === 'undeny' ? { removeDenied: parsed.valid } : {}),
        })
      }
    }

    const configExists = fs.existsSync(configFile)
    const persisted = configExists ? readDaemonConfig(configFile) : null
    const rules = {
      allowedOrigins: persisted?.allowedOrigins ?? [],
      deniedOrigins: persisted?.deniedOrigins ?? [],
      persistedAllowedOrigins: persisted?.allowedOrigins ?? [],
      persistedDeniedOrigins: persisted?.deniedOrigins ?? [],
      configFile,
      configExists,
    }
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, action: sub, ...rules, rules }, null, 2))
    } else {
      console.log(
        formatOriginRulesAscii(rules, {
          width: flags.width !== undefined ? Number(flags.width) : undefined,
        }),
      )
    }
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
        profileDir: resolvedProfileFlag,
        remoteCdpPort: remoteCdpPortFlag,
        cdpUrl: cdpUrlFlag,
        proxy: proxyFlag,
        trackerBlocking,
        crashRecovery,
        downloads: downloadsOpts,
        dialogs: dialogsOpts,
        audit: auditOpts,
        ssrf: ssrfOpts,
        untrustedMarkers: untrustedMarkersOpts,
        redactSecrets: redactSecretsOpts,
        policy: policyProfileFlag,
        policyFile: policyFileFlag,
        readonly: readonlyFlag || undefined,
        allowOrigins: allowOriginsFlag,
        denyOrigins: denyOriginsFlag,
        daemonConfigFile: daemonConfigFileFlag,
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

  if (cmd === 'ec2') {
    const sub = positional[1] || 'setup'
    if (sub === 'setup') {
      console.log(`=== Troy Advanced EC2 Setup ===
1. One-command Docker Compose deployment (persistent profile volume + /readyz healthcheck):
   docker compose up -d
   docker compose ps
   curl -s http://127.0.0.1:9333/readyz

2. Or bootstrap Chromium + Node natively on Ubuntu / Amazon Linux 2023:
   bash deploy/ec2-bootstrap.sh
   sudo cp deploy/troy-advanced.service /etc/systemd/system/
   sudo systemctl enable --now troy-advanced

3. Tunnel the loopback Agent Socket securely from your laptop (optional):
   troy-advanced ec2 tunnel ec2-user@<ec2-host> --discover --connect

4. Or drive Chrome on another EC2 node over an SSH tunnel using --cdp-url:
   troy-advanced ec2 tunnel ec2-user@<chrome-node> --cdp-only --connect --background
   troy-advanced daemon start --cdp-url http://127.0.0.1:19222

5. Or run AI agents directly on the EC2 host over SSH/tmux:
   troy-advanced daemon start --compat-troy
   troy-advanced open https://example.com
   troy-advanced ascii
   troy-advanced mcp       # Wire into Dexter / Claude Code / Codex MCP config
`)
      return
    }

    if (sub === 'compose') {
      try {
        const validateTarget =
          typeof flags.validate === 'string' && flags.validate.trim()
            ? path.resolve(flags.validate.trim())
            : flags.validate === true
              ? path.resolve('docker-compose.yml')
              : undefined

        if (validateTarget) {
          const result = validateDockerComposeFile(validateTarget)
          if (flags.json) {
            console.log(JSON.stringify({ file: validateTarget, ...result }, null, 2))
          } else {
            console.log(`Docker Compose validation (${validateTarget}): ${result.ok ? 'PASS' : 'FAIL'}`)
            for (const err of result.errors) {
              console.log(`  [ERROR] ${err.code}: ${err.message}`)
            }
            for (const warn of result.warnings) {
              console.log(`  [WARN]  ${warn.code}: ${warn.message}`)
            }
          }
          if (!result.ok) process.exit(1)
          return
        }

        const portFlag =
          typeof flags.port === 'string' && flags.port.trim() ? Number(flags.port.trim()) : undefined
        const yaml = renderDockerComposeYaml({
          port: portFlag,
          engine,
          policy: policyProfileFlag ?? 'standard',
          shmSize: typeof flags['shm-size'] === 'string' ? flags['shm-size'].trim() : undefined,
          volumeName: typeof flags.volume === 'string' ? flags.volume.trim() : undefined,
          bindHostDir: typeof flags['bind-dir'] === 'string' ? flags['bind-dir'].trim() : undefined,
          image: typeof flags.image === 'string' ? flags.image.trim() : undefined,
          memoryLimit: typeof flags.memory === 'string' ? flags.memory.trim() : undefined,
          cpus: typeof flags.cpus === 'string' ? flags.cpus.trim() : undefined,
          timezone: typeof flags.tz === 'string' ? flags.tz.trim() : undefined,
          readonly: Boolean(flags.readonly),
          publicMetrics: Boolean(flags['public-metrics']),
          untrustedMarkers: Boolean(flags['untrusted-markers']),
          redactSecrets: Boolean(flags['redact-secrets']),
          allowOrigins: allowOriginsFlag,
          denyOrigins: denyOriginsFlag,
          compatTroy: flags['no-compat-troy'] ? false : true,
          blockPrivateNet: flags['no-block-private-net'] ? false : true,
        })

        const writeTarget =
          typeof flags.write === 'string' && flags.write.trim()
            ? path.resolve(flags.write.trim())
            : undefined

        if (writeTarget) {
          fs.mkdirSync(path.dirname(writeTarget), { recursive: true })
          fs.writeFileSync(writeTarget, yaml, 'utf8')
          if (flags.json) {
            console.log(JSON.stringify({ ok: true, file: writeTarget, bytes: Buffer.byteLength(yaml, 'utf8') }, null, 2))
          } else {
            console.log(`Wrote hardened EC2 docker-compose manifest to ${writeTarget}`)
          }
          return
        }

        if (flags.json) {
          console.log(JSON.stringify({ ok: true, yaml }, null, 2))
        } else {
          process.stdout.write(yaml)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(flags.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
        process.exit(1)
      }
      return
    }

    if (sub === 'tunnel') {
      const target = positional[2]
      if (!target) {
        const msg =
          'Usage: troy-advanced ec2 tunnel <user@host> [--local-port N] [--remote-port N] [--cdp] [--cdp-only] [--cdp-port N] [--remote-cdp-port N] [-i <key>] [--ssh-port N] [--jump <bastion>] [--discover] [--write-endpoint <file>] [--connect] [--background] [--json]'
        console.error(flags.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
        process.exit(1)
      }

      const parseOptInt = (val: string | boolean | undefined, label: string): number | undefined => {
        if (val === undefined || val === false) return undefined
        if (val === true) throw new Error(`${label} requires a numeric value`)
        const n = Number(val)
        if (!Number.isInteger(n)) throw new Error(`Invalid ${label} "${val}": must be an integer`)
        return n
      }

      try {
        const localPort = parseOptInt(flags['local-port'] ?? flags.port, '--local-port')
        let remotePort = parseOptInt(flags['remote-port'], '--remote-port')
        const localCdpPort = parseOptInt(flags['local-cdp-port'] ?? flags['cdp-port'], '--cdp-port')
        let remoteCdpPort = parseOptInt(flags['remote-cdp-port'], '--remote-cdp-port')
        const sshPort = parseOptInt(flags['ssh-port'], '--ssh-port')
        const keepaliveSec = parseOptInt(flags.keepalive, '--keepalive')
        const keepaliveCount = parseOptInt(flags['keepalive-count'], '--keepalive-count')
        const timeoutMs = parseOptInt(flags.timeout, '--timeout')

        const baseOpts = {
          target,
          localPort,
          remotePort,
          forwardCdp: Boolean(flags.cdp),
          cdpOnly: Boolean(flags['cdp-only']),
          localCdpPort,
          remoteCdpPort,
          sshPort,
          identityFile: typeof flags.identity === 'string' ? flags.identity : undefined,
          jumpHost: typeof flags.jump === 'string' ? flags.jump : undefined,
          background: Boolean(flags.background),
          batchMode: Boolean(flags.batch),
          keepaliveSec,
          keepaliveCount,
          strictHostKey:
            typeof flags['strict-host-key'] === 'string'
              ? (flags['strict-host-key'] as StrictHostKeyMode)
              : undefined,
          remoteEndpointPath:
            typeof flags['remote-endpoint'] === 'string' ? flags['remote-endpoint'] : undefined,
          sshBinary: typeof flags['ssh-bin'] === 'string' ? flags['ssh-bin'] : undefined,
        }

        let plan = buildEc2TunnelPlan(baseOpts)
        let discoveredEndpoint:
          | Awaited<ReturnType<typeof discoverRemoteEndpoint>>['endpoint']
          | undefined
        let writtenEndpointFile: string | undefined

        if (flags.discover) {
          const disc = await discoverRemoteEndpoint(plan, { timeoutMs })
          if (!disc.ok || !disc.endpoint) {
            const out = { ok: false, error: disc.error || 'Failed to discover remote endpoint', stderr: disc.stderr }
            console.error(flags.json ? JSON.stringify(out, null, 2) : `${out.error}${disc.stderr ? `\n${disc.stderr}` : ''}`)
            process.exit(1)
          }
          discoveredEndpoint = disc.endpoint
          if (remotePort === undefined) remotePort = disc.endpoint.agentPort
          if (remoteCdpPort === undefined && disc.endpoint.port > 0) remoteCdpPort = disc.endpoint.port
          plan = buildEc2TunnelPlan({
            ...baseOpts,
            remotePort,
            remoteCdpPort,
          })
          if (flags['write-endpoint']) {
            const agentFwd = plan.forwards.find((f) => f.label === 'agent')
            const cdpFwd = plan.forwards.find((f) => f.label === 'cdp')
            if (agentFwd) {
              const outPath = typeof flags['write-endpoint'] === 'string' ? flags['write-endpoint'] : undefined
              const written = writeTunneledEndpointFile(
                disc.endpoint,
                agentFwd.localPort,
                outPath,
                cdpFwd?.localPort,
              )
              writtenEndpointFile = written.file
            }
          }
        }

        const shouldConnect = Boolean(flags.connect || flags.exec || flags.start)
        if (!shouldConnect) {
          if (flags.json) {
            console.log(
              JSON.stringify(
                {
                  ...plan,
                  connected: false,
                  ...(discoveredEndpoint ? { discoveredEndpoint } : {}),
                  ...(writtenEndpointFile ? { writtenEndpointFile } : {}),
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              formatEc2TunnelAscii(plan, {
                discoveredEndpoint,
                writtenEndpointFile,
              }),
            )
          }
          return
        }

        if (!flags.json && !plan.security.background) {
          console.log(
            formatEc2TunnelAscii(plan, {
              discoveredEndpoint,
              writtenEndpointFile,
            }),
          )
          console.log('Establishing foreground SSH loopback tunnel (press Ctrl+C to close)...')
        }

        const result = await establishEc2Tunnel(plan, {
          timeoutMs,
          onStderr: !flags.json ? (chunk) => process.stderr.write(chunk) : undefined,
          onStdout: !flags.json ? (chunk) => process.stdout.write(chunk) : undefined,
        })

        if (flags.json) {
          console.log(
            JSON.stringify(
              {
                ...plan,
                connected: result.ok,
                tunnel: result,
                ...(discoveredEndpoint ? { discoveredEndpoint } : {}),
                ...(writtenEndpointFile ? { writtenEndpointFile } : {}),
              },
              null,
              2,
            ),
          )
        } else if (plan.security.background || !result.ok) {
          console.log(
            formatEc2TunnelAscii(plan, {
              discoveredEndpoint,
              writtenEndpointFile,
              connected: result,
            }),
          )
        }

        if (!result.ok) process.exit(1)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(flags.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
        process.exit(1)
      }
      return
    }

    console.error(`Unknown ec2 subcommand "${sub}". Usage: troy-advanced ec2 <setup|compose|tunnel>`)
    process.exit(1)
  }

  if (cmd === 'daemon') {
    const sub = positional[1] || 'status'
    const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'troy-advanced.mjs')
    const logFileFlag =
      typeof flags['log-file'] === 'string' && flags['log-file'].trim()
        ? path.resolve(flags['log-file'].trim())
        : undefined
    const logMaxBytesFlag =
      typeof flags['log-max-bytes'] === 'string' && Number.isFinite(Number(flags['log-max-bytes']))
        ? Number(flags['log-max-bytes'])
        : undefined
    const logMaxFilesFlag =
      typeof flags['log-max-files'] === 'string' && Number.isFinite(Number(flags['log-max-files']))
        ? Number(flags['log-max-files'])
        : undefined
    let maxRssMbFlag: number | undefined
    if (typeof flags['max-rss-mb'] === 'string') {
      try {
        maxRssMbFlag = parseMaxRssMb(flags['max-rss-mb'])
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
    const watchdogIntervalMsFlag =
      typeof flags['watchdog-interval-ms'] === 'string' &&
      Number.isFinite(Number(flags['watchdog-interval-ms']))
        ? Number(flags['watchdog-interval-ms'])
        : undefined
    const watchdogIdleTtlMsFlag =
      typeof flags['watchdog-idle-ttl-ms'] === 'string' &&
      Number.isFinite(Number(flags['watchdog-idle-ttl-ms']))
        ? Number(flags['watchdog-idle-ttl-ms'])
        : undefined

    const daemonOpts = {
      engine,
      port: flags.port ? Number(flags.port) : undefined,
      cdpPort: flags['cdp-port'] ? Number(flags['cdp-port']) : undefined,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      proxy: proxyFlag,
      profileDir: resolvedProfileFlag,
      endpointFile: endpointFlag,
      compatTroy: Boolean(flags['compat-troy']),
      initialUrl: typeof flags.url === 'string' ? flags.url : undefined,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
      ssrf: ssrfOpts,
      untrustedMarkers: untrustedMarkersOpts,
      redactSecrets: redactSecretsOpts,
      policy: policyProfileFlag,
      policyFile: policyFileFlag,
      readonly: readonlyFlag || undefined,
      allowOrigins: allowOriginsFlag,
      denyOrigins: denyOriginsFlag,
      daemonConfigFile: daemonConfigFileFlag,
      logFile: logFileFlag,
      logMaxBytes: logMaxBytesFlag,
      logMaxFiles: logMaxFilesFlag,
      healthProbeUnauthenticated: flags['no-health-probe'] ? false : undefined,
      metricsUnauthenticated: Boolean(flags['public-metrics']),
      maxRssMb: maxRssMbFlag,
      watchdogIntervalMs: watchdogIntervalMsFlag,
      watchdogIdleTtlMs: watchdogIdleTtlMsFlag,
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
    if (sub === 'logs') {
      const logFile = logFileFlag ?? defaultDaemonLogPath(endpointFlag)
      const includeRotated = Boolean(flags.all) || Boolean(flags['include-rotated'])

      if (flags.rotate) {
        const res = rotateLogFile(logFile, {
          maxBytes: logMaxBytesFlag,
          maxFiles: logMaxFilesFlag,
          copyTruncate: true,
        })
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, ...res }, null, 2))
        } else if (res.rotated) {
          console.log(
            res.rotatedTo
              ? `Rotated ${res.logFile} -> ${res.rotatedTo} (${res.sizeBytes ?? 0} bytes)`
              : `Truncated ${res.logFile} (${res.sizeBytes ?? 0} bytes)`,
          )
        } else {
          console.log(`No active log file to rotate at ${res.logFile}`)
        }
        return
      }

      if (flags.clear) {
        const res = clearLogFiles(logFile, { includeRotated })
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, logFile, ...res }, null, 2))
        } else {
          console.log(`Cleared ${res.cleared.length} log file(s) for ${logFile}`)
        }
        return
      }

      let tailCount: number | null = DEFAULT_LOG_TAIL_LINES
      if (typeof flags.tail === 'string') {
        const parsed = Number(flags.tail)
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(`Invalid --tail value: "${flags.tail}" (expected non-negative integer)`)
          process.exit(1)
        }
        tailCount = Math.floor(parsed)
      } else if (flags.all) {
        tailCount = null
      }

      if (flags.follow) {
        const pollMs =
          typeof flags['poll-ms'] === 'string' && Number.isFinite(Number(flags['poll-ms']))
            ? Math.max(25, Math.floor(Number(flags['poll-ms'])))
            : undefined
        const handle = followLogFile(logFile, {
          tail: tailCount ?? DEFAULT_LOG_TAIL_LINES,
          pollIntervalMs: pollMs,
          onLine: (line) => {
            if (flags.json) {
              console.log(JSON.stringify({ logFile, line }))
            } else {
              console.log(line)
            }
          },
          onRotate: (info) => {
            if (flags.json) {
              console.log(JSON.stringify({ event: 'log_rotated', ...info }))
            } else {
              console.error(`[troy-advanced] log rotated (${info.reason}): ${info.logFile}`)
            }
          },
          onError: (err) => {
            console.error(`[troy-advanced] log follow error: ${err.message}`)
          },
        })
        const onStop = () => handle.stop()
        process.once('SIGINT', onStop)
        process.once('SIGTERM', onStop)
        await handle.done
        process.removeListener('SIGINT', onStop)
        process.removeListener('SIGTERM', onStop)
        return
      }

      const result = readLogTail(logFile, {
        tail: tailCount,
        includeRotated,
      })
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2))
        return
      }
      if (!result.exists) {
        console.log(`No daemon log found at ${result.logFile}`)
        return
      }
      if (result.lines.length > 0) {
        console.log(result.lines.join('\n'))
      }
      return
    }
    if (sub === 'status') {
      const live = readLiveEndpoint(endpointFlag)
      if (!live) {
        cli.debug('daemon status: no live endpoint', { endpoint: endpointFlag ?? 'default' })
        cli.json({ ok: false, running: false, code: 'daemon_offline' })
        process.exit(CLI_EXIT_CODES.DAEMON_OFFLINE)
      }
      const health = await callDaemon(live.endpoint, '/health', {}, cli)
      cli.json({ ok: true, running: true, endpoint: live.endpoint, health })
      return
    }
    cli.error(`Unknown daemon subcommand: "${sub}". Expected start | run | stop | status | logs`)
    process.exit(CLI_EXIT_CODES.ERROR)
  }

  if (cmd === 'browse') {
    const manager = await BrowserManager.create({
      engine,
      profileDir: resolvedProfileFlag,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      proxy: proxyFlag,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
      ssrf: ssrfOpts,
      untrustedMarkers: untrustedMarkersOpts,
      redactSecrets: redactSecretsOpts,
      policy: policyProfileFlag,
      policyFile: policyFileFlag,
      readonly: readonlyFlag || undefined,
      allowOrigins: allowOriginsFlag,
      denyOrigins: denyOriginsFlag,
      daemonConfigFile: daemonConfigFileFlag,
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
      profileDir: resolvedProfileFlag,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      proxy: proxyFlag,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
      ssrf: ssrfOpts,
      untrustedMarkers: untrustedMarkersOpts,
      redactSecrets: redactSecretsOpts,
      policy: policyProfileFlag,
      policyFile: policyFileFlag,
      readonly: readonlyFlag || undefined,
      allowOrigins: allowOriginsFlag,
      denyOrigins: denyOriginsFlag,
      daemonConfigFile: daemonConfigFileFlag,
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
      profileDir: resolvedProfileFlag,
      remoteCdpPort: remoteCdpPortFlag,
      cdpUrl: cdpUrlFlag,
      proxy: proxyFlag,
      trackerBlocking,
      emulation: cliEmulation,
      crashRecovery,
      downloads: downloadsOpts,
      dialogs: dialogsOpts,
      audit: auditOpts,
      ssrf: ssrfOpts,
      untrustedMarkers: untrustedMarkersOpts,
      redactSecrets: redactSecretsOpts,
      policy: policyProfileFlag,
      policyFile: policyFileFlag,
      readonly: readonlyFlag || undefined,
      allowOrigins: allowOriginsFlag,
      denyOrigins: denyOriginsFlag,
      daemonConfigFile: daemonConfigFileFlag,
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

    const explicitProfile = resolvedProfileFlag
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
          proxy: proxyFlag,
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
          proxy: proxyFlag,
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
          proxy: proxyFlag,
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

    const explicitProfile = resolvedProfileFlag
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
          proxy: proxyFlag,
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
          proxy: proxyFlag,
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
          proxy: proxyFlag,
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
          proxy: proxyFlag,
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
    cli.debug(`oneshot ${cmd}`, { target: positional[1], engine })
    const manager = await cli.withTimeout(
      BrowserManager.create({
        engine,
        remoteCdpPort: remoteCdpPortFlag,
        cdpUrl: cdpUrlFlag,
        proxy: proxyFlag,
        trackerBlocking,
        emulation: cliEmulation,
        ssrf: ssrfOpts,
        untrustedMarkers: untrustedMarkersOpts,
        redactSecrets: redactSecretsOpts,
        policy: policyProfileFlag,
        policyFile: policyFileFlag,
        readonly: readonlyFlag || undefined,
        allowOrigins: allowOriginsFlag,
        denyOrigins: denyOriginsFlag,
        daemonConfigFile: daemonConfigFileFlag,
      }),
      `oneshot ${cmd} startup`,
    )
    try {
      const opened = await cli.withTimeout(
        manager.openTab(positional[1], { activate: true, bypassReadonly: true }),
        `oneshot ${cmd} open`,
      )
      if (!opened.ok) {
        cli.errorJson(opened)
        process.exit(cli.classifyResponse(opened as unknown as Record<string, unknown>))
      }
      if (cmd === 'extract') {
        const res = await cli.withTimeout(
          manager.runTool(opened.id, 'page_extract', {
            sections: typeof flags.sections === 'string' ? flags.sections : undefined,
            maxItems: flags['max-items'] ? Number(flags['max-items']) : undefined,
            includeObjects: !flags['no-objects'],
            asciiOnly: Boolean(flags['ascii-only']),
            externalLinksOnly: Boolean(flags.external),
            internalLinksOnly: Boolean(flags.internal),
            ascii: Boolean(flags.ascii),
            width: flags.width ? Number(flags.width) : undefined,
            settle: Boolean(flags.settle),
          }),
          'oneshot extract',
        )
        if (flags.ascii && !flags.json && typeof res.ascii === 'string') cli.out(res.ascii)
        else cli.json(res)
        const exitCode = cli.classifyResponse(res as Record<string, unknown>)
        if (exitCode !== CLI_EXIT_CODES.OK) process.exit(exitCode)
        return
      }
      if (cmd === 'markdown' || cmd === 'md') {
        const res = await cli.withTimeout(
          manager.runTool(opened.id, 'page_read_markdown', {
            includeFrontmatter: Boolean(flags.frontmatter),
            includeMediaSummary: Boolean(flags.media),
            asciiOnly: Boolean(flags.ascii),
            showRefs: !flags['no-refs'],
            includeUrls: !flags['no-urls'],
            crop: typeof flags.crop === 'string' ? flags.crop : undefined,
            ref: typeof flags.ref === 'string' ? flags.ref : undefined,
          }),
          'oneshot markdown',
        )
        if (flags.json) cli.json(res)
        else if (typeof res.markdown === 'string') cli.out(res.markdown)
        else cli.json(res)
        const exitCode = cli.classifyResponse(res as Record<string, unknown>)
        if (exitCode !== CLI_EXIT_CODES.OK) process.exit(exitCode)
        return
      }
      const toolName = cmd === 'visual' ? 'page_screenshot_ascii' : 'page_read_ascii'
      const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
      const res = await cli.withTimeout(
        manager.runTool(opened.id, toolName, {
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
        }),
        `oneshot ${cmd}`,
      )
      if (flags.json) cli.json(res)
      else if (typeof res.ascii === 'string') cli.out(res.ascii)
      else cli.json(res)
      const exitCode = cli.classifyResponse(res as Record<string, unknown>)
      if (exitCode !== CLI_EXIT_CODES.OK) process.exit(exitCode)
    } finally {
      await manager.close()
    }
    return
  }

  // Daemon client commands
  const live = readLiveEndpoint(endpointFlag)
  if (!live) {
    cli.debug('daemon offline: no live endpoint file', { endpoint: endpointFlag ?? 'default' })
    cli.errorJson({
      ok: false,
      code: 'daemon_offline',
      error: 'troy-advanced daemon is not running. Start it with: troy-advanced daemon start',
    })
    process.exit(CLI_EXIT_CODES.DAEMON_OFFLINE)
  }

  cli.debug('daemon endpoint loaded', {
    port: live.endpoint.agentPort,
    pid: live.endpoint.pid,
    file: live.endpoint.file,
  })

  const rawSession = typeof flags.session === 'string' ? flags.session : process.env.TROY_SESSION
  const parsedSession = parseSessionId(rawSession)
  if (!parsedSession.ok) {
    cli.errorJson({ ok: false, error: parsedSession.error })
    process.exit(CLI_EXIT_CODES.ERROR)
  }
  const sessionId = parsedSession.sessionId
  const daemonEndpoint = sessionId ? { ...live.endpoint, sessionId } : live.endpoint
  const daemonCall = (route: string, body: Record<string, unknown> = {}, timeoutOverrideMs?: number) =>
    callDaemon(daemonEndpoint, route, body, cli, timeoutOverrideMs)

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
              cli.out(JSON.stringify(parsed))
            } else if (parsed.type === 'ascii_frame' && typeof parsed.ascii === 'string') {
              cli.out(
                `--- [frame #${parsed.seq ?? '?'} | ${parsed.reason ?? 'update'} | tab ${parsed.tabId ?? '?'} | ${parsed.mode ?? 'full'}] ---`,
              )
              cli.out(parsed.ascii)
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
          if (isDaemonOfflineError(err) || (err instanceof TypeError && /fetch failed/i.test(err.message))) {
            throw cli.daemonOfflineError(
              `Unable to reach troy-advanced daemon on 127.0.0.1:${daemonEndpoint.agentPort}`,
            )
          }
          cli.errorJson({ ok: false, error: String((err as Error)?.message ?? err) })
          process.exit(CLI_EXIT_CODES.ERROR)
        }
      } finally {
        process.off('SIGINT', onSig)
        process.off('SIGTERM', onSig)
      }
      return
    }
    case 'status': {
      const health = await daemonCall('/health')
      const memory = await daemonCall('/memory')
      res = { ok: true, endpoint: live.endpoint.file, pid: live.endpoint.pid, health, memory }
      break
    }
    case 'health': {
      const base = `http://127.0.0.1:${daemonEndpoint.agentPort}`
      const timeoutCtl = cli.createTimeoutSignal()
      let livezRes: Response
      let readyzRes: Response
      try {
        ;[livezRes, readyzRes] = await Promise.all([
          fetch(`${base}/healthz`, { signal: timeoutCtl.signal }),
          fetch(`${base}/readyz`, { signal: timeoutCtl.signal }),
        ])
      } catch (err) {
        if (timeoutCtl.signal.aborted || isTimeoutError(err)) {
          throw new CliExitError(`Health probe timed out after ${timeoutCtl.timeoutMs}ms`, {
            exitCode: CLI_EXIT_CODES.ERROR,
            code: 'timeout',
            payload: { ok: false, code: 'timeout', error: `Health probe timed out after ${timeoutCtl.timeoutMs}ms` },
            cause: err,
          })
        }
        throw cli.daemonOfflineError(
          `Unable to reach troy-advanced daemon on 127.0.0.1:${daemonEndpoint.agentPort}`,
        )
      } finally {
        timeoutCtl.clear()
      }
      const livez = (await livezRes.json().catch(() => ({ ok: false }))) as Record<string, unknown>
      const readyz = (await readyzRes.json().catch(() => ({ ok: false }))) as Record<string, unknown>
      const health = await daemonCall('/health')
      const ok = livezRes.ok && readyzRes.ok && Boolean(health.ok)
      res = {
        ok,
        endpoint: live.endpoint.file,
        pid: live.endpoint.pid,
        livez: { httpStatus: livezRes.status, ...livez },
        readyz: { httpStatus: readyzRes.status, ...readyz },
        health,
      }
      if (!ok) {
        cli.json(res)
        process.exit(CLI_EXIT_CODES.ERROR)
      }
      break
    }
    case 'metrics': {
      const wantProm = Boolean(flags.prometheus || flags.prom)
      const metricsRes = await daemonCall('/metrics', {
        ...(flags.width !== undefined ? { width: Number(flags.width) } : {}),
      })
      if (!metricsRes.ok) {
        res = metricsRes
        break
      }
      if (wantProm) {
        if (!cli.quiet) process.stdout.write(String(metricsRes.prometheus ?? ''))
        return
      }
      if (flags.json) {
        cli.json(metricsRes.snapshot ?? metricsRes)
        return
      }
      cli.out(String(metricsRes.ascii ?? ''))
      return
    }
    case 'sessions': {
      if (args[0] === 'close') {
        const targetId = args[1] || sessionId
        res = await daemonCall('/sessions', {
          sessionId: targetId,
          close: true,
          closeTabs: !flags['keep-tabs'],
        })
      } else if (args[0]) {
        res = await daemonCall('/sessions', {
          sessionId: args[0],
          ...(flags.width !== undefined ? { width: Number(flags.width) } : {}),
        })
      } else {
        res = await daemonCall('/sessions', {
          ...(flags.width !== undefined ? { width: Number(flags.width) } : {}),
        })
      }
      break
    }
    case 'tabs':
      res = await daemonCall('/tabs')
      break
    case 'open':
      res = await daemonCall('/open', { url: args.join(' '), activate: true })
      if (res.ok && flags.ascii) {
        const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
        res = await daemonCall('/ascii', {
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
      res = await daemonCall('/activate', { tabId: Number(args[0]) })
      break
    case 'close':
      res = await daemonCall('/close', { tabId: Number(args[0]) })
      break
    case 'grant':
      res = await daemonCall('/grant-origin', { origin: args[0], tabId })
      break
    case 'ascii': {
      const maxTokensOpt = parseMaxTokens(flags['max-tokens'])
      res = await daemonCall('/ascii', {
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
        ...(untrustedMarkersOpts ? { untrustedMarkers: untrustedMarkersOpts } : {}),
        ...(redactSecretsOpts ? { redactSecrets: redactSecretsOpts } : {}),
        asciiOnly: true,
      })
      break
    }
    case 'markdown':
    case 'md':
      res = await daemonCall('/markdown', {
        tabId,
        includeFrontmatter: Boolean(flags.frontmatter),
        includeMediaSummary: Boolean(flags.media),
        asciiOnly: Boolean(flags.ascii),
        showRefs: !flags['no-refs'],
        includeUrls: !flags['no-urls'],
        crop: typeof flags.crop === 'string' ? flags.crop : undefined,
        ref: typeof flags.ref === 'string' ? flags.ref : undefined,
        settle: Boolean(flags.settle),
        ...(untrustedMarkersOpts ? { untrustedMarkers: untrustedMarkersOpts } : {}),
        ...(redactSecretsOpts ? { redactSecrets: redactSecretsOpts } : {}),
      })
      break
    case 'visual':
      res = await daemonCall('/tool', {
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
      res = await daemonCall('/tool', {
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
          ...(untrustedMarkersOpts ? { untrustedMarkers: untrustedMarkersOpts } : {}),
          ...(redactSecretsOpts ? { redactSecrets: redactSecretsOpts } : {}),
        },
      })
      break
    }
    case 'find': {
      const findRoles: string[] = []
      if (typeof flags.role === 'string') findRoles.push(flags.role)
      if (flags.button) findRoles.push('button')
      if (flags.input) findRoles.push('input')
      if (flags.link) findRoles.push('link')
      if (flags.select) findRoles.push('select')
      if (flags.checkbox) findRoles.push('checkbox')
      if (flags.radio) findRoles.push('radio')
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_find',
        args: {
          query: args.join(' '),
          ...(findRoles.length > 0 ? { roles: findRoles } : {}),
          ...(flags.limit ? { limit: Number(flags.limit) } : {}),
          ...(flags['no-fuzzy'] ? { fuzzy: false } : {}),
          ...(flags['no-synonyms'] ? { synonyms: false } : {}),
          ...(flags['enabled-only'] ? { includeDisabled: false } : {}),
        },
      })
      break
    }
    case 'text':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_text',
        args: {
          ...(args[0] ? { ref: args[0] } : {}),
          ...(untrustedMarkersOpts ? { untrustedMarkers: untrustedMarkersOpts } : {}),
          ...(redactSecretsOpts ? { redactSecrets: redactSecretsOpts } : {}),
        },
      })
      break
    case 'extract':
      res = await daemonCall('/extract', {
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
        ...(untrustedMarkersOpts ? { untrustedMarkers: untrustedMarkersOpts } : {}),
        ...(redactSecretsOpts ? { redactSecrets: redactSecretsOpts } : {}),
      })
      break
    case 'click':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_click',
        args: { ref: args[0], allowSubmit: Boolean(flags['allow-submit'] || flags.submit) },
      })
      break
    case 'fill':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_fill',
        args: { ref: args[0], text: args.slice(1).join(' '), clear: flags.clear !== undefined ? Boolean(flags.clear) : true },
      })
      break
    case 'select':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_select',
        args: { ref: args[0], value: args.slice(1).join(' ') },
      })
      break
    case 'press':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_press',
        args: { key: args[0] ?? 'Enter', ref: typeof flags.ref === 'string' ? flags.ref : undefined },
      })
      break
    case 'scroll':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_scroll',
        args: { direction: args[0] || 'down', amount: args[1] ? Number(args[1]) : 450 },
      })
      break
    case 'wait': {
      const waitTimeout = cli.timeoutMs
      const rpcTimeout = waitTimeout !== undefined ? Math.max(waitTimeout + 5_000, 10_000) : undefined
      res = await daemonCall(
        '/tool',
        {
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
            ...(waitTimeout !== undefined ? { timeout: waitTimeout } : {}),
          },
        },
        rpcTimeout,
      )
      break
    }
    case 'back':
    case 'forward':
    case 'reload':
      res = await daemonCall('/tool', { tabId, name: 'page_history', args: { direction: cmd } })
      break
    case 'console':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_console',
        args: { clear: Boolean(flags.clear), level: flags.level, limit: flags.limit ? Number(flags.limit) : 50 },
      })
      break
    case 'network': {
      const bodyReqId = typeof flags.body === 'string' ? flags.body : undefined
      res = await daemonCall('/tool', {
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
      res = await daemonCall('/tool', { tabId, name: 'page_eval', args: { expression: args.join(' ') } })
      break
    case 'act':
      res = await daemonCall('/tool', {
        tabId,
        name: 'page_act',
        args: { steps: JSON.parse(args.join(' ')), allowSubmit: Boolean(flags['allow-submit']) },
      })
      break
    case 'recall':
      res = await daemonCall('/recall', {
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
      res = await daemonCall('/forget', { origin: args[0] })
      break
    case 'emulate':
    case 'viewport': {
      const viewportArg = typeof flags.viewport === 'string' ? flags.viewport : args[0]
      const extraHeaders = rawHeaderArgs.length > 0 ? parseHeaderList(rawHeaderArgs) : undefined
      const removeHeaders = multiFlags['remove-header']
      res = await daemonCall('/emulation', {
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
      res = await daemonCall('/downloads', {
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
      res = await daemonCall('/dialogs', {
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
      res = await daemonCall('/audit', {
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
      cli.error(`Unknown command: ${cmd}\nRun "troy-advanced help" for usage.`)
      process.exit(CLI_EXIT_CODES.ERROR)
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
    cli.out(res.ascii)
  } else if (!flags.json && (cmd === 'markdown' || cmd === 'md') && typeof res.markdown === 'string') {
    cli.out(res.markdown)
  } else {
    cli.json(res)
  }
  const exitCode = cli.classifyResponse(res, daemonHttpStatus.get(res))
  if (exitCode !== CLI_EXIT_CODES.OK) process.exit(exitCode)
}
