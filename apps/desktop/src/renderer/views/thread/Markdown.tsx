import { memo, type ReactNode } from 'react'

// Block-level Markdown as replies use it (kit MarkdownBlocks): paragraphs, headings, nested
// lists, quotes, rules, tables and fenced code; inline styling like `AttributedString(markdown:)`.

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'bullet'; text: string; marker: string; depth: number }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' }

const isTableRule = (line: string) => line.includes('-') && [...line].every((c) => '|-: '.includes(c))
const cells = (line: string) => {
  let row = line
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map((c) => c.trim())
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let table: string[] = []
  let code: string[] | null = null
  let language = ''
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
      paragraph = []
    }
    if (table.length) {
      // A header and its `|---|` line make a table; anything less stays text.
      if (table.length >= 2 && isTableRule(table[1]!)) blocks.push({ kind: 'table', header: cells(table[0]!), rows: table.slice(2).map(cells) })
      else blocks.push({ kind: 'paragraph', text: table.join('\n') })
      table = []
    }
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
    if (line.startsWith('|')) {
      if (paragraph.length) flush()
      table.push(line)
      continue
    }
    if (table.length) flush()
    const depth = Math.min(Math.floor((/^[ \t]*/.exec(raw)?.[0].length ?? 0) / 2), 3)
    const heading = /^(#+) (.*)$/.exec(line)
    const ordered = /^(\d+\.) (.*)$/.exec(line)
    if (!line) flush()
    else if (line === '---' || line === '***' || line === '___') {
      flush()
      blocks.push({ kind: 'rule' })
    } else if (heading) {
      flush()
      blocks.push({ kind: 'heading', text: heading[2]!.trim(), level: heading[1]!.length })
    } else if (/^[-*+•] /.test(line)) {
      flush()
      blocks.push({ kind: 'bullet', text: line.slice(2), marker: depth > 0 ? '◦' : '•', depth })
    } else if (ordered) {
      flush()
      blocks.push({ kind: 'bullet', text: ordered[2]!, marker: ordered[1]!, depth })
    } else if (line.startsWith('>')) {
      flush()
      blocks.push({ kind: 'quote', text: line.slice(1).trim() })
    } else paragraph.push(raw)
  }
  if (code) blocks.push({ kind: 'code', text: (code as string[]).join('\n'), language })
  flush()
  return blocks
}

/** Closes the inline markers left open at the end of text being written. */
export function heal(text: string): string {
  let t = text
  // A link still being typed shows as its label: `[label](partial` or `[label`.
  const open = t.lastIndexOf('[')
  if (open >= 0) {
    const rest = t.slice(open + 1)
    const close = rest.indexOf(']')
    if (close >= 0) {
      const after = rest.slice(close + 1)
      if (after.startsWith('(') && !after.includes(')')) t = t.slice(0, open) + rest.slice(0, close)
    } else if (!rest.includes('\n') && rest.length < 120) {
      t = t.slice(0, open) + rest
    }
  }
  if ([...t].filter((c) => c === '`').length % 2 === 1) t += '`'
  // Outside inline code only.
  const plain = t.split('`').filter((_, i) => i % 2 === 0).join('')
  for (const marker of ['**', '~~']) if (plain.split(marker).length % 2 === 0) t += marker
  return t
}

/** Blocks of `source`; while `streaming`, the last one is healed so half-written syntax doesn't flash. */
export function parseStreaming(source: string, streaming: boolean): Block[] {
  const blocks = parseMarkdown(source)
  const last = blocks[blocks.length - 1]
  if (streaming && last && 'text' in last && last.kind !== 'code') blocks[blocks.length - 1] = { ...last, text: heal(last.text) }
  return blocks
}

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

/**
 * The Mac's Markdown for messages. Completed blocks keep their rendering while text streams;
 * only the block being written renders again.
 */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseStreaming(text, streaming)
  return (
    <div className="markdown selectable" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {blocks.map((b, i) => (
        <MarkdownBlock key={i} block={b} />
      ))}
    </div>
  )
})
