import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/engine/manager.js'
import {
  McpStdioFrameParser,
  encodeMcpMessage,
  parseMcpFramingMode,
  runMcpStdioServer,
} from '../src/mcp/server.js'

function decodeAllContentLengthFrames(raw: Buffer): Array<{ contentLength: number; body: Record<string, unknown> }> {
  const results: Array<{ contentLength: number; body: Record<string, unknown> }> = []
  let offset = 0
  const sep = Buffer.from('\r\n\r\n', 'ascii')

  while (offset < raw.length) {
    const sepIdx = raw.indexOf(sep, offset)
    expect(sepIdx).toBeGreaterThan(offset)
    const headerStr = raw.subarray(offset, sepIdx).toString('utf8')
    const match = /^Content-Length:\s*(\d+)$/im.exec(headerStr.trim())
    expect(match).not.toBeNull()
    const contentLength = Number.parseInt(match![1]!, 10)
    const bodyStart = sepIdx + 4
    const bodyEnd = bodyStart + contentLength
    expect(bodyEnd).toBeLessThanOrEqual(raw.length)
    const bodyBuf = raw.subarray(bodyStart, bodyEnd)
    expect(bodyBuf.byteLength).toBe(contentLength)
    results.push({
      contentLength,
      body: JSON.parse(bodyBuf.toString('utf8')) as Record<string, unknown>,
    })
    offset = bodyEnd
  }

  return results
}

