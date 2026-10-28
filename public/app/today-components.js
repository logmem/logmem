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
 return html`<details class="lmx-plan lmx-plan-tile priority-tile"><summary><span class="lmx-plan-tile-heading"><strong title=${plan.title||plan.id}>${plan.title||plan.id}</strong>${laneBadge(plan.lane)}</span><span class="lmx-plan-tile-metrics"><span class="lmx-bar" role="progressbar" aria-label="Plan completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent}><i style=${'width:'+percent+'%'}></i></span><span>${done} of ${total} done</span><span class="lmx-pct">${percent}%</span></span><span class="lmx-plan-tile-meta" title=${plan.next_milestone?plan.next_milestone.title:''}>${plan.next_milestone?'Next: '+plan.next_milestone.title+(plan.next_milestone.date?' · '+plan.next_milestone.date:''):'No milestone'}</span></summary><div class="lmx-plan-tile-detail"><p><strong>${plan.title||plan.id}</strong></p>${plan.next_milestone?html`<p>${plan.next_milestone.title}${plan.next_milestone.date?' · '+plan.next_milestone.date:''}</p>`:html`<p>No milestone checklist was returned. Open the plan to review its work.</p>`}<a href=${'#/plan/'+encodeURIComponent(plan.id)}>Review plan and milestones →</a></div></details>`;
}
export function terminalActionBanner({item,space,review}) {
 if(!item)return nothing;
 const prompt=dispatchPrompt({space,refs:[item.job?'job:'+item.job:null,item.trail?'decision:'+item.trail:null].filter(Boolean),sender:item.by,summary:item.summary||item.ask?.summary||''});
 return html`<section class="lmx-terminal-action" aria-label="Pending sign-off"><div><span class="lm-eyebrow">Pending sign-off</span><p>${item.summary||item.ask?.summary}</p><small>Review the exact action before approving. Copying does not dispatch an agent.</small></div><div class="lmx-terminal-buttons">${agentDispatchButton(prompt,'Copy dispatch')}<button type="button" class="lm-btn lm-btn--primary" @click=${review}>Review decision</button></div></section>`;
}
