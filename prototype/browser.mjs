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
].filter(Boolean)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class CloudBrowser {
  constructor(dataDir) {
    this.profile = path.join(dataDir, 'browser_profile')
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
    this.pages = []
  }

  async start() {
    const exe = CANDIDATES.find(p => fs.existsSync(p))
    if (!exe) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.')
    fs.mkdirSync(this.profile, { recursive: true })
    fs.rmSync(path.join(this.profile, 'DevToolsActivePort'), { force: true })
    const args = [
      '--headless=new', `--user-data-dir=${this.profile}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=430,800',
    ]
    if (process.env.BOBBOT_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox')
    this.proc = spawn(exe, args, { stdio: 'ignore' })
    this.proc.on('exit', code => { this.dead = true; console.error(`Chromium exited (${code})`) })
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
    this.ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject) })
    this.ws.on('message', raw => this.#dispatch(JSON.parse(raw)))
    try { this.chromeVersion = /Chrome\/(\S+)/.exec((await this.#send('Browser.getVersion')).product)?.[1] ?? this.chromeVersion } catch { /* keep the default */ }
    await this.#send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = await this.#send('Target.getTargets')
    const first = targetInfos.find(t => t.type === 'page')
    const targetId = first?.targetId ?? (await this.#send('Target.createTarget', { url: 'about:blank' })).targetId
    await this.#adopt(targetId)
    console.log(`Chromium ready: ${path.basename(exe)}`)
  }

  /** Asks Chromium to exit cleanly so cookies reach disk, then falls back to killing it. */
  async close() {
    await Promise.race([this.#send('Browser.close').catch(() => {}), sleep(5000)])
    await sleep(500)
    try { this.proc?.kill() } catch { /* already gone */ }
  }

  #send(method, params = {}, sessionId) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer, method })
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
    if (msg.method === 'Page.screencastFrame' && msg.sessionId === this.session) {
      // Chrome sends the next frame only after this ack, so acking once the viewer has taken the frame
      // makes a slow connection coalesce frames instead of dropping the last one.
      this.frameMeta = msg.params.metadata
      const ack = () => this.#send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, msg.sessionId).catch(() => {})
      Promise.resolve(this.onFrame?.(Buffer.from(msg.params.data, 'base64'))).then(ack, ack)
    } else if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page' && msg.params.targetInfo.openerId) {
      // Popups such as OAuth windows become the active page.
      this.#adopt(msg.params.targetInfo.targetId).catch(() => {})
    } else if (msg.method === 'Target.targetDestroyed') {
      const closedActive = this.targetId === msg.params.targetId
      this.pages = this.pages.filter(p => p.targetId !== msg.params.targetId)
      const previous = this.pages.at(-1)
      if (closedActive && previous) this.#activate(previous).catch(() => {})
    }
  }

  async #adopt(targetId) {
    const { sessionId } = await this.#send('Target.attachToTarget', { targetId, flatten: true })
    const page = { targetId, sessionId }
    this.pages.push(page)
    await this.#send('Page.enable', {}, sessionId)
    await this.#send('Runtime.enable', {}, sessionId)
    await this.#activate(page)
  }

  async #activate(page) {
    if (this.casting) await this.page('Page.stopScreencast').catch(() => {})
    this.targetId = page.targetId
    this.session = page.sessionId
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
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] }
    await this.page('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    if (key === 'Enter') await this.page('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' })
    await this.page('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  // ---- agent primitives ----
  async evaluate(expression) {
    const out = await this.page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'Page script failed')
    return out.result.value
  }

  async navigate(url) {
    const nav = await this.page('Page.navigate', { url: await assertPublicUrl(url) })
    if (nav.errorText) throw new Error(`Navigation failed: ${nav.errorText}`)
    await this.settle()
  }

  /** Waits until the document has loaded, with a bounded pause for late rendering. */
  async settle() {
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      try { if (await this.evaluate('document.readyState') === 'complete') break } catch { /* navigating */ }
    }
    await sleep(600)
  }

  screenshot() {
    return this.page('Page.captureScreenshot', { format: 'jpeg', quality: 50 }).then(r => r.data)
  }

  /** Numbers the visible interactive elements and returns a compact text view of the page. */
  snapshot() {
    return this.evaluate(`(() => {
      const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox],[role=searchbox],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable=""],[contenteditable=true]';
      const seen = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none' || el.disabled) continue;
        if (r.bottom < 0 || r.top > innerHeight) continue;
        seen.push(el);
        if (seen.length >= 120) break;
      }
      window.__bb = seen;
      const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
      const lines = seen.map((el, i) => {
        const tag = el.tagName.toLowerCase(), type = el.getAttribute('type'), href = tag === 'a' ? ' -> ' + el.href.slice(0, 100) : '';
        return '[' + (i + 1) + '] <' + tag + (type ? ' type=' + type : '') + '> "' + label(el) + '"' + href;
      });
      const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
      return 'URL: ' + location.href + '\\nTitle: ' + document.title + '\\n\\nInteractive elements:\\n' + lines.join('\\n') + '\\n\\nPage text:\\n' + text;
    })()`)
  }

  describe(id) {
    return this.evaluate(`(() => {
      const el = (window.__bb || [])[${Number(id) - 1}];
      if (!el || !el.isConnected) return null;
      const form = el.closest('form');
      return { text: (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', inForm: !!form,
        search: /search|搜索|query/i.test([el.type, el.getAttribute('role'), el.name, el.placeholder, el.getAttribute('aria-label'), form && form.getAttribute('role')].join(' ')) };
    })()`)
  }

  async click(id) {
    const box = await this.evaluate(`(() => {
      const el = window.__bb[${Number(id) - 1}];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    await this.tapAt(box.x, box.y)
    await this.settle()
  }

  async type(id, text, pressEnter) {
    await this.evaluate(`(() => { const el = window.__bb[${Number(id) - 1}]; el.focus(); if (el.select) el.select(); })()`)
    await this.insertText(text)
    if (pressEnter) { await this.pressKey('Enter'); await this.settle() }
  }

  async scroll(direction) {
    await this.wheel(direction === 'up' ? -this.viewport.height * 0.8 : this.viewport.height * 0.8)
    await sleep(500)
  }
}
