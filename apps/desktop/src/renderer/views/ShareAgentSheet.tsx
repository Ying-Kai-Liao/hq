import { useEffect, useState } from 'react'
import { inviteAgents, invitesOnly, openInvitesFor, roleName, sharedWith } from '@shared/agent-share'
import { isGroup, type Bot } from '@shared/models'
import type { CreatedInvite, Person, Role } from '@shared/people'
import { Button, CardSection, SegmentedChoice } from '../components/Controls'
import { Icon } from '../components/Icon'
import { Dialog, ModalHeader, Sheet, SheetPage } from '../components/Overlay'
import { HStack, Spacer, VStack } from '../components/Stack'
import { Text } from '../components/Text'
import { useModel } from '../lib/observable'
import type { BotStore } from '../store/bot-store'
import { peopleFor } from '../store/people-store'
import { InviteLinkCard } from './settings/PeopleView'
import './settings/settings.css'

/**
 * Whether the Share action shows for a bot: the owner of a connected computer whose host knows people,
 * on a single agent's chat. Loads the people list once so an old host hides it.
 */
export function useCanShareAgent(store: BotStore, bot: Bot | null | undefined): boolean {
  const people = peopleFor(store)
  useModel(people)
  const eligible = shareEligible(store, bot)
  useEffect(() => {
    if (eligible && people.supported === null) void people.load()
  }, [eligible, people])
  return eligible && people.supported !== false
}

/** The checks that need no host answer: owner, connected, one agent's chat. */
function shareEligible(store: BotStore, bot: Bot | null | undefined): bot is Bot {
  return store.connection.kind === 'online' && store.isOwner && !!bot && !isGroup(bot) && !!bot.hqAgent
}

/** For a menu built outside a hook: eligible and the host hasn't said it lacks people. */
export function canShareAgent(store: BotStore, bot: Bot): boolean {
  return shareEligible(store, bot) && peopleFor(store).supported !== false
}

/** Share one agent: who has it, and an invite for someone new that grants this agent only. */
export function ShareAgentSheet({ store, bot, open, onClose }: { store: BotStore; bot: Bot; open: boolean; onClose: () => void }) {
  return (
    <Sheet className="settings-sheet" open={open} onClose={onClose} width={480}>
      {open ? <ShareAgentBody store={store} agent={bot.hqAgent ?? ''} name={bot.name} /> : null}
    </Sheet>
  )
}

function ShareAgentBody({ store, agent, name }: { store: BotStore; agent: string; name: string }) {
  const people = peopleFor(store)
  useModel(people)
  const [pick, setPick] = useState('')
  const [who, setWho] = useState('')
  const [role, setRole] = useState<Role>('guest')
  const [made, setMade] = useState<CreatedInvite | null>(null)
  const [removing, setRemoving] = useState<Person | null>(null)
  useEffect(() => {
    people.notice = null
    void people.load()
  }, [people])

  const now = Date.now()
  const holders = sharedWith(people.people, agent)
  const open = openInvitesFor(people.invites, agent, now)
  const pending = invitesOnly(open, holders)
  const nameOf = (id: string) => people.people.find((p) => p.personId === id)?.name ?? id
  // People who already hold this agent have nothing to be invited to.
  const others = people.people.filter((p) => !(agent in p.agents))
  const ready = pick !== '' || who.trim() !== ''

  const create = async () => {
    if (people.busy || !ready) return
    const result = await people.create(pick ? { personId: pick } : { name: who.trim() }, inviteAgents(agent, role))
    if (result) setMade(result)
  }

  if (made) {
    return (
      <SheetPage>
        <ModalHeader title={`Share ${name}`} subtitle="Invite ready" />
        <InviteLinkCard invite={made} />
        <HStack className="settings-invite-body">
          <Spacer />
          <Button kind="secondary" onClick={() => { setMade(null); setPick(''); setWho('') }}>Done</Button>
        </HStack>
      </SheetPage>
    )
  }

  return (
    <SheetPage>
      <ModalHeader title={`Share ${name}`} />
      <VStack gap={14} className="settings-invite-body">
        <VStack gap={6}>
        <Text size="caption" tone="secondary">Shared with</Text>
        <CardSection footer={holders.length === 0 && pending.length === 0 ? `No one has ${name} yet. Invite someone below.` : undefined}>
          {holders.map(({ person, role: held }) => (
            <div key={person.personId} className="settings-row">
              <Icon name="person.crop.circle" size={22} color="var(--secondary)" />
              <VStack grow className="settings-stack">
                <Text truncate>{person.name}</Text>
                <Text size="caption" tone="secondary">{roleName(held)} · {person.joined ? 'Joined' : open.some((i) => i.personId === person.personId) ? 'Invite not used yet' : 'Waiting to join'}</Text>
              </VStack>
              <Button kind="secondary" onClick={() => setRemoving(person)} disabled={people.busy}>Remove</Button>
            </div>
          ))}
          {pending.map((invite) => (
            <div key={invite.inviteId} className="settings-row">
              <Icon name="link" size={20} color="var(--secondary)" />
              <VStack grow className="settings-stack">
                <Text truncate>{nameOf(invite.personId)}</Text>
                <Text size="caption" tone="secondary">{roleName(invite.agents[agent] ?? 'guest')} · Invite not used yet</Text>
              </VStack>
              <Button kind="secondary" onClick={() => void people.revokeInvite(invite.inviteId)} disabled={people.busy}>Cancel</Button>
            </div>
          ))}
        </CardSection>
        </VStack>

        <VStack gap={8}>
          <Text size="caption" tone="secondary">Invite someone</Text>
          {others.length > 0 ? (
            <select className="settings-select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person">
              <option value="">Someone new</option>
              {others.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}
            </select>
          ) : null}
          {pick === '' ? (
            <input className="settings-input" placeholder="Their name" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Their name" />
          ) : null}
          <HStack gap={10} align="center">
            <div style={{ width: 180 }}>
              <SegmentedChoice<Role> selection={role} options={[{ id: 'guest', label: 'Guest' }, { id: 'member', label: 'Member' }]} onChange={setRole} />
            </div>
            <Spacer />
            <Button onClick={() => void create()} disabled={!ready || people.busy}>{people.busy ? 'Creating…' : 'Create invite'}</Button>
          </HStack>
          <Text size="footnote" tone="secondary">A member can do more with an agent than a guest. Guest is the safer start. They get {name} only.</Text>
        </VStack>
        {people.error ? <Text size="footnote" tone="danger">{people.error}</Text> : null}
        {people.notice ? <Text size="footnote" tone="secondary">{people.notice}</Text> : null}
      </VStack>
      <Dialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'this person'} from ${name}?`}
        message={`They stop being able to use ${name}. Anything else they were given stays.`}
        actions={[{ title: 'Remove', destructive: true, action: () => removing && void people.removeAgent(removing, agent) }]}
        onClose={() => setRemoving(null)}
      />
    </SheetPage>
  )
}
