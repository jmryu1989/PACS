window.KinViewerPriorController = (() => {
  // Match the workspace calendar rule: an absent/invalid date is never a Prior.
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return year > 0 && month >= 1 && month <= 12 && day >= 1 &&
      day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }
  const date = value => typeof value === 'string' && /^\d{8}$/.test(value)
    ? value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6) : value;
  function relation(study, current) {
    if (study.uid === current.uid) return 'Current';
    if (!validDate(study.date) || !validDate(current.date)) return 'Unknown-date Comparison';
    if (study.date === current.date) return 'Same-date Comparison';
    return study.date < current.date ? 'Prior' : 'Later Comparison';
  }
  // Same head semantics as related-report.js: reset/cancel supersedes approval;
  // discarded records alone are ignored. Never search backwards for an approve.
  function reportHead(versions) {
    const head = versions.filter(version => version?.action !== 'discarded')
      .sort((a, b) => b.version - a.version)[0];
    return head && Number.isSafeInteger(head.version) && ['approve', 'addendum'].includes(head.action) ? head : null;
  }
  function create({ viewer, loadStudy, onList, onReport }) {
    let origin = null, rows = [], listRequest = null, reportRequest = null, imageRequest = null, disposed = false;
    const fields = ['patientKey', 'sequence', 'viewportId', 'studyUid', 'seriesUid', 'mode'];
    function current() {
      const now = origin && viewer.viewport(origin.viewportId), patient = viewer.snapshot();
      return !disposed && now && patient && patient.key === origin.patientKey && patient.sequence === origin.sequence &&
        fields.every(field => now[field] === origin[field]);
    }
    function closeReport() { reportRequest?.abort(); reportRequest = null; onReport({ state: 'closed' }); }
    function close() {
      listRequest?.abort(); listRequest = null; rows = []; origin = null;
      imageRequest?.abort(); imageRequest = null;
      closeReport(); onList({ state: 'closed' });
    }
    // The adapter calls this on the existing viewport events, including removal.
    function refresh() { if (origin && !current()) close(); }
    async function read(path, request) {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
      if (!response.ok) throw new Error(response.status === 403 || response.status === 404
        ? '이 검사 또는 판독문을 조회할 수 없습니다.' : '연결을 확인한 뒤 다시 시도하세요.');
      return response.json();
    }
    async function open(value) {
      close();
      if (disposed) return;
      origin = value && { ...value };
      if (!current()) { origin = null; onList({ state: 'no-study' }); return; }
      const request = listRequest = new AbortController();
      const admitted = () => listRequest === request && !request.signal.aborted && current();
      onList({ state: 'loading', origin });
      try {
        const data = await read('/api/studies', request);
        if (!admitted()) return;
        if (!Array.isArray(data.studies)) throw new Error('검사 목록 응답을 확인할 수 없습니다.');
        const patient = viewer.snapshot();
        const studies = data.studies.map(study => ({ ...study, date: date(study.date) }));
        const reference = studies.find(study => study.uid === patient.studyUIDs[0] && study.sourcePatientKey === origin.patientKey);
        const source = studies.find(study => study.uid === origin.studyUid && study.sourcePatientKey === origin.patientKey);
        if (!reference || !source) { onList({ state: 'no-study', origin }); return; }
        rows = studies.filter(study => study.sourcePatientKey === origin.patientKey && !study.state?.identityUnresolved)
          .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.uid.localeCompare(a.uid))
          .map(study => ({ ...study, relation: relation(study, reference) }));
        onList({ state: 'ready', origin, studies: rows });
      } catch (error) {
        if (admitted()) onList({ state: 'error', origin, message: error.message });
      }
    }
    async function openReport(uid) {
      closeReport();
      if (!current()) { refresh(); return; }
      const study = rows.find(row => row.uid === uid);
      if (!study) { onReport({ state: 'no-study' }); return; }
      const request = reportRequest = new AbortController();
      const admitted = () => reportRequest === request && !request.signal.aborted && current();
      onReport({ state: 'loading', origin, study });
      try {
        const versions = await read('/api/studies/' + encodeURIComponent(uid) + '/report/versions', request);
        if (!admitted()) return;
        if (!Array.isArray(versions)) throw new Error('판독 이력 응답을 확인할 수 없습니다.');
        const report = reportHead(versions);
        onReport({ state: report ? 'ready' : 'none', origin, study, report });
      } catch (error) {
        if (admitted()) onReport({ state: 'error', origin, study, message: error.message });
      }
    }
    async function openImages(uid) {
      imageRequest?.abort();
      if (!current() || !rows.some(row => row.uid === uid)) { refresh(); return; }
      const request = imageRequest = new AbortController();
      const value = { ...origin };
      const admitted = () => imageRequest === request && !request.signal.aborted && current();
      onList({ state: 'ready', origin, studies: rows, message: '영상을 불러오는 중…' });
      try {
        const sets = await loadStudy(uid);
        if (!admitted()) return;
        if (!sets.length) throw new Error('표시할 영상 시리즈가 없습니다.');
        if (!await viewer.compare(value, [sets[0].displaySetInstanceUID], { signal: request.signal })) {
          if (admitted()) throw new Error('저장·편집 또는 배치를 확인한 뒤 다시 시도하세요. 현재 영상은 유지합니다.');
          return;
        }
        close();
      } catch (error) {
        if (admitted()) onList({ state: 'ready', origin, studies: rows, message: error.message, retryImageUid: uid });
      }
    }
    const unsubscribe = viewer.subscribe(close);
    return { open, openReport, openImages, closeReport, close, refresh,
      retryList() { if (origin && current()) return open(origin); },
      dispose() { disposed = true; unsubscribe(); close(); } };
  }
  return { create };
})();
