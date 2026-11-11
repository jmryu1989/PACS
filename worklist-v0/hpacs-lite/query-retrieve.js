/*
 * FC-070 Query/Retrieve: More › Query/Retrieve opens a non-modal panel that searches another PACS the institution's
 * administrator registered (Members › DICOM Peers) and pulls the chosen studies into this archive. The server does the
 * DICOM work (GET /api/query-retrieve/peers, POST …/search, POST …/retrieve, GET …/jobs/:id) and decides each row's end:
 * Arrived only when the study is here and the caller's own list opens it, Held when no hospital is decided for it,
 * Failed with the server's reason otherwise. The panel blocks nothing and takes no focus from reading.
 *
 * Mounted by page-boot.js: KinQueryRetrieve.mount({ button, panel, api, transport, allowed, can, refresh }).
 */
(function (root) {
  'use strict';
  const STATES = Object.freeze({ pending: 'Queued', running: 'Retrieving', arrived: 'Arrived', held: 'Held', failed: 'Failed' });
  const POLL_MS = 2000;

  function mount({ button, panel, api, transport, allowed, can, refresh = () => {} }) {
    if (!button || !panel) return null;
    const $ = selector => panel.querySelector(selector);
    const work = root.KinWorkContext;
    const jobs = new Map();          // `${peerId}|${studyUid}` → { state, progress, reason, jobId }
    let rows = [], peerOfRows = null, searchSeq = 0, busy = false;

    const permitted = () => !!allowed() && (can('radiologist') || can('technician'));
    function sync() {
      const on = permitted();
      button.hidden = !(can('radiologist') || can('technician'));
      button.disabled = !on;
      if (!on && !panel.hidden) close();
    }

    function status(text) { $('#qr-status').textContent = text || ''; }

    async function call(path, init = {}) {
      const context = work.capture('document');
      const answer = await transport.request(api + path, { ...init, context });
      if (!work.admits(context)) throw Object.assign(new Error('ended'), { ended: true });
      if (!answer.ok || answer.incomplete) {
        const said = typeof answer.body?.message === 'string' && [400, 404, 409, 502].includes(answer.status) ? answer.body.message : '';
        throw Object.assign(new Error(said || `HTTP ${answer.status}`), { status: answer.status, said });
      }
      return answer.body;
    }
    function failure(error, what) {
      if (error?.said) return error.said;
      if (error?.status === 403) return '이 계정으로는 Query/Retrieve를 쓸 수 없습니다.';
      return `${what} 결과를 확인하지 못했습니다. 잠시 후 다시 시도하세요.`;
    }

    async function loadPeers() {
      const select = $('#qr-peer');
      select.replaceChildren();
      $('#qr-search').disabled = true;
      status('');
      let body;
      try { body = await call('/query-retrieve/peers'); }
      catch (error) { if (!error.ended) status(failure(error, '상대 PACS 목록')); return; }
      const peers = Array.isArray(body?.peers) ? body.peers : [];
      for (const peer of peers) {
        const option = document.createElement('option');
        option.value = peer.id; option.textContent = peer.name;
        select.append(option);
      }
      if (!peers.length) { status(body?.message || '등록된 상대 PACS가 없습니다'); return; }
      $('#qr-search').disabled = false;
    }

    function stateText(job) {
      if (!job) return '';
      if (job.state === 'running') return `${STATES.running} ${job.progress}%`;
      return job.reason ? `${STATES[job.state]} — ${job.reason}` : STATES[job.state];
    }

    function render() {
      const body = $('#qr-rows');
      body.replaceChildren();
      for (const row of rows) {
        const tr = document.createElement('tr');
        tr.dataset.uid = row.studyUid;
        const job = jobs.get(`${peerOfRows}|${row.studyUid}`);
        const pick = document.createElement('input');
        pick.type = 'checkbox'; pick.className = 'qr-pick'; pick.value = row.studyUid;
        pick.setAttribute('aria-label', `Select ${row.patientId} ${row.studyDate}`);
        pick.disabled = !!job && job.state !== 'failed';
        const first = document.createElement('td'); first.append(pick); tr.append(first);
        for (const value of [row.patientId, row.patientName, row.studyDate, row.modality, row.description, row.accession,
          row.here || job?.state === 'arrived' ? 'Here' : '']) {
          const td = document.createElement('td'); td.textContent = value ?? ''; tr.append(td);
        }
        const state = document.createElement('td');
        state.className = 'qr-state'; state.textContent = stateText(job);
        tr.append(state);
        body.append(tr);
      }
      $('#qr-results').hidden = !rows.length;
      $('#qr-retrieve').disabled = busy || !rows.length;
    }

    async function search(event) {
      event?.preventDefault();
      if (!permitted() || busy) return;
      const peerId = $('#qr-peer').value;
      const criteria = { peerId };
      for (const [key, id] of [['patientId', '#qr-patient-id'], ['patientName', '#qr-patient-name'], ['accession', '#qr-accession'],
        ['studyDateFrom', '#qr-date-from'], ['studyDateTo', '#qr-date-to'], ['modality', '#qr-modality']]) {
        const value = $(id).value.trim();
        if (value) criteria[key] = value;
      }
      const mine = ++searchSeq;
      busy = true; $('#qr-search').disabled = true; status('Searching…');
      try {
        const body = await call('/query-retrieve/search', { method: 'POST', json: criteria });
        if (mine !== searchSeq) return;
        rows = Array.isArray(body?.rows) ? body.rows : [];
        peerOfRows = peerId;
        status(body?.truncated ? (body.message || '200건까지만 보입니다 — 조건을 좁히세요') : `${rows.length} Studies`);
      } catch (error) {
        if (mine !== searchSeq || error.ended) return;
        rows = []; status(failure(error, '검색'));
      } finally {
        if (mine === searchSeq) { busy = false; $('#qr-search').disabled = !permitted() || !$('#qr-peer').value; render(); }
      }
    }

    async function follow(key, jobId) {
      while (permitted()) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        if (!permitted()) return;
        let answer;
        try { answer = await call('/query-retrieve/jobs/' + encodeURIComponent(jobId)); }
        catch (error) {
          if (error.ended) return;
          if (error.status === 404) { jobs.set(key, { state: 'failed', progress: 100, reason: failure(error, '가져오기'), jobId }); render(); return; }
          continue;
        }
        jobs.set(key, { ...answer, jobId });
        render();
        if (answer.state === 'arrived') { try { await refresh(); } catch (_) { /* the list's own refresh reports */ } }
        if (['arrived', 'held', 'failed'].includes(answer.state)) return;
      }
    }

    async function retrieve() {
      if (!permitted() || !peerOfRows) return;
      const peerId = peerOfRows;
      const chosen = [...panel.querySelectorAll('.qr-pick:checked')].map(input => input.value);
      if (!chosen.length) { status('가져올 검사를 고르세요.'); return; }
      for (const studyUid of chosen) {
        const key = `${peerId}|${studyUid}`;
        jobs.set(key, { state: 'pending', progress: 0, reason: null, jobId: null });
        render();
        try {
          const { jobId } = await call('/query-retrieve/retrieve', { method: 'POST', json: { peerId, studyUid } });
          jobs.set(key, { state: 'pending', progress: 0, reason: null, jobId });
          render();
          void follow(key, jobId);
        } catch (error) {
          if (error.ended) return;
          jobs.set(key, { state: 'failed', progress: 100, reason: failure(error, '가져오기'), jobId: null });
          render();
        }
      }
    }

    function open() {
      if (!permitted()) return;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      void loadPeers();
    }
    function close() {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }

    button.addEventListener('click', () => { button.closest('details')?.removeAttribute('open'); open(); });
    $('#qr-close').addEventListener('click', close);
    $('#qr-form').addEventListener('submit', search);
    $('#qr-retrieve').addEventListener('click', () => void retrieve());
    sync();
    return { sync, open, close, state: key => jobs.get(key) ?? null };
  }

  root.KinQueryRetrieve = Object.freeze({ mount, STATES });
})(typeof window !== 'undefined' ? window : globalThis);
