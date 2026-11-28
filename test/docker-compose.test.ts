import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  renderDockerComposeYaml,
  validateDockerComposeFile,
  validateDockerComposeYaml,
} from '../src/cloud/docker-compose.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker-compose.yml')
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile')
const DOCKERIGNORE = path.join(REPO_ROOT, '.dockerignore')
const ENV_EXAMPLE = path.join(REPO_ROOT, 'deploy', '.env.example')
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'troy-advanced.mjs')

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-compose-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('EC2 docker-compose.yml deployment (M86)', () => {
  it('repository docker-compose.yml passes all production-safety checks with zero errors/warnings', () => {
    expect(fs.existsSync(COMPOSE_FILE)).toBe(true)
    const res = validateDockerComposeFile(COMPOSE_FILE)
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.warnings).toEqual([])
    expect(res.summary).toEqual({
      hasService: true,
      hasPersistentVolume: true,
      hasHealthcheck: true,
      hasReadinessProbe: true,
      hasShmSize: true,
      hasInit: true,
      hasLoopbackNetworking: true,
      hasNoNewPrivileges: true,
      hasSsrfGuard: true,
      exposesPublicPorts: false,
    })

    const raw = fs.readFileSync(COMPOSE_FILE, 'utf8')
    expect(raw).toContain('troy_profile_data:/data')
    expect(raw).toContain('--profile')
    expect(raw).toContain('/data/profile')
    expect(raw).toContain('--endpoint')
    expect(raw).toContain('/data/agent-endpoint.json')
    expect(raw).toContain('http://127.0.0.1:${TROY_AGENT_PORT:-9333}/readyz')
    expect(raw).toContain('restart: unless-stopped')
  })

  it('Dockerfile, .dockerignore, and deploy/.env.example are aligned for EC2 Docker builds', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
    expect(dockerfile).toContain('curl')
    expect(dockerfile).toContain('HEALTHCHECK')
    expect(dockerfile).toContain('/readyz')
    expect(dockerfile).toContain('"/data"')

    const dockerignore = fs.readFileSync(DOCKERIGNORE, 'utf8')
    expect(dockerignore).toContain('node_modules')
    expect(dockerignore).toContain('.git')
    expect(dockerignore).toContain('dist')

    const envExample = fs.readFileSync(ENV_EXAMPLE, 'utf8')
    expect(envExample).toContain('TROY_AGENT_PORT=9333')
    expect(envExample).toContain('TROY_ENGINE=auto')
    expect(envExample).toContain('TROY_POLICY=standard')
    expect(envExample).toContain('TROY_SHM_SIZE=1gb')
  })

  it('renderDockerComposeYaml produces valid hardened Compose manifests for default and custom options', () => {
    const defaultYaml = renderDockerComposeYaml()
    const defaultValidation = validateDockerComposeYaml(defaultYaml)
    expect(defaultValidation.ok).toBe(true)
    expect(defaultValidation.errors).toEqual([])
    expect(defaultValidation.warnings).toEqual([])

    const customYaml = renderDockerComposeYaml({
      serviceName: 'troy-prod',
      containerName: 'troy-prod-01',
      port: 9444,
      engine: 'chromium',
      policy: 'strict',
      shmSize: '2gb',
      bindHostDir: '/var/lib/troy-advanced',
      readonly: true,
      publicMetrics: true,
      untrustedMarkers: true,
      redactSecrets: true,
      allowOrigins: ['https://example.com'],
      denyOrigins: ['https://evil.example'],
      memoryLimit: '2G',
      cpus: 2,
      timezone: 'America/New_York',
    })

    const customValidation = validateDockerComposeYaml(customYaml)
    expect(customValidation.ok).toBe(true)
    expect(customValidation.errors).toEqual([])
    expect(customValidation.warnings).toEqual([])

    expect(customYaml).toContain('troy-prod:')
    expect(customYaml).toContain('${TROY_AGENT_PORT:-9444}')
    expect(customYaml).toContain('${TROY_ENGINE:-chromium}')
    expect(customYaml).toContain('${TROY_POLICY:-strict}')
    expect(customYaml).toContain('${TROY_SHM_SIZE:-2gb}')
    expect(customYaml).toContain('/var/lib/troy-advanced:/data')
    expect(customYaml).toContain('--readonly')
    expect(customYaml).toContain('--public-metrics')
    expect(customYaml).toContain('--untrusted-markers')
    expect(customYaml).toContain('--redact-secrets')
    expect(customYaml).toContain('https://example.com')
    expect(customYaml).toContain('https://evil.example')
    expect(customYaml).toContain('memory: 2G')
    expect(customYaml).toContain('cpus: "2"')
    expect(customYaml).toContain('TZ: ${TZ:-America/New_York}')
    // Host bind-mount does not need a top-level named volumes section.
    expect(customYaml).not.toMatch(/^volumes:/m)
  })

  it('renderDockerComposeYaml rejects invalid ports, engines, policies, and identifiers', () => {
    expect(() => renderDockerComposeYaml({ port: 0 })).toThrow(/Invalid port/)
    expect(() => renderDockerComposeYaml({ port: 70000 })).toThrow(/Invalid port/)
    expect(() => renderDockerComposeYaml({ engine: 'webkit' as 'auto' })).toThrow(/Invalid engine/)
    expect(() => renderDockerComposeYaml({ policy: 'yolo' as 'standard' })).toThrow(/Invalid policy/)
    expect(() => renderDockerComposeYaml({ shmSize: 'huge' })).toThrow(/Invalid shmSize/)
    expect(() => renderDockerComposeYaml({ serviceName: '../bad' })).toThrow(/Invalid serviceName/)
    expect(() => renderDockerComposeYaml({ volumeName: 'bad volume' })).toThrow(/Invalid volumeName/)
  })

  it('validateDockerComposeYaml catches missing volume, missing healthcheck, public port exposure, and hardening warnings', () => {
    const insecureYaml = `
services:
  troy:
    image: troy-advanced:latest
    ports:
      - "9333:9333"
`
    const res = validateDockerComposeYaml(insecureYaml)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        'missing_persistent_volume',
        'missing_healthcheck',
        'public_port_exposure',
      ]),
    )
    expect(res.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'missing_shm_size',
        'missing_init',
        'missing_no_new_privileges',
        'missing_ssrf_guard',
      ]),
    )
  })

  it('validateDockerComposeYaml flags healthcheck missing readiness probe', () => {
    const badHealthYaml = `
services:
  troy:
    image: troy-advanced:latest
    network_mode: host
    volumes:
      - troy_data:/data
    healthcheck:
      test: ["CMD-SHELL", "echo ok"]
volumes:
  troy_data:
`
    const res = validateDockerComposeYaml(badHealthYaml)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.code)).toContain('missing_readiness_probe')
  })

  it('CLI ec2 compose --validate and --write work end-to-end', () => {
    // Build must already exist or we test against dist via bin/troy-advanced.mjs only if dist exists.
    if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'cli.js'))) return

    const validateOut = execFileSync(
      process.execPath,
      [BIN_PATH, 'ec2', 'compose', '--validate', COMPOSE_FILE, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const parsed = JSON.parse(validateOut) as { ok: boolean; errors: unknown[]; warnings: unknown[] }
    expect(parsed.ok).toBe(true)
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])

    const tmpDir = makeTempDir()
    const outFile = path.join(tmpDir, 'docker-compose.ec2.yml')
    const writeOut = execFileSync(
      process.execPath,
      [
        BIN_PATH,
        'ec2',
        'compose',
        '--port',
        '9555',
        '--policy',
        'strict',
        '--readonly',
        '--write',
        outFile,
        '--json',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const writeParsed = JSON.parse(writeOut) as { ok: boolean; file: string; bytes: number }
    expect(writeParsed.ok).toBe(true)
    expect(writeParsed.file).toBe(outFile)
    expect(writeParsed.bytes).toBeGreaterThan(200)

    const revalidated = validateDockerComposeFile(outFile)
    expect(revalidated.ok).toBe(true)
    expect(revalidated.errors).toEqual([])
  })
})
