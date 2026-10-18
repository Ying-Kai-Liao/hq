import { useState } from 'react'
import { Button } from '../components/Controls'
import { Icon } from '../components/Icon'
import { ModalHeader, Sheet } from '../components/Overlay'
import { HStack, VStack } from '../components/Stack'
import { Text } from '../components/Text'
import { useModel } from '../lib/observable'
import { prefs, usePref } from '../lib/prefs'
import { afterStarAsk, dueStarAsk } from '../lib/star-ask'
import { useApp } from '../store/context'

const REPO = 'https://github.com/leepokai/Codync'

const copy = {
  first: {
    title: 'Star Codync on GitHub',
    message: 'Codync is free and open source. A star on GitHub is how other people find it.',
  },
  second: {
    title: 'Enjoying Codync?',
    message: "You've been using Codync for a while. If it saves you trips to your desk, a star on GitHub helps other people find it.",
  },
}

/**
 * Asks for a GitHub star twice at most: once after setup, and once more a week later.
 * Starring ends it.
 */
export function StarPrompt() {
  const app = useApp()
  const local = useModel(app.local)
  const [onboarded] = usePref(prefs.onboardingDone)
  const [state, setState] = usePref(prefs.starAsk)
  const [closed, setClosed] = useState(false)
  const due = dueStarAsk(state, Date.now())
  const open = due !== null && onboarded && !closed && local?.connection.kind === 'online'

  const finish = (starred: boolean) => {
    if (closed) return
    setClosed(true)
    setState(afterStarAsk(state, starred, Date.now()))
    if (starred) window.codync.app.openExternal(REPO)
  }

  const text = copy[due ?? 'first']
  return (
    <Sheet open={open} onClose={() => finish(false)}>
      <VStack className="star-prompt">
        <ModalHeader title={text.title} />
        <VStack align="center" gap={16} className="star-prompt-body">
          <Icon name="star" size={36} weight="light" color="var(--secondary)" />
          <Text as="div" size="callout" tone="secondary" className="star-prompt-message">{text.message}</Text>
          <HStack align="stretch" gap={12}>
            <Button kind="secondary" onClick={() => finish(false)}>
              Not now
            </Button>
            <Button onClick={() => finish(true)}>Star on GitHub</Button>
          </HStack>
        </VStack>
      </VStack>
    </Sheet>
  )
}
