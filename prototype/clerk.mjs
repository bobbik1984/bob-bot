// The clerk: scheduled tasks and reminders. Schedules are structured (not cron strings) so the model cannot get
// the syntax wrong, and every time is computed in the owner's time zone, including daylight saving changes.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_JOBS = 30
const MAX_INBOX = 100
export const CATCH_UP_MS = 2 * 60 * 60 * 1000 // a job more than this late is skipped, not run

const fail = code => Object.assign(new Error(code), { code })
const parts = (ms, tz) => {
  const list = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms))
  const get = type => Number(list.find(p => p.type === type).value)
  return { y: get('year'), m: get('month'), d: get('day'), H: get('hour'), M: get('minute'), S: get('second') }
}

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0 } catch { return false }
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(ms, tz) {
  const p = parts(ms, tz)
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - Math.floor(ms / 1000) * 1000) / 60000)
}

/** The instant when a wall clock in `tz` shows this date and time. */
export function zonedToUtc(y, m, d, H, M, tz) {
  const guess = Date.UTC(y, m - 1, d, H, M)
  const first = offsetMinutes(guess, tz)
  let instant = guess - first * 60000
  const second = offsetMinutes(instant, tz)
  if (second !== first) instant = guess - second * 60000 // the clocks changed in between
  return instant
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/
const AT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/

/** Checks a schedule from the model or the page and returns it in a fixed shape. */
export function normalizeSchedule(input) {
  const type = input?.type
  const time = () => {
    const m = TIME.exec(String(input.time ?? '').trim())
    if (!m) throw fail('BAD_TIME')
    return `${m[1].padStart(2, '0')}:${m[2]}`
  }
  if (type === 'daily') return { type, time: time() }
  if (type === 'weekly') {
    const days = [...new Set((input.days ?? []).map(Number))].sort()
    if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw fail('BAD_DAYS')
    return { type, days, time: time() }
  }
  if (type === 'monthly') {
    const day = Number(input.day)
    if (!Number.isInteger(day) || day < 1 || day > 31) throw fail('BAD_DAY')
    return { type, day, time: time() }
  }
  if (type === 'once') {
    const m = AT.exec(String(input.at ?? '').trim())
    if (!m) throw fail('BAD_AT')
    const probe = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    if (probe.getUTCMonth() !== +m[2] - 1) throw fail('BAD_AT')
    return { type, at: m[0] }
  }
  throw fail('BAD_SCHEDULE')
}

/** The first run strictly after `afterMs`, or null when there is none (a one-time job in the past). */
export function nextRun(schedule, tz, afterMs) {
  if (schedule.type === 'once') {
    const [, y, m, d, H, M] = AT.exec(schedule.at).map(Number)
    const at = zonedToUtc(y, m, d, H, M, tz)
    return at > afterMs ? at : null
  }
  const [H, M] = schedule.time.split(':').map(Number)
  const today = parts(afterMs, tz)
  for (let add = 0; add < 800; add++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + add))
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate()
    if (schedule.type === 'weekly' && !schedule.days.includes(day.getUTCDay())) continue
    if (schedule.type === 'monthly' && schedule.day !== d) continue
    const at = zonedToUtc(y, m, d, H, M, tz)
    if (at > afterMs) return at
  }
  return null
}

const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function describeSchedule(s) {
  if (s.type === 'daily') return `Every day at ${s.time}`
  if (s.type === 'weekly') return `Every ${s.days.map(d => DAY_EN[d]).join(', ')} at ${s.time}`
  if (s.type === 'monthly') return `On day ${s.day} of every month at ${s.time}`
  return `Once, ${s.at.replace('T', ' ')}`
}

