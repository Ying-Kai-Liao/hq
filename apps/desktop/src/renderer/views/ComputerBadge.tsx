import type { Computer } from '@shared/models'
import { Icon } from '../components/Icon'
import linux from '../assets/computer-linux.svg'
import './computer-badge.css'

/** The colours a computer can be given (its own list, unrelated to the bots' palette). */
const COMPUTER_COLORS: Record<string, string> = {
  black: '#2B2B2B', brown: '#936439', red: '#FF263C', orange: '#FF6700', yellow: '#FF9800', green: '#00C972',
  cyan: '#00BCA6', blue: '#1084FE', violet: '#9159FE', magenta: '#FF309B', gray: '#777777',
}

const symbol = (device?: string | null) =>
  ({ laptop: 'laptopcomputer', macmini: 'macmini', macstudio: 'macstudio', imac: 'desktopcomputer', macpro: 'macpro.gen3' })[device ?? ''] ?? 'desktopcomputer'

/** A computer's icon showing what it is (laptop, Mac mini, Linux…), in the color picked for it. */
export function ComputerBadge({ computer, size = 36 }: { computer: Computer | null; size?: number }) {
  const color = (computer?.color && COMPUTER_COLORS[computer.color]) || 'var(--text)'
  return (
    <span aria-hidden className="computer-badge" style={{ width: size, height: size, color }}>
      {computer?.device === 'linux' ? (
        // SF Symbols has no penguin.
        <span className="computer-badge-linux" style={{ width: size * 0.55, height: size * 0.55, backgroundColor: color, WebkitMaskImage: `url("${linux}")` }} />
      ) : (
        <Icon name={symbol(computer?.device)} size={size * 0.5} weight="medium" />
      )}
    </span>
  )
}
