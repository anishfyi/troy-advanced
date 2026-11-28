// EC2, Docker, SSH, and local terminal environment diagnostics (`troy-advanced doctor`).

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { findChromeBinary } from '../engine/chromium.js'
import { defaultEndpointPath, readLiveEndpoint } from '../bridge/endpoint.js'
import { probeEc2ImdsV2, type Ec2ImdsMetadata, type ImdsProbeOptions } from './imds.js'

export interface DoctorOptions {
  /** IMDSv2 probe options (e.g. skip, baseUrl, timeoutMs). */
  imds?: ImdsProbeOptions
}

export interface DoctorReport {
  nodeVersion: string
  platform: string
  arch: string
  cpus: number
  totalMemMb: number
  freeMemMb: number
  isTTY: boolean
  term: string
  sshSession: boolean
  ec2Hint: boolean
  ec2Imds: Ec2ImdsMetadata | null
  chromeBinary: string | null
  chromeVersion: string | null
  devShmMb: number | null
  systemdAvailable: boolean
  endpointFile: string
  daemonRunning: boolean
  daemonPid: number | null
  recommendedEngine: 'chromium' | 'lite'
  warnings: string[]
}

function detectDevShmMb(): number | null {
  if (process.platform !== 'linux') return null
  try {
    const out = execSync('df -m /dev/shm | tail -n 1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const parts = out.trim().split(/\s+/)
    const size = Number(parts[1])
    return Number.isFinite(size) ? size : null
  } catch {
    return null
  }
}

function detectEc2Hint(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const uuid = fs.readFileSync('/sys/hypervisor/uuid', 'utf8').trim().toLowerCase()
    if (uuid.startsWith('ec2')) return true
  } catch {
    // ignore
  }
  try {
    const vendor = fs.readFileSync('/sys/devices/virtual/dmi/id/sys_vendor', 'utf8').toLowerCase()
    if (vendor.includes('amazon ec2')) return true
  } catch {
    // ignore
  }
  return false
}

function detectChromeVersion(bin: string | null): string | null {
  if (!bin) return null
  try {
    return execSync(`"${bin}" --version`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function buildDoctorReport(ec2Imds: Ec2ImdsMetadata | null): DoctorReport {
  const chromeBinary = findChromeBinary()
  const chromeVersion = detectChromeVersion(chromeBinary)
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024))
  const freeMemMb = Math.round(os.freemem() / (1024 * 1024))
  const devShmMb = detectDevShmMb()
  const live = readLiveEndpoint()
  const warnings: string[] = []
  const localEc2Hint = detectEc2Hint()
  const ec2Hint = localEc2Hint || Boolean(ec2Imds?.available)

  if (!chromeBinary) {
    warnings.push('No Chrome/Chromium binary found. troy-advanced will run on the zero-dependency Lite engine (no JS/screenshots). Run deploy/ec2-bootstrap.sh to install Chromium.')
  }
  if (devShmMb !== null && devShmMb < 128) {
    warnings.push(`/dev/shm is small (${devShmMb}MB). troy-advanced automatically passes --disable-dev-shm-usage for stability.`)
  }
  if (totalMemMb < 1024) {
    warnings.push(`Low RAM (${totalMemMb}MB). Consider --engine lite or adding swap on small EC2 instances.`)
  }
  if (localEc2Hint && ec2Imds && !ec2Imds.available) {
    if (ec2Imds.status === 'timeout') {
      warnings.push(
        'EC2 environment detected but IMDSv2 timed out. If running inside Docker on EC2, set HttpPutResponseHopLimit=2 on instance metadata options.',
      )
    } else if (ec2Imds.status === 'disabled') {
      warnings.push('EC2 environment detected but IMDSv2 is disabled (HTTP 403 or AWS_EC2_METADATA_DISABLED).')
    }
  }

  let systemdAvailable = false
  if (process.platform === 'linux') {
    try {
      execSync('command -v systemctl', { stdio: 'ignore' })
      systemdAvailable = true
    } catch {
      systemdAvailable = false
    }
  }

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemMb,
    freeMemMb,
    isTTY: Boolean(process.stdout.isTTY),
    term: process.env.TERM || 'dumb',
    sshSession: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
    ec2Hint,
    ec2Imds,
    chromeBinary,
    chromeVersion,
    devShmMb,
    systemdAvailable,
    endpointFile: defaultEndpointPath(),
    daemonRunning: Boolean(live),
    daemonPid: live?.endpoint.pid ?? null,
    recommendedEngine: chromeBinary && totalMemMb >= 768 ? 'chromium' : 'lite',
    warnings,
  }
}

export function runDoctor(): DoctorReport {
  return buildDoctorReport(null)
}

export async function runDoctorAsync(options: DoctorOptions = {}): Promise<DoctorReport> {
  const ec2Imds = await probeEc2ImdsV2(options.imds)
  return buildDoctorReport(ec2Imds)
}

export function formatDoctorAscii(report: DoctorReport): string {
  const lines = [
    '+----------------------------------------------------------------------+',
    '| TROY-ADVANCED ENVIRONMENT DOCTOR                                     |',
    '+----------------------------------------------------------------------+',
    `  Node.js       : ${report.nodeVersion} (${report.platform}/${report.arch}, ${report.cpus} CPUs)`,
    `  Memory        : ${report.freeMemMb}MB free / ${report.totalMemMb}MB total`,
    `  Terminal      : TERM=${report.term} | TTY=${report.isTTY} | SSH=${report.sshSession} | EC2=${report.ec2Hint}`,
  ]
  if (report.ec2Imds) {
    if (report.ec2Imds.available) {
      const parts = [
        report.ec2Imds.instanceType ?? 'unknown-type',
        report.ec2Imds.region ?? 'unknown-region',
        report.ec2Imds.availabilityZone ? `AZ ${report.ec2Imds.availabilityZone}` : 'AZ unknown',
      ]
      lines.push(`  EC2 IMDSv2    : ${parts.join(' | ')} (${report.ec2Imds.latencyMs}ms)`)
      if (report.ec2Imds.instanceId || report.ec2Imds.amiId) {
        const idParts = [
          report.ec2Imds.instanceId,
          report.ec2Imds.amiId ? `(${report.ec2Imds.amiId})` : null,
        ].filter(Boolean)
        lines.push(`  EC2 Instance  : ${idParts.join(' ')}`)
      }
    } else {
      lines.push(`  EC2 IMDSv2    : not available (${report.ec2Imds.status})`)
    }
  }
  lines.push(
    `  Chromium      : ${report.chromeBinary ? `${report.chromeBinary} (${report.chromeVersion ?? 'detected'})` : 'not installed (lite engine ready)'}`,
    `  /dev/shm      : ${report.devShmMb !== null ? `${report.devShmMb}MB` : 'n/a'}`,
    `  systemd       : ${report.systemdAvailable ? 'available' : 'unavailable'}`,
    `  Recommended   : --engine ${report.recommendedEngine}`,
    `  Daemon        : ${report.daemonRunning ? `RUNNING (pid ${report.daemonPid})` : 'stopped'}`,
    `  Endpoint file : ${report.endpointFile}`,
  )
  if (report.warnings.length > 0) {
    lines.push('  Warnings:')
    for (const w of report.warnings) lines.push(`    ! ${w}`)
  }
  lines.push('+----------------------------------------------------------------------+')
  return lines.join('\n')
}
