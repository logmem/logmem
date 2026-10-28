import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createStore} from '../src/core/store.mjs';
import {createPlan} from '../src/core/plans.mjs';
import {createBlocker,getBlocker} from '../src/core/blockers.mjs';
import {interact,discussion,coordinationQueue} from '../src/http/interactions.mjs';
async function setup(){const redis=createMemoryRedis(),store=createStore(redis,{space:'test'});await store.setWho('job','a',{title:'A',owner:'agent:one'});await store.setNow('job','a',{owner:'agent:one',stage:'blocked',waits:[{type:'task',ref:'t'}]});for(const id of ['one','two'])await store.setWho('agent',id,{name:id});return{redis,store};}
const input=(extra={})=>({target:{type:'job',id:'a'},action:'comment',text:'Please check this.',requestId:'request-0001',by:'human:Mikey',manager:true,now:()=>1000000,...extra});
test('comments attach to records, replay once, and reject altered request reuse',async()=>{const{store}=await setup();await interact(store,input());await interact(store,input());const d=await discussion(store,{type:'job',id:'a'},{by:'human:Mikey'});assert.equal(d.entries.length,1);assert.equal(d.entries[0].by,'human:Mikey');await assert.rejects(()=>interact(store,input({text:'Changed'})),e=>e.status===409);assert.equal((await store.readLog('job','a')).length,1);});
test('missing targets, oversized text, and malformed identifiers cannot write',async()=>{const{store}=await setup();for(const x of [{target:{type:'job',id:'missing'}},{text:' '},{text:'x'.repeat(2001)},{target:{type:'job',id:'../a'}}])await assert.rejects(()=>interact(store,input(x)));assert.equal((await discussion(store,{type:'job',id:'a'},{by:'human:Mikey'})).entries.length,0);});
test('job reassignment uses expected ownership and preserves waits and stage',async()=>{const{store}=await setup();await interact(store,input({action:'reassign',to:'agent:two',expectedOwner:'agent:one',text:'Cover this review.'}));const n=await store.getNow('job','a');assert.equal(n.owner,'agent:two');assert.equal(n.stage,'blocked');assert.equal(n.waits[0].ref,'t');await assert.rejects(()=>interact(store,input({action:'reassign',to:'agent:one',expectedOwner:'agent:one',requestId:'request-0002'})),e=>e.status===409);await assert.rejects(()=>interact(store,input({action:'reassign',to:'agent:one',expectedOwner:'agent:two',manager:false,requestId:'request-0003'})),e=>e.status===403);});
test('task reassignment keeps progress and refuses a completed task',async()=>{const{store}=await setup();await createBlocker(store,{trail:'t',where:'job:a',by:'human:Mikey',to:'human:Old',summary:'Read it'});await store.redis('SET','lm:test:blocker:t',JSON.stringify({...await getBlocker(store,'t'),steps_done:[0],started_at:99}));await interact(store,input({target:{type:'task',id:'t'},action:'reassign',to:'human:New',expectedOwner:'human:Old'}));let b=await getBlocker(store,'t');assert.deepEqual(b.steps_done,[0]);assert.equal(b.started_at,99);assert.equal(b.to,'human:New');await store.redis('SET','lm:test:blocker:t',JSON.stringify({...b,done:true}));await assert.rejects(()=>interact(store,input({target:{type:'task',id:'t'},action:'reassign',to:'human:Old',expectedOwner:'human:New',requestId:'request-0002'})),e=>e.status===409);});
test('plan discussion is isolated from sibling spaces and supports paging',async()=>{const{store,redis}=await setup();await createPlan(store,{id:'launch',title:'Launch'});for(let i=0;i<3;i++)await interact(store,input({target:{type:'plan',id:'launch'},requestId:'request-page-'+i,now:()=>1000000+i}));const first=await discussion(store,{type:'plan',id:'launch'},{by:'human:Mikey',limit:2});assert.equal(first.entries.length,2);assert.equal(first.nextCursor,2);const next=await discussion(store,{type:'plan',id:'launch'},{by:'human:Mikey',limit:2,cursor:2});assert.equal(next.entries.length,1);await assert.rejects(()=>discussion(createStore(redis,{space:'other'}),{type:'plan',id:'launch'},{by:'human:Mikey'}),e=>e.status===404);});
async function seedItem(redis){const id='ci_'+'a'.repeat(24);await redis('HSET','lm:test:coord:item:'+id,'id',id,'space','test','type','handoff','from','agent:one','to','agent:two','where','job:a','request_trail','handoff-a','summary','Review A','response','open','created_at','1000','deadline','86401000','last_nudge_at','');await redis('ZADD','lm:test:coord:open',86401000,id);return id;}
test('item nudges resolve stored recipients and keep deadline and response unchanged',async()=>{const{store,redis}=await setup(),id=await seedItem(redis);await interact(store,input({target:{type:'coord',id},action:'nudge',to:'agent:forged'}));assert.equal(await redis('HGET','lm:test:coord:item:'+id,'deadline'),'86401000');assert.equal(await redis('HGET','lm:test:coord:item:'+id,'response'),'open');assert.equal((await store.readLog('agent','two')).length,1);await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'nudge',requestId:'request-0002'})),e=>e.status===429);await redis('HSET','lm:test:coord:item:'+id,'response','answered');await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'nudge',requestId:'request-0003',now:()=>2000000})),e=>e.status===409);});
test('queue reports incomplete coverage instead of claiming an empty backlog',async()=>{const{store,redis}=await setup();const empty=await coordinationQueue(store);assert.equal(empty.coverage.complete,false);await seedItem(redis);const q=await coordinationQueue(store);assert.equal(q.items.length,1);assert.equal(q.items[0].to,'agent:two');});
test('a delivery failure keeps the mutation receipt and retry finishes without duplication',async()=>{const{store}=await setup();const append=store.append;let fail=true;store.append=async(...a)=>{if(fail)throw new Error('offline');return append(...a);};await assert.rejects(()=>interact(store,input()),e=>e.status===503);assert.equal((await discussion(store,{type:'job',id:'a'},{by:'human:Mikey'})).entries.length,1);fail=false;await interact(store,input());assert.equal((await store.readLog('job','a')).length,1);});
test('a task progress race refuses reassignment without losing the new progress',async()=>{const{store,redis}=await setup();await createBlocker(store,{trail:'race',where:'job:a',by:'human:Mikey',to:'human:Old',summary:'Read'});let once=true;store.redis=async(...c)=>{if(c[0]==='EVAL'&&once){once=false;const key='lm:test:blocker:race',old=JSON.parse(await redis('GET',key));await redis('SET',key,JSON.stringify({...old,steps_done:[0]}));}return redis(...c);};await assert.rejects(()=>interact(store,input({target:{type:'task',id:'race'},action:'reassign',to:'human:New',expectedOwner:'human:Old'})),e=>e.status===409);assert.deepEqual((await getBlocker(store,'race')).steps_done,[0]);assert.equal((await getBlocker(store,'race')).to,'human:Old');});
test('a corrupt revision counter never leaves a partial mutation',async()=>{const{store,redis}=await setup();await redis('SET','lm:test:rev','invalid');await assert.rejects(()=>interact(store,input()));assert.equal((await discussion(store,{type:'job',id:'a'},{by:'human:Mikey'})).entries.length,0);});
test('the old task recipient cannot finish or tick after reassignment',async()=>{const{store}=await setup();const{setStep,markDone,cantDo}=await import('../src/core/blockers.mjs');await createBlocker(store,{trail:'authority',where:'job:a',by:'human:Mikey',to:'human:Old',summary:'Read',walkthrough:{steps:[{title:'One'}]}});await interact(store,input({target:{type:'task',id:'authority'},action:'reassign',to:'human:New',expectedOwner:'human:Old'}));await assert.rejects(()=>setStep(store,'authority',{by:'human:Old',step:0,checked:true}));await assert.rejects(()=>markDone(store,'authority',{by:'human:Old'}));await assert.rejects(()=>cantDo(store,'authority',{by:'human:Old',reason:'No'}));assert.equal((await getBlocker(store,'authority')).done,false);});
test('task CAS uses the same raw snapshot that produced its replacement',async()=>{const{store,redis}=await setup();await createBlocker(store,{trail:'snapshot',where:'job:a',by:'human:Mikey',to:'human:Old',summary:'Read'});let changed=false;store.redis=async(...c)=>{const result=await redis(...c);if(c[0]==='GET'&&c[1]==='lm:test:blocker:snapshot'&&!changed){changed=true;await redis('SET',c[1],JSON.stringify({...JSON.parse(result),steps_done:[0]}));}return result;};await assert.rejects(()=>interact(store,input({target:{type:'task',id:'snapshot'},action:'reassign',to:'human:New',expectedOwner:'human:Old'})),e=>e.status===409);const rec=await getBlocker(store,'snapshot');assert.deepEqual(rec.steps_done,[0]);assert.equal(rec.to,'human:Old');});
test('a decision comment preserves the exact approval request and job wait',async()=>{const{store,redis}=await setup();process.env.LOGMEM_DECIDE_SECRET||='test-only-interaction-decision-0123456789';const{createLogmem}=await import('../src/server.mjs');const lm=createLogmem({redis,space:'test',sessionId:'comment-approval',surface:'test',defaultAgent:'one'});const asked=(await lm.callTool('logmem_ask',{question:'Ship this version?',action:'Deploy the reviewed commit.',where:'job:a'})).structuredContent;assert.equal(asked.ok,true);const before=await store.getNow('job','a');await interact(store,input({target:{type:'decision',id:asked.trail},text:'Please include the rollback steps.'}));assert.deepEqual(await store.getNow('job','a'),before);assert.equal((await discussion(store,{type:'decision',id:asked.trail},{by:'human:Mikey'})).entries.length,1);assert.equal(await redis('GET',`lm:test:decision:${asked.trail}`),null);});
test('settlement racing an item nudge wins without a new ping',async()=>{const{store,redis}=await setup(),id=await seedItem(redis);let once=true;store.redis=async(...c)=>{if(c[0]==='EVAL'&&once){once=false;await redis('HSET','lm:test:coord:item:'+id,'response','answered');}return redis(...c);};await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'nudge'})),e=>e.status===409);assert.equal((await store.readLog('agent','two')).length,0);});
test('canonical last nudge time enforces cooldown even without a local cooldown key',async()=>{const{store,redis}=await setup(),id=await seedItem(redis);await redis('HSET','lm:test:coord:item:'+id,'last_nudge_at','999999');await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'nudge'})),e=>e.status===429);assert.equal((await store.readLog('agent','two')).length,0);});
test('invalid coordination timestamps cannot send a nudge',async()=>{const{store,redis}=await setup(),id=await seedItem(redis);await redis('HSET','lm:test:coord:item:'+id,'deadline','-1');await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'nudge'})),e=>e.status===409);});

