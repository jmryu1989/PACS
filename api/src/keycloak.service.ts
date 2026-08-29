import { Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * Keycloak Admin API 클라이언트 — "우리 기관의 판독의가 누구인가"를 묻기 위한 것.
 *
 * 왜 필요한가: Preliminary(RS=P)는 상급 판독의를 **지정**하는 기능이고, 지정된 사람만
 * 판독문을 볼 수 있다. 지정을 자유 입력으로 받으면 오타 하나에 아무도 못 보는 판독문이
 * 생긴다. 접근 권한을 좌우하는 값을 사람이 타이핑하게 두면 안 된다.
 *
 * 사용자 목록은 이미 Keycloak에 있다. 우리 DB에 복사본을 두면 두 곳이 어긋난다
 * (인계문서 §8의 "상태를 두 곳에 두면 반드시 어긋난다"가 사용자에도 그대로 적용된다).
 * 그래서 물어본다.
 *
 * 이 클라이언트는 **서비스 계정**으로 인증한다. 사용자의 토큰을 빌려 쓰지 않는다 —
 * 판독의에게 사용자 조회 권한을 줄 이유가 없기 때문. 서버가 서버 자격으로 묻는다.
 */
@Injectable()
export class KeycloakService {
  private base = (process.env.KC_ADMIN_URL ?? 'http://keycloak:8080').replace(/\/$/, '');
  private realm = process.env.KC_REALM ?? 'kin';
  private clientId = process.env.KC_CLIENT_ID ?? 'kin-api';
  private secret = process.env.KC_CLIENT_SECRET ?? '';

  private token: { value: string; exp: number } | null = null;
  /** 기관별 판독의 목록 캐시. 사람은 자주 안 바뀌므로 1분이면 충분하다. */
  private cache = new Map<string, { at: number; users: any[] }>();
  private static TTL = 60_000;

  private async admToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp) return this.token.value;
    if (!this.secret) throw new ServiceUnavailableException('KC_CLIENT_SECRET이 설정되지 않았습니다');

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.secret,
    });
    let res: Response;
    try {
      res = await fetch(`${this.base}/realms/${this.realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (e: any) {
      throw new ServiceUnavailableException(`Keycloak에 연결할 수 없습니다: ${e.message}`);
    }
    if (!res.ok) throw new ServiceUnavailableException(`Keycloak 서비스 계정 인증 실패 (HTTP ${res.status})`);
    const j: any = await res.json();
    // 만료 30초 전을 만료로 친다 — 요청 왕복 중에 죽는 걸 막는다
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in - 30) * 1000 };
    return this.token.value;
  }

  /**
   * 401을 만나면 토큰을 버리고 **한 번만** 다시 받아 재시도한다.
   *
   * 왜 필요한가: 만료 시각만 보고 토큰을 재사용하면, Keycloak이 재시작되거나
   * 서명 키가 바뀌었을 때 "아직 안 만료됐다"고 믿는 죽은 토큰을 계속 들고 있게 된다.
   * 그러면 API를 재시작하기 전까지 사용자 목록이 영영 401이다.
   * 실제로 렐름을 다시 import한 직후 이 상태에 빠졌다.
   * **만료는 시계가 아니라 상대방이 정한다.**
   */
  private async adm(path: string, retry = true): Promise<any> {
    const res = await fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      headers: { Authorization: 'Bearer ' + (await this.admToken()) },
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.adm(path, false);
    }
    if (!res.ok) throw new ServiceUnavailableException(`Keycloak Admin API HTTP ${res.status} (${path})`);
    return res.json();
  }

  /**
   * 특정 기관(=그룹)에 속한, 특정 롤을 가진 사용자들.
   *
   * 두 번 물어서 교집합을 낸다:
   *   그룹 멤버  — 어느 기관 사람인가
   *   롤 보유자  — 판독의인가
   * 멤버마다 롤을 따로 묻는 방법도 있지만 사람 수만큼 요청이 늘어난다.
   */
  async usersInGroupWithRole(group: string, role: string) {
    const key = `${group}|${role}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < KeycloakService.TTL) return hit.users;

    const groups: any[] = await this.adm('/groups');
    const g = groups.find(x => x.name === group || x.path === '/' + group);
    if (!g) return [];

    const [members, withRole]: [any[], any[]] = await Promise.all([
      this.adm(`/groups/${g.id}/members?briefRepresentation=true&max=500`),
      this.adm(`/roles/${encodeURIComponent(role)}/users?max=500`),
    ]);
    const roleIds = new Set(withRole.map(u => u.id));

    const users = members
      .filter(u => roleIds.has(u.id) && u.enabled !== false)
      .map(u => ({
        // actor와 같은 형태로 맞춘다. AuthGuard가 email을 우선 쓰므로 여기서도 email이 우선이다.
        // 이 값이 preReviewer 컬럼에 들어가고, 나중에 "이 판독문이 내 것인가"를 이걸로 비교한다.
        id: u.email ?? u.username,
        username: u.username,
        name: [u.lastName, u.firstName].filter(Boolean).join('') || u.username,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.cache.set(key, { at: Date.now(), users });
    return users;
  }
}
