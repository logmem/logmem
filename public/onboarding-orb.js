// One decorative setup companion. Step copy describes guidance, never runtime status.
import {createLiveOrb} from './live-orb.js';
const root=document.querySelector('[data-setup-companion]');
if(root){
 const canvas=root.querySelector('canvas'),message=root.querySelector('[data-companion-message]');
 const words={choose:'Open your workspace, then connect your AI.',connect:'Connect one agent, then check its first entry.',first:'Read the example, then verify your own agent in the app.'};
 const sync=()=>{message.textContent=words[document.body.dataset.obStep]||'Take one step at a time. Your setup stays in your control.';};
 let orb=null;
 const start=()=>{
  if(orb)return;
  try{orb=createLiveOrb(canvas,{variant:'custom',color:'#0F6E68',eyeColor:'#F4F8F5',interactive:true,blink:true,onHasGl:ok=>{root.dataset.gl=String(ok);}});}
  catch{root.dataset.gl='false';}
 };
 const stop=()=>{orb?.destroy();orb=null;root.dataset.gl='false';};
 const steps=new MutationObserver(sync);steps.observe(document.body,{attributes:true,attributeFilter:['data-ob-step']});
 sync();start();
 window.addEventListener('pagehide',stop);
 window.addEventListener('pageshow',start);
}
