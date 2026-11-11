/*
 * FA-090 EMR Link: builds the hospital EMR address for one worklist row from the institution's template (/api/me emrLink)
 * and opens it in a new browser tab. Placeholders: {patientId} = the patient ID the list shows (after Match, the order's),
 * {accession} = the study's accession number, {studyUid} = the Study Instance UID; each value is URL-encoded. The address
 * format and the EMR's own sign-in belong to the hospital's EMR: nothing is handed over but the address.
 * Used by the worklist's row menu (Open EMR) and the Members page's EMR Link example.
 */
(function (root) {
  'use strict';
  const PLACEHOLDERS = Object.freeze(['patientId', 'accession', 'studyUid']);
  const PATTERN = /\{(patientId|accession|studyUid)\}/g;
  const NOT_SET = 'EMR 주소가 설정되지 않았습니다 — 관리자가 Members ▸ EMR Link에서 설정합니다';
  const SCHEME = 'EMR 주소는 http:// 또는 https://로 시작해야 합니다';
  const NO_PLACEHOLDER = '{patientId}, {accession}, {studyUid} 중 하나는 있어야 합니다';
  const MISSING = Object.freeze({
    patientId: '이 검사에는 환자번호가 없어 EMR을 열 수 없습니다',
    accession: '이 검사에는 접수번호가 없어 EMR을 열 수 없습니다',
    studyUid: '이 검사에는 Study UID가 없어 EMR을 열 수 없습니다',
  });

  /** The template's own problem, or '' when it can be used (the same two rules the server applies when saving). */
  function check(template) {
    const text = typeof template === 'string' ? template.trim() : '';
    if (!text) return NOT_SET;
    if (!/^https?:\/\/[^/?#\s]/i.test(text)) return SCHEME;
    if (!PLACEHOLDERS.some(name => text.includes(`{${name}}`))) return NO_PLACEHOLDER;
    return '';
  }

  /** `{ url }` or `{ error }`: every placeholder the template uses needs a value; an empty one is never filled in. */
  function build(template, values) {
    const problem = check(template);
    if (problem) return { error: problem };
    const text = template.trim();
    for (const name of PLACEHOLDERS) {
      if (!text.includes(`{${name}}`)) continue;
      const value = values?.[name];
      if (typeof value !== 'string' || !value.trim()) return { error: MISSING[name] };
    }
    return { url: text.replace(PATTERN, (_, name) => encodeURIComponent(values[name].trim())) };
  }

  /** The values a worklist row shows: its patient ID (the order's after Match), accession number and Study UID. */
  function rowValues(row) {
    return { patientId: row?.id, accession: row?.acc, studyUid: row?.uid };
  }

  /**
   * Opens the row's EMR address in a new tab, inside the click that asked for it. With noopener the browser returns null
   * even when the tab opened, so the return value is not read as a failure. `{ error }` = nothing was opened.
   */
  function open(template, row) {
    const built = build(template, rowValues(row));
    if (built.error) return built;
    root.open(built.url, '_blank', 'noopener,noreferrer');
    return built;
  }

  root.KinEmrLink = Object.freeze({ PLACEHOLDERS, check, build, rowValues, open });
})(window);
