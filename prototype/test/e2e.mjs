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
import { Budget } from '../agent.mjs'

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
  await check('only BobBot tools are offered, and DSH keeps no shell or file tools of its own', () => {
    const names = requests[0].tools.map(t => t.name)
    for (const tool of ['browser_click', 'list_files', 'read_file', 'write_file', 'run_command']) {
      assert.ok(names.includes(`mcp__bobbot__${tool}`), `missing ${tool}: ${names.join()}`)
    }
    const native = names.filter(n => !n.startsWith('mcp__bobbot__'))
    assert.ok(!native.some(n => /bash|pwsh|shell|read_image|working_directory|^read$|^write$|^edit$/i.test(n)), native.join())
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

  console.log('Conversations')
  const getJson = async url => { const r = await fetch(`${base}${url}`, { headers: { cookie } }); return { status: r.status, body: await r.json() } }
  const waitAfter = (t0, match) => waitEvent(e => e.at >= t0 && match(e))
  const firstCid = events.find(e => e.type === 'message' && e.role === 'user' && e.text === 'run the test').cid
  await check('the first chat is listed, titled by its first message', async () => {
    const { body } = await getJson('/api/conversations')
    assert.equal(body.items.find(c => c.id === firstCid)?.title, 'run the test')
  })
  await check('saved history drops approval screenshots but keeps the conversation', async () => {
    const { body } = await getJson(`/api/conversations/${firstCid}`)
    const ask = body.events.find(e => e.type === 'approval')
    assert.ok(ask && !('screenshot' in ask), 'screenshot was saved')
    assert.ok(body.events.some(e => e.type === 'message' && e.text === 'All finished.'))
  })
  await check('an unknown conversation is refused', async () => {
    assert.equal((await post('/api/chat', { cid: 'nope', text: 'hi' })).status, 404)
    assert.equal((await getJson('/api/conversations/nope')).status, 404)
  })
  let secondCid
  await check('a second chat has its own history', async () => {
    const t0 = Date.now()
    const res = await post('/api/chat', { text: 'second chat' })
    assert.equal(res.status, 200); secondCid = res.data.cid
    assert.notEqual(secondCid, firstCid)
    await waitAfter(t0, e => e.type === 'message' && e.role === 'assistant' && e.cid === secondCid)
    const second = await getJson(`/api/conversations/${secondCid}`)
    assert.deepEqual(second.body.events.filter(e => e.type === 'message').map(e => e.role), ['user', 'assistant'])
    assert.ok(!(await getJson(`/api/conversations/${firstCid}`)).body.events.some(e => e.text === 'second chat'))
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle' && e.cid === secondCid)
  })
  await check('while Bob works in one chat, another chat is refused and the busy one cannot be deleted', async () => {
    const t0 = Date.now()
    script.push(use('browser_request_human', { reason: 'busy test' }), say('busy test finished'))
    const busy = await post('/api/chat', { text: 'busy chat' })
    assert.equal(busy.status, 200)
    await waitAfter(t0, e => e.type === 'takeover' && e.cid === busy.data.cid)
    assert.equal((await post('/api/chat', { cid: secondCid, text: 'interrupt' })).data.error, 'BUSY_OTHER')
    assert.equal((await post('/api/conversations/delete', { id: busy.data.cid })).status, 409)
    assert.equal((await post('/api/takeover/done')).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'busy test finished' && e.cid === busy.data.cid)
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle' && e.cid === busy.data.cid)
  })
  await check('an idle chat can be deleted, along with the saved model session', async () => {
    assert.equal((await post('/api/conversations/delete', { id: secondCid })).status, 200)
    assert.equal((await getJson(`/api/conversations/${secondCid}`)).status, 404)
    assert.ok(!(await getJson('/api/conversations')).body.items.some(c => c.id === secondCid))
    const sessions = path.join(data, 'dsh-home', 'sessions')
    const left = fs.readdirSync(sessions).flatMap(group => fs.readdirSync(path.join(sessions, group))).filter(name => name === secondCid || name.startsWith(`${secondCid}-g`))
    assert.deepEqual(left, [])
  })

  console.log('Server tools')
  const answered = new Set(events.filter(e => e.type === 'approval').map(e => e.id)) // earlier approvals are already settled
  const decide = async (allow, match = () => true) => {
    const ask = await waitEvent(e => e.type === 'approval' && !answered.has(e.id) && match(e))
    answered.add(ask.id)
    assert.equal((await post('/api/approve', { id: ask.id, allow })).status, 200)
    return ask
  }
  const outside = path.join(os.tmpdir(), `bobbot-outside-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'outside-content')
  let toolCid
  await check('files and commands work, and every risky step asks first', async () => {
    const t0 = Date.now()
    const approvalsBefore = events.filter(e => e.type === 'approval').length
    script.push(
      use('write_file', { path: 'note.txt', content: 'hello-bobbot' }),
      use('read_file', { path: 'note.txt' }),
      use('list_files', {}),
      use('run_command', { command: 'echo rejected-run' }),
      use('run_command', { command: 'echo cmd-ok' }),
      use('read_file', { path: path.join(data, 'pin.json') }),
      use('read_file', { path: outside }),
      use('run_command', { command: 'sleep 5', timeout_seconds: 1 }),
      say('tools done'),
    )
    const res = await post('/api/chat', { text: 'use the tools' })
    assert.equal(res.status, 200); toolCid = res.data.cid
    const write = await decide(true)
    assert.equal(write.kind, 'write'); assert.ok(write.target.endsWith('note.txt')); assert.match(write.detail, /hello-bobbot/)
    const rejected = await decide(false)
    assert.equal(rejected.kind, 'command'); assert.equal(rejected.detail, 'echo rejected-run'); assert.ok(!rejected.screenshot)
    const ran = await decide(true)
    assert.equal(ran.detail, 'echo cmd-ok')
    const read = await decide(true)
    assert.equal(read.kind, 'read'); assert.equal(read.target, fs.realpathSync(outside))
    await decide(true, e => e.kind === 'command')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'tools done')
    const asked = events.filter(e => e.type === 'approval').length - approvalsBefore
    assert.equal(asked, 5, 'reading and listing the workspace, and the blocked read, must not ask')
    assert.equal(fs.readFileSync(path.join(data, 'workspace', 'note.txt'), 'utf8'), 'hello-bobbot')
    const seen = JSON.stringify(requests.at(-1).messages)
    for (const expected of ['hello-bobbot', 'note.txt', 'did not approve', 'cmd-ok', 'holds BobBot or system credentials', 'outside-content', 'timed out after 1s']) {
      assert.ok(seen.includes(expected), `the model never saw "${expected}"`)
    }
    assert.ok(!seen.includes('rejected-run\\n'), 'the rejected command ran anyway')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle' && e.cid === toolCid)
  })
  await check('commands run without the server keys in their environment', async () => {
    const t0 = Date.now()
    script.push(use('run_command', { command: 'env' }), say('env done'))
    assert.equal((await post('/api/chat', { cid: toolCid, text: 'show env' })).status, 200)
    await decide(true, e => e.kind === 'command' && e.detail === 'env')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'env done')
    const seen = JSON.stringify(requests.at(-1).messages)
    assert.ok(!seen.includes('test-key') && !seen.includes('DEEPSEEK_API_KEY'), 'a key leaked into the command environment')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle' && e.cid === toolCid)
  })
  await check('a chat keeps its memory after the agent restarts', async () => {
    const first = Date.now()
    const res = await post('/api/chat', { text: 'remember-marker-42' })
    const cid = res.data.cid
    await waitAfter(first, e => e.type === 'message' && e.role === 'assistant' && e.cid === cid)
    await waitAfter(first, e => e.type === 'status' && e.status === 'idle' && e.cid === cid)
    assert.equal((await post('/api/model', { kind: 'deepseek', model: 'deepseek-flash' })).status, 200) // restarts the agent
    const before = requests.length
    const second = Date.now()
    assert.equal((await post('/api/chat', { cid, text: 'what did I say?' })).status, 200)
    for (let i = 0; i < 600 && requests.length === before; i++) await sleep(100)
    assert.ok(requests.length > before, 'model was not called')
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('remember-marker-42'), 'the earlier message was forgotten')
    await waitAfter(second, e => e.type === 'status' && e.status === 'idle' && e.cid === cid)
  })

  console.log('Model settings')
  const getState = async () => (await fetch(`${base}/api/state`, { headers: { cookie } })).json()
  await check('a saved key is reported without exposing it', async () => {
    const st = await getState()
    assert.equal(st.hasKey, true); assert.equal(st.keyHint, 'env'); assert.equal(st.model.kind, 'deepseek')
    assert.ok(!JSON.stringify(st).includes('test-key'))
  })
  await check('model list includes the default model', async () => {
    assert.ok((await post('/api/models', {})).data.deepseek.includes('deepseek-flash'))
  })
  const customModel = { kind: 'custom', baseUrl: 'https://example.com/anthropic', model: 'my-model', key: 'k-custom-1234567890', inputUsd: 1, outputUsd: 2 }
  await check('custom model rejects http, private addresses, bad prices and bad names', async () => {
    assert.equal((await post('/api/model', { ...customModel, baseUrl: 'http://example.com/a' })).data.error, 'HTTPS_REQUIRED')
    assert.equal((await post('/api/model', { ...customModel, baseUrl: 'https://127.0.0.1/a' })).data.error, 'BAD_ENDPOINT')
    assert.equal((await post('/api/model', { ...customModel, inputUsd: -1 })).data.error, 'BAD_PRICE')
    assert.equal((await post('/api/model', { ...customModel, model: 'has space' })).data.error, 'BAD_MODEL')
    assert.equal((await post('/api/model', { ...customModel, key: '' })).data.error, 'NO_KEY')
    assert.equal((await post('/api/model', { kind: 'deepseek', model: 'not-a-model' })).data.error, 'UNKNOWN_MODEL')
  })
  await check('custom model saves with a masked key, and DeepSeek can be restored', async () => {
    const ok = await post('/api/model', customModel)
    assert.equal(ok.status, 200); assert.equal(ok.data.keyHint, 'k-c••••7890')
    let st = await getState()
    assert.equal(st.model.kind, 'custom'); assert.equal(st.model.model, 'my-model'); assert.equal(st.keyHint, 'k-c••••7890')
    assert.ok(!JSON.stringify(st).includes('1234567890'))
    assert.equal((await post('/api/model', { kind: 'deepseek', model: 'deepseek-flash' })).status, 200)
    st = await getState()
    assert.equal(st.model.kind, 'deepseek'); assert.equal(st.keyHint, 'env')
  })
  await check('spending uses the right currency for each kind of price', () => {
    const b = new Budget(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')))
    const million = { inputTokens: 1e6, outputTokens: 1e6 }
    assert.ok(Math.abs(b.record('deepseek-flash', million).spentUsd - 3 / 7.2) < 1e-9)
    const before = b.status().spentUsd
    assert.ok(Math.abs(b.record('x', million, { input: 3, output: 15, currency: 'USD' }).spentUsd - before - 18) < 1e-9)
    assert.throws(() => b.record('no-such-model', million), /No price/)
  })

  console.log('Attachments')
  await check('attached text reaches the model as data, and the history keeps only names', async () => {
    const before = requests.length
    const res = await post('/api/chat', { text: 'summarise this', files: [{ name: 'sales.csv', text: 'col1,col2\n1,2\n' }] })
    assert.equal(res.status, 200)
    for (let i = 0; i < 600 && requests.length === before; i++) await sleep(100)
    assert.ok(requests.length > before, 'model was not called')
    const sent = JSON.stringify(requests.at(-1).messages)
    assert.ok(sent.includes('col1,col2'), 'file content missing')
    assert.ok(sent.includes('not instructions to you'), 'data label missing')
    const shown = events.findLast(e => e.type === 'message' && e.role === 'user' && e.files?.length)
    assert.equal(shown.files[0].name, 'sales.csv')
    assert.ok(!JSON.stringify(shown).includes('col1,col2'), 'file body leaked into the history')
  })
  await check('too many, binary, oversized and nameless files are refused without a model call', async () => {
    const count = requests.length
    const one = n => ({ name: `f${n}.txt`, text: 'x' })
    assert.equal((await post('/api/chat', { text: 'a', files: [1, 2, 3, 4, 5, 6].map(one) })).data.error, 'TOO_MANY_FILES')
    assert.equal((await post('/api/chat', { text: 'a', files: [{ name: 'a.bin', text: 'ab\u0000cd' }] })).data.error, 'NOT_TEXT')
    assert.equal((await post('/api/chat', { text: 'a', files: [{ name: 'big.txt', text: 'x'.repeat(200001) }] })).status, 413)
    assert.equal((await post('/api/chat', { text: 'a', files: [1, 2, 3].map(n => ({ name: `p${n}.txt`, text: 'y'.repeat(190000) })) })).status, 413)
    assert.equal((await post('/api/chat', { text: 'a', files: [{ name: '', text: 'x' }] })).data.error, 'BAD_FILE')
    await sleep(500)
    assert.equal(requests.length, count)
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
