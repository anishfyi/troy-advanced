#!/usr/bin/env node
/**
 * 10-minute OS crontab autonomous "continue" loop controller for troy-advanced.
 *
 * Installs a Linux crontab entry (`*\/10 * * * *`) that checks every 10 minutes
 * and sends "continue" to a headless `dexter -p` worker at least 100 times
 * (default: minRuns=100, maxRuns=105), advancing through ROADMAP.md, verifying
 * typecheck + build + tests, committing, and pushing to origin main.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_INTERVAL_MINUTES = 10
export const DEFAULT_MIN_RUNS = 100
export const DEFAULT_MAX_RUNS = 105
export const DEFAULT_TIMEOUT_MINUTES = 18

const CRON_BEGIN = '# BEGIN troy-advanced continue-cron'
const CRON_END = '# END troy-advanced continue-cron'
const THIS_FILE = fileURLToPath(import.meta.url)

export function getPaths(cwd) {
  const repo = resolve(cwd)
  const dir = join(repo, '.troy-cron')
  return {
    repo,
    dir,
    statePath: join(dir, 'state.json'),
    logPath: join(dir, 'log.jsonl'),
    cronLogPath: join(dir, 'cron.log'),
    runsDir: join(dir, 'runs'),
    lockDir: join(dir, 'run.lock'),
    lockMetaPath: join(dir, 'run.lock', 'meta.json'),
    pausePath: join(dir, 'PAUSE'),
  }
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9,._+=@/:%-]+$/.test(value)) return value
  return `"${String(value).replace(/(["\\`$])/g, '\\$1')}"`
}

export function buildCronExpression(intervalMinutes) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
    throw new Error(`interval must be an integer between 1 and 60, got ${intervalMinutes}`)
  }
  if (intervalMinutes === 60) return '0 * * * *'
  if (60 % intervalMinutes !== 0) {
    throw new Error(`interval under 60 must divide 60 evenly (1,2,3,4,5,6,10,12,15,20,30); got ${intervalMinutes}`)
  }
  return `*/${intervalMinutes} * * * *`
}

export function stripCronBlock(existing) {
  const kept = []
  let inside = false
  for (const line of existing.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === CRON_BEGIN) {
      inside = true
      if (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
      continue
    }
    if (trimmed === CRON_END) {
      inside = false
      continue
    }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}

export function applyCronBlock(existing, line) {
  const base = stripCronBlock(existing).trim()
  const parts = base.length > 0 ? [base, ''] : []
  parts.push(CRON_BEGIN, line, CRON_END, '')
  return parts.join('\n')
}

export function buildMergedPath(basePath = '', extraDirs = []) {
  const defaults = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const seen = new Set()
  const out = []
  for (const dir of [...extraDirs, ...(basePath ? basePath.split(delimiter) : []), ...defaults]) {
    const d = (dir ?? '').trim()
    if (!d || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out.join(delimiter)
}

export function resolveDexterBin(override, env = process.env) {
  if (override && override.trim()) return override.trim()
  const dirs = [dirname(process.execPath), ...(env.PATH ? env.PATH.split(delimiter) : [])]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, 'dexter')
    if (existsSync(candidate)) return candidate
  }
  return 'dexter'
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

export function readState(statePath) {
  if (!existsSync(statePath)) return null
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return null
  }
}

export function writeState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, statePath)
}

export function acquireLock(lockDir, pid, maxAgeMs = 45 * 60_000, now = Date.now()) {
  mkdirSync(dirname(lockDir), { recursive: true })
  const metaPath = join(lockDir, 'meta.json')
  try {
    mkdirSync(lockDir)
    writeFileSync(metaPath, JSON.stringify({ pid, startedAt: now }, null, 2) + '\n', 'utf8')
    return { acquired: true }
  } catch {
    // Lock exists; inspect if holder is still alive and fresh
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      const alive = pidAlive(meta?.pid)
      const fresh = typeof meta?.startedAt === 'number' && now - meta.startedAt < maxAgeMs
      if (alive && fresh) {
        return { acquired: false, holderPid: meta.pid }
      }
    } catch {
      // Corrupt lock; reclaim
    }
    rmSync(lockDir, { recursive: true, force: true })
    try {
      mkdirSync(lockDir)
      writeFileSync(metaPath, JSON.stringify({ pid, startedAt: now }, null, 2) + '\n', 'utf8')
      return { acquired: true, reclaimed: true }
    } catch {
      return { acquired: false }
    }
  }
}

export function releaseLock(lockDir, expectedPid) {
  if (!existsSync(lockDir)) return
  try {
    const meta = JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf8'))
    if (expectedPid !== undefined && meta?.pid !== expectedPid) return
  } catch {
    // remove anyway
  }
  rmSync(lockDir, { recursive: true, force: true })
}

export function buildContinuePrompt(state, nextRun) {
  const repo = state.cwd
  let nextMilestones = ''
  try {
    const roadmap = readFileSync(join(repo, 'ROADMAP.md'), 'utf8')
    const unchecked = roadmap
      .split('\n')
      .filter((l) => l.trim().startsWith('- [ ]'))
      .slice(0, 5)
    if (unchecked.length > 0) {
      nextMilestones = unchecked.join('\n')
    }
  } catch {
    // ignore
  }

  let recentGit = ''
  try {
    recentGit = execFileSync('git', ['-C', repo, 'log', '-n', '5', '--oneline'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // ignore
  }

  return [
    'continue',
    '',
    `Autonomous 10-minute continue cron — iteration ${nextRun} / ${state.maxRuns} (minimum required: ${state.minRuns}).`,
    `Repository: ${repo}`,
    '',
    'Recent commits:',
    recentGit || '(none)',
    '',
    'Next unchecked milestones from ROADMAP.md:',
    nextMilestones || '(All listed milestones checked — run hardening, benchmarks, edge-case tests, and docs polish!)',
    '',
    'Instructions for this iteration:',
    '1. Inspect git status, GOAL.md, and ROADMAP.md.',
    '2. Pick the highest-priority unchecked milestone (or next concrete improvement/test/bugfix) and implement it thoroughly with clean TypeScript code and real Vitest tests.',
    '3. Verify every gate passes: `npm run typecheck && npm run build && npm test`.',
    '4. Mark the completed milestone `[x]` in ROADMAP.md.',
    `5. Commit your changes cleanly with message \`feat(iter-${nextRun}): <concise summary>\` (or fix/test/docs) and push to \`origin main\`.`,
    '6. Do NOT disarm or modify the crontab; the cron controller manages the 100+ iteration lifecycle.',
  ].join('\n')
}

