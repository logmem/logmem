// Customer account screens. All data remains escaped by lit-html.
import {html,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {state,live,postJSON,getJSON,switchContext,clearCustomerContext,toast} from './core.js';
import {renderBare,renderView} from './shell.js';
import {humanPrompt} from './go-prompt.js';
let ready=()=>{},closePanels=()=>{},formError='',busy=false,model={name:'',spaceName:'Operations',businessType:'',withSample:false};
let requestId=crypto.randomUUID();
export function configureAccount(hooks){ready=hooks.ready;closePanels=hooks.closePanels;}
const logo=()=>html`<a href="/"><img src="/ds/logos/logmem-lockup.svg" alt="LogMem" width="150"></a>`;
export function showCustomerLogin(message='') {
 clearCustomerContext();state.customer=true;
 renderBare(html`<section class="lmx-account-start">${logo()}<h1>Your agents. One shared workspace.</h1><p>Sign in to create spaces, track work, and keep your team aligned.</p>${message?html`<p role="alert">${message}</p>`:nothing}<a class="lm-btn lm-btn--primary" href=${'/api/session?signin=1&returnTo='+encodeURIComponent(location.pathname+location.search+location.hash)}>Sign in or create an account</a></section>`);
}
export async function bootstrapAccount() {
 if(new URLSearchParams(location.search).get('operator')==='1')return false;
 const res=await fetch('/api/session',{credentials:'same-origin'}),data=await res.json().catch(()=>({}));
 if(res.status===503&&data.error==='customer_dashboard_disabled')return false;
 if(res.status===404)return false; // Existing local sample server has no customer routes.
 state.customer=true;
 if(res.status===401){new URLSearchParams(location.search).get('invite')?showInviteSignedOut():showCustomerLogin();return true;}
 if(!res.ok){renderBare(html`<section class="lmx-account-start">${logo()}<h1>Could not open your workspace.</h1><p role="alert">Please retry. Your data stays private.</p><button class="lm-btn" @click=${()=>location.reload()}>Retry</button></section>`);return true;}
 state.user=data.user;state.workspaces=data.workspaces;state.spaceRecords=data.spaces;live.signedOut=false;
 const invite=new URLSearchParams(location.search).get('invite');
 if(invite){await showInvitation(invite);return true;}
 const entry=new URL(location.href);
 if(entry.searchParams.get('setup')==='managed'){
  entry.searchParams.delete('setup');
  if(!entry.hash)entry.hash='#/home';
  history.replaceState(null,'',entry.pathname+entry.search+entry.hash);
 }
 if(data.onboarding===true){showCreateWorkspace();return true;}
 let selected=data.selected;
 try{const saved=JSON.parse(localStorage.getItem('lm-context-'+data.user.id)||'null');if(data.spaces.some(s=>s.id===saved?.spaceId&&s.workspaceId===saved?.workspaceId))selected=saved;}catch{}
 if(!selected){showCreateWorkspace();return true;}
 switchContext(selected);return false;
}
async function reloadContext(selection) {
 const res=await fetch('/api/session',{credentials:'same-origin'});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not refresh access.');
 state.user=data.user;state.workspaces=data.workspaces;state.spaceRecords=data.spaces;
 switchContext(selection||data.selected);closePanels();location.hash='#/home';ready();
}
export function chooseSpace(namespace) {
 const space=state.spaceRecords.find(s=>s.namespace===namespace);if(!space)return;
 closePanels();switchContext({workspaceId:space.workspaceId,spaceId:space.id});location.hash='#/home';ready();
}
function showCreation(kind) {
 const isWorkspace=kind==='workspace';formError='';busy=false;requestId=crypto.randomUUID();model={name:'',spaceName:'Operations',businessType:'',withSample:false};
 const draw=()=>renderBare(html`<section class="lmx-account-start">${logo()}<h1>${isWorkspace?'Create your workspace':'Create a space'}</h1><p>${isWorkspace?'Start with your business or team. You can add more spaces later.':'Keep related work together. New spaces start private.'}</p>
 <form class="lm-panel lmx-account-form" @submit=${async e=>{
  e.preventDefault();if(busy)return;const f=e.currentTarget;model={name:f.elements.name.value,spaceName:f.elements.spaceName?.value||model.spaceName,businessType:f.elements.businessType?.value||'',withSample:f.elements.withSample?.checked===true};busy=true;formError='';draw();
  try{const result=await postJSON('/api/workspaces','workspace',{action:isWorkspace?'create-workspace':'create-space',name:model.name,firstSpaceName:model.spaceName,businessType:model.businessType,withSample:model.withSample,requestId});await reloadContext({workspaceId:result.space.workspaceId,spaceId:result.space.id});if(result.sampleStatus==='interrupted')toast('Your space was created. Sample setup stopped and needs review.',true);}
  catch(err){if(err.stale)return;busy=false;formError=err.message;draw();}
 }}>
 <label class="lm-field"><span class="lm-label">${isWorkspace?'Workspace name':'Space name'}</span><input class="lm-input" name="name" required maxlength="80" autocomplete="organization" .value=${model.name} ?disabled=${busy}></label>
 ${isWorkspace?html`<label class="lm-field"><span class="lm-label">First space name</span><input class="lm-input" name="spaceName" required maxlength="80" .value=${model.spaceName} ?disabled=${busy}></label><label class="lm-field"><span class="lm-label">Business type (optional)</span><select class="lm-select" name="businessType" .value=${model.businessType} ?disabled=${busy}><option value="">Choose later</option><option value="solo">Solo operator</option><option value="development">Development</option><option value="trades">Trades</option><option value="restaurant">Restaurant</option><option value="sales">Sales team</option></select></label><label><input type="checkbox" name="withSample" .checked=${model.withSample} ?disabled=${busy}> Add labeled sample content for this business type</label>`:nothing}
 ${formError?html`<p role="alert" class="lm-alert lm-alert--danger">${formError}</p>`:nothing}<button class="lm-btn lm-btn--primary" ?disabled=${busy}>${busy?'Creating…':isWorkspace?'Create workspace':'Create space'}</button>
 ${state.spaceId?html`<button class="lm-btn lm-btn--ghost" type="button" ?disabled=${busy} @click=${ready}>Cancel</button>`:nothing}</form><button class="lm-btn lm-btn--ghost" @click=${signOutCustomer}>Sign out</button></section>`);
 draw();
}
export const showCreateWorkspace=()=>showCreation('workspace');
export const showCreateSpace=()=>showCreation('space');
export async function signOutCustomer() {
 try{await postJSON('/api/session','session',{action:'signout'});clearCustomerContext();localStorage.setItem('lm-account-event',JSON.stringify({type:'signout',at:Date.now()}));new URLSearchParams(location.search).get('invite')?showInviteSignedOut():showCustomerLogin();}
 catch(e){toast(e.message,true);}
}
export function showAccount() {
 const w=state.workspaces.find(w=>w.id===state.workspaceId),manager=['owner','admin'].includes(w?.role);
 renderView('account',['Settings'],html`<a class="lm-btn lm-btn--secondary" href="#/home">Return to Today</a><section class="lmx-account-settings"><h1 class="lm-title-1">Settings</h1><section class="lm-panel lmx-profile-card"><div class="lmx-profile-mark" aria-hidden="true">${String(state.user?.email||'L').slice(0,1).toUpperCase()}</div><div class="lmx-profile-copy"><span class="lm-eyebrow">LOGMEM ACCOUNT</span><h2>Your profile</h2><p>Signed in as <strong>${state.user?.email}</strong></p><p>Manage your name, profile details, sign-in methods and security with Clerk.</p></div><a class="lm-btn lm-btn--primary" href="/api/session?profile=1">Manage profile and security <span aria-hidden="true">↗</span></a></section><section class="lm-panel lmx-account-form"><h2>${w?.name||'Workspace'} settings</h2><p>Manage spaces, people and agent access for this workspace.</p><div class="lmx-account-actions"><button class="lm-btn" @click=${showCreateWorkspace}>Create another workspace</button>${w?.role!=='viewer'?html`<button class="lm-btn" @click=${showCreateSpace}>Create space</button>`:nothing}<button class="lm-btn lm-btn--ghost" @click=${signOutCustomer}>Sign out</button></div>
 ${manager?html`<section class="lm-panel lmx-account-form"><h2>Invite a teammate</h2><p>They will see only the spaces you grant. LogMem will email the invitation and show you a copyable link.</p><form @submit=${invitePerson}><label class="lm-field"><span class="lm-label">Email</span><input class="lm-input" type="email" name="email" required></label><label class="lm-field"><span class="lm-label">Access to this space</span><select class="lm-select" name="role"><option value="member">Editor</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option></select></label><button class="lm-btn lm-btn--primary">Create and email invitation</button></form><div id="invitation-result" role="status"></div></section><section class="lm-panel lmx-account-form"><h2>Connect an agent</h2><p>Keys grant access to this space only. Keep each key private.</p><form @submit=${connectAgent}><label class="lm-field"><span class="lm-label">Agent name</span><input class="lm-input" name="agent" placeholder="codex" pattern="[a-z][a-z0-9_.-]*" required></label><button class="lm-btn">Create agent key</button></form><div id="agent-key-result" role="status"></div><div id="connection-list"></div></section><section class="lm-panel lmx-account-form"><h2>People and access</h2><div id="membership-list">Loading members…</div></section>`:html`<p>Your workspace owner manages invitations and agent access.</p>`}</section>`);
 if(manager){loadMembers();loadConnections();}
}
function showSecret(container,text,label) {
 const el=document.getElementById(container);if(!el)return;el.replaceChildren();const p=document.createElement('p');p.textContent=label;const input=document.createElement('input');input.className='lm-input';input.readOnly=true;input.value=text;input.setAttribute('aria-label',label);const copy=document.createElement('button');copy.className='lm-btn';copy.textContent='Copy';copy.onclick=()=>navigator.clipboard.writeText(text).then(()=>toast('Copied.')).catch(()=>{input.select();toast('Select and copy the text.');});el.append(p,input,copy);
}
async function invitePerson(e) {
 e.preventDefault();const f=e.currentTarget;
 try{const role=f.elements.role.value,r=await postJSON('/api/memberships','memberships',{action:'invite',email:f.elements.email.value,role,spaces:{[state.spaceId]:{role:role==='viewer'?'viewer':'editor',canApprove:false}},requestId:crypto.randomUUID()});showSecret('invitation-result',location.origin+'/app?invite='+encodeURIComponent(r.token),r.emailSent?'Invitation email sent. Link expires in seven days.':`Email could not be sent. Copy and share this link. Link expires in seven days.`);loadMembers();}
 catch(err){toast(err.message,true);}
}
async function connectAgent(e) {
 e.preventDefault();try{const r=await postJSON('/api/agent-keys','agent-keys',{agent:e.currentTarget.elements.agent.value,requestId:crypto.randomUUID()});showSecret('agent-key-result',r.key,'Agent key. Shown once.');loadConnections();}catch(err){toast(err.message,true);}
}
async function loadConnections() {
 try{const r=await getJSON('/api/agent-keys');if(r.__stale||r.__status!==200)return;const el=document.getElementById('connection-list');if(!el)return;el.replaceChildren();
 for(const c of [...r.keys,...r.apps]){const row=document.createElement('p');row.textContent=c.agent+' ';const b=document.createElement('button');b.className='lm-btn lm-btn--ghost';b.textContent='Disconnect';b.onclick=async()=>{try{await postJSON('/api/agent-keys','agent-keys',{action:c.fid?'disconnect':'revoke',id:c.id,fid:c.fid,requestId:crypto.randomUUID()});loadConnections();}catch(e){toast(e.message,true);}};row.append(b);el.append(row);}}
 catch(e){toast(e.message,true);}
}
async function loadMembers() {
 try{
  const r=await getJSON('/api/memberships');if(r.__stale||r.__status!==200)return;
  const el=document.getElementById('membership-list');if(!el)return;el.replaceChildren();
  const owner=state.workspaces.find(w=>w.id===state.workspaceId)?.role==='owner';
  for(const m of r.members){
   const panel=document.createElement('details'),heading=document.createElement('summary');
   heading.textContent=(m.userId===state.user.id?'You':m.label||'Member '+m.userId.slice(-6))+' · '+m.role;panel.append(heading);
   const form=document.createElement('form'),roleLabel=document.createElement('label'),select=document.createElement('select');
   roleLabel.textContent='Workspace role';select.className='lm-select';select.setAttribute('aria-label','Workspace role');
   for(const role of owner?['owner','admin','member','viewer','contributor']:['admin','member','viewer','contributor']){const option=document.createElement('option');option.value=role;option.textContent=role;option.selected=role===m.role;select.append(option);}
   select.disabled=m.role==='owner'&&!owner;roleLabel.append(select);form.append(roleLabel);
   const inputs=[];
   for(const space of state.spaceRecords.filter(s=>s.workspaceId===state.workspaceId)){
    const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=Boolean(m.spaces?.[space.id]);label.append(check,document.createTextNode(' Access to '+space.name));form.append(label);
    const approvalLabel=document.createElement('label'),approval=document.createElement('input');approval.type='checkbox';approval.checked=Boolean(m.spaces?.[space.id]?.canApprove);approval.disabled=!owner;approvalLabel.append(approval,document.createTextNode(' May answer decisions in '+space.name));form.append(approvalLabel);inputs.push({id:space.id,check,approval});
   }
   const save=document.createElement('button');save.className='lm-btn';save.textContent='Save access';save.disabled=m.role==='owner'&&!owner;form.append(save);
   form.onsubmit=async event=>{event.preventDefault();const spaces={};for(const i of inputs)if(i.check.checked)spaces[i.id]={role:select.value==='viewer'?'viewer':'editor',canApprove:select.value!=='viewer'&&i.approval.checked};
    try{await postJSON('/api/memberships','memberships',{action:'set',userId:m.userId,role:select.value,spaces,requestId:crypto.randomUUID()});if(m.userId===state.user.id)await reloadContext();else loadMembers();toast('Access saved.');}catch(e){toast(e.message,true);}
   };
   const remove=document.createElement('button');remove.type='button';remove.className='lm-btn lm-btn--ghost';remove.textContent='Remove member';remove.disabled=m.role==='owner'&&!owner;
   remove.onclick=async()=>{try{await postJSON('/api/memberships','memberships',{action:'remove',userId:m.userId,requestId:crypto.randomUUID()});if(m.userId===state.user.id){clearCustomerContext();await bootstrapAccount();}else loadMembers();}catch(e){toast(e.message,true);}};
   form.append(remove);panel.append(form);el.append(panel);
  }
  for(const invite of r.invitations||[]){const row=document.createElement('p');row.textContent='Pending '+invite.role+' invitation. ';const cancel=document.createElement('button');cancel.textContent='Revoke invitation';cancel.className='lm-btn lm-btn--ghost';cancel.onclick=async()=>{try{await postJSON('/api/memberships','memberships',{action:'revoke-invitation',invitationId:invite.id,requestId:crypto.randomUUID()});loadMembers();}catch(e){toast(e.message,true);}};row.append(cancel);el.append(row);}
 }catch(e){toast(e.message,true);}
}

const inviteSteps=(on)=>html`<ol class="lmx-invite-steps"><li aria-current=${on===1?'step':nothing}><strong>Sign in</strong> with the email the invite was sent to.</li><li aria-current=${on===2?'step':nothing}><strong>Accept</strong> to join the workspace.</li><li aria-current=${on===3?'step':nothing}><strong>Connect your AI.</strong> Paste one short prompt.</li></ol>`;
const signInHref=()=>'/api/session?signin=1&returnTo='+encodeURIComponent(location.pathname+location.search+location.hash);
function showInviteSignedOut() {
 clearCustomerContext();state.customer=true;
 renderBare(html`<section class="lmx-account-start lmx-invite">${logo()}<h1>You have been invited to LogMem.</h1><p>LogMem is a shared space where you and your AI tools keep work in one place.</p>${inviteSteps(1)}<a class="lm-btn lm-btn--primary" href=${signInHref()}>Sign in to accept</a><p class="lmx-invite-note">No account yet? The same button lets you create one. Use the email the invite was sent to. The link works once and expires after 7 days.</p></section>`);
}
function inviteProblem(email) {
 renderBare(html`<section class="lmx-account-start lmx-invite">${logo()}<h1>This invitation does not open for your account.</h1><p role="alert">You are signed in as <strong>${email}</strong>. An invitation works only for the email it was sent to. It also stops working after one use or after 7 days.</p><button class="lm-btn lm-btn--primary" @click=${signOutCustomer}>Sign out and use another email</button><a class="lm-btn" href="/app">Open my workspace</a><p class="lmx-invite-note">Still stuck? Ask the person who invited you to send a new invitation.</p></section>`);
}
function inviteAccepted(workspaceName,selected) {
 const prompt=humanPrompt('this AI');
 renderBare(html`<section class="lmx-account-start lmx-invite">${logo()}<h1>You joined ${workspaceName}.</h1>${inviteSteps(3)}<p>Paste this into your AI. It goes to logmem.si/agents, gets the skills and connects.</p><pre class="lmx-invite-prompt" tabindex="0">${prompt}</pre><button class="lm-btn lm-btn--primary" @click=${async e=>{const b=e.currentTarget;try{await navigator.clipboard.writeText(prompt);b.textContent='Copied';}catch{b.textContent='Select the text and copy it';}}}>Copy the prompt</button><a class="lm-btn" href="https://logmem.si/agents">Open the agent setup page</a><button class="lm-btn lm-btn--ghost" @click=${()=>reloadContext(selected)}>Open the workspace</button></section>`);
}
async function showInvitation(token) {
 let r;
 try{const res=await fetch('/api/memberships?token='+encodeURIComponent(token),{credentials:'same-origin'});r=await res.json().catch(()=>({}));if(!res.ok){inviteProblem(state.user?.email||'your account');return;}}
 catch{renderBare(html`<section class="lmx-account-start lmx-invite">${logo()}<h1>Could not check the invitation.</h1><p role="alert">Check your connection and try again. Your invitation is not used up.</p><button class="lm-btn lm-btn--primary" @click=${()=>location.reload()}>Try again</button></section>`);return;}
 renderBare(html`<section class="lmx-account-start lmx-invite">${logo()}<h1>Join ${r.workspaceName}</h1>${inviteSteps(2)}<p>Your role: <strong>${r.role}</strong>.</p><p>Spaces: ${r.spaces.map(x=>x.name).join(', ')}</p><p class="lmx-invite-note">Signed in as ${state.user?.email}. <button class="lmx-linkbtn" @click=${signOutCustomer}>Not you? Sign out</button></p><button class="lm-btn lm-btn--primary" @click=${async e=>{const b=e.currentTarget;b.disabled=true;try{const accepted=await postJSON('/api/memberships','memberships',{action:'accept',token});history.replaceState(null,'','/app');inviteAccepted(r.workspaceName,accepted.selected);}catch(err){b.disabled=false;toast(err.message,true);}}}>Accept invitation</button><a class="lm-btn" href="/app">Not now</a></section>`);
}
export function showNewTask() {
 let error='';const draw=()=>renderView('home',['Today','Add a task'],html`<form class="lm-panel lmx-account-form" @submit=${async e=>{e.preventDefault();try{await postJSON('/api/work?op=create_job','work',{job:'task-'+crypto.randomUUID(),title:e.currentTarget.elements.title.value});location.hash='#/work';ready();}catch(err){if(err.stale)return;error=err.message;draw();}}}><h1>Add a task</h1><label class="lm-field"><span class="lm-label">What needs to happen?</span><input class="lm-input" name="title" maxlength="120" required></label>${error?html`<p role="alert">${error}</p>`:nothing}<button class="lm-btn lm-btn--primary">Add task</button></form>`);draw();
}
