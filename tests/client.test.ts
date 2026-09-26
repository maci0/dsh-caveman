import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(packageRoot, 'lib', 'client.js')

interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** Minimal React stub with stateful hooks, so a click can be re-rendered. */
function createReactStub() {
  const hooks: unknown[] = []
  let cursor = 0
  return {
    reset: (): void => { cursor = 0 },
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props: props ?? {},
      children: children.flat(),
    }),
    useSyncExternalStore: (_subscribe: () => void, getSnapshot: () => unknown): unknown => getSnapshot(),
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const slot = cursor
      cursor += 1
      if (hooks.length <= slot) hooks[slot] = initial
      return [hooks[slot], (next: unknown) => {
        hooks[slot] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(hooks[slot]) : next
      }]
    },
  }
}

type ReactStub = ReturnType<typeof createReactStub>

interface Snapshot {
  status: string
  value: unknown
  user: unknown
  writable: boolean
}

/** Load the bundle the way the client module system does and return its exports. */
function loadBundle(snapshot: Snapshot, calls: { set: unknown[][]; unset: unknown[][] }) {
  const react = createReactStub()
  const scope = {
    subscribe: (): (() => void) => () => {},
    getSnapshot: (): Snapshot => snapshot,
    set: async (field: string, value: unknown): Promise<void> => { calls.set.push([field, value]) },
    unset: async (field: string): Promise<void> => { calls.unset.push([field]) },
  }

  // One dictionary per namespace, keyed by the locale the bundle registers
  // first (`en`), with the service's own `{name}` interpolation.
  const dictionaries: Record<string, Record<string, string>> = {}
  const translate = (ns: string, key: string, params?: Record<string, unknown>): string => {
    const template = dictionaries[ns]?.[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
  const registeredLocales: string[] = []

  const bound: string[] = []
  const injected: string[] = []
  const registered: { entry: Record<string, unknown>; component: () => Element | null }[] = []
  const ctx = {
    configForms: { get: (namespace: string) => { bound.push(namespace); return scope } },
    locale: {
      register: (ns: string, dicts: Record<string, Record<string, string>>): (() => void) => {
        registeredLocales.push(ns)
        dictionaries[ns] = dicts['en'] ?? {}
        return () => {}
      },
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) => translate(ns, key, params),
    },
    effect: (callback: () => unknown): (() => void) => { callback(); return () => {} },
    slots: {
      inject: (name: string, callback: () => unknown): void => { injected.push(name); callback() },
      register: (entry: Record<string, unknown>, component: () => Element | null) => {
        registered.push({ entry, component })
        return () => {}
      },
    },
  }

  let loaded: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
  const windowStub = { __ModuleLoader__: { load: (registration: typeof loaded): void => { loaded = registration } } }
  const requireFn = (id: string): unknown => {
    assert.equal(id, 'react', `the bundle may only require react, got ${id}`)
    return react
  }

  // The bundle is plain JavaScript in the loader's factory format.
  new Function('window', 'require', readFileSync(bundlePath, 'utf8'))(windowStub, requireFn)
  assert.ok(loaded, 'the bundle registered itself on window.__ModuleLoader__')
  assert.equal(loaded.id, 'dsh-caveman')

  const exported = loaded.factory(requireFn)
  ;(exported['apply'] as (ctx: unknown) => void)(ctx)
  return { exported, bound, injected, registered, registeredLocales, react }
}

/** The component registered into one slot, by slot name. */
function componentFor(
  registered: { entry: Record<string, unknown>; component: (props?: { view?: string }) => Element | string | null }[],
  slot: string,
): (props?: { view?: string }) => Element | string | null {
  const found = registered.filter((entry) => entry.entry['name'] === slot)[0]
  assert.ok(found, `no component registered into ${slot}`)
  return found.component
}

/** Collect every element in a rendered tree. */
function walk(node: unknown, found: Element[] = []): Element[] {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) walk(child, found)
    return found
  }
  const element = node as Element
  if ('props' in element && 'type' in element) {
    found.push(element)
    for (const child of element.children) walk(child, found)
  }
  return found
}

/** Render one component through the stub, resetting its hook cursor. */
function render(react: ReactStub, component: (props?: { view?: string }) => Element | string | null, view = 'page'): Element[] {
  react.reset()
  return walk(component({ view }))
}

