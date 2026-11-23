import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ageLabel,ticketAgeBadge} from '../public/app/dispatch-model.js';
import {briefTiles} from '../public/app/brief-model.js';
const read=f=>fs.readFileSync(new URL('../public/'+f,import.meta.url),'utf8');
const shell=read('app/shell.js'),inter=read('app/interactions.js'),dc=read('app/dispatch-components.js'),views=read('app/views.js'),css=read('app.css');
test('phone tabs draw a needs badge on Today and Inbox, hidden at zero or null',()=>{
 assert.match(shell,/\(id === 'home' \|\| id === 'queue'\) && Number\(live\.needs\) > 0/);
 assert.match(shell,/aria-label=\$\{n \?/);
 assert.match(css,/\.lmx-tabs b\{position:absolute/);
});
test('Inbox page: title, list before collapsed map',()=>{
 assert.match(inter,/<h1>Inbox<\/h1>/);
 assert.doesNotMatch(inter,/<h1>Coordination queue<\/h1>/);
 assert.ok(inter.indexOf('id="lmx-queue-list"')<inter.indexOf('class="lmx-queue-map"'));
 assert.match(inter,/mapOpen=false/);
 assert.doesNotMatch(inter+dc,/Snooze|Mark done/);
});
test('Inbox uses keyset pages, resets filters, and ignores stale responses',()=>{
 assert.match(inter,/paging:'keyset'/);
 assert.match(inter,/data\?\.nextAfter/);
 assert.match(inter,/request!==requestSeq/);
 assert.match(inter,/bucket=value;load\(\{reset:true\}\)/);
 assert.match(inter,/recipient=e\.target\.recipient\.value\.trim\(\);load\(\{reset:true\}\)/);
 assert.match(inter,/busy\|\|mp>=mpMax&&data\.nextAfter==null/);
 assert.doesNotMatch(inter,/queue:'1',cursor/);
});
test('ticket age badge text',()=>{
 const now=1e12,h=3600000;
 assert.equal(ageLabel(now-26*h,now),'26h');
 assert.equal(ageLabel(now-72*h,now),'3d');
 assert.equal(ageLabel(0,now),'');
 assert.equal(ticketAgeBadge({created_at:now-30*h,deadline:now-26*h},now),'Overdue · 30h unanswered');
 assert.equal(ticketAgeBadge({created_at:now-3*h,deadline:now+h},now),'Awaiting · 3h');
 assert.equal(ticketAgeBadge({},now),'Awaiting response');
 assert.match(dc,/agentChip\(item\.from,space\)/);
});
test('demo badge wording and no unicode glyph icons in shell',()=>{
 assert.equal((shell.match(/DEMO DATA/g)||[]).length,2);
 assert.doesNotMatch(shell,/Sample space|Contains sample content/);
 for(const g of ['▣','⌄','✓','＋'])assert.ok(!shell.includes(g)&&!dc.includes(g),g);
});
test('Brief tiles come from the brief model and link to their pages',()=>{
 assert.match(views,/statTiles\(\{ needs, queue: q, agents: d\.agents, plans: d\.plans \}/);
 assert.doesNotMatch(views,/Number\.isFinite\(b\.total\)&&b\.total>0&&Number\.isFinite\(value\)/);
 const tiles=briefTiles({needs:[{type:'decision'}],queue:{items:[]},agents:[],plans:[]},1e12);
 assert.deepEqual(tiles.map(t=>t.href),['#/needs','#/queue/overdue','#/agents','#/plans']);
 assert.match(css,/\/\* canvas-inbox \*\//);
});
test('Workspace views skip the assistant rail and use the full width',()=>{
 assert.match(shell,/NO_ASSISTANT\.has\(route\)\?nothing:workspaceAssistant\(route\)/);
 for(const r of ['home','overview','queue','activity','agents','agent','work','chat','slots','health']){
  assert.match(shell,new RegExp(`NO_ASSISTANT = new Set\\(\\[[^\\]]*'${r}'`));
 }
 assert.match(css,/\.lmx-workarea\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
});
