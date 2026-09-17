/**
 * Structural validation of a compressed file against its original.
 *
 * TypeScript port of `skills/caveman-compress/scripts/validate.py` (MIT,
 * © JuliusBrussee). Same extractors, same six validators, same fail-closed
 * posture: headings/code/URLs/paths/inline-code must survive byte-identical,
 * bullets only warn on drift. The Python original is dropped.
 *
 * @module dsh-caveman/compress-validate
 */
/** Outcome of validating one original/compressed pair. */
export interface ValidationResult {
    readonly isValid: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}
export declare function extractHeadings(text: string): [string, string][];
/**
 * Every fenced and indented code block, in document order.
 *
 * The masker already owns the definition of "code block" for the rewriter; the
 * validator reuses it so both agree on what must survive byte-identical.
 * @param text - markdown body.
 * @returns the block texts.
 */
export declare function extractCodeBlocks(text: string): string[];
export declare function extractUrls(text: string): Set<string>;
export declare function extractPaths(text: string): Set<string>;
export declare function extractInlineCodes(text: string): string[];
/**
 * Validate a compressed candidate against its original.
 * @param original - original file text.
 * @param compressed - compressed candidate text.
 * @returns errors (fail-closed) and warnings (drift notes).
 */
export declare function validate(original: string, compressed: string): ValidationResult;
