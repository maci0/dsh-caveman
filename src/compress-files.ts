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

import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Packaged default for the `maxFileSize` cap (500000 bytes, ~500 KB), used when
 * the plugin row does not override it. `apply` validates the configured value
 * and threads it through the pipeline; this is only the default.
 */
export const MAX_FILE_SIZE = 500_000

const SENSITIVE_BASENAME_REGEX = /^(\.env(\..+)?|\.netrc|credentials(\..+)?|secrets?(\..+)?|passwords?(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|authorized_keys|known_hosts|.*\.(pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg))$/i

const SENSITIVE_PATH_COMPONENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker',
  'credential', 'credentials', 'secret', 'secrets',
])

const SENSITIVE_NAME_TOKENS = [
  'secret', 'credential', 'password', 'passwd',
  'apikey', 'accesskey', 'token', 'privatekey',
]

/**
 * Heuristic denylist for files that must never be rewritten by a tool that
 * ships bytes to a model. Fail loudly rather than exfiltrate.
 * @param filePath - absolute file path.
 * @returns true when the path looks sensitive.
 */
export function isSensitivePath(filePath: string): boolean {
  if (SENSITIVE_BASENAME_REGEX.test(basename(filePath))) return true
  const parts = filePath.split('/').map((part) => part.toLowerCase().replace(/[_\-.\s]/g, ''))
  if (parts.some((part) => SENSITIVE_PATH_COMPONENTS.has(part))) return true
  return parts.some((part) => SENSITIVE_NAME_TOKENS.some((token) => part.includes(token)))
}

/** Platform data dir holding out-of-tree backups. */
function backupsBaseDir(): string {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'caveman-compress', 'backups')
}

/** Override root for backups, set from the `compressBackupDir` setting. Empty = platform default. */
let backupRootOverride = ''

/**
 * Set the backup root override. Empty string restores the platform default.
 * @param dir - override directory, or empty.
 */
export function setBackupRootOverride(dir: string): void {
  backupRootOverride = dir
}

/**
 * Out-of-tree backup dir for a file, keyed by its parent dir name — kept
 * outside the source tree so skill auto-loaders don't re-ingest backups.
 * Honors the override when set.
 * @param filePath - absolute source path.
 * @returns the backup directory.
 */
export function backupDirFor(filePath: string): string {
  const root = backupRootOverride !== '' ? backupRootOverride : backupsBaseDir()
  return join(root, basename(dirname(filePath)))
}

/**
 * Backup file path for a source file.
 * @param filePath - absolute source path.
 * @returns the `.original.md` backup path.
 */
export function backupPathFor(filePath: string): string {
  const stem = basename(filePath).replace(/\.[^.]*$/, '')
  return join(backupDirFor(filePath), `${stem}.original.md`)
}

/**
 * Write bytes atomically: sibling temp file, fsync, rename. Preserves the
 * destination's permission bits across the swap.
 * @param filePath - destination path.
 * @param data - bytes to write.
 */
export function writeBytesAtomic(filePath: string, data: Buffer): void {
  const tmp = join(dirname(filePath), `${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (existsSync(filePath)) chmodSync(tmp, statSync(filePath).mode & 0o777)
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Ignore cleanup failure; the original error is what matters.
    }
    throw error
  }
}

/**
 * Write text atomically as UTF-8, preserving the document's line terminator.
 * @param filePath - destination path.
 * @param text - text with `\n` line endings.
 * @param newline - line terminator to emit.
 */
export function writeTextAtomic(filePath: string, text: string, newline: '\n' | '\r\n' = '\n'): void {
  const normalized = newline === '\n' ? text : text.replace(/\r\n/g, '\n').replace(/\n/g, newline)
  writeBytesAtomic(filePath, Buffer.from(normalized, 'utf8'))
}

/** A source file read exactly: decoded text, line terminator, raw bytes. */
export interface SourceFile {
  readonly text: string
  readonly newline: '\n' | '\r\n'
  readonly raw: Buffer
}

/**
 * Read a source file strictly as UTF-8. A file that cannot be decoded
 * exactly is refused: the round trip would destroy bytes.
 * @param filePath - absolute source path.
 * @returns text (LF-normalized), terminator, and raw bytes for the backup.
 */
export function readSource(filePath: string): SourceFile {
  const raw = readFileSync(filePath)
  let text: string
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    text = decoded
  } catch {
    throw new Error(
      `Refusing to compress ${filePath}: not valid UTF-8. `
      + 'Compression rewrites the file in place, and any byte this tool '
      + 'cannot decode would be destroyed by the round trip. '
      + 'Convert the file to UTF-8 first.',
    )
  }
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length
  const newline = crlf * 2 > lf ? '\r\n' as const : '\n' as const
  return { text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), newline, raw }
}
