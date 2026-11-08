// End-to-end check against a scripted fake model. Uses a real Chromium and real DSH, and needs no API key.
// Run: npm test
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbot-e2e-'))
const PORT = 8799
const base = `http://127.0.0.1:${PORT}`
const origin = { Origin: base }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, fn) => Promise.resolve().then(fn).then(
  () => { results.push(true); console.log(`  ok   ${name}`) },
  error => { results.push(false); console.log(`  FAIL ${name}\n       ${error.message}`) },
)

// ---- scripted model ----
const requests = []
const script = []
const say = text => ({ text })
const use = (name, input) => ({ tool: name, input })
async function modelResponse(body, res) {
  requests.push(body)
  const step = script.shift() ?? say('done')
  const resolved = typeof step === 'function' ? await step(body) : step
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`)
  emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 0 } } })
  if (resolved.tool) {
    emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `t${requests.length}`, name: `mcp__bobbot__${resolved.tool}`, input: {} } })
    emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(resolved.input) } })
  } else {
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: resolved.text } })
  }
  emit('content_block_stop', { index: 0 })
  emit('message_delta', { delta: { stop_reason: resolved.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 500 } })
  emit('message_stop', {})
  res.end()
}
const fake = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    if (req.method === 'POST' && req.url.includes('/messages')) modelResponse(JSON.parse(raw), res).catch(e => { console.error(e); res.destroy() })
    else res.writeHead(404).end('{}')
  })
})
await new Promise(r => fake.listen(0, '127.0.0.1', r))

// ---- server under test ----
const env = { ...process.env, BOBBOT_DATA: data, PORT: String(PORT), HOST: '127.0.0.1', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${fake.address().port}` }
const setPin = pin => spawnSync(process.execPath, ['set-pin.mjs', pin], { cwd: root, env, encoding: 'utf8' })
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })
for (let i = 0; i < 300 && !log.includes('BobBot prototype'); i++) await sleep(100)
assert.ok(log.includes('BobBot prototype'), `server did not start:\n${log}`)

let cookie = ''
const post = async (url, body, headers = {}) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...origin, cookie, ...headers }, body: JSON.stringify(body ?? {}) })
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers }
}

// ---- event feed ----
const events = []
async function follow() {
  const res = await fetch(`${base}/api/events`, { headers: { cookie } })
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    let at
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      events.push(JSON.parse(buffer.slice(6, at)))
      buffer = buffer.slice(at + 2)
    }
  }
}
async function waitEvent(match, ms = 90000) {
  for (let waited = 0; waited < ms; waited += 100) {
    const hit = events.find(match)
    if (hit) return hit
    await sleep(100)
  }
  throw new Error(`timed out; recent events: ${JSON.stringify(events.slice(-6)).slice(0, 500)}\n${log.slice(-800)}`)
}
const toolResultText = body => JSON.stringify(body.messages.at(-1))

