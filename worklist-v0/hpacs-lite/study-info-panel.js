

    function renderClinical() {
      imagePreview?.sync();
      const s = viewed();
      renderPatientCopy();
      imageRequests?.sync();
      if (srUid && srUid !== s?.uid) closeSR();
      $('#sr-open').disabled = !s || demoMode;
      $('#tech-note-open').disabled = !s || demoMode || !serverMode || offline;
      // S5-U4b: 판독 대상이 바뀐 때만 그 검사의 임상의 질문을 읽는다(같은 대상이면 요청도 그리기도 없다).
      studyQuestions?.sync();
      // S7-U1b: 판독 대상이나 화면이 아는 판독 상태가 바뀐 때만 Mark CVR의 서버 답(#1)을 다시 읽는다.
      criticalResults?.sync();
      // S7-U4b: 보는 검사가 바뀐 때만 Clinical Context를 다시 읽는다(같은 검사면 요청도 그리기도 없다).
      clinicalContext?.sync();
      $("#clinical").innerHTML = s ? `
        <div class="clinical-scope">${s.uid === selectedUid ? '판독 대상 검사 정보' : '관련 검사 정보 · 판독 대상은 바뀌지 않습니다'}</div>
        <table>
          <tr><td>Patient</td><td>${esc(s.name)} (${esc(s.id)})</td></tr>
          <tr><td>Sex/Age</td><td>${esc(s.sex)} / ${esc(s.age)}</td></tr>
          <tr><td>Birth</td><td>${esc(s.birth)}</td></tr>
          <tr><td>Study</td><td>${esc(shownStudyDesc(s))}</td></tr>
          <tr><td>Date</td><td>${esc(s.date)}</td></tr>
          <tr><td>AccNo</td><td>${esc(s.acc)}</td></tr>
          <tr><td>Img/Se</td><td>${esc(s.count)} / ${esc(s.series)}</td></tr>
          <tr><td>SS / Mt</td><td>${esc(s.ss)} / ${s.matched === "M" ? "Matched" : "Unmatched"}</td></tr>
          <tr><td>Ward</td><td>${esc(s.ward) || "-"}</td></tr>
          <tr><td>Study UID</td><td>${esc(s.uid)}</td></tr>
        </table>` : "No clinical information provided.";
      renderStudyIdentity();
      renderObservation();
    }

    /**
     * S4-U1b 수신 표시. 세 축을 한 단어로 접지 않는다 — 기관 배정(A), KIN이 관측한 보유(B),
     * Gateway가 보고한 전송(C). 관측은 이 탭의 메모리에만 있고 서버에 이력을 남기지 않는다.
     * 관측 실패는 아무것도 비우지 않고 `관측 불가`만 더한다. 상태 `studyObservationModel`은 `studies` 옆에 둔다.
     * S4-U3: 축 C는 서버가 목록 행에 실어 준 마지막 Gateway 영수증이다. 영수증이 없으면 `No Gateway Report`(정상)다.
     */
    function applyObservation(result) {
      if (!studyObservationModel) return;
      const next = KinStudyArrivals.observationSucceeded(studyObservationModel, result);
      // A response whose observation cannot be read is not an observation; the last one stays.
      studyObservationModel = next.ok ? next.model : KinStudyArrivals.observationFailed(studyObservationModel);
      // The poll renders before it updates rows in place, so the receipt rides on this same readable answer;
      // an unreadable one keeps the last receipt, like everything else here.
      if (next.ok) {
        const receipts = new Map(result.studies.map(row => [row.uid, row.gatewayReceipt ?? null]));
        for (const study of studies) if (receipts.has(study.uid)) study.gatewayReceipt = receipts.get(study.uid);
      }
      // S4-U2: the order answer rides on this same observation and fails with it.
      applyOrderReconciliation(next.ok ? result : null);
      // S4-U5: so do the server-read tags and the linked-order relations of each row.
      applyStudyIdentity(next.ok ? result : null);
      // S7-U4b: the Clinical Context panel compares this same readable answer with the answer it shows (contract 8.1).
      clinicalContext?.observe(next.ok ? result : null);
      renderObservation();
    }
    function markObservationUnavailable() {
      if (!studyObservationModel) return;
      studyObservationModel = KinStudyArrivals.observationFailed(studyObservationModel);
      applyOrderReconciliation(null);
      applyStudyIdentity(null);
      renderObservation();
    }
    function renderObservation() {
      if (!studyObservationModel) return;
      const summary = KinStudyArrivals.observationSummary(studyObservationModel), status = $("#observation-status");
      if (status) { status.hidden = !summary.text; status.textContent = summary.text; status.title = summary.title; }
      // S4-U4 Now Retry, drawn only from labels.retry. Another study or a newer receipt drops the in-flight token
      // and the requested mark, so an answer for what was drawn before is never written over it (A->B->A too).
      // S4-F01V: one drawing serves the worklist panel and every Not Observed item, so both keep the same rules.
      const drawRetry = (s, retry, retryButton, retryNote) => {
        const retryKey = retry?.kind === "now_retry" ? retry.key : "";
        if (retryButton.dataset.uid !== s.uid || retryButton.dataset.key !== retryKey) {
          Object.assign(retryButton.dataset, { uid: s.uid, key: retryKey, request: "", requested: "" });
          retryNote.textContent = ""; retryNote.title = "";
        }
        retryButton.hidden = !retryKey || retryButton.dataset.requested === "1"
          || !(serverMode && !offline && !demoMode && KinAuth.has("technician"));
        retryButton.disabled = !!retryButton.dataset.request; retryButton.title = retry?.title ?? "";
        // Without a bindable retry the note is labels.retry itself: the F-01 sentence for failed, else nothing.
        if (!retryKey) { retryNote.textContent = retry?.text ?? ""; retryNote.title = retry?.title ?? ""; }
      };
      const absent = summary.notObserved ?? [], box = $("#not-observed");
      if (box) {
        box.hidden = !absent.length;
        $("#not-observed-summary").textContent = absent.length
          ? `Not Observed (${absent.length})` + (summary.key === "observation_unavailable" ? " · 마지막 관측 기준" : "") : "";
        // S4-F01V: every item is an own study (axis A assigned) and its own receipt adds the Gateway text and Now Retry.
        // Items are kept per UID so a request in flight survives a redraw. An item that leaves the list drops its
        // token, so a late answer is never written anywhere, and one that comes back is built new (A->B->A).
        const list = $("#not-observed-list"), kept = new Map([...list.children].map(item => [item.dataset.uid, item]));
        const items = absent.map(row => {
          let item = kept.get(row.uid);
          kept.delete(row.uid);
          if (!item) {
            const control = document.createElement("button");
            control.type = "button"; control.className = "chip"; control.hidden = true;
            control.textContent = KinStudyArrivals.RETRY_TEXT.button;
            control.addEventListener("click", requestGatewayRetry);
            item = document.createElement("div"); item.dataset.uid = row.uid;
            item.append(document.createElement("span"), " ", control, " ", document.createElement("span"));
          }
          const gateway = row.gatewayReceipt ?? null, [text, button, note] = item.children;
          const labels = KinStudyArrivals.receiptLabels({ assignment: "assigned",
            observation: KinStudyArrivals.studyObservation(studyObservationModel, row.uid), gateway });
          // Without a receipt the text stays the U1b item text; no No Gateway Report is added to this list.
          text.textContent = `${row.uid} · ${row.origin} · ${KinStudyArrivals.formatTime(row.createdAt)}`
            + (gateway === null ? "" : ` · ${labels.gateway.text}`);
          text.title = gateway === null ? "" : labels.gateway.title;
          drawRetry(row, labels.retry, button, note);
          return item;
        });
        for (const item of kept.values()) item.querySelector("button").dataset.request = "";
        // Moving a kept item would drop keyboard focus, so the children are replaced only when the items change.
        if (items.length !== list.children.length || items.some((item, index) => item !== list.children[index])) list.replaceChildren(...items);
      }
      const s = viewed(), receipt = $("#study-receipt");
      if (!receipt) return;
      receipt.hidden = !s;
      if (!s) return;
      // Every worklist row passed the visible() boundary on the server, so axis A is `assigned` here;
      // institution-less studies only appear in the admin Unmatched Studies list.
      const labels = KinStudyArrivals.receiptLabels({ assignment: "assigned",
        observation: KinStudyArrivals.studyObservation(studyObservationModel, s.uid), gateway: s.gatewayReceipt ?? null });
      $("#receipt-assignment").textContent = labels.assignment.text; $("#receipt-assignment").title = labels.assignment.title;
      $("#receipt-observation").textContent = [labels.observation.text, labels.change?.text].filter(Boolean).join(" · ");
      $("#receipt-observation").title = labels.observation.title;
      drawRetry(s, labels.retry, $("#receipt-retry"), $("#receipt-retry-note"));
      $("#receipt-gateway").textContent = labels.gateway.text; $("#receipt-gateway").title = labels.gateway.title;
    }

    /**
     * S4-U4 Now Retry: one POST with an empty body and nothing shown before the answer. The answer is written
     * only while the same study and receipt are still drawn with this request's token (renderObservation drops
     * it when either changes). `Retry Requested` means the request is stored at KIN, never that a retry ran.
     * S4-F01V: the clicked control is the one bound (the panel or a Not Observed item), and its note is the element
     * right after it; a call without an event is the panel.
     */
    async function requestGatewayRetry(event) {
      const button = event?.currentTarget ?? $("#receipt-retry"), uid = button.dataset.uid, key = button.dataset.key;
      if (!uid || !key || button.hidden || button.dataset.request) return;
      const token = String(++gatewayRetryRequestSeq);
      button.dataset.request = token; button.disabled = true;
      let answer = null, error = null;
      const at = work.capture("document");
      try { answer = await api("POST", `/studies/${encodeURIComponent(uid)}/gateway-retry`, {}, undefined, at); }
      catch (e) { error = e ?? new Error("request failed"); }
      work.commit(at, () => {
        if (button.dataset.request !== token || button.dataset.uid !== uid || button.dataset.key !== key) return;
        const shown = KinStudyArrivals.gatewayRetryAnswer(uid, answer, error);
        Object.assign(button.dataset, { request: "", requested: shown.requested ? "1" : "" });
        const note = button.nextElementSibling;
        note.textContent = shown.text; note.title = shown.title;
        renderObservation();
      });
    }
    $("#receipt-retry").addEventListener("click", requestGatewayRetry);

    /**
     * S4-U2 오더 측 대사 표시 — **엔지니어링 전용**. 입력은 서버가 목록을 완성한 관측과 함께 준 답뿐이다.
     * 브라우저의 `orders`(오프라인이면 localStorage 시드다)는 이 면에 들어오지 않는다. 관측 실패는
     * 마지막 답을 지우지 않고 `관측 불가`만 더한다. 환자 칸·예정 시각은 그리지 않는다.
     */
    function applyOrderReconciliation(result) {
      if (!orderReconciliationModel) return;
      orderReconciliationModel = result ? KinOrderReconciliation.succeeded(orderReconciliationModel, result)
        : KinOrderReconciliation.failed(orderReconciliationModel);
      renderOrderReconciliation();
    }
    function renderOrderReconciliation() {
      const box = $("#order-reconciliation");
      if (!box || !orderReconciliationModel) return;
      const summary = KinOrderReconciliation.summary(orderReconciliationModel);
      box.hidden = summary.hidden;
      $("#order-reconciliation-summary").textContent = summary.text;
      $("#order-reconciliation-summary").title = summary.title;
      $("#order-reconciliation-list").replaceChildren(...summary.rows.map(row => {
        const item = document.createElement("div");
        item.textContent = row.text; item.title = row.title;
        return item;
      }));
    }

    /**
     * S4-U5 DICOM Identity panel — read-only, engineering only. The tags are the ones the server read for the list row
     * (never the row object, which carries the display overlay); the relations are the server's, shown only while this
     * screen's own row state still names the same linked order. A failed observation keeps the last answer and says so.
     */
    function applyStudyIdentity(result) {
      if (!studyIdentityModel) return;
      studyIdentityModel = result ? KinStudyIdentity.succeeded(studyIdentityModel, result)
        : KinStudyIdentity.failed(studyIdentityModel);
      renderStudyIdentity();
    }
    // A correction answer (Match, Unmatch, Modify Exam) for the panel's next-action line. Memory only.
    function noteIdentityCorrection(uid, ok) {
      if (studyIdentityModel) studyIdentityModel = KinStudyIdentity.correction(studyIdentityModel, uid, ok);
      renderStudyIdentity();
    }