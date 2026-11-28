import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintPaths, lintSource, RULES } from '../scripts/lint.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint.mjs')

function rulesOf(filePath: string, code: string): string[] {
  return lintSource(filePath, code, { rootDir: REPO_ROOT }).map((d) => d.rule)
}

describe('Strict static linter (scripts/lint.mjs)', () => {
  it('exposes metadata for all configured lint rules', () => {
    const ruleIds = Object.keys(RULES)
    expect(ruleIds.length).toBeGreaterThanOrEqual(15)
    for (const id of ruleIds) {
      const meta = (RULES as Record<string, { severity: string; description: string }>)[id]!
      expect(meta.severity).toBe('error')
      expect(meta.description.length).toBeGreaterThan(5)
    }
  })

  it('catches no-var, no-debugger, and no-with', () => {
    expect(rulesOf('src/a.ts', 'var x = 1\nexport { x }\n')).toContain('no-var')
    expect(rulesOf('src/a.ts', 'export function f() { debugger }\n')).toContain('no-debugger')
    expect(rulesOf('scripts/a.mjs', 'export function f(o) { with (o) { return 1 } }\n')).toContain('no-with')
  })

  it('enforces eqeqeq while allowing idiomatic == null / != null', () => {
    expect(rulesOf('src/a.ts', 'export const eq = (a: number, b: number) => a == b\n')).toContain('eqeqeq')
    expect(rulesOf('src/a.ts', 'export const neq = (a: number, b: number) => a != b\n')).toContain('eqeqeq')
    expect(rulesOf('src/a.ts', 'export const isNil = (a: unknown) => a == null\n')).toEqual([])
    expect(rulesOf('src/a.ts', 'export const notNil = (a: unknown) => a != null\n')).toEqual([])
  })

  it('enforces no-explicit-any in src/ files only', () => {
    expect(rulesOf('src/a.ts', 'export function f(x: any): unknown { return x }\n')).toContain('no-explicit-any')
    expect(rulesOf('test/a.test.ts', 'export function f(x: any): unknown { return x }\n')).toEqual([])
  })

  it('catches no-eval for eval() and new Function()', () => {
    expect(rulesOf('src/a.ts', 'export const r = eval("1+1")\n')).toContain('no-eval')
    expect(rulesOf('src/a.ts', 'export const fn = new Function("return 1")\n')).toContain('no-eval')
  })

  it('catches no-duplicate-imports while allowing separate type and value imports', () => {
    expect(
      rulesOf(
        'src/a.ts',
        "import { a } from './b.js'\nimport { c } from './b.js'\nexport const x = [a, c]\n",
      ),
    ).toContain('no-duplicate-imports')

    expect(
      rulesOf(
        'src/a.ts',
        "import type { Foo } from './b.js'\nimport type { Bar } from './b.js'\nexport type T = Foo | Bar\n",
      ),
    ).toContain('no-duplicate-imports')

    // Separate value and type-only imports from same module are allowed
    expect(
      rulesOf(
        'src/a.ts',
        "import { a } from './b.js'\nimport type { Foo } from './b.js'\nexport const x: Foo = a\n",
      ),
    ).toEqual([])
  })

  it('enforces esm-relative-js-extension in src/', () => {
    expect(rulesOf('src/a.ts', "import { foo } from './foo'\nexport { foo }\n")).toContain(
      'esm-relative-js-extension',
    )
    expect(rulesOf('src/a.ts', "export { foo } from '../bar'\n")).toContain('esm-relative-js-extension')
    expect(rulesOf('src/a.ts', "import { foo } from './foo.js'\nexport { foo }\n")).toEqual([])
    expect(rulesOf('src/a.ts', "import pkg from '../package.json'\nexport { pkg }\n")).toEqual([])
  })

  it('catches no-self-compare and no-self-assign', () => {
    expect(rulesOf('src/a.ts', 'export const f = (x: number) => x === x\n')).toContain('no-self-compare')
    expect(rulesOf('src/a.ts', 'export function f(x: number) { x = x; return x }\n')).toContain('no-self-assign')
  })

  it('catches no-unsafe-finally while allowing return inside nested functions in finally', () => {
    expect(
      rulesOf('src/a.ts', 'export function f() { try { return 1 } finally { return 2 } }\n'),
    ).toContain('no-unsafe-finally')
    expect(
      rulesOf('src/a.ts', 'export function f() { try { return 1 } finally { throw new Error("x") } }\n'),
    ).toContain('no-unsafe-finally')
    expect(
      rulesOf('src/a.ts', 'export function f() { try { return 1 } finally { const g = () => { return 2 }; g() } }\n'),
    ).toEqual([])
  })

  it('catches no-shadow-restricted-names, no-duplicate-case, no-empty-interface, no-throw-literal', () => {
    expect(rulesOf('src/a.ts', 'export function f(undefined: number) { return undefined }\n')).toContain(
      'no-shadow-restricted-names',
    )
    expect(
      rulesOf('src/a.ts', 'export function f(x: number) { switch (x) { case 1: return 1; case 1: return 2; default: return 0 } }\n'),
    ).toContain('no-duplicate-case')
    expect(rulesOf('src/a.ts', 'export interface Empty {}\n')).toContain('no-empty-interface')
    expect(rulesOf('src/a.ts', 'export interface Derived extends Error {}\n')).toEqual([])
    expect(rulesOf('src/a.ts', 'export function f() { throw "bad" }\n')).toContain('no-throw-literal')
    expect(rulesOf('src/a.ts', 'export function f() { throw new Error("ok") }\n')).toEqual([])
  })

  it('enforces prefer-const accurately without false positives on reassigned bindings', () => {
    expect(rulesOf('src/a.ts', 'export function f() { let x = 1; return x }\n')).toContain('prefer-const')
    expect(rulesOf('src/a.ts', 'export function f() { let x = 1; x += 2; return x }\n')).toEqual([])
    expect(rulesOf('src/a.ts', 'export function f() { let x = 0; x++; return x }\n')).toEqual([])
    expect(rulesOf('src/a.ts', 'export function f() { let x: number; x = 1; return x }\n')).toEqual([])
  })

  it('checks formatting hygiene (no-crlf, no-trailing-whitespace, eol-last)', () => {
    expect(rulesOf('src/a.ts', 'export const x = 1\r\n')).toContain('no-crlf')
    expect(rulesOf('src/a.ts', 'export const x = 1   \n')).toContain('no-trailing-whitespace')
    expect(rulesOf('src/a.ts', 'export const x = 1')).toContain('eol-last')
    // Multi-line template literals with intentional trailing spaces are allowed
    expect(rulesOf('src/a.ts', 'export const art = `\nline 1  \nline 2\n`\n')).toEqual([])
  })

  it('supports inline disable directives for specific rules or all rules', () => {
    const specific = [
      '// lint-disable-next-line no-explicit-any',
      'export function f(x: any): unknown { return x }',
      '',
    ].join('\n')
    expect(rulesOf('src/a.ts', specific)).toEqual([])

    const wrongRule = [
      '// lint-disable-next-line no-var',
      'export function f(x: any): unknown { return x }',
      '',
    ].join('\n')
    expect(rulesOf('src/a.ts', wrongRule)).toContain('no-explicit-any')

    const eslintAlias = [
      '// eslint-disable-next-line prefer-const',
      'export function f() { let x = 1; return x }',
      '',
    ].join('\n')
    expect(rulesOf('src/a.ts', eslintAlias)).toEqual([])
  })

  it('passes cleanly across the entire repository via lintPaths and CLI --json', () => {
    const result = lintPaths(undefined, { rootDir: REPO_ROOT })
    expect(result.ok).toBe(true)
    expect(result.errorCount).toBe(0)
    expect(result.filesChecked).toBeGreaterThan(150)

    const raw = execFileSync(process.execPath, [LINT_SCRIPT, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    const parsed = JSON.parse(raw) as { ok: boolean; filesChecked: number; errorCount: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.errorCount).toBe(0)
    expect(parsed.filesChecked).toBe(result.filesChecked)
  })
})
