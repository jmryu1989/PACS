// REQ-S7-U5-DRAFT-OWNER -> RISK-S7-U5-DRAFT-WRONG-AUTHOR -> TEST-S7-U5-DRAFT-OWNER (Astra S7-U5-SPEC-C-F01).
// REQ-S7-U5-DRAFT-ORDER -> RISK-S7-U5-DRAFT-LATE-WRITE -> TEST-S7-U5-DRAFT-ORDER (Astra S7-U5-R-001-F03).
//
// The compiled draft write (PUT /api/studies/:uid/report) against an `expectedOwner` binding: the screen sends the account it
// took the report text from ([institution, subject, author]); a write whose cookie session is another account (an account
// switch in another tab, or a swap between Recover Draft's /api/me check and its PUT) must not create, overwrite or delete
// that account's draft. And against a `draftOrder` ([page id, sequence]): an earlier write of a page - one whose connection
// the browser lost while the API still had it, or one that reaches the API late - must not replace what a later write of
// that page stored, in whichever order the two finish. Every case goes in where the router does: the handler Nest's route
// metadata maps that PUT to (looked up over the controllers AppModule registers, not by its name), its arguments placed as
// its parameter decorators ask, the request carrying the fields the auth guard sets, over the real PacsService; one
// controller per case, as the application has one. Runs against the built image (/app/dist)
// exactly like report_stale_draft_test.cjs:
//   docker run --rm --network none --read-only -v "$PWD/tests:/tests:ro" \
//     --entrypoint node kin-api:ci --test /tests/report_draft_owner_test.cjs
// Every database call is a stub, so no Postgres, no Orthanc and no original data.
const test = require('node:test'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { PacsService } = require('/app/dist/pacs.service');
const { AppModule } = require('/app/dist/app.module');
// Nest's own metadata names, from the copy of @nestjs/common the compiled controllers use.
const nest = createRequire('/app/dist/app.module.js');
const { PATH_METADATA, METHOD_METADATA, MODULE_METADATA, ROUTE_ARGS_METADATA } = nest('@nestjs/common/constants');
const { RequestMethod } = nest('@nestjs/common');
const { RouteParamtypes } = nest('@nestjs/common/enums/route-paramtypes.enum');

// ── the route ──
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
const ROUTES = routed(RequestMethod.PUT, 'studies/:uid/report');

const UID = '2.25.7707';
const INST = 'synthetic-a', OTHER_INST = 'synthetic-b';
const A = { kind: 'member', institution: INST, sub: 'sub-a', actor: 'doctor-a@synthetic', roles: ['radiologist'] };
const B = { kind: 'member', institution: INST, sub: 'sub-b', actor: 'doctor-b@synthetic', roles: ['radiologist'] };
const OWNER_A = [INST, A.sub, A.actor];
const STATE = { uid: UID, institutionId: INST, teleInstitutionId: null, rs: 'W', ss: 'Verified', em: 'N',
  holder: null, heldAt: null, preDoc: null, preReviewer: null, repDoc: null, confirm: null };
const TEXT = { findings: 'SYN captured findings', conclusion: 'SYN conclusion', recommendation: '' };

function fixture({ state = STATE } = {}) {
  // Every touch of the store, in order. A refusal must leave all of these empty.
  const touched = [], writes = [], audits = [], prepared = [];
  // The draft rows as the store holds them: the text the last write to reach each (study, author) row left, null once it
  // was emptied. `gates` are closed by a case to keep the next transaction(s) open: a write the API is still working on.
  const rows = new Map(), gates = [];
  const row = (uid, author) => rows.get(JSON.stringify([uid, author]));
  const tx = {
    $executeRaw: async () => { touched.push('lock_timeout'); return 0; },
    $queryRaw: async () => { touched.push('queryRaw'); return []; },
    studyState: { findUnique: async () => { touched.push('studyState.findUnique'); return state; } },
    report: { findUnique: async () => { touched.push('report.findUnique'); return { version: 0 }; } },
    reportDraft: {
      findUnique: async a => { touched.push('reportDraft.findUnique:' + a.where.uid_author.author); return null; },
      upsert: async a => {
        writes.push('reportDraft.upsert:' + a.where.uid_author.author + ':' + a.create.author);
        rows.set(JSON.stringify([a.where.uid_author.uid, a.where.uid_author.author]),
          { findings: a.create.findings, conclusion: a.create.conclusion, recommendation: a.create.recommendation });
        return { uid: a.create.uid, author: a.create.author, baseVersion: a.create.baseVersion, updatedAt: new Date(0) };
      },
      deleteMany: async a => {
        writes.push('reportDraft.deleteMany:' + a.where.author);
        rows.set(JSON.stringify([a.where.uid, a.where.author]), null);
        return { count: 1 };
      },
    },
    auditLog: { create: async a => { audits.push(a.data.actor + ':' + a.data.action); return a.data; } },
  };
  const prisma = {
    $transaction: async work => { touched.push('transaction'); await gates.shift(); return work(tx); },
    studyState: { findUnique: async () => { touched.push('prisma.studyState.findUnique'); return state; } },
    auditLog: { create: async a => { audits.push(a.data.actor + ':' + a.data.action); return a.data; } },
  };
  const studyAccess = {
    prepare: async (c, uids) => { prepared.push(c.actor + ':' + JSON.stringify(uids ?? null)); },
    require: async () => { touched.push('studyAccess.require'); },
  };
  const keycloak = { usersInGroupWithRole: async () => [] };
  // Neither citation nor structure keys are sent, so the finding gate must never be reached.
  const findings = { readableFindings: async () => { throw new Error('the owner cases must not ask about findings'); } };
  /** Keeps the next transaction open until the returned function is called. */
  const hold = () => { let open; gates.push(new Promise(resolve => { open = resolve; })); return open; };
  return { svc: new PacsService(prisma, {}, keycloak, studyAccess, findings), touched, writes, audits, prepared, row, hold,
    controller: null };
}

/**
 * The PUT as the router hands it over: `caller` is the session the auth guard resolved (req.sub/actor/roles/institution/kind).
 * A fixture has one controller for all its writes, as the application has one for all requests.
 */
function put(f, body, caller, uid = UID) {
  assert.equal(ROUTES.length, 1, 'PUT studies/:uid/report must reach one handler');
  const [{ controller, key }] = ROUTES;
  const types = Reflect.getMetadata('design:paramtypes', controller) ?? [];
  f.controller ??= new controller(...types.map(type => {
    assert.equal(type, PacsService, `${controller.name} needs ${type?.name}, which these cases do not provide`);
    return f.svc;
  }));
  const instance = f.controller;
  const req = { sub: caller.sub, actor: caller.actor, roles: caller.roles, institution: caller.institution, kind: caller.kind };
  const args = [];
  for (const [slot, { index, data }] of Object.entries(Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, key) ?? {})) {
    const type = Number(slot.split(':')[0]);
    if (type === RouteParamtypes.PARAM && data === 'uid') args[index] = uid;
    else if (type === RouteParamtypes.BODY && data === undefined) args[index] = body;
    else if (type === RouteParamtypes.REQUEST) args[index] = req;
    else assert.fail(`the handler asks for argument ${slot} ${JSON.stringify(data)}, which these cases do not provide`);
  }
  return (async () => instance[key](...args))();
}

