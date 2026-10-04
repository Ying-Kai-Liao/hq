export function CallView(_: { botId: string; onSpeaking: (s: boolean) => void; interrupt: { current: (() => void) | null }; onEnd: () => void }) {
  return <div>Call</div>
}
