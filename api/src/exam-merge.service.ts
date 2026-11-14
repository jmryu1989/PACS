/*
 * Merge Exam / Unmerge: a record makes one logical exam out of a patient's studies (a base study and its members).
 * No DICOM object, UID or Orthanc resource is changed — the worklist shows the base row only (with every study's images),
 * the viewer opens all of them as the current study, and the report is written on the base. Q/R, export and the hospital's
 * EMR keep the original studies. Unmerge ends the record: each study's images belong to it again (images that arrived
 * while merged included, since they were always stored under their own study). A report written while merged keeps the
 * group it was written on (Report / ReportVersion / ReportDraft.groupId), so its source stays readable after Unmerge.
 *
 * Every change is judged and written in one transaction that locks the studies' StudyState rows in UID order (the same row
 * lock the report commit, the hold and the transfer start take), so a concurrent approval, hold or transfer either commits
 * first and is seen here, or waits and sees the new group. Both changes also give the studies a new draft epoch: a screen
 * that still shows the old grouping cannot save or approve on it (the existing draft-conflict answer).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { dump, holdAlive } from './pacs/values';
import { canReadPreliminary } from './preliminary-reader';

export const STUDY_MERGED = 'STUDY_MERGED';
export const EXAM_GROUP_REFUSED = 'EXAM_GROUP_REFUSED';
export const EXAM_SCOPE_CHANGED = 'EXAM_SCOPE_CHANGED';
/** At most this many studies in one merged exam (the viewer opens all of them in one window). */
export const MERGE_LIMIT = 10;
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const studyUidOf = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+)+$/.test(value);
/** A transfer to another institution that is still open (requested or accepted, not yet imported or ended). */
const OPEN_TRANSFER = ['OPEN', 'ACCEPTED'];
/** A local download (export to this PC) that is being prepared or sent. */
const OPEN_DOWNLOAD = ['prepared', 'sending'];

export interface ExamGroupMember { groupId: string; logicalUid: string; studyUid: string; part: number; seriesUids: string[];
  sourcePatientId?: string | null; sourceInstitution?: string | null }
export interface ExamGroup { id: string; kind: string; baseUid: string; institutionId: string; dissolvedAt?: Date | null; members: ExamGroupMember[] }
/** The exam a report on `uid` is written for: its active group (null = the study alone) and the original studies it covers. */
export interface ExamScope { groupId: string | null; kind: 'merge' | 'split' | null; baseUid: string; studies: string[] }

export interface ResolvedExamScope extends ExamScope {
  reportUid: string;
  part: number | null;
  active: boolean;
  sources: { studyUid: string; series: { mode: 'all' | 'include' | 'exclude'; uids: string[] } }[];
  generation: string;
  lockUids: string[];
  state: any;
  redirectUid?: string;
}
export interface ExamScopeRequest {
  uid: string;
  purpose: 'current' | 'stored' | 'source';
  record?: { groupId?: string | null };
  phase?: 'prepare' | 'write';
  prepared?: ResolvedExamScope;
  /** Other report parents needed by a compound operation, locked in the same order. */
  related?: string[];
}

const unique = (uids: string[]) => [...new Set(uids)];
const absent = () => new NotFoundException('검사를 찾을 수 없습니다');
const visible = (s: any, c: Caller) => s?.institutionId != null && (s.institutionId === inst(c) || s.teleInstitutionId === inst(c));

