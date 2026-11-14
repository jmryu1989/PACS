(function(root){
  'use strict';
  /*
   * FC-028 Batch Reading: one of my Reading Templates saved as the report of several selected studies, one study at a time.
   * FC-029 Batch Approve: the saved reports of several selected studies approved, one study at a time, each exactly as shown.
   *
   * Nothing new on the server: each study is the existing single-study commit (action save, or approve) with its own
   * version, audit line, access record and, for approve, its own signature. The page passes everything that reads or
   * writes its state (facts, send, verify, the commit lock); this file holds the pure classifiers, the sequential runner
   * and the two dialogs (main.html #batch-report-dialog, #batch-approve-dialog; mount once per mode).
   *
   * - Rows are captured when the dialog opens (uid, version, draft revision and epoch, the saved text) and sent with exactly
   *   those values. A row whose draft revision or epoch moved since is skipped, never re-based and re-sent.
   * - Batch Reading sends only an Unread study with no saved text, no draft of mine and nothing unconfirmed (classify).
   *   Batch Approve sends only a saved report (In Progress, or a Preliminary I am the designated reviewer of) with text, no
   *   draft of mine and nothing unconfirmed (classifyApprove); the text signed is the text the dialog shows, and a version
   *   that moved since is refused by the server (baseVersion) and shown again before it can be approved. The server
   *   decides again for each request.
   * - One failure never stops the next row. A row whose answer was lost is checked against the study's version list; if
   *   that cannot tell, it stays Unconfirmed and Retry Failed never sends it again.
   */
  const FIELDS=['findings','conclusion','recommendation'];
  const LABELS={findings:'Findings',conclusion:'Conclusion',recommendation:'Recommendation'};
  const SKIP=Object.freeze({
    text:'이미 판독문이 있습니다',draft:'내 초안이 있습니다',unverified:'촬영 중(미확인) 검사입니다',
    prelim:'다른 판독의의 예비 판독입니다',identity:'환자 식별 불일치',approved:'승인된 검사입니다',hold:'보류 중입니다',
    destroyed:'파기된 검사입니다',unconfirmed:'저장을 확인하는 중인 글이 있습니다',priority:'응급 상태 저장을 확인하는 중입니다',
    base:'이 검사의 초안 기준을 알 수 없습니다',changed:'그 사이 초안이 바뀌었습니다',missing:'목록에서 찾을 수 없습니다',
    stopped:'작업이 끝나 보내지 않았습니다',
    // FC-029 Batch Approve
    noText:'판독문이 없습니다',alreadyApproved:'이미 승인된 검사입니다',draftOpen:'내 초안이 있습니다 — 열어서 확인하세요',
    notDesignated:'지정된 상급 판독의만 승인할 수 있습니다'
  });
  const APPROVE_REASON='Batch Approve';
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
  const hasText=f=>FIELDS.some(k=>String(f?.texts?.[k]??'').trim()!=='');
  /**
   * Will Batch Approve approve this study? A saved report (rs T), or a Preliminary (rs P) I am the designated reviewer of
   * (`f.designated`; the server decides again by its own designation), with text in at least one field. A Unread study, an
   * empty report, an approved one, a draft of mine (opened and checked one by one instead) and every exclusion Batch
   * Reading has are skipped. A study received for remote reading is not excluded by its kind.
   */
  function classifyApprove(f){
    const skip=reason=>({ok:false,reason});
    if(!f)return skip(SKIP.missing);
    if(f.identityUnresolved)return skip(SKIP.identity);
    if(f.prelimHidden)return skip(SKIP.prelim);
    if(f.rs==='A')return skip(SKIP.alreadyApproved);
    if(f.rs==='H')return skip(SKIP.hold);
    if(f.rs==='D')return skip(SKIP.destroyed);
    if(f.ss==='Unverified'&&f.em!=='E')return skip(SKIP.unverified);
    if(f.holder)return skip(heldText(f.holder));
    if(f.draft)return skip(SKIP.draftOpen);
    if(f.unconfirmed)return skip(SKIP.unconfirmed);
    if(f.priority)return skip(SKIP.priority);
    if(f.rs==='P'&&!f.designated)return skip(SKIP.notDesignated);
    if((f.rs!=='T'&&f.rs!=='P')||!hasText(f))return skip(SKIP.noText);
    if(typeof f.draftRevision!=='string'||!f.draftRevision)return skip(SKIP.base);
    return {ok:true};
  }
  /** The row as it is sent: captured when the dialog opened (or when Retry re-read it), with the saved text it shows. */
  const capture=(uid,f)=>({uid,examGeneration:f?.examGeneration??null,version:f?.version??0,draftRevision:f?.draftRevision??null,draftEpoch:f?.draftEpoch??null,
    texts:Object.fromEntries(FIELDS.map(k=>[k,String(f?.texts?.[k]??'')]))});
  /**
   * Batch Approve: is the captured row still approvable? The classifier again, then the captured draft revision/epoch. The
   * captured version is not compared here: it is sent as baseVersion, so a report saved since is refused by the server
   * (409) and that row is shown again with its new text before it can be approved.
   */
  function recheckApprove(item,f){
    const c=classifyApprove(f);
    if(!c.ok)return c;
    if((f.examGeneration??null)!==(item.examGeneration??null))return {ok:false,reason:SKIP.changed};
    if(f.draftRevision!==item.draftRevision||(f.draftEpoch??null)!==(item.draftEpoch??null))return {ok:false,reason:SKIP.changed};
    return {ok:true};
  }
  /**
   * Is the captured row still the study as it is now? The classifier again, then the captured version and draft
   * revision/epoch. A moved draft is skipped as changed, a moved version as text that now exists.
   */
  function recheck(item,f){
    const c=classify(f);
    if(!c.ok)return c;
    if((f.examGeneration??null)!==(item.examGeneration??null))return {ok:false,reason:SKIP.changed};
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
  function summary(results,done='Saved'){
    const n=s=>results.filter(x=>x.result.status===s).length;
    return `${done} ${n('saved')} · Skipped ${n('skipped')} · Failed ${n('failed')} · Unconfirmed ${n('unknown')}`;
  }
  /** The first non-blank line of one field (the Batch Approve table shows Findings and Conclusion this way). */
  const firstLine=text=>String(text??'').split(/\r?\n/).map(s=>s.trim()).find(Boolean)||'';

  function mount(options){
    const dialog=options.dialog;
    if(!dialog)return null;
    const approve=options.mode==='approve';
    // What differs between the two modes; everything else (capture, runner, lock, Retry, lost answers) is shared.
    const M=approve?{action:'approve',classify:classifyApprove,recheck:recheckApprove,done:'Approved',will:'Will Approve',
      button:n=>`Approve ${n} Studies`,running:'승인하는 중입니다 — 검사마다 차례로 보냅니다.',failed:'승인하지 못했습니다'}
      :{action:'save',classify,recheck,done:'Saved',will:'Will Save',button:n=>`Save to ${n} Studies`,
        running:'저장하는 중입니다 — 검사마다 차례로 보냅니다.',failed:'저장하지 못했습니다'};
    const q=sel=>dialog.querySelector(sel);
    const picker=q('[data-batch-template]'),body=q('[data-batch-rows]'),note=q('[data-batch-note]'),save=q('[data-batch-save]'),
      retry=q('[data-batch-retry]'),cancel=q('[data-batch-cancel]'),close=q('[data-batch-close]');
    const preview=Object.fromEntries(FIELDS.map(k=>[k,q(`[data-batch-field="${k}"]`)]));
    // the open dialog: {owner, generation, uids, rows: Map uid -> {item, verdict, result}, phase, texts, reason, settling, expanded}
    let state=null;
    let ended=false;
    const live=()=>!ended&&!!state&&options.owner()===state.owner;
    const shown=()=>!ended&&!!options.shown?.();
    const blocked=()=>options.blocked?.()||null;
    const chosen=()=>{if(!picker)return null;const list=state?.templates||[];const i=Number(picker.value);return picker.value!==''&&list[i]?list[i]:null;};
    const pending=()=>state.uids.filter(uid=>state.rows.get(uid).verdict.ok&&!state.rows.get(uid).result);
    function cell(tr,text){const td=document.createElement('td');td.textContent=text;tr.append(td);return td;}
    /**
     * Batch Approve's report cell: the first line of Findings and of Conclusion; opening the row shows the three fields in
     * full. It shows the captured text, which is the text sent and signed. Opening it is offered, never required.
     */
    function reportCell(tr,uid,texts){
      const td=document.createElement('td');td.dataset.batchReport='';
      const box=document.createElement('details'),head=document.createElement('summary');
      const lines=[['findings',firstLine(texts?.findings)],['conclusion',firstLine(texts?.conclusion)]].filter(([,v])=>v);
      head.textContent=lines.length?lines.map(([k,v])=>`${LABELS[k]}: ${v}`).join(' · '):'(판독문 없음)';
      box.append(head);
      for(const k of FIELDS){
        const v=String(texts?.[k]??'');if(!v)continue;
        const part=document.createElement('div');part.dataset.batchFull=k;
        const name=document.createElement('strong');name.textContent=LABELS[k];
        const text=document.createElement('pre');text.textContent=v;
        part.append(name,text);box.append(part);
      }
      box.open=state.expanded.has(uid);
      box.addEventListener('toggle',()=>{if(!state)return;if(box.open)state.expanded.add(uid);else state.expanded.delete(uid);});
      td.append(box);tr.append(td);
    }
    function resultText(row){
      const r=row.result;
      if(r){
        if(r.status==='saved')return M.done;
        if(r.status==='failed')return `Failed — ${r.reason||M.failed}`;
        if(r.status==='unknown')return 'Unconfirmed — 결과 미확인 (다시 보내지 않습니다)';
        return `Skipped — ${r.reason}`;
      }
      return row.verdict.ok?(state.phase==='running'?'Sending…':M.will):`Skipped — ${row.verdict.reason}`;
    }
    function render(){
      if(!state)return;
      body.replaceChildren();
      for(const uid of state.uids){
        const row=state.rows.get(uid),s=options.study(uid)||{};
        const tr=document.createElement('tr');tr.dataset.uid=uid;
        for(const v of [s.name,s.id,s.modality,s.date,options.status(uid)])cell(tr,String(v??''));
        if(approve)reportCell(tr,uid,row.item.texts);
        const res=cell(tr,resultText(row));res.dataset.batchResult=row.result?row.result.status:row.verdict.ok?'will':'skipped';
        body.append(tr);
      }
      const t=chosen(),n=pending().length;
      if(!approve)for(const k of FIELDS)preview[k].value=t?String(t[k]??''):'';
      save.textContent=M.button(n);
      const idle=state.phase==='ready';
      save.hidden=!idle;
      if(approve){save.disabled=!idle||!n;save.title=!n?'승인할 검사가 없습니다':'';}
      else{save.disabled=!idle||!n||!usableTemplate(t);
        save.title=!t?'상용구를 고르세요':!usableTemplate(t)?'빈 상용구는 넣지 않습니다':!n?'보낼 검사가 없습니다':'';}
      if(picker)picker.disabled=!idle;
      cancel.hidden=!idle;
      const done=state.phase==='done';
      close.hidden=!done;
      // Retry Failed waits for the list read after the run, so a failed row is re-read from the study as it is now.
      retry.hidden=!done||!!state.settling||!retryable(state.results).length;retry.disabled=retry.hidden;
      if(done)note.textContent=summary(state.uids.map(uid=>({result:state.rows.get(uid).result||{status:'skipped'}})),M.done);
      else if(state.phase==='running')note.textContent=M.running;
    }
    function fillTemplates(){
      if(!picker)return;
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
      for(const uid of set.studyUids){const f=options.facts(uid);rows.set(uid,{item:capture(uid,f),verdict:M.classify(f),result:null});}
      state={owner:options.owner(),generation:set.generation,uids:[...set.studyUids],rows,phase:'ready',results:[],texts:null,reason:null,
        templates:approve?[]:[...(options.templates()||[])],settling:false,expanded:new Set()};
      fillTemplates();note.textContent='';
      render();
      if(!dialog.open)dialog.showModal();
      picker?.focus();
    }
    async function go(uids){
      const at=options.context();
      if(!options.begin()){note.textContent='진행 중인 저장·확정이 끝난 뒤 다시 누르세요';return;}
      state.phase='running';render();
      const items=uids.map(uid=>state.rows.get(uid).item);
      // Batch Reading sends the chosen template; Batch Approve sends each row's own captured text, the text the dialog shows.
      const textsOf=item=>approve?item.texts:state.texts;
      let results;
      try{
        results=await run(items,{
          live:()=>live()&&options.admits(at)?null:SKIP.stopped,
          check:item=>M.recheck(item,options.facts(item.uid)),
          send:item=>options.save(item,textsOf(item),state.reason,at,M.action),
          verify:(item,sent)=>options.verify(item,textsOf(item),state.reason,at,sent,M.action),
          onRow:(item,r)=>{if(!state)return;state.rows.get(item.uid).result=r;render();}
        });
      }finally{options.end(at);}
      if(!state)return;
      // Results of this run replace the earlier result of the same rows (Retry), the rest stay as they were.
      const byUid=new Map(results.map(x=>[x.item.uid,x]));
      state.results=state.results.filter(x=>!byUid.has(x.item.uid)).concat(results);
      state.phase='done';state.settling=true;render();
      // The list is read again (the saved rows' status, a lost answer's study) once the lock is released.
      const mine=state;
      try{if(options.admits(at))await options.reload?.();}catch(_){}
      finally{mine.settling=false;}
      if(state&&live())render();
    }
    // The selection this dialog was opened for, unchanged (owner and generation): checked before Save and before Retry.
    const sameSelection=()=>{const now=options.selection?.();return !!now&&now.owner===state.owner&&now.generation===state.generation;};
    save.onclick=()=>{
      if(!live()||state.phase!=='ready')return;
      if(approve)state.reason=APPROVE_REASON;
      else{const t=chosen();if(!usableTemplate(t))return;state.texts=templateTexts(t);state.reason=batchReason(t);}
      if(!sameSelection()){note.textContent=SELECTION_CHANGED;return;}
      go(pending());
    };
    retry.onclick=()=>{
      if(!live()||state.phase!=='done'||state.settling)return;
      if(!sameSelection()){note.textContent=SELECTION_CHANGED;retry.hidden=retry.disabled=true;return;}
      const again=[];
      // A failed row is shown as the study is now and sent again only if it still qualifies (text written meanwhile: skipped).
      for(const uid of retryable(state.results)){
        const row=state.rows.get(uid),f=options.facts(uid);
        row.item=capture(uid,f);row.verdict=M.classify(f);
        if(row.verdict.ok){row.result=null;again.push(uid);}
        else{row.result={status:'skipped',reason:row.verdict.reason};
          state.results=state.results.filter(x=>x.item.uid!==uid).concat([{item:row.item,result:row.result}]);}
      }
      if(!again.length){render();return;}
      /**
       * Batch Approve signs only text that was shown: a failed row (its report may have been saved again meanwhile) is shown
       * again as it is now and the dialog is ready again; Approve N Studies then sends exactly that. Batch Reading sends its
       * template, which the row's new state cannot change, so it goes at once.
       */
      if(approve){
        state.phase='ready';
        note.textContent=`실패한 줄을 지금의 판독문으로 다시 보였습니다 — 확인한 뒤 ${M.button(again.length)}를 누르세요.`;
        render();return;
      }
      go(again);
    };
    if(picker)picker.onchange=()=>render();
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
  const api={classify,classifyApprove,recheck,recheckApprove,run,retryable,summary,usableTemplate,templateTexts,batchReason,capture,
    SKIP,SELECTION_CHANGED,APPROVE_REASON,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistBatchReport=api;
})(globalThis);
