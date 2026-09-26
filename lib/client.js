/**
 * dsh-caveman — browser half.
 *
 * Two surfaces read one settings namespace:
 *
 * - the Caveman card on the Plugins page, keyed on the
 *   `caveman` namespace the host half registers; and
 * - a read-only level chip in the composer tool row (`conversation.input.left`),
 *   so the active level is visible without opening Settings.
 *
 * Both read `ctx.configForms`, so they cannot disagree, and both take their
 * copy from the `caveman` locale namespace registered here (en/zh), which is
 * also why every label has an English and a Chinese entry.
 *
 * Chrome is a stylesheet, not inline style objects: the module system claims
 * every `<style>` tag a factory appends while it materializes and removes it
 * when the package unloads, so the tags cost nothing to own. It also keeps
 * state changes out of React's inline-style diffing, which is what silently
 * blanked a deselected pill's border (a longhand removed against a set
 * shorthand decomposes the shorthand).
 *
 * This file is plain JavaScript on purpose. The client module system serves a
 * package's `exports["./client"]` artifact as a lazy-CJS factory registered on
 * `window.__ModuleLoader__`, and that is the whole format — an out-of-tree
 * plugin can author it directly instead of reproducing the repository's tsdown
 * client preset. `react` is provided by the module system; nothing else is
 * required here.
 *
 * The chrome mirrors the shipped plugin cards: a `<li>` disclosure whose header
 * button names the plugin, states the current level, and expands the controls
 * in place. Disclosure is card-local state, as it is for every card in the tab.
 */

