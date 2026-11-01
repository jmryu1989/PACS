

    // ══════════ 컬럼 스펙: 모드별로 다른 워크리스트 (6.3 / 8.1.1) ══════════
    // f: 없으면 필터 없음 / 'text' = 입력칸 / 배열 = 드롭다운
    const COLS = {
      Radiology: [
        { k: "pf", t: "PF" },
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note", f: ["Yes", "None", "Cleared", "Unknown"] },
        { k: "no", t: "No", num: 1 },
        { k: "viewing", t: "Viewing" },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "rs", t: "RS", f: ["W", "T", "P", "H", "A"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "ts", t: "TS" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1, f: "text" },
        { k: "birth", t: "BirthDate" },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate", f: "text" },
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
        { k: "techNote", t: "Tech Note", f: ["Yes", "None", "Cleared", "Unknown"] },
        { k: "no", t: "No", num: 1 },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "matched", t: "Mt", f: ["M", "U"] },
        { k: "rs", t: "RS", f: ["W", "T", "P", "H", "A"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1, f: "text" },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate", f: "text" },
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
    const viewingNames = new Map();
    const CELL = {
      assignedReader:s=>`<button type="button" class="chip" data-reader-assignment="${esc(s.uid)}" ${!serverMode||demoMode||offline?'disabled':''}>${esc(s.assignedReader||'Unassigned')}</button>`,
      techNote: s => `<button type="button" class="chip" data-tech-note="${esc(s.uid)}" aria-label="${esc(s.id)} Tech Note ${noteLabel(s.uid)}" title="${noteHelp(s.uid)}" ${!serverMode || demoMode || offline ? 'disabled' : ''}>${noteLabel(s.uid)}</button>`,
      em: s => {const phase=studyPriority?.get(s.uid)?.phase;return phase?`<span title="${phase==='saving'?'응급 상태를 저장 중입니다':'저장 결과 미확인 — 문맥 메뉴의 Refresh Status로 확인하세요'}">${phase==='saving'?'Saving':'Unverified'}</span>`:s.em === "E" ? `<span class="em-e">E</span>` : "";},
      // 판독 상태 이름은 목록과 건수 줄에서 같은 계약을 따른다.
      rs: s => { const word = { W: "Unread", A: "Approved", H: "On Hold", P: "Preliminary", T: "In Progress" }[s.rs] ?? s.rs;
        return `<span class="rs ${esc(s.rs)}" title="${esc(s.holdReason || (word !== s.rs ? ({ W: "아직 판독하지 않은 검사", T: "저장했지만 아직 승인하지 않은 판독문", P: "상급 판독의 승인 대기", H: "판독 보류", A: "승인된 판독문" }[s.rs] || "") : ""))}">${esc(word)}</span>`; },
      ts: s => `<span class="ts ts-${esc(s.ts)}">${esc(s.ts)}</span>`,
      ss: s => `<span class="ss ${esc(s.ss)}">${esc(s.ss)}</span>`,
      // S4-U5: server values too, but escaped like every other cell; a stored value never becomes markup.
      matched: s => `<span class="mt ${esc(s.matched)}">${esc(s.matched)}</span>`,
      desc: s => esc(shownStudyDesc(s)),
      preDoc: s => esc(displayActor(s.preDoc)),
      preReviewer: s => esc(displayActor(s.preReviewer)),
      // A writer can hold the report with no viewer open. Presence excludes self; the lock does not.
      viewing: s => {
        const hold = !s.holder ? '' : s.holder === user
          ? `<span class="hold me" title="내가 작성 중">✎ 나</span>`
          : `<span class="hold other" title="${s.holder === '다른 기관' ? '다른 기관 판독의가' : s.holder === '작성자 비공개' ? '비공개 작성자가' : esc(displayActor(s.holder)) + ' 님이'} 작성 중">✎ ${esc(displayActor(s.holder))}</span>`;
        const presence = esc(viewingNames.get(s.uid) || '');
        return hold + (hold && presence ? ' · ' : '') + presence;
      },
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

    // StudyDate filter: a preset menu (Today / since 2 days / a week / a month ago) or a custom From–To range.
    // It writes the same "from..to" text the column filter already understands (see testCol in worklist-view.js).
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    function datePresets() {
      const today = new Date(), back = f => { const d = new Date(today); f(d); return ymd(d); }, t = ymd(today);
      return [
        { id: "today", label: "Today", value: `${t}..${t}` },
        { id: "2d", label: "2 days ago", value: `${back(d => d.setDate(d.getDate() - 2))}..${t}` },
        { id: "1w", label: "A week ago", value: `${back(d => d.setDate(d.getDate() - 7))}..${t}` },
        { id: "1m", label: "A month ago", value: `${back(d => {
          // 말일에서 전달로 이동할 때 존재하지 않는 날짜가 이번 달로 넘치지 않게 한다.
          const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() - 1);
          d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
        })}..${t}` },
      ];
    }
    function dateFilterHtml(c) {
      const cur = String(fval[c.k] ?? ""), presets = datePresets(), hit = presets.find(p => p.value === cur);
      const sel = cur === "" ? "" : hit ? hit.id : "custom", [from = "", to = ""] = cur.includes("..") ? cur.split("..") : [cur, cur];
      const opt = (v, l) => `<option value="${v}"${sel === v ? " selected" : ""}>${l}</option>`;
      return `<select data-date-preset aria-label="${esc(c.t)} Filter" title="기간을 고릅니다. Custom은 시작일과 종료일을 직접 정합니다.">` +
        opt("", "All dates") + presets.map(p => opt(p.id, p.label)).join("") + opt("custom", "Custom…") + `</select>` +
        `<span class="date-custom" hidden><label>From <input type="date" data-date-from aria-label="${esc(c.t)} From" value="${esc(from)}"></label><label>To <input type="date" data-date-to aria-label="${esc(c.t)} To" value="${esc(to)}"></label></span>`;
    }
    // Custom range is a floating window under the select (position: fixed), so the filter row never grows.
    function placeDatePopup(row) {
      const box = row.querySelector(".date-custom"), r = row.querySelector("[data-date-preset]").getBoundingClientRect();
      box.style.top = Math.round(r.bottom + 2) + "px";
      box.style.left = Math.round(Math.min(r.left, window.innerWidth - 230)) + "px";
    }
    document.addEventListener("pointerdown", e => {
      document.querySelectorAll("#filterrow .date-custom:not([hidden])").forEach(box => { if (!box.closest(".date-filter").contains(e.target)) box.hidden = true; });
    }, true);
    document.addEventListener("click", e => {   // clicking the select while "Custom…" is chosen reopens the window
      const sel = e.target.closest?.("#filterrow [data-date-preset]");
      if (sel && sel.value === "custom") { const row = sel.closest(".date-filter"), box = row.querySelector(".date-custom"); box.hidden = false; placeDatePopup(row); }
    });
    function applyDateFilter(row) {
      const preset = row.querySelector("[data-date-preset]").value, box = row.querySelector(".date-custom");
      box.hidden = preset !== "custom";
      if (!box.hidden) placeDatePopup(row);
      let value = "";
      if (preset === "custom") {
        const from = row.querySelector("[data-date-from]").value, to = row.querySelector("[data-date-to]").value;
        value = from || to ? `${from}..${to}` : "";
      } else if (preset) value = datePresets().find(p => p.id === preset).value;
      if (value) fval.date = value; else delete fval.date;
      folderAppliedSearch = null;
      worklistSearch?.change();
      render();
    }
    document.addEventListener("change", e => {
      const th = e.target.closest?.("#filterrow .date-filter"); if (th) applyDateFilter(th);
    });

    // Hover help for one- and two-letter headers. Only codes the screen already uses are explained (RS letters match the count bar).
    const HEAD_HELP = {
      rs: "RS (Report Status, 판독 상태)\nW: Unread — 판독 전\nT: In Progress — 저장했지만 승인 전\nP: Preliminary — 상급 판독의 승인 대기\nH: On Hold — 보류\nA: Approved — 승인됨",
      em: "EM (Emergency)\nE: 응급\nN: 일반",
      ss: "SS (촬영 확인 상태)\nVerified: 촬영 확인됨\nUnverified: 촬영 미확인",
    };
    function renderHeads() {
      $("#heads").innerHTML = shownColumns().map((c, i) => `<th data-key="${c.k}" class="${c.num ? "num" : ""}"${HEAD_HELP[c.k] ? ` title="${esc(HEAD_HELP[c.k])}"` : ""}>${i === 0 ? '<button type="button" class="col-add" aria-haspopup="dialog" aria-label="Choose columns" title="표시할 열을 고릅니다.">+</button>' : ""}${c.t}</th>`).join("");
      $("#heads .col-add")?.addEventListener("click", e => { e.stopPropagation(); openColumnPicker(e.currentTarget); });
      bindColumnResize();
      $("#filterrow").innerHTML = shownColumns().map((c, i) => {
        // The first column has no filter of its own, so the worklist's "Clear Filters" button lives in that cell.
        if (!c.f && i === 0) return '<th class="clear-cell"><button type="button" class="col-clear" title="모든 검색 조건을 지웁니다.">Clear</button></th>';
        if (!c.f) return "<th></th>";
        if (c.k === "date") return `<th class="date-filter">${dateFilterHtml(c)}</th>`;
        if (c.f === "text" || c.k === 'modality')
          return `<th><input data-f="${c.k}" aria-label="${esc(c.t)} Filter" value="${esc(fval[c.k] ?? "")}"></th>`;
        return `<th><select data-f="${c.k}" aria-label="${esc(c.t)} Filter">` +
          ["", ...c.f].map(o => `<option value="${o}"${(fval[c.k] ?? "") === o ? " selected" : ""}>${o}</option>`).join("") +
          `</select></th>`;
      }).join("");
      if (!$("#filterrow .col-clear")) $("#filterrow th")?.insertAdjacentHTML("afterbegin", '<button type="button" class="col-clear" title="모든 검색 조건을 지웁니다.">Clear</button>');
    }
    // Top bar "Config" had no action. For now it opens the existing Panel Settings dialog (same as the Panels button).
    (function bindConfig() {
      const cfg = $("#m-config"); if (!cfg) return;
      const open = () => { const b = $("#panel-settings-open"); if (b && !b.disabled) b.click(); };
      cfg.addEventListener("click", open);
      cfg.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    })();
    document.addEventListener("click", e => {
      if (e.target.closest?.("#filterrow .col-clear")) clearWorklistFilters();
    });
    // 드래그 중에도 같은 계정 열 상태를 사용하되 머리글을 다시 만들지 않아 포인터를 잃지 않는다.
    function bindColumnResize() {
      const heads = $("#heads");
      for (const th of heads.children) {
        const grip = document.createElement("span");
        grip.className = "col-grip";
        grip.title = "열 너비: 끌어서 조절, 두 번 클릭하면 자동 너비로 돌아갑니다.";
        grip.addEventListener("click", e => e.stopPropagation());
        grip.addEventListener("dblclick", e => { e.stopPropagation(); columnPrefs?.setWidth(mode, th.dataset.key, null); });
        grip.addEventListener("pointerdown", e => {
          if (e.button !== 0 || !columnPrefs) return;
          e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
          const key = th.dataset.key, startX = e.clientX, start = th.getBoundingClientRect().width;
          const original = columnPrefs.widths(mode);
          const widths = Object.fromEntries([...heads.children].map(h => [h.dataset.key,
            Math.max(64, Math.min(600, Math.round(h.getBoundingClientRect().width)))]));
          const move = ev => {
            widths[key] = Math.max(64, Math.min(600, Math.round(start + ev.clientX - startX)));
            columnPrefs.setWidths(mode, widths, false);
          };
          const done = ev => {
            grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", done); grip.removeEventListener("pointercancel", done);
            if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
            columnPrefs.setWidths(mode, ev.type === "pointercancel" ? original : widths, true);
          };
          grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", done); grip.addEventListener("pointercancel", done);
        });
        th.append(grip);
      }
    }
    // "+" in the first header cell: tick any column of this mode on or off; applies at once.
    let columnPicker = null;
    function openColumnPicker(opener) {
      if (!columnPrefs) return;
      if (!columnPicker) {
        columnPicker = document.createElement("dialog"); columnPicker.id = "column-picker";
        columnPicker.setAttribute("aria-label", "Columns");
        columnPicker.addEventListener("click", e => { if (e.target === columnPicker) columnPicker.close(); });
        document.body.append(columnPicker);
      }
      const m = mode, head = document.createElement("header");
      const title = document.createElement("strong"); title.textContent = "Columns · " + m;
      const close = document.createElement("button"); close.type = "button"; close.textContent = "Close"; close.onclick = () => columnPicker.close();
      head.append(title, close);
      const list = document.createElement("div"); list.className = "cp-list";
      let dragged = null;
      const clearDrop = () => { for (const el of list.querySelectorAll(".cp-before, .cp-after")) el.classList.remove("cp-before", "cp-after"); };
      const draw = () => {
        list.replaceChildren(...columnPrefs.all(m).map(c => {
          const row = document.createElement("div"); row.className = "cp-row"; row.dataset.column = c.k;
          const grip = document.createElement("span"); grip.className = "cp-grip"; grip.textContent = "≡"; grip.draggable = true;
          grip.title = "끌어서 열 순서를 바꿉니다.";
          grip.addEventListener("dragstart", e => { dragged = c.k; row.classList.add("cp-dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.k); });
          grip.addEventListener("dragend", () => { dragged = null; clearDrop(); row.classList.remove("cp-dragging"); });
          row.addEventListener("dragover", e => {
            if (!dragged || dragged === c.k) return;
            e.preventDefault(); e.dataTransfer.dropEffect = "move";
            const box = row.getBoundingClientRect(); clearDrop(); row.classList.add(e.clientY > box.top + box.height / 2 ? "cp-after" : "cp-before");
          });
          row.addEventListener("dragleave", e => { if (!row.contains(e.relatedTarget)) row.classList.remove("cp-before", "cp-after"); });
          row.addEventListener("drop", e => {
            if (!dragged || dragged === c.k) return;
            e.preventDefault(); const after = row.classList.contains("cp-after"), moving = dragged; dragged = null; clearDrop();
            columnPrefs.move(m, moving, c.k, after); draw();
          });
          const label = document.createElement("label"), box = document.createElement("input");
          box.type = "checkbox"; box.checked = c.shown; box.disabled = c.required;
          box.addEventListener("change", () => { columnPrefs.setShown(m, c.k, box.checked); });
          label.append(box, document.createTextNode(" " + c.t + (c.required ? " (Required)" : "")));
          const width = document.createElement("input"); width.type = "number";
          width.min = "64"; width.max = "600"; width.step = "1"; width.placeholder = "Auto";
          width.setAttribute("aria-label", c.t + " width (px)"); width.value = c.width ?? "";
          width.addEventListener("change", () => {
            if (width.validity.valid) columnPrefs.setWidth(m, c.k, width.value === "" ? null : width.valueAsNumber);
          });
          row.append(grip, label, width); return row;
        }));
      };
      const bulk = document.createElement("footer");
      const all = document.createElement("button"); all.type = "button"; all.textContent = "Show All";
      all.onclick = () => { for (const c of columnPrefs.all(m)) if (!c.shown) columnPrefs.setShown(m, c.k, true); draw(); };
      bulk.append(all);
      draw(); columnPicker.replaceChildren(head, list, bulk);
      const box = opener.getBoundingClientRect();
      columnPicker.style.cssText = `position:fixed;margin:0;left:${Math.max(4, Math.round(box.left))}px;top:${Math.round(box.bottom + 2)}px;max-height:${Math.max(160, innerHeight - box.bottom - 12)}px;`;
      columnPicker.onclose = () => { try { opener.isConnected && opener.focus(); } catch (_) {} };
      if (!columnPicker.open) columnPicker.showModal();
    }
    const reportedModalityInputs = new WeakSet();
    function commitModalityInput(el) {
      if (el?.dataset.f !== 'modality') return true;
      if (el.validationMessage) {
        if (!reportedModalityInputs.has(el)) toast(el.validationMessage, 'err');
        reportedModalityInputs.add(el);
        return false;
      }
      el.value = String(fval.modality ?? '');
      return true;
    }
    $('#filterrow').addEventListener('focusout', e => commitModalityInput(e.target));
    $('#filterrow').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !commitModalityInput(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    });
    document.addEventListener('click', e => {
      if (e.target.closest('[data-search-apply]') && !commitModalityInput($('#filterrow [data-f=modality]'))) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    }, true);
    $("#filterrow").addEventListener("input", e => {
      const el = e.target.closest("[data-f]"); if (!el) return;
      let value = el.value.trim();
      if (el.dataset.f === 'modality') {
        reportedModalityInputs.delete(el);
        const tokens = value.split(/[,\\]/).map(v => v.trim().toUpperCase());
        const allowed = KinWorklistFolderTree.defaultModalities(studies);
        const error = value && tokens.some(v => !v || !allowed.includes(v))
          ? '사용할 수 없는 Modality입니다. 빈 값 없이 목록의 Modality를 쉼표로 구분해 입력하세요.' : '';
        el.setCustomValidity(error);
        // Incomplete tokens keep the last applied criteria while the doctor types.
        if (error) return;
        if (/[,\\]/.test(el.value)) value = [...new Set(tokens)];
        else value = tokens[0] || '';
        folderAppliedSearch = null;
      }
      fval[el.dataset.f] = value;
      worklistSearch?.change();
      render();
    });
