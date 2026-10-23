import type { Usage } from '@shared/models'
import { CardSection } from '../../components/Controls'
import { Text } from '../../components/Text'
import { resetDescription, windowTitle } from '../usage/usage-model'
import './settings.css'

/** One group per provider: a row per limit with its name, "NN% · resets …" and an ink bar. Near the limit the bar stays ink. */
export function UsageLimits({ usage, computer }: { usage: Usage; computer: string | null }) {
  return (
    <>
      {usage.providers.map((provider) => (
        <CardSection key={provider.id} title={computer ? `${computer} · ${provider.name}` : provider.name}>
          {provider.windows.map((w) => {
            const percent = Math.min(100, Math.max(0, Math.round(w.percent)))
            const reset = resetDescription(w)
            return (
              <div key={w.id} className="settings-usage-row">
                <div className="settings-usage-line">
                  <Text tone="text" truncate>{windowTitle(w)}</Text>
                  <Text size="caption" tone="secondary">{reset ? `${percent}% · ${reset}` : `${percent}%`}</Text>
                </div>
                <div className="settings-usage-bar" role="progressbar" aria-label={`${windowTitle(w)} ${percent}% used`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${Math.max(2, percent)}%` }} />
                </div>
              </div>
            )
          })}
        </CardSection>
      ))}
    </>
  )
}