const refusal = async (promise, status) => {
  const e = await promise.then(() => null, error => error);
  assert.ok(e, 'the call resolved instead of being refused');
  assert.equal(e.getStatus?.(), status, e.message);
  return e.getResponse();
};

const untouched = (f, what) => {
  assert.deepEqual(f.touched, [], `${what}: nothing of the study or the draft is read`);
  assert.deepEqual(f.writes, [], `${what}: no draft row is created, overwritten or deleted`);
  assert.deepEqual(f.audits, [], `${what}: no audit row (the success audit included)`);
  assert.deepEqual(f.prepared, [], `${what}: the access policy is not even prepared`);
};

test('PUT studies/:uid/report reaches exactly one handler, the one every case below goes through', () => {
  console.log('S7-U5-DRAFT-OWNER-ROUTE ' + JSON.stringify(ROUTES.map(route => route.name)));
  assert.equal(ROUTES.length, 1, JSON.stringify(ROUTES.map(route => route.name)));
});

test('the account the text was taken from writes its own draft, as before', async () => {
  const f = fixture();
  const answer = await put(f, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, A);
  assert.equal(answer.author, A.actor);
  assert.deepEqual(f.writes, [`reportDraft.upsert:${A.actor}:${A.actor}`]);
  assert.deepEqual(f.audits, [`${A.actor}:report.draft`]);
});

