'use strict';
// The studio page: left = the product screens (same-origin iframe), right = the Korean chat.
// All text from the server is rendered with textContent; chat and file content are never treated as markup.
(() => {
  const $ = id => document.getElementById(id);
  const mirror = $('mirror');
  const messages = $('messages');
  const input = $('input');
  const state = { mode: 'edit', me: null, live: new Map(), errors: [], missing: [], pendingReload: null, jobsWaiting: new Set() };
  const VIEWER_STUDY = '2.25.202610270003';
  const PLACEHOLDER = {
    edit: '예) 판독문 입력칸을 더 크게 해 주세요 / Approve 버튼을 오른쪽 끝으로 옮겨 주세요',
    ask: '예) Related Report는 어떻게 동작해요? / 제 피드백 3번은 어디까지 됐어요?',
  };

  async function api(path, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (options.json !== undefined) { init.method = init.method || 'POST'; init.body = JSON.stringify(options.json); init.headers['Content-Type'] = 'application/json'; }
    if (init.method && init.method !== 'GET') init.headers['X-Studio'] = '1';
    const res = await fetch('/studio-api/' + path, init);
    if (res.status === 401) { location.replace('/studio/login.html'); throw new Error('login'); }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || res.statusText);
    return body;
  }

  // ── tiny safe formatter: newlines kept by CSS, **bold** and `code` only ──
  function richText(text) {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m;
    const s = String(text || '');
    while ((m = re.exec(s))) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      const token = m[0];
      const el = document.createElement(token.startsWith('**') ? 'strong' : 'code');
      el.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1);
      frag.append(el);
      last = m.index + token.length;
    }
    if (last < s.length) frag.append(s.slice(last));
    return frag;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollDown() { messages.scrollTop = messages.scrollHeight; }

  function renderEntry(entry) {
    if (entry.jobId && state.live.has(entry.jobId) && entry.role !== 'user') {
      state.live.get(entry.jobId).remove();
      state.live.delete(entry.jobId);
    }
    const li = el('li', `msg ${entry.role}${entry.meta && entry.meta.failed ? ' failed' : ''}`);
    const who = el('div', 'who', entry.role === 'user' ? (entry.displayName || entry.user) : entry.role === 'assistant' ? '스튜디오' : '안내');
    who.append(el('span', 'mode', entry.mode === 'ask' ? '물어보기' : '바꾸기'));
    who.append(' ' + new Date(entry.t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
    const text = el('div', 'text');
    text.append(richText(entry.text));
    li.append(who, text);
    const meta = entry.meta || {};
    if (entry.role === 'assistant' && meta.changed && meta.sha) {
      const row = el('div', 'meta');
      row.append(el('span', 'applied', '반영됨'));
      if (meta.files) row.append(el('span', '', meta.files.filter(f => !/bundle\.js$|config\/ohif\.js$/.test(f)).map(f => f.split('/').pop()).join(', ')));
      const timing = state.timings && state.timings[entry.jobId];
      if (timing) row.append(el('span', '', timing));
      const view = el('button', '', '변경 보기'); view.type = 'button'; view.onclick = () => showChange(meta.sha);
      const undo = el('button', '', '되돌리기'); undo.type = 'button'; undo.onclick = () => doUndo(meta.sha);
      row.append(view, undo);
      li.append(row);
    }
    if (meta.blocked && meta.blocked.length) li.append(el('div', 'meta', `허용 밖이라 되돌린 파일: ${meta.blocked.join(', ')}`));
    if (meta.errors && meta.errors.length) li.append(el('div', 'meta', `검사 오류: ${meta.errors[0]}`));
    messages.append(li);
    scrollDown();
  }

  function liveBubble(jobId, mode) {
    let li = state.live.get(jobId);
    if (!li) {
      li = el('li', 'msg assistant live');
      const who = el('div', 'who', '스튜디오'); who.append(el('span', 'mode', mode === 'ask' ? '물어보기' : '바꾸기'));
      li.append(who, el('div', 'text', '…'), el('div', 'meta tools'));
      messages.append(li);
      state.live.set(jobId, li);
    }
    return li;
  }

  // ── job progress line ──
  const jobLine = $('job-line');
  let tick = null;
  function showJob(ev) {
    const label = { queued: '차례를 기다리는 중', running: ev.mode === 'ask' ? '찾아보는 중' : '고치는 중', building: '빌드·검사 중', repairing: '오류를 고치는 중',
      applied: '반영됨', done: '끝', failed: '실패' }[ev.state] || ev.state;
    if (['applied', 'done', 'failed'].includes(ev.state)) {
      state.jobsWaiting.delete(ev.id);
      if (!state.jobsWaiting.size) { jobLine.hidden = true; clearInterval(tick); tick = null; }
      return;
    }
    state.jobsWaiting.add(ev.id);
    jobLine.hidden = false;
    jobLine.dataset.label = label;
    jobLine.dataset.started = jobLine.dataset.started && state.jobsWaiting.size > 1 ? jobLine.dataset.started : String(Date.now());
    const paint = () => {
      const secs = Math.round((Date.now() - Number(jobLine.dataset.started)) / 1000);
      jobLine.textContent = `${jobLine.dataset.label}… ${secs}초`;
    };
    paint();
    if (!tick) tick = setInterval(paint, 1000);
  }

  // ── events from the server ──
  function connect() {
    const source = new EventSource('/studio-api/events');
    source.onmessage = event => {
      let ev; try { ev = JSON.parse(event.data); } catch { return; }
      if (ev.type === 'chat') renderEntry(ev.entry);
      else if (ev.type === 'job') {
        showJob(ev);
        if (ev.state === 'delta') {
          const li = liveBubble(ev.id, ev.mode);
          li.querySelector('.text').textContent = ev.text || '…';
          scrollDown();
        } else if (ev.state === 'tool') {
          const li = liveBubble(ev.id, ev.mode);
          li.querySelector('.tools').textContent = ev.summary;
        } else if (ev.state === 'applied' && ev.timings) {
          state.timings = state.timings || {};
          state.timings[ev.id] = `요청→적용 ${(ev.timings.totalToReloadSentMs / 1000).toFixed(1)}초`;
        }
      } else if (ev.type === 'reload') {
        requestReload(ev);
        refreshState().catch(() => {});
      } else if (ev.type === 'missing') {
        if (!state.missing.some(m => m.method === ev.method && m.path === ev.path)) state.missing.push(ev);
        $('missing').hidden = false; $('missing').querySelector('b').textContent = state.missing.length;
      } else if (ev.type === 'digest') {
        refreshState();
      }
    };
    source.onerror = () => { /* EventSource reconnects by itself */ };
  }

  // ── mirror ──
  function selectedStudy() {
    try {
      const doc = mirror.contentDocument;
      const tr = doc && doc.querySelector('#rows tr.sel');
      if (!tr) return null;
      const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim()).filter(Boolean).slice(0, 6).join(' · ');
      return { uid: tr.dataset.uid, label: cells };
    } catch { return null; }
  }

  function typing() {
    try {
      const active = mirror.contentDocument && mirror.contentDocument.activeElement;
      return !!active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /text|search/.test(active.type)) || active.isContentEditable);
    } catch { return false; }
  }

  function watchMirror() {
    try {
      const win = mirror.contentWindow;
      if (!win || win.__studioWatched) return;
      win.__studioWatched = true;
      win.addEventListener('error', e => pushError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
      win.addEventListener('unhandledrejection', e => pushError(`unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
    } catch { /* about:blank or navigating */ }
  }

  function pushError(text) {
    state.errors.push(text);
    if (state.errors.length > 20) state.errors.shift();
    $('errors').hidden = false; $('errors').querySelector('b').textContent = state.errors.length;
  }

  function requestReload(ev) {
    if (typing() && ev.reason === 'edit') { state.pendingReload = ev; $('mirror-banner').hidden = false; return; }
    reloadMirror(ev);
  }

  // Reload and measure until the screen is usable again (the worklist rows are back, not just DOMContentLoaded),
  // then put the same study back in focus.
  function reloadMirror(ev = {}) {
    $('mirror-banner').hidden = true;
    state.pendingReload = null;
    const keep = selectedStudy();
    const started = performance.now();
    const onLoad = () => {
      mirror.removeEventListener('load', onLoad);
      watchMirror();
      const deadline = started + 30000;
      const poll = () => {
        let doc; try { doc = mirror.contentDocument; } catch { doc = null; }
        const isList = doc && /main\.html/.test(doc.location.pathname);
        const ready = doc && doc.readyState === 'complete' && (!isList || doc.querySelector('#rows tr[data-uid]'));
        if (ready || performance.now() > deadline) {
          const reloadMs = Math.round(performance.now() - started);
          if (ev.jobId) api('metrics/reload', { json: { jobId: ev.jobId, reloadMs, readyKind: ready ? (isList ? 'rows' : 'load') : 'timeout' } }).catch(() => {});
          if (ev.jobId && state.timings && state.timings[ev.jobId]) state.timings[ev.jobId] += ` · 화면 새로고침 ${(reloadMs / 1000).toFixed(1)}초`;
          if (keep && isList) {
            const row = doc.querySelector(`#rows tr[data-uid="${CSS.escape(keep.uid)}"]`);
            if (row) row.click();
          }
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    };
    mirror.addEventListener('load', onLoad);
    try { mirror.contentWindow.location.reload(); } catch { mirror.src = mirror.src; }
  }

  function openScreen(value) {
    state.errors = []; $('errors').hidden = true;
    mirror.src = value === 'viewer' ? `/ohif/viewer?StudyInstanceUIDs=${VIEWER_STUDY}` : value;
    localStorage.setItem('studio-screen', value);
  }
  mirror.addEventListener('load', watchMirror);

  // ── chat ──
  function setMode(mode) {
    state.mode = mode;
    for (const b of document.querySelectorAll('.tabs button')) { b.classList.toggle('on', b.dataset.mode === mode); b.setAttribute('aria-selected', String(b.dataset.mode === mode)); }
    input.placeholder = PLACEHOLDER[mode];
  }
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setMode(b.dataset.mode);

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    let page = '';
    try { page = mirror.contentWindow.location.pathname + mirror.contentWindow.location.search; } catch { /* navigating */ }
    const study = selectedStudy();
    const context = { page, study: study ? `${study.uid} (${study.label})` : null, errors: state.errors.slice(-5),
      missing: state.missing.slice(-8).map(m => `${m.method} ${m.path}`) };
    input.value = '';
    try { await api('chat', { json: { mode: state.mode, text, context } }); }
    catch (error) { input.value = text; alert('보내지 못했습니다: ' + error.message); }
  }
  $('composer').addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });

  // ── actions ──
  async function doUndo(sha) {
    try { await api('undo', { json: sha ? { sha } : {} }); refreshState(); }
    catch (error) { alert(error.message); }
  }
  $('undo').onclick = () => doUndo();
  $('apply-now').onclick = () => reloadMirror(state.pendingReload || {});
  $('reload').onclick = () => reloadMirror();
  $('screen').onchange = e => openScreen(e.target.value);
  $('role').onchange = async e => {
    try { await api('role', { json: { role: e.target.value } }); openScreen($('screen').value === 'viewer' ? 'viewer' : (e.target.value === 'clinician' ? '/worklist/hpacs-lite/clinician.html' : $('screen').value)); }
    catch (error) { alert(error.message); }
  };
  $('logout').onclick = async () => { await api('logout', { method: 'POST' }).catch(() => {}); location.replace('/studio/login.html'); };

  const panel = $('panel');
  function openPanel(title, build) {
    $('panel-title').textContent = title;
    const body = $('panel-body');
    body.replaceChildren();
    build(body);
    if (!panel.open) panel.showModal();
  }
  $('panel-close').onclick = () => panel.close();

  async function showChange(sha) {
    const patch = await api('changes/' + sha);
    openPanel('변경 내용', body => body.append(el('pre', '', patch)));
  }

  $('changes').onclick = async () => {
    const log = await api('changes');
    openPanel('적용한 변경 (최근 순)', body => {
      if (!log.length) { body.append(el('p', 'muted', '아직 적용한 변경이 없습니다.')); return; }
      const table = el('table');
      const head = el('tr'); for (const h of ['시각', '누가', '요청', '파일', '']) head.append(el('th', '', h));
      table.append(head);
      for (const c of log) {
        const tr = el('tr');
        tr.append(el('td', '', new Date(c.time).toLocaleString('ko-KR')), el('td', '', c.trailers['Studio-User'] || ''),
          el('td', '', (c.trailers['Studio-Kind'] === 'revert' ? '↩ ' : '') + c.subject + (c.reverted ? ' (되돌림)' : '')),
          el('td', '', c.files.filter(f => !/bundle\.js$|config\/ohif\.js$/.test(f)).map(f => f.split('/').pop()).join(', ')));
        const td = el('td');
        const view = el('button', '', '보기'); view.type = 'button'; view.onclick = () => showChange(c.sha); td.append(view);
        if (c.trailers['Studio-Kind'] === 'change' && !c.reverted) { const u = el('button', '', '되돌리기'); u.type = 'button'; u.onclick = () => { panel.close(); doUndo(c.sha); }; td.append(' ', u); }
        tr.append(td); table.append(tr);
      }
      body.append(table);
    });
  };

  function renderValue(value, depth = 0) {
    if (value === null || value === undefined) return el('span', 'muted', '—');
    if (typeof value !== 'object') {
      const s = String(value);
      const span = el('span', '', s);
      return span;
    }
    if (Array.isArray(value)) {
      if (!value.length) return el('span', 'muted', '없음');
      const ul = el('ul');
      for (const item of value) { const li = el('li'); li.append(renderValue(item, depth + 1)); ul.append(li); }
      return ul;
    }
    const box = el('div');
    for (const [k, v] of Object.entries(value)) {
      const line = el('div');
      const key = el('b', '', k + ': ');
      if (/eta|estimate|forecast/i.test(k)) key.append(el('span', 'tag est', '추정'));
      line.append(key, renderValue(v, depth + 1));
      box.append(line);
    }
    return box;
  }

  $('status').onclick = async () => {
    const view = await api('status');
    openPanel('개발 현황 (status.json)', body => {
      if (!view.present) { body.append(el('p', 'muted', view.message)); return; }
      body.append(el('p', view.overdue ? 'error' : 'muted', `발행 ${view.publishedAt} · ${view.ageHours}시간 전${view.overdue ? ' · 다음 예정 발행이 지났습니다(갱신 지연)' : ''}`));
      const s = view.status;
      for (const [key, value] of Object.entries(s)) {
        if (['published_at', 'next_publication'].includes(key)) continue;
        body.append(el('h3', '', key));
        body.append(renderValue(value));
      }
    });
  };

  $('done').onclick = async () => {
    if (!confirm('오늘 요청과 변경을 정리해 지휘자에게 넘길까요? (계속 쓸 수 있습니다)')) return;
    try { const d = await api('digest', { method: 'POST' }); showDigest(d.day); } catch (error) { alert(error.message); }
  };
  async function showDigest(day) {
    const md = await api('digests/' + day);
    openPanel(`하루 인계 ${day}`, body => body.append(el('pre', '', md)));
  }
  $('digests').onclick = async () => {
    const days = await api('digests');
    openPanel('지난 인계', body => {
      if (!days.length) { body.append(el('p', 'muted', '아직 없습니다.')); return; }
      for (const day of days) { const b = el('button', '', day); b.type = 'button'; b.onclick = () => showDigest(day); body.append(b, ' '); }
    });
  };
  $('records').onclick = async () => {
    const list = await api('records');
    openPanel('이견·넘긴 질문', body => {
      if (!list.length) { body.append(el('p', 'muted', '아직 없습니다.')); return; }
      for (const r of list.slice().reverse()) {
        const box = el('div'); box.style.borderBottom = '1px solid var(--line)'; box.style.padding = '6px 0';
        box.append(el('div', 'muted', `${new Date(r.t).toLocaleString('ko-KR')} · ${r.user} · ${r.kind === 'disagreement' ? '이견' : r.kind === 'question' ? '넘긴 질문' : r.kind}`));
        box.append(renderValue(Object.fromEntries(Object.entries(r).filter(([k]) => !['t', 'user', 'kind', 'jobId', 'mode'].includes(k)))));
        body.append(box);
      }
    });
  };
  $('metrics').onclick = async () => {
    const list = await api('metrics');
    const reloads = new Map(list.filter(m => m.kind === 'reload-ready').map(m => [m.jobId, m]));
    openPanel('반영 시간 기록', body => {
      const table = el('table');
      const head = el('tr'); for (const h of ['시각', '요청', 'Claude', '빌드', '마지막 수정→신호', '화면 새로고침', '마지막 수정→화면 준비', '요청→신호']) head.append(el('th', '', h));
      table.append(head);
      const s = ms => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) + '초' : '—');
      for (const m of list.filter(x => x.kind !== 'reload-ready' && x.changed).reverse()) {
        const t = m.timings || {}; const r = reloads.get(m.jobId);
        const tr = el('tr');
        tr.append(el('td', '', new Date(m.t).toLocaleTimeString('ko-KR')), el('td', '', m.text), el('td', '', s(t.claudeMs)), el('td', '', s(t.buildMs)),
          el('td', '', s(t.lastEditToReloadSentMs)), el('td', '', s(r && r.reloadMs)), el('td', '', s(r && Number.isFinite(t.lastEditToReloadSentMs) ? t.lastEditToReloadSentMs + r.reloadMs : NaN)),
          el('td', '', s(t.totalToReloadSentMs)));
        table.append(tr);
      }
      body.append(table);
    });
  };
  $('claude').onclick = async () => {
    const s = await api('claude');
    openPanel('Claude 상태', body => body.append(renderValue(s)));
  };
  $('reset-mock').onclick = async () => {
    if (!confirm('합성 자료(초안·판독 상태)를 처음 상태로 되돌릴까요? 화면 코드 변경은 그대로입니다.')) return;
    await api('mock/reset', { method: 'POST' });
  };
  $('missing').onclick = () => openPanel('스튜디오에 가짜 응답이 없는 요청', body => {
    body.append(el('p', 'muted', '이 요청들은 501(스튜디오 미지원)로 답했습니다. 필요하면 바꾸기에서 "이 화면에 가짜 자료를 넣어 주세요"라고 말하면 됩니다.'));
    body.append(renderValue(state.missing.map(m => `${m.method} ${m.path}`)));
  });
  $('errors').onclick = () => openPanel('왼쪽 화면의 JavaScript 오류', body => body.append(renderValue(state.errors)));

  // ── splitter ──
  const splitter = $('splitter');
  const saved = Number(localStorage.getItem('studio-chat-width'));
  if (saved > 280) document.documentElement.style.setProperty('--chat-width', saved + 'px');
  splitter.addEventListener('pointerdown', e => {
    splitter.setPointerCapture(e.pointerId);
    mirror.style.pointerEvents = 'none';
    const move = ev => {
      const width = Math.max(300, Math.min(window.innerWidth * 0.7, window.innerWidth - ev.clientX));
      document.documentElement.style.setProperty('--chat-width', width + 'px');
      localStorage.setItem('studio-chat-width', String(Math.round(width)));
    };
    const up = () => { splitter.removeEventListener('pointermove', move); mirror.style.pointerEvents = ''; };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });

  async function refreshState() {
    const s = await api('state');
    state.me = s;
    $('who').textContent = s.displayName;
    $('role').value = s.role;
    $('undo').disabled = !s.sandbox.undoable;
    $('claude-state').textContent = s.claude.model ? `Claude ${s.claude.model}` : '';
    return s;
  }

  (async () => {
    setMode('edit');
    const s = await refreshState();
    const screen = localStorage.getItem('studio-screen') || '/worklist/hpacs-lite/main.html';
    $('screen').value = screen;
    openScreen(s.role === 'clinician' && screen.includes('main.html') ? '/worklist/hpacs-lite/clinician.html' : screen);
    const history = await api('history');
    for (const entry of history) renderEntry(entry);
    connect();
    setInterval(() => refreshState().catch(() => {}), 30000);
    if (!history.length) {
      renderEntry({ role: 'system', mode: 'edit', t: new Date().toISOString(), text: '왼쪽은 실제 PACS 화면을 합성 자료로 띄운 것입니다. 바꾸기 탭에서 "이 버튼을 오른쪽으로" 처럼 말하면 몇 초~1분 안에 왼쪽 화면이 바뀝니다. 마음에 안 들면 되돌리기를 누르세요. 물어보기 탭에서는 제품과 개발 현황을 물을 수 있습니다.' });
    }
  })().catch(error => { if (error.message !== 'login') alert('스튜디오를 열지 못했습니다: ' + error.message); });
})();
