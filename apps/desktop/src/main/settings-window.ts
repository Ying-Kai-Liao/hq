import { join } from 'node:path'
import { BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron'
import type { ProfileMenuChoice, ProfileMenuSpec, WindowCommand } from '../shared/ipc'
import { isSettingsPage, type SettingsPage } from '../shared/settings-pages'

const isMac = process.platform === 'darwin'
let settings: BrowserWindow | null = null
const ground = () => (nativeTheme.shouldUseDarkColors ? '#14161B' : '#FFFFFF')

/** The Settings window: its own window (not a sheet), one at a time; a second request shows its page in the open one. */
export function openSettingsWindow(url: (page: string) => string, page?: SettingsPage | null) {
  if (settings) {
    if (settings.isMinimized()) settings.restore()
    if (page) settings.webContents.send('app:command', { kind: 'openSettingsPage', page } satisfies WindowCommand)
    settings.show()
    settings.focus()
    return
  }
  settings = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 680,
    minHeight: 460,
    title: 'Settings',
    backgroundColor: ground(),
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  settings.on('closed', () => (settings = null))
  void settings.loadURL(`${url('settings')}${page ? `&page=${page}` : ''}`)
}

nativeTheme.on('updated', () => settings?.setBackgroundColor(ground()))

/** The Profile menu is a native menu popped under the picture; the renderer acts on the item chosen. */
export function registerProfileMenu(openSettings: (page?: SettingsPage | null) => void) {
  ipcMain.on('app:openSettingsWindow', (_e, page: unknown) => openSettings(isSettingsPage(page) ? page : null))
  ipcMain.handle('app:profileMenu', (e, spec: ProfileMenuSpec) =>
    new Promise<ProfileMenuChoice | null>((resolve) => {
      const pick = (choice: ProfileMenuChoice) => () => resolve(choice)
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: spec.name, ...(spec.detail ? { sublabel: spec.detail } : {}), enabled: false },
        { type: 'separator' },
        { label: 'Computers', click: pick('computers') },
        { label: 'Extensions', click: pick('extensions') },
        { label: 'Usage', click: pick('usage') },
        { label: spec.approvals > 0 ? `Settings… (${spec.approvals})` : 'Settings…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: pick('settings') },
        {
          label: 'Support',
          submenu: [
            { label: 'Help & documentation', click: pick('help') },
            { label: 'Report an issue', click: pick('issue') },
          ],
        },
        { type: 'separator' },
        ...(spec.signedIn
          ? [{ label: 'Sign out', enabled: !spec.busy, click: pick('signOut') }]
          : [
              { label: 'Continue with Apple', enabled: !spec.busy, click: pick('apple') },
              { label: 'Continue with Google', enabled: !spec.busy, click: pick('google') },
              { label: 'Continue with GitHub', enabled: !spec.busy, click: pick('github') },
            ]),
      ]
      const window = BrowserWindow.fromWebContents(e.sender)
      // The close callback may run before an item's click handler: a dismissal only counts once nothing was chosen.
      Menu.buildFromTemplate(template).popup({ ...(window ? { window } : {}), callback: () => setTimeout(() => resolve(null), 150) })
    }),
  )
}
