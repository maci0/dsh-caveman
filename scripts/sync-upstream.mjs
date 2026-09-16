#!/usr/bin/env node
/**
 * Sync bundled upstream files from JuliusBrussee/caveman.
 *
 * Reads `sync.manifest.json` next to this script:
 * - `verbatim`: byte-identical copies, overwritten on `sync`, diffed on `check`;
 * - `patched`: DSH-adapted files, never overwritten; `check` only reports that
 *   upstream moved, so a human can re-apply the adaptation.
 *
 * Upstream paths mirror local paths minus the `skills/` prefix quirk:
 * `skills/caveman/SKILL.md` lives at `skills/caveman/SKILL.md` upstream, while
 * `skills/cavecrew/cavecrew-*.md` live at `agents/cavecrew-*.md` upstream.
 * The per-file `upstream` override in the manifest covers the quirk.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs check [--ref <branch|tag|sha>]
 *   node scripts/sync-upstream.mjs sync [--ref <branch|tag|sha>] [--force]
 *
 * `check` exits 0 when everything matches, 1 with a file list otherwise.
 * `sync` rewrites stale verbatim files (refusing patched ones) and exits 1
 * when anything changed, so CI can fail on drift. `--force` also syncs when
 * the working tree is dirty; without it, `sync` refuses to avoid clobbering
 * uncommitted work.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'sync.manifest.json')

/** Upstream path overrides for files that live elsewhere upstream. */
const UPSTREAM_OVERRIDES = {
  'skills/cavecrew/cavecrew-investigator.md': 'agents/cavecrew-investigator.md',
  'skills/cavecrew/cavecrew-builder.md': 'agents/cavecrew-builder.md',
  'skills/cavecrew/cavecrew-reviewer.md': 'agents/cavecrew-reviewer.md',
}

function loadManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return {
    upstream: manifest.upstream ?? 'https://github.com/JuliusBrussee/caveman',
    ref: manifest.ref ?? 'main',
    verbatim: manifest.verbatim ?? [],
    patched: manifest.patched ?? [],
  }
}

function parseArgs(argv) {
  const command = argv[2]
  let ref
  let force = false
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--ref') {
      ref = argv[i + 1]
      i += 1
    } else if (argv[i] === '--force') {
      force = true
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argv[i])}`)
    }
  }
  if (command !== 'check' && command !== 'sync') {
    throw new Error(`usage: sync-upstream.mjs (check|sync) [--ref <ref>] [--force]`)
  }
  return { command, ref, force }
}

function upstreamPath(local) {
  return UPSTREAM_OVERRIDES[local] ?? local
}

function fetchUpstream(repo, ref, path) {
  const url = `${repo.replace(/\/$/, '')}/raw/${ref}/${path}`
  try {
    const out = execFileSync('curl', ['-sfL', '--max-time', '60', url], { maxBuffer: 16 * 1024 * 1024 })
    return Buffer.from(out)
  } catch (error) {
    throw new Error(`fetch failed for ${path}@${ref}: ${error.message}`)
  }
}

function isWorkingTreeClean() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: root })
    return out.toString().trim() === ''
  } catch {
    return false
  }
}

function main() {
  const { command, ref: refOverride, force } = parseArgs(process.argv)
  const manifest = loadManifest()
  const ref = refOverride ?? manifest.ref
  const all = [
    ...manifest.verbatim.map((file) => ({ file, kind: 'verbatim' })),
    ...manifest.patched.map((file) => ({ file, kind: 'patched' })),
  ]

  const stale = []
  const cache = new Map()
  for (const { file, kind } of all) {
    const localPath = join(root, file)
    const local = existsSync(localPath) ? readFileSync(localPath) : null
    let remote
    try {
      if (!cache.has(file)) cache.set(file, fetchUpstream(manifest.upstream, ref, upstreamPath(file)))
      remote = cache.get(file)
    } catch (error) {
      console.error(`error: ${error.message}`)
      process.exit(2)
    }
    if (local === null || !local.equals(remote)) stale.push({ file, kind, missing: local === null })
  }

  if (command === 'check') {
    if (stale.length === 0) {
      console.log(`clean: ${all.length} files match ${ref}`)
      return
    }
    for (const { file, kind, missing } of stale) {
      console.log(`${missing ? 'missing' : 'stale'} [${kind}]: ${file}`)
    }
    if (stale.some((s) => s.kind === 'patched')) {
      console.log('note: patched files need manual re-adaptation; see README "Upstream sync"')
    }
    process.exitCode = 1
    return
  }

  // sync: refuse a dirty tree unless forced, then rewrite verbatim files only.
  if (!force && !isWorkingTreeClean()) {
    console.error('error: working tree dirty; commit or stash first, or pass --force')
    process.exit(2)
  }
  const patched = stale.filter((s) => s.kind === 'patched')
  const verbatim = stale.filter((s) => s.kind === 'verbatim')
  for (const { file } of verbatim) {
    const localPath = join(root, file)
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, cache.get(file))
    console.log(`synced: ${file}`)
  }
  if (patched.length > 0) {
    console.log('left for manual re-adaptation:')
    for (const { file } of patched) console.log(`  patched: ${file}`)
  }
  if (stale.length === 0) console.log(`clean: ${all.length} files match ${ref}`)
  process.exit(stale.length === 0 ? 0 : 1)
}

main()
