import {customerIdentity,requireIntent,jsonBody,requestUrl,customerError} from '../src/http/customer-http.mjs';
import {readWorkspace,canManage,setMembership,removeMembership,WorkspaceError} from '../src/http/workspaces.mjs';
import {createInvitation,acceptInvitation,revokeInvitation,inspectInvitation} from '../src/http/workspace-invites.mjs';
export const config={runtime:'nodejs',maxDuration:15};
export function createHandler(deps={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  const {session:s,redis}=await customerIdentity(req,deps),d={redis,now:deps.now,limits:deps.limits};
  if(req.method==='GET'){
   const q=requestUrl(req).searchParams;
   if(q.get('token'))return res.status(200).json(await inspectInvitation({verifiedEmail:s.email,token:q.get('token')},d));
   const {w}=await readWorkspace(redis,q.get('workspaceId'));if(!canManage(w,s.userId))throw new WorkspaceError('forbidden',403);
   return res.status(200).json({members:Object.entries(w.members).filter(([,m])=>m.status==='active').map(([userId,m])=>({userId,label:m.label||null,role:m.role,spaces:m.spaces})),invitations:Object.values(w.invitations||{}).filter(i=>i.status==='pending'&&i.expiresAt>Date.now()).map(({id,role,expiresAt,spaces})=>({id,role,expiresAt,spaces}))});
  }
  if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
  requireIntent(req,'memberships');const b=jsonBody(req);
  const input={...b,actorId:s.userId};let r;
  if(b.action==='accept')r=await acceptInvitation({userId:s.userId,verifiedEmail:s.email,token:b.token},d);
  else if(b.action==='invite')r=await createInvitation(input,d);
  else if(b.action==='revoke-invitation')r=await revokeInvitation(input,d);
  else if(b.action==='set')r=await setMembership(input,d);
  else if(b.action==='remove')r=await removeMembership(input,d);
  else throw new WorkspaceError('invalid_action');
  return res.status(200).json(r);
 }catch(e){return customerError(res,e,'workspace-memberships');}
};}
export default createHandler();
