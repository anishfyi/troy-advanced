import { describe, expect, it } from 'vitest'
import { resolveInput, stripTrackingParams, isTrackerHost } from '../src/agent/omnibox.js'
import { authorizeAction, sensitiveElementReason } from '../src/agent/policy.js'
import { ElementRegistry } from '../src/agent/elements.js'

describe('omnibox URL resolver & refusals', () => {
  it('refuses dangerous schemes including disguised control-char payloads', () => {
    expect(resolveInput('javascript:alert(1)').kind).toBe('refused')
    expect(resolveInput('java\nscript://x/%0aalert(document.cookie)').kind).toBe('refused')
    expect(resolveInput('data:text/html,<script>alert(1)</script>').kind).toBe('refused')
    expect(resolveInput('file:///etc/passwd').kind).toBe('refused')
    expect(resolveInput('chrome://settings').kind).toBe('refused')
  })

  it('strips tracking parameters and identifies tracker hosts', () => {
    const res = resolveInput('https://example.com/docs?utm_source=x&fbclid=123&page=2')
    expect(res.kind).toBe('url')
    if (res.kind === 'url') {
      expect(res.url).toBe('https://example.com/docs?page=2')
      expect(res.strippedParams).toBe(2)
    }
    expect(stripTrackingParams('https://a.com/?gclid=abc&keep=1').url).toBe('https://a.com/?keep=1')
    expect(isTrackerHost('https://www.google-analytics.com/collect')).toBe(true)
    expect(isTrackerHost('https://example.com/')).toBe(false)
  })

  it('resolves bare domains, localhost:port, and search queries', () => {
    expect(resolveInput('localhost:3000/app')).toMatchObject({ kind: 'url', url: 'http://localhost:3000/app' })
    expect(resolveInput('example.com')).toMatchObject({ kind: 'url', url: 'https://example.com/' })
    expect(resolveInput('terminal ascii browser')).toMatchObject({ kind: 'search', query: 'terminal ascii browser' })
  })
})

describe('deterministic autonomy policy', () => {
  it('blocks password, file upload, payment, and identity fields', () => {
    expect(sensitiveElementReason({ tag: 'input', type: 'password', text: 'Password' })).toBeTruthy()
    expect(sensitiveElementReason({ tag: 'input', type: 'file', text: 'Upload' })).toBeTruthy()
    expect(sensitiveElementReason({ tag: 'input', type: 'text', name: 'credit-card-number' })).toBeTruthy()
    expect(sensitiveElementReason({ tag: 'input', type: 'text', label: 'Social Security Number' })).toBeTruthy()
    expect(sensitiveElementReason({ tag: 'input', type: 'text', label: 'Search query' })).toBeNull()
  })

  it('enforces origin boundaries and submit confirmation', () => {
    const originDeny = authorizeAction({
      name: 'page_navigate',
      targetUrl: 'https://other.example.com/x',
      allowedOrigins: ['https://allowed.example.com'],
    })
    expect(originDeny.allowed).toBe(false)
    if (!originDeny.allowed) expect(originDeny.code).toBe('origin')

    const submitDeny = authorizeAction({
      name: 'page_click',
      item: { tag: 'button', text: 'Place order', defaultSubmit: true },
      allowSubmit: false,
      allowedOrigins: ['https://allowed.example.com'],
    })
    expect(submitDeny.allowed).toBe(false)
    if (!submitDeny.allowed) expect(submitDeny.code).toBe('submit')

    const submitAllow = authorizeAction({
      name: 'page_click',
      item: { tag: 'button', text: 'Place order', defaultSubmit: true },
      allowSubmit: true,
      allowedOrigins: ['https://allowed.example.com'],
    })
    expect(submitAllow.allowed).toBe(true)
  })
})

describe('ElementRegistry epoch binding', () => {
  it('issues opaque eN refs and invalidates on epoch or URL change', () => {
    const reg = new ElementRegistry()
    const ctx1 = { tabId: 1, url: 'https://example.com', epoch: 1 }
    const registered = reg.register(
      [{ selector: '#search', tag: 'input', type: 'text', text: 'Search' }],
      ctx1,
    )
    expect(registered[0]?.ref).toBe('e1')
    expect(reg.resolve('e1', ctx1)).toMatchObject({ selector: '#search' })
    const stale = reg.resolve('e1', { tabId: 1, url: 'https://example.com', epoch: 2 })
    expect('error' in stale).toBe(true)
  })
})
