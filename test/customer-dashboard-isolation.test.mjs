import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/core/store.mjs';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace,createSpace,setMembership} from '../src/http/workspaces.mjs';
import {createCustomerDashboard} from '../src/http/customer-dashboard.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';
const userId='user_Customer00001',other='user_another000001';
const paths=['view','pulse','needs','scorecard','blockers','connections','agent-keys'];
async function setup(){const redis=createMemoryRedis();const a=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},{redis});return {redis,...a};}
test('all customer dashboard reads reject foreign contexts and anonymous callers',async()=>{
 const {redis,workspace:w,space:s}=await setup();
 for(const path of paths){
  const req=mockReq({url:`/api/${path}?workspaceId=${w.id}&spaceId=${s.id}`,headers:{'x-logmem-viewer':'customer'}});
  let res=mockRes();await createCustomerDashboard({redis,session:async()=>({status:'signed-out'})})(req,res);assert.equal(res.statusCode,401,path);
  res=mockRes();await createCustomerDashboard({redis,session:async()=>({status:'signed-in',userId:other})})(req,res);assert.equal(res.statusCode,404,path);
 }
});
test('authorized home and human writes use only selected space and actual identity',async()=>{
 const {redis,workspace:w,space:s}=await setup(),deps={redis,session:async()=>({status:'signed-in',userId})};
 const h=createCustomerDashboard(deps);await createStore(redis,{space:s.namespace}).setWho('job','first-job',{title:'First job'});
 let res=mockRes();await h(mockReq({url:`/api/view?workspaceId=${w.id}&spaceId=${s.id}&what=home`,headers:{'x-logmem-viewer':'customer'}}),res);assert.equal(res.statusCode,200,res.body);
 res=mockRes();await h(mockReq({method:'POST',url:'/api/tasks',headers:{origin:'https://logmem.test','x-logmem-intent':'blockers','x-logmem-viewer':'customer'},body:{workspaceId:w.id,spaceId:s.id,action:'write',job:'first-job',summary:'Check this work',walkthrough:{steps:[{title:'Read the result'}]},by:'human:forged'}}),res);
 assert.equal(res.statusCode,200,res.body);assert.ok(res.body.includes(`human:${userId}`));assert.ok(!res.body.includes('human:forged'));
});
test('viewer role cannot write or approve and sibling access stays private',async()=>{
 const {redis,workspace:w,space:s}=await setup();
 await setMembership({actorId:userId,workspaceId:w.id,userId:other,role:'viewer',spaces:{[s.id]:{role:'viewer',canApprove:false}},requestId:'member-001'},{redis});
 const b=await createSpace({userId,workspaceId:w.id,name:'Private',requestId:'space-002'},{redis});
 const h=createCustomerDashboard({redis,session:async()=>({status:'signed-in',userId:other})});
 for(const path of ['nudge','decide','tasks','agent-keys','connections']){
 const res=mockRes();await h(mockReq({method:'POST',url:`/api/${path}`,headers:{origin:'https://logmem.test','x-logmem-intent':'work'},body:{workspaceId:w.id,spaceId:s.id}}),res);assert.equal(res.statusCode,403,path);
 }
 const res=mockRes();await h(mockReq({url:`/api/view?workspaceId=${w.id}&spaceId=${b.space.id}&what=home`}),res);assert.equal(res.statusCode,404);
});
