/**
 * Frontmatter reader for the bundled `SKILL.md` files and the compress
 * pipeline.
 *
 * The fast path is a local reader for the flat subset those files use:
 * `key: value` with a plain, single-quoted, or double-quoted scalar, and `>`/`|`
 * block scalars in all three chomping forms. It claims only forms it can prove
 * — a nested map, a list, a flow collection, a key form it does not recognise,
 * or any other shape it is not sure about falls through to `yaml`.
 *
 * "Prove" is the whole contract, so the claimed subset is deliberately narrow:
 * every line of the block must be a blank line, a column-0 comment, or
 * `SIMPLE_KEY: value` with a key the YAML core schema leaves a string and no
 * repeated key; a block that is anything else (a bare scalar, a sequence, an
 * explicit `?` key, an indented continuation) is refused rather than guessed.
 * {@link NON_STRING} is the YAML core schema's own resolution set copied out of
 * `yaml/dist/schema/core`, so a value it does not match is provably a string,
 * and a value it does match falls back instead of being read as one.
 *
 * The fallback is the contract, not an afterthought: `yaml` is never imported
 * at module scope, so a catalog of flat files (every bundled skill) never pays
 * the library's module-load cost. {@link parseFrontmatterAsync} loads it with a
 * dynamic `import('yaml')`; the synchronous {@link parseFrontmatter} loads it
 * with a lazy `createRequire` for the callers that cannot await.
 *
 * Behaviour matches the previous `yaml`-only reader: a block that is not a YAML
 * mapping at all (a bare scalar, a sequence, an empty block) yields no keys and
 * keeps the body, and a block that is malformed YAML throws, which
 * `readSkillFile` turns into a warning and a skipped skill.
 *
 * @module dsh-caveman/frontmatter
 */
/** Parsed frontmatter plus the markdown body that follows it. */
export interface Frontmatter {
    /** The verbatim frontmatter block including both delimiters, or `''` when absent. */
    readonly raw: string;
    readonly data: Readonly<Record<string, unknown>>;
    /** Everything after the closing delimiter, or the whole source when absent. */
    readonly body: string;
}
/**
 * Parse leading YAML frontmatter from a markdown document.
 *
 * For callers that cannot await. A block the fast path refuses loads `yaml`
 * synchronously; use {@link parseFrontmatterAsync} on paths where deferring the
 * library to a dynamic import matters.
 * @param source - full file contents.
 * @returns the verbatim block, the parsed keys, and the remaining body.
 */
export declare function parseFrontmatter(source: string): Frontmatter;
/**
 * Parse leading YAML frontmatter, loading `yaml` with a dynamic import only
 * when the fast path refuses the block.
 * @param source - full file contents.
 * @returns the verbatim block, the parsed keys, and the remaining body.
 */
export declare function parseFrontmatterAsync(source: string): Promise<Frontmatter>;
