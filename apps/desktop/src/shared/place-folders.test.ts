import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chipOf, needsConfirm, normalizeFolder, pickerSections, projectAt, projectIdFromName, selectionOfRecent } from './place-folders.ts'

test('a folder name becomes a lowercase-kebab project id', () => {
  assert.equal(projectIdFromName('My Project_v2'), 'my-project-v2')
  assert.equal(projectIdFromName('  --Kith App--  '), 'kith-app')
  assert.equal(projectIdFromName('Café Ünï'), 'cafe-uni')
  assert.equal(projectIdFromName('日本語'), '')
})

test('the picker lists projects first with missing ones disabled, and marks the current pick', () => {
  const projects = [
    { id: 'hq', path: '/h/hq', paths: ['/h/hq'], parent: null, exists: true },
    { id: 'old', path: null, paths: [], parent: null, exists: false },
  ]
  const recent = [{ path: '/h/x', name: 'x', project: null }, { path: '/h/hq', name: 'hq', project: 'hq' }]
  const current = { kind: 'project' as const, project: 'hq', path: '/h/hq', name: 'hq', inherited: false }
  const s = pickerSections(projects, recent, current)
  assert.deepEqual(s.projects.map((p) => [p.id, p.disabled, p.current]), [['hq', false, true], ['old', true, false]])
  assert.deepEqual(s.recent.map((r) => r.current), [false, true])
  assert.ok(pickerSections(projects, recent, { ...current, inherited: true }).projects.every((p) => !p.current), 'an inherited folder is nobody’s pick')
})

test('a recent project is picked by id, a plain folder by path', () => {
  assert.deepEqual(selectionOfRecent({ path: '/a', project: 'a' }), { project: 'a' })
  assert.deepEqual(selectionOfRecent({ path: '/a', project: null }), { folder: '/a' })
})

test('a folder is a registered project by the listing or by the registry', () => {
  const projects = [{ id: 'hq', path: '/h/hq', paths: ['/h/hq', '/v/hq'], parent: null, exists: true }]
  assert.equal(projectAt('/v/hq/', projects), 'hq')
  assert.equal(projectAt('/h/other', projects), null)
  assert.equal(projectAt('/h/other', projects, 'o'), 'o')
})

test('an older host without folder reads as absent; the chip names the place', () => {
  assert.equal(normalizeFolder(undefined), null)
  assert.equal(normalizeFolder({ kind: 'weird' }), null)
  const f = normalizeFolder({ kind: 'workspace', path: null, inherited: true })!
  assert.equal(f.name, 'Workspace')
  assert.equal(chipOf(f).icon, 'house.fill')
  assert.equal(chipOf({ kind: 'project', project: 'hq', path: '/h/hq', name: 'hq', inherited: false }).icon, 'arrow.triangle.branch')
})

test('only a place with messages asks before a fresh session', () => {
  assert.equal(needsConfirm(0), false)
  assert.equal(needsConfirm(3), true)
})