function buttons(tree: Element[]): Element[] {
  return tree.filter((element) => element.type === 'button')
}

function radios(tree: Element[]): Element[] {
  return tree.filter((element) => element.props['role'] === 'radio')
}

/** Render the row configuration page. */
function openPage(react: ReactStub, component: (props?: { view?: string }) => Element | string | null): Element[] {
  return render(react, component, 'page')
}

/** Fresh write log for the card's settings scope. */
function newCalls(): { set: unknown[][]; unset: unknown[][] } {
  return { set: [], unset: [] }
}

/** The seven persisted levels, in the order the card renders them. */
const LEVEL_LABELS = ['Off', 'Lite', 'Full', 'Ultra', 'Wenyan-Lite', 'Wenyan-Full', 'Wenyan-Ultra'] as const

/**
 * Assert the level radios against that table: every level present in order,
 * checked for `selected` alone. Returns them for follow-up work.
 */
function assertLevels(tree: Element[], selected: string): Element[] {
  const levels = radios(tree).slice(0, 7)
  assert.deepEqual(levels.map((radio) => radio.children[0]), [...LEVEL_LABELS])
  assert.deepEqual(
    levels.map((radio) => radio.props['aria-checked']),
    LEVEL_LABELS.map((label) => label === selected),
  )
  return levels
}

/** Load the bundle, open the settings card, and render it expanded. */
function openCard(
  snapshot: Snapshot,
  calls: { set: unknown[][]; unset: unknown[][] } = newCalls(),
) {
  const bundle = loadBundle(snapshot, calls)
  const component = componentFor(bundle.registered, 'plugins.row.config')
  return { ...bundle, calls, component, open: openPage(bundle.react, component) }
}

test('the card binds the caveman namespace and registers into the plugins tab', () => {
  const calls = newCalls()
  const { exported, bound, injected, registered, registeredLocales } = loadBundle(
    { status: 'ready', value: { defaultMode: 'lite' }, user: { defaultMode: 'lite' }, writable: true },
    calls,
  )

  assert.deepEqual(exported['inject'], ['slots', 'configForms', 'locale'])
  assert.deepEqual(bound, ['caveman'])
  assert.deepEqual(injected, ['plugins.row.config', 'conversation.input.left'])
  assert.deepEqual(registeredLocales, ['caveman'])
  assert.equal(registered.length, 2)
  assert.equal(registered[0]?.entry['name'], 'plugins.row.config')
  assert.equal(registered[0]?.entry['key'], 'dsh-caveman#caveman')
  // The documented keyed-card fields: `locale` names the namespace this card's
  // copy comes from. `inject` stays absent because the card closes over its own
  // bound scope and takes no injected props.
  assert.equal(registered[0]?.entry['locale'], 'caveman')
  assert.equal('inject' in (registered[0]?.entry ?? {}), false)
  assert.equal(registered[1]?.entry['name'], 'conversation.input.left')
  assert.equal(registered[1]?.entry['id'], 'caveman-level')
})

test('the card renders collapsed, naming the plugin and the current level', () => {
  const calls = newCalls()
  const { registered, react } = loadBundle(
    { status: 'ready', value: { defaultMode: 'lite' }, user: {}, writable: true },
    calls,
  )

  const component = componentFor(registered, 'plugins.row.config')
  const tree = render(react, component)

  react.reset()
  assert.equal(component({ view: 'summary' }), 'Terse-talk mode — level: Lite.')
  const levels = assertLevels(tree, 'Lite')
  assert.equal(levels.length, 7)
})

test('expanding reveals one radio per persisted level and writes the chosen one', () => {
  const { calls, open } = openCard({ status: 'ready', value: { defaultMode: 'full' }, user: {}, writable: true })

  const levels = assertLevels(open, 'Full')

  ;(levels[6]?.props['onClick'] as () => void)()
  assert.deepEqual(calls.set, [['defaultMode', 'wenyan-ultra']])
})

test('an overridden level is called out and offers a reset', () => {
  const { calls, open } = openCard({ status: 'ready', value: { defaultMode: 'ultra' }, user: { defaultMode: 'ultra' }, writable: true })

  const reset = buttons(open).find((button) => button.children[0] === 'Reset')
  assert.ok(reset, 'the reset control renders while the field is overridden')
  ;(reset.props['onClick'] as () => void)()
  assert.deepEqual(calls.unset, [['defaultMode']])
})

