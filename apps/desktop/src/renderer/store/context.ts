import { createContext, useContext } from 'react'
import { useModel } from '../lib/observable'
import type { AppModel } from './app-model'
import type { BotStore } from './bot-store'

export const AppContext = createContext<AppModel | null>(null)

/** The window's model, re-rendering on its changes. */
export function useApp(): AppModel {
  const app = useContext(AppContext)
  if (!app) throw new Error('AppContext missing')
  return useModel(app)
}

/** The store of the computer a view works on (kit's `@Environment(BotStore.self)`). */
export const StoreContext = createContext<BotStore | null>(null)

export function useStore(): BotStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('StoreContext missing')
  return useModel(store)
}

/** The store without following its changes: for rows that get their data as props. */
export function useStoreRef(): BotStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('StoreContext missing')
  return store
}
