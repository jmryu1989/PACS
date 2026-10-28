'use strict';
// The admin console of the studio mock (admin.html with signing-key-admin.js, study-access-admin.js and
// admin-access-review.js): members, temporary passwords, signing keys, study access, Gateway receipts, Operations,
// Audit / Security and Access Review. Synthetic members and records only, kept in the mock state, so an action is
// still there after a reload and shows up in Audit / Access Review. The answer shapes and refusals follow
// api/src/admin.service.ts, signing-key-admin.controller.ts, study-access.service.ts, gateway-receipt.ts,
// pacs/metrics.ts, admin-audit.ts and admin-access-review.ts. What the studio cannot stand in for (a real mail,
// Keycloak sessions, a restriction on the studio person's own worklist) is refused with a studio sentence, never a
// silent success.
const crypto = require('crypto');

const ISO = () => new Date().toISOString();
const DAY = 86400e3;
const ago = ms => new Date(Date.now() - ms).toISOString();
const APP_ROLES = ['radiologist', 'technician', 'admin', 'clinician'];
const KEY_ROLES = ['radiologist', 'clinician', 'technician'];
const ACCESS_ROLES = ['admin', 'radiologist', 'technician'];
const SNAPSHOT_FIELDS = ['id', 'username', 'name', 'roles', 'enabled', 'approvalState', 'emailVerified', 'institution'];
const FILE_ACTIONS = ['print-opened', 'print-done', 'pdf', 'copy', 'download', 'disclosure'];
const STATUTORY = { write: '기재', 'approve-sign': '기재', addendum: '추가기재', cancel: '수정', modify: '수정', 'client-shown': '열람',
  'provide-prepared': '열람', download: '열람', 'print-opened': '열람' };
const known = value => ({ status: 'known', value });
const err = (status, message, code) => ({ status, body: code ? { code, message } : { statusCode: status, message } });
const ok = body => ({ status: 200, body });

// ── synthetic records ───────────────────────────────────────────────────────────────────────────────────────
function member(id, username, name, institution, roles, extra = {}) {
  return { id, username, email: username, emailVerified: true, name, institution, roles, version: 1, enabled: true, approvalState: 'APPROVED', ...extra };
}

