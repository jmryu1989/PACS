// REQ-S7-U5-DRAFT-OWNER -> RISK-S7-U5-DRAFT-WRONG-AUTHOR -> TEST-S7-U5-DRAFT-OWNER (Astra S7-U5-SPEC-C-F01; U5S-REQ-15, D09).
//
// What a draft mutation refuses before it looks at anything. Every draft mutation - the draft PUT, the own discard, the
// commit, the admin force-discard - carries the account its document took the text from (`expectedOwner`:
// { institution, sub, author }) and the boundary it read (`expectedRevision`, or `expectedEpoch` for the force-discard).
// A request whose cookie session is another account (an account switch in another tab, a swap between Recover Draft's
// check and its write), or one that does not carry these fields in this shape (an older page, a hand-made request),
// must be refused by name without reading the study, its drafts or the access policy, and without an audit row: a
// refusal that had already read or prepared something could leak or lock on behalf of the wrong account.
//
// The stored outcome of these same refusals (zero mutation in the database), the conditional write itself, its
// conflicts, the rollback of a failed audit write and the retry of the same revision (D08) are in
// tests/report_draft_cas_service_test.cjs, over the real service and a real PostgreSQL. This file replaces the
// process-memory write order (`draftOrder`, REPORT_DRAFT_SUPERSEDED) that the stored revision made unnecessary.
//
// Every case goes in where the router does: the handler Nest's route metadata maps the request to (looked up over the
// controllers AppModule registers, not by its name), its arguments placed as its parameter decorators ask, the request
// carrying the fields the auth guard sets, over the real PacsService. Runs against the built image (/app/dist):
//   docker run --rm --network none --read-only -v "$PWD/tests:/tests:ro" \
//     --entrypoint node kin-api:ci --test /tests/report_draft_owner_test.cjs
// The store is a stand-in that records every touch: no Postgres, no Orthanc, no original data.
const test = require('node:test'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { PacsService } = require('/app/dist/pacs.service');
const { AuthService } = require('/app/dist/auth.service');
const { AppModule } = require('/app/dist/app.module');
// Nest's own metadata names, from the copy of @nestjs/common the compiled controllers use.
const nest = createRequire('/app/dist/app.module.js');
const { PATH_METADATA, METHOD_METADATA, MODULE_METADATA, ROUTE_ARGS_METADATA } = nest('@nestjs/common/constants');
const { RequestMethod } = nest('@nestjs/common');
const { RouteParamtypes } = nest('@nestjs/common/enums/route-paramtypes.enum');

// ── the routes ──
const pattern = (...parts) => parts.flatMap(part => String(part).split('/')).filter(Boolean)
  .map(segment => (segment.startsWith(':') ? ':' : segment)).join('/');
function controllersOf(module, seen = new Set()) {
  if (!module || seen.has(module)) return [];
  seen.add(module);
  const meta = key => (typeof module === 'function' ? Reflect.getMetadata(key, module) : module[key]) ?? [];
  return [...meta(MODULE_METADATA.CONTROLLERS),
    ...meta(MODULE_METADATA.IMPORTS).flatMap(imported => controllersOf(imported?.module ?? imported, seen)),
    ...(typeof module === 'function' ? [] : controllersOf(module.module, seen))];
}
/** Every handler a request `method path` reaches: its method or ALL, and the same path with any parameter names. */
function routed(method, path) {
  const found = [];
  for (const controller of new Set(controllersOf(AppModule))) {
    const prefixes = [].concat(Reflect.getMetadata(PATH_METADATA, controller) ?? '/');
    for (let proto = controller.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const handler = key === 'constructor' ? null : Object.getOwnPropertyDescriptor(proto, key).value;
        if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        if (![method, RequestMethod.ALL].includes(Reflect.getMetadata(METHOD_METADATA, handler))) continue;
        const paths = [].concat(Reflect.getMetadata(PATH_METADATA, handler) ?? '/');
        if (prefixes.some(prefix => paths.some(at => pattern(prefix, at) === pattern(path))))
          found.push({ controller, key, name: `${controller.name}.${key}` });
      }
    }
  }
  return found;
}
const ROUTES = {
  put: routed(RequestMethod.PUT, 'studies/:uid/report'),
  discard: routed(RequestMethod.DELETE, 'studies/:uid/draft'),
  commit: routed(RequestMethod.POST, 'studies/:uid/report/commit'),
  force: routed(RequestMethod.DELETE, 'studies/:uid/draft/force'),
};

const UID = '2.25.7707';
const INST = 'synthetic-a', OTHER_INST = 'synthetic-b';
const A = { kind: 'member', institution: INST, sub: 'sub-a', actor: 'doctor-a@synthetic', roles: ['radiologist'] };
const B = { kind: 'member', institution: INST, sub: 'sub-b', actor: 'doctor-b@synthetic', roles: ['radiologist'] };
const ADMIN = { kind: 'member', institution: INST, sub: 'sub-admin', actor: 'admin@synthetic', roles: ['admin'] };
const ownerOf = p => ({ institution: p.institution, sub: p.sub, author: p.actor });
const EPOCH = '0a1b2c3d-0000-4000-8000-00000000000a';
const TOKEN = EPOCH + ':3';
const SNAPSHOT = { findings: 'SYN captured findings', conclusion: 'SYN conclusion', recommendation: '', baseVersion: 0,
  citationIds: [], structureIds: [] };

