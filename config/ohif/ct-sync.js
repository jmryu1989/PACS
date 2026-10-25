
// Position matching is display navigation, not image registration or a measurement result.
const kinCTSyncModel = (() => {
  const eps = 1e-3, dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const sub = (a, b) => a.map((x, i) => x - b[i]);
  const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  function normal(p) {
    if (!p || !vector(p.imagePositionPatient) || !vector(p.rowCosines) || !vector(p.columnCosines) ||
        p.isDefaultValueSetForRowCosine || p.isDefaultValueSetForColumnCosine) return null;
    const r = p.rowCosines, c = p.columnCosines;
    if (Math.abs(dot(r, r) - 1) > 1e-6 || Math.abs(dot(c, c) - 1) > 1e-6 || Math.abs(dot(r, c)) > 1e-6) return null;
    return [r[1]*c[2]-r[2]*c[1], r[2]*c[0]-r[0]*c[2], r[0]*c[1]-r[1]*c[0]];
  }
  function match(source, target) {
    const deny = reason => ({ reason, index: -1 });
    if (!source?.patient || source.patient !== target?.patient) return deny('같은 환자를 확인할 수 없습니다');
    if (!source.classic || !target.classic) return deny('일반 CT 스택만 위치 동기할 수 있습니다');
    const a = source.planes?.[source.index], planes = target.planes;
    if (!a?.frameOfReferenceUID || !Array.isArray(planes) || planes.length < 2 || planes.length > 2000 ||
        planes.some(p => !p?.frameOfReferenceUID || p.frameOfReferenceUID !== a.frameOfReferenceUID)) return deny('좌표계가 다르거나 없습니다');
    const n = normal(a), t = normal(planes[0]);
    if (!n || !t || Math.abs(dot(n, t)) < 1 - 1e-6) return deny('영상 방향 또는 위치가 맞지 않습니다');
    const origin = planes[0].imagePositionPatient, values = [];
    for (const p of planes) {
      const pn = normal(p);
      if (!pn || Math.abs(dot(pn, t)) < 1 - 1e-6) return deny('영상 방향 또는 위치가 맞지 않습니다');
      const d = sub(p.imagePositionPatient, origin), z = dot(d, t);
      if (Math.sqrt(dot(d, d) - Math.min(dot(d, d), z*z)) > eps) return deny('기울어진 스택은 위치 동기하지 않습니다');
      values.push(z);
    }
    const sorted = [...values].sort((a, b) => a - b), gaps = sorted.slice(1).map((x, i) => x - sorted[i]);
    if (gaps.some(x => x < eps)) return deny('같은 위치의 영상이 중복되어 있습니다');
    const z = dot(sub(a.imagePositionPatient, origin), t);
    if (z < sorted[0] - eps || z > sorted.at(-1) + eps) return deny('대상 영상의 위치 범위를 벗어났습니다');
    // Preserve native nearest-position and stable first-index tie behavior, but refuse large gaps.
    let index = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i]-z) < Math.abs(values[index]-z) - 1e-9) index = i;
    if (Math.abs(values[index]-z) > Math.min(...gaps) / 2 + eps) return deny('대상 영상 위치 사이에 큰 공백이 있습니다');
    return { index, reason: '' };
  }
  return { match };
})();

