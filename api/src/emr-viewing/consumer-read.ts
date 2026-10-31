import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LocalReadTarget } from '../emr-contract/access-event';
import type { SourceIdentity } from '../study-access.service';
import { LocalReadResponse, LocalReadSource } from './local-read';
import { LOCAL_READ_UNAVAILABLE } from './response-lifecycle';

const absent = Object.freeze({ status: 'unresolved', reason: 'not-observed' } as const);
const observed = (value: string | number | null | undefined) => value === null || value === undefined || value === ''
  ? absent : { status: 'known' as const, value: String(value) };

/** Bind only facts from the selected read. A source identifier is never inferred from a patient overlay. */
export function consumerSource(kind: LocalReadTarget['kind'], uid: string, institution: string,
  recordId: string, version: string | number | null, path: readonly (string | number)[],
  identity?: SourceIdentity, fields?: readonly string[]): LocalReadSource {
  if (!institution) throw new ServiceUnavailableException(LOCAL_READ_UNAVAILABLE);
  return { eventId: randomUUID(), managingInstitution: institution, path, fields, cause: 'user-view',
    target: { kind, studyId: observed(uid), recordId: observed(recordId), versionId: observed(version),
      sourcePatientId: observed(identity?.sourcePatientId), sourceInstitution: observed(identity?.sourceInstitution) } };
}

const reportFields = ['version', 'findings', 'conclusion', 'recommendation'];

/** These are the rows actually returned by the list, after pagination, filtering and preliminary withholding. */
export function worklistRead(body: any, author: string, institution: string, institutions: Map<string, string>,
  identities: Map<string, SourceIdentity>): LocalReadResponse {
  const sources: LocalReadSource[] = [];
  for (const [index, row] of body.studies.entries()) {
    const state = row.state, path = ['studies', index], uid = row.uid;
    const identity = identities.get(uid);
    sources.push(consumerSource('study-metadata', uid, state.institutionId, uid, null, path, identity));
    if (state.version > 0 && !state.prelimHidden)
      sources.push(consumerSource('report-head', uid, state.institutionId, uid, state.version, [...path, 'state'], identity, reportFields));
    if (state.draft)
      sources.push(consumerSource('private-draft', uid, state.institutionId, JSON.stringify([uid, author]), state.draftRevision,
        [...path, 'state', 'draft'], identity));
  }
  for (const [index, row] of (body.identityIssues ?? []).entries())
    sources.push(consumerSource('study-metadata', row.uid, institutions.get(row.uid), row.uid, null, ['identityIssues', index]));
  for (const [index, row] of (body.notObserved ?? []).entries())
    sources.push(consumerSource('study-metadata', row.uid, institution,
      row.uid, null, ['notObserved', index]));
  for (const [index, order] of (body.orderReconciliation?.orders ?? []).entries())
    sources.push(consumerSource('order', order.studyUid ?? null, institution, order.oid, null, ['orderReconciliation', 'orders', index]));
  return new LocalReadResponse(body, sources);
}

export function bootstrapRead(body: any, author: string, institution: string): LocalReadResponse {
  const sources: LocalReadSource[] = [];
  for (const [uid, state] of Object.entries<any>(body.states)) {
    const path = ['states', uid];
    sources.push(consumerSource('study-metadata', uid, state.institutionId, uid, null, path));
    if (state.version > 0 && !state.prelimHidden)
      sources.push(consumerSource('report-head', uid, state.institutionId, uid, state.version, path, undefined, reportFields));
    if (state.draft) sources.push(consumerSource('private-draft', uid, state.institutionId, JSON.stringify([uid, author]),
      state.draftRevision, [...path, 'draft']));
  }
  for (const [index, order] of body.orders.entries())
    sources.push(consumerSource('order', order.studyUid, institution, order.oid, null, ['orders', index],
      { sourcePatientId: order.id || null, sourceInstitution: null }));
  return new LocalReadResponse(body, sources);
}

/** Stored keys/measurements are metadata about the saved marks, not a claim that image pixels were displayed. */
export function viewerSources(uid: string, institution: string, rows: any[], path: readonly (string | number)[],
  identity?: SourceIdentity, itemId?: string): LocalReadSource[] {
  return rows.map((row, index) => consumerSource(row.item.kind === 'key' ? 'key-image' : 'measurement',
    uid, institution, itemId ?? row.id, row.revision, [...path, index], identity));
}

