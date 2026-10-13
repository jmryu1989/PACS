'use strict';
/* EMR-D round 5 part (a), a5: the composed clinical runtime for the shared service fixtures (tests/clinician_question_service_test.cjs,
 * tests/image_request_service_test.cjs, tests/reader_assignment_scope_test.cjs) and the storage protocol the recovery cases
 * (tests/emr/d/recovery_test.cjs) already used.
 * REQ-EMR-01/03/07, REQ-S5-U4p, REQ-S7-U3a -> RISK-D-01..04 (an unsigned or unledgered effect, a body without its durable
 * provision, an original terminal rewritten) -> TEST-D-04 and the fixtures' own cases.
 *
 * Real: ClinicalRuntime and SqlClinicalStore as composeClinicalRuntime makes them (once per process: the services' port is
 * bound once, DR2-08), the services' own registered projections, C's v2 verification of a test-only device (device.cjs),
 * A's stored-record reader composed with D's sources, and the response boundary - every answer is read as the client gets
 * it, through ClinicalResponseInterceptor over the controllers' own Nest route metadata.
 * Stand-ins (external ports only): the emr_clinical schema functions as the store calls them - a request register and a
 * version store whose transactions roll back with the case's own tables, savepoints included - B1's ledger (append and
 * confirm, with fault switches), B2's verified request facts and C's study reader, both read from the case's world.
 * Nothing here re-implements a reducer, a permission, a terminal choice or a response body. Synthetic data only.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

/** A unit's stored rows as emr_clinical.unit_for gives them (store.ts unitFromRows reads them back). */
const unitRows = unit => unit.versions.map(v => ({ record_id: unit.recordId, record: unit.record, study_id: unit.studyId,
  managing_institution_id: unit.managingInstitutionId, patient: JSON.stringify(unit.patient), author_id: unit.parties.authorId,
  recipient_id: unit.parties.recipientId, state: unit.state, revision: unit.revision, head_version_id: unit.head.versionId,
  head_sha256: unit.head.sha256, clinical_entry: unit.clinicalEntry, sequence: v.sequence, version_id: v.versionId, body: JSON.stringify(v), signature: null }));

/**
 * The emr_clinical register and version store (the functions of migrations 20261012120000_emr_d and
 * 20261013010000_emr_d_original_decisions, by what the store passes them), keyed by (record, actor, request) and by record.
 * `R` is records.ts (applyPlan), `rows` the unit row mapper. A world (`attach`: its tables' snapshot and restore) is rolled
 * back with the store; `open(name)` gives the client a commit transaction runs on (default: this store's own client).
 */