function kinCreateCTSync() {
  let services, stop;
  function mount() {
    stop?.();
    const core = window.cornerstone, groups = services.syncGroupService;
    const creators = ['imageSlice', 'stackimage'].map(type => [type, groups.getSyncCreatorForType(type)]);
    if (!core?.imageLoader || creators.some(([, fn]) => typeof fn !== 'function')) return;
    // S5-U2c (Astra S5-VIEWER-UXR-R-001 F01): one wording per state. Only a real end of the login (401, another account, the
    // logout broadcast, the document's end of it before or during this mount — documentEnded — and pagehide) says the session
    // changed. A refused or unanswered access check is not a logout: it keeps its own reason and a Recheck Access button, and
    // nothing moves until a later check confirms access.
    const TEXT = {
      ended: '세션이 변경되었거나 종료되어 위치 동기를 중지했습니다. 다시 로그인한 뒤 뷰어를 여세요',
      checking: '검사 접근 정보를 확인하는 중입니다. 확인한 뒤 위치 동기를 적용합니다',
      confirmed: '검사 접근 정보를 확인했습니다. 위치 동기를 사용할 수 있습니다',
      failed: '검사 접근 정보를 확인하지 못해 위치 동기를 멈췄습니다. 연결 상태를 확인한 뒤 다시 확인하세요',
      denied: '이 계정으로 검사 접근 정보를 확인할 수 없어 위치 동기를 멈췄습니다. 권한을 확인한 뒤 다시 확인하세요',
      changed: '계정의 역할이 바뀌어 위치 동기를 멈췄습니다. 검사 접근 정보를 다시 확인하세요',
    };
    const notice = document.createElement('div'); notice.id = 'kin-ct-sync-status'; notice.setAttribute('role', 'status');
    notice.style.cssText = 'position:fixed;top:110px;left:50%;transform:translateX(-50%);z-index:42;max-width:70vw;padding:6px 10px;background:#101e32;color:#e1ecfc;border-radius:6px;font:13px sans-serif;pointer-events:none';
    // The notice lets the pointer through to the viewport under it; only its own button takes a click.
    const message = document.createElement('span'), recheck = document.createElement('button');
    recheck.type = 'button'; recheck.id = 'kin-ct-sync-recheck'; recheck.textContent = 'Recheck Access'; recheck.title = '검사 접근 정보를 다시 확인합니다'; recheck.hidden = true;
    recheck.style.cssText = 'pointer-events:auto;margin-left:8px;min-height:24px;padding:2px 8px;border:1px solid #657c9f;border-radius:4px;background:#1b3252;color:#e1ecfc;font:13px sans-serif;cursor:pointer';
    notice.append(message, recheck); notice.hidden = true; document.body.append(notice);
    const controller = new AbortController(), search = location.search, created = new Set();
    // access: checking · ready · failed (unanswered) · denied (403 or not one institution's member) · changed (the role changed).
    // keys: study UID -> server patient key (sourcePatientKey) from the list the last confirmed round read; never DICOM PatientID.
    // Panel account checks reject only this access round; only the page gate ends the document.
    let ended = false, channel, checking, clinician = null, keys = new Map(), access = 'checking', round = 0, waiting = false;
    let ready = Promise.resolve(false);
    const say = (text, offer = false) => { waiting = text === TEXT.checking; message.textContent = text; recheck.hidden = !offer; notice.hidden = !text; };
    // Every gate after an await reads these. The document's end (documentEnded below) sets `ended` or moves `round` synchronously
    // inside kinViewerSession's verdict, so no answer or image load that resumes after it passes a gate.
    const live = () => !ended && location.search === search;
    const fresh = mine => !ended && mine === round;
    const usable = mine => live() && access === 'ready' && mine === round;
    const end = () => { ended = true; controller.abort(); created.forEach(s => s.setEnabled(false)); say(TEXT.ended); };
    // Only the document gate publishes an end; a panel's HTTP refusal stays in that panel.
    function documentEnded() { if (!ended) end(); }
    // Session termination is owned by the page transport and gate.
    const refusal = (kind, status = 0) => Object.assign(Error(kind), { kind, status });
    async function get(path) {
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      const timer = setTimeout(abort, 10000);
      try {
        let r;
        try { r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal }); }
        catch (_) { throw refusal('failed'); }
        if (window.KinSessionTransport.refusal(r) === 'denied' && r.status === 403) throw refusal('denied', r.status);
        if (!r.ok) throw refusal('failed', r.status);
        try { return await r.json(); } catch (_) { throw refusal('failed', r.status); }
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    }
    const session = () => checking ||= whoAmI().finally(() => { checking = null; });
    const ownerOf = me => me?.kind === 'member' && me.institution && me.sub ? JSON.stringify([me.institution, me.sub]) : null;
    // Comparing a panel answer never changes the page's session authority.
    async function whoAmI() {
      const me = await get('/api/me');
      return { me, same: ownerOf(me) ? kinViewerSession.sameAccount(me) : null };
    }
    const keyOf = row => typeof row?.sourcePatientKey === 'string' && row.sourcePatientKey ? row.sourcePatientKey : null;
    const opened = [...new Set((new URLSearchParams(search).get('StudyInstanceUIDs') || '').split(',').filter(Boolean))];
    async function legacyKeys() {
      const data = await get('/api/studies');
      if (!Array.isArray(data?.studies)) throw refusal('failed');
      return new Map(data.studies.filter(row => typeof row?.uid === 'string').map(row => [row.uid, keyOf(row)]));
    }
    // clinician-only: GET studies is refused to that role (api/src/clinician-policy.ts), so its narrow list GET clinician/studies is
    // read instead — the worklist's own institution / tele / StudyAccess scope with the same server patient key. Pages follow the
    // signed cursor verbatim until every study this viewer opened is seen or the list ends; a page of another shape refuses the whole
    // read, and a 409 (the list changed between pages) starts again from the first page, at most twice.
    async function clinicianPages(mine) {
      const found = new Map();
      let after = null, total = null, read = 0;
      for (let page = 0; page < 200; page++) {
        const data = await get('/api/clinician/studies?limit=100' + (after === null ? '' : '&after=' + encodeURIComponent(after)));
        if (!fresh(mine)) throw refusal('failed');
        const p = data?.pagination, list = data?.studies;
        if (!p || !Array.isArray(list) || list.length > 100 || p.limit !== 100 || p.offset !== read ||
            !Number.isSafeInteger(p.total) || (total !== null && p.total !== total) ||
            !(p.next === null || (typeof p.next === 'string' && p.next.length > 0 && p.next.length <= 4096 && p.next !== after)) ||
            (p.next === null ? read + list.length !== p.total : list.length !== 100) ||
            list.some(row => typeof row?.uid !== 'string' || !row.uid)) throw refusal('failed');
        for (const row of list) found.set(row.uid, keyOf(row));
        read += list.length; total = p.total; after = p.next;
        if (after === null || (opened.length && opened.every(uid => found.has(uid)))) break;
      }
      return found;
    }
    async function clinicianKeys(mine) {
      for (let attempt = 0; ; attempt++) {
        try { return await clinicianPages(mine); }
        catch (error) { if (error?.status !== 409 || attempt >= 2 || !fresh(mine)) throw error; }
      }
    }
    // One access check: the account (/me), the study list its role may read, then the same account and role again. A later round
    // (Recheck Access, a role change) and the end of this mount drop an earlier round's answers.
    // A mismatched member answer refuses this round; the bound page transport owns real ends.
    function confirm() {
      const mine = ++round; access = 'checking'; keys = new Map();
      ready = (async () => {
        const { me, same } = await whoAmI();
        if (!fresh(mine)) throw refusal('failed');
        if (!ownerOf(me)) throw refusal('denied');
        if (!same) throw refusal('denied');
        const role = kinViewerClinicianOnly(me), found = role ? await clinicianKeys(mine) : await legacyKeys();
        if (!fresh(mine)) throw refusal('failed');
        const again = await whoAmI();
        if (!fresh(mine)) throw refusal('failed');
        if (!ownerOf(again.me)) throw refusal('denied');
        if (!again.same) throw refusal('denied');
        if (kinViewerClinicianOnly(again.me) !== role) throw refusal('changed');
        return [role, found];
      })().then(([role, found]) => {
        if (!fresh(mine)) return false;
        clinician = role; keys = found; access = 'ready';
        if (waiting) say(TEXT.confirmed);
        return true;
      }, error => {
        if (!fresh(mine)) return false;
        access = error?.kind === 'denied' || error?.kind === 'changed' ? error.kind : 'failed';
        // Said at once only to someone waiting (a sync event or Recheck Access); otherwise at the next sync event.
        if (waiting) say(TEXT[access], true);
        return false;
      });
      return ready;
    }
    function roleChanged() { round++; access = 'changed'; keys = new Map(); ready = Promise.resolve(false); say(TEXT.changed, true); }
    recheck.addEventListener('click', () => { if (ended || access === 'checking' || access === 'ready') return; say(TEXT.checking); confirm(); });
    function view(info) {
      const v = services.cornerstoneViewportService.getCornerstoneViewport(info.viewportId);
      const g = services.viewportGridService.getState().viewports.get(info.viewportId);
      if (!v || !g || v.getRenderingEngine().id !== info.renderingEngineId) return null;
      const ids = v.getImageIds?.() || [], sets = g.displaySetInstanceUIDs || [];
      const d = sets.length === 1 && services.displaySetService.getDisplaySetByUID(sets[0]);
      const classic = v.type === 'stack' && d?.Modality === 'CT' && d?.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2' &&
        d.images?.length === ids.length && d.images.every(i => i.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2') &&
        ids.length > 1 && ids.length <= 2000 && ids.every(id => id.includes('/studies/'+d.StudyInstanceUID+'/series/'+d.SeriesInstanceUID+'/'));
      return { v, ids, study: d?.StudyInstanceUID, patient: null, classic, index: v.getCurrentImageIdIndex?.(),
        planes: classic ? ids.map(id => core.metaData.get('imagePlaneModule', id)) : [],
        signature: JSON.stringify([sets, ids, v.getCurrentImageId?.()]) };
    }
    const current = (info, before) => before && view(info)?.signature === before.signature;
    for (const [type, original] of creators) {
      groups.addSynchronizerType(type, (id, options) => {
        const sync = original(id, options), fire = sync.fireEvent;
        created.add(sync); let serial = 0;
        const destroy = sync.destroy;
        sync.destroy = function (...args) { ++serial; created.delete(sync); if (!ended) say('위치 동기 꺼짐'); return destroy.apply(this, args); };
        sync.fireEvent = async function (sourceInfo, event) {
          if (!live() || sync.isDisabled()) return;
          const ticket = ++serial, source = view(sourceInfo), targets = sync.getTargetViewports().filter(t => t.viewportId !== sourceInfo.viewportId);
          const snapshots = targets.map(view);
          // Refused or unconfirmed: nothing moves, and the reason stays with Recheck Access. Still asking: this event waits for it.
          if (access !== 'ready' && access !== 'checking') { say(TEXT[access], true); return; }
          if (access === 'checking') say(TEXT.checking);
          const mine = round;
          if (!(await ready) || !usable(mine) || ticket !== serial || !current(sourceInfo, source)) return;
          try {
            const { me, same } = await session();
            // Member/role refusals are local. Only the page gate can end this mount.
            if (ended) return;
            if (!ownerOf(me)) throw refusal('denied');
            if (!same) throw refusal('denied');
            if (!usable(mine)) return;
            if (kinViewerClinicianOnly(me) !== clinician) { roleChanged(); return; }
            if (sync.isDisabled() || ticket !== serial || !current(sourceInfo, source)) return;
            // The patient key is attached only now, from the list this confirmed round read (an event queued behind the check
            // would otherwise carry the empty map it saw when it fired).
            for (const v of [source, ...snapshots]) if (v) v.patient = keys.get(v.study) ?? null;
            const matches = snapshots.map(t => kinCTSyncModel.match(source, t));
            await Promise.all(matches.map((m, i) => m.index < 0 ? null : core.imageLoader.loadAndCacheImage(snapshots[i].ids[m.index])));
            // Native movement now uses cached pixels. A late load cannot choose a replaced stack or an OFF group, nor move anything
            // once the document's login ended or refused this account while it loaded (usable). This is the last gate: nothing
            // between it and the native fire awaits.
            if (!usable(mine) || sync.isDisabled() || ticket !== serial || !current(sourceInfo, source) || targets.some((t, i) => !current(t, snapshots[i]) || !sync.hasTargetViewport(t.renderingEngineId, t.viewportId))) return;
            matches.forEach((m, i) => {
              sync.setOptions(targets[i].viewportId, { ...sync.getOptions(targets[i].viewportId), disabled: m.index < 0, useInitialPosition: true });
              if (m.index >= 0) core.utilities.spatialRegistrationMetadataProvider.add([targets[i].viewportId, sourceInfo.viewportId], [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
            });
            const denied = matches.find(m => m.index < 0);
            say(denied ? '위치 동기 제한: '+denied.reason : '같은 좌표계의 CT 위치 동기');
            return fire.call(sync, sourceInfo, event);
          } catch (error) {
            // Session termination is owned by the page transport and gate.
            if (error?.kind === 'ended') { if (!ended) end(); return; }
            // fix2 (Astra S5-U2c-B-R-001 F03): any other failure speaks only for an event still in effect — its round, its serial
            // number, its synchronizer and the screen it fired on — so a dropped event's late 403 or network error cannot replace the
            // refusal, check or confirmation shown since (and its Recheck Access).
            if (!usable(mine) || sync.isDisabled() || ticket !== serial || !current(sourceInfo, source)) return;
            say(error?.kind === 'denied' ? '위치 동기를 적용하지 못했습니다. 이 계정의 검사 접근 권한을 확인할 수 없습니다' : '위치 동기를 적용하지 못했습니다. 영상과 연결 상태를 확인하세요');
          }
        };
        return sync;
      });
    }
    // This mount's own logout receivers stay beside the document's (which reaches it through onEnded, after a refusal of this
    // account too). pagehide ends the mount as it does the other viewer extensions'.

    const onMessage = () => { end(); };
     window.addEventListener('pagehide', end);
    try { channel = kinViewerOnEnd(() => onMessage()); } catch (_) {}
    // Subscribed for the whole mount and dropped at mode exit. A document whose login already ended before this entry answers at
    // once: an end asks nothing; a refusal of this account asks nothing either until Recheck Access. This extension's own /me and
    // list refusal, plain 401 and another account stay local failures. Only the page gate ends the document's session.
    const unwatchEnd = kinViewerSession.onEnded(documentEnded);
    stop = () => { unwatchEnd(); end(); creators.forEach(([type, fn]) => groups.addSynchronizerType(type, fn));  window.removeEventListener('pagehide', end); channel?.close(); notice.remove(); };
    if (!ended && access === 'checking') confirm();
  }
  return { id: 'kin.ct-sync', preRegistration({ servicesManager }) { services = servicesManager.services; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
