/**
 * Deterministic perf gate for the compress pipeline.
 *
 * Metric: `process.cpuUsage()` delta per full pipeline pass over a fixed
 * 512 KB corpus (see `bench/markdown-corpus.mjs`): CPU time, not wall clock,
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
 *   `bench/compress-bench.mjs --kb=2048 --repeat=12`: 94.98e9 now, 115.5e9
 *   before the allocation and regex pass. At this test's 512 KB corpus it is
 *   ~1.00e9 per pass (was ~1.19e9). Not asserted: no `perf` on CI runners.
 * - allocation churn: JavaScriptCore collections on bun or V8 scavenges on
 *   Node over a fixed bench run, asserted in the third test.
 *
 * Reference (recorded, not asserted): AMD Ryzen 9 9950X, Node v26.9.0,
 * ~14.8 ms CPU per pass minimum, ~1.00e9 instructions per pass. Under bun
 * 1.4.2 on the same host the minimum reads 17 to 22 ms across runs.
 *
 * @module dsh-caveman/tests/compress-perf
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
 * The host-speed yardstick: one regex scan over the same source, run in the
 * same process as the pipeline. Absolute microseconds fail on a slower CI
 * runner; the ratio of pipeline to this scan is what a regression moves.
 */
function calibrate(): number {
  const before = process.cpuUsage()
  for (let pass = 0; pass < 3; pass += 1) source.replace(/[aeiou]/g, '')
  const delta = process.cpuUsage(before)
  return delta.user + delta.system
}

/** A ratio this far above the reference reading is a real regression, not a slow host. */
const MAX_PIPELINE_TO_SCAN_RATIO = 15

/**
 * Ceiling for garbage collections over the fixed allocation workload (see the
 * third test). JavaScriptCore collects once its allocation budget for the
 * cycle (8 MB on the recording host) is spent, so the count tracks bytes
 * allocated, and a re-added per-pass allocation moves it before it moves CPU
 * time. Reference is 46 collections (39 eden, 7 full) on bun 1.4.2 with heap
 * sizing pinned to 16 GiB, steady across runs; the band sits ~20% above it.
 */
const MAX_COLLECTIONS = 56

/** V8's 4 MB semi-space collects 111–112 times; the pre-optimization floor was 137. */
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

  const scanSamples: number[] = []
  for (let pass = 0; pass < MEASURED_PASSES; pass += 1) scanSamples.push(calibrate())
  const scan = Math.min(...scanSamples)

  const fastest = Math.min(...samples)
  const ratio = fastest / scan
  const sorted = samples.toSorted((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  console.log(
    `compress-perf: ${CORPUS_BYTES} B corpus, min ${(fastest / 1000).toFixed(1)} ms, `
    + `median ${(median / 1000).toFixed(1)} ms CPU per pass `
    + `(reference scan ${(scan / 1000).toFixed(2)} ms, ratio ${ratio.toFixed(1)} `
    + `of ${MAX_PIPELINE_TO_SCAN_RATIO} allowed; absolute budget `
    + `${(MAX_CPU_MICROS_PER_PASS / 1000).toFixed(0)} ms on the recording host)`,
  )

  assert.ok(
    ratio < MAX_PIPELINE_TO_SCAN_RATIO,
    `compress pipeline cost ${ratio.toFixed(1)}x the reference scan `
    + `(${(fastest / 1000).toFixed(1)} ms vs ${(scan / 1000).toFixed(2)} ms CPU) over `
    + `${CORPUS_BYTES} bytes; the limit is ${MAX_PIPELINE_TO_SCAN_RATIO}x. `
    + 'Re-run bench/compress-bench.mjs before raising it.',
  )
})

test('compress pipeline output is byte-stable on the fixed corpus', () => {
  const digest = createHash('sha256').update(runPipeline()).digest('hex')
  assert.equal(digest, REFERENCE_DIGEST, 'compressed bytes changed; update only with a deliberate rule change')
})

test('compress pipeline allocation stays inside its collection budget', () => {
  const isBun = process.versions.bun !== undefined
  const budget = isBun ? MAX_COLLECTIONS : MAX_SCAVENGES
  // Allocation churn, not time: each collection follows a fixed allocation
  // budget, so the count over a fixed workload tracks bytes allocated, not the
  // host's clock. The collector runs non-concurrently so its own threads do
  // not decide when a cycle ends. JavaScriptCore writes the log to stderr.
  const result = spawnSync(process.execPath, [
    ...(isBun ? [] : ['--max-semi-space-size=4', '--trace-gc']),
    benchScript,
    '--kb=512',
    '--repeat=8',
    '--runs=3',
    '--warmup=2',
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 120_000,
    // JavaScriptCore sizes its heap from the host's RAM, so the same workload
    // collected 46 times here (16 GiB sizing) and 57 on a smaller CI runner.
    // Pinning the sizing makes the count a property of the code, not the host.
    env: { ...process.env, BUN_JSC_useConcurrentGC: '0', BUN_JSC_logGC: '1', BUN_JSC_forceRAMSize: String(16 * 1024 ** 3) },
  })
  assert.equal(result.status, 0, `bench failed: ${result.stderr.slice(-2000)}`)

  const collections = `${result.stdout}${result.stderr}`.match(isBun ? /=> (Eden|Full)Collection/g : /Scavenge/g)?.length ?? 0
  console.log(
    `compress-perf: fixed 512 KB workload took ${collections} garbage collections `
    + `(budget ${budget})`,
  )

  // Self-check: a runtime that ignores the log option reports nothing, and a
  // zero must not pass as a perfect score.
  assert.ok(collections > 0, 'the bench logged no garbage collections; the counter is not wired')
  assert.ok(
    collections <= budget,
    `compress pipeline needed ${collections} garbage collections for a fixed `
    + `512 KB workload; budget is ${budget}. `
    + 'Something on the pass path allocates per line, per block, or per document again; '
    + 'check what the pass allocates before raising the budget.',
  )
})
