/* A modal pins the viewed study for this edit; it never retargets the report. */
window.KinTechNote = function (app) {
  const work=window.KinWorkContext;
  let interruptedRead=false;
  const d = document.createElement('dialog'); d.id = 'tech-note-dialog';
  d.setAttribute('aria-labelledby', 'tech-note-title');
  d.innerHTML = `<h2 id="tech-note-title">Tech Note</h2>
    <div id="tech-note-target"></div><p>판독문·원본 영상과 별도로 저장됩니다. 촬영 기관의 방사선사·관리자가 작성하며 수정 전 내용은 이력에 남습니다.</p>
    <div id="tech-note-meta"></div><label>Note<textarea id="tech-note-text" maxlength="10000" rows="7"></textarea></label>
    <label>Reason for Change<input id="tech-note-reason" maxlength="1000"></label>
    <div id="tech-note-status" role="status"></div><div class="tech-note-actions">
    <button id="tech-note-save" type="button">Save Note</button><button id="tech-note-reload" type="button">Reload Note</button>
    <button id="tech-note-history" type="button">History</button><button id="tech-note-close" type="button">Close</button></div>
    <div id="tech-note-history-items"></div><button id="tech-note-more" type="button" hidden>Load More</button>`;
  document.body.append(d);
  const $ = id => d.querySelector('#tech-note-' + id);
  let uid = null, seq = 0, busy = false, ended = false, writable = false, version = 0, saved = '', savedReason = '', cursor = null, opener, openerDocument, innerOpener;
  const dirty = () => $('text').value !== saved || $('reason').value.trim() !== savedReason;
  const status = text => { $('status').textContent = text; };
  function controls() {
    $('save').disabled = busy || !writable || !app.allowed() || ended;
    $('text').readOnly = $('reason').disabled = busy || !writable || !app.allowed() || ended;
    for (const id of ['reload', 'history', 'more', 'close']) $(id).disabled = busy;
  }
  function valid(ticket, target) { return !ended && d.open && ticket === seq && uid === target && app.allowed(); }
  // A receipt/read records the server baseline; only an explicit read replaces input.
  function remember(result) {
    if (result.uid !== uid || result.note && result.note.studyUid !== uid) throw new Error('메모 대상이 일치하지 않습니다');
    writable = result.writable === true; version = result.note?.version ?? 0; saved = result.note?.text ?? '';
    savedReason = result.note?.reason ?? '';
    app.changed?.(uid, result.note);
    $('meta').textContent = result.note ? `v${version} · ${result.note.author} · ${new Date(result.note.createdAt).toLocaleString()}` : '저장된 메모 없음';
  }
  function adopt(result) {
    remember(result);
    $('text').value = saved; $('reason').value = savedReason;
    status(writable ? '내용을 확인한 뒤 명시적으로 저장하세요.' : '읽기 전용 · 촬영 기관의 작성 권한이 필요합니다.');
  }
  async function read() {
    if(work.state()!=='active')return;
    const at=work.capture('document'); interruptedRead=true;interruptedHistory=null;interruptedSave=null;
    const ticket = ++seq, target = uid; busy = true; controls(); status('메모를 불러오는 중…');
    try {
      const result = await app.api('GET', '/studies/' + encodeURIComponent(target) + '/tech-note', undefined, undefined, at);
      work.commit(at,()=>{if (valid(ticket, target)) { adopt(result); $('history-items').replaceChildren(); cursor = null; $('more').hidden = true; interruptedRead=false; }});
    } catch (e) { work.commit(at,()=>{if (valid(ticket, target)) status('조회 실패: ' + e.message);}); }
    finally { if (ticket === seq) busy=false; work.commit(at,()=>{if(ticket===seq){interruptedRead=false;controls();}}); }
  }
  $('save').onclick = async () => {
    if(work.state()!=='active'||busy||!writable||!app.allowed()||ended)return;
    if(interruptedSave){
      const pending=interruptedSave;
      const outcome=await reconcileSave(pending);
      if(outcome==='unchanged')await saveCurrent(pending.body.baseVersion,pending);
      else if(outcome==='stored'&&dirty())await saveCurrent(version);
      return;
    }
    if (busy || !writable || !app.allowed() || ended) return;
    if (version && !$('reason').value.trim()) { status('수정·비우기 사유를 입력하세요.'); $('reason').focus(); return; }
    await saveCurrent(version);
  };
  const savedStatus = () => '저장되었습니다. v' + version + (dirty() ? ' · 이후 입력은 아직 저장되지 않았습니다.' : '');
  function saveCurrent(baseVersion, prior=null) {
    return save({ baseVersion, text: $('text').value, reason: $('reason').value }, prior);
  }
  async function save(body, prior=null) {
    if(work.state()!=='active'||busy||!writable||!app.allowed()||ended||!d.open)return;
    const at=work.capture('document');
    const ticket = ++seq, target = uid;
    let settled, confirmed = false, recheck = false;
    const pending={target,body,attempts:[...(prior?.attempts||[]),body],previous:prior?prior.previous:saved,done:new Promise(resolve=>{settled=resolve;})};
    interruptedSave=pending;busy = true; controls(); status('저장 중…');
    try {
      const result = await app.api('POST', '/studies/' + encodeURIComponent(target) + '/tech-note', body, undefined, at);
      work.commit(at,()=>{if (valid(ticket, target)) {
        remember(result); $('history-items').replaceChildren(); $('more').hidden = true; cursor = null;
        confirmed = true;
        status(savedStatus());
      }});
    } catch (e) { work.commit(at,()=>{if (valid(ticket, target)) {
      // An answered refusal is not an uncertain write. A gateway error alone
      // cannot prove whether the application committed the note.
      confirmed = e.notSent === true || e.status >= 400 && e.status < 500;
      // Refusing the retry does not refuse the original in-flight write. In
      // particular, its 409 may mean that the original has just committed.
      if(prior&&confirmed){confirmed=false;recheck=true;return;}
      status(e.notSent === true
        ? '저장 요청을 보내지 못했습니다: ' + e.message + ' · 입력은 유지했습니다.'
        : confirmed
        ? '저장되지 않았습니다: ' + e.message + ' · 입력은 유지했습니다. 최신 메모와 이력을 확인하세요.'
        : '저장 결과를 알 수 없습니다: ' + e.message + ' · 입력은 유지했습니다. Save Note 또는 Reload Note로 결과를 확인하세요.');
    }}); }
    finally { settled();if (ticket === seq) busy=false; work.commit(at,()=>{if(ticket===seq){if(confirmed)interruptedSave=null;controls();}}); }
    if(recheck&&work.admits(at)&&valid(ticket,target)){
      const outcome=await reconcileSave(pending);
      // This Save press may follow a witnessed earlier write once. The new write
      // has no unresolved predecessor, so its own answer cannot start a retry loop.
      if(outcome==='stored'&&dirty())await saveCurrent(version);
    }
  }
  const unknownActions='저장 결과는 아직 알 수 없습니다 · 입력은 유지되며 Save Note는 확인 후 재시도하고 Reload Note는 결과만 확인합니다.';
  async function reconcileSave(pending) {
    if(work.state()!=='active'||ended||!d.open||uid!==pending.target)return;
    const at=work.capture('document'),ticket=++seq,target=uid;
    busy=true;controls();
    // Client completion is not server completion. Only a witnessed revision
    // resolves an unanswered write; an old read permits a same-base CAS retry.
    await pending.done;
    if(!work.admits(at)||!valid(ticket,target))return;
    try {
      const result=await app.api('GET','/studies/'+encodeURIComponent(target)+'/tech-note',undefined,undefined,at);
      if (!work.admits(at) || !valid(ticket,target)) return;
      if(result.uid!==target||result.note&&result.note.studyUid!==target)throw new Error('메모 대상이 일치하지 않습니다');
      work.commit(at,()=>{if(valid(ticket,target))remember(result);});
      let next = result.note?.version === pending.body.baseVersion + 1 ? result.note : null;
      // A later revision is not proof that this attempt failed. The immutable next
      // revision resolves that attempt without replacing the reader's current input.
      if ((result.note?.version ?? 0) > pending.body.baseVersion + 1) {
        const history = await app.api('GET','/studies/'+encodeURIComponent(target)+'/tech-note/history?before='+(pending.body.baseVersion+2),undefined,undefined,at);
        if (!work.admits(at) || !valid(ticket,target)) return;
        if (history.uid!==target || !Array.isArray(history.items)) throw new Error('메모 이력을 확인하지 못했습니다');
        next=history.items.find(item=>item.studyUid===target&&item.version===pending.body.baseVersion+1)||null;
      }
      let outcome;
      work.commit(at,()=>{
        if(!valid(ticket,target))return;
        if(result.uid!==target||result.note&&result.note.studyUid!==target)throw new Error('메모 대상이 일치하지 않습니다');
        const latest=result.note,revision=latest?.version??0;
        const witnessed=next&&pending.attempts.some(body=>next.text===body.text&&(next.reason||'')===(body.reason||'').trim());
        const stored=revision===pending.body.baseVersion+1&&witnessed;
        const unchanged=revision===pending.body.baseVersion&&(latest?.text??'')===pending.previous;
        if(stored){$('history-items').replaceChildren();$('more').hidden=true;cursor=null;}
        else if(unchanged){outcome='unchanged';status(unknownActions);return;}
        else {
          if(next)interruptedSave=null;
          status(witnessed?'저장되었습니다. v'+next.version+' · 이후 메모가 변경되어 입력을 유지했습니다. 최신 메모와 비교하세요.':next?'저장되지 않았습니다. 다른 메모가 저장되었습니다. 입력은 유지했습니다. 최신 메모와 이력을 확인하세요.':'저장 결과를 알 수 없습니다. 입력은 유지했습니다. 최신 메모와 이력을 다시 확인하세요.');return;
        }
        interruptedSave=null;outcome='stored';status(savedStatus());
      });
      return outcome;
    } catch(e){work.commit(at,()=>{if(valid(ticket,target))status('저장 결과를 알 수 없습니다: '+e.message+' · 입력은 유지했습니다. Save Note 또는 Reload Note로 다시 확인하세요.');});}
    finally {if(ticket===seq)busy=false;work.commit(at,()=>{if(ticket===seq)controls();});}
  }
  $('reload').onclick = () => {
    if (interruptedSave) { if (!busy) reconcileSave(interruptedSave); return; }
    if (!busy && (!dirty() || confirm('입력 중인 메모를 버리고 최신 저장본을 읽을까요?'))) read();
  };
  async function history(more) {
    if(work.state()!=='active')return;
    const at=work.capture('document');
    if (busy) return;
    const ticket = ++seq, target = uid;interruptedHistory=more;busy = true; controls(); status('이력을 불러오는 중…');
    try {
      const result = await app.api('GET', '/studies/' + encodeURIComponent(target) + '/tech-note/history' + (more && cursor ? '?before=' + cursor : ''), undefined, undefined, at);
      work.commit(at,()=>{if (!valid(ticket, target)) return;
      if (result.uid !== target || !Array.isArray(result.items) || result.items.some(x => x.studyUid !== target)) throw new Error('이력 대상이 일치하지 않습니다');
      if (!more) $('history-items').replaceChildren();
      for (const item of result.items) {
        const entry = document.createElement('section'), title = document.createElement('h3'), text = document.createElement('pre');
        title.textContent = `v${item.version} · ${item.author} · ${new Date(item.createdAt).toLocaleString()}`;
        text.textContent = (item.text || '(메모 비움)') + '\n수정 사유: ' + (item.reason || '(최초 작성)');
        entry.append(title, text); $('history-items').append(entry);
      }
      cursor = result.nextBefore; $('more').hidden = !cursor;
      status(result.items.length ? '저장 이력입니다. 입력 중인 메모는 유지됩니다.' : '저장 이력이 없습니다.');});
    } catch (e) { work.commit(at,()=>{if (valid(ticket, target)) status('이력 조회 실패: ' + e.message);}); }
    finally { if (ticket === seq) busy=false; work.commit(at,()=>{if(ticket===seq){interruptedHistory=null;controls();}}); }
  }
  $('history').onclick = () => history(false); $('more').onclick = () => history(true);
  function close(force = false) {
    if (!force && (busy || (dirty() || interruptedSave) && !confirm(interruptedSave
      ? '저장 결과를 알 수 없습니다. 메모 입력을 버리고 닫을까요? 다시 열어 최신 메모와 이력을 확인하세요.'
      : '저장하지 않은 메모 입력을 버리고 닫을까요?'))) return;
    const closedUid = uid;
    ++seq; uid = null; busy = false; writable = false; saved = savedReason = ''; version = 0; interruptedSave = null;
    $('text').value = $('reason').value = ''; $('history-items').replaceChildren(); $('target').textContent = $('meta').textContent = ''; status('');
    if (d.open) d.close();
    if (!force) {
      if (opener?.isConnected) {
        opener.focus();
        try {
          if (openerDocument && opener.contentDocument === openerDocument && innerOpener?.isConnected) {
            opener.contentWindow.focus(); innerOpener.focus({ preventScroll: true });
          }
        } catch (_) { /* A navigated/cross-origin document cannot receive old focus. */ }
      } else app.restoreFocus?.(closedUid);
    }
    opener = openerDocument = innerOpener = null;
  }
  $('close').onclick = () => close(); d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  function end() { ended = true; close(true); }
  let interruptedHistory=null,interruptedSave=null;
  const unsubscribe=work.onInvalidate(event=>{
    if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();
    if(event.reason==='cancel'){
      ++seq;busy=false;controls();
      if(d.open&&interruptedSave){reconcileSave(interruptedSave);}
      else if(d.open&&interruptedHistory!==null){const more=interruptedHistory;interruptedHistory=null;history(more);}
      else if(d.open&&interruptedRead&&!dirty()){interruptedRead=false;read();}
    }
  });
  const pagehide = () => { end(); unsubscribe(); };
  const pageshow = e => { if (e.persisted) location.reload(); };
  const beforeunload = e => { if (d.open && (busy || dirty() || interruptedSave)) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow); window.addEventListener('beforeunload', beforeunload);
  return { workspaceState: () => ({ dirty: d.open && dirty(), busy: d.open && busy, unknown: d.open && !!interruptedSave }), dispose() {
    end(); unsubscribe(); d.remove();
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', pageshow); window.removeEventListener('beforeunload', beforeunload);
  }, open(study) {
    if (work.state()!=='active' || ended || d.open || !study || !app.allowed()) return;
    uid = study.uid; opener = document.activeElement; cursor = null; $('more').hidden = true;
    openerDocument = innerOpener = null;
    try {
      if (opener?.tagName === 'IFRAME') { openerDocument = opener.contentDocument; innerOpener = openerDocument?.activeElement; }
    } catch (_) { /* Only same-origin iframe focus can be retained. */ }
    $('target').textContent = [study.name, study.id, study.date, study.desc, study.uid].filter(Boolean).join(' · ');
    writable = false; controls(); d.showModal(); read();
  } };
};
