// Secure SSH loopback tunnel helper for EC2 deployments (`troy-advanced ec2 tunnel <user@host>`).
// Builds hardened OpenSSH loopback forwarding commands (`127.0.0.1` only, ExitOnForwardFailure=yes,
// ServerAliveInterval keepalives, no remote shell) and optionally establishes the tunnel live
// or discovers the remote daemon's agent-endpoint.json over SSH.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { defaultEndpointPath, writeEndpoint } from '../bridge/endpoint.js'
import { sanitizeAscii } from '../ascii/sanitize.js'
import type { EndpointDescriptor } from '../types.js'

export const DEFAULT_AGENT_PORT = 9333
export const DEFAULT_LOCAL_CDP_PORT = 19222
export const DEFAULT_REMOTE_CDP_PORT = 9222
export const DEFAULT_SSH_KEEPALIVE_SEC = 30
export const DEFAULT_SSH_KEEPALIVE_COUNT = 3
export const DEFAULT_REMOTE_ENDPOINT_PATH = '~/.config/troy-advanced/agent-endpoint.json'

export type StrictHostKeyMode = 'accept-new' | 'yes' | 'no'

export interface ParsedSshTarget {
  raw: string
  user?: string
  host: string
  sshPort?: number
  /** Canonical OpenSSH destination (`user@host` or `host`, with brackets stripped for IPv6). */
  destination: string
}

export interface TunnelForwardSpec {
  label: 'agent' | 'cdp'
  bindHost: '127.0.0.1'
  localPort: number
  remoteHost: '127.0.0.1'
  remotePort: number
  /** OpenSSH `-L` argument value: `127.0.0.1:<localPort>:127.0.0.1:<remotePort>` */
  spec: string
}

export interface Ec2TunnelOptions {
  /** Target host in `user@host`, `host`, `user@host:port`, or `ssh://user@host:port` form. */
  target: string
  /** Local loopback port for Agent Socket (default: same as remotePort or 9333). */
  localPort?: number
  /** Remote loopback port for Agent Socket on EC2 (default: 9333). */
  remotePort?: number
  /** Also forward Chromium DevTools Protocol (CDP) port over loopback. */
  forwardCdp?: boolean
  /** Only forward CDP (omit Agent Socket forward). */
  cdpOnly?: boolean
  /** Local loopback port for CDP (default: 19222). */
  localCdpPort?: number
  /** Remote loopback port for CDP on EC2 (default: 9222). */
  remoteCdpPort?: number
  /** Explicit SSH server port (overrides port embedded in target). */
  sshPort?: number
  /** Path to SSH private key (`-i`). */
  identityFile?: string
  /** Optional SSH jump host / bastion (`-J`). */
  jumpHost?: string
  /** Run SSH in background after authentication (`-f`). */
  background?: boolean
  /** Non-interactive SSH batch mode (`-o BatchMode=yes`). */
  batchMode?: boolean
  /** ServerAliveInterval in seconds (default: 30, 0 disables). */
  keepaliveSec?: number
  /** ServerAliveCountMax (default: 3). */
  keepaliveCount?: number
  /** StrictHostKeyChecking policy (default: 'accept-new'). */
  strictHostKey?: StrictHostKeyMode
  /** Remote path to agent-endpoint.json on EC2 (default: ~/.config/troy-advanced/agent-endpoint.json). */
  remoteEndpointPath?: string
  /** Path to local ssh binary (default: 'ssh'). */
  sshBinary?: string
}

export interface Ec2TunnelPlan {
  ok: true
  target: ParsedSshTarget
  sshBinary: string
  forwards: TunnelForwardSpec[]
  args: string[]
  command: string
  remoteDiscoverArgs: string[]
  remoteDiscoverCommand: string
  agentUrl?: string
  cdpUrl?: string
  remoteEndpointPath: string
  security: {
    loopbackOnly: true
    exitOnForwardFailure: true
    noRemoteCommand: true
    noTty: true
    strictHostKey: StrictHostKeyMode
    keepaliveSec: number
    keepaliveCount: number
    batchMode: boolean
    background: boolean
    jumpHost?: string
    identityFile?: string
  }
}

