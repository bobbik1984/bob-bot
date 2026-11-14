// Unit tests for the clerk (schedules and store), the channel senders and web_fetch. No server, model or Chrome needed.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, checkCard } from '../cards.mjs'
import { buildRequest, findTelegramChat, publicChannel, sendToChannel, validateChannel } from '../channels.mjs'
import { CATCH_UP_MS, Clerk, describeSchedule, formatLocal, nextRun, normalizeSchedule, zonedToUtc } from '../clerk.mjs'
import { htmlToText, webFetch } from '../web-fetch.mjs'
import { Memory } from '../memory.mjs'
import { checkPage, Pages } from '../pages.mjs'
import { checkProfile, Providers } from '../providers.mjs'

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`  ok   ${name}`) } catch (error) { results.push(false); console.log(`  FAIL ${name}\n       ${error.message}`) }
}
const utc = iso => Date.parse(iso)
const SH = 'Asia/Shanghai', NY = 'America/New_York'

console.log('Schedules')
await check('daily runs today if the time has not come, tomorrow if it has', () => {
  const s = normalizeSchedule({ type: 'daily', time: '8:00' })
  assert.equal(s.time, '08:00')
  assert.equal(nextRun(s, SH, utc('2026-11-08T23:00:00Z')), utc('2026-11-09T00:00:00Z')) // 07:00 in Shanghai -> 08:00 today
  assert.equal(nextRun(s, SH, utc('2026-11-09T00:00:00Z')), utc('2026-11-10T00:00:00Z')) // exactly 08:00 -> tomorrow
})
await check('weekly picks the next listed weekday', () => {
  const s = normalizeSchedule({ type: 'weekly', days: [5, 1, 3], time: '09:30' })
  assert.deepEqual(s.days, [1, 3, 5])
  assert.equal(formatLocal(nextRun(s, SH, utc('2026-11-08T05:00:00Z')), SH), '2026-11-09 09:30') // Sunday -> Monday
  assert.equal(formatLocal(nextRun(s, SH, utc('2026-11-09T05:00:00Z')), SH), '2026-11-11 09:30') // Monday 13:00 -> Wednesday
})
await check('monthly skips months without that day', () => {
  const s = normalizeSchedule({ type: 'monthly', day: 31, time: '09:00' })
  assert.equal(formatLocal(nextRun(s, SH, utc('2026-11-09T00:00:00Z')), SH), '2026-12-31 09:00')
  assert.equal(formatLocal(nextRun(s, SH, utc('2027-01-31T10:00:00Z')), SH), '2027-03-31 09:00') // February has no 31st
})
await check('a one-time run is exact, and null once it has passed', () => {
  const s = normalizeSchedule({ type: 'once', at: '2026-11-09T15:00' })
  assert.equal(nextRun(s, SH, utc('2026-11-09T00:00:00Z')), utc('2026-11-09T07:00:00Z'))
  assert.equal(nextRun(s, SH, utc('2026-11-09T07:00:00Z')), null)
})
await check('the same wall-clock time follows daylight saving', () => {
  const s = normalizeSchedule({ type: 'daily', time: '08:00' })
  const before = nextRun(s, NY, utc('2026-10-31T00:00:00Z')) // Oct 31, still EDT
  const after = nextRun(s, NY, before) // Nov 1, after the clocks went back
  assert.equal(before, utc('2026-10-31T12:00:00Z'))
  assert.equal(after, utc('2026-11-01T13:00:00Z'))
  assert.equal((after - before) / 3600000, 25)
  const spring = nextRun(s, NY, utc('2026-03-07T14:00:00Z'))
  assert.equal(spring, utc('2026-03-08T12:00:00Z')) // Mar 8: the clocks went forward, 08:00 is EDT
})
await check('a time that does not exist on a clock-change day still gives a later instant', () => {
  const s = normalizeSchedule({ type: 'daily', time: '02:30' })
  const t = nextRun(s, NY, utc('2026-03-08T00:00:00Z'))
  assert.ok(t > utc('2026-03-08T00:00:00Z') && t < utc('2026-03-09T12:00:00Z'))
})
await check('bad schedules are refused with a code', () => {
  const code = input => { try { normalizeSchedule(input) } catch (e) { return e.message } return 'accepted' }
  assert.equal(code({ type: 'daily', time: '25:00' }), 'BAD_TIME')
  assert.equal(code({ type: 'daily' }), 'BAD_TIME')
  assert.equal(code({ type: 'weekly', days: [], time: '08:00' }), 'BAD_DAYS')
  assert.equal(code({ type: 'weekly', days: [7], time: '08:00' }), 'BAD_DAYS')
  assert.equal(code({ type: 'monthly', day: 32, time: '08:00' }), 'BAD_DAY')
  assert.equal(code({ type: 'once', at: '2026-02-30T10:00' }), 'BAD_AT')
  assert.equal(code({ type: 'once', at: 'tomorrow' }), 'BAD_AT')
  assert.equal(code({ type: 'cron', expr: '* * * * *' }), 'BAD_SCHEDULE')
})
await check('schedules read well in English', () => {
  assert.equal(describeSchedule({ type: 'weekly', days: [1, 2], time: '07:00' }), 'Every Mon, Tue at 07:00')
  assert.equal(zonedToUtc(2026, 11, 9, 8, 0, SH), utc('2026-11-09T00:00:00Z'))
})

