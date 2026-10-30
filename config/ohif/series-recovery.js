
/* S3-U5 CI1. OHIF 3.9.1 로더는 시리즈 메타데이터 GET 하나가 거절되면 다시 묻지 않고 검사 캐시에 거절된 약속을
   남긴다(retrieveMetadataLoaderAsync.js:65-83, retrieveStudyMetadata.js:30-32). 그래서 서버의 500 한 번에 현재 검사
   칸이 빈 채로 끝났다. 설정에서 닿는 재시도 지점이 없으므로 이번 모드 수명주기의 WADO 클라이언트 인스턴스 하나에만
   공개 메서드 retrieveSeriesMetadata를 자기 속성으로 씌우고, 나갈 때 그 속성이 아직 이 확장의 것일 때만 지운다.
   prototype·전역 fetch/XHR은 건드리지 않는다.
   - 다시 묻는 것은 HTTP 500~599 또는 AUTH_* 일시 실패로 거절된 GET이다. 종료 신호·코드 없는 4xx·0·동기 예외는 원래
     결과를 그대로 돌려준다. (수명주기, 검사, 시리즈)마다 한 번, 고정 1000ms 뒤, 같은 this·options로 보낸다.
   - 로더가 쥐는 약속은 여기서 돌려준 하나뿐이다. 다시 받은 응답으로 그 약속을 한 번 채우므로 storeInstances·표시 세트·
     HP 적용도 한 번만 일어난다. 끝난 실패는 마지막 오류로 거절하고 영상이 준비된 척하지 않는다.
   - URL의 검사 목록과 수명주기에 묶는다. 나가거나 URL이 바뀌면 기다리던 재요청은 보내지 않고 원래 오류로 끝내며
     알림도 남기지 않는다.
   - 실패는 URL 순서의 검사 번호와 HTTP 상태로만 알린다. UID·환자 정보는 쓰지 않는다.
   - 모양이 예상과 다르면 씌우지 않고 기본 동작을 둔 채 그 사실만 표시한다. */
