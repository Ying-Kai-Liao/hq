/** Match the terminal roster: first nonempty line, without block/bold/code markers. */
export function messagePreview(text: string): string {
  const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  return first.replace(/^[#>\-* ]+/, '').replaceAll('**', '').replaceAll('`', '')
}
