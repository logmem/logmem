import {customerSession} from './clerk.mjs';
import {customerRedis} from './jail.mjs';
import {WorkspaceError} from './workspaces.mjs';
import {sendServerError} from './log.mjs';
import {isSuspended} from './admin-roles.mjs';
export function requestUrl(req) {
 const host=req.headers?.host||'logmem.si';
 const protocol=/^(localhost|127\.0\.0\.1)(:|$)/.test(host)?'http':'https';
 return new URL(req.url||'/',`${protocol}://${host}`);
}
export function requireIntent(req,intent) {
 if(req.headers?.['x-logmem-intent']!==intent || req.headers?.origin!==requestUrl(req).origin)throw new WorkspaceError('request_not_allowed',403);
}
export function jsonBody(req) {
 let b=req.body;
 if(typeof b==='string')try{b=JSON.parse(b);}catch{throw new WorkspaceError('invalid_json');}
 if(!b||typeof b!=='object'||Array.isArray(b))throw new WorkspaceError('invalid_json');
 if(JSON.stringify(b).length>16384)throw new WorkspaceError('request_too_large',413);
 return b;
}
export async function customerIdentity(req,deps={}) {
 const env=deps.env||process.env;
 if(env.LOGMEM_CUSTOMER_DASHBOARD!=='1')throw new WorkspaceError('customer_dashboard_disabled',503);
 const s=await (deps.session||customerSession)(req,{env,url:requestUrl(req).toString()});
 if(s.status!=='signed-in')throw new WorkspaceError('sign_in_required',401);
 const redis=deps.redis||customerRedis(env);
 if(s.userId && await isSuspended(s.userId,redis))throw new WorkspaceError('account_suspended',403);
 return {session:s,redis,env};
}
export function customerError(res,e,context) {
 if(e instanceof WorkspaceError)return res.status(e.status).json({error:e.code});
 return sendServerError(res,context,e);
}
export const customerRequest=req=>req.headers?.['x-logmem-viewer']==='customer';
