
// OHIF's study browser searches priors by MRN. Patient IDs are local to an
// institution, so resolve them through the same source patient key as Related.
// Each resulting UID still uses the ordinary scoped DICOMweb query.
function kinCreateStudySearch() {
  let extensions, stop;
  function mount() {
    stop?.();
    const studies = extensions.getActiveDataSource()[0].query.studies;
    const original = studies.search, search = location.search;
    const opened = new URLSearchParams(search).get('StudyInstanceUIDs')?.split(',') || [];
    let ended = false;
    const controller = new AbortController();
    const session = kinViewerOnEnd(() => { ended = true; controller.abort(); });
    const live = () => !ended && location.search === search;
    const current = () => { if (!live()) throw new Error('검사 조회가 종료되었습니다.'); };
    // OHIF repeats the patient lookup for each opened study. Share the list only
    // within this mode/session; each UID query still checks current access.
    let listing;
    const readList = () => listing ||= (async () => {
      const response = await fetch('/api/studies', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('이전 검사 목록을 확인하지 못했습니다 (HTTP ' + response.status + ').');
      return response.json();
    })().catch(error => { listing = null; throw error; });
    // /api/studies is the radiology list; a clinician-only session is refused it (api/src/clinician-policy.ts) and keeps the
    // stock scoped MRN search. An account not yet confirmed either way does not read that list or merge by MRN.
    const role = async () => {
      const now = kinViewerSession.state();
      return now === 'unconfirmed' ? kinViewerSession.decide() : now;
    };
    const wrapped = async function (params) {
      if (!params?.patientId || params.studyInstanceUid) return original.call(this, params);
      current();
      const verdict = await role();
      current();
      if (verdict === 'read-only') return original.call(this, params);
      if (verdict !== 'writer') throw new Error('계정을 확인하지 못해 이전 검사를 찾지 않았습니다.');
      const list = await readList();
      current();
      const keys = new Set(list.studies.filter(row => opened.includes(row.uid) && row.id === params.patientId && row.sourcePatientKey)
        .map(row => row.sourcePatientKey));
      // The stock MRN request does not identify which opened study asked it.
      // Keep its current-study fallback when two institutions reuse that MRN.
      if (keys.size > 1) throw new Error('기관별 환자 식별이 달라 이전 검사를 하나로 묶을 수 없습니다.');
      if (keys.size === 0) throw new Error('열린 검사의 환자 식별을 확인하지 못했습니다.');
      const rows = list.studies.filter(row => row.id === params.patientId && keys.has(row.sourcePatientKey));
      const results = [];
      for (const row of rows) {
        current();
        results.push(...await original.call(this, { ...params, studyInstanceUid: row.uid, disableWildcard: true }));
      }
      current();
      return results;
    };
    studies.search = wrapped;
    stop = () => { ended = true; controller.abort(); session.close(); if (studies.search === wrapped) studies.search = original; };
  }
  return { id: 'kin.study-search', preRegistration({ extensionManager }) { extensions = extensionManager; },
    onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
