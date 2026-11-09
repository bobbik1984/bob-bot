// Runtime feature packages: small trusted modules under data/features that add tools, routes and a panel.
// A broken feature is skipped at startup instead of taking Bob down; installing one always needs approval.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NAME_RE = /^[a-z][a-z0-9-]{1,32}$/
const TOOL_RE = /^[a-z][a-z0-9_]{1,40}$/
const MAX_CODE = 60_000
const MAX_PANEL = 80_000
const SETUP_TIMEOUT_MS = 5000

const fail = code => Object.assign(new Error(code), { code })

export class Features {
  constructor(dir) {
    this.dir = dir
    this.items = new Map()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  list() {
    return [...this.items.values()].map(({ name, title, description, status, error, tools, routes, manifest }) => ({
      name, title, description, status, error,
      tools: tools.map(t => t.fullName),
      routes: routes.map(r => `${r.method} ${r.path}`),
      panel: manifest.panel ?? '',
    }))
  }

  /** Feature tools, renamed so they cannot collide with built-ins. */
  toolList() {
    return [...this.items.values()].flatMap(item => item.tools.map(tool => ({
      name: tool.fullName,
      description: `[${item.title}] ${tool.description}`,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    })))
  }

  findTool(fullName) {
    for (const item of this.items.values()) {
      const tool = item.tools.find(t => t.fullName === fullName)
      if (tool) return { item, tool }
    }
    return null
  }

  findRoute(name, method, subpath) {
    const item = this.items.get(name)
    if (!item) return null
    return item.routes.find(r => r.method === method && r.path === subpath) ?? null
  }

  panelFile(name, file) {
    const item = this.items.get(name)
    if (!item?.manifest.panel) return null
    if (!/^[\w.-]+\.html$/.test(file)) return null
    const full = path.join(item.dir, file)
    if (!fs.existsSync(full)) return null
    return full
  }

  async loadAll() {
    this.items.clear()
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try { await this.load(entry.name) } catch (error) { console.error(`[features] ${entry.name}: ${error.message}`) }
    }
  }

  async load(name) {
    if (!NAME_RE.test(name)) throw fail('BAD_FEATURE_NAME')
    const dir = path.join(this.dir, name)
    const manifestFile = path.join(dir, 'feature.json')
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { throw fail('BAD_MANIFEST') }
    const title = String(manifest.title ?? '').trim().slice(0, 40)
    if (!title) throw fail('BAD_MANIFEST')
    const item = {
      name, title,
      description: String(manifest.description ?? '').trim().slice(0, 200),
      manifest, dir, tools: [], routes: [], status: 'ok', error: '',
    }
    this.items.set(name, item)
    const ctx = {
      name,
      log: (...args) => console.log(`[feature:${name}]`, ...args),
      storage: this.#storage(name),
      registerTool: spec => this.#registerTool(item, spec),
      registerRoute: spec => this.#registerRoute(item, spec),
    }
    try {
      const module = await import(`${pathToFileURL(path.join(dir, 'server.mjs')).href}?v=${Date.now()}`)
      if (typeof module.default !== 'function') throw fail('NO_DEFAULT_EXPORT')
      await Promise.race([
        module.default(ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('setup timed out')), SETUP_TIMEOUT_MS)),
      ])
    } catch (error) {
      item.status = 'error'
      item.error = String(error?.message ?? error)
      console.error(`[features] ${name}: ${item.error}`)
    }
    return item
  }

  unload(name) { this.items.delete(name) }

  async install({ name, title, description = '', code, panelHtml = '' }) {
    if (!NAME_RE.test(String(name ?? ''))) throw fail('BAD_FEATURE_NAME')
    const cleanTitle = String(title ?? '').trim().slice(0, 40)
    if (!cleanTitle) throw fail('BAD_TITLE')
    const source = String(code ?? '')
    if (!source.trim() || !/export\s+default/.test(source)) throw fail('NO_DEFAULT_EXPORT')
    if (source.length > MAX_CODE) throw fail('CODE_TOO_LARGE')
    const panel = String(panelHtml ?? '')
    if (panel.length > MAX_PANEL) throw fail('PANEL_TOO_LARGE')
    const dir = path.join(this.dir, name)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify({
      name, title: cleanTitle, description: String(description ?? '').trim().slice(0, 200),
      ...(panel.trim() ? { panel: 'panel.html' } : {}),
    }), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'server.mjs'), source, { mode: 0o600 })
    if (panel.trim()) fs.writeFileSync(path.join(dir, 'panel.html'), panel, { mode: 0o600 })
    else fs.rmSync(path.join(dir, 'panel.html'), { force: true })
    this.unload(name)
    const item = await this.load(name)
    return item
  }

  remove(name) {
    if (!NAME_RE.test(String(name ?? ''))) throw fail('BAD_FEATURE_NAME')
    this.unload(name)
    fs.rmSync(path.join(this.dir, name), { recursive: true, force: true })
  }

  #registerTool(item, spec) {
    const name = String(spec?.name ?? '')
    if (!TOOL_RE.test(name)) throw fail('BAD_TOOL_NAME')
    if (typeof spec?.handler !== 'function') throw fail('BAD_TOOL_HANDLER')
    const fullName = `f_${item.name.replace(/-/g, '_')}_${name}`
    item.tools.push({
      name, fullName,
      description: String(spec.description ?? '').slice(0, 300),
      inputSchema: spec.inputSchema,
      handler: spec.handler,
    })
  }

  #registerRoute(item, spec) {
    const method = String(spec?.method ?? 'GET').toUpperCase()
    if (!['GET', 'POST'].includes(method)) throw fail('BAD_ROUTE_METHOD')
    const route = String(spec?.path ?? '')
    if (!route.startsWith('/') || route.includes('..')) throw fail('BAD_ROUTE_PATH')
    if (typeof spec?.handler !== 'function') throw fail('BAD_ROUTE_HANDLER')
    item.routes.push({ method, path: route, handler: spec.handler })
  }

  #storage(name) {
    const file = path.join(this.dir, name, 'storage.json')
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
    return {
      get: (key, fallback = null) => (key in read() ? read()[key] : fallback),
      set: (key, value) => {
        const data = read()
        data[key] = value
        fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
      },
      all: () => read(),
    }
  }
}