describe('M57: MCP Content-Length framed stdio transport & auto-detection', () => {
  let server: http.Server
  let baseUrl: string
  let tmpRoot: string

  const freshProfile = () => fs.mkdtempSync(path.join(tmpRoot, 'prof-'))

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-mcp-m57-'))
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/utf8')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
          <html>
            <head><title>Café Tokyo</title></head>
            <body>
              <h1>Framing Check</h1>
              <p>Hello world from MCP framed transport.</p>
              <button type="button">Run Action</button>
            </body>
          </html>`)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('parses framing mode aliases and rejects unknown modes', () => {
    expect(parseMcpFramingMode(undefined)).toBe('auto')
    expect(parseMcpFramingMode('')).toBe('auto')
    expect(parseMcpFramingMode('auto')).toBe('auto')
    expect(parseMcpFramingMode('detect')).toBe('auto')
    expect(parseMcpFramingMode('ndjson')).toBe('ndjson')
    expect(parseMcpFramingMode('line')).toBe('ndjson')
    expect(parseMcpFramingMode('lines')).toBe('ndjson')
    expect(parseMcpFramingMode('jsonl')).toBe('ndjson')
    expect(parseMcpFramingMode('content-length')).toBe('content-length')
    expect(parseMcpFramingMode('content_length')).toBe('content-length')
    expect(parseMcpFramingMode('lsp')).toBe('content-length')
    expect(parseMcpFramingMode('framed')).toBe('content-length')
    expect(() => parseMcpFramingMode('xml')).toThrow(/Invalid MCP framing mode/)
  })

  it('encodes Content-Length using exact UTF-8 byte length for multi-byte payloads', () => {
    const payload = { jsonrpc: '2.0', id: 1, method: 'test', params: { label: 'Café € 🚀 東京' } }
    const encoded = encodeMcpMessage(payload, 'content-length')
    const jsonBody = JSON.stringify(payload)
    const expectedBytes = Buffer.byteLength(jsonBody, 'utf8')

    // UTF-8 byte length must be strictly larger than UTF-16 string length here
    expect(expectedBytes).toBeGreaterThan(jsonBody.length)
    expect(encoded).toBe(`Content-Length: ${expectedBytes}\r\n\r\n${jsonBody}`)

    const ndjson = encodeMcpMessage(payload, 'ndjson')
    expect(ndjson).toBe(`${jsonBody}\n`)
  })

  it('parses byte-by-byte fragmented Content-Length frames with extra headers and multi-byte UTF-8', () => {
    const parser = new McpStdioFrameParser('auto')
    const msg1 = { jsonrpc: '2.0', id: 1, method: 'ping', params: { note: '日本語 € 🚀' } }
    const body1 = JSON.stringify(msg1)
    const frame1 = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body1, 'utf8')}\r\n\r\n${body1}`

    const msg2 = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    const body2 = JSON.stringify(msg2)
    // Also verify \n\n header delimiter compatibility
    const frame2 = `Content-Length: ${Buffer.byteLength(body2, 'utf8')}\n\n${body2}`

    const combined = Buffer.from(frame1 + frame2, 'utf8')
    const collected = []
    for (let i = 0; i < combined.length; i++) {
      collected.push(...parser.push(combined.subarray(i, i + 1)))
    }
    collected.push(...parser.flush())

    expect(parser.detectedFraming).toBe('content-length')
    expect(collected).toHaveLength(2)
    expect(collected[0]).toEqual({ ok: true, raw: body1, framing: 'content-length' })
    expect(collected[1]).toEqual({ ok: true, raw: body2, framing: 'content-length' })
  })

  it('handles NDJSON streams with CRLF, blank lines, and EOF without trailing newline', () => {
    const parser = new McpStdioFrameParser('ndjson')
    const frames = [
      ...parser.push('\r\n  \n{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n'),
      ...parser.push('{"jsonrpc":"2.0","id":2,"method":"tools/list"}'),
      ...parser.flush(),
    ]

    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ ok: true, raw: '{"jsonrpc":"2.0","id":1,"method":"ping"}', framing: 'ndjson' })
    expect(frames[1]).toEqual({ ok: true, raw: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', framing: 'ndjson' })
  })

  it('reports framing errors cleanly (missing header, oversized frame, oversized header, truncated EOF)', () => {
    const parser = new McpStdioFrameParser('content-length', { maxFrameBytes: 32, maxHeaderBytes: 64 })

    // 1. Missing Content-Length header
    const missing = parser.push('Content-Type: application/json\r\n\r\n')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ ok: false, framing: 'content-length' })

    // 2. Oversized Content-Length
    const oversized = parser.push('Content-Length: 9999\r\n\r\n')
    expect(oversized).toHaveLength(1)
    expect(oversized[0]).toMatchObject({ ok: false, framing: 'content-length' })
    if (!oversized[0]!.ok) {
      expect(oversized[0]!.error).toContain('exceeds maximum allowed')
    }

    // 3. Oversized header block without terminator
    const bigHeader = parser.push('X-Junk: ' + 'A'.repeat(100))
    expect(bigHeader).toHaveLength(1)
    expect(bigHeader[0]).toMatchObject({ ok: false, framing: 'content-length' })

    // 4. Truncated body at EOF
    const partial = parser.push('Content-Length: 20\r\n\r\n{"short":1}')
    expect(partial).toHaveLength(0)
    const flushed = parser.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toMatchObject({ ok: false, framing: 'content-length' })
  })

  it('runs full MCP session over explicit content-length framed stdio transport', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const input = new PassThrough()
      const output = new PassThrough()
      const outChunks: Buffer[] = []
      output.on('data', (chunk) => outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))

      const serverDone = runMcpStdioServer(manager, input, output, { framing: 'content-length' })

      const wire =
        encodeMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'content-length') +
        // Notification (no id) must produce no response frame
        encodeMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'content-length') +
        encodeMcpMessage(
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'troy_open', arguments: { url: `${baseUrl}/utf8` } } },
          'content-length',
        ) +
        encodeMcpMessage(
          { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'troy://active/ascii' } },
          'content-length',
        )

      // Feed in uneven chunks to test streaming reassembly
      const wireBuf = Buffer.from(wire, 'utf8')
      input.write(wireBuf.subarray(0, 17))
      input.write(wireBuf.subarray(17, 73))
      input.end(wireBuf.subarray(73))

      await serverDone

      const decoded = decodeAllContentLengthFrames(Buffer.concat(outChunks))
      expect(decoded).toHaveLength(3)
      expect(decoded[0]!.body.id).toBe(1)
      expect((decoded[0]!.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('troy-advanced')
      expect(decoded[1]!.body.id).toBe(2)
      expect((decoded[1]!.body.result as { isError: boolean }).isError).toBe(false)
      expect(decoded[2]!.body.id).toBe(3)
      const asciiText = (decoded[2]!.body.result as { contents: Array<{ text: string }> }).contents[0]!.text
      expect(asciiText).toContain('FRAMING CHECK')
    } finally {
      await manager.close()
    }
  })

  it('auto-detects Content-Length framing in default auto mode and recovers from bad JSON frames', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const input = new PassThrough()
      const output = new PassThrough()
      const outChunks: Buffer[] = []
      output.on('data', (chunk) => outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))

      // Default options -> framing: 'auto'
      const serverDone = runMcpStdioServer(manager, input, output)

      const badBody = '{not valid json'
      const badFrame = `Content-Length: ${Buffer.byteLength(badBody, 'utf8')}\r\n\r\n${badBody}`
      const goodFrame = encodeMcpMessage({ jsonrpc: '2.0', id: 99, method: 'ping' }, 'content-length')

      input.write(badFrame.slice(0, 8))
      input.write(badFrame.slice(8))
      input.end(goodFrame)

      await serverDone

      const decoded = decodeAllContentLengthFrames(Buffer.concat(outChunks))
      expect(decoded).toHaveLength(2)
      expect(decoded[0]!.body).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700 },
      })
      expect(decoded[1]!.body).toEqual({
        jsonrpc: '2.0',
        id: 99,
        result: {},
      })
    } finally {
      await manager.close()
    }
  })

  it('auto-detects NDJSON line mode in default auto mode for backwards compatibility', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false, profileDir: freshProfile() })
    try {
      const input = new PassThrough()
      const output = new PassThrough()
      let rawOut = ''
      output.on('data', (chunk) => {
        rawOut += String(chunk)
      })

      const serverDone = runMcpStdioServer(manager, input, output)
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' })}\n`)
      input.end()

      await serverDone

      expect(rawOut).not.toContain('Content-Length:')
      const lines = rawOut
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> })
      expect(lines).toHaveLength(2)
      expect(lines[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
      expect(lines[1]!.id).toBe(2)
      expect(Array.isArray(lines[1]!.result.resources)).toBe(true)
    } finally {
      await manager.close()
    }
  })
})
