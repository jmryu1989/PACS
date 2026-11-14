import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { canReadPreliminary } from './preliminary-reader';
import { Caller } from './pacs.service';
import { canonical, viewerJson, viewerUid } from './viewer-input';
import { validateCellCamera, validateCellProperties } from './viewer-job-input';
import { snapshotText } from './viewer-job-snapshot';
import { displayRule } from './hanging-protocol';

/**
 * Auto Save View: the reader's own last view of a study, kept automatically while the account setting is on and put back
 * when the study is opened again. One row per reader and study, overwritten by each save. It is not a Job: it is never
 * listed with the Jobs and has no title, history or print. The view names original images (study, series, SOP, frame),
 * each cell's camera and window, and the cell's display rule; it carries no marks and no clinical text.
 */
const deny = (): never => { throw new ForbiddenException('저장된 보기에 접근할 수 없습니다'); };
const invalid = (): never => { throw new BadRequestException('저장할 보기의 형식이 올바르지 않습니다'); };
const allowed = (s: any, c: Caller) => !!s && !!c.institution && typeof s.rs === 'string' &&
  (s.institutionId === c.institution || s.teleInstitutionId === c.institution) && canReadPreliminary(s, c);
const CELL_KEYS = ['study', 'series', 'sop', 'frame', 'index', 'zoom', 'camera', 'properties', 'display'];
const exact = (x: any, names: string[]) => !!x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).length === names.length && Object.keys(x).every(k => names.includes(k));
const count = (x: any, min: number, max: number) => Number.isInteger(x) && x >= min && x <= max;
const WRITER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, WRITERS = 32;
/** The order of a save or a Discard: the viewer's id, its count and when it was taken (ms). */
function order(body: any): { writer: string; seq: number; at: number } {
  if (typeof body.writer !== 'string' || !WRITER.test(body.writer) || !count(body.seq, 1, 2147483647) || !count(body.at, 1, 8640000000000000)) invalid();
  return { writer: body.writer, seq: body.seq, at: body.at };
}
/** The last count written for a viewer (0 when none): the row keeps [[writer, seq], …], the latest last. */
const seen = (writers: any, writer: string): number => (Array.isArray(writers) ? writers.find(w => Array.isArray(w) && w[0] === writer)?.[1] : 0) ?? 0;
const noted = (writers: any, writer: string, seq: number) =>
  [...(Array.isArray(writers) ? writers.filter(w => Array.isArray(w) && w[0] !== writer) : []), [writer, seq]].slice(-WRITERS);

/** The saved view of a study, checked the same way when it is written and when it is read back. */
export function autoViewSnapshot(s: any, uid: string): any {
  if (!exact(s, ['version', 'studies', 'rows', 'cols', 'active', 'cells']) || s.version !== 1) invalid();
  if (!Array.isArray(s.studies) || s.studies.length < 1 || s.studies.length > 8 || new Set(s.studies).size !== s.studies.length || s.studies[0] !== uid) invalid();
  s.studies.forEach(viewerUid);
  if (!count(s.rows, 1, 4) || !count(s.cols, 1, 4) || !Array.isArray(s.cells) || s.cells.length !== s.rows * s.cols ||
      s.cells.every(c => c === null) || !count(s.active, 0, s.cells.length - 1)) invalid();
  for (const c of s.cells) {
    if (c === null) continue;
    if (!exact(c, CELL_KEYS) || !s.studies.includes(c.study)) invalid();
    viewerUid(c.series); viewerUid(c.sop);
    if (!count(c.frame, 1, 100000) || !count(c.index, 0, 100000) || typeof c.zoom !== 'number' || !Number.isFinite(c.zoom) || c.zoom <= 0 || c.zoom > 10000) invalid();
    validateCellCamera(c.camera); validateCellProperties(c.properties, true);
    // The rule is checked as the Hanging Protocol's cell rules are (a plain copy: the request parser's objects have no prototype).
    if (c.display !== null && (typeof c.display !== 'object' || !displayRule(JSON.parse(JSON.stringify(c.display))))) invalid();
  }
  if (Buffer.byteLength(canonical(s)) > 30000) invalid();
  return s;
}

const summary = (row: any) => ({ revision: row.revision, savedAt: row.updatedAt.toISOString() });

