

    // ── 임상 정보 패널(S7-U4b) ──
    // REQ-S7-U4b-PANEL → RISK-S7-U4b-STALE-PANEL/FAIL-AS-EMPTY → TEST-S7-U4b-DOM (tests/clinical_context_dom_test.py가 이 절을
    // 잘라 clinical-context.js·auth.js와 함께 실행한다) · TEST-S7-U4b-MODEL. 계약 S7-U4p §7·§8·§10.
    // 보고 있는 검사(viewed(), Related 미리보기 포함)의 서명된 과거 판독문·검사 이력·DICOM 요청 태그·Tech Note 메타를 서버의 닫힌 답
    // 하나(GET studies/:uid/clinical-context)로 그린다. 보는 검사가 바뀔 때만 읽고, 같은 검사의 renderClinical은 요청도 다시 그리기도
    // 하지 않는다. 시간이 지나거나 목록이 바뀌어도 스스로 다시 읽지 않는다 — Refresh·Retry는 사람이 누른다(CS-11).
    // 답은 요청 번호·요청 UID·보는 UID·계정이 모두 같을 때만 그린다(ABA-3). 새 요청이 앞 요청을 abort해도 앞 답은 이미 오고 있을
    // 수 있으므로 abort는 전송을 줄일 뿐이고 방어는 이 대조다. 다른 검사를 말하는 답은 상태를 바꾸지 않고 버린다(OP-2, D172).
    // 404·403·409와 모양이 다른 답은 항목을 지우고(ABA-6), 503·그 밖의 5xx·연결 실패는 같은 검사의 앞 답을 Stale로 남긴다(ABA-7, OP-1).
    // 역할에 radiologist·admin이 없으면 숨기고 요청하지 않는다 — 경계는 서버이고 숨김은 편의다. 세션 종료는 이 페이지가 맡는다:
    // Module teardown follows the page work-context lifecycle.
    // 답은 이 문서의 메모리에만 두고, 모든 값은 textContent로 쓴다.
    function mountClinicalContext({ work, allowed, target, owner, read, actor }) {
      const model = KinClinicalContext;
      const root = $('#clinical-context'), status = $('#clinical-context-status'), refresh = $('#clinical-context-refresh'),
        conflict = $('#clinical-context-conflict'), list = $('#clinical-context-sections');
      const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== null && text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
      };
      const retry = node('button', model.TEXT.retry, 'chip');
      retry.type = 'button';
      retry.hidden = true;
      status.after(retry);
      // shownUid: the study the panel is for (null = hidden). A request is one generation of seq; only the newest may paint.
      let ended = false, seq = 0, controller = null, loading = false, shownUid = null;
      let answer = null, stale = {}, failure = null, observation = null;
      const opened = new Map();

      function parts(items) {
        const out = document.createDocumentFragment();
        items.forEach((part, i) => {
          if (i) out.append(' · ');
          const span = node('span', part.text, part.badge ? 'cc-badge' : null);
          if (part.title) span.title = part.title;
          out.append(span);
        });
        return out;
      }
      function line(summary) {
        if (summary.label) status.append(node('strong', summary.label), ' ');
        status.append(summary.text);
        status.title = summary.title || '';
      }
      function paint() {
        const visible = !ended && shownUid !== null;
        // A report text the reader opened stays open when the same answer is painted again (a later list observation).
        const wasOpen = new Set([...opened].filter(([, details]) => details.open).map(([key]) => key));
        opened.clear();
        root.hidden = !visible;
        refresh.disabled = !visible || loading;
        retry.disabled = loading;
        retry.hidden = true;
        status.replaceChildren();
        status.title = '';
        conflict.replaceChildren();
        conflict.hidden = true;
        list.replaceChildren();
        if (!visible) return;
        if (loading) status.textContent = model.TEXT.loading;
        if (!answer) {
          if (!loading && failure) {
            line(model.failedSummary(failure));
            retry.hidden = false;
          }
          return;
        }
        const shown = model.view(answer, stale, { actor });
        if (shown.conflict) {
          conflict.append(node('strong', shown.conflict.title), ' ', shown.conflict.text);
          conflict.hidden = false;
        }
        for (const section of shown.sections) {
          const box = node('div', null, 'cc-section');
          box.setAttribute('role', 'group');
          box.setAttribute('aria-label', section.title);
          box.dataset.section = section.name;
          box.dataset.state = section.state;
          const head = node('div', null, 'cc-section-head');
          head.append(node('span', section.count ? section.title + ' ' + section.count : section.title));
          if (section.label) head.append(' ', node('span', section.label, 'cc-state'));
          if (section.retry) {
            const again = node('button', model.TEXT.retry, 'chip');
            again.type = 'button';
            again.disabled = loading;
            again.addEventListener('click', reread);
            head.append(' ', again);
          }
          box.append(head, node('div', section.description, 'cc-note'));
          if (section.checked) box.append(node('div', section.checked, 'cc-note'));
          if (section.items.length) {
            const items = node('ul');
            for (const item of section.items) {
              const entry = node('li');
              entry.append(parts(item.line));
              for (const mark of item.marks) entry.append(' ', node('span', mark, 'cc-mark'));
              const source = node('div', null, 'cc-source');
              source.append(parts(item.source));
              entry.append(source);
              if (item.details) {
                const details = node('details'), key = section.name + ' ' + item.key;
                details.append(node('summary', model.TEXT.reportText));
                for (const body of item.details) details.append(node('div', body.label, 'cc-note'), node('div', body.text, 'cc-body'));
                details.open = wasOpen.has(key);
                opened.set(key, details);
                entry.append(details);
              }
              items.append(entry);
            }
            box.append(items);
          }
          list.append(box);
        }
        if (!loading) line(model.summary(answer, stale, failure));
      }

      function start(uid) {
        if (controller) controller.abort();
        const mine = ++seq, who = owner(), own = new AbortController();
        controller = own;
        loading = true;
        paint();
        // 이 읽기를 시작한 작업 문맥. 답도 실패도 그것이 그대로일 때만 이 패널에 닿는다.
        const at = work.capture('document');
        read(uid, own.signal, at).then(value => settle(mine, uid, who, value, null, at), error => settle(mine, uid, who, null, error, at));
      }
      function settle(mine, uid, who, value, error, at) {
        // 로그아웃 준비·그 취소 뒤에 온 답은 아무것도 그리지 않는다. 그 읽기가 세운 대기 표시만 내려 두고(자기 것만),
        // 편집으로 돌아오면 resume()이 지금 문맥에서 다시 읽는다.
        if (!work.admits(at)) {
          if (!ended && mine === seq) { controller = null; loading = false; }
          return;
        }
        // ABA-3: the newest request, for the study still viewed, of the account that asked. Anything else changes nothing.
        if (ended || mine !== seq) return;
        const me = owner();
        if ((allowed() ? target() : null) !== uid || !who || !me || who[0] !== me[0] || who[1] !== me[1]) return;
        if (error && error.name === 'AbortError') return;
        const bad = error ? null : model.shapeError(value);
        if (!error && bad === null && value.uid !== uid) return;
        controller = null;
        loading = false;
        if (error || bad !== null) {
          const failed = error ? model.failure(error) : { reason: 'malformed', status: null, code: null, keep: false };
          if (failed.keep && answer) stale = model.refreshFailed(answer, stale);
          else { answer = null; stale = {}; }
          failure = failed;
        } else {
          answer = value;
          failure = null;
          // An observation that arrived while this read was out is compared now (it may be later than the answer).
          stale = observation ? model.staleAfter(value, observation, {}) : {};
        }
        paint();
      }
      function sync() {
        if (ended) return;
        const uid = allowed() ? target() : null;
        if (uid === shownUid) return;
        // ABA-4: another study's items go at once; nothing of it is kept for a later return (A->B->A reads A again).
        shownUid = uid;
        answer = null;
        stale = {};
        failure = null;
        loading = false;
        seq++;
        if (controller) controller.abort();
        controller = null;
        if (uid === null) paint();
        else start(uid);
      }
      function reread() {
        if (ended || loading) return;
        const uid = allowed() ? target() : null;
        if (uid === null || uid !== shownUid) { sync(); return; }
        start(uid);
      }
      function observe(result) {
        if (ended || !result) return;
        observation = result;
        if (!answer) return;
        const next = model.staleAfter(answer, result, stale);
        if (model.SECTIONS.every(name => (next[name] || null) === (stale[name] || null))) return;
        stale = next;
        paint();
      }
      /**
       * 세션이 끝났다(로그아웃·다른 탭·401·계정 변경). 패널을 비우고 숨기며 나간 요청을 멈추고, 그 답은 어디에도 그리지 않는다.
       * 이 문서에서는 다시 읽지 않는다. 방송·storage·pagehide와 겹쳐 여러 번 불려도 처음 한 번만 끝낸다.
       */
      function end() {
        if (ended) return;
        ended = true;
        seq++;
        if (controller) controller.abort();
        controller = null;
        loading = false;
        shownUid = null;
        answer = null;
        stale = {};
        failure = null;
        observation = null;
        paint();
      }
      /** 로그아웃 준비에서 편집으로 돌아왔다: 준비가 끊은 읽기가 있었으면 지금 문맥에서 다시 읽는다. */
      function resume() {
        if (ended) return;
        if (shownUid !== null && !loading && !answer && !failure) start(shownUid);
        else paint();
      }

      refresh.addEventListener('click', reread);
      retry.addEventListener('click', reread);
      window.addEventListener('pagehide', () => end());
      // 이 문서의 세션이 끝나면 세션 종료 조정이 이 목록을 동기로 부른다. 어느 로그인의 종료인지는 auth.js가 대조한다.
      onCommonEnd(() => end());
      paint();
      return { sync, observe, end, resume };
    }
    let clinicalContext = null;
    try {
      clinicalContext = mountClinicalContext({ work,
        allowed: () => !!sess && serverMode && !demoMode && !offline && (KinAuth.has('radiologist') || KinAuth.has('admin')),
        target: () => viewed()?.uid ?? null,
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; },
        read: (uid, signal, at) => api('GET', '/studies/' + encodeURIComponent(uid) + '/clinical-context', undefined, signal, at),
        actor: value => displayActor(value) });
    } catch (_) { toast('Clinical Context 패널을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }