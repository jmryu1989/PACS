/**
 * S5-U2a Clinician Home (clinician.html).
 * REQ-S5-U2a-CLINICIAN-HOME -> RISK-S5-U2a-STALE-A-B-A / HIDE-AS-PERMISSION / STATE-CONFUSION -> TEST-S5-U2a-DOM
 * (tests/clinician_home_dom_test.py).
 * S5-U2b 뷰어·비교: REQ-S5-U2b-READONLY-VIEWER -> RISK-S5-U2b-WRITE-CONTROL / WRONG-PRIOR -> TEST-S5-U2b-DOM
 * (tests/clinician_viewer_dom_test.py). 영상은 고정 OHIF 창에서 열고, 그 창의 읽기 전용은 config/ohif.js가 서버 /me로 정한다.
 * S5-U3 환자 타임라인: REQ-S5-U3-PATIENT-TIMELINE -> RISK-S5-U3-NAME-MERGE / ID-ONLY-IDENTITY / TENANT -> TEST-S5-U3-DOM
 * (tests/clinician_timeline_dom_test.py). 묶음은 서버 GET clinician/studies/:uid/timeline이 정하고, 이 화면은 사용자가 열 때만 읽는다.
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
    recheck: '검사 목록을 다시 확인하는 중입니다. 확인이 끝나면 선택했던 검사의 판독문을 다시 불러옵니다.',
    unverified: '검사 목록을 다시 확인하지 못해 선택했던 검사를 내렸습니다. 목록을 다시 불러오면 그 검사의 판독문을 새로 읽습니다.',
    closing: '세션을 닫았습니다. 로그인 화면으로 이동하는 중입니다…',
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
    viewer: '영상은 새 창의 뷰어에서 읽기 전용으로 엽니다. 측정·키 이미지를 만들거나 저장하지 않으며 서버도 쓰기를 거절합니다.',
    viewerAsked: '뷰어 창에 이 검사를 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요.',
    compareAsked: '뷰어 창에 이 검사와 고른 비교 검사를 나란히 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요.',
    viewerBlocked: '브라우저가 새 창을 막아 뷰어를 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 누르세요.',
    viewerUid: '검사 UID 형식을 확인할 수 없어 뷰어를 열지 않았습니다.',
    compareGone: '비교할 검사를 지금 목록에서 같은 환자로 확인할 수 없어 열지 않았습니다. 목록을 새로고침하세요.',
    compareHint: '서버가 정한 같은 환자 키(기관과 원본 DICOM 환자 ID)의 다른 검사만 표시합니다. 이름이나 화면에서 고친 환자 ID로는 묶지 않습니다. Compare는 이 검사와 나란히 엽니다.',
    compareNone: '같은 환자 키의 다른 검사가 목록에 없어 나란히 비교할 검사가 없습니다.',
    compareNoKey: '이 검사에는 서버 환자 키가 없어 비교할 검사를 찾지 않습니다.',
  };
  const VIEWER_WINDOW = 'kin-clinician-viewer';
  const STUDY_UID = /^\d+(?:\.\d+)+$/;
  // S5-U3 타임라인 문구. 상태명·버튼·제목은 영어, 설명·툴팁은 한국어다(AGENTS §4).
  const TIMELINE = {
    hint: count => `지금 목록에 같은 환자 키(기관과 원본 DICOM 환자 ID)의 다른 검사가 ${count}건 있습니다. `
      + 'Show Timeline은 서버가 이 키로 묶은 검사 전부를 출처 기관·검사일과 함께 읽습니다. '
      + '이름이나 화면에서 고친 환자 ID로는 묶지 않고, 원본 생년월일·성별이 서로 다르면 표시합니다.',
    loading: '환자 타임라인을 불러오는 중입니다…',
    failed: '환자 타임라인을 불러오지 못했습니다.',
    malformed: '타임라인 응답 형식을 확인할 수 없습니다. 새로고침하세요.',
    ready: count => `같은 환자 키의 검사 ${count}건을 검사일 최신순으로 표시합니다.`,
    empty: '같은 환자 키의 다른 검사가 없습니다.',
    noKey: '이 검사에는 서버 환자 키가 없어 다른 검사와 묶지 않습니다.',
    conflict: fields => `같은 환자 키로 묶인 검사 사이에 원본 DICOM ${fields}이 서로 다릅니다. 같은 사람의 검사인지 확인한 뒤 비교하세요.`,
    unknown: fields => `일부 검사는 원본 DICOM ${fields}이 없거나 형식이 달라 비교하지 못했습니다.`,
    birth: '원본 DICOM 생년월일이 선택한 검사와 다릅니다.',
    sex: '원본 DICOM 성별이 선택한 검사와 다릅니다.',
    notListed: '이 검사는 지금 목록에 없어 열 수 없습니다. 목록을 새로고침하세요.',
  };
  const RELATIONS = ['match', 'mismatch', 'not_comparable'];

  const $ = selector => document.querySelector(selector);
  let owner = null;
  let listSeq = 0;
  let reportSeq = 0;
  let studies = [];
  let byUid = new Map();
  let selected = null;
  // 목록을 다시 확인하느라 내려 둔 검사. 새 목록과 계정 확인이 끝난 뒤에만 다시 읽는다(setAside/applyList).
  let resume = null;
  let refocus = null;
  let channel = null;
  let leaving = false;
  // 사용자가 Show Timeline을 누른 뒤에만 참이다. 그 뒤 고르는 검사는 타임라인을 이어서 읽는다(이 문서 안에서만).
  let timelineOpen = false;
  let timelineSeq = 0;

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
      // 401은 상태 줄에서 바로 끝낸다. 본문을 기다리는 동안에는 leaving과 요청 번호가 그대로라 그사이 도착한 다른
      // 읽기의 답(확정 판독문·key image)이 그려진다. 떠나는 문서는 이 오류를 보이지 않으므로 본문은 읽지 않는다.
      if (response.status === 401) {
        logout();
        throw failure(401, null, '세션이 만료되었습니다. 다시 로그인하세요.');
      }
      const body = await response.json().catch(() => null);
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
    return !leaving && mine === listSeq;
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
    // 세션이 끝난 문서는 새로 읽지 않는다. 이미 나간 읽기의 답은 close()가 넘긴 요청 번호로 버린다.
    if (leaving) return;
    const mine = ++listSeq;
    const tbody = $('#studies');
    // 행을 비우면 행에 있던 포커스가 body로 떨어진다. 목록이 다시 서면 같은 검사 행으로 돌려준다.
    const focused = tbody.contains(document.activeElement) ? document.activeElement.closest('tr[data-uid]') : null;
    refocus = focused ? focused.dataset.uid : null;
    setAside();
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
      if (resume !== null) clearDetail(TEXT.unverified);
    }
  }

  /**
   * 목록을 다시 확인하는 동안 선택했던 검사를 내려 둔다 — 식별 줄·판독문·key image를 지우고, clearDetail이 reportSeq를
   * 넘겨 진행 중인 판독 읽기의 답도 버린다. 이 목록이 거절되면(403/409 등) 보이던 확정본은 서버가 방금 다시 확인해 주지
   * 않은 것이라, 그대로 두면 목록 오류 옆에서 현재 확정본처럼 읽힌다. 새 목록과 계정 확인이 모두 끝난 뒤에만 applyList가
   * 같은 검사를 다시 읽는다.
   */
  function setAside() {
    if (selected !== null) resume = selected;
    clearDetail(resume === null ? TEXT.pick : TEXT.recheck);
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
    const reopen = resume;
    resume = null;
    $('#studies').replaceChildren(...studies.map(studyRow));
    rove(focusUid !== null && byUid.has(focusUid) ? focusUid : reopen, focusUid !== null);
    if (studies.length) setListState('ready', `검사 ${studies.length}건을 표시합니다.`);
    else setListState('empty', TEXT.listEmpty);
    // 내려 둔 검사가 새 목록에 남아 있으면 판독문도 다시 읽어 식별 줄과 판독문이 같은 시점의 것이 되게 한다.
    if (reopen !== null) {
      if (byUid.has(reopen)) select(reopen);
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
    $('#open-viewer').disabled = false;
    paintCompare(row);
  }

  // ── 뷰어와 비교(S5-U2b) ──

  /**
   * 같은 환자인지는 서버가 만든 sourcePatientKey(기관|원본 DICOM PatientID, pacs.service.ts)로만 본다. 이름·생년월일이나
   * 기사가 화면에서 고친 환자 ID(overlay)는 다른 환자가 같아 보이거나 같은 환자가 달라 보이는 값이라 쓰지 않는다.
   */
  function patientKey(row) {
    return row && typeof row.sourcePatientKey === 'string' && row.sourcePatientKey ? row.sourcePatientKey : null;
  }

  /**
   * 비교 후보는 지금 목록(서버가 이 계정에 허용한 검사)에서 같은 환자 키의 다른 검사다. 후보가 있을 때만 이 칸을 만들고,
   * 없으면 이유를 viewer-note 한 줄로 쓴다. 선택이 바뀌면(select·clearDetail) 그 자리에서 다시 그리거나 지운다 — 요청이 없으므로
   * 늦게 도착해 다른 검사의 후보를 그리는 답도 없다.
   */
  function paintCompare(row) {
    const old = $('#compare');
    if (old) old.remove();
    const note = $('#viewer-note');
    const key = patientKey(row);
    const peers = key === null ? [] : studies.filter(other => other.uid !== row.uid && patientKey(other) === key);
    if (!peers.length) {
      note.textContent = `${TEXT.viewer} ${key === null ? TEXT.compareNoKey : TEXT.compareNone}`;
      return;
    }
    note.textContent = TEXT.viewer;
    const section = node('section');
    section.id = 'compare';
    section.dataset.uid = row.uid;
    section.setAttribute('aria-labelledby', 'compare-title');
    section.style.marginTop = '14px';
    const head = node('div', 'panel-head');
    const title = node('h3', null, 'Comparison');
    title.id = 'compare-title';
    head.append(title);
    const list = node('ul');
    list.id = 'compare-list';
    for (const other of peers) {
      const item = node('li');
      item.dataset.uid = other.uid;
      item.style.margin = '6px 0';
      const button = node('button', null, 'Compare');
      button.type = 'button';
      button.addEventListener('click', () => openViewer(other.uid));
      item.append(node('span', null, `${day(other.date)} · ${dash(other.modality)} · ${dash(other.desc)}`), ' ',
        statusBadge(other.report), ' ', button,
        node('p', 'muted', `${dash(other.name)} · ${dash(other.id)} · ${dash(other.institutionName)}${other.tele === true ? ' · Tele' : ''}`));
      list.append(item);
    }
    section.append(head, node('p', 'muted', TEXT.compareHint), list);
    $('#viewer-slot').after(section);
  }

  /**
   * 뷰어 창은 이름 하나로 다시 쓴다. 누른 순간의 선택과 목록으로 다시 확인한다 — 버튼을 그린 뒤 목록이 바뀌었거나 다른 검사를
   * 골랐으면 다른 환자의 검사를 나란히 열 수 있다. 그 창이 읽기 전용인지는 창의 문서(config/ohif.js)가 서버 /me로 정하고, 쓰기는
   * 서버가 거절한다. 이 화면은 역할을 보고 여기서 무엇을 막지 않는다.
   */
  function openViewer(otherUid) {
    if (leaving || selected === null) return;
    const row = byUid.get(selected);
    if (!row) return;
    const note = $('#viewer-note');
    const other = otherUid === null ? null : byUid.get(otherUid);
    if (otherUid !== null && (!other || other.uid === row.uid || patientKey(row) === null || patientKey(other) !== patientKey(row))) {
      note.textContent = TEXT.compareGone;
      return;
    }
    const uids = other ? [row.uid, other.uid] : [row.uid];
    if (!uids.every(uid => typeof uid === 'string' && uid.length <= 64 && STUDY_UID.test(uid))) {
      note.textContent = TEXT.viewerUid;
      return;
    }
    // main.html openOhifWindow와 같은 주소 모양: 첫 검사가 현재 검사, 둘째가 비교 검사이고 비교 배치로 연다.
    const url = `/ohif/viewer?StudyInstanceUIDs=${uids.join(',')}${other ? '&hangingProtocolId=@ohif/hpCompare' : ''}`;
    let popup = null;
    try { popup = root.open(url, VIEWER_WINDOW); } catch (_) {}
    if (!popup) {
      note.textContent = TEXT.viewerBlocked;
      return;
    }
    // 뷰어 문서가 이 화면을 되짚지 못하게 끊는다(워크리스트의 뷰어 창과 같다).
    try { popup.opener = null; } catch (_) {}
    try { popup.focus(); } catch (_) {}
    note.textContent = other ? TEXT.compareAsked : TEXT.viewerAsked;
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
    $('#open-viewer').disabled = true;
    $('#viewer-note').textContent = TEXT.viewer;
    const compare = $('#compare');
    if (compare) compare.remove();
    clearTimeline();
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
    return !leaving && mine === reportSeq && selected === uid;
  }

  function select(uid) {
    if (leaving) return;
    const row = byUid.get(uid);
    if (!row) return;
    selected = uid;
    const mine = ++reportSeq;
    markSelected(uid);
    paintIdentity(row);
    paintTimelineShell(row);
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

  // ── 환자 타임라인(S5-U3) ──
  // 묶음은 서버가 정한다. 이 화면은 받은 행이 모두 기준 검사와 같은 서버 환자 키인지 다시 볼 뿐, 이름·생년월일로 묶거나 넓히지 않는다.
  // 생년월일·성별 표식도 서버가 원본 DICOM 값으로 낸 관계만 쓴다 — 행에 보이는 값은 기사가 고친 값일 수 있어 비교에 쓰지 않는다.
  // 읽기는 사용자가 Show Timeline을 눌렀을 때만 시작한다. 한 번에 서버가 볼 수 있는 검사 전체를 다시 열거하는 읽기라 검사를
  // 고를 때마다 자동으로 부르지 않는다.

  /** A->B->A: 요청 번호와 기준 검사를 함께 본다(판독 읽기와 같은 이유). */
  function timelineFresh(mine, uid) {
    return !leaving && mine === timelineSeq && selected === uid;
  }

  /** 선택이 바뀌거나 내려갈 때: 진행 중인 타임라인 읽기의 답을 버리고 칸을 지운다. */
  function clearTimeline() {
    timelineSeq++;
    const old = $('#timeline');
    if (old) old.remove();
  }

  function setTimelineState(state, text, detail) {
    const box = $('#timeline-state');
    if (!box) return;
    box.dataset.state = state;
    box.querySelector('.state-text').textContent = text;
    box.querySelector('.state-detail').textContent = detail || '';
    $('#timeline-retry').hidden = state !== 'failed';
  }

  /** 받은 행·표식을 모두 지운다. 다음 읽기나 닫기 전에 이전 기준 검사의 표식이 남지 않게 한다. */
  function resetTimelineBody() {
    $('#timeline-conflict').hidden = true;
    $('#timeline-conflict').querySelector('.state-detail').textContent = '';
    $('#timeline-note').hidden = true;
    $('#timeline-note').textContent = '';
    $('#timeline-list').replaceChildren();
    $('#timeline-list').hidden = true;
    setTimelineState('idle', '');
  }

  function setTimelineOpen(open) {
    const toggle = $('#timeline-toggle');
    toggle.textContent = open ? 'Hide Timeline' : 'Show Timeline';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    $('#timeline-body').hidden = !open;
  }

  /**
   * 고른 검사의 타임라인 자리. 지금 목록에 같은 서버 환자 키의 다른 검사가 있을 때만 만든다(Comparison 후보와 같은 조건) —
   * 키가 없거나 혼자인 검사에는 묶을 것이 없다. 식별 줄·판독문·키 이미지 다음, 뷰어 줄 앞에 두어 원본 생년월일·성별 표식이
   * Open Viewer·Compare보다 먼저 보이게 한다.
   */
  function paintTimelineShell(row) {
    clearTimeline();
    const key = patientKey(row);
    const peers = key === null ? 0 : studies.filter(other => other.uid !== row.uid && patientKey(other) === key).length;
    if (!peers) return;
    const section = node('section');
    section.id = 'timeline';
    section.dataset.uid = row.uid;
    section.setAttribute('aria-labelledby', 'timeline-title');
    section.style.marginBottom = '14px';
    const head = node('div', 'panel-head');
    const title = node('h3', null, 'Patient Timeline');
    title.id = 'timeline-title';
    const toggle = node('button');
    toggle.type = 'button';
    toggle.id = 'timeline-toggle';
    toggle.setAttribute('aria-controls', 'timeline-body');
    toggle.addEventListener('click', () => toggleTimeline());
    head.append(title, toggle);
    const body = node('div');
    body.id = 'timeline-body';
    const state = node('div', 'state');
    state.id = 'timeline-state';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    const retry = node('button', null, 'Retry');
    retry.type = 'button';
    retry.id = 'timeline-retry';
    retry.addEventListener('click', () => { if (selected !== null) loadTimeline(selected); });
    state.append(node('p', 'state-text'), node('p', 'state-detail'), retry);
    // 원본 생년월일·성별이 다르다는 표식. 색만이 아니라 상태명과 문장으로 알린다(UXR-G-12).
    const conflict = node('div', 'state');
    conflict.id = 'timeline-conflict';
    conflict.dataset.state = 'conflict';
    conflict.setAttribute('role', 'alert');
    conflict.style.borderColor = 'var(--danger-line)';
    conflict.style.background = 'var(--danger-bg)';
    conflict.style.color = 'var(--danger-text)';
    conflict.append(node('p', 'state-text', 'Identity Conflict'), node('p', 'state-detail'));
    conflict.querySelector('.state-text').style.fontWeight = '700';
    const note = node('p', 'muted');
    note.id = 'timeline-note';
    const list = node('ol');
    list.id = 'timeline-list';
    list.style.margin = '0';
    list.style.paddingLeft = '20px';
    list.style.maxHeight = '360px';
    list.style.overflow = 'auto';
    body.append(state, conflict, note, list);
    section.append(head, node('p', 'muted', TIMELINE.hint(peers)), body);
    $('#viewer-slot').before(section);
    resetTimelineBody();
    setTimelineOpen(timelineOpen);
    if (timelineOpen) loadTimeline(row.uid);
  }

  function toggleTimeline() {
    if (leaving || selected === null || !$('#timeline')) return;
    timelineOpen = !timelineOpen;
    setTimelineOpen(timelineOpen);
    if (timelineOpen) {
      loadTimeline(selected);
      return;
    }
    // 닫으면 진행 중인 읽기의 답도 버린다. 다시 열면 처음부터 읽는다.
    timelineSeq++;
    resetTimelineBody();
  }

  /**
   * 한 쪽의 타임라인 칸 검사(쪽 모양 자체는 목록과 같은 checkPage가 본다). 요청한 기준 검사의 답이어야 하고, 환자 키와 전체
   * 관계는 모든 쪽에서 같아야 하며, 행마다 기준 검사와 같은 서버 환자 키와 관계 표식이 있어야 한다. 하나라도 어긋나면 받은
   * 쪽까지 모두 버린다 — 서버가 다른 환자의 행을 섞어 보내도 이 화면에서 한 사람으로 그려지지 않는다.
   */
  function readTimelinePage(uid, data, head) {
    const identity = data.identity;
    const key = data.patientKey;
    if (data.uid !== uid || !(key === null || (typeof key === 'string' && key))
        || !identity || typeof identity !== 'object' || typeof identity.conflict !== 'boolean'
        || !RELATIONS.includes(identity.birth) || !RELATIONS.includes(identity.sex)
        || identity.conflict !== (identity.birth === 'mismatch' || identity.sex === 'mismatch'))
      throw new Error(TIMELINE.malformed);
    const page = { patientKey: key, conflict: identity.conflict, birth: identity.birth, sex: identity.sex };
    if (head && ['patientKey', 'conflict', 'birth', 'sex'].some(name => head[name] !== page[name])) throw new Error(TIMELINE.malformed);
    for (const row of data.studies) {
      const mark = row.identity;
      if ((key === null ? row.uid !== uid : patientKey(row) !== key)
          || !mark || typeof mark !== 'object' || !RELATIONS.includes(mark.birth) || !RELATIONS.includes(mark.sex))
        throw new Error(TIMELINE.malformed);
    }
    return page;
  }

  /**
   * 기준 검사의 타임라인을 끝까지 읽는다. 목록과 같이 서명된 이어받기 값(pagination.next)을 그대로 after로 넘기고, 중간 쪽이
   * 실패하면 받은 쪽도 버린다. 기준 검사가 답에 없거나 키 없는 답에 다른 검사가 있으면 형식 오류다.
   */
  async function loadTimeline(uid) {
    if (leaving || selected !== uid || !$('#timeline')) return;
    const mine = ++timelineSeq;
    resetTimelineBody();
    setTimelineState('loading', TIMELINE.loading);
    const loaded = [];
    let total = null;
    let after = null;
    let head = null;
    try {
      do {
        const data = await request(`/clinician/studies/${encodeURIComponent(uid)}/timeline?limit=${PAGE_LIMIT}`
          + (after === null ? '' : `&after=${encodeURIComponent(after)}`));
        if (!timelineFresh(mine, uid)) return;
        const page = checkPage(data, loaded, total, after);
        head = readTimelinePage(uid, data, head);
        loaded.push(...data.studies);
        total = page.total;
        after = page.next;
        if (after !== null) setTimelineState('loading', `${TIMELINE.loading} (${loaded.length} / ${total})`);
      } while (after !== null);
      // 검사 하나로는 같다·다르다가 나올 수 없다. 그런 답은 다른 묶음의 관계를 실어 온 것이다.
      if (!loaded.some(row => row.uid === uid) || (head.patientKey === null && loaded.length !== 1)
          || (loaded.length < 2 && (head.birth !== 'not_comparable' || head.sex !== 'not_comparable')))
        throw new Error(TIMELINE.malformed);
      paintTimeline(uid, head, loaded);
    } catch (error) {
      if (!timelineFresh(mine, uid)) return;
      resetTimelineBody();
      setTimelineState('failed', TIMELINE.failed, describe(error));
    }
  }

  function fieldNames(birth, sex) {
    return birth && sex ? '생년월일과 성별' : birth ? '생년월일' : '성별';
  }

  function paintTimeline(uid, head, rows) {
    if (head.patientKey === null) {
      setTimelineState('nokey', TIMELINE.noKey);
      return;
    }
    if (head.conflict) {
      const box = $('#timeline-conflict');
      box.querySelector('.state-detail').textContent = TIMELINE.conflict(fieldNames(head.birth === 'mismatch', head.sex === 'mismatch'));
      box.hidden = false;
    }
    if (rows.length < 2) {
      setTimelineState('empty', TIMELINE.empty);
      return;
    }
    const birthUnknown = head.birth === 'not_comparable', sexUnknown = head.sex === 'not_comparable';
    if (birthUnknown || sexUnknown) {
      $('#timeline-note').textContent = TIMELINE.unknown(fieldNames(birthUnknown, sexUnknown));
      $('#timeline-note').hidden = false;
    }
    const list = $('#timeline-list');
    list.replaceChildren(...[...rows].sort(byStudyDate).map(row => timelineItem(row, uid)));
    list.hidden = false;
    setTimelineState(head.conflict ? 'conflict' : 'ready', TIMELINE.ready(rows.length));
  }

  function mismatchTag(label, explanation) {
    const tag = node('span', 'tag', label);
    tag.title = explanation;
    tag.style.borderColor = 'var(--danger-line)';
    tag.style.color = 'var(--danger-text)';
    tag.style.marginRight = '6px';
    return tag;
  }

  function timelineItem(row, anchor) {
    const item = node('li');
    item.dataset.uid = row.uid;
    item.style.margin = '8px 0';
    const current = row.uid === anchor;
    if (current) item.setAttribute('aria-current', 'true');
    const line = node('p');
    line.style.margin = '0';
    line.append(node('strong', null, day(row.date)), ` · ${dash(row.modality)} · ${dash(row.desc)} `, statusBadge(row.report));
    const where = node('p', 'muted', dash(row.institutionName));
    if (row.tele === true) where.append(' ', teleTag());
    const who = node('p', 'muted', `${dash(row.name)} · ${dash(row.id)} · ${day(row.birth)} · ${dash(row.sex)}`);
    for (const part of [where, who]) part.style.margin = '0';
    item.append(line, where, who);
    const tags = [];
    if (row.identity.birth === 'mismatch') tags.push(mismatchTag('Birth Date Mismatch', TIMELINE.birth));
    if (row.identity.sex === 'mismatch') tags.push(mismatchTag('Sex Mismatch', TIMELINE.sex));
    if (tags.length) {
      const marks = node('p');
      marks.style.margin = '4px 0 0';
      marks.append(...tags);
      item.append(marks);
    }
    const view = node('button', null, current ? 'Viewing' : 'View');
    view.type = 'button';
    view.dataset.timelineView = '';
    view.style.marginTop = '4px';
    if (current) view.disabled = true;
    else if (!byUid.has(row.uid)) {
      view.disabled = true;
      view.title = TIMELINE.notListed;
    } else view.addEventListener('click', () => viewFromTimeline(row.uid));
    item.append(view);
    return item;
  }

  /** 타임라인의 다른 검사를 현재 검사로 고른다. 목록의 행을 누른 것과 같고, 열려 있던 타임라인은 새 기준 검사로 다시 읽는다. */
  function viewFromTimeline(uid) {
    if (leaving || !byUid.has(uid)) return;
    rove(uid, false);
    select(uid);
    const toggle = $('#timeline-toggle');
    if (toggle) toggle.focus();
  }

  // ── 세션 ──

  /**
   * 이 계정의 화면을 끝낸다. 두 요청 번호를 넘겨 이미 나간 목록·판독 읽기의 답을 버리고, 검사·판독문·key image·사용자
   * 이름을 문서에서 지운다. 세션이 끝난 것을 안 그 자리에서 부른다 — 로그아웃 POST나 이동이 끝나기를 기다리면 그동안
   * 이전 세션의 판독문이 남고 늦게 온 답이 다시 그려진다. 이동이 늦어도 빈 화면이 되지 않게 이유 한 줄만 남긴다.
   */
  function close() {
    listSeq++;
    reportSeq++;
    selected = null;
    resume = null;
    studies = [];
    byUid = new Map();
    const note = node('p', 'closing', TEXT.closing);
    note.setAttribute('role', 'status');
    document.body.replaceChildren(note);
  }

  /**
   * 이 문서의 이동은 한 번뿐이다. 진행 중인 이동 위에서 location.replace를 다시 부르면 첫 이동이 취소된다(net::ERR_ABORTED).
   * 세션 종료 소식은 한 번에 여러 번 온다 — 다른 탭의 로그아웃은 BroadcastChannel 한 번과 storage 두 번(set·remove)이고,
   * 이 문서의 로그아웃도 auth.js clearLocal()이 새 채널 객체로 보내므로 이 문서의 채널이 받는다(제외되는 것은 보낸 객체뿐이다).
   */
  function go(url) {
    if (leaving) return;
    leaving = true;
    location.replace(url);
  }

  /**
   * Log out과 401. 화면을 먼저 지우고(close) 이동은 KinAuth.logout()이 한다 — 그 이동은 POST /auth/logout이 끝난 뒤라
   * (제한 시간 없음) 기다리는 동안 이전 세션의 판독문이 남거나 늦은 답이 그려지면 안 된다. 그 뒤에 오는 자기 종료 소식·
   * 두 번째 401은 화면만 다시 지운다.
   */
  function logout() {
    close();
    if (leaving) return;
    leaving = true;
    KinAuth.logout();
  }

  /** 세션이 끝났거나 다른 계정이 되었다. 이 계정의 검사·판독문을 화면에서 먼저 지우고 진입 화면이 다시 정하게 한다. */
  function leave() {
    close();
    go('index.html');
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
    $('#logout').addEventListener('click', () => logout());
    $('#membership-logout').addEventListener('click', () => logout());
    $('#refresh').addEventListener('click', () => loadList());
    $('#list-retry').addEventListener('click', () => loadList());
    $('#report-retry').addEventListener('click', () => { if (selected !== null) select(selected); });
    $('#open-viewer').addEventListener('click', () => openViewer(null));
    // Open Viewer와 Compare의 결과(창 차단·다시 확인 실패)를 읽어 준다.
    $('#viewer-note').setAttribute('aria-live', 'polite');
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
      go('index.html');
      return;
    }
    const session = KinAuth.session();
    if (!session) {
      go('index.html');
      return;
    }
    listen();
    if (session.state === 'pending' || session.state === 'invalid') {
      showMembership(session.state);
      return;
    }
    // 데모 세션에는 서버가 없어 이 화면이 읽을 응답이 없다. 워크리스트의 데모로 보낸다.
    if (session.demo) {
      go('main.html');
      return;
    }
    owner = [session.institution ?? null, session.sub ?? null];
    $('#actor').textContent = session.displayName || session.user || '';
    clearDetail();
    loadList();
  }

  root.KinClinicianHome = { boot, ageAtStudy };
})(globalThis);
