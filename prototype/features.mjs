// Feature packages: how Bob changes himself without touching the core. A package can add server tools and routes,
// page widgets anywhere in the app, a settings panel and styling. Nothing in a package is trusted:
//   - its server code runs in plugin-host.mjs, a separate process that cannot read Bob's data or start programs;
//   - its widgets and panel are served to sandboxed frames that carry no login;
//   - its styling is scoped away from the approval cards and the trial control.
// A new or changed package starts as a trial. Unless the owner keeps it, it is undone: on a timer, if its code
// crashes, and when the server starts while a trial is still open.
import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from './store.mjs'

const HOST_FILE = fileURLToPath(new URL('./plugin-host.mjs', import.meta.url))
const NAME_RE = /^[a-z][a-z0-9-]{1,32}$/
const WIDGET_ID_RE = /^[a-z][a-z0-9-]{0,20}$/
const SELECTOR_RE = /^[#.][\w-]+(\s+[#.][\w-]+)?$/
const MAX_CODE = 60_000
const MAX_HTML = 80_000
const MAX_CSS = 30_000
const MAX_WIDGETS = 4
const MAX_HISTORY = 5
const LOAD_TIMEOUT_MS = 7000
const CALL_TIMEOUT_MS = 30_000

export const ANCHORS = ['header-right', 'home', 'clerk-top', 'settings-top']
export const PLACES = ['end', 'start', 'before', 'after']

const fail = code => Object.assign(new Error(code), { code })
const clamp = (value, low, high, fallback) => Math.min(high, Math.max(low, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback))

/** Styling is wrapped in a scope by the server, so it must not be able to close that scope or pull in other files. */
export function checkCss(input) {
  const css = String(input ?? '')
  if (css.length > MAX_CSS) throw fail('CSS_TOO_LARGE')
  if (/@import|<\/style/i.test(css)) throw fail('BAD_CSS')
  let depth = 0
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '')) {
    if (ch === '{') depth += 1
    if (ch === '}' && --depth < 0) throw fail('BAD_CSS')
  }
  if (depth !== 0) throw fail('BAD_CSS')
  return css
}

function checkWidgets(input) {
  const list = Array.isArray(input) ? input : []
  if (list.length > MAX_WIDGETS) throw fail('TOO_MANY_WIDGETS')
  const seen = new Set()
  return list.map(widget => {
    const id = String(widget?.id ?? '')
    if (!WIDGET_ID_RE.test(id) || seen.has(id)) throw fail('BAD_WIDGET_ID')
    seen.add(id)
    const anchor = String(widget.anchor ?? '').trim()
    if (!ANCHORS.includes(anchor) && !SELECTOR_RE.test(anchor)) throw fail('BAD_WIDGET_ANCHOR')
    const html = String(widget.html ?? '')
    if (!html.trim()) throw fail('EMPTY_WIDGET')
    if (html.length > MAX_HTML) throw fail('WIDGET_TOO_LARGE')
    return {
      id, anchor, html,
      place: PLACES.includes(widget.place) ? widget.place : 'end',
      width: clamp(widget.width, 20, 1200, anchor === 'header-right' ? 44 : 320),
      height: clamp(widget.height, 20, 600, anchor === 'header-right' ? 36 : 120),
    }
  })
}

export class Features {
  constructor(dir, { storageDir = path.join(path.dirname(dir), 'feature-storage'), onTrialEnd = () => {} } = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 })
    this.dir = fs.realpathSync(dir) // the permission flags compare real paths
    this.storageDir = fs.realpathSync(storageDir)
    this.historyDir = path.join(this.dir, '.history')
    this.trialFile = path.join(this.dir, '.trial.json')
    this.onTrialEnd = onTrialEnd
    this.items = new Map()
    this.host = null
    this.pending = new Map()
    this.nextId = 1
    this.trial = null
    this.trialTimer = null
  }

  list() {
    return [...this.items.values()].map(({ name, title, description, status, error, tools, routes, manifest }) => ({
      name, title, description, status, error,
      tools: tools.map(t => t.fullName),
      routes: routes.map(r => `${r.method} ${r.path}`),
      panel: manifest.panel ?? '',
      widgets: manifest.widgets ?? [],
      style: Boolean(manifest.style),
      trial: this.trial?.name === name,
      version: (() => { try { return Math.round(fs.statSync(path.join(this.dir, name, 'feature.json')).mtimeMs) } catch { return 0 } })(),
      hasPrevious: this.#versions(name).length > 0,
    }))
  }

  trialView() {
    return this.trial ? { name: this.trial.name, title: this.trial.title, until: this.trial.until, remainingMs: Math.max(0, this.trial.until - Date.now()) } : null
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

  async callTool(fullName, args) {
    const found = this.findTool(fullName)
    if (!found) throw fail('NO_FEATURE_TOOL')
    return this.#call({ op: 'tool', name: found.item.name, tool: found.tool.name, args })
  }

  hasRoute(name, method, subpath) {
    return Boolean(this.items.get(name)?.routes.some(r => r.method === method && r.path === subpath))
  }

  callRoute(name, method, subpath, { query = {}, body = null } = {}) {
    return this.#call({ op: 'route', name, method, path: subpath, query, body })
  }

  /** The text of a file a frame or the page may load: the panel, a widget, or the styling. */
  readFile(name, file) {
    const item = this.items.get(name)
    if (!item || item.status !== 'ok') return null
    const widget = /^widget-([a-z][a-z0-9-]{0,20})\.html$/.exec(file)
    const allowed = (file === 'panel.html' && item.manifest.panel) || (file === 'style.css' && item.manifest.style) ||
      (widget && item.manifest.widgets?.some(w => w.id === widget[1]))
    if (!allowed) return null
    try { return fs.readFileSync(path.join(item.dir, file), 'utf8') } catch { return null }
  }

  // ---- loading ----
  async loadAll() {
    this.items.clear()
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try { await this.load(entry.name) } catch (error) { console.error(`[features] ${entry.name}: ${error.message}`) }
    }
  }

  async load(name) {
    if (!NAME_RE.test(name)) throw fail('BAD_FEATURE_NAME')
    const dir = path.join(this.dir, name)
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'feature.json'), 'utf8')) } catch { throw fail('BAD_MANIFEST') }
    const title = String(manifest.title ?? '').trim().slice(0, 40)
    if (!title) throw fail('BAD_MANIFEST')
    const item = {
      name, title, manifest, dir,
      description: String(manifest.description ?? '').trim().slice(0, 200),
      hasServer: fs.existsSync(path.join(dir, 'server.mjs')),
      hosted: false, tools: [], routes: [], status: 'ok', error: '',
    }
    this.items.set(name, item)
    if (item.hasServer) await this.#loadServer(item, true)
    return item
  }

  async #loadServer(item, startHost) {
    try {
      const msg = { op: 'load', name: item.name, file: path.join(item.dir, 'server.mjs'), storageFile: path.join(this.storageDir, `${item.name}.json`) }
      const out = startHost ? await this.#call(msg, LOAD_TIMEOUT_MS) : await this.#send(msg, LOAD_TIMEOUT_MS)
      item.tools = out.tools.map(tool => ({ ...tool, fullName: `f_${item.name.replace(/-/g, '_')}_${tool.name}` }))
      item.routes = out.routes
      item.hosted = true
      item.status = 'ok'; item.error = ''
    } catch (error) {
      item.status = 'error'
      item.error = String(error?.message ?? error)
      console.error(`[features] ${item.name}: ${item.error}`)
    }
  }

  unload(name) {
    if (this.items.get(name)?.hosted && this.host) this.#send({ op: 'unload', name }, 2000).catch(() => {})
    this.items.delete(name)
  }

  // ---- the separate process that runs feature code ----
  async #ready() {
    if (this.host) return
    this.starting ??= (async () => {
      const dirArg = folder => `${folder}${path.sep}`
      const child = fork(HOST_FILE, [], {
        execArgv: ['--permission', `--allow-fs-read=${HOST_FILE}`, `--allow-fs-read=${dirArg(this.dir)}`, `--allow-fs-read=${dirArg(this.storageDir)}`,
          `--allow-fs-write=${dirArg(this.storageDir)}`, '--max-old-space-size=96'],
        env: {}, // no keys, no tokens, nothing from Bob's own environment
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      child.on('message', msg => {
        if (msg.log) return console.log(msg.log)
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        clearTimeout(waiter.timer)
        if (msg.error !== undefined) waiter.reject(new Error(msg.error))
        else waiter.resolve(msg.result)
      })
      child.on('exit', () => {
        if (this.host !== child) return
        this.host = null
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('The feature stopped unexpectedly.')) }
        this.pending.clear()
        for (const item of this.items.values()) item.hosted = false
        if (this.trial && !this.closing) this.endTrial(false, 'crashed').catch(() => {})
      })
      this.host = child
      // A fresh process knows nothing: give it back the features that were running before it stopped.
      for (const item of this.items.values()) if (item.hasServer && item.status === 'ok' && item.tools.length + item.routes.length > 0) await this.#loadServer(item, false)
    })().finally(() => { this.starting = null })
    return this.starting
  }

  #send(msg, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const host = this.host
      if (!host?.connected) return reject(new Error('The feature process is not running.'))
      const id = this.nextId++
      // Code that hangs is stopped along with its process, which is started again on the next call.
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The feature took too long and was stopped.')); host.kill('SIGKILL') }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      host.send({ ...msg, id })
    })
  }

  async #call(msg, timeoutMs) {
    await this.#ready()
    return this.#send(msg, timeoutMs)
  }

  stop() {
    this.closing = true
    clearTimeout(this.trialTimer)
    this.host?.kill()
  }

  // ---- earlier versions ----
  #versions(name) {
    try { return fs.readdirSync(path.join(this.historyDir, name)).sort() } catch { return [] }
  }

  /** Copies the installed version aside and returns where, or null when there is nothing installed. */
  #backup(name) {
    const dir = path.join(this.dir, name)
    if (!fs.existsSync(path.join(dir, 'feature.json'))) return null
    const target = path.join(this.historyDir, name, String(Date.now()))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.cpSync(dir, target, { recursive: true })
    for (const old of this.#versions(name).slice(0, -MAX_HISTORY)) fs.rmSync(path.join(this.historyDir, name, old), { recursive: true, force: true })
    return target
  }

  #putBack(name, from) {
    const dir = path.join(this.dir, name)
    fs.rmSync(dir, { recursive: true, force: true })
    if (!from || !fs.existsSync(from)) return false
    fs.cpSync(from, dir, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
    return true
  }

  /** Swaps the installed version with the one before it. */
  async restorePrevious(name) {
    if (!NAME_RE.test(String(name ?? ''))) throw fail('BAD_FEATURE_NAME')
    if (this.trial) throw fail('TRIAL_ACTIVE')
    const previous = this.#versions(name).at(-1)
    if (!previous) throw fail('NO_PREVIOUS')
    const from = path.join(this.historyDir, name, previous)
    this.unload(name)
    this.#backup(name)
    this.#putBack(name, from)
    return this.load(name)
  }

  // ---- installing ----
  /** With `trialMs` the package is undone after that long unless endTrial(true) is called first. */
  async install({ name, title, description = '', code = '', panelHtml = '', widgets = [], css = '' }, { trialMs = 0 } = {}) {
    if (!NAME_RE.test(String(name ?? ''))) throw fail('BAD_FEATURE_NAME')
    if (this.trial) throw fail('TRIAL_ACTIVE')
    const cleanTitle = String(title ?? '').trim().slice(0, 40)
    if (!cleanTitle) throw fail('BAD_TITLE')
    const source = String(code ?? '')
    if (source.trim() && !/export\s+default/.test(source)) throw fail('NO_DEFAULT_EXPORT')
    if (source.length > MAX_CODE) throw fail('CODE_TOO_LARGE')
    const panel = String(panelHtml ?? '')
    if (panel.length > MAX_HTML) throw fail('PANEL_TOO_LARGE')
    const frames = checkWidgets(widgets)
    const style = checkCss(css)
    if (!source.trim() && !panel.trim() && !frames.length && !style.trim()) throw fail('EMPTY_FEATURE')

    this.unload(name)
    const previous = this.#backup(name)
    const dir = path.join(this.dir, name)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (file, text) => fs.writeFileSync(path.join(dir, file), text, { mode: 0o600 })
    write('feature.json', JSON.stringify({
      name, title: cleanTitle, description: String(description ?? '').trim().slice(0, 200),
      ...(panel.trim() ? { panel: 'panel.html' } : {}),
      ...(frames.length ? { widgets: frames.map(({ html, ...rest }) => rest) } : {}),
      ...(style.trim() ? { style: true } : {}),
    }))
    if (source.trim()) write('server.mjs', source)
    if (panel.trim()) write('panel.html', panel)
    for (const frame of frames) write(`widget-${frame.id}.html`, frame.html)
    if (style.trim()) write('style.css', style)

    let item
    try { item = await this.load(name) } catch (error) { item = { status: 'error', error: error.message } }
    if (item.status === 'error') {
      this.unload(name)
      if (this.#putBack(name, previous)) await this.load(name).catch(() => {})
      throw Object.assign(fail('FEATURE_FAILED'), { detail: item.error })
    }
    if (trialMs > 0) this.#startTrial({ name, title: cleanTitle, until: Date.now() + trialMs, previous })
    return item
  }

  remove(name) {
    if (!NAME_RE.test(String(name ?? ''))) throw fail('BAD_FEATURE_NAME')
    if (this.trial?.name === name) throw fail('TRIAL_ACTIVE')
    this.unload(name)
    this.#backup(name)
    fs.rmSync(path.join(this.dir, name), { recursive: true, force: true })
    fs.rmSync(path.join(this.storageDir, `${name}.json`), { force: true })
  }

  // ---- trials ----
  #startTrial(trial) {
    this.trial = trial
    writeAtomic(this.trialFile, JSON.stringify(trial)) // on disk first, so a crash right now still undoes it at the next start
    this.trialTimer = setTimeout(() => this.endTrial(false, 'timeout').catch(error => console.error(`[features] undo failed: ${error.message}`)), Math.max(0, trial.until - Date.now()))
  }

  /** Keeps the package on trial, or puts back what was there before it. */
  async endTrial(keep, reason = keep ? 'kept' : 'rejected') {
    const trial = this.trial
    if (!trial) return null
    this.trial = null
    clearTimeout(this.trialTimer)
    if (!keep) {
      this.unload(trial.name)
      if (this.#putBack(trial.name, trial.previous)) await this.load(trial.name).catch(() => {})
    }
    fs.rmSync(this.trialFile, { force: true })
    this.onTrialEnd({ name: trial.name, title: trial.title, kept: keep, reason })
    return trial
  }

  /** At startup: a trial nobody answered before the server stopped is undone, never kept by accident. */
  recover() {
    let trial
    try { trial = JSON.parse(fs.readFileSync(this.trialFile, 'utf8')) } catch { return null }
    if (NAME_RE.test(String(trial?.name ?? ''))) {
      const inHistory = typeof trial.previous === 'string' && path.resolve(trial.previous).startsWith(this.historyDir + path.sep)
      this.#putBack(trial.name, inHistory ? trial.previous : null)
    }
    fs.rmSync(this.trialFile, { force: true })
    return trial
  }
}