function seed(mock) {
  const colleagues = mock.seed.colleagues || [];
  const users = [
    ...colleagues.map(c => member(c.id, c.username, c.name, 'kin-center', ['radiologist'], { version: 3 })),
    member('studio-han-tech', 'han.tech@studio.invalid', 'HAN MINSU', 'kin-center', ['technician'], { version: 2 }),
    member('studio-choi-tech', 'tech.choi@studio.invalid', 'CHOI TECH', 'hallym', ['technician']),
    member('studio-yoon-clinic', 'yoon.clinic@studio.invalid', 'YOON HARIN', 'hallym', ['clinician'], { version: 2 }),
    member('studio-old-locum', 'old.locum@studio.invalid', 'JUNG LOCUM', 'kin-center', ['radiologist'], { enabled: false, version: 4 }),
    member('studio-new-doctor', 'new.doctor@studio.invalid', 'NEW DOCTOR', null, [], { approvalState: 'PENDING', version: null }),
    member('studio-new-resident', 'park.resident@studio.invalid', 'PARK RESIDENT', null, [], { approvalState: 'PENDING', version: null, emailVerified: false }),
  ];
  const kid = () => crypto.randomUUID();
  const keys = {};
  if (colleagues[0]) { const k = kid(); keys[colleagues[0].id] = { current: k, keys: [{ kid: k, status: 'active', registeredAt: ago(40 * DAY), endedAt: null }] }; }
  if (colleagues[1]) {
    const k = kid();
    keys[colleagues[1].id] = { current: k, keys: [{ kid: k, status: 'active', registeredAt: ago(12 * DAY), endedAt: null },
      { kid: kid(), status: 'revoked', registeredAt: ago(200 * DAY), endedAt: ago(12 * DAY) }] };
  }
  const studyAccess = {};
  if (colleagues[1]) studyAccess[colleagues[1].id] = { revision: 1, reason: '외부 판독 계약 범위(CT·MR)만', updatedBy: 'park.admin@studio.invalid', updatedAt: ago(5 * DAY),
    policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ patientId: null, modalities: ['CT', 'MR'], dateFrom: null, dateTo: null, studyUids: [] }] } };
  // Receipts only on studies the reading center owns, on finished readings so the reading worklist stays as it was.
  const own = mock.studies.filter(s => s.institutionId === 'kin-center' && !s.tele && ['A'].includes(mock.state.studies[s.uid].rs));
  const gateway = {};
  const receipt = (phase, successCount, localCount, { attempt = 1, errorCode = null, ageMs, agentSeq }) => ({ phase, successCount, localCount,
    attempt, errorCode, serverReceivedAt: ago(ageMs), agentSeq, epoch: crypto.randomUUID() });
  if (own[0]) gateway[own[0].uid] = receipt('complete', own[0].count || 2, own[0].count || 2, { ageMs: 26 * 3600e3, agentSeq: 41 });
  if (own[1]) gateway[own[1].uid] = receipt('retry', 1, Math.max(own[1].count || 3, 2), { attempt: 3, errorCode: 'cloud_unreachable', ageMs: 50 * 60e3, agentSeq: 57 });
  if (own[2]) gateway[own[2].uid] = receipt('failed', 0, own[2].count || 1, { errorCode: 'instance_exceeds_budget', ageMs: 5 * 3600e3, agentSeq: 12 });

  const admin = { users, keys, studyAccess, gateway, retries: {}, requests: {}, audit: [], access: [], nextAudit: 1, nextEvent: 1 };
  const byId = id => users.find(u => u.id === id);
  const actor = 'park.admin@studio.invalid';
  const kim = colleagues[0] && byId(colleagues[0].id), lee = colleagues[1] && byId(colleagues[1].id);
  if (kim) audit(admin, { at: ago(30 * DAY), actor, action: 'admin.user.approve', target: kim.id, rule: 'member_snapshots',
    detail: { before: snapshot({ ...kim, approvalState: 'PENDING', institution: null, roles: [], version: null }), after: snapshot(kim), verificationOverride: false } });
  const old = byId('studio-old-locum');
  audit(admin, { at: ago(10 * DAY), actor, action: 'admin.user.suspend', target: old.id, rule: 'member_snapshots',
    detail: { before: snapshot({ ...old, enabled: true }), after: snapshot(old), verificationOverride: false } });
  if (lee) audit(admin, { at: ago(5 * DAY), actor, action: 'study.access', target: lee.id, rule: 'field:detail.institution',
    detail: { institution: 'kin-center', subject: lee.id, revision: 1, restricted: true, reason: '외부 판독 계약 범위(CT·MR)만' } });
  const fresh = byId('studio-new-doctor');
  audit(admin, { at: ago(2 * DAY), actor, action: 'admin.user.create', target: fresh.id, rule: 'member_snapshots',
    detail: { before: null, after: snapshot(fresh), verificationOverride: false } });
  // A member who moved to another institution: that side is withheld, never named.
  audit(admin, { at: ago(20 * DAY), actor: 'admin@hallym.invalid', action: 'admin.user.update', target: 'studio-choi-tech', rule: 'member_snapshots',
    detail: { before: snapshot(byId('studio-choi-tech')), after: { withheld: 'other_institution' }, verificationOverride: false } });
  for (const [who, hours] of [[kim, 3], [lee, 1.5]]) {
    if (!who) continue;
    audit(admin, { at: ago(hours * 3600e3), actor: who.username, action: 'auth.login', target: who.id, rule: 'field:detail.institution',
      detail: { institution: 'kin-center', ip: '10.20.0.' + (hours === 3 ? 31 : 32) } });
    event(admin, { at: ago(hours * 3600e3), actor: who, surface: 'GET auth/callback', action: 'login', result: 'succeeded', statutoryAct: 'none',
      targets: [{ kind: 'authentication-session', recordId: known('session-' + who.id) }], ip: '10.20.0.' + (hours === 3 ? 31 : 32) });
  }
  const read = own[0] || mock.studies[0];
  if (kim && read) {
    event(admin, { at: ago(2.5 * 3600e3), actor: kim, surface: 'GET studies/:uid/report-preview', action: 'client-shown', result: 'reported', statutoryAct: '열람',
      targets: [studyTarget(read, 'report')] });
    event(admin, { at: ago(2 * 3600e3), actor: kim, surface: 'POST studies/:uid/original-download', action: 'download', result: 'prepared', statutoryAct: '열람',
      targets: [studyTarget(read, 'dicom-study')], cause: '외부 협진 의뢰' });
  }
  return admin;
}

