// A minimal MCP server over stdio (newline-delimited JSON-RPC), used by the end-to-end tests.
import readline from 'node:readline'

const tools = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'show_token', description: 'Report whether FAKE_TOKEN reached this server.', inputSchema: { type: 'object', properties: {} } },
]

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notifications need no answer
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } })
  if (msg.method === 'tools/list') return reply(msg.id, { tools })
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params
    const text = name === 'echo' ? `echo:${args.text}` : `token:${process.env.FAKE_TOKEN ?? 'unset'}`
    return reply(msg.id, { content: [{ type: 'text', text }] })
  }
  return reply(msg.id, {})
})
