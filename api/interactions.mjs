// Shared human actions. Storage and identity always come from the selected authorization context.
import {fromDescriptor,descriptorFromEnv} from '../src/lib/backend.mjs';
import {webStore} from '../src/http/web-store.mjs';
import {isAdmin,mayRead,viewSpaces} from '../src/http/admin-auth.mjs';
import {resolveViewer} from '../src/http/viewer.mjs';
import {customerRequest,requestUrl,requireIntent,jsonBody,customerError} from '../src/http/customer-http.mjs';
import {authorizeSpace,readWorkspace,accessPolicy,WorkspaceError} from '../src/http/workspaces.mjs';
import {customerRedis} from '../src/http/jail.mjs';
import {interact,discussion,coordinationQueue,InteractionError} from '../src/http/interactions.mjs';
import {readOnly} from '../src/lib/read-only.mjs';
export const config={runtime:'nodejs',maxDuration:15};
export function createHandler(deps={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed.'});
  const env=deps.env||process.env,u=requestUrl(req),q=Object.fromEntries(u.searchParams),write=req.method==='POST',b=write?jsonBody(req):q;
  if(write)requireIntent(req,'interactions');
  let store,by,manager,canWrite,viewer,control;
  if(customerRequest(req)){
   viewer=await resolveViewer(req,{workspaceId:b.workspaceId,spaceId:b.spaceId,action:write?(b.action==='reassign'?'manage-members':'write'):'read'},deps);
   store=webStore(viewer.redis,viewer.namespace,{...env,LOGMEM_MIRROR_ACMI:''});by=viewer.person;manager=viewer.permissions.manage;canWrite=viewer.permissions.write;
   control=deps.redis||customerRedis(env);
   if(write&&b.action==='reassign'&&typeof b.to==='string'&&b.to.startsWith('human:'))await authorizeSpace({userId:b.to.slice(6),workspaceId:b.workspaceId,spaceId:b.spaceId,action:'write'},{redis:control});
   if(write)await viewer.revalidate();
  }else{
   if(!(write?isAdmin(req,env):mayRead(req,env)))return res.status(401).json({error:'Sign in required.'});
   if(!viewSpaces(env).includes(b.space))return res.status(403).json({error:'Space unavailable.'});
   let redis=deps.redis;if(!redis){const descriptor=descriptorFromEnv(env);if(!descriptor)return res.status(503).json({error:'Storage unavailable.'});redis=fromDescriptor(descriptor).redis;}
   store=webStore(write?redis:readOnly(redis),b.space,env);by='human:'+String(env.LOGMEM_ADMIN_ID||'admin');manager=isAdmin(req,env);canWrite=manager;
   // Operator tasks have no account registry. Only the configured operator is a valid human destination.
   if(write&&b.action==='reassign'&&b.to?.startsWith('human:')&&b.to!==by)return res.status(400).json({error:'Choose the configured operator or a registered agent.'});
  }
  if(write)return res.status(200).json(await interact(store,{target:b.target,action:b.action,text:b.text,requestId:b.requestId,to:b.to,expectedOwner:b.expectedOwner,by,manager,...(deps.now?{now:deps.now}:{})}));
  if(q.queue==='1')return res.status(200).json(await coordinationQueue(store,q));
  const d=await discussion(store,{type:q.type,id:q.id},{by,manager,canWrite,cursor:q.cursor,limit:q.limit}),assignees=[];
  if(d.canReassign){
   if(q.type==='job')for(const id of await store.list('agent')){try{const {checkAgentId}=await import('../src/core/keys.mjs');checkAgentId(id);if(await store.getWho('agent',id))assignees.push({id:'agent:'+id,label:id});}catch{}}
   if(viewer){
    const {w}=await readWorkspace(control,viewer.workspaceId);
    for(const id of Object.keys(w.members)){try{accessPolicy(w,id,viewer.spaceId,'write');assignees.push({id:'human:'+id,label:w.members[id].name||'human:'+id});}catch{}}
   }else assignees.push({id:by,label:by.slice(6)});
  }
  if(viewer)await viewer.revalidate();
  return res.status(200).json({...d,assignees});
 }catch(e){
  if(e instanceof InteractionError)return res.status(e.status).json({error:e.message});
  if(e instanceof WorkspaceError)return customerError(res,e,'interactions');
  if(e.name==='DecisionError')return res.status(409).json({error:'Decision record changed. Reload its source.'});
  if(e.code==='bad_agent_id')return res.status(400).json({error:'Invalid recipient.'});
  return customerError(res,e,'interactions');
 }
};}
export default createHandler();
