import {interpret} from './life-turn.mjs';
import {calendarPreview,dailyAgenda,eventFile} from './life-calendar.mjs';
const words={
 zh:{helpMe:'帮我想想怎么做',helpQuestion:'帮我把这件事拆成接下来能做的几步：',reminder:'定时提醒', dueNow:'你让我在这个时候提醒你', tracked:'我记着了', nextWhen:'你想让我什么时候提醒？选个时间，或直接回复我。', confirmWhen:'就这个时间', daily:'每天', weekly:'每周', whenClosed:'已办好', chooseOne:'有几件事在跟进，点一下办好的是哪件。', clarify:'这个提醒的条件还需要说清楚。可以告诉我具体时间和要做的事吗？', nothing:'目前没有待办的提醒。', finished:'办好了，我把这件事收起来了。', completed:'已完成', skipLabel:'已取消', occurrence:'这次知道了', endSeries:'结束重复提醒', deviceHint:'设置锁屏提醒', pushTest:'发送测试通知',pushAccepted:'推送服务已接受测试通知，请查看本机通知中心。',pushPreview:'锁屏显示提醒正文',city:'城市（选填）',area:'街区或商圈（选填）',providerAuth:'供应商拒绝了凭据，请在聊天与设置中检查密钥和模型权限。',providerRejected:'当前模型拒绝了提取请求。请检查模型与端点；读取截图需要支持图片的模型。',providerLimit:'供应商限流或额度不足，请稍后重试或检查账户。',draft:'拟个日程',draftLabel:'日程草稿',draftHelp:'核对时间和地点，再打开到你的日历。预留 30 分钟。',draftName:'名称',draftAt:'开始时间',downloadDraft:'导出到日历',cancel:'取消',draftReady:'已生成 .ics 草稿，可以在日历中确认。',today:'今天的安排',untilShort:'截止',agendaEmpty:'今天还没有定下时间的行程或待办。',calendar:'从日历导入行程',calendarHelp:'选择 .ics 文件，再勾选要交给 Bob 的行程。这里支持未来一年内有明确开始时间的单次行程；全天、重复和无法判定时区的项目会跳过。',chooseCalendar:'选择日历文件',confirmCalendar:'导入已选行程',calendarInvalid:'无法读取这个日历文件。',calendarSize:'请选择小于 1 MB 且最多含 2,000 场活动的日历文件。',available:'可选',skipped:'跳过',imported:'已添加',updated:'已更新',unchanged:'已有',heading:'今天，替你记着',classic:'聊天与设置',pin:'输入 Bob 的 PIN',enter:'进入',capture:'这份资料要记什么？',placeholder:'例如：周末想去看展，路过西岸时提醒我。',kind:'怎么处理',wish:'替我留意',save:'只收藏',plan:'我的行程',image:'附一张截图',details:'地点和时间',where:'地点或街区',until:'最晚时间（选填）',start:'行程开始时间',submit:'记下来',read:'帮我提取',readhint:'点击提取后，当前选用的模型会读取这段话和所选图片。请核对地点、街区和日期后保存。',watching:'记着的事',history:'已结束',push:'开启手机提醒',unpush:'关闭本机提醒',signout:'退出',done:'办好了',drop:'这次算了',seen:'知道了',later:'明天再说',saved:'已记下',opportunity:'一个顺路的机会',deadline:'快到最晚时间了',reason:'附近有一项已安排的行程',empty:'还没有交给 Bob 的事。',first:'先写一句话或选一张图片。',missingTime:'请给行程选一个未来的开始时间。',source:'打开原图',pic:'一张截图',hint:'已附图片',busy:'正在读取…',ready:'已提取，请核对地点和时间后保存。',unavailable:'请在聊天与设置中选择模型并配置端点和密钥，也可以手动填写。',budget:'本期可用预算不足。',error:'操作未完成，请重试。',imageErr:'无法读取图片，请改选 JPG 或 PNG。',pushErr:'本机未能开启推送。可以先安装到主屏幕并允许通知。',enabled:'本机提醒已开启',disabled:'本机提醒已关闭',late:'已过截止时间',snooze:'已推迟到',invalid:'输入无效，请检查时间和内容。',closed:'已结束',noTime:'未设时间',stale:'事项已变化，请查看最新状态。'},
 en:{helpMe:'Help me plan this',helpQuestion:'Help me plan the next steps for this: ',reminder:'Scheduled reminder', dueNow:'You asked me to remind you now', tracked:'I’ll keep track of this', nextWhen:'When should I remind you? Pick a time or tell me here.', confirmWhen:'Use this time', daily:'Every day', weekly:'Every week', whenClosed:'Done', chooseOne:'Which of these did you finish?', clarify:'When should I remind you, and what would you like to do?', nothing:'There are no open reminders.', finished:'Done. I’ve marked it complete.', completed:'Completed', skipLabel:'Cancelled', occurrence:'Got this one', endSeries:'End recurring reminder', deviceHint:'Set up lock-screen alerts', pushTest:'Send a test notification',pushAccepted:'The push service accepted the test. Check this device’s notifications.',pushPreview:'Show reminder details on the lock screen',city:'City (optional)',area:'Neighborhood (optional)',providerAuth:'Check your API key and model access in Chat & settings.',providerRejected:'The selected model rejected the request. Check its endpoint and image support.',providerLimit:'Provider quota or rate limit reached. Check the account or retry later.',draft:'Draft a plan',draftLabel:'Calendar draft',draftHelp:'Review the time and place before opening the 30-minute event in your calendar.',draftName:'Title',draftAt:'Start time',downloadDraft:'Export to calendar',cancel:'Cancel',draftReady:'Calendar draft downloaded. Open it to confirm.',today:"Today's agenda",untilShort:'Due',agendaEmpty:'Nothing scheduled or due today.',calendar:'Import from calendar',calendarHelp:'Choose an .ics file, then select the plans to share with Bob. Imports timed, one-off events within a year. All-day, recurring and ambiguous times are skipped.',chooseCalendar:'Choose a calendar file',confirmCalendar:'Import selected plans',calendarInvalid:'Could not read this calendar file.',calendarSize:'Choose a file under 1 MB with up to 2,000 events.',available:'Available',skipped:'Skipped',imported:'Added',updated:'Updated',unchanged:'Already saved',heading:'On your mind',classic:'Chat & settings',pin:'Enter your Bob PIN',enter:'Sign in',capture:'What should I remember from this?',placeholder:'An exhibit I want to see when I’m near the waterfront…',kind:'Handle as',wish:'Keep an eye on it',save:'Bookmark only',plan:'My plan',image:'Add a screenshot',details:'Place and time',where:'Venue or area',until:'Deadline (optional)',start:'Plan starts',submit:'Save',read:'Extract details',readhint:'Extraction sends this note and selected image to your selected model. Review the venue, neighborhood and date before saving.',watching:'Keeping track',history:'Finished',push:'Enable phone alerts',unpush:'Disable alerts here',signout:'Sign out',done:'Done',drop:'Skip this one',seen:'Got it',later:'Tomorrow',saved:'Saved',opportunity:'An opportunity nearby',deadline:'Time is running short',reason:'A scheduled plan nearby',empty:'Nothing to follow yet.',first:'Add a note or an image first.',missingTime:'Choose a future time for the plan.',source:'Open image',pic:'Screenshot',hint:'Image attached',busy:'Reading…',ready:'Review the extracted place and time, then save.',unavailable:'Select a model, endpoint and key in Chat & settings, or enter details manually.',budget:'Insufficient budget.',error:'Could not finish. Please try again.',imageErr:'Could not read image. Try JPEG or PNG.',pushErr:'Could not enable alerts. Install on your home screen and allow notifications.',enabled:'Alerts enabled',disabled:'Alerts disabled',late:'Deadline passed',snooze:'Snoozed until',invalid:'Check the time and contents.',closed:'Finished',noTime:'No time set',stale:'This item changed. Check its current state.'}
};
const $=id=>document.getElementById(id);
const ui=window.assistantUI;
const lang=ui.lang;
const t=k=>words[lang][k]||k;
let items=[],candidate=crypto.randomUUID().replaceAll('-',''),attachment='',shareKey='',busy=false,photoWork=Promise.resolve();
function message(k){$('msg').textContent=k?t(k):''}
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
function localDate(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
const fmt=ms=>new Date(ms).toLocaleString(lang,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function translate(){for(const n of document.querySelectorAll('[data-life-t]'))n.textContent=t(n.dataset.lifeT);$('note').placeholder=t('placeholder');$('kind').onchange();showCalendar()}
async function api(path,body){
 const r=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(!r.ok)throw new Error((await r.text()).trim());return r.json()
}
let generation=0;
async function load(){
 const current=++generation, result=await api('/api/life/items');
 if(current!==generation)return;
 items=result||[];render()
}
function button(label,fn){const b=el('button',t(label));b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn()}catch(e){message(e.message==='stale'?'stale':'error');await load()}finally{b.disabled=false}};return b}
function card(i,focus){
 const d=el('article',undefined,'card'+(focus?' focus':''));const name=i.Text||t('pic');
 if(focus){d.append(el('small',t(i.Kind==='reminder'?'dueNow':i.Related?'opportunity':'deadline')))}
 d.append(el('h3',name));const p=items.find(p=>p.ID===i.Related);
 if(focus&&p)d.append(el('p',[t('reason'),p.Text,p.Place,fmt(p.At)].filter(Boolean).join(' · ')));
 d.append(el('small',[t(i.Kind),i.Repeat?t(i.Repeat):'',i.Place,i.At?fmt(focus&&i.Signal.startsWith('due:')?Number(i.Signal.slice(4)):i.At):'',i.At&&i.At<Date.now()&&i.Kind==='wish'?t('late'):'',i.Snooze>Date.now()?t('snooze')+' '+fmt(i.Snooze):''].filter(Boolean).join(' · ')));
 if(i.Image){const a=el('a',t('source'));a.href='/api/life/art/'+encodeURIComponent(i.ID);a.target='_blank';a.rel='noopener';d.append(a)}
 if(i.Status==='open'){const actions=el('div',undefined,'actions');for(const action of (focus?['seen','later','done','drop']:['done','drop'])){actions.append(button(i.Repeat&&action==='done'?'endSeries':i.Repeat&&action==='seen'?'occurrence':action,async()=>{await api('/api/life/action',{ID:i.ID,Action:action,Signal:i.Signal});await load()}))}if(focus&&i.Kind!=='reminder')actions.prepend(button('draft',()=>openDraft(i,p)));d.append(actions)}return d
}
function render(){showAgenda();for(const id of ['notices','open','closed'])$(id).replaceChildren();for(const i of items){const focus=i.Status==='open'&&i.Signal&&i.Signal!==i.Seen;if(focus)$('notices').append(card(i,true));$(i.Status==='open'?'open':'closed').append(card(i,false))}if(!items.some(i=>i.Status==='open'))$('open').append(el('p',t('empty'),'muted'));paint()}
async function setPhoto(file){attachment='';$('filehint').textContent='';if(!file||!file.size)return;if(file.size>12*1024*1024)throw new Error('image');const url=URL.createObjectURL(file);
 try{const img=new Image();img.src=url;await img.decode();const k=Math.min(1,1200/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*k));c.height=Math.max(1,Math.round(img.height*k));c.getContext('2d').drawImage(img,0,0,c.width,c.height);attachment=c.toDataURL('image/jpeg',.84);$('filehint').textContent=t('hint')}finally{URL.revokeObjectURL(url)}}
