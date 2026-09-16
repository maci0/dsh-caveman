# dsh-caveman

**Caveman terse-talk mode, as a DeepSeek Harness plugin.**

Adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT).
"why use many token when few do trick"

| Capability | Extension point | Effect |
|---|---|---|
| Always-on ruleset | `ctx.systemPrompt.section()` | While a level other than `off` is active, the mode-filtered caveman ruleset is part of every request. |
| Thirteen skills | `ctx.skills.registerProvider()` | `caveman`, `cavecrew`, `caveman-commit`, `caveman-review`, `caveman-compress`, `caveman-stats`, `caveman-help`, plus six work patterns — loadable through the `skill` tool, and so appearing as `/caveman-review`, … in the composer, which is DSH's own command surface for user-invocable skills. |
| Level control | `ctx.tools.register()` + `ctx.commands.register()` + `ctx.on('session/event')` | The model calls the `caveman` tool; the human types `/caveman [lite\|full\|ultra\|wenyan-lite\|wenyan-full\|wenyan-ultra\|off]` or just says **stop caveman** / **normal mode**. |
| Settings card | `ctx.settings.installSection()` + `settings.plugin.item` | A **Caveman** card in Settings → Plugins → **Plugin configuration**, collapsed like the shipped cards and expanding to a seven-level picker. |
| Composer chip | `conversation.input.left` | A read-only level chip in the composer tool row, so the active level is visible without opening Settings. Hidden while the level is `off`. |
| Localized copy | `ctx.locale.register()` | The card and the chip ship `en` + `zh` dictionaries under the `caveman` locale namespace. |

## What it changes

One talking style. Code, commands, file paths, and exact error messages are
never compressed — only the prose around them. The skill drops to full
sentences for security warnings and irreversible confirmations, then picks the
club back up.

`skills/caveman/SKILL.md` is the source of truth, and it is the exact text
injected into every request while a level other than `off` is active; this
README deliberately keeps no second copy of it.

## Levels

| Level | Behavior | Persisted |
|---|---|---|
| `lite` | Drop filler. Keep sentence structure. | yes |
| `full` | Drop articles, filler, pleasantries, hedging. Fragments OK. Default. | yes |
| `ultra` | Extreme compression. Bare fragments. | yes |
| `wenyan-lite` | Classical Chinese style, light compression. | yes |
| `wenyan-full` | Full 文言文. Maximum classical terseness. (`/caveman wenyan` shorthand.) | yes |
| `wenyan-ultra` | Extreme. Ancient scholar on a budget. | yes |
| `off` | No injection. Normal behavior. | yes |

All seven levels live in the `caveman` settings namespace
(`~/.dsh/settings.yaml`), so the card, the chip, the tool, and `/caveman` all
agree and the choice survives a restart.

### Switching from a message

`/caveman full` is a command. Typing **stop caveman** or **normal mode** as an
ordinary message is picked up from the durable `user/message` event, which
arrives before the turn's prompt is assembled — so the turn that carried the
command already runs without the ruleset, rather than one turn later.

Only the human's own words count. Injected context (a skill body, a file
reference, replayed history) rides the same event stream and can never toggle
the level, and the message must *be* the command: "add a normal mode toggle" is
left alone.

## Install

The plugin is two halves in one package and has no runtime dependencies beyond
`@deepseek-ai/schemastery` (the settings service serializes the namespace
schema with it):

- **host half** — `src/index.ts`, loaded by the Loader from the profile;
- **browser half** — `lib/client.js`, served by the client module system because
  the package declares `dsh.client` and exports `./client`.

### Install

Live-reload install: keep the package as a **plain dependency** (no
`dsh.bundle`) and put the Loader row in the profile's own
`cordis.patch.yml`. That file is what `patchReload: live` watches.
`dsh.profile.bundles` is frozen at boot — do not put this package there.

```sh
dsh plugin --profile web add /path/to/dsh-caveman
# pnpm will warn "declares no dsh.bundle — installed as a plain dependency". That is the point.
```

