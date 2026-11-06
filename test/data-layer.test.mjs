import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {withDefaults,envelope,KEYS,CONTRACT} from '../public/app/data-defaults.js';
test('a thin reply gets the lists the views index without a guard',()=>{
 const d=withDefaults('home',{__status:200,needs_count:2});
 assert.deepEqual(d.blocked,[]);assert.deepEqual(d.agents,[]);assert.equal(d.needs_count,2);
 assert.deepEqual(withDefaults('lanes',null).lanes,[]);
 assert.deepEqual(withDefaults('plan',{tracks:'bad'}).tracks,[]);
});
test('defaults never replace data the server sent',()=>{
 const d=withDefaults('agents',{agents:[{id:'a'}],extra:1});assert.equal(d.agents.length,1);assert.equal(d.extra,1);
});
test('envelope hides raw status codes and marks stale replies',()=>{
 assert.deepEqual(Object.keys(envelope('jobs',{__status:200,jobs:[]})).sort(),['data','error','ok','stale']);
 assert.equal(envelope('jobs',{__status:500,error:'down'}).ok,false);assert.equal(envelope('jobs',{__status:500,error:'down'}).error,'down');
 assert.equal(envelope('jobs',{__stale:true}).stale,true);assert.equal(envelope('jobs',{__stale:true}).ok,false);
});
test('every view that indexes lists loads through data.js',()=>{
 const views=fs.readFileSync(new URL('../public/app/views.js',import.meta.url),'utf8');
 for(const w of ['home','lanes','plan','agents'])assert.match(views,new RegExp(`load\\('${w}'`));
 assert.ok(CONTRACT>=1&&KEYS.home);
});
test('a cold load primes the space before a page reads it',()=>{
 const main=fs.readFileSync(new URL('../public/app/main.js',import.meta.url),'utf8');
 assert.match(main,/async function primeSpace/);assert.match(main,/state\.customer \|\| state\.space \|\| parts\[0\] === 'home'/);
 assert.match(main,/import \{ state, live, getJSON, api,/);
});
