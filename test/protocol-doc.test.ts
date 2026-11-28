import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOLS,
} from '../src/mcp/server.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PROTOCOL_DOC = path.join(ROOT, 'docs', 'PROTOCOL.md')

describe('docs/PROTOCOL.md (M93)', () => {
  const content = fs.readFileSync(PROTOCOL_DOC, 'utf8')

  it('exists and covers all required protocol sections', () => {
    expect(fs.existsSync(PROTOCOL_DOC)).toBe(true)
    expect(content.length).toBeGreaterThan(6000)

    const requiredHeadings = [
      '## 1. Transport Overview & Discovery',
      '## 2. HTTP Agent Socket Protocol',
      '## 3. Streaming SSE Protocol (`GET /stream`)',
      '## 4. WebSocket Bridge Protocol (`GET /ws`, `troy-ws-v1`)',
      '## 5. Model Context Protocol (MCP) over Stdio',
      '## 6. Streaming Pipe REPL Protocol (`troy-advanced pipe`)',
      '## 7. Cross-Protocol Invariants',
    ]

    for (const heading of requiredHeadings) {
      expect(content, `missing heading: ${heading}`).toContain(heading)
    }
  })

  it('contains strict 7-bit ASCII diagrams within 100 columns', () => {
    const diagramMatches = [...content.matchAll(/```text\n([\s\S]*?)```/g)]
    expect(diagramMatches.length).toBeGreaterThanOrEqual(2)

    // First two text blocks are the system/guard ASCII diagrams (skip wire-format examples if longer)
    for (let idx = 0; idx < 2; idx++) {
      const diagram = diagramMatches[idx]![1]!
      expect(diagram.trim().length, `diagram #${idx + 1} should not be empty`).toBeGreaterThan(50)
      expect(
        /^[\x20-\x7e\n]+$/.test(diagram),
        `diagram #${idx + 1} contains non-7-bit ASCII characters`,
      ).toBe(true)
      const lines = diagram.split('\n')
      const maxLen = Math.max(...lines.map((l) => l.length))
      expect(maxLen, `diagram #${idx + 1} exceeds 100-column width (${maxLen})`).toBeLessThanOrEqual(100)
    }
  })

  it('documents every HTTP Agent Socket route implemented in src/bridge/agent-socket.ts', () => {
    const agentSocketSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'agent-socket.ts'), 'utf8')
    const routeMatches = [...agentSocketSrc.matchAll(/case\s+'(\/[a-z0-9/_-]+)':/g)]
    const routes = [...new Set(routeMatches.map((m) => m[1]!))]
    expect(routes.length).toBeGreaterThanOrEqual(25)

    const missingRoutes = routes.filter((route) => !content.includes(`\`${route}\``))
    expect(missingRoutes, `undocumented Agent Socket routes: ${missingRoutes.join(', ')}`).toEqual([])

    // Also verify health probes and streaming endpoints
    for (const extraRoute of ['/healthz', '/livez', '/readyz', '/stream', '/ws']) {
      expect(content, `missing route ${extraRoute}`).toContain(extraRoute)
    }
  })

  it('documents every MCP tool, resource, template, and prompt from src/mcp/server.ts', () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(15)
    for (const tool of MCP_TOOLS) {
      expect(content, `missing MCP tool: ${tool.name}`).toContain(`\`${tool.name}\``)
    }
    for (const resource of MCP_RESOURCES) {
      expect(content, `missing MCP resource: ${resource.uri}`).toContain(`\`${resource.uri}\``)
    }
    for (const template of MCP_RESOURCE_TEMPLATES) {
      expect(content, `missing MCP resource template: ${template.uriTemplate}`).toContain(
        `\`${template.uriTemplate}\``,
      )
    }
    for (const prompt of MCP_PROMPTS) {
      expect(content, `missing MCP prompt: ${prompt.name}`).toContain(`\`${prompt.name}\``)
    }
  })

  it('documents all deterministic safety refusal codes and Pipe REPL commands', () => {
    const refusalCodes = [
      'readonly',
      'policy_tool_blocked',
      'policy_eval_disabled',
      'scheme',
      'ssrf',
      'origin_denied',
      'sensitive',
      'origin',
      'submit',
    ]
    for (const code of refusalCodes) {
      expect(content, `missing refusal code: ${code}`).toContain(`\`${code}\``)
    }

    const pipeVerbs = [
      'open',
      'ascii',
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
      'tabs',
      'grant',
      'recall',
      'emulate',
      'downloads',
      'dialogs',
      'network',
      'quit',
    ]
    for (const verb of pipeVerbs) {
      expect(content, `missing Pipe REPL verb: ${verb}`).toContain(`\`${verb}`)
    }
  })

  it('references only real files that exist in the repository', () => {
    const pathMatches = [...content.matchAll(/`(src\/[A-Za-z0-9_./-]+)`/g)]
    expect(pathMatches.length).toBeGreaterThanOrEqual(15)

    const missing: string[] = []
    for (const match of pathMatches) {
      const rel = match[1]!
      if (rel.includes('*') || rel.includes('...')) continue
      if (!fs.existsSync(path.join(ROOT, rel))) {
        missing.push(rel)
      }
    }
    expect(missing, `stale paths in docs/PROTOCOL.md: ${missing.join(', ')}`).toEqual([])
  })

  it('is linked from README.md and included in package.json files', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('docs/PROTOCOL.md')

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(pkg.files).toContain('docs')
  })
})
