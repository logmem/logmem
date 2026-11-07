// admin-notes-model.js: the words for the operator pages. No lit import, so a test can load it.
export const SETTINGS_NOTE = 'These values come from the deploy. This page cannot change them.';
export const AUDIT_NOTE = 'This page reads saved checks. It does not run checks or change records.';
export const INVITE_RISK = 'Invite emails a link to the managed beta. A sent email cannot be taken back.';
export const inviteAllLabel = (n) => `Invite all ${n} not invited`;
export const inviteAllQuestion = (n) => `Email ${n} ${n === 1 ? 'person' : 'people'} a beta invitation? This cannot be undone.`;
