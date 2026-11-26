// Provider-specific JSON tool-schema generator for Troy Advanced.
// Converts the canonical MCP tool definitions into ready-to-use schemas for:
//   - openai    (OpenAI Chat Completions / Responses API function tools, with optional strict mode)
//   - anthropic (Anthropic Messages API `tools` with `input_schema`)
//   - gemini    (Google Gemini `tools: [{ functionDeclarations }]` with UPPERCASE Schema types)
//   - mcp       (Model Context Protocol `tools/list` `inputSchema` format)

import { MCP_TOOLS } from './server.js'

export type ToolSchemaFormat = 'openai' | 'anthropic' | 'gemini' | 'mcp'

export const TOOL_SCHEMA_FORMATS: readonly ToolSchemaFormat[] = [
  'openai',
  'anthropic',
  'gemini',
  'mcp',
] as const

export interface JsonSchemaNode {
  type?: string | string[]
  description?: string
  enum?: Array<string | number | boolean | null>
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  additionalProperties?: boolean | JsonSchemaNode
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchemaNode
}

export interface OpenAiFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    strict?: boolean
    parameters: JsonSchemaNode
  }
}

export interface AnthropicTool {
  name: string
  description: string
  input_schema: JsonSchemaNode
}

export type GeminiSchemaType =
  | 'STRING'
  | 'NUMBER'
  | 'INTEGER'
  | 'BOOLEAN'
  | 'ARRAY'
  | 'OBJECT'

export interface GeminiSchema {
  type: GeminiSchemaType
  description?: string
  enum?: string[]
  properties?: Record<string, GeminiSchema>
  required?: string[]
  items?: GeminiSchema
}

export interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters?: GeminiSchema
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[]
}

export type GeneratedToolSchemas =
  | OpenAiFunctionTool[]
  | AnthropicTool[]
  | GeminiTool[]
  | McpToolDefinition[]

export interface GenerateToolSchemaOptions {
  /** Target format: 'openai' | 'anthropic' | 'gemini' | 'mcp' */
  format: ToolSchemaFormat
  /** Optional subset of tool names to include (accepts full name or without leading 'troy_') */
  tools?: string[]
  /** Optional replacement prefix for tool names (replaces leading 'troy_'; e.g. '' or 'browser_') */
  prefix?: string
  /** OpenAI Structured Outputs strict mode (adds strict: true, makes all properties required with nullable optionals) */
  strict?: boolean
  /** Override source tool definitions (defaults to MCP_TOOLS) */
  sourceTools?: readonly McpToolDefinition[]
}

export function parseToolSchemaFormat(raw: unknown): ToolSchemaFormat | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === 'openai' ||
    normalized === 'anthropic' ||
    normalized === 'gemini' ||
    normalized === 'mcp'
  ) {
    return normalized
  }
  return null
}

function cloneSchemaNode(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = {}
  if (node.type !== undefined) {
    out.type = Array.isArray(node.type) ? [...node.type] : node.type
  }
  if (node.description !== undefined) out.description = node.description
  if (node.enum !== undefined) out.enum = [...node.enum]
  if (node.properties !== undefined) {
    const props: Record<string, JsonSchemaNode> = {}
    for (const [k, v] of Object.entries(node.properties)) {
      if (v !== undefined) props[k] = cloneSchemaNode(v)
    }
    out.properties = props
  }
  if (node.required !== undefined) out.required = [...node.required]
  if (node.items !== undefined) out.items = cloneSchemaNode(node.items)
  if (node.additionalProperties !== undefined) {
    out.additionalProperties =
      typeof node.additionalProperties === 'boolean'
        ? node.additionalProperties
        : cloneSchemaNode(node.additionalProperties)
  }
  return out
}

export function renameToolName(name: string, prefix?: string): string {
  if (prefix === undefined) return name
  const stripped = name.startsWith('troy_') ? name.slice('troy_'.length) : name
  return `${prefix}${stripped}`
}

