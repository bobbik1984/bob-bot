// Saved model providers. One profile is one endpoint, model and key the owner can switch between, so keeping a
// DeepSeek key and a Claude key no longer means typing the whole configuration again on every switch.
// Keys live in secrets.json, never here.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeAtomic } from './store.mjs'

export const MAX_PROVIDERS = 12
export const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/**
 * A preset only supplies defaults. Every field the owner can edit is copied into the saved profile, so changing a
 * preset later never silently changes a saved provider.
 */
export const PRESETS = {
  deepseek: { label: 'DeepSeek', kind: 'deepseek', api: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', contextWindow: 1000000, maxTokens: 8192, registryPrices: true },
  openai: { label: 'OpenAI', kind: 'openai', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', contextWindow: 128000, maxTokens: 16384 },
  anthropic: { label: 'Anthropic', kind: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', contextWindow: 200000, maxTokens: 8192 },
  google: { label: 'Google Gemini', kind: 'google', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', contextWindow: 1000000, maxTokens: 8192 },
  openrouter: { label: 'OpenRouter', kind: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', contextWindow: 200000, maxTokens: 8192 },
  custom: { label: '自定义端点', kind: 'custom', api: 'openai-completions', baseUrl: '', model: '', contextWindow: 128000, maxTokens: 8192 },
}

const ID_RE = /^p[0-9a-f]{12}$/
const fail = code => Object.assign(new Error(code), { code })
const clean = value => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
const integer = (value, fallback, max) => {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) throw fail('BAD_LIMIT')
  return n
}
const money = value => {
  const n = value === undefined || value === null || value === '' ? 0 : Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw fail('BAD_PRICE')
  return n
}

/**
 * Checks and normalises a profile from the page. Address reachability is checked by the server, which knows whether
 * a private test endpoint is allowed; this only enforces shape and the https rule.
 * @returns {{name:string,kind:string,api:string,baseUrl:string,model:string,inputUsd:number|null,outputUsd:number|null,contextWindow:number,maxTokens:number}}
 */
export function checkProfile(input, { allowHttp = false } = {}) {
  const kind = String(input?.kind ?? 'custom')
  const preset = PRESETS[kind]
  if (!preset) throw fail('BAD_KIND')
  const api = kind === 'custom' ? String(input?.api ?? preset.api) : preset.api
  if (!APIS.includes(api)) throw fail('BAD_API')
  const rawUrl = clean(input?.baseUrl ?? preset.baseUrl)
  if (kind !== 'deepseek') {
    const https = /^https:\/\/[^\s]+$/i.test(rawUrl)
    const httpTest = allowHttp && /^http:\/\/127\.0\.0\.1(?::\d+)?(\/[^\s]*)?$/.test(rawUrl)
    if (!https && !httpTest) throw fail('HTTPS_REQUIRED')
    if (rawUrl.length > 300) throw fail('BAD_ENDPOINT')
  }
  const model = clean(input?.model ?? preset.model)
  if (!model || model.length > 100 || /[\s\u0000-\u001f]/.test(model)) throw fail('BAD_MODEL')
  const name = clean(input?.name ?? preset.label).slice(0, 40) || preset.label
  const inputUsd = kind === 'deepseek' ? null : money(input?.inputUsd)
  const outputUsd = kind === 'deepseek' ? null : money(input?.outputUsd)
  if (kind !== 'deepseek' && inputUsd === 0 && outputUsd === 0) throw fail('BAD_PRICE') // a free model would never count toward the limit
  return {
    name, kind, api,
    baseUrl: kind === 'deepseek' ? preset.baseUrl : rawUrl.replace(/\/+$/, ''),
    model, inputUsd, outputUsd,
    contextWindow: integer(input?.contextWindow, preset.contextWindow, 10_000_000),
    maxTokens: integer(input?.maxTokens, preset.maxTokens, 1_000_000),
  }
}

export class Providers {
  constructor(file) {
    this.file = file
    let saved = null
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run or unreadable */ }
    this.state = saved && Array.isArray(saved.items) ? saved : null
  }

  get exists() { return this.state !== null }
  get items() { return this.state?.items ?? [] }
  get activeId() { return this.state?.activeId ?? null }
  get(id) { return this.items.find(p => p.id === id) ?? null }
  active() { return this.items.find(p => p.id === this.activeId) ?? this.items[0] ?? null }

  #newId() {
    let id
    do { id = `p${crypto.randomBytes(6).toString('hex')}` } while (this.get(id))
    return id
  }

  save() { writeAtomic(this.file, JSON.stringify({ activeId: this.state.activeId, items: this.state.items })) }

  /** Fills an empty store from an older single-model configuration. Returns false when profiles already exist. */
  seed(items, activeId = null, options = {}) {
    if (this.state) return false
    // Validate everything before touching the store, so one bad legacy profile cannot leave an empty one behind.
    const built = []
    for (const item of items) {
      const profile = checkProfile(item, options)
      const id = ID_RE.test(String(item?.id ?? '')) && !built.some(p => p.id === item.id) ? item.id : this.#newId()
      built.push({
        id, ...profile,
        ...(item?.legacyKey ? { legacyKey: String(item.legacyKey) } : {}),
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
      })
    }
    this.state = {
      activeId: built.some(p => p.id === activeId) ? activeId : built[0]?.id ?? null,
      items: built,
    }
    this.save()
    return true
  }

  add(input, options = {}) {
    if (this.items.length >= MAX_PROVIDERS) throw fail('TOO_MANY_PROVIDERS')
    const profile = checkProfile(input, options)
    const now = Date.now()
    const item = { id: this.#newId(), ...profile, createdAt: now, updatedAt: now }
    this.state.items.push(item)
    this.save()
    return item
  }

  update(id, input, options = {}) {
    const old = this.get(id)
    if (!old) throw fail('NO_PROVIDER')
    const profile = { ...old, ...checkProfile(input, options), updatedAt: Date.now() }
    this.state.items = this.items.map(p => p.id === id ? profile : p)
    this.save()
    return profile
  }

  activate(id) {
    if (!this.get(id)) throw fail('NO_PROVIDER')
    this.state.activeId = id
    this.save()
    return this.get(id)
  }

  remove(id) {
    const item = this.get(id)
    if (!item) throw fail('NO_PROVIDER')
    this.state.items = this.items.filter(p => p.id !== id)
    if (this.activeId === id) this.state.activeId = this.items[0]?.id ?? null
    this.save()
    return item
  }
}
