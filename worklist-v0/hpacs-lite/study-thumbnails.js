

    /**
     * 썸네일. **PACS에서 wrong-patient image display는 그 자체로 사고 분류 항목이다.**
     *
     * 예전엔 `selectedUid`를 캡처하지 않고, 여러 await 뒤의 결과를 무조건 써넣었다.
     * Prev/Next로 빠르게 넘기면 **A의 응답이 B의 화면에 도착한다** — 워크리스트도
     * Clinical Info도 B인데 썸네일만 A인 상태. 판독의가 알아챌 방법이 없다.
     * (`const s = cur();`가 쓰이지도 않은 채 남아 있었다. 원래 여기서 uid를 잡으려던 흔적)
     *
     * 두 가지를 함께 막는다:
     *   uid  — 내가 그리려던 검사가 아직 선택돼 있는가
     *   seq  — 그 사이 더 새로운 요청이 시작되지 않았는가 (A→B→A로 돌아오면 uid만으로는 못 잡는다)
     * await가 있는 모든 지점 뒤에서, 화면에 쓰기 직전에 확인한다. 에러 표시도 마찬가지다 —
     * A의 실패 메시지가 B의 썸네일을 덮으면 그것도 같은 종류의 거짓말이다.
     */
    let thumbSeq = 0, thumbController = null, thumbDone = Promise.resolve(), thumbUrls = [], thumbSort = "source";
    function orderedThumbs(reps) {
      if (thumbSort === "source") return reps;
      const number = value => /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
      const direction = thumbSort === "number-desc" ? -1 : 1;
      // 캐시 원본을 정렬하면 원래 순서를 복원할 수 없다. 불량 번호는 양 방향 모두 뒤로 보낸다.
      return [...reps].sort((a, b) => {
        const x = number(a.number), y = number(b.number);
        if (x === null && y !== null) return 1;
        if (x !== null && y === null) return -1;
        return (x !== null && y !== null ? direction * (x - y) : 0)
          || (a.seriesUid < b.seriesUid ? -1 : a.seriesUid > b.seriesUid ? 1 : 0);
      });
    }
    function cancelThumbs(keepImageGrid = false) {
      ++thumbSeq;
      thumbController?.abort();
      thumbController = null;
      thumbUrls.forEach(url => URL.revokeObjectURL(url));
      thumbUrls = [];
      if (keepImageGrid !== true) imageThumbnails?.close();
    }
    window.addEventListener("pagehide", cancelThumbs);
    window.addEventListener("pageshow", e => { if (e.persisted) renderThumbs(); });
    function renderThumbs(page = 0, cached = null) {
      const wrap = $("#thumbwrap");
      const uid = viewingUid();
      // Polling may repaint the surrounding study without changing its source. Keep an explicitly
      // opened Images page in place; owner or study changes make sync close it synchronously.
      if (imageThumbnails?.sync()) return;
      cancelThumbs();
      if (!uid) { wrap.innerHTML = ""; return; }
      const seq = thumbSeq;
      const controller = thumbController = new AbortController();
      const signal = controller.signal;
      // 이 그리기를 시작한 문맥. 받은 목록·영상·실패가 화면에 닿는 자리는 모두 이 문맥(세션·작업 세대)과 아래 stale()
      // (요청 세대·보는 검사)을 함께 지난다. 받은 blob으로 만든 URL은 이 그리기의 것이라 통과한 뒤에만 만든다.
      const at = work.capture("document");
      const stale = () => signal.aborted || seq !== thumbSeq || uid !== viewingUid();
      const apply = effect => work.commit(at, () => { if (!stale()) effect(); });
      if (demoMode) {
        wrap.innerHTML = `<div class="thumbs" style="grid-template-columns:repeat(2,1fr)"><img src="${DEMO_IMG}"></div>`;
        return;
      }
      wrap.innerHTML = `<div style="color:#556;padding:20px">로딩…</div>`;
      // 이전 fetch뿐 아니라 body 소비까지 끝내야 빠른 전환에도 worker 수가 누적되지 않는다.
      thumbDone = thumbDone.then(async () => {
        if (stale() || !work.admits(at)) return;
        try {
          let reps = cached?.uid === uid ? cached.reps : null;
          if (!reps) {
            const res = await transport.request(`/dicom-web/studies/${uid}/instances`, { context: at, signal, cache: "no-store", deadlineMs: 30000 });
            if (!res.ok || !Array.isArray(res.body)) throw new Error(`HTTP ${res.status}`);
            const inst = res.body;
            const bySeries = new Map();
            for (const i of inst) {
              const series = tagv(i, "0020000E");
              if (!bySeries.has(series)) bySeries.set(series, []);
              bySeries.get(series).push(i);
            }
            reps = [...bySeries.values()].map(arr => {
              arr.sort((a, b) => (+tagv(a, "00200013") || 0) - (+tagv(b, "00200013") || 0));
              const representative = arr[Math.floor(arr.length / 2)];
              // 순번은 DICOM 번호가 아니며, 표시 정보도 실제 preview의 대표 SOP와 함께 캐시해야 한다.
              return { sopUid: tagv(representative, "00080018"), seriesUid: tagv(representative, "0020000E"),
                number: tagv(representative, "00200011").trim(), description: tagv(representative, "0008103E").trim() };
            });
          }
          const start = page * 24, batch = orderedThumbs(reps).slice(start, start + 24);
          const n = Math.max(Math.ceil(Math.sqrt(batch.length)), 2);
          let cells = null;
          if (!apply(() => {
          wrap.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px">
            <button id="thumb-prev" class="chip" type="button" ${page === 0 ? "disabled" : ""}>Previous</button>
            <span id="thumb-range">시리즈 ${batch.length ? start + 1 : 0}–${start + batch.length} / ${reps.length}</span>
            <button id="thumb-next" class="chip" type="button" ${start + 24 >= reps.length ? "disabled" : ""}>Next</button>
            <label>정렬 <select id="thumb-sort" aria-label="시리즈 정렬" style="max-width:100%;background:#14181f;color:#cdd3dc;border:1px solid #3a4356;font:inherit">
              <option value="source">원래 순서</option><option value="number-asc">번호 오름차순</option><option value="number-desc">번호 내림차순</option>
            </select></label>
            </div><div class="thumbs" style="grid-template-columns:repeat(${n},1fr)"></div>`;
          const sort = wrap.querySelector("#thumb-sort");
          sort.value = thumbSort;
          sort.onchange = () => {
            if (stale() || !["source", "number-asc", "number-desc"].includes(sort.value)) return;
            thumbSort = sort.value;
            renderThumbs(0, { uid, reps });
          };
          wrap.querySelector("#thumb-prev").onclick = () => { if (!stale()) renderThumbs(page - 1, { uid, reps }); };
          wrap.querySelector("#thumb-next").onclick = () => { if (!stale()) renderThumbs(page + 1, { uid, reps }); };
          const grid = wrap.querySelector(".thumbs");
          cells = batch.map((rep, index) => {
            const cell = document.createElement("div");
            cell.className = "thumb-card";
            const heading = `항목 ${start + index + 1} · ${rep.number ? `번호 ${rep.number}` : "번호 없음"}`;
            const description = rep.description || "설명 없음";
            cell.title = `${heading}\n${description}\nSeries UID: ${rep.seriesUid || "없음"}\n더블클릭: Film Box`;
            const preview = document.createElement("div");
            preview.className = "thumb-preview";
            preview.textContent = "로딩…";
            const label = document.createElement("div");
            label.className = "thumb-label";
            const number = document.createElement("div"), detail = document.createElement("div");
            number.className = "thumb-number"; number.textContent = heading;
            detail.className = "thumb-description"; detail.textContent = description;
            label.append(number, detail);
            // title과 생략 표시만으로는 키보드나 터치에서 전체 식별 정보를 읽을 수 없다.
            const disclosure = document.createElement("details"), summary = document.createElement("summary"), full = document.createElement("div");
            disclosure.className = "thumb-details"; summary.textContent = "상세 정보";
            full.className = "thumb-full"; full.textContent = `${heading}\n${description}\nSeries UID: ${rep.seriesUid || "없음"}`;
            disclosure.append(summary, full);
            const open = document.createElement("button");
            open.type = "button"; open.className = "chip thumb-open"; open.textContent = "시리즈 열기"; open.disabled = true;
            open.setAttribute("aria-label", `시리즈 열기 · ${heading} · ${description} · Series UID: ${rep.seriesUid || "없음"}`);
            open.onclick = () => { if (!stale() && !open.disabled) openFilmbox(uid, null, rep.seriesUid); };
            const inspect=document.createElement('button');inspect.type='button';inspect.className='chip thumb-preview-open';inspect.textContent='Image Preview';inspect.disabled=true;
            inspect.onclick=()=>{if(!stale()&&!inspect.disabled){const study=viewed();if(study?.uid===uid)imagePreview?.open({...study,series:rep.seriesUid,sop:rep.sopUid});}};
            const images=document.createElement('button');images.type='button';images.className='chip thumb-images-open';images.textContent='Images';images.disabled=true;
            if(!imageThumbnails)images.title='Images 모듈을 불러오지 못했습니다. 페이지를 다시 열어 주세요.';
            images.onclick=()=>{if(!stale()&&!images.disabled){const study=viewed();if(study?.uid!==uid)return;cancelThumbs(true);if(!imageThumbnails?.open({...study,series:rep.seriesUid}))renderThumbs();}};
            cell.append(label, disclosure, preview, open, inspect, images);
            grid.appendChild(cell);
            return { preview, open, inspect, images, alt: `${heading} · ${description}` };
          });
          }) || !cells) return;
          let next = 0, stopped = false;
          const worker = async () => {
            while (!stopped && !stale() && work.admits(at) && next < batch.length) {
              const index = next++;
              try {
                // 한 항목의 조회 실패가 다른 영상과 실패한 항목의 식별 정보까지 지우면 대조할 수 없다.
                const lk = await api("POST", "/dicom/lookup", { studyUid: uid, sopUid: batch[index].sopUid }, signal, at);
                const res = await transport.request(`/instances/${encodeURIComponent(lk.id)}/preview`,
                  { context: at, signal, cache: "no-store", read: "blob", deadlineMs: 30000 });
                if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
                const blob = res.body;
                // 받은 영상을 화면에 놓는 자리(디코딩 뒤, 적용 전): 그 사이 보는 검사나 작업 문맥이 바뀌었으면 URL도 만들지 않는다.
                if (!apply(() => {
                  const url = URL.createObjectURL(blob);
                  thumbUrls.push(url);
                  const img = document.createElement("img");
                  img.alt = cells[index].alt;
                  img.onerror = () => apply(() => { cells[index].open.disabled = cells[index].inspect.disabled = cells[index].images.disabled = true; cells[index].preview.textContent = "썸네일 표시 실패"; });
                  img.ondblclick = () => { if (!stale()) openFilmbox(uid, null, batch[index].seriesUid); };
                  img.src = url;
                  cells[index].preview.replaceChildren(img);
                  cells[index].open.disabled = false;
                  cells[index].inspect.disabled = false;
                  cells[index].images.disabled = !imageThumbnails;
                })) return;
              } catch (e) {
                if (!apply(() => {
                  cells[index].preview.textContent = `썸네일 실패: ${e.message}`;
                  cells[index].images.disabled = true;
                  // 연결/세션 전체의 실패를 24개 개별 결함처럼 재요청하지 않는다. 이미 시작한 항목은 마저 종결한다.
                  if (e.transport === "network" || e.status === 401) {
                    stopped = true;
                    cells.slice(next).forEach(cell => { cell.preview.textContent = "요청 중단 · 새로고침하여 다시 시도하세요"; });
                  }
                })) return;
              }
            }
          };
          const results = await Promise.allSettled(Array.from({ length: Math.min(4, batch.length) }, worker));
          const failure = results.find(r => r.status === "rejected");
          if (failure) throw failure.reason;
        } catch (e) {
          apply(() => {
            thumbUrls.forEach(url => URL.revokeObjectURL(url));
            thumbUrls = [];
            wrap.innerHTML = `<div style="color:#ff8080;padding:10px">썸네일 실패: ${esc(e.message)}</div>`;
          });
        }
      });
      return thumbDone;
    }