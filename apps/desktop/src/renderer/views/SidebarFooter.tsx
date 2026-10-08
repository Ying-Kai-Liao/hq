import { ProfileAvatar } from './PanelMenus'
import gmail from '../assets/gmail.png'
import calendar from '../assets/google-calendar.png'
import drive from '../assets/google-drive.png'
import './sidebar-footer.css'

/** Account and app connections float above the scrolling roster. */
export function SidebarFooter({ accountOpen, onAccount, onConnectApps }: {
  accountOpen: boolean
  onAccount: () => void
  onConnectApps: () => void
}) {
  return (
    <div className="sidebar-footer">
      <div className="sidebar-footer-fade" aria-hidden />
      <button
        className={`sidebar-account ${accountOpen ? 'active' : ''}`}
        aria-label="Open account menu for Account"
        aria-expanded={accountOpen}
        title="Account menu"
        onClick={onAccount}
      >
        <ProfileAvatar />
      </button>
      <button className="connect-apps" onClick={onConnectApps}>
        <span>Connect apps</span>
        <span className="connect-apps-logos" aria-hidden>
          {[gmail, calendar, drive].map((src) => <img key={src} src={src} alt="" draggable={false} />)}
        </span>
      </button>
    </div>
  )
}
