export type SettingsPage = 'general' | 'usage' | 'computers'
export function SettingsView(_: { page: SettingsPage }) {
  return <div style={{ padding: 24 }}>Settings</div>
}