function execCmd(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => (stdout += c.toString('utf8')))
    child.stderr?.on('data', (c) => (stderr += c.toString('utf8')))
    child.once('error', reject)
    if (options.stdin !== undefined) child.stdin?.end(options.stdin)
    else child.stdin?.end()
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }))
  })
}

function runWorker(state, prompt, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const cliArgs = ['-p', prompt]
    if (state.provider) cliArgs.push('--provider', state.provider)
    if (state.model) cliArgs.push('--model', state.model)

    const dexterBin = state.dexterBin || 'dexter'
    const child = spawn(dexterBin, cliArgs, {
      cwd: state.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let output = ''
    let timedOut = false
    const append = (buf) => {
      if (output.length < 500_000) output += buf.toString('utf8')
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // ignore
        }
      }, 2000)
    }, timeoutMs)

    child.once('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: 1, timedOut: false, output: `${output}\nspawn error: ${err.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: timedOut ? null : (code ?? 1), timedOut, output })
    })
  })
}

async function installCron(state) {
  const paths = getPaths(state.cwd)
  const expr = buildCronExpression(state.intervalMinutes)
  const cmd = [process.execPath, THIS_FILE, 'tick', '--cwd', state.cwd].map(shellQuote).join(' ')
  const line = `${expr} ${cmd} >> ${shellQuote(paths.cronLogPath)} 2>&1`
  const listed = await execCmd('crontab', ['-l']).catch(() => ({ code: 1, stdout: '' }))
  const existing = listed.code === 0 ? listed.stdout : ''
  const updated = applyCronBlock(existing, line)
  const applied = await execCmd('crontab', ['-'], { stdin: updated })
  if (applied.code !== 0) {
    throw new Error(`crontab install failed: ${applied.stderr}`)
  }
  return { line, expr }
}

async function removeCron() {
  const listed = await execCmd('crontab', ['-l']).catch(() => ({ code: 1, stdout: '' }))
  if (listed.code !== 0 || !listed.stdout.includes(CRON_BEGIN)) return false
  const updated = stripCronBlock(listed.stdout)
  await execCmd('crontab', ['-'], { stdin: updated.trim() ? `${updated.trimEnd()}\n` : '' })
  return true
}

function parseFlags(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i]
      } else {
        flags[a.slice(2)] = true
      }
    } else {
      pos.push(a)
    }
  }
  return { pos, flags }
}

