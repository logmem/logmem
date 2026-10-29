// today-components.js: triage tiles, compact plan progress and a review-first action banner.
import {html,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {agentName,ago} from './core.js';
import {attentionKind,splitHeadline} from './dashboard-model.js';
import {laneBadge} from './ui.js';
import {agentDispatchButton} from './dispatch-components.js';
import {dispatchPrompt} from './dispatch-model.js';
const labels={decision:'Your decision',task:'Your task',review:'Review completion'};
export function bentoTaskCard({item,space,review}) {
 const kind=attentionKind(item),{head,body}=splitHeadline(item.summary||item.ask?.summary);
 return html`<article class="lmx-card lmx-attention lmx-bento-task" data-kind=${kind} data-key=${space+':'+item.type+':'+item.trail}>
 <div class="lmx-attention-top"><span class="lm-eyebrow lmx-kind">${labels[kind]}</span><h3 class="lmx-attention-title">${head}</h3>${body?html`<p class="lmx-attention-body">${body}</p>`:nothing}</div>
 <div class="lmx-attention-foot"><div class="lmx-attention-meta">${item.by?html`<span class="lmx-chip">${agentName(item.by)}</span>`:nothing}${item.plan?html`<span class="lmx-chip lmx-chip--lane">${item.plan}</span>`:nothing}${item.created_at?html`<time class="lmx-meta">${ago(item.created_at)}</time>`:nothing}</div><button type="button" class="lm-btn lm-btn--primary" @click=${review}>${kind==='decision'?'Review decision':kind==='task'?'Review task':'Review evidence'}</button></div></article>`;
}
export function planProgressTile(plan) {
 const total=Math.max(0,Number(plan.jobs)||0),done=Math.max(0,Number(plan.done)||0),percent=total?Math.min(100,Math.round(done/total*100)):0;
 return html`<details class="lmx-plan lmx-plan-tile priority-tile"><summary><span class="lmx-plan-tile-heading"><strong title=${plan.title||plan.id}>${plan.title||plan.id}</strong>${laneBadge(plan.lane)}</span><span class="lmx-plan-tile-progress" aria-label=${`${done} of ${total} work items done, ${percent} percent`}><span class="lmx-plan-tile-fraction">${done} of ${total} done</span><span class="lmx-bar" role="progressbar" aria-label="Plan completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent}><i style=${'width:'+percent+'%'}></i></span><span class="lmx-pct">${percent}%</span></span><span class="lmx-plan-tile-meta" title=${plan.next_milestone?plan.next_milestone.title:''}>${plan.next_milestone?'Next: '+plan.next_milestone.title+(plan.next_milestone.date?' · '+plan.next_milestone.date:''):'No milestone'}</span></summary><div class="lmx-plan-tile-detail"><p><strong>${plan.title||plan.id}</strong></p>${plan.next_milestone?html`<p>${plan.next_milestone.title}${plan.next_milestone.date?' · '+plan.next_milestone.date:''}</p>`:html`<p>No milestone checklist was returned. Open the plan to review its work.</p>`}<a href=${'#/plan/'+encodeURIComponent(plan.id)}>Review plan and milestones →</a></div></details>`;
}
export function taskTree({done=0,total=0,blocked=0}) {
 const pct=total?Math.min(100,Math.round(done/total*100)):0, strained=blocked>0;
 return html`<section class="lmx-task-tree" data-mood=${strained?'strained':'growing'} aria-label="Workspace progress companion">
   <div class="lmx-task-tree-art" aria-hidden="true"><span class="lmx-tree-orb"></span><span class="lmx-tree-trunk"></span><span class="lmx-tree-leaf lmx-tree-leaf--one"></span><span class="lmx-tree-leaf lmx-tree-leaf--two"></span><span class="lmx-tree-leaf lmx-tree-leaf--three"></span><span class="lmx-tree-leaf lmx-tree-leaf--four"></span></div>
   <div class="lmx-task-tree-copy"><span class="lm-eyebrow">Workspace growth</span><strong>${strained?'A blocker needs care':'Your work is growing'}</strong><span class="lmx-meta">${done} of ${total} loaded tasks complete · ${blocked} waiting</span><span class="lmx-task-tree-track"><i style=${`width:${pct}%`}></i></span></div>
   <button type="button" class="lmx-task-tree-pet" aria-pressed="false" @click=${e=>{const b=e.currentTarget,active=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',String(active));b.textContent=active?'Checked in ✓':'Check in';const note=b.parentElement.querySelector('.lmx-task-tree-note');if(note)note.textContent=active?'Small steps count. Review the next blocker when you are ready.':'';}}>Check in</button><span class="lmx-task-tree-note" aria-live="polite"></span>
 </section>`;
}
export function waitingTeamCard(job) {
 const why=job.blocked_on?.note||job.last?.summary||'No reason was recorded for this wait.';
 return html`<article class="lmx-waiting-card"><div class="lmx-waiting-main"><a href=${'#/job/'+encodeURIComponent(job.id)}>${job.title||job.id}</a><div class="lmx-meta">${job.plan||'No plan'} · ${job.owner?agentName(job.owner):'Owner not assigned'}</div></div><details><summary>Why it is waiting</summary><p>${why}</p></details><a class="lm-btn lm-btn--secondary" href=${'#/job/'+encodeURIComponent(job.id)}>Review blocker</a></article>`;
}
export function terminalActionBanner({item,space,review}) {
 if(!item)return nothing;
 const prompt=dispatchPrompt({space,refs:[item.job?'job:'+item.job:null,item.trail?'decision:'+item.trail:null].filter(Boolean),sender:item.by,summary:item.summary||item.ask?.summary||''});
 return html`<section class="lmx-terminal-action" aria-label="Pending sign-off"><div><span class="lm-eyebrow">Pending sign-off</span><p>${item.summary||item.ask?.summary}</p><small>Review the exact action before approving. Copying does not dispatch an agent.</small></div><div class="lmx-terminal-buttons">${agentDispatchButton(prompt,'Copy dispatch')}<button type="button" class="lm-btn lm-btn--primary" @click=${review}>Review decision</button></div></section>`;
}
