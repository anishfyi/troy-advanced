// Docker Compose generator and production-safety validator for one-command EC2 deployments.
// Produces hardened loopback-only Compose files with persistent profile volumes,
// /readyz healthchecks, /dev/shm sizing for Chromium, and SSRF protection.

import fs from 'node:fs'
import type { EngineKind, PolicyProfileName } from '../types.js'
import { DEFAULT_AGENT_PORT } from './ec2-tunnel.js'

export const DEFAULT_COMPOSE_SERVICE_NAME = 'troy-advanced'
export const DEFAULT_COMPOSE_IMAGE = 'troy-advanced:latest'
export const DEFAULT_COMPOSE_VOLUME_NAME = 'troy_profile_data'
export const DEFAULT_COMPOSE_DATA_DIR = '/data'
export const DEFAULT_COMPOSE_SHM_SIZE = '1gb'

const VALID_ENGINES = new Set<EngineKind>(['auto', 'chromium', 'lite'])
const VALID_POLICIES = new Set<PolicyProfileName>(['strict', 'standard', 'permissive'])
const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_SHM_SIZE_RE = /^[1-9][0-9]*(?:b|k|kb|m|mb|g|gb)$/i

export interface DockerComposeOptions {
  serviceName?: string
  containerName?: string
  image?: string
  port?: number
  engine?: EngineKind
  policy?: PolicyProfileName
  shmSize?: string
  volumeName?: string
  /** Optional host directory to bind-mount at /data instead of a named Docker volume. */
  bindHostDir?: string
  compatTroy?: boolean
  blockPrivateNet?: boolean
  readonly?: boolean
  publicMetrics?: boolean
  untrustedMarkers?: boolean
  redactSecrets?: boolean
  allowOrigins?: string[]
  denyOrigins?: string[]
  memoryLimit?: string
  cpus?: string | number
  timezone?: string
}

export interface DockerComposeValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
}

