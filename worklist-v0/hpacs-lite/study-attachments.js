/*
 * FC-076 Attach Document: attach scanned documents and PC pictures (JPG, PNG, PDF) to a study, see what is attached, and
 * withdraw a wrong one. Entry points: the Technician row menu (after Import DICOM), the Technician button bar (#t-attach,
 * after Import DICOM) and the end of the Radiology row menu. Choosing files opens the Attach Document dialog for the study
 * the choice started from; that study is fixed for the dialog, and an answer that comes back after the dialog moved on
 * (closed, another study, a new choice) is not drawn. A picture can be turned by 90° (Rotate) before it is sent: the page
 * redraws it and sends the turned picture as PNG. Each file is one request (POST /api/studies/:uid/attachments, the file's
 * bytes as the body) and gets its own result: Attached, or Failed with the server's reason.
 *
 * The server decides everything that matters (role, institution, the file's kind from its first bytes, the 20 MB limit);
 * the page only keeps its controls honest.
 *
 * Mounted by feature-mounts.js: KinStudyAttachments({ api, transport, allowed, can, demo, study, current, button }).
 */
window.KinStudyAttachments = function (app) {
  'use strict';
  const work = window.KinWorkContext;
  const MAX_BYTES = 20 * 1024 * 1024;
  const TYPES = Object.freeze({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' });
  const TEXT = Object.freeze({
    tooLarge: '파일이 20MB를 넘습니다',
    type: 'JPG·PNG·PDF 파일만 붙일 수 있습니다',
    lost: '서버의 답을 받지 못했습니다. 아래 목록에서 붙었는지 확인하세요',
    rotate: '그림을 돌리지 못했습니다',
    offline: '서버에 연결된 계정에서만 문서를 붙일 수 있습니다.',
    received: '원격판독으로 받은 검사에는 문서를 붙일 수 없습니다',
    noStudy: '문서를 붙일 검사를 먼저 고르세요.',
    reason: '사유가 필요합니다',
    listFailed: '붙은 문서 목록을 불러오지 못했습니다.',
    attachedHeading: '이 검사에 붙은 문서',
    none: '아직 붙은 문서가 없습니다.',
    reasonLabel: '철회 사유',
  });
  const STATE_NAMES = Object.freeze({ stored: 'Attached', withdrawn: 'Withdrawn', failed: 'Failed', pending: 'Pending' });

  const canAttach = () => !app.demo() && (app.can('technician') || app.can('radiologist') || app.can('admin'));
  let session = null;      // { uid, seq, entries, attached, canWithdraw } of the open dialog
  let seq = 0;             // every choice and every dialog gets a new number; late answers compare against it
  let pickFor = null;      // { uid, seq } of the file choice in progress

  // ── nodes ──
  const style = document.createElement('style');
  style.textContent = `
    #attach-document { min-width: 520px; max-width: 760px; color: #d7dce4; background: #1b2029; border: 1px solid #3a4356; border-radius: 6px; padding: 14px 16px; }
    #attach-document::backdrop { background: rgba(0, 0, 0, .45); }
    #attach-document h2 { font-size: 15px; margin: 0 0 6px; }
    #attach-document h3 { font-size: 12px; margin: 14px 0 6px; color: #aab2c0; }
    #attach-document ul { list-style: none; margin: 0; padding: 0; }
    #attach-document .attach-study { font-size: 12px; color: #aab2c0; margin: 0 0 10px; }
    #attach-document .attach-file, #attach-document .attach-done { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid #2c3444; font-size: 12px; }
    #attach-document .attach-thumb { width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; flex: none; background: #11151c; overflow: hidden; }
    #attach-document .attach-thumb img { max-width: 64px; max-height: 64px; transition: transform .1s; }
    #attach-document .attach-name { flex: 1; overflow-wrap: anywhere; }
    #attach-document .attach-result.failed { color: #ff8a80; }
    #attach-document .attach-result.ok { color: #8bd49c; }
    #attach-document button { background: #232936; border: 1px solid #3a4356; color: #d7dce4; padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    #attach-document button:disabled { opacity: .4; cursor: default; }
    #attach-document .attach-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
    #attach-document .attach-status { min-height: 1em; font-size: 12px; margin: 8px 0 0; }
    #attach-document .attach-withdraw-form { display: flex; gap: 6px; width: 100%; margin-top: 4px; }
    #attach-document .attach-withdraw-form input { flex: 1; }`;
  const dialog = node('dialog');
  dialog.id = 'attach-document';
  dialog.setAttribute('aria-labelledby', 'attach-document-title');
  const title = node('h2', null, 'Attach Document');
  title.id = 'attach-document-title';
  const head = node('p', 'attach-study');
  const fileList = node('ul', 'attach-files');
  const status = node('p', 'attach-status');
  status.setAttribute('role', 'status');
  status.lang = 'ko';
  const send = button('Attach 0 Files', () => attachAll());
  send.id = 'attach-send';
  const cancel = button('Cancel', () => close());
  cancel.id = 'attach-cancel';
  const actions = node('div', 'attach-actions');
  actions.append(send, cancel);
  const attachedHead = node('h3', null, TEXT.attachedHeading);
  attachedHead.lang = 'ko';
  const attachedList = node('ul', 'attach-attached');
  dialog.append(title, head, fileList, actions, status, attachedHead, attachedList);
  dialog.addEventListener('close', () => { if (session) end(); });
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  picker.accept = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';
  picker.id = 'attach-document-files';
  document.head.append(style);
  document.body.append(dialog, picker);
  picker.addEventListener('change', () => chosen());
  if (app.button) app.button.addEventListener('click', event => { event.preventDefault(); open(app.current()); });

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(label, onClick) {
    const el = node('button', null, label);
    el.type = 'button';
    el.addEventListener('click', event => { event.preventDefault(); onClick(); });
    return el;
  }
  function toast(text) { (window.toast || (() => {}))(text, 'err'); }

  /** The toolbar button follows the role; a click without a server, a selection or on a received study says why. */
  function sync() {
    if (app.button) app.button.hidden = !canAttach();
  }

  /** Start a file choice for `uid`: the dialog that follows belongs to this study and this choice only. */
  function open(uid) {
    if (!canAttach()) return;
    if (!app.allowed()) { toast(TEXT.offline); return; }
    if (!uid) { toast(TEXT.noStudy); return; }
    const row = app.study(uid);
    if (row?.tele) { toast(TEXT.received); return; }
    pickFor = { uid, seq: ++seq };
    picker.value = '';
    picker.click();
  }

  function typeOf(file) {
    const ext = String(file.name || '').toLowerCase().split('.').pop();
    return TYPES[ext] || (Object.values(TYPES).includes(file.type) ? file.type : null);
  }

  function chosen() {
    const target = pickFor;
    pickFor = null;
    const files = [...(picker.files || [])];
    picker.value = '';
    if (!target || target.seq !== seq || !files.length) return;
    if (session) end();
    session = { uid: target.uid, seq: target.seq, sending: false, canWithdraw: false,
      entries: files.map((file, index) => ({ index, file, type: typeOf(file), rotation: 0, state: 'ready', reason: '',
        requestId: crypto.randomUUID(), url: null })) };
    for (const entry of session.entries) if (entry.type && entry.type !== 'application/pdf') entry.url = URL.createObjectURL(entry.file);
    renderHead();
    render();
    attachedList.replaceChildren();
    status.textContent = '';
    if (!dialog.open) dialog.showModal();
    void loadAttached(session);
  }

  function renderHead() {
    const s = app.study(session.uid) || {};
    head.replaceChildren();
    const parts = [s.name, s.id, s.date, s.modality, s.desc].filter(v => v != null && String(v).trim() !== '');
    head.textContent = parts.join(' · ');
    head.dataset.uid = session.uid;
  }

  function pending() { return session ? session.entries.filter(e => e.state === 'ready' || e.state === 'failed') : []; }

  function render() {
    if (!session) return;
    fileList.replaceChildren();
    for (const entry of session.entries) {
      if (entry.state === 'removed') continue;
      const li = node('li', 'attach-file');
      li.dataset.index = String(entry.index);
      const thumb = node('span', 'attach-thumb');
      if (entry.url) {
        const img = node('img');
        img.alt = '';
        img.src = entry.url;
        img.style.transform = `rotate(${entry.rotation}deg)`;
        thumb.append(img);
      } else thumb.textContent = entry.type === 'application/pdf' ? 'PDF' : '—';
      const name = node('span', 'attach-name', entry.file.name);
      const size = node('span', 'attach-size', (entry.file.size / 1024 / 1024).toFixed(1) + ' MB');
      li.append(thumb, name, size);
      const idle = !session.sending && entry.state !== 'attached' && entry.state !== 'sending';
      if (entry.url) {
        const rotate = button('Rotate', () => { entry.rotation = (entry.rotation + 90) % 360; render(); });
        rotate.disabled = !idle;
        li.append(rotate);
      }
      const remove = button('Remove', () => { entry.state = 'removed'; if (entry.url) URL.revokeObjectURL(entry.url); render(); });
      remove.disabled = !idle;
      li.append(remove);
      const result = node('span', 'attach-result');
      result.lang = 'ko';
      if (entry.state === 'attached') { result.textContent = 'Attached'; result.classList.add('ok'); }
      else if (entry.state === 'failed') { result.textContent = 'Failed — ' + entry.reason; result.classList.add('failed'); }
      else if (entry.state === 'sending') result.textContent = 'Attaching…';
      li.append(result);
      fileList.append(li);
    }
    const n = pending().length;
    send.textContent = `Attach ${n} File${n === 1 ? '' : 's'}`;
    send.disabled = session.sending || n === 0 || !app.allowed();
  }

  /** A picture turned by `degrees`, redrawn by the browser and encoded as PNG. */
  async function turned(file, degrees) {
    const bitmap = await createImageBitmap(file);
    const across = degrees % 180 !== 0;
    const canvas = document.createElement('canvas');
    canvas.width = across ? bitmap.height : bitmap.width;
    canvas.height = across ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close?.();
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('png')), 'image/png'));
  }

  async function attachAll() {
    const mine = session;
    if (!mine || mine.sending || !app.allowed()) return;
    mine.sending = true;
    status.textContent = '';
    render();
    for (const entry of pending()) {
      if (session !== mine) return;
      await attachOne(mine, entry);
      if (session !== mine) return;
      render();
    }
    mine.sending = false;
    render();
    void loadAttached(mine);
  }

  async function attachOne(mine, entry) {
    if (!entry.type) { entry.state = 'failed'; entry.reason = TEXT.type; return; }
    let body = entry.file, type = entry.type, name = entry.file.name;
    if (entry.rotation) {
      try { body = await turned(entry.file, entry.rotation); }
      catch (_) { entry.state = 'failed'; entry.reason = TEXT.rotate; return; }
      type = 'image/png';
      name = name.replace(/\.(jpe?g|png)$/i, '') + '.png';
    }
    if (body.size > MAX_BYTES) { entry.state = 'failed'; entry.reason = TEXT.tooLarge; return; }
    entry.state = 'sending';
    render();
    const context = work.capture('document');
    let answer = null;
    try {
      answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(mine.uid) + '/attachments', {
        method: 'POST', body, context, deadlineMs: 120000,
        headers: { 'Content-Type': type, 'X-KIN-File-Name': encodeURIComponent(name), 'X-KIN-Request-Id': entry.requestId } });
    } catch (_) { answer = null; }
    // Drawn only for the dialog, study and choice this request left from, and while the session still admits it.
    if (session !== mine || mine.uid !== session.uid || mine.seq !== seq || !work.admits(context)) return;
    const said = typeof answer?.body?.message === 'string' ? answer.body.message : '';
    if (answer?.ok && !answer.incomplete && answer.body?.state === 'stored') { entry.state = 'attached'; entry.reason = ''; }
    else if (answer?.ok && !answer.incomplete && answer.body?.state === 'failed') {
      entry.state = 'failed'; entry.reason = answer.body.failReason || '문서가 저장되지 않았습니다';
      entry.requestId = crypto.randomUUID();
    } else if (answer && !answer.incomplete && answer.status >= 400 && answer.status < 500) {
      entry.state = 'failed'; entry.reason = said || `HTTP ${answer.status}`;
      entry.requestId = crypto.randomUUID();
    } else {
      // No answer, or the server could not confirm yet: the same request id is sent again on a retry (no second copy).
      entry.state = 'failed'; entry.reason = said && answer?.status === 503 ? said : TEXT.lost;
    }
  }

  async function loadAttached(mine) {
    const context = work.capture('document');
    let answer = null;
    try { answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(mine.uid) + '/attachments', { context }); }
    catch (_) { answer = null; }
    if (session !== mine || mine.seq !== seq || !work.admits(context)) return;
    if (!answer?.ok || answer.incomplete || !Array.isArray(answer.body?.attachments)) {
      attachedList.replaceChildren(node('li', 'attach-done', TEXT.listFailed));
      return;
    }
    mine.canWithdraw = !!answer.body.canWithdraw;
    renderAttached(mine, answer.body.attachments);
  }

  function when(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderAttached(mine, rows) {
    attachedList.replaceChildren();
    if (!rows.length) { const empty = node('li', 'attach-done', TEXT.none); empty.lang = 'ko'; attachedList.append(empty); return; }
    for (const row of rows) {
      const li = node('li', 'attach-done');
      li.dataset.id = row.id;
      li.dataset.state = row.state;
      li.append(node('span', 'attach-name', row.fileName), node('span', 'attach-kind', row.kind === 'pdf' ? 'PDF' : 'Image'),
        node('span', 'attach-by', row.createdBy || ''), node('span', 'attach-at', when(row.createdAt)),
        node('span', 'attach-state', row.state === 'stored' ? '' : STATE_NAMES[row.state] || row.state));
      if (row.state === 'withdrawn' && row.withdrawReason) {
        const why = node('span', 'attach-why', row.withdrawReason);
        why.lang = 'ko';
        li.append(why);
      }
      if (row.state === 'stored' && mine.canWithdraw) li.append(button('Withdraw', () => withdrawForm(mine, li, row)));
      attachedList.append(li);
    }
  }

  function withdrawForm(mine, li, row) {
    if (li.querySelector('.attach-withdraw-form')) return;
    const form = node('form', 'attach-withdraw-form');
    const input = node('input');
    input.type = 'text';
    input.maxLength = 500;
    input.setAttribute('aria-label', TEXT.reasonLabel);
    input.placeholder = TEXT.reasonLabel;
    const confirm = node('button', null, 'Withdraw');
    confirm.type = 'submit';
    const back = button('Cancel', () => form.remove());
    const note = node('span', 'attach-result failed');
    note.lang = 'ko';
    form.append(input, confirm, back, note);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const reason = input.value.trim();
      if (!reason) { note.textContent = TEXT.reason; input.focus(); return; }
      confirm.disabled = true;
      const context = work.capture('document');
      let answer = null;
      try {
        answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(mine.uid) + '/attachments/'
          + encodeURIComponent(row.id) + '/withdraw', { method: 'POST', json: { reason }, context });
      } catch (_) { answer = null; }
      if (session !== mine || mine.seq !== seq || !work.admits(context)) return;
      confirm.disabled = false;
      if (answer?.ok && !answer.incomplete) { void loadAttached(mine); return; }
      note.textContent = typeof answer?.body?.message === 'string' ? answer.body.message : TEXT.lost;
    });
    li.append(form);
    input.focus();
  }

  function end() {
    const ending = session;
    session = null;
    seq++;
    for (const entry of ending?.entries || []) if (entry.url) URL.revokeObjectURL(entry.url);
    fileList.replaceChildren();
    attachedList.replaceChildren();
    status.textContent = '';
  }

  function close() {
    if (dialog.open) dialog.close();
    if (session) end();
  }

  work.onInvalidate(event => {
    if (event.reason === 'lifecycle') {
      if (!['active', 'preparing'].includes(event.state)) close();
      sync();
    }
  });
  window.addEventListener('pagehide', close);
  sync();

  return Object.freeze({ canAttach, open, sync, close });
};