Then paste this into `~/.dsh/profiles/web/cordis.patch.yml` (or merge into
an existing `- insert:` list):

```yaml
- insert:
    - id: caveman
      name: dsh-caveman
      config:
        defaultMode: full
```

Saving that file remounts the plugin. No profile restart. `insert` does not
dedupe ids — never also list this package in `dsh.profile.bundles`.

### Verify

After the profile patch save (and a **page refresh** of the Web client the first time):

- Settings → Plugins → **Plugin configuration** shows the Caveman card;
- the `skill` tool's catalog lists the thirteen caveman skills;
- the composer tool row shows a `Caveman: full` chip until the level is `off`;
- `/caveman` reports the current level in the composer;
- sending exactly `stop caveman` in a message turns the chip off and the next
  request carries no ruleset.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | row config, then `CAVEMAN_DEFAULT_MODE`, then `~/.config/caveman/config.json`, then `full` | The composition-layer level. The user's settings namespace overrides it. Must be one of the seven levels. |

The card also carries a backup-dir input for `/caveman-compress`
(`compressBackupDir`, empty = platform default).

Invalid configuration fails while the plugin loads rather than silently doing
the wrong thing.

## Skills

| Skill | Trigger | What it does |
|---|---|---|
| **caveman** | `/caveman` | Terse mode itself. `/caveman wenyan` for 文言文. Tool also takes per-call `once` (unpersisted) and `usage` (session totals). |
| **cavecrew** | delegation | Decision guide + three spawnable prompts (`cavecrew-*.md` beside the skill) for investigator/builder/reviewer via the `subagent` tool. |
| **caveman-commit** | `/caveman-commit` | Terse Conventional Commit messages. |
| **caveman-review** | `/caveman-review` | One-line, actionable review findings. |
| **caveman-compress** | `/caveman-compress <file>` | Local-rule compression (no model call), backup kept out-of-tree. |
| **caveman-explore** | delegation | Read-only repo explorer returning `path:line` citations. |
| **caveman-stats** | `/caveman-stats` | Session token usage via `caveman({usage:true})`; savings unknown without a measured comparison. |
| **caveman-help** | `/caveman-help` | One-screen reminder of every mode and command. |
| **investigate-first**, **lean-build**, **surgical-patch**, **safe-refactor**, **migration**, **verify-and-stop** | auto | Work patterns the agent picks up when a task fits. |

Upstream's `caveman-setup/-discover/-learn/-manage/-optimize/-evidence-review`
drive the caveman engine and proxy (local Go runtime / Cloud gateway) and are
**not** bundled: that runtime has no harness extension point. See Limits.

## Layout

```
src/index.ts        host plugin: section, provider, tools, commands, message watcher, settings namespace
src/modes.ts        levels, the mode filter, the injected ruleset, default resolution
src/skills.ts       skills provider over skills/<name>/SKILL.md
src/frontmatter.ts  minimal frontmatter reader (plain, `>`, `|`, quoted scalars)
src/host.ts         structural declaration of the host surface
src/compress-detect.ts / compress-validate.ts / compress-files.ts / compress-rules.ts / compress-pipeline.ts
                    local compress pipeline (ported, no model call)
lib/client.js       browser half: the settings card + the composer chip (loader factory format)
cordis.patch.yml    the Loader row to paste into the profile's live-watched patch
skills/             fourteen skills; cavecrew ships its three spawnable prompts
                    as cavecrew-*.md beside its SKILL.md
tests/              node:test unit + fake-host integration coverage
scripts/sync-upstream.mjs + sync.manifest.json
                    upstream sync tool: `npm run sync:check` diffs bundled files
                    against JuliusBrussee/caveman@main
```

`lib/client.js` is plain JavaScript on purpose. The client module system serves
a package's `exports["./client"]` artifact as a lazy-CJS factory registered on
`window.__ModuleLoader__`; an out-of-tree plugin can author that directly
instead of reproducing the repository's tsdown client preset.

