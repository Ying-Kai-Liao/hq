/**
 * Where the app finds its own releases. Null until Kith publishes some: Kith's builds must never look at (or install from) another project's feed. Set this and a
 * `publish:` block in electron-builder.yml together.
 */
export const UPDATE_FEED: string | null = null
