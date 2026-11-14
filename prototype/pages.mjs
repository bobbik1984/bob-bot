// Self-contained pages Bob publishes into the chat: a chart, a report or a small dashboard. The page is served
// from this server, shown in a sandboxed frame with no network access, and has a plain link the owner can open.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from './store.mjs'

export const MAX_PAGE_HTML = 300_000
export const MAX_PAGES = 100
const ID_RE = /^[a-f0-9]{12}$/
const fail = code => Object.assign(new Error(code), { code })

/** Validates the page Bob asked to publish and clamps the preview height. */
export function checkPage({ title, html, height } = {}) {
  const name = String(title ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!name) throw fail('BAD_TITLE')
  const body = String(html ?? '')
  if (!body.trim()) throw fail('EMPTY_PAGE')
  if (body.length > MAX_PAGE_HTML) throw fail('PAGE_TOO_LARGE')
  const n = Number(height)
  return { title: name, html: body, height: Number.isFinite(n) ? Math.min(800, Math.max(160, Math.round(n))) : 360 }
}

export class Pages {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'index.json')
    fs.mkdirSync(dir, { recursive: true })
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.items = [] }
    if (!Array.isArray(this.items)) this.items = []
  }

  save({ title, html, height }) {
    const page = { id: crypto.randomBytes(6).toString('hex'), title, height, at: Date.now() }
    writeAtomic(path.join(this.dir, `${page.id}.html`), html)
    this.items = [page, ...this.items]
    while (this.items.length > MAX_PAGES) {
      const old = this.items.pop()
      try { fs.rmSync(path.join(this.dir, `${old.id}.html`), { force: true }) } catch { /* already gone */ }
    }
    writeAtomic(this.file, JSON.stringify(this.items))
    return page
  }

  read(id) {
    if (!ID_RE.test(String(id ?? ''))) return null
    try { return fs.readFileSync(path.join(this.dir, `${id}.html`), 'utf8') } catch { return null }
  }

  list() { return this.items }
}