export async function arm(flags) {
  const cwd = resolve(flags.cwd || process.cwd())
  const paths = getPaths(cwd)
  mkdirSync(paths.dir, { recursive: true })
  const existing = readState(paths.statePath)

  const intervalMinutes = Number(flags.interval ?? existing?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)
  const minRuns = Math.max(100, Number(flags['min-runs'] ?? existing?.minRuns ?? DEFAULT_MIN_RUNS))
  const maxRuns = Math.max(minRuns, Number(flags['max-runs'] ?? existing?.maxRuns ?? DEFAULT_MAX_RUNS))
  const timeoutMinutes = Number(flags['timeout-minutes'] ?? existing?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES)
  const dexterBin = resolveDexterBin(flags['dexter-bin'], process.env)
  const pathEnv = buildMergedPath(process.env.PATH || '', [dirname(process.execPath), dirname(dexterBin)])

  const state = {
    version: 1,
    status: 'active',
    cwd,
    intervalMinutes,
    minRuns,
    maxRuns,
    timeoutMinutes,
    completedRuns: existing?.completedRuns ?? 0,
    totalTicks: existing?.totalTicks ?? 0,
    provider: flags.provider ?? process.env.DEXTER_PROVIDER ?? existing?.provider ?? null,
    model: flags.model ?? process.env.DEXTER_MODEL ?? existing?.model ?? null,
    dexterBin,
    pathEnv,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: existing?.lastRunAt ?? null,
    lastExitCode: existing?.lastExitCode ?? null,
    lastRunLog: existing?.lastRunLog ?? null,
  }

  writeState(paths.statePath, state)
  const { line } = await installCron(state)

  console.log(`Armed troy-advanced continue-cron in ${cwd}`)
  console.log(`  schedule  : every ${intervalMinutes}m (${buildCronExpression(intervalMinutes)})`)
  console.log(`  runs      : ${state.completedRuns} / ${maxRuns} (minimum ${minRuns} "continue" iterations)`)
  console.log(`  dexter    : ${dexterBin} (provider=${state.provider ?? 'default'}, model=${state.model ?? 'default'})`)
  console.log(`  cron line : ${line}`)
  console.log(`  cron log  : ${paths.cronLogPath}`)
  return 0
}

