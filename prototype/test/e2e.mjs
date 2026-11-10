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
    emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `t${requests.length}`, name: resolved.tool.startsWith('mcp__') || resolved.tool === 'skill' ? resolved.tool : `mcp__bobbot__${resolved.tool}`, input: {} } })
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
const env = { ...process.env, BOBBOT_NO_NIGHTLY: '1', BOBBOT_TRIAL_MS: '2500', BOBBOT_DATA: data, PORT: String(PORT), HOST: '127.0.0.1', DEEPSEEK_API_KEY: 'test-key', BOBBOT_TICK_MS: '1000', BOB_COMPAT_PORT: '3731', WECHAT_BRIDGE_URL: 'http://127.0.0.1:3999', DEEPSEEK_BASE_URL: `http://127.0.0.1:${fake.address().port}` }
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

  console.log('Clerk')
  const clerkView = async () => (await getJson('/api/clerk')).body
  const lastSent = () => JSON.stringify(requests.at(-1).messages)
  let reminderId, taskId
  await check('a reminder is created from chat, after a card that shows the schedule', async () => {
    const t0 = Date.now()
    script.push(
      use('clerk_create', { title: 'Call mom', kind: 'reminder', text: 'Call mom now', schedule: { type: 'daily', time: '23:59' } }),
      say('Reminder set.'),
    )
    assert.equal((await post('/api/chat', { text: 'remind me every day to call mom' })).status, 200)
    const ask = await decide(true, e => e.kind === 'clerk')
    assert.equal(ask.action, 'create'); assert.equal(ask.jobKind, 'reminder'); assert.deepEqual(ask.schedule, { type: 'daily', time: '23:59' })
    assert.equal(ask.detail, 'Call mom now'); assert.deepEqual(ask.channels, []); assert.ok(ask.firstRun > Date.now())
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Reminder set.')
    const view = await clerkView()
    assert.equal(view.jobs.length, 1); reminderId = view.jobs[0].id
    assert.ok(view.jobs[0].nextRun > Date.now() && view.jobs[0].enabled)
    assert.match(lastSent(), /\[Current time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, \w+day\. The user's time zone: [\w/_+-]+\.\]/, 'the current time was not sent')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
  })
  await check('a bad schedule, unknown channel or past time is refused without asking the user', async () => {
    const t0 = Date.now()
    const asked = events.filter(e => e.type === 'approval').length
    script.push(
      use('clerk_create', { title: 'x', kind: 'task', text: 'x', schedule: { type: 'weekly', days: [9], time: '08:00' } }),
      use('clerk_create', { title: 'x', kind: 'task', text: 'x', schedule: { type: 'daily', time: '08:00' }, channels: ['Nope'] }),
      use('clerk_create', { title: 'x', kind: 'reminder', text: 'x', schedule: { type: 'once', at: '2020-01-01T09:00' } }),
      say('refused all'),
    )
    assert.equal((await post('/api/chat', { text: 'try bad schedules' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'refused all')
    const seen = lastSent()
    for (const expected of ['Bad schedule', 'Unknown channel', 'already passed']) assert.ok(seen.includes(expected), `missing "${expected}"`)
    assert.equal(events.filter(e => e.type === 'approval').length, asked)
    assert.equal((await clerkView()).jobs.length, 1)
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
  })
  await check('"run now" on a reminder fills the inbox and the unread count', async () => {
    const run = await post('/api/clerk/job/run', { id: reminderId })
    assert.equal(run.status, 200); assert.equal(run.data.result, 'done')
    const view = await clerkView()
    assert.equal(view.inbox[0].text, 'Call mom now'); assert.equal(view.unread, 1); assert.equal(view.jobs[0].lastStatus, 'ok')
    assert.equal((await getJson('/api/state')).body.unread, 1)
    assert.equal((await post('/api/clerk/inbox/read')).status, 200)
    assert.equal((await clerkView()).unread, 0)
  })
  await check('a task runs alone: it can fetch the web, but cannot ask, run commands, install or change the schedule', async () => {
    const t0 = Date.now()
    script.push(
      use('clerk_create', { title: 'Morning weather', kind: 'task', text: 'Check the weather in Shanghai and say whether to bring an umbrella.', schedule: { type: 'daily', time: '23:58' } }),
      say('Task set.'),
    )
    assert.equal((await post('/api/chat', { text: 'every morning check the weather' })).status, 200)
    await decide(true, e => e.kind === 'clerk')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Task set.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    taskId = (await clerkView()).jobs.find(j => j.kind === 'task').id

    const asked = events.filter(e => e.type === 'approval').length
    const t1 = Date.now()
    script.push(
      use('web_fetch', { url: 'https://example.com/' }),
      use('run_command', { command: 'echo should-not-run' }),
      use('install_package', { manager: 'npm', packages: ['left-pad'] }),
      use('clerk_delete', { id: reminderId }),
      use('browser_request_human', { reason: 'login please' }),
      say('Take an umbrella.'),
    )
    const run = await post('/api/clerk/job/run', { id: taskId })
    assert.equal(run.status, 200); assert.equal(run.data.result, 'started')
    await waitAfter(t1, e => e.type === 'message' && e.text === 'Take an umbrella.')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')
    const seen = lastSent()
    assert.ok(seen.includes('Example Domain'), 'web_fetch result missing')
    assert.ok((seen.match(/scheduled run/g) ?? []).length >= 3, 'the unattended refusals are missing')
    assert.ok(seen.includes('Nobody is available to help'), 'login request was not refused')
    assert.equal(events.filter(e => e.type === 'approval').length, asked, 'a scheduled run asked for approval')
    assert.ok(!seen.includes('should-not-run\\n'), 'a command ran during a scheduled run')
    assert.equal((await clerkView()).jobs.length, 2, 'a scheduled run changed the schedule')
    const view = await clerkView()
    const task = view.jobs.find(j => j.id === taskId)
    assert.equal(task.lastStatus, 'needs_you'); assert.equal(task.lastResult, 'Take an umbrella.')
    assert.equal(task.assist.reason, 'login please'); assert.equal(task.runs[0].status, 'needs_you')
    assert.ok(view.inbox[0].text.startsWith('Take an umbrella.')); assert.ok(view.inbox[0].text.includes('login please')); assert.equal(view.inbox[0].title, 'Morning weather')
    const convo = (await getJson('/api/conversations')).body.items.find(c => c.id === task.cid)
    assert.ok(convo?.job, 'the run has no conversation of its own')
  })
  await check('a run that needed a sign-in can be finished by the owner, and then runs again', async () => {
    const t1 = Date.now()
    script.push(say('Signed in, here is the report.'))
    assert.equal((await post('/api/clerk/job/assist', { id: taskId })).status, 200)
    const help = await waitAfter(t1, e => e.type === 'takeover' && e.reason === 'login please')
    assert.equal((await post('/api/takeover/done', {})).status, 200)
    await waitAfter(t1, e => e.type === 'takeover_done' && e.id === help.id)
    await waitAfter(t1, e => e.type === 'message' && e.text === 'Signed in, here is the report.')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')
    let task
    for (let i = 0; i < 30; i++) { task = (await clerkView()).jobs.find(j => j.id === taskId); if (task.runs.length >= 2) break; await sleep(100) }
    assert.equal(task.lastStatus, 'ok'); assert.equal(task.assist, null)
    assert.deepEqual(task.runs.slice(0, 2).map(r => r.status), ['ok', 'needs_you'])
    assert.ok(task.runs[0].ms > 0, 'the run has no duration')
    assert.equal((await post('/api/clerk/job/assist', { id: taskId })).status, 404)
  })
  await check('Bob refuses to type into a password field', async () => {
    const t2 = Date.now()
    script.push(
      async () => { await injectPage('<input type="password" aria-label="Code">'); return use('browser_snapshot', {}) },
      use('browser_type', { element_id: 1, text: 'hunter2' }),
      say('Could not.'),
    )
    assert.equal((await post('/api/chat', { text: 'sign me in' })).status, 200)
    await waitAfter(t2, e => e.type === 'message' && e.text === 'Could not.')
    await waitAfter(t2, e => e.type === 'status' && e.status === 'idle')
    assert.ok(lastSent().includes('password or code field'), 'the refusal is missing')
  })
  await check('organized results are shown as cards in the chat, kept with the run, and sent to the inbox', async () => {
    const t0 = Date.now()
    script.push(
      use('show_card', { title: 'Shanghai today', tag: 'Weather', subtitle: 'Light rain in the afternoon', fields: [{ label: 'Temperature', value: '14-19C' }, { label: 'Rain chance', value: '70%' }], items: ['Light jacket', 'Bring an umbrella'], note: 'Updated 08:00' }),
      use('show_card', { title: '' }),
      say('Take an umbrella.'),
    )
    assert.equal((await post('/api/clerk/job/run', { id: taskId })).data.result, 'started')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Take an umbrella.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    const shown = events.find(e => e.type === 'card' && e.at >= t0 && e.card.title === 'Shanghai today')
    assert.ok(shown, 'the card was not shown')
    assert.equal(shown.card.fields.length, 2); assert.deepEqual(shown.card.items, ['Light jacket', 'Bring an umbrella'])
    assert.ok(lastSent().includes('Bad card'), 'the empty card was not refused')
    const view = await clerkView()
    assert.equal(view.inbox[0].cards.length, 1); assert.equal(view.inbox[0].cards[0].title, 'Shanghai today')
    const task = view.jobs.find(j => j.id === taskId)
    const saved = (await getJson(`/api/conversations/${task.cid}`)).body.events
    assert.ok(saved.some(e => e.type === 'card' && e.card.title === 'Shanghai today'), 'the card is not saved with the conversation')
  })
  await check('creating and listing schedules show job cards in the chat', async () => {
    assert.ok(events.some(e => e.type === 'card' && e.card.kind === 'job' && e.card.job.title === 'Call mom'), 'no card after creating the reminder')
    const t0 = Date.now()
    script.push(use('clerk_list', {}), say('Here they are.'))
    assert.equal((await post('/api/chat', { text: 'what is scheduled?' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Here they are.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    const cards = events.filter(e => e.type === 'card' && e.card.kind === 'job' && e.at >= t0).map(e => e.card.job.title).sort()
    assert.deepEqual(cards, ['Call mom', 'Morning weather'])
    assert.ok(lastSent().includes('Morning weather'), 'Bob did not get the list as text')
  })
  await check('a meeting becomes a to-do card with its own reminder, and finishing it switches the reminder off', async () => {
    const t0 = Date.now()
    const asked = events.filter(e => e.type === 'approval').length
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: (await clerkView()).timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + 2 * 86400000))
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
    const due = `${p.year}-${p.month}-${p.day}T09:30`
    script.push(use('todo_add', { title: 'Meeting at 9:30', due }), use('todo_add', { title: 'Call the client' }), use('todo_add', { title: 'x', due: 'tomorrow' }), say('Noted.'))
    assert.equal((await post('/api/chat', { text: 'I have a meeting at 9:30, record it' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Noted.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    assert.equal(events.filter(e => e.type === 'approval').length, asked, 'a to-do should not need a confirmation')
    assert.ok(lastSent().includes('due must look like'), 'a vague due time was accepted')
    const view = await clerkView()
    assert.deepEqual(view.todos.map(t => t.title), ['Call the client', 'Meeting at 9:30'])
    const meeting = view.todos.find(t => t.title === 'Meeting at 9:30')
    assert.equal(meeting.due, due); assert.ok(meeting.jobId, 'no reminder was created for the due time')
    assert.ok(events.some(e => e.type === 'card' && e.card.kind === 'todo' && e.card.todo.title === 'Meeting at 9:30' && e.at >= t0), 'no to-do card in the chat')
    assert.ok(!view.jobs.some(j => j.title === 'Meeting at 9:30'), 'the linked reminder is listed as a separate scheduled job')
    assert.equal((await post('/api/clerk/todo/toggle', { id: meeting.id, done: true })).status, 200)
    assert.equal((await clerkView()).todos.find(t => t.id === meeting.id).done, true)
    assert.equal((await post('/api/clerk/todo/delete', { id: meeting.id })).status, 200)
    assert.equal((await post('/api/clerk/todo/delete', { id: meeting.id })).status, 404)
    assert.deepEqual((await clerkView()).todos.map(t => t.title), ['Call the client'])
  })
  await check('while a task runs, other tasks and chats wait', async () => {
    const t0 = Date.now()
    script.push(async () => { await sleep(2500); return say('slow task done') })
    assert.equal((await post('/api/clerk/job/run', { id: taskId })).data.result, 'started')
    assert.equal((await post('/api/clerk/job/run', { id: taskId })).status, 409)
    assert.equal((await post('/api/chat', { text: 'meanwhile' })).data.error, 'BUSY_OTHER')
    assert.equal((await post('/api/clerk/job/delete', { id: taskId })).status, 409)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'slow task done')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
  })
  await check('jobs can be paused, resumed and deleted, and the time zone can change', async () => {
    assert.equal((await post('/api/clerk/job/toggle', { id: taskId, enabled: false })).status, 200)
    let job = (await clerkView()).jobs.find(j => j.id === taskId)
    assert.equal(job.enabled, false); assert.equal(job.nextRun, null)
    assert.equal((await post('/api/clerk/job/toggle', { id: taskId, enabled: true })).status, 200)
    const before = (await clerkView()).jobs.find(j => j.id === taskId).nextRun
    assert.equal((await post('/api/clerk/timezone', { timezone: 'Mars/Base' })).status, 400)
    assert.equal((await post('/api/clerk/timezone', { timezone: 'America/New_York' })).status, 200)
    job = (await clerkView()).jobs.find(j => j.id === taskId)
    assert.notEqual(job.nextRun, before, 'the next run did not move with the time zone')
    assert.equal((await post('/api/clerk/timezone', { timezone: 'Asia/Shanghai' })).status, 200)
    assert.equal((await post('/api/clerk/job/delete', { id: taskId })).status, 200)
    assert.equal((await post('/api/clerk/job/delete', { id: taskId })).status, 404)
  })
  await check('channels are checked, never shown in full, and a failed send is recorded', async () => {
    assert.equal((await post('/api/channels', { type: 'lark', name: 'Bad', webhook: 'https://evil.example/hook' })).data.error, 'BAD_WEBHOOK')
    assert.equal((await post('/api/channels', { type: 'sms', name: 'Bad' })).data.error, 'BAD_TYPE')
    const added = await post('/api/channels', { type: 'lark', name: 'Team Lark', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/not-a-real-token-0001', secret: 'topsecret' })
    assert.equal(added.status, 200); assert.equal(added.data.channel.signed, true)
    assert.equal((await post('/api/channels', { type: 'lark', name: 'team lark', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/other' })).data.error, 'NAME_TAKEN')
    const shown = JSON.stringify(await clerkView())
    assert.ok(!shown.includes('not-a-real-token') && !shown.includes('topsecret'), 'a channel secret reached the page')
    const t0 = Date.now()
    script.push(use('clerk_create', { title: 'Team ping', kind: 'reminder', text: 'Stand-up time', schedule: { type: 'daily', time: '23:57' }, channels: ['team lark'] }), say('Ping set.'))
    assert.equal((await post('/api/chat', { text: 'ping the team' })).status, 200)
    const ask = await decide(true, e => e.kind === 'clerk')
    assert.deepEqual(ask.channels, ['Team Lark']); assert.equal(ask.detail, 'Stand-up time')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Ping set.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    const ping = (await clerkView()).jobs.find(j => j.title === 'Team ping')
    assert.deepEqual(ping.channels, ['Team Lark'])
    assert.equal((await post('/api/clerk/job/run', { id: ping.id })).status, 200)
    const entry = (await clerkView()).inbox.find(n => n.text === 'Stand-up time')
    assert.equal(entry.delivery[0].channel, 'Team Lark'); assert.equal(entry.delivery[0].ok, false)
    assert.ok(entry.delivery[0].error, 'the failure has no reason')
    const channelId = (await clerkView()).channels.find(c => c.name === 'Team Lark').id
    assert.equal((await post('/api/channels/delete', { id: channelId })).status, 200)
    assert.deepEqual((await clerkView()).jobs.find(j => j.id === ping.id).channels, [])
  })
  await check('a one-time reminder fires by itself at its minute and then switches off', async () => {
    const view = await clerkView()
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: view.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(Date.now() + 70_000))
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
    const at = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
    const t0 = Date.now()
    script.push(use('clerk_create', { title: 'Right on time', kind: 'reminder', text: 'It is time', schedule: { type: 'once', at } }), say('Timer set.'))
    assert.equal((await post('/api/chat', { text: 'remind me in a minute' })).status, 200)
    await decide(true, e => e.kind === 'clerk')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Timer set.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    for (let i = 0; i < 1000; i++) { // up to 100s
      if ((await clerkView()).inbox.some(n => n.text === 'It is time')) break
      await sleep(100)
    }
    const after = await clerkView()
    assert.ok(after.inbox.some(n => n.text === 'It is time'), 'the reminder never fired')
    const job = after.jobs.find(j => j.title === 'Right on time')
    assert.equal(job.enabled, false); assert.equal(job.nextRun, null); assert.equal(job.lastStatus, 'ok')
  })

  console.log('Extensions')
  const extView = async () => (await getJson('/api/extensions')).body
  await check('Bob is offered the install tools and DSH\'s skill tool', () => {
    const names = requests.at(-1).tools.map(t => t.name)
    for (const tool of ['install_package', 'mcp_add', 'mcp_remove', 'skill_create', 'skill_install', 'skill_remove', 'ext_list', 'web_fetch', 'clerk_create']) {
      assert.ok(names.includes(`mcp__bobbot__${tool}`), `missing ${tool}`)
    }
    assert.ok(names.some(n => /^skill$/i.test(n)), `DSH's skill tool is missing: ${names.join()}`)
  })
  await check('package names are checked before anyone is asked', async () => {
    const t0 = Date.now()
    const asked = events.filter(e => e.type === 'approval').length
    script.push(
      use('install_package', { manager: 'npm', packages: ['x; rm -rf /'] }),
      use('install_package', { manager: 'npm', packages: ['--registry=http://evil.example'] }),
      use('install_package', { manager: 'gem', packages: ['rails'] }),
      say('names refused'),
    )
    assert.equal((await post('/api/chat', { text: 'install stuff' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'names refused')
    assert.ok((lastSent().match(/Not allowed/g) ?? []).length >= 3)
    assert.equal(events.filter(e => e.type === 'approval').length, asked)
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
  })
  await check('installing shows the exact command, runs only after approval, and reports a failure honestly', async () => {
    const t0 = Date.now()
    script.push(use('install_package', { manager: 'npm', packages: ['bobbot-no-such-package-zzz'] }), say('install attempted'))
    assert.equal((await post('/api/chat', { text: 'install that package' })).status, 200)
    const ask = await decide(true, e => e.kind === 'install')
    assert.equal(ask.detail, 'npm install -g bobbot-no-such-package-zzz'); assert.equal(ask.manager, 'npm')
    await waitAfter(t0, e => e.type === 'message' && e.text === 'install attempted')
    assert.match(lastSent(), /Failed \(exit code/)
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
  })
  await check('a skill is created only after the user reads it, then shows up for Bob', async () => {
    const t0 = Date.now()
    const skill = { name: 'weekly-report', description: 'Write the weekly report in the usual format', instructions: 'Start with three highlights, then risks.' }
    script.push(use('skill_create', skill), say('skill saved'))
    assert.equal((await post('/api/chat', { text: 'teach yourself the weekly report' })).status, 200)
    const ask = await decide(false, e => e.kind === 'skill')
    assert.match(ask.detail, /three highlights/)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'skill saved')
    assert.equal(fs.existsSync(path.join(data, 'skills', 'weekly-report')), false, 'a rejected skill was written')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')

    const t1 = Date.now()
    script.push(use('skill_create', skill), say('skill saved again'))
    assert.equal((await post('/api/chat', { text: 'please do save it' })).status, 200)
    await decide(true, e => e.kind === 'skill')
    await waitAfter(t1, e => e.type === 'message' && e.text === 'skill saved again')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')
    assert.match(fs.readFileSync(path.join(data, 'skills', 'weekly-report', 'SKILL.md'), 'utf8'), /name: weekly-report[\s\S]*three highlights/)
    assert.deepEqual((await extView()).skills.map(k => k.name), ['weekly-report'])

    const before = requests.length
    const t2 = Date.now()
    assert.equal((await post('/api/chat', { text: 'what skills do you have?' })).status, 200)
    for (let i = 0; i < 300 && requests.length === before; i++) await sleep(100)
    const catalog = JSON.stringify(requests.at(-1))
    assert.ok(catalog.includes('weekly-report') && catalog.includes('usual format'), 'the new skill is not in Bob\'s catalog')
    await waitAfter(t2, e => e.type === 'status' && e.status === 'idle')
  })
  await check('an MCP server is added after approval, loads on the next message, gets its secret from Settings and can be removed', async () => {
    await sleep(1500)
    const t0 = Date.now()
    const spec = { name: 'fake', command: 'node', args: [path.join(root, 'test', 'fake-mcp.mjs')], env_names: ['FAKE_TOKEN'] }
    script.push(use('mcp_add', spec), say('server added'))
    assert.equal((await post('/api/chat', { text: 'add the fake server' })).status, 200)
    const ask = await decide(true, e => e.kind === 'mcp')
    assert.match(ask.detail, /node .*fake-mcp\.mjs/); assert.match(ask.detail, /FAKE_TOKEN/); assert.match(ask.detail, /without asking each time/)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'server added')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    let view = await extView()
    assert.equal(view.mcp[0].name, 'fake'); assert.deepEqual(view.mcp[0].secrets, [{ name: 'FAKE_TOKEN', set: false }])

    assert.equal((await post('/api/extensions/secret', { server: 'fake', name: 'FAKE_TOKEN', value: 's3cret-value' })).status, 200)
    assert.equal((await post('/api/extensions/secret', { server: 'fake', name: 'OTHER', value: 'x' })).status, 400)
    assert.ok(!JSON.stringify(await extView()).includes('s3cret-value'), 'a secret reached the page')
    await sleep(1500)

    const t1 = Date.now()
    script.push(use('mcp__fake__echo', { text: 'hi' }), use('mcp__fake__show_token', {}), say('used the server'))
    assert.equal((await post('/api/chat', { text: 'use the fake server' })).status, 200)
    await waitAfter(t1, e => e.type === 'message' && e.text === 'used the server')
    const seen = lastSent()
    assert.ok(seen.includes('echo:hi'), 'the MCP tool result is missing')
    assert.ok(seen.includes('token:s3cret-value'), 'the secret did not reach the server')
    assert.ok(requests.at(-1).tools.some(t => t.name === 'mcp__fake__echo'))
    assert.ok(events.some(e => e.type === 'step' && e.name === 'mcp__fake__echo' && e.at >= t1), 'the MCP call is not shown as a step')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')

    assert.equal((await post('/api/extensions/mcp/delete', { name: 'fake' })).status, 200)
    assert.equal((await post('/api/extensions/mcp/delete', { name: 'fake' })).status, 404)
    await sleep(1500)
    const before = requests.length
    const t2 = Date.now()
    assert.equal((await post('/api/chat', { text: 'still there?' })).status, 200)
    for (let i = 0; i < 400 && requests.length === before; i++) await sleep(100)
    assert.ok(!requests.at(-1).tools.some(t => t.name.startsWith('mcp__fake__')), 'the removed server\'s tools are still offered')
    await waitAfter(t2, e => e.type === 'status' && e.status === 'idle')
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

  console.log('Extensions and WeChat')
  await check('a tool server whose command does not exist is refused before anyone is asked', async () => {
    const t0 = Date.now()
    script.push(use('mcp_add', { name: 'ghost', command: 'bobbot-no-such-command', args: [] }), say('could not add'))
    assert.equal((await post('/api/chat', { text: 'add a ghost server' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'could not add')
    assert.ok(!events.some(e => e.type === 'approval' && e.kind === 'mcp' && e.at >= t0), 'an approval was shown for a server that cannot start')
    assert.ok(JSON.stringify(requests.at(-1)?.messages ?? '').includes('not installed'), 'the model was not told why')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    assert.equal((await getJson('/api/extensions')).body.mcp.some(m => m.name === 'ghost'), false)
  })

  await check('the bob-agent bridge endpoint answers with SSE text and done events', async () => {
    const health = await (await fetch('http://127.0.0.1:3731/v1/health')).json()
    assert.equal(health.status, 'ok')
    script.push(say('来自 bridge 的回复'))
    const res = await fetch('http://127.0.0.1:3731/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好', from_user: 'wxid_ann', from_channel: 'wechat' }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes('event: text') && body.includes('来自 bridge 的回复'), 'no text event')
    assert.ok(body.includes('event: done') && body.includes('full_text'), 'no done event')
    const convs = (await getJson('/api/conversations')).body.items
    assert.ok(convs.some(c => c.title === 'WeChat · wxid_ann'), 'no conversation for the WeChat contact')
  })

  await check('a home-screen device can subscribe and gets a notification channel', async () => {
    const before = (await getJson('/api/push/config')).body.subscriptions
    const endpoint = 'https://example.invalid/push/1'
    const saved = await post('/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } })
    assert.equal(saved.status, 200)
    assert.equal(saved.data.subscriptions, before + 1)
    assert.ok((await clerkView()).channels.some(c => c.name === '手机通知'), 'no notification channel was created')
    assert.equal((await post('/api/push/unsubscribe', { endpoint })).status, 200)
  })

  await check('a conversation can be renamed, and an empty name is refused', async () => {
    const cid = (await post('/api/conversations', {})).data.id
    assert.equal((await post('/api/conversations/rename', { id: cid, title: '   ' })).status, 400)
    assert.equal((await post('/api/conversations/rename', { id: 'nope', title: 'x' })).status, 404)
    const renamed = await post('/api/conversations/rename', { id: cid, title: '  My weekly review  ' })
    assert.equal(renamed.status, 200)
    const item = (await getJson('/api/conversations')).body.items.find(c => c.id === cid)
    assert.equal(item.title, 'My weekly review')
    assert.equal((await post('/api/conversations/delete', { id: cid })).status, 200)
  })

  await check('a feature package adds a tool, a route and a panel, and a broken one is refused', async () => {
    const code = `export default function setup(ctx) {
  ctx.registerTool({ name: 'ping', description: 'Ping', handler: () => 'pong' })
  ctx.registerRoute({ method: 'GET', path: '/ping', handler: () => ({ ok: true }) })
}`
    const installed = await post('/api/features/install', { name: 'demo', title: 'Demo', description: 'test feature', code, panelHtml: '<h1>demo</h1>' })
    assert.equal(installed.status, 200)
    const list = (await getJson('/api/features')).body.items
    assert.ok(list.some(f => f.name === 'demo' && f.status === 'ok' && f.tools.includes('f_demo_ping')), 'feature not listed with its tool')
    assert.equal((await fetch(`${base}/api/f/demo/ping`, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${base}/f/demo/panel.html`, { headers: { cookie } })).status, 200)
    const broken = await post('/api/features/install', { name: 'broken', title: 'Broken', code: 'export default function setup() { throw new Error("boom") }' })
    assert.equal(broken.status, 400)
    const panel = await fetch(`${base}/f/demo/panel.html`, { headers: { cookie } })
    assert.match(panel.headers.get('content-security-policy'), /^sandbox allow-scripts/, 'the panel is not sandboxed')
    assert.equal((await fetch(`${base}/f/demo/feature.json`, { headers: { cookie } })).status, 404)
    assert.equal((await fetch(`${base}/f/demo/panel.html`)).status, 401)
    assert.equal((await post('/api/features/remove', { name: 'demo' })).status, 200)
    assert.ok(!(await getJson('/api/features')).body.items.some(f => f.name === 'demo'))
    assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /default-src 'self'/)
  })
  await check('the nightly dream folds chats into memory, and a check-in can speak or stay silent', async () => {
    // A real model takes seconds to answer, and the dream has to wait for it.
    script.push(async () => { await sleep(1500); return say('{"add":[{"kind":"fact","text":"用户在上海工作"}],"insights":["最近常问天气"]}') })
    const dreamed = await post('/api/memory/dream', {})
    assert.equal(dreamed.status, 200)
    assert.equal(dreamed.data.ok, true)
    const saved = (await getJson('/api/memory')).body
    const item = saved.items.find(i => i.text === '用户在上海工作')
    assert.ok(item, 'the dream did not save the memory')
    assert.ok(saved.insights.some(i => i.text === '最近常问天气'), 'the dream did not keep the insight')
    assert.equal((await post('/api/memory/delete', { id: item.id })).status, 200)

    assert.equal((await post('/api/proactive', { enabled: true, times: ['09:00'] })).status, 200)
    assert.equal((await post('/api/proactive', { level: 2 })).status, 400)
    const leveled = await post('/api/proactive', { level: 0.8 })
    assert.equal(leveled.status, 200); assert.equal(leveled.data.level, 0.8)
    await post('/api/proactive', { enabled: false }) // so the clock cannot start a check-in in the middle of this script
    script.push(async () => { await sleep(1500); return say('你今天有两个待办，要我帮你排一下吗？') })
    const sent = await post('/api/proactive/run', {})
    assert.equal(sent.data.sent, true)
    assert.ok((await clerkView()).inbox.some(n => n.title === '主动关心'), 'the check-in did not reach the inbox')
    script.push(say('[SILENT]'))
    const quiet = await post('/api/proactive/run', {})
    assert.equal(quiet.data.sent, false)
  })

  await check('a dream with an unusable answer reports failure and changes nothing', async () => {
    const before = (await getJson('/api/memory')).body.items.length
    script.push(say('sorry, no json here'))
    const dreamed = await post('/api/memory/dream', {})
    assert.equal(dreamed.data.ok, false)
    const after = (await getJson('/api/memory')).body
    assert.equal(after.items.length, before); assert.equal(after.lastDream.failed, true)
  })

  await check('a new chat is given what Bob remembers, and only once', async () => {
    await post('/api/memory/add', { text: '用户常驻上海', kind: 'preference' })
    const t0 = Date.now()
    script.push(say('记住了。'))
    const first = await post('/api/chat', { text: '明天上海天气' })
    assert.equal(first.status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === '记住了。')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    assert.ok(JSON.stringify(requests.at(-1).messages.at(-1)).includes('用户常驻上海'), 'the memory was not given to the model')
    const t1 = Date.now()
    script.push(say('好的。'))
    await post('/api/chat', { cid: first.data.cid, text: '后天呢' })
    await waitAfter(t1, e => e.type === 'message' && e.text === '好的。')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')
    assert.ok(!JSON.stringify(requests.at(-1).messages.at(-1)).includes('用户常驻上海'), 'the same memory was sent twice')
  })

  const runsReach = async (id, count) => {
    for (let i = 0; i < 300; i++) {
      const job = (await clerkView()).jobs.find(j => j.id === id)
      if ((job?.runs?.length ?? 0) >= count) return job
      await sleep(100)
    }
    throw new Error(`job ${id} did not reach ${count} runs`)
  }
  let routineId
  await check('a chat becomes a routine: confirmed, tried once, and scheduled only when turned on', async () => {
    const t0 = Date.now()
    script.push(
      use('list_files', { path: '.' }),
      use('routine_steps', {}),
      use('routine_save', { title: 'Daily digest', goal: 'Collect the news', steps: ['Open the page', 'Summarize it'], success_check: 'At least one item', on_missing: 'Say there was nothing today', schedule: { type: 'daily', time: '08:00' } }),
      say('Saved.'),
      use('run_report', { met: true, evidence: 'one item' }),
      say('Digest ready.'),
    )
    assert.equal((await post('/api/chat', { text: 'save that as a routine' })).status, 200)
    const ask = await waitAfter(t0, e => e.type === 'approval' && e.summary === 'Save as a routine: Daily digest')
    assert.ok(requests.some(r => JSON.stringify(r.messages).includes('ok: list_files')), 'the real steps were not available')
    assert.ok(ask.detail.includes('Success check: At least one item'))
    assert.equal((await post('/api/approve', { id: ask.id, allow: true })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Saved.')
    routineId = (await clerkView()).jobs.find(j => j.title === 'Daily digest').id
    const job = await runsReach(routineId, 1)
    assert.equal(job.enabled, false); assert.equal(job.nextRun, null); assert.equal(job.trial, 'done')
    assert.equal(job.runs[0].status, 'ok'); assert.equal(job.runs[0].trial, true); assert.equal(job.playbook.check, 'At least one item')
    const turnedOn = (await clerkView()).jobs.length && await post('/api/clerk/job/toggle', { id: routineId, enabled: true })
    assert.equal(turnedOn.status, 200)
    const on = (await clerkView()).jobs.find(j => j.id === routineId)
    assert.equal(on.enabled, true); assert.ok(on.nextRun > Date.now())
  })
  await check('a routine that misses its check, or does not report, is not called done', async () => {
    script.push(use('run_report', { met: false, evidence: 'the page was empty' }), say('No digest.'))
    assert.equal((await post('/api/clerk/job/run', { id: routineId })).status, 200)
    let job = await runsReach(routineId, 2)
    assert.equal(job.runs[0].status, 'failed'); assert.ok(job.lastResult.includes('the page was empty'))
    script.push(say('Done anyway.'))
    assert.equal((await post('/api/clerk/job/run', { id: routineId })).status, 200)
    job = await runsReach(routineId, 3)
    assert.equal(job.runs[0].status, 'partial')
  })
  await check('a scheduled run prepares a draft, and only the owner\'s approval runs it', async () => {
    const output = path.join(data, 'workspace', 'draft-output.txt')
    script.push(use('run_command', { command: 'echo draft-ran > draft-output.txt' }), use('run_report', { met: true, evidence: 'prepared' }), say('Prepared it.'))
    assert.equal((await post('/api/clerk/job/run', { id: routineId })).status, 200)
    const job = await runsReach(routineId, 4)
    assert.equal(job.runs[0].status, 'drafted')
    const [draft] = (await clerkView()).drafts
    assert.equal(draft.summary, 'Run a command'); assert.ok(draft.detail.includes('draft-ran')); assert.equal(draft.action, undefined)
    assert.ok(!fs.existsSync(output), 'the command ran without approval')
    const done = await post('/api/clerk/draft/decide', { id: draft.id, allow: true })
    assert.equal(done.status, 200); assert.equal(done.data.status, 'done')
    assert.ok(fs.existsSync(output), 'the approved command did not run')
    assert.ok(!(await clerkView()).drafts.some(d => d.id === draft.id), 'the draft is still waiting')
    assert.equal((await post('/api/clerk/draft/decide', { id: draft.id, allow: true })).status, 404)
  })
  await check('a discarded draft never runs', async () => {
    const output = path.join(data, 'workspace', 'never.txt')
    script.push(use('run_command', { command: 'echo no > never.txt' }), use('run_report', { met: true, evidence: 'prepared' }), say('Prepared again.'))
    assert.equal((await post('/api/clerk/job/run', { id: routineId })).status, 200)
    await runsReach(routineId, 5)
    const [draft] = (await clerkView()).drafts
    assert.equal((await post('/api/clerk/draft/decide', { id: draft.id, allow: false })).data.status, 'rejected')
    assert.ok(!fs.existsSync(output)); assert.ok(!(await clerkView()).drafts.some(d => d.id === draft.id), 'the draft is still waiting')
  })

  const featureArgs = text => ({ name: 'weather', title: 'Weather', code: `export default function setup(ctx) { ctx.registerTool({ name: 'now', description: 'Weather now', handler: () => '${text}' }) }`,
    widgets: [{ id: 'now', anchor: 'header-right', html: '<b>sun</b>' }], css: '.msg { color: inherit }' })
  const trialNow = async () => (await getJson('/api/features')).body.trial
  await check('Bob changes himself in a chat: it is live at once, and stays only because the owner keeps it', async () => {
    const t0 = Date.now()
    script.push(use('feature_create', featureArgs('sunny')), say('Look at the top right.'))
    assert.equal((await post('/api/chat', { text: 'add a weather icon' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Look at the top right.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    assert.ok(lastSent().includes('live on trial'), 'the model was not told it is a trial')
    assert.equal(events.filter(e => e.at >= t0 && e.type === 'approval').length, 0)
    assert.equal((await trialNow()).name, 'weather')
    const style = await (await fetch(`${base}/f/weather/style.css`, { headers: { cookie } })).text()
    assert.match(style, /^@scope \(body\) to \(\.card\.ask/, 'the styling is not scoped')
    assert.match(await (await fetch(`${base}/f/weather/widget-now.html`, { headers: { cookie } })).text(), /window\.bob = [\s\S]*<b>sun<\/b>$/)
    assert.equal((await post('/api/features/trial', { keep: true })).status, 200)
    await sleep(3200) // past the trial time: a kept feature must still be there
    const kept = (await getJson('/api/features')).body
    assert.equal(kept.trial, null); assert.ok(kept.items.some(f => f.name === 'weather' && f.tools.includes('f_weather_now')))
    const t1 = Date.now()
    script.push(use('mcp__bobbot__f_weather_now', {}), say('It is sunny.'))
    assert.equal((await post('/api/chat', { text: 'weather?' })).status, 200)
    await waitAfter(t1, e => e.type === 'message' && e.text === 'It is sunny.')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')
    assert.ok(lastSent().includes('sunny'), 'the new tool did not reach the model')
  })
  await check('an update nobody answers is undone by itself, back to the kept version', async () => {
    const t0 = Date.now()
    script.push(use('feature_create', featureArgs('rainy')), say('Updated.'))
    assert.equal((await post('/api/chat', { text: 'change it' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Updated.')
    assert.equal((await trialNow()).name, 'weather')
    const done = await waitAfter(t0, e => e.type === 'trial_done')
    assert.equal(done.kept, false); assert.equal(done.reason, 'timeout')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    assert.equal(await trialNow(), null)
    const t1 = Date.now()
    script.push(use('mcp__bobbot__f_weather_now', {}), say('Still sunny.'))
    assert.equal((await post('/api/chat', { text: 'weather again?' })).status, 200)
    await waitAfter(t1, e => e.type === 'message' && e.text === 'Still sunny.')
    await waitAfter(t1, e => e.type === 'status' && e.status === 'idle')
    assert.ok(lastSent().includes('sunny') && !lastSent().includes('rainy'), 'the undone version is still in use')
  })
  await check('Bob cannot change himself in a scheduled run or by editing his own program files', async () => {
    const t0 = Date.now()
    script.push(use('write_file', { path: path.join(root, 'server.mjs'), content: '// hacked' }), say('Could not.'))
    assert.equal((await post('/api/chat', { text: 'edit your own code' })).status, 200)
    await waitAfter(t0, e => e.type === 'message' && e.text === 'Could not.')
    await waitAfter(t0, e => e.type === 'status' && e.status === 'idle')
    assert.ok(lastSent().includes('own program files'), 'writing the program was not refused')
    assert.equal(events.filter(e => e.at >= t0 && e.type === 'approval').length, 0)
    assert.ok(!fs.readFileSync(path.join(root, 'server.mjs'), 'utf8').startsWith('// hacked'))
    const before = (await clerkView()).jobs.find(j => j.id === routineId).runs.length
    script.push(use('feature_create', { name: 'sneaky', title: 'Sneaky', css: 'a{}' }), use('run_report', { met: true, evidence: 'x' }), say('Done.'))
    assert.equal((await post('/api/clerk/job/run', { id: routineId })).status, 200)
    await runsReach(routineId, before + 1)
    assert.ok(!(await getJson('/api/features')).body.items.some(f => f.name === 'sneaky')); assert.equal(await trialNow(), null)
    assert.equal((await post('/api/features/remove', { name: 'weather' })).status, 200)
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
