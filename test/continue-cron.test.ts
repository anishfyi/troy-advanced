import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  acquireLock,
  applyCronBlock,
  buildContinuePrompt,
  buildCronExpression,
  releaseLock,
  stripCronBlock,
} from '../scripts/continue-cron.mjs'

describe('continue-cron 10-minute watchdog', () => {
  it('builds valid 10-minute cron expression and manages crontab blocks idempotently', () => {
    expect(buildCronExpression(10)).toBe('*/10 * * * *')
    expect(() => buildCronExpression(7)).toThrow()

    const line = '*/10 * * * * node /repo/scripts/continue-cron.mjs tick --cwd /repo >> /repo/.troy-cron/cron.log 2>&1'
    const once = applyCronBlock('0 0 * * * echo hi\n', line)
    expect(once).toContain('# BEGIN troy-advanced continue-cron')
    expect(once).toContain('*/10 * * * *')
    expect(once).toContain('echo hi')

    const twice = applyCronBlock(once, line)
    expect(twice).toBe(once)

    const stripped = stripCronBlock(twice)
    expect(stripped).not.toContain('troy-advanced continue-cron')
    expect(stripped).toContain('echo hi')
  })

  it('builds a continue prompt starting with "continue" and enforces minRuns >= 100', () => {
    const prompt = buildContinuePrompt(
      { cwd: process.cwd(), minRuns: 100, maxRuns: 105 },
      1,
    )
    expect(prompt.startsWith('continue\n')).toBe(true)
    expect(prompt).toContain('iteration 1 / 105')
    expect(prompt).toContain('minimum required: 100')
  })

  it('acquires and releases single-writer lock cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-cron-lock-'))
    const lockDir = path.join(tmp, 'run.lock')
    try {
      const first = acquireLock(lockDir, process.pid)
      expect(first.acquired).toBe(true)
      const second = acquireLock(lockDir, process.pid + 1)
      expect(second.acquired).toBe(false)
      releaseLock(lockDir, process.pid)
      const third = acquireLock(lockDir, process.pid)
      expect(third.acquired).toBe(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
