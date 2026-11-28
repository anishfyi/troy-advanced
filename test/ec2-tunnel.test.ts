import { EventEmitter } from 'node:events'
import { execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_PORT,
  DEFAULT_LOCAL_CDP_PORT,
  DEFAULT_REMOTE_CDP_PORT,
  buildEc2TunnelPlan,
  discoverRemoteEndpoint,
  establishEc2Tunnel,
  formatEc2TunnelAscii,
  formatSshCommand,
  parseSshTarget,
  shellQuoteArg,
  waitForLocalPort,
  writeTunneledEndpointFile,
} from '../src/cloud/ec2-tunnel.js'
import { readLiveEndpoint } from '../src/bridge/endpoint.js'

const tempDirs: string[] = []
function makeTempDir(prefix = 'troy-ec2-tunnel-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function createMockChild(behavior: {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  emitError?: Error
  delayMs?: number
}): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  ;(emitter as unknown as { stdout: PassThrough }).stdout = stdout
  ;(emitter as unknown as { stderr: PassThrough }).stderr = stderr
  ;(emitter as unknown as { pid: number }).pid = 42424
  emitter.kill = (() => true) as ChildProcess['kill']

  setTimeout(() => {
    if (behavior.emitError) {
      emitter.emit('error', behavior.emitError)
      return
    }
    if (behavior.stdout) stdout.write(behavior.stdout)
    if (behavior.stderr) stderr.write(behavior.stderr)
    stdout.end()
    stderr.end()
    emitter.emit('close', behavior.exitCode ?? 0, behavior.signal ?? null)
  }, behavior.delayMs ?? 10)

  return emitter
}

describe('ec2-tunnel: parseSshTarget', () => {
  it('parses user@host, host-only, host:port, ssh://, and IPv6 targets', () => {
    expect(parseSshTarget('ec2-user@203.0.113.10')).toEqual({
      raw: 'ec2-user@203.0.113.10',
      user: 'ec2-user',
      host: '203.0.113.10',
      destination: 'ec2-user@203.0.113.10',
    })

    expect(parseSshTarget('my-ec2.internal')).toEqual({
      raw: 'my-ec2.internal',
      host: 'my-ec2.internal',
      destination: 'my-ec2.internal',
    })

    expect(parseSshTarget('ubuntu@ec2-1-2-3-4.compute-1.amazonaws.com:2222')).toEqual({
      raw: 'ubuntu@ec2-1-2-3-4.compute-1.amazonaws.com:2222',
      user: 'ubuntu',
      host: 'ec2-1-2-3-4.compute-1.amazonaws.com',
      sshPort: 2222,
      destination: 'ubuntu@ec2-1-2-3-4.compute-1.amazonaws.com',
    })

    expect(parseSshTarget('ssh://admin@10.0.1.5:2200/')).toEqual({
      raw: 'ssh://admin@10.0.1.5:2200/',
      user: 'admin',
      host: '10.0.1.5',
      sshPort: 2200,
      destination: 'admin@10.0.1.5',
    })

    expect(parseSshTarget('ubuntu@[2001:db8::1]:2222')).toEqual({
      raw: 'ubuntu@[2001:db8::1]:2222',
      user: 'ubuntu',
      host: '2001:db8::1',
      sshPort: 2222,
      destination: 'ubuntu@2001:db8::1',
    })
  })

  it('rejects empty, option-injection, shell-metacharacter, and invalid port targets', () => {
    const badTargets = [
      '',
      '   ',
      '-oProxyCommand=id',
      '-Jevil@host',
      'ec2-user@host;rm -rf /',
      'ec2-user@host|cat /etc/passwd',
      'ec2-user@host$(id)',
      'ec2-user@host`id`',
      'ec2-user@host with spaces',
      'http://ec2-user@host',
      'ssh://ec2-user@host/extra/path',
      'ec2-user@host:0',
      'ec2-user@host:70000',
      'ec2-user@host:abc',
      '-baduser@host',
      'ec2-user@-badhost',
      'ubuntu@[2001:db8::1',
    ]
    for (const target of badTargets) {
      expect(() => parseSshTarget(target), `expected "${target}" to throw`).toThrow()
    }
  })
})

