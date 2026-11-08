// Organized information shown as a card: a title, a few labelled fields, a short list and a note.
const fail = code => Object.assign(new Error(code), { code })
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max)

/** Checks what the model gave and returns a card of known shape, so the page never has to trust it. */
export function checkCard(input) {
  const title = text(input?.title, 80)
  if (!title) throw fail('A card needs a title.')
  const fields = input.fields ?? []
  const items = input.items ?? []
  if (!Array.isArray(fields) || !Array.isArray(items)) throw fail('fields and items must be lists.')
  if (fields.length > 12 || items.length > 12) throw fail('At most 12 fields and 12 items.')
  const card = {
    kind: 'info', title,
    subtitle: text(input.subtitle, 120), tag: text(input.tag, 20),
    fields: fields.map(f => ({ label: text(f?.label, 30), value: text(f?.value, 200) })).filter(f => f.label && f.value),
    items: items.map(i => text(i, 200)).filter(Boolean),
    note: text(input.note, 300),
  }
  if (!card.subtitle && !card.fields.length && !card.items.length && !card.note) throw fail('Add at least one field, item or note.')
  return card
}

/** The same card as plain text, for chat apps that cannot draw cards. */
export function cardText(card) {
  return [
    card.tag ? `[${card.tag}] ${card.title}` : card.title,
    card.subtitle,
    ...card.fields.map(f => `${f.label}: ${f.value}`),
    ...card.items.map(i => `- ${i}`),
    card.note,
  ].filter(Boolean).join('\n')
}
