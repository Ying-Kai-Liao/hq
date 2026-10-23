// Names from before the rename that an existing install may still hold. Read once, then gone.

const MOVED_PREFIXES: [from: string, to: string][] = [
  ['codync-drafts-v1-', 'kith-drafts-v1-'],
  ['codync-mirror-', 'kith-mirror-'],
]

/** Moves the renderer's cached drafts and mirrors from their old localStorage keys to the new ones. */
export function migrateLegacyStorage(storage: Storage) {
  try {
    for (const key of Object.keys(storage)) {
      const moved = MOVED_PREFIXES.find(([from]) => key.startsWith(from))
      if (!moved) continue
      const value = storage.getItem(key)
      const target = moved[1] + key.slice(moved[0].length)
      if (value !== null && storage.getItem(target) === null) storage.setItem(target, value)
      storage.removeItem(key)
    }
  } catch {
    // A full or blocked store only loses the cache.
  }
}