test('only managers can resolve canonical coordination and must give a reason',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis),target={type:'coord',id};
 for(const extra of [{manager:false},{text:' '},{expectedOwner:'agent:one'},{target:{type:'job',id:'a'}}]){
  await assert.rejects(()=>interact(store,input({target,action:'resolve',expectedOwner:'agent:two',...extra})),e=>[400,403,409].includes(e.status));
 }
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'response'),'open');
 assert.equal((await discussion(store,target,{manager:false})).canResolve,false);
 assert.equal((await discussion(store,target,{manager:true})).canResolve,true);
 assert.equal((await discussion(store,target,{manager:true,canWrite:false})).canResolve,false);
});

test('manager resolution records the human reason and removes both open indexes without completing the job',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis),target={type:'coord',id};
 await redis('ZADD','lm:test:coord:open:two',86401000,id);
 await store.append('job','a',{ts:1000,trail:'handoff-a',kind:'handoff',by:'agent:one',to:'agent:two',summary:'Original handoff'});
 const before=await store.getNow('job','a');
 const change=input({target,action:'resolve',text:'This request was superseded by the completed review.',expectedOwner:'agent:two'});
 const result=await interact(store,change);
 const raw=await redis('HGETALL','lm:test:coord:item:'+id);
 const record=Array.isArray(raw)?Object.fromEntries(Array.from({length:raw.length/2},(_,i)=>[raw[i*2],raw[i*2+1]])):raw;
 assert.equal(record.response,'declined');
 assert.equal(record.disposition,'manager-resolved');
 assert.equal(record.settled_by,'human:Mikey');
 assert.equal(record.settled_at,'1000000');
 assert.equal(record.settlement_trail,result.entry.trail);
 assert.deepEqual(await redis('ZRANGE','lm:test:coord:open',0,-1),[]);
 assert.deepEqual(await redis('ZRANGE','lm:test:coord:open:two',0,-1),[]);
 assert.deepEqual(await store.getNow('job','a'),before);
 const logs=await store.readLog('job','a');
 assert.equal(logs[0].kind,'handoff');
 assert.equal(logs[1].by,'human:Mikey');
 assert.equal(logs[1].payload.reason,change.text);
 assert.equal(logs[1].payload.disposition,'manager-resolved');
 const d=await discussion(store,target,{manager:true});
 assert.equal(d.canResolve,false);
 assert.equal(d.entries.length,1);
 assert.equal(d.entries[0].kind,'memo');
 assert.equal((await interact(store,change)).replayed,true);
 assert.equal((await store.readLog('job','a')).length,2);
 assert.equal((await store.readLog('agent','two')).length,1);
 await assert.rejects(()=>interact(store,{...change,text:'Different reason.'}),e=>e.status===409);
 await assert.rejects(()=>interact(store,{...change,manager:false}),e=>e.status===403);
});

