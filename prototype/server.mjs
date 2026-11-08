// BobBot test prototype: PIN login, chat over DSH, and a shared cloud browser with phone takeover.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Agent, Budget } from './agent.mjs'
import { DATA_DIR, hasPin, issueSession, login, validSession } from './auth.mjs'
import { CloudBrowser } from './browser.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const KEY_FILE = path.join(DATA_DIR, 'secrets.json')
const HISTORY_FILE = path.join(DATA_DIR, 'history.json')
const HUMAN_TIMEOUT_MS = 15 * 60 * 1000
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const RISKY = /支付|付款|购买|下单|结算|删除|发送|发布|提交|转账|\b(pay|buy|purchase|checkout|order|delete|remove|send|post|publish|submit|transfer|tweet)\b/i

const browser = new CloudBrowser(DATA_DIR)
const agent = new Agent(DATA_DIR)
const budget = new Budget(DATA_DIR)
const mcpToken = crypto.randomBytes(32).toString('hex')
let mcpUrl = ''

// ---- event feed ----
const clients = new Set()
let history = []
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { /* first run */ }

function push(event, keep = true) {
  const payload = { ...event, at: Date.now() }
  if (keep) {
    history.push(payload)
    history = history.slice(-400)
    fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {})
  }
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of clients) res.write(line)
}

const publishBudget = () => push({ type: 'budget', ...budget.status() }, false)

// ---- shared-control gates ----
const approvals = new Map()
let takeover = null
let viewer = null

function waitForHuman() {
  if (!takeover && !viewer) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (!takeover && !viewer) { clearInterval(timer); resolve() }
      else if (Date.now() - started > HUMAN_TIMEOUT_MS) { clearInterval(timer); reject(new Error('The user kept control of the browser for too long.')) }
    }, 300)
  })
}

async function requireApproval(summary) {
  const id = crypto.randomUUID()
  const screenshot = await browser.screenshot().catch(() => null)
  push({ type: 'approval', id, summary, screenshot })
  const allowed = await new Promise(resolve => {
    const timer = setTimeout(() => { approvals.delete(id); resolve(false) }, APPROVAL_TIMEOUT_MS)
    approvals.set(id, value => { clearTimeout(timer); approvals.delete(id); resolve(value) })
  })
  push({ type: 'approval_done', id, allowed })
  if (!allowed) throw new Error(`The user did not approve this action: ${summary}`)
}

// ---- agent tools, served as MCP on a private loopback port ----
const idSchema = { element_id: { type: 'integer', description: 'Number shown in the latest page snapshot' } }
const TOOLS = [
  ['browser_navigate', 'Open a public http(s) URL and return a page snapshot.', { url: { type: 'string' } }, ['url']],
  ['browser_snapshot', 'Return the current page text and numbered interactive elements.', {}, []],
  ['browser_click', 'Click a numbered element and return a new snapshot.', idSchema, ['element_id']],
  ['browser_type', 'Replace the text in a numbered field.', { ...idSchema, text: { type: 'string' }, press_enter: { type: 'boolean' } }, ['element_id', 'text']],
  ['browser_scroll', 'Scroll one screen and return a new snapshot.', { direction: { type: 'string', enum: ['up', 'down'] } }, ['direction']],
  ['browser_request_human', 'Pause and ask the user to complete a login, captcha, QR code or 2FA in the browser window.', { reason: { type: 'string' }, action_type: { type: 'string', enum: ['login', 'captcha', 'qr', 'confirm'] } }, ['reason']],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } }))

async function element(id) {
  const info = await browser.describe(id)
  if (!info) throw new Error('That element number is out of date. Call browser_snapshot and use a fresh number.')
  return info
}

