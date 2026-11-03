(() => {
  'use strict';
  const el = name => document.getElementById(`audit-${name}`);
  // Existing STATUTORY_ACT groups (emr-contract/access-event.ts); the API accepts actions.
  const actions = {
    entry: ['write', 'approve-sign', 'draft-save'],
    addition: ['additional-entry', 'addendum'],
    correction: ['modify', 'amend', 'cancel', 'clear', 'discard'],
    access: ['provide-prepared', 'transfer-ended', 'transfer-aborted', 'client-shown', 'explicit-ack',
      'print-opened', 'print-done', 'pdf', 'copy', 'download', 'disclosure'],
  };
  const acts = { '기재': 'Entry', '추가기재': 'Addition', '수정': 'Correction', '열람': 'Access', none: 'None' };
  const streams = ['changes', 'views'];
  let ready = false, denied = false, pending = false, sequence = 0, selection = null;
  let pages = {}, downloaded = null;
  let inspectionSequence = 0, inspectionPending = false, inspectionSnapshot = null, inspectionFinished = false;
  let disclosureSequence = 0, disclosurePending = false, disclosureSnapshot = null, disclosureCopy = null;
  let rightsSequence = 0, rightsPending = false, rightsSnapshot = null;
  const message = text => { el('message').textContent = text; };
  const value = item => item == null ? 'Not Recorded' : typeof item === 'string' ? item : JSON.stringify(item);
  const fact = item => !item ? 'Not Recorded' : item.status === 'known' ? value(item.value) : `${item.status}: ${item.reason}`;

  function controls() {
    el('search').disabled = !ready || denied || pending;
    el('export').disabled = !ready || denied || pending;
    el('more').disabled = !ready || denied || pending;
    el('more').hidden = !streams.some(key => pages[key]?.next);
    inspectionControls(); disclosureControls(); rightsControls();
  }
  function clear() {
    sequence++; pending = false; selection = null; pages = {};
    el('export-message').textContent = '';
    el('results').hidden = true;
    for (const key of streams) { el(`${key}-rows`).replaceChildren(); el(`${key}-summary`).textContent = ''; }
    if (downloaded) { URL.revokeObjectURL(downloaded); downloaded = null; }
    controls();
  }
  function refuse() {
    denied = true; clear(); clearInspection(); clearDisclosure(true); clearRights(true); el('workspace').hidden = true;
    el('form').reset();
    message('감사 기록을 조회할 권한이 없습니다.');
  }
  function query() {
    const patientId = el('patient').value.trim(), assigningAuthority = el('authority').value.trim();
    if (!!patientId !== !!assigningAuthority) throw new Error('환자 ID와 발급 기관을 함께 입력하세요.');
    const from = new Date(`${el('from').value}Z`), to = new Date(`${el('to').value}Z`);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || from >= to) throw new Error('시작보다 뒤인 종료 시각을 지정하세요.');
    return { from: from.toISOString(), to: to.toISOString(),
      ...(patientId ? { patient: { patientId, assigningAuthority } } : {}),
      ...(actions[el('kind').value] ? { actions: actions[el('kind').value] } : {}) };
  }
  function cell(lines) {
    const td = document.createElement('td');
    for (const [label, text] of lines) {
      const line = document.createElement('div'); line.textContent = `${label}: ${value(text)}`; td.append(line);
    }
    return td;
  }
  function row(event) {
    const tr = document.createElement('tr');
    tr.append(cell([['Occurred', event.occurredAt], ['Recorded', event.committedAt]]),
      cell([['Actor', fact(event.actor)], ['Roles', fact(event.rolesAtTime)],
        ['Acting Institution', fact(event.actingInstitution)], ['Managing Institution', fact(event.managingInstitution)]]),
      cell(event.targets.flatMap(target => [['Patient', fact(target.patient)],
        ...(target.localSource ? [['Local Source', value(target.localSource)]] : []),
        ['Study', fact(target.studyId)], ['Record', fact(target.recordId)], ['Version', fact(target.versionId)]])),
      cell([['Act', acts[event.statutoryAct] || event.statutoryAct], ['Action', event.action], ['Result', event.result],
        ['Surface', event.surface], ['Event', event.eventId], ['Request', event.requestId]]));
    return tr;
  }
  function validPage(page) {
    return page && Array.isArray(page.rows) && Number.isInteger(page.total) &&
      (page.nextCursor === null || typeof page.nextCursor === 'string') &&
      page.rows.every(event => event && typeof event.eventId === 'string' && Array.isArray(event.targets));
  }
  async function load(mode = 'search') {
    if (!ready || denied || pending || (mode === 'more' && !streams.some(key => pages[key]?.next))) return;
    let selected;
    try { selected = mode === 'more' ? selection : query(); }
    catch (error) { message(error.message); return; }
    if (mode === 'search') clear();
    selection = selected;
    const current = ++sequence, context = KinWorkContext.capture('document');
    const admits = () => current === sequence && selection === selected && KinWorkContext.admits(context);
    const body = { ...selected };
    const active = streams.filter(key => mode !== 'more' || pages[key]?.next);
    if (mode === 'more') for (const key of streams) {
      if (pages[key].next) body[`${key}After`] = pages[key].next;
      else body[`${key}Done`] = true;
    }
    el('export-message').textContent = '';
    pending = true; message(mode === 'export' ? '내보내는 중입니다.' : '조회 중입니다.'); controls();
    try {
      const response = await KinSessionTransport.page().request(`${location.origin}/api/emr-audit/${mode === 'export' ? 'exports' : 'investigations'}`,
        { method: 'POST', json: body, context });
      if (!admits()) return;
      if (response.status === 403) {
        if (response.body?.code === 'AuditorNotDesignated') refuse();
        else if (response.body?.code === 'AuditScopeNotGranted') {
          if (mode === 'export') { el('export-message').textContent = '이 계정에는 내보내기 권한이 없습니다.'; message(''); }
          else message('이 계정에는 접속기록 조회 권한이 없습니다.');
        } else message('요청이 거절되었습니다. 감사 권한과 요청 상태를 확인하세요.');
        return;
      }
      if (!response.ok || response.incomplete) throw Object.assign(new Error(), { status: response.status, code: response.body?.code });
      if (!active.every(key => validPage(response.body?.[key]))) throw new Error();
      el('workspace').hidden = false;
      if (mode === 'export') {
        if (downloaded) URL.revokeObjectURL(downloaded);
        downloaded = URL.createObjectURL(new Blob([JSON.stringify(response.body, null, 2)], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a'); link.href = downloaded; link.download = 'audit-records.json';
        document.body.append(link); link.click(); link.remove();
        message('현재 조건의 전체 기록을 내보냈습니다.');
      } else {
        // Build both streams before changing either table, so a failed response cannot look complete.
        const fragments = active.map(key => {
          const fragment = document.createDocumentFragment();
          response.body[key].rows.forEach(event => fragment.append(row(event)));
          return [key, fragment];
        });
        for (const [key, fragment] of fragments) {
          const page = response.body[key], count = (pages[key]?.count || 0) + page.rows.length;
          pages[key] = { count, next: page.nextCursor };
          el(`${key}-rows`).append(fragment);
          el(`${key}-summary`).textContent = `표시 ${count}건 / 전체 ${page.total}건`;
        }
        el('results').hidden = false;
        message(streams.some(key => pages[key]?.next) ? '일부 기록을 조회했습니다. Load More로 이어서 확인하세요.' :
          streams.some(key => pages[key]?.count) ? '선택한 조건의 조회를 마쳤습니다.' : '표시할 기록이 없습니다.');
      }
    } catch (error) {
      if (!admits()) return;
      el('workspace').hidden = false;
      message(error.status === 503 && error.code === 'InvestigationTimedOut' ?
        '기간이나 조건을 좁혀 다시 시도' + (mode === 'more' ? ' — 표시된 기록은 일부입니다.' : '') :
        mode === 'export' ? '내보내기에 실패했습니다. 조건과 연결 상태를 확인하고 다시 시도하세요.' :
        mode === 'more' ? '이어보기에 실패했습니다. 표시된 기록은 일부입니다. 다시 시도하세요.' :
        '조회에 실패했습니다. 조건과 연결 상태를 확인하고 다시 시도하세요.');
    } finally {
      if (current === sequence) { pending = false; controls(); }
    }
  }
  function inspectionControls() {
    const unavailable = !ready || denied || inspectionPending;
    el('inspection-load').disabled = unavailable;
    el('inspection-month').disabled = !ready || denied || el('inspection-month').options.length < 2;
    el('inspection-start').disabled = unavailable || !el('inspection-month').value || !inspectionSnapshot || !!inspectionSnapshot.cycle;
    el('inspection-finish').disabled = unavailable || !inspectionSnapshot?.cycle || inspectionFinished;
    for (const control of el('inspection-detail').querySelectorAll('input, select, button')) {
      control.disabled = unavailable || !inspectionSnapshot?.cycle || inspectionFinished || inspectionSnapshot?.status?.state === 'closed';
    }
  }
  function clearInspection() {
    inspectionSequence++; inspectionPending = false; inspectionSnapshot = null; inspectionFinished = false;
    el('inspection-detail').hidden = true;
    el('inspection-summary').textContent = ''; el('inspection-message').textContent = '';
    for (const name of ['downloads', 'history', 'followups']) el(`inspection-${name}`).replaceChildren();
    el('inspection-review').reset(); inspectionControls();
  }
  const inspectionMessage = text => { el('inspection-message').textContent = text; };
  function field(label, name, options) {
    const wrapper = document.createElement('label'); wrapper.append(label);
    const input = document.createElement(options ? 'select' : 'input'); input.name = name;
    if (options) for (const [value, text] of options) input.add(new Option(text, value));
    else { input.required = true; input.autocomplete = 'off'; }
    wrapper.append(input); return wrapper;
  }
  function stepForm(title, fields, body) {
    const form = document.createElement('form'), group = document.createElement('fieldset'), legend = document.createElement('legend');
    form.dataset.step = JSON.stringify(body);
    legend.textContent = title; group.append(legend);
    const inputs = document.createElement('div'); inputs.className = 'inspection-actions';
    fields.forEach(args => inputs.append(field(...args)));
    const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Record'; inputs.append(button);
    group.append(inputs); form.append(group);
    form.addEventListener('submit', event => { event.preventDefault(); inspectionRequest('steps', { ...body, ...Object.fromEntries(new FormData(form)) }, form.dataset.step); });
    return form;
  }
  function showInspection(snapshot, recordedFormKey, stepOnly = false) {
    if (stepOnly) {
      if (!inspectionSnapshot || !Array.isArray(snapshot?.cycle?.events) || !snapshot.status) throw new Error('Invalid inspection step response');
      snapshot = { ...inspectionSnapshot, cycle: snapshot.cycle, status: snapshot.status };
    }
    if (!snapshot?.summary || !Array.isArray(snapshot.downloads) ||
        (snapshot.cycle && (!Array.isArray(snapshot.cycle.events) || !snapshot.status))) throw new Error('Invalid inspection response');
    // A successful row write must preserve unfinished work in the other rows.
    const drafts = new Map();
    for (const form of el('inspection-detail').querySelectorAll('form[data-step]')) {
      if (form.dataset.step !== recordedFormKey) drafts.set(form.dataset.step,
        Object.fromEntries(Array.from(form.elements).filter(control => control.name).map(control => [control.name, control.value])));
    }
    inspectionSnapshot = snapshot;
    const summary = snapshot.summary, report = snapshot.cycle?.events.find(e => e.kind === 'report-generated');
    el('inspection-summary').textContent = `Month: ${summary.month}\nEvent Count: ${report?.eventCount ?? summary.eventCount}\n` +
      `Report SHA-256: ${report?.reportSha256 ?? 'Not Recorded'}\n` +
      `Actions: ${JSON.stringify(summary.byAction)}\n` + (report ? '시작 시 저장한 보고서입니다. 이후 유입된 사건을 다시 합산하지 않습니다.' : '미리보기입니다. 시작할 때 보고서를 저장합니다.');
    if (snapshot.status) el('inspection-summary').textContent +=
      `\nReview: ${snapshot.status.state === 'report-only' ? 'Pending' : 'Recorded'}` +
      `\n미확인 다운로드 ${snapshot.status.missingDownloadReasons.length}건 / 진행 중 후속조치 ${snapshot.status.openInvestigations.length}건`;
    if (!stepOnly) {
      el('inspection-downloads').replaceChildren();
      for (const event of snapshot.downloads) {
        const block = document.createElement('div'), details = document.createElement('p');
        details.textContent = `Event: ${event.eventId} | Action: ${event.action} | Time: ${event.occurredAt} | Actor: ${fact(event.userId)} | Result: ${event.result}\nTargets: ${JSON.stringify(event.targets)}`;
        block.append(details);
        if (report) block.append(stepForm(`Download ${event.eventId}`, [
          ['Reason Check', 'reason'], ['Outcome', 'outcome', [['legitimate', 'Legitimate'], ['investigate', 'Investigate']]],
          ['Follow-up', 'followUp']], { kind: 'download-check', eventId: event.eventId }));
        el('inspection-downloads').append(block);
      }
    } else {
      for (const form of el('inspection-downloads').querySelectorAll('form[data-step]')) {
        if (form.dataset.step === recordedFormKey) form.reset();
      }
    }
    el('inspection-review').hidden = !report;
    el('inspection-followups').replaceChildren();
    for (const investigationId of snapshot.status?.openInvestigations || []) {
      const needsAction = !snapshot.cycle.events.some(e => e.kind === 'action-recorded' && e.investigationId === investigationId);
      const form = stepForm('Open Follow-up', needsAction ? [['Follow-up', 'action']] : [
        ['Result', 'result', [['not-resolved', 'Not Resolved'], ['resolved', 'Resolved']]], ['Recheck Note', 'note']],
      { kind: needsAction ? 'action-recorded' : 'rechecked', investigationId });
      const reference = document.createElement('p'); reference.textContent = investigationId; form.prepend(reference);
      el('inspection-followups').append(form);
    }
    el('inspection-history').replaceChildren();
    const titles = { reviewed: 'Review', 'download-reason': 'Reason Check', 'investigation-opened': 'Investigation',
      'action-recorded': 'Follow-up', rechecked: 'Recheck', closed: 'Closed' };
    for (const step of snapshot.cycle?.events || []) {
      if (step.kind === 'report-generated') continue;
      const line = document.createElement('p');
      line.textContent = `${titles[step.kind] || step.kind} | ${step.at} | ${value(step.by)}\n` +
        [step.eventId, step.conclusion, step.outcome, step.reason, step.summary, step.action, step.result, step.note].filter(Boolean).join('\n');
      el('inspection-history').append(line);
    }
    for (const form of el('inspection-detail').querySelectorAll('form[data-step]')) {
      for (const [name, value] of Object.entries(drafts.get(form.dataset.step) || {})) form.elements.namedItem(name).value = value;
    }
    el('inspection-detail').hidden = false;
  }
  async function inspectionRequest(mode, body, recordedFormKey) {
    if (!ready || denied || inspectionPending) return;
    const month = el('inspection-month').value;
    if (mode !== 'months' && !month) return;
    const current = ++inspectionSequence, context = KinWorkContext.capture('document');
    const admits = () => current === inspectionSequence && month === el('inspection-month').value && KinWorkContext.admits(context) && !denied;
    inspectionPending = true; inspectionMessage(mode === 'steps' ? '기록 중입니다.' : '월간 점검을 불러오는 중입니다.'); inspectionControls();
    try {
      const route = mode === 'months' ? '' : `/${encodeURIComponent(month)}` + (['report', 'steps'].includes(mode) ? `/${mode}` : '');
      const response = await KinSessionTransport.page().request(`${location.origin}/api/emr-audit/inspections${route}`,
        { method: ['report', 'steps'].includes(mode) ? 'POST' : 'GET', ...(body ? { json: body } : {}), context });
      if (!admits()) return;
      if (response.status === 403) {
        if (response.body?.code === 'AuditorNotDesignated') refuse();
        else inspectionMessage(response.body?.code === 'AuditScopeNotGranted' ? '이 계정에는 월간 점검 권한이 없습니다.' : '감사 권한과 요청 상태를 확인하세요.');
        return;
      }
      if (response.status === 503 && response.body?.code === 'InvestigationTimedOut') {
        inspectionMessage('월간 점검 처리 시간이 초과되었습니다. ' + (['report', 'steps'].includes(mode)
          ? '입력 내용은 유지했습니다. 월을 다시 열어 저장된 기록을 확인하세요.'
          : '해당 월의 결과를 가져오지 못했습니다. 잠시 후 다시 시도하세요. 반복되면 관리자에게 문의하세요.'));
        return;
      }
      if (!response.ok || response.incomplete) throw new Error();
      if (mode === 'months') {
        if (!Array.isArray(response.body?.months)) throw new Error();
        el('inspection-month').replaceChildren(new Option('Select Month', ''));
        const states = { 'awaiting-report': 'Awaiting Report', 'report-only': 'Report Only',
          'in-follow-up': 'In Follow-up', 'ready-to-close': 'Ready to Close', closed: 'Closed' };
        // Use the same Seoul calendar as the server, including the year boundary.
        const seoulNow = new Date(Date.now() + 9 * 3600_000);
        const lastEnded = new Date(Date.UTC(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        for (const item of response.body.months) el('inspection-month').add(new Option(
          `${item.month} — ${states[item.state] || item.state}${item.month < lastEnded ? ' · 기한 경과' : ''}`, item.month));
        inspectionMessage(response.body.months.length ? '점검할 달을 선택하세요. 기한이 지난 달도 점검할 수 있습니다.' : '점검이 남은 달이 없습니다.');
      } else {
        showInspection(response.body, recordedFormKey, mode === 'steps');
        inspectionMessage(mode === 'steps' ? '확인 기록을 추가했습니다.' : response.body.cycle ? '저장된 시작 보고서와 확인 기록을 표시합니다.' : 'Start Inspection으로 보고서를 저장한 뒤 확인 기록을 추가하세요.');
      }
    } catch {
      if (admits()) inspectionMessage(mode === 'steps' ? '기록 응답을 확인하지 못했습니다. 입력 내용은 유지했습니다. 월을 다시 열어 저장된 기록을 확인하세요.' :
        '월간 점검을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.');
    } finally {
      if (current === inspectionSequence) { inspectionPending = false; inspectionControls(); }
    }
  }

  const disclosureEl = name => el(`disclosure-${name}`);
  const disclosureMessage = text => { disclosureEl('message').textContent = text; };
  const formValues = name => Object.fromEntries(new FormData(disclosureEl(name)));
  const utcInput = text => {
    const date = new Date(`${text}Z`);
    if (!Number.isFinite(+date)) throw new Error('시각을 확인하세요.');
    return date.toISOString();
  };
  function disclosureControls() {
    const busy = !ready || denied || disclosurePending, state = disclosureCopy?.status.state;
    disclosureEl('open').querySelector('button').disabled = !ready || denied;
    disclosureEl('receive-button').disabled = busy || !!disclosureSnapshot;
    disclosureEl('prepare').disabled = busy || !disclosureSnapshot || !!disclosureSnapshot.facts.resolution ||
      (!!disclosureSnapshot.issuanceId && state !== 'Prepared');
    disclosureEl('issue').disabled = busy || state !== 'Prepared' || !!disclosureSnapshot?.facts.resolution;
    disclosureEl('delivery-button').disabled = busy || !['Issued', 'ReceiptUnknown', 'DeliveryFailed'].includes(state) || !!disclosureSnapshot?.facts.resolution;
    for (const name of ['extend', 'resolve']) disclosureEl(`${name}-button`).disabled = busy || !disclosureSnapshot || !!disclosureSnapshot.facts.resolution;
    for (const [name, type] of [['json', 'signed-electronic'], ['html', 'paper-print']])
      disclosureEl(name).disabled = busy || !disclosureCopy?.artifact || disclosureCopy.issuance.manifest.delivery.format !== type;
  }
  function clearDisclosure(all = false) {
    disclosureSequence++; disclosurePending = false; disclosureSnapshot = null; disclosureCopy = null;
    disclosureEl('workspace').hidden = false; disclosureEl('receive').hidden = false;
    disclosureEl('detail').hidden = true; disclosureEl('state').textContent = ''; disclosureEl('versions').replaceChildren();
    for (const name of ['json', 'html']) disclosureEl(`${name}-sha`).textContent = '';
    disclosureMessage('');
    for (const name of ['delivery', 'extend', 'resolve']) disclosureEl(name).reset();
    if (all) {
      disclosureEl('id').value = ''; disclosureEl('receive').reset();
      disclosureEl('evidence').replaceChildren(); disclosureEl('scope').replaceChildren();
      addDisclosureEvidence(); addDisclosureScope();
    }
    disclosureControls();
  }
  function addDisclosureEvidence() {
    const row = document.createElement('div'); row.className = 'inspection-actions';
    row.append(field('Evidence Kind', 'evidenceKind', [['identity-check', 'Identity Check'], ['patient-consent', 'Patient Consent'],
      ['relationship-proof', 'Relationship Proof'], ['agency-proof', 'Agency Proof'], ['consent-impossible', 'Consent Impossible'], ['official-request', 'Official Request']]),
      field('Evidence Document ID', 'documentId'));
    disclosureEl('evidence').append(row);
  }
  function addDisclosureScope() {
    const row = document.createElement('div'); row.className = 'inspection-actions';
    row.append(field('Record ID', 'recordId'), field('Version Scope', 'versionScope', [['all', 'All Versions'], ['part', 'Requested Part']]), field('Requested Version IDs', 'versions'));
    const versions = row.querySelector('[name=versions]'), select = row.querySelector('select');
    versions.required = false; versions.disabled = true;
    select.addEventListener('change', () => { versions.disabled = select.value === 'all'; versions.required = select.value !== 'all'; });
    disclosureEl('scope').append(row);
  }
  function disclosureIntake(id) {
    const v = formValues('receive'), checkedBy = { id: v.verifierId, issuer: v.verifierIssuer, subject: v.verifierSubject };
    return { dueAt: utcInput(v.dueAt), request: { requestId: id, receivedAt: utcInput(v.receivedAt),
      patient: { patientId: v.patientId, assigningAuthority: v.assigningAuthority, linkId: v.linkId },
      basis: { clauseId: v.clauseId, purpose: v.purpose },
      requester: { kind: v.requesterKind, name: v.requesterName, organization: v.organization || null },
      evidence: Array.from(disclosureEl('evidence').children, row => ({ kind: row.querySelector('[name=evidenceKind]').value,
        documentId: row.querySelector('[name=documentId]').value, checkedBy, checkedAt: utcInput(v.checkedAt) })),
      scope: Array.from(disclosureEl('scope').children, row => ({ recordId: row.querySelector('[name=recordId]').value,
        versions: row.querySelector('select').value === 'all' ? 'all' : row.querySelector('[name=versions]').value.split(',').map(id => id.trim()).filter(Boolean) })),
      delivery: { recipient: v.recipient, method: v.method, format: v.method === 'electronic' ? 'signed-electronic' : 'paper-print' } } };
  }
  function showDisclosure(snapshot, copy) {
    disclosureSnapshot = snapshot; disclosureCopy = copy;
    const request = snapshot.request, facts = snapshot.facts;
    disclosureEl('receive').hidden = true;
    disclosureEl('detail').hidden = false;
    const labels = { pending: 'Pending', 'pending-overdue': 'Pending Overdue', 'release-required': 'Release Required',
      'hold-out-of-sync': 'Hold Out of Sync', released: 'Released' };
    disclosureEl('state').textContent = `Request ID: ${facts.requestId}\nPatient: ${request.patient.patientId} / ${request.patient.assigningAuthority}\n` +
      `Requester: ${request.requester.name}\nRecipient: ${request.delivery.recipient}\nMethod: ${request.delivery.method}\n` +
      `Request: ${facts.resolution ? 'Resolved' : 'Pending'}\nIssuance ID: ${snapshot.issuanceId ?? 'null'}\n` +
      `Issuance: ${copy?.status.state ?? (snapshot.issuanceId ? 'Unavailable' : 'Not Prepared')}\n` +
      snapshot.states.map(h => `Hold: ${labels[h.state] || h.state} / Due At: ${h.dueAt}`).join('\n') +
      (snapshot.issuanceId === null ? '\n발급 준비가 아직 완료되지 않았습니다. 원본 누락 또는 준비 실패 상태에서도 연장·종결할 수 있습니다.' : '') +
      `\nResolution: ${facts.resolution ? JSON.stringify(facts.resolution) : 'Not Recorded'}`;
    if (copy) {
      const history = copy.issuance.events.filter(e => e.kind === 'delivery');
      for (const event of history) disclosureEl('state').textContent +=
        `\nDelivery: ${event.outcome} / Recorded At: ${event.at}\nEvidence: ${event.evidence?.evidenceId ?? 'Not Recorded'}\n${event.note || ''}`;
    }
    disclosureEl('versions').replaceChildren();
    for (const record of copy?.issuance.manifest.records || []) for (const version of record.versions) {
      const row = document.createElement('tr');
      for (const text of [record.recordId, record.selection === 'all-versions' ? 'All Versions' : 'Requested Part', version.versionId, version.act, version.sha256]) {
        const td = document.createElement('td'); td.textContent = text; row.append(td);
      }
      disclosureEl('versions').append(row);
    }
    for (const [name, format] of [['json', 'signed-electronic'], ['html', 'paper-print']])
      disclosureEl(`${name}-sha`).textContent = copy?.artifact && copy.issuance.manifest.delivery.format === format ? `SHA-256: ${copy.sha256} (서버 보고)` : '';
    const extend = disclosureEl('extend');
    extend.elements.clauseId.value = snapshot.holds[0].basis.clauseId;
    extend.elements.version.value = snapshot.holds[0].basis.clause.version;
    disclosureEl('delivery').elements.recipient.value = request.delivery.recipient;
    disclosureEl('delivery').elements.kind.value = request.delivery.method === 'electronic' ? 'electronic-receipt' : 'recipient-signed-receipt';
    disclosureControls();
  }
  async function disclosureRequest(mode) {
    if (!ready || denied || disclosurePending) return;
    const id = disclosureEl('id').value.trim();
    if (!id) { disclosureMessage('요청 ID를 입력하세요.'); return; }
    let body, path = `requests/${encodeURIComponent(id)}`;
    try {
      if (mode === 'receive') { body = disclosureIntake(id); path = 'requests'; }
      else if (mode === 'prepare') { body = { request: disclosureSnapshot.request, dueAt: disclosureSnapshot.facts.initialDueAt }; path = 'issuances'; }
      else if (mode === 'issue' || mode === 'delivery') {
        path = `issuances/${encodeURIComponent(disclosureSnapshot.issuanceId)}/${mode}`;
        if (mode === 'delivery') {
          const v = formValues('delivery');
          body = { outcome: v.outcome, evidence: v.outcome === 'unknown' ? null : { kind: v.kind, evidenceId: v.evidenceId },
            note: `Method: ${disclosureSnapshot.request.delivery.method}\nDelivered At: ${utcInput(v.deliveredAt)}\nRecipient: ${v.recipient}\n${v.note}` };
        }
      } else if (mode === 'extend') {
        const v = formValues('extend'); path += '/extend';
        body = { extensionId: crypto.randomUUID(), previousDueAt: disclosureSnapshot.states[0].dueAt, dueAt: utcInput(v.dueAt),
          basis: { clauseId: v.clauseId, version: v.version }, evidenceId: v.evidenceId };
      } else if (mode === 'resolve') { body = formValues('resolve'); path += '/resolve'; }
    } catch (error) { disclosureMessage(error.message || '입력을 확인하세요.'); return; }
    const current = ++disclosureSequence, context = KinWorkContext.capture('document');
    const admits = () => current === disclosureSequence && id === disclosureEl('id').value.trim() && KinWorkContext.admits(context);
    disclosurePending = true; disclosureMessage('요청을 처리하고 있습니다.'); disclosureControls();
    const call = async (route, method = 'GET', json) => {
      const response = await KinSessionTransport.page().request(`${location.origin}/api/emr-audit/${route}`,
        { method, ...(json ? { json } : {}), context });
      if (!admits()) throw { stale: true };
      if (response.status === 403 && response.body?.code === 'AuditorNotDesignated') { refuse(); throw { stale: true }; }
      if (response.status === 403 && response.body?.code === 'AuditScopeNotGranted') throw { scope: true };
      if (!response.ok || response.incomplete) throw { code: response.body?.code || 'ResponseUnavailable' };
      return response.body;
    };
    try {
      let failure = null;
      if (mode !== 'open') {
        try { await call(path, 'POST', body); }
        catch (error) { if (error.stale || error.scope) throw error; failure = error; }
      }
      // Intake survives failed preparation. Re-read it even after an unsuccessful action or lost response.
      const snapshot = await call(`requests/${encodeURIComponent(id)}`);
      let copy = null;
      if (snapshot.issuanceId) {
        try { copy = await call(`issuances/${encodeURIComponent(snapshot.issuanceId)}`); }
        catch (error) { if (error.stale || error.scope) throw error; failure = error; }
      }
      if (!admits()) return;
      showDisclosure(snapshot, copy);
      disclosureMessage(failure ? `처리 결과를 확인하세요 (${failure.code}). 아래는 다시 조회한 상태입니다. 입력은 유지했습니다.` : '저장된 요청과 발급 상태를 다시 조회했습니다.');
    } catch (error) {
      if (!admits() || error.stale) return;
      if (error.scope) { clearDisclosure(); disclosureEl('workspace').hidden = true; disclosureMessage('이 계정에는 진료기록 사본 발급 권한이 없습니다.'); }
      else {
        // A failed refresh cannot leave old action buttons presenting a confirmed state.
        disclosureSnapshot = null; disclosureCopy = null; disclosureEl('detail').hidden = true;
        disclosureMessage(`요청 상태를 확인하지 못했습니다 (${error.code || 'ResponseUnavailable'}). 입력은 유지했습니다. Open Request로 다시 확인하세요.`);
      }
    } finally {
      if (current === disclosureSequence) { disclosurePending = false; disclosureControls(); }
    }
  }
  function downloadDisclosure(format) {
    if (disclosurePending || denied || !ready || !disclosureCopy?.artifact || disclosureCopy.issuance.manifest.delivery.format !== format) return;
    const bytes = Uint8Array.from(atob(disclosureCopy.artifact), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: disclosureCopy.contentType }));
    const link = document.createElement('a'); link.href = url;
    link.download = `record-copy-${disclosureCopy.issuance.issuanceId.replace(/[^a-zA-Z0-9-]/g, '-')}.${format === 'paper-print' ? 'html' : 'json'}`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  disclosureEl('id').addEventListener('input', () => clearDisclosure());
  disclosureEl('open').addEventListener('submit', event => { event.preventDefault(); clearDisclosure(); disclosureRequest('open'); });
  for (const mode of ['receive', 'delivery', 'extend', 'resolve']) disclosureEl(mode).addEventListener('submit', event => {
    event.preventDefault(); disclosureRequest(mode);
  });
  for (const mode of ['prepare', 'issue']) disclosureEl(mode).addEventListener('click', () => disclosureRequest(mode));
  disclosureEl('add-evidence').addEventListener('click', addDisclosureEvidence);
  disclosureEl('add-scope').addEventListener('click', addDisclosureScope);
  disclosureEl('json').addEventListener('click', () => downloadDisclosure('signed-electronic'));
  disclosureEl('html').addEventListener('click', () => downloadDisclosure('paper-print'));
  addDisclosureEvidence(); addDisclosureScope();

  const rightsEl = name => el(`rights-${name}`);
  function rightsControls() {
    const off = !ready || denied || rightsPending;
    for (const name of ['load', 'open-button', 'receive-button']) rightsEl(name).disabled = off;
    const closed = !!rightsSnapshot?.notification || !!rightsSnapshot?.withdrawal;
    const form = rightsEl('notify'), withdrawing = form.elements.outcome.value === 'withdrawn';
    rightsEl('decide').disabled = off || !rightsSnapshot || !!rightsSnapshot.decision || closed;
    form.elements.outcome.disabled = off || !rightsSnapshot || closed;
    for (const input of form.querySelectorAll('input, textarea, button')) {
      const noticeOnly = ['notifiedAt', 'recipient', 'method', 'content'].includes(input.name);
      input.disabled = off || !rightsSnapshot || closed || (withdrawing ? noticeOnly : !rightsSnapshot.decision);
      if (noticeOnly) input.required = !withdrawing;
    }
    rightsEl('notify-button').textContent = withdrawing ? 'Record Withdrawal' : 'Record Notification';
  }
  function clearRights(all = false) {
    rightsSequence++; rightsPending = false; rightsSnapshot = null;
    rightsEl('detail').hidden = true; rightsEl('state').textContent = ''; rightsEl('notice').textContent = '';
    rightsEl('correction').hidden = true;
    if (all) { rightsEl('list').replaceChildren(); rightsEl('receive').reset(); rightsEl('notify').reset(); rightsEl('id').value = ''; }
    rightsControls();
  }
  function noticeDraft(state) {
    if (!state.decision) return '결정 후 계약의 근거 조문을 표시합니다.';
    const d = state.decision;
    return ['통지 문안 확정 전 (P5). 아래는 계약의 결정 및 근거 조문 자리표시입니다.',
      ...d.records.map(r => `${r.recordId}: ${r.outcome}\n근거 조문: ${r.basis.join(', ') || '계약에 별도 조문 없음'}`),
      ...(d.records.some(r => r.outcome.startsWith('refused-')) ? ['보존기간 경과 여부는 이 결정에 반영되지 않습니다(CD-07-Q1 미정). 보존기간이 끝난 기록이면 통지 전에 확인하세요.'] : []),
      d.notice.content === 'refusal-with-reason-and-objection-method' ?
        '거절 사유: 위 계약의 결정·근거 조문.\n이의제기 방법: 문안 확정 전 (P5).' :
        '조치 결과 통지: 실제 수행 결과를 확인하여 문안을 작성하세요.'].join('\n');
  }
  function showRights(state) {
    rightsSnapshot = state; rightsEl('detail').hidden = false;
    rightsEl('state').textContent = [`Request: ${state.status}`, `Request ID: ${state.request.requestId}`,
      `Kind: ${state.request.kind}`, `Patient ID: ${state.request.patient.patientId}`,
      `Assigning Authority: ${state.request.patient.assigningAuthority}`, `Patient Link ID: ${state.request.patient.linkId}`,
      `Records: ${state.request.recordIds.join(', ')}`, `Statement: ${state.request.statement}`,
      `Received At: ${state.request.receivedAt}`, `Received By: ${state.receivedBy.subject}`, `Recorded At: ${state.recordedAt}`,
      `Notice Due By: ${state.dueBy}`,
      state.overdue ? '통지 기한 경과: 철회 기록 시각, 실제 통지 시각 또는 현재 시각 기준입니다.' : '통지 기한 내',
      ...(state.decision ? [`Decided At: ${state.decision.decidedAt}`, `Decided By: ${state.decision.decidedBy.subject}`] : []),
      ...(state.notification ? [`Notified At: ${state.notification.notifiedAt}`, `Evidence: ${state.notification.evidenceId}`,
        `Notice: ${state.notification.content}`, `Recorded By: ${state.notification.recordedBy.subject}`,
        `Notification Recorded At: ${state.notification.recordedAt}`] : []),
      ...(state.withdrawal ? [`Withdrawn At: ${state.withdrawal.recordedAt}`, `Evidence: ${state.withdrawal.evidenceId}`,
        `Recorded By: ${state.withdrawal.recordedBy.subject}`, '철회 증빙으로 요구와 응답 의무를 닫았습니다.'] : [])].join('\n');
    rightsEl('notice').textContent = noticeDraft(state);
    rightsEl('correction').hidden = !state.decision?.records.some(r => r.outcome === 'correct-by-new-signed-version');
    if (state.notification) for (const key of ['notifiedAt', 'recipient', 'method', 'evidenceId', 'content'])
      rightsEl('notify').elements[key].value = key === 'notifiedAt' ? state.notification[key].replace(/Z$/, '') : state.notification[key];
    if (state.notification) rightsEl('notify').elements.outcome.value = 'notified';
    if (state.withdrawal) {
      rightsEl('notify').elements.outcome.value = 'withdrawn';
      rightsEl('notify').elements.evidenceId.value = state.withdrawal.evidenceId;
    }
    rightsControls();
  }
  function showRightsList(rows) {
    rightsEl('list').replaceChildren();
    for (const r of rows) {
      const tr = document.createElement('tr'), td = document.createElement('td'), open = document.createElement('button');
      open.type = 'button'; open.textContent = r.requestId;
      open.addEventListener('click', () => {
        if (rightsEl('id').value !== r.requestId) rightsEl('notify').reset();
        rightsEl('id').value = r.requestId; clearRights(); rightsRequest('open');
      });
      td.append(open); tr.append(td);
      for (const text of [r.kind, r.receivedAt, r.status, r.dueBy + (r.overdue ? ' — 통지 기한 경과' : '')]) {
        const cell = document.createElement('td'); cell.textContent = text; tr.append(cell);
      }
      rightsEl('list').append(tr);
    }
  }
  async function rightsRequest(mode) {
    if (!ready || denied || rightsPending) return;
    const id = rightsEl('id').value.trim();
    let path = 'rights-requests', body;
    try {
      if (mode !== 'list' && !id) throw Error('요구 ID를 입력하세요.');
      if (mode === 'receive') {
        const v = Object.fromEntries(new FormData(rightsEl('receive')));
        body = { requestId: id, kind: v.kind, receivedAt: utcInput(v.receivedAt),
          patient: { patientId: v.patientId, assigningAuthority: v.assigningAuthority, linkId: v.linkId },
          recordIds: v.recordIds.split(',').map(s => s.trim()).filter(Boolean), statement: v.statement };
      } else if (mode !== 'list') {
        path += `/${encodeURIComponent(id)}`;
        if (mode !== 'open') path += `/${mode}`;
        if (mode === 'notify') {
          body = Object.fromEntries(new FormData(rightsEl('notify')));
          if (body.outcome === 'withdrawn') body = { outcome: 'withdrawn', evidenceId: body.evidenceId };
          else { delete body.outcome; body.notifiedAt = utcInput(body.notifiedAt); }
        }
      }
    } catch (error) { rightsEl('message').textContent = error.message || '입력을 확인하세요.'; return; }
    const current = ++rightsSequence, context = KinWorkContext.capture('document');
    const admits = () => current === rightsSequence && id === rightsEl('id').value.trim() && KinWorkContext.admits(context);
    rightsPending = true; rightsControls(); rightsEl('message').textContent = '요구를 처리하고 있습니다.';
    let decisionRefused = false;
    try {
      const response = await KinSessionTransport.page().request(`${location.origin}/api/emr-audit/${path}`,
        { method: ['list', 'open'].includes(mode) ? 'GET' : 'POST', ...(body ? { json: body } : {}), context });
      if (!admits()) return;
      if (response.status === 403 && response.body?.code === 'AuditorNotDesignated') { refuse(); return; }
      if (response.status === 403 && response.body?.code === 'AuditScopeNotGranted') {
        clearRights(true); rightsEl('workspace').hidden = true; rightsEl('message').textContent = '이 계정에는 정정·삭제·처리정지 요구 처리 권한이 없습니다.'; return;
      }
      if (!response.ok || response.incomplete) {
        decisionRefused = mode === 'decide' && !response.incomplete && [400, 409].includes(response.status) &&
          !['RightsRequestWithdrawn', 'RightsRequestConflict'].includes(response.body?.code);
        throw Error(response.body?.code || 'ResponseUnavailable');
      }
      if (mode === 'list') showRightsList(response.body.requests); else showRights(response.body);
      rightsEl('message').textContent = mode === 'list' ? '저장된 요구 목록입니다.' : response.body.status === 'Withdrawn' ?
        '철회 증빙으로 요구와 응답 의무를 닫았습니다.' : '저장된 요구 상태입니다. 실제 통지는 증빙을 입력하여 기록하세요.';
    } catch (error) {
      if (!admits()) return;
      if (!decisionRefused) { rightsSnapshot = null; rightsEl('detail').hidden = true; }
      rightsEl('message').textContent = decisionRefused ?
        `결정이 거절되어 요구는 Received로 남고, 열린 응답 의무가 접속기록 만료를 계속 막습니다(CD-07-Q4). 철회가 아니면 닫지 않습니다 (${error.message}).` :
        mode === 'receive' && ['RightsRecordUnsupported', 'RightsRecordAmbiguous', 'VersionListingIncomplete'].includes(error.message) ?
        '이 기록 종류는 아직 이 화면에서 처리할 수 없습니다(CD-07-Q3 미정). 접수 사실은 별도로 기록하세요.' :
        `요구 상태를 확인하지 못했습니다 (${error.message}). 입력은 유지했습니다. Open Request로 다시 확인하세요.`;
    } finally { if (current === rightsSequence) { rightsPending = false; rightsControls(); } }
  }
  rightsEl('id').addEventListener('input', () => { rightsEl('notify').reset(); clearRights(); });
  rightsEl('load').addEventListener('click', () => rightsRequest('list'));
  for (const mode of ['open', 'receive', 'notify']) rightsEl(mode).addEventListener('submit', event => {
    event.preventDefault(); if (mode === 'open') clearRights(); rightsRequest(mode);
  });
  rightsEl('decide').addEventListener('click', () => rightsRequest('decide'));
  rightsEl('notify').elements.outcome.addEventListener('change', rightsControls);

  el('inspection-load').addEventListener('click', () => { clearInspection(); inspectionRequest('months'); });
  el('inspection-month').addEventListener('change', () => { clearInspection(); inspectionRequest('month'); });
  el('inspection-start').addEventListener('click', () => inspectionRequest('report'));
  el('inspection-review').addEventListener('submit', event => {
    event.preventDefault(); inspectionRequest('steps', { kind: 'reviewed', ...Object.fromEntries(new FormData(event.currentTarget)) });
  });
  el('inspection-finish').addEventListener('click', () => {
    inspectionFinished = true; inspectionControls();
    inspectionMessage('화면에서 점검 작업을 마쳤습니다. 추가 기록은 저장하지 않았습니다. 위 해시와 사건 수는 시작할 때 저장한 보고서 값입니다. 미확인·미해결 사항이 있으면 계속 남습니다.');
  });
  el('form').addEventListener('submit', event => { event.preventDefault(); load(); });
  el('export').addEventListener('click', () => load('export'));
  el('more').addEventListener('click', () => load('more'));
  for (const name of ['patient', 'authority', 'from', 'to', 'kind']) el(name).addEventListener('input', () => {
    clear(); message('조건이 바뀌었습니다. Search로 조회하세요.');
  });
  el('logout').addEventListener('click', () => KinAuth.logout());
  KinAuth.onLifecycle(state => {
    if (['ending', 'unconfirmed', 'confirmed'].includes(state.state)) {
      ready = false; clear(); clearInspection(); clearDisclosure(true); clearRights(true); el('workspace').hidden = true;
      el('form').reset(); message('세션을 확인하고 다시 로그인하세요.');
    }
  });
  KinAuth.onEndedElsewhere(() => KinAuth.leave());
  KinAuth.init().then(session => {
    if (!session || KinAuth.lifecycle().state !== 'active') { KinAuth.leave(); return; }
    // Start with today's UTC calendar window; authority still comes only from the route response.
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    el('from').value = today.toISOString().slice(0, 16); el('to').value = tomorrow.toISOString().slice(0, 16);
    disclosureEl('id').value = crypto.randomUUID();
    rightsEl('id').value = crypto.randomUUID();
    rightsEl('receive').elements.receivedAt.value = new Date().toISOString().slice(0, 16);
    for (const name of ['receivedAt', 'checkedAt']) disclosureEl('receive').elements[name].value = new Date().toISOString().slice(0, 16);
    ready = true; el('workspace').hidden = false; controls(); message('조건을 선택하고 Search로 조회하세요.');
  }).catch(() => message('세션을 확인할 수 없습니다. 다시 로그인하세요.'));
})();
