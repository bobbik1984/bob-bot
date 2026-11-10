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
  const emulate = async kind => {
    if (kind === 'phone') {
      await phone.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
      await phone.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    } else {
      await phone.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false })
      await phone.call('Emulation.setTouchEmulationEnabled', { enabled: false })
    }
  }
  const openWindow = async () => {
    await phone.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
    await waitFor(() => phone.evaluate("!document.getElementById('login').hidden || !document.getElementById('app').hidden"))
    if (await phone.evaluate("!document.getElementById('login').hidden")) {
      for (const k of ['2', '4', '6', '8']) await phone.evaluate(`[...document.querySelectorAll('.pad button')].find(b => b.textContent === '${k}').click()`)
    }
    await waitFor(() => phone.evaluate("!document.getElementById('app').hidden"))
    await phone.evaluate('openBrowser()') // the page has no button for this: it opens when Bob asks for a takeover
    await waitFor(() => phone.evaluate('document.getElementById("screen").width > 300'))
  }
  await emulate('phone')
  await openWindow()

  const [debugPort] = fs.readFileSync(path.join(data, 'browser_profile', 'DevToolsActivePort'), 'utf8').trim().split('\n')
  const cloudPage = (await (await fetch(`http://127.0.0.1:${debugPort.trim()}/json/list`)).json()).find(p => p.type === 'page')
  const cloud = await connect(cloudPage.webSocketDebuggerUrl)
  const button = `<body style="margin:0"><button id=b style="position:fixed;left:60px;top:240px;width:220px;height:90px" onclick="document.title='CLICKED'">tap</button></body><title>start</title>`
  const responsive = '<meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0"><input id=i style="position:fixed;left:30px;top:100px;width:200px;height:50px"><div id=h style="position:fixed;left:0;top:300px;width:100%;height:200px"></div></body><title>start</title>'
  const canvasBox = () => phone.evaluate("(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height } })()")

  /** Loads a page into the cloud browser and returns where the element is on the owner's screen. */
  const show = async (html, id) => {
    await cloud.call('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) })
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'start')
    await sleep(1200) // let the first frame with the new page scale arrive
    const box = await cloud.evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight } })()`)
    const canvas = await canvasBox()
    return { box, x: canvas.l + ((box.l + box.w / 2) / box.iw) * canvas.w, y: canvas.t + ((box.t + box.h / 2) / box.ih) * canvas.h }
  }
  const place = () => show(button, 'b')
  const clickWithMouse = async ({ x, y }) => {
    await phone.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await phone.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await phone.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const facts = () => cloud.evaluate('({ ua: navigator.userAgent, touch: navigator.maxTouchPoints, iw: innerWidth })')

  console.log('Phone')
  await check('a page with no viewport tag is laid out wider than the phone, as on a real phone', async () => {
    const { box } = await place()
    assert.ok(box.iw > 390, `layout width ${box.iw}`)
  })
  await check('a mouse click on the canvas reaches the right spot on the page', async () => {
    await clickWithMouse(await place())
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'CLICKED', 5000)
  })
  await check('a touch tap on the canvas reaches the right spot on the page', async () => {
    const { x, y } = await place()
    await phone.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await phone.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'CLICKED', 5000)
  })
  await check('the phone gets a mobile browser: mobile user agent, touch, and a page exactly as wide as its screen', async () => {
    await show(responsive, 'i')
    const f = await facts()
    assert.match(f.ua, /Mobile/); assert.ok(f.touch > 0, `touch points ${f.touch}`)
    const canvas = await canvasBox()
    assert.equal(f.iw, Math.round(canvas.w), `page ${f.iw}px wide on a ${canvas.w}px screen`)
  })

  console.log('PC')
  await emulate('desktop')
  await openWindow() // the server changes the browser to a desktop one and reloads the page
  await check('a PC gets a desktop browser: desktop user agent, no touch, and a page as wide as the window', async () => {
    await show(responsive, 'i')
    const f = await facts()
    assert.doesNotMatch(f.ua, /Mobile/); assert.equal(f.touch, 0)
    const canvas = await canvasBox()
    assert.ok(canvas.w > 900, `window only ${canvas.w}px`)
    assert.equal(f.iw, Math.round(canvas.w), `page ${f.iw}px wide in a ${canvas.w}px window`)
  })
  await check('a mouse click reaches the right spot', async () => {
    await clickWithMouse(await place())
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'CLICKED', 5000)
  })
  await check('hovering over the window reaches the page, with no button pressed', async () => {
    const { x, y } = await show('<body style="margin:0" onmousemove="document.title=\'HOVER\'"><div id=b style="position:fixed;left:0;top:0;width:100%;height:100%"></div></body><title>start</title>', 'b')
    await phone.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 40, y: y - 40 })
    await phone.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await waitFor(async () => (await cloud.evaluate('document.title')) === 'HOVER', 5000)
  })
  await check('typing on the PC keyboard goes straight into the page', async () => {
    const field = await show(responsive, 'i')
    await clickWithMouse(field)
    await sleep(300)
    for (const key of ['h', 'i']) {
      await phone.call('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key })
      await phone.call('Input.dispatchKeyEvent', { type: 'keyUp', key })
    }
    await waitFor(async () => (await cloud.evaluate('document.getElementById("i").value')) === 'hi', 5000)
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
