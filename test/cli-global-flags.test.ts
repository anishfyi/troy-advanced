import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLI_EXIT_CODES,
  CliExitError,
  CliRuntime,
  classifyErrorExitCode,
  classifyResponseExitCode,
  exitCodeToCategory,
  handleTopLevelCliError,
  parseTimeoutMs,
  resolveCliRuntime,
} from '../src/cli-runtime.js'
import { SsrfBlockedError } from '../src/agent/ssrf.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { writeEndpoint } from '../src/bridge/endpoint.js'
import { CLI_COMPLETION_SPEC } from '../src/completions.js'

const execFileAsync = promisify(execFile)
const BIN_PATH = path.resolve('bin/troy-advanced.mjs')
const DIST_CLI = path.resolve('dist/cli.js')

const tmpDirs: string[] = []
const cleanupFns: Array<() => Promise<void> | void> = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-cli-flags-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const fn = cleanupFns.pop()!
    await fn()
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function runCliSubprocess(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN_PATH, ...args], {
      timeout: 15_000,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

describe('cli-runtime unit tests (M96)', () => {
  it('defines canonical exit codes 0, 1, 2, 3 and categories', () => {
    expect(CLI_EXIT_CODES.OK).toBe(0)
    expect(CLI_EXIT_CODES.ERROR).toBe(1)
    expect(CLI_EXIT_CODES.POLICY_REFUSAL).toBe(2)
    expect(CLI_EXIT_CODES.DAEMON_OFFLINE).toBe(3)

    expect(exitCodeToCategory(0)).toBe('ok')
    expect(exitCodeToCategory(1)).toBe('error')
    expect(exitCodeToCategory(2)).toBe('policy_refusal')
    expect(exitCodeToCategory(3)).toBe('daemon_offline')
  })

  it('parses --timeout values in ms, s, and m and rejects invalid inputs', () => {
    expect(parseTimeoutMs(undefined)).toEqual({ ok: true, timeoutMs: undefined })
    expect(parseTimeoutMs(false)).toEqual({ ok: true, timeoutMs: undefined })
    expect(parseTimeoutMs('5000')).toEqual({ ok: true, timeoutMs: 5000 })
    expect(parseTimeoutMs(250)).toEqual({ ok: true, timeoutMs: 250 })
    expect(parseTimeoutMs('500ms')).toEqual({ ok: true, timeoutMs: 500 })
    expect(parseTimeoutMs('5s')).toEqual({ ok: true, timeoutMs: 5000 })
    expect(parseTimeoutMs('1.5s')).toEqual({ ok: true, timeoutMs: 1500 })
    expect(parseTimeoutMs('2m')).toEqual({ ok: true, timeoutMs: 120_000 })

    expect(parseTimeoutMs(true).ok).toBe(false)
    expect(parseTimeoutMs('').ok).toBe(false)
    expect(parseTimeoutMs('abc').ok).toBe(false)
    expect(parseTimeoutMs('0').ok).toBe(false)
    expect(parseTimeoutMs('-100').ok).toBe(false)
    expect(parseTimeoutMs('99999999').ok).toBe(false)
  })

  it('classifies responses into clean exit codes (0 ok, 1 error, 2 policy refusal, 3 daemon offline)', () => {
    expect(classifyResponseExitCode({ ok: true })).toBe(CLI_EXIT_CODES.OK)
    expect(classifyResponseExitCode({ ok: false, error: 'boom' })).toBe(CLI_EXIT_CODES.ERROR)
    expect(classifyResponseExitCode({ ok: false, code: 'timeout', error: 'timed out' })).toBe(
      CLI_EXIT_CODES.ERROR,
    )

    // Policy refusals -> 2
    expect(classifyResponseExitCode({ ok: false, status: 'blocked', code: 'readonly' })).toBe(
      CLI_EXIT_CODES.POLICY_REFUSAL,
    )
    expect(classifyResponseExitCode({ ok: false, status: 'boundary', code: 'origin' })).toBe(
      CLI_EXIT_CODES.POLICY_REFUSAL,
    )
    expect(classifyResponseExitCode({ ok: false, code: 'ssrf', error: 'blocked' })).toBe(
      CLI_EXIT_CODES.POLICY_REFUSAL,
    )
    expect(classifyResponseExitCode({ ok: false, code: 'sensitive' })).toBe(
      CLI_EXIT_CODES.POLICY_REFUSAL,
    )
    expect(classifyResponseExitCode({ ok: false, code: 'submit' })).toBe(
      CLI_EXIT_CODES.POLICY_REFUSAL,
    )
    expect(classifyResponseExitCode({ ok: false, error: 'forbidden' }, 403)).toBe(
      CLI_EXIT_CODES.POLICY_REFUSAL,
    )

    // Daemon offline -> 3
    expect(classifyResponseExitCode({ ok: false, code: 'daemon_offline' })).toBe(
      CLI_EXIT_CODES.DAEMON_OFFLINE,
    )
    expect(classifyResponseExitCode({ ok: false, running: false })).toBe(
      CLI_EXIT_CODES.DAEMON_OFFLINE,
    )
    expect(classifyResponseExitCode({ ok: false, error: 'troy-advanced daemon is not running' })).toBe(
      CLI_EXIT_CODES.DAEMON_OFFLINE,
    )
  })

  it('classifies thrown errors accurately', () => {
    expect(classifyErrorExitCode(new Error('generic'))).toBe(CLI_EXIT_CODES.ERROR)
    expect(
      classifyErrorExitCode(
        new SsrfBlockedError({
          category: 'imds',
          url: 'http://169.254.169.254/',
          reason: 'IMDS blocked',
        }),
      ),
    ).toBe(CLI_EXIT_CODES.POLICY_REFUSAL)

    const connRefused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' }),
    })
    expect(classifyErrorExitCode(connRefused)).toBe(CLI_EXIT_CODES.DAEMON_OFFLINE)

    const timeoutErr = new CliExitError('timed out', {
      exitCode: CLI_EXIT_CODES.ERROR,
      code: 'timeout',
    })
    expect(classifyErrorExitCode(timeoutErr)).toBe(CLI_EXIT_CODES.ERROR)
  })

  it('respects quiet/verbose precedence and redacts sensitive metadata in debug logs', () => {
    const out: string[] = []
    const err: string[] = []
    const verboseRt = new CliRuntime({
      verbose: true,
      io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    })
    verboseRt.out('hello')
    verboseRt.debug('rpc', { route: '/tabs', agentToken: 'super-secret-token', password: 'pw' })
    expect(out).toEqual(['hello'])
    expect(err.length).toBe(1)
    expect(err[0]).toContain('[troy-advanced +')
    expect(err[0]).toContain('route=/tabs')
    expect(err[0]).toContain('agentToken=[REDACTED]')
    expect(err[0]).toContain('password=[REDACTED]')
    expect(err[0]).not.toContain('super-secret-token')

    // Quiet wins over verbose
    const qOut: string[] = []
    const qErr: string[] = []
    const quietRt = new CliRuntime({
      quiet: true,
      verbose: true,
      io: { stdout: (l) => qOut.push(l), stderr: (l) => qErr.push(l) },
    })
    expect(quietRt.verbosity).toBe('quiet')
    quietRt.out('suppressed')
    quietRt.json({ a: 1 })
    quietRt.error('suppressed err')
    quietRt.errorJson({ ok: false })
    quietRt.debug('suppressed debug')
    expect(qOut).toEqual([])
    expect(qErr).toEqual([])
  })

  it('enforces withTimeout and clears timer cleanly', async () => {
    const rt = new CliRuntime({ timeoutMs: 40 })
    const fast = await rt.withTimeout(Promise.resolve('done'), 'fast-op')
    expect(fast).toBe('done')

    await expect(
      rt.withTimeout(new Promise((r) => setTimeout(() => r('late'), 500)), 'slow-op'),
    ).rejects.toMatchObject({
      name: 'CliExitError',
      exitCode: CLI_EXIT_CODES.ERROR,
      code: 'timeout',
    })
  })

  it('formats top-level CLI errors via handleTopLevelCliError', () => {
    const lines: string[] = []
    const code = handleTopLevelCliError(
      new CliExitError('offline', { exitCode: CLI_EXIT_CODES.DAEMON_OFFLINE, code: 'daemon_offline' }),
      { verbose: true, stderr: (l) => lines.push(l) },
    )
    expect(code).toBe(3)
    expect(lines[0]).toContain('"code": "daemon_offline"')
    expect(lines[1]).toContain('exit=3 (daemon_offline)')

    const silentLines: string[] = []
    const silentCode = handleTopLevelCliError(new Error('fail'), {
      quiet: true,
      stderr: (l) => silentLines.push(l),
    })
    expect(silentCode).toBe(1)
    expect(silentLines).toEqual([])
  })

  it('registers --quiet, --verbose, and --timeout in shell completions spec', () => {
    const names = new Set(CLI_COMPLETION_SPEC.globalFlags.map((f) => f.name))
    expect(names.has('quiet')).toBe(true)
    expect(names.has('verbose')).toBe(true)
    expect(names.has('timeout')).toBe(true)

    const resolved = resolveCliRuntime({ quiet: false, verbose: true, timeout: '2s' })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.runtime.timeoutMs).toBe(2000)
      expect(resolved.runtime.verbose).toBe(true)
    }
  })
})

