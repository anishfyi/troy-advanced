import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  renderCiWorkflowYaml,
  validateCiWorkflowFile,
  validateCiWorkflowYaml,
} from '../src/cloud/ci-workflow.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CI_WORKFLOW_FILE = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const PACKAGE_JSON_FILE = path.join(REPO_ROOT, 'package.json')

describe('GitHub Actions CI workflow (M87)', () => {
  it('repository .github/workflows/ci.yml exists and passes all CI and security checks with zero errors/warnings', () => {
    expect(fs.existsSync(CI_WORKFLOW_FILE)).toBe(true)

    const result = validateCiWorkflowFile(CI_WORKFLOW_FILE)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.summary).toEqual({
      hasPushTrigger: true,
      hasPullRequestTrigger: true,
      hasUbuntuRunner: true,
      hasNode22OrHigher: true,
      hasNpmCi: true,
      hasTypecheck: true,
      hasBuild: true,
      hasUnitTests: true,
      hasChromeE2e: true,
      hasLeastPrivilegePermissions: true,
      hasConcurrency: true,
      hasJobTimeouts: true,
      hasUnsafePullRequestTarget: false,
    })

    const raw = fs.readFileSync(CI_WORKFLOW_FILE, 'utf8')
    expect(raw).toBe(renderCiWorkflowYaml())
    expect(raw).toContain('runs-on: ubuntu-latest')
    expect(raw).toContain('npm run typecheck')
    expect(raw).toContain('npm run build')
    expect(raw).toContain('npm run test:unit')
    expect(raw).toContain('npm run test:e2e:chrome')
    expect(raw).toContain('TROY_CHROME_BIN')
    expect(raw).toContain('TROY_REQUIRE_CHROME: "1"')
    expect(raw).toContain('doctor --json')
  })

  it('package.json defines every npm script referenced by .github/workflows/ci.yml', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_FILE, 'utf8')) as {
      scripts?: Record<string, string>
      engines?: { node?: string }
    }
    expect(pkg.scripts?.typecheck).toBeTruthy()
    expect(pkg.scripts?.build).toBeTruthy()
    expect(pkg.scripts?.test).toBeTruthy()
    expect(pkg.scripts?.['test:unit']).toBeTruthy()
    expect(pkg.scripts?.['test:e2e:chrome']).toBeTruthy()
    expect(pkg.scripts?.['test:e2e:chrome']).toContain('TROY_REQUIRE_CHROME=1')
    expect(pkg.scripts?.['test:e2e:chrome']).toContain('test/chromium-e2e.test.ts')
    expect(pkg.engines?.node).toContain('22')
  })

  it('renderCiWorkflowYaml supports custom branches, Node matrix, and timeout configurations', () => {
    const customYaml = renderCiWorkflowYaml({
      workflowName: 'Troy CI Matrix',
      branches: ['main', 'release/*'],
      nodeVersions: [22, 24],
      runner: 'ubuntu-24.04',
      unitTimeoutMinutes: 10,
      e2eTimeoutMinutes: 25,
      includeDoctorCheck: false,
      includeFullSuiteInE2e: false,
    })

    const validation = validateCiWorkflowYaml(customYaml)
    expect(validation.ok).toBe(true)
    expect(validation.errors).toEqual([])
    expect(validation.warnings).toEqual([])

    expect(customYaml).toContain('name: Troy CI Matrix')
    expect(customYaml).toContain('branches: [main, release/*]')
    expect(customYaml).toContain('node-version: [22, 24]')
    expect(customYaml).toContain('runs-on: ubuntu-24.04')
    expect(customYaml).toContain('timeout-minutes: 10')
    expect(customYaml).toContain('timeout-minutes: 25')
    expect(customYaml).not.toContain('doctor --json')
    expect(customYaml).not.toContain('Run full test suite with headless Chrome')
  })

  it('renderCiWorkflowYaml rejects invalid workflow names, branches, Node versions, runners, and timeouts', () => {
    expect(() => renderCiWorkflowYaml({ workflowName: '   ' })).toThrow(/Invalid workflowName/)
    expect(() => renderCiWorkflowYaml({ branches: [] })).toThrow(/Invalid branches/)
    expect(() => renderCiWorkflowYaml({ branches: ['bad branch'] })).toThrow(/Invalid branch/)
    expect(() => renderCiWorkflowYaml({ nodeVersions: [] })).toThrow(/Invalid nodeVersions/)
    expect(() => renderCiWorkflowYaml({ nodeVersions: [20] })).toThrow(/requires Node\.js >= 22/)
    expect(() => renderCiWorkflowYaml({ runner: 'ubuntu latest' })).toThrow(/Invalid runner/)
    expect(() => renderCiWorkflowYaml({ unitTimeoutMinutes: 0 })).toThrow(/Invalid unitTimeoutMinutes/)
    expect(() => renderCiWorkflowYaml({ e2eTimeoutMinutes: 500 })).toThrow(/Invalid e2eTimeoutMinutes/)
  })

  it('validateCiWorkflowYaml catches missing gates, unsafe pull_request_target, and missing hardening warnings', () => {
    const weakYaml = `
name: Weak CI
on:
  pull_request_target:
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm install
`
    const res = validateCiWorkflowYaml(weakYaml)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        'missing_push_trigger',
        'missing_pull_request_trigger',
        'unsafe_pull_request_target',
        'missing_ubuntu_runner',
        'missing_node_22',
        'missing_typecheck',
        'missing_build',
        'missing_unit_tests',
        'missing_chrome_e2e',
      ]),
    )
    expect(res.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'missing_npm_ci',
        'missing_least_privilege_permissions',
        'missing_concurrency',
        'missing_job_timeouts',
      ]),
    )
  })
})
