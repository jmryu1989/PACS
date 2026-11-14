(function () {
  'use strict';
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  };
  const text = value => value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);
  const button = (label, onClick, title) => {
    const b = el('button', { type: 'button', title });
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const note = (message, kind = '') => el('p', { className: 'order-note ' + kind, text: message });
  const RS_WORD = { W: 'Unread', T: 'In Progress', P: 'Preliminary', H: 'On Hold', A: 'Approved', D: 'Destroyed' };
  const count = value => Number.isInteger(value) ? String(value) : '?';
  const seriesImages = (series, images) => count(series) + ' / ' + count(images);
  const sum = (rows, key) => rows.some(r => !Number.isInteger(r[key])) ? null : rows.reduce((a, r) => a + r[key], 0);

  /** A modal window (Esc and Close close it; removed when closed). Same look as the Technician Order List windows. */
  function openWindow(title, name) {
    const body = el('div', { className: 'order-dialog-body' }), foot = el('div', { className: 'order-dialog-foot' });
    const dialog = el('dialog', { className: 'order-dialog exam-merge-dialog', 'aria-label': title, 'data-exam-window': name },
      el('h3', { text: title }), body, foot);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    const close = () => { if (dialog.open) dialog.close(); };
    const buttons = (...list) => { foot.replaceChildren(...list); list.find(b => !b.disabled)?.focus(); };
    return { dialog, body, foot, close, buttons, closeButton: (label = 'Close') => button(label, close) };
  }
  const table = (heads, rows) => el('table', { className: 'order-table' },
    el('thead', {}, el('tr', {}, heads.map(h => el('th', { text: h })))),
    el('tbody', {}, rows.map(r => r instanceof HTMLElement ? r : el('tr', {}, r.map(v => v instanceof Node ? el('td', {}, v) : el('td', { text: text(v) }))))));
  // The server's refusals, each with the Accession No of the study it is about (when the page knows it).
  const reason = (error, accOf = uid => uid) => {
    const refusals = Array.isArray(error?.body?.refusals) ? error.body.refusals : [];
    return refusals.length ? [...new Set(refusals.map(r => (r.uid ? accOf(r.uid) + ': ' : '') + r.message))]
      : [error?.message || '서버가 변경을 받지 않았습니다.'];
  };


  (window.KinWorklistAddOns ||= []).push(function examMerge(ctx) {
    const scopes = window.KinExamScope;
    const mergeButton = document.getElementById('t-merge-exam'), unmergeButton = document.getElementById('t-split-unmerge');
    const allowed = () => ctx.has('technician') || ctx.has('admin');
    const selected = () => ctx.study(ctx.selectedUid());
    const accOf = uid => text(scopes.originals(ctx.studies()).find(s => s.uid === uid)?.acc ?? uid);
    let active = null, sequence = 0;
    function roles() { for (const b of [mergeButton, unmergeButton]) b.disabled = !allowed(); }
    function begin(name, title) {
      if (!allowed() || !ctx.allowed()) return null;
      const row = selected();
      if (!row) { ctx.toast('검사를 먼저 고르세요.', 'info'); return null; }
      active?.close();
      const win = openWindow(title, name), seq = ++sequence, at = ctx.work('study'), stamp = scopes.stamp(row);
      active = win;
      win.live = () => win.dialog.open && seq === sequence && ctx.admits(at) &&
        ctx.selectedUid() === row.uid && scopes.stamp(ctx.study(row.uid)) === stamp;
      win.row = row;
      win.at = at;
      win.dialog.addEventListener('close', () => { if (active === win) active = null; });
      return win;
    }
    const failure = (win, error) => {
      if (!win.live()) return;
      win.body.querySelector('.exam-merge-refused')?.remove();
      win.body.append(el('div', {className:'exam-merge-refused'}, reason(error, accOf).map(m=>note(m,'err'))));
    };
    async function changed(win, message, uid) {
      if (!win.live()) return;
      win.completed=true;win.body.replaceChildren(note(message, 'ok'));win.buttons(win.closeButton());
      // The successful mutation may itself change the list scope. Selection is never restored after a later user move.
      const at=ctx.work('study');
      await ctx.reload();
      if(ctx.admits(at) && win.dialog.open && uid)ctx.select(uid);
    }
    async function openMerge() {
      const win=begin('merge','Merge Exam');if(!win)return;
      const sel=win.row;
      if(scopes.read(sel)?.groupId) { win.body.append(note('이미 묶인 검사입니다. Split / Unmerge로 먼저 되돌리세요.'));win.buttons(win.closeButton());return; }
      const list=ctx.studies().filter(s=>!scopes.read(s)?.groupId).sort((a,b)=>(b.id===sel.id)-(a.id===sel.id));
      const checks=new Map(),bases=new Map(),captured=new Map(list.map(s=>[s.uid,scopes.stamp(s)]));
      const summary=el('div',{className:'order-status exam-merge-result',role:'status','aria-live':'polite'});
      let busy=false;
      const go=button('Merge',submit,'체크한 검사를 기준 검사 하나로 합칩니다.');
      const picked=()=>list.filter(s=>checks.get(s.uid).checked);
      function recompute() {
        const rows=picked(),base=rows.find(s=>bases.get(s.uid).checked),ids=[...new Set(rows.map(s=>s.id))];
        go.disabled=true;
        if(rows.length<2)summary.textContent='합칠 검사를 2건 이상 체크하세요.';
        else if(ids.length>1)summary.replaceChildren(note(`다른 환자의 검사는 합칠 수 없습니다 (${ids.join(', ')}).`,'warn'));
        else if(!base)summary.textContent='기준 검사(Base)를 고르세요.';
        else {
          go.disabled=busy;
          summary.replaceChildren(note(`결과: 검사 1건 (기준 ${text(base.acc)}, ${text(base.date)}) · 시리즈 ${count(sum(rows,'series'))} · 영상 ${count(sum(rows,'count'))}. 원래 검사 ${rows.length}건의 연결은 보존합니다.`),
            note('판독문은 합치지 않습니다. 기준 검사에서 판독하며 판독문에 영상 범위를 남깁니다. 원본 영상·UID는 바뀌지 않습니다. Query/Retrieve와 원본 내보내기는 원래 검사 단위입니다.','muted'));
        }
      }
      const rows=list.map(s=>{
        const c=el('input',{type:'checkbox',checked:s.uid===sel.uid || s.id===sel.id&&s.date===sel.date,'aria-label':'Merge '+text(s.acc)});
        const b=el('input',{type:'radio',name:'exam-merge-base',checked:s.uid===sel.uid,'aria-label':'Base '+text(s.acc)});
        checks.set(s.uid,c);bases.set(s.uid,b);c.onchange=recompute;b.onchange=()=>{c.checked=true;recompute();};
        return el('tr',{'data-uid':s.uid},...[c,b,s.id,s.name,s.date,s.desc,s.acc,seriesImages(s.series,s.count),RS_WORD[s.rs]||s.rs].map(v=>el('td',{},v instanceof Node?v:text(v))));
      });
      win.body.append(note('같은 날의 같은 환자 검사는 미리 체크되어 있습니다. 다른 날짜의 검사도 체크할 수 있습니다.'),summary,
        table(['Merge','Base','ID','Name','StudyDate','StudyDesc','Accession No','Series / Images','Report'],rows));
      win.buttons(go,win.closeButton());recompute();
      async function submit() {
        if(busy||!win.live()||go.disabled)return;
        const chosen=picked(),base=chosen.find(s=>bases.get(s.uid).checked);if(!base)return;
        busy=true;recompute();
        try {
          for(const s of chosen) {
            if(scopes.stamp(ctx.study(s.uid))!==captured.get(s.uid))throw Error('선택한 검사의 범위가 바뀌었습니다. 창을 다시 여세요.');
            const current=await scopes.fetch(ctx.api,s.uid,{at:win.at});
            if(!win.live())return;
            if(current.groupId)throw Error('선택한 검사가 이미 묶였습니다. 목록을 새로고침하세요.');
          }
          await ctx.api('POST','/exam-groups',{baseUid:base.uid,uids:chosen.map(s=>s.uid)},undefined,win.at);
          ctx.examChanged?.(chosen.map(s=>s.uid));
          await changed(win,`합쳤습니다: 검사 ${chosen.length}건 → ${text(base.acc)} · ${count(sum(chosen,'count'))}장. 원본 내보내기는 원래 검사 단위이며 판독문은 합치지 않습니다.`,base.uid);
        } catch(error) { failure(win,error); }
        finally {busy=false;if(win.live())recompute();}
      }
    }
    async function openUnmerge() {
      const win=begin('unmerge','Split / Unmerge Exam');if(!win)return;
      win.body.append(note('검사 범위를 확인하는 중입니다.'));win.buttons(win.closeButton());
      try {
        const answer=await ctx.api('GET','/studies/'+encodeURIComponent(win.row.uid)+'/exam-group',undefined,undefined,win.at);
        if(!win.live())return;
        if(answer.group)await showDissolve(win,answer);
        else await showSplit(win);
      }catch(error){if(win.live()){failure(win,error);win.buttons(button('Retry',()=>{win.close();openUnmerge();}),win.closeButton());}}
    }
    async function showDissolve(win,answer) {
      const scope=scopes.read(win.row),split=answer.group.kind==='split';
      if(scope?.groupId!==answer.group.id)throw Error('검사 범위가 바뀌었습니다. 목록을 새로고침한 뒤 다시 여세요.');
      const sources=scopes.metadata(win.row),checks=el('ul',{className:'exam-merge-checks'});
      const go=button(split?'Unsplit':'Unmerge',submit);
      let busy=false;
      const paint=()=>{checks.replaceChildren(...(answer.checks||[]).map(c=>el('li',{className:c.ok?'order-note ok':'order-note err',text:(c.ok?'✓ ':'✗ ')+c.message})));go.disabled=busy || !Array.isArray(answer.checks) || answer.checks.some(c=>!c.ok);};
      win.body.replaceChildren(note(split?'나눈 검사를 원래 영상 소속으로 되돌립니다. 양쪽의 판독 이력은 남습니다.':'합친 검사를 원래 영상 소속으로 되돌립니다. 합친 동안 쓴 판독 이력은 남습니다.'),
        table(['Original exam','StudyDate','StudyDesc','Series / Images back'],sources.map(s=>[s.acc??s.uid,s.date,s.desc,seriesImages(s.series,s.count)])),el('h4',{text:'Checks'}),checks,
        note('현재 승인·점유·초안·진행 중 전송이 있으면 서버가 되돌리기를 거절합니다. 합친 뒤 도착한 영상은 자기 원본에 그대로 남습니다.','muted'));
      win.buttons(go,win.closeButton());paint();
      async function submit() {
        if(busy||go.disabled||!win.live())return;busy=true;paint();
        try {
          await ctx.api('POST','/exam-groups/'+encodeURIComponent(answer.group.id)+'/dissolve',undefined,undefined,win.at);
          ctx.examChanged?.(scope.sources.map(s=>s.studyUid));
          await changed(win,'되돌렸습니다. 원본 영상과 기존 판독 이력은 보존했습니다.');
        }catch(error){failure(win,error);
          try {const next=await ctx.api('GET','/studies/'+encodeURIComponent(win.row.uid)+'/exam-group',undefined,undefined,win.at);
            if(win.live()&&next.group?.id===answer.group.id)answer=next;
          }catch(_){}
        }finally{busy=false;if(win.live())paint();}
      }
    }
    async function showSplit(win) {
      const scope=await scopes.fetch(ctx.api,win.row.uid,{at:win.at});
      const inventory=await scopes.dicom(scope,'series',async path=>{
        const response=await window.KinSessionTransport.page().request(path,{context:win.at,cache:'no-store'});
        if(!response.ok)throw Error('시리즈 목록을 불러오지 못했습니다.');return response.body;
      });
      if(!win.live())return;
      if(scope.groupId)throw Error('검사 범위가 바뀌었습니다. 창을 다시 여세요.');
      const tag=(r,k)=>r?.[k]?.Value?.[0];
      const rows=inventory.map(({row})=>({uid:tag(row,'0020000E'),number:tag(row,'00200011'),desc:tag(row,'0008103E'),
        modality:tag(row,'00080060'),count:Number.isSafeInteger(Number(tag(row,'00201209')))&&tag(row,'00201209')!=null?Number(tag(row,'00201209')):null}));
      const boxes=new Map(),summary=el('p',{className:'exam-merge-result',role:'status'});
      let busy=false;
      const go=button('Split',submit),picked=()=>rows.filter(s=>boxes.get(s.uid).checked);
      const images=items=>items.filter(s=>!['SR','DOC','PR','KO','SEG'].includes(s.modality));
      function paint(){const second=picked(),first=rows.filter(s=>!boxes.get(s.uid).checked);
        go.disabled=busy||!images(first).length||!images(second).length;
        summary.textContent=`Exam 1: 시리즈 ${first.length} · 영상 ${count(sum(first,'count'))} / Exam 2: 시리즈 ${second.length} · 영상 ${count(sum(second,'count'))}`;
      }
      win.body.replaceChildren(note('체크한 시리즈는 둘째 검사로 옮깁니다. 두 검사는 따로 판독합니다. 새 시리즈는 첫째 검사에, 기존 시리즈의 새 영상은 그 시리즈가 있는 쪽에 붙습니다.'),summary,
        table(['Exam 2','Series','Description','Modality','Images'],rows.map(s=>{
          const c=el('input',{type:'checkbox','aria-label':'Split '+text(s.desc||s.uid)});boxes.set(s.uid,c);c.onchange=paint;
          return [c,s.number,s.desc,s.modality,count(s.count)];
        })));
      if(images(rows).length<2)win.body.append(note('나눌 수 있는 영상 시리즈가 두 개 이상 필요합니다.','warn'));
      win.buttons(go,win.closeButton());paint();
      async function submit(){if(busy||go.disabled||!win.live())return;const chosen=picked();busy=true;paint();
        try {
          const fresh=await scopes.fetch(ctx.api,win.row.uid,{at:win.at});
          if(!win.live())return;
          if(scopes.stamp(fresh)!==scopes.stamp(scope))throw Error('검사 범위가 바뀌었습니다. 창을 다시 여세요.');
          await ctx.api('POST','/exam-groups/split',{uid:scope.reportUid,seriesUids:chosen.map(s=>s.uid)},undefined,win.at);
          ctx.examChanged?.(scope.sources.map(s=>s.studyUid));
          await changed(win,'나눴습니다. 목록의 Split 1/2와 Split 2/2에서 각각 판독할 수 있습니다.');
        }catch(error){failure(win,error);}finally{busy=false;if(win.live())paint();}
      }
    }
    const reportScope=document.getElementById('exam-report-scope');
    function paintScope(){
      const row=selected(),current=scopes.read(row),stored=scopes.read(row,'stored');
      if(row?.reportGroup?.readable===false){reportScope.hidden=false;reportScope.textContent='Exam scope — 저장된 판독 범위 일부를 볼 수 없어 본문을 보이지 않습니다.';return;}
      const scope=stored||current;
      reportScope.hidden=!scope?.groupId;
      reportScope.replaceChildren();if(reportScope.hidden)return;
      reportScope.append(el('b',{text:scope.kind==='split'?`Split ${(scope.part??0)+1}/2`:'Merged exam'}),
        ' — '+scope.sources.map(s=>accOf(s.studyUid)).join(' + ')+(scope.active?'':' · 지금은 되돌린 범위의 판독입니다.'));
      for(const source of scope.sources)reportScope.append(' ',button('Report History · '+accOf(source.studyUid),()=>ctx.report.history(source.studyUid)));
    }
    function paint(){roles();paintScope();
      if(active&&!active.completed&&!active.live()) {active.close();ctx.toast('선택 또는 검사 범위가 바뀌어 창을 닫았습니다. 다시 여세요.','info');}
      for(const tr of document.querySelectorAll('#rows tr[data-uid]')){
        const cell=tr.querySelector('td.acc');if(!cell)continue;cell.querySelector('.exam-merged')?.remove();
        const row=ctx.study(tr.dataset.uid),scope=scopes.read(row);if(!scope?.groupId)continue;
        const label=scope.kind==='split'?`Split ${(scope.part??0)+1}/2`:`Merged ×${scope.sources.length} · ${count(row.count)} img`;
        cell.append(' ',el('span',{className:'exam-merged',text:label,title:scopes.metadata(row).map(s=>text(s.acc??s.uid)).join(' + ')}));
      }
    }
    const style=document.head.appendChild(el('style',{text:'.exam-merged{display:inline-block;margin-left:4px;padding:0 5px;border:1px solid var(--kin-line2);border-radius:3px;color:var(--kin-warn,#ffcf7a);font-size:11px;white-space:nowrap}.exam-merge-checks{margin:4px 0;padding-left:18px}.exam-report-scope{padding:2px 6px;font-size:12px;color:var(--kin-warn,#ffcf7a)}'}));
    const offRender=ctx.onRender(paint),offSelect=ctx.onSelect(paint);
    mergeButton.addEventListener('click',openMerge);unmergeButton.addEventListener('click',openUnmerge);paint();
    return ()=>{sequence++;active?.close();offRender();offSelect();reportScope.hidden=true;reportScope.replaceChildren();style.remove();
      mergeButton.removeEventListener('click',openMerge);unmergeButton.removeEventListener('click',openUnmerge);
      for(const badge of document.querySelectorAll('#rows .exam-merged'))badge.remove();};
  });
})();