function selectPhoto(file){photoWork=photoWork.then(()=>setPhoto(file)).catch(()=>{attachment='';message('imageErr')});return photoWork}
$('photo').onchange=()=>selectPhoto($('photo').files[0]);
$('kind').onchange=()=>{$('whenLabel').textContent=t($('kind').value==='plan'?'start':'until');if($('kind').value==='plan')$('details').open=true};
$('place').oninput=()=>{$('city').value='';$('area').value=''};
$('read').onclick=async()=>{await photoWork;if(!attachment&&!$('note').value.trim())return message('first');$('read').disabled=true;message('busy');try{const out=await api('/api/life/read',{Photo:attachment,Text:$('note').value,Today:localDate(new Date())});if(out.Title&&!$('note').value.trim())$('note').value=out.Title;if(out.Place&&(!$('place').value||$('place').value===out.Place)){
 $('place').value=out.Place;if(!$('city').value)$('city').value=out.City||'';if(!$('area').value)$('area').value=out.Area||'';}if(/^\d{4}-\d{2}-\d{2}$/.test(out.Date)&&!$('when').value)$('when').value=out.Date+($('kind').value==='plan'?'T09:00':'T23:59');$('details').open=true;message('ready')}catch(e){message(e.message==='visionUnavailable'?'unavailable':['budget','providerAuth','providerRejected','providerLimit'].includes(e.message)?e.message:'error')}finally{$('read').disabled=false}};
