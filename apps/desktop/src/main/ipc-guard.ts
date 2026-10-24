import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { isRendererURL } from '../shared/navigation'

/** Any URL of the renderer; matches the base `rendererURL` in index.ts builds. */
const base = () =>
  process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/` : `file://${join(__dirname, '../renderer/index.html')}`

/** Sensitive handlers (tokens, cloud, reset) only answer the app's own pages, never a foreign page that got loaded. */
export function fromRenderer<A extends unknown[], R>(handler: (e: IpcMainInvokeEvent, ...args: A) => R) {
  return (e: IpcMainInvokeEvent, ...args: A): R => {
    if (!isRendererURL(e.senderFrame?.url, base())) throw new Error('Refused: the request did not come from the app.')
    return handler(e, ...args)
  }
}
