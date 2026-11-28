import { describe, expect, it, afterEach } from 'vitest'
import net from 'node:net'
import {
  AGENT_TOKEN_HEADER,
  MAX_TOKEN_BYTES,
  extractAgentTokenHeader,
  timingSafeTokenEqual,
  validateAgentTokenRequest,
} from '../src/bridge/auth.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'

async function sendRawHttp(port: number, rawRequest: string): Promise<{ status: number; raw: string; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    sock.setTimeout(3000)
    sock.on('connect', () => {
      sock.write(rawRequest)
    })
    sock.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      const headerEnd = text.indexOf('\r\n\r\n')
      if (headerEnd !== -1) {
        const headersPart = text.slice(0, headerEnd)
        const bodyPart = text.slice(headerEnd + 4)
        const clMatch = /^content-length:\s*(\d+)/im.exec(headersPart)
        if (clMatch) {
          const expectedLen = Number(clMatch[1])
          if (Buffer.byteLength(bodyPart, 'utf8') >= expectedLen) {
            sock.destroy()
          }
        } else if (/^HTTP\/1\.1\s+101\b/i.test(headersPart)) {
          sock.destroy()
        }
      }
    })
    sock.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const firstLine = raw.split('\r\n')[0] ?? ''
      const m = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(firstLine)
      const status = m ? Number(m[1]) : 0
      const headerEnd = raw.indexOf('\r\n\r\n')
      const body = headerEnd !== -1 ? raw.slice(headerEnd + 4) : ''
      resolve({ status, raw, body })
    })
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error('raw HTTP request timed out'))
    })
    sock.on('error', reject)
  })
}

