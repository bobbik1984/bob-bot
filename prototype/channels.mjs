// Outgoing messages to the owner's chat apps. Each channel is a webhook or bot the owner set up themselves.
// Secrets stay on the server and are never shown to the page or to the model.
import crypto from 'node:crypto'

export const CHANNEL_TYPES = ['lark', 'wecom', 'telegram', 'discord', 'wechat']
const MAX_TEXT = 3500

const HOSTS = {
  lark: /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[\w-]+$/,
  wecom: /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[\w-]+$/,
  discord: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/,
}
const TELEGRAM_TOKEN = /^\d{5,}:[\w-]{30,}$/
const TELEGRAM_CHAT = /^(-?\d+|@\w{4,})$/

const fail = code => Object.assign(new Error(code), { code })

/** Checks what the owner typed and returns the stored shape. Throws an Error whose message is a short code. */
export function validateChannel(input) {
  const type = String(input?.type ?? '')
  if (!CHANNEL_TYPES.includes(type)) throw fail('BAD_TYPE')
  const name = String(input?.name ?? '').trim()
  if (!name || name.length > 40) throw fail('BAD_NAME')
  if (type === 'wechat') {
    // Official WeChat: the bridge keeps the login, and the owner is the person who scanned.
    return { type, name, config: {} }
  }
  if (type === 'telegram') {
    const token = String(input.token ?? '').trim()
    const chatId = String(input.chatId ?? '').trim()
    if (!TELEGRAM_TOKEN.test(token)) throw fail('BAD_TOKEN')
    if (chatId && !TELEGRAM_CHAT.test(chatId)) throw fail('BAD_CHAT_ID')
    return { type, name, config: { token, chatId } }
  }
  const webhook = String(input.webhook ?? '').trim()
  if (!HOSTS[type].test(webhook)) throw fail('BAD_WEBHOOK')
  const config = { webhook }
  if (type === 'lark') {
    const secret = String(input.secret ?? '').trim()
    if (secret) config.secret = secret
  }
  return { type, name, config }
}

/** What the page may see: never the webhook, token or secret. */
export function publicChannel(channel) {
  const c = channel.config
  const hint = channel.type === 'wechat'
    ? '通过官方微信桥发送'
    : channel.type === 'telegram'
    ? `${c.token.split(':')[0]}:••••${c.token.slice(-4)}`
    : `••••${c.webhook.slice(-6)}`
  return { id: channel.id, type: channel.type, name: channel.name, hint, ready: channel.type !== 'telegram' || Boolean(c.chatId), signed: Boolean(c.secret) }
}

const clip = text => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text)

/** The HTTP request for one message. Pure, so it can be tested without a network. */
export function buildRequest(channel, text, nowMs = Date.now()) {
  const body = clip(String(text))
  const c = channel.config
  const post = (url, json) => ({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) } })
  switch (channel.type) {
    case 'lark': {
      const json = { msg_type: 'text', content: { text: body } }
      if (c.secret) {
        const timestamp = String(Math.floor(nowMs / 1000))
        json.timestamp = timestamp
        json.sign = crypto.createHmac('sha256', `${timestamp}\n${c.secret}`).update('').digest('base64')
      }
      return post(c.webhook, json)
    }
    case 'wecom': return post(c.webhook, { msgtype: 'text', text: { content: body } })
    case 'discord': return post(c.webhook, { content: body.slice(0, 2000) })
    case 'telegram': return post(`https://api.telegram.org/bot${c.token}/sendMessage`, { chat_id: c.chatId, text: body.slice(0, 4096) })
    case 'wechat': return post(`${process.env.WECHAT_BRIDGE_URL || 'http://127.0.0.1:3722'}/send`, { text: body })
    default: throw fail('BAD_TYPE')
  }
}

/** Did the service accept it? Each one reports success differently. */
async function judge(channel, response) {
  if (channel.type === 'discord') return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` }
  let data = {}
  try { data = await response.json() } catch { /* not JSON */ }
  if (channel.type === 'lark') return (data.code ?? data.StatusCode) === 0 ? { ok: true } : { ok: false, error: data.msg ?? data.StatusMessage ?? `HTTP ${response.status}` }
  if (channel.type === 'wecom') return data.errcode === 0 ? { ok: true } : { ok: false, error: data.errmsg?.split(',')[0] ?? `HTTP ${response.status}` }
  return data.ok === true ? { ok: true } : { ok: false, error: data.description ?? `HTTP ${response.status}` }
}

export async function sendToChannel(channel, text, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (channel.type === 'telegram' && !channel.config.chatId) return { ok: false, error: 'No chat id yet' }
  try {
    const { url, init } = buildRequest(channel, text, now)
    return await judge(channel, await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }))
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'Timed out (this server may not reach the service)' : (error.cause?.code ?? error.message) }
  }
}

/** Finds the chat that last wrote to a Telegram bot, so the owner does not have to look up a chat id. */
export async function findTelegramChat(token, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) })
  const data = await response.json()
  if (!data.ok) throw fail('BAD_TOKEN')
  const chat = [...data.result].reverse().map(u => u.message?.chat ?? u.channel_post?.chat).find(Boolean)
  if (!chat) throw fail('SEND_A_MESSAGE_FIRST')
  return String(chat.id)
}
