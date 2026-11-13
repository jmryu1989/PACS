(function () {
  'use strict';
  // FC-070 DICOM Peers: the administrator registers the hospital's other PACS or modalities (name, AE Title, host, port)
  // that the worklist's Query/Retrieve searches and pulls from, and removes them (GET/POST /api/admin/dicom-peers,
  // DELETE /api/admin/dicom-peers/:id). Like Held Studies, opening the page reads nothing: Refresh Peers (or arriving at
  // #dicom-peers) reads the list, and each Add or Remove reads it again. The page owns termination (KinConsoleSession).
  // Film / DICOM Print: Kind "Film Printer" registers a DICOM film printer with the film sizes it takes (kind and sizes are
  // sent only for a printer); a printer is never searched or pulled from.
  const API = `${location.origin}/api`;
  const $ = selector => document.querySelector(selector);
  const FIELDS = ['#dicom-peer-name', '#dicom-peer-aet', '#dicom-peer-host', '#dicom-peer-port', '#dicom-peer-kind', '#dicom-peer-add', '#dicom-peers-refresh'];
  const SIZES = () => [...document.querySelectorAll('#dicom-peer-film-sizes input[type=checkbox]')];
  let enabled = false, pending = false, seq = 0;

  function message(text) {
    const box = $('#dicom-peers-message');
    box.textContent = text || '';
    box.classList.toggle('show', !!text);
  }

  function controls(on) {
    for (const id of FIELDS) $(id).disabled = !on;
    for (const box of SIZES()) box.disabled = !on;
    for (const button of document.querySelectorAll('#dicom-peers-rows button')) button.disabled = !on;
  }

  async function request(method, path, body) {
    if (KinConsoleSession.ended()) throw new Error('세션이 종료되었습니다');
    const context = KinWorkContext.capture('document');
    const response = await KinSessionTransport.page().request(API + path, { method, json: body, context });
    if (!KinWorkContext.admits(context)) throw new Error('세션이 종료되었습니다');
    if (!response.ok || response.incomplete) throw Object.assign(new Error(`HTTP ${response.status}`),
      { status: response.status, said: typeof response.body?.message === 'string' ? response.body.message : '' });
    return response.body;
  }

  // The server's input checks are worded for this screen (400, 409); other refusals get fixed sentences.
  function failure(error, what) {
    if ((error?.status === 400 || error?.status === 409) && error.said) return error.said;
    if (error?.status === 403) return '이 계정으로는 상대 PACS를 관리할 수 없습니다.';
    if (error?.status === 404) return '이미 지워진 상대 PACS입니다. 목록을 다시 불러왔습니다.';
    if (error?.status === 503) return `${what} 결과를 확인하지 못했습니다. 잠시 후 다시 시도하세요.`;
    return `${what} 결과를 확인하지 못했습니다. 페이지를 다시 열어 지금 목록을 확인하세요.`;
  }

  function cell(tr, value) {
    const td = document.createElement('td');
    td.textContent = value;
    tr.append(td);
    return td;
  }

  function render(peers) {
    const rows = $('#dicom-peers-rows');
    rows.replaceChildren();
    for (const peer of peers) {
      const tr = document.createElement('tr');
      tr.dataset.peer = peer.id;
      cell(tr, peer.name); cell(tr, peer.aet); cell(tr, peer.host); cell(tr, String(peer.port));
      cell(tr, peer.kind === 'printer' ? 'Film Printer' + (peer.filmSizes ? ' (' + peer.filmSizes.split(',').join(', ') + ')' : '') : 'PACS / Modality');
      cell(tr, typeof peer.createdAt === 'string' ? peer.createdAt.slice(0, 16).replace('T', ' ') : '');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Remove';
      button.disabled = !enabled || pending;
      button.addEventListener('click', () => void remove(peer));
      cell(tr, '').append(button);
      rows.append(tr);
    }
    $('#dicom-peers-wrap').hidden = !peers.length;
    $('#dicom-peers-empty').hidden = !!peers.length;
    const chip = $('#dicom-peers-state');
    chip.className = `gstate ${peers.length ? 'observed' : 'not_loaded'}`;
    chip.textContent = peers.length ? `${peers.length} Registered` : 'None';
  }

  async function load() {
    const mine = ++seq;
    const body = await request('GET', '/admin/dicom-peers');
    if (mine === seq && !KinConsoleSession.ended()) render(Array.isArray(body?.peers) ? body.peers : []);
  }

  async function run(work, what) {
    if (KinConsoleSession.ended() || pending || !enabled) return;
    pending = true;
    controls(false);
    message('');
    try { await work(); }
    catch (error) {
      if (KinConsoleSession.ended()) return;
      message(failure(error, what));
      if (error?.status === 404) await load().catch(() => {});
    } finally {
      pending = false;
      if (!KinConsoleSession.ended() && enabled) controls(true);
    }
  }

  function remove(peer) {
    return run(async () => {
      await request('DELETE', '/admin/dicom-peers/' + encodeURIComponent(peer.id));
      await load();
      message(`${peer.name} (${peer.aet})를 지웠습니다.`);
    }, '삭제');
  }

  function refresh() {
    return run(() => load(), '목록 조회');
  }

  KinConsoleSession.onEnd(() => {
    enabled = false;
    controls(false);
    $('#dicom-peers-rows').replaceChildren();
    $('#dicom-peers-wrap').hidden = true;
    $('#dicom-peers-empty').hidden = true;
    $('#dicom-peers-state').className = 'gstate not_loaded';
    $('#dicom-peers-state').textContent = 'Not Loaded';
    message('');
  });
  $('#dicom-peers-refresh').addEventListener('click', () => void refresh());
  $('#dicom-peer-kind').addEventListener('change', () => { $('#dicom-peer-film-sizes').hidden = $('#dicom-peer-kind').value !== 'printer'; });
  $('#dicom-peers-form').addEventListener('submit', event => {
    event.preventDefault();
    const peer = { name: $('#dicom-peer-name').value, aet: $('#dicom-peer-aet').value, host: $('#dicom-peer-host').value,
      port: $('#dicom-peer-port').value };
    if ($('#dicom-peer-kind').value === 'printer') Object.assign(peer, { kind: 'printer', filmSizes: SIZES().filter(b => b.checked).map(b => b.value) });
    void run(async () => {
      const body = await request('POST', '/admin/dicom-peers', peer);
      event.target.reset();
      $('#dicom-peer-film-sizes').hidden = true;
      await load();
      message(`${body?.peer?.name ?? peer.name} (${body?.peer?.aet ?? peer.aet})를 등록했습니다.`);
    }, '등록');
  });
  // Enabled only for the administrator session the Members console accepts.
  KinAuth.init().then(async session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    enabled = true;
    controls(true);
    if (location.hash === '#dicom-peers') void refresh();
  }).catch(() => {});
})();
