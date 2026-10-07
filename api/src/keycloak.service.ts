import { Injectable, ServiceUnavailableException } from '@nestjs/common';
// setRoles()가 여기 없는 역할을 503으로 거절하고 approve()는 그것을 409 USER_ISOLATED로 끝낸다.
// 그래서 관리 대상 역할은 guard·회원콘솔과 같은 목록(clinician-policy)이어야 한다.
import { APP_ROLES as MANAGED_ROLES } from './clinician-policy';
const USER_PAGE_SIZE = 25;
const USER_SCAN_SIZE = 100;
/**
 * `ms` 뒤에 끊기는 신호. AbortSignal.timeout은 0 이상의 정수 ms만 받고 그 밖에는 던진다 — 단조 시계로 남은 시간을 잰 한도는
 * 소수이므로 올려서 넘긴다(남은 시간이 없으면 1ms).
 */
export const within = (ms: number) => AbortSignal.timeout(Math.max(1, Math.ceil(ms)));
const bound = (limitMs?: number) => limitMs === undefined ? undefined : within(limitMs);

/**
 * 변경 호출 하나의 답(S7-U5 D600): `done` 인증 서버가 했다, `void` 하지 않았다(보내지 않았거나 처리하지 않았다고 답했다),
 * `unknown` 모른다. `outcome`은 진단용 요약(상태 코드·`not_sent`·`transport`)이며 판정에 쓰지 않는다.
 */
export type ChangeAnswer = { state: 'done' | 'void' | 'unknown'; outcome: string };
export type CredentialWriter = (path: string, method: 'PUT' | 'DELETE' | 'POST', body?: any) => Promise<void>;

