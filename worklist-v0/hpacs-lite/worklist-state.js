

    // ── 데이터 ──
    // S4-U1b session-local KIN observation (renderObservation). Memory only; a page load starts over.
    let studyObservationModel = window.KinStudyArrivals?.observationStart?.() ?? null;
    // S4-U2 order reconciliation answer (renderOrderReconciliation). Memory only, engineering only.
    let orderReconciliationModel = window.KinOrderReconciliation?.start?.() ?? null;
    // S4-U5 server-read tags and linked-order relations per row (renderStudyIdentity). Memory only, engineering only.
    let studyIdentityModel = window.KinStudyIdentity?.start?.() ?? null;
    // S4-U5 Order List refresh tokens (refreshOrders): only the latest answer may replace the list.
    let orderRefreshSequence = 0;
    // S4-U4 Now Retry request tokens (requestGatewayRetry). Memory only; the server answers a repeat with the first time.
    let gatewayRetryRequestSeq = 0;
    let favoriteList = null, studyTagList = null, studyTagScope = 'personal';
    let demoMode = false;
    let quickDays = -1, sortKey = null, sortDir = 0, selectedOid = null;
    let worklistFolders = null, folderLoadState = 'unknown', folderAppliedSearch = null;
    let filterCollection = null, sharedSearches = [], shortcutDraft = null, shortcutBusy = false, filterReadSequence = 0, sharedFilterReadSequence = 0;
    let storedShortcuts = [];
    // 워크리스트 선택은 "지금 작성할 검사", Related 선택은 썸네일과 이전 판독문에만 쓴다.
    // 둘을 한 변수로 쓰면 prior를 클릭한 순간 저장·승인 대상까지 prior로 바뀐다.
    let relatedUid = null;
    let relatedModality = "", relatedBodyPart = "", relatedIncludeCurrent = false;
    // relatedParts의 종료(pagehide)가 부르는 Related 목록 그리기다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).
    function relatedModalities(study) {
      return [...new Set(String(study.modality ?? "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean))];
    }
    let relatedPage = 0, relatedPageQuery = '';
    function renderRelated(reveal = false) {
      relatedRowNavigation?.beforeRender();
      const s = cur();
      relatedParts.sync(s?.uid||'');
      $('#related-include-current').checked=relatedIncludeCurrent;$('#related-include-current').disabled=!s;
      $('#related-load-parts').disabled=!s||!serverMode||offline||demoMode||relatedParts.busy();
      $('#related-cancel-parts').hidden=!relatedParts.busy();
      $("#related-return").disabled = !s || !relatedUid;
      $("#related-current").textContent = s
        ? `판독 대상 · ${s.date || "날짜 없음"} · ${s.modality} · ${s.name} (${s.id}) · ${shownStudyDesc(s)}`
        : "판독 대상을 선택하세요";
      $("#related-current").title = $("#related-current").textContent;
      let rel = [];
      if (s) {
        rel = relatedCandidates().filter(x => relatedIncludeCurrent || x.uid !== s.uid);
        rel = [...rel].sort((a, b) => b.date.localeCompare(a.date) || b.uid.localeCompare(a.uid));
      }
      const total = rel.length;
      const known=relatedCandidates().filter(x=>relatedParts.get(x.uid)?.parts).length;
      const partTokens=[...new Set(relatedCandidates().flatMap(x=>relatedParts.get(x.uid)?.parts||[]))].filter(Boolean).sort();
      const body=$('#related-body-part'),bodyOptions=[new Option('All Body Parts',''),new Option('Unverified','?'),new Option('Unspecified',JSON.stringify('')),
        ...partTokens.map(v=>new Option(v,JSON.stringify(v)))];
      if(relatedBodyPart&&!bodyOptions.some(o=>o.value===relatedBodyPart))bodyOptions.push(new Option(JSON.parse(relatedBodyPart),relatedBodyPart));
      body.replaceChildren(...bodyOptions);body.value=relatedBodyPart;body.disabled=!s;body.title=body.selectedOptions[0]?.textContent||'';
      $('#related-parts-status').textContent=relatedParts.note() || (s?`${relatedParts.busy()?'조회 중 · ':''}부위 확인 ${known}/${relatedCandidates().length} · 미조회·실패는 Unverified` : '');
      const modality = $("#related-modality");
      const tokens = [...new Set(rel.flatMap(relatedModalities))].sort();
      const options = [new Option("All Modalities", ""), new Option("Unspecified", JSON.stringify("")),
        ...tokens.map(token => new Option(token, JSON.stringify(token)))];
      // 마지막 일치 항목이 사라져도 사용자가 고른 조건을 몰래 전체로 넓히지 않는다.
      if (relatedModality && !options.some(option => option.value === relatedModality))
        options.push(new Option(JSON.parse(relatedModality), relatedModality));
      modality.replaceChildren(...options);
      modality.value = relatedModality;
      modality.disabled = !s;
      modality.title = modality.selectedOptions[0]?.textContent || "";
      if (relatedModality) {
        const token = JSON.parse(relatedModality);
        rel = rel.filter(x => token ? relatedModalities(x).includes(token) : !relatedModalities(x).length);
      }
      if(relatedBodyPart)rel=rel.filter(x=>{const parts=relatedParts.get(x.uid)?.parts;return relatedBodyPart==='?'?!parts:!!parts&&parts.includes(JSON.parse(relatedBodyPart));});
      $("#related-filter-count").textContent = `${rel.length} / ${total}`;
      $("#related-filter-hidden").hidden = !s || !relatedUid || rel.some(x => x.uid === relatedUid);
      const pageQuery = JSON.stringify([selectedUid, relatedModality, relatedBodyPart, relatedIncludeCurrent]);
      if (pageQuery !== relatedPageQuery) { relatedPage = 0; relatedPageQuery = pageQuery; }
      const viewed = rel.findIndex(x => x.uid === relatedUid), pages = Math.max(1, Math.ceil(rel.length / 50));
      if (reveal === true && viewed >= 0) relatedPage = Math.floor(viewed / 50);
      relatedPage = Math.max(0, Math.min(relatedPage, pages - 1));
      $('#related-pages').hidden = pages <= 1;
      $('#related-page-prev').disabled = relatedPage === 0; $('#related-page-next').disabled = relatedPage >= pages - 1;
      $('#related-page-current').disabled = viewed < 0;
      $('#related-page-status').textContent = `${relatedPage + 1}/${pages}페이지`;
      relatedRows = rel;
      $("#relrows").innerHTML = s
        ? (rel.slice(relatedPage * 50, (relatedPage + 1) * 50).map(x => {
            return `
            <tr data-uid="${esc(x.uid)}" class="${x.uid === relatedUid || (x.uid === s.uid && !relatedUid) ? "related-selected" : ""}">
              <td>${x.uid === s.uid ? "Reading Target" : relatedDateLabel(x)} · ${x.uid === relatedUid || (x.uid === s.uid && !relatedUid) ? "👁 열람 중" : "비교"}</td>
              <td>${esc(x.date)}</td><td>${esc(x.modality)}</td><td>${esc(shownStudyDesc(x))}</td><td class="num">${esc(x.count)}</td>
              <td><span class="rs ${esc(x.rs)}">${esc(x.rs)}</span></td>
              <td>${x.rs === "A" ? "Approved" : "No Report"} <button class="chip" type="button" data-related-open="${esc(x.uid)}">${x.uid === s.uid ? 'Open Images' : 'Compare Images'}</button></td>
            </tr>`;
          }).join("") || `<tr><td class="empty" colspan="7">${relatedModality || relatedBodyPart ? "조건에 맞는 관련 검사 없음" : "관련 검사 없음"}</td></tr>`)
        : `<tr><td class="empty" colspan="7">검사를 선택하세요</td></tr>`;
      columnPrefs?.decorateRelated(mode);
      relatedRowNavigation?.sync();
    }