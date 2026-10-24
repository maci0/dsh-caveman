---
name: caveman-help
description: >
  Quick-reference card for caveman modes, skills and commands.
  Trigger: /caveman-help or "caveman help".
---

# Caveman Help

Display this reference card when invoked. One-shot — do NOT change mode or persist anything. Output in caveman style.

## Modes

| Mode | Trigger | What change |
|------|---------|-------------|
| **Lite** | `/caveman lite` | Drop filler. Keep sentence structure. |
| **Full** | `/caveman` | Drop articles, filler, pleasantries, hedging. Fragments OK. Default. |
| **Ultra** | `/caveman ultra` | Extreme compression. Bare fragments. Tables over prose. |
| **Wenyan-Lite** | `/caveman wenyan-lite` | Classical Chinese style, light compression. |
| **Wenyan-Full** | `/caveman wenyan` | Full 文言文. Maximum classical terseness. |
| **Wenyan-Ultra** | `/caveman wenyan-ultra` | Extreme. Ancient scholar on a budget. |
| **Off** | `/caveman off` | No injection. Normal behavior. |

Mode stick until changed or session end.

## Skills

| Skill | Trigger | What it do |
|-------|---------|-----------|
| **caveman-commit** | `/caveman-commit` | Terse commit messages. Conventional Commits. ≤50 char subject. |
| **caveman-review** | `/caveman-review` | One-line PR comments: `L42: bug: user null. Add guard.` |
| **caveman-compress** | `/caveman-compress <file>` | Compress .md files with local rules. Backup kept out-of-tree. |
| **caveman-stats** | `/caveman-stats` | Session token usage. Counts only, never savings. |
| **caveman-help** | `/caveman-help` | This card. |

Model tool also takes per-call `once` (unpersisted style) and `usage: true` (session totals).

## Deactivate

Say "stop caveman" or "normal mode". Resume anytime with `/caveman`.

## Language

Reply in the user's dominant language, whatever the example text or multilingual context elsewhere says. A wenyan level does not switch language: its Register line keeps the register classical Chinese inside Chinese, and a user writing another language gets that level's terseness only. Technical terms, code, commands, commit types, and exact error strings stay verbatim.

## Configure Default Mode

Default mode = `full`. Change it (lowest priority last):

**Profile row** (highest priority): `defaultMode` in `cordis.patch.yml`.

**Environment variable**:
```bash
export CAVEMAN_DEFAULT_MODE=ultra
```

**Config file** (`~/.config/caveman/config.json`):
```json
{ "defaultMode": "lite" }
```

Set `"off"` to disable auto-activation on session start. User can still activate manually with `/caveman`.

Resolution: profile row > env var > config file > `full`.

## More

Full docs: https://github.com/JuliusBrussee/caveman
