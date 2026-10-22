import { useEffect, useState } from 'react'
import { isBelow } from '@shared/compat'
import { CardForm, CardSection, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader, SheetPage } from '../../components/Overlay'
import { Text } from '../../components/Text'
import { useStore } from '../../store/context'
import { MarkdownText } from '../thread/Markdown'
import { SKILLS_HOST } from '../thread/slash-commands'
import { errorText, market } from './market-models'
import { ErrorText } from './pieces'
import { usePlugins } from './plugins'

/** The skill a details sheet shows: an installed one (`id`) or one from the catalog (`source`). */
export type SkillRef = { name: string; description: string } & ({ id: string; source?: never; installed?: never } | { source: string; installed?: boolean; id?: never })

/** A skill's details (kit `SkillSheet`): what it tells the bot, its `SKILL.md`, with Add while it isn't installed. */
export function SkillSheet({ skill }: { skill: SkillRef }) {
  const store = useStore()
  const plugins = usePlugins(store)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const which = skill.source !== undefined ? { source: skill.source } : { id: skill.id }
  const source = skill.source ?? null
  const added = source === null || skill.installed === true || plugins.installedSkills.some((s) => s.id === source.toLowerCase())
  // Older hosts list skills but can't show what's in them.
  const readable = !isBelow(store.hello?.version ?? '', SKILLS_HOST)

  useEffect(() => {
    if (!readable) return
    let live = true
    void store
      .ready()
      .then((c) => market.skillDetails(c, which))
      .then((m) => live && setMarkdown(m), (e: unknown) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [])

  const add = async () => {
    if (!source) return
    setAdding(true)
    setError(null)
    try {
      await plugins.installSkill(source)
    } catch (e) {
      setError(errorText(e))
    }
    setAdding(false)
  }

  const trailing = added ? (
    <span title="Added" aria-label="Added" className="skill-added">
      <Icon name="checkmark" size={13} weight="semibold" />
    </span>
  ) : adding ? <Spinner /> : <IconButton title="Add" icon="plus" onClick={() => void add()} />

  return (
    <SheetPage>
      <ModalHeader title={skill.name} trailing={trailing} />
      <CardForm>
        {skill.description ? (
          <CardSection>
            <Text size="subheadline" tone="secondary">{skill.description}</Text>
          </CardSection>
        ) : null}
        {readable ? (
          <CardSection title="Instructions" footer={added ? 'Bots read these before using the skill.' : 'Add it to let bots use these instructions.'}>
            {markdown ? <MarkdownText text={markdown} /> : markdown === '' ? <Text tone="secondary">No instructions.</Text> : error ? null : <Spinner />}
          </CardSection>
        ) : null}
        {error ? <CardSection><ErrorText text={error} /></CardSection> : null}
      </CardForm>
    </SheetPage>
  )
}
