

    // ── 영상 요청(S5-U4c) ──
    // REQ-S5-U4c-REQUEST-UI → RISK-S5-U4c-STALE → TEST-S5-U4c-DOM (tests/clinician_request_dom_test.py가 이 절을 잘라 실행한다).
    // 임상의가 남긴 외부영상(External Images)·영상전송(Send Images) 요청을 두 곳에 보인다. Technician 모드 Order List 패널 안의
    // 대기열은 #7 view=queue(쪽 50·cursor), #8 단건, #11 accept·close·decline·cancel을 쓰고, 판독 화면의 줄은 판독 대상 검사의 #9를
    // 읽기만 한다. 질문·consultation 창과 섞지 않는다(별도 칸·별도 읽기). 요청은 처리 상태의 기록일 뿐이라 이 절은 영상을 옮기거나
    // Connect 경로를 부르지 않고, Closed 옆에는 그 기록이 실제 전송 여부를 나타내지 않는다고 쓴다. 역할에 맞지 않는 처리 단추는
    // applyRoleUi처럼 회색으로 두어 안내만 하고 판정은 서버가 한다(거절은 코드·문구 그대로 보인다).
    // 늦은 답은 대기열 쪽 번호(queueSeq), 단건 번호(detailSeq)와 연 요청 id, 판독 쪽 번호(readSeq)와 대상 검사로 버린다(A→B→A).
    // 서버가 읽기를 거절(403)했거나 다른 계정의 답·OWNER_CHANGED가 오면 이 문서에서는 더 읽거나 쓰지 않고(뷰어 세션의 거절과 같은
    // 한 방향), 세션이 끝나면(로그아웃·다른 탭·401) 두 칸을 내린다. 이 페이지가 로그아웃을 시작하는 곳(api()의 401, 확정한 Log out,
    // Module teardown follows the page work-context lifecycle.
    // 부른다 — 로그아웃 통지는 POST /auth/logout(제한 시간 없음)이 끝난 뒤에야 오므로 그것을 기다리면 그사이 도착한 이전 세션의 답이
    // 그려진다. 계정 변경은 같은 목록에 사유 'account-changed'로 알려 이 페이지의 다른 영역(S5-U4b 질문 줄)도 같은 자리에서 잠근다.
    // 쓰던 note는 요청별로 이 문서의 메모리에만 두고, 잠그거나 끝나면 이전 계정의 글이라 버린다.
    function mountImageRequests({ api, apiBase, work, transport, owner, allowed, current, study, institution, can }) {
      const TEXT = {
        queueHint: '소속 기관 검사에 임상의가 남긴 외부영상(External Images)·영상전송(Send Images) 요청입니다. 요청은 처리 상태의 '
          + '기록이며 이 칸은 영상을 옮기지 않습니다. 영상은 기존 경로에서 따로 옮기고, 처리를 마치면 Close에 처리 기록을 남기세요.',
        noteHint: 'Accept는 note 없이 기록합니다. Close·Decline·Cancel은 note(1~2,000자)가 필요합니다. 처리자·시각은 서버가 로그인한 계정으로 기록합니다.',
        offline: '서버에 연결된 동안에만 영상 요청을 읽습니다.',
        queueLoading: '요청 대기열을 불러오는 중입니다…',
        queueFailed: '요청 대기열을 불러오지 못했습니다.',
        queueEmpty: '이 조건의 영상 요청이 없습니다. 목록 조회는 성공했습니다.',
        queueReady: (n, more) => `영상 요청 ${n}건을 최신순으로 표시합니다.${more ? ' More로 다음 요청을 이어서 읽습니다.' : ''}`,
        detailLoading: '요청을 불러오는 중입니다…',
        detailFailed: '요청을 불러오지 못했습니다.',
        malformed: '영상 요청 응답 형식을 확인할 수 없습니다. 다시 불러오세요.',
        notFound: '요청이나 검사를 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다.',
        // U4p §3.3 화면 문구 규칙: Closed 옆에 늘 함께 쓴다.
        closedNote: '이 기록은 실제 전송 여부를 나타내지 않습니다',
        unlisted: '워크리스트에 없는 검사',
        meta: (created, name) => `${created} 요청 · ${name}`,
        registered: '등록 기관',
        noNote: '이 동작에는 note(1~2,000자)가 필요합니다.',
        sending: '보내는 중입니다…',
        saved: { accept: 'Accepted로 기록했습니다.', close: 'Closed로 기록했습니다. 이 기록은 실제 전송 여부를 나타내지 않습니다.',
          decline: 'Declined로 기록했습니다.', cancel: 'Cancelled로 기록했습니다.' },
        replayed: '이미 저장된 요청입니다. 서버가 처음 저장한 결과를 돌려주었습니다.',
        unknown: '저장되었는지 알 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인하고, Discard는 이 요청을 버립니다.',
        discarded: '보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 요청에서 확인하세요.',
        writeMalformed: '저장 응답의 형식을 확인할 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인합니다.',
        noRequestId: '요청 ID를 만들지 못해 보내지 않았습니다.',
        refused: '서버가 이 계정의 영상 요청 읽기를 거절했습니다. 권한이 바뀌었다면 화면을 다시 불러오세요.',
        ownerChanged: '로그인한 계정이 바뀌었습니다. 이 화면에서는 영상 요청을 더 읽거나 쓰지 않습니다. 화면을 다시 불러오세요.',
        ended: '세션이 끝났습니다. 영상 요청을 더 읽거나 쓰지 않습니다.',
        rejected: '서버가 요청을 거절했습니다.',
        expired: '세션이 만료되었습니다. 다시 로그인하세요.',
        noResponse: '응답이 없어 요청을 멈췄습니다.',
        noServer: '서버에 연결하지 못했습니다.',
        roleStaff: '방사선사(technician) 또는 관리자 권한이 필요합니다.',
        roleCancel: '요청한 임상의 또는 관리자만 취소할 수 있습니다.',
        ownChecking: '이 계정이 남긴 요청인지 서버의 내 요청 목록에서 확인하는 중입니다.',
        ownFailed: '이 계정이 남긴 요청인지 확인하지 못해 Cancel을 막았습니다. Reload로 다시 확인하세요.',
        ownTooMany: '내 요청 목록을 끝까지 보지 못해 이 요청을 찾지 못했습니다.',
        stateAccept: 'Requested 상태의 요청만 Accept할 수 있습니다.',
        stateDone: '처리가 끝난 요청입니다.',
        tips: { accept: '요청을 받아 처리 중(Accepted)으로 기록합니다.', close: '처리를 마쳤다고(Closed) 기록합니다. 실제 전송 여부를 나타내지 않습니다.',
          decline: '요청을 거절(Declined)로 기록합니다.', cancel: '요청을 취소(Cancelled)로 기록합니다.' },
        readHint: '이 검사에 임상의가 남긴 영상 요청입니다. 판독 화면에서는 읽기만 하고, 처리는 Technician 모드의 Image Requests에서 합니다.',
        readLoading: '이 검사의 영상 요청을 불러오는 중입니다…',
        readFailed: '이 검사의 영상 요청을 불러오지 못했습니다.',
        readCounts: (n, parts) => `이 검사의 영상 요청 ${n}건 · ${parts}`,
        codes: {
          IMAGE_REQUEST_CHANGED: '그사이 이 요청이 바뀌었습니다. 요청을 다시 불러왔으니 상태를 확인한 뒤 다시 보내세요.',
          IMAGE_REQUEST_STATE: '지금 요청 상태에서는 할 수 없는 동작입니다. 이미 처리가 끝났을 수 있어 요청을 다시 불러왔습니다.',
          REQUEST_ID_REUSED: '같은 요청 ID가 다른 내용에 이미 쓰였습니다. 요청을 다시 불러온 뒤 새로 보내세요.',
          IMAGE_REQUEST_INPUT_INVALID: '서버가 입력 형식을 거절했습니다. note의 길이와 줄바꿈·탭 외의 제어 문자를 확인하세요.',
          IMAGE_REQUEST_ROLE_REQUIRED: '이 계정에는 이 동작에 필요한 역할이 없습니다.',
          IMAGE_REQUEST_ACTION_FORBIDDEN: '이 요청에는 이 동작을 할 수 없습니다.',
          IMAGE_REQUEST_BUSY: '서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.',
          STUDY_ACCESS_CHANGED: '요청 중 검사 접근 조건이 바뀌었습니다. 저장되었을 수 있으니 Retry로 같은 요청을 다시 보내 확인하세요.',
        },
        statuses: { 400: '서버가 입력을 거절했습니다.', 403: '서버가 이 동작을 거절했습니다.' },
      };
      const STATES = ['Requested', 'Accepted', 'Closed', 'Declined', 'Cancelled'];
      const ACTIVE = ['Requested', 'Accepted'];
      // 동작마다 적용 결과가 가야 할 상태(U4p §5.2 전이표). 쓰기 응답의 to가 이것과 다르면 저장 결과로 받지 않는다.
      const TARGET = { accept: 'Accepted', close: 'Closed', decline: 'Declined', cancel: 'Cancelled' };
      // API 값 image-transfer는 화면에 쓰지 않는다: transfer는 Connect 전송의 말이고 요청은 전송이 아니다(U4p R06).
      const KINDS = { 'external-image': 'External Images', 'image-transfer': 'Send Images' };
      const KIND_TIPS = { 'external-image': '다른 병원의 영상을 이 기관으로 가져오도록 한 요청입니다.',
        'image-transfer': '이 검사의 영상을 다른 병원에 보내도록 한 요청입니다.' };
      const NOTE_LABEL = { Closed: 'Handling Note', Declined: 'Decline Reason', Cancelled: 'Cancel Reason' };
      const FILTERS = [['active', 'Active'], ['closed', 'Closed'], ['declined', 'Declined'], ['cancelled', 'Cancelled'], ['all', 'All']];
      const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      const STUDY = /^\d+(?:\.\d+)+$/;
      const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
      // OWN_PAGES: 본인 요청을 찾으려 읽는 #7 view=mine의 최대 쪽 수(50건씩). 넘기면 모르는 채로 두어 Cancel을 닫는다.
      const TIMEOUT_MS = 60000, NOTE_MAX = 2000, PAGE = 50, OWN_PAGES = 20;
      const queueRoot = document.getElementById('image-request-queue');
      const queueBody = document.getElementById('image-request-queue-body');
      const readRoot = document.getElementById('image-request-p');
      const readSummary = document.getElementById('image-request-summary');
      const readToggle = document.getElementById('image-request-toggle');
      const readPane = document.getElementById('image-request-pane');
      let ended = false, lock = null;
      // queueLoaded: 지금 조건의 첫 쪽을 읽은 적이 있는가. 읽기 전의 빈 목록을 "조회 성공, 요청 없음"으로 쓰지 않기 위해서다.
      let queueState = 'active', queueKind = '', queueItems = [], queueCursor = null, queueFailure = null, queueLoading = false;
      let queueLoaded = false;
      let queueSeq = 0, detailId = null, detailItem = null, detailFailure = null, detailLoading = false, detailSeq = 0;
      let readUid = null, readItems = null, readFailure = null, readLoading = false, readSeq = 0, readOpen = false;
      // 요청 id별로 쓰던 note, 결과를 모르는 쓰기(같은 requestId로 다시 보낼 것), 마지막 결과 문구.
      const drafts = new Map(), attempts = new Map(), notes = new Map();
      // 요청 id별로 이 계정이 남긴 요청인지(true·false, 서버 목록이 정한 값)와, 확인 중('checking')·확인 실패(오류)인 것.
      const ownIds = new Map(), ownReads = new Map();
      const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const button = (label, onClick) => {
        const node = make('button', null, label);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
      };
      const stateBox = () => {
        const box = make('div', 'image-request-box');
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.append(make('p', 'image-request-line'), make('p', 'image-request-detail'));
        return box;
      };
      const setState = (box, state, text, detail) => {
        box.dataset.state = state;
        box.querySelector('.image-request-line').textContent = text;
        box.querySelector('.image-request-detail').textContent = detail || '';
      };
      const dash = value => typeof value === 'string' && value.trim() ? value : '—';
      const person = value => dash(value && (value.name || value.actor));
      const time = value => {
        const date = typeof value === 'string' ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '—';
        const two = part => String(part).padStart(2, '0');
        return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
      };
      const describe = error => {
        const parts = [];
        if (error && error.status) parts.push(`HTTP ${error.status}`);
        if (error && error.code) parts.push(error.code);
        const message = error && error.message ? error.message : TEXT.rejected;
        return parts.length ? `${message} (${parts.join(' · ')})` : message;
      };
      const readDetail = error => `${error && error.status === 404 ? `${TEXT.notFound}\n` : ''}${describe(error)}`;
      // 상태명은 색과 함께 늘 글자로 쓰고(UXR-G-12), Closed에는 기록일 뿐이라는 문구를 바로 옆에 붙인다.
      const badge = state => {
        const wrap = make('span');
        const name = make('span', 'image-request-status', state);
        name.dataset.state = state;
        wrap.append(name);
        if (state === 'Closed') {
          const note = make('span', 'image-request-closed', TEXT.closedNote);
          note.dataset.closedNote = '';
          wrap.append(' ', note);
        }
        return wrap;
      };
      const kindName = kind => {
        const name = make('strong', null, KINDS[kind]);
        name.title = KIND_TIPS[kind];
        return name;
      };
      const line = (label, value) => {
        const node = make('p', 'image-request-text');
        node.append(make('span', 'image-request-muted', label), ' ', value);
        return node;
      };
      const studyLabel = uid => {
        const row = study(uid);
        return row ? `${dash(row.name)} · ${dash(row.id)} · ${dash(row.date)} · ${dash(row.desc)}` : `${TEXT.unlisted} · ${uid}`;
      };

      /** 응답의 owner가 이 화면의 계정인가. 다르면 false(다른 계정의 답), 모양이 틀리면 null(형식 오류)이다. */
      function ownerOf(data) {
        const value = data && data.owner, mine = owner();
        if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null;
        return !!mine && value[0] === mine[0] && value[1] === mine[1];
      }

      /** 쓰기마다 새 UUID v4. randomUUID가 없는 브라우저는 같은 형식을 getRandomValues로 만든다. */
      function newRequestId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map(part => part.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }

      /**
       * 읽기(#7·#8·#9). api()에 제한 시간을 둔다. 연결 실패·제한 시간은 status 0이다. `at`은 그 읽기를 시작한 작업 문맥이다 —
       * 답과 실패를 그리는 자리는 부른 쪽이 이 문맥(work.admits)과 자기 번호를 함께 본다(로그아웃 준비·그 취소 뒤의 답은
       * 이 칸의 것이 아니다).
       */
      async function call(method, path, body, at) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          return await api(method, path, body, controller.signal, at);
        } catch (error) {
          if (error && Number.isInteger(error.status)) throw error;
          throw Object.assign(new Error(error && error.name === 'AbortError' ? TEXT.noResponse : TEXT.noServer), { status: 0, code: null });
        } finally {
          clearTimeout(timer);
        }
      }

      /**
       * 쓰기(#11, 제한 시간 60초). api()는 성공 응답의 본문만 돌려주어 HTTP 상태를 버린다 — 적용 결과는 201뿐이라(U4p §3.4)
       * 200·202·204 같은 다른 성공 상태를 저장 결과로 받지 않으려면 상태가 필요하다(Astra S5-U4bc-R-001 F02). api()를 쓰는
       * 다른 호출자는 그대로 두고 이 쓰기만 상태와 본문을 함께 돌려준다(appliedOf). 같은 전송으로 보낸다: 시작할 때의 문맥으로
       * 승인받고 그 세션의 식별값을 싣는다. 401은 전송이 그 요청의 세션으로 auth.js에 알린다 — 이 칸은 세션 종료 조정이
       * 부르는 end()로 닫히고 여기서 로그아웃을 부르지 않는다. 연결 실패·제한 시간은 status 0이다 — 서버가 적용했는지 모르는
       * 결과다.
       */
      async function post(path, body, at) {
        try {
          const answer = await transport.request(apiBase + path, { method: 'POST', json: body, context: at, deadlineMs: TIMEOUT_MS });
          if (answer.auth) throw Object.assign(new Error(TEXT.expired), { status: answer.status, code: null, auth: true });
          if (!answer.ok) {
            throw Object.assign(new Error(answer.body && typeof answer.body.message === 'string' ? answer.body.message : `HTTP ${answer.status}`),
              { status: answer.status, code: answer.code });
          }
          return { status: answer.status, data: answer.incomplete ? null : answer.body };
        } catch (error) {
          if (error && Number.isInteger(error.status)) throw error;
          throw Object.assign(new Error(error && error.transport === 'timeout' ? TEXT.noResponse : TEXT.noServer), { status: 0, code: null });
        }
      }

      /**
       * 요청 DTO 한 건(U4p §3.3). target이 있으면 그 검사의 행이어야 한다. 처리 중(Requested·Accepted)이면 note가 없고 끝난
       * 상태면 있다(서버 CHECK와 같은 조건).
       */
      function itemOk(item, target) {
        const text = value => typeof value === 'string';
        const who = value => !!value && typeof value === 'object' && text(value.actor) && text(value.name);
        return !!item && typeof item === 'object' && text(item.id) && ID.test(item.id) && text(item.studyUid)
          && (target === null ? item.studyUid.length <= 64 && STUDY.test(item.studyUid) : item.studyUid === target)
          && Object.prototype.hasOwnProperty.call(KINDS, item.kind) && STATES.includes(item.state)
          && Number.isSafeInteger(item.revision) && item.revision >= 1 && who(item.requester)
          && !!item.counterparty && typeof item.counterparty === 'object' && text(item.counterparty.text)
          && (item.counterparty.institutionId === null || text(item.counterparty.institutionId)) && text(item.reason)
          && (item.handler === null || who(item.handler)) && (item.note === null || text(item.note))
          && ACTIVE.includes(item.state) === (item.note === null);
      }

      /** #7·#9 응답의 items. 하나라도 틀리면 답 전체를 그리지 않는다. */
      function itemsOf(data, target) {
        const rows = data && data.items;
        if (!Array.isArray(rows) || rows.length > PAGE || !rows.every(row => itemOk(row, target))
            || new Set(rows.map(row => row.id)).size !== rows.length)
          throw new Error(TEXT.malformed);
        return rows;
      }

      /**
       * 쓰기 응답(U4p §3.4)이 보낸 그 쓰기의 적용 결과인가: HTTP 201이고 봉투가 이 requestId·요청·검사·동작, 보낼 때 읽은 종류와
       * 상태(from), 동작의 목적 상태(to), 보낸 revision + 1, 서버가 쓰는 형식의 시각(at). 재전송 답(replayed)도 처음 적용한 그
       * 결과라 지금 요청이 더 진행되었어도 같은 조건이다. 하나라도 어긋나면 저장 결과가 아니라 결과를 모르는 쓰기로 둔다(같은
       * requestId로 Retry).
       */
      function appliedOf(sent, attempt) {
        const answer = sent.data, applied = answer && answer.applied;
        const at = applied && typeof applied.at === 'string' ? new Date(applied.at) : null;
        return sent.status === 201 && !!applied && typeof applied === 'object' && typeof answer.replayed === 'boolean'
          && typeof applied.requestId === 'string' && applied.requestId.toLowerCase() === attempt.requestId
          && applied.id === attempt.id && applied.studyUid === attempt.studyUid && applied.action === attempt.action
          && applied.kind === attempt.kind && applied.from === attempt.from && applied.to === TARGET[attempt.action]
          && applied.revision === attempt.payload.revision + 1
          && !!at && !Number.isNaN(at.getTime()) && at.toISOString() === applied.at;
      }

      /** 요청 한 건의 읽기 전용 줄들: 종류·상태·검사·요청자와 상대 기관·사유·처리자·note. */
      function itemLines(item, withStudy) {
        const head = make('p');
        head.append(badge(item.state), ' ', kindName(item.kind), ` · ${TEXT.meta(time(item.createdAt), person(item.requester))}`);
        const lines = [head];
        if (withStudy) lines.push(line('Study', studyLabel(item.studyUid)));
        const registered = item.counterparty.institutionId === null ? null : institution(item.counterparty.institutionId);
        lines.push(line('Counterparty', item.counterparty.institutionId === null ? item.counterparty.text
          : `${item.counterparty.text} (${TEXT.registered}: ${registered || item.counterparty.institutionId})`));
        lines.push(line('Reason', item.reason));
        if (item.handler) lines.push(line('Handler', person(item.handler)));
        if (item.note !== null) lines.push(line(NOTE_LABEL[item.state] || 'Note', item.note));
        return lines;
      }

      // ── 대기열(Technician 모드) ──
      // 칸은 한 번 만든다: 조건 줄, 목록, 단건과 처리 칸, 잠금 안내.
      const lockBox = stateBox();
      lockBox.id = 'image-request-queue-lock';
      lockBox.dataset.state = 'failed';
      lockBox.setAttribute('role', 'alert');
      const queueView = make('div');
      const filters = make('div', 'image-request-actions');
      const stateLabel = make('label', null, 'State');
      stateLabel.htmlFor = 'image-request-queue-state';
      const stateFilter = make('select');
      stateFilter.id = 'image-request-queue-state';
      for (const [value, label] of FILTERS) {
        const option = make('option', null, label);
        option.value = value;
        stateFilter.append(option);
      }
      const kindLabel = make('label', null, 'Kind');
      kindLabel.htmlFor = 'image-request-queue-kind';
      const kindFilter = make('select');
      kindFilter.id = 'image-request-queue-kind';
      for (const [value, label] of [['', 'All Kinds'], ...Object.entries(KINDS)]) {
        const option = make('option', null, label);
        option.value = value;
        kindFilter.append(option);
      }
      const reload = button('Reload', () => { loadQueue(false); if (detailId !== null) loadDetail(detailId); });
      reload.id = 'image-request-queue-reload';
      filters.append(stateLabel, stateFilter, kindLabel, kindFilter, reload);
      const queueLine = stateBox();
      queueLine.id = 'image-request-queue-status';
      const queueRetry = button('Retry', () => loadQueue(queueItems.length > 0));
      queueRetry.id = 'image-request-queue-retry';
      queueLine.append(queueRetry);
      const queueList = make('ol');
      queueList.id = 'image-request-queue-list';
      const queueMore = button('More', () => loadQueue(true));
      queueMore.id = 'image-request-queue-more';
      const detailBox = make('section');
      detailBox.id = 'image-request-detail';
      detailBox.setAttribute('aria-labelledby', 'image-request-detail-title');
      const detailHead = make('div', 'image-request-actions');
      const detailTitle = make('h4', null, 'Request');
      detailTitle.id = 'image-request-detail-title';
      const detailStatus = make('span');
      detailHead.append(detailTitle, detailStatus);
      const detailLine = stateBox();
      detailLine.dataset.part = 'read';
      const detailRetry = button('Retry', () => { if (detailId !== null) loadDetail(detailId); });
      detailLine.append(detailRetry);
      const detailLines = make('div');
      detailLines.dataset.part = 'lines';
      const noteLabel = make('label', null, 'Note');
      noteLabel.htmlFor = 'image-request-note';
      const noteHint = make('p', 'image-request-muted', TEXT.noteHint);
      noteHint.id = 'image-request-note-hint';
      const noteField = make('textarea');
      noteField.id = 'image-request-note';
      noteField.rows = 2;
      noteField.maxLength = NOTE_MAX;
      noteField.setAttribute('aria-describedby', 'image-request-note-hint');
      noteField.addEventListener('input', () => { if (detailId !== null && !attempts.has(detailId)) drafts.set(detailId, noteField.value); });
      const actions = {};
      const actionRow = make('div', 'image-request-actions');
      for (const [action, label] of [['accept', 'Accept'], ['close', 'Close'], ['decline', 'Decline'], ['cancel', 'Cancel']]) {
        actions[action] = button(label, () => submit(action));
        actions[action].dataset.action = action;
        actionRow.append(actions[action]);
      }
      const retryRow = make('div', 'image-request-actions');
      const writeRetry = button('Retry', () => resend());
      writeRetry.dataset.write = 'retry';
      const writeDiscard = button('Discard', () => drop());
      writeDiscard.dataset.write = 'discard';
      retryRow.append(writeRetry, writeDiscard);
      const writeNote = stateBox();
      writeNote.dataset.part = 'write';
      detailBox.append(detailHead, detailLine, detailLines, noteLabel, noteHint, noteField, actionRow, retryRow, writeNote);
      queueView.append(make('p', 'image-request-muted', TEXT.queueHint), filters, queueLine, queueList, queueMore, detailBox);
      queueBody.append(lockBox, queueView);

      function renderQueue() {
        const unavailable = !ended && lock === null && !allowed();
        lockBox.hidden = !ended && lock === null;
        setState(lockBox, 'failed', ended ? TEXT.ended : lock ? lock.text : '', lock && !ended ? lock.detail : '');
        queueView.hidden = ended || lock !== null;
        const state = unavailable ? 'offline' : queueLoading ? 'loading' : queueFailure ? 'failed' : !queueLoaded ? 'idle'
          : queueItems.length ? 'ready' : 'empty';
        setState(queueLine, state, { offline: TEXT.offline, loading: TEXT.queueLoading, failed: TEXT.queueFailed, empty: TEXT.queueEmpty,
          idle: '' }[state] ?? TEXT.queueReady(queueItems.length, queueCursor !== null), queueFailure ? readDetail(queueFailure) : '');
        queueRetry.hidden = !queueFailure;
        queueMore.hidden = queueCursor === null || queueLoading || !!queueFailure;
        stateFilter.value = queueState;
        kindFilter.value = queueKind;
      }

      function queueItem(item) {
        const li = make('li');
        li.dataset.id = item.id;
        const info = make('div');
        info.dataset.part = 'info';
        info.append(...itemLines(item, true));
        const open = button('Open', () => openDetail(item.id));
        open.dataset.open = '';
        open.title = '이 요청을 읽고 처리 칸을 엽니다.';
        li.append(info, open);
        if (item.id === detailId) li.setAttribute('aria-current', 'true');
        li.dataset.state = item.state;
        return li;
      }

      function renderQueueList() {
        queueList.replaceChildren(...queueItems.map(queueItem));
        queueList.hidden = !queueItems.length;
      }

      /** 연 요청 표시만 제자리에서 바꾼다(목록을 다시 만들면 방금 누른 Open 단추의 포커스가 사라진다). */
      function markCurrent() {
        for (const li of queueList.children) {
          if (li.dataset.id === detailId) li.setAttribute('aria-current', 'true');
          else li.removeAttribute('aria-current');
        }
      }

      /** 단건을 다시 읽으면 대기열의 같은 줄도 그 내용으로 바꾼다(Open 단추는 그대로 둔다). */
      function refreshQueueItem(item) {
        const at = queueItems.findIndex(entry => entry.id === item.id);
        if (at < 0) return;
        queueItems[at] = item;
        const li = [...queueList.children].find(entry => entry.dataset.id === item.id);
        if (!li) return;
        const info = make('div');
        info.dataset.part = 'info';
        info.append(...itemLines(item, true));
        li.querySelector('[data-part="info"]').replaceWith(info);
        li.dataset.state = item.state;
      }

      /** #7 view=queue. 조건을 바꾸거나 다시 읽으면 첫 쪽부터, More는 서버가 준 cursor를 그대로 넘겨 이어 붙인다. */
      async function loadQueue(more) {
        if (ended || lock !== null || !queueRoot.open) return;
        const mine = ++queueSeq, cursor = more ? queueCursor : null;
        if (!more) {
          queueItems = [];
          queueCursor = null;
          queueLoaded = false;
          renderQueueList();
        }
        queueFailure = null;
        if (!allowed()) {
          queueLoading = false;
          renderQueue();
          return;
        }
        queueLoading = true;
        renderQueue();
        const query = `view=queue&state=${encodeURIComponent(queueState)}${queueKind ? `&kind=${encodeURIComponent(queueKind)}` : ''}`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const at = work.capture('document');
        let data;
        try {
          data = await call('GET', `/image-requests?${query}`, undefined, at);
        } catch (error) {
          if (!work.admits(at) || ended || lock !== null || mine !== queueSeq) return;
          queueLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          queueFailure = error;
          renderQueue();
          return;
        }
        if (!work.admits(at) || ended || lock !== null || mine !== queueSeq) return;
        queueLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          const page = itemsOf(data, null), next = data.nextCursor;
          if (!(next === null || (typeof next === 'string' && CURSOR.test(next) && next !== cursor))
              || page.some(item => queueItems.some(seen => seen.id === item.id)))
            throw new Error(TEXT.malformed);
          queueItems = [...queueItems, ...page];
          queueCursor = next;
          queueLoaded = true;
        } catch (error) {
          queueFailure = error;
        }
        renderQueueList();
        renderQueue();
      }

      function openDetail(id) {
        if (ended || lock !== null) return;
        if (detailId !== id) {
          detailId = id;
          detailItem = null;
          detailFailure = null;
          detailSeq++;
        }
        markCurrent();
        loadDetail(id);
      }

      /** #8. 연 요청 한 건. 늦은 답은 번호와 연 요청 id로 버린다. */
      async function loadDetail(id) {
        if (ended || lock !== null || detailId !== id) return;
        const mine = ++detailSeq;
        detailLoading = true;
        detailFailure = null;
        renderDetail();
        const at = work.capture('document');
        let data;
        try {
          data = await call('GET', `/image-requests/${encodeURIComponent(id)}`, undefined, at);
        } catch (error) {
          if (!work.admits(at) || ended || lock !== null || mine !== detailSeq || detailId !== id) return;
          detailLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          detailItem = null;
          detailFailure = error;
          renderDetail();
          return;
        }
        if (!work.admits(at) || ended || lock !== null || mine !== detailSeq || detailId !== id) return;
        detailLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null || !itemOk(data.item, null) || data.item.id !== id) throw new Error(TEXT.malformed);
          detailItem = data.item;
          refreshQueueItem(detailItem);
          checkOwn(detailItem);
        } catch (error) {
          detailItem = null;
          detailFailure = error;
        }
        renderDetail();
      }

      function loadedDetail() {
        return !detailFailure && detailItem !== null && detailItem.id === detailId ? detailItem : null;
      }

      /**
       * 이 요청의 Cancel 안내(U4p §5.2·RM-R7): 관리자이거나, clinician 역할이 있고 이 요청을 남긴 본인일 때만. 역할만 보면
       * 기관 전체 요청을 읽는 혼합 역할(clinician+radiologist 등)에게 남의 요청 취소가 열린다. 본인인지는 서버가 요청자 sub로 고른
       * #7 view=mine에 그 id가 있는지로만 정한다(ownIds) — requester.actor는 email 등이 바뀌면 같은 사람의 것이 달라지고 다른
       * 계정의 값과 겹칠 수 있다. 확인 중이거나 확인하지 못했으면 닫는다. 판정은 서버가 sub로 다시 한다.
       */
      function canCancel(item) {
        return can('admin') || (can('clinician') && !!item && ownIds.get(item.id) === true);
      }

      /** 닫힌 Cancel의 이유: 역할·타인의 요청, 확인 중, 확인 실패(Reload로 다시 확인). */
      function cancelHint(item) {
        if (canCancel(item)) return '';
        const reading = item ? ownReads.get(item.id) : undefined;
        if (!can('clinician') || !item || ownIds.has(item.id)) return TEXT.roleCancel;
        if (reading === 'checking') return TEXT.ownChecking;
        return reading ? `${TEXT.ownFailed}\n${describe(reading)}` : TEXT.roleCancel;
      }

      /**
       * #7 view=mine(state=all)을 필요한 쪽까지 읽어 targets 각각이 이 계정의 요청인지 정한다(true·false). 목록은 생성 시각이 늦은
       * 것부터라, 한 쪽의 마지막 행이 남은 요청보다 확실히 이르거나 다음 쪽이 없으면 남은 요청은 이 계정의 것이 아니다. 요청자는
       * 요청이 생긴 뒤 바뀌지 않으므로 한 번 정한 값은 이 문서(같은 계정) 안에서 그대로다. OWN_PAGES 쪽을 넘기면 오류로 둔다.
       * live()가 거짓이 되면(세션 종료·잠금) null이다.
       */
      async function readOwn(targets, live, at) {
        const left = new Map(targets.map(item => [item.id, Date.parse(item.createdAt)])), found = new Map();
        let cursor = null;
        for (let page = 0; left.size && page < OWN_PAGES; page++) {
          const query = 'view=mine&state=all' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
          const data = await call('GET', `/image-requests?${query}`, undefined, at);
          if (!live()) return null;
          const same = ownerOf(data);
          if (same === false) {
            accountChanged('');
            return null;
          }
          if (same === null) throw new Error(TEXT.malformed);
          const rows = itemsOf(data, null), next = data.nextCursor;
          if (!(next === null || (typeof next === 'string' && CURSOR.test(next) && next !== cursor))) throw new Error(TEXT.malformed);
          for (const row of rows) if (left.delete(row.id)) found.set(row.id, true);
          const last = rows.length ? Date.parse(rows[rows.length - 1].createdAt) : NaN;
          for (const [id, at] of left) {
            if (next !== null && !(last < at)) continue;
            left.delete(id);
            found.set(id, false);
          }
          cursor = next;
        }
        if (left.size) throw new Error(TEXT.ownTooMany);
        return found;
      }

      /**
       * 연 요청이 처리 중이고 이 계정이 관리자가 아닌 clinician이면 본인 요청인지 확인한다(관리자는 누구의 요청이든 취소할 수
       * 있고, clinician이 아니면 요청자일 수 없다). 403은 서버가 이 계정에 요청자 범위를 주지 않은 것이라 본인 요청이 아니다.
       * 그 밖의 실패는 확인 실패로 남겨 Cancel을 닫고, Reload(단건 다시 읽기)가 다시 확인한다.
       */
      async function checkOwn(item) {
        if (ended || lock !== null || can('admin') || !can('clinician') || !ACTIVE.includes(item.state) || ownIds.has(item.id)
            || ownReads.get(item.id) === 'checking') return;
        const at = work.capture('document');
        const live = () => work.admits(at) && !ended && lock === null;
        ownReads.set(item.id, 'checking');
        paintComposer();
        let found = null, failure = null;
        try {
          found = await readOwn([item], live, at);
        } catch (error) {
          failure = error;
        }
        // 이 확인이 건 "확인 중" 표시는 이 확인이 푼다(자기 것만). 그리는 것은 문맥이 그대로일 때만 한다.
        if (!live()) { if (ownReads.get(item.id) === 'checking') ownReads.delete(item.id); return; }
        if (failure && failure.auth) return;
        ownReads.delete(item.id);
        if (failure && failure.status === 403) found = new Map([[item.id, false]]);
        else if (failure) ownReads.set(item.id, failure);
        if (found) for (const [id, own] of found) ownIds.set(id, own);
        paintComposer();
      }

      function renderDetail() {
        detailBox.hidden = detailId === null;
        if (detailId === null) return;
        const loaded = loadedDetail();
        detailBox.dataset.id = detailId;
        detailBox.dataset.state = loaded ? loaded.state : detailFailure ? 'failed' : 'loading';
        detailStatus.replaceChildren(...(loaded ? [badge(loaded.state)] : []));
        const state = detailFailure ? 'failed' : detailLoading || !loaded ? 'loading' : 'ready';
        setState(detailLine, state, { failed: TEXT.detailFailed, loading: TEXT.detailLoading }[state] || '',
          detailFailure ? readDetail(detailFailure) : '');
        detailLine.hidden = state === 'ready';
        detailRetry.hidden = !detailFailure;
        detailLines.replaceChildren(...(loaded ? itemLines(loaded, true) : []));
        paintComposer();
      }

      /**
       * 처리 칸의 모양은 맵(쓰던 note·결과를 모르는 쓰기)과 마지막으로 읽은 그 요청에서만 정한다. 결과를 모르는 쓰기가 있는 동안
       * note는 바꿀 수 없고 Retry(같은 requestId)와 Discard만 있다 — 고쳐 새로 보내면 같은 처리가 두 번 기록될 수 있다.
       */
      function paintComposer() {
        const id = detailId, attempt = id === null ? null : attempts.get(id) || null, loaded = loadedDetail();
        detailBox.dataset.write = !attempt ? 'idle' : attempt.busy ? 'busy' : 'unknown';
        const value = attempt ? attempt.text : id === null ? '' : drafts.get(id) || '';
        // 같은 글이면 쓰지 않는다: 값을 다시 넣으면 치고 있던 커서·한글 조합이 끊긴다.
        if (noteField.value !== value) noteField.value = value;
        noteField.readOnly = attempt !== null;
        const staff = can('technician'), cancel = cancelHint(loaded);
        const state = loaded ? loaded.state : null;
        for (const [action, control] of Object.entries(actions)) {
          const role = action === 'cancel' ? cancel : staff ? '' : TEXT.roleStaff;
          const stale = !loaded ? '' : action === 'accept' ? (state === 'Requested' ? '' : TEXT.stateAccept)
            : ACTIVE.includes(state) ? '' : TEXT.stateDone;
          control.disabled = attempt !== null || !loaded || !!role || !!stale;
          control.title = role || stale || TEXT.tips[action];
        }
        writeRetry.hidden = writeDiscard.hidden = !attempt || attempt.busy;
        const note = id === null ? null : notes.get(id) || null;
        writeNote.hidden = note === null;
        setState(writeNote, note ? note.state : 'idle', note ? note.text : '', note ? note.detail : '');
      }

      function setNote(id, state, text, detail) {
        notes.set(id, { state, text, detail: detail || '' });
        if (id === detailId) paintComposer();
      }

      /** 새 쓰기: 새 requestId(UUID v4), 이 화면의 계정([기관, sub]), 마지막으로 읽은 그 요청의 revision. Accept는 빈 note다. */
      function submit(action) {
        const id = detailId, loaded = loadedDetail(), who = owner();
        if (ended || lock !== null || id === null || !loaded || attempts.has(id) || !who) return;
        if (action === 'cancel' && !canCancel(loaded)) return;
        const text = noteField.value, note = action === 'accept' ? '' : text;
        if (action !== 'accept' && (!note.trim() || note.length > NOTE_MAX)) {
          setNote(id, 'failed', TEXT.noNote);
          return;
        }
        let requestId;
        try {
          requestId = newRequestId();
        } catch (_) {
          setNote(id, 'failed', TEXT.noRequestId);
          return;
        }
        // kind·from은 보낼 때 읽은 그 요청의 값이다. 적용 결과가 이 둘과 맞아야 저장 결과로 받는다(appliedOf).
        const attempt = { requestId, owner: who, id, studyUid: loaded.studyUid, kind: loaded.kind, from: loaded.state, action, text,
          busy: false, unknown: false, payload: { revision: loaded.revision, action, note } };
        drafts.set(id, text);
        attempts.set(id, attempt);
        transmit(attempt);
      }

      /** 결과를 모르는 쓰기만 같은 requestId·같은 본문으로 다시 보낸다. 이미 적용되었으면 서버가 저장한 결과를 돌려준다. */
      function resend() {
        const attempt = detailId === null ? null : attempts.get(detailId);
        if (ended || lock !== null || !attempt || attempt.busy || !attempt.unknown) return;
        transmit(attempt);
      }

      /** 결과를 모르는 쓰기를 버린다. note는 칸에 남기고, 저장되었는지는 다시 읽은 요청으로 보인다. */
      function drop() {
        const attempt = detailId === null ? null : attempts.get(detailId);
        if (ended || !attempt || attempt.busy) return;
        attempts.delete(attempt.id);
        drafts.set(attempt.id, attempt.text);
        setNote(attempt.id, 'discarded', TEXT.discarded);
        afterWrite(attempt);
      }

      async function transmit(attempt) {
        attempt.busy = true;
        attempt.unknown = false;
        setNote(attempt.id, 'busy', TEXT.sending);
        const at = work.capture('document');
        let sent = null, error = null;
        try {
          sent = await post(`/image-requests/${encodeURIComponent(attempt.id)}`,
            { requestId: attempt.requestId, expectedOwner: attempt.owner, ...attempt.payload }, at);
        } catch (caught) {
          error = caught;
        }
        // 세션이 끝났거나 잠겨 맵을 비웠으면 이 결과는 어디에도 쓰지 않는다.
        if (ended || attempts.get(attempt.id) !== attempt) return;
        // 로그아웃 준비·그 취소 뒤에 온 답은 저장 결과로 그리지 않는다. 그 쓰기는 결과를 모르는 것으로 남아 같은 요청 ID의
        // Retry가 서버의 결과를 확인한다(보낸 것을 잊지 않는다).
        if (!work.admits(at)) {
          attempt.busy = false;
          attempt.unknown = true;
          notes.set(attempt.id, { state: 'unknown', text: TEXT.unknown, detail: '' });
          return;
        }
        attempt.busy = false;
        if (error) {
          writeFailed(attempt, error);
          return;
        }
        const same = ownerOf(sent.data);
        if (same === false) {
          accountChanged('');
          return;
        }
        // 201이 아닌 성공 상태는 적용 결과가 아니다. 그 상태를 자세한 줄에 보이고 같은 requestId의 Retry·Discard를 남긴다.
        if (same === null || !appliedOf(sent, attempt)) {
          attempt.unknown = true;
          setNote(attempt.id, 'unknown', TEXT.writeMalformed, sent.status === 201 ? '' : `HTTP ${sent.status}`);
          return;
        }
        attempts.delete(attempt.id);
        // Accept는 note를 보내지 않았으니 쓰던 note는 다음 처리(Close 등)를 위해 남긴다.
        if (attempt.action !== 'accept') drafts.delete(attempt.id);
        setNote(attempt.id, 'saved', sent.data.replayed ? TEXT.replayed : TEXT.saved[attempt.action]);
        afterWrite(attempt);
      }

      /**
       * 쓰기 실패. 연결 실패·제한 시간·5xx·IMAGE_REQUEST_BUSY·STUDY_ACCESS_CHANGED(커밋 뒤 최종 확인일 수 있다)는 적용 여부를 모르는
       * 결과라 Retry(같은 requestId)를 남긴다. 그 밖의 거절은 쓰기를 버리고 note는 칸에 둔다. OWNER_CHANGED는 계정이 바뀐 것이다.
       */
      function writeFailed(attempt, error) {
        if (error.auth) return;
        if (error.code === 'OWNER_CHANGED') {
          accountChanged(describe(error));
          return;
        }
        if (error.status === 0 || error.status >= 500 || error.code === 'STUDY_ACCESS_CHANGED') {
          attempt.unknown = true;
          setNote(attempt.id, 'unknown', TEXT.codes[error.code] || TEXT.unknown, describe(error));
          return;
        }
        attempts.delete(attempt.id);
        setNote(attempt.id, 'failed', TEXT.codes[error.code] || (error.status === 404 ? TEXT.notFound : TEXT.statuses[error.status])
          || TEXT.rejected, describe(error));
        // 요청이 바뀌었거나 끝났거나 보이지 않게 되었으면 지금 서버 상태를 다시 읽는다(note는 칸에 남는다).
        if (error.status === 404 || error.status === 409) afterWrite(attempt);
      }

      /** 화면은 쓰기 응답(적용 결과)이 아니라 읽기 route로 다시 읽은 현재 상태로만 그린다: 그 요청, 대기열 첫 쪽, 같은 검사의 판독 쪽 줄. */
      function afterWrite(attempt) {
        if (ended || lock !== null) return;
        if (detailId === attempt.id) loadDetail(attempt.id);
        else paintComposer();
        if (queueRoot.open) loadQueue(false);
        if (readUid !== null && readUid === attempt.studyUid) loadReading();
      }

      // ── 판독 화면(읽기 전용) ──
      const readLine = stateBox();
      readLine.id = 'image-request-read-status';
      const readRetry = button('Retry', () => loadReading());
      readLine.append(readRetry);
      const readList = make('ol');
      readList.id = 'image-request-read-list';
      readPane.append(make('p', 'image-request-muted', TEXT.readHint), readLine, readList);
      // 접힌 줄에도 Closed 옆 문구가 보여야 한다(U4p §3.3). 요약은 말줄임으로 잘리므로 그 안에 두지 않고 바로 아래에 줄을 넘기는
      // 한 줄로 둔다 — Closed가 있을 때만 서므로 Closed 없는 검사의 판독 화면 배치는 그대로다.
      const readClosed = make('p', 'image-request-closed-line');
      readClosed.dataset.part = 'closed';
      readClosed.append(badge('Closed'));
      readRoot.insertBefore(readClosed, readPane);

      function readCounts(items) {
        return STATES.map(state => [state, items.filter(item => item.state === state).length]).filter(([, n]) => n)
          .map(([state, n]) => `${state} ${n}`).join(' · ');
      }

      /** 줄은 요청이 있거나 읽기가 실패했거나 잠긴 동안만 보인다 — 요청 없는 검사의 판독 화면 배치를 바꾸지 않는다. */
      function renderReading() {
        const visible = !ended && (lock !== null || readFailure !== null || (readItems !== null && readItems.length > 0));
        readRoot.hidden = !visible;
        readRoot.dataset.state = ended ? 'ended' : lock ? 'locked' : readFailure ? 'failed' : readLoading ? 'loading'
          : readItems === null ? 'idle' : readItems.length ? 'ready' : 'empty';
        const text = lock ? lock.text : readFailure ? TEXT.readFailed : readItems && readItems.length
          ? TEXT.readCounts(readItems.length, readCounts(readItems)) : TEXT.readLoading;
        readSummary.textContent = text;
        readSummary.title = lock ? `${lock.text}\n${lock.detail}`.trim() : readFailure ? readDetail(readFailure) : text;
        readClosed.hidden = !!lock || !!readFailure || !readItems || !readItems.some(item => item.state === 'Closed');
        readToggle.hidden = lock !== null;
        readToggle.textContent = readOpen ? 'Hide Requests' : 'Show Requests';
        readToggle.setAttribute('aria-expanded', String(readOpen && lock === null));
        readPane.hidden = !readOpen || lock !== null;
        const state = readFailure ? 'failed' : readLoading ? 'loading' : 'ready';
        setState(readLine, state, { failed: TEXT.readFailed, loading: TEXT.readLoading }[state] || '',
          readFailure ? readDetail(readFailure) : '');
        readLine.hidden = state === 'ready';
        readRetry.hidden = !readFailure;
        readList.replaceChildren(...(readFailure || !readItems ? [] : readItems).map(item => {
          const li = make('li');
          li.dataset.id = item.id;
          li.dataset.state = item.state;
          li.append(...itemLines(item, false));
          return li;
        }));
        readList.hidden = !readList.children.length;
      }

      /** #9. 판독 대상 검사의 요청(최신 50). 늦은 답은 번호와 대상 검사로 버린다. */
      async function loadReading() {
        if (ended || lock !== null || readUid === null) return;
        const target = readUid, mine = ++readSeq;
        readLoading = true;
        readFailure = null;
        renderReading();
        const at = work.capture('document');
        let data;
        try {
          data = await call('GET', `/studies/${encodeURIComponent(target)}/image-requests`, undefined, at);
        } catch (error) {
          if (!work.admits(at) || ended || lock !== null || mine !== readSeq || target !== readUid) return;
          readLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          readItems = null;
          readFailure = error;
          renderReading();
          return;
        }
        if (!work.admits(at) || ended || lock !== null || mine !== readSeq || target !== readUid) return;
        readLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          readItems = itemsOf(data, target);
        } catch (error) {
          readItems = null;
          readFailure = error;
        }
        renderReading();
      }

      /**
       * renderClinical()이 부른다(선택·목록 갱신·관련 검사 보기마다). 판독 대상이 바뀐 때만 이전 대상의 줄을 내리고 새 대상을
       * 읽는다 — 같은 대상이면 요청도 그리기도 없다. refreshRight()에 두지 않는다: report_* 시험은 select()·refreshRight()를
       * 잘라 그대로 돌리고 renderClinical()만 비워 두므로, 거기서 선언되지 않은 이름은 ReferenceError가 된다.
       * 원격판독으로 받은 검사는 읽지 않는다: 요청은 소유 기관 안에서만 오가고(U4p T-4) 늘 404다.
       */
      function sync() {
        if (ended) return;
        const target = allowed() ? current() : null;
        const row = target ? study(target) : null;
        const next = row && row.tele !== true ? target : null;
        if (next === readUid) return;
        readUid = next;
        readSeq++;
        readItems = null;
        readFailure = null;
        readLoading = false;
        renderReading();
        if (readUid !== null && lock === null) loadReading();
      }

      /**
       * 확인된 계정 변경(다른 계정의 봉투 owner·OWNER_CHANGED)은 이 칸만의 일이 아니다. 이 칸을 잠그고 notifyAccountChanged로 onCommonEnd 구독자에게
       * 사유 'account-changed'로 알려, 네트워크를 기다리기 전에 같은 페이지의 다른 영역(S5-U4b 질문 줄)도
       * 쓰던 글·결과를 모르는 요청·읽기/쓰기 번호를 버리게 한다 — 이 칸만 잠그면 다른 영역에 이전 계정의 글과 Retry가 남고 나가
       * 있던 쓰기의 늦은 영수증이 저장 결과로 그려진다(Astra S5-U4bc-R-001 F01). 한 요청·검사의 읽기를 서버가 403으로 거절한 것은
       * 계정 변경이 아니라서 lockPanel로 이 칸만 잠근다.
       */
      function accountChanged(detail) {
        lockPanel(TEXT.ownerChanged, detail, true);
        notifyAccountChanged(detail);
      }

      /**
       * 서버가 읽기를 거절했거나(403) 계정이 바뀌었다(accountChanged, 이 칸이나 다른 영역이 알아챘다). 이 문서에서는 요청을 더
       * 읽거나 쓰지 않고 진행 중인 요청의 답도 그리지 않는다(뷰어 세션의 거절·계정 변경과 같은 한 방향). 쓰던 note는 이전 계정의
       * 것이라 버린다. 403으로 이미 잠긴 뒤 계정 변경을 알면(account) 그 까닭으로 바꿔 쓴다.
       */
      function lockPanel(text, detail, account = false) {
        if (ended || (lock !== null && (lock.account || !account))) return;
        lock = { text, detail: detail || '', account };
        queueSeq++;
        detailSeq++;
        readSeq++;
        drafts.clear();
        attempts.clear();
        notes.clear();
        ownIds.clear();
        ownReads.clear();
        noteField.value = '';
        queueItems = [];
        queueCursor = null;
        queueLoading = false;
        queueFailure = null;
        detailId = null;
        detailItem = null;
        detailFailure = null;
        detailLoading = false;
        readItems = null;
        readFailure = null;
        readLoading = false;
        renderQueueList();
        renderQueue();
        renderDetail();
        renderReading();
      }

      /**
       * 세션 관문이 실제 종료를 알렸다(명시적 로그아웃·같은 세션의 종료 통지·서버의 종료 코드). 두 칸을 내리고 쓰던 note를 버리며 나간 요청의 답은 어디에도 그리지 않는다. 공통 목록이
       * 사유 'account-changed'로 부르면 세션은 그대로이고 계정이 바뀐 것이라 잠근다(accountChanged).
       */
      function end(reason, detail) {
        if (reason === 'account-changed') {
          lockPanel(TEXT.ownerChanged, detail, true);
          return;
        }
        if (ended) return;
        ended = true;
        queueSeq++;
        detailSeq++;
        readSeq++;
        drafts.clear();
        attempts.clear();
        notes.clear();
        ownIds.clear();
        ownReads.clear();
        // 숨긴 칸에도 이전 계정이 치던 글을 남기지 않는다.
        noteField.value = '';
        queueItems = [];
        queueCursor = null;
        detailId = null;
        detailItem = null;
        readUid = null;
        readItems = null;
        readFailure = null;
        renderQueueList();
        renderQueue();
        renderDetail();
        renderReading();
      }

      /**
       * 로그아웃 준비에서 편집으로 돌아왔다. 준비가 끊은 읽기는 답을 쓰지 않고 끝났으므로, 그 읽기가 건 대기 표시를 풀고
       * 지금 문맥에서 다시 읽는다. 결과를 모르는 쓰기는 그대로 남는다(사람이 Retry·Discard를 고른다).
       */
      function resume() {
        if (ended || lock !== null) return;
        queueLoading = detailLoading = readLoading = false;
        if (queueRoot.open) { loadQueue(false); if (detailId !== null) loadDetail(detailId); }
        else { renderQueue(); renderDetail(); }
        if (readUid !== null) loadReading(); else renderReading();
        paintComposer();
      }

      queueRoot.addEventListener('toggle', () => {
        if (ended) return;
        if (!queueRoot.open) {
          // 닫으면 나간 읽기의 답을 버린다. 다시 열면 처음부터 읽는다.
          queueSeq++;
          detailSeq++;
          queueLoading = false;
          detailLoading = false;
          return;
        }
        renderQueue();
        renderDetail();
        if (lock !== null) return;
        loadQueue(false);
        if (detailId !== null) loadDetail(detailId);
      });
      stateFilter.addEventListener('change', () => { queueState = stateFilter.value; loadQueue(false); });
      kindFilter.addEventListener('change', () => { queueKind = kindFilter.value; loadQueue(false); });
      readToggle.addEventListener('click', () => {
        if (ended || lock !== null) return;
        readOpen = !readOpen;
        renderReading();
      });
      window.addEventListener('pagehide', end);
      // 이 문서의 세션이 끝나면(Log out, 요청의 401, 다른 문서의 종료) 세션 종료 조정이 네트워크를 기다리기 전에 동기로 부르는
      // 목록이다. 칸마다 자기 end()를 넣는다(S5-U4b 등도 같은 목록). 한 영역이 알아챈 계정 변경도 이 목록으로 사유
      // 'account-changed'와 함께 온다(accountChanged). 어느 로그인의 종료인지는 auth.js가 대조한다 — 이 칸은 통지 채널을
      // 따로 듣지 않는다.
      onCommonEnd(end);
      renderQueueList();
      renderQueue();
      renderDetail();
      renderReading();
      return { sync, end, resume };
    }
    let imageRequests = null;
    try {
      imageRequests = mountImageRequests({ api, apiBase: API, work, transport,
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; },
        allowed: () => !!sess && serverMode && !demoMode && !offline,
        current: () => selectedUid, study: uid => studies.find(s => s.uid === uid) || null,
        institution: id => institutions.find(i => i.id === id)?.name || null, can: role => KinAuth.has(role) });
    } catch (_) { toast('영상 요청 칸을 준비하지 못했습니다. 판독·검사 작업은 계속할 수 있습니다.', 'err'); }