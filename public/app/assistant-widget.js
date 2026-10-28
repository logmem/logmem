// assistant-widget.js: source-aware shortcuts and a read-only client grant inspector.
import {html,render,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {repeat} from '/vendor/lit-html-3.2.1/directives/repeat.js';
import {state,live} from './core.js';
import {icon} from './ui.js';
import {observeTelemetry,telemetryFor} from './telemetry-state.js';
async function inspect(event){
 const details=event.currentTarget;if(!details.open)return;
 const container=details.querySelector('[data-client-results]'),space=state.space,identity=state.user?.id,workspace=state.workspaceId,customer=state.customer;
 const active=()=>details.isConnected&&space===state.space&&identity===state.user?.id&&workspace===state.workspaceId&&customer===state.customer;
 render(html`<p role="status">Reading configured client grants…</p>`,container);
 const url=state.customer?'/api/agent-keys?'+new URLSearchParams({workspaceId:state.workspaceId||'',spaceId:state.spaceId||''}):'/api/connections';
 try{
  const response=await fetch(url,{credentials:'same-origin',redirect:'error',headers:state.customer?{'X-LogMem-Viewer':'customer'}:{}});
  const data=await response.json();if(!active())return;
  if(!response.ok){render(html`<p role="status">${response.status===401?'Sign in with your account to inspect its configured apps.':response.status===403?'Your account cannot inspect these grants.':'Client grants are unavailable. Close and reopen this panel to retry.'}</p>`,container);return;}
  const rows=[...(Array.isArray(data.apps)?data.apps:[]),...(Array.isArray(data.keys)?data.keys:[])];
  render(html`<p>${customer?'Configured access for this space.':'Account app grants can span spaces.'}</p><p>Configured access does not prove a client tunnel is online.</p>${rows.length?html`<ul class="lmx-client-grants">${rows.slice(0,50).map(row=>html`<li><strong>${row.app||row.agent||'Client'}</strong><span>Grant configured</span>${row.last_used?html`<small>Last used ${new Date(Number(row.last_used)*1000).toLocaleString()}</small>`:nothing}</li>`)}</ul>${rows.length>50?html`<p>Showing 50 of ${rows.length} configured records.</p>`:nothing}`:html`<p>No configured client grants were returned.</p>`}`,container);
 }catch{if(active())render(html`<p role="status">Client grants could not be read. Close and reopen this panel to retry.</p>`,container);}
}
async function refreshSnapshots(event,refresh){
 const button=event.currentTarget,space=state.space,customer=state.customer,user=state.user?.id,workspace=state.workspaceId,spaceId=state.spaceId;
 if(!space)return;button.disabled=true;
 const active=()=>space===state.space&&customer===state.customer&&user===state.user?.id&&workspace===state.workspaceId;
 const context={space,...(customer?{workspaceId:workspace||'',spaceId:spaceId||''}:{})};
 const sources=[['inbox','/api/interactions', {queue:'1'},d=>Array.isArray(d.items)?d.items.length:null],['decisions','/api/view',{what:'home'},d=>Array.isArray(d.needs_items)?d.needs_items.filter(i=>i.type==='decision').length:null],['mirror','/api/view',{what:'audit'},d=>d.source_status?.audit==='error'?null:typeof d.days?.at(-1)?.mirror_mismatches==='number'&&d.days.at(-1).mirror_checked!==false?d.days.at(-1).mirror_mismatches:null],['activity','/api/view',{what:'log'},d=>Array.isArray(d.entries)?d.entries.length:null]];
 await Promise.all(sources.map(async([key,path,query,read])=>{
  try{const response=await fetch(path+'?'+new URLSearchParams({...context,...query}),{credentials:'same-origin',redirect:'error',headers:customer?{'X-LogMem-Viewer':'customer'}:{}});if(!response.ok)throw Error('unavailable');const data=await response.json();if(active())observeTelemetry(space,{[key]:{value:read(data),label:'Unavailable'}});}
  catch{if(active())observeTelemetry(space,{[key]:{value:null,label:'Unavailable'}});}
 }));
 if(button.isConnected)button.disabled=false;if(active())refresh?.();
}
export function assistantWidget(route,refresh){
 const metrics=telemetryFor(state.space),transport=live.storageDown?'unavailable':live.status==='live'?'connected':live.status==='paused'?'paused':'reconnecting';
 const rows=[['inbox','Inbox','handoff','#/queue','pending · loaded page'],['decisions','Knowledge decisions','brief','#/knowledge','waiting sign-off · loaded'],['mirror','Health & coverage','eye','#/health','missing copies · audit window'],['activity','Source activity','timeline','#/activity','entries · loaded']];
 return html`<aside class="lmx-assistant lmx-command-widget" aria-label="Workspace assistant"><h2>${icon('recall')}Workspace assistant</h2><p class="lmx-assistant-context">${state.space||'Choose a space'} · saved operational snapshots</p><nav class="lmx-telemetry-links" aria-label="Workspace telemetry shortcuts">${rows.map(([key,label,ic,href,suffix])=>{const metric=metrics[key];return html`<a href=${href} data-kind=${key} data-measured=${String(metric?.value!=null)}>${icon(ic)}<span>${label}</span><span class="lmx-telemetry-count" title=${metric?'Observed '+new Date(metric.at).toLocaleString():''}>${metric?.value!=null?metric.value+' '+suffix:metric?.label||'Open to measure'}</span></a>`;})}</nav><button type="button" class="lm-btn lm-btn--secondary" ?disabled=${!state.space} @click=${event=>refreshSnapshots(event,refresh)}>Refresh snapshots</button><section class="lmx-connection-terminal" aria-label="Connection status"><div class="lmx-transport" data-status=${transport}><i aria-hidden="true"></i>Workspace data ${transport}</div><strong>Agent execution: unverified</strong><p>No runner or local MCP tunnel heartbeat is available here.</p>${repeat([[state.space,state.user?.id,state.workspaceId].join('|')],key=>key,()=>html`<details class="lmx-client-inspector" @toggle=${inspect}><summary>Inspect configured clients</summary><div data-client-results></div><a class="lm-btn lm-btn--secondary" href=${state.customer?'#/account':'/connections'} target="_blank" rel="noopener">Manage access in a new tab ↗</a></details>`)}</section></aside>`;
}
