/** The crew with a face of their own (brand crew/<agent>.png, shipped in renderer/assets/crew). */
export const CREW = [
  'branding', 'builder', 'coder', 'designer', 'devops', 'finance', 'house', 'image',
  'lab', 'marketing', 'modeler', 'pemo', 'personal', 'resource-manager', 'sound', 'video',
] as const

/**
 * The crew member a bot is, by its name or id (`house`, `Resource Manager`, `hq-coder`), or null.
 * Groups never are. Bots made by the user keep the dotted character avatar.
 */
export function crewName(bot: { id: string; name: string; kind: string }): string | null {
  if (bot.kind === 'group') return null
  const slug = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  for (const candidate of [slug(bot.name), slug(bot.id), slug(bot.id).replace(/^hq-/, '')]) {
    if ((CREW as readonly string[]).includes(candidate)) return candidate
  }
  return null
}