async function callTool(name, args) {
  if (budget.status().exceeded) throw new Error('The monthly spending limit has been reached. Stop and tell the user.')
  await waitForHuman()
  switch (name) {
    case 'browser_navigate':
      await browser.navigate(String(args.url))
      break
    case 'browser_snapshot':
      break
    case 'browser_click': {
      const info = await element(args.element_id)
      if (RISKY.test(info.text) || (info.type === 'submit' && !info.search)) await requireApproval(`Click "${info.text || info.tag}"`)
      await waitForHuman()
      await browser.click(args.element_id)
      break
    }
    case 'browser_type': {
      const info = await element(args.element_id)
      if (args.press_enter && !info.search) await requireApproval(`Enter "${String(args.text).slice(0, 80)}" and press Enter`)
      await waitForHuman()
      await browser.type(args.element_id, String(args.text), Boolean(args.press_enter))
      break
    }
    case 'browser_scroll':
      await browser.scroll(args.direction)
      break
    case 'browser_request_human': {
      const id = crypto.randomUUID()
      push({ type: 'takeover', id, reason: String(args.reason) })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { takeover = null; reject(new Error('The user did not respond in time.')) }, HUMAN_TIMEOUT_MS)
        takeover = { id, finish: () => { clearTimeout(timer); takeover = null; resolve() } }
      })
      push({ type: 'takeover_done', id })
      await waitForHuman()
      break
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
  return browser.snapshot()
}

async function handleMcp(req, res) {
  if (req.headers.authorization !== `Bearer ${mcpToken}`) return send(res, 401, { error: 'unauthorized' })
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
  const msg = JSON.parse(await readBody(req, 4 * 1024 * 1024))
  if (msg.id === undefined) { res.writeHead(202).end(); return }
  const reply = result => send(res, 200, { jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bobbot-browser', version: '0.0.1' } })
  }
  if (msg.method === 'ping') return reply({})
  if (msg.method === 'tools/list') return reply({ tools: TOOLS })
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params
    push({ type: 'step', name })
    try {
      return reply({ content: [{ type: 'text', text: await callTool(name, args) }] })
    } catch (error) {
      return reply({ content: [{ type: 'text', text: error.message }], isError: true })
    }
  }
  return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
}

// ---- agent wiring ----
agent.on('text', text => push({ type: 'message', role: 'assistant', text }))
agent.on('status', status => push({ type: 'status', status }, false))
agent.on('exit', code => push({ type: 'error', text: `Agent stopped unexpectedly (${code}). Send a message to restart it.` }))
agent.on('usage', (model, usage) => {
  const status = budget.record(model, usage)
  publishBudget()
  if (status.near && !status.warned) {
    budget.markWarned()
    push({ type: 'notice', code: 'BUDGET_NEAR' })
  }
  if (status.exceeded) {
    agent.stop()
    push({ type: 'notice', code: 'BUDGET_EXCEEDED' })
    push({ type: 'status', status: 'idle' }, false)
  }
})

const loadKey = () => {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).deepseek } catch { return null }
}

async function checkKey(key) {
  if (process.env.DEEPSEEK_BASE_URL) return // test endpoints have no /models route
  const response = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(response.status === 401 ? 'INVALID_KEY' : `PROVIDER_${response.status}`)
}

// ---- http helpers ----
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const cookieOf = req => /(?:^|;\s*)bb_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
const authed = req => validSession(cookieOf(req))

function sameOrigin(req) {
  if (!req.headers.origin) return false
  try { return new URL(req.headers.origin).host === req.headers.host } catch { return false }
}

