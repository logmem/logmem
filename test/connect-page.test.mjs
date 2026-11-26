import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLIENTS, MCP_URL, humanPrompt, agentPrompt, musePrompt } from '../public/connect-prompt.js';
const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
const decode = s => s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

function clientPanel(html, name) {
  const start = html.indexOf(`<div class="client-panel" data-client="${name}" role="group"`);
  assert.ok(start >= 0, `missing panel for ${name}`);
  const next = html.indexOf('<div class="client-panel" data-client=', start + 1);
  const end = next >= 0 ? next : html.indexOf('<details class="agent-prompt">', start);
  return html.slice(start, end);
}

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
  assert.match(html, /Hosted plans: join the waitlist\./);
  assert.doesNotMatch(html, /November 16|Nov\.? 16/);
});

test('/connect removes the /agents hop from all paste prompts and shared prompt helpers', async () => {
  const html = await read('public/connect.html');
  const homeJs = await read('public/home.js');
  const goPrompt = await read('public/app/go-prompt.js');
  for (const name of CLIENTS) {
    const p = name === 'Muse' ? musePrompt() : humanPrompt(name);
    assert.doesNotMatch(p, /logmem\.si\/agents/, `${name} prompt must not send users through /agents`);
  }
  assert.doesNotMatch(agentPrompt(), /logmem\.si\/agents/, 'agent prompt must not send agents through /agents');
  assert.doesNotMatch(goPrompt, /logmem\.si\/agents/, 'shared prompt module must not hop through /agents');
  assert.doesNotMatch(homeJs, /logmem\.si\/agents/, 'home.js prompt copies must not hop through /agents');
  for (const m of html.matchAll(/<pre class="prompt-text"[^>]*>([\s\S]*?)<\/pre>/g)) {
    assert.doesNotMatch(m[1], /logmem\.si\/agents/);
  }
});

test('/connect gives exact Gemini CLI and Codex setup steps instead of vague settings wording', async () => {
  const html = await read('public/connect.html');
  assert.doesNotMatch(html, /MCP settings of your Gemini app|MCP server settings of your Codex install/);

  const gemini = clientPanel(html, 'Gemini');
  assert.ok(gemini.includes('~/.gemini/settings.json'), 'Gemini panel names settings.json');
  assert.ok(gemini.includes('"mcpServers"'), 'Gemini panel shows mcpServers');
  assert.ok(gemini.includes('"httpUrl": "https://logmem.si/mcp"'), 'Gemini panel uses httpUrl for Streamable HTTP');
  assert.ok(gemini.includes('gemini mcp add -s user --transport http logmem https://logmem.si/mcp'), 'Gemini panel shows exact gemini mcp add command');
  assert.ok(gemini.includes('gemini mcp list'), 'Gemini panel shows gemini mcp list');
  assert.ok(gemini.includes('/mcp'), 'Gemini panel shows /mcp');
  assert.ok(gemini.includes('/mcp auth logmem'), 'Gemini panel shows /mcp auth logmem');

  const codex = clientPanel(html, 'Codex');
  assert.ok(codex.includes('~/.codex/config.toml'), 'Codex panel names config.toml');
  assert.ok(codex.includes('[mcp_servers.logmem]'), 'Codex panel shows [mcp_servers.logmem]');
  assert.ok(codex.includes('url = "https://logmem.si/mcp"'), 'Codex panel shows hosted url in config.toml');
  assert.ok(codex.includes('codex mcp add logmem --url https://logmem.si/mcp'), 'Codex panel shows exact codex mcp add command');
  assert.ok(codex.includes('codex mcp login logmem'), 'Codex panel shows codex mcp login');
  assert.ok(codex.includes('codex mcp list'), 'Codex panel shows codex mcp list');
});

test('/connect includes an explicit logmem_connection done-check on every client tab', async () => {
  const html = await read('public/connect.html');
  for (const name of CLIENTS) {
    const panel = clientPanel(html, name);
    assert.match(panel, /logmem_connection/, `${name} panel names logmem_connection`);
    assert.match(panel, /ok:\s*true/, `${name} panel checks ok: true`);
    assert.match(panel, /<code>space<\/code>|\bexpected space\b/, `${name} panel checks expected space`);
    assert.match(panel, /degraded:\s*false/, `${name} panel checks degraded: false`);
  }
  const okSection = html.slice(html.indexOf('id="ok"'), html.indexOf('id="stuck"'));
  assert.match(okSection, /logmem_connection/);
  assert.match(okSection, /ok:\s*true/);
  assert.match(okSection, /degraded:\s*false/);
});

test('/connect waitlist and invite wording reflects the live invite-gated backend and self-host path', async () => {
  const html = await read('public/connect.html');
  assert.match(html, /Managed hosted access is invite only unless you already received an invite or a teammate’s workspace invitation link\./);
  assert.match(html, /self-host on your own Redis.*no invite needed/i);
  assert.match(html, /Self-host \(no invite needed\)/);
  assert.match(html, /@logmem\/mcp/);
  assert.match(html, /Hosted \(invite only\)/);
});

test('the homepage says the same thing about invites and the order', async () => {
  const html = await read('public/index.html');
  assert.match(html, /Hosted plans: join the waitlist\./);
  assert.doesNotMatch(html, /November 16|Nov\.? 16/);
  assert.match(html, /paste the prompt into your AI\. It gets the skills and connects/);
});
