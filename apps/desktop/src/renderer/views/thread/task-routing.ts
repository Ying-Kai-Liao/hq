// Where a main-chat message goes: the host's `continued` puts any message without `newTask` into the current task
// while it works or is under ten minutes idle. So the composer decides here, from what the reader sees, whether the
// message starts a task of its own. Same rule as iOS (`BotStore.startsNewTask`).
import type { Bot, Entry } from '../../../shared/models.ts'
import { currentTask, taskLastAt, taskOpen, taskStatus } from '../../../shared/tasks.ts'

/**
 * Whether a send starts a new task: asked for, or (main chat only) the reader is out of the current task, because
 * they left its thread or it is folded. `currentOpen` is null when the chat has no task yet.
 */
export function startsNewTask(o: { requested: boolean; thread: string | null; left: boolean; currentOpen: boolean | null }): boolean {
  if (o.requested) return true
  if (o.thread) return false
  return o.left || o.currentOpen === false
}

/** Whether the chat's current task shows open in the main chat (a task waiting on a question does); null without one. */
export function currentTaskOpen(bot: Bot, chat: Entry[], replies: (rootId: string) => Entry[], now: number, choice: (id: string) => boolean | undefined): boolean | null {
  const root = currentTask(chat)
  if (!root) return null
  return taskOpen(taskStatus(bot, root, replies(root.id)), true, taskLastAt(root), now, choice(root.id))
}

/**
 * What the reader did to the tasks of one computer's chats, on this device: which they opened or folded, and the bots
 * whose thread they just left. It lives outside the views so the transcript and the composer agree.
 */
export class TaskRoutes {
  readonly choices = new Map<string, boolean>()
  private readonly left = new Set<string>()
  version = 0
  private readonly listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getVersion = () => this.version
  private changed() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  choose(taskId: string, open: boolean) {
    this.choices.set(taskId, open)
    this.changed()
  }
  hasLeft(botId: string) {
    return this.left.has(botId)
  }
  /** The reader is out of a thread, back in the main chat. */
  leave(botId: string) {
    if (this.left.has(botId)) return
    this.left.add(botId)
    this.changed()
  }
  /** The reader is back in the current task (or sent a message): the main chat goes on with it again. */
  stay(botId: string) {
    if (this.left.delete(botId)) this.changed()
  }
}

const routes = new WeakMap<object, TaskRoutes>()
/** The routes of a store (one per computer). */
export function routesOf(store: object): TaskRoutes {
  let r = routes.get(store)
  if (!r) routes.set(store, (r = new TaskRoutes()))
  return r
}
