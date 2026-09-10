(function(root){
  'use strict';
  function create(){
    let selected=new Set(),anchor=null;
    const reconcile=rows=>{const known=new Set(rows.map(s=>s.uid));selected=new Set([...selected].filter(uid=>known.has(uid)));if(!known.has(anchor))anchor=null;};
    return {
      reconcile,
      toggle(uid,rows,range=false){
        reconcile(rows);const ids=rows.map(s=>s.uid),end=ids.indexOf(uid),start=ids.indexOf(anchor);
        if(end<0)return;
        if(range&&start>=0)for(const id of ids.slice(Math.min(start,end),Math.max(start,end)+1))selected.add(id);
        else {if(selected.has(uid))selected.delete(uid);else selected.add(uid);anchor=uid;}
      },
      page(ids,rows){reconcile(rows);const known=new Set(rows.map(s=>s.uid));for(const uid of ids)if(known.has(uid))selected.add(uid);},
      clear(){selected.clear();anchor=null;},
      rows(rows){reconcile(rows);return rows.filter(s=>selected.has(s.uid));},
      has:uid=>selected.has(uid)
    };
  }
  function comparison(rows,current){
    if(rows.length!==2||!rows[0].sourcePatientKey||rows[0].sourcePatientKey!==rows[1].sourcePatientKey)return null;
    return rows[1].uid===current?[rows[1].uid,rows[0].uid]:rows.map(s=>s.uid);
  }
  function mount(options){
    const model=create(),host=options.host,tbody=options.tbody,initial=options.owner();
    let ended=false,dialog=null,dialogSignature=null;
    const live=()=>!ended&&initial&&options.owner()===initial;
    const element=(tag,text,parent)=>{const el=document.createElement(tag);el.textContent=text;if(tag==='button')el.className='chip';parent.append(el);return el;};
    const count=element('span','Selected: 0',host);count.id='multi-selection-count';count.setAttribute('role','status');
    const page=element('button','Select Page',host),inspect=element('button','Selection Details',host),clear=element('button','Clear Selection',host);
    page.type=inspect.type=clear.type='button';page.id='multi-selection-page';inspect.id='multi-selection-details';clear.id='multi-selection-clear';
    element('span','Ctrl/⌘ 클릭 · Shift 범위 · Space 선택. 작성 대상은 유지합니다.',host);
    function rows(){return live()?model.rows(options.rows()):[];}
    function renderDialog(){
      if(!dialog)return;
      const list=rows(),signature=JSON.stringify(list.map(s=>[s.uid,s.id,s.name,s.date,s.modality,s.desc,s.sourcePatientKey]));
      if(signature===dialogSignature)return;dialogSignature=signature;
      const body=dialog.querySelector('tbody');body.replaceChildren();
      dialog.querySelector('[data-summary]').textContent=`Selected: ${list.length}`;
      dialog.querySelector('[data-compare]').disabled=!comparison(list);
      for(const s of list){
        const tr=element('tr','',body);
        for(const value of [s.id,s.name,s.date,s.modality,s.desc])element('td',String(value??''),tr);
        const cell=element('td','',tr),open=element('button','Open Study',cell);open.type='button';open.dataset.uid=s.uid;
        open.onclick=()=>{if(!live()||!rows().some(x=>x.uid===s.uid))return;dialog.close();options.open(s.uid);};
      }
    }
    function sync(){
      if(!live()){end();return;}
      const selected=rows();count.textContent=`Selected: ${selected.length}`;
      clear.disabled=inspect.disabled=!selected.length;page.disabled=!tbody.querySelector('tr[data-uid]');
      for(const tr of tbody.querySelectorAll('tr[data-uid]')){
        const chosen=model.has(tr.dataset.uid);tr.classList.toggle('multi-selected',chosen);tr.setAttribute('aria-selected',String(chosen));
      }
      renderDialog();
    }
    function focus(uid){tbody.querySelector(`tr[data-uid="${CSS.escape(uid)}"]`)?.focus({preventScroll:true});}
    function click(e){
      if(!live()||e.target.closest('button,input,select,a'))return;
      const uid=e.target.closest('tr[data-uid]')?.dataset.uid;if(!uid)return;
      if(e.ctrlKey||e.metaKey||e.shiftKey){e.preventDefault();e.stopImmediatePropagation();model.toggle(uid,options.rows(),e.shiftKey);sync();focus(uid);}
    }
    function key(e){
      if(!live()||e.defaultPrevented||e.repeat||e.isComposing||e.altKey||e.ctrlKey||e.metaKey||e.code!=='Space'||e.target.closest('button,input,select,a'))return;
      const uid=e.target.closest('tr[data-uid]')?.dataset.uid;if(!uid)return;
      e.preventDefault();e.stopImmediatePropagation();model.toggle(uid,options.rows(),e.shiftKey);sync();focus(uid);
    }
    function double(e){if(e.ctrlKey||e.metaKey||e.shiftKey){e.preventDefault();e.stopImmediatePropagation();}}
    page.onclick=()=>{if(!live())return;model.page([...tbody.querySelectorAll('tr[data-uid]')].map(tr=>tr.dataset.uid),options.rows());sync();};
    clear.onclick=()=>{model.clear();sync();};
    inspect.onclick=()=>{
      if(!live()||!rows().length)return;
      if(!dialog){
        dialog=document.createElement('dialog');dialog.id='multi-selection-dialog';
        dialog.style.cssText='max-width:min(1000px,94vw);max-height:85vh;overflow:auto;color:inherit;background:#142237;border:1px solid #355272;padding:20px';
        dialog.innerHTML='<h2>Selection Details</h2><p data-summary></p><p>두 검사 비교는 원본 환자 키가 같은 검사만 가능합니다. 작성 검사가 선택돼 있으면 그 검사를, 아니면 목록의 첫 검사를 기준으로 엽니다. 현재 판독문은 기존 작성 대상을 유지합니다.</p><div style="overflow:auto"><table><thead><tr><th>Patient ID</th><th>Patient Name</th><th>Study Date</th><th>Modality</th><th>Description</th><th>Action</th></tr></thead><tbody></tbody></table></div><p><button class="chip" type="button" data-compare>Compare Two Studies</button> <button class="chip" type="button" data-close>Close</button></p>';
        dialog.querySelector('[data-close]').onclick=()=>dialog.close();
        dialog.querySelector('[data-compare]').onclick=()=>{const pair=comparison(rows(),options.current());if(!pair)return;dialog.close();options.compare(...pair);};
        dialog.addEventListener('close',()=>{if(live())inspect.focus();});document.body.append(dialog);
      }
      renderDialog();dialog.showModal();
    };
    tbody.addEventListener('click',click,true);tbody.addEventListener('keydown',key,true);tbody.addEventListener('dblclick',double,true);
    const storage=e=>{if(e.key==='kin-session-ended')end();};let channel=null;
    function end(){if(ended)return;ended=true;model.clear();dialog?.remove();dialog=null;host.hidden=true;for(const tr of tbody.querySelectorAll('.multi-selected')){tr.classList.remove('multi-selected');tr.removeAttribute('aria-selected');}tbody.removeEventListener('click',click,true);tbody.removeEventListener('keydown',key,true);tbody.removeEventListener('dblclick',double,true);root.removeEventListener('storage',storage);root.removeEventListener('pagehide',end);channel?.close();}
    root.addEventListener('storage',storage);root.addEventListener('pagehide',end);
    try{channel=new BroadcastChannel('kin-session');channel.onmessage=e=>{if(e.data?.type==='session-ended')end();};}catch(_){}
    sync();return {sync,end};
  }
  const api={create,comparison,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistSelection=api;
})(globalThis);
