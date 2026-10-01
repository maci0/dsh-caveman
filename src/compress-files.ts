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

import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
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
  // Match the literal component first: the dot-prefixed denylist entries
  // (`.ssh`, `.gnupg`, …) only exist with their dot, so the stripped form
  // below can never reach them.
  const parts = filePath.split(/[/\\]/).map((part) => part.toLowerCase())
  if (parts.some((part) => SENSITIVE_PATH_COMPONENTS.has(part))) return true
  // Token matching keeps the stripped form: `api-key` must read as `apikey`.
  const flattened = parts.map((part) => part.replace(/[_\-.\s]/g, ''))
  return flattened.some((part) => SENSITIVE_NAME_TOKENS.some((token) => part.includes(token)))
}

/** Platform data dir holding out-of-tree backups. */
function backupsBaseDir(): string {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'caveman-compress', 'backups')
}

/**
 * Out-of-tree backup dir for a file, keyed by its parent dir name, kept
 * outside the source tree so skill auto-loaders don't re-ingest backups.
 * @param filePath - absolute source path.
 * @returns the backup directory.
 */
export function backupDirFor(filePath: string): string {
  return join(backupsBaseDir(), basename(dirname(filePath)))
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

/** A write syscall-shaped function: bytes written, possibly fewer than asked. */
export type WriteCall = (fd: number, buffer: Buffer, offset: number, length: number) => number

/**
 * Write bytes atomically: sibling temp file, fsync, rename. Loops over short
 * writes so the temp file is never a truncated prefix of `data`. Preserves the
 * destination's permission bits across the swap.
 * @param filePath - destination path.
 * @param data - bytes to write.
 * @param write - write syscall seam; defaults to `fs.writeSync`.
 * @param exclusive - publish a backup only if its destination does not exist.
 */
export function writeBytesAtomic(filePath: string, data: Buffer, write: WriteCall = writeSync, exclusive = false): void {
  const tmp = join(dirname(filePath), `${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      let written = 0
      while (written < data.length) {
        const count = write(fd, data, written, data.length - written)
        if (count <= 0) throw new Error(`Short write on ${filePath}: ${written} of ${data.length} bytes`)
        written += count
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (exclusive) linkSync(tmp, filePath)
    else {
      if (existsSync(filePath)) chmodSync(tmp, statSync(filePath).mode & 0o777)
      renameSync(tmp, filePath)
    }
  } finally {
    try { unlinkSync(tmp) } catch { /* Original failure, if any, remains authoritative. */ }
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
  /** True when the file started with a UTF-8 BOM, stripped from `text`. */
  readonly bom: boolean
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
  // The WHATWG UTF-8 decoder already swallows a leading BOM, so the flag has
  // to come from the raw bytes; `text` never holds the U+FEFF.
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length
  const newline = crlf * 2 > lf ? '\r\n' as const : '\n' as const
  return { text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), newline, raw, bom }
}
