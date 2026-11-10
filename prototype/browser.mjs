// One persistent headless Chromium, shared by the agent tools and the phone window.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { assertPublicUrl } from './net-guard.mjs'

export { assertPublicUrl }

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
].filter(Boolean)

const MAX_TABS = 6
const MAX_FRAMES = 8
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
const MAX_DOWNLOADS_KEPT = 20
const READ_CHUNK = 12_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The functions below run inside the page, so they can use only their arguments and browser globals.

/** Numbers what can be used in this document, including open shadow roots and same-origin frames. */
function collectElements() {
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=textbox],[role=searchbox],[role=combobox],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[onclick],[contenteditable=""],[contenteditable=true]'
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim()
  const isSecret = el => el.tagName === 'INPUT' && (el.type === 'password' || /password|one-time|cc-/i.test(el.autocomplete || ''))
  const found = [], extra = []
  let scanned = 0, above = 0, below = 0
  const consider = (el, oy) => {
    const file = el.tagName === 'INPUT' && el.type === 'file'
    const listed = el.matches(SEL)
    const r = el.getBoundingClientRect()
    if (!file && (r.width < 2 || r.height < 2)) return
    if (!listed) {
      // Many sites build buttons from plain <div>s: the pointer cursor is the one sign they can be clicked.
      if (r.height > 120 || getComputedStyle(el).cursor !== 'pointer') return
      if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') return
      if (el.querySelector(SEL)) return
      const words = clean(el.innerText)
      if (!words || words.length > 60) return
    }
    const s = getComputedStyle(el)
    if (!file && (s.visibility === 'hidden' || s.display === 'none')) return
    if (el.disabled) return
    if (!file && r.bottom + oy < 0) { above++; return }
    if (!file && r.top + oy > innerHeight) { below++; return }
    if (found.length < 120) found.push(el)
  }
  const walk = (root, oy) => {
    for (const el of root.querySelectorAll('*')) {
      if (++scanned > 6000) return
      consider(el, oy)
      if (el.shadowRoot) {
        extra.push([...el.shadowRoot.children].map(c => c.innerText || '').join('\n'))
        walk(el.shadowRoot, oy)
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const doc = el.contentDocument
          if (doc?.documentElement) {
            extra.push(doc.body?.innerText ?? '')
            walk(doc, oy + el.getBoundingClientRect().top + el.clientTop)
          }
        } catch { /* a cross-origin frame is read through its own session */ }
      }
    }
  }
  walk(document, 0)
  window.__bb = found
  const items = found.map(el => {
    const tag = el.tagName.toLowerCase(), type = el.getAttribute('type') || ''
    const buttonLike = tag === 'input' && /^(submit|button|reset)$/i.test(type)
    const secret = isSecret(el)
    const name = clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || (tag === 'textarea' ? '' : el.innerText) || (buttonLike ? el.value : '') || el.placeholder || el.title || el.alt || el.getAttribute('name')).slice(0, 90)
    const state = []
    if (el.checked || el.getAttribute('aria-checked') === 'true') state.push('checked')
    if (el.getAttribute('aria-selected') === 'true') state.push('selected')
    if (el.getAttribute('aria-expanded') === 'true') state.push('expanded')
    if (secret) state.push(el.value ? 'filled' : 'empty')
    else if ((tag === 'input' && !buttonLike && !/^(checkbox|radio|file)$/i.test(type)) || tag === 'textarea') { if (el.value) state.push(`value: ${clean(el.value).slice(0, 60)}`) }
    const options = tag === 'select' ? [...el.options].slice(0, 30).map(o => (o.selected ? '*' : '') + clean(o.text).slice(0, 40)) : null
    return { tag, type, name, href: tag === 'a' ? el.href.slice(0, 100) : '', state, options, secret }
  })
  return { url: location.href, title: document.title, items, above, below, text: document.body ? document.body.innerText : '', extra: extra.filter(Boolean).join('\n\n') }
}