export interface DockerComposeValidationResult {
  ok: boolean
  errors: DockerComposeValidationIssue[]
  warnings: DockerComposeValidationIssue[]
  summary: {
    hasService: boolean
    hasPersistentVolume: boolean
    hasHealthcheck: boolean
    hasReadinessProbe: boolean
    hasShmSize: boolean
    hasInit: boolean
    hasLoopbackNetworking: boolean
    hasNoNewPrivileges: boolean
    hasSsrfGuard: boolean
    exposesPublicPorts: boolean
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${port}": must be an integer between 1 and 65535`)
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER_RE.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_IDENTIFIER_RE.source}`)
  }
}

function assertSafeShmSize(value: string): void {
  if (!SAFE_SHM_SIZE_RE.test(value)) {
    throw new Error(`Invalid shmSize "${value}": expected e.g. "512m" or "1gb"`)
  }
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9._/:${}-]+$/.test(value)) return value
  return JSON.stringify(value)
}

/**
 * Render a hardened EC2 `docker-compose.yml` manifest for Troy Advanced.
 */
export function renderDockerComposeYaml(opts: DockerComposeOptions = {}): string {
  const serviceName = opts.serviceName ?? DEFAULT_COMPOSE_SERVICE_NAME
  const containerName = opts.containerName ?? serviceName
  const image = opts.image ?? DEFAULT_COMPOSE_IMAGE
  const port = opts.port ?? DEFAULT_AGENT_PORT
  const engine: EngineKind = opts.engine ?? 'auto'
  const policy: PolicyProfileName = opts.policy ?? 'standard'
  const shmSize = opts.shmSize ?? DEFAULT_COMPOSE_SHM_SIZE
  const volumeName = opts.volumeName ?? DEFAULT_COMPOSE_VOLUME_NAME
  const compatTroy = opts.compatTroy !== false
  const blockPrivateNet = opts.blockPrivateNet !== false
  const timezone = opts.timezone ?? 'UTC'

  assertSafeIdentifier(serviceName, 'serviceName')
  assertSafeIdentifier(containerName, 'containerName')
  assertValidPort(port)
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(`Invalid engine "${engine}": expected auto, chromium, or lite`)
  }
  if (!VALID_POLICIES.has(policy)) {
    throw new Error(`Invalid policy "${policy}": expected strict, standard, or permissive`)
  }
  assertSafeShmSize(shmSize)
  if (!opts.bindHostDir) {
    assertSafeIdentifier(volumeName, 'volumeName')
  }

  const commandArgs: string[] = [
    'daemon',
    'run',
    '--engine',
    `\${TROY_ENGINE:-${engine}}`,
    '--port',
    `\${TROY_AGENT_PORT:-${port}}`,
    '--profile',
    `${DEFAULT_COMPOSE_DATA_DIR}/profile`,
    '--endpoint',
    `${DEFAULT_COMPOSE_DATA_DIR}/agent-endpoint.json`,
  ]
  if (compatTroy) commandArgs.push('--compat-troy')
  if (blockPrivateNet) commandArgs.push('--block-private-net')
  commandArgs.push('--policy', `\${TROY_POLICY:-${policy}}`)
  if (opts.readonly) commandArgs.push('--readonly')
  if (opts.publicMetrics) commandArgs.push('--public-metrics')
  if (opts.untrustedMarkers) commandArgs.push('--untrusted-markers')
  if (opts.redactSecrets) commandArgs.push('--redact-secrets')
  for (const origin of opts.allowOrigins ?? []) {
    const trimmed = origin.trim()
    if (trimmed) commandArgs.push('--allow-origin', trimmed)
  }
  for (const origin of opts.denyOrigins ?? []) {
    const trimmed = origin.trim()
    if (trimmed) commandArgs.push('--deny-origin', trimmed)
  }

  const volumeMount = opts.bindHostDir
    ? `${opts.bindHostDir}:${DEFAULT_COMPOSE_DATA_DIR}`
    : `${volumeName}:${DEFAULT_COMPOSE_DATA_DIR}`

  const lines: string[] = [
    '# One-command EC2 deployment for Troy Advanced (headless ASCII/CDP AI browser).',
    '#',
    '# Quick start on any Linux EC2 instance (x86_64 or Graviton ARM64):',
    '#   docker compose up -d',
    '#   docker compose ps',
    `#   curl -s http://127.0.0.1:\${TROY_AGENT_PORT:-${port}}/readyz`,
    '',
    'services:',
    `  ${serviceName}:`,
    '    build:',
    '      context: .',
    '      dockerfile: Dockerfile',
    `    image: \${TROY_IMAGE:-${image}}`,
    `    container_name: \${TROY_CONTAINER_NAME:-${containerName}}`,
    '    restart: unless-stopped',
    '    init: true',
    `    shm_size: \${TROY_SHM_SIZE:-${shmSize}}`,
    '    network_mode: host',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    environment:',
    '      NODE_ENV: production',
    '      TROY_CHROME_BIN: /usr/bin/chromium',
    `      TROY_ADVANCED_ENDPOINT_FILE: ${DEFAULT_COMPOSE_DATA_DIR}/agent-endpoint.json`,
    `      XDG_CONFIG_HOME: ${DEFAULT_COMPOSE_DATA_DIR}/config`,
    `      TZ: \${TZ:-${timezone}}`,
    '    command:',
    ...commandArgs.map((arg) => `      - ${yamlScalar(arg)}`),
    '    volumes:',
    `      - ${yamlScalar(volumeMount)}`,
    '    healthcheck:',
    '      test:',
    '        - CMD-SHELL',
    `        - curl -fsS "http://127.0.0.1:\${TROY_AGENT_PORT:-${port}}/readyz" >/dev/null || exit 1`,
    '      interval: 15s',
    '      timeout: 5s',
    '      retries: 5',
    '      start_period: 20s',
  ]

  if (opts.memoryLimit || opts.cpus !== undefined) {
    lines.push('    deploy:')
    lines.push('      resources:')
    lines.push('        limits:')
    if (opts.cpus !== undefined) {
      lines.push(`          cpus: "${String(opts.cpus)}"`)
    }
    if (opts.memoryLimit) {
      lines.push(`          memory: ${yamlScalar(opts.memoryLimit)}`)
    }
  }

  lines.push(
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
  )

  if (!opts.bindHostDir) {
    lines.push('', 'volumes:', `  ${volumeName}:`, '    driver: local')
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Strip YAML comments (lines starting with `#`) while preserving indentation and structure.
 */
function stripCommentLines(yamlText: string): string {
  return yamlText
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * Validate a `docker-compose.yml` manifest against Troy Advanced's EC2 production checklist.
 */
export function validateDockerComposeYaml(yamlText: string): DockerComposeValidationResult {
  const active = stripCommentLines(yamlText)
  const errors: DockerComposeValidationIssue[] = []
  const warnings: DockerComposeValidationIssue[] = []

  const hasService = /^\s*services:\s*$/m.test(active) && /^\s{2}[a-zA-Z0-9._-]+:\s*$/m.test(active)
  const hasVolumeMount =
    /^\s*volumes:\s*$/m.test(active) &&
    /^\s*-\s*['"]?[^:\s'"]+:(?:\/data|\/root\/\.config\/troy-advanced)/m.test(active)
  const hasTopLevelVolume = /^volumes:\s*$/m.test(active)
  const hasPersistentVolume = hasVolumeMount && (hasTopLevelVolume || /^\s*-\s*['"]?(?:\.|\/|~)/m.test(active))
  const hasHealthcheck = /^\s*healthcheck:\s*$/m.test(active) && /^\s*test:/m.test(active)
  const hasReadinessProbe = /\/(?:readyz|healthz|livez)\b/.test(active)
  const hasShmSize = /^\s*shm_size:\s*\S+/m.test(active)
  const hasInit = /^\s*init:\s*true\b/m.test(active)
  const hasLoopbackNetworking =
    /^\s*network_mode:\s*['"]?host['"]?\s*$/m.test(active) ||
    /^\s*-\s*['"]?127\.0\.0\.1:\d+:\d+['"]?\s*$/m.test(active)
  const hasNoNewPrivileges = /no-new-privileges:true/.test(active)
  const hasSsrfGuard = /--block-private-net/.test(active)

  // Detect public port bindings like `"9333:9333"` or `"0.0.0.0:9333:9333"` (not bound to 127.0.0.1).
  const exposesPublicPorts =
    /^\s*-\s*['"]?(?:0\.0\.0\.0:)?\d+:\d+['"]?\s*$/m.test(active) &&
    !/^\s*-\s*['"]?127\.0\.0\.1:/m.test(active)

  if (!hasService) {
    errors.push({
      severity: 'error',
      code: 'missing_service',
      message: 'Compose file must define a top-level services block with at least one service.',
    })
  }
  if (!hasPersistentVolume) {
    errors.push({
      severity: 'error',
      code: 'missing_persistent_volume',
      message: 'Compose file must mount a persistent profile volume at /data or /root/.config/troy-advanced.',
    })
  }
  if (!hasHealthcheck) {
    errors.push({
      severity: 'error',
      code: 'missing_healthcheck',
      message: 'Compose file must configure a container healthcheck.',
    })
  } else if (!hasReadinessProbe) {
    errors.push({
      severity: 'error',
      code: 'missing_readiness_probe',
      message: 'Healthcheck should probe the Agent Socket /readyz or /healthz endpoint.',
    })
  }
  if (exposesPublicPorts) {
    errors.push({
      severity: 'error',
      code: 'public_port_exposure',
      message: 'Agent Socket port must not be published on 0.0.0.0; bind to 127.0.0.1 or use network_mode: host.',
    })
  }

  if (!hasShmSize) {
    warnings.push({
      severity: 'warning',
      code: 'missing_shm_size',
      message: 'Set shm_size (e.g. 1gb) to prevent Chromium /dev/shm renderer crashes on EC2.',
    })
  }
  if (!hasInit) {
    warnings.push({
      severity: 'warning',
      code: 'missing_init',
      message: 'Set init: true so Chromium child processes are reaped cleanly.',
    })
  }
  if (!hasNoNewPrivileges) {
    warnings.push({
      severity: 'warning',
      code: 'missing_no_new_privileges',
      message: 'Add security_opt: [no-new-privileges:true] for container hardening.',
    })
  }
  if (!hasSsrfGuard) {
    warnings.push({
      severity: 'warning',
      code: 'missing_ssrf_guard',
      message: 'Pass --block-private-net on EC2 deployments to block AWS IMDS (169.254.169.254) SSRF.',
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      hasService,
      hasPersistentVolume,
      hasHealthcheck,
      hasReadinessProbe,
      hasShmSize,
      hasInit,
      hasLoopbackNetworking,
      hasNoNewPrivileges,
      hasSsrfGuard,
      exposesPublicPorts,
    },
  }
}

export function validateDockerComposeFile(filePath: string): DockerComposeValidationResult {
  const content = fs.readFileSync(filePath, 'utf8')
  return validateDockerComposeYaml(content)
}
