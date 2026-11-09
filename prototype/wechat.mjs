// Optional WeChat bridge. Personal WeChat login runs in a separate child process with its own node_modules,
// and talks to Bob over a loopback-only endpoint. If WeChat breaks, Bob keeps working.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const WECHAT_PACKAGES = ['wechaty@1.20.2', 'wechaty-puppet-wechat4u@1.14.14']

export class WeChat {
  constructor(dir, port) {
    this.dir = dir
    this.home = path.join(dir, 'wechat')
    this.file = path.join(dir, 'wechat.json')
    this.port = port
    this.proc = null
    this.state = 'off' // off | starting | qr | online | error
    this.qr = ''
    this.qrImage = ''
    this.name = ''
    this.error = ''
    this.log = ''
    this.installing = false
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { /* first run */ }
    this.secret = saved.secret || crypto.randomBytes(32).toString('hex')
    this.#save()
  }

  #save() { try { fs.writeFileSync(this.file, JSON.stringify({ secret: this.secret }), { mode: 0o600 }) } catch { /* read only */ } }

  get installed() { return fs.existsSync(path.join(this.home, 'node_modules', 'wechaty')) }

  status() {
    return { installed: this.installed, state: this.installing ? 'installing' : this.state, qr: this.qrImage, name: this.name, error: this.error, log: this.log.slice(-600) }
  }

  /** Installs the WeChat packages beside Bob's own dependencies, so they can never change Bob's node_modules. */
  install() {
    if (this.installing) return
    this.installing = true
    this.log = ''
    fs.mkdirSync(this.home, { recursive: true })
    if (!fs.existsSync(path.join(this.home, 'package.json'))) fs.writeFileSync(path.join(this.home, 'package.json'), JSON.stringify({ name: 'bobbot-wechat', private: true }))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|^BOBBOT_|^DEEPSEEK_/i.test(key)) delete env[key]
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...WECHAT_PACKAGES], { cwd: this.home, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const add = chunk => { this.log += chunk.toString() }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    child.on('error', error => { this.installing = false; this.state = 'error'; this.error = error.message })
    child.on('close', code => {
      this.installing = false
      if (code !== 0) { this.state = 'error'; this.error = `npm install exited ${code}` }
      else this.state = 'off'
    })
  }

  start() {
    if (this.proc) return
    if (!this.installed) { this.state = 'error'; this.error = 'NOT_INSTALLED'; throw new Error('NOT_INSTALLED') }
    this.state = 'starting'
    this.error = ''
    this.qr = ''
    this.qrImage = ''
    this.log = ''
    this.proc = spawn(process.execPath, [path.join(here, 'wechat-bridge.mjs')], {
      cwd: this.home,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WECHAT_HOME: this.home, BOBBOT_URL: `http://127.0.0.1:${this.port}`, WECHAT_SECRET: this.secret },
    })
    let buffer = ''
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', chunk => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        try { this.#event(JSON.parse(line)) } catch { /* ignore） */ }
      }
    })
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', text => { this.log += text })
    this.proc.on('exit', code => {
      this.proc = null
      if (this.state === 'off') return
      this.state = 'error'
      this.error = `bridge exited (${code})`
    })
  }

  #event(message) {
    if (message.type === 'qr') { this.state = 'qr'; this.qr = message.qr; this.qrImage = '' }
    else if (message.type === 'status' && message.state === 'online') { this.state = 'online'; this.name = message.name ?? ''; this.qr = ''; this.qrImage = '' }
    else if (message.type === 'status' && message.state === 'offline') { this.state = 'off'; this.qr = ''; this.qrImage = ''; this.name = '' }
    else if (message.type === 'error') { this.state = 'error'; this.error = message.message ?? 'error' }
  }

  stop() {
    this.state = 'off'
    this.qr = ''
    this.qrImage = ''
    this.name = ''
    const proc = this.proc
    this.proc = null
    try { proc?.kill() } catch { /* already gone */ }
  }
}
