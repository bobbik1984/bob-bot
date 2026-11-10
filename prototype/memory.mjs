// Durable memory: facts the owner would expect Bob to remember, plus insights produced by the nightly dream.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeAtomic } from './store.mjs'

const MAX_ITEMS = 120
const MAX_DREAM_REMOVALS = 3
const MAX_INSIGHTS = 8
const INSIGHT_DAYS = 7
const KIND_WEIGHT = { open_loop: 3, preference: 2, pattern: 1, fact: 1 }
const SECRET = /sk-[a-z0-9]{12,}|password|密码|验证码/i

const squash = text => String(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const sameText = (a, b) => squash(a) === squash(b)
/** Latin words and pairs of Chinese characters, so a message can be matched to memories without a search engine. */
const terms = text => new Set([
  ...(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []),
  ...[...String(text).matchAll(/\p{Script=Han}+/gu)].flatMap(([run]) => Array.from({ length: Math.max(run.length - 1, 0) }, (_, i) => run.slice(i, i + 2))),
])

export class Memory {
  constructor(file) {
    this.file = file
    this.state = { items: [], insights: [], lastDreamAt: 0, dreamLog: [] }
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { /* first run */ }
    this.state.items ??= []
    this.state.insights ??= []
    this.state.dreamLog ??= []
  }

  #save() { try { writeAtomic(this.file, JSON.stringify(this.state)) } catch { /* read only */ } }

  list() { return { items: this.state.items, insights: this.state.insights, lastDreamAt: this.state.lastDreamAt, lastDream: this.state.dreamLog[0] ?? null } }

  /** Remembers that a dream failed, so the owner can see it and it is not retried straight away. */
  noteDreamFailure(reason, now = Date.now()) {
    this.state.dreamLog = [{ at: now, failed: true, reason: String(reason).slice(0, 200) }, ...this.state.dreamLog].slice(0, 10)
    this.#save()
  }

  /** The memories most worth having for this message: unfinished work and preferences first, then what it mentions. */
  pick({ query = '', maxChars = 1500 } = {}) {
    const wanted = terms(query)
    const scored = this.state.items.map(item => {
      let overlap = 0
      for (const term of terms(item.text)) if (wanted.has(term)) overlap += 1
      return { item, score: (KIND_WEIGHT[item.kind] ?? 1) + Math.min(overlap, 4) * 3 }
    }).sort((a, b) => b.score - a.score || b.item.at - a.item.at)
    const out = []
    let used = 0
    for (const { item } of scored) {
      used += item.text.length + 3
      if (used > maxChars) break
      out.push(item)
    }
    return out
  }

  /** Observations from recent dreams. Old ones expire instead of being repeated for ever. */
  freshInsights(now = Date.now()) { return this.state.insights.filter(i => now - (i.at ?? 0) < INSIGHT_DAYS * 86400e3).slice(0, 4) }

  add({ text, kind = 'fact', source = 'chat' }) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!clean) return null
    if (this.state.items.some(i => sameText(i.text, clean))) return null
    const item = { id: `m${crypto.randomBytes(4).toString('hex')}`, text: clean, kind, source, at: Date.now() }
    this.state.items.unshift(item)
    this.state.items = this.state.items.slice(0, MAX_ITEMS)
    this.#save()
    return item
  }

  update(id, text) {
    const item = this.state.items.find(i => i.id === id)
    if (!item) return null
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!clean) return null
    item.text = clean
    item.at = Date.now()
    this.#save()
    return item
  }

  remove(id) {
    const before = this.state.items.length
    this.state.items = this.state.items.filter(i => i.id !== id)
    if (this.state.items.length !== before) this.#save()
    return before !== this.state.items.length
  }

  /** A short block for prompts: what Bob knows about this person. */
  context() {
    const items = this.pick().map(i => `- ${i.text}`)
    const insights = this.freshInsights().map(i => `- ${i.text}`)
    return [
      items.length ? `What you remember about the user:\n${items.join('\n')}` : '',
      insights.length ? `Recent observations:\n${insights.join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
  }

  applyDream({ add = [], update = [], remove = [], insights = [] }) {
    let added = 0
    let updated = 0
    let removed = 0
    const forgotten = []
    for (const id of remove.slice(0, MAX_DREAM_REMOVALS)) { // one bad night must not be able to wipe the memory
      const text = this.state.items.find(i => i.id === id)?.text
      if (text && this.remove(id)) { removed += 1; forgotten.push(text) }
    }
    for (const entry of update.slice(0, 10)) if (entry?.id && !SECRET.test(entry.text ?? '') && this.update(entry.id, entry.text)) updated += 1
    for (const entry of add.slice(0, 8)) {
      if (!entry?.text || SECRET.test(entry.text)) continue
      const kind = KIND_WEIGHT[entry.kind] ? entry.kind : 'fact'
      if (this.add({ text: entry.text, kind, source: 'dream' })) added += 1
    }
    const fresh = insights.filter(i => typeof i === 'string' && i.trim()).slice(0, 4)
    if (fresh.length) this.state.insights = [...fresh.map(text => ({ text: text.slice(0, 200), at: Date.now() })), ...this.state.insights].slice(0, MAX_INSIGHTS)
    this.state.lastDreamAt = Date.now()
    this.state.dreamLog = [{ at: Date.now(), added, updated, removed, insights: fresh.length, forgotten }, ...this.state.dreamLog].slice(0, 10)
    this.#save()
    return { added, updated, removed }
  }
}
