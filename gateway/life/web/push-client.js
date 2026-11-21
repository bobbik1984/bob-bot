// Shared by Life and Classic. Service worker scope, permission and device identity belong to the origin.
(() => {
  const path = '/api/life/push';
  const pref = 'bob.push.enabled', last = 'bob.push.endpoint';
  let registration, queue = Promise.resolve();
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  function remember(key, value) { try { localStorage.setItem(key, value); } catch {} }
  function serial(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }
  async function api(url, body) {
    const options = {credentials:'same-origin', cache:'no-store'};
    if (body !== undefined) Object.assign(options, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const response = await fetch(url, options);
    if (!response.ok) throw Error((await response.text()).trim());
    return response.json();
  }
  function ready() {
    if (!('serviceWorker' in navigator)) return Promise.reject(Error('unsupported'));
    if (!registration) registration = navigator.serviceWorker.register('/sw.js',{scope:'/'}).then(() => navigator.serviceWorker.ready)
      .catch(error => { registration = undefined; throw error; });
    return registration;
  }
  async function create(manager) {
    const {key} = await api(path);
    const bytes = Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')), ch => ch.charCodeAt(0));
    return manager.subscribe({userVisibleOnly:true, applicationServerKey:bytes});
  }
  async function synchronize({enable=false, preview, replace=false}={}) {
    const reg = await ready();
    if (!reg.pushManager) {if(enable)throw Error('unsupported');return {enabled:false};}
    let sub = await reg.pushManager.getSubscription();
    const previousEndpoint = sub?.endpoint || stored(last) || '';
    if (!enable && stored(pref)==='off') {
      if(sub && !await sub.unsubscribe()) throw Error('unsubscribe');
      if(previousEndpoint) await api(path,{endpoint:previousEndpoint,remove:true});
      remember(last,''); return {enabled:false};
    }
    if (replace && sub) { await sub.unsubscribe(); sub = null; }
    if (!sub && (enable || stored(pref)==='on') && globalThis.Notification?.permission==='granted') sub = await create(reg.pushManager);
    if (!sub) return {enabled:false};
    const save = () => {
      const data = sub.toJSON();
      if (!data.keys?.p256dh || !data.keys?.auth) throw Error('pushKeys');
      return api(path, {...data, previousEndpoint:stored(last) || previousEndpoint, preview});
    };
    let state;
    try { state = await save(); }
    catch(error) {
      if (error.message!=='expired' || replace || globalThis.Notification?.permission!=='granted') throw error;
      remember(pref,'on');
      await sub.unsubscribe();
      sub = await create(reg.pushManager);
      state = await save();
    }
    remember(pref,'on'); remember(last,sub.endpoint);
    return {enabled:true, preview:state.preview, endpoint:sub.endpoint};
  }
  window.BobPush = {
    ready,
    sync: () => serial(() => synchronize()),
    async enable() {
      if (!globalThis.Notification) throw Error('unsupported');
      // The permission prompt must run in the original iOS tap handler.
      const permission = Notification.permission==='default' ? await Notification.requestPermission() : Notification.permission;
      if (permission!=='granted') throw Error('permission');
      return serial(() => synchronize({enable:true}));
    },
    disable: () => serial(async () => {
      const reg = await ready(), sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint || stored(last);
      remember(pref,'off');
      if (sub && !await sub.unsubscribe()) throw Error('unsubscribe');
      if (endpoint) await api(path,{endpoint,remove:true});
      remember(last,'');
      return {enabled:false};
    }),
    preview: value => serial(() => synchronize({preview:value})),
    test: () => serial(async () => {
      let state = await synchronize();
      if (!state.enabled) throw Error('missing');
      try { return await api(path+'/test',{endpoint:state.endpoint}); }
      catch(error) {
        if(error.message!=='expired') throw error;
        state=await synchronize({enable:true,replace:true});
        return api(path+'/test',{endpoint:state.endpoint});
      }
    })
  };
})();