describe('CLI global flags & exit codes E2E (M96)', () => {
  it('exits 3 (daemon offline) when endpoint file is missing, and suppresses output with --quiet', async () => {
    if (!fs.existsSync(DIST_CLI)) return
    const missingEndpoint = path.join(makeTmpDir(), 'missing-endpoint.json')

    const res = await runCliSubprocess(['tabs', '--endpoint', missingEndpoint])
    expect(res.exitCode).toBe(CLI_EXIT_CODES.DAEMON_OFFLINE)
    expect(res.stderr).toContain('"code": "daemon_offline"')

    const quietRes = await runCliSubprocess(['tabs', '-q', '--endpoint', missingEndpoint])
    expect(quietRes.exitCode).toBe(CLI_EXIT_CODES.DAEMON_OFFLINE)
    expect(quietRes.stdout).toBe('')
    expect(quietRes.stderr).toBe('')

    const statusRes = await runCliSubprocess(['daemon', 'status', '--endpoint', missingEndpoint])
    expect(statusRes.exitCode).toBe(CLI_EXIT_CODES.DAEMON_OFFLINE)
    expect(statusRes.stdout).toContain('"running": false')
  })

  it('exits 3 (daemon offline) when endpoint points to an unreachable closed port', async () => {
    if (!fs.existsSync(DIST_CLI)) return
    // Grab an ephemeral unused port by opening and immediately closing a server
    const closedPort = await new Promise<number>((resolve, reject) => {
      const srv = http.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })

    const endpointFile = path.join(makeTmpDir(), 'stale-endpoint.json')
    writeEndpoint(endpointFile, {
      agentPort: closedPort,
      agentToken: 'dead-token-12345',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })

    const res = await runCliSubprocess(['tabs', '--endpoint', endpointFile])
    expect(res.exitCode).toBe(CLI_EXIT_CODES.DAEMON_OFFLINE)
    expect(res.stderr).toContain('"code": "daemon_offline"')
  })

  it('exits 0 on ok, 2 on policy refusal (readonly), and supports --quiet and --verbose', async () => {
    if (!fs.existsSync(DIST_CLI)) return
    const dir = makeTmpDir()
    const endpointFile = path.join(dir, 'agent-endpoint.json')

    const manager = await BrowserManager.create({
      engine: 'lite',
      profileDir: dir,
      readonly: { enabled: true },
    })
    const socket = await createAgentSocket(manager, { port: 0 })
    writeEndpoint(endpointFile, {
      agentPort: socket.port,
      agentToken: socket.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })
    cleanupFns.push(async () => {
      await socket.close()
      await manager.close()
    })

    // 1. OK + --verbose: stdout is clean JSON, stderr has trace, token is never leaked
    const okVerbose = await runCliSubprocess(['tabs', '--verbose', '--endpoint', endpointFile])
    expect(okVerbose.exitCode).toBe(CLI_EXIT_CODES.OK)
    const parsedTabs = JSON.parse(okVerbose.stdout) as { ok: boolean }
    expect(parsedTabs.ok).toBe(true)
    expect(okVerbose.stderr).toContain('POST /tabs -> 200')
    expect(okVerbose.stderr).not.toContain(socket.token)

    // 2. OK + --quiet: exit 0 with completely empty stdout and stderr
    const okQuiet = await runCliSubprocess(['tabs', '--quiet', '--endpoint', endpointFile])
    expect(okQuiet.exitCode).toBe(CLI_EXIT_CODES.OK)
    expect(okQuiet.stdout).toBe('')
    expect(okQuiet.stderr).toBe('')

    // 3. Policy refusal (readonly blocks mutating open) -> exit 2
    const refused = await runCliSubprocess(['open', 'https://example.com', '--endpoint', endpointFile])
    expect(refused.exitCode).toBe(CLI_EXIT_CODES.POLICY_REFUSAL)
    expect(refused.stdout).toContain('"code": "readonly"')

    // 4. Policy refusal + --quiet -> exit 2, empty stdout & stderr
    const refusedQuiet = await runCliSubprocess([
      'open',
      'https://example.com',
      '-q',
      '--endpoint',
      endpointFile,
    ])
    expect(refusedQuiet.exitCode).toBe(CLI_EXIT_CODES.POLICY_REFUSAL)
    expect(refusedQuiet.stdout).toBe('')
    expect(refusedQuiet.stderr).toBe('')
  })

  it('exits 1 on --timeout expiration against a slow daemon and on invalid --timeout', async () => {
    if (!fs.existsSync(DIST_CLI)) return

    // Invalid --timeout
    const badTimeout = await runCliSubprocess(['tabs', '--timeout', 'not-a-duration'])
    expect(badTimeout.exitCode).toBe(CLI_EXIT_CODES.ERROR)
    expect(badTimeout.stderr).toContain('Invalid --timeout')

    // Slow mock daemon server that delays 600ms
    const slowServer = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, tabs: [] }))
      }, 600)
    })
    const slowPort = await new Promise<number>((resolve) => {
      slowServer.listen(0, '127.0.0.1', () => {
        const addr = slowServer.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    cleanupFns.push(
      () =>
        new Promise<void>((resolve) => {
          slowServer.close(() => resolve())
        }),
    )

    const endpointFile = path.join(makeTmpDir(), 'slow-endpoint.json')
    writeEndpoint(endpointFile, {
      agentPort: slowPort,
      agentToken: 'slow-test-token',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })

    const timedOut = await runCliSubprocess([
      'tabs',
      '--timeout',
      '60',
      '--endpoint',
      endpointFile,
    ])
    expect(timedOut.exitCode).toBe(CLI_EXIT_CODES.ERROR)
    expect(timedOut.stderr).toContain('"code": "timeout"')
  })
})
