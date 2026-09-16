import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildModeInstructions,
  filterSkillBodyForMode,
  isDeactivationCommand,
  normalizeCommandMode,
  normalizeMode,
  resolveDefaultMode,
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

test('resolveDefaultMode prefers config, then env, then file, then full', () => {
  assert.equal(resolveDefaultMode({ configured: 'ultra', env: { CAVEMAN_DEFAULT_MODE: 'lite' }, configFile: { defaultMode: 'full' } }), 'ultra')
  assert.equal(resolveDefaultMode({ configured: 'wenyan-full', env: {} }), 'wenyan-full')
  assert.equal(resolveDefaultMode({ env: { CAVEMAN_DEFAULT_MODE: 'wenyan-ultra' } }), 'wenyan-ultra')
  assert.equal(resolveDefaultMode({ configFile: { defaultMode: 'lite' }, env: {} }), 'lite')
  assert.equal(resolveDefaultMode({ configFile: { defaultMode: 'nonsense' }, env: {} }), 'full')
  assert.equal(resolveDefaultMode({ env: {} }), 'full')
  assert.equal(resolveDefaultMode({ env: { CAVEMAN_DEFAULT_MODE: 'nonsense' } }), 'full')
  assert.equal(resolveDefaultMode({ env: { CAVEMAN_DEFAULT_MODE: 'review' } }), 'full')
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
  assert.match(full, /^CAVEMAN MODE ACTIVE — level: full\n\n# The rules/)
  assert.match(full, /fluff die$/)

  const wenyan = buildModeInstructions({ mode: 'wenyan-full', skillBody: '# rules' })
  assert.match(wenyan, /^CAVEMAN MODE ACTIVE — level: wenyan-full\n\n/)
})