@Injectable()
export class ViewerAutoViewService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService) {}
  private member(c: Caller) { if (c.kind !== 'member' || !c.sub || !c.institution) deny(); }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return work(tx);
      }, { isolationLevel: read ? 'RepeatableRead' : 'ReadCommitted', maxWait: 4000, timeout: 8000 });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && (['P2002', 'P2034', 'P2028'].includes(e.code) ||
          e.code === 'P2010' && ['55P03', '57014'].includes(String(e.meta?.code)))) throw new ServiceUnavailableException('보기를 저장하지 못했습니다. 잠시 뒤 다시 시도합니다');
      throw e;
    }
  }
  /** Every study the view names is one this caller reads now. */
  private async studies(tx: any, uids: string[], c: Caller) {
    await this.studyAccess.snapshot(c, tx);
    const rows = await tx.studyState.findMany({ where: { uid: { in: uids } } });
    if (rows.length !== uids.length || rows.some(s => !allowed(s, c))) deny();
    await this.studyAccess.require(c, uids, tx);
  }
  private where(uid: string, c: Caller) { return { authorSub_studyUid: { authorSub: c.sub, studyUid: uid } }; }

  async read(uid: string, c: Caller) {
    this.member(c); viewerUid(uid); await this.studyAccess.prepare(c);
    return this.transaction(async tx => {
      await this.studies(tx, [uid], c);
      const row = await tx.viewerAutoView.findUnique({ where: this.where(uid, c) });
      if (!row || row.snapshot === null) return { view: null };
      // A stored view that no longer reads as one, or that names a study this caller no longer reads, is not given out.
      let snapshot: any;
      try { snapshot = autoViewSnapshot(JSON.parse(row.snapshot), uid); } catch { return { view: null }; }
      const others = snapshot.studies.filter(s => s !== uid);
      if (others.length) {
        const rows = await tx.studyState.findMany({ where: { uid: { in: others } } });
        const permitted = await this.studyAccess.allowed(c, others, tx);
        if (rows.length !== others.length || rows.some(s => !allowed(s, c) || !permitted.has(s.uid))) return { view: null };
      }
      return { view: { snapshot, ...summary(row) } };
    }, true);
  }

  /**
   * Writes over the caller's view of the study. `writer` names the viewer that sends it, `seq` counts that viewer's saves
   * and `at` is when it was taken (the viewer's clock, ms). A save writes nothing when the same viewer's save with that
   * count or a later one was written already (whatever other viewers wrote meanwhile: each viewer's last count is kept,
   * the 32 latest viewers), or when it was taken before the last Discard Saved View of this study.
   */
  async save(uid: string, raw: Buffer, c: Caller) {
    this.member(c); viewerUid(uid);
    const body = viewerJson(raw);
    if (!exact(body, ['snapshot', 'writer', 'seq', 'at'])) invalid();
    const { writer, seq, at } = order(body);
    const snapshot = autoViewSnapshot(body.snapshot, uid), text = snapshotText(snapshot);
    await this.studyAccess.prepare(c);
    return this.transaction(async tx => {
      await this.studies(tx, snapshot.studies, c);
      return this.write(tx, uid, c, row => {
        if (row && (seen(row.writers, writer) >= seq || (row.discardedAt !== null && at <= Number(row.discardedAt)))) return null;
        return { studies: snapshot.studies, snapshot: text, writers: noted(row?.writers, writer, seq) };
      });
    });
  }

  /**
   * Discard Saved View: the view is gone for this caller, and the row stays behind it (snapshot null) so that a save taken
   * before the Discard that arrives after it is refused: the boundary is when the Discard was taken (`at`, never later
   * than the server's own clock) and the discarding viewer's count.
   */
  async discard(uid: string, raw: Buffer, c: Caller) {
    this.member(c); viewerUid(uid);
    const body = viewerJson(raw);
    if (!exact(body, ['writer', 'seq', 'at'])) invalid();
    const { writer, seq, at } = order(body);
    await this.studyAccess.prepare(c);
    return this.transaction(async tx => {
      await this.studies(tx, [uid], c);
      let had = false;
      await this.write(tx, uid, c, row => {
        had = !!row && row.snapshot !== null;
        const boundary = Math.max(row?.discardedAt === null || row?.discardedAt === undefined ? 0 : Number(row.discardedAt), Math.min(at, Date.now()));
        return { studies: [uid], snapshot: null, discardedAt: BigInt(boundary), writers: noted(row?.writers, writer, Math.max(seq, seen(row?.writers, writer))) };
      });
      return { discarded: had };
    });
  }

  /** Reads the row, asks `next` for what to write (null: nothing), and writes it if the row is still the one read. */
  private async write(tx: any, uid: string, c: Caller, next: (row: any) => any) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await tx.viewerAutoView.findUnique({ where: this.where(uid, c) });
      const data = next(row);
      if (!data) return { saved: false, ...summary(row) };
      const updatedAt = new Date();
      if (row) {
        const { count } = await tx.viewerAutoView.updateMany({ where: { id: row.id, revision: row.revision }, data: { ...data, revision: row.revision + 1, updatedAt } });
        if (count) return { saved: true, revision: row.revision + 1, savedAt: updatedAt.toISOString() };
      } else {
        const { count } = await tx.viewerAutoView.createMany({ skipDuplicates: true,
          data: [{ id: randomUUID(), studyUid: uid, authorSub: c.sub, institutionId: c.institution as string, discardedAt: null, ...data, revision: 1, updatedAt }] });
        if (count) return { saved: true, revision: 1, savedAt: updatedAt.toISOString() };
      }
    }
    throw new ServiceUnavailableException('보기를 저장하지 못했습니다. 잠시 뒤 다시 시도합니다');
  }
}