/** All membership interpretation lives here. A stored null is explicitly the original study, never today's group. */
async function describeScope(db: any, request: ExamScopeRequest): Promise<ResolvedExamScope> {
  const { uid, purpose } = request;
  let group: ExamGroup | undefined;
  if (purpose === 'stored') {
    if (!request.record) throw examScopeChanged();
    const id = request.record.groupId;
    if (id != null) {
      if (!GROUP_ID.test(id)) throw examScopeChanged();
      const [row] = await db.studyGroup.findMany({ where: { id: { in: [id] } } });
      if (!row) throw examScopeChanged();
      group = { ...row, members: await db.studyGroupMember.findMany({ where: { groupId: id } }) };
    }
  } else if (purpose === 'current') {
    const groups = await activeGroups(db, [uid]);
    if (groups.length > 1) throw examScopeChanged();
    group = groups[0];
  }
  // A retired logical part must never turn into an original DICOM study.
  if (!group) {
    const parts: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { logicalUid: uid } });
    if (parts.some(p => p.studyUid !== uid)) throw examScopeChanged();
  }
  const members = group?.members ?? [];
  let sources: ResolvedExamScope['sources'], part: number | null = null;
  if (group?.kind === 'merge') {
    if (!members.length || !members.some(m => m.studyUid === group!.baseUid) || members.some(m => m.studyUid !== m.logicalUid)) throw examScopeChanged();
    if (group.baseUid !== uid && purpose === 'stored') throw examScopeChanged();
    sources = unique(members.sort((a, b) => a.part - b.part).map(m => m.studyUid))
      .map(studyUid => ({ studyUid, series: { mode: 'all', uids: [] } }));
  } else if (group?.kind === 'split') {
    const selected = members.find(m => m.logicalUid === uid), second = members.find(m => m.part === 1);
    if (members.length !== 2 || !selected || !second?.seriesUids.length || !members.some(m => m.part === 0)
      || members.some(m => m.studyUid !== group!.baseUid)) throw examScopeChanged();
    part = selected.part;
    sources = [{ studyUid: selected.studyUid, series: { mode: part === 0 ? 'exclude' : 'include', uids: [...second.seriesUids].sort() } }];
  } else if (group) throw examScopeChanged();
  else sources = [{ studyUid: uid, series: { mode: 'all', uids: [] } }];
  const state = await db.studyState.findUnique({ where: { uid } });
  const scope = { groupId: group?.id ?? null, kind: (group?.kind ?? null) as ExamScope['kind'], baseUid: group?.baseUid ?? uid,
    reportUid: uid, part, active: group ? group.dissolvedAt == null : true, sources,
    ...(group?.kind === 'merge' && group.baseUid !== uid ? { redirectUid: group.baseUid } : {}),
    studies: sources.map(s => s.studyUid), lockUids: unique([uid, ...members.flatMap(m => [m.logicalUid, m.studyUid])]).sort(), state };
  return { ...scope, generation: createHash('sha256').update(JSON.stringify([uid, scope.groupId, part, sources,
    purpose !== 'stored' ? state?.draftEpoch ?? null : null])).digest('hex') };
}

/**
 * One interpretation for current work, preserved text and explicitly selected originals. Preparation observes Orthanc
 * before locks. A write locks the prepared parents in UID order, then resolves again on that connection; it never
 * widens the lock set in response to a concurrent group change. Reads supplied a transaction stay on that transaction.
 */
export async function resolveExamScope(db: any, access: StudyAccessService, c: Caller, request: ExamScopeRequest): Promise<ResolvedExamScope> {
  if (request.phase === 'write') {
    if (!request.prepared) throw examScopeChanged();
    await access.require(c, request.prepared.studies, db);
    await lockExamStates(db, unique([...request.prepared.lockUids, ...request.related ?? []]).sort());
  }
  const scope = await describeScope(db, request);
  if (request.prepared && scope.generation !== request.prepared.generation) throw examScopeChanged();
  if (!visible(scope.state, c)) throw absent();
  if (request.phase === 'prepare') {
    await access.prepare(c, scope.studies);
    await access.prepareSourceIdentity(c, scope.studies);
  }
  const rows = scope.studies.length === 1 && scope.studies[0] === request.uid
    ? [scope.state] : await db.studyState.findMany({ where: { uid: { in: scope.studies } } });
  if (rows.length !== scope.studies.length || rows.some(s => !visible(s, c))) throw absent();
  await access.require(c, scope.studies, db);
  requireCurrentTarget(scope);
  if (request.phase === 'prepare') return scope;
  // Only observed original identities may qualify a logical exam. This is distinct from policy matching, which permits
  // missing metadata for UID-only policies. A missing source must not masquerade as an ordinary ungrouped study.
  if (request.phase === 'write' || request.purpose === 'current' || scope.groupId) {
    const observed = scope.studies.map(uid => access.assertIdentifiedSource(c, uid));
    if (new Set(observed.map(s => s.sourcePatientId)).size !== 1 || new Set(rows.map(s => s.institutionId)).size !== 1)
      throw examScopeChanged();
    if (scope.groupId) {
      for (const row of rows) await access.requireSourceOwner(c, row.uid, row.institutionId, db);
      const [group] = await db.studyGroup.findMany({ where: { id: { in: [scope.groupId] } } });
      if (!group || rows.some(s => s.institutionId !== group.institutionId)) throw examScopeChanged();
      const members: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { groupId: scope.groupId } });
      for (const member of members) {
        const source = access.assertIdentifiedSource(c, member.studyUid);
        if (member.sourcePatientId != null && member.sourcePatientId !== source.sourcePatientId
          || member.sourceInstitution != null && member.sourceInstitution !== source.sourceInstitution) throw examScopeChanged();
      }
    }
  }
  return scope;
}

