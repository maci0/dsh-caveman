import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  buildModeInstructions,
  filterSkillBodyForMode,
  isDeactivationCommand,
  normalizeCommandMode,
  normalizeMode,
  resolveDefaultMode,
  splitModeCommand,
} from '../src/modes.ts'

test('normalizeMode accepts all seven persistable levels', () => {
  assert.equal(normalizeMode('ULTRA'), 'ultra')
  assert.equal(normalizeMode('  off '), 'off')
  assert.equal(normalizeMode('wenyan-full'), 'wenyan-full')
  assert.equal(normalizeMode('WENYAN-LITE'), 'wenyan-lite')
  assert.equal(normalizeMode('wenyan-ultra'), 'wenyan-ultra')
  assert.equal(normalizeMode('review'), undefined)
  assert.equal(normalizeMode(''), undefined)
  assert.equal(normalizeMode(42), undefined)
})

test('normalizeCommandMode adds the bare wenyan shorthand', () => {
  assert.equal(normalizeCommandMode('wenyan'), 'wenyan-full')
  assert.equal(normalizeCommandMode('ultra'), 'ultra')
  assert.equal(normalizeCommandMode('shrug'), undefined)
})

test('normalizeCommandMode tolerates invisible and alternative spellings', () => {
  assert.equal(normalizeCommandMode('wenyan-ultra'), 'wenyan-ultra')
  assert.equal(normalizeCommandMode('\u200bwenyan-ultra'), 'wenyan-ultra')
  assert.equal(normalizeCommandMode('wenyan\u00a0ultra'), 'wenyan-ultra')
  assert.equal(normalizeCommandMode('wenyan_ultra'), 'wenyan-ultra')
  assert.equal(normalizeCommandMode('  Wenyan-Ultra  '), 'wenyan-ultra')
})

test('splitModeCommand keeps the level and reports the message typed after it', () => {
  assert.deepEqual(splitModeCommand('wenyan-ultra'), { mode: 'wenyan-ultra', rest: '' })
  assert.deepEqual(splitModeCommand('  Wenyan-Ultra  '), { mode: 'wenyan-ultra', rest: '' })
  assert.deepEqual(splitModeCommand('wenyan-ultra 已重启，验证caveman'), {
    mode: 'wenyan-ultra',
    rest: '已重启，验证caveman',
  })
  assert.deepEqual(splitModeCommand('full explain this'), { mode: 'full', rest: 'explain this' })
  // Multi-word spellings and deactivation phrases beat their first word.
  assert.deepEqual(splitModeCommand('wenyan full explain'), { mode: 'wenyan-full', rest: 'explain' })
  assert.deepEqual(splitModeCommand('normal mode please'), { mode: 'off', rest: 'please' })
  assert.deepEqual(splitModeCommand('stop caveman'), { mode: 'off', rest: '' })
  assert.deepEqual(splitModeCommand('\u200bwenyan-ultra why'), { mode: 'wenyan-ultra', rest: 'why' })
  // A leading word that is not a level is an error, not a silent level change.
  assert.equal(splitModeCommand('shrug explain'), undefined)
  assert.equal(splitModeCommand(''), undefined)
  // An ordinary sentence starting with a level word still sets that level; the
  // command only runs when the human chooses it.
  assert.deepEqual(splitModeCommand('off topic'), { mode: 'off', rest: 'topic' })
})

test('resolveDefaultMode prefers config, then env, then file, then full, and names the source', () => {
  assert.deepEqual(resolveDefaultMode({ configured: 'ultra', env: { CAVEMAN_DEFAULT_MODE: 'lite' }, configFile: { defaultMode: 'full' } }), { mode: 'ultra', source: 'settings' })
  assert.deepEqual(resolveDefaultMode({ configured: 'wenyan-full', env: {} }), { mode: 'wenyan-full', source: 'settings' })
  assert.deepEqual(resolveDefaultMode({ env: { CAVEMAN_DEFAULT_MODE: 'wenyan-ultra' } }), { mode: 'wenyan-ultra', source: 'env' })
  assert.deepEqual(resolveDefaultMode({ configFile: { defaultMode: 'lite' }, env: {} }), { mode: 'lite', source: 'config-file' })
  assert.deepEqual(resolveDefaultMode({ configFile: { defaultMode: 'nonsense' }, env: {} }), { mode: 'full', source: 'default' })
  assert.deepEqual(resolveDefaultMode({ env: {} }), { mode: 'full', source: 'default' })
  assert.deepEqual(resolveDefaultMode({ env: { CAVEMAN_DEFAULT_MODE: 'nonsense' } }), { mode: 'full', source: 'default' })
  assert.deepEqual(resolveDefaultMode({ env: { CAVEMAN_DEFAULT_MODE: 'review' } }), { mode: 'full', source: 'default' })
})

