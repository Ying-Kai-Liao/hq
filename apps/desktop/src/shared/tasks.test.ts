import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeBot, type Entry } from './models.ts'
import { TASK_IDLE_MS, chatAndTasks, currentTask, taskOpen, taskStatus, taskTitle } from './tasks.ts'

const entry = (id: string, kind: string, data: Entry['data'], threadId: string | null = null): Entry =>
  ({ id, seq: 0, botId: 'b', threadId, rev: 1, kind, turn: 1, data, createdAt: 0, updatedAt: 0 })

test('the newest task is the current one; a plain message or a thread reply is no task', () => {
  const a = entry('a', 'user', { text: 'fix the build', task: true })
  const b = entry('b', 'user', { text: 'and the docs', task: true })
  assert.equal(currentTask([a, b, entry('n', 'notice', { text: 'Routine ran' })])?.id, 'b')
  assert.equal(currentTask([entry('u', 'user', { text: 'before tasks' })]), null)
  assert.equal(currentTask([entry('r', 'user', { task: true }, 'a')]), null)
})

test('a task is working, waiting on the user, stopped or done', () => {
  const root = entry('t', 'user', { text: 'deploy', task: true })
  const working = normalizeBot({ id: 'b', workingLanes: [{ chat: 'b', thread: 't' }] })
  const idle = normalizeBot({ id: 'b', workingLanes: [] })
  assert.equal(taskStatus(working, root, []), 'working')
  assert.equal(taskStatus(working, root, [entry('p', 'permission', { status: 'pending' }, 't')]), 'needsYou')
  assert.equal(taskStatus(idle, root, [entry('s', 'notice', { text: 'Stopped.' }, 't')]), 'stopped')
  assert.equal(taskStatus(idle, root, [entry('s', 'notice', { text: 'Stopped.' }, 't'), entry('r', 'agent', { final: true }, 't')]), 'done')
  assert.equal(taskStatus(idle, root, []), 'done')
})

test('a finished task takes the host\'s status, and an older host falls back to the thread', () => {
  const idle = normalizeBot({ id: 'b', workingLanes: [] })
  const thread = (status?: string) => entry('t', 'user', { text: 'deploy', task: true, thread: { count: 1, lastAt: 1, authors: [], status } })
  const failedNotice = [entry('f', 'notice', { text: 'The agent failed: boom' }, 't')]
  assert.equal(taskStatus(idle, thread('failed'), []), 'failed')
  assert.equal(taskStatus(idle, thread('stopped'), []), 'stopped')
  assert.equal(taskStatus(idle, thread('done'), failedNotice), 'done')
  assert.equal(taskStatus(idle, thread(), failedNotice), 'done', 'no status: today\'s derivation')
  assert.equal(taskStatus(idle, thread('working'), []), 'done', 'a stale working is not taken')
})

test('a task shows inline while busy and while the newest is fresh; the user can open or fold any', () => {
  const now = 100 * TASK_IDLE_MS
  assert.ok(taskOpen('done', true, now - 60_000, now))
  assert.ok(!taskOpen('done', true, now - TASK_IDLE_MS, now), 'ten quiet minutes fold it')
  assert.ok(!taskOpen('done', false, now - 60_000, now), 'an older task is a card')
  assert.ok(taskOpen('working', false, now - 5 * TASK_IDLE_MS, now), 'a working task stays open')
  assert.ok(taskOpen('needsYou', false, 0, now))
  assert.ok(!taskOpen('working', true, now, now, false), 'folded by hand')
  assert.ok(taskOpen('done', false, 0, now, true), 'opened by hand')
})

test('a voice call follows the chat and its tasks, not other threads', () => {
  const task = entry('t', 'user', { text: 'deploy', task: true })
  const plain = entry('p', 'agent', { text: 'hello' })
  const all = [plain, task, entry('a', 'agent', { final: true }, 't'), entry('x', 'agent', { final: true }, 'p')]
  assert.deepEqual(chatAndTasks(all).map((e) => e.id), ['p', 't', 'a'])
})

test('a card is titled by its first message on one line', () => {
  assert.equal(taskTitle(entry('t', 'user', { text: '  fix\nthe   build ', task: true })), 'fix the build')
  assert.equal(taskTitle(entry('t', 'user', { task: true })), 'Task')
})