export function selectSourceTools(
  sourceTools: readonly McpToolDefinition[] = MCP_TOOLS as unknown as readonly McpToolDefinition[],
  filterNames?: string[],
): McpToolDefinition[] {
  if (!filterNames || filterNames.length === 0) {
    return sourceTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: cloneSchemaNode(t.inputSchema),
    }))
  }

  const wanted = filterNames
    .map((s) => s.trim())
    .filter(Boolean)

  if (wanted.length === 0) {
    return sourceTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: cloneSchemaNode(t.inputSchema),
    }))
  }

  const byExact = new Map<string, McpToolDefinition>()
  const byShort = new Map<string, McpToolDefinition>()
  for (const tool of sourceTools) {
    byExact.set(tool.name, tool)
    if (tool.name.startsWith('troy_')) {
      byShort.set(tool.name.slice('troy_'.length), tool)
    }
  }

  const selected: McpToolDefinition[] = []
  const seen = new Set<string>()
  const unknown: string[] = []

  for (const rawName of wanted) {
    const match = byExact.get(rawName) ?? byShort.get(rawName)
    if (!match) {
      unknown.push(rawName)
      continue
    }
    if (!seen.has(match.name)) {
      seen.add(match.name)
      selected.push({
        name: match.name,
        description: match.description,
        inputSchema: cloneSchemaNode(match.inputSchema),
      })
    }
  }

  if (unknown.length > 0) {
    const available = sourceTools.map((t) => t.name).join(', ')
    throw new Error(`Unknown tool name(s): ${unknown.join(', ')}. Available tools: ${available}`)
  }

  return selected
}

function makeNullable(node: JsonSchemaNode): JsonSchemaNode {
  const out = cloneSchemaNode(node)
  if (typeof out.type === 'string') {
    if (out.type !== 'null') {
      out.type = [out.type, 'null']
    }
  } else if (Array.isArray(out.type)) {
    if (!out.type.includes('null')) {
      out.type = [...out.type, 'null']
    }
  }
  if (out.enum && !out.enum.includes(null)) {
    out.enum = [...out.enum, null]
  }
  return out
}

function normalizeOpenAiStrictSchema(node: JsonSchemaNode): JsonSchemaNode {
  const out = cloneSchemaNode(node)
  const isObject =
    out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'))

  if (isObject) {
    const rawProps = out.properties ?? {}
    const origRequired = new Set(out.required ?? [])
    const nextProps: Record<string, JsonSchemaNode> = {}
    const allKeys = Object.keys(rawProps)
    for (const key of allKeys) {
      let propSchema = normalizeOpenAiStrictSchema(rawProps[key]!)
      if (!origRequired.has(key)) {
        propSchema = makeNullable(propSchema)
      }
      nextProps[key] = propSchema
    }
    out.properties = nextProps
    out.required = allKeys
    out.additionalProperties = false
  }

  if (out.items) {
    out.items = normalizeOpenAiStrictSchema(out.items)
  }

  return out
}

export function toMcpToolSchemas(
  sourceTools: readonly McpToolDefinition[],
  prefix?: string,
): McpToolDefinition[] {
  return sourceTools.map((tool) => ({
    name: renameToolName(tool.name, prefix),
    description: tool.description,
    inputSchema: cloneSchemaNode(tool.inputSchema),
  }))
}

export function toOpenAiToolSchemas(
  sourceTools: readonly McpToolDefinition[],
  options: { prefix?: string; strict?: boolean } = {},
): OpenAiFunctionTool[] {
  const strict = Boolean(options.strict)
  return sourceTools.map((tool) => {
    const parameters = strict
      ? normalizeOpenAiStrictSchema(tool.inputSchema)
      : {
          ...cloneSchemaNode(tool.inputSchema),
          type: 'object',
          properties: tool.inputSchema.properties
            ? Object.fromEntries(
                Object.entries(tool.inputSchema.properties).map(([k, v]) => [k, cloneSchemaNode(v)]),
              )
            : {},
          additionalProperties: false,
        }

    const fn: OpenAiFunctionTool['function'] = {
      name: renameToolName(tool.name, options.prefix),
      description: tool.description,
      parameters,
    }
    if (strict) {
      fn.strict = true
    }

    return {
      type: 'function',
      function: fn,
    }
  })
}

