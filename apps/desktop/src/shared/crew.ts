/** The crew with a face of their own (brand crew/<agent>.png, shipped in renderer/assets/crew). */
export const CREW = [
  'branding', 'builder', 'coder', 'designer', 'devops', 'finance', 'house', 'image',
  'lab', 'marketing', 'modeler', 'pemo', 'personal', 'resource-manager', 'sound', 'video',
] as const

/**
 * The crew member a bot is, by its name or id (`house`, `Resource Manager`, `hq-coder`), or null.
 * Groups never are.
 */
export function crewName(bot: { id: string; name: string; kind: string }): string | null {
  if (bot.kind === 'group') return null
  const slug = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  for (const candidate of [slug(bot.name), slug(bot.id), slug(bot.id).replace(/^hq-/, '')]) {
    if ((CREW as readonly string[]).includes(candidate)) return candidate
  }
  return null
}

/** Extra portraits anyone can pick (brand crew/spare/<name>.png, shipped in renderer/assets/spare). */
export const SPARES = ['calendar', 'chart', 'cloud', 'globe', 'gradcap', 'heart', 'laptop', 'magnifier'] as const

/** The portrait used when nothing else matches (`auto`). */
export const DEFAULT_CREW = 'builder'

export type AvatarImage = { kind: 'crew' | 'spare'; name: string }

/** The portrait a bot shows, or null for a group or a bot drawn as Codync's shape. */
export function avatarImage(bot: { id: string; name: string; kind: string; avatarSource?: string }): AvatarImage | null {
  if (bot.kind === 'group') return null
  const source = bot.avatarSource ?? 'auto'
  if (source === 'shape') return null
  const [kind, name = ''] = source.split(':')
  if (kind === 'crew' && (CREW as readonly string[]).includes(name)) return { kind, name }
  if (kind === 'spare' && (SPARES as readonly string[]).includes(name)) return { kind, name }
  // `auto`, and anything a newer host sends that this app can't draw.
  return { kind: 'crew', name: crewName(bot) ?? DEFAULT_CREW }
}