window.__ModuleLoader__.load({
  id: 'dsh-caveman',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Settings namespace shared with the host half; also this card's slot key. */
    const NAMESPACE = 'caveman'

    /** Locale namespace for this plugin's copy: both surfaces read one dictionary. */
    const LOCALE_NS = 'caveman'

    /** Every class is `dc-`-prefixed: the sheet lands in the page's own document. */
    const CSS = [
      '.dc-page{display:flex;flex-direction:column;gap:10px}',
      '.dc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dc-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
      '.dc-head{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dc-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
      '.dc-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dc-chevron{flex:none;width:7px;height:7px;margin-top:-3px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transition:transform .16s;transform:rotate(45deg)}',
      '.dc-chevron-open{transform:rotate(225deg);margin-top:3px}',
      '.dc-body{border-top:0.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:10px}',
      '.dc-row{display:flex;flex-wrap:wrap;gap:8px}',
      '.dc-pill{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px}',
      '.dc-pill-selected{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4)}',
      '.dc-pill:disabled{cursor:default;opacity:.5}',
      '.dc-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dc-status{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dc-reset{appearance:none;font:inherit;font-size:12px;line-height:1.5;padding:3px 10px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.dc-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
      '.dc-input{font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;width:100%;box-sizing:border-box}',
      '.dc-input:disabled{cursor:default;opacity:.5}',
      '.dc-field{display:flex;flex-direction:column;gap:6px}',
      '.dc-chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;max-width:180px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:999px}',
    ].join('')

    // Appended while the factory materializes: the module system claims the tag
    // for this package and disposes it on unload. Guarded because the node unit
    // tests evaluate this file without a DOM.
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** Plugin version, shown in the card header. Bump with package.json. */
    const VERSION = '0.11.8'

    const en = {
      title: 'Caveman',
      summary: 'Terse-talk mode. The level persists in settings.',
      description: 'Terse-talk mode — level: {level}{overridden}.',
      version: 'v{version}',
      overridden: ' (overridden)',
      expand: 'Expand',
      collapse: 'Collapse',
      levelGroup: 'Caveman level',
      indicator: 'Caveman: {level}',
      levelOff: 'Off',
      levelLite: 'Lite',
      levelFull: 'Full',
      levelUltra: 'Ultra',
      levelWenyanLite: 'Wenyan-Lite',
      levelWenyanFull: 'Wenyan-Full',
      levelWenyanUltra: 'Wenyan-Ultra',
      hintOff: 'No ruleset injected. Normal behavior.',
      hintLite: 'Drop filler. Keep sentence structure.',
      hintFull: 'Drop articles, filler, pleasantries. Fragments OK. Default.',
      hintUltra: 'Extreme compression. Bare fragments.',
      hintWenyanLite: 'Classical Chinese style, light compression.',
      hintWenyanFull: 'Full 文言文. Maximum classical terseness.',
      hintWenyanUltra: 'Extreme. Ancient scholar on a budget.',
      persists: 'Applies to every request and persists in your settings.',
      readOnly: 'Read-only: settings are not persisted in this deployment.',
      reset: 'Reset',
      compressGroup: 'Memory-file compression (local rules, no model call)',
      compressHint: 'Rewrites .md/.txt memory files in place; original kept out-of-tree.',
      sizeLabel: 'Largest file to compress (bytes)',
      sizeHint: 'A bigger file is refused with its size instead of being rewritten.',
      sizeSave: 'Save',
      sizeSaved: 'Saved. The next compress call uses it.',
      sizeInvalid: 'Must be a whole number of bytes, at least 1.',
      sizeRejected: 'The Host refused the write; the previous cap is still in effect.',
    }

    const zh = {
      title: 'Caveman',
      summary: '简言模式。级别写入设置。',
      description: '简言模式 — 级别：{level}{overridden}。',
      version: 'v{version}',
      overridden: '（已覆盖）',
      expand: '展开',
      collapse: '收起',
      levelGroup: 'Caveman 级别',
      indicator: 'Caveman：{level}',
      levelOff: '关闭',
      levelLite: '轻量',
      levelFull: '完整',
      levelUltra: '极端',
      levelWenyanLite: '文言-轻量',
      levelWenyanFull: '文言-完整',
      levelWenyanUltra: '文言-极端',
      hintOff: '不注入任何规则集，行为如常。',
      hintLite: '去 filler，保留句子结构。',
      hintFull: '去冠词、filler、客套。片段可。默认。',
      hintUltra: '极致压缩。 bare 片段。',
      hintWenyanLite: '文言风格，轻压缩。',
      hintWenyanFull: '全文言文。极致简练。',
      hintWenyanUltra: '极端。惜字如金的古学者。',
      persists: '对每个请求生效，并保存在你的设置中。',
      readOnly: '只读：此部署不会持久化设置。',
      reset: '重置',
      compressGroup: '记忆文件压缩（本地规则，不调用模型）',
      compressHint: '就地重写 .md/.txt 记忆文件；原文件在目录外备份。',
      sizeLabel: '可压缩的最大文件（字节）',
      sizeHint: '超过该值的文件会被拒绝并列出其大小，而不会改写。',
      sizeSave: '保存',
      sizeSaved: '已保存。下一次压缩调用将使用该值。',
      sizeInvalid: '必须是至少为 1 的整数字节数。',
      sizeRejected: 'Host 拒绝了写入；原先的上限仍然有效。',
    }

    /** Every caveman level persists, so the card offers all seven. */
    const LEVELS = [
      { value: 'off', label: 'levelOff', hint: 'hintOff' },
      { value: 'lite', label: 'levelLite', hint: 'hintLite' },
      { value: 'full', label: 'levelFull', hint: 'hintFull' },
      { value: 'ultra', label: 'levelUltra', hint: 'hintUltra' },
      { value: 'wenyan-lite', label: 'levelWenyanLite', hint: 'hintWenyanLite' },
      { value: 'wenyan-full', label: 'levelWenyanFull', hint: 'hintWenyanFull' },
      { value: 'wenyan-ultra', label: 'levelWenyanUltra', hint: 'hintWenyanUltra' },
    ]

    /**
     * Localized name of a level, falling back to the raw value for one this card
     * does not offer (a hand-edited document, a future level).
     * @param t - translate function bound to this plugin's namespace.
     * @param mode - level value.
     * @returns the display name.
     */
    function levelLabel(t, mode) {
      const level = LEVELS.filter((candidate) => candidate.value === mode)[0]
      return level === undefined ? mode : t(level.label)
    }

    /**
     * Bind one scope to a React subscription.
     * @param scope - a scope bound to the caveman settings namespace.
     * @returns a hook reading that scope's current snapshot.
     */
    function useScope(scope) {
      const subscribe = (listener) => scope.subscribe(listener)
      const getSnapshot = () => scope.getSnapshot()
      return () => React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Read a snapshot's level. A namespace the deployment does not serve reports
     * no value, which every surface renders as nothing.
     * @param snapshot - the settings scope snapshot.
     * @returns the active level value, or `undefined` when unreadable.
     */
    function modeOf(snapshot) {
      if (snapshot.status !== 'ready') return undefined
      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      return typeof value.defaultMode === 'string' ? value.defaultMode : 'full'
    }

    /**
     * Build the card component over one bound settings scope.
     * @param scope - the scope bound to the caveman namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the component the slot renders.
     */
    function createCard(scope, t) {
      const useCaveman = useScope(scope)

      return function CavemanCard(props) {
        const snapshot = useCaveman()
        const [error, setError] = React.useState(null)
        // The size cap stages a draft the way a form does; a number cannot be a
        // pill, and one write per Save keeps the document from seeing half-typed
        // values.
        const [sizeDraft, setSizeDraft] = React.useState(null)
        const [sizeStatus, setSizeStatus] = React.useState(null)

        const current = modeOf(snapshot)
        // A namespace this deployment does not serve renders no trace of itself.
        if (current === undefined) return null

        const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
        const overridden = Object.prototype.hasOwnProperty.call(user, 'defaultMode')
        if (props != null && props.view === 'summary') {
          return t('description', {
            level: levelLabel(t, current),
            overridden: overridden ? t('overridden') : '',
          })
        }
        const disabled = !snapshot.writable
        const selected = LEVELS.filter((level) => level.value === current)[0] ?? LEVELS[2]

        const report = (cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
        const write = (run) => {
          setError(null)
          Promise.resolve(run()).catch(report)
        }

        /** Validate and write the staged size cap; the field is volatile, so the
         * running plugin reads it on its next compress call. */
        const saveSize = (current) => {
          setError(null)
          const parsed = Number(sizeDraft ?? current)
          if (!Number.isInteger(parsed) || parsed < 1) {
            setError(t('sizeInvalid'))
            return
          }
          if (parsed === current) {
            setSizeStatus(null)
            return
          }
          write(() => scope.set('maxFileSize', parsed).then((accepted) => {
            if (accepted === false) {
              setError(t('sizeRejected'))
              return
            }
            setSizeDraft(null)
            setSizeStatus(t('sizeSaved'))
          }))
        }

        return React.createElement(
          'div',
          { className: 'dc-page' },
          React.createElement(
            'div',
            { className: 'dc-body' },
              React.createElement(
                'div',
                { className: 'dc-row', role: 'radiogroup', 'aria-label': t('levelGroup') },
                LEVELS.map((level) => React.createElement(
                  'button',
                  {
                    key: level.value,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': current === level.value,
                    disabled,
                    className: `dc-pill${current === level.value ? ' dc-pill-selected' : ''}`,
                    onClick: () => { write(() => scope.set('defaultMode', level.value)) },
                  },
                  t(level.label),
                )),
              ),
              React.createElement('div', { className: 'dc-hint' }, t(selected.hint)),
              React.createElement(
                'div',
                { className: 'dc-hint', role: 'group', 'aria-label': t('compressGroup') },
                t('compressGroup'),
              ),
              React.createElement('div', { className: 'dc-hint' }, t('compressHint')),
              React.createElement(
                'div',
                { className: 'dc-field' },
                React.createElement('span', { className: 'dc-name' }, t('sizeLabel')),
                React.createElement(
                  'div',
                  { className: 'dc-row' },
                  React.createElement('input', {
                    className: 'dc-input',
                    type: 'number',
                    min: 1,
                    value: String(sizeDraft ?? snapshot.value?.maxFileSize ?? ''),
                    disabled,
                    'aria-label': t('sizeLabel'),
                    onChange: (event) => {
                      setSizeStatus(null)
                      setSizeDraft(event.target.value)
                    },
                  }),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dc-reset',
                      disabled,
                      onClick: () => { saveSize(snapshot.value?.maxFileSize) },
                    },
                    t('sizeSave'),
                  ),
                ),
                React.createElement('span', { className: 'dc-hint' }, sizeStatus ?? t('sizeHint')),
              ),
              React.createElement(
                'div',
                { className: 'dc-status' },
                snapshot.writable ? t('persists') : t('readOnly'),
                overridden
                  ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dc-reset',
                      disabled,
                      onClick: () => { write(() => scope.unset('defaultMode')) },
                    },
                    t('reset'),
                  )
                  : null,
              ),
              error === null ? null : React.createElement('div', { className: 'dc-error' }, error),
            ),
        )
      }
    }

    /**
     * Build the read-only level chip for the composer tool row.
     *
     * It reads the same settings scope the card edits, so the two surfaces can
     * never disagree; it renders nothing while the namespace is unavailable or
     * the level is `off`, where a chip would only say "nothing is injected".
     * @param scope - the scope bound to the caveman namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the component the composer slot renders.
     */
    function createIndicator(scope, t) {
      const useCaveman = useScope(scope)

      return function CavemanIndicator() {
        const current = modeOf(useCaveman())
        if (current === undefined || current === 'off') return null

        const text = t('indicator', { level: levelLabel(t, current) })
        return React.createElement('span', { className: 'dc-chip', title: text }, text)
      }
    }

    /**
     * Mount both browser surfaces: the Plugins card and the composer chip.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { en, zh }),
        'dsh-caveman: locale dictionary',
      )

      const scope = ctx.configForms.get(NAMESPACE)
      const Card = createCard(scope, t)
      const Indicator = createIndicator(scope, t)

      // Each owner declares its own slot; injecting waits for it to exist, so
      // these registrations do not depend on plugin load order. The card takes
      // no injected props — it closes over its own bound scope — so the entry
      // declares the documented `locale` namespace and no `inject`.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-caveman#caveman',
        locale: LOCALE_NS,
      }, Card))

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'caveman-level',
        order: 20,
      }, Indicator))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale']
    return module.exports
  },
})