export async function lockExamStates(tx: any, uids: string[]): Promise<any[]> {
  const sorted = unique(uids).sort();
  return tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid IN (${Prisma.join(sorted)}) ORDER BY uid FOR UPDATE`;
}

function requireCurrentTarget(scope: ResolvedExamScope) {
  if (scope.redirectUid) throw new ConflictException({ code: STUDY_MERGED, baseUid: scope.redirectUid,
    message: '이 검사는 다른 검사에 합쳐져 있습니다(Merge Exam). 목록에서 합친 검사를 열어 판독하세요.' });
}

/** Prepare all historical originals once, outside a read transaction. The record itself is selected inside it. */
export async function prepareExamRead(db: any, access: StudyAccessService, c: Caller, uid: string) {
  const touched: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { logicalUid: uid } });
  const members: ExamGroupMember[] = touched.length
    ? await db.studyGroupMember.findMany({ where: { groupId: { in: unique(touched.map(m => m.groupId)) } } }) : [];
  const studies = unique(members.length ? members.map(m => m.studyUid) : [uid]);
  await access.prepare(c, studies);
  await access.prepareSourceIdentity(c, studies);
  return studies;
}

/** Authorization of a report parent, including a retired split part. It does not relabel any stored body. */
export async function examParentAccess(db: any, access: StudyAccessService, c: Caller, uid: string, prepare = false) {
  const parts: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { logicalUid: uid } });
  const part = parts.find(p => p.studyUid !== uid);
  if (part && prepare) await prepareExamRead(db, access, c, uid);
  return resolveExamScope(db, access, c, part
    ? { uid, purpose: 'stored', record: { groupId: part.groupId } }
    : { uid, purpose: 'source' });
}

export async function prepareExamParent(db: any, access: StudyAccessService, c: Caller, uid: string) {
  const parts: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { logicalUid: uid } });
  const part = parts.find(p => p.studyUid !== uid);
  if (part) return prepareExamRead(db, access, c, uid);
  await access.prepare(c, [uid]);
  return [uid];
}

/** A body projection may withhold inaccessible preserved text, but never substitute the current scope for it. */
export async function readableExamRecord(db: any, access: StudyAccessService, c: Caller, uid: string, record: { groupId?: string | null }) {
  try { return await resolveExamScope(db, access, c, { uid, purpose: 'stored', record }); }
  catch (error) {
    if (error instanceof NotFoundException || error instanceof ConflictException) return null;
    throw error;
  }
}

/** Existing source lists can link to the current merged report without pretending it was written on that source alone. */
export async function relatedExamRecord(db: any, access: StudyAccessService, c: Caller, row: { uid: string; groupId?: string; mergedInto?: string }) {
  const [current] = row.groupId ? [] : await activeGroups(db, [row.uid]);
  const uid = current?.kind === 'merge' ? current.baseUid : row.uid;
  await prepareExamRead(db, access, c, uid);
  return readableExamRecord(db, access, c, uid, { groupId: row.groupId ?? current?.id ?? null });
}

/** List projections consume these resolved exams; only this module enumerates merge members and split parts. */
export async function currentExams(db: any, access: StudyAccessService, c: Caller, originalUids: string[]): Promise<ResolvedExamScope[]> {
  const result: ResolvedExamScope[] = [];
  for (const group of await activeGroups(db, originalUids)) {
    const uids = group.kind === 'merge' ? [group.baseUid] : group.members.map(m => m.logicalUid);
    for (const uid of uids) {
      try {
        const described = await describeScope(db, { uid, purpose: 'current' });
        if (!described.studies.every(s => originalUids.includes(s))) continue;
        await prepareExamRead(db, access, c, uid);
        const scope = await resolveExamScope(db, access, c, { uid, purpose: 'current' });
        if (scope.studies.every(s => originalUids.includes(s))) result.push(scope);
      } catch (error) {
        if (!(error instanceof NotFoundException || error instanceof ConflictException)) throw error;
      }
    }
  }
  return result;
}

/** Workload counts use report parents; source registrations and archive bytes keep their original meaning. */
export async function currentExamStates(db:any,access:StudyAccessService,c:Caller,states:any[]) {
  const parts:ExamGroupMember[]=await db.studyGroupMember.findMany({where:{logicalUid:{in:states.map(s=>s.uid)}}});
  const logicalOnly=new Set(parts.filter(p=>p.logicalUid!==p.studyUid).map(p=>p.logicalUid));
  const originals=states.filter(s=>!logicalOnly.has(s.uid));
  const scopes=await currentExams(db,access,c,originals.map(s=>s.uid));
  const covered=new Set((await activeGroups(db,originals.map(s=>s.uid))).flatMap(group=>group.members.map(member=>member.studyUid)));
  return {originals,states:[...originals.filter(s=>!covered.has(s.uid)),...scopes.map(scope=>scope.state)],
    generations:scopes.map(scope=>scope.generation).sort()};
}

export function scopeIncludesSeries(scope: ResolvedExamScope, studyUid: string, seriesUid: string) {
  const series = scope.sources.find(s => s.studyUid === studyUid)?.series;
  return !!series && (series.mode === 'all' || (series.mode === 'include' ? series.uids.includes(seriesUid) : !series.uids.includes(seriesUid)));
}

/** Public scope facts, shared by read responses and stored output records. No state or lock implementation escapes. */
export function examScopeView(scope: ResolvedExamScope) {
  return { reportUid: scope.reportUid, groupId: scope.groupId, kind: scope.kind, part: scope.part, active: scope.active,
    sources: scope.sources, generation: scope.generation };
}

/** Original-keyed collections keep their keys. Links are a projection, so merging never rewrites saved references. */
export async function examLinks(db: any, access: StudyAccessService, c: Caller, uids: string[]) {
  if(!uids.length)return [];
  const touched = await db.studyGroupMember.findMany({ where: { OR: [
    { studyUid: { in: unique(uids) } }, { logicalUid: { in: unique(uids) } }] } });
  const groups: ExamGroup[] = touched.length ? await db.studyGroup.findMany({ where: { id: { in: unique(touched.map(m => m.groupId)) } } }) : [];
  const members: ExamGroupMember[] = groups.length
    ? await db.studyGroupMember.findMany({ where: { groupId: { in: groups.map(g => g.id) } } }) : [];
  const links: { uid: string; exams: ReturnType<typeof examScopeView>[] }[] = [];
  for (const uid of unique(uids)) {
    const requests: ExamScopeRequest[] = [{ uid, purpose: 'source' }];
    for (const group of groups.filter(g => touched.some(m => m.groupId === g.id && (m.studyUid === uid || m.logicalUid === uid)))) {
      const parents = group.kind === 'merge' ? [group.baseUid] : members.filter(m => m.groupId === group.id).map(m => m.logicalUid);
      for (const parent of parents) requests.push({ uid: parent, purpose: group.dissolvedAt ? 'stored' : 'current', record: { groupId: group.id } });
    }
    const scopes = new Map<string, ReturnType<typeof examScopeView>>();
    for (const request of requests) {
      try {
        const scope = await resolveExamScope(db, access, c, request);
        scopes.set(scope.generation, examScopeView(scope));
      } catch (error) {
        if (!(error instanceof NotFoundException || error instanceof ConflictException)) throw error;
      }
    }
    links.push({ uid, exams: [...scopes.values()] });
  }
  return links;
}

/** A source can lead to both split reports and to reports retained after dissolution. Never relabel their head. */
export async function relatedExamReports(db:any,access:StudyAccessService,c:Caller,uid:string) {
  const [link]=await examLinks(db,access,c,[uid]);
  const reports:any[]=[];
  for(const exam of link.exams) {
    const row=await db.reportVersion.findFirst({where:{uid:exam.reportUid,groupId:exam.groupId,action:{not:'discarded'}},orderBy:{version:'desc'}});
    if(!row)continue;
    const scope=await readableExamRecord(db,access,c,exam.reportUid,row);
    if(!scope||!canReadPreliminary(scope.state,c))continue;
    if(!reports.some(r=>r.uid===row.uid&&r.version===row.version))reports.push({uid:row.uid,version:row.version,action:row.action,scope:examScopeView(scope)});
  }
  return reports;
}

/** Source corrections must not change the identity on which any active or preserved logical report depends. */
export async function requireUngroupedSource(db: any, access: StudyAccessService, c: Caller, uid: string) {
  const scope = await resolveExamScope(db, access, c, { uid, purpose: 'source' });
  const members: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { OR: [{ studyUid: uid }, { logicalUid: uid }] } });
  if (!members.length) return scope;
  const where = { groupId: { in: unique(members.map(m => m.groupId)) } };
  const groups = await db.studyGroup.findMany({ where: { id: where.groupId } });
  if (groups.some(group => group.dissolvedAt == null)
    || await db.reportVersion.findFirst({ where }) || await db.reportDraft.findFirst({ where: { ...where, present: true } })
    || await db.reportDraftPurposeEnd.findFirst({ where }))
    throw new ConflictException('검사 묶음이나 보존 판독의 원본 정보는 변경할 수 없습니다');
  return scope;
}

export async function examLookupSources(db: any, uids: string[]) {
  const groups = await activeGroups(db, uids);
  const parts = groups.flatMap(g => g.members);
  return { sources: unique(uids.flatMap(uid => {
    const group = groups.find(g => g.members.some(m => m.logicalUid === uid || m.studyUid === uid));
    return group ? group.members.map(m => m.studyUid) : [uid];
  })), parents: unique([...uids, ...parts.flatMap(p => [p.logicalUid, p.studyUid])]) };
}

/** The active groups any of these UIDs (a study UID or a logical exam UID) belongs to, each with all its members. */
export async function activeGroups(db: any, uids: string[]): Promise<ExamGroup[]> {
  const unique = [...new Set(uids)];
  if (!unique.length) return [];
  const touched: ExamGroupMember[] = await db.studyGroupMember.findMany({
    where: { OR: [{ studyUid: { in: unique } }, { logicalUid: { in: unique } }] },
    select: { groupId: true, logicalUid: true, studyUid: true, part: true, seriesUids: true } });
  if (!touched.length) return [];
  const groups = await db.studyGroup.findMany({ where: { id: { in: [...new Set(touched.map(m => m.groupId))] }, dissolvedAt: null },
    select: { id: true, kind: true, baseUid: true, institutionId: true, dissolvedAt: true } });
  if (!groups.length) return [];
  const members: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { groupId: { in: groups.map((g: any) => g.id) } },
    select: { groupId: true, logicalUid: true, studyUid: true, part: true, seriesUids: true } });
  return groups.map((g: any) => ({ ...g, members: members.filter(m => m.groupId === g.id)
    .sort((a, b) => a.part - b.part || (a.logicalUid < b.logicalUid ? -1 : a.logicalUid > b.logicalUid ? 1 : 0)) }));
}

/** 409 EXAM_SCOPE_CHANGED: a report or draft written on another exam (before a Merge or an Unmerge) than the study's current one. */
export const examScopeChanged = () => new ConflictException({ code: EXAM_SCOPE_CHANGED,
  message: '이 판독문은 검사를 합치거나 되돌리기 전의 영상으로 쓴 것입니다. 판독 취소(Reset)나 초안 버리기로 이력에 남긴 뒤 다시 판독하세요.' });

/** One refusal of a group change, for the window's Checks list: which study, which rule, and a sentence. */
export interface GroupRefusal { uid: string | null; rule: string; message: string }

@Injectable()
export class ExamMergeService {
  constructor(private readonly prisma: PrismaService, private readonly studyAccess: StudyAccessService) {}

  /** The active group of a worklist exam UID, with the checks Unmerge would apply now (nothing is changed). */
  async group(c: Caller, uid: string) {
    need(c.roles, 'technician', '검사 묶음 조회');
    const me = inst(c);
    if (!studyUidOf(uid)) throw new NotFoundException('검사를 찾을 수 없습니다');
    await prepareExamRead(this.prisma, this.studyAccess, c, uid);
    await examParentAccess(this.prisma, this.studyAccess, c, uid);
    const state = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
    const [group] = await activeGroups(this.prisma, [uid]);
    if (!group) return { group: null };
    await resolveExamScope(this.prisma, this.studyAccess, c, { uid: group.kind === 'merge' ? group.baseUid : uid, purpose: 'current' });
    const uids = this.lockUids(group);
    await this.studyAccess.require(c, unique(group.members.map(m => m.studyUid)));
    const rows = await this.prisma.studyState.findMany({ where: { uid: { in: uids } } });
    const refusals = await this.dissolveRefusals(this.prisma, c, group, rows);
    return { group: this.view(group), checks: [...(group.institutionId === me ? [] : [
      { rule: 'owner', ok: false, message: '검사 묶음은 원본 소유 기관에서만 되돌릴 수 있습니다.', uids: [] }]), ...this.checks(refusals)] };
  }

  /**
   * Merge: `uids` (2..MERGE_LIMIT studies, the base among them) become one exam on `baseUid`. Refused (409 EXAM_GROUP_REFUSED
   * with every reason) unless every study is this institution's own, readable by the caller, of one identified patient (the
   * original PatientID of each study, never an empty one), in no active group, with no report written or approved (RS W),
   * no draft, no one else reading it (a live hold) and no transfer or export in progress.
   */
  async merge(c: Caller, body: any) {
    need(c.roles, 'technician', '검사 합치기');
    const me = inst(c);
    const baseUid = body?.baseUid, uids = body?.uids;
    if (!studyUidOf(baseUid) || !Array.isArray(uids) || uids.length < 2 || uids.length > MERGE_LIMIT || !uids.every(studyUidOf)
      || new Set(uids).size !== uids.length || !uids.includes(baseUid) || Object.keys(body).some(k => k !== 'baseUid' && k !== 'uids'))
      throw new BadRequestException(`합칠 검사 2~${MERGE_LIMIT}개와 그중 기준 검사(baseUid)를 보내세요`);
    const sorted = [...uids].sort();
    // Source reads happen before any lock: the policy's original tags and each study's original patient.
    await this.studyAccess.prepare(c, sorted);
    await this.studyAccess.prepareSourceIdentity(c, sorted);
    const prepared = await Promise.all(sorted.map(uid => describeScope(this.prisma, { uid, purpose: 'source' })));
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c, sorted, tx);
      const rows = await this.lock(tx, sorted);
      for (const scope of prepared) {
        const current = await resolveExamScope(tx, this.studyAccess, c, { uid: scope.reportUid, purpose: 'source', prepared: scope });
        if (current.generation !== scope.generation) throw examScopeChanged();
      }
      const refusals = await this.mergeRefusals(tx, c, me, sorted, rows);
      if (refusals.length) throw this.refused('합칠 수 없습니다', refusals);
      const id = randomUUID(), at = new Date();
      await tx.studyGroup.create({ data: { id, institutionId: me, kind: 'merge', baseUid, createdBy: c.actor, createdBySub: c.sub, createdAt: at } });
      const order = [baseUid, ...sorted.filter(uid => uid !== baseUid)];
      await tx.studyGroupMember.createMany({ data: order.map((uid, part) => ({ groupId: id, logicalUid: uid, studyUid: uid, part, seriesUids: [],
        ...this.studyAccess.assertIdentifiedSource(c, uid) })) });
      await this.newEpochs(tx, sorted);
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'study.merge', target: baseUid,
        detail: dump({ by: me, group: id, base: baseUid, studies: order }) } });
      return { group: { id, kind: 'merge', baseUid, members: order.map((uid, part) => ({ logicalUid: uid, studyUid: uid, part, seriesUids: [] })) } };
    }, { maxWait: 4000, timeout: 8000 });
  }

  /** The selected series become a second report target; the complement (including later series) stays on the first. */
  async split(c: Caller, body: any) {
    need(c.roles, 'technician', '검사 나누기');
    const uid = body?.uid, selected = body?.seriesUids;
    if (!studyUidOf(uid) || !Array.isArray(selected) || !selected.length || !selected.every(studyUidOf)
      || new Set(selected).size !== selected.length || Object.keys(body).some(k => !['uid', 'seriesUids'].includes(k)))
      throw new BadRequestException('둘째 검사로 옮길 시리즈를 선택하세요');
    const prepared = await resolveExamScope(this.prisma, this.studyAccess, c, { uid, purpose: 'source', phase: 'prepare' });
    const series = await this.studyAccess.sourceSeries(uid);
    if (selected.some(s => !series.some(row => row.uid === s)) || selected.length >= series.length)
      throw new BadRequestException('존재하는 시리즈 중 일부를 선택하세요. 전체 시리즈를 옮길 수 없습니다');
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      const scope = await resolveExamScope(tx, this.studyAccess, c, { uid, purpose: 'source', phase: 'write', prepared });
      const refusals = await this.mergeRefusals(tx, c, inst(c), [uid], [scope.state]);
      if (refusals.length) throw this.refused('나눌 수 없습니다', refusals);
      const id = randomUUID(), second = '2.25.' + BigInt('0x' + randomUUID().replace(/-/g, '')).toString();
      await tx.studyState.create({ data: { uid: second, institutionId: scope.state.institutionId,
        teleInstitutionId: scope.state.teleInstitutionId, origin: 'logical', ss: scope.state.ss, em: scope.state.em } });
      await tx.studyGroup.create({ data: { id, institutionId: inst(c), kind: 'split', baseUid: uid, createdBy: c.actor, createdBySub: c.sub } });
      const members = [{ groupId: id, logicalUid: uid, studyUid: uid, part: 0, seriesUids: [] },
        { groupId: id, logicalUid: second, studyUid: uid, part: 1, seriesUids: [...selected].sort() }];
      await tx.studyGroupMember.createMany({ data: members.map(m => ({ ...m, ...this.studyAccess.assertIdentifiedSource(c, uid) })) });
      await this.newEpochs(tx, [uid, second]);
      await tx.auditLog.create({ data: { actor: c.actor, action: 'study.split', target: uid,
        detail: dump({ by: inst(c), group: id, studies: [uid], parts: members.map(m => ({ uid: m.logicalUid, part: m.part, seriesUids: m.seriesUids })) }) } });
      return { group: { id, kind: 'split', baseUid: uid, members } };
    }, { maxWait: 4000, timeout: 8000 });
  }

  async scope(c: Caller, uid: string, query: any = {}) {
    if(Object.keys(query).some(k=>!['purpose','version'].includes(k))||query.purpose!==undefined&&!['current','source','stored'].includes(query.purpose)
      ||query.version!==undefined&&(!/^[1-9]\d*$/.test(String(query.version))||!Number.isSafeInteger(Number(query.version))))
      throw new BadRequestException('검사 범위 조회 형식을 확인하세요');
    await prepareExamRead(this.prisma, this.studyAccess, c, uid);
    return this.prisma.$transaction(async tx=>{
      const purpose=query.purpose??(query.version===undefined?'current':'stored');
      if(query.version!==undefined&&purpose!=='stored')throw new BadRequestException('저장 판의 범위를 선택하세요');
      const record=purpose==='stored'?(query.version===undefined?await tx.report.findUnique({where:{uid}})
        :await tx.reportVersion.findUnique({where:{uid_version:{uid,version:Number(query.version)}}})):undefined;
      if(purpose==='stored'&&!record)throw absent();
      const {state,lockUids,...scope}=await resolveExamScope(tx,this.studyAccess,c,{uid,purpose,record});
      if(!canReadPreliminary(state,c))throw absent();
      return scope;
    },{isolationLevel:'RepeatableRead'});
  }

  /**
   * Unmerge: the group ends (dissolvedAt) and every study is an exam of its own again. Refused while the merged exam has an
   * approved report now (Reset it to Unread first — a report saved but not approved may stay: it keeps the group it was written
   * on), a draft, someone else reading it, or a transfer or export in progress.
   */
  async dissolve(c: Caller, id: string) {
    need(c.roles, 'technician', '검사 묶음 되돌리기');
    const me = inst(c);
    if (typeof id !== 'string' || !GROUP_ID.test(id)) throw new NotFoundException('검사 묶음을 찾을 수 없습니다');
    const found = await this.prisma.studyGroup.findUnique({ where: { id } });
    if (!found || found.institutionId !== me) throw new NotFoundException('검사 묶음을 찾을 수 없습니다');
    const before = (await activeGroups(this.prisma, [found.baseUid])).find(g => g.id === id);
    if (!before) throw new ConflictException({ code: EXAM_GROUP_REFUSED, message: '이미 되돌린 검사입니다. 목록을 새로고침하세요.', refusals: [] });
    const uids = this.lockUids(before);
    const originals = unique(before.members.map(m => m.studyUid));
    await this.studyAccess.prepare(c, originals);
    await this.studyAccess.prepareSourceIdentity(c, originals);
    const prepared = await resolveExamScope(this.prisma, this.studyAccess, c,
      { uid: before.baseUid, purpose: 'current', phase: 'prepare' });
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c, originals, tx);
      await resolveExamScope(tx, this.studyAccess, c,
        { uid: before.baseUid, purpose: 'current', phase: 'write', prepared });
      const rows = await tx.studyState.findMany({ where: { uid: { in: uids } } });
      // Judged on the group as it is under the lock (a concurrent Unmerge already ended it).
      const group = (await activeGroups(tx, [before.baseUid])).find(g => g.id === id);
      if (!group || JSON.stringify(this.lockUids(group)) !== JSON.stringify(uids))
        throw new ConflictException({ code: EXAM_GROUP_REFUSED, message: '검사 묶음이 바뀌었습니다. 목록을 새로고침하세요.', refusals: [] });
      if (rows.length !== uids.length || rows.some(row => row.institutionId !== me)) throw new NotFoundException('검사 묶음을 찾을 수 없습니다');
      for (const uid of originals) await this.studyAccess.requireSourceOwner(c, uid, me, tx);
      if (new Set(originals.map(uid => this.studyAccess.assertIdentifiedSource(c, uid).sourcePatientId)).size !== 1) throw examScopeChanged();
      const refusals = await this.dissolveRefusals(tx, c, group, rows);
      if (refusals.length) throw this.refused('되돌릴 수 없습니다', refusals);
      const at = new Date();
      const ended = await tx.studyGroup.updateMany({ where: { id, dissolvedAt: null }, data: { dissolvedAt: at, dissolvedBy: c.actor, dissolvedBySub: c.sub } });
      if (ended.count !== 1) throw new ConflictException({ code: EXAM_GROUP_REFUSED, message: '이미 되돌린 검사입니다. 목록을 새로고침하세요.', refusals: [] });
      await this.newEpochs(tx, uids);
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: group.kind === 'split' ? 'study.unsplit' : 'study.unmerge',
        target: group.baseUid, detail: dump({ by: me, group: id, base: group.baseUid, studies: group.members.map(m => m.logicalUid) }) } });
      return { group: { ...this.view(group), dissolvedAt: at.toISOString() } };
    }, { maxWait: 4000, timeout: 8000 });
  }

  // ── rules ──

  private async mergeRefusals(tx: any, c: Caller, me: string, uids: string[], rows: any[]): Promise<GroupRefusal[]> {
    const out: GroupRefusal[] = [];
    // A study the caller's institution does not own (a tele study, another hospital's, or none) is "not found", like elsewhere.
    if (rows.length !== uids.length || rows.some(row => row.institutionId !== me)) throw new NotFoundException('검사를 찾을 수 없습니다');
    const patients = new Map<string, string>();
    for (const uid of uids) {
      const source = this.studyAccess.assertUnsplitSource(c, uid);
      if (source.sourcePatientId?.trim()) {
        this.studyAccess.assertIdentifiedSource(c, uid);
        await this.studyAccess.requireSourceOwner(c, uid, me, tx);
      }
      const patient = source.sourcePatientId?.trim() ?? '';
      if (!patient) out.push({ uid, rule: 'patient-unidentified', message: '이 검사의 원본 환자 ID가 비어 있습니다.' });
      else patients.set(uid, patient);
    }
    const distinct = [...new Set(patients.values())];
    if (distinct.length > 1) out.push({ uid: null, rule: 'different-patients', message: `다른 환자의 검사는 합칠 수 없습니다 (${distinct.join(', ')}).` });
    out.push(...await this.commonRefusals(tx, c, rows, uids, rows));
    for (const group of await activeGroups(tx, uids))
      for (const uid of uids.filter(u => group.members.some(m => m.studyUid === u || m.logicalUid === u)))
        out.push({ uid, rule: 'grouped', message: group.kind === 'merge' ? '이미 합친 검사에 들어 있는 검사입니다.' : '두 검사로 나뉜 검사입니다.' });
    return out;
  }

  private async dissolveRefusals(tx: any, c: Caller, group: ExamGroup, rows: any[]): Promise<GroupRefusal[]> {
    const studies = [...new Set(group.members.map(m => m.studyUid))];
    return this.commonRefusals(tx, c, rows, studies, rows, true);
  }

  /**
   * Report, draft, hold and transfer rules. `dissolving`: only an approved report (now) refuses — a saved report keeps the group
   * it was written on; merging refuses any written report (RS other than W), since the merged exam would show it as its own.
   */
  private async commonRefusals(tx: any, c: Caller, rows: any[], studies: string[], states: any[], dissolving = false): Promise<GroupRefusal[]> {
    const out: GroupRefusal[] = [];
    for (const row of states) {
      if (row.rs === 'D') out.push({ uid: row.uid, rule: 'destroyed', message: '보존 기간이 끝나 판독문을 파기한 검사입니다.' });
      else if (row.rs === 'A') out.push({ uid: row.uid, rule: 'approved', message: '승인된 판독문이 있습니다. 먼저 판독 취소(Reset)를 하세요.' });
      else if (!dissolving && row.rs !== 'W') out.push({ uid: row.uid, rule: 'reported', message: `판독문이 있습니다(RS ${row.rs}). 먼저 판독 취소(Reset)를 하세요.` });
      if (holdAlive(row) && row.holder !== c.actor) out.push({ uid: row.uid, rule: 'held', message: '판독의가 지금 이 검사의 판독문을 쓰고 있습니다.' });
    }
    const uids = states.map(row => row.uid);
    const drafts = await tx.reportDraft.findMany({ where: { uid: { in: uids }, present: true }, select: { uid: true } });
    for (const uid of new Set<string>(drafts.map((d: any) => d.uid)))
      out.push({ uid, rule: 'draft', message: '이 검사에 열린 판독 초안이 있습니다. 먼저 저장하거나 버려야 합니다.' });
    const transfers = await tx.transfer.findMany({ where: { studyUid: { in: studies }, status: { in: OPEN_TRANSFER } }, select: { studyUid: true } });
    const downloads = await tx.importOperation.findMany({ where: { studyUid: { in: studies }, kind: 'download', status: { in: OPEN_DOWNLOAD } }, select: { studyUid: true } });
    for (const uid of new Set<string>([...transfers, ...downloads].map((t: any) => t.studyUid)))
      out.push({ uid, rule: 'transfer', message: '이 검사의 전송 또는 내보내기가 진행 중입니다.' });
    return out;
  }

  /** The Checks the Split / Unmerge window lists: each rule with ✓ (passes) or the refusals that apply. */
  private checks(refusals: GroupRefusal[]) {
    const rule = (key: string[], ok: string) => {
      const hit = refusals.filter(r => key.includes(r.rule));
      return { rule: key[0], ok: !hit.length, message: hit.length ? hit.map(r => r.message).join(' ') : ok, uids: hit.map(r => r.uid) };
    };
    return [rule(['approved', 'destroyed'], '합친 검사에 지금 승인된 판독문이 없습니다.'),
      rule(['transfer'], '이 검사들의 전송·내보내기가 진행 중이지 않습니다.'),
      rule(['held', 'draft'], '합친 검사의 판독문을 쓰는 사람이 없습니다.')];
  }

  private refused(prefix: string, refusals: GroupRefusal[]) {
    return new ConflictException({ code: EXAM_GROUP_REFUSED, message: prefix + ': ' + [...new Set(refusals.map(r => r.message))].join(' '), refusals });
  }

  private lockUids(group: ExamGroup) {
    return [...new Set(group.members.flatMap(m => [m.studyUid, m.logicalUid]))].sort();
  }

  private async lock(tx: any, uids: string[]): Promise<any[]> {
    return lockExamStates(tx, uids);
  }

  /** A new draft epoch: every write a screen sends with the old one is refused (it still shows the old grouping). */
  private async newEpochs(tx: any, uids: string[]) {
    for (const uid of uids) await tx.studyState.update({ where: { uid }, data: { draftEpoch: randomUUID() } });
  }

  private view(group: ExamGroup) {
    return { id: group.id, kind: group.kind, baseUid: group.baseUid,
      members: group.members.map(m => ({ logicalUid: m.logicalUid, studyUid: m.studyUid, part: m.part, seriesUids: m.seriesUids })) };
  }
}