function studyTarget(s, kind, version = null) {
  return { kind, patientLinkSnapshot: known({ patientId: s.patient.id, name: s.patient.name }), studyId: known(s.uid),
    recordId: known(s.uid), versionId: version === null ? { status: 'not-applicable', reason: 'no-version' } : known(String(version)) };
}

function snapshot(user) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map(k => [k, user[k] === undefined ? null : user[k]]));
}

function audit(admin, row) {
  admin.audit.push({ id: admin.nextAudit++, ...row });
}

function event(admin, { at, actor, surface, action, result, statutoryAct, targets, ip, cause, affected }) {
  const id = admin.nextEvent++;
  admin.access.push({
    eventId: crypto.randomUUID(), occurredAt: at, recordedAt: at, surface, action, result, statutoryAct: statutoryAct || STATUTORY[action] || 'none',
    userId: known(actor.username || actor.actor), rolesAtTime: known(actor.roles), executor: 'member',
    actingInstitution: known(actor.institution || 'kin-center'), managingInstitution: known('kin-center'),
    trustedProxyIp: ip ? known(ip) : { status: 'unresolved', reason: 'studio-mock' },
    affectedIdentity: affected ? known(affected) : { status: 'not-applicable', reason: 'no-affected-member' },
    targets: targets || [], cause: cause || null, context: null, requestId: `studio-request-${id}`, auditLinkId: null, relatedEventId: null,
    auth: 'session', rightsVersion: 1,
  });
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
function state(mock, me) {
  if (!mock.state.admin) { mock.state.admin = seed(mock); mock.save(); }
  const admin = mock.state.admin;
  // The studio person is a member of the reading center too, so the self rules (no self-suspend…) apply to that row.
  if (!admin.users.some(u => u.id === me.sub)) {
    admin.users.unshift(member(me.sub, me.actor, me.displayName.replace(/ \(Studio\)$/, ''), me.institution, ['radiologist', 'admin'], { version: 1 }));
    mock.save();
  }
  return admin;
}

function row(user) {
  const { id, username, email, emailVerified, name, institution, roles, version, enabled, approvalState } = user;
  return { id, username, email, emailVerified, name, institution, roles, version, enabled, approvalState };
}

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw err(400, `${name}은(는) 1~${max}자 문자열이어야 합니다`);
  return value.trim();
}

function reasonText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) throw err(400, '변경 사유를 1~2000자로 입력하세요');
  return value.trim();
}

const actorOf = me => ({ username: me.actor, roles: me.roles, institution: me.institution });
const median = list => { const s = [...list].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2); };
const cursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function uncursor(value) { try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch { return null; } }

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────────────
// Returns {status, body} for an admin route, or null when the path is not one of them.
function route(mock, method, p, q, body, me) {
  let m;
  const adminPath = p.startsWith('/api/admin/');
  const retry = (m = p.match(/^\/api\/studies\/([0-9.]+)\/gateway-retry$/)) && method === 'POST';
  if (!adminPath && !retry) return null;
  const id = () => decodeURIComponent(m[1]);
  let handler = null;
  if (retry) handler = admin => gatewayRetry(mock, admin, m[1], me);
  else if (p === '/api/admin/users' && method === 'GET') handler = admin => listUsers(admin, q);
  else if (p === '/api/admin/users' && method === 'POST') handler = admin => createUser(mock, admin, body, me);
  else if ((m = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && method === 'PATCH') handler = admin => patchUser(mock, admin, id(), body, me);
  else if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/)) && method === 'POST') handler = admin => resetPassword(mock, admin, id(), body, me);
  else if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/signing-key$/)) && (method === 'GET' || method === 'POST')) handler = admin => signingKey(mock, admin, id(), method, body, me);
  else if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/study-access$/)) && (method === 'GET' || method === 'POST')) handler = admin => studyAccess(mock, admin, id(), method, body, me);
  else if (p === '/api/admin/metrics' && method === 'GET') handler = () => metrics(mock, me);
  else if (p === '/api/admin/audit' && method === 'GET') handler = admin => (q.get('report') === 'access' ? accessReview(admin, q, me) : auditPage(admin, q, me));
  if (!handler) return null;
  try {
    if (!retry && !me.roles.includes('admin')) return err(403, '회원 관리는 admin 권한이 필요합니다');
    return handler(state(mock, me));
  } catch (refusal) {
    if (refusal && refusal.status) return refusal;
    throw refusal;
  }
}

