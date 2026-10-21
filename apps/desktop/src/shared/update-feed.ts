/**
 * Where the app finds its own releases. Null until Kith publishes some: Kith began as a fork of
 * Codync, and its builds must never look at (or install from) Codync's feed. Set this and a
 * `publish:` block in electron-builder.yml together.
 */
export const UPDATE_FEED: string | null = null