$('capture').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('submit').disabled=true;try{await photoWork;const kind=$('kind').value,at=$('when').value?new Date($('when').value).getTime():0;if(!attachment&&!$('note').value.trim()){message('first');return}if(kind==='plan'&&at<=Date.now()){$('details').open=true;message('missingTime');return}
 await api('/api/life/items',{ID:candidate,Kind:kind,Text:$('note').value,Place:$('place').value,City:$('city').value,Area:$('area').value,At:at,Photo:attachment});candidate=crypto.randomUUID().replaceAll('-','');$('capture').reset();attachment='';$('filehint').textContent='';$('kind').onchange();if(shareKey){(await caches.open('life-share')).delete('/life-share/'+shareKey);history.replaceState(null,'','/');shareKey=''}message('saved');await load();$('captureDialog').close();ui.notice(t('saved'))}catch(e){message(['invalid','time','image'].includes(e.message)?'invalid':'error')}finally{busy=false;$('submit').disabled=false}};
let calendarRows=[], readVersion=0, importing=false, lastImport=null;
function showAgenda(){
 const today=dailyAgenda(items,new Date());
 $('agendaList').replaceChildren();
 $('agendaCount').textContent=t('today')+' · '+today.length;
 for(const i of today){
   const row=el('li');row.append(el('small',fmt(i.At)+' · '+t(i.Kind==='wish'?'untilShort':'plan')),el('span',i.Text||t('pic')));
   if(i.Place)row.append(el('small',i.Place));
   $('agendaList').append(row);
 }
 $('agendaEmpty').hidden=today.length>0;
}
function showCalendar(){
 const panel=$('calendarRows'), checked=new Set([...panel.querySelectorAll('input:checked')].map(n=>n.value));
 panel.replaceChildren();
 for(const [n,event] of calendarRows.entries()){
   const label=el('label',undefined,'eventRow'),box=el('input');box.type='checkbox';box.value=String(n);
   box.checked=checked.has(box.value);box.onchange=syncImportButton;
   label.append(box,el('span',fmt(event.at)+' · '+event.text+(event.place?' · '+event.place:'')));panel.append(label);
 }
 if(lastImport)$('importInfo').textContent=t('imported')+' '+lastImport.Added+' · '+t('updated')+' '+lastImport.Updated+' · '+t('unchanged')+' '+lastImport.Unchanged;
 else if(panel.dataset.skipped!==undefined)$('importInfo').textContent=t('available')+' '+calendarRows.length+' · '+t('skipped')+' '+panel.dataset.skipped;
 else $('importInfo').textContent='';
 syncImportButton();
}
function syncImportButton(){$('confirmCalendar').hidden=!calendarRows.length;$('confirmCalendar').disabled=importing||!$('calendarRows').querySelector('input:checked')}
$('calendarFile').onchange=async()=>{
 const sequence=++readVersion, file=$('calendarFile').files[0];lastImport=null;calendarRows=[];$('calendarRows').replaceChildren();delete $('calendarRows').dataset.skipped;showCalendar();
 if(!file)return;
 try{
   if(file.size>1048576)throw Error('calendarSize');
   const {events,skipped}=calendarPreview(await file.text());
   if(sequence!==readVersion)return;
   calendarRows=events;$('calendarRows').dataset.skipped=String(skipped);showCalendar();message('');
 }catch(e){if(sequence===readVersion)message(e.message==='calendarSize'?'calendarSize':'calendarInvalid')}
};
$('confirmCalendar').onclick=async()=>{
 if(importing)return;
 const selected=[...$('calendarRows').querySelectorAll('input:checked')].map(n=>calendarRows[+n.value]);
 if(!selected.length)return;importing=true;$('calendarFile').disabled=true;syncImportButton();
 try{
   lastImport=await api('/api/life/calendar',{events:selected});calendarRows=[];$('calendarRows').replaceChildren();$('calendarFile').value='';await load();message('');
 }catch{message('error')}finally{importing=false;$('calendarFile').disabled=false;showCalendar()}
};


