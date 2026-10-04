import { Icon } from '../../components/Icon'

/**
 * The chat's one circular surface (floating chevrons, inspector actions, Jump to latest):
 * a directional arrow nudges toward `direction` on hover and press; pressing scales to 94%.
 */
export function MacChatButton({ title, icon, onClick, direction = [0, 0], size = 32, className }: {
  title: string
  icon: string
  onClick: () => void
  direction?: [number, number]
  size?: number
  className?: string
}) {
  return (
    <button
      className={`mac-chat-button ${className ?? ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{ width: size, height: size, ['--dx' as string]: direction[0], ['--dy' as string]: direction[1] }}
    >
      <Icon name={icon} size={size / 2} weight="medium" />
    </button>
  )
}