export function formatLocal(ms, tz) {
  const p = parts(ms, tz)
  const pad = n => String(n).padStart(2, '0')
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.H)}:${pad(p.M)}`
}

export class Clerk {
  constructor(dir, { serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    this.file = path.join(dir, 'clerk.json')
    this.inboxFile = path.join(dir, 'inbox.json')
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { /* first run */ }
    this.timezone = validTimezone(saved.timezone) ? saved.timezone : serverTimezone
    this.timezoneChosen = Boolean(saved.timezoneChosen)
    this.jobs = saved.jobs ?? []
    this.todos = saved.todos ?? []
    this.channels = saved.channels ?? []
    try { this.inbox = JSON.parse(fs.readFileSync(this.inboxFile, 'utf8')) } catch { this.inbox = [] }
  }

  #save() {
    fs.writeFileSync(this.file, JSON.stringify({ timezone: this.timezone, timezoneChosen: this.timezoneChosen, jobs: this.jobs, todos: this.todos, channels: this.channels }), { mode: 0o600 })
  }

  #saveInbox() { fs.writeFileSync(this.inboxFile, JSON.stringify(this.inbox.slice(0, MAX_INBOX)), { mode: 0o600 }) }

  setTimezone(tz) {
    if (!validTimezone(tz)) throw fail('BAD_TIMEZONE')
    this.timezone = tz
    this.timezoneChosen = true
    const now = Date.now()
    for (const job of this.jobs) if (job.enabled) job.nextRun = nextRun(job.schedule, tz, now)
    this.#save()
  }

  // ---- channels ----
  addChannel(validated) {
    if (this.channels.some(c => c.name.toLowerCase() === validated.name.toLowerCase())) throw fail('NAME_TAKEN')
    const channel = { id: `ch${crypto.randomBytes(4).toString('hex')}`, ...validated }
    this.channels.push(channel)
    this.#save()
    return channel
  }
  channel(id) { return this.channels.find(c => c.id === id) }
  setChannelConfig(id, patch) { Object.assign(this.channel(id).config, patch); this.#save() }
  removeChannel(id) {
    this.channels = this.channels.filter(c => c.id !== id)
    for (const job of this.jobs) job.channels = job.channels.filter(c => c !== id)
    this.#save()
  }
  /** Channel ids for names the model gave. Unknown names are an error that lists the real ones. */
  resolveChannels(names = []) {
    return names.map(name => {
      const found = this.channels.find(c => c.name.toLowerCase() === String(name).trim().toLowerCase())
      if (!found) throw Object.assign(fail('UNKNOWN_CHANNEL'), { available: this.channels.map(c => c.name) })
      return found.id
    })
  }

  // ---- jobs ----
  addJob({ title, kind, text, schedule, channels = [], todoId = null }, now = Date.now()) {
    if (this.jobs.length >= MAX_JOBS) throw fail('TOO_MANY_JOBS')
    if (kind !== 'task' && kind !== 'reminder') throw fail('BAD_KIND')
    const cleanTitle = String(title ?? '').trim().slice(0, 60)
    const cleanText = String(text ?? '').trim().slice(0, 4000)
    if (!cleanTitle || !cleanText) throw fail('EMPTY')
    const normalized = normalizeSchedule(schedule)
    const next = nextRun(normalized, this.timezone, now)
    if (next === null) throw fail('IN_THE_PAST')
    const job = { id: `j${crypto.randomBytes(4).toString('hex')}`, title: cleanTitle, kind, text: cleanText, schedule: normalized, channels, todoId, enabled: true, cid: null, createdAt: now, nextRun: next, lastRun: null, lastStatus: null, lastResult: null }
    this.jobs.push(job)
    this.#save()
    return job
  }
  job(id) { return this.jobs.find(j => j.id === id) }
  removeJob(id) { this.jobs = this.jobs.filter(j => j.id !== id); this.#save() }
  setEnabled(id, enabled, now = Date.now()) {
    const job = this.job(id)
    job.enabled = Boolean(enabled)
    job.nextRun = job.enabled ? nextRun(job.schedule, this.timezone, now) : null
    if (job.enabled && job.nextRun === null) job.enabled = false // a one-time job that already passed
    this.#save()
    return job
  }
  update(job, patch) { Object.assign(job, patch); this.#save() }

  /** Jobs whose time has come. Anything more than CATCH_UP_MS late is reported as missed instead. */
  due(now = Date.now()) {
    const run = [], missed = []
    for (const job of this.jobs) {
      if (!job.enabled || job.nextRun === null || job.nextRun > now) continue
      ;(now - job.nextRun > CATCH_UP_MS ? missed : run).push(job)
    }
    return { run, missed }
  }
  /** Moves a job on to its following run (or switches off a one-time job). */
  advance(job, now = Date.now()) {
    job.nextRun = job.schedule.type === 'once' ? null : nextRun(job.schedule, this.timezone, now)
    if (job.nextRun === null) job.enabled = false
    this.#save()
  }

  // ---- to-dos: things to remember or do, with an optional due time ----
  addTodo({ title, note = '', due = null, jobId = null }, now = Date.now()) {
    const clean = String(title ?? '').trim().slice(0, 100)
    if (!clean) throw fail('EMPTY')
    if (due !== null && !AT.test(due)) throw fail('BAD_AT')
    if (this.todos.length >= 200) throw fail('TOO_MANY_TODOS')
    const todo = { id: `t${crypto.randomBytes(4).toString('hex')}`, title: clean, note: String(note ?? '').trim().slice(0, 300), due, done: false, createdAt: now, jobId }
    this.todos.unshift(todo)
    this.#save()
    return todo
  }
  todo(id) { return this.todos.find(t => t.id === id) }
  setTodoDone(id, done) {
    const todo = this.todo(id)
    todo.done = Boolean(done)
    const job = todo.jobId ? this.job(todo.jobId) : null
    if (job && todo.done) { job.enabled = false; job.nextRun = null } // finished, so no reminder
    this.#save()
    return todo
  }
  removeTodo(id) {
    const todo = this.todo(id)
    if (todo?.jobId) this.jobs = this.jobs.filter(j => j.id !== todo.jobId)
    this.todos = this.todos.filter(t => t.id !== id)
    this.#save()
  }

  // ---- inbox ----
  addInbox({ title, text, jobId = null, cards = [] }, now = Date.now()) {
    const entry = { id: `n${crypto.randomBytes(4).toString('hex')}`, at: now, title, text: String(text).slice(0, 6000), jobId, cards, read: false, delivery: [] }
    this.inbox.unshift(entry)
    this.inbox = this.inbox.slice(0, MAX_INBOX)
    this.#saveInbox()
    return entry
  }
  setDelivery(id, delivery) {
    const entry = this.inbox.find(n => n.id === id)
    if (entry) { entry.delivery = delivery; this.#saveInbox() }
  }
  markAllRead() { for (const n of this.inbox) n.read = true; this.#saveInbox() }
  unread() { return this.inbox.filter(n => !n.read).length }
}