function listUsers(admin, q) {
  const page = q.get('page') == null || q.get('page') === '' ? 1 : Number(q.get('page'));
  if (!Number.isInteger(page) || page < 1) return err(400, 'page는 1 이상의 정수여야 합니다');
  const size = 25;
  const users = admin.users.slice((page - 1) * size, page * size).map(u => ({ ...row(u), rosterUnconfirmed: false }));
  return ok({ page, pageSize: size, total: admin.users.length, pendingCount: admin.users.filter(u => u.approvalState !== 'APPROVED').length, users });
}

function temporaryPassword() { return crypto.randomBytes(18).toString('base64url') + 'aA1!'; }

function createUser(mock, admin, body, me) {
  const username = text(body.username, 'username', 128);
  if (username.startsWith('service-account-')) return err(400, 'Keycloak 서비스 계정 예약 이름은 사용할 수 없습니다');
  const email = text(body.email, 'email', 254);
  if (!email.includes('@')) return err(400, 'email 형식이 올바르지 않습니다');
  const firstName = text(body.firstName, 'firstName', 128), lastName = text(body.lastName, 'lastName', 128);
  if (body.institution !== undefined || body.roles !== undefined) return err(400, '기관·역할을 함께 지정하려면 verificationOverride:true가 필요합니다');
  if (admin.users.some(u => u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === email.toLowerCase()))
    return err(409, '같은 아이디 또는 이메일의 사용자가 이미 있습니다', 'MEMBER_EXISTS');
  // A new account has not verified its email yet: approving it needs the in-person check box, as in the product.
  const user = member(`studio-${crypto.randomUUID()}`, username, `${lastName} ${firstName}`, null, [],
    { email, emailVerified: false, approvalState: 'PENDING', version: null });
  admin.users.push(user);
  audit(admin, { at: ISO(), actor: me.actor, action: 'admin.user.create', target: user.id, rule: 'member_snapshots',
    detail: { before: null, after: snapshot(user), verificationOverride: false } });
  event(admin, { at: ISO(), actor: actorOf(me), surface: 'POST admin/users', action: 'write', result: 'succeeded',
    targets: [{ kind: 'identity-access', recordId: known(user.id) }], affected: user.id });
  mock.save();
  return ok({ ...row(user), temporaryPassword: temporaryPassword() });
}

function patchUser(mock, admin, id, body, me) {
  const user = admin.users.find(u => u.id === id);
  if (!user) return err(404, '사용자를 찾을 수 없습니다');
  const conflict = () => err(409, '회원 상태가 바뀌었습니다. 새로고침하세요', 'MEMBER_VERSION_CONFLICT');
  if (user.version !== null && body.version !== undefined && body.version !== user.version) return conflict();
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return err(400, 'enabled는 boolean이어야 합니다');
  if (body.verificationOverride !== undefined && typeof body.verificationOverride !== 'boolean') return err(400, 'verificationOverride는 boolean이어야 합니다');
  if (body.approvalState !== undefined && !['APPROVED', 'PENDING'].includes(body.approvalState)) return err(400, 'approvalState는 APPROVED 또는 PENDING이어야 합니다');
  const approvalMutation = body.approvalState === 'APPROVED' || body.institution !== undefined || body.roles !== undefined;
  if (body.verificationOverride === true && !approvalMutation) return err(400, 'verificationOverride는 승인·자격 변경에만 사용할 수 있습니다');
  if (body.approvalState === 'PENDING' && body.enabled !== undefined) return err(400, '승인 취소와 활성 상태 변경을 섞을 수 없습니다');
  const roles = value => {
    if (!Array.isArray(value) || !value.length || value.some(r => typeof r !== 'string')) throw err(400, 'roles는 한 개 이상의 역할 배열이어야 합니다');
    const list = [...new Set(value.map(r => r.trim()))];
    if (list.some(r => !APP_ROLES.includes(r))) throw err(400, '허용되지 않은 역할입니다');
    return list;
  };
  if (me.sub === id) {
    if (body.enabled === false) return err(400, '자기 자신을 정지할 수 없습니다');
    if (body.approvalState === 'PENDING') return err(400, '자기 자신의 승인을 취소할 수 없습니다');
    if (body.roles !== undefined && !roles(body.roles).includes('admin')) return err(400, '자기 자신의 admin 역할을 제거할 수 없습니다');
  }
  const before = snapshot(user);
  const next = { ...user };
  let action;
  if (body.approvalState === 'PENDING') {
    if (body.institution !== undefined || body.roles !== undefined) return err(400, '승인 취소와 기관·역할 변경을 한 요청에 섞을 수 없습니다');
    action = 'unapprove'; Object.assign(next, { approvalState: 'PENDING', enabled: false, institution: null, roles: [] });
  } else if (approvalMutation) {
    action = user.approvalState === 'APPROVED' ? 'update' : 'approve';
    const institution = body.institution !== undefined ? body.institution : user.institution;
    if (typeof institution !== 'string' || !(mock.seed.institutions || []).some(i => i.id === institution.trim())) return err(400, '허용되지 않은 기관입니다');
    next.institution = institution.trim();
    next.roles = roles(body.roles !== undefined ? body.roles : user.roles);
    if (!user.emailVerified && body.verificationOverride !== true) return err(400, '이메일 검증이 끝나지 않은 사용자는 승인할 수 없습니다');
    next.approvalState = 'APPROVED';
    if (body.enabled !== undefined) next.enabled = body.enabled;
  } else if (body.enabled === false) {
    action = 'suspend'; next.enabled = false;
  } else if (body.enabled === true) {
    action = 'activate';
    if (user.approvalState !== 'APPROVED' || !user.institution || !user.roles.length) return err(400, '승인된 회원만 활성화할 수 있습니다');
    next.enabled = true;
  } else return err(400, '변경할 회원 상태가 없습니다');
  next.version = (user.version || 1) + 1;
  Object.assign(user, next);
  audit(admin, { at: ISO(), actor: me.actor, action: `admin.user.${action}`, target: id, rule: 'member_snapshots',
    detail: { before, after: snapshot(user), verificationOverride: body.verificationOverride === true } });
  event(admin, { at: ISO(), actor: actorOf(me), surface: 'PATCH admin/users/:id', action: 'modify', result: 'succeeded',
    targets: [{ kind: 'identity-access', recordId: known(id), versionId: known(String(user.version)) }], affected: id });
  mock.save();
  return ok({ ...row(user), rosterUnconfirmed: false });
}

