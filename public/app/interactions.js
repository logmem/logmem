// One record discussion and the canonical coordination queue.
import {html,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {getJSON,postJSON,state,onContextReset,ago,agentName,toast} from './core.js';
import {renderView} from './shell.js';
import {handoffMap} from './flow-views.js';
import {handoffArcs,matchHandoff} from './flow-model.js';
import {agentDispatchButton} from './dispatch-components.js';
import {observeTelemetry} from './telemetry-state.js';
import {ticketStatus,summaryPreview,ticketPrompt,ticketAgeBadge,mailRange} from './dispatch-model.js';
import {BUCKETS,inBucket,bucketCounts,sortOldestFirst,queueSummary,dueChip,relTime,fullTime} from './brief-model.js';
import {splitHeadline} from './dashboard-model.js';
import {agent as avatar,idChip} from './ui.js';
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
export async function queuePage(arg){
 const space=state.space,version=generation,route=location.hash,pending=new Map();let recipient='',error='',data=null,busy=false,requestSeq=0,flowSel='',flowHover='',flowPair=null,flowView='map',bucket=BUCKETS.some(([k])=>k===arg)?arg:'all',mapOpen=false,openId='',selected=new Set(),mp=0;const MAIL_PAGE=10;
 const active=()=>space===state.space&&version===generation&&location.hash===route;
 const jumpToList=()=>requestAnimationFrame(()=>{const el=document.getElementById('lmx-queue-list');if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
 const draw=()=>{
  if(!active())return;
  const now=Date.now();
  // The server returns stable oldest-first pages. Keep loaded pages together so local paging never shifts backward.
  const loaded=data?sortOldestFirst(data.items):[];
  const counts=bucketCounts(loaded,now);
  const shownItems=loaded.filter(i=>inBucket(i,bucket,now)&&matchHandoff(i,flowSel,flowPair));
  const mpMax=Math.max(0,Math.ceil(shownItems.length/MAIL_PAGE)-1);if(mp>mpMax)mp=mpMax;
  const pageItems=shownItems.slice(mp*MAIL_PAGE,mp*MAIL_PAGE+MAIL_PAGE);
  const nudgeState=item=>{const next=Number(item.last_nudge_at||0)+300000,invalid=Number(item.created_at)>Date.now()||!Number.isFinite(Number(item.deadline))||Number(item.deadline)<Number(item.created_at)||!Number.isFinite(Number(item.created_at))||Number(item.created_at)<=0;return {next,invalid,disabled:state.customer&&!state.permissions?.write||next>Date.now()||invalid||pending.has(item.id)};};
  const closeDrawer=()=>{openId='';draw();};
  // One row per request: who to whom, a human title, one line of detail, the due chip, and the actions that exist.
  const renderRow=item=>{const st=ticketStatus(item,now),due=dueChip(item,now),{head,body}=splitHeadline(summaryPreview(item.summary)),{disabled}=nudgeState(item);
   return html`<li class="lmx-inbox-row" data-status=${st}><label class="lmx-mail-check"><input type="checkbox" aria-label=${'Select request from '+agentName(item.from)} .checked=${selected.has(item.id)} @change=${e=>{if(e.target.checked)selected.add(item.id);else selected.delete(item.id);draw();}}></label>
    <span class="lmx-inbox-who" aria-hidden="true">${avatar(item.from)}<span>→</span>${avatar(item.to)}</span>
    <div class="lmx-inbox-main"><button type="button" class="lmx-inbox-open" aria-label=${'Open request from '+agentName(item.from)+' to '+agentName(item.to)+': '+head} @click=${()=>{openId=item.id;draw();}}><span class="lmx-inbox-route">${agentName(item.from)} → ${agentName(item.to)}</span><strong class="lmx-inbox-title">${head}</strong>${body?html`<span class="lmx-inbox-desc">${body}</span>`:nothing}</button>
     <span class="lmx-inbox-meta"><span class="lmx-due-chip" data-tone=${due.tone||nothing}>${due.text}</span><time class="lmx-meta" title=${fullTime(item.created_at)}>opened ${relTime(item.created_at,now)}</time></span></div>
    <div class="lmx-inbox-acts"><button type="button" class="lm-btn lm-btn--secondary" ?disabled=${disabled} @click=${()=>nudge(item)}>Nudge ${agentName(item.to)}</button>${agentDispatchButton(ticketPrompt(item,space))}<a class="lm-btn lm-btn--ghost" href=${link({type:'coord',id:item.id})}>Comment</a></div></li>`;
  };
  const renderDrawer=()=>{const item=data&&openId?data.items.find(i=>i.id===openId):null;if(!item)return nothing;const {next,invalid,disabled}=nudgeState(item);const st=ticketStatus(item,now);
   return html`<dialog class="lmx-drawer lm-inbox-sheet" data-status=${st} aria-label="Request details" @cancel=${e=>{e.preventDefault();closeDrawer();}} @click=${e=>{if(e.target===e.currentTarget)closeDrawer();}}>
    <header class="lmx-drawer-head lm-sheet-head"><div class="lm-sheet-titles"><span class="lm-sheet-eyebrow">Coordination request</span><h2 class="lm-sheet-route">${avatar(item.from)}<span class="lm-sheet-arrow" aria-hidden="true">→</span>${avatar(item.to)}</h2></div><button type="button" class="lm-btn lm-btn--ghost lmx-drawer-close" aria-label="Close details" @click=${closeDrawer}>Close</button></header>
    <div class="lmx-drawer-body lm-sheet-body"><div class="lm-sheet-status-row"><span class="lmx-drawer-status lm-sheet-pill" data-status=${st}>${ticketAgeBadge(item)}</span><span class="lm-sheet-type">${item.type}</span></div><section class="lm-sheet-summary"><p class="lmx-drawer-summary">${item.summary}</p></section><dl class="lm-sheet-kv"><dt>Created</dt><dd>${stamp(item.created_at)}</dd><dt>Deadline</dt><dd>${stamp(item.deadline)}</dd><dt>Last nudge</dt><dd>${item.last_nudge_at?stamp(item.last_nudge_at):'None recorded'}</dd><dt>Source</dt><dd>${item.where||'Not recorded'}</dd><dt>Type</dt><dd>${item.type}</dd><dt>ID</dt><dd>${idChip(item.id)}</dd></dl>${invalid?html`<p class="lm-sheet-warn" role="alert">Check the source timestamps before nudging.</p>`:nothing}${next>Date.now()?html`<p class="lmx-meta">Next nudge available ${stamp(next)}.</p>`:nothing}</div>
    <footer class="lmx-drawer-foot lm-sheet-foot"><div class="lm-sheet-foot-primary">${agentDispatchButton(ticketPrompt(item,space))}<button type="button" class="lm-btn lm-btn--primary" ?disabled=${disabled} @click=${()=>nudge(item)}>Nudge ${agentName(item.to)}</button>${queueRequests.has(space+':'+item.id)?html`<button type="button" class="lm-btn lm-btn--secondary" ?disabled=${pending.has(item.id)} @click=${()=>nudge(item)}>Retry nudge delivery</button>`:nothing}</div><div class="lm-sheet-foot-links"><a class="lm-btn lm-btn--secondary" href=${link({type:'coord',id:item.id})}>Comments and actions</a>${item.where?.startsWith('job:')?html`<a class="lm-btn lm-btn--ghost" href=${'#/job/'+encodeURIComponent(item.where.slice(4))}>Open work →</a>`:nothing}</div></footer>
   </dialog>`;};
  const selectedItems=data?data.items.filter(i=>selected.has(i.id)):[];
  const batchBar=selectedItems.length?html`<div class="lmx-mail-batch" role="status"><span>${selectedItems.length} selected</span>${agentDispatchButton(selectedItems.map(i=>ticketPrompt(i,space)).join('\n\n---\n\n'),'Copy prompts')}<button type="button" class="lm-btn lm-btn--ghost" @click=${()=>{selected.clear();draw();}}>Clear</button></div>`:nothing;
  const empty=!loaded.length?(data?.coverage?.complete?'No open requests. Nothing is waiting on a reply.':'No indexed requests are open. Older requests may still sit in source logs.'):(flowSel||flowPair)?'No requests match this map filter. Pick the same agent or cell again to clear it.':'No requests in this bucket yet.';
  renderView('queue',['Inbox'],html`<section class="lmx-queue"><header class="lmx-pageheader"><div><span class="lm-eyebrow">Requests · oldest first</span><h1>Inbox</h1></div><div class="lmx-pageheader-links"><a href="#/work">Work</a><a href="#/decisions">Decisions</a></div></header>
   ${error?html`<p role="alert">${error}</p>`:nothing}
   ${data?html`<div class="lmx-inbox-bar"><p class="lmx-inbox-summary" aria-live="polite"><strong>${queueSummary(pageItems,now)}</strong> <span class="lmx-meta">${data.indexedCount} indexed</span>${data.nextAfter!=null?html` <span class="lmx-meta">more requests available</span>`:nothing}</p>
    <div class="lmx-bucket-chips" role="group" aria-label="Age buckets">${BUCKETS.map(([value,label])=>html`<button type="button" class="lmx-typepill" aria-pressed=${String(bucket===value)} ?disabled=${busy} @click=${()=>{if(bucket!==value){bucket=value;load({reset:true});}}}>${label} ${counts[value]}</button>`)}</div></div>
    <div class="lmx-stack" id="lmx-queue-list">${batchBar}${pageItems.length?html`<ul class="lmx-inbox" aria-label="Requests">${pageItems.map(renderRow)}</ul>`:html`<p class="lmx-meta">${empty}</p>`}</div>
    <div class="lmx-mail-foot"><span aria-live="polite">${mailRange(mp*MAIL_PAGE,pageItems.length,mp>=mpMax&&data.nextAfter!=null)}</span><button type="button" class="lm-btn lm-btn--ghost" aria-label="Previous page" ?disabled=${busy||mp<=0} @click=${()=>{if(mp>0){mp--;draw();}}}>‹</button><button type="button" class="lm-btn lm-btn--ghost" aria-label="Next page" ?disabled=${busy||mp>=mpMax&&data.nextAfter==null} @click=${nextPage}>›</button></div>
    <form class="lmx-filters lmx-inbox-filter" @submit=${e=>{e.preventDefault();recipient=e.target.recipient.value.trim();load({reset:true});}}><label class="lm-field"><span>Recipient agent</span><input class="lm-input" name="recipient" aria-label="Recipient agent" maxlength="64" placeholder="All agents" .value=${recipient} ?disabled=${busy}></label><button class="lm-btn" ?disabled=${busy}>Filter</button></form>
    <details class="lmx-queue-map" ?open=${mapOpen} @toggle=${e=>{mapOpen=e.currentTarget.open;}}><summary><strong>Request map</strong><span class="lmx-meta">Who sends requests to whom</span></summary><div class="lmx-map-canvas">${data.items.length?handoffMap({arcs:handoffArcs(data.items),sel:flowSel,hover:flowHover,pair:flowPair,view:flowView,setView:v=>{flowView=v;flowPair=null;draw();},pick:s=>{flowSel=s;flowPair=null;load({reset:true});if(s)jumpToList();},peek:h=>{if(h!==flowHover){flowHover=h;draw();}},pickPair:x=>{flowPair=x;flowSel='';load({reset:true});if(x)jumpToList();}}):html`<p class="lmx-meta">The map appears when this page has requests.</p>`}</div></details>
    <details class="lmx-coverage lmx-coverage--quiet"><summary>About this list</summary><p>Age counts cover requests loaded so far. Use Next to load more. Copy prompt puts a prompt on your clipboard and starts no agent. Reassign and resolve live under Comment, for people with that permission.</p>${!data.coverage?.complete?html`<p>History indexing is pending. Older requests remain in their source logs until verified indexing completes.</p>`:nothing}${(data.coverage?.notes||[]).map(n=>html`<p>${n}</p>`)}${(data.coverage?.errors||[]).map(n=>html`<p role="alert">${n}</p>`)}</details>`:html`<p>Loading requests…</p>`}${renderDrawer()}</section>`);
  requestAnimationFrame(()=>{const d=document.querySelector('dialog.lmx-drawer');if(d&&!d.open){try{d.showModal();const c=d.querySelector('.lmx-drawer-close');if(c)c.focus();}catch{}}});
 };
 const nudge=async item=>{
  if(pending.has(item.id))return;
  const key=space+':'+item.id,requestId=queueRequests.get(key)||crypto.randomUUID();queueRequests.set(key,requestId);pending.set(item.id,true);draw();
  try{await postJSON('/api/interactions','interactions',{target:{type:'coord',id:item.id},action:'nudge',text:'',requestId});if(!active())return;toast('Nudge recorded. The original deadline stays in place.');queueRequests.delete(key);pending.delete(item.id);await load({reset:true});}
  catch(e){if(!active()||e.stale)return;pending.delete(item.id);if(e.status&&e.status!==503)queueRequests.delete(key);error=e.message;draw();}
 };
 const load=async({reset=false}={})=>{
  const request=++requestSeq,after=reset?null:data?.nextAfter;
  if(reset){data=null;mp=0;selected.clear();openId='';}
  busy=true;error='';draw();
  try{
   const result=await getJSON(endpoint(null,{queue:'1',paging:'keyset',...(after?{after}:{}),...(recipient?{recipient}:{})}));
   if(!active()||result.__stale||request!==requestSeq)return false;
   if(result.__status!==200)throw new Error(result.error||'Could not load requests.');
   const previous=reset||!data?[]:data.items;
   data={...result,items:[...previous,...result.items]};
   observeTelemetry(space,{inbox:{value:result.items.length}});
   return true;
  }catch(e){if(active()&&request===requestSeq)error=e.message;return false;}
  finally{if(active()&&request===requestSeq){busy=false;draw();}}
 };
 const nextPage=async()=>{
  if(busy||!data)return;
  const current=sortOldestFirst(data.items).filter(i=>inBucket(i,bucket,Date.now())&&matchHandoff(i,flowSel,flowPair));
  if(mp<Math.ceil(current.length/MAIL_PAGE)-1){mp++;draw();return;}
  const hadRows=current.length>mp*MAIL_PAGE,needed=hadRows?(mp+1)*MAIL_PAGE:mp*MAIL_PAGE;
  while(data?.nextAfter!=null&&active()){
   const loaded=await load();if(!loaded)return;
   const matches=sortOldestFirst(data.items).filter(i=>inBucket(i,bucket,Date.now())&&matchHandoff(i,flowSel,flowPair));
   if(matches.length>needed){if(hadRows)mp++;draw();return;}
  }
 };
 await load({reset:true});
}
