import type { UsageProvider } from '@shared/models'
import { agentIconURL, AgentIcon } from '../../components/AgentIcon'
import { Icon } from '../../components/Icon'
import { HStack } from '../../components/Stack'
import { palette } from '../../lib/theme'
import { providerRegistry, providerTintCSS, tightest } from './usage-model'
import './usage.css'

/**
 * A provider's logo, with a red "!" once any of its limits is nearly used up. Both icon styles show the
 * logo now (the dot character is gone); the setting stays for the menu bar and the island.
 */
export function ProviderMascot({ provider, size }: { provider: UsageProvider; size: number; style?: 'character' | 'original' }) {
  const full = (tightest(provider)?.percent ?? 0) >= 90
  return (
    <span className="usage-mascot" style={{ width: size, height: size }}>
      <span className="usage-mascot-logo" style={{ width: size, height: size }}>
        <AgentIcon registry={providerRegistry(provider.id)} size={size * 0.84} color={providerTintCSS(provider.id)} />
      </span>
      {full ? (
        <HStack as="span" align="stretch" className="usage-mascot-alert" style={{ top: -size * 0.12, right: -size * 0.12 }}>
          <Icon name="exclamationmark.circle.fill" size={size * 0.34} weight="bold" scaled={false} />
        </HStack>
      ) : null}
    </span>
  )
}

const loaded = new Map<string, HTMLImageElement>()

/** The logo as a menu bar image (16 pt). Original logos load once, then appear on the next update. */
export function mascotDataURL(provider: UsageProvider, size: number, _style: 'character' | 'original', dark: boolean): string | null {
  const ratio = 2
  const canvas = document.createElement('canvas')
  canvas.width = size * ratio
  canvas.height = size * ratio
  const ctx = canvas.getContext('2d')!
  ctx.scale(ratio, ratio)
  const tint = provider.id === 'claude' ? '#D97757' : dark ? '#FFFFFF' : '#000000'
  const url = agentIconURL(providerRegistry(provider.id))
  if (!url) return null
  const image = loaded.get(url)
  if (!image) {
    const img = new Image()
    img.src = url
    img.onload = () => loaded.set(url, img)
    return null
  }
  const inset = size * 0.08
  ctx.drawImage(image, inset, inset, size - inset * 2, size - inset * 2)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = tint
  ctx.fillRect(0, 0, size, size)
  if ((tightest(provider)?.percent ?? 0) >= 90) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.beginPath()
    ctx.arc(size * 0.92, size * 0.08, size * 0.17, 0, Math.PI * 2)
    ctx.fillStyle = palette(dark).danger
    ctx.fill()
  }
  return canvas.toDataURL('image/png')
}
