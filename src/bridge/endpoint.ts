// Atomic owner-only (0o600) agent-endpoint.json lifecycle.
// Supports both troy-advanced's native path and optional compatibility mirroring
// to Troy's standard endpoint path so Dexter / Claude Code / troy CLI discover it seamlessly.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EndpointDescriptor } from '../types.js'

export function defaultEndpointPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TROY_ADVANCED_ENDPOINT_FILE?.trim()) return env.TROY_ADVANCED_ENDPOINT_FILE.trim()
  if (env.TROY_ENDPOINT_FILE?.trim()) return env.TROY_ENDPOINT_FILE.trim()
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'troy-advanced', 'agent-endpoint.json')
  }
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'troy-advanced', 'agent-endpoint.json')
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'troy-advanced', 'agent-endpoint.json')
}

export function troyCompatEndpointPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Troy', 'agent-endpoint.json')
  }
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Troy', 'agent-endpoint.json')
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Troy', 'agent-endpoint.json')
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function writeEndpoint(file: string, descriptor: EndpointDescriptor): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function clearEndpoint(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // ignore
  }
}

export function readLiveEndpoint(explicitFile?: string): { endpoint: EndpointDescriptor & { file: string } } | null {
  const candidates = explicitFile ? [explicitFile] : [defaultEndpointPath(), troyCompatEndpointPath()]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EndpointDescriptor
      if (parsed && parsed.agentPort && parsed.agentToken) {
        if (typeof parsed.pid === 'number' && !pidAlive(parsed.pid)) continue
        return { endpoint: { ...parsed, file } }
      }
    } catch {
      // skip missing/corrupt
    }
  }
  return null
}
