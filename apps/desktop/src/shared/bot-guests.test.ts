import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedBy, alwaysLabel, askList, botGuestsMode, botLine, cardHeading, cardOutcome, cardQuestion, inTime, parseBotGuests, parseBotRequest, pendingBots, type BotGuest } from './bot-guests.ts'
import { boardWaiting, buildBoard } from './board.ts'

const NOW = Date.parse('2026-10-25T12:00:00')
const row = (extra: Record<string, unknown> = {}) => ({
  botId: 'bg_1', name: 'Rex', provider: 'grok', state: 'pending', ownerPerson: 'sam', ownerName: 'Sam', agents: ['house', 'notes'],
  limits: { ratePerHour: 60, concurrent: 2 }, connected: false, createdAt: NOW - 3 * 3_600_000, joinedAt: null, decidedAt: null, decidedBy: null,
  lastSeenAt: null, revokedAt: null, ...extra,
})
const bot = (extra: Record<string, unknown> = {}): BotGuest => parseBotGuests({ bots: [row(extra)] })[0]!

test('rows keep nullable fields null and read unknown states as removed', () => {
  const b = bot({ ownerPerson: null, ownerName: null, state: 'weird' })
  assert.equal(b.ownerName, null)
  assert.equal(b.joinedAt, null)
  assert.equal(b.state, 'revoked')
  assert.deepEqual(parseBotGuests({}), [])
})

test('each state has its line and trailing control', () => {
  const line = (state: string, view: 'owner' | 'invitee' = 'owner', extra = {}) => botLine(bot({ state, ...extra }), view, NOW, 'the owner of Mac')
  assert.deepEqual(line('invited'), { line: 'Invite not used yet', trailing: 'cancel', emphasis: false })
  assert.equal(line('joining').trailing, 'spinner')
  assert.deepEqual(line('pending'), { line: 'Waiting for you · 3 h', trailing: 'decide', emphasis: true })
  assert.equal(line('pending', 'invitee').line, 'Waiting for the owner of Mac to allow it')
  assert.equal(line('pending', 'invitee').trailing, 'none')
  assert.equal(line('active', 'owner', { connected: true }).line, 'Asks house, notes · online now')
  assert.equal(line('active', 'owner', { lastSeenAt: NOW - 2 * 3_600_000 }).line, 'Asks house, notes · last asked 2 h ago')
  assert.equal(line('active').trailing, 'chevron')
  assert.equal(line('denied').line, 'You said no')
  assert.equal(line('denied', 'invitee').line, 'The owner of Mac said no')
  assert.equal(line('revoked', 'owner', { revokedAt: NOW - 60_000 }).line, 'Removed 1 min ago')
  assert.equal(line('revoked').trailing, 'none')
})

test('the card says whose bot, what it asks and what happened', () => {
  assert.equal(cardHeading(bot()), "Sam's bot · Grok")
  assert.equal(cardQuestion(bot()), 'Rex wants to ask house and notes')
  assert.equal(askList(['house']), 'house')
  assert.equal(askList(['house', 'notes', 'finance']), 'house, notes and finance')
  assert.equal(askList(['house', 'notes', 'a', 'b']), 'house, notes and 2 more')
  assert.equal(alwaysLabel(bot()), "Always allow Sam's bots")
  assert.equal(alwaysLabel(bot({ ownerPerson: null, ownerName: null })), null)
  assert.equal(cardOutcome('allow', true, bot()), "Allowed · Sam's bots now join on their own")
  assert.equal(cardOutcome('allow', false, bot()), 'Allowed')
  assert.equal(cardOutcome('deny', false, bot()), 'Denied')
})

test('who allowed it depends on who is looking', () => {
  assert.equal(allowedBy(bot({ decidedBy: 'kai' }), 'owner'), 'You')
  assert.equal(allowedBy(bot({ decidedBy: 'kai' }), 'invitee', 'the owner of Mac'), 'The owner of Mac')
  assert.equal(allowedBy(bot({ decidedBy: 'auto' }), 'owner'), 'Automatically')
  assert.equal(allowedBy(bot(), 'owner'), null)
})

test('owner and member see different halves; a guest none', () => {
  assert.equal(botGuestsMode('owner'), 'owner')
  assert.equal(botGuestsMode('member'), 'member')
  assert.equal(botGuestsMode('guest'), null)
})

test('expiry reads as time from now', () => {
  assert.equal(inTime(NOW + 24 * 3_600_000, NOW), 'in 24 h')
  assert.equal(inTime(NOW + 5 * 60_000, NOW), 'in 5 min')
  assert.equal(inTime(NOW - 1, NOW), 'now')
})

test('a botRequest event is always pending', () => {
  const req = parseBotRequest({ botId: 'bg_2', name: 'Rex', provider: 'grok', ownerPerson: 'sam', ownerName: 'Sam', agents: ['house'], createdAt: 5 })
  assert.equal(req?.state, 'pending')
  assert.equal(parseBotRequest({ botId: '' }), null)
})

test('waiting bots count toward the Board', () => {
  const waiting = pendingBots([bot(), bot({ botId: 'b2', state: 'active' })])
  assert.equal(waiting.length, 1)
  const board = buildBoard([{ id: 'mac', hostName: 'Mac', bots: [], entries: new Map(), botRequests: waiting }], NOW)
  assert.equal(boardWaiting(board), 1)
  assert.equal(board.needsYou[0]!.guest, true)
})
