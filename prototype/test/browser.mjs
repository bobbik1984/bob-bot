// Checks the browser engine against local pages: frames, shadow DOM, tabs, dialogs, downloads, the address guard and crash recovery.
// Needs Chrome, Edge or Chromium, and no network or API key. Run: npm run test:browser
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { CloudBrowser } from '../browser.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbot-browser-'))
const hits = []
const long = Array.from({ length: 1500 }, (_, i) => `line-${i}`).join(' ')
const page = body => `<!doctype html><meta charset=utf-8><body style="margin:0">${body}`
let port = 0
const routes = {
  '/main': () => page(`
    <h1>Fixture</h1>
    <shadow-host id=sh></shadow-host>
    <div id=pdiv style="cursor:pointer;width:120px" onclick="fetch('/hit/div')">Plain div button</div>
    <input id=pw type=password value="hunter2-secret" aria-label=Secret>
    <input id=txt aria-label=Note value="kept">
    <select id=sel onchange="fetch('/hit/sel-'+this.value)"><option value=a>Apple</option><option value=b>Banana</option></select>
    <div style="position:relative;width:200px;height:40px"><button id=under onclick="fetch('/hit/under')">Under</button>
      <div style="position:absolute;inset:0;background:#eee">overlay blocker</div></div>
    <button onclick="alert('hello')">Alert me</button>
    <button onclick="fetch('/hit/confirm-'+confirm('sure?'))">Confirm me</button>
    <a href="/other" target=_blank>New tab link</a>
    <a href="/redirect">Redirect link</a>
    <a href="/file.csv" download>Get file</a>
    <input type=file id=up onchange="fetch('/hit/up-'+this.files[0].name)">
    <div style="height:900px"></div>
    <iframe src="/inner" width=300 height=120></iframe>
    <iframe src="http://localhost:${port}/cross" width=300 height=160></iframe>
    <table><tr><th>K<th>V<tr><td>rate<td>42</table>
    <p>${long}</p>
    <script>customElements.define('shadow-host',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<button onclick="fetch(\\'/hit/shadow\\')">Shadow button</button><p>Shadow words</p>'}});
      setTimeout(()=>document.body.insertAdjacentHTML('afterbegin','<p>Late arrival</p>'),1500)</script>`),
  '/inner': () => page(`<button onclick="fetch('/hit/same-frame')">Same frame button</button>`),
  '/cross': () => page(`<p>Cross words</p><button onclick="fetch('/hit/cross')">Cross frame button</button><input aria-label="Cross field">`),
  '/other': () => page('<h2>Other page</h2>'),
  '/guarded': () => page(`<iframe src="/private-frame" width=200 height=100></iframe><a href="/redirect">Redirect link</a>`),
  '/slow': () => page(`<div id=o>waiting</div><script>fetch('/api-slow').then(r=>r.text()).then(t=>o.textContent=t)</script>`),
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  hits.push(url)
  if (url.startsWith('/hit/')) { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); return res.end('ok') }
  if (url === '/redirect') { res.writeHead(302, { Location: '/private-page' }); return res.end() }
  if (url === '/file.csv') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' }); return res.end('a,b\n1,2\n') }
  if (url === '/api-slow') return setTimeout(() => res.end('loaded by script'), 1200)
  res.writeHead(routes[url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(routes[url]?.() ?? 'none')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
port = server.address().port
const base = `http://127.0.0.1:${port}`
const guard = async url => { if (/private/.test(url)) throw new Error('Local and private network addresses are blocked'); return url }
const browser = new CloudBrowser(data, { guard })
await browser.start()

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`) } catch (error) { fail++; console.log(`  FAIL ${name}\n       ${error.message}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const idOf = (snap, words) => { const m = snap.split('\n').find(l => l.includes(`"${words}"`))?.match(/^\[(\d+)\]/); assert.ok(m, `no element "${words}" in:\n${snap.slice(0, 1800)}`); return Number(m[1]) }
const hit = async (name, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (hits.includes(name)) return; await sleep(100) } assert.fail(`${name} was not reached`) }
const open = async () => { await browser.navigate(`${base}/main`); return browser.snapshot() }
const toFrames = async () => { await browser.evaluate('window.scrollTo(0, 950)'); await sleep(400); return browser.snapshot() }

await check('the snapshot reaches shadow DOM and clickable divs, and shows dropdown options', async () => {
  const s = await open()
  idOf(s, 'Shadow button'); idOf(s, 'Plain div button')
  assert.ok(s.includes('Shadow words')); assert.ok(s.includes('*Apple | Banana'))
})
await check('same-origin and cross-origin frames are seen', async () => {
  const s = await toFrames()
  idOf(s, 'Same frame button'); idOf(s, 'Cross frame button')
  assert.ok(s.includes('Cross words')); assert.match(s, /Cross frame button.*\[in frame\]/)
})
await check('a saved password never reaches the snapshot, and is flagged for a person', async () => {
  const s = await open()
  assert.ok(!s.includes('hunter2-secret')); assert.match(s, /Secret.*\(filled\)/); assert.ok(s.includes('browser_request_human'))
  assert.equal((await browser.describe(idOf(s, 'Secret'))).secret, true)
})
await check('clicks land in shadow DOM, divs, same-origin and cross-origin frames', async () => {
  let s = await open()
  await browser.click(idOf(s, 'Shadow button')); await hit('/hit/shadow')
  s = await browser.snapshot(); await browser.click(idOf(s, 'Plain div button')); await hit('/hit/div')
  s = await toFrames(); await browser.click(idOf(s, 'Same frame button')); await hit('/hit/same-frame')
  s = await browser.snapshot(); await browser.click(idOf(s, 'Cross frame button')); await hit('/hit/cross')
})
await check('typing works inside a cross-origin frame', async () => {
  await open(); let s = await toFrames()
  await browser.type(idOf(s, 'Cross field'), 'typed here', false)
  s = await browser.snapshot(); assert.match(s, /Cross field.*value: typed here/)
})
await check('a dropdown is chosen by text, and a wrong option lists the real ones', async () => {
  const s = await open(); const id = s.split('\n').find(l => l.includes('<select'))?.match(/^\[(\d+)\]/)[1]
  assert.equal(await browser.select(id, 'Banana'), 'Banana'); await hit('/hit/sel-b')
  await assert.rejects(browser.select(id, 'Cherry'), /Apple \| Banana/)
})
await check('a covered element is refused instead of clicking what is on top of it', async () => {
  const s = await open(); await assert.rejects(browser.click(idOf(s, 'Under')), /overlay blocker/)
  assert.ok(!hits.includes('/hit/under'))
})
await check('dialogs cannot freeze the page: alerts are accepted, confirms cancelled and reported', async () => {
  let s = await open(); await browser.click(idOf(s, 'Alert me'))
  s = await browser.snapshot(); assert.ok(s.includes('alert dialog (accepted): hello'))
  await browser.click(idOf(s, 'Confirm me')); await hit('/hit/confirm-false')
  assert.ok((await browser.snapshot()).includes('confirm dialog (cancelled)'))
})
await check('a target=_blank link becomes a tab that can be listed, switched and closed', async () => {
  const s = await open(); await browser.click(idOf(s, 'New tab link')); await sleep(800)
  assert.match(await browser.tabs(), /2 \(current\):.*Other|other/)
  assert.ok((await browser.snapshot()).includes('Other page'))
  await browser.switchTab(1); assert.ok((await browser.snapshot()).includes('Fixture'))
  await browser.closeTab(2); assert.equal(browser.pages.length, 1)
  await assert.rejects(browser.closeTab(1), /only tab/)
})
await check('old element numbers are refused after moving to another page', async () => {
  const s = await open(); const id = idOf(s, 'Shadow button')
  await browser.navigate(`${base}/other`)
  assert.equal(await browser.describe(id), null)
})
await check('the address guard stops redirects, clicked links and frames, and says why', async () => {
  hits.length = 0
  await browser.navigate(`${base}/guarded`); await sleep(300)
  assert.ok(!hits.includes('/private-frame'), 'the frame was loaded')
  let s = await browser.snapshot(); assert.ok(s.includes('Blocked'), s.slice(0, 400))
  await browser.click(idOf(s, 'Redirect link')); await sleep(300)
  assert.ok(hits.includes('/redirect')); assert.ok(!hits.includes('/private-page'), 'the redirect was followed')
  await assert.rejects(browser.navigate(`${base}/private-direct`), /blocked/)
})
await check('settling waits for content a script fetches', async () => {
  await browser.navigate(`${base}/slow`)
  assert.ok((await browser.snapshot()).includes('loaded by script'))
})
await check('waiting finds late text and reports text that never comes', async () => {
  await browser.navigate(`${base}/main`)
  assert.equal(await browser.waitFor('Late arrival', 5), true)
  assert.equal(await browser.waitFor('never-appears', 1), false)
})
await check('long pages, tables and links are read in pieces', async () => {
  await open()
  const first = await browser.read('text'); const at = Number(first.match(/offset (\d+)/)[1])
  assert.ok(first.includes('line-0')); assert.ok((await browser.read('text', at)).includes('line-1499'))
  assert.ok((await browser.read('tables')).includes('rate\t42')); assert.ok((await browser.read('links')).includes('New tab link ->'))
})
await check('going back returns to the previous page', async () => {
  await open(); await browser.navigate(`${base}/other`); await browser.back()
  assert.ok((await browser.snapshot()).includes('Fixture'))
  await browser.navigate('about:blank').catch(() => {})
})
await check('a download is saved under its own name in the workspace', async () => {
  const s = await open(); await browser.click(idOf(s, 'Get file'))
  for (let i = 0; i < 30 && !browser.listDownloads().includes('report.csv ('); i++) await sleep(100)
  assert.match(browser.listDownloads(), /downloads\/report\.csv/)
  assert.equal(fs.readFileSync(path.join(data, 'workspace/downloads/report.csv'), 'utf8'), 'a,b\n1,2\n')
})
await check('a hidden file input is listed and receives a file', async () => {
  const s = await open(); const id = s.split('\n').find(l => l.includes('type=file')).match(/^\[(\d+)\]/)[1]
  await browser.upload(id, path.join(data, 'workspace/downloads/report.csv')); await hit('/hit/up-report.csv')
})
await check('after a browser crash the next action brings it back', async () => {
  browser.proc.kill('SIGKILL')
  for (let i = 0; i < 50 && !browser.dead; i++) await sleep(100)
  assert.equal(browser.dead, true)
  await browser.navigate(`${base}/other`)
  assert.ok((await browser.snapshot()).includes('Other page'))
})

await browser.close()
server.close()
fs.rmSync(data, { recursive: true, force: true })
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