export interface DiscoveredRemoteEndpoint {
  ok: boolean
  endpoint?: EndpointDescriptor
  error?: string
  stderr?: string
}

export interface EstablishTunnelOptions {
  /** Timeout in ms to wait for background SSH or readiness probe (default: 15000). */
  timeoutMs?: number
  /** When background=true, probe local loopback port(s) after ssh -f exits (default: true). */
  verifyPort?: boolean
  /** Injectable spawn implementation for testing. */
  spawnFn?: typeof spawn
  /** Injectable port probe for testing. */
  probePortFn?: (port: number, timeoutMs: number) => Promise<boolean>
  /** Optional stdout/stderr writers for foreground output. */
  onStderr?: (chunk: string) => void
  onStdout?: (chunk: string) => void
}

export interface EstablishTunnelResult {
  ok: boolean
  mode: 'background' | 'foreground'
  pid?: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  verifiedPorts?: number[]
  stderr?: string
  error?: string
}

const FORBIDDEN_TARGET_CHARS = /[\s\x00-\x1f\x7f;|&`$()<>\\'"]/
const SAFE_USER_RE = /^[A-Za-z0-9._-]+$/
const SAFE_HOST_RE = /^[A-Za-z0-9._:-]+$/
const STRICT_HOST_KEY_VALUES = new Set<StrictHostKeyMode>(['accept-new', 'yes', 'no'])

export function validatePort(port: number, label: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port "${port}": must be an integer between 1 and 65535`)
  }
  return port
}

/**
 * Parse and strictly validate an SSH target (`user@host`, `host`, `user@host:port`, `ssh://user@host:port`).
 * Blocks leading `-` (SSH option injection) and shell metacharacters.
 */
export function parseSshTarget(rawInput: string): ParsedSshTarget {
  const raw = String(rawInput ?? '').trim()
  if (!raw) {
    throw new Error('SSH target is required (e.g. ec2-user@203.0.113.10 or ubuntu@my-ec2.example.com)')
  }
  if (raw.startsWith('-')) {
    throw new Error(`Invalid SSH target "${raw}": target must not start with "-"`)
  }
  if (FORBIDDEN_TARGET_CHARS.test(raw)) {
    throw new Error(`Invalid SSH target "${raw}": contains disallowed whitespace or shell characters`)
  }

  let body = raw
  if (/^ssh:\/\//i.test(body)) {
    body = body.slice(6)
    const slashIdx = body.indexOf('/')
    if (slashIdx >= 0) {
      const trailing = body.slice(slashIdx)
      if (trailing !== '/') {
        throw new Error(`Invalid SSH target "${raw}": unexpected path "${trailing}"`)
      }
      body = body.slice(0, slashIdx)
    }
  } else if (body.includes('://')) {
    throw new Error(`Invalid SSH target "${raw}": only ssh:// scheme or user@host is supported`)
  }

  let user: string | undefined
  let hostPort = body
  const atIdx = body.lastIndexOf('@')
  if (atIdx >= 0) {
    user = body.slice(0, atIdx)
    hostPort = body.slice(atIdx + 1)
    if (!user || user.startsWith('-') || !SAFE_USER_RE.test(user)) {
      throw new Error(`Invalid SSH username "${user}" in target "${raw}"`)
    }
  }

  let host = hostPort
  let sshPort: number | undefined

  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']')
    if (closeIdx < 0) {
      throw new Error(`Invalid IPv6 SSH target "${raw}": missing closing "]"`)
    }
    host = hostPort.slice(1, closeIdx)
    const rest = hostPort.slice(closeIdx + 1)
    if (rest) {
      if (!rest.startsWith(':')) {
        throw new Error(`Invalid IPv6 SSH target "${raw}": unexpected suffix "${rest}"`)
      }
      const portNum = Number(rest.slice(1))
      sshPort = validatePort(portNum, 'SSH')
    }
  } else {
    const firstColon = hostPort.indexOf(':')
    const lastColon = hostPort.lastIndexOf(':')
    if (firstColon >= 0 && firstColon === lastColon) {
      host = hostPort.slice(0, firstColon)
      const portStr = hostPort.slice(firstColon + 1)
      if (!/^\d+$/.test(portStr)) {
        throw new Error(`Invalid SSH port "${portStr}" in target "${raw}"`)
      }
      sshPort = validatePort(Number(portStr), 'SSH')
    }
  }

  if (!host || host.startsWith('-') || !SAFE_HOST_RE.test(host)) {
    throw new Error(`Invalid SSH host "${host}" in target "${raw}"`)
  }

  const destination = user ? `${user}@${host}` : host
  return {
    raw,
    ...(user ? { user } : {}),
    host,
    ...(sshPort !== undefined ? { sshPort } : {}),
    destination,
  }
}

