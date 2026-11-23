import http from 'node:http'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStrictAscii, stripAnsi } from '../src/ascii/sanitize.js'
import { BrowserManager } from '../src/engine/manager.js'
import {
  createFormModalState,
  isFormModalElement,
  overlayModalOnFrame,
  renderFormModalBox,
} from '../src/tui/form-modal.js'
import {
  TerminalBrowserController,
  type TuiInputStream,
  type TuiOutputStream,
} from '../src/tui/terminal-browser.js'
import type { ElementDescriptor } from '../src/types.js'

function createMockOutput(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = []
  const stream = new PassThrough() as unknown as TuiOutputStream & PassThrough
  stream.isTTY = opts.isTTY ?? false
  stream.columns = opts.columns ?? 110
  stream.rows = opts.rows ?? 28
  stream.on('data', (chunk) => {
    chunks.push(chunk.toString('utf8'))
  })
  return {
    stream,
    getText: () => chunks.join(''),
    getLastChunk: () => chunks[chunks.length - 1] ?? '',
    clear: () => {
      chunks.length = 0
    },
  }
}

function createMockTtyInput() {
  const stream = new PassThrough() as unknown as TuiInputStream & PassThrough
  stream.isTTY = true
  stream.setRawMode = () => {}
  return stream
}

async function typeText(ctrl: TerminalBrowserController, text: string): Promise<void> {
  for (const ch of text) {
    await ctrl.handleKeypress(ch, { sequence: ch })
  }
}

