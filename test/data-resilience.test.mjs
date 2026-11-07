import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {withDefaults,contractProblem,failed,KEYS,CONTRACT} from '../public/app/data-defaults.js';
const app=(f)=>fs.readFileSync(new URL('../public/app/'+f,import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/app.css',import.meta.url),'utf8');

test('drawer reads Needs through data.js, never getJSON',()=>{
 const d=app('drawer.js');
 assert.doesNotMatch(d,/getJSON\(/);
 assert.doesNotMatch(d,/\/api\/needs/);
 assert.equal((d.match(/load\('needs'\)/g)||[]).length,2);
 assert.deepEqual(KEYS.needs,{items:[],count:0,stale:[]});
 assert.deepEqual(withDefaults('needs',{__status:200}).items,[]);
});
test('load catches network errors and returns stale defaults',()=>{
 const s=app('data.js');
 const load=s.slice(s.indexOf('export async function load'),s.indexOf('export async function read'));
 assert.match(load,/try \{ reply = await api\(what, extra\); \}/);
 assert.match(load,/catch \(e\)/);
 assert.match(load,/failed\(what/);
 const f=failed('jobs','offline');
 assert.equal(f.ok,false);assert.equal(f.stale,true);assert.equal(f.error,'offline');
 assert.deepEqual(f.data.jobs,[]);assert.deepEqual(f.jobs,[]);assert.equal(f.__status,0);
});
test('load checks the server contract and shape before it trusts a reply',()=>{
 const s=app('data.js');
 assert.match(s,/contractProblem\(what, reply\)/);
 assert.equal(contractProblem('jobs',{jobs:[]}),null);
 assert.equal(contractProblem('jobs',{contract:CONTRACT,jobs:[]}),null);
 assert.ok(contractProblem('jobs',{contract:CONTRACT+1,jobs:[]}));
 assert.ok(contractProblem('jobs',{jobs:'bad'}));
 assert.ok(contractProblem('jobs',null));
 assert.ok(contractProblem('jobs',[]));
 assert.ok(contractProblem('jobs','<html>'));
});
test('api/view.mjs sends the FE CONTRACT version on success',()=>{
 const src=fs.readFileSync(new URL('../api/view.mjs',import.meta.url),'utf8');
 assert.match(src,/import \{ CONTRACT \} from ["']\.\.\/public\/app\/data-defaults\.js["']/);
 assert.match(src,/contract:\s*CONTRACT/);
});
test('phone header shows at most four controls on map routes',()=>{
 assert.match(css,/@media \(max-width: 639px\)\{\s*:root \.lmx-head>\.lmx-map-toggle[^}]*display:none/);
 assert.match(css.slice(css.lastIndexOf("@media (max-width:639px)")),/^@media \(max-width:639px\)\{\.lmx-adminbar a\{display:none\}\}/);
});
