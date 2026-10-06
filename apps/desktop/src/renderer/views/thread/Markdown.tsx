import { memo, type ReactNode } from 'react'
import { parseMarkdown, type Block } from './markdown-blocks.ts'

// The Mac's Markdown for messages: the blocks from `markdown-blocks.ts`, with inline styling like
// `AttributedString(markdown:)`.

/** Inline Markdown: `code` (tinted), **bold**, *italic*, ~~strike~~, [links](url). */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  // Code spans first: nothing inside them is styled.
  text.split(/(`[^`\n]+`)/).forEach((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code key={`${key}${i}`} style={{ fontFamily: 'var(--mono)', background: 'rgba(var(--text-rgb), 0.08)' }}>
          {part.slice(1, -1)}
        </code>,
      )
    } else if (part) out.push(...emphasis(part, `${key}${i}-`))
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
/**
 * SwiftUI's `.lineSpacing(4 * scale)`: four points between lines on top of the font's own, none
 * above the first or below the last (the negative margins take the half-leading back).
 */
const lineHeight = 'calc(1.2em + 4px * var(--md-scale))'
const spaced: React.CSSProperties = { lineHeight, margin: 'calc(-2px * var(--md-scale)) 0' }
const text: React.CSSProperties = { color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...spaced }

const MarkdownBlock = memo(function MarkdownBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'paragraph':
      return <div style={{ ...text, fontSize: 'var(--conversation)' }}>{inline(block.text)}</div>
    case 'heading':
      return (
        <div style={{ ...text, fontSize: `calc(${headingSize(block.level)}px * var(--md-scale))`, fontWeight: block.level === 2 ? 600 : 700 }}>
          {inline(block.text)}
        </div>
      )
    case 'bullet':
      return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--conversation)', paddingLeft: block.depth * 16, ...spaced }}>
          <span style={{ color: 'var(--secondary)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{block.marker}</span>
          <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}>{inline(block.text)}</span>
        </div>
      )
    case 'rule':
      return <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
    case 'table': {
      const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length))
      const cols = Array.from({ length: columns }, (_, i) => i)
      return (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, max-content)`, columnGap: 16, rowGap: 7, fontSize: 'var(--conversation)', color: 'var(--text)', padding: '2px 0', width: 'max-content', lineHeight }}>
            {cols.map((i) => (
              <span key={`h${i}`} style={{ fontWeight: 600 }}>{inline(block.header[i] ?? '', `h${i}`)}</span>
            ))}
            {block.rows.map((row, r) => [
              <div key={`l${r}`} style={{ gridColumn: `1 / span ${columns}`, height: 1, background: 'var(--border)' }} />,
              ...cols.map((i) => <span key={`${r}-${i}`}>{inline(row[i] ?? '', `${r}-${i}`)}</span>),
            ])}
          </div>
        </div>
      )
    }
    case 'quote':
      return <div style={{ ...text, fontSize: 'var(--conversation)', color: 'var(--secondary)', paddingLeft: 10, boxShadow: 'inset 3px 0 0 var(--border)' }}>{inline(block.text)}</div>
    case 'code':
      return (
        <div style={{ background: 'var(--code-background)', borderRadius: 8, overflowX: 'auto' }}>
          <pre style={{ margin: 0, padding: 10, fontFamily: 'var(--mono)', fontSize: 'calc(10px * var(--md-scale))', color: 'var(--text)', width: 'max-content', lineHeight }}>{block.text}</pre>
        </div>
      )
  }
}, (a, b) => JSON.stringify(a.block) === JSON.stringify(b.block))

/** The desktop's Markdown for messages; a block that didn't change keeps its rendering. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className="markdown selectable" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {blocks.map((b, i) => (
        <MarkdownBlock key={i} block={b} />
      ))}
    </div>
  )
})