function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  return `bb_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://local')
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' })
    return res.end(fs.readFileSync(path.join(here, 'public/index.html')))
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    const ok = authed(req)
    return send(res, 200, { authed: ok, pinSet: hasPin(), ...(ok ? { hasKey: Boolean(loadKey()), budget: budget.status() } : {}) })
  }
  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'BAD_ORIGIN' })
  if (req.method === 'POST' && pathname === '/api/login') {
    const result = await login(JSON.parse(await readBody(req)).pin ?? '')
    if (!result.ok) return send(res, result.status, result)
    const session = issueSession()
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, session.value, session.maxAge) })
  }
  if (!authed(req)) return send(res, 401, { error: 'UNAUTHORIZED' })
  if (req.method === 'POST' && pathname === '/api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) })
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
    res.write(`data: ${JSON.stringify({ type: 'hello', history, budget: budget.status(), busy: agent.running && busyNow })}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return undefined
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'NOT_FOUND' })
  const body = JSON.parse(await readBody(req) || '{}')
  switch (pathname) {
    case '/api/chat': {
      const text = String(body.text ?? '').trim()
      if (!text) return send(res, 400, { error: 'EMPTY' })
      const apiKey = loadKey()
      if (!apiKey) return send(res, 400, { error: 'NO_KEY' })
      if (budget.status().exceeded) return send(res, 402, { error: 'BUDGET_EXCEEDED' })
      push({ type: 'message', role: 'user', text })
      await agent.ensure({ apiKey, mcpUrl, mcpToken })
      await agent.prompt(text)
      return send(res, 200, { ok: true })
    }
    case '/api/key': {
      const key = String(body.key ?? '').trim()
      if (!key) return send(res, 400, { error: 'EMPTY' })
      await checkKey(key)
      fs.writeFileSync(KEY_FILE, JSON.stringify({ deepseek: key }), { mode: 0o600 })
      agent.stop()
      return send(res, 200, { ok: true })
    }
    case '/api/budget': {
      const cap = Number(body.capUsd)
      if (!(cap > 0)) return send(res, 400, { error: 'INVALID' })
      budget.setCap(cap)
      publishBudget()
      return send(res, 200, budget.status())
    }
    case '/api/approve': {
      const resolve = approvals.get(body.id)
      if (!resolve) return send(res, 404, { error: 'EXPIRED' })
      resolve(body.allow === true)
      return send(res, 200, { ok: true })
    }
    case '/api/takeover/done':
      takeover?.finish()
      return send(res, 200, { ok: true })
    default:
      return send(res, 404, { error: 'NOT_FOUND' })
  }
}

let busyNow = false
agent.on('status', status => { busyNow = status === 'running' })

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    console.error(error)
    if (!res.headersSent) send(res, 500, { error: error.message })
  })
})

// ---- phone browser window ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://local').pathname !== '/ws/browser' || !authed(req) || !sameOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
})

browser.onFrame = frame => {
  if (viewer?.readyState === 1 && viewer.bufferedAmount < 2 * 1024 * 1024) viewer.send(frame)
}

const unit = v => Number.isFinite(v) && v >= 0 && v <= 1

wss.on('connection', ws => {
  viewer?.close()
  viewer = ws
  ws.on('message', raw => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    const act = (() => {
      if (m.t === 'viewport') return browser.startCast(Number(m.w) || 390, Number(m.h) || 720)
      if (m.t === 'pointer' && unit(m.x) && unit(m.y)) return browser.pointer(m.k, m.x, m.y)
      if (m.t === 'wheel' && Number.isFinite(m.d)) return browser.wheel(m.d)
      if (m.t === 'text' && typeof m.v === 'string') return browser.insertText(m.v.slice(0, 4000))
      if (m.t === 'key') return browser.pressKey(m.k)
      if (m.t === 'nav' && typeof m.url === 'string') return browser.navigate(/^https?:/i.test(m.url) ? m.url : `https://${m.url}`)
      return null
    })()
    act?.catch(error => { if (ws.readyState === 1) ws.send(JSON.stringify({ error: error.message })) })
  })
  ws.on('close', () => {
    if (viewer === ws) { viewer = null; browser.stopCast().catch(() => {}) }
  })
})

// ---- start ----
await browser.start()

const mcpServer = http.createServer((req, res) => {
  handleMcp(req, res).catch(error => { console.error(error); if (!res.headersSent) send(res, 500, { error: error.message }) })
})
await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve))
mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`

server.listen(PORT, HOST, () => {
  console.log(`BobBot prototype: http://${HOST}:${PORT}`)
  if (!hasPin()) console.log('No PIN set yet. Run: npm run set-pin -- 1234')
})

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  agent.stop()
  await browser.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
