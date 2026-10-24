# Changelog

## 0.18.1

- **Fix: host packages are peer dependencies, not dependencies.**
  `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill` and
  `@deepseek-ai/schemastery` moved from `dependencies` to
  `peerDependencies` (they stay in `devDependencies` for build and
  typecheck). The previous pin made the DSH profile hoist a second,
  version-locked copy of `dsh-tools`; the plugin resolved that copy while the
  host kept its own, so the tool layer's module-level `Symbol` no longer
  matched. After a Harness upgrade the stale copy also made the host abort at
  startup with `startup failed: 1 required plugin did not activate`, listing
  every plugin that needs `tools` as waiting. Peers let the running
  installation provide the only copy, so a Harness upgrade no longer requires
  a matching plugin release.
- Peer shape aligned with the recommendation in
  [issue #6](https://github.com/maci0/dsh-caveman/issues/6):
  `peerDependencies: "*"` plus `peerDependenciesMeta.optional` for the three
  harness packages, matching the `v0.6.1` fix for the same regression.
- **Fix: `/caveman <level>` tolerates invisible and alternative spellings.**
  A zero-width character, a non-breaking space, or a space/underscore instead
  of the hyphen no longer produces `Unknown caveman level`; the rejection now
  prints the escaped input so a hidden character is visible.
- **Fix: text typed after the level no longer fails the command.**
  The command box sends everything after `/caveman` as one argument, so
  `/caveman wenyan-ultra explain this` used to report
  `Unknown caveman level "wenyan-ultra explain this"` and change nothing. The
  leading level is now matched as the longest recognized prefix (multi-word
  spellings like `wenyan full` and the phrases `normal mode` / `stop caveman`
  included), and the remaining text is reported back to send as its own
  message.

Earlier releases are documented by the git history.