test('the card disables its controls when the host document is not writable', () => {
  const { open } = openCard({ status: 'ready', value: { defaultMode: 'full' }, user: {}, writable: false })

  const levels = assertLevels(open, 'Full')
  for (const level of levels) assert.equal(level.props['disabled'], true)
})

test('an unavailable namespace renders no trace of the card', () => {
  const calls = newCalls()
  const { registered, react } = loadBundle(
    { status: 'loading', value: undefined, user: undefined, writable: false },
    calls,
  )

  const component = componentFor(registered, 'plugins.row.config')
  react.reset()
  assert.equal(component(), null)
})

test('the size cap is editable, staged, validated, and then written', async () => {
  const { calls, component, react } = openCard({
    status: 'ready', value: { defaultMode: 'lite', maxFileSize: 500000 }, user: {}, writable: true,
  })

  let tree = openPage(react, component)
  const input = () => tree.filter((element) => element.props['aria-label'] === 'Largest file to compress (bytes)')[0]
  const save = () => buttons(tree).filter((element) => String(element.children?.[0] ?? '') === 'Save')[0]
  assert.equal(input()?.props['value'], '500000')
  assert.notEqual(save(), undefined)

  // A cap that is not a whole positive number of bytes never reaches the
  // settings document.
  ;(input()?.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: '0' } })
  tree = openPage(react, component)
  ;(save()?.props['onClick'] as () => void)()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.deepEqual(calls.set, [], 'an invalid cap is refused before the write')
  tree = openPage(react, component)
  assert.match(JSON.stringify(tree.map((element) => element.children)), /whole number of bytes/)

  // A usable cap is written as a number, and the draft clears.
  ;(input()?.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: '250000' } })
  tree = openPage(react, component)
  ;(save()?.props['onClick'] as () => void)()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.deepEqual(calls.set, [['maxFileSize', 250000]])
  tree = openPage(react, component)
  assert.equal(input()?.props['value'], '500000', 'the snapshot decides the shown value once the draft clears')
})

test('the chrome is class-based, so no state change goes through React style diffing', () => {
  const { open } = openCard({ status: 'ready', value: { defaultMode: 'lite' }, user: { defaultMode: 'lite' }, writable: true })

  // An inline object is what let a removed longhand decompose a border
  // shorthand and blank a deselected pill; classes keep every state change out
  // of React's style diffing.
  for (const element of open) {
    assert.equal(element.props['style'], undefined, `${element.type} carries an inline style`)
    assert.equal(typeof element.props['className'], 'string', `${element.type} carries no class`)
  }

  assert.match(String(open.filter((element) => element.type === 'div')[0]?.props['className']), /dc-page/)

  const levels = assertLevels(open, 'Lite')
  const selected = levels.filter((pill) => pill.props['aria-checked'] === true)
  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.props['className'], 'dc-pill dc-pill-selected')
  for (const pill of levels.filter((candidate) => candidate.props['aria-checked'] === false)) {
    assert.equal(pill.props['className'], 'dc-pill')
  }
})

test('the composer chip states the level and vanishes when off or unavailable', () => {
  const calls = newCalls()

  const active = loadBundle(
    { status: 'ready', value: { defaultMode: 'ultra' }, user: {}, writable: true },
    calls,
  )
  const chip = render(active.react, componentFor(active.registered, 'conversation.input.left'))
  assert.equal(chip.length, 1)
  assert.equal(chip[0]?.type, 'span')
  assert.equal(chip[0]?.props['className'], 'dc-chip')
  assert.equal(chip[0]?.children[0], 'Caveman: Ultra')

  const off = loadBundle(
    { status: 'ready', value: { defaultMode: 'off' }, user: { defaultMode: 'off' }, writable: true },
    calls,
  )
  assert.deepEqual(render(off.react, componentFor(off.registered, 'conversation.input.left')), [])

  const unavailable = loadBundle(
    { status: 'loading', value: undefined, user: undefined, writable: false },
    calls,
  )
  assert.deepEqual(render(unavailable.react, componentFor(unavailable.registered, 'conversation.input.left')), [])
})
