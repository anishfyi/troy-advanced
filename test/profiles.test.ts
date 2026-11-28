import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROFILE_BUNDLE_FORMAT,
  createProfile,
  deleteProfile,
  exportProfile,
  formatProfileDetailAscii,
  formatProfilesAscii,
  getProfile,
  importProfile,
  isValidProfileName,
  listProfiles,
  resolveProfileDir,
  resolveProfileFlag,
  validateProfileName,
} from '../src/cloud/profiles.js'

const BIN_PATH = path.resolve(process.cwd(), 'bin/troy-advanced.mjs')

function mkTempDir(prefix = 'troy-profiles-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function seedProfileFiles(profileDir: string): void {
  fs.writeFileSync(
    path.join(profileDir, 'cookies.json'),
    JSON.stringify([{ name: 'sid', value: 'secret123', domain: 'example.com', path: '/' }]),
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(profileDir, 'memory.json'),
    JSON.stringify({ entries: [{ origin: 'https://example.com', selector: '#login' }] }),
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(profileDir, 'policy.json'),
    JSON.stringify({ profile: 'strict', allowEval: false }),
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(profileDir, 'daemon.json'),
    JSON.stringify({ version: 1, allowedOrigins: ['https://example.com'], deniedOrigins: [] }),
    { mode: 0o600 },
  )
  fs.writeFileSync(path.join(profileDir, 'audit.jsonl'), '{"tool":"page_read","ok":true}\n', { mode: 0o600 })

  // Nested chrome-data with both persistent prefs and cache files
  fs.mkdirSync(path.join(profileDir, 'chrome-data', 'Default', 'Cache'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'chrome-data', 'Default', 'Preferences'), '{"profile":{"name":"test"}}')
  fs.writeFileSync(path.join(profileDir, 'chrome-data', 'Default', 'Cache', 'blob.bin'), 'cached-bytes')

  // Volatile files that must be skipped during clone and export
  fs.writeFileSync(path.join(profileDir, 'SingletonLock'), 'lock')
  fs.writeFileSync(path.join(profileDir, 'daemon.log'), 'log line 1\n')
  fs.writeFileSync(path.join(profileDir, 'daemon.log.1'), 'rotated log\n')
}

