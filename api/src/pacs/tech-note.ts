/*
 * Tech 메모 판(REQ-D01-TECH-NOTE). 권한 → 검사 잠금 → 시도 ID → 판 번호 순서로 보고, 판과 감사는 한 트랜잭션이다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { noteTransactionError } from './values';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';

const NOTE_PUBLIC_FIELDS = { studyUid: true, version: true, text: true, reason: true, author: true, createdAt: true } as const;
// S8-CTX: what a read needs to tell a caller whether a revision is the caller's own attempt. authorSub stays inside.
const NOTE_READ_FIELDS = { ...NOTE_PUBLIC_FIELDS, attemptId: true, authorSub: true } as const;
/** A revision as answered: the attempt id it was written by (NULL for older revisions) and, computed here, whether
 *  that attempt was the caller's. A revision without an id is nobody's attempt, whoever wrote it. */
function noteForCaller(row: any, c: Caller) {
  if (!row) return null;
  const { authorSub, attemptId, ...note } = row;
  return { ...note, attemptId: attemptId ?? null, isOwnAttempt: !!attemptId && authorSub === c.sub };
}

export class PacsTechNote {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess) {}

  // ══════════════════ 조회 ══════════════════

  // REQ-D01-TECH-NOTE -> RISK-D01-NOTE-IDENTITY/HISTORY -> TEST-D01-TECH-NOTE.
  // The parent lock serializes note revisions with transfer cancellation/deletion.
  private async noteScope(tx: any, uid: string, c: Caller, writing: boolean) {
    if (typeof uid !== 'string' || uid.length > 64 || !/^\d+(?:\.\d+)+$/.test(uid))
      throw new BadRequestException('검사 UID를 확인하세요');
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용입니다');
    need(c.roles, writing ? 'technician' : c.roles.includes('technician') ? 'technician' : 'radiologist', 'Tech 메모');
    const me = inst(c);
    await this.studyAccess.snapshot(c,tx);
    const rows = writing
      ? await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR SHARE`;
    const study = rows[0];
    if (!study || !this.access.visible(study, me)) throw new NotFoundException('검사를 찾을 수 없습니다');
    await this.studyAccess.require(c,[uid],tx);
    if (writing && study.institutionId !== me) throw new ForbiddenException('촬영 기관에서만 Tech 메모를 작성할 수 있습니다');
    return study;
  }

  async techNote(uid: string, c: Caller, before?: string) {
    if (before !== undefined && (!/^[1-9]\d{0,9}$/.test(before) || Number(before) > 2147483647))
      throw new BadRequestException('이력 위치를 확인하세요');
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      const study = await this.noteScope(tx, uid, c, false);
      const writable = study.institutionId === c.institution && (c.roles.includes('technician') || c.roles.includes('admin'));
      if (before !== undefined) {
        const items = await tx.techNoteRevision.findMany({ where: { studyUid: uid, version: { lt: Number(before) } }, orderBy: { version: 'desc' }, take: 51, select: NOTE_READ_FIELDS });
        const more = items.length > 50; if (more) items.pop();
        return { uid, items: items.map(item => noteForCaller(item, c)), nextBefore: more ? items[items.length - 1].version : null };
      }
      const note = await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, orderBy: { version: 'desc' }, select: NOTE_READ_FIELDS });
      return { uid, note: noteForCaller(note, c), writable };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch(noteTransactionError);
  }

  /**
   * One Tech Note revision (REQ-D01-TECH-NOTE; S8-CTX save attempts, REQ-S8-CTX-NOTE -> RISK-CTX-NOTE-OUTCOME).
   * `attemptId` (checked as a UUID by the controller) names the screen's attempt. The same attempt sent again - same
   * study, author, institution, base version, text and normalised reason - answers the revision it already wrote and
   * writes neither a revision nor an audit row (the first write's audit row is the record of that one addition). The id
   * used for any other request is refused without showing the earlier revision. Without an id (an older screen) the
   * write behaves as before. The id lookup runs after the permission, institution and study-lock checks and before the
   * version check, in the same transaction as the revision and its audit row.
   */
  async saveTechNote(uid: string, body: any, c: Caller) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['baseVersion', 'text', 'reason', 'attemptId'].includes(k)) ||
        !Number.isInteger(body.baseVersion) || body.baseVersion < 0 || body.baseVersion >= 2147483646 ||
        typeof body.text !== 'string' || body.text.length > 10000 || body.text.includes('\0') ||
        typeof body.reason !== 'string' || body.reason.length > 1000 || body.reason.includes('\0') ||
        body.attemptId !== undefined && typeof body.attemptId !== 'string')
      throw new BadRequestException('메모·수정 사유·기준 버전을 확인하세요');
    if (/[\uD800-\uDFFF]/u.test(body.text) || /[\uD800-\uDFFF]/u.test(body.reason))
      throw new BadRequestException('잘못된 문자 인코딩입니다');
    const attemptId: string | null = body.attemptId ?? null, reason = body.reason.trim();
    const reused = () => new BadRequestException('이 저장 시도 ID는 다른 요청에 이미 사용되었습니다. 메모를 다시 확인하세요');
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.noteScope(tx, uid, c, true);
      if (attemptId) {
        const sent = await tx.techNoteRevision.findUnique({ where: { attemptId }, select: { ...NOTE_READ_FIELDS, institutionId: true } });
        if (sent) {
          if (sent.studyUid !== uid || sent.authorSub !== c.sub || sent.institutionId !== inst(c) || sent.version !== body.baseVersion + 1 ||
              sent.text !== body.text || sent.reason !== reason) throw reused();
          const { institutionId, ...receipt } = sent;
          const latest = await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, orderBy: { version: 'desc' }, select: NOTE_READ_FIELDS });
          return { uid, note: noteForCaller(receipt, c), latestNote: noteForCaller(latest, c), writable: true };
        }
      }
      const prev = await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, orderBy: { version: 'desc' } });
      if ((prev?.version ?? 0) !== body.baseVersion) throw new ConflictException('메모가 변경되었습니다. 이력을 확인한 뒤 다시 작성하세요');
      if (prev && !reason) throw new BadRequestException('수정·비우기에는 사유가 필요합니다');
      if (!prev && !body.text.trim()) throw new BadRequestException('메모 내용을 입력하세요');
      if (prev?.text === body.text) throw new BadRequestException('변경된 내용이 없습니다');
      const note = noteForCaller(await tx.techNoteRevision.create({ data: { studyUid: uid, version: body.baseVersion + 1,
        text: body.text, reason, author: c.actor, authorSub: c.sub, institutionId: inst(c), attemptId }, select: NOTE_READ_FIELDS }), c);
      await tx.auditLog.create({ data: { actor: c.actor, action: 'tech-note.revise', target: uid,
        detail: JSON.stringify({ version: note.version, institutionId: c.institution, attemptId }) } });
      return { uid, note, latestNote: note, writable: true };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch(error => {
      // Two studies cannot both keep one id: the second insert waits for the first and then violates the unique index.
      // That is the id reused for a different request (400), never a server fault (500).
      if (attemptId && error?.code === 'P2002' && [].concat(error.meta?.target ?? []).some((t: any) => String(t).includes('attemptId'))) throw reused();
      return noteTransactionError(error);
    });
  }
}
