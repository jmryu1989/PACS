/* A modal pins the viewed study for this edit; it never retargets the report. */
window.KinTechNote = function (app) {
  const d = document.createElement('dialog'); d.id = 'tech-note-dialog';
  d.setAttribute('aria-labelledby', 'tech-note-title');
  d.innerHTML = `<h2 id="tech-note-title">Tech 메모 · 검사 소통 기록</h2>
    <div id="tech-note-target"></div><p>판독문·원본 영상과 별도로 저장됩니다. 촬영 기관의 방사선사·관리자가 작성하며 수정 전 내용은 이력에 남습니다.</p>
    <div id="tech-note-meta"></div><label>메모<textarea id="tech-note-text" maxlength="10000" rows="7"></textarea></label>
    <label>수정·비우기 사유<input id="tech-note-reason" maxlength="1000"></label>
    <div id="tech-note-status" role="status"></div><div class="tech-note-actions">
    <button id="tech-note-save" type="button">메모 저장</button><button id="tech-note-reload" type="button">최신 메모 다시 읽기</button>
    <button id="tech-note-history" type="button">변경 이력</button><button id="tech-note-close" type="button">닫기</button></div>
    <div id="tech-note-history-items"></div><button id="tech-note-more" type="button" hidden>이전 이력 더 보기</button>`;
  document.body.append(d);
  const $ = id => d.querySelector('#tech-note-' + id);
  let uid = null, seq = 0, busy = false, ended = false, writable = false, version = 0, saved = '', cursor = null, opener;
  const dirty = () => $('text').value !== saved || !!$('reason').value;
  const status = text => { $('status').textContent = text; };
  function controls() {
    $('save').disabled = busy || !writable || !app.allowed() || ended;
    $('text').readOnly = $('reason').disabled = busy || !writable || !app.allowed() || ended;
    for (const id of ['reload', 'history', 'more', 'close']) $(id).disabled = busy;
  }
  function valid(ticket, target) { return !ended && d.open && ticket === seq && uid === target && app.allowed(); }
  function adopt(result) {
    if (result.uid !== uid || result.note && result.note.studyUid !== uid) throw new Error('메모 대상이 일치하지 않습니다');
    writable = result.writable === true; version = result.note?.version ?? 0; saved = result.note?.text ?? '';
    $('text').value = saved; $('reason').value = '';
    $('meta').textContent = result.note ? `v${version} · ${result.note.author} · ${new Date(result.note.createdAt).toLocaleString()}` : '저장된 메모 없음';
    status(writable ? '내용을 확인한 뒤 명시적으로 저장하세요.' : '읽기 전용 · 촬영 기관의 작성 권한이 필요합니다.');
  }
  async function read() {
    const ticket = ++seq, target = uid; busy = true; controls(); status('메모를 불러오는 중…');
    try {
      const result = await app.api('GET', '/studies/' + encodeURIComponent(target) + '/tech-note');
      if (valid(ticket, target)) { adopt(result); $('history-items').replaceChildren(); cursor = null; $('more').hidden = true; }
    } catch (e) { if (valid(ticket, target)) status('조회 실패: ' + e.message); }
    finally { if (ticket === seq) { busy = false; controls(); } }
  }
  $('save').onclick = async () => {
    if (busy || !writable || !app.allowed() || ended) return;
    if (version && !$('reason').value.trim()) { status('수정·비우기 사유를 입력하세요.'); $('reason').focus(); return; }
    const ticket = ++seq, target = uid;
    const body = { baseVersion: version, text: $('text').value, reason: $('reason').value };
    busy = true; controls(); status('저장 중…');
    try {
      const result = await app.api('POST', '/studies/' + encodeURIComponent(target) + '/tech-note', body);
      if (valid(ticket, target)) {
        adopt(result); $('history-items').replaceChildren(); $('more').hidden = true; cursor = null;
        status('저장되었습니다. v' + version);
      }
    } catch (e) { if (valid(ticket, target)) status('저장 확인 실패: ' + e.message + ' · 입력은 유지했습니다. 최신 메모와 이력을 확인하세요.'); }
    finally { if (ticket === seq) { busy = false; controls(); } }
  };
  $('reload').onclick = () => {
    if (!busy && (!dirty() || confirm('입력 중인 메모를 버리고 최신 저장본을 읽을까요?'))) read();
  };
  async function history(more) {
    if (busy) return;
    const ticket = ++seq, target = uid; busy = true; controls(); status('이력을 불러오는 중…');
    try {
      const result = await app.api('GET', '/studies/' + encodeURIComponent(target) + '/tech-note/history' + (more && cursor ? '?before=' + cursor : ''));
      if (!valid(ticket, target)) return;
      if (result.uid !== target || !Array.isArray(result.items) || result.items.some(x => x.studyUid !== target)) throw new Error('이력 대상이 일치하지 않습니다');
      if (!more) $('history-items').replaceChildren();
      for (const item of result.items) {
        const entry = document.createElement('section'), title = document.createElement('h3'), text = document.createElement('pre');
        title.textContent = `v${item.version} · ${item.author} · ${new Date(item.createdAt).toLocaleString()}`;
        text.textContent = (item.text || '(메모 비움)') + '\n수정 사유: ' + (item.reason || '(최초 작성)');
        entry.append(title, text); $('history-items').append(entry);
      }
      cursor = result.nextBefore; $('more').hidden = !cursor;
      status(result.items.length ? '저장 이력입니다. 입력 중인 메모는 유지됩니다.' : '저장 이력이 없습니다.');
    } catch (e) { if (valid(ticket, target)) status('이력 조회 실패: ' + e.message); }
    finally { if (ticket === seq) { busy = false; controls(); } }
  }
  $('history').onclick = () => history(false); $('more').onclick = () => history(true);
  function close(force = false) {
    if (!force && (busy || dirty() && !confirm('저장하지 않은 메모 입력을 버리고 닫을까요?'))) return;
    ++seq; uid = null; busy = false; writable = false; saved = ''; version = 0;
    $('text').value = $('reason').value = ''; $('history-items').replaceChildren(); $('target').textContent = $('meta').textContent = ''; status('');
    if (d.open) d.close(); if (!force && opener?.isConnected) opener.focus();
  }
  $('close').onclick = () => close(); d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  function end() { ended = true; close(true); }
  let channel; try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
  window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') end(); });
  window.addEventListener('pagehide', () => { end(); channel?.close(); });
  window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
  window.addEventListener('beforeunload', e => { if (d.open && (busy || dirty())) { e.preventDefault(); e.returnValue = ''; } });
  return { open(study) {
    if (ended || d.open || !study || !app.allowed()) return;
    uid = study.uid; opener = document.activeElement; cursor = null; $('more').hidden = true;
    $('target').textContent = [study.name, study.id, study.date, study.desc, study.uid].filter(Boolean).join(' · ');
    writable = false; controls(); d.showModal(); read();
  } };
};
