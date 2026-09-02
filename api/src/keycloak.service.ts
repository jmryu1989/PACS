import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const MANAGED_ROLES = new Set(['radiologist', 'technician', 'admin']);
const USER_PAGE_SIZE = 25;
const USER_SCAN_SIZE = 100;

export interface KeycloakUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  enabled: boolean;
  serviceAccountClientId: string | null;
  groups: string[];
  roles: string[];
}

/**
 * Keycloak Admin API 클라이언트 — 판독의 조회와 회원 관리의 고정 동작만 제공한다.
 *
 * 왜 필요한가: Preliminary(RS=P)는 상급 판독의를 **지정**하는 기능이고, 지정된 사람만
 * 판독문을 볼 수 있다. 지정을 자유 입력으로 받으면 오타 하나에 아무도 못 보는 판독문이
 * 생긴다. 접근 권한을 좌우하는 값을 사람이 타이핑하게 두면 안 된다.
 *
 * 사용자와 회원 상태는 이미 Keycloak에 있다. 우리 DB에 복사본을 두면 두 곳이 어긋난다
 * (인계문서 §8의 "상태를 두 곳에 두면 반드시 어긋난다"가 사용자에도 그대로 적용된다).
 * 그래서 물어본다.
 *
 * 이 클라이언트는 **서비스 계정**으로 인증한다. manage-users는 피해 반경이 넓으므로
 * 컨트롤러가 경로를 넘기는 범용 메서드는 내보내지 않고, 아래 고정 메서드만 공개한다.
 * 사용자의 토큰을 빌리지 않는 이유는 판독의에게 Keycloak 관리 권한을 줄 이유가 없기 때문이다.
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
  private async adm(path: string, method = 'GET', body?: any, retry = true): Promise<any> {
    const res = await fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer ' + (await this.admToken()),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.adm(path, method, body, false);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ServiceUnavailableException(`Keycloak Admin API HTTP ${res.status} (${path})`);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { return text; }
  }

  private async user(raw: any): Promise<KeycloakUser | null> {
    const detail = await this.adm(`/users/${encodeURIComponent(raw.id)}`);
    if (!detail) return null;
    const [groups, roles] = await Promise.all([
      this.adm(`/users/${encodeURIComponent(raw.id)}/groups?briefRepresentation=true&max=500`),
      this.adm(`/users/${encodeURIComponent(raw.id)}/role-mappings/realm`),
    ]);
    const username = detail.username ?? '';
    // Admin REST는 export와 달리 serviceAccountClientId를 사용자 표현에서 생략한다.
    // Keycloak이 서비스 사용자에 강제하는 예약 이름도 함께 봐야 쓰기 전에 알아챌 수 있다.
    const serviceAccountClientId = detail.serviceAccountClientId
      ?? (username.startsWith('service-account-') ? username.slice('service-account-'.length) : null);
    return {
      id: detail.id,
      username,
      email: detail.email ?? '',
      emailVerified: detail.emailVerified === true,
      firstName: detail.firstName ?? '',
      lastName: detail.lastName ?? '',
      enabled: detail.enabled !== false,
      serviceAccountClientId,
      groups: (groups ?? []).map((group: any) => String(group.name ?? group.path ?? '').replace(/^\//, '')),
      roles: (roles ?? []).map((role: any) => String(role.name ?? '')),
    };
  }

  /** 관리 콘솔의 한 페이지와 전체 대기 수. 서비스 계정은 이 경계에서 제거한다. */
  async listUsers(page: number) {
    const raw: any[] = [];
    for (let first = 0; ; first += USER_SCAN_SIZE) {
      const batch: any[] = await this.adm(`/users?first=${first}&max=${USER_SCAN_SIZE}`) ?? [];
      raw.push(...batch);
      if (batch.length < USER_SCAN_SIZE) break;
    }
    const detailed = (await Promise.all(raw.map(user => this.user(user))))
      .filter((user): user is KeycloakUser => !!user && !user.serviceAccountClientId);
    const first = (page - 1) * USER_PAGE_SIZE;
    return {
      page,
      pageSize: USER_PAGE_SIZE,
      total: detailed.length,
      pendingCount: detailed.filter(user => user.groups.length === 0).length,
      users: detailed.slice(first, first + USER_PAGE_SIZE),
    };
  }

  async getUser(id: string): Promise<KeycloakUser | null> {
    const raw = await this.adm(`/users/${encodeURIComponent(id)}`);
    return raw ? this.user(raw) : null;
  }

  /** Keycloak의 실제 기관 그룹 이름이 쓰기 화이트리스트다. */
  async institutions(): Promise<string[]> {
    const groups: any[] = await this.adm('/groups?briefRepresentation=true&first=0&max=500') ?? [];
    return groups.map(group => String(group.name ?? '')).filter(Boolean);
  }

  async createUser(user: {
    username: string; email: string; firstName: string; lastName: string;
  }): Promise<KeycloakUser> {
    await this.adm('/users', 'POST', { ...user, enabled: false, emailVerified: false });
    const found: any[] = await this.adm(
      `/users?username=${encodeURIComponent(user.username)}&exact=true&max=2`,
    ) ?? [];
    const exact = found.filter(row => row.username === user.username);
    if (exact.length !== 1)
      throw new ServiceUnavailableException('Keycloak 생성 사용자를 하나로 확정할 수 없습니다');
    const created = await this.user(exact[0]);
    if (!created) throw new ServiceUnavailableException('Keycloak 생성 사용자를 다시 읽을 수 없습니다');
    this.cache.clear();
    return created;
  }

  async setGroups(id: string, institutions: string[]): Promise<void> {
    const groups: any[] = await this.adm('/groups?briefRepresentation=true&first=0&max=500') ?? [];
    const byName = new Map(groups.map(group => [String(group.name), group]));
    if (institutions.some(institution => !byName.has(institution)))
      throw new ServiceUnavailableException('허용되지 않은 Keycloak 그룹 변경입니다');
    const current: any[] = await this.adm(`/users/${encodeURIComponent(id)}/groups?max=500`) ?? [];
    const wanted = new Set(institutions);
    for (const group of current)
      if (!wanted.has(String(group.name)))
        await this.adm(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(group.id)}`, 'DELETE');
    const currentNames = new Set(current.map(group => String(group.name)));
    for (const institution of wanted) {
      if (currentNames.has(institution)) continue;
      const group = byName.get(institution);
      await this.adm(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(group.id)}`, 'PUT');
    }
    this.cache.clear();
  }

  async setRoles(id: string, roles: string[]): Promise<void> {
    if (roles.some(role => !MANAGED_ROLES.has(role)))
      throw new ServiceUnavailableException('허용되지 않은 Keycloak 역할 변경입니다');
    const current: any[] = await this.adm(`/users/${encodeURIComponent(id)}/role-mappings/realm`) ?? [];
    const wanted = new Set(roles);
    const remove = current.filter(role => MANAGED_ROLES.has(role.name) && !wanted.has(role.name));
    if (remove.length)
      await this.adm(`/users/${encodeURIComponent(id)}/role-mappings/realm`, 'DELETE', remove);
    const currentNames = new Set(current.map(role => role.name));
    const add: any[] = [];
    for (const role of wanted) {
      if (currentNames.has(role)) continue;
      const representation = await this.adm(`/roles/${encodeURIComponent(role)}`);
      if (!representation) throw new ServiceUnavailableException(`Keycloak 역할이 없습니다: ${role}`);
      add.push(representation);
    }
    if (add.length)
      await this.adm(`/users/${encodeURIComponent(id)}/role-mappings/realm`, 'POST', add);
    this.cache.clear();
  }

  async resetPassword(id: string, mode: 'temp' | 'email', password?: string): Promise<void> {
    if (mode === 'temp') {
      await this.adm(`/users/${encodeURIComponent(id)}/reset-password`, 'PUT', {
        type: 'password', value: password, temporary: true,
      });
      return;
    }
    await this.adm(`/users/${encodeURIComponent(id)}/execute-actions-email`, 'PUT', ['UPDATE_PASSWORD']);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.adm(`/users/${encodeURIComponent(id)}`, 'PUT', { enabled });
    this.cache.clear();
  }

  async logoutUser(id: string): Promise<void> {
    await this.adm(`/users/${encodeURIComponent(id)}/logout`, 'POST');
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
