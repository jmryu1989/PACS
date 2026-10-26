/*
 * S9-U4b part (c): Import DICOM, Download Originals and Resolve Unconfirmed (contract S9-U4p 4.4, 4.6, 4.8, 5.3, 6).
 *
 * D1606: only Files selected into a new operation in this live document can be dispatched, once. Responses change
 * observation, never send authority. Restored history is read-only. Downloads likewise have one first-grant opportunity.
 * Complete matching positive wire results confirm storage or supply; every other dispatched result stays unconfirmed.
 *
 * Every answer is applied through the work-context gate (work.commit) with the context its request left with, and only
 * while the panel still holds that operation in the same generation: a logout, an account change, a cancelled logout
 * preparation or a cleared panel leaves a late answer unwritten. The panel never opens a dialog, never moves focus and
 * never touches the viewer or the report editor.
 *
 * Mounted by feature-mounts.js: KinStudyTransferLocal({ api, transport, allowed, identity, can, demo, study }). identity()
 * is [issuer, institution, sub]: the login server that verified the person (/api/me issuer, the service's ownerIssuer), the
 * institution and the immutable subject (D1691). Without all three the panel neither restores nor starts any transfer.
 */
window.KinStudyTransferLocal = function (app) {
  'use strict';
  const work = window.KinWorkContext;
  const root = document.getElementById('study-transfer');
  const toolbarButton = document.getElementById('t-import');

  // Keep operation records in batches; selections have no file count or object size ceiling.
  const MAX_FILES = 100;
  // The server's own answer can take up to its 240 s reading of an existing study (4.4) behind nginx's 300 s; a shorter
  // limit here would only turn a result that is still coming into an unknown one.
  const IMPORT_DEADLINE_MS = 300000;
  // A file the server left Unconfirmed is read again once its attempt's 30 s lease has run out (4.4): only then does the
  // status GET reconcile it, so an earlier read would not be a re-check.
  const RECHECK_AFTER_MS = 35000;
  const DOWNLOAD_POLL_MS = 3000;
  // Automatic status reads of one download operation in this document, counted when each is sent (D1691): a read whose
  // answer lost to a newer one was still sent, and a manual Check Again neither uses nor gives back any of them.
  const DOWNLOAD_START_POLLS = 10;
  // The page goes online (bootstrap) after the identity is known; operations kept for this tab are read only then.
  const ONLINE_WAIT_MS = 1000;
  const ONLINE_WAITS = 120;
  // Each owner keeps its history in its own slot of this tab, named and verified by the exact [issuer, institution, sub]
  // (D1617, D1691), so one person's kept history never stands in another's way.
  const HISTORY_KEY = 'kin-study-transfer-local.v4:';
  const HISTORY_VERSION = 4;
  // History written before D1691 (v1-v3, here and under LEGACY_KEY + ':' + owner) never recorded the login server, so whose
  // it is cannot be proven. It stays exactly as it is: never shown, read for status, relabelled, merged, pruned or replaced.
  const LEGACY_KEY = 'kin-study-transfer-local';
  const STORE_OPERATIONS = 20;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // API token -> screen name (4.6, 5.3). Names are English, descriptions Korean (AGENTS 4).
  const OUTCOME_NAMES = Object.freeze({ stored: 'Stored', 'already-present': 'Already Present', rejected: 'Rejected',
    retryable: 'Retry Needed', unconfirmed: 'Unconfirmed' });
  const DOWNLOAD_NAMES = Object.freeze({ prepared: 'Ready', sending: 'Downloading', sent: 'Sent', incomplete: 'Incomplete',
    unconfirmed: 'Unconfirmed' });
  const POSITIVE = new Set(['stored', 'already-present']);
  const BASES = Object.freeze([
    ['orthanc-restarted', '이 시도 뒤 Orthanc가 다시 시작된 것을 확인했습니다'],
    ['orthanc-log-checked', 'Orthanc 기록에서 이 시도가 저장되지 않은 것을 확인했습니다'],
  ]);
  const TEXT = Object.freeze({
    lost: '서버의 답을 받지 못했습니다. 이 작업의 상태를 다시 읽어 확인합니다.',
    // Neither a 404 of the status read (also the answer for an operation whose study this account cannot see now,
    // contract 3) nor a status without this file proves that the file did not arrive, so nothing is offered to send
    // again on them (U4C-03, U4C-03b). D1606 limits Not Sent + Retry to the live document
    // holding a genuine never-dispatched File; no server result restores that opportunity.
    pending: '이번 조회에서 이 파일의 저장 결과를 확인하지 못했습니다. Check Again으로 다시 확인하세요.',
    unread: '작업 상태를 읽지 못했습니다. Check Again으로 다시 확인하세요.',
    paused: '지금은 요청을 보낼 수 없어 이 파일을 보내지 않았습니다. Retry로 이어서 보낼 수 있습니다.',
    offline: '서버에 연결된 계정에서만 반입·원본 다운로드를 쓸 수 있습니다.',
    identity: '로그인 서버를 포함한 계정 정보를 확인하지 못해 반입·원본 다운로드를 시작하지 않았습니다. 다시 로그인한 뒤 사용하세요.',
    legacy: '이 탭에 이전 형식의 반입·다운로드 기록이 남아 있습니다. 어느 로그인 서버 계정의 기록인지 확인할 수 없어 자동으로 조회하거나 표시하지 않고 지우지 않은 채 보존합니다. 필요하면 관리자에게 확인을 요청하세요.',
    pollsEnded: '자동 상태 확인을 마쳤습니다. 이후 상태는 Check Again으로 확인하세요.',
    sending: (done, n) => `파일을 보내는 중입니다 (${done}/${n}).`,
    summary: (kept, attention) => `반입 결과: 저장 확인 ${kept}개` + (attention ? `, 확인이 필요한 파일 ${attention}개` : '') + '.',
    sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',
    ready: (n, size) => `검사 원본 ${n}개(${size})를 내려받을 준비가 되었습니다.`,
    downloading: (done, n) => `서버가 원본을 보내는 중입니다 (${done}/${n}).`,
    incomplete: '서버 기록에서 전송 완료를 확인하지 못했습니다. Check Again으로 확인하거나 Prepare Again으로 새 원본 목록을 준비하세요.',
    downloadUnconfirmed: '서버의 전송 결과를 확인하지 못했습니다. Check Again으로 확인하거나 Prepare Again으로 새로 준비하세요.',
    // A poll deadline does not prove that the browser's own GET will not start: only that it was not seen to start.
    notStarted: '내려받기가 시작됐는지 확인하지 못했습니다. 브라우저의 다운로드 목록을 확인한 뒤, 필요하면 다시 시도하세요.',
    selectionMoved: '검사 선택이 바뀌어 이 답을 적용하지 않았습니다. 상태를 확인하거나 Prepare Again으로 새로 준비하세요.',
    preparing: '원본 목록을 준비하는 중입니다…',
    granting: '내려받기를 시작하는 중입니다…',
    copied: '작업 번호와 파일 번호를 복사했습니다.',
    copyFailed: (id, index) => `복사하지 못했습니다. 작업 번호 ${id} · 파일 번호 ${index}`,
    resolveInput: '작업 번호(UUID), 파일 번호(0~99), 확인 근거와 확인 시각을 적으세요.',
    resolving: '관리자 확인을 요청하는 중입니다…',
    // An answer this page cannot read as a typed result or refusal: what it did is not known (D1566), never called refused.
    unknownAnswer: '서버의 답을 확인하지 못했습니다(형식이 다르거나 중간에서 바뀐 답). 처리됐을 수 있어 다시 보내지 않았습니다. Check Again으로 상태를 확인하세요.',
    storeFailed: '이 탭의 작업 기록을 보존하지 못했습니다. 새로고침·재로그인 뒤 일부 이력이 보이지 않을 수 있습니다. 필요한 작업 번호를 Copy ID로 보관하세요.',
    prepareUnknown: '원본 준비 요청의 결과를 확인하지 못했습니다. 같은 작업의 상태를 다시 읽습니다.',
    grantUnknown: '내려받기 권한 요청의 결과를 확인하지 못했습니다. Check Again으로 확인하거나 Prepare Again으로 새로 준비하세요.',
    lifetimeEnded: '이 작업의 다운로드 시작 기회가 종료되어 늦게 도착한 답을 적용하지 않았습니다. Check Again으로 상태를 확인하거나 Prepare Again으로 새로 준비하세요.',
  });

  // ── panel state ──
  let generation = 0;          // a cleared operation or an ended session leaves the late answers of the old one unwritten
  let ended = false;
  let restored = false;
  let onlineWaits = 0;
  let owner = null;            // [issuer, institution, sub] of the identity whose operations the panel holds
  let legacy = false;          // this tab still holds history without a recorded login server (shown as a notice only)
  const operations = [];       // import and download operations, newest first
  // These capabilities never enter storage. Neither a response nor a descriptor can create one.
  const unsent = new WeakSet();
  const firstDownloads = new WeakSet();
  const pendingClicks = new WeakSet();
  const clearedHistory = new Map();
  let persistenceFailed = false;
  const queue = [];            // import file entries waiting to be sent, in order
  let running = false;         // the one upload loop
  // Every import request (an upload or a status read) runs in this one lane, so exactly one is in flight (4).
  let lane = Promise.resolve();
  const timers = new Set();

  // ── the panel's own nodes (the container is main.html's) ──
  const header = node('div', 'study-transfer-head');
  const resolveOpen = button('Resolve Unconfirmed', () => toggleResolve());
  const clear = button('Clear Finished', () => clearFinished());
  const hide = button('Hide', () => {
    if (!body.hidden) endDownloads();
    body.hidden = !body.hidden;
    hide.textContent = body.hidden ? 'Show' : 'Hide';
    render();
  });
  const close = button('Close', () => closePanel());
  header.append(node('b', null, 'DICOM Transfer'), resolveOpen, clear, hide, close);
  const body = node('div', 'study-transfer-body');
  const list = node('div', 'study-transfer-list');
  const resolveForm = node('form', 'study-transfer-resolve');
  const status = node('p', 'study-transfer-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.lang = 'ko';
  const persistence = node('p', 'study-transfer-note');
  persistence.lang = 'ko';
  body.append(persistence, resolveForm, list);
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  if (root) root.append(header, body, status, picker);
  let pickFor = null;          // expected study for a new operation only
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
    return timer;
  }
  function inLane(task) {
    const run = lane.then(task, task);
    lane = run.then(() => undefined, () => undefined);
    return run;
  }

  // ── roles and identity (the server's checks are the authority; this only keeps the controls honest) ──
  // The owner as the service keys an operation (D1691): a login server, an institution and a subject, each a non-empty
  // string taken exactly as given. Anything less is no identity - never the former [institution, sub] alone.
  const field = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  function currentOwner() {
    const v = app.identity();
    return Array.isArray(v) && v.length === 3 && field(v[0], 2048) && field(v[1], 256) && field(v[2], 256) ? [v[0], v[1], v[2]] : null;
  }
  const usable = () => !ended && !!owner && sameOwner(currentOwner()) && work.state() === 'active' && app.allowed();
  const canImport = () => !app.demo() && app.can('technician');
  const canDownload = () => !app.demo() && (app.can('radiologist') || app.can('technician'));
  const isAdmin = () => !app.demo() && app.can('admin');
  const live = op => !ended && op.gen === generation && operations.includes(op);

  /** The identity or the page's state may have changed: the role controls, and once the operations kept for this tab. */
  function sync() {
    if (toolbarButton) toolbarButton.hidden = ended || !canImport();
    resolveOpen.hidden = !isAdmin();
    if (!isAdmin()) resolveForm.hidden = true;
    const identity = currentOwner();
    // Without a complete identity nothing is restored or started; a later valid one (a new login) restores then.
    if (ended || !identity || work.state() !== 'active') return;
    if (owner && !sameOwner(identity)) { end(); return; }
    owner = owner || identity;
    if (restored) return;
    if (app.allowed()) { restored = true; restore(); }
    else if (onlineWaits++ < ONLINE_WAITS) later(sync, ONLINE_WAIT_MS);
  }
  /** Why a transfer cannot start now: no complete identity, or no server connection. */
  const unavailable = () => (currentOwner() ? TEXT.offline : TEXT.identity);

  /** The session ended, the account changed or the page is leaving: nothing of the panel survives into another one. */
  function end() {
    endDownloads();
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
    if (event.reason === 'prepare') { endDownloads(); render(); }
    if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) { end(); return; }
    if (event.reason === 'lifecycle') { sync(); return; }
    // Back from a logout preparation: an answer that left before it is no longer applied (a new work epoch), so what
    // was in flight or answered meanwhile is read again from the server instead of being guessed.
    if (event.reason === 'cancel' && !ended) {
      for (const op of operations) if (op.lost) { op.lost = false; if (op.kind === 'import') readImport(op); else readDownload(op); }
      if (!running && queue.length) pump();
    }
  });
  window.addEventListener('pagehide', end);
  window.addEventListener('beforeunload', endDownloads);

  // Ending the visible lifetime revokes both an unrequested grant and an outstanding answer's native-click budget.
  // This is synchronous: reopening the panel, cancelling logout or a later status read cannot revive either one.
  function endDownload(op) {
    const active = firstDownloads.has(op) || pendingClicks.has(op);
    firstDownloads.delete(op);
    pendingClicks.delete(op);
    if (active && op.state !== 'sent') op.notice = TEXT.lifetimeEnded;
  }
  function endDownloads() {
    for (const op of operations) if (op.kind === 'download') endDownload(op);
  }

  /**
   * An answer that came back when its context no longer admitted it (a logout preparation or its cancellation): its
   * content is not used. The panel only notes that the request has ended, and reads the server again when it may.
   */
  function lostAnswer(op, entry) {
    op.inFlight = false;
    if (!live(op)) return;
    if (entry && entry.state === 'sending') uncertain(entry, TEXT.lost);
    if (usable()) { if (op.kind === 'import') readImport(op); else readDownload(op); } else op.lost = true;
  }

  // Positive wire contracts only. Negative bodies are diagnostics, never non-write or retry certificates (D1606).
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const uid = v => typeof v === 'string' && v.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(v);
  // The server's own reading of a UTC text (dicom-import-gate.service.ts utcInstant): its calendar fields exist as written
  // (Date.parse would roll 2026-02-30 over to March) and its year is 1970 or later. Null otherwise.
  const UTC_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
  function utcInstant(v) {
    const m = typeof v === 'string' ? UTC_TEXT.exec(v) : null;
    if (!m) return null;
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
    if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
    const at = Date.UTC(year, month - 1, day, hour, minute, second, m[7] ? Number(m[7].padEnd(3, '0')) : 0);
    const back = new Date(at);
    return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? at : null;
  }
  // A time the server wrote itself (storedTime): exactly the canonical text of such an instant. An admin's recovery
  // checkedAt is the instant the admin named, accepted by the server without or with 1-3 fractional digits.
  const time = v => { const at = utcInstant(v); return at !== null && new Date(at).toISOString() === v; };
  const nullableTime = v => v === null || time(v);
  const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  const code = v => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v));
  const complete = a => !!a && a.ok && a.status === 200 && !a.incomplete && !a.auth && isObject(a.body);
  // The codes an attempt ends retryable with having written nothing (the server's ATTEMPT_RETRY_CODES).
  const NO_WRITE_RETRY = new Set(['ORTHANC_UNAVAILABLE', 'IMPORT_PERMISSION_REVOKED', 'IMPORT_ATTEMPT_EXPIRED', 'SOP_WRITE_PENDING']);

  /**
   * The only attempts a positive result can follow (the server's retryEnded, U4BB2-03 table): finished retryable with a
   * code of its own end and certain-no-write, or RECOVERED_NO_OBJECT after a resolved admin recovery with the transport
   * its dispatch left (null or unknown). A final, rejected or still running predecessor is no history the server writes.
   */
  function retryEnded(a) {
    if (a.phase !== 'finished' || a.outcome !== 'retryable') return false;
    if (a.code === 'RECOVERED_NO_OBJECT') return a.transport !== 'certain-no-write' && a.recovery !== null && a.recovery.resolvedAt !== null;
    return NO_WRITE_RETRY.has(a.code) && a.transport === 'certain-no-write';
  }

  function importPositive(r, entry) {
    if (!isObject(r) || r.index !== entry.index || !POSITIVE.has(r.outcome) || r.code !== null || r.writeDisposition !== null
        || typeof r.message !== 'string' || !['new-study', 'matched', 'not_comparable'].includes(r.identity)
        || !uid(r.studyUid) || !uid(r.seriesUid) || !uid(r.sopUid) || !hash(r.sha256)
        || !count(r.bytes, Number.MAX_SAFE_INTEGER) || r.bytes === 0 || r.bytes !== entry.size || !time(r.at)
        || (entry.op.expect && r.studyUid !== entry.op.expect) || (entry.sha256 && r.sha256 !== entry.sha256)
        || !Number.isSafeInteger(r.generation) || r.generation < 1 || !Array.isArray(r.attempts) || !r.attempts.length) return null;
    const ids = new Set();
    for (let i = 0; i < r.attempts.length; i++) {
      const a = r.attempts[i];
      if (!isObject(a) || typeof a.attemptId !== 'string' || !UUID.test(a.attemptId) || ids.has(a.attemptId)
          || a.generation !== i + 1 || !['prepared', 'dispatching', 'finished', 'unknown'].includes(a.phase)
          || !Object.prototype.hasOwnProperty.call(OUTCOME_NAMES, a.outcome) || !code(a.code)
          || ![null, 'certain-no-write', 'unknown'].includes(a.transport) || !time(a.startedAt)
          || !nullableTime(a.finishedAt) || !nullableTime(a.autoRecheckedAt)
          // A running attempt (prepared/dispatching) has no end time; every ended one has its own.
          || ['prepared', 'dispatching'].includes(a.phase) !== (a.finishedAt === null)) return null;
      if (a.recovery !== null && (!isObject(a.recovery) || !BASES.some(b => b[0] === a.recovery.basis)
          || utcInstant(a.recovery.checkedAt) === null || !time(a.recovery.requestedAt)
          || !nullableTime(a.recovery.resolvedAt))) return null;
      if (i < r.attempts.length - 1 && !retryEnded(a)) return null;
      ids.add(a.attemptId);
    }
    const last = r.attempts[r.attempts.length - 1];
    // Stored rests on a POST or read-back (transport null) or a re-check (unknown); Already Present on the pre-write
    // lookup (certain-no-write) or a POST (null).
    const transports = r.outcome === 'stored' ? [null, 'unknown'] : ['certain-no-write', null];
    return last.generation === r.generation && last.phase === 'finished' && last.outcome === r.outcome
      && last.code === null && time(last.finishedAt) && transports.includes(last.transport) ? r : null;
  }

  function importRows(answer, op) {
    if (!complete(answer) || answer.body.operationId !== op.id || !['open', 'settled'].includes(answer.body.status)
        || !Array.isArray(answer.body.files)) return null;
    const rows = new Map();
    for (const row of answer.body.files) {
      if (!isObject(row) || !count(row.index, MAX_FILES - 1) || rows.has(row.index)) return null;
      rows.set(row.index, row);
    }
    return rows;
  }

  function downloadPositive(answer, op) {
    if (!complete(answer)) return null;
    const v = answer.body;
    if (v.operationId !== op.id || v.studyUid !== op.uid || !hash(v.manifestSha256) || !time(v.preparedAt)
        || !count(v.objects, 65533) || v.objects === 0 || !count(v.bytes, 4294967294) || v.bytes === 0
        || !(v.note === null || typeof v.note === 'string') || !Object.prototype.hasOwnProperty.call(DOWNLOAD_NAMES, v.state)
        || !Array.isArray(v.attempts) || (op.manifestSha256 && (op.manifestSha256 !== v.manifestSha256
          || op.preparedAt !== v.preparedAt || op.objects !== v.objects || op.bytes !== v.bytes))) return null;
    const ids = new Set();
    for (let i = 0; i < v.attempts.length; i++) {
      const a = v.attempts[i], last = i === v.attempts.length - 1;
      if (!isObject(a) || typeof a.attemptId !== 'string' || !UUID.test(a.attemptId) || ids.has(a.attemptId)
          || a.number !== i + 1 || !['sending', 'sent', 'incomplete', 'unconfirmed'].includes(a.state)
          || !time(a.startedAt) || !nullableTime(a.endedAt) || (a.state === 'sending') !== (a.endedAt === null)
          || !count(a.objectsComplete, v.objects) || !count(a.bytesSupplied, v.bytes)
          || typeof a.responseFinished !== 'boolean' || ((a.state === 'sending' || a.state === 'sent') && !last)) return null;
      if (a.state === 'sent' ? !(hash(a.archiveSha256) && a.responseFinished && a.objectsComplete === v.objects && a.bytesSupplied === v.bytes)
        : !(a.archiveSha256 === null && a.responseFinished === false)) return null;
      ids.add(a.attemptId);
    }
    const last = v.attempts[v.attempts.length - 1];
    if (v.state !== (last ? last.state : 'prepared')) return null;
    if (v.archiveRequest !== null) {
      const a = v.archiveRequest;
      if (!isObject(a) || typeof a.grantId !== 'string' || !UUID.test(a.grantId) || !time(a.expiresAt)
          || !['issued', 'expired', 'refused', 'consumed'].includes(a.state) || !code(a.code)
          || !(a.message === null || typeof a.message === 'string') || (op.grantId && a.grantId !== op.grantId)) return null;
      if (a.state === 'consumed' ? !(last && a.attemptId === last.attemptId && a.code === null && a.message === null)
        : a.attemptId !== null) return null;
      if (a.state === 'issued' && (a.code !== null || a.message !== null)) return null;
      if (['expired', 'refused'].includes(a.state) && (a.code === null || typeof a.message !== 'string')) return null;
    }
    return v;
  }

  function grantPositive(answer, op) {
    const b = complete(answer) ? answer.body : null;
    return b && b.operationId === op.id && typeof b.grantId === 'string' && UUID.test(b.grantId)
      && typeof b.grant === 'string' && /^[A-Za-z0-9_-]{43}$/.test(b.grant) && time(b.expiresAt) ? b : null;
  }

  function diagnostic(value, fallback = TEXT.unknownAnswer) {
    const c = isObject(value) && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : null;
    if (!c) return fallback;
    let guidance = '상태를 다시 확인하고, 새 반입이 필요하면 원본 파일을 다시 선택하세요.';
    if (/PENDING$/.test(c)) guidance = '다른 작업의 결과 확인을 기다리고 있습니다. Check Again으로 확인하고 관리자에게 작업 번호를 알려 주세요.';
    else if (/PERMISSION|ACCESS|SUBJECT|AUTH/.test(c)) guidance = '현재 계정의 권한을 확인하세요. 기존 작업은 상태 조회만 가능합니다.';
    else if (/DICOM_|PATIENT_|SOP_|STUDY_UID|IDENTITY/.test(c)) guidance = '파일 형식과 환자·검사 식별 정보를 확인하세요. 관리자에게 작업 번호를 알려 주세요.';
    else if (/ORTHANC|STORAGE|NOT_READY/.test(c)) guidance = '서버 연결과 저장소 상태를 관리자에게 확인하세요.';
    return `${c} · 결과를 확인하지 못했습니다. ${guidance}`;
  }

  function uncertain(entry, message) {
    if (entry.final) return;
    entry.state = 'unresolved';
    entry.message = message;
  }
  function localUnsent(entry) {
    if (!unsent.has(entry)) return;
    entry.state = 'notSent';
    entry.message = TEXT.paused;
  }
  function adoptImport(entry, result) {
    entry.state = 'result';
    entry.outcome = result.outcome;
    entry.identity = result.identity;
    entry.message = result.outcome === 'stored' ? '원본 저장을 확인했습니다.' : '같은 원본이 이미 저장되어 있음을 확인했습니다.';
    entry.sha256 = result.sha256;
    entry.final = true;
    unsent.delete(entry);
    entry.file = null;
  }

  // ── what is kept for this tab (4.6: the bytes never are; a re-login of the same person reads its operations again) ──
  function descriptor(op) {
    return op.kind === 'import'
      ? { kind: 'import', id: op.id, expect: op.expect, files: op.files.map(f => ({ index: f.index, name: f.name, size: f.size, sha256: f.sha256 })) }
      : { kind: 'download', id: op.id, uid: op.uid, manifestSha256: op.manifestSha256, preparedAt: op.preparedAt, objects: op.objects, bytes: op.bytes };
  }

  const sameOwner = value => JSON.stringify(value) === JSON.stringify(owner);
  // The exact identity the panel was mounted with ([issuer, institution, sub]); a name or an actor never selects the slot.
  const ownerKey = () => HISTORY_KEY + JSON.stringify(owner);

  /** The owner's slot exactly in the qualified format (v4, this exact owner, verified operations), or null when empty. */
  function snapshot(key) {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const saved = JSON.parse(raw);
    // A partial/unknown snapshot is not an empty history anybody may replace (D1617).
    if (!isObject(saved) || saved.v !== HISTORY_VERSION || !Array.isArray(saved.operations)) throw new Error('Unverified history');
    // Only this owner's own record is its history; the bytes of anybody else are never adopted or written over.
    if (!sameOwner(saved.owner)) throw new Error('Foreign history');
    checkOperations(saved.operations);
    return saved;
  }

  /**
   * This owner's kept history and the slot it is written back to, read again before every write. Another owner's slot
   * and legacy history stay exactly as they are - never shown, read for status, merged, pruned or given any capability.
   * An unreadable or unverifiable slot is never taken for an empty history.
   */
  function readHistory() {
    const key = ownerKey(), own = snapshot(key);
    return { key, operations: own ? ownHistory(own.operations) : [] };
  }

  /** Whether this tab still holds history from before D1691 (no login server recorded). Only its presence is looked at. */
  function legacyHistory() {
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key === LEGACY_KEY || (typeof key === 'string' && key.startsWith(LEGACY_KEY + ':'))) return true;
      }
    } catch (_) {}
    return false;
  }

  function checkOperations(operations) {
    const ids = new Set();
    for (const kept of operations) {
      if (!isObject(kept) || typeof kept.id !== 'string' || !UUID.test(kept.id) || ids.has(kept.id)) throw new Error('Unverified operation');
      ids.add(kept.id);
      if (kept.kind === 'import') {
        if (!(kept.expect == null || uid(kept.expect)) || !Array.isArray(kept.files)
            || !kept.files.length || kept.files.length > MAX_FILES) throw new Error('Unverified import history');
        const indexes = new Set();
        for (const f of kept.files) {
          if (!isObject(f) || !count(f.index, MAX_FILES - 1) || indexes.has(f.index) || typeof f.name !== 'string'
              || !count(f.size, Number.MAX_SAFE_INTEGER) || !(f.sha256 == null || hash(f.sha256))) throw new Error('Unverified file history');
          indexes.add(f.index);
        }
      } else if (kept.kind === 'download') {
        if (!uid(kept.uid) || !(kept.manifestSha256 == null || hash(kept.manifestSha256))
            || !(kept.preparedAt == null || time(kept.preparedAt)) || !(kept.objects == null || count(kept.objects, 65533))
            || !(kept.bytes == null || count(kept.bytes, 4294967294))) throw new Error('Unverified download history');
      } else throw new Error('Unknown history kind');
    }
  }

  /** This owner's verified history agrees with what the page already holds of the same operations. */
  function ownHistory(saved) {
    for (const kept of saved) {
      const op = operations.find(o => o.id === kept.id) || clearedHistory.get(kept.id);
      if (!op) continue;
      if (op.kind !== kept.kind || (op.kind === 'download' ? op.uid !== kept.uid : op.expect !== (kept.expect ?? null)))
        throw new Error('Conflicting history');
      if (op.kind === 'import') for (const f of kept.files) {
        const entry = op.files.find(e => e.index === f.index);
        if ((!entry && clearedHistory.has(op.id)) || (entry && (entry.size !== f.size || entry.name !== f.name
            || (entry.sha256 && f.sha256 && entry.sha256 !== f.sha256)))) throw new Error('Conflicting file history');
      }
      if (op.kind === 'download' && op.manifestSha256 && kept.manifestSha256
          && (op.manifestSha256 !== kept.manifestSha256 || op.preparedAt !== kept.preparedAt
            || op.objects !== kept.objects || op.bytes !== kept.bytes)) throw new Error('Conflicting manifest history');
    }
    return saved;
  }

  // Kept history is a record to observe; writing it succeeds or fails without giving any operation a send or a grant.
  function store() {
    if (!owner) return;
    let added = [];
    try {
      // Read, merge and choose the slot in the same turn as the write. A failed restore never licenses replacing unseen
      // history, and the slot is the one this owner's own history is in now, never one assumed earlier.
      const history = readHistory();
      added = mergeHistory(history.operations);
      let confirmed = 0;
      const kept = operations.filter(op => !finished(op) || confirmed++ < STORE_OPERATIONS).map(descriptor);
      sessionStorage.setItem(history.key, JSON.stringify({ v: HISTORY_VERSION, observationOnly: true, owner, operations: kept }));
      persistenceFailed = false;
    } catch (_) { persistenceFailed = true; }
    observeHistory(added);
  }
  function restore() {
    legacy = legacyHistory();
    let added = [];
    try { added = mergeHistory(readHistory().operations); }
    catch (_) { persistenceFailed = true; openPanel(); render(); return; }
    if (!operations.length && !legacy) return;
    openPanel();
    observeHistory(added);
    render();
  }
  function mergeHistory(saved) {
    const added = [];
    for (const kept of saved) {
      if (clearedHistory.has(kept.id)) continue;
      let op = operations.find(o => o.id === kept.id);
      const existing = !!op;
      if (kept.kind === 'import') {
        op = op || importOperation(kept.id, kept.expect ?? null);
        for (const f of kept.files) {
          const entryBefore = op.files.find(e => e.index === f.index);
          if (entryBefore) { entryBefore.sha256 = entryBefore.sha256 || f.sha256 || null; continue; }
          const entry = fileEntry(op, f.index, null, String(f.name ?? ''), f.size, 'unresolved');
          entry.sha256 = hash(f.sha256) ? f.sha256 : null;
          entry.message = TEXT.unread;
          op.files.push(entry);
          if (existing && !added.includes(op)) added.push(op);
        }
      } else {
        op = op || downloadOperation(kept.id, kept.uid);
        if (!op.manifestSha256 && hash(kept.manifestSha256) && time(kept.preparedAt) && count(kept.objects, 65533) && count(kept.bytes, 4294967294))
          Object.assign(op, { manifestSha256: kept.manifestSha256, preparedAt: kept.preparedAt, objects: kept.objects, bytes: kept.bytes });
      }
      if (!existing) { operations.push(op); added.push(op); }
    }
    return added;
  }
  function observeHistory(added) {
    for (const op of added) if (op.kind === 'import') readImport(op); else readDownload(op);
  }

  // ── the panel ──
  function openPanel() {
    if (!root || ended) return;
    root.hidden = false;
    body.hidden = false;
    hide.textContent = 'Hide';
  }
  function closePanel() {
    endDownloads();
    render();
    // While files are still going out the panel only folds: its results must stay reachable.
    if (running || operations.some(op => op.inFlight)) { body.hidden = true; hide.textContent = 'Show'; return; }
    if (root) root.hidden = true;
  }
  function clearFinished() {
    endDownloads();
    for (let i = operations.length - 1; i >= 0; i--) if (finished(operations[i])) {
      endDownload(operations[i]);
      clearedHistory.set(operations[i].id, operations[i]);
      operations[i].gen = -1;
      operations.splice(i, 1);
    }
    store();
    render();
  }
  function finished(op) {
    if (op.inFlight || op.polling) return false;
    if (op.kind === 'download') return op.state === 'sent';
    return op.files.every(f => f.final);
  }

  // ── Import DICOM (4, 4.4, 4.6, 6) ──
  function importOperation(id, expect) {
    return { kind: 'import', id, expect, files: [], gen: generation, readSeq: 0, inFlight: false, lost: false, notice: '',
      recheckPending: false, label: studyLabel(expect) };
  }
  function fileEntry(op, index, file, name, size, state) {
    return { op, index, file, name, size, state, final: false, outcome: null, message: '', identity: null, sha256: null };
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
    if (!usable()) { status.textContent = unavailable(); return; }
    pickFor = { expect };
    picker.value = '';
    picker.click();
  }
  picker.addEventListener('change', () => {
    const files = [...(picker.files || [])], target = pickFor;
    pickFor = null;
    picker.value = '';
    if (!files.length || !target || !usable()) return;
    // Each selection grants dispatch for its files; split operation records without asking the user to reselect.
    for (let start = 0; start < files.length; start += MAX_FILES) {
      const op = importOperation(crypto.randomUUID(), target.expect ?? null);
      files.slice(start, start + MAX_FILES).forEach((file, index) => {
        const entry = fileEntry(op, index, file, file.name, file.size, 'waiting');
        unsent.add(entry); op.files.push(entry); queue.push(entry);
      });
      operations.unshift(op);
    }
    store();
    render();
    pump();
  });

  function sendable(entry) {
    return !!entry.file && unsent.has(entry) && !entry.final && !queue.includes(entry) && entry.state !== 'sending' && entry.state !== 'waiting';
  }
  function retry(entry) {
    if (!live(entry.op) || !usable() || !sendable(entry)) return;
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
        if (!live(entry.op) || !entry.file || entry.state !== 'waiting' || entry.final || !unsent.has(entry)) continue;
        if (await inLane(() => send(entry)) === 'stop') break;
      }
    } finally {
      running = false;
      // Files a stop left waiting were never sent: they go back to the person (Retry), never out by themselves.
      for (const entry of queue.splice(0))
        if (entry.state === 'waiting') localUnsent(entry);
      summarise();
      render();
    }
  }

  /** Consume the live File's opportunity before any asynchronous work or transport invocation. */
  async function send(entry) {
    const op = entry.op;
    if (!live(op) || !usable() || !entry.file || !unsent.has(entry) || entry.final) return 'stop';
    const gen = op.gen, at = work.capture('document');
    unsent.delete(entry);
    entry.state = 'sending';
    op.inFlight = true;
    render();
    const headers = { 'Content-Type': 'application/dicom', 'X-KIN-Operation-Id': op.id, 'X-KIN-File-Index': String(entry.index) };
    if (op.expect) headers['X-KIN-Expect-Study'] = op.expect;
    let answer = null, failure = null;
    try {
      const digest = await crypto.subtle.digest('SHA-256', await entry.file.arrayBuffer());
      entry.sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) { failure = error; }
    if (failure || !live(op) || !usable() || !work.admits(at)) {
      // Transport was never invoked: nothing of this file left the page. While this document and its owner are still
      // current, the resident File keeps its single first send (Retry); a logout, an account change or the page's end
      // has already removed the operation, so nothing comes back after them (R5-I1).
      op.inFlight = false;
      if (live(op) && op.gen === gen && entry.file && sameOwner(currentOwner())) { unsent.add(entry); localUnsent(entry); }
      render();
      return 'stop';
    }
    try {
      answer = await app.transport.request(app.api + '/dicom-import', { method: 'POST', body: entry.file, headers, context: at,
        deadlineMs: IMPORT_DEADLINE_MS });
    } catch (error) { failure = error; }
    let go = 'stop';
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      if (failure && failure.sent === false) {
        unsent.add(entry);
        localUnsent(entry);
      } else {
        const result = complete(answer) && answer.body.operationId === op.id ? importPositive(answer.body, entry) : null;
        if (result) { adoptImport(entry, result); go = 'next'; }
        else {
          uncertain(entry, diagnostic(answer?.body, failure ? TEXT.lost : TEXT.unknownAnswer));
          readImport(op);
          if (answer?.body?.code === 'IMPORT_UNCONFIRMED') scheduleRecheck(op);
        }
      }
      store();
      render();
    });
    if (!applied) lostAnswer(op, entry);
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
    op.inFlight = true;
    render();
    let answer = null;
    try { answer = await app.transport.request(app.api + '/dicom-import/' + encodeURIComponent(op.id), { context: at }); }
    catch (_) {}
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen || op.readSeq !== seq) return;
      op.inFlight = false;
      const rows = importRows(answer, op);
      for (const entry of op.files) {
        if (entry.final || unsent.has(entry) || entry.state === 'sending') continue;
        const row = rows?.get(entry.index), result = importPositive(row, entry);
        if (result) adoptImport(entry, result);
        else uncertain(entry, diagnostic(row, !rows ? TEXT.unread : TEXT.pending));
      }
      store();
      render();
    });
    if (!applied) lostAnswer(op, null);
  }

  function copyId(entry) {
    const text = entry.index === undefined ? entry.op.id : `${entry.op.id} ${entry.index}`, at = work.capture('document');
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
      inFlight: false, lost: false, polling: false, pollTimer: null, polls: 0, grantId: null, manifestSha256: null, preparedAt: null, label: studyLabel(uid) };
  }

  /** The row's Download Originals: a new operation is prepared for that study's fixed manifest (5.2 steps 1-2). */
  async function download(uid) {
    sync();
    if (!canDownload()) return;
    openPanel();
    if (!usable()) { status.textContent = unavailable(); return; }
    const op = downloadOperation(crypto.randomUUID(), uid);
    firstDownloads.add(op);
    operations.unshift(op);
    store();
    const gen = op.gen, at = work.capture('document');
    op.inFlight = true;
    op.notice = TEXT.preparing;
    render();
    let answer = null;
    try {
      answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(uid) + '/original-downloads',
        { method: 'POST', json: { operationId: op.id }, context: at });
    } catch (_) {}
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      const view = downloadPositive(answer, op);
      if (view) { adoptDownload(op, view); op.notice = ''; }
      else { op.notice = TEXT.prepareUnknown; readDownload(op, false, true); }
      store();
      render();
    });
    if (!applied) lostAnswer(op, null);
  }

  function adoptDownload(op, view) {
    // An uncertain observation can never erase a previously validated supply result.
    if (op.state === 'sent') return;
    op.state = view.state;
    op.manifestSha256 = view.manifestSha256;
    op.preparedAt = view.preparedAt;
    op.objects = view.objects;
    op.bytes = view.bytes;
    op.done = view.attempts.length ? view.attempts[view.attempts.length - 1].objectsComplete : 0;
  }

  // One grant request and one native click, only in the creating document's still-current context.
  async function start(op) {
    if (!live(op) || !usable() || op.polling || op.inFlight || op.state !== 'prepared' || !firstDownloads.has(op)) return;
    firstDownloads.delete(op);
    pendingClicks.add(op);
    const gen = op.gen, seq = ++op.readSeq, at = work.capture('document'), who = JSON.stringify(app.identity());
    // The press was made with one study selected; once the person has moved to another one (A→B, and A→B→A is not the
    // same selection either, AGENTS 1) its late grant starts no download in the middle of other work (DG-T06, U4C-04).
    const pressed = work.capture('study');
    const base = app.api + '/studies/' + encodeURIComponent(op.uid) + '/original-downloads/' + encodeURIComponent(op.id) + '/archive';
    op.inFlight = true;
    op.notice = TEXT.granting;
    render();
    let answer = null;
    try {
      answer = await app.transport.request(base + '/grant', { method: 'POST', json: {}, context: at });
    } catch (_) {}
    const decision = grantPositive(answer, op);
    let grant = decision ? decision.grant : null;
    if (answer?.body && typeof answer.body === 'object') delete answer.body.grant;
    const applied = work.commit(at, () => {
      if (!live(op) || op.gen !== gen) return;
      op.inFlight = false;
      if (!pendingClicks.has(op)) {
        op.notice = TEXT.lifetimeEnded;
        render();
        return;
      }
      if (!grant) {
        pendingClicks.delete(op);
        op.notice = TEXT.grantUnknown;
        render();
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
      let started = false;
      work.commit(pressed, () => {
        if (!live(op) || op.gen !== gen || op.readSeq !== seq || !usable()
            || JSON.stringify(app.identity()) !== who || !pendingClicks.has(op)) return;
        pendingClicks.delete(op);
        link.click();
        started = true;
      });
      link.remove();
      link.removeAttribute('href');
      pendingClicks.delete(op);
      if (!started) { op.notice = TEXT.selectionMoved; render(); return; }
      op.notice = '';
      poll(op);
    });
    grant = null;
    if (!applied) { pendingClicks.delete(op); lostAnswer(op, null); }
  }

  // An operation has at most one pending automatic read. Whichever read is accepted as current owns it: it ends the
  // chain on a terminal state or leaves exactly one successor, so a manual Check Again never orphans or doubles it. The
  // successor is scheduled only while the operation's automatic reads are not used up; nothing gives them back.
  function poll(op) {
    if (op.pollTimer) { clearTimeout(op.pollTimer); timers.delete(op.pollTimer); }
    if (op.polls >= DOWNLOAD_START_POLLS) { exhausted(op); render(); return; }
    op.polling = true;
    op.pollTimer = later(() => { op.pollTimer = null; readDownload(op, true); }, DOWNLOAD_POLL_MS);
    render();
  }
  function stopPolling(op) {
    if (op.pollTimer) { clearTimeout(op.pollTimer); timers.delete(op.pollTimer); }
    op.pollTimer = null;
    op.polling = false;
  }
  // The automatic reads are used up: the history and Check Again stay. Neither a non-start nor a supply is concluded.
  function exhausted(op) {
    stopPolling(op);
    op.notice = op.state === 'sending' ? TEXT.pollsEnded : TEXT.notStarted;
  }

  /** GET .../original-downloads/:operationId: the state the server recorded. Sent is not a saved file (5.3). */
  async function readDownload(op, polled = false, keepNotice = false) {
    if (!live(op)) return;
    if (!usable()) { stopPolling(op); op.lost = true; return; }
    if (polled) {
      // An automatic read is charged here, before it is sent, whichever answer later wins (D1691).
      if (op.polls >= DOWNLOAD_START_POLLS) { exhausted(op); render(); return; }
      op.polls++;
    }
    const gen = op.gen, seq = ++op.readSeq, at = work.capture('document');
    let answer = null;
    try {
      answer = await app.transport.request(app.api + '/studies/' + encodeURIComponent(op.uid) + '/original-downloads/'
        + encodeURIComponent(op.id), { context: at });
    } catch (_) {}
    const applied = work.commit(at, () => {
      // A read overtaken by a newer one changes nothing: neither the state, the notice nor the newer read's polling.
      if (!live(op) || op.gen !== gen || op.readSeq !== seq) return;
      const view = downloadPositive(answer, op);
      if (view) adoptDownload(op, view);
      op.notice = view ? (keepNotice ? op.notice : '') : TEXT.unread;
      if (op.polling || polled) {
        // Sent, Incomplete and Unconfirmed are the server's last word on this attempt; Ready, Downloading or an unreadable
        // answer keep one bounded successor read.
        if (['sent', 'incomplete', 'unconfirmed'].includes(op.state)) stopPolling(op);
        else if (op.polls < DOWNLOAD_START_POLLS) poll(op);
        else exhausted(op);
      } else if (op.state === 'sending') poll(op);
      store();
      render();
    });
    if (!applied) { if (op.readSeq === seq) stopPolling(op); lostAnswer(op, null); }
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
        // Recovery is an explicit server action; its reply does not authorize another payload send or certify a file.
        result.textContent = diagnostic(answer.body, '관리자 확인 요청 뒤 이 작업의 상태를 다시 확인하세요.');
        const op = operations.find(o => o.kind === 'import' && o.id === id);
        if (op) readImport(op);
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
    persistence.textContent = [persistenceFailed ? TEXT.storeFailed : '', legacy ? TEXT.legacy : ''].filter(Boolean).join(' ');
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
    if (op.files.some(f => !f.final && !unsent.has(f))) head.append(button('Import Again', () => choose(op.expect)));
    if (op.files.filter(f => f.file && sendable(f)).length > 1) head.append(button('Retry All', () => op.files.forEach(retry)));
    if (op.files.some(f => !f.final && !unsent.has(f))) head.append(button('Check Again', () => readImport(op)));
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
      li.append(button('Copy ID', () => copyId(f)));
      if (f.file && sendable(f)) li.append(button('Retry', () => retry(f)));
      rows.append(li);
    }
    box.append(rows);
    return box;
  }
  function stateName(f) {
    if (f.state === 'result') return OUTCOME_NAMES[f.outcome];
    return { waiting: 'Waiting', sending: 'Sending', unresolved: 'Not confirmed', notSent: 'Not Sent', refused: 'Not Sent' }[f.state] || 'Not confirmed';
  }
  function describe(f) { return f.message; }

  function drawDownload(op) {
    const box = node('section', 'study-transfer-op');
    box.dataset.operation = op.id;
    const head = node('div', 'study-transfer-op-head');
    head.append(node('b', null, 'Download Originals'), node('span', null, ' · ' + op.id.slice(0, 8) + (op.label ? ' · ' + op.label : '')));
    box.append(head);
    const line = node('p', 'study-transfer-download');
    const ready = op.state === 'prepared' && firstDownloads.has(op);
    line.append(node('span', 'study-transfer-state', ready ? 'Ready' : op.state && op.state !== 'prepared' ? DOWNLOAD_NAMES[op.state] : 'Not confirmed'),
      node('span', 'study-transfer-reason', downloadText(op)));
    box.append(line);
    if (op.notice) box.append(node('p', 'study-transfer-note', op.notice));
    if (ready && !op.polling && !op.inFlight) box.append(button('Download', () => start(op)));
    box.append(button('Copy ID', () => copyId({ op })));
    if (!op.inFlight) {
      box.append(button('Check Again', () => readDownload(op)));
      box.append(button('Prepare Again', () => download(op.uid)));
    }
    return box;
  }
  function downloadText(op) {
    if (op.state === 'prepared' && firstDownloads.has(op)) return TEXT.ready(op.objects, size(op.bytes));
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
