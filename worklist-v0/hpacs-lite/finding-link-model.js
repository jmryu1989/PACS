/* Findings link saved display items to a finding record and navigate to their exact image.
 * The pure half (link state, refusal texts, reply shape, command shape and the async store that
 * owns every ticket/sequence decision) runs under Node; the DOM half lives in viewer-findings.js. */
(function (root) {
  'use strict';
  const LINK_STATES = ['current', 'revised', 'hidden', 'missing'];
  const LINK_LABELS = { current: 'Current', revised: 'Revised', hidden: 'Hidden', missing: 'Missing' };
  const LINK_TEXT = {
    current: '저장 당시 판과 같습니다.',
    revised: '표식이 저장 이후 수정되었습니다. 소견의 수치는 저장 당시 값이며 Refresh Link로 최신판을 다시 복사할 수 있습니다.',
    hidden: '표식이 숨겨졌습니다. 소견의 사본은 유지됩니다.',
    missing: '표식을 이 검사에서 찾을 수 없습니다. 소견의 사본은 유지됩니다.',
  };
  const REFERENCE_TEXT = { verified: 'Verified', unverified: 'Unverified' };
  const NAVIGATION_REASONS = ['invalid', 'ended', 'scope', 'busy', 'series-missing', 'viewport-unsupported', 'frame-missing', 'superseded', 'tool-missing'];
  // Viewport activation refusals of config/ohif.js (kinViewerActivateStudy) and every reason a Go to Image
  // into the other study of the same viewer can end with, the caller's 15 s bound included (S2-B2).
  const ACTIVATION_REASONS = ['invalid', 'ended', 'viewport-missing', 'viewport-ambiguous', 'viewport-unsupported', 'tool-missing'];
  const CROSS_REASONS = [...NAVIGATION_REASONS, 'viewport-missing', 'viewport-ambiguous', 'timeout'];
  const REASONS = {
    invalid: '이동할 영상 식별이 올바르지 않습니다.',
    ended: '로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.',
    scope: '이 소견의 검사가 현재 화면의 검사가 아닙니다. 해당 검사를 연 창에서 이동하세요.',
    busy: '현재 검사 접근과 보관 작업을 확인한 후 이동하세요.',
    'series-missing': '현재 검사에서 원본 시리즈를 찾을 수 없습니다.',
    'viewport-unsupported': '현재 화면은 원본 프레임 목록이 없는 MPR/볼륨 화면입니다. 일반 프레임 화면을 선택한 뒤 이동하세요.',
    'frame-missing': '원본 프레임을 열지 못했습니다.',
    superseded: '이동 중 화면이 바뀌어 이 이동을 취소했습니다. 다시 시도하세요.',
    'tool-missing': '영상 이동 도구가 준비되지 않았습니다. 뷰어를 다시 여세요.',
    'viewport-missing': '이 원본의 검사를 표시하는 영상 칸이 이 화면에 없습니다. 그 검사를 영상 칸에 표시한 뒤 다시 누르세요.',
    'viewport-ambiguous': '이 원본의 검사를 표시하는 영상 칸이 여러 개라 이동할 칸을 정하지 않았습니다. 그 검사의 영상 칸을 하나만 남긴 뒤 다시 누르세요.',
    timeout: '제한 시간 안에 원본 영상으로의 이동을 확인하지 못했습니다. 현재 영상을 확인한 뒤 다시 누르세요.',
  };
  // A comparison Go to Image that stopped after the active viewport moved never claims an unchanged display.
  const PHASE_TEXT = {
    activated: ' 원본 검사의 영상 칸이 선택되었을 수 있지만 원본 프레임으로는 이동하지 않았습니다. 이전 영상 칸 선택은 자동으로 되돌리지 않습니다.',
    navigating: ' 영상 화면은 이미 이동했을 수 있으니 현재 영상을 확인하세요.',
  };
  const ANCHOR_SCOPE_TEXT = '현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다. 현재 검사의 영상 칸을 선택한 뒤 다시 누르세요.';
  const COMPARISON_ARRIVAL = '비교 검사 영상 칸에서 원본 프레임으로 이동했습니다.';
  const COMPARISON_DENIED = '비교 검사에 접근할 수 없어 이 소견을 저장·수정하지 않았습니다. 비교 검사 표식 연결을 해제하거나 접근을 확인한 뒤 다시 시도하세요.';
  const ANNOTATION_TEXT = {
    shown: '', none: '', key: '키 이미지 프레임으로 이동했습니다.',
    hidden: '이동했습니다. 표식이 숨겨져 있어 그리지 않습니다.',
    unverified: '이동했습니다. 원본을 확인하지 못해 표식을 그리지 않습니다(재확인 필요).',
    missing: '이동했습니다. 표식이 현재 목록에 없어 그리지 않습니다.',
  };
  const LIMITS = Object.freeze({ sources: 8, title: 200, text: 4000, findings: 256 });
  const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(s);
  const revision = n => Number.isSafeInteger(n) && n >= 1 && n <= 2147483647;
  const clone = value => JSON.parse(JSON.stringify(value));

  // Same rule as the server (finding-input.ts linkState): a database fact about the head,
  // distinct from the Orthanc verified/unverified verdict of the viewer-items list.
  function linkState(source, head) {
    if (!source || !head || head.id !== source.itemId) return 'missing';
    if (source.studyUid !== undefined && head.studyUid !== undefined && head.studyUid !== source.studyUid) return 'missing';
    if (head.hidden) return 'hidden';
    if (head.revision !== source.revision) return 'revised';
    return 'current';
  }
  function reasonText(reason) { return REASONS[reason] || REASONS.invalid; }
  function annotationText(annotation) { return Object.prototype.hasOwnProperty.call(ANNOTATION_TEXT, annotation) ? ANNOTATION_TEXT[annotation] : ANNOTATION_TEXT.missing; }
  // Display descriptor of one source: the server link (authoritative when present), the client
  // head as a fallback for unsaved selections, and the separate reference verdict.
  function sourceStatus(source, link, head) {
    const state = link && LINK_STATES.includes(link.linkState) ? link.linkState : linkState(source, head);
    const referenceStatus = head && (head.referenceStatus === 'verified' || head.referenceStatus === 'unverified') ? head.referenceStatus : null;
    return { linkState: state, label: LINK_LABELS[state], text: LINK_TEXT[state], referenceStatus,
      referenceLabel: referenceStatus ? REFERENCE_TEXT[referenceStatus] : null,
      headRevision: link ? link.headRevision ?? null : head ? head.revision : null };
  }
  /* Copied measurement values (S2-V), display only. The server stores the viewer's numbers as sent and never
   * recomputes them, so names and units are a convention of the pinned calculator identity alone: the order of
   * config/ohif.js sample() ([length] | [angle] | [area, mean, min, max, count]) and the wording of
   * viewer-job-print.js (whose own rounding may show other decimals). `provenance` is required:
   * 'server-copy' (a finding source or a viewer-items read) needs the exact calculator; 'live-head' (the
   * Measurements panel's saved heads, which omit it) accepts it absent but not null. Any other provenance or
   * calculator, a wrong count (an empty list of a measurement kind included), a non-finite number, one that
   * toFixed would write in exponent form (>= 1e21) or a pixel count that is not a non-negative safe integer
   * shows every value, one decimal each, without names or units. Other kinds without values show nothing.
   * Values may come from another document: each is read once as a primitive. */
  const CALCULATOR = 'kin-native-manual-v1', ARITY = { length: 1, angle: 1, ellipse: 5 };
  const UNVERIFIED = '수치(단위 미확인): ';
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  // -0 and -0.04 round to -0, which toFixed writes as '0.0'; from 1e21 on toFixed would write String(n) anyway.
  const decimal = n => !finite(n) ? '?' : Math.abs(n) < 1e21 ? (Math.round(n * 10) / 10).toFixed(1) : String(n);
  function valueText(kind, calculator, values, provenance) {
    let list;
    try {
      if (!Array.isArray(values)) return '';
      list = Array.from({ length: values.length }, (_, i) => { const n = values[i]; return typeof n === 'number' ? n : null; });
    } catch (_) { return UNVERIFIED + '?'; }
    const arity = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ARITY, kind) ? ARITY[kind] : 0;
    if (!list.length && !arity) return '';
    const known = provenance === 'server-copy' ? calculator === CALCULATOR
      : provenance === 'live-head' ? calculator === undefined || calculator === CALCULATOR : false;
    const exact = known && list.length === arity && list.every(n => finite(n) && Math.abs(n) < 1e21) &&
      (kind !== 'ellipse' || (Number.isSafeInteger(list[4]) && list[4] >= 0));
    if (!exact) return UNVERIFIED + list.map(decimal).join(' / ');
    const [a, b, c, d] = list.map(decimal);
    if (kind === 'length') return a + ' mm';
    if (kind === 'angle') return a + '°';
    return '면적 ' + a + ' mm² · 평균 ' + b + ' HU · 최소 ' + c + ' HU · 최대 ' + d + ' HU · 화소 수 ' + String(list[4]);
  }
  const refusal = reason => ({ ok: false, reason });
  // Navigation reply from another window (S2-B): only the exact answer to this request counts.
  function validReply(message, expected) {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'kin-finding-nav-reply') return refusal('invalid');
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return refusal('invalid');
      for (const key of ['request', 'owner', 'activeUid'])
        if (typeof expected[key] !== 'string' || typeof message[key] !== 'string' || message[key] !== expected[key]) return refusal('invalid');
      if (!Array.isArray(expected.studies) || !Array.isArray(message.studies) || message.studies.length !== expected.studies.length ||
          message.studies.some((value, index) => value !== expected.studies[index])) return refusal('invalid');
      if (message.result === 'ok') {
        if (typeof message.highlighted !== 'boolean') return refusal('invalid');
        return { ok: true, highlighted: message.highlighted, annotation: typeof message.annotation === 'string' ? message.annotation : 'none' };
      }
      if (NAVIGATION_REASONS.includes(message.result)) return refusal(message.result);
      return refusal('invalid');
    } catch (_) { return refusal('invalid'); }
  }
  function validTarget(target) {
    return !!target && typeof target === 'object' && !Array.isArray(target) && uid(target.studyUid) && uid(target.seriesUid) &&
      uid(target.sopUid) && revision(target.frame) && (target.itemId === undefined || target.itemId === null || uuid(target.itemId));
  }

  /* ---------- Go to Image into the other study of the same viewer (S2-B2) ---------- */
  function phaseText(phase) { return PHASE_TEXT[phase] || ''; }
  // Values below may come from another window's realm: every field is read once and copied as a primitive.
  function plainImage(value) {
    try {
      if (!value || typeof value !== 'object') return null;
      const image = { study: value.study, seriesUid: value.seriesUid, sopUid: value.sopUid, frame: value.frame };
      return uid(image.study) && uid(image.seriesUid) && uid(image.sopUid) && revision(image.frame) ? image : null;
    } catch (_) { return null; }
  }
  function plainState(value) {
    try {
      if (!value || typeof value !== 'object') return null;
      const state = { scope: value.scope, subject: value.subject, ended: value.ended === true, suspended: value.suspended === true,
        loading: value.loading === true, generation: value.generation, viewportId: value.viewportId, image: plainImage(value.image) };
      return typeof state.scope === 'string' && typeof state.subject === 'string' && Number.isSafeInteger(state.generation) &&
        (state.viewportId === null || typeof state.viewportId === 'string') ? state : null;
    } catch (_) { return null; }
  }
  function viewerResult(value) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return refusal('invalid');
      const ok = value.ok;
      if (ok === true) {
        const highlighted = value.highlighted, annotation = value.annotation;
        return typeof highlighted === 'boolean' && typeof annotation === 'string' ? { ok: true, highlighted, annotation } : refusal('invalid');
      }
      const reason = ok === false ? value.reason : null;
      return typeof reason === 'string' && NAVIGATION_REASONS.includes(reason) ? refusal(reason) : refusal('invalid');
    } catch (_) { return refusal('invalid'); }
  }
  function activationResult(value) {
    try {
      if (!value || typeof value !== 'object') return { ok: false, reason: 'tool-missing', changed: false };
      const ok = value.ok, changed = value.changed === true, viewportId = value.viewportId, reason = value.reason;
      if (ok === true) return typeof viewportId === 'string' && viewportId ? { ok: true, viewportId, changed } : { ok: false, reason: 'tool-missing', changed };
      return { ok: false, reason: typeof reason === 'string' && ACTIVATION_REASONS.includes(reason) ? reason : 'tool-missing', changed };
    } catch (_) { return { ok: false, reason: 'tool-missing', changed: false }; }
  }
  const sameImage = (image, target) => !!image && image.study === target.studyUid && image.seriesUid === target.seriesUid &&
    image.sopUid === target.sopUid && image.frame === target.frame;
  const POLL_MS = 100;
  /* `env` reads ONE viewer document at call time: state() is its kinViewerHistoryState, activate(study)
   * its kinViewerHistoryActivate and navigate(target) its kinViewerHistoryNavigate. `control` belongs to
   * the caller, which owns the 15 s bound, its own session/document/selection checks and the message:
   * stopped() -> null | 'timeout' | 'superseded', wait(ms), phase(name). Exactly one viewport showing the
   * study is activated (the viewer decides), then the history of THAT viewport must load the study
   * (scope, not suspended, same login) before the one navigation call. Success needs the viewer's ok and,
   * afterwards, the same history generation and viewport showing the exact series/SOP/frame. There is no
   * fallback to another viewport, no retry and no viewport restoration. */
  async function crossNavigate(env, target, control) {
    const read = () => { try { return plainState(env.state()); } catch (_) { return null; } };
    const stopped = () => { try { return control.stopped(); } catch (_) { return 'superseded'; } };
    const mark = name => { try { control.phase(name); } catch (_) {} };
    if (!validTarget(target)) return refusal('invalid');
    const study = target.studyUid, start = read();
    if (!start) return refusal('tool-missing');
    if (start.ended) return refusal('ended');
    if (start.suspended) return refusal('busy');
    let stop = stopped();
    if (stop) return refusal(stop);
    let activation;
    try { activation = activationResult(env.activate(study)); } catch (_) { activation = activationResult(null); }
    if (activation.changed) mark('activated');
    if (!activation.ok) return refusal(activation.reason);
    const viewportId = activation.viewportId;
    let seen = start.viewportId === viewportId, ready = null;
    while (!ready) {
      stop = stopped();
      if (stop) return refusal(stop);
      const now = read();
      if (!now) return refusal('tool-missing');
      if (now.ended) return refusal('ended');
      if (now.subject !== start.subject) return refusal('superseded');
      // The activated viewport must become and stay active; any other active viewport is a user or layout change.
      if (now.viewportId === viewportId) seen = true;
      else if (seen || now.viewportId !== start.viewportId) return refusal('superseded');
      if (seen && now.scope === study) {
        if (!now.suspended) { ready = now; break; }
        // Loaded but refused, failed or holding parked marks: the viewer would refuse the navigation too.
        if (!now.loading) return refusal('busy');
      }
      await control.wait(POLL_MS);
    }
    mark('navigating');
    let value;
    try { value = await env.navigate(target); } catch (_) { return refusal('tool-missing'); }
    const result = viewerResult(value);
    stop = stopped();
    if (stop) return refusal(stop);
    if (!result.ok) return result;
    const after = read();
    if (!after || after.ended || after.suspended || after.subject !== start.subject || after.scope !== study ||
        after.generation !== ready.generation || after.viewportId !== viewportId) return refusal('superseded');
    return sameImage(after.image, target) ? result : refusal('frame-missing');
  }
  // The client sends only {itemId, revision} pairs; every copied field comes from the server.
  function commandBody(draft, head, action, reason, requestId) {
    const sources = Array.isArray(draft.sources) ? draft.sources.map(s => ({ itemId: s.itemId, revision: s.revision })) : [];
    const item = { schemaVersion: 1, title: String(draft.title ?? ''), text: String(draft.text ?? ''), sources,
      primary: Number.isSafeInteger(draft.primary) && draft.primary >= 0 && draft.primary < sources.length ? draft.primary : 0 };
    const body = { requestId, item };
    if (head) Object.assign(body, { expectedRevision: head.revision, action: action || 'edit', ...(reason ? { reason } : {}) });
    return body;
  }
  function draftProblem(draft) {
    if (!draft) return '작성 내용이 없습니다.';
    if (!Array.isArray(draft.sources) || draft.sources.length < 1) return '저장한 표식을 하나 이상 연결하세요.';
    if (draft.sources.length > LIMITS.sources) return '표식은 최대 ' + LIMITS.sources + '개까지 연결할 수 있습니다.';
    if (draft.sources.some(s => !uuid(s.itemId) || !revision(s.revision))) return '연결한 표식의 저장 정보를 확인하세요.';
    if (new Set(draft.sources.map(s => s.itemId)).size !== draft.sources.length) return '같은 표식을 두 번 연결할 수 없습니다.';
    if ([...String(draft.title ?? '')].length > LIMITS.title) return '제목은 ' + LIMITS.title + '자 이하여야 합니다.';
    if ([...String(draft.text ?? '')].length > LIMITS.text) return '본문은 ' + LIMITS.text + '자 이하여야 합니다.';
    if (!String(draft.title ?? '').trim() && !String(draft.text ?? '').trim()) return '제목 또는 본문을 입력하세요.';
    return null;
  }
  // A pair copied from the comparison study keeps that study in the draft for display only; commandBody never sends it.
  const itemOnly = head => ({ title: head.item.title, text: head.item.text, primary: head.item.primary ?? 0,
    sources: head.item.sources.map(s => uid(s.studyUid) && uid(head.studyUid) && s.studyUid !== head.studyUid
      ? { itemId: s.itemId, revision: s.revision, studyUid: s.studyUid } : { itemId: s.itemId, revision: s.revision }) });
  // `context.comparison`: the command named a comparison study, so 400/403/404 may be about that study.
  function errorMessage(error, context) {
    const comparison = !!(context && context.comparison);
    if (error.code === 'FINDING_STORAGE_LIMIT') return '소견 저장 한도입니다. 한도에는 이 화면에 표시되지 않는 소견도 포함됩니다. 숨김으로 공간이 회수되지는 않습니다. 작성 내용은 미저장 상태로 남아 있습니다.';
    if (error.code === 'FINDING_COMPARISON_STUDY') return '이 소견에는 이미 다른 비교 검사가 연결된 적이 있어 이 비교 검사의 표식을 연결할 수 없습니다. 이 비교 검사의 소견은 새 소견으로 기록하세요. 작성 내용은 저장되지 않았습니다.';
    if (error.code === 'FINDING_SOURCE_STALE') return error.headHidden ? '연결하려는 표식이 숨겨졌습니다. 연결을 해제하거나 표식을 복원한 뒤 다시 저장하세요.'
      : '연결하려는 표식에 더 새로운 판(r' + error.headRevision + ')이 있습니다. Refresh Link로 최신판을 확인한 뒤 다시 저장하세요.';
    if (error.status === 409) return '다른 판 또는 저장 조건과 충돌했습니다. 최신판을 확인한 뒤 다시 저장하세요.';
    if (error.status === 404) return comparison ? '소견이나 연결한 표식을 찾을 수 없거나 그 검사에 더 이상 접근할 수 없습니다. 작성 내용은 저장되지 않았습니다.'
      : '연결한 표식이 이 검사에 없습니다. 작성 내용은 저장되지 않았습니다.';
    if (error.status === 403 && comparison) return '비교 검사가 이 검사와 다른 기관 소속이거나 접근할 수 없어 연결하지 않았습니다. 작성 내용은 저장되지 않았습니다.';
    if (error.status === 400 && comparison) return '같은 환자의 비교 검사 하나만 연결할 수 있습니다. 비교 검사와 입력 내용을 확인하세요. 작성 내용은 저장되지 않았습니다.';
    if (error.status === 400 || error.status === 413) return '입력 길이와 연결 표식을 확인하세요. 작성 내용은 저장되지 않았습니다.';
    return '저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.';
  }
  // One viewer-items head of the comparison study, in the shape of kinViewerHistoryState().heads plus its
  // calculator, which only valueText reads.
  function comparisonHead(item, study) {
    if (!item || typeof item !== 'object' || !uuid(item.id) || item.studyUid !== study || !revision(item.revision) ||
        typeof item.hidden !== 'boolean' || !item.item || typeof item.item !== 'object') throw new Error('Invalid page');
    const body = item.item, values = body.baseline && Array.isArray(body.baseline.values) ? body.baseline.values : null;
    const calculator = body.baseline && typeof body.baseline.calculator === 'string' ? body.baseline.calculator : null;
    if (typeof body.kind !== 'string' || !uid(body.seriesUid) || !uid(body.sopUid) || !revision(body.frame)) throw new Error('Invalid page');
    return { id: item.id, studyUid: study, revision: item.revision, hidden: item.hidden, kind: body.kind,
      label: typeof body.label === 'string' ? body.label : typeof body.title === 'string' ? body.title : '',
      seriesUid: body.seriesUid, sopUid: body.sopUid, frame: body.frame, authorSub: typeof item.authorSub === 'string' ? item.authorSub : '',
      referenceStatus: item.referenceStatus === 'verified' || item.referenceStatus === 'unverified' ? item.referenceStatus : null,
      values: values && values.every(n => typeof n === 'number') ? [...values] : null, calculator, working: false };
  }
  const studySet = value => Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(uid) &&
    new Set(value).size === value.length ? [...value] : null;

  /* Unsaved, editing and pending findings survive a study switch, a 403 and a mode exit as held
   * copies bound to {subject, study}; only a logout, a 401 or a subject change destroys them. The
   * copy never shares an object with the entry an in-flight request still holds, so a late answer
   * cannot mutate or re-insert it, and its pending URL/body (with the requestId) stay byte-identical. */
  const heldKey = (subject, scope) => JSON.stringify([subject, scope]);
  function heldCopy(e) {
    return { id: e.id, head: e.head ? clone(e.head) : null, draft: clone(e.draft), links: clone(e.links || []), editing: !!e.editing,
      latest: e.latest ? clone(e.latest) : null, pending: e.pending ? { url: e.pending.url, body: e.pending.body } : null,
      busy: false, message: String(e.message || ''), staleSource: e.staleSource ? clone(e.staleSource) : null };
  }
  function heldRecords(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(r => r && typeof r.subject === 'string' && r.subject && uid(r.scope) && Array.isArray(r.entries) &&
      r.entries.every(e => e && typeof e.id === 'string' && e.draft && typeof e.draft === 'object' &&
        (e.pending === null || (typeof e.pending?.url === 'string' && typeof e.pending?.body === 'string'))))
      .map(r => ({ subject: r.subject, scope: r.scope, entries: r.entries.map(heldCopy) }));
  }

  /* The store owns scope, generation, read sequence and every pending request. `deps.fetch`,
   * `deps.uuid`, `deps.navigate` (window.kinViewerHistoryNavigate) and `deps.notify` are injected
   * so the same decisions run under Node with fake transports. `deps.recovered` carries the
   * records a previous store of this same document handed over with detach().
   * S2-B2: `deps.studies` is the viewer document's study set in URL order. With two studies the first
   * anchors the store and the second is its comparison study: activating the comparison viewport keeps
   * the anchor's entries, drafts and pending bodies, and the comparison heads come from that study's own
   * viewer-items list. `deps.history`/`deps.activate` read the viewer for crossNavigate; `deps.setTimeout`,
   * `deps.clearTimeout` and `deps.navigationMs` bound it. */
  function createStore(deps) {
    const fetchImpl = deps.fetch, makeId = deps.uuid, timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 30000;
    const later = typeof deps.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const cancelLater = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : id => clearTimeout(id);
    const navigationMs = Number.isFinite(deps.navigationMs) ? deps.navigationMs : 15000;
    const studies = studySet(deps.studies);
    const listeners = new Set();
    const s = { scope: '', subject: '', me: null, ended: false, generation: 0, readSequence: 0, loading: false, suspended: true,
      status: '', history: null, entries: new Map(), heads: new Map(), parked: new Map(), studies, navigation: 0,
      pair: { status: 'none', heads: new Map(), working: new Set(), key: '', sequence: 0, refused: false } };
    for (const record of heldRecords(deps.recovered)) s.parked.set(heldKey(record.subject, record.scope), record);
    let controller = typeof AbortController === 'function' ? new AbortController() : null;
    const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (_) {} } };
    const valid = ticket => !s.ended && ticket === s.generation;
    const writable = entry => !s.suspended && s.me?.kind === 'member' && Array.isArray(s.me.roles) && s.me.roles.includes('radiologist') &&
      (!entry || !entry.head || entry.head.authorSub === s.subject);
    const hasWork = e => !!(e.editing || e.pending || e.busy);
    const anchorOf = scope => studies && studies.length === 2 && studies.includes(scope) ? studies[0] : scope;
    const pairOf = () => studies && studies.length === 2 && s.scope === studies[0] ? studies[1] : '';
    // The anchor's saved heads are selectable only while its own viewport feeds the Measurements panel.
    const anchorLive = () => !!s.history && s.history.scope === s.scope && !!s.scope;
    function clearPair() {
      s.pair.sequence++; s.pair.heads = new Map(); s.pair.working = new Set(); s.pair.key = ''; s.pair.refused = false;
      s.pair.status = pairOf() ? 'idle' : 'none';
    }
    // Where a pair or copied source comes from: its own study, the saved copy of the same item, else the anchor.
    function studyOf(e, source) {
      if (source && uid(source.studyUid)) return source.studyUid;
      const copy = [...(e.head?.item.sources || []), ...(e.latest?.item.sources || [])].find(x => x.itemId === source?.itemId);
      return copy && uid(copy.studyUid) ? copy.studyUid : s.scope;
    }
    function comparisonOf(e) {
      const found = new Set();
      for (const x of [...(e.head?.item.sources || []), ...(e.draft?.sources || [])]) { const study = studyOf(e, x); if (study !== s.scope) found.add(study); }
      return [...found].sort().join(',');
    }
    // A refused comparison list blocks new commands on every entry that names a comparison study.
    const pairBlocked = e => s.pair.status === 'denied' && comparisonOf(e) !== '';
    function reset(message) {
      s.generation++; s.readSequence++; controller?.abort(); controller = typeof AbortController === 'function' ? new AbortController() : null;
      s.entries.clear(); s.loading = false; s.again = false; s.suspended = true; s.status = message; clearPair(); notify();
    }
    // Hold every entry with work for the current {subject, study} before the entries are cleared.
    function park() {
      if (!s.scope || !s.subject) return;
      const work = [...s.entries.values()].filter(hasWork);
      if (!work.length) return;
      const key = heldKey(s.subject, s.scope), record = s.parked.get(key) || { subject: s.subject, scope: s.scope, entries: [] };
      for (const e of work) { const copy = heldCopy(e); record.entries = record.entries.filter(x => x.id !== copy.id).concat([copy]); }
      s.parked.set(key, record);
    }
    // Called only after this study's list was read with the current login: the same subject, a
    // successful authorization of this study and a writable role. Otherwise the copies stay held.
    function restore() {
      const key = heldKey(s.subject, s.scope), record = s.parked.get(key);
      if (!record || !writable()) return;
      s.parked.delete(key);
      for (const copy of record.entries) {
        const current = s.entries.get(copy.id);
        if (current && hasWork(current)) continue;
        const e = heldCopy(copy);
        e.message = e.pending ? '보관했던 저장 요청을 복원했습니다. Retry Request로 저장 결과를 확인하세요.' : '보관했던 작성 내용을 복원했습니다. 저장 전 내용을 확인하세요.';
        s.entries.set(e.id, e);
      }
    }
    function heldEntries() { return [...s.parked.values()].reduce((n, r) => n + r.entries.length, 0); }
    // Counts and study identifiers only: the held text and sources are never shown before restore.
    function held() {
      const studies = [...s.parked.values()].filter(r => s.subject && r.subject === s.subject)
        .map(r => ({ scope: r.scope, count: r.entries.length, current: r.scope === s.scope }));
      return { count: studies.reduce((n, r) => n + r.count, 0), studies };
    }
    // Whole-viewer guard state: held copies are unsaved work too; only live entries can be in flight.
    function workState() {
      const live = [...s.entries.values()];
      return { dirty: live.some(hasWork) || heldEntries() > 0, busy: live.some(e => !!(e.busy || e.pending)), held: heldEntries() };
    }
    function discardHeld() {
      if (s.ended || !s.subject) return 0;
      let removed = 0;
      for (const [key, r] of [...s.parked]) if (r.subject === s.subject) { removed += r.entries.length; s.parked.delete(key); }
      notify(); return removed;
    }
    function end() {
      if (s.ended) return;
      s.parked.clear();
      reset('로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'); s.ended = true; s.me = null; s.subject = ''; notify();
    }
    // Mode exit: hand every entry with work to the next store of this document and stop this one.
    function detach() {
      if (s.ended) return [];
      park();
      const records = heldRecords([...s.parked.values()]);
      s.parked.clear(); reset(''); s.ended = true; s.me = null; notify();
      return records;
    }
    function deny() { park(); reset('이 검사에 접근할 수 없습니다. 접근 확인 후 Refresh로 다시 불러오세요.'); s.me = null; }
    // `foreign`: a 403 may concern the comparison study, so it is returned to the caller instead of
    // holding this study's drafts; the caller re-reads the anchor list, which denies if the anchor is gone.
    async function api(path, options, ticket, foreign) {
      options = options || {};
      const parentSignal = controller?.signal, request = typeof AbortController === 'function' ? new AbortController() : null;
      const abort = () => request?.abort();
      parentSignal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        const res = await fetchImpl('/api' + path, { ...options, cache: 'no-store', credentials: 'same-origin', signal: request?.signal,
          headers: { 'X-KIN-CSRF': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
        if (!valid(ticket)) throw { stale: true };
        if (res.status === 401 || (res.status === 403 && path === '/me')) { end(); throw { stale: true }; }
        if (res.status === 403 && !foreign) { deny(); throw { stale: true }; }
        const data = await res.json().catch(() => null);
        if (!valid(ticket)) throw { stale: true };
        if (!res.ok || !data) throw { status: res.status, code: data?.code, headRevision: data?.headRevision ?? null, headHidden: data?.headHidden ?? null, itemId: data?.itemId ?? null };
        return data;
      } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
    }
    async function authenticate(ticket) {
      const user = await api('/me', {}, ticket);
      if (!user || !user.sub || (s.subject && s.subject !== user.sub)) { end(); throw { stale: true }; }
      s.me = user; s.subject = user.sub;
      // Copies handed over from another login are never restored or counted for this one.
      for (const [key, r] of [...s.parked]) if (r.subject !== s.subject) s.parked.delete(key);
      return user;
    }
    const path = () => '/studies/' + s.scope + '/findings';
    function setScope(scope) {
      if (s.ended || scope === s.scope) return;
      park();
      reset(scope ? '소견 확인 중…' : '');
      s.scope = uid(scope) ? scope : '';
      clearPair();
      if (s.scope) load();
    }
    // The Measurements panel is the source of truth for saved heads and their reference verdict. Its
    // scope follows the active viewport; the store follows only the anchor of that scope.
    function syncHistory(state) {
      if (s.ended) return;
      if (!state || typeof state !== 'object') { s.history = null; return; }
      if (state.ended) { end(); return; }
      const heads = Array.isArray(state.heads) ? state.heads : [];
      const key = JSON.stringify([state.scope, state.suspended, heads.map(h => [h.id, h.revision, h.hidden, h.referenceStatus, h.working])]);
      const changed = key !== s.historyKey;
      s.historyKey = key; s.history = state;
      const anchor = anchorOf(state.scope), moved = anchor !== s.scope;
      if (moved) s.heads = new Map();
      if (state.scope === anchor) s.heads = new Map(heads.map(h => [h.id, h]));
      if (moved) { setScope(anchor); return; }
      // While the comparison viewport is active its panel marks items being edited; a changed saved set
      // (or a new activation) re-reads the comparison list.
      const onPair = !!pairOf() && state.scope === pairOf();
      const pairKey = onPair ? JSON.stringify(heads.map(h => [h.id, h.revision, h.hidden])) : '';
      s.pair.working = new Set(onPair ? heads.filter(h => h.working).map(h => h.id) : []);
      if (pairKey !== s.pair.key) { s.pair.key = pairKey; if (onPair) loadPair(); }
      if (changed) notify();
    }
    async function load() {
      if (!s.scope || s.ended || s.loading) return;
      const ticket = s.generation, seq = ++s.readSequence; s.loading = true;
      s.status = '소견 확인 중…'; notify();
      try {
        await authenticate(ticket);
        const heads = []; let cursor = null;
        do {
          const page = await api(path() + '?includeHidden=true&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {}, ticket);
          if (seq !== s.readSequence) return;
          if (!page || !Array.isArray(page.items) || heads.length + page.items.length > LIMITS.findings || (cursor && page.nextCursor === cursor)) throw new Error('Invalid page');
          heads.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        if (!valid(ticket) || seq !== s.readSequence) return;
        s.suspended = false;
        restore();
        const seen = new Set();
        for (const head of heads) {
          if (!uuid(head.id) || !head.item || !Array.isArray(head.item.sources)) throw new Error('Invalid page');
          seen.add(head.id);
          let e = s.entries.get(head.id);
          if (e && hasWork(e)) {
            if (head.revision !== e.head?.revision) { e.latest = head; e.message = '서버에 다른 판이 있습니다. 작성 내용은 유지됩니다.'; }
            else { e.head = head; e.links = head.links || []; }
            continue;
          }
          if (!e) { e = { id: head.id }; s.entries.set(e.id, e); }
          Object.assign(e, { head, draft: itemOnly(head), links: head.links || [], editing: false, latest: null, pending: null, busy: false, message: '', staleSource: null });
        }
        let dropped = 0;
        for (const [id, e] of [...s.entries]) {
          if (!e.head || seen.has(id) || e.busy) continue;
          if (!hasWork(e)) s.entries.delete(id);
          else if (!lose(e)) dropped++;
        }
        s.status = heads.length + '개 소견 · 소견 저장은 판독 확정과 별개입니다.' +
          (dropped ? ' · 결과를 확인하지 못한 숨김·복원 요청이 있던 소견을 더 이상 볼 수 없어 목록에서 뺐습니다.' : '');
        if (pairOf()) loadPair();
      } catch (e) { if (!e.stale && valid(ticket)) s.status = '소견 목록을 확인하지 못했습니다. Refresh로 다시 확인하세요.'; }
      finally {
        // A comparison refusal seen during this read asks for one more read of the anchor list.
        if (ticket === s.generation) { s.loading = false; if (s.again) { s.again = false; Promise.resolve().then(load); } }
        notify();
      }
    }
    /* The authoritative list no longer contains a finding this login was working on (for example its
     * comparison study was withdrawn): nothing copied from it stays on screen. An edit keeps only the
     * user's own title and text, with the pairs of this study, as a new unsaved draft of this study that
     * is saved only by an explicit Save; a pending hide/restore is dropped. Returns false when dropped. */
    function lose(e) {
      s.entries.delete(e.id);
      if (!e.editing) return false;
      const own = e.draft.sources.filter(p => studyOf(e, p) === s.scope).map(p => ({ itemId: p.itemId, revision: p.revision }));
      Object.assign(e, { id: makeId(), head: null, links: [], latest: null, pending: null, staleSource: null, editing: true, busy: false,
        draft: { title: e.draft.title, text: e.draft.text, sources: own, primary: 0 },
        message: '이 소견을 더 이상 볼 수 없어 저장하지 않았습니다. 작성한 제목과 본문만 이 검사의 새 소견 초안으로 남겼고 비교 검사 연결은 뺐습니다. 저장 전 내용과 연결 표식을 확인하세요.' });
      s.entries.set(e.id, e);
      return true;
    }
    // Saved, non-hidden heads of the comparison study from its own list; the pair ticket drops a late or
    // superseded answer, and a refusal clears the heads without a trace of their content.
    async function loadPair() {
      const study = pairOf();
      if (!study || s.ended || s.suspended || !s.subject) return;
      const ticket = s.generation, seq = ++s.pair.sequence, subject = s.subject, anchor = s.scope;
      const current = () => valid(ticket) && seq === s.pair.sequence && s.subject === subject && s.scope === anchor;
      s.pair.status = 'loading'; notify();
      try {
        const items = []; let cursor = null;
        do {
          const page = await api('/studies/' + study + '/viewer-items?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {}, ticket, true);
          if (!current()) return;
          if (!page || !Array.isArray(page.items) || items.length + page.items.length > 512 || (cursor && page.nextCursor === cursor)) throw new Error('Invalid page');
          items.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        const heads = items.map(item => comparisonHead(item, study)).filter(h => !h.hidden);
        if (!current()) return;
        s.pair.heads = new Map(heads.map(h => [h.id, h])); s.pair.status = 'ready'; s.pair.refused = false;
      } catch (error) {
        if (!current()) return;
        s.pair.heads = new Map();
        s.pair.status = error && (error.status === 403 || error.status === 404) ? 'denied' : 'failed';
        // Findings naming that study are no longer readable either; the anchor list drops them, once per
        // refusal (the flag survives superseded reads and clears only with an answered list or a new anchor).
        if (s.pair.status === 'denied' && !s.pair.refused) { s.pair.refused = true; if (s.loading) s.again = true; else load(); }
      } finally { if (current()) notify(); }
    }
    function newDraft() {
      if (s.ended || s.suspended || !writable()) return null;
      const e = { id: makeId(), head: null, draft: { title: '', text: '', sources: [], primary: 0 }, links: [], editing: true, latest: null, pending: null, busy: false, message: '', staleSource: null };
      s.entries.set(e.id, e); notify(); return e;
    }
    function updateDraft(e, patch) {
      if (s.entries.get(e.id) !== e || !e.editing || e.busy || e.pending) return;
      if (typeof patch.title === 'string') e.draft.title = patch.title;
      if (typeof patch.text === 'string') e.draft.text = patch.text;
    }
    // Selection only from saved heads that are visible and not mid-edit; a new pair always
    // takes the current head revision, so the server copies exactly that revision. `study` names the
    // comparison study for its own list; an entry never mixes two comparison studies.
    function toggleSource(e, itemId, study) {
      if (s.entries.get(e.id) !== e || !e.editing || e.busy || e.pending) return false;
      const index = e.draft.sources.findIndex(x => x.itemId === itemId);
      if (index >= 0) { e.draft.sources.splice(index, 1); if (e.draft.primary >= e.draft.sources.length) e.draft.primary = 0; notify(); return true; }
      if (e.draft.sources.length >= LIMITS.sources) return false;
      if (study === undefined || study === s.scope) {
        const head = s.heads.get(itemId);
        if (!anchorLive() || !head || head.hidden || head.working) return false;
        e.draft.sources.push({ itemId, revision: head.revision }); notify(); return true;
      }
      const pair = pairOf(), head = s.pair.heads.get(itemId), other = comparisonOf(e);
      if (!pair || study !== pair || s.pair.status !== 'ready' || (other && other !== pair)) return false;
      if (!head || head.hidden || s.pair.working.has(itemId)) return false;
      e.draft.sources.push({ itemId, revision: head.revision, studyUid: pair }); notify(); return true;
    }
    function setPrimary(e, index) {
      if (s.entries.get(e.id) !== e || !e.editing || e.busy || e.pending) return;
      if (Number.isSafeInteger(index) && index >= 0 && index < e.draft.sources.length) { e.draft.primary = index; notify(); }
    }
    // Explicit refresh is an edit that replaces one {itemId, revision} pair by the current head
    // pair; ordinary text edits keep every existing pair and therefore every frozen copy.
    function refreshSource(e, itemId) {
      if (s.entries.get(e.id) !== e || !e.head || e.busy || e.pending || !writable(e) || pairBlocked(e)) return false;
      const link = (e.links || []).find(l => l.itemId === itemId);
      const head = studyOf(e, { itemId }) === s.scope ? s.heads.get(itemId) : s.pair.heads.get(itemId);
      const target = link && link.headRevision ? { revision: link.headRevision, hidden: !!link.headHidden } : head ? { revision: head.revision, hidden: !!head.hidden } : null;
      const pair = e.draft.sources.find(x => x.itemId === itemId);
      if (!pair || !target || target.hidden || target.revision === pair.revision) return false;
      pair.revision = target.revision; e.staleSource = null;
      if (!e.editing) return save(e, 'edit');
      e.message = '최신판을 연결했습니다. 저장을 눌러야 새 사본이 기록됩니다.'; notify(); return true;
    }
    function useLatest(e) {
      if (s.entries.get(e.id) !== e || !e.latest || e.busy || e.pending) return;
      e.head = e.latest; e.latest = null; e.links = e.head.links || e.links;
      if (!e.editing) e.draft = itemOnly(e.head);
      e.message = e.editing ? '최신판을 확인했습니다. 저장을 눌러야 내 수정이 반영됩니다.' : '최신 서버판을 반영했습니다.'; notify();
    }
    function discard(e) {
      if (s.entries.get(e.id) !== e || e.busy || e.pending) return;
      if (!e.head) { s.entries.delete(e.id); notify(); return; }
      e.editing = false; e.draft = itemOnly(e.head); e.staleSource = null; e.message = ''; notify();
    }
    function edit(e) {
      if (s.entries.get(e.id) !== e || !e.head || e.head.hidden || e.busy || e.pending || !writable(e) || pairBlocked(e)) return;
      e.editing = true; notify();
    }
    async function save(e, action, reason) {
      if (!valid(s.generation) || s.entries.get(e.id) !== e || !writable(e) || e.busy || s.ended) return false;
      // Computed before the request: a pending retry keeps the context of the body it replays.
      const comparison = comparisonOf(e) !== '';
      if (!e.pending) {
        if (e.head && action !== 'edit' && action !== 'hide' && action !== 'restore') return false;
        if (!e.head && action && action !== 'create') return false;
        if (pairBlocked(e)) { e.message = COMPARISON_DENIED; notify(); return false; }
        const problem = draftProblem(e.draft);
        if (problem) { e.message = problem; notify(); return false; }
        const body = commandBody(e.draft, e.head, action, reason, makeId());
        e.pending = { url: path() + (e.head ? '/' + e.head.id + '/revisions' : ''), body: JSON.stringify(body) };
      }
      const ticket = s.generation; e.busy = true; notify();
      try {
        await authenticate(ticket);
        const head = await api(e.pending.url, { method: 'POST', body: e.pending.body }, ticket, comparison);
        if (!valid(ticket) || !s.entries.has(e.id)) return false;
        if (!uuid(head?.id) || !head.item || !Array.isArray(head.item.sources)) throw { status: 200 };
        const duplicate = s.entries.get(head.id);
        if (duplicate && duplicate !== e && hasWork(duplicate)) {
          s.entries.delete(e.id); duplicate.message = '같은 요청의 저장 결과를 확인했습니다. 이 항목의 작성 내용은 유지됩니다.'; return true;
        }
        if (duplicate && duplicate !== e) s.entries.delete(duplicate.id);
        s.entries.delete(e.id); e.id = head.id; s.entries.set(e.id, e);
        Object.assign(e, { head, draft: itemOnly(head), links: e.links, pending: null, latest: null, editing: false, staleSource: null, message: '저장 완료' });
        notify();
        // Link states are a server fact of the current heads; refresh them after every write.
        await load();
        return true;
      } catch (error) {
        if (error.stale || !valid(ticket)) return false;
        e.message = errorMessage(error, { comparison });
        if (error.status >= 400 && error.status < 500) e.pending = null;
        if (error.code === 'FINDING_SOURCE_STALE') e.staleSource = { itemId: error.itemId, headRevision: error.headRevision, headHidden: error.headHidden };
        else if (error.status === 409 && error.code !== 'FINDING_COMPARISON_STUDY') await load();
        // A saved finding that answers 404 may have become unreadable, and a comparison 403 may hide an
        // anchor refusal: the authoritative list decides (lose() or deny()) and the draft stays otherwise.
        else if ((error.status === 404 && e.head) || (error.status === 403 && comparison)) { e.busy = false; await load(); }
        else if (error.status === 404 && comparison) loadPair();
        return false;
      } finally { if (valid(ticket) && s.entries.has(e.id)) { e.busy = false; notify(); } }
    }
    async function navigate(e, index) {
      if (!valid(s.generation) || s.entries.get(e.id) !== e || !e.head) return refusal('invalid');
      const sources = e.head.item.sources, at = Number.isSafeInteger(index) ? index : (e.head.item.primary ?? 0);
      const source = sources[at];
      if (!source) return refusal('invalid');
      const go = deps.navigate;
      const ticket = s.generation;
      const target = { studyUid: source.studyUid ?? s.scope, seriesUid: source.seriesUid, sopUid: source.sopUid, frame: source.frame, itemId: source.itemId };
      if (target.studyUid !== s.scope && validTarget(target)) return navigateAcross(e, target);
      let result;
      if (typeof go !== 'function') result = refusal('tool-missing');
      else {
        if (!validTarget(target)) result = refusal('invalid');
        else { try { result = await go(target); } catch (_) { result = refusal('tool-missing'); } }
      }
      if (!result || typeof result !== 'object') result = refusal('invalid');
      if (!valid(ticket) || s.entries.get(e.id) !== e) return refusal('superseded');
      // In a two-study viewer the anchor's source needs the anchor's own viewport selected. The viewer refused
      // with its live scope, so that scope (not the snapshot synced every 250 ms) names the viewport to select.
      const shown = result.reason === 'scope' ? liveScope() : '';
      const away = !!shown && shown !== s.scope && !!studies && studies.includes(shown);
      e.message = result.ok ? annotationText(result.annotation) : away ? ANCHOR_SCOPE_TEXT : reasonText(result.reason);
      notify(); return result;
    }
    // The viewer's current history scope for this same login, read once through deps.history; '' when unknown.
    function liveScope() {
      try {
        const h = typeof deps.history === 'function' ? deps.history() : null;
        const scope = h && h.scope, subject = h && h.subject, ended = h && h.ended;
        return typeof scope === 'string' && !!s.subject && subject === s.subject && ended !== true ? scope : '';
      } catch (_) { return ''; }
    }
    // A source of the comparison study: only through crossNavigate within the 15 s bound; the newest
    // Go to Image of this store, an anchor/session change or a replaced entry stops it.
    async function navigateAcross(e, target) {
      const ticket = s.generation, seq = ++s.navigation;
      const history = deps.history, activate = deps.activate, go = deps.navigate;
      let result, phase = 'before', expired = false, timer = null;
      if (target.studyUid !== pairOf()) result = refusal('scope');
      else if (s.pair.status === 'denied') result = refusal('busy');
      else if (typeof history !== 'function' || typeof activate !== 'function' || typeof go !== 'function') result = refusal('tool-missing');
      else {
        const live = () => valid(ticket) && seq === s.navigation && s.entries.get(e.id) === e;
        const control = { stopped: () => expired ? 'timeout' : live() ? null : 'superseded', phase: name => { phase = name; },
          wait: ms => new Promise(resolve => later(resolve, ms)) };
        const bound = new Promise(resolve => { timer = later(() => { expired = true; resolve(refusal('timeout')); }, navigationMs); });
        try { result = await Promise.race([crossNavigate({ state: history, activate, navigate: go }, target, control), bound]); }
        catch (_) { result = refusal('tool-missing'); }
        finally { cancelLater(timer); }
      }
      if (!valid(ticket) || seq !== s.navigation || s.entries.get(e.id) !== e) return { ...refusal('superseded'), phase };
      e.message = result.ok ? COMPARISON_ARRIVAL + (annotationText(result.annotation) ? ' ' + annotationText(result.annotation) : '')
        : reasonText(result.reason) + phaseText(phase);
      notify(); return { ...result, phase };
    }
    async function history(e, cursor) {
      if (!valid(s.generation) || s.entries.get(e.id) !== e || !e.head) return null;
      const ticket = s.generation;
      const data = await api(path() + '/' + e.head.id + '/revisions?limit=50' + (cursor ? '&cursor=' + cursor : ''), {}, ticket);
      if (!valid(ticket) || s.entries.get(e.id) !== e) return null;
      return data;
    }
    return { state: () => s, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, valid, writable, hasWork, held, workState,
      discardHeld, detach, pairOf, anchorLive, studyOf, comparisonOf, pairBlocked, loadPair,
      setScope, syncHistory, load, newDraft, updateDraft, toggleSource, setPrimary, refreshSource, useLatest, discard, edit, save, navigate, history, end,
      dispose: () => { listeners.clear(); controller?.abort(); } };
  }

  const api = { LINK_STATES, LINK_LABELS, NAVIGATION_REASONS, ACTIVATION_REASONS, CROSS_REASONS, LIMITS, linkState, sourceStatus, valueText, reasonText, annotationText,
    phaseText, validReply, validTarget, plainState, viewerResult, activationResult, crossNavigate, comparisonHead,
    commandBody, draftProblem, itemOnly, errorMessage, createStore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.kinFindingLinkModel = api;
})(globalThis);
