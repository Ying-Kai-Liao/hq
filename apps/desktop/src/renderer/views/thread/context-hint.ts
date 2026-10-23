/** "context 42%" under a bot's last reply once the host says the session is filling up. Nothing when absent or not a number. */
export function contextLabel(contextPercent: unknown): string | null {
  return typeof contextPercent === 'number' && Number.isFinite(contextPercent) ? `context ${Math.round(contextPercent)}%` : null
}
