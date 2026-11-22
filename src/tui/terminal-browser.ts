// Interactive ASCII/ANSI Terminal Browser TUI (`troy-advanced browse [url]`).
// Works over plain SSH, tmux, EC2 serial console, or local terminals.
// Supports both pure 7-bit ASCII mode (--ascii) and ANSI color mode.

import readline from 'node:readline'
import type { BrowserManager } from '../engine/manager.js'

export interface TuiOptions {
  initialUrl?: string
  asciiOnly?: boolean
  color?: boolean
}

export async function runTerminalBrowser(manager: BrowserManager, opts: TuiOptions = {}): Promise<void> {
  let scrollOffset = 0
  let asciiOnly = opts.asciiOnly ?? false
  let color = asciiOnly ? false : (opts.color ?? Boolean(process.stdout.isTTY))
  let statusMessage = 'Type a command (open <url>, click e1, fill e2 txt, j/k scroll, ascii, visual, tabs, quit)'

  if (opts.initialUrl) {
    const opened = await manager.openTab(opts.initialUrl, { activate: true })
    if (!opened.ok) {
      statusMessage = `Error: ${opened.error}`
    }
  } else if (manager.listTabs().length === 0) {
    await manager.openTab(undefined, { activate: true })
  }

  const draw = async () => {
    const width = Math.max(60, Math.min(180, process.stdout.columns || 100))
    const height = Math.max(20, Math.min(80, (process.stdout.rows || 36) - 3))
    const res = await manager.renderAscii(undefined, {
      width,
      height,
      asciiOnly,
      color,
      scrollOffset,
      statusMessage,
    })
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H')
    }
    process.stdout.write(`${res.ascii ?? res.error ?? '(no tab)'}\n`)
  }

  await draw()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'troy-adv> ',
  })

  rl.prompt()

  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) {
      await draw()
      rl.prompt()
      continue
    }

    const [cmdRaw, ...rest] = line.split(/\s+/)
    const cmd = (cmdRaw ?? '').toLowerCase()
    const arg = rest.join(' ')

    try {
      if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
        rl.close()
        return
      } else if (cmd === 'j' || cmd === 'down') {
        scrollOffset += Number(rest[0] || 10)
        statusMessage = `Scrolled down to line ${scrollOffset}`
      } else if (cmd === 'k' || cmd === 'up') {
        scrollOffset = Math.max(0, scrollOffset - Number(rest[0] || 10))
        statusMessage = `Scrolled up to line ${scrollOffset}`
      } else if (cmd === 'top') {
        scrollOffset = 0
        statusMessage = 'Top of page'
      } else if (cmd === 'ascii') {
        asciiOnly = !asciiOnly
        color = !asciiOnly && Boolean(process.stdout.isTTY)
        statusMessage = `Mode: ${asciiOnly ? 'strict 7-bit ASCII' : 'Unicode/ANSI'}`
      } else if (cmd === 'open' || cmd === 'go' || cmd === 'o') {
        const res = await manager.openTab(arg, { activate: true })
        scrollOffset = 0
        statusMessage = res.ok ? `Opened tab ${res.id}: ${res.url}` : `Refused: ${res.error}`
      } else if (cmd === 'nav' || cmd === 'navigate') {
        const res = await manager.runTool(undefined, 'page_navigate', { url: arg })
        scrollOffset = 0
        statusMessage = res.ok ? `Navigated: ${res.url}` : `Error: ${res.error}`
      } else if (cmd === 'click' || cmd === 'c') {
        const allowSubmit = rest.includes('--submit') || rest.includes('--allow-submit')
        const res = await manager.runTool(undefined, 'page_click', { ref: rest[0], allowSubmit })
        statusMessage = res.ok ? `Clicked ${rest[0]} -> ${res.url ?? ''}` : `Refused: ${res.error}`
      } else if (cmd === 'fill' || cmd === 'f') {
        const res = await manager.runTool(undefined, 'page_fill', { ref: rest[0], text: rest.slice(1).join(' ') })
        statusMessage = res.ok ? `Filled ${rest[0]}` : `Error: ${res.error}`
      } else if (cmd === 'select') {
        const res = await manager.runTool(undefined, 'page_select', { ref: rest[0], value: rest.slice(1).join(' ') })
        statusMessage = res.ok ? `Selected ${rest[0]} = ${res.value}` : `Error: ${res.error}`
      } else if (cmd === 'find' || cmd === '/') {
        const res = await manager.runTool(undefined, 'page_find', { query: arg })
        const matches = Array.isArray(res.matches) ? (res.matches as Array<{ ref?: string; text?: string }>) : []
        statusMessage = `Found ${matches.length}: ${matches
          .slice(0, 5)
          .map((m) => `[${m.ref}] ${m.text}`)
          .join(', ')}`
      } else if (cmd === 'back' || cmd === 'forward' || cmd === 'reload') {
        const res = await manager.runTool(undefined, 'page_history', { direction: cmd })
        scrollOffset = 0
        statusMessage = res.ok ? `${cmd}: ${res.url}` : `Error: ${res.error}`
      } else if (cmd === 'grant') {
        const res = manager.grantOrigin(arg)
        statusMessage = res.ok ? `Granted ${res.origin}` : `Error: ${res.error}`
      } else if (cmd === 'tab' || cmd === 't') {
        const res = manager.activateTab(Number(rest[0]))
        scrollOffset = 0
        statusMessage = res.ok ? `Switched to tab ${rest[0]}` : `Error: ${res.error}`
      } else if (cmd === 'visual' || cmd === 'v') {
        const res = await manager.runTool(undefined, 'page_screenshot_ascii', {
          width: Math.max(40, Math.min(120, (process.stdout.columns || 80) - 4)),
          mode: rest[0] === 'braille' ? 'braille' : rest[0] === 'halfblock' ? 'halfblock' : 'ascii',
          annotate: true,
        })
        if (res.ok && typeof res.ascii === 'string') {
          process.stdout.write(`\n${res.ascii}\n`)
          rl.prompt()
          continue
        }
        statusMessage = `Visual error: ${res.error}`
      } else if (cmd === 'help' || cmd === '?') {
        statusMessage = 'open <url> | click eN [--submit] | fill eN <txt> | find <q> | j/k | ascii | visual [braille] | back | reload | tab N | quit'
      } else if (/^e\d+$/.test(cmd)) {
        // Shorthand: typing `e3` clicks `e3`
        const res = await manager.runTool(undefined, 'page_click', { ref: cmd })
        statusMessage = res.ok ? `Clicked ${cmd}` : `Refused: ${res.error}`
      } else {
        statusMessage = `Unknown cmd "${cmd}". Type "help" for commands.`
      }
    } catch (err) {
      statusMessage = `Error: ${(err as Error).message}`
    }

    await draw()
    rl.prompt()
  }
}
