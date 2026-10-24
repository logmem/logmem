import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace,createSpace,removeMembership,setMembership} from '../src/http/workspaces.mjs';
import {createWorkspaceAgentKey,lookupWorkspaceAgentKey,revokeWorkspaceAgentKey} from '../src/http/workspace-agent-keys.mjs';
const userId='user_Customer00001';
test('workspace agent keys bind one immutable space and issuer, and revoke immediately',async()=>{
 const redis=createMemoryRedis(),deps={redis};const {workspace:w,space:s}=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},deps);
 const key=await createWorkspaceAgentKey({userId,workspaceId:w.id,spaceId:s.id,agent:'codex',label:'CLI',requestId:'agent-key-001'},deps);
 assert.match(key.key,/^lmw_/);
 const resolved=await lookupWorkspaceAgentKey(key.key,deps);assert.equal(resolved.space,s.namespace);assert.equal(resolved.workspaceId,w.id);
 const b=await createSpace({userId,workspaceId:w.id,name:'Private',requestId:'space-002'},deps);assert.notEqual(resolved.space,b.space.namespace);
 await revokeWorkspaceAgentKey({userId,workspaceId:w.id,spaceId:s.id,id:key.id,requestId:'revoke-key-01'},deps);
 assert.equal(await lookupWorkspaceAgentKey(key.key,deps),null);
});
test('removing an issuing manager invalidates their grants',async()=>{
 const redis=createMemoryRedis(),deps={redis},admin='user_manager000001';const {workspace:w,space:s}=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},deps);
 await setMembership({actorId:userId,workspaceId:w.id,userId:admin,role:'admin',spaces:{},requestId:'member-001'},deps);
 const k=await createWorkspaceAgentKey({userId:admin,workspaceId:w.id,spaceId:s.id,agent:'codex',requestId:'agent-key-001'},deps);
 await removeMembership({actorId:userId,workspaceId:w.id,userId:admin,requestId:'remove-001'},deps);
 assert.equal(await lookupWorkspaceAgentKey(k.key,deps),null);
});
test('workspace keys resolve as managed MCP credentials and cannot write a sibling space',async()=>{
 const {resolveAuth}=await import('../src/http/auth.mjs');const {buildManaged}=await import('../api/mcp.mjs');
 const redis=createMemoryRedis(),deps={redis};const {workspace:w,space:s}=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},deps);
 const k=await createWorkspaceAgentKey({userId,workspaceId:w.id,spaceId:s.id,agent:'codex',requestId:'agent-key-001'},deps);
 const auth=await resolveAuth({headers:{authorization:`Bearer ${k.key}`}}, {}, {VERCEL_ENV:'production',LOGMEM_CUSTOMER_REDIS_URI:'rediss://test:pass@203.0.113.9:6380'}, {lookupWorkspaceAgentKey:key=>lookupWorkspaceAgentKey(key,deps)});
 assert.equal(auth.source,'managed');assert.equal(auth.space,s.namespace);assert.equal(auth.issuedBy,userId);
 const lm=await buildManaged({redis,auth,sessionId:'test-session'});
 const start=await lm.callTool('logmem_start',{agent:'codex'});assert.equal(start.structuredContent.ok,true);
 const result=await lm.callTool('logmem_update',{job:'test-job',summary:'Created in selected space'});assert.equal(result.structuredContent.ok,true);
 assert.equal(await redis('EXISTS',`lm:t-${w.id}:job:test-job:log`),0);
});
test('OAuth consent lists authorized workspace spaces and issues the selected immutable grant',async()=>{
 const {oauthRedis,withEnv,mockReq,mockRes,callbackOf,TEST_KEK_HEX}=await import('./oauth-helpers.mjs');
 const {__setRedisForTests,registerClient,consumeAuthCode}=await import('../api/oauth/_lib/storage.mjs');
 const {default:authorize,__setManagedDepsForTests}=await import('../api/oauth/authorize.mjs');
 const redis=oauthRedis();
 await withEnv({LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_MANAGED:'1',LOGMEM_OAUTH_KEK:TEST_KEK_HEX,VERCEL_ENV:undefined},async()=>{
 try{
 __setRedisForTests(redis);__setManagedDepsForTests({ready:()=>true,redis:()=>redis,session:async()=>({status:'signed-in',userId,email:'a@example.com'})});
 const {workspace:w,space:s}=await createWorkspace({userId,name:'Real business',firstSpaceName:'Ops',requestId:'create-001'},{redis});
 const c=await registerClient({client_name:'Codex',redirect_uris:['https://app.example/cb'],token_endpoint_auth_method:'none'});
 const query={response_type:'code',client_id:c.client_id,redirect_uri:'https://app.example/cb',code_challenge:'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',code_challenge_method:'S256',state:'test',scope:'mcp'};
 const get=mockRes();await authorize(mockReq({url:'/api/oauth/authorize?'+new URLSearchParams(query)}),get);
 assert.equal(get.statusCode,200);assert.match(get.body,/Real business/);assert.match(get.body,/spaceChoice/);
 const cookie=String(get.getHeader('set-cookie')).split(';')[0],csrf=String(get.body).match(/name="csrf_token" value="([^"]+)"/)[1];
 const post=mockRes();await authorize(mockReq({method:'POST',url:'/api/oauth/authorize',headers:{cookie},body:{...query,action:'approve',csrf_token:csrf,spaceChoice:`${w.id}/${s.id}`}}),post);
 assert.equal(post.statusCode,200,post.body);
 const record=await consumeAuthCode(callbackOf(post).searchParams.get('code'));
 assert.equal(record.space,s.namespace);assert.equal(record.backend.workspaceId,w.id);assert.equal(record.backend.issuedBy,userId);
 assert.equal(await redis('GET',`lm:account:clerk:${userId}`),null,'workspace OAuth must not provision an extra legacy account');
 }finally{__setManagedDepsForTests(null);__setRedisForTests(null);}
 });
});
test('OAuth exchange and refresh policy refuses grants after issuer removal',async()=>{
 const {workspaceGrantActive}=await import('../src/http/workspace-agent-keys.mjs');
 const redis=createMemoryRedis(),deps={redis},manager='user_manager000001';
 const {workspace:w,space:s}=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},deps);
 await setMembership({actorId:userId,workspaceId:w.id,userId:manager,role:'admin',spaces:{},requestId:'member-001'},deps);
 const rec={space:s.namespace,backend:{kind:'managed',tenant:w.tenantId,workspaceId:w.id,spaceId:s.id,issuedBy:manager}};
 assert.equal(await workspaceGrantActive(rec,deps),true);
 await removeMembership({actorId:userId,workspaceId:w.id,userId:manager,requestId:'remove-001'},deps);
 assert.equal(await workspaceGrantActive(rec,deps),false);
 assert.equal(await workspaceGrantActive({space:'t-legacy',backend:{kind:'managed',tenant:'legacy'}},deps),true);
});
