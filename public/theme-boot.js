// Apply the saved appearance before rendering account and setup pages.
try{const t=localStorage.getItem('lm-app-theme');const v=['white','sage','sand','midnight'].includes(t)?t:'white';document.documentElement.dataset.appTheme=v;document.documentElement.dataset.theme=v==='midnight'?'dark':'light';}catch{}