let draftID='';
function openDraft(i,plan) {
 draftID=i.ID;$('draftTitle').value=i.Text||t('pic');$('draftPlace').value=i.Place;
 const start=plan?.At || i.At || Date.now()+3600000;
 const dt=new Date(start);$('draftAt').value=localDate(dt)+'T'+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0');
 $('draftDialog').showModal();
}
$('cancelDraft').onclick=()=>$('draftDialog').close();
$('draftForm').onsubmit=e=>{
 e.preventDefault();
 try{
   const at=new Date($('draftAt').value).getTime();
   const data=eventFile({id:draftID,title:$('draftTitle').value,place:$('draftPlace').value,at});
   const url=URL.createObjectURL(new Blob([data],{type:'text/calendar;charset=utf-8'}));
   const link=el('a');link.href=url;link.download='bob-plan.ics';document.body.append(link);link.click();link.remove();
   setTimeout(()=>URL.revokeObjectURL(url),60000);$('draftDialog').close();message('draftReady');
 }catch{message('invalid')}
};

translate();
async function readShare(){
const args=new URLSearchParams(location.search);shareKey=args.get('share')||'';
if(/^[0-9a-f-]{36}$/.test(shareKey)){if(!$('captureDialog').open)$('captureDialog').showModal();try{const r=await(await caches.open('life-share')).match('/life-share/'+shareKey);if(r){const data=await r.formData();$('note').value=[data.get('title'),data.get('text'),data.get('url')].filter(Boolean).join('\n').slice(0,1200);await selectPhoto(data.get('image'))}}catch{message('imageErr')}}
if(args.has('shareError')){if(!$('captureDialog').open)$('captureDialog').showModal();message('imageErr')}
}

