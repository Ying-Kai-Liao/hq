import { memo, type ReactNode } from 'react'
import { px } from '../../lib/fonts'

// The Mac's Markdown renderer (kit MarkdownText.swift): paragraphs, headings, lists, quotes and
// fenced code; inline styling like `AttributedString(markdown:)` (inline only, whitespace kept).

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'bullet'; text: string; marker: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; language: string }

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let code: string[] | null = null
  let language = ''
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n'), language })
        code = null
      } else {
        flush()
        code = []
        language = line.slice(3)
      }
      continue
    }
    if (code) {
      code.push(raw)
      continue
    }
    const heading = /^(#+) (.*)$/.exec(line)
    const ordered = /^(\d+\.) (.*)$/.exec(line)
    if (!line) flush()
    else if (heading) {
      flush()
      blocks.push({ kind: 'heading', text: heading[2]!.trim(), level: heading[1]!.length })
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      flush()
      blocks.push({ kind: 'bullet', text: line.slice(2), marker: '•' })
    } else if (ordered) {
      flush()
      blocks.push({ kind: 'bullet', text: ordered[2]!, marker: ordered[1]! })
    } else if (line.startsWith('> ')) {
      flush()
      blocks.push({ kind: 'quote', text: line.slice(2) })
    } else paragraph.push(raw)
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n'), language })
  flush()
  return blocks
}

/** Inline Markdown: `code`, **bold**, *italic*, ~~strike~~, [links](url). */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  // Code spans first: nothing inside them is styled.
  const parts = text.split(/(`[^`\n]+`)/)
  parts.forEach((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push(<code key={`${key}${i}`} style={{ fontFamily: 'var(--mono)', fontSize: '0.92em' }}>{part.slice(1, -1)}</code>)
    } else if (part) {
      out.push(...emphasis(part, `${key}${i}-`))
    }
  })
  return out
}

const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])/
function emphasis(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest) {
    const m = pattern.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const k = `${key}${n++}`
    if (m[1] !== undefined) {
      const url = m[2]!
      out.push(
        <a key={k} href={url} onClick={(e) => { e.preventDefault(); window.codync.app.openExternal(url) }} style={{ color: 'var(--accent)', textDecoration: 'none', cursor: 'pointer' }}>
          {emphasis(m[1], `${k}-`)}
        </a>,
      )
    } else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={k} style={{ fontWeight: 600 }}>{emphasis(m[3] ?? m[4]!, `${k}-`)}</strong>)
    else if (m[5] !== undefined) out.push(<s key={k}>{emphasis(m[5], `${k}-`)}</s>)
    else out.push(<em key={k}>{emphasis(m[6] ?? m[7]!, `${k}-`)}</em>)
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

const headingSize = (level: number) => (level === 1 ? 15 : level === 2 ? 13 : 11)

export const MarkdownText = memo(function MarkdownText({ text }: { text: string; streaming?: boolean }) {
  const blocks = parseMarkdown(text)
  return (
    <div className="markdown selectable" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'paragraph':
            return <div key={i} style={{ fontSize: 'var(--conversation)', color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{inline(b.text)}</div>
          case 'heading':
            return <div key={i} style={{ fontSize: px(headingSize(b.level)), fontWeight: b.level === 2 ? 600 : 700, color: 'var(--text)' }}>{inline(b.text)}</div>
          case 'bullet':
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--conversation)' }}>
                <span style={{ color: 'var(--secondary)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{b.marker}</span>
                <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}>{inline(b.text)}</span>
              </div>
            )
          case 'quote':
            return <div key={i} style={{ fontSize: 'var(--conversation)', color: 'var(--secondary)', paddingLeft: 10, boxShadow: 'inset 3px 0 0 var(--border)', whiteSpace: 'pre-wrap' }}>{inline(b.text)}</div>
          case 'code':
            return (
              <div key={i} style={{ background: 'var(--code-background)', borderRadius: 8, overflowX: 'auto' }}>
                <pre style={{ margin: 0, padding: 10, fontFamily: 'var(--mono)', fontSize: px(10), color: 'var(--text)', width: 'max-content' }}>{b.text}</pre>
              </div>
            )
        }
      })}
    </div>
  )
})
