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
