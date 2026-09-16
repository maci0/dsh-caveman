---
name: caveman-stats
description: >
  Show this session's provider-reported token usage (input, output, cache
  read/write) via the caveman tool, or locate the host's native usage report.
  Trigger: /caveman-stats.
---

Call the `caveman` tool with `{ "usage": true }`. It reads the host's
`tokenUsage` session projection — cumulative provider-reported totals for this
session — and renders one line:

> Session usage so far — input N, output N, cache read N, cache write N.
> Savings unknown without a measured comparison.

Print that line verbatim inside a fenced code block. Do not calculate,
recompute, or re-round the numbers yourself.

When the tool returns no `usage` field, the host mounts no usage projection:
say current session usage is unavailable rather than inventing a number. In
other hosts, use a native usage report if one is available.

Savings are unknown in every host without a measured comparison: the log has
no unbuilt baseline to subtract. Do not infer saved tokens, percentages,
dollars, rule overhead, or a net result from output counts or the current
mode.

Original/current memory-file pairs are reported by their measured byte sizes.
Those file-size differences do not establish provider token or billing
savings.