function kinCreateSeriesMetadataRecovery() {
  const retryDelay = 1000, own = (target, key) => Object.prototype.hasOwnProperty.call(target, key);
  let services = null, extensions = null, ticket = null, phase = 'stopped';
  const retryable = error => !!error && typeof error === 'object' && !!error.request &&
    (window.KinSessionTransport.refusal(error) === 'temporary' ||
      Number.isInteger(error.status) && error.status >= 500 && error.status <= 599);
  function studiesOf(search) {
    const list = [];
    for (const value of new URLSearchParams(search).getAll('StudyInstanceUIDs'))
      for (const uid of value.split(',')) if (uid && !list.includes(uid)) list.push(uid);
    return list;
  }
  // 다른 확장이 함께 쓰는 #kin-viewer-layout-status 문구를 덮지 않도록 같은 상태 패널 안의 자기 줄만 쓴다.
  function say(text) {
    let node = document.querySelector('#kin-series-metadata-status');
    if (!text) { node?.remove(); return; }
    if (!node) {
      const panel = document.querySelector('#kin-viewer-layout'); if (!panel) return;
      node = document.createElement('p'); node.id = 'kin-series-metadata-status'; node.setAttribute('role', 'alert');
      node.style.cssText = 'margin:6px 0;color:#ffb4a8'; panel.append(node);
    }
    node.textContent = text;
  }
  function describe(failure) {
    const code = Number.isInteger(failure.status) && failure.status > 0 ? 'HTTP ' + failure.status : '요청 오류';
    if (window.KinSessionTransport.refusal(failure.error) === 'temporary') return failure.position + '번째 검사의 연결을 확인하지 못했습니다. 뷰어를 다시 열어 재시도하세요.';
    if (window.KinSessionTransport.refusal(failure.error) === 'denied') return failure.position + '번째 검사의 영상 정보에 접근할 수 없습니다(' + code + '). 이 검사 영상은 표시하지 않았습니다.';
    return failure.position + '번째 검사의 영상 정보를 ' + (failure.retried ? '한 번 다시 요청했지만 ' : '') +
      '불러오지 못했습니다(' + code + '). 이 검사 영상은 표시하지 않았습니다. 뷰어를 다시 여세요.';
  }
  function render(current) {
    const failures = [...current.failures.values()].sort((a, b) => a.position - b.position);
    say([...new Set(failures.map(describe))].join(' '));
  }
  function release() {
    const current = ticket; ticket = null; phase = 'stopped'; say('');
    if (!current) return;
    for (const wait of current.waits) { clearTimeout(wait.timer); wait.cancel(); }
    current.waits.clear(); current.failures.clear();
    if (own(current.client, 'retrieveSeriesMetadata') && current.client.retrieveSeriesMetadata === current.wrapper) delete current.client.retrieveSeriesMetadata;
  }
  function install() {
    const search = location.search, studies = studiesOf(search);
    const refuse = () => { phase = 'refused'; say('영상 정보 재요청 기능을 연결하지 못했습니다. 기본 동작으로 계속 표시하며, 영상 칸이 비어 있으면 뷰어를 다시 여세요.'); };
    let client = null, config = null;
    try {
      const source = extensions?.getActiveDataSource?.()?.[0];
      client = typeof source?.retrieve?.getWadoDicomWebClient === 'function' ? source.retrieve.getWadoDicomWebClient() : null;
      config = typeof source?.getConfig === 'function' ? source.getConfig() : null;
    } catch (_) { client = null; }
    // 지연 로드가 꺼져 있으면 로더가 이 메서드를 부르지 않으므로 복구가 성립하지 않는다.
    if (!client || typeof client !== 'object' || typeof client.retrieveSeriesMetadata !== 'function' ||
        own(client, 'retrieveSeriesMetadata') || config?.enableStudyLazyLoad !== true || !studies.length) return refuse();
    const original = client.retrieveSeriesMetadata;
    const current = { client, wrapper: null, used: new Set(), waits: new Set(), failures: new Map(), retries: 0 };
    const live = () => ticket === current && location.search === search;
    const succeed = key => { if (live() && current.failures.delete(key)) render(current); };
    const fail = (key, position, error, retried) => {
      if (!live()) return;
      const fresh = !current.failures.has(key);
      current.failures.set(key, { position, status: error?.status, error, retried: retried || !!current.failures.get(key)?.retried });
      render(current);
      // The route boundary also listens to unhandled rejections. Its generic toast must not replace the reason
      // this request already has (including the exhausted single retry), even if an upstream caller drops its catch.
      window.dispatchEvent(new CustomEvent('kin-series-metadata-failed', { detail: { error, message: describe(current.failures.get(key)) } }));
      if (!fresh) return;
      try { services?.uiNotificationService?.show?.({ title: 'Image Loading', message: describe(current.failures.get(key)), type: 'error' }); } catch (_) {}
    };
    current.wrapper = function retrieveSeriesMetadata(options) {
      // 동기 예외와 약속이 아닌 반환은 원래 메서드의 것 그대로 나간다.
      const first = original.call(this, options);
      const study = options?.studyInstanceUID, series = options?.seriesInstanceUID, position = studies.indexOf(study) + 1;
      if (!live() || !position || typeof series !== 'string' || !series || typeof first?.then !== 'function') return first;
      const self = this, key = JSON.stringify([study, series]);
      return new Promise((resolve, reject) => {
        first.then(value => { resolve(value); succeed(key); }, error => {
          // 예산은 첫 거절 때 잡는다. 같은 키의 반복·동시 요청은 예산을 새로 만들지 못한다.
          if (!live() || !retryable(error) || current.used.has(key)) { reject(error); fail(key, position, error, false); return; }
          current.used.add(key);
          const wait = { cancel: () => reject(error) };
          wait.timer = setTimeout(() => {
            current.waits.delete(wait);
            if (!live()) { reject(error); return; }
            current.retries++;
            let again;
            try { again = original.call(self, options); } catch (thrown) { reject(thrown); fail(key, position, thrown, true); return; }
            Promise.resolve(again).then(value => { resolve(value); succeed(key); }, final => { reject(final); fail(key, position, final, true); });
          }, retryDelay);
          current.waits.add(wait);
        });
      });
    };
    try { Object.defineProperty(client, 'retrieveSeriesMetadata', { configurable: true, writable: true, enumerable: false, value: current.wrapper }); } catch (_) {}
    if (!own(client, 'retrieveSeriesMetadata') || client.retrieveSeriesMetadata !== current.wrapper) return refuse();
    ticket = current; phase = 'installed';
  }
  const state = () => ({ phase, pending: ticket ? ticket.waits.size : 0, retries: ticket ? ticket.retries : 0, errors: ticket ? ticket.failures.size : 0 });
  return {
    id: 'kin.series-metadata-recovery',
    preRegistration({ servicesManager, extensionManager }) {
      services = servicesManager?.services || null; extensions = extensionManager || null;
      window.kinSeriesMetadataRecoveryState = state;
    },
    onModeEnter() { release(); install(); },
    onModeExit() { release(); },
  };
}
