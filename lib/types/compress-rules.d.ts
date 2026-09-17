/**
 * Deterministic local compression rules: the caveman style without a model.
 *
 * This replaces the `callClaude` half of
 * `skills/caveman-compress/scripts/compress.py` (MIT, © JuliusBrussee),
 * which this plugin deliberately does not port — shipping file bytes to a
 * third-party model for a local rewrite is the "dumb feature" this port
 * leaves out. Everything else (detect, validate, file handling) is ported
 * faithfully; only the rewrite step is local and rule-based.
 *
 * Rules mirror the skill's Compression Rules section: drop articles, filler,
 * pleasantries, hedging, and connective fluff; shorten redundant phrasing;
 * keep code/URLs/paths/commands/technical terms/numbers byte-identical;
 * never touch headings. Code spans (fenced, indented, inline) are masked
 * before rewriting and restored after, so prose rules cannot reach them.
 *
 * @module dsh-caveman/compress-rules
 */
/**
 * Mask fenced and indented code blocks with opaque markers.
 * @param text - markdown body.
 * @returns masked text plus the blocks for restoration.
 */
export declare function maskCodeBlocks(text: string): {
    masked: string;
    blocks: string[];
};
/**
 * Restore masked code blocks exactly; fail closed on tampering.
 * @param text - rewritten text with markers.
 * @param blocks - blocks from {@link maskCodeBlocks}.
 * @returns text with code restored.
 */
export declare function restoreCodeBlocks(text: string, blocks: string[]): string;
/**
 * Compress one prose line: drop fluff, tighten phrasing, collapse space.
 * Inline code spans (`` `...` ``) are masked first so rules skip them.
 * @param line - a single non-heading, non-code line.
 * @returns the compressed line.
 */
export declare function compressLine(line: string): string;
/**
 * Compress a markdown body with local rules. Headings pass through
 * byte-identical; list markers and table pipes are preserved; everything
 * else goes through {@link compressLine}. Empty results fall back to the
 * original line so structure never collapses.
 * @param body - markdown body (frontmatter already removed).
 * @returns the compressed body.
 */
export declare function compressBody(body: string): string;
/**
 * Whether the candidate actually compresses the body (strictly smaller).
 * Guard against a rewrite that validates structurally but saves nothing.
 * @param candidate - compressed body.
 * @param body - original body.
 * @returns true when strictly smaller.
 */
export declare function isSmaller(candidate: string, body: string): boolean;