function validateSafePathArg(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  if (trimmed.startsWith('-')) {
    throw new Error(`Invalid ${label} "${trimmed}": must not start with "-"`)
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`Invalid ${label}: contains control characters`)
  }
  return trimmed
}

/**
 * POSIX shell-safe single-argument quoting for printable copy-paste commands.
 */
export function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function formatSshCommand(binary: string, args: string[]): string {
  return [shellQuoteArg(binary), ...args.map(shellQuoteArg)].join(' ')
}

/**
 * Build a deterministic, hardened OpenSSH loopback forwarding plan.
 * Always binds strictly to 127.0.0.1 on both local and remote sides.
 */
export function buildEc2TunnelPlan(options: Ec2TunnelOptions): Ec2TunnelPlan {
  const target = parseSshTarget(options.target)
  const sshBinary = validateSafePathArg(options.sshBinary || 'ssh', 'ssh binary')

  const sshPort =
    options.sshPort !== undefined
      ? validatePort(options.sshPort, 'SSH')
      : target.sshPort

  const strictHostKey: StrictHostKeyMode = options.strictHostKey ?? 'accept-new'
  if (!STRICT_HOST_KEY_VALUES.has(strictHostKey)) {
    throw new Error(
      `Invalid --strict-host-key "${String(strictHostKey)}": expected one of accept-new, yes, no`,
    )
  }

  const keepaliveSec =
    options.keepaliveSec !== undefined ? options.keepaliveSec : DEFAULT_SSH_KEEPALIVE_SEC
  if (!Number.isInteger(keepaliveSec) || keepaliveSec < 0 || keepaliveSec > 3600) {
    throw new Error(`Invalid keepalive interval "${keepaliveSec}": must be an integer between 0 and 3600`)
  }

  const keepaliveCount =
    options.keepaliveCount !== undefined ? options.keepaliveCount : DEFAULT_SSH_KEEPALIVE_COUNT
  if (!Number.isInteger(keepaliveCount) || keepaliveCount < 1 || keepaliveCount > 60) {
    throw new Error(`Invalid keepalive count "${keepaliveCount}": must be an integer between 1 and 60`)
  }

  const identityFile = options.identityFile
    ? validateSafePathArg(options.identityFile, 'identity file')
    : undefined

  let jumpHost: string | undefined
  if (options.jumpHost) {
    const parsedJump = parseSshTarget(options.jumpHost)
    jumpHost = parsedJump.sshPort ? `${parsedJump.destination}:${parsedJump.sshPort}` : parsedJump.destination
  }

  const remoteEndpointPath = validateSafePathArg(
    options.remoteEndpointPath || DEFAULT_REMOTE_ENDPOINT_PATH,
    'remote endpoint path',
  )

  const forwards: TunnelForwardSpec[] = []
  const includeAgent = !options.cdpOnly
  const includeCdp = Boolean(options.forwardCdp || options.cdpOnly)

  if (includeAgent) {
    const remotePort = validatePort(options.remotePort ?? DEFAULT_AGENT_PORT, 'remote agent')
    const localPort = validatePort(options.localPort ?? remotePort, 'local agent')
    forwards.push({
      label: 'agent',
      bindHost: '127.0.0.1',
      localPort,
      remoteHost: '127.0.0.1',
      remotePort,
      spec: `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    })
  }

  if (includeCdp) {
    const remoteCdpPort = validatePort(options.remoteCdpPort ?? DEFAULT_REMOTE_CDP_PORT, 'remote CDP')
    const localCdpPort = validatePort(options.localCdpPort ?? DEFAULT_LOCAL_CDP_PORT, 'local CDP')
    if (forwards.some((f) => f.localPort === localCdpPort)) {
      throw new Error(`Local port collision: both agent and CDP tunnels requested local port ${localCdpPort}`)
    }
    forwards.push({
      label: 'cdp',
      bindHost: '127.0.0.1',
      localPort: localCdpPort,
      remoteHost: '127.0.0.1',
      remotePort: remoteCdpPort,
      spec: `127.0.0.1:${localCdpPort}:127.0.0.1:${remoteCdpPort}`,
    })
  }

  const baseSshOpts: string[] = []
  if (sshPort !== undefined) {
    baseSshOpts.push('-p', String(sshPort))
  }
  if (identityFile) {
    baseSshOpts.push('-i', identityFile)
  }
  if (jumpHost) {
    baseSshOpts.push('-J', jumpHost)
  }
  baseSshOpts.push('-o', `StrictHostKeyChecking=${strictHostKey}`)
  if (options.batchMode) {
    baseSshOpts.push('-o', 'BatchMode=yes')
  }

  const args: string[] = [
    '-N',
    '-T',
    ...(options.background ? ['-f'] : []),
    ...baseSshOpts,
    '-o',
    'ExitOnForwardFailure=yes',
  ]
  if (keepaliveSec > 0) {
    args.push('-o', `ServerAliveInterval=${keepaliveSec}`)
    args.push('-o', `ServerAliveCountMax=${keepaliveCount}`)
  }
  for (const fwd of forwards) {
    args.push('-L', fwd.spec)
  }
  args.push('--', target.destination)

  // Remote endpoint discovery command: reads remote agent-endpoint.json cleanly with no TTY.
  // Note: `~` is expanded by the remote login shell only when left unquoted at the start;
  // for absolute/relative paths we single-quote it safely.
  const remoteCatArg = remoteEndpointPath.startsWith('~/')
    ? `$HOME/${shellQuoteArg(remoteEndpointPath.slice(2))}`
    : shellQuoteArg(remoteEndpointPath)

  const remoteDiscoverArgs: string[] = [
    '-T',
    ...baseSshOpts,
    '-o',
    'ConnectTimeout=10',
    '--',
    target.destination,
    `cat ${remoteCatArg}`,
  ]

  const agentFwd = forwards.find((f) => f.label === 'agent')
  const cdpFwd = forwards.find((f) => f.label === 'cdp')

  return {
    ok: true,
    target,
    sshBinary,
    forwards,
    args,
    command: formatSshCommand(sshBinary, args),
    remoteDiscoverArgs,
    remoteDiscoverCommand: formatSshCommand(sshBinary, remoteDiscoverArgs),
    ...(agentFwd ? { agentUrl: `http://127.0.0.1:${agentFwd.localPort}` } : {}),
    ...(cdpFwd ? { cdpUrl: `http://127.0.0.1:${cdpFwd.localPort}` } : {}),
    remoteEndpointPath,
    security: {
      loopbackOnly: true,
      exitOnForwardFailure: true,
      noRemoteCommand: true,
      noTty: true,
      strictHostKey,
      keepaliveSec,
      keepaliveCount,
      batchMode: Boolean(options.batchMode),
      background: Boolean(options.background),
      ...(jumpHost ? { jumpHost } : {}),
      ...(identityFile ? { identityFile } : {}),
    },
  }
}

/**
 * Probe whether a local loopback TCP port is accepting connections.
 */
export async function waitForLocalPort(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + Math.max(100, timeoutMs)
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port })
      const timer = setTimeout(() => {
        sock.destroy()
        resolve(false)
      }, 250)
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        clearTimeout(timer)
        sock.destroy()
        resolve(false)
      })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