console.log('Clerk store')
const newClerk = (tz = SH) => new Clerk(fs.mkdtempSync(path.join(os.tmpdir(), 'clerk-')), { serverTimezone: tz })
const weather = { title: 'Morning weather', kind: 'task', text: 'Check the weather in Shanghai and advise on clothes and an umbrella.', schedule: { type: 'daily', time: '08:00' } }
await check('a job gets its first run time, and survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerk-'))
  const a = new Clerk(dir, { serverTimezone: SH })
  const job = a.addJob(weather, utc('2026-11-09T00:30:00Z'))
  assert.equal(job.nextRun, utc('2026-11-10T00:00:00Z'))
  const b = new Clerk(dir, { serverTimezone: 'UTC' })
  assert.equal(b.jobs.length, 1); assert.equal(b.timezone, SH)
  assert.equal(b.job(job.id).nextRun, job.nextRun)
})
await check('due, advance and the catch-up limit', () => {
  const c = newClerk()
  const job = c.addJob(weather, utc('2026-11-09T00:30:00Z'))
  assert.deepEqual(c.due(job.nextRun - 1), { run: [], missed: [] })
  assert.deepEqual(c.due(job.nextRun + 60000).run.map(j => j.id), [job.id])
  const late = c.due(job.nextRun + CATCH_UP_MS + 1)
  assert.deepEqual(late.run, []); assert.deepEqual(late.missed.map(j => j.id), [job.id])
  c.advance(job, job.nextRun + 60000)
  assert.equal(job.nextRun, utc('2026-11-11T00:00:00Z'))
})
await check('a one-time job switches itself off after it runs, and cannot be set in the past', () => {
  const c = newClerk()
  const job = c.addJob({ title: 'Call mom', kind: 'reminder', text: 'Call mom', schedule: { type: 'once', at: '2026-11-09T15:00' } }, utc('2026-11-09T00:00:00Z'))
  c.advance(job, job.nextRun + 1000)
  assert.equal(job.enabled, false); assert.equal(job.nextRun, null)
  assert.throws(() => c.addJob({ title: 'x', kind: 'reminder', text: 'x', schedule: { type: 'once', at: '2026-11-08T15:00' } }, utc('2026-11-09T00:00:00Z')), /IN_THE_PAST/)
})
await check('pausing and resuming recompute the next run', () => {
  const c = newClerk()
  const job = c.addJob(weather, utc('2026-11-09T00:30:00Z'))
  c.setEnabled(job.id, false); assert.equal(job.nextRun, null)
  c.setEnabled(job.id, true, utc('2026-11-12T05:00:00Z')); assert.equal(job.nextRun, utc('2026-11-13T00:00:00Z'))
})
await check('changing the time zone moves the next run', () => {
  const c = newClerk()
  const job = c.addJob(weather, utc('2026-11-09T00:30:00Z'))
  c.setTimezone(NY)
  assert.equal(formatLocal(job.nextRun, NY), formatLocal(nextRun(job.schedule, NY, Date.now()), NY))
  assert.throws(() => c.setTimezone('Mars/Base'), /BAD_TIMEZONE/)
})
await check('input is checked: kind, empty text and the job limit', () => {
  const c = newClerk()
  assert.throws(() => c.addJob({ ...weather, kind: 'chore' }), /BAD_KIND/)
  assert.throws(() => c.addJob({ ...weather, text: '  ' }), /EMPTY/)
  for (let i = 0; i < 30; i++) c.addJob({ ...weather, title: `Job ${i}` })
  assert.throws(() => c.addJob(weather), /TOO_MANY_JOBS/)
})
await check('channel names resolve case-insensitively, and an unknown one lists the real ones', () => {
  const c = newClerk()
  const ch = c.addChannel(validateChannel({ type: 'lark', name: 'Team Lark', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123' }))
  assert.deepEqual(c.resolveChannels(['team lark']), [ch.id])
  try { c.resolveChannels(['Nope']); assert.fail('should throw') } catch (e) { assert.equal(e.message, 'UNKNOWN_CHANNEL'); assert.deepEqual(e.available, ['Team Lark']) }
  assert.throws(() => c.addChannel(validateChannel({ type: 'lark', name: 'TEAM LARK', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/zzz' })), /NAME_TAKEN/)
  const job = c.addJob({ ...weather, channels: [ch.id] })
  c.removeChannel(ch.id)
  assert.deepEqual(job.channels, [])
})
await check('the inbox keeps the newest 100 and counts unread', () => {
  const c = newClerk()
  for (let i = 0; i < 105; i++) c.addInbox({ title: 't', text: String(i) })
  assert.equal(c.inbox.length, 100); assert.equal(c.inbox[0].text, '104'); assert.equal(c.unread(), 100)
  c.markAllRead(); assert.equal(c.unread(), 0)
})
await check('inbox entries that no longer belong there can be dropped, and the change is saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerk-'))
  const c = new Clerk(dir, { serverTimezone: SH })
  c.addInbox({ title: '主动关心', text: 'old check-in' })
  c.addInbox({ title: '主动关心', text: 'a job result', jobId: 'j1' })
  c.addInbox({ title: 'Weather', text: 'forecast', jobId: 'j2' })
  assert.equal(c.pruneInbox(n => n.title === '主动关心' && !n.jobId), 1)
  assert.deepEqual(c.inbox.map(n => n.text), ['forecast', 'a job result'])
  assert.equal(c.unread(), 2)
  assert.deepEqual(new Clerk(dir, { serverTimezone: SH }).inbox.map(n => n.text), ['forecast', 'a job result'])
})

console.log('Model providers')
const profileError = (input, options) => { try { checkProfile(input, options); return 'ok' } catch (e) { return e.code } }
await check('a DeepSeek profile uses the direct Messages endpoint and the registry price', () => {
  const p = checkProfile({ kind: 'deepseek', model: 'deepseek-flash' })
  assert.equal(p.api, 'anthropic-messages'); assert.equal(p.baseUrl, 'https://api.deepseek.com/anthropic')
  assert.equal(p.inputUsd, null); assert.equal(p.outputUsd, null)
})
await check('a custom profile needs https, a model and a real price', () => {
  assert.equal(profileError({ kind: 'custom', baseUrl: 'http://example.com/v1', model: 'm', inputUsd: 1, outputUsd: 2 }), 'HTTPS_REQUIRED')
  assert.equal(profileError({ kind: 'custom', baseUrl: 'https://example.com/v1', model: 'm', inputUsd: 0, outputUsd: 0 }), 'BAD_PRICE')
  assert.equal(profileError({ kind: 'custom', baseUrl: 'https://example.com/v1', model: 'has space', inputUsd: 1, outputUsd: 2 }), 'BAD_MODEL')
  assert.equal(profileError({ kind: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', inputUsd: 1, outputUsd: 2 }), 'HTTPS_REQUIRED')
  assert.equal(profileError({ kind: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', inputUsd: 1, outputUsd: 2 }, { allowHttp: true }), 'ok')
  assert.equal(checkProfile({ kind: 'custom', baseUrl: 'https://example.com/v1/', model: 'm', inputUsd: 1, outputUsd: 2 }).baseUrl, 'https://example.com/v1')
  assert.equal(profileError({ kind: 'nope' }), 'BAD_KIND')
})
await check('a preset takes the vendor defaults but keeps the owner\'s model and price', () => {
  const p = checkProfile({ kind: 'anthropic', model: 'claude-sonnet-4-5', inputUsd: 3, outputUsd: 15 })
  assert.equal(p.api, 'anthropic-messages'); assert.equal(p.baseUrl, 'https://api.anthropic.com')
  assert.equal(p.contextWindow, 200000); assert.equal(p.maxTokens, 8192)
  assert.equal(p.inputUsd, 3); assert.equal(p.outputUsd, 15)
})
await check('profiles save, switch, survive a reload and can be removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'))
  const file = path.join(dir, 'providers.json')
  const p = new Providers(file)
  assert.equal(p.exists, false)
  assert.equal(p.seed([{ kind: 'deepseek', model: 'deepseek-flash', legacyKey: 'deepseek' }]), true)
  assert.equal(p.active().kind, 'deepseek'); assert.equal(p.active().legacyKey, 'deepseek')
  const claude = p.add({ name: 'Claude', kind: 'anthropic', model: 'claude-sonnet-4-5', inputUsd: 3, outputUsd: 15 })
  p.activate(claude.id)
  assert.equal(p.active().name, 'Claude')
  const again = new Providers(file)
  assert.equal(again.active().name, 'Claude'); assert.equal(again.items.length, 2)
  p.remove(claude.id)
  assert.equal(p.active().kind, 'deepseek'); assert.equal(new Providers(file).active().kind, 'deepseek')
})
await check('a broken legacy profile does not leave an empty store behind', () => {
  const p = new Providers(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'providers-')), 'providers.json'))
  assert.throws(() => p.seed([{ kind: 'custom', baseUrl: 'http://example.com/v1', model: 'm', inputUsd: 1, outputUsd: 2 }]), /HTTPS_REQUIRED/)
  assert.equal(p.exists, false)
})

console.log('Published pages')
const pageError = input => { try { checkPage(input); return 'ok' } catch (e) { return e.code } }
await check('a page needs a title, content and a bounded preview height', () => {
  assert.equal(pageError({ title: '', html: '<p>x</p>' }), 'BAD_TITLE')
  assert.equal(pageError({ title: 'x', html: '' }), 'EMPTY_PAGE')
  assert.equal(pageError({ title: 'x', html: 'x'.repeat(300001) }), 'PAGE_TOO_LARGE')
  const p = checkPage({ title: '  My  chart ', html: '<h1>x</h1>', height: 900 })
  assert.equal(p.title, 'My chart'); assert.equal(p.height, 800)
  assert.equal(checkPage({ title: 'x', html: '<h1>x</h1>' }).height, 360)
})
await check('a published page is stored with a safe id and can be read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'))
  const pages = new Pages(dir)
  const p = pages.save(checkPage({ title: 'Chart', html: '<h1>ok</h1>', height: 300 }))
  assert.match(p.id, /^[a-f0-9]{12}$/)
  assert.equal(pages.read(p.id), '<h1>ok</h1>')
  assert.equal(pages.read('../etc/passwd'), null)
  assert.equal(pages.read('zzzzzzzzzzzz'), null)
  assert.deepEqual(new Pages(dir).list().map(x => x.id), [p.id])
})

console.log('Channels')
const lark = validateChannel({ type: 'lark', name: 'Lark', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123', secret: 'shh' })
await check('only real webhook addresses and tokens are accepted', () => {
  const code = input => { try { validateChannel(input) } catch (e) { return e.message } return 'accepted' }
  assert.equal(code({ type: 'lark', name: 'x', webhook: 'https://evil.example/open-apis/bot/v2/hook/abc' }), 'BAD_WEBHOOK')
  assert.equal(code({ type: 'lark', name: 'x', webhook: 'http://open.feishu.cn/open-apis/bot/v2/hook/abc' }), 'BAD_WEBHOOK')
  assert.equal(code({ type: 'wecom', name: 'x', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-1' }), 'accepted')
  assert.equal(code({ type: 'wecom', name: 'x', webhook: 'https://127.0.0.1/cgi-bin/webhook/send?key=abc' }), 'BAD_WEBHOOK')
  assert.equal(code({ type: 'discord', name: 'x', webhook: 'https://discord.com/api/webhooks/123456/abc_def' }), 'accepted')
  assert.equal(code({ type: 'telegram', name: 'x', token: '123456:' + 'a'.repeat(35) }), 'accepted')
  assert.equal(code({ type: 'telegram', name: 'x', token: 'nope' }), 'BAD_TOKEN')
  assert.equal(code({ type: 'telegram', name: 'x', token: '123456:' + 'a'.repeat(35), chatId: 'abc' }), 'BAD_CHAT_ID')
  assert.equal(code({ type: 'sms', name: 'x' }), 'BAD_TYPE')
  assert.equal(code({ type: 'lark', name: '', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' }), 'BAD_NAME')
})
await check('the page never sees a webhook, secret or token', () => {
  const tg = validateChannel({ type: 'telegram', name: 'TG', token: '123456:' + 'abcdefghij'.repeat(4), chatId: '42' })
  const shown = JSON.stringify([publicChannel({ id: 'a', ...lark }), publicChannel({ id: 'b', ...tg })])
  assert.ok(!shown.includes('abc-123') && !shown.includes('shh') && !shown.includes('abcdefghij'), shown)
})
await check('each service gets the message in its own format', () => {
  const now = 1_700_000_000_000
  const l = buildRequest({ id: 'x', ...lark }, 'hello', now)
  const body = JSON.parse(l.init.body)
  assert.equal(l.url, 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123')
  assert.deepEqual(body.content, { text: 'hello' }); assert.equal(body.msg_type, 'text'); assert.equal(body.timestamp, '1700000000')
  assert.equal(body.sign, crypto.createHmac('sha256', '1700000000\nshh').update('').digest('base64'))
  const w = JSON.parse(buildRequest({ type: 'wecom', config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } }, 'hi').init.body)
  assert.deepEqual(w, { msgtype: 'text', text: { content: 'hi' } })
  const t = buildRequest({ type: 'telegram', config: { token: '1:tok', chatId: '42' } }, 'yo')
  assert.equal(t.url, 'https://api.telegram.org/bot1:tok/sendMessage'); assert.deepEqual(JSON.parse(t.init.body), { chat_id: '42', text: 'yo' })
  assert.equal(JSON.parse(buildRequest({ type: 'discord', config: { webhook: 'https://discord.com/api/webhooks/1/a' } }, 'x'.repeat(5000)).init.body).content.length, 2000)
  const wx = validateChannel({ type: 'wechat', name: '微信提醒' })
  assert.deepEqual(wx, { type: 'wechat', name: '微信提醒', config: {} })
  const wxReq = buildRequest(wx, 'remember the meeting')
  assert.equal(wxReq.url, 'http://127.0.0.1:3722/send'); assert.deepEqual(JSON.parse(wxReq.init.body), { text: 'remember the meeting' })
  assert.ok(JSON.parse(buildRequest({ id: 'x', ...lark }, 'x'.repeat(9000)).init.body).content.text.length < 3600)
})
const reply = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body })
await check('success and failure are read from each service\'s own answer', async () => {
  assert.deepEqual(await sendToChannel({ id: 'x', ...lark }, 'hi', { fetchImpl: reply({ code: 0 }) }), { ok: true })
  assert.deepEqual(await sendToChannel({ id: 'x', ...lark }, 'hi', { fetchImpl: reply({ code: 19001, msg: 'param invalid' }) }), { ok: false, error: 'param invalid' })
  const wecom = { type: 'wecom', config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } }
  assert.equal((await sendToChannel(wecom, 'hi', { fetchImpl: reply({ errcode: 0, errmsg: 'ok' }) })).ok, true)
  assert.equal((await sendToChannel(wecom, 'hi', { fetchImpl: reply({ errcode: 93000, errmsg: 'invalid webhook url, hint: [1]' }) })).error, 'invalid webhook url')
  const tg = { type: 'telegram', config: { token: '1:tok', chatId: '42' } }
  assert.equal((await sendToChannel(tg, 'hi', { fetchImpl: reply({ ok: true }) })).ok, true)
  assert.equal((await sendToChannel(tg, 'hi', { fetchImpl: reply({ ok: false, description: 'chat not found' }) })).error, 'chat not found')
  assert.equal((await sendToChannel({ type: 'discord', config: { webhook: 'https://discord.com/api/webhooks/1/a' } }, 'hi', { fetchImpl: async () => ({ ok: true, status: 204 }) })).ok, true)
  assert.equal((await sendToChannel({ type: 'telegram', config: { token: '1:tok', chatId: '' } }, 'hi')).error, 'No chat id yet')
})
await check('a blocked or slow service gives a readable error instead of throwing', async () => {
  const timeout = async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }
  assert.match((await sendToChannel({ id: 'x', ...lark }, 'hi', { fetchImpl: timeout })).error, /Timed out/)
  const refused = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  assert.equal((await sendToChannel({ id: 'x', ...lark }, 'hi', { fetchImpl: refused })).error, 'ECONNREFUSED')
})
await check('the Telegram chat id is found from the newest message', async () => {
  const updates = { ok: true, result: [{ message: { chat: { id: 1 } } }, { message: { chat: { id: 77 } } }] }
  assert.equal(await findTelegramChat('1:tok', { fetchImpl: reply(updates) }), '77')
  await assert.rejects(findTelegramChat('1:tok', { fetchImpl: reply({ ok: true, result: [] }) }), /SEND_A_MESSAGE_FIRST/)
  await assert.rejects(findTelegramChat('1:tok', { fetchImpl: reply({ ok: false }) }), /BAD_TOKEN/)
})

console.log('Cards')
await check('a card is trimmed into a known shape, and empty fields are dropped', () => {
  const card = checkCard({ title: '  Shanghai today  ', tag: 'Weather', fields: [{ label: 'Temperature', value: '14-19C' }, { label: '', value: 'x' }, { label: 'Rain', value: '' }], items: ['Light jacket', '  ', 'Umbrella'], note: 'Updated 08:00', extra: 'ignored' })
  assert.deepEqual(card, { kind: 'info', title: 'Shanghai today', subtitle: '', tag: 'Weather', fields: [{ label: 'Temperature', value: '14-19C' }], items: ['Light jacket', 'Umbrella'], note: 'Updated 08:00' })
})
await check('a card with no title, no content or too much is refused', () => {
  const message = input => { try { checkCard(input) } catch (e) { return e.message } return 'accepted' }
  assert.match(message({ title: '', items: ['x'] }), /title/)
  assert.match(message({ title: 'Only a title' }), /at least one/)
  assert.match(message({ title: 'x', fields: 'nope' }), /lists/)
  assert.match(message({ title: 'x', items: Array.from({ length: 13 }, (_, i) => `item ${i}`) }), /At most 12/)
  assert.equal(checkCard({ title: 'x'.repeat(500), note: 'y'.repeat(900) }).title.length, 80)
})
await check('a card reads well as plain text for chat apps', () => {
  const text = cardText(checkCard({ title: 'Shanghai today', tag: 'Weather', subtitle: 'Light rain', fields: [{ label: 'Temperature', value: '14-19C' }], items: ['Bring an umbrella'], note: 'Updated 08:00' }))
  assert.equal(text, '[Weather] Shanghai today\nLight rain\nTemperature: 14-19C\n- Bring an umbrella\nUpdated 08:00')
})

console.log('web_fetch')
await check('html becomes readable text', () => {
  const text = htmlToText('<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Weather</h1><p>Sunny &amp; 20&nbsp;degrees</p><!-- c --><li>Bring a hat</li></body></html>')
  assert.equal(text, 'Weather\nSunny & 20 degrees\nBring a hat')
})
const page = (status, headers, body) => async () => ({
  ok: status < 300, status, headers: new Headers(headers),
  body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(body) })), cancel: async () => {} } } },
})
await check('local and private addresses are refused, including through a redirect', async () => {
  await assert.rejects(webFetch('http://127.0.0.1:8787/'), /private network/)
  await assert.rejects(webFetch('http://169.254.169.254/latest/meta-data/'), /private network/)
  await assert.rejects(webFetch('file:///etc/passwd'), /http/)
  await assert.rejects(webFetch('https://1.1.1.1/', { fetchImpl: page(302, { location: 'http://10.0.0.5/admin' }, '') }), /private network/)
})
await check('a public page is fetched, converted and cut to length', async () => {
  const out = await webFetch('https://1.1.1.1/', { fetchImpl: page(200, { 'content-type': 'text/html' }, '<p>' + 'word '.repeat(100) + '</p>'), maxChars: 50 })
  assert.match(out, /^https:\/\/1\.1\.1\.1\/\nword word/); assert.match(out, /… \(cut\)$/)
  const json = await webFetch('https://1.1.1.1/data', { fetchImpl: page(200, { 'content-type': 'application/json' }, '{"temp":21}') })
  assert.match(json, /\{"temp":21\}$/)
  await assert.rejects(webFetch('https://1.1.1.1/', { fetchImpl: page(404, {}, '') }), /HTTP 404/)
})

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bobbot-unit-'))
await check('memory puts unfinished work first and finds what a message mentions', () => {
  const m = new Memory(path.join(tempDir(), 'm.json'))
  m.add({ text: '喜欢吃辣', kind: 'preference' })
  m.add({ text: '常驻上海，通勤骑车', kind: 'fact' })
  m.add({ text: '季度报告还差第三节', kind: 'open_loop' })
  assert.equal(m.pick()[0].text, '季度报告还差第三节')
  assert.equal(m.pick({ query: '上海明天下雨吗' })[0].text, '常驻上海，通勤骑车')
  assert.equal(m.pick({ maxChars: 12 }).length, 1)
})
await check('memory ignores a duplicate that only differs in punctuation', () => {
  const m = new Memory(path.join(tempDir(), 'm.json'))
  assert.ok(m.add({ text: 'Lives in Shanghai.' }))
  assert.equal(m.add({ text: 'lives in shanghai' }), null)
})
await check('one dream cannot wipe the memory or store a secret', () => {
  const m = new Memory(path.join(tempDir(), 'm.json'))
  const ids = Array.from({ length: 6 }, (_, i) => m.add({ text: `fact number ${i}` }).id)
  const out = m.applyDream({ remove: ids, add: [{ text: '登录密码是 1234' }, { text: 'a real fact', kind: 'nonsense' }] })
  assert.equal(out.removed, 3); assert.equal(out.added, 1)
  assert.equal(m.state.items.find(i => i.text === 'a real fact').kind, 'fact')
  assert.equal(m.state.dreamLog[0].forgotten.length, 3)
})
await check('old observations stop being used', () => {
  const m = new Memory(path.join(tempDir(), 'm.json'))
  m.state.insights = [{ text: 'new', at: Date.now() }, { text: 'old', at: Date.now() - 8 * 86400e3 }]
  assert.deepEqual(m.freshInsights().map(i => i.text), ['new'])
})
await check('a job keeps its latest 20 runs and clears what it was waiting for', () => {
  const c = new Clerk(tempDir(), { serverTimezone: 'UTC' })
  const job = c.addJob({ title: 'J', kind: 'task', text: 'x', schedule: { type: 'daily', time: '08:00' } })
  for (let i = 0; i < 25; i++) c.recordRun(job, { status: 'ok', summary: String(i) })
  assert.equal(job.runs.length, 20); assert.equal(job.runs[0].summary, '24')
  c.recordRun(job, { status: 'needs_you', summary: 'x' }, { reason: 'login' })
  assert.equal(job.assist.reason, 'login')
  c.recordRun(job, { status: 'ok', summary: 'y' })
  assert.equal(job.assist, null)
})
await check('drafts survive a restart, can be settled, and expire after a week', () => {
  const dir = tempDir()
  const now = Date.now()
  const c = new Clerk(dir, { serverTimezone: 'UTC' })
  const old = c.addDraft({ summary: 'old', action: { kind: 'command' } }, now - 8 * 86400e3)
  const fresh = c.addDraft({ summary: 'fresh', action: { kind: 'command' } }, now)
  assert.deepEqual(c.pendingDrafts(now).map(d => d.summary), ['fresh'])
  assert.equal(c.draft(old.id).status, 'expired')
  c.settleDraft(fresh, 'rejected')
  const again = new Clerk(dir, { serverTimezone: 'UTC' })
  assert.equal(again.draft(fresh.id).status, 'rejected'); assert.equal(again.pendingDrafts(now).length, 0)
})

