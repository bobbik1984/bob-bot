// RY keeps its own sessions. Only the write-only shortcut credential crosses to the shared inbox.
import fs from 'node:fs'

const limit = 13 * 1024 * 1024
let uploading = 0
export async function intakeRelay(req, res) {
  const path = req.url.split('?', 1)[0]
  const receipt = /^\/task\/[a-f0-9]{32}$/.test(path)
  if (!(req.method === 'GET' && (path === '/wechat' || receipt)) &&
      !(req.method === 'POST' && path === '/api/ingest')) return false
  res.setHeader('Cache-Control', 'no-store')
  const config = JSON.parse(fs.readFileSync(new URL('../release.json',import.meta.url),'utf8'))
  const dest = new URL(config.origin)
  if (dest.protocol !== 'https:') throw new Error('Invalid intake origin')
  if (req.method === 'GET') {
    res.writeHead(302,{Location:new URL(path,dest).href});res.end();return true
  }
  const auth = req.headers.authorization || ''
  if (!/^Bearer [a-f0-9]{64}$/.test(auth)) {res.writeHead(401);res.end();return true}
  const contentType = req.headers['content-type'] || ''
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {res.writeHead(415);res.end();return true}
  if (Number(req.headers['content-length']) > limit) {res.writeHead(413);res.end();return true}
  if (uploading >= 4) {res.writeHead(429);res.end();return true}
  uploading++
  try {
    const chunks = [];let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) {res.writeHead(413);res.end();return true}
      chunks.push(chunk)
    }
    const response = await fetch(new URL('/api/ingest',dest),{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{authorization:auth,'content-type':contentType},body:Buffer.concat(chunks)
    })
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type') || 'text/plain'})
    res.end(await response.text())
  } catch {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  } finally {uploading--}
  return true
}
