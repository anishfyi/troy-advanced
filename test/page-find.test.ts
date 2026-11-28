import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  damerauLevenshtein,
  findElements,
  matchesRoleFilter,
  parseRoleFilters,
  resolveEffectiveRole,
  tokenizeText,
} from '../src/agent/find.js'
import { BrowserManager } from '../src/engine/manager.js'
import { executePipeCommand } from '../src/pipe/repl.js'
import { handleMcpRequest, MCP_TOOLS } from '../src/mcp/server.js'
import type { ElementDescriptor } from '../src/types.js'

const SAMPLE_ELEMENTS: ElementDescriptor[] = [
  {
    ref: 'e1',
    selector: '#nav-home',
    tag: 'a',
    type: '',
    id: 'nav-home',
    text: 'Home',
    href: 'https://example.com/',
  },
  {
    ref: 'e2',
    selector: '#nav-docs',
    tag: 'a',
    type: '',
    id: 'nav-docs',
    text: 'Documentation',
    href: 'https://example.com/documentation',
  },
  {
    ref: 'e3',
    selector: '#nav-pricing',
    tag: 'a',
    type: '',
    id: 'nav-pricing',
    text: 'Pricing',
    href: 'https://example.com/pricing',
  },
  {
    ref: 'e4',
    selector: '#login-link',
    tag: 'a',
    type: '',
    id: 'login-link',
    text: 'Login',
    href: 'https://example.com/login',
  },
  {
    ref: 'e5',
    selector: '#email-input',
    tag: 'input',
    type: 'email',
    id: 'email-input',
    name: 'user_email',
    text: '',
    label: 'Email Address',
    placeholder: 'you@example.com',
  },
  {
    ref: 'e6',
    selector: '#password-input',
    tag: 'input',
    type: 'password',
    id: 'password-input',
    name: 'userPassword',
    text: '',
    label: 'Password',
    placeholder: 'Enter password',
  },
  {
    ref: 'e7',
    selector: '#search-box',
    tag: 'input',
    type: 'search',
    id: 'search-box',
    name: 'q',
    text: '',
    ariaLabel: 'Search products',
    placeholder: 'Search...',
  },
  {
    ref: 'e8',
    selector: '#remember-me',
    tag: 'input',
    type: 'checkbox',
    id: 'remember-me',
    name: 'remember',
    text: '',
    label: 'Remember me',
  },
  {
    ref: 'e9',
    selector: '#plan-select',
    tag: 'select',
    type: 'select-one',
    id: 'plan-select',
    name: 'plan',
    text: '',
    label: 'Subscription Plan',
  },
  {
    ref: 'e10',
    selector: '#signin-btn',
    tag: 'button',
    type: 'submit',
    id: 'signin-btn',
    text: 'Sign In',
    defaultSubmit: true,
  },
  {
    ref: 'e11',
    selector: '#delete-btn',
    tag: 'button',
    type: 'button',
    id: 'delete-btn',
    text: 'Delete Account',
  },
  {
    ref: 'e12',
    selector: '#checkout-btn',
    tag: 'div',
    type: '',
    role: 'button',
    id: 'checkout-btn',
    text: 'Checkout',
    ariaLabel: 'Proceed to Checkout',
  },
  {
    ref: 'e13',
    selector: '#pricing-calc-btn',
    tag: 'button',
    type: 'button',
    id: 'pricing-calc-btn',
    text: 'Pricing Calculator',
  },
  {
    ref: 'e14',
    selector: '#email-support-link',
    tag: 'a',
    type: '',
    id: 'email-support-link',
    text: 'Email Support',
    href: 'mailto:support@example.com',
  },
  {
    ref: 'e15',
    selector: '#disabled-submit',
    tag: 'button',
    type: 'submit',
    id: 'disabled-submit',
    text: 'Sign In',
    disabled: true,
  },
  {
    ref: 'e16',
    selector: '#billing-tab',
    tag: 'div',
    type: '',
    role: 'tab',
    id: 'billing-tab',
    text: 'Billing',
  },
  {
    ref: 'e17',
    selector: '#signup-submit',
    tag: 'input',
    type: 'submit',
    id: 'signup-submit',
    text: 'Sign Up',
    value: 'Sign Up',
  },
  {
    ref: 'e18',
    selector: '#contact-radio',
    tag: 'input',
    type: 'radio',
    id: 'contact-radio',
    name: 'contactMethod',
    text: '',
    label: 'Phone',
  },
]

