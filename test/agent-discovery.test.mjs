import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AGENT_CLIENTS} from '../public/agent-clients.js';
import {createHandler} from '../api/sign-in.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';
const read = path => readFile(new URL('../'+path,import.meta.url),'utf8');
test('public agent paths and skills are crawlable and listed without protected routes',async()=>{
 const robots=await read('public/robots.txt'),sitemap=await read('public/sitemap.xml');
 assert.match(robots,/Disallow: \/api\//);assert.match(robots,/Disallow: \/sign-in/);
 for(const id of Object.keys(AGENT_CLIENTS)){
  assert.ok(sitemap.includes('https://logmem.si/agents/'+id));
  const html=await read('public/agents/'+id+'.html');
  assert.ok(html.indexOf('Read the skills first')<html.indexOf('Connect your client'));
  assert.match(html,/Sign-in authenticates a person/);assert.match(html,/Verify, then assign work/);
  assert.ok(html.includes('/sign-in?client='+id));assert.ok(html.includes('/skills/logmem-onboard-agent/SKILL.md'));
 }
 for(const path of ['/app','/keys','/connections','/api/','/sign-in'])assert.ok(!sitemap.includes('<loc>https://logmem.si'+path));
});
test('published skills match reviewed repository sources, including relative references',async()=>{
 async function walk(dir){for(const item of await readdir(new URL('../'+dir,import.meta.url),{withFileTypes:true})){
  const path=dir+'/'+item.name;if(item.isDirectory())await walk(path);else if(item.name.endsWith('.md'))assert.equal(await read('public/'+path),await read(path),path);
 }}await walk('skills');
});
test('AI reading guides give skills-first setup and avoid claiming public access',async()=>{
 const guide=await read('public/llms.txt');assert.equal(await read('public/llm.txt'),guide);
 assert.match(guide,/skills first/);assert.match(guide,/Managed access is invite only/);assert.match(guide,/not a public crawl target/);
 for(const id of Object.keys(AGENT_CLIENTS))assert.ok(guide.includes('/agents/'+id));
 assert.match(await read('public/llm.tx'),/https:\/\/logmem.si\/llms.txt/);
});
test('branded client sign-in context is allowlisted and does not alter destination validation',async()=>{
 const env={CLERK_PUBLISHABLE_KEY:'pk_test_'+Buffer.from('test-login.clerk.accounts.dev$').toString('base64')};
 const h=createHandler({env});
 for(const [id,client] of Object.entries(AGENT_CLIENTS)){
  const res=mockRes();await h(mockReq({url:'/sign-in?client='+id}),res);
  assert.equal(res.statusCode,200);assert.ok(res.body.includes('Continue '+client.name+' setup.'));
  assert.match(res.body,/data-return-to="\/app"/);assert.match(res.body,/does not connect or launch an agent/);
 }
 const res=mockRes();await h(mockReq({url:'/sign-in?client='+encodeURIComponent('\"><script>alert(1)</script>')}),res);
 assert.ok(!res.body.includes('alert(1)'));assert.match(res.body,/Pick up where you left off/);
 const bad=mockRes();await h(mockReq({url:'/sign-in?client=codex&returnTo=https://evil.example'}),bad);assert.equal(bad.statusCode,400);
});
