// Daemon lifecycle for running Troy Advanced persistently on an EC2 instance or terminal session.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  CrashRecoveryOptions,
  DialogPolicyOptions,
  DownloadPolicyOptions,
  EmulationOptions,
  EngineKind,
  TrackerBlockingOptions,
} from '../types.js'
import { BrowserManager } from '../engine/manager.js'
import { createAgentSocket } from '../bridge/agent-socket.js'
import {
  clearEndpoint,
  defaultEndpointPath,
  pidAlive,
  readLiveEndpoint,
  troyCompatEndpointPath,
  writeEndpoint,
} from '../bridge/endpoint.js'

export interface DaemonOptions {
  engine?: EngineKind
  port?: number
  cdpPort?: number
  remoteCdpPort?: number
  cdpUrl?: string
  profileDir?: string
  endpointFile?: string
  compatTroy?: boolean
  initialUrl?: string
  trackerBlocking?: TrackerBlockingOptions
  emulation?: EmulationOptions
  crashRecovery?: CrashRecoveryOptions
  downloads?: DownloadPolicyOptions
  dialogs?: DialogPolicyOptions
}

export async function runDaemonForeground(opts: DaemonOptions = {}): Promise<void> {
  const manager = await BrowserManager.create({
    engine: opts.engine ?? 'auto',
    profileDir: opts.profileDir,
    cdpPort: opts.cdpPort,
    remoteCdpPort: opts.remoteCdpPort,
    cdpUrl: opts.cdpUrl,
    trackerBlocking: opts.trackerBlocking,
    emulation: opts.emulation,
    crashRecovery: opts.crashRecovery,
    downloads: opts.downloads,
    dialogs: opts.dialogs,
  })

  if (opts.initialUrl) {
    await manager.openTab(opts.initialUrl, { activate: true })
  }

  const socket = await createAgentSocket(manager, { port: opts.port ?? 0 })
  const endpointFile = opts.endpointFile || defaultEndpointPath()
  const compatFile = opts.compatTroy ? troyCompatEndpointPath() : null

  const startedAt = new Date().toISOString()
  const buildDescriptor = () => {
    const remoteCdp = manager.engine.getRemoteCdpInfo ? manager.engine.getRemoteCdpInfo() : null
    const httpEndpoint = remoteCdp
      ? (remoteCdp.httpBaseUrl ?? '')
      : manager.engine.cdpPort
        ? `http://127.0.0.1:${manager.engine.cdpPort}`
        : ''
    const webSocketDebuggerUrlHint = remoteCdp
      ? remoteCdp.httpBaseUrl
        ? `${remoteCdp.httpBaseUrl}/json/list`
        : remoteCdp.displayUrl
      : manager.engine.cdpPort
        ? `http://127.0.0.1:${manager.engine.cdpPort}/json/list`
        : ''
    return {
      port: manager.engine.cdpPort,
      httpEndpoint,
      webSocketDebuggerUrlHint,
      ...(remoteCdp ? { remoteCdpUrl: remoteCdp.displayUrl } : {}),
      pid: process.pid,
      version: '0.1.0',
      startedAt,
      engine: manager.engine.kind,
      agentPort: socket.port,
      agentToken: socket.token,
      profileDir: manager.profileDir,
    }
  }

  const syncEndpoints = () => {
    const descriptor = buildDescriptor()
    writeEndpoint(endpointFile, descriptor)
    if (compatFile && compatFile !== endpointFile) {
      writeEndpoint(compatFile, descriptor)
    }
  }

  syncEndpoints()

  const offCrashSync = manager.onEvent((ev) => {
    if (ev.type === 'chromium_recovered') {
      syncEndpoints()
    }
  })

  console.log(
    JSON.stringify({
      ok: true,
      event: 'daemon_ready',
      pid: process.pid,
      engine: manager.engine.kind,
      agentPort: socket.port,
      cdpPort: manager.engine.cdpPort,
      ...(manager.engine.remoteCdpUrl ? { remoteCdpUrl: manager.engine.remoteCdpUrl } : {}),
      endpointFile,
      ...(compatFile ? { compatFile } : {}),
    }),
  )

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    offCrashSync()
    clearEndpoint(endpointFile)
    if (compatFile && compatFile !== endpointFile) clearEndpoint(compatFile)
    await socket.close().catch(() => {})
    await manager.close().catch(() => {})
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // Keep event loop alive until signaled
  await new Promise(() => {})
}

