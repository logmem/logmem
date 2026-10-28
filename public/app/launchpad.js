// Customer setup stays inside Today and retains drafts in a scoped browser session.
import {html,nothing,render} from '/vendor/lit-html-3.2.1/lit-html.js';
import {state,postJSON} from './core.js';
import {launchpadProgress,taskDraft} from './launchpad-model.js';
import {clientId,selectedEntry,readGuide} from './setup-model.js';
import './setup-guide.js';
if(!customElements.get('lm-launchpad-content'))customElements.define('lm-launchpad-content',class extends HTMLElement {
 set template(value){this.view=value;if(this.isConnected)render(this.view(),this);}
 connectedCallback(){if(this.view)render(this.view(),this);}
});
const sessions=new Map();
function read(key){try{return JSON.parse(sessionStorage.getItem(key)||'{}');}catch{return {};}}
function save(key,value){try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}}
export function launchpad({data={},space=state.space,refresh=()=>{}}={}){
 if(!state.customer)return nothing;
 const scope=String(state.user?.id)+':'+String(state.workspaceId)+':'+String(state.spaceId||space),key='lm-launchpad:'+scope;
 let session=sessions.get(scope);
 if(!session){const v=read(key);session={title:typeof v.title==='string'?v.title.slice(0,120):'',job:/^task-[a-z0-9-]+$/.test(v.job||'')?v.job:'task-'+crypto.randomUUID(),phase:['agent','task','team'].includes(v.phase)?v.phase:'agent',solo:v.solo===true,closed:v.closed===true,client:clientId(v.client),busy:false,error:'',savedTask:false};sessions.set(scope,session);}
 const persist=()=>save(key,{title:session.title,job:session.job,phase:session.phase,solo:session.solo,closed:session.closed,client:session.client});
 const query=new URLSearchParams(location.search);
 if(query.get('setup')==='guided'){
  session.client=clientId(query.get('client'))||session.client;session.phase='agent';session.closed=false;
  const step=Number(query.get('step'));session.entryStep=Number.isInteger(step)&&step>=0&&step<=3?step:0;
  const url=new URL(location.href);for(const k of ['setup','client','step'])url.searchParams.delete(k);history.replaceState(null,'',url.pathname+url.search+url.hash);persist();
 }
 if(!session.client){session.client=readGuide('public').client;persist();}
 const verified=id=>launchpadProgress({agents:selectedEntry(data.agents,id)}).agent;
 const progress=()=>launchpadProgress({...data,agents:selectedEntry(data.agents,session.client)},{solo:session.solo,savedTask:session.savedTask,userId:state.user?.id,spaceId:state.spaceId});
 let host;
 const redraw=()=>{if(host?.isConnected)render(body(),host);};
 const eventHost=e=>{host=e.currentTarget.closest('lm-launchpad-content');};
 const phase=(e,value)=>{eventHost(e);session.phase=value;session.closed=false;persist();redraw();};
 const exit=e=>{eventHost(e);session.closed=true;persist();redraw();};
 const create=async e=>{
  e.preventDefault();if(session.busy)return;eventHost(e);const target=host;
  session.title=e.currentTarget.elements.title.value;persist();let payload;
  try{payload=taskDraft(session.title,session.job);}catch(err){session.error=err.message;redraw();return;}
  session.busy=true;session.error='';redraw();
  try{await postJSON('/api/work?op=create_job','work',payload);session.savedTask=true;session.busy=false;session.phase='team';persist();if(target.isConnected)render(body(),target);await refresh();}
  catch(err){session.busy=false;if(err.stale)return;session.error=err.status===409?'This task ID already exists. Verify the saved task before creating another.':err.message||'Could not save the task. Retry uses the same task ID.';if(target.isConnected)render(body(),target);}
 };
 const task=()=>html`<section class="setup-guide-panel"><h3>Drop your first task</h3>${progress().task?html`<p>A saved task exists in this space.</p><button type="button" class="lm-btn lm-btn--primary" @click=${e=>phase(e,'team')}>Continue to collaboration</button>`:state.permissions?.write?html`<form @submit=${create}><label class="lm-field"><span class="lm-label">What should your team build or fix?</span><input class="lm-input" name="title" required maxlength="120" .value=${session.title} ?disabled=${session.busy} @input=${e=>{session.title=e.target.value;persist();}}></label><div class="lmx-launchpad-ideas">${['Write our product README','Draft social posts','Check my code'].map(idea=>html`<button type="button" ?disabled=${session.busy} @click=${e=>{eventHost(e);session.title=idea;persist();redraw();}}>${idea}</button>`)}</div><button class="lm-btn lm-btn--primary" ?disabled=${session.busy}>${session.busy?'Saving task…':'Save first task'}</button></form>`:html`<p>Your workspace owner can grant task editing access.</p><button type="button" class="lm-btn" @click=${e=>phase(e,'team')}>Continue to collaboration</button>`}</section>`;
 const team=()=>html`<section class="setup-guide-panel"><h3>Choose how you collaborate</h3><p>${progress().collaborator?'Another member has access to this space.':session.solo?'You chose to work solo in this space. You can invite people later.':'Invite a teammate through workspace settings, or choose to work solo.'}</p>${state.permissions?.manage?html`<a class="lm-btn" href="#/account">Invite a teammate</a>`:html`<p>Your workspace owner can invite a teammate.</p>`}<button type="button" class="lm-btn lm-btn--secondary" aria-pressed=${String(session.solo)} @click=${e=>{eventHost(e);session.solo=!session.solo;persist();redraw();}}>${session.solo?'Change solo choice':'I am working solo'}</button><p class="lmx-meta">An invitation link alone does not verify that a teammate joined.</p><button type="button" class="lm-btn lm-btn--primary" @click=${exit}>Go to Today</button></section>`;
 const body=()=>{const p=progress();return html`<div class="lmx-launchpad-head"><div><span class="lm-eyebrow">${p.complete?'Workspace setup complete':'Your first five minutes · a setup target'}</span><h2>${p.complete?'Ready for your next handoff':'Launch your shared workspace'}</h2></div><strong>${p.percent}%</strong></div><progress max="3" value=${p.done} aria-label="Workspace setup progress">${p.done} of 3 steps</progress><p class="lmx-meta" role="status">${p.done} of 3 steps complete · ${!p.agent?'Next: verify your selected agent.':!p.task?'Next: save your first task.':!p.collaboration?'Next: choose how you collaborate.':'Agent entry found. Task saved. Collaboration choice recorded.'}</p>
 ${session.closed?html`<button type="button" class="lm-btn lm-btn--secondary" @click=${e=>phase(e,session.phase)}>${p.complete?'Review setup':'Resume setup'}</button>`:html`<nav class="setup-trail" aria-label="Workspace setup stages">${[['agent','Connect agent'],['task','First task'],['team','Collaborate']].map(([id,label])=>html`<button type="button" aria-current=${session.phase===id?'step':nothing} @click=${e=>phase(e,id)}>${label}</button>`)}</nav>
 ${session.phase==='agent'?html`<lm-agent-guide @setup-choice=${e=>{session.client=e.detail.client;session.entryStep=undefined;persist();}} .options=${{scope,customer:true,client:session.client,step:session.entryStep,isVerified:verified,onCheck:refresh,onSave:()=>{session.closed=true;persist();const el=document.querySelector('lm-launchpad-content');if(el)render(body(),el);},onDone:id=>{session.client=id;session.phase='task';persist();const el=document.querySelector('lm-launchpad-content');if(el)render(body(),el);}}}></lm-agent-guide>`:session.phase==='task'?task():team()}
 ${session.phase!=='agent'?html`<div class="setup-guide-actions"><button type="button" class="lm-btn lm-btn--secondary" @click=${e=>phase(e,session.phase==='team'?'task':'agent')}>Previous step</button><button type="button" class="lm-btn lm-btn--ghost" @click=${exit}>Save and exit</button></div>`:nothing}`}
 ${session.error?html`<p role="alert" class="lm-alert lm-alert--danger">${session.error}${session.error.includes('task ID')?html` <a href=${'#/job/'+encodeURIComponent(session.job)}>Verify this task</a>`:nothing}</p>`:nothing}`;};
 return html`<section class="lmx-launchpad" aria-label="Workspace setup"><lm-launchpad-content .template=${body}></lm-launchpad-content></section>`;
}