describe('smart page_find primitives', () => {
  it('computes Damerau-Levenshtein distance including transpositions', () => {
    expect(damerauLevenshtein('login', 'login')).toBe(0)
    expect(damerauLevenshtein('lgoin', 'login')).toBe(1)
    expect(damerauLevenshtein('submt', 'submit')).toBe(1)
    expect(damerauLevenshtein('serach', 'search')).toBe(1)
    expect(damerauLevenshtein('pasword', 'password')).toBe(1)
    expect(damerauLevenshtein('abc', 'xyz')).toBe(3)
  })

  it('tokenizes camelCase, snake_case, kebab-case, and whitespace cleanly', () => {
    expect(tokenizeText('userPassword')).toEqual(expect.arrayContaining(['user', 'password']))
    expect(tokenizeText('user_email-field')).toEqual(expect.arrayContaining(['user', 'email', 'field']))
    expect(tokenizeText('Sign In')).toEqual(['sign', 'in'])
  })

  it('parses role filters and resolves effective ARIA roles', () => {
    expect(parseRoleFilters('button, link')).toEqual(['button', 'link'])
    expect(parseRoleFilters(['LINK', 'input'])).toEqual(['link', 'input'])
    expect(resolveEffectiveRole(SAMPLE_ELEMENTS[6]!)).toBe('searchbox')
    expect(resolveEffectiveRole(SAMPLE_ELEMENTS[11]!)).toBe('button')
    expect(resolveEffectiveRole(SAMPLE_ELEMENTS[16]!)).toBe('button')
    expect(matchesRoleFilter(SAMPLE_ELEMENTS[16]!, 'button')).toBe(true)
    expect(matchesRoleFilter(SAMPLE_ELEMENTS[16]!, 'input')).toBe(false)
    expect(matchesRoleFilter(SAMPLE_ELEMENTS[4]!, 'input')).toBe(true)
    expect(matchesRoleFilter(SAMPLE_ELEMENTS[4]!, 'button')).toBe(false)
  })
})

