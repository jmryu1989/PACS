
// Only a bounded recent grid is retained; transient display-set IDs never leave this session.
const kinViewerLayoutModel = (() => {
  const PREFIX = 'kin-viewer-layout-v1:';
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(s);
  const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join('|') === [...keys].sort().join('|');
  function scope(search) {
    const query = new URLSearchParams(search), raw = query.getAll('StudyInstanceUIDs');
    if (raw.length !== 1) return null;
    const values = raw[0].split(',');
    return values.length >= 1 && values.length <= 2 && values.every(uid) && new Set(values).size === values.length ? values.sort() : null;
  }
  function owner(me) {
    return me?.kind === 'member' && [me.sub, me.institution].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)
      ? PREFIX + JSON.stringify([me.institution, me.sub]) : null;
  }
  function normalize(value) {
    if (!exact(value, ['version', 'studies', 'rows', 'cols', 'active', 'cells']) || value.version !== 1) return null;
    const { studies, rows, cols, active, cells } = value;
    if (!Array.isArray(studies) || ![1, 2].includes(studies.length) || !studies.every(uid) || new Set(studies).size !== studies.length) return null;
    if (![1, 2].includes(rows) || ![1, 2].includes(cols) || !Number.isInteger(active) || active < 0 || active >= rows * cols) return null;
    if (!Array.isArray(cells) || cells.length !== rows * cols || cells.every(x => x === null)) return null;
    if (!cells.every(x => x === null || (exact(x, ['study', 'series']) && studies.includes(x.study) && uid(x.series)))) return null;
    return { version: 1, studies: [...studies].sort(), rows, cols, active, cells: cells.map(x => x && ({ study: x.study, series: x.series })) };
  }
  function read(storage, key) {
    if (!key) throw new Error('계정 정보를 확인할 수 없습니다.');
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value = typeof raw === 'string' && raw.length <= 8192 ? normalize(JSON.parse(raw)) : null;
    if (!value) throw new Error('저장한 배치가 손상되었거나 지원하지 않는 형식입니다.');
    return value;
  }
  function write(storage, key, value) {
    const clean = normalize(value);
    if (!key || !clean) throw new Error('이 배치는 저장할 수 없습니다.');
    storage.setItem(key, JSON.stringify(clean));
  }
  return { PREFIX, uid, scope, owner, normalize, read, write };
})();

function kinHangingProtocolDisplaySets(values) {
  const counts = new Map();
  for (const value of values) {
    const key = JSON.stringify([value.StudyInstanceUID, value.SeriesInstanceUID]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return values.filter(value =>
    counts.get(JSON.stringify([value.StudyInstanceUID, value.SeriesInstanceUID])) === 1 &&
    value.SOPClassHandlerId === '@ohif/extension-default.sopClassHandlerModule.stack' &&
    !value.isCompositeStack && Array.isArray(value.images) && value.images.length > 0 &&
    value.images.every(image => image.StudyInstanceUID === value.StudyInstanceUID &&
      image.SeriesInstanceUID === value.SeriesInstanceUID));
}