/** 연결 자체가 이루어지지 않은 오류: 요청의 바이트가 인증 서버에 닿지 않았다. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
function notSent(error: any): boolean {
  const cause = error?.cause;
  return NOT_SENT.has(cause?.code) || (Array.isArray(cause?.errors) && cause.errors.length > 0
    && cause.errors.every((inner: any) => NOT_SENT.has(inner?.code)));
}

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

  /**
   * 변경 호출 하나(S7-U5 D600). 그 요청 자체는 끊지 않는다: 기다리는 쪽의 기한이 지나도 요청은 자기 답이 올 때까지 남고,
   * 그 답이 결과를 정한다 — 기한에 끊으면 인증 서버가 그 요청을 나중에 처리해도 우리는 끝내 모른다. 기한(`signal`)은
   * 서비스 계정 토큰 취득에만 건다: 토큰을 얻기 전에 기한이 지나면 변경 요청은 나가지 않았다(`void`).
   * 판정은 상태 코드로만 한다(본문 유무로 하지 않는다): 2xx done; 404는 세션 종료면 "그런 세션이 없다"(done), 그 밖은 대상
   * 없음(void); 그 밖의 4xx는 인증 서버가 처리하지 않았다는 답(void, 401은 토큰을 한 번 다시 받아 다시 청한다); 501은
   * 그 요청을 다루는 곳이 없다는 답(void); 그 밖의 5xx와 연결 오류(연결이 맺어지지 않은 것 제외)는 처리됐는지 알 수 없다
   * (unknown). 503도 unknown이다: Keycloak은 넘친 요청을 처리 전에 503으로 돌려보내지만, 처리 중에 난 오류도 같은 상태
   * 코드로 돌려줄 수 있고(오류 처리기가 예외의 상태를 그대로 쓴다) 이 답만으로는 둘을 가르지 못한다 — 처리 전 거절이라고
   * 믿으면 실제로 수행된 변경을 "하지 않았다"로 지운다. 토큰 취득의 503은 다르다: 변경 요청이 나가지 않았다(void).
   */
  private async change(path: string, method: 'PUT' | 'DELETE' | 'POST', body: any, signal: AbortSignal | undefined, absentIsDone: boolean)
    : Promise<ChangeAnswer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try { token = await this.admToken(signal); }
      catch { return { state: 'void', outcome: 'not_sent' }; }
      let res: Response;
      try {
        res = await fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
          method,
          headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        return notSent(error) ? { state: 'void', outcome: 'not_sent' } : { state: 'unknown', outcome: 'transport' };
      }
      await res.arrayBuffer().catch(() => undefined);
      const outcome = 'http_' + res.status;
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (res.status >= 200 && res.status < 300) return { state: 'done', outcome };
      if (res.status === 404) return absentIsDone ? { state: 'done', outcome: 'absent' } : { state: 'void', outcome };
      if ((res.status >= 400 && res.status < 500) || res.status === 501) return { state: 'void', outcome };
      return { state: 'unknown', outcome };
    }
    return { state: 'void', outcome: 'http_401' };
  }

  private async user(raw: any, signal?: AbortSignal): Promise<KeycloakUser | null> {
    const detail = await this.adm(`/users/${encodeURIComponent(raw.id)}`, 'GET', undefined, true, signal);
    if (!detail) return null;
    const [groups, roles] = await Promise.all([
      this.adm(`/users/${encodeURIComponent(raw.id)}/groups?briefRepresentation=true&max=500`, 'GET', undefined, true, signal),
      this.adm(`/users/${encodeURIComponent(raw.id)}/role-mappings/realm`, 'GET', undefined, true, signal),
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

  /** `signal`(선택)은 이 읽기 전체의 기한이다(읽기는 끊어도 된다 — 아무것도 바꾸지 않는다). 넘기면 던진다. */
  async getUser(id: string, signal?: AbortSignal): Promise<KeycloakUser | null> {
    const raw = await this.adm(`/users/${encodeURIComponent(id)}`, 'GET', undefined, true, signal);
    return raw ? this.user(raw, signal) : null;
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

  private async credentialWrite(path: string, method: 'PUT' | 'DELETE' | 'POST', body: any, signal?: AbortSignal): Promise<void> {
    const answer = await this.change(path, method, body, signal, false);
    if (answer.state !== 'done') throw new ServiceUnavailableException('Keycloak 자격 변경을 확인하지 못했습니다');
  }

  /** A credential request recorded by the compound membership command before it is sent. */
  async changeCredential(path: string, method: 'PUT' | 'DELETE' | 'POST', body: any, signal?: AbortSignal): Promise<ChangeAnswer> {
    const answer = await this.change(path, method, body, signal, false);
    this.cache.clear();
    return answer;
  }

  async setGroups(id: string, institutions: string[], signal?: AbortSignal, write: CredentialWriter =
    (path, method, body) => this.credentialWrite(path, method, body, signal)): Promise<void> {
    const groups: any[] = await this.adm('/groups?briefRepresentation=true&first=0&max=500', 'GET', undefined, true, signal) ?? [];
    const byName = new Map(groups.map(group => [String(group.name), group]));
    if (institutions.some(institution => !byName.has(institution)))
      throw new ServiceUnavailableException('허용되지 않은 Keycloak 그룹 변경입니다');
    const current: any[] = await this.adm(`/users/${encodeURIComponent(id)}/groups?max=500`, 'GET', undefined, true, signal) ?? [];
    const wanted = new Set(institutions);
    for (const group of current)
      if (!wanted.has(String(group.name)))
        await write(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(group.id)}`, 'DELETE');
    const currentNames = new Set(current.map(group => String(group.name)));
    for (const institution of wanted) {
      if (currentNames.has(institution)) continue;
      const group = byName.get(institution);
      await write(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(group.id)}`, 'PUT');
    }
    this.cache.clear();
  }

  async setRoles(id: string, roles: string[], signal?: AbortSignal, write: CredentialWriter =
    (path, method, body) => this.credentialWrite(path, method, body, signal)): Promise<void> {
    if (roles.some(role => !MANAGED_ROLES.has(role)))
      throw new ServiceUnavailableException('허용되지 않은 Keycloak 역할 변경입니다');
    const current: any[] = await this.adm(`/users/${encodeURIComponent(id)}/role-mappings/realm`, 'GET', undefined, true, signal) ?? [];
    const wanted = new Set(roles);
    const remove = current.filter(role => MANAGED_ROLES.has(role.name) && !wanted.has(role.name));
    if (remove.length)
      await write(`/users/${encodeURIComponent(id)}/role-mappings/realm`, 'DELETE', remove);
    const currentNames = new Set(current.map(role => role.name));
    const add: any[] = [];
    for (const role of wanted) {
      if (currentNames.has(role)) continue;
      const representation = await this.adm(`/roles/${encodeURIComponent(role)}`, 'GET', undefined, true, signal);
      if (!representation) throw new ServiceUnavailableException(`Keycloak 역할이 없습니다: ${role}`);
      add.push(representation);
    }
    if (add.length)
      await write(`/users/${encodeURIComponent(id)}/role-mappings/realm`, 'POST', add);
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

  /** 기록하지 않는 활성화(새로 만든 회원의 첫 활성화 — 격리와 무관하다). 격리·재활성화의 변경은 `changeEnabled`다. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.adm(`/users/${encodeURIComponent(id)}`, 'PUT', { enabled });
    this.cache.clear();
  }

  /**
   * 격리·재활성화의 회원 비활성화/활성화 — 변경 호출 하나(`change`). 부른 쪽이 보내기 전에 기록하고 이 답으로 결과를 적는다.
   * `signal`은 토큰 취득의 기한일 뿐 요청을 끊지 않는다.
   */
  async changeEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<ChangeAnswer> {
    const answer = await this.change(`/users/${encodeURIComponent(id)}`, 'PUT', { enabled }, signal, false);
    this.cache.clear();
    return answer;
  }

  /**
   * 회원 하나의 지금 provider(SSO) 세션 id들 — 격리가 그 전부에 표식을 남기려고 읽는다(서비스 계정의 view-users로 읽을 수
   * 있음: closure-audit facts.md "GET users/{id}/sessions 200"). 읽지 못하면 던진다 — 격리는 그 자리에서 실패로 끝난다.
   * 읽기라 기한(`limitMs`)에 끊는다: 늦은 목록은 쓰지 않는다(부른 쪽이 다시 나열한다).
   */
  async userSessions(id: string, limitMs?: number): Promise<string[]> {
    const sessions: any[] = await this.adm(`/users/${encodeURIComponent(id)}/sessions`, 'GET', undefined, true, bound(limitMs)) ?? [];
    if (!Array.isArray(sessions)) throw new ServiceUnavailableException('Keycloak 사용자 세션 목록을 읽지 못했습니다');
    return sessions.map(session => session?.id).filter((sid): sid is string => typeof sid === 'string' && !!sid);
  }

  /**
   * provider 세션 **하나**를 끝낸다(S7-U5 R1) — 변경 호출 하나(`change`). 고정 동작이다: 대상은 그 세션 id 하나뿐이고, 사용자
   * 전체 로그아웃으로 대신하지 않는다 — 다른 PC에서 일하는 같은 의사의 세션은 건드리지 않고, 격리도 회원의 provider 세션을
   * 나열해 하나씩 끝낸다. 끝나는 것은 그 SSO 세션 전체다(같은 SSO에 묶인 다른 client도 함께 끝난다).
   * 인증 서버는 같은 브라우저의 다음 SSO에 끝난 SSO의 sid를 다시 줄 수 있고, 이 요청은 처리될 때 그 sid의 세션을 끝낸다
   * (인증 세대를 조건으로 받지 않는다) — 그래서 답을 잃은 요청은 "모른다"로 남고 부른 쪽은 그 sid의 끝을 확인하지 않는다.
   * `signal`은 토큰 취득의 기한일 뿐 요청을 끊지 않는다. 404는 "그런 세션이 없다"(done)다.
   */
  async endSession(sid: string, signal?: AbortSignal): Promise<ChangeAnswer> {
    return this.change(`/sessions/${encodeURIComponent(sid)}`, 'DELETE', undefined, signal, true);
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
