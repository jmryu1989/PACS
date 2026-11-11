(function(root){
  'use strict';
  /*
   * FC-028 Batch Reading: one of my Reading Templates saved as the report of several selected studies, one study at a time.
   *
   * Nothing new on the server: each study is the existing single-study commit (action save) with its own version, audit
   * line and access record. The page passes everything that reads or writes its state (facts, save, verify, the commit
   * lock); this file holds the pure classifier, the sequential runner and the dialog (main.html #batch-report-dialog).
   *
   * - Rows are captured when the dialog opens (uid, version, draft revision and epoch) and sent with exactly those values.
   *   A row whose draft revision or epoch moved since is skipped, never re-based and re-sent.
   * - Only an Unread study with no saved text, no draft of mine and nothing unconfirmed is sent (classify). The server
   *   decides again for each request.
   * - One failure never stops the next row. A row whose answer was lost is checked against the study's version list; if
   *   that cannot tell, it stays Unconfirmed and Retry Failed never sends it again.
   */
  const FIELDS=['findings','conclusion','recommendation'];
  const SKIP=Object.freeze({
    text:'이미 판독문이 있습니다',draft:'내 초안이 있습니다',unverified:'촬영 중(미확인) 검사입니다',
    prelim:'다른 판독의의 예비 판독입니다',identity:'환자 식별 불일치',approved:'승인된 검사입니다',hold:'보류 중입니다',
    destroyed:'파기된 검사입니다',unconfirmed:'저장을 확인하는 중인 글이 있습니다',priority:'응급 상태 저장을 확인하는 중입니다',
    base:'이 검사의 초안 기준을 알 수 없습니다',changed:'그 사이 초안이 바뀌었습니다',missing:'목록에서 찾을 수 없습니다',
    stopped:'작업이 끝나 보내지 않았습니다'
  });
  const SELECTION_CHANGED='선택이 바뀌었습니다 — 다시 여세요';
  const usableTemplate=t=>!!t&&FIELDS.some(k=>typeof t[k]==='string'&&t[k].trim()!=='');
  const templateTexts=t=>Object.fromEntries(FIELDS.map(k=>[k,typeof t?.[k]==='string'?t[k]:'']));
  const batchReason=t=>`Batch Reading — ${String(t?.title??'').trim()}`;
  function heldText(holder){
    if(holder==='다른 기관')return '다른 기관 판독의가 판독 중입니다';
    if(holder==='작성자 비공개')return '비공개 작성자가 판독 중입니다';
    return `${holder} 님이 판독 중입니다`;
  }
  /**
   * Will this study take the batch text? `f` is the page's facts for one study (batchReportFacts), null when the list no
   * longer has it. The first reason that applies is the one shown.
   */
  function classify(f){
    const skip=reason=>({ok:false,reason});
    if(!f)return skip(SKIP.missing);
    if(f.identityUnresolved)return skip(SKIP.identity);
    if(f.prelimHidden)return skip(SKIP.prelim);
    if(f.rs==='A')return skip(SKIP.approved);
    if(f.rs==='H')return skip(SKIP.hold);
    if(f.rs==='D')return skip(SKIP.destroyed);
    if(f.ss==='Unverified'&&f.em!=='E')return skip(SKIP.unverified);
    if(f.holder)return skip(heldText(f.holder));
    if(f.draft)return skip(SKIP.draft);
    if(f.unconfirmed)return skip(SKIP.unconfirmed);
    if(f.priority)return skip(SKIP.priority);
    if(f.rs!=='W'||FIELDS.some(k=>String(f.texts?.[k]??'')!==''))return skip(SKIP.text);
    if(typeof f.draftRevision!=='string'||!f.draftRevision)return skip(SKIP.base);
    return {ok:true};
  }
  /** The row as it is sent: captured when the dialog opened (or when Retry re-read it). */
  const capture=(uid,f)=>({uid,version:f?.version??0,draftRevision:f?.draftRevision??null,draftEpoch:f?.draftEpoch??null});
  /**
   * Is the captured row still the study as it is now? The classifier again, then the captured version and draft
   * revision/epoch. A moved draft is skipped as changed, a moved version as text that now exists.
   */
  function recheck(item,f){
    const c=classify(f);
    if(!c.ok)return c;
    if(f.version!==item.version)return {ok:false,reason:SKIP.text};
    if(f.draftRevision!==item.draftRevision||(f.draftEpoch??null)!==(item.draftEpoch??null))return {ok:false,reason:SKIP.changed};
    return {ok:true};
  }
  /**
   * Send the rows one after another. deps: check(item) -> {ok, reason}; send(item) -> {status}; verify(item, sent) ->
   * {status} for a lost answer; live() -> null or the reason nothing more is sent; onRow(item, result).
   * status: saved | skipped | failed | unknown. A thrown send is that row's failure, not the batch's.
   */
  async function run(items,deps){
    const results=[];
    let stopped=null;
    for(const item of items){
      let r;
      if(!stopped)stopped=deps.live?.()||null;
      if(stopped)r={status:'skipped',reason:stopped};
      else{
        const c=deps.check?deps.check(item):{ok:true};
        if(!c.ok)r={status:'skipped',reason:c.reason};
        else{
          try{r=await deps.send(item);}catch(e){r={status:'failed',reason:String(e?.message||e||'요청을 보내지 못했습니다')};}
          if(r?.status==='unknown'&&deps.verify){
            try{r=await deps.verify(item,r);}catch(_){r={status:'unknown'};}
          }
          if(!r||r.status==='stopped'){stopped=SKIP.stopped;r={status:'skipped',reason:SKIP.stopped};}
        }
      }
      results.push({item,result:r});
      deps.onRow?.(item,r);
    }
    return results;
  }
  /** Retry Failed takes failed rows only: an Unconfirmed row may already be saved and is never sent twice. */
  const retryable=results=>results.filter(x=>x.result.status==='failed').map(x=>x.item.uid);
  function summary(results){
    const n=s=>results.filter(x=>x.result.status===s).length;
    return `Saved ${n('saved')} · Skipped ${n('skipped')} · Failed ${n('failed')} · Unconfirmed ${n('unknown')}`;
  }

  function mount(options){
    const dialog=options.dialog;
    if(!dialog)return null;
    const q=sel=>dialog.querySelector(sel);
    const picker=q('[data-batch-template]'),body=q('[data-batch-rows]'),note=q('[data-batch-note]'),save=q('[data-batch-save]'),
      retry=q('[data-batch-retry]'),cancel=q('[data-batch-cancel]'),close=q('[data-batch-close]');
    const preview=Object.fromEntries(FIELDS.map(k=>[k,q(`[data-batch-field="${k}"]`)]));
    let state=null;   // the open dialog: {owner, generation, uids, rows: Map uid -> {item, verdict, result}, phase, texts, reason}
    let ended=false;
    const live=()=>!ended&&!!state&&options.owner()===state.owner;
    const shown=()=>!ended&&!!options.shown?.();
    const blocked=()=>options.blocked?.()||null;
    const chosen=()=>{const list=state?.templates||[];const i=Number(picker.value);return picker.value!==''&&list[i]?list[i]:null;};
    function cell(tr,text){const td=document.createElement('td');td.textContent=text;tr.append(td);return td;}
    function resultText(row){
      const r=row.result;
      if(r){
        if(r.status==='saved')return 'Saved';
        if(r.status==='failed')return `Failed — ${r.reason||'저장하지 못했습니다'}`;
        if(r.status==='unknown')return 'Unconfirmed — 결과 미확인 (다시 보내지 않습니다)';
        return `Skipped — ${r.reason}`;
      }
      return row.verdict.ok?(state.phase==='running'?'Sending…':'Will Save'):`Skipped — ${row.verdict.reason}`;
    }
    function render(){
      if(!state)return;
      body.replaceChildren();
      for(const uid of state.uids){
        const row=state.rows.get(uid),s=options.study(uid)||{};
        const tr=document.createElement('tr');tr.dataset.uid=uid;
        for(const v of [s.name,s.id,s.modality,s.date,options.status(uid)])cell(tr,String(v??''));
        const res=cell(tr,resultText(row));res.dataset.batchResult=row.result?row.result.status:row.verdict.ok?'will':'skipped';
        body.append(tr);
      }
      const t=chosen(),n=state.uids.filter(uid=>state.rows.get(uid).verdict.ok&&!state.rows.get(uid).result).length;
      for(const k of FIELDS)preview[k].value=t?String(t[k]??''):'';
      save.textContent=`Save to ${n} Studies`;
      const idle=state.phase==='ready';
      save.hidden=!idle;save.disabled=!idle||!n||!usableTemplate(t);
      save.title=!t?'상용구를 고르세요':!usableTemplate(t)?'빈 상용구는 넣지 않습니다':!n?'보낼 검사가 없습니다':'';
      picker.disabled=!idle;
      cancel.hidden=!idle;
      const done=state.phase==='done';
      close.hidden=!done;
      retry.hidden=!done||!retryable(state.results).length;retry.disabled=retry.hidden;
      if(done)note.textContent=summary(state.uids.map(uid=>({result:state.rows.get(uid).result||{status:'skipped'}})));
      else if(state.phase==='running')note.textContent='저장하는 중입니다 — 검사마다 차례로 보냅니다.';
    }
    function fillTemplates(){
      const list=state.templates;
      picker.replaceChildren();
      const none=document.createElement('option');none.value='';none.textContent=list.length?'— Reading Template —':'상용구 없음';picker.append(none);
      list.forEach((t,i)=>{
        const o=document.createElement('option');o.value=String(i);
        o.textContent=[t.title,t.shortcut,t.modality].map(v=>String(v??'').trim()).filter(Boolean).join(' · ')||'(제목 없음)';
        picker.append(o);
      });
    }
    function open(set){
      if(ended||!set||!Array.isArray(set.studyUids)||!set.studyUids.length)return;
      const why=blocked();
      if(why){options.notify?.(why);return;}
      if(state?.phase==='running')return;
      const rows=new Map();
      for(const uid of set.studyUids){const f=options.facts(uid);rows.set(uid,{item:capture(uid,f),verdict:classify(f),result:null});}
      state={owner:options.owner(),generation:set.generation,uids:[...set.studyUids],rows,phase:'ready',results:[],texts:null,reason:null,
        templates:[...(options.templates()||[])]};
      fillTemplates();note.textContent='';
      render();
      if(!dialog.open)dialog.showModal();
      picker.focus();
    }
    async function go(uids){
      const at=options.context();
      if(!options.begin()){note.textContent='진행 중인 저장·확정이 끝난 뒤 다시 누르세요';return;}
      state.phase='running';render();
      const items=uids.map(uid=>state.rows.get(uid).item);
      let results;
      try{
        results=await run(items,{
          live:()=>live()&&options.admits(at)?null:SKIP.stopped,
          check:item=>recheck(item,options.facts(item.uid)),
          send:item=>options.save(item,state.texts,state.reason,at),
          verify:(item,sent)=>options.verify(item,state.texts,state.reason,at,sent),
          onRow:(item,r)=>{if(!state)return;state.rows.get(item.uid).result=r;render();}
        });
      }finally{options.end(at);}
      if(!state)return;
      // Results of this run replace the earlier result of the same rows (Retry), the rest stay as they were.
      const byUid=new Map(results.map(x=>[x.item.uid,x]));
      state.results=state.results.filter(x=>!byUid.has(x.item.uid)).concat(results);
      state.phase='done';render();
      // The list is read again (the saved rows' status, a lost answer's study) once the lock is released.
      if(options.admits(at))await options.reload?.();
      if(state&&live())render();
    }
    // The selection this dialog was opened for, unchanged (owner and generation): checked before Save and before Retry.
    const sameSelection=()=>{const now=options.selection?.();return !!now&&now.owner===state.owner&&now.generation===state.generation;};
    save.onclick=()=>{
      if(!live()||state.phase!=='ready')return;
      const t=chosen();if(!usableTemplate(t))return;
      if(!sameSelection()){note.textContent=SELECTION_CHANGED;return;}
      state.texts=templateTexts(t);state.reason=batchReason(t);
      go(state.uids.filter(uid=>state.rows.get(uid).verdict.ok));
    };
    retry.onclick=()=>{
      if(!live()||state.phase!=='done')return;
      if(!sameSelection()){note.textContent=SELECTION_CHANGED;retry.hidden=retry.disabled=true;return;}
      const again=[];
      // A failed row is shown as the study is now and sent again only if it still qualifies (text written meanwhile: skipped).
      for(const uid of retryable(state.results)){
        const row=state.rows.get(uid),f=options.facts(uid);
        row.item=capture(uid,f);row.verdict=classify(f);
        if(row.verdict.ok){row.result=null;again.push(uid);}
        else{row.result={status:'skipped',reason:row.verdict.reason};
          state.results=state.results.filter(x=>x.item.uid!==uid).concat([{item:row.item,result:row.result}]);}
      }
      if(!again.length){render();return;}
      go(again);
    };
    picker.onchange=()=>render();
    cancel.onclick=()=>{if(state?.phase==='ready')dialog.close();};
    close.onclick=()=>{if(state?.phase==='done')dialog.close();};
    // The run is not left half-seen: Escape does not close the dialog while rows are being sent.
    dialog.addEventListener('cancel',e=>{if(state?.phase==='running')e.preventDefault();});
    dialog.addEventListener('close',()=>{if(state?.phase!=='running')state=null;});
    function end(){if(ended)return;ended=true;if(dialog.open)dialog.close();state=null;}
    root.KinWorkContext?.onInvalidate?.(event=>{if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();});
    root.addEventListener('pagehide',end);
    return {open,end,shown,blocked};
  }
  const api={classify,recheck,run,retryable,summary,usableTemplate,templateTexts,batchReason,capture,SKIP,SELECTION_CHANGED,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistBatchReport=api;
})(globalThis);
