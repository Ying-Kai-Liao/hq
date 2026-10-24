/** What the problem card needs to know about one Mac. */
export interface MacProblemInput {
  kind: 'this' | 'ssh' | 'relay'
  /** Shown in Crew (not hidden in Settings). */
  shown: boolean
  /** This device has a channel to it; an account Mac it hasn't set up yet has none. */
  hasStore: boolean
  /** The relay row's action: connect and cancel mean no access yet. */
  action: 'connect' | 'cancel' | 'disconnect' | 'forget' | 'none'
  mismatch: boolean
  /** The refusal is the "open the invite link" text, which isn't a fault to fix here. */
  openInvite: boolean
  connection:
    | { kind: 'unpaired' | 'connecting' | 'online' }
    | { kind: 'computerOffline'; lastSeen: number | null }
    | { kind: 'offline'; message: string }
    | { kind: 'unauthorized'; message: string }
}

export interface MacProblem {
  icon: string
  title: string
  detail: string
  /** reconnect tries the link again; forget stops using the Mac on this device. */
  button: 'reconnect' | 'forget'
}

/** The card for a Mac that needs the person, or null: a version mismatch, this Mac, SSH and hidden computers never get one. */
export function macProblem(name: string, input: MacProblemInput, seen: (ms: number) => string): MacProblem | null {
  if (input.kind !== 'relay' || !input.shown || !input.hasStore || input.mismatch || input.openInvite) return null
  if (input.action === 'connect' || input.action === 'cancel') return null
  const c = input.connection
  switch (c.kind) {
    case 'computerOffline':
      return {
        icon: 'desktopcomputer.trianglebadge.exclamationmark',
        title: `${name} is offline`,
        detail: `${c.lastSeen ? `Last seen ${seen(c.lastSeen)}. ` : ''}Its agents pick up again when it's back.`,
        button: 'reconnect',
      }
    case 'offline':
      return { icon: 'wifi.slash', title: `Can't reach ${name}`, detail: "This Mac can't connect to it right now.", button: 'reconnect' }
    case 'unauthorized':
      return { icon: 'lock.slash', title: `${name} stopped letting this Mac in`, detail: c.message || 'Access was removed on the Mac.', button: 'forget' }
    default:
      return null
  }
}