test('a recipient change between load and resolution prevents closure and audit writes',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis);let once=true;
 store.redis=async(...c)=>{if(c[0]==='EVAL'&&once){once=false;await redis('HSET','lm:test:coord:item:'+id,'to','agent:one');}return redis(...c);};
 await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'resolve',expectedOwner:'agent:two'})),e=>e.status===409);
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'response'),'open');
 assert.equal((await discussion(store,{type:'coord',id},{manager:true})).entries.length,0);
});

test('an agent answer racing manager resolution wins without manager audit writes',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis);let once=true;
 store.redis=async(...c)=>{if(c[0]==='EVAL'&&once){once=false;await redis('HSET','lm:test:coord:item:'+id,'response','answered','settled_by','agent:two');}return redis(...c);};
 await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'resolve',expectedOwner:'agent:two'})),e=>e.status===409);
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'response'),'answered');
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'settled_by'),'agent:two');
 assert.equal((await discussion(store,{type:'coord',id},{manager:true})).entries.length,0);
});

test('manager resolution cannot access another space or a forged record namespace',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis);
 const change=input({target:{type:'coord',id},action:'resolve',expectedOwner:'agent:two'});
 await assert.rejects(()=>interact(createStore(redis,{space:'other'}),change),e=>e.status===404);
 await redis('HSET','lm:test:coord:item:'+id,'space','other');
 await assert.rejects(()=>interact(store,change),e=>e.status===404);
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'response'),'open');
});

