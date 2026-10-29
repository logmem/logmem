import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLIENTS, MCP_URL, humanPrompt, agentPrompt, musePrompt } from '../public/connect-prompt.js';
const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
const decode = s => s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

test('/connect shows every client panel and prompt as static HTML, equal to the prompt module', async () => {
  const html = await read('public/connect.html');
  for (const name of CLIENTS) {
    const m = html.match(new RegExp(`<pre class="prompt-text" id="prompt-${name.toLowerCase()}"[^>]*>([\\s\\S]*?)</pre>`));
    assert.ok(m, name);
    assert.equal(decode(m[1]), name === 'Muse' ? musePrompt() : humanPrompt(name), name);
    assert.ok(html.includes(`data-client="${name}" role="group"`), name);
  }
  assert.equal(decode(html.match(/id="prompt-agent"[^>]*>([\s\S]*?)<\/pre>/)[1]), agentPrompt());
});

test('/connect names one MCP URL, in a copy box, and the order is link first then message', async () => {
  const html = await read('public/connect.html');
  assert.equal(MCP_URL, 'https://logmem.si/mcp');
  assert.match(html, /<code id="mcp-url">https:\/\/logmem\.si\/mcp<\/code>/);
  assert.ok(!/logmem\.si\/api\/mcp/.test(html));
  assert.ok(html.indexOf('id="s2"') < html.indexOf('id="s3"'));
  assert.ok(!/One prompt connects/.test(html), 'a prompt alone cannot connect an AI');
  assert.match(html, /Invite only until the beta opens on November 16/);
});

test('the homepage says the same thing about invites and the order', async () => {
  const html = await read('public/index.html');
  assert.match(html, /Invite only until the beta opens on November 16/);
  assert.match(html, /paste the prompt into your AI\. It gets the skills and connects/);
});
