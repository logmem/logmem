// Dashboard appearance is a local preference, independent of workspace authorization.
export const THEMES = Object.freeze(['white','sage','sand','midnight']);
const normalize = value => THEMES.includes(value) ? value : 'white';
export function readTheme(storage) {
  try { return normalize((storage || globalThis.localStorage)?.getItem('lm-app-theme')); }
  catch { return 'white'; }
}
export function applyTheme(value, root = globalThis.document?.documentElement) {
  const theme = normalize(value);
  if (root) { root.dataset.appTheme = theme; root.dataset.theme = theme === 'midnight' ? 'dark' : 'light'; }
  return theme;
}
export function writeTheme(value, storage, root = globalThis.document?.documentElement) {
  const theme = applyTheme(value, root);
  try { (storage || globalThis.localStorage)?.setItem('lm-app-theme', theme); } catch { /* Appearance still changes when storage is blocked. */ }
  return theme;
}
if (globalThis.document) applyTheme(readTheme());
