import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOLS,
  parseMcpFramingMode,
} from '../src/mcp/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'troy-advanced')
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md')
const PLUGIN_JSON_PATH = path.join(SKILL_DIR, '.claude-plugin', 'plugin.json')
const MCP_JSON_PATH = path.join(SKILL_DIR, '.mcp.json')
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json')

interface ParsedFrontmatter {
  raw: string
  body: string
  fields: Record<string, string | string[]>
}

function parseSkillFrontmatter(markdown: string): ParsedFrontmatter {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) {
    throw new Error('SKILL.md is missing valid YAML frontmatter delimited by ---')
  }
  const raw = match[1]!
  const body = match[2]!
  const fields: Record<string, string | string[]> = {}
  const lines = raw.split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (!kv) {
      i++
      continue
    }
    const key = kv[1]!
    const rest = kv[2]!.trim()

    if (rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
      const folded: string[] = []
      i++
      while (i < lines.length && (/^\s+/.test(lines[i]!) || lines[i]!.trim() === '')) {
        if (lines[i]!.trim()) folded.push(lines[i]!.trim())
        i++
      }
      fields[key] = folded.join(' ')
      continue
    }

    if (rest === '') {
      const list: string[] = []
      i++
      while (i < lines.length && /^\s+-\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '')
        list.push(item)
        i++
      }
      fields[key] = list
      continue
    }

    fields[key] = rest.replace(/^["']|["']$/g, '')
    i++
  }

  return { raw, body, fields }
}

describe('M58: skills/troy-advanced SKILL.md & Claude Code plugin manifest', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    name: string
    version: string
    license: string
    files?: string[]
  }

  describe('SKILL.md structure & frontmatter', () => {
    it('exists and parses cleanly with required Claude Code / Dexter / Codex frontmatter', () => {
      expect(fs.existsSync(SKILL_MD_PATH)).toBe(true)
      const content = fs.readFileSync(SKILL_MD_PATH, 'utf8')
      const { fields, body } = parseSkillFrontmatter(content)

      expect(fields.name).toBe('troy-advanced')
      expect(typeof fields.description).toBe('string')
      expect((fields.description as string).length).toBeGreaterThan(40)
      expect((fields.description as string).length).toBeLessThanOrEqual(1024)
      expect(fields.version).toBe(pkg.version)
      expect(fields.license).toBe(pkg.license)

      expect(Array.isArray(fields.compatibility)).toBe(true)
      const compat = fields.compatibility as string[]
      expect(compat).toEqual(expect.arrayContaining(['claude-code', 'dexter', 'codex', 'mcp']))

      expect(Array.isArray(fields.triggers)).toBe(true)
      expect((fields.triggers as string[]).length).toBeGreaterThanOrEqual(5)

      expect(body.trim().length).toBeGreaterThan(500)
    })

    it('documents every MCP tool, resource, resource template, and prompt with zero drift', () => {
      const content = fs.readFileSync(SKILL_MD_PATH, 'utf8')

      for (const tool of MCP_TOOLS) {
        expect(content, `SKILL.md should document MCP tool ${tool.name}`).toContain(`\`${tool.name}\``)
      }

      for (const resource of MCP_RESOURCES) {
        expect(content, `SKILL.md should document MCP resource ${resource.uri}`).toContain(`\`${resource.uri}\``)
      }

      for (const tpl of MCP_RESOURCE_TEMPLATES) {
        expect(content, `SKILL.md should document MCP resource template ${tpl.uriTemplate}`).toContain(
          `\`${tpl.uriTemplate}\``,
        )
      }

      for (const prompt of MCP_PROMPTS) {
        expect(content, `SKILL.md should document MCP prompt ${prompt.name}`).toContain(`\`${prompt.name}\``)
      }
    })

    it('references existing sibling files and enforces safety hygiene', () => {
      const content = fs.readFileSync(SKILL_MD_PATH, 'utf8')

      // Referenced files exist inside skills/troy-advanced/
      expect(content).toContain('.mcp.json')
      expect(content).toContain('.claude-plugin/plugin.json')
      expect(fs.existsSync(path.join(SKILL_DIR, '.mcp.json'))).toBe(true)
      expect(fs.existsSync(path.join(SKILL_DIR, '.claude-plugin/plugin.json'))).toBe(true)

      // Documents safety guardrails
      expect(content).toContain('allowSubmit')
      expect(content).toContain('--since')
      expect(content).toMatch(/sensitive[- ]field/i)

      // Security hygiene: no curl|sh or hardcoded secrets
      expect(content).not.toMatch(/curl\s+[^|\n]*\|\s*(ba)?sh/i)
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/)
    })
  })

  describe('.claude-plugin/plugin.json', () => {
    it('is valid JSON matching Claude Code plugin manifest schema and package version', () => {
      expect(fs.existsSync(PLUGIN_JSON_PATH)).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8')) as {
        name: string
        version: string
        description: string
        author?: { name?: string; email?: string }
        homepage?: string
        repository?: string
        license?: string
        keywords?: string[]
        skills?: string | string[]
        mcpServers?: string | Record<string, unknown>
      }

      expect(manifest.name).toBe('troy-advanced')
      expect(manifest.version).toBe(pkg.version)
      expect(typeof manifest.description).toBe('string')
      expect(manifest.description.length).toBeGreaterThan(20)
      expect(manifest.author?.name).toBeTruthy()
      expect(manifest.license).toBe(pkg.license)
      expect(manifest.repository).toContain('troy-advanced')
      expect(Array.isArray(manifest.keywords)).toBe(true)
      expect(manifest.keywords!.length).toBeGreaterThanOrEqual(5)

      // skills path resolves to SKILL.md directory
      expect(typeof manifest.skills).toBe('string')
      const resolvedSkillsDir = path.resolve(SKILL_DIR, manifest.skills as string)
      expect(fs.existsSync(path.join(resolvedSkillsDir, 'SKILL.md'))).toBe(true)

      // mcpServers path resolves to valid .mcp.json
      expect(typeof manifest.mcpServers).toBe('string')
      const resolvedMcpPath = path.resolve(SKILL_DIR, manifest.mcpServers as string)
      expect(fs.existsSync(resolvedMcpPath)).toBe(true)
    })
  })

  describe('.mcp.json', () => {
    it('declares a valid troy-advanced stdio MCP server configuration', () => {
      expect(fs.existsSync(MCP_JSON_PATH)).toBe(true)
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8')) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>
      }

      const server = mcpConfig.mcpServers?.['troy-advanced']
      expect(server).toBeDefined()
      expect(server!.command).toBe('npx')
      expect(Array.isArray(server!.args)).toBe(true)
      expect(server!.args).toContain(pkg.name)
      expect(server!.args).toContain('mcp')

      const framingIdx = server!.args!.indexOf('--framing')
      expect(framingIdx).toBeGreaterThanOrEqual(0)
      expect(parseMcpFramingMode(server!.args![framingIdx + 1])).toBe('auto')
    })
  })

  describe('npm packaging', () => {
    it('includes skills directory in package.json files array', () => {
      expect(Array.isArray(pkg.files)).toBe(true)
      expect(pkg.files).toContain('skills')
    })
  })
})