let pending=null, lastRequest=null, started=false, applying=false;
function receipt(item,offerPush) {
 const row=el('div',undefined,'bubble-row'), body=el('div',undefined,'msg md');
 const status=item.Status==='done'?t('completed'):item.Status==='drop'?t('skipLabel'):t('tracked');
 body.append(el('small',status),el('strong',item.Text));
 const meta=[item.Repeat?t(item.Repeat):'',item.At?fmt(item.At):'',item.Place].filter(Boolean).join(' · ');
 if(meta)body.append(el('small',meta));
 if(item.Status==='open'){
  const help=el('button',t('helpMe'),'link');help.type='button';
  help.onclick=()=>ui.compose(t('helpQuestion')+item.Text);body.append(help);
 }
 if(offerPush){
  const push=el('button',t('deviceHint'),'link');push.type='button';push.onclick=ui.settings;body.append(push);
 }
 row.dataset.offerPush=String(offerPush);
 row.append(body);row.dataset.receipt=item.ID;row.dataset.at=item.Created;
 return row;
}
export function paint(){
 const feed=$('feed');
 const visible=ui.active()==='assistant';
 const byID=new Map([...feed.querySelectorAll('[data-receipt]')].map(row=>[row.dataset.receipt,row]));
 const invite=('Notification' in window ? Notification.permission==='default' : true) && localStorage.getItem('bob.push.enabled')!=='off';
 const latest=invite && items.find(i=>i.Spoken&&i.Kind==='reminder'&&i.Status==='open');
 for(const item of items){
   if(!visible||!item.Spoken)continue;
   const existing=byID.get(item.ID);
   const offerPush=latest?.ID===item.ID;
   if(existing&&existing.dataset.status===item.Status&&existing.dataset.offerPush===String(offerPush)){byID.delete(item.ID);continue}
   const row=receipt(item,offerPush);row.dataset.status=item.Status;
   if(existing){existing.replaceWith(row);byID.delete(item.ID)}
   else{
    const next=[...feed.children].find(n=>Number(n.dataset.at)>item.Created)||feed.querySelector('.typing')?.parentElement;
    feed.insertBefore(row,next||null);
   }
 }
 for(const node of byID.values())node.remove();
 ui.setHero();
}
async function saveTurn(turn,requestID){
 await api('/api/life/items',{ID:requestID,Kind:turn.type,Text:turn.text,Place:turn.place||'',At:turn.at||0,Repeat:turn.repeat||'',Zone:turn.repeat?Intl.DateTimeFormat().resolvedOptions().timeZone:'',Spoken:true});
 pending=null;lastRequest=null;$('turnPrompt').replaceChildren();
 await load();ui.atEnd();
}
function askWhen(turn,id){
 pending={turn,id};
 const prompt=$('turnPrompt');prompt.replaceChildren();
 prompt.append(el('p',turn.text));
 const date=el('input');date.type='datetime-local';date.id='whenEntry';date.setAttribute('aria-label',t('nextWhen'));
 const title=el('label',t('nextWhen'));title.htmlFor=date.id;prompt.append(title,date);
 const actions=el('div',undefined,'actions');
 const confirm=button('confirmWhen',async()=>{
   const at=new Date(date.value).getTime();
   if(!Number.isFinite(at)||at<=Date.now()){ui.notice(t('missingTime'),true);date.focus();return}
   try {await saveTurn({...turn,type:'reminder',at},id)}catch{ui.notice(t('error'),true)}
 });
 actions.append(confirm,button('cancel',async()=>{pending=null;lastRequest=null;prompt.replaceChildren();ui.setHero()}));prompt.append(actions);ui.setHero();ui.atEnd();
}
function records(){if(!$('recordsDialog').open)$('recordsDialog').showModal()}
export async function handle(text){
 if(text.startsWith(t('helpQuestion')))return false;
 let turn=interpret(text);
 if(!turn&&pending){
   const reply=interpret(text+'提醒我'+pending.turn.text);
   if(reply?.type==='reminder')turn={...pending.turn,type:'reminder',at:reply.at,repeat:pending.turn.repeat||reply.repeat};
 }
 if(!turn)return false;
 if(applying)throw Error('busy');
 applying=true;
 try {
   if(ui.active()!=='assistant')await ui.openAssistant();
   if(turn.type==='clarify'){ui.say('assistant',t('clarify'));return true}
   if(turn.type==='list'){await load();records();return true}
   if(turn.type==='done'){
     await load();
     const open=items.filter(i=>i.Status==='open'&&i.Kind!=='save');
     const due=open.filter(i=>i.Signal&&i.Signal!==i.Seen);
     const target=due.length===1?due[0]:open.length===1?open[0]:null;
     if(!target){ui.say('assistant',t(open.length?'chooseOne':'nothing'));if(open.length)records();return true}
     if(target.Repeat&&!target.Signal){ui.say('assistant',t('chooseOne'));records();return true}
     await api('/api/life/action',{ID:target.ID,Action:target.Repeat?'seen':'done',Signal:target.Signal});
     await load();ui.say('assistant',t(target.Repeat?'occurrence':'finished'));return true
   }
   const id=pending&&turn.text===pending.turn.text?pending.id:lastRequest?.text===text?lastRequest.id:crypto.randomUUID().replaceAll('-','');
   lastRequest={text,id};
   if(turn.type==='when'){askWhen(turn,id);return true}
   await saveTurn(turn,id);return true;
 }finally{applying=false}
}
async function refresh(){
 if(!started||document.hidden||$('app').hidden)return;
 try{await load()}catch{/* keep the last view available while offline */}
}
export async function start(){
 if(started){await refresh();return}
 started=true;window.BobPush?.ready().catch(()=>{});await readShare();
 try{await load()}catch{ui.notice(t('error'),true)}
 if(location.hash==='#attention')$('attention').scrollIntoView({block:'nearest'});
}
async function attention(){
 await refresh();
 $('attention').scrollIntoView({block:'nearest'});
 $('attention').focus({preventScroll:true});
}
window.BobLife={paint,handle,start,attention};
setInterval(refresh,30000);
addEventListener('pageshow',refresh);
document.addEventListener('visibilitychange',refresh);
addEventListener('hashchange',()=>{if(location.hash==='#attention'){ui.showChat();refresh()}});