export async function tick(flags) {
  const cwd = resolve(flags.cwd || process.cwd())
  const paths = getPaths(cwd)
  const prefix = `[continue-cron ${new Date().toISOString()}]`
  const state = readState(paths.statePath)

  if (!state) {
    console.log(`${prefix} no state.json in ${paths.dir}; disarming orphan cron.`)
    await removeCron()
    return 0
  }

  if (existsSync(paths.pausePath)) {
    console.log(`${prefix} PAUSE file exists; skipping tick.`)
    return 0
  }

  if (state.status === 'done' || state.status === 'stopped') {
    console.log(`${prefix} status is "${state.status}"; disarming cron.`)
    await removeCron()
    return 0
  }

  state.totalTicks = (state.totalTicks ?? 0) + 1

  if ((state.completedRuns ?? 0) >= state.maxRuns) {
    console.log(`${prefix} completed ${state.completedRuns}/${state.maxRuns} continue iterations; marking done and disarming.`)
    state.status = 'done'
    state.updatedAt = new Date().toISOString()
    writeState(paths.statePath, state)
    await removeCron()
    return 0
  }

  const lock = acquireLock(paths.lockDir, process.pid, Math.max(30, state.timeoutMinutes * 2) * 60_000)
  if (!lock.acquired) {
    console.log(`${prefix} previous worker still active (pid ${lock.holderPid ?? '?'}); skipping tick.`)
    writeState(paths.statePath, state)
    return 0
  }

  try {
    const nextRun = (state.completedRuns ?? 0) + 1
    const prompt = buildContinuePrompt(state, nextRun)

    if (flags['dry-run']) {
      console.log(`${prefix} DRY-RUN iteration ${nextRun}/${state.maxRuns} (min ${state.minRuns})`)
      console.log(prompt)
      return 0
    }

    console.log(`${prefix} Run ${nextRun}/${state.maxRuns} (min ${state.minRuns}): saying "continue" to dexter...`)
    const workerEnv = {
      ...process.env,
      PATH: buildMergedPath(state.pathEnv || process.env.PATH || '', [dirname(process.execPath)]),
      TROY_CONTINUE_CRON_WORKER: '1',
      TROY_CONTINUE_ITERATION: String(nextRun),
    }

    const startedAt = Date.now()
    const result = await runWorker(state, prompt, workerEnv, (state.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000)
    const durationMs = Date.now() - startedAt

    mkdirSync(paths.runsDir, { recursive: true })
    const runLogFile = join(paths.runsDir, `continue-${String(nextRun).padStart(3, '0')}-${startedAt}.log`)
    writeFileSync(
      runLogFile,
      [
        `# troy-advanced continue-cron run ${nextRun}/${state.maxRuns}`,
        `# startedAt: ${new Date(startedAt).toISOString()}`,
        `# durationMs: ${durationMs}`,
        `# exitCode: ${result.exitCode ?? 'timeout'}`,
        '',
        '## prompt',
        prompt,
        '',
        '## output',
        result.output,
        '',
      ].join('\n'),
      'utf8',
    )

    state.completedRuns = nextRun
    state.lastRunAt = new Date().toISOString()
    state.lastExitCode = result.exitCode
    state.lastRunLog = runLogFile
    state.updatedAt = new Date().toISOString()

    appendFileSync(
      paths.logPath,
      `${JSON.stringify({
        iteration: nextRun,
        minRuns: state.minRuns,
        maxRuns: state.maxRuns,
        ts: state.lastRunAt,
        durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        logFile: runLogFile,
      })}\n`,
      'utf8',
    )

    if (nextRun >= state.maxRuns) {
      state.status = 'done'
      writeState(paths.statePath, state)
      await removeCron()
      console.log(`${prefix} Completed final continue iteration ${nextRun}/${state.maxRuns}; cron disarmed.`)
    } else {
      writeState(paths.statePath, state)
      console.log(`${prefix} Finished continue iteration ${nextRun}/${state.maxRuns} (exit=${result.exitCode ?? 'timeout'}, ${Math.round(durationMs / 1000)}s).`)
    }
    return 0
  } finally {
    releaseLock(paths.lockDir, process.pid)
  }
}

export async function status(flags) {
  const cwd = resolve(flags.cwd || process.cwd())
  const paths = getPaths(cwd)
  const state = readState(paths.statePath)
  const listed = await execCmd('crontab', ['-l']).catch(() => ({ code: 1, stdout: '' }))
  const cronInstalled = listed.code === 0 && listed.stdout.includes(CRON_BEGIN)
  const paused = existsSync(paths.pausePath)
  const report = { cwd, state, cronInstalled, paused, cronLogPath: paths.cronLogPath }
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`troy-advanced continue-cron status`)
    console.log(`  repo       : ${cwd}`)
    console.log(`  status     : ${state?.status ?? 'not armed'}`)
    console.log(`  crontab    : ${cronInstalled ? `installed (every ${state?.intervalMinutes ?? 10}m)` : 'not installed'}`)
    console.log(`  paused     : ${paused ? 'yes' : 'no'}`)
    if (state) {
      console.log(`  runs       : ${state.completedRuns} / ${state.maxRuns} (min ${state.minRuns})`)
      console.log(`  totalTicks : ${state.totalTicks}`)
      console.log(`  dexter     : ${state.dexterBin} (${state.provider ?? 'default'}/${state.model ?? 'default'})`)
      console.log(`  lastRunAt  : ${state.lastRunAt ?? 'pending first 10m tick'}`)
      console.log(`  cronLog    : ${paths.cronLogPath}`)
    }
  }
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  const { pos, flags } = parseFlags(argv)
  const cmd = pos[0] || 'status'
  const cwd = resolve(flags.cwd || process.cwd())
  const paths = getPaths(cwd)

  if (cmd === 'arm') return arm(flags)
  if (cmd === 'tick') return tick(flags)
  if (cmd === 'status') return status(flags)
  if (cmd === 'pause') {
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.pausePath, `${flags.reason || 'Paused by operator'}\n`, 'utf8')
    console.log(`Paused continue-cron (${paths.pausePath})`)
    return 0
  }
  if (cmd === 'resume') {
    rmSync(paths.pausePath, { force: true })
    console.log('Resumed continue-cron')
    return 0
  }
  if (cmd === 'disarm' || cmd === 'stop') {
    const state = readState(paths.statePath)
    if (state) {
      state.status = 'stopped'
      state.updatedAt = new Date().toISOString()
      writeState(paths.statePath, state)
    }
    await removeCron()
    console.log('Disarmed troy-advanced continue-cron.')
    return 0
  }
  console.error(`Unknown command: ${cmd}. Use: arm | tick | status | pause | resume | disarm`)
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE)) {
  main().then((code) => process.exit(code))
}
