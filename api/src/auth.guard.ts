import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** 이 엔드포인트는 토큰 없이 부를 수 있다 (health 확인용) */
export const Public = () => SetMetadata('public', true);

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
  private jwks = process.env.KC_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.KC_JWKS_URL))
    : null;

  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]))
      return true;

    // 인증을 끄고 돌리는 개발 모드. compose 기본값은 켜짐이고, 끄면 로그로 경고한다.
    if (process.env.AUTH_REQUIRED === 'false') {
      req.actor = req.headers['x-kin-user'] || 'dev';
      req.roles = ['radiologist', 'technician', 'admin'];
      return true;
    }

    if (!this.jwks) throw new UnauthorizedException('서버에 KC_JWKS_URL이 설정되지 않았습니다');

    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer '))
      throw new UnauthorizedException('Authorization 헤더가 없습니다');

    let payload: any;
    try {
      ({ payload } = await jwtVerify(header.slice(7), this.jwks, {
        issuer: process.env.KC_ISSUER,
        audience: process.env.KC_AUDIENCE ?? 'kin-api',
      }));
    } catch (e: any) {
      throw new UnauthorizedException('토큰 검증 실패: ' + e.message);
    }

    req.actor = payload.email ?? payload.preferred_username ?? payload.sub;
    req.roles = payload.realm_access?.roles ?? [];
    return true;
  }
}
