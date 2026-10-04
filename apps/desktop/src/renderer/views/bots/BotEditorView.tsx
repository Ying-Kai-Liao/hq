import type { BotDraft } from '@shared/models'
export function BotEditorView(_: { draft: BotDraft }) {
  return <div style={{ padding: 24 }}>Bot editor</div>
}
export function BotSettingsPanel(_: { botId: string }) {
  return <div style={{ padding: 24 }}>Bot settings</div>
}
