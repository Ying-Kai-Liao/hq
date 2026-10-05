import type { CSSProperties } from 'react'

// macOS text styles in points (NSFont.preferredFont), scaled by the app's text size preference
// like kit's `AppFont`.
export const TextStyle = {
  largeTitle: 26,
  title: 22,
  title2: 17,
  title3: 15,
  headline: 13,
  body: 13,
  callout: 12,
  subheadline: 11,
  footnote: 10,
  caption: 10,
  caption2: 10,
  /** Codync's compact desktop body (12) and secondary (11). */
  compactBody: 12,
  compactSecondary: 11,
} as const

export type TextStyleName = keyof typeof TextStyle

/** `calc(<pt>px * var(--scale))` */
export const px = (size: number) => `calc(${size}px * var(--scale))`

type Weight = 'regular' | 'medium' | 'semibold' | 'bold' | 'black' | 'light'
const weights: Record<Weight, number> = { light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, black: 900 }

/** `.appFont(...)`: a text style name or a point size, with weight and design. */
export function font(style: TextStyleName | number, weight?: Weight, design?: 'monospaced' | 'rounded'): CSSProperties {
  const size = typeof style === 'number' ? style : TextStyle[style]
  const w = weight ?? (style === 'headline' ? 'bold' : 'regular')
  return {
    fontSize: px(size),
    fontWeight: weights[w],
    ...(design === 'monospaced' ? { fontFamily: 'var(--mono)' } : design === 'rounded' ? { fontFamily: 'ui-rounded, var(--font)' } : {}),
  }
}
