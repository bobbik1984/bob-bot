self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
 const u = new URL(event.request.url);
 if (u.origin !== self.location.origin || u.pathname !== '/life-share' || event.request.method !== 'POST') return;
 event.respondWith((async () => {
  const form = await event.request.formData();
  const token = crypto.randomUUID();
  const file = form.get('image');
  if (file && file.size > 12*1024*1024) return Response.redirect('/?shareError=1',303);
  const cache = await caches.open('life-share');
  // Only retain temporary shares for a day on this device.
  for (const k of await cache.keys()) {
    const res = await cache.match(k);
    if (Number(res.headers.get('expires-at')) < Date.now()) await cache.delete(k);
  }
  const valid = new FormData();
  for (const k of ['title','text','url']) valid.set(k,String(form.get(k)||'').slice(0,1500));
  if(file instanceof Blob && file.type.startsWith('image/')) valid.set('image',file);
  const res = new Response(valid); res.headers.set('expires-at',String(Date.now()+86400000));
  await cache.put('/life-share/'+token,res);
  return Response.redirect('/?share='+token,303);
 })());
});
const copy = {
 zh:{reminder:'有一件你惦记的事，打开看看。',test:'这台设备可以收到 Bob 的通知。',testTitle:'Bob · 测试通知'},
 en:{reminder:'An intention needs your attention.',test:'This device can receive notifications from Bob.',testTitle:'Bob · Test notification'}
};
function localURL(value) {
 try {
  const u=new URL(typeof value==='string'?value:'/#attention',self.location.origin);
  if(u.origin===self.location.origin && !u.username && !u.password)return u.href;
 } catch {}
 return new URL('/#attention',self.location.origin).href;
}
self.addEventListener('push', event => {
 event.waitUntil((async () => {
  const t=copy[self.navigator.language?.startsWith('zh')?'zh':'en'];
  let data={}; try {data=event.data?.json()||{};} catch {}
  const test=data.kind==='test';
  const title=test?t.testTitle:(typeof data.title==='string' && data.title || 'Bob');
  const body=test?t.test:(typeof data.body==='string' && data.body || t.reminder);
  await self.registration.showNotification(title,{body,tag:test?'bob-test':(typeof data.tag==='string' && data.tag || 'bob-life'),
   icon:'/icons/icon-192.png',data:{url:localURL(data.url)}});
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const target=localURL(event.notification.data?.url);
  const open=await clients.matchAll({type:'window',includeUncontrolled:true});
  const same=open.find(c=>c.url===target);
  if(same){await same.focus();return}
  const app=open.find(c=>new URL(c.url).origin===self.location.origin);
  if(app){try{const next=await app.navigate(target);if(next){await next.focus();return}}catch{}}
  await clients.openWindow(target);
 })());
});
// Browsers that do not implement this event reconcile on login and foreground.
self.addEventListener('pushsubscriptionchange',event=>{
 event.waitUntil((async()=>{
  let sub=event.newSubscription;
  if(!sub && event.oldSubscription?.options?.applicationServerKey && self.Notification?.permission==='granted')
   sub=await self.registration.pushManager.subscribe(event.oldSubscription.options);
  if(!sub)return;
  const response=await fetch('/api/life/push',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({...sub.toJSON(),previousEndpoint:event.oldSubscription?.endpoint||''})});
  if(!response.ok)throw Error('subscription sync pending');
 })());
});
