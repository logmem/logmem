import {randomBytes} from 'node:crypto';
import {customerRedis} from './jail.mjs';
import {checkAgentId} from '../core/keys.mjs';
import {isSuspendedSafe} from './admin-roles.mjs';
import {readWorkspace,accessPolicy,commitWorkspace,digest,failWorkspace,WorkspaceError,requestKey,replay} from './workspaces.mjs';
export async function createWorkspaceAgentKey({userId,workspaceId,spaceId,agent,label='',requestId},deps) {
 agent=checkAgentId(agent);if(typeof label!=='string'||label.length>80)failWorkspace('invalid_label');
 for(let i=0;i<12;i++) {
  const {w}=await readWorkspace(deps.redis,workspaceId);accessPolicy(w,userId,spaceId,'manage-connections');
  if(Object.values(w.connections||{}).filter(x=>!x.revoked).length>=20)failWorkspace('connection_limit',429);
  const at=(deps.now||Date.now)(),attempts=(w.keyAttempts?.[userId]||[]).filter(t=>t>at-3600000);
  if(attempts.length>=20)failWorkspace('connection_rate_limit',429);
  const key=`lmw_${randomBytes(32).toString('base64url')}`,hash=digest(key),id=`wk_${randomBytes(12).toString('hex')}`;
  const rec={id,spaceId,namespace:w.spaces[spaceId].namespace,agent,label,issuedBy:userId,created_at:(deps.now||Date.now)(),hash};
  const next=structuredClone(w);next.version++;next.keyAttempts={...next.keyAttempts,[userId]:[...attempts,at]};next.connections={...next.connections,[id]:rec};next.audit.push({kind:'agent-key-created',id,by:`human:${userId}`,at:rec.created_at});
  const r=await commitWorkspace({before:w,after:next,userId,requestId,operation:'agent-key',fingerprint:digest({workspaceId,spaceId,agent,label}),result:{id,space:rec.namespace,spaceId,agent,label,created_at:rec.created_at}},deps);
  if(r){if(r.created) {await deps.redis('SET',`lm:workspace:key:${hash}`,JSON.stringify({workspaceId,id}));return {...r,key};}return r;}
 }
 failWorkspace('update_conflict',409);
}
export async function lookupWorkspaceAgentKey(key,deps={}) {
 if(!/^lmw_[A-Za-z0-9_-]{43}$/.test(String(key)))return null;
 const redis=deps.redis||customerRedis(),hash=digest(key);
 const raw=await redis('GET',`lm:workspace:key:${hash}`);if(!raw)return null;
 try{
  const {workspaceId,id}=JSON.parse(raw),{w}=await readWorkspace(redis,workspaceId),c=w.connections?.[id];
  if(!c||c.hash!==hash||c.revoked)return null;
 if(c.issuedBy && await isSuspendedSafe(c.issuedBy,redis))return null;
  accessPolicy(w,c.issuedBy,c.spaceId,'manage-connections');
  return {id,workspaceId,spaceId:c.spaceId,tenant:w.tenantId,space:c.namespace,agent:c.agent,issuedBy:c.issuedBy};
 }catch(e){if(e instanceof WorkspaceError)return null;throw e;}
}
export async function revokeWorkspaceAgentKey({userId,workspaceId,spaceId,id,requestId},deps) {
 for(let i=0;i<12;i++) {
  const {w}=await readWorkspace(deps.redis,workspaceId);accessPolicy(w,userId,spaceId,'manage-connections');
  const previous=await replay(deps.redis,requestKey(userId,'revoke-key',requestId),digest({workspaceId,spaceId,id}));if(previous)return previous;
  const c=w.connections?.[id];
 if(!c||c.spaceId!==spaceId)failWorkspace('not_found',404);
  const next=structuredClone(w);next.version++;delete next.connections[id];next.audit.push({kind:'agent-key-revoked',id,by:`human:${userId}`,at:(deps.now||Date.now)()});
  const r=await commitWorkspace({before:w,after:next,userId,requestId,operation:'revoke-key',fingerprint:digest({workspaceId,spaceId,id}),result:{revoked:true}},deps);if(r)return r;
 }
 failWorkspace('update_conflict',409);
}
export async function listWorkspaceAgentKeys({userId,workspaceId,spaceId},deps) {
 const {w}=await readWorkspace(deps.redis,workspaceId);accessPolicy(w,userId,spaceId,'manage-connections');
 return Object.values(w.connections||{}).filter(c=>c.spaceId===spaceId&&!c.revoked).map(({hash,...rec})=>rec);
}

/** Recheck immutable OAuth scope at code exchange, refresh, and access. */
export async function workspaceGrantActive(record,deps={}) {
 const g=record?.backend;if(!g?.workspaceId)return true;
 try {
  const redis=deps.redis||customerRedis();const {w}=await readWorkspace(redis,g.workspaceId);
  accessPolicy(w,g.issuedBy,g.spaceId,'manage-connections');
  return w.tenantId===g.tenant&&w.spaces[g.spaceId].namespace===record.space;
 } catch(e){if(e instanceof WorkspaceError)return false;throw e;}
}
