import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Clerk } from '../clerk.mjs'

test('capture, recall after restart, grouped local review and opt out', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-thought-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = Date.parse('2026-12-31T15:58:00Z') // 23:58 in Shanghai
  const tomorrow = Date.parse('2027-01-01T01:00:00Z')
  const open = () => new Clerk(dir, { serverTimezone: 'Asia/Shanghai' })
  let clerk = open()
  const save = (quote, options = {}) => clerk.saveThought({ cid: 'chat-a', source: { at: now, text: quote }, quote, ...options }, now)
  const first = save('屋角值得留一点空白。')
  assert.equal(first.due, tomorrow)
  assert.deepEqual(save(first.text), first)
  const second = save('植物也可以移到那里。')
  const quiet = save('先放在这里。', { quiet: true })
  assert.equal(quiet.due, null)
  const explicit = save('下周再看。', { reviewAt: '2027-01-04T14:00' })
  assert.equal(explicit.due, Date.parse('2027-01-04T06:00:00Z'))
  assert.throws(() => save('不是原话', { source: { at: now, text: '别的文字' } }), /QUOTE_USER_THOUGHT/)
  assert.throws(() => save('时间已过', { reviewAt: '2026-12-30T12:00' }), /REVIEW_IN_PAST/)
  const removed = save('取消这一条。')
  clerk.removeThought(removed.id)
  clerk = open()
  assert.equal(clerk.thoughts.length, 4)
  assert.equal(clerk.takeThoughtReview(tomorrow - 1), null)
  const entry = clerk.takeThoughtReview(tomorrow + 3600000)
  assert.deepEqual(entry.thoughtIds, [first.id, second.id])
  assert.equal(entry.text, first.text + '\n\n' + second.text)
  assert.equal(open().takeThoughtReview(tomorrow + 7200000), null)
  // Restart between writing the inbox and saving reviewedAt.
  const file = path.join(dir, 'clerk.json')
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const item of snapshot.thoughts) item.reviewedAt = null
  fs.writeFileSync(file, JSON.stringify(snapshot))
  clerk = open()
  assert.equal(clerk.takeThoughtReview(tomorrow + 7200000), null)
  assert.equal(open().inbox.length, 1)
  assert.equal(open().thoughts.find(item => item.id === first.id).reviewedAt, entry.at)
  assert.equal(clerk.todos.length, 0)
})
