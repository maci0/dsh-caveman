import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile, readFile, readdir } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { scratchDir } from './scratch.ts'
import { join, basename } from 'node:path'
import { detectFileType } from '../src/compress-detect.ts'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { extractCodeBlocks, extractHeadings, extractInlineCodes, extractPaths, extractUrls, validate } from '../src/compress-validate.ts'
import { compressBody, compressLine, isSmaller, maskCodeBlocks, restoreCodeBlocks } from '../src/compress-rules.ts'
import { backupPathFor, isSensitivePath, writeBytesAtomic, writeTextAtomic } from '../src/compress-files.ts'
import { compressFile } from '../src/compress-pipeline.ts'

// Backups land under `XDG_DATA_HOME`; point it at a directory this suite owns so
// a compression test never writes outside the test's own tree.
const backupHome = await mkdtemp(join(scratchDir, 'caveman-xdg-'))
process.env['XDG_DATA_HOME'] = backupHome
after(() => rm(backupHome, { recursive: true, force: true }))

test('detectFileType classifies by extension, name, and content', () => {
  assert.equal(detectFileType('notes.md'), 'natural_language')
  assert.equal(detectFileType('app.ts'), 'unknown')
  assert.equal(detectFileType('config.json'), 'unknown')
  assert.equal(detectFileType('Dockerfile'), 'code')
  assert.equal(detectFileType('CMakeLists.txt'), 'code')
  assert.equal(detectFileType('weird.xyz'), 'unknown')
  assert.equal(detectFileType('TODO', () => 'Buy milk\nCall dentist\n'), 'natural_language')
  assert.equal(detectFileType('run', () => '#!/bin/sh\necho hi\n'), 'code')
  assert.equal(detectFileType('TODO', () => { throw new Error('unreadable') }), 'unknown')
})