function resetPassword(mock, admin, id, body, me) {
  if (!['temp', 'email'].includes(body.mode)) return err(400, 'mode는 temp 또는 email이어야 합니다');
  const user = admin.users.find(u => u.id === id);
  if (!user) return err(404, '사용자를 찾을 수 없습니다');
  // There is no mail server behind the studio: say so instead of pretending a mail went out.
  if (body.mode === 'email') return err(501, '스튜디오에는 메일 서버가 없어 비밀번호 변경 메일은 보내지 않습니다(스튜디오 미지원). Temp Password는 써 볼 수 있습니다.', 'STUDIO_NOT_SUPPORTED');
  audit(admin, { at: ISO(), actor: me.actor, action: 'admin.user.reset-password', target: id, rule: 'member_snapshots',
    detail: { before: snapshot(user), after: snapshot(user), mode: body.mode } });
  mock.save();
  return ok({ ...row(user), temporaryPassword: temporaryPassword() });
}

function signingKey(mock, admin, id, method, body, me) {
  const user = admin.users.find(u => u.id === id);
  if (!user || user.approvalState !== 'APPROVED') return err(404, '회원 권한 이관 또는 등록이 필요합니다');
  if (user.institution !== me.institution || !user.roles.some(r => KEY_ROLES.includes(r)))
    return err(403, '이 기관의 판독의·임상의·방사선사만 서명키를 가질 수 있습니다', 'DoctorRegistrationRequired');
  const held = admin.keys[id] || (admin.keys[id] = { current: null, keys: [] });
  const view = () => ok({ subject: id, institutionId: user.institution, current: held.current, keys: held.keys.map(k => ({ ...k })) });
  if (method === 'GET') return view();
  const keys = Object.keys(body || {}).sort().join(',');
  if (keys !== 'action,expectedKid,reason' || !['provision', 'replace', 'revoke'].includes(body.action)) return err(400, '서명키 요청 형식이 올바르지 않습니다');
  const reason = reasonText(body.reason);
  const changed = () => err(409, '다른 관리자가 먼저 이 회원의 키를 바꿨습니다. Reload로 현재 키를 확인하세요', 'KeyManagementConflict');
  if (body.action === 'provision' ? body.expectedKid !== null || held.current !== null : body.expectedKid !== held.current || held.current === null) return changed();
  const now = ISO();
  const end = () => { const k = held.keys.find(x => x.kid === held.current); if (k) Object.assign(k, { status: 'revoked', endedAt: now }); held.current = null; };
  if (body.action !== 'provision') end();
  if (body.action !== 'revoke') { const kid = crypto.randomUUID(); held.keys.unshift({ kid, status: 'active', registeredAt: now, endedAt: null }); held.current = kid; }
  event(admin, { at: now, actor: actorOf(me), surface: 'POST admin/users/:id/signing-key', action: 'modify', result: 'succeeded',
    targets: [{ kind: 'identity-access', recordId: known(id) }], affected: id, cause: reason });
  mock.save();
  return view();
}