test('without expectedOwner the write is the caller\'s, exactly as before (the other callers of this PUT)', async () => {
  for (const caller of [A, B]) {
    const f = fixture();
    const answer = await put(f, { ...TEXT, baseVersion: 0 }, caller);
    assert.equal(answer.author, caller.actor);
    assert.deepEqual(f.writes, [`reportDraft.upsert:${caller.actor}:${caller.actor}`]);
    assert.deepEqual(f.audits, [`${caller.actor}:report.draft`]);
  }
});

test('A\'s captured text under B\'s session is refused before any read, write or audit', async () => {
  const cases = [
    ['another reader of the same institution', B],
    ['the same subject under another author name', { ...A, actor: 'renamed@synthetic' }],
    ['another subject under the same author name', { ...A, sub: 'sub-z' }],
    ['the same reader moved to another institution', { ...A, institution: OTHER_INST }],
    ['the same reader with no institution', { ...A, institution: null }],
  ];
  for (const [what, caller] of cases) {
    for (const [shape, body] of [
      ['a text write', { ...TEXT, baseVersion: 0 }],
      // An empty write deletes the caller's draft: that is exactly what must not happen to B.
      ['an emptying write', { findings: '', conclusion: '', recommendation: '', baseVersion: 0 }],
      // An insertion prepares the access policy first; the binding is decided before that, too.
      ['a write with an insertion', { ...TEXT, baseVersion: 0, insert: { field: 'findings' } }],
    ]) {
      const f = fixture();
      const answer = await refusal(put(f, { ...body, expectedOwner: OWNER_A }, caller), 409);
      assert.equal(answer.code, 'REPORT_DRAFT_OWNER_CHANGED', `${what}, ${shape}`);
      assert.doesNotMatch(answer.message, /저장했습니다/, 'the refusal never reads as a stored write');
      untouched(f, `${what}, ${shape}`);
    }
  }
});

test('a binding to another institution\'s reader is refused even when that reader is the caller\'s namesake', async () => {
  const f = fixture();
  const answer = await refusal(put(f, { ...TEXT, baseVersion: 0, expectedOwner: [OTHER_INST, A.sub, A.actor] }, A), 409);
  assert.equal(answer.code, 'REPORT_DRAFT_OWNER_CHANGED');
  untouched(f, 'another institution in the binding');
});

test('a malformed binding is a 400 and touches nothing', async () => {
  for (const value of [null, 'sub-a', {}, { institution: INST, sub: A.sub, author: A.actor }, [], [INST, A.sub],
                       [INST, A.sub, A.actor, 'extra'], [7, A.sub, A.actor], [INST, null, A.actor], [INST, A.sub, null]]) {
    const f = fixture();
    await refusal(put(f, { ...TEXT, baseVersion: 0, expectedOwner: value }, A), 400);
    untouched(f, `expectedOwner ${JSON.stringify(value)}`);
  }
});

