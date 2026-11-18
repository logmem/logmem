// Activity reads /api/view?what=log. A customer sees only the space they are authorized for.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/core/store.mjs';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace} from '../src/http/workspaces.mjs';
import {createCustomerDashboard} from '../src/http/customer-dashboard.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';

const mine='user_Customer00001',theirs='user_another000001';
test('customer log view is scoped to the authorized space only',async()=>{
 const redis=createMemoryRedis();
 const a=await createWorkspace({userId:mine,name:'Mine',firstSpaceName:'Ops',requestId:'create-mine-01'},{redis});
 const b=await createWorkspace({userId:theirs,name:'Theirs',firstSpaceName:'Ops',requestId:'create-theirs-1'},{redis});
 await createStore(redis,{space:a.space.namespace}).append('channel','general',{ts:Date.now()-1000,kind:'memo',by:'agent:atlas',summary:'MINE-ENTRY photos land Thu.'});
 await createStore(redis,{space:b.space.namespace}).append('channel','general',{ts:Date.now()-1000,kind:'memo',by:'agent:spy',summary:'THEIRS-ENTRY private plan.'});
 const h=createCustomerDashboard({redis,session:async()=>({status:'signed-in',userId:mine})});
 const get=async url=>{const res=mockRes();await h(mockReq({url,headers:{'x-logmem-viewer':'customer'}}),res);return res;};
 let res=await get(`/api/view?workspaceId=${a.workspace.id}&spaceId=${a.space.id}&what=log`);
 assert.equal(res.statusCode,200,res.body);
 const body=JSON.parse(res.body);
 assert.equal(body.space,a.space.namespace);
 assert.deepEqual(body.spaces,[a.space.namespace]);
 assert.ok(res.body.includes('MINE-ENTRY'));
 assert.ok(!res.body.includes('THEIRS-ENTRY'));
 // A forged space id for another workspace is refused, not served.
 res=await get(`/api/view?workspaceId=${b.workspace.id}&spaceId=${b.space.id}&what=log`);
 assert.equal(res.statusCode,404);
 assert.ok(!res.body.includes('THEIRS-ENTRY'));
 // A mixed pair (own workspace, foreign space) is refused too.
 res=await get(`/api/view?workspaceId=${a.workspace.id}&spaceId=${b.space.id}&what=log`);
 assert.notEqual(res.statusCode,200);
 assert.ok(!res.body.includes('THEIRS-ENTRY'));
});
test('anonymous callers cannot read the log',async()=>{
 const redis=createMemoryRedis();
 const a=await createWorkspace({userId:mine,name:'Mine',firstSpaceName:'Ops',requestId:'create-mine-02'},{redis});
 const res=mockRes();
 await createCustomerDashboard({redis,session:async()=>({status:'signed-out'})})(mockReq({url:`/api/view?workspaceId=${a.workspace.id}&spaceId=${a.space.id}&what=log`,headers:{'x-logmem-viewer':'customer'}}),res);
 assert.equal(res.statusCode,401);
});
