import {test} from 'node:test';
import assert from 'node:assert/strict';
import {state,live,switchContext,getJSON,postJSON} from '../public/app/core.js';
test('switching customer context clears cached data and rejects late reads',async()=>{
 state.customer=true;state.user={id:'user_a'};state.spaceRecords=[{id:'a',workspaceId:'w1',namespace:'s-a'},{id:'b',workspaceId:'w1',namespace:'s-b'}];
 switchContext({workspaceId:'w1',spaceId:'a'});
 const before=globalThis.fetch;let finish;
 globalThis.fetch=()=>new Promise(resolve=>{finish=()=>resolve({status:200,json:async()=>({secret:'old space'})});});
 try{
  const pending=getJSON('/api/view?what=home');live.home={old:true};live.jobs={old:true};live.decisionReceipt={old:true};
  switchContext({workspaceId:'w1',spaceId:'b'});finish();const r=await pending;
  assert.equal(r.__stale,true);assert.equal(live.home,null);assert.equal(live.jobs,null);assert.equal(live.decisionReceipt,null);
 }finally{globalThis.fetch=before;}
});
test('customer requests carry verified-context selectors, never previous selectors',async()=>{
 state.customer=true;state.user={id:'user_a'};state.spaceRecords=[{id:'a',workspaceId:'w1',namespace:'s-a'}];switchContext({workspaceId:'w1',spaceId:'a'});
 const before=globalThis.fetch;let captured;
 globalThis.fetch=async(url,opts)=>{captured={url,opts};return {status:200,json:async()=>({ok:true})};};
 try{
 await getJSON('/api/view?what=home');assert.match(captured.url,/workspaceId=w1/);assert.equal(captured.opts.headers['X-LogMem-Viewer'],'customer');
 await postJSON('/api/nudge','work',{job:'job'});assert.equal(JSON.parse(captured.opts.body).spaceId,'a');
 }finally{globalThis.fetch=before;}
});
test('a denied customer mutation clears revoked content before callbacks run',async()=>{
 const {setSignedOutHook}=await import('../public/app/core.js');setSignedOutHook(()=>{});
 state.customer=true;state.user={id:'user_a'};state.spaceRecords=[{id:'a',workspaceId:'w1',namespace:'s-a'}];switchContext({workspaceId:'w1',spaceId:'a'});live.home={private:'old records'};
 const before=globalThis.fetch;globalThis.fetch=async()=>({status:404,json:async()=>({error:'not_found'})});
 try{await assert.rejects(postJSON('/api/nudge','work',{job:'job'}));assert.equal(state.space,null);assert.equal(live.home,null);assert.equal(live.signedOut,true);}finally{globalThis.fetch=before;}
});
