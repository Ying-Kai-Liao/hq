import { useEffect } from 'react'
import { useModel } from '../../../lib/observable'
import { useStore, useStoreRef } from '../../../store/context'
import { KithInfoStore } from '../../../store/kith-info-store'
import type { BotStore } from '../../../store/bot-store'

// One store per bot and host, so the Details and Memory tabs share one answer and one request.
const stores = new WeakMap<BotStore, Map<string, KithInfoStore>>()

function storeFor(host: BotStore, botId: string): KithInfoStore {
  let byBot = stores.get(host)
  if (!byBot) stores.set(host, (byBot = new Map()))
  let store = byBot.get(botId)
  if (!store) byBot.set(botId, (store = new KithInfoStore(botId, () => host.ready())))
  return store
}

/**
 * A Kith bot's details. `reload` (the details panel opening) reads them again; a view that only
 * follows them (the memory tab) reads only when nobody has yet. Never on a bot event. Null for a
 * bot that is not a Kith agent, so every other bot is untouched.
 */
export function useKithInfo(botId: string, reload = false): KithInfoStore | null {
  const host = useStoreRef()
  const kith = !!useStore().bots.get(botId)?.hqAgent
  const model = kith ? storeFor(host, botId) : null
  useModel(model)
  useEffect(() => {
    if (model && (reload || (!model.loaded && !model.loading))) void model.load()
  }, [model, reload])
  return model
}
