// The site menu, written once. site-nav.js builds the header from it and test/site-nav.test.mjs checks every link.
import { AGENT_CLIENTS } from './app/agent-clients.js';

const CORE_SKILLS = [['logmem', 'Everyday LogMem'], ['logmem-onboard-agent', 'Agent onboarding'], ['logmem-decisions', 'Decisions and approvals']];

export const MENU = [
  { id: 'how', label: 'How it works', href: '/#network' },
  { id: 'control', label: 'Your control', href: '/#privacy' },
  { id: 'howto', label: 'How to use', href: '/how-to' },
  {
    id: 'agents', label: 'Agent setup', href: '/agents',
    sub: [
      { label: 'All clients', href: '/agents' },
      ...Object.entries(AGENT_CLIENTS).map(([id, c]) => ({ label: c.name, href: '/agents/' + id })),
      { label: 'Connect guide', href: '/connect' },
    ],
  },
  {
    id: 'skills', label: 'Skills', href: '/skills',
    sub: [{ label: 'All skills', href: '/skills' }, ...CORE_SKILLS.map(([id, label]) => ({ label, href: `/skills/${id}/SKILL.md` }))],
  },
  { id: 'pricing', label: 'Pricing', href: '/pricing' },
];
export const CTA = { label: 'Open your workspace', href: '/onboarding' };
/** A sub list longer than this opens in two columns on a wide screen. */
export const WIDE_AFTER = 6;