describe('Multi-profile management (M84)', () => {
  let tmpRoot: string
  let profilesDir: string

  beforeEach(() => {
    tmpRoot = mkTempDir()
    profilesDir = path.join(tmpRoot, 'profiles')
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe('name validation & path resolution', () => {
    it('accepts valid profile names and rejects unsafe/traversal names', () => {
      for (const good of ['work', 'ec2-prod', 'agent_1', 'team.alpha', 'default', 'A1']) {
        expect(validateProfileName(good).ok).toBe(true)
        expect(isValidProfileName(good)).toBe(true)
      }

      for (const bad of [
        '',
        '   ',
        '../etc',
        'foo/bar',
        'foo\\bar',
        '.hidden',
        '-leading-dash',
        'has space',
        'a'.repeat(65),
        'null\0byte',
        'a..b',
      ]) {
        expect(validateProfileName(bad).ok).toBe(false)
        expect(isValidProfileName(bad)).toBe(false)
      }
    })

    it('resolves named profiles vs filesystem paths in resolveProfileFlag', () => {
      expect(resolveProfileDir('work', { profilesDir })).toBe(path.join(profilesDir, 'work'))
      expect(resolveProfileFlag('work', { profilesDir })).toBe(path.join(profilesDir, 'work'))
      expect(resolveProfileFlag('/tmp/custom-prof', { profilesDir })).toBe(path.resolve('/tmp/custom-prof'))
      expect(resolveProfileFlag('./rel-prof', { profilesDir })).toBe(path.resolve('./rel-prof'))
      expect(resolveProfileFlag('~/my-prof', { profilesDir })).toBe(path.join(os.homedir(), 'my-prof'))
      expect(() => resolveProfileDir('../escape', { profilesDir })).toThrow()
    })
  })

  describe('create, list, inspect, clone, and delete', () => {
    it('creates profiles with metadata, 0700 permissions, and lists features accurately', () => {
      expect(listProfiles({ profilesDir })).toEqual([])

      const created = createProfile('work', {
        profilesDir,
        description: 'Work EC2 profile',
        engine: 'lite',
        policy: 'strict',
        tags: ['ec2', 'prod', 'ec2'],
      })
      expect(created.ok).toBe(true)
      expect(created.profile?.name).toBe('work')
      expect(created.profile?.description).toBe('Work EC2 profile')
      expect(created.profile?.engine).toBe('lite')
      expect(created.profile?.policy).toBe('strict')
      expect(created.profile?.tags).toEqual(['ec2', 'prod'])

      // Duplicate creation fails
      const dup = createProfile('work', { profilesDir })
      expect(dup.ok).toBe(false)
      expect(dup.error).toMatch(/already exists/i)

      // Seed files and verify feature detection
      seedProfileFiles(created.profile!.dir)
      const inspected = getProfile('work', { profilesDir })
      expect(inspected).not.toBeNull()
      expect(inspected!.hasCookies).toBe(true)
      expect(inspected!.hasMemory).toBe(true)
      expect(inspected!.hasPolicy).toBe(true)
      expect(inspected!.hasDaemonConfig).toBe(true)
      expect(inspected!.hasChromeData).toBe(true)
      expect(inspected!.hasAuditLog).toBe(true)
      expect(inspected!.daemonRunning).toBe(false)
      expect(inspected!.fileCount).toBeGreaterThanOrEqual(7)
      expect(inspected!.sizeBytes).toBeGreaterThan(0)

      // POSIX permission check on Linux/macOS
      if (process.platform !== 'win32') {
        const dirMode = fs.statSync(created.profile!.dir).mode & 0o777
        const metaMode = fs.statSync(path.join(created.profile!.dir, 'profile.json')).mode & 0o777
        expect(dirMode).toBe(0o700)
        expect(metaMode).toBe(0o600)
      }

      // ASCII formatting is strict 7-bit ASCII
      const listAscii = formatProfilesAscii(listProfiles({ profilesDir }))
      expect(listAscii).toContain('TROY-ADVANCED PROFILES (1)')
      expect(listAscii).toContain('work')
      expect(listAscii).toContain('cookies,memory,policy,daemon-cfg,chrome,audit')
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(listAscii)).toBe(true)

      const detailAscii = formatProfileDetailAscii(inspected!)
      expect(detailAscii).toContain('PROFILE: work')
      expect(detailAscii).toContain('Work EC2 profile')
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(detailAscii)).toBe(true)
    })

    it('clones an existing profile via --from while skipping volatile lock/log/cache files', () => {
      const src = createProfile('base', { profilesDir, description: 'Base profile', policy: 'standard' })
      expect(src.ok).toBe(true)
      seedProfileFiles(src.profile!.dir)

      const cloned = createProfile('staging', { profilesDir, from: 'base' })
      expect(cloned.ok).toBe(true)
      expect(cloned.clonedFrom).toBe('base')
      expect(cloned.copiedFiles).toBeGreaterThanOrEqual(5)

      const dstDir = cloned.profile!.dir
      expect(fs.existsSync(path.join(dstDir, 'cookies.json'))).toBe(true)
      expect(fs.existsSync(path.join(dstDir, 'memory.json'))).toBe(true)
      expect(fs.existsSync(path.join(dstDir, 'chrome-data', 'Default', 'Preferences'))).toBe(true)
      // Volatile & cache files must NOT be cloned
      expect(fs.existsSync(path.join(dstDir, 'SingletonLock'))).toBe(false)
      expect(fs.existsSync(path.join(dstDir, 'daemon.log'))).toBe(false)
      expect(fs.existsSync(path.join(dstDir, 'chrome-data', 'Default', 'Cache', 'blob.bin'))).toBe(false)
      // Metadata updated to new name
      expect(cloned.profile!.name).toBe('staging')
      expect(cloned.profile!.policy).toBe('standard')
    })

    it('deletes profiles safely and refuses deleting default or live-daemon profiles without --force', () => {
      const p1 = createProfile('temp', { profilesDir })
      expect(p1.ok).toBe(true)
      seedProfileFiles(p1.profile!.dir)

      // Simulate running daemon by writing agent-endpoint.json with current live PID
      fs.writeFileSync(
        path.join(p1.profile!.dir, 'agent-endpoint.json'),
        JSON.stringify({
          pid: process.pid,
          agentPort: 49999,
          agentToken: 'tok',
          startedAt: Date.now(),
          profileDir: p1.profile!.dir,
        }),
      )
      expect(getProfile('temp', { profilesDir })?.daemonRunning).toBe(true)

      const blocked = deleteProfile('temp', { profilesDir })
      expect(blocked.ok).toBe(false)
      expect(blocked.error).toMatch(/running daemon/i)

      const forced = deleteProfile('temp', { profilesDir, force: true })
      expect(forced.ok).toBe(true)
      expect(forced.removedFiles).toBeGreaterThan(0)
      expect(getProfile('temp', { profilesDir })).toBeNull()

      // Default profile delete guard
      const def = createProfile('default', { profilesDir })
      expect(def.ok).toBe(true)
      const defBlocked = deleteProfile('default', { profilesDir })
      expect(defBlocked.ok).toBe(false)
      expect(defBlocked.error).toMatch(/default/i)
      const defForced = deleteProfile('default', { profilesDir, force: true })
      expect(defForced.ok).toBe(true)
    })
  })

  describe('export and import (plain, gzip, encrypted, integrity & security)', () => {
    it('exports and imports a plain JSON bundle with full fidelity and excludes volatile/cache files', () => {
      const created = createProfile('alpha', { profilesDir, description: 'Alpha box', policy: 'strict' })
      expect(created.ok).toBe(true)
      seedProfileFiles(created.profile!.dir)

      const outFile = path.join(tmpRoot, 'alpha.json')
      const exp = exportProfile('alpha', { profilesDir, outFile })
      expect(exp.ok).toBe(true)
      expect(exp.encrypted).toBe(false)
      expect(exp.compressed).toBe(false)
      expect(exp.outFile).toBe(outFile)
      expect(exp.manifestSha256).toMatch(/^[a-f0-9]{64}$/)

      const exportedPaths = exp.bundle!.files.map((f) => f.path)
      expect(exportedPaths).toContain('cookies.json')
      expect(exportedPaths).toContain('memory.json')
      expect(exportedPaths).toContain('chrome-data/Default/Preferences')
      expect(exportedPaths).not.toContain('SingletonLock')
      expect(exportedPaths).not.toContain('daemon.log')
      expect(exportedPaths).not.toContain('chrome-data/Default/Cache/blob.bin')

      // Import under a new name
      const imp = importProfile(outFile, { profilesDir, name: 'alpha-copy' })
      expect(imp.ok).toBe(true)
      expect(imp.profile?.name).toBe('alpha-copy')
      expect(imp.profile?.description).toBe('Alpha box')
      expect(imp.profile?.policy).toBe('strict')
      expect(imp.profile?.hasCookies).toBe(true)
      expect(imp.profile?.hasChromeData).toBe(true)
      expect(imp.encrypted).toBe(false)
      expect(imp.overwritten).toBe(false)

      const importedCookies = JSON.parse(
        fs.readFileSync(path.join(imp.profile!.dir, 'cookies.json'), 'utf8'),
      )
      expect(importedCookies[0].value).toBe('secret123')

      // Importing again without overwrite fails
      const dupImp = importProfile(outFile, { profilesDir, name: 'alpha-copy' })
      expect(dupImp.ok).toBe(false)
      expect(dupImp.error).toMatch(/already exists/i)

      // Importing with overwrite succeeds
      const overImp = importProfile(outFile, { profilesDir, name: 'alpha-copy', overwrite: true })
      expect(overImp.ok).toBe(true)
      expect(overImp.overwritten).toBe(true)
    })

    it('supports excludeChromeData, excludeAudit, includeCache, and gzip (.gz) compression', () => {
      const created = createProfile('slim', { profilesDir })
      seedProfileFiles(created.profile!.dir)

      const gzFile = path.join(tmpRoot, 'slim.troy-profile.json.gz')
      const expSlim = exportProfile('slim', {
        profilesDir,
        outFile: gzFile,
        excludeChromeData: true,
        excludeAudit: true,
      })
      expect(expSlim.ok).toBe(true)
      expect(expSlim.compressed).toBe(true)
      const slimPaths = expSlim.bundle!.files.map((f) => f.path)
      expect(slimPaths).toContain('cookies.json')
      expect(slimPaths).not.toContain('audit.jsonl')
      expect(slimPaths.some((p) => p.startsWith('chrome-data/'))).toBe(false)

      // Auto-detects gzip on import
      const impSlim = importProfile(gzFile, { profilesDir, name: 'slim-restored' })
      expect(impSlim.ok).toBe(true)
      expect(impSlim.profile?.hasCookies).toBe(true)
      expect(impSlim.profile?.hasChromeData).toBe(false)
      expect(impSlim.profile?.hasAuditLog).toBe(false)

      // includeCache includes Chrome cache files
      const expWithCache = exportProfile('slim', { profilesDir, includeCache: true })
      expect(expWithCache.ok).toBe(true)
      expect(expWithCache.bundle!.files.map((f) => f.path)).toContain('chrome-data/Default/Cache/blob.bin')
    })

    it('supports AES-256-GCM encrypted export/import and rejects missing/wrong passphrases and tampering', () => {
      const created = createProfile('vault', { profilesDir, description: 'Signed-in EC2 session' })
      seedProfileFiles(created.profile!.dir)

      const encFile = path.join(tmpRoot, 'vault.enc.json')
      const exp = exportProfile('vault', {
        profilesDir,
        outFile: encFile,
        encrypt: true,
        passphrase: 'correct-horse-battery-staple',
      })
      expect(exp.ok).toBe(true)
      expect(exp.encrypted).toBe(true)

      // Plaintext secret must NOT appear in encrypted file on disk
      const diskText = fs.readFileSync(encFile, 'utf8')
      expect(diskText).not.toContain('secret123')
      expect(diskText).toContain('aes-256-gcm')

      // Missing passphrase fails
      const noPass = importProfile(encFile, { profilesDir, name: 'vault-copy' })
      expect(noPass.ok).toBe(false)
      expect(noPass.error).toMatch(/passphrase required/i)

      // Wrong passphrase fails
      const wrongPass = importProfile(encFile, {
        profilesDir,
        name: 'vault-copy',
        passphrase: 'wrong-passphrase',
      })
      expect(wrongPass.ok).toBe(false)
      expect(wrongPass.error).toMatch(/decrypt/i)

      // Tampered ciphertext fails GCM auth tag verification
      const tamperedObj = JSON.parse(diskText)
      const ctBuf = Buffer.from(tamperedObj.ciphertext, 'base64')
      ctBuf[0] = ctBuf[0]! ^ 0xff
      tamperedObj.ciphertext = ctBuf.toString('base64')
      const tamperedRes = importProfile(JSON.stringify(tamperedObj), {
        profilesDir,
        name: 'vault-tampered',
        passphrase: 'correct-horse-battery-staple',
      })
      expect(tamperedRes.ok).toBe(false)
      expect(tamperedRes.error).toMatch(/decrypt/i)

      // Correct passphrase succeeds
      const okImp = importProfile(encFile, {
        profilesDir,
        name: 'vault-restored',
        passphrase: 'correct-horse-battery-staple',
      })
      expect(okImp.ok).toBe(true)
      expect(okImp.encrypted).toBe(true)
      expect(okImp.profile?.hasCookies).toBe(true)
      expect(fs.readFileSync(path.join(okImp.profile!.dir, 'cookies.json'), 'utf8')).toContain('secret123')
    })

    it('rejects tampered SHA-256 checksums and path-traversal bundle entries before touching disk', () => {
      const created = createProfile('integrity', { profilesDir })
      seedProfileFiles(created.profile!.dir)
      const exp = exportProfile('integrity', { profilesDir })
      expect(exp.ok).toBe(true)

      // 1. Tampered file content fails per-file SHA-256
      const badFileBundle = structuredClone(exp.bundle!)
      badFileBundle.files[0]!.contentBase64 = Buffer.from('corrupted').toString('base64')
      const badFileRes = importProfile(JSON.stringify(badFileBundle), {
        profilesDir,
        name: 'should-not-exist-1',
      })
      expect(badFileRes.ok).toBe(false)
      expect(badFileRes.error).toMatch(/SHA-256 integrity mismatch/i)
      expect(getProfile('should-not-exist-1', { profilesDir })).toBeNull()

      // 2. Tampered manifestSha256 fails manifest check
      const badManifestBundle = structuredClone(exp.bundle!)
      badManifestBundle.manifestSha256 = '0'.repeat(64)
      const badManifestRes = importProfile(JSON.stringify(badManifestBundle), {
        profilesDir,
        name: 'should-not-exist-2',
      })
      expect(badManifestRes.ok).toBe(false)
      expect(badManifestRes.error).toMatch(/manifest SHA-256 mismatch/i)
      expect(getProfile('should-not-exist-2', { profilesDir })).toBeNull()

      // 3. Path traversal entries are rejected
      for (const evilPath of ['../escape.txt', '/etc/passwd', 'sub/../../escape.txt', 'dir\\evil.txt']) {
        const evilBundle = {
          format: PROFILE_BUNDLE_FORMAT,
          version: 1,
          profileName: 'evil',
          exportedAt: new Date().toISOString(),
          files: [
            {
              path: evilPath,
              mode: 0o600,
              contentBase64: Buffer.from('pwn').toString('base64'),
              sizeBytes: 3,
              sha256: '',
            },
          ],
          totalFiles: 1,
          totalBytes: 3,
          manifestSha256: '',
        }
        const evilRes = importProfile(JSON.stringify(evilBundle), {
          profilesDir,
          name: 'evil-target',
        })
        expect(evilRes.ok).toBe(false)
        expect(getProfile('evil-target', { profilesDir })).toBeNull()
      }
    })
  })

  describe('CLI integration (troy-advanced profile list|show|create|delete|export|import)', () => {
    function runCli(args: string[], input?: Buffer | string) {
      return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        input,
        env: { ...process.env, TROY_PROFILES_DIR: profilesDir },
      })
    }

    it('runs full lifecycle via CLI including stdout->stdin pipe transfer', () => {
      // Create
      const c = runCli([
        'profile',
        'create',
        'cli-prof',
        '--description',
        'Created via CLI',
        '--policy',
        'strict',
        '--tag',
        'ec2',
        '--json',
      ])
      expect(c.status).toBe(0)
      const cJson = JSON.parse(c.stdout)
      expect(cJson.ok).toBe(true)
      expect(cJson.profile.name).toBe('cli-prof')

      // Seed a file inside created profile
      fs.writeFileSync(path.join(cJson.profile.dir, 'cookies.json'), '[{"name":"a","value":"b","domain":"x.com","path":"/"}]')

      // List (JSON + ASCII)
      const lJson = JSON.parse(runCli(['profile', 'list', '--json']).stdout)
      expect(lJson.ok).toBe(true)
      expect(lJson.count).toBe(1)
      expect(lJson.profiles[0].name).toBe('cli-prof')

      const lAscii = runCli(['profile', 'list'])
      expect(lAscii.status).toBe(0)
      expect(lAscii.stdout).toContain('cli-prof')

      // Show
      const s = runCli(['profile', 'show', 'cli-prof', '--json'])
      expect(s.status).toBe(0)
      expect(JSON.parse(s.stdout).profile.description).toBe('Created via CLI')

      // Export encrypted to file
      const encPath = path.join(tmpRoot, 'cli-prof.enc.json.gz')
      const e = runCli([
        'profile',
        'export',
        'cli-prof',
        encPath,
        '--encrypt',
        '--passphrase',
        'cli-secret',
        '--json',
      ])
      expect(e.status).toBe(0)
      const eJson = JSON.parse(e.stdout)
      expect(eJson.ok).toBe(true)
      expect(eJson.encrypted).toBe(true)
      expect(eJson.compressed).toBe(true)

      // Import from encrypted .gz file under a new name
      const i = runCli([
        'profile',
        'import',
        encPath,
        '--name',
        'cli-imported',
        '--passphrase',
        'cli-secret',
        '--json',
      ])
      expect(i.status).toBe(0)
      const iJson = JSON.parse(i.stdout)
      expect(iJson.ok).toBe(true)
      expect(iJson.profile.name).toBe('cli-imported')
      expect(iJson.profile.hasCookies).toBe(true)

      // Pipe export stdout -> import stdin
      const exportedStdout = execFileSync(process.execPath, [BIN_PATH, 'profile', 'export', 'cli-prof', '-'], {
        env: { ...process.env, TROY_PROFILES_DIR: profilesDir },
      })
      const piped = runCli(['profile', 'import', '-', '--name', 'cli-piped', '--json'], exportedStdout)
      expect(piped.status).toBe(0)
      expect(JSON.parse(piped.stdout).profile.name).toBe('cli-piped')

      // Delete
      const d = runCli(['profile', 'delete', 'cli-piped', '--json'])
      expect(d.status).toBe(0)
      expect(JSON.parse(d.stdout).ok).toBe(true)
      expect(getProfile('cli-piped', { profilesDir })).toBeNull()
    })
  })
})
