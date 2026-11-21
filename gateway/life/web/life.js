import {calendarPreview,dailyAgenda,eventFile} from './life-calendar.mjs';
const words={
 zh:{city:'城市（选填）',area:'街区或商圈（选填）',providerAuth:'供应商拒绝了凭据，请在聊天与设置中检查密钥和模型权限。',providerRejected:'当前模型拒绝了提取请求。请检查模型与端点；读取截图需要支持图片的模型。',providerLimit:'供应商限流或额度不足，请稍后重试或检查账户。',draft:'拟个日程',draftLabel:'日程草稿',draftHelp:'核对时间和地点，再打开到你的日历。预留 30 分钟。',draftName:'名称',draftAt:'开始时间',downloadDraft:'导出到日历',cancel:'取消',draftReady:'已生成 .ics 草稿，可以在日历中确认。',today:'今天的安排',untilShort:'截止',agendaEmpty:'今天还没有定下时间的行程或待办。',calendar:'从日历导入行程',calendarHelp:'选择 .ics 文件，再勾选要交给 Bob 的行程。这里支持未来一年内有明确开始时间的单次行程；全天、重复和无法判定时区的项目会跳过。',chooseCalendar:'选择日历文件',confirmCalendar:'导入已选行程',calendarInvalid:'无法读取这个日历文件。',calendarSize:'请选择小于 1 MB 且最多含 2,000 场活动的日历文件。',available:'可选',skipped:'跳过',imported:'已添加',updated:'已更新',unchanged:'已有',heading:'今天，替你记着',classic:'聊天与设置',pin:'输入 Bob 的 PIN',enter:'进入',capture:'想让 Bob 惦记什么？',placeholder:'例如：周末想去看展，路过西岸时提醒我。',kind:'怎么处理',wish:'替我留意',save:'只收藏',plan:'我的行程',image:'附一张截图',details:'地点和时间',where:'地点或街区',until:'最晚时间（选填）',start:'行程开始时间',submit:'记下来',read:'帮我提取',readhint:'点击提取后，当前选用的模型会读取这段话和所选图片。请核对地点、街区和日期后保存。',watching:'记着的事',history:'已结束',push:'开启手机提醒',unpush:'关闭本机提醒',signout:'退出',done:'办好了',drop:'这次算了',seen:'知道了',later:'明天再说',saved:'已记下',opportunity:'一个顺路的机会',deadline:'快到最晚时间了',reason:'附近有一项已安排的行程',empty:'还没有交给 Bob 的事。',first:'先写一句话或选一张图片。',missingTime:'请给行程选一个未来的开始时间。',source:'打开原图',pic:'一张截图',hint:'已附图片',busy:'正在读取…',ready:'已提取，请核对地点和时间后保存。',unavailable:'请在聊天与设置中选择模型并配置端点和密钥，也可以手动填写。',budget:'本期可用预算不足。',error:'操作未完成，请重试。',imageErr:'无法读取图片，请改选 JPG 或 PNG。',pushErr:'本机未能开启推送。可以先安装到主屏幕并允许通知。',enabled:'本机提醒已开启',disabled:'本机提醒已关闭',late:'已过截止时间',snooze:'已推迟到',invalid:'输入无效，请检查时间和内容。',closed:'已结束',noTime:'未设时间',stale:'事项已变化，请查看最新状态。'},
 en:{city:'City (optional)',area:'Neighborhood (optional)',providerAuth:'Check your API key and model access in Chat & settings.',providerRejected:'The selected model rejected the request. Check its endpoint and image support.',providerLimit:'Provider quota or rate limit reached. Check the account or retry later.',draft:'Draft a plan',draftLabel:'Calendar draft',draftHelp:'Review the time and place before opening the 30-minute event in your calendar.',draftName:'Title',draftAt:'Start time',downloadDraft:'Export to calendar',cancel:'Cancel',draftReady:'Calendar draft downloaded. Open it to confirm.',today:"Today's agenda",untilShort:'Due',agendaEmpty:'Nothing scheduled or due today.',calendar:'Import from calendar',calendarHelp:'Choose an .ics file, then select the plans to share with Bob. Imports timed, one-off events within a year. All-day, recurring and ambiguous times are skipped.',chooseCalendar:'Choose a calendar file',confirmCalendar:'Import selected plans',calendarInvalid:'Could not read this calendar file.',calendarSize:'Choose a file under 1 MB with up to 2,000 events.',available:'Available',skipped:'Skipped',imported:'Added',updated:'Updated',unchanged:'Already saved',heading:'On your mind',classic:'Chat & settings',pin:'Enter your Bob PIN',enter:'Sign in',capture:'What should Bob remember?',placeholder:'An exhibit I want to see when I’m near the waterfront…',kind:'Handle as',wish:'Keep an eye on it',save:'Bookmark only',plan:'My plan',image:'Add a screenshot',details:'Place and time',where:'Venue or area',until:'Deadline (optional)',start:'Plan starts',submit:'Save',read:'Extract details',readhint:'Extraction sends this note and selected image to your selected model. Review the venue, neighborhood and date before saving.',watching:'Keeping track',history:'Finished',push:'Enable phone alerts',unpush:'Disable alerts here',signout:'Sign out',done:'Done',drop:'Skip this one',seen:'Got it',later:'Tomorrow',saved:'Saved',opportunity:'An opportunity nearby',deadline:'Time is running short',reason:'A scheduled plan nearby',empty:'Nothing to follow yet.',first:'Add a note or an image first.',missingTime:'Choose a future time for the plan.',source:'Open image',pic:'Screenshot',hint:'Image attached',busy:'Reading…',ready:'Review the extracted place and time, then save.',unavailable:'Select a model, endpoint and key in Chat & settings, or enter details manually.',budget:'Insufficient budget.',error:'Could not finish. Please try again.',imageErr:'Could not read image. Try JPEG or PNG.',pushErr:'Could not enable alerts. Install on your home screen and allow notifications.',enabled:'Alerts enabled',disabled:'Alerts disabled',late:'Deadline passed',snooze:'Snoozed until',invalid:'Check the time and contents.',closed:'Finished',noTime:'No time set',stale:'This item changed. Check its current state.'}
};
const $=id=>document.getElementById(id);
let lang=localStorage.getItem('bob-life-lang')||(navigator.language.startsWith('zh')?'zh':'en');
const t=k=>words[lang][k]||k;
let items=[],candidate=crypto.randomUUID().replaceAll('-',''),attachment='',shareKey='',sw,sub,loaded=false,busy=false,photoWork=Promise.resolve();
function message(k){$('msg').textContent=k?t(k):''}
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
function localDate(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
const fmt=ms=>new Date(ms).toLocaleString(lang,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function translate(){document.documentElement.lang=lang;$('lang').textContent=lang==='zh'?'EN':'中文';for(const n of document.querySelectorAll('[data-t]'))n.textContent=t(n.dataset.t);$('note').placeholder=t('placeholder');$('push').textContent=t(sub?'unpush':'push');$('whenLabel').textContent=t($('kind').value==='plan'?'start':'until');render();showCalendar()}
async function api(path,body){const r=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok){if(r.status===401){$('login').hidden=false;$('app').hidden=true;loaded=false}throw new Error((await r.text()).trim())}return r.json()}
async function load(){try{items=await api('/api/life/items');loaded=true;$('login').hidden=true;$('app').hidden=false;render()}catch(e){if(e.message!=='auth')message('error')}}
function button(label,fn){const b=el('button',t(label));b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn()}catch(e){message(e.message==='stale'?'stale':'error');await load()}finally{b.disabled=false}};return b}
function card(i,focus){
 const d=el('article',undefined,'card'+(focus?' focus':''));const name=i.Text||t('pic');
 if(focus){d.append(el('small',t(i.Related?'opportunity':'deadline')))}
 d.append(el('h3',name));const p=items.find(p=>p.ID===i.Related);
 if(focus&&p)d.append(el('p',[t('reason'),p.Text,p.Place,fmt(p.At)].filter(Boolean).join(' · ')));
 d.append(el('small',[t(i.Kind),i.Place,i.At?fmt(i.At):'',i.At&&i.At<Date.now()&&i.Kind==='wish'?t('late'):'',i.Snooze>Date.now()?t('snooze')+' '+fmt(i.Snooze):''].filter(Boolean).join(' · ')));
 if(i.Image){const a=el('a',t('source'));a.href='/api/life/art/'+encodeURIComponent(i.ID);a.target='_blank';a.rel='noopener';d.append(a)}
 if(i.Status==='open'){const actions=el('div',undefined,'actions');for(const action of (focus?['seen','later','done','drop']:['done','drop'])){actions.append(button(action,async()=>{await api('/api/life/action',{ID:i.ID,Action:action,Signal:i.Signal});await load()}))}if(focus)actions.prepend(button('draft',()=>openDraft(i,p)));d.append(actions)}return d
}
function render(){showAgenda();for(const id of ['notices','open','closed'])$(id).replaceChildren();for(const i of items){const focus=i.Status==='open'&&i.Signal&&i.Signal!==i.Seen;$(focus?'notices':i.Status==='open'?'open':'closed').append(card(i,focus))}if(!items.some(i=>i.Status==='open'))$('open').append(el('p',t('empty'),'muted'))}
async function setPhoto(file){attachment='';$('filehint').textContent='';if(!file||!file.size)return;if(file.size>12*1024*1024)throw new Error('image');const url=URL.createObjectURL(file);
 try{const img=new Image();img.src=url;await img.decode();const k=Math.min(1,1200/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*k));c.height=Math.max(1,Math.round(img.height*k));c.getContext('2d').drawImage(img,0,0,c.width,c.height);attachment=c.toDataURL('image/jpeg',.84);$('filehint').textContent=t('hint')}finally{URL.revokeObjectURL(url)}}