test('compressFile skips a non-file path and never recompresses a backup', async () => {
  const root = await mkdtemp(join(scratchDir, 'caveman-skip-'))
  try {
    const backup = join(root, 'notes.original.md')
    await writeFile(backup, '# Notes\n\nYou should always make sure to run the tests before you push.\n')
    assert.match((compressFile(backup) as { reason: string }).reason, /not natural language/)
    assert.match((compressFile(root) as { reason: string }).reason, /Not a file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate passes a faithful compression and fails a lossy one', () => {
  const original = '# Title\n\nSee https://example.com/docs and `./run.sh`.\n\n```bash\nnpm test\n```\n'
  const good = '# Title\n\nSee https://example.com/docs and `./run.sh`.\n\n```bash\nnpm test\n```\n'.replace('See ', '')
  assert.equal(validate(original, good).isValid, true)

  const renamed = original.replace('# Title', '# Renamed')
  const bad = validate(original, renamed)
  assert.equal(bad.isValid, false)
  assert.match(bad.errors.join(';'), /Heading/)

  const droppedUrl = original.replace('https://example.com/docs ', '')
  assert.equal(validate(original, droppedUrl).isValid, false)

  const droppedCode = original.replace('npm test', 'npm run all')
  assert.equal(validate(original, droppedCode).isValid, false)

  const droppedInline = original.replace('`./run.sh`', 'the script')
  assert.equal(validate(original, droppedInline).isValid, false)
})

test('extractors cover headings, code, urls, paths, inline spans', () => {
  assert.deepEqual(extractHeadings('# A\n## B\n'), [['#', 'A'], ['##', 'B']])
  assert.deepEqual(extractCodeBlocks('```js\nx\n```\n'), ['```js\nx\n```'])
  assert.ok(extractUrls('go https://example.com/x now').has('https://example.com/x'))
  assert.ok(extractPaths('edit ./src/a.ts now').has('./src/a.ts'))
  assert.deepEqual(extractInlineCodes('run `npm test` now'), ['npm test'])
})

test('code masking survives a prose rewrite untouched', () => {
  const body = 'You should run it.\n\n```bash\nnpm test -- --watch\n```\n'
  const { masked, blocks } = maskCodeBlocks(body)
  assert.equal(blocks.length, 1)
  assert.doesNotMatch(masked, /npm test/)
  assert.equal(restoreCodeBlocks(masked, blocks), body)
  assert.throws(() => maskCodeBlocks('@@CAVEMAN_PRESERVED_CODE_ boom'), /reserved/)
})

test('compressLine drops fluff and keeps inline code', () => {
  assert.equal(
    compressLine('You should always make sure to run the tests before push.'),
    'run tests before push.',
  )
  assert.equal(compressLine('Run `npm test` before you push, however.'), 'Run `npm test` before you push.')
  assert.equal(compressLine('The cat sat on the mat.'), 'cat sat on mat.')
})

test('compressBody keeps headings, lists, tables, and code', () => {
  const body = [
    '# Keep Me',
    '',
    '- You should really test the big function.',
    '',
    '| a | b |',
    '|---|---|',
    '| the cat | just sat |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'Use `the API` with care.',
  ].join('\n')
  const compressed = compressBody(body)
  assert.match(compressed, /^# Keep Me$/m)
  assert.match(compressed, /^- test big function\.$/m)
  assert.match(compressed, /const x = 1;/)
  assert.match(compressed, /`the API`/)
  assert.ok(isSmaller(compressed, body))
  assert.equal(isSmaller(body, body), false)
})

test('file helpers refuse sensitive paths and bad encodings', () => {
  assert.equal(isSensitivePath('/home/u/.aws/credentials'), true)
  assert.equal(isSensitivePath('/home/u/secrets.txt'), true)
  assert.equal(isSensitivePath('/home/u/notes.md'), false)
  assert.deepEqual(parseFrontmatter('---\na: b\n---\nbody\n'), {
    raw: '---\na: b\n---\n', data: { a: 'b' }, body: 'body\n',
  })
  assert.deepEqual(parseFrontmatter('plain\n'), { raw: '', data: {}, body: 'plain\n' })
  assert.match(backupPathFor('/a/b/notes.md'), /caveman-compress\/backups\/b\/notes\.original\.md$/)
})

test('dot-prefixed sensitive directories are refused, not compressed', async () => {
  // Regression: the component check stripped `.` before matching, so every
  // dot-prefixed entry in the denylist (`.ssh`, `.gnupg`, `.kube`, …) was
  // unreachable and a file inside one was rewritten in place.
  assert.equal(isSensitivePath('/home/u/.ssh/config'), true)
  assert.equal(isSensitivePath('/home/u/.gnupg/gpg.conf'), true)
  assert.equal(isSensitivePath('C:\\Users\\u\\.kube\\config'), true)

  const root = await mkdtemp(join(scratchDir, 'caveman-dot-dir-'))
  try {
    const config = join(root, '.ssh', 'config')
    await mkdir(join(root, '.ssh'), { recursive: true })
    const original = 'You should really keep this host entry.\n'
    await writeFile(config, original)
    const outcome = compressFile(config)
    assert.equal(outcome.ok, false)
    assert.match((outcome as { reason: string }).reason, /sensitive/)
    assert.equal(await readFile(config, 'utf8'), original, 'the file must be untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('compressFile end-to-end: compresses, backs up, refuses twice', async () => {
  const root = await mkdtemp(join(scratchDir, 'caveman-pipeline-'))
  try {
    const target = join(root, 'memory.md')
    await writeFile(target, '# Memory\n\nYou should always make sure to run the tests. The extensive suite is very big.\n\n```bash\nnpm test\n```\n')
    const first = compressFile(target)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.match(first.backupPath, /memory\.original\.md$/)
    const compressed = await readFile(target, 'utf8')
    assert.match(compressed, /^# Memory$/m)
    assert.match(compressed, /npm test/)
    assert.ok(first.compressedChars < first.originalChars)

    const second = compressFile(target)
    assert.equal(second.ok, false)
    assert.match((second as { reason: string }).reason, /Backup already exists/)

    const code = join(root, 'app.ts')
    await writeFile(code, 'const x = 1;\n')
    assert.match((compressFile(code) as { reason: string }).reason, /not natural language/)

    const secret = join(root, 'secrets.txt')
    await writeFile(secret, 'You should rotate these.\n')
    assert.match((compressFile(secret) as { reason: string }).reason, /sensitive/)

    assert.match((compressFile(join(root, 'missing.md')) as { reason: string }).reason, /not found/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const PROSE = '# Memory\n\nYou should always make sure to run the tests before you push the code. The extensive suite is very big.\n'

test('compressFile keeps a UTF-8 BOM on the rewritten file', async () => {
  // Regression: the decoder swallowed the BOM, validation compared the
  // stripped original, and the rewrite silently dropped the three bytes.
  const root = await mkdtemp(join(scratchDir, 'caveman-bom-'))
  try {
    const target = join(root, 'bom.md')
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await writeFile(target, Buffer.concat([bom, Buffer.from(PROSE)]))
    const outcome = compressFile(target)
    assert.equal(outcome.ok, true)
    const after = await readFile(target)
    assert.deepEqual([...after.subarray(0, 3)], [...bom], 'the BOM survives the rewrite')
    assert.ok(after.length < Buffer.byteLength(PROSE) + 3, 'the body was actually compressed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('compressFile follows a symlink instead of replacing it', async () => {
  // Regression: `resolve` left the link in place, so `rename` swapped the
  // symlink node for a regular file and the real target kept the original.
  const root = await mkdtemp(join(scratchDir, 'caveman-link-'))
  try {
    const realDir = join(root, 'real')
    await mkdir(realDir)
    const target = join(realDir, 'notes.md')
    await writeFile(target, PROSE)
    const link = join(root, 'notes.md')
    await symlink(target, link)

    const outcome = compressFile(link)
    assert.equal(outcome.ok, true)
    assert.equal((await lstat(link)).isSymbolicLink(), true, 'the symlink is not replaced by a regular file')
    assert.match(await readFile(target, 'utf8'), /^run tests before you push code\./m, 'the real target was compressed in place')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a symlink cannot smuggle a sensitive file past the denylist', async () => {
  const root = await mkdtemp(join(scratchDir, 'caveman-link-deny-'))
  try {
    const sshDir = join(root, '.ssh')
    await mkdir(sshDir)
    const secret = join(sshDir, 'config')
    await writeFile(secret, PROSE)
    const link = join(root, 'notes.md')
    await symlink(secret, link)

    const outcome = compressFile(link)
    assert.equal(outcome.ok, false)
    assert.match((outcome as { reason: string }).reason, /sensitive/)
    assert.equal(await readFile(secret, 'utf8'), PROSE, 'the real file must be untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeBytesAtomic writes the whole buffer when the OS reports short writes', async () => {
  // Regression: the returned byte count of a single `writeSync` was ignored, so
  // a short write left a truncated temp file, renamed over the user's only copy.
  const root = await mkdtemp(join(scratchDir, 'caveman-short-write-'))
  try {
    const target = join(root, 'notes.md')
    const data = Buffer.from('x'.repeat(300))
    writeBytesAtomic(target, data, (fd, buffer, offset = 0, length = buffer.length - offset) => writeSync(fd, buffer, offset, Math.min(length, 7)))
    const after = await readFile(target)
    assert.equal(after.length, data.length, 'every byte reaches the file, not just the first short write')
    assert.deepEqual(after, data)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeTextAtomic preserves newlines and missing basenames', async () => {
  const root = await mkdtemp(join(scratchDir, 'caveman-atomic-'))
  try {
    const target = join(root, 'f.md')
    writeTextAtomic(target, 'a\nb\n', '\r\n')
    const raw = await readFile(target)
    assert.ok(raw.includes('\r\n'))
    assert.equal(basename(target), 'f.md')
    await assert.rejects(async () => {
      const { readSource: read } = await import('../src/compress-files.ts')
      const bad = join(root, 'bad.md')
      await writeFile(bad, Buffer.from([0xff, 0xfe]))
      read(bad)
    }, /not valid UTF-8/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('a failed atomic write removes its temporary file and preserves the destination', async () => {
  const root = await mkdtemp(join(scratchDir, 'atomic-fail-'))
  try {
    const target = join(root, 'notes.md')
    await writeFile(target, 'original')
    assert.throws(() => writeBytesAtomic(target, Buffer.from('replacement'), () => 0), /Short write/)
    assert.equal(await readFile(target, 'utf8'), 'original')
    assert.deepEqual(await readdir(root), ['notes.md'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an exclusive backup write never overwrites an existing original', async () => {
  const root = await mkdtemp(join(scratchDir, 'backup-exclusive-'))
  try {
    const target = join(root, 'notes.original.md')
    writeBytesAtomic(target, Buffer.from('original'), writeSync, true)
    assert.throws(() => writeBytesAtomic(target, Buffer.from('replacement'), writeSync, true), /EEXIST/)
    assert.equal(await readFile(target, 'utf8'), 'original')
    assert.deepEqual(await readdir(root), ['notes.original.md'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
