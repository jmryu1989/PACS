import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { catchError, defer, finalize, from, mergeMap, throwError } from 'rxjs';
import { createHash, randomUUID } from 'node:crypto';
import { srFile } from '../manual-sr-dicom';
import { rightsAllow } from '../member-rights';
import type { Caller } from '../pacs/access';
import type { StudyAccessService } from '../study-access.service';
import { canReadPreliminary } from '../preliminary-reader';
import { sourceStudies } from '../finding-input';
import { canonical } from '../viewer-input';
import { AccessEvent, AccessEventV1, newAuditLinkId, parseAccessEvent, provideAfterDurableEvent } from '../emr-contract/access-event';
import { ContractError, freeze, refuse } from '../emr-contract/validation';
import { CLINICAL_SURFACES, ClinicalUnit, ClinicalVersion, WriteReceipt } from './contract';
import { ClinicalBody, planClinicalRead, provideClinicalReads } from './records';
import { clinicalHttpError, readClinicalRows } from './services';
import { readSrAdoptionRecord, unitFromRows } from './store';
import type { ClinicalRuntimeParts } from './runtime';

/** All successful response variants are closed here. The services select records; only this boundary constructs bodies. */
export const RESPONSE_ROUTES = {
  'GET questions': 'business', 'GET questions/:id': 'clinical', 'GET studies/:uid/questions': 'business',
  'POST studies/:uid/questions': 'business', 'POST questions/:id/entries': 'business', 'POST questions/:id/close': 'business',
  'GET image-requests': 'clinical', 'GET image-requests/:id': 'clinical', 'GET studies/:uid/image-requests': 'clinical',
  'POST studies/:uid/image-requests': 'business', 'POST image-requests/:id': 'business',
  'GET consultation-candidates': 'business', 'GET consultations': 'clinical', 'GET consultations/:id': 'clinical',
  'POST studies/:uid/consultations': 'clinical', 'POST consultations/:id': 'clinical',
  'GET studies/:uid/findings': 'clinical', 'POST studies/:uid/findings': 'clinical',
  'GET studies/:uid/findings/:id/revisions': 'clinical', 'POST studies/:uid/findings/:id/revisions': 'clinical',
  'POST studies/:uid/manual-sr': 'preparation-or-clinical', 'POST studies/:uid/manual-sr/:id/store': 'clinical',
  'GET reader-candidates': 'business', 'GET studies/:uid/reader-assignment': 'business', 'POST studies/:uid/reader-assignment': 'business',
} as const;
export type ResponseRoute = keyof typeof RESPONSE_ROUTES;
declare const responseBrand: unique symbol;
export type AuthorizedResponse = Readonly<object> & { readonly [responseBrand]: true };
type Binding = { request: unknown; route: ResponseRoute; recheck: () => Promise<void> };
const authorized = new WeakMap<object, Binding>();
function authorize(body: object, binding: Binding): AuthorizedResponse {
  const result = freeze(body) as AuthorizedResponse;
  authorized.set(result, binding);
  return result;
}
const mismatch = () => refuse('ProjectionMismatch');
const iso = (value: Date | string) => new Date(typeof value === 'string' && !/(Z|[+-]\d\d:\d\d)$/.test(value) ? value + 'Z' : value).toISOString();
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const text = (v: unknown) => typeof v === 'string' ? v : mismatch();
const nullableText = (v: unknown) => v === null || v === undefined ? null : text(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : mismatch();
const owner = (c: Caller) => [text(c.institution), text(c.sub)];
const known = <T>(value: T) => ({ status: 'known' as const, value });
const reader = (v: any) => v === null ? null : ({ sub: text(v.sub), actor: text(v.actor), name: text(v.name) });

export interface ResponseContext { db: any; tx: any; caller: Caller; access: StudyAccessService }
type Page = { nextCursor?: string | number | null };
export type ClinicalResponseSelector =
  | { view: 'question'; route: 'GET questions/:id'; id: string; current: { rs: string; version: number | null } }
  | ({ view: 'images'; route: 'GET image-requests' | 'GET studies/:uid/image-requests' | 'GET image-requests/:id'; ids: readonly string[] } & Page)
  | ({ view: 'consultations'; route: 'GET consultations' | 'GET consultations/:id' | 'POST studies/:uid/consultations' | 'POST consultations/:id';
      ids: readonly string[]; receipt?: WriteReceipt; direction?: string } & Page)
  | ({ view: 'findings'; route: 'GET studies/:uid/findings'; ids: readonly string[]; links: readonly { id: string; links: readonly FindingLink[] }[]; schema?: string } & Page)
  | ({ view: 'finding-history'; route: 'GET studies/:uid/findings/:id/revisions'; id: string; sequences: readonly number[]; schema?: string } & Page)
  | { view: 'sr'; route: 'POST studies/:uid/manual-sr' | 'POST studies/:uid/manual-sr/:id/store'; id: string; studyUid: string }
  | { view: 'finding-write'; route: 'POST studies/:uid/findings' | 'POST studies/:uid/findings/:id/revisions'; receipt: WriteReceipt };
export interface FindingLink { itemId?: string; jobId?: string; markId?: string | null; linkState: string; headRevision: number | null; headHidden: boolean | null }
function link(v: FindingLink) {
  if (!['missing', 'hidden', 'metadata-changed', 'current', 'revised'].includes(v.linkState)) mismatch();
  return { ...(v.itemId === undefined ? { jobId: text(v.jobId), markId: nullableText(v.markId) } : { itemId: text(v.itemId) }),
    linkState: v.linkState, headRevision: v.headRevision === null ? null : count(v.headRevision), headHidden: v.headHidden === null ? null : v.headHidden === true };
}
function summary(v: any) {
  return { id: text(v.id), studyUid: text(v.studyUid), state: text(v.state), revision: count(v.revision),
    author: { actor: text(v.author.actor), name: text(v.author.name) }, entryCount: count(v.entryCount),
    lastEntryAt: iso(v.lastEntryAt), createdAt: iso(v.createdAt), updatedAt: iso(v.updatedAt) };
}
export type BusinessResponse =
  | { type: 'questions'; owner: readonly (string | null)[]; items: readonly ReturnType<typeof summary>[]; nextCursor?: string | null }
  | { type: 'candidates'; owner: readonly (string | null)[]; readers: readonly { sub: string; actor: string; name: string }[]; canManage?: boolean }
  | { type: 'assignment'; owner: readonly (string | null)[]; studyUid: string; revision: number; reader: { sub: string; actor: string; name: string } | null;
      canManage: boolean; blocked: string; history: readonly { at: Date | string; actor: string; detail: { institution: string; revision: number; from: string | null; to: string | null; closed?: string } }[] };
/** Explicit operational DTOs, including nested fields. This API cannot turn arbitrary result JSON into an authorized body. */
export function businessResponse(request: unknown, route: ResponseRoute, value: BusinessResponse): AuthorizedResponse {
  if (RESPONSE_ROUTES[route] !== 'business') refuse('ResponseVariantRefused');
  const own = value.owner.map(text);
  let body: object;
  switch (value.type) {
    case 'questions':
      if (!['GET questions', 'GET studies/:uid/questions'].includes(route)) refuse('ResponseVariantRefused');
      body = { owner: own, items: value.items.map(summary), ...(value.nextCursor === undefined ? {} : { nextCursor: nullableText(value.nextCursor) }) }; break;
    case 'candidates':
      if (!['GET reader-candidates', 'GET consultation-candidates'].includes(route)) refuse('ResponseVariantRefused');
      body = { owner: own, readers: value.readers.map(reader), ...(value.canManage === undefined ? {} : { canManage: value.canManage === true }) }; break;
    case 'assignment':
      if (!['GET studies/:uid/reader-assignment', 'POST studies/:uid/reader-assignment'].includes(route)) refuse('ResponseVariantRefused');
      body = { owner: own, studyUid: text(value.studyUid), revision: count(value.revision), reader: reader(value.reader),
        canManage: value.canManage === true, blocked: ['', '대기·보류 상태의 검사만 배정을 바꿀 수 있습니다.', '판독 중인 검사입니다. 작성자가 점유를 해제한 뒤 다시 확인하세요.'].includes(value.blocked) ? value.blocked : mismatch(), history: value.history.map(h => ({ at: iso(h.at), actor: text(h.actor),
          detail: { institution: text(h.detail.institution), revision: count(h.detail.revision), from: nullableText(h.detail.from), to: nullableText(h.detail.to),
            ...(h.detail.closed === undefined ? {} : { closed: ['tele-closed', 'study-deleted'].includes(h.detail.closed) ? h.detail.closed : mismatch() }) } })) }; break;
    default: return refuse('ResponseVariantRefused');
  }
  return authorize(body, { request, route, recheck: async () => {} });
}

/** An ACK is rebuilt from the original terminal and its immutable version, never the mutable receipt's result JSON. */
export function writeAcknowledgement(request: unknown, c: Caller, route: ResponseRoute, receipt: WriteReceipt,
  unit: Readonly<ClinicalUnit>, replayed: boolean, stored: any): AuthorizedResponse {
  const v = unit?.versions[receipt.revision - 1];
  if (!v || v.recordId !== receipt.recordId || v.versionId !== receipt.versionId || v.sha256 !== receipt.versionSha256 ||
      v.state.to !== receipt.state || v.at !== receipt.at || stored?.requestId !== receipt.requestId || stored?.id !== v.recordId ||
      stored?.revision !== receipt.revision || stored?.studyUid !== v.studyId) mismatch();
  if (CLINICAL_SURFACES[v.surface].route !== route) mismatch();
  const question = v.record === 'question';
  const action = v.surface === 'question.reply' ? (v.kind === 'clinical-answer' ? 'answer' : 'followup') : v.surface.split('.')[1];
  if (stored.action !== action || stored.from !== v.state.from || stored.to !== v.state.to || stored.at !== v.at) mismatch();
  const applied = { id: v.recordId, studyUid: v.studyId, requestId: receipt.requestId, action,
    ...(question ? { entry: { id: receipt.requestId, seq: v.sequence, kind: action === 'create' ? 'question' : action } }
      : { kind: ['external-image', 'image-transfer'].includes(stored.kind) ? stored.kind : mismatch() }),
    from: v.state.from, to: v.state.to, revision: v.sequence, at: v.at };
  return authorize({ owner: owner(c), applied, replayed }, { request, route, recheck: async () => {} });
}

type Loaded = { unit: Readonly<ClinicalUnit> | null; row: any; entries: any[]; sequences: number[]; originals: Map<number, any> };
function chosen(v: Loaded) { return v.sequences.map(n => v.unit.versions[n - 1] ?? mismatch()); }
function validateReceipt(unit: Readonly<ClinicalUnit>, receipt: WriteReceipt) {
  const v = unit?.versions[receipt.revision - 1];
  if (!v || v.recordId !== receipt.recordId || v.versionId !== receipt.versionId || v.sha256 !== receipt.versionSha256 ||
      v.state.to !== receipt.state || v.at !== receipt.at) mismatch();
}
async function load(ctx: ResponseContext, selector: Exclude<ClinicalResponseSelector, { view: 'sr' }>): Promise<Loaded[]> {
  const ids = 'ids' in selector ? selector.ids : [selector.view === 'finding-write' ? selector.receipt.recordId : selector.id];
  if (ids.length > 200 || new Set(ids).size !== ids.length) refuse('ResponseSelectionRefused');
  const result: Loaded[] = [];
  for (const id of ids) {
    const unit = unitFromRows(text(id), await readClinicalRows(ctx.tx, id));
    const record = selector.view === 'question' ? 'question' : selector.view === 'images' ? 'image-request' :
      selector.view === 'consultations' ? 'consultation' : 'finding';
    if (unit && unit.record !== record) mismatch();
    let row: any, entries: any[] = [];
    if (record === 'question') {
      row = await ctx.tx.studyQuestion.findUnique({ where: { id } });
      entries = await ctx.tx.studyQuestionEntry.findMany({ where: { questionId: id }, orderBy: { seq: 'asc' } });
    } else if (record === 'image-request') row = await ctx.tx.studyImageRequest.findUnique({ where: { id } });
    else if (record === 'consultation') row = await ctx.tx.studyConsultation.findUnique({ where: { id } });
    else {
      const heads = await ctx.tx.$queryRaw`SELECT id::text AS id, "studyUid", "authorSub", "authorActor", revision, hidden,
        "createdAt", "updatedAt", snapshot::text AS snapshot FROM "Finding" WHERE id=${text(id)}::uuid`;
      row = heads[0];
      entries = await ctx.tx.$queryRaw`SELECT revision, action, reason, actor, "authorSub", "payloadBytes", at, snapshot::text AS snapshot
        FROM "FindingRevision" WHERE "findingId"=${text(id)}::uuid ORDER BY revision`;
    }
    if (!row) refuse('NotFound');
    let sequences = unit ? [1, unit.revision].filter((n, i, a) => a.indexOf(n) === i) : [];
    if (selector.view === 'question') sequences = unit ? unit.versions.map(v => v.sequence) : [];
    if (selector.view === 'findings') sequences = unit ? [unit.revision] : [];
    if (selector.view === 'finding-history') sequences = unit ? [...selector.sequences] : [];
    if (selector.view === 'finding-write') { validateReceipt(unit, selector.receipt); sequences = [selector.receipt.revision]; }
    if (selector.view === 'consultations' && selector.receipt) {
      validateReceipt(unit, selector.receipt); sequences = [...new Set([1, selector.receipt.revision])];
    }
    const originals = new Map<number, any>();
    const versions = unit?.versions.map(v => text(v.versionId)) ?? [];
    const facts = versions.length ? await ctx.tx.$queryRaw`SELECT * FROM emr_clinical.response_facts(${text(id)}::text, ${versions}::text[])` : [];
    if (unit) for (const v of unit.versions) {
      const matches = facts.filter(f => f.version_id === v.versionId);
      if (matches.length !== 1) mismatch();
      const p = JSON.parse(matches[0].projection);
      if (p?.caller?.sub !== v.author.subject) mismatch();
      const name = typeof p.caller.name === 'string' && p.caller.name.trim() ? p.caller.name : text(p.caller.actor);
      originals.set(v.sequence, { requestId: text(matches[0].request_id), caller: { actor: text(p.caller.actor), name: Array.from(name).slice(0, 256).join('') },
        recipient: p.recipient == null ? null : reader(p.recipient), create: p.create ? { kind: text(p.create.kind), counterparty: text(p.create.counterparty),
          counterpartyInstitutionId: nullableText(p.create.counterpartyInstitutionId) } : null });
    }
    result.push({ unit, row, entries, sequences, originals });
  }
  return result;
}

async function access(ctx: ResponseContext, loaded: readonly Loaded[]) {
  const uids = new Set<string>(), lineages = new Map<Loaded, Set<string>>();
  for (const l of loaded) {
    uids.add(text(l.row.studyUid));
    const lineage = new Set<string>([text(l.row.studyUid)]);
    lineages.set(l, lineage);
    if (l.unit?.record === 'finding') for (const v of l.unit.versions) {
      for (const uid of v.navigation) lineage.add(text(uid));
      for (const source of JSON.parse(v.text).sources) for (const uid of sourceStudies(source)) lineage.add(text(uid));
    }
    // Current and legacy projection lineage must also be readable: deleting a source from the current head cannot
    // remove the permission boundary of an older copied source.
    if (l.entries.length && (l.unit?.record === 'finding' || l.row.snapshot !== undefined)) for (const e of l.entries) {
      const snapshot = typeof e.snapshot === 'string' ? JSON.parse(e.snapshot) : e.snapshot;
      for (const source of snapshot.sources ?? []) for (const uid of sourceStudies(source)) lineage.add(text(uid));
    }
    for (const uid of lineage) uids.add(uid);
  }
  const ids = [...uids].sort();
  if (!ids.length) return [];
  const rows: any[] = await ctx.tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid=ANY(${ids}::text[]) ORDER BY uid`;
  await ctx.access.require(ctx.caller, ids, ctx.tx);
  for (const uid of ids) {
    const row = rows.find(r => r.uid === uid);
    const findingScope = loaded.some(l => l.row.snapshot !== undefined);
    if (!row || (row.institutionId !== ctx.caller.institution && (!findingScope || row.teleInstitutionId !== ctx.caller.institution)) ||
        findingScope && !canReadPreliminary(row, ctx.caller)) refuse('NotFound');
  }
  for (const l of loaded) {
    if (l.row.snapshot !== undefined) {
      const anchor = rows.find(r => r.uid === l.row.studyUid);
      for (const uid of lineages.get(l)) if (uid !== l.row.studyUid &&
          (!anchor?.institutionId || rows.find(r => r.uid === uid)?.institutionId !== anchor.institutionId)) refuse('NotFound');
    }
    if (l.row.institutionId !== undefined && l.row.institutionId !== ctx.caller.institution) refuse('NotFound');
    const roles = ctx.caller.roles;
    if (l.row.recipientSub !== undefined) {
      if (!roles.includes('admin') && (!roles.includes('radiologist') || ![l.row.requesterSub, l.row.recipientSub].includes(ctx.caller.sub))) refuse('NotFound');
    } else if (l.row.requesterSub !== undefined && !roles.some(r => ['admin', 'technician', 'radiologist'].includes(r)) &&
        (!roles.includes('clinician') || l.row.requesterSub !== ctx.caller.sub)) refuse('NotFound');
  }
  for (const l of loaded) if (l.unit && (l.unit.studyId !== l.row.studyUid || l.unit.managingInstitutionId !== ctx.caller.institution)) mismatch();
  return rows;
}
function findingItem(l: Loaded, sequence: number) {
  const v = l.unit?.versions[sequence - 1], row = l.entries.find(e => e.revision === sequence);
  if (!v) return null;
  const snapshot = typeof row?.snapshot === 'string' ? JSON.parse(row.snapshot) : row?.snapshot;
  if (!row || canonical(snapshot) !== v.text || row.authorSub !== v.author.subject || iso(row.at) !== v.at ||
      row.actor !== l.originals.get(sequence)?.caller.actor || row.payloadBytes !== Buffer.byteLength(text(row.snapshot), 'utf8') ||
      row.action !== (v.sequence === 1 ? 'create' : v.state.from === 'Visible' && v.state.to === 'Hidden' ? 'hide' : v.state.from === 'Hidden' && v.state.to === 'Visible' ? 'restore' : 'edit') || row.reason !== (v.reasonSource === 'stated' ? v.reason : '')) mismatch();
  return JSON.parse(v.text);
}
function finding(l: Loaded, sequence: number) {
  const v = l.unit?.versions[sequence - 1], item = findingItem(l, sequence), row = l.row;
  if (l.unit && (l.unit.versions[0].author.subject !== row.authorSub || l.unit.versions[0].at !== iso(row.createdAt) ||
      row.authorActor !== l.originals.get(1)?.caller.actor)) mismatch();
  if (l.unit && sequence === l.unit.revision && (row.revision !== sequence || canonical(JSON.parse(row.snapshot)) !== v.text ||
      row.hidden !== item.hidden || iso(row.updatedAt) !== v.at)) mismatch();
  return { id: text(row.id), studyUid: text(row.studyUid), authorSub: v ? v.author.subject : text(row.authorSub), authorActor: text(row.authorActor),
    revision: sequence, createdAt: iso(row.createdAt), hidden: item ? item.hidden : row.hidden === true,
    updatedAt: v ? v.at : iso(row.updatedAt), item };
}
function requestItem(l: Loaded, consultation: boolean, echo: boolean) {
  const row = l.row, versions = l.unit ? chosen(l) : [], first = versions[0], last = versions[versions.length - 1];
  const revision = last?.sequence ?? row.revision, state = last?.state.to ?? row.state;
  if (l.unit && (row.requesterSub !== first.author.subject || row.reason !== first.text || iso(row.createdAt) !== first.at ||
      (!echo && (row.revision !== revision || row.state !== state || iso(row.updatedAt) !== last.at)))) mismatch();
  const original = l.originals.get(1), ending = l.originals.get(last?.sequence);
  if (l.unit) {
    if (row.requesterActor !== original.caller.actor) mismatch();
    if (consultation) {
      if (!original.recipient || row.recipientSub !== original.recipient.sub || row.recipientActor !== original.recipient.actor ||
          row.recipientName !== original.recipient.name || !echo && row.changedBy !== ending.caller.actor) mismatch();
    } else {
      if (!original.create || row.kind !== original.create.kind || row.counterpartyText !== original.create.counterparty ||
          row.counterpartyInstitutionId !== original.create.counterpartyInstitutionId || row.requesterName !== original.caller.name ||
          row.changedBy !== ending.caller.actor) mismatch();
      const handled = [...l.unit.versions].reverse().find(v => v.sequence > 1 && v.capacity !== 'clinical-author');
      const handler = handled ? l.originals.get(handled.sequence).caller : null;
      if ((row.handlerActor ?? null) !== (handler?.actor ?? null) || (row.handlerName ?? null) !== (handler?.name ?? null)) mismatch();
    }
  }
  const note = last && last.sequence > 1 ? last.text : null;
  if (!echo && l.unit && (consultation ? (row.reply ?? null) !== (state === 'Completed' ? note : null) ||
    (row.cancelReason ?? null) !== (state === 'Cancelled' ? note : null) : (row.note ?? null) !== note)) mismatch();
  if (consultation) return { id: text(row.id), studyUid: text(row.studyUid), institutionId: text(row.institutionId),
    requesterSub: first?.author.subject ?? text(row.requesterSub), requesterActor: text(row.requesterActor), recipientSub: text(row.recipientSub),
    recipientActor: text(row.recipientActor), recipientName: text(row.recipientName), reason: first?.text ?? null,
    reply: state === 'Completed' ? note : null, cancelReason: state === 'Cancelled' ? note : null, state, revision,
    changedBy: ending ? ending.caller.actor : text(row.changedBy), createdAt: first?.at ?? iso(row.createdAt), updatedAt: last?.at ?? iso(row.updatedAt) };
  return { id: text(row.id), studyUid: text(row.studyUid), kind: text(row.kind), state, revision,
    requester: { actor: text(row.requesterActor), name: text(row.requesterName) },
    counterparty: { text: text(row.counterpartyText), institutionId: nullableText(row.counterpartyInstitutionId) },
    reason: first?.text ?? null, handler: row.handlerActor == null ? null : { actor: text(row.handlerActor), name: text(row.handlerName) },
    note, createdAt: first?.at ?? iso(row.createdAt), updatedAt: last?.at ?? iso(row.updatedAt) };
}
function dto(selector: Exclude<ClinicalResponseSelector, { view: 'sr' }>, loaded: readonly Loaded[], c: Caller): object {
  if (selector.view === 'question') {
    const l = loaded[0], row = l.row, versions = l.unit?.versions;
    if (!versions) refuse('ClinicalVersionMissing');
    if (row.revision !== versions.length || row.entryCount !== versions.length || row.state !== l.unit.state ||
        row.authorSub !== versions[0].author.subject || row.authorActor !== l.originals.get(1).caller.actor ||
        row.authorName !== l.originals.get(1).caller.name || row.changedBy !== l.originals.get(versions.length).caller.actor ||
        l.entries.length !== versions.length) mismatch();
    const entries = versions.map((v, i) => {
      const e = l.entries[i], kind = i === 0 ? 'question' : v.surface === 'question.close' ? 'close' : v.kind === 'clinical-answer' ? 'answer' : 'followup';
      const original = l.originals.get(v.sequence), role = v.capacity === 'operational-staff' ? 'admin' : v.kind === 'clinical-answer' ? 'radiologist' : 'clinician';
      if (e.id !== original.requestId || e.seq !== v.sequence || e.kind !== kind || e.body !== (v.text ?? '') || e.authorSub !== v.author.subject ||
          e.authorActor !== original.caller.actor || e.authorName !== original.caller.name || e.authorRole !== role || iso(e.at) !== v.at) mismatch();
      return { id: text(e.id), seq: v.sequence, kind, body: v.text ?? '', author: { actor: text(e.authorActor), name: text(e.authorName), role: text(e.authorRole) },
        at: v.at, reportAnchor: { rs: text(e.reportRs), version: e.reportVersion === null ? null : count(e.reportVersion) } };
    });
    const last = versions[versions.length - 1];
    if (iso(row.createdAt) !== versions[0].at || iso(row.updatedAt) !== last.at || row.state === 'Closed' && iso(row.closedAt) !== last.at) mismatch();
    if (row.state === 'Closed' && (row.closedByActor !== entries.at(-1).author.actor || row.closedByName !== entries.at(-1).author.name ||
        row.closedByRole !== entries.at(-1).author.role)) mismatch();
    return { owner: owner(c), item: { id: row.id, studyUid: l.unit.studyId, state: l.unit.state, revision: l.unit.revision,
      author: { actor: text(row.authorActor), name: text(row.authorName) }, entryCount: entries.length, lastEntryAt: last.at,
      createdAt: versions[0].at, updatedAt: last.at, entries,
      closed: row.state === 'Closed' ? { at: last.at, by: { actor: text(row.closedByActor), name: text(row.closedByName), role: text(row.closedByRole) } } : null,
      current: { rs: text(selector.current.rs), version: selector.current.version === null ? null : count(selector.current.version) } } };
  }
  if (selector.view === 'images' || selector.view === 'consultations') {
    const items = loaded.map(l => requestItem(l, selector.view === 'consultations', 'receipt' in selector && !!selector.receipt));
    const single = selector.route.includes('/:id') || selector.route.startsWith('POST');
    return { owner: owner(c), ...(single ? { item: items[0] } : { items }),
      ...(selector.view === 'consultations' && selector.direction !== undefined ? { direction: text(selector.direction) } : {}),
      ...(selector.nextCursor === undefined ? {} : { nextCursor: selector.nextCursor }) };
  }
  if (selector.view === 'finding-write') return finding(loaded[0], selector.receipt.revision);
  const schemaCheck = (items: any[]) => { if (selector.schema !== '2' && items.some(i => i !== null && i.schemaVersion !== 1)) refuse('FINDING_CLIENT_OUTDATED'); };
  if (selector.view === 'findings') {
    const items = loaded.map(l => ({ ...finding(l, l.unit?.revision ?? l.row.revision),
      links: (selector.links.find(v => v.id === l.row.id)?.links ?? []).map(link) }));
    schemaCheck(items.map(i => i.item));
    return { items, nextCursor: selector.nextCursor ?? null };
  }
  const l = loaded[0], revisions = selector.sequences.map(n => {
    const row = l.entries.find(e => e.revision === n) ?? mismatch(), v = l.unit?.versions[n - 1];
    return { revision: count(n), action: text(row.action), reason: v ? v.reasonSource === 'stated' ? v.reason : '' : null,
      actor: text(row.actor), at: iso(row.at), payloadBytes: count(row.payloadBytes), item: findingItem(l, n) };
  });
  schemaCheck(revisions.map(r => r.item));
  return { revisions, nextCursor: selector.nextCursor ?? null };
}


async function currentMember(ctx: ResponseContext) {
  const rights = await ctx.tx.memberRights.findUnique({ where: { sub: ctx.caller.sub } });
  if (!rightsAllow(rights) || rights.institution !== ctx.caller.institution ||
      !same([...rights.roles].sort(), [...ctx.caller.roles].sort())) refuse('NotFound');
}
/** The shared boundary also owns prepared/adopted SR envelopes; callers supply only a stored record selector. */
async function srResponse(parts: ClinicalRuntimeParts, request: unknown, selector: Extract<ClinicalResponseSelector, { view: 'sr' }>, ctx: ResponseContext) {
  const facts = await parts.context.facts(request), c = ctx.caller, policy = await ctx.access.snapshot(c, ctx.tx);
  const build = async (read: ResponseContext) => {
    await currentMember(read);
    const row = await read.tx.manualSr.findUnique({ where: { id: selector.id } });
    if (!row || row.studyUid !== selector.studyUid || row.authorSub !== c.sub || !c.roles.includes('radiologist')) refuse('NotFound');
    const study = await read.tx.studyState.findUnique({ where: { uid: row.studyUid } });
    if (!study || study.institutionId !== c.institution && study.teleInstitutionId !== c.institution || !canReadPreliminary(study, c)) refuse('NotFound');
    await read.access.require(read.caller, [row.studyUid], read.tx);
    if (!row.dicom || !row.dataset || !row.attemptedAt && Date.now() - new Date(row.createdAt).getTime() >= 86400000) refuse('PreparedSrExpired');
    // The existing closed DICOM encoder rejects unknown tags recursively. Comparing its bytes also covers nested values,
    // SOP identity and dataset/base64 divergence, without recalculating any measurements.
    const bytes = Buffer.from(row.dicom), encoded = srFile(row.dataset), hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== row.sha256 || !encoded.equals(bytes) || row.dataset.StudyInstanceUID !== row.studyUid) mismatch();
    const stored = await readSrAdoptionRecord(read.tx, row.id);
    if (stored && (!stored.fact.confirmed || stored.fact.bytesSha256 !== hash || stored.fact.sopInstanceUid !== row.dataset.SOPInstanceUID ||
        stored.adoption.author.id !== facts.actor.identity.id || stored.adoption.recordId !== row.id || stored.adoption.studyId !== row.studyUid)) refuse('OutcomeUnknown');
    const file = selector.route === 'POST studies/:uid/manual-sr';
    if (row.storedAt && !stored) refuse('OutcomeUnknown');
    const body = { id: text(row.id), dataset: file || stored ? structuredClone(row.dataset) : null,
      stored: !!row.storedAt, storedAt: row.storedAt ? iso(row.storedAt) : null, sha256: hash,
      expiresAt: row.attemptedAt ? null : new Date(new Date(row.createdAt).getTime() + 86400000).toISOString(),
      ...(file ? { dicom: bytes.toString('base64') } : {}) };
    return { stored, body };
  };
  const { stored, body } = await build(ctx);
  if (stored) {
    const a = stored.adoption;
    const event = parseAccessEvent({ formatVersion: 1, surface: selector.route, eventId: `clinical-read:${randomUUID()}`,
      userId: known({ ...facts.actor.identity }), rolesAtTime: known([...facts.actor.roles]), actingInstitution: known(facts.actor.institutionId),
      managingInstitution: known(a.managingInstitutionId), occurredAt: new Date().toISOString(), trustedProxyIp: facts.trustedProxyIp,
      cause: 'user-view', context: { basis: 'worklist', studyId: a.studyId, relatedStudyId: null, reason: null }, executor: 'member',
      targets: [{ kind: 'manual-sr', patientLinkSnapshot: known({ ...a.patient }), studyId: known(a.studyId), recordId: known(a.recordId), versionId: known(a.versionId) }],
      action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null } as AccessEventV1) as AccessEvent;
    // The returned receipt is checked by A, not just an append returning normally.
    await provideAfterDurableEvent(parts.ledger, event, async () => undefined);
  }
  return authorize(body, { request, route: selector.route, recheck: async () => {
    await ctx.access.unchanged(c, policy);
    const caller = { ...c, roles: [...c.roles] };
    await ctx.access.prepare(caller);
    await ctx.db.$transaction(async tx => { if (!same(body, (await build({ ...ctx, tx, caller })).body)) mismatch(); }, { isolationLevel: 'RepeatableRead' });
  } });
}

export async function clinicalResponse(parts: ClinicalRuntimeParts, request: unknown, selector: ClinicalResponseSelector,
  ctx: ResponseContext): Promise<AuthorizedResponse> {
  const facts = await parts.context.facts(request), c = ctx.caller;
  if (facts.actor.identity.subject !== c.sub || facts.actor.institutionId !== c.institution ||
      !same([...facts.actor.roles].sort(), [...c.roles].sort())) refuse('NotFound');
  await currentMember(ctx);
  if (selector.view === 'sr') return srResponse(parts, request, selector, ctx);
  const policy = await ctx.access.snapshot(c, ctx.tx), loaded = await load(ctx, selector);
  await access(ctx, loaded);
  const served = loaded.filter(l => l.unit && l.sequences.length);

  const plans = served.map(l => planClinicalRead({ actor: facts.actor, unit: l.unit, scope: { sequences: l.sequences } }));
  // Validate every projection before appending any provide event. The DTO contains only verified version bodies.
  const body = dto(selector, loaded, c), targets = plans.flatMap(p => [...p.targets]);
  const events: AccessEvent[] = [];
  for (let i = 0; i < targets.length; i += 64) events.push(parseAccessEvent({ formatVersion: 1, surface: selector.route,
    eventId: `clinical-read:${randomUUID()}`, userId: known({ ...facts.actor.identity }), rolesAtTime: known([...facts.actor.roles]),
    actingInstitution: known(facts.actor.institutionId), managingInstitution: known(facts.actor.institutionId), occurredAt: new Date().toISOString(),
    trustedProxyIp: facts.trustedProxyIp, cause: 'user-view', context: { basis: 'worklist', studyId: loaded.length === 1 ? loaded[0].row.studyUid : null,
      relatedStudyId: null, reason: null }, executor: 'member', targets: targets.slice(i, i + 64), action: 'provide-prepared', result: 'prepared',
    requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null } as AccessEventV1) as AccessEvent);
  return provideClinicalReads(parts.ledger, selector.route, events, plans, async () => authorize(body, { request, route: selector.route,
    recheck: async () => {
      await ctx.access.unchanged(c, policy);
      const caller = { ...c, roles: [...c.roles] };
      await ctx.access.prepare(caller);
      await ctx.db.$transaction(async tx => {
        const current = { ...ctx, tx, caller };
        await currentMember(current);
        const latest = await load(current, selector);
        await access(current, latest);
        for (const l of latest.filter(v => v.unit && v.sequences.length)) planClinicalRead({ actor: facts.actor, unit: l.unit, scope: { sequences: l.sequences } });
        if (!same(body, dto(selector, latest, caller))) mismatch();
      }, { isolationLevel: 'RepeatableRead', maxWait: 4000, timeout: 8000 });
    } }));
}

/** Runs before Nest serializes any JSON, stream, binary, or SSR response. Raw response writes during the handler fail closed. */
@Injectable()
export class ClinicalResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp(), request = http.getRequest(), response = http.getResponse();
    const handler = context.getHandler();
    const path = [Reflect.getMetadata(PATH_METADATA, context.getClass()), Reflect.getMetadata(PATH_METADATA, handler)]
      .filter(p => typeof p === 'string').join('/').split('/').filter(Boolean).join('/');
    const route = `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]} ${path}` as ResponseRoute;
    if (!Object.prototype.hasOwnProperty.call(RESPONSE_ROUTES, route)) throw new ServiceUnavailableException('응답 경계를 확인하지 못했습니다');
    const originals = new Map<string, Function>();
    for (const method of ['write', 'end', 'send', 'json', 'render', 'writeHead', 'flushHeaders']) if (typeof response[method] === 'function') {
      originals.set(method, response[method]); response[method] = () => { throw new ServiceUnavailableException('검증되지 않은 응답은 제공하지 않았습니다'); };
    }
    const restore = () => { for (const [method, value] of originals) response[method] = value; };
    return defer(() => next.handle()).pipe(mergeMap(value => from((async () => {
      const binding = value && typeof value === 'object' ? authorized.get(value) : null;
      if (!binding || binding.request !== request || binding.route !== route) throw new ServiceUnavailableException('검증되지 않은 응답은 제공하지 않았습니다');
      await binding.recheck(); restore(); return value;
    })())), catchError(error => {
      restore();
      if (error instanceof ContractError) error = clinicalHttpError(error.code);
      const status = error instanceof HttpException ? error.getStatus() : 503;
      const raw = error instanceof HttpException ? error.getResponse() as any : null;
      const code = typeof raw?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(raw.code) ? raw.code : 'CLINICAL_RESPONSE_REFUSED';
      // Errors are operational envelopes. Arbitrary exception payloads (including stale projection snapshots) never serialize.
      return throwError(() => new HttpException({ code, message: status === 404 ? '기록을 찾을 수 없습니다' :
        status === 409 ? '기록이 변경되었습니다. 작성 내용을 보존하고 다시 확인하세요' : '요청 결과를 확인하지 못했습니다. 작성 내용은 그대로 남아 있습니다' }, status));
    }), finalize(restore));
  }
}
