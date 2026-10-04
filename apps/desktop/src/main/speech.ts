import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
import type { SpeechEvent } from '../shared/ipc'

// On-device speech recognition for calls: a small Swift helper (native/speech-macos) runs
// SFSpeechRecognizer on the microphone and prints JSON lines. macOS only.

function helperPath() {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'codync-speech') : null,
    join(__dirname, '../../native/speech-macos/.build/release/codync-speech'),
    join(__dirname, '../../native/speech-macos/.build/debug/codync-speech'),
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
}

let child: ChildProcessWithoutNullStreams | null = null
let listener: WebContents | null = null

function emit(event: SpeechEvent) {
  if (listener && !listener.isDestroyed()) listener.send('speech:event', event)
}

function start(sender: WebContents, locale: string | null) {
  stop()
  listener = sender
  const path = helperPath()
  if (!path) return emit({ type: 'error', message: "On-device speech isn't available in this build." })
  const proc = spawn(path, locale ? ['--locale', locale] : [], { stdio: 'pipe' })
  child = proc
  let buffer = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        if (child === proc) emit(JSON.parse(line) as SpeechEvent)
      } catch {}
    }
  })
  proc.on('exit', () => {
    if (child === proc) {
      child = null
      emit({ type: 'stopped' })
    }
  })
  proc.on('error', (error) => emit({ type: 'error', message: error.message }))
}

function stop() {
  const proc = child
  child = null
  if (proc && !proc.killed) proc.kill('SIGTERM')
}

export function registerSpeech() {
  ipcMain.on('speech:available', (e) => (e.returnValue = process.platform === 'darwin' && helperPath() !== null))
  ipcMain.on('speech:start', (e, locale: string | null) => start(e.sender, locale))
  ipcMain.on('speech:stop', () => stop())
  app.on('before-quit', stop)
}
