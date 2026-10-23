import type { GuestPrompt } from '@shared/mac-role'
import { Spinner } from '../components/Controls'
import { VStack } from '../components/Stack'
import { Text } from '../components/Text'
import { useModel } from '../lib/observable'
import type { BotStore } from '../store/bot-store'
import { optionLabel, sortedOptions } from './thread/PermissionCard'

/**
 * "Needs your OK": what other people's agents on this Mac ask, for the owner to answer. The data and the answering are
 * the store's (`guestPrompts`, `respond`); this is only their layout, so it can be restyled without touching them.
 */
export function GuestPromptList({ store }: { store: BotStore }) {
  useModel(store)
  const prompts = store.guestPrompts
  if (!prompts.length) return null
  return (
    <VStack gap={8} className="guest-prompts" aria-label="Needs your OK">
      <Text size="caption" weight="semibold" tone="secondary">Needs your OK</Text>
      {prompts.map((p) => (
        <GuestPromptRow key={p.entryId} prompt={p} answering={store.answering.get(p.entryId) ?? null} respond={(option) => store.respond(p.entry, option)} />
      ))}
    </VStack>
  )
}

function GuestPromptRow({ prompt, answering, respond }: { prompt: GuestPrompt; answering: string | null; respond: (option: string) => void }) {
  return (
    <VStack gap={4} className="guest-prompt">
      <Text size="callout" weight="medium" truncate>{`${prompt.personName} · ${prompt.agent}`}</Text>
      <Text size="caption" tone="secondary" mono lines={3}>{prompt.title}</Text>
      <div className="permission-card-options">
        {sortedOptions(prompt.options).map((o) => (
          <button
            key={o.optionId}
            className={answering === null || answering === o.optionId ? 'permission-option' : 'permission-option dimmed'}
            disabled={answering !== null}
            onClick={() => respond(o.optionId)}
          >
            <Text size="body" weight={o.kind === 'allow_once' ? 'semibold' : 'regular'} tone={o.kind.startsWith('allow') ? 'text' : 'danger'} className="permission-option-label">{optionLabel(o)}</Text>
            {answering === o.optionId ? <Spinner size={14} /> : null}
          </button>
        ))}
      </div>
    </VStack>
  )
}
