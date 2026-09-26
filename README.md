# dsh-caveman

Your agent writes three paragraphs where one line would do. This plugin makes it
talk like a caveman: same meaning, fewer tokens. Code, commands, file paths, and
exact error strings are never compressed — only the prose around them.

Adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT).
"why use many token when few do trick"

## What you get

- **A talking style on every request.** While any level except `off` is active,
  the mode-filtered ruleset joins the system prompt.
- **Fourteen skills** the `skill` tool can load, so they also appear as
  `/caveman-review`, `/caveman-commit`, … in the composer: `caveman`, `cavecrew`,
  `caveman-commit`, `caveman-review`, `caveman-compress`, `caveman-explore`,
  `caveman-stats`, `caveman-help`, plus six work patterns (`investigate-first`,
  `lean-build`, `surgical-patch`, `safe-refactor`, `migration`, `verify-and-stop`).
- **Two ways to switch level.** The model calls the `caveman` tool; you type
  `/caveman <level>` or just say **stop caveman**.
- **A settings card and a composer chip**, so the active level is visible without
  opening Settings.
- **`/caveman-compress <file>`** shrinks a memory file or todo list with local
  rules. No model call, original backed up out of tree.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start, and
> the Plugins card cannot save into it — the editor refuses a write an overlay
> would win.

```sh
dsh plugin --profile web add github:maci0/dsh-caveman   # untagged spec tracks main
```

The package declares `dsh.bundle`, so `dsh plugin add` appends it to
`dsh.profile.bundles` and the row in its own `cordis.patch.yml` applies as a
layer. Bundle layers compose at boot, so **restart `dsh web`**. To pick up a newer
commit later, run `dsh plugin --profile web update dsh-caveman` and restart again.

Do **not** also paste that `id: caveman` row into your profile's own
`cordis.patch.yml`: `insert` does not dedupe ids, and a second row mounts the
plugin twice.

## Try it

```
/caveman ultra     -> Caveman level: ultra (was full).
/caveman wenyan    -> Caveman level: wenyan-full (was ultra).
/caveman           -> Caveman level: wenyan-full.
/caveman off       -> Caveman off (was wenyan-full). Normal behavior.
```

Typing **stop caveman** or **normal mode** as an ordinary message has the same
effect as `/caveman off`, and it lands on the turn that carried it. Only the
human's own words count — injected context riding the same event stream cannot
toggle the level, and the message must *be* the command: "add a normal mode
toggle" is left alone.

Model side, the tool takes `mode` (persist a level), `once` (this call only, not
persisted), and `usage` (session token totals). `{"usage": true}` appends input,
output, cache read, and cache write totals from the harness's `tokenUsage`
projection — counts only, never a saving.

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

Every level persists, so the card, the chip, the tool, and `/caveman` always agree
and the choice survives a restart. Security warnings, irreversible-action
confirmations, and anything where compression would change the meaning drop back
to full sentences.

## Configure

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | unset | Startup level. Absent means "ask the chain below". One of the seven levels when set. |
| `maxFileSize` | `500000` | Size cap in bytes for `/caveman-compress`. Positive number. |

The row schema declares no default for `defaultMode`, so an absent field stays
absent and `apply` resolves the startup level in this order: the row's
`defaultMode`, then `CAVEMAN_DEFAULT_MODE`, then
`~/.config/caveman/config.json`'s `defaultMode`, then `full`. An invalid value
fails while the plugin loads rather than silently doing the wrong thing.

## How it works

The host half mounts through public Cordis extension points — `systemPrompt.section`,
`skills.registerProvider`, `tools.register`, `commands.register`,
`loader/volatile-update` (the settings document writes the row's volatile
`defaultMode`), and `session/event` for the message switch. The browser half draws
its card into the public `plugins.row.config` slot from `configForms`, registers its
copy through `locale.register`, and draws its chip into `conversation.input.left`, so
this plugin needs no client change of its own.

