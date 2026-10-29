import {customerSession,revokeCustomerSession,clerkFrontendForKey} from '../src/http/clerk.mjs';
import {requestUrl,requireIntent,jsonBody,customerIdentity,customerError} from '../src/http/customer-http.mjs';
import {listWorkspaces,listSpaces,ensureLegacyWorkspace,WorkspaceError} from '../src/http/workspaces.mjs';
import {issuerFor} from '../src/http/issuer.mjs';
export const config={runtime:'nodejs',maxDuration:15};
export function safeReturn(value='/app') {
 if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x20]/.test(value))throw new WorkspaceError('invalid_return_path');
 let decoded=value;for(let i=0;i<4;i++){try{decoded=decodeURIComponent(decoded);}catch{throw new WorkspaceError('invalid_return_path');}}
 if(decoded.startsWith('//')||/[\\\x00-\x20]/.test(decoded)||!/^\/(app|connections)([?#]|$)/.test(decoded))throw new WorkspaceError('invalid_return_path');
 return value;
}
export function createHandler(deps={}) {return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try {
  const env=deps.env||process.env,url=requestUrl(req);
  if(env.LOGMEM_CUSTOMER_DASHBOARD!=='1')throw new WorkspaceError('customer_dashboard_disabled',503);
  if(req.method==='GET'&&url.searchParams.get('signin')==='1') {
   const back=safeReturn(url.searchParams.get('returnTo')||'/app');
   const s=await (deps.session||customerSession)(req,{env,url:url.toString()});
   if(s.status==='handshake'){
    const cookies=[];for(const [k,v] of s.headers||[])if(k.toLowerCase()==='set-cookie')cookies.push(v);else res.setHeader(k,v);
    if(cookies.length)res.setHeader('Set-Cookie',cookies);res.statusCode=307;return res.end();
   }
   res.setHeader('Location',s.status==='signed-in'?back:s.signInUrl);res.statusCode=302;return res.end();
  }
  const {session:s,redis}=await customerIdentity(req,deps);
  if(req.method==='GET'&&url.searchParams.get('profile')==='1'){
   const frontend=clerkFrontendForKey(env.CLERK_PUBLISHABLE_KEY||'');
   if(!frontend)throw new WorkspaceError('clerk_profile_unavailable',503);
   const profileOrigin=env.VERCEL_ENV||env.LOGMEM_ISSUER?issuerFor(req,env):url.origin;
   const returnTo=new URL('/app#/account',profileOrigin).toString();
   res.setHeader('Cache-Control','no-store');res.setHeader('Location',frontend+'/user?redirect_url='+encodeURIComponent(returnTo));res.statusCode=302;return res.end();
  }
  if(req.method==='POST') {
   requireIntent(req,'session');const b=jsonBody(req);if(b.action!=='signout')throw new WorkspaceError('invalid_action');
   if(!s.sessionId)throw new WorkspaceError('session_not_available',503);
   await (deps.revokeSession||revokeCustomerSession)(s.sessionId,env);
   res.setHeader('Set-Cookie','__session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');return res.status(200).json({ok:true});
  }
  if(req.method!=='GET')return res.status(405).json({error:'method_not_allowed'});
  const legacy=await redis('GET',`lm:account:clerk:${s.userId}`);
  if(legacy)await ensureLegacyWorkspace({userId:s.userId,tenantId:legacy},{redis});
  const workspaces=await listWorkspaces({userId:s.userId},{redis}),spaces=[];
  for(const w of workspaces)spaces.push(...await listSpaces({userId:s.userId,workspaceId:w.id},{redis}));
  const chosen=spaces.find(x=>x.id===url.searchParams.get('spaceId')&&x.workspaceId===url.searchParams.get('workspaceId'))||spaces[0]||null;
  return res.status(200).json({user:{id:s.userId,email:s.email},workspaces,spaces,selected:chosen?{workspaceId:chosen.workspaceId,spaceId:chosen.id,namespace:chosen.namespace}:null,onboarding:workspaces.length===0});
 }catch(e){return customerError(res,e,'customer-session');}
};}
export default createHandler();
