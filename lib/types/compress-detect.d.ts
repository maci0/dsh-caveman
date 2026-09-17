/**
 * Detect whether a file is natural language (compressible) or code/config.
 *
 * TypeScript port of `skills/caveman-compress/scripts/detect.py` (MIT,
 * © JuliusBrussee). The Python original is dropped: the ported pipeline runs
 * in-process with no `python3` requirement.
 *
 * @module dsh-caveman/compress-detect
 */
/** File classification. */
export type FileType = 'natural_language' | 'code' | 'config' | 'unknown';
/**
 * Classify a file as natural language, code, config, or unknown.
 * @param basename - file basename (extension rules key off this).
 * @param readText - reads the file when content sniffing is needed; throw to signal unreadable.
 * @returns the classification.
 */
export declare function detectFileType(basename: string, readText?: () => string): FileType;
