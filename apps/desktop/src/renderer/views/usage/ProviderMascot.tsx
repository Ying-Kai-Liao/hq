import type { UsageProvider } from '@shared/models'
import { agentIconURL, AgentIcon } from '../../components/AgentIcon'
import { CharacterAvatar, drawCharacter } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { mascotShape, providerRegistry, providerTint, providerTintCSS, tightest } from './usage-model'

/** A provider's character, with a red "!" once any of its limits is nearly used up. */
export function ProviderMascot({ provider, size, style = 'character' }: { provider: UsageProvider; size: number; style?: 'character' | 'original' }) {
  const full = (tightest(provider)?.percent ?? 0) >= 90
  if (style === 'original') {
    return (
      <span style={{ width: size, height: size, display: 'grid', placeItems: 'center', flex: 'none' }}>
        <AgentIcon registry={providerRegistry(provider.id)} size={size * 0.84} color={providerTintCSS(provider.id)} />
      </span>
    )
  }
  return (
    <span style={{ position: 'relative', width: size, height: size, flex: 'none', display: 'block' }}>
      <CharacterAvatar shape={mascotShape(provider.id)} color="" tint={providerTint(provider.id)} size={size} mood={full ? 'needsInput' : 'idle'} />
      {full ? (
        <span style={{ position: 'absolute', top: -size * 0.12, right: -size * 0.12, display: 'flex', color: 'var(--danger)', background: '#fff', borderRadius: '50%' }}>
          <Icon name="exclamationmark.circle.fill" size={size * 0.34} weight="bold" scaled={false} />
        </span>
      ) : null}
    </span>
  )
}

const loaded = new Map<string, HTMLImageElement>()

/** The mascot as a menu bar image (16 pt). Original logos load once, then appear on the next update. */
export function mascotDataURL(provider: UsageProvider, size: number, style: 'character' | 'original', dark: boolean): string | null {
  const ratio = 2
  const canvas = document.createElement('canvas')
  canvas.width = size * ratio
  canvas.height = size * ratio
  const ctx = canvas.getContext('2d')!
  ctx.scale(ratio, ratio)
  const tint = provider.id === 'claude' ? '#D97757' : dark ? '#FFFFFF' : '#000000'
  if (style === 'original') {
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
    return canvas.toDataURL('image/png')
  }
  const full = (tightest(provider)?.percent ?? 0) >= 90
  drawCharacter(ctx, { shape: mascotShape(provider.id), fill: tint, size, mood: full ? 'needsInput' : 'idle', dark, t: 0, still: true })
  if (full) {
    ctx.beginPath()
    ctx.arc(size * 0.92, size * 0.08, size * 0.17, 0, Math.PI * 2)
    ctx.fillStyle = dark ? '#F0A7A7' : '#C23A2B'
    ctx.fill()
  }
  return canvas.toDataURL('image/png')
}
