import test from 'node:test';
import assert from 'node:assert/strict';
import {guideState,readGuide,saveGuide,setupReturn,selectedEntry} from '../public/app/setup-model.js';
import {safeReturn} from '../api/session.mjs';
test('guide preferences allow known clients and bounded navigation only',()=>{
 assert.deepEqual(guideState({client:'evil',step:99,closed:true,token:'secret'}),{client:'',step:3,closed:true});
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 saveGuide('user:workspace:one',{client:'codex',step:2},storage);
 assert.equal(readGuide('user:workspace:two',storage).client,'');
 assert.equal(readGuide('user:workspace:one',storage).step,2);
 assert.equal(readGuide('x',{getItem:()=>{throw Error();}}).step,0);
});
test('setup return remains a validated local app route and carries no arbitrary client',()=>{
 const back=setupReturn('claude',3);assert.equal(safeReturn(back),back);
 const u=new URL(back,'https://logmem.si');assert.equal(u.searchParams.get('client'),'claude');assert.equal(u.searchParams.get('step'),'3');
 assert.equal(new URL(setupReturn('https://evil.test'),'https://logmem.si').searchParams.has('client'),false);
});
test('verification records belong to the chosen agent',()=>{
 assert.deepEqual(selectedEntry([{id:'agent:codex'},{id:'claude'},{id:'unknown'}],'codex'),[{id:'agent:codex'}]);
 assert.deepEqual(selectedEntry([{id:'claude'}],'codex'),[]);
});
