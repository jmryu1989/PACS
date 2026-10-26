(() => {
  'use strict';
  const el = name => document.getElementById(`access-review-${name}`);
  let sequence = 0, next = null, selection = null, count = 0, ready = false, pending = false;
  const fact = value => {
    if (!value) return 'not recorded';
    if (value.status === 'known') return typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
    return `${value.status}: ${value.reason}`;
  };
  const value = item => item == null ? 'not recorded' : typeof item === 'string' ? item : JSON.stringify(item);
  const message = (text, failed = false) => {
    el('message').textContent = text;
    el('message').className = failed ? 'message show' : 'audit-hint';
  };
  function controls() {
    el('load').disabled = !ready || pending;
    el('more').hidden = !next;
    el('more').disabled = !ready || pending;
  }
  function clear() {
    sequence++; next = selection = null; count = 0; pending = false;
    el('rows').replaceChildren(); el('wrap').hidden = true;
    el('wrap').classList.remove('stale'); el('scope').textContent = '';
    el('state').textContent = 'Not Loaded'; message(''); controls();
  }
  function cell(lines) {
    const td = document.createElement('td');
    for (const [label, text] of lines) {
      const line = document.createElement('div'); line.textContent = `${label}: ${text}`; td.append(line);
    }
    return td;
  }
  function row(event) {
    const tr = document.createElement('tr');
    tr.append(cell([['Occurred', event.occurredAt], ['Recorded', event.recordedAt]]),
      cell([['Actor', fact(event.userId)], ['Roles', fact(event.rolesAtTime)], ['Executor', value(event.executor)],
        ['Acting institution', fact(event.actingInstitution)], ['Managing institution', fact(event.managingInstitution)],
        ['IP', fact(event.trustedProxyIp)], ['Affected identity', fact(event.affectedIdentity)]]),
      cell(event.targets.length ? event.targets.flatMap((target, index) => [
        [`${index + 1}. Kind`, target.kind], ['Patient', fact(target.patientLinkSnapshot)], ['Study', fact(target.studyId)],
        ['Record', fact(target.recordId)], ['Version', fact(target.versionId)]]) : [['Targets', 'None']]),
      cell([['Surface', event.surface], ['Action', event.action], ['Result', event.result], ['Statutory act', event.statutoryAct]]),
      cell([['Cause', value(event.cause)], ['Context', value(event.context)], ['Event', event.eventId],
        ['Request', value(event.requestId)], ['Audit link', value(event.auditLinkId)], ['Related event', value(event.relatedEventId)],
        ['Auth', value(event.auth)], ['Rights version', value(event.rightsVersion)]]));
    return tr;
  }
  async function load(more) {
    if (!ready || pending || KinConsoleSession.ended() || (more && !next)) return;
    if (!more) {
      clear();
      try {
        selection = { report: 'access', from: new Date(`${el('from').value}Z`).toISOString(),
          until: new Date(`${el('until').value}Z`).toISOString(), downloads: el('filter').value };
        if (selection.from >= selection.until) throw new Error();
      } catch { message('시작보다 뒤인 종료 시각을 지정하세요.', true); return; }
    }
    const current = ++sequence, selected = selection, context = KinWorkContext.capture('document');
    const query = new URLSearchParams(selected);
    if (more) query.set('after', next);
    pending = true; el('state').textContent = 'Loading'; message(''); controls();
    try {
      const response = await KinSessionTransport.page().request(`${location.origin}/api/admin/audit?${query}`, { context });
      if (current !== sequence || selection !== selected || KinConsoleSession.ended() || !KinWorkContext.admits(context)) return;
      if (!response.ok || response.incomplete) throw Object.assign(new Error(), { status: response.status });
      const body = response.body;
      if (!body || body.from !== selected.from || body.until !== selected.until || typeof body.institutionId !== 'string' ||
          !Array.isArray(body.rows) || !(body.next === null || typeof body.next === 'string') ||
          body.rows.some(item => !item || !Array.isArray(item.targets) ||
            ['eventId', 'occurredAt', 'recordedAt', 'surface', 'action', 'result'].some(key => typeof item[key] !== 'string'))) throw new Error();
      const fragment = document.createDocumentFragment();
      body.rows.forEach(item => fragment.append(row(item)));
      el('rows').append(fragment); count += body.rows.length; next = body.next;
      el('wrap').hidden = !count; el('wrap').classList.remove('stale');
      el('scope').textContent = `${body.institutionId} · ${body.from} ≤ 발생 시각 < ${body.until} · 표시 사건 ${count}건`;
      el('state').textContent = next ? 'Partial' : count ? 'Loaded' : 'No Events';
      message(next ? '아직 일부 기록만 조회했습니다. Load More로 이어서 확인하세요.' :
        count ? '선택 범위의 조회를 마쳤습니다. 업무 대조와 사유 확인은 담당자가 수행해야 합니다.' : '선택한 기간·조건에 표시할 접속기록이 없습니다.');
    } catch (error) {
      if (current !== sequence || KinConsoleSession.ended()) return;
      if (error.status === 401 || error.status === 403) {
        el('rows').replaceChildren(); el('wrap').hidden = true; el('scope').textContent = ''; next = null; count = 0;
      }
      el('state').textContent = 'Query Failed'; el('wrap').classList.add('stale');
      message(count ? '이어보기에 실패했습니다. 표시된 기록은 이전에 조회한 일부입니다. 다시 조회하세요.' : '접속기록 조회에 실패했습니다. 기간과 권한을 확인하고 다시 조회하세요.', true);
    } finally {
      if (current === sequence) { pending = false; controls(); }
    }
  }
  el('form').addEventListener('submit', event => { event.preventDefault(); load(false); });
  el('more').addEventListener('click', () => load(true));
  for (const name of ['from', 'until', 'filter']) el(name).addEventListener('input', clear);
  KinConsoleSession.onEnd(() => { ready = false; clear(); });
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended()) return;
    ready = session?.state === 'approved' && !session.demo && KinAuth.has('admin'); controls();
  }).catch(() => {});
})();