function studyAccess(mock, admin, id, method, body, me) {
  const user = admin.users.find(u => u.id === id);
  if (!user || !user.enabled || user.institution !== me.institution || !user.roles.some(r => ACCESS_ROLES.includes(r))) return err(404, '대상 회원을 찾을 수 없습니다');
  const owner = [me.institution, me.sub];
  const stored = admin.studyAccess[id] || { revision: 0, reason: null, updatedBy: null, updatedAt: null,
    policy: { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } };
  if (method === 'GET') return ok({ owner, subject: id, revision: stored.revision, policy: stored.policy, needsInstitutionReview: false,
    reason: stored.reason, updatedBy: stored.updatedBy, updatedAt: stored.updatedAt });
  if (id === me.sub) return err(501, '스튜디오는 지금 쓰는 사람 자신의 검사 접근 제한을 적용하지 않습니다(스튜디오 미지원). 다른 회원으로 해 보세요.', 'STUDIO_NOT_SUPPORTED');
  const changed = () => err(409, '다른 관리자가 먼저 접근 조건을 바꿨습니다. Reload로 현재 설정을 확인하세요', 'STUDY_ACCESS_CHANGED');
  if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner)) return changed();
  if (typeof body.requestId !== 'string' || !body.requestId) return err(400, 'requestId가 필요합니다');
  const fingerprint = JSON.stringify([id, body.revision, body.policy, body.reason]);
  const seen = admin.requests[body.requestId];
  if (seen) return seen.fingerprint === fingerprint ? ok({ owner, subject: id, revision: seen.revision, replayed: true })
    : err(409, '같은 요청 번호가 다른 내용으로 다시 쓰였습니다', 'STUDY_ACCESS_REQUEST_REUSED');
  if (body.revision !== stored.revision) return changed();
  const reason = reasonText(body.reason);
  const policy = checkPolicy(body.policy);
  const revision = stored.revision + 1;
  admin.studyAccess[id] = { revision, reason, updatedBy: me.actor, updatedAt: ISO(), policy };
  admin.requests[body.requestId] = { fingerprint, revision };
  audit(admin, { at: ISO(), actor: me.actor, action: 'study.access', target: id, rule: 'field:detail.institution',
    detail: { institution: me.institution, subject: id, revision, restricted: policy.restricted, reason } });
  event(admin, { at: ISO(), actor: actorOf(me), surface: 'POST admin/users/:id/study-access', action: 'modify', result: 'succeeded',
    targets: [{ kind: 'identity-access', recordId: known(id), versionId: known(String(revision)) }], affected: id, cause: reason });
  mock.save();
  return ok({ owner, subject: id, revision, replayed: false });
}

function checkPolicy(p) {
  const bad = message => { throw err(400, message); };
  const instant = v => (v === null ? null : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : bad('시각 형식이 올바르지 않습니다'));
  if (!p || p.version !== 1 || typeof p.restricted !== 'boolean' || !Array.isArray(p.rules)) bad('접근 조건 형식이 올바르지 않습니다');
  if (!p.restricted) return { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] };
  const startsAt = instant(p.startsAt ?? null), endsAt = instant(p.endsAt ?? null);
  if (startsAt && endsAt && startsAt >= endsAt) bad('종료 시각은 시작 시각보다 뒤여야 합니다');
  if (p.rules.length > 10) bad('조건은 최대 10개입니다');
  if (p.rules.length === 1 && p.rules[0] && p.rules[0].all === true) return { version: 1, restricted: true, startsAt, endsAt, rules: [{ all: true }] };
  const rules = p.rules.map(r => {
    if (!r || typeof r !== 'object' || r.all) bad('조건 형식이 올바르지 않습니다');
    const rule = { patientId: r.patientId || null, modalities: Array.isArray(r.modalities) ? r.modalities.filter(Boolean).map(String) : [],
      dateFrom: r.dateFrom || null, dateTo: r.dateTo || null, studyUids: Array.isArray(r.studyUids) ? r.studyUids.filter(Boolean).map(String) : [] };
    if (!rule.patientId && !rule.modalities.length && !rule.dateFrom && !rule.dateTo && !rule.studyUids.length) bad('빈 조건은 저장할 수 없습니다');
    return rule;
  });
  return { version: 1, restricted: true, startsAt, endsAt, rules };
}

