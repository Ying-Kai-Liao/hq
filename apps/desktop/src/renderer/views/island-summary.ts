import { useEffect } from 'react'
import type { IslandPermission, IslandSummary } from '@shared/island'
import { isGroup } from '@shared/models'
import { useModels } from '../lib/observable'
import { refKey, type AppModel, type RosterItem } from '../store/app-model'
import { botDetail } from './tray-summary'
import { optionLabel, permissionHeadline, sortedOptions } from './thread/PermissionCard'

let sent = ''
let pending: ReturnType<typeof setTimeout> | null = null

/**
 * Sends the notch island what it shows when the stores change: at most every 150 ms while
 * replies stream (reading the stores when it fires), and only when that changed.
 */
export function useIslandSummary(app: AppModel) {
  useModels([...app.stores.values()])
  useEffect(() => {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      const summary = islandSummary(app)
      const json = JSON.stringify(summary)
      if (json === sent) return
      sent = json
      window.codync.island.setSummary(summary)
    }, 150)
  })
}

function islandSummary(app: AppModel): IslandSummary {
  const many = app.computers.length > 1
  return {
    bots: app.roster
      .filter((i) => !isGroup(i.bot))
      .map((i) => ({
        ref: refKey(i.ref),
        name: many ? `${i.bot.name} · ${i.computer.name}` : i.bot.name,
        shape: i.bot.avatarShape,
        color: i.bot.avatarColor,
        status: i.bot.status,
        detail: botDetail(i.bot),
      })),
    permissions: app.roster.flatMap(pendingCards),
  }
}

/** A conversation's unanswered approval cards; in a group, the member that asks. */
function pendingCards({ ref, bot, store }: RosterItem): IslandPermission[] {
  return store
    .allEntries(bot.id)
    .filter((e) => e.kind === 'permission' && e.data.status === 'pending')
    .map((e) => {
      const author = (e.data.author ? store.bots.get(e.data.author) : undefined) ?? bot
      return {
        ref: refKey(ref),
        entryId: e.id,
        bot: { name: author.name, shape: author.avatarShape, color: author.avatarColor },
        headline: permissionHeadline(e.data.toolKind),
        title: e.data.title ?? '',
        options: sortedOptions(e.data.options ?? []).map((o) => ({ id: o.optionId, label: optionLabel(o), allow: o.kind.startsWith('allow') })),
        answering: store.answering.get(e.id) ?? null,
      }
    })
}