// Edits the live test page directly so risky buttons exist without weakening the local-address block.
async function injectPage(html) {
  const [port] = fs.readFileSync(path.join(data, 'browser_profile', 'DevToolsActivePort'), 'utf8').trim().split('\n')
  const pages = await (await fetch(`http://127.0.0.1:${port.trim()}/json/list`)).json()
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise(r => ws.once('open', r))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.body.innerHTML=${JSON.stringify(html)}` } }))
  await new Promise(r => ws.once('message', r))
  ws.close()
}

try {
  console.log('PIN login')
  await check('login is refused until a PIN is set on the server', async () => assert.equal((await post('/api/login', { pin: '1234' })).status, 503))
  await check('set-pin rejects anything but 4 digits', () => assert.equal(setPin('12a').status, 1))
  await check('set-pin accepts 4 digits', () => assert.equal(setPin('4821').status, 0))
  await check('API needs a login', async () => assert.equal((await fetch(`${base}/api/events`)).status, 401))
  await check('cross-origin login is rejected', async () => assert.equal((await post('/api/login', { pin: '4821' }, { Origin: 'https://evil.example' })).status, 403))
  await check('wrong PIN is refused and counted', async () => {
    const { status, data: d } = await post('/api/login', { pin: '0000' })
    assert.equal(status, 401); assert.equal(d.remaining, 4)
  })
  await check('5 wrong PINs lock login, even for the right PIN', async () => {
    for (let i = 0; i < 4; i++) await post('/api/login', { pin: '0000' })
    const { status, data: d } = await post('/api/login', { pin: '4821' })
    assert.equal(status, 429); assert.equal(d.error, 'LOCKED')
  })
  await check('changing the PIN on the server clears the lock', async () => {
    assert.equal(setPin('7316').status, 0)
    const res = await post('/api/login', { pin: '7316' })
    assert.equal(res.status, 200)
    cookie = res.headers.get('set-cookie').split(';')[0]
    assert.match(res.headers.get('set-cookie'), /HttpOnly/)
  })
  follow().catch(() => {})

  console.log('Agent loop through DSH')
  script.push(
    use('browser_navigate', { url: 'http://127.0.0.1:9222/json' }),
    use('browser_navigate', { url: 'https://example.com/' }),
    async () => { await injectPage('<h1>Draft</h1><a href="#x">Read more</a><button>Post</button>'); return use('browser_snapshot', {}) },
    use('browser_click', { element_id: 1 }),
    use('browser_click', { element_id: 2 }),
    use('browser_click', { element_id: 2 }),
    use('browser_request_human', { reason: 'Please log in', action_type: 'login' }),
    say('All finished.'),
  )
  await check('chat reaches DSH and the model', async () => {
    assert.equal((await post('/api/chat', { text: 'run the test' })).status, 200)
    await waitEvent(e => e.type === 'step' && e.name === 'browser_navigate')
  })
  await check('shell is removed; only BobBot browser tools are offered', () => {
    const names = requests[0].tools.map(t => t.name)
    assert.ok(names.includes('mcp__bobbot__browser_click'), names.join())
    assert.ok(!names.some(n => /bash|pwsh|shell|read_image|working_directory|read_file|write|edit/i.test(n)), names.join())
  })
  await check('agent cannot open local addresses', async () => {
    for (let i = 0; i < 200 && requests.length < 2; i++) await sleep(100)
    assert.match(toolResultText(requests[1]), /private network addresses are blocked/)
  })
  let approval
  await check('risky "Post" button stops for approval with a screenshot', async () => {
    approval = await waitEvent(e => e.type === 'approval')
    assert.equal(approval.summary, 'Click "Post"')
    assert.ok(approval.screenshot?.length > 100)
  })
  await check('non-risky click ran without approval', () => {
    assert.ok(requests.length >= 5)
    assert.match(toolResultText(requests[4]), /Read more/)
    assert.equal(events.filter(e => e.type === 'approval').length, 1)
  })
  await check('rejecting tells the model the action was refused', async () => {
    assert.equal((await post('/api/approve', { id: approval.id, allow: false })).status, 200)
    for (let i = 0; i < 300 && requests.length < 6; i++) await sleep(100)
    assert.match(toolResultText(requests[5]), /did not approve/)
  })
  await check('takeover pauses the agent until handed back', async () => {
    const second = await waitEvent(e => e.type === 'approval' && e.id !== approval.id)
    assert.equal((await post('/api/approve', { id: second.id, allow: true })).status, 200)
    await waitEvent(e => e.type === 'takeover')
    const count = requests.length
    await sleep(1500)
    assert.equal(requests.length, count)
    assert.equal((await post('/api/takeover/done')).status, 200)
    await waitEvent(e => e.type === 'takeover_done')
  })
  await check('final reply reaches the chat', () => waitEvent(e => e.type === 'message' && e.text === 'All finished.'))
  await check('token use is charged from the registry price', async () => {
    const { budget } = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()
    const perCall = (1000 * 1 + 500 * 2) / 1e6 / 7.2
    assert.ok(budget.spentUsd >= perCall * requests.length * 0.9, `spent ${budget.spentUsd}, calls ${requests.length}`)
    assert.ok(budget.spentUsd <= perCall * requests.length * 1.5, `spent ${budget.spentUsd}, calls ${requests.length}`)
  })

  console.log('Phone window')
  await check('socket refuses a foreign origin', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/browser`, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })
    await new Promise(r => ws.on('error', r))
  })
  await check('socket refuses a missing login', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/browser`, { headers: { Origin: base } })
    await new Promise(r => ws.on('error', r))
  })
  await check('frames stream, and tap and text reach the page', async () => {
    await injectPage('<input id="f" style="position:fixed;left:0;top:0;width:100%;height:100%;font-size:40px">')
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/browser`, { headers: { Cookie: cookie, Origin: base } })
    await new Promise(r => ws.once('open', r))
    const frames = []
    ws.on('message', (m, binary) => { if (binary) frames.push(m) })
    ws.send(JSON.stringify({ t: 'viewport', w: 390, h: 720 }))
    for (let i = 0; i < 100 && frames.length < 1; i++) await sleep(100)
    assert.ok(frames.length >= 1, 'no frames')
    assert.equal(frames[0][0], 0xff, 'not a JPEG')
    ws.send(JSON.stringify({ t: 'pointer', k: 'down', x: 0.5, y: 0.5 }))
    ws.send(JSON.stringify({ t: 'pointer', k: 'up', x: 0.5, y: 0.5 }))
    await sleep(400)
    ws.send(JSON.stringify({ t: 'text', v: 'hello-phone' }))
    await sleep(600)
    const [port] = fs.readFileSync(path.join(data, 'browser_profile', 'DevToolsActivePort'), 'utf8').trim().split('\n')
    const pages = await (await fetch(`http://127.0.0.1:${port.trim()}/json/list`)).json()
    const cdp = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
    await new Promise(r => cdp.once('open', r))
    cdp.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.getElementById("f").value' } }))
    const reply = await new Promise(r => cdp.once('message', r))
    cdp.close()
    assert.equal(JSON.parse(reply).result.result.value, 'hello-phone')
    const before = frames.length
    ws.close()
    await sleep(800)
    await injectPage('<h1>changed after close</h1>')
    await sleep(800)
    assert.equal(frames.length, before, 'frames kept arriving after close')
  })

  console.log('Spending limit')
  await check('at the cap, new chat is refused with no model call', async () => {
    assert.equal((await post('/api/budget', { capUsd: 0.000001 })).status, 200)
    const count = requests.length
    assert.equal((await post('/api/chat', { text: 'more' })).status, 402)
    await sleep(500)
    assert.equal(requests.length, count)
  })
} finally {
  server.kill()
  fake.close()
  fake.closeAllConnections()
}

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed) console.log(`\nServer log tail:\n${log.slice(-1500)}`)
setTimeout(() => process.exit(failed ? 1 : 0), 200)
