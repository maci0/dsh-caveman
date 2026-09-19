#!/usr/bin/env node
/**
 * Fixed-scenario bench for the caveman compress pipeline.
 *
 * Scenario: one deterministic markdown corpus (see `markdown-corpus.mjs`),
 * passed through the same helpers `compressFile` calls — frontmatter parse,
 * `compressBody`, `validate`. No filesystem, no network, no clock dependency
 * beyond the reported p50/p95.
 *
 * Usage:
 *   node bench/compress-bench.mjs [--kb=256] [--runs=30] [--warmup=5] [--repeat=1]
 *
 * Prints one JSON object on stdout. Wall clock is reported for the product
 * view; `cpuMicros` is the load-resistant counter the perf test asserts on.
 *
 * @module dsh-caveman/bench/compress-bench
 */

import { createHash } from 'node:crypto'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { compressBody } from '../src/compress-rules.ts'
import { validate } from '../src/compress-validate.ts'
import { buildCorpus } from './markdown-corpus.mjs'

function readFlag(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit === undefined ? fallback : Number(hit.slice(prefix.length))
}

const KB = readFlag('kb', 256)
const RUNS = readFlag('runs', 30)
const WARMUP = readFlag('warmup', 5)
/** Full passes per timed sample; raise it when sampling a counter like instructions. */
const REPEAT = readFlag('repeat', 1)

const corpus = buildCorpus(KB * 1024)
const source = `---\ntitle: bench\n---\n${corpus}`

/** One full pipeline pass, identical to what `compressFile` computes. */
function runOnce() {
  const { raw, body } = parseFrontmatter(source)
  const compressedBody = compressBody(body)
  const compressed = raw + compressedBody
  const result = validate(source, compressed)
  return { compressed, isValid: result.isValid }
}

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)]
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

// Warm up: JIT, regex engine caches, megamorphic call sites.
for (let i = 0; i < WARMUP; i += 1) runOnce()

const wallMs = []
const cpuMicros = []
for (let i = 0; i < RUNS; i += 1) {
  const started = process.hrtime.bigint()
  const before = process.cpuUsage()
  let outcome
  for (let pass = 0; pass < REPEAT; pass += 1) outcome = runOnce()
  const after = process.cpuUsage(before)
  wallMs.push(Number(process.hrtime.bigint() - started) / 1e6)
  cpuMicros.push(after.user + after.system)
  if (!outcome.isValid) throw new Error('corpus failed validation')
}

const last = runOnce()
const digest = createHash('sha256').update(last.compressed).digest('hex')

wallMs.sort((left, right) => left - right)
cpuMicros.sort((left, right) => left - right)

process.stdout.write(`${JSON.stringify({
  kb: KB,
  runs: RUNS,
  warmup: WARMUP,
  bytes: source.length,
  compressedBytes: last.compressed.length,
  digest,
  wallMs: { p50: median(wallMs), p95: percentile(wallMs, 0.95) },
  cpuMicros: { p50: median(cpuMicros), min: cpuMicros[0], p95: percentile(cpuMicros, 0.95) },
})}\n`)
