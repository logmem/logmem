// One record discussion and the canonical coordination queue.
import {html,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {getJSON,postJSON,state,onContextReset,ago,agentName,toast} from './core.js';
import {renderView} from './shell.js';
import {handoffMap} from './flow-views.js';
import {handoffArcs,matchHandoff} from './flow-model.js';
import {terminalTicketCard} from './dispatch-components.js';
import {ticketStatus} from './dispatch-model.js';
const drafts=new Map(),queueRequests=new Map();let generation=0;
export function clearInteractions(){drafts.clear();queueRequests.clear();generation++;}
onContextReset(clearInteractions);
const endpoint=(target,extra={})=>'/api/interactions?'+new URLSearchParams({space:state.space||'',...(target?{type:target.type,id:target.id}:{}),...extra});
const stamp=v=>{const n=Number(v);return n>0&&Number.isFinite(n)?new Date(n).toLocaleString():'Timestamp unavailable';};
const link=t=>'#/discussion/'+t.type+'/'+encodeURIComponent(t.id);
export async function drawDiscussion(want,shell,current){
 const split=want.id.indexOf('/'),target={type:want.id.slice(0,split),id:want.id.slice(split+1)},space=state.space,version=generation;
 const key=space+':'+want.id;
 let model=drafts.get(key);if(!model){model={text:'',reason:'',to:'',error:'',busy:false,attempt:null,data:null,older:[]};drafts.set(key,model);}
 const alive=()=>drafts.get(key)===model&&state.space===space&&version===generation;
 const active=()=>current()&&alive();
 const draw=()=>{
  if(!active())return;
  const d=model.data;
  if(!d){shell('Comments and actions',html`<p>Loading discussion…</p>`);return;}
  const write=async(action)=>{
   if(model.busy)return;
   if(!model.attempt)model.attempt={target,action,text:['reassign','resolve'].includes(action)?model.reason:model.text,requestId:crypto.randomUUID(),...(['reassign','resolve'].includes(action)?{expectedOwner:d.owner}:{}),...(action==='reassign'?{to:model.to}:{})};
   model.busy=true;model.error='';draw();
   try{
    const saved=await postJSON('/api/interactions','interactions',model.attempt);
    if(!alive())return;
    const completed=model.attempt.action;model.attempt=null;model.busy=false;model.older=[];
    if(['reassign','resolve'].includes(completed))model.reason='';else model.text='';
    toast(completed==='resolve'?'Request resolved. History preserved.':completed==='reassign'?'Owner updated.':completed==='nudge'?'Nudge recorded.':'Comment added.');
    model.render?.();await model.reload?.();
   }catch(e){
    if(!alive()||e.stale)return;
    model.busy=false;model.error=e.message||'Could not confirm the save. Retry to check the same request.';
    if(e.status&&e.status!==503)model.attempt=null;
    model.render?.();
   }
  };
  const frozen=model.busy||!!model.attempt;
  shell('Comments and actions',html`<section class="lmx-card lmx-discussion"><div class="lmx-meta">${target.type} · ${target.id}</div><h3>${d.title}</h3>${d.owner?html`<p class="lmx-meta">Current owner: ${agentName(d.owner)}</p>`:nothing}
   <p class="lmx-meta">Comments record context. They do not approve decisions or close work.</p>
   ${model.error?html`<p role="alert">${model.error}</p>`:nothing}
   ${d.canComment?html`<form @submit=${e=>{e.preventDefault();write('comment');}}><label class="lm-field"><span>Comment</span><textarea class="lm-input" aria-label="Comment" maxlength="2000" required .value=${model.text} ?disabled=${frozen} @input=${e=>{model.text=e.target.value;}}></textarea></label><div class="lmx-acts">${model.attempt?nothing:html`<button class="lm-btn lm-btn--primary" ?disabled=${model.busy}>Add comment</button>`}${d.canNudge&&!model.attempt?html`<button type="button" class="lm-btn lm-btn--secondary" @click=${()=>write('nudge')}>Nudge recipient</button>`:nothing}</div></form>`:html`<p>You have read access. Ask a space manager for edit access to add comments.</p>`}
   ${model.attempt?html`<button type="button" class="lm-btn lm-btn--secondary" ?disabled=${model.busy} @click=${()=>write(model.attempt.action)}>${model.busy?'Saving…':'Retry save'}</button>`:nothing}
   ${d.canReassign?html`<details><summary>Reassign work</summary><p class="lmx-meta">This changes the current owner. Progress, waits, and decision rights stay in place.</p><form @submit=${e=>{e.preventDefault();write('reassign');}}><label class="lm-field"><span>New owner</span><select class="lm-select" aria-label="New owner" required ?disabled=${frozen} .value=${model.to} @change=${e=>{model.to=e.target.value;}}><option value="">Choose an owner</option>${(d.assignees||[]).filter(x=>x.id!==d.owner).map(x=>html`<option value=${x.id}>${x.label}</option>`)}</select></label><label class="lm-field"><span>Reason for reassignment</span><textarea class="lm-input" aria-label="Reason for reassignment" maxlength="2000" required ?disabled=${frozen} .value=${model.reason} @input=${e=>{model.reason=e.target.value;}}></textarea></label><button class="lm-btn lm-btn--secondary" ?disabled=${frozen}>Reassign</button></form></details>`:nothing}
   ${d.canResolve?html`<details><summary>Resolve a stale request</summary><p>This closes the response request with your name and reason. It preserves the handoff history and does not complete linked work.</p><form @submit=${e=>{e.preventDefault();write('resolve');}}><label class="lm-field"><span>Reason for resolution</span><textarea class="lm-input" aria-label="Reason for resolution" maxlength="2000" required ?disabled=${frozen} .value=${model.reason} @input=${e=>{model.reason=e.target.value;}}></textarea></label><button class="lm-btn lm-btn--secondary" ?disabled=${frozen}>Resolve request</button></form></details>`:nothing}
   <h3>Discussion history</h3>${[...d.entries,...model.older].length?[...d.entries,...model.older].map(e=>html`<article class="lmx-discussion-entry"><div class="lmx-meta">${agentName(e.by)} · ${e.payload?.interaction||e.kind} · ${stamp(e.ts)}</div><p>${e.summary}</p></article>`):html`<p>No comments or actions on this record yet.</p>`}
   ${d.nextCursor!=null?html`<button type="button" class="lm-btn lm-btn--ghost" ?disabled=${model.busy} @click=${async()=>{model.busy=true;draw();try{const more=await getJSON(endpoint(target,{cursor:d.nextCursor}));if(!active()||more.__stale)return;if(more.__status!==200)throw new Error(more.error||'Could not load history.');model.older.push(...more.entries);d.nextCursor=more.nextCursor;}catch(e){if(active())model.error=e.message;}finally{if(active()){model.busy=false;draw();}}}}>Load older comments</button>`:nothing}
  </section>`);
 };
 const load=async()=>{
  if(!active())return;
  const request= model.loadSeq=(model.loadSeq||0)+1;
  try{const data=await getJSON(endpoint(target));if(!active()||data.__stale||model.loadSeq!==request)return;if(data.__status!==200)throw new Error(data.error||'Could not load this discussion.');model.data=data;draw();}
  catch(e){if(active())shell('Comments and actions',html`<p role="alert">${e.message}</p><button class="lm-btn" @click=${load}>Retry loading</button>`);}
 };
 model.render=draw;model.reload=load;draw();await load();
}
export async function queuePage(){
 const space=state.space,version=generation,route=location.hash,pending=new Map();let recipient='',cursor=0,error='',data=null,busy=false,flowSel='',flowHover='',flowPair=null,flowView='map',status='all';
 const active=()=>space===state.space&&version===generation&&location.hash===route;
 const jumpToList=()=>requestAnimationFrame(()=>{const el=document.getElementById('lmx-queue-list');if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
 const draw=()=>{
  if(!active())return;
  const shownItems=data?data.items.filter(i=>(status==='all'||ticketStatus(i)===status)&&matchHandoff(i,flowSel,flowPair)):[];
  renderView('queue',['Work','Coordination queue'],html`<section class="lmx-queue"><div class="lmx-work-toolbar"><h1>Coordination queue</h1><a href="#/work">Back to work</a></div><p>Unanswered requests, ordered by their original deadline.</p>
   ${error?html`<p role="alert">${error}</p>`:nothing}
   <form class="lmx-filters" @submit=${e=>{e.preventDefault();recipient=e.target.recipient.value.trim();cursor=0;load();}}><label class="lm-field"><span>Recipient agent</span><input class="lm-input" name="recipient" aria-label="Recipient agent" maxlength="64" placeholder="All agents" .value=${recipient}></label><button class="lm-btn" ?disabled=${busy}>Filter</button></form>
   ${data?html`${!data.coverage?.complete?html`<div class="lmx-coverage-note"><p>History indexing is pending. New indexed requests appear below. Older requests remain in their source logs until verified indexing completes.</p></div>`:nothing}${(data.coverage?.notes||[]).map(n=>html`<p class="lmx-meta">${n}</p>`)}${(data.coverage?.errors||[]).map(n=>html`<p role="alert">${n}</p>`)}
    <div class="lmx-ticket-filters" role="group" aria-label="Request status">${[['all','All'],['overdue','Overdue'],['active','Awaiting response']].map(([value,label])=>html`<button type="button" class="lm-btn" aria-pressed=${String(status===value)} @click=${()=>{status=value;draw();}}>${label} (${data.items.filter(i=>value==='all'||ticketStatus(i)===value).length})</button>`)}</div><p class="lmx-meta">Counts describe this loaded page. Copy prepares a prompt and starts no agent.</p><details class="lmx-queue-map"><summary>Show handoff map</summary>${handoffMap({arcs:handoffArcs(data.items),sel:flowSel,hover:flowHover,pair:flowPair,view:flowView,setView:v=>{flowView=v;flowPair=null;draw();},pick:s=>{flowSel=s;flowPair=null;draw();if(s)jumpToList();},peek:h=>{if(h!==flowHover){flowHover=h;draw();}},pickPair:x=>{flowPair=x;flowSel='';draw();if(x)jumpToList();}})}</details>
    <div class="lmx-stack" id="lmx-queue-list">${shownItems.length?shownItems.map(item=>{
     const next=Number(item.last_nudge_at||0)+300000,invalid=Number(item.created_at)>Date.now()||!Number.isFinite(Number(item.deadline))||Number(item.deadline)<Number(item.created_at)||!Number.isFinite(Number(item.created_at))||Number(item.created_at)<=0,disabled=state.customer&&!state.permissions?.write||next>Date.now()||invalid||pending.has(item.id);
     return terminalTicketCard({item,space,actions:html`<button class="lm-btn lm-btn--secondary" ?disabled=${disabled} @click=${()=>nudge(item)}>Nudge ${agentName(item.to)}</button>${queueRequests.has(space+':'+item.id)?html`<button class="lm-btn" ?disabled=${pending.has(item.id)} @click=${()=>nudge(item)}>Retry nudge delivery</button>`:nothing}<a href=${link({type:'coord',id:item.id})}>Comments and actions</a>${item.where?.startsWith('job:')?html`<a href=${'#/job/'+encodeURIComponent(item.where.slice(4))}>Open work</a>`:nothing}`,notice:html`${invalid?html`<p role="alert">Check the source timestamps before nudging.</p>`:nothing}${next>Date.now()?html`<p class="lmx-meta">Next nudge available ${stamp(next)}.</p>`:nothing}`});
    }):html`<p>${data.items.length?(flowSel||flowPair)&&data.items.some(i=>status==='all'||ticketStatus(i)===status)?'No handoffs match this map filter. Pick the same agent or cell again to clear it.':'No loaded requests match this status. Choose another filter.':'No pending records were returned for this page. Check the coverage notice above.'}</p>`}</div><div class="lmx-acts">${cursor>0?html`<button class="lm-btn" @click=${()=>{cursor=Math.max(0,cursor-30);load();}}>Previous page</button>`:nothing}${data.nextCursor!=null?html`<button class="lm-btn" @click=${()=>{cursor=data.nextCursor;load();}}>Next page</button>`:nothing}</div>`:html`<p>Loading requests…</p>`}</section>`);
 };
 const nudge=async item=>{
  if(pending.has(item.id))return;
  const key=space+':'+item.id,requestId=queueRequests.get(key)||crypto.randomUUID();queueRequests.set(key,requestId);pending.set(item.id,true);draw();
  try{await postJSON('/api/interactions','interactions',{target:{type:'coord',id:item.id},action:'nudge',text:'',requestId});if(!active())return;toast('Nudge recorded. The original deadline stays in place.');queueRequests.delete(key);pending.delete(item.id);await load();}
  catch(e){if(!active()||e.stale)return;pending.delete(item.id);if(e.status&&e.status!==503)queueRequests.delete(key);error=e.message;draw();}
 };
 const load=async()=>{
  busy=true;error='';draw();
  try{const result=await getJSON(endpoint(null,{queue:'1',cursor,...(recipient?{recipient}:{})}));if(!active()||result.__stale)return;if(result.__status!==200)throw new Error(result.error||'Could not load requests.');data=result;}
  catch(e){if(active())error=e.message;}
  finally{if(active()){busy=false;draw();}}
 };
 await load();
}
