

    /**
     * ── 소견 인용 (S3-U2b) ──
     *
     * Image Findings의 한 출처를 판독문에 넣는다. 순서가 계약이다: **서버가 먼저**
     * 문장과 증언을 한 쓰기로 기록하고, 200을 받은 **뒤에야** 화면의 글자가 바뀐다.
     * 거절·오프라인·비서버 모드에서는 판독문을 한 글자도 건드리지 않는다 — 증언 없는
     * 문장을 만들지 않기 위해서다.
     *
     * 인용 집합은 `appState[uid].draft` **바깥**에 산다. 초안 객체는 저장할 때마다
     * 새로 만들어지고 서버 투영이 통째로 갈아끼우므로, 그 안에 두면 조용히 사라진다.
     * 그리고 **사라진 것과 아직 모르는 것은 다르다** — 모르면 `citationIds` 키를 아예
     * 보내지 않는다. `[]`는 "내 초안의 인용을 전부 지워라"라는 뜻이기 때문이다.
     */
    const citations = KinReportCitation.createState();
    /** 이 검사의 전용 읽기를 실제로 시도했는가 / 그 결과 안내 문구. */
    const citationReads = new Map(), citationNotes = new Map();
    let citationListOpen = false;

    /**
     * 검사마다 하나의 사실: **이 문서에 서버가 아직 확인하지 않은 글이 있다.** 글을 비교해 짐작하지 않고 이 문서가 한 일로만
     * 세운다 — 편집기의 글을 바꿨거나(`recordReportEdit`: 사람의 타건과 `editReport`), 그 글을 싣고 나간 쓰기가 있다(초안
     * 명령 경로의 `onWrite`: write·preserve·writeOnUnload). 서버에서 온 글(목록·폴링·bootstrap·다른 탭의 저장)과 버리기·
     * 확정 명령은 세우지 않는다. 내리는 것은 지금의 글 그대로를 서버가 확인했을 때와 사람이 서버 것을 골랐을 때·버렸을 때뿐이다.
     * 자동 저장·로그아웃 보존·떠나기 경고·폴링의 입력 보호가 모두 이 표시 하나만 본다.
     */
    const reportConverge = new Set();
    /**
     * 자동 저장이 실패한 검사와 그 뒤에 할 일. 같은 글을 20초마다 다시 보내 같은 실패를 다시 알리지 않는다: 처음 한 번만
     * 알린다. 서버가 그 검사에 쓸 수 없다고 답한 거절(4xx — 권한·기관 이동으로 목록에서 사라진 검사 등)은 다시 보내도 같은
     * 답이므로 자동 저장을 멈추고("stop"), 지나갈 수 있는 실패(5xx·결과 모름)는 조용히 다시 해 본다("retry"). 글과 표시는
     * 어느 쪽이든 그대로다 — Log out과 떠나기 경고는 표시만 보므로 그 글을 그대로 묻는다. 그 검사의 글이 다시 바뀌거나,
     * 저장이 확인되거나, 연결이 되살아나면 지운다.
     */
    const reportSaveFailures = new Map();
    function markConverge(uid) {
      if (!uid) return;
      reportConverge.add(uid);
      if (uid === selectedUid) renderDraftBar();
    }
    /** Only this document's recorded edits/commands can require a write. */
    function reportNeedsWrite() {
      return !!selectedUid && reportConverge.has(selectedUid);
    }
    /**
     * 삽입(인용·구조화)이 싣고 나가는 글은 지금 글에 넣을 문장을 더한, 아직 화면에 없는 글이다. 그 쓰기도 표시를 세운다
     * (답을 기다리는 동안 폴링이 편집기를 다시 그리지 않게 한다). 그런데 서버가 그 삽입을 기록하지 않았다고 분명히 답했고
     * (거절), 삽입을 누른 뒤로 편집기가 그대로이며, 삽입 전에 표시가 없었으면 — 이 문서에 확인되지 않은 글은 여전히 없다.
     * 그때 표시를 남기면 고치지 않은 검사의 저장된 판독문이 20초 뒤 초안으로 보내진다(U5CLI-F10과 같은 부류).
     * `pristineEditor`는 삽입을 보내기 전에 "표시가 없는 지금의 편집기"를 잡고(표시가 있으면 null), `insertLeftNoText`는
     * 실패한 삽입이 그 상태를 그대로 두었는지를 답한다. 결과를 모르는 삽입(서버에 닿았을 수 있다)과 충돌은 표시를 남긴다.
     */
    function pristineEditor(uid) {
      return uid === selectedUid && !reportConverge.has(uid) ? work.capture("editor") : null;
    }
    function insertLeftNoText(pristine, result) {
      return !!pristine && work.admits(pristine)
        && (result.outcome === "owner" || (result.outcome === "refused" && result.answer?.status !== 503));
    }

    /**
     * 폴링이 한 검사의 상태를 합칠 때 **화면 것을 지켜야 하는 칸**. 규칙은 여기 하나뿐이고
     * 폴링의 세 자리가 모두 이것을 쓴다 — 세 곳이 각자 판단하면 언젠가 한 곳만 고쳐진다.
     *
     *   version — 고른 검사에 로컬 편집이 있으면 그 글이 딛고 선 판을 지킨다.
     *   draft  — 아직 서버에 보내지 못한 글. 삽입이 나가 있는 동안 검사를 옮기면 그 타건은
     *     **여기에만** 담겨 있고(쓰기는 미뤘다), 폴링이 서버 투영으로 갈아끼우면 사람이 친
     *     글이 어디에도 남지 않는다. 그래서 수렴 표시가 있는 검사는 고르지 않았어도 지킨다.
     *     수렴이 끝나 표시가 내려간 뒤에는 평소처럼 서버 투영을 받는다.
     */
    function preservedLocal(uid, mine) {
      const local = {};
      if (reportConverge.has(uid)) {
        if (uid === selectedUid) local.version = mine?.version ?? 0;
        local.draft = mine?.draft ?? null;
        // 초안과 그 revision은 한 쌍이다. 화면의 초안을 지키면서 revision만 폴링의 것으로 바꾸면, 본 적 없는 서버 초안을
        // 기준으로 쓰게 된다.
        local.draftRevision = mine?.draftRevision;
        local.draftEpoch = mine?.draftEpoch;
      }
      return local;
    }
    /** 폴링 응답 한 건을 그 검사의 화면 상태에 합친다. 가려진 예비 판독은 서버가 본문을 안 준다. */
    function mergeObservedReportState(uid, st) {
      // An observation can update an idle document, including its draft command baseline.
      const mine = appState[uid] ?? {};
      if (!reportConverge.has(uid) && st)
        draftClient.observe(uid, st.draftRevision, st.prelimHidden ? undefined : st.draft ?? null);
      return { ...mine, ...st, ...preservedLocal(uid, mine) };
    }

    /**
     * A person's server choice (or confirmed discard/commit) replaces all report baselines together.
     *
     * 읽어 온 상태로 바꾸는 선택(Load Server Draft·Reload Report·최신 불러오기)은 초안 명령 경로의 기준도 함께 바꿔야 하므로
     * 그 검사에 나가 있는 명령이 없을 때만 된다. `confirmed`는 확정·버리기의 답이다: 그 명령이 기준을 이미 그 상태로 옮겼고
     * 뒤에 줄 선 명령은 그 위에서 나간다 — 서버가 받아들인 확정을 여기서 실패로 바꾸지 않는다.
     */
    function replaceReportState(uid, st, { confirmed = false } = {}) {
      const rebased = !!st && (demoMode || draftClient.replace(uid, st.draftRevision, st.draft ?? null));
      if (!st || (!rebased && !confirmed))
        throw new Error("서버 판독문의 기준을 확인하지 못했습니다. 다시 불러오세요.");
      reportConverge.delete(uid);
      reportSaveFailures.delete(uid);
      recordReportOrigin(uid, renderedOrigin(st));
      citations.forget(uid); citationNotes.delete(uid);
      structureState.forget(uid); structureNotes.delete(uid);
      return { ...appState[uid], ...st, draft: st.draft ?? null };
    }

    /** 삽입이 나가 있는 동안의 비-keepalive 초안 저장을 **전부** 비켜세운다(B1). */
    let insertInFlight = false;
    /**
     * 나가 있는 초안 버리기의 수. 버리기의 답도 화면의 글과 서버 행을 함께 바꾼다(편집기가 저장된 판독문으로 돌아가고 표시가
     * 내려간다) — Log out이 그 답을 보기 전에 글을 잡으면 사람이 버리기로 한 글을 보존 저장이 초안으로 되살린다.
     */
    let discardsOut = 0;
    /**
     * 나가 있는 확정·삽입·버리기가 끝날 때. Log out은 그 답을 본 뒤의 화면을 잡아야 하므로 이것을 기다린다 — 사람에게 "끝난 뒤
     * 다시 누르라"고 하지 않는다. 그 표시들이 내려가는 자리(자기 것만 내린다)가 기다리는 쪽을 깨운다.
     */
    const idleWaiters = [];
    function workBusy() { return commitInFlight || insertInFlight || discardsOut > 0; }
    function workIdle() {
      return workBusy() ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
    }
    function wakeIdle() {
      if (!workBusy()) for (const wake of idleWaiters.splice(0)) wake();
    }
    /**
     * 초안의 명령 프로토콜(S7-U5 U5S-REQ-15·17, report-draft-client.js). 이 문서가 초안을 바꾸는 모든 길 — 자동 저장·검사
     * 이동·탭 닫기·재기준·인용 삽입·구조화 적용·초안 버리기·확정·로그아웃 준비의 보존·Recover Draft — 이 이것 하나로 간다.
     * 요청마다 작성자와 그 글이 딛고 선 초안 revision, 전체 원문을 싣고, 서버는 저장된 revision이 그것과 같을 때만 바꾼다.
     * 한 검사의 명령은 차례로 나간다(뒤의 명령은 앞의 명령이 올린 revision을 싣는다). 그래서 끊긴 쓰기가 늦게 닿아도 그 뒤의
     * 글을 덮지 못하고, 결과를 모르는 쓰기 뒤에는 다음 명령이 서버 상태부터 읽는다. 저장 확인은 답의 봉투(작성자·revision·
     * 전체 원문)가 보낸 것과 전부 같을 때뿐이다.
     */
    const draftClient = KinReportDraftClient.create({ transport, base: API,
      // 이 문서의 글을 싣고 나간 쓰기는 답이 확인할 때까지 표시로 남는다. 버리기·확정은 표시를 세우지 않는다(U5CLI-F10).
      onWrite: uid => reportConverge.add(uid) });

    /** 점유 거절(REPORT_HELD): 누가 잡고 있는지 화면에 반영하고 그 검사에 한 번만 알린다. */
    function noteHeld(uid, holder) {
      appState[uid] = { ...appState[uid], holder };
      syncStudy(uid);
      if (uid === selectedUid) { updateReportButtons(); loadReport(); }
      if (warnedFor !== uid) {
        warnedFor = uid;
        toast(`${displayActor(holder)} 님이 판독 중입니다 — 저장되지 않았습니다`, "err");
      }
    }

    function draftFailureText(result) {
      return result.message ?? (result.outcome === "unknown" ? "서버의 답을 확인하지 못했습니다"
        : result.outcome === "conflict" ? "서버의 초안이 이 화면과 다릅니다"
        : result.outcome === "owner" ? "이 화면의 계정으로 쓴 초안이 아니라고 서버가 답했습니다"
        : "요청을 보내지 못했습니다");
    }

    /**
     * 저장되지 않은 초안 명령의 결과를 사실대로 남긴다(saved는 부른 쪽이 다룬다). 명령 경로가 이미 서버의 지금 초안을 읽어
     * 확인을 끝낸 뒤의 결과다 — 같은 글이거나 이 문서의 글과의 충돌, 답만 잃은 저장은 여기 오지 않는다. 남은 충돌은 자동
     * 쓰기를 멈추고 사람이 한 번 고르게 하고(openDraftConflict), 결과를 모르는 쓰기와 거절은 수렴 표시로 남겨 저장된 것처럼
     * 두지 않는다. 떠나지 않은 요청(문맥이 무효), 서버가 알린 세션 종료(종료 조정이 맡는다), 더 새 저장에 합쳐진 쓰기는 알릴
     * 실패가 아니다. 작성자 대조의 거절은 그 쓰기 하나의 거절이다 — 아무것도 다른 계정으로 저장되지 않았고, 화면을 닫을
     * 일이 아니다. `quiet`는 부른 쪽이 자기 자리에 이미 알렸을 때(또는 같은 실패를 이미 알렸을 때), `converge: false`는
     * 화면의 글을 다시 보낼 일이 아닐 때(버리기, 아무것도 남기지 않은 삽입 거절), `discard`는 실패한 것이 버리기일 때다.
     */
    function draftNotSaved(uid, at, result, { quiet = false, converge = true, discard = false } = {}) {
      // withdrawn: 차례가 왔을 때 보낼 글이 없었다(그 글은 그 사이 확정됐거나 사람이 버렸다) — 실패가 아니다.
      if (["unsent", "auth", "merged", "withdrawn"].includes(result.outcome)) return;
      work.commit(at, () => {
        if (converge) reportConverge.add(uid);
        if (result.outcome === "conflict") { openDraftConflict(uid); return; }
        if (result.code === "REPORT_HELD") { noteHeld(uid, result.answer?.body?.holder); return; }
        if (uid === selectedUid) renderDraftBar();
        if (quiet) return;
        // 버리기의 실패는 저장의 실패가 아니다 — 무엇이 되지 않았는지를 그대로 말한다. 화면의 글은 어느 쪽이든 그대로다.
        if (discard) toast(result.outcome === "unknown"
          ? "초안을 버렸는지 확인하지 못했습니다 — 화면은 그대로 두었습니다. 서버의 상태는 다음 새로 고침에 반영됩니다"
          : "초안을 버리지 못했습니다: " + draftFailureText(result), "err");
        else toast(result.outcome === "unknown"
          ? "초안 저장을 확인하지 못했습니다 — 입력한 내용은 그대로 있고, 다음 저장이 서버 상태부터 확인합니다"
          : "서버 저장 실패: " + draftFailureText(result), "err");
      });
    }

    /**
     * 인용 전용 읽기. 판독문 관문(기관·예비 판독)에 더해 **소견 가독을 다시 거는**
     * 유일한 표면이고, 축약된 건과 `sameTextCount`도 여기서만 온다.
     * 같은 검사를 한 번 확인했으면 다시 묻지 않는다 — 다시 묻는 것은 사람이 고르는 일이다.
     */
    async function ensureCitations(uid, { force = false } = {}) {
      if (!uid || !serverMode || offline || demoMode) return false;
      if (!KinAuth.has("radiologist") || appState[uid]?.prelimHidden) return false;
      if (citationReads.has(uid)) return false;
      if (!force && (citations.known(uid) || citationNotes.has(uid))) return false;
      const ticket = {};
      citationReads.set(uid, ticket);
      // 이 읽기를 시작한 문맥. 답도 실패도 표시줄도 이것을 지난다 — 로그아웃 준비·그 취소·세션 종료 뒤에 온 것은 확인 상태도
      // 안내도 바꾸지 않는다(편집으로 돌아간 뒤에는 그때의 문맥으로 다시 읽는다).
      const at = work.capture("document");
      let mine = true;
      try {
        const answer = await api("GET", `/studies/${encodeURIComponent(uid)}/report/citations`, undefined, undefined, at);
        // 늦게 온 답이 더 새 답을 덮지 않는다. 상태는 uid로 키가 잡혀 있으므로
        // 다른 검사의 답이 이 검사에 들어올 길은 없다.
        if (!work.admits(at) || citationReads.get(uid) !== ticket) return mine = false;
        citations.confirm(uid, answer);
        citationNotes.delete(uid);
        return true;
      } catch (e) {
        if (!work.admits(at) || citationReads.get(uid) !== ticket) return mine = false;
        // 확인하지 못한 것과 인용이 없는 것은 다르다. 모른다고 말하고, 키는 만들지 않는다.
        citationNotes.set(uid, "인용 건수를 확인하지 못했습니다: " + e.message);
        return false;
      } finally {
        // 이 읽기의 표는 이 읽기가 치운다(자기 것만).
        if (citationReads.get(uid) === ticket) citationReads.delete(uid);
        // 버려진 읽기(더 새 읽기가 맡았거나 문맥이 무효가 됐다)는 표시줄도 그리지 않는다 — 그리는 것은 맡은 읽기다.
        if (mine) work.commit(at, () => { if (uid === selectedUid) renderCitationBar(); });
      }
    }

    /**
     * **삽입 뒤 서버 행을 모르게 됐을 때 초안 쪽 상태를 되돌린다.**
     *
     * 거절·늦은 응답·확인 전 200 — 어느 쪽이든 그 뒤 행에 무엇이 들어 있는지 화면은 모른다.
     * 그런데도 "확인됨"으로 남겨 두면 다음 저장이 **새 `cid`가 빠진 유지 목록**을 싣고, 서버의
     * 교집합이 그 증언만 지운다. 문장은 본문에 남고 증언만 사라지는 것이 이 단위가 막아야 할
     * 바로 그 상태다. 머리 판의 제거 선택은 사람이 고른 것이므로 함께 지우지 않는다.
     *
     * 나가 있던 전용 읽기의 표도 함께 버린다 — 삽입 **전에** 떠난 답이 삽입 **뒤의** 목록으로
     * 굳으면 같은 구멍이 다시 열린다.
     */
    function invalidateCitations(uid) {
      if (!uid) return false;
      const changed = citations.unconfirm(uid);
      citationReads.delete(uid);
      citationNotes.delete(uid);
      if (uid === selectedUid) { renderCitationBar(); ensureCitations(uid, { force: true }); }
      return changed;
    }