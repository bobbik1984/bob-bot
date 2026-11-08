// A read-only way for Bob to fetch a public web address as text (weather, news, APIs), without the cloud browser.
import { assertPublicUrl } from './net-guard.mjs'

const MAX_BYTES = 1_000_000
const MAX_HOPS = 4

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m])
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * GET only. Every address, including each redirect, must be public (no local or private networks).
 * The answer is data for the model, so it is returned as plain text with the final address on top.
 */
export async function webFetch(url, { maxChars = 40_000, fetchImpl = fetch, raw = false } = {}) {
  let current = await assertPublicUrl(String(url))
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'BobBot/0.1 personal assistant', Accept: 'application/json,text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(15000),
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      current = await assertPublicUrl(new URL(location, current).href)
      continue
    }
    if (!response.ok) throw new Error(`The site answered HTTP ${response.status}.`)
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      if (size > MAX_BYTES) { await reader.cancel(); break }
    }
    let text = new TextDecoder('utf-8').decode(Buffer.concat(chunks))
    if (/html/i.test(response.headers.get('content-type') ?? '')) text = htmlToText(text)
    const cut = text.length > maxChars
    if (raw) {
      if (cut) throw new Error('That file is too large.')
      return text
    }
    return `${current}\n${cut ? text.slice(0, maxChars) + '\n… (cut)' : text}`
  }
  throw new Error('Too many redirects.')
}
