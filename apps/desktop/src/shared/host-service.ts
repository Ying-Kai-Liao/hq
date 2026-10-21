import { join } from 'node:path'

/**
 * Whether an installed service belongs to `kith serve` rather than this app: its definition sets
 * HQ_BIN, or it runs the binary `kith serve start` installs in the data folder. The app never
 * reinstalls such a service (that would drop HQ_BIN), even when its own binary resolves to the
 * same file in an unpackaged run.
 */
export function isKithServeService(definition: string, program: string | null, home: string, dataFolder: string): boolean {
  if (/\bHQ_BIN\b/.test(definition)) return true
  return program !== null && program.startsWith(join(home, dataFolder, 'bin') + '/')
}
