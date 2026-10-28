import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedCount,healthQueueItems,auditResult,auditVectors,auditDays,volumeChecks} from '../public/app/health-model.js';
test('Health filters loaded records without changing the source array',()=>{
 const rows=[{id:'a',created_at:1,deadline:5},{id:'b',read_only:true,created_at:1,deadline:500},{id:'c',deadline:'bad'}];
 assert.equal(healthQueueItems(rows,'all',100).length,3);assert.deepEqual(healthQueueItems(rows,'overdue',100).map(i=>i.id),['a']);assert.deepEqual(healthQueueItems(rows,'unindexed',100).map(i=>i.id),['b']);assert.equal(rows.length,3);
});
test('Audit distinguishes paused and volume gates from health failures',()=>{
 assert.equal(auditResult({paused:true,pass:false}),'Paused');assert.equal(auditResult({pass:false,health_pass:true}),'Low volume');assert.equal(auditResult({}),'Unknown');
 const vectors=auditVectors({mirror_checked:true,mirror_mismatches:190,unanswered_24h:4,degraded_sessions:0});assert.deepEqual(vectors.filter(v=>v.active).map(v=>v.key),['mirror','unanswered']);
 assert.equal(auditVectors({mirror_checked:false,mirror_mismatches:190})[0].active,false);assert.equal(auditVectors({})[0].value,null);
});
test('Audit history filters only observed signals and preserves day data',()=>{
 const days=[{date:'2026-10-27',mirror_checked:true,mirror_mismatches:2},{date:'2026-10-28',unanswered_24h:1}];
 assert.equal(auditDays(days,'mirror').length,1);assert.equal(auditDays(days,'unanswered')[0].date,'2026-10-28');assert.equal(days[0].date,'2026-10-27');
 assert.equal(recordedCount(null),null);assert.equal(recordedCount(-1),null);assert.equal(recordedCount(0),0);
});
test('Volume diagnostics use the recorded three-agent and handoff criteria',()=>{
 const checks=volumeChecks({agents:['one','two'],handoffs:3,accepted:1});assert.deepEqual(checks.map(c=>c.pass),[false,true,false]);assert.equal(volumeChecks({})[0].pass,null);
});
