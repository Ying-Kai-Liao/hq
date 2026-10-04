import { join } from 'node:path'
import { app, clipboard, Menu, nativeImage, shell, Tray as ElectronTray } from 'electron'
import type { TraySummary, WindowCommand } from '../shared/ipc'
import type { HostController } from './host-controller'

interface Deps {
  openChat: () => unknown
  openPairing: () => void
  send: (command: WindowCommand, show?: boolean) => void
  host: HostController
}

const resources = () => (app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'))
const TEXT_SIZES = [11, 12, 13, 14, 15, 16, 18]

/** The menu bar icon and its system menu: macOS owns layout, selection and submenus. */
export class Tray {
  private tray: ElectronTray
  private summary: TraySummary | null = null
  private launchAtLogin = app.getLoginItemSettings().openAtLogin

  constructor(private deps: Deps) {
    this.tray = new ElectronTray(this.icon(false))
    this.tray.setToolTip('Codync')
    this.rebuild()
  }

  private icon(alert: boolean) {
    const image = nativeImage.createFromPath(join(resources(), 'tray', alert ? 'trayAlertTemplate.png' : 'trayTemplate.png'))
    image.setTemplateImage(true)
    return image
  }

  update(summary: TraySummary) {
    const attention = summary.needsAttention !== this.summary?.needsAttention
    this.summary = summary
    if (attention) this.tray.setImage(this.icon(summary.needsAttention))
    this.rebuild()
  }

  hostChanged() {
    this.rebuild()
  }

  private image(dataURL: string | null) {
    if (!dataURL) return undefined
    const image = nativeImage.createFromDataURL(dataURL)
    return image.isEmpty() ? undefined : image
  }

  private rebuild() {
    const { host, send } = this.deps
    const s = this.summary
    const state = host.state
    const items: Electron.MenuItemConstructorOptions[] = []
    const status =
      state.kind === 'missingBinary' ? 'Host not found'
      : state.kind === 'notInstalled' ? 'Host not installed'
      : state.kind === 'starting' ? 'Connecting…'
      : state.kind === 'failed' ? 'Host problem'
      : (s?.status ?? 'Connected')
    items.push({ label: status, enabled: false })
    items.push({ label: 'Open Codync', accelerator: 'CmdOrCtrl+O', click: () => this.deps.openChat() })
    if (state.kind === 'running') {
      items.push({ label: 'Pair iPhone…', enabled: s?.canPair ?? false, click: () => this.deps.openPairing() })
    }
    items.push({ type: 'separator' })

    switch (state.kind) {
      case 'missingBinary':
        items.push({ label: 'Reinstall Codync or install the host with Homebrew.', enabled: false })
        items.push({ label: 'Copy host install command', click: () => clipboard.writeText('brew install leepokai/codync/codync-host') })
        break
      case 'notInstalled':
        items.push({ label: 'Install host', click: () => void host.install() })
        break
      case 'starting':
        items.push({ label: 'Starting the host…', enabled: false })
        break
      case 'failed':
        items.push({ label: state.message, enabled: false })
        items.push({ label: 'Restart host', click: () => host.restart() })
        items.push({ label: 'Open log', click: () => void shell.openPath(host.logPath) })
        break
      case 'running':
        if (s?.approval) {
          items.push({ label: `Review access request from ${s.approval}…`, click: () => send({ kind: 'reviewApprovals' }) })
          items.push({ type: 'separator' })
        }
        if (!s || s.bots.length === 0) {
          items.push({ label: 'No bots yet', enabled: false })
        } else {
          for (const bot of s.bots) {
            const submenu: Electron.MenuItemConstructorOptions[] = [
              { label: bot.detail, enabled: false },
              { label: 'Open conversation', click: () => send({ kind: 'openBot', ref: bot.ref }) },
            ]
            if (bot.working) submenu.push({ label: 'Stop task', click: () => send({ kind: 'stopBot', ref: bot.ref }, false) })
            items.push({ label: bot.name, icon: this.image(bot.avatar), submenu })
          }
        }
        if (s?.screen) {
          items.push({ type: 'separator' })
          items.push({ label: 'Remote screen', submenu: this.screenMenu(s.screen) })
        }
        if (s && s.usage.length) {
          items.push({ type: 'separator' })
          for (const provider of s.usage) {
            // Buttons, not text: the menu dims a disabled item's image. They open the app.
            items.push({ label: provider.name, icon: this.image(provider.icon), click: () => this.deps.openChat() })
            for (const line of provider.lines) {
              items.push({ label: line.title, icon: this.image(line.bar), click: () => this.deps.openChat() })
            }
          }
        }
        break
    }

    items.push({ type: 'separator' })
    items.push({ label: 'Settings', submenu: this.settingsMenu() })
    if (s?.version) items.push({ label: `Version ${s.version}`, enabled: false })
    items.push({ label: 'Quit Codync', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() })
    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  private screenMenu(screen: NonNullable<TraySummary['screen']>): Electron.MenuItemConstructorOptions[] {
    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Enable remote screen',
        type: 'checkbox',
        checked: screen.enabled,
        click: () => this.deps.send({ kind: 'setRemoteScreen', on: !screen.enabled }, false),
      },
      { label: screen.subtitle, enabled: false },
    ]
    if (screen.enabled) {
      if (screen.needsLoginItem) {
        items.push({ label: 'Allow Codync Screen in Login Items…', click: () => void shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension') })
      } else {
        if (screen.needsCapture) items.push({ label: 'Allow Screen Recording…', click: () => void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') })
        if (screen.needsInput) items.push({ label: 'Allow Accessibility…', click: () => void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') })
      }
    }
    if (screen.error) items.push({ label: screen.error, enabled: false })
    return items
  }

  private settingsMenu(): Electron.MenuItemConstructorOptions[] {
    const { host, send } = this.deps
    const s = this.summary
    const style = s?.usageIconStyle ?? 'character'
    const size = s?.textSize ?? 12
    return [
      {
        label: 'Usage icons',
        submenu: [
          { label: 'Character', type: 'radio', checked: style === 'character', click: () => send({ kind: 'setUsageIconStyle', style: 'character' }, false) },
          { label: 'Original', type: 'radio', checked: style === 'original', click: () => send({ kind: 'setUsageIconStyle', style: 'original' }, false) },
        ],
      },
      {
        label: 'Text Size',
        submenu: TEXT_SIZES.map((pt) => ({
          label: pt === 12 ? `${pt} pt (Default)` : `${pt} pt`,
          type: 'radio' as const,
          checked: pt === size,
          click: () => send({ kind: 'setTextSize', size: pt }, false),
        })),
      },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: this.launchAtLogin,
        click: () => {
          app.setLoginItemSettings({ openAtLogin: !this.launchAtLogin })
          this.launchAtLogin = app.getLoginItemSettings().openAtLogin
          this.rebuild()
        },
      },
      { type: 'separator' },
      { label: 'Restart host', click: () => host.restart() },
      { label: 'Open log', click: () => void shell.openPath(host.logPath) },
      { type: 'separator' },
      { label: 'Uninstall host service', click: () => void host.uninstall() },
      { type: 'separator' },
      { label: 'Reset all data…', click: () => send({ kind: 'confirmReset' }) },
    ]
  }
}
