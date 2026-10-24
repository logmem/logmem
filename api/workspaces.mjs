import {customerIdentity,requireIntent,jsonBody,customerError} from '../src/http/customer-http.mjs';
import {isInvited} from '../src/http/invites.mjs';
import {createWorkspace,createSpace,summary,WorkspaceError} from '../src/http/workspaces.mjs';
export const config={runtime:'nodejs',maxDuration:15};
export function createHandler(deps={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try {
  const {session:s,redis,env}=await customerIdentity(req,deps);
  if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
  requireIntent(req,'workspace');const b=jsonBody(req);
  if(!await isInvited(s.email,{redis,env}))throw new WorkspaceError('signup_closed',403);
  const options={redis,limits:deps.limits};
  let result;
  if(b.action==='create-workspace')result=await createWorkspace({userId:s.userId,name:b.name,firstSpaceName:b.firstSpaceName,requestId:b.requestId},options);
  else if(b.action==='create-space')result=await createSpace({userId:s.userId,workspaceId:b.workspaceId,name:b.name,requestId:b.requestId},options);
  else throw new WorkspaceError('invalid_action');
  if(result.workspace)result.workspace=summary(result.workspace);
  return res.status(200).json(result);
 }catch(e){return customerError(res,e,'workspace-handler');}
};}
export default createHandler();
