// Commands with an explicit reminder intent stay local. Anything ambiguous is
// confirmed in the conversation before it can schedule a notification.
const digits = '零一二三四五六七八九';
function number(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const s=value.replaceAll('两','二');
  if(s.includes('十')) {
    const [t,u]=s.split('十');
    return (t ? digits.indexOf(t) : 1)*10+(u ? digits.indexOf(u) : 0);
  }
  return digits.indexOf(s);
}
const punctuation=/^[\s，,。:：]+|[\s，,。:：]+$/g;
export function interpret(text, now=new Date()) {
  const s=text.trim();
  if(/^(?:办好了|已完成|搞定了|done|finished)[。！.!]?$/i.test(s)) return {type:'done'};
  if(/^(?:你?(?:还)?(?:在)?惦记(?:着)?什么|有哪些提醒|看看提醒|查看提醒|我的提醒|show (?:my )?reminders|list reminders)[？?。.!]?$/i.test(s)) return {type:'list'};
  const zh=s.match(/^(.*?)提醒我[，,：:\s]*(.*)$/);
  const en=s.match(/^(?:please\s+)?remind me\s+(.+)$/i);
  if(!zh&&!en) {
    const keep=s.match(/^(?:(?:请|麻烦)?(?:帮我|替我))?(?:记住|记着|记下|惦记着?)[，,：:\s]*(.+)$/)||s.match(/^(?:please\s+)?remember (?:that |to )?(.+)$/i);
    return keep ? {type:'wish',text:keep[1].trim(),place:''} : null;
  }
  const lead=zh?.[1]||'';
  if(zh && /(?:不要|不必|不用|别|如何|怎么|为什么|能否|有没有|没|取消|忘了|没有)/.test(lead)) return null;
  const rest=(zh ? zh[2] : en[1]).trim();
  const near=lead.match(/^(?:请|下次|下次我|我)?(?:经过|路过)(.+?)(?:时|的时候)?[，,\s]*$/);
  if(near && rest) return {type:'wish',text:rest,place:near[1]};
  const raw=(zh ? [lead,rest].join(' ') : rest).trim();
  const repeat=/每天|每日|\bevery day\b|\bdaily\b/i.test(raw)?'daily':/每周|每星期|\bevery week\b/i.test(raw)?'weekly':'';
  const repeatWords=/每天|每日|每(?:周|星期)[日天一二三四五六]?|\bevery (?:day|week)\b|\bdaily\b/ig;
  const clean=part=>part.replace(repeatWords,'').replace(punctuation,'').replace(/^to\s+/i,'').trim();
  const clarify=()=>({type:'when',text:clean(rest)||s,repeat});
  // Keep combined, negated or conditional clauses for explicit review.
  if(/(?:如果|除非|或者|工作日|每月|隔周|每隔|every (?:month|other)|\bor\b)/i.test(raw)) return {type:'clarify',text:s};
  const rel=raw.match(/([0-9零一二三四五六七八九十两]+)\s*(分钟|小时|天)(?:以|之)?后|\bin\s+(\d+)\s+(minute|hour|day)s?\b/i);
  if(rel&&!repeat){
    const n=number(rel[1]||rel[3]), unit=rel[2]||rel[4].toLowerCase();
    const label=clean(rest.replace(rel[0],''));
    if(n>0&&n<=3650&&label) return {type:'reminder',text:label,at:+now+n*({分钟:60000,小时:3600000,天:86400000,minute:60000,hour:3600000,day:86400000}[unit]),repeat:''};
    return clarify();
  }
  if(en){
    if(/\bevery\b/i.test(raw)&&!repeat) return {type:'clarify',text:s};
    const parsed=raw.match(/\b(today|tomorrow|every day|daily)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if(!parsed)return clarify();
    let hour=Number(parsed[2]);
    const minute=Number(parsed[3]||0),period=parsed[4]?.toLowerCase(),day=parsed[1].toLowerCase();
    if(minute>59||hour>23||(period&&(hour<1||hour>12))||(!parsed[3]&&!period))return clarify();
    if(period)hour=hour%12+(period==='pm'?12:0);
    const at=new Date(now);
    if(day==='tomorrow')at.setDate(at.getDate()+1);
    at.setHours(hour,minute,0,0);
    if(+at<=+now && repeat==='daily')at.setDate(at.getDate()+1);
    const title=clean(rest.replace(parsed[0],''));
    return +at>+now&&title?{type:'reminder',text:title,at:+at,repeat}:clarify();
  }
  const clock=raw.match(/(凌晨|早上|上午|中午|下午|晚上)?\s*([0-9零一二三四五六七八九十两]{1,3})(?:[:：](\d{2})|[点时](半|[0-9零一二三四五六七八九十两]+分?)?)/);
  if(!clock) return clarify();
  const part=clock[1], minute=clock[3] ? +clock[3] : clock[4]==='半' ? 30 : clock[4] ? number(clock[4].replace('分','')) : 0;
  let hour=number(clock[2]);
  if(hour<0||hour>23||minute<0||minute>59) return clarify();
  if(/^(下午|晚上|中午)$/.test(part)&&hour<12) hour+=12;
  if(part==='凌晨'&&hour===12)hour=0;
  const when=new Date(now);
  let calendar=raw.match(/今天|明天|后天/),weekday=raw.match(/每(?:周|星期)([日天一二三四五六])/);
  const other=raw.replace(clock[0],'').replace(calendar?.[0]||'','').replace(repeatWords,'');
  // An unparsed date before “提醒我” must never silently become today.
  if(zh && lead && clean(lead.replace(clock[0],'').replace(calendar?.[0]||'','')).replace(/^(请|请在|在)$/,'')!=='')return clarify();
  if(/下周|周[一二三四五六日天]|星期|月底|周末|\d+[年月日号]|\d{4}-\d{2}|tomorrow|next|am\b|pm\b/i.test(other))return clarify();
  if(repeat==='weekly'&&!weekday) return clarify();
  const delta=weekday ? (('日一二三四五六'.indexOf(weekday[1].replace('天','日'))-now.getDay()+7)%7) : calendar ? ['今天','明天','后天'].indexOf(calendar[0]) : 0;
  when.setDate(when.getDate()+delta);
  when.setHours(hour,minute,0,0);
  if(+when<=+now && (repeat || !calendar))when.setDate(when.getDate()+(repeat==='weekly'?7:1));
  if(+when<=+now)return clarify();
  const title=clean(rest.replace(clock[0],'').replace(calendar?.[0]||'',''));
  return title ? {type:'reminder',text:title,at:+when,repeat} : clarify();
}