function database({ R, unitRows: rowsOf = unitRows, attach = null, open = null, done = null } = {}) {
  const rows = new Map(), units = new Map(), events = []; const fault = { sealBefore: 0, sealAfter: 0, confirm: 0, observe: 0, append: 0, checkpoint: null };
  const counts = { admit: 0, commit: 0, project: 0, seal: [] };
  let savepoint = null, queue = Promise.resolve();
  const key = v => JSON.stringify(v.slice(0, 3)), err = code => Object.assign(new Error(code), { meta: { code } });
  const copy = () => ({ rows: structuredClone([...rows]), units: structuredClone([...units]), events: structuredClone(events), world: attach ? attach.snapshot() : null });
  const restore = s => { rows.clear(); for (const [k, v] of s.rows) rows.set(k, v); units.clear(); for (const [k, v] of s.units) units.set(k, v); events.splice(0, events.length, ...s.events); if (attach) attach.restore(s.world); };
  const NOT = Symbol('not emr_clinical');
  /** The stored units and committed originals a RepeatableRead transaction reads: as of its start, as PostgreSQL gives them. */
  function frozen() {
    const kept = { rows: new Map(structuredClone([...rows])), units: new Map(structuredClone([...units])) };
    return async (sql, v) => {
      if (sql.includes('units_for')) return v[0].flatMap(id => (kept.units.has(id) ? rowsOf(kept.units.get(id)) : []));
      if (sql.includes('unit_for')) return kept.units.has(v[0]) ? rowsOf(kept.units.get(v[0])) : [];
      if (sql.includes('response_facts')) return facts(kept.rows, v);
      if (sql.includes('emr_clinical.')) throw new Error('SYN a RepeatableRead read view takes no register statement: ' + sql);
      return NOT;
    };
  }
  const facts = (from, v) => [...from.values()].filter(r => r.state === 'committed' && r.record_id === v[0]).flatMap(r => {
    const proof = JSON.parse(r.terminal).proof;
    return v[1].includes(proof.version.versionId) ? [{ version_id: proof.version.versionId, request_id: proof.receipt.requestId, projection: JSON.stringify(JSON.parse(r.facts).projection) }] : [];
  });
  /** One emr_clinical statement, or NOT when the SQL is the case's own. */
  async function clinical(sql, v) {
    const row = rows.get(key(v));
    if (sql.includes('emr_clinical.lock_request') || sql.includes('lock_request(') || sql.includes('note_attempt')) return [];
    if (sql.includes('units_for')) return v[0].flatMap(id => (units.has(id) ? rowsOf(units.get(id)) : []));
    if (sql.includes('unit_for')) return units.has(v[0]) ? rowsOf(units.get(v[0])) : [];
    if (sql.includes('response_facts')) return facts(rows, v);
    if (sql.includes('observe(')) { if (fault.observe-- > 0) throw new Error('SYN read unavailable'); if (row && row.fingerprint !== v[3]) throw err('ED002'); return row ? [{ ...row, kind: 'observer' }] : []; }
    if (sql.includes('admit(')) {
      if (row) { if (row.fingerprint !== v[3]) throw err('ED002'); return [{ ...row, kind: 'observer' }]; }
      const created = { original_id: randomUUID(), epoch: 1, phase: 'admitted', state: 'pending', fingerprint: v[3], seed: v[4], facts: v[5], envelope: v[6], checkpoint: null, confirmed: false };
      rows.set(key(v), created); counts.admit++; return [{ ...created, kind: 'owner' }];
    }
    if (sql.includes('checkpoint(')) {
      if (fault.checkpoint === v[5]) throw new Error('SYN checkpoint lost');
      if (!row || row.epoch !== v[4] || row.state !== 'pending' || row.rejection_decision) return [{ done: false }];
      row.phase = v[5]; row.checkpoint = v[6]; return [{ done: true }];
    }
    if (sql.includes('commit_version(')) {
      if (!row || row.epoch !== v[4] || row.state !== 'pending' || row.phase !== 'commit-dispatched' || row.rejection_decision) throw err('ED004');
      const version = JSON.parse(v[18]), terminal = JSON.parse(v[20]);
      const unit = units.get(v[5]) ?? null; if ((unit?.revision ?? 0) + 1 !== version.sequence) throw err('ED003');
      units.set(v[5], R.applyPlan(unit, terminal.binding.plan));
      row.state = 'committed'; row.terminal = v[20]; row.access_event = v[21]; row.record_id = v[5]; counts.commit++; return [{ done: true }];
    }
    if (sql.includes('remember_rejection')) {
      if (!row || row.epoch !== v[4] || row.state !== 'pending') return [{ done: false }];
      if (row.rejection_decision && JSON.parse(row.rejection_decision).code !== JSON.parse(v[5]).code) throw err('ED004');
      row.rejection_decision ??= v[5]; return [{ done: true }];
    }
    if (sql.includes('rejection_for')) return [{ decision: [...rows.values()].find(r => r.original_id === v[0])?.rejection_decision ?? null }];
    if (sql.includes('seal_rejected')) {
      counts.seal.push(JSON.parse(v[6]).proof.code);
      if (fault.sealBefore-- > 0) throw new Error('SYN seal before commit');
      if (!row || row.epoch !== v[4] || row.state !== 'pending' || !row.rejection_decision) return [{ done: false }];
      row.state = 'rejected'; row.terminal = v[6]; if (fault.sealAfter-- > 0) throw new Error('SYN seal response lost'); return [{ done: true }];
    }
    if (sql.includes('confirm_request')) { if (fault.confirm-- > 0) throw new Error('SYN confirm lost'); row.confirmed = true; return [{ done: true }]; }
    if (sql.includes('recover(')) { if (!row) return []; if (row.fingerprint !== v[3]) throw err('ED002'); if (row.state !== 'pending') return [{ ...row, kind: 'observer' }]; row.epoch++; return [{ ...row, kind: row.phase === 'commit-dispatched' ? 'fenced' : 'owner' }]; }
    return NOT;
  }
  const executed = strings => {
    const sql = strings.join('?');
    if (sql.startsWith('SAVEPOINT')) { savepoint = copy(); return true; }
    if (sql.startsWith('ROLLBACK TO')) { restore(savepoint); return true; }
    return false;
  };
  const db = { $executeRaw: async strings => { executed(strings); return 0; },
    $queryRaw: async (strings, ...v) => {
      const sql = strings.join('?'), found = await clinical(sql, v);
      if (found === NOT) throw new Error('Unimplemented synthetic SQL ' + sql);
      return found;
    } };
  /** A client of the case's world that also answers the emr_clinical statements and the commit's savepoints; `view` (a
   *  frozen() reader) for a RepeatableRead transaction. */
  const wrap = (base, view = null) => ({ ...base,
    $executeRaw: async (strings, ...v) => (executed(strings) ? 0 : base.$executeRaw(strings, ...v)),
    $queryRaw: async (strings, ...v) => {
      const sql = strings.join('?'), found = view ? await view(sql, v) : await clinical(sql, v);
      return found === NOT ? base.$queryRaw(strings, ...v) : found;
    } });
  const ledger = { withAppendTransaction: work => {
    const run = queue.then(async () => {
      const before = copy(), tx = open ? open() : db;
      try { const result = await work(tx); done?.(tx, 'commit'); return result; } catch (e) { restore(before); done?.(tx, 'rollback'); throw e; }
    });
    queue = run.catch(() => {}); return run;
  }, appendInTransaction: async (_tx, event) => { if (fault.append-- > 0) throw new Error('SYN B append rollback'); events.push(event); return { event }; },
  settleTransaction: async () => {}, confirm: async p => ({ eventId: p.event.eventId, durableAt: new Date().toISOString() }),
  append: async e => ({ eventId: e.eventId, durableAt: new Date().toISOString() }), holdRows: async () => [] };
  return { db, ledger, rows, units, events, fault, counts, wrap, copy, restore, frozen };
}

