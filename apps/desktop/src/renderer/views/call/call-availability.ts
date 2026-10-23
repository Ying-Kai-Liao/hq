import type { BotStore } from '../../store/bot-store'
import { onDeviceAvailable, onDeviceUnavailableReason, VoiceSettings } from './voice'

/**
 * Why a call can't start from here, for the call buttons' tooltips; null when it can. Only what is
 * known up front: a cloud voice's missing key or a voice still downloading show on the call screen.
 */
export function callBlockedReason(store: BotStore): string | null {
  if (store.isOffline) return "Can't call while the computer is offline."
  if (store.mismatch) return 'Update Kith on the computer to call.'
  if (!onDeviceAvailable() && !VoiceSettings.provider()) return `${onDeviceUnavailableReason()} Pick a cloud voice in call settings.`
  return null
}