/** What the approval rules need to know about one numbered element. */
function describeElement(index) {
  const pick = () => {
    if (index !== null) return (window.__bb || [])[index]
    let el = document.activeElement
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
    return el && el !== document.body ? el : null
  }
  const el = pick()
  if (!el || !el.isConnected) return null
  const form = el.closest('form')
  const secret = el.tagName === 'INPUT' && (el.type === 'password' || /password|one-time|cc-/i.test(el.autocomplete || ''))
  return {
    text: (el.getAttribute('aria-label') || el.innerText || (secret ? '' : el.value) || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', inForm: !!form, secret,
    search: /search|搜索|query/i.test([el.type, el.getAttribute('role'), el.name, el.placeholder, el.getAttribute('aria-label'), form && form.getAttribute('role')].join(' ')),
  }
}

/** Scrolls an element into view and says where it is on screen and whether something else is on top of it. */
function locateElement(index) {
  const el = (window.__bb || [])[index]
  if (!el || !el.isConnected) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const root = el.getRootNode()
  const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y)
  const within = (node, parent) => { for (let n = node; n; n = n.parentNode || n.host) if (n === parent) return true; return false }
  const viaLabel = hit && [...(el.labels ?? [])].some(l => within(hit, l))
  const covered = hit && !within(hit, el) && !within(el, hit) && !viaLabel
  let ox = 0, oy = 0
  try {
    for (let w = el.ownerDocument.defaultView; w.frameElement; w = w.parent) {
      const f = w.frameElement, fr = f.getBoundingClientRect()
      ox += fr.left + f.clientLeft; oy += fr.top + f.clientTop
    }
  } catch { /* stops at a cross-origin parent, which is added from outside */ }
  return { x: x + ox, y: y + oy, covered: covered ? (hit.innerText || hit.getAttribute('aria-label') || hit.tagName).replace(/\s+/g, ' ').trim().slice(0, 60) : '' }
}

/** Focuses a field and selects what is in it, so the text typed next replaces it. */
function focusForTyping(index) {
  const el = window.__bb[index]
  el.focus()
  if (el.select) el.select()
  else if (el.isContentEditable) {
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    const chosen = el.ownerDocument.getSelection()
    chosen.removeAllRanges()
    chosen.addRange(range)
  }
}

function chooseOption(index, wanted) {
  const el = (window.__bb || [])[index]
  if (!el?.isConnected) return { error: 'stale' }
  if (el.tagName !== 'SELECT') return { error: 'not_select' }
  const clean = s => String(s).replace(/\s+/g, ' ').trim()
  const list = [...el.options]
  const option = list.find(o => o.value === wanted || clean(o.text) === wanted) ?? list.find(o => clean(o.text).toLowerCase().includes(wanted.toLowerCase()))
  if (!option) return { error: 'no_option', options: list.slice(0, 30).map(o => clean(o.text)) }
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, option.value) // frameworks watch this setter
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { chosen: clean(option.text) }
}

function readLinks() {
  const seen = new Set(), out = []
  for (const a of document.querySelectorAll('a[href]')) {
    if (seen.has(a.href) || !/^https?:/.test(a.href)) continue
    seen.add(a.href)
    out.push(`${(a.innerText || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)} -> ${a.href}`)
    if (out.length >= 400) break
  }
  return out.join('\n')
}

function readTables() {
  return [...document.querySelectorAll('table')].slice(0, 20).map((table, i) => `Table ${i + 1}\n` + [...table.rows].slice(0, 300)
    .map(row => [...row.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim()).join('\t')).join('\n')).join('\n\n')
}

function readText() {
  const parts = [document.body?.innerText ?? '']
  const walk = root => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { parts.push([...el.shadowRoot.children].map(c => c.innerText || '').join('\n')); walk(el.shadowRoot) }
      if (el.tagName === 'IFRAME') try { if (el.contentDocument?.body) { parts.push(el.contentDocument.body.innerText); walk(el.contentDocument) } } catch { /* cross-origin */ }
    }
  }
  walk(document)
  return parts.filter(Boolean).join('\n\n')
}

/** Runs in the page's parent frame, on the element that holds a cross-origin frame. */
function frameOwnerBox(scroll) {
  if (scroll) this.scrollIntoView({ block: 'center', behavior: 'instant' })
  const r = this.getBoundingClientRect()
  let x = r.left + this.clientLeft, y = r.top + this.clientTop
  try {
    for (let w = this.ownerDocument.defaultView; w.frameElement; w = w.parent) {
      const f = w.frameElement, fr = f.getBoundingClientRect()
      x += fr.left + f.clientLeft; y += fr.top + f.clientTop
    }
  } catch { /* the outer frame adds its own offset */ }
  return { x, y, width: r.width, height: r.height, onScreen: r.bottom > 0 && r.top < innerHeight }
}

