import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import { wrapWebSocket, type WebSocketLike } from '../../shared/relay-core/dial.ts'
import type { Dial, Probe } from '../../shared/relay-core/link.ts'

/** Desktop's half of the dial seam: Node (undici) can send the real `Kith-Sig` upgrade header, and can probe a refusal over node:http. */

/** undici's WebSocket never says why an upgrade was refused; this repeats it as plain HTTP and returns the status (null: no answer). */
export const probeUpgrade: Probe = (url, auth) =>
  new Promise((resolve) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(u, {
      method: 'GET',
      timeout: 5000,
      headers: { 'Kith-Sig': auth.sig, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') },
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? null)
    })
    req.on('upgrade', (_res, sock) => {
      sock.destroy()
      resolve(101)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })

export const dialWebSocket: Dial = (url, auth) => {
  // Node's (undici) WebSocket takes the upgrade headers in its init object.
  const ws = new WebSocket(url, { headers: { 'Kith-Sig': auth.sig } } as unknown as string[])
  return wrapWebSocket(ws as unknown as WebSocketLike)
}
