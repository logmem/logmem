import { resolveViewer } from '../src/http/viewer.mjs';
import { BUSINESS_DEMOS, seedBusinessDemos } from '../scripts/seed-business-demos.mjs';
import {customerIdentity,requireIntent,jsonBody,customerError} from '../src/http/customer-http.mjs';
import {isInvited} from '../src/http/invites.mjs';
import {createWorkspace,createSpace,summary,WorkspaceError} from '../src/http/workspaces.mjs';
export const config={runtime:'nodejs',maxDuration:30};
export function createHandler(deps={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try {
  const {session:s,redis,env}=await customerIdentity(req,deps);
  if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
  requireIntent(req,'workspace');const b=jsonBody(req);
  if(b.action==='create-workspace'&&!await isInvited(s.email,{redis,env}))throw new WorkspaceError('signup_closed',403);
  const options={redis,limits:deps.limits};
  let result;
  if(b.action==='create-workspace')result=await createWorkspace({userId:s.userId,name:b.name,firstSpaceName:b.firstSpaceName,requestId:b.requestId,businessType:b.businessType||'',withSample:b.withSample===true,userLabel:s.email},options);
  else if(b.action==='create-space')result=await createSpace({userId:s.userId,workspaceId:b.workspaceId,name:b.name,requestId:b.requestId},options);
  else throw new WorkspaceError('invalid_action');
  if(result.space.sampleTemplate) {
   const v=await resolveViewer(req,{workspaceId:result.space.workspaceId,spaceId:result.space.id,action:'write'},deps);
   const marker=`lm:${result.space.namespace}:sample:state`;
   const prior=await v.redis('GET',marker);
   if(prior){const saved=JSON.parse(prior);result.sampleStatus=saved.status;result.sampleJobs=saved.jobs||[];}
   else if(await v.redis('SET',marker,JSON.stringify({status:'running'}),'NX')) {
    try {
     const template=BUSINESS_DEMOS.find(d=>d.id==='demo-'+result.space.sampleTemplate);
     const seeded=await seedBusinessDemos(v.redis,{demos:[{...template,id:result.space.namespace}]});
     const saved={status:'complete',jobs:seeded[0].jobs};await v.redis('SET',marker,JSON.stringify(saved));result.sampleStatus=saved.status;result.sampleJobs=saved.jobs;
    }catch{await v.redis('SET',marker,JSON.stringify({status:'interrupted'}));result.sampleStatus='interrupted';}
   }else result.sampleStatus='running';
  }
  if(result.workspace)result.workspace=summary(result.workspace);
  return res.status(200).json(result);
 }catch(e){return customerError(res,e,'workspace-handler');}
};}
export default createHandler();
