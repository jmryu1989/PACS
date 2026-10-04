/*
 * S7-U1b 중요 결과(CVR) 발신 화면 — 계약 S7-U1p §16.1(이름·문구), §6.1 route #1·#2·#3·#4·#7·#8, §8·§8.1(쓰기 답의 판별).
 * REQ-S7-U1b-SENDER-UI / REQ-S7-U1b-FAILURE / REQ-S7-U1b-ABA → RISK-S7-U1b-SUCCESS-WITHOUT-RECORD / -STALE-A-B-A /
 * -HIDE-AS-PERMISSION / RISK-S7-U1p-FALSE-UNDELIVERED → TEST-S7-U1b-DOM (tests/critical_result_sender_dom_test.py).
 *
 * 판독 화면의 Mark CVR 단추, 발신 창(Send Critical Result), 보낸 목록(Sent Critical Results)을 서버 S7-U1a route에만 잇는다.
 * - 단추는 서버 #1이 sendable:true라고 답한 판독 대상에서만 켠다. 끄는 것은 안내일 뿐 권한 확인이 아니다 — 보내기는 서버가
 *   다시 확인하고, 서버의 거절은 그 이유 그대로 보인다(RISK-S7-U1b-HIDE-AS-PERMISSION).
 * - 201 전에는 어디에도 성공 문구가 없다. HTTP 실패를 "보내지 않음"으로 읽지 않는다: 커밋 뒤에도 날 수 있는 답(409
 *   STUDY_ACCESS_CHANGED, code 없는 503)과 답 없음은 결과를 모르는 답이고, 그때는 requestId와 body를 바꾸지 않고 보관해
 *   Check Again으로 같은 요청을 다시 보내거나 기록을 다시 읽어서만 끝낸다(§8.1 규칙 2~4).
 * - 모든 답은 화면에 쓰기 직전 요청 번호·판독 대상·계정·응답의 owner·requestId를 대조하고, 어긋나면 버린다(A→B→A, 로그아웃).
 * The page transport supplies status and session authority; only an acknowledged 201 applies a write.
 * 결과를 모르는 요청과 쓰던 글은 이 문서의 메모리에만 두고 저장소에 쓰지 않는다 — 로그아웃·계정 전환에서 버린다.
 */