function selectPhoto(file){photoWork=photoWork.then(()=>setPhoto(file)).catch(()=>{attachment='';message('imageErr')});return photoWork}
$('photo').onchange=()=>selectPhoto($('photo').files[0]);
$('kind').onchange=()=>{$('whenLabel').textContent=t($('kind').value==='plan'?'start':'until');if($('kind').value==='plan')$('details').open=true};
$('lang').onclick=()=>{lang=lang==='zh'?'en':'zh';localStorage.setItem('bob-life-lang',lang);translate()};
$('login').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{pin:$('pin').value});$('pin').value='';message('');await load()}catch{message('error')}};
$('signout').onclick=async()=>{try{await api('/api/logout',{});location.reload()}catch{message('error')}};
$('place').oninput=()=>{$('city').value='';$('area').value=''};
$('read').onclick=async()=>{await photoWork;if(!attachment&&!$('note').value.trim())return message('first');$('read').disabled=true;message('busy');try{const out=await api('/api/life/read',{Photo:attachment,Text:$('note').value,Today:localDate(new Date())});if(out.Title&&!$('note').value.trim())$('note').value=out.Title;if(out.Place&&(!$('place').value||$('place').value===out.Place)){
 $('place').value=out.Place;if(!$('city').value)$('city').value=out.City||'';if(!$('area').value)$('area').value=out.Area||'';}if(/^\d{4}-\d{2}-\d{2}$/.test(out.Date)&&!$('when').value)$('when').value=out.Date+($('kind').value==='plan'?'T09:00':'T23:59');$('details').open=true;message('ready')}catch(e){message(e.message==='visionUnavailable'?'unavailable':['budget','providerAuth','providerRejected','providerLimit'].includes(e.message)?e.message:'error')}finally{$('read').disabled=false}};