export async function startDaemonDetached(binPath: string, opts: DaemonOptions = {}): Promise<{ ok: boolean; pid?: number; endpoint?: unknown; error?: string }> {
  const existing = readLiveEndpoint(opts.endpointFile)
  if (existing) {
    return { ok: true, pid: existing.endpoint.pid, endpoint: existing.endpoint }
  }

  const endpointFile = opts.endpointFile || defaultEndpointPath()
  const logFile = path.join(path.dirname(endpointFile), 'daemon.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const outFd = fs.openSync(logFile, 'a')

  const args = [binPath, 'daemon', 'run']
  if (opts.engine) args.push('--engine', opts.engine)
  if (opts.port) args.push('--port', String(opts.port))
  if (opts.cdpPort) args.push('--cdp-port', String(opts.cdpPort))
  if (opts.remoteCdpPort) args.push('--remote-cdp-port', String(opts.remoteCdpPort))
  if (opts.cdpUrl) args.push('--cdp-url', opts.cdpUrl)
  if (opts.profileDir) args.push('--profile', opts.profileDir)
  if (opts.endpointFile) args.push('--endpoint', opts.endpointFile)
  if (opts.compatTroy) args.push('--compat-troy')
  if (opts.initialUrl) args.push('--url', opts.initialUrl)
  if (opts.trackerBlocking?.enabled === false) args.push('--no-block-trackers')
  if (opts.trackerBlocking?.mode) args.push('--tracker-mode', opts.trackerBlocking.mode)
  if (opts.crashRecovery?.enabled === false) args.push('--no-crash-recovery')
  if (opts.crashRecovery?.maxRestarts !== undefined) args.push('--max-restarts', String(opts.crashRecovery.maxRestarts))
  if (opts.downloads?.mode) args.push('--download-mode', opts.downloads.mode)
  if (opts.downloads?.maxBytes !== undefined) args.push('--download-max-bytes', String(opts.downloads.maxBytes))
  if (opts.dialogs?.mode) args.push('--dialog-mode', opts.dialogs.mode)
  if (opts.dialogs?.defaultPromptText !== undefined) {
    args.push('--dialog-prompt-text', opts.dialogs.defaultPromptText)
  }
  if (opts.dialogs?.acceptBeforeUnload === false) {
    args.push('--dialog-dismiss-beforeunload')
  }
  if (opts.emulation?.viewport) {
    const vp = opts.emulation.viewport
    if (typeof vp === 'string') {
      args.push('--viewport', vp)
    } else if (typeof vp === 'object') {
      const scale = vp.deviceScaleFactor && vp.deviceScaleFactor !== 1 ? `@${vp.deviceScaleFactor}` : ''
      const mob = vp.mobile ? 'm' : ''
      args.push('--viewport', `${vp.width}x${vp.height}${scale}${mob}`)
    }
  }
  if (opts.emulation?.userAgent) args.push('--user-agent', opts.emulation.userAgent)
  if (opts.emulation?.acceptLanguage) args.push('--accept-language', opts.emulation.acceptLanguage)
  if (opts.emulation?.platform) args.push('--platform', opts.emulation.platform)
  if (opts.emulation?.extraHeaders) {
    for (const [k, v] of Object.entries(opts.emulation.extraHeaders)) {
      args.push('--header', `${k}: ${v}`)
    }
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', outFd, outFd],
  })
  child.unref()

  // Wait up to 15s for endpoint file to appear with this pid
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const live = readLiveEndpoint(opts.endpointFile)
    if (live && live.endpoint.pid === child.pid) {
      return { ok: true, pid: child.pid, endpoint: live.endpoint }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return { ok: false, error: `Daemon did not publish endpoint within 15s. Check ${logFile}` }
}

export function stopDaemon(endpointFile?: string): { ok: boolean; stoppedPid?: number; error?: string } {
  const live = readLiveEndpoint(endpointFile)
  if (!live) return { ok: true, error: 'no running daemon found' }
  const pid = live.endpoint.pid
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (err) {
      return { ok: false, error: String((err as Error).message) }
    }
  }
  clearEndpoint(live.endpoint.file)
  return { ok: true, stoppedPid: pid }
}