(function () {
  'use strict';

  // 요청 하나의 제한 시간. 넘으면 멈추고, 쓰기라면 결과를 모르는 답이다.
  const TIMEOUT_MS = 60000;
  // 보낸 목록을 화면이 보이는 동안 다시 읽는 주기(계약 §16.3, OQ-5 권장값). 읽기일 뿐 어떤 기록도 바꾸지 않는다.
  const PERIOD_MS = 60000;
  const TEXT_MAX = 2000;
  // 서버 critical-result-policy.ts와 같은 형식: UUID(변형 8~b), 검사 UID, cursor, 줄바꿈·탭 말고 제어문자 없음.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const STUDY = /^\d+(?:\.\d+)+$/;
  const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
  const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
  const ACTIONS = { save: 'Save', approve: 'Approve', addendum: 'Addendum', preliminary: 'Preliminary', defer: 'Defer' };
  const ROLES = { clinician: 'Clinician', radiologist: 'Radiologist' };
  const STATES = { created: 'Pending ACK', acknowledged: 'Acknowledged', cancelled: 'Cancelled', superseded: 'Superseded' };
  const FILTER_STATE = { pending: 'created', acknowledged: 'acknowledged', cancelled: 'cancelled', superseded: 'superseded', all: null };
  const DELIVERIES = ['readable', 'stub', 'not_eligible', 'unknown'];
  // 확정 거절로 읽는 409(§8.1 표). STUDY_ACCESS_CHANGED와 모르는 code는 커밋 뒤에도 날 수 있어 여기 없다.
  const REFUSED_409 = new Set(['OWNER_CHANGED', 'REQUEST_ID_REUSED', 'CRITICAL_RESULT_CHANGED', 'CRITICAL_RESULT_ACKNOWLEDGED',
    'CRITICAL_RESULT_CANCELLED', 'CRITICAL_RESULT_SUPERSEDED', 'CRITICAL_RESULT_PENDING_EXISTS', 'CRITICAL_RESULT_SOURCE_MOVED',
    'CRITICAL_RESULT_SOURCE_INVALID', 'CRITICAL_RESULT_SOURCE_CHANGED', 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ']);
  // §4 순서 12~15의 409. 결과를 모르는 요청의 재전송이 받으면 "지금 다시 보내면 거절되는 이유"일 뿐이다 — 잠금 앞에서 늦어진
  // 원래 요청은 그 뒤에 적용될 수 있어 미적용의 증거가 아니다(§8.1 규칙 4, SV14).
  const LATER_409 = new Set(['CRITICAL_RESULT_ACKNOWLEDGED', 'CRITICAL_RESULT_CANCELLED', 'CRITICAL_RESULT_SUPERSEDED',
    'CRITICAL_RESULT_PENDING_EXISTS', 'CRITICAL_RESULT_CHANGED', 'CRITICAL_RESULT_SOURCE_MOVED', 'CRITICAL_RESULT_SOURCE_INVALID',
    'CRITICAL_RESULT_SOURCE_CHANGED', 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ']);

  const TEXT = {
    entry: {
      offline: '서버에 연결된 판독 세션에서만 중요 결과(CVR)를 보낼 수 있는지 확인합니다.',
      role: '중요 결과(CVR)는 판독의(radiologist) 계정에서 보냅니다. 이 계정에서는 보낼 수 있는지 서버에 묻지 않습니다.',
      none: '판독 대상 검사를 고르면 중요 결과(CVR)를 보낼 수 있는지 서버에 확인합니다.',
      loading: '중요 결과(CVR)를 보낼 수 있는지 서버에 확인하는 중입니다…',
      unknown: '지금 확인할 수 없습니다',
      ready: version => `이 검사의 판독 판 v${version}으로 중요 결과(CVR)를 보냅니다. 받는 사람이 KIN 화면에서 직접 확인(Acknowledge)해야 완료됩니다.`,
      ended: '세션이 끝났습니다.',
    },
    // 계약 §16.1 비활성 이유(#1 reason).
    reasons: {
      NO_PINNABLE_SOURCE: '보낼 수 있는 판독 판이 없습니다(판독 전이거나 판독 취소됨)',
      SOURCE_FORBIDDEN: '예비 판독 중이라 지정된 판독의만 보낼 수 있습니다',
      NO_ELIGIBLE_RECIPIENT: '이 판독 판을 지금 읽을 수 있는 수신자가 없습니다(임상의는 승인·추가기재된 판독만 받을 수 있습니다)',
    },
    dialog: {
      loading: '받는 사람 후보와 보낼 판을 서버에서 확인하는 중입니다…',
      unavailable: '이 창에서는 보내지 않습니다.',
      failed: '보낼 수 있는지 확인하지 못했습니다. 창을 닫고 Mark CVR을 다시 누르세요.',
      ready: 'Recipient를 고르고 메시지를 입력한 뒤 Send를 누르세요. 메시지는 판독문과 따로 저장되며 판독문을 바꾸지 않습니다.',
      invalid: 'Recipient를 고르고 1~2,000자의 메시지를 입력하세요. 줄바꿈·탭 말고 보이지 않는 제어 문자는 보낼 수 없습니다.',
      sending: '보내는 중입니다… 서버가 저장했다고 답하기 전에는 전달되었다고 표시하지 않습니다.',
      locked: '로그인한 계정이 바뀌었습니다. 이 화면에서는 중요 결과를 더 읽거나 보내지 않습니다. 화면을 다시 불러오세요.',
    },
    // 첫 Send가 확정 SOURCE_MOVED로 거절된 뒤 열린 창이 지금 판과 후보를 다시 읽을 때(§8). 다시 보내는 것은 사용자의 다음 Send다.
    moved: {
      loading: '지금 판과 받는 사람 후보를 서버에서 다시 읽는 중입니다. 다 읽기 전에는 보낼 수 없습니다.',
      ready: (from, to) => `보낼 판을 다시 읽었습니다(${from === to ? `v${to}` : `v${from} → v${to}`}). 쓰던 메시지는 그대로입니다. 새 판을 확인하고 Send를 누르세요.`,
      dropped: name => `선택했던 받는 사람(${name})은 지금 판을 읽을 수 있는 후보에 없어 선택을 비웠습니다. Recipient를 다시 고르세요.`,
    },
    delivered: '전달 기록이 저장되었습니다. 수신자가 확인(Acknowledge)하면 Acknowledged로 바뀝니다.',
    replayed: '이미 저장된 요청이라 서버가 처음 저장한 결과를 돌려주었습니다.',
    cancelled: '전달을 취소했습니다. 수신자는 이 전달을 더 확인할 수 없습니다.',
    newRequest: '다시 보내면 새 요청으로 보냅니다.',
    unknown: '요청이 서버에 적용되었는지 확인하지 못했습니다. 전달되었을 수 있습니다. Check Again으로 확인하세요.',
    cancelUnknown: '취소가 서버에 적용되었는지 확인하지 못했습니다. 취소되었을 수 있습니다. Check Again으로 확인하세요.',
    checking: '같은 요청을 다시 보내 확인하는 중입니다…',
    sending: '보내는 중입니다…',
    later: reason => `지금 다시 보내면 거절되는 이유: ${reason}`,
    guidance: '보낸 목록에서 확인하거나 수신자에게 직접 확인하세요. 같은 수신자에게 다시 보내기 전에 보낸 목록을 확인하세요.',
    serverState: state => `서버의 이 기록은 지금 ${STATES[state] || state} 상태입니다.`,
    unexpected: status => `서버 답(HTTP ${status})이 이 요청의 저장 결과인지 확인할 수 없습니다.`,
    malformed: '서버 응답 형식을 확인할 수 없습니다.',
    otherEnvelope: '다른 계정의 응답을 받았습니다.',
    expired: '세션이 만료되었습니다. 다시 로그인하세요.',
    noResponse: '응답이 없어 요청을 멈췄습니다.',
    noServer: '서버에 연결하지 못했습니다.',
    rejected: '서버가 요청을 거절했습니다.',
    codes: {
      CRITICAL_RESULT_INPUT_INVALID: '서버가 요청 형식을 거절했습니다.',
      CRITICAL_RESULT_RECIPIENT_INVALID: '받는 사람이 지금 받을 수 없는 계정입니다(본인·비활성·다른 기관·역할 없음 등).',
      CRITICAL_RESULT_ROLE_REQUIRED: '이 계정에는 지금 중요 결과를 보낼 역할이 없습니다.',
      CRITICAL_RESULT_SOURCE_FORBIDDEN: '예비 판독 중이라 지정된 판독의만 보낼 수 있습니다.',
      STUDY_NOT_FOUND: '검사를 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다.',
      CRITICAL_RESULT_NOT_FOUND: '전달 기록을 찾을 수 없습니다. 접근 조건이 바뀌었을 수 있습니다.',
      OWNER_CHANGED: '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요.',
      REQUEST_ID_REUSED: '같은 요청 ID가 다른 내용에 이미 쓰였습니다.',
      CRITICAL_RESULT_CHANGED: '그사이 전달 기록이 바뀌었습니다. 보낸 목록을 다시 불러와 확인하세요.',
      CRITICAL_RESULT_ACKNOWLEDGED: '이미 수신 확인된 전달입니다.',
      CRITICAL_RESULT_CANCELLED: '이미 취소된 전달입니다.',
      CRITICAL_RESULT_SUPERSEDED: '이미 새 판으로 대체된 전달입니다.',
      CRITICAL_RESULT_PENDING_EXISTS: '같은 검사·받는 사람에게 확인 대기 중인 전달이 있습니다. Sent Critical Results에서 대체(Supersede)하거나 취소(Cancel Delivery)하세요.',
      CRITICAL_RESULT_SOURCE_MOVED: '그사이 판독 판이 바뀌었습니다. 보낼 판을 다시 확인하세요.',
      CRITICAL_RESULT_SOURCE_INVALID: '보낼 수 있는 판독 판이 없습니다(판독 전이거나 판독 취소됨).',
      CRITICAL_RESULT_SOURCE_CHANGED: '판독이 바뀌어 이 전달은 확인할 수 없습니다.',
      CRITICAL_RESULT_RECIPIENT_CANNOT_READ: '받는 사람이 이 판독 판을 지금 읽을 수 없습니다(임상의는 승인·추가기재된 판독만 받을 수 있습니다).',
      CRITICAL_RESULT_UNAVAILABLE: '서버가 계정 또는 원본 정보를 확인하지 못해 보내지 않았습니다.',
    },
    statuses: { 400: '서버가 입력을 거절했습니다.', 403: '서버가 이 요청을 거절했습니다.', 404: '서버가 대상을 찾지 못했습니다.' },
    list: {
      loading: '보낸 목록을 불러오는 중입니다…',
      failed: '보낸 목록을 불러오지 못했습니다.',
      empty: '이 조건의 보낸 전달이 없습니다.',
      ready: (n, more) => `보낸 전달 ${n}건을 최신순으로 표시합니다.${more ? ' More로 이어서 읽습니다.' : ''}`,
      unknownCount: n => `적용 여부를 확인하지 못한 요청 ${n}건`,
      cancelReason: reason => `취소 사유: ${reason}`,
    },
    // 계약 §16.1 상태명 설명과 표지 설명. not_eligible의 원인은 발신자에게 나누어 보이지 않는다.
    states: {
      created: '수신자가 아직 확인하지 않았습니다. 열어보았는지는 기록하지 않습니다.',
      acknowledged: '수신자가 KIN 화면에서 확인했습니다. 임상 조치를 했다는 기록은 아닙니다.',
      cancelled: '발신자가 취소한 전달입니다.',
      superseded: '새 판 또는 새 메시지로 대체된 전달입니다.',
    },
    marks: {
      source: ['Source Changed', '판독이 바뀌어 수신자가 확인할 수 없습니다. 새 판으로 대체하거나 취소하세요.'],
      not_eligible: ['Recipient Not Eligible', '수신자가 지금 이 전달을 볼 수 없습니다(수신자의 역할·기관·검사 접근이 바뀌었거나, 판독의 역할을 잃어 서명 전 판을 더는 읽을 수 없음). 확인할 수 없으니 취소하고 다른 사람에게 보내세요.'],
      unknown: ['Status Unknown', '지금 수신자 상태를 확인할 수 없습니다.'],
    },
    form: {
      cancelHint: '취소 사유는 이 전달 기록에 남고, 수신자가 이 기록을 읽을 수 있으면 함께 보입니다. 취소한 전달은 되돌리지 않습니다.',
      supersedeHint: name => `같은 받는 사람(${name})에게 지금 판으로 새 기록을 보내고 이 기록은 Superseded가 됩니다.`,
      loading: '지금 보낼 판을 서버에서 확인하는 중입니다…',
      failed: '지금 보낼 판을 확인하지 못했습니다.',
      notCandidate: '이 받는 사람은 지금 판을 읽을 수 있는 후보에 없습니다. 보내면 서버가 거절할 수 있습니다.',
      noText: '1~2,000자의 내용을 입력하세요. 줄바꿈·탭 말고 보이지 않는 제어 문자는 보낼 수 없습니다.',
    },
  };

  const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string';
  const textOk = value => text(value) && value.trim().length > 0 && value.length <= TEXT_MAX && !CONTROL.test(value);
  const at = value => value === null || (text(value) && !Number.isNaN(new Date(value).getTime()));

  function time(value) {
    const date = text(value) ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '—';
    const two = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  /** 요청마다 새 UUID v4. randomUUID가 없는 브라우저는 같은 형식을 getRandomValues로 만든다. */
  function newRequestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(part => part.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function describe(error) {
    const parts = [];
    if (error && error.status) parts.push(`HTTP ${error.status}`);
    if (error && error.code) parts.push(error.code);
    const message = error && error.message ? error.message : TEXT.rejected;
    return parts.length ? `${message} (${parts.join(' · ')})` : message;
  }
  const reasonOf = error => (error && own(TEXT.codes, error.code) ? TEXT.codes[error.code] : null)
    || (error && own(TEXT.statuses, String(error.status)) ? TEXT.statuses[error.status] : TEXT.rejected);

  /**
   * 첫 요청의 거절이 확정 거절인가(§8.1 표 넷째 열). 400·403·404는 JSON 본문이 있으면 모두 트랜잭션 전·안의 답이다.
   * 409는 이름이 알려진 코드만, 503은 CRITICAL_RESULT_UNAVAILABLE만이다. 그 밖(409 STUDY_ACCESS_CHANGED, code 없는 503,
   * CRITICAL_RESULT_BUSY, 5xx, JSON이 아닌 답, 모르는 code)은 커밋 뒤에도 날 수 있거나 판별할 수 없어 결과를 모르는 답이다.
   */
  function refused(error) {
    if (!error || !error.json) return false;
    if ([400, 403, 404].includes(error.status)) return true;
    if (error.status === 409) return REFUSED_409.has(error.code);
    return error.status === 503 && error.code === 'CRITICAL_RESULT_UNAVAILABLE';
  }

  /** 응답의 owner가 요청을 보낸 계정인가: 'same' | 'other'(다른 계정의 답) | 'malformed'. */
  function ownerOf(value, sent) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(text)) return 'malformed';
    return JSON.stringify(value) === sent ? 'same' : 'other';
  }

  /** #1 Candidates(§3.3). 틀린 칸이 하나라도 있으면 null — 그 답으로는 단추를 켜지 않는다. */
  function readCandidates(data, uid) {
    if (!isObject(data) || data.uid !== uid || typeof data.sendable !== 'boolean' || !Array.isArray(data.recipients)
        || data.recipients.length > 1000 || !(data.reason === null || own(TEXT.reasons, data.reason))) return null;
    const recipients = data.recipients;
    if (!recipients.every(r => isObject(r) && text(r.sub) && UUID.test(r.sub) && text(r.actor) && text(r.name) && own(ROLES, r.role)))
      return null;
    const s = data.source;
    const source = isObject(s) && Number.isSafeInteger(s.version) && s.version >= 1 && own(ACTIONS, s.action) && text(s.author)
      && at(s.at) && typeof s.final === 'boolean' ? { version: s.version, action: s.action, author: s.author, at: s.at } : null;
    if (data.sendable ? data.reason !== null || !source || !recipients.length : data.reason === null) return null;
    return { sendable: data.sendable, reason: data.reason, source,
      recipients: recipients.map(r => ({ sub: r.sub.toLowerCase(), actor: r.actor, name: r.name, role: r.role })) };
  }

  /** 보낸 목록 한 행(SenderView, §3.3). */
  function senderItem(item) {
    const s = item && item.source, study = item && item.study, recipient = item && item.recipient;
    const ok = isObject(item) && text(item.id) && UUID.test(item.id) && text(item.studyUid) && item.studyUid.length <= 64
      && STUDY.test(item.studyUid) && own(STATES, item.state) && (item.revision === 1 || item.revision === 2) && at(item.createdAt)
      && item.createdAt !== null && (item.replacedBy === null || (text(item.replacedBy) && UUID.test(item.replacedBy)))
      && (item.supersedes === null || (text(item.supersedes) && UUID.test(item.supersedes))) && item.view === 'sender'
      && isObject(recipient) && text(recipient.actor) && text(recipient.name) && own(ROLES, recipient.role)
      && isObject(study) && ['uid', 'name', 'id', 'birth', 'date'].every(key => text(study[key])) && text(item.message)
      && isObject(s) && Number.isSafeInteger(s.version) && s.version >= 1 && text(s.action) && text(s.author) && at(s.at)
      && typeof s.current === 'boolean' && [null, 'head_moved', 'reset'].includes(s.reason)
      && (item.delivery === null || DELIVERIES.includes(item.delivery)) && (item.state === 'created' || item.delivery === null)
      && at(item.acknowledgedAt) && at(item.cancelledAt) && at(item.supersededAt)
      && (item.cancelReason === null || text(item.cancelReason));
    return ok ? { ...item, id: item.id.toLowerCase(), replacedBy: item.replacedBy && item.replacedBy.toLowerCase() } : null;
  }

  function readList(data, filter) {
    if (!isObject(data) || data.view !== 'sent' || !Array.isArray(data.items) || data.items.length > 50
        || !(data.nextCursor === null || (text(data.nextCursor) && CURSOR.test(data.nextCursor)))
        || !Number.isSafeInteger(data.pending) || data.pending < 0) return null;
    const items = data.items.map(senderItem);
    if (items.some(item => !item || (FILTER_STATE[filter] !== null && item.state !== FILTER_STATE[filter]))) return null;
    return { items, nextCursor: data.nextCursor, pending: data.pending };
  }

  /**
   * 쓰기 201의 applied가 이 요청의 적용 결과인가(§3.4). 다른 요청·다른 기록·다른 검사·다른 전이의 봉투는 저장 결과로 세지
   * 않는다 — 그 답만으로는 이 요청이 적용되었는지 모른다.
   */
  function appliedMatches(attempt, data) {
    const a = data && data.applied, e = attempt.expect;
    if (!isObject(a) || typeof data.replayed !== 'boolean' || a.requestId !== attempt.requestId || a.action !== attempt.action
        || a.id !== e.id || a.studyUid !== attempt.uid || a.from !== e.from || a.to !== e.to || a.revision !== e.revision
        || !text(a.at) || !at(a.at)) return false;
    if (e.replacement === null) return a.replacement === null;
    const r = a.replacement;
    return isObject(r) && r.id === e.replacement.id && r.revision === 1 && r.sourceVersion === e.replacement.sourceVersion;
  }

  /**
   * mount(options): main.html이 한 번 부른다. 반환값의 sync()는 renderClinical()이 부르고(판독 대상이 바뀌었는지 이 파일이
 * Session termination belongs to the page transport and work-context lifecycle.
   *   apiBase    API 주소(같은 출처 /api)
   *   current()  판독 대상 검사 UID
   *   study(uid) 워크리스트 행(이름·ID·날짜 표시용)
   *   report(uid) 화면이 아는 판독 상태 {version, rs} — 바뀌면 #1을 다시 읽는다
   *   online()   서버 모드이고 연결된 로그인 세션인가
   *   radiologist() 이 세션의 역할에 radiologist가 있는가(admin만으로는 보내지 않는다, D-S7-02 a)
   *   owner()    [institution, sub]
   *   actorName(actor) 표시 이름
   */
  function mount({ apiBase, current, study, report, online, radiologist, owner, actorName, onAccountChanged }) {
    const work = window.KinWorkContext, transport = window.KinSessionTransport.page();
    // Capture at registration, not when a delayed callback runs.
    const guarded = (effect, scope = 'document') => {
      const context = work.capture(scope);
      return (...args) => {
        let result;
        work.commit(context, () => { result = effect(...args); });
        return result;
      };
    };
    const node = id => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`#${id} is missing`);
      return found;
    };
    const entry = node('b-mark-cvr'), more = node('report-more');
    const dialog = node('cvr-send'), studyLine = node('cvr-send-study'), sourceLine = node('cvr-send-source');
    const recipientField = node('cvr-send-recipient'), messageField = node('cvr-send-message'), statusBox = node('cvr-send-status');
    const closeButton = node('cvr-send-close'), checkButton = node('cvr-send-check'), sendButton = node('cvr-send-submit');
    const panel = node('cvr-sent-p'), summary = node('cvr-sent-summary'), toggle = node('cvr-sent-toggle');
    const refreshButton = node('cvr-sent-refresh'), attemptList = node('cvr-sent-attempts'), pane = node('cvr-sent-pane');
    const filterField = node('cvr-sent-filter'), rows = node('cvr-sent-rows'), listStatus = node('cvr-sent-status');
    const moreButton = node('cvr-sent-more');

    const make = (tag, className, content) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (content !== undefined) element.textContent = content;
      return element;
    };
    const button = (label, onClick) => {
      const element = make('button', null, label);
      element.type = 'button';
      element.addEventListener('click', onClick);
      return element;
    };
    const statusWord = make('p', 'cvr-word'), statusText = make('p', 'cvr-text'), statusDetail = make('p', 'cvr-detail');
    statusBox.append(statusWord, statusText, statusDetail);

    let ended = false, lock = null, timer = null;
    const inflight = new Set();
    // 진입 단추: 판독 대상(target)과 그 판독 상태(targetKey)마다 #1을 한 번 읽는다. 읽기마다 entrySeq가 오르고 답은 자기
    // 번호·대상·계정일 때만 쓴다.
    let target = null, targetKey = null, entrySeq = 0, entryView = { phase: 'idle' };
    // 발신 창: 열 때마다 dialogSeq가 오르고 #1을 새로 읽는다. dialogAttempt는 이 창이 보이는 요청의 requestId다.
    let dialogSeq = 0, dialogUid = null, dialogView = null, dialogAttempt = null, dialogNote = '', dialogReturn = null;
    // 요청별 기록(§8.1 규칙 2): requestId → 요청. 결과를 모르는 요청은 창을 닫아도 보낸 목록 위 줄(lined)로 남는다.
    const attempts = new Map();
    const lineNodes = new Map();
    // 보낸 목록(#3 view=sent). 기본 필터는 Pending ACK. 쪽을 넘기면 nextCursor를 그대로 돌려준다.
    let filter = 'pending', listSeq = 0, items = [], nextCursor = null, pending = null, listPhase = 'idle', listError = '';
    let loadedOnce = false, paneOpen = false, staleRows = false;
    // 행 동작(Cancel Delivery·Supersede) 입력 칸: recordId → 칸. 열려 있는 동안 목록 행은 다시 그리지 않는다(쓰던 글·초점 보존).
    const forms = new Map();

    const who = () => {
      const value = owner();
      return Array.isArray(value) && value.length === 2 && value.every(part => text(part) && part.length > 0) ? JSON.stringify(value) : null;
    };
    const sender = () => work.state() === 'active' && !ended && lock === null && online() && radiologist() && who() !== null;
    const live = sent => !ended && lock === null && who() === sent;
    const keyOf = uid => {
      const state = report(uid);
      return JSON.stringify([uid, state ? state.version ?? null : null, state ? state.rs ?? null : null]);
    };
    const studyLabel = (uid, fallback) => {
      const row = study(uid);
      const name = row ? row.name : fallback && fallback.name, id = row ? row.id : fallback && fallback.id;
      return name || id ? `${name || '—'} (${id || '—'})` : uid;
    };
    const sourceText = source => `Source: v${source.version} · ${ACTIONS[source.action] || source.action} · ${actorName(source.author)} · ${time(source.at)}`;
    const unsettled = attempt => ['sending', 'checking', 'unknown'].includes(attempt.state);

    /**
     * 중요 결과 route 요청(제한 시간 60초). 성공 응답은 HTTP 상태와 함께 돌려주고(쓰기는 201만 적용), 실패는 상태·code·JSON
     * 본문 여부를 싣는다. 연결 실패·제한 시간·세션 종료로 멈춘 요청은 status 0이다 — 쓰기라면 서버가 적용했는지 모르는 답이다.
     * Session termination belongs to the page transport and lifecycle gate.
     */
    async function call(method, path, body, context = work.capture('document')) {
      const controller = new AbortController(), stop = setTimeout(() => controller.abort(), TIMEOUT_MS);
      inflight.add(controller);
      try {
        const response = await transport.request(apiBase + path, { context, deadlineMs: TIMEOUT_MS, method, signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-KIN-CSRF': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = response.incomplete ? undefined : response.body;
        if (!response.ok) {
          throw Object.assign(new Error(isObject(data) && text(data.message) ? data.message : `HTTP ${response.status}`),
            { kin: true, status: response.status, code: isObject(data) && text(data.code) ? data.code : null, json: isObject(data),
              body: isObject(data) ? data : null });
        }
        return { status: response.status, data };
      } catch (error) {
        if (error && error.kin) throw error;
        throw Object.assign(new Error(error && error.name === 'AbortError' ? TEXT.noResponse : TEXT.noServer),
          { kin: true, status: 0, code: null, json: false, body: null });
      } finally {
        clearTimeout(stop);
        inflight.delete(controller);
      }
    }

    // ── 진입 단추(Mark CVR) ──

    function paintEntry() {
      let enabled = false, title;
      if (ended) title = TEXT.entry.ended;
      else if (lock !== null) title = lock.text;
      else if (!online()) title = TEXT.entry.offline;
      else if (!radiologist()) title = TEXT.entry.role;
      else if (target === null) title = TEXT.entry.none;
      else if (entryView.phase === 'failed') title = `${TEXT.entry.unknown}\n${entryView.detail}`;
      else if (entryView.phase !== 'ready') title = TEXT.entry.loading;
      else if (!entryView.data.sendable) title = TEXT.reasons[entryView.data.reason];
      else {
        enabled = true;
        title = TEXT.entry.ready(entryView.data.source.version);
      }
      entry.disabled = !enabled;
      entry.title = title;
    }

    /** #1을 읽어 단추를 정한다. 답을 받기 전·거절·오류에는 꺼 두고 그 이유를 툴팁에 쓴다. */
    function readEntry() {
      const uid = target, sent = who(), seq = ++entrySeq;
      targetKey = keyOf(uid);
      entryView = { phase: 'loading' };
      paintEntry();
      call('GET', `/studies/${encodeURIComponent(uid)}/critical-result-recipients`, undefined, work.capture('study')).then(guarded(({ data }) => {
        if (seq !== entrySeq || uid !== target || !live(sent)) return;
        const mine = ownerOf(data && data.owner, sent);
        if (mine === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        const read = mine === 'same' ? readCandidates(data, uid) : null;
        entryView = read ? { phase: 'ready', data: read } : { phase: 'failed', detail: TEXT.malformed };
        paintEntry();
      }, 'study'), guarded(error => {
        if (seq !== entrySeq || uid !== target || !live(sent)) return;
        entryView = { phase: 'failed', detail: describe(error) };
        paintEntry();
      }, 'study'));
    }

    /**
     * renderClinical()과 More를 열 때 부른다. 판독 대상이 바뀌었거나 화면이 아는 판독 상태(판 번호·RS)가 바뀐 때만 #1을
     * 다시 읽는다 — 같은 상태면 요청이 없다. 다른 검사로 옮기면 열린 발신 창을 닫는다(보내는 중이던 요청은 목록 위 줄로 남는다).
     */
    function sync() {
      if (work.state() !== 'active') return;
      if (ended) return;
      const next = sender() ? current() || null : null;
      if (next !== target) {
        target = next;
        targetKey = null;
        entrySeq++;
        entryView = { phase: 'idle' };
        // 잠긴 뒤에는 창을 닫지 않는다 — 창에 남은 계정 변경 안내를 사용자가 읽고 닫는다.
        if (dialogUid !== null && dialogUid !== target && lock === null) closeDialog();
      }
      if (target !== null && keyOf(target) !== targetKey) readEntry();
      paintEntry();
      if (sender() && !loadedOnce && listPhase !== 'loading') loadList(false);
      paintPanel();
    }

    // ── 발신 창(Send Critical Result) ──

    function resetForm() {
      const placeholder = new Option('Choose Recipient', '');
      recipientField.replaceChildren(placeholder);
      recipientField.value = '';
      messageField.value = '';
    }

    function fillRecipients(recipients) {
      const options = recipients.map(r => new Option(`${r.name} (${r.actor}) · ${ROLES[r.role]}`, r.sub));
      recipientField.replaceChildren(new Option('Choose Recipient', ''), ...options);
      recipientField.value = '';
    }

    /** 원천 이동 뒤 다시 읽은 결과의 안내. 다 읽기 전·실패·보낼 수 없음이면 그 이유다. */
    function movedText(view) {
      if (lock !== null) return { line: TEXT.dialog.locked, detail: lock.detail };
      if (view.phase === 'loading') return { line: TEXT.moved.loading, detail: '' };
      if (view.phase === 'failed') return { line: TEXT.dialog.failed, detail: view.detail };
      if (view.phase === 'unavailable') return { line: `${TEXT.reasons[view.data.reason]}. ${TEXT.dialog.unavailable}`, detail: '' };
      const { from, dropped } = view.moved;
      return { line: [TEXT.moved.ready(from, view.data.source.version), dropped ? TEXT.moved.dropped(dropped) : ''].filter(Boolean).join('\n'),
        detail: '' };
    }

    function paintDialog() {
      if (dialogUid === null) return;
      const view = dialogView, attempt = dialogAttempt ? attempts.get(dialogAttempt) : null;
      const row = study(dialogUid);
      studyLine.textContent = row ? `Study: ${row.name || '—'} (${row.id || '—'}) · ${row.date || '—'}` : `Study: ${dialogUid}`;
      // 보낸(보내는 중·결과를 모르는·적용된) 요청은 그 요청이 고정한 판을 보인다. 거절된 요청 뒤에는 다음 Send가 쓸 판(#1의 답)을
      // 보인다 — SOURCE_MOVED 뒤 다시 읽은 새 판이 여기 선다.
      const source = attempt && attempt.state !== 'rejected' ? attempt.source : view && view.data && view.data.source;
      sourceLine.textContent = source ? sourceText(source) : '';
      const phase = view ? view.phase : 'loading';
      let state = phase, word = '', line = '', detail = '';
      if (attempt) {
        state = attempt.state;
        ({ word, line, detail } = outcomeText(attempt));
        if (attempt.state === 'rejected' && view && view.moved && view.moved.requestId === attempt.requestId) {
          const again = movedText(view);
          line = `${line}\n${again.line}`;
          detail = [detail, again.detail].filter(Boolean).join('\n');
        }
      } else if (lock !== null) {
        state = 'locked';
        line = TEXT.dialog.locked;
        detail = lock.detail;
      } else if (phase === 'loading') line = TEXT.dialog.loading;
      else if (phase === 'failed') { line = TEXT.dialog.failed; detail = view.detail; }
      else if (phase === 'unavailable') line = `${TEXT.reasons[view.data.reason]}. ${TEXT.dialog.unavailable}`;
      else line = dialogNote || TEXT.dialog.ready;
      if (attempt && lock !== null && attempt.state !== 'rejected') {
        state = 'locked';
        word = '';
        line = TEXT.dialog.locked;
        detail = lock.detail;
      }
      statusBox.dataset.state = state;
      statusWord.textContent = word;
      statusWord.hidden = !word;
      statusText.textContent = line;
      statusDetail.textContent = detail;
      statusDetail.hidden = !detail;
      const editable = lock === null && view && view.phase === 'ready' && (!attempt || attempt.state === 'rejected');
      recipientField.disabled = !editable;
      messageField.readOnly = !editable;
      sendButton.disabled = !editable;
      checkButton.hidden = !attempt || lock !== null || !['unknown', 'checking'].includes(attempt.state);
      checkButton.disabled = !!attempt && attempt.state === 'checking';
    }

    function openDialog() {
      if (ended || lock !== null || target === null || entry.disabled) return;
      dialogUid = target;
      dialogAttempt = null;
      dialogNote = '';
      dialogReturn = document.activeElement;
      resetForm();
      dialog.classList.add('show');
      closeButton.focus();
      // 창을 열 때마다 새로 읽는다: 보낼 판(sourceVersion)은 "화면이 본 머리 판"이어야 하고 후보는 권한이 아니라 지금의 답이다.
      readDialog(null);
    }

    /**
     * 열린 창의 #1 읽기. 창을 열 때와, 첫 Send가 확정 SOURCE_MOVED로 거절된 뒤(§8: 화면은 #1을 다시 읽고 사용자가 다시 확정한다)
     * 부른다. 다 읽을 때까지 phase가 loading이라 Send가 잠긴다. 다시 읽을 때(moved)는 쓰던 메시지를 두고, 고른 받는 사람은 새
     * 후보에 있을 때만 남긴다. 스스로 다시 보내지 않는다. 결과를 모르는 요청의 Check Again은 이 길을 타지 않는다 — 그 요청의
     * requestId·body(sourceVersion 포함)는 바꾸지 않는다(§8.1 규칙 2).
     */
    function readDialog(moved) {
      const uid = dialogUid, sent = who(), seq = ++dialogSeq;
      const before = dialogView && dialogView.data;
      const chosen = moved && before ? before.recipients.find(r => r.sub === recipientField.value) || null : null;
      dialogView = { phase: 'loading', data: null, detail: '', moved };
      paintDialog();
      call('GET', `/studies/${encodeURIComponent(uid)}/critical-result-recipients`, undefined, work.capture('study')).then(guarded(({ data }) => {
        if (seq !== dialogSeq || dialogUid !== uid || !live(sent)) return;
        const mine = ownerOf(data && data.owner, sent);
        if (mine === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        const read = mine === 'same' ? readCandidates(data, uid) : null;
        if (!read) {
          dialogView = { phase: 'failed', data: null, detail: TEXT.malformed, moved };
        } else {
          const kept = !!chosen && read.sendable && read.recipients.some(r => r.sub === chosen.sub);
          dialogView = { phase: read.sendable ? 'ready' : 'unavailable', data: read, detail: '',
            moved: moved && { ...moved, dropped: chosen && read.sendable && !kept ? chosen.name : null } };
          fillRecipients(read.sendable ? read.recipients : []);
          if (kept) recipientField.value = chosen.sub;
          // 같은 대상의 단추도 이 답을 따른다. 앞서 나간 #1 읽기의 늦은 답은 번호로 버린다.
          if (uid === target) {
            entrySeq++;
            targetKey = keyOf(uid);
            entryView = { phase: 'ready', data: read };
            paintEntry();
          }
        }
        paintDialog();
        if (dialogView.phase === 'ready') recipientField.focus();
      }, 'study'), guarded(error => {
        if (seq !== dialogSeq || dialogUid !== uid || !live(sent)) return;
        dialogView = { phase: 'failed', data: null, detail: describe(error), moved };
        paintDialog();
      }, 'study'));
    }

    /** 창을 닫는다. 보내는 중·결과를 모르는 요청은 버리지 않고 보낸 목록 위 줄로 옮긴다(§8.1 규칙 2). */
    function closeDialog() {
      if (dialogUid === null) return;
      dialogSeq++;
      const attempt = dialogAttempt ? attempts.get(dialogAttempt) : null;
      if (attempt) {
        if (unsettled(attempt)) attempt.lined = true;
        else if (!attempt.lined) attempts.delete(attempt.requestId);
      }
      const focusInside = dialog.contains(document.activeElement);
      dialogUid = null;
      dialogAttempt = null;
      dialogView = null;
      dialogNote = '';
      dialog.classList.remove('show');
      resetForm();
      statusBox.dataset.state = '';
      statusWord.textContent = statusText.textContent = statusDetail.textContent = '';
      studyLine.textContent = sourceLine.textContent = '';
      checkButton.hidden = true;
      if (focusInside && dialogReturn && dialogReturn.isConnected) dialogReturn.focus();
      dialogReturn = null;
      paintPanel();
    }

    function send() {
      if (work.state() !== 'active') return;
      if (ended || lock !== null || dialogUid === null || !dialogView || dialogView.phase !== 'ready') return;
      const previous = dialogAttempt ? attempts.get(dialogAttempt) : null;
      if (previous && previous.state !== 'rejected') return;
      const read = dialogView.data, recipient = read.recipients.find(r => r.sub === recipientField.value);
      const message = messageField.value;
      if (!recipient || !textOk(message)) {
        dialogNote = TEXT.dialog.invalid;
        if (previous) { attempts.delete(previous.requestId); dialogAttempt = null; }
        paintDialog();
        return;
      }
      const sent = who(), requestId = newRequestId(), uid = dialogUid;
      if (previous) attempts.delete(previous.requestId);
      const attempt = {
        requestId, action: 'create', uid, recordId: requestId, sent, source: read.source, lined: false,
        path: `/studies/${encodeURIComponent(uid)}/critical-results`,
        body: { requestId, expectedOwner: JSON.parse(sent), recipientSub: recipient.sub, sourceVersion: read.source.version, message },
        expect: { id: requestId, from: null, to: 'created', revision: 1, replacement: null },
        label: `${studyLabel(uid)} · ${recipient.name} · ${ROLES[recipient.role]}`,
        state: 'sending', retried: false, reason: '', detail: '', later: '', replayed: false,
      };
      attempts.set(requestId, attempt);
      dialogAttempt = requestId;
      dialogNote = '';
      transmit(attempt, false);
    }

    // ── 쓰기 답의 판별(§8.1) ──

    function transmit(attempt, retry) {
      attempt.state = retry ? 'checking' : 'sending';
      paintAttempt(attempt);
      call('POST', attempt.path, attempt.body).then(guarded(result => settle(attempt, retry, result, null)), guarded(error => settle(attempt, retry, null, error)));
    }

    /**
     * 한 요청의 답. 버린 요청(로그아웃·계정 전환)이나 이미 증거로 끝난 요청의 늦은 답은 쓰지 않는다. 201이고 봉투가 이 요청의
     * 적용 결과일 때만 적용됨이다. 첫 요청의 확정 거절만 Not delivered이고, 그 밖은 결과를 모르는 답이다. 결과를 모르는 요청의
     * 재전송은 201(또는 같은 id를 가리키는 PENDING_EXISTS)이 아니면 결과를 모르는 채로 두고 기록을 다시 읽는다(규칙 3·4).
     */
    function settle(attempt, retry, result, error) {
      if (attempts.get(attempt.requestId) !== attempt || !['sending', 'checking'].includes(attempt.state)) return;
      if (!live(attempt.sent)) return;
      if (result) {
        const mine = ownerOf(result.data && result.data.owner, attempt.sent);
        if (mine === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        if (result.status === 201 && mine === 'same' && appliedMatches(attempt, result.data)) { applied(attempt, result.data.replayed); return; }
        unknown(attempt, retry, TEXT.unexpected(result.status), '');
        return;
      }
      if (error.status === 409 && error.code === 'OWNER_CHANGED') {
        if (!retry) Object.assign(attempt, { state: 'rejected', reason: TEXT.codes.OWNER_CHANGED, detail: describe(error) });
        paintAttempt(attempt);
        accountChanged(describe(error));
        return;
      }
      if (error.status === 409 && error.code === 'CRITICAL_RESULT_PENDING_EXISTS' && error.body && text(error.body.id)) {
        const id = error.body.id.toLowerCase();
        // 규칙 4: 확인 대기 기록의 id가 이 요청(또는 결과를 모르는 다른 요청)이면 그것이 적용 증거다.
        if (id === attempt.requestId && attempt.action === 'create') { applied(attempt, true); return; }
        evidence(id);
      }
      if (!retry && refused(error)) {
        Object.assign(attempt, { state: 'rejected', reason: reasonOf(error), detail: describe(error) });
        if (attempt.action === 'create' && error.code === 'CRITICAL_RESULT_SOURCE_MOVED') sourceMoved(attempt);
        paintAttempt(attempt);
        if (attempt.action !== 'create') loadList(false);
        return;
      }
      unknown(attempt, retry, describe(error), retry && error.status === 409 && LATER_409.has(error.code) ? reasonOf(error) : '');
    }

    /**
     * 첫 Send의 확정 SOURCE_MOVED: 요청이 닿기 전에 머리 판이 옮겨져 아무것도 저장되지 않았다(§8). 이 요청을 보이는 창이 열려
     * 있으면 그 창의 판과 후보를 다시 읽고, 창이 닫혔으면 단추의 #1만 다시 읽는다. 어느 쪽도 다시 보내지 않는다.
     */
    function sourceMoved(attempt) {
      if (dialogAttempt === attempt.requestId && dialogUid === attempt.uid && lock === null) {
        readDialog({ requestId: attempt.requestId, from: attempt.source.version, dropped: null });
      } else if (attempt.uid === target) {
        targetKey = null;
        sync();
      }
    }

    function applied(attempt, replayed) {
      Object.assign(attempt, { state: attempt.action === 'cancel' ? 'cancelled' : 'delivered', replayed: !!replayed });
      paintAttempt(attempt);
      if (sender()) loadList(false);
    }

    function unknown(attempt, retry, detail, later) {
      Object.assign(attempt, { state: 'unknown', detail, later, retried: attempt.retried || retry });
      paintAttempt(attempt);
      if (retry) confirmByRead(attempt);
    }

    /** 규칙 3 (b): create·supersede는 새 기록 id = requestId, cancel·supersede는 대상 기록의 상태를 다시 읽는다. */
    function confirmByRead(attempt) {
      const ids = attempt.action === 'cancel' ? [attempt.recordId] : attempt.action === 'create' ? [attempt.requestId]
        : [attempt.requestId, attempt.recordId];
      const sent = attempt.sent, context = work.capture('document');
      (async () => {
        for (const id of ids) {
          if (attempts.get(attempt.requestId) !== attempt || attempt.state !== 'unknown' || !live(sent)) return;
          let data;
          try { ({ data } = await call('GET', `/critical-results/${encodeURIComponent(id)}`, undefined, context)); }
          catch (_) { continue; }   // 404·거절은 가시성과 구별되지 않아 미적용의 증거가 아니다.
          if (!work.commit(context, () => {
          if (!live(sent)) return;
          const mine = ownerOf(data && data.owner, sent);
          if (mine === 'other') { accountChanged(TEXT.otherEnvelope); return; }
          const item = mine === 'same' && isObject(data) ? senderItem(data.item) : null;
          if (item && item.id === id) observe(item);
          })) return;
        }
      })();
    }

    /** 읽기에서 본 한 기록으로 결과를 모르는 요청을 끝낸다(규칙 4 (a) 적용 증거, (b) 대상 기록의 종결). */
    function observe(item) {
      evidence(item.id);
      if (item.state === 'created') return;
      for (const attempt of attempts.values()) {
        if (attempt.recordId !== item.id || attempt.action === 'create' || !['unknown', 'checking'].includes(attempt.state)) continue;
        if (attempt.action === 'cancel' && item.state === 'cancelled') { applied(attempt, false); continue; }
        if (attempt.action === 'supersede' && item.state === 'superseded' && item.replacedBy === attempt.requestId) { applied(attempt, false); continue; }
        Object.assign(attempt, { state: 'rejected', reason: TEXT.serverState(item.state), detail: '', later: '' });
        paintAttempt(attempt);
      }
    }

    function evidence(id) {
      const attempt = attempts.get(id);
      if (attempt && attempt.action !== 'cancel' && ['sending', 'checking', 'unknown'].includes(attempt.state)) applied(attempt, false);
    }

    /** 요청의 상태 이름·설명·세부. 창과 목록 위 줄이 같은 문구를 쓴다. */
    function outcomeText(attempt) {
      const cancel = attempt.action === 'cancel';
      const retryText = [attempt.later ? TEXT.later(attempt.later) : '', attempt.retried ? TEXT.guidance : ''].filter(Boolean).join('\n');
      switch (attempt.state) {
        case 'sending': return { word: '', line: attempt.lined ? TEXT.sending : TEXT.dialog.sending, detail: '' };
        case 'checking': return { word: cancel ? 'Cancellation status unknown' : 'Delivery status unknown', line: TEXT.checking, detail: retryText };
        case 'unknown': return { word: cancel ? 'Cancellation status unknown' : 'Delivery status unknown',
          line: cancel ? TEXT.cancelUnknown : TEXT.unknown, detail: [retryText, attempt.detail].filter(Boolean).join('\n') };
        case 'delivered': return { word: 'Delivered', line: attempt.replayed ? `${TEXT.delivered} ${TEXT.replayed}` : TEXT.delivered, detail: '' };
        case 'cancelled': return { word: 'Cancelled', line: attempt.replayed ? `${TEXT.cancelled} ${TEXT.replayed}` : TEXT.cancelled, detail: '' };
        default: return { word: cancel ? 'Not cancelled' : 'Not delivered',
          line: attempt.action === 'create' && !attempt.lined && lock === null ? `${attempt.reason} ${TEXT.newRequest}` : attempt.reason,
          detail: attempt.detail };
      }
    }

    function paintAttempt(attempt) {
      if (dialogAttempt === attempt.requestId && dialogUid !== null) paintDialog();
      if (attempt.lined) paintLines();
      paintPanel();
    }

    function check(attempt) {
      if (ended || lock !== null || attempts.get(attempt.requestId) !== attempt || attempt.state !== 'unknown') return;
      if (!live(attempt.sent)) return;
      transmit(attempt, true);
    }

    // ── 보낸 목록(Sent Critical Results) ──

    function loadList(next) {
      if (!sender()) return;
      const cursor = next ? nextCursor : null;
      if (next && !cursor) return;
      const seq = ++listSeq, sent = who(), chosen = filter;
      listPhase = 'loading';
      paintPanel();
      const query = `view=sent&state=${encodeURIComponent(chosen)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      call('GET', `/critical-results?${query}`).then(guarded(({ data }) => {
        if (seq !== listSeq || chosen !== filter || !live(sent)) return;
        const mine = ownerOf(data && data.owner, sent);
        if (mine === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        const read = mine === 'same' ? readList(data, chosen) : null;
        loadedOnce = true;
        if (!read) {
          listPhase = 'failed';
          listError = TEXT.malformed;
          paintPanel();
          return;
        }
        const known = new Set(next ? items.map(item => item.id) : []);
        items = next ? items.concat(read.items.filter(item => !known.has(item.id))) : read.items;
        nextCursor = read.nextCursor;
        pending = read.pending;
        listPhase = 'ready';
        listError = '';
        staleRows = true;
        for (const item of read.items) observe(item);
        paintPanel();
        // 목록에서 끝나지 않은 결과 모르는 요청은 한 건 읽기로 다시 확인한다(규칙 3 (b)). 읽기일 뿐 요청을 다시 보내지 않는다.
        for (const attempt of attempts.values()) if (attempt.state === 'unknown') confirmByRead(attempt);
      }), guarded(error => {
        if (seq !== listSeq || !live(sent)) return;
        loadedOnce = true;
        listPhase = 'failed';
        listError = describe(error);
        paintPanel();
      }));
    }

    function lined() { return [...attempts.values()].filter(attempt => attempt.lined); }

    function paintLines() {
      const shown = lined();
      for (const [id, element] of lineNodes) if (!shown.some(attempt => attempt.requestId === id)) { element.remove(); lineNodes.delete(id); }
      for (const attempt of shown) {
        let element = lineNodes.get(attempt.requestId);
        if (!element) {
          element = make('li', 'cvr-line');
          element.dataset.request = attempt.requestId;
          const head = make('p', 'cvr-line-head');
          head.append(make('strong', 'cvr-word'), make('span', 'cvr-line-what'));
          element.append(head, make('p', 'cvr-text'), make('p', 'cvr-detail'), button('Check Again', () => check(attempt)));
          attemptList.append(element);
          lineNodes.set(attempt.requestId, element);
        }
        const { word, line, detail } = outcomeText(attempt);
        const action = { create: 'Send', supersede: 'Supersede', cancel: 'Cancel Delivery' }[attempt.action];
        element.dataset.state = attempt.state;
        element.querySelector('.cvr-word').textContent = word || 'Sending';
        element.querySelector('.cvr-line-what').textContent = ` · ${action} · ${attempt.label}`;
        element.querySelector('.cvr-text').textContent = line;
        const extra = element.querySelector('.cvr-detail');
        extra.textContent = detail;
        extra.hidden = !detail;
        const again = element.querySelector('button');
        again.hidden = !['unknown', 'checking'].includes(attempt.state);
        again.disabled = attempt.state === 'checking';
      }
      attemptList.hidden = shown.length === 0;
    }

    function markOf(item) {
      if (item.state !== 'created') return [];
      const out = [];
      if (!item.source.current) out.push(['source', ...TEXT.marks.source]);
      if (item.delivery === 'not_eligible') out.push(['not_eligible', ...TEXT.marks.not_eligible]);
      if (item.delivery === 'unknown') out.push(['unknown', ...TEXT.marks.unknown]);
      return out;
    }

    function renderRow(item) {
      const row = make('tr');
      row.dataset.id = item.id;
      row.dataset.state = item.state;
      const studyCell = make('td');
      studyCell.append(make('span', null, `${item.study.name || '—'} (${item.study.id || '—'})`), make('span', 'cvr-muted', item.study.date || '—'));
      const recipientCell = make('td', null, `${item.recipient.name} · ${ROLES[item.recipient.role]}`);
      const sentCell = make('td', null, time(item.createdAt));
      const stateCell = make('td');
      const state = make('span', 'cvr-state', STATES[item.state]);
      state.dataset.state = item.state;
      state.title = TEXT.states[item.state];
      stateCell.append(state);
      const closedAt = { acknowledged: item.acknowledgedAt, cancelled: item.cancelledAt, superseded: item.supersededAt }[item.state];
      if (closedAt) stateCell.append(make('span', 'cvr-muted', time(closedAt)));
      for (const [key, name, note] of markOf(item)) {
        const mark = make('span', 'cvr-mark', name);
        mark.dataset.mark = key;
        mark.title = note;
        stateCell.append(mark, make('p', 'cvr-note', note));
      }
      if (item.state === 'cancelled' && item.cancelReason) stateCell.append(make('p', 'cvr-note', TEXT.list.cancelReason(item.cancelReason)));
      if (item.state === 'created') {
        const busy = [...attempts.values()].some(attempt => attempt.recordId === item.id && attempt.action !== 'create' && unsettled(attempt));
        const actions = make('div', 'cvr-actions');
        const supersede = button('Supersede', () => openForm(item, 'supersede'));
        const cancel = button('Cancel Delivery', () => openForm(item, 'cancel'));
        supersede.disabled = cancel.disabled = busy || forms.has(item.id);
        actions.append(supersede, cancel);
        stateCell.append(actions);
      }
      const sourceCell = make('td', null, sourceText(item.source).slice('Source: '.length));
      row.append(studyCell, recipientCell, sentCell, stateCell, sourceCell);
      const out = [row];
      if (forms.has(item.id)) out.push(forms.get(item.id).row);
      return out;
    }

    function paintRows() {
      // 입력 칸이 열려 있거나 초점이 행 안에 있으면 다시 그리지 않는다 — 쓰던 사유·메시지와 초점을 지킨다. 칸을 닫거나 초점이
      // 떠나면 그린다.
      if (forms.size || rows.contains(document.activeElement)) return;
      rows.replaceChildren(...items.flatMap(renderRow));
      staleRows = false;
    }

    function paintPanel() {
      // 보낼 수 있는 세션에는 이 줄이 늘 선다. 확인 대기가 0이어도 Show Sent로 종결된 전달(Acknowledged·Cancelled·Superseded)의
      // 기록과 서버 시각을 다시 열 수 있어야 한다 — 확인 대기 항목의 표시 조건을 이력 입구의 조건으로 쓰지 않는다. 목록 칸은
      // 사용자가 열 때만 펼친다.
      const show = !ended && online() && radiologist();
      panel.hidden = !show;
      if (!show) return;
      const unknownCount = lined().filter(attempt => unsettled(attempt)).length;
      let line;
      if (lock !== null) line = lock.text;
      else if (listPhase === 'failed') line = TEXT.list.failed;
      else if (pending === null) line = listPhase === 'loading' ? TEXT.list.loading : '';
      else line = `Pending ACK ${pending}${unknownCount ? ` · ${TEXT.list.unknownCount(unknownCount)}` : ''}`;
      panel.dataset.state = lock !== null ? 'locked' : listPhase;
      summary.textContent = line;
      summary.title = line;
      toggle.textContent = paneOpen ? 'Hide Sent' : 'Show Sent';
      toggle.setAttribute('aria-expanded', String(paneOpen && lock === null));
      toggle.disabled = refreshButton.disabled = lock !== null;
      filterField.disabled = lock !== null;
      pane.hidden = !paneOpen || lock !== null;
      paintLines();
      if (lock !== null) attemptList.hidden = true;
      if (staleRows) paintRows();
      listStatus.dataset.state = listPhase;
      listStatus.textContent = listPhase === 'loading' ? TEXT.list.loading
        : listPhase === 'failed' ? `${TEXT.list.failed}\n${listError}`
          : items.length ? TEXT.list.ready(items.length, !!nextCursor) : loadedOnce ? TEXT.list.empty : '';
      moreButton.hidden = !nextCursor || lock !== null;
      moreButton.disabled = listPhase === 'loading';
    }

    // ── 행 동작: Cancel Delivery(#7)·Supersede(#8) ──

    function openForm(item, kind) {
      if (ended || lock !== null || forms.has(item.id) || item.state !== 'created') return;
      const form = { kind, item, row: make('tr', 'cvr-form'), note: make('p', 'cvr-note'), field: make('textarea'),
        confirm: null, source: null, seq: 0 };
      form.row.dataset.form = item.id;
      const cell = make('td');
      cell.colSpan = 5;
      const label = make('label', null);
      label.append(make('span', null, kind === 'cancel' ? 'Reason' : 'Message'), form.field);
      form.field.maxLength = TEXT_MAX;
      form.field.rows = 3;
      form.sourceLine = make('p', 'cvr-form-source');
      form.confirm = button(kind === 'cancel' ? 'Cancel Delivery' : 'Supersede', () => submitForm(form));
      const actions = make('div', 'cvr-actions');
      actions.append(form.confirm, button('Close', () => closeForm(item.id)));
      cell.append(make('p', 'cvr-form-title', kind === 'cancel' ? 'Cancel Delivery' : 'Supersede'),
        make('p', 'cvr-muted', kind === 'cancel' ? TEXT.form.cancelHint : TEXT.form.supersedeHint(item.recipient.name)),
        form.sourceLine, label, form.note, actions);
      form.row.append(cell);
      forms.set(item.id, form);
      form.sourceLine.hidden = kind === 'cancel';
      form.note.hidden = true;
      if (kind === 'supersede') readFormSource(form);
      rows.replaceChildren(...items.flatMap(renderRow));
      form.field.focus();
      paintPanel();
    }

    /** Supersede는 지금 머리 판으로 보낸다. 그 판 번호는 그 검사의 #1이 답한 source다. */
    function readFormSource(form) {
      const seq = ++form.seq, sent = who(), uid = form.item.studyUid;
      form.confirm.disabled = true;
      form.sourceLine.textContent = TEXT.form.loading;
      call('GET', `/studies/${encodeURIComponent(uid)}/critical-result-recipients`, undefined, work.capture('document')).then(guarded(({ data }) => {
        if (forms.get(form.item.id) !== form || seq !== form.seq || !live(sent)) return;
        const mine = ownerOf(data && data.owner, sent);
        if (mine === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        const read = mine === 'same' ? readCandidates(data, uid) : null;
        if (!read) { form.sourceLine.textContent = `${TEXT.form.failed}\n${TEXT.malformed}`; return; }
        if (!read.source || read.reason === 'NO_PINNABLE_SOURCE' || read.reason === 'SOURCE_FORBIDDEN') {
          form.sourceLine.textContent = read.reason ? TEXT.reasons[read.reason] : TEXT.form.failed;
          return;
        }
        form.source = read.source;
        form.sourceLine.textContent = sourceText(read.source);
        const listed = read.recipients.some(r => r.actor === form.item.recipient.actor);
        form.note.textContent = listed ? '' : TEXT.form.notCandidate;
        form.note.hidden = listed;
        form.confirm.disabled = false;
      }), guarded(error => {
        if (forms.get(form.item.id) !== form || seq !== form.seq || !live(sent)) return;
        form.sourceLine.textContent = `${TEXT.form.failed}\n${describe(error)}`;
      }));
    }

    function closeForm(id) {
      const form = forms.get(id);
      if (!form) return;
      form.seq++;
      forms.delete(id);
      form.row.remove();
      staleRows = true;
      paintPanel();
      const back = rows.querySelector(`tr[data-id="${CSS.escape(id)}"] button`);
      if (back) back.focus();
    }

    function submitForm(form) {
      if (ended || lock !== null || forms.get(form.item.id) !== form) return;
      const value = form.field.value, item = form.item;
      if (!textOk(value)) {
        form.note.textContent = TEXT.form.noText;
        form.note.hidden = false;
        return;
      }
      // Supersede는 지금 판(#1 source)을 읽기 전에는 단추가 꺼져 있다.
      if (form.kind === 'supersede' && !form.source) return;
      const sent = who(), requestId = newRequestId();
      const cancel = form.kind === 'cancel';
      const attempt = {
        requestId, action: form.kind, uid: item.studyUid, recordId: item.id, sent, source: cancel ? null : form.source, lined: true,
        path: `/critical-results/${encodeURIComponent(item.id)}/${form.kind}`,
        body: cancel ? { requestId, expectedOwner: JSON.parse(sent), revision: item.revision, reason: value }
          : { requestId, expectedOwner: JSON.parse(sent), revision: item.revision, sourceVersion: form.source.version, message: value },
        expect: { id: item.id, from: 'created', to: cancel ? 'cancelled' : 'superseded', revision: 2,
          replacement: cancel ? null : { id: requestId, sourceVersion: form.source.version } },
        label: `${studyLabel(item.studyUid, item.study)} · ${item.recipient.name} · ${ROLES[item.recipient.role]}`,
        state: 'sending', retried: false, reason: '', detail: '', later: '', replayed: false,
      };
      attempts.set(requestId, attempt);
      forms.delete(item.id);
      form.row.remove();
      staleRows = true;
      transmit(attempt, false);
    }

    // ── 세션 경계 ──

    function abortAll() {
      for (const controller of inflight) controller.abort();
      inflight.clear();
    }

    /**
     * 확인된 계정 변경(다른 계정의 봉투·OWNER_CHANGED)은 이 영역만의 일이 아니다. 이 영역을 잠그고 결과를 모르는 요청을 버린
     * 뒤(원래 계정의 requestId를 새 계정으로 보내지 않는다) 공통 목록에 사유 'account-changed'로 알린다.
     */
    function accountChanged(detail) {
      if (ended || lock !== null) return;
      lockArea(TEXT.dialog.locked, detail);
      if (onAccountChanged) onAccountChanged(detail);
    }

    function lockArea(message, detail) {
      if (ended || lock !== null) return;
      lock = { text: message, detail: detail || '' };
      abortAll();
      entrySeq++;
      listSeq++;
      dialogSeq++;
      for (const [id, attempt] of attempts) if (id !== dialogAttempt || attempt.state !== 'rejected') attempts.delete(id);
      forms.clear();
      items = [];
      nextCursor = null;
      pending = null;
      rows.replaceChildren();
      paintEntry();
      paintDialog();
      paintPanel();
    }

    /**
 * Session termination belongs to the page transport and work-context lifecycle.
     * 어디에도 그리지 않는다. 방송·storage·pagehide와 겹쳐 여러 번 불려도 한 번만 끝낸다.
     */
    function end(reason, detail) {
      if (reason === 'account-changed') { lockArea(TEXT.dialog.locked, detail); return; }
      if (ended) return;
      ended = true;
      abortAll();
      entrySeq++;
      listSeq++;
      closeDialog();
      attempts.clear();
      forms.clear();
      items = [];
      nextCursor = null;
      pending = null;
      rows.replaceChildren();
      paintLines();
      clearInterval(timer);
      target = null;
      paintEntry();
      paintPanel();
    }

    entry.addEventListener('click', openDialog);
    more.addEventListener('toggle', () => { if (more.open) sync(); });
    sendButton.addEventListener('click', send);
    checkButton.addEventListener('click', () => { const attempt = attempts.get(dialogAttempt); if (attempt) check(attempt); });
    closeButton.addEventListener('click', closeDialog);
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || dialogUid === null) return;
      event.preventDefault();
      closeDialog();
    });
    toggle.addEventListener('click', () => {
      if (ended || lock !== null) return;
      paneOpen = !paneOpen;
      staleRows = true;
      paintPanel();
      if (paneOpen && !loadedOnce) loadList(false);
    });
    refreshButton.addEventListener('click', () => {
      if (ended || lock !== null) return;
      // 끝난 줄은 사용자가 본 뒤 Refresh에서 내린다. 결과를 모르는 줄은 끝날 때까지 남는다.
      for (const [id, attempt] of attempts) if (attempt.lined && !unsettled(attempt)) attempts.delete(id);
      loadList(false);
    });
    filterField.addEventListener('change', () => {
      if (ended || lock !== null || !Object.prototype.hasOwnProperty.call(FILTER_STATE, filterField.value)) return;
      filter = filterField.value;
      // 다른 상태의 목록으로 바꾸면 열어 둔 행 입력 칸은 그 목록에 없는 행의 것이다. 칸을 닫고 새 목록을 그린다.
      for (const form of forms.values()) form.row.remove();
      forms.clear();
      items = [];
      nextCursor = null;
      staleRows = true;
      loadList(false);
    });
    moreButton.addEventListener('click', () => loadList(true));
    rows.addEventListener('focusout', () => {
      if (!staleRows) return;
      setTimeout(guarded(() => { if (staleRows && !rows.contains(document.activeElement)) paintRows(); }), 0);
    });
    // 문서가 보이고 이 줄이 서 있는(보낼 수 있는 세션) 동안만 다시 읽는다. 읽기는 어떤 기록도 바꾸지 않고(ACK·재알림이 아니다)
    // 알림도 띄우지 않는다.
    function startTimers() {
      clearInterval(timer);
      timer = setInterval(guarded(() => {
        if (sender() && !panel.hidden && document.visibilityState === 'visible' && listPhase !== 'loading') loadList(false);
      }), PERIOD_MS);
    }
    work.onInvalidate(event => {
      if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) { end(); return; }
      if (event.reason === 'prepare') { clearInterval(timer); }
      if (event.reason === 'cancel') {
        for (const attempt of attempts.values()) if (['sending', 'checking'].includes(attempt.state)) {
          attempt.state = 'unknown'; attempt.detail = TEXT.noResponse; paintAttempt(attempt);
        }
        if (entryView.phase === 'loading') targetKey = null;
        if (dialogUid !== null && dialogView?.phase === 'loading') readDialog(false);
        for (const form of forms.values()) if (!form.source) readFormSource(form);
        sync(); if (listPhase === 'loading') loadList(false);
        startTimers();
      } else if (event.reason === 'lifecycle' && event.state === 'active') startTimers();
    });
    if (work.state() === 'active') startTimers();
    window.addEventListener('pagehide', () => end());
    filterField.value = filter;
    paintEntry();
    paintPanel();
    return { sync, end, lock: detail => lockArea(TEXT.dialog.locked, detail) };
  }

  window.KinCriticalResultSend = Object.freeze({ mount });
})();