/** A well-formed request of each mutation by `who`: the document read TOKEN (EPOCH for the force-discard). */
const good = {
  put: who => ({ ...SNAPSHOT, expectedOwner: ownerOf(who), expectedRevision: TOKEN }),
  discard: who => ({ expectedOwner: ownerOf(who), expectedRevision: TOKEN }),
  commit: who => ({ action: 'save', findings: 'SYN captured findings', conclusion: '', recommendation: '', baseVersion: 0,
    expectedOwner: ownerOf(who), expectedRevision: TOKEN }),
  force: who => ({ expectedOwner: ownerOf(who), expectedEpoch: EPOCH }),
};
/** The account a route's mutation belongs to in these cases, and the field that names its boundary. */
const actorOf = route => (route === 'force' ? ADMIN : A);
const boundaryOf = route => (route === 'force' ? 'expectedEpoch' : 'expectedRevision');

function fixture() {
  // Every touch of the store, the access policy, Keycloak and the audit log, in order. A refusal leaves all of it empty.
  const touched = [];
  const store = new Proxy({}, { get(_target, key) {
    if (key === 'then') return undefined;
    return new Proxy(() => {}, {
      get: (_t, inner) => inner === 'then' ? undefined : async () => { touched.push(`${String(key)}.${String(inner)}`); throw new Error('harness: the store must not be reached'); },
      apply: async () => { touched.push(String(key)); throw new Error('harness: the store must not be reached'); },
    });
  } });
  const studyAccess = { prepare: async () => { touched.push('studyAccess.prepare'); }, require: async () => { touched.push('studyAccess.require'); } };
  const keycloak = { usersInGroupWithRole: async () => { touched.push('keycloak.usersInGroupWithRole'); return []; } };
  const findings = { readableFindings: async () => { touched.push('findings.readableFindings'); return []; } };
  return { svc: new PacsService(store, {}, keycloak, studyAccess, findings), touched, controllers: new Map() };
}

/** The request as the router hands it over: `caller` is the session the auth guard resolved. */
function send(f, route, body, caller, uid = UID) {
  assert.equal(ROUTES[route].length, 1, `${route} must reach one handler`);
  const [{ controller, key }] = ROUTES[route];
  if (!f.controllers.has(controller)) {
    const types = Reflect.getMetadata('design:paramtypes', controller) ?? [];
    const providers = new Map([[PacsService, f.svc], [AuthService, { memberRightsState: async () => 'ready' }]]);
    f.controllers.set(controller, new controller(...types.map(type => {
      assert.ok(providers.has(type), `${controller.name} needs ${type?.name}, which these cases do not provide`);
      return providers.get(type);
    })));
  }
  const req = { sub: caller.sub, actor: caller.actor, roles: caller.roles, institution: caller.institution, kind: caller.kind,
    authMethod: 'session', sid: 'syn-session-of-' + caller.sub, headers: {} };
  const args = [];
  for (const [slot, { index, data }] of Object.entries(Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, key) ?? {})) {
    const type = Number(slot.split(':')[0]);
    if (type === RouteParamtypes.PARAM && data === 'uid') args[index] = uid;
    else if (type === RouteParamtypes.BODY && data === undefined) args[index] = body;
    else if (type === RouteParamtypes.REQUEST) args[index] = req;
    else assert.fail(`the handler asks for argument ${slot} ${JSON.stringify(data)}, which these cases do not provide`);
  }
  return (async () => f.controllers.get(controller)[key](...args))();
}

/** The refusal of one request on a fresh fixture: [status, code, field], after checking that nothing was touched. */
async function refused(route, body, caller, what) {
  const f = fixture();
  const e = await send(f, route, body, caller).then(() => null, error => error);
  assert.ok(e, `${what}: the call resolved instead of being refused`);
  assert.equal(typeof e.getStatus, 'function', `${what}: ${e.message}`);
  assert.deepEqual(f.touched, [], `${what}: nothing of the study, the drafts, the access policy or the audit log is touched`);
  const answer = e.getResponse();
  return [e.getStatus(), answer?.code ?? null, answer?.field ?? null];
}

test('each draft mutation route reaches exactly one handler, the one every case below goes through', () => {
  console.log('S7-U5-DRAFT-OWNER-ROUTE ' + JSON.stringify(Object.fromEntries(Object.entries(ROUTES).map(([name, found]) => [name, found.map(route => route.name)]))));
  for (const [name, found] of Object.entries(ROUTES)) assert.equal(found.length, 1, name);
});

