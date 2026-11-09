// Compatibility API for bob-agent's wechat-bot-bridge.
// bob-agent exposes POST /v1/chat (SSE), GET /v1/conversations and GET /v1/health on 127.0.0.1:3721.
// This server speaks the same contract, so an existing bridge only needs its base URL changed.
import http from 'node:http'

const writeEvent = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

const readBody = req => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) req.destroy() })
  req.on('end', () => resolve(body))
  req.on('error', reject)
})

/**
 * @param {object} options
 * @param {string} options.host      loopback by default; set BOB_COMPAT_HOST to listen on a tailnet address
 * @param {number} options.port
 * @param {(input: {from: string, name: string, text: string}) => Promise<{reply: string, cid: string}>} options.ask
 * @param {() => Array<object>} options.conversations
 */
export function startCompatApi({ host = '127.0.0.1', port = 3721, ask, conversations }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return json(200, { status: 'ok', service: 'bobbot-compat', version: '0.1.0' })
      }
      if (req.method === 'GET' && url.pathname === '/v1/conversations') {
        // bob-agent returns a bare array here, and the bridge calls .slice on it.
        return json(200, conversations().map(({ id, title, updatedAt }) => ({ id, title, updated_at: updatedAt })))
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat') {
        const body = JSON.parse(await readBody(req) || '{}')
        const message = String(body.message ?? '').trim()
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        if (!message) { writeEvent(res, 'error', { error: 'message is required' }); return res.end() }
        try {
          const { reply, cid } = await ask({
            from: String(body.from_user ?? 'compat').slice(0, 200),
            name: String(body.from_name ?? body.from_user ?? 'WeChat').slice(0, 40),
            text: message,
            conversationId: body.conversation_id === null || body.conversation_id === undefined ? null : String(body.conversation_id),
          })
          if (reply) writeEvent(res, 'text', { content: reply })
          writeEvent(res, 'done', { conversation_id: cid, full_text: reply ?? '' })
        } catch (error) {
          writeEvent(res, 'error', { error: error?.message ?? String(error) })
        }
        return res.end()
      }
      return json(404, { error: 'not found' })
    } catch (error) {
      if (res.headersSent) { writeEvent(res, 'error', { error: error.message }); return res.end() }
      return json(400, { error: error.message })
    }
  })
  server.on('error', error => console.error(`[bobbot] compat api not started: ${error.message}`))
  server.listen(port, host, () => console.log(`[bobbot] compat api for wechat-bot-bridge: http://${host}:${port}/v1/chat`))
  return server
}
