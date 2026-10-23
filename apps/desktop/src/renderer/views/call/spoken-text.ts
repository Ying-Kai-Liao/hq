/** A chat reply as it should sound: markdown syntax and code blocks dropped (kit SpokenText). */
export function spokenText(markdown: string) {
  const rules: [RegExp, string][] = [
    [/```[\s\S]*?```/g, ''], // code blocks
    [/!?\[([^\]]*)\]\([^)]*\)/g, '$1'], // links and images → their text
    [/`([^`]*)`/g, '$1'], // inline code
    [/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, ''], // headings, quotes, list markers
    [/(\*\*|\*|~~)(\S[^\n]*?)\1/g, '$2'], // emphasis (not `_`: it's in identifiers)
    [/^[ \t]*\|?[ \t:|-]{3,}\|?[ \t]*$/gm, ''], // table rules
    [/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, ''], // table edges
    [/[ \t]*\|[ \t]*/g, ', '], // table cells
    [/\n{2,}/g, '\n'],
  ]
  let text = markdown
  for (const [pattern, template] of rules) text = text.replace(pattern, template)
  return text.trim()
}
