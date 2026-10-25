/* W9 viewing composition. The resolve reply authorizes fresh metadata only;
 * this model never promotes it to image-display evidence or selects a report.
 * Wire limits are those of multi-study-view.service.ts (2–20 members).
 */
(function (root) {
  'use strict';
  const memberCodes = new Set(['W9_MEMBER_UNAVAILABLE', 'W9_SCOPE_EXCLUDED',
    'W9_IDENTITY_UNAVAILABLE', 'STUDY_IDENTITY_UNRESOLVED', 'W9_LOAD_FAILED']);
  const metadataFields = ['patientId', 'patientName', 'institutionName', 'studyDate', 'description', 'accession'];
  const copy = value => value === null ? null : JSON.parse(JSON.stringify(value));
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  const uid = value => typeof value === 'string' && value.length <= 64 && /^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/.test(value);
  const key = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
  const contextEqual = (a, b) => !!a && !!b && !!a.owner && !!a.session && a.owner === b.owner && a.session === b.session;
  // The existing display bound of the Reading Workspace (reading-workspace.js: 45000 ms) and the W9 prep contract; it starts
  // at an accepted viewer opening, never at the resolve click. Not a new transport timer.
  const DISPLAY_TIMEOUT_MS = 45000;

  function orderedSelection(studyUids, readingUid) {
    if (!Array.isArray(studyUids) || studyUids.length < 2 || studyUids.length > 20 ||
        studyUids.some(value => !uid(value)) || new Set(studyUids).size !== studyUids.length) return null;
    return studyUids.includes(readingUid)
      ? [readingUid, ...studyUids.filter(value => value !== readingUid)] : [...studyUids];
  }

  function validateResponse(body, reply) {
    if (!reply || reply.compositionId !== body.compositionId || reply.generation !== body.generation ||
        reply.requestId !== body.requestId || !Array.isArray(reply.members) ||
        reply.members.length !== body.studyUids.length) return null;
    let ready = 0;
    const refs = new Set(), members = [];
    for (let ordinal = 0; ordinal < body.studyUids.length; ordinal++) {
      const member = reply.members[ordinal];
      if (!member || member.uid !== body.studyUids[ordinal] || member.ordinal !== ordinal) return null;
      if (member.status === 'ready') {
        const meta = member.metadata;
        if (!meta || metadataFields.some(name => typeof meta[name] !== 'string') ||
            !Array.isArray(meta.modalities) || meta.modalities.some(value => typeof value !== 'string') ||
            typeof member.accessRef !== 'string' || !member.accessRef.trim() || refs.has(member.accessRef) ||
            member.code !== undefined) return null;
        ready++; refs.add(member.accessRef);
        members.push({ uid: member.uid, ordinal, status: 'ready',
          metadata: Object.fromEntries([...metadataFields.map(name => [name, meta[name]]), ['modalities', [...meta.modalities]]]),
          accessRef: member.accessRef });
      } else if (member.status === 'error' && memberCodes.has(member.code) &&
          member.metadata === undefined && member.accessRef === undefined) {
        members.push({ uid: member.uid, ordinal, status: 'error', code: member.code });
      } else return null;
    }
    const scope = ready === members.length ? 'ready' : ready ? 'partial' : 'rejected';
    if (reply.scopeStatus !== scope || (ready ? !key(reply.sourcePatientKey) : reply.sourcePatientKey !== null) ||
        (ready && body.expectedSourcePatientKey !== null && reply.sourcePatientKey !== body.expectedSourcePatientKey)) return null;
    return { scopeStatus: scope, sourcePatientKey: reply.sourcePatientKey, members };
  }

  // One member's own answer (prep ui-contract "Member errors"). An error member carries only uid/ordinal/code, so the row
  // shows its ordinal and this text; no earlier name, Accession or label stays on it.
  const MEMBER_STATES = {
    W9_MEMBER_UNAVAILABLE: ['Access Restricted', '검사를 열 수 없습니다. 접근 권한과 목록을 확인한 뒤 Retry로 다시 시도하세요.'],
    W9_SCOPE_EXCLUDED: ['Access Restricted', '같은 소속 기관의 검사만 함께 열 수 있습니다. 원격판독 중인 검사는 제외하세요.'],
    W9_IDENTITY_UNAVAILABLE: ['Unverified', '원본 환자 ID를 확인할 수 없어 함께 열지 않았습니다. Retry로 다시 확인하세요.'],
    STUDY_IDENTITY_UNRESOLVED: ['Unverified', '환자 식별 불일치로 이 검사를 사용할 수 없습니다. 원본 확인이 필요합니다.'],
    W9_LOAD_FAILED: ['Load Failed', '이 검사의 영상을 불러오지 못했습니다. Retry로 다시 시도하세요.'],
  };
  function memberState(code) {
    const [status, message] = MEMBER_STATES[code] || MEMBER_STATES.W9_LOAD_FAILED;
    return { status, message, code };
  }

  /**
   * A request-level answer, by status and code only (never the server's message text). `retry` is false where the same
   * request cannot succeed (an invalid selection, a refused role or institution, a changed patient or context): the reader
   * starts again from the list.
   */
  function errorState(error = {}) {
    const code = error.code, status = error.status;
    const state = (name, message, retry) => ({ status: name, code: code || null, message, retry });
    if (code === 'W9_SELECTION_INVALID') return state('Selection Invalid',
      '같은 환자의 검사를 2개에서 20개까지 선택하세요. 중복 검사는 포함할 수 없습니다.', false);
    if (code === 'W9_PATIENT_MISMATCH') return state('Context Changed',
      '원본 환자 ID가 다른 검사는 함께 열 수 없습니다. 선택 목록을 확인하세요.', false);
    if (code === 'W9_CONTEXT_CHANGED') return state('Context Changed',
      '선택·환자 정보 또는 로그인 상태가 바뀌었습니다. 목록에서 다시 여세요.', false);
    if (code === 'STUDY_ACCESS_CHANGED') return state('Context Changed',
      '검사 접근 조건이 변경되었습니다. 다시 불러온 뒤 확인하세요', false);
    if (code === 'W9_AUDIT_UNAVAILABLE') return state('Load Failed',
      '열람 기록을 저장하지 못했습니다. 잠시 후 Retry로 다시 시도하세요.', true);
    if (code === 'W9_VIEW_FORBIDDEN' || code === 'CLINICIAN_ROUTE_DENIED') return state('Access Restricted',
      '여러 검사 열기는 판독의 권한이 필요합니다.', false);
    if (code === 'GATEWAY_IDENTITY_INVALID') return state('Access Restricted',
      '현재 로그인으로 여러 검사를 열 수 없습니다. 목록에서 다시 여세요.', false);
    if (code === 'INSTITUTION_PENDING' || code === 'INSTITUTION_INVALID' || (status === 403 && !code)) return state('Access Restricted',
      '기관 또는 업무 역할 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.', false);
    // The session transport already owns an authentication answer; this is only the W9 line beside it.
    if (error.auth) return status === 401
      ? state('Disconnected', '로그인 상태를 확인할 수 없습니다. 목록에서 다시 여세요.', false)
      : state('Context Changed', '로그인 요청 상태를 확인할 수 없습니다. 목록에서 다시 여세요.', false);
    if (!code && (status === 400 || status === 413)) return state('Selection Invalid',
      '요청한 검사 목록을 처리할 수 없습니다. 선택 목록을 확인한 뒤 다시 여세요.', false);
    // Local launch outcomes (no server answer is involved).
    if (code === 'W9_POPUP_BLOCKED') return state('Popup Blocked', '영상 창이 차단되었습니다. 팝업을 허용한 뒤 Retry를 누르세요.', true);
    if (code === 'W9_VIEWER_BUSY') return state('Not Opened', error.message || '기존 영상의 저장·복원 또는 미저장 작업을 확인한 뒤 다시 여세요.', true);
    return state('Load Failed', '검사 정보를 확인하지 못했습니다. 잠시 후 Retry로 다시 시도하세요.', true);
  }

  /** The page owns transport and windows. A begin result is an immutable request
   * intent; only finish() of that exact intent can supply a fresh launch plan.
   * Call cancel() when aborting transport, and end() on work-context termination.
   */
  function create({ context, selection, uuid = () => root.crypto.randomUUID() }) {
    const owner = { ...context() };
    let ended = false, sequence = 0, pending = null, composition = null, attempt = null, candidate = null, candidateAttempt = null, failed = null, resolved = null;
    function live() {
      if (!ended && !contextEqual(owner, context())) end();
      return !ended;
    }
    function snapshot() {
      live();
      return copy({ ended, pending: pending !== null, composition, attempt, candidateAttempt,
        retry: !!failed || !!(candidate && composition?.compositionId !== candidate.body.compositionId) });
    }
    function current(intent) { return live() && pending === intent; }
    function begin(studyUids, compositionId, generation, expectedSourcePatientKey, intent) {
      if (!live()) return null;
      resolved = null;
      const body = Object.freeze({ compositionId, generation, requestId: uuid(),
        studyUids: Object.freeze([...studyUids]), expectedSourcePatientKey });
      pending = Object.freeze({ body, sequence: ++sequence, ...intent,
        activeUids: Object.freeze([...intent.activeUids]) });
      if (intent.kind === 'open') { candidate = pending; candidateAttempt = null; }
      failed = null;
      attempt = { status: 'Loading', sequence, activeUids: [...intent.activeUids], members: null,
        message: composition ? '검사 접근 상태를 다시 확인하는 중입니다…' : '선택한 검사를 확인하는 중입니다…' };
      return pending;
    }
    function beginOpen(chosen, readingUid) {
      if (!live()) return null;
      const now = selection();
      // Generation also distinguishes a menu opened before A → B → A selection.
      if (!chosen || !now || !contextEqual(owner, chosen) || !contextEqual(owner, now) ||
          chosen.generation !== now.generation || !Array.isArray(chosen.studyUids) ||
          !Array.isArray(now.studyUids) || !same(chosen.studyUids, now.studyUids)) {
        attempt = errorState({ code: 'W9_CONTEXT_CHANGED' });
        return null;
      }
      const studyUids = orderedSelection(chosen.studyUids, readingUid);
      if (!studyUids) { attempt = errorState({ code: 'W9_SELECTION_INVALID' }); return null; }
      return begin(studyUids, uuid(), 1, null, { kind: 'open', activeUids: studyUids.slice(0, 2), page: 0 });
    }
    function navigate(activeUids, kind, page = composition?.page) {
      if (!live() || !composition || composition.blocked || !Array.isArray(activeUids) ||
          activeUids.length < 1 || activeUids.length > 2 || new Set(activeUids).size !== activeUids.length ||
          activeUids.some(value => !composition.studyUids.includes(value))) return null;
      return begin(composition.studyUids, composition.compositionId, composition.generation,
        composition.sourcePatientKey, { kind, activeUids, page });
    }
    function beginPage(page) {
      if (!live() || !composition || !Number.isInteger(page) || page < 0 || page >= Math.ceil(composition.studyUids.length / 2)) return null;
      return navigate(composition.studyUids.slice(page * 2, page * 2 + 2), 'page', page);
    }
    function beginCompare(pair) { return Array.isArray(pair) && pair.length === 2 ? navigate(pair, 'compare') : null; }
    function beginSingle(value) { return navigate([value], 'single'); }
    function backToPages() { return beginPage(composition?.page); }
    // A row belongs to the admitted composition. Only the top Retry can retry a different, unadmitted selection.
    function beginRetry(value) {
      if (!live()) return null;
      return navigate([value], 'retry');
    }
    /**
     * Retry of a request that failed as a whole (transport, audit 503, a blocked popup): the same intent with a new
     * requestId. Without such a failure it is the retry of an unadmitted candidate (first answer partial or rejected).
     */
    function beginRetryAttempt() {
      if (!live()) return null;
      const intent = failed || (candidate && composition?.compositionId !== candidate.body.compositionId ? candidate : null);
      if (!intent) return null;
      const { body, kind, activeUids, page } = intent;
      if (kind === 'open' && composition?.compositionId !== body.compositionId)
        return begin(body.studyUids, body.compositionId, body.generation, null, { kind, activeUids, page });
      return navigate(activeUids, kind, page);
    }
    function finish(intent, reply) {
      if (!current(intent)) return { status: 'ignored' };
      const validated = validateResponse(intent.body, reply);
      if (!validated) return fail(intent, { code: null });
      pending = null;
      const first = intent.kind === 'open';
      if (first && validated.scopeStatus !== 'ready') {
        attempt = { status: 'Not Opened', sequence: intent.sequence, activeUids: [...intent.activeUids], members: validated.members,
          message: validated.scopeStatus === 'partial' ? '선택한 검사를 모두 확인하지 못해 함께 열지 않았습니다. 오류를 확인한 뒤 Retry를 누르세요.'
            : '열 수 있는 검사를 확인하지 못했습니다. 오류를 확인한 뒤 Retry를 누르세요.' };
        candidateAttempt = copy(attempt);
        return { status: 'not-admitted' };
      }
      resolved = { intent, previous: copy(composition) };
      if (first) {
        composition = { compositionId: intent.body.compositionId, generation: intent.body.generation,
          studyUids: [...intent.body.studyUids], sourcePatientKey: validated.sourcePatientKey,
          page: 0, mode: 'page', activeUids: [], members: [], blocked: false };
        candidate = null; candidateAttempt = null;
      }
      composition.members = validated.members;
      composition.activeUids = [...intent.activeUids];
      composition.page = intent.page;
      composition.mode = first ? 'page' : intent.kind;
      const ready = intent.activeUids.map(value => validated.members.find(member => member.uid === value))
        .filter(member => member.status === 'ready');
      attempt = { status: validated.scopeStatus === 'rejected' ? 'Load Failed' : validated.scopeStatus === 'partial' ? 'Partial' : 'Ready',
        sequence: intent.sequence, activeUids: [...intent.activeUids], members: copy(validated.members),
        message: validated.scopeStatus === 'rejected' ? '열 수 있는 검사를 확인하지 못했습니다. 오류를 확인한 뒤 Retry를 누르세요.'
          : validated.scopeStatus === 'partial' ? '일부 검사를 열 수 없습니다. 해당 검사의 오류와 Retry를 확인하세요.'
            : '검사 접근 상태를 확인했습니다. 영상 표시를 기다립니다.' };
      // Failed slots remain in activeUids. Only this response's ready members
      // enter the viewer; a singleton always carries an explicit null prior.
      return { status: ready.length ? 'resolved' : 'not-opened', sequence: intent.sequence,
        compositionId: composition.compositionId, activeUids: [...intent.activeUids],
        members: copy(ready), uid: ready[0]?.uid ?? null, priorUid: ready[1]?.uid ?? null,
        preservePartner: intent.kind === 'retry' };
    }
    function fail(intent, error) {
      if (!current(intent)) return { status: 'ignored' };
      pending = null;
      attempt = { ...errorState(error), sequence: intent.sequence, activeUids: [...intent.activeUids] };
      failed = attempt.retry ? intent : null;
      if (intent.kind === 'open') candidateAttempt = copy(attempt);
      if (attempt.status === 'Context Changed') { candidate = null; candidateAttempt = null; }
      if (attempt.status === 'Context Changed' && composition?.compositionId === intent.body.compositionId) composition.blocked = true;
      return { status: 'failed' };
    }
    function rejectLaunch(plan, error) {
      if (!live() || resolved?.intent.sequence !== plan.sequence) return;
      const { intent, previous } = resolved;
      // Ready metadata alone must not replace the admitted set when the viewer keeps its old document.
      composition = previous;
      if (intent.kind === 'open') candidate = intent;
      attempt = { ...errorState(error), sequence: intent.sequence, activeUids: [...intent.activeUids] };
      if (intent.kind === 'open') candidateAttempt = copy(attempt);
      failed = attempt.retry ? intent : null;
      resolved = null;
    }
    function cancel() { pending = null; sequence++; }
    function end() {
      cancel(); ended = true; composition = null; candidate = null; candidateAttempt = null; failed = null; resolved = null;
      attempt = { status: 'Disconnected', message: '로그인 상태가 바뀌어 여러 검사 열기를 종료했습니다. 목록에서 다시 여세요.' };
    }
    return { snapshot, beginOpen, beginPage, beginCompare, beginSingle, backToPages, beginRetry, beginRetryAttempt,
      finish, fail, rejectLaunch, cancel, end };
  }

  /**
   * The W9 host on the worklist page (main.html #multi-study) and its owned viewer channel.
   *
   * The page hands in what it already has: the session work gate (work), the owner/session (context), the selection
   * snapshot, the W4 Reading Target and its guarded select, the W5 mode's reason, the session transport (resolve) and the
   * existing launcher in phases (viewer.reserve in the click, viewer.launch after the answer, viewer.release of an unused
   * reservation). Nothing here writes a report, a hold or any clinical row, stores the composition, or decides patient or
   * institution admission: the server's resolve does.
   *
   * Displayed comes only from the opened viewer's own renderer (viewer-multi-study.js over the channel `kin-w9:<opening>`
   * named in the viewer URL's fragment): one member's original Study/Series/SOP/frame rendered visibly in that opening.
   * A launch, a load, an HTTP 200 or the partner's image is never display evidence for a member.
   */
  function mount(o) {
    const work = o.work, host = o.host, $ = selector => host.querySelector(selector);
    const summary = $('#multi-study-summary'), status = $('#multi-study-status'), identity = $('#multi-study-identity');
    const candidateStatus = $('#multi-study-candidate');
    const list = $('#multi-study-members'), title = $('#multi-study-title');
    const previous = $('#multi-study-prev'), next = $('#multi-study-next'), compare = $('#multi-study-compare');
    const pages = $('#multi-study-pages'), retry = $('#multi-study-retry'), close = $('#multi-study-close');
    let model = null, inflight = null, opening = null, refusal = null, picks = [], note = null, ended = false;
    let reporting = null, signature = '';
    let retained = [];
    const viewers = () => [opening, ...retained].filter(Boolean);
    const viewingUids = () => [...new Set(viewers().flatMap(v => v.uids))];
    const viewerFor = value => viewers().find(v => v.uids.includes(value));
    const uuid = () => root.crypto.randomUUID();
    const pageCount = c => Math.ceil(c.studyUids.length / 2);

    function ensureModel() {
      if (model && !model.snapshot().ended) return model;
      model = create({ context: o.context, selection: o.selection, uuid });
      return model;
    }
    /** The selection-scoped menu's frozen snapshot, or null when the row is not part of a multi-selection. */
    function menu() {
      const chosen = o.selection();
      return chosen && Array.isArray(chosen.studyUids) && chosen.studyUids.length >= 2 ? chosen : null;
    }
    function open(chosen) {
      if (ended) return;
      note = null;
      if (!o.allowed()) { note = '서버 연결과 로그인 상태를 확인한 뒤 다시 여세요.'; render(); return; }
      run(ensureModel().beginOpen(chosen, o.target()));
      if (!host.hidden) title.focus({ preventScroll: true });
    }
    function supersede() {
      if (!inflight) return;
      const old = inflight; inflight = null;
      old.controller.abort();
      o.viewer.release(old.reservation);
    }
    /** One intent: reserve the viewer in this click, resolve the original N, then launch only what this answer made ready. */
    function run(intent) {
      if (!intent) { render(); return; }
      supersede(); refusal = null;
      const composition = model.snapshot().composition;
      const preserveStudies = intent.kind === 'retry' ? (composition?.mode === 'retry' ? viewingUids() : composition?.activeUids || [])
        .filter(value => !intent.activeUids.includes(value) && viewerFor(value)) : [];
      const reservation = o.viewer.reserve(intent.activeUids, { preserveStudies });
      if (reservation.status === 'blocked' || reservation.status === 'refused') {
        model.fail(intent, { code: reservation.status === 'blocked' ? 'W9_POPUP_BLOCKED' : 'W9_VIEWER_BUSY', message: reservation.message });
        render(); return;
      }
      const controller = new AbortController(), at = work.capture('document');
      inflight = { intent, reservation, controller };
      render();
      Promise.resolve().then(() => o.resolve(intent.body, controller.signal, at)).then(
        reply => { if (!work.commit(at, () => answered(intent, reply))) dropped(intent); },
        error => { if (!work.commit(at, () => failedRequest(intent, error))) dropped(intent); });
    }
    function dropped(intent) {
      if (inflight?.intent !== intent) return;
      o.viewer.release(inflight.reservation); inflight = null;
    }
    function answered(intent, reply) {
      if (inflight?.intent !== intent) return;
      const reservation = inflight.reservation; inflight = null;
      const plan = model.finish(intent, reply);
      if (plan.status !== 'resolved') { o.viewer.release(reservation); render(); return; }
      launch(plan, reservation);
    }
    function failedRequest(intent, error) {
      if (inflight?.intent !== intent) return;
      const reservation = inflight.reservation; inflight = null;
      o.viewer.release(reservation);
      // Our own abort never gets here (supersede() forgets the request first) and an ended work context fails the commit.
      // Any other cancellation is a request-level unknown: Load Failed with Retry, never a Loading left behind.
      model.fail(intent, error?.name === 'AbortError' ? {} : error || {});
      render();
    }
    function launch(plan, reservation) {
      const id = uuid(), uids = plan.members.map(member => member.uid);
      const metadata = new Map(plan.members.map(member => [member.uid, member.metadata]));
      const result = o.viewer.launch(reservation, plan, id, metadata);
      if (result?.status !== 'accepted') {
        o.viewer.release(reservation);
        const error = result?.status === 'blocked' ? { code: 'W9_POPUP_BLOCKED' }
          : { code: 'W9_VIEWER_BUSY', message: result?.message };
        model.rejectLaunch(plan, error);
        refusal = { compositionId: plan.compositionId, uids, ...errorState(error) };
        render(); return;
      }
      bind(id, uids, reservation.preservePartner, result.isOpen);
      render();
    }
    // ── the opened viewer's channel ──
    function bind(id, uids, preservePartner, isOpen) {
      if (preservePartner && viewingUids().some(value => !uids.includes(value))) {
        const keep = viewers().filter(viewer => viewer.uids.some(value => !uids.includes(value)));
        for (const viewer of viewers().filter(viewer => !keep.includes(viewer))) {
          clearTimeout(viewer.timer);
          try { viewer.channel?.postMessage({ type: 'replaced', opening: viewer.id }); } catch (_) {}
          viewer.channel?.close();
        }
        retained = keep;
      } else unbind('replaced');
      const at = work.capture('document');
      const current = { id, uids, isOpen, states: new Map(uids.map(value => [value, 'Loading'])), expired: false, channel: null, timer: null };
      try {
        current.channel = new BroadcastChannel('kin-w9:' + id);
        current.channel.onmessage = event => work.commit(at, () => message(current, event.data));
      } catch (_) { current.channel = null; }
      current.timer = setTimeout(() => work.commit(at, () => expire(current)), DISPLAY_TIMEOUT_MS);
      opening = current;
    }
    function pruneClosed() {
      for (const viewer of viewers()) {
        if (viewer.isOpen?.() !== false) continue;
        clearTimeout(viewer.timer); viewer.channel?.close();
        if (opening === viewer) opening = null;
        retained = retained.filter(v => v !== viewer);
      }
    }
    function unbind(reason) {
      for (const viewer of viewers()) {
        clearTimeout(viewer.timer);
        try { viewer.channel?.postMessage({ type: reason, opening: viewer.id }); } catch (_) {}
        viewer.channel?.close();
      }
      opening = null; retained = [];
    }
    function expire(current) {
      if (!viewers().includes(current)) return;
      current.expired = true;
      for (const [value, state] of current.states) if (state === 'Loading') current.states.set(value, 'Unverified');
      render();
    }
    function message(current, m) {
      // Late events of an older opening, even for the same UID again (A → B → A), never reach the current one.
      if (!viewers().includes(current) || !m || typeof m !== 'object' || m.opening !== current.id) return;
      if (m.type === 'hello') { post(); return; }
      // The strip's buttons: the same bounded page commands as the host's (the reservation reuses the held window).
      if (m.type === 'intent' && ['previous', 'next', 'pages'].includes(m.action)) { command(m.action); return; }
      if (m.type === 'failed') {
        // A whole renderer failure invalidates even a member shown earlier in this document. Retry starts a new opening.
        current.expired = true;
        clearTimeout(current.timer);
        for (const value of current.states.keys()) current.states.set(value, 'Unverified');
        render(); return;
      }
      if (current.expired) return;
      const state = current.states.get(m.study);
      if (m.type === 'displayed' && state && uid(m.series) && uid(m.sop) && Number.isSafeInteger(m.frame) && m.frame >= 1) {
        if (state === 'Loading' || state === 'No Images') { current.states.set(m.study, 'Displayed'); render(); }
      } else if (m.type === 'no-images' && state === 'Loading') {
        current.states.set(m.study, 'No Images'); render();
      }
    }
    function post() {
      if (!viewers().length) return;
      const s = model?.snapshot(), c = s?.composition;
      try {
        for (const viewer of viewers()) viewer.channel?.postMessage({ type: 'state', opening: viewer.id, summary: summaryText(s),
          status: s?.attempt?.status ?? null, busy: !!inflight,
          canPrevious: !!c && !inflight && !c.blocked && c.page > 0, canNext: !!c && !inflight && !c.blocked && c.page < pageCount(c) - 1,
          canPages: !!c && !inflight && !c.blocked && c.mode !== 'page',
          members: c ? c.studyUids.map((value, ordinal) => ({ ordinal, viewing: viewingUids().includes(value), state: rowState(value, c).status,
            label: label(c.members[ordinal]) })) : [] });
      } catch (_) {}
    }
    // ── page actions ──
    function command(action) {
      const s = model?.snapshot(), c = s?.composition;
      if (ended || inflight || reporting || !c || c.blocked) return;
      note = null;
      if (action === 'previous' && c.page > 0) run(model.beginPage(c.page - 1));
      else if (action === 'next' && c.page < pageCount(c) - 1) run(model.beginPage(c.page + 1));
      else if (action === 'pages' && c.mode !== 'page') run(model.backToPages());
    }
    function compareTwo() {
      if (ended || inflight || picks.length !== 2) return;
      const pair = [...picks]; picks = []; note = null;
      run(model.beginCompare(pair));
    }
    function view(value) { if (!ended && !inflight) { note = null; run(model.beginSingle(value)); } }
    function retryMember(value) { if (!ended && !inflight) { note = null; run(model.beginRetry(value)); } }
    function retryAttempt() { if (!ended && !inflight) { note = null; run(model.beginRetryAttempt()); } }
    /**
     * Select for Reporting: the one W9 action that moves the Reading Target, only through W4's guarded select. The token
     * travels with that select so the page can tell this explicit move (the composition stays) from an ordinary W4 move
     * (which ends it). Anything but same/clear/saved, or a different final target, leaves the target and the text as W4 left
     * them, with W4's own Notice.
     */
    function selectForReporting(value) {
      if (ended || inflight || reporting) return;
      const why = o.relatedBlock();
      if (why) { note = why; render(); return; }
      const token = Object.freeze({ uid: value }), at = work.capture('document');
      reporting = token; note = null; render();
      const settle = result => {
        if (reporting !== token) return;
        reporting = null;
        const moved = ['same', 'clear', 'saved'].includes(result?.status) && o.target() === value;
        if (!moved) { render(); return; }
        // The new Reading Target's own image, through the same guarded launch. A workspace pane belongs to its Reading Target
        // (reading-workspace.js hides a pane of another target), so there it is requested even when already in view.
        pruneClosed();
        const shown = !!viewerFor(value) && !o.viewer.bindsTarget?.();
        if (!shown && model?.snapshot().composition) run(model.beginSingle(value));
        else render();
      };
      let result;
      try { result = o.select(value, token); } catch (_) { result = null; }
      if (result instanceof Promise) result.then(r => work.commit(at, () => settle(r)), () => work.commit(at, () => settle(null)));
      else settle(result);
    }
    /** W4 entered a study. An explicit W9 Select for Reporting keeps the composition; any other successful move ends it. */
    function entered(value, token) {
      if (ended || !model) return;
      if (token && token === reporting) return;
      finishComposition();
    }
    function finishComposition() {
      supersede();
      unbind('ended');
      model?.end(); model = null; refusal = null; picks = []; note = null; reporting = null;
      render();
    }
    // ── rendering ──
    function label(member) {
      if (!member || member.status !== 'ready') return 'Study ' + ((member?.ordinal ?? 0) + 1);
      const m = member.metadata, date = o.formatDate ? o.formatDate(m.studyDate) : m.studyDate;
      return ['Study ' + (member.ordinal + 1), date || '—', m.modalities.join(', ') || '—', m.accession || '—', m.description || '—'].join(' · ');
    }
    function summaryText(s) {
      const c = s?.composition;
      if (!c) return s?.attempt ? 'Not Opened' : '';
      const mode = c.mode === 'compare' ? 'Compare' : c.mode === 'single' || c.mode === 'retry' ? 'Single Study' : 'Pages';
      return 'Studies ' + c.studyUids.length + ' · Page ' + (c.page + 1) + '/' + pageCount(c) + ' · ' + mode;
    }
    function rowState(value, c) {
      const member = c.members.find(m => m.uid === value);
      if (member?.status === 'error') return memberState(member.code);
      const viewer = viewerFor(value);
      if (viewer) {
        const state = viewer.states.get(value);
        const text = { Loading: '영상을 불러오는 중입니다…', Displayed: '이 검사의 원본 영상이 화면에 표시되었습니다.',
          Unverified: '영상 표시를 확인하지 못했습니다. 창 상태를 확인한 뒤 Retry로 다시 시도하세요.', 'No Images': '표시할 영상 없음' }[state];
        return { status: state, message: text };
      }
      if (refusal?.compositionId === c.compositionId && refusal.uids.includes(value)) return refusal;
      return { status: 'Not Opened', message: '이 검사의 영상은 아직 열지 않았습니다.' };
    }
    function button(text, action, disabled, why) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = text;
      b.disabled = !!disabled; if (why) b.title = why; b.onclick = action; return b;
    }
    function render() {
      pruneClosed();
      const s = model?.snapshot() ?? null, c = s?.composition ?? null, attempt = s?.attempt ?? null;
      host.hidden = ended || !s || (!c && !attempt);
      if (host.hidden) { list.replaceChildren(); signature = ''; post(); return; }
      const busy = !!inflight || !!reporting, blocked = !!c?.blocked;
      summary.textContent = summaryText(s);
      const text = attempt ? [attempt.status, attempt.message].filter(Boolean).join(' · ') : '';
      const statusText = note ? [text, note].filter(Boolean).join(' · ') : text;
      if (status.textContent !== statusText) status.textContent = statusText;
      const candidate = c && s.candidateAttempt;
      candidateStatus.hidden = !candidate;
      const candidateLines = [];
      if (candidate) {
        candidateLines.push('New Selection · ' + candidate.status + ' · ' + candidate.message);
        for (const member of candidate.members || []) if (member.status === 'error') {
          const state = memberState(member.code);
          candidateLines.push(label(member) + ' · ' + state.status + ' · ' + state.message);
        }
      }
      if (candidateStatus.textContent !== candidateLines.join('')) {
        candidateStatus.replaceChildren(...candidateLines.map(text => {
          const line = document.createElement('div'); line.textContent = text; return line;
        }));
      }
      previous.disabled = busy || !c || blocked || c.page <= 0;
      next.disabled = busy || !c || blocked || c.page >= pageCount(c) - 1;
      pages.disabled = busy || !c || blocked || c.mode === 'page';
      compare.disabled = busy || !c || blocked || picks.length !== 2;
      retry.hidden = !s.retry || busy; retry.disabled = busy;
      const target = o.target();
      const targetText = target ? o.targetLabel(target) || target : 'None';
      const viewingText = c && viewingUids().length ? viewingUids().map(value => 'Study ' + (c.studyUids.indexOf(value) + 1)).join(', ') : 'None';
      identity.textContent = 'Viewing: ' + viewingText + ' · Reading Target: ' + targetText;
      const rows = c ? c.studyUids.map((value, ordinal) => ({ value, ordinal, member: c.members[ordinal] }))
        : (attempt?.members || []).map(member => ({ value: member.uid, ordinal: member.ordinal, member }));
      const why = o.relatedBlock();
      const key = JSON.stringify([rows.map(r => [r.value, r.member, c ? rowState(r.value, c) : null]), picks, busy, blocked, target,
        why, viewingUids(), c?.activeUids]);
      if (key !== signature) {
        signature = key;
        const focused = document.activeElement && list.contains(document.activeElement)
          ? [document.activeElement.closest('li')?.dataset.uid, document.activeElement.dataset.action] : null;
        list.replaceChildren(...rows.map(({ value, ordinal, member }) => {
          const li = document.createElement('li'); li.dataset.uid = value;
          const ready = member?.status === 'ready';
          const state = c ? rowState(value, c) : member?.status === 'error' ? memberState(member.code) : { status: 'Ready', message: '' };
          li.className = 'multi-study-member' + (c?.activeUids.includes(value) ? ' active' : '');
          const head = document.createElement('span'); head.className = 'multi-study-label';
          head.textContent = label(member || { ordinal });
          const marks = document.createElement('span'); marks.className = 'multi-study-marks';
          marks.textContent = [viewerFor(value) && c ? 'Viewing' : '', value === target ? 'Reading Target' : ''].filter(Boolean).join(' · ');
          const line = document.createElement('span'); line.className = 'multi-study-state';
          line.textContent = [state.status, state.message].filter(Boolean).join(' · ');
          li.append(head, marks, line);
          if (c) {
            const actions = document.createElement('span'); actions.className = 'multi-study-actions';
            const pick = document.createElement('label'); const box = document.createElement('input'); box.type = 'checkbox';
            box.checked = picks.includes(value); box.disabled = busy || blocked || !ready; box.dataset.action = 'pick';
            box.onchange = () => { picks = box.checked ? [...picks.filter(x => x !== value), value].slice(-2) : picks.filter(x => x !== value); render(); };
            pick.append(box, ' Compare'); pick.title = '두 검사를 고른 뒤 Compare Two를 누르세요. 먼저 고른 검사가 왼쪽입니다.';
            const viewButton = button('View Study', () => view(value), busy || blocked || !ready);
            viewButton.dataset.action = 'view';
            const reportButton = button('Select for Reporting', () => selectForReporting(value), busy || blocked || !ready || value === target || !!why, why || '');
            reportButton.dataset.action = 'report';
            actions.append(pick, viewButton, reportButton);
            if (!ready || state === refusal || ['Unverified', 'No Images'].includes(state.status)) {
              const again = button('Retry', () => retryMember(value), busy || blocked); again.dataset.action = 'retry';
              actions.append(again);
            }
            li.append(actions);
          }
          return li;
        }));
        if (focused) list.querySelector(`li[data-uid="${CSS.escape(focused[0] || '')}"] [data-action="${focused[1]}"]:not(:disabled)`)?.focus();
      }
      post();
    }
    previous.onclick = () => command('previous');
    next.onclick = () => command('next');
    pages.onclick = () => command('pages');
    compare.onclick = compareTwo;
    retry.onclick = retryAttempt;
    close.onclick = () => finishComposition();
    function end() {
      if (ended) return;
      supersede(); unbind('ended'); model?.end(); ended = true; watched.disconnect(); host.hidden = true; list.replaceChildren();
    }
    // Another feature's visible state that this host's controls depend on (W5's Related Report mode element): when it is
    // shown or hidden the reason on Select for Reporting follows at once, not only at the next W9 action.
    const watched = new MutationObserver(() => { if (!ended) render(); });
    for (const element of o.watch || []) if (element) watched.observe(element, { attributes: true, attributeFilter: ['hidden'] });
    work.onInvalidate(event => { if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) end(); });
    root.addEventListener('pagehide', end);
    render();
    return { open, menu, entered, refresh: render, end, close: finishComposition };
  }

  const api = { orderedSelection, validateResponse, errorState, memberState, create, mount, DISPLAY_TIMEOUT_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinMultiStudyView = api;
})(globalThis);
