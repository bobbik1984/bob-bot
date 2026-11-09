// Durable memory: facts the owner would expect Bob to remember, plus insights produced by the nightly dream.
import crypto from 'node:crypto'
import fs from 'node:fs'

const MAX_ITEMS = 120
const MAX_INSIGHTS = 8

export class Memory {
  constructor(file) {
    this.file = file
    this.state = { items: [], insights: [], lastDreamAt: 0, dreamLog: [] }
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { /* first run */ }
    this.state.items ??= []
    this.state.insights ??= []
    this.state.dreamLog ??= []
  }

  #save() { try { fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 }) } catch { /* read only */ } }

  list() { return { items: this.state.items, insights: this.state.insights, lastDreamAt: this.state.lastDreamAt } }

  add({ text, kind = 'fact', source = 'chat' }) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!clean) return null
    if (this.state.items.some(i => i.text === clean)) return null
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
  context(limit = 10) {
    const items = this.state.items.slice(0, limit).map(i => `- ${i.text}`)
    const insights = this.state.insights.slice(0, 4).map(i => `- ${i.text}`)
    return [
      items.length ? `What you remember about the user:\n${items.join('\n')}` : '',
      insights.length ? `Recent observations:\n${insights.join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
  }

  applyDream({ add = [], update = [], remove = [], insights = [] }) {
    let added = 0
    let updated = 0
    let removed = 0
    for (const entry of remove.slice(0, 10)) if (this.remove(entry)) removed += 1
    for (const entry of update.slice(0, 10)) if (entry?.id && this.update(entry.id, entry.text)) updated += 1
    for (const entry of add.slice(0, 8)) {
      if (!entry?.text) continue
      if (this.add({ text: entry.text, kind: entry.kind ?? 'fact', source: 'dream' })) added += 1
    }
    const fresh = insights.filter(i => typeof i === 'string' && i.trim()).slice(0, 4)
    if (fresh.length) this.state.insights = [...fresh.map(text => ({ text: text.slice(0, 200), at: Date.now() })), ...this.state.insights].slice(0, MAX_INSIGHTS)
    this.state.lastDreamAt = Date.now()
    this.state.dreamLog = [{ at: Date.now(), added, updated, removed, insights: fresh.length }, ...this.state.dreamLog].slice(0, 10)
    this.#save()
    return { added, updated, removed }
  }
}
