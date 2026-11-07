// nav-model.js: which More links each viewer sees. Pure, so a test can cover every role.
// The server still checks access. This only stops the screen from offering pages a viewer cannot use.
export const ADMIN = [['settings', 'Settings', 'settings', '#/settings'], ['audit', 'Audit', 'eye', '#/audit'], ['waitlist', 'Waitlist', 'globe', '#/waitlist'], ['activity', 'Activity', 'timeline', '#/activity'], ['access', 'Agent access', 'link', '#/access']];
export const WORKSPACE_LINKS = [['decisions', 'Decisions', 'decisions'], ['knowledge', 'Knowledge', 'brief'], ['channels/fleet-truth', 'Fleet truth', 'eye'], ['health', 'Health', 'eye'], ['log', 'Log', 'timeline'], ['recall', 'Recall', 'recall']];
const OPERATOR_ONLY = new Set(['audit', 'waitlist', 'activity']);
const MANAGERS = ['owner', 'admin'];
/**
 * @param {{customer:boolean, role?:string}} who  customer false means an operator signed in with the admin password.
 * @param {Array} admin  the ADMIN list from shell.js
 * @returns {{workspace:Array, you:Array, admin:Array}}
 */
export function moreGroups({ customer, role }, admin) {
  const you = customer ? [['account', 'Settings', 'settings', '#/account']] : [];
  if (!customer) return { workspace: WORKSPACE_LINKS, you, admin };
  const manager = MANAGERS.includes(role);
  // Customers never get operator pages. Agent access stays for workspace managers.
  const rest = admin.filter((n) => n[0] === 'access' && manager);
  return { workspace: WORKSPACE_LINKS, you, admin: rest.filter((n) => !OPERATOR_ONLY.has(n[0])) };
}
