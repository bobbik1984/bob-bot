import fs from 'node:fs'

// Keep previews separate from the SDK protocol and its logs. The final message remains authoritative.
export const name = 'bob-chat-stream'
export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta' || !frame.chunk.text) return
    fs.writeSync(3, JSON.stringify({
      jsonrpc: '2.0',
      method: 'bob.text',
      params: { sessionId: agent.session.id, attempt: frame.attemptId, text: frame.chunk.text },
    }) + '\n')
  })
}
