const DAY = 86_400_000

/** A Crew row's time: the clock today, "Yesterday", the weekday this week, else the date. */
export function rowTime(at: number, now = Date.now()): string {
  if (!at) return ''
  const start = new Date(now).setHours(0, 0, 0, 0)
  if (at >= start) return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (at >= start - DAY) return 'Yesterday'
  if (at >= start - 6 * DAY) return new Date(at).toLocaleDateString([], { weekday: 'long' })
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
