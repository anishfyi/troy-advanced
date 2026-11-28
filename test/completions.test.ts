import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  COMPLETION_SHELLS,
  formatInstallHint,
  generateBashCompletion,
  generateFishCompletion,
  generateShellCompletion,
  generateZshCompletion,
  getCompletionSpec,
  parseCompletionShell,
} from '../src/completions.js'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-completions-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('shell completion generator (M95)', () => {
  it('parses valid shell names case-insensitively and rejects unknown shells', () => {
    expect(COMPLETION_SHELLS).toEqual(['bash', 'zsh', 'fish'])
    expect(parseCompletionShell('bash')).toBe('bash')
    expect(parseCompletionShell('ZSH')).toBe('zsh')
    expect(parseCompletionShell('  Fish  ')).toBe('fish')
    expect(parseCompletionShell('powershell')).toBeNull()
    expect(parseCompletionShell('')).toBeNull()
  })

  it('maintains a unique, comprehensive CLI completion spec', () => {
    const spec = getCompletionSpec()
    expect(spec.defaultBinNames).toEqual(['troy-advanced', 'troya'])

    const cmdNames = spec.commands.map((c) => c.name)
    expect(new Set(cmdNames).size).toBe(cmdNames.length)

    const globalFlagNames = spec.globalFlags.map((f) => f.name)
    expect(new Set(globalFlagNames).size).toBe(globalFlagNames.length)

    for (const required of [
      'daemon',
      'browse',
      'mcp',
      'schema',
      'run',
      'pipe',
      'doctor',
      'bench',
      'profile',
      'ec2',
      'completions',
      'status',
      'health',
      'metrics',
      'tabs',
      'open',
      'ascii',
      'stream',
      'markdown',
      'visual',
      'read',
      'find',
      'extract',
      'click',
      'fill',
      'select',
      'press',
      'scroll',
      'wait',
      'network',
      'downloads',
      'dialogs',
      'audit',
      'policy',
      'origins',
      'sessions',
      'cookies',
      'storage',
      'emulate',
    ]) {
      expect(cmdNames).toContain(required)
    }
  })

  it('generates syntactically valid bash completions and passes live bash completion probes', () => {
    const script = generateBashCompletion()
    expect(script).toContain('_troy_advanced_completions()')
    expect(script).toContain('complete -F _troy_advanced_completions troy-advanced')
    expect(script).toContain('complete -F _troy_advanced_completions troya')
    expect(script).toContain('compgen -f')
    expect(script).toContain('compgen -d')

    const dir = makeTmpDir()
    const scriptPath = path.join(dir, 'troy-advanced.bash')
    fs.writeFileSync(scriptPath, script, 'utf8')

    // 1. Validate Bash syntax with `bash -n`
    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
    expect(syntax.status).toBe(0)
    expect(syntax.stderr).toBe('')

    // 2. Execute live completion probes inside Bash
    const probe = (words: string[], cword: number): string[] => {
      const quoted = words.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(' ')
      const cmd = `source '${scriptPath}' && COMP_WORDS=(${quoted}) && COMP_CWORD=${cword} && _troy_advanced_completions && printf '%s\\n' "\${COMPREPLY[@]}"`
      const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' })
      return out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }

    // Top-level command prefix
    expect(probe(['troy-advanced', 'da'], 1)).toEqual(['daemon'])

    // Subcommand completion
    expect(probe(['troy-advanced', 'daemon', 'l'], 2)).toEqual(['logs'])
    expect(probe(['troy-advanced', 'ec2', ''], 2)).toEqual(['setup', 'compose', 'tunnel'])

    // Positional enum completion for `completions`
    expect(probe(['troy-advanced', 'completions', ''], 2)).toEqual(['bash', 'zsh', 'fish'])

    // Enum flag value completion
    expect(probe(['troy-advanced', 'daemon', 'start', '--engine', ''], 4)).toEqual([
      'auto',
      'chromium',
      'lite',
    ])
    expect(probe(['troy-advanced', 'schema', '--format', 'o'], 3)).toEqual(['openai'])

    // Command-specific + global flag completion
    expect(probe(['troy-advanced', 'ascii', '--den'], 2)).toEqual(['--density', '--deny-origin'])
    expect(probe(['troy-advanced', 'ascii', '--dens'], 2)).toEqual(['--density'])
  })

  it('generates well-formed zsh completion script with #compdef, _arguments, and subcommands', () => {
    const script = generateZshCompletion()
    expect(script.startsWith('#compdef troy-advanced troya\n')).toBe(true)
    expect(script).toContain('_troy_advanced() {')
    expect(script).toContain("_describe -t commands 'troy-advanced command' commands")
    expect(script).toContain("'completions:Generate shell completion scripts (bash, zsh, fish)'")
    expect(script).toContain("'1:completions argument:(bash zsh fish)'")
    expect(script).toContain('--engine[Browser engine]:engine:(auto chromium lite)')
    expect(script).toContain(':endpoint:_files')
    expect(script).toContain(':profiles-dir:_files -/')
    expect(script).toContain('compdef _troy_advanced troy-advanced troya')

    const noHeader = generateZshCompletion({ includeHeader: false, binNames: ['my-troy'] })
    expect(noHeader.startsWith('#compdef my-troy\n_troy_advanced()')).toBe(true)
    expect(noHeader).toContain('compdef _troy_advanced my-troy')
  })

  it('generates well-formed fish completion script with subcommand guards and enum values', () => {
    const script = generateFishCompletion()
    expect(script).toContain('complete -c troy-advanced')
    expect(script).toContain('complete -c troya')
    expect(script).toContain("-n '__fish_use_subcommand' -f -a 'completions'")
    expect(script).toContain(
      "-n '__fish_seen_subcommand_from daemon; and not __fish_seen_subcommand_from start run stop status logs' -f -a 'start'",
    )
    expect(script).toContain("-l engine -r -f -a 'auto chromium lite'")
    expect(script).toContain("-n '__fish_seen_subcommand_from completions; and not __fish_seen_subcommand_from bash zsh fish' -f -a 'bash zsh fish'")
    expect(script).toContain('-l endpoint -r -F')
    expect(script).toContain('-s H -l header -r')
  })

  it('rejects unsafe binary names to prevent shell injection', () => {
    for (const bad of ['troy;rm -rf /', 'troy$(id)', 'troy`id`', 'troy name']) {
      expect(() => generateShellCompletion('bash', { binNames: [bad] })).toThrow(/Invalid binary name/)
      expect(() => generateShellCompletion('zsh', { binNames: [bad] })).toThrow(/Invalid binary name/)
      expect(() => generateShellCompletion('fish', { binNames: [bad] })).toThrow(/Invalid binary name/)
    }
  })

  it('formats install hints for individual shells and all shells combined', () => {
    expect(formatInstallHint('bash')).toContain('eval "$(troy-advanced completions bash)"')
    expect(formatInstallHint('zsh')).toContain('eval "$(troy-advanced completions zsh)"')
    expect(formatInstallHint('fish')).toContain('~/.config/fish/completions/troy-advanced.fish')
    const all = formatInstallHint()
    expect(all).toContain('# Bash')
    expect(all).toContain('# Zsh')
    expect(all).toContain('# Fish')
  })

  it('CLI `completions` command outputs scripts, supports --out, --json, --bin, --install-hint, and errors cleanly', () => {
    const cliBin = path.resolve('bin/troy-advanced.mjs')
    const dir = makeTmpDir()
    const outFile = path.join(dir, 'nested', '_troy-advanced')

    // Build must already exist or we test against dist/cli.js via bin/troy-advanced.mjs;
    // ensure dist/completions.js is built before running CLI subprocess checks.
    const zshOut = spawnSync(
      process.execPath,
      [cliBin, 'completions', 'zsh', '--bin', 'troy-advanced', '--out', outFile, '--json'],
      { encoding: 'utf8' },
    )
    expect(zshOut.status).toBe(0)
    const parsed = JSON.parse(zshOut.stdout) as { ok: boolean; shell: string; out: string; bytes: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.shell).toBe('zsh')
    expect(parsed.out).toBe(outFile)
    expect(parsed.bytes).toBeGreaterThan(500)
    expect(fs.readFileSync(outFile, 'utf8')).toContain('#compdef troy-advanced')

    // --install-hint
    const hintRes = spawnSync(
      process.execPath,
      [cliBin, 'completions', 'fish', '--install-hint'],
      { encoding: 'utf8' },
    )
    expect(hintRes.status).toBe(0)
    expect(hintRes.stdout).toContain('troy-advanced.fish')

    // Invalid shell -> exit code 1
    const badShell = spawnSync(process.execPath, [cliBin, 'completions', 'tcsh'], {
      encoding: 'utf8',
    })
    expect(badShell.status).toBe(1)
    expect(badShell.stderr).toContain('Invalid shell')

    // Missing shell -> exit code 1
    const missingShell = spawnSync(process.execPath, [cliBin, 'completions'], {
      encoding: 'utf8',
    })
    expect(missingShell.status).toBe(1)
    expect(missingShell.stderr).toContain('Usage: troy-advanced completions')
  })
})
