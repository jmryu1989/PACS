import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';

/** 토큰 없이 부를 수 있는 네 진입점에만 붙인다: health, login, register, callback. */
export const Public = () => SetMetadata('public', true);

type MemberState = 'PENDING' | 'APPROVED' | 'INVALID';
const APP_ROLES = new Set(['radiologist', 'technician', 'admin']);
const KIN_ROLES = new Set([...APP_ROLES, 'gateway']);

/** 회원콘솔과 가드가 공유하는 두 축 중 승인 상태의 단일 판정표. */
export function memberState(groups: string[], roles: string[]): MemberState {
  const appRoles = (Array.isArray(roles) ? roles : []).filter(role => APP_ROLES.has(role));
  if (groups.length === 0) return 'PENDING';
  if (groups.length === 1 && appRoles.length >= 1) return 'APPROVED';
  return 'INVALID';
}

/**
 * Keycloak이 발급한 access token을 검증한다.
 *
 * 확인하는 것 네 가지 — 하나라도 빼면 검증이 아니다:
 *  1. 서명   — Keycloak의 공개키(JWKS)로. 위조 토큰을 막는다.
 *  2. iss    — 우리 렐름이 발급한 것인가. 남의 Keycloak 토큰을 막는다.
 *  3. aud    — 우리 API를 위해 발급된 것인가. 같은 Keycloak의 다른 앱 토큰을 막는다.
 *  4. exp    — jose가 자동으로 본다. 만료 토큰을 막는다.
 *
 * JWKS는 내부 주소로 가져오고 iss는 외부 주소로 검증한다. 브라우저와 API 컨테이너가
 * 같은 Keycloak을 서로 다른 이름으로 부르기 때문 (keycloak/README.md 참고).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]))
      return true;

    // 인증을 끄고 돌리는 개발 모드. compose 기본값은 켜짐이고, 끄면 로그로 경고한다.
    if (process.env.AUTH_REQUIRED === 'false') {
      req.actor = req.headers['x-kin-user'] || 'dev';
      req.sub = req.headers['x-kin-sub'] || 'dev';
      req.roles = ['radiologist', 'technician', 'admin'];
      req.kind = 'member';
      // 인증이 꺼져 있으면 기관도 헤더로 흉내낸다. 기본값을 주는 이유는
      // 이 모드가 이미 "아무나 아무거나"이기 때문 — 여기서만 기관을 비워두면
      // 진짜 경계 코드와 다른 두 번째 경로가 생긴다.
      req.institution = req.headers['x-kin-institution'] || 'hallym';
      return true;
    }

    const header = req.headers.authorization ?? '';
    let raw = header.startsWith('Bearer ') ? header.slice(7) : '';
    let method: 'bearer' | 'session' | null = raw ? 'bearer' : null;
    if (!raw) {
      const sid = this.auth.sessionId(req);
      if (sid) {
        const session = await this.auth.authenticateSession(sid, ctx.switchToHttp().getResponse());
        req.sid = sid;
        raw = session.accessToken;
        method = 'session';
      }
    }
    if (!raw) throw new UnauthorizedException('인증 정보가 없습니다');

    const payload = await this.auth.verifyAccessToken(raw);

    req.sub = payload.sub;
    req.actor = payload.email ?? payload.preferred_username ?? payload.sub;
    req.displayName = [payload.family_name, payload.given_name].filter(Boolean).join(' ')
      || payload.name || req.actor;
    req.roles = Array.isArray(payload.realm_access?.roles) ? payload.realm_access.roles : [];

    /**
     * 소속 기관. Keycloak **그룹**에서 온다 (kin-realm.json의 groups + groupMembership 매퍼).
     *
     * 왜 그룹인가: 기관은 "이 사람이 무엇을 할 수 있는가"(롤)가 아니라
     * "이 사람이 어느 조직에 속하는가"다. 롤로 흉내내면 기관이 늘어날 때마다
     * 롤이 늘고, 롤 검사 코드가 기관 목록을 알게 된다.
     *
     * 클라이언트가 정할 수 없다는 점이 중요하다 — 감사로그의 actor와 같은 이유로,
     * 기관도 **서명된 토큰**에서만 나온다. 헤더로 받으면 그건 필터가 아니라 요청이다.
     *
     * 매퍼가 full path로 넣으면 "/hallym"으로 오므로 앞의 슬래시를 떼어낸다.
    */
    const groups: string[] = (Array.isArray(payload.groups) ? payload.groups : [])
      .filter((group: unknown): group is string => typeof group === 'string')
      .map(group => group.replace(/^\//, ''));
    req.groups = groups;
    req.institution = groups.length === 1 ? groups[0] : null;
    req.authMethod = method;

    /**
     * Gateway는 회원의 특수 역할이 아니라 client-credentials 신원이다.
     * realm_access에는 Keycloak 기본 역할도 섞이므로 KIN이 관리하는 네 역할만 비교한다.
     * gw-* 또는 gateway 역할 어느 한쪽이라도 보이면 '비슷한 회원'으로 흘려보내지 않고,
     * 네 조건이 전부 맞는지 여기서 닫힌 판정을 한다.
     */
    const kinRoles = req.roles.filter((role: string) => KIN_ROLES.has(role));
    const azp = typeof payload.azp === 'string' ? payload.azp : '';
    const gatewayAdjacent = azp.startsWith('gw-') || kinRoles.includes('gateway');
    if (gatewayAdjacent) {
      const validGateway = method === 'bearer' && azp.startsWith('gw-') && groups.length === 1 &&
        kinRoles.length === 1 && kinRoles[0] === 'gateway';
      if (!validGateway)
        throw new ForbiddenException({ code: 'GATEWAY_IDENTITY_INVALID' });

      req.kind = 'gateway';
      const path = String(req.originalUrl ?? '').split('?')[0];
      const originalMethod = String(req.headers['x-original-method'] ?? '').toUpperCase();
      const gatewayApi = path.startsWith('/api/gateway/');
      const stowAuthorization = path === '/api/authz/dicom' && originalMethod === 'POST';
      if (!gatewayApi && !stowAuthorization)
        throw new ForbiddenException('게이트웨이에 허용되지 않는 경로입니다');
      return true;
    }

    req.kind = 'member';

    const state = memberState(groups, req.roles);
    req.memberState = state;
    const path = String(req.originalUrl ?? '').split('?')[0];
    const isLogout = req.method === 'POST' && path === '/api/auth/logout';
    if (state !== 'APPROVED' && !isLogout)
      throw new ForbiddenException({
        code: state === 'PENDING' ? 'INSTITUTION_PENDING' : 'INSTITUTION_INVALID',
      });

    // Bearer 호출은 CSRF 대상이 아니다. 브라우저가 자동으로 싣는 쿠키 호출만 헤더를 요구한다.
    if (method !== 'bearer' && !['GET', 'HEAD'].includes(req.method) && req.headers['x-kin-csrf'] !== '1')
      throw new ForbiddenException('X-KIN-CSRF 헤더가 필요합니다');
    return true;
  }
}
