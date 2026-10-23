/** The Settings window's pages, in the sidebar's order (the same list as the iPhone's, then the Mac-only pages). */
export const SETTINGS_PAGES = ['account', 'crew', 'computers', 'people', 'voice', 'usage', 'notifications', 'privacy', 'updates', 'about'] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]

export const isSettingsPage = (v: unknown): v is SettingsPage => typeof v === 'string' && (SETTINGS_PAGES as readonly string[]).includes(v)
