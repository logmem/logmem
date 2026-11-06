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
test('route shows a busy bar while it loads and offers Try again on failure',()=>{
 const main=fs.readFileSync(new URL('../public/app/main.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
 assert.match(main,/setBusy\(true\)/);assert.match(main,/\.finally\(\(\) => setBusy\(false\)\)/);assert.match(main,/Try again/);
 assert.match(css,/:root\[data-route-busy\]::before/);assert.match(css,/prefers-reduced-motion:reduce\)\{:root\[data-route-busy\]/);
});
const src=(f)=>fs.readFileSync(new URL('../public/app/'+f,import.meta.url),'utf8');
test('views, drawer and search no longer call api() directly',()=>{
 for(const f of ['views.js','drawer.js','search.js']){
  assert.doesNotMatch(src(f),/\bapi\('/,f+' still calls api()');
  assert.doesNotMatch(src(f),/import \{[^}]*\bapi\b[^}]*\} from '\.\/core\.js'/,f+' still imports api');
 }
 assert.match(src('data.js'),/await api\(what, extra\)/);
});
test('KEYS covers every what that views, drawer and search load',()=>{
 const used=new Set();
 for(const f of ['views.js','drawer.js','search.js'])for(const m of src(f).matchAll(/\bload(?:Data)?\('([a-z]+)'/g))used.add(m[1]);
 assert.ok(used.size>=12,'found '+used.size);
 for(const w of used)assert.ok(w in KEYS,'KEYS is missing '+w);
});
test('plan and huddle defaults cover fields the views index',()=>{
 assert.deepEqual(withDefaults('plan',{}).milestones,[]);
 assert.deepEqual(withDefaults('huddle',{huddle:{}}).replies,[]);
});
test('settings link cluster hides on phones only',()=>{
 const css=fs.readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
 assert.match(css.slice(css.lastIndexOf('@media (max-width:639px)')),/^@media \(max-width:639px\)\{\.lmx-adminbar a\{display:none\}\}/);
 assert.doesNotMatch(css,/^\.lmx-adminbar a\{[^}]*display:none/m);
});