describe('ec2-tunnel: buildEc2TunnelPlan', () => {
  it('builds a secure loopback-only agent socket forwarding plan by default', () => {
    const plan = buildEc2TunnelPlan({ target: 'ec2-user@203.0.113.10' })

    expect(plan.ok).toBe(true)
    expect(plan.sshBinary).toBe('ssh')
    expect(plan.forwards).toEqual([
      {
        label: 'agent',
        bindHost: '127.0.0.1',
        localPort: DEFAULT_AGENT_PORT,
        remoteHost: '127.0.0.1',
        remotePort: DEFAULT_AGENT_PORT,
        spec: `127.0.0.1:${DEFAULT_AGENT_PORT}:127.0.0.1:${DEFAULT_AGENT_PORT}`,
      },
    ])
    expect(plan.agentUrl).toBe(`http://127.0.0.1:${DEFAULT_AGENT_PORT}`)
    expect(plan.cdpUrl).toBeUndefined()
    expect(plan.args).toContain('-N')
    expect(plan.args).toContain('-T')
    expect(plan.args).toContain('ExitOnForwardFailure=yes')
    expect(plan.args).toContain('ServerAliveInterval=30')
    expect(plan.args).toContain('ServerAliveCountMax=3')
    expect(plan.args).toContain('StrictHostKeyChecking=accept-new')
    expect(plan.args).toContain(`127.0.0.1:${DEFAULT_AGENT_PORT}:127.0.0.1:${DEFAULT_AGENT_PORT}`)
    // Ensure `--` immediately precedes destination to block option injection
    expect(plan.args.slice(-2)).toEqual(['--', 'ec2-user@203.0.113.10'])
    expect(plan.security.loopbackOnly).toBe(true)
    expect(plan.security.exitOnForwardFailure).toBe(true)
    expect(plan.command).toContain('-L 127.0.0.1:9333:127.0.0.1:9333')
    expect(plan.remoteDiscoverCommand).toContain('agent-endpoint.json')
  })

  it('supports combined agent + CDP forwarding, cdpOnly, custom ports, identity, jump host, and background mode', () => {
    const plan = buildEc2TunnelPlan({
      target: 'ubuntu@198.51.100.7:2222',
      localPort: 19333,
      remotePort: 9444,
      forwardCdp: true,
      localCdpPort: 19222,
      remoteCdpPort: 9222,
      identityFile: '/home/dev/my keys/ec2.pem',
      jumpHost: 'bastion@jump.example.com:2200',
      background: true,
      batchMode: true,
      strictHostKey: 'yes',
      keepaliveSec: 15,
      keepaliveCount: 5,
    })

    expect(plan.forwards).toHaveLength(2)
    expect(plan.agentUrl).toBe('http://127.0.0.1:19333')
    expect(plan.cdpUrl).toBe('http://127.0.0.1:19222')
    expect(plan.args).toContain('-f')
    expect(plan.args).toContain('-p')
    expect(plan.args).toContain('2222')
    expect(plan.args).toContain('-i')
    expect(plan.args).toContain('/home/dev/my keys/ec2.pem')
    expect(plan.args).toContain('-J')
    expect(plan.args).toContain('bastion@jump.example.com:2200')
    expect(plan.args).toContain('BatchMode=yes')
    expect(plan.args).toContain('StrictHostKeyChecking=yes')
    expect(plan.args).toContain('ServerAliveInterval=15')
    expect(plan.args).toContain('ServerAliveCountMax=5')
    // Identity path with space must be shell-quoted in printable command
    expect(plan.command).toContain("'/home/dev/my keys/ec2.pem'")

    const cdpOnlyPlan = buildEc2TunnelPlan({
      target: 'ec2-user@chrome-node',
      cdpOnly: true,
    })
    expect(cdpOnlyPlan.forwards).toEqual([
      {
        label: 'cdp',
        bindHost: '127.0.0.1',
        localPort: DEFAULT_LOCAL_CDP_PORT,
        remoteHost: '127.0.0.1',
        remotePort: DEFAULT_REMOTE_CDP_PORT,
        spec: `127.0.0.1:${DEFAULT_LOCAL_CDP_PORT}:127.0.0.1:${DEFAULT_REMOTE_CDP_PORT}`,
      },
    ])
    expect(cdpOnlyPlan.agentUrl).toBeUndefined()
    expect(cdpOnlyPlan.cdpUrl).toBe(`http://127.0.0.1:${DEFAULT_LOCAL_CDP_PORT}`)
  })

  it('rejects local port collisions and invalid options', () => {
    expect(() =>
      buildEc2TunnelPlan({
        target: 'ec2-user@host',
        localPort: 19222,
        forwardCdp: true,
        localCdpPort: 19222,
      }),
    ).toThrow(/collision/i)

    expect(() =>
      buildEc2TunnelPlan({
        target: 'ec2-user@host',
        identityFile: '-bad-key',
      }),
    ).toThrow(/must not start with "-"/)

    expect(() =>
      buildEc2TunnelPlan({
        target: 'ec2-user@host',
        strictHostKey: 'invalid' as 'yes',
      }),
    ).toThrow(/strict-host-key/i)

    expect(() =>
      buildEc2TunnelPlan({
        target: 'ec2-user@host',
        keepaliveSec: -1,
      }),
    ).toThrow(/keepalive/i)
  })

  it('shell-quotes arguments safely', () => {
    expect(shellQuoteArg('ec2-user@10.0.0.1')).toBe('ec2-user@10.0.0.1')
    expect(shellQuoteArg("/tmp/it's a key.pem")).toBe("'/tmp/it'\\''s a key.pem'")
    expect(formatSshCommand('ssh', ['-i', '/tmp/my key.pem', '--', 'ec2-user@host'])).toBe(
      "ssh -i '/tmp/my key.pem' -- ec2-user@host",
    )
  })
})

