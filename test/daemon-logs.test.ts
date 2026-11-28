import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RotatingLogWriter,
  clearLogFiles,
  defaultDaemonLogPath,
  followLogFile,
  formatDaemonLogInfoAscii,
  listLogFiles,
  readLogTail,
  rotateIfNeeded,
  rotateLogFile,
  rotatedLogPath,
} from '../src/cloud/daemon-logs.js'

const BIN_PATH = path.resolve(process.cwd(), 'bin', 'troy-advanced.mjs')
const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-daemon-logs-'))
  tempDirs.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('M82: Daemon log rotation & daemon logs CLI', () => {
  it('resolves default daemon.log path next to endpoint file and validates rotatedLogPath', () => {
    const dir = makeTempDir()
    const ep = path.join(dir, 'agent-endpoint.json')
    expect(defaultDaemonLogPath(ep)).toBe(path.join(dir, 'daemon.log'))
    expect(rotatedLogPath(path.join(dir, 'daemon.log'), 1)).toBe(path.join(dir, 'daemon.log.1'))
    expect(() => rotatedLogPath('/tmp/daemon.log', 0)).toThrow()
    expect(() => rotatedLogPath('/tmp/daemon.log', -2)).toThrow()
  })

  it('rotates log files atomically, shifts archives, and prunes beyond maxFiles', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')

    // Non-existent file -> no-op
    expect(rotateLogFile(logFile)).toEqual({
      rotated: false,
      logFile,
      pruned: [],
    })

    // Write gen 1 -> rotate -> .1
    fs.writeFileSync(logFile, 'gen-1\n')
    const r1 = rotateLogFile(logFile, { maxFiles: 2 })
    expect(r1.rotated).toBe(true)
    expect(r1.rotatedTo).toBe(`${logFile}.1`)
    expect(fs.existsSync(logFile)).toBe(false)
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('gen-1\n')

    // Write gen 2 -> rotate -> .1=gen-2, .2=gen-1
    fs.writeFileSync(logFile, 'gen-2\n')
    const r2 = rotateLogFile(logFile, { maxFiles: 2 })
    expect(r2.rotated).toBe(true)
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('gen-2\n')
    expect(fs.readFileSync(`${logFile}.2`, 'utf8')).toBe('gen-1\n')

    // Write gen 3 -> rotate -> .1=gen-3, .2=gen-2, old .2 pruned
    fs.writeFileSync(logFile, 'gen-3\n')
    const r3 = rotateLogFile(logFile, { maxFiles: 2 })
    expect(r3.rotated).toBe(true)
    expect(r3.pruned).toContain(`${logFile}.2`)
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('gen-3\n')
    expect(fs.readFileSync(`${logFile}.2`, 'utf8')).toBe('gen-2\n')
    expect(fs.existsSync(`${logFile}.3`)).toBe(false)

    // Verify 0600 mode on POSIX
    if (process.platform !== 'win32') {
      const mode = fs.statSync(`${logFile}.1`).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('supports maxFiles: 0 by truncating active log and pruning all rotated archives', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    fs.writeFileSync(logFile, 'active-line\n')
    fs.writeFileSync(`${logFile}.1`, 'old-1\n')
    fs.writeFileSync(`${logFile}.2`, 'old-2\n')

    const res = rotateLogFile(logFile, { maxFiles: 0 })
    expect(res.rotated).toBe(true)
    expect(res.rotatedTo).toBeUndefined()
    expect(res.pruned.length).toBe(2)
    expect(fs.readFileSync(logFile, 'utf8')).toBe('')
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
    expect(fs.existsSync(`${logFile}.2`)).toBe(false)
  })

  it('supports copyTruncate rotation while an O_APPEND fd keeps writing to the same inode', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    const fd = fs.openSync(logFile, 'a', 0o600)
    try {
      fs.writeSync(fd, 'before-rotation\n')
      const inoBefore = fs.statSync(logFile).ino

      const res = rotateLogFile(logFile, { maxFiles: 3, copyTruncate: true })
      expect(res.rotated).toBe(true)
      expect(fs.statSync(logFile).ino).toBe(inoBefore)
      expect(fs.readFileSync(logFile, 'utf8')).toBe('')
      expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('before-rotation\n')

      // Continuing to write via O_APPEND fd lands at offset 0 of active daemon.log
      fs.writeSync(fd, 'after-rotation\n')
      expect(fs.readFileSync(logFile, 'utf8')).toBe('after-rotation\n')
    } finally {
      fs.closeSync(fd)
    }
  })

  it('rotateIfNeeded only rotates when file size >= maxBytes', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    fs.writeFileSync(logFile, '12345')

    const skipped = rotateIfNeeded(logFile, { maxBytes: 10, maxFiles: 2 })
    expect(skipped.rotated).toBe(false)
    expect(skipped.sizeBytes).toBe(5)

    fs.appendFileSync(logFile, '67890')
    const rotated = rotateIfNeeded(logFile, { maxBytes: 10, maxFiles: 2 })
    expect(rotated.rotated).toBe(true)
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('1234567890')
  })

  it('RotatingLogWriter enforces maxBytes and tracks rotation stats', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    const writer = new RotatingLogWriter(logFile, { maxBytes: 40, maxFiles: 3 })

    writer.writeLine('line-1-aaaaaaaaaaaa') // 20 bytes
    writer.writeLine('line-2-bbbbbbbbbbbb') // 20 bytes -> 40 bytes total
    const r3 = writer.writeLine('line-3-cccccccccccc') // triggers rotation before write
    expect(r3.rotated).toBe(true)

    writer.writeJson({ event: 'ready', ok: true })
    const stats = writer.getStats()
    expect(stats.rotations).toBeGreaterThanOrEqual(1)
    expect(stats.totalBytesWritten).toBeGreaterThan(60)
    expect(stats.files.length).toBeGreaterThanOrEqual(2)
    expect(stats.files[0]!.active).toBe(true)
  })

  it('listLogFiles and clearLogFiles handle active and rotated archives accurately', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    fs.writeFileSync(logFile, 'active\n')
    fs.writeFileSync(`${logFile}.1`, 'rot1\n')
    fs.writeFileSync(`${logFile}.2`, 'rot2\n')
    fs.writeFileSync(`${logFile}.bak`, 'ignore-me\n')
    fs.writeFileSync(path.join(dir, 'other.log'), 'ignore-me\n')

    const files = listLogFiles(logFile)
    expect(files.map((f) => f.index)).toEqual([0, 1, 2])

    const clearedActive = clearLogFiles(logFile, { includeRotated: false })
    expect(clearedActive.cleared).toEqual([logFile])
    expect(fs.readFileSync(logFile, 'utf8')).toBe('')
    expect(fs.existsSync(`${logFile}.1`)).toBe(true)

    const clearedAll = clearLogFiles(logFile, { includeRotated: true })
    expect(clearedAll.cleared.length).toBe(3)
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
    expect(fs.existsSync(`${logFile}.2`)).toBe(false)
  })

  it('readLogTail returns trailing lines and optionally spans rotated archives chronologically', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')

    const missing = readLogTail(logFile)
    expect(missing.exists).toBe(false)
    expect(missing.lines).toEqual([])

    fs.writeFileSync(`${logFile}.2`, 'old-1\nold-2\n')
    fs.writeFileSync(`${logFile}.1`, 'mid-1\nmid-2\n')
    fs.writeFileSync(logFile, 'cur-1\ncur-2\ncur-3\n')

    const activeTail = readLogTail(logFile, { tail: 2 })
    expect(activeTail.exists).toBe(true)
    expect(activeTail.lines).toEqual(['cur-2', 'cur-3'])
    expect(activeTail.totalLines).toBe(3)
    expect(activeTail.rotatedFiles).toBe(2)
    expect(formatDaemonLogInfoAscii(activeTail)).toContain('2 archive(s)')

    const zeroTail = readLogTail(logFile, { tail: 0 })
    expect(zeroTail.lines).toEqual([])

    const spanned = readLogTail(logFile, { tail: 5, includeRotated: true })
    expect(spanned.lines).toEqual(['mid-1', 'mid-2', 'cur-1', 'cur-2', 'cur-3'])
    expect(spanned.totalLines).toBe(7)

    const allSpanned = readLogTail(logFile, { tail: null, includeRotated: true })
    expect(allSpanned.lines).toEqual(['old-1', 'old-2', 'mid-1', 'mid-2', 'cur-1', 'cur-2', 'cur-3'])
  })

  it('followLogFile streams new lines, buffers partial lines, and survives copy-truncate & rename rotations', async () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    fs.writeFileSync(logFile, 'init-1\ninit-2\ninit-3\n')

    const received: string[] = []
    const rotations: Array<{ reason: string }> = []
    const ac = new AbortController()

    const handle = followLogFile(logFile, {
      tail: 2,
      pollIntervalMs: 20,
      signal: ac.signal,
      onLine: (line) => received.push(line),
      onRotate: (info) => rotations.push({ reason: info.reason }),
    })

    // Initial tail emitted synchronously
    expect(received).toEqual(['init-2', 'init-3'])

    // Partial line followed by completion
    fs.appendFileSync(logFile, 'part-a')
    await sleep(50)
    expect(received).toEqual(['init-2', 'init-3'])

    fs.appendFileSync(logFile, '-part-b\nnext-line\n')
    await sleep(60)
    expect(received).toEqual(['init-2', 'init-3', 'part-a-part-b', 'next-line'])

    // Copy-truncate rotation
    rotateLogFile(logFile, { maxFiles: 2, copyTruncate: true })
    await sleep(50)
    fs.appendFileSync(logFile, 'after-trunc\n')
    await sleep(60)
    expect(rotations.some((r) => r.reason === 'truncated')).toBe(true)
    expect(received).toContain('after-trunc')

    // Atomic rename replacement rotation
    rotateLogFile(logFile, { maxFiles: 2, copyTruncate: false })
    fs.writeFileSync(logFile, 'after-replace\n')
    await sleep(60)
    expect(received).toContain('after-replace')

    ac.abort()
    await handle.done
  })

  it('followLogFile waits cleanly when file does not exist yet and streams once created', async () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'delayed.log')
    const received: string[] = []

    const handle = followLogFile(logFile, {
      tail: 5,
      pollIntervalMs: 20,
      onLine: (line) => received.push(line),
    })

    await sleep(45)
    expect(received).toEqual([])

    fs.writeFileSync(logFile, 'created-line-1\ncreated-line-2\n')
    await sleep(60)
    expect(received).toEqual(['created-line-1', 'created-line-2'])

    handle.stop()
    await handle.done
  })

  it('CLI `daemon logs` supports --tail, -n, --all, --rotate, --clear, and --json', () => {
    const dir = makeTempDir()
    const ep = path.join(dir, 'agent-endpoint.json')
    const logFile = path.join(dir, 'daemon.log')
    fs.writeFileSync(`${logFile}.1`, 'archive-line\n')
    fs.writeFileSync(logFile, 'line-a\nline-b\nline-c\n')

    // --tail 2 via --endpoint
    const rTail = spawnSync(process.execPath, [BIN_PATH, 'daemon', 'logs', '--tail', '2', '--endpoint', ep], {
      encoding: 'utf8',
    })
    expect(rTail.status).toBe(0)
    expect(rTail.stdout.trim().split('\n')).toEqual(['line-b', 'line-c'])

    // -n 2 --json
    const rJson = spawnSync(process.execPath, [BIN_PATH, 'daemon', 'logs', '-n', '2', '--log-file', logFile, '--json'], {
      encoding: 'utf8',
    })
    expect(rJson.status).toBe(0)
    const parsed = JSON.parse(rJson.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.lines).toEqual(['line-b', 'line-c'])
    expect(parsed.rotatedFiles).toBe(1)

    // --all spans rotated archive
    const rAll = spawnSync(process.execPath, [BIN_PATH, 'daemon', 'logs', '--all', '--log-file', logFile], {
      encoding: 'utf8',
    })
    expect(rAll.status).toBe(0)
    expect(rAll.stdout.trim().split('\n')).toEqual(['archive-line', 'line-a', 'line-b', 'line-c'])

    // --rotate --json
    const rRot = spawnSync(process.execPath, [BIN_PATH, 'daemon', 'logs', '--rotate', '--log-file', logFile, '--json'], {
      encoding: 'utf8',
    })
    expect(rRot.status).toBe(0)
    const rotJson = JSON.parse(rRot.stdout)
    expect(rotJson.ok).toBe(true)
    expect(rotJson.rotated).toBe(true)
    expect(fs.readFileSync(logFile, 'utf8')).toBe('')
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('line-a\nline-b\nline-c\n')
    expect(fs.readFileSync(`${logFile}.2`, 'utf8')).toBe('archive-line\n')

    // --clear --all --json
    const rClr = spawnSync(
      process.execPath,
      [BIN_PATH, 'daemon', 'logs', '--clear', '--all', '--log-file', logFile, '--json'],
      { encoding: 'utf8' },
    )
    expect(rClr.status).toBe(0)
    const clrJson = JSON.parse(rClr.stdout)
    expect(clrJson.ok).toBe(true)
    expect(clrJson.cleared.length).toBe(3)
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
  })

  it('CLI `daemon logs --follow` streams appended lines live and exits cleanly on SIGINT', async () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'daemon.log')
    fs.writeFileSync(logFile, 'seed-1\nseed-2\n')

    const child = spawn(
      process.execPath,
      [BIN_PATH, 'daemon', 'logs', '--tail', '1', '--follow', '--poll-ms', '25', '--log-file', logFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })

    // Wait for initial seed-2
    const waitFor = async (substr: string, timeoutMs = 4000) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (stdout.includes(substr)) return
        await sleep(30)
      }
      throw new Error(`Timed out waiting for "${substr}" in stdout:\n${stdout}`)
    }

    await waitFor('seed-2')
    fs.appendFileSync(logFile, 'live-streamed-line\n')
    await waitFor('live-streamed-line')

    child.kill('SIGINT')
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
    })
    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('seed-1')
    expect(stdout).toContain('seed-2')
    expect(stdout).toContain('live-streamed-line')
  })

  it('daemon start rotates pre-existing oversized daemon.log before launching and daemon logs reads ready event', () => {
    const dir = makeTempDir()
    const ep = path.join(dir, 'agent-endpoint.json')
    const profileDir = path.join(dir, 'profile')
    const logFile = path.join(dir, 'daemon.log')

    // Pre-seed an oversized log file (> 64 bytes)
    fs.writeFileSync(logFile, 'x'.repeat(120) + '\n')

    const startRes = spawnSync(
      process.execPath,
      [
        BIN_PATH,
        'daemon',
        'start',
        '--engine',
        'lite',
        '--endpoint',
        ep,
        '--profile',
        profileDir,
        '--log-max-bytes',
        '64',
        '--log-max-files',
        '2',
      ],
      { encoding: 'utf8', timeout: 15000 },
    )

    try {
      expect(startRes.status).toBe(0)
      const started = JSON.parse(startRes.stdout)
      expect(started.ok).toBe(true)

      // Pre-existing oversized log was rotated to daemon.log.1
      expect(fs.existsSync(`${logFile}.1`)).toBe(true)
      expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toContain('x'.repeat(120))

      // Active daemon.log contains daemon_ready JSON event
      const logsRes = spawnSync(
        process.execPath,
        [BIN_PATH, 'daemon', 'logs', '--tail', '10', '--endpoint', ep],
        { encoding: 'utf8' },
      )
      expect(logsRes.status).toBe(0)
      expect(logsRes.stdout).toContain('"event":"daemon_ready"')
    } finally {
      spawnSync(process.execPath, [BIN_PATH, 'daemon', 'stop', '--endpoint', ep], { encoding: 'utf8' })
    }
  })
})