test('a matching binding grants nothing: the role, institution and study gates are unchanged', async () => {
  // Without the radiologist role the existing refusal stands (403) and nothing is written.
  const tech = { ...A, roles: ['technician'] };
  const f1 = fixture();
  await refusal(put(f1, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, tech), 403);
  assert.deepEqual([f1.writes, f1.audits], [[], []]);
  // A study of another institution stays invisible (404) to a caller whose binding matches.
  const f2 = fixture({ state: { ...STATE, institutionId: OTHER_INST } });
  await refusal(put(f2, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, A), 404);
  assert.deepEqual([f2.writes, f2.audits], [[], []]);
  // A Preliminary report of someone else stays closed to the binding's own reader (403).
  const f3 = fixture({ state: { ...STATE, rs: 'P', preDoc: 'doctor-c@synthetic', preReviewer: 'doctor-c@synthetic' } });
  await refusal(put(f3, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, A), 403);
  assert.deepEqual([f3.writes, f3.audits], [[], []]);
  // The matching empty write still deletes only the caller's own draft.
  const f4 = fixture();
  await put(f4, { findings: '', conclusion: '', recommendation: '', baseVersion: 0, expectedOwner: OWNER_A }, A);
  assert.deepEqual(f4.writes, [`reportDraft.deleteMany:${A.actor}`]);
  assert.deepEqual(f4.audits, [`${A.actor}:report.draft.clear`]);
});

// ── the write order (Astra S7-U5-R-001-F03) ──
// A page numbers its draft writes: `draftOrder` is [page id, sequence]. "Earlier" and "later" below are that sequence - the
// order the page sent them in - never the order they reach or leave the API.
const PAGE = 'syn-page-1', OTHER_PAGE = 'syn-page-2';
const told = label => ({ findings: `SYN ${label} findings`, conclusion: `SYN ${label} conclusion`, recommendation: '' });
const ordered = (label, seq, page = PAGE) => ({ ...told(label), baseVersion: 0, expectedOwner: OWNER_A, draftOrder: [page, seq] });
const EMPTY = { findings: '', conclusion: '', recommendation: '', baseVersion: 0, expectedOwner: OWNER_A };
/** Lets everything that can run without a held transaction run (timers phase, twice over the microtask queue). */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
/** What a case compares before and after a refusal: every touch of the store. */
const marks = f => JSON.stringify([f.touched, f.writes, f.audits, f.prepared]);
const superseded = async (f, promise, what) => {
  const before = marks(f);
  const answer = await refusal(promise, 409);
  assert.equal(answer.code, 'REPORT_DRAFT_SUPERSEDED', what);
  assert.doesNotMatch(answer.message, /저장했습니다/, 'the refusal never reads as a stored write');
  assert.equal(marks(f), before, `${what}: nothing is read, written, audited or prepared for the refused write`);
};

test('an ordered write is stored and answered with its order; a write without one is stored and answered as before', async () => {
  const f = fixture();
  const first = await put(f, ordered('one', 1), A);
  assert.deepEqual(first.draftOrder, [PAGE, 1], 'the answer says which order the API kept');
  assert.equal(first.author, A.actor);
  assert.deepEqual(f.row(UID, A.actor), told('one'));
  const plain = await put(f, { ...told('plain'), baseVersion: 0 }, A);
  assert.equal('draftOrder' in plain, false, 'no order was sent, so none is confirmed');
  assert.equal(plain.author, A.actor);
  assert.deepEqual(f.row(UID, A.actor), told('plain'));
  assert.deepEqual(f.audits, [`${A.actor}:report.draft`, `${A.actor}:report.draft`]);
});

test('F03: an earlier write that reaches the API after a later one of its page is refused; the draft stays the later text', async () => {
  const f = fixture();
  // The page sent 1 (its connection was lost on the way), then 2. The API sees 2 first.
  assert.deepEqual((await put(f, ordered('later', 2), A)).draftOrder, [PAGE, 2]);
  await superseded(f, put(f, ordered('earlier', 1), A), 'the earlier write arriving late');
  assert.deepEqual(f.row(UID, A.actor), told('later'));
  // The same write delivered twice is not a newer one either.
  await superseded(f, put(f, ordered('later again', 2), A), 'the same sequence again');
  // A refusal moves nothing: what is at or below the stored sequence stays refused, the page's next write is stored.
  await superseded(f, put(f, ordered('still earlier', 1), A), 'after a refusal');
  assert.deepEqual((await put(f, ordered('next', 3), A)).draftOrder, [PAGE, 3]);
  assert.deepEqual(f.row(UID, A.actor), told('next'));
  assert.deepEqual(f.writes, [`reportDraft.upsert:${A.actor}:${A.actor}`, `reportDraft.upsert:${A.actor}:${A.actor}`]);
});

