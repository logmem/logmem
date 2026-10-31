import { listManagedApps, revokeManagedApp } from '../../api/oauth/_lib/storage.mjs';
// One customer boundary shared by every browser data route.
import {resolveViewer} from './viewer.mjs';
import {customerRequest,requestUrl,requireIntent,jsonBody,customerError} from './customer-http.mjs';
import {WorkspaceError,authorizeSpace} from './workspaces.mjs';
import {createWorkspaceAgentKey,listWorkspaceAgentKeys,revokeWorkspaceAgentKey} from './workspace-agent-keys.mjs';
import {buildView,needsView} from './view.mjs';
import {webStore} from './web-store.mjs';
import {isSuspendedSafe} from './admin-roles.mjs';
import {revKey} from '../core/store.mjs';
import {nudge,unblock,lane,confirmDone,keepOpen} from './work.mjs';
import {writeDecision} from '../core/tools.mjs';
import {listBlockers,getBlocker,setStep,markDone,cantDo,writeWalkthrough,JOB_ID_RE} from '../core/blockers.mjs';
import {buildScorecard} from '../../api/scorecard.mjs';
import {randomBytes} from 'node:crypto';

export function createCustomerDashboard(deps={}) {return async(req,res)=>{
// Phase A: a suspended account stops at the front door of the dashboard.
 res.setHeader('Cache-Control','no-store');
 try {
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'method_not_allowed'});
  const u=requestUrl(req),b=req.method==='POST'?jsonBody(req):{},q=Object.fromEntries(u.searchParams);
  const path=u.pathname.startsWith('/api/inbox/')?'inbox':u.pathname.split('/').filter(Boolean).at(-1),op=q.op||({pulse:'pulse',needs:'needs',nudge:'nudge',unblock:'unblock',lane:'lane','confirm-done':'confirm_done','keep-open':'keep_open','create-job':'create_job'}[path]);
  const manager=['connections','agent-keys'].includes(path);
  const action=manager?'manage-connections':path==='decide'?'approve':req.method==='GET'?'read':'write';
  const v=await resolveViewer(req,{workspaceId:b.workspaceId||q.workspaceId,spaceId:b.spaceId||q.spaceId,action},deps);
  const env=deps.env||process.env,space=v.namespace,store=webStore(v.redis,space,{...env,LOGMEM_MIRROR_ACMI:''}),opts={by:v.person};
 if(v.person && await isSuspendedSafe(v.person, deps.redis||await import('./jail.mjs').then(m=>m.customerRedis(env))))throw new WorkspaceError('account_suspended',403);
  const result=data=>res.status(200).json({space,workspaceId:v.workspaceId,spaceId:v.spaceId,person:v.person,permissions:v.permissions,...data});
  if(req.method==='GET') {
   if(path==='view')return result({ok:true,spaces:[space],generated_at:Date.now(),...await buildView(v.redis,space,q.what||'home',{...q,person:v.person})});
   if(op==='pulse')return result({rev:Number(await v.redis('GET',revKey(space))||0)});
   if(op==='needs')return result(await needsView(store,v.redis,space,{person:v.person,secret:env.LOGMEM_DECIDE_SECRET}));
   if(path==='scorecard')return result(await buildScorecard(v.redis,space));
   if(path==='blockers'||path==='tasks') {
    if(q.trail){const blocker=await getBlocker(store,q.trail);if(!blocker||(blocker.to!==v.person&&blocker.by!==v.person))throw new WorkspaceError('not_found',404);return result({blocker});}
    return result({blockers:(await listBlockers(store)).filter(x=>x.to===v.person||x.by===v.person)});
   }
   if(manager){const apps=await listManagedApps(v.workspace.tenantId).catch(()=>null);return result({keys:await listWorkspaceAgentKeys({userId:v.userId,workspaceId:v.workspaceId,spaceId:v.spaceId},{redis:deps.redis||await import('./jail.mjs').then(m=>m.customerRedis(env))}),apps:apps?apps.filter(a=>a.workspaceId===v.workspaceId&&a.spaceId===v.spaceId).map(a=>({fid:a.fid,app:a.client_name||'App',agent:a.agent,space:a.space,created_at:a.created_at})):[],oauthAvailable:apps!==null});}
   throw new WorkspaceError('not_found',404);
  }
  const expected=manager?(path==='connections'?'connections':'agent-keys'):path==='decide'?'decide':(path==='tasks'||path==='blockers')?'blockers':path==='inbox'?'inbox':'work';
  requireIntent(req,expected);await v.revalidate();
  if(manager) {
   const redis=deps.redis||await import('./jail.mjs').then(m=>m.customerRedis(env));
   const input={...b,userId:v.userId,workspaceId:v.workspaceId,spaceId:v.spaceId};
   if(b.action==='disconnect'&&b.fid){const apps=await listManagedApps(v.workspace.tenantId);if(!apps.some(a=>a.fid===b.fid&&a.workspaceId===v.workspaceId&&a.spaceId===v.spaceId))throw new WorkspaceError('not_found',404);await v.revalidate();return result({disconnected:!!await revokeManagedApp(v.workspace.tenantId,b.fid)});}
   if(b.action==='revoke'||b.action==='disconnect')return result(await revokeWorkspaceAgentKey({...input,id:b.id||b.fid},{redis}));
   return result(await createWorkspaceAgentKey(input,{redis}));
  }
  if(path==='inbox') {
   const agent=u.pathname.split('/').at(-1);
   const {checkAgentId}=await import('../core/keys.mjs'); checkAgentId(agent);
   if(typeof b.summary!=='string'||!b.summary.trim()||b.summary.length>280)throw new WorkspaceError('invalid_summary');
   if(!await store.getWho('agent',agent))throw new WorkspaceError('not_found',404);
   const entry=await store.append('agent',agent,{ts:Date.now(),kind:'handoff',by:v.person,to:`agent:${agent}`,summary:b.summary,via:'inbox',trail:`inbox-${randomBytes(12).toString('hex')}`});
   return result({ok:true,entry});
  }
  if(path==='decide')return res.status(201).json({ok:true,space,...await writeDecision(store,b.trail,{...opts,verdict:b.verdict,note:b.note,confirm:b.confirm==='approve',expectedHash:b.expected_hash,reclaim:true,via:'web'})});
  if(path==='blockers'||path==='tasks') {
   const trail=String(b.trail||'');
   if(b.action!=='write'){const old=await getBlocker(store,trail);if(!old||old.to!==v.person)throw new WorkspaceError('not_found',404);}
   if(b.action==='step')return result({ok:true,blocker:await setStep(store,trail,{...opts,step:b.step,checked:b.checked===true,rev:b.rev})});
   if(b.action==='done')return result({ok:true,blocker:await markDone(store,trail,{...opts,note:b.note})});
   if(b.action==='cant_do')return result({ok:true,blocker:await cantDo(store,trail,{...opts,reason:b.reason})});
   if(b.action==='write'&&b.to&&b.to!==v.person)await authorizeSpace({userId:String(b.to).replace(/^human:/,''),workspaceId:v.workspaceId,spaceId:v.spaceId,action:'read'},{redis:deps.redis||await import('./jail.mjs').then(m=>m.customerRedis(env))});
   if(b.action==='write')return result({ok:true,blocker:await writeWalkthrough(store,{...opts,job:b.job,to:b.to||v.person,summary:b.summary,walkthrough:b.walkthrough,trail:b.trail,mint:(job,t)=>`walkthrough-${job}-${t}-${randomBytes(6).toString('hex')}`})});
   throw new WorkspaceError('invalid_action');
  }
  const work={nudge,unblock,lane,confirm_done:confirmDone,keep_open:keepOpen};
  if(work[op])return result(await work[op](store,{...b,...opts}));
  if(op==='create_job') {
   if(!JOB_ID_RE.test(b.job||'')||typeof b.title!=='string'||!b.title.trim()||b.title.length>120)throw new WorkspaceError('invalid_job');
   if(await store.getWho('job',b.job))throw new WorkspaceError('job_exists',409);
   await store.setWho('job',b.job,{title:b.title.trim(),plan:'general',created_by:v.person,created_at:Date.now()});
   await store.setNow('job',b.job,{stage:'open',owner:v.person});
   await store.append('job',b.job,{ts:Date.now(),kind:'progress',by:v.person,via:'web',trail:'created-'+b.job,summary:'Task created: '+b.title.trim()});
   return result({ok:true,job:b.job});
  }
  throw new WorkspaceError('not_found',404);
 }catch(e){
  const statuses={confirm_required:428,stale_ask:409,not_pending:409,forbidden:403,not_found:404,bad_request:400};
  if(e instanceof WorkspaceError)return customerError(res,e,'customer-dashboard');
  if(e.name==='DecisionError')return res.status(statuses[e.code]||400).json({error:e.message,code:e.code});
  if(e.name==='BlockerError'||e.name==='WorkError')return res.status(e.status||400).json({error:e.message});
  return customerError(res,e,'customer-dashboard');
 }
};}
export function withCustomerDashboard(handler) {
 const customer=createCustomerDashboard();return (req,res)=>customerRequest(req)?customer(req,res):handler(req,res);
}
