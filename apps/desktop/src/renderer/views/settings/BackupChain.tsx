import { useEffect } from 'react'
import {
  CLAUDE_ACCOUNTS_NOTE, addable, entryFor, hasClaudeAccount, loginCommand, move, reasonText, stateText,
  type BackupEntry,
} from '@shared/backups'
import { Button, DropdownMenu, IconButton } from '../../components/Controls'
import { HStack, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { useApp } from '../../store/context'
import { BackupsStore } from '../../store/backups-store'
import type { BotStore } from '../../store/bot-store'
import { ComputerBadge } from '../ComputerBadge'
import './backup-chain.css'

// One store per computer, so Settings and a bot's details share one answer.
const stores = new WeakMap<BotStore, BackupsStore>()

/** The computer's backup chain, read again each time a view that shows it opens; null before `host` exists. */
export function useBackups(host: BotStore | null | undefined): BackupsStore | null {
  let model: BackupsStore | null = null
  if (host) {
    model = stores.get(host) ?? null
    if (!model) stores.set(host, (model = new BackupsStore(() => host.ready())))
  }
  useModel(model)
  useEffect(() => void model?.load(), [model])
  return model
}

/** Settings → Usage: every computer's backup order, under its limits. */
export function BackupChains() {
  const app = useApp()
  const hosts = app.computers.flatMap((c) => app.store(c.id) ?? [])
  return (
    <>
      {hosts.map((host) => <ComputerBackups key={host.computer.id} host={host} labeled={hosts.length > 1} />)}
    </>
  )
}

function ComputerBackups({ host, labeled }: { host: BotStore; labeled: boolean }) {
  const store = useBackups(host)
  // A host from before this call has nothing to show.
  if (!store || store.unsupported) return null
  return (
    <section className="backups">
      <HStack gap={8} className="backups-head">
        {labeled ? <ComputerBadge computer={host.computer} size={16} /> : null}
        <Text as="h3" size="body" weight="semibold" tone="text">Backups</Text>
      </HStack>
      <Text size="callout" tone="secondary">
        When an agent's own account runs out of usage, Kith moves its turns down this list until the limit lifts.
        Logging in stays in the terminal; the app only shows the command.
      </Text>
      <ChainEditor store={store} agent={null} chain={store.backups.global} />
    </section>
  )
}

/** One order: its entries with their state, reorder, remove, and add. `agent` null is the global order. */
export function ChainEditor({ store, agent, chain }: { store: BackupsStore; agent: string | null; chain: string[] }) {
  const { backups } = store
  const save = (next: string[]) => void store.set(agent, next)
  const options = addable(backups, chain)
  return (
    <VStack gap={10}>
      {store.error ? <Text size="callout" tone="danger" role="alert">{store.error}</Text> : null}
      {!store.loaded && store.loading ? <Text size="callout" tone="secondary">Reading the backups…</Text> : null}
      {chain.length === 0 && store.loaded ? (
        <Text size="callout" tone="secondary">
          No backups. Add one below{agent ? '' : ', or from the terminal with `kith backup add codex`'}; nothing changes until you do.
        </Text>
      ) : null}
      {chain.length ? (
        <ol className="backups-list">
          {chain.map((id, i) => (
            <li key={id} className="backups-row">
              <EntryRow entry={entryFor(backups, id)} index={i} />
              <HStack gap={2} className="backups-actions">
                <IconButton title={`Move ${id} up`} icon="arrow.up" size={24} disabled={i === 0} onClick={() => save(move(chain, i, i - 1))} />
                <IconButton title={`Move ${id} down`} icon="arrow.down" size={24} disabled={i === chain.length - 1} onClick={() => save(move(chain, i, i + 1))} />
                <IconButton title={`Remove ${id}`} icon="xmark" size={24} onClick={() => save(chain.filter((c) => c !== id))} />
              </HStack>
            </li>
          ))}
        </ol>
      ) : null}
      <HStack gap={8}>
        <DropdownMenu
          className="styled-button secondary"
          title="Add a backup"
          items={() => options.map((id) => ({
            title: entryFor(backups, id).ready ? id : `${id} (${entryFor(backups, id).why ?? 'not ready'})`,
            action: () => save([...chain, id]),
          }))}
        >
          Add backup
        </DropdownMenu>
        {agent === null && store.loaded ? (
          <Button kind="secondary" disabled={store.loading} onClick={() => void store.load()}>Refresh</Button>
        ) : null}
      </HStack>
      {hasClaudeAccount(chain) ? <Text size="callout" tone="secondary" className="backups-note">{CLAUDE_ACCOUNTS_NOTE}</Text> : null}
    </VStack>
  )
}

function EntryRow({ entry, index }: { entry: BackupEntry; index: number }) {
  const state = stateText(entry)
  const command = state.tone === 'ok' ? null : loginCommand(entry)
  const why = state.tone === 'out' ? reasonText(entry.reason) : null
  return (
    <VStack gap={2} grow className="backups-entry">
      <HStack gap={8}>
        <Text tabular tone="tertiary" size="callout">{index + 1}</Text>
        <Text truncate className="backups-id">{entry.id}</Text>
        <Text size="callout" className={`backups-state ${state.tone}`}>{state.text}</Text>
      </HStack>
      {why ? <Text size="callout" tone="secondary">{why}</Text> : null}
      {command && state.tone === 'blocked' ? (
        <HStack gap={6} className="backups-fix">
          <Text size="callout" tone="secondary">Run in the terminal:</Text>
          <code className="backups-code">{command}</code>
          <IconButton title="Copy command" icon="doc.on.doc" size={22} onClick={() => void navigator.clipboard?.writeText(command)} />
        </HStack>
      ) : null}
    </VStack>
  )
}
