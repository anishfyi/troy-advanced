// Automatic Chromium crash detection, stale lock cleanup, backoff calculation,
// and disconnect error classification for transparent process relaunch (M26).

import fs from 'node:fs'
import path from 'node:path'
import type { CrashRecoveryOptions, CrashRecoveryStats } from '../types.js'

export const DEFAULT_CRASH_RECOVERY_OPTIONS: Required<CrashRecoveryOptions> = {
  enabled: true,
  maxRestarts: 5,
  backoffMs: 250,
  maxBackoffMs: 5000,
  resetWindowMs: 60_000,
  restoreTabs: true,
}

const STALE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const

export function resolveCrashRecoveryOptions(opts?: CrashRecoveryOptions): Required<CrashRecoveryOptions> {
  const enabled = opts?.enabled ?? DEFAULT_CRASH_RECOVERY_OPTIONS.enabled
  const maxRestarts =
    typeof opts?.maxRestarts === 'number' && Number.isFinite(opts.maxRestarts)
      ? Math.max(0, Math.floor(opts.maxRestarts))
      : DEFAULT_CRASH_RECOVERY_OPTIONS.maxRestarts
  const backoffMs =
    typeof opts?.backoffMs === 'number' && Number.isFinite(opts.backoffMs)
      ? Math.max(0, Math.floor(opts.backoffMs))
      : DEFAULT_CRASH_RECOVERY_OPTIONS.backoffMs
  const rawMaxBackoff =
    typeof opts?.maxBackoffMs === 'number' && Number.isFinite(opts.maxBackoffMs)
      ? Math.max(0, Math.floor(opts.maxBackoffMs))
      : DEFAULT_CRASH_RECOVERY_OPTIONS.maxBackoffMs
  const maxBackoffMs = Math.max(backoffMs, rawMaxBackoff)
  const resetWindowMs =
    typeof opts?.resetWindowMs === 'number' && Number.isFinite(opts.resetWindowMs)
      ? Math.max(0, Math.floor(opts.resetWindowMs))
      : DEFAULT_CRASH_RECOVERY_OPTIONS.resetWindowMs
  const restoreTabs = opts?.restoreTabs ?? DEFAULT_CRASH_RECOVERY_OPTIONS.restoreTabs

  return {
    enabled,
    maxRestarts,
    backoffMs,
    maxBackoffMs,
    resetWindowMs,
    restoreTabs,
  }
}

/**
 * Exponential backoff delay for recovery attempt index (0-based).
 * Attempt 0 -> backoffMs, attempt 1 -> 2*backoffMs, capped at maxBackoffMs.
 */
export function computeRecoveryBackoffMs(
  attempt: number,
  opts: Pick<Required<CrashRecoveryOptions>, 'backoffMs' | 'maxBackoffMs'>,
): number {
  const idx = Math.max(0, Math.floor(attempt))
  if (opts.backoffMs <= 0) return 0
  const delay = opts.backoffMs * Math.pow(2, Math.min(idx, 16))
  return Math.min(opts.maxBackoffMs, Math.floor(delay))
}

/**
 * Classify whether an error indicates the Chromium CDP transport or process died.
 */
export function isCdpDisconnectError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '')
  const causeCode = String((err as { cause?: { code?: unknown } })?.cause?.code ?? '')
  const code = String((err as { code?: unknown })?.code ?? '')
  const combined = `${msg} ${code} ${causeCode}`.toLowerCase()

  return (
    combined.includes('cdp websocket closed') ||
    combined.includes('cdp client is closed') ||
    combined.includes('econnrefused') ||
    combined.includes('econnreset') ||
    combined.includes('epipe') ||
    combined.includes('socket hang up') ||
    combined.includes('fetch failed') ||
    combined.includes('chromium process exited') ||
    combined.includes('chromium engine crashed')
  )
}

/**
 * Remove stale Chromium singleton lock files left behind after an abrupt crash
 * (e.g. SIGKILL / OOM) so relaunching with the same persistent profile succeeds cleanly.
 */
export function cleanupStaleProfileLocks(profileDir: string): string[] {
  const removed: string[] = []
  if (!profileDir) return removed
  for (const name of STALE_LOCK_FILES) {
    const full = path.join(profileDir, name)
    try {
      // lstatSync works for broken symlinks (which SingletonLock is on Linux)
      fs.lstatSync(full)
      fs.unlinkSync(full)
      removed.push(name)
    } catch {
      // Lock file does not exist or cannot be removed; ignore
    }
  }
  return removed
}

/**
 * Determine if a tab's last URL should be automatically re-navigated after crash recovery.
 */
export function shouldRestoreTabUrl(url: string | undefined): boolean {
  if (!url) return false
  const trimmed = url.trim().toLowerCase()
  return trimmed.startsWith('http://') || trimmed.startsWith('https://')
}

export function defaultDisabledCrashRecoveryStats(cdpPort: number): CrashRecoveryStats {
  return {
    enabled: false,
    canRecover: false,
    status: 'healthy',
    pid: null,
    cdpPort,
    profileDir: null,
    restartCount: 0,
    consecutiveRestarts: 0,
    totalCrashes: 0,
    maxRestarts: 0,
    lastCrashAt: null,
    lastRecoveredAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
  }
}
