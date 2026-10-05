import { needsInput } from '@shared/models'
import type { BotStore } from '../../store/bot-store'

/**
 * While a call's audio is active, speaks each new final reply in the bot's main chat and
 * announces when the bot starts waiting for an approval (kit BotStore `beginVoiceCall`). Only
 * entries newer (by rev) than the call's start count. Returns the function that stops it.
 */
export function watchVoiceCall(store: BotStore, botId: string, handlers: { speak: (text: string) => void; announce: (text: string) => void }) {
  let startRev = 0
  for (const b of store.bots.values()) startRev = Math.max(startRev, b.rev)
  for (const list of store.entries.values()) for (const e of list) startRev = Math.max(startRev, e.rev)
  // Replies already final when the call began are never spoken (a reaction bumps their rev).
  const finals = new Set(store.allEntries(botId).filter((e) => e.data.final).map((e) => e.id))
  let waiting = (() => {
    const bot = store.bots.get(botId)
    return bot ? needsInput(bot) : false
  })()

  return store.subscribe(() => {
    for (const e of store.allEntries(botId)) {
      if (!e.data.final || finals.has(e.id)) continue
      finals.add(e.id)
      if (e.kind === 'agent' && !e.threadId && e.rev > startRev && e.data.text) handlers.speak(e.data.text)
    }
    const bot = store.bots.get(botId)
    const now = bot ? needsInput(bot) : false
    if (bot && now && !waiting) handlers.announce(`${bot.name} needs your approval in the chat.`)
    waiting = now
  })
}
