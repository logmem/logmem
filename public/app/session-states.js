// session-states.js: what a person reads when a session changes (canvas board SessionStates).
// Each notice says what failed, what it means for the data, and what to do. Raw server codes never show.
export const NOTICE = {
  expired: { title: 'Your sign-in expired.', body: 'Anything already saved is safe. Sign in again to continue.', action: 'Sign in again' },
  otherTab: { title: 'You signed out in another tab.', body: 'This tab stopped to match. Sign in to pick up where you left off.', action: 'Sign in' },
  approval: { title: 'Your approval was not recorded.', body: 'Your sign-in expired before you approved. Nothing ran. Sign in and approve again. The ask is still waiting.', action: 'Sign in and review ask' },
  suspended: { title: 'Your account is suspended.', body: 'Your agent keys are revoked. Your history is kept. Ask your workspace owner to restore access.', action: 'Sign in' },
  accessChanged: { title: 'Your access changed.', body: 'A workspace admin changed your role or your spaces. Pick a space to continue.', action: 'Choose a space' },
  gone: { title: 'This space is no longer available to you.', body: 'It may have been archived, or your access was removed. Pick another space.', action: 'Choose a space' },
  unreachable: { title: 'Couldn’t reach sign-in.', body: 'This is a problem on our side, not with your account. Your data is safe. Try again in a minute.', action: 'Try again' },
};

/** Which notice fits a failed call. status is the HTTP status, code the server's short error code, intent the X-LogMem-Intent. */
export function noticeFor({ status, code = '', intent = '' }) {
  if (/suspend/i.test(String(code))) return 'suspended';
  if (status === 401) return intent === 'decide' ? 'approval' : 'expired';
  if (status === 403) return 'accessChanged';
  if (status === 404) return 'gone';
  if (status === 503) return 'unreachable';
  return 'expired';
}
export const notice = (info) => NOTICE[noticeFor(info)];
/** One line for toasts and alerts. */
export const noticeLine = (info) => { const n = notice(info); return `${n.title} ${n.body}`; };

/** Admins see this when sign-in runs on a Clerk development instance (publishable key starts pk_test_). */
export const DEV_INSTANCE = { title: 'Sign-in runs on a development instance.', body: 'Sessions can drop. Move to production keys before launch.' };
export const isDevInstance = (clerk) => /^pk_test_/.test(String(clerk?.publishableKey || ''));
