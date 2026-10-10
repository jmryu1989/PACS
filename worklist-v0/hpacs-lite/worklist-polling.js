

    // 다른 사람이 잡거나 놓은 걸 보려면 주기적으로 확인해야 한다.
    // 기본 30초. 간격 변경은 진행 중인 이전 조회도 무효화한다.
    let poll = null, pollGeneration = 0;
    function startPolling() {
      clearInterval(poll); poll = null;
      const generation = ++pollGeneration;
      const seconds = worklistRefresh?.seconds() ?? 30;
      if (!serverMode || !seconds) return;
      poll = setInterval(async () => {
        if (generation !== pollGeneration || !serverMode || document.hidden || studyPageClient.busy || studyPageClient.paused) return;
        /**
         * 확정이 나가 있으면 이번 회차는 건너뛴다.
         * 폴링 요청이 확정보다 **먼저 나가고 나중에 도착**하면, 방금 승인한 rs=A를
         * 낡은 rs=T로 되돌린다. 화면이 되돌아가면 판독의는 Approve를 또 누르고,
         * baseVersion이 맞아 통과하므로 판이 하나 더 쌓인다.
         */
        if (commitInFlight) return;
        // 이 회차를 시작한 문맥. 로그아웃 준비 중에는 시작하지 않고, 답과 실패가 목록·판독문·연결 상태에 닿는 자리는 모두
        // 이것을 지난다 — 준비·그 취소·세션 종료 뒤에 온 회차는 아무것도 바꾸지 않고 실패로 세지도 않는다.
        const at = work.capture("document");
        if (!work.admits(at)) return;
        const live = () => work.admits(at) && generation === pollGeneration;
        const epoch = commitEpoch;
        try {
          /**
           * **`/bootstrap`이 아니라 `/studies`를 본다.**
           *
           * bootstrap은 StudyState 행만 준다. 그런데 장비에서 막 C-STORE로 도착한
           * 검사는 아직 행이 없다 — 서버가 목록을 만들 때 비로소 생긴다. bootstrap만
           * 보면 그 검사는 다음 새로고침 전까지 아무에게도 안 보인다. 방사선사가
           * 확인해야 판독이 시작되는 구조에서, 도착을 못 보는 건 워크플로가 멈춘 것이다.
           *
           * /studies는 목록과 상태를 함께 주므로 도착·원격판독 수신·상태 변화를
           * 한 번에 잡는다. (오더는 자주 안 바뀌므로 여기서 갱신하지 않는다)
           */
          const r = await studyPageClient.read({ epoch, valid:() => live() && !commitInFlight && epoch === commitEpoch });
          // 요청을 보낸 뒤 확정이 일어났다면 이 응답은 그 이전 사진이다. 버린다.
          if (!live() || commitInFlight || epoch !== commitEpoch) return;
          assertStudyOwner(r);
          await Promise.all([favoriteList?.refresh(),studyTagList?.refresh()]);
          if (!live() || commitInFlight || epoch !== commitEpoch) return;
          pollFails = 0;
          worklistAlerts?.observe(r.studies.map(s=>({uid:s.uid,em:s.state.em})));
          applyObservation(r);
          const arrivals = window.KinStudyArrivals?.diff(studies, r.studies);
          const arrivalNotice = arrivals?.ok && arrivals.changes.length
            ? `기존 검사 ${arrivals.changes.length}건에 영상 또는 시리즈가 추가됐습니다. 현재 영상 화면은 자동 교체하지 않습니다.` : '';
          const known = new Map(studies.map(x => [x.uid, x]));
          const fresh = r.studies.filter(s => !known.has(s.uid));

          // 목록이 달라졌으면(도착·삭제) 통째로 다시 그린다.
          if (fresh.length || r.studies.length !== studies.length) {
            // 지키는 칸은 `fromApi`가 지나는 `mergeObservedReportState` 한 곳이 정한다 — 목록을 통째로
            // 다시 그리는 이 길도 결국 그 함수를 지나므로 여기서 따로 되돌릴 것이 없다.
            studies = r.studies.map(fromApi);
            // 썸네일 등 오른쪽 전체를 다시 그릴 필요는 없지만, 판독문 잠금은 반영해야 한다.
            // loadReport가 값만 보호하므로 새 검사 도착과 Prelim 전환이 겹쳐도 입력은 유지된다.
            render();
            if (selectedUid) { loadReport(); updateReportButtons(); }
            if (fresh.length || arrivalNotice)
              toast([fresh.length ? `새 검사 ${fresh.length}건이 도착했습니다` +
                    (fresh.some(s => s.state.ss === "Unverified") ? " — Technician 탭에서 확인(Verify)하세요" : "") : '', arrivalNotice].filter(Boolean).join(' · '), "info");
            return;
          }

          for (const s of r.studies) {
            const uid = s.uid, st = s.state, existing = known.get(uid);
            if (existing) for (const field of ['count', 'series'])
              if (Number.isSafeInteger(s[field]) && s[field] >= 0) existing[field] = s[field];
            updateNoteSummary(uid, s.techNote);
            updateReaderAssignment(uid, s.readerAssignment);
            if (uid === selectedUid) {
              // 지금 편집 중인 검사는 두 가지만 보호한다:
              //   version — baseVersion은 "내가 화면에서 본 판"이어야 한다. 폴링이 몰래
              //     올리면 남이 저장한 걸 본 적도 없으면서 최신을 아는 셈이 되어, 다음
              //     저장이 충돌 경고 없이 남의 판독문을 덮는다. 낙관적 락의 조용한 무력화.
              //   draft — 타이핑 중인 내 초안. 서버 응답이 한 박자 늦으면 방금 친 문장이
              //     되돌아간다. 확정본(findings 등)은 갱신해도 된다 — 초안이 있는 동안
              //     화면은 초안을 그리고, 확정본은 "그 사이 남이 v5를 확정했다" 안내에만 쓰인다.
              // 나머지(rs·ss·holder 등)도 갱신한다. 남이 승인한 게 화면에 보여야 하니까.
              appState[uid] = mergeObservedReportState(uid, st);
              /**
               * 판독문 값은 loadReport가 스스로 지키므로, 호출자는 항상 상태를 반영한다.
               * 예전엔 폴링이 `prelimHidden`만 반영하고 판독문 패널은 그대로 뒀다 —
               * 내가 읽는 중에 남이 그 검사를 Prelim으로 넘기면 내용이 그대로 남고
               * 버튼도 활성인 채라, Save를 눌러야 403을 만났다. (남은버그 3-1)
               */
            } else {
              /**
               * 고르지 않은 검사도 **수렴을 기다리는 초안**은 덮지 않는다. 삽입이 나가 있는
               * 동안 검사를 옮기면 그때 담아 둔 타건이 이 칸에만 있고, 그 삽입이 거절되면
               * 서버 어디에도 없다. 폴링 한 번이 그것을 서버 투영으로 갈아끼우면 돌아온
               * 화면은 옛 글을 그리고, 수렴 저장이 그 옛 글을 서버에 밀어 넣는다.
               */
              appState[uid] = mergeObservedReportState(uid, st);
            }
            syncStudy(uid);
            if (selectedUid === uid) { loadReport(); updateReportButtons(); }
          }
          render();
          if (arrivalNotice) toast(arrivalNotice, 'info');
          pollFails = 0;
        } catch (e) {
          if (!live()) return;
          // 목록 읽기가 "계정이 바뀌었다"고 했다. 이 세션에 묶어 한 번 확인해 정말 다른 계정의 답일 때만 세션 교체로 닫는다.
          // 401·403으로 읽지 못한 것은 이 회차의 실패일 뿐이다.
          if (e.ownerChanged) {
            studyPageClient.clear();
            if (await accountReplaced(at)) return;
            if (!live()) return;
          }
          if (e.stale || e.code === 'STUDY_LIST_CHANGED') return;
          // The first failure already says 관측 불가 beside the kept list; going offline waits for two.
          markObservationUnavailable();
          /**
           * **일하는 도중에 서버가 죽는 경우.**
           *
           * 예전엔 폴링의 catch가 통째로 비어 있어서, API가 죽어도 화면은 아무 말도
           * 안 했다. 판독의는 계속 쓰고 Save를 누를 때가 되어서야 알게 됐다.
           * 두 번 연속 실패하면 고장으로 본다. 한 번은 blip일 수 있다.
           */
          if (++pollFails >= 2) goOffline(e);
        }
      }, seconds * 1000);
    }
    let pollFails = 0;