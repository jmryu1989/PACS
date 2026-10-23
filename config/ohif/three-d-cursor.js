
/* REQ-D-3D-CURSOR 연결 경로. 이 확장은 3D Cursor 모듈 두 개를 불러 컨트롤러를 붙이고
   렌더러의 사건을 컨트롤러의 refresh()로 옮기는 일만 한다. 도구를 켜거나 끄지 않고,
   주석을 만들지 않으며, 저장소에 쓰지 않는다.
   평가 빌드에 커밋되는 플래그는 false다. 켜는 수단은 window.config의 리터럴 하나뿐이고
   URL 매개변수·localStorage·전역 토글 같은 런타임 우회 경로는 두지 않는다. OFF면
   preRegistration에서 스크립트를 주입하지 않으므로 모듈 전역도 패널도 생기지 않는다. */
function kinCreateThreeDCursor() {
  let services, ready = null, current = null, epoch = 0, ended = false, listening = false, channel = null;
  let rows = [], owner = null, mark = null, listeners = [], mounts = 0, renders = 0, invalidations = 0;
  /* 종료는 이 호스트가 소유한다. retiring은 아직 끝나지 않은 disable→stop이고, blocked는 그
     종료가 미완료(unsettled)이거나 예외로 끝나 이 뷰어 창에서 모드가 영구 불가가 된 상태다.
     컨트롤러 안의 poisoned는 인스턴스와 함께 사라지므로 창 단위 기억은 여기에만 있고, 그래서
     retire()는 컨트롤러를 버리기 전에 그 인스턴스의 오염을 읽어 여기로 올린다(:2308-2325). */
  let retiring = null, blocked = false;
  // 'true'가 아닌 모든 값(누락·문자열 'true'·1)은 OFF다.
  const on = () => window.config?.kinThreeDCursor?.enabled === true;
  const say = text => { const node = document.querySelector('#kin-viewer-layout-status'); if (node) node.textContent = text; };
  // mountProtocols() :1436-1448과 같은 형태. 이미 로드된 전역이 있으면 다시 주입하지 않는다.
  const load = (name, global) => window[global] ? Promise.resolve() : new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
    const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('3D Cursor 연결이 지연되어 중단했습니다.')), 20000);
    script.onload = () => finish(window[global] ? null : new Error('3D Cursor 모듈을 확인할 수 없습니다.'));
    script.onerror = () => finish(new Error('3D Cursor 모듈을 불러오지 못했습니다.'));
    document.head.append(script);
  });
  async function get(path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('검사 접근 정보를 확인할 수 없습니다.');
    return await response.json();
  }
  const ownerOf = me => me?.kind === 'member' && me.institution && me.sub ? JSON.stringify([me.institution, me.sub]) : null;

  /* view(info) :1611-1614과 같은 이유의 렌더링엔진 대조: grid가 기록한 viewportId로 얻은
     뷰포트가 이 그리드를 그리는 엔진의 것이 아니면 그 pane은 버린다. 남은 판정(type,
     stack 내용, 앵커)은 컨트롤러가 한다. */
  function panes() {
    const grid = services.viewportGridService, cornerstoneViewports = services.cornerstoneViewportService;
    let engineId = null;
    try { engineId = cornerstoneViewports.getRenderingEngine?.()?.id || null; } catch (_) { engineId = null; }
    const list = [];
    for (const record of grid.getState().viewports.values()) {
      const viewport = cornerstoneViewports.getCornerstoneViewport(record.viewportId);
      const element = document.querySelector('[data-viewport-uid="' + record.viewportId + '"]');
      // 컨트롤러도 stack이 아닌 것을 거절하지만, 후보 목록에 넣지 않는 편이 조용한 탈락과
      // 거절 사유를 헷갈리게 하지 않는다.
      if (!viewport || !element || viewport.type !== 'stack') continue;
      let paneEngine = null;
      try { paneEngine = viewport.getRenderingEngine()?.id || null; } catch (_) { continue; }
      if (!paneEngine || (engineId && paneEngine !== engineId)) continue;
      list.push({ id: record.viewportId, element, viewport });
    }
    return list;
  }

  const numbers = value => Array.isArray(value) ? value.map(Number) : value;
  /* 환자 키는 인증된 /api/studies 행에서만 온다(:1617). DICOM PatientID는 제품의 식별
     경계가 아니므로 태그에서 유도하지 않으며, 행이 없으면 null을 돌려 pane을 거절시킨다. */
  function meta(imageId) {
    const core = window.cornerstone;
    const instance = core?.metaData?.get('instance', imageId);
    if (!instance) return null;
    const plane = core.metaData.get('imagePlaneModule', imageId) || {};
    const patient = rows.find(row => row.uid === instance.StudyInstanceUID)?.sourcePatientKey;
    if (!patient) return null;
    return {
      StudyInstanceUID: instance.StudyInstanceUID, SeriesInstanceUID: instance.SeriesInstanceUID,
      SOPInstanceUID: instance.SOPInstanceUID, FrameOfReferenceUID: instance.FrameOfReferenceUID,
      sourcePatientKey: patient, Modality: instance.Modality,
      ImageOrientationPatient: numbers(instance.ImageOrientationPatient ?? plane.imageOrientationPatient),
      ImagePositionPatient: numbers(instance.ImagePositionPatient ?? plane.imagePositionPatient),
      PixelSpacing: numbers(instance.PixelSpacing ?? plane.pixelSpacing),
      Rows: Number(instance.Rows ?? plane.rows), Columns: Number(instance.Columns ?? plane.columns), imageId };
  }

  /* 직렬화된 세 값 중 하나라도 바뀌면 컨트롤러가 진행 중인 run을 취소한다. owner는 :1605의
     ownerOf, tool은 :948과 같은 getActivePrimaryMouseButtonTool이다. 제품은 뷰어 창에
     읽을 수 있는 세션 식별자를 노출하지 않으므로 session은 이 창의 모드 진입 표식이며,
     세션 종료·모드 이탈에서 컨트롤러 자체가 내려가므로 그 경계와 같은 값이다. */
  function context() {
    if (!owner || !mark) return null;
    let tool = null;
    try {
      const active = services.viewportGridService.getActiveViewportId();
      const viewport = active && services.cornerstoneViewportService.getCornerstoneViewport(active);
      const group = viewport && window.cornerstoneTools.ToolGroupManager.getToolGroupForViewport(viewport.id, viewport.renderingEngineId);
      tool = group?.getActivePrimaryMouseButtonTool() || null;
    } catch (_) { tool = null; }
    return { owner, session: mark, tool };
  }

  /* 확정은 끝까지 컨트롤러 안의 rendered() 폴링이다. IMAGE_RENDERED는 그 대기를 줄이고,
     STACK_NEW_IMAGE·grid 변경·CAMERA_MODIFIED는 표식을 무효화한다. STACK_NEW_IMAGE는
     render 앞에 발화하므로 확정 신호로 쓰지 않는다(B8 §2). */
  function bind() {
    const core = window.cornerstone;
    const listen = (target, type, handler, capture) => {
      target.addEventListener(type, handler, capture);
      listeners.push(() => target.removeEventListener(type, handler, capture));
    };
    const rendered = () => { renders++; current?.refresh(); };
    const invalidate = () => { invalidations++; current?.refresh(); };
    // viewer-frame-coverage.js:141/146과 같은 document capture.
    listen(document, core.Enums.Events.IMAGE_RENDERED, rendered, true);
    listen(document, core.Enums.Events.STACK_NEW_IMAGE, invalidate, true);
    listen(document, core.Enums.Events.CAMERA_MODIFIED, invalidate, true);
    // kinCreateViewerHistory :1326-1329의 grid 구독 관례. 해제는 같은 배열이 가진다.
    for (const event of Object.values(services.viewportGridService.EVENTS)) {
      const subscription = services.viewportGridService.subscribe(event, invalidate);
      listeners.push(() => subscription.unsubscribe());
    }
  }
  function unbind() {
    const pending = listeners; listeners = [];
    for (const off of pending) { try { off(); } catch (_) {} }
  }

  function retire() {
    epoch++; unbind();
    const gone = current; current = null; mark = null;
    if (!gone) return;
    /* 이탈은 disable() 뒤 stop()이다. 둘 중 하나라도 'unsettled'를 돌려주거나 동기 예외·
       reject로 끝나면 취소할 수 없는 native 요청이 남은 것이므로 그 창에서 모드는 영구
       불가다. 호스트는 재마운트로 그것을 되돌리지 않으며, 뒤따르는 정리가 성공해도 이미
       세워진 차단을 지우지 않는다. 정리 자체는 오류 뒤에도 이어서 시도한다. */
    const step = call => Promise.resolve().then(call).then(
      result => { if (result === 'unsettled') blocked = true; }, () => { blocked = true; });
    /* 반환값만으로는 부족하다. 패널의 토글은 호스트를 거치지 않고 스스로 disable('off')을
       부를 수 있고, 그 종료가 미완료로 끝나면 기록은 그 인스턴스 안의 poisoned에만 남는다.
       뒤늦게 진행 중이던 요청이 정리되고 나면 호스트의 disable·stop은 이미 끝난 종료를 보고
       'idle'을 돌려주므로, 결과만 읽는 호스트는 그 미완료를 영원히 보지 못한 채 새 컨트롤러를
       올린다. 그래서 교체 전후로 컨트롤러 상태를 직접 읽어 창 단위 기억으로 올린다. 상태를
       읽지 못한 것은 안전을 확인하지 못한 것이므로 조용히 재마운트를 허용하지 않고 막는다. */
    const inspect = () => {
      let seen = null;
      try { seen = gone.state(); } catch (_) { blocked = true; return; }
      if (!seen || typeof seen !== 'object') { blocked = true; return; }
      if (seen.poisoned || seen.teardown === 'unsettled') blocked = true;
    };
    // 종료끼리 겹치지 않게 이어 붙이고, 끝나기 전에는 새 mount가 생기지 않게 보관한다.
    const run = (retiring || Promise.resolve())
      .then(inspect)
      .then(() => step(() => gone.disable('off')))
      .then(() => step(() => gone.stop()))
      .then(inspect);
    retiring = run;
    run.then(() => { if (retiring === run) retiring = null; });
  }
  function endSession() {
    if (ended) return; ended = true;
    retire();
     window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }

  function watchSession() {
    if (listening) return; listening = true;
    // kinCreateCTSync :1657-1660 + kinCreateImageText :2028-2040의 pagehide 포함 형태.
     window.addEventListener('pagehide', endSession);
    try { channel = kinViewerOnEnd(() => endSession()); } catch (_) {}
  }

  return {
    id: 'kin.three-d-cursor',
    preRegistration({ servicesManager }) {
      services = servicesManager.services;
      if (!on()) return;
      ready = load('three-d-cursor-model.js', 'KinThreeDCursorModel')
        .then(() => load('viewer-three-d-cursor.js', 'KinViewerThreeDCursor'));
      ready.catch(() => {});
      // 다른 확장과 같은 읽기 전용 관측 창구다. 여기서 기능을 켜거나 끌 수 없다.
      window.kinViewerThreeDCursorState = () => ({
        mounts, renders, invalidations, listeners: listeners.length, ended, blocked,
        retiring: !!retiring, mounted: !!current, cursor: current ? current.state() : null });
    },
    onModeEnter() {
      if (!ready || ended || blocked) return;
      // kinCreateFrameCoverage :2171-2175의 티켓 관례. 늦게 도착한 then은 버린다.
      const ticket = ++epoch;
      watchSession();
      // 이전 종료가 끝난 뒤에만 mount한다. 종료를 기다리는 동안 여러 번 진입해도 표가 가장
      // 나중인 요청 하나만 남아 재개하므로, 사용자는 모드를 다시 고르지 않아도 된다.
      ready.then(() => retiring).then(async () => {
        if (ticket !== epoch || ended || blocked) return;
        const me = await get('/api/me');
        const next = ownerOf(me);
        // 늦게 끝난 이전 진입이 최신 목록을 덮지 않도록 표를 확인한 뒤에만 옮긴다.
        const studies = (await get('/api/studies')).studies || [];
        if (ticket !== epoch || ended || blocked || !next) return;
        rows = studies; owner = next; mark = 'kin3d-mode-' + ticket;
        if (current) return;
        current = window.KinViewerThreeDCursor.mount(
          { panes, meta, context, host: document.querySelector('#kin-viewer-layout') });
        mounts++;
        bind();
      }).catch(() => { if (ticket === epoch) say('3D Cursor를 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.'); });
    },
    onModeExit() { retire(); },
  };
}
