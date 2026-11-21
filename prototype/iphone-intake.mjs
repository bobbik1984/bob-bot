import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Agent } from './agent.mjs'
import { formatLocal } from './clerk.mjs'
import { writeAtomic } from './store.mjs'

export function iphoneIntake({ dir, clerk, profile, charge, changed }) {
  const file = path.join(dir, 'iphone-intake.key')
  let busy = false
  function code(rotate = false) {
    if (!rotate) {
      try { return fs.readFileSync(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    const key = crypto.randomBytes(32).toString('hex')
    writeAtomic(file, key)
    return key
  }
  function accepts(header) {
    const key = /^Bearer ([a-f0-9]{64})$/.exec(header || '')?.[1]
    if (!key || !fs.existsSync(file)) return false
    const expected = fs.readFileSync(file)
    return expected.length === key.length && crypto.timingSafeEqual(expected, Buffer.from(key))
  }
  async function work() {
    if (busy) return
    const item = clerk.captures.findLast(c => c.status === 'pending')
    if (!item) return
    busy = true
    const agent = new Agent(path.join(dir, 'iphone-extractor'))
    let timer
    try {
      const cfg = profile()
      await agent.ensure({ model: cfg.model, apiKey: cfg.apiKey, reasoningEffort: 'low', extractionOnly: true })
      let output = '', started = false
      const done = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 90000)
        agent.on('text', (_, text) => { output = text })
        agent.on('status', (_, status) => {
          if (status === 'running') started = true
          if (started && status === 'idle') resolve()
        })
        agent.on('error_turn', () => reject(new Error('provider')))
        agent.on('exit', () => reject(new Error('exit')))
        agent.on('usage', (_, model, usage) => { if (charge(model, usage).exceeded) reject(new Error('budget')) })
      })
      const prompt = 'Read only the quoted chat in source. Return {"tasks":[{"title":"action in source language","quote":"exact supporting excerpt","due":null}]}. Extract only clear pending actions, up to 8. No inferred tasks or deadlines. Use local YYYY-MM-DDTHH:MM for explicit deadlines (09:00 for date only); return an empty list if uncertain. ' +
        JSON.stringify({ received: formatLocal(item.at, clerk.timezone), timezone: clerk.timezone, source: item.text })
      await Promise.all([done, agent.prompt(item.id,prompt)])
      const parsed = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,''))
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length > 8) throw new Error('format')
      clerk.finishCapture(item, parsed.tasks)
    } catch {
      clerk.finishCapture(item, [])
    } finally {
      clearTimeout(timer)
      agent.stop()
      agent.forget(item.id)
      busy = false
      changed()
      if (clerk.captures.some(c => c.status === 'pending')) setImmediate(() => work().catch(() => {}))
    }
  }
  return { code, accepts, wake: () => { setImmediate(() => work().catch(() => {})) } }
}