test('isDeactivationCommand requires the whole message to be the command', () => {
  assert.equal(isDeactivationCommand('stop caveman'), true)
  assert.equal(isDeactivationCommand('  Normal Mode! '), true)
  assert.equal(isDeactivationCommand('stop ponytail'), false)
  assert.equal(isDeactivationCommand('add a normal mode toggle'), false)
  assert.equal(isDeactivationCommand('stop caveman and then build the cache'), false)
})

test('filterSkillBodyForMode keeps only the active level rows and examples', () => {
  const body = [
    '# Caveman',
    '| Level | What change |',
    '|-------|------------|',
    '| **lite** | drop filler |',
    '| **full** | drop articles |',
    '| **ultra** | bare fragments |',
    '| **wenyan-full** | full wenyan |',
    '- lite: "Your component re-renders."',
    '- full: "New object ref each render."',
    '- ultra: "Inline obj prop, new ref."',
    '- wenyan-full: "some classical line."',
    '- Never drop not/never/no/only/except: keep me.',
  ].join('\n')

  const full = filterSkillBodyForMode(body, 'full')
  assert.match(full, /\*\*full\*\* \| drop articles/)
  assert.doesNotMatch(full, /\*\*lite\*\*/)
  assert.doesNotMatch(full, /\*\*ultra\*\*/)
  assert.doesNotMatch(full, /\*\*wenyan-full\*\*/)
  assert.match(full, /- full: "New object ref each render\."/)
  assert.doesNotMatch(full, /- lite:/)
  assert.doesNotMatch(full, /- ultra:/)
  assert.doesNotMatch(full, /- wenyan-full:/)
  assert.match(full, /- Never drop not\/never\/no\/only\/except: keep me\./)

  const wenyan = filterSkillBodyForMode(body, 'wenyan-full')
  assert.match(wenyan, /\*\*wenyan-full\*\* \| full wenyan/)
  assert.doesNotMatch(wenyan, /\*\*full\*\* \|/)
  assert.match(wenyan, /- wenyan-full: "some classical line\."/)
})

test('buildModeInstructions drops the ruleset when off', () => {
  assert.equal(buildModeInstructions({ mode: 'off', skillBody: '# rules' }), '')

  const full = buildModeInstructions({ mode: 'full', skillBody: '# The rules\n\nfluff die' })
  assert.match(full, /^CAVEMAN MODE ACTIVE — level: full\n\nPrecedence: /)
  assert.match(full, /\n\n# The rules\n\nfluff die$/)
  assert.match(full, /fluff die$/)

  const wenyan = buildModeInstructions({ mode: 'wenyan-full', skillBody: '# rules' })
  assert.match(wenyan, /^CAVEMAN MODE ACTIVE — level: wenyan-full\n\n/)
})

test('buildModeInstructions swaps the register by level instead of hard-coding one', () => {
  const body = '# rules'
  const plain = ['lite', 'full', 'ultra'] as const
  const wenyan = ['wenyan-lite', 'wenyan-full', 'wenyan-ultra'] as const

  for (const mode of [...plain, ...wenyan]) {
    const text = buildModeInstructions({ mode, skillBody: body })
    assert.match(text, new RegExp(`^CAVEMAN MODE ACTIVE — level: ${mode}\\n`))
    assert.match(text, /Precedence: this block decides reply length, register, and formatting/)
    assert.match(text, /\n\n# rules$/)
  }

  for (const mode of plain) {
    const text = buildModeInstructions({ mode, skillBody: body })
    assert.match(text, new RegExp(`Register: reply in the user's dominant language \\(level ${mode}\\)`))
    assert.doesNotMatch(text, /classical Chinese/)
    assert.doesNotMatch(text, /Overrides language preservation/)
  }

  for (const mode of wenyan) {
    const text = buildModeInstructions({ mode, skillBody: body })
    assert.match(text, new RegExp(`\\(level ${mode}; classical Chinese\\)\\. Overrides language preservation\\.`))
    assert.match(text, /If the user's dominant language is not Chinese, apply this level's terseness only/)
    assert.doesNotMatch(text, /reply in the user's dominant language/)
  }
})

test('the shipped skill body no longer contradicts its own level', () => {
  const skill = readFileSync(new URL('../skills/caveman/SKILL.md', import.meta.url), 'utf8')
  assert.doesNotMatch(skill, /Compress the style, not the language/)
  assert.doesNotMatch(skill, /Default: \*\*full\*\*/)
  assert.match(skill, /the current user message literally contains/)
  assert.match(skill, /wenyan-ultra 50 words/, 'wenyan levels need their own tighter budgets')
  assert.match(skill, /wenyan-lite 110/)
  assert.match(skill, /Language: reply in the user's dominant language unless the Register line/)
})

