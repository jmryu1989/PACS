/**
 * S5-U2a Clinician Home (clinician.html).
 * REQ-S5-U2a-CLINICIAN-HOME -> RISK-S5-U2a-STALE-A-B-A / HIDE-AS-PERMISSION / STATE-CONFUSION -> TEST-S5-U2a-DOM
 * (tests/clinician_home_dom_test.py).
 *
 * 그리는 칸은 S5-U1b 두 읽기 응답에 있는 것뿐이다 — GET clinician/studies의 행과 GET clinician/studies/:uid/report.
 * 역할을 보고 컨트롤을 숨기거나 권한을 짐작하지 않는다. 서버가 거절하면(403/404/409) 그 상태 코드·코드·문구를
 * 그대로 상태로 보인다. 확정 여부도 이 화면이 다시 정하지 않고 응답의 report.final을 따른다(S5-F5: 머리 판이
 * approve/addendum인 확정본에만 본문과 key image가 온다). 외부 문자열은 모두 textContent로 쓴다.
 */
(function (root) {
  'use strict';

  const API = `${location.origin}/api`;
  // 워크리스트(study-pages.js)와 같은 쪽 크기이자 서버 상한(study-page.ts)이다.
  const PAGE_LIMIT = 100;
  const TIMEOUT_MS = 60000;
  const FINAL_TYPE = { approve: 'Approved', addendum: 'Addendum' };
  const OPEN_STATUS = { W: 'Awaiting Report', T: 'In Progress', P: 'Preliminary', H: 'On Hold' };
  const OPEN_NOTE = {
    W: '아직 판독되지 않은 검사입니다.',
    T: '판독이 진행 중입니다.',
    P: '예비 판독 단계입니다.',
    H: '판독이 보류된 검사입니다.',
  };
  const FINAL_ONLY = '확정된 판독문(승인 또는 Addendum)만 본문과 키 이미지를 표시합니다.';
  const TEXT = {
    listLoading: '검사 목록을 불러오는 중입니다…',
    listEmpty: '표시할 검사가 없습니다. 목록 조회는 성공했습니다.',
    listFailed: '검사 목록을 불러오지 못했습니다.',
    pick: '목록에서 검사를 고르면 확정 판독문과 키 이미지를 먼저 표시합니다.',
    gone: '선택했던 검사가 새 목록에 없어 화면에서 내렸습니다.',
    reportLoading: '판독문을 불러오는 중입니다…',
    reportFailed: '판독문을 불러오지 못했습니다.',
    approved: '승인된 확정 판독문입니다.',
    addendum: 'Addendum이 반영된 확정 판독문입니다.',
    unknown: '판독 상태를 확인할 수 없습니다.',
    keysLoading: '키 이미지를 불러오는 중입니다…',
    keysWithheld: '확정 전에는 키 이미지를 표시하지 않습니다.',
    keysNone: '이 판독문에 지정된 키 이미지가 없습니다.',
    keysFailed: '판독문을 불러오지 못해 키 이미지도 표시하지 않았습니다.',
    emptyField: '기재된 내용이 없습니다.',
    untitled: '(제목 없음)',
  };

  const $ = selector => document.querySelector(selector);
  let owner = null;
  let listSeq = 0;
  let reportSeq = 0;
  let studies = [];
  let byUid = new Map();
  let selected = null;
  let refocus = null;
  let channel = null;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  const dash = value => typeof value === 'string' && value.trim() ? value : '—';
  const number = value => Number.isSafeInteger(value) ? String(value) : '—';

  function digits(value) {
    const text = typeof value === 'string' ? value.replace(/-/g, '') : '';
    return /^\d{8}$/.test(text) ? text : null;
  }

  function day(value) {
    const text = digits(value);
    return text ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : dash(value);
  }

  /**
   * 검사 시 나이(M3-10). 서버는 나이 칸을 보내지 않으므로 같은 행의 생년월일과 검사일로만 센다 — 오늘 기준
   * 나이를 쓰면 오래된 검사의 식별 줄에 검사 당시와 다른 나이가 선다. 어느 한쪽이라도 없거나 날짜가 아니면 모른다.
   */
  function ageAtStudy(birth, date) {
    const born = digits(birth);
    const studied = digits(date);
    if (!born || !studied) return null;
    const years = Math.floor((Number(studied) - Number(born)) / 10000);
    return years >= 0 ? years : null;
  }

  function sexAge(row) {
    const years = ageAtStudy(row.birth, row.date);
    return `${dash(row.sex)} / ${years === null ? '—' : `${years}Y`}`;
  }

  function errorText(body) {
    const message = body && body.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.filter(item => typeof item === 'string').join('\n');
    if (message && typeof message.message === 'string') return message.message;
    return '';
  }

  function failure(status, body, fallback) {
    const error = new Error(errorText(body) || fallback || '서버가 요청을 거절했습니다.');
    error.status = status;
    error.code = body && typeof body.code === 'string' ? body.code : null;
    error.kin = true;
    return error;
  }

  function describe(error) {
    const parts = [];
    if (error && error.status) parts.push(`HTTP ${error.status}`);
    if (error && error.code) parts.push(error.code);
    const message = error && error.message ? error.message : '응답을 확인하지 못했습니다.';
    return parts.length ? `${message} (${parts.join(' · ')})` : message;
  }

  async function request(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(API + path, { headers: { 'X-KIN-CSRF': '1' }, signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        KinAuth.logout();
        throw failure(401, body, '세션이 만료되었습니다. 다시 로그인하세요.');
      }
      if (!response.ok) throw failure(response.status, body);
      return body;
    } catch (error) {
      if (error && error.kin) throw error;
      throw failure(0, null, error && error.name === 'AbortError' ? '응답이 없어 요청을 멈췄습니다.' : '서버에 연결하지 못했습니다.');
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 목록 ──

  /**
   * 한 쪽을 받아들이기 전의 모양 검사(study-pages.js와 같은 조건, 임상의 응답에는 owner 칸이 없다).
   * 쪽 사이에서 total이 바뀌거나 순서가 어긋나면 서로 다른 시점의 목록을 이어 붙이게 되므로 답 전체를 버린다.
   */
  function checkPage(data, loaded, total, after) {
    const page = data && data.pagination;
    const rows = data && data.studies;
    const bad = !page || typeof page !== 'object' || !Array.isArray(rows) || rows.length > PAGE_LIMIT
      || page.limit !== PAGE_LIMIT || page.offset !== loaded.length
      || !Number.isSafeInteger(page.total) || page.total < 0 || (total !== null && page.total !== total)
      || !(page.next === null || (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096))
      || (page.next !== null && (rows.length !== PAGE_LIMIT || page.next === after))
      || loaded.length + rows.length > page.total
      || (page.next === null && loaded.length + rows.length !== page.total);
    if (bad) throw new Error('목록 페이지 형식을 확인할 수 없습니다. 새로고침하세요.');
    let previous = loaded.length ? loaded[loaded.length - 1].uid : null;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.uid !== 'string' || !row.uid || (previous !== null && row.uid <= previous)
          || !row.report || typeof row.report !== 'object' || typeof row.report.final !== 'boolean')
        throw new Error('목록의 검사 순서 또는 형식을 확인할 수 없습니다. 새로고침하세요.');
      previous = row.uid;
    }
    return page;
  }

  function listFresh(mine) {
    return mine === listSeq;
  }

  function setListState(state, text, detail) {
    const box = $('#list-state');
    box.dataset.state = state;
    box.querySelector('.state-text').textContent = text;
    box.querySelector('.state-detail').textContent = detail || '';
    $('#list-retry').hidden = state !== 'failed';
    $('#studies').closest('table').setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  /**
   * 서명된 이어받기 값(pagination.next)을 그대로 after로 넘겨 끝까지 읽은 뒤에만 목록을 바꾼다. 중간 쪽이 실패하면
   * 받은 쪽도 버린다 — 반쪽 목록을 "이것이 전부"로 보이지 않기 위해서다. 늦게 온 이전 요청의 답은 listSeq로 버린다.
   */
  async function loadList() {
    const mine = ++listSeq;
    const tbody = $('#studies');
    // 행을 비우면 행에 있던 포커스가 body로 떨어진다. 목록이 다시 서면 같은 검사 행으로 돌려준다.
    const focused = tbody.contains(document.activeElement) ? document.activeElement.closest('tr[data-uid]') : null;
    refocus = focused ? focused.dataset.uid : null;
    studies = [];
    tbody.replaceChildren();
    setListState('loading', TEXT.listLoading);
    const loaded = [];
    let total = null;
    let after = null;
    try {
      do {
        const data = await request(`/clinician/studies?limit=${PAGE_LIMIT}` + (after === null ? '' : `&after=${encodeURIComponent(after)}`));
        if (!listFresh(mine)) return;
        const page = checkPage(data, loaded, total, after);
        loaded.push(...data.studies);
        total = page.total;
        after = page.next;
        if (after !== null) setListState('loading', `${TEXT.listLoading} (${loaded.length} / ${total})`);
      } while (after !== null);
      // 목록을 읽는 사이 이 브라우저의 세션이 다른 계정으로 바뀌었으면 머리글의 사람과 목록의 주인이 다르다.
      const me = await request('/me');
      if (!listFresh(mine)) return;
      if (!me || me.kind !== 'member' || me.institution !== owner[0] || me.sub !== owner[1]) {
        leave();
        return;
      }
      applyList(loaded);
    } catch (error) {
      if (!listFresh(mine)) return;
      setListState('failed', TEXT.listFailed, describe(error));
    }
  }

  function byStudyDate(a, b) {
    const left = digits(a.date) || '';
    const right = digits(b.date) || '';
    if (left !== right) return left < right ? 1 : -1;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  }

  function applyList(rows) {
    studies = [...rows].sort(byStudyDate);
    byUid = new Map(studies.map(row => [row.uid, row]));
    const focusUid = refocus;
    refocus = null;
    $('#studies').replaceChildren(...studies.map(studyRow));
    rove(focusUid !== null && byUid.has(focusUid) ? focusUid : selected, focusUid !== null);
    if (studies.length) setListState('ready', `검사 ${studies.length}건을 표시합니다.`);
    else setListState('empty', TEXT.listEmpty);
    // 새 목록에 남아 있으면 판독문도 다시 읽어 식별 줄과 판독문이 같은 시점의 것이 되게 한다.
    if (selected !== null) {
      if (byUid.has(selected)) select(selected);
      else clearDetail(TEXT.gone);
    }
  }

  function statusName(report) {
    if (report && report.final === true) return report.action === 'addendum' ? 'Final · Addendum' : 'Final';
    return (report && OPEN_STATUS[report.rs]) || 'Unknown';
  }

  function statusBadge(report) {
    const kind = report && report.final === true ? 'final' : report && OPEN_STATUS[report.rs] ? 'open' : 'unknown';
    return node('span', `status ${kind}`, statusName(report));
  }

  function studyRow(row) {
    const tr = node('tr');
    tr.dataset.uid = row.uid;
    const current = row.uid === selected;
    if (current) tr.setAttribute('aria-current', 'true');
    const action = node('td');
    const view = node('button', 'view', current ? 'Viewing' : 'View');
    view.type = 'button';
    view.tabIndex = -1;
    view.dataset.view = '';
    action.append(view);
    const institution = node('td', null, dash(row.institutionName));
    if (row.tele === true) institution.append(' ', teleTag());
    const report = node('td');
    report.append(statusBadge(row.report));
    tr.append(action, node('td', 'name', dash(row.name)), node('td', null, dash(row.id)), node('td', null, sexAge(row)),
      node('td', null, day(row.birth)), node('td', null, day(row.date)), node('td', null, dash(row.modality)),
      node('td', null, dash(row.desc)), institution, report);
    return tr;
  }

  function teleTag() {
    const tag = node('span', 'tag', 'Tele');
    tag.title = '원격판독으로 의뢰받은 검사입니다.';
    return tag;
  }

  function rowButtons() {
    return [...document.querySelectorAll('#studies button[data-view]')];
  }

  /** 목록에는 탭 멈춤이 하나만 있다(워크리스트 행 탐색과 같다). 화살표·Home·End로 행을 옮기고 Enter·Space로 고른다. */
  function rove(uid, focus) {
    const buttons = rowButtons();
    const target = buttons.find(button => button.closest('tr').dataset.uid === uid) || buttons[0];
    for (const button of buttons) button.tabIndex = button === target ? 0 : -1;
    if (focus && target) target.focus();
  }

  function markSelected(uid) {
    for (const tr of document.querySelectorAll('#studies tr[data-uid]')) {
      const on = tr.dataset.uid === uid;
      if (on) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
      const button = tr.querySelector('button[data-view]');
      if (button) button.textContent = on ? 'Viewing' : 'View';
    }
  }

  function rowKey(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = rowButtons();
    const index = buttons.indexOf(event.target.closest('button[data-view]'));
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    rove(buttons[next].closest('tr').dataset.uid, true);
  }

  // ── 선택한 검사 ──

  function field(label, value, note) {
    const wrap = node('div', 'field');
    const term = node('dt', null, label);
    if (note) term.title = note;
    wrap.append(term, node('dd', null, value));
    return wrap;
  }

  function paintIdentity(row) {
    $('#detail').dataset.uid = row.uid;
    $('#detail-empty').hidden = true;
    const identity = $('#identity');
    identity.hidden = false;
    identity.replaceChildren(
      field('Name', dash(row.name)),
      field('Patient ID', dash(row.id)),
      field('Sex / Age at Study', sexAge(row), '나이는 검사일 기준입니다(생년월일과 검사일로 계산).'),
      field('Birth Date', day(row.birth)),
      field('Study Date', day(row.date)),
      field('Institution', `${dash(row.institutionName)}${row.tele === true ? ' · Tele' : ''}`),
      field('Accession', dash(row.acc)),
      field('Modality', dash(row.modality)),
      field('Description', dash(row.desc)),
      field('Series / Images', `${number(row.series)} / ${number(row.count)}`),
    );
    $('#report').hidden = false;
    $('#keys').hidden = false;
    $('#viewer-slot').hidden = false;
  }

  function setReport(state, text, detail) {
    const box = $('#report-state');
    box.dataset.state = state;
    box.querySelector('.state-text').textContent = text;
    box.querySelector('.state-detail').textContent = detail || '';
    $('#report-retry').hidden = state !== 'failed';
  }

  function setKeys(text, items) {
    $('#keys-state').textContent = text;
    const list = $('#key-list');
    list.replaceChildren(...(items || []));
    list.hidden = !items || !items.length;
  }

  function clearReport() {
    const report = $('#report');
    delete report.dataset.uid;
    $('#report-status').replaceChildren();
    $('#report-meta').replaceChildren();
    $('#report-meta').hidden = true;
    $('#report-body').replaceChildren();
    $('#report-body').hidden = true;
  }

  function clearDetail(note) {
    reportSeq++;
    selected = null;
    markSelected(null);
    delete $('#detail').dataset.uid;
    $('#identity').replaceChildren();
    $('#identity').hidden = true;
    clearReport();
    setKeys('', null);
    $('#report').hidden = true;
    $('#keys').hidden = true;
    $('#viewer-slot').hidden = true;
    const empty = $('#detail-empty');
    empty.textContent = note || TEXT.pick;
    empty.hidden = false;
  }

  /**
   * 판독 응답의 모양 검사. 요청한 검사가 아닌 답, final이 참/거짓이 아닌 답, 확정이라면서 판 번호·본문·key image
   * 목록이 없는 답은 그리지 않는다. 확정이 아닌 답은 상태만 쓴다 — 그 답에 다른 칸이 실려 와도 읽지 않는다.
   */
  function readReport(uid, body) {
    if (!body || typeof body !== 'object' || body.uid !== uid) throw new Error('응답의 검사가 요청한 검사와 다릅니다.');
    const report = body.report;
    if (!report || typeof report !== 'object' || typeof report.final !== 'boolean') throw new Error('판독 응답 형식을 확인할 수 없습니다.');
    if (!report.final) return { uid, final: false, rs: OPEN_STATUS[report.rs] ? report.rs : null };
    const text = ['findings', 'conclusion', 'recommendation'];
    if (!Number.isSafeInteger(report.version) || report.version < 1 || !FINAL_TYPE[report.action]
        || text.some(key => typeof report[key] !== 'string') || !Array.isArray(body.keys))
      throw new Error('판독 응답 형식을 확인할 수 없습니다.');
    return { uid, final: true, action: report.action, version: report.version,
      repDoc: typeof report.repDoc === 'string' ? report.repDoc : null,
      confirm: typeof report.confirm === 'string' ? report.confirm : null,
      findings: report.findings, conclusion: report.conclusion, recommendation: report.recommendation,
      keys: body.keys };
  }

  function bodySection(title, text) {
    const section = node('section', 'body-section');
    section.append(node('h4', null, title));
    section.append(text.trim() ? node('p', 'body-text', text) : node('p', 'muted', TEXT.emptyField));
    return section;
  }

  function keyItem(key) {
    const item = key && typeof key.item === 'object' && key.item ? key.item : {};
    const entry = node('li', 'key');
    entry.append(node('p', 'key-title', typeof item.title === 'string' && item.title.trim() ? item.title : TEXT.untitled));
    if (typeof item.description === 'string' && item.description.trim()) entry.append(node('p', 'key-description', item.description));
    const frame = Number.isSafeInteger(item.frame) ? String(item.frame) : '—';
    entry.append(node('p', 'key-ref', `Series ${dash(item.seriesUid)} · Instance ${dash(item.sopUid)} · Frame ${frame}`));
    return entry;
  }

  function paintReport(view) {
    clearReport();
    $('#report').dataset.uid = view.uid;
    const status = view.final ? { final: true, action: view.action } : { final: false, rs: view.rs };
    $('#report-status').replaceChildren(statusBadge(status));
    if (!view.final) {
      setReport('status', `${view.rs ? OPEN_NOTE[view.rs] : TEXT.unknown} ${FINAL_ONLY}`);
      setKeys(TEXT.keysWithheld, null);
      return;
    }
    setReport('final', view.action === 'addendum' ? TEXT.addendum : TEXT.approved);
    const meta = $('#report-meta');
    meta.replaceChildren(field('Version', String(view.version)), field('Type', FINAL_TYPE[view.action]),
      field('Signed By', dash(view.repDoc)), field('Signed On', day(view.confirm)));
    meta.hidden = false;
    const body = $('#report-body');
    body.replaceChildren(bodySection('Findings', view.findings), bodySection('Conclusion', view.conclusion),
      bodySection('Recommendation', view.recommendation));
    body.hidden = false;
    const keys = view.keys.map(keyItem);
    setKeys(keys.length ? `키 이미지 ${keys.length}건` : TEXT.keysNone, keys);
  }

  /** A->B->A: 화면에 쓰기 직전 요청 번호와 UID를 함께 본다. UID만 보면 A의 첫 요청 답이 A의 두 번째 요청 자리에 그려진다. */
  function reportFresh(mine, uid) {
    return mine === reportSeq && selected === uid;
  }

  function select(uid) {
    const row = byUid.get(uid);
    if (!row) return;
    selected = uid;
    const mine = ++reportSeq;
    markSelected(uid);
    paintIdentity(row);
    clearReport();
    setReport('loading', TEXT.reportLoading);
    setKeys(TEXT.keysLoading, null);
    request(`/clinician/studies/${encodeURIComponent(uid)}/report`).then(body => {
      if (!reportFresh(mine, uid)) return;
      let view;
      try {
        view = readReport(uid, body);
      } catch (error) {
        setReport('failed', TEXT.reportFailed, describe(error));
        setKeys(TEXT.keysFailed, null);
        return;
      }
      paintReport(view);
    }, error => {
      if (!reportFresh(mine, uid)) return;
      setReport('failed', TEXT.reportFailed, describe(error));
      setKeys(TEXT.keysFailed, null);
    });
  }

  // ── 세션 ──

  function close() {
    listSeq++;
    reportSeq++;
    selected = null;
    studies = [];
    byUid = new Map();
    document.body.replaceChildren();
  }

  /** 세션이 끝났거나 다른 계정이 되었다. 이 계정의 검사·판독문을 화면에서 먼저 지우고 진입 화면이 다시 정하게 한다. */
  function leave() {
    close();
    location.replace('index.html');
  }

  function listen() {
    try {
      channel = new BroadcastChannel('kin-session');
      channel.onmessage = event => { if (event.data && event.data.type === 'session-ended') leave(); };
    } catch (_) {}
    root.addEventListener('storage', event => { if (event.key === 'kin-session-ended') leave(); });
    root.addEventListener('pagehide', () => { if (channel) channel.close(); });
  }

  function showMembership(state) {
    const pending = state === 'pending';
    $('#home').hidden = true;
    $('#logout').hidden = true;
    $('#membership-title').textContent = pending ? 'Pending Approval' : 'Account Setup Required';
    $('#membership-text').textContent = pending
      ? '가입 신청이 접수되었습니다. 관리자가 기관과 역할을 확인한 뒤 사용할 수 있습니다.'
      : '기관 또는 업무 역할 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.';
    $('#membership').hidden = false;
  }

  function wire() {
    $('#logout').addEventListener('click', () => KinAuth.logout());
    $('#membership-logout').addEventListener('click', () => KinAuth.logout());
    $('#refresh').addEventListener('click', () => loadList());
    $('#list-retry').addEventListener('click', () => loadList());
    $('#report-retry').addEventListener('click', () => { if (selected !== null) select(selected); });
    const tbody = $('#studies');
    tbody.addEventListener('click', event => {
      const tr = event.target.closest('tr[data-uid]');
      if (!tr) return;
      rove(tr.dataset.uid, false);
      select(tr.dataset.uid);
    });
    tbody.addEventListener('keydown', rowKey);
  }

  async function boot() {
    wire();
    try {
      await KinAuth.init();
    } catch (_) {
      location.replace('index.html');
      return;
    }
    const session = KinAuth.session();
    if (!session) {
      location.replace('index.html');
      return;
    }
    listen();
    if (session.state === 'pending' || session.state === 'invalid') {
      showMembership(session.state);
      return;
    }
    // 데모 세션에는 서버가 없어 이 화면이 읽을 응답이 없다. 워크리스트의 데모로 보낸다.
    if (session.demo) {
      location.replace('main.html');
      return;
    }
    owner = [session.institution ?? null, session.sub ?? null];
    $('#actor').textContent = session.displayName || session.user || '';
    clearDetail();
    loadList();
  }

  root.KinClinicianHome = { boot, ageAtStudy };
})(globalThis);
