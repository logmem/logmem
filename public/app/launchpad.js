// launchpad provides shared workspace interface behavior.
import {html,nothing,render} from '/vendor/lit-html-3.2.1/lit-html.js';
import {state,postJSON} from './core.js';
import {launchpadProgress,taskDraft} from './launchpad-model.js';
if(!customElements.get('lm-launchpad-content'))customElements.define('lm-launchpad-content',class extends HTMLElement {
 set template(value){this.view=value;if(this.isConnected)render(this.view(),this);}
 connectedCallback(){if(this.view)render(this.view(),this);}
});
const sessions=new Map();
const prefKey=space=>'lm-launchpad:'+String(space);
function preference(space){try{return JSON.parse(localStorage.getItem(prefKey(space))||'{}');}catch{return {};}}
function savePreference(space,value){try{localStorage.setItem(prefKey(space),JSON.stringify(value));}catch{}}
export function launchpad({data={},space=state.space,refresh=()=>{}}={}) {
 if(!state.customer)return nothing;
 const scope=String(state.user?.id)+':'+String(state.workspaceId)+':'+String(state.spaceId||space);
 let session=sessions.get(scope);
 if(!session){session={title:'',job:'task-'+crypto.randomUUID(),busy:false,error:'',savedTask:false};sessions.set(scope,session);}
 const prefs=preference(scope);
 const progress=()=>launchpadProgress(data,{solo:prefs.solo===true,savedTask:session.savedTask,userId:state.user?.id,spaceId:state.spaceId});
 const redraw=e=>render(body(),e.currentTarget.closest('.lmx-launchpad').querySelector('.lmx-launchpad-content'));
 const chooseSolo=e=>{prefs.solo=!prefs.solo;savePreference(scope,prefs);redraw(e);};
 const check=async e=>{const button=e.currentTarget;button.disabled=true;try{await refresh();}catch{session.error='Could not refresh source records. Try again.';if(button.isConnected){button.disabled=false;render(body(),button.closest('.lmx-launchpad-content'));}}};
 const create=async e=>{
  e.preventDefault();if(session.busy)return;
  const form=e.currentTarget,host=form.closest('.lmx-launchpad-content');session.title=form.elements.title.value;
  let payload;try{payload=taskDraft(session.title,session.job);}catch(err){session.error=err.message;render(body(),host);return;}
  session.busy=true;session.error='';render(body(),host);
  try{await postJSON('/api/work?op=create_job','work',payload);session.savedTask=true;session.busy=false;render(body(),host);await refresh();}
  catch(err){session.busy=false;if(err.stale)return;session.error=err.status===409?'This task ID already exists. Open Work to verify the saved task before creating another.':err.message||'Could not save the task. Retry uses the same task ID.';if(host.isConnected)render(body(),host);}
 };
 const body=()=>{const p=progress();return html`
  <div class="lmx-launchpad-head"><div><span class="lm-eyebrow">${p.complete?'Workspace setup complete':'Your first five minutes · a setup target'}</span><h2>${p.complete?'Ready for your next handoff':'Launch your shared workspace'}</h2></div><strong>${p.percent}%</strong></div>
  <progress max="3" value=${p.done} aria-label="Workspace setup progress">${p.done} of 3 steps</progress>
  <p class="lmx-meta" role="status">${p.done} of 3 steps complete · ${!p.agent?'Next: connect an agent and check for its first entry.':!p.task?'Next: save your first task.':!p.collaboration?'Next: choose how you will collaborate.':'Agent entry found. Task saved. Collaboration choice recorded.'}</p>
  ${p.complete?html`<details><summary>Review setup steps</summary>${tiles(p)}</details>`:tiles(p)}
  ${session.error?html`<p role="alert" class="lm-alert lm-alert--danger">${session.error}${session.error.includes('task ID')?html` <a href=${'#/job/'+encodeURIComponent(session.job)}>Verify this task</a>`:nothing}</p>`:nothing}`;};
 const tiles=p=>html`<div class="lmx-launchpad-grid">
  <article><span class="lmx-launchpad-step">01 · ${p.agent?'Entry verified':'About 1 minute'}</span><h3>Connect your first agent</h3><p>${p.agent?'A real agent log entry was returned. This does not prove a running worker.':'Install the skill, connect your client, then ask it to write its first entry.'}</p><a class="lm-btn" href="/agents">Choose an agent setup</a><button type="button" class="lm-btn lm-btn--ghost" @click=${check}>Check for first entry</button></article>
  <article><span class="lmx-launchpad-step">02 · ${p.task?'Task verified':'About 2 minutes'}</span><h3>Drop your first task</h3>${p.task?html`<p>A saved task exists in this space.</p><a class="lm-btn" href="#/work">Open Work</a>`:state.permissions?.write?html`<form @submit=${create}><label class="lm-field"><span class="lm-label">What should your team build or fix?</span><input class="lm-input" name="title" required maxlength="120" .value=${session.title} ?disabled=${session.busy} @input=${e=>{session.title=e.target.value;}}></label><div class="lmx-launchpad-ideas">${['Write our product README','Draft social posts','Check my code'].map(idea=>html`<button type="button" ?disabled=${session.busy} @click=${e=>{session.title=idea;redraw(e);}}>${idea}</button>`)}</div><button class="lm-btn lm-btn--primary" ?disabled=${session.busy}>${session.busy?'Saving task…':'Save first task'}</button></form>`:html`<p>Your workspace owner can grant task editing access.</p>`}</article>
  <article><span class="lmx-launchpad-step">03 · ${p.collaboration?'Choice recorded':'About 2 minutes'}</span><h3>Choose how you collaborate</h3><p>${p.collaborator?'Another member has access to this space.':prefs.solo?'You chose to work solo in this space. You can invite people later.':'Invite a teammate through workspace settings, or choose to work solo.'}</p>${state.permissions?.manage?html`<a class="lm-btn" href="#/account">Invite a teammate</a>`:html`<p class="lmx-meta">Ask your workspace owner to invite a teammate.</p>`}<button type="button" class="lm-btn lm-btn--ghost" aria-pressed=${String(prefs.solo===true)} @click=${chooseSolo}>${prefs.solo?'Change solo choice':'I am working solo'}</button>${!p.collaborator&&!prefs.solo?html`<p class="lmx-meta">An invitation link alone does not verify that a teammate joined.</p>`:nothing}</article>
 </div>`;
 return html`<section class="lmx-launchpad" aria-label="Workspace setup"><lm-launchpad-content class="lmx-launchpad-content" .template=${body}></lm-launchpad-content></section>`;
}
