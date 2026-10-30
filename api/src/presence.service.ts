import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { Caller, inst, PacsAccess } from './pacs/access';

// One missed heartbeat is removed at the following heartbeat boundary. The
// served-browser test records both the actual cadence and disappearance delay.
export const PRESENCE_HEARTBEAT_MS = 5000;
export const PRESENCE_EXPIRES_MS = 2 * PRESENCE_HEARTBEAT_MS;

type Viewer = {
  sid: string; sessionRef: string; institution: string; user: string; name: string;
  sequence: number; lastSeen: number; studies: Map<string, number>;
};

@Injectable()
export class PresenceService {
  private readonly viewers = new Map<string, Viewer>();
  private readonly ended = new Map<string, number>();
  private readonly access: PacsAccess;

  constructor(private readonly prisma: PrismaService, private readonly studyAccess: StudyAccessService) {
    this.access = new PacsAccess(prisma, studyAccess);
  }

  endUser(sub: string) {
    this.ended.set(sub, (this.ended.get(sub) ?? 0) + 1);
    for (const [key, viewer] of this.viewers) if (viewer.user === sub) this.viewers.delete(key);
  }

  private uids(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(uid => typeof uid !== 'string' || !/^\d+(?:\.\d+)*$/.test(uid) || uid.length > 64))
      throw new BadRequestException('검사 UID 목록을 확인하세요.');
    return [...new Set(value as string[])];
  }

  private async visible(c: Caller, uids: string[]): Promise<Set<string>> {
    const institution = inst(c);
    const rows = await this.prisma.studyState.findMany({ where: { uid: { in: uids } },
      select: { uid: true, institutionId: true, teleInstitutionId: true } });
    return this.studyAccess.allowed(c, rows.filter(row => this.access.visible(row, institution)).map(row => row.uid));
  }

  async update(c: Caller, sid: string | null, sessionRef: string | null, name: string, body: any) {
    if (!sid || !sessionRef) throw new UnauthorizedException('열람 상태에는 로그인 세션이 필요합니다.');
    const institution = inst(c), generation = this.ended.get(c.sub) ?? 0;
    if (typeof body?.viewerId !== 'string' || !body.viewerId || !Number.isSafeInteger(body.sequence) || body.sequence < 0)
      throw new BadRequestException('뷰어 창과 갱신 순서를 확인하세요.');
    const uids = this.uids(body.uids), allowed = await this.visible(c, uids);
    if (uids.some(uid => !allowed.has(uid))) throw new NotFoundException('검사를 찾을 수 없습니다');
    const session = await this.prisma.authSession.findUnique({ where: { sid }, select: { sub: true } });
    if (!session || session.sub !== c.sub || generation !== (this.ended.get(c.sub) ?? 0))
      throw new UnauthorizedException('로그인 세션이 종료되었습니다.');
    const key = JSON.stringify([sessionRef, body.viewerId]), previous = this.viewers.get(key), now = Date.now();
    if (!previous || body.sequence > previous.sequence) {
      const continuing = previous && now - previous.lastSeen < PRESENCE_EXPIRES_MS;
      this.viewers.set(key, { sid, sessionRef, institution, user: c.sub, name,
        sequence: body.sequence, lastSeen: now,
        studies: new Map(uids.map(uid => [uid, continuing ? previous.studies.get(uid) ?? now : now])) });
    }
    return { heartbeatMs: PRESENCE_HEARTBEAT_MS, expiresMs: PRESENCE_EXPIRES_MS };
  }

  async read(c: Caller, requested: unknown) {
    const institution = inst(c), uids = this.uids(requested), allowed = await this.visible(c, uids);
    // Also drops sessions ended by another process (or an account administration
    // transaction), without making transient presence an access-history record.
    const sessions = await this.prisma.authSession.findMany({ where: { sid: { in: [...new Set([...this.viewers.values()].map(v => v.sid))] } }, select: { sid: true } });
    const live = new Set(sessions.map(s => s.sid)), now = Date.now();
    for (const [key, viewer] of this.viewers) {
      if (!live.has(viewer.sid)) this.viewers.delete(key);
      else if (now - viewer.lastSeen >= PRESENCE_EXPIRES_MS) viewer.studies.clear();
    }
    const studies: Record<string, { name: string; since: string }[]> = {};
    for (const uid of allowed) {
      const people = new Map<string, { name: string; since: number }>();
      for (const viewer of this.viewers.values()) {
        const since = viewer.studies.get(uid);
        if (viewer.user === c.sub || viewer.institution !== institution || since === undefined) continue;
        const person = people.get(viewer.user);
        if (!person || since < person.since) people.set(viewer.user, { name: viewer.name, since });
      }
      studies[uid] = [...people.values()].map(person => ({ name: person.name, since: new Date(person.since).toISOString() }));
    }
    return { studies, heartbeatMs: PRESENCE_HEARTBEAT_MS, expiresMs: PRESENCE_EXPIRES_MS };
  }
}
