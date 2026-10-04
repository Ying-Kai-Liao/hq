import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isGroup, isWorkingIn, type Bot } from '@shared/models'
import { BotAvatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { MAX_FILE_SIZE, type OutgoingFile } from '../../store/bot-store'
import { attachmentSymbol } from './Attachments'

type Trailing = 'interrupt' | 'stop' | 'call' | 'send'

/**
 * The message box under a chat or a thread: send, or stop while the bot (or the group) is
 * working there. In a group, typing `@` suggests its bots.
 */
export function Composer({ botId, thread = null, onCall, onInterrupt }: {
  botId: string
  thread?: string | null
  /** Starts a voice call; while the box is empty it takes the send button's place. */
  onCall?: (() => void) | null
  /** Interrupts the bot while it is speaking in a voice call. */
  onInterrupt?: (() => void) | null
}) {
  const store = useStore()
  const bot = store.bots.get(botId) ?? null
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<OutgoingFile[]>([])
  const field = useRef<HTMLTextAreaElement>(null)
  const working = !!bot && isWorkingIn(bot, botId, thread)
  const empty = !draft.trim() && !files.length
  const canSend = !empty && (store.connection.kind === 'online' || (store.canQueue && !files.length))
  const canAttach = !!bot && !isGroup(bot)

  const placeholder = thread ? 'Reply…' : bot && isGroup(bot) ? `Message ${bot.name} · @ to ask one bot` : working ? `Queue a message for ${bot?.name ?? ''}` : `Ask ${bot?.name ?? ''}`

  // A routine's "Try it" fills the box.
  const routineDraft = store.routineDrafts.get(botId)
  useEffect(() => {
    if (thread || routineDraft === undefined) return
    setDraft((d) => (d ? `${d}\n${routineDraft}` : routineDraft))
    store.consumeRoutineDraft(botId)
    field.current?.focus()
  }, [routineDraft, thread, botId, store])

  // One to eight lines, growing with the text.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    const line = parseFloat(getComputedStyle(el).lineHeight) || 15
    el.style.height = `${Math.min(el.scrollHeight, line * 8)}px`
  }, [draft])

  const mentionQuery = (() => {
    if (!bot || !isGroup(bot)) return null
    const at = draft.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && !/\s/.test(draft[at - 1]!)) return null
    const query = draft.slice(at + 1)
    return /\n/.test(query) || query.length > 24 ? null : query
  })()
  const suggestions: Bot[] =
    mentionQuery !== null && bot ? store.members(bot).filter((m) => !mentionQuery || m.name.toLowerCase().includes(mentionQuery.toLowerCase())) : []

  const mention = (member: Bot) => {
    const at = draft.lastIndexOf('@')
    if (at < 0) return
    setDraft(`${draft.slice(0, at)}@${member.name} `)
    field.current?.focus()
  }

  const append = (incoming: { name: string; data: Uint8Array }[]) => {
    if (!canAttach) return
    const accepted: OutgoingFile[] = []
    for (const f of incoming) {
      if (f.data.length > MAX_FILE_SIZE) {
        store.setError(`${f.name} is larger than 100 MB.`)
        continue
      }
      accepted.push({ id: crypto.randomUUID(), name: f.name, data: f.data })
    }
    setFiles((list) => [...list, ...accepted])
  }

  const submit = () => {
    if (!canSend) return
    store.send(draft, botId, thread, files)
    setDraft('')
    setFiles([])
  }

  const trailing: Trailing = onInterrupt && !draft && !files.length ? 'interrupt' : working && !draft && !files.length ? 'stop' : onCall && !draft && !files.length ? 'call' : 'send'
  const [symbol, label, size] = ({
    interrupt: ['stop.fill', 'Interrupt', 12],
    stop: ['stop.fill', 'Stop', 12],
    call: ['waveform', 'Call', 15],
    send: ['arrow.up', 'Send', 14],
  } as const)[trailing]
  const fill = trailing === 'interrupt' ? 'var(--danger)' : trailing === 'send' ? (canSend ? 'var(--accent-fill)' : 'var(--accent-dim)') : 'var(--accent-fill)'
  const ink = trailing === 'interrupt' ? '#fff' : trailing === 'send' ? (canSend ? 'var(--on-accent)' : 'var(--tertiary)') : 'var(--on-accent)'
  const enabled = trailing !== 'send' || canSend

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {suggestions.length ? (
        <div className="mentions">
          {suggestions.map((m) => (
            <button key={m.id} className="press mention" onClick={() => mention(m)}>
              <BotAvatar bot={m} size={18} animated={false} />
              <span style={{ ...font('subheadline'), color: 'var(--text)' }}>{m.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="composer"
        onDragOver={(e) => {
          if (canAttach && e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!canAttach) return
          e.preventDefault()
          void Promise.all([...e.dataTransfer.files].map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))).then(append)
        }}
      >
        <div className="composer-surface">
          {files.length ? (
            <div className="file-chips">
              {files.map((f) => (
                <span key={f.id} className="file-chip">
                  <Icon name={attachmentSymbol(f.name)} size={10} color="var(--secondary)" />
                  <span style={{ ...font('footnote'), color: 'var(--text)', maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                  <button aria-label={`Remove ${f.name}`} title="Remove" style={{ display: 'flex' }} onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))}>
                    <Icon name="xmark" size={10} weight="bold" color="var(--secondary)" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="composer-box">
            {/* One capsule: attachments, the field, and send / stop / call. */}
            {canAttach ? (
              <button className="press composer-add" aria-label="Add files" title="Add files" onClick={() => void window.codync.app.pickFiles().then(append)}>
                <Icon name="plus" size={13} weight="medium" color="var(--text)" />
              </button>
            ) : null}
            <textarea
              ref={field}
              rows={1}
              value={draft}
              placeholder={placeholder}
              spellCheck
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Return sends, Shift-Return adds a line; an input method's Return picks its candidate.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  submit()
                }
              }}
              onPaste={(e) => {
                // ⌘V with a copied file or image: attach it (the field alone would paste a name).
                if (!canAttach) return
                const types = [...e.clipboardData.types]
                const hasFiles = types.includes('Files')
                if (!hasFiles || (types.includes('text/plain') && !e.clipboardData.files.length)) return
                e.preventDefault()
                void window.codync.app.readClipboardFiles().then((picked) => {
                  if (picked.length) return append(picked)
                  return Promise.all([...e.clipboardData.files].map(async (f) => ({ name: f.name || `pasted-${Date.now()}.png`, data: new Uint8Array(await f.arrayBuffer()) }))).then(append)
                })
              }}
            />
            <button
              className="press composer-send"
              disabled={!enabled}
              aria-label={label}
              title={label}
              style={{ background: fill, color: ink }}
              onClick={() => {
                if (trailing === 'interrupt') onInterrupt?.()
                else if (trailing === 'stop') store.stop(botId)
                else if (trailing === 'call') onCall?.()
                else submit()
              }}
            >
              <Icon key={symbol} name={symbol} size={size} weight="bold" className="symbol-swap" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
