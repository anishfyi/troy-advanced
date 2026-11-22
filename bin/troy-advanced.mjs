#!/usr/bin/env node
import { main } from '../dist/cli.js'

main(process.argv.slice(2)).catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 2))
  process.exit(1)
})
