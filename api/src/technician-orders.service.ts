/*
 * Technician Order List: Scheduled (what each of the day's orders has in the archive) and Delete Order (take an order off
 * this list with a reason, and Undo). The orders are this institution's Order rows; no authoritative hospital order feed
 * is connected (the answer's `source` says so), and nothing here cancels or changes a hospital RIS order.
 *
 * Delete Order never deletes a row: the mark (who, when, why) and an audit row are written in one transaction, and only
 * while the order is still unmatched and on the list — the same condition, in one statement, as Match's claim (which also
 * requires an order that is on the list), so a long-open screen can neither match a removed order nor remove a matched one.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { StudyAccessService } from './study-access.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { dump } from './pacs/values';
import { ORDER_RECONCILIATION_SOURCE, scheduledOrderState } from './order-reconciliation';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validOid = (oid: unknown): oid is string => typeof oid === 'string' && oid.length > 0 && oid.length <= 64 && !/[\u0000-\u001f\u007f]/.test(oid);
const queryablePatient = (id: unknown) => typeof id === 'string' && !!id.trim() && id.length <= 64 && !/[*?\\]/.test(id);
const accessionText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

/** The Delete Order reason: required text, at most 500 characters, kept trimmed. */
export function removeReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw new BadRequestException('오더를 내리는 사유를 500자 이하로 적으세요');
  return value.trim();
}

