// Workspace control plane. Never expose this runner to a customer data store.
import { randomBytes, createHash } from 'node:crypto';
import { registerEvalScript } from '../lib/lua-scripts.mjs';

export class WorkspaceError extends Error {
  constructor(code, status=400) { super(code); this.code=code; this.status=status; }
}
export const failWorkspace = (code, status=400) => { throw new WorkspaceError(code,status); };
export const workspaceKey = id => `lm:workspace:record:${id}`;
export const validUser = id => typeof id==='string' && /^user_[A-Za-z0-9]{10,64}$/.test(id);
export const validWorkspace = id => typeof id==='string' && /^[a-z][a-z0-9-]{2,30}$/.test(id);
const id = () => randomBytes(12).toString('hex');
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const userKey = u => `lm:workspace:user:${u}`;
const ownedKey = u => `lm:workspace:owned:${u}`;
export const cleanName = n => {
  if (typeof n!=='string' || /[\x00-\x1f\x7f]/.test(n) || !n.trim() || n.trim().length>80) failWorkspace('invalid_name');
  return n.trim();
};
export function checkUser(u) { if (!validUser(u)) failWorkspace('invalid_user'); }
export function requestKey(u, operation, requestId) {
  checkUser(u);
  if(typeof requestId!=='string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) failWorkspace('invalid_request_id');
  return `lm:workspace:request:${u}:${operation}:${digest(requestId)}`;
}
// One CAS owns the record, indexes, quota reservation, tenant creation and replay result.
const COMMIT = `
local replay = redis.call('GET', KEYS[4])
if replay then
 local r = cjson.decode(replay)
 if r.digest ~= ARGV[3] then return {'conflict',''} end
 return {'replay', r.result}
end
local old = redis.call('GET', KEYS[1]) or ''
if old ~= ARGV[1] then return {'retry',''} end
local fresh = ARGV[1] == ''
local status = redis.call('HGET', KEYS[5], 'status')
if not fresh and status ~= 'active' then return {'inactive',''} end
if fresh then
 if redis.call('EXISTS', KEYS[5]) == 1 then return {'collision',''} end
 if redis.call('SCARD', KEYS[3]) >= tonumber(ARGV[5]) then return {'quota',''} end
 local w = cjson.decode(ARGV[2])
 redis.call('HSET', KEYS[5], 'id', w.tenantId, 'name', w.name, 'plan', 'free', 'status', 'active', 'created_at', tostring(w.createdAt), 'namespace', 't-' .. w.tenantId, 'key_ids', '[]')
 redis.call('SADD', KEYS[6], w.tenantId)
end
redis.call('SET', KEYS[1], ARGV[2])
local flags = cjson.decode(ARGV[6])
for i, f in ipairs(flags) do
 local k = 6 + (i-1)*2
 if f.member then redis.call('SADD', KEYS[k+1], ARGV[7]) else redis.call('SREM', KEYS[k+1], ARGV[7]) end
 if f.owner then redis.call('SADD', KEYS[k+2], ARGV[7]) else redis.call('SREM', KEYS[k+2], ARGV[7]) end
end
redis.call('SET', KEYS[4], cjson.encode({digest=ARGV[3],result=ARGV[4]}))
return {'ok', ARGV[4]}
`;
registerEvalScript(COMMIT,(call,keys,a)=>{
  const replay=call('GET',keys[3]);
  if(replay) { const r=JSON.parse(replay); return r.digest===a[2]?['replay',r.result]:['conflict','']; }
  if((call('GET',keys[0])||'')!==a[0]) return ['retry',''];
  if(a[0] && call('HGET',keys[4],'status')!=='active') return ['inactive',''];
  if(!a[0]) {
    if(call('EXISTS',keys[4])) return ['collision',''];
    if(call('SCARD',keys[2])>=Number(a[4])) return ['quota',''];
    const w=JSON.parse(a[1]);
    call('HSET',keys[4],'id',w.tenantId,'name',w.name,'plan','free','status','active','created_at',String(w.createdAt),'namespace',`t-${w.tenantId}`,'key_ids','[]');
    call('SADD',keys[5],w.tenantId);
  }
  call('SET',keys[0],a[1]);
  JSON.parse(a[5]).forEach((f,i)=>{
    call(f.member?'SADD':'SREM',keys[6+i*2],a[6]);
    call(f.owner?'SADD':'SREM',keys[7+i*2],a[6]);
  });
  call('SET',keys[3],JSON.stringify({digest:a[2],result:a[3]}));
  return ['ok',a[3]];
});

export async function readWorkspace(redis, workspaceId) {
  if(!validWorkspace(workspaceId)) failWorkspace('not_found',404);
  const raw=await redis('GET',workspaceKey(workspaceId));
  if(!raw) failWorkspace('not_found',404);
  let w; try {w=JSON.parse(raw);} catch { failWorkspace('not_found',404); }
  if(w.id!==workspaceId || w.status!=='active' || await redis('HGET',`acmi:cloud:tenant:${w.tenantId}`,'status')!=='active' || await redis('HGET',`acmi:cloud:tenant:${w.tenantId}`,'deleted_at')) failWorkspace('not_found',404);
  return {w,raw};
}
export function membership(w,u) {
  const m=w.members?.[u];
  if(!m || m.status!=='active') failWorkspace('not_found',404);
  return m;
}
export function canManage(w,u) {return ['owner','admin'].includes(membership(w,u).role);}
export function spaceSummary(w,s) {return {...s, permissions:undefined};}
export function visibleSpaces(w,u) {
 const m=membership(w,u);
 return Object.values(w.spaces).filter(s=>s.status==='active' && (['owner','admin'].includes(m.role) || m.spaces?.[s.id]));
}
export function summary(w) {const {members,spaces,audit,...out}=w; return out;}
export async function commitWorkspace({before,after,userId,requestId,operation,fingerprint,result},deps) {
  const users=[...new Set([...Object.keys(before?.members||{}),...Object.keys(after.members)])];
  const keys=[workspaceKey(after.id),userKey(userId),ownedKey(userId),requestKey(userId,operation,requestId),`acmi:cloud:tenant:${after.tenantId}`,'acmi:cloud:tenants'];
  const flags=users.map(u=>{keys.push(userKey(u),ownedKey(u)); const m=after.members[u]; return {member:m?.status==='active',owner:m?.status==='active'&&m.role==='owner'};});
  const response=await deps.redis('EVAL',COMMIT,keys.length,...keys,before?JSON.stringify(before):'',JSON.stringify(after),fingerprint,JSON.stringify(result),String(deps.limits?.ownedWorkspaces??3),JSON.stringify(flags),after.id);
  const [status,payload]=response;
  if(status==='conflict') failWorkspace('idempotency_conflict',409);
  if(status==='quota') failWorkspace('workspace_limit',429);
  if(status==='inactive') failWorkspace('not_found',404);
  if(status==='retry'||status==='collision') return null;
  return {...JSON.parse(payload),created:status==='ok'};
}
async function replay(redis,key,fingerprint) {
 const raw=await redis('GET',key); if(!raw) return null;
 const r=JSON.parse(raw); if(r.digest!==fingerprint) failWorkspace('idempotency_conflict',409);
 return {...JSON.parse(r.result),created:false};
}
export async function createWorkspace({userId,name,firstSpaceName,requestId},deps) {
 checkUser(userId); name=cleanName(name); firstSpaceName=cleanName(firstSpaceName);
 const key=requestKey(userId,'create',requestId), fingerprint=digest({name,firstSpaceName});
 const prior=await replay(deps.redis,key,fingerprint); if(prior) {await readWorkspace(deps.redis,prior.workspace.id); return prior;}
 for(let retry=0;retry<12;retry++) {
  const newId=deps.newId||id, workspaceId=`w${newId()}`, spaceId=newId(), now=(deps.now||Date.now)();
  const space={id:spaceId,workspaceId,namespace:`s-${spaceId}`,name:firstSpaceName,status:'active',createdAt:now};
  const w={id:workspaceId,tenantId:workspaceId,name,status:'active',createdAt:now,version:1,members:{[userId]:{role:'owner',status:'active',spaces:{[spaceId]:{role:'editor',canApprove:true}}}},spaces:{[spaceId]:space},audit:[{kind:'workspace-created',by:`human:${userId}`,at:now}]};
  const r=await commitWorkspace({after:w,userId,requestId,operation:'create',fingerprint,result:{workspace:w,space}},deps); if(r) return r;
 }
 failWorkspace('creation_conflict',409);
}
export async function createSpace({userId,workspaceId,name,requestId},deps) {
 checkUser(userId); name=cleanName(name); const fingerprint=digest({workspaceId,name});
 const key=requestKey(userId,'space',requestId);
 for(let retry=0;retry<20;retry++) {
  const {w}=await readWorkspace(deps.redis,workspaceId), m=membership(w,userId);
  if(!['owner','admin','member'].includes(m.role)) failWorkspace('forbidden',403);
  const prior=await replay(deps.redis,key,fingerprint); if(prior)return prior;
  if(Object.values(w.spaces).filter(s=>s.status==='active').length>=(deps.limits?.spaces??10)) failWorkspace('space_limit',429);
  const spaceId=(deps.newId||id)(), now=(deps.now||Date.now)();
  const space={id:spaceId,workspaceId,namespace:`s-${spaceId}`,name,status:'active',createdAt:now};
  const next=structuredClone(w); next.spaces[spaceId]=space; next.version++;
  next.members[userId].spaces[spaceId]={role:'editor',canApprove:true};
  next.audit.push({kind:'space-created',spaceId,by:`human:${userId}`,at:now});
  const r=await commitWorkspace({before:w,after:next,userId,requestId,operation:'space',fingerprint,result:{space}},deps); if(r)return r;
 }
 failWorkspace('update_conflict',409);
}
export async function listWorkspaces({userId},deps) {
 checkUser(userId); const out=[];
 for(const workspaceId of await deps.redis('SMEMBERS',userKey(userId))||[]) {
  try {const {w}=await readWorkspace(deps.redis,workspaceId); membership(w,userId); out.push({...summary(w),role:w.members[userId].role});} catch(e) {if(!(e instanceof WorkspaceError))throw e;}
 }
 return out;
}
export async function listSpaces({userId,workspaceId},deps) {
 checkUser(userId); const {w}=await readWorkspace(deps.redis,workspaceId); return visibleSpaces(w,userId);
}
