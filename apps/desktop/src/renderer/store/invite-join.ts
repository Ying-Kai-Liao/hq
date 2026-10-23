import type { InviteLink } from '@shared/invite'
import { runJoin, type JoinDeps, type JoinState } from '@shared/invite-join'
import { Observable } from '../lib/observable'
import { account } from './account'

/**
 * Why a joined Mac can't be opened from this app yet. The end-to-end client for other people's Macs lives in the
 * iPhone app only; the join itself (the account's membership and the kept token) is done here, and the same link
 * finishes it on the iPhone.
 */
export const NO_REMOTE_CLIENT = "You've joined this Mac, but the Kith desktop app can't open a shared Mac yet. Open the invite in the Kith iPhone app."

/** The real dependencies of a join; `runJoin` takes them so the order can be tested with fakes. */
export function appJoinDeps(waitForSignIn: () => Promise<void>): JoinDeps {
  return {
    signedIn: () => account.isSignedIn,
    waitForSignIn,
    async accept(inviteId, h1) {
      const res = await window.kith.cloud.acceptInvite(inviteId, h1)
      if (!res.ok) throw res.error
      return res.value as { computerId: string; membershipId?: string }
    },
    async requestAccess() {
      throw new Error(NO_REMOTE_CLIENT)
    },
    async connect() {
      throw new Error(NO_REMOTE_CLIENT)
    },
    keepToken: (computerId, inviteId, token) => window.kith.invites.keep(computerId, inviteId, token),
  }
}

/** The invite link being joined, and how far it got. */
export class InviteJoin extends Observable {
  link: InviteLink | null = null
  state: JoinState | null = null
  private cancelSignIn: ((e: Error) => void) | null = null
  private running = false

  /** A link arrived (or one was waiting at launch): runs the join. */
  async start() {
    if (this.running) return
    const link = await window.kith.invites.takePending()
    if (!link) return
    this.link = link
    await this.run()
  }

  async run() {
    const link = this.link
    if (!link || this.running) return
    this.running = true
    try {
      await runJoin(
        link,
        appJoinDeps(
          () =>
            new Promise<void>((resolve, reject) => {
              this.cancelSignIn = reject
              const stop = account.subscribe(() => {
                if (account.isSignedIn) {
                  stop()
                  this.cancelSignIn = null
                  resolve()
                }
              })
            }),
        ),
        (s) => {
          this.state = s
          this.changed()
        },
      )
    } finally {
      this.running = false
    }
  }

  /** The person closed the sheet. The link is dropped; the token stays kept only if the cloud already took the invite. */
  dismiss() {
    this.cancelSignIn?.(new Error('Sign-in was cancelled.'))
    this.cancelSignIn = null
    this.link = null
    this.state = null
    this.changed()
  }
}

export const inviteJoin = new InviteJoin()
