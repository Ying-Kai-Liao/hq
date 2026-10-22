import { useEffect, useMemo } from 'react'
import { useModel } from '../../../lib/observable'
import { useStore, useStoreRef } from '../../../store/context'
import { KithInfoStore } from '../../../store/kith-info-store'

/**
 * A Kith bot's details, fetched when the view opens and again when it is reopened or refreshed;
 * never on a bot event. Null for a bot that is not a Kith agent, so every other bot is untouched.
 */
export function useKithInfo(botId: string): KithInfoStore | null {
  const host = useStoreRef()
  const kith = !!useStore().bots.get(botId)?.hqAgent
  const model = useMemo(() => (kith ? new KithInfoStore(botId, () => host.ready()) : null), [botId, host, kith])
  useModel(model)
  useEffect(() => { void model?.load() }, [model])
  return model
}
