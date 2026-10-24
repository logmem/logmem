import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace,listSpaces} from '../src/http/workspaces.mjs';
import {createInvitation,acceptInvitation,revokeInvitation,inspectInvitation} from '../src/http/workspace-invites.mjs';
const owner='user_owner00000001',userId='user_teammate00001';
async function setup(){let clock=1000000;const redis=createMemoryRedis(),deps={redis,now:()=>clock};const a=await createWorkspace({userId:owner,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},deps);return {...a,deps,setClock:v=>clock=v};}
test('invitations bind verified email and exact space permissions, accept only once',async()=>{
 const {workspace:w,space:s,deps}=await setup();const invite=await createInvitation({actorId:owner,workspaceId:w.id,email:'Team@example.com',role:'member',spaces:{[s.id]:{role:'editor',canApprove:false}},requestId:'invite-001'},deps);
 await assert.rejects(acceptInvitation({userId,verifiedEmail:'wrong@example.com',token:invite.token},deps),{status:404});
 const a=await acceptInvitation({userId,verifiedEmail:'team@example.com',token:invite.token},deps);
 assert.equal(a.selected.spaceId,s.id);assert.equal((await listSpaces({userId,workspaceId:w.id},deps)).length,1);
 const b=await acceptInvitation({userId,verifiedEmail:'team@example.com',token:invite.token},deps);assert.equal(b.accepted,true);
 const serialized=JSON.stringify([...deps.redis._data.values()]);assert.ok(!serialized.includes(invite.token));
});
test('expired and revoked invitations cannot create memberships',async()=>{
 for(const expired of [false,true]){
 const {workspace:w,space:s,deps,setClock}=await setup();const invite=await createInvitation({actorId:owner,workspaceId:w.id,email:'team@example.com',role:'viewer',spaces:{[s.id]:{role:'viewer',canApprove:false}},requestId:'invite-001'},deps);
 if(expired)setClock(1000000+7*86400000);else await revokeInvitation({actorId:owner,workspaceId:w.id,invitationId:invite.id,requestId:'revoke-001'},deps);
 await assert.rejects(inspectInvitation({verifiedEmail:'team@example.com',token:invite.token},deps),{status:404});
 await assert.rejects(acceptInvitation({userId,verifiedEmail:'team@example.com',token:invite.token},deps),{status:404});
 }
});
test('invite quota is atomic and rejects invalid or escalated grants',async()=>{
 const {workspace:w,space:s,deps}=await setup();deps.limits={pendingInvitations:1};
 const r=await Promise.allSettled(Array.from({length:4},(_,i)=>createInvitation({actorId:owner,workspaceId:w.id,email:`team${i}@example.com`,role:'member',spaces:{[s.id]:{role:'editor',canApprove:false}},requestId:`invite-00${i}`},deps)));
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(createInvitation({actorId:owner,workspaceId:w.id,email:'other@example.com',role:'owner',spaces:{},requestId:'invite-999'},deps),{status:400});
});