describe('M46: Inline form-filling modal prompt in TUI', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/about') {
        res.end(`<!doctype html><html><head><title>About</title></head><body><h1>About Page</h1></body></html>`)
        return
      }
      res.end(`<!doctype html>
<html>
  <head><title>Form Modal Test</title></head>
  <body>
    <h1>Account Settings</h1>
    <p><a href="/about">About Link</a></p>
    <form action="/save" method="post">
      <label>Username <input name="username" type="text" placeholder="Enter handle" value="anish" /></label>
      <label>Bio <textarea name="bio" placeholder="Short bio">hello world</textarea></label>
      <label>Region
        <select name="region">
          <option value="us-east-1" selected>US East</option>
          <option value="us-west-2">US West</option>
          <option value="eu-west-1">EU West</option>
          <option value="ap-south-1">AP South</option>
        </select>
      </label>
      <label><input name="subscribe" type="checkbox" /> Subscribe to updates</label>
      <label>Locked <input name="locked" type="text" value="fixed" readonly /></label>
      <label>Disabled <input name="disabledField" type="text" value="nope" disabled /></label>
      <label>Password <input name="password" type="password" placeholder="Secret" /></label>
      <button type="submit">Save Profile</button>
    </form>
  </body>
</html>`)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('classifies fillable inputs, textareas, selects vs click-only elements accurately', () => {
    const mk = (partial: Partial<ElementDescriptor>): ElementDescriptor => ({
      selector: '#el',
      tag: 'input',
      type: 'text',
      text: '',
      ...partial,
    })

    expect(isFormModalElement(mk({ tag: 'input', type: 'text' }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'input', type: 'email' }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'input', type: 'password' }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'input', type: 'search' }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'input', type: 'number' }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'textarea', type: '' }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'div', type: '', editable: true }))).toBe('input')
    expect(isFormModalElement(mk({ tag: 'select', type: '' }))).toBe('select')

    // Non-modal click targets
    expect(isFormModalElement(mk({ tag: 'input', type: 'submit' }))).toBeNull()
    expect(isFormModalElement(mk({ tag: 'input', type: 'button' }))).toBeNull()
    expect(isFormModalElement(mk({ tag: 'input', type: 'checkbox' }))).toBeNull()
    expect(isFormModalElement(mk({ tag: 'input', type: 'radio' }))).toBeNull()
    expect(isFormModalElement(mk({ tag: 'input', type: 'file' }))).toBeNull()
    expect(isFormModalElement(mk({ tag: 'a', type: '' }))).toBeNull()
    expect(isFormModalElement(mk({ tag: 'button', type: 'button' }))).toBeNull()
    expect(isFormModalElement(undefined)).toBeNull()
  })

  it('renders strict 7-bit ASCII modal boxes and masks password input values', () => {
    const pwdEl: ElementDescriptor = {
      ref: 'e7',
      selector: 'input[name="password"]',
      tag: 'input',
      type: 'password',
      label: 'Password',
      placeholder: 'Secret passphrase',
      text: '',
    }
    const modal = createFormModalState('e7', pwdEl)
    expect(modal.masked).toBe(true)
    modal.value = 'hunter2'
    modal.cursor = modal.value.length

    const box = renderFormModalBox(modal, { maxWidth: 80, maxHeight: 20, asciiOnly: true, color: false })
    const joined = box.join('\n')
    expect(isStrictAscii(joined)).toBe(true)
    expect(joined).toContain('Edit [e7] <input:password> - Password')
    expect(joined).toContain('*******')
    expect(joined).not.toContain('hunter2')

    const bgFrame = Array.from({ length: 18 }, (_, i) => `| Row ${String(i + 1).padStart(2, '0')} ${'·'.repeat(60)} |`).join('\n')
    const overlaid = overlayModalOnFrame(bgFrame, box, { asciiOnly: true })
    expect(overlaid).toContain('Edit [e7] <input:password> - Password')
    expect(overlaid).toContain('*******')
    // Overlaid modal rows must be strict 7-bit ASCII
    const overlaidLines = overlaid.split('\n')
    const modalRow = overlaidLines.find((l) => l.includes('Edit [e7]'))!
    expect(isStrictAscii(modalRow)).toBe(true)
  })

  it('renders scrollable select modal when there are many options', () => {
    const options = Array.from({ length: 14 }, (_, i) => ({
      value: `opt-${i + 1}`,
      label: `Option ${i + 1}`,
      selected: i === 11,
    }))
    const selectEl: ElementDescriptor = {
      ref: 'e4',
      selector: 'select[name="many"]',
      tag: 'select',
      type: 'select',
      label: 'Many Choices',
      text: '',
      options,
    }
    const modal = createFormModalState('e4', selectEl)
    expect(modal.selectedIndex).toBe(11)

    const box = renderFormModalBox(modal, { maxWidth: 90, maxHeight: 14, asciiOnly: true, color: false })
    const joined = box.join('\n')
    expect(joined).toContain('Select [e4] <select> - Many Choices')
    expect(joined).toContain('> ')
    expect(joined).toContain('Option 12')
    expect(joined).toContain('of 14')
    expect(isStrictAscii(joined)).toBe(true)
  })

  it('opens inline input modal on Enter for <input>, supports full cursor editing, and submits via page_fill', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
    try {
      const input = createMockTtyInput()
      const out = createMockOutput({ isTTY: false, columns: 100, rows: 26 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        input,
        output: out.stream,
        asciiOnly: true,
      })

      await ctrl.init()

      // Find username input ref by tabbing until focusedRef is the username input
      let usernameRef: string | null = null
      for (let i = 0; i < 10; i++) {
        await ctrl.handleKeypress('\t', { name: 'tab' })
        const st = ctrl.getState()
        if (st.focusedTooltip?.includes('Username') || st.focusedTooltip?.includes('Enter handle')) {
          usernameRef = st.focusedRef
          break
        }
      }
      expect(usernameRef).toBeTruthy()

      // Press Enter -> opens inline form modal prefilled with "anish"
      out.clear()
      await ctrl.handleKeypress('\r', { name: 'return' })
      const modalState = ctrl.getState()
      expect(modalState.mode).toBe('modal')
      expect(modalState.formModal?.kind).toBe('input')
      expect(modalState.formModal?.ref).toBe(usernameRef)
      expect(modalState.formModal?.value).toBe('anish')
      expect(modalState.formModal?.cursor).toBe(5)

      const modalFrame = out.getText()
      expect(modalFrame).toContain(`Edit [${usernameRef}]`)
      expect(modalFrame).toContain('> anish_')
      expect(isStrictAscii(modalFrame)).toBe(true)

      // Test cursor editing: Left, Left, insert "X", Backspace, Ctrl+U clear, type "dexter bot", Ctrl+W, type "agent"
      await ctrl.handleKeypress(undefined, { name: 'left' })
      await ctrl.handleKeypress(undefined, { name: 'left' })
      expect(ctrl.getState().formModal?.cursor).toBe(3)
      await ctrl.handleKeypress('X', { sequence: 'X' })
      expect(ctrl.getState().formModal?.value).toBe('aniXsh')
      await ctrl.handleKeypress('\x7f', { name: 'backspace' })
      expect(ctrl.getState().formModal?.value).toBe('anish')

      // Ctrl+U clears entire buffer
      await ctrl.handleKeypress('\x15', { name: 'u', ctrl: true })
      expect(ctrl.getState().formModal?.value).toBe('')
      expect(ctrl.getState().formModal?.cursor).toBe(0)

      // Type "dexter bot", Ctrl+W removes "bot", type "agent"
      await typeText(ctrl, 'dexter bot')
      expect(ctrl.getState().formModal?.value).toBe('dexter bot')
      await ctrl.handleKeypress('\x17', { name: 'w', ctrl: true })
      expect(ctrl.getState().formModal?.value).toBe('dexter ')
      await typeText(ctrl, 'agent')
      expect(ctrl.getState().formModal?.value).toBe('dexter agent')

      // Home + Delete removes 'd', then reinsert 'D'
      await ctrl.handleKeypress(undefined, { name: 'home' })
      expect(ctrl.getState().formModal?.cursor).toBe(0)
      await ctrl.handleKeypress(undefined, { name: 'delete' })
      await ctrl.handleKeypress('D', { sequence: 'D' })
      expect(ctrl.getState().formModal?.value).toBe('Dexter agent')

      // Press Enter -> submits page_fill and closes modal
      out.clear()
      await ctrl.handleKeypress('\r', { name: 'return' })
      const afterSubmit = ctrl.getState()
      expect(afterSubmit.mode).toBe('normal')
      expect(afterSubmit.formModal).toBeNull()
      expect(afterSubmit.statusMessage).toContain(`Filled ${usernameRef}`)
      expect(afterSubmit.statusMessage).toContain('Dexter agent')
      expect(out.getText()).toContain('Dexter agent')
    } finally {
      await manager.close()
    }
  })

  it('cancels modal with Escape without modifying the field', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
    try {
      const input = createMockTtyInput()
      const out = createMockOutput({ isTTY: false, columns: 100, rows: 26 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        input,
        output: out.stream,
      })

      await ctrl.init()

      // Focus username input (second ref after /about link)
      await ctrl.handleKeypress('\t', { name: 'tab' })
      await ctrl.handleKeypress('\t', { name: 'tab' })
      const ref = ctrl.getState().focusedRef
      expect(ref).toBe('e2')

      await ctrl.handleKeypress('\r', { name: 'return' })
      expect(ctrl.getState().mode).toBe('modal')
      await ctrl.handleKeypress('\x15', { name: 'u', ctrl: true })
      await typeText(ctrl, 'discard-me')
      expect(ctrl.getState().formModal?.value).toBe('discard-me')

      // Cancel with Escape
      await ctrl.handleKeypress('\x1b', { name: 'escape' })
      const st = ctrl.getState()
      expect(st.mode).toBe('normal')
      expect(st.formModal).toBeNull()
      expect(st.statusMessage).toContain('Cancelled editing e2')
      expect(st.focusedTooltip).toContain('anish')
    } finally {
      await manager.close()
    }
  })

  it('opens inline <select> picker modal on Enter, navigates options, and submits via page_select', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
    try {
      const input = createMockTtyInput()
      const out = createMockOutput({ isTTY: true, columns: 110, rows: 28 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        input,
        output: out.stream,
        color: true,
      })

      await ctrl.init()

      // Tab to <select name="region">
      let selectRef: string | null = null
      for (let i = 0; i < 12; i++) {
        await ctrl.handleKeypress('\t', { name: 'tab' })
        const st = ctrl.getState()
        if (st.focusedTooltip?.includes('<select')) {
          selectRef = st.focusedRef
          break
        }
      }
      expect(selectRef).toBeTruthy()

      // Press Enter -> opens select picker modal
      out.clear()
      await ctrl.handleKeypress('\r', { name: 'return' })
      const openState = ctrl.getState()
      expect(openState.mode).toBe('modal')
      expect(openState.formModal?.kind).toBe('select')
      expect(openState.formModal?.options.length).toBe(4)
      expect(openState.formModal?.selectedIndex).toBe(0)

      const rendered = stripAnsi(out.getText())
      expect(rendered).toContain(`Select [${selectRef}] <select>`)
      expect(rendered).toContain('US East')
      expect(rendered).toContain('EU West')

      // Navigate with j -> index 1, then digit '3' -> index 2 (EU West), then G -> index 3 (AP South), then k -> index 2 (EU West)
      await ctrl.handleKeypress('j', { sequence: 'j' })
      expect(ctrl.getState().formModal?.selectedIndex).toBe(1)
      await ctrl.handleKeypress('3', { sequence: '3' })
      expect(ctrl.getState().formModal?.selectedIndex).toBe(2)
      await ctrl.handleKeypress('G', { name: 'g', shift: true, sequence: 'G' })
      expect(ctrl.getState().formModal?.selectedIndex).toBe(3)
      await ctrl.handleKeypress('k', { sequence: 'k' })
      expect(ctrl.getState().formModal?.selectedIndex).toBe(2)

      // Press Enter -> submits page_select with 'eu-west-1'
      await ctrl.handleKeypress('\r', { name: 'return' })
      const afterSelect = ctrl.getState()
      expect(afterSelect.mode).toBe('normal')
      expect(afterSelect.formModal).toBeNull()
      expect(afterSelect.statusMessage).toContain(`Selected ${selectRef} = EU West`)
    } finally {
      await manager.close()
    }
  })

  it('refuses disabled/readonly inputs cleanly, keeps links/checkboxes as direct click, and works in split-pane mode', async () => {
    const manager = await BrowserManager.create({ engine: 'lite', autoGrantAll: true })
    try {
      const input = createMockTtyInput()
      const out = createMockOutput({ isTTY: false, columns: 120, rows: 28 })
      const ctrl = new TerminalBrowserController(manager, {
        initialUrl: baseUrl,
        rawMode: true,
        input,
        output: out.stream,
        splitPane: true,
        asciiOnly: true,
      })

      await ctrl.init()
      expect(ctrl.getState().splitPane).toBe(true)

      // Tab through elements to test checkbox, readonly, disabled, and password
      let testedReadOnly = false
      let testedDisabled = false
      let testedCheckbox = false
      let testedPassword = false

      const totalRefs = ctrl.getState().availableRefs.length
      for (let i = 0; i < totalRefs * 2 + 4; i++) {
        await ctrl.handleKeypress('\t', { name: 'tab' })
        const st = ctrl.getState()
        const tip = st.focusedTooltip ?? ''
        if (!testedCheckbox && tip.toLowerCase().includes('checkbox')) {
          await ctrl.handleKeypress('\r', { name: 'return' })
          expect(ctrl.getState().mode).toBe('normal')
          expect(ctrl.getState().statusMessage).toContain('Activated')
          testedCheckbox = true
        } else if (!testedReadOnly && tip.toLowerCase().includes('readonly')) {
          await ctrl.handleKeypress('\r', { name: 'return' })
          expect(ctrl.getState().mode).toBe('normal')
          expect(ctrl.getState().statusMessage).toContain('read-only')
          testedReadOnly = true
        } else if (!testedDisabled && tip.toLowerCase().includes('disabled')) {
          await ctrl.handleKeypress('\r', { name: 'return' })
          expect(ctrl.getState().mode).toBe('normal')
          expect(ctrl.getState().statusMessage).toContain('disabled')
          testedDisabled = true
        } else if (!testedPassword && tip.toLowerCase().includes('password')) {
          out.clear()
          await ctrl.handleKeypress('\r', { name: 'return' })
          expect(ctrl.getState().mode).toBe('modal')
          expect(ctrl.getState().formModal?.masked).toBe(true)
          await typeText(ctrl, 's3cr3t')
          const frame = out.getText()
          expect(frame).toContain('******')
          expect(frame).not.toContain('s3cr3t')
          // Submitting a password input is refused by sensitive-field policy cleanly
          await ctrl.handleKeypress('\r', { name: 'return' })
          expect(ctrl.getState().mode).toBe('normal')
          expect(ctrl.getState().statusMessage).toContain('Refused')
          testedPassword = true
        }
      }

      expect(testedCheckbox).toBe(true)
      expect(testedReadOnly).toBe(true)
      expect(testedDisabled).toBe(true)
      expect(testedPassword).toBe(true)
    } finally {
      await manager.close()
    }
  })
})
