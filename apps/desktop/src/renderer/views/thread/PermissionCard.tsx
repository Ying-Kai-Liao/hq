import { useState } from 'react'
import type { Entry, FileDiff, PermissionOption } from '@shared/models'
import { Disclosure } from '../../components/Controls'
import { DecisionCard, type Pair } from '../../components/kith'
import { FALLBACK_PAIR } from '../../components/kith/pair.ts'
import { Icon } from '../../components/Icon'
import { HStack, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import './permission-card.css'

/** What the agent wants, from the tool's kind (also the notch island's headline). */
export const permissionHeadline = (toolKind?: string) => {
  switch (toolKind) {
    case 'execute':
      return 'Wants to run a command'
    case 'edit':
    case 'delete':
    case 'move':
      return 'Wants to change files'
    case 'fetch':
      return 'Wants to access the web'
    case 'read':
    case 'search':
      return 'Wants to read files'
    default:
      return 'Wants to use a tool'
  }
}

const rank: Record<string, number> = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 }

/** Allow before deny, once before always. */
export const sortedOptions = (options: PermissionOption[]) => [...options].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))

export function optionLabel(o: PermissionOption) {
  switch (o.kind) {
    case 'allow_once':
      return 'Allow once'
    case 'allow_always':
      return 'Always allow'
    case 'reject_once':
      return 'Deny'
    case 'reject_always':
      return 'Never'
    default:
      return o.name
  }
}

/**
 * Approval card (the kith DecisionCard): what the agent wants, where it runs, the answers, tinted in the agent's pair.
 * `waiting`: the owner's name when this card is for them to answer (a guest's run); the buttons are theirs, not this person's.
 */
export function PermissionCard({ entry, hostName, answering, respond, waiting = null, pair = FALLBACK_PAIR }: { entry: Entry; hostName: string; answering: string | null; respond: (option: string | null) => void; waiting?: string | null; pair?: Pair }) {
  const [expanded, setExpanded] = useState(false)
  const d = entry.data
  const pending = d.status === 'pending'
  const hasDetail = !!d.command || !!d.detail || !!d.diffs?.length
  const options = sortedOptions(d.options ?? [])
  const cwd = d.cwd ? ` · ${d.cwd.split('/').filter(Boolean).pop() ?? d.cwd}` : ''
  const byKind = (kind: string) => options.find((o) => o.kind === kind)
  // Allow / Deny / Always when the host offers exactly those; any other set shows every option as its own button.
  const plain = options.length > 0 && options.every((o) => ['allow_once', 'allow_always', 'reject_once'].includes(o.kind)) && !!byKind('allow_once') && !!byKind('reject_once')
  const common = {
    pair,
    title: permissionHeadline(d.toolKind),
    subject: d.title ?? '',
    place: `Runs on ${hostName}${cwd}`,
    waiting,
    outcome: pending ? undefined : outcome(entry),
    pending: answering,
    details: hasDetail ? (
      <Disclosure expanded={expanded} onToggle={() => setExpanded((e) => !e)} label={<Text size="caption" weight="medium" tone="secondary">Details</Text>}>
        <VStack gap={8} className="permission-card-details">
          {d.command ? <CodeBox text={d.command} /> : null}
          {d.detail ? <CodeBox text={d.detail.slice(0, 2000)} /> : null}
          {(d.diffs ?? []).map((diff, i) => <DiffView key={i} diff={diff} />)}
        </VStack>
      </Disclosure>
    ) : undefined,
  }
  // answering !== null disables every button, so a double click answers once.
  return (
    <div className="agent-inset">
      {plain ? (
        <DecisionCard
          kind="permission"
          {...common}
          pending={answering !== null ? true : null}
          onAllow={() => respond(byKind('allow_once')!.optionId)}
          onDeny={() => respond(byKind('reject_once')!.optionId)}
          onAlways={byKind('allow_always') ? () => respond(byKind('allow_always')!.optionId) : undefined}
        />
      ) : (
        <DecisionCard
          kind="question"
          {...common}
          options={options.map((o) => ({ id: o.optionId, label: optionLabel(o) }))}
          onChoose={(id) => respond(id)}
        />
      )}
    </div>
  )
}

function outcome(entry: Entry) {
  const d = entry.data
  switch (d.status) {
    case 'answered': {
      const chosen = d.options?.find((o) => o.optionId === d.selected)
      switch (chosen?.kind) {
        case 'allow_once':
          return 'Allowed once'
        case 'allow_always':
          return 'Always allowed'
        case 'reject_once':
          return 'Denied'
        case 'reject_always':
          return 'Never allowed'
        default:
          return chosen?.name ?? 'Answered'
      }
    }
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Expired — the agent moved on'
  }
}

export function CodeBox({ text }: { text: string }) {
  return (
    <div className="code-box">
      <pre className="selectable code-box-text">{text}</pre>
    </div>
  )
}

export function DiffView({ diff }: { diff: FileDiff }) {
  const lines = diff.patch.split('\n').slice(0, 80)
  return (
    <VStack gap={4}>
      <HStack gap={6} className="diff-header">
        <Icon name={diff.isNew ? 'doc.badge.plus' : 'doc.text'} size={10} />
        <Text truncate grow>{diff.path.split('/').pop()}</Text>
        <Text tone="added">+{diff.added}</Text>
        <Text tone="removed">−{diff.removed}</Text>
      </HStack>
      <div className="code-box diff-box">
        <div className="code-box-text">
          {lines.map((line, i) => (
            <Text as="div" key={i} tone={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'secondary'} className="diff-line">
              {line || ' '}
            </Text>
          ))}
        </div>
      </div>
    </VStack>
  )
}