/**
 * Discover remote `agent-endpoint.json` over SSH using the plan's hardened options.
 */
export async function discoverRemoteEndpoint(
  plan: Ec2TunnelPlan,
  opts: { timeoutMs?: number; spawnFn?: typeof spawn } = {},
): Promise<DiscoveredRemoteEndpoint> {
  const spawnImpl = opts.spawnFn ?? spawn
  const timeoutMs = opts.timeoutMs ?? 12_000

  return new Promise<DiscoveredRemoteEndpoint>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (res: DiscoveredRemoteEndpoint) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }

    let child: ChildProcess
    try {
      child = spawnImpl(plan.sshBinary, plan.remoteDiscoverArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      } as SpawnOptions)
    } catch (err) {
      finish({
        ok: false,
        error: `Failed to spawn ${plan.sshBinary}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      finish({
        ok: false,
        error: `Timed out after ${timeoutMs}ms discovering remote endpoint on ${plan.target.destination}`,
        stderr: stderr.trim() || undefined,
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.once('error', (err) => {
      finish({
        ok: false,
        error: `SSH execution error: ${err.message}`,
        stderr: stderr.trim() || undefined,
      })
    })
    child.once('close', (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          error: `SSH exited with code ${code} while reading ${plan.remoteEndpointPath}`,
          stderr: stderr.trim() || undefined,
        })
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as Partial<EndpointDescriptor>
        if (
          !parsed ||
          typeof parsed.agentPort !== 'number' ||
          !Number.isInteger(parsed.agentPort) ||
          parsed.agentPort < 1 ||
          parsed.agentPort > 65535 ||
          typeof parsed.agentToken !== 'string' ||
          !parsed.agentToken.trim()
        ) {
          finish({
            ok: false,
            error: 'Remote endpoint JSON is missing valid agentPort or agentToken',
            stderr: stderr.trim() || undefined,
          })
          return
        }
        finish({
          ok: true,
          endpoint: {
            port: typeof parsed.port === 'number' && Number.isInteger(parsed.port) ? parsed.port : 0,
            httpEndpoint: typeof parsed.httpEndpoint === 'string' ? parsed.httpEndpoint : '',
            webSocketDebuggerUrlHint:
              typeof parsed.webSocketDebuggerUrlHint === 'string' ? parsed.webSocketDebuggerUrlHint : '',
            ...(typeof parsed.remoteCdpUrl === 'string' ? { remoteCdpUrl: parsed.remoteCdpUrl } : {}),
            pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
            version: typeof parsed.version === 'string' ? parsed.version : '0.1.0',
            startedAt:
              typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
            engine: parsed.engine === 'chromium' ? 'chromium' : 'lite',
            agentPort: parsed.agentPort,
            agentToken: parsed.agentToken,
            ...(typeof parsed.agentWsEndpoint === 'string'
              ? { agentWsEndpoint: parsed.agentWsEndpoint }
              : {}),
            profileDir: typeof parsed.profileDir === 'string' ? parsed.profileDir : '',
          },
        })
      } catch (err) {
        finish({
          ok: false,
          error: `Failed to parse remote endpoint JSON: ${err instanceof Error ? err.message : String(err)}`,
          stderr: stderr.trim() || undefined,
        })
      }
    })
  })
}

/**
 * Write a local 0o600 tunneled endpoint descriptor pointing to 127.0.0.1:<localPort>
 * with the discovered remote agentToken so local `troy-advanced` CLI / MCP clients can connect directly.
 */
export function writeTunneledEndpointFile(
  remoteEndpoint: EndpointDescriptor,
  localAgentPort: number,
  outFile?: string,
  localCdpPort?: number,
): { file: string; descriptor: Omit<EndpointDescriptor, 'pid'> } {
  validatePort(localAgentPort, 'local agent')
  const cdpPort = localCdpPort !== undefined ? validatePort(localCdpPort, 'local CDP') : 0
  const file = outFile ? path.resolve(outFile) : defaultEndpointPath()
  // Intentionally omit `pid` so local `readLiveEndpoint` does not reject the remote daemon's PID
  // after the short-lived `ec2 tunnel` CLI exits.
  const descriptor: Omit<EndpointDescriptor, 'pid'> = {
    port: cdpPort,
    httpEndpoint: cdpPort > 0 ? `http://127.0.0.1:${cdpPort}` : '',
    webSocketDebuggerUrlHint: cdpPort > 0 ? `http://127.0.0.1:${cdpPort}/json/version` : '',
    version: remoteEndpoint.version || '0.1.0',
    startedAt: new Date().toISOString(),
    engine: remoteEndpoint.engine,
    agentPort: localAgentPort,
    agentToken: remoteEndpoint.agentToken,
    agentWsEndpoint: `ws://127.0.0.1:${localAgentPort}/ws`,
    profileDir: remoteEndpoint.profileDir || '',
  }
  writeEndpoint(file, descriptor as EndpointDescriptor)
  return { file, descriptor }
}

/**
 * Spawn `ssh` directly (no shell) to establish the loopback tunnel.
 * - In background mode (`-f`), waits for `ssh` to daemonize (exit 0) and optionally verifies local ports.
 * - In foreground mode, runs until `ssh` exits or SIGINT/SIGTERM terminates it.
 */
export async function establishEc2Tunnel(
  plan: Ec2TunnelPlan,
  opts: EstablishTunnelOptions = {},
): Promise<EstablishTunnelResult> {
  const spawnImpl = opts.spawnFn ?? spawn
  const probePort = opts.probePortFn ?? waitForLocalPort
  const timeoutMs = opts.timeoutMs ?? 15_000
  const mode: 'background' | 'foreground' = plan.security.background ? 'background' : 'foreground'

  return new Promise<EstablishTunnelResult>((resolve) => {
    let stderr = ''
    let settled = false

    const finish = (res: EstablishTunnelResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolve(res)
    }

    let child: ChildProcess
    try {
      child = spawnImpl(plan.sshBinary, plan.args, {
        stdio: mode === 'background' ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
      } as SpawnOptions)
    } catch (err) {
      finish({
        ok: false,
        mode,
        error: `Failed to launch ${plan.sshBinary}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }

    const onSignal = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    if (mode === 'foreground') {
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
    }

    const timer =
      mode === 'background'
        ? setTimeout(() => {
            try {
              child.kill('SIGTERM')
            } catch {
              // ignore
            }
            finish({
              ok: false,
              mode,
              pid: child.pid,
              stderr: stderr.trim() || undefined,
              error: `Timed out after ${timeoutMs}ms waiting for background SSH tunnel to establish`,
            })
          }, timeoutMs)
        : null

    child.stdout?.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stderr += text
      opts.onStderr?.(text)
    })

    child.once('error', (err) => {
      finish({
        ok: false,
        mode,
        pid: child.pid,
        stderr: stderr.trim() || undefined,
        error: `SSH process error: ${err.message}`,
      })
    })

    child.once('close', async (code, signal) => {
      if (timer) clearTimeout(timer)
      if (mode === 'background') {
        if (code !== 0) {
          finish({
            ok: false,
            mode,
            pid: child.pid,
            exitCode: code,
            signal,
            stderr: stderr.trim() || undefined,
            error: `SSH background tunnel exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
          })
          return
        }
        const verifiedPorts: number[] = []
        if (opts.verifyPort !== false) {
          for (const fwd of plan.forwards) {
            const ready = await probePort(fwd.localPort, Math.min(3000, timeoutMs))
            if (ready) verifiedPorts.push(fwd.localPort)
          }
        }
        finish({
          ok: true,
          mode,
          pid: child.pid,
          exitCode: code,
          signal,
          verifiedPorts,
          stderr: stderr.trim() || undefined,
        })
        return
      }

      const cleanSignalStop = signal === 'SIGINT' || signal === 'SIGTERM'
      finish({
        ok: code === 0 || cleanSignalStop,
        mode,
        pid: child.pid,
        exitCode: code,
        signal,
        stderr: stderr.trim() || undefined,
        ...(code !== 0 && !cleanSignalStop
          ? { error: `SSH tunnel exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}` }
          : {}),
      })
    })
  })
}

