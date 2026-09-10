(function(root){
  'use strict';
  function nextUid(rows,current,key){
    if(!rows.length)return null;const i=rows.findIndex(row=>row.uid===current);
    if(key==='Home')return rows[0].uid;if(key==='End')return rows[rows.length-1].uid;
    if(!['ArrowUp','ArrowDown'].includes(key))return null;
    if(i<0)return rows[0].uid;
    return rows[Math.max(0,Math.min(rows.length-1,i+(key==='ArrowDown'?1:-1)))].uid;
  }
  function mount({tbody,owner,rows,current,reveal,activate,fallback=()=>document.querySelector('#quick')}){
    const bound=owner();let ended=false,last=null,restore=null;
    const live=()=>!ended&&bound&&owner()===bound;
    const elements=()=>[...tbody.querySelectorAll('tr[data-uid]')];
    const find=uid=>elements().find(row=>row.dataset.uid===uid);
    function tabStops(target){
      for(const row of elements()){
        row.tabIndex=row===target?0:-1;
        // Reach row actions from the active row. Earlier rows' buttons must not
        // intercept Tab before the list's single entry row.
        for(const control of row.querySelectorAll('button,a[href],input,select,textarea'))control.tabIndex=row===target?0:-1;
      }
    }
    function sync(){
      if(!live()){end();return;}
      const candidates=elements(),target=find(last)||find(current())||candidates[0];
      tabStops(target);
      if(restore){const previous=restore;restore=null;const row=find(previous.uid)||target;
        if(row){const destination=previous.control?row.querySelector(previous.control)||row:row;destination.focus({preventScroll:true});}
        else if(tbody.contains(document.activeElement)||document.activeElement===document.body)fallback()?.focus({preventScroll:true});
      }
    }
    function beforeRender(){
      const active=document.activeElement,row=active?.closest('tr[data-uid]');
      const control=['[data-tech-note]','[data-reader-assignment]','[data-related-open]'].find(selector=>active?.closest(selector));
      restore=row&&tbody.contains(row)?{uid:row.dataset.uid,control}:null;
    }
    function focused(e){const row=e.target.closest('tr[data-uid]');if(live()&&row){last=row.dataset.uid;tabStops(row);}}
    function key(e){
      if(!live()||e.defaultPrevented||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||e.target.closest('button,input,select,textarea,a'))return;
      const row=e.target.closest('tr[data-uid]');if(!row)return;
      if(e.key==='Enter'){
        if(e.repeat)return;e.preventDefault();e.stopImmediatePropagation();
        if(rows().some(item=>item.uid===row.dataset.uid))activate(row.dataset.uid);return;
      }
      const uid=nextUid(rows(),row.dataset.uid,e.key);if(!uid)return;
      e.preventDefault();e.stopImmediatePropagation();last=uid;if(!find(uid))reveal(uid);const target=find(uid);
      if(target){
        target.focus({preventScroll:true});
        // A wide table row must not pan away from the patient ID columns.
        const grid=tbody.closest('.grid,.grid2');
        if(grid){const bounds=grid.getBoundingClientRect(),rect=target.getBoundingClientRect();
          const header=grid.querySelector('thead'),top=Math.max(bounds.top,header?.getBoundingClientRect().bottom||bounds.top);
          if(rect.top<top)grid.scrollTop+=rect.top-top;
          else if(rect.bottom>bounds.bottom)grid.scrollTop+=rect.bottom-bounds.bottom;
        }
      }
    }
    function end(){if(ended)return;ended=true;last=restore=null;tabStops(null);tbody.removeEventListener('keydown',key,true);tbody.removeEventListener('focusin',focused);channel?.close();root.removeEventListener('storage',storage);root.removeEventListener('pagehide',end);}
    const storage=e=>{if(e.key==='kin-session-ended')end();};let channel;
    tbody.addEventListener('keydown',key,true);tbody.addEventListener('focusin',focused);
    root.addEventListener('storage',storage);root.addEventListener('pagehide',end);
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    sync();return {beforeRender,sync,end};
  }
  const api={nextUid,mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistRowNavigation=api;
})(globalThis);
