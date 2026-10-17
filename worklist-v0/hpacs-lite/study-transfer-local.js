/*
 * S9-U4b part (c): Import DICOM, Download Originals and Resolve Unconfirmed (contract S9-U4p 4.4, 4.6, 4.8, 5.3, 6).
 *
 * One non-modal panel for the person's own transfers. The server decides every result: this file never parses DICOM,
 * never re-decides an HTTP status, an outcome or whether a result is final, and shows the server's Korean message for
 * each code. What it decides is only the sending: one object per request, one import request in flight, the same
 * operation id, index and bytes for a retry, and never a resend of a file whose result is final or unconfirmed.
 *
 * Every answer is applied through the work-context gate (work.commit) with the context its request left with, and only
 * while the panel still holds that operation in the same generation: a logout, an account change, a cancelled logout
 * preparation or a cleared panel leaves a late answer unwritten. The panel never opens a dialog, never moves focus and
 * never touches the viewer or the report editor.
 *
 * Mounted by feature-mounts.js: KinStudyTransferLocal({ api, transport, allowed, identity, can, demo, study }).
 */
window.KinStudyTransferLocal = function (app) {
  'use strict';
  const work = window.KinWorkContext;
  const root = document.getElementById('study-transfer');
  const toolbarButton = document.getElementById('t-import');

  // Contract limits (4, 4.4): 100 files per selection, 24 MiB per object, one request in flight.
  const MAX_FILES = 100;
  const MAX_BYTES = 25165824;
  // The server's own answer can take up to its 240 s reading of an existing study (4.4) behind nginx's 300 s; a shorter
  // limit here would only turn a result that is still coming into an unknown one.
  const IMPORT_DEADLINE_MS = 300000;
  // A file the server left Unconfirmed is read again once its attempt's 30 s lease has run out (4.4): only then does the
  // status GET reconcile it, so an earlier read would not be a re-check.
  const RECHECK_AFTER_MS = 35000;
  const DOWNLOAD_POLL_MS = 3000;
  const DOWNLOAD_START_POLLS = 10;
  // The page goes online (bootstrap) after the identity is known; operations kept for this tab are read only then.
  const ONLINE_WAIT_MS = 1000;
  const ONLINE_WAITS = 120;
  const STORE_KEY = 'kin-study-transfer-local';
  const STORE_OPERATIONS = 20;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // API token -> screen name (4.6, 5.3). Names are English, descriptions Korean (AGENTS 4).
  const OUTCOME_NAMES = Object.freeze({ stored: 'Stored', 'already-present': 'Already Present', rejected: 'Rejected',
    retryable: 'Retry Needed', unconfirmed: 'Unconfirmed' });
  const DOWNLOAD_NAMES = Object.freeze({ prepared: 'Ready', sending: 'Downloading', sent: 'Sent', incomplete: 'Incomplete',
    unconfirmed: 'Unconfirmed' });
  const FINAL = new Set(['stored', 'already-present', 'rejected']);
  const RESTARTABLE = ['prepared', 'incomplete', 'unconfirmed'];
  const BASES = Object.freeze([
    ['orthanc-restarted', '이 시도 뒤 Orthanc가 다시 시작된 것을 확인했습니다'],
    ['orthanc-log-checked', 'Orthanc 기록에서 이 시도가 저장되지 않은 것을 확인했습니다'],
  ]);
  const TEXT = Object.freeze({
    tooMany: n => `한 번에 100개 파일까지 반입할 수 있습니다. 고른 ${n}개 파일은 보내지 않았습니다. 나눠서 다시 고르세요.`,
    tooLarge: '한 파일은 24 MiB(25,165,824 bytes)까지 반입할 수 있습니다. 이 파일은 저장되지 않았습니다.',
    // 4.6: a write that may have happened is never described as not stored, after an admin recovery too.
    mayHaveWritten: '저장된 원본과 충돌하여 완료를 확인할 수 없습니다.',
    askAdmin: (id, index) => `저장 결과를 확인하지 못했습니다. 관리자에게 작업 번호 ${id.slice(0, 8)}·파일 번호 ${index}의 확인을 요청하세요.`,
    lost: '서버의 답을 받지 못했습니다. 이 작업의 상태를 다시 읽어 확인합니다.',
    notReached: '이 파일은 서버에 닿지 않았습니다. Retry로 같은 파일을 다시 보낼 수 있습니다.',
    unread: '작업 상태를 읽지 못했습니다. Check Again으로 다시 확인하세요.',
    paused: '지금은 요청을 보낼 수 없어 이 파일을 보내지 않았습니다. Retry로 이어서 보낼 수 있습니다.',
    offline: '서버에 연결된 계정에서만 반입·원본 다운로드를 쓸 수 있습니다.',
    sending: (done, n) => `파일을 보내는 중입니다 (${done}/${n}).`,
    summary: (kept, attention) => `반입 결과: 저장 확인 ${kept}개` + (attention ? `, 확인이 필요한 파일 ${attention}개` : '') + '.',
    sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',
    ready: (n, size) => `검사 원본 ${n}개(${size})를 내려받을 준비가 되었습니다.`,
    downloading: (done, n) => `서버가 원본을 보내는 중입니다 (${done}/${n}).`,
    incomplete: '내려받기가 끝까지 이어지지 않았습니다. 같은 작업으로 다시 받을 수 있습니다.',
    downloadUnconfirmed: '서버가 다시 시작되는 등으로 보낸 결과를 확인하지 못했습니다. 같은 작업으로 다시 받을 수 있습니다.',
    notStarted: '내려받기가 시작되지 않았습니다. 브라우저의 다운로드 목록을 확인한 뒤 다시 시도하세요.',
    preparing: '원본 목록을 준비하는 중입니다…',
    granting: '내려받기를 시작하는 중입니다…',
    copied: '작업 번호와 파일 번호를 복사했습니다.',
    copyFailed: (id, index) => `복사하지 못했습니다. 작업 번호 ${id} · 파일 번호 ${index}`,
    resolveInput: '작업 번호(UUID), 파일 번호(0~99), 확인 근거와 확인 시각을 적으세요.',
    resolving: '관리자 확인을 요청하는 중입니다…',
    httpFailure: status => `요청이 거절되었습니다 (HTTP ${status}).`,
  });

  // ── panel state ──
  let generation = 0;          // a cleared operation or an ended session leaves the late answers of the old one unwritten
  let ended = false;
  let restored = false;
  let onlineWaits = 0;
  let owner = null;            // [institution, sub] of the identity whose operations the panel holds
  const operations = [];       // import and download operations, newest first
  const queue = [];            // import file entries waiting to be sent, in order
  let running = false;         // the one upload loop
  // Every import request (an upload or a status read) runs in this one lane, so exactly one is in flight (4).
  let lane = Promise.resolve();
  const timers = new Set();

  // ── the panel's own nodes (the container is main.html's) ──
  const header = node('div', 'study-transfer-head');
  const resolveOpen = button('Resolve Unconfirmed', () => toggleResolve());
  const clear = button('Clear Finished', () => clearFinished());
  const hide = button('Hide', () => { body.hidden = !body.hidden; hide.textContent = body.hidden ? 'Show' : 'Hide'; });
  const close = button('Close', () => closePanel());
  header.append(node('b', null, 'DICOM Transfer'), resolveOpen, clear, hide, close);
  const body = node('div', 'study-transfer-body');
  const list = node('div', 'study-transfer-list');
  const resolveForm = node('form', 'study-transfer-resolve');
  const status = node('p', 'study-transfer-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.lang = 'ko';
  body.append(resolveForm, list);
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  if (root) root.append(header, body, status, picker);
  let pickFor = null;          // what the next file choice is for: { expect } or { operation } (Choose Files Again)
  buildResolveForm();

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
  function later(fn, ms) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  }
  function inLane(task) {
    const run = lane.then(task, task);
    lane = run.then(() => undefined, () => undefined);
    return run;
  }

  // ── roles and identity (the server's checks are the authority; this only keeps the controls honest) ──
  const usable = () => !ended && work.state() === 'active' && app.allowed();
  const canImport = () => !app.demo() && app.can('technician');
  const canDownload = () => !app.demo() && (app.can('radiologist') || app.can('technician'));
  const isAdmin = () => !app.demo() && app.can('admin');
  const live = op => !ended && op.gen === generation && operations.includes(op);

  /** The identity or the page's state may have changed: the role controls, and once the operations kept for this tab. */
  function sync() {
    if (toolbarButton) toolbarButton.hidden = ended || !canImport();
    resolveOpen.hidden = !isAdmin();
    if (!isAdmin()) resolveForm.hidden = true;
    const identity = app.identity();
    if (ended || !identity || work.state() !== 'active') return;
    if (owner && JSON.stringify(owner) !== JSON.stringify(identity)) { end(); return; }
    owner = owner || identity;
    if (restored) return;
    if (app.allowed()) { restored = true; restore(); }
    else if (onlineWaits++ < ONLINE_WAITS) later(sync, ONLINE_WAIT_MS);
  }

  /** The session ended, the account changed or the page is leaving: nothing of the panel survives into another one. */
  function end() {
    ended = true;
    generation++;
    queue.length = 0;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    operations.length = 0;
    owner = null;
    list.replaceChildren();
    status.textContent = '';
    resolveForm.hidden = true;
    if (root) root.hidden = true;
    if (toolbarButton) toolbarButton.hidden = true;
  }

  work.onInvalidate(event => {
    if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) { end(); return; }
    if (event.reason === 'lifecycle') { sync(); return; }
    // Back from a logout preparation: an answer that left before it is no longer applied (a new work epoch), so what
    // was in flight or answered meanwhile is read again from the server instead of being guessed.
    if (event.reason === 'cancel' && !ended) {
      for (const op of operations) if (op.lost) { op.lost = false; if (op.kind === 'import') readImport(op); else readDownload(op); }
      if (!running && queue.length) pump();
    }
  });
  window.addEventListener('pagehide', () => { ended = true; generation++; });

  /**
   * An answer that came back when its context no longer admitted it (a logout preparation or its cancellation): its
   * content is not used. The panel only notes that the request has ended, and reads the server again when it may.
   */
  function lostAnswer(op, entry) {
    op.inFlight = false;
    if (!live(op)) return;
    if (entry && entry.state === 'sending') { entry.state = 'unknown'; entry.message = TEXT.lost; }
    if (usable()) { if (op.kind === 'import') readImport(op); else readDownload(op); } else op.lost = true;
  }

  // ── what is kept for this tab (4.6: the bytes never are; a re-login of the same person reads its operations again) ──
  function store() {
    try {
      if (!owner) return;
      const kept = operations.slice(0, STORE_OPERATIONS).map(op => op.kind === 'import'
        ? { kind: 'import', id: op.id, expect: op.expect, files: op.files.map(f => ({ index: f.index, name: f.name, size: f.size })) }
        : { kind: 'download', id: op.id, uid: op.uid });
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, owner, operations: kept }));
    } catch (_) { /* nothing is kept; the panel still works for this page */ }
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (_) { saved = null; }
    // Another person's operations are never read, shown or resumed, whatever their display name (REQ-S9-U4-10).
    if (!saved || saved.v !== 1 || JSON.stringify(saved.owner) !== JSON.stringify(owner) || !Array.isArray(saved.operations)) {
      try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
      return;
    }
    for (const kept of saved.operations.slice(0, STORE_OPERATIONS).reverse()) {
      if (!kept || !UUID.test(String(kept.id))) continue;
      if (kept.kind === 'import' && Array.isArray(kept.files)) {
        const op = importOperation(String(kept.id), typeof kept.expect === 'string' ? kept.expect : null);
        for (const f of kept.files.slice(0, MAX_FILES))
          if (Number.isInteger(f?.index) && f.index >= 0 && f.index < MAX_FILES)
            op.files.push(fileEntry(op, f.index, null, String(f.name ?? ''), Number(f.size) || 0, 'unknown'));
        operations.unshift(op);
      } else if (kept.kind === 'download' && typeof kept.uid === 'string') {
        operations.unshift(downloadOperation(String(kept.id), kept.uid));
      }
    }
    if (!operations.length) return;
    openPanel();
    for (const op of operations) if (op.kind === 'import') readImport(op); else readDownload(op);
    render();
  }

  // ── the panel ──
  function openPanel() {
    if (!root || ended) return;
    root.hidden = false;
    body.hidden = false;
    hide.textContent = 'Hide';
  }
  function closePanel() {
    // While files are still going out the panel only folds: its results must stay reachable.
    if (running || operations.some(op => op.inFlight)) { body.hidden = true; hide.textContent = 'Show'; return; }
    if (root) root.hidden = true;
  }
  function clearFinished() {
    for (let i = operations.length - 1; i >= 0; i--) if (finished(operations[i])) { operations[i].gen = -1; operations.splice(i, 1); }
    store();
    render();
  }
  function finished(op) {
    if (op.inFlight || op.polling) return false;
    if (op.kind === 'download') return ['sent', 'incomplete', 'unconfirmed'].includes(op.state) || (!op.state && !!op.notice);
    return op.files.every(f => f.final);
  }

  // ── Import DICOM (4, 4.4, 4.6, 6) ──
  function importOperation(id, expect) {
    return { kind: 'import', id, expect, files: [], gen: generation, readSeq: 0, inFlight: false, lost: false, notice: '',
      recheckPending: false, label: studyLabel(expect) };
  }
  function fileEntry(op, index, file, name, size, state) {
    return { op, index, file, name, size, state, final: false, outcome: null, code: null, message: '', identity: null,
      writeDisposition: null, rechecked: false, autoRechecked: false };
  }
  function studyLabel(uid) {
    if (!uid) return null;
    const s = app.study(uid);
    return s ? [s.name, s.id, s.date, s.desc].filter(Boolean).join(' · ') : uid;
  }

  /** The toolbar's Import DICOM (a new study, or files of several studies) and the Technician row's (that study). */
  function choose(expect) {
    sync();
    if (!canImport()) return;
    openPanel();
    if (!usable()) { status.textContent = TEXT.offline; return; }
    pickFor = { expect };
    picker.value = '';
    picker.click();
  }
  function chooseAgain(op) {
    if (!canImport() || !usable() || !live(op)) return;
    pickFor = { operation: op };
    picker.value = '';
    picker.click();
  }
  picker.addEventListener('change', () => {
    const files = [...(picker.files || [])], target = pickFor;
    pickFor = null;
    picker.value = '';
    if (!files.length || !target || !usable()) return;
    // 4: more than 100 files is refused before any request; nothing of the selection is sent.
    if (files.length > MAX_FILES) { status.textContent = TEXT.tooMany(files.length); return; }
    if (target.operation) { reattach(target.operation, files); return; }
    // One operation id per selection; each file keeps its index for every retry (4.4).
    const op = importOperation(crypto.randomUUID(), target.expect ?? null);
    files.forEach((file, index) => {
      const entry = fileEntry(op, index, file, file.name, file.size, 'waiting');
      if (file.size > MAX_BYTES) { entry.state = 'refused'; entry.final = true; entry.message = TEXT.tooLarge; entry.file = null; }
      op.files.push(entry);
    });
    operations.unshift(op);
    store();
    for (const entry of op.files) if (entry.state === 'waiting') queue.push(entry);
    render();
    pump();
  });

  /** Choose Files Again for an operation read back after a re-login: the same index and operation id (by name and size). */
  function reattach(op, files) {
    if (!live(op)) return;
    for (const entry of op.files) {
      if (entry.file || !sendable(entry)) continue;
      const match = files.find(f => f.name === entry.name && f.size === entry.size);
      if (match) { entry.file = match; entry.state = 'waiting'; queue.push(entry); }
    }
    render();
    pump();
  }

  /**
   * A file may go again only while its last answer says it was not stored and may be retried: never after a final result
   * (stored, already present, rejected), never while Unconfirmed (only reads change that, 4.4), never twice at once.
   */
  function sendable(entry) {
    if (entry.final) return false;
    if (entry.state === 'result') return entry.outcome === 'retryable';
    return entry.state === 'notSent' || entry.state === 'refused';
  }
  function retry(entry) {
    if (!live(entry.op) || !entry.file || !sendable(entry) || queue.includes(entry)) return;
    entry.state = 'waiting';
    queue.push(entry);
    render();
    pump();
  }

  /** The one upload loop: one object per request, one request at a time (4). */
  async function pump() {
    if (running) return;
    running = true;
    render();
    try {
      while (queue.length && usable()) {
        const entry = queue.shift();
        if (!live(entry.op) || !entry.file || entry.state !== 'waiting') continue;
        if (await inLane(() => send(entry)) === 'stop') break;
      }
    } finally {
      running = false;
      // Files a stop left waiting go back to the person (Retry), never out by themselves.
      for (const entry of queue.splice(0)) if (entry.state === 'waiting') { entry.state = 'notSent'; entry.message = TEXT.paused; }
      summarise();
      render();
    }
  }

  /** One file: POST /api/dicom-import with its operation id, its index and (from a row) the expected study. */
  async function send(entry) {
    const op = entry.op;
    if (!live(op) || !usable()) return 'stop';
    const gen = op.gen, at = work.capture('document');
    entry.state = 'sending';
    op.inFlight = true;
    render();
    const headers = { 'Content-Type': 'application/dicom', 'X-KIN-Operation-Id': op.id, 'X-KIN-File-Index': String(entry.index) };
    if (op.expect) headers['X-KIN-Expect-Study'] = op.expect;
    let answer = null, failure = null;
    try {
      answer = await app.transport.request(app.api + '/dicom-import', { method: 'POST', body: entry.file, headers, context: at,
        deadlineMs: IMPORT_DEADLINE_MS });
    } catch (error) { failure = error; }
    let go = 'next';
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) { go = 'stop'; return; }
      op.inFlight = false;
      if (failure) {
        if (failure.sent === false) {
          // It never left the browser (a logout preparation began, no session binding): it waits for Retry.
          entry.state = 'notSent';
          entry.message = TEXT.paused;
          go = 'stop';
        } else {
          // It left and its answer was lost (time limit, dropped connection): the server may hold a result, so the file
          // is read back, never sent again on a guess. An ordinary network error never ends the session.
          entry.state = 'unknown';
          entry.message = TEXT.lost;
          readImport(op);
        }
      } else if (answer.auth) {
        // The server said this session ended; the page closes it (auth.js). Nothing more goes out.
        entry.state = 'notSent';
        entry.message = '';
        go = 'stop';
      } else {
        const result = answer.body;
        if (result && typeof result === 'object' && result.operationId === op.id && result.index === entry.index && OUTCOME_NAMES[result.outcome]) {
          adopt(entry, result);
          if (entry.outcome === 'unconfirmed') scheduleRecheck(op);
        } else {
          // A request-level refusal (4.8): no file result was made, so it is shown once for this request, not as an outcome.
          entry.state = 'refused';
          entry.code = typeof result?.code === 'string' ? result.code : null;
          entry.message = typeof result?.message === 'string' && result.message ? result.message : TEXT.httpFailure(answer.status);
          // The account cannot import now or the import is not ready: the remaining files would be refused alike.
          if ([401, 403, 503].includes(answer.status) || entry.code === 'OPERATION_CONFLICT') go = 'stop';
        }
      }
      store();
      render();
    });
    if (!applied) { lostAnswer(op, entry); return 'stop'; }
    return go;
  }

  /** A file result from the server (a POST answer or the status GET), as the panel shows it. */
  function adopt(entry, result) {
    entry.state = 'result';
    entry.outcome = result.outcome;
    entry.code = result.code ?? null;
    entry.identity = result.identity ?? null;
    entry.writeDisposition = result.writeDisposition ?? null;
    entry.message = typeof result.message === 'string' ? result.message : '';
    const attempts = Array.isArray(result.attempts) ? result.attempts : [];
    entry.autoRechecked = !!attempts.length && !!attempts[attempts.length - 1]?.autoRecheckedAt;
    entry.final = FINAL.has(entry.outcome);
  }

  function scheduleRecheck(op) {
    if (op.recheckPending) return;
    op.recheckPending = true;
    later(() => { op.recheckPending = false; if (live(op)) readImport(op, true); }, RECHECK_AFTER_MS);
  }

  /** GET /api/dicom-import/:operationId in the import lane: the server reconciles what it can; the panel shows the answer. */
  function readImport(op, recheck = false) {
    if (!live(op)) return Promise.resolve();
    const seq = ++op.readSeq;
    return inLane(() => readImportNow(op, recheck, seq));
  }
  async function readImportNow(op, recheck, seq) {
    if (!live(op) || op.readSeq !== seq) return;
    if (!usable()) { op.lost = true; return; }
    const gen = op.gen, at = work.capture('document');
    for (const entry of op.files) if (entry.state === 'unknown') entry.state = 'checking';
    op.inFlight = true;
    render();
    let answer = null, failed = false;
    try {
      answer = await app.transport.request(app.api + '/dicom-import/' + encodeURIComponent(op.id), { context: at });
    } catch (_) { failed = true; }
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      // 404 is the server's answer for an operation it does not hold for this person (none of its files reached it);
      // anything else that is not a status leaves the panel's knowledge as it was.
      const files = !failed && answer.ok && answer.body?.operationId === op.id && Array.isArray(answer.body.files) ? answer.body.files
        : !failed && answer.status === 404 ? [] : null;
      if (!files) {
        op.notice = !failed && !answer.ok && answer.body?.message ? answer.body.message : TEXT.unread;
        for (const entry of op.files) if (entry.state === 'checking') entry.state = 'unknown';
        render();
        return;
      }
      op.notice = '';
      const byIndex = new Map(files.map(f => [f.index, f]));
      for (const entry of op.files) {
        if (entry.state === 'sending' || entry.state === 'waiting') continue;
        const found = byIndex.get(entry.index);
        if (found && OUTCOME_NAMES[found.outcome]) {
          adopt(entry, found);
          if (entry.outcome !== 'unconfirmed') continue;
          if (recheck) entry.rechecked = true;
          else scheduleRecheck(op);
        } else if (entry.state === 'checking') {
          // The server has no result for it: that request never reached the server, so the same file may go again.
          entry.state = 'notSent';
          entry.message = TEXT.notReached;
        }
      }
      store();
      render();
    });
    if (!applied) lostAnswer(op, null);
  }

  function copyId(entry) {
    const text = `${entry.op.id} ${entry.index}`, at = work.capture('document');
    const done = ok => work.commit(at, () => { status.textContent = ok ? TEXT.copied : TEXT.copyFailed(entry.op.id, entry.index); });
    try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch (_) { done(false); }
  }

  function summarise() {
    let kept = 0, attention = 0;
    for (const op of operations) if (op.kind === 'import') for (const f of op.files) {
      if (f.state === 'result' && (f.outcome === 'stored' || f.outcome === 'already-present')) kept++;
      else attention++;
    }
    if (kept || attention) status.textContent = TEXT.summary(kept, attention);
  }

  // ── Download Originals (5.2, 5.3, 6) ──
  function downloadOperation(id, uid) {
    return { kind: 'download', id, uid, state: null, objects: 0, bytes: 0, done: 0, notice: '', gen: generation, readSeq: 0,
      inFlight: false, lost: false, polling: false, polls: 0, startedFrom: null, label: studyLabel(uid) };
  }

  /** The row's Download Originals: a new operation is prepared for that study's fixed manifest (5.2 steps 1-2). */
  async function download(uid) {
    sync();
    if (!canDownload()) return;
    openPanel();
    if (!usable()) { status.textContent = TEXT.offline; return; }
    const op = downloadOperation(crypto.randomUUID(), uid);
    operations.unshift(op);
    store();
    const gen = op.gen, at = work.capture('document');
    op.inFlight = true;
    op.notice = TEXT.preparing;
    render();
    let answer = null, failed = false;
    try {
      answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(uid) + '/original-downloads',
        { method: 'POST', json: { operationId: op.id }, context: at });
    } catch (_) { failed = true; }
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      // The same id may be prepared again safely (it replays): a lost answer is read back, never prepared anew.
      if (failed) { op.notice = TEXT.lost; readDownload(op); }
      else if (answer.ok && answer.body?.operationId === op.id && DOWNLOAD_NAMES[answer.body.state]) { adoptDownload(op, answer.body); op.notice = ''; }
      else op.notice = answer.body?.message || TEXT.httpFailure(answer.status);
      store();
      render();
    });
    if (!applied) lostAnswer(op, null);
  }

  function adoptDownload(op, view) {
    op.state = view.state;
    op.objects = Number(view.objects) || 0;
    op.bytes = Number(view.bytes) || 0;
    const attempts = Array.isArray(view.attempts) ? view.attempts : [];
    op.done = attempts.length ? Number(attempts[attempts.length - 1].objectsComplete) || 0 : 0;
  }

  /**
   * The archive, as the browser's own download of the server's stream (5.1): never read into this page (an archive may
   * approach 4 GiB). Offered for the same operation only while it is Ready, Incomplete or Unconfirmed (5.3); after Sent
   * a new operation is prepared instead. No Range, no resume.
   *
   * The browser's own GET cannot carry the session binding header, so one Download press first asks, as an ordinary
   * bound request, for a one-time grant of this operation (D1489), and only then clicks one hidden link with it. The
   * grant lives in this function's memory and the link alone, never in the page's record, its storage or on screen.
   * Its answer is used only if the panel, the operation, this read's sequence, the work context and the signed-in person
   * are all still the ones that asked; else no link is clicked. A refusal is a notice, and the status read tells the rest.
   */
  async function start(op) {
    if (!live(op) || !usable() || op.polling || op.inFlight || !RESTARTABLE.includes(op.state)) return;
    const gen = op.gen, seq = ++op.readSeq, at = work.capture('document'), who = JSON.stringify(app.identity());
    const base = app.api + '/studies/' + encodeURIComponent(op.uid) + '/original-downloads/' + encodeURIComponent(op.id) + '/archive';
    op.inFlight = true;
    op.notice = TEXT.granting;
    render();
    let answer = null, failed = false;
    try {
      answer = await app.transport.request(base + '/grant', { method: 'POST', json: {}, context: at });
    } catch (_) { failed = true; }
    let grant = !failed && answer.ok && answer.body?.operationId === op.id && typeof answer.body.grant === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(answer.body.grant) ? answer.body.grant : null;
    if (answer?.body && typeof answer.body === 'object') delete answer.body.grant;
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      if (op.readSeq !== seq || !usable() || JSON.stringify(app.identity()) !== who) { render(); return; }
      if (!grant) {
        // A lost answer or a refusal starts nothing: the operation's state is read again, and Download asks anew.
        op.notice = failed ? TEXT.lost : answer.body?.message || TEXT.httpFailure(answer.status);
        render();
        readDownload(op);
        return;
      }
      const link = document.createElement('a');
      link.href = base + '?grant=' + encodeURIComponent(grant);
      grant = null;
      // The download attribute keeps an answer that is not a file from replacing this page and the reading work on it.
      link.download = '';
      link.referrerPolicy = 'no-referrer';
      link.rel = 'noreferrer';
      link.hidden = true;
      root.append(link);
      link.click();
      link.remove();
      link.removeAttribute('href');
      op.notice = '';
      op.startedFrom = op.state;
      op.polls = 0;
      poll(op);
    });
    grant = null;
    if (!applied) lostAnswer(op, null);
  }

  function poll(op) {
    if (op.polling) return;
    op.polling = true;
    render();
    later(() => readDownload(op, true), DOWNLOAD_POLL_MS);
  }

  /** GET .../original-downloads/:operationId: the state the server recorded. Sent is not a saved file (5.3). */
  async function readDownload(op, polled = false) {
    if (!live(op)) return;
    if (!usable()) { op.polling = false; op.lost = true; return; }
    const gen = op.gen, seq = ++op.readSeq, at = work.capture('document');
    let answer = null, failed = false;
    try {
      answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(op.uid) + '/original-downloads/'
        + encodeURIComponent(op.id), { context: at });
    } catch (_) { failed = true; }
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen || op.readSeq !== seq) return;
      if (failed || !answer.ok || answer.body?.operationId !== op.id || !DOWNLOAD_NAMES[answer.body.state]) {
        op.notice = !failed && !answer.ok && answer.body?.message ? answer.body.message : TEXT.unread;
        op.polling = false;
        render();
        return;
      }
      adoptDownload(op, answer.body);
      // The browser's own GET answers this page nothing: a refused or expired grant is known from the status (D1489).
      const request = answer.body.archiveRequest;
      const unstarted = request && (request.state === 'refused' || request.state === 'expired') && RESTARTABLE.includes(op.state);
      op.notice = unstarted && typeof request.message === 'string' ? request.message : '';
      if (polled && op.polling) {
        op.polls++;
        const waiting = op.state === op.startedFrom;
        if (op.state === 'sending' || (waiting && !unstarted && op.polls < DOWNLOAD_START_POLLS)) later(() => readDownload(op, true), DOWNLOAD_POLL_MS);
        else { op.polling = false; if (waiting && !unstarted) op.notice = TEXT.notStarted; }
      } else if (op.state === 'sending' && !op.polling) {
        op.startedFrom = null;
        poll(op);
      }
      store();
      render();
    });
    if (!applied) { op.polling = false; lostAnswer(op, null); }
  }

  // ── Resolve Unconfirmed (own-institution admin only, 4.4) ──
  function buildResolveForm() {
    resolveForm.hidden = true;
    resolveForm.noValidate = true;
    const field = (label, input) => { const l = node('label', null, label + ' '); l.append(input); return l; };
    const opInput = node('input'); opInput.name = 'operationId'; opInput.autocomplete = 'off'; opInput.spellcheck = false;
    const indexInput = node('input'); indexInput.name = 'index'; indexInput.type = 'number'; indexInput.min = '0'; indexInput.max = '99';
    const basis = node('select'); basis.name = 'basis';
    for (const [value, text] of BASES) { const o = node('option', null, text); o.value = value; basis.append(o); }
    const checked = node('input'); checked.name = 'checkedAt'; checked.type = 'datetime-local'; checked.step = '1';
    const submit = node('button', null, 'Resolve'); submit.type = 'submit';
    const result = node('p', 'study-transfer-resolve-result'); result.lang = 'ko'; result.setAttribute('role', 'status');
    // A pasted Copy ID (the operation id and the file number) fills both fields.
    opInput.addEventListener('input', () => {
      const m = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\d{1,2})\s*$/i.exec(opInput.value);
      if (m) { opInput.value = m[1]; indexInput.value = m[2]; }
    });
    resolveForm.append(node('b', null, 'Resolve Unconfirmed'), field('Operation ID', opInput), field('File Number', indexInput),
      field('Basis', basis), field('Checked At', checked), submit, result);
    let busy = false;
    resolveForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !isAdmin() || !usable()) return;
      const id = opInput.value.trim().toLowerCase(), index = indexInput.value.trim();
      // The local time the admin read is sent as the UTC instant it names (the route's closed form, 4.4).
      const when = checked.value ? new Date(checked.value) : null;
      if (!UUID.test(id) || !/^(0|[1-9][0-9]?)$/.test(index) || !when || Number.isNaN(when.getTime())) { result.textContent = TEXT.resolveInput; return; }
      const gen = generation, at = work.capture('document');
      busy = true;
      submit.disabled = true;
      result.textContent = TEXT.resolving;
      let answer = null, failed = false;
      try {
        answer = await app.transport.request(app.api + '/admin/dicom-import/' + encodeURIComponent(id) + '/files/' + index + '/recovery',
          { method: 'POST', json: { basis: basis.value, checkedAt: when.toISOString() }, context: at });
      } catch (_) { failed = true; }
      const applied = work.commit(at, () => {
        busy = false;
        submit.disabled = false;
        if (ended || gen !== generation) return;
        if (failed) { result.textContent = TEXT.lost; return; }
        const value = answer.body;
        if (answer.ok && value && OUTCOME_NAMES[value.outcome]) {
          result.textContent = OUTCOME_NAMES[value.outcome] + ' — ' + (value.message || '');
          const op = operations.find(o => o.kind === 'import' && o.id === value.operationId);
          if (op) readImport(op);
        } else result.textContent = value?.message || TEXT.httpFailure(answer.status);
      });
      if (!applied) { busy = false; submit.disabled = false; }
    });
  }
  function toggleResolve() {
    if (!isAdmin()) return;
    openPanel();
    resolveForm.hidden = !resolveForm.hidden;
  }

  // ── drawing (textContent only: file names, messages and study labels are data) ──
  function render() {
    if (!root || ended) return;
    resolveOpen.hidden = !isAdmin();
    clear.disabled = !operations.some(finished);
    list.replaceChildren(...operations.map(op => op.kind === 'import' ? drawImport(op) : drawDownload(op)));
    if (running) {
      const all = operations.filter(op => op.kind === 'import').flatMap(op => op.files);
      status.textContent = TEXT.sending(all.filter(f => f.state === 'result' || f.state === 'refused').length, all.length);
    }
  }

  function drawImport(op) {
    const box = node('section', 'study-transfer-op');
    box.dataset.operation = op.id;
    const head = node('div', 'study-transfer-op-head');
    head.append(node('b', null, 'Import DICOM'), node('span', null, ' · ' + op.id.slice(0, 8) + (op.label ? ' · ' + op.label : '')));
    if (op.files.some(f => !f.file && sendable(f))) head.append(button('Choose Files Again', () => chooseAgain(op)));
    if (op.files.filter(f => f.file && sendable(f)).length > 1) head.append(button('Retry All', () => op.files.forEach(retry)));
    if (op.files.some(f => f.state === 'unknown' || (f.state === 'result' && f.outcome === 'unconfirmed')))
      head.append(button('Check Again', () => readImport(op, op.files.some(f => f.outcome === 'unconfirmed'))));
    box.append(head);
    if (op.notice) box.append(node('p', 'study-transfer-note', op.notice));
    const rows = node('ol', 'study-transfer-files');
    for (const f of op.files) {
      const li = node('li', 'study-transfer-file');
      li.dataset.index = String(f.index);
      li.append(node('span', 'study-transfer-name', f.name || `#${f.index}`), node('span', 'study-transfer-state', stateName(f)));
      if (f.state === 'result' && f.identity === 'not_comparable') li.append(node('span', 'study-transfer-mark', 'Unverified'));
      const text = describe(f);
      if (text) li.append(node('span', 'study-transfer-reason', text));
      if (f.state === 'result' && f.outcome === 'unconfirmed' && (f.rechecked || f.autoRechecked)) li.append(button('Copy ID', () => copyId(f)));
      if (f.file && sendable(f)) li.append(button('Retry', () => retry(f)));
      rows.append(li);
    }
    box.append(rows);
    return box;
  }
  function stateName(f) {
    if (f.state === 'result') return OUTCOME_NAMES[f.outcome];
    return { waiting: 'Waiting', sending: 'Sending', checking: 'Checking', unknown: 'Checking', notSent: 'Not Sent', refused: 'Not Sent' }[f.state] || '';
  }
  function describe(f) {
    if (f.state !== 'result') return f.message;
    if (f.outcome === 'rejected' && f.writeDisposition === 'may-have-written') return TEXT.mayHaveWritten;
    if (f.outcome === 'unconfirmed' && (f.rechecked || f.autoRechecked)) return TEXT.askAdmin(f.op.id, f.index);
    return f.message;
  }

  function drawDownload(op) {
    const box = node('section', 'study-transfer-op');
    box.dataset.operation = op.id;
    const head = node('div', 'study-transfer-op-head');
    head.append(node('b', null, 'Download Originals'), node('span', null, ' · ' + op.id.slice(0, 8) + (op.label ? ' · ' + op.label : '')));
    box.append(head);
    if (op.state) {
      const line = node('p', 'study-transfer-download');
      line.append(node('span', 'study-transfer-state', DOWNLOAD_NAMES[op.state]), node('span', 'study-transfer-reason', downloadText(op)));
      box.append(line);
    }
    if (op.notice) box.append(node('p', 'study-transfer-note', op.notice));
    if (RESTARTABLE.includes(op.state) && !op.polling && !op.inFlight) box.append(button('Download', () => start(op)));
    if (op.state === 'sent' && !op.inFlight) box.append(button('Prepare Again', () => download(op.uid)));
    return box;
  }
  function downloadText(op) {
    if (op.state === 'prepared') return TEXT.ready(op.objects, size(op.bytes));
    if (op.state === 'sending') return TEXT.downloading(op.done, op.objects);
    if (op.state === 'sent') return TEXT.sent;
    if (op.state === 'incomplete') return TEXT.incomplete;
    return TEXT.downloadUnconfirmed;
  }
  function size(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GiB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MiB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KiB';
  }

  if (toolbarButton) toolbarButton.addEventListener('click', () => choose(null));
  sync();

  return Object.freeze({
    canImport, canDownload,
    /** The Technician row's Import DICOM: the row's study goes as X-KIN-Expect-Study. */
    importInto: uid => choose(uid),
    download,
    sync,
  });
};
