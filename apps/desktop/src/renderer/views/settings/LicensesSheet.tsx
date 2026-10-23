import { useMemo, useState } from 'react'
import { CardForm, CardSection } from '../../components/Controls'
import { ModalHeader, SheetPage } from '../../components/Overlay'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { parseNotices, type NoticeGroup } from '@shared/notices'
// Written by scripts/notices/generate.mjs; bundled at build time so the screen works in dev and packaged alike.
import noticesMarkdown from '../../../../../../THIRD_PARTY_NOTICES.md?raw'

/** Settings → Open-source licenses: the generated third-party notices, one collapsible group per license. */
export function LicensesSheet() {
  const notices = useMemo(() => parseNotices(noticesMarkdown), [])
  return (
    <SheetPage>
      <ModalHeader title="Open-source licenses" />
      <CardForm>
        <CardSection>
          <Text size="footnote" tone="secondary" style={{ whiteSpace: 'pre-wrap' }}>{notices.intro}</Text>
        </CardSection>
        {notices.groups.map((g) => (
          <LicenseGroup key={g.license} group={g} />
        ))}
      </CardForm>
    </SheetPage>
  )
}

function LicenseGroup({ group }: { group: NoticeGroup }) {
  const [open, setOpen] = useState(false)
  const header = (
    <button key="toggle" className="settings-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      {open ? 'Hide' : 'Show'} {group.packages.length} {group.packages.length === 1 ? 'package' : 'packages'}
    </button>
  )
  return (
    <CardSection title={group.license}>
      {[
        header,
        ...(open
          ? [
              ...group.packages.map((p, i) => (
                <VStack key={`p${i}`} gap={2} className="settings-stack">
                  <span>{p.name}</span>
                  {p.details.map((d, j) => (
                    <Text key={j} size="footnote" tone="secondary" style={{ overflowWrap: 'anywhere' }}>{d}</Text>
                  ))}
                </VStack>
              )),
              ...group.texts.map((t, i) => (
                <Text key={`t${i}`} as="div" size="caption" tone="tertiary" mono style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t}</Text>
              )),
            ]
          : []),
      ]}
    </CardSection>
  )
}
