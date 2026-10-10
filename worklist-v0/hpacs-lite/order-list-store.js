

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
     */
    function reportWriteBlock() {
      if (!selectedUid) return "검사를 선택하세요";
      if (!KinAuth.has("radiologist")) return "판독문 편집은 판독의 권한이 필요합니다";
      if (appState[selectedUid]?.prelimHidden) return "다른 판독의의 예비 판독(RS: P)입니다";
      return null;
    }