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
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { dump, holdAlive } from './pacs/values';

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

export interface ExamGroupMember { groupId: string; logicalUid: string; studyUid: string; part: number; seriesUids: string[] }
export interface ExamGroup { id: string; kind: string; baseUid: string; institutionId: string; members: ExamGroupMember[] }
/** The exam a report on `uid` is written for: its active group (null = the study alone) and the original studies it covers. */
export interface ExamScope { groupId: string | null; kind: 'merge' | 'split' | null; baseUid: string; studies: string[] }

/** The active groups any of these UIDs (a study UID or a logical exam UID) belongs to, each with all its members. */
export async function activeGroups(db: any, uids: string[]): Promise<ExamGroup[]> {
  const unique = [...new Set(uids)];
  if (!unique.length) return [];
  const touched: ExamGroupMember[] = await db.studyGroupMember.findMany({
    where: { OR: [{ studyUid: { in: unique } }, { logicalUid: { in: unique } }] },
    select: { groupId: true, logicalUid: true, studyUid: true, part: true, seriesUids: true } });
  if (!touched.length) return [];
  const groups = await db.studyGroup.findMany({ where: { id: { in: [...new Set(touched.map(m => m.groupId))] }, dissolvedAt: null },
    select: { id: true, kind: true, baseUid: true, institutionId: true } });
  if (!groups.length) return [];
  const members: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { groupId: { in: groups.map((g: any) => g.id) } },
    select: { groupId: true, logicalUid: true, studyUid: true, part: true, seriesUids: true } });
  return groups.map((g: any) => ({ ...g, members: members.filter(m => m.groupId === g.id)
    .sort((a, b) => a.part - b.part || (a.logicalUid < b.logicalUid ? -1 : a.logicalUid > b.logicalUid ? 1 : 0)) }));
}

/** The institution's active merged exams, each with its members (the worklist reads them once per list). */
export async function institutionMerges(db: any, institutionId: string): Promise<ExamGroup[]> {
  const groups = await db.studyGroup.findMany({ where: { institutionId, kind: 'merge', dissolvedAt: null },
    select: { id: true, kind: true, baseUid: true, institutionId: true } });
  if (!groups.length) return [];
  const members: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { groupId: { in: groups.map((g: any) => g.id) } },
    select: { groupId: true, logicalUid: true, studyUid: true, part: true, seriesUids: true } });
  return groups.map((g: any) => ({ ...g, members: members.filter(m => m.groupId === g.id).sort((a, b) => a.part - b.part) }));
}

/**
 * The report scope of a worklist exam UID. A merged member is not an exam of its own while merged: every report write on it
 * (hold, draft, save, approve) is refused with 409 STUDY_MERGED naming the base, so a stale screen cannot write a report the
 * merged exam does not show. Read under the caller's StudyState row lock.
 */
export async function examScope(db: any, uid: string): Promise<ExamScope> {
  const [group] = await activeGroups(db, [uid]);
  if (!group) return { groupId: null, kind: null, baseUid: uid, studies: [uid] };
  if (group.kind === 'merge') {
    if (group.baseUid !== uid)
      throw new ConflictException({ code: STUDY_MERGED, baseUid: group.baseUid,
        message: '이 검사는 다른 검사에 합쳐져 있습니다(Merge Exam). 목록에서 합친 검사를 열어 판독하세요.' });
    return { groupId: group.id, kind: 'merge', baseUid: uid, studies: [...new Set(group.members.map(m => m.studyUid))] };
  }
  const part = group.members.find(m => m.logicalUid === uid);
  return { groupId: group.id, kind: 'split', baseUid: group.baseUid, studies: part ? [part.studyUid] : [uid] };
}

/**
 * The exam groups a report text was written on, by group id: each with its original study UIDs (base first) and whether it is
 * still merged. A report, version or draft that carries a group is about every one of these studies' images.
 */
export async function reportGroups(db: any, groupIds: (string | null | undefined)[]): Promise<Map<string, { id: string; baseUid: string;
    active: boolean; studies: string[] }>> {
  const ids = [...new Set(groupIds.filter((id): id is string => typeof id === 'string' && GROUP_ID.test(id)))];
  if (!ids.length) return new Map();
  const groups = await db.studyGroup.findMany({ where: { id: { in: ids } }, select: { id: true, baseUid: true, dissolvedAt: true } });
  const members: ExamGroupMember[] = await db.studyGroupMember.findMany({ where: { groupId: { in: ids } },
    select: { groupId: true, logicalUid: true, studyUid: true, part: true, seriesUids: true } });
  return new Map(groups.map((g: any) => [g.id, { id: g.id, baseUid: g.baseUid, active: g.dissolvedAt == null,
    studies: [...new Set(members.filter(m => m.groupId === g.id).sort((a, b) => a.part - b.part).map(m => m.studyUid))] }]));
}

