// Pure logic for choosing the folder a place (a bot's chat, a thread, a task) works in.
// The wire contract is serve/docs/place-folders.md.

/** Where a place works. `folder` is absent from a host that predates place folders. */
export interface PlaceFolder {
  kind: 'project' | 'folder' | 'workspace'
  project?: string
  path: string | null
  name: string
  inherited: boolean
  missing?: boolean
}

/** One entry of Kith's project registry (`projects`). */
export interface ProjectInfo {
  id: string
  path: string | null
  paths: string[]
  parent: string | null
  exists: boolean
}

export interface RecentFolder {
  path: string
  name: string
  project: string | null
}

/** What a picker hands back: exactly one of these goes to `setPlaceFolder` / `send`. */
export type StartingFolder = { project: string } | { folder: string }
export type PlaceSelection = StartingFolder | { clear: true }

/** Lenient read of a host's `folder`: anything unusable is absent, which hides the header chip. */
export function normalizeFolder(raw: unknown): PlaceFolder | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Partial<PlaceFolder>
  if (f.kind !== 'project' && f.kind !== 'folder' && f.kind !== 'workspace') return null
  return {
    kind: f.kind,
    ...(f.project ? { project: f.project } : {}),
    path: f.path ?? null,
    name: f.name ?? (f.kind === 'workspace' ? 'Workspace' : (f.path ?? '').split('/').filter(Boolean).pop() ?? ''),
    inherited: f.inherited ?? false,
    ...(f.missing ? { missing: true } : {}),
  }
}

/** `My Project_v2` -> `my-project-v2`: lowercase words joined by single dashes, as `kith project add` wants. */
export function projectIdFromName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const isProjectId = (id: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)

export const lastComponent = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** The registered project whose folder is `path`, if any (the listing's own `project` wins). */
export function projectAt(path: string, projects: ProjectInfo[], listed: string | null = null): string | null {
  if (listed) return listed
  const clean = path.replace(/\/+$/, '')
  return projects.find((p) => (p.path ?? '').replace(/\/+$/, '') === clean || p.paths.some((q) => q.replace(/\/+$/, '') === clean))?.id ?? null
}

export interface PickerSections {
  projects: { id: string; path: string | null; disabled: boolean; current: boolean }[]
  recent: { path: string; name: string; project: string | null; current: boolean }[]
}

/** The picker's lists in order: hq projects (missing ones dimmed), then recent folders. */
export function pickerSections(projects: ProjectInfo[], recent: RecentFolder[], current: PlaceFolder | null): PickerSections {
  return {
    projects: projects.map((p) => ({
      id: p.id,
      path: p.path,
      disabled: !p.exists,
      current: !current?.inherited && current?.kind === 'project' && current.project === p.id,
    })),
    recent: recent.map((r) => ({
      ...r,
      current: !current?.inherited && !!current && current.path === r.path,
    })),
  }
}

/** The selection for a recent folder: its project when it is one. */
export const selectionOfRecent = (r: { path: string; project: string | null }): PlaceSelection => (r.project ? { project: r.project } : { folder: r.path })

/** A short line for the header chip, and its icon. */
export function chipOf(folder: PlaceFolder) {
  return {
    label: folder.name,
    icon: folder.kind === 'project' ? 'arrow.triangle.branch' : folder.kind === 'folder' ? 'folder' : 'house.fill',
    title: folder.path ?? folder.name,
  }
}

/** Changing the folder starts a fresh session; only worth a confirm when there is a conversation to lose. */
export const needsConfirm = (messages: number) => messages > 0

/**
 * Where a new task of this bot starts when nothing is picked: its default project, else its own folder or
 * workspace. Not the chat's current folder, which a pick on the chat may have changed.
 */
export function defaultFolderOf(bot: { folder: PlaceFolder | null; project: string | null; cwd: string; managedWorkspace: boolean }): PlaceFolder | null {
  // A host without place folders sends none; then there is nothing to show.
  if (!bot.folder) return null
  if (bot.project) return { kind: 'project', project: bot.project, path: null, name: bot.project, inherited: true }
  if (bot.managedWorkspace || !bot.cwd) return { kind: 'workspace', path: null, name: 'Workspace', inherited: true }
  return { kind: 'folder', path: bot.cwd, name: lastComponent(bot.cwd), inherited: true }
}
