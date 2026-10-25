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

  function errorState(error = {}) {
    const code = error.code;
    if (code === 'W9_SELECTION_INVALID') return { status: 'Selection Invalid', code,
      message: '같은 환자의 검사를 2개에서 20개까지 선택하세요. 중복 검사는 포함할 수 없습니다.' };
    if (code === 'W9_PATIENT_MISMATCH') return { status: 'Context Changed', code,
      message: '원본 환자 ID가 다른 검사는 함께 열 수 없습니다. 선택 목록을 확인하세요.' };
    if (code === 'W9_CONTEXT_CHANGED') return { status: 'Context Changed', code,
      message: '선택·환자 정보 또는 로그인 상태가 바뀌었습니다. 목록에서 다시 여세요.' };
    if (code === 'STUDY_ACCESS_CHANGED') return { status: 'Context Changed', code,
      message: '검사 접근 조건이 변경되었습니다. 다시 불러온 뒤 확인하세요' };
    if (code === 'W9_AUDIT_UNAVAILABLE') return { status: 'Load Failed', code,
      message: '열람 기록을 저장하지 못했습니다. 잠시 후 Retry로 다시 시도하세요.' };
    return { status: 'Load Failed', code: code || null,
      message: '검사 정보를 확인하지 못했습니다. 잠시 후 Retry로 다시 시도하세요.' };
  }

  /** The page owns transport and windows. A begin result is an immutable request
   * intent; only finish() of that exact intent can supply a fresh launch plan.
   * Call cancel() when aborting transport, and end() on work-context termination.
   */
  function create({ context, selection, uuid = () => root.crypto.randomUUID() }) {
    const owner = { ...context() };
    let ended = false, sequence = 0, pending = null, composition = null, attempt = null, retry = null;
    function live() {
      if (!ended && !contextEqual(owner, context())) end();
      return !ended;
    }
    function snapshot() {
      live();
      return copy({ ended, pending: pending !== null, composition, attempt });
    }
    function current(intent) { return live() && pending === intent; }
    function begin(studyUids, compositionId, generation, expectedSourcePatientKey, intent) {
      if (!live()) return null;
      const body = Object.freeze({ compositionId, generation, requestId: uuid(),
        studyUids: Object.freeze([...studyUids]), expectedSourcePatientKey });
      pending = Object.freeze({ body, sequence: ++sequence, ...intent,
        activeUids: Object.freeze([...intent.activeUids]) });
      retry = pending;
      attempt = { status: 'Loading', sequence, activeUids: [...intent.activeUids], members: null };
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
    function beginRetry(value) {
      if (!live() || !retry) return null;
      // A failed candidate is retried as the same whole, still-unadmitted set.
      // It must not turn into a singleton of an older admitted composition.
      if (retry.kind === 'open' && composition?.compositionId !== retry.body.compositionId) {
        const { body, activeUids, page } = retry;
        return begin(body.studyUids, body.compositionId, body.generation, null, { kind: 'open', activeUids, page });
      }
      return navigate([value], 'retry');
    }
    function finish(intent, reply) {
      if (!current(intent)) return { status: 'ignored' };
      const validated = validateResponse(intent.body, reply);
      if (!validated) return fail(intent, { code: null });
      pending = null;
      const first = intent.kind === 'open';
      if (first && validated.scopeStatus !== 'ready') {
        attempt = { status: 'Not Opened', sequence: intent.sequence,
          activeUids: [...intent.activeUids], members: validated.members };
        return { status: 'not-admitted' };
      }
      if (first) {
        composition = { compositionId: intent.body.compositionId, generation: intent.body.generation,
          studyUids: [...intent.body.studyUids], sourcePatientKey: validated.sourcePatientKey,
          page: 0, mode: 'page', activeUids: [], members: [], blocked: false };
      }
      composition.members = validated.members;
      composition.activeUids = [...intent.activeUids];
      composition.page = intent.page;
      composition.mode = first ? 'page' : intent.kind;
      const ready = intent.activeUids.map(value => validated.members.find(member => member.uid === value))
        .filter(member => member.status === 'ready');
      attempt = { status: validated.scopeStatus === 'rejected' ? 'Load Failed' : validated.scopeStatus === 'partial' ? 'Partial' : 'Ready',
        sequence: intent.sequence, activeUids: [...intent.activeUids], members: copy(validated.members) };
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
      if (attempt.status === 'Context Changed') retry = null;
      if (attempt.status === 'Context Changed' && composition?.compositionId === intent.body.compositionId) composition.blocked = true;
      return { status: 'failed' };
    }
    function cancel() { pending = null; sequence++; }
    function end() {
      cancel(); ended = true; composition = null; retry = null;
      attempt = { status: 'Disconnected', message: '로그인 상태가 바뀌어 여러 검사 열기를 종료했습니다. 목록에서 다시 여세요.' };
    }
    return { snapshot, beginOpen, beginPage, beginCompare, beginSingle, backToPages, beginRetry, finish, fail, cancel, end };
  }
  const api = { orderedSelection, validateResponse, errorState, create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinMultiStudyView = api;
})(globalThis);
