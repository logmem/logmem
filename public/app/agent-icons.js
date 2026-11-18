// LobeHub logos used in agent profiles and the shared avatar helper.
import { LOBEHUB_ICONS } from './lobehub-icons.js';
import { state } from './core.js';

const bySlug = new Map(LOBEHUB_ICONS.map((icon) => [icon.slug, icon]));
const STORE_KEY = 'logmem.agent-icons.v1';
const ALIASES = {
  'claude-code': 'claudecode',
  'gemini-cli': 'geminicli',
};

function identity(value) {
  const raw = String(value || '').trim();
  if (!raw || /^human:/i.test(raw)) return '';
  return raw.replace(/^agent:/i, '').toLowerCase();
}

function readChoices() {
  try {
    const choices = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {};
  } catch {
    return {};
  }
}

function recordKey(space, id) {
  return JSON.stringify([String(space || ''), state.customer ? state.workspaceId || '' : '', state.customer ? state.spaceId || '' : '', state.user?.id || '', id]);
}

function automaticSlug(id) {
  const exact = bySlug.has(id) ? id : ALIASES[id];
  return exact && bySlug.has(exact) ? exact : '';
}

/** Return only a profile choice made by the user. */
export function savedAgentIcon(space, value) {
  const id = identity(value);
  if (!id) return null;
  const slug = readChoices()[recordKey(space, id)];
  return slug && bySlug.has(slug) ? bySlug.get(slug) : null;
}

/** Return the saved logo or an exact-name LobeHub logo for an agent. */
export function agentIcon(space, value) {
  const id = identity(value);
  if (!id) return null;
  return savedAgentIcon(space, id) || bySlug.get(automaticSlug(id)) || null;
}

/** Save only a visual choice in this browser and this space. */
export function saveAgentIcon(space, value, slug) {
  const id = identity(value);
  if (!id || (slug && !bySlug.has(slug))) return false;
  try {
    const choices = readChoices(), key = recordKey(space, id);
    if (slug) choices[key] = slug;
    else delete choices[key];
    localStorage.setItem(STORE_KEY, JSON.stringify(choices));
    return true;
  } catch {
    return false;
  }
}
