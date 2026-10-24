import {randomBytes} from 'node:crypto';
import {readWorkspace,membership,canManage,accessPolicy,commitWorkspace,digest,failWorkspace,checkUser,requestKey,replay} from './workspaces.mjs';
const emailHash=email=>{if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email.trim()))failWorkspace('invalid_email');return digest(email.trim().toLowerCase());};
const tokenHash=token=>{if(typeof token!=='string'||!/^lmi_[A-Za-z0-9_-]{43}$/.test(token))failWorkspace('not_found',404);return digest(token);};
function validateGrant(w,actorId,role,spaces){
 const actor=membership(w,actorId);if(!canManage(w,actorId))failWorkspace('forbidden',403);
 if(!['admin','member','viewer'].includes(role)||!spaces||typeof spaces!=='object'||Array.isArray(spaces)||!Object.keys(spaces).length)failWorkspace('invalid_invitation');
 for(const [sid,g] of Object.entries(spaces)) {
  if(!w.spaces[sid]||w.spaces[sid].status!=='active'||!g||!['editor','viewer'].includes(g.role)||typeof g.canApprove!=='boolean'||(role==='viewer'&&(g.canApprove||g.role!=='viewer')))failWorkspace('invalid_invitation');
  if(g.canApprove&&actor.role!=='owner')failWorkspace('forbidden',403);
 }
}
export async function createInvitation({actorId,workspaceId,email,role,spaces,requestId},deps) {
 checkUser(actorId);const emailDigest=emailHash(email),fingerprint=digest({workspaceId,emailDigest,role,spaces});
 for(let i=0;i<20;i++) {
  const {w}=await readWorkspace(deps.redis,workspaceId);validateGrant(w,actorId,role,spaces);const at=(deps.now||Date.now)();
  if(Object.values(w.invitations||{}).filter(x=>x.status==='pending'&&x.expiresAt>at).length>=(deps.limits?.pendingInvitations??50))failWorkspace('invitation_limit',429);
  if(Object.values(w.invitations||{}).filter(x=>x.expiresAt>at).length>=100)failWorkspace('invitation_history_limit',429);
  const attempts=(w.inviteAttempts?.[actorId]||[]).filter(t=>t>at-3600000);if(attempts.length>=20)failWorkspace('invitation_rate_limit',429);
  const token='lmi_'+randomBytes(32).toString('base64url'),id=randomBytes(12).toString('hex'),hash=tokenHash(token);
  const rec={id,hash,emailDigest,role,spaces,by:actorId,status:'pending',createdAt:at,expiresAt:at+7*86400000};
  const next=structuredClone(w);next.version++;next.invitations={...Object.fromEntries(Object.entries(next.invitations||{}).filter(([,i])=>i.expiresAt>at)),[id]:rec};next.inviteAttempts={...next.inviteAttempts,[actorId]:[...attempts,at]};next.audit.push({kind:'invitation-created',id,by:`human:${actorId}`,at});
  const r=await commitWorkspace({before:w,after:next,userId:actorId,requestId,operation:'invite',fingerprint,result:{id,expiresAt:rec.expiresAt}},deps);
  if(r){if(r.created){await deps.redis('SET',`lm:workspace:invite:${hash}`,JSON.stringify({workspaceId,id}),'EX','604800');return {...r,token};}return r;}
 }
 failWorkspace('update_conflict',409);
}
async function findInvite({verifiedEmail,token},deps,{allowAccepted=false}={}) {
 const hash=tokenHash(token),raw=await deps.redis('GET',`lm:workspace:invite:${hash}`);if(!raw)failWorkspace('not_found',404);
 const {workspaceId,id}=JSON.parse(raw),{w}=await readWorkspace(deps.redis,workspaceId),invite=w.invitations?.[id];
 if(!invite||invite.hash!==hash||invite.emailDigest!==emailHash(verifiedEmail)||invite.expiresAt<=(deps.now||Date.now)()||(!allowAccepted&&invite.status!=='pending')||invite.status==='revoked')failWorkspace('not_found',404);
 validateGrant(w,invite.by,invite.role,invite.spaces);
 return {w,invite};
}
export async function inspectInvitation(input,deps){const {w,invite}=await findInvite(input,deps);return {workspaceName:w.name,role:invite.role,spaces:Object.keys(invite.spaces).map(sid=>({id:sid,name:w.spaces[sid].name}))};}
export async function acceptInvitation({userId,verifiedEmail,token},deps) {
 checkUser(userId);
 for(let i=0;i<20;i++) {
  const {w,invite}=await findInvite({verifiedEmail,token},deps,{allowAccepted:true});
  const sid=Object.keys(invite.spaces)[0];
  if(invite.status==='accepted') {if(invite.acceptedBy!==userId)failWorkspace('not_found',404);accessPolicy(w,userId,sid,'read');return {accepted:true,selected:{workspaceId:w.id,spaceId:sid}};}
  if(Object.keys(w.members).length>=100&&!w.members[userId])failWorkspace('member_limit',429);
  const next=structuredClone(w);next.version++;
  const old=next.members[userId];
  // Existing owner rights can change only through explicit ownership administration.
  if(old?.role==='owner'&&old.status==='active'){}else next.members[userId]={role:invite.role,status:'active',label:verifiedEmail.trim().toLowerCase(),spaces:structuredClone(invite.spaces)};
  next.invitations[invite.id].status='accepted';next.invitations[invite.id].acceptedBy=userId;
  next.audit.push({kind:'invitation-accepted',id:invite.id,by:`human:${userId}`,at:(deps.now||Date.now)()});
  const r=await commitWorkspace({before:w,after:next,userId,requestId:'accept-'+invite.id,operation:'accept-invite',fingerprint:digest({userId,inviteId:invite.id}),result:{accepted:true,selected:{workspaceId:w.id,spaceId:sid}}},deps);if(r)return r;
 }
 failWorkspace('update_conflict',409);
}
export async function revokeInvitation({actorId,workspaceId,invitationId,requestId},deps) {
 for(let i=0;i<20;i++){
  const {w}=await readWorkspace(deps.redis,workspaceId);if(!canManage(w,actorId))failWorkspace('forbidden',403);
  const previous=await replay(deps.redis,requestKey(actorId,'revoke-invite',requestId),digest({workspaceId,invitationId}));if(previous)return previous;
  const invite=w.invitations?.[invitationId];if(!invite||invite.status!=='pending')failWorkspace('not_found',404);
  const next=structuredClone(w);next.version++;delete next.invitations[invitationId];next.audit.push({kind:'invitation-revoked',id:invitationId,by:`human:${actorId}`,at:(deps.now||Date.now)()});
  const r=await commitWorkspace({before:w,after:next,userId:actorId,requestId,operation:'revoke-invite',fingerprint:digest({workspaceId,invitationId}),result:{revoked:true}},deps);if(r)return r;
 }
 failWorkspace('update_conflict',409);
}
