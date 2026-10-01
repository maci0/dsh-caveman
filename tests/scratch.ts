/**
 * Temp-file root for the suite: the repo's gitignored `.scratch/`, never the
 * system temp dir. Tests `mkdtemp` inside it and remove what they create.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of `<repo>/.scratch`, created on import. */
export const scratchDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.scratch')
mkdirSync(scratchDir, { recursive: true })