/**
 * Whether the caller may read every original study of an exam group now: each study's row is the caller institution's own or
 * received by tele, and the caller's study access policy allows it. A report written on a group is read only on these terms
 * (a caller who may read the base study but not another study of the group does not get its text).
 */
export async function studiesReadable(db: any, studyAccess: StudyAccessService, c: Caller, studies: string[]): Promise<boolean> {
  if (!studies.length) return false;
  const me = inst(c);
  const rows = await db.studyState.findMany({ where: { uid: { in: studies } }, select: { uid: true, institutionId: true, teleInstitutionId: true } });
  if (rows.length !== new Set(studies).size || rows.some((r: any) => r.institutionId == null || (r.institutionId !== me && r.teleInstitutionId !== me))) return false;
  const allowed = await studyAccess.allowed(c, studies);
  return studies.every(uid => allowed.has(uid));
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
    await this.studyAccess.require(c, [uid]);
    const state = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!state || state.institutionId !== me) throw new NotFoundException('검사를 찾을 수 없습니다');
    const [group] = await activeGroups(this.prisma, [uid]);
    if (!group || group.institutionId !== me) return { group: null };
    const uids = this.lockUids(group);
    await this.studyAccess.require(c, uids);
    const rows = await this.prisma.studyState.findMany({ where: { uid: { in: uids } } });
    const refusals = await this.dissolveRefusals(this.prisma, c, group, rows);
    return { group: this.view(group), checks: this.checks(refusals) };
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
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c, sorted, tx);
      const rows = await this.lock(tx, sorted);
      const refusals = await this.mergeRefusals(tx, c, me, sorted, rows);
      if (refusals.length) throw this.refused('합칠 수 없습니다', refusals);
      const id = randomUUID(), at = new Date();
      await tx.studyGroup.create({ data: { id, institutionId: me, kind: 'merge', baseUid, createdBy: c.actor, createdBySub: c.sub, createdAt: at } });
      const order = [baseUid, ...sorted.filter(uid => uid !== baseUid)];
      await tx.studyGroupMember.createMany({ data: order.map((uid, part) => ({ groupId: id, logicalUid: uid, studyUid: uid, part, seriesUids: [] })) });
      await this.newEpochs(tx, sorted);
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'study.merge', target: baseUid,
        detail: dump({ by: me, group: id, base: baseUid, studies: order }) } });
      return { group: { id, kind: 'merge', baseUid, members: order.map((uid, part) => ({ logicalUid: uid, studyUid: uid, part, seriesUids: [] })) } };
    }, { maxWait: 4000, timeout: 8000 });
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
    await this.studyAccess.prepare(c, uids);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c, uids, tx);
      const rows = await this.lock(tx, uids);
      // Judged on the group as it is under the lock (a concurrent Unmerge already ended it).
      const group = (await activeGroups(tx, [before.baseUid])).find(g => g.id === id);
      if (!group || JSON.stringify(this.lockUids(group)) !== JSON.stringify(uids))
        throw new ConflictException({ code: EXAM_GROUP_REFUSED, message: '검사 묶음이 바뀌었습니다. 목록을 새로고침하세요.', refusals: [] });
      if (rows.length !== uids.length || rows.some(row => row.institutionId !== me)) throw new NotFoundException('검사 묶음을 찾을 수 없습니다');
      const refusals = await this.dissolveRefusals(tx, c, group, rows);
      if (refusals.length) throw this.refused('되돌릴 수 없습니다', refusals);
      const at = new Date();
      const ended = await tx.studyGroup.updateMany({ where: { id, dissolvedAt: null }, data: { dissolvedAt: at, dissolvedBy: c.actor, dissolvedBySub: c.sub } });
      if (ended.count !== 1) throw new ConflictException({ code: EXAM_GROUP_REFUSED, message: '이미 되돌린 검사입니다. 목록을 새로고침하세요.', refusals: [] });
      await this.newEpochs(tx, uids);
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'study.unmerge',
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
    return tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid IN (${Prisma.join(uids)}) ORDER BY uid FOR UPDATE`;
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
