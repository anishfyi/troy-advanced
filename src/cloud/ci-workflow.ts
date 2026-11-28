// GitHub Actions CI workflow generator and validator for troy-advanced.
// Ensures Ubuntu Linux CI runs typecheck, build, unit tests, and headless Chrome E2E
// with least-privilege permissions, concurrency cancellation, and explicit timeouts.

import fs from 'node:fs'

export const DEFAULT_CI_WORKFLOW_NAME = 'CI'
export const DEFAULT_CI_BRANCHES = ['main']
export const DEFAULT_CI_NODE_VERSIONS = [22]
export const DEFAULT_CI_RUNNER = 'ubuntu-latest'
export const DEFAULT_CI_UNIT_TIMEOUT_MINUTES = 15
export const DEFAULT_CI_E2E_TIMEOUT_MINUTES = 20

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/*-]+$/
const SAFE_RUNNER_RE = /^[a-zA-Z0-9._-]+$/

export interface CiWorkflowOptions {
  workflowName?: string
  branches?: string[]
  nodeVersions?: number[]
  runner?: string
  includeChromeE2e?: boolean
  includeDoctorCheck?: boolean
  includeFullSuiteInE2e?: boolean
  unitTimeoutMinutes?: number
  e2eTimeoutMinutes?: number
}

export interface CiWorkflowValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
}

export interface CiWorkflowValidationResult {
  ok: boolean
  errors: CiWorkflowValidationIssue[]
  warnings: CiWorkflowValidationIssue[]
  summary: {
    hasPushTrigger: boolean
    hasPullRequestTrigger: boolean
    hasUbuntuRunner: boolean
    hasNode22OrHigher: boolean
    hasNpmCi: boolean
    hasTypecheck: boolean
    hasBuild: boolean
    hasUnitTests: boolean
    hasChromeE2e: boolean
    hasLeastPrivilegePermissions: boolean
    hasConcurrency: boolean
    hasJobTimeouts: boolean
    hasUnsafePullRequestTarget: boolean
  }
}

function assertPositiveTimeout(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 360) {
    throw new Error(`Invalid ${label} "${value}": must be an integer between 1 and 360`)
  }
}

/**
 * Render a hardened GitHub Actions CI workflow YAML for Ubuntu Linux
 * running typecheck, build, unit tests, and headless Chrome E2E.
 */
