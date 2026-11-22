// Daemon lifecycle for running Troy Advanced persistently on an EC2 instance or terminal session.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EngineKind, TrackerBlockingOptions } from '../types.js'
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
  profileDir?: string
  endpointFile?: string
  compatTroy?: boolean
  initialUrl?: string
  trackerBlocking?: TrackerBlockingOptions
}

export async function runDaemonForeground(opts: DaemonOptions = {}): Promise<void> {
  const manager = await BrowserManager.create({
    engine: opts.engine ?? 'auto',
    profileDir: opts.profileDir,
    cdpPort: opts.cdpPort,
    remoteCdpPort: opts.remoteCdpPort,
    trackerBlocking: opts.trackerBlocking,
  })

  if (opts.initialUrl) {
    await manager.openTab(opts.initialUrl, { activate: true })
  }

  const socket = await createAgentSocket(manager, { port: opts.port ?? 0 })
  const endpointFile = opts.endpointFile || defaultEndpointPath()
  const compatFile = opts.compatTroy ? troyCompatEndpointPath() : null

  const descriptor = {
    port: manager.engine.cdpPort,
    httpEndpoint: manager.engine.cdpPort ? `http://127.0.0.1:${manager.engine.cdpPort}` : '',
    webSocketDebuggerUrlHint: manager.engine.cdpPort ? `http://127.0.0.1:${manager.engine.cdpPort}/json/list` : '',
    pid: process.pid,
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    engine: manager.engine.kind,
    agentPort: socket.port,
    agentToken: socket.token,
    profileDir: manager.profileDir,
  }

  writeEndpoint(endpointFile, descriptor)
  if (compatFile && compatFile !== endpointFile) {
    writeEndpoint(compatFile, descriptor)
  }

  console.log(
    JSON.stringify({
      ok: true,
      event: 'daemon_ready',
      pid: process.pid,
      engine: manager.engine.kind,
      agentPort: socket.port,
      cdpPort: manager.engine.cdpPort,
      endpointFile,
      ...(compatFile ? { compatFile } : {}),
    }),
  )

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
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
  if (opts.profileDir) args.push('--profile', opts.profileDir)
  if (opts.endpointFile) args.push('--endpoint', opts.endpointFile)
  if (opts.compatTroy) args.push('--compat-troy')
  if (opts.initialUrl) args.push('--url', opts.initialUrl)
  if (opts.trackerBlocking?.enabled === false) args.push('--no-block-trackers')
  if (opts.trackerBlocking?.mode) args.push('--tracker-mode', opts.trackerBlocking.mode)

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
