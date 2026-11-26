import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_TOOLS } from '../src/mcp/server.js'
import {
  TOOL_SCHEMA_FORMATS,
  formatToolSchemasJson,
  generateToolSchemas,
  parseToolSchemaFormat,
  renameToolName,
  type AnthropicTool,
  type GeminiSchema,
  type GeminiTool,
  type McpToolDefinition,
  type OpenAiFunctionTool,
} from '../src/mcp/schema.js'
import { main as runCli } from '../src/cli.js'

function collectGeminiSchemas(schema: GeminiSchema | undefined, out: GeminiSchema[] = []): GeminiSchema[] {
  if (!schema) return out
  out.push(schema)
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) {
      collectGeminiSchemas(child, out)
    }
  }
  if (schema.items) {
    collectGeminiSchemas(schema.items, out)
  }
  return out
}

describe('Tool Schema Generator (M59)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses valid formats case-insensitively and rejects invalid ones', () => {
    for (const fmt of TOOL_SCHEMA_FORMATS) {
      expect(parseToolSchemaFormat(fmt)).toBe(fmt)
      expect(parseToolSchemaFormat(`  ${fmt.toUpperCase()}  `)).toBe(fmt)
    }
    expect(parseToolSchemaFormat('unknown')).toBeNull()
    expect(parseToolSchemaFormat('')).toBeNull()
    expect(parseToolSchemaFormat(undefined)).toBeNull()
    expect(parseToolSchemaFormat(123)).toBeNull()
  })

  it('generates MCP format matching all MCP_TOOLS with deep-cloned immutability', () => {
    const tools = generateToolSchemas({ format: 'mcp' }) as McpToolDefinition[]
    expect(tools).toHaveLength(MCP_TOOLS.length)
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name))

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema.type).toBe('object')
    }

    // Mutating generated schema must not mutate canonical MCP_TOOLS
    const openTool = tools.find((t) => t.name === 'troy_open')!
    openTool.inputSchema.properties!.url!.description = 'MUTATED'
    const originalOpen = MCP_TOOLS.find((t) => t.name === 'troy_open')!
    expect(originalOpen.inputSchema.properties.url.description).not.toBe('MUTATED')
  })

  it('generates OpenAI function tool schemas (standard mode)', () => {
    const tools = generateToolSchemas({ format: 'openai' }) as OpenAiFunctionTool[]
    expect(tools).toHaveLength(MCP_TOOLS.length)

    for (const tool of tools) {
      expect(tool.type).toBe('function')
      expect(typeof tool.function.name).toBe('string')
      expect(typeof tool.function.description).toBe('string')
      expect(tool.function.strict).toBeUndefined()
      expect(tool.function.parameters.type).toBe('object')
      expect(tool.function.parameters.additionalProperties).toBe(false)
    }

    const click = tools.find((t) => t.function.name === 'troy_click')!
    expect(click.function.parameters.required).toEqual(['ref'])
    expect(click.function.parameters.properties!.ref!.type).toBe('string')
    expect(click.function.parameters.properties!.tabId!.type).toBe('number')

    // Non-strict mode preserves nested additionalProperties on extraHeaders
    const emulate = tools.find((t) => t.function.name === 'troy_emulate')!
    expect(emulate.function.parameters.properties!.extraHeaders!.additionalProperties).toEqual({
      type: 'string',
    })
  })

  it('generates OpenAI strict-mode schemas with all properties required and optionals nullable', () => {
    const tools = generateToolSchemas({ format: 'openai', strict: true }) as OpenAiFunctionTool[]
    expect(tools).toHaveLength(MCP_TOOLS.length)

    for (const tool of tools) {
      expect(tool.type).toBe('function')
      expect(tool.function.strict).toBe(true)
      expect(tool.function.parameters.additionalProperties).toBe(false)
      const propKeys = Object.keys(tool.function.parameters.properties ?? {})
      expect(tool.function.parameters.required).toEqual(propKeys)
    }

    const click = tools.find((t) => t.function.name === 'troy_click')!
    // Required field stays non-nullable
    expect(click.function.parameters.properties!.ref!.type).toBe('string')
    // Optional fields become nullable
    expect(click.function.parameters.properties!.tabId!.type).toEqual(['number', 'null'])
    expect(click.function.parameters.properties!.allowSubmit!.type).toEqual(['boolean', 'null'])

    // Optional enum field includes null in both type and enum
    const readAscii = tools.find((t) => t.function.name === 'troy_read_ascii')!
    expect(readAscii.function.parameters.properties!.density!.type).toEqual(['string', 'null'])
    expect(readAscii.function.parameters.properties!.density!.enum).toEqual([
      'compact',
      'normal',
      'wide',
      null,
    ])
  })

  it('generates Anthropic Messages API tool schemas with input_schema', () => {
    const tools = generateToolSchemas({ format: 'anthropic' }) as AnthropicTool[]
    expect(tools).toHaveLength(MCP_TOOLS.length)

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.input_schema).toBeDefined()
      expect(tool.input_schema.type).toBe('object')
      expect(tool.input_schema.properties).toBeDefined()
      expect('inputSchema' in tool).toBe(false)
    }

    const fill = tools.find((t) => t.name === 'troy_fill')!
    expect(fill.input_schema.required).toEqual(['ref', 'text'])
    expect(fill.input_schema.properties!.text!.type).toBe('string')
  })

  it('generates Google Gemini functionDeclarations with UPPERCASE types, no additionalProperties, and omitted empty parameters', () => {
    const tools = generateToolSchemas({ format: 'gemini' }) as GeminiTool[]
    expect(tools).toHaveLength(1)
    const decls = tools[0]!.functionDeclarations
    expect(decls).toHaveLength(MCP_TOOLS.length)

    const validTypes = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT'])
    for (const decl of decls) {
      expect(typeof decl.name).toBe('string')
      expect(typeof decl.description).toBe('string')
      const allSchemas = collectGeminiSchemas(decl.parameters)
      for (const s of allSchemas) {
        expect(validTypes.has(s.type)).toBe(true)
        expect('additionalProperties' in s).toBe(false)
      }
    }

    // Zero-argument tool omits `parameters` for Gemini REST compatibility
    const tabsDecl = decls.find((d) => d.name === 'troy_tabs')!
    expect(tabsDecl.parameters).toBeUndefined()

    // Tool with properties + required + enums
    const readAscii = decls.find((d) => d.name === 'troy_read_ascii')!
    expect(readAscii.parameters?.type).toBe('OBJECT')
    expect(readAscii.parameters?.properties?.width?.type).toBe('NUMBER')
    expect(readAscii.parameters?.properties?.since?.type).toBe('BOOLEAN')
    expect(readAscii.parameters?.properties?.density?.type).toBe('STRING')
    expect(readAscii.parameters?.properties?.density?.enum).toEqual(['compact', 'normal', 'wide'])

    // Array items converted properly
    const actDecl = decls.find((d) => d.name === 'troy_act')!
    expect(actDecl.parameters?.properties?.steps?.type).toBe('ARRAY')
    expect(actDecl.parameters?.properties?.steps?.items?.type).toBe('OBJECT')
    expect(actDecl.parameters?.required).toEqual(['steps'])

    // extraHeaders has no additionalProperties
    const emulateDecl = decls.find((d) => d.name === 'troy_emulate')!
    expect(emulateDecl.parameters?.properties?.extraHeaders?.type).toBe('OBJECT')
    expect('additionalProperties' in (emulateDecl.parameters?.properties?.extraHeaders ?? {})).toBe(false)
    expect(emulateDecl.parameters?.properties?.removeHeaders?.type).toBe('ARRAY')
    expect(emulateDecl.parameters?.properties?.removeHeaders?.items?.type).toBe('STRING')
  })

  it('supports filtering by full or short tool names and rejects unknown tools', () => {
    const subset = generateToolSchemas({
      format: 'anthropic',
      tools: ['troy_open', 'read_ascii', 'click', 'troy_click'],
    }) as AnthropicTool[]

    expect(subset.map((t) => t.name)).toEqual(['troy_open', 'troy_read_ascii', 'troy_click'])

    expect(() =>
      generateToolSchemas({ format: 'openai', tools: ['troy_open', 'nonexistent_tool'] }),
    ).toThrow(/Unknown tool name\(s\): nonexistent_tool/)
  })

  it('supports renaming tool prefixes cleanly', () => {
    expect(renameToolName('troy_open')).toBe('troy_open')
    expect(renameToolName('troy_open', '')).toBe('open')
    expect(renameToolName('troy_open', 'browser_')).toBe('browser_open')

    const tools = generateToolSchemas({
      format: 'openai',
      tools: ['open', 'click'],
      prefix: 'web_',
    }) as OpenAiFunctionTool[]

    expect(tools.map((t) => t.function.name)).toEqual(['web_open', 'web_click'])
  })

  it('formats JSON in pretty and compact modes', () => {
    const pretty = formatToolSchemasJson({ format: 'mcp', tools: ['open'] })
    const compact = formatToolSchemasJson({ format: 'mcp', tools: ['open'], compact: true })
    expect(pretty).toContain('\n')
    expect(compact).not.toContain('\n')
    expect(JSON.parse(pretty)).toEqual(JSON.parse(compact))
  })

  it('CLI `schema --format openai|anthropic|gemini|mcp` outputs valid JSON and supports --out', async () => {
    for (const fmt of TOOL_SCHEMA_FORMATS) {
      const logs: string[] = []
      vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
        logs.push(String(msg ?? ''))
      })

      await runCli(['schema', '--format', fmt, '--tools', 'open,tabs'])
      expect(logs).toHaveLength(1)
      const parsed = JSON.parse(logs[0]!)
      if (fmt === 'gemini') {
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed[0].functionDeclarations).toHaveLength(2)
      } else {
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed).toHaveLength(2)
      }
      vi.restoreAllMocks()
    }

    // Test writing to file via --out
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-schema-test-'))
    const outFile = path.join(tmpDir, 'nested', 'openai-tools.json')
    try {
      const logs: string[] = []
      vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
        logs.push(String(msg ?? ''))
      })
      await runCli(['schema', '--format', 'openai', '--strict', '--out', outFile])
      const written = JSON.parse(fs.readFileSync(outFile, 'utf8')) as OpenAiFunctionTool[]
      expect(written).toHaveLength(MCP_TOOLS.length)
      expect(written[0]!.function.strict).toBe(true)
      const ack = JSON.parse(logs[0]!)
      expect(ack.ok).toBe(true)
      expect(ack.format).toBe('openai')
      expect(ack.out).toBe(outFile)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('CLI `schema` rejects invalid --format with exit code 1', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ''))
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`)
    }) as never)

    await expect(runCli(['schema', '--format', 'bogus'])).rejects.toThrow('EXIT:1')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errors[0]).toContain('Invalid schema format')
  })
})