export function renderCiWorkflowYaml(opts: CiWorkflowOptions = {}): string {
  const workflowName = (opts.workflowName ?? DEFAULT_CI_WORKFLOW_NAME).trim()
  if (!workflowName) {
    throw new Error('Invalid workflowName: must not be empty')
  }

  const branches = opts.branches ?? DEFAULT_CI_BRANCHES
  if (branches.length === 0) {
    throw new Error('Invalid branches: must include at least one branch')
  }
  for (const branch of branches) {
    if (!SAFE_BRANCH_RE.test(branch)) {
      throw new Error(`Invalid branch "${branch}": must match ${SAFE_BRANCH_RE.source}`)
    }
  }

  const nodeVersions = opts.nodeVersions ?? DEFAULT_CI_NODE_VERSIONS
  if (nodeVersions.length === 0) {
    throw new Error('Invalid nodeVersions: must include at least one Node.js major version')
  }
  for (const ver of nodeVersions) {
    if (!Number.isInteger(ver) || ver < 22) {
      throw new Error(`Invalid nodeVersion "${ver}": troy-advanced requires Node.js >= 22`)
    }
  }

  const runner = opts.runner ?? DEFAULT_CI_RUNNER
  if (!SAFE_RUNNER_RE.test(runner)) {
    throw new Error(`Invalid runner "${runner}": must match ${SAFE_RUNNER_RE.source}`)
  }

  const unitTimeoutMinutes = opts.unitTimeoutMinutes ?? DEFAULT_CI_UNIT_TIMEOUT_MINUTES
  const e2eTimeoutMinutes = opts.e2eTimeoutMinutes ?? DEFAULT_CI_E2E_TIMEOUT_MINUTES
  assertPositiveTimeout(unitTimeoutMinutes, 'unitTimeoutMinutes')
  assertPositiveTimeout(e2eTimeoutMinutes, 'e2eTimeoutMinutes')

  const includeChromeE2e = opts.includeChromeE2e !== false
  const includeDoctorCheck = opts.includeDoctorCheck !== false
  const includeFullSuiteInE2e = opts.includeFullSuiteInE2e !== false
  const primaryNodeVersion = nodeVersions[0]!

  const lines: string[] = [
    '# GitHub Actions CI workflow for troy-advanced',
    '# Runs typecheck, TypeScript build, unit tests, and headless Chrome E2E on Ubuntu Linux.',
    `name: ${workflowName}`,
    '',
    'on:',
    '  push:',
    `    branches: [${branches.join(', ')}]`,
    '  pull_request:',
    `    branches: [${branches.join(', ')}]`,
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    '  group: ci-${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  typecheck-build-unit:',
    '    name: Typecheck, Build & Unit Tests (Node ${{ matrix.node-version }})',
    `    runs-on: ${runner}`,
    `    timeout-minutes: ${unitTimeoutMinutes}`,
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    `        node-version: [${nodeVersions.join(', ')}]`,
    '    steps:',
    '      - name: Checkout repository',
    '        uses: actions/checkout@v4',
    '',
    '      - name: Setup Node.js',
    '        uses: actions/setup-node@v4',
    '        with:',
    '          node-version: ${{ matrix.node-version }}',
    '          cache: npm',
    '',
    '      - name: Install dependencies',
    '        run: npm ci',
    '',
    '      - name: Lint',
    '        run: npm run lint',
    '',
    '      - name: Typecheck',
    '        run: npm run typecheck',
    '',
    '      - name: Build',
    '        run: npm run build',
    '',
    '      - name: Run unit tests',
    '        run: npm run test:unit',
  ]

  if (includeChromeE2e) {
    lines.push(
      '',
      '  chromium-e2e:',
      '    name: Headless Chrome E2E (Ubuntu Linux)',
      `    runs-on: ${runner}`,
      '    needs: typecheck-build-unit',
      `    timeout-minutes: ${e2eTimeoutMinutes}`,
      '    steps:',
      '      - name: Checkout repository',
      '        uses: actions/checkout@v4',
      '',
      '      - name: Setup Node.js',
      '        uses: actions/setup-node@v4',
      '        with:',
      `          node-version: ${primaryNodeVersion}`,
      '          cache: npm',
      '',
      '      - name: Install dependencies',
      '        run: npm ci',
      '',
      '      - name: Build',
      '        run: npm run build',
      '',
      '      - name: Ensure headless Chrome/Chromium is available',
      '        run: |',
      '          CHROME_BIN=""',
      '          for cand in google-chrome-stable google-chrome chromium chromium-browser; do',
      '            if command -v "$cand" >/dev/null 2>&1; then',
      '              CHROME_BIN="$(command -v "$cand")"',
      '              break',
      '            fi',
      '          done',
      '          if [ -z "$CHROME_BIN" ]; then',
      '            sudo apt-get update',
      '            sudo apt-get install -y --no-install-recommends chromium-browser fonts-liberation || sudo apt-get install -y --no-install-recommends chromium fonts-liberation',
      '            CHROME_BIN="$(command -v chromium-browser || command -v chromium || true)"',
      '          fi',
      '          if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then',
      '            echo "Failed to locate an executable Chrome/Chromium binary" >&2',
      '            exit 1',
      '          fi',
      '          echo "TROY_CHROME_BIN=$CHROME_BIN" >> "$GITHUB_ENV"',
      '          "$CHROME_BIN" --version',
    )

    if (includeDoctorCheck) {
      lines.push(
        '',
        '      - name: Verify Chrome detection with troy-advanced doctor',
        '        run: |',
        '          node ./bin/troy-advanced.mjs doctor --json | node -e "const d = JSON.parse(require(\'fs\').readFileSync(0, \'utf8\')); if (!d.chromeBinary) { console.error(\'Chrome not detected by doctor:\', d); process.exit(1); } console.log(\'Doctor detected Chrome:\', d.chromeBinary);"',
      )
    }

    lines.push(
      '',
      '      - name: Run headless Chrome E2E suite',
      '        env:',
      '          TROY_REQUIRE_CHROME: "1"',
      '        run: npm run test:e2e:chrome',
    )

    if (includeFullSuiteInE2e) {
      lines.push(
        '',
        '      - name: Run full test suite with headless Chrome',
        '        env:',
        '          TROY_REQUIRE_CHROME: "1"',
        '        run: npm test',
      )
    }
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Validate a GitHub Actions CI workflow YAML against troy-advanced CI gates and security checks.
 */
export function validateCiWorkflowYaml(yaml: string): CiWorkflowValidationResult {
  const errors: CiWorkflowValidationIssue[] = []
  const warnings: CiWorkflowValidationIssue[] = []

  const hasPushTrigger = /^\s*push\s*:/m.test(yaml)
  const hasPullRequestTrigger = /^\s*pull_request\s*:/m.test(yaml)
  const hasUnsafePullRequestTarget = /^\s*pull_request_target\s*:/m.test(yaml)
  const hasUbuntuRunner = /^\s*runs-on\s*:\s*["']?ubuntu-/m.test(yaml)
  const hasNode22OrHigher =
    /node-version\s*:\s*\[[^\]]*\b(2[2-9]|[3-9][0-9])\b/.test(yaml) ||
    /node-version\s*:\s*["']?(2[2-9]|[3-9][0-9])(?:\.x)?["']?/.test(yaml)
  const hasNpmCi = /\bnpm\s+ci\b/.test(yaml)
  const hasTypecheck = /\bnpm\s+run\s+typecheck\b/.test(yaml)
  const hasBuild = /\bnpm\s+run\s+build\b/.test(yaml)
  const hasUnitTests = /\bnpm\s+(?:run\s+test:unit|test)\b/.test(yaml)
  const hasChromeE2e =
    /\b(?:test:e2e:chrome|chromium-e2e\.test\.ts)\b/.test(yaml) &&
    /\bTROY_CHROME_BIN\b/.test(yaml)
  const hasLeastPrivilegePermissions =
    /^\s*permissions\s*:/m.test(yaml) && /^\s*contents\s*:\s*read\b/m.test(yaml)
  const hasConcurrency =
    /^\s*concurrency\s*:/m.test(yaml) && /^\s*cancel-in-progress\s*:\s*true\b/m.test(yaml)
  const hasJobTimeouts = /^\s*timeout-minutes\s*:\s*\d+/m.test(yaml)

  if (!hasPushTrigger) {
    errors.push({
      severity: 'error',
      code: 'missing_push_trigger',
      message: 'CI workflow must trigger on push events',
    })
  }
  if (!hasPullRequestTrigger) {
    errors.push({
      severity: 'error',
      code: 'missing_pull_request_trigger',
      message: 'CI workflow must trigger on pull_request events',
    })
  }
  if (hasUnsafePullRequestTarget) {
    errors.push({
      severity: 'error',
      code: 'unsafe_pull_request_target',
      message: 'Avoid pull_request_target in CI workflows to prevent untrusted code execution with elevated secrets',
    })
  }
  if (!hasUbuntuRunner) {
    errors.push({
      severity: 'error',
      code: 'missing_ubuntu_runner',
      message: 'CI workflow must run on an Ubuntu Linux runner (runs-on: ubuntu-latest)',
    })
  }
  if (!hasNode22OrHigher) {
    errors.push({
      severity: 'error',
      code: 'missing_node_22',
      message: 'CI workflow must configure Node.js >= 22 (matching package.json engines)',
    })
  }
  if (!hasTypecheck) {
    errors.push({
      severity: 'error',
      code: 'missing_typecheck',
      message: 'CI workflow must run `npm run typecheck`',
    })
  }
  if (!hasBuild) {
    errors.push({
      severity: 'error',
      code: 'missing_build',
      message: 'CI workflow must run `npm run build`',
    })
  }
  if (!hasUnitTests) {
    errors.push({
      severity: 'error',
      code: 'missing_unit_tests',
      message: 'CI workflow must run unit tests (`npm run test:unit` or `npm test`)',
    })
  }
  if (!hasChromeE2e) {
    errors.push({
      severity: 'error',
      code: 'missing_chrome_e2e',
      message: 'CI workflow must configure TROY_CHROME_BIN and run headless Chrome E2E tests',
    })
  }

  if (!hasNpmCi) {
    warnings.push({
      severity: 'warning',
      code: 'missing_npm_ci',
      message: 'Prefer `npm ci` over `npm install` for reproducible lockfile builds',
    })
  }
  if (!hasLeastPrivilegePermissions) {
    warnings.push({
      severity: 'warning',
      code: 'missing_least_privilege_permissions',
      message: 'Declare explicit `permissions: contents: read` at the workflow level',
    })
  }
  if (!hasConcurrency) {
    warnings.push({
      severity: 'warning',
      code: 'missing_concurrency',
      message: 'Declare `concurrency` with `cancel-in-progress: true` to cancel redundant runs',
    })
  }
  if (!hasJobTimeouts) {
    warnings.push({
      severity: 'warning',
      code: 'missing_job_timeouts',
      message: 'Set `timeout-minutes` on CI jobs to prevent hung runners',
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      hasPushTrigger,
      hasPullRequestTrigger,
      hasUbuntuRunner,
      hasNode22OrHigher,
      hasNpmCi,
      hasTypecheck,
      hasBuild,
      hasUnitTests,
      hasChromeE2e,
      hasLeastPrivilegePermissions,
      hasConcurrency,
      hasJobTimeouts,
      hasUnsafePullRequestTarget,
    },
  }
}

export function validateCiWorkflowFile(filePath: string): CiWorkflowValidationResult {
  const raw = fs.readFileSync(filePath, 'utf8')
  return validateCiWorkflowYaml(raw)
}
