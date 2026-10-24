import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startsNewTask, TaskRoutes } from './task-routing.ts'

const base = { requested: false, thread: null, left: false, currentOpen: true as boolean | null }

test('an open current task is gone on with', () => {
  assert.equal(startsNewTask(base), false)
})
test('a chat without a task is not a new task by this rule', () => {
  assert.equal(startsNewTask({ ...base, currentOpen: null }), false)
})
test('a folded current task starts a new one', () => {
  assert.equal(startsNewTask({ ...base, currentOpen: false }), true)
})
test('leaving a thread starts a new task', () => {
  assert.equal(startsNewTask({ ...base, left: true }), true)
})
test('asking for a new task always starts one', () => {
  assert.equal(startsNewTask({ ...base, requested: true }), true)
  assert.equal(startsNewTask({ ...base, requested: true, thread: 't' }), true)
})
test('inside a thread a send stays in it', () => {
  assert.equal(startsNewTask({ ...base, thread: 't', left: true, currentOpen: false }), false)
})
test('routes remember leaving and staying, and notify', () => {
  const r = new TaskRoutes()
  let n = 0
  r.subscribe(() => n++)
  r.leave('b')
  r.leave('b')
  assert.equal(r.hasLeft('b'), true)
  assert.equal(n, 1)
  r.stay('b')
  assert.equal(r.hasLeft('b'), false)
  r.choose('t', false)
  assert.equal(r.choices.get('t'), false)
  assert.equal(n, 3)
})
