export type Appearance = 'system' | 'light' | 'dark'

export const APPEARANCES: Appearance[] = ['system', 'light', 'dark']

/** A stored value the app doesn't know (a newer version's, or damage) means System. */
export function parseAppearance(raw: unknown): Appearance {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}
