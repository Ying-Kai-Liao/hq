import type { BotStatus } from './models'

// The notch island: a black shape at the top of the screen (in the notch on a MacBook) that
// shows working bots and takes approvals. The chat window owns the stores and sends an
// `IslandSummary`; the island window only draws it (main/island.ts, views/island/).

/** One bot as the island shows it (`ref` = computerId/botId). */
export interface IslandBot {
  ref: string
  name: string
  shape: string
  color: string
  /** A `BotStatus`, or a newer one this app doesn't know. */
  status: BotStatus | string
  /** What it's doing, that it needs you, or its last message. */
  detail: string
}

export interface IslandOption {
  id: string
  label: string
  allow: boolean
}

/** A pending approval card: the conversation holding it and the bot asking. */
export interface IslandPermission {
  ref: string
  entryId: string
  bot: Pick<IslandBot, 'name' | 'shape' | 'color'>
  headline: string
  title: string
  options: IslandOption[]
  /** The option on its way to the host. */
  answering: string | null
}

export interface IslandSummary {
  bots: IslandBot[]
  permissions: IslandPermission[]
}

/** The display the island sits on: the notch's size in points, or null at a plain top edge. */
export interface IslandScreen {
  notch: { width: number; height: number } | null
}

/** The island's shape in its window, in points: the part that takes the mouse. */
export interface IslandRect {
  x: number
  y: number
  width: number
  height: number
}

/** One `NSScreen`: its frame's x and width, the safe area's top inset and the menu bar on each side of the notch. */
export interface NotchScreen {
  x: number
  width: number
  top: number
  left: number
  right: number
}

export type IslandMode = 'hidden' | 'compact' | 'bots' | 'approval' | 'finished'

/** How long a bot that just finished stays in the island. */
export const FINISHED_MS = 4000
/** Extra room around the shape that still counts as on it, so a click at its edge is never lost. */
export const HIT_MARGIN = 8
/** The window holding the island: the largest shape fits, the rest is transparent and lets clicks through. */
export const PANEL = { width: 720, height: 360 }

const WING = 36
const BAR = 28

export const isActive = (b: Pick<IslandBot, 'status'>) => b.status === 'working' || b.status === 'needsInput'

export function islandMode(
  summary: IslandSummary,
  { open, deferred, finished }: { open: boolean; deferred: ReadonlySet<string>; finished: boolean },
): IslandMode {
  if (summary.permissions.some((p) => open || !deferred.has(p.entryId))) return 'approval'
  if (open) return 'bots'
  if (finished) return 'finished'
  return summary.bots.some(isActive) ? 'compact' : 'hidden'
}

/** Bots that stopped working since `before` (their last statuses by ref). */
export function justFinished(before: ReadonlyMap<string, string>, bots: IslandBot[]): IslandBot[] {
  return bots.filter((b) => {
    const was = before.get(b.ref)
    return (was === 'working' || was === 'needsInput') && (b.status === 'idle' || b.status === 'error')
  })
}

/** Where content starts below the top edge: under the notch, never behind the camera. */
export const contentTop = (screen: IslandScreen) => screen.notch?.height ?? 10

/** The shape's size for `mode`; `content` is the measured height of an open view's content. */
export function islandFrame(mode: IslandMode, screen: IslandScreen, content: number) {
  const notch = screen.notch
  const gap = notch?.width ?? 0
  const bar = notch?.height ?? BAR
  const open = (min: number) => ({ width: Math.max(gap + 2 * WING, min), height: contentTop(screen) + content + 14, radius: 24 })
  switch (mode) {
    case 'hidden':
      // At a plain top edge only a thin strip under the edge wakes it.
      return notch ? { width: notch.width, height: notch.height, radius: 10 } : { width: 160, height: 0, radius: 0 }
    case 'compact':
      return { width: gap + 2 * WING, height: bar, radius: notch ? 10 : bar / 2 }
    case 'finished':
      return open(340)
    case 'bots':
      return open(380)
    case 'approval':
      return open(440)
  }
}

/** The shape centered at the top of a `windowWidth`-wide window. */
export function islandRect(frame: { width: number; height: number }, windowWidth: number): IslandRect {
  return { x: (windowWidth - frame.width) / 2, y: 0, width: frame.width, height: frame.height }
}

/** The part of the window that takes the mouse: the shape with `HIT_MARGIN` around it, inside the window. */
export function hitRect(rect: IslandRect): IslandRect {
  if (rect.width <= 0) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.max(0, Math.floor(rect.x - HIT_MARGIN))
  const y = Math.max(0, Math.floor(rect.y - HIT_MARGIN))
  return { x, y, width: Math.ceil(rect.x + rect.width + HIT_MARGIN) - x, height: Math.ceil(rect.y + rect.height + HIT_MARGIN) - y }
}

/** Whether a point in window coordinates is on the island. The window's top edge is the screen's, so above it counts too. */
export function hits(rect: IslandRect, x: number, y: number) {
  const r = hitRect(rect)
  return r.width > 0 && x >= r.x && x <= r.x + r.width && y <= r.y + r.height && (r.y === 0 || y >= r.y)
}

/** The notch of the display at `bounds`, from the screens `NSScreen` reports (same points and x axis). */
export function notchOf(screens: NotchScreen[], bounds: { x: number; width: number }) {
  const s = screens.find((s) => s.x === bounds.x && s.width === bounds.width && s.top > 0)
  const width = s ? s.width - s.left - s.right : 0
  return s && width > 0 ? { width, height: s.top } : null
}

/** The setting's name: a notch on the Mac, the top edge elsewhere. */
export const islandLabel = (platform: string) => (platform === 'darwin' ? 'Show in notch' : 'Show at top of screen')
