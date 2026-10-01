/**
 * File handling for the compress pipeline: sensitive path refusal, atomic
 * writes, backups, and source reading.
 *
 * TypeScript port of the non-model parts of
 * `skills/caveman-compress/scripts/compress.py` (MIT, © JuliusBrussee).
 * The `callClaude` half is deliberately not ported: this plugin compresses
 * with deterministic local rules instead (see `compress-rules.ts`). The
 * Python original is dropped.
 *
 * @module dsh-caveman/compress-files
 */
/**
 * Packaged default for the `maxFileSize` cap (500000 bytes, ~500 KB), used when
 * the plugin row does not override it. `apply` validates the configured value
 * and threads it through the pipeline; this is only the default.
 */
export declare const MAX_FILE_SIZE = 500000;
/**
 * Heuristic denylist for files that must never be rewritten by a tool that
 * ships bytes to a model. Fail loudly rather than exfiltrate.
 * @param filePath - absolute file path.
 * @returns true when the path looks sensitive.
 */
export declare function isSensitivePath(filePath: string): boolean;
/**
 * Out-of-tree backup dir for a file, keyed by its parent dir name, kept
 * outside the source tree so skill auto-loaders don't re-ingest backups.
 * @param filePath - absolute source path.
 * @returns the backup directory.
 */
export declare function backupDirFor(filePath: string): string;
/**
 * Backup file path for a source file.
 * @param filePath - absolute source path.
 * @returns the `.original.md` backup path.
 */
export declare function backupPathFor(filePath: string): string;
/** A write syscall-shaped function: bytes written, possibly fewer than asked. */
export type WriteCall = (fd: number, buffer: Buffer, offset: number, length: number) => number;
/**
 * Write bytes atomically: sibling temp file, fsync, rename. Loops over short
 * writes so the temp file is never a truncated prefix of `data`. Preserves the
 * destination's permission bits across the swap.
 * @param filePath - destination path.
 * @param data - bytes to write.
 * @param write - write syscall seam; defaults to `fs.writeSync`.
 * @param exclusive - publish a backup only if its destination does not exist.
 */
export declare function writeBytesAtomic(filePath: string, data: Buffer, write?: WriteCall, exclusive?: boolean): void;
/**
 * Write text atomically as UTF-8, preserving the document's line terminator.
 * @param filePath - destination path.
 * @param text - text with `\n` line endings.
 * @param newline - line terminator to emit.
 */
export declare function writeTextAtomic(filePath: string, text: string, newline?: '\n' | '\r\n'): void;
/** A source file read exactly: decoded text, line terminator, raw bytes. */
export interface SourceFile {
    readonly text: string;
    readonly newline: '\n' | '\r\n';
    readonly raw: Buffer;
    /** True when the file started with a UTF-8 BOM, stripped from `text`. */
    readonly bom: boolean;
}
/**
 * Read a source file strictly as UTF-8. A file that cannot be decoded
 * exactly is refused: the round trip would destroy bytes.
 *
 * A leading BOM is detected from the raw bytes and reported separately: the
 * decoder drops it, and the caller re-attaches it when writing so the byte
 * survives the round trip.
 * @param filePath - absolute source path.
 * @returns text (LF-normalized), terminator, raw bytes for the backup, BOM flag.
 */
export declare function readSource(filePath: string): SourceFile;