$('capture').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('submit').disabled=true;try{await photoWork;const kind=$('kind').value,at=$('when').value?new Date($('when').value).getTime():0;if(!attachment&&!$('note').value.trim()){message('first');return}if(kind==='plan'&&at<=Date.now()){$('details').open=true;message('missingTime');return}
 await api('/api/life/items',{ID:candidate,Kind:kind,Text:$('note').value,Place:$('place').value,City:$('city').value,Area:$('area').value,At:at,Photo:attachment});candidate=crypto.randomUUID().replaceAll('-','');$('capture').reset();attachment='';$('filehint').textContent='';$('kind').onchange();if(shareKey){(await caches.open('life-share')).delete('/life-share/'+shareKey);history.replaceState(null,'','/');shareKey=''}message('saved');await load()}catch(e){message(['invalid','time','image'].includes(e.message)?'invalid':'error')}finally{busy=false;$('submit').disabled=false}};
$('push').onclick=async()=>{try{if(!sw)throw Error();if(sub){await api('/api/life/push',{Endpoint:sub.endpoint,Remove:true});await sub.unsubscribe();sub=null;message('disabled')}else{if(await Notification.requestPermission()!=='granted')throw Error();const {key}=await api('/api/life/push');const bytes=Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));const next=await sw.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});await api('/api/life/push',{Endpoint:next.endpoint});sub=next;message('enabled')}translate()}catch{message('pushErr')}};
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

translate();await load();
if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('/sw.js');sw=await navigator.serviceWorker.ready;sub=await sw.pushManager?.getSubscription();if(sub&&loaded)await api('/api/life/push',{Endpoint:sub.endpoint});translate()}catch{}}
const args=new URLSearchParams(location.search);shareKey=args.get('share')||'';
if(/^[0-9a-f-]{36}$/.test(shareKey)){try{const r=await(await caches.open('life-share')).match('/life-share/'+shareKey);if(r){const data=await r.formData();$('note').value=[data.get('title'),data.get('text'),data.get('url')].filter(Boolean).join('\n').slice(0,1200);await selectPhoto(data.get('image'))}}catch{message('imageErr')}}
if(args.has('shareError'))message('imageErr');
setInterval(()=>{if(loaded&&!document.hidden)load()},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