describe('ec2-tunnel: discoverRemoteEndpoint & writeTunneledEndpointFile', () => {
  it('parses remote agent-endpoint.json from ssh output and writes 0600 local tunneled endpoint', async () => {
    const plan = buildEc2TunnelPlan({ target: 'ec2-user@203.0.113.10' })
    const remoteJson = JSON.stringify({
      version: '0.1.0',
      port: 9222,
      httpEndpoint: 'http://127.0.0.1:9222',
      webSocketDebuggerUrlHint: 'http://127.0.0.1:9222/json/version',
      agentPort: 9444,
      agentToken: 'tok_remote_secret_123456',
      engine: 'chromium',
      pid: 999999,
      startedAt: '2025-01-01T00:00:00.000Z',
      profileDir: '/home/ec2-user/.troy-advanced/profile',
    })

    const res = await discoverRemoteEndpoint(plan, {
      spawnFn: ((_bin: string, _args: readonly string[], _opts: SpawnOptions) =>
        createMockChild({ stdout: remoteJson, exitCode: 0 })) as unknown as typeof import('node:child_process').spawn,
    })

    expect(res.ok).toBe(true)
    expect(res.endpoint?.agentPort).toBe(9444)
    expect(res.endpoint?.agentToken).toBe('tok_remote_secret_123456')
    expect(res.endpoint?.port).toBe(9222)

    const dir = makeTempDir()
    const outFile = path.join(dir, 'ec2-endpoint.json')
    const written = writeTunneledEndpointFile(res.endpoint!, 19333, outFile, 19222)
    expect(written.file).toBe(outFile)
    expect(written.descriptor.agentPort).toBe(19333)
    expect(written.descriptor.port).toBe(19222)
    expect(written.descriptor.agentToken).toBe('tok_remote_secret_123456')
    expect('pid' in written.descriptor).toBe(false)

    const mode = fs.statSync(outFile).mode & 0o777
    expect(mode).toBe(0o600)

    // Verify local readLiveEndpoint accepts the tunneled endpoint file cleanly
    const loaded = readLiveEndpoint(outFile)
    expect(loaded).not.toBeNull()
    expect(loaded?.endpoint.agentPort).toBe(19333)
    expect(loaded?.endpoint.agentToken).toBe('tok_remote_secret_123456')
  })

  it('handles SSH errors and invalid remote JSON gracefully', async () => {
    const plan = buildEc2TunnelPlan({ target: 'ec2-user@203.0.113.10' })

    const exitFail = await discoverRemoteEndpoint(plan, {
      spawnFn: (() =>
        createMockChild({ exitCode: 255, stderr: 'Permission denied (publickey).' })) as unknown as typeof import('node:child_process').spawn,
    })
    expect(exitFail.ok).toBe(false)
    expect(exitFail.error).toContain('255')
    expect(exitFail.stderr).toContain('Permission denied')

    const badJson = await discoverRemoteEndpoint(plan, {
      spawnFn: (() =>
        createMockChild({ stdout: 'not json', exitCode: 0 })) as unknown as typeof import('node:child_process').spawn,
    })
    expect(badJson.ok).toBe(false)
    expect(badJson.error).toContain('parse')

    const missingFields = await discoverRemoteEndpoint(plan, {
      spawnFn: (() =>
        createMockChild({ stdout: '{"agentPort":9333}', exitCode: 0 })) as unknown as typeof import('node:child_process').spawn,
    })
    expect(missingFields.ok).toBe(false)
    expect(missingFields.error).toContain('agentToken')
  })
})

