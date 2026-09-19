/**
 * Deterministic perf gate for the compress pipeline.
 *
 * Metric: `process.cpuUsage()` delta per full pipeline pass over a fixed
 * 512 KB corpus (see `bench/markdown-corpus.mjs`) — CPU time, not wall clock,
 * so descheduling and I/O wait do not move it. Warm up first, then take the
 * minimum of N measured passes: the minimum is the run least disturbed by
 * other work on the machine, which makes it the most reproducible sample.
 *
 * The band is deliberately loose. This is a regression gate for an algorithmic
 * blow-up (a regex recompiled per block, a per-line full-document scan, an
 * O(n²) rebuild), not a benchmark of the host: a machine a few times slower
 * than the recorded reference still passes.
 *
 * Two more counters guard the same scenario. One is asserted below, the other
 * is recorded here because the tool behind it is not on every runner:
 *
 * - instructions retired: `perf stat -e instructions` around
 *   `bench/compress-bench.mjs --kb=2048 --repeat=12` — 94.98e9 now, 115.5e9
 *   before the allocation and regex pass. At this test's 512 KB corpus it is
 *   ~1.00e9 per pass (was ~1.19e9). Not asserted: no `perf` on CI runners.
 * - young-generation allocation: Scavenge count from `--trace-gc` with a
 *   pinned 4 MB semi-space, asserted in the third test. At
 *   `--kb=2048 --repeat=12` it is 715 now and 750 before, over the same 24 MB
 *   of input, with a run-to-run spread of about one collection.
 *
 * Reference (recorded, not asserted): AMD Ryzen 9 9950X, Node v26.9.0,
 * ~14.8 ms CPU per pass minimum, ~1.00e9 instructions per pass.
 *
 * @module dsh-caveman/tests/compress-perf
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildCorpus } from '../bench/markdown-corpus.mjs'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { compressBody } from '../src/compress-rules.ts'
import { validate } from '../src/compress-validate.ts'

/** Corpus size for the gate; the reference numbers above are for this size. */
const CORPUS_BYTES = 512 * 1024

/** Warm-up passes: JIT, regex engine caches, megamorphic call sites. */
const WARMUP_PASSES = 5

/** Measured passes; the minimum across them is the reported sample. */
const MEASURED_PASSES = 10

/**
 * Ceiling for the minimum per-pass CPU time, in microseconds. Reference is
 * ~14.8 ms; 35 ms leaves room for a slower host or a co-tenant stealing CPU
 * while still failing on a real per-pass blow-up. Tightened from 45 ms (the
 * band for the ~17.8 ms reference) so the gate tracks the current pipeline
 * instead of the one it replaced.
 */
const MAX_CPU_MICROS_PER_PASS = 35_000

/**
 * Ceiling for young-generation collections over the fixed allocation workload
 * (see the third test). Reference is 111–112 for the current pipeline and
 * 137–138 for the one before the allocation pass, measured with a pinned 4 MB
 * semi-space; each collection accounts for the same slice of it, so a
 * re-added per-pass allocation moves the count well before it moves CPU time.
 * The band sits ~15% above the reference, under the old pipeline's floor.
 */
const MAX_SCAVENGES = 128

/** The bench harness the allocation gate drives as a child process. */
const benchScript = fileURLToPath(new URL('../bench/compress-bench.mjs', import.meta.url))

/** Package root, so the child process resolves `yaml` like the parent does. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/** SHA-256 of the compressed corpus on the reference recording. */
const REFERENCE_DIGEST = 'eb594746295408c16215f358e8091668ba587ea165d50ba01cb50e80bab48601'

const corpus = buildCorpus(CORPUS_BYTES)
const source = `---\ntitle: perf\n---\n${corpus}`

function runPipeline(): string {
  const { raw, body } = parseFrontmatter(source)
  const compressedBody = compressBody(body)
  const compressed = raw + compressedBody
  const result = validate(source, compressed)
  assert.equal(result.isValid, true, `corpus failed validation: ${result.errors.join('; ')}`)
  return compressed
}

test('compress pipeline stays inside its CPU budget on a fixed corpus', () => {
  for (let pass = 0; pass < WARMUP_PASSES; pass += 1) runPipeline()

  const samples: number[] = []
  for (let pass = 0; pass < MEASURED_PASSES; pass += 1) {
    const before = process.cpuUsage()
    runPipeline()
    const after = process.cpuUsage(before)
    samples.push(after.user + after.system)
  }

  const fastest = Math.min(...samples)
  const sorted = samples.toSorted((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  console.log(
    `compress-perf: ${CORPUS_BYTES} B corpus, min ${(fastest / 1000).toFixed(1)} ms, `
    + `median ${(median / 1000).toFixed(1)} ms CPU per pass `
    + `(budget ${(MAX_CPU_MICROS_PER_PASS / 1000).toFixed(0)} ms)`,
  )

  assert.ok(
    fastest < MAX_CPU_MICROS_PER_PASS,
    `compress pipeline retired ${(fastest / 1000).toFixed(1)} ms CPU for one pass `
    + `over ${CORPUS_BYTES} bytes; budget is ${(MAX_CPU_MICROS_PER_PASS / 1000).toFixed(0)} ms. `
    + 'A real algorithmic regression, or a host much slower than the recorded reference — '
    + 're-run bench/compress-bench.mjs before raising the budget.',
  )
})

test('compress pipeline output is byte-stable on the fixed corpus', () => {
  const digest = createHash('sha256').update(runPipeline()).digest('hex')
  assert.equal(digest, REFERENCE_DIGEST, 'compressed bytes changed; update only with a deliberate rule change')
})

test('compress pipeline young-generation allocation stays inside its budget', () => {
  // Allocation churn, not time: with a pinned young generation, one scavenge
  // costs a fixed slice of the semi-space, so the count over a fixed workload
  // is a work counter — it tracks bytes allocated, not the host's clock. The
  // in-process equivalent (`perf_hooks` gc entries) is too coarse to gate on:
  // it separates the current pipeline from the previous one by two events.
  const result = execFileSync(process.execPath, [
    '--max-semi-space-size=4',
    '--trace-gc',
    benchScript,
    '--kb=512',
    '--repeat=8',
    '--runs=3',
    '--warmup=2',
  ], { cwd: packageRoot, encoding: 'utf8' })

  const scavenges = result.match(/Scavenge/g)?.length ?? 0
  console.log(
    `compress-perf: fixed 512 KB workload allocated into ${scavenges} young-generation `
    + `collections (budget ${MAX_SCAVENGES})`,
  )

  assert.ok(
    scavenges <= MAX_SCAVENGES,
    `compress pipeline needed ${scavenges} young-generation collections for a fixed `
    + `512 KB workload; budget is ${MAX_SCAVENGES}. `
    + 'Something on the pass path allocates per line, per block, or per document again — '
    + 'check what the pass allocates before raising the budget.',
  )
})
