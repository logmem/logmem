import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {approveObject,reversibleLine,jobNext,jobHandoff,shiftEnds,earliestPass,evidenceLinks} from '../public/app/canvas-detail-model.js';
import {shiftRows} from '../public/app/profile-model.js';
const rd=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const M=60000,T=1_700_000_000_000;

test('approve label names the verb and object, plain Approve when none',()=>{
  assert.equal(approveObject({summary:'Codex asks to email issue 14 to 2,184 subscribers'}),' email');
  assert.equal(approveObject({summary:'Ready?',payload:{action:'gh pr merge 14'}}),' merge');
  assert.equal(approveObject({summary:'Is this fine?'}),'');
  assert.equal(approveObject(null),'');
});
test('reversible line shows only when the ask states it',()=>{
  assert.equal(reversibleLine({payload:{reversible:false}}).value,'No');
  assert.equal(reversibleLine({payload:{reversible:true}}).value,'Yes');
  assert.equal(reversibleLine({payload:{}}),null);
  assert.equal(reversibleLine(undefined),null);
});
test('job next step: you, blocked, owner next, or nothing',()=>{
  assert.equal(jobNext({open_asks:[{},{}]}).who,'you');
  assert.match(jobNext({open_asks:[{}]}).text,/decision below/);
  assert.deepEqual(jobNext({now:{stage:'blocked',blocked_on:{note:'Needs the price page'}}}),{who:'blocked',text:'Needs the price page'});
  assert.equal(jobNext({now:{stage:'active',owner:'agent:claude',next:'Check links'}}).who,'claude');
  assert.equal(jobNext({now:{stage:'done',next:'x'}}),null);
  assert.equal(jobNext({}),null);assert.equal(jobNext(undefined),null);
});
test('job handoff reads the newest handoff and its acceptance',()=>{
  const log=[{kind:'accepted',origin:'h1',ts:T+M,by:'agent:claude'},{kind:'handoff',trail:'h1',ts:T,by:'agent:chatgpt',to:'agent:claude',summary:'Draft by 11:00'},{kind:'progress',ts:T+5}];
  const h=jobHandoff(log);
  assert.deepEqual([h.from,h.to,h.message,h.acceptedMin],['chatgpt','claude','Draft by 11:00',1]);
  assert.equal(jobHandoff([{kind:'handoff',trail:'h2',ts:T,by:'a'}]).acceptedMin,null);
  assert.equal(jobHandoff([]),null);assert.equal(jobHandoff(null),null);
});
test('shift ends read the last recap or the recap entry, null when unknown',()=>{
  const recap={shift:'s1',mode:'manual',reason:'recap',ended_at:T,entry_count:17};
  assert.deepEqual(shiftEnds('s1',recap,[]),{endedBy:'Recap (manual)',endedAt:T,entries:17});
  const log=[{kind:'recap',origin:'s0',ts:T,summary:'claude recap (auto, idle): 9 entries this shift: 9 progress.'}];
  assert.deepEqual(shiftEnds('s0',null,log),{endedBy:'Auto recap',endedAt:T,entries:9});
  assert.deepEqual(shiftEnds('s9',recap,log),{endedBy:null,endedAt:0,entries:null});
  assert.equal(shiftEnds(undefined).entries,null);
});
test('shiftRows carries ended-by and entry count when known',()=>{
  const r=shiftRows([{shift:'s1',ts:2},{shift:'s0',ts:1}],'all',{recap:{shift:'s1',mode:'manual',entry_count:3},log:[]});
  assert.equal(r.rows[0].endedBy,'Recap (manual)');assert.equal(r.rows[0].entries,3);
  assert.equal(r.rows[1].endedBy,null);assert.equal(shiftRows([{shift:'x',ts:1}]).rows[0].entries,null);
});
test('earliest pass counts the passing streak and restarts after a fail',()=>{
  const day=(d,pass)=>({date:'2026-10-'+d,pass});
  const e=earliestPass([day(14,true),day(15,false)],{pass:false});
  assert.deepEqual(e,{streak:0,earliest:'Oct 22',restart:'Oct 16'});
  assert.deepEqual(earliestPass([day(15,false),day(16,true),day(17,true)],{}),{streak:2,earliest:'Oct 22',restart:null});
  assert.equal(earliestPass([day(17,true)],{pass:true}),null);
  assert.equal(earliestPass([],{}),null);assert.equal(earliestPass(undefined,undefined),null);
  assert.equal(earliestPass([day(10,true),day(12,true)],{}).streak,1);
});
test('evidence links point at the day checkup entry',()=>{
  const l=evidenceLinks({date:'2026-10-15'});
  assert.deepEqual([l[0].href,l[0].trail],['#/job/logmem-dogfood','dogfoodCheck-2026-10-15']);
  assert.deepEqual(evidenceLinks({date:'bad'}),[]);assert.deepEqual(evidenceLinks({date:'2026-10-15',ran:false}),[]);
});
test('views wire the new rows and keep one phone block',()=>{
  const cards=rd('public/app/cards.js'),views=rd('public/app/views.js'),prof=rd('public/app/profile-components.js'),health=rd('public/app/health-components.js'),css=rd('public/app.css');
  assert.match(cards,/btn\('Approve' \+ approveObject\(a\)/);assert.match(cards,/lmx-reversible/);
  assert.match(views,/earliestPass\(d\.days, g\)/);assert.match(views,/Earliest pass:/);
  assert.match(prof,/Ended by/);assert.match(health,/lmx-evidence/);
  assert.match(css,/\/\* canvas-detail \*\/[\s\S]*@media \(max-width: 639px\)\{/);
  const panels=rd('public/app/job-detail-components.js');assert.match(panels,/export const jobDetailPanels/);
  for(const n of ['decisions','pause','arrow-right','handoff']){assert.ok(rd('public/ds/components/bundle.css').includes(`[data-i="${n}"]`),n);}
});
