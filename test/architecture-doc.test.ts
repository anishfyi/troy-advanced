import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const ARCH_DOC = path.join(ROOT, 'docs', 'ARCHITECTURE.md')

describe('docs/ARCHITECTURE.md (M92)', () => {
  const content = fs.readFileSync(ARCH_DOC, 'utf8')

  it('exists and covers all major architectural sections', () => {
    expect(fs.existsSync(ARCH_DOC)).toBe(true)
    expect(content.length).toBeGreaterThan(4000)

    const requiredHeadings = [
      '## 1. High-Level System Architecture',
      '## 2. Design Principles & Core Invariants',
      '## 3. Request & Tool Execution Pipeline',
      '## 4. Layer-by-Layer Deep Dive',
      '### 4.1 Frontends & Protocols',
      '### 4.2 Bridge & Discovery',
      '### 4.3 Dual Browser Engines',
      '### 4.4 ASCII Visual & Layout Rendering Pipeline',
      '### 4.5 Security & Defense-in-Depth Architecture',
      '### 4.6 Agent Memory, Refs & Intelligence',
      '### 4.7 Daemon, Cloud Ops & Storage Layout',
      '## 5. Module Directory Reference',
    ]

    for (const heading of requiredHeadings) {
      expect(content, `missing heading: ${heading}`).toContain(heading)
    }
  })

  it('contains strict 7-bit ASCII system diagrams within 100 columns', () => {
    const diagramMatches = [...content.matchAll(/```text\n([\s\S]*?)```/g)]
    expect(diagramMatches.length).toBeGreaterThanOrEqual(5)

    for (const [idx, match] of diagramMatches.entries()) {
      const diagram = match[1]
      expect(diagram.trim().length, `diagram #${idx + 1} should not be empty`).toBeGreaterThan(50)

      // Strict 7-bit printable ASCII + newline only
      expect(
        /^[\x20-\x7e\n]+$/.test(diagram),
        `diagram #${idx + 1} contains non-7-bit ASCII characters`,
      ).toBe(true)

      const lines = diagram.split('\n')
      const maxLen = Math.max(...lines.map((l) => l.length))
      expect(maxLen, `diagram #${idx + 1} exceeds 100-column width (${maxLen})`).toBeLessThanOrEqual(100)
    }
  })

  it('references only real files and directories that exist in the repository', () => {
    // Match backticked paths like `src/engine/manager.ts`, `bin/troy-advanced.mjs`, `deploy/ec2-bootstrap.sh`
    const pathMatches = [
      ...content.matchAll(/`((?:src|bin|scripts|deploy|skills)\/[A-Za-z0-9_./-]+)`/g),
    ]
    expect(pathMatches.length).toBeGreaterThan(25)

    const missing: string[] = []
    for (const match of pathMatches) {
      const rel = match[1]
      // Skip wildcard patterns like `src/ascii/*`
      if (rel.includes('*') || rel.includes('...')) continue
      const full = path.join(ROOT, rel)
      if (!fs.existsSync(full)) {
        missing.push(rel)
      }
    }

    expect(missing, `stale paths in docs/ARCHITECTURE.md: ${missing.join(', ')}`).toEqual([])
  })

  it('documents every top-level subsystem directory under src/', () => {
    const srcDirs = fs
      .readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)

    expect(srcDirs.length).toBeGreaterThanOrEqual(8)
    for (const dir of srcDirs) {
      expect(content, `src/${dir}/ is not documented in docs/ARCHITECTURE.md`).toContain(`src/${dir}/`)
    }
  })

  it('is linked from README.md and included in package.json files', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('docs/ARCHITECTURE.md')

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(pkg.files).toContain('docs')
  })
})
