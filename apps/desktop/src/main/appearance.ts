import { nativeTheme } from 'electron'
import { parseAppearance } from '../shared/appearance'
import { prefs } from './host-controller'

/** Settings > Display > Appearance. nativeTheme.themeSource also drives prefers-color-scheme in every window, so the CSS follows. */
export function applyAppearance() {
  nativeTheme.themeSource = parseAppearance(prefs.get('appearance'))
}

export function setAppearance(raw: unknown) {
  const next = parseAppearance(raw)
  if (prefs.get('appearance') !== next) prefs.set('appearance', next)
  nativeTheme.themeSource = next
}
