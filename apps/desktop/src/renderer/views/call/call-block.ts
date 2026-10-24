/** Why a call can't start, from what is known up front; null when it can. Pure, so it is tested without the voice engines. */
export function callBlock(s: { offline: boolean; mismatch: boolean; voiceReady: boolean; unavailableReason: () => string }): string | null {
  if (s.offline) return "Can't call while the computer is offline."
  if (s.mismatch) return 'Update Kith on the computer to call.'
  if (!s.voiceReady) return `${s.unavailableReason()} Pick a cloud voice in call settings.`
  return null
}
