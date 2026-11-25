// One record discussion and the canonical Inbox triage cockpit.
import {html,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {getJSON,postJSON,state,onContextReset,ago,agentName,toast} from './core.js';
import {load as loadView} from './data.js';
import {renderView} from './shell.js';
import {handoffMap} from './flow-views.js';
import {handoffArcs,matchHandoff} from './flow-model.js';
import {agentDispatchButton} from './dispatch-components.js';
import {observeTelemetry} from './telemetry-state.js';
import {ticketStatus,summaryPreview,ticketPrompt,ticketAgeBadge,mailRange} from './dispatch-model.js';
import {BUCKETS,inBucket,bucketCounts,sortOldestFirst,queueSummary,dueChip,relTime,fullTime} from './brief-model.js';
import {splitHeadline,decisionProblem} from './dashboard-model.js';
import {agent as avatar,idChip,decision,textWithIds,joinDot} from './ui.js';
import {decide,doStep,doTask,doWork,setChangedHook} from './actions.js';
import {
  cleanAgent,
  sortDecisionsUrgency,
  splitQueueHandoffs,
  splitNeedsItems,
  extractFleetChips,
  extractArchiveEntries,
  filterArchive,
  computeCockpitStats,
  buildAgentComboboxOptions,
  isEditableTarget,
} from './inbox-cockpit-model.js';
const drafts=new Map(),queueRequests=new Map();let generation=0;let activeKeyHandler=null;
export function clearInteractions(){
  drafts.clear();queueRequests.clear();generation++;
  if(activeKeyHandler){window.removeEventListener('keydown',activeKeyHandler,true);activeKeyHandler=null;}
}
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
 const space=state.space,version=generation,route=location.hash,pending=new Map();
 let recipient='',recipientDraft='',comboOpen=false,comboIndex=-1;
 let error='',data=null,busy=false,requestSeq=0;
 let homeData=null,homeLoading=true,homeError='';
 let decData=null,decLoading=true,decError='';
 let logData=null,logLoading=true,logError='';
 let flowSel='',flowHover='',flowPair=null,flowView='map';
 let bucket=BUCKETS.some(([k])=>k===arg)?arg:'all';
 let mapOpen=false,openId='',selected=new Set(),mp=0;
 let showAllDecisions=false,agentOpen=bucket==='overdue',archiveOpen=false;
 let selectedReviews=new Set(),pendingAckJobs=new Set(),localArchive=[],undoToast=null;
 let archiveQuery='',archiveAgent='',archiveWindow='all';
 let expandedTexts=new Set(),kbIndex=-1,activeTab='decisions',slashAt=0;
 let noteOpenTrails=new Map(),actionExpandedTrails=new Set(),unfoldedDecisions=new Set();
 const MAIL_PAGE=10,UNDO_MS=4500;
 const active=()=>space===state.space&&version===generation&&location.hash===route;
 const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const scrollToId=(id)=>{
  requestAnimationFrame(()=>{
   const el=document.getElementById(id);
   if(el&&el.scrollIntoView)el.scrollIntoView({block:'start',behavior:reducedMotion()?'auto':'smooth'});
  });
 };
 const jumpToList=()=>scrollToId('lmx-queue-list');
 const toggleExpand=(key)=>{if(expandedTexts.has(key))expandedTexts.delete(key);else expandedTexts.add(key);draw();};
 const renderExpandable=(key,text,limit=150)=>{
  const str=String(text||'').trim();
  if(!str)return nothing;
  const open=expandedTexts.has(key);
  if(str.length<=limit)return html`<p class="lmx-cockpit-body">${textWithIds(str)}</p>`;
  return html`<p class="lmx-cockpit-body">${textWithIds(open?str:str.slice(0,limit).trimEnd()+'…')} <button type="button" class="lmx-inline-more" aria-expanded=${String(open)} @click=${(e)=>{e.stopPropagation();toggleExpand(key);}}>${open?'Show less':'Show more'}</button></p>`;
 };

 // Optimistic review acknowledge with Undo countdown toast (21st.dev Undo Feedback pattern)
 const commitAck=async(items)=>{
  const failed=[];
  for(const item of items){
   try{await postJSON('/api/confirm-done','work',{job:item.job});}
   catch{failed.push(item);}
  }
  if(!active())return;
  if(failed.length){
   const failedIds=new Set(failed.map(f=>f.job));
   for(const j of failedIds)pendingAckJobs.delete(j);
   localArchive=localArchive.filter(a=>!failedIds.has(a.job));
   toast(`Could not acknowledge ${failed.length} review${failed.length===1?'':'s'}. Restored to Reviews.`,true);
   draw();
  }else{
   await loadCockpitSideData();
  }
 };
 const flushUndoNow=()=>{
  if(!undoToast)return;
  const current=undoToast;
  clearTimeout(current.timer);
  undoToast=null;
  draw();
  commitAck(current.items);
 };
 const undoPendingAck=()=>{
  if(!undoToast)return;
  const current=undoToast;
  clearTimeout(current.timer);
  undoToast=null;
  const jobs=new Set(current.items.map(i=>i.job));
  for(const j of jobs)pendingAckJobs.delete(j);
  localArchive=localArchive.filter(a=>!jobs.has(a.job));
  toast(`Restored ${current.items.length} review${current.items.length===1?'':'s'}.`);
  draw();
 };
 const startAck=(items)=>{
  const valid=items.filter(i=>i&&i.job&&!pendingAckJobs.has(i.job));
  if(!valid.length)return;
  if(undoToast)flushUndoNow();
  const nowTs=Date.now();
  for(const item of valid){
   pendingAckJobs.add(item.job);
   selectedReviews.delete(item.job);
   localArchive=[{id:'ack:'+item.job+':'+nowTs,job:item.job,kind:'done',by:'you',ts:nowTs,summary:`Acknowledged review: ${item.summary||item.job}`,where:`job:${item.job}`,origin:''},...localArchive];
  }
  const timer=setTimeout(()=>{
   const current=undoToast;
   undoToast=null;
   draw();
   if(current)commitAck(current.items);
  },UNDO_MS);
  undoToast={items:valid,timer,startedAt:nowTs};
  draw();
 };

 const loadCockpitSideData=async()=>{
  const reqVersion=generation;
  const [hRes,dRes,lRes]=await Promise.all([
   loadView('home').catch(e=>({ok:false,error:e?.message||'Could not load fleet status.'})),
   loadView('decisions').catch(e=>({ok:false,error:e?.message||'Could not load decisions.'})),
   loadView('log').catch(e=>({ok:false,error:e?.message||'Could not load archive.'})),
  ]);
  if(!active()||reqVersion!==generation)return;
  homeLoading=false;decLoading=false;logLoading=false;
  if(hRes&&hRes.ok===false){homeError=hRes.error||'Could not load fleet status.';}
  else{homeData=hRes||{};homeError='';}
  if(dRes&&dRes.ok===false){decError=dRes.error||'Could not load decisions.';}
  else{decData=dRes||{};decError='';}
  if(lRes&&lRes.ok===false){logError=lRes.error||'Could not load archive.';}
  else{logData=lRes||{};logError='';}
  draw();
 };

 const registerKeys=()=>{
  if(activeKeyHandler){window.removeEventListener('keydown',activeKeyHandler,true);activeKeyHandler=null;}
  const onKey=(e)=>{
   if(!active())return;
   if(e.metaKey||e.ctrlKey||e.altKey)return;
   if(e.key==='Escape'){
    const input=document.getElementById('lmx-cockpit-agent-input');
    const inCombo=document.activeElement===input||e.target===input;
    if(inCombo||comboOpen){
     e.preventDefault();
     e.stopPropagation();
     comboOpen=false;
     if(input)input.blur();
     draw();
     return;
    }
    if(mapOpen){e.preventDefault();mapOpen=false;draw();}
    return;
   }
   if(isEditableTarget(e.target))return;
   if(e.key==='/'){
    e.preventDefault();
    e.stopImmediatePropagation();
    const input=document.getElementById('lmx-cockpit-agent-input');
    if(input){
     slashAt=Date.now();
     comboOpen=true;
     draw();
     setTimeout(()=>{input.focus();if(input.value==='/'&&recipientDraft===''){input.value='';}input.select();},20);
    }
    return;
   }
   const nodes=[...document.querySelectorAll('.lmx-cockpit-item')];
   if(!nodes.length)return;
   if(e.key==='j'||e.key==='k'){
    e.preventDefault();
    if(e.key==='j')kbIndex=kbIndex<nodes.length-1?kbIndex+1:0;
    else kbIndex=kbIndex>0?kbIndex-1:nodes.length-1;
    nodes.forEach((n,idx)=>{if(idx===kbIndex)n.setAttribute('data-kb-active','true');else n.removeAttribute('data-kb-active');});
    const cur=nodes[kbIndex];
    if(cur&&cur.scrollIntoView)cur.scrollIntoView({block:'nearest',behavior:reducedMotion()?'auto':'smooth'});
    return;
   }
   const cur=kbIndex>=0&&kbIndex<nodes.length?nodes[kbIndex]:nodes[0];
   if(!cur)return;
   if(e.key==='a'){
    const act=cur.querySelector('[data-kb-primary]');
    if(act&&!act.disabled){e.preventDefault();act.click();}
   }else if(e.key==='c'){
    const cLink=cur.querySelector('[data-kb-comment]');
    if(cLink){e.preventDefault();cLink.click();}
   }
  };
  activeKeyHandler=onKey;
  window.addEventListener('keydown',onKey,true);
 };
 registerKeys();

 const draw=()=>{
  if(!active())return;
  const now=Date.now();
  const loaded=data?sortOldestFirst(data.items):[];
  const counts=bucketCounts(loaded,now);
  const {human:humanQueueAll,agentToAgent:agentQueueAll}=splitQueueHandoffs(loaded);
  const shownHumanQueue=humanQueueAll.filter(i=>inBucket(i,bucket,now)&&matchHandoff(i,flowSel,flowPair));
  const shownAgentQueue=agentQueueAll.filter(i=>inBucket(i,bucket,now)&&matchHandoff(i,flowSel,flowPair));
  const mpMax=Math.max(0,Math.ceil(shownAgentQueue.length/MAIL_PAGE)-1);if(mp>mpMax)mp=mpMax;
  const pageItems=shownAgentQueue.slice(mp*MAIL_PAGE,mp*MAIL_PAGE+MAIL_PAGE);

  const rawNeeds=Array.isArray(homeData?.needs_items)?homeData.needs_items:[];
  const {tasks:humanTasks,reviews:allReviews}=splitNeedsItems(rawNeeds);
  const reviews=allReviews.filter(r=>r&&r.job&&!pendingAckJobs.has(r.job));
  const rawWaiting=Array.isArray(decData?.waiting)?decData.waiting:[];
  const sortedDecisions=sortDecisionsUrgency(rawWaiting);
  const visibleDecisions=showAllDecisions?sortedDecisions:sortedDecisions.slice(0,3);

  const agents=Array.isArray(homeData?.agents)?homeData.agents:[];
  const fleet=extractFleetChips(agents,now,10);

  const rawLogEntries=Array.isArray(logData?.entries)?logData.entries:[];
  const archiveAll=extractArchiveEntries(rawLogEntries,localArchive);
  const filteredArchive=filterArchive(archiveAll,{query:archiveQuery,agent:archiveAgent,windowDays:archiveWindow},now);

  const stats=computeCockpitStats({
   decisions:sortedDecisions,
   humanHandoffs:humanQueueAll,
   humanTasks,
   reviews,
   agentHandoffs:agentQueueAll,
   agents,
   now,
  });

  const agentOptions=buildAgentComboboxOptions(loaded,agents,archiveAll);
  const filteredOptions=agentOptions.filter(opt=>!recipientDraft.trim()||opt.toLowerCase().includes(recipientDraft.trim().toLowerCase()));

  const nudgeState=item=>{const next=Number(item.last_nudge_at||0)+300000,invalid=Number(item.created_at)>Date.now()||!Number.isFinite(Number(item.deadline))||Number(item.deadline)<Number(item.created_at)||!Number.isFinite(Number(item.created_at))||Number(item.created_at)<=0;return {next,invalid,disabled:state.customer&&!state.permissions?.write||next>Date.now()||invalid||pending.has(item.id)};};
  const closeDrawer=()=>{openId='';draw();};

  const renderQueueRow=item=>{
   const st=ticketStatus(item,now),due=dueChip(item,now),{head,body}=splitHeadline(summaryPreview(item.summary)),{disabled}=nudgeState(item);
   const expandKey='q:'+item.id;
   return html`<li class="lmx-inbox-row lmx-cockpit-item" data-status=${st}>
    <label class="lmx-mail-check"><input type="checkbox" aria-label=${'Select request from '+agentName(item.from)} .checked=${selected.has(item.id)} @change=${e=>{if(e.target.checked)selected.add(item.id);else selected.delete(item.id);draw();}}></label>
    <span class="lmx-inbox-who" aria-hidden="true">${avatar(item.from)}<span>→</span>${avatar(item.to)}</span>
    <div class="lmx-inbox-main">
     <button type="button" class="lmx-inbox-open" aria-label=${'Open request from '+agentName(item.from)+' to '+agentName(item.to)+': '+head} @click=${()=>{openId=item.id;draw();}}>
      <span class="lmx-inbox-route">${agentName(item.from)} → ${agentName(item.to)}</span>
      <span class="lmx-inbox-title lmx-cockpit-qhead">${head}</span>
     </button>
     ${body?renderExpandable(expandKey,body,140):nothing}
     <span class="lmx-inbox-meta"><span class="lmx-due-chip" data-tone=${due.tone||nothing}>${due.text}</span><time class="lmx-meta" title=${fullTime(item.created_at)}>opened ${relTime(item.created_at,now)}</time>${item.where?html`<span class="lmx-cockpit-chip" title=${item.where}>${item.where.replace(/^job:/,'')}</span>`:nothing}</span>
    </div>
    <div class="lmx-inbox-acts">
     ${agentDispatchButton(ticketPrompt(item,space))}
     <button type="button" class="lm-btn lm-btn--secondary" data-kb-primary ?disabled=${disabled} @click=${()=>nudge(item)}>Nudge ${agentName(item.to)}</button>
     <a class="lm-btn lm-btn--ghost" data-kb-comment href=${link({type:'coord',id:item.id})}>Comment</a>
    </div>
   </li>`;
  };

  const renderHumanTask=item=>{
   const b=item.task||{},w=b.walkthrough||{},steps=Array.isArray(w.steps)?w.steps:[],done=Array.isArray(b.steps_done)?b.steps_done:[];
   const dueTone=w.due&&Date.parse(w.due)<now?'danger':w.due?'warning':'';
   return html`<li class="lmx-cockpit-card lmx-cockpit-item" data-kind="task">
    <div class="lmx-cockpit-rowhead">
     <span class="lmx-cockpit-badge" data-tone="brand">Task</span>
     <span class="lmx-cockpit-qhead">${b.summary||'Human task'}</span>
     ${w.due?html`<span class="lmx-due-chip" data-tone=${dueTone||nothing}>due ${w.due}</span>`:nothing}
    </div>
    <div class="lmx-inbox-meta">
     <span>${joinDot([b.by?'from '+agentName(b.by):'',item.plan,item.job,steps.length?`${done.length} of ${steps.length} steps`:''])}</span>
    </div>
    ${steps.length?html`<ol class="lmx-steps lmx-cockpit-steps">${steps.map((st,k)=>html`<li><input type="checkbox" .checked=${done.indexOf(k)>=0} @change=${e=>doStep(e,b.trail,k,b.rev||0)} aria-label=${`Step ${k+1} done`}><div style="min-width:0"><span class="lmx-step-title">${st.title}</span>${st.detail?renderExpandable(`task:${b.trail}:${k}`,st.detail,120):nothing}</div></li>`)}</ol>`:nothing}
    <div class="lmx-cockpit-foot">
     <input class="lm-input lmx-cockpit-note" data-note-for=${'task:'+b.trail} maxlength="300" placeholder="Note, or why you can’t do it" aria-label="Note for task">
     <div class="lmx-cockpit-acts">
      <button type="button" class="lm-btn lm-btn--primary" data-kb-primary @click=${e=>doTask(e,'done',b.trail)}>Done</button>
      <button type="button" class="lm-btn lm-btn--danger" @click=${e=>doTask(e,'cant_do',b.trail)}>Can’t do</button>
      <a class="lm-btn lm-btn--ghost" data-kb-comment href=${link({type:'task',id:b.trail})}>Comment</a>
     </div>
    </div>
   </li>`;
  };

  const copyActionText=(text)=>{
   if(!text)return;
   navigator.clipboard.writeText(text).then(()=>toast('Proposed action copied'),()=>toast('Could not copy action.',true));
  };

  const renderDecisionCard=(a,idx)=>{
   const p=a.payload||{},irr=p.reversible!==true;
   const problem=decisionProblem(a,'approve')||(!a.ask_digest?'Reload to verify the action version.':null);
   const expandKey='dec:'+a.trail;
   const summary=String(a.summary||'Untitled decision');
   const isLong=summary.length>150,isOpen=expandedTexts.has(expandKey);
   const folded=idx>=2&&!unfoldedDecisions.has(a.trail);
   const noteMode=noteOpenTrails.get(a.trail)||'';
   const actionExpanded=actionExpandedTrails.has(a.trail);
   const actionStr=String(p.action||'').trim();
   const actionFirstLine=actionStr.split(/\r?\n/)[0]||'';
   const actionLong=actionStr.includes('\n')||actionStr.length>88;

   const openComposer=(mode)=>{
    noteOpenTrails.set(a.trail,mode);
    unfoldedDecisions.add(a.trail);
    draw();
    requestAnimationFrame(()=>{
     const el=document.querySelector(`[data-note-for="${CSS.escape('ask:'+a.trail)}"]`);
     if(el)el.focus();
    });
   };

   const onRequestChanges=(e)=>{
    const el=document.querySelector(`[data-note-for="${CSS.escape('ask:'+a.trail)}"]`);
    if(el&&el.value.trim()){
     decide(e,a,'reject');
     return;
    }
    openComposer('changes');
   };

   return html`<article class="lm-approval lmx-di-row lmx-cockpit-item" data-irreversible=${String(irr)} data-folded=${String(folded)} data-key=${'decision:'+a.trail}>
    <div class="lmx-di-shell">
     <span class="lmx-di-icon" data-tone=${irr?'danger':'decision'} aria-hidden="true">${irr
      ?html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2.2 13.8 12.6a1 1 0 0 1-.87 1.5H3.07a1 1 0 0 1-.87-1.5L8 2.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.2v3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".8" fill="currentColor"/></svg>`
      :html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.4"/><path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.7c0 1-1.1 1.4-1.6 1.8v.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".8" fill="currentColor"/></svg>`}</span>
     <div class="lmx-di-content">
      <div class="lmx-di-top">
       ${folded
        ?html`<button type="button" class="lmx-di-title lmx-di-title--folded" @click=${()=>{unfoldedDecisions.add(a.trail);draw();}}>${summary}</button>`
        :html`<p class="lmx-di-title">${isLong&&!isOpen?summary.slice(0,150).trimEnd()+'…':summary}${isLong?html` <button type="button" class="lmx-inline-more" aria-expanded=${String(isOpen)} @click=${()=>toggleExpand(expandKey)}>${isOpen?'Show less':'Show more'}</button>`:nothing}</p>`}
       <div class="lmx-di-pills">
        <span class="lmx-cockpit-badge" data-tone=${irr?'danger':'neutral'}>${irr?'Irreversible':'Reversible'}</span>
        ${a.deferred?decision('deferred'):nothing}
       </div>
      </div>

      <div class="lmx-di-meta">
       <span class="lmx-cockpit-agent">${avatar(a.by)}</span>
       ${a.ts?html`<time class="lmx-meta" title=${fullTime(a.ts)}>${ago(a.ts)}</time>`:nothing}
       ${a.where?html`<span class="lmx-cockpit-chip" title=${a.where}>${a.where.replace(/^job:/,'')}</span>`:nothing}
       ${folded?html`<button type="button" class="lmx-inline-more lmx-di-unfold" @click=${()=>{unfoldedDecisions.add(a.trail);draw();}}>Review</button>`:nothing}
      </div>

      <div class="lmx-di-body" data-open=${String(!folded)}>
       <div class="lmx-di-body-inner">
        ${actionStr?html`<div class="lmx-di-actionbox" data-expanded=${String(actionExpanded)}>
         <div class="lmx-di-actionbar">
          <span class="lmx-di-actionlabel">Action</span>
          <code class="lmx-di-actionpreview" title=${actionStr}>${actionFirstLine}</code>
          <div class="lmx-di-actionbtns">
           ${actionLong?html`<button type="button" class="lmx-di-microbtn" aria-expanded=${String(actionExpanded)} @click=${()=>{if(actionExpanded)actionExpandedTrails.delete(a.trail);else actionExpandedTrails.add(a.trail);draw();}}>${actionExpanded?'Hide':'Details'}</button>`:nothing}
           <button type="button" class="lmx-di-microbtn" @click=${()=>copyActionText(actionStr)}>Copy</button>
          </div>
         </div>
         ${actionExpanded?html`<pre class="lmx-di-pre">${actionStr}</pre>`:nothing}
        </div>`:nothing}

        ${problem?html`<p class="lmx-meta lmx-di-problem" role="status">${problem}</p>`:nothing}

        <div class="lmx-di-acts">
         <button type="button" class="lmx-di-btn lmx-di-btn--approve" data-kb-primary ?disabled=${!!problem} @click=${e=>decide(e,a,'approve')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.3 3 3 6-6.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Approve
         </button>
         <button type="button" class="lmx-di-btn lmx-di-btn--changes" aria-expanded=${String(noteMode==='changes')} @click=${onRequestChanges}>Request changes</button>
         ${!a.deferred?html`<button type="button" class="lmx-di-btn lmx-di-btn--sunken" @click=${e=>decide(e,a,'defer')}>Decide later</button>`:nothing}
         <span class="lmx-di-spacer"></span>
         <button type="button" class="lmx-di-linkbtn" aria-expanded=${String(!!noteMode)} @click=${()=>{if(noteMode){noteOpenTrails.delete(a.trail);draw();}else openComposer('note');}}>${noteMode?'Hide note':'+ Note'}</button>
         <a class="lmx-di-linkbtn" data-kb-comment href=${link({type:'decision',id:a.trail})}>Comment</a>
        </div>

        <div class="lmx-di-composer" data-open=${String(!!noteMode)}>
         <div class="lmx-di-composer-inner">
          <div class="lmx-di-composer-row">
           <input class="lm-input lmx-di-noteinput" data-note-for=${'ask:'+a.trail} maxlength="1000" autocomplete="off" placeholder=${noteMode==='changes'?'Explain what should change (required)…':'Add an optional note for the agent…'} aria-label="Note for decision" @keydown=${e=>{if(e.key==='Enter'&&noteMode==='changes'){e.preventDefault();decide(e,a,'reject');}else if(e.key==='Escape'){noteOpenTrails.delete(a.trail);draw();}}}>
           ${noteMode==='changes'?html`<button type="button" class="lmx-di-btn lmx-di-btn--danger-solid" @click=${e=>decide(e,a,'reject')}>Send changes</button>`:nothing}
           <button type="button" class="lmx-di-btn lmx-di-btn--sunken" @click=${()=>{noteOpenTrails.delete(a.trail);draw();}}>Cancel</button>
          </div>
         </div>
        </div>
       </div>
      </div>
     </div>
    </div>
   </article>`;
  };

  const renderReviewRow=item=>{
   const checked=selectedReviews.has(item.job);
   return html`<li class="lmx-cockpit-review lmx-cockpit-item">
    <label class="lmx-mail-check"><input type="checkbox" aria-label=${'Select review for '+(item.summary||item.job)} .checked=${checked} @change=${e=>{if(e.target.checked)selectedReviews.add(item.job);else selectedReviews.delete(item.job);draw();}}></label>
    <div class="lmx-inbox-main">
     <div class="lmx-cockpit-rowhead">
      <a class="lmx-cockpit-qhead lmx-cockpit-link" href=${'#/job/'+encodeURIComponent(item.job)}>${item.summary||item.job}</a>
      <span class="lmx-cockpit-badge" data-tone="warning">Needs review</span>
     </div>
     ${item.evidence?renderExpandable('rev:'+item.job,item.evidence,150):nothing}
     <div class="lmx-inbox-meta">
      ${item.owner?html`<span class="lmx-cockpit-agent">${avatar(item.owner)}</span>`:nothing}
      ${item.plan?html`<span class="lmx-cockpit-chip" title=${item.plan}>${item.plan}</span>`:nothing}
      ${item.created_at?html`<time class="lmx-meta">checked ${ago(item.created_at)}</time>`:nothing}
     </div>
    </div>
    <div class="lmx-inbox-acts">
     <button type="button" class="lm-btn lm-btn--primary" data-kb-primary @click=${()=>startAck([item])}>Acknowledge</button>
     <button type="button" class="lm-btn lm-btn--ghost" @click=${e=>doWork(e,'keep-open',item.job)}>Still open</button>
     <a class="lm-btn lm-btn--ghost" data-kb-comment href=${'#/job/'+encodeURIComponent(item.job)}>Open</a>
    </div>
   </li>`;
  };

  const renderDrawer=()=>{
   const item=data&&openId?data.items.find(i=>i.id===openId):null;
   if(!item)return nothing;
   const {next,invalid,disabled}=nudgeState(item),st=ticketStatus(item,now);
   return html`<dialog class="lmx-drawer lm-inbox-sheet" data-status=${st} aria-label="Request details" @cancel=${e=>{e.preventDefault();closeDrawer();}} @click=${e=>{if(e.target===e.currentTarget)closeDrawer();}}>
    <header class="lmx-drawer-head lm-sheet-head"><div class="lm-sheet-titles"><span class="lm-sheet-eyebrow">Coordination request</span><h2 class="lm-sheet-route">${avatar(item.from)}<span class="lm-sheet-arrow" aria-hidden="true">→</span>${avatar(item.to)}</h2></div><button type="button" class="lm-btn lm-btn--ghost lmx-drawer-close" aria-label="Close details" @click=${closeDrawer}>Close</button></header>
    <div class="lmx-drawer-body lm-sheet-body"><div class="lm-sheet-status-row"><span class="lmx-drawer-status lm-sheet-pill" data-status=${st}>${ticketAgeBadge(item)}</span><span class="lm-sheet-type">${item.type}</span></div><section class="lm-sheet-summary"><p class="lmx-drawer-summary">${item.summary}</p></section><dl class="lm-sheet-kv"><dt>Created</dt><dd>${stamp(item.created_at)}</dd><dt>Deadline</dt><dd>${stamp(item.deadline)}</dd><dt>Last nudge</dt><dd>${item.last_nudge_at?stamp(item.last_nudge_at):'None recorded'}</dd><dt>Source</dt><dd>${item.where||'Not recorded'}</dd><dt>Type</dt><dd>${item.type}</dd><dt>ID</dt><dd>${idChip(item.id)}</dd></dl>${invalid?html`<p class="lm-sheet-warn" role="alert">Check the source timestamps before nudging.</p>`:nothing}${next>Date.now()?html`<p class="lmx-meta">Next nudge available ${stamp(next)}.</p>`:nothing}</div>
    <footer class="lmx-drawer-foot lm-sheet-foot"><div class="lm-sheet-foot-primary">${agentDispatchButton(ticketPrompt(item,space))}<button type="button" class="lm-btn lm-btn--primary" ?disabled=${disabled} @click=${()=>nudge(item)}>Nudge ${agentName(item.to)}</button>${queueRequests.has(space+':'+item.id)?html`<button type="button" class="lm-btn lm-btn--secondary" ?disabled=${pending.has(item.id)} @click=${()=>nudge(item)}>Retry nudge delivery</button>`:nothing}</div><div class="lm-sheet-foot-links"><a class="lm-btn lm-btn--secondary" href=${link({type:'coord',id:item.id})}>Comments and actions</a>${item.where?.startsWith('job:')?html`<a class="lm-btn lm-btn--ghost" href=${'#/job/'+encodeURIComponent(item.where.slice(4))}>Open work →</a>`:nothing}</div></footer>
   </dialog>`;
  };

  const selectedItems=data?data.items.filter(i=>selected.has(i.id)):[];
  const batchBar=selectedItems.length?html`<div class="lmx-mail-batch" role="status"><span>${selectedItems.length} selected</span>${agentDispatchButton(selectedItems.map(i=>ticketPrompt(i,space)).join('\n\n---\n\n'),'Copy prompts')}<button type="button" class="lm-btn lm-btn--ghost" @click=${()=>{selected.clear();draw();}}>Clear</button></div>`:nothing;
  const emptyAgent=!loaded.length?(data?.coverage?.complete?'All clear — no open agent-to-agent handoffs.':'No indexed requests are open. Older requests may still sit in source logs.'):(flowSel||flowPair)?'No requests match this map filter. Clear the filter to view all.':'No agent-to-agent handoffs in this bucket.';

  const humanTotal=shownHumanQueue.length+humanTasks.length;
  const totalHandoffs=humanTotal+agentQueueAll.length;
  const allReviewsChecked=reviews.length>0&&reviews.every(r=>selectedReviews.has(r.job));
  const selectedReviewList=reviews.filter(r=>selectedReviews.has(r.job));

  const tabs=[
   {id:'decisions',label:'Decisions',count:sortedDecisions.length,target:'cockpit-decisions'},
   {id:'handoffs',label:'Handoffs',count:totalHandoffs,target:humanTotal>0?'cockpit-handoffs':'cockpit-agent-handoffs'},
   {id:'reviews',label:'Reviews',count:reviews.length,target:'cockpit-reviews'},
   {id:'archive',label:'Archive',count:archiveAll.length,target:'cockpit-archive'},
  ];

  const onStatClick=(st)=>{
   if(st.action==='filter-overdue'){
    bucket=bucket==='overdue'?'all':'overdue';
    if(bucket==='overdue')agentOpen=true;
    load({reset:true});
    scrollToId(humanQueueAll.some(i=>ticketStatus(i,now)==='overdue')?'cockpit-handoffs':'cockpit-agent-handoffs');
   }else if(st.target){
    if(st.target==='cockpit-agent-handoffs')agentOpen=true;
    draw();
    scrollToId(st.target);
   }
  };

  renderView('queue',['Inbox'],html`<section class="lmx-queue lmx-cockpit">
   <header class="lmx-cockpit-head">
    <div class="lmx-cockpit-titleblock">
     <h1>Inbox</h1>
     <span class="lmx-kbd-hint" aria-label="Keyboard shortcuts"><kbd>j</kbd><kbd>k</kbd> move · <kbd>a</kbd> act · <kbd>c</kbd> comment · <kbd>/</kbd> filter</span>
    </div>
    <div class="lmx-cockpit-controls">
     <form class="lmx-filters lmx-inbox-filter lmx-combobox-form" @submit=${e=>{e.preventDefault();comboOpen=false;recipientDraft=e.target.recipient.value.trim();recipient=e.target.recipient.value.trim();load({reset:true});}}>
      <div class="lmx-combobox">
       <input id="lmx-cockpit-agent-input" class="lm-input lmx-combobox-input" name="recipient" role="combobox" aria-label="Filter by recipient agent" aria-expanded=${String(comboOpen)} aria-controls="lmx-agent-listbox" aria-autocomplete="list" autocomplete="off" maxlength="64" placeholder="Filter by agent…" .value=${recipientDraft} ?disabled=${busy}
        @focus=${()=>{comboOpen=true;comboIndex=-1;draw();}}
        @blur=${()=>setTimeout(()=>{comboOpen=false;draw();},150)}
        @input=${e=>{if(Date.now()-slashAt<150&&e.target.value==='/'&&recipientDraft===''){e.target.value='';return;}recipientDraft=e.target.value;comboOpen=true;comboIndex=-1;draw();}}
        @keydown=${e=>{
         if(e.key==='ArrowDown'){e.preventDefault();comboOpen=true;comboIndex=Math.min(filteredOptions.length-1,comboIndex+1);draw();}
         else if(e.key==='ArrowUp'){e.preventDefault();comboIndex=Math.max(-1,comboIndex-1);draw();}
         else if(e.key==='Enter'&&comboOpen&&comboIndex>=0&&filteredOptions[comboIndex]){e.preventDefault();recipient=filteredOptions[comboIndex];recipientDraft=recipient;comboOpen=false;load({reset:true});}
        }}>
       ${recipient?html`<button type="button" class="lmx-combobox-clear" aria-label="Clear agent filter" @click=${()=>{recipient='';recipientDraft='';comboOpen=false;load({reset:true});}}>×</button>`:nothing}
       ${comboOpen&&filteredOptions.length?html`<ul id="lmx-agent-listbox" class="lmx-combobox-list" role="listbox">${filteredOptions.slice(0,10).map((opt,idx)=>html`<li role="option" aria-selected=${String(opt===recipient)} data-active=${String(idx===comboIndex)} @mousedown=${e=>{e.preventDefault();recipient=opt;recipientDraft=opt;comboOpen=false;load({reset:true});}}>${opt}</li>`)}</ul>`:nothing}
      </div>
      <button class="lm-btn lm-btn--secondary" ?disabled=${busy}>Filter</button>
     </form>
     <button type="button" class="lm-btn lm-btn--ghost" @click=${()=>{mapOpen=true;draw();}}>Request map${flowSel||flowPair?' · active':''}</button>
     ${flowSel||flowPair?html`<button type="button" class="lm-btn lm-btn--ghost" @click=${()=>{flowSel='';flowPair=null;load({reset:true});}}>Clear map filter</button>`:nothing}
    </div>
   </header>

   ${error?html`<p class="lmx-cockpit-err" role="alert">${error} <button type="button" class="lm-btn lm-btn--ghost" @click=${()=>load({reset:true})}>Retry</button></p>`:nothing}

   <nav class="lmx-cockpit-tabs" aria-label="Inbox sections">
    ${tabs.map(t=>html`<button type="button" class="lmx-cockpit-tab" aria-current=${activeTab===t.id?'true':nothing} @click=${()=>{
     activeTab=t.id;
     if(t.id==='archive')archiveOpen=true;
     if(t.target==='cockpit-agent-handoffs')agentOpen=true;
     draw();
     scrollToId(t.target);
    }}><span>${t.label}</span><span class="lmx-tab-badge" data-zero=${t.count===0?'true':nothing}>${t.count}</span></button>`)}
   </nav>

   <section class="lmx-cockpit-glance" aria-label="At a glance">
    <div class="lmx-cockpit-stats">
     ${stats.map(st=>st.href
      ?html`<a class="lmx-stat-tile lmx-cockpit-stat" href=${st.href} data-tone=${st.tone} ?data-zero=${st.value===0}><span class="lmx-stat-label">${st.label}</span><strong>${st.value}</strong><span class="lmx-stat-sub">${st.sub}</span></a>`
      :html`<button type="button" class="lmx-stat-tile lmx-cockpit-stat" data-tone=${st.tone} ?data-zero=${st.value===0} ?data-active=${st.action==='filter-overdue'&&bucket==='overdue'} @click=${()=>onStatClick(st)}><span class="lmx-stat-label">${st.label}</span><strong>${st.value}</strong><span class="lmx-stat-sub">${st.sub}</span></button>`)}
    </div>

    <div class="lmx-fleet-bar" aria-label="Fleet right now">
     <div class="lmx-fleet-head">
      <span class="lmx-fleet-title">Fleet right now</span>
      <span class="lmx-meta">${fleet.activeCount} active${fleet.blockedCount?` · ${fleet.blockedCount} blocked`:''}</span>
      <a class="lmx-fleet-all" href="#/agents">View all ${fleet.total}</a>
     </div>
     ${homeLoading?html`<div class="lmx-cockpit-skel" aria-busy="true"><span class="lm-skeleton"></span><span class="lm-skeleton"></span><span class="lm-skeleton"></span></div>`
      :homeError?html`<p class="lmx-cockpit-err" role="alert">${homeError} <button type="button" class="lm-btn lm-btn--ghost" @click=${loadCockpitSideData}>Retry</button></p>`
      :fleet.chips.length?html`<ul class="lmx-fleet-chips">${fleet.chips.map(c=>html`<li><a class="lmx-fleet-chip" href=${'#/agent/'+encodeURIComponent(c.id)} data-status=${c.status} title=${`${c.name} (${c.statusLabel}) — ${c.currentJob} · ${c.lastWrite}`}>
       <span class="lmx-fleet-dot" data-status=${c.status} aria-hidden="true"></span>
       <span class="lmx-fleet-name">${c.name}</span>
       <span class="lmx-fleet-job">${c.currentJob}</span>
       <span class="lmx-fleet-time">${c.lastWrite}</span>
      </a></li>`)}</ul>`
      :html`<p class="lmx-allclear">No agents connected yet.</p>`}
    </div>
   </section>

   <section id="cockpit-decisions" class="lmx-cockpit-sec" aria-labelledby="sec-decisions-h">
    ${decLoading?html`<div class="lmx-cockpit-sechead"><h2 id="sec-decisions-h">Decisions</h2></div><div class="lmx-cockpit-skel" aria-busy="true"><span class="lm-skeleton"></span><span class="lm-skeleton"></span></div>`
     :decError?html`<div class="lmx-cockpit-sechead"><h2 id="sec-decisions-h">Decisions</h2></div><p class="lmx-cockpit-err" role="alert">${decError} <button type="button" class="lm-btn lm-btn--ghost" @click=${loadCockpitSideData}>Retry</button></p>`
     :visibleDecisions.length?html`<div class="lmx-di-tray" data-has-irreversible=${String(sortedDecisions.some(d=>(d.payload||{}).reversible!==true))}>
      <header class="lmx-di-trayhead">
       <div class="lmx-di-traytitle">
        <span class="lmx-di-orb" aria-hidden="true"></span>
        <h2 id="sec-decisions-h">Decisions</h2>
        <span class="lmx-sec-count" data-tone="decision">${sortedDecisions.length}</span>
        <span class="lmx-di-sub">${sortedDecisions.length===1?'1 needs your input':`${sortedDecisions.length} need your input`}${sortedDecisions.some(d=>(d.payload||{}).reversible!==true)?' · irreversible first':''}</span>
       </div>
       <div class="lmx-sec-meta">
        ${sortedDecisions.length>3?html`<button type="button" class="lmx-di-linkbtn" @click=${()=>{showAllDecisions=!showAllDecisions;draw();}}>${showAllDecisions?'Show top 3':`See all ${sortedDecisions.length}`}</button>`:nothing}
        <a class="lmx-di-linkbtn" href="#/decisions">Open board</a>
       </div>
      </header>
      <div class="lmx-di-card">${visibleDecisions.map((a,idx)=>renderDecisionCard(a,idx))}</div>
     </div>`
     :html`<div class="lmx-cockpit-sechead"><h2 id="sec-decisions-h">Decisions <span class="lmx-sec-count" data-tone="neutral">0</span></h2><a class="lmx-di-linkbtn" href="#/decisions">Open board</a></div><p class="lmx-allclear">All clear — no decisions waiting on you.</p>`}
   </section>

   <section id="cockpit-handoffs" class="lmx-cockpit-sec" aria-labelledby="sec-handoffs-h">
    <div class="lmx-cockpit-sechead">
     <h2 id="sec-handoffs-h">Human handoffs &amp; tasks <span class="lmx-sec-count" data-tone=${humanTotal?'brand':'neutral'}>${humanTotal}</span></h2>
     ${bucket==='overdue'?html`<button type="button" class="lm-btn lm-btn--ghost" @click=${()=>{bucket='all';load({reset:true});}}>Showing overdue · Clear</button>`:nothing}
    </div>
    ${!data&&busy?html`<div class="lmx-cockpit-skel" aria-busy="true"><span class="lm-skeleton"></span></div>`
     :humanTotal?html`<ul class="lmx-inbox" aria-label="Human handoffs and tasks">${shownHumanQueue.map(renderQueueRow)}${humanTasks.map(renderHumanTask)}</ul>`
     :html`<p class="lmx-allclear">All clear — no handoffs or tasks addressed directly to you.</p>`}
   </section>

   <section id="cockpit-reviews" class="lmx-cockpit-sec" aria-labelledby="sec-reviews-h">
    <div class="lmx-cockpit-sechead">
     <h2 id="sec-reviews-h">Reviews to acknowledge <span class="lmx-sec-count" data-tone=${reviews.length?'warning':'neutral'}>${reviews.length}</span></h2>
     ${reviews.length?html`<div class="lmx-sec-meta">
      <label class="lmx-check-inline"><input type="checkbox" .checked=${allReviewsChecked} @change=${e=>{if(e.target.checked)reviews.forEach(r=>selectedReviews.add(r.job));else selectedReviews.clear();draw();}}> Select all</label>
      <button type="button" class="lm-btn lm-btn--primary" @click=${()=>startAck(selectedReviewList.length?selectedReviewList:reviews)}>${selectedReviewList.length?`Acknowledge selected (${selectedReviewList.length})`:`Acknowledge all (${reviews.length})`}</button>
     </div>`:nothing}
    </div>
    ${homeLoading?html`<div class="lmx-cockpit-skel" aria-busy="true"><span class="lm-skeleton"></span></div>`
     :reviews.length?html`<ul class="lmx-inbox" aria-label="Reviews to acknowledge">${reviews.map(renderReviewRow)}</ul>`
     :html`<p class="lmx-allclear">All clear — no reviews waiting to acknowledge.</p>`}
   </section>

   <details id="cockpit-agent-handoffs" class="lmx-cockpit-collapse" ?open=${agentOpen} @toggle=${e=>{agentOpen=e.currentTarget.open;draw();}}>
    <summary class="lmx-cockpit-collapse-head">
     <span class="lmx-collapse-title">Agent-to-agent handoffs</span>
     <span class="lmx-sec-count" data-tone=${agentQueueAll.length?'neutral':'neutral'}>${agentQueueAll.length}</span>
     ${counts.overdue?html`<span class="lmx-cockpit-badge" data-tone="danger">${counts.overdue} overdue</span>`:nothing}
     <span class="lmx-collapse-hint">${agentOpen?'Hide':'Expand'}</span>
    </summary>
    <div class="lmx-cockpit-collapse-body">
     ${data?html`<div class="lmx-inbox-bar"><p class="lmx-inbox-summary" aria-live="polite"><strong>${queueSummary(pageItems,now)}</strong> <span class="lmx-meta">${data.indexedCount} indexed</span>${data.nextAfter!=null?html` <span class="lmx-meta">more requests available</span>`:nothing}</p>
      <div class="lmx-bucket-chips" role="group" aria-label="Age buckets">${BUCKETS.map(([value,label])=>html`<button type="button" class="lmx-typepill" aria-pressed=${String(bucket===value)} ?disabled=${busy} @click=${()=>{if(bucket!==value){bucket=value;load({reset:true});}}}>${label} ${counts[value]}</button>`)}</div></div>
      <div class="lmx-stack" id="lmx-queue-list">${batchBar}${pageItems.length?html`<ul class="lmx-inbox" aria-label="Agent-to-agent handoffs">${pageItems.map(renderQueueRow)}</ul>`:html`<p class="lmx-allclear">${emptyAgent}</p>`}</div>
      <div class="lmx-mail-foot"><span aria-live="polite">${mailRange(mp*MAIL_PAGE,pageItems.length,mp>=mpMax&&data.nextAfter!=null)}</span><button type="button" class="lm-btn lm-btn--ghost" aria-label="Previous page" ?disabled=${busy||mp<=0} @click=${()=>{if(mp>0){mp--;draw();}}}>‹</button><button type="button" class="lm-btn lm-btn--ghost" aria-label="Next page" ?disabled=${busy||mp>=mpMax&&data.nextAfter==null} @click=${nextPage}>›</button></div>`
     :html`<div class="lmx-cockpit-skel" id="lmx-queue-list" aria-busy="true"><span class="lm-skeleton"></span></div>`}
    </div>
   </details>

   <details id="cockpit-archive" class="lmx-cockpit-collapse" ?open=${archiveOpen} @toggle=${e=>{archiveOpen=e.currentTarget.open;draw();}}>
    <summary class="lmx-cockpit-collapse-head">
     <span class="lmx-collapse-title">Accepted handoffs archive</span>
     <span class="lmx-sec-count" data-tone="success">${archiveAll.length}</span>
     <span class="lmx-collapse-hint">${archiveOpen?'Hide':'Expand'}</span>
    </summary>
    <div class="lmx-cockpit-collapse-body">
     <div class="lmx-archive-filters">
      <input class="lm-input" type="search" placeholder="Search accepted handoffs &amp; decisions…" aria-label="Search archive" .value=${archiveQuery} @input=${e=>{archiveQuery=e.target.value;draw();}}>
      <select class="lm-select" aria-label="Filter archive by agent" .value=${archiveAgent} @change=${e=>{archiveAgent=e.target.value;draw();}}>
       <option value="">All agents</option>
       ${agentOptions.map(opt=>html`<option value=${opt}>${opt}</option>`)}
      </select>
      <div class="lmx-bucket-chips" role="group" aria-label="Archive date window">
       ${[['all','All'],['1','Today'],['7','7d'],['30','30d']].map(([val,lbl])=>html`<button type="button" class="lmx-typepill" aria-pressed=${String(archiveWindow===val)} @click=${()=>{archiveWindow=val;draw();}}>${lbl}</button>`)}
      </div>
     </div>
     ${logLoading?html`<div class="lmx-cockpit-skel" aria-busy="true"><span class="lm-skeleton"></span></div>`
      :logError?html`<p class="lmx-cockpit-err" role="alert">${logError} <button type="button" class="lm-btn lm-btn--ghost" @click=${loadCockpitSideData}>Retry</button></p>`
      :filteredArchive.length?html`<ul class="lmx-archive-list">${filteredArchive.slice(0,40).map(e=>html`<li class="lmx-archive-row">
       <span class="lmx-cockpit-badge" data-tone=${e.kind==='done'?'success':e.kind==='decided'?'decision':'brand'}>${e.kind}</span>
       <div class="lmx-archive-main">
        ${renderExpandable('arc:'+e.id,e.summary,160)}
        <div class="lmx-inbox-meta"><span>by <strong>${e.by}</strong></span>${e.ts?html`<time class="lmx-meta" title=${fullTime(e.ts)}>${relTime(e.ts,now)}</time>`:nothing}${e.where?html`<span class="lmx-cockpit-chip" title=${e.where}>${e.where.replace(/^job:/,'')}</span>`:nothing}</div>
       </div>
      </li>`)}</ul>`
      :html`<p class="lmx-allclear">No archive entries match these filters.</p>`}
    </div>
   </details>

   ${data?html`<details class="lmx-coverage lmx-coverage--quiet"><summary>About this list</summary><p>Age counts cover requests loaded so far. Use Next to load more. Copy prompt puts a prompt on your clipboard and starts no agent. Reassign and resolve live under Comment, for people with that permission.</p>${!data.coverage?.complete?html`<p>History indexing is pending. Older requests remain in their source logs until verified indexing completes.</p>`:nothing}${(data.coverage?.notes||[]).map(n=>html`<p>${n}</p>`)}${(data.coverage?.errors||[]).map(n=>html`<p role="alert">${n}</p>`)}</details>`:nothing}

   ${undoToast?html`<div class="lmx-undo-toast" role="status" aria-live="polite">
    <span class="lmx-undo-dot" aria-hidden="true"></span>
    <span>Acknowledged ${undoToast.items.length} review${undoToast.items.length===1?'':'s'}</span>
    <button type="button" class="lm-btn lm-btn--secondary lmx-undo-btn" @click=${undoPendingAck}>Undo</button>
    <button type="button" class="lm-btn lm-btn--ghost lmx-undo-dismiss" aria-label="Dismiss" @click=${flushUndoNow}>×</button>
   </div>`:nothing}

   ${renderDrawer()}
   ${mapOpen?html`<dialog class="lmx-queue-map" data-dialog="map" aria-label="Request map" @cancel=${e=>{e.preventDefault();mapOpen=false;draw();}} @click=${e=>{if(e.target===e.currentTarget){mapOpen=false;draw();}}}>
    <header class="lmx-map-head"><div><h2>Request map</h2><p class="lmx-meta">Who sends requests to whom. Click an agent or cell to filter.</p></div><button type="button" class="lm-btn lm-btn--ghost lmx-map-close" @click=${()=>{mapOpen=false;draw();}}>Close</button></header>
    <div class="lmx-map-canvas">${data&&data.items.length?handoffMap({arcs:handoffArcs(data.items),sel:flowSel,hover:flowHover,pair:flowPair,view:flowView,setView:v=>{flowView=v;flowPair=null;draw();},pick:s=>{flowSel=s;flowPair=null;mapOpen=false;agentOpen=true;load({reset:true});if(s)jumpToList();},peek:h=>{if(h!==flowHover){flowHover=h;draw();}},pickPair:x=>{flowPair=x;flowSel='';mapOpen=false;agentOpen=true;load({reset:true});if(x)jumpToList();}}):html`<p class="lmx-meta">No open requests to map yet.</p>`}</div>
   </dialog>`:nothing}
  </section>`);

  requestAnimationFrame(()=>{
   const d=document.querySelector('dialog.lmx-drawer');
   if(d&&!d.open){try{d.showModal();const c=d.querySelector('.lmx-drawer-close');if(c)c.focus();}catch{}}
   const m=document.querySelector('dialog.lmx-queue-map');
   if(m&&!m.open){try{m.showModal();const c=m.querySelector('.lmx-map-close');if(c)c.focus();}catch{}}
  });
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
  const current=splitQueueHandoffs(sortOldestFirst(data.items)).agentToAgent.filter(i=>inBucket(i,bucket,Date.now())&&matchHandoff(i,flowSel,flowPair));
  if(mp<Math.ceil(current.length/MAIL_PAGE)-1){mp++;draw();return;}
  const hadRows=current.length>mp*MAIL_PAGE,needed=hadRows?(mp+1)*MAIL_PAGE:mp*MAIL_PAGE;
  while(data?.nextAfter!=null&&active()){
   const loaded=await load();if(!loaded)return;
   const matches=splitQueueHandoffs(sortOldestFirst(data.items)).agentToAgent.filter(i=>inBucket(i,bucket,Date.now())&&matchHandoff(i,flowSel,flowPair));
   if(matches.length>needed){if(hadRows)mp++;draw();return;}
  }
 };
 setChangedHook(()=>{if(active()){loadCockpitSideData();load({reset:true});}});
 await Promise.all([load({reset:true}),loadCockpitSideData()]);
}
