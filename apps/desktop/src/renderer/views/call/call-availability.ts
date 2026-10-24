import type { BotStore } from '../../store/bot-store'
import { callBlock } from './call-block'
import { onDeviceAvailable, onDeviceUnavailableReason, VoiceSettings } from './voice'

/**
 * Why a call can't start from here, for the call buttons' tooltips; null when it can. Only what is
 * known up front: a cloud voice's missing key or a voice still downloading show on the call screen.
 */
export function callBlockedReason(store: BotStore): string | null {
  return callBlock({
    offline: store.isOffline,
    mismatch: !!store.mismatch,
    voiceReady: onDeviceAvailable() || !!VoiceSettings.provider(),
    unavailableReason: onDeviceUnavailableReason,
  })
}