describe('M73: timing-safe token comparison (crypto.timingSafeEqual)', () => {
  describe('timingSafeTokenEqual unit tests', () => {
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718'

    it('matches identical tokens and rejects single-char differences at start, middle, or end', () => {
      expect(timingSafeTokenEqual(secret, secret)).toBe(true)
      expect(timingSafeTokenEqual('b' + secret.slice(1), secret)).toBe(false)
      expect(timingSafeTokenEqual(secret.slice(0, 24) + 'X' + secret.slice(25), secret)).toBe(false)
      expect(timingSafeTokenEqual(secret.slice(0, -1) + '9', secret)).toBe(false)
    })

    it('rejects shorter, longer, prefix, superstring, and empty tokens without throwing RangeError', () => {
      expect(timingSafeTokenEqual('', secret)).toBe(false)
      expect(timingSafeTokenEqual(secret.slice(0, 10), secret)).toBe(false)
      expect(timingSafeTokenEqual(secret.slice(0, -1), secret)).toBe(false)
      expect(timingSafeTokenEqual(secret + '0', secret)).toBe(false)
      expect(timingSafeTokenEqual(secret + ' ', secret)).toBe(false)
      expect(timingSafeTokenEqual(' ' + secret, secret)).toBe(false)
      expect(timingSafeTokenEqual(secret.toUpperCase(), secret)).toBe(false)
    })

    it('handles multi-byte UTF-8 characters safely when JS string.length matches byte length of ASCII secret', () => {
      // 'é' is 1 JS code unit (length 1) but 2 UTF-8 bytes
      const asciiSecret = 'a'.repeat(16)
      const utf8SameJsLen = 'é'.repeat(16)
      expect(utf8SameJsLen.length).toBe(asciiSecret.length)
      expect(Buffer.byteLength(utf8SameJsLen, 'utf8')).not.toBe(Buffer.byteLength(asciiSecret, 'utf8'))
      expect(timingSafeTokenEqual(utf8SameJsLen, asciiSecret)).toBe(false)
      expect(timingSafeTokenEqual(utf8SameJsLen, utf8SameJsLen)).toBe(true)
    })

    it('fails closed on empty expected token or oversized inputs', () => {
      expect(timingSafeTokenEqual('', '')).toBe(false)
      expect(timingSafeTokenEqual('anything', '')).toBe(false)
      const huge = 'x'.repeat(MAX_TOKEN_BYTES + 1)
      expect(timingSafeTokenEqual(huge, huge)).toBe(false)
      expect(timingSafeTokenEqual(huge, secret)).toBe(false)
    })
  })

  describe('extractAgentTokenHeader & validateAgentTokenRequest', () => {
    const expected = 'secret-token-0123456789abcdef'

    it('extracts valid single x-troy-agent header and validates it', () => {
      const req = {
        headers: { [AGENT_TOKEN_HEADER]: expected },
        rawHeaders: ['Host', '127.0.0.1:9222', 'X-Troy-Agent', expected],
      }
      expect(extractAgentTokenHeader(req)).toEqual({ ok: true, present: true, token: expected })
      expect(validateAgentTokenRequest(req, expected)).toEqual({ ok: true })
    })

    it('rejects duplicate x-troy-agent headers in rawHeaders even when values match', () => {
      const req = {
        headers: { [AGENT_TOKEN_HEADER]: `${expected}, ${expected}` },
        rawHeaders: ['x-troy-agent', expected, 'X-Troy-Agent', expected],
      }
      const ext = extractAgentTokenHeader(req)
      expect(ext.ok).toBe(false)
      expect(ext.code).toBe('duplicate_token')

      const res = validateAgentTokenRequest(req, expected)
      expect(res.ok).toBe(false)
      expect(res.code).toBe('duplicate_token')
    })

    it('rejects array header values and control characters', () => {
      const arrReq = { headers: { [AGENT_TOKEN_HEADER]: [expected, expected] } }
      expect(validateAgentTokenRequest(arrReq, expected).code).toBe('duplicate_token')

      const ctrlReq = { headers: { [AGENT_TOKEN_HEADER]: `${expected}\x00` } }
      expect(validateAgentTokenRequest(ctrlReq, expected).code).toBe('invalid_token')
    })

    it('supports WebSocket queryToken fallback while failing closed on header/query conflicts', () => {
      const noHeaderReq = { headers: {} }
      expect(validateAgentTokenRequest(noHeaderReq, expected, { queryToken: expected })).toEqual({ ok: true })
      expect(validateAgentTokenRequest(noHeaderReq, expected, { queryToken: 'wrong' }).ok).toBe(false)

      // Valid header + mismatched query token -> fail closed
      const validHeaderReq = { headers: { [AGENT_TOKEN_HEADER]: expected } }
      expect(validateAgentTokenRequest(validHeaderReq, expected, { queryToken: 'wrong' }).ok).toBe(false)
      expect(validateAgentTokenRequest(validHeaderReq, expected, { queryToken: expected })).toEqual({ ok: true })

      // Duplicate header + valid query token -> fail closed
      const dupHeaderReq = {
        headers: { [AGENT_TOKEN_HEADER]: expected },
        rawHeaders: ['x-troy-agent', expected, 'x-troy-agent', 'bogus'],
      }
      expect(validateAgentTokenRequest(dupHeaderReq, expected, { queryToken: expected }).ok).toBe(false)
    })
  })

  describe('Agent Socket HTTP & WebSocket integration', () => {
    let manager: BrowserManager | null = null
    let agent: AgentSocketServer | null = null

    afterEach(async () => {
      if (agent) {
        await agent.close()
        agent = null
      }
      if (manager) {
        await manager.close()
        manager = null
      }
    })

    it('enforces timing-safe x-troy-agent auth with uniform 401 errors and blocks duplicate headers', async () => {
      manager = await BrowserManager.create({ engine: 'lite', memory: false })
      agent = await createAgentSocket(manager, { port: 0 })

      // 1. Valid token on GET /health succeeds
      const okRes = await sendRawHttp(
        agent.port,
        `GET /health HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `Connection: close\r\n\r\n`,
      )
      expect(okRes.status).toBe(200)
      expect(JSON.parse(okRes.body).ok).toBe(true)

      // 2. Missing, shorter, longer, and same-length wrong tokens all return uniform 401
      const badCases = [
        null,
        '',
        agent.token.slice(0, 8),
        agent.token + 'x',
        (agent.token[0] === 'a' ? 'b' : 'a') + agent.token.slice(1),
        agent.token.toUpperCase(),
      ]
      for (const bad of badCases) {
        const headerLine = bad === null ? '' : `x-troy-agent: ${bad}\r\n`
        const res = await sendRawHttp(
          agent.port,
          `GET /health HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${agent.port}\r\n` +
            headerLine +
            `Connection: close\r\n\r\n`,
        )
        expect(res.status).toBe(401)
        const parsed = JSON.parse(res.body)
        expect(parsed).toEqual({ ok: false, error: 'missing or invalid x-troy-agent token' })
      }

      // 3. Duplicate x-troy-agent headers are rejected even when both carry the valid token
      const dupRes = await sendRawHttp(
        agent.port,
        `GET /health HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `X-Troy-Agent: ${agent.token}\r\n` +
          `Connection: close\r\n\r\n`,
      )
      expect(dupRes.status).toBe(401)

      // 4. WebSocket upgrade rejects duplicate x-troy-agent headers and header/query mismatch
      const wsDup = await sendRawHttp(
        agent.port,
        `GET /ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `x-troy-agent: ${agent.token}\r\n` +
          `x-troy-agent: ${agent.token}\r\n\r\n`,
      )
      expect(wsDup.status).toBe(401)

      const wsConflict = await sendRawHttp(
        agent.port,
        `GET /ws?token=wrong-token HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `x-troy-agent: ${agent.token}\r\n\r\n`,
      )
      expect(wsConflict.status).toBe(401)

      // 5. Valid WebSocket upgrade with x-troy-agent header succeeds (101)
      const wsOk = await sendRawHttp(
        agent.port,
        `GET /ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${agent.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `x-troy-agent: ${agent.token}\r\n\r\n`,
      )
      expect(wsOk.status).toBe(101)
    })
  })
})
