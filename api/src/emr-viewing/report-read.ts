import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LocalReadResponse, LocalReadSource } from './local-read';
import { LOCAL_READ_UNAVAILABLE } from './response-lifecycle';

/**
 * Report history reads (A-023 versions, A-025 version citations) as A1 local reads.
 *
 * The caller passes the rows its existing gates already fixed. Nothing here reads the database again, so the
 * recorded targets and the body are the same read. Each returned row or answer carries its own `accessRef`, the
 * server-generated event ID of its provide-prepared record, so a later display report can name that exact record.
 *
 * These routes observe the study's managing institution (StudyState) and the stored rows. They do not retain the
 * source PatientID or source institution, so both stay `not-observed`; no formal patient link is implied.
 */
const NOT_OBSERVED = Object.freeze({ status: 'unresolved', reason: 'not-observed' } as const);
const known = (value: string) => Object.freeze({ status: 'known', value } as const);

function institutionOf(managingInstitution: string | null | undefined): string {
  // A read whose managing institution is unknown cannot be recorded truthfully. It is the ordinary 503 of A1,
  // never a body without its record.
  if (typeof managingInstitution !== 'string' || !managingInstitution) throw new ServiceUnavailableException(LOCAL_READ_UNAVAILABLE);
  return managingInstitution;
}

function source(kind: 'report-version' | 'report-evidence', eventId: string, uid: string, managingInstitution: string,
  stored: { id: number; version: number }, path: readonly (string | number)[]): LocalReadSource {
  return { eventId, managingInstitution, path, cause: 'user-view',
    target: { kind, studyId: known(uid), recordId: known(String(stored.id)), versionId: known(String(stored.version)),
      sourcePatientId: NOT_OBSERVED, sourceInstitution: NOT_OBSERVED } };
}

/** Every stored version the history answer returns is a target, not only the ones a screen later picks. */
export function reportVersionsRead<T extends { id: number; uid: string; version: number }>(uid: string,
  managingInstitution: string | null | undefined, rows: readonly T[]): LocalReadResponse {
  const institution = rows.length ? institutionOf(managingInstitution) : '';
  const body: (T & { accessRef: string })[] = [], sources: LocalReadSource[] = [];
  rows.forEach((row, index) => {
    const eventId = randomUUID();
    body.push({ ...row, accessRef: eventId });
    sources.push(source('report-version', eventId, uid, institution, row, [index]));
  });
  // An empty history has no stored version to record; it is not a synthetic target.
  return new LocalReadResponse(body, sources);
}

/**
 * One stored version's citation projection after the existing readability filter. An empty projection of an existing
 * version is still that version's read; reduced entries stay reduced in the record's projection as in the answer.
 */
export function reportVersionCitationsRead<T extends object>(uid: string, managingInstitution: string | null | undefined,
  stored: { id: number; version: number }, answer: T): LocalReadResponse {
  const eventId = randomUUID();
  return new LocalReadResponse({ ...answer, accessRef: eventId },
    [source('report-evidence', eventId, uid, institutionOf(managingInstitution), stored, [])]);
}