export function toAnthropicToolSchemas(
  sourceTools: readonly McpToolDefinition[],
  prefix?: string,
): AnthropicTool[] {
  return sourceTools.map((tool) => {
    const inputSchema = cloneSchemaNode(tool.inputSchema)
    if (!inputSchema.type) inputSchema.type = 'object'
    if (!inputSchema.properties) inputSchema.properties = {}
    return {
      name: renameToolName(tool.name, prefix),
      description: tool.description,
      input_schema: inputSchema,
    }
  })
}

function mapJsonTypeToGemini(rawType: string | string[] | undefined): GeminiSchemaType {
  const primary = Array.isArray(rawType)
    ? rawType.find((t) => t !== 'null') ?? 'string'
    : rawType ?? 'object'
  switch (primary.toLowerCase()) {
    case 'string':
      return 'STRING'
    case 'number':
      return 'NUMBER'
    case 'integer':
      return 'INTEGER'
    case 'boolean':
      return 'BOOLEAN'
    case 'array':
      return 'ARRAY'
    case 'object':
    default:
      return 'OBJECT'
  }
}

function convertToGeminiSchema(node: JsonSchemaNode): GeminiSchema {
  const geminiType = mapJsonTypeToGemini(node.type)
  const out: GeminiSchema = { type: geminiType }

  if (node.description !== undefined) {
    out.description = node.description
  }

  if (node.enum !== undefined && node.enum.length > 0) {
    out.enum = node.enum.filter((v): v is string | number | boolean => v !== null).map(String)
  }

  if (geminiType === 'OBJECT' && node.properties && Object.keys(node.properties).length > 0) {
    const props: Record<string, GeminiSchema> = {}
    for (const [k, v] of Object.entries(node.properties)) {
      props[k] = convertToGeminiSchema(v)
    }
    out.properties = props
    if (node.required && node.required.length > 0) {
      out.required = [...node.required]
    }
  }

  if (geminiType === 'ARRAY') {
    out.items = node.items ? convertToGeminiSchema(node.items) : { type: 'OBJECT' }
  }

  // Note: Gemini Schema intentionally omits `additionalProperties` (unsupported by Gemini REST/Vertex API).
  return out
}

export function toGeminiToolSchemas(
  sourceTools: readonly McpToolDefinition[],
  prefix?: string,
): GeminiTool[] {
  const functionDeclarations: GeminiFunctionDeclaration[] = sourceTools.map((tool) => {
    const decl: GeminiFunctionDeclaration = {
      name: renameToolName(tool.name, prefix),
      description: tool.description,
    }
    const propKeys = tool.inputSchema.properties ? Object.keys(tool.inputSchema.properties) : []
    // Gemini API rejects OBJECT parameter schemas with empty `properties: {}`; omit `parameters` for zero-arg tools.
    if (propKeys.length > 0) {
      decl.parameters = convertToGeminiSchema(tool.inputSchema)
    }
    return decl
  })

  return [{ functionDeclarations }]
}

export function generateToolSchemas(options: GenerateToolSchemaOptions): GeneratedToolSchemas {
  const selected = selectSourceTools(options.sourceTools, options.tools)
  switch (options.format) {
    case 'openai':
      return toOpenAiToolSchemas(selected, { prefix: options.prefix, strict: options.strict })
    case 'anthropic':
      return toAnthropicToolSchemas(selected, options.prefix)
    case 'gemini':
      return toGeminiToolSchemas(selected, options.prefix)
    case 'mcp':
      return toMcpToolSchemas(selected, options.prefix)
  }
}

export function formatToolSchemasJson(
  options: GenerateToolSchemaOptions & { compact?: boolean },
): string {
  const schemas = generateToolSchemas(options)
  return options.compact ? JSON.stringify(schemas) : JSON.stringify(schemas, null, 2)
}
