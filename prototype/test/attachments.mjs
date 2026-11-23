import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acceptsImages, chatUploads, pageBlocks } from '../attachments.mjs'

const neon = { kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-4-neon' }
const file = { name: 'sheet.pdf', relPath: 'uploads/1-sheet.pdf' }

test('visual inputs require a supported model on its official route', () => {
  assert.ok(acceptsImages(neon))
  assert.equal(acceptsImages({ ...neon, baseUrl: 'https://example.com' }), false)
  assert.equal(acceptsImages({ ...neon, model: 'unknown' }), false)
  assert.equal(acceptsImages({ ...neon, kind: 'deepseek' }), false)
})

test('only corresponding user uploads can be read from conversation history', () => {
  assert.deepEqual(chatUploads([
    { type: 'message', role: 'assistant', files: [file] },
    { type: 'message', role: 'user', files: [file, { name: 'x.csv' }] },
  ]), [file])
})

test('render a saved image as labeled pixels and reject invalid pages and paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-attachment-'))
  const img = { name: 'img.png', relPath: 'uploads/img.png' }
  try {
    fs.mkdirSync(path.join(dir, 'uploads'))
    fs.writeFileSync(path.join(dir, img.relPath), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'))
    const [label, image] = await pageBlocks(dir, img)
    assert.match(label.text, /page 1 of 1/)
    assert.equal(image.type, 'image')
    assert.equal(Buffer.from(image.data, 'base64').readUInt16BE(0), 0xffd8)
    await assert.rejects(pageBlocks(dir, img, 2), /only one page/)
    await assert.rejects(pageBlocks(dir, img, -1), /positive page/)
    await assert.rejects(pageBlocks(dir, { ...img, relPath: 'uploads/../private' }), /Invalid upload/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
