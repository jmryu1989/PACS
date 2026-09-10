(function(root){
  'use strict';
  function screens(details){
    const seen=new Set();
    return Array.from(details?.screens||[]).map(s=>({left:s.availLeft,top:s.availTop,width:s.availWidth,height:s.availHeight,primary:!!s.isPrimary}))
      .filter(s=>[s.left,s.top,s.width,s.height].every(Number.isFinite)&&s.width>=320&&s.height>=240)
      .sort((a,b)=>a.left-b.left||a.top-b.top)
      .filter(s=>{const key=identity(s);if(seen.has(key))return false;seen.add(key);return true;});
  }
  function identity(s){return JSON.stringify([s.left,s.top,s.width,s.height]);}
  function fit(rect,screen){
    if(!rect||!screen||![rect.width,rect.height,screen.left,screen.top,screen.width,screen.height].every(Number.isFinite)||
      rect.width<320||rect.height<240||screen.width<320||screen.height<240)return null;
    const width=Math.floor(Math.min(rect.width,screen.width)),height=Math.floor(Math.min(rect.height,screen.height));
    return {left:Math.round(screen.left+(screen.width-width)/2),top:Math.round(screen.top+(screen.height-height)/2),width,height};
  }
  const api={screens,identity,fit};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinViewerDisplayLayout=api;
})(globalThis);