The entry point is the built `lib/index.js` (declarations in `lib/types/`); `npm run
build` regenerates it from `src/`. `lib/client.js` is hand-authored plain JavaScript —
the client module system serves it as a lazy-CJS factory on `window.__ModuleLoader__`
because the package exports `./client`, and it is not built. Skills come from
`skills/<name>/SKILL.md` with frontmatter parsed by `yaml`; the provider takes its rank
and name grammar from `@deepseek-ai/dsh-skill`, projects `disable-model-invocation`,
`user-invocable`, and `whenToUse`, and settles on the lookup's abort signal. Tools use
`defineTool` from `@deepseek-ai/dsh-tools` and forward `exec.signal`. Only
`skills/caveman/SKILL.md` is the source of truth for the ruleset; this README keeps no
second copy.

## What it does not do

- **No proxy, no CLI verbs, no Cloud engine.** Upstream's
  `caveman-setup/-discover/-learn/-manage/-optimize/-evidence-review` need an
  external runtime the harness has no extension point for, so they are not bundled.
- **Savings are not measured.** `/caveman-stats` reports what the provider reported this
  session, never a percentage, and it says unavailable when the host mounts no token meter.
- **The level is process-wide.** One prompt section, one namespace value: every
  agent in the process shares it.
- **External subagents ignore it.** In-process children inherit the ruleset, but
  `subagent-claude-code`/`subagent-codex` spawn their own CLI with its own prompt.
- **Two locales.** The card and the chip ship `en` and `zh`; any other locale
  falls back through the service's own chain.
- **Host source edits need `npm run build` and a restart**; browser-half edits need a page refresh.

## Development

```sh
npm install --legacy-peer-deps   # the harness packages are optional peers
npm run build       # tsc -p tsconfig.build.json -> lib/index.js + lib/types/
npm test            # node --test tests/*.test.ts (Node ^22.19 || >=24, no build step)
npm run typecheck   # tsc -p tsconfig.json
npm run sync:check  # diff bundled files against upstream main (needs network)
npm run sync        # overwrite stale verbatim files (refuses dirty tree w/o --force)
```

The harness packages this plugin imports at runtime — `@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-skill`, `@deepseek-ai/schemastery` — are **optional peer
dependencies**, not installed ones; `yaml` is the only real dependency. That
shape is deliberate. `@deepseek-ai/dsh-tools` keys its runtime scheduler on a
module-level `Symbol`, so a second physical copy in the profile hands the tool
layer a different symbol than the host's and every tool call dies with
`Cannot read properties of undefined (reading 'prepare')`. Peers leave
resolution to the installation, where exactly one copy exists; a standalone
clone gets them from `devDependencies`, which is why the local install needs
`--legacy-peer-deps`.

The suite covers level normalization and filtering, the fake-host surface, the skills
provider, the compress pipeline, and a real Cordis composition mount next to the real
skill registry. `sync:check` exits 1 and lists stale files; `sync` rewrites verbatim
copies and leaves adapted ones for manual re-adaptation. Both accept `--ref <tag|sha>`
(default `main`). The network assertion runs only with `DSH_SYNC_CHECK=1`; plain
`npm test` stays offline. To uninstall, run `dsh plugin --profile web remove dsh-caveman`
and drop any `id: caveman` override from `~/.dsh/profiles/<profile>/cordis.patch.yml`.

## Attribution and license

MIT. Skill content: © JuliusBrussee
([caveman](https://github.com/JuliusBrussee/caveman)). DSH port: see `LICENSE`.

The fourteen `skills/*/SKILL.md` files track upstream; nine are verbatim copies
and five carry small DSH adaptations (`caveman`, `caveman-compress`, `cavecrew`,
`caveman-stats`, `caveman-help`). The `cavecrew-*.md` prompts are verbatim too.
The compress pipeline (`src/compress-*.ts`) is a port, not a copy: same behavior,
local rules instead of a model call, no `python3` needed.

Upstream's numbers (JetBrains: 8.5% fewer output tokens, skill only; Adobe CAVEWOMAN:
1.4–2.4× output-side cost cut; proxy: −33.2% input tokens) are upstream's, not this
package's — this port ships the skill half only, so only the skill-side figures apply.
