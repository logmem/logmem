import {safeReturn} from './session.mjs';
import {signInPage,signInPolicy} from '../src/http/sign-in-page.mjs';
export const config={runtime:'nodejs',maxDuration:15};
export function frontendForKey(key='') {
 if(!/^pk_(test|live)_[A-Za-z0-9+/=]+$/.test(key))return '';
 const domain=Buffer.from(key.replace(/^pk_(test|live)_/,''),'base64').toString('utf8').replace(/\$$/,'');
 if(!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)||domain.includes('..'))return '';
 return 'https://'+domain;
}
export function createHandler({env=process.env}={}) {return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','text/html; charset=utf-8');
 if(req.method!=='GET'){res.statusCode=405;return res.end('Method not allowed.');}
 let back,client;try{const params=new URL(req.url,'https://logmem.invalid').searchParams;back=safeReturn(params.get('returnTo')||'/app');client=params.get('client')||'';}catch{res.statusCode=400;return res.end('Invalid return destination.');}
 const key=env.CLERK_PUBLISHABLE_KEY||'',frontend=frontendForKey(key);
 res.setHeader('Content-Security-Policy',signInPolicy(frontend));res.statusCode=frontend?200:503;
 return res.end(signInPage({publishableKey:frontend?key:'',frontend,returnTo:back,client}));
};}
export default createHandler();
