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
  };
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
  const itemOnly = head => ({ title: head.item.title, text: head.item.text, primary: head.item.primary ?? 0,
    sources: head.item.sources.map(s => ({ itemId: s.itemId, revision: s.revision })) });
  function errorMessage(error) {
    if (error.code === 'FINDING_STORAGE_LIMIT') return '소견 저장 한도입니다. 숨김으로 공간이 회수되지는 않습니다. 작성 내용은 미저장 상태로 남아 있습니다.';
    if (error.code === 'FINDING_SOURCE_STALE') return error.headHidden ? '연결하려는 표식이 숨겨졌습니다. 연결을 해제하거나 표식을 복원한 뒤 다시 저장하세요.'
      : '연결하려는 표식에 더 새로운 판(r' + error.headRevision + ')이 있습니다. Refresh Link로 최신판을 확인한 뒤 다시 저장하세요.';
    if (error.status === 409) return '다른 판 또는 저장 조건과 충돌했습니다. 최신판을 확인한 뒤 다시 저장하세요.';
    if (error.status === 404) return '연결한 표식이 이 검사에 없습니다. 작성 내용은 저장되지 않았습니다.';
    if (error.status === 400 || error.status === 413) return '입력 길이와 연결 표식을 확인하세요. 작성 내용은 저장되지 않았습니다.';
    return '저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.';
  }

  /* The store owns scope, generation, read sequence and every pending request. `deps.fetch`,
   * `deps.uuid`, `deps.navigate` (window.kinViewerHistoryNavigate) and `deps.notify` are injected
   * so the same decisions run under Node with fake transports. */
  function createStore(deps) {
    const fetchImpl = deps.fetch, makeId = deps.uuid, timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 30000;
    const listeners = new Set();
    const s = { scope: '', subject: '', me: null, ended: false, generation: 0, readSequence: 0, loading: false, suspended: true,
      status: '', history: null, entries: new Map(), heads: new Map() };
    let controller = typeof AbortController === 'function' ? new AbortController() : null;
    const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (_) {} } };
    const valid = ticket => !s.ended && ticket === s.generation;
    const writable = entry => !s.suspended && s.me?.kind === 'member' && Array.isArray(s.me.roles) && s.me.roles.includes('radiologist') &&
      (!entry || !entry.head || entry.head.authorSub === s.subject);
    const hasWork = e => !!(e.editing || e.pending || e.busy);
    function reset(message) {
      s.generation++; s.readSequence++; controller?.abort(); controller = typeof AbortController === 'function' ? new AbortController() : null;
      s.entries.clear(); s.loading = false; s.suspended = true; s.status = message; notify();
    }
    function end() {
      if (s.ended) return;
      reset('로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'); s.ended = true; s.me = null; s.subject = ''; notify();
    }
    function deny() { reset('이 검사에 접근할 수 없습니다. 접근 확인 후 Refresh로 다시 불러오세요.'); s.me = null; }
    async function api(path, options, ticket) {
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
        if (res.status === 403) { deny(); throw { stale: true }; }
        const data = await res.json().catch(() => null);
        if (!valid(ticket)) throw { stale: true };
        if (!res.ok || !data) throw { status: res.status, code: data?.code, headRevision: data?.headRevision ?? null, headHidden: data?.headHidden ?? null, itemId: data?.itemId ?? null };
        return data;
      } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
    }
    async function authenticate(ticket) {
      const user = await api('/me', {}, ticket);
      if (!user || !user.sub || (s.subject && s.subject !== user.sub)) { end(); throw { stale: true }; }
      s.me = user; s.subject = user.sub; return user;
    }
    const path = () => '/studies/' + s.scope + '/findings';
    function setScope(scope) {
      if (s.ended || scope === s.scope) return;
      reset(scope ? '소견 확인 중…' : '');
      s.scope = uid(scope) ? scope : '';
      if (s.scope) load();
    }
    // The Measurements panel is the source of truth for saved heads and their reference verdict.
    function syncHistory(state) {
      if (s.ended) return;
      if (!state || typeof state !== 'object') { s.history = null; return; }
      if (state.ended) { end(); return; }
      const key = JSON.stringify([state.scope, state.suspended, state.heads.map(h => [h.id, h.revision, h.hidden, h.referenceStatus, h.working])]);
      const changed = key !== s.historyKey;
      s.historyKey = key; s.history = state;
      s.heads = new Map((state.heads || []).map(h => [h.id, h]));
      if (state.scope !== s.scope) setScope(state.scope);
      else if (changed) notify();
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
        for (const [id, e] of [...s.entries]) if (e.head && !seen.has(id) && !hasWork(e)) s.entries.delete(id);
        s.status = heads.length + '개 소견 · 소견 저장은 판독 확정과 별개입니다.';
      } catch (e) { if (!e.stale && valid(ticket)) s.status = '소견 목록을 확인하지 못했습니다. Refresh로 다시 확인하세요.'; }
      finally { if (ticket === s.generation) s.loading = false; notify(); }
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
    // takes the current head revision, so the server copies exactly that revision.
    function toggleSource(e, itemId) {
      if (s.entries.get(e.id) !== e || !e.editing || e.busy || e.pending) return false;
      const index = e.draft.sources.findIndex(x => x.itemId === itemId);
      if (index >= 0) { e.draft.sources.splice(index, 1); if (e.draft.primary >= e.draft.sources.length) e.draft.primary = 0; notify(); return true; }
      const head = s.heads.get(itemId);
      if (!head || head.hidden || head.working || e.draft.sources.length >= LIMITS.sources) return false;
      e.draft.sources.push({ itemId, revision: head.revision }); notify(); return true;
    }
    function setPrimary(e, index) {
      if (s.entries.get(e.id) !== e || !e.editing || e.busy || e.pending) return;
      if (Number.isSafeInteger(index) && index >= 0 && index < e.draft.sources.length) { e.draft.primary = index; notify(); }
    }
    // Explicit refresh is an edit that replaces one {itemId, revision} pair by the current head
    // pair; ordinary text edits keep every existing pair and therefore every frozen copy.
    function refreshSource(e, itemId) {
      if (s.entries.get(e.id) !== e || !e.head || e.busy || e.pending || !writable(e)) return false;
      const link = (e.links || []).find(l => l.itemId === itemId), head = s.heads.get(itemId);
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
      if (s.entries.get(e.id) !== e || !e.head || e.head.hidden || e.busy || e.pending || !writable(e)) return;
      e.editing = true; notify();
    }
    async function save(e, action, reason) {
      if (!valid(s.generation) || s.entries.get(e.id) !== e || !writable(e) || e.busy || s.ended) return false;
      if (!e.pending) {
        if (e.head && action !== 'edit' && action !== 'hide' && action !== 'restore') return false;
        if (!e.head && action && action !== 'create') return false;
        const problem = draftProblem(e.draft);
        if (problem) { e.message = problem; notify(); return false; }
        const body = commandBody(e.draft, e.head, action, reason, makeId());
        e.pending = { url: path() + (e.head ? '/' + e.head.id + '/revisions' : ''), body: JSON.stringify(body) };
      }
      const ticket = s.generation; e.busy = true; notify();
      try {
        await authenticate(ticket);
        const head = await api(e.pending.url, { method: 'POST', body: e.pending.body }, ticket);
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
        e.message = errorMessage(error);
        if (error.status >= 400 && error.status < 500) e.pending = null;
        if (error.code === 'FINDING_SOURCE_STALE') e.staleSource = { itemId: error.itemId, headRevision: error.headRevision, headHidden: error.headHidden };
        else if (error.status === 409) await load();
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
      let result;
      if (typeof go !== 'function') result = refusal('tool-missing');
      else {
        const target = { studyUid: source.studyUid ?? s.scope, seriesUid: source.seriesUid, sopUid: source.sopUid, frame: source.frame, itemId: source.itemId };
        if (!validTarget(target)) result = refusal('invalid');
        else { try { result = await go(target); } catch (_) { result = refusal('tool-missing'); } }
      }
      if (!result || typeof result !== 'object') result = refusal('invalid');
      if (!valid(ticket) || s.entries.get(e.id) !== e) return refusal('superseded');
      e.message = result.ok ? annotationText(result.annotation) : reasonText(result.reason);
      notify(); return result;
    }
    async function history(e, cursor) {
      if (!valid(s.generation) || s.entries.get(e.id) !== e || !e.head) return null;
      const ticket = s.generation;
      const data = await api(path() + '/' + e.head.id + '/revisions?limit=50' + (cursor ? '&cursor=' + cursor : ''), {}, ticket);
      if (!valid(ticket) || s.entries.get(e.id) !== e) return null;
      return data;
    }
    return { state: () => s, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, valid, writable, hasWork,
      setScope, syncHistory, load, newDraft, updateDraft, toggleSource, setPrimary, refreshSource, useLatest, discard, edit, save, navigate, history, end,
      dispose: () => { listeners.clear(); controller?.abort(); } };
  }

  const api = { LINK_STATES, LINK_LABELS, NAVIGATION_REASONS, LIMITS, linkState, sourceStatus, reasonText, annotationText, validReply, validTarget,
    commandBody, draftProblem, itemOnly, errorMessage, createStore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.kinFindingLinkModel = api;
})(globalThis);
