/**
 * YAML-frontmatter reader for the bundled `SKILL.md` files and the compress
 * pipeline.
 *
 * The parsing is `yaml`'s (`parse`), the same library upstream's filesystem
 * skill provider depends on, so every valid YAML frontmatter form is read the
 * same way the harness reads it: plain and quoted scalars, `>`/`|` block
 * scalars in all chomping forms, and nested maps.
 *
 * A block that is not a YAML mapping at all (a bare scalar, a sequence, an
 * empty block) yields no keys and keeps the body. A block that is malformed
 * YAML throws, and `readSkillFile` turns that into a warning and a skipped
 * skill: one broken file must not cost the catalog its other skills.
 *
 * @module dsh-caveman/frontmatter
 */

import { parse } from 'yaml'

/** Parsed frontmatter plus the markdown body that follows it. */
export interface Frontmatter {
  /** The verbatim frontmatter block including both delimiters, or `''` when absent. */
  readonly raw: string
  /** Frontmatter keys and their YAML values (`string`, `boolean`, map, list, …). */
  readonly data: Readonly<Record<string, unknown>>
  /** Everything after the closing delimiter, or the whole source when absent. */
  readonly body: string
}

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Parse leading YAML frontmatter from a markdown document.
 * @param source - full file contents.
 * @returns the verbatim block, the parsed keys, and the remaining body.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^\uFEFF/, '')
  const match = FRONTMATTER_BLOCK.exec(text)
  if (match === null) return { raw: '', data: {}, body: text }

  const raw = match[0]
  // The body keeps its own bytes apart from line terminators, which are
  // normalized the way the previous line-split reader normalized them.
  const body = text.slice(raw.length).replace(/\r\n/g, '\n')
  const parsed: unknown = parse(match[1] ?? '')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { raw, data: {}, body }
  }

  return { raw, data: parsed as Record<string, unknown>, body }
}