/**
 * Render a clean strict 7-bit ASCII guide & summary for `troy-advanced ec2 tunnel`.
 */
export function formatEc2TunnelAscii(
  plan: Ec2TunnelPlan,
  extras?: {
    discoveredEndpoint?: EndpointDescriptor
    writtenEndpointFile?: string
    connected?: EstablishTunnelResult
  },
): string {
  const lines: string[] = [
    '+======================================================================+',
    '|                TROY ADVANCED - EC2 SSH LOOPBACK TUNNEL               |',
    '+======================================================================+',
    `  Target        : ${plan.target.destination}${plan.target.sshPort ? ` (ssh port ${plan.target.sshPort})` : ''}`,
    `  Mode          : ${plan.security.background ? 'background (-f)' : 'foreground (Ctrl+C to close)'}`,
    `  Security      : 127.0.0.1 loopback-only | ExitOnForwardFailure=yes | StrictHostKey=${plan.security.strictHostKey}`,
    `  Keepalive     : ${plan.security.keepaliveSec > 0 ? `${plan.security.keepaliveSec}s x ${plan.security.keepaliveCount}` : 'disabled'}`,
  ]
  if (plan.security.jumpHost) {
    lines.push(`  Jump Host     : ${plan.security.jumpHost}`)
  }
  if (plan.security.identityFile) {
    lines.push(`  Identity Key  : ${plan.security.identityFile}`)
  }

  lines.push('')
  lines.push('  Port Forwards (Loopback Only):')
  for (const fwd of plan.forwards) {
    const tag = fwd.label === 'agent' ? 'Agent Socket' : 'Chrome CDP  '
    lines.push(`    - ${tag}: 127.0.0.1:${fwd.localPort}  --->  ${plan.target.destination} -> 127.0.0.1:${fwd.remotePort}`)
  }

  lines.push('')
  lines.push('  SSH Command:')
  lines.push(`    ${plan.command}`)

  if (plan.agentUrl) {
    lines.push('')
    lines.push('  Discover Remote Port & Token (run locally):')
    lines.push(`    ${plan.remoteDiscoverCommand}`)
  }

  if (extras?.discoveredEndpoint) {
    lines.push('')
    lines.push(
      `  Discovered    : remote agentPort=${extras.discoveredEndpoint.agentPort} engine=${extras.discoveredEndpoint.engine}`,
    )
  }
  if (extras?.writtenEndpointFile) {
    lines.push(`  Endpoint File : ${extras.writtenEndpointFile} (mode 0600)`)
  }

  lines.push('')
  lines.push('  Next Steps:')
  if (!extras?.connected) {
    lines.push(`    1. Run the SSH command above, or re-run with --connect to start it now.`)
  }
  if (plan.agentUrl) {
    if (extras?.writtenEndpointFile) {
      lines.push(`    - Query tunneled daemon: troy-advanced --endpoint ${shellQuoteArg(extras.writtenEndpointFile)} status`)
    } else {
      lines.push(`    - Verify health probe  : curl -s ${plan.agentUrl}/healthz`)
      lines.push(
        `    - Auto-bind locally    : troy-advanced ec2 tunnel ${plan.target.raw} --discover --write-endpoint ~/.config/troy-advanced/ec2-endpoint.json --connect --background`,
      )
    }
  }
  if (plan.cdpUrl) {
    lines.push(`    - Drive remote Chrome  : troy-advanced daemon start --cdp-url ${plan.cdpUrl}`)
  }

  if (extras?.connected) {
    lines.push('')
    const status = extras.connected.ok ? 'ESTABLISHED' : 'FAILED'
    const portsNote =
      extras.connected.verifiedPorts && extras.connected.verifiedPorts.length > 0
        ? ` (verified ports: ${extras.connected.verifiedPorts.join(', ')})`
        : ''
    lines.push(`  Tunnel Status : ${status} [${extras.connected.mode}]${portsNote}`)
    if (extras.connected.error) {
      lines.push(`  Error         : ${extras.connected.error}`)
    }
  }

  lines.push('+======================================================================+')
  return sanitizeAscii(lines.join('\n'))
}