// ── Gateway ────────────────────────────────────────────────────────────────────────────────────────────────
function receiptFor(mock, uid, me) {
  const s = mock.byUid.get(uid);
  if (!s || s.tele || s.institutionId !== me.institution) return null;
  return state(mock, me).gateway[uid] || null;
}

function gatewayRetry(mock, admin, uid, me) {
  if (!me.roles.some(r => r === 'technician' || r === 'admin')) return err(403, 'Gateway 재시도는 방사선사 또는 관리자만 요청할 수 있습니다');
  const s = mock.byUid.get(uid);
  if (!s || s.tele || s.institutionId !== me.institution) return err(404, '검사를 찾을 수 없습니다', 'GATEWAY_RETRY_NOT_FOUND');
  const receipt = admin.gateway[uid];
  if (receipt && receipt.phase === 'failed') return err(409, '같은 바이트로는 성공할 수 없습니다', 'GATEWAY_RETRY_UNSUPPORTED_F01');
  if (!receipt || receipt.phase !== 'retry') return err(409, '재시도 대기 상태가 아닙니다', 'GATEWAY_RETRY_NOT_RETRY');
  const key = `${receipt.epoch}|${receipt.agentSeq}`;
  const done = admin.retries[uid];
  if (done && done.key === key) return ok({ studyUid: uid, result: 'already_requested', requestedAt: done.requestedAt });
  admin.retries[uid] = { key, requestedAt: ISO() };
  mock.save();
  return ok({ studyUid: uid, result: 'requested', requestedAt: admin.retries[uid].requestedAt });
}

// ── Operations ─────────────────────────────────────────────────────────────────────────────────────────────
function metrics(mock, me) {
  const now = Date.now(), at = new Date(now).toISOString();
  const source = 'KIN DB StudyState + ReportVersion (Studio mock, synthetic)';
  const scope = mock.studies.filter(s => s.institutionId === me.institution || s.tele);
  // The synthetic study has no registration row: it counts as registered at 00:30 KST of its study date.
  const registered = s => Math.min(now - 60e3, Date.parse(`${s.date.slice(0, 4)}-${s.date.slice(4, 6)}-${s.date.slice(6, 8)}T00:30:00+09:00`));
  const windowOf = span => ({ from: new Date(now - span).toISOString(), to: at });
  const countRow = (key, value, window = null) => ({ key, state: 'observed', reason: null, scope: 'institution', source, observedAt: at, unit: 'study',
    value, max: null, denominator: null, excluded: 0, ...(window ? { window } : {}) });
  const timeRow = (key, seconds, window = null) => seconds.length
    ? { key, state: 'observed', reason: null, scope: 'institution', source, observedAt: at, unit: 'second', value: median(seconds), max: Math.max(...seconds),
      denominator: { unit: 'study', value: seconds.length }, excluded: 0, ...(window ? { window } : {}) }
    : { key, state: 'empty', reason: null, scope: 'institution', source, observedAt: at, unit: 'second', value: null, max: null,
      denominator: { unit: 'study', value: 0 }, excluded: 0, ...(window ? { window } : {}) };
  const tat = { E: [], N: [] }, waiting = { E: [], N: [] };
  for (const s of scope) {
    const st = mock.state.studies[s.uid];
    const em = st.em === 'E' ? 'E' : 'N';
    if (['W', 'T', 'P', 'H'].includes(st.rs)) waiting[em].push(Math.max(0, Math.round((now - registered(s)) / 1000)));
    const first = st.versions.filter(v => v.action === 'approve').sort((a, b) => a.version - b.version)[0];
    const approved = first ? Date.parse(first.at) : NaN;
    if (approved <= now && approved >= now - 7 * DAY) tat[em].push(Math.max(0, Math.round((approved - registered(s)) / 1000)));
  }
  const within = span => scope.filter(s => registered(s) >= now - span).length;
  return ok({ institutionId: me.institution, generatedAt: at, metrics: [
    { key: 'storage.server', state: 'observed', reason: null, scope: 'server', source: 'Orthanc /statistics (Studio mock)', observedAt: at, unit: 'byte',
      value: 330000000, max: null, denominator: { unit: 'byte', value: null }, excluded: null },
    { key: 'storage.institution', state: 'unobservable', reason: 'no_source', scope: 'institution', source: null, observedAt: null, unit: 'byte',
      value: null, max: null, denominator: null, excluded: null },
    countRow('studies.own', scope.filter(s => !s.tele).length),
    countRow('studies.tele', scope.filter(s => s.tele).length),
    countRow('studies.flag_unreadable', 0),
    countRow('studies.registered_24h', within(DAY), windowOf(DAY)),
    countRow('studies.registered_7d', within(7 * DAY), windowOf(7 * DAY)),
    timeRow('tat.emergency', tat.E, windowOf(7 * DAY)),
    timeRow('tat.normal', tat.N, windowOf(7 * DAY)),
    timeRow('waiting.emergency', waiting.E),
    timeRow('waiting.normal', waiting.N),
  ] });
}

