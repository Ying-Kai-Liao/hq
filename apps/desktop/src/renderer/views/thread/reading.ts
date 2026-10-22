import { useEffect, useId } from 'react'
import type { BotStore } from '../../store/bot-store'

/** A scoped read receipt that follows the view's visibility (and the window's), not the selection. */
export function useReading(store: BotStore, botId: string, thread: string | null) {
  const token = useId()
  const connected = store.connection.kind
  useEffect(() => {
    const update = () => store.setReading(token, botId, thread, document.visibilityState === 'visible' && document.hasFocus())
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
      store.setReading(token, botId, thread, false)
    }
  }, [store, token, botId, thread, connected])
}
