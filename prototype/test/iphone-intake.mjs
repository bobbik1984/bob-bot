import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Clerk } from '../clerk.mjs'
import { iphoneIntake } from '../iphone-intake.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ry-intake-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, clerk: new Clerk(dir, { serverTimezone: 'Asia/Shanghai' }) }
}

test('duplicate shares keep one receipt, one todo and one future reminder after restart', t => {
  const { dir, clerk } = fixture(t)
  const text = 'Send the revised drawing tomorrow.'
  const item = clerk.receiveCapture(text)
  assert.equal(clerk.receiveCapture(text).id, item.id)
  clerk.finishCapture(item, [{ title: 'Send the drawing', quote: 'revised drawing', due: '2099-02-01T15:00' }])
  assert.equal(clerk.todos.length, 0)
  assert.equal(clerk.jobs.length, 0)
  const review = new Clerk(dir)
  assert.equal(review.receiveCapture(text).status, 'suggested')
  assert.equal(review.suggestions.length, 1)
  const id = review.suggestions[0].id
  review.decideSuggestion(id, true)
  review.decideSuggestion(id, false)
  const saved = new Clerk(dir)
  assert.equal(saved.receiveCapture(text).status, 'done')
  assert.equal(saved.todos.length, 1)
  assert.equal(saved.jobs.length, 1)
  assert.equal(saved.jobs[0].todoId, saved.todos[0].id)
})

test('unsupported quotes save no partial tasks and ambiguous captures can be retried', t => {
  const { clerk } = fixture(t)
  const item = clerk.receiveCapture('Check the layout.')
  assert.throws(() => clerk.finishCapture(item, [
    { title: 'Check layout', quote: 'layout' }, { title: 'Call supplier', quote: 'supplier' },
  ]))
  assert.equal(clerk.todos.length, 0)
  clerk.finishCapture(item, [])
  assert.equal(item.status, 'review')
  assert.equal(clerk.retryCapture(item.id), true)
  assert.equal(item.status, 'pending')
})

test('multiple follow-ups can be dismissed and accepted independently', t => {
  const { dir, clerk } = fixture(t)
  const item = clerk.receiveCapture('Check the layout. Call the supplier.')
  clerk.finishCapture(item, [
    { title: 'Check layout', quote: 'Check the layout' },
    { title: 'Call supplier', quote: 'Call the supplier', due: '2099-04-20T10:00' },
  ])
  clerk.decideSuggestion(clerk.suggestions[1].id, false)
  assert.equal(clerk.captures[0].status, 'suggested')
  clerk.decideSuggestion(clerk.suggestions[0].id, true)
  const saved = new Clerk(dir)
  assert.deepEqual(saved.captures[0].titles, ['Check layout'])
  assert.equal(saved.todos.length, 1)
  assert.equal(saved.jobs.length, 0)
})

test('a retried chat suggestion reuses the card and remembers dismissal', t => {
  const { clerk } = fixture(t)
  const message = { at: 1, text: 'We may need a revised quote.' }
  const task = { title: 'Check quote', quote: 'revised quote' }
  const first = clerk.suggestFromChat(task, message, 'chat-one')
  assert.equal(clerk.suggestFromChat(task, message, 'chat-one').id, first.id)
  clerk.decideSuggestion(first.id, false)
  assert.equal(clerk.suggestFromChat(task, message, 'chat-one').status, 'dismissed')
  assert.equal(clerk.todos.length, 0)
  clerk.forgetChatSuggestions('chat-one')
  assert.equal(clerk.suggestions.length, 0)
})

test('intake requires its own bearer and rotating the code invalidates the previous one', t => {
  const { dir, clerk } = fixture(t)
  const intake = iphoneIntake({ dir, clerk })
  assert.equal(intake.accepts(''), false)
  const first = intake.code()
  assert.equal(intake.code(), first)
  assert.equal(intake.accepts('Bearer ' + first), true)
  const next = intake.code(true)
  assert.notEqual(first, next)
  assert.equal(intake.accepts('Bearer ' + first), false)
  assert.equal(intake.accepts('Bearer ' + next), true)
})
