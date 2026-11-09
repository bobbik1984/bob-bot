// Runs wechaty for one personal WeChat account and relays text messages to Bob over loopback.
// Its packages live in WECHAT_HOME, so a WeChat failure stays inside this process.
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.WECHAT_HOME
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

if (!home) { send({ type: 'error', message: 'WECHAT_HOME is not set' }); process.exit(1) }
const require = createRequire(path.join(home, 'package.json'))

let WechatyBuilder
try {
  const module = await import(pathToFileURL(require.resolve('wechaty')).href)
  WechatyBuilder = module.WechatyBuilder ?? module.default?.WechatyBuilder
} catch (error) {
  send({ type: 'error', message: `cannot load wechaty: ${error.message}` })
  process.exit(1)
}
if (!WechatyBuilder) { send({ type: 'error', message: 'wechaty is missing WechatyBuilder' }); process.exit(1) }

const bot = WechatyBuilder.build({ name: 'bobbot', puppet: 'wechaty-puppet-wechat4u' })
const seen = new Set()
const remember = id => { if (seen.has(id)) return false; seen.add(id); if (seen.size > 300) seen.delete(seen.values().next().value); return true }

bot.on('scan', qr => send({ type: 'qr', qr }))
bot.on('login', user => send({ type: 'status', state: 'online', name: user.name() }))
bot.on('logout', () => send({ type: 'status', state: 'offline' }))
bot.on('error', error => send({ type: 'error', message: error.message }))

bot.on('message', async message => {
  try {
    if (message.self()) return
    if (message.room()) return // group chats are not handled yet
    if (message.type() !== bot.Message.Type.Text) return
    if (!remember(message.id)) return
    const text = message.text().trim()
    if (!text) return
    const talker = message.talker()
    const response = await fetch(`${process.env.BOBBOT_URL}/api/wechat/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.WECHAT_SECRET, from: talker.id, name: talker.name() || 'WeChat', text }),
      signal: AbortSignal.timeout(240000),
    })
    const data = await response.json().catch(() => ({}))
    const reply = typeof data.reply === 'string' && data.reply.trim() ? data.reply.trim() : '(Bob did not answer)'
    await talker.say(reply)
  } catch (error) {
    console.error('relay failed:', error.message)
  }
})

process.on('SIGTERM', async () => { try { await bot.stop() } catch { /* gone */ } process.exit(0) })
process.on('SIGINT', async () => { try { await bot.stop() } catch { /* gone */ } process.exit(0) })

try { await bot.start() } catch (error) {
  send({ type: 'error', message: error.message })
  process.exit(1)
}
