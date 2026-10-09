/* EMR-C1 단절 판독 승인 화면 제어 (미연결 모듈). 페이지·main.html에 아직 등록하지 않는다(C2가 W6/W4 편집기에 연결).
 *
 * 자체 fetch·전역 인증·페이지 부팅이 없다. 생성자가 받는 다섯 접점만 쓴다.
 *   view      readText() → {findings, conclusion, recommendation}, status(요소), showReport(body), print() → Promise
 *   store     관리형 단말의 보호 저장(C-NATIVE): enqueue(entry), list(owner), observe(observation), cached(uid)
 *   signer    단말 서명(C-NATIVE): sign(request) → { entry }  — 완성된 승인 요청만 서명한다(임의 바이트 서명 없음)
 *   transport 서버: submit(entry), read(uid)
 *   context   owner(), online(), session() → {epoch}, opening() → {uid, generation}
 *
 * 정상 흐름은 기존 Approve 한 번이다. 승인 순간의 본문을 고정해 서명하고, 원문·접속사건·큐가 단말에 내구 저장된
 * 뒤에만 "승인 대기(단절)"(D594)로 표시한다. 그것은 의뢰의에게 공개되었다는 뜻이 아니다. 승인 뒤 입력은 그대로
 * 둔다(승인본에 섞지 않고 응답으로 지우지 않는다). 실제 세션 종료는 "재인증 후 전송"으로 보류하고 큐를 지우지 않는다.
 * 다른 계정은 앞 의사의 큐를 보거나 보내지 못한다. 충돌은 서버 판과 내 승인 원문을 모두 남기고 자동으로 덮어쓰지 않는다.
 */
