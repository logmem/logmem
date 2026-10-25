import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readTheme,writeTheme,applyTheme} from '../public/app/theme.js';
test('dashboard defaults to white and rejects invalid stored themes',()=>{
 assert.equal(readTheme({getItem:()=>null}),'white');
 assert.equal(readTheme({getItem:()=>'<script>'}),'white');
 assert.equal(readTheme({getItem:()=>{throw Error('blocked');}}),'white');
});
test('theme choice persists and updates both palette and color scheme',()=>{
 let saved;const storage={setItem:(k,v)=>{saved=[k,v];}};
 const root={dataset:{}};
 assert.equal(writeTheme('midnight',storage,root),'midnight');
 assert.deepEqual(saved,['lm-app-theme','midnight']);
 assert.deepEqual(root.dataset,{appTheme:'midnight',theme:'dark'});
 applyTheme('sage',root);assert.equal(root.dataset.theme,'light');
 assert.equal(writeTheme('invalid',storage,root),'white');
 assert.equal(writeTheme('sand',{setItem:()=>{throw Error('blocked');}},root),'sand');
 assert.equal(root.dataset.appTheme,'sand');
});
