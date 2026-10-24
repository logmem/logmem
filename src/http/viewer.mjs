// Customer browser identity, permissions and atomic storage authorization.
import {customerSession} from './clerk.mjs';
import {customerRedis,createSpaceJail} from './jail.mjs';
import {readOnly} from '../lib/read-only.mjs';
import {evalScriptFor,registerEvalScript} from '../lib/lua-scripts.mjs';
import {authorizeSpace,readWorkspace,workspaceKey,WorkspaceError} from './workspaces.mjs';
const scripts=new Map();
function guardedScript(original) {
 if(scripts.has(original))return scripts.get(original);
 const source=`
local expected = ARGV[#ARGV]
local workspace = KEYS[#KEYS-1]
local tenant = KEYS[#KEYS]
if redis.call('GET',workspace) ~= expected or redis.call('HGET',tenant,'status') ~= 'active' or redis.call('HGET',tenant,'deleted_at') then return redis.error_reply('space access changed') end
table.remove(KEYS)
table.remove(KEYS)
table.remove(ARGV)
${original||'return redis.call(unpack(ARGV))'}
`;
 registerEvalScript(source,(call,keys,args)=>{
  if(call('GET',keys.at(-2))!==args.at(-1)||call('HGET',keys.at(-1),'status')!=='active'||call('HGET',keys.at(-1),'deleted_at')) throw new WorkspaceError('not_found',404);
  const ks=keys.slice(0,-2),as=args.slice(0,-1);
  return original?evalScriptFor(original)(call,ks,as):call(...as);
 });
 scripts.set(original,source);return source;
}
export async function resolveViewer(req,{workspaceId,spaceId,action='read'},deps={}) {
 const env=deps.env||process.env;
 if(env.LOGMEM_CUSTOMER_DASHBOARD!=='1'&&!deps.redis)throw new WorkspaceError('customer_dashboard_disabled',503);
 const origin=deps.origin||`https://${req.headers?.host||'logmem.si'}`;
 const session=await (deps.session||customerSession)(req,{env,url:new URL('/api/session',origin).toString()});
 if(session.status!=='signed-in')throw new WorkspaceError('sign_in_required',401);
 const redis=deps.redis||customerRedis(env),userId=session.userId;
 const options={userId,workspaceId,spaceId,action};
 const revalidate=()=>authorizeSpace(options,{redis});
 const context=await revalidate();
 const run=async(...cmd)=>{
  await revalidate();
  const {raw}=await readWorkspace(redis,workspaceId);
  // Bind the checked record exactly. A concurrent policy change aborts the command.
  // Recheck the same snapshot because it may have changed between the preceding awaits.
  const current=await authorizeSpace(options,{redis});
  if(current.version!==JSON.parse(raw).version)throw new WorkspaceError('not_found',404);
  let keys,args,source;
  if(String(cmd[0]).toUpperCase()==='EVAL') {
   const n=Number(cmd[2]);keys=cmd.slice(3,3+n);args=cmd.slice(3+n);source=guardedScript(cmd[1]);
  } else {keys=[];args=cmd;source=guardedScript('');}
  try {return await redis('EVAL',source,keys.length+2,...keys,workspaceKey(workspaceId),`acmi:cloud:tenant:${context.workspace.tenantId}`,...args,raw);}
  catch(e){if(String(e.message).includes('space access changed'))throw new WorkspaceError('not_found',404);throw e;}
 };
 const jailed=createSpaceJail(run,{tenantId:context.workspace.tenantId,namespace:context.space.namespace});
 return {...context,userId,workspaceId,spaceId,namespace:context.space.namespace,redis:action==='read'?readOnly(jailed):jailed,revalidate};
}
