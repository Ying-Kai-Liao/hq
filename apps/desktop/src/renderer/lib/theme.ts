import { useSyncExternalStore } from 'react'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

const subscribe = (query: MediaQueryList) => (cb: () => void) => {
  query.addEventListener('change', cb)
  return () => query.removeEventListener('change', cb)
}

export function useDark() {
  return useSyncExternalStore(subscribe(darkQuery), () => darkQuery.matches)
}

export function useReduceMotion() {
  return useSyncExternalStore(subscribe(motionQuery), () => motionQuery.matches)
}

export const isDark = () => darkQuery.matches
export const reduceMotion = () => motionQuery.matches

/** Palette values for drawing code (canvas) that can't read CSS variables. */
export const palette = (dark: boolean) => ({
  text: dark ? [242, 242, 242] : [20, 20, 20],
  secondary: dark ? '#9a9a9a' : '#6b6b6b',
  background: dark ? '#0a0a0a' : '#ffffff',
})

export interface Swatch {
  id: string
  label: string
  hex: string
}

export const AVATAR_COLORS: Swatch[] = [
  { id: 'black', label: 'Black', hex: '#2B2B2B' },
  { id: 'brown', label: 'Brown', hex: '#936439' },
  { id: 'red', label: 'Red', hex: '#FF263C' },
  { id: 'orange', label: 'Orange', hex: '#FF6700' },
  { id: 'yellow', label: 'Yellow', hex: '#FF9800' },
  { id: 'green', label: 'Green', hex: '#00C972' },
  { id: 'cyan', label: 'Cyan', hex: '#00BCA6' },
  { id: 'blue', label: 'Blue', hex: '#1084FE' },
  { id: 'violet', label: 'Violet', hex: '#9159FE' },
  { id: 'magenta', label: 'Magenta', hex: '#FF309B' },
  { id: 'gray', label: 'Gray', hex: '#777777' },
]

export const AVATAR_SHAPES = ['blob', 'pebble', 'squircle', 'tablet', 'wedge', 'hex', 'cloud', 'teardrop']

export function avatarColor(id: string) {
  return (AVATAR_COLORS.find((c) => c.id === id) ?? AVATAR_COLORS[7]!).hex
}

/** `#RRGGBB` → `rgba(r, g, b, a)`. */
export function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
