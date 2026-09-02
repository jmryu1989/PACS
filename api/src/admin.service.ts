import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { memberState } from './auth.guard';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import { Caller } from './pacs.service';
import { PrismaService } from './prisma.service';

const APP_ROLES = new Set(['radiologist', 'technician', 'admin']);

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
  ) {}

  private admin(c: Caller) {
    if (!c.roles?.includes('admin')) throw new ForbiddenException('회원 관리는 admin 권한이 필요합니다');
  }

  private row(user: KeycloakUser) {
    const roles = user.roles.filter(role => APP_ROLES.has(role)).sort();
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      name: [user.lastName, user.firstName].filter(Boolean).join('') || user.username,
      institution: user.groups.length === 1 ? user.groups[0] : null,
      roles,
      enabled: user.enabled,
      approvalState: memberState(user.groups, roles),
    };
  }

  private async managed(id: string): Promise<KeycloakUser> {
    const user = await this.keycloak.getUser(id);
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

  /**
   * KC 변경은 트랜잭션이 아니므로 자격을 건드리기 전에 이 순서를 끝까지 통과해야 한다.
   * disabled만으로 기존 JWT는 죽지 않는다. DB 세션 0건과 KC logout까지가 한 장벽이다.
   */
  private async isolate(id: string): Promise<void> {
    await this.keycloak.setEnabled(id, false);
    await this.prisma.authSession.deleteMany({ where: { sub: id } });
    const remaining = await this.prisma.authSession.count({ where: { sub: id } });
    if (remaining !== 0) throw new Error('AuthSession 격리 확인 실패');
    await this.keycloak.logoutUser(id);
  }

  private async isolatedConflict(id: string): Promise<never> {
    let user: any = null;
    try {
      const current = await this.keycloak.getUser(id);
      if (current && !current.serviceAccountClientId) user = this.row(current);
    } catch {}
    throw new ConflictException({
      code: 'USER_ISOLATED',
      message: '사용자를 비활성 격리했지만 변경을 완료하지 못했습니다. 현재 상태를 확인해 재시도하세요.',
      user,
    });
  }

  /**
   * POST 생성의 대면 확인과 PATCH 승인이 반드시 이 함수 하나를 지난다.
   * 이메일 검증 예외를 다른 경로에 복사하면 어느 한쪽이 조용한 우회로가 된다.
   */
  private async approve(
    id: string,
    institutionValue: unknown,
    rolesValue: unknown,
    verificationOverride: boolean,
    targetEnabled: boolean,
  ) {
    const institution = await this.institution(institutionValue);
    const roles = this.roles(rolesValue);
    const before = await this.managed(id);
    if (!before.emailVerified && !verificationOverride)
      throw new BadRequestException('이메일 검증이 끝나지 않은 사용자는 승인할 수 없습니다');
    try {
      await this.isolate(id);
      await this.keycloak.setGroups(id, [institution]);
      await this.keycloak.setRoles(id, roles);
      const changed = await this.managed(id);
      if (memberState(changed.groups, changed.roles) !== 'APPROVED')
        throw new Error('승인 상태 재검증 실패');
      if (targetEnabled) await this.keycloak.setEnabled(id, true);
      return this.row(await this.managed(id));
    } catch {
      return this.isolatedConflict(id);
    }
  }

  private async cancelApproval(id: string) {
    try {
      await this.isolate(id);
      await this.keycloak.setGroups(id, []);
      await this.keycloak.setRoles(id, []);
      const changed = await this.managed(id);
      if (memberState(changed.groups, changed.roles) !== 'PENDING')
        throw new Error('대기 상태 재검증 실패');
      // BFF는 PENDING 세션을 허용해 승인 대기 안내를 보여 준다.
      await this.keycloak.setEnabled(id, true);
      return this.row(await this.managed(id));
    } catch {
      return this.isolatedConflict(id);
    }
  }

  async listUsers(pageValue: unknown, c: Caller) {
    this.admin(c);
    const page = pageValue == null || pageValue === '' ? 1 : Number(pageValue);
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page는 1 이상의 정수여야 합니다');
    const result = await this.keycloak.listUsers(page);
    const response = { ...result, users: result.users.map(user => this.row(user)) };
    await this.audit(c.actor, 'admin.user.list', 'admin-users', {
      page, count: response.users.length, pendingCount: response.pendingCount,
    });
    return response;
  }

  async createUser(body: any, c: Caller) {
    this.admin(c);
    const username = text(body?.username, 'username', 128);
    if (username.startsWith('service-account-'))
      throw new BadRequestException('Keycloak 서비스 계정 예약 이름은 사용할 수 없습니다');
    const email = text(body?.email, 'email', 254);
    if (!email.includes('@')) throw new BadRequestException('email 형식이 올바르지 않습니다');
    const firstName = text(body?.firstName ?? body?.name, 'name', 128, false);
    const lastName = text(body?.lastName, 'lastName', 128, false);
    if (body?.verificationOverride !== undefined && typeof body.verificationOverride !== 'boolean')
      throw new BadRequestException('verificationOverride는 boolean이어야 합니다');
    const verificationOverride = body?.verificationOverride === true;
    if (!verificationOverride && (body?.institution !== undefined || body?.roles !== undefined))
      throw new BadRequestException('기관·역할을 함께 지정하려면 verificationOverride:true가 필요합니다');
    if (verificationOverride && (body?.institution === undefined || body?.roles === undefined))
      throw new BadRequestException('대면 확인 생성에는 institution과 roles가 모두 필요합니다');

    const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
    let created: KeycloakUser | null = null;
    try {
      created = await this.keycloak.createUser({ username, email, firstName, lastName });
      // 렐름에 default group/role이 나중에 생겨도 기본 생성은 항상 PENDING에서 시작한다.
      await this.keycloak.setGroups(created.id, []);
      await this.keycloak.setRoles(created.id, []);
      await this.keycloak.resetPassword(created.id, 'temp', temporaryPassword);
      let after;
      if (verificationOverride) {
        after = await this.approve(created.id, body.institution, body.roles, true, true);
      } else {
        await this.keycloak.setEnabled(created.id, true);
        after = this.row(await this.managed(created.id));
      }
      await this.audit(c.actor, 'admin.user.create', created.id, {
        before: null, after, verificationOverride,
      });
      return { ...after, temporaryPassword };
    } catch (error) {
      if (!created) throw error;
      let after: any = null;
      try { after = this.row(await this.managed(created.id)); } catch {}
      await this.audit(c.actor, 'admin.user.create.failed', created.id, {
        before: null, after, verificationOverride, failed: true,
      });
      if (error instanceof ConflictException) throw error;
      return this.isolatedConflict(created.id);
    }
  }

  async patchUser(id: string, body: any, c: Caller) {
    this.admin(c);
    const beforeUser = await this.managed(id);
    const before = this.row(beforeUser);
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
      throw new BadRequestException('승인 취소는 대기 안내를 위해 enabled=true로 끝납니다');

    if (c.sub === id) {
      if (body?.enabled === false) throw new BadRequestException('자기 자신을 정지할 수 없습니다');
      if (body?.approvalState === 'PENDING') throw new BadRequestException('자기 자신의 승인을 취소할 수 없습니다');
      if (body?.roles !== undefined && !this.roles(body.roles).includes('admin'))
        throw new BadRequestException('자기 자신의 admin 역할을 제거할 수 없습니다');
    }

    let action = 'update';
    let after;
    try {
      if (body?.approvalState === 'PENDING') {
        if (body?.institution !== undefined || body?.roles !== undefined)
          throw new BadRequestException('승인 취소와 기관·역할 변경을 한 요청에 섞을 수 없습니다');
        action = 'unapprove';
        after = await this.cancelApproval(id);
      } else if (approvalMutation) {
        action = before.approvalState === 'PENDING' ? 'approve' : 'update';
        const institution = body?.institution ?? before.institution;
        const roles = body?.roles ?? before.roles;
        const targetEnabled = body?.enabled === undefined ? before.enabled : body.enabled;
        after = await this.approve(
          id, institution, roles, body?.verificationOverride === true, targetEnabled,
        );
      } else if (body?.enabled === false) {
        action = 'suspend';
        try {
          await this.isolate(id);
          after = this.row(await this.managed(id));
        } catch {
          await this.isolatedConflict(id);
        }
      } else if (body?.enabled === true) {
        action = 'activate';
        if (before.approvalState === 'INVALID')
          throw new BadRequestException('INVALID 사용자는 자격을 바로잡기 전 활성화할 수 없습니다');
        try {
          await this.keycloak.setEnabled(id, true);
          after = this.row(await this.managed(id));
        } catch {
          await this.isolatedConflict(id);
        }
      } else {
        throw new BadRequestException('변경할 회원 상태가 없습니다');
      }
      await this.audit(c.actor, `admin.user.${action}`, id, {
        before, after, verificationOverride: body?.verificationOverride === true,
      });
      return after;
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      let current: any = null;
      try { current = this.row(await this.managed(id)); } catch {}
      await this.audit(c.actor, 'admin.user.patch.failed', id, {
        before, after: current, verificationOverride: body?.verificationOverride === true, failed: true,
      });
      throw error;
    }
  }

  async resetPassword(id: string, body: any, c: Caller) {
    this.admin(c);
    const user = await this.managed(id);
    if (!['temp', 'email'].includes(body?.mode))
      throw new BadRequestException('mode는 temp 또는 email이어야 합니다');
    const mode: 'temp' | 'email' = body.mode;
    const before = this.row(user);
    if (mode === 'temp') {
      const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
      await this.keycloak.resetPassword(id, mode, temporaryPassword);
      const after = this.row(await this.managed(id));
      await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
      return { ...after, temporaryPassword };
    }
    await this.keycloak.resetPassword(id, mode);
    const after = this.row(await this.managed(id));
    await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
    return after;
  }
}
