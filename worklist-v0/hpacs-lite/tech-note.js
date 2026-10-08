/* A modal pins the viewed study for this edit; it never retargets the report.
 *
 * S8-CTX save contract (REQ-S8-CTX-NOTE, Astra 2026-10-05): the dialog keeps separate facts and derives every sentence,
 * Close question and unsaved-work flag from them.
 *   A  - an attempt: a UUID bound to one immutable request (study, base version, text, reason as typed). Its outcome is
 *        saved(vN) only from a valid POST receipt or a revision carrying its id and owned by this caller; not-saved from
 *        this send's 4xx / not sent (unless an earlier send of the same id is unknown) or from the exact next revision
 *        (base + 1) carrying another id; otherwise unknown. A confirmed outcome is never reversed by a later refusal.
 *   L  - the last confirmed revision; it only moves forward. I - the input; no outcome changes it, only the first read
 *        and an accepted Reload replace it. D = text differs from L, or a typed reason differs from L's reason, or an
 *        attempt is unresolved. A reason used by a saved attempt cannot be used again until it is typed again.
 *   C  - another save after the version the input is based on; it never makes D by itself.
 * The rows T01-T27 of the contract are named where they are decided.
 */
window.KinTechNote = function (app) {
  const work=window.KinWorkContext;
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
  let uid = null, seq = 0, busy = false, ended = false, writable = false, cursor = null, opener, openerDocument, innerOpener;
  let L = null, basis = 0, attempts = [], reasonGeneration = 0, interruptedRead = false, interruptedHistory = null, beforePreparation = null;
  const usedReasons = new Set();
  // Korean particles after a version number follow how its last digit is read (0 영·십·백, 1 일, 2 이, 3 삼, …):
  // "v2로·v3으로", "v1과·v2와", "v1을·v2를".
  const ro = v => `v${v}${/[036]$/.test(v) ? '으로' : '로'}`;
  const gwa = v => `v${v}${/[2459]$/.test(v) ? '와' : '과'}`;
  const eul = v => `v${v}${/[2459]$/.test(v) ? '를' : '을'}`;

  // ── facts ──
  const Lv = () => L?.version ?? 0, Ltext = () => L?.text ?? '', Lreason = () => L?.reason ?? '';
  const text = () => $('text').value, reason = () => $('reason').value;
  const unresolved = () => attempts.filter(a => a.outcome === 'pending' || a.outcome === 'unknown');
  const savedAttempts = () => attempts.filter(a => a.outcome === 'saved').sort((x, y) => x.version - y.version);
  const mine = revision => !!revision && attempts.some(a => a.outcome === 'saved' && a.version === revision.version && a.id === revision.attemptId);
  // The input differs from the last confirmed version: its text, or a reason typed for this edit (a blank reason means
  // none typed, not "erase the reason of the revision").
  const inputDiffers = () => text() !== Ltext() || (!!reason().trim() && reason().trim() !== Lreason());
  const dirty = () => inputDiffers() || unresolved().length > 0;
  const reasonUsable = () => !!reason().trim() && !usedReasons.has(reasonGeneration);
  const conflict = () => !!L && L.version > basis && !mine(L);
  $('reason').addEventListener('input', () => { ++reasonGeneration; });

  /** Record one revision as a fact about the attempts of this edit (T15, T16): only the exact next revision of an
   *  attempt's base decides it - its own id and owner mean saved, any other id means it can never be saved. */
  function learn(revision) {
    if (!revision || revision.studyUid !== uid || !Number.isInteger(revision.version)) return;
    for (const a of attempts) {
      if (a.outcome === 'saved' || revision.version !== a.base + 1) continue;
      if (revision.attemptId === a.id && revision.isOwnAttempt === true) {
        a.outcome = 'saved'; a.version = revision.version; for (const g of a.generations) usedReasons.add(g);
      } else a.outcome = 'not-saved';
    }
  }
  /** L moves only forward (T14: an older read never takes it back). */
  function advance(revision) {
    if (revision === null && !L) { meta(); return; }
    if (!revision || revision.studyUid !== uid || !Number.isInteger(revision.version) || revision.version <= Lv()) return;
    L = revision; app.changed?.(uid, L); meta();
  }
  function meta() {
    $('meta').textContent = L ? `v${L.version} · ${L.author} · ${new Date(L.createdAt).toLocaleString()}` : '저장된 메모 없음';
  }
  const status = sentence => { if ($('status').textContent !== sentence) $('status').textContent = sentence; };
  function controls() {
    $('save').disabled = busy || !writable || !app.allowed() || ended;
    $('text').readOnly = $('reason').disabled = busy || !writable || !app.allowed() || ended;
    for (const id of ['reload', 'history', 'more']) $(id).disabled = busy;
  }
  function valid(ticket, target) { return !ended && d.open && ticket === seq && uid === target && app.allowed(); }
  // How an answer ended: never sent, refused by the server (4xx, 409 apart), or unknown (5xx, lost, timeout, broken).
  function failure(e) {
    if (e?.notSent === true || e?.sent === false) return 'unsent';
    if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500) return e.status === 409 ? 'conflict' : 'refused';
    return 'unknown';
  }

  // ── sentences: one sentence that joins the facts it is about ──
  const latestSaved = () => savedAttempts().at(-1) || null;
  /** T14-T17: what the reads established about the attempts of this edit. */
  function factsSentence() {
    if (unresolved().length) return '앞선 저장 결과는 아직 확인되지 않았으며 입력은 유지됩니다.';
    const saved = latestSaved();
    if (conflict()) {
      if (saved) return `앞선 입력은 ${ro(saved.version)} 저장되었고 마지막 확인본은 다른 저장인 v${L.version}입니다.`;
      return `이 시도는 저장되지 않았고 마지막 확인본은 다른 저장인 v${L.version}이며 입력은 유지됩니다.`;
    }
    if (saved) {
      if (text() !== Ltext()) return `앞선 입력은 ${ro(saved.version)} 저장되었으며 현재 입력은 아직 저장되지 않았습니다.`;
      if (reason().trim() && reason().trim() !== Lreason()) return `앞선 입력은 ${ro(saved.version)} 저장되었으며 현재 사유는 저장되지 않았습니다.`;
      return `앞선 입력은 ${ro(saved.version)} 저장되었습니다.`;
    }
    return inputSentence();
  }
  /** T02: the input against the last confirmed version; an unresolved attempt stays said. */
  function inputSentence() {
    const differs = inputDiffers(), open = unresolved().length > 0;
    if (open) return `현재 입력은 마지막 확인본과 ${differs ? '다르며' : '같으며'} 앞선 저장 결과는 아직 확인되지 않았습니다.`;
    return `현재 입력은 마지막 확인본과 ${differs ? '다릅니다' : '같습니다'}.`;
  }
  const openedSentence = () => (L ? `마지막으로 확인한 메모는 v${L.version}입니다.` : '마지막으로 확인한 메모가 없습니다.')
    + (writable ? '' : ' 읽기 전용입니다 · 촬영 기관의 작성 권한이 필요합니다.');
  for (const id of ['text', 'reason']) $(id).addEventListener('input', () => { if (!busy && d.open) status(inputSentence()); });

  // ── reads ──
  async function read() {
    if(work.state()!=='active')return;
    const at=work.capture('document'); interruptedRead=true; interruptedHistory=null;
    const ticket = ++seq, target = uid; busy = true; controls(); status('메모를 불러오는 중…');
    try {
      const result = await app.api('GET', '/studies/' + encodeURIComponent(target) + '/tech-note', undefined, undefined, at);
      work.commit(at,()=>{if (valid(ticket, target)) {
        if (result?.uid !== target || result.note && result.note.studyUid !== target) throw new Error('메모 대상이 일치하지 않습니다');
        // T01 / T21: the read and an accepted Reload are the only writers of the input; the reason starts untyped.
        writable = result.writable === true; learn(result.note); advance(result.note);
        $('text').value = Ltext(); $('reason').value = ''; ++reasonGeneration; basis = Lv();
        $('history-items').replaceChildren(); cursor = null; $('more').hidden = true; interruptedRead=false;
        status(openedSentence());
      }});
    } catch (e) { work.commit(at,()=>{if (valid(ticket, target)) status('메모를 불러오지 못했으며 입력은 유지됩니다: ' + e.message);}); }
    finally { if (ticket === seq) busy=false; work.commit(at,()=>{if(ticket===seq){interruptedRead=false;controls();}}); }
  }
  /** T14-T17, T20: read the latest (and the exact next revision of each unresolved base) to settle attempts. Writes
   *  nothing, replaces no input. Answers 'stale' when this screen moved on meanwhile. */
  async function check() {
    if(work.state()!=='active'||ended||!d.open)return 'stale';
    const at=work.capture('document'), ticket=++seq, target=uid;
    busy=true; controls();
    try {
      // Client completion is not server completion: wait for every send still out before reading.
      await Promise.all(attempts.map(a => a.inflight));
      if(!work.admits(at)||!valid(ticket,target))return 'stale';
      const result=await app.api('GET','/studies/'+encodeURIComponent(target)+'/tech-note',undefined,undefined,at);
      if(!work.admits(at)||!valid(ticket,target))return 'stale';
      if(result?.uid!==target||result.note&&result.note.studyUid!==target)throw new Error('메모 대상이 일치하지 않습니다');
      const proofs=[];
      for (const base of new Set(unresolved().map(a => a.base))) {
        if ((result.note?.version ?? 0) <= base + 1) continue;
        const history=await app.api('GET','/studies/'+encodeURIComponent(target)+'/tech-note/history?before='+(base+2),undefined,undefined,at);
        if(!work.admits(at)||!valid(ticket,target))return 'stale';
        if(history?.uid!==target||!Array.isArray(history.items))throw new Error('메모 이력을 확인하지 못했습니다');
        // Only that exact revision decides; a missing row leaves the attempt unknown.
        const next=history.items.find(item=>item.studyUid===target&&item.version===base+1);
        if(next)proofs.push(next);
      }
      let committed=false;
      work.commit(at,()=>{ if(!valid(ticket,target))return;
        writable = result.writable === true; learn(result.note); for(const next of proofs)learn(next); advance(result.note); committed=true; });
      return committed ? 'read' : 'stale';
    } catch(e){ work.commit(at,()=>{if(valid(ticket,target))status('앞선 저장 결과는 아직 확인되지 않았으며 입력은 유지됩니다: '+e.message);}); return 'failed'; }
    finally {if(ticket===seq)busy=false;work.commit(at,()=>{if(ticket===seq)controls();});}
  }

  // ── writes ──
  // `generations`: the reason inputs this attempt carried - the one it was made from, and the input of a click that resent
  // it unchanged; a saved attempt uses up every one of them.
  function attempt(base) {
    return { id: crypto.randomUUID(), uid, base, text: text(), reason: reason(), generations: new Set([reasonGeneration]), outcome: 'new', version: 0, sends: [], inflight: null };
  }
  const sameRequest = a => a.text === text() && a.reason.trim() === reason().trim();
  /** One POST of attempt `a`. `prior` = an attempt of this click already saved (its fact joins the sentence). */
  async function send(a, sentence, prior = null) {
    if(work.state()!=='active'||!writable||!app.allowed()||ended||!d.open)return null;
    const at=work.capture('document'), ticket=++seq, target=uid, sent={state:'sent'};
    if(!attempts.includes(a))attempts.push(a);
    a.sends.push(sent); if(a.outcome!=='saved')a.outcome='pending';
    let finish; a.inflight=new Promise(resolve=>{finish=resolve;});
    busy=true; controls(); status(sentence);
    let result=null, ending=null;
    try {
      result = await app.api('POST', '/studies/' + encodeURIComponent(target) + '/tech-note',
        { baseVersion: a.base, text: a.text, reason: a.reason, attemptId: a.id }, undefined, at);
      sent.state='answered';
      work.commit(at,()=>{ if(!valid(ticket,target))return;
        const note=result?.note;
        // T11: a receipt is valid only when it is this attempt's revision as the caller's own.
        if(result?.uid===target&&note&&note.studyUid===target&&note.version===a.base+1&&note.text===a.text&&note.reason===a.reason.trim()&&
           note.attemptId===a.id&&note.isOwnAttempt===true){
          writable=result.writable===true; learn(note); learn(result.latestNote); advance(note); advance(result.latestNote);
          if(a.outcome==='saved')basis=Math.max(basis,a.version);
          ending='saved';
        } else { sent.state='unknown'; if(a.outcome!=='saved'&&a.outcome!=='not-saved')a.outcome='unknown'; ending='unknown'; }
      });
    } catch (e) {
      const kind=failure(e);
      work.commit(at,()=>{ if(!valid(ticket,target))return;
        // An earlier send of the same id that is still unknown may have committed: this answer does not settle it.
        const earlierUnknown=a.sends.some(s=>s!==sent&&(s.state==='unknown'||s.state==='sent'));
        if(kind==='unknown'){ sent.state='unknown'; if(a.outcome!=='saved'&&a.outcome!=='not-saved')a.outcome='unknown'; }
        else { sent.state=kind==='unsent'?'unsent':'refused'; if(a.outcome!=='saved')a.outcome=earlierUnknown?'unknown':'not-saved'; }
        ending=kind; result=e;
      });
    } finally {
      finish(); if(a.outcome==='pending')a.outcome='unknown';
      if(ticket===seq)busy=false; work.commit(at,()=>{if(ticket===seq)controls();});
    }
    if(!ending||!valid(seq,target))return null;
    const before=prior?`앞선 입력은 ${ro(prior.version)} 저장되었지만 `:'';
    // T12 exception: a refused or unsent resend leaves an earlier unknown send of the same id unknown, and says so.
    const open=a.outcome==='unknown'?' 앞선 저장 결과는 아직 확인되지 않았습니다.':'';
    if(ending==='saved'){
      const later=L&&L.version>a.version&&!mine(L)?` 마지막 확인본은 다른 저장인 v${L.version}입니다.`:'';
      status(later?`입력이 ${ro(a.version)} 저장되었고${later}`:inputDiffers()?`입력이 ${ro(a.version)} 저장되었으며 이후 입력은 아직 저장되지 않았습니다.`:`입력이 ${ro(a.version)} 저장되었습니다.`);
    } else if(ending==='unknown') status(before?before+'이번 입력의 저장 결과는 알 수 없으며 입력은 유지되므로 Save Note 또는 Reload Note로 확인하세요.'
      :'저장 결과를 알 수 없으며 입력은 유지되므로 Save Note 또는 Reload Note로 확인하세요.');
    else if(ending==='unsent') status((before?before+'이번 입력은 저장 요청을 보내지 못해 유지됩니다.':'저장 요청을 보내지 못해 입력을 유지합니다.')+open);
    else if(ending==='refused') status((before?before+'이번 입력은 거절되어 유지됩니다':'이번 저장은 거절되어 입력을 유지합니다')+(result?.message?' ('+result.message+').':'.')+open);
    return ending;
  }
  // T04 / T18: an edit of an existing note needs a reason typed for it; an earlier save of this edit is said with it.
  function needReason(prior) {
    const saved=latestSaved();
    status(prior?`앞선 입력은 ${ro(prior.version)} 저장되었으며 현재 수정은 새 사유를 입력한 뒤 저장하세요.`:
      (saved?`앞선 입력은 ${ro(saved.version)} 저장되었으며 이번 수정의 사유를 입력하세요.`:'이번 수정의 사유를 입력하세요.'));
    $('reason').focus();
  }
  /** A new attempt from the current input on `base` (T03, T09, T18 follow-up). Checks T04-T06 first. */
  async function fresh(base, sentence, prior = null) {
    if (Lv() === 0 && !text().trim()) { status('메모 내용을 입력하세요.'); $('text').focus(); return null; } // T05
    if (text() === Ltext()) { // T06
      const reasonOnly = !!reason().trim() && reason().trim() !== Lreason();
      status(`새 저장은 보내지 않았으며 본문은 마지막 확인한 ${gwa(Lv())} 같${reasonOnly ? '고 사유만의 변경은 저장되지 않습니다' : '습니다'}.`);
      return null;
    }
    if (base > 0 && !reasonUsable()) { needReason(prior); return null; }
    return send(attempt(base), sentence, prior);
  }
  /** After 409 (T07): read; a different save found stops this click; my own earlier save allows the one follow-up.
   *  `prior` = this click's earlier save, said together with the refusal of the follow-up (T19). */
  async function afterConflict(prior, followed) {
    const outcome = await check();
    if (outcome === 'stale') return;
    const before = prior ? `앞선 입력은 ${ro(prior.version)} 저장되었지만 이번 입력은` : '이번 저장은';
    if (outcome !== 'read') { status(before + ' 다른 저장과 충돌해 거절되었으며 최신본을 확인하지 못했으므로 입력은 유지되고 Reload Note로 다시 확인하세요.'); return; }
    if (unresolved().length) { status(factsSentence()); return; } // T14: the read did not settle an earlier unknown send
    if (conflict()) {
      status(prior ? `${before} 다른 저장 ${gwa(L.version)} 충돌해 거절되었으며 입력은 유지되므로 비교 후 Save Note 또는 Reload Note를 선택하세요.`
        : `다른 저장 ${eul(L.version)} 확인했으며 입력은 유지되므로 비교 후 Save Note 또는 Reload Note를 선택하세요.`);
      return;
    }
    return settled(followed);
  }
  /** Every attempt of this edit is settled: say so, or send the one follow-up of this click (T15-T19). */
  async function settled(followed) {
    const saved = latestSaved();
    if (!saved || !mine(L) || text() === Ltext() || followed) { status(factsSentence()); return; }
    // T18: the latest is my own earlier save and the box differs - one follow-up on it, never more in this click.
    const ending = await fresh(Lv(), '입력을 저장하는 중입니다.', saved);
    if (ending === 'conflict') await afterConflict(saved, true);
  }
  $('save').onclick = async () => {
    if(work.state()!=='active'||busy||!writable||!app.allowed()||ended||!d.open)return;
    if (unresolved().length) {
      const outcome = await check();
      if (outcome === 'stale') return;
      const open = unresolved();
      if (open.length) {
        const a = open.at(-1);
        // T14: only a read that still shows the attempt's base lets the same request go again or a new one start.
        if (outcome === 'failed') return; // its sentence already says the result is still unknown
        if (Lv() !== a.base) { status(factsSentence()); return; }
        if (sameRequest(a)) { // T08: the same id, the same request, once
          a.generations.add(reasonGeneration);
          const ending = await send(a, '앞선 저장 결과를 확인하며 같은 입력을 다시 요청합니다.');
          if (ending === 'conflict') await afterConflict(null, false);
          return;
        }
        if (text() === Ltext()) { status('본문은 마지막 확인본과 같지만 앞선 저장 결과는 아직 알 수 없습니다.'); return; } // T10
        const ending = await fresh(a.base, '현재 입력을 저장하는 중이며 앞선 시도와 결과를 구분해 확인합니다.'); // T09
        if (ending === 'conflict') await afterConflict(null, false);
        return;
      }
      return settled(false);
    }
    // T03, with a known conflict too: the base is the version already shown, never one found during this click.
    const ending = await fresh(Lv(), '입력을 저장하는 중입니다.');
    if (ending === 'conflict') await afterConflict(null, false);
  };

  // ── reload, history, close ──
  $('reload').onclick = async () => {
    if (busy || !d.open) return;
    if (unresolved().length) { // T20: results only - no write, no input replaced
      if (await check() === 'read') status(factsSentence());
      return;
    }
    // T21: ask only when the input would lose a difference; a cancelled question or a failed read keeps it.
    if (inputDiffers() && !confirm('현재 입력을 버리고 마지막 저장본을 불러올까요?')) return;
    read();
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
        learn(item); // T23: an id found in the history settles its attempt; the input stays
        const entry = document.createElement('section'), title = document.createElement('h3'), body = document.createElement('pre');
        title.textContent = `v${item.version} · ${item.author} · ${new Date(item.createdAt).toLocaleString()}`;
        body.textContent = (item.text || '(메모 비움)') + '\n수정 사유: ' + (item.reason || '(최초 작성)');
        entry.append(title, body); $('history-items').append(entry);
      }
      // Only the first page identifies the latest confirmed revision; older pages supply attempt evidence only.
      if (!more) advance(result.items[0]);
      cursor = result.nextBefore; $('more').hidden = !cursor;
      const open = unresolved().length ? ' 앞선 저장 결과는 아직 확인되지 않았습니다.' : '';
      status((result.items.length ? '저장 이력을 표시하며 현재 입력은 유지됩니다.' : '저장 이력이 없으며 현재 입력은 유지됩니다.') + open);});
    } catch (e) { work.commit(at,()=>{if (valid(ticket, target)) status('이력을 불러오지 못했으며 입력은 유지됩니다: ' + e.message);}); }
    finally { if (ticket === seq) busy=false; work.commit(at,()=>{if(ticket===seq){interruptedHistory=null;controls();}}); }
  }
  $('history').onclick = () => history(false); $('more').onclick = () => history(true);
  // T22: a clean dialog closes at once; otherwise one question, and a cancel keeps everything. A write still out does not
  // trap the reader: closing does not cancel it, and the question says so.
  function close(force = false) {
    if (!force) {
      if (unresolved().length) { if (!confirm('저장 결과가 미확정이고 닫아도 저장이 취소되지는 않는데 닫을까요?')) return; }
      else if (dirty() && !confirm('현재 입력이 마지막 확인본과 다른데 입력을 버리고 닫을까요?')) return;
    }
    const closedUid = uid;
    ++seq; uid = null; busy = false; writable = false; L = null; basis = 0; attempts = []; usedReasons.clear();
    interruptedRead = false; interruptedHistory = null; beforePreparation = null;
    $('text').value = $('reason').value = ''; ++reasonGeneration; $('history-items').replaceChildren(); $('target').textContent = $('meta').textContent = ''; status('');
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
  function end() { ended = true; close(true); } // T25: the security end closes; unsent input is not kept anywhere.
  const unsubscribe=work.onInvalidate(event=>{
    if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();
    // T24: a logout preparation stops new writes (the context refuses them) and keeps the input.
    if(event.reason==='prepare'&&d.open){beforePreparation??=$('status').textContent;status('로그아웃 확인 중이며 입력은 유지됩니다.');}
    if(event.reason==='cancel'){
      ++seq;busy=false;controls();
      const previous=beforePreparation;beforePreparation=null;
      // Back to Editing resumes reads only - never a write.
      if(d.open&&unresolved().length){check().then(outcome=>{if(outcome==='read')status(factsSentence());});}
      else if(d.open&&interruptedHistory!==null){const more=interruptedHistory;interruptedHistory=null;history(more);}
      else if(d.open&&interruptedRead&&!inputDiffers()){interruptedRead=false;read();}
      else if(d.open&&previous!==null)status(previous);
    }
  });
  const pagehide = () => { end(); unsubscribe(); };
  const pageshow = e => { if (e.persisted) location.reload(); };
  const beforeunload = e => { if (d.open && dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow); window.addEventListener('beforeunload', beforeunload);
  // The one published state. Log Out's question (and the Worklist page's own declaration) reads `dirty || unknown`;
  // `busy` is also true while the note or its history is only being read, so it never makes a question on its own.
  // `dirty()` is the contract's D (an unresolved attempt included) for the Worklist page's declaration (main.html).
  const workspaceState = () => ({ dirty: d.open && dirty(), busy: d.open && busy, unknown: d.open && unresolved().length > 0 });
  return { workspaceState, dirty: () => workspaceState().dirty, dispose() {
    end(); unsubscribe(); d.remove();
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', pageshow); window.removeEventListener('beforeunload', beforeunload);
  }, open(study) {
    if (work.state()!=='active' || ended || d.open || !study || !app.allowed()) return;
    uid = study.uid; opener = document.activeElement; cursor = null; $('more').hidden = true;
    openerDocument = innerOpener = null; L = null; basis = 0; attempts = []; usedReasons.clear();
    try {
      if (opener?.tagName === 'IFRAME') { openerDocument = opener.contentDocument; innerOpener = openerDocument?.activeElement; }
    } catch (_) { /* Only same-origin iframe focus can be retained. */ }
    $('target').textContent = [study.name, study.id, study.date, study.desc, study.uid].filter(Boolean).join(' · ');
    writable = false; controls(); d.showModal(); read();
  } };
};