const uuidOf = text => { const h = createHash('sha256').update(String(text)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const known = value => ({ status: 'known', value });
let composed = null;

/**
 * The one composition of this process. `dist` is the compiled API (/app/dist in the image). A case's world is `use`d
 * when it is built; worlds are used one after another, never at once, so a projection a service registers is the one of
 * the world in use (each service registers its own at construction, as at server start).
 */
function compose(dist = '/app/dist') {
  if (composed) return composed;
  const load = name => require(path.posix.join(dist, name));
  const RT = load('emr-clinical/runtime'), R = load('emr-clinical/records'), B = load('emr-clinical/response'), V = load('emr-contract/validation');
  const C = load('emr-contract/composition'), adapters = load('emr-runtime/context').runtimeAdapters, sources = load('emr-clinical/sources');
  C.composeEmrAdapters({ ...adapters, stored: sources.clinicalStoredReader(adapters.stored) });
  const device = require('./device.cjs')({ K: load('emr-signature/keys'), CV: load('emr-signature/canonical-v2') });
  // The API's own dependencies, found from its compiled tree (the image sets no NODE_PATH for a test mounted elsewhere).
  const dependency = name => require(require.resolve(name, { paths: [dist] }));
  const N = dependency('@nestjs/common'), constants = dependency('@nestjs/common/constants'), { firstValueFrom, of } = dependency('rxjs');
  let current = null;
  const world = () => { if (!current) throw new Error('no case world is in use'); return current; };
  const db = { $queryRaw: (strings, ...v) => world().store.db.$queryRaw(strings, ...v), $executeRaw: (strings, ...v) => world().store.db.$executeRaw(strings, ...v) };
  const ledger = { withAppendTransaction: work => world().store.ledger.withAppendTransaction(work), appendInTransaction: (tx, e) => world().store.ledger.appendInTransaction(tx, e),
    settleTransaction: (...a) => world().store.ledger.settleTransaction(...a), confirm: p => world().provided.confirm(p),
    append: e => world().provided.append(e), holdRows: async () => [] };
  const runtime = RT.composeClinicalRuntime({ db, ledger, context: { facts: async request => world().facts(request) },
    studies: { facts: async (_db, studyId) => world().study(studyId) }, signatures: device.ports, recoveryDelayMs: 3600000 });
  const registered = new Set();
  /** The verified actor B2 gives for a caller of the case (its stable identity, its institution and roles). */
  const actorOf = c => {
    const identity = { id: uuidOf('identity:' + c.sub), issuer: 'https://synthetic.invalid', subject: c.sub };
    const actor = { identity, kind: 'member', roles: [...c.roles], institutionId: c.institution, signingRegistrationId: 'reg-' + identity.id };
    if (!registered.has(identity.id)) { registered.add(identity.id); device.register(identity, actor.signingRegistrationId, c.institution); }
    return actor;
  };
  const routes = new Map();
  /** The routes of the given compiled controllers, by their Nest metadata ("METHOD path"). */
  const route = (controllers, name) => {
    for (const file of controllers) for (const controller of Object.values(load(file)).filter(v => typeof v === 'function')) {
      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[key], method = Reflect.getMetadata(constants.METHOD_METADATA, handler);
        if (method === undefined) continue;
        const at = [Reflect.getMetadata(constants.PATH_METADATA, controller), Reflect.getMetadata(constants.PATH_METADATA, handler)]
          .filter(v => typeof v === 'string').join('/').split('/').filter(Boolean).join('/');
        routes.set(N.RequestMethod[method] + ' ' + at, { controller, handler });
      }
    }
    const found = routes.get(name);
    if (!found) throw new Error('no route ' + name);
    return found;
  };

  /**
   * The world a case builds: `tables` its own snapshot/restore, `transaction()` one client of it for a clinical commit
   * (`finish(client, 'commit' | 'rollback')` when that ends), `studyOf(uid)` the StudyState row C's reader takes the
   * managing institution from, `identityOf(sub)` another member's verified identity. MemberRights follow each caller's
   * roles as their token carries them (the normal case) unless a case pins a row (`pin`). The world is in use from here on.
   */
  function attach({ tables, transaction, finish = () => {}, studyOf, identityOf = sub => ({ id: uuidOf('identity:' + sub), issuer: 'https://synthetic.invalid', subject: sub }) }) {
    const provided = [], fault = { provide: 0, receipt: 0 }, rights = new Map(), pinned = new Set();
    const store = database({ R, attach: tables, open: () => w.client(transaction()), done: (tx, how) => finish(tx, how) });
    const w = {
      store, provided, fault, rights, responses: [],
      know: c => { if (!pinned.has(c.sub)) rights.set(c.sub, { sub: c.sub, approved: true, suspended: false, institution: c.institution, roles: [...c.roles] }); },
      pin: (sub, row) => { pinned.add(sub); rights.set(sub, row); },
      frozen: () => store.frozen(),
      facts: async request => {
        if (!request?.actor) throw new Error('a clinical call needs the request its facts come from');
        return { actor: request.actor, signature: request.signature, requestId: request.requestId, trustedProxyIp: known({ address: '10.0.0.7', source: 'trusted-proxy' }),
          member: async subject => identityOf(subject) };
      },
      study: async studyId => {
        const row = studyOf(studyId);
        if (!row) throw new V.ContractError('NotFound');
        return { studyId, managingInstitutionId: row.institutionId, patient: { linkId: 'syn-link-' + studyId, patientId: 'SYNTHETIC-PATIENT', assigningAuthority: row.institutionId } };
      },
      /** A client of the world that also answers the emr_clinical statements (`view`: a RepeatableRead transaction's
       *  frozen reader) and holds MemberRights. */
      client: (base, view = null) => ({ memberRights: { findUnique: async ({ where }) => structuredClone(rights.get(where.sub) ?? null) }, ...store.wrap(base, view) }),
    };
    w.provided.append = async event => {
      if (fault.provide > 0 && --fault.provide === 0) throw Object.assign(new Error('SYN ledger unavailable'), { name: 'LedgerFailure' });
      provided.push(event);
      return { eventId: fault.receipt > 0 && --fault.receipt === 0 ? 'syn-other-event' : event.eventId, durableAt: new Date().toISOString() };
    };
    w.provided.confirm = async p => store.ledger.confirm(p);
    current = w;
    return w;
  }

  /**
   * The request one call carries (B2's verified actor and C's device signature): a clinical write's device signs the
   * version the server will plan for exactly this body; an operational write and a read carry none.
   */
  async function request(c, { surface = null, body = null, recordId = null, studyId = null } = {}) {
    const actor = actorOf(c), req = { actor, signature: null, requestId: 'syn-request-' + randomUUID() };
    world().know(c);
    if (!surface) return req;
    try {
      const unit = await runtime.unit(recordId), study = await world().study(studyId);
      const plan = R.planClinicalWrite({ surface, actor, study, unit, body, content: null, attachments: [], navigation: [], recipientId: null,
        readerId: null, workContext: null, ids: { recordId, versionId: randomUUID() }, at: new Date().toISOString() });
      if (plan.signing) req.signature = device.sign(plan.signing, { kid: 'kid-' + actor.identity.id, eventId: plan.requestId });
    } catch { /* a write the core refuses is refused by the service with its own answer; nothing to sign */ }
    return req;
  }

  /** What the client gets for `value` on `name` (the route's handler metadata through the response boundary), as JSON. */
  async function answer(controllers, name, value, req) {
    const { controller, handler } = route(controllers, name), writes = [];
    const response = Object.fromEntries(['write', 'end', 'send', 'json', 'render', 'writeHead', 'flushHeaders'].map(k => [k, () => writes.push(k)]));
    const context = { getHandler: () => handler, getClass: () => controller, switchToHttp: () => ({ getRequest: () => req, getResponse: () => response }) };
    const observation = { writes, bodies: 0 };
    world().responses.push(observation);
    try {
      const result = new B.ClinicalResponseInterceptor().intercept(context, { handle: () => of(value) });
      const body = JSON.parse(JSON.stringify(await firstValueFrom(result)));
      observation.bodies++;
      return body;
    } finally {
      // A refusal must not bypass observation, and assertion failures must not become ordinary HTTP refusals.
      assert.deepEqual(writes, [], 'response bytes before the boundary');
    }
  }

  composed = { runtime, device, R, load, attach, request, answer, actorOf, uuidOf };
  return composed;
}

module.exports = { database, unitRows, compose, uuidOf };
