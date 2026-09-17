/* Worklist Image Findings (S2-B1): a read-only list of the selected study's findings and an explicit
 * Go to Image into the one viewer that already shows that study. The pure half here owns every
 * decision (list ticket and page validation, target choice, pre-call refusal, the call/timeout race,
 * post-await identity and the result shape) and runs under Node; reading-findings.js only reads the
 * documents and renders. Navigation never opens, replaces or re-scopes a viewer and never writes. */
(function (root) {
  'use strict';
  const links = typeof module === 'object' && module.exports ? require('./finding-link-model.js') : root.kinFindingLinkModel;
  const VIEWER_REASONS = links.NAVIGATION_REASONS;
  const LIST_LIMIT = links.LIMITS.findings, PAGE = 100;
  const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(s);
  const count = n => Number.isSafeInteger(n) && n >= 1 && n <= 2147483647;
  const text = s => typeof s === 'string';
  const refusal = reason => ({ ok: false, reason });

  // A viewer that may already have moved is never described as unchanged (review C7).
  const TEXT = {
    session: '로그인과 검사 접근 상태를 확인한 뒤 다시 누르세요.',
    foreign: '이 원본은 선택한 검사의 영상이 아니어서 이동하지 않았습니다.',
    'list-changed': '소견 목록이 바뀌어 이동하지 않았습니다. 목록을 확인한 뒤 다시 누르세요.',
    loading: '영상 화면을 준비하는 중입니다. 영상이 표시된 뒤 다시 누르세요.',
    ambiguous: '이 검사를 표시하는 영상 창이 여러 개라 이동할 창을 정하지 않았습니다. 창을 하나만 남긴 뒤 다시 누르세요.',
    unattached: '이 검사를 연 영상 창이 목록 새로고침 뒤 아직 연결되지 않았습니다. Open Image로 그 창을 다시 연결한 뒤 다시 누르세요.',
    'no-viewer': '이 검사를 표시하는 영상 화면이 없습니다. Open Image로 연 뒤 다시 누르세요. 자동으로 이동하지 않습니다.',
    owner: '영상 화면의 계정이 현재 로그인과 다릅니다. 영상 화면을 닫고 다시 연 뒤 이동하세요.',
    modal: '영상 화면에 열린 대화상자가 있습니다. 닫은 뒤 다시 누르세요.',
    scope: '영상 화면에서 이 검사가 아닌 영상 칸이 선택되어 있습니다. 그 화면에서 이 검사의 영상 칸을 선택한 뒤 다시 누르세요.',
    superseded: '이동을 확인하는 동안 선택·로그인·영상 화면이 바뀌어 성공으로 처리하지 않았습니다. 영상 화면은 이미 이동했을 수 있으니 현재 영상을 확인하세요.',
    timeout: '이동 결과를 확인하지 못했습니다. 영상 화면은 이미 이동했을 수 있으니 현재 영상을 확인한 뒤 다시 누르세요.',
  };
  function reasonText(reason) { return TEXT[reason] || links.reasonText(reason); }
  const retryable = reason => reason !== 'invalid' && reason !== 'foreign' && reason !== 'list-changed';
  const openable = reason => reason === 'no-viewer' || reason === 'unattached';
  function arrivalText(result, where) {
    const note = links.annotationText(result && result.annotation);
    return '영상 이동 확인 · ' + where + (note ? ' · ' + note : '');
  }
  const READINESS = {
    loading: '이동 대상: 영상 준비 중', ambiguous: '이동 대상 미정: 이 검사를 표시하는 영상 창이 여러 개입니다',
    unattached: '이동 대상 미연결: Open Image로 기존 영상 창을 다시 연결하세요', 'no-viewer': '이동 대상 없음: Open Image로 영상을 여세요',
    owner: '이동 대상 확인 불가: 다른 계정의 영상 창입니다', invalid: '',
  };
  function readinessText(choice) {
    if (!choice) return '';
    if (choice.kind === 'embedded') return '이동 대상: 통합 작업공간 영상';
    if (choice.kind === 'window') return '이동 대상: 영상 창 ' + (choice.index + 1);
    return READINESS[choice.reason] ?? '';
  }

  /* ---------- list ---------- */
  const KINDS = { arrow: 'Arrow', key: 'Key Image', length: 'Length', angle: 'Angle', ellipse: 'Ellipse ROI' };
  const number = n => Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) : '?';
  function describeSource(s) {
    return (KINDS[s.kind] || s.kind) + (s.label ? ' · ' + s.label : '') + ' · 프레임 ' + s.frame + ' · r' + s.revision +
      (s.values && s.values.length ? ' · ' + s.values.map(number).join(' / ') : '');
  }
  function timeText(value) {
    const d = text(value) ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return '시각 미확인';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const INVALID = { invalid: true };
  // One server item to a plain row. Anything unexpected invalidates the whole page: no partial list.
  function rowOf(item, study) {
    if (!item || typeof item !== 'object' || !uuid(item.id) || item.studyUid !== study || !count(item.revision) ||
        typeof item.hidden !== 'boolean' || !item.item || typeof item.item !== 'object') throw INVALID;
    const body = item.item, sources = body.sources, primary = body.primary === undefined ? 0 : body.primary;
    if (!text(body.title) || !text(body.text) || !Array.isArray(sources) || sources.length < 1 || sources.length > links.LIMITS.sources ||
        !Number.isSafeInteger(primary) || primary < 0 || primary >= sources.length) throw INVALID;
    const serverLinks = Array.isArray(item.links) ? item.links : [];
    return {
      id: item.id, revision: item.revision, hidden: item.hidden, title: body.title, text: body.text, primary,
      author: text(item.authorActor) ? item.authorActor : '', updated: timeText(item.updatedAt),
      sources: sources.map((s, index) => {
        if (!s || typeof s !== 'object' || !uuid(s.itemId) || !count(s.revision) || !uid(s.studyUid) || !uid(s.seriesUid) || !uid(s.sopUid) ||
            !count(s.frame) || !text(s.kind) || !text(s.label) ||
            !(s.values === null || s.values === undefined || (Array.isArray(s.values) && s.values.every(n => typeof n === 'number')))) throw INVALID;
        const link = serverLinks[index] && serverLinks[index].itemId === s.itemId ? serverLinks[index] : serverLinks.find(l => l && l.itemId === s.itemId) || null;
        // DB link state only: no head is passed, so no Verified/Unverified label can appear here.
        const status = links.sourceStatus(s, link, null);
        const source = { itemId: s.itemId, revision: s.revision, studyUid: s.studyUid, seriesUid: s.seriesUid, sopUid: s.sopUid, frame: s.frame,
          kind: s.kind, label: s.label, values: Array.isArray(s.values) ? [...s.values] : null,
          linkState: status.linkState, linkLabel: status.label, linkText: status.text, headRevision: count(status.headRevision) ? status.headRevision : null,
          foreign: s.studyUid !== study };
        source.description = describeSource(source);
        return source;
      }),
    };
  }
  function listPath(study, includeHidden, cursor) {
    return '/studies/' + encodeURIComponent(study) + '/findings?includeHidden=' + (includeHidden ? 'true' : 'false') + '&limit=' + PAGE +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  }
  const LIST_TEXT = {
    none: '판독 대상 검사를 선택하세요.', idle: '', loading: '소견 목록을 불러오는 중…', reloading: '소견 목록을 다시 확인하는 중…',
    denied: '이 검사의 소견을 볼 수 없습니다. 검사 접근 권한을 확인하세요. 표시했던 목록은 지웠습니다.',
    failed: '소견 목록을 확인하지 못했습니다. 표시했던 목록은 지웠습니다. Reload Findings로 다시 시도하세요.',
    ended: '로그인이 종료되었습니다. 다시 로그인한 뒤 확인하세요.',
  };
  /* The ticket is (owner, study, generation, readSequence). A selection/owner change bumps the
   * generation and clears rows at once; a reload or Show Hidden bumps only the read sequence and keeps
   * the rows of the same context until its answer. A refused or failed read never leaves rows behind. */
  function createListStore(deps) {
    const s = { owner: null, uid: null, generation: 0, readSequence: 0, includeHidden: false, loading: false, status: 'none', message: LIST_TEXT.none, rows: [], ended: false };
    const changed = () => { try { deps.changed && deps.changed(); } catch (_) {} };
    const set = (status, rows) => { s.status = status; s.message = LIST_TEXT[status]; if (rows) s.rows = rows; };
    function context(owner, study) {
      if (s.ended) return false;
      const next = text(owner) && owner && uid(study) ? [owner, study] : [null, null];
      if (next[0] === s.owner && next[1] === s.uid) return false;
      [s.owner, s.uid] = next; s.generation++; s.readSequence++; s.loading = false;
      set(s.uid ? 'idle' : 'none', []); changed(); return true;
    }
    async function load() {
      if (s.ended || !s.owner || !s.uid) return false;
      const ticket = { owner: s.owner, uid: s.uid, generation: s.generation, seq: ++s.readSequence, includeHidden: s.includeHidden };
      const current = () => !s.ended && ticket.owner === s.owner && ticket.uid === s.uid && ticket.generation === s.generation && ticket.seq === s.readSequence;
      s.loading = true; set(s.status === 'ready' || s.status === 'reloading' ? 'reloading' : 'loading'); changed();
      try {
        const items = [], cursors = new Set(); let cursor = null, pages = 0;
        do {
          const page = await deps.fetch(listPath(ticket.uid, ticket.includeHidden, cursor));
          if (!current()) return false;
          pages++;
          const next = page && page.nextCursor;
          if (!page || !Array.isArray(page.items) || items.length + page.items.length > LIST_LIMIT || pages > Math.ceil(LIST_LIMIT / PAGE) ||
              !(next === null || uuid(next)) || (next && cursors.has(next))) throw INVALID;
          items.push(...page.items);
          if (next) cursors.add(next);
          cursor = next;
        } while (cursor);
        const rows = items.map(item => rowOf(item, ticket.uid)).filter(row => ticket.includeHidden || !row.hidden);
        if (!current()) return false;
        set('ready', rows);
        s.message = rows.length ? rows.length + '개 소견 · 읽기 전용이며 판독문과 별개입니다.' : '이 검사에 표시할 소견이 없습니다.';
        return true;
      } catch (error) {
        if (!current()) return false;
        const status = error && error.status;
        if (status === 401) { end(); return false; }
        set(status === 403 || status === 404 ? 'denied' : 'failed', []);
        return false;
      } finally {
        if (current()) { s.loading = false; changed(); }
      }
    }
    function includeHidden(value) {
      if (s.ended || s.includeHidden === !!value) return false;
      s.includeHidden = !!value; s.readSequence++; s.loading = false;
      if (s.uid) return load();
      changed(); return false;
    }
    function end() {
      if (s.ended) return;
      s.ended = true; s.generation++; s.readSequence++; s.loading = false; s.owner = s.uid = null;
      set('ended', []); changed();
    }
    return { state: () => s, context, load, includeHidden, end };
  }

  /* ---------- target, pre-call and post-await ---------- */
  const has = (list, study) => Array.isArray(list) && list.includes(study);
  /* Contract §2.4 over plain data, without side effects: the embedded workspace first, then exactly
   * one attached, ready, owner-matched window. Any second window or reloaded slot showing the study
   * makes the target ambiguous instead of picking one. Navigation is never queued. A window's owner is
   * 'match', 'other' (its live owner export names another account) or 'unknown' (still loading). */
  function chooseTarget(snapshot) {
    const study = snapshot && snapshot.uid;
    if (!uid(study)) return { kind: 'refused', reason: 'invalid' };
    const w = snapshot.workspace;
    if (w && w.active && w.sameTarget && has(w.studies, study)) {
      return !w.loaded || w.inert || w.hidden ? { kind: 'refused', reason: 'loading' } : { kind: 'embedded' };
    }
    const windows = (Array.isArray(snapshot.windows) ? snapshot.windows : []).filter(x => x && has(x.studies, study));
    const attached = windows.filter(x => x.attached && !x.closed), detached = windows.filter(x => !x.attached);
    if (attached.length + detached.length > 1) return { kind: 'refused', reason: 'ambiguous' };
    if (attached.length === 1) {
      const x = attached[0];
      if (x.pending) return { kind: 'refused', reason: 'loading' };
      if (x.owner === 'other') return { kind: 'refused', reason: 'owner' };
      if (!x.ready || x.owner !== 'match') return { kind: 'refused', reason: 'loading' };
      return { kind: 'window', index: x.index };
    }
    if (detached.length === 1) return { kind: 'refused', reason: 'unattached', index: detached[0].index };
    return { kind: 'refused', reason: 'no-viewer' };
  }
  /* `view` is the plain fact sheet one probe reads synchronously from the worklist session and the
   * target document: {error, live, owner, sub, uid, selection, generation, kind, ref, window, document,
   * scope, attached, closed, visible, historyPresent, ended, suspended, subject, windowOwner, modal,
   * navigate}. The viewer remains the authority for scope/busy/series/frame/viewport. */
  function precheck(view, expected) {
    if (!expected || !text(expected.owner) || !expected.owner || !text(expected.sub) || !expected.sub || !uid(expected.uid)) return 'session';
    if (!view || view.live !== true) return 'session';
    if (view.owner !== expected.owner || view.sub !== expected.sub || view.uid !== expected.uid || view.selection !== expected.uid ||
        view.generation !== expected.generation) return 'superseded';
    if (view.error || view.closed || !view.attached || !text(view.scope) || !view.scope.split(',').includes(expected.uid)) return 'no-viewer';
    if (!view.visible) return 'loading';
    if (!view.historyPresent) return 'tool-missing';
    if (view.ended) return 'ended';
    if (view.subject !== expected.sub) return 'owner';
    if (view.kind === 'window' && view.windowOwner !== expected.owner) return 'owner';
    if (view.suspended) return 'busy';
    if (view.modal) return 'modal';
    if (!view.navigate) return 'tool-missing';
    return null;
  }
  const IDENTITY = ['kind', 'ref', 'window', 'document', 'scope', 'owner', 'sub', 'uid', 'selection', 'generation', 'subject', 'windowOwner'];
  function sameIdentity(before, after) {
    if (!before || !after || before.error || after.error) return false;
    if (after.live !== true || after.closed || !after.attached || !after.visible || !after.historyPresent || after.ended || after.suspended) return false;
    return IDENTITY.every(key => before[key] === after[key]);
  }
  // The value comes from the viewer document's realm: read each field once, copy primitives only.
  function validResult(value) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return refusal('invalid');
      const ok = value.ok;
      if (ok === true) {
        const highlighted = value.highlighted, annotation = value.annotation;
        return typeof highlighted === 'boolean' && text(annotation) ? { ok: true, highlighted, annotation } : refusal('invalid');
      }
      if (ok === false) { const reason = value.reason; return text(reason) && VIEWER_REASONS.includes(reason) ? refusal(reason) : refusal('invalid'); }
      return refusal('invalid');
    } catch (_) { return refusal('invalid'); }
  }
  function targetOf(source) {
    try {
      if (!source || typeof source !== 'object') return null;
      const target = { studyUid: source.studyUid, seriesUid: source.seriesUid, sopUid: source.sopUid, frame: source.frame, itemId: source.itemId };
      return links.validTarget(target) ? target : null;
    } catch (_) { return null; }
  }
  /* One command at a time is current. `job` = {expected:{owner, sub, uid, generation}, source,
   * choose() -> refusal | {kind, probe(), invoke(target)}, announce(result, choice)}. The checks, the
   * call and (after the await) the identity check and the announcement each happen in one tick;
   * `invoke` must read the viewer function at that moment. Only the latest command announces. */
  const THROWN = {};
  function createNavigator(options) {
    const o = options || {};
    const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 15000, watchMs = Number.isFinite(o.watchMs) ? o.watchMs : 250;
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms)), cancelTimer = o.clearTimeout || (id => clearTimeout(id));
    let sequence = 0;
    const safe = fn => { try { return typeof fn === 'function' ? fn() : null; } catch (_) { return null; } };
    async function run(job) {
      const seq = ++sequence;
      const finish = (result, choice) => {
        const latest = seq === sequence;
        if (latest && job && typeof job.announce === 'function') { try { job.announce(result, choice || null); } catch (_) {} }
        return { ...result, latest };
      };
      const expected = job && job.expected;
      if (!expected || !text(expected.owner) || !expected.owner || !text(expected.sub) || !expected.sub || !uid(expected.uid)) return finish(refusal('session'));
      if (job.source === null || job.source === undefined) return finish(refusal('list-changed'));
      const target = targetOf(job.source);
      if (!target) return finish(refusal('invalid'));
      // Never substitute the selected study for a source of another study (review C7).
      if (target.studyUid !== expected.uid) return finish(refusal('foreign'));
      const choice = safe(job.choose);
      if (!choice || choice.kind === 'refused') return finish(refusal(choice && choice.reason ? choice.reason : 'no-viewer'));
      const before = safe(choice.probe), reason = precheck(before, expected);
      if (reason) return finish(refusal(reason));
      let pending;
      try { pending = choice.invoke(target); } catch (_) { pending = THROWN; }
      let timer = null, watch = null;
      const outcome = pending === THROWN ? { thrown: true } : await new Promise(resolve => {
        timer = later(() => resolve({ timeout: true }), timeoutMs);
        // A closed, replaced or re-scoped target, a session end or a newer command settles early.
        const check = () => {
          watch = null;
          if (seq !== sequence || !sameIdentity(before, safe(choice.probe))) { resolve({ changed: true }); return; }
          watch = later(check, watchMs);
        };
        watch = later(check, watchMs);
        Promise.resolve().then(() => pending).then(value => resolve({ value }), () => resolve({ thrown: true }));
      });
      if (timer !== null) cancelTimer(timer);
      if (watch !== null) cancelTimer(watch);
      if (seq !== sequence) return { ...refusal('superseded'), latest: false };
      const after = safe(choice.probe);
      if (outcome.changed || !sameIdentity(before, after)) return finish(refusal('superseded'), choice);
      if (outcome.timeout) return finish(refusal('timeout'), choice);
      if (outcome.thrown) return finish(refusal('tool-missing'), choice);
      return finish(validResult(outcome.value), choice);
    }
    return { run, cancel: () => { sequence++; }, sequence: () => sequence };
  }

  const api = { reasonText, retryable, openable, arrivalText, readinessText, describeSource, timeText, rowOf, listPath, createListStore,
    chooseTarget, precheck, sameIdentity, validResult, targetOf, createNavigator, LOCAL_REASONS: Object.freeze(Object.keys(TEXT)) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.kinFindingCommand = api;
})(globalThis);
