

    // ── Order List (8.2.2): HRIS에서 온 오더 목록 (여기선 가짜) ──
    const SEED_ORDERS = [
      { oid: "O-9001", id: "P-1001", name: "KIM CHULSOO",  sex: "M", birth: "1962-03-04", sched: today() + " 09:10", modality: "CT", desc: "Brain CT without contrast", ward: "NR",  reqDoc: "PARK MD" },
      { oid: "O-9002", id: "P-1002", name: "LEE YOUNGHEE", sex: "F", birth: "1975-11-22", sched: today() + " 09:40", modality: "CT", desc: "Brain CT with contrast",    ward: "ER",  reqDoc: "KIM MD" },
      { oid: "O-9003", id: "P-2001", name: "HAN JIWOO",    sex: "F", birth: "1990-07-14", sched: today() + " 10:05", modality: "CT", desc: "Brain CT screening",       ward: "OPD", reqDoc: "CHOI MD" },
      { oid: "O-9004", id: "P-2002", name: "OH SEUNGMIN",  sex: "M", birth: "1984-01-30", sched: today() + " 10:30", modality: "CR", desc: "Chest PA",                 ward: "OPD", reqDoc: "KIM MD" },
      { oid: "O-9005", id: "P-2003", name: "SEO YUNA",     sex: "F", birth: "2001-09-02", sched: today() + " 11:00", modality: "CT", desc: "Brain CT f/u",             ward: "NR",  reqDoc: "PARK MD" },
      { oid: "O-9006", id: "P-2004", name: "BAEK DOYUN",   sex: "M", birth: "1958-12-19", sched: today() + " 11:25", modality: "US", desc: "Abdominal US",             ward: "GI",  reqDoc: "LEE MD" },
    ];
    let orders = null;
    try { orders = JSON.parse(localStorage.getItem("kin-orders")); } catch (e) {}
    if (!Array.isArray(orders) || !orders.length)
      orders = SEED_ORDERS.map(o => ({ ...o, matched: "U", studyUid: null }));
    const saveOrders = () => { try { localStorage.setItem("kin-orders", JSON.stringify(orders)); } catch (e) {} };
    saveOrders();

    // 상용구 검색·View·삽입 관문과 그 등록(아래)이 부르는 선언이다. script를 나눠 실어도 틈의 초기 입력이 미정의를 만나지 않게 등록보다 앞에 둔다(S9-U0a-PRE).
    let studies = [];
    let selectedUid = null;
    function cur() { return studies.find(s => s.uid === selectedUid); }
    const RFIELDS = ["findings", "conclusion", "recommendation"];
    /**
     * 판독문 textarea를 **스크립트로** 고쳐도 되는가.
     *
     * `readOnly`는 사람의 타이핑만 막는다. `el.value = ...` 대입은 그대로 통과한다.
     * 그래서 Clear·Paste 같은 버튼은 잠금을 스스로 확인해야 한다 —
     * 예비 판독 잠금이 이 두 버튼에서만 열려 있었다.
     * 막는 이유를 문자열로 돌려준다. 통과면 null.
     *
     * W5(설계 v5 §1.6, D1423 R2): Related Report 모드와, 저장 영수증이 확인되지 않은 Related 삽입도 쓰기를 막는다. 예외는 모드가 연
     * 일회용 허가(`admission`) 하나뿐이다 — 검토한 Insert의 그 칸, 그 한 번의 native 편집. `RELATED_BASE`는 모드가 "Target이 그
     * 삽입을 받을 수 있는가"를 물을 때 W5 사유를 빼고 기존 규칙만 묻는 표시이고, 편집을 열지 않는다(편집기의 canEdit은 모드가
     * 직접 확인한 허가만 넘긴다). `relatedMode`는 page-boot가 올린 모드이며, 그보다 앞의 소비자가 읽으므로 여기서 선언한다(S9-U0a-PRE).
     */
    let relatedMode = null;
    const RELATED_BASE = Object.freeze({ base: true });
    function reportWriteBlock(admission = null) {
      if (!selectedUid) return "검사를 선택하세요";
      if (!KinAuth.has("radiologist")) return "판독문 편집은 판독의 권한이 필요합니다";
      if (appState[selectedUid]?.prelimHidden) return "다른 판독의의 예비 판독(RS: P)입니다";
      if (admission === RELATED_BASE) return null;
      return relatedMode?.blocked(admission) ?? relatedInsertWriteBlock(selectedUid, admission);
    }