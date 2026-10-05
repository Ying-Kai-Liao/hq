import type { Computer } from '@shared/models'
import { Icon } from '../components/Icon'
import { avatarColor } from '../lib/theme'
import linux from '../assets/computer-linux.svg'

const symbol = (device?: string | null) =>
  ({ laptop: 'laptopcomputer', macmini: 'macmini', macstudio: 'macstudio', imac: 'desktopcomputer', macpro: 'macpro.gen3' })[device ?? ''] ?? 'desktopcomputer'

/** A computer's icon showing what it is (laptop, Mac mini, Linux…), in the color picked for it. */
export function ComputerBadge({ computer, size = 36 }: { computer: Computer | null; size?: number }) {
  const color = computer?.color ? avatarColor(computer.color) : 'var(--text)'
  return (
    <span aria-hidden style={{ width: size, height: size, display: 'grid', placeItems: 'center', flex: 'none', color }}>
      {computer?.device === 'linux' ? (
        // SF Symbols has no penguin.
        <span style={{ width: size * 0.55, height: size * 0.55, backgroundColor: color, WebkitMaskImage: `url("${linux}")`, WebkitMaskSize: 'contain', WebkitMaskRepeat: 'no-repeat', WebkitMaskPosition: 'center' }} />
      ) : (
        <Icon name={symbol(computer?.device)} size={size * 0.5} weight="medium" />
      )}
    </span>
  )
}
