// Runs feature packages' server code, away from Bob. The parent starts this file with Node's permission system,
// so code here can read only the feature folders, write only the feature storage folder, and cannot start programs.
// It talks to the parent over IPC and holds no keys, no session and no environment.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const SETUP_TIMEOUT_MS = 5000
const TOOL_RE = /^[a-z][a-z0-9_]{1,40}$/
const loaded = new Map() // feature name -> { tools: Map, routes: Map }

const fail = message => { throw new Error(message) }

function storage(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
  return {
    get: (key, fallback = null) => { const data = read(); return key in data ? data[key] : fallback },
    set: (key, value) => { const data = read(); data[key] = value; fs.writeFileSync(file, JSON.stringify(data)) },
    all: () => read(),
  }
}

async function load({ name, file, storageFile }) {
  const entry = { tools: new Map(), routes: new Map() }
  const ctx = {
    name,
    log: (...args) => process.send({ log: `[feature:${name}] ${args.map(String).join(' ')}`.slice(0, 500) }),
    storage: storage(storageFile),
    registerTool: spec => {
      const tool = String(spec?.name ?? '')
      if (!TOOL_RE.test(tool)) fail('BAD_TOOL_NAME')
      if (typeof spec?.handler !== 'function') fail('BAD_TOOL_HANDLER')
      entry.tools.set(tool, { description: String(spec.description ?? '').slice(0, 300), inputSchema: spec.inputSchema, handler: spec.handler })
    },
    registerRoute: spec => {
      const method = String(spec?.method ?? 'GET').toUpperCase()
      const route = String(spec?.path ?? '')
      if (!['GET', 'POST'].includes(method)) fail('BAD_ROUTE_METHOD')
      if (!route.startsWith('/') || route.includes('..')) fail('BAD_ROUTE_PATH')
      if (typeof spec?.handler !== 'function') fail('BAD_ROUTE_HANDLER')
      entry.routes.set(`${method} ${route}`, spec.handler)
    },
  }
  const module = await import(`${pathToFileURL(file).href}?v=${Date.now()}`)
  if (typeof module.default !== 'function') fail('NO_DEFAULT_EXPORT')
  await Promise.race([
    module.default(ctx),
    new Promise((_, reject) => setTimeout(() => reject(new Error('setup timed out')), SETUP_TIMEOUT_MS)),
  ])
  loaded.set(name, entry)
  return {
    tools: [...entry.tools].map(([tool, spec]) => ({ name: tool, description: spec.description, inputSchema: spec.inputSchema })),
    routes: [...entry.routes.keys()].map(key => { const [method, route] = key.split(' '); return { method, path: route } }),
  }
}

async function handle(msg) {
  if (msg.op === 'load') return load(msg)
  if (msg.op === 'unload') { loaded.delete(msg.name); return true }
  const entry = loaded.get(msg.name) ?? fail('This feature is not loaded.')
  if (msg.op === 'tool') {
    const tool = entry.tools.get(msg.tool) ?? fail('No such tool.')
    const result = await tool.handler(msg.args ?? {})
    return typeof result === 'string' ? result : JSON.stringify(result ?? null)
  }
  if (msg.op === 'route') {
    const handler = entry.routes.get(`${msg.method} ${msg.path}`) ?? fail('No such route.')
    return (await handler({ query: new URLSearchParams(msg.query ?? {}), body: msg.body ?? null })) ?? { ok: true }
  }
  return fail('Unknown request.')
}

process.on('message', msg => {
  handle(msg).then(
    result => process.send({ id: msg.id, result }),
    error => process.send({ id: msg.id, error: String(error?.message ?? error).slice(0, 500) }),
  )
})
// One feature's stray error must not take the others down with it.
process.on('unhandledRejection', error => process.send({ log: `[features] unhandled: ${String(error?.message ?? error).slice(0, 300)}` }))
process.on('disconnect', () => process.exit(0))
