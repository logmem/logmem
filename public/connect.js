// /connect: show the panel for the picked client and copy the link or the prompt.
// Every panel is plain HTML, so the page reads the same without this script.
import { CLIENTS, humanPrompt } from '/connect-prompt.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
document.documentElement.classList.add('js');

function pick(name) {
  $$('.client-pill').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.client === name)));
  $$('.client-panel').forEach(p => { p.hidden = p.dataset.client !== name; });
  try { sessionStorage.setItem('lm-connect-client', name); } catch {}
}
$('#client-pills').addEventListener('click', e => {
  const b = e.target.closest('.client-pill');
  if (b) pick(b.dataset.client);
});
$$('[data-copy-text]').forEach(btn => btn.addEventListener('click', async () => {
  const source = document.getElementById(btn.dataset.copyText);
  const note = btn.parentElement.querySelector('[role=status]');
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    note.textContent = 'Copied.';
  } catch {
    note.textContent = 'Select the text and copy it.';
  }
}));
let start = 'Claude';
try { const saved = sessionStorage.getItem('lm-connect-client'); if (CLIENTS.includes(saved)) start = saved; } catch {}
const hash = decodeURIComponent(location.hash.slice(1));
const named = CLIENTS.find(c => c.toLowerCase() === hash.toLowerCase());
pick(named || start);
