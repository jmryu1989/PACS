(function(root){
  'use strict';
  function create(){
    // generation: the number of changes of the selected set. A selection-scoped action (W9 Open Selected Studies) binds the
    // generation it was offered at, so A -> B -> A between offer and click is a different selection.
    let selected=new Set(),anchor=null,generation=0;
    const changed=run=>{const before=[...selected].join('\n');run();if([...selected].join('\n')!==before)generation++;};
    const reconcile=rows=>changed(()=>{const known=new Set(rows.map(s=>s.uid));selected=new Set([...selected].filter(uid=>known.has(uid)));if(!known.has(anchor))anchor=null;});
    return {
      reconcile,
      toggle(uid,rows,range=false){
        reconcile(rows);const ids=rows.map(s=>s.uid),end=ids.indexOf(uid),start=ids.indexOf(anchor);
        if(end<0)return;
        changed(()=>{
          if(range&&start>=0)for(const id of ids.slice(Math.min(start,end),Math.max(start,end)+1))selected.add(id);
          else {if(selected.has(uid))selected.delete(uid);else selected.add(uid);anchor=uid;}
        });
      },
      page(ids,rows){reconcile(rows);const known=new Set(rows.map(s=>s.uid));changed(()=>{for(const uid of ids)if(known.has(uid))selected.add(uid);});},
      clear(){changed(()=>selected.clear());anchor=null;},
      rows(rows){reconcile(rows);return rows.filter(s=>selected.has(s.uid));},
      has:uid=>selected.has(uid),
      generation:()=>generation
    };
  }
  // The W9 viewing API's own wire bound (multi-study-view.service.ts VIEWING_SET_LIMITS.minMembers); the server has no upper
  // member count (removed by the caution census), so the page sets none either. Never truncated here.
  const SET_LIMITS=Object.freeze({min:2});
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
    // W9: the same Open Selected Studies here, in Selection Details and in the selected rows' menu (options.openSet).
    const openSet=options.openSet?element('button','Open Selected Studies',host):null;
    if(openSet){openSet.type='button';openSet.id='multi-selection-open-set';}
    // D1890 / Minhoon P0 item 1: Preload queues encrypted reading-PC copies (preload-queue.js).
    const preloadQueue=root.KinPreloadQueue?.available()?root.KinPreloadQueue:null;
    const preload=preloadQueue?element('button','Preload',host):null;
    if(preload){preload.type='button';preload.id='multi-selection-preload';preload.title='선택한 검사의 영상을 암호화해 72시간 보관합니다. 열 때 서버의 권한 확인과 열람 기록을 거칩니다.';
      preload.onclick=()=>{const list=rows();if(!live()||!list.length)return;preloadQueue.add(list.map(s=>({uid:s.uid,label:[s.id,s.name,s.date,s.modality].filter(Boolean).join(' · ')})),root.KinWorkContext?.session?.());};}
    // FC-028 Batch Reading (options.batchRead): one of my Reading Templates saved to the selected studies. Shown only where the
    // page offers it (Radiology, a radiologist, the server); it moves no Reading Target either.
    const batchRead=options.batchRead?element('button','Batch Reading',host):null;
    if(batchRead){batchRead.type='button';batchRead.id='multi-selection-batch-read';batchRead.setAttribute('aria-haspopup','dialog');
      batchRead.onclick=()=>{const s=snapshot();if(!s||!s.studyUids.length)return;dialog?.open&&dialog.close();options.batchRead.open(s);};}
    // FC-029 Batch Approve (options.batchApprove): the selected saved reports approved as shown, after Batch Reading.
    const batchApprove=options.batchApprove?element('button','Batch Approve',host):null;
    if(batchApprove){batchApprove.type='button';batchApprove.id='multi-selection-batch-approve';batchApprove.setAttribute('aria-haspopup','dialog');
      batchApprove.onclick=()=>{const s=snapshot();if(!s||!s.studyUids.length)return;dialog?.open&&dialog.close();options.batchApprove.open(s);};}
    // The hint shares the last button line and gives way (ellipsis, full text in its title): it never adds a line of its own,
    // so the bar does not take the work rows' floor in a narrow window once more buttons stand before it. Where no room is
    // left for it, Selection Details carries the same sentence.
    const HINT='Ctrl/⌘ 클릭 · Shift 범위 · Space 선택. 작성 대상은 유지합니다.';
    const hint=element('span',HINT,host);
    hint.title=hint.textContent;hint.style.cssText='flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    // FC-073: the bar also stays shown while the Preload panel has rows (Auto Preload queues with nothing selected).
    let queueShown=false,selectedCount=0;
    const preloadPanel=preloadQueue?preloadQueue.mount(host,{shown:visible=>{queueShown=visible;if(!ended)host.hidden=!selectedCount&&!queueShown;}}):null;
    function rows(){return live()?model.rows(options.rows()):[];}
    /** The selected UIDs in the order the reader sees them, bound to this owner and selection generation. */
    function snapshot(){const list=rows();return live()?{owner:initial,generation:model.generation(),studyUids:list.map(s=>s.uid)}:null;}
    // A count outside the API's bound disables the action with the reason; the server still decides everything else.
    function setBlock(count){
      if(count<SET_LIMITS.min)return '여러 검사 열기는 2개 이상 선택해야 합니다.';
      return options.openBlocked?.()||null;
    }
    function runOpenSet(){const s=snapshot();if(!s||setBlock(s.studyUids.length))return;dialog?.open&&dialog.close();options.openSet(s);}
    if(openSet)openSet.onclick=runOpenSet;
    let lastGeneration=model.generation();
    function renderDialog(){
      if(!dialog)return;
      const list=rows(),signature=JSON.stringify(list.map(s=>[s.uid,s.id,s.name,s.date,s.modality,s.desc,s.sourcePatientKey]));
      if(signature===dialogSignature)return;dialogSignature=signature;
      const body=dialog.querySelector('tbody');body.replaceChildren();
      dialog.querySelector('[data-summary]').textContent=`Selected: ${list.length}`;
      dialog.querySelector('[data-compare]').disabled=!comparison(list);
      const set=dialog.querySelector('[data-open-set]');
      if(set){const why=setBlock(list.length);set.disabled=!!why;set.title=why||'';}
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
      selectedCount=selected.length;host.hidden=!selected.length&&!queueShown;
      clear.disabled=inspect.disabled=!selected.length;if(preload)preload.disabled=!selected.length;page.disabled=!tbody.querySelector('tr[data-uid]');
      if(openSet){const why=setBlock(selected.length);openSet.disabled=!!why;openSet.title=why||'';}
      if(batchRead){const offered=!!options.batchRead.shown?.(),why=offered&&selected.length?options.batchRead.blocked?.()||null:null;
        batchRead.hidden=!offered;batchRead.disabled=!offered||!selected.length||!!why;batchRead.title=why||'';}
      if(batchApprove){const offered=!!options.batchApprove.shown?.(),why=offered&&selected.length?options.batchApprove.blocked?.()||null:null;
        batchApprove.hidden=!offered;batchApprove.disabled=!offered||!selected.length||!!why;batchApprove.title=why||'';}
      if(model.generation()!==lastGeneration){lastGeneration=model.generation();options.changed?.(lastGeneration);}
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
        dialog.innerHTML='<h2>Selection Details</h2><p data-summary></p><p data-hint></p><p>두 검사 비교는 원본 환자 키가 같은 검사만 가능합니다. 작성 검사가 선택돼 있으면 그 검사를, 아니면 목록의 첫 검사를 기준으로 엽니다. 현재 판독문은 기존 작성 대상을 유지합니다.</p><div style="overflow:auto"><table><thead><tr><th>Patient ID</th><th>Patient Name</th><th>Study Date</th><th>Modality</th><th>Description</th><th>Action</th></tr></thead><tbody></tbody></table></div><p><button class="chip" type="button" data-compare>Compare Two Studies</button> <button class="chip" type="button" data-close>Close</button></p>';
        if(openSet){
          const set=element('button','Open Selected Studies',document.createDocumentFragment());set.type='button';set.dataset.openSet='';
          dialog.querySelector('[data-compare]').after(' ',set);set.onclick=runOpenSet;
        }
        dialog.querySelector('[data-hint]').textContent=HINT;
        dialog.querySelector('[data-close]').onclick=()=>dialog.close();
        dialog.querySelector('[data-compare]').onclick=()=>{const pair=comparison(rows(),options.current());if(!pair)return;dialog.close();options.compare(...pair);};
        dialog.addEventListener('close',()=>{if(live())inspect.focus();});document.body.append(dialog);
      }
      renderDialog();dialog.showModal();
    };
    tbody.addEventListener('click',click,true);tbody.addEventListener('keydown',key,true);tbody.addEventListener('dblclick',double,true);

    const work = root.KinWorkContext;
    work.onInvalidate(event => {
      if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) end();
    });
    function end(){if(ended)return;ended=true;model.clear();preloadPanel?.end();dialog?.remove();dialog=null;host.hidden=true;for(const tr of tbody.querySelectorAll('.multi-selected')){tr.classList.remove('multi-selected');tr.removeAttribute('aria-selected');}tbody.removeEventListener('click',click,true);tbody.removeEventListener('keydown',key,true);tbody.removeEventListener('dblclick',double,true);root.removeEventListener('pagehide',end);}
    root.addEventListener('pagehide',end);

    sync();return {sync,end,snapshot,has:uid=>live()&&model.has(uid)&&rows().some(s=>s.uid===uid)};
  }
  const api={create,comparison,mount,SET_LIMITS};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistSelection=api;
})(globalThis);
