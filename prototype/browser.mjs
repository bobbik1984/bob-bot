// One persistent headless Chromium, shared by the agent tools and the phone window.
import { spawn } from 'node:child_process'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import WebSocket from 'ws'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const isPrivateIp = ip => {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase()
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7))
    return low === '::1' || low === '::' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Allows only public http(s) targets, so the agent cannot reach this machine's own services. */
export async function assertPublicUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error(`Invalid URL: ${raw}`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages are allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address)
  if (addresses.some(isPrivateIp)) throw new Error('Local and private network addresses are blocked')
  return url.href
}

export class CloudBrowser {
  constructor(dataDir) {
    this.profile = path.join(dataDir, 'browser_profile')
    this.pending = new Map()
    this.nextId = 1
    this.onFrame = null
    this.viewport = { width: 430, height: 800 }
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
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  page(method, params) { return this.#send(method, params, this.session) }

  #dispatch(msg) {
    if (msg.id) {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
      return
    }
    if (msg.method === 'Page.screencastFrame' && msg.sessionId === this.session) {
      this.#send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, msg.sessionId).catch(() => {})
      this.onFrame?.(Buffer.from(msg.params.data, 'base64'))
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

  async #applyViewport() {
    await this.page('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 2, mobile: true })
  }

  #beginCast() {
    return this.page('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: this.viewport.width * 2, maxHeight: this.viewport.height * 2, everyNthFrame: 1,
    })
  }

  // ---- phone window ----
  async startCast(width, height) {
    this.viewport = { width: Math.min(Math.max(Math.round(width), 280), 1280), height: Math.min(Math.max(Math.round(height), 400), 1280) }
    await this.#applyViewport()
    await this.page('Page.stopScreencast').catch(() => {})
    this.casting = true
    await this.#beginCast()
  }

  async stopCast() {
    this.casting = false
    await this.page('Page.stopScreencast').catch(() => {})
  }

  async pointer(kind, nx, ny) {
    const x = nx * this.viewport.width
    const y = ny * this.viewport.height
    const type = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[kind]
    if (!type) return
    await this.page('Input.dispatchMouseEvent', {
      type, x, y, button: kind === 'move' ? 'none' : 'left', buttons: kind === 'up' ? 0 : 1, clickCount: kind === 'move' ? 0 : 1,
    })
  }

  async wheel(deltaY) {
    await this.page('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.viewport.width / 2, y: this.viewport.height / 2, deltaX: 0, deltaY,
    })
  }

  insertText(text) { return this.page('Input.insertText', { text }) }

  async pressKey(key) {
    const codes = { Enter: 13, Backspace: 8, Tab: 9 }
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
    const base = { ...box, button: 'left', clickCount: 1 }
    await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
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
