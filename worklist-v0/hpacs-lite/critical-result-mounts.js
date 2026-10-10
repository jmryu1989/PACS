

    // ── 중요 결과 수신(S7-U2a) ──
    // REQ-S7-U2a-RECIPIENT-LIST/EXPLICIT-ACK/WORDING → TEST-S7-U2a-DOM (tests/critical_result_recipient_dom_test.py가 이 절을
    // 잘라 critical-result-inbox.js와 함께 실행한다). 판독 화면의 Critical Results 패널은 판독 대상과 무관한 이 계정의 받은 목록이다.
    // 받는 역할은 clinician 또는 radiologist를 정확히 본다 — KinAuth.has()는 admin을 모든 역할로 통과시키지만 서버는 admin만·
    // technician만인 계정의 받은 목록을 거절한다(계약 §14). 이 절은 부팅이 세션과 서버 연결을 확인하기 전에 돌므로, 영역은 이
    // Module teardown follows the page work-context lifecycle.
    // Module teardown follows the page work-context lifecycle.
    let criticalInbox = null;
    try {
      criticalInbox = KinCriticalResultInbox.mount({ apiBase: API, root: 'cvr-inbox-p', prefix: 'cvr-inbox', fold: true,
        onAccountChanged: notifyAccountChanged,
        eligible: () => { const s = KinAuth.session(); return !!sess && serverMode && !demoMode && !offline && s?.state === 'approved'
          && Array.isArray(s.roles) && (s.roles.includes('clinician') || s.roles.includes('radiologist')); },
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; } });
      accountChangeHooks.push((reason, detail) => criticalInbox.lock(detail));
    } catch (_) { toast('중요 결과 수신 화면을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }

    // ── 중요 결과 발신(S7-U1b) ──
    // REQ-S7-U1b-SENDER-UI/FAILURE/ABA → TEST-S7-U1b-DOM (tests/critical_result_sender_dom_test.py가 이 절을 잘라
    // critical-result-send.js와 함께 실행한다). Mark CVR·발신 창·보낸 목록은 그 파일이 서버 S7-U1a route로만 움직인다.
    // 보내는 역할은 radiologist를 정확히 본다 — KinAuth.has()는 admin을 모든 역할로 통과시키지만 서버는 admin만인
    // 계정의 발신을 거절한다(D-S7-02 a). 판독 상태 {version, rs}가 바뀌면 그 파일이 #1을 다시 읽는다.
    let criticalResults = null;
    try {
      criticalResults = KinCriticalResultSend.mount({ apiBase: API,  current: () => selectedUid,
        onAccountChanged: notifyAccountChanged,
        study: uid => studies.find(s => s.uid === uid),
        report: uid => { const a = appState[uid]; return a ? { version: a.version ?? 0, rs: a.rs ?? null } : null; },
        online: () => !!sess && serverMode && !demoMode && !offline,
        radiologist: () => { const s = KinAuth.session(); return s?.state === 'approved' && Array.isArray(s.roles) && s.roles.includes('radiologist'); },
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; },
        actorName: value => displayActor(value) });
      accountChangeHooks.push((reason, detail) => criticalResults.lock(detail));
    } catch (_) { toast('중요 결과 발신 화면을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }