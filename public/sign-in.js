// Credentials stay in Clerk's own component. The server validates the return path.
(async () => {
 const root = document.getElementById('signin-root');
 const status = document.getElementById('signin-status');
 const retry = document.getElementById('signin-retry');
 retry.addEventListener('click', () => location.reload());
 if (!root.dataset.clerkFrontend) return;
 function script(src, key) {
  return new Promise((resolve, reject) => {
   const tag = document.createElement('script');
   tag.src = src; tag.crossOrigin = 'anonymous'; tag.async = true;
   if (key) tag.dataset.clerkPublishableKey = key;
   tag.onload = resolve; tag.onerror = () => reject(new Error('Sign-in could not load.'));
   document.head.append(tag);
  });
 }
 try {
  const frontend = root.dataset.clerkFrontend;
  await script(frontend + '/npm/@clerk/ui@1/dist/ui.browser.js');
  await script(frontend + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js', root.dataset.clerkKey);
  await window.Clerk.load({ui:{ClerkUI:window.__internal_ClerkUICtor}});
  const destination = root.dataset.returnTo === '/connections'
    ? '/api/connections?signin=1'
    : '/api/session?signin=1&returnTo=' + encodeURIComponent(root.dataset.returnTo);
  if (window.Clerk.isSignedIn) { location.replace(destination); return; }
  const tokens=getComputedStyle(document.documentElement),color=name=>tokens.getPropertyValue(name).trim();
  window.Clerk.mountSignIn(root, {
   routing:'hash',forceRedirectUrl:destination,
   signUpForceRedirectUrl:destination,
   appearance:{
    variables:{colorPrimary:color('--cockpit-action'),colorText:color('--text'),colorTextSecondary:color('--text-muted'),colorBackground:color('--surface'),colorInputBackground:color('--surface-sunken'),borderRadius:'12px',fontFamily:'inherit'},
    elements:{rootBox:{width:'100%'},cardBox:{width:'100%',boxShadow:'none'},card:{boxShadow:'none',padding:'0',border:'0'},header:{display:'none'},formButtonPrimary:{boxShadow:'none',textTransform:'none'}}
   }
  });
  status.textContent = '';
 } catch {
  status.textContent = 'We could not load secure sign-in. Check your connection and try again.';
  retry.hidden = false;
 }
})();
