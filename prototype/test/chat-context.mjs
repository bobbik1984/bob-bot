import assert from 'node:assert/strict'
import test from 'node:test'
import { chatSeed, foldEvicted, needsCompaction } from '../chat-context.mjs'

const message = (text, at, role = 'user') => ({ type: 'message', role, text, at })

test('a long thread keeps the relevant older decision and the newest correction within budget', () => {
  const history = [message('丹桂品牌要求周五前提供报价，原预算三万。', 1)]
  for (let i = 0; i < 100; i++) history.push(message(('无关话题' + i).repeat(40), i + 2, 'assistant'))
  history.push(message('更正：丹桂品牌最终预算是两万。', 103))
  const context = chatSeed(history, [], '丹桂品牌报价和预算')
  assert.ok(context.length <= 9000)
  assert.ok(context.includes('周五前提供报价'))
  assert.ok(context.indexOf('原预算三万') < context.indexOf('最终预算是两万'))
  assert.ok(context.includes('最终预算是两万'))
})

test('evicted chat facts stay bounded, deduplicated and usable after reload', () => {
  let saved = foldEvicted([], [message('决定把样品交给王工跟进。', 1)])
  for (let i = 0; i < 90; i++) saved = foldEvicted(saved, [message('闲聊记录' + i, i + 2)])
  saved = foldEvicted(saved, [message('登录密码是一个测试值。', 93)])
  assert.ok(saved.length <= 40)
  const replay = chatSeed([], JSON.parse(JSON.stringify(saved)), '样品跟进')
  assert.match(replay, /样品交给王工/)
  assert.doesNotMatch(replay, /登录密码/)
  assert.equal(chatSeed([]), '')
})

test('rotation accounts for conversation length, attachment bytes in the prompt and tool usage', () => {
  const state = { turns: 1, chars: 23, tokens: 200 }
  assert.equal(needsCompaction(null, 100), false)
  assert.equal(needsCompaction(state, 40), false)
  assert.equal(needsCompaction({ ...state, turns: 16 }, 40), true)
  assert.equal(needsCompaction({ ...state, chars: 47000 }, 1200), true)
  assert.equal(needsCompaction({ ...state, tokens: 7000 }, 20, 10000), true)
})
