// Human discussions and record actions. Canonical coordination indexing belongs to coord.mjs.
import {createHash,randomUUID} from 'node:crypto';
import {registerEvalScript} from '../lib/lua-scripts.mjs';
import {lmKey,checkAgentId} from '../core/keys.mjs';
import {PERSON_RE} from '../core/blockers.mjs';
import {getPlan} from '../core/plans.mjs';
import {findAsk} from '../core/tools.mjs';
import {revKey} from '../core/store.mjs';
export class InteractionError extends Error {constructor(status,message){super(message);this.name='InteractionError';this.status=status;}}
const fail=(status,message)=>{throw new InteractionError(status,message);};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const COORD=/^ci_[a-f0-9]{24}$/;
const parse=x=>{try{return JSON.parse(x);}catch{return null;}};
const hashObject=raw=>Array.isArray(raw)?Object.fromEntries(Array.from({length:raw.length/2},(_,i)=>[raw[i*2],raw[i*2+1]])):raw||{};
const journal=(s,t)=>`lm:${s}:discussion:${hash(t)}`;
const bounded=(v,def,max)=>v==null?def:Number.isInteger(Number(v))&&Number(v)>=0?Math.min(Number(v),max):fail(400,'Invalid page.');
export function normalizeTarget(t){
 if(!t||!['job','task','decision','plan','coord'].includes(t.type)||typeof t.id!=='string'||!ID.test(t.id)||(t.type==='coord'&&!COORD.test(t.id)))fail(400,'Invalid discussion target.');
 return {type:t.type,id:t.id};
}
async function loadTarget(store,input,{by,manager=false}={}){
 const target=normalizeTarget(input),{type,id}=target;
 let rec,key,owner='',where,watch,recordKind='string';
 if(type==='job'){
  rec=await store.getWho('job',id);const now=await store.getNow('job',id)||{};
  owner=now.owner||rec?.owner||'';where='job:'+id;key=lmKey(store.space,'job',id,'who');
 }else if(type==='task'){
  key=`lm:${store.space}:blocker:${id}`;rec=parse(await store.redis('GET',key));
  if(rec&&rec.trail!==id)rec=null;
  if(rec&&!manager&&![rec.to,rec.by].includes(by))fail(404,'Record unavailable.');
  owner=rec?.to||'';where=rec?.where;
 }else if(type==='plan'){
  rec=await getPlan(store,id);key=`lm:${store.space}:plan:${id}`;owner=rec?.owner||'';where='channel:plan-'+id;
 }else if(type==='decision'){
  const found=await findAsk(store,id);rec=found?.ask;where=found?.where;owner=rec?.to||rec?.by||'';
  key=`lm:${store.space}:ask:${id}`;
 }else{
  key=`lm:${store.space}:coord:item:${id}`;rec=hashObject(await store.redis('HGETALL',key));recordKind='hash';
  if(!rec?.id||rec.id!==id||rec.space!==store.space)rec=null;
  owner=rec?.to||'';where=rec?.where;
 }
 if(!rec)fail(404,'Record unavailable.');
 if(!/^(job|channel|agent):[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(where||''))fail(409,'Record has no valid source.');
 if(recordKind==='string')watch=[['',await store.redis('GET',key)]];
 else watch=['response','to','request_trail','last_nudge_at'].map(k=>[k,rec[k]??null]);
 return {target,rec,key,owner,where,watch,recordKind};
}

// All keys are explicit. Every validation runs before the first write.
export const INTERACTION_LUA=`
local old = redis.call('GET',KEYS[3])
if old then
 local receipt=cjson.decode(old)
 if receipt.fingerprint~=ARGV[1] then return {'conflict'} end
 return {'replay',old}
end
local watch=cjson.decode(ARGV[2])
for _,pair in ipairs(watch) do
 local got
 if ARGV[3]=='hash' then got=redis.call('HGET',KEYS[1],pair[1]) else got=redis.call('GET',KEYS[1]) end
 local want=pair[2]
 if want==cjson.null then want=false end
 if got~=want then return {'changed'} end
end
local count=redis.call('ZCARD',KEYS[2])
if count>=1000 then return {'limit'} end
local previous=redis.call('GET',KEYS[5])
if ARGV[4]=='nudge' and previous and tonumber(previous)+300000>tonumber(ARGV[5]) then return {'cooldown'} end
local rate=tonumber(redis.call('GET',KEYS[6]) or '0')
if rate>=30 then return {'rate'} end
local revision=redis.call('GET',KEYS[4])
if revision and (not tonumber(revision) or tonumber(revision)<0 or tonumber(revision)>9007199254740000) then return {'storage'} end
local receipt=cjson.decode(ARGV[6])
local fields=cjson.decode(ARGV[7])
if ARGV[3]=='hash' then
 for _,pair in ipairs(fields) do redis.call('HSET',KEYS[1],pair[1],pair[2]) end
elseif ARGV[8]~='' then redis.call('SET',KEYS[1],ARGV[8]) end
redis.call('ZADD',KEYS[2],ARGV[5],ARGV[9])
redis.call('SET',KEYS[3],ARGV[6],'EX',604800)
if ARGV[4]=='nudge' then redis.call('SET',KEYS[5],ARGV[5],'EX',300) end
redis.call('SET',KEYS[6],rate+1,'EX',60)
redis.call('INCR',KEYS[4])
return {'ok',ARGV[6]}
`;
registerEvalScript(INTERACTION_LUA,(call,k,a)=>{
 const old=call('GET',k[2]);if(old){if(parse(old).fingerprint!==a[0])return ['conflict'];return ['replay',old];}
 for(const[field,want]of parse(a[1])){const got=a[2]==='hash'?call('HGET',k[0],field):call('GET',k[0]);if((got??null)!==want)return ['changed'];}
 if(call('ZCARD',k[1])>=1000)return ['limit'];
 const prev=call('GET',k[4]);if(a[3]==='nudge'&&prev&&Number(prev)+300000>Number(a[4]))return ['cooldown'];
 const rate=Number(call('GET',k[5])||0);if(rate>=30)return ['rate'];
 const revision=call('GET',k[3]);if(revision!=null&&(!/^\d+$/.test(revision)||Number(revision)>9007199254740000))return ['storage'];
 if(a[2]==='hash'){for(const[f,v]of parse(a[6]))call('HSET',k[0],f,v);}else if(a[7])call('SET',k[0],a[7]);
 call('ZADD',k[1],a[4],a[8]);call('SET',k[2],a[5],'EX','604800');
 if(a[3]==='nudge')call('SET',k[4],a[4],'EX','300');
 call('SET',k[5],String(rate+1),'EX','60');call('INCR',k[3]);return ['ok',a[5]];
},{jail:true});

export async function discussion(store,target,options={}){
 const t=await loadTarget(store,target,options),cursor=bounded(options.cursor,0,1000),limit=Math.max(1,bounded(options.limit,30,100));
 const rows=await store.redis('ZREVRANGE',journal(store.space,t.target),cursor,cursor+limit);
 const entries=rows.slice(0,limit).map(parse).filter(Boolean);
 const writable=options.canWrite!==false;
 return {target:t.target,title:t.rec.title||t.rec.summary||t.target.id,owner:t.owner,entries,nextCursor:rows.length>limit?cursor+limit:null,canComment:writable,canReassign:!!options.manager&&['job','task'].includes(t.target.type)&&!t.rec.done,canNudge:writable&&t.target.type==='coord'&&t.rec.response==='open'};
}
async function deliver(store,receipt){
 for(const dest of receipt.destinations){const split=dest.indexOf(':');await store.append(dest.slice(0,split),dest.slice(split+1),receipt.entry);}
}
export async function interact(store,{target:input,action,text='',requestId,by,manager=false,to,expectedOwner,now=Date.now}){
 if(!PERSON_RE.test(String(by)))fail(403,'A verified person must make this change.');
 const target=normalizeTarget(input);
 if(!['comment','reassign','nudge'].includes(action)||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(requestId))fail(400,'Invalid action or request ID.');
 if(typeof text!=='string'||text.length>2000||((action==='comment'||action==='reassign')&&!text.trim()))fail(400,'Add a comment or reason, up to 2000 characters.');
 if(action==='reassign'&&!manager)fail(403,'Only a space manager can reassign work.');
 const fingerprint=hash({target,action,text:text.trim(),to:action==='reassign'?to:null,expectedOwner:action==='reassign'?expectedOwner:null});
 const receiptKey=`lm:${store.space}:interaction:request:${hash([by,requestId])}`;
 const old=parse(await store.redis('GET',receiptKey));
 if(old){if(old.fingerprint!==fingerprint)fail(409,'Request ID already names another change.');await loadTarget(store,target,{by,manager});try{await deliver(store,old);}catch{fail(503,'Saved. Notification pending. Retry to finish delivery.');}return {ok:true,replayed:true,entry:old.entry};}
 const t=await loadTarget(store,target,{by,manager}),at=now();let key=t.key,watch=t.watch,kind=t.recordKind,fields=[],replacement='',recipient;
 if(action==='reassign'){
  if(!['job','task'].includes(target.type))fail(400,'This record cannot be reassigned.');
  if(typeof expectedOwner!=='string'||t.owner!==expectedOwner)fail(409,'Owner changed. Reload before reassigning.');
  if(typeof to!=='string'||to===t.owner)fail(400,'Choose a different owner.');
  if(target.type==='task'&&!PERSON_RE.test(to))fail(400,'A human task needs a person.');
  if(target.type==='job'&&!PERSON_RE.test(to)){
   let id;try{id=checkAgentId(to);}catch{fail(400,'Choose a valid owner.');}
   if(!to.startsWith('agent:')||!await store.getWho('agent',id))fail(404,'Agent unavailable in this space.');
  }
  recipient=to;
  if(target.type==='task'){
   if(t.rec.done)fail(409,'This task is already closed.');replacement=JSON.stringify({...t.rec,to,updated_at:at,rev:(t.rec.rev||0)+1});
  }else{
   key=lmKey(store.space,'job',target.id,'now');kind='hash';watch=[];
   for(const f of ['owner','stage'])watch.push([f,await store.redis('HGET',key,f)]);
   if(parse(watch[0][1])!==t.owner&&!(watch[0][1]==null&&t.rec.owner===t.owner))fail(409,'Owner changed. Reload before reassigning.');
   if(parse(watch[1][1])==='done')fail(409,'This job is already done.');fields=[['owner',JSON.stringify(to)]];
  }
 }else if(action==='nudge'){
  if(target.type!=='coord')fail(400,'Choose a pending coordination item.');
  if(t.rec.response!=='open')fail(409,'This item already has an answer.');
  if(!Number.isFinite(Number(t.rec.deadline))||!Number.isFinite(Number(t.rec.created_at))||Number(t.rec.created_at)>at)fail(409,'This item has invalid timestamps.');
  try{recipient='agent:'+checkAgentId(t.rec.to);}catch{fail(409,'This item has no valid agent recipient.');}
  if(!await store.getWho('agent',recipient.slice(6)))fail(404,'Recipient unavailable in this space.');
  fields=[['last_nudge_at',String(at)]];
 }
 const entry={ts:at,kind:action==='nudge'?'ping':action==='reassign'?'assigned':'memo',by,via:'web',trail:'interaction-'+randomUUID(),origin:target.type==='coord'?t.rec.request_trail:['task','decision'].includes(target.type)?target.id:undefined,summary:action==='comment'?text.trim():action==='reassign'?`Reassigned from ${t.owner||'unassigned'} to ${to}: ${text.trim()}`:`Nudge: ${text.trim()||t.rec.summary}`,payload:{interaction:action,target,...(action==='reassign'?{from:t.owner,to}:{}),...(action==='nudge'?{nudge:true,item:target.id}:{})},...(recipient?{to:recipient}:{})};
 const receipt={fingerprint,entry,destinations:[...new Set([t.where,...(recipient?.startsWith('agent:')?[recipient]:[])])]};
 const result=await store.redis('EVAL',INTERACTION_LUA,6,key,journal(store.space,target),receiptKey,revKey(store.space),`lm:${store.space}:interaction:cooldown:${hash(target)}`,`lm:${store.space}:interaction:rate:${hash(by)}`,
 fingerprint,JSON.stringify(watch),kind,action,String(at),JSON.stringify(receipt),JSON.stringify(fields),replacement,JSON.stringify(entry));
 const [status,raw]=result;
 if(status==='conflict')fail(409,'Request ID already names another change.');
 if(status==='changed')fail(409,'Record changed. Reload before retrying.');
 if(status==='storage')fail(503,'Storage needs repair. No change was saved.');
 if(status==='limit')fail(429,'This discussion reached its 1000 entry limit.');
 if(status==='cooldown')fail(429,'This item was nudged recently. Wait five minutes between nudges.');
 if(status==='rate')fail(429,'Too many changes. Wait one minute.');
 const saved=parse(raw);try{await deliver(store,saved);}catch{fail(503,'Saved. Notification pending. Retry to finish delivery.');}
 return {ok:true,replayed:status==='replay',entry:saved.entry};
}
export async function coordinationQueue(store,{cursor,limit,recipient}={}){
 cursor=bounded(cursor,0,100000);limit=Math.max(1,bounded(limit,30,100));
 const coverage=hashObject(await store.redis('HGETALL',`lm:${store.space}:coord:coverage`));
 const index=recipient?`lm:${store.space}:coord:open:${checkAgentId(recipient)}`:`lm:${store.space}:coord:open`;
 const ids=await store.redis('ZRANGE',index,cursor,cursor+limit),items=[],errors=[];
 for(const id of ids.slice(0,limit)){
  if(!COORD.test(id)){errors.push('Invalid item identifier.');continue;}
  const rec=hashObject(await store.redis('HGETALL',`lm:${store.space}:coord:item:${id}`));
  if(rec?.id!==id||rec.space!==store.space||rec.response!=='open'){errors.push('An index entry has no matching pending record.');continue;}
  items.push(rec);
 }
 return {items,nextCursor:ids.length>limit?cursor+limit:null,coverage:{...coverage,complete:coverage?.status==='complete'&&errors.length===0,errors,notes:['This queue reads the canonical coordination index. Legacy records require verified backfill.']}};
}
