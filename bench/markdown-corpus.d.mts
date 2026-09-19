/**
 * Types for the plain-JS bench corpus generator so the perf test can import it
 * under `strict` without pulling the bench into the TypeScript build.
 *
 * @module dsh-caveman/bench/markdown-corpus
 */

/**
 * Build one deterministic markdown document.
 * @param targetBytes - approximate document size in bytes.
 * @param seed - PRNG seed; same seed and size give identical bytes.
 * @returns markdown text.
 */
export function buildCorpus(targetBytes: number, seed?: number): string