describe('findElements scoring, fuzzy, synonyms, and ARIA role filters', () => {
  it('matches common typos via fuzzy matching and respects fuzzy: false', () => {
    const res1 = findElements(SAMPLE_ELEMENTS, { query: 'emial' })
    expect(res1.matches.length).toBeGreaterThan(0)
    expect(res1.matches[0]?.ref).toBe('e5')
    expect(res1.matches[0]?.matchedBy.some((r) => r.startsWith('fuzzy:'))).toBe(true)

    const res2 = findElements(SAMPLE_ELEMENTS, { query: 'pasword' })
    expect(res2.matches[0]?.ref).toBe('e6')

    const res3 = findElements(SAMPLE_ELEMENTS, { query: 'serach' })
    expect(res3.matches[0]?.ref).toBe('e7')

    const resNoFuzzy = findElements(SAMPLE_ELEMENTS, { query: 'pasword', fuzzy: false })
    expect(resNoFuzzy.matches.length).toBe(0)
  })

  it('matches UI synonyms and respects synonyms: false', () => {
    const resAuth = findElements(SAMPLE_ELEMENTS, { query: 'authenticate', role: 'button' })
    expect(resAuth.matches.length).toBeGreaterThan(0)
    expect(resAuth.matches[0]?.ref).toBe('e10')
    expect(resAuth.matches[0]?.matchedBy.some((r) => r.startsWith('synonym:'))).toBe(true)

    const resRemove = findElements(SAMPLE_ELEMENTS, { query: 'trash' })
    expect(resRemove.matches[0]?.ref).toBe('e11')

    const resBuy = findElements(SAMPLE_ELEMENTS, { query: 'buy' })
    expect(resBuy.matches[0]?.ref).toBe('e12')

    const resDocs = findElements(SAMPLE_ELEMENTS, { query: 'docs' })
    expect(resDocs.matches[0]?.ref).toBe('e2')

    const resRegister = findElements(SAMPLE_ELEMENTS, { query: 'register' })
    expect(resRegister.matches[0]?.ref).toBe('e17')

    const resNoSyn = findElements(SAMPLE_ELEMENTS, { query: 'trash', synonyms: false })
    expect(resNoSyn.matches.length).toBe(0)
  })

  it('filters strictly by role: button, input, link, select, checkbox, radio, and explicit ARIA roles', () => {
    const buttons = findElements(SAMPLE_ELEMENTS, { role: 'button' })
    const btnRefs = buttons.matches.map((m) => m.ref)
    expect(btnRefs).toEqual(expect.arrayContaining(['e10', 'e11', 'e12', 'e13', 'e15', 'e17']))
    expect(btnRefs).not.toContain('e4') // link
    expect(btnRefs).not.toContain('e5') // email input
    expect(buttons.appliedFilters?.roles).toEqual(['button'])

    const inputs = findElements(SAMPLE_ELEMENTS, { role: 'input' })
    const inputRefs = inputs.matches.map((m) => m.ref)
    expect(inputRefs).toEqual(expect.arrayContaining(['e5', 'e6', 'e7', 'e8', 'e9', 'e18']))
    expect(inputRefs).not.toContain('e10') // button
    expect(inputRefs).not.toContain('e17') // input[type=submit] is a button, not data input
    expect(inputRefs).not.toContain('e1') // link

    const links = findElements(SAMPLE_ELEMENTS, { role: 'link' })
    expect(links.matches.map((m) => m.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e14'])

    const selects = findElements(SAMPLE_ELEMENTS, { role: 'select' })
    expect(selects.matches.map((m) => m.ref)).toEqual(['e9'])

    const checkboxes = findElements(SAMPLE_ELEMENTS, { role: 'checkbox' })
    expect(checkboxes.matches.map((m) => m.ref)).toEqual(['e8'])

    const radios = findElements(SAMPLE_ELEMENTS, { role: 'radio' })
    expect(radios.matches.map((m) => m.ref)).toEqual(['e18'])

    const tabs = findElements(SAMPLE_ELEMENTS, { role: 'tab' })
    expect(tabs.matches.map((m) => m.ref)).toEqual(['e16'])
  })

  it('supports inline role:<name> qualifiers, multi-role filters, and type/tag filters', () => {
    const inline = findElements(SAMPLE_ELEMENTS, { query: 'role:button login' })
    expect(inline.appliedFilters?.roles).toEqual(['button'])
    expect(inline.query).toBe('login')
    expect(inline.matches[0]?.ref).toBe('e10')
    expect(inline.matches.every((m) => m.effectiveRole === 'button')).toBe(true)

    const multi = findElements(SAMPLE_ELEMENTS, { query: 'pricing', role: 'button,link' })
    expect(multi.appliedFilters?.roles).toEqual(['button', 'link'])
    expect(multi.matches.map((m) => m.ref)).toEqual(['e3', 'e13'])

    const byType = findElements(SAMPLE_ELEMENTS, { type: 'email' })
    expect(byType.matches.map((m) => m.ref)).toEqual(['e5'])

    const byTag = findElements(SAMPLE_ELEMENTS, { tag: 'select' })
    expect(byTag.matches.map((m) => m.ref)).toEqual(['e9'])
  })

  it('uses natural-language role hints in queries to boost matching ARIA roles', () => {
    // "sign in button" should prefer <button>Sign In</button> (e10) over <a href="/login">Login</a> (e4)
    const loginBtn = findElements(SAMPLE_ELEMENTS, { query: 'sign in button' })
    expect(loginBtn.matches[0]?.ref).toBe('e10')

    // "email input" should prefer <input type="email"> (e5) over <a href="mailto:...">Email Support</a> (e14)
    const emailInput = findElements(SAMPLE_ELEMENTS, { query: 'email input' })
    expect(emailInput.matches[0]?.ref).toBe('e5')

    // "pricing link" should prefer <a href="/pricing">Pricing</a> (e3) over <button>Pricing Calculator</button> (e13)
    const pricingLink = findElements(SAMPLE_ELEMENTS, { query: 'pricing link' })
    expect(pricingLink.matches[0]?.ref).toBe('e3')

    // Query with nonexistent content + role hint must not blindly match every button
    const none = findElements(SAMPLE_ELEMENTS, { query: 'zxqwy button' })
    expect(none.matches.length).toBe(0)
  })

  it('ranks enabled elements above disabled duplicates, supports enabledOnly, and never leaks selector', () => {
    const both = findElements(SAMPLE_ELEMENTS, { query: 'Sign In', role: 'button' })
    expect(both.matches[0]?.ref).toBe('e10')
    expect(both.matches[1]?.ref).toBe('e15')
    expect(both.matches[0]!.score).toBeGreaterThan(both.matches[1]!.score)

    for (const m of both.matches) {
      expect('selector' in m).toBe(false)
    }

    const enabledOnly = findElements(SAMPLE_ELEMENTS, {
      query: 'Sign In',
      role: 'button',
      enabledOnly: true,
    })
    expect(enabledOnly.matches[0]?.ref).toBe('e10')
    expect(enabledOnly.matches.map((m) => m.ref)).not.toContain('e15')

    const limited = findElements(SAMPLE_ELEMENTS, { role: 'link', limit: 2 })
    expect(limited.matches.length).toBe(2)
  })
})

describe('smart page_find integration across BrowserManager, Pipe REPL, and MCP', () => {
  let server: http.Server
  let baseUrl = ''
  let tmpDir = ''
  let manager: BrowserManager

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-find-test-'))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head><title>Smart Find Portal</title></head>
  <body>
    <nav>
      <a href="/docs">Documentation</a>
      <a href="/login">Login</a>
      <a href="/pricing">Pricing</a>
    </nav>
    <main>
      <form action="/auth" method="post">
        <label for="email">Email Address</label>
        <input id="email" name="email" type="email" placeholder="alice@example.com" />
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" />
        <label for="plan">Plan</label>
        <select id="plan" name="plan">
          <option value="free">Free</option>
          <option value="pro">Pro</option>
        </select>
        <button type="submit">Sign In</button>
      </form>
      <div role="button" aria-label="Delete workspace">Remove</div>
    </main>
  </body>
</html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`

    manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir, memoryEnabled: false })
    await manager.openTab(baseUrl)
  })

  afterAll(async () => {
    await manager.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs smart page_find via BrowserManager with fuzzy, synonym, and ARIA role filters', async () => {
    const btnRes = (await manager.runTool(undefined, 'page_find', {
      query: 'login',
      role: 'button',
    })) as {
      ok: boolean
      count: number
      appliedFilters?: { roles?: string[] }
      matches: Array<{ ref?: string; text: string; effectiveRole?: string }>
    }
    expect(btnRes.ok).toBe(true)
    expect(btnRes.appliedFilters?.roles).toEqual(['button'])
    expect(btnRes.count).toBeGreaterThan(0)
    expect(btnRes.matches[0]?.text).toBe('Sign In')
    expect(btnRes.matches[0]?.effectiveRole).toBe('button')

    const ariaBtnRes = (await manager.runTool(undefined, 'page_find', {
      query: 'trash',
      role: 'button',
    })) as { ok: boolean; matches: Array<{ text: string; ariaLabel?: string; effectiveRole?: string }> }
    expect(ariaBtnRes.matches[0]?.ariaLabel).toBe('Delete workspace')
    expect(ariaBtnRes.matches[0]?.effectiveRole).toBe('button')

    const inputRes = (await manager.runTool(undefined, 'page_find', {
      query: 'emial',
      role: 'input',
    })) as { ok: boolean; matches: Array<{ type: string; effectiveRole?: string }> }
    expect(inputRes.matches[0]?.type).toBe('email')
    expect(inputRes.matches[0]?.effectiveRole).toBe('textbox')
  })

  it('supports smart find flags in Pipe REPL', async () => {
    const res1 = await executePipeCommand(manager, 'find --button login', 'json')
    const parsed1 = JSON.parse(res1.output) as {
      ok: boolean
      appliedFilters?: { roles?: string[] }
      matches: Array<{ text: string }>
    }
    expect(parsed1.ok).toBe(true)
    expect(parsed1.appliedFilters?.roles).toEqual(['button'])
    expect(parsed1.matches[0]?.text).toBe('Sign In')

    const res2 = await executePipeCommand(manager, 'find --link docs', 'json')
    const parsed2 = JSON.parse(res2.output) as {
      ok: boolean
      appliedFilters?: { roles?: string[] }
      matches: Array<{ text: string }>
    }
    expect(parsed2.ok).toBe(true)
    expect(parsed2.appliedFilters?.roles).toEqual(['link'])
    expect(parsed2.matches[0]?.text).toBe('Documentation')

    const res3 = await executePipeCommand(manager, 'find --no-fuzzy pasword', 'json')
    const parsed3 = JSON.parse(res3.output) as { ok: boolean; count: number }
    expect(parsed3.ok).toBe(true)
    expect(parsed3.count).toBe(0)
  })

  it('exposes role/fuzzy/synonyms schema in MCP troy_find and executes smart find over MCP', async () => {
    const toolDef = MCP_TOOLS.find((t) => t.name === 'troy_find')
    expect(toolDef).toBeDefined()
    expect(toolDef?.inputSchema.properties).toHaveProperty('role')
    expect(toolDef?.inputSchema.properties).toHaveProperty('fuzzy')
    expect(toolDef?.inputSchema.properties).toHaveProperty('synonyms')

    const mcpResp = (await handleMcpRequest(manager, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'troy_find',
        arguments: { query: 'pasword', role: 'input', limit: 3 },
      },
    })) as { result: { content: Array<{ text: string }> } }

    const payload = JSON.parse(mcpResp.result.content[0]!.text) as {
      ok: boolean
      appliedFilters?: { roles?: string[] }
      matches: Array<{ type: string; effectiveRole: string; score: number }>
    }
    expect(payload.ok).toBe(true)
    expect(payload.appliedFilters?.roles).toEqual(['input'])
    expect(payload.matches[0]?.type).toBe('password')
    expect(payload.matches[0]?.score).toBeGreaterThan(0)
  })
})
