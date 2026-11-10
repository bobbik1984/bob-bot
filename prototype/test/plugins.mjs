// Feature packages on their own: the sandbox, trials and undo. Needs no network, browser or API key.
// Run: npm run test:plugins
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkCss, Features } from '../features.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbot-plugins-'))
const secret = path.join(root, 'secrets.json')
fs.writeFileSync(secret, '{"key":"sk-test"}')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`) } catch (error) { fail++; console.log(`  FAIL ${name}\n       ${error.message}`) }
}
const ended = []
const make = () => new Features(path.join(root, 'features'), { onTrialEnd: e => ended.push(e) })
let features = make()
const tool = (body, extra = '') => `export default function setup(ctx) {\n  ctx.registerTool({ name: 'run', description: 'Run', handler: async args => { ${body} } })\n${extra}\n}`
const ask = (name, args) => features.callTool(`f_${name}_run`, args)

await check('a package adds a tool, a route and storage that survive a call', async () => {
  const item = await features.install({ name: 'demo', title: 'Demo', code: tool("ctx.storage.set('n', (ctx.storage.get('n', 0)) + 1); return 'count ' + ctx.storage.get('n')", "  ctx.registerRoute({ method: 'GET', path: '/hi', handler: ({ query }) => ({ hello: query.get('who') }) })") })
  assert.equal(item.status, 'ok'); assert.deepEqual(item.tools.map(t => t.fullName), ['f_demo_run'])
  assert.equal(await ask('demo'), 'count 1'); assert.equal(await ask('demo'), 'count 2')
  assert.deepEqual(await features.callRoute('demo', 'GET', '/hi', { query: { who: 'bob' } }), { hello: 'bob' })
  assert.equal(features.hasRoute('demo', 'GET', '/nope'), false)
})
await check('package code cannot read Bob\'s files, change itself, start programs or see the environment', async () => {
  process.env.BOBBOT_TEST_SECRET = 'visible-to-core-only'
  const probe = `const fs = await import('node:fs'); const cp = await import('node:child_process'); const out = {}
    try { fs.readFileSync(${JSON.stringify(secret)}, 'utf8'); out.read = 'ALLOWED' } catch (e) { out.read = e.code }
    try { fs.writeFileSync(${JSON.stringify(path.join(root, 'features', 'probe', 'server.mjs'))}, 'x'); out.write = 'ALLOWED' } catch (e) { out.write = e.code }
    try { const r = cp.spawnSync('id'); out.spawn = r.error ? r.error.code : 'ALLOWED' } catch (e) { out.spawn = e.code }
    out.env = Object.keys(process.env).filter(k => /KEY|SECRET|TOKEN/.test(k)).length
    return out`
  await features.install({ name: 'probe', title: 'Probe', code: tool(probe) })
  assert.deepEqual(JSON.parse(await ask('probe')), { read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', env: 0 })
  features.remove('probe')
})
await check('a package that fails to start is refused and leaves the earlier version in place', async () => {
  await assert.rejects(features.install({ name: 'demo', title: 'Demo 2', code: 'export default function setup() { throw new Error("boom") }' }), e => e.code === 'FEATURE_FAILED' && /boom/.test(e.detail))
  assert.equal(features.list().find(f => f.name === 'demo').title, 'Demo')
  assert.match(await ask('demo'), /^count /)
  await assert.rejects(features.install({ name: 'fresh', title: 'Fresh', code: 'export default 1' }), e => e.code === 'FEATURE_FAILED')
  assert.ok(!features.list().some(f => f.name === 'fresh')); assert.ok(!fs.existsSync(path.join(root, 'features', 'fresh')))
})
await check('widgets, styling and anchors are checked', async () => {
  const item = await features.install({ name: 'look', title: 'Look', css: '.msg { color: red }', widgets: [{ id: 'w', anchor: 'header-right', html: '<b>hi</b>' }, { id: 'x', anchor: '#feed', place: 'before', html: 'x', width: 99999 }] })
  assert.deepEqual(item.manifest.widgets, [{ id: 'w', anchor: 'header-right', place: 'end', width: 44, height: 36 }, { id: 'x', anchor: '#feed', place: 'before', width: 1200, height: 120 }])
  assert.equal(features.readFile('look', 'widget-w.html'), '<b>hi</b>'); assert.equal(features.readFile('look', 'style.css'), '.msg { color: red }')
  assert.equal(features.readFile('look', 'feature.json'), null); assert.equal(features.readFile('look', '../demo/server.mjs'), null)
  for (const bad of ['a { } } body { display:none', '@import url(x)', 'a { color: red', '</style><script>']) assert.throws(() => checkCss(bad), /BAD_CSS/)
  assert.equal(checkCss('a::after { content: "}" } /* } */'), 'a::after { content: "}" } /* } */')
  await assert.rejects(features.install({ name: 'bad', title: 'Bad', widgets: [{ id: 'w', anchor: 'body > *', html: 'x' }] }), /BAD_WIDGET_ANCHOR/)
  await assert.rejects(features.install({ name: 'bad', title: 'Bad' }), /EMPTY_FEATURE/)
  features.remove('look')
})
await check('a trial that is kept stays, and nothing else can be installed during it', async () => {
  await features.install({ name: 'demo', title: 'Demo v2', code: tool("return 'v2'") }, { trialMs: 60_000 })
  assert.equal(features.trialView().name, 'demo'); assert.equal(await ask('demo'), 'v2')
  await assert.rejects(features.install({ name: 'other', title: 'Other', css: 'a{}' }), /TRIAL_ACTIVE/)
  assert.throws(() => features.remove('demo'), /TRIAL_ACTIVE/)
  await features.endTrial(true)
  assert.equal(features.trialView(), null); assert.equal(await ask('demo'), 'v2')
  assert.deepEqual(ended.at(-1), { name: 'demo', title: 'Demo v2', kept: true, reason: 'kept' })
})
await check('a trial nobody answers is undone when its time is up: an update goes back, a new package goes away', async () => {
  await features.install({ name: 'demo', title: 'Demo v3', code: tool("return 'v3'") }, { trialMs: 300 })
  assert.equal(await ask('demo'), 'v3')
  await sleep(900)
  assert.equal(features.trialView(), null); assert.equal(await ask('demo'), 'v2'); assert.equal(ended.at(-1).reason, 'timeout')
  await features.install({ name: 'newone', title: 'New', css: 'a{}' }, { trialMs: 300 })
  await sleep(900)
  assert.ok(!features.list().some(f => f.name === 'newone')); assert.ok(!fs.existsSync(path.join(root, 'features', 'newone')))
})
await check('a trial whose code crashes or hangs is undone at once, and the others keep working', async () => {
  await features.install({ name: 'crash', title: 'Crash', code: tool('process.exit(1)') }, { trialMs: 60_000 })
  await assert.rejects(ask('crash'), /stopped unexpectedly/)
  await sleep(600)
  assert.equal(features.trialView(), null); assert.equal(ended.at(-1).reason, 'crashed'); assert.ok(!features.list().some(f => f.name === 'crash'))
  assert.equal(await ask('demo'), 'v2')
})
await check('a trial left open when the server stopped is undone at the next start', async () => {
  await features.install({ name: 'demo', title: 'Demo v4', code: tool("return 'v4'") }, { trialMs: 60_000 })
  features.stop() // the server goes down without an answer
  features = make()
  assert.equal(features.recover().name, 'demo')
  await features.loadAll()
  assert.equal(features.trialView(), null); assert.equal(await ask('demo'), 'v2')
})
await check('the version before can be brought back, and removing a package clears it', async () => {
  await features.install({ name: 'demo', title: 'Demo v5', code: tool("return 'v5'") })
  assert.equal(features.list().find(f => f.name === 'demo').hasPrevious, true)
  await features.restorePrevious('demo'); assert.equal(await ask('demo'), 'v2')
  await features.restorePrevious('demo'); assert.equal(await ask('demo'), 'v5')
  features.remove('demo')
  assert.equal(features.findTool('f_demo_run'), null); assert.ok(!fs.existsSync(path.join(root, 'features', 'demo')))
})

features.stop()
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