@Injectable()
export class TechnicianOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly orthanc: OrthancService,
    private readonly studyAccess: StudyAccessService) {}

  /**
   * The orders scheduled on `day` (the order's `sched` date, as the screen's local date) — or the one `oid` of that day
   * (Retry Check) — each with its archive state. Own institution, orders on the list only. As in the order list, a
   * caller with a study access policy gets only matched orders whose study it may open (an unmatched order has no study
   * to judge, and its candidates would show studies outside the policy).
   */
  async scheduled(c: Caller, query: any) {
    need(c.roles, 'technician', '예정 검사 확인');
    const me = inst(c);
    const keys = Object.keys(query ?? {});
    if (keys.some(k => k !== 'day' && k !== 'oid') || typeof query?.day !== 'string' || !DAY.test(query.day)
      || (query.oid !== undefined && !validOid(query.oid)))
      throw new BadRequestException('예정 검사 요청 형식이 잘못되었습니다 (day=YYYY-MM-DD, oid 선택)');
    const day: string = query.day;
    const access = await this.studyAccess.snapshot(c);
    const rows = await this.prisma.order.findMany({ where: { institutionId: me, removedAt: null, sched: { startsWith: day },
      ...(query.oid === undefined ? {} : { oid: query.oid }) }, orderBy: [{ sched: 'asc' }, { oid: 'asc' }] });
    const linkedUids = rows.flatMap(o => o.matched === 'M' && o.studyUid ? [o.studyUid] : []);
    const permitted = await this.studyAccess.allowed(c, linkedUids);
    const orders = rows.filter(o => o.matched === 'M' && o.studyUid ? permitted.has(o.studyUid) : !access.policy.restricted);
    const out = [];
    for (const o of orders) {
      let linked: { studyUid: string; images: number | null; failed: boolean } | null = null;
      let found: { uid: string; accession: string; images: number; desc: string }[] | null | 'unqueryable' | 'unregistered' = [];
      if (o.matched === 'M' && o.studyUid) {
        try {
          const counts = await this.orthanc.studyInstanceCounts([o.studyUid]);
          linked = { studyUid: o.studyUid, images: counts.has(o.studyUid) ? counts.get(o.studyUid)! : null, failed: false };
        } catch { linked = { studyUid: o.studyUid, images: null, failed: true }; }
      } else {
        // The order's date is its own sched date (the day asked for); a patient ID that cannot be looked up is not "no images".
        if (!queryablePatient(o.patientId) || !DAY.test(String(o.sched).slice(0, 10))) found = 'unqueryable';
        else try { found = await this.candidates(me, access, o.patientId, String(o.sched).slice(0, 10).replace(/-/g, '')); } catch { found = null; }
      }
      const entry = scheduledOrderState({ accession: o.accession }, linked, found);
      out.push({ oid: o.oid, sched: o.sched, id: o.patientId, name: o.name, modality: o.modality, desc: o.descr,
        accession: accessionText(o.accession), matched: o.matched, ...entry });
    }
    // The access answer this read was judged on is still the caller's (a policy change during it refuses the whole answer).
    await this.studyAccess.unchanged(c, access);
    return { source: ORDER_RECONCILIATION_SOURCE, day, orders: out };
  }

  /**
   * Same patient, same study date, this institution's unmatched studies in the caller's access scope. A study the archive
   * answers that the worklist has not registered yet (no StudyState: owner and match state unknown) leaves the order
   * 'unregistered' when no candidate was found, never "no images".
   */
  private async candidates(me: string, access: any, patientId: string, studyDate: string) {
    const rows = await this.orthanc.patientStudiesOnDate(patientId, studyDate);
    if (!rows.length) return [];
    const uid = (row: any) => OrthancService.tag(row, '0020000D');
    const states = await this.prisma.studyState.findMany({ where: { uid: { in: rows.map(uid) } },
      select: { uid: true, institutionId: true, matched: true, orderOid: true } });
    const own = new Map(states.filter(s => s.institutionId === me && s.matched === 'U' && s.orderOid == null).map(s => [s.uid, s]));
    const seen = new Set<string>();
    const out = [];
    let unregistered = false;
    const known = new Set(states.map(s => s.uid));
    for (const row of rows) {
      const u = uid(row);
      // A UID two archive resources answer has no single accession or count: the lookup is incomplete, not "no images".
      if (seen.has(u)) throw new Error('split study UID');
      seen.add(u);
      if (!known.has(u)) { unregistered = true; continue; }
      if (!own.has(u) || !this.studyAccess.matches(access, u, row)) continue;
      out.push({ uid: u, accession: OrthancService.tag(row, '00080050'), images: Number(row['00201208']?.Value?.[0] ?? 0),
        desc: OrthancService.tag(row, '00081030') });
    }
    return !out.length && unregistered ? 'unregistered' as const : out;
  }

  /** Delete Order: take an unmatched order off the list (mark + audit, one transaction). */
  async remove(c: Caller, oid: string, body: any) {
    need(c.roles, 'technician', '오더 삭제');
    const me = inst(c);
    if (!validOid(oid)) throw new NotFoundException('오더를 찾을 수 없습니다');
    const reason = removeReason(body?.reason);
    return this.prisma.$transaction(async tx => {
      // An unmatched order is not listed to a caller with a study access policy, so it cannot be removed by one either. The
      // policy is read under its shared lock in this transaction: a restriction committed meanwhile waits or is seen here.
      if ((await this.studyAccess.snapshot(c, tx)).policy.restricted) throw new NotFoundException('오더를 찾을 수 없습니다');
      const at = new Date();
      const taken = await tx.order.updateMany({ where: { oid, institutionId: me, matched: 'U', studyUid: null, removedAt: null },
        data: { removedAt: at, removedBySub: c.sub, removedBy: c.actor, removeReason: reason } });
      if (taken.count !== 1) {
        const order = await tx.order.findUnique({ where: { oid } });
        if (!order || order.institutionId !== me) throw new NotFoundException('오더를 찾을 수 없습니다');
        if (order.removedAt) throw new ConflictException('이미 목록에서 내린 오더입니다. 오더 목록을 새로고침하세요.');
        throw new ConflictException('매칭된 오더는 지울 수 없습니다. 먼저 Unmatch 하세요.');
      }
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'order.remove', target: oid, detail: dump({ reason, by: me }) } });
      return { oid, removed: true, removedAt: at.toISOString() };
    }, { maxWait: 4000, timeout: 8000 });
  }

  /** Undo of Delete Order: the order comes back to the list (mark cleared; the audit log keeps both rows). */
  async restore(c: Caller, oid: string) {
    need(c.roles, 'technician', '오더 되돌리기');
    const me = inst(c);
    if (!validOid(oid)) throw new NotFoundException('오더를 찾을 수 없습니다');
    return this.prisma.$transaction(async tx => {
      if ((await this.studyAccess.snapshot(c, tx)).policy.restricted) throw new NotFoundException('오더를 찾을 수 없습니다');
      const back = await tx.order.updateMany({ where: { oid, institutionId: me, removedAt: { not: null } },
        data: { removedAt: null, removedBySub: null, removedBy: null, removeReason: null } });
      if (back.count !== 1) {
        const order = await tx.order.findUnique({ where: { oid } });
        if (!order || order.institutionId !== me) throw new NotFoundException('오더를 찾을 수 없습니다');
        throw new ConflictException('목록에 있는 오더입니다. 오더 목록을 새로고침하세요.');
      }
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'order.restore', target: oid, detail: dump({ by: me }) } });
      return { oid, removed: false };
    }, { maxWait: 4000, timeout: 8000 });
  }
}
