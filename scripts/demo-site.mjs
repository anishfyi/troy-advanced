#!/usr/bin/env node
import { createDemoServer, formatDemoBanner, parseDemoCliArgs } from '../dist/demo/server.js'

const opts = parseDemoCliArgs(process.argv.slice(2))

if (opts.help) {
  console.log([
    'Usage: node scripts/demo-site.mjs [options]',
    '',
    'Options:',
    '  --host <host>   Bind address (default: 127.0.0.1, env: DEMO_HOST)',
    '  -p, --port <n>  Listen port (default: 4173, env: DEMO_PORT, 0 for random)',
    '  -h, --help      Show this help message',
  ].join('\n'))
  process.exit(0)
}

const demo = createDemoServer({ host: opts.host, port: opts.port })
const { url } = await demo.start()
console.log(formatDemoBanner(url))

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\nReceived ${signal}, stopping demo server...`)
  await demo.stop()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
