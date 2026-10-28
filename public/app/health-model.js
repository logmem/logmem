// health-model.js: bounded queue filters and recorded audit diagnostics. No server policy changes.
export const recordedCount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function overdueRequest(item,now=Date.now()){
 const due=Number(item.deadline),created=Number(item.created_at);
 return Number.isFinite(due)&&due>0&&due<now&&(item.created_at==null||(Number.isFinite(created)&&created>0&&created<=now&&due>=created));
}
export const unindexedRequest=item=>item.read_only===true||!item.id;
export function healthQueueItems(items=[],filter='all',now=Date.now()){
 return items.filter(item=>filter==='overdue'?overdueRequest(item,now):filter==='unindexed'?unindexedRequest(item):true);
}
export function auditResult(day){return day.paused===true?'Paused':day.pass===true?'Pass':day.health_pass===true?'Low volume':day.pass===false?'Fail':'Unknown';}
export function auditVectors(day){
 return [
  {key:'mirror',label:'Missing compatibility copies',value:recordedCount(day.mirror_mismatches),note:day.mirror_checked===false?'Mirror check was not enabled.':day.mirror_checked===true?'Saved audit window only.':'Mirror check status is unknown.',active:day.mirror_checked!==false&&recordedCount(day.mirror_mismatches)>0},
  {key:'unanswered',label:'Unanswered handoffs over 24 hours',value:recordedCount(day.unanswered_24h),note:'Historical response check, not the current overdue queue.',active:recordedCount(day.unanswered_24h)>0},
  {key:'degraded',label:'Degraded sessions',value:recordedCount(day.degraded_sessions),note:'Recorded degraded-session signals.',active:recordedCount(day.degraded_sessions)>0},
 ];
}
export function auditDays(days=[],filter='all'){
 return days.filter(day=>filter==='all'||auditVectors(day).some(v=>v.key===filter&&v.active)).slice().reverse();
}
export function volumeChecks(day){
 const agents=Array.isArray(day.agents)?day.agents.length:null,handoffs=recordedCount(day.handoffs),accepted=recordedCount(day.accepted);
 return [{label:'At least 3 reporting agents',value:agents,pass:agents==null?null:agents>=3},
  {label:'At least 1 handoff',value:handoffs,pass:handoffs==null?null:handoffs>=1},
  {label:'All handoffs accepted',value:accepted==null||handoffs==null?null:accepted+' / '+handoffs,pass:accepted==null||handoffs==null?null:accepted>=handoffs}];
}
