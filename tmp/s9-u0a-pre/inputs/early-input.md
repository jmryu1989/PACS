# S9-U0a-PRE에 넘길 조기 입력 3건 — UNRESOLVED

현재 원본은 하나의 inline script다. 아래 위험은 이를 외부 classic script로 분할할 때 생기는 task gap 반례다. RELIST에서는 제품을 수정하거나 위험이 사라졌다고 판정하지 않는다. D707에 따라 별도 PRE에서 최소 제품 변경, Astra 사전 검수와 교차 검수를 거친 SHA를 새 byte baseline으로 고정한다.

## B1-03 — UNRESOLVED

현재 문장 `ForOfStatement after dictation #1`: main.html:2320–2327. 후행 선언 main.html:5514: `let selectionSeq = 0;`.

```javascript
for (const k of ["findings", "conclusion", "recommendation"]) {
      const el = $("#" + k);
      el.addEventListener("focus", () => { dictationField = { field: k, seq: selectionSeq }; });
      // 위치를 다시 고정하는 몸짓은 **칸 안을 누르는 것**이다. 다시 고정해도 넣지는 않는다.
      el.addEventListener("mouseup", () => { dictation.fieldClicked(); });
      // 사람이 고친 글은 새 편집 순번이다 — 그 전에 떠난 편집기 범위의 작업은 이 글 위에 쓰지 않는다.
      el.addEventListener("input", () => { work.edited(); dictation.redraw(); });
    }
```

최소 선행 변경 제안 — 선언 앞당기기: `let selectionSeq = 0;` 단일 선언을 5514행에서 `const work = KinWorkContext;`(1990행) 바로 다음으로 옮긴다. focus/mouseup/input 등록의 위치·내용·순서는 그대로 둔다. 같은 이름의 후행 초기화를 남기지 않는다.

동작 시험 수용 기준: 세 textarea의 focus → mouseup → input 이벤트에 대해 실제 등록 순서와 횟수가 원본과 같고, 초점에 따른 dictation 대상/selection epoch 및 편집 알림이 동일해야 한다. 각 분할 경계 응답을 보류한 초기 focus에서 ReferenceError가 없어야 한다. 검사 A→B→A와 늦은 받아쓰기 결과도 기존 유효성 규칙을 유지한다.

처음부터 disabled가 아닌 입력 요소다. findings뿐 아니라 같은 for-of의 conclusion/recommendation도 검사한다.

```text
1468:           <textarea id="findings" placeholder="Please enter findings"></textarea>
```

## B1-05 — UNRESOLVED

현재 문장 `ExpressionStatement after updateTemplatePreview #1`: main.html:2379–2393. 후행 선언 main.html:5405: `const RFIELDS = ["findings", "conclusion", "recommendation"];`.

```javascript
$("#tplrows").addEventListener("click", e => {
      const button = e.target.closest("[data-tpl-preview]"); if (!button) return;
      const tr = button.closest("tr[data-i]"), t = templates[+tr.dataset.i]; if (!t) return;
      // 목록이 새로 로드돼도, 삽입은 사람이 미리보기에서 읽은 문장과 같아야 한다.
      templatePreview = { uid: selectedUid, template: Object.fromEntries(
        ["title", "shortcut", "modality", "bodypart", ...RFIELDS].map(k => [k, String(t[k] ?? "")])) };
      templatePreviewReturn = button;
      const snapshot = templatePreview.template;
      $("#tpl-preview-title").textContent = `상용구 미리보기 — ${snapshot.title}`;
      $("#tpl-preview-meta").textContent = `단축어: ${snapshot.shortcut || "없음"} · Modality: ${snapshot.modality || "전체"} · Bodypart: ${snapshot.bodypart || "미지정"}`;
      for (const k of RFIELDS) $("#tpl-preview-" + k).textContent = snapshot[k] || "(내용 없음)";
      updateTemplatePreview();
      $("#tpl-preview").classList.add("show");
      $("#tpl-preview-close").focus();
    });
```

최소 선행 변경 제안 — 상용구 조기 등록을 boot 초기화로 묶기: 2346–2619행 run의 즉시 이벤트 등록을 원래 순서대로 일회 초기화 함수에 묶고, boot(12277행)의 첫 await 전에 한 번 호출한다. 상태 선언과 순수 함수는 기존 순서를 유지한다. 재시도 boot가 재등록하지 않도록 한다. Modality change만 늦추면 View를 만드는 다른 입력이 남으므로 검색·Bodypart·clear·View·미리보기/편집 등록을 함께 대조한다. RFIELDS만 앞당기는 안은 더 이른 cur 미정의 경로를 없애지 못하므로 이 안으로 채택하지 않는다.

