// /how-to: show the seed prompt and copy it. The prompt text comes from the one prompt module.
import { seedPrompt, developerSeedPrompt } from '/app/seed-prompt.js';
const box = document.getElementById('seed-prompt');
const toggle = document.getElementById('dev-toggle');
let dev = false;
const draw = () => { box.textContent = dev ? developerSeedPrompt() : seedPrompt(); toggle.setAttribute('aria-pressed', String(dev)); };
toggle.addEventListener('click', () => { dev = !dev; draw(); });
for (const btn of document.querySelectorAll('[data-copy-text]')) btn.addEventListener('click', async () => {
  const note = btn.parentElement.querySelector('[role=status]');
  try { await navigator.clipboard.writeText(document.getElementById(btn.dataset.copyText).textContent.trim()); note.textContent = 'Copied.'; }
  catch { note.textContent = 'Select the text and copy it.'; }
});
draw();
