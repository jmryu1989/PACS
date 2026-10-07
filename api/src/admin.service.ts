import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import {
  AUDIT_CANDIDATE_ACTIONS, AUDIT_TARGET_ACTIONS, AuditCursor, AuditLogRow, AuditSource, auditMention, auditPageQuery,
  openAuditCursor, readAuditPage, sealAuditCursor,
} from './admin-audit';
import { lockMemberRights, rightsAllow } from './member-rights';
import { AuthService, lockWaitExceeded } from './auth.service';
// 역할 목록은 clinician-policy 한 곳에서 온다. 여기서 별도 literal을 두면 guard와 어긋난다.
import { APP_ROLES } from './clinician-policy';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import { Caller } from './pacs.service';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';

// 감사 기록 다음 쪽 값의 봉인 키. 프로세스마다 새로 만든다 — API가 다시 시작되면 이어받기는 만료(409)되고
// 처음부터 다시 읽는다. 키를 설정으로 두면 값이 재시작을 넘어 살아남을 이유만 생긴다.
const AUDIT_CURSOR_KEY = randomBytes(32);
function text(value: unknown, field: string, max: number, required = true): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new BadRequestException(`${field}은(는) 문자열이어야 합니다`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max)
    throw new BadRequestException(`${field} 길이가 올바르지 않습니다`);
  return normalized;
}

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private keycloak: KeycloakService,
    private studyAccess: StudyAccessService,
    private auth: AuthService,
  ) {}

  private admin(c: Caller) {
    if (!c.roles?.includes('admin')) throw new ForbiddenException('회원 관리는 admin 권한이 필요합니다');
  }

  private row(user: any) {
    return { id: user.sub, username: user.username, email: user.email, emailVerified: user.emailVerified,
      name: user.name, institution: user.institution, roles: user.roles, version: user.version,
      enabled: !user.suspended, approvalState: user.approved ? 'APPROVED' : 'PENDING' };
  }

  private async member(id: string) {
    const row = await this.prisma.memberRights.findUnique({ where: { sub: id } });
    if (!row) throw new NotFoundException('회원 권한 이관 또는 등록이 필요합니다');
    return row;
  }

  private pendingMember(user: KeycloakUser) {
    return {
      sub: user.id, username: user.username, email: user.email,
      name: [user.lastName, user.firstName].filter(Boolean).join(' ') || user.username,
      emailVerified: user.emailVerified, approved: false, suspended: false, institution: null, roles: [],
      version: null,
    };
  }

  private async register(tx: any, user: KeycloakUser) {
    const { version, ...create } = this.pendingMember(user);
    return tx.memberRights.create({ data: create });
  }

  private async managed(id: string, signal?: AbortSignal): Promise<KeycloakUser> {
    const user = await this.keycloak.getUser(id, signal);
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');
    if (user.serviceAccountClientId)
      throw new ForbiddenException('서비스 계정은 회원 관리 API로 변경할 수 없습니다');
    return user;
  }

  private audit(actor: string, action: string, target: string, detail: any) {
    return this.prisma.auditLog.create({
      data: { actor: actor || 'unknown', action, target, detail: JSON.stringify(detail) },
    });
  }

  private roles(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some(role => typeof role !== 'string'))
      throw new BadRequestException('roles는 한 개 이상의 역할 배열이어야 합니다');
    const roles = [...new Set(value.map(role => role.trim()))];
    if (roles.some(role => !APP_ROLES.has(role)))
      throw new BadRequestException('허용되지 않은 역할입니다');
    return roles;
  }

  private async institution(value: unknown): Promise<string> {
    const institution = text(value, 'institution', 128);
    const allowed = await this.keycloak.institutions();
    if (!allowed.includes(institution)) throw new BadRequestException('허용되지 않은 기관입니다');
    return institution;
  }

  async listUsers(pageValue: unknown, c: Caller) {
    this.admin(c);
    const page = pageValue == null || pageValue === '' ? 1 : Number(pageValue);
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page는 1 이상의 정수여야 합니다');
    const result = await this.keycloak.listUsers(page);
    const realmUsers = [...result.users];
    for (let other = 1; other <= Math.ceil(result.total / result.pageSize); other++) {
      if (other !== page) realmUsers.push(...(await this.keycloak.listUsers(other)).users);
    }
    const rightsRows = await this.prisma.memberRights.findMany({ where: { sub: { in: realmUsers.map(user => user.id) } } });
    const bySub = new Map(rightsRows.map(row => [row.sub, row]));
    const users = [];
    for (const user of result.users) {
      const rights = bySub.get(user.id);
      if (!rights) {
        users.push({ ...this.row(this.pendingMember(user)), rosterUnconfirmed: false });
        continue;
      }
      users.push({ ...this.row(rights), rosterUnconfirmed: await this.rosterUnconfirmed(user.id) });
    }
    const pendingCount = new Set(realmUsers.filter(user => !bySub.get(user.id)?.approved).map(user => user.id)).size;
    const response = { ...result, pendingCount, users };
    await this.audit(c.actor, 'admin.user.list', 'admin-users', {
      page, count: response.users.length, pendingCount: response.pendingCount,
    });
    return response;
  }

  private async rosterUnconfirmed(id: string, db: any = this.prisma) {
    const latest = await db.providerChange.findFirst({ where: { kind: 'credentials', sub: id }, orderBy: { id: 'desc' } });
    const unknown = await db.providerChange.findFirst({ where: { kind: 'credentials', sub: id, state: { in: ['unknown', 'void'] } } });
    const overlap = latest && await db.providerChange.findFirst({ where: {
      kind: 'credentials', sub: id, id: { lt: latest.id }, settledAt: { gte: latest.createdAt },
    } });
    // Suspend/Activate only change blocking. The existing atomic audit supplies the last roster-affecting version.
    const decision = await db.auditLog.findFirst({ where: { target: id,
      action: { in: ['admin.user.approve', 'admin.user.update', 'admin.user.unapprove'] } }, orderBy: { id: 'desc' } });
    const generation = decision ? JSON.parse(decision.detail).after.version : 0;
    return !!unknown || !!overlap || (!!latest && latest.state !== 'done') || (latest?.generation ?? 0) < generation;
  }

  async createUser(body: any, c: Caller) {
    this.admin(c);
    const username = text(body?.username, 'username', 128);
    if (username.startsWith('service-account-'))
      throw new BadRequestException('Keycloak 서비스 계정 예약 이름은 사용할 수 없습니다');
    const email = text(body?.email, 'email', 254);
    if (!email.includes('@')) throw new BadRequestException('email 형식이 올바르지 않습니다');
    const firstName = text(body?.firstName ?? body?.name, 'firstName', 128);
    const lastName = text(body?.lastName, 'lastName', 128);
    if (body?.verificationOverride !== undefined && typeof body.verificationOverride !== 'boolean')
      throw new BadRequestException('verificationOverride는 boolean이어야 합니다');
    const verificationOverride = body?.verificationOverride === true;
    if (!verificationOverride && (body?.institution !== undefined || body?.roles !== undefined))
      throw new BadRequestException('기관·역할을 함께 지정하려면 verificationOverride:true가 필요합니다');
    if (verificationOverride && (body?.institution === undefined || body?.roles === undefined))
      throw new BadRequestException('대면 확인 생성에는 institution과 roles가 모두 필요합니다');
    // Validate scope before provider creation, so invalid input cannot leave a disabled orphan.
    if (verificationOverride) {
      await this.institution(body.institution);
      this.roles(body.roles);
    }

    const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
    let created: KeycloakUser | null = null;
    try {
      created = await this.keycloak.createUser({ username, email, firstName, lastName });
      // 렐름에 default group/role이 나중에 생겨도 기본 생성은 항상 PENDING에서 시작한다.
      await this.keycloak.setGroups(created.id, []);
      await this.keycloak.setRoles(created.id, []);
      await this.keycloak.resetPassword(created.id, 'temp', temporaryPassword);
      await this.keycloak.setEnabled(created.id, true);
      let after;
      if (verificationOverride) {
        after = await this.patchUser(created.id, { institution: body.institution, roles: body.roles, verificationOverride: true, enabled: true }, c);
      } else {
        after = await this.prisma.$transaction(async tx => {
          await lockMemberRights(tx, created!.id);
          return this.row(await tx.memberRights.findUnique({ where: { sub: created!.id } })
            ?? await this.register(tx, created!));
        });
      }
      await this.audit(c.actor, 'admin.user.create', created.id, {
        before: null, after, verificationOverride,
      });
      return { ...after, temporaryPassword };
    } catch (error) {
      if (!created) throw error;
      let after: any = null;
      try { after = this.row(await this.member(created.id)); } catch {}
      await this.audit(c.actor, 'admin.user.create.failed', created.id, {
        before: null, after, verificationOverride, failed: true,
      });
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('회원 생성의 일부 처리를 완료하지 못했습니다');
    }
  }

  async patchUser(id: string, body: any, c: Caller) {
    this.admin(c);
    const existing = await this.prisma.memberRights.findUnique({ where: { sub: id } });
    const identityToRegister = existing ? null : await this.managed(id);
    const observed = existing ?? this.pendingMember(identityToRegister!);
    const before = this.row(observed);
    if (existing && body?.version !== undefined && body.version !== observed.version)
      throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean')
      throw new BadRequestException('enabled는 boolean이어야 합니다');
    if (body?.verificationOverride !== undefined && typeof body.verificationOverride !== 'boolean')
      throw new BadRequestException('verificationOverride는 boolean이어야 합니다');
    if (body?.approvalState !== undefined && !['APPROVED', 'PENDING'].includes(body.approvalState))
      throw new BadRequestException('approvalState는 APPROVED 또는 PENDING이어야 합니다');
    const approvalMutation = body?.approvalState === 'APPROVED'
      || body?.institution !== undefined || body?.roles !== undefined;
    if (body?.verificationOverride === true && !approvalMutation)
      throw new BadRequestException('verificationOverride는 승인·자격 변경에만 사용할 수 있습니다');
    if (body?.approvalState === 'PENDING' && body?.enabled !== undefined)
      throw new BadRequestException('승인 취소와 활성 상태 변경을 섞을 수 없습니다');

    if (c.sub === id) {
      if (body?.enabled === false) throw new BadRequestException('자기 자신을 정지할 수 없습니다');
      if (body?.approvalState === 'PENDING') throw new BadRequestException('자기 자신의 승인을 취소할 수 없습니다');
      if (body?.roles !== undefined && !this.roles(body.roles).includes('admin'))
        throw new BadRequestException('자기 자신의 admin 역할을 제거할 수 없습니다');
    }

    let action = 'update';
    let institution = observed.institution, roles = observed.roles;
    let approved = observed.approved, suspended = observed.suspended, emailVerified = observed.emailVerified;
    if (body?.approvalState === 'PENDING') {
      if (body?.institution !== undefined || body?.roles !== undefined)
        throw new BadRequestException('승인 취소와 기관·역할 변경을 한 요청에 섞을 수 없습니다');
      action = 'unapprove'; approved = false; suspended = true; institution = null; roles = [];
    } else if (approvalMutation) {
      action = observed.approved ? 'update' : 'approve';
      institution = await this.institution(body?.institution ?? observed.institution);
      roles = this.roles(body?.roles ?? observed.roles);
      const identity = await this.managed(id);
      emailVerified = identity.emailVerified;
      if (!emailVerified && body?.verificationOverride !== true)
        throw new BadRequestException('이메일 검증이 끝나지 않은 사용자는 승인할 수 없습니다');
      approved = true;
      if (body?.enabled !== undefined) suspended = !body.enabled;
    } else if (body?.enabled === false) {
      action = 'suspend'; suspended = true;
    } else if (body?.enabled === true) {
      action = 'activate';
      if (!rightsAllow({ ...observed, suspended: false }))
        throw new BadRequestException('승인된 회원만 활성화할 수 있습니다');
      suspended = false;
    } else throw new BadRequestException('변경할 회원 상태가 없습니다');

    try {
      const committed = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockMemberRights(tx, id);
        let version = observed.version;
        if (!existing) {
          // The absence was observed before locking. A concurrent registration is a conflict, not a CAS bypass.
          if (await tx.memberRights.findUnique({ where: { sub: id } }))
            throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
          version = (await this.register(tx, identityToRegister!)).version;
        }
        const [{ boundary }] = await tx.$queryRaw<{ boundary: Date }[]>`SELECT now() AS boundary`;
        const { count } = await tx.memberRights.updateMany({ where: { sub: id, version }, data: {
          approved, suspended, institution, roles, emailVerified,
          version: { increment: 1 }, newAuthAfter: boundary,
        } });
        if (count !== 1) throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
        // No remote end is scheduled here: this deletion cannot outlive this version's commit.
        const sessions = await tx.authSession.findMany({ where: { sub: id } });
        for (const session of sessions) {
          const deleted = await tx.authSession.deleteMany({ where: { sid: session.sid } });
          if (deleted.count !== 1) continue;
          await tx.auditLog.create({ data: { actor: observed.email || observed.username, action: 'auth.logout', target: id,
            detail: JSON.stringify({ institution: session.institution, ip: null, dataSubject: null, cause: 'isolation' }) } });
        }
        const after = this.row(await tx.memberRights.findUnique({ where: { sub: id } }));
        await tx.auditLog.create({ data: { actor: c.actor, action: `admin.user.${action}`, target: id,
          detail: JSON.stringify({ before, after, verificationOverride: body?.verificationOverride === true }) } });
        const change = approvalMutation ? await tx.providerChange.create({ data: {
          kind: 'credentials', target: id, sub: id, generation: after.version, state: 'unknown', createdAt: new Date(),
        } }) : null;
        return { after, change, rosterUnconfirmed: !!change || await this.rosterUnconfirmed(id, tx) };
      }, { maxWait: 4000, timeout: 8000 });
      if (committed.change) this.auth.publishCredentials({ id: committed.change.id, kind: 'credentials', target: id }, institution!, roles);
      return { ...committed.after, rosterUnconfirmed: committed.rosterUnconfirmed };
    } catch (error) {
      await this.audit(c.actor, 'admin.user.patch.failed', id, {
        before, after: null, verificationOverride: body?.verificationOverride === true, failed: true,
      });
      if (lockWaitExceeded(error))
        throw new ConflictException({ code: 'MEMBER_BUSY', message: '다른 요청이 회원 상태를 변경하고 있습니다. 잠시 후 다시 시도하세요' });
      throw error;
    }
  }

  async resetPassword(id: string, body: any, c: Caller) {
    this.admin(c);
    const user = await this.managed(id);
    if (!['temp', 'email'].includes(body?.mode))
      throw new BadRequestException('mode는 temp 또는 email이어야 합니다');
    const mode: 'temp' | 'email' = body.mode;
    const before = this.row(await this.member(id));
    if (mode === 'temp') {
      const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
      await this.keycloak.resetPassword(id, mode, temporaryPassword);
      const after = this.row(await this.member(id));
      await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
      return { ...after, temporaryPassword };
    }
    await this.keycloak.resetPassword(id, mode);
    const after = this.row(await this.member(id));
    await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
    return after;
  }

  /**
   * S5-U5b 관리자 감사·보안 기록(`GET /api/admin/audit`). 행의 귀속과 기관별 투영은 admin-audit.ts가 정한다: 행을 쓸 때
   * 남은 기관 값만 보고, 회원의 지금 그룹·검사의 지금 소유 기관·지금 StudyAccess로 귀속을 다시 정하지 않는다.
   * 호출자의 기관은 "누가 읽는가"를 정할 뿐이다. 기존 검사 범위 `GET /api/audit`은 바꾸지 않는다.
   *
   * 거르기는 쪽을 자르기 전이다. SQL은 계약표에 있는 action이면서 이 기관 문자열의 JSON 표기가 detail에 있거나(target이
   * 기관인 action이면 target이 이 기관인) 행만 후보로 넘기고 — 보이는 행을 빠뜨리지 않는 넓은 조건이다 — 정확한 판정은
   * readAuditPage가 한다. detail 검색은 strpos(글자 그대로의 부분 문자열)다: Prisma `contains`(LIKE 패턴)는 JSON
   * 표기의 역슬래시를 이스케이프로 먹어 `\`·`"`가 든 기관의 행을 판정 전에 놓친다(admin-audit.ts auditCandidateRow가
   * 같은 조건의 순수 쌍둥이다). 첫 쪽이 읽은 가장 큰 id를 다음 쪽 값에 봉인해 이어받는 동안의 기준으로 삼는다.
   *
   * 검사 접근이 제한된 관리자는 거절한다: 검사 행에는 오더 매칭 overlay 같은 검사 내용이 실리므로, 허용 범위 밖
   * 검사의 기록을 보이는 창이 된다(운영 지표의 ADMIN_METRICS_RESTRICTED와 같은 이유). 이것은 읽는 사람의 관문이며
   * 행의 귀속에 쓰지 않는다. AdminController는 응답 뒤 재확인 interceptor를 건너뛰므로 그 확인을 여기서 한다.
   */
  async auditEvents(query: unknown, c: Caller) {
    if (!c.roles?.includes('admin')) throw new ForbiddenException('감사 기록 조회는 admin 권한이 필요합니다');
    if (c.kind !== 'member' || !c.institution) throw new ForbiddenException('소속 기관이 없는 계정입니다');
    const me = c.institution;
    const page = auditPageQuery(query);
    if (!page) throw new BadRequestException({ code: 'ADMIN_AUDIT_QUERY_INVALID', message: '감사 기록 조회 요청 형식이 잘못되었습니다' });
    const access = await this.studyAccess.snapshot(c);
    if (access.policy.restricted)
      throw new ForbiddenException({ code: 'ADMIN_AUDIT_RESTRICTED', message: '검사 접근 범위가 제한된 계정은 감사 기록을 볼 수 없습니다' });
    const owner = [me, c.sub];
    let cursor: AuditCursor | null = null;
    if (page.after !== null) {
      cursor = openAuditCursor(AUDIT_CURSOR_KEY, owner, page.after);
      if (!cursor) throw new ConflictException({ code: 'ADMIN_AUDIT_CURSOR_EXPIRED',
        message: '이어받기 유효기간이 지났거나 서버가 다시 시작되었습니다. 처음부터 다시 조회하세요.' });
    }
    let read: { top: number; observedAt: string; rows: any[]; total: number; last: number | null };
    try {
      const top = cursor ? cursor.top
        : (await this.prisma.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? 0;
      const mention = auditMention(me);
      const candidates = Prisma.join([...AUDIT_CANDIDATE_ACTIONS]), targets = Prisma.join([...AUDIT_TARGET_ACTIONS]);
      const source: AuditSource = (below, take) => {
        const older = below === null ? Prisma.empty : Prisma.sql`AND "id" < ${below}::int`;
        return this.prisma.$queryRaw<AuditLogRow[]>`SELECT "id", "at", "actor", "action", "target", "detail" FROM "AuditLog"
          WHERE "id" <= ${top}::int ${older} AND "action" IN (${candidates})
            AND (strpos("detail", ${mention}) > 0 OR ("action" IN (${targets}) AND "target" = ${me}))
          ORDER BY "id" DESC LIMIT ${take}`;
      };
      const observedAt = new Date().toISOString();
      read = { top, observedAt, ...await readAuditPage(source, me, { after: cursor?.after ?? null, limit: page.limit }) };
    } catch (e: any) {
      // 읽기 실패는 0건이 아니다. 원인 문구(주소·SQL이 섞일 수 있다)는 싣지 않고 코드만 남긴다.
      console.warn(`[KIN API] 감사 기록 읽기 실패: ${e?.code ?? e?.name ?? 'unknown'}`);
      throw new ServiceUnavailableException({ code: 'ADMIN_AUDIT_UNAVAILABLE', message: '감사 기록을 읽지 못했습니다. 잠시 후 다시 조회하세요.' });
    }
    await this.studyAccess.unchanged(c, access);
    return {
      institutionId: me, observedAt: read.observedAt, total: read.total, rows: read.rows,
      next: read.last === null ? null : sealAuditCursor(AUDIT_CURSOR_KEY, owner, { top: read.top, after: read.last }),
    };
  }
}