// ── Audit / Security and Access Review ─────────────────────────────────────────────────────────────────────
function auditPage(admin, q, me) {
  if ([...q.keys()].some(k => k !== 'limit' && k !== 'after')) return err(400, '감사 조회 조건이 올바르지 않습니다', 'ADMIN_AUDIT_QUERY_INVALID');
  const limit = q.has('limit') ? Number(q.get('limit')) : 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, 'limit는 1~100이어야 합니다', 'ADMIN_AUDIT_QUERY_INVALID');
  let offset = 0;
  if (q.has('after')) {
    const c = uncursor(q.get('after'));
    if (!c || c.sub !== me.sub || !Number.isInteger(c.offset)) return err(409, '이어보기 위치가 만료되었습니다. 다시 조회하세요', 'ADMIN_AUDIT_CURSOR_EXPIRED');
    offset = c.offset;
  }
  const all = admin.audit.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  const rows = all.slice(offset, offset + limit).map(({ id, ...r }) => r);
  return ok({ institutionId: me.institution, observedAt: ISO(), total: all.length, rows,
    next: offset + limit < all.length ? cursor({ sub: me.sub, offset: offset + limit }) : null });
}

function accessReview(admin, q, me) {
  const allowed = ['report', 'from', 'until', 'downloads', 'after'];
  if ([...q.keys()].some(k => !allowed.includes(k)) || !['all', 'files'].includes(q.get('downloads'))) return err(400, '조회 조건이 올바르지 않습니다');
  const from = q.get('from'), until = q.get('until');
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until)) || Date.parse(from) >= Date.parse(until)) return err(400, '시작보다 뒤인 종료 시각을 지정하세요');
  let offset = 0;
  if (q.has('after')) {
    const c = uncursor(q.get('after'));
    if (!c || c.from !== from || c.until !== until || c.downloads !== q.get('downloads') || !Number.isInteger(c.offset)) return err(400, '이어보기 위치가 조회 조건과 맞지 않습니다');
    offset = c.offset;
  }
  const lo = Date.parse(from), hi = Date.parse(until);
  const all = admin.access.filter(e => Date.parse(e.occurredAt) >= lo && Date.parse(e.occurredAt) < hi)
    .filter(e => q.get('downloads') !== 'files' || FILE_ACTIONS.includes(e.action))
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const size = 25;
  return ok({ institutionId: me.institution, from, until, observedAt: ISO(), rows: all.slice(offset, offset + size),
    next: offset + size < all.length ? cursor({ from, until, downloads: q.get('downloads'), offset: offset + size }) : null });
}

// A committed reading in the mock leaves the same audit and access rows the product's commitReport does.
function noteCommit(mock, me, s, action, version, reason) {
  const admin = state(mock, me);
  const at = ISO();
  audit(admin, { at, actor: me.actor, action: `report.${action}`, target: s.uid, rule: 'field:detail.by',
    detail: { by: me.institution, version, ...(reason ? { reason } : {}) } });
  const access = action === 'approve' ? 'approve-sign' : action === 'addendum' ? 'addendum' : action === 'reset' ? 'cancel' : 'write';
  event(admin, { at, actor: actorOf(me), surface: 'POST studies/:uid/report/commit', action: access, result: 'succeeded',
    targets: [studyTarget(s, 'report', version)], cause: reason || null });
}

module.exports = { route, receiptFor, noteCommit };
