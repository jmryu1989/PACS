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
  function span(selected){
    if(!Array.isArray(selected)||selected.length!==2||selected.some(s=>!s||
      ![s.left,s.top,s.width,s.height].every(Number.isFinite)||s.width<=0||s.height<=0)||identity(selected[0])===identity(selected[1]))return null;
    const left=Math.min(...selected.map(s=>s.left)),top=Math.min(...selected.map(s=>s.top));
    // OS available coordinates already include scale and taskbars. The bounding
    // rectangle includes any gap; there is no per-monitor pixel correction.
    return {left,top,width:Math.max(...selected.map(s=>s.left+s.width))-left,height:Math.max(...selected.map(s=>s.top+s.height))-top};
  }
  function fit(rect,screen){
    if(!rect||!screen||![rect.width,rect.height,screen.left,screen.top,screen.width,screen.height].every(Number.isFinite)||
      rect.width<320||rect.height<240||screen.width<320||screen.height<240)return null;
    const width=Math.floor(Math.min(rect.width,screen.width)),height=Math.floor(Math.min(rect.height,screen.height));
    return {left:Math.round(screen.left+(screen.width-width)/2),top:Math.round(screen.top+(screen.height-height)/2),width,height};
  }
  // Display edges inside one window's client area, in that window's CSS px.
  // Screen rectangles and screenX/outerWidth are DIPs; zoom is CSS px -> DIPs
  // (the browser zoom alone, never the OS scale again). Without a known zoom
  // only a plain window frame (Windows Chrome: 8px a side) is accepted as 1.
  function seams(list,win,zoom){
    const n=Number.isFinite;
    if(!win||![win.screenX,win.screenY,win.outerWidth,win.outerHeight,win.innerWidth,win.innerHeight].every(n)||win.innerWidth<=0||win.innerHeight<=0)return [];
    let z=zoom;
    if(!(n(z)&&z>0)){const plain=win.outerWidth-win.innerWidth;if(plain<0||plain>40)return [];z=1;}
    const frame=win.outerWidth-win.innerWidth*z;
    if(frame<-1||frame>80)return [];
    const side=Math.max(0,frame)/2,left=win.screenX+side,top=win.screenY+(win.outerHeight-win.innerHeight*z)-side,bottom=top+win.innerHeight*z;
    const found=new Set();
    for(const s of Array.from(list||[])){
      if(!s||![s.left,s.top,s.width,s.height].every(n)||s.width<=0||s.height<=0||s.top>=bottom||s.top+s.height<=top)continue;
      for(const x of [s.left,s.left+s.width]){const c=Math.round((x-left)/z*100)/100;if(c>=1&&c<=win.innerWidth-1)found.add(c);}
    }
    return [...found].sort((a,b)=>a-b);
  }
  // The middle column edge of the grid on the display edge nearest the
  // middle. Columns stay equal (current and prior at one size): the side that
  // is longer loses the difference as a margin. An edge in the outer quarters
  // (a window barely over the edge) is left alone.
  function split(base,list){
    if(!base||![base.left,base.right].every(Number.isFinite)||base.right<=base.left)return null;
    const width=base.right-base.left,middle=(base.left+base.right)/2;
    const seam=Array.from(list||[]).filter(x=>Number.isFinite(x)&&x>=base.left+width/4&&x<=base.right-width/4)
      .sort((a,b)=>Math.abs(a-middle)-Math.abs(b-middle))[0];
    if(seam===undefined)return null;
    const r=v=>Math.round(v*100)/100;
    return seam<=middle?{seam,left:0,right:r(base.left+base.right-2*seam)}:{seam,left:r(2*seam-base.left-base.right),right:0};
  }
  const api={screens,identity,fit,span,seams,split};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinViewerDisplayLayout=api;
})(globalThis);