test('a corrupt recipient index prevents every resolution write',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis);
 await redis('SET','lm:test:coord:open:two','broken');
 await assert.rejects(()=>interact(store,input({target:{type:'coord',id},action:'resolve',expectedOwner:'agent:two'})),e=>e.status===503);
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'response'),'open');
 assert.deepEqual(await redis('ZRANGE','lm:test:coord:open',0,-1),[id]);
 assert.equal((await discussion(store,{type:'coord',id},{manager:true})).entries.length,0);
});

test('resolution delivery retries preserve one durable audit entry and the original human identity',async()=>{
 const{store,redis}=await setup(),id=await seedItem(redis),append=store.append;let offline=true;
 store.append=async(...args)=>{if(offline)throw new Error('offline');return append(...args);};
 const change=input({target:{type:'coord',id},action:'resolve',expectedOwner:'agent:two',text:'Duplicate request.'});
 await assert.rejects(()=>interact(store,change),e=>e.status===503);
 assert.equal(await redis('HGET','lm:test:coord:item:'+id,'disposition'),'manager-resolved');
 assert.equal((await discussion(store,change.target,{manager:true})).entries.length,1);
 offline=false;
 assert.equal((await interact(store,change)).replayed,true);
 assert.equal((await store.readLog('job','a')).length,1);
 assert.equal((await store.readLog('job','a'))[0].by,'human:Mikey');
});