동작 시험 수용 기준: Modality/Bodypart/검색/clear→View→닫기/삽입/편집의 실제 사용자 결과·포커스·등록 횟수·동일 target/event의 호출 순서가 원본과 같아야 한다. 인증 대기/실패/Retry에서도 등록 1회이며, current-study 이후 related-report 이전 응답을 보류해 View를 누를 때 RFIELDS/cur TDZ가 없어야 한다.

Modality change → renderTemplates(2191–2214) → View 생성 → 2379행 click. cur가 준비된 뒤 RFIELDS 파일을 보류하는 반례다. cur 이전 입력도 PRE에서 별도 확인해야 한다.

```text
2346:     $("#t-mod").addEventListener("change", renderTemplates);
2192:       const s = cur();
2211:           <td><button type="button" class="chip" data-tpl-preview aria-label="상용구 미리보기: ${esc(t.title)}">View</button></td>
3461:     function cur() { return studies.find(s => s.uid === selectedUid); }
```

## B1-58 — UNRESOLVED

현재 문장 `ExpressionStatement after splitFrame, splitSize #8`: main.html:11351–11359. 후행 선언 main.html:11386: `let activeFilterName = null;`.

```javascript
$("#quick-match").addEventListener("change", () => {
      try {
        const next = KinCompoundFilter.withQuickMode(fval[KinCompoundFilter.KEY], $("#quick-match").value, COLS[mode]);
        if (next) fval[KinCompoundFilter.KEY] = next; else delete fval[KinCompoundFilter.KEY];
        activeFilterName = null;
      } catch (error) { toast(error.message, 'err'); }
      worklistSearch?.change();
      render();
    });
```

최소 선행 변경 제안 — Quick Match 등록을 boot 초기화로 묶기: 11351–11359행 change 등록을 일회 초기화 함수로 감싸고 boot의 첫 await 전에 호출한다. activeFilterName만 앞당겨도 render→renderChips의 후행 함수 문제는 남는다. 상용구 초기화 후 원래 등록 상대 순서를 유지하도록 호출한다.

동작 시험 수용 기준: Quick Match 변경 후 조건 fval·activeFilterName·칩·목록·저장 검색 상태와 worklistSearch.change→render 관측 순서가 원본과 같아야 한다. saved-filters 응답을 지연한 change에서 TDZ/함수 미정의/부분 조건 변경이 없어야 한다. boot retry 뒤 한 이벤트당 handler 한 번, 잘못된 값의 오류/복구 동작도 동일해야 한다.

초기 enabled Quick Match가 activeFilterName에 먼저 쓰고 render(3190–3271) → renderChips(11548–11573)로 간다. 선언 하나만 앞당기는 것으로 후행 함수 문제까지 해결되지 않는다.

```text
1100:       <select id="quick-match" aria-label="Patient Search Match"><option value="contains">Contains</option><option value="prefix">Starts With</option><option value="exact">Exact</option></select>
3267:       renderChips();
11548:     function renderChips() {
```

## PRE 공통 수용 조건

REQ-S9-U0a-PRE-ORDER → RISK-EARLY-TDZ/REGISTRATION-ORDER/DUPLICATE → TEST-PRE-REGISTRATION/EARLY-03/05/58. 이름/문자열 핀 대신 브라우저의 실제 등록·dispatch·사용자 결과를 대조한다. 동일 EventTarget/event에 대한 영향 받는 모든 등록과 그 호출 결과를 비교하고, 독립 target 간 시간 이동이 관측 가능한 차이를 만드는지도 초기 입력·pagehide·세션 종료로 검사한다. boot 첫 await 뒤로 미루어 인증 결과에 등록 여부가 달라져서는 안 된다. 원본과 선행 변경을 같은 입력으로 실행하고, 임시 18/30/45 분할의 0/150ms 및 위험 경계 보류로 재현한다. 원본 위험 변이/재등록 변이를 되돌려 시험이 실패하는지 확인한다.

boot wrapper는 원래 전역 등록 trace에서 다른 등록보다 뒤로 이동할 수 있으므로 등록 순서 보존을 자동 충족하지 않는다. 원본 전체 등록 trace와 동일 대상/event의 실행 trace를 비교하고, 요구된 상대 순서를 보존할 수 없으면 이 후보안을 기각한다. 필요한 후행 등록까지 원래 순서로 초기화할 최소 경계 또는 선언 앞당기기 대안을 PRE 사전 검수에서 확정해야 한다. 제품 경로 변경은 PRE 소유자가 수행한다. C1 새 기준 바이트/HTML 동등, C2 possible 재분류, C3 조기 입력·종료·late response, C4 A2 실제 사례/결과, C5 served/network 자산, C6 TS Program 진단과 같은 SHA의 후보 관문을 결속한다. 이 문서는 구현·시험 통과 승인이 아니다.
