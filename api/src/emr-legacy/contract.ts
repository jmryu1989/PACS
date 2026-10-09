import { createHash } from 'node:crypto';
import { ImmutableIdentity, PatientLinkSnapshot, identity, patientLink } from '../emr-contract/access-event';
import { RECORD_CLASSIFICATION, RecordEvent, RecordKind, classifyModel } from '../emr-contract/classification';
import { StatutoryClass, civilPeriodEnd, statutoryClasses, retentionFor as classifiedRetention } from '../emr-contract/lawful-defaults';
import { ContractError, choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';

/* EMR-G R1: move unsigned legacy records into the new record system without changing a fact.
 * 의료법 제22조②(원본 보존)·③(거짓 작성 금지), 전자서명법 제2조제2호(서명 = 서명자가 서명했다는 사실):
 * the original text, the author's display string and the stored time are kept byte for byte, the record is marked
 * Legacy Unsigned, and no signature, approval or reading that the source does not hold is ever created. The run itself is
 * a separate current-time system event. Pure contract: no storage, no signing; R2 binds the importer, B1 storage and C/D.
 */

export const LEGACY_FORMAT = 'emr-legacy/1';
/** A's own act names; lawful-defaults refuses both as a retention start (D591②), which the contract test re-checks. */
export const MIGRATION_ACT = 'migration' satisfies RecordEvent['act'];
export const SUPPLEMENT_ACT = 'resign' satisfies RecordEvent['act'];

export type LegacyModel = 'Report' | 'ReportVersion' | 'ReportDraft' | 'StudyConsultation' | 'ManualSr';
export interface LegacyObjectSource { objectKey: string; hashColumn: string; bytesColumn: string | null; locatorColumn: string | null }
export interface LegacySourceTable {
  /** Prisma primary key of the source row; the re-run key is derived from it, never supplied. */
  key: readonly string[];
  /** Rows sharing these values form one legacy record ('report': the Report head and its ReportVersion rows of one uid). */
  record: readonly string[];
  family: 'report' | 'own';
  /** Versions of one record are linked in this column's order. */
  chain: boolean;
  sequence: string | null;
  action: string | null;
  /** The stored time of the row, kept as read; never replaced by the migration time. */
  time: string;
  /** Human-readable names only; never resolved to a current issuer+sub. */
  authors: readonly string[];
  /** Clinical wording compared byte for byte (no trim, normalization or newline change). */
  text: readonly string[];
  presence: string | null;
  preserve: readonly string[];
  objects: readonly LegacyObjectSource[];
}

/** The 2fc7358 legacy model, read only (schema.prisma Report:330, ReportDraft:370, ReportVersion:398, ManualSr:542,
 * StudyConsultation:774). JSON columns are captured as their stored JSON text; NULL stays distinct from ''.
 */
export const LEGACY_SOURCES: Readonly<Record<LegacyModel, Readonly<LegacySourceTable>>> = freeze({
  Report: { key: ['uid'], record: ['uid'], family: 'report', chain: false, sequence: 'version', action: null, time: 'updatedAt',
    authors: ['updatedBy'], text: ['findings', 'conclusion', 'recommendation'], presence: null, preserve: [], objects: [] },
  ReportVersion: { key: ['id'], record: ['uid'], family: 'report', chain: true, sequence: 'version', action: 'action', time: 'at',
    authors: ['author'], text: ['findings', 'conclusion', 'recommendation', 'reason', 'citations', 'structured'], presence: null,
    preserve: [], objects: [] },
  ReportDraft: { key: ['uid', 'author'], record: ['uid', 'author'], family: 'own', chain: false, sequence: 'revision', action: null,
    time: 'updatedAt', authors: ['author'], text: ['findings', 'conclusion', 'recommendation', 'citations', 'structured'],
    presence: 'present', preserve: ['baseVersion'], objects: [] },
  StudyConsultation: { key: ['id'], record: ['id'], family: 'own', chain: false, sequence: 'revision', action: 'state', time: 'updatedAt',
    authors: ['requesterActor', 'recipientActor', 'recipientName', 'changedBy'], text: ['reason', 'reply', 'cancelReason'], presence: null,
    preserve: ['studyUid', 'institutionId', 'requesterSub', 'recipientSub', 'creationFingerprint', 'lastRequest', 'lastFingerprint', 'createdAt'],
    objects: [] },
  ManualSr: { key: ['id'], record: ['id'], family: 'own', chain: false, sequence: null, action: null, time: 'createdAt',
    authors: ['authorActor'], text: ['selection', 'dataset'], presence: null,
    preserve: ['studyUid', 'authorSub', 'requestId', 'fingerprint', 'sha256', 'storedAt', 'orthancId', 'attemptedAt', 'nextCheckAt'],
    objects: [{ objectKey: 'database-bytes', hashColumn: 'sha256', bytesColumn: 'dicom', locatorColumn: null },
      { objectKey: 'orthanc-instance', hashColumn: 'sha256', bytesColumn: null, locatorColumn: 'orthancId' }] },
});
const MODELS = Object.keys(LEGACY_SOURCES) as LegacyModel[];

/** A's classification decides the content kind; a source model must map to exactly one, or the contract does not load. */
export const LEGACY_KINDS: Readonly<Record<LegacyModel, RecordKind>> = freeze(Object.fromEntries(MODELS.map(model => {
  const kinds = classifyModel(model).filter(k => RECORD_CLASSIFICATION[k].retention.mode !== 'source-record');
  if (kinds.length !== 1) throw new Error(`Legacy model ${model} needs exactly one content kind`);
  return [model, kinds[0]];
})) as Record<LegacyModel, RecordKind>);

/** Who may add a current supplement signature. A private draft is not a statement; adopting it is a new entry through C. */
const SUPPLEMENT_ROLES: Readonly<Partial<Record<RecordKind, readonly string[]>>> = freeze({
  'report-head': ['radiologist'], 'report-version': ['radiologist'], 'manual-sr': ['radiologist'], consultation: ['radiologist', 'clinician'],
});

export interface TimeFact { value: string; basis: 'utc-verified' | 'unverified' }
export type LegacyFact<T> = { status: 'known'; value: T } | { status: 'unresolved'; reason: string };
export interface ObjectObservation { objectKey: string; present: boolean; sha256: string | null }
export interface LegacyRowInput {
  model: LegacyModel;
  columns: Readonly<Record<string, string | null>>;
  /** The exporter's verified writer/zone evidence for the stored time; anything less stays unverified. */
  timeBasis: TimeFact['basis'];
  institution: LegacyFact<string>;
  patient: LegacyFact<PatientLinkSnapshot>;
  objects: readonly ObjectObservation[];
}
export interface LegacySnapshotInput {
  format: typeof LEGACY_FORMAT;
  snapshotId: string;
  source: { databaseId: string; capturedAt: string };
  scope: { institutionId: string; models: readonly LegacyModel[]; rowCount: number };
  rows: readonly LegacyRowInput[];
}
export interface SealedLegacySnapshot extends LegacySnapshotInput { inputSha256: string }

const INSTITUTION_REASONS = ['not-determined'] as const;
const PATIENT_REASONS = ['no-matched-order', 'not-determined'] as const;

export type UnresolvedKind = 'original-time' | 'managing-institution' | 'patient-link' | 'source-object' | 'head-version-divergence' |
  'purpose-end' | 'draft-presence';
/** Records staff and system administrators confirm; never the reading doctor in the normal reading flow. */
export const FOLLOW_UP_OWNERS = freeze(['records-manager', 'system-administrator'] as const);
const FOLLOW_UP: Readonly<Record<UnresolvedKind, { owner: typeof FOLLOW_UP_OWNERS[number]; blocksAcceptance: boolean; action: string }>> = freeze({
  'original-time': { owner: 'records-manager', blocksAcceptance: false, action: '원 기록 시각의 시간대와 작성 경로를 원본 DB 설정·감사 기록으로 확인한다' },
  'managing-institution': { owner: 'records-manager', blocksAcceptance: true, action: '기록을 관리하는 기관을 원본 검사 정보로 확인한다' },
  'patient-link': { owner: 'records-manager', blocksAcceptance: true, action: '환자 연결을 원본 오더·영상 정보로 확인한다' },
  'source-object': { owner: 'system-administrator', blocksAcceptance: true, action: '원본 SR 객체의 존재와 해시를 저장소에서 확인한다' },
  'head-version-divergence': { owner: 'records-manager', blocksAcceptance: false, action: '현재 판독 내용과 확정판의 차이를 원본 이력으로 확인한다' },
  'purpose-end': { owner: 'records-manager', blocksAcceptance: false, action: '개인 초안의 목적 종료 사실을 확인한다' },
  'draft-presence': { owner: 'records-manager', blocksAcceptance: false, action: '비운 초안 표시와 남은 내용의 관계를 확인한다' },
});
export interface UnresolvedFact {
  itemKey: string; model: LegacyModel; sourceKey: string; fact: UnresolvedKind; reason: string; objectKey: string | null;
  blocksAcceptance: boolean; followUp: { owner: typeof FOLLOW_UP_OWNERS[number]; action: string };
}

/** Object keys in a fixed order so an exporter's or reader's key order never changes a hash; arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const canonicalJson = (value: unknown) => JSON.stringify(canonical(value));
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** Malformed input is refused under a code; it is never repaired, skipped or counted as empty. */
function shaped<T>(code: string, parse: () => T): T {
  try { return parse(); } catch (error) { if (error instanceof ContractError) throw error; return refuse(code); }
}
function captured(t: LegacySourceTable): readonly string[] {
  return [...new Set([...t.key, ...t.record, t.sequence, t.action, t.time, ...t.authors, ...t.text, t.presence, ...t.preserve]
    .filter((c): c is string => c !== null))];
}
function fact<T>(input: unknown, reasons: readonly string[], parse: (value: unknown) => T): LegacyFact<T> {
  const status = (input as any)?.status;
  if (status === 'known') return { status, value: parse(object(input, ['status', 'value']).value) };
  if (status === 'unresolved') return { status, reason: choice(object(input, ['status', 'reason']).reason, reasons) };
  throw new Error('Unknown fact status');
}

interface ParsedRow {
  itemKey: string; model: LegacyModel; sourceKey: string; recordClass: string; sequence: number | null;
  columns: Readonly<Record<string, string | null>>; time: TimeFact; institution: LegacyFact<string>; patient: LegacyFact<PatientLinkSnapshot>;
  objects: readonly ObjectObservation[]; rowSha256: string; contentSha256: string;
}
function rowHashes(model: LegacyModel, sourceKey: string, columns: Record<string, string | null>, time: TimeFact,
  institution: unknown, patient: unknown, objects: unknown) {
  const t = LEGACY_SOURCES[model];
  return {
    contentSha256: digest(['emr-legacy-content/1', model, t.text.map(c => [c, columns[c]])]),
    rowSha256: digest(['emr-legacy-row/1', model, sourceKey, captured(t).map(c => [c, columns[c]]), time.basis, institution, patient, objects]),
  };
}
function parseRow(input: unknown, databaseId: string): ParsedRow {
  const v = object(input, ['model', 'columns', 'timeBasis', 'institution', 'patient', 'objects']);
  const model = choice(v.model, MODELS), t = LEGACY_SOURCES[model], names = captured(t);
  const raw = object(v.columns, names), columns: Record<string, string | null> = {};
  for (const name of names) columns[name] = raw[name] === null ? null : string(raw[name], true);
  for (const name of [...t.key, ...t.record, t.time]) string(columns[name]);
  const sequence = t.sequence === null ? null : (() => {
    const s = string(columns[t.sequence]);
    if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error('Expected a decimal sequence');
    return integer(Number(s));
  })();
  if (t.presence !== null) choice(columns[t.presence], ['true', 'false']);
  const time: TimeFact = { value: columns[t.time], basis: choice(v.timeBasis, ['utc-verified', 'unverified']) };
  if (time.basis === 'utc-verified') {
    try { utc(time.value); } catch { refuse('LegacyTimeMalformed'); }
  }
  const institution = fact(v.institution, INSTITUTION_REASONS, value => string(value));
  const patient = fact(v.patient, PATIENT_REASONS, patientLink);
  if (!Array.isArray(v.objects) || v.objects.length !== t.objects.length) throw new Error('Object observations required');
  const objects = v.objects.map((o, i) => {
    const x = object(o, ['objectKey', 'present', 'sha256']);
    if (x.objectKey !== t.objects[i].objectKey || typeof x.present !== 'boolean') throw new Error('Object observation mismatch');
    if (x.present ? sha256(x.sha256) !== x.sha256 : x.sha256 !== null) throw new Error('Object hash mismatch');
    return { objectKey: x.objectKey as string, present: x.present as boolean, sha256: x.sha256 as string | null };
  });
  const sourceKey = JSON.stringify(t.key.map(c => columns[c]));
  const recordClass = JSON.stringify([t.family === 'report' ? 'report' : model, ...t.record.map(c => columns[c])]);
  return { model, sourceKey, recordClass, sequence, columns, time, institution, patient, objects,
    itemKey: `legacy:${digest(['emr-legacy-item/1', databaseId, model, sourceKey])}`,
    ...rowHashes(model, sourceKey, columns, time, institution, patient, objects) };
}
function order(a: ParsedRow, b: ParsedRow): number {
  return MODELS.indexOf(a.model) - MODELS.indexOf(b.model) || (a.recordClass < b.recordClass ? -1 : a.recordClass > b.recordClass ? 1 : 0) ||
    (a.sequence ?? -1) - (b.sequence ?? -1) || (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0);
}

export interface ParsedLegacySnapshot {
  snapshotId: string; databaseId: string; capturedAt: string; institutionId: string; models: readonly LegacyModel[];
  rowCount: number; inputSha256: string; rows: readonly ParsedRow[];
}
const parsedSnapshots = new WeakSet<object>();
function parseUnsealed(input: unknown, sealed: boolean) {
  const v = shaped('LegacySnapshotMalformed', () =>
    object(input, ['format', 'snapshotId', 'source', 'scope', 'rows', ...(sealed ? ['inputSha256'] : [])]));
  return shaped('LegacySnapshotMalformed', () => {
    if (v.format !== LEGACY_FORMAT) throw new Error('Unknown legacy format');
    const source = object(v.source, ['databaseId', 'capturedAt']), scope = object(v.scope, ['institutionId', 'models', 'rowCount']);
    const databaseId = string(source.databaseId), capturedAt = utc(source.capturedAt), institutionId = string(scope.institutionId);
    if (!Array.isArray(scope.models) || !scope.models.length || new Set(scope.models).size !== scope.models.length) throw new Error('Scope models required');
    const models = MODELS.filter(m => scope.models.includes(m));
    if (models.length !== scope.models.length) throw new Error('Unknown scope model');
    if (!Array.isArray(v.rows)) throw new Error('Rows required');
    const rows = v.rows.map(row => parseRow(row, databaseId)).sort(order);
    return { snapshotId: string(v.snapshotId), databaseId, capturedAt, institutionId, models, rowCount: integer(scope.rowCount), rows };
  });
}
function bindScope(s: ReturnType<typeof parseUnsealed>) {
  // A head without its versions cannot be compared, so the scope is refused rather than partially judged.
  if (s.models.includes('Report') && !s.models.includes('ReportVersion')) refuse('LegacyScopeIncomplete');
  if (s.rowCount !== s.rows.length) refuse('LegacyCountMismatch');
  for (const row of s.rows) {
    if (!s.models.includes(row.model) || (row.institution.status === 'known' && row.institution.value !== s.institutionId)) refuse('LegacyScopeMismatch');
  }
  const keys = s.rows.map(r => r.itemKey), chained = s.rows.filter(r => LEGACY_SOURCES[r.model].chain).map(r => r.recordClass + '\0' + r.sequence);
  if (new Set(keys).size !== keys.length || new Set(chained).size !== chained.length) refuse('LegacyRowDuplicate');
  return digest([LEGACY_FORMAT, s.snapshotId, s.databaseId, s.capturedAt, s.institutionId, s.models, s.rowCount, s.rows.map(r => r.rowSha256)]);
}
/** The exporter seals at capture time; the seal covers every row's bytes, the scope and the count. */
export function sealLegacySnapshot(input: unknown): Readonly<SealedLegacySnapshot> {
  const parsed = parseUnsealed(input, false), inputSha256 = bindScope(parsed);
  return freeze({ ...structuredClone(input as LegacySnapshotInput), inputSha256 });
}
export function parseLegacySnapshot(input: unknown): Readonly<ParsedLegacySnapshot> {
  const parsed = parseUnsealed(input, true), inputSha256 = bindScope(parsed);
  if ((input as SealedLegacySnapshot).inputSha256 !== inputSha256) refuse('LegacySnapshotHashMismatch');
  const result = freeze({ ...parsed, inputSha256 });
  parsedSnapshots.add(result);
  return result;
}

export interface PlanItem extends ParsedRow { kind: RecordKind; predecessorItemKey: string | null }
export interface MigrationPlan {
  format: typeof LEGACY_FORMAT; planSha256: string; snapshotId: string; inputSha256: string; databaseId: string; capturedAt: string;
  institutionId: string; items: readonly PlanItem[];
  excluded: readonly { itemKey: string; model: LegacyModel; sourceKey: string; reason: 'cleared-draft-boundary' }[];
  unresolved: readonly UnresolvedFact[];
  counts: { rows: number; migrate: number; excluded: number; unresolved: number; blocking: number };
}
const plans = new WeakSet<object>();
function verifiedPlan(plan: MigrationPlan): MigrationPlan {
  if (!plans.has(plan)) refuse('MigrationPlanRequired');
  return plan;
}
function unresolved(row: ParsedRow, kind: UnresolvedKind, reason: string, objectKey: string | null = null): UnresolvedFact {
  const f = FOLLOW_UP[kind];
  return { itemKey: row.itemKey, model: row.model, sourceKey: row.sourceKey, fact: kind, reason, objectKey,
    blocksAcceptance: f.blocksAcceptance, followUp: { owner: f.owner, action: f.action } };
}
const empty = (row: ParsedRow) => LEGACY_SOURCES[row.model].text.every(c => !row.columns[c]);

/** Dry-run input: the complete migration plan, every exclusion and every fact that needs a person's confirmation. */
export function planLegacyMigration(snapshot: ParsedLegacySnapshot): Readonly<MigrationPlan> {
  if (!parsedSnapshots.has(snapshot)) refuse('ParsedSnapshotRequired');
  const items: PlanItem[] = [], excluded: MigrationPlan['excluded'][number][] = [], facts: UnresolvedFact[] = [];
  const previous = new Map<string, string>(), versions = new Map(snapshot.rows.filter(r => r.model === 'ReportVersion')
    .map(r => [r.recordClass + '\0' + r.sequence, r]));
  for (const row of snapshot.rows) {
    const t = LEGACY_SOURCES[row.model], kind = LEGACY_KINDS[row.model];
    if (t.presence !== null && row.columns[t.presence] === 'false') {
      // A cleared draft row is a revision boundary, not a draft; it is listed, never silently dropped.
      if (empty(row)) { excluded.push({ itemKey: row.itemKey, model: row.model, sourceKey: row.sourceKey, reason: 'cleared-draft-boundary' }); continue; }
      facts.push(unresolved(row, 'draft-presence', 'content-on-cleared-draft'));
    }
    if (row.time.basis !== 'utc-verified') facts.push(unresolved(row, 'original-time', 'timezone-or-writer-unverified'));
    if (row.institution.status !== 'known') facts.push(unresolved(row, 'managing-institution', row.institution.reason));
    if (row.patient.status !== 'known') facts.push(unresolved(row, 'patient-link', row.patient.reason));
    t.objects.forEach((o, i) => {
      const observed = row.objects[i], declared = row.columns[o.hashColumn];
      const located = o.locatorColumn === null || row.columns[o.locatorColumn] !== null;
      const reason = declared === null || !/^[a-f0-9]{64}$/.test(declared) ? 'declared-hash-missing' :
        !located || !observed.present ? 'object-missing' : observed.sha256 !== declared ? 'object-hash-mismatch' : null;
      if (reason) facts.push(unresolved(row, 'source-object', reason, o.objectKey));
    });
    if (RECORD_CLASSIFICATION[kind].retention.mode !== 'statutory') facts.push(unresolved(row, 'purpose-end', 'no-recorded-purpose-end'));
    if (row.model === 'Report') {
      const version = versions.get(row.recordClass + '\0' + row.sequence);
      if (!version ? !empty(row) : t.text.some(c => version.columns[c] !== row.columns[c]))
        facts.push(unresolved(row, 'head-version-divergence', version ? 'text-differs' : 'no-matching-version'));
    }
    items.push({ ...row, kind, predecessorItemKey: t.chain ? previous.get(row.recordClass) ?? null : null });
    if (t.chain) previous.set(row.recordClass, row.itemKey);
  }
  const planSha256 = digest(['emr-legacy-plan/1', snapshot.inputSha256, items.map(i => [i.itemKey, i.rowSha256, i.predecessorItemKey]),
    excluded.map(e => [e.itemKey, e.reason])]);
  const result = freeze({ format: LEGACY_FORMAT, planSha256, snapshotId: snapshot.snapshotId, inputSha256: snapshot.inputSha256,
    databaseId: snapshot.databaseId, capturedAt: snapshot.capturedAt, institutionId: snapshot.institutionId, items, excluded, unresolved: facts,
    counts: { rows: snapshot.rowCount, migrate: items.length, excluded: excluded.length, unresolved: facts.length,
      blocking: facts.filter(f => f.blocksAcceptance).length } }) as MigrationPlan;
  if (result.counts.migrate + result.counts.excluded !== result.counts.rows) refuse('LegacyCountMismatch');
  plans.add(result);
  return result;
}

export type RetentionHandoff =
  { status: 'original-start'; startedAt: string; classes: readonly StatutoryClass[]; years: number; ownDeadline: string } |
  { status: 'unresolved'; fact: 'original-time' | 'purpose-end'; destroyable: false };
/** H receives the verified original start or an unresolved fact; never the migration date, never a permanent value. */
function retentionFor(item: PlanItem): RetentionHandoff {
  if (RECORD_CLASSIFICATION[item.kind].retention.mode !== 'statutory') return { status: 'unresolved', fact: 'purpose-end', destroyable: false };
  if (item.time.basis !== 'utc-verified') return { status: 'unresolved', fact: 'original-time', destroyable: false };
  // D-19/D-21 belong to A: G neither invents chart incorporation nor owns a period/calendar table.
  // R2 must bind the corrected A and recorded original-start/incorporation evidence before H consumes this handoff.
  const classes = statutoryClasses([item.kind]), years = classifiedRetention([item.kind]).retentionYears;
  return { status: 'original-start', startedAt: item.time.value, classes, years, ownDeadline: civilPeriodEnd(item.time.value, years) };
}
export interface LegacyLifecycle {
  amendWindow: { status: 'not-granted'; reason: 'no-verified-original-signer' | 'original-time-unresolved' };
  finalization: 'not-asserted';
  legacyAction: string | null;
}
/** A legacy approval has no verified signer, so no 24-hour amendment and no Finalized expiry is derived from it. */
function lifecycleFor(item: PlanItem): LegacyLifecycle {
  const action = LEGACY_SOURCES[item.model].action;
  return { amendWindow: { status: 'not-granted', reason: item.time.basis === 'utc-verified' ? 'no-verified-original-signer' : 'original-time-unresolved' },
    finalization: 'not-asserted', legacyAction: action === null ? null : item.columns[action] };
}
export interface LegacyMarking {
  status: 'legacy-unsigned'; label: 'Legacy Unsigned'; originalSignature: 'absent';
  provenance: { kind: 'legacy-migration'; snapshotId: string; inputSha256: string; databaseId: string; model: LegacyModel; sourceKey: string; rowSha256: string };
  author: { kind: 'legacy-display'; columns: readonly string[]; identity: { status: 'unresolved'; reason: 'legacy-display-only' } };
}
function markingFor(plan: MigrationPlan, item: PlanItem): LegacyMarking {
  return { status: 'legacy-unsigned', label: 'Legacy Unsigned', originalSignature: 'absent',
    provenance: { kind: 'legacy-migration', snapshotId: plan.snapshotId, inputSha256: plan.inputSha256, databaseId: plan.databaseId,
      model: item.model, sourceKey: item.sourceKey, rowSha256: item.rowSha256 },
    author: { kind: 'legacy-display', columns: LEGACY_SOURCES[item.model].authors, identity: { status: 'unresolved', reason: 'legacy-display-only' } } };
}
export interface MigrationEvent { act: typeof MIGRATION_ACT; at: string; runId: string; unitId: string; actorId: string; signature: null }
export interface SupplementSummary { act: typeof SUPPLEMENT_ACT; at: string; signer: ImmutableIdentity; contentSha256: string }
export interface LegacyRecordWrite {
  format: typeof LEGACY_FORMAT; itemKey: string; model: LegacyModel; sourceKey: string; recordClass: string; sequence: number | null;
  predecessorItemKey: string | null; kind: RecordKind; rowSha256: string; contentSha256: string;
  original: { columns: Readonly<Record<string, string | null>>; time: TimeFact };
  institution: LegacyFact<string>; patient: LegacyFact<PatientLinkSnapshot>; objects: readonly ObjectObservation[];
  marking: LegacyMarking; retention: RetentionHandoff; lifecycle: LegacyLifecycle;
  events: readonly MigrationEvent[]; supplements: readonly SupplementSummary[];
}
function legacyWrite(plan: MigrationPlan, item: PlanItem, ctx: { runId: string; unitId: string; at: string; actorId: string }): LegacyRecordWrite {
  return { format: LEGACY_FORMAT, itemKey: item.itemKey, model: item.model, sourceKey: item.sourceKey, recordClass: item.recordClass,
    sequence: item.sequence, predecessorItemKey: item.predecessorItemKey, kind: item.kind, rowSha256: item.rowSha256, contentSha256: item.contentSha256,
    original: { columns: item.columns, time: item.time }, institution: item.institution, patient: item.patient, objects: item.objects,
    marking: markingFor(plan, item), retention: retentionFor(item), lifecycle: lifecycleFor(item),
    // The run is its own current-time system event; nothing is dated into the source's past.
    events: [{ act: MIGRATION_ACT, at: ctx.at, runId: ctx.runId, unitId: ctx.unitId, actorId: ctx.actorId, signature: null }],
    supplements: [] };
}

/** Complete re-read of migrated items and committed checkpoints. A failed or partial read is not an empty store. */
export interface StoredFacts {
  complete: true;
  items: readonly { itemKey: string; rowSha256: string; runId: string; unitId: string }[];
  checkpoints: readonly { runId: string; unitId: string; through: number }[];
}
function storedFacts(input: unknown): StoredFacts {
  const v = shaped('StoredFactsIncomplete', () => object(input, ['complete', 'items', 'checkpoints']));
  if (v.complete !== true || !Array.isArray(v.items) || !Array.isArray(v.checkpoints)) refuse('StoredFactsIncomplete');
  const items = shaped('StoredFactsIncomplete', () => v.items.map(i => {
    const x = object(i, ['itemKey', 'rowSha256', 'runId', 'unitId']);
    return { itemKey: string(x.itemKey), rowSha256: sha256(x.rowSha256), runId: string(x.runId), unitId: string(x.unitId) };
  }));
  const checkpoints = shaped('StoredFactsIncomplete', () => v.checkpoints.map(c => {
    const x = object(c, ['runId', 'unitId', 'through']);
    return { runId: string(x.runId), unitId: string(x.unitId), through: integer(x.through, 1) };
  }));
  // Two stored copies of one source row are exactly the duplicate this contract exists to prevent.
  if (new Set(items.map(i => i.itemKey)).size !== items.length) refuse('JournalStoreDiverged');
  if (new Set(checkpoints.map(c => canonicalJson([c.runId, c.unitId]))).size !== checkpoints.length ||
      new Set(checkpoints.map(c => canonicalJson([c.runId, c.through]))).size !== checkpoints.length) refuse('JournalStoreDiverged');
  return { complete: true, items, checkpoints };
}

export interface DryRunReceipt {
  format: typeof LEGACY_FORMAT; planSha256: string; inputSha256: string; checkedAt: string; itemCount: number;
  preexisting: readonly string[]; conflicts: readonly { itemKey: string; plannedRowSha256: string; storedRowSha256: string }[];
  excluded: number; unresolved: number; blocking: number; ok: boolean;
}
/** Same row and bytes already migrated: acknowledged, never written again. Same row, other bytes: a conflict to show. */
export function dryRunLegacyMigration(plan: MigrationPlan, stored: unknown, checkedAt: string): Readonly<DryRunReceipt> {
  const p = verifiedPlan(plan), s = storedFacts(stored), planned = new Map(p.items.map(i => [i.itemKey, i]));
  const preexisting: string[] = [], conflicts: DryRunReceipt['conflicts'][number][] = [];
  for (const row of s.items) {
    const item = planned.get(row.itemKey);
    if (!item) continue; // a row outside this plan's scope is not this run's to judge
    if (item.rowSha256 === row.rowSha256) preexisting.push(row.itemKey);
    else conflicts.push({ itemKey: row.itemKey, plannedRowSha256: item.rowSha256, storedRowSha256: row.rowSha256 });
  }
  return freeze({ format: LEGACY_FORMAT, planSha256: p.planSha256, inputSha256: p.inputSha256, checkedAt: utc(checkedAt), itemCount: p.items.length,
    preexisting: preexisting.sort(), conflicts: conflicts.sort((a, b) => (a.itemKey < b.itemKey ? -1 : 1)),
    excluded: p.counts.excluded, unresolved: p.counts.unresolved, blocking: p.counts.blocking, ok: conflicts.length === 0 });
}

export type RunState = 'applying' | 'stopping' | 'stopped' | 'commit-unknown' | 'completed';
export interface MigrationJournal {
  format: typeof LEGACY_FORMAT; runId: string; planSha256: string; inputSha256: string; snapshotId: string; actorId: string; startedAt: string;
  state: RunState; checkpoint: { through: number; lastItemKey: string | null; unitId: string | null };
  pending: { unitId: string; from: number; through: number } | null;
  preexisting: readonly string[]; stopRequestedAt: string | null;
  history: readonly { kind: 'run-started' | 'stop-requested' | 'run-stopped' | 'commit-unknown' | 'commit-resolved' | 'run-resumed' | 'run-completed'; at: string }[];
}
export interface CommitUnit {
  unitId: string; runId: string; planSha256: string; from: number; through: number; at: string;
  writes: readonly LegacyRecordWrite[]; acknowledged: readonly { itemKey: string; rowSha256: string }[];
  /** Committed in the same transaction as the writes; there is no state in which the checkpoint is ahead of its bodies. */
  checkpoint: { runId: string; unitId: string; through: number; lastItemKey: string };
}
function parseJournal(input: MigrationJournal): MigrationJournal {
  return shaped('MigrationJournalMalformed', () => {
    const v = object(input, ['format', 'runId', 'planSha256', 'inputSha256', 'snapshotId', 'actorId', 'startedAt', 'state', 'checkpoint',
      'pending', 'preexisting', 'stopRequestedAt', 'history']);
    if (v.format !== LEGACY_FORMAT) throw new Error('Unknown journal format');
    string(v.runId); sha256(v.planSha256); sha256(v.inputSha256); string(v.snapshotId); string(v.actorId); utc(v.startedAt);
    choice(v.state, ['applying', 'stopping', 'stopped', 'commit-unknown', 'completed']);
    const c = object(v.checkpoint, ['through', 'lastItemKey', 'unitId']); integer(c.through);
    if (c.through === 0 ? c.lastItemKey !== null || c.unitId !== null : !string(c.lastItemKey) || !string(c.unitId))
      throw new Error('Checkpoint identity required');
    if (v.pending !== null) {
      const p = object(v.pending, ['unitId', 'from', 'through']); string(p.unitId); integer(p.from); integer(p.through, 1);
      if (p.from !== c.through || p.through <= p.from) throw new Error('Pending range mismatch');
    }
    if (!Array.isArray(v.preexisting) || !Array.isArray(v.history)) throw new Error('Journal lists required');
    v.preexisting.forEach(x => string(x));
    if (new Set(v.preexisting).size !== v.preexisting.length) throw new Error('Duplicate acknowledgment');
    for (const entry of v.history) {
      const h = object(entry, ['kind', 'at']); utc(h.at);
      choice(h.kind, ['run-started', 'stop-requested', 'run-stopped', 'commit-unknown', 'commit-resolved', 'run-resumed', 'run-completed']);
    }
    if (v.stopRequestedAt !== null) utc(v.stopRequestedAt);
    if ((v.state === 'commit-unknown' && v.pending === null) ||
        (['stopped', 'completed'].includes(v.state) && v.pending !== null) ||
        (['stopping', 'stopped'].includes(v.state) && v.stopRequestedAt === null)) throw new Error('Journal state mismatch');
    return v as MigrationJournal;
  });
}
function bindJournal(journal: MigrationJournal, plan: MigrationPlan): MigrationJournal {
  const j = parseJournal(journal), p = verifiedPlan(plan);
  if (j.snapshotId === p.snapshotId && j.inputSha256 !== p.inputSha256) refuse('SourceSnapshotChanged');
  if (j.planSha256 !== p.planSha256 || j.inputSha256 !== p.inputSha256 || j.snapshotId !== p.snapshotId) refuse('PlanMismatch');
  if (j.startedAt < p.capturedAt || j.checkpoint.through > p.items.length ||
      (j.checkpoint.through && j.checkpoint.lastItemKey !== p.items[j.checkpoint.through - 1].itemKey) ||
      j.preexisting.some(key => !p.items.some(i => i.itemKey === key)) ||
      (j.state === 'completed' && j.checkpoint.through !== p.items.length) ||
      (j.pending && (j.pending.through > p.items.length || j.pending.unitId !== unitIdentity(j.runId, p, j.pending.from, j.pending.through))))
    refuse('MigrationJournalMalformed');
  return j;
}
const unitIdentity = (runId: string, plan: MigrationPlan, from: number, through: number) =>
  `unit:${digest([runId, plan.planSha256, from, through])}`;
const next = (j: MigrationJournal, change: Partial<MigrationJournal>, event?: MigrationJournal['history'][number]): Readonly<MigrationJournal> =>
  freeze({ ...structuredClone(j), ...change, history: event ? [...j.history, event] : [...j.history] });

/** Apply only after a clean dry-run of this exact plan that still matches storage. */
export function startLegacyRun(plan: MigrationPlan, receipt: DryRunReceipt, stored: unknown,
  command: { runId: string; at: string; actorId: string }): Readonly<MigrationJournal> {
  const p = verifiedPlan(plan), c = object(command, ['runId', 'at', 'actorId']);
  const runId = string(c.runId), at = utc(c.at), actorId = string(c.actorId);
  if (at < p.capturedAt) refuse('ServerTimeRefused');
  if (receipt?.planSha256 !== p.planSha256 || receipt.inputSha256 !== p.inputSha256) refuse('DryRunMismatch');
  const fresh = dryRunLegacyMigration(p, stored, at);
  if (fresh.conflicts.length) refuse('LegacyItemConflict');
  if (!receipt.ok || !same(fresh.preexisting, receipt.preexisting) || !same(fresh.conflicts, receipt.conflicts)) refuse('DryRunStale');
  const s = storedFacts(stored);
  if (s.items.some(i => i.runId === runId) || s.checkpoints.some(k => k.runId === runId)) refuse('RunIdReused');
  return freeze({ format: LEGACY_FORMAT, runId, planSha256: p.planSha256, inputSha256: p.inputSha256, snapshotId: p.snapshotId, actorId,
    startedAt: at, state: 'applying' as RunState, checkpoint: { through: 0, lastItemKey: null, unitId: null }, pending: null,
    preexisting: [...fresh.preexisting], stopRequestedAt: null, history: [{ kind: 'run-started' as const, at }] });
}

/** One atomic unit at a time. After a stop request no new unit starts; an empty result ends the run as stopped or completed. */
export function nextLegacyUnit(journal: MigrationJournal, plan: MigrationPlan, command: { at: string; size: number }):
  { journal: Readonly<MigrationJournal>; unit: Readonly<CommitUnit> | null } {
  const j = bindJournal(journal, plan), p = verifiedPlan(plan), at = utc(command?.at), size = integer(command?.size, 1);
  if (j.state === 'commit-unknown') refuse('CommitOutcomeUnknown');
  if (j.pending) refuse('UnitPending');
  if (j.state === 'stopped' || j.state === 'completed') refuse('RunNotActive');
  if (at < j.startedAt) refuse('ServerTimeRefused');
  const from = j.checkpoint.through;
  if (from >= p.items.length) return { journal: next(j, { state: 'completed' }, { kind: 'run-completed', at }), unit: null };
  if (j.state === 'stopping') return { journal: next(j, { state: 'stopped' }, { kind: 'run-stopped', at }), unit: null };
  const through = Math.min(p.items.length, from + size);
  const unitId = unitIdentity(j.runId, p, from, through), pre = new Set(j.preexisting);
  const range = p.items.slice(from, through);
  const unit = freeze({ unitId, runId: j.runId, planSha256: p.planSha256, from, through, at,
    writes: range.filter(i => !pre.has(i.itemKey)).map(i => legacyWrite(p, i, { runId: j.runId, unitId, at, actorId: j.actorId })),
    acknowledged: range.filter(i => pre.has(i.itemKey)).map(i => ({ itemKey: i.itemKey, rowSha256: i.rowSha256 })),
    checkpoint: { runId: j.runId, unitId, through, lastItemKey: p.items[through - 1].itemKey } });
  return { journal: next(j, { pending: { unitId, from, through } }), unit };
}

/** 'unknown' is not guessed either way; only a re-read by the unit's own ID resolves it. */
export function recordLegacyCommit(journal: MigrationJournal, plan: MigrationPlan, unit: CommitUnit,
  outcome: 'committed' | 'rolled-back' | 'unknown', at: string): Readonly<MigrationJournal> {
  const j = bindJournal(journal, plan), p = verifiedPlan(plan);
  choice(outcome, ['committed', 'rolled-back', 'unknown']); utc(at);
  if (j.state === 'commit-unknown') refuse('CommitOutcomeUnknown');
  if (!j.pending || unit?.unitId !== j.pending.unitId || unit.checkpoint?.through !== j.pending.through) refuse('UnitMismatch');
  const { from, through: end } = j.pending, pre = new Set(j.preexisting), range = p.items.slice(from, end);
  shaped('UnitMismatch', () => {
    utc(unit.at);
    if (unit.at < j.startedAt || at < unit.at || !same(unit, {
      unitId: j.pending.unitId, runId: j.runId, planSha256: p.planSha256, from, through: end, at: unit.at,
      writes: range.filter(i => !pre.has(i.itemKey)).map(i => legacyWrite(p, i, { runId: j.runId, unitId: j.pending.unitId, at: unit.at, actorId: j.actorId })),
      acknowledged: range.filter(i => pre.has(i.itemKey)).map(i => ({ itemKey: i.itemKey, rowSha256: i.rowSha256 })),
      checkpoint: { runId: j.runId, unitId: j.pending.unitId, through: end, lastItemKey: p.items[end - 1].itemKey },
    })) refuse('UnitMismatch');
  });
  if (outcome === 'unknown') return next(j, { state: 'commit-unknown' }, { kind: 'commit-unknown', at });
  if (outcome === 'rolled-back') return next(j, { pending: null });
  const { unitId, through } = j.pending;
  return next(j, { pending: null, checkpoint: { through, lastItemKey: p.items[through - 1].itemKey, unitId } });
}

/** Storage is the truth: every item below the stored checkpoint must be stored, nothing of this run beyond it. */
function progress(j: MigrationJournal, p: MigrationPlan, s: StoredFacts): MigrationJournal['checkpoint'] {
  const planned = new Map(p.items.map(i => [i.itemKey, i])), byKey = new Map(s.items.map(i => [i.itemKey, i]));
  for (const row of s.items) {
    const item = planned.get(row.itemKey);
    if (item && item.rowSha256 !== row.rowSha256) refuse('LegacyItemConflict');
  }
  const mine = s.checkpoints.filter(c => c.runId === j.runId).sort((a, b) => a.through - b.through);
  const through = Math.max(0, ...mine.map(c => c.through));
  if (j.checkpoint.through > through) refuse('CheckpointAheadOfBody');
  if (through !== j.checkpoint.through && through !== j.pending?.through) refuse('JournalStoreDiverged');
  if (through > p.items.length) refuse('JournalStoreDiverged');
  for (let n = 0; n < through; n++) if (!byKey.has(p.items[n].itemKey)) refuse('CheckpointAheadOfBody');
  // A matching row count is not proof of this transaction: bind every durable range and body to its own unit ID.
  const pre = new Set(j.preexisting);
  let from = 0;
  for (const checkpoint of mine) {
    if (checkpoint.unitId !== unitIdentity(j.runId, p, from, checkpoint.through)) refuse('JournalStoreDiverged');
    const rangeKeys = new Set(p.items.slice(from, checkpoint.through).map(i => i.itemKey));
    for (const body of s.items.filter(i => rangeKeys.has(i.itemKey))) {
      if (pre.has(body.itemKey) ? body.runId === j.runId : body.runId !== j.runId || body.unitId !== checkpoint.unitId)
        refuse('JournalStoreDiverged');
    }
    from = checkpoint.through;
  }
  if (j.checkpoint.through && !mine.some(c => c.through === j.checkpoint.through && c.unitId === j.checkpoint.unitId))
    refuse('JournalStoreDiverged');
  if (through > j.checkpoint.through && !mine.some(c => c.unitId === j.pending?.unitId && c.through === j.pending?.through))
    refuse('JournalStoreDiverged');
  if (j.preexisting.some(key => !byKey.has(key))) refuse('JournalStoreDiverged');
  // Beyond the checkpoint only rows acknowledged at start may exist: a body of this run without its checkpoint, or a row
  // another writer migrated meanwhile, would otherwise be written twice.
  if (p.items.slice(through).some(i => byKey.has(i.itemKey) && (byKey.get(i.itemKey).runId === j.runId || !pre.has(i.itemKey))))
    refuse('JournalStoreDiverged');
  const last = mine.find(c => c.through === through);
  return { through, lastItemKey: through ? p.items[through - 1].itemKey : null, unitId: last ? last.unitId : null };
}
export function resolveLegacyCommit(journal: MigrationJournal, plan: MigrationPlan, stored: unknown, at: string): Readonly<MigrationJournal> {
  const j = bindJournal(journal, plan);
  if (j.state !== 'commit-unknown') refuse('CommitOutcomeKnown');
  const checkpoint = progress(j, verifiedPlan(plan), storedFacts(stored));
  return next(j, { state: j.stopRequestedAt ? 'stopping' : 'applying', pending: null, checkpoint }, { kind: 'commit-resolved', at: utc(at) });
}
/** Stop lets the unit in flight finish; it never interrupts a transaction and leaves the journal as restart data. */
export function requestLegacyStop(journal: MigrationJournal, plan: MigrationPlan, at: string): Readonly<MigrationJournal> {
  const j = bindJournal(journal, plan);
  if (j.state === 'stopping') return freeze(structuredClone(j));
  if (!['applying', 'commit-unknown'].includes(j.state)) refuse('RunNotActive');
  return next(j, { state: j.state === 'commit-unknown' ? j.state : 'stopping', stopRequestedAt: utc(at) }, { kind: 'stop-requested', at });
}
/** Restart after a stop or a crash with the same plan: re-derives progress from storage before any new write. */
export function resumeLegacyRun(journal: MigrationJournal, plan: MigrationPlan, stored: unknown, at: string): Readonly<MigrationJournal> {
  const j = bindJournal(journal, plan);
  if (j.state === 'completed') refuse('RunAlreadyCompleted');
  const checkpoint = progress(j, verifiedPlan(plan), storedFacts(stored));
  return next(j, { state: 'applying', pending: null, stopRequestedAt: null, checkpoint }, { kind: 'run-resumed', at: utc(at) });
}

export interface LegacyRecordReadBack extends LegacyRecordWrite {
  target: { recordId: string; versionId: string; sha256: string };
  targetPredecessor: { recordId: string; versionId: string } | null;
}
export type Mismatch = 'missing' | 'duplicate' | 'unexpected' | 'model' | 'columns' | 'content' | 'time' | 'institution' | 'patient' | 'object' |
  'marking' | 'retention' | 'lifecycle' | 'events' | 'supplements' | 'record-mapping' | 'version-chain';
export interface Reconciliation {
  status: 'failed' | 'matched-with-unresolved' | 'matched';
  planSha256: string; inputSha256: string;
  counts: { rows: number; planned: number; excluded: number; readBack: number; matched: number };
  rows: readonly { itemKey: string; result: 'matched' | 'mismatch' | 'unexpected'; mismatches: readonly Mismatch[] }[];
  unresolved: readonly UnresolvedFact[];
  records: readonly LegacyRecordReadBack[];
}
const reconciliations = new WeakSet<object>();
function readBack(input: unknown): LegacyRecordReadBack[] {
  const v = shaped('ReadBackIncomplete', () => object(input, ['complete', 'records']));
  if (v.complete !== true || !Array.isArray(v.records)) refuse('ReadBackIncomplete');
  return shaped('ReadBackMalformed', () => v.records.map(r => {
    const x = object(r, ['format', 'itemKey', 'model', 'sourceKey', 'recordClass', 'sequence', 'predecessorItemKey', 'kind', 'rowSha256',
      'contentSha256', 'original', 'institution', 'patient', 'objects', 'marking', 'retention', 'lifecycle', 'events', 'supplements', 'target', 'targetPredecessor']);
    const t = object(x.target, ['recordId', 'versionId', 'sha256']); string(t.recordId); string(t.versionId); sha256(t.sha256);
    if (x.targetPredecessor !== null) { const q = object(x.targetPredecessor, ['recordId', 'versionId']); string(q.recordId); string(q.versionId); }
    object(x.original, ['columns', 'time']); object(x.original.time, ['value', 'basis']);
    if (!Array.isArray(x.events) || !Array.isArray(x.supplements) || !Array.isArray(x.objects)) throw new Error('Read-back lists required');
    string(x.itemKey);
    return structuredClone(x) as LegacyRecordReadBack;
  }));
}
function eventsOk(record: LegacyRecordReadBack, plan: MigrationPlan): boolean {
  // Exactly the one current-time migration event: no signature, approval or reading dated into the legacy past.
  return record.events.length === 1 && record.events.every(e => {
    try {
      object(e, ['act', 'at', 'runId', 'unitId', 'actorId', 'signature']);
      return e.act === MIGRATION_ACT && e.signature === null && utc(e.at) >= plan.capturedAt && !!string(e.runId) && !!string(e.unitId) && !!string(e.actorId);
    } catch { return false; }
  });
}
function supplementsOk(record: LegacyRecordReadBack): boolean {
  const migratedAt = record.events[0]?.at;
  return record.supplements.every(s => {
    try {
      object(s, ['act', 'at', 'signer', 'contentSha256']); identity(s.signer);
      return s.act === SUPPLEMENT_ACT && typeof migratedAt === 'string' && utc(s.at) >= migratedAt && s.contentSha256 === record.contentSha256;
    } catch { return false; }
  });
}

/** Row by row, then AND. Equal totals never pass when any row's text, author, time, patient, version or object moved. */
export function reconcileLegacyMigration(plan: MigrationPlan, stored: unknown): Readonly<Reconciliation> {
  const p = verifiedPlan(plan), records = readBack(stored);
  const byKey = new Map<string, LegacyRecordReadBack[]>();
  for (const r of records) byKey.set(r.itemKey, [...(byKey.get(r.itemKey) ?? []), r]);
  const rows: { itemKey: string; result: 'matched' | 'mismatch' | 'unexpected'; mismatches: Mismatch[] }[] = [];
  const classToRecord = new Map<string, string>(), recordToClass = new Map<string, string>(), versions = new Set<string>();
  const matchedTargets = new Map<string, LegacyRecordReadBack>();
  for (const item of p.items) {
    const found = byKey.get(item.itemKey) ?? [], m: Mismatch[] = [];
    if (found.length !== 1) { rows.push({ itemKey: item.itemKey, result: 'mismatch', mismatches: [found.length ? 'duplicate' : 'missing'] }); continue; }
    const r = found[0], columns = r.original.columns as Record<string, string | null>;
    if (r.format !== LEGACY_FORMAT || r.model !== item.model || r.sourceKey !== item.sourceKey || r.recordClass !== item.recordClass ||
        r.sequence !== item.sequence || r.kind !== item.kind || r.predecessorItemKey !== item.predecessorItemKey) m.push('model');
    if (!same(Object.keys(columns ?? {}).sort(), Object.keys(item.columns).sort()) ||
        Object.keys(item.columns).some(c => columns[c] !== item.columns[c])) m.push('columns');
    if (!same(r.original.time, item.time)) m.push('time');
    if (!same(r.institution, item.institution)) m.push('institution');
    if (!same(r.patient, item.patient)) m.push('patient');
    if (!same(r.objects, item.objects)) m.push('object');
    // The stored bytes are re-hashed here; a hash the read-back merely claims is not evidence.
    let hashes: { rowSha256: string; contentSha256: string } | null = null;
    try { hashes = rowHashes(item.model, item.sourceKey, columns, r.original.time, r.institution, r.patient, r.objects); } catch { hashes = null; }
    const claimed = r.rowSha256 === item.rowSha256 && r.contentSha256 === item.contentSha256;
    const recomputed = hashes !== null && hashes.rowSha256 === item.rowSha256 && hashes.contentSha256 === item.contentSha256;
    if (!claimed || (!recomputed && !m.length)) m.push('content');
    if (!same(r.marking, markingFor(p, item))) m.push('marking');
    if (!same(r.retention, retentionFor(item))) m.push('retention');
    if (!same(r.lifecycle, lifecycleFor(item))) m.push('lifecycle');
    if (!eventsOk(r, p)) m.push('events');
    if (!supplementsOk(r)) m.push('supplements');
    // One legacy record maps to one new record, distinct records stay distinct, every version keeps its own identity.
    const mapped = classToRecord.get(item.recordClass), owner = recordToClass.get(r.target.recordId), version = r.target.recordId + '\0' + r.target.versionId;
    if ((mapped !== undefined && mapped !== r.target.recordId) || (owner !== undefined && owner !== item.recordClass) || versions.has(version)) m.push('record-mapping');
    classToRecord.set(item.recordClass, r.target.recordId); recordToClass.set(r.target.recordId, item.recordClass); versions.add(version);
    const predecessor = item.predecessorItemKey === null ? null : matchedTargets.get(item.predecessorItemKey);
    const expected = predecessor ? { recordId: predecessor.target.recordId, versionId: predecessor.target.versionId } : null;
    if ((item.predecessorItemKey !== null && !predecessor) || !same(r.targetPredecessor, expected)) m.push('version-chain');
    matchedTargets.set(item.itemKey, r);
    rows.push({ itemKey: item.itemKey, result: m.length ? 'mismatch' : 'matched', mismatches: m });
  }
  const planned = new Set(p.items.map(i => i.itemKey));
  for (const r of records) if (!planned.has(r.itemKey)) rows.push({ itemKey: r.itemKey, result: 'unexpected', mismatches: ['unexpected'] });
  const matched = rows.filter(r => r.result === 'matched').length;
  const failed = rows.some(r => r.result !== 'matched') || matched !== p.items.length || records.length !== p.items.length;
  const result = freeze({ status: failed ? 'failed' : p.unresolved.length ? 'matched-with-unresolved' : 'matched',
    planSha256: p.planSha256, inputSha256: p.inputSha256,
    counts: { rows: p.counts.rows, planned: p.items.length, excluded: p.counts.excluded, readBack: records.length, matched },
    rows, unresolved: p.unresolved, records }) as Reconciliation;
  reconciliations.add(result);
  return result;
}
function verifiedReconciliation(input: Reconciliation): Reconciliation {
  if (!reconciliations.has(input)) refuse('ReconciliationRequired');
  if (input.status === 'failed') refuse('ReconciliationFailed');
  return input;
}

/** C/D's re-read surfaces must show every current and past version with its original facts, marking and provenance.
 * Reading needs no supplement signature or extra confirmation (no new step in the doctor's flow).
 */
export function acceptLegacyReopen(reconciliation: Reconciliation, reopened: unknown):
  Readonly<{ accepted: true; records: number; versions: number; supplementsRequired: 0 }> {
  const r = verifiedReconciliation(reconciliation);
  if (r.unresolved.some(f => f.blocksAcceptance)) refuse('ReopenBlockedByUnresolved');
  const v = shaped('ReopenViewIncomplete', () => object(reopened, ['complete', 'views']));
  if (v.complete !== true || !Array.isArray(v.views)) refuse('ReopenViewIncomplete');
  const views = shaped('ReopenViewMalformed', () => v.views.map(x => object(x, ['itemKey', 'recordId', 'versionId', 'patient', 'columns', 'time', 'marking', 'objects'])));
  const byKey = new Map<string, Record<string, any>>(views.map(x => [x.itemKey, x]));
  if (views.length !== r.records.length || byKey.size !== views.length) refuse('ReopenViewMismatch');
  for (const record of r.records) {
    const view = byKey.get(record.itemKey);
    if (!view || record.patient.status !== 'known' || view.recordId !== record.target.recordId || view.versionId !== record.target.versionId ||
        !same(view.patient, record.patient.value) || !same(view.columns, record.original.columns) || !same(view.time, record.original.time) ||
        !same(view.marking, record.marking) || !same(view.objects, record.objects)) refuse('ReopenViewMismatch');
  }
  return freeze({ accepted: true as const, records: new Set(r.records.map(x => x.target.recordId)).size, versions: r.records.length, supplementsRequired: 0 as const });
}

export interface SupplementSigner { identity: ImmutableIdentity; display: string; kind: 'member' | 'service'; roles: readonly string[]; canSign: boolean; canReadStudy: boolean }
export interface SupplementPlan {
  act: typeof SUPPLEMENT_ACT; itemKey: string; target: LegacyRecordReadBack['target']; at: string;
  signer: ImmutableIdentity; signerDisplay: string;
  attests: { contentSha256: string; rowSha256: string; snapshotId: string; inputSha256: string };
  originalAuthor: { kind: 'legacy-display'; values: readonly (string | null)[]; identity: { status: 'unresolved'; reason: 'legacy-display-only' } };
  marking: LegacyMarking;
  retention: 'no-new-start';
  amendWindow: { status: 'not-granted'; reason: 'supplement-is-not-approval' };
  route: 'emr-c-supplement-sign';
  summary: SupplementSummary;
}
/** A current, authorized clinician confirms the original text and its migration provenance at the current server time.
 * The signer facts come from the server's verified session (B2/C), never from the request body. Changed wording is a new
 * lawful entry through C, not a supplement; the legacy author string and the unsigned original stay untouched.
 */
export function planLegacySupplement(reconciliation: Reconciliation, itemKey: string,
  request: { signer: SupplementSigner; at: string; viewed: { rowSha256: string; contentSha256: string; snapshotId: string } }): Readonly<SupplementPlan> {
  const r = verifiedReconciliation(reconciliation);
  const record = r.records.find(x => x.itemKey === itemKey);
  if (!record || record.marking?.status !== 'legacy-unsigned') refuse('LegacyRecordRequired');
  if (r.unresolved.some(f => f.itemKey === itemKey && f.blocksAcceptance)) refuse('SupplementBlockedByUnresolved');
  const roles = SUPPLEMENT_ROLES[record.kind];
  if (!roles) refuse('SupplementNotApplicable');
  const q = shaped('SupplementRequestMalformed', () => object(request, ['signer', 'at', 'viewed']));
  const s = shaped('SupplementAuthorityRefused', () => object(q.signer, ['identity', 'display', 'kind', 'roles', 'canSign', 'canReadStudy']));
  const signer = shaped('SupplementAuthorityRefused', () => identity(s.identity));
  if (s.kind !== 'member' || s.canSign !== true || s.canReadStudy !== true || !Array.isArray(s.roles) || !roles.some(x => s.roles.includes(x)))
    refuse('SupplementAuthorityRefused');
  const at = shaped('SupplementTimeRefused', () => utc(q.at));
  if (at < record.events[0].at) refuse('SupplementTimeRefused');
  const viewed = shaped('SupplementProvenanceUnconfirmed', () => object(q.viewed, ['rowSha256', 'contentSha256', 'snapshotId']));
  if (viewed.contentSha256 !== record.contentSha256) refuse('SupplementContentChanged');
  if (viewed.rowSha256 !== record.marking.provenance.rowSha256 || viewed.snapshotId !== record.marking.provenance.snapshotId) refuse('SupplementProvenanceUnconfirmed');
  const authors = LEGACY_SOURCES[record.model].authors.map(c => record.original.columns[c]);
  return freeze({ act: SUPPLEMENT_ACT, itemKey: record.itemKey, target: record.target, at, signer, signerDisplay: string(s.display),
    attests: { contentSha256: record.contentSha256, rowSha256: record.rowSha256, snapshotId: record.marking.provenance.snapshotId,
      inputSha256: record.marking.provenance.inputSha256 },
    // A matching display name is not the same person: the legacy author stays an unverified string.
    originalAuthor: { kind: 'legacy-display', values: authors, identity: record.marking.author.identity },
    marking: record.marking, retention: 'no-new-start', amendWindow: { status: 'not-granted', reason: 'supplement-is-not-approval' },
    route: 'emr-c-supplement-sign', summary: { act: SUPPLEMENT_ACT, at, signer, contentSha256: record.contentSha256 } }) as SupplementPlan;
}
