// Path and denial rules for the Next dashboard.
// Workspace screens are /space/[space]/[page]. /app is the existing customer
// app on the main site and is not a route in this app.

export const SPACE_PAGES = Object.freeze([
  'today',
  'inbox',
  'schedule',
  'work',
  'agents',
  'activity',
  'access',
]);

export const SELECT_SPACE_PATH = '/select-space';
export const ACCESS_DENIED_PATH = '/space/denied';

const SPACE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validSpaceId(space) {
  return typeof space === 'string' && SPACE_ID.test(space) && !space.includes('..');
}

export function spacePath(space, page = 'today') {
  if (!validSpaceId(space) || !SPACE_PAGES.includes(page)) return SELECT_SPACE_PATH;
  return `/space/${space}/${page}`;
}

/** Only same-site dashboard paths may be a sign-in return target. */
export function safeReturnTo(path) {
  if (path === SELECT_SPACE_PATH) return path;
  if (typeof path !== 'string' || path.includes('..') || path.includes('\\') || path.includes('//')) {
    return SELECT_SPACE_PATH;
  }
  const match = /^\/space\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return SELECT_SPACE_PATH;
  return spacePath(match[1], match[2]);
}

/**
 * Workspace membership and role checks use these codes.
 * not_found is how the workspace layer reports "not a member" and "no such space".
 * forbidden is a role that cannot take the action. Neither is a missing dashboard page.
 */
export function isMembershipDenial(error) {
  if (!error || typeof error !== 'object') return false;
  return error.code === 'not_found' || error.code === 'forbidden';
}

export function isSignInRequired(error) {
  if (!error || typeof error !== 'object') return false;
  return error.code === 'sign_in_required';
}
