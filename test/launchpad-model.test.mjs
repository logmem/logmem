import test from 'node:test';
import assert from 'node:assert/strict';
import {launchpadProgress,taskDraft} from '../public/app/launchpad-model.js';
test('roster and saved preferences do not prove an agent entry',()=>{
 assert.equal(launchpadProgress({agents:[{id:'codex',seen:{state:'unknown',since:'never'}}]},{solo:true}).agent,false);
 assert.equal(launchpadProgress({agents:[{id:'codex',seen:{state:'offline',since:'2d'}}]}).agent,true);
});
test('progress remains after first task and needs three distinct steps',()=>{
 const data={agents:[{last:{ts:100}}],plans:[{jobs:1}]};
 assert.equal(launchpadProgress(data).percent,67);
 assert.equal(launchpadProgress(data,{solo:true}).complete,true);
 assert.equal(launchpadProgress({},{solo:true}).complete,false);
});
test('membership must belong to another person and the selected space',()=>{
 const data={members:[{userId:'self',spaces:{one:{}}},{userId:'other',spaces:{two:{}}}]};
 assert.equal(launchpadProgress(data,{userId:'self',spaceId:'one'}).collaborator,false);
 assert.equal(launchpadProgress(data,{userId:'self',spaceId:'two'}).collaborator,true);
});
test('task drafts preserve retry identity and validate titles',()=>{
 assert.deepEqual(taskDraft(' Read code ','task-fixed'),{title:'Read code',job:'task-fixed'});
 assert.throws(()=>taskDraft(' ','task-fixed'));
 assert.throws(()=>taskDraft('x'.repeat(121),'task-fixed'));
});
