// Public entry keeps crawlable content and adds a guided path in the same page.
import {html,render} from '/vendor/lit-html-3.2.1/lit-html.js';
import './app/setup-guide.js';
import {readGuide,clientId,saveGuide} from './app/setup-model.js';
import {THEMES,readTheme,writeTheme} from './app/theme.js';
const main=document.querySelector('.agent-main');
const picker=document.createElement('div');picker.className='setup-theme-picker';picker.setAttribute('role','group');picker.setAttribute('aria-label','Theme');
function paintPicker(){render(html`${THEMES.map(t=>html`<button type="button" title=${t} aria-label=${t+' theme'} aria-pressed=${String(readTheme()===t)} data-swatch=${t} @click=${()=>{writeTheme(t);paintPicker();}}></button>`)}`,picker);}
document.querySelector('.agent-nav')?.append(picker);paintPicker();
if(main){
 const original=document.createElement('div');while(main.firstChild)original.append(main.firstChild);main.append(original);
 const host=document.createElement('section');host.setAttribute('aria-label','Guided setup');main.prepend(host);
 const selected=clientId(location.pathname.split('/')[2]);
 const saved=readGuide('public');
 function closed(){original.hidden=false;render(html`<div class="setup-resume"><p>Your setup choices are saved in this browser session.</p><button type="button" class="lm-btn lm-btn--primary" @click=${()=>open()}>Resume setup</button><a class="lm-btn lm-btn--secondary" href="/app#/home">Go to Today</a></div>`,host);}
 function open(client='',step){original.hidden=true;render(html`<lm-agent-guide .options=${{scope:'public',client,step,onSave:closed}}></lm-agent-guide>`,host);}
 original.addEventListener('click',e=>{const a=e.target.closest('a');if(!a||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;const url=new URL(a.href);if(url.origin!==location.origin)return;const id=clientId(url.pathname.split('/')[2]);if(url.pathname.startsWith('/agents/')&&id){e.preventDefault();open(id,1);}else if(/^\/skills\/[a-z-]+\/SKILL.md$/.test(url.pathname)){e.preventDefault();open(saved.client,1);host.querySelector('lm-agent-guide').readSkill(url.pathname.split('/')[2]);}});
 const start=document.createElement('button');start.className='lm-btn lm-btn--primary';start.textContent='Start guided setup';start.type='button';start.addEventListener('click',()=>open(selected,selected?1:undefined));original.querySelector('h1')?.after(start);
 if(selected&&!saved.closed)open(selected, saved.client===selected?saved.step:1);
 else if(saved.client)closed();
}
