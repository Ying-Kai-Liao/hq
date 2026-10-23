// Reads THIRD_PARTY_NOTICES.md (written by scripts/notices/generate.mjs) for the Open-source licenses screen.
// The format is fixed by the generator: `## <license>` opens a group, `- name version (source)` a package with
// two-space-indented detail lines under it, and a ~~~~~ fence a license text. The iOS app parses the same file
// (apps/ios/Kit/Sources/KithUI/LicensesSheet.swift): change both together.

export interface NoticePackage {
  name: string
  details: string[]
}

export interface NoticeGroup {
  license: string
  packages: NoticePackage[]
  texts: string[]
}

export interface Notices {
  intro: string
  groups: NoticeGroup[]
}

export function parseNotices(markdown: string): Notices {
  const intro: string[] = []
  const groups: NoticeGroup[] = []
  let group: NoticeGroup | null = null
  let text: string[] | null = null
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (text) {
      if (line.startsWith('~~~~~')) {
        group?.texts.push(text.join('\n'))
        text = null
      } else text.push(line)
    } else if (line.startsWith('~~~~~')) text = []
    else if (line.startsWith('## ')) {
      group = { license: line.slice(3).trim(), packages: [], texts: [] }
      groups.push(group)
    } else if (!group) {
      if (!line.startsWith('# ') && !line.startsWith('<!--')) intro.push(line)
    } else if (line.startsWith('- ')) group.packages.push({ name: line.slice(2).trim(), details: [] })
    else if (line.startsWith('  ') && group.packages.length) group.packages[group.packages.length - 1].details.push(line.trim())
  }
  return { intro: intro.join('\n').replace(/\n{3,}/g, '\n\n').trim(), groups }
}
