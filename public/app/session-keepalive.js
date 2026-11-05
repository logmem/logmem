// Keeps the customer sign-in fresh. Clerk session tokens last 60 seconds and only
// clerk-js renews the __session cookie, so /app loads it once the account is known.
// The publishable key is public by design. No secret reaches the browser.
let loading=null;
function loadScript(src,key){
 return new Promise((resolve,reject)=>{
  const tag=document.createElement('script');
  tag.src=src;tag.crossOrigin='anonymous';tag.async=true;tag.dataset.clerkPublishableKey=key;
  tag.onload=resolve;tag.onerror=()=>reject(new Error('session keep-alive could not load'));
  document.head.append(tag);
 });
}
export function startKeepAlive(clerk){
 if(!clerk||!clerk.frontend||!clerk.publishableKey)return null;
 if(!loading){
  loading=(async()=>{
   await loadScript(clerk.frontend+'/npm/@clerk/clerk-js@6/dist/clerk.browser.js',clerk.publishableKey);
   await window.Clerk.load({telemetry:false});
   return window.Clerk;
  })().catch(()=>{loading=null;return null;});
 }
 return loading;
}
/** Ask Clerk for a fresh token, which also rewrites the cookie. True only when one came back. */
export async function refreshSession(){
 if(!loading)return false;
 const clerk=await loading;
 if(!clerk||!clerk.session)return false;
 try{return Boolean(await clerk.session.getToken({skipCache:true}));}catch{return false;}
}
