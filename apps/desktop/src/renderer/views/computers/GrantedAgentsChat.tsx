import { agentsWithoutChat } from '@shared/mac-role'
import { Button } from '../../components/Controls'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useStore } from '../../store/context'

/** "New chat" on a Mac that is someone else's: one chat per agent the owner gave this account. */
export function GrantedAgentsChat({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const free = agentsWithoutChat([...store.bots.values()], store.granted)
  return (
    <VStack gap={12} className="settings-invite-body">
      <Text size="headline">New chat</Text>
      {free.length === 0 ? <Text size="callout" tone="secondary">You already have a chat with every agent you can use here.</Text> : null}
      {free.map((g) => (
        <div key={g.agent} className="settings-row">
          <Text size="callout" grow>{g.name ?? g.agent}</Text>
          <Button
            kind="secondary"
            onClick={() => {
              void store.startChat(g.agent)
              onClose()
            }}
          >
            New chat
          </Button>
        </div>
      ))}
    </VStack>
  )
}
