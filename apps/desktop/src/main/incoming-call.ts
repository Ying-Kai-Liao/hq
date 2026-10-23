import { app, BrowserWindow, ipcMain, Notification, screen, type WebContents } from 'electron'
import { isCallAnswer, parsePanelCall, type CallAnswer, type IncomingPanelCall } from '../shared/incoming-call'

const WIDTH = 340
const HEIGHT = 430
const MARGIN = 22

interface Deps {
  url: string
  preload: string
  /** The chat window, if it exists; an answer is delivered there. */
  chatWindow: () => BrowserWindow | null
  /** Brings the chat window forward (Accept takes the person to the call). */
  openChat: () => void
}

/**
 * The incoming-call panel: a small frameless window above other apps at the top right of the screen, like FaceTime.
 * The chat window owns the call and asks for it with `incomingCall:show`; the panel shows the one call it is given
 * (the newest) and sends the answer back through here. In full screen the panel would sit over the person's work, so
 * a system notification (Accept / Decline where the platform has the buttons) does the job; when neither can open,
 * `show` says false and the chat window shows the call itself.
 */
export function registerIncomingCall(deps: Deps) {
  let panel: BrowserWindow | null = null
  let notification: Notification | null = null
  let current: IncomingPanelCall | null = null
  let source: WebContents | null = null
  let timer: NodeJS.Timeout | null = null

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
    notification?.close()
    notification = null
    current = null
    if (panel && !panel.isDestroyed()) panel.close()
    panel = null
  }

  /** Delivers the answer once: the call is cleared first, so a second click finds nothing. */
  const answer = (id: string, how: CallAnswer) => {
    if (current?.id !== id) return
    const to = source
    clear()
    if (how === 'accept') deps.openChat()
    if (to && !to.isDestroyed()) to.send('incomingCall:answer', { id, answer: how })
    else deps.chatWindow()?.webContents.send('incomingCall:answer', { id, answer: how })
  }

  const openPanel = (call: IncomingPanelCall) => {
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send('incomingCall:call', call)
      panel.showInactive()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    panel = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: area.x + area.width - WIDTH - MARGIN,
      y: area.y + MARGIN,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Kith call',
      webPreferences: { preload: deps.preload, sandbox: true, contextIsolation: true },
    })
    // Above other apps and on every desktop, but never taking the keyboard from whatever the person is typing in.
    panel.setAlwaysOnTop(true, 'floating')
    panel.setVisibleOnAllWorkspaces(true)
    panel.once('ready-to-show', () => panel?.showInactive())
    const mine = panel
    panel.on('closed', () => {
      if (panel === mine) panel = null
    })
    void panel.loadURL(deps.url)
  }

  const notify = (call: IncomingPanelCall) => {
    if (!Notification.isSupported()) return false
    const n = new Notification({
      title: `${call.name} is calling you`,
      body: call.reason || 'Kith call',
      silent: true,
      actions: [
        { type: 'button', text: 'Accept' },
        { type: 'button', text: 'Decline' },
      ],
    })
    n.on('action', (_e, index) => answer(call.id, index === 1 ? 'decline' : 'accept'))
    // Without the buttons (or a click on the body) it brings the app forward, where the call keeps ringing.
    n.on('click', () => deps.openChat())
    n.show()
    notification = n
    return true
  }

  ipcMain.handle('incomingCall:show', (e, raw: unknown) => {
    const call = parsePanelCall(raw)
    if (!call) return false
    // A newer call replaces the one showing.
    if (current && current.id !== call.id) clear()
    current = call
    source = e.sender
    if (timer) clearTimeout(timer)
    timer = setTimeout(clear, Math.max(0, call.deadline - Date.now()) + 1000)
    try {
      if (deps.chatWindow()?.isFullScreen()) {
        if (notify(call)) return true
        clear()
        return false
      }
      openPanel(call)
      return true
    } catch (error) {
      console.error(`incoming call: couldn't open the panel: ${error instanceof Error ? error.message : String(error)}`)
      clear()
      return false
    }
  })
  ipcMain.on('incomingCall:close', (_e, id: unknown) => {
    if (typeof id === 'string' && current?.id === id) clear()
  })
  ipcMain.handle('incomingCall:current', () => current)
  ipcMain.on('incomingCall:respond', (_e, id: unknown, how: unknown) => {
    if (typeof id === 'string' && isCallAnswer(how)) answer(id, how)
  })
  app.on('before-quit', clear)
}
