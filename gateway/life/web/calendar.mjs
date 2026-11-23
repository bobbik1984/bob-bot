// Parse locally. Only explicitly selected, timed events leave the browser.
const dateParts = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/;
function instant(raw, zone) {
  const m = dateParts.exec(raw);
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const wall = new Date(utc);
  if (year < 1970 || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) return NaN;
  if (m[7]) return utc;
  const fmt = new Intl.DateTimeFormat('en-GB', {timeZone: zone || undefined,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
  function asWall(ms) {
    const p = Object.fromEntries(fmt.formatToParts(ms).map(({type,value}) => [type, value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  // Inspect offsets on both sides of a possible clock transition.
  const offsets = new Set([-86400000, 0, 86400000].map(n => asWall(utc+n) - (utc+n)));
  const choices = [...offsets].map(offset => utc-offset).filter(ms => asWall(ms) === utc);
  return choices.length === 1 ? choices[0] : NaN;
}
function unescapeText(value) {
  return value.replace(/\\([nN,;\\])/g, (_, c) => c.toLowerCase() === 'n' ? '\n' : c).trim();
}
export function calendarPreview(content, now = Date.now()) {
  if (content.length > 1048576) throw Error('calendarSize');
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  if (lines[0]?.trim().toUpperCase() !== 'BEGIN:VCALENDAR' || !lines.some(l=>l.trim().toUpperCase()==='END:VCALENDAR')) throw Error('calendarInvalid');
  let fields=null, depth=0, skipped=0, total=0;
  const events=[], ids=new Set();
  for (const line of lines) {
    const tag=line.toUpperCase();
    if (tag === 'BEGIN:VEVENT' && !fields) {fields={};depth=0;continue}
    if (!fields) continue;
    if (tag.startsWith('BEGIN:')) {depth++;continue}
    if (depth) {if(tag.startsWith('END:'))depth--;continue}
    if (tag === 'END:VEVENT') {
      if (++total > 2000) throw Error('calendarSize');
      let at=NaN;
      try {if(fields.DTSTART) at=instant(fields.DTSTART.value, fields.DTSTART.zone)} catch {}
      const uid=fields.UID?.value || '', text=unescapeText(fields.SUMMARY?.value || ''), place=unescapeText(fields.LOCATION?.value || '');
      if (!uid || uid.length>512 || !text || text.length>1200 || place.length>60 || ids.has(uid) ||
          !Number.isFinite(at) || at<=now || at>now+365*86400000 || fields.RRULE || fields.RDATE || fields['RECURRENCE-ID'] ||
          fields.STATUS?.value.toUpperCase()==='CANCELLED' || events.length>=200) skipped++;
      else {ids.add(uid);events.push({uid,text,place,at})}
      fields=null;continue;
    }
    const m = /^([A-Z-]+)((?:;(?:[^":]|"[^"]*")*)?):(.*)$/i.exec(line);
    if (!m) continue;
    const key=m[1].toUpperCase();
    if (!['UID','DTSTART','SUMMARY','LOCATION','RRULE','RDATE','RECURRENCE-ID','STATUS'].includes(key)) continue;
    const zone=/(?:^|;)TZID=(?:"([^"]*)"|([^;]*))/i.exec(m[2]);
    fields[key]={value:m[3],zone:zone?.[1]||zone?.[2]};
  }
  if (fields) throw Error('calendarInvalid');
  return {events:events.sort((a,b)=>a.at-b.at),skipped};
}
export function dailyAgenda(items, day) {
  const next=new Date(day.getFullYear(),day.getMonth(),day.getDate()+1).getTime();
  const start=new Date(day.getFullYear(),day.getMonth(),day.getDate()).getTime();
  return items.filter(i=>i.Status==='open' && (i.Kind==='wish'||i.Kind==='plan') && i.At>=start && i.At<next)
              .sort((a,b)=>a.At-b.At);
}


export function eventFile({id,title,place,at},now=new Date()) {
  const stamp=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const safe=s=>s.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
  if(!/^[0-9a-f]{32}$/.test(id)||!title.trim()||!Number.isFinite(at))throw Error('invalid');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Bob//Personal Calendar//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',
    'UID:'+id+'-proposal@bob.local','DTSTAMP:'+stamp(now),'DTSTART:'+stamp(new Date(at)),'DURATION:PT30M',
    'SUMMARY:'+safe(title),'LOCATION:'+safe(place),'END:VEVENT','END:VCALENDAR'];
  const encoder=new TextEncoder();
  return lines.map(line=>{
    let folded='',width=0;
    for(const ch of line){const n=encoder.encode(ch).length;if(width+n>75){folded+='\r\n ';width=1}folded+=ch;width+=n}
    return folded;
  }).join('\r\n')+'\r\n';
}
