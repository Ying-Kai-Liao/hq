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
            Codync can record which features you use on this {device}, like creating a bot or sending a message. It never collects your messages, code, files, prompts or bot names. Your data stays private: it's used only to understand how people use Codync, never sold and never used for ads. When you're signed in, it's linked to your Codync account. You can turn this off anytime in Settings.
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
