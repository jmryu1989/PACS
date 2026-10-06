import { Injectable, ServiceUnavailableException } from '@nestjs/common';
// setRoles()가 여기 없는 역할을 503으로 거절하고 approve()는 그것을 409 USER_ISOLATED로 끝낸다.
// 그래서 관리 대상 역할은 guard·회원콘솔과 같은 목록(clinician-policy)이어야 한다.
import { APP_ROLES as MANAGED_ROLES } from './clinician-policy';
const USER_PAGE_SIZE = 25;
const USER_SCAN_SIZE = 100;
const bound = (limitMs?: number) => limitMs === undefined ? undefined : AbortSignal.timeout(limitMs);

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

  private async admToken(signal?: AbortSignal): Promise<string> {
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
        signal,
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
  private async adm(path: string, method = 'GET', body?: any, retry = true, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer ' + (await this.admToken(signal)),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.adm(path, method, body, false, signal);
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

  /**
   * `limitMs`(선택)는 이 호출 **전체**의 한도다(서비스 계정 토큰 취득·401 뒤의 재요청까지). 격리의 남은 일이 이 호출들에
   * 한도를 준다: 그 호출이 돌아올 때까지 넘겨받은 쪽(재활성화)이 기다리므로, 기다림이 끝없지 않게 한다. 넘기면 던진다.
   */
  async setEnabled(id: string, enabled: boolean, limitMs?: number): Promise<void> {
    await this.adm(`/users/${encodeURIComponent(id)}`, 'PUT', { enabled }, true, bound(limitMs));
    this.cache.clear();
  }

  /**
   * 회원 하나의 지금 provider(SSO) 세션 id들 — 격리가 그 전부에 표식을 남기려고 읽는다(서비스 계정의 view-users로 읽을 수
   * 있음: closure-audit facts.md "GET users/{id}/sessions 200"). 읽지 못하면 던진다 — 격리는 그 자리에서 실패로 끝난다.
   */
  async userSessions(id: string, limitMs?: number): Promise<string[]> {
    const sessions: any[] = await this.adm(`/users/${encodeURIComponent(id)}/sessions`, 'GET', undefined, true, bound(limitMs)) ?? [];
    if (!Array.isArray(sessions)) throw new ServiceUnavailableException('Keycloak 사용자 세션 목록을 읽지 못했습니다');
    return sessions.map(session => session?.id).filter((sid): sid is string => typeof sid === 'string' && !!sid);
  }

  async logoutUser(id: string, limitMs?: number): Promise<void> {
    await this.adm(`/users/${encodeURIComponent(id)}/logout`, 'POST', undefined, true, bound(limitMs));
  }

  /**
   * provider 세션 **하나**를 끝낸다(S7-U5 R1). 고정 동작이다: 대상은 그 세션 id 하나뿐이고, 사용자 전체 로그아웃
   * (`logoutUser`)으로 대신하지 않는다 — 다른 PC에서 일하는 같은 의사의 세션은 건드리지 않는다. 끝나는 것은 그 SSO 세션
   * 전체다(같은 SSO에 묶인 다른 client도 함께 끝난다).
   *
   * 답은 셋뿐이다: `ended`(204, 지금 끝냈다) · `absent`(404, 그런 세션이 없다) · `unconfirmed`(그 밖 전부 — 시간 초과,
   * 연결 실패, 5xx, 권한 거절). `unconfirmed`는 "끝나지 않았다"가 아니라 "모른다"이고, 부른 쪽이 다시 청한다.
   * 한도 `limitMs`는 이 호출 **전체**의 것이다: 서비스 계정 토큰 취득과 401 뒤의 재취득·재요청까지 그 안에서 끝난다 —
   * 인증 서버가 멈춰 있어도 부른 쪽은 그 시간 뒤에 답을 받는다.
   */
  async endSession(sid: string, limitMs: number): Promise<'ended' | 'absent' | 'unconfirmed'> {
    const signal = AbortSignal.timeout(limitMs);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${this.base}/admin/realms/${this.realm}/sessions/${encodeURIComponent(sid)}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + (await this.admToken(signal)) },
          signal,
        });
        // 죽은 서비스 토큰(Keycloak 재시작·키 교체)은 한 번만 다시 받아 같은 한도 안에서 다시 청한다.
        if (res.status === 401 && attempt === 0) {
          this.token = null;
          continue;
        }
        await res.arrayBuffer().catch(() => undefined);
        return res.status === 204 ? 'ended' : res.status === 404 ? 'absent' : 'unconfirmed';
      }
    } catch {
      // 시간 초과·연결 실패·서비스 계정 인증 실패: 모른다.
    }
    return 'unconfirmed';
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
        name: [u.lastName, u.firstName].filter(Boolean).join(' ') || u.username,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.cache.set(key, { at: Date.now(), users });
    return users;
  }
  /** Assignment picker: no cached role/group decisions or silent 500-user truncation. */
  async assignmentReaders(institution: string) {
    const groups: any[] = await this.adm('/groups?briefRepresentation=true&max=500') ?? [];
    const group = groups.find(g => g.name === institution || g.path === '/' + institution);
    if (!group) return [];
    const readers: KeycloakUser[] = [];
    for (let first=0; first<1000; first+=100) {
      const batch:any[] = await this.adm(`/groups/${encodeURIComponent(group.id)}/members?briefRepresentation=true&first=${first}&max=100`) ?? [];
      // Bounded batches keep this path from opening hundreds of Admin requests at once.
      for (let offset=0; offset<batch.length; offset+=10) {
        const users=await Promise.all(batch.slice(offset,offset+10).map(u=>this.getUser(u.id)));
        readers.push(...users.filter((u):u is KeycloakUser=>!!u&&u.enabled&&!u.serviceAccountClientId&&u.groups.length===1&&u.groups[0]===institution&&u.roles.includes('radiologist')));
      }
      if(batch.length<100)return readers;
    }
    throw new ServiceUnavailableException('기관 사용자 수가 조회 한도를 넘었습니다');
  }

  /**
   * S7-U1a 중요 결과 수신자 후보: 기관 그룹의 활성 회원(서비스 계정 아님, 그룹 정확히 하나 = 그 기관). 역할은 거르지 않는다 —
   * clinician·radiologist 부류와 원문 읽기 판정은 호출자가 한다. assignmentReaders와 같은 배치·한도이고 캐시한 역할·그룹으로
   * 판정하지 않는다(후보 목록이 생성 판정과 같은 Keycloak 현재 상태를 보게).
   */
  async institutionMembers(institution: string) {
    const groups: any[] = await this.adm('/groups?briefRepresentation=true&max=500') ?? [];
    const group = groups.find(g => g.name === institution || g.path === '/' + institution);
    if (!group) return [];
    const members: KeycloakUser[] = [];
    for (let first=0; first<1000; first+=100) {
      const batch:any[] = await this.adm(`/groups/${encodeURIComponent(group.id)}/members?briefRepresentation=true&first=${first}&max=100`) ?? [];
      for (let offset=0; offset<batch.length; offset+=10) {
        const users=await Promise.all(batch.slice(offset,offset+10).map(u=>this.getUser(u.id)));
        members.push(...users.filter((u):u is KeycloakUser=>!!u&&u.enabled&&!u.serviceAccountClientId&&u.groups.length===1&&u.groups[0]===institution));
      }
      if(batch.length<100)return members;
    }
    throw new ServiceUnavailableException('기관 사용자 수가 조회 한도를 넘었습니다');
  }

}
