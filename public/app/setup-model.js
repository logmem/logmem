// Setup preferences describe navigation, never connection proof.
import {AGENT_CLIENTS} from './agent-clients.js';
export const GUIDE_STEPS=['Choose agent','Read skills','Connect','Verify'];
export const clientId=value=>Object.hasOwn(AGENT_CLIENTS,value)?value:'';
export function guideState(value={}){return {client:clientId(value.client),step:Math.max(0,Math.min(3,Number.isInteger(value.step)?value.step:0)),closed:value.closed===true};}
export function readGuide(scope,storage=globalThis.sessionStorage){try{return guideState(JSON.parse(storage.getItem('lm-guide:'+scope)||'{}'));}catch{return guideState();}}
export function saveGuide(scope,value,storage=globalThis.sessionStorage){try{storage.setItem('lm-guide:'+scope,JSON.stringify(guideState(value)));}catch{}}
export function setupReturn(client,step=2){const id=clientId(client);return '/app?'+new URLSearchParams({setup:'guided',...(id?{client:id}:{}),step:String(guideState({step}).step)})+'#/home';}
export function selectedEntry(agents,client){return (agents||[]).filter(a=>String(a.id||a.agent||'').replace(/^agent:/,'')===client);}
