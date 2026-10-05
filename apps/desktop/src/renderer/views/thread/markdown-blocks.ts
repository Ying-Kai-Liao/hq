// Block-level Markdown as replies use it (kit MarkdownBlocks): paragraphs, headings, nested
// lists, quotes, rules, tables and fenced code. Pure parsing, tested on its own.

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