test('customer resolve requires manage-members permission and preserves verified human identity',async()=>{
 const{createHandler}=await import('../api/interactions.mjs');
 const{createWorkspace,setMembership}=await import('../src/http/workspaces.mjs');
 const{mockReq,mockRes}=await import('./oauth-helpers.mjs');
 const redis=createMemoryRedis(),owner='user_OwnerResolve01',editor='user_EditorResolve01';
 const workspace=await createWorkspace({userId:owner,name:'Firm',firstSpaceName:'Ops',requestId:'create-resolve'},{redis});
 await setMembership({actorId:owner,workspaceId:workspace.workspace.id,userId:editor,role:'member',spaces:{[workspace.space.id]:{role:'editor',canApprove:false}},requestId:'membership-resolve'},{redis});
 const store=createStore(redis,{space:workspace.space.namespace}),id='ci_'+'b'.repeat(24),key=`lm:${store.space}:coord:item:${id}`;
 await store.setWho('job','a',{title:'Review'});
 await redis('HSET',key,'id',id,'space',store.space,'to','agent:retired','where','job:a','request_trail','old-handoff','response','open');
 await redis('ZADD',`lm:${store.space}:coord:open`,1000,id);
 await redis('ZADD',`lm:${store.space}:coord:open:retired`,1000,id);
 const invoke=async(userId)=>{
  const handler=createHandler({redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1'},session:async()=>({status:'signed-in',userId})});
  const res=mockRes();
  await handler(mockReq({method:'POST',url:'/api/interactions',headers:{host:'logmem.test',origin:'https://logmem.test','x-logmem-intent':'interactions','x-logmem-viewer':'customer'},body:{workspaceId:workspace.workspace.id,spaceId:workspace.space.id,target:{type:'coord',id},action:'resolve',text:'The retired agent no longer owns this request.',expectedOwner:'agent:retired',requestId:'resolve-api-001',by:'human:Forged'}}),res);
  return {status:res.statusCode,data:JSON.parse(res.body)};
 };
 const denied=await invoke(editor);
 assert.equal(denied.status,403);
 assert.equal(await redis('HGET',key,'response'),'open');
 const approved=await invoke(owner);
 assert.equal(approved.status,200,JSON.stringify(approved));
 assert.equal(approved.data.entry.by,'human:'+owner);
 assert.equal(await redis('HGET',key,'settled_by'),'human:'+owner);
 assert.deepEqual(await redis('ZRANGE',`lm:${store.space}:coord:open:retired`,0,-1),[]);
});

test('queue accepts legacy scalar coverage without a wrong-type read or stale warning',async()=>{
 const redis=createMemoryRedis(),store=createStore(redis,{space:'legacy'});await redis('SET','lm:legacy:coord:coverage','full');
 const result=await coordinationQueue(store);assert.equal(result.coverage.complete,true);assert.deepEqual(result.coverage.notes,[]);
});
