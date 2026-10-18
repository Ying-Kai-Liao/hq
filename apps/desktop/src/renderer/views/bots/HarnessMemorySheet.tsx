import { CardForm, CardSection } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader, SheetPage } from '../../components/Overlay'
import { HStack, IconSlot, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'

/**
 * The memory screen's info button beside the harness's own memory switch: what turning it on means. The same text
 * as the kit's; the terminal UI says it short in a confirmation before turning it on. `readable`: Codync shows its
 * notes (Claude Code's are a file).
 */
export function HarnessMemorySheet({ harness, readable }: { harness: string; readable: boolean }) {
  const details = [
    { icon: 'brain', title: 'A memory of its own', detail: `${harness} keeps notes apart from Codync's memory. It's off by default, so this bot has one memory and you see and change all of it here.` },
    { icon: 'square.on.square', title: 'Remembered twice', detail: 'With both on, the bot may save the same thing twice, and the two can disagree after something changes.' },
    { icon: 'trash', title: 'Forgetting', detail: `Forgetting something here doesn't remove it from ${harness}'s notes. Codync can't change them.` },
    { icon: 'eye', title: 'Where to see it', detail: readable ? `Its notes show read-only under the ${harness} tab.` : `Codync can't show it; look in ${harness} itself.` },
  ]
  return (
    <SheetPage>
      <ModalHeader title={`${harness}'s own memory`} />
      <CardForm>
        <CardSection>
          {details.map((d) => (
            <HStack key={d.title} align="flex-start" gap={12}>
              <IconSlot width={20} tone="secondary" className="memory-info-icon">
                <Icon name={d.icon} size={15} />
              </IconSlot>
              <VStack gap={2} grow>
                <span>{d.title}</span>
                <Text size="footnote" tone="secondary">{d.detail}</Text>
              </VStack>
            </HStack>
          ))}
        </CardSection>
      </CardForm>
    </SheetPage>
  )
}
