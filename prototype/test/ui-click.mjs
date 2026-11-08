// Regression test for the phone browser window: drives the real web page in a phone-sized Chrome and clicks
// the cloud browser through the canvas, with a mouse and with touch. It uses a page with no mobile viewport tag,
// which Chrome lays out 980px wide, the case that used to miss every click.
// Run: npm run test:ui   (needs Node 22+ and Chrome, Edge or Chromium; set CHROME_PATH if it is not found)
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find(p => fs.existsSync(p))
assert.ok(chrome, 'No Chrome/Chromium found. Set CHROME_PATH.')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbot-ui-data-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbot-ui-chrome-'))
const PORT = 8802, DEBUG = 9445
const env = { ...process.env, BOBBOT_DATA: data, PORT: String(PORT), HOST: '127.0.0.1', DEEPSEEK_API_KEY: 'test-key' }
spawnSync(process.execPath, ['set-pin.mjs', '2468'], { cwd: root, env })
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', d => { log += d }); server.stderr.on('data', d => { log += d })
const ui = spawn(chrome, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG}`, '--no-first-run', ...(process.env.BOBBOT_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' })

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`  ok   ${name}`) } catch (error) { results.push(false); console.log(`  FAIL ${name}\n       ${error.message}`) }
}
const connect = async url => {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', m => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d.result); waiting.delete(d.id) })
  const call = (method, params = {}) => new Promise(resolve => { const me = ++id; waiting.set(me, resolve); ws.send(JSON.stringify({ id: me, method, params })) })
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  return { call, evaluate, close: () => ws.close() }
}
async function waitFor(fn, ms = 20000) {
  for (let waited = 0; waited < ms; waited += 200) { const v = await Promise.resolve().then(fn).catch(() => undefined); if (v) return v; await sleep(200) }
  throw new Error('timed out')
}

try {
  await waitFor(() => log.includes('BobBot prototype'))
  const uiPage = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json()).find(p => p.type === 'page'))
  const phone = await connect(uiPage.webSocketDebuggerUrl)
  await phone.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await phone.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitFor(() => phone.evaluate("document.querySelectorAll('.pad button').length > 0"))
  for (const k of ['2', '4', '6', '8']) await phone.evaluate(`[...document.querySelectorAll('.pad button')].find(b => b.textContent === '${k}').click()`)
  await waitFor(() => phone.evaluate("!document.getElementById('app').hidden"))
  await phone.evaluate("document.getElementById('openBrowser').click()")
  await waitFor(() => phone.evaluate('document.getElementById("screen").width > 300'))

  const [debugPort] = fs.readFileSync(path.join(data, 'browser_profile', 'DevToolsActivePort'), 'utf8').trim().split('\n')
  const cloudPage = (await (await fetch(`http://127.0.0.1:${debugPort.trim()}/json/list`)).json()).find(p => p.type === 'page')
  const cloud = await connect(cloudPage.webSocketDebuggerUrl)
  const html = `<body style="margin:0"><button id=b style="position:fixed;left:60px;top:240px;width:220px;height:90px" onclick="document.title='CLICKED'">tap</button></body><title>start</title>`

  const place = async () => {
    await cloud.call('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) })
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'start')
    await sleep(1200) // let the first frame with the new page scale arrive
    const box = await cloud.evaluate("(() => { const r = document.getElementById('b').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight } })()")
    const canvas = await phone.evaluate("(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height } })()")
    return { box, x: canvas.l + ((box.l + box.w / 2) / box.iw) * canvas.w, y: canvas.t + ((box.t + box.h / 2) / box.ih) * canvas.h }
  }

  await check('the test page is laid out wider than the phone, as sites without a viewport tag are', async () => {
    const { box } = await place()
    assert.ok(box.iw > 390, `layout width ${box.iw}`)
  })
  await check('a mouse click on the canvas reaches the right spot on the page', async () => {
    const { x, y } = await place()
    await phone.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await phone.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await phone.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'CLICKED', 5000)
  })
  await check('a touch tap on the canvas reaches the right spot on the page', async () => {
    const { x, y } = await place()
    await phone.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await phone.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'CLICKED', 5000)
  })
  cloud.close(); phone.close()
} catch (error) {
  results.push(false)
  console.log(`  FAIL setup\n       ${error.message}\n${log.slice(-600)}`)
} finally {
  ui.kill()
  server.kill('SIGTERM')
  await sleep(2500)
  server.kill('SIGKILL')
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
setTimeout(() => process.exit(failed ? 1 : 0), 200)
