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
    // Neither a 404 of the status read (also the answer for an operation whose study this account cannot see now,
    // contract 3) nor a status without this file proves that the file did not arrive, so nothing is offered to send
    // again on them (U4C-03, U4C-03b). Not Sent + Retry is only for a file the browser never sent or the server refused
    // as retryable.
    pending: '서버가 아직 이 파일의 결과를 기록하지 않았습니다. 저장 중일 수 있어 다시 보내지 않았습니다. 잠시 뒤 Check Again으로 다시 확인하세요.',
    unresolved: '서버가 이 작업의 결과를 보여 주지 않습니다. 저장됐을 수 있어 다시 보내지 않았습니다. 잠시 뒤 Check Again으로 다시 확인하고, 계속 같으면 관리자에게 작업 번호를 알려 주세요.',
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
    // A poll deadline does not prove that the browser's own GET will not start: only that it was not seen to start.
    notStarted: '내려받기가 시작됐는지 확인하지 못했습니다. 브라우저의 다운로드 목록을 확인한 뒤, 필요하면 다시 시도하세요.',
    selectionMoved: '다른 검사를 고르는 사이에 온 답이라 내려받기를 시작하지 않았습니다. 이 검사의 원본이 필요하면 Download를 다시 누르세요.',
    preparing: '원본 목록을 준비하는 중입니다…',
    granting: '내려받기를 시작하는 중입니다…',
    copied: '작업 번호와 파일 번호를 복사했습니다.',
    copyFailed: (id, index) => `복사하지 못했습니다. 작업 번호 ${id} · 파일 번호 ${index}`,
    resolveInput: '작업 번호(UUID), 파일 번호(0~99), 확인 근거와 확인 시각을 적으세요.',
    resolving: '관리자 확인을 요청하는 중입니다…',
    // An answer this page cannot read as a typed result or refusal: what it did is not known (D1566), never called refused.
    httpFailure: status => `서버의 답을 확인하지 못했습니다 (HTTP ${status}).`,
    unknownAnswer: '서버의 답을 확인하지 못했습니다(형식이 다르거나 중간에서 바뀐 답). 처리됐을 수 있어 다시 보내지 않았습니다. Check Again으로 상태를 확인하세요.',
    storeBlocked: '이 탭의 작업 기록을 갱신하지 못해 이 파일을 보내지 않았습니다. Retry로 다시 보낼 수 있습니다.',
    prepareUnknown: '원본 준비 요청의 결과를 확인하지 못했습니다. 같은 작업의 상태를 다시 읽습니다.',
    grantUnknown: '내려받기 권한 요청의 결과를 확인하지 못했습니다. 이번 누름으로는 내려받기를 시작하지 않았습니다. Download를 다시 누를 수 있습니다.',
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
    if (entry && entry.state === 'sending') applyImportDecision(entry, classifyTransferEvidence({ source: 'post', failure: { sent: true } }));
    if (usable()) { if (op.kind === 'import') readImport(op); else readDownload(op); } else op.lost = true;
  }

  // ── what an answer proves: the one decision boundary of every transition and control (D1566) ──
  /*
   * An import may say Not Sent only on (1) this page's own evidence that this dispatch never left the browser, or (2) a
   * complete, typed server answer that this very request or attempt wrote nothing. Retry needs, besides, a contract that
   * lets the same input go again: "nothing written" and "may be sent again" are different facts (a typed 413 is the first
   * without the second). Everything else - a missing, malformed, proxy-made (502/504 HTML), unreadable, scoped-away (404)
   * or older-attempt answer - is "not known": the file keeps its operation and index, is never sent again by itself and is
   * read back; Check Again reads it again. The tables are the server's own finite contracts (4.8; IMPORT_RESULT_CODES and
   * the request refusals of the import route); membership decides, never an HTTP status alone or the outcome name alone.
   */
  const RETRYABLE_HTTP = Object.freeze({ ORTHANC_UNAVAILABLE: [503], IMPORT_PERMISSION_REVOKED: [403, 404], IMPORT_ATTEMPT_EXPIRED: [200],
    STUDY_WRITE_PENDING: [409], SOP_WRITE_PENDING: [409], STUDY_OWNERSHIP_UNDETERMINED: [409], RECOVERED_NO_OBJECT: [200] });
  const REJECTED_HTTP = Object.freeze({ DICOM_NOT_PART10: 400, DICOM_FILE_META_MISSING: 400, DICOM_TRANSFER_SYNTAX_UNSUPPORTED: 400,
    DICOM_MALFORMED: 400, PATIENT_ID_UNREADABLE: 400, PATIENT_ID_MISSING: 400, MODALITY_NOT_IMPORTABLE: 400, PATIENT_ISSUER_CONFLICT: 409,
    PATIENT_ID_CONFLICT: 409, PATIENT_IDENTITY_CONFLICT: 409, STUDY_OWNERSHIP_CONFLICT: 409, STUDY_UID_MISMATCH: 409,
    EXISTING_STUDY_IDENTITY_UNRESOLVED: 409, SOP_UID_AMBIGUOUS: 409, SOP_CONTENT_CONFLICT: 409 });
  // Request-level refusals of POST /api/dicom-import, all made before any write: 'again' - the same file may go again
  // unchanged; 'changed' - nothing was written but the same request would be refused alike (another file or request is
  // needed); 'conflict' - this request wrote nothing, but it says nothing of what the operation already holds.
  const REQUEST_REFUSALS = Object.freeze({ '503 IMPORT_NOT_READY': 'again', '503 IMPORT_STORAGE_UNAVAILABLE': 'again',
    '503 IMPORT_ISSUER_UNCONFIGURED': 'again', '403 STUDY_ACCESS_RESTRICTED_IMPORT': 'again', '403 IMPORT_SUBJECT_MISSING': 'again',
    '400 IMPORT_REQUEST_INVALID': 'changed', '415 IMPORT_CONTENT_TYPE_UNSUPPORTED': 'changed', '413 DICOM_IMPORT_TOO_LARGE': 'changed',
    '409 OPERATION_CONFLICT': 'conflict', '409 OPERATION_CONTENT_CONFLICT': 'conflict' });
  const DISPOSITIONS = [null, 'pre-write', 'may-have-written'];
  const GRANT_STATES = ['issued', 'expired', 'refused', 'consumed'];
  const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

  /**
   * A file result as the routes answer it (gate publicFile; on POST also its operationId and an HTTP status that belongs to
   * its code), or null. Wire types and the outcome/code/disposition pairing only - the server's state machine is not redone.
   */
  function validateImportResult(r, operationId, index, http) {
    if (!isObject(r) || (http !== null && r.operationId !== operationId) || r.index !== index || typeof r.message !== 'string') return null;
    if (!owns(r, 'code') || !owns(r, 'writeDisposition') || !owns(r, 'identity') || !DISPOSITIONS.includes(r.writeDisposition)) return null;
    if ((r.identity !== null && typeof r.identity !== 'string') || !Number.isInteger(r.generation) || r.generation < 0 || !Array.isArray(r.attempts)) return null;
    const o = r.outcome, c = r.code, written = r.writeDisposition === 'may-have-written';
    let statuses;
    if (o === 'stored' || o === 'already-present') { if (c !== null || written) return null; statuses = [200]; }
    else if (o === 'retryable') { if (typeof c !== 'string' || !owns(RETRYABLE_HTTP, c) || written) return null; statuses = RETRYABLE_HTTP[c]; }
    else if (o === 'rejected') { if (typeof c !== 'string' || !owns(REJECTED_HTTP, c)) return null; statuses = [REJECTED_HTTP[c]]; }
    else if (o === 'unconfirmed') { if (c !== 'IMPORT_UNCONFIRMED' || written) return null; statuses = [202]; }
    else return null;
    return http === null || statuses.includes(http) ? r : null;
  }

  /**
   * Evidence -> decision { kind, proof, canRetry, notice, readNeeded, stop, result, generation }. Unknown is the default.
   * Sources: local-oversize / local-unsent (this page's own non-dispatch), post (the answer of THIS dispatch), status (a
   * bound GET envelope), status-file (one file row of it, against the latest dispatch), prepare / grant (download
   * requests: issuance unknown is not a refusal) and archive-status (a status' archiveRequest, for this operation's grant).
   */
  function classifyTransferEvidence(input) {
    const unknown = (notice, readNeeded = false, stop = false) => ({ kind: 'unknown', proof: null, canRetry: false, notice, readNeeded, stop });
    switch (input.source) {
      case 'local-oversize': return { kind: 'refused', proof: 'local', canRetry: false, final: true, notice: TEXT.tooLarge };
      case 'local-unsent': return { kind: 'not-sent', proof: 'local', canRetry: true, notice: input.notice || TEXT.paused };
      case 'post': {
        const { failure, answer, entry } = input;
        if (failure) return failure.sent === false ? { kind: 'not-sent', proof: 'local', canRetry: true, notice: TEXT.paused, stop: true }
          : unknown(TEXT.lost, true);
        // The server ended this session before the handler: this request wrote nothing, and nothing more goes out.
        if (answer.auth) return { kind: 'not-sent', proof: 'auth', canRetry: false, notice: '', stop: true };
        if (answer.incomplete) return unknown(TEXT.unknownAnswer, true);
        const result = validateImportResult(answer.body, entry.op.id, entry.index, answer.status);
        if (result) return { kind: 'result', proof: 'post', result, canRetry: result.outcome === 'retryable', generation: result.generation };
        const b = answer.body;
        const refusal = !answer.ok && isObject(b) && typeof b.code === 'string' && typeof b.message === 'string' && b.message
          ? REQUEST_REFUSALS[answer.status + ' ' + b.code] : undefined;
        if (refusal === 'again' || refusal === 'changed')
          // An 'again' refusal (import not ready, storage, the account's access) would refuse the next files alike: the loop
          // stops. A 'changed' one is this file's own (too large, its request or type): the others still go.
          return { kind: 'refused', proof: 'request', canRetry: refusal === 'again', notice: b.message, code: b.code, stop: refusal === 'again' };
        if (refusal === 'conflict') return unknown(b.message, true, true);
        return unknown(TEXT.unknownAnswer, true);
      }
      case 'status': {
        const { failed, answer, op } = input;
        if (failed || answer.incomplete) return { kind: 'unreadable', notice: TEXT.unread };
        if (answer.ok && isObject(answer.body) && answer.body.operationId === op.id && Array.isArray(answer.body.files)) {
          const rows = new Map();
          for (const f of answer.body.files) if (isObject(f) && Number.isInteger(f.index)) rows.set(f.index, rows.has(f.index) ? null : f);
          return { kind: 'shown', rows };
        }
        // 404 is also the answer for an operation whose study this person cannot see now (contract 3).
        if (answer.status === 404) return { kind: 'not-shown' };
        return { kind: 'unreadable', notice: isObject(answer.body) && typeof answer.body.message === 'string' && answer.body.message
          ? answer.body.message : TEXT.unread };
      }
      case 'status-file': {
        const { entry, row } = input;
        if (row === undefined) return unknown(TEXT.pending);
        const result = validateImportResult(row, entry.op.id, entry.index, null);
        if (!result) return unknown(TEXT.unknownAnswer);
        // A final result is final whenever it was made. Any other row must be newer than the latest dispatch left
        // undecided: an older attempt's retryable is not this request's answer (the request may still store later).
        if (!FINAL.has(result.outcome) && entry.pending !== null && !(result.generation > entry.pending)) return unknown(TEXT.pending);
        return { kind: 'result', proof: 'status', result, canRetry: result.outcome === 'retryable', generation: result.generation };
      }
      case 'prepare': {
        const { failed, answer, op } = input;
        if (!failed && !answer.incomplete && answer.ok && isObject(answer.body) && answer.body.operationId === op.id && DOWNLOAD_NAMES[answer.body.state])
          return { kind: 'prepared', view: answer.body };
        if (!failed && !answer.incomplete && !answer.ok && isObject(answer.body) && typeof answer.body.code === 'string'
            && typeof answer.body.message === 'string' && answer.body.message) return { kind: 'refused', notice: answer.body.message };
        return { kind: 'unknown', notice: TEXT.prepareUnknown, readNeeded: true };
      }
      case 'grant': {
        const { failed, answer, op } = input;
        const b = !failed && !answer.incomplete ? answer.body : null;
        if (answer?.ok && isObject(b) && b.operationId === op.id && typeof b.grantId === 'string' && typeof b.grant === 'string'
            && /^[A-Za-z0-9_-]{43}$/.test(b.grant)) return { kind: 'grant', grant: b.grant, grantId: b.grantId };
        // A refusal the route typed: no grant was issued for this press. Anything else: issuance is not known.
        if (b && !answer.ok && isObject(b) && typeof b.code === 'string' && typeof b.message === 'string' && b.message)
          return { kind: 'refused', notice: b.message };
        return { kind: 'unknown', notice: TEXT.grantUnknown };
      }
      case 'archive-status': {
        const { request, op } = input;
        if (!isObject(request) || typeof request.grantId !== 'string' || !GRANT_STATES.includes(request.state)) return { kind: 'none' };
        // Only the grant this panel asked for (when it knows it) - a status of another grant tells nothing of this press.
        if (op.grantId && request.grantId !== op.grantId) return { kind: 'none' };
        if ((request.state === 'refused' || request.state === 'expired') && typeof request.code === 'string'
            && typeof request.message === 'string' && request.message)
          return { kind: request.state === 'refused' && request.code === 'MANIFEST_CHANGED' ? 'manifest-changed' : 'unstarted', notice: request.message };
        return { kind: 'none' };
      }
      default: return unknown(TEXT.unknownAnswer);
    }
  }

  /** A decision applied to one file: the only place a file's state, its retry permission and its dispatch marker change. */
  function applyImportDecision(entry, d) {
    entry.canRetry = false;
    if (d.kind === 'result') {
      const r = d.result;
      entry.state = 'result';
      entry.outcome = r.outcome;
      entry.code = r.code;
      entry.identity = r.identity;
      entry.writeDisposition = r.writeDisposition;
      entry.message = r.message;
      entry.generation = r.generation;
      entry.pending = null;
      entry.autoRechecked = !!r.attempts.length && !!r.attempts[r.attempts.length - 1]?.autoRecheckedAt;
      entry.final = FINAL.has(r.outcome);
      entry.canRetry = d.canRetry === true && !entry.final;
    } else if (d.kind === 'not-sent' || d.kind === 'refused') {
      entry.state = d.kind === 'refused' ? 'refused' : 'notSent';
      entry.message = d.notice;
      entry.code = d.code ?? null;
      entry.pending = null;
      if (d.final) { entry.final = true; entry.file = null; }
      entry.canRetry = d.canRetry === true && !entry.final;
    } else {
      // Not known: nothing is claimed and nothing may go again. A final result already shown is never taken back.
      if (entry.final) return;
      entry.state = entry.state === 'result' ? 'result' : (d.readNeeded ? 'unknown' : 'unresolved');
      if (entry.state !== 'result') entry.message = d.notice;
    }
  }

  // ── what is kept for this tab (4.6: the bytes never are; a re-login of the same person reads its operations again) ──
  /**
   * The record of this tab: descriptors only (index, name, size), the last generation seen and the marker of a dispatch
   * whose answer is not known yet - never bytes, grants or credentials. Returns false only when a write failed AND an
   * older record may still be read back (one that does not know the dispatch about to start).
   */
  function store() {
    try {
      if (!owner) return true;
      const kept = operations.slice(0, STORE_OPERATIONS).map(op => op.kind === 'import'
        ? { kind: 'import', id: op.id, expect: op.expect, files: op.files.map(f => ({ index: f.index, name: f.name, size: f.size,
          generation: Number.isInteger(f.generation) ? f.generation : null, pending: f.pending })) }
        : { kind: 'download', id: op.id, uid: op.uid });
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, owner, operations: kept }));
      return true;
    } catch (_) {
      try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
      // A storage that cannot be read back restores nothing; one that still reads the old record would mislead a re-login.
      try { return sessionStorage.getItem(STORE_KEY) === null; } catch (_) { return true; }
    }
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (_) { saved = null; }
    // Another person's operations are never read, shown or resumed, whatever their display name (REQ-S9-U4-10).
    if (!saved || (saved.v !== 1 && saved.v !== 2) || JSON.stringify(saved.owner) !== JSON.stringify(owner) || !Array.isArray(saved.operations)) {
      try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
      return;
    }
    for (const kept of saved.operations.slice(0, STORE_OPERATIONS).reverse()) {
      if (!kept || !UUID.test(String(kept.id))) continue;
      if (kept.kind === 'import' && Array.isArray(kept.files)) {
        const op = importOperation(String(kept.id), typeof kept.expect === 'string' ? kept.expect : null);
        for (const f of kept.files.slice(0, MAX_FILES))
          if (Number.isInteger(f?.index) && f.index >= 0 && f.index < MAX_FILES) {
            const entry = fileEntry(op, f.index, null, String(f.name ?? ''), Number(f.size) || 0, 'unknown');
            // A record without the dispatch marker (format 1, or a damaged one) cannot tell a settled file from one whose
            // last request is still unknown: no non-final row of the server may then open it again.
            entry.generation = saved.v === 2 && Number.isInteger(f.generation) ? f.generation : null;
            entry.pending = saved.v === 2 && (f.pending === null || Number.isInteger(f.pending)) ? f.pending : Number.MAX_SAFE_INTEGER;
            entry.message = TEXT.lost;
            op.files.push(entry);
          }
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
    if (op.kind === 'download') return ['sent', 'incomplete', 'unconfirmed'].includes(op.state) || op.manifestChanged || (!op.state && op.prepareRefused);
    return op.files.every(f => f.final);
  }

  // ── Import DICOM (4, 4.4, 4.6, 6) ──
  function importOperation(id, expect) {
    return { kind: 'import', id, expect, files: [], gen: generation, readSeq: 0, inFlight: false, lost: false, notice: '',
      recheckPending: false, label: studyLabel(expect) };
  }
  function fileEntry(op, index, file, name, size, state) {
    // generation: the last attempt generation the server showed; pending: the lower bound of a dispatch whose answer is
    // not known yet (null: none) - a status row must be newer than it to speak for that dispatch.
    return { op, index, file, name, size, state, final: false, outcome: null, code: null, message: '', identity: null,
      writeDisposition: null, rechecked: false, autoRechecked: false, canRetry: false, generation: null, pending: null };
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
      entry.fresh = true;
      if (file.size > MAX_BYTES) applyImportDecision(entry, classifyTransferEvidence({ source: 'local-oversize' }));
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
      // Name and size only find the file again; whether it may go is the classified permission (sendable).
      if (entry.file || !sendable(entry)) continue;
      const match = files.find(f => f.name === entry.name && f.size === entry.size);
      if (match) { entry.file = match; entry.state = 'waiting'; queue.push(entry); }
    }
    render();
    pump();
  }

  /**
   * A file may go again only on a classified permission for what is known of it now (canRetry): never after a final
   * result, never while Unconfirmed or not known (only reads change that, 4.4), never twice at once.
   */
  function sendable(entry) {
    return !entry.final && entry.canRetry === true && !queue.includes(entry) && entry.state !== 'sending' && entry.state !== 'waiting';
  }
  function retry(entry) {
    if (!live(entry.op) || !entry.file || !sendable(entry)) return;
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
        if (!live(entry.op) || !entry.file || entry.state !== 'waiting' || entry.final || !(entry.fresh || entry.canRetry)) continue;
        if (await inLane(() => send(entry)) === 'stop') break;
      }
    } finally {
      running = false;
      // Files a stop left waiting were never sent: they go back to the person (Retry), never out by themselves.
      for (const entry of queue.splice(0))
        if (entry.state === 'waiting') applyImportDecision(entry, classifyTransferEvidence({ source: 'local-unsent' }));
      summarise();
      render();
    }
  }

  /** One file: POST /api/dicom-import with its operation id, its index and (from a row) the expected study. */
  async function send(entry) {
    const op = entry.op;
    if (!live(op) || !usable()) return 'stop';
    const gen = op.gen, at = work.capture('document');
    // Before it leaves: no earlier permission survives, and the record knows a dispatch is out (a re-login then reads
    // the server and never takes an older attempt's retryable as this request's answer).
    entry.canRetry = false;
    entry.fresh = false;
    entry.pending = Number.isInteger(entry.generation) ? entry.generation : -1;
    if (!store()) {
      applyImportDecision(entry, classifyTransferEvidence({ source: 'local-unsent', notice: TEXT.storeBlocked }));
      render();
      return 'stop';
    }
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
      const d = classifyTransferEvidence({ source: 'post', failure, answer, entry });
      applyImportDecision(entry, d);
      if (d.kind === 'result' && entry.outcome === 'unconfirmed') scheduleRecheck(op);
      // An answer that proves nothing gets one bound read of this operation - never a send.
      if (d.readNeeded) readImport(op);
      if (d.stop) go = 'stop';
      store();
      render();
    });
    if (!applied) { lostAnswer(op, entry); return 'stop'; }
    return go;
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
    for (const entry of op.files) if (entry.state === 'unknown' || entry.state === 'unresolved') entry.state = 'checking';
    op.inFlight = true;
    render();
    let answer = null, failed = false;
    try {
      answer = await app.transport.request(app.api + '/dicom-import/' + encodeURIComponent(op.id), { context: at });
    } catch (_) { failed = true; }
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      const view = classifyTransferEvidence({ source: 'status', failed, answer, op });
      op.notice = view.kind === 'unreadable' ? view.notice : '';
      for (const entry of op.files) {
        if (entry.state === 'sending' || entry.state === 'waiting' || entry.final) continue;
        if (view.kind !== 'shown') {
          if (entry.state === 'checking')
            applyImportDecision(entry, view.kind === 'not-shown' ? { kind: 'unknown', notice: TEXT.unresolved } : { kind: 'unknown', notice: TEXT.unread, readNeeded: true });
          continue;
        }
        const row = view.rows.has(entry.index) ? view.rows.get(entry.index) : undefined;
        const d = classifyTransferEvidence({ source: 'status-file', entry, row });
        // Only an entry this read was asked about, or a result row, changes: an uncertain read never undoes what is known.
        if (d.kind !== 'result' && entry.state !== 'checking') continue;
        applyImportDecision(entry, d);
        if (d.kind === 'result' && entry.outcome === 'unconfirmed') {
          if (recheck) entry.rechecked = true;
          else scheduleRecheck(op);
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
      inFlight: false, lost: false, polling: false, polls: 0, startedFrom: null, manifestChanged: false, prepareRefused: false, grantId: null, label: studyLabel(uid) };
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
      // The same id may be prepared again safely (it replays): an answer that proves nothing is read back by its id, never
      // prepared anew, and is not called a refusal (a lost or proxy-made answer may follow a committed preparation).
      const d = classifyTransferEvidence({ source: 'prepare', failed, answer, op });
      if (d.kind === 'prepared') { adoptDownload(op, d.view); op.notice = ''; }
      else if (d.kind === 'refused') { op.notice = d.notice; op.prepareRefused = true; }
      else { op.notice = d.notice; readDownload(op, false, true); }
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
    if (!live(op) || !usable() || op.polling || op.inFlight || !RESTARTABLE.includes(op.state) || op.manifestChanged) return;
    const gen = op.gen, seq = ++op.readSeq, at = work.capture('document'), who = JSON.stringify(app.identity());
    // The press was made with one study selected; once the person has moved to another one (A→B, and A→B→A is not the
    // same selection either, AGENTS 1) its late grant starts no download in the middle of other work (DG-T06, U4C-04).
    const pressed = work.capture('study');
    const base = app.api + '/studies/' + encodeURIComponent(op.uid) + '/original-downloads/' + encodeURIComponent(op.id) + '/archive';
    op.inFlight = true;
    op.notice = TEXT.granting;
    render();
    let answer = null, failed = false;
    try {
      answer = await app.transport.request(base + '/grant', { method: 'POST', json: {}, context: at });
    } catch (_) { failed = true; }
    const decision = classifyTransferEvidence({ source: 'grant', failed, answer, op });
    let grant = decision.kind === 'grant' ? decision.grant : null;
    delete decision.grant;
    if (answer?.body && typeof answer.body === 'object') delete answer.body.grant;
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      if (op.readSeq !== seq || !usable() || JSON.stringify(app.identity()) !== who) { render(); return; }
      if (grant && !work.admits(pressed)) {
        // The grant is not used: it stays unused until it runs out (120 s) or the next press replaces it.
        op.notice = TEXT.selectionMoved;
        render();
        return;
      }
      if (!grant) {
        // This press clicks no link (that much is this page's own fact). Whether a grant was issued is the route's typed
        // refusal or not known - never a refusal by guess; the operation's state is read again, and Download asks anew.
        op.notice = decision.notice;
        render();
        // The notice is the answer to this press; the read that follows keeps it unless the server has its own to say.
        readDownload(op, false, true);
        return;
      }
      // Not secret: kept so that a later status speaks of this grant only (archiveRequest.grantId).
      op.grantId = decision.grantId;
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
  async function readDownload(op, polled = false, keepNotice = false) {
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
      const said = classifyTransferEvidence({ source: 'archive-status', request: answer.body.archiveRequest, op });
      const unstarted = said.kind !== 'none' && RESTARTABLE.includes(op.state);
      // The study's originals are no longer the ones this operation's fixed manifest names (5.2 step 3): no grant of this
      // operation can ever start, so the panel offers a new preparation instead of asking for this one again (U4C-02).
      if (unstarted && said.kind === 'manifest-changed') op.manifestChanged = true;
      op.notice = unstarted ? said.notice : keepNotice ? op.notice : '';
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
        } else result.textContent = !answer.ok && typeof value?.code === 'string' && value?.message ? value.message : TEXT.httpFailure(answer.status);
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
    if (op.files.some(f => f.state === 'unknown' || f.state === 'unresolved' || (f.state === 'result' && f.outcome === 'unconfirmed')))
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
    return { waiting: 'Waiting', sending: 'Sending', checking: 'Checking', unknown: 'Checking', unresolved: 'Result Unknown',
      notSent: 'Not Sent', refused: 'Not Sent' }[f.state] || '';
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
    if (RESTARTABLE.includes(op.state) && !op.manifestChanged && !op.polling && !op.inFlight) box.append(button('Download', () => start(op)));
    // After Sent, or once its manifest no longer matches the study: a new operation with a new manifest (5.3); this one
    // and its attempts stay in the panel as they were.
    if ((op.state === 'sent' || (op.manifestChanged && RESTARTABLE.includes(op.state))) && !op.inFlight && !op.polling)
      box.append(button('Prepare Again', () => download(op.uid)));
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
