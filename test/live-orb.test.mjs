import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveVariant,fallbackFaceStyle,defaultVariant} from '../public/live-orb.js';
test('orb material choices retain a static fallback',()=>{
 assert.equal(defaultVariant(true),'white');assert.equal(defaultVariant(false),'black');
 const custom=resolveVariant('custom','#0f6e68','#f4f8f5');assert.equal(fallbackFaceStyle(custom).backgroundColor,'#0f6e68');
 assert.match(fallbackFaceStyle(resolveVariant('webgl')).backgroundImage,/linear-gradient/);
});
