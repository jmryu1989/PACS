

    // ── 임상의 질문 답변(S5-U4b) ──
    // REQ-S5-U4b-QUESTION-UI → RISK-S5-U4b-STALE → TEST-S5-U4b-DOM (tests/clinician_question_dom_test.py가 이 절을 잘라 실행한다).
    // 판독 대상 검사(selectedUid)의 임상의 질문을 서버 S5-U4a route로 읽고(#3 검사별·#2 스레드·#1 view=inbox) 답변(#5)과
    // 사유 있는 닫기(#6)를 쓴다. consultation 창·요청과 섞지 않는다. 판독문 칸·버튼 줄 밖의 줄이며 판독문을 읽거나 쓰지 않는다.
    // 역할로 쓰기 컨트롤을 숨기지 않는다 — 관리자 답변 403처럼 서버 거절을 그대로 보인다. 읽기는 판독의·관리자 세션에서만 시작한다.
    // 줄은 질문이 있거나 읽기가 실패했거나 사용자가 창을 연 동안만 보인다: 질문 없는 검사의 판독 화면 배치를 바꾸지 않는다.
    // 원격판독으로 받은 검사는 읽지 않는다 — 질문은 소유 기관 안에서만 오가고(OQ-1 a) 수신 기관의 읽기는 늘 404다.
    // 검사를 바꾸면 이전 검사의 스레드를 내린다. 쓰던 글은 검사·스레드별로 이 문서의 메모리에만 두어 그 스레드에서만 다시 보인다.
    // 요청은 api()가 아니라 이 절의 call()로 보낸다 — 401에서 이 줄을 로그아웃 POST보다 먼저 끝내야 한다(call·expire).
    // Module teardown follows the page work-context lifecycle.
    // api()의 401, 확정한 Log out, 받아쓰기의 401, 목록의 계정 변경, 이 절의 401(expire) — 은 로그아웃 POST·초안 저장 같은
    // 네트워크 대기 전에 그 목록을 동기로 부른다. auth.js의 session-ended 방송은 그 POST가 끝난 뒤라 기다리지 않는다.
    // 한 영역이 알아챈 계정 변경(다른 계정의 봉투·OWNER_CHANGED)은 같은 목록에 사유 'account-changed'로 알려 두 영역을 함께 잠근다.
    function mountStudyQuestions({ apiBase, work, transport, current, study, openStudy, allowed, owner }) {
      const root = $('#question-p'), summary = $('#question-summary'), toggle = $('#question-toggle');
      const inboxButton = $('#question-inbox'), pane = $('#question-pane');
      const TEXT = {
        loading: '이 검사의 질문을 불러오는 중입니다…',
        failed: '이 검사의 질문을 불러오지 못했습니다.',
        empty: '이 검사에는 질문이 없습니다.',
        none: '판독 대상 검사를 고르면 그 검사의 질문을 표시합니다.',
        counts: (n, open, answered, closed) => `이 검사의 질문 ${n}건 · Open ${open} · Answered ${answered} · Closed ${closed}`,
        ready: n => `이 검사의 질문 ${n}건을 최신순으로 표시합니다.`,
        malformed: '질문 응답 형식을 확인할 수 없습니다. 다시 불러오세요.',
        notFound: '검사나 질문을 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다.',
        item: (created, name, count, last) => `${created} 등록 · ${name} · 항목 ${count}개 · 최근 ${last}`,
        threadLoading: '질문 스레드를 불러오는 중입니다…',
        threadFailed: '질문 스레드를 불러오지 못했습니다.',
        otherStudy: '이 질문은 판독 대상 검사의 질문이 아니어서 열지 않았습니다. Inbox를 다시 불러오세요.',
        threadMeta: (created, name) => `${created} 등록 · 질문 ${name}`,
        closedNote: '닫힌 질문입니다. 새 답변·닫기는 서버가 거절합니다.',
        anchorChanged: '답변 이후 판독 상태가 바뀌었습니다.',
        anchorDetail: (then, now) => `답변 때 ${then} → 지금 ${now}`,
        closeEmpty: '사유 없이 닫았습니다.',
        nonFinal: '확정 전 소견을 적으면 임상의에게 그대로 보입니다.',
        replyHint: '질문한 임상의가 이 스레드에서 그대로 읽습니다. 답변은 판독문에 들어가지 않습니다.',
        closeHint: '작성자가 아닌 사람이 닫을 때는 사유가 필요합니다. 닫은 질문에는 더 쓸 수 없습니다.',
        inboxHint: '소속 기관 검사에 남은 임상의 질문입니다. Open Study는 그 검사를 판독 대상으로 엽니다.',
        inboxLoading: '받은 질문을 불러오는 중입니다…',
        inboxFailed: '받은 질문을 불러오지 못했습니다.',
        inboxEmpty: '이 조건의 질문이 없습니다.',
        inboxReady: (n, more) => `질문 ${n}건을 최신순으로 표시합니다.${more ? ' More로 이어서 읽습니다.' : ''}`,
        notListed: '이 검사는 지금 워크리스트에 없어 열 수 없습니다. 목록을 새로고침하거나 검색 조건을 바꾸세요.',
        unlisted: '워크리스트에 없는 검사',
        noText: '1~2,000자의 내용을 입력하세요.',
        sending: '보내는 중입니다…',
        saved: '저장했습니다.',
        replayed: '이미 저장된 요청입니다. 서버가 처음 저장한 결과를 돌려주었습니다.',
        discarded: '보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 스레드에서 확인하세요.',
        writeMalformed: '저장 응답의 형식을 확인할 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인합니다.',
        noRequestId: '요청 ID를 만들지 못해 보내지 않았습니다.',
        unknown: '저장되었는지 알 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인하고, Discard는 이 요청을 버립니다.',
        refused: '서버가 이 계정의 질문 읽기를 거절했습니다. 권한이 바뀌었다면 화면을 다시 불러오세요.',
        ownerChanged: '로그인한 계정이 바뀌었습니다. 이 화면에서는 질문을 더 읽거나 쓰지 않습니다. 화면을 다시 불러오세요.',
        rejected: '서버가 요청을 거절했습니다.',
        expired: '세션이 만료되었습니다. 다시 로그인하세요.',
        noResponse: '응답이 없어 요청을 멈췄습니다.',
        noServer: '서버에 연결하지 못했습니다.',
        codes: {
          QUESTION_CHANGED: '그사이 이 질문이 바뀌었습니다. 스레드를 다시 불러왔으니 내용을 확인한 뒤 다시 보내세요.',
          QUESTION_CLOSED: '이미 닫힌 질문이라 더 쓸 수 없습니다.',
          QUESTION_STATE: '지금 질문 상태에서는 할 수 없는 동작입니다.',
          QUESTION_ENTRY_LIMIT: '이 스레드의 항목 수가 상한에 도달했습니다.',
          REQUEST_ID_REUSED: '같은 요청 ID가 다른 내용에 이미 쓰였습니다. 다시 불러온 뒤 새로 보내세요.',
          QUESTION_BUSY: '서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.',
          STUDY_ACCESS_CHANGED: '요청 중 검사 접근 조건이 바뀌었습니다. 저장되었을 수 있으니 Retry로 같은 요청을 다시 보내 확인하세요.',
        },
        statuses: { 400: '서버가 입력을 거절했습니다.', 403: '서버가 이 동작을 거절했습니다.' },
      };
      const STATES = ['Open', 'Answered', 'Closed'];
      const KINDS = { question: 'Question', followup: 'Follow-up', answer: 'Answer', close: 'Close' };
      const ROLES = { clinician: 'Clinician', radiologist: 'Radiologist', admin: 'Admin' };
      const REPORT = { W: 'Awaiting Report', T: 'In Progress', P: 'Preliminary', A: 'Approved', H: 'On Hold' };
      // 계약 §5.1 전이표(이 화면이 쓰는 동작만). 쓰기 응답의 action마다 항목 종류·가능한 이전 상태·다음 상태가 하나다.
      const STEPS = {
        answer: { kind: 'answer', from: ['Open', 'Answered'], to: 'Answered' },
        followup: { kind: 'followup', from: ['Open', 'Answered'], to: 'Open' },
        close: { kind: 'close', from: ['Open', 'Answered'], to: 'Closed' },
      };
      // 쓰는 칸마다 서버가 고를 수 있는 action. Reply는 작성자면 followup, 아니면 answer다(서버가 정한다).
      const ACTIONS = { reply: ['answer', 'followup'], close: ['close'] };
      const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const STUDY = /^\d+(?:\.\d+)+$/;
      const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
      const TIMEOUT_MS = 60000, TEXT_MAX = 2000;
      let ended = false, lock = null;
      // 나가 있는 질문 요청. 세션이 끝나면(end) 모두 멈춘다 — 답은 번호로도 버려지지만 끝난 세션의 응답을 기다리지 않는다.
      const inflight = new Set();
      // uid는 지금 읽는 판독 대상. epoch는 대상이 바뀌거나 잠길 때마다 오르고, 읽기마다 자기 번호와 함께 들고 떠난다.
      let uid = null, epoch = 0, listSeq = 0, threadSeq = 0, inboxSeq = 0;
      let items = null, listFailure = null, listLoading = false;
      let mode = null, threadId = null, thread = null, threadFailure = null, threadLoading = false, pendingThread = null;
      let inboxState = 'open', inboxItems = [], inboxCursor = null, inboxFailure = null, inboxLoading = false;
      // 검사·스레드·동작별로 쓰던 글, 결과를 모르는 요청(같은 requestId로 다시 보낼 것), 스레드별 마지막 결과 문구.
      const drafts = new Map(), attempts = new Map(), notes = new Map();
      const fresh = (era, target) => !ended && lock === null && era === epoch && target === uid;
      const keyOf = (target, id, action) => `${target}\n${id}\n${action}`;
      const noteOf = (target, id) => `${target}\n${id}`;
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
      const stateBox = id => {
        const box = make('div', 'question-state');
        box.id = id;
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.append(make('p', 'question-text'), make('p', 'question-detail'));
        return box;
      };
      const setState = (box, state, text, detail) => {
        box.dataset.state = state;
        box.querySelector('.question-text').textContent = text;
        box.querySelector('.question-detail').textContent = detail || '';
      };
      const dash = value => typeof value === 'string' && value.trim() ? value : '—';
      const person = value => dash(value && (value.name || value.actor));
      const badge = state => {
        const node = make('span', 'question-status', state);
        node.dataset.state = state;
        return node;
      };
      const time = value => {
        const date = typeof value === 'string' ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '—';
        const two = part => String(part).padStart(2, '0');
        return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
      };
      const reportText = anchor => {
        const name = REPORT[anchor.rs] || `RS ${anchor.rs}`;
        return anchor.version === null ? name : `${name} · Version ${anchor.version}`;
      };
      const describe = error => {
        const parts = [];
        if (error && error.status) parts.push(`HTTP ${error.status}`);
        if (error && error.code) parts.push(error.code);
        const message = error && error.message ? error.message : TEXT.rejected;
        return parts.length ? `${message} (${parts.join(' · ')})` : message;
      };
      const readDetail = error => `${error && error.status === 404 ? `${TEXT.notFound}\n` : ''}${describe(error)}`;

      /** 응답의 owner가 이 화면의 계정인가. 다르면 false(다른 계정의 답), 모양이 틀리면 null(형식 오류)이다. */
      function ownerOf(data) {
        const value = data && data.owner, mine = owner();
        if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null;
        return !!mine && value[0] === mine[0] && value[1] === mine[1];
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

      /**
       * 질문 route 요청(제한 시간 60초). 이 문서의 전송으로 보낸다: 부르는 순간의 작업 문맥으로 승인받고 그 세션의 식별값을
       * 싣는다. 쓰기는 HTTP 상태가 필요해 성공 응답을 상태와 함께 돌려준다 — 201만 적용 결과다(appliedOf). 401은 전송이 그
       * 요청의 세션으로 auth.js에 알리고, 이 줄은 세션 종료 조정이 부르는 end()로 닫힌다(여기서 로그아웃을 부르지 않는다).
       * 연결 실패·제한 시간·세션 종료로 멈춘 요청은 status 0이다 — 쓰기라면 서버가 적용했는지 모르는 결과다. 답이 왔을 때 그
       * 문맥이 무효이면(로그아웃 준비·그 취소) `stale`을 단 status 0으로 끝난다: 읽기는 번호로 버려지고(suspend), 쓰기는 결과를
       * 모르는 것으로 남는다.
       */
      async function call(method, path, body) {
        const controller = new AbortController(), at = work.capture('document');
        inflight.add(controller);
        try {
          const answer = await transport.request(apiBase + path, { method, json: body, signal: controller.signal, context: at,
            deadlineMs: TIMEOUT_MS, abortWhenStale: false });
          if (!work.admits(at)) throw Object.assign(new Error(TEXT.noResponse), { status: 0, code: null, stale: true });
          if (answer.auth) throw Object.assign(new Error(TEXT.expired), { status: answer.status, code: null, auth: true });
          if (!answer.ok) {
            throw Object.assign(new Error(answer.body && typeof answer.body.message === 'string' ? answer.body.message : `HTTP ${answer.status}`),
              { status: answer.status, code: answer.code });
          }
          return { status: answer.status, data: answer.incomplete ? null : answer.body };
        } catch (error) {
          if (error && Number.isInteger(error.status)) throw error;
          throw Object.assign(new Error(error && error.transport === 'timeout' ? TEXT.noResponse : TEXT.noServer),
            { status: 0, code: null, stale: !work.admits(at) });
        } finally {
          inflight.delete(controller);
        }
      }

      /** #3·#1 응답의 모양 검사. target이 있으면 모든 행이 그 검사의 것이어야 한다. 하나라도 틀리면 답 전체를 그리지 않는다. */
      function readSummaries(data, target) {
        const rows = data && data.items;
        if (!Array.isArray(rows) || rows.length > 50) throw new Error(TEXT.malformed);
        for (const row of rows) {
          if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.studyUid !== 'string'
              || (target === null ? row.studyUid.length > 64 || !STUDY.test(row.studyUid) : row.studyUid !== target)
              || !STATES.includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 1
              || !Number.isSafeInteger(row.entryCount) || row.entryCount < 1 || !row.author || typeof row.author !== 'object')
            throw new Error(TEXT.malformed);
        }
        return rows;
      }

      /** #2 응답의 모양 검사: 요청한 스레드·판독 대상의 답, seq 1부터 빈틈없는 항목, revision = 항목 수(서버 CHECK). */
      function readThread(data, target, id) {
        const item = data && data.item;
        const text = value => typeof value === 'string';
        const who = (value, role) => !!value && typeof value === 'object' && text(value.actor) && text(value.name)
          && (!role || Object.prototype.hasOwnProperty.call(ROLES, value.role));
        const anchor = value => !!value && typeof value === 'object' && text(value.rs) && value.rs.length > 0
          && (value.version === null || (Number.isSafeInteger(value.version) && value.version > 0));
        if (!item || typeof item !== 'object' || item.id !== id) throw new Error(TEXT.malformed);
        // 다른 검사의 질문이면 판독 대상 곁에 열지 않고 그 이유를 보인다(Inbox에서 고른 질문도 이 단건 읽기로 확인한다).
        if (item.studyUid !== target) throw new Error(TEXT.otherStudy);
        if (!STATES.includes(item.state) || !who(item.author) || !Array.isArray(item.entries) || !item.entries.length || item.entries.length > 100
            || item.revision !== item.entries.length || item.entryCount !== item.entries.length || !anchor(item.current)
            || (item.state === 'Closed') !== (!!item.closed && typeof item.closed === 'object'))
          throw new Error(TEXT.malformed);
        item.entries.forEach((entry, index) => {
          if (!entry || typeof entry !== 'object' || entry.seq !== index + 1
              || !Object.prototype.hasOwnProperty.call(KINDS, entry.kind) || (index === 0) !== (entry.kind === 'question')
              || !text(entry.body) || (entry.kind !== 'close' && !entry.body.trim()) || !who(entry.author, true) || !anchor(entry.reportAnchor))
            throw new Error(TEXT.malformed);
        });
        return item;
      }

      /**
       * 쓰기 응답이 이 요청의 적용 결과인가(계약 §3.4 QuestionApplied·§5.1 전이). HTTP 201만 받고 필수 칸을 모두 본다:
       * requestId·검사·스레드, entry.id = requestId, entry.seq = revision, revision = 보낸 기준 revision + 1, from = 보낸 때의
       * 상태, action·entry.kind·from·to가 전이표의 한 줄, at은 시각. 기준은 원래 요청(attempt)이다 — 지금 화면의 스레드로 보면
       * 그사이 전이·종결된 스레드에 보낸 Retry의 정상 재전송(저장된 결과)을 틀렸다고 한다. 어긋나면 결과를 모르는 응답이다.
       */
      function appliedOf(sent, attempt) {
        const answer = sent.data, applied = answer && answer.applied;
        if (sent.status !== 201 || !applied || typeof applied !== 'object' || typeof answer.replayed !== 'boolean'
            || !ACTIONS[attempt.action].includes(applied.action)) return false;
        const step = STEPS[applied.action], entry = applied.entry, base = attempt.base;
        const mine = value => typeof value === 'string' && value.toLowerCase() === attempt.requestId;
        return mine(applied.requestId) && applied.studyUid === attempt.uid && applied.id === attempt.threadId
          && !!entry && typeof entry === 'object' && mine(entry.id) && entry.kind === step.kind && entry.seq === applied.revision
          && applied.revision === base.revision + 1 && step.from.includes(applied.from) && applied.from === base.state
          && applied.to === step.to && typeof applied.at === 'string' && !Number.isNaN(Date.parse(applied.at));
      }

      // 창은 한 번 만든다: 목록·스레드·받은편지함·잠금 안내.
      const lockBox = make('div', 'question-state');
      lockBox.id = 'question-lock';
      lockBox.dataset.state = 'failed';
      lockBox.setAttribute('role', 'alert');
      lockBox.append(make('p', 'question-text'), make('p', 'question-detail'));
      const studyView = make('div');
      studyView.dataset.view = 'study';
      const listState = stateBox('question-list-state');
      const listRetry = button('Retry', () => loadList());
      listRetry.id = 'question-list-retry';
      listState.append(listRetry);
      const list = make('ol');
      list.id = 'question-list';
      const threadBox = make('section', 'question-thread');
      threadBox.id = 'question-thread';
      threadBox.setAttribute('aria-label', 'Thread');
      threadBox.hidden = true;
      studyView.append(listState, list, threadBox);
      const inboxView = make('div');
      inboxView.dataset.view = 'inbox';
      const inboxHead = make('div', 'question-actions');
      const inboxLabel = make('label', null, 'State');
      inboxLabel.htmlFor = 'question-inbox-filter';
      const inboxFilter = make('select');
      inboxFilter.id = 'question-inbox-filter';
      for (const [value, label] of [['open', 'Open'], ['answered', 'Answered'], ['closed', 'Closed'], ['all', 'All']]) {
        const option = make('option', null, label);
        option.value = value;
        inboxFilter.append(option);
      }
      inboxFilter.addEventListener('change', () => { inboxState = inboxFilter.value; loadInbox(false); });
      const inboxReload = button('Reload', () => loadInbox(false));
      inboxReload.id = 'question-inbox-reload';
      inboxHead.append(inboxLabel, inboxFilter, inboxReload);
      const inboxLine = stateBox('question-inbox-state');
      const inboxRetry = button('Retry', () => loadInbox(inboxItems.length > 0));
      inboxRetry.id = 'question-inbox-retry';
      inboxLine.append(inboxRetry);
      const inboxList = make('ol');
      inboxList.id = 'question-inbox-list';
      const inboxMore = button('More', () => loadInbox(true));
      inboxMore.id = 'question-inbox-more';
      inboxView.append(make('p', 'question-muted', TEXT.inboxHint), inboxHead, inboxLine, inboxList, inboxMore);
      pane.append(lockBox, studyView, inboxView);

      /** 줄과 창의 겉모습. 줄은 질문이 있거나·읽기가 실패했거나·잠겼거나·창을 연 동안만 보인다. */
      function paint() {
        const visible = !ended && allowed() && (lock !== null || mode !== null || listFailure !== null || (items !== null && items.length > 0));
        root.hidden = !visible;
        root.dataset.state = ended ? 'ended' : lock ? 'locked' : listFailure ? 'failed' : listLoading ? 'loading'
          : items === null ? 'idle' : items.length ? 'ready' : 'empty';
        const counts = state => (items || []).filter(item => item.state === state).length;
        const line = lock ? lock.text : uid === null ? TEXT.none : listFailure ? TEXT.failed : items === null ? TEXT.loading
          : items.length ? TEXT.counts(items.length, counts('Open'), counts('Answered'), counts('Closed')) : TEXT.empty;
        summary.textContent = line;
        summary.title = line;
        toggle.textContent = mode === 'study' ? 'Hide Questions' : 'Show Questions';
        toggle.setAttribute('aria-expanded', String(mode === 'study'));
        inboxButton.setAttribute('aria-expanded', String(mode === 'inbox'));
        pane.hidden = mode === null;
        pane.dataset.mode = mode || '';
        lockBox.hidden = lock === null;
        lockBox.querySelector('.question-text').textContent = lock ? lock.text : '';
        lockBox.querySelector('.question-detail').textContent = lock ? lock.detail : '';
        studyView.hidden = lock !== null || mode !== 'study';
        inboxView.hidden = lock !== null || mode !== 'inbox';
      }

      function renderList() {
        const state = uid === null ? 'none' : listFailure ? 'failed' : listLoading || items === null ? 'loading' : items.length ? 'ready' : 'empty';
        setState(listState, state, { none: TEXT.none, failed: TEXT.failed, loading: TEXT.loading, empty: TEXT.empty }[state]
          || TEXT.ready(items.length), listFailure ? readDetail(listFailure) : '');
        listRetry.hidden = !listFailure;
        list.replaceChildren(...(listFailure || !items ? [] : items).map(listItem));
        list.hidden = !list.children.length;
      }

      function listItem(item) {
        const li = make('li');
        li.dataset.id = item.id;
        if (item.id === threadId) li.setAttribute('aria-current', 'true');
        const open = button('Open Thread', () => openThread(item.id));
        open.dataset.openThread = '';
        li.append(badge(item.state), ' ',
          TEXT.item(time(item.createdAt), person(item.author), item.entryCount, time(item.lastEntryAt)), ' ', open);
        return li;
      }

      function clearThreadBox() {
        threadBox.hidden = true;
        threadBox.replaceChildren();
        delete threadBox.dataset.id;
        delete threadBox.dataset.state;
      }

      /**
       * 스레드 자리. 같은 스레드를 다시 읽을 때는 머리·항목만 바꾸고 쓰는 칸은 그대로 둔다 — 다시 만들면 치고 있던 글자와
       * 커서가 사라진다. 다른 스레드(다른 검사의 스레드 포함)를 열 때만 새로 만든다.
       */
      function buildThread(target, id) {
        threadBox.dataset.id = id;
        const head = make('div', 'question-actions');
        const title = make('h4', null, 'Thread');
        const status = make('span');
        status.dataset.part = 'status';
        head.append(title, status);
        const meta = make('p', 'question-muted');
        meta.dataset.part = 'meta';
        const state = stateBox('question-thread-state');
        state.dataset.part = 'state';
        const retry = button('Retry', () => loadThread());
        retry.dataset.part = 'retry';
        state.append(retry);
        const entries = make('ol');
        entries.id = 'question-entries';
        entries.dataset.part = 'entries';
        const closed = make('p', 'question-muted', TEXT.closedNote);
        closed.dataset.part = 'closed';
        const reply = composer(target, id, 'reply', { label: 'Reply', hint: TEXT.replyHint, button: 'Reply', multiline: true });
        // OQ-11 (a): 서버는 답변 문장을 거르지 않는다. 확정 전 소견이 그대로 전해진다는 사실을 입력 곁에 둔다.
        const nonFinal = make('p', 'question-nonfinal', TEXT.nonFinal);
        nonFinal.id = 'question-nonfinal';
        reply.querySelector('textarea').before(nonFinal);
        reply.querySelector('textarea').setAttribute('aria-describedby', 'question-reply-hint question-nonfinal');
        const close = composer(target, id, 'close', { label: 'Close Reason', hint: TEXT.closeHint, button: 'Close', multiline: false });
        const note = noteBox(noteOf(target, id));
        threadBox.replaceChildren(head, meta, state, entries, closed, reply, close, note);
      }

      function renderThread() {
        if (uid === null || threadId === null || listFailure !== null) {
          clearThreadBox();
          return;
        }
        if (threadBox.dataset.id !== threadId) buildThread(uid, threadId);
        threadBox.hidden = false;
        const part = name => threadBox.querySelector(`[data-part="${name}"]`);
        const loaded = !threadFailure && thread !== null && thread.id === threadId ? thread : null;
        threadBox.dataset.state = loaded ? loaded.state : threadFailure ? 'failed' : 'loading';
        part('status').replaceChildren(...(loaded ? [badge(loaded.state)] : []));
        part('meta').textContent = loaded ? TEXT.threadMeta(time(loaded.createdAt), person(loaded.author)) : '';
        const state = threadFailure ? 'failed' : threadLoading || !loaded ? 'loading' : 'ready';
        setState(part('state'), state, { failed: TEXT.threadFailed, loading: TEXT.threadLoading }[state] || '',
          threadFailure ? readDetail(threadFailure) : '');
        part('state').hidden = state === 'ready';
        part('retry').hidden = !threadFailure;
        part('entries').replaceChildren(...(loaded ? loaded.entries.map(item => entryItem(item, loaded.current)) : []));
        part('closed').hidden = !loaded || loaded.state !== 'Closed';
        for (const wrap of threadBox.querySelectorAll('.question-compose')) {
          paintComposer(wrap);
          // 닫힌 스레드에는 쓰는 칸을 두지 않는다. 쓰던 글이나 결과를 모르는 요청이 남은 칸만 그대로 둔다.
          wrap.hidden = !!loaded && loaded.state === 'Closed' && !attempts.has(wrap.dataset.key) && !(drafts.get(wrap.dataset.key) || '');
        }
      }

      function entryItem(entry, current) {
        const li = make('li');
        li.dataset.seq = String(entry.seq);
        li.dataset.kind = entry.kind;
        const meta = make('p', 'question-muted');
        meta.append(make('strong', null, KINDS[entry.kind]), ` · ${person(entry.author)} (${ROLES[entry.author.role]}) · ${time(entry.at)}`);
        const body = entry.body ? make('p', 'question-body', entry.body) : make('p', 'question-muted', TEXT.closeEmpty);
        li.append(meta, body);
        // 답변 뒤 판독이 승인·Addendum·Reset되었으면 그 답이 어느 판독 상태를 보고 쓴 것인지 알린다(서버는 스레드를 다시 열지 않는다).
        if (entry.kind === 'answer' && (entry.reportAnchor.rs !== current.rs || entry.reportAnchor.version !== current.version)) {
          const note = make('p', 'question-anchor');
          note.dataset.anchor = '';
          note.append(make('strong', null, TEXT.anchorChanged), ' ', TEXT.anchorDetail(reportText(entry.reportAnchor), reportText(current)));
          li.append(note);
        }
        return li;
      }

      /**
       * 쓰는 칸 하나(Reply·Close Reason). 결과를 모르는 요청이 있는 동안 글은 바꿀 수 없고 Retry(같은 requestId)와 Discard만
       * 있다 — 글을 고쳐 새 requestId로 보내면 이미 저장된 답 위에 하나가 더 생길 수 있다.
       */
      function composer(target, id, action, spec) {
        const key = keyOf(target, id, action);
        const wrap = make('div', 'question-compose');
        wrap.dataset.key = key;
        wrap.dataset.action = action;
        const fieldId = `question-${action}-text`, hintId = `question-${action}-hint`;
        const label = make('label', null, spec.label);
        label.htmlFor = fieldId;
        const hint = make('p', 'question-muted', spec.hint);
        hint.id = hintId;
        const field = make(spec.multiline ? 'textarea' : 'input');
        field.id = fieldId;
        field.dataset.field = '';
        if (spec.multiline) field.rows = 3;
        else field.type = 'text';
        field.maxLength = TEXT_MAX;
        field.setAttribute('aria-describedby', hintId);
        field.addEventListener('input', () => {
          if (!attempts.has(key)) drafts.set(key, field.value);
        });
        const actions = make('div', 'question-actions');
        const send = button(spec.button, () => submit(target, id, action, field));
        send.dataset.send = '';
        const retry = button('Retry', () => resend(key));
        retry.dataset.retry = '';
        const discard = button('Discard', () => drop(key));
        discard.dataset.discard = '';
        actions.append(send, retry, discard);
        wrap.append(label, hint, field, actions);
        paintComposer(wrap);
        return wrap;
      }

      /** 쓰는 칸의 모양은 맵(쓰던 글·결과를 모르는 요청)과 마지막으로 읽힌 그 스레드에서만 정한다. */
      function paintComposer(wrap) {
        const key = wrap.dataset.key, [, id] = key.split('\n');
        const attempt = attempts.get(key) || null, field = wrap.querySelector('[data-field]');
        wrap.dataset.state = !attempt ? 'idle' : attempt.busy ? 'busy' : 'unknown';
        field.readOnly = attempt !== null;
        // 같은 글이면 쓰지 않는다: 값을 다시 넣으면 치고 있던 커서·한글 조합이 끊긴다.
        const value = attempt ? attempt.text : drafts.get(key) || '';
        if (field.value !== value) field.value = value;
        // 기준 revision은 마지막으로 읽힌 그 스레드에서만 온다. 한 번도 읽히지 않았거나 읽기에 실패했으면 보내지 않는다.
        const ready = !threadFailure && thread !== null && thread.id === id;
        wrap.querySelector('[data-send]').disabled = attempt !== null || !ready;
        for (const name of ['retry', 'discard']) wrap.querySelector(`[data-${name}]`).hidden = !attempt || attempt.busy;
      }

      function repaintComposer(key) {
        for (const wrap of threadBox.querySelectorAll('.question-compose')) if (wrap.dataset.key === key) paintComposer(wrap);
      }

      function noteBox(key) {
        const box = make('div', 'question-state');
        box.dataset.noteKey = key;
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.append(make('p', 'question-text'), make('p', 'question-detail'));
        paintNote(box);
        return box;
      }

      function paintNote(box) {
        const note = notes.get(box.dataset.noteKey) || null;
        box.hidden = note === null;
        setState(box, note ? note.state : 'idle', note ? note.text : '', note ? note.detail : '');
      }

      function setNote(key, state, text, detail) {
        notes.set(key, { state, text, detail: detail || '' });
        for (const box of threadBox.querySelectorAll('[data-note-key]')) if (box.dataset.noteKey === key) paintNote(box);
      }

      /**
       * 새 쓰기: 새 requestId(UUID v4), 이 화면의 계정([기관, sub]), 마지막으로 읽힌 스레드의 revision을 싣는다. 그 revision과
       * 상태를 요청에 적어 두고 응답(Retry의 재전송 포함)은 이 기준으로만 확인한다(appliedOf).
       */
      function submit(target, id, action, field) {
        const key = keyOf(target, id, action), noteKey = noteOf(target, id);
        const loaded = !threadFailure && thread !== null && thread.id === id ? thread : null;
        const who = owner();
        if (ended || lock !== null || target !== uid || attempts.has(key) || !loaded || !who) return;
        const value = field.value;
        if (!(action === 'close' && value === '') && (!value.trim() || value.length > TEXT_MAX)) {
          setNote(noteKey, 'failed', TEXT.noText);
          return;
        }
        let requestId;
        try {
          requestId = newRequestId();
        } catch (_) {
          setNote(noteKey, 'failed', TEXT.noRequestId);
          return;
        }
        const path = `/questions/${encodeURIComponent(id)}/${action === 'close' ? 'close' : 'entries'}`;
        const attempt = { requestId, owner: who, uid: target, threadId: id, action, noteKey, path, text: value, busy: false, unknown: false,
          base: { revision: loaded.revision, state: loaded.state },
          payload: { revision: loaded.revision, [action === 'close' ? 'note' : 'body']: value } };
        drafts.set(key, value);
        attempts.set(key, attempt);
        transmit(key, attempt);
      }

      /** 결과를 모르는 요청만 같은 requestId·같은 본문으로 다시 보낸다. 이미 적용되었으면 서버가 저장한 결과를 돌려준다. */
      function resend(key) {
        const attempt = attempts.get(key);
        if (ended || lock !== null || !attempt || attempt.busy || !attempt.unknown) return;
        transmit(key, attempt);
      }

      /** 결과를 모르는 요청을 버린다. 글은 칸에 남기고, 저장되었는지는 다시 읽은 스레드로 보인다. */
      function drop(key) {
        const attempt = attempts.get(key);
        if (ended || !attempt || attempt.busy) return;
        attempts.delete(key);
        drafts.set(key, attempt.text);
        setNote(attempt.noteKey, 'discarded', TEXT.discarded);
        repaintComposer(key);
        if (lock === null && attempt.uid === uid) loadList();
      }

      async function transmit(key, attempt) {
        attempt.busy = true;
        attempt.unknown = false;
        setNote(attempt.noteKey, 'busy', TEXT.sending);
        repaintComposer(key);
        let sent = null, error = null;
        try {
          sent = await call('POST', attempt.path, { requestId: attempt.requestId, expectedOwner: attempt.owner, ...attempt.payload });
        } catch (caught) {
          error = caught;
        }
        // 세션이 끝났거나 잠겨 맵을 비웠으면 이 결과는 어디에도 쓰지 않는다.
        if (ended || attempts.get(key) !== attempt) return;
        attempt.busy = false;
        // 로그아웃 준비·그 취소 뒤에 온 답은 저장 결과로 그리지 않는다. 그 쓰기는 결과를 모르는 것으로 남아 같은 요청 ID의
        // Retry가 서버의 결과를 확인한다(보낸 것을 잊지 않는다).
        if (error && error.stale) {
          attempt.unknown = true;
          notes.set(attempt.noteKey, { state: 'unknown', text: TEXT.unknown, detail: '' });
          return;
        }
        if (error) {
          writeFailed(key, attempt, error);
          return;
        }
        const same = ownerOf(sent.data);
        if (same === false) {
          accountChanged('');
          return;
        }
        if (same === null || !appliedOf(sent, attempt)) {
          attempt.unknown = true;
          setNote(attempt.noteKey, 'unknown', TEXT.writeMalformed, sent.status === 201 ? '' : `HTTP ${sent.status}`);
          repaintComposer(key);
          return;
        }
        attempts.delete(key);
        drafts.delete(key);
        setNote(attempt.noteKey, 'saved', sent.data.replayed ? TEXT.replayed : TEXT.saved);
        repaintComposer(key);
        // 화면의 스레드는 쓰기 응답(적용 결과)이 아니라 읽기 route로 다시 읽은 현재 상태로만 그린다.
        if (lock === null && attempt.uid === uid) loadList();
      }

      /**
       * 쓰기 실패. 연결 실패·제한 시간·5xx·QUESTION_BUSY·STUDY_ACCESS_CHANGED(커밋 뒤 최종 확인일 수 있다)는 적용 여부를 모르는
       * 결과라 Retry(같은 requestId)를 남긴다. 그 밖의 거절은 요청을 버리고 쓰던 글은 칸에 둔다. OWNER_CHANGED는 계정이 바뀐 것이다.
       */
      function writeFailed(key, attempt, error) {
        if (error.auth) return;
        if (error.code === 'OWNER_CHANGED') {
          accountChanged(describe(error));
          return;
        }
        if (error.status === 0 || error.status >= 500 || error.code === 'STUDY_ACCESS_CHANGED') {
          attempt.unknown = true;
          setNote(attempt.noteKey, 'unknown', TEXT.codes[error.code] || TEXT.unknown, describe(error));
          repaintComposer(key);
          return;
        }
        attempts.delete(key);
        setNote(attempt.noteKey, 'failed',
          TEXT.codes[error.code] || (error.status === 404 ? TEXT.notFound : TEXT.statuses[error.status]) || TEXT.rejected, describe(error));
        repaintComposer(key);
        // 질문이 바뀌었거나 닫혔거나 보이지 않게 되었으면 지금 서버 상태를 다시 읽는다(쓰던 글은 칸에 남는다).
        if ((error.status === 404 || error.status === 409) && lock === null && attempt.uid === uid) loadList();
      }

      /**
       * 확인된 계정 변경(다른 계정의 봉투 owner·OWNER_CHANGED)은 이 줄만의 일이 아니다. 이 줄을 잠그고 notifyAccountChanged로 onCommonEnd 구독자에게
       * 사유 'account-changed'로 알려, 네트워크를 기다리기 전에 같은 페이지의 다른 영역(S5-U4c 영상 요청)도
       * 쓰던 글·결과를 모르는 요청·읽기/쓰기 번호를 버리게 한다 — 이 줄만 잠그면 다른 영역에 이전 계정의 note와 Retry가 남고 나가
       * 있던 쓰기의 늦은 영수증이 저장 결과로 그려진다(Astra S5-U4bc-R-001 F01). 질문 읽기를 서버가 403으로 거절한 것은 계정 변경이
       * 아니라서 lockPanel로 이 줄만 잠근다.
       */
      function accountChanged(detail) {
        lockPanel(TEXT.ownerChanged, detail, true);
        notifyAccountChanged(detail);
      }

      /**
       * 서버가 질문 읽기를 거절했거나(403) 계정이 바뀌었다(accountChanged, 이 줄이나 다른 영역이 알아챘다). 이 문서에서는 질문을
       * 더 읽거나 쓰지 않고 진행 중인 요청의 답도 그리지 않는다(뷰어 세션의 거절·계정 변경과 같은 한 방향). 쓰던 글은 이전 계정의
       * 것이라 버린다. 403으로 이미 잠긴 뒤 계정 변경을 알면(account) 그 까닭으로 바꿔 쓴다.
       */
      function lockPanel(text, detail, account = false) {
        if (ended || (lock !== null && (lock.account || !account))) return;
        lock = { text, detail: detail || '', account };
        epoch++;
        listSeq++;
        threadSeq++;
        inboxSeq++;
        drafts.clear();
        attempts.clear();
        notes.clear();
        items = null;
        listFailure = null;
        listLoading = false;
        threadId = null;
        thread = null;
        threadFailure = null;
        threadLoading = false;
        pendingThread = null;
        inboxItems = [];
        inboxCursor = null;
        inboxFailure = null;
        inboxLoading = false;
        if (mode === null) mode = 'study';
        clearThreadBox();
        list.replaceChildren();
        inboxList.replaceChildren();
        paint();
      }

      /**
       * #3. 판독 대상의 스레드 요약(최신 50). 성공하면 연 스레드를 단건 읽기(#2)로 다시 읽는다. 연 스레드는 이 목록에 있는지로
       * 고르거나 내리지 않는다 — 목록은 최신 50개뿐이라 Inbox에서 고른 오래된 질문이나 쓰기 뒤 다시 읽은 목록에 없을 수 있다
       * (Astra S5-U4b-R-001 F3). 그 스레드를 열 수 있는지는 loadThread가 owner·studyUid·요청 번호로 정하고 404·403·다른 검사는
       * 명시 문구로 보인다. 목록을 읽지 못하면 스레드 칸을 내리되(그 내용은 버린다) 고른 스레드는 두어 Retry 뒤 다시 읽는다.
       */
      async function loadList() {
        if (ended || lock !== null || uid === null) return;
        const target = uid, era = epoch, mine = ++listSeq;
        listLoading = true;
        listFailure = null;
        paint();
        renderList();
        let data;
        try {
          data = (await call('GET', `/studies/${encodeURIComponent(target)}/questions`)).data;
        } catch (error) {
          if (!fresh(era, target) || mine !== listSeq) return;
          listLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          items = null;
          listFailure = error;
          thread = null;
          paint();
          renderList();
          renderThread();
          return;
        }
        if (!fresh(era, target) || mine !== listSeq) return;
        listLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          items = readSummaries(data, target);
        } catch (error) {
          items = null;
          listFailure = error;
          thread = null;
        }
        paint();
        renderList();
        renderThread();
        if (items && threadId !== null) loadThread();
      }

      function openThread(id) {
        if (ended || lock !== null || uid === null) return;
        if (threadId !== id) {
          threadId = id;
          thread = null;
          threadFailure = null;
          threadSeq++;
        }
        renderList();
        renderThread();
        loadThread();
      }

      /** #2. 연 스레드 전체. 늦은 답은 번호·epoch·판독 대상·연 스레드로 버린다. */
      async function loadThread() {
        if (ended || lock !== null || uid === null || threadId === null) return;
        const target = uid, id = threadId, era = epoch, mine = ++threadSeq;
        threadLoading = true;
        threadFailure = null;
        renderThread();
        let data;
        try {
          data = (await call('GET', `/questions/${encodeURIComponent(id)}`)).data;
        } catch (error) {
          if (!fresh(era, target) || mine !== threadSeq || threadId !== id) return;
          threadLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          thread = null;
          threadFailure = error;
          renderThread();
          return;
        }
        if (!fresh(era, target) || mine !== threadSeq || threadId !== id) return;
        threadLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          thread = readThread(data, target, id);
        } catch (error) {
          thread = null;
          threadFailure = error;
        }
        renderThread();
      }

      /** #1 view=inbox. 판독 대상과 무관한 목록이라 epoch가 아니라 자기 번호와 창의 모드로 늦은 답을 버린다. */
      async function loadInbox(more) {
        if (ended || lock !== null || mode !== 'inbox') return;
        const mine = ++inboxSeq, cursor = more ? inboxCursor : null;
        if (!more) {
          inboxItems = [];
          inboxCursor = null;
        }
        inboxLoading = true;
        inboxFailure = null;
        renderInbox();
        let data;
        try {
          data = (await call('GET', `/questions?view=inbox&state=${encodeURIComponent(inboxState)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).data;
        } catch (error) {
          if (ended || lock !== null || mine !== inboxSeq) return;
          inboxLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          inboxFailure = error;
          renderInbox();
          return;
        }
        if (ended || lock !== null || mine !== inboxSeq) return;
        inboxLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          const page = readSummaries(data, null), next = data.nextCursor;
          if (!(next === null || (typeof next === 'string' && CURSOR.test(next) && next !== cursor))) throw new Error(TEXT.malformed);
          inboxItems = [...inboxItems, ...page];
          inboxCursor = next;
        } catch (error) {
          inboxFailure = error;
        }
        renderInbox();
      }

      function renderInbox() {
        const state = inboxLoading ? 'loading' : inboxFailure ? 'failed' : inboxItems.length ? 'ready' : 'empty';
        setState(inboxLine, state, { loading: TEXT.inboxLoading, failed: TEXT.inboxFailed, empty: TEXT.inboxEmpty }[state]
          || TEXT.inboxReady(inboxItems.length, inboxCursor !== null), inboxFailure ? describe(inboxFailure) : '');
        inboxRetry.hidden = !inboxFailure;
        inboxList.replaceChildren(...inboxItems.map(inboxItem));
        inboxList.hidden = !inboxItems.length;
        inboxMore.hidden = inboxCursor === null || inboxLoading || !!inboxFailure;
        inboxFilter.value = inboxState;
      }

      function inboxItem(item) {
        const li = make('li');
        li.dataset.id = item.id;
        li.dataset.uid = item.studyUid;
        const row = study(item.studyUid);
        const label = row ? `${dash(row.name)} · ${dash(row.id)} · ${dash(row.date)} · ${dash(row.desc)}` : `${TEXT.unlisted} · ${item.studyUid}`;
        const open = button('Open Study', () => openFromInbox(item));
        open.dataset.openStudy = '';
        if (!row) {
          open.disabled = true;
          open.title = TEXT.notListed;
        }
        li.append(badge(item.state), ' ', make('span', null, label), ' ',
          make('span', 'question-muted', TEXT.item(time(item.createdAt), person(item.author), item.entryCount, time(item.lastEntryAt))), ' ', open);
        return li;
      }

      /**
       * Inbox의 질문을 연다: 그 검사를 판독 대상으로 고르고(select) 그 검사의 목록을 읽은 뒤 이 스레드를 단건 읽기(#2)로 연다.
       * 스레드는 그 검사의 목록(최신 50)에 있는지와 무관하게 연다(sync·loadList).
       */
      function openFromInbox(item) {
        if (ended || lock !== null || !study(item.studyUid)) return;
        inboxSeq++;
        mode = 'study';
        if (item.studyUid === uid) {
          paint();
          openThread(item.id);
          return;
        }
        pendingThread = { uid: item.studyUid, id: item.id };
        paint();
        openStudy(item.studyUid);
      }

      /**
       * renderClinical()이 부른다(선택·관련 검사 보기·검사 정보 갱신마다). 판독 대상이 바뀐 때만 이전 대상의 스레드를 내리고
       * 새 대상의 목록을 읽는다 — 같은 대상이면 요청도 그리기도 없다.
       */
      function sync() {
        if (ended) return;
        const selectedUid = allowed() ? current() : null;
        const row = selectedUid ? study(selectedUid) : null;
        const next = row && row.tele !== true ? selectedUid : null;
        if (next === uid) return;
        uid = next;
        epoch++;
        listSeq++;
        threadSeq++;
        items = null;
        listFailure = null;
        listLoading = false;
        // Inbox에서 고른 질문의 검사가 판독 대상이 되었으면 그 스레드가 연 스레드다. 목록을 읽은 뒤 단건으로 읽는다(loadList).
        threadId = pendingThread && pendingThread.uid === uid ? pendingThread.id : null;
        pendingThread = null;
        thread = null;
        threadFailure = null;
        threadLoading = false;
        clearThreadBox();
        paint();
        renderList();
        if (uid !== null && lock === null) loadList();
      }

      /**
       * 세션 관문이 실제 종료를 알렸다(명시적 로그아웃·같은 세션의 종료 통지·서버의 종료 코드). 줄을 내리고 쓰던 글을 버리며 나간 요청은 멈추고 그 답은 어디에도 그리지 않는다.
       * 일반 401은 요청 실패로만 남고, 실제 종료는 관문의 lifecycle 변경에서 onCommonEnd 구독자에게 동기로 전달된다.
       * 방송·storage·pagehide와 겹쳐 여러 번 불려도 처음 한 번만 끝낸다. 목록이 사유 'account-changed'로 부르면 세션은 그대로이고
       * 계정이 바뀐 것이라 잠근다(accountChanged).
       */
      function end(reason, detail) {
        if (reason === 'account-changed') {
          lockPanel(TEXT.ownerChanged, detail, true);
          return;
        }
        if (ended) return;
        ended = true;
        epoch++;
        listSeq++;
        threadSeq++;
        inboxSeq++;
        for (const controller of inflight) controller.abort();
        inflight.clear();
        drafts.clear();
        attempts.clear();
        notes.clear();
        uid = null;
        items = null;
        mode = null;
        threadId = null;
        thread = null;
        pendingThread = null;
        inboxItems = [];
        clearThreadBox();
        list.replaceChildren();
        inboxList.replaceChildren();
        paint();
      }

      /**
       * 이 문서의 작업 문맥이 바뀌었다(로그아웃 준비에 들어섰다). 그 전에 나간 읽기의 답은 이 줄의 것이 아니다: 읽기 번호를
       * 넘겨 늦은 답과 실패를 버리고, 그 읽기들이 세운 대기 표시를 내린다. 쓰던 글과 결과를 모르는 쓰기는 그대로 둔다.
       */
      function suspend() {
        if (ended) return;
        listSeq++;
        threadSeq++;
        inboxSeq++;
        listLoading = threadLoading = inboxLoading = false;
      }
      /** 편집으로 돌아왔다: 준비가 버린 읽기를 지금 문맥에서 다시 읽는다. */
      function resume() {
        if (ended || lock !== null) return;
        paint();
        if (uid !== null) loadList();
        if (mode === 'inbox') loadInbox(false);
      }
      work.onInvalidate(event => { if (event.reason === 'prepare') suspend(); });

      toggle.addEventListener('click', () => {
        if (ended) return;
        inboxSeq++;
        mode = mode === 'study' ? null : 'study';
        paint();
        renderList();
        renderThread();
      });
      inboxButton.addEventListener('click', () => {
        if (ended) return;
        if (mode === 'inbox') {
          inboxSeq++;
          mode = lock === null ? null : 'study';
          paint();
          return;
        }
        mode = 'inbox';
        paint();
        if (lock === null) loadInbox(false);
      });
      window.addEventListener('pagehide', end);
      // 이 문서의 세션이 끝나면 세션 종료 조정이 이 목록을 동기로 부른다. 어느 로그인의 종료인지는 auth.js가 대조한다.
      onCommonEnd(end);
      paint();
      return { sync, end, resume };
    }
    let studyQuestions = null;
    try {
      studyQuestions = mountStudyQuestions({ apiBase: API, work, transport, current: () => selectedUid,
        study: uid => studies.find(s => s.uid === uid),
        openStudy: uid => select(uid),
        allowed: () => !!sess && serverMode && !demoMode && !offline && (KinAuth.has('radiologist') || KinAuth.has('admin')),
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; } });
    } catch (_) { toast('임상의 질문 줄을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }