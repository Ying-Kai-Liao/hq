/** Schemes a link may hand to the operating system. Everything else is dropped. */
const EXTERNAL = /^(https?|mailto):/i

export function isSafeExternalURL(url: string): boolean {
  return EXTERNAL.test(url.trim())
}

/**
 * Whether `url` is a page of the app's own renderer: the dev server's origin in development,
 * the bundled index.html in a packaged build. `base` is any URL of the renderer.
 */
export function isRendererURL(url: string | undefined | null, base: string): boolean {
  if (!url) return false
  try {
    const a = new URL(url)
    const b = new URL(base)
    if (a.protocol !== b.protocol) return false
    if (b.protocol === 'file:') return a.pathname === b.pathname
    return a.origin === b.origin
  } catch {
    return false
  }
}