// The service worker is plain browser code: run it against a fake worker scope to check what a tap on a notification does.
import vm from 'node:vm'
function tapNotification({ windows, url }) {
  const handlers = {}
  const calls = []
  const scope = {
    location: { origin: 'https://bob.example' },
    registration: { showNotification: () => {} },
    addEventListener: (name, fn) => { handlers[name] = fn },
    skipWaiting: () => {},
    clients: {
      claim: () => {},
      matchAll: async () => windows.map(w => ({ url: w, focus: async () => calls.push(['focus', w]), postMessage: m => calls.push(['post', w, m]) })),
      openWindow: async u => calls.push(['open', u]),
    },
    URL,
  }
  scope.self = scope
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), scope)
  let pending
  handlers.notificationclick({ notification: { close: () => calls.push(['close']), data: { url } }, waitUntil: p => { pending = p } })
  return pending.then(() => JSON.parse(JSON.stringify(calls))) // objects made inside the fake scope are from another realm
}
await check('tapping a notification moves an open app to its chat, without a reload', async () => {
  const calls = await tapNotification({ windows: ['https://other.example/', 'https://bob.example/?v=clerk'], url: '/?c=cabc123' })
  assert.deepEqual(calls, [['close'], ['focus', 'https://bob.example/?v=clerk'], ['post', 'https://bob.example/?v=clerk', { type: 'open', url: '/?c=cabc123' }]])
})
await check('tapping a notification with no app open starts the app at that chat', async () => {
  assert.deepEqual(await tapNotification({ windows: ['https://other.example/'], url: '/?c=cabc123' }), [['close'], ['open', 'https://bob.example/?c=cabc123']])
  assert.deepEqual(await tapNotification({ windows: [], url: undefined }), [['close'], ['open', 'https://bob.example/']])
})

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
