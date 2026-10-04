/* KIN 작업 문맥 관문 (S7-U5, U5S-REQ-11). DOM·저장소·네트워크를 쓰지 않는다.
 *
 * 비동기 작업의 결과를 화면·공유 상태에 쓰기 직전에 "그 작업이 시작된 문맥이 지금도 그대로인가"를 한 자리에서 묻는다.
 * 요청이 떠날 때 capture()로 문맥을 잡고, 답·오류·finally·스트림 조각·디코딩·클립보드·타이머·구독이 무엇인가를 바꾸려 할
 * 때마다 commit(문맥, 효과)로 지난다. commit은 동기로 검사하고 동기 효과를 정확히 한 번 실행하거나 아무것도 하지 않는다 —
 * 효과 안에서 다시 기다린 뒤의 쓰기는 이 검사가 본 적 없는 시점의 쓰기이므로, 이어지는 일은 자기 commit을 또 지나야 한다.
 *
 * 문맥은 바꿀 수 없는 값이다: { session, workEpoch, uid, selectionSeq[, editRevision] }.
 *   · 문서 범위('document')는 검사 칸이 명시적 null이다 — 세션과 작업 세대만 본다.
 *   · 검사 범위('study')는 UID와 선택 순번을 함께 본다(A→B→A는 같은 선택이 아니다).
 *   · 편집기 범위('editor')는 편집 순번까지 본다(기다리는 사이 사람이 고친 글 위에 쓰지 않는다).
 *   · 수명주기 범위('lifecycle')는 업무가 아니라 이 문서의 진입·종료 안내만 바꾸는 일에 쓴다. 어느 상태에서든 잡을 수 있고
 *     세션과 작업 세대가 그대로인 동안만 통과한다.
 *   · 준비 문맥은 prepare()가 돌려준다. 로그아웃 준비의 보존 저장만 그것으로 지나고, 준비가 취소되거나 세션이 끝나면
 *     그 순간 쓸 수 없다(U5S-REQ-13).
 *
 * 상태는 unknown·active·preparing·ending·unconfirmed·confirmed 여섯이다(U5S-REQ-04). 세션 쪽 다섯(unknown·active·ending·
 * unconfirmed·confirmed)은 follow()로 붙인 세션 권위(auth.js)가 알리고, preparing은 이 관문의 prepare()/cancelPreparation()이
 * 만든다. 업무 범위의 문맥은 active에서만 통과한다. 한 문서는 신원을 한 번만 받는다 — 닫힌 문서나 이미 신원을 가진 문서에
 * 다른 신원이 오면 그 신원으로 다시 열지 않고 닫는다.
 */
