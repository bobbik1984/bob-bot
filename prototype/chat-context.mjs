// Quoted excerpts keep names, numbers and deadlines in the speaker's own words.
// Rank only within this conversation. The recent exchange always follows the older notes.
const actionable = /决定|改为|改成|确认|取消|最终|必须|要求|负责|截止|之前|提醒|待办|跟进|下一步|预算|约定|偏好|不要|\b(?:agreed|decided|instead|cancelled|owner|deadline|due|must|follow.up|budget|prefer)\b/i
const dated = /\d{1,4}[-/:年月日点时%元]|(?:明天|下周|周[一二三四五六日])|\b(?:monday|tuesday|wednesday|thursday|friday|tomorrow)\b/i
const sensitive = /(?:api[ _-]?key|password|passwd|密码|口令|连接码|\bpin\b|\bbearer\b|sk-[\w-]{10,})/i

function excerpts(events) {
  const rows = []
  for (const e of events) {
    if (e.type !== 'message') continue
    for (const line of String(e.text || '').split(/(?:[。！？!?；;\n]+|(?<=\.)\s+)/u)) {
      const text = line.trim()
      if (text.length < 3 || sensitive.test(text)) continue
      for (let pos = 0; pos < text.length; pos += 240) {
        rows.push({ role: e.role, text: text.slice(pos, pos + 240), at: e.at || 0 })
      }
    }
  }
  return rows
}

function select(rows, query, limit, space = Infinity) {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [])
  for (const m of query.matchAll(/(?=([\p{Script=Han}]{2}))/gu)) terms.add(m[1])
  const unique = new Map()
  for (const row of rows) unique.set(row.role + row.text, row)
  const ranked = [...unique.values()].map((row, index) => {
    const text = row.text.toLowerCase()
    let matches = 0
    for (const term of terms) { if (text.includes(term) && ++matches === 5) break }
    const score = 4 * matches + 3 * actionable.test(text) + 2 * dated.test(text) + Number(row.role === 'user')
    return { row, score, index }
  }).sort((a,b) => b.score - a.score || b.index - a.index)
  const kept = []
  for (const entry of ranked) {
    const length = entry.row.text.length + 7
    if (length > space) continue
    kept.push(entry)
    space -= length
    if (kept.length >= limit) break
  }
  return kept.sort((a,b) => a.row.at - b.row.at || a.index - b.index).map(r => r.row)
}

export function foldEvicted(previous, events) {
  return select([...previous, ...excerpts(events)], '', 40)
}

export function chatSeed(events, archive = [], query = '', budget = 9000) {
  const messages = events.filter(e => e.type === 'message')
  const recentLimit = Math.floor(budget * 0.68)
  const recent = []
  let bytes = 0, i = messages.length
  const speaker = role => role === 'user' ? 'User' : 'Bob'
  while (i > 0) {
    const m = messages[i - 1]
    const files = (m.files || []).map(f => f.relPath || f.name).join(', ')
    const line = speaker(m.role) + ': ' + (m.text || '') + (files ? ' [files: ' + files + ']' : '')
    if (bytes + line.length + 1 > recentLimit) {
      if (!recent.length) recent.unshift('…' + line.slice(-Math.max(1, recentLimit - 4)))
      break
    }
    recent.unshift(line)
    bytes += line.length + 1
    i--
  }
  const room = Math.max(0, budget - recent.join('\n').length - 190)
  const notes = select([...archive, ...excerpts(messages.slice(0, i))], query.slice(-320), 32, room)
    .map(row => speaker(row.role) + ': ' + row.text)
  if (!notes.length && !recent.length) return ''
  return ('[Chat background only. Older excerpts may be superseded by later messages.]\n' +
    (notes.length ? notes.join('\n').slice(0, room) + '\n' : '') +
    '[Recent exchange]\n' + recent.join('\n') + '\n[End of chat background]\n\n').slice(0, budget)
}

export function needsCompaction(state, nextChars, window = 128000) {
  if (!state?.turns) return false
  return state.turns >= 16 || state.chars + nextChars > Math.min(48000, window * 0.55) ||
    state.tokens + nextChars > Math.min(24000, window * 0.65)
}
