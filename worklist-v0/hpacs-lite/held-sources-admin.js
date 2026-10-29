(function () {
  'use strict';
  // D1882 Held Studies: studies whose sending hospital is unknown, as the server groups them (device, raw InstitutionName
  // text, arrival times, count; no patient or study fact). Registering a device or a spelling the hospital confirmed is
  // one POST; the server attaches the held studies it now decides. The page owns termination (KinConsoleSession).
  const API = `${location.origin}/api`;
  const $ = selector => document.querySelector(selector);
  let seq = 0, pending = null;

  function message(text) {
    const box = $('#held-message');
    box.textContent = text || '';
    box.classList.toggle('show', !!text);
  }

  async function request(method, path, body) {
    if (KinConsoleSession.ended()) throw new Error('세션이 종료되었습니다');
    const context = KinWorkContext.capture('document');
    const response = await KinSessionTransport.page().request(API + path, { method, json: body, context });
    if (!KinWorkContext.admits(context)) throw new Error('세션이 종료되었습니다');
    if (!response.ok || response.incomplete) throw Object.assign(new Error(`HTTP ${response.status}`),
      { status: response.status, code: response.body?.code });
    return response.body;
  }

  // Fixed sentences only: server wording is never shown here.
  function failure(error, writing) {
    if (error?.status === 403) return writing ? '이 계정으로는 등록할 수 없습니다.' : '이 계정으로는 보류 검사 알림을 조회할 수 없습니다.';
    if (error?.status === 409) return '이미 다른 기관에 등록된 값입니다. 병원과 다시 확인하세요.';
    if (error?.status === 400) return '입력을 확인하세요. 장비 AE Title은 16자 이내이고 병원과 확인한 내용이 필요합니다.';
    if (error?.status === 503) return '서버가 바쁘거나 원본 조회가 지연되었습니다. 잠시 후 다시 시도하세요.';
    return writing ? '등록 결과를 확인하지 못했습니다. Refresh로 현재 상태를 확인하세요.' : '보류 검사 알림을 불러오지 못했습니다.';
  }

  function state(key, text) {
    const chip = $('#held-state');
    chip.className = `gstate ${key}`;
    chip.textContent = text;
  }

  function cell(row, value) {
    const td = document.createElement('td');
    td.textContent = value;
    row.append(td);
    return td;
  }

  function draw(result) {
    const groups = Array.isArray(result?.groups) ? result.groups : null;
    if (!groups || groups.some(g => !g || !Number.isInteger(g.count) || typeof g.institutionText !== 'string' ||
        !Array.isArray(g.institutionNames) || g.institutionNames.some(n => typeof n !== 'string') ||
        !(g.device === null || typeof g.device === 'string'))) throw new Error('format');
    const total = groups.reduce((n, g) => n + g.count, 0);
    state(total ? 'retry_requested' : 'observed', total ? `Held ${total}` : 'None Held');
    const own = result.institution?.name || result.institution?.id || '';
    const rows = groups.map(group => {
      const tr = document.createElement('tr');
      cell(tr, group.device ?? 'Not Recorded').title = group.device ? '' : '수신 장비(AE Title)가 기록되지 않았습니다(REST 업로드 등). 기관명 표기로만 연결할 수 있습니다.';
      cell(tr, group.institutionText || '(empty)');
      cell(tr, group.reason === 'patient_not_identified' ? 'Patient Not Identified' : 'Unknown Source');
      cell(tr, group.firstArrival);
      cell(tr, group.lastArrival);
      cell(tr, String(group.count));
      const actions = cell(tr, '');
      if (group.reason === 'patient_not_identified') {
        const guidance = document.createElement('p');
        guidance.textContent = '송신 병원에서 환자를 확인해 PatientID를 보정·재전송한 뒤 아카이브 관리자가 PatientID가 비어 있는 기존 사본을 제거해야 합니다. 이후 Refresh Held Studies로 확인하세요. 환자를 확인하지 못한 검사는 판독하지 않습니다.';
        actions.append(guidance);
      }
      if (group.sourceUnregistered === false) return tr;
      const add = (label, kind, value, refusal) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = !!refusal;
        button.title = refusal || `${value} → ${own}`;
        button.addEventListener('click', () => open(kind, value, own));
        actions.append(button);
      };
      if (group.device) add('Register Device', 'device', group.device, '');
      // The server's list decides multiplicity; a " / " inside one hospital's own spelling is still one spelling.
      const names = group.institutionNames;
      if (names.length > 1)
        add('Register Name', 'alias', group.institutionText, '표기가 여럿인 기관명은 등록할 수 없습니다. 수신 장비 등록으로 연결하세요.');
      else if (names[0]) add('Register Name', 'alias', names[0], '');
      return tr;
    });
    $('#held-rows').replaceChildren(...rows);
    $('#held-wrap').hidden = !rows.length;
    $('#held-empty').hidden = !!rows.length;
  }

  // `outcome`: a registration's result, kept on screen through the refresh that follows it.
  async function refresh(outcome = '') {
    if (KinConsoleSession.ended()) return;
    const mine = ++seq;
    $('#held-refresh').disabled = true;
    state('not_loaded', 'Loading');
    let result = null, error = null;
    try { result = await request('GET', '/admin/held-sources'); } catch (e) { error = e; }
    if (mine !== seq) return;
    $('#held-refresh').disabled = false;
    try {
      if (error) throw error;
      draw(result);
      message(outcome);
    } catch (e) {
      state('query_failed', 'Unknown');
      message([outcome, failure(e === error ? error : null, false)].filter(Boolean).join(' '));
    }
  }

  function open(kind, value, own) {
    if (KinConsoleSession.ended() || pending) return;
    const dialog = $('#held-dialog'), form = $('#held-form');
    form.reset();
    form.dataset.kind = kind;
    form.dataset.value = value;
    $('#held-dialog-title').textContent = kind === 'device' ? 'Register Device' : 'Register Name';
    $('#held-dialog-target').textContent = kind === 'device'
      ? `수신 장비 "${value}"를 ${own}의 장비로 등록합니다. 이 장비로 받은 보류 검사와 앞으로 받을 검사가 ${own}에 연결됩니다.`
      : `기관명 표기 "${value}"를 ${own}의 표기로 등록합니다. 이 표기로 받은 보류 검사와 앞으로 받을 검사가 ${own}에 연결됩니다.`;
    $('#held-dialog-message').textContent = '';
    dialog.showModal();
  }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget, kind = form.dataset.kind, value = form.dataset.value;
    const confirmation = form.elements.confirmation.value.trim();
    if (!confirmation || pending) return;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    pending = kind;
    try {
      const result = await request('POST', kind === 'device' ? '/admin/source-devices' : '/admin/institution-aliases', { value, confirmation });
      if (KinConsoleSession.ended()) return;
      $('#held-dialog').close();
      const outcome = result?.changed === false ? '이미 이 기관에 등록된 값입니다.'
        : `등록했습니다. 보류 검사 ${Number.isInteger(result?.attached) ? result.attached : 0}건이 이 기관에 연결되었습니다.`;
      message(outcome);
      void refresh(outcome);
    } catch (error) {
      if (KinConsoleSession.ended()) return;
      $('#held-dialog-message').textContent = failure(error, true);
    } finally {
      pending = null;
      button.disabled = false;
    }
  }

  KinConsoleSession.onEnd(() => {
    seq++;
    $('#held-rows').replaceChildren();
    $('#held-wrap').hidden = true;
    $('#held-empty').hidden = true;
    $('#held-refresh').disabled = true;
    state('not_loaded', 'Not Loaded');
    message('');
    if ($('#held-dialog').open) $('#held-dialog').close();
  });
  $('#held-refresh').addEventListener('click', () => refresh());
  $('#held-form').addEventListener('submit', submit);
  $('#held-cancel').addEventListener('click', () => $('#held-dialog').close());
  // Enabled only for the session the Members console accepts; arriving from the worklist alert reads it at once.
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    $('#held-refresh').disabled = false;
    if (location.hash === '#held-sources') void refresh();
  }).catch(() => {});
})();
