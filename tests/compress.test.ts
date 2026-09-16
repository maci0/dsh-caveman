import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { detectFileType, shouldCompress } from '../src/compress-detect.ts'
import { extractCodeBlocks, extractHeadings, extractInlineCodes, extractPaths, extractUrls, validate } from '../src/compress-validate.ts'
import { compressBody, compressLine, isSmaller, maskCodeBlocks, restoreCodeBlocks } from '../src/compress-rules.ts'
import { backupPathFor, isSensitivePath, setBackupRootOverride, splitFrontmatter, writeTextAtomic } from '../src/compress-files.ts'
import { compressFile } from '../src/compress-pipeline.ts'

test('detectFileType classifies by extension, name, and content', () => {
  assert.equal(detectFileType('notes.md'), 'natural_language')
  assert.equal(detectFileType('app.ts'), 'code')
  assert.equal(detectFileType('config.json'), 'config')
  assert.equal(detectFileType('Dockerfile'), 'code')
  assert.equal(detectFileType('CMakeLists.txt'), 'code')
  assert.equal(detectFileType('weird.xyz'), 'unknown')
  assert.equal(detectFileType('TODO', () => 'Buy milk\nCall dentist\n'), 'natural_language')
  assert.equal(detectFileType('run', () => '#!/bin/sh\necho hi\n'), 'code')
  assert.equal(detectFileType('TODO', () => { throw new Error('unreadable') }), 'unknown')
})

test('shouldCompress skips non-files and backups', () => {
  assert.equal(shouldCompress('notes.md', true), true)
  assert.equal(shouldCompress('notes.md', false), false)
  assert.equal(shouldCompress('app.ts', true), false)
  assert.equal(shouldCompress('notes.original.md', true), false)
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
  assert.deepEqual(splitFrontmatter('---\na: b\n---\nbody\n'), ['---\na: b\n---\n', 'body\n'])
  assert.deepEqual(splitFrontmatter('plain\n'), ['', 'plain\n'])
  assert.match(backupPathFor('/a/b/notes.md'), /caveman-compress\/backups\/b\/notes\.original\.md$/)
})

test('compressFile end-to-end: compresses, backs up, refuses twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caveman-pipeline-'))
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

test('backup dir override is honored and resettable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caveman-backupdir-'))
  try {
    const target = join(root, 'note.md')
    await writeFile(target, '# N\n\nYou should always test the big function thoroughly.\n')
    setBackupRootOverride(join(root, 'vault'))
    const outcome = compressFile(target)
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.match(outcome.backupPath, /vault/)
    const second = compressFile(target)
    assert.match((second as { reason: string }).reason, /Backup already exists/)
  } finally {
    setBackupRootOverride('')
    await rm(root, { recursive: true, force: true })
  }
})

test('writeTextAtomic preserves newlines and missing basenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caveman-atomic-'))
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