describe('ec2-tunnel: establishEc2Tunnel & waitForLocalPort', () => {
  it('establishes background tunnel and verifies forwarded local ports', async () => {
    const plan = buildEc2TunnelPlan({
      target: 'ec2-user@203.0.113.10',
      localPort: 19333,
      forwardCdp: true,
      localCdpPort: 19222,
      background: true,
    })

    const probed: number[] = []
    const res = await establishEc2Tunnel(plan, {
      spawnFn: ((bin: string, args: readonly string[]) => {
        expect(bin).toBe('ssh')
        expect(args).toContain('-f')
        return createMockChild({ exitCode: 0 })
      }) as unknown as typeof import('node:child_process').spawn,
      probePortFn: async (port) => {
        probed.push(port)
        return true
      },
    })

    expect(res.ok).toBe(true)
    expect(res.mode).toBe('background')
    expect(res.exitCode).toBe(0)
    expect(probed).toEqual([19333, 19222])
    expect(res.verifiedPorts).toEqual([19333, 19222])
  })

  it('reports failure when ssh exits non-zero or errors', async () => {
    const plan = buildEc2TunnelPlan({ target: 'ec2-user@203.0.113.10', background: true })
    const failed = await establishEc2Tunnel(plan, {
      spawnFn: (() =>
        createMockChild({
          exitCode: 255,
          stderr: 'bind [127.0.0.1]:9333: Address already in use',
        })) as unknown as typeof import('node:child_process').spawn,
    })
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('255')
    expect(failed.stderr).toContain('Address already in use')

    const errored = await establishEc2Tunnel(plan, {
      spawnFn: (() =>
        createMockChild({
          emitError: new Error('ENOENT: ssh not found'),
        })) as unknown as typeof import('node:child_process').spawn,
    })
    expect(errored.ok).toBe(false)
    expect(errored.error).toContain('ENOENT')
  })

  it('handles foreground mode cleanly on exit 0 and SIGINT', async () => {
    const plan = buildEc2TunnelPlan({ target: 'ec2-user@203.0.113.10' })
    const res = await establishEc2Tunnel(plan, {
      spawnFn: (() => createMockChild({ exitCode: null, signal: 'SIGINT' })) as unknown as typeof import('node:child_process').spawn,
    })
    expect(res.ok).toBe(true)
    expect(res.mode).toBe('foreground')
    expect(res.signal).toBe('SIGINT')
  })

  it('waitForLocalPort detects a live loopback TCP listener', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as net.AddressInfo
    try {
      const ready = await waitForLocalPort(addr.port, 1000)
      expect(ready).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('ec2-tunnel: ASCII formatting & CLI integration', () => {
  it('renders strict 7-bit ASCII guide containing target, forwards, and ssh command', () => {
    const plan = buildEc2TunnelPlan({
      target: 'ec2-user@203.0.113.10',
      localPort: 19333,
      remotePort: 9333,
      forwardCdp: true,
      jumpHost: 'bastion@198.51.100.1',
    })
    const ascii = formatEc2TunnelAscii(plan, {
      writtenEndpointFile: '/tmp/ec2-endpoint.json',
      connected: { ok: true, mode: 'background', verifiedPorts: [19333, 19222] },
    })

    // Strict 7-bit ASCII check
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(ascii)).toBe(true)
    expect(ascii).toContain('EC2 SSH LOOPBACK TUNNEL')
    expect(ascii).toContain('ec2-user@203.0.113.10')
    expect(ascii).toContain('127.0.0.1:19333')
    expect(ascii).toContain('127.0.0.1:19222')
    expect(ascii).toContain('bastion@198.51.100.1')
    expect(ascii).toContain('ESTABLISHED [background]')
    expect(ascii).toContain('/tmp/ec2-endpoint.json')
  })

  it('CLI `ec2 tunnel` prints ASCII and JSON plans and supports --discover --write-endpoint --connect', () => {
    const bin = path.resolve(process.cwd(), 'bin', 'troy-advanced.mjs')

    // 1. ASCII dry-run output
    const asciiOut = execFileSync(process.execPath, [bin, 'ec2', 'tunnel', 'ec2-user@203.0.113.10'], {
      encoding: 'utf8',
    })
    expect(asciiOut).toContain('TROY ADVANCED - EC2 SSH LOOPBACK TUNNEL')
    expect(asciiOut).toContain('ssh -N -T -o StrictHostKeyChecking=accept-new')
    expect(asciiOut).toContain('127.0.0.1:9333:127.0.0.1:9333')

    // 2. JSON plan with CDP + custom ports + identity
    const jsonOut = execFileSync(
      process.execPath,
      [
        bin,
        'ec2',
        'tunnel',
        'ubuntu@ec2.example.com:2222',
        '--local-port',
        '19333',
        '--remote-port',
        '9333',
        '--cdp',
        '-i',
        '/tmp/ec2.pem',
        '--json',
      ],
      { encoding: 'utf8' },
    )
    const parsed = JSON.parse(jsonOut)
    expect(parsed.ok).toBe(true)
    expect(parsed.connected).toBe(false)
    expect(parsed.forwards).toHaveLength(2)
    expect(parsed.agentUrl).toBe('http://127.0.0.1:19333')
    expect(parsed.cdpUrl).toBe('http://127.0.0.1:19222')
    expect(parsed.security.identityFile).toBe('/tmp/ec2.pem')

    // 3. End-to-end --discover + --write-endpoint + --connect --background using a fake ssh script
    const dir = makeTempDir()
    const fakeSsh = path.join(dir, 'fake-ssh.sh')
    const endpointOut = path.join(dir, 'tunneled-endpoint.json')
    fs.writeFileSync(
      fakeSsh,
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    cat*)
      echo '{"version":1,"agentPort":9555,"agentToken":"tok_ec2_e2e","engine":"lite","startedAt":1700000000000}'
      exit 0
      ;;
  esac
done
exit 0
`,
      { mode: 0o755 },
    )

    const e2eOut = execFileSync(
      process.execPath,
      [
        bin,
        'ec2',
        'tunnel',
        'ec2-user@203.0.113.10',
        '--local-port',
        '19555',
        '--discover',
        '--write-endpoint',
        endpointOut,
        '--connect',
        '--background',
        '--timeout',
        '300',
        '--ssh-bin',
        fakeSsh,
        '--json',
      ],
      { encoding: 'utf8' },
    )
    const e2e = JSON.parse(e2eOut)
    expect(e2e.ok).toBe(true)
    expect(e2e.connected).toBe(true)
    expect(e2e.discoveredEndpoint.agentPort).toBe(9555)
    expect(e2e.forwards[0].remotePort).toBe(9555)
    expect(e2e.forwards[0].localPort).toBe(19555)
    expect(e2e.writtenEndpointFile).toBe(endpointOut)

    const written = JSON.parse(fs.readFileSync(endpointOut, 'utf8'))
    expect(written.agentPort).toBe(19555)
    expect(written.agentToken).toBe('tok_ec2_e2e')
  })
})