/**
 * S7-U4a Clinical Context: the anchor's identity and request tags, the same-patient study rows and the signed prior report
 * bodies the answer actually carries. A failed or absent section returned no record and adds no target. The Tech Note
 * section carries the note's version, author and time but never its text; that is still read from the note record, so it
 * is recorded as a 열람 of that version (the conservative reading of 제23조④; the note's record is its study, as on the
 * Tech Note routes). `studies` holds each returned study's managing institution and observed source PatientID.
 */
export function clinicalContextRead(body: any,
  studies: ReadonlyMap<string, { institution: string | null; patientId: string | null }>): LocalReadResponse {
  const at = (uid: string) => {
    const study = studies.get(uid);
    return { institution: study?.institution ?? '', identity: { sourcePatientId: study?.patientId || null, sourceInstitution: null } };
  };
  const source = (kind: LocalReadTarget['kind'], uid: string, recordId: string, version: string | number | null,
    path: readonly (string | number)[], fields?: readonly string[]) =>
    consumerSource(kind, uid, at(uid).institution, recordId, version, path, at(uid).identity, fields);
  const { uid, sections } = body;
  const sources = [source('study-metadata', uid, uid, null, [], ['uid', 'patientKey', 'anchor', 'identity'])];
  if (sections.requestTags.state === 'present')
    sources.push(source('study-metadata', uid, uid, null, ['sections', 'requestTags']));
  sections.history.items.forEach((item: any, index: number) =>
    sources.push(source('study-metadata', item.studyUid, item.studyUid, null, ['sections', 'history', 'items', index])));
  sections.priorReports.items.forEach((item: any, index: number) =>
    sources.push(source('report-version', item.studyUid, item.provenance.recordId, item.report.version,
      ['sections', 'priorReports', 'items', index])));
  sections.techNote.items.forEach((item: any, index: number) =>
    sources.push(source('tech-note', uid, uid, item.version, ['sections', 'techNote', 'items', index])));
  return new LocalReadResponse(body, sources);
}

/** The existing critical-result visibility projection decides whether a pinned report body was actually provided. */
export function criticalRead(body: any, rows: any[], single = false): LocalReadResponse {
  const items = single ? [body.item] : body.items;
  const sources: LocalReadSource[] = [];
  items.forEach((item, index) => {
    const row = rows[index], path = single ? ['item'] : ['items', index];
    sources.push(consumerSource('critical-result', row.studyUid, row.institutionId, row.id, row.revision, path,
      { sourcePatientId: row.origPatientId || null, sourceInstitution: null }));
    if (item.body) sources.push(consumerSource('report-version', row.studyUid, row.institutionId,
      String(row.pinId), row.sourceVersion, [...path, 'body']));
  });
  return new LocalReadResponse(body, sources);
}

/**
 * D7: an audit row belongs to the institution recorded in it at write time, and readAuditPage returns only the side
 * keyed by that institution. So every returned row's managing institution is the response's institutionId — the
 * record-time key it was projected under, not the reader's current membership.
 */
export function adminAuditRead(body: any, ids: readonly number[]): LocalReadResponse {
  return new LocalReadResponse(body, body.rows.map((_: unknown, index: number) =>
    consumerSource('access-audit', null, body.institutionId, String(ids[index]), null, ['rows', index])));
}

/**
 * A-027 (D1881): GET audit records every returned row to the institution PacsAudit.auditRead selected with it - the
 * recorded institution of a row that has one, else the study's current owner. A row without either refuses the whole
 * response (consumerSource), never a partly recorded one.
 */
export function studyAuditRead(read: { rows: any[]; managing: readonly (string | null)[] }): LocalReadResponse {
  return new LocalReadResponse(read.rows, read.rows.map((row, index) =>
    consumerSource('access-audit', row.target, read.managing[index], String(row.id), null, [index])));
}

/** Existing classification logs organization reads even before clinical adoption; filtered UID lists stay filtered. */
export function organizationRead(body: any, catalogs: boolean): LocalReadResponse {
  const [institution, subject] = body.owner;
  const sources = catalogs ? body.catalogs.map((catalog: any, index: number) =>
    consumerSource('study-organization', null, institution,
      JSON.stringify(['StudyTagCatalog', institution, catalog.scope === 'personal' ? subject : '']),
      catalog.revision, ['catalogs', index])) : [consumerSource('study-organization', null, institution,
        JSON.stringify(['FavoriteWorkspace', institution, subject]), body.revision, [], undefined, ['revision', 'folders'])];
  return new LocalReadResponse(body, sources);
}
