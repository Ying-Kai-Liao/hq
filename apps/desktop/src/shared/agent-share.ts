import { isOpenInvite, type PendingInvite, type Person, type Role } from './people.ts'

/** Sharing one agent with a person (the Share sheet): which rows are about this agent, and what Remove sends. */

/** People who hold this agent, with the role they hold it as. */
export function sharedWith(people: Person[], agent: string): { person: Person; role: Role }[] {
  return people.flatMap((person) => {
    const role = person.agents[agent]
    return role ? [{ person, role }] : []
  })
}

/** Invites for this agent that someone can still accept. */
export function openInvitesFor(invites: PendingInvite[], agent: string, now: number): PendingInvite[] {
  return invites.filter((i) => agent in i.agents && isOpenInvite(i, now))
}

/** The invite body's agents: only this agent, never what the person already holds. */
export const inviteAgents = (agent: string, role: Role): Record<string, Role> => ({ [agent]: role })

/** The person's current agents minus this one; other agents and their roles stay as they are. */
export function agentsWithout(person: Person, agent: string): Record<string, Role> {
  const rest = { ...person.agents }
  delete rest[agent]
  return rest
}

export const roleName = (r: Role) => (r === 'member' ? 'Member' : 'Guest')
