import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const clientScript=readFileSync(new URL('./web/push-client.js',import.meta.url),'utf8');
const workerScript=readFileSync(new URL('./web/sw.js',import.meta.url),'utf8');

function browser() {
  const values=new Map(), calls=[], device={sub:null, prompts:0, created:0, failTest:false};
  function subscription(id) {
    return {endpoint:id,toJSON:()=>({endpoint:id,expirationTime:null,keys:{p256dh:'device-key',auth:'secret'}}),
      unsubscribe:async()=>{device.sub=null;return true;}};
  }
  device.sub=subscription('original');
  const registration={pushManager:{getSubscription:async()=>device.sub,
    subscribe:async()=>{device.created++;return device.sub=subscription('renewed-'+device.created);}}};
  const context={atob,Uint8Array,Notification:{permission:'granted',requestPermission(){device.prompts++;return 'granted';}},
    navigator:{serviceWorker:{register:async(path,options)=>{assert.equal(path,'/sw.js');assert.equal(options.scope,'/');},ready:Promise.resolve(registration)}},
    localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},
    fetch:async(path,options)=>{
      const body=options.body && JSON.parse(options.body);calls.push({path,body});
      if(path.endsWith('/test')&&device.failTest){device.failTest=false;return {ok:false,text:async()=>'expired'};}
      return {ok:true,json:async()=>body?{preview:!!body.preview,accepted:true}:{key:'AQID'}};
    }};
  context.window=context;vm.runInNewContext(clientScript,context);
  return {push:context.BobPush,device,calls,values};
}
test('existing installation syncs all keys without prompting; renewal preserves the previous endpoint',async()=>{
  const {push,device,calls}=browser();
  await push.sync();await push.sync();
  assert.deepEqual(calls[0].body.keys,{p256dh:'device-key',auth:'secret'});
  assert.equal(device.created,0);assert.equal(device.prompts,0);
  device.sub=null;
  assert.equal((await push.sync()).endpoint,'renewed-1');
  assert.equal(calls.at(-1).body.previousEndpoint,'original');
  assert.equal(device.prompts,0);
  await push.preview(true);assert.equal(calls.at(-1).body.preview,true);
  await push.disable();await push.sync();
  assert.equal(device.created,1);assert.equal(device.sub,null);
});
test('a test targets this device and silently retries a confirmed expiration once',async()=>{
  const {push,device,calls}=browser();
  device.failTest=true;await push.test();
  assert.deepEqual(calls.filter(c=>c.path.endsWith('/test')).map(c=>c.body.endpoint),['original','renewed-1']);
  assert.equal(device.prompts,0);
});
test('root worker always displays a notification and limits click URLs to this origin',async()=>{
  const handlers={},shown=[],opened=[];
  const scope={URL,clients:{matchAll:async()=>[],openWindow:async u=>opened.push(u)},
    self:{navigator:{language:'zh'},location:{origin:'https://example.test'},addEventListener:(event,fn)=>handlers[event]=fn,
      registration:{showNotification:async(title,options)=>shown.push({title,...options})}}};
  vm.runInNewContext(workerScript,scope);
  async function fire(name,payload){let job;handlers[name]({...payload,waitUntil(p){job=p;}});await job;}
  await fire('push',{});assert.ok(shown[0].body);
  await fire('push',{data:{json:()=>({kind:'test'})}});assert.match(shown[1].title,/测试/);
  await fire('push',{data:{json:()=>({title:'T',body:'B',tag:'tag',url:'/classic#plan'})}});
  assert.equal(shown[2].body,'B');assert.equal(shown[2].tag,'tag');
  await fire('notificationclick',{notification:{close(){},data:shown[2].data}});
  await fire('notificationclick',{notification:{close(){},data:{url:'//outside.test'}}});
  assert.deepEqual(opened,['https://example.test/classic#plan','https://example.test/#attention']);
  assert.ok(handlers.pushsubscriptionchange);
});
