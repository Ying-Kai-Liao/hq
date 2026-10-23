import { Fragment, useEffect, useState } from 'react'
import { islandLabel } from '@shared/island'
import { Button, CardForm, CardSection, ChoicePicker, IconButton, ProgressBar, Switch, ValueRow } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { useDismiss } from '../../components/Overlay'
import { HStack, IconSlot, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { DEFAULT_TEXT_SIZE, prefs, TEXT_SIZES, usePref } from '../../lib/prefs'
import { useAccount } from '../../store/account'
import { StoreContext, useApp } from '../../store/context'
import { ComputerBadge } from '../ComputerBadge'
import { UpdateButton, useUpdates } from '../UpdateButton'
import { ComputersView } from './ComputersView'
import { LinkChatRow } from './LinkChatRow'
import { errorText, isMac, thisMac } from './parts'
import { BackupChains } from './BackupChain'
import { UsageLimits } from './UsageLimits'
import { VoiceChatSettingsView } from './VoiceChatSettingsView'
import { ComputerAccessView } from '../computer-access/ComputerAccessView'
import { FormSheet } from '../marketplace/pieces'
import { AnalyticsSheet } from './AnalyticsSheet'
import { LicensesSheet } from './LicensesSheet'

/** The chat window's Settings: pages in a sidebar, ChatGPT's settings layout. */
export type SettingsPage = 'general' | 'computers' | 'access' | 'voice' | 'usage' | 'updates'

const thisComputer = isMac ? 'This Mac' : 'This computer'
const pages: { id: SettingsPage; title: string; label?: string; group: string; icon: string }[] = [
  { id: 'general', title: 'General', group: 'Personal', icon: 'gearshape' },
  { id: 'computers', title: 'Computers & devices', label: 'Computers', group: thisComputer, icon: 'desktopcomputer' },
  { id: 'access', title: 'Computer access', group: thisComputer, icon: 'hand.raised' },
  { id: 'voice', title: 'Voice chat', group: 'Personal', icon: 'waveform' },
  { id: 'usage', title: 'Usage', group: 'Personal', icon: 'gauge.with.dots.needle.33percent' },
  { id: 'updates', title: 'Updates', group: thisComputer, icon: 'arrow.down.circle' },
]

export function SettingsView({ page: initial }: { page: SettingsPage }) {
  // Kept here: the sheet's content doesn't follow the window's state once shown.
  const [page, setPage] = useState(initial)
  const app = useApp()
  const dismiss = useDismiss()
  const current = pages.find((p) => p.id === page)!
  return (
    <div className="settings">
      <nav className="settings-sidebar">
        {['Personal', thisComputer].map((group) => (
          <Fragment key={group}>
            <div className="settings-group">{group}</div>
            {pages.filter((p) => p.group === group).map((item) => (
              <button key={item.id} className={`settings-item ${item.id === page ? 'selected' : ''}`} aria-current={item.id === page ? 'page' : undefined} onClick={() => setPage(item.id)}>
                <IconSlot width={18} tone="secondary">
                  <Icon name={item.icon} size={13} />
                </IconSlot>
                <Text truncate grow>{item.label ?? item.title}</Text>
                {item.id === 'computers' && app.approvals.length > 0 ? (
                  <Text size="caption" weight="semibold" tone="secondary">{app.approvals.length}</Text>
                ) : null}
              </button>
            ))}
          </Fragment>
        ))}
      </nav>
      <div className="settings-divider" />
      <div className="settings-main">
        <Text as="div" size={24} weight="semibold" tone="text" className="settings-title">{current.title}</Text>
        <div key={page} className="settings-page">
          <PageContent page={page} />
        </div>
      </div>
      <span className="settings-close">
        <IconButton title="Close" icon="xmark" onClick={dismiss} />
      </span>
    </div>
  )
}

function PageContent({ page }: { page: SettingsPage }) {
  const app = useApp()
  switch (page) {
    case 'access':
      return <ComputerAccessView />
    case 'general':
      return <GeneralSettings />
    case 'computers':
      return <ComputersView />
    case 'voice':
      return app.local ? (
        <StoreContext.Provider value={app.local}>
          <VoiceChatSettingsView showsHeader={false} />
        </StoreContext.Provider>
      ) : (
        <CardForm>
          <Text tone="secondary">Voice keys are kept by {thisMac}'s host, which isn't running.</Text>
        </CardForm>
      )
    case 'usage':
      return (
        <CardForm>
          <UsageLimitsList />
          <BackupChains />
        </CardForm>
      )
    case 'updates':
      return <UpdateSettings />
  }
}

/** Account, window and app preferences. */
function GeneralSettings() {
  const account = useAccount()
  const [textSize, setTextSize] = usePref(prefs.textSize)
  const [usageIconStyle, setUsageIconStyle] = usePref(prefs.usageIconStyle)
  const [compact, setCompact] = usePref(prefs.sidebarCompact)
  const [showInDock, setShowInDock] = useState(true)
  useEffect(() => void window.kith.app.showInDock().then(setShowInDock), [])
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  useEffect(() => void window.kith.app.launchAtLogin().then(setLaunchAtLogin), [])
  const [island, setIsland] = useState(false)
  useEffect(() => void window.kith.island.enabled().then(setIsland), [])

  return (
    <CardForm>
      <CardSection title="Account" footer={account.errorMessage}>
        <div className="settings-row">
          <Icon name="person.crop.circle" size={26} color="var(--secondary)" />
          <VStack grow className="settings-stack">
            <Text truncate>
              {account.isSignedIn ? (account.user?.email ?? 'Signed in') : 'Not signed in'}
            </Text>
            <Text size="caption" tone="secondary">
              {account.isSignedIn ? 'Reach your computers from anywhere' : 'Sign in to reach your computers from anywhere'}
            </Text>
          </VStack>
          {account.isSignedIn ? (
            <Button kind="secondary" onClick={() => void account.signOut()} disabled={account.isBusy}>
              {account.isBusy ? 'Please wait…' : 'Sign out'}
            </Button>
          ) : (
            <>
              <Button kind="secondary" onClick={() => void account.signIn('apple')} disabled={account.isBusy}>
                Apple
              </Button>
              <Button kind="secondary" onClick={() => void account.signIn('google')} disabled={account.isBusy}>
                Google
              </Button>
              <Button kind="secondary" onClick={() => void account.signIn('github')} disabled={account.isBusy}>
                GitHub
              </Button>
            </>
          )}
        </div>
        <LinkChatRow />
      </CardSection>
      <CardSection title="Appearance">
        <ValueRow label="Text size">
          <ChoicePicker
            selection={textSize}
            options={TEXT_SIZES.map((s) => ({ id: s, label: s === DEFAULT_TEXT_SIZE ? `${s} pt (Default)` : `${s} pt` }))}
            onChange={setTextSize}
          />
        </ValueRow>
        <ValueRow label="Usage icons">
          <ChoicePicker selection={usageIconStyle} options={[{ id: 'character', label: 'Character' }, { id: 'original', label: 'Original' }]} onChange={setUsageIconStyle} />
        </ValueRow>
        <Switch on={compact} onChange={setCompact}>
          Compact sidebar
        </Switch>
      </CardSection>
      <CardSection title="System">
        {window.kith.platform === 'darwin' ? <Switch on={showInDock} onChange={(on) => void window.kith.app.setShowInDock(on).then(setShowInDock)}>Show in Dock</Switch> : null}
        {window.kith.island.supported ? (
          <Switch on={island} onChange={(on) => void window.kith.island.setEnabled(on).then(setIsland)}>
            {islandLabel(window.kith.platform)}
          </Switch>
        ) : null}
        <Switch on={launchAtLogin} onChange={(on) => void window.kith.app.setLaunchAtLogin(on).then(setLaunchAtLogin)}>
          Open at login
        </Switch>
      </CardSection>
      <PrivacySettings />
    </CardForm>
  )
}

/** Product analytics on this computer's host; only the computer itself may change it. */
function PrivacySettings() {
  const app = useApp()
  const local = useModel(app.local)
  const running = local !== null && local.connection.kind === 'online'
  const [about, setAbout] = useState(false)
  const setShared = (on: boolean) => void local?.setAnalytics(on).catch((e: unknown) => app.setError(errorText(e)))
  return (
    <>
      <CardSection title="Privacy" footer="Which features you use, never your messages, code or files. Helps us spot bugs sooner and make Kith better for you.">
        <HStack gap={4}>
          <span className={running ? undefined : 'settings-off'}>Share usage analytics</span>
          <IconButton title="About usage analytics" icon="info.circle" onClick={() => setAbout(true)} />
          <Switch on={local?.analytics === true} onChange={setShared} disabled={!running} label="Share usage analytics" className="settings-privacy-switch" />
        </HStack>
      </CardSection>
      <FormSheet open={about} onClose={() => setAbout(false)}>
        <AnalyticsSheet />
      </FormSheet>
    </>
  )
}

/** Every computer's usage limits, grouped by computer when there's more than one. */
function UsageLimitsList() {
  const app = useApp()
  const stores = app.computers.flatMap((c) => app.store(c.id) ?? [])
  const withUsage = stores.filter((s) => s.usage.providers.length > 0)
  if (withUsage.length === 0) return <Text tone="secondary">No usage information yet.</Text>
  return (
    <>
      {withUsage.flatMap((store) => [
        stores.length > 1 ? (
          <HStack key={`${store.computer.id}-label`} gap={6} className="settings-usage-computer">
            <ComputerBadge computer={store.computer} size={16} />
            {store.hostName}
          </HStack>
        ) : null,
        <UsageLimits key={store.computer.id} usage={store.usage} />,
      ])}
    </>
  )
}

/** The app's update check and preferences, the same as the menu bar's Updates menu. */
function UpdateSettings() {
  const updates = useUpdates()
  const [licenses, setLicenses] = useState(false)
  if (!updates) return null
  const footer = (
    <>
      {updates.supported ? null : 'Automatic updates are off until Kith publishes its own releases. '}
      <button className="settings-link" onClick={() => setLicenses(true)}>
        Open-source licenses
      </button>
    </>
  )
  const lastChecked = updates.lastCheck
    ? `Last checked ${new Date(updates.lastCheck).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : null
  return (
    <>
    <CardForm>
      <CardSection title="Kith" footer={footer}>
        {[
          <ValueRow key="version" label="Version" detail={lastChecked}>
            <HStack as="span" gap={10}>
              <span>{window.kith.appVersion}</span>
              <UpdateButton updates={updates} />
            </HStack>
          </ValueRow>,
          ...(updates.downloadPercent !== null
            ? [
                <div key="progress" className="settings-row settings-appear">
                  <ProgressBar value={updates.downloadPercent / 100} label={`Downloading Kith ${updates.availableVersion ?? ''}`} />
                </div>,
              ]
            : []),
          <Switch key="check" on={updates.autoCheck} onChange={(on) => window.kith.updates.setAutoCheck(on)} disabled={!updates.supported}>
            Automatically check for updates
          </Switch>,
          <Switch key="download" on={updates.autoDownload} onChange={(on) => window.kith.updates.setAutoDownload(on)} disabled={!updates.supported}>
            Automatically download and install
          </Switch>,
          ...(updates.error
            ? [
                <div key="error" className="settings-row settings-appear">
                  <Text tone="attention" grow>{updates.error}</Text>
                  <Button kind="secondary" onClick={() => window.kith.updates.check()} disabled={updates.checking}>
                    Retry
                  </Button>
                </div>,
              ]
            : []),
        ]}
      </CardSection>
    </CardForm>
    <FormSheet open={licenses} onClose={() => setLicenses(false)}>
      <LicensesSheet />
    </FormSheet>
    </>
  )
}
