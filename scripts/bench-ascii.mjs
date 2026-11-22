#!/usr/bin/env node
import { formatAsciiBenchmarkReport, runDefaultAsciiBenchmarkSuite } from '../dist/ascii/benchmark.js'

const iterations = Number.parseInt(process.env.BENCH_ITERS ?? '80', 10)
const warmupIterations = Number.parseInt(process.env.BENCH_WARMUP ?? '15', 10)
const budgetMs = Number.parseFloat(process.env.BENCH_BUDGET_MS ?? '5.0')

const suite = runDefaultAsciiBenchmarkSuite({ iterations, warmupIterations, budgetMs })
console.log(formatAsciiBenchmarkReport(suite))

if (!suite.allPassed) {
  process.exitCode = 1
}
