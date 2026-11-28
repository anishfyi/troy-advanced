import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const EC2_GUIDE_DOC = path.join(ROOT, 'docs', 'EC2_GUIDE.md')

describe('docs/EC2_GUIDE.md (M94)', () => {
  const content = fs.readFileSync(EC2_GUIDE_DOC, 'utf8')

  it('exists and covers all required EC2 production operations sections', () => {
    expect(fs.existsSync(EC2_GUIDE_DOC)).toBe(true)
    expect(content.length).toBeGreaterThan(8000)

    const requiredHeadings = [
      '## 1. Production Topology',
      '## 2. EC2 Instance Sizing (`t3` vs `t4g` Graviton)',
      '## 3. IAM & IMDSv2 Hardening',
      '## 4. Bootstrapping & systemd Production Service',
      '## 5. Docker Compose Deployment on EC2',
      '## 6. SSH Loopback Tunneling & Remote Control',
      '## 7. Session Hydration, Profiles & Egress Proxies',
      '## 8. Memory Watchdog, Health Probes & Observability',
      '## 9. Pre-Flight Verification & Troubleshooting Runbook',
    ]

    for (const heading of requiredHeadings) {
      expect(content, `missing heading: ${heading}`).toContain(heading)
    }
  })

  it('contains strict 7-bit ASCII diagrams within 100 columns', () => {
    const diagramMatches = [...content.matchAll(/```text\n([\s\S]*?)```/g)]
    expect(diagramMatches.length).toBeGreaterThanOrEqual(2)

    for (let idx = 0; idx < diagramMatches.length; idx++) {
      const diagram = diagramMatches[idx]![1]!
      expect(diagram.trim().length, `diagram #${idx + 1} should not be empty`).toBeGreaterThan(40)
      expect(
        /^[\x20-\x7e\n]+$/.test(diagram),
        `diagram #${idx + 1} contains non-7-bit ASCII characters`,
      ).toBe(true)
      const lines = diagram.split('\n')
      const maxLen = Math.max(...lines.map((l) => l.length))
      expect(maxLen, `diagram #${idx + 1} exceeds 100-column width (${maxLen})`).toBeLessThanOrEqual(100)
    }
  })

  it('covers t3/t4g instance sizing, IMDSv2 hardening, systemd, and SSH tunneling details', () => {
    const requiredTerms = [
      't4g.nano',
      't4g.micro',
      't3.small',
      't4g.small',
      't3.medium',
      't4g.medium',
      't3.large',
      't4g.large',
      'HttpTokens=required',
      'HttpPutResponseHopLimit=1',
      '169.254.169.254',
      '169.254.170.2',
      'systemd',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ExitOnForwardFailure=yes',
      'ServerAliveInterval=30',
      'StrictHostKeyChecking=accept-new',
      'AWS-StartPortForwardingSession',
      'shm_size',
      '/healthz',
      '/livez',
      '/readyz',
      '/metrics',
    ]

    for (const term of requiredTerms) {
      expect(content, `missing EC2 operations term: ${term}`).toContain(term)
    }
  })

  it('references only real repository files (src/* and deploy/*)', () => {
    const pathMatches = [...content.matchAll(/`((?:src|deploy)\/[A-Za-z0-9_./-]+)`/g)]
    expect(pathMatches.length).toBeGreaterThanOrEqual(12)

    const missing: string[] = []
    for (const match of pathMatches) {
      const rel = match[1]!
      if (rel.includes('*') || rel.includes('...')) continue
      if (!fs.existsSync(path.join(ROOT, rel))) {
        missing.push(rel)
      }
    }
    expect(missing, `stale paths in docs/EC2_GUIDE.md: ${missing.join(', ')}`).toEqual([])

    for (const rootFile of ['Dockerfile', 'docker-compose.yml']) {
      expect(content).toContain(rootFile)
      expect(fs.existsSync(path.join(ROOT, rootFile))).toBe(true)
    }
  })

  it('cites only real Prometheus metrics implemented in src/bridge/metrics.ts', () => {
    const metricsSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'metrics.ts'), 'utf8')
    const citedMetrics = [...new Set([...content.matchAll(/`(troy_[a-z0-9_]+)`/g)].map((m) => m[1]!))]
    expect(citedMetrics.length).toBeGreaterThanOrEqual(8)

    const unknown = citedMetrics.filter((name) => !metricsSrc.includes(`'${name}'`))
    expect(unknown, `unknown Prometheus metrics in docs/EC2_GUIDE.md: ${unknown.join(', ')}`).toEqual([])
  })

  it('documents real CLI flags implemented in src/cli.ts', () => {
    const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8')
    const flags = [
      '--block-private-net',
      '--ssrf-allow-host',
      '--policy',
      '--allow-origin',
      '--deny-origin',
      '--readonly',
      '--redact-secrets',
      '--untrusted-markers',
      '--max-rss-mb',
      '--watchdog-interval-ms',
      '--watchdog-idle-ttl-ms',
      '--public-metrics',
      '--no-health-probe',
      '--proxy',
      '--proxy-bypass',
      '--no-env-proxy',
      '--cdp-url',
      '--no-imds',
      '--log-max-bytes',
      '--log-max-files',
    ]

    for (const flag of flags) {
      expect(content, `docs/EC2_GUIDE.md should document ${flag}`).toContain(flag)
      expect(cliSrc, `src/cli.ts should implement ${flag}`).toContain(flag)
    }
  })

  it('is linked from README.md and included in package.json files', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('docs/EC2_GUIDE.md')

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(pkg.files).toContain('docs')
  })
})