Its chrome is a stylesheet, not inline style objects. The factory appends one
`<style>` tag while it materializes, which the module system claims for this
package and removes on unload. That keeps every state change (card open, pill
selected, disabled) out of React's inline-style diffing — a removed style key
is cleared with an empty string, which decomposes a shorthand set alongside it,
and that is what silently blanked a deselected pill's border upstream.

## Development

```sh
npm install         # real install (npm needed --legacy-peer-deps at build time: registry RC drift)
npm test            # node --test tests/*.test.ts (Node >= 22.6, no build step)
npm run typecheck   # tsc --noEmit
npm run sync:check  # diff bundled files against upstream main (needs network)
npm run sync        # overwrite stale verbatim files (refuses dirty tree w/o --force)
```

## Upstream sync

`sync.manifest.json` lists every file copied from
[JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman): 13
`verbatim` (byte-identical, safe to overwrite) and 4 `patched` (DSH-adapted,
never overwritten):

- `skills/caveman/SKILL.md` — one added line steering concise reasoning
  (upstream says nothing about thinking tokens);
- `skills/caveman-compress/SKILL.md` — rewired to the ported TS pipeline
  (upstream shells to `python3` + a Claude route);
- `skills/cavecrew/SKILL.md` — added how to spawn via the `subagent` tool
  (DSH has no named-agent registry);
- `skills/caveman-stats/SKILL.md` — rewired to this plugin's `usage` field
  (upstream reads Claude Code hook files).

`npm run sync:check` exits 1 listing stale files; `sync` rewrites verbatim
ones and leaves patched ones for manual re-adaptation. Both accept
`--ref <tag|sha>` to pin (default: `main`). `tests/sync.test.ts` asserts the
steady state — 13 clean, 4 patched-stale — so new upstream drift fails loudly.

## Uninstall

```sh
dsh plugin --profile web remove dsh-caveman
```

and delete the `id: caveman` row from
`~/.dsh/profiles/<profile>/cordis.patch.yml`. Saving unmounts it.

## Limits

- **Host source edits remount when `id: hmr` is enabled** with this checkout
  in `config.root`. Without that, a live patch reload re-runs `apply` from the
  ESM module already in memory.
- **A browser-half edit needs a page refresh.** The client module system serves
  `exports["./client"]` from the package, so the host half can stay up.
- **The level is process-wide.** The ruleset is a global prompt section and the
  level is one namespace value, so every agent in the process shares it.
- **Two locales.** The card and the chip ship `en` and `zh`; any other active
  locale falls back through the service's own chain.
- **External subagents are out of reach.** In-process children join the parent
  composition and inherit the ruleset, but `subagent-claude-code` and
  `subagent-codex` spawn their own CLI with its own system prompt, and no
  harness extension point wraps a spawn. So the `cavecrew-*` prompts target the
  plain in-process `subagent` tool only.
- **Usage needs the host meter.** `caveman({usage:true})` reads the
  token-meter `tokenUsage` projection; without it the field is absent and
  `/caveman-stats` says unavailable. Counts only, never savings.
- **`emit` modes**: a level change is not announced as a session event; a
  replayed session shows the ruleset each request already carried.

## Attribution and license

MIT. Skill content: © JuliusBrussee
([caveman](https://github.com/JuliusBrussee/caveman)). DSH port: see `LICENSE`.

The fourteen `skills/*/SKILL.md` files track upstream; ten are verbatim
copies, four carry small DSH adaptations (see Upstream sync). The
`cavecrew-*.md` prompts are verbatim too. The compress pipeline
(`src/compress-*.ts`) is a port, not a copy: same behavior, local rules
instead of a model call, no python3 needed.
Upstream's numbers (JetBrains: 8.5% fewer output tokens, skill only; Adobe
CAVEWOMAN: 1.4–2.4× output-side cost cut; proxy benchmark: −33.2% input
tokens) are upstream's, not this package's — this port ships the skill half
only, so only the skill-side figures apply. Verbatim files stay verbatim
rather than forked, because a fork re-diverges at every upstream sync.
