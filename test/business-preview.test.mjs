import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';

test('business preview: decisions work only in isolated sample spaces and preserve origin checks', async t => {
  const slot = net.createServer();
  slot.listen(0, '127.0.0.1');
  await once(slot, 'listening');
  const port = slot.address().port;
  await new Promise(resolve => slot.close(resolve));
  const child = spawn(process.execPath, ['scripts/dev-site.mjs','--business-demos','--port',String(port)], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, VERCEL_ENV:'development', LOGMEM_ADMIN_PASSWORD:'', LOGMEM_ADMIN_SECRET:'', LOGMEM_DECIDE_SECRET:'' },
    stdio:['ignore','pipe','pipe'],
  });
  t.after(async()=>{ if(child.exitCode == null){ child.kill(); await once(child,'exit'); } });
  await new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>reject(new Error('Sample server did not start')),15000);
    child.stdout.on('data',data=>{ if(String(data).includes('site on')){clearTimeout(timer);resolve();} });
    child.once('error',e=>{clearTimeout(timer);reject(e);});
  });
  const base = 'http://127.0.0.1:'+port;
  const needs = await (await fetch(base+'/api/needs?space=demo-solo')).json();
  assert.equal(needs.count,1);
  const body = {space:'demo-solo',trail:needs.items[0].trail,verdict:'defer',note:'Sample review only'};
  const send = (value,origin=base)=>fetch(base+'/api/decide',{method:'POST',headers:{'content-type':'application/json','x-logmem-intent':'decide',origin},body:JSON.stringify(value)});
  assert.equal((await send(body,'https://unrelated.example')).status,403);
  assert.equal((await send({...body,space:'madez'})).status,403);
  const saved = await send(body);
  assert.equal(saved.status,201);
  const refreshed = await (await fetch(base+'/api/needs?space=demo-solo')).json();
  assert.equal(refreshed.count,1);
  assert.ok(refreshed.items[0].ask.deferred);
});

test('business preview: production mode refuses the disposable demo session', () => {
  const r = spawnSync(process.execPath,['scripts/dev-site.mjs','--business-demos','--port','0'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,VERCEL_ENV:'production'},encoding:'utf8',timeout:5000,
  });
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Business demos are local only/);
});