test('F03: an earlier write the API is still working on finishes first; the later one is stored after it and stays', async () => {
  const f = fixture();
  // The browser lost the connection of write 1, but the API has it: its transaction is open (held here).
  const finishEarlier = f.hold();
  const earlier = put(f, ordered('earlier', 1), A);
  await settle();
  assert.deepEqual([f.prepared.length, f.touched.filter(t => t === 'transaction').length, f.writes], [1, 1, []],
    'the earlier write is inside its transaction and has stored nothing yet');
  // The recovery (write 2) arrives now. It is not handed to the service while the earlier one is unfinished.
  const later = put(f, ordered('later', 2), A);
  await settle();
  assert.deepEqual([f.prepared.length, f.touched.filter(t => t === 'transaction').length, f.writes], [1, 1, []],
    'the later write waits: nothing of it is prepared, read or written while the earlier one is open');
  finishEarlier();
  assert.deepEqual([(await earlier).draftOrder, (await later).draftOrder], [[PAGE, 1], [PAGE, 2]]);
  assert.deepEqual(f.writes, [`reportDraft.upsert:${A.actor}:${A.actor}`, `reportDraft.upsert:${A.actor}:${A.actor}`]);
  assert.deepEqual(f.row(UID, A.actor), told('later'), 'the draft is what the page sent last');
});

test('F03: an earlier write that arrives while the later one is still open waits, and is then refused', async () => {
  const f = fixture();
  const finishLater = f.hold();
  const later = put(f, ordered('later', 2), A);
  await settle();
  const earlier = put(f, ordered('earlier', 1), A);
  await settle();
  assert.deepEqual([f.prepared.length, f.writes], [1, []], 'the earlier write is not decided while the later one is open');
  finishLater();
  assert.deepEqual((await later).draftOrder, [PAGE, 2]);
  const answer = await refusal(earlier, 409);
  assert.equal(answer.code, 'REPORT_DRAFT_SUPERSEDED');
  assert.deepEqual([f.prepared.length, f.writes], [1, [`reportDraft.upsert:${A.actor}:${A.actor}`]],
    'only the later write reached the service');
  assert.deepEqual(f.row(UID, A.actor), told('later'));
});

test('an emptying write keeps its place: an earlier text write arriving late does not bring the text back', async () => {
  const f = fixture();
  await put(f, ordered('typed', 1), A);
  const cleared = await put(f, { ...EMPTY, draftOrder: [PAGE, 3] }, A);
  assert.deepEqual([cleared.cleared, cleared.draftOrder], [true, [PAGE, 3]]);
  assert.equal(f.row(UID, A.actor), null);
  await superseded(f, put(f, ordered('typed before the emptying', 2), A), 'a text write from before the emptying');
  assert.equal(f.row(UID, A.actor), null, 'the emptied draft stays empty');
});

test('a write that was refused or failed leaves no order behind', async () => {
  // Refused by the role gate inside the service (403): the page's next write is stored, and so is a retry of the same text.
  const f = fixture();
  await refusal(put(f, ordered('no role', 5), { ...A, roles: ['technician'] }), 403);
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await put(f, ordered('next', 6), A)).draftOrder, [PAGE, 6]);
  assert.deepEqual(f.row(UID, A.actor), told('next'));
  // Refused for the account binding (another session carrying A's page): nothing is recorded for anyone.
  const g = fixture();
  const answer = await refusal(put(g, ordered('as B', 9), B), 409);
  assert.equal(answer.code, 'REPORT_DRAFT_OWNER_CHANGED', 'the account binding is decided before the order');
  untouched(g, 'another session with an order');
  assert.deepEqual((await put(g, ordered('A after', 1), A)).draftOrder, [PAGE, 1]);
});

