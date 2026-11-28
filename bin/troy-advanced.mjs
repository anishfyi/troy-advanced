#!/usr/bin/env node
import { main } from '../dist/cli.js'
import { handleTopLevelCliError } from '../dist/cli-runtime.js'

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet') || argv.includes('-q')
const verbose = !quiet && (argv.includes('--verbose') || argv.includes('-v'))

main(argv).catch((err) => {
  const exitCode = handleTopLevelCliError(err, { quiet, verbose })
  process.exit(exitCode)
})
