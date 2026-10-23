import type { ProfileMenuChoice } from '@shared/ipc'
import type { SettingsPage } from '@shared/settings-pages'
import { account } from '../../store/account'
import type { AppModel } from '../../store/app-model'
import { peopleFor } from '../../store/people-store'

/** Opens (or focuses) the Settings window, on `page` when given. The one call for every old "open Settings" entry point. */
export const openSettingsWindow = (page?: SettingsPage) => window.kith.app.openSettingsWindow(page)

/**
 * Pops the native Profile menu under the picture and acts on the choice. `onExtensions` opens the Extensions
 * sheet of the window that calls this; everything else (Settings pages, support links, sign in and out) is handled here.
 * The sidebar's picture click calls `void openProfileMenu(app, { onExtensions: openMarketplace })`.
 */
export async function openProfileMenu(app: AppModel, { onExtensions }: { onExtensions: () => void }) {
  const { user, isBusy } = account
  const macs = app.computers.length
  const people = app.local ? peopleFor(app.local).people.length : 0
  // Only the parts the data has.
  const detail = [macs > 0 ? `${macs} Mac${macs === 1 ? '' : 's'}` : null, people > 0 ? `${people} ${people === 1 ? 'person' : 'people'}` : null].filter(Boolean).join(' · ')
  const choice: ProfileMenuChoice | null = await window.kith.app.profileMenu({
    name: user?.email ?? 'Account',
    detail: user ? detail : 'Not signed in',
    signedIn: user !== null,
    busy: isBusy,
    approvals: app.approvals.length,
  })
  switch (choice) {
    case 'computers':
      return openSettingsWindow('computers')
    case 'usage':
      return openSettingsWindow('usage')
    case 'settings':
      return openSettingsWindow()
    case 'extensions':
      return onExtensions()
    case 'help':
      return window.kith.app.openExternal('https://github.com/Ying-Kai-Liao/kith#readme')
    case 'issue':
      return window.kith.app.openExternal('https://github.com/Ying-Kai-Liao/kith/issues')
    case 'signOut':
      return void account.signOut()
    case 'apple':
    case 'google':
    case 'github':
      return void account.signIn(choice)
    case null:
      return
  }
}