test('pages, authors and studies keep their own order', async () => {
  const f = fixture();
  await put(f, ordered('page one', 9), A);
  // Another page of the same reader (another tab) starts its own sequence; the two are not ordered against each other.
  assert.deepEqual((await put(f, ordered('page two', 1, OTHER_PAGE), A)).draftOrder, [OTHER_PAGE, 1]);
  assert.deepEqual(f.row(UID, A.actor), told('page two'));
  await superseded(f, put(f, ordered('page one, earlier', 8), A), 'page one below its own sequence');
  await superseded(f, put(f, ordered('page two again', 1, OTHER_PAGE), A), 'page two at its own sequence');
  // Another reader's draft of the same study is another row: the same page id and a lower sequence are stored.
  const asB = await put(f, { ...told('B'), baseVersion: 0, expectedOwner: [INST, B.sub, B.actor], draftOrder: [PAGE, 1] }, B);
  assert.deepEqual([asB.author, asB.draftOrder], [B.actor, [PAGE, 1]]);
  assert.deepEqual([f.row(UID, B.actor), f.row(UID, A.actor)], [told('B'), told('page two')]);
  // Another study of the same reader, from the same page.
  const OTHER_UID = '2.25.7708';
  assert.deepEqual((await put(f, ordered('other study', 2), A, OTHER_UID)).draftOrder, [PAGE, 2]);
  assert.deepEqual([f.row(OTHER_UID, A.actor), f.row(UID, A.actor)], [told('other study'), told('page two')]);
});

test('a write without draftOrder takes its turn but is never refused for order and changes no order', async () => {
  const f = fixture();
  await put(f, ordered('five', 5), A);
  // An open page from before the order, an insertion or an API client: stored whatever the page's sequence is.
  const plain = await put(f, { ...told('plain'), baseVersion: 0, expectedOwner: OWNER_A }, A);
  assert.equal('draftOrder' in plain, false);
  assert.deepEqual(f.row(UID, A.actor), told('plain'));
  await superseded(f, put(f, ordered('four', 4), A), 'below the sequence the page stored before the plain write');
  assert.deepEqual((await put(f, ordered('six', 6), A)).draftOrder, [PAGE, 6]);
  // Its turn: it is not handed to the service while an earlier write of the row is open.
  const finishSeven = f.hold();
  const seven = put(f, ordered('seven', 7), A);
  await settle();
  const prepared = f.prepared.length, writes = f.writes.length;
  const late = put(f, { ...told('plain, later'), baseVersion: 0 }, A);
  await settle();
  assert.deepEqual([f.prepared.length, f.writes.length], [prepared, writes], 'the plain write waits for the open one');
  finishSeven();
  await seven;
  assert.equal('draftOrder' in await late, false);
  assert.deepEqual(f.row(UID, A.actor), told('plain, later'), 'writes of one row are applied in the order they arrived');
});

test('a malformed draftOrder is a 400 and touches nothing', async () => {
  for (const value of [null, 'syn-page-1', {}, { page: PAGE, seq: 1 }, [], [PAGE], [PAGE, 1, 2], [1, 1], ['', 1], [null, 1],
                       [PAGE, 0], [PAGE, -1], [PAGE, 1.5], [PAGE, '1'], [PAGE, null], [PAGE, 2 ** 53], ['p'.repeat(65), 1]]) {
    const f = fixture();
    await refusal(put(f, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A, draftOrder: value }, A), 400);
    untouched(f, `draftOrder ${JSON.stringify(value)}`);
  }
  // The longest page id the API takes.
  const f = fixture();
  assert.deepEqual((await put(f, ordered('long id', 1, 'p'.repeat(64)), A)).draftOrder, ['p'.repeat(64), 1]);
});

test('an order grants nothing: the role, institution and study gates are unchanged', async () => {
  const f1 = fixture();
  await refusal(put(f1, ordered('no role', 1), { ...A, roles: ['technician'] }), 403);
  const f2 = fixture({ state: { ...STATE, institutionId: OTHER_INST } });
  await refusal(put(f2, ordered('other institution', 1), A), 404);
  const f3 = fixture({ state: { ...STATE, rs: 'P', preDoc: 'doctor-c@synthetic', preReviewer: 'doctor-c@synthetic' } });
  await refusal(put(f3, ordered('preliminary of another reader', 1), A), 403);
  assert.deepEqual([f1.writes, f1.audits, f2.writes, f2.audits, f3.writes, f3.audits], [[], [], [], [], [], []]);
});