(function (root) {
  'use strict';

  const FIELDS = ['findings', 'conclusion', 'recommendation'];
  // 상태명은 영어(AGENTS §4), 단절 승인과 재인증 대기 표시는 D594·EMR-C 주문이 정한 문구를 쓴다.
  const STATUS_TEXT = Object.freeze({
    idle: '',
    signing: 'Approving',
    'pending-offline': '승인 대기(단절)',
    'awaiting-reauth': '재인증 후 전송',
    published: 'Approved',
    conflict: 'Conflict — 서버의 현재 판독과 내 승인 원문을 모두 보존했습니다. 자동으로 덮어쓰지 않습니다.',
    held: 'On Hold — 시각 또는 선행 판독 확인이 필요해 반영을 보류했습니다. 승인 원문은 보존되어 있습니다.',
    refused: 'Not Applied — 서버가 반영하지 않았습니다. 승인 원문은 보존되어 있습니다.',
    'not-saved': '승인을 저장하지 못했습니다. 입력한 내용은 그대로 있습니다.',
    locked: '로그인한 계정이 없어 승인할 수 없습니다. 입력한 내용은 그대로 있습니다.',
  });

  const sameOwner = (a, b) => !!a && !!b && ['issuer', 'subject', 'institutionId', 'deviceId', 'osUserId'].every(k => typeof a[k] === 'string' && a[k] === b[k]);
  const textOf = value => {
    if (!value || typeof value !== 'object' || !FIELDS.every(k => typeof value[k] === 'string')) throw new TypeError('report text required');
    return Object.freeze({ findings: value.findings, conclusion: value.conclusion, recommendation: value.recommendation });
  };
  /** 서명된 payload의 본문이 승인 순간 고정한 본문과 같은지(다른 내용 서명을 승인으로 표시하지 않는다). */
  function signedText(entry) {
    const b64 = String(entry && entry.envelope && entry.envelope.payload || '').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && payload.text && payload.text.kind === 'report' ? textOf(payload.text) : null;
  }
  const sameText = (a, b) => !!a && !!b && FIELDS.every(k => a[k] === b[k]);
  function newId() {
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function create(options) {
    const { view, store, signer, transport, context } = options || {};
    const need = (port, name, methods) => {
      if (!port || methods.some(m => typeof port[m] !== 'function')) throw new TypeError('KinOfflineReport.create: ' + name + ' port required');
    };
    need(view, 'view', ['readText', 'showReport', 'print']);
    if (!view.status || typeof view.status !== 'object') throw new TypeError('KinOfflineReport.create: view.status required');
    need(store, 'store', ['enqueue', 'list', 'observe', 'cached']);
    need(signer, 'signer', ['sign']);
    need(transport, 'transport', ['submit', 'read']);
    need(context, 'context', ['owner', 'online', 'session', 'opening']);

    const states = new Map();
    const stateOf = uid => states.get(uid) || { status: 'idle', eventId: null, owner: null, currentVersion: null, signedText: null, reason: null };
    function setState(uid, patch) {
      states.set(uid, Object.freeze({ ...stateOf(uid), ...patch }));
      render();
    }
    function render() {
      const opening = context.opening();
      const current = opening ? stateOf(opening.uid) : stateOf(null);
      // 표시는 현재 열린 검사와 현재 계정의 것만. 다른 계정의 승인 대기는 보이지 않는다.
      const visible = current.owner === null || sameOwner(current.owner, context.owner());
      view.status.textContent = STATUS_TEXT[visible ? current.status : 'idle'] || '';
    }

    /** 서버 응답은 보낸 세션이 아직 현재 세션일 때만 반영한다. 아니면 다음 전송이 같은 eventId로 영수증을 다시 받는다. */
    async function submit(uid, entry) {
      const epoch = context.session().epoch;
      let reply;
      try { reply = await transport.submit(entry); }
      catch (signal) {
        if (context.session().epoch !== epoch) return;
        if (signal && signal.status === 401 && signal.code === 'AUTH_SESSION_ENDED') setState(uid, { status: 'awaiting-reauth' });
        return; // 단절·timeout·5xx는 종료가 아니다: 승인 대기 유지
      }
      if (context.session().epoch !== epoch || !reply || reply.eventId !== entry.eventId) return;
      const next = { committed: 'published', duplicate: 'published', conflict: 'conflict', held: 'held', refused: 'refused', failed: 'pending-offline' }[reply.status];
      if (!next) return;
      setState(uid, { status: next, currentVersion: reply.currentVersion || null, reason: reply.reason || null });
    }

    async function observe(observation) {
      try { await store.observe(Object.freeze(observation)); return true; } catch { return false; }
    }

    return Object.freeze({
      /** 기존 Approve 한 번. 추가 확인창·재로그인·창 닫힘 없음. */
      async approve(target) {
        const t = target || {};
        const opening = context.opening();
        if (!opening || opening.uid !== t.uid) throw new TypeError('approve: the open study is required');
        const text = textOf(view.readText()); // 누른 순간의 본문. 이후 입력은 별도 작업본으로 남는다.
        const owner = context.owner();
        if (!owner) { setState(t.uid, { status: 'locked' }); return stateOf(t.uid); }
        setState(t.uid, { status: 'signing', owner, signedText: text });
        let entry;
        try {
          entry = (await signer.sign(Object.freeze({ uid: t.uid, recordId: t.recordId, baseVersionId: t.baseVersionId ?? null, text, owner }))).entry;
          if (!entry || !sameText(signedText(entry), text) || !sameOwner(entry.owner, owner)) throw new Error('signed other content');
        } catch { setState(t.uid, { status: 'not-saved' }); return stateOf(t.uid); }
        let receipt;
        try {
          receipt = await store.enqueue(entry);
          if (!receipt || receipt.eventId !== entry.eventId) throw new Error('no durable receipt');
        } catch { setState(t.uid, { status: 'not-saved' }); return stateOf(t.uid); }
        setState(t.uid, { status: 'pending-offline', eventId: entry.eventId });
        if (context.online()) await submit(t.uid, entry);
        return stateOf(t.uid);
      },

      /** 연결이 돌아오면 현재 계정 자신의 큐만 원래 eventId로 다시 보낸다. */
      async sync() {
        if (!context.online()) return;
        const owner = context.owner();
        if (!owner) return;
        const entries = await store.list(owner);
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (!entry || !sameOwner(entry.owner, owner)) continue; // 저장소가 다른 계정 것을 돌려줘도 보내지 않는다
          const uid = entry.access && entry.access.target && entry.access.target.studyId;
          if (typeof uid !== 'string') continue;
          const state = stateOf(uid);
          // 재시작 뒤에는 화면 상태가 비어 있다: 단말이 내구 저장한 미전송 승인을 그대로 이어받는다.
          if (state.status === 'idle') setState(uid, { status: 'pending-offline', eventId: entry.eventId, owner });
          else if (!['pending-offline', 'awaiting-reauth'].includes(state.status) || state.eventId !== entry.eventId) continue;
          await submit(uid, entry);
        }
      },

      /** 검사를 열면 본문을 자동으로 가져온다(추가 열기 클릭 없음). 늦은 응답은 같은 열기(uid+generation)에만 쓴다. */
      async open(uid) {
        const opening = context.opening();
        if (!opening || opening.uid !== uid) throw new TypeError('open: the selected study is required');
        const online = context.online();
        let body;
        try { body = online ? await transport.read(uid) : await store.cached(uid); } catch { body = null; }
        const now = context.opening();
        if (!body || !now || now.uid !== uid || now.generation !== opening.generation) return false;
        view.showReport(body);
        render();
        // 표시할 때마다 새 사건이다. 단절 중에는 IP를 관측하지 못했으므로 그렇게 기록한다.
        await observe({ action: 'client-shown', eventId: newId(), relatedEventId: null, uid, recordId: body.recordId, versionId: body.versionId,
          network: online ? 'online' : 'offline', ip: online ? null : 'not-observed', physicalOutput: null });
        return true;
      },

      /** 출력은 정확한 판에 고정한다. print()가 돌아온 것은 대화상자가 닫혔다는 보고일 뿐 종이 출력의 증거가 아니다. */
      async print(version) {
        const v = version || {};
        const opened = { action: 'print-opened', eventId: newId(), relatedEventId: null, uid: v.uid, recordId: v.recordId, versionId: v.versionId,
          network: context.online() ? 'online' : 'offline', ip: context.online() ? null : 'not-observed', physicalOutput: null };
        await observe(opened);
        try { await view.print(Object.freeze({ uid: v.uid, recordId: v.recordId, versionId: v.versionId })); }
        catch { return 'cancelled'; }
        await observe({ ...opened, action: 'print-done', eventId: newId(), relatedEventId: opened.eventId, physicalOutput: 'not-observed' });
        return 'dialog-returned';
      },

      state(uid) { return stateOf(uid); },
      render,
    });
  }

  const api = Object.freeze({ create, STATUS_TEXT });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinOfflineReport = api;
})(typeof window === 'object' ? window : null);