export class CloudBrowser {
  /** `guard` decides which addresses documents may load from. Tests replace it to reach their own local pages. */
  constructor(dataDir, { guard = assertPublicUrl } = {}) {
    this.guard = guard
    this.profile = path.join(dataDir, 'browser_profile')
    this.downloadDir = path.join(dataDir, 'workspace', 'downloads')
    this.pending = new Map()
    this.nextId = 1
    this.onFrame = null
    this.modeFile = path.join(dataDir, 'browser-mode.json')
    // The browser looks like the owner's device: a phone gets mobile sites and touch, a PC gets desktop sites and a mouse.
    // With nobody connected, Bob browses the way the owner last did, or as a desktop when there is no history.
    const saved = (() => { try { return JSON.parse(fs.readFileSync(this.modeFile, 'utf8')) } catch { return {} } })()
    this.device = saved.device === 'phone' ? 'phone' : 'desktop'
    this.viewport = { width: saved.width ?? 1280, height: saved.height ?? 800 }
    this.scale = saved.scale ?? 1
    this.lang = saved.lang ?? 'en-US,en;q=0.9'
    this.chromeVersion = '120.0.0.0'
    this.casting = false
    this.lastInputAt = 0
    this.downloads = new Map()
    this.#reset()
  }

  #reset() {
    this.pages = []
    this.frames = new Map() // sessionId -> a cross-origin frame
    this.inflight = new Map() // sessionId -> requests still loading
    this.refs = [] // element number - 1 -> where that element lives
    this.ready = false
    this.notes = []
  }

  async start() {
    const exe = CANDIDATES.find(p => fs.existsSync(p))
    if (!exe) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.')
    this.dead = false
    fs.mkdirSync(this.profile, { recursive: true })
    fs.rmSync(path.join(this.profile, 'DevToolsActivePort'), { force: true })
    const args = [
      '--headless=new', `--user-data-dir=${this.profile}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=430,800',
    ]
    if (process.env.BOBBOT_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox')
    const proc = spawn(exe, args, { stdio: 'ignore' })
    this.proc = proc
    proc.on('exit', code => { if (this.proc === proc) { this.dead = true; console.error(`Chromium exited (${code})`) } })
    let endpoint
    for (let i = 0; i < 150 && !endpoint; i++) {
      await sleep(100)
      if (this.dead) throw new Error('Chromium exited during startup')
      try {
        const [port, wsPath] = fs.readFileSync(path.join(this.profile, 'DevToolsActivePort'), 'utf8').trim().split('\n')
        if (port && wsPath) endpoint = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`
      } catch { /* not written yet */ }
    }
    if (!endpoint) throw new Error('Timed out waiting for Chromium')
    const ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    this.ws = ws
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.on('message', raw => this.#dispatch(JSON.parse(raw)))
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.dead = true
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('The browser stopped unexpectedly.')) }
      this.pending.clear()
    })
    try { this.chromeVersion = /Chrome\/(\S+)/.exec((await this.#send('Browser.getVersion')).product)?.[1] ?? this.chromeVersion } catch { /* keep the default */ }
    fs.mkdirSync(this.downloadDir, { recursive: true })
    await this.#send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloadDir, eventsEnabled: true }).catch(() => {})
    await this.#send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = await this.#send('Target.getTargets')
    const first = targetInfos.find(t => t.type === 'page')
    const targetId = first?.targetId ?? (await this.#send('Target.createTarget', { url: 'about:blank' })).targetId
    await this.#adopt(targetId)
    this.ready = true
    console.log(`Chromium ready: ${path.basename(exe)}`)
  }

  /** Brings the browser back if it crashed, for example when the server ran short of memory. Login data is on disk. */
  async ensure() {
    if (!this.dead) return
    this.restarting ??= (async () => {
      try { this.proc?.kill('SIGKILL') } catch { /* already gone */ }
      await sleep(300)
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(this.profile, name), { force: true })
      this.#reset()
      await this.start()
    })().finally(() => { this.restarting = null })
    return this.restarting
  }

  /** Asks Chromium to exit cleanly so cookies reach disk, then falls back to killing it. */
  async close() {
    await Promise.race([this.#send('Browser.close').catch(() => {}), sleep(5000)])
    await sleep(500)
    try { this.proc?.kill() } catch { /* already gone */ }
  }

  #send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.dead || this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('The browser is restarting. Try again.'))
      const id = this.nextId++
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer, method })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  page(method, params) { return this.#send(method, params, this.session) }

  #dispatch(msg) {
    if (msg.id) {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${waiter.method})`))
      else waiter.resolve(msg.result)
      return
    }
    const { method, params, sessionId } = msg
    if (method === 'Page.screencastFrame' && sessionId === this.session) {
      // Chrome sends the next frame only after this ack, so acking once the viewer has taken the frame
      // makes a slow connection coalesce frames instead of dropping the last one.
      this.frameMeta = params.metadata
      const ack = () => this.#send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {})
      Promise.resolve(this.onFrame?.(Buffer.from(params.data, 'base64'))).then(ack, ack)
    } else if (method === 'Fetch.requestPaused') {
      this.#checkRequest(params, sessionId)
    } else if (method === 'Network.requestWillBeSent') {
      // Documents are left out: readyState covers them, and a frame in another process never reports finishing here.
      if (!['Document', 'EventSource', 'Ping', 'CSPViolationReport'].includes(params.type)) this.inflight.get(sessionId)?.add(params.requestId)
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.inflight.get(sessionId)?.delete(params.requestId)
    } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      this.inflight.get(sessionId)?.clear() // requests from the page that just went away will never finish
    } else if (method === 'Page.javascriptDialogOpening') {
      this.#answerDialog(params, sessionId)
    } else if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
      this.#adoptFrame(params, sessionId).catch(() => {})
    } else if (method === 'Target.detachedFromTarget') {
      this.frames.delete(params.sessionId)
    } else if (method === 'Target.targetCreated') {
      // Popups such as OAuth windows name their opener. A target=_blank link does not, so a tab that appears right
      // after a click counts too. Tabs the browser opens by itself (Edge does) stay out of the way.
      const info = params.targetInfo
      const fromInput = info.openerId || Date.now() - this.lastInputAt < 3000
      if (this.ready && fromInput && info.type === 'page' && !/^(chrome|edge|devtools):/.test(info.url) && !this.pages.some(p => p.targetId === info.targetId)) this.#adopt(info.targetId).catch(() => {})
    } else if (method === 'Target.targetDestroyed') {
      const closedActive = this.targetId === params.targetId
      const gone = this.pages.find(p => p.targetId === params.targetId)
      if (gone) this.inflight.delete(gone.sessionId)
      this.pages = this.pages.filter(p => p.targetId !== params.targetId)
      if (!closedActive || this.dead) return
      const previous = this.pages.at(-1)
      if (previous) this.#activate(previous).catch(() => {})
      else this.#send('Target.createTarget', { url: 'about:blank' }).then(r => this.#adopt(r.targetId)).catch(() => {})
    } else if (method === 'Browser.downloadWillBegin') {
      this.downloads.set(params.guid, { name: params.suggestedFilename, url: params.url, state: 'inProgress', bytes: 0, at: Date.now() })
    } else if (method === 'Browser.downloadProgress') {
      this.#trackDownload(params)
    }
  }

  /** Every document, including redirects, frames and links the agent clicks, must pass the address check. */
  #checkRequest({ requestId, request }, sessionId) {
    const allow = () => this.#send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {})
    if (/^(about|data|blob):/i.test(request.url)) return allow()
    this.guard(request.url).then(allow, error => {
      this.notes.push(`Blocked ${request.url.slice(0, 120)}: ${error.message}`)
      this.#send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {})
    })
  }

  /** A dialog freezes the page until it is answered. Nothing destructive is confirmed unless a person is at the window. */
  #answerDialog({ type, message }, sessionId) {
    const accept = type === 'alert' || type === 'beforeunload' || (type === 'confirm' && this.casting)
    this.#send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => {})
    this.notes.push(`The page showed a ${type} dialog (${accept ? 'accepted' : 'cancelled'}): ${String(message).slice(0, 200)}`)
  }

  #trackDownload({ guid, state, receivedBytes }) {
    const item = this.downloads.get(guid)
    if (!item) return
    item.state = state
    item.bytes = receivedBytes
    if (state === 'inProgress' && receivedBytes > MAX_DOWNLOAD_BYTES) {
      this.#send('Browser.cancelDownload', { guid }).catch(() => {})
      item.tooBig = true
    }
    if (state === 'completed') {
      const safe = path.basename(String(item.name)).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'download'
      let name = safe
      for (let n = 2; fs.existsSync(path.join(this.downloadDir, name)); n++) name = `${n}-${safe}`
      try { fs.renameSync(path.join(this.downloadDir, guid), path.join(this.downloadDir, name)); item.saved = `downloads/${name}` } catch { item.state = 'canceled' }
    } else if (state === 'canceled') fs.rmSync(path.join(this.downloadDir, guid), { force: true })
    const finished = [...this.downloads].filter(([, d]) => d.state !== 'inProgress')
    for (const [id, old] of finished.slice(0, Math.max(0, finished.length - MAX_DOWNLOADS_KEPT))) {
      if (old.saved) fs.rmSync(path.join(this.downloadDir, path.basename(old.saved)), { force: true })
      this.downloads.delete(id)
    }
  }

  async #prepare(sessionId) {
    await this.#send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, sessionId).catch(() => {})
    await this.#send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {})
    await this.#send('DOM.enable', {}, sessionId).catch(() => {})
  }

  async #adoptFrame({ sessionId, targetInfo }, parentSession) {
    if (this.frames.size >= MAX_FRAMES * MAX_TABS) return
    this.frames.set(sessionId, { sessionId, targetId: targetInfo.targetId, parentSession })
    await this.#prepare(sessionId)
  }

  async #adopt(targetId) {
    const { sessionId } = await this.#send('Target.attachToTarget', { targetId, flatten: true })
    const page = { targetId, sessionId }
    this.pages.push(page)
    this.inflight.set(sessionId, new Set())
    await this.#send('Page.enable', {}, sessionId)
    await this.#send('Runtime.enable', {}, sessionId)
    await this.#send('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 500_000 }, sessionId).catch(() => {})
    await this.#prepare(sessionId)
    await this.#activate(page)
    // Each tab costs memory on a small server, so the oldest ones go first.
    while (this.pages.length > MAX_TABS) {
      const oldest = this.pages.find(p => p.targetId !== this.targetId)
      this.pages = this.pages.filter(p => p !== oldest)
      await this.#send('Target.closeTarget', { targetId: oldest.targetId }).catch(() => {})
    }
  }

  async #activate(page) {
    if (this.casting) await this.page('Page.stopScreencast').catch(() => {})
    this.targetId = page.targetId
    this.session = page.sessionId
    this.refs = []
    await this.#applyViewport()
    if (this.casting) await this.#beginCast()
  }

  #userAgent() {
    const phone = this.device === 'phone'
    const major = this.chromeVersion.split('.')[0]
    return {
      userAgent: phone
        ? `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Mobile Safari/537.36`
        : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`,
      acceptLanguage: this.lang,
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not-A.Brand', version: '24' }],
        fullVersion: this.chromeVersion, platform: phone ? 'Android' : 'Linux', platformVersion: phone ? '13.0.0' : '6.5.0',
        architecture: phone ? '' : 'x86', model: phone ? 'Pixel 7' : '', mobile: phone,
      },
    }
  }

  /** Size, scale, user agent and touch support for the current page, all matching the device. */
  async #applyViewport() {
    const phone = this.device === 'phone'
    await this.page('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: this.scale, mobile: phone })
    // The look of the device matters, but a failure here must never stop the browser from starting.
    await this.page('Emulation.setUserAgentOverride', this.#userAgent()).catch(() => {})
    await this.page('Emulation.setTouchEmulationEnabled', phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }).catch(() => {})
  }

  /** Chrome sometimes says the tab is not active for a moment after it opens, so bring it forward and try again. */
  async #beginCast() {
    const { width, height } = this.viewport
    const params = { format: 'jpeg', quality: width * this.scale > 1400 ? 50 : 60, maxWidth: Math.round(width * this.scale), maxHeight: Math.round(height * this.scale), everyNthFrame: 1 }
    for (let attempt = 0; ; attempt++) {
      await this.page('Page.bringToFront').catch(() => {})
      try { return await this.page('Page.startScreencast', params) } catch (error) {
        if (attempt >= 5 || !/active page/i.test(error.message)) throw error
        await sleep(300)
      }
    }
  }

  // ---- the owner's window ----
  /**
   * `device` is "phone" (mobile site, touch) or "desktop" (desktop site, mouse). width and height are what the page
   * should be laid out at, in CSS pixels, and dpr is how sharp the frames should be.
   */
  async startCast(width, height, { device = 'desktop', dpr = 1, lang } = {}) {
    await this.ensure()
    const next = device === 'phone' ? 'phone' : 'desktop'
    const clamp = (v, lo, hi) => Math.min(Math.max(Math.round(v), lo), hi)
    const viewport = { width: clamp(width, 280, 2560), height: clamp(height, 300, 2560) }
    const scale = Math.min(Math.max(Number(dpr) || 1, 1), 2)
    const language = typeof lang === 'string' && /^[\w,;.= -]{2,100}$/.test(lang) ? lang : this.lang
    const changedKind = next !== this.device || language !== this.lang
    this.device = next; this.viewport = viewport; this.scale = scale; this.lang = language
    fs.writeFile(this.modeFile, JSON.stringify({ device: next, ...viewport, scale, lang: language }), () => {})
    await this.#applyViewport()
    if (changedKind) await this.page('Page.reload').catch(() => {}) // sites choose their mobile or desktop version when the page loads
    await this.page('Page.stopScreencast').catch(() => {})
    this.casting = true
    await this.#beginCast()
  }

  async stopCast() {
    this.casting = false
    await this.page('Page.stopScreencast').catch(() => {})
  }

  /**
   * Pages without a mobile viewport tag are laid out wider than the phone (often 980px) and shown scaled down.
   * Input events use layout pixels, so screen positions must be divided by the page scale Chrome reports per frame.
   */
  #pageScale() {
    const scale = this.frameMeta?.pageScaleFactor
    return scale > 0 ? scale : 1
  }

  /** `kind` is down, move, up, or hover (a mouse moving with no button down). A phone gets touch events, a PC gets mouse events. */
  async pointer(kind, nx, ny) {
    this.lastInputAt = Date.now()
    const scale = this.#pageScale()
    const x = (nx * this.viewport.width) / scale
    const y = (ny * this.viewport.height) / scale
    if (this.device === 'phone') {
      const type = { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[kind]
      if (type) await this.page('Input.dispatchTouchEvent', { type, touchPoints: kind === 'up' ? [] : [{ x, y, id: 1 }] })
      return
    }
    const type = { down: 'mousePressed', move: 'mouseMoved', hover: 'mouseMoved', up: 'mouseReleased' }[kind]
    if (!type) return
    const pressed = kind === 'down' || kind === 'move'
    await this.page('Input.dispatchMouseEvent', {
      type, x, y, button: pressed || kind === 'up' ? 'left' : 'none', buttons: pressed ? 1 : 0, clickCount: kind === 'down' || kind === 'up' ? 1 : 0,
    })
  }

  async wheel(deltaY, deltaX = 0) {
    const scale = this.#pageScale()
    await this.page('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.viewport.width / 2 / scale, y: this.viewport.height / 2 / scale, deltaX, deltaY,
    })
  }

  /** A tap or click at layout coordinates, the way the owner's device would deliver it. */
  async tapAt(x, y) {
    this.lastInputAt = Date.now()
    if (this.device === 'phone') {
      await this.page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      await this.page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return
    }
    const base = { x, y, button: 'left', clickCount: 1 }
    await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  }

  insertText(text) { return this.page('Input.insertText', { text }) }

  async pressKey(key) {
    const codes = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 }
    if (!codes[key]) return
    this.lastInputAt = Date.now()
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] }
    await this.page('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    if (key === 'Enter') await this.page('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' })
    await this.page('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  // ---- agent primitives ----
  async #evaluateIn(sessionId, expression) {
    const out = await this.#send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'Page script failed')
    return out.result.value
  }

  #call(sessionId, fn, ...args) {
    return this.#evaluateIn(sessionId, `(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`)
  }

  evaluate(expression) { return this.#evaluateIn(this.session, expression) }

  /** Throws the address-check reason rather than Chromium's generic error, so the model knows not to retry. */
  async navigate(url) {
    await this.ensure()
    const nav = await this.page('Page.navigate', { url: await this.guard(url) })
    if (nav.errorText) throw new Error(`Navigation failed: ${nav.errorText}`)
    await this.settle()
  }

  async back() {
    const { currentIndex, entries } = await this.page('Page.getNavigationHistory')
    if (currentIndex < 1) throw new Error('There is no earlier page in this tab.')
    await this.page('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id })
    await this.settle()
  }

  /** Waits for the document and its requests to go quiet. After a while one open request is tolerated, for long-polling pages. */
  async settle(maxMs = 6000) {
    const started = Date.now()
    const deadline = started + maxMs
    let quietSince = 0
    while (Date.now() < deadline) {
      await sleep(100)
      let complete = false
      try { complete = await this.evaluate('document.readyState') === 'complete' } catch { /* navigating */ }
      if (complete && (this.inflight.get(this.session)?.size ?? 0) <= (Date.now() - started > 2500 ? 1 : 0)) {
        quietSince ||= Date.now()
        if (Date.now() - quietSince >= 500) return
      } else quietSince = 0
    }
  }

  screenshot() {
    return this.page('Page.captureScreenshot', { format: 'jpeg', quality: 50 }).then(r => r.data)
  }

  /** Cross-origin frames of the current tab, each with its place on the page. */
  async #visibleFrames() {
    const inTab = frame => {
      let f = frame
      while (this.frames.has(f.parentSession)) f = this.frames.get(f.parentSession)
      return f.parentSession === this.session
    }
    const out = []
    for (const frame of this.frames.values()) {
      if (out.length >= MAX_FRAMES || !inTab(frame)) continue
      const box = await this.#frameBox(frame).catch(() => null)
      if (box && box.width >= 20 && box.height >= 20 && box.onScreen) out.push(frame)
    }
    return out
  }

  /** Where a cross-origin frame's content starts, adding up every frame around it. */
  async #frameBox(frame, scroll = false) {
    const { backendNodeId } = await this.#send('DOM.getFrameOwner', { frameId: frame.targetId }, frame.parentSession)
    const { object } = await this.#send('DOM.resolveNode', { backendNodeId }, frame.parentSession)
    const out = await this.#send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: frameOwnerBox.toString(), arguments: [{ value: scroll }], returnByValue: true }, frame.parentSession)
    const box = out.result.value
    const outer = this.frames.get(frame.parentSession)
    if (outer) {
      const up = await this.#frameBox(outer, scroll)
      box.x += up.x; box.y += up.y
    }
    return box
  }

  /** Numbers the visible interactive elements in the page and its frames, and returns a compact text view. */
  async snapshot() {
    await this.ensure()
    const main = await this.#call(this.session, collectElements)
    const refs = main.items.map((item, index) => ({ session: this.session, index, item }))
    const texts = [main.text.replace(/\n{3,}/g, '\n\n').slice(0, 6000)]
    if (main.extra) texts.push(main.extra.replace(/\n{3,}/g, '\n\n').slice(0, 2000))
    for (const frame of await this.#visibleFrames()) {
      const got = await this.#call(frame.sessionId, collectElements).catch(() => null)
      if (!got) continue
      got.items.forEach((item, index) => { if (refs.length < 120) refs.push({ session: frame.sessionId, frame, index, item, inFrame: true }) })
      if (got.text.trim()) texts.push(`[Frame ${got.url.slice(0, 80)}]\n${got.text.replace(/\n{3,}/g, '\n\n').slice(0, 1500)}`)
    }
    this.refs = refs
    const lines = refs.map(({ item, inFrame }, i) => {
      const options = item.options ? ` options: ${item.options.join(' | ')}` : ''
      const state = item.state.length ? ` (${item.state.join(', ')})` : ''
      return `[${i + 1}] <${item.tag}${item.type ? ` type=${item.type}` : ''}> "${item.name}"${item.href ? ` -> ${item.href}` : ''}${state}${options}${inFrame ? ' [in frame]' : ''}`
    })
    if (main.above) lines.unshift(`(${main.above} more above; scroll up to reach them)`)
    if (main.below) lines.push(`(${main.below} more below; scroll down to reach them)`)
    const notes = this.notes.splice(0)
    if (refs.some(r => r.item.secret)) notes.push('This page asks for a password or code. Call browser_request_human; never type these yourself.')
    const tabs = this.pages.length > 1 ? `\nOpen tabs: ${this.pages.length} (browser_tabs lists them)` : ''
    return `URL: ${main.url}\nTitle: ${main.title}${tabs}${notes.length ? `\n\nNotes:\n${notes.join('\n')}` : ''}\n\nInteractive elements:\n${lines.join('\n')}\n\nPage text:\n${texts.join('\n\n')}`
  }

  #ref(id) {
    const ref = this.refs[Number(id) - 1]
    if (!ref) throw new Error('That element number is out of date. Call browser_snapshot and use a fresh number.')
    return ref
  }

  async describe(id) {
    const ref = this.refs[Number(id) - 1]
    if (!ref) return null
    return this.#call(ref.session, describeElement, ref.index).catch(() => null)
  }

  /** The element with keyboard focus, or null when focus is on the page or inside a cross-origin frame. */
  focused() { return this.#call(this.session, describeElement, null).catch(() => null) }

  async #point(ref) {
    const outer = ref.frame ? await this.#frameBox(ref.frame, true) : null
    const spot = await this.#call(ref.session, locateElement, ref.index)
    if (!spot) throw new Error('That element number is out of date. Call browser_snapshot and use a fresh number.')
    if (spot.covered) throw new Error(`Something is on top of that element: "${spot.covered}". Close it first, or call browser_snapshot to see the page again.`)
    if (ref.frame) await sleep(200) // Chrome routes input to a frame from its compositor, which lags just after a scroll
    const box = ref.frame ? await this.#frameBox(ref.frame) : outer
    return { x: spot.x + (box?.x ?? 0), y: spot.y + (box?.y ?? 0) }
  }

  async click(id) {
    const { x, y } = await this.#point(this.#ref(id))
    await this.tapAt(x, y)
    await this.settle()
  }

  async hover(id) {
    const { x, y } = await this.#point(this.#ref(id))
    await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(400)
  }

  async type(id, text, pressEnter) {
    const ref = this.#ref(id)
    await this.#call(ref.session, focusForTyping, ref.index)
    await this.insertText(text)
    if (pressEnter) { await this.pressKey('Enter'); await this.settle() }
  }

  async select(id, value) {
    const ref = this.#ref(id)
    const out = await this.#call(ref.session, chooseOption, ref.index, String(value))
    if (out.error === 'stale') throw new Error('That element number is out of date. Call browser_snapshot and use a fresh number.')
    if (out.error === 'not_select') throw new Error('That element is not a dropdown. Click it and choose from what appears.')
    if (out.error === 'no_option') throw new Error(`No such option. Available: ${out.options.join(' | ')}`)
    await this.settle(2000)
    return out.chosen
  }

  /** Attaches a file on this server to a numbered file input. */
  async upload(id, file) {
    const ref = this.#ref(id)
    const { result } = await this.#send('Runtime.evaluate', { expression: `window.__bb[${ref.index}]` }, ref.session)
    await this.#send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId }, ref.session)
    await this.settle(2000)
  }

  async scroll(direction) {
    await this.wheel(direction === 'up' ? -this.viewport.height * 0.8 : this.viewport.height * 0.8)
    await sleep(500)
  }

  /** Waits until some text appears on the page, or for a number of seconds when no text is given. */
  async waitFor(text, seconds = 5) {
    const limit = Math.min(Math.max(Number(seconds) || 5, 1), 20) * 1000
    if (!text) { await sleep(limit); return true }
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
      if ((await this.#allText().catch(() => '')).includes(text)) return true
      await sleep(400)
    }
    return false
  }

  async #allText() {
    const parts = [await this.#call(this.session, readText)]
    for (const frame of await this.#visibleFrames()) parts.push(await this.#call(frame.sessionId, readText).catch(() => ''))
    return parts.filter(Boolean).join('\n\n')
  }

  /** The whole page as text, links or tables, in pieces, for content too long for a snapshot. */
  async read(what = 'text', offset = 0) {
    await this.ensure()
    const all = what === 'links' ? await this.#call(this.session, readLinks)
      : what === 'tables' ? await this.#call(this.session, readTables)
        : (await this.#allText()).replace(/\n{3,}/g, '\n\n')
    const from = Math.max(0, Math.floor(Number(offset) || 0))
    const piece = all.slice(from, from + READ_CHUNK)
    const next = from + piece.length
    return `${piece || `(no ${what} found)`}${next < all.length ? `\n\n[${all.length - next} more characters. Continue with offset ${next}.]` : ''}`
  }

  async tabs() {
    const { targetInfos } = await this.#send('Target.getTargets')
    return this.pages.map((p, i) => {
      const info = targetInfos.find(t => t.targetId === p.targetId)
      return `${i + 1}${p.targetId === this.targetId ? ' (current)' : ''}: ${info?.title || '(no title)'} - ${info?.url ?? ''}`
    }).join('\n')
  }

  #tab(index) {
    const page = this.pages[Number(index) - 1]
    if (!page) throw new Error('No tab with that number. Call browser_tabs.')
    return page
  }

  async switchTab(index) {
    await this.#activate(this.#tab(index))
    await this.page('Page.bringToFront').catch(() => {})
  }

  async closeTab(index) {
    const page = this.#tab(index)
    if (this.pages.length === 1) throw new Error('This is the only tab.')
    await this.#send('Target.closeTarget', { targetId: page.targetId })
    await sleep(200)
  }

  listDownloads() {
    const items = [...this.downloads.values()]
    if (!items.length) return 'No downloads yet.'
    return items.map(d => d.saved ? `${d.saved} (${Math.round(d.bytes / 1024)} KB), readable with read_file if it is text`
      : d.tooBig ? `${d.name}: stopped, larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`
        : `${d.name}: ${d.state}`).join('\n')
  }
}
