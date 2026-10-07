import { useState } from 'react'
import { Button } from '../components/Controls'
import { Icon } from '../components/Icon'
import { ModalHeader, Sheet } from '../components/Overlay'
import { font } from '../lib/fonts'
import { useModel } from '../lib/observable'
import { prefs, usePref } from '../lib/prefs'
import { useApp } from '../store/context'
import { errorText } from './settings/parts'

const device = window.codync.platform === 'darwin' ? 'Mac' : 'computer'
/** What the answer covers; same points as the iPhone's and the terminal's question. */
const points: [icon: string, text: string][] = [
  ['eye.slash', 'Never your messages, code, files, prompts or bot names'],
  ['lock.shield', "Never sold or used for ads. Linked to your Codync account when you're signed in"],
  ['gearshape', 'Turn it off anytime in Settings'],
]
/** Read at launch: a welcome screen finished later was this launch's onboarding. */
const onboardedAtLaunch = prefs.onboardingDone.get()

/**
 * Asks this computer's owner once whether to share product analytics: after the welcome screen,
 * or on the first launch after updating. Closing without choosing asks again next launch.
 */
export function AnalyticsPrompt() {
  const app = useApp()
  const local = useModel(app.local)
  const [onboarded] = usePref(prefs.onboardingDone)
  const [closed, setClosed] = useState(false)
  const open = onboarded && !closed && local !== null && local.connection.kind === 'online' && local.analytics === null

  const choose = async (share: boolean) => {
    setClosed(true)
    if (!local) return
    try {
      await local.setAnalytics(share)
      if (share && !onboardedAtLaunch) local.track('onboarding_completed')
    } catch (e) {
      app.setError(errorText(e))
    }
  }

  return (
    <Sheet open={open} onClose={() => setClosed(true)}>
      <div style={{ width: 420, display: 'flex', flexDirection: 'column' }}>
        <ModalHeader title="Help improve Codync" />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '0 24px 24px' }}>
          <Icon name="chart.bar" size={36} weight="light" color="var(--secondary)" />
          <div style={{ ...font('callout'), color: 'var(--secondary)', textAlign: 'center' }}>
            Codync can record which features you use on this {device}, like creating a bot or sending a message.
          </div>
          <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 16, background: 'var(--surface)' }}>
            {points.map(([icon, text]) => (
              <div key={icon} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name={icon} size={13} color="var(--tertiary)" style={{ width: 18, flexShrink: 0 }} />
                <div style={{ ...font('callout'), color: 'var(--secondary)' }}>{text}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Button kind="secondary" onClick={() => void choose(false)}>
              Don't share
            </Button>
            <Button onClick={() => void choose(true)}>Share usage</Button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
