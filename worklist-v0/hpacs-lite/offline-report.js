/* EMR-C1 단절 판독 승인 화면 제어 (미연결 모듈). 페이지·main.html에 아직 등록하지 않는다(C2가 W6/W4 편집기에 연결).
 *
 * 자체 fetch·전역 인증·페이지 부팅이 없다. 생성자가 받는 명시 접점만 쓴다.
 *   view      readText() → {findings, conclusion, recommendation}, status(요소), showReport(body), print() → Promise
 *   store     관리형 단말의 보호 저장(C-NATIVE): queue(owner) → C 큐 모델의 enqueue/send adapter,
 *             observe(observation), cached(uid)
 *   signer    단말 서명(C-NATIVE): sign(request) → { entry }  — 완성된 승인 요청만 서명한다(임의 바이트 서명 없음)
 *   transport 서버: submit(entry), read(uid)
 *   context   owner(), online(), session() → {epoch}, opening() → {uid, generation}, accountGeneration(), subscribe(callback)
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
    need(view, 'view', ['readText', 'showReport', 'clearReport', 'print']);
    if (!view.status || typeof view.status !== 'object') throw new TypeError('view.status required');
    // queue(owner) implements the C queue model's enqueue/send contract. It owns eligibility, receipts and ordering.
    need(store, 'store', ['queue', 'observe', 'cached']);
    need(signer, 'signer', ['sign']);
    need(transport, 'transport', ['submit', 'read']);
    need(context, 'context', ['owner', 'online', 'session', 'opening', 'accountGeneration', 'subscribe']);
    const scheduler = options.scheduler || { schedule: (f, ms) => setTimeout(f, ms), cancel: id => clearTimeout(id) };
    need(scheduler, 'scheduler', ['schedule', 'cancel']);
    const states = new Map(), selections = new Map(), records = new Map(), lanes = new Map(), queues = new Map(), shown = new Map();
    let disposed = false, drain = null, retry = null, retryCount = 0;
    const key = parts => JSON.stringify(parts);
    const ownerKey = owner => owner ? key(['issuer', 'subject', 'institutionId', 'deviceId', 'osUserId'].map(k => owner[k])) : null;
    const copyOwner = () => context.owner() ? Object.freeze({ ...context.owner() }) : null;
    const idle = () => Object.freeze({ status: 'idle', eventId: null, owner: null, currentVersion: null, signedText: null, reason: null });
    const recordKey = (owner, uid, recordId) => key([ownerKey(owner), uid, recordId]);
    const eventKey = (owner, uid, recordId, eventId) => key([ownerKey(owner), uid, recordId, eventId]);
    function stateOf(uid, recordId) {
      const owner = context.owner(), rk = recordId ?? records.get(key([ownerKey(owner), uid]));
      const selection = selections.get(recordKey(owner, uid, rk));
      return selection ? (selection.eventId === null ? selection.state : states.get(eventKey(owner, uid, rk, selection.eventId))) || idle() : idle();
    }
    function paint() {
      const opening = context.opening();
      view.status.textContent = STATUS_TEXT[opening ? stateOf(opening.uid, opening.recordId).status : 'idle'] || '';
    }
    function capture(scope, target = {}, screen = false) {
      const owner = copyOwner(), session = Object.freeze({ ...context.session() }), opening = context.opening();
      const lane = key([ownerKey(owner), scope, target.uid ?? null, target.recordId ?? null, target.eventId ?? null]);
      const jobGeneration = (lanes.get(lane) || 0) + 1;
      lanes.set(lane, jobGeneration);
      const accountGeneration = context.accountGeneration();
      if (!Number.isSafeInteger(accountGeneration)) throw new TypeError('authority account generation required');
      return Object.freeze({ owner, session, accountGeneration, lane, jobGeneration, ...target,
        screen, openingGeneration: opening?.generation });
    }
    const valid = token => !disposed && sameOwner(token.owner, context.owner()) &&
      token.accountGeneration === context.accountGeneration() && token.session.epoch === context.session().epoch &&
      lanes.get(token.lane) === token.jobGeneration;
    const visible = token => {
      const opening = context.opening();
      return !!opening && opening.uid === token.uid && opening.generation === token.openingGeneration &&
        (!opening.recordId || !token.recordId || opening.recordId === token.recordId);
    };
    /** Every continuation and external effect enters here: no await between ownership check and effect. */
    function apply(token, effect) {
      if (!valid(token) || (token.screen && !visible(token))) return { stale: true };
      return { stale: false, value: effect() };
    }
    const stale = Object.freeze({ status: 'stale' });
    const currentResult = token => valid(token) ? stateOf(token.uid, token.recordId) : stale;
    function select(token, patch, sequence = Infinity) {
      const rk = recordKey(token.owner, token.uid, token.recordId);
      const state = Object.freeze({ ...idle(), ...patch, owner: token.owner });
      records.set(key([ownerKey(token.owner), token.uid]), token.recordId);
      selections.set(rk, { eventId: state.eventId, sequence, state });
      if (state.eventId !== null) states.set(eventKey(token.owner, token.uid, token.recordId, state.eventId), state);
      paint();
    }
    function queueFor(token) {
      const k = ownerKey(token.owner);
      if (!queues.has(k)) queues.set(k, store.queue(token.owner));
      return queues.get(k);
    }
    const sessionEnded = signal => !!signal && ((signal.status === 401 && signal.code === 'AUTH_SESSION_ENDED') ||
      ([403, 409].includes(signal.status) && signal.code === 'AUTH_SESSION_MISMATCH'));
    function updateEvent(token, entry, state, evidence) {
      return apply(token, () => {
        if (!sameOwner(entry.owner, token.owner) || entry.eventId !== token.eventId || entry.access.target.studyId !== token.uid || entry.access.target.recordId !== token.recordId) return;
        const ek = eventKey(token.owner, token.uid, token.recordId, entry.eventId), prior = states.get(ek);
        if (prior?.status === 'published' && state !== 'committed') return;
        const status = { pending: 'pending-offline', 'sent-unknown': 'pending-offline', committed: 'published',
          'awaiting-reauth': 'awaiting-reauth', conflict: 'conflict', held: 'held', refused: 'refused', corrupt: 'held' }[state];
        states.set(ek, Object.freeze({ ...idle(), ...prior, owner: token.owner, eventId: entry.eventId, signedText: signedText(entry),
          status, currentVersion: evidence?.currentVersion ?? prior?.currentVersion ?? null, reason: evidence?.reason ?? null }));
        const rk = recordKey(token.owner, token.uid, token.recordId), selection = selections.get(rk);
        if (!selection || entry.deviceSequence > selection.sequence) {
          selections.set(rk, { eventId: entry.eventId, sequence: entry.deviceSequence });
          records.set(key([ownerKey(token.owner), token.uid]), token.recordId);
        }
        paint();
      });
    }
    function retryLater(token) {
      apply(token, () => {
        if (retry) scheduler.cancel(retry.id);
        const handle = { token, id: null };
        handle.id = scheduler.schedule(() => apply(token, () => {
          if (retry !== handle) return;
          retry = null;
          sync();
        }), Math.min(30000, 500 * (2 ** Math.min(retryCount++, 6))));
        retry = handle;
      });
    }
    function sync() {
      if (disposed || !context.online() || !context.owner() || context.session().state === 'ended') return Promise.resolve(stale);
      // Reconnect joins the running job; it never invalidates that job's generation.
      if (drain && valid(drain.token)) {
        apply(drain.token, () => { drain.dirty = true; });
        return drain.promise;
      }
      const token = capture('drain'), handle = { token, dirty: false, promise: null };
      apply(token, () => {
        if (retry) { scheduler.cancel(retry.id); retry = null; }
        drain = handle;
      });
      const run = async () => {
        let retryable = false;
        do {
          if (apply(token, () => { handle.dirty = false; }).stale) return stale;
          const sends = new Map();
          const sendToken = entry => {
            if (!sends.has(entry.eventId)) sends.set(entry.eventId, capture('send', { uid: entry.access.target.studyId,
              recordId: entry.access.target.recordId, eventId: entry.eventId }));
            return sends.get(entry.eventId);
          };
          try {
            const launched = apply(token, () => queueFor(token).send({
              submit: entry => {
                const started = apply(token, () => {
                  if (!sameOwner(entry.owner, token.owner)) return { stale: true };
                  const t = sendToken(entry);
                  return apply(t, () => transport.submit(entry, Object.freeze({ owner: t.owner, session: t.session, accountGeneration: t.accountGeneration })));
                });
                const dispatched = started.stale ? started : started.value;
                return dispatched.stale ? Promise.reject({ kind: 'stale' }) : Promise.resolve(dispatched.value).catch(signal => {
                  // Normalize the native queue signal; network failures never borrow a new session.
                  if (sessionEnded(signal)) throw { ...signal, kind: 'http' };
                  throw signal;
                });
              },
              findAdoption: (id, entry) => {
                const dispatched = apply(token, () => transport.findAdoption ? transport.findAdoption(id, entry, token) : null);
                return dispatched.stale ? Promise.resolve(null) : dispatched.value;
              },
            }, { state: 'active', ...token.owner }, {
              active: () => valid(token),
              changed: (entry, state, evidence) => {
                apply(token, () => updateEvent(sendToken(entry), entry, state, evidence));
              },
            }));
            if (launched.stale) return stale;
            const rows = await launched.value;
            if (apply(token, () => { retryable = rows.some(r => r.retryable); }).stale) return stale;
          } catch {
            if (apply(token, () => { retryable = true; }).stale) return stale;
          }
        } while (handle.dirty && valid(token));
        apply(token, () => {
          if (retryable) retryLater(token); else retryCount = 0;
        });
        return { status: 'drained' };
      };
      // Start on a microtask so concurrent callers always see the same promise.
      handle.promise = Promise.resolve().then(run).finally(() => apply(token, () => { if (drain === handle) drain = null; }));
      return handle.promise;
    }
    async function observe(token, observation) {
      const started = apply(token, () => store.observe(Object.freeze({ ...observation, owner: token.owner, session: token.session,
        accountGeneration: token.accountGeneration })));
      if (started.stale) return false;
      try { await started.value; return !apply(token, () => true).stale; } catch { return false; }
    }
    function render() {
      if (disposed || !context.owner()) { view.status.textContent = ''; return; }
      const token = capture('render');
      apply(token, paint);
    }
    const unsubscribe = context.subscribe(() => {
      if (disposed) return;
      if (retry) { scheduler.cancel(retry.id); retry = null; }
      // W6 keeps each owner's editor draft; only the displayed report projection is cleared here.
      view.clearReport();
      render();
      sync();
    });
    return Object.freeze({
      async approve(target) {
        const t = Object.freeze({ ...target }), opening = context.opening();
        if (!opening || opening.uid !== t.uid) throw new TypeError('approve: the open study is required');
        const text = textOf(view.readText());
        const token = capture('approval', { uid: t.uid, recordId: t.recordId });
        if (!token.owner) return Object.freeze({ ...idle(), status: 'locked' });
        if (apply(token, () => select(token, { status: 'signing', signedText: text })).stale) return stale;
        let entry;
        try {
          const signed = apply(token, () => signer.sign(Object.freeze({ uid: t.uid, recordId: t.recordId,
            baseVersionId: t.baseVersionId ?? null, text, owner: token.owner, session: token.session, accountGeneration: token.accountGeneration })));
          if (signed.stale) return stale;
          entry = (await signed.value).entry;
          if (!valid(token)) return stale;
          if (!entry || !sameText(signedText(entry), text) || !sameOwner(entry.owner, token.owner) ||
              entry.access?.target?.studyId !== t.uid || entry.access?.target?.recordId !== t.recordId) throw new Error('signed other content');
        } catch {
          apply(token, () => select(token, { status: 'not-saved', signedText: text }));
          return currentResult(token);
        }
        try {
          const put = apply(token, () => queueFor(token).enqueue(entry));
          if (put.stale) return stale;
          const saved = await put.value;
          if (!valid(token)) return stale;
          // The queue validates the digest of the exact entry and the complete native durable receipt.
          if (saved?.status !== 'pending-offline' || saved.receipt?.eventId !== entry.eventId) throw new Error('no durable receipt');
        } catch {
          apply(token, () => select(token, { status: 'not-saved', signedText: text }));
          return currentResult(token);
        }
        if (apply(token, () => select(token, { status: 'pending-offline', signedText: text, eventId: entry.eventId }, entry.deviceSequence)).stale) return stale;
        const started = apply(token, () => context.online() ? sync() : null);
        if (!started.stale) await started.value;
        return currentResult(token);
      },
      sync,
      async open(uid) {
        const opening = context.opening();
        if (!opening || opening.uid !== uid) throw new TypeError('open: the selected study is required');
        const token = capture('read', { uid }, true), online = context.online();
        if (!token.owner) return false;
        let body;
        try {
          const start = apply(token, () => online ? transport.read(uid, token) : store.cached(uid, token));
          if (start.stale) return false;
          body = await start.value;
        } catch { return false; }
        if (!body || typeof body.recordId !== 'string' || typeof body.versionId !== 'string' || (body.uid && body.uid !== uid)) return false;
        const observation = { action: 'client-shown', eventId: newId(), relatedEventId: null, uid, recordId: body.recordId, versionId: body.versionId,
          network: online ? 'online' : 'offline', ip: online ? null : 'not-observed', physicalOutput: null };
        if (!online && !(await observe(token, observation))) return false;
        const painted = apply(token, () => {
          shown.set(recordKey(token.owner, uid, body.recordId), body.versionId);
          view.showReport(body); paint();
        });
        if (painted.stale) return false;
        if (online) await observe(token, observation);
        return !apply(token, () => true).stale;
      },
      async print(version) {
        const v = Object.freeze({ ...version });
        const token = capture('print', { uid: v.uid, recordId: v.recordId, versionId: v.versionId }, true);
        const pinned = () => !shown.has(recordKey(token.owner, v.uid, v.recordId)) || shown.get(recordKey(token.owner, v.uid, v.recordId)) === v.versionId;
        const opened = { action: 'print-opened', eventId: newId(), relatedEventId: null, uid: v.uid, recordId: v.recordId, versionId: v.versionId,
          network: context.online() ? 'online' : 'offline', ip: context.online() ? null : 'not-observed', physicalOutput: null };
        if (!pinned()) return 'cancelled';
        if (!(await observe(token, opened))) return valid(token) && visible(token) ? 'not-recorded' : 'cancelled';
        const started = apply(token, () => pinned() ? view.print(v) : null);
        if (started.stale || started.value === null) return 'cancelled';
        try { await started.value; } catch { return 'cancelled'; }
        if (!pinned() || apply(token, () => true).stale) return 'cancelled';
        if (!(await observe(token, { ...opened, action: 'print-done', eventId: newId(), relatedEventId: opened.eventId, physicalOutput: 'not-observed' }))) return 'cancelled';
        return 'dialog-returned';
      },
      state: stateOf,
      render,
      dispose() {
        if (retry) scheduler.cancel(retry.id);
        disposed = true;
        if (typeof unsubscribe === 'function') unsubscribe();
      },
    });
  }

  const api = Object.freeze({ create, STATUS_TEXT });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinOfflineReport = api;
})(typeof window === 'object' ? window : null);
