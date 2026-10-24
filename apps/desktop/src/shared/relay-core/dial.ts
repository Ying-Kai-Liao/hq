import { b64url, text } from './crypto.ts'
import { RelayError, type Dial, type DialAuth, type Socket } from './link.ts'

/**
 * Turning a WebSocket into the link's `Socket`, and the browser's way to dial: browsers can't set upgrade headers, so
 * the signature and the session token ride in `Sec-WebSocket-Protocol` (design 2026-10-25 §4.6). Desktop's dialer, which
 * sends the real `Kith-Sig` header, lives in main/relay/dial.ts and uses `wrapWebSocket` too.
 */

/** The part of a WebSocket the link uses; both the browser's and undici's satisfy it. */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number): void
  addEventListener(type: 'open' | 'error', cb: () => void): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
  addEventListener(type: 'close', cb: (e: { code: number }) => void): void
}

export function wrapWebSocket(ws: WebSocketLike): Socket {
  const socket: Socket = {
    send: (text) => ws.send(text),
    close: (code) => {
      try {
        // 1000 and 3000-4999 are the only codes a client may send.
        ws.close(code === 1011 ? 1000 : code)
      } catch {}
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  }
  ws.addEventListener('open', () => socket.onopen?.())
  ws.addEventListener('message', (e) => socket.onmessage?.(typeof e.data === 'string' ? e.data : ''))
  ws.addEventListener('close', (e) => socket.onclose?.(e.code))
  ws.addEventListener('error', () => {})
  return socket
}

/** The subprotocol list the cloud reads when there is no `Kith-Sig` header: `kith.v1`, the signature, the session JWT. */
export const browserProtocols = (auth: DialAuth, jwt: string) => ['kith.v1', `kith-sig.${b64url(text(auth.sig))}`, `kith-jwt.${jwt}`]

export interface BrowserDialOptions {
  /**
   * A fresh Clerk session JWT, asked for on every dial (a reconnect after 4100 must not reuse the old one). Resolve null
   * when there is definitely no session; any throw (a network blip) is retried with backoff, not read as signed out.
   */
  jwt: () => Promise<string | null>
  /** The WebSocket constructor; default the global one. */
  WebSocket?: new (url: string, protocols: string[]) => WebSocketLike
}

/**
 * Close codes the cloud answers a refused browser upgrade with (it accepts, then closes, since a browser can't read an
 * HTTP status): 4404 unknown computer, 4426 needs update, 4401 no or expired session, 4403 forbidden, 4100 reconnect.
 * `RelayLink.outcomeForClose` is the one place they are mapped.
 */
export function browserDial(options: BrowserDialOptions): Dial {
  return async (url, auth) => {
    const jwt = await options.jwt()
    if (!jwt) throw new RelayError(401, 'Sign in again to reach your computers.', 'signedOut')
    const Ctor = options.WebSocket ?? (globalThis.WebSocket as unknown as NonNullable<BrowserDialOptions['WebSocket']>)
    return wrapWebSocket(new Ctor(url, browserProtocols(auth, jwt)))
  }
}
