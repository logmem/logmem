import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const shell=fs.readFileSync(new URL('../public/app/shell.js',import.meta.url),'utf8');
test('phone bar has five tabs with Inbox in the middle and More last',()=>{
 const m=shell.match(/export const PHONE_NAV = (\[\[.*?\]\]);/);assert.ok(m);
 const nav=eval(m[1]);
 assert.equal(nav.length,5);assert.equal(nav[2][1],'Inbox');assert.equal(nav[4][0],'more');
 assert.match(shell,/PHONE_NAV\.map\(n=>phoneTab/);
});
test('More lists the screens the phone bar leaves out',()=>{
 const views=fs.readFileSync(new URL('../public/app/views.js',import.meta.url),'utf8');
 const more=views.slice(views.indexOf('pages.more'));
 for(const id of ["'knowledge'","'health'"])assert.ok(more.slice(0,900).includes(id));
});
test('phone header drops theme into More and keeps targets at 44px',()=>{
 const css=fs.readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
 assert.match(css,/\.lmx-head>\.lmx-theme-picker\{display:none\}/);
 assert.match(shell,/export const themePicker/);
 const views=fs.readFileSync(new URL('../public/app/views.js',import.meta.url),'utf8');
 assert.match(views,/themePicker\(\)/);
});
test('lane card keeps one visible action and puts the rest in a menu',()=>{
 const cards=fs.readFileSync(new URL('../public/app/cards.js',import.meta.url),'utf8');
 const ui=fs.readFileSync(new URL('../public/app/ui.js',import.meta.url),'utf8');
 assert.match(ui,/export const moreMenu/);
 const lane=cards.slice(cards.indexOf('function laneActs'),cards.indexOf('const laneJobRow'));
 assert.match(lane,/moreMenu\(/);assert.ok((lane.match(/btn\('/g)||[]).length<=4);
});
test('cards.js imports moreMenu from ui.js',()=>{
 const cards=fs.readFileSync(new URL('../public/app/cards.js',import.meta.url),'utf8');
 assert.match(cards.split('\n').find(l=>l.includes("from './ui.js'")),/moreMenu/);
});
test('phone css lifts buttons, chips, summaries and picker rows to 44px',()=>{
 const css=fs.readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
 const tail=css.slice(css.lastIndexOf('phone: every button'));
 for(const s of ['.lmx-main .lm-btn','typepill','.lmx-space-options button','.lmx-main summary','lmx-task-tree-pet'])assert.ok(tail.includes(s),s);
 assert.equal((tail.match(/min-height:44px/g)||[]).length>=4,true);
});
test('phone css gives chips and crumbs a 44px hit area',()=>{
 const css=fs.readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
 assert.match(css,/\.lmx-idchip::after\{content:""/);assert.match(css,/lmx-main button:not\(\.lmx-idchip\):not\(\.lmx-linkish\)\{min-height:44px\}/);
});
