import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SecretRedactorGuard,
  isPlausibleCreditCard,
  isPlausibleJwt,
  isValidLuhn,
  parseSecretRedactionBoolean,
  parseSecretRedactionCategories,
  parseSecretRedactionMode,
  redactSensitiveText,
} from '../src/agent/secret-redactor.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket } from '../src/bridge/agent-socket.js'
import { handleMcpRequest } from '../src/mcp/server.js'
import { executePipeCommand } from '../src/pipe/repl.js'

// Build synthetic test secrets dynamically so static secret scanners do not trigger on test fixtures.
function makeTestJwt(payload: Record<string, unknown> = { sub: 'user_42', role: 'admin' }): string {
  const b64u = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  const header = b64u({ alg: 'HS256', typ: 'JWT' })
  const body = b64u(payload)
  const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  return `${header}.${body}.${sig}`
}

const TEST_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const TEST_AWS_STS_KEY = ['ASIA', '1234567890ABCDEF'].join('')
const TEST_AWS_SECRET = ['wJalrXUtnFEMI', '/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'].join('')
const TEST_GH_PAT = ['ghp', '_', '1234567890abcdefghijklmnopqrstuvwxyzABCD'].join('')
const TEST_GH_FINE = ['github', '_pat_', '11AAAAAA0123456789_abcdefghijklmnop'].join('')
const TEST_OPENAI_KEY = ['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('')
const TEST_STRIPE_KEY = ['sk', '_live_', '51H7xYz1234567890abcdef'].join('')
const TEST_SLACK_TOKEN = ['xoxb', '-', '123456789012', '-', '123456789012-abcdefghijklmnop'].join('')
const TEST_GOOGLE_KEY = ['AIza', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe'].join('')
const TEST_SENDGRID_KEY = ['SG', '.', 'abcdefghijklmnopQRST', '.', '0123456789abcdefGHIJKLMN'].join('')
const TEST_BEARER_OPAQUE = 'opaque_session_token_9876543210abcdef'
const TEST_PEM_KEY = [
  '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7Mhgw0v2Q9m0q5v1a',
  '-----END ' + 'RSA PRIVATE KEY-----',
].join('\n')

// Standard Luhn-valid test card numbers (Stripe/Braintree/RFC test numbers)
const TEST_VISA_HYPHEN = ['4111', '1111', '1111', '1111'].join('-')
const TEST_VISA_PLAIN = ['4242', '4242', '4242', '4242'].join('')
const TEST_MASTERCARD_SPACES = ['5555', '5555', '5555', '4444'].join(' ')
const TEST_AMEX_HYPHEN = ['3782', '822463', '10005'].join('-')
const TEST_DISCOVER_PLAIN = ['6011', '1111', '1111', '1117'].join('')

describe('M76: SecretRedactor unit tests', () => {
  it('validates Luhn checksums and plausible credit cards accurately', () => {
    expect(isValidLuhn(TEST_VISA_PLAIN)).toBe(true)
    expect(isValidLuhn('4111111111111112')).toBe(false)
    expect(isValidLuhn('12345')).toBe(false)

    expect(isPlausibleCreditCard(TEST_VISA_HYPHEN)).toBe(true)
    expect(isPlausibleCreditCard(TEST_VISA_PLAIN)).toBe(true)
    expect(isPlausibleCreditCard(TEST_MASTERCARD_SPACES)).toBe(true)
    expect(isPlausibleCreditCard(TEST_AMEX_HYPHEN)).toBe(true)
    expect(isPlausibleCreditCard(TEST_DISCOVER_PLAIN)).toBe(true)

    // Invalid Luhn, mixed separators, all-zero, unknown IIN prefix
    expect(isPlausibleCreditCard('4111-1111-1111-1112')).toBe(false)
    expect(isPlausibleCreditCard('4111-1111 1111-1111')).toBe(false)
    expect(isPlausibleCreditCard('0000000000000000')).toBe(false)
    expect(isPlausibleCreditCard('9999999999999999')).toBe(false)
  })

  it('validates JWT structure before redacting', () => {
    const validJwt = makeTestJwt()
    expect(isPlausibleJwt(validJwt)).toBe(true)
    expect(isPlausibleJwt('not.a.jwt')).toBe(false)
    expect(isPlausibleJwt('eyJnotjson.eyJnotjson.abcdefghij')).toBe(false)
  })

  it('parses CLI / config helpers', () => {
    expect(parseSecretRedactionMode('tag')).toBe('tag')
    expect(parseSecretRedactionMode('PARTIAL')).toBe('partial')
    expect(parseSecretRedactionMode('invalid')).toBeUndefined()

    expect(parseSecretRedactionBoolean(true)).toBe(true)
    expect(parseSecretRedactionBoolean('on')).toBe(true)
    expect(parseSecretRedactionBoolean('false')).toBe(false)
    expect(parseSecretRedactionBoolean('maybe')).toBeUndefined()

    expect(parseSecretRedactionCategories('jwt, aws-access-key, unknown')).toEqual(['jwt', 'aws-access-key'])
    expect(parseSecretRedactionCategories(['credit-card', 'jwt'])).toEqual(['credit-card', 'jwt'])
  })

  it('redacts JWTs, AWS keys, AWS secrets, credit cards, PEM keys, provider API keys, and Bearer tokens', () => {
    const jwt = makeTestJwt()
    const input = [
      `Session JWT: ${jwt}`,
      `AWS Key: ${TEST_AWS_KEY} and STS: ${TEST_AWS_STS_KEY}`,
      `aws_secret_access_key=${TEST_AWS_SECRET}`,
      `Visa: ${TEST_VISA_HYPHEN}, MC: ${TEST_MASTERCARD_SPACES}, Amex: ${TEST_AMEX_HYPHEN}`,
      `GitHub: ${TEST_GH_PAT} / ${TEST_GH_FINE}`,
      `OpenAI: ${TEST_OPENAI_KEY}`,
      `Stripe: ${TEST_STRIPE_KEY}`,
      `Slack: ${TEST_SLACK_TOKEN}`,
      `Google: ${TEST_GOOGLE_KEY}`,
      `SendGrid: ${TEST_SENDGRID_KEY}`,
      `Authorization: Bearer ${TEST_BEARER_OPAQUE}`,
      `Key Block:\n${TEST_PEM_KEY}`,
      `[e1: Submit Order] [e2: Account #1700000000123]`,
    ].join('\n')

    const res = redactSensitiveText(input, { source: 'https://example.test/secrets', kind: 'page_text' })

    expect(res.meta.redacted).toBe(true)
    expect(res.meta.countsByCategory['jwt']).toBe(1)
    expect(res.meta.countsByCategory['aws-access-key']).toBe(2)
    expect(res.meta.countsByCategory['aws-secret-key']).toBe(1)
    expect(res.meta.countsByCategory['credit-card']).toBe(3)
    expect(res.meta.countsByCategory['provider-api-key']).toBe(7)
    expect(res.meta.countsByCategory['bearer-token']).toBe(1)
    expect(res.meta.countsByCategory['private-key']).toBe(1)

    // Ensure none of the raw secrets survive
    for (const secret of [
      jwt,
      TEST_AWS_KEY,
      TEST_AWS_STS_KEY,
      TEST_AWS_SECRET,
      TEST_VISA_HYPHEN,
      TEST_MASTERCARD_SPACES,
      TEST_AMEX_HYPHEN,
      TEST_GH_PAT,
      TEST_GH_FINE,
      TEST_OPENAI_KEY,
      TEST_STRIPE_KEY,
      TEST_SLACK_TOKEN,
      TEST_GOOGLE_KEY,
      TEST_SENDGRID_KEY,
      TEST_BEARER_OPAQUE,
      'MIIEpAIBAAKCAQEA',
    ]) {
      expect(res.text).not.toContain(secret)
    }

    // Check placeholders & preserved non-secret context / [eN] refs
    expect(res.text).toContain('[REDACTED:JWT]')
    expect(res.text).toContain('[REDACTED:AWS_KEY]')
    expect(res.text).toContain('aws_secret_access_key=[REDACTED:AWS_SECRET]')
    expect(res.text).toContain('[REDACTED:CREDIT_CARD]')
    expect(res.text).toContain('[REDACTED:API_KEY]')
    expect(res.text).toContain('Authorization: Bearer [REDACTED:BEARER_TOKEN]')
    expect(res.text).toContain('[REDACTED:PRIVATE_KEY]')
    expect(res.text).toContain('[e1: Submit Order]')
    expect(res.text).toContain('[e2: Account #1700000000123]')

    // Strict 7-bit ASCII check
    // eslint-disable-next-line no-control-regex
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(res.text)).toBe(true)
  })

  it('does not falsely redact benign numbers, version strings, or normal prose', () => {
    const benign = [
      'Order ID: 1234567890123456', // invalid Luhn + non-card IIN
      'Timestamp: 1732784400000',
      'Phone: 555-019-9988',
      'Version: 2.14.3-rc.1',
      'IP: 192.168.1.100',
      'Button [e12: Save Settings]',
      'Normal text with AKIA short word and Bearer short',
    ].join('\n')

    const res = redactSensitiveText(benign)
    expect(res.meta.redacted).toBe(false)
    expect(res.meta.totalRedactions).toBe(0)
    expect(res.text).toBe(benign)
  })

  it('supports partial masking mode', () => {
    const jwt = makeTestJwt()
    const input = `AWS=${TEST_AWS_KEY} Card=${TEST_VISA_HYPHEN} Token=${jwt}`
    const res = redactSensitiveText(input, { options: { enabled: true, mode: 'partial' } })

    expect(res.meta.mode).toBe('partial')
    expect(res.text).toContain('AKIA****[REDACTED:AWS_KEY]')
    expect(res.text).toContain('****-****-****-1111')
    expect(res.text).toContain('eyJ...[REDACTED:JWT]')
    expect(res.text).not.toContain(TEST_AWS_KEY)
    expect(res.text).not.toContain(TEST_VISA_HYPHEN)
    expect(res.text).not.toContain(jwt)
  })

  it('supports category filtering and custom regex patterns', () => {
    const input = `AWS=${TEST_AWS_KEY} Card=${TEST_VISA_PLAIN} Internal=CORP-SECRET-998877`
    const res = redactSensitiveText(input, {
      options: {
        enabled: true,
        categories: ['aws-access-key', 'custom'],
        customPatterns: [{ name: 'corp_secret', pattern: /CORP-SECRET-\d{6}/g }],
      },
    })

    expect(res.text).toContain('[REDACTED:AWS_KEY]')
    expect(res.text).toContain('[REDACTED:CORP_SECRET]')
    // credit-card was excluded from categories
    expect(res.text).toContain(TEST_VISA_PLAIN)
    expect(res.meta.countsByCategory['aws-access-key']).toBe(1)
    expect(res.meta.countsByCategory['custom']).toBe(1)
  })

  it('is idempotent when applied multiple times', () => {
    const input = `Authorization: Bearer ${makeTestJwt()} AWS=${TEST_AWS_KEY} Card=${TEST_DISCOVER_PLAIN}`
    const first = redactSensitiveText(input)
    expect(first.meta.totalRedactions).toBe(3)

    const second = redactSensitiveText(first.text)
    expect(second.meta.totalRedactions).toBe(0)
    expect(second.text).toBe(first.text)
  })

  it('tracks aggregate stats in SecretRedactorGuard without storing raw secret values', () => {
    const guard = new SecretRedactorGuard({ enabled: true })
    const jwt = makeTestJwt()
    guard.redact(`Clean page with no secrets`, { source: 'https://clean.test', kind: 'page_text' })
    guard.redact(`Leak: ${jwt} and ${TEST_AWS_KEY}`, { source: 'https://leak.test/admin', kind: 'page_ascii' })

    const stats = guard.getStats()
    expect(stats.enabled).toBe(true)
    expect(stats.scansCount).toBe(2)
    expect(stats.pagesWithRedactions).toBe(1)
    expect(stats.totalRedactions).toBe(2)
    expect(stats.redactionsByCategory['jwt']).toBe(1)
    expect(stats.redactionsByCategory['aws-access-key']).toBe(1)
    expect(stats.recentRedactions).toHaveLength(1)

    const serialized = JSON.stringify(stats)
    expect(serialized).not.toContain(jwt)
    expect(serialized).not.toContain(TEST_AWS_KEY)

    guard.resetStats()
    expect(guard.getStats().totalRedactions).toBe(0)
    expect(guard.getStats().scansCount).toBe(0)
  })
})

describe('M76: BrowserManager, Agent Socket, MCP & Pipe REPL integration', () => {
  let server: http.Server
  let baseUrl = ''
  const jwt = makeTestJwt({ sub: 'svc_ec2', scope: 'read:all' })
  let toggleExtraSecret = false

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/secrets') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
  <head><title>Credentials Console</title></head>
  <body>
    <h1>Deployment Credentials</h1>
    <p>Bearer token: Bearer ${jwt}</p>
    <p>AWS Access Key: ${TEST_AWS_KEY}</p>
    <p>aws_secret_access_key=${TEST_AWS_SECRET}</p>
    <p>Billing card: ${TEST_VISA_HYPHEN}</p>
    <p>GitHub PAT: ${TEST_GH_PAT}</p>
    ${toggleExtraSecret ? `<p>Secondary Amex: ${TEST_AMEX_HYPHEN}</p>` : ''}
    <form action="/save">
      <label for="tok">API Token</label>
      <input id="tok" name="tok" type="text" value="${TEST_AWS_KEY}" />
      <button type="submit">Rotate Key</button>
    </form>
    <a href="/docs">Documentation</a>
  </body>
</html>`)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('leaves output unredacted by default and redacts when --redact-secrets is enabled', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', memoryEnabled: false })
    try {
      const opened = await manager.openTab(`${baseUrl}/secrets`, { activate: true })
      expect(opened.ok).toBe(true)

      // Default off: raw secrets are present
      const rawText = (await manager.runTool(opened.id, 'page_text', {})) as Record<string, unknown>
      expect(rawText.ok).toBe(true)
      expect(String(rawText.content)).toContain(TEST_AWS_KEY)
      expect(String(rawText.content)).toContain(jwt)
      expect(String(rawText.content)).toContain(TEST_VISA_HYPHEN)
      expect(rawText.secretRedaction).toBeUndefined()

      // Per-call override: redactSecrets: true
      const redactedText = (await manager.runTool(opened.id, 'page_text', {
        redactSecrets: true,
      })) as Record<string, unknown>
      expect(redactedText.ok).toBe(true)
      expect(String(redactedText.content)).not.toContain(TEST_AWS_KEY)
      expect(String(redactedText.content)).not.toContain(jwt)
      expect(String(redactedText.content)).not.toContain(TEST_VISA_HYPHEN)
      expect(String(redactedText.content)).not.toContain(TEST_AWS_SECRET)
      expect(String(redactedText.content)).not.toContain(TEST_GH_PAT)
      expect(String(redactedText.content)).toContain('[REDACTED:AWS_KEY]')
      expect(String(redactedText.content)).toContain('[REDACTED:JWT]')
      expect(String(redactedText.content)).toContain('[REDACTED:CREDIT_CARD]')
      expect((redactedText.secretRedaction as { totalRedactions: number }).totalRedactions).toBeGreaterThanOrEqual(5)
    } finally {
      await manager.close()
    }
  })

  it('redacts across page_read, renderAscii (full & delta), renderMarkdown, page_text by ref, and page_extract when enabled globally', async () => {
    const manager = await BrowserManager.create({
      engine: 'lite',
      memoryEnabled: false,
      redactSecrets: { enabled: true },
    })
    try {
      toggleExtraSecret = false
      const opened = await manager.openTab(`${baseUrl}/secrets`, { activate: true })
      expect(opened.ok).toBe(true)

      // 1. renderAscii full
      const asciiRes = await manager.renderAscii(opened.id, { width: 120 })
      expect(asciiRes.ok).toBe(true)
      expect(asciiRes.ascii).toContain('[REDACTED:AWS_KEY]')
      expect(asciiRes.ascii).toContain('[REDACTED:CREDIT_CARD]')
      expect(asciiRes.ascii).not.toContain(TEST_AWS_KEY)
      expect(asciiRes.ascii).not.toContain(TEST_VISA_HYPHEN)
      expect(asciiRes.ascii).toContain('[e1')
      expect(asciiRes.secretRedaction?.redacted).toBe(true)

      // 2. renderAscii delta (--since)
      toggleExtraSecret = true
      await manager.runTool(opened.id, 'page_navigate', { url: `${baseUrl}/secrets` })
      const deltaRes = await manager.renderAscii(opened.id, { width: 120, since: true })
      expect(deltaRes.ok).toBe(true)
      expect(deltaRes.ascii).not.toContain(TEST_AMEX_HYPHEN)
      expect(deltaRes.ascii).not.toContain(TEST_AWS_KEY)
      toggleExtraSecret = false

      // 3. page_read redacts ascii, content, compactRefs, and elements
      const readRes = (await manager.runTool(opened.id, 'page_read', { width: 120 })) as Record<string, unknown>
      expect(readRes.ok).toBe(true)
      expect(String(readRes.ascii)).not.toContain(TEST_AWS_KEY)
      expect(String(readRes.content)).not.toContain(jwt)
      expect(String(readRes.compactRefs)).not.toContain(TEST_AWS_KEY)
      expect(JSON.stringify(readRes.elements)).not.toContain(TEST_AWS_KEY)

      // 4. page_text by ref redacts element value
      const findRes = (await manager.runTool(opened.id, 'page_find', { query: 'API Token' })) as {
        matches: Array<{ ref: string }>
      }
      expect(findRes.matches.length).toBeGreaterThan(0)
      const refTextRes = (await manager.runTool(opened.id, 'page_text', {
        ref: findRes.matches[0]!.ref,
      })) as Record<string, unknown>
      expect(refTextRes.ok).toBe(true)
      expect(String(refTextRes.value)).toBe('[REDACTED:AWS_KEY]')
      expect((refTextRes.secretRedaction as { totalRedactions: number }).totalRedactions).toBe(1)

      // 5. renderMarkdown
      const mdRes = await manager.renderMarkdown(opened.id)
      expect(mdRes.ok).toBe(true)
      expect(mdRes.markdown).not.toContain(TEST_AWS_KEY)
      expect(mdRes.markdown).not.toContain(jwt)
      expect(mdRes.markdown).toContain('[REDACTED:JWT]')

      // 6. page_extract --ascii
      const extRes = (await manager.runTool(opened.id, 'page_extract', { ascii: true })) as Record<string, unknown>
      expect(extRes.ok).toBe(true)
      expect(String(extRes.ascii)).not.toContain(TEST_AWS_KEY)
      expect(extRes.secretRedaction).toBeDefined()

      // 7. Composition with --untrusted-markers
      const comboRes = await manager.renderAscii(opened.id, {
        width: 120,
        untrustedMarkers: { enabled: true, boundary: 'troy_combo_test' },
      })
      expect(comboRes.ok).toBe(true)
      expect(comboRes.ascii).toContain('troy_combo_test')
      expect(comboRes.ascii).toContain('[REDACTED:AWS_KEY]')
      expect(comboRes.ascii).not.toContain(TEST_AWS_KEY)
      expect(comboRes.secretRedaction?.redacted).toBe(true)
      expect(comboRes.untrustedMarkers?.wrapped).toBe(true)
    } finally {
      await manager.close()
    }
  })

  it('integrates with Agent Socket HTTP endpoints, MCP tools, and Pipe REPL', async () => {
    const manager = await BrowserManager.create({
      engine: 'lite',
      memoryEnabled: false,
      redactSecrets: false,
    })
    const socket = await createAgentSocket(manager, { port: 0 })
    try {
      const opened = await manager.openTab(`${baseUrl}/secrets`, { activate: true })
      expect(opened.ok).toBe(true)

      const post = async (endpoint: string, body: Record<string, unknown> = {}) => {
        const resp = await fetch(`http://127.0.0.1:${socket.port}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-troy-agent': socket.token,
          },
          body: JSON.stringify(body),
        })
        return resp.json() as Promise<Record<string, unknown>>
      }

      // Agent Socket /ascii with redactSecrets: true
      const asciiHttp = await post('/ascii', { tabId: opened.id, width: 120, redactSecrets: true })
      expect(asciiHttp.ok).toBe(true)
      expect(String(asciiHttp.ascii)).toContain('[REDACTED:AWS_KEY]')
      expect(String(asciiHttp.ascii)).not.toContain(TEST_AWS_KEY)
      expect((asciiHttp.secretRedaction as { redacted: boolean }).redacted).toBe(true)

      // Agent Socket /markdown with redact_secrets: true
      const mdHttp = await post('/markdown', { tabId: opened.id, redact_secrets: true })
      expect(mdHttp.ok).toBe(true)
      expect(String(mdHttp.markdown)).toContain('[REDACTED:JWT]')
      expect(String(mdHttp.markdown)).not.toContain(jwt)

      // Agent Socket /tool page_text with redactSecrets: true
      const textHttp = await post('/tool', {
        tabId: opened.id,
        name: 'page_text',
        args: { redactSecrets: true, redactMode: 'partial' },
      })
      expect(textHttp.ok).toBe(true)
      expect(String(textHttp.content)).toContain('AKIA****[REDACTED:AWS_KEY]')
      expect(String(textHttp.content)).toContain('****-****-****-1111')
      expect(String(textHttp.content)).not.toContain(TEST_AWS_KEY)

      // Agent Socket /health exposes secretRedaction stats
      const healthResp = await fetch(`http://127.0.0.1:${socket.port}/health`, {
        headers: { 'x-troy-agent': socket.token },
      })
      const health = (await healthResp.json()) as Record<string, unknown>
      expect(health.ok).toBe(true)
      expect((health.secretRedaction as { totalRedactions: number }).totalRedactions).toBeGreaterThan(0)

      // MCP troy_read_ascii with redactSecrets: true
      const mcpRes = (await handleMcpRequest(manager, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'troy_read_ascii',
          arguments: { tabId: opened.id, width: 120, redactSecrets: true },
        },
      })) as { result?: { content?: Array<{ text?: string }> } }
      const mcpText = mcpRes.result?.content?.[0]?.text ?? ''
      expect(mcpText).toContain('[REDACTED:AWS_KEY]')
      expect(mcpText).not.toContain(TEST_AWS_KEY)

      // Pipe REPL ascii --redact-secrets
      const pipeRes = await executePipeCommand(manager, 'ascii 120 --redact-secrets', true)
      expect(pipeRes.output).toContain('[REDACTED:AWS_KEY]')
      expect(pipeRes.output).not.toContain(TEST_AWS_KEY)
    } finally {
      await socket.close()
      await manager.close()
    }
  })
})
