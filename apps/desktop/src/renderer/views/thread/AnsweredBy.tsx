import { viaLabel } from '@shared/backups'
import { Text } from '../../components/Text'

/** "via codex" under a reply a backup account answered. Nothing for the agent's own account and for older messages. */
export function AnsweredBy({ answeredBy }: { answeredBy: unknown }) {
  const label = viaLabel(answeredBy)
  if (!label) return null
  return (
    <Text size="footnote" tone="tertiary" title="Answered by a backup account, because the agent's own had no usage left">
      {label}
    </Text>
  )
}
