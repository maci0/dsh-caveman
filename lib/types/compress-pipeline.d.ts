/**
 * The compress pipeline: detect, guard, rewrite locally, validate, back up,
 * and write. TypeScript port of the orchestration in
 * `skills/caveman-compress/scripts/compress.py` (MIT, © JuliusBrussee) with
 * one deliberate difference: the rewrite step uses deterministic local rules
 * (`compress-rules.ts`) instead of a model call, so no file bytes ever leave
 * the machine and no API key or CLI is needed.
 *
 * Fail-closed throughout: sensitive paths refuse, oversized files refuse,
 * non-UTF-8 refuses, an existing backup aborts, a candidate that is not
 * smaller aborts, and a candidate that fails validation aborts — the live
 * file is written only after a passing validation.
 *
 * @module dsh-caveman/compress-pipeline
 */
/** Why a compression run refused or failed. */
export type CompressOutcome = {
    readonly ok: true;
    readonly backupPath: string;
    readonly originalChars: number;
    readonly compressedChars: number;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * Compress one file in place, keeping an out-of-tree backup.
 * @param inputPath - file to compress.
 * @param maxFileSize - configured size cap in bytes; defaults to the packaged 500000.
 * @returns the outcome; the file is untouched unless `ok` is true.
 */
export declare function compressFile(inputPath: string, maxFileSize?: number): CompressOutcome;
