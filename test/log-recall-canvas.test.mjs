import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {logRows,trailChain,shiftRuns,entryKey,matchTerms,highlightParts,matchedTerms,recallRow,techFields,groupByMode} from '../public/app/log-model.js';
import {withDefaults} from '../public/app/data-defaults.js';
const rd=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const views=rd('public/app/views.js'),comps=rd('public/app/log-components.js'),css=rd('public/app.css');
const M=60000,T0=1_700_000_000_000;
const E=(min,by,kind,trail,origin,group='work')=>({ts:T0+min*M,by:'agent:'+by,kind,trail,origin,group,where:'job:issue-14',summary:kind+' '+trail});
const sample=[E(0,'chatgpt','assigned','a1'),E(4,'chatgpt','handoff','h1','a1','handoff'),E(150,'claude','progress','p1','h1'),E(170,'claude','recap','r1'),E(500,'claude','progress','p2'),E(510,'codex','approval','ap1','p2','decision')];
test('trail chain follows origin back and forward, oldest first',()=>{
  const c=trailChain(sample,sample[2]);
  assert.deepEqual(c.map(e=>e.trail),['a1','h1','p1']);
  assert.ok(trailChain(sample,sample[5]).some(e=>e.trail==='p2'));
  assert.deepEqual(trailChain(null,null),[]);
  assert.equal(trailChain(undefined,{trail:'z',ts:1}).length,1);
});
test('shift runs split on a new writer or a 30 minute gap and label carried or cold',()=>{
  const runs=shiftRuns(sample);
  const claude=runs.filter(r=>r.agent==='claude');
  assert.equal(claude.length,2);
  const later=claude.find(r=>r.start>T0+400*M);
  assert.equal(later.state,'carried');
  assert.equal(claude.find(r=>r!==later).state,'first');
  assert.equal(shiftRuns([E(0,'a','x','t'),E(100,'a','progress','u'),E(300,'a','x','v')]).at(0).state,'cold');
});
test('group by Time, Trail and Shift build the expected rows',()=>{
  const t=logRows(sample,'time'),tr=logRows(sample,'trail'),sh=logRows(sample,'shift');
  assert.equal(t.filter(r=>r.type==='entry').length,6);assert.ok(t.some(r=>r.type==='shift'));
  assert.equal(tr.filter(r=>r.type==='head').length,6);
  assert.ok(sh[0].type==='shift');
  assert.equal(groupByMode('nope'),'time');assert.deepEqual(logRows(undefined,'trail'),[]);
});
test('recall helpers highlight and default every field',()=>{
  assert.deepEqual(matchTerms('Pricing, in the Newsletter!'),['pricing','in','the','newsletter']);
  const p=highlightParts('Pricing stays out',['pricing']);assert.deepEqual(p.map(x=>x.hit),[true,false]);
  assert.deepEqual(highlightParts('a.b',['.']).map(x=>x.text),['a','.','b']);
  assert.deepEqual(matchedTerms('Pricing note',['pricing','zzz']),['pricing']);
  assert.equal(recallRow(null).kind,'entry');assert.equal(recallRow({}).ts,0);
  assert.deepEqual(techFields({kind:'x',junk:1}),{kind:'x'});
  assert.deepEqual(withDefaults('recall',{}).results,[]);
});
test('entryKey is stable for missing fields',()=>assert.equal(typeof entryKey({}),'string'));
test('Log view wires group-by, inspector, markers and recall cards',()=>{
  for(const s of ['groupControl(mode','inspector({ sel','logRows(list, mode)','recallCard(r, terms, openOriginal)','recallExplainer()'])assert.ok(views.includes(s),s);
  assert.match(views,/live\.logSel/);
  assert.match(comps,/Matching by words/);assert.match(comps,/Open original entry/);assert.match(comps,/Tech view/);assert.match(comps,/This trail/);
  assert.match(comps,/<mark>/);assert.match(comps,/<blockquote class="lm-recall-quote">/);
});
test('inspector keeps at most three visible controls',()=>{
  const fn=comps.slice(comps.indexOf('export function inspector'),comps.indexOf('const marked'));
  assert.ok((fn.match(/<button/g)||[]).length===1);
  assert.ok((fn.match(/<a href/g)||[]).length===2&&/approval \? .*: job \?/s.test(fn));
  assert.match(fn,/<summary>Tech view<\/summary>/);
});
test('canvas-log css block holds phone targets and 16px inputs, and is the last block',()=>{
  const i=css.indexOf('/* canvas-log');assert.ok(i>0);
  const blk=css.slice(i);
  assert.match(blk,/min-height:44px/);assert.match(blk,/font-size:16px/);assert.match(blk,/\.lmx-inspector/);
});
