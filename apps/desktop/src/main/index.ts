import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron'
import type { HostSnapshot, WindowCommand } from '../shared/ipc'
import { devPort, fetchHealth, HostController } from './host-controller'
import { registerHostProxy } from './host-proxy'
import { readClipboardFiles, readFiles } from './files'
import { Tray } from './tray'
import { AccountService } from './account'
import { Updates } from './updates'
import { handleURL, registerAuthIPC, registerSchemes, urlFromArgv } from './auth'
import { registerSpeech } from './speech'

const host = new HostController()
const account = new AccountService()
const updates = new Updates()
let chat: BrowserWindow | null = null
let pairing: BrowserWindow | null = null
let quitting = false
const isMac = process.platform === 'darwin'

function rendererURL(page: string) {
  return process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/?window=${page}`
    : `file://${join(__dirname, '../renderer/index.html')}?window=${page}`
}

const background = () => (nativeTheme.shouldUseDarkColors ? '#0A0A0A' : '#FFFFFF')

function snapshot(): HostSnapshot {
  return { state: host.state, local: host.local, dev: devPort !== null, logPath: host.logPath }
}

/** The chat window: roster on the left, the conversation on the right (Grok Bot's desktop layout). */
function openChat() {
  if (chat) {
    chat.show()
    chat.focus()
    return chat
  }
  chat = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 500,
    title: 'Codync',
    show: false,
    backgroundColor: background(),
    titleBarStyle: isMac ? 'hidden' : 'default',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  chat.on('ready-to-show', () => chat?.show())
  // Closing hides: the window keeps the stores (and the menu bar's data) alive.
  chat.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    chat?.hide()
  })
  chat.on('closed', () => (chat = null))
  chat.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void chat.loadURL(rendererURL('chat'))
  return chat
}

function openPairing() {
  if (pairing) {
    pairing.webContents.send('app:command', { kind: 'reviewApprovals' } satisfies WindowCommand)
    pairing.show()
    pairing.focus()
    return
  }
  pairing = new BrowserWindow({
    width: 340,
    height: 420,
    useContentSize: true,
    resizable: false,
    title: 'Pair iPhone',
    backgroundColor: background(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  pairing.on('closed', () => (pairing = null))
  void pairing.loadURL(rendererURL('pairing'))
}

export function send(command: WindowCommand, show = true) {
  const window = show ? openChat() : chat
  if (show && isMac) app.focus({ steal: true })
  window?.webContents.send('app:command', command)
}

function menu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Bigger', accelerator: 'CmdOrCtrl+=', click: () => send({ kind: 'stepTextSize', up: true }, false) },
        { label: 'Smaller', accelerator: 'CmdOrCtrl+-', click: () => send({ kind: 'stepTextSize', up: false }, false) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send({ kind: 'stepTextSize', up: null }, false) },
        { type: 'separator' },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send({ kind: 'newChat' }) },
        { label: 'Search Bots', accelerator: 'CmdOrCtrl+F', click: () => send({ kind: 'search' }) },
        { label: 'Toggle Sidebar', accelerator: 'Ctrl+CmdOrCtrl+S', click: () => send({ kind: 'toggleSidebar' }, false) },
        { label: 'Conversation Details', accelerator: 'Alt+CmdOrCtrl+I', click: () => send({ kind: 'toggleDetails' }, false) },
        { type: 'separator' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }, { role: 'reload' as const }]),
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIPC(tray: Tray) {
  registerHostProxy()
  ipcMain.on('app:version', (e) => (e.returnValue = app.getVersion()))
  ipcMain.handle('host:snapshot', () => snapshot())
  ipcMain.handle('host:health', (_e, url: string) => fetchHealth(url))
  ipcMain.on('host:install', () => void host.install())
  ipcMain.on('host:restart', () => host.restart())
  ipcMain.on('host:uninstall', () => void host.uninstall())
  ipcMain.on('host:openLog', () => void shell.openPath(host.logPath))
  ipcMain.on('app:openExternal', (_e, url: string) => {
    if (/^(https?|mailto|x-apple\.systempreferences):/.test(url)) void shell.openExternal(url)
  })
  ipcMain.on('app:openSettings', (_e, url: string) => {
    if (url.startsWith('x-apple.systempreferences:')) void shell.openExternal(url)
  })
  ipcMain.on('app:copy', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('app:pickFiles', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : readFiles(result.filePaths)
  })
  ipcMain.handle('app:clipboardFiles', () => readClipboardFiles())
  ipcMain.on('app:traySummary', (_e, summary) => tray.update(summary))
  ipcMain.on('app:openPairing', () => openPairing())
  ipcMain.on('app:quit', () => app.quit())
  ipcMain.handle('app:launchAtLogin', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('app:setLaunchAtLogin', (_e, on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:resetAllData', async () => {
    await host.uninstall()
    const { rm } = await import('node:fs/promises')
    const { dataDir } = await import('./host-controller')
    await rm(dataDir, { recursive: true, force: true })
    await rm(app.getPath('userData'), { recursive: true, force: true })
    app.relaunch()
    quitting = true
    app.exit(0)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerSchemes()
  app.on('second-instance', (_e, argv) => {
    const url = urlFromArgv(argv)
    if (url) handleURL(url)
    else openChat()
  })
  app.on('before-quit', () => (quitting = true))
  app.on('activate', () => openChat())
  app.on('window-all-closed', () => {
    // A menu bar app: it keeps running with no window.
  })
  void app.whenReady().then(() => {
    const tray = new Tray({ openChat, openPairing, send, host })
    registerIPC(tray)
    registerAuthIPC()
    registerSpeech()
    // Calls use the microphone (realtime voice); nothing else asks for permissions.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media' || permission === 'clipboard-sanitized-write'))
    account.register(() => BrowserWindow.getAllWindows())
    updates.register(() => BrowserWindow.getAllWindows())
    menu()
    host.on('change', () => {
      const s = snapshot()
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('host:change', s)
      tray.hostChanged()
    })
    nativeTheme.on('updated', () => {
      for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(background())
    })
    host.start()
    openChat()
  })
}
