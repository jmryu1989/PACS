

    // ══════════ 컬럼 스펙: 모드별로 다른 워크리스트 (6.3 / 8.1.1) ══════════
    // f: 없으면 필터 없음 / 'text' = 입력칸 / 배열 = 드롭다운
    const COLS = {
      Radiology: [
        { k: "pf", t: "PF" },
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note" },
        { k: "no", t: "No", num: 1 },
        { k: "viewing", t: "Viewing" },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "rs", t: "RS", f: ["A", "H", "O", "P", "T", "W"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "ts", t: "TS" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1 },
        { k: "birth", t: "BirthDate" },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate" },
        // 예비 판독을 쓴 사람과, 최종 판독을 맡은 상급 판독의.
        // HPACS도 2025.07에 이 둘을 컬럼으로 붙였다 (교훈 §13 — 컬럼은 끝없이 늘어난다)
        { k: "preDoc", t: "PreDoc", f: "text" },
        { k: "preReviewer", t: "PreReviewer", f: "text" },
        // S7-U3b: 검사를 소유한 기관의 등록 이름(목록 행의 institutionName 그대로). 서버 목록(worklist-columns.ts)과 같은
        // 끝자리라 이 열이 생기기 전 저장된 열 설정에도 순서를 바꾸지 않고 맨 뒤에 보인다(두 정규화기의 규칙).
        { k: "institutionName", t: "Hospital", f: "text" },
      ],
      Technician: [
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note" },
        { k: "no", t: "No", num: 1 },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "matched", t: "Mt", f: ["M", "U"] },
        { k: "rs", t: "RS", f: ["A", "H", "O", "P", "T", "W"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1 },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate" },
        { k: "ward", t: "Ward", f: "text" },
        { k: "reqHosp", t: "ReqHosp" },
      ],
    };
    // 빈 StudyDescription을 데이터에 채우면 "같은 검사명" 묶음과 Modify 원본까지
    // 모달리티로 바뀐다. 원본 의미는 보존하고, 사람이 읽는 자리에서만 대체한다.
    function shownStudyDesc(s) {
      return String(s?.desc ?? "").trim()
        || String(s?.modality ?? "").trim()
        || "(설명 없음)";
    }

    // 특수 렌더링이 필요한 칸만 함수로
    let studyPriority = null;
    const CELL = {
      assignedReader:s=>`<button type="button" class="chip" data-reader-assignment="${esc(s.uid)}" ${!serverMode||demoMode||offline?'disabled':''}>${esc(s.assignedReader||'Unassigned')}</button>`,
      techNote: s => `<button type="button" class="chip" data-tech-note="${esc(s.uid)}" aria-label="${esc(s.id)} Tech 메모 ${noteLabel(s.uid)}" ${!serverMode || demoMode || offline ? 'disabled' : ''}>${noteLabel(s.uid)}</button>`,
      em: s => {const phase=studyPriority?.get(s.uid)?.phase;return phase?`<span title="${phase==='saving'?'응급 상태를 저장 중입니다':'저장 결과 미확인 — 문맥 메뉴의 Refresh Status로 확인하세요'}">${phase==='saving'?'Saving':'Unverified'}</span>`:s.em === "E" ? `<span class="em-e">E</span>` : "";},
      rs: s => `<span class="rs ${esc(s.rs)}" title="${esc(s.holdReason ?? "")}">${esc(s.rs)}</span>`,
      ts: s => `<span class="ts ts-${esc(s.ts)}">${esc(s.ts)}</span>`,
      ss: s => `<span class="ss ${esc(s.ss)}">${esc(s.ss)}</span>`,
      // S4-U5: server values too, but escaped like every other cell; a stored value never becomes markup.
      matched: s => `<span class="mt ${esc(s.matched)}">${esc(s.matched)}</span>`,
      desc: s => esc(shownStudyDesc(s)),
      preDoc: s => esc(displayActor(s.preDoc)),
      preReviewer: s => esc(displayActor(s.preReviewer)),
      // Viewing: 지금 이 검사의 판독문을 쓰고 있는 사람
      viewing: s => !s.holder ? ""
        : s.holder === user
          ? `<span class="hold me" title="내가 작성 중">✎ 나</span>`
          : `<span class="hold other" title="${esc(displayActor(s.holder))} 님이 작성 중">✎ ${esc(displayActor(s.holder))}</span>`,
      // S7-U3b Hospital: 서버가 준 소유 기관 이름만 쓴다. Tele는 행의 tele만 따른다 — 이름을 내 기관 이름과 비교하면
      // 등록 이름이 같은 두 기관에서 틀리고, reqHosp는 Technician에서 손으로 바꿀 수 있는 값이다.
      institutionName: s => {
        const name = typeof s.institutionName === "string" && s.institutionName !== "" ? esc(s.institutionName) : "—";
        return s.tele === true ? `${name} <span class="tele-tag" title="원격판독으로 의뢰받은 검사입니다.">Tele</span>` : name;
      },
    };

    let mode = "Radiology";
    const fval = {};   // 컬럼필터 값 (컬럼 key → 문자열)
    let columnPrefs = null, multiSelection = null, imagePreview = null, imageThumbnails = null, worklistSearch = null, rowNavigation = null, relatedRowNavigation = null, relatedRows = [];
    const shownColumns = () => columnPrefs ? columnPrefs.columns(mode) : COLS[mode];

    function renderHeads() {
      $("#heads").innerHTML = shownColumns().map(c => `<th data-key="${c.k}" class="${c.num ? "num" : ""}">${c.t}</th>`).join("");
      $("#filterrow").innerHTML = shownColumns().map(c => {
        if (!c.f) return "<th></th>";
        if (c.f === "text" || c.k === 'modality')
          return `<th><input data-f="${c.k}" value="${esc(fval[c.k] ?? "")}"></th>`;
        return `<th><select data-f="${c.k}">` +
          ["", ...c.f].map(o => `<option value="${o}"${(fval[c.k] ?? "") === o ? " selected" : ""}>${o}</option>`).join("") +
          `</select></th>`;
      }).join("");
    }
    $("#filterrow").addEventListener("input", e => {
      const el = e.target.closest("[data-f]"); if (!el) return;
      fval[el.dataset.f] = el.value.trim();
      if (el.dataset.f === 'modality') {
        if (/[,\\]/.test(el.value)) fval.modality = el.value.split(/[,\\]/).map(v => v.trim().toUpperCase()).filter(Boolean);
        folderAppliedSearch = null;
      }
      worklistSearch?.change();
      render();
    });