test('the text of one account under another account\'s session is refused before any read, write, audit or access preparation - on every mutation', async () => {
  for (const route of Object.keys(ROUTES)) {
    const owner = actorOf(route);
    // the old document's request (its account, its boundary) arrives under the other account's session
    const other = route === 'force' ? { ...ADMIN, sub: 'sub-admin-2', actor: 'admin-2@synthetic' } : B;
    assert.deepEqual(await refused(route, good[route](owner), other, route + ' under another session'),
      [409, 'REPORT_DRAFT_OWNER_CHANGED', null]);
    // each part of the owner is compared: another institution, another subject, another author
    for (const [part, value] of [['institution', OTHER_INST], ['sub', 'sub-x'], ['author', 'someone-else@synthetic']])
      assert.deepEqual(await refused(route, { ...good[route](owner), expectedOwner: { ...ownerOf(owner), [part]: value } }, owner, `${route} ${part}`),
        [409, 'REPORT_DRAFT_OWNER_CHANGED', null]);
  }
});

test('a mutation without its owner or its boundary, or with either in another shape, is refused by name before anything is read', async () => {
  const without = (body, key) => { const next = { ...body }; delete next[key]; return next; };
  for (const route of Object.keys(ROUTES)) {
    const who = actorOf(route), body = good[route](who), boundary = boundaryOf(route);
    assert.deepEqual(await refused(route, without(body, 'expectedOwner'), who, route + ' without an owner'),
      [400, 'REPORT_DRAFT_PRECONDITION_REQUIRED', 'expectedOwner']);
    assert.deepEqual(await refused(route, without(body, boundary), who, route + ' without a boundary'),
      [400, 'REPORT_DRAFT_PRECONDITION_REQUIRED', boundary]);
    // The removed shapes: the owner as an array (the fix3-fix8 page), a string, an object with other keys or values.
    for (const owner of [[who.institution, who.sub, who.actor], who.actor, { ...ownerOf(who), extra: 1 }, { institution: who.institution, sub: who.sub },
      { ...ownerOf(who), sub: 7 }, { ...ownerOf(who), institution: null }])
      assert.deepEqual(await refused(route, { ...body, expectedOwner: owner }, who, `${route} owner ${JSON.stringify(owner)}`),
        [400, 'REPORT_DRAFT_PRECONDITION_INVALID', 'expectedOwner']);
    const malformed = route === 'force' ? [7, '', 'not-an-epoch', EPOCH + ':1', EPOCH.toUpperCase()]
      : [7, '', EPOCH, '3', EPOCH + ':', EPOCH + ':-1', EPOCH + ':03', EPOCH + ':1.5', EPOCH + ':2147483648', 'x:1', [EPOCH, 3]];
    for (const value of malformed)
      assert.deepEqual(await refused(route, { ...body, [boundary]: value }, who, `${route} boundary ${JSON.stringify(value)}`),
        [400, 'REPORT_DRAFT_PRECONDITION_INVALID', boundary]);
  }
});

test('a draft PUT is the whole snapshot: a missing or mistyped part is refused by name, never read as "unchanged"', async () => {
  const body = good.put(A);
  for (const field of ['findings', 'conclusion', 'recommendation', 'baseVersion', 'citationIds', 'structureIds']) {
    const next = { ...body }; delete next[field];
    assert.deepEqual(await refused('put', next, A, 'without ' + field), [400, 'REPORT_DRAFT_PRECONDITION_REQUIRED', field]);
    assert.deepEqual(await refused('put', { ...body, [field]: null }, A, field + ' null'), [400, 'REPORT_DRAFT_PRECONDITION_REQUIRED', field]);
  }
  for (const [field, value] of [['findings', 7], ['conclusion', ['x']], ['recommendation', {}], ['baseVersion', -1], ['baseVersion', 1.5],
    ['baseVersion', '0'], ['citationIds', 'cid'], ['citationIds', [7]], ['structureIds', {}], ['structureIds', [null]]])
    assert.deepEqual(await refused('put', { ...body, [field]: value }, A, `${field} ${JSON.stringify(value)}`),
      [400, 'REPORT_DRAFT_PRECONDITION_INVALID', field]);
  // The fields of the removed write order are not a way in: an old page's body (array owner, draftOrder, no boundary).
  assert.deepEqual(await refused('put', { findings: 'SYN', conclusion: '', recommendation: '', baseVersion: 0,
    expectedOwner: [INST, A.sub, A.actor], draftOrder: ['syn-page', 4] }, A, 'the fix8 page'), [400, 'REPORT_DRAFT_PRECONDITION_INVALID', 'expectedOwner']);
});

test('the preconditions grant nothing: the role is refused first, whatever the request carries', async () => {
  const technician = { ...A, roles: ['technician'] };
  for (const route of ['put', 'discard', 'commit'])
    assert.deepEqual((await refused(route, good[route](technician), technician, route + ' by a technician'))[0], 403);
  assert.deepEqual((await refused('force', good.force(A), A, 'force-discard by a radiologist'))[0], 403);
  // ... and a role refusal does not depend on the preconditions being there at all
  assert.deepEqual((await refused('put', { findings: 'SYN' }, technician, 'a bare PUT by a technician'))[0], 403);
});
