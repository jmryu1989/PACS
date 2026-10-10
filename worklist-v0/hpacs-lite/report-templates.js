

    // ── Reading Template ──
    // **계정에 붙는다.** 서버 모드면 bootstrap이 내 것을 실어 오고, 로컬 모드에서만
    // localStorage를 쓴다. 판독의는 자기 상용구를 하루 종일 쓰는데 PC를 바꿨다고
    // 사라지면 깨지는 건 작업이 아니라 신뢰다 (교훈 §6).
    // 매뉴얼이 "Upload/Download **My** Template File"이라고 부르듯 기관 공용이 아니라 개인 것이다.
    let templates = null;
    try { templates = JSON.parse(localStorage.getItem("kin-templates")); } catch (e) {}
    templates ??= [
      { title: "Normal Brain CT", shortcut: "nbct", modality: "CT",
        findings: "No evidence of acute intracranial hemorrhage.\nNo mass effect or midline shift.\nVentricles and sulci are within normal limits.",
        conclusion: "No acute intracranial abnormality." },
      { title: "Brain CT f/u nodule", shortcut: "fu", modality: "CT",
        findings: "Known hyperdense nodule in right frontal region.\nNo interval change in size.\nNo new lesion.",
        conclusion: "Stable known nodule. No interval change." },
      { title: "Screening", shortcut: "scr", modality: "",
        findings: "Screening examination.\n", conclusion: "" },
    ];
    const saveTemplatesLocal = () => {
      try { localStorage.setItem("kin-templates", JSON.stringify(templates)); } catch (e) {}
    };
    saveTemplatesLocal();

    const templateClass = value => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const templateModalities = value => String(value ?? "").split(",").map(templateClass).filter(Boolean);
    function renderTemplateBodyparts() {
      const select = $("#t-body"), chosen = select.value, label = select.selectedOptions[0]?.textContent;
      const classes = new Map();
      for (const t of templates) {
        const key = templateClass(t.bodypart);
        if (key && !classes.has(key)) classes.set(key, String(t.bodypart).trim().replace(/\s+/g, " "));
      }
      const options = [new Option("전체 부위", ""), new Option("미지정", JSON.stringify("")),
        ...[...classes].sort(([a], [b]) => a.localeCompare(b)).map(([key, name]) => new Option(name, JSON.stringify(key)))];
      // 마지막 항목의 부위를 바꿔도 사용자가 고른 조건을 몰래 '전체'로 넓히지 않는다.
      if (chosen && !options.some(option => option.value === chosen)) options.push(new Option(label, chosen));
      select.replaceChildren(...options); select.value = chosen;
    }
    function renderTemplates() {
      const s = cur();
      const useMod = $("#t-mod").checked, modalities = templateModalities(s?.modality);
      renderTemplateBodyparts();
      const body = $("#t-body").value;
      const words = $("#tpl-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const list = templates.filter(t => {
        const text = [t.title, t.shortcut, t.modality, t.bodypart].map(v => String(v ?? "").toLowerCase()).join(" ");
        const kinds = templateModalities(t.modality);
        // CT가 SCT 같은 다른 코드의 일부라는 이유로 분류에 들어오면 안 된다.
        return (!useMod || !modalities.length || !kinds.length || kinds.some(kind => modalities.includes(kind)))
          && (!body || JSON.stringify(templateClass(t.bodypart)) === body) && words.every(word => text.includes(word));
      });
      const modStatus = !useMod ? "Modality 전체" : !s ? "검사 미선택 · Modality 미적용"
        : !modalities.length ? "검사 Modality 없음 · 미적용" : "Modality: " + modalities.join(", ").toUpperCase();
      $("#tpl-filter-status").textContent = `${list.length} / ${templates.length}개 · ${modStatus} · ${$("#t-body").selectedOptions[0].textContent}${words.length ? " · 검색 적용" : ""}`;
      $("#tplrows").innerHTML = list.map(t => `
        <tr data-i="${templates.indexOf(t)}" title="더블클릭: 판독문에 삽입${
          t.shortcut ? ` / 판독문에서 &quot;${esc(t.shortcut)}&quot; 입력 후 Tab` : ""} / 우클릭: 편집">
          <td>${esc(t.title)}</td><td>${esc(t.shortcut)}</td><td>${esc(t.modality)}</td>
          <td><button type="button" class="chip" data-tpl-preview aria-label="상용구 미리보기: ${esc(t.title)}">View</button></td>
        </tr>`).join("") || `<tr><td class="empty" colspan="4">${templates.length ? "조건에 맞는 상용구가 없습니다" : "상용구 없음 — 우클릭해서 추가하세요"}</td></tr>`;
      updateTemplatePreview();
    }
    /**
     * 스크립트가 판독문 칸에 글을 넣어도 되는가. 상용구 삽입과 소견 인용이 **같은 관문
     * 하나**를 쓴다 — 둘이 각자 검사를 들고 있으면 언젠가 한쪽만 고쳐진다.
     */
    function reportEditorBlock() {
      const why = reportWriteBlock();
      if (why) return why;
      // value 대입은 촬영 중/타인 점유의 readOnly도 우회한다. 타이핑과 같은 관문을 거친다.
      if (RFIELDS.some(k => $("#" + k).readOnly)) return "현재 판독문은 편집할 수 없습니다";
      return null;
    }
    function templateInsertionBlock(t, emptyMessage = "삽입할 내용이 없습니다") {
      const why = reportEditorBlock();
      if (why) return why;
      if (!t || RFIELDS.every(k => !t[k])) return emptyMessage;
      return null;
    }
    function insertTemplate(t) {
      const why = templateInsertionBlock(t);
      if (why) { toast(why, why === "삽입할 내용이 없습니다" ? "info" : "err"); return false; }
      // S3-U6: 상용구도 사람이 둔 커서 자리에 줄 단위로 들어간다. 저장된 상용구에는 CR이
      // 섞일 수 있어 줄 끝을 먼저 모은다 — 아니면 넣은 뒤 커서가 CR 수만큼 어긋난다.
      // 쓰기는 편집기의 한 자리(`editReport`)로 간다: 표시를 세우고, 타이핑/Tab처럼 점유를 시작해 다른 판독의에게 편집
      // 중임이 보이게 한다.
      return editReport(RFIELDS.filter(k => t[k]).map(k => {
        const plan = KinReportCitation.placeBlock($("#" + k).value, KinReportCitation.toLf(t[k]),
                                                  caretAt(k), citationGuards(k));
        return reportEditOf(k, plan.text, plan.end);
      }));
    }
    $("#tplrows").addEventListener("dblclick", e => {
      if (e.target.closest("button")) return;
      const tr = e.target.closest("tr[data-i]"); if (!tr?.isConnected) return;
      insertTemplate(templates[+tr.dataset.i]);
    });