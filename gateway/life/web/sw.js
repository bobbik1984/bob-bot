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
self.addEventListener('push', event => {
 event.waitUntil((async()=>{
  if(event.data){let p={};try{p=event.data.json()}catch{};await self.registration.showNotification(p.title||'Bob',{body:p.body||'',tag:p.tag,data:{url:p.url||'/'}});return}
  let body=self.navigator.language?.startsWith('zh')?'有一件你惦记的事，打开看看。':'An intention needs your attention.';
  await self.registration.showNotification('Bob',{body,tag:'bob-life',icon:'/icons/icon-192.png',data:{url:'/#attention'}});
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const u=new URL(event.notification.data?.url||'/',self.location.origin);
 if(u.origin===self.location.origin)event.waitUntil(clients.openWindow(u.href));
});