(function (root) {
  'use strict';

  const CLOSED = ['ending', 'unconfirmed', 'confirmed'];
  const SOURCE_STATES = ['unknown', 'active', ...CLOSED];
  const SCOPES = ['document', 'study', 'editor', 'lifecycle'];
  // 호출만으로 본문이 끝까지 실행되지 않는 함수들. 이런 효과는 "동기로 한 번 실행"을 지킬 수 없어 실행 전에 거절한다.
  const DEFERRED_KINDS = ['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'];

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  /** JSON 값의 독립 사본. 준비가 잡은 원문은 부른 쪽이 나중에 고쳐도 달라지지 않아야 한다. */
  function snapshotOf(value) {
    return value === undefined ? undefined : deepFreeze(JSON.parse(JSON.stringify(value)));
  }

  function create() {
    let state = 'unknown';
    let session = null;
    let workEpoch = 0;
    let uid = null;
    let selectionSeq = 0;
    let editRevision = 0;
    let preparation = null;
    let preparations = 0;
    // 이 문서가 신원을 받은 적이 있는가. 한 번 받은 뒤에는 다른 신원으로 다시 열지 않는다.
    let adopted = false;
    let following = false;
    // 이 관문이 내준 문맥만 통과한다 — 지금 값을 베껴 만든 객체는 문맥이 아니다.
    const issued = new WeakSet();
    const listeners = new Set();

    function issue(context) {
      Object.freeze(context);
      issued.add(context);
      return context;
    }

    function notify(reason) {
      const event = Object.freeze({ reason, state, session, workEpoch });
      for (const listener of [...listeners]) {
        // 한 구독자의 실패가 전이를 반쯤 한 상태로 남기지 않게 한다.
        try { listener(event); } catch (_) {}
      }
    }

    function capture(scope) {
      if (!SCOPES.includes(scope)) throw new TypeError('KinWorkContext.capture: unknown scope ' + String(scope));
      if (scope === 'document') return issue({ session, workEpoch, uid: null, selectionSeq: null });
      if (scope === 'study') return issue({ session, workEpoch, uid, selectionSeq });
      if (scope === 'editor') return issue({ session, workEpoch, uid, selectionSeq, editRevision });
      return issue({ session, workEpoch, uid: null, selectionSeq: null, lifecycle: state });
    }

    function admits(context) {
      if (!context || typeof context !== 'object' || !issued.has(context)) return false;
      if (context.session !== session || context.workEpoch !== workEpoch) return false;
      if ('preparation' in context) return state === 'preparing' && preparation === context;
      if ('lifecycle' in context) return true;
      if (state !== 'active') return false;
      if (context.selectionSeq === null) return true;
      if (context.uid !== uid || context.selectionSeq !== selectionSeq) return false;
      return !('editRevision' in context) || context.editRevision === editRevision;
    }

    function commit(context, effect) {
      if (typeof effect !== 'function') throw new TypeError('KinWorkContext.commit: the effect must be a function');
      if (DEFERRED_KINDS.includes(Object.prototype.toString.call(effect).slice(8, -1)))
        throw new TypeError('KinWorkContext.commit: the effect must be synchronous (async and generator functions defer their body)');
      if (!admits(context)) return false;
      const result = effect();
      // 약속을 돌려주는 효과는 아직 끝나지 않은 일을 남긴다. 그 일의 쓰기는 이 검사를 지나지 않았으므로 조용히 넘기지 않는다.
      if (result && typeof result.then === 'function')
        throw new TypeError('KinWorkContext.commit: the effect returned a promise; continue under another commit');
      return true;
    }

    function select(next) {
      uid = next === undefined || next === null ? null : String(next);
      selectionSeq += 1;
      // 새 선택의 편집기는 다른 글이다.
      editRevision += 1;
      notify('select');
      return selectionSeq;
    }

    function edited() {
      editRevision += 1;
      notify('edit');
      return editRevision;
    }

    /**
     * 로그아웃 준비에 들어선다(active → preparing). 잡은 값(작성자·검사·기대 revision·전체 원문)은 여기서 얼려 준비 문맥에
     * 묶는다 — 보존 저장은 URL이나 메서드가 아니라 살아 있는 이 문맥으로만 지난다. 준비 중에 다시 부르면(충돌 뒤 사람이
     * 확인한 재시도처럼 기대 revision이 달라졌을 때) 앞선 준비 문맥은 그 순간 끝나고 새 문맥이 선다.
     */
    function prepare(detail) {
      if (state !== 'active' && state !== 'preparing') return null;
      workEpoch += 1;
      state = 'preparing';
      preparations += 1;
      preparation = issue({
        session, workEpoch, uid, selectionSeq,
        preparation: typeof detail?.preparationId === 'string' && detail.preparationId ? detail.preparationId : preparations,
        owner: snapshotOf(detail?.owner ?? null),
        expectedRevision: snapshotOf(detail?.expectedRevision ?? null),
        snapshot: snapshotOf(detail?.snapshot ?? null),
      });
      notify('prepare');
      return preparation;
    }

    /** 준비를 취소하고 편집으로 돌아간다(preparing → active). 새 작업 세대라 준비 전의 문맥도, 준비 문맥도 되살아나지 않는다. */
    function cancelPreparation(context) {
      if (state !== 'preparing' || !context || preparation !== context) return false;
      preparation = null;
      state = 'active';
      workEpoch += 1;
      notify('cancel');
      return true;
    }

    function lifecycle(event) {
      const next = SOURCE_STATES.includes(event?.state) ? event.state : 'unknown';
      const id = typeof event?.session === 'string' && event.session ? event.session : null;
      if (next === 'active') {
        // 구독할 때 다시 받는 지금 상태.
        if (id !== null && (state === 'active' || state === 'preparing') && id === session) return;
        if (id !== null && state === 'unknown' && !adopted) {
          adopted = true;
          session = id;
          state = 'active';
          workEpoch += 1;
          notify('lifecycle');
          return;
        }
        // 닫힌 문서에 늦게 온 active(끝난 세션의 늦은 완료, 다른 로그인)는 아무것도 바꾸지 않는다 — 닫힘 안내도 그대로다.
        if (state !== 'active' && state !== 'preparing') return;
      }
      if (CLOSED.includes(next)) {
        if (CLOSED.includes(state) && (id === null || id === session)) {
          // 같은 종료의 결과(요청 중 → 확인·미확인, 다시 시도). 이미 닫힌 문서의 닫힘 안내는 이어진다.
          if (state === next) return;
          state = next;
          notify('lifecycle');
          return;
        }
        preparation = null;
        state = next;
        if (id !== null) session = id;
        workEpoch += 1;
        notify('lifecycle');
        return;
      }
      // unknown, 또는 업무 중인 문서에 온 다른 신원(식별값 없는 active 포함): 그 신원으로 바꾸지 않고 닫는다.
      if (state === 'unknown' && session === null && next === 'unknown') return;
      preparation = null;
      state = 'unknown';
      session = null;
      workEpoch += 1;
      notify('lifecycle');
    }

    /** 세션 권위를 붙인다. source.onLifecycle(listener)는 지금 상태를 한 번 알리고 그 뒤의 전이를 동기로 알려야 한다. */
    function follow(source) {
      if (following) throw new Error('KinWorkContext.follow: this gate already follows a session source');
      if (!source || typeof source.onLifecycle !== 'function')
        throw new TypeError('KinWorkContext.follow: the source must provide onLifecycle(listener)');
      following = true;
      source.onLifecycle(lifecycle);
    }

    function onInvalidate(listener) {
      if (typeof listener !== 'function') throw new TypeError('KinWorkContext.onInvalidate: the listener must be a function');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }

    return {
      capture, commit, admits,
      select, edited, prepare, cancelPreparation, follow, onInvalidate,
      state: () => state,
      session: () => session,
      selection: () => ({ uid, selectionSeq, editRevision }),
      preparation: () => preparation,
    };
  }

  // 이 문서의 관문 하나. create()는 따로 도는 관문(시험, 다른 창을 대신 조정하는 코드)을 만든다.
  const api = Object.freeze({ ...create(), create, STATES: Object.freeze(['unknown', 'active', 'preparing', ...CLOSED]) });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinWorkContext = api;
})(typeof window === 'object' ? window : null);
