import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

const run = promisify(execFile)
const renderer = fileURLToPath(new URL('./attachment-pages.py', import.meta.url))
const official = {
  google: /^https:\/\/generativelanguage\.googleapis\.com\/v1(?:beta)?(?:\/openai)?\/?$/,
  openai: /^https:\/\/api\.openai\.com\/v1\/?$/,
  anthropic: /^https:\/\/api\.anthropic\.com(?:\/v1)?\/?$/,
}
// Installed DSH catalog predates these official model IDs used by this app.
const extraVision = { google: ['gemini-4-neon', 'gemini-4-hydrogen'], openai: ['gpt-6.2-sol', 'gpt-6.2-astra'] }
export function acceptsImages(cfg) {
  if (!Object.hasOwn(official, cfg.kind) || !official[cfg.kind].test(cfg.baseUrl)) return false
  return extraVision[cfg.kind]?.includes(cfg.model) ||
    getBuiltinModels(cfg.kind).some(model => model.id === cfg.model && model.input.includes('image'))
}

export const visualUpload = file => !!file.relPath && /\.(pdf|png|jpe?g|webp|gif)$/i.test(file.name)

export function chatUploads(events) {
  return events.filter(e => e.type === 'message' && e.role === 'user').flatMap(e => e.files ?? []).filter(visualUpload)
}

export async function pageBlocks(workspace, file, start = 1, count = 3) {
  if (!Number.isSafeInteger(start) || start < 1) throw new Error('Use a positive page number, starting at 1.')
  if (!/^uploads\/[^/\\]+$/.test(file.relPath)) throw new Error('Invalid upload path.')
  const dir = path.join(fs.realpathSync(workspace), 'uploads')
  const full = path.join(dir, path.basename(file.relPath))
  if (fs.realpathSync(full) !== full || !fs.statSync(full).isFile()) throw new Error('Invalid upload path.')
  const { stdout } = await run(process.platform === 'win32' ? 'python' : 'python3', [renderer, full, String(start), String(count)], {
    timeout: 18000, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  if (result.error) throw new Error(result.error)
  return result.frames.flatMap((data, i) => [
    { type: 'text', text: JSON.stringify(file.name) + ' — page ' + (start + i) + ' of ' + result.total },
    { type: 'image', mimeType: 'image/jpeg', data },
  ])
}
