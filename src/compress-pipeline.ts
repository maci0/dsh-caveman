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

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { detectFileType, shouldCompress } from './compress-detect.ts'
import { backupPathFor, backupDirFor, isSensitivePath, MAX_FILE_SIZE, readSource, withFileLock, writeBytesAtomic, writeTextAtomic, splitFrontmatter } from './compress-files.ts'
import { compressBody, isSmaller } from './compress-rules.ts'
import { validate } from './compress-validate.ts'

/** Why a compression run refused or failed. */
export type CompressOutcome =
  | { readonly ok: true; readonly backupPath: string; readonly originalChars: number; readonly compressedChars: number }
  | { readonly ok: false; readonly reason: string }

/**
 * Compress one file in place, keeping an out-of-tree backup.
 * @param inputPath - file to compress (resolved before locking).
 * @returns the outcome; the file is untouched unless `ok` is true.
 */
export function compressFile(inputPath: string): CompressOutcome {
  const filePath = resolve(inputPath)

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(filePath)
  } catch {
    return { ok: false, reason: `File not found: ${filePath}` }
  }
  if (!stat.isFile()) return { ok: false, reason: `Not a file: ${filePath}` }
  if (stat.size > MAX_FILE_SIZE) {
    return { ok: false, reason: `File too large to compress safely (max ${MAX_FILE_SIZE} bytes): ${filePath}` }
  }
  if (isSensitivePath(filePath)) {
    return {
      ok: false,
      reason: `Refusing to compress ${filePath}: filename looks sensitive. Rename the file if this is a false positive.`,
    }
  }

  return withFileLock(filePath, () => compressFileLocked(filePath))
}

function compressFileLocked(filePath: string): CompressOutcome {
  const name = basename(filePath)
  let source: ReturnType<typeof readSource>
  try {
    source = readSource(filePath)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!shouldCompress(name, true, () => source.text)) {
    return { ok: false, reason: `Skipping: ${detectFileType(name, () => source.text)} is not natural language` }
  }
  if (source.text.trim() === '') {
    return { ok: false, reason: 'Refusing to compress: file is empty or whitespace-only.' }
  }

  const backupPath = backupPathFor(filePath)
  if (existsSync(backupPath)) {
    return {
      ok: false,
      reason: `Backup already exists: ${backupPath}. Remove or rename it to proceed.`,
    }
  }

  const [frontmatter, body] = splitFrontmatter(source.text)
  if (body.trim() === '') {
    return { ok: false, reason: 'Refusing to compress: body is empty after frontmatter removal.' }
  }

  const compressedBody = compressBody(body)
  if (compressedBody.trim() === '' || compressedBody.trim() === body.trim()) {
    return { ok: false, reason: 'Compression produced no change; original left untouched.' }
  }
  if (!isSmaller(compressedBody, body)) {
    return { ok: false, reason: 'Compressed output is not smaller than input; original left untouched.' }
  }

  const compressed = frontmatter + compressedBody
  const result = validate(source.text, compressed)
  if (!result.isValid) {
    return {
      ok: false,
      reason: `Validation failed: ${result.errors.join('; ')}. Original left untouched.`,
    }
  }

  mkdirSync(backupDirFor(filePath), { recursive: true })
  writeBytesAtomic(backupPath, source.raw)
  writeTextAtomic(filePath, compressed, source.newline)
  return {
    ok: true,
    backupPath,
    originalChars: body.trim().length,
    compressedChars: compressedBody.trim().length,
  }
}
