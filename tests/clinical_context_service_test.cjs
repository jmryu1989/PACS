'use strict';
/* TEST-S7-U4a-SERVICE: the compiled Clinical Context service (GET studies/:uid/clinical-context) over a stub store and a
 * recording Orthanc, cases CC-S01...CC-S14 of contract S7-U4p section 11.1 (Astra S7-U4p-D-R-001 ACCEPT, D-S7-11 (b)).
 *
 * REQ-S7-U4p-SOURCES / ORDER-EXCLUDED / PATIENT-KEY / PROVENANCE / ACCESS-BASIS / READ-RULE / CONSISTENCY / READ-ONLY /
 *   STATES / STALE-BASELINE / ROUTE
 *   -> RISK-S7-U4a-TENANT / CROSS-PATIENT / NONFINAL, RISK-S7-U4p-UNSOURCED / WIDER-READ / SEED-AS-AUTHORITY /
 *      ORDER-VIA-OVERLAY / KEY-WIDENING / ABSENT-OVERCLAIM / MEMBER-CHANGE / READ-WRITES
 *   -> TEST-S7-U4a-SERVICE (this file).
 *
 * The real StudyAccessService, PacsService (institution display names only) and controller run from /app/dist; only Prisma
 * and Orthanc are stubs. The stubs answer by what a call means, never by SQL text: a Prisma delegate call by its model,
 * method and arguments (where/select/orderBy); a raw statement by its arguments - the StudyAccess lock key, the caller's
 * subject for the policy row, a joined list of study UIDs for the R7(a) re-read. A RepeatableRead transaction reads a copy
 * of the store taken when it starts; the root client reads the live store. `w.at(event, step)` runs a step once, right
 * after that event, as a commit landing between two reads (the CC-S08 barriers). Every call is logged in order, so
 * "no Orthanc call inside the transaction callback" and "R7(a) is one statement after the transaction" are read from one
 * event list. Assertions are on the answer, the HTTP errors and the recorded calls; none reads product source text.
 * Hosted in kin-api:ci (validate.yml runtime, tmp/runtime-ci/clinical-context-service); no /app/dist exists on a
 * development host. Synthetic data only: SYN-* values, no network, no database, no clinical data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClinicalContextService } = require('/app/dist/clinical-context.service');
const { ClinicalContextController } = require('/app/dist/clinical-context.controller');
const policy = require('/app/dist/clinical-context-policy');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { PacsService } = require('/app/dist/pacs.service');
const { OrthancService } = require('/app/dist/orthanc.service');

// Contract S7-U4p uxr-trace.json (docs fc7680b): the closed response keys and the forbidden key names (section 3.1, 9.1).
const RESPONSE_KEYS = ['kind', 'recordId', 'version', 'author', 'recordedAt', 'observedAt', 'state', 'reason', 'sourceLabel',
  'truncated', 'items', 'access', 'institutionName', 'techNoteVersion', 'schema', 'uid', 'patientKey', 'anchor', 'identity',
  'conflict', 'birth', 'sex', 'sections', 'priorReports', 'history', 'requestTags', 'checked', 'techNote', 'date', 'modalities',
  'description', 'studyUid', 'study', 'report', 'action', 'findings', 'conclusion', 'recommendation', 'provenance', 'accession',
  'reading', 'rs', 'signed', 'reportVersion', 'tag', 'keyword', 'vr', 'value', 'note', 'hasText'];
const FORBIDDEN_FRAGMENTS = ['order', 'oid', 'ward', 'reqdoc', 'reqhosp', 'sched', 'matched', 'draft', 'holder', 'predoc',
  'prereviewer', 'holdreason'];
const FORBIDDEN_EXACT = ['ov', 'orig'];
const FIVE = ['00321030', '00401002', '001021B0', '00081080', '00324000'];
const LABELS = { priorReports: 'KIN signed report (head version)', history: 'DICOM study + KIN study state',
  requestTags: 'DICOM header (one original instance)', techNote: 'KIN Tech Note' };
const KINDS = { priorReports: 'kin.report-version', history: 'dicom.study+kin.study-state',
  requestTags: 'dicom.instance-header', techNote: 'kin.tech-note' };
const READ_HELPERS = ['studies', 'contextLookup', 'contextSeries', 'contextInstances', 'contextHeader', 'studyAccessMetadata',
  'studyIdentities'];
const WRITE_METHODS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const A = 'synthetic-a', B = 'synthetic-b', C = 'synthetic-c';
const NAMES = [{ id: A, name: 'SYN Hospital A' }, { id: B, name: 'SYN Center B' }, { id: C, name: 'SYN Clinic C' }];
const member = (name, roles, institution = A) => ({ kind: 'member', institution, sub: 'syn-' + name + '-sub',
  actor: 'syn-' + name, roles });
const reader = member('reader', ['radiologist']);
const admin = member('admin', ['admin']);
const teleReader = member('tele-reader', ['radiologist'], B);
const ANCHOR = '2.25.7001';
const T0 = new Date('2026-09-01T00:00:00.000Z');

let serial = 0;
const orthancId = () => ('00000000-00000000-00000000-00000000-' + (++serial).toString(16).padStart(8, '0'));

/**
 * One synthetic study. `state: null` = no StudyState row (Orthanc only); `orthanc: false` = no Orthanc study.
 * series: [{ modality, uid, instances: [{ sop, tags }] }] - tags are Orthanc /tags entries keyed 'gggg,eeee'.
 */
function study(uid, o = {}) {
  return {
    uid, pid: o.pid ?? 'SYN-PID-1', birth: o.birth ?? '19700101', sex: o.sex ?? 'F', date: o.date ?? '20260101',
    modalities: o.modalities ?? ['CT'], desc: o.desc ?? 'SYN DESC ' + uid, acc: o.acc ?? 'SYN-ACC-' + uid.split('.').pop(),
    name: o.name ?? 'SYN^PATIENT', orthanc: o.orthanc ?? true,
    state: o.state === null ? null : { institutionId: A, teleInstitutionId: null, rs: 'W', preDoc: null, preReviewer: null,
      createdAt: T0, updatedAt: T0, ...(o.state ?? {}) },
    report: o.report ?? null, versions: o.versions ?? [], notes: o.notes ?? [],
    series: o.series ?? [{ modality: 'CT', uid: uid + '.1', instances: [{ sop: uid + '.1.1', tags: {} }] }],
  };
}

/** A signed head at version v (approve) with a body marker. */
const signedAt = (v, marker, action = 'approve') => ({ state: { rs: 'A' }, report: { version: v, findings: 'REPORT-TABLE-' + marker },
  versions: Array.from({ length: v }, (_, i) => ({ version: i + 1, action: i + 1 === v ? action : 'approve',
    findings: 'BODY-' + marker + '-v' + (i + 1), conclusion: 'CONCLUSION-' + marker, recommendation: 'REC-' + marker,
    author: 'syn-signer', at: new Date(T0.getTime() + 60000 * (i + 1)) })) });

function world(studies, { policies = {}, orders = true } = {}) {
  const events = [], calls = { orthanc: [], delegates: [], raw: [], execute: [], rechecks: [] };
  const store = { states: new Map(), reports: new Map(), versions: [], notes: [], policies: new Map(),
    orders: orders ? [{ oid: 'SENTINEL-OID-1', patientId: 'SENTINEL-ORDER-PID', name: 'SENTINEL^ORDER', descr: 'SENTINEL-DESCR',
      ward: 'SENTINEL-WARD', reqDoc: 'SENTINEL-REQDOC', sched: 'SENTINEL-SCHED', institutionId: A, matched: 'M' }] : [] };
  let versionId = 100;
  for (const s of studies) {
    if (s.state) store.states.set(s.uid, { uid: s.uid, ...s.state });
    if (s.report) store.reports.set(s.uid, { uid: s.uid, findings: '', conclusion: '', recommendation: '', ...s.report });
    for (const v of s.versions) store.versions.push({ id: ++versionId, uid: s.uid, findings: '', conclusion: '', recommendation: '',
      reason: null, author: 'syn-doctor', at: T0, ...v });
    for (const n of s.notes) store.notes.push({ studyUid: s.uid, reason: 'SYN-NOTE-REASON', authorSub: 'syn-tech-sub',
      institutionId: A, createdAt: T0, ...n });
  }
  for (const [subject, { __row, ...p }] of Object.entries(policies)) store.policies.set(subject, { institution: A, revision: 1,
    policy: p, reason: 'SYN policy', updatedBy: 'syn-admin', updatedAt: T0, ...(__row ?? {}) });
  const w = { events, calls, store, studies, fail: {} };
  const hooks = new Map();
  w.at = (event, step) => hooks.set(event, step);
  const log = async event => {
    events.push(event);
    const step = hooks.get(event);
    if (step) { hooks.delete(event); await step(); }
  };
  w.pending = () => [...hooks.keys()];

  const project = (row, select) => {
    if (!select) return { ...row };
    const out = {};
    for (const [key, on] of Object.entries(select)) if (on === true && Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
    return out;
  };
  const isJoin = v => !!v && typeof v === 'object' && Array.isArray(v.values) && Array.isArray(v.strings);
  const query = async (view, scope, strings, values) => {
    calls.raw.push({ scope, sql: strings.join('?'), values });
    if (values.length === 1 && typeof values[0] === 'string' && values[0].startsWith('study-access:')) {
      await log(scope + ':lock');
      return [{ locked: 1 }];
    }
    const joined = values.find(isJoin);
    if (joined) {
      // The R7(a) re-read: the listed studies' current institution, tele, RS, P pair and head version, and the anchor's latest
      // Tech Note version - read from the live store, as one statement after the transaction reads it.
      const anchor = values.find(v => typeof v === 'string');
      const noteVersion = Math.max(0, ...view.notes.filter(n => n.studyUid === anchor).map(n => n.version));
      const rows = joined.values.filter(uid => view.states.has(uid)).map(uid => {
        const s = view.states.get(uid);
        return { uid, institutionId: s.institutionId, teleInstitutionId: s.teleInstitutionId, rs: s.rs, preDoc: s.preDoc,
          preReviewer: s.preReviewer, reportVersion: view.reports.get(uid)?.version ?? 0, techNoteVersion: noteVersion };
      });
      calls.rechecks.push({ scope, uids: [...joined.values], anchor, rows: structuredClone(rows) });
      await log(scope + ':recheck');
      return rows;
    }
    if (values.length === 2 && values.every(v => typeof v === 'string')) {
      const row = view.policies.get(values[0]);
      await log(scope + ':policy');
      return row ? [{ ...row }] : [];
    }
    throw new Error('a raw statement the stub cannot read by its arguments');
  };
  const delegate = (view, scope, model) => new Proxy({}, { get: (_t, method) => async (args = {}) => {
    calls.delegates.push({ scope, model, method: String(method), args });
    await log(scope + ':' + model + '.' + String(method));
    const where = args.where ?? {};
    if (model === 'studyState' && method === 'findUnique') {
      const row = view.states.get(where.uid);
      return row ? project(row, args.select) : null;
    }
    if (model === 'studyState' && method === 'findMany')
      return [...view.states.values()].filter(r => where.uid.in.includes(r.uid)).map(r => project(r, args.select));
    if (model === 'report' && method === 'findMany')
      return [...view.reports.values()].filter(r => where.uid.in.includes(r.uid)).map(r => project(r, args.select));
    if (model === 'reportVersion' && method === 'findMany') {
      const rows = where.OR ? view.versions.filter(v => where.OR.some(p => p.uid === v.uid && p.version === v.version))
        : where.id?.in ? view.versions.filter(v => where.id.in.includes(v.id)) : null;
      if (!rows) throw new Error('a ReportVersion read the stub does not model');
      return rows.map(r => project(r, args.select));
    }
    if (model === 'techNoteRevision' && method === 'findFirst') {
      assert.deepEqual(args.orderBy, { version: 'desc' }, 'the latest note');
      const rows = view.notes.filter(n => n.studyUid === where.studyUid).sort((a, b) => b.version - a.version);
      return rows.length ? project(rows[0], args.select) : null;
    }
    if (WRITE_METHODS.includes(String(method))) return {};
    return String(method).startsWith('findMany') ? [] : null;
  } });
  const client = (view, scope) => new Proxy({}, { get: (_t, name) => {
    if (name === 'then') return undefined;
    if (name === '$queryRaw') return (strings, ...values) => query(view, scope, strings, values);
    if (name === '$executeRaw') return async (strings) => { calls.execute.push({ scope, sql: strings.join('?') }); await log(scope + ':execute'); return 0; };
    if (name === '$transaction' && scope === 'root') return async (fn, options) => {
      calls.delegates.push({ scope, model: '$transaction', method: 'call', args: options });
      if (w.fail.transaction) throw w.fail.transaction;
      const view = options?.isolationLevel === 'RepeatableRead' ? structuredClone(store) : store;
      await log('tx:start');
      const result = await fn(client(view, 'tx'));
      await log('tx:end');
      return result;
    };
    return delegate(view, scope, String(name));
  } });
  const prisma = client(store, 'root');

  // Orthanc: every member the service stack touches is recorded, not only the ones it may use.
  const ids = new Map();
  const idOf = key => { if (!ids.has(key)) ids.set(key, orthancId()); return ids.get(key); };
  const inOrthanc = () => w.studies.filter(s => s.orthanc);
  const qido = s => {
    const v = (vr, value) => value === '' || value == null ? { vr } : { vr, Value: [value] };
    return { '0020000D': { vr: 'UI', Value: [s.uid] }, '00100020': v('LO', s.pid), '00100030': v('DA', s.birth),
      '00100040': v('CS', s.sex), '00080020': v('DA', s.date), '00080061': { vr: 'CS', Value: s.modalities },
      '00081030': v('LO', s.desc), '00080050': v('SH', s.acc), '00100010': { vr: 'PN', Value: [{ Alphabetic: s.name }] },
      '00080080': v('LO', 'SYN') };
  };
  const handlers = {
    studies: async () => { if (w.fail.studies) throw w.fail.studies; return inOrthanc().map(qido); },
    studyIdentities: async () => inOrthanc().map(qido),
    studyAccessMetadata: async uid => { const s = inOrthanc().find(x => x.uid === uid); return s ? qido(s) : null; },
    contextLookup: async uid => {
      if (w.fail.lookup) throw w.fail.lookup;
      const s = inOrthanc().find(x => x.uid === uid);
      return s ? [{ ID: idOf('study:' + uid), Path: '/studies/' + idOf('study:' + uid), Type: 'Study' }] : [];
    },
    contextSeries: async id => {
      if (w.fail.series) throw w.fail.series;
      const s = inOrthanc().find(x => idOf('study:' + x.uid) === id);
      return s.series.map(se => ({ ID: idOf('series:' + se.uid), Type: 'Series',
        MainDicomTags: { Modality: se.modality, SeriesInstanceUID: se.uid }, Instances: se.instances.map(i => idOf('instance:' + i.sop)) }));
    },
    contextInstances: async id => {
      for (const s of inOrthanc()) for (const se of s.series) if (idOf('series:' + se.uid) === id)
        return se.instances.map(i => ({ ID: idOf('instance:' + i.sop), Type: 'Instance', MainDicomTags: { SOPInstanceUID: i.sop } }));
      return [];
    },
    contextHeader: async id => {
      if (w.fail.header) throw w.fail.header;
      for (const s of inOrthanc()) for (const se of s.series) for (const i of se.instances) if (idOf('instance:' + i.sop) === id)
        return { '0008,0018': { Name: 'SOPInstanceUID', Type: 'String', Value: i.sop },
          '0008,0060': { Name: 'Modality', Type: 'String', Value: se.modality }, ...i.tags };
      return {};
    },
  };
  const orthanc = new Proxy({}, { get: (_t, name) => {
    if (name === 'then') return undefined;
    return async (...args) => {
      calls.orthanc.push({ name: String(name), args });
      await log('orthanc:' + String(name));
      const handler = handlers[name];
      return handler ? handler(...args) : null;
    };
  } });
  w.prisma = prisma;
  w.orthanc = orthanc;
  w.access = new StudyAccessService(prisma, orthanc, {});
  w.pacs = new PacsService(prisma, orthanc, {}, w.access, {});
  w.pacs.institutions = NAMES.map(n => ({ ...n }));
  w.service = new ClinicalContextService(prisma, orthanc, w.access, w.pacs);
  w.controller = new ClinicalContextController(w.service);
  return w;
}

/** Calls the real controller; answers { status, body } for 200 and for every HTTP error. */
async function call(w, caller, uid = ANCHOR, query = {}) {
  try {
    const body = await w.controller.read(uid, query, { ...caller });
    return { status: 200, body: JSON.parse(JSON.stringify(body)) };
  } catch (error) {
    if (typeof error?.getStatus !== 'function') throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}
async function ok(w, caller, uid = ANCHOR) {
  const result = await call(w, caller, uid);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(policy.clinicalContextShapeError(result.body), null, 'the answer passes the closed-shape check');
  return result.body;
}
const uidsOf = section => section.items.map(item => item.studyUid);
function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const item of value) deepKeys(item, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.add(key); deepKeys(item, out); }
  return out;
}
const inTransaction = w => {
  const inside = [];
  let open = false;
  for (const event of w.events) {
    if (event === 'tx:start') open = true; else if (event === 'tx:end') open = false;
    else if (open && event.startsWith('orthanc:')) inside.push(event);
  }
  return inside;
};

/** Every section present: one signed prior, one history row, a header with a tag, a Tech Note. */
function fullWorld(extra = {}) {
  return world([
    study(ANCHOR, { notes: [{ version: 1, text: 'SYN-NOTE-TEXT', author: 'syn-tech', createdAt: new Date('2026-09-02T00:00:00.000Z') }],
      series: [{ modality: 'CT', uid: ANCHOR + '.1', instances: [{ sop: ANCHOR + '.1.1', tags: {
        '0032,1030': { Name: 'RETIRED_ReasonForStudy', Type: 'String', Value: 'SYN reason' } } }] }] }),
    study('2.25.7002', { date: '20250101', ...signedAt(1, 'P7002'), state: { rs: 'A', createdAt: new Date('2026-08-01T00:00:00.000Z') } }),
  ], extra);
}

// ── CC-S01 provenance ──

test('CC-S01 every item of an all-present answer carries the six provenance fields of section 5.1', async () => {
  const w = fullWorld();
  const answer = await ok(w, reader);
  for (const name of ['priorReports', 'history', 'requestTags', 'techNote']) assert.equal(answer.sections[name].state, 'present', name);
  const head = w.store.versions.find(v => v.uid === '2.25.7002' && v.version === 1);
  assert.deepEqual(answer.sections.priorReports.items[0].provenance, { kind: KINDS.priorReports, recordId: String(head.id),
    version: 1, author: 'syn-signer', recordedAt: head.at.toISOString(), observedAt: answer.sections.priorReports.observedAt });
  assert.deepEqual(answer.sections.history.items[0].provenance, { kind: KINDS.history, recordId: '2.25.7002', version: null,
    author: null, recordedAt: '2026-08-01T00:00:00.000Z', observedAt: answer.sections.history.observedAt });
  assert.deepEqual(answer.sections.requestTags.items[0].provenance, { kind: KINDS.requestTags, recordId: ANCHOR + '.1.1',
    version: null, author: null, recordedAt: null, observedAt: answer.sections.requestTags.observedAt });
  assert.deepEqual(answer.sections.techNote.items[0].provenance, { kind: KINDS.techNote, recordId: ANCHOR + '#1', version: 1,
    author: 'syn-tech', recordedAt: '2026-09-02T00:00:00.000Z', observedAt: answer.sections.techNote.observedAt });
  for (const name of ['priorReports', 'history', 'requestTags', 'techNote']) {
    assert.match(answer.sections[name].observedAt, ISO, name);
    assert.equal(answer.sections[name].sourceLabel, LABELS[name], name);
  }
  assert.match(answer.observedAt, ISO);
});

test('CC-S01 an item missing a provenance field is not made; its section alone is failed/source_invalid', async () => {
  const w = fullWorld();
  delete w.store.versions.find(v => v.uid === '2.25.7002').at;          // ReportVersion.at missing
  let answer = await ok(w, reader);
  assert.deepEqual([answer.sections.priorReports.state, answer.sections.priorReports.reason, answer.sections.priorReports.items],
    ['failed', 'source_invalid', []]);
  assert.equal(answer.sections.history.state, 'present', 'the other sections keep their state');
  const v = fullWorld();
  delete v.store.states.get('2.25.7002').createdAt;                      // StudyState.createdAt missing
  answer = await ok(v, reader);
  assert.deepEqual([answer.sections.history.state, answer.sections.history.reason], ['failed', 'source_invalid']);
  assert.equal(answer.sections.priorReports.state, 'present');
});

// ── CC-S02 read rules and roles ──

test('CC-S02 members are included exactly when the caller may read them now (owner/tele x StudyAccess)', async () => {
  const at = (uid, state, extra = {}) => study(uid, { state, ...extra });
  const studies = [
    at(ANCHOR, { teleInstitutionId: B }),
    at('2.25.7101', {}),                                                  // A-owned, not tele: B cannot read
    at('2.25.7102', { teleInstitutionId: B }),                            // tele to B
    at('2.25.7103', { institutionId: C, teleInstitutionId: B }),          // same PatientID at C: another key
    at('2.25.7104', { institutionId: null }),                             // unassigned
    at('2.25.7105', { teleInstitutionId: C }),                            // tele to another institution
    at('2.25.7106', { teleInstitutionId: B }, { modalities: ['MR'] }),    // tele to B, fails a modality rule
  ];
  const owner = await ok(world(studies), reader);
  assert.deepEqual(uidsOf(owner.sections.history).sort(), ['2.25.7101', '2.25.7102', '2.25.7105', '2.25.7106']);
  const tele = await ok(world(studies), teleReader);
  assert.deepEqual(uidsOf(tele.sections.history).sort(), ['2.25.7102', '2.25.7106']);
  const restrict = (uids, modalities = []) => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
    rules: [{ patientId: null, modalities, dateFrom: null, dateTo: null, studyUids: uids }] });
  const byUid = await ok(world(studies, { policies: { [teleReader.sub]: { ...restrict([ANCHOR, '2.25.7106']), __row: { institution: B } } } }), teleReader);
  assert.deepEqual(uidsOf(byUid.sections.history), ['2.25.7106'], 'a UID rule leaves out 7102');
  const byTag = await ok(world(studies, { policies: { [teleReader.sub]: { ...restrict([], ['CT']), __row: { institution: B } } } }), teleReader);
  assert.deepEqual(uidsOf(byTag.sections.history), ['2.25.7102'], 'an original-tag rule leaves out the MR study');
  const excluded = await call(world(studies, { policies: { [teleReader.sub]: { ...restrict(['2.25.7102']), __row: { institution: B } } } }), teleReader);
  assert.equal(excluded.status, 404, 'a policy that excludes the anchor is 404');
  // the pure rule behind the table
  assert.equal(policy.contextAccess({ institutionId: A, teleInstitutionId: null }, A), 'owner');
  assert.equal(policy.contextAccess({ institutionId: A, teleInstitutionId: B }, B), 'tele');
  assert.equal(policy.contextAccess({ institutionId: A, teleInstitutionId: null }, B), null);
  assert.equal(policy.contextAccess({ institutionId: null, teleInstitutionId: null }, A), null);
  assert.equal(policy.contextAccess(null, A), null);
});

test('CC-S02 roles: radiologist, admin and a mixed clinician+radiologist pass; technician-only and clinician-only are 403', async () => {
  // A mixed user keeps its legacy role (RISK-S5-U1c-MIXED-DOWNGRADE): the controller's second line refuses clinician-only,
  // never "has clinician". This case, not a source pin, is what clinician_policy_fixtures.json behaviour_checked_sites names.
  for (const caller of [reader, admin, member('mixed', ['clinician', 'radiologist']), member('mixed-admin', ['clinician', 'admin'])]) {
    assert.equal((await call(fullWorld(), caller)).status, 200, caller.actor);
  }
  const techWorld = fullWorld();
  const tech = await call(techWorld, member('tech', ['technician']));
  assert.deepEqual([tech.status, tech.body.code], [403, 'CLINICAL_CONTEXT_ROLE']);
  assert.deepEqual([techWorld.calls.delegates.length, techWorld.calls.orthanc.length], [0, 0], 'refused before any read');
  const mixedTech = await call(fullWorld(), member('mixed-tech', ['clinician', 'technician']));
  assert.deepEqual([mixedTech.status, mixedTech.body.code], [403, 'CLINICAL_CONTEXT_ROLE']);
  const w = fullWorld();
  const clinician = await call(w, member('clinician', ['clinician']));
  assert.deepEqual([clinician.status, clinician.body], [403, { code: 'CLINICIAN_ROUTE_DENIED' }]);
  assert.deepEqual([w.calls.delegates.length, w.calls.orthanc.length], [0, 0], 'refused before any read');
  const gateway = await call(fullWorld(), { ...reader, kind: 'gateway' });
  assert.equal(gateway.status, 403);
});

test('CC-S02 R1 input: a malformed UID or any query key is 400 CLINICAL_CONTEXT_INPUT_INVALID before any read', async () => {
  for (const [uid, query] of [['1.2.03', {}], ['../x', {}], ['1.2.' + '3'.repeat(70), {}], [ANCHOR, { limit: '1' }], [ANCHOR, { x: '' }]]) {
    const w = fullWorld();
    const result = await call(w, reader, uid, query);
    assert.deepEqual([result.status, result.body.code], [400, 'CLINICAL_CONTEXT_INPUT_INVALID'], uid + JSON.stringify(query));
    assert.deepEqual([w.calls.delegates.length, w.calls.orthanc.length], [0, 0]);
  }
});

test('CC-S02 a missing study, another institution, a closed tele and a StudyAccess exclusion answer the same 404 bytes', async () => {
  const bodies = [];
  bodies.push((await call(fullWorld(), reader, '2.25.9999')).body);                                   // no StudyState
  bodies.push((await call(world([study(ANCHOR, { state: { institutionId: C } })]), reader)).body);  // another institution
  bodies.push((await call(world([study(ANCHOR, { state: { teleInstitutionId: null } })]), teleReader)).body); // tele closed
  const restricted = { version: 1, restricted: true, startsAt: null, endsAt: null,
    rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: ['2.25.1'] }] };
  bodies.push((await call(fullWorld({ policies: { [reader.sub]: restricted } }), reader)).body);
  for (const body of bodies) assert.equal(JSON.stringify(body), JSON.stringify(bodies[0]));
  assert.equal(bodies[0].statusCode, 404);
});

// ── CC-S03 signed head only ──

test('CC-S03 only a signed head is a prior report, with the head row\'s own body', async () => {
  const P = (uid, extra) => study(uid, extra);
  const w = world([
    study(ANCHOR),
    P('2.25.7301', signedAt(1, 'APPROVE')),
    P('2.25.7302', signedAt(2, 'ADDENDUM', 'addendum')),
    P('2.25.7303', { state: { rs: 'A' }, report: { version: 1 }, versions: [{ version: 1, action: 'save', findings: 'BODY-SAVEHEAD' }] }),
    P('2.25.7304', { state: { rs: 'T' }, report: { version: 1 }, versions: [{ version: 1, action: 'save', findings: 'BODY-T' }] }),
    P('2.25.7305', { state: { rs: 'P', preDoc: reader.actor, preReviewer: 'syn-senior' }, report: { version: 1 },
      versions: [{ version: 1, action: 'save', findings: 'BODY-P' }] }),
    P('2.25.7306', { state: { rs: 'H' }, report: { version: 1 }, versions: [{ version: 1, action: 'save', findings: 'BODY-H' }] }),
    P('2.25.7307', { state: { rs: 'W' }, report: { version: 2 }, versions: [{ version: 1, action: 'approve', findings: 'BODY-RESET-OLD' },
      { version: 2, action: 'reset', findings: 'BODY-RESET', reason: 'SYN reason' }] }),
    P('2.25.7308', { state: { rs: 'A' }, report: { version: 3 }, versions: [{ version: 1, action: 'approve', findings: 'BODY-NOHEAD' }] }),
  ]);
  const answer = await ok(w, reader);
  assert.deepEqual(uidsOf(answer.sections.priorReports).sort(), ['2.25.7301', '2.25.7302']);
  const byUid = new Map(answer.sections.priorReports.items.map(item => [item.studyUid, item]));
  assert.deepEqual(byUid.get('2.25.7301').report, { version: 1, action: 'approve', findings: 'BODY-APPROVE-v1',
    conclusion: 'CONCLUSION-APPROVE', recommendation: 'REC-APPROVE' });
  assert.deepEqual([byUid.get('2.25.7302').report.version, byUid.get('2.25.7302').report.action, byUid.get('2.25.7302').report.findings],
    [2, 'addendum', 'BODY-ADDENDUM-v2']);
  const text = JSON.stringify(answer);
  for (const marker of ['REPORT-TABLE-', 'BODY-ADDENDUM-v1', 'BODY-SAVEHEAD', 'BODY-T', 'BODY-P', 'BODY-H', 'BODY-RESET',
    'BODY-NOHEAD', 'SYN reason']) assert.ok(!text.includes(marker), marker);
  const history = new Map(answer.sections.history.items.map(item => [item.studyUid, item.reading]));
  assert.deepEqual(history.get('2.25.7305'), { rs: 'P', signed: false, reportVersion: 1 }, 'P is history only, even for the P pair');
  assert.deepEqual(history.get('2.25.7308'), { rs: 'A', signed: false, reportVersion: 3 }, 'no head row is not signed');
  // bodies are read only for the signed heads that are shown
  const bodyReads = w.calls.delegates.filter(d => d.model === 'reportVersion' && d.args.where?.id);
  assert.equal(bodyReads.length, 1);
  const shownIds = w.store.versions.filter(v => ['2.25.7301', '2.25.7302'].includes(v.uid) && v.version === w.store.reports.get(v.uid).version).map(v => v.id);
  assert.deepEqual([...bodyReads[0].args.where.id.in].sort(), shownIds.sort());
  const headReads = w.calls.delegates.filter(d => d.model === 'reportVersion' && d.args.where?.OR);
  for (const read of headReads) for (const key of ['findings', 'conclusion', 'recommendation'])
    assert.notEqual(read.args.select?.[key], true, 'the head metadata read carries no body');
});

// ── CC-S04 exact key ──

test('CC-S04 the patient key is exact: name, overlay and wildcard look-alikes stay out, the key is institution|PatientID', async () => {
  const w = world([
    study(ANCHOR, { pid: 'SYN-PID-1', name: 'SYN^SAME' }),
    study('2.25.7401', { pid: 'SYN-PID-2', name: 'SYN^SAME' }),                                      // same name, another ID
    study('2.25.7402', { pid: 'SYN-PID-1', state: { institutionId: C, teleInstitutionId: A } }),     // same ID at C (tele to A)
    study('2.25.7403', { pid: 'SYN-PID-9', state: { ov: JSON.stringify({ id: 'SYN-PID-1' }) } }),     // overlay says the anchor's ID
    study('2.25.7404', { pid: 'SYN-PID-1' }),
    study('2.25.7405', { pid: 'SYN-PID-1', state: null }),                                          // Orthanc only
  ]);
  const answer = await ok(w, reader);
  assert.deepEqual(uidsOf(answer.sections.history), ['2.25.7404']);
  assert.equal(answer.patientKey, A + '|SYN-PID-1');
  assert.equal(w.store.states.has('2.25.7405'), false, 'the read registers nothing');
  for (const pid of ['A*', 'A?', 'A\\B', 'A,B']) {
    const v = world([study(ANCHOR, { pid }), study('2.25.7411', { pid }), study('2.25.7412', { pid: 'AX' }),
      study('2.25.7413', { pid: 'AB' }), study('2.25.7414', { pid: 'A' })]);
    const got = await ok(v, reader);
    assert.deepEqual(uidsOf(got.sections.history), ['2.25.7411'], pid);
    assert.equal(got.patientKey, A + '|' + pid);
    const sent = JSON.stringify(v.calls.orthanc.map(c => c.args));
    assert.ok(!sent.includes(JSON.stringify(pid).slice(1, -1)), 'no Orthanc query carries the PatientID ' + pid);
  }
});

// ── CC-S05 D8 relation ──

test('CC-S05 D8: match, mismatch and not_comparable per row and overall; no birth or sex value is sent', async () => {
  const w = world([
    study(ANCHOR, { birth: '19700101', sex: 'F' }),
    study('2.25.7501', { birth: '19700101', sex: 'F' }),
    study('2.25.7502', { birth: '19810203', sex: 'F' }),
    study('2.25.7503', { birth: '', sex: 'O' }),
  ]);
  const answer = await ok(w, reader);
  assert.deepEqual(answer.identity, { conflict: true, birth: 'mismatch', sex: 'not_comparable' });
  const rows = new Map(answer.sections.history.items.map(item => [item.studyUid, item.identity]));
  assert.deepEqual(rows.get('2.25.7501'), { birth: 'match', sex: 'match' });
  assert.deepEqual(rows.get('2.25.7502'), { birth: 'mismatch', sex: 'match' });
  assert.deepEqual(rows.get('2.25.7503'), { birth: 'not_comparable', sex: 'not_comparable' });
  const text = JSON.stringify(answer);
  for (const value of ['19700101', '19810203']) assert.ok(!text.includes(value), value);
  const same = await ok(world([study(ANCHOR, { sex: 'M' }), study('2.25.7511', { sex: 'M' })]), reader);
  assert.deepEqual(same.identity, { conflict: false, birth: 'match', sex: 'match' });
  const sexOnly = await ok(world([study(ANCHOR, { sex: 'M' }), study('2.25.7521', { sex: 'F' })]), reader);
  assert.deepEqual(sexOnly.identity, { conflict: true, birth: 'match', sex: 'mismatch' });
});

// ── CC-S06 order exclusion ──

test('CC-S06 no order value: sentinel Match copies and Order rows never reach the answer; Order is never read', async () => {
  const copies = { matched: 'M', orderOid: 'SENTINEL-OID-1', ward: 'SENTINEL-WARD', reqHosp: 'SENTINEL-REQHOSP',
    ov: JSON.stringify({ id: 'SENTINEL-OV-ID', name: 'SENTINEL^OV', desc: 'SENTINEL-OV-DESC', ward: 'SENTINEL-OV-WARD' }),
    orig: JSON.stringify({ id: 'SENTINEL-ORIG-ID' }) };
  const w = world([
    study(ANCHOR, { state: copies, notes: [{ version: 1, text: 'SYN', author: 'syn-tech' }],
      series: [{ modality: 'CT', uid: ANCHOR + '.1', instances: [{ sop: ANCHOR + '.1.1', tags: {
        '0040,1002': { Name: 'ReasonForTheRequestedProcedure', Type: 'String', Value: 'SYN request' } } }] }] }),
    study('2.25.7601', { desc: 'SYN ORIGINAL DESC', acc: 'SYN-ORIGINAL-ACC', ...signedAt(1, 'P7601'), state: { rs: 'A', ...copies,
      orderOid: 'SENTINEL-OID-2' } }),
  ]);
  const answer = await ok(w, reader);
  const text = JSON.stringify(answer);
  assert.ok(!text.includes('SENTINEL'), 'no sentinel value in the answer');
  const keys = [...deepKeys(answer)].map(k => k.toLowerCase());
  assert.deepEqual(keys.filter(k => FORBIDDEN_EXACT.includes(k) || FORBIDDEN_FRAGMENTS.some(f => k.includes(f))), []);
  const row = answer.sections.history.items[0];
  assert.deepEqual([row.study.description, row.study.accession], ['SYN ORIGINAL DESC', 'SYN-ORIGINAL-ACC'], 'original DICOM values');
  assert.deepEqual(w.calls.delegates.filter(d => d.model === 'order'), [], 'the order delegate is never called');
  for (const statement of [...w.calls.raw, ...w.calls.execute]) assert.ok(!statement.sql.includes('"Order"'), statement.sql);
  for (const d of w.calls.delegates.filter(d => d.model === 'studyState')) {
    assert.ok(d.args.select, 'every StudyState read names its fields');
    for (const field of ['ov', 'orig', 'ward', 'orderOid', 'matched', 'reqHosp']) assert.notEqual(d.args.select[field], true, field);
  }
  for (const name of ['priorReports', 'history', 'requestTags', 'techNote']) assert.equal(answer.sections[name].state, 'present', name);
});

// ── CC-S07 absent, not configured, failed; section isolation ──

test('CC-S07 read-and-none is absent in every section, so an all-absent answer exists', async () => {
  const w = world([study(ANCHOR)]);
  const answer = await ok(w, reader);
  for (const name of ['priorReports', 'history', 'requestTags', 'techNote'])
    assert.deepEqual([answer.sections[name].state, answer.sections[name].reason, answer.sections[name].items], ['absent', null, []], name);
  assert.deepEqual(answer.sections.requestTags.checked, FIVE);
  assert.equal(answer.anchor.techNoteVersion, 0);
});

test('CC-S07 derived series only: requestTags not_configured/no_original_instance, never absent', async () => {
  const w = world([study(ANCHOR, { series: ['SR', 'KO', 'PR', 'SEG'].map((modality, i) => ({ modality, uid: ANCHOR + '.' + (i + 1),
    instances: [{ sop: ANCHOR + '.' + (i + 1) + '.1', tags: { '0032,1030': { Type: 'String', Value: 'SYN derived' } } }] })) })]);
  const answer = await ok(w, reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason, answer.sections.requestTags.checked],
    ['not_configured', 'no_original_instance', []]);
  assert.match(answer.sections.requestTags.observedAt, ISO);
  for (const name of ['priorReports', 'history', 'techNote']) assert.equal(answer.sections[name].state, 'absent', name);
  assert.deepEqual(w.calls.orthanc.filter(c => c.name === 'contextHeader' || c.name === 'contextInstances'), [], 'no header read');
});

test('CC-S07 failures stay in their section; a DB failure is 503 for the whole answer; no Orthanc call in the transaction', async () => {
  let w = fullWorld();
  w.fail.header = new Error('synthetic header failure');
  let answer = await ok(w, reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason, answer.sections.requestTags.checked],
    ['failed', 'source_unavailable', []]);
  for (const name of ['priorReports', 'history', 'techNote']) assert.equal(answer.sections[name].state, 'present', name);
  w = fullWorld();
  w.fail.studies = new Error('synthetic enumeration failure');
  answer = await ok(w, reader);
  for (const name of ['priorReports', 'history']) assert.deepEqual([answer.sections[name].state, answer.sections[name].reason],
    ['failed', 'source_unavailable'], name);
  assert.equal(answer.sections.techNote.state, 'present');
  assert.equal(answer.sections.requestTags.state, 'present');
  assert.equal(answer.patientKey, null);
  for (const code of [{ code: 'P2028' }, { code: 'P2010', meta: { code: '55P03' } }]) {
    w = fullWorld();
    w.fail.transaction = Object.assign(new Error('synthetic'), code);
    const result = await call(w, reader);
    assert.deepEqual([result.status, result.body.code], [503, 'CLINICAL_CONTEXT_BUSY'], JSON.stringify(code));
  }
  w = fullWorld();
  await ok(w, reader);
  assert.deepEqual(inTransaction(w), []);
  assert.ok(w.events.indexOf('orthanc:studies') < w.events.indexOf('tx:start') && w.events.lastIndexOf('orthanc:contextHeader') < w.events.indexOf('tx:start'),
    'every Orthanc read ends before the transaction starts');
});

test('CC-S07 a DB lock or timeout in R6 or R7(a), inside StudyAccess too, is 503 CLINICAL_CONTEXT_BUSY; other failures keep their answer', async () => {
  // Astra S7-U4a-R-001 F02. The real StudyAccessService takes its shared lock and reads the policy row on the R6 transaction
  // connection; a barrier step throws the Prisma error there, as PostgreSQL would under lock_timeout or statement_timeout.
  const dbError = (code, meta) => Object.assign(new Error('SYN-DB-DETAIL relation "StudyAccessPolicy"'), { code },
    meta ? { meta: { code: meta, message: 'SYN-DB-DETAIL' } } : {});
  const busy = [
    ['R6 StudyAccess shared lock, lock_timeout', 'tx:lock', dbError('P2010', '55P03')],
    ['R6 StudyAccess policy SQL, statement timeout', 'tx:policy', dbError('P2010', '57014')],
    ['R6 StudyAccess policy SQL, deadlock', 'tx:policy', dbError('P2010', '40P01')],
    ['R6 StudyAccess lock on an expired transaction', 'tx:lock', dbError('P2028')],
    ['R6 transaction timed out on its own read', 'tx:studyState.findMany', dbError('P2028')],
    ['R7(a) statement timeout', 'root:recheck', dbError('P2010', '57014')],
  ];
  for (const [label, event, error] of busy) {
    const w = fullWorld();
    w.at(event, () => { throw error; });
    const result = await barrier(w, reader);
    assert.deepEqual([result.status, Object.keys(result.body).sort(), result.body.code], [503, ['code', 'message'], 'CLINICAL_CONTEXT_BUSY'], label);
    assert.ok(!/SYN-DB-DETAIL|55P03|57014|40P01|P20/.test(JSON.stringify(result.body)), label + ': no DB text in the answer');
  }
  // Not a DB delay: the StudyAccess answer goes out as it is, never BUSY.
  const unavailable = { message: '검사 접근 조건을 확인하지 못했습니다. 잠시 후 다시 시도하세요', error: 'Service Unavailable', statusCode: 503 };
  for (const [label, event, error] of [['R6 policy SQL, another DB error', 'tx:policy', dbError('P2010', '42P01')],
    ['R6 shared lock, an error without a code', 'tx:lock', new Error('SYN-DB-DETAIL connection reset')]]) {
    const w = fullWorld();
    w.at(event, () => { throw error; });
    const result = await barrier(w, reader);
    assert.deepEqual([result.status, result.body], [503, unavailable], label);
  }
  let w = fullWorld();
  w.at('orthanc:studies', () => { w.store.policies.set(reader.sub, { institution: A, revision: 1, reason: 'SYN', updatedBy: 'syn-admin',
    updatedAt: T0, policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules: 'SYN-MALFORMED' } }); });
  let result = await barrier(w, reader);
  assert.deepEqual([result.status, result.body], [503, unavailable], 'a malformed policy row read in R6');
  // A policy change is still V-ACCESS: 409 STUDY_ACCESS_CHANGED.
  w = fullWorld();
  w.at('orthanc:studies', () => { w.store.policies.set(reader.sub, { institution: A, revision: 1, reason: 'SYN', updatedBy: 'syn-admin',
    updatedAt: T0, policy: { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } }); });
  result = await barrier(w, reader);
  assert.deepEqual([result.status, result.body.code], [409, 'STUDY_ACCESS_CHANGED'], 'policy changed between R3 and R6');
  // R3: the anchor's original metadata read fails -> the existing StudyAccess 503 (section 9.4), even for an error with a code.
  const tagRule = { version: 1, restricted: true, startsAt: null, endsAt: null,
    rules: [{ patientId: null, modalities: ['CT'], dateFrom: null, dateTo: null, studyUids: [] }] };
  w = fullWorld({ policies: { [reader.sub]: tagRule } });
  w.at('orthanc:studyAccessMetadata', () => { throw dbError('P2028'); });
  result = await barrier(w, reader);
  assert.deepEqual([result.status, result.body], [503, { message: '검사 원본의 접근 조건을 확인하지 못했습니다', error: 'Service Unavailable', statusCode: 503 }],
    'R3 original metadata failure');
  assert.equal(w.events.includes('tx:start'), false, 'no transaction after an R3 failure');
});

// ── CC-S08 changes between the reads ──

/** Calls through the controller and checks that every barrier step set with w.at() really ran inside that call. */
async function barrier(w, caller, expected) {
  const result = await call(w, caller);
  assert.deepEqual(w.pending(), [], 'every barrier step ran');
  if (expected === undefined) return result;
  assert.equal(result.status, expected, JSON.stringify(result.body));
  assert.equal(policy.clinicalContextShapeError(result.body), null);
  return result.body;
}

function changeWorld() {
  return world([
    study(ANCHOR, { state: { teleInstitutionId: B, rs: 'T' }, report: { version: 1 },
      versions: [{ version: 1, action: 'save', findings: 'ANCHOR-DRAFT-BODY' }],
      notes: [{ version: 1, text: 'SYN', author: 'syn-tech' }] }),
    study('2.25.7801', { ...signedAt(1, 'MEMBERX'), state: { rs: 'A', teleInstitutionId: B } }),
    study('2.25.7802', { state: { teleInstitutionId: null } }),
  ]);
}
const X = '2.25.7801';

test('CC-S08 (1)(2)(3) policy, anchor tele and anchor visibility changes', async () => {
  let w = changeWorld();
  w.at('root:recheck', () => { w.store.policies.set(teleReader.sub, { institution: B, revision: 2, reason: 'SYN', updatedBy: 'syn-admin',
    updatedAt: T0, policy: { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } }); });
  let result = await barrier(w, teleReader);
  assert.deepEqual([result.status, result.body.code], [409, 'STUDY_ACCESS_CHANGED'], 'R3 -> R7(b)');
  w = changeWorld();
  w.at('orthanc:studies', () => { w.store.policies.set(teleReader.sub, { institution: B, revision: 2, reason: 'SYN', updatedBy: 'syn-admin',
    updatedAt: T0, policy: { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } }); });
  result = await barrier(w, teleReader);
  assert.deepEqual([result.status, result.body.code], [409, 'STUDY_ACCESS_CHANGED'], 'R3 -> R6');
  w = changeWorld();
  w.at('orthanc:studies', () => { w.store.states.get(ANCHOR).teleInstitutionId = C; });
  result = await barrier(w, reader);
  assert.deepEqual([result.status, result.body.code], [409, 'CLINICAL_CONTEXT_CHANGED'], 'anchor tele between R4 and R6');
  w = changeWorld();
  w.at('orthanc:studies', () => { w.store.states.get(ANCHOR).teleInstitutionId = null; });
  result = await barrier(w, teleReader);
  assert.equal(result.status, 404, 'the anchor is not visible in R6');
});

test('CC-S08 (4)-(11) with the policy revision unchanged, every pinned change between R6 and R7(a) is 409 with no body', async () => {
  const cases = {
    '(4) member tele cancelled': s => { s.states.get(X).teleInstitutionId = null; },
    '(5) member institution changed': s => { s.states.get(X).institutionId = C; },
    '(6) member reset': s => { s.states.get(X).rs = 'W'; s.reports.get(X).version = 2; s.versions.push({ id: 999, uid: X, version: 2, action: 'reset', findings: '' }); },
    '(7) member addendum': s => { s.reports.get(X).version = 2; s.versions.push({ id: 998, uid: X, version: 2, action: 'addendum', findings: 'NEW' }); },
    '(8) member P pair changed': s => { s.states.get(X).preDoc = 'syn-other'; },
    '(9) member row deleted': s => { s.states.delete(X); },
    '(10) anchor Tech Note revised': s => { s.notes.push({ studyUid: ANCHOR, version: 2, text: 'SYN2', author: 'syn-tech', createdAt: T0 }); },
    '(11) anchor tele cancelled': s => { s.states.get(ANCHOR).teleInstitutionId = null; },
  };
  for (const [label, change] of Object.entries(cases)) {
    const w = changeWorld();
    w.at('tx:end', () => change(w.store));
    const caller = label.startsWith('(11)') ? reader : teleReader;
    const result = await barrier(w, caller);
    assert.deepEqual([result.status, Object.keys(result.body).sort(), result.body.code], [409, ['code', 'message'], 'CLINICAL_CONTEXT_CHANGED'], label);
    assert.ok(!JSON.stringify(result.body).includes('MEMBERX'), label);
    assert.equal(w.store.policies.size, 0, 'no policy row: the StudyAccess revision stayed 0');
  }
});

test('CC-S08 (12)(13)(14) changes that are not pinned or that only narrow answer 200', async () => {
  let w = changeWorld();
  w.at('tx:end', () => { const s = w.store.states.get(X); s.teleInstitutionId = null; s.updatedAt = new Date(); s.teleInstitutionId = B; });
  let answer = await barrier(w, teleReader, 200);
  assert.deepEqual(uidsOf(answer.sections.history), [X], '(12) closed and reopened to the same institution');
  w = changeWorld();
  w.at('tx:end', () => { w.store.states.get('2.25.7802').teleInstitutionId = B; });
  answer = await barrier(w, teleReader, 200);
  assert.ok(!uidsOf(answer.sections.history).includes('2.25.7802'), '(13) visible only after R6: absent, not 409');
  w = changeWorld();
  w.at('tx:end', () => { w.store.states.get(ANCHOR).rs = 'A'; w.store.reports.get(ANCHOR).version = 2; });
  answer = await barrier(w, teleReader, 200);
  assert.ok(!JSON.stringify(answer).includes('ANCHOR-DRAFT-BODY'), '(14) the anchor report is never in the answer');
  // R7(a) is one root statement after the transaction, over the anchor and every contributing member
  const rechecks = w.calls.rechecks;
  assert.equal(rechecks.length, 1);
  assert.equal(rechecks[0].scope, 'root');
  assert.deepEqual(rechecks[0].uids.sort(), [ANCHOR, X].sort());
  assert.ok(w.events.indexOf('root:recheck') > w.events.indexOf('tx:end'));
});

// ── CC-S09 read only ──

test('CC-S09 read only: no write, no audit, no registration, one lock_timeout statement, Orthanc reads only', async () => {
  const w = fullWorld();
  w.studies.push(study('2.25.7901', { state: null }));                  // same key in Orthanc, not registered in KIN
  const answer = await ok(w, reader);
  assert.ok(!uidsOf(answer.sections.history).includes('2.25.7901'));
  assert.deepEqual(w.calls.delegates.filter(d => WRITE_METHODS.includes(d.method) || d.model === 'auditLog'), []);
  assert.deepEqual(w.calls.execute.map(e => [e.scope, e.sql.replace(/\s+/g, ' ').trim()]), [['tx', "SET LOCAL lock_timeout = '3s'"]]);
  assert.deepEqual([...new Set(w.calls.orthanc.map(c => c.name))].filter(name => !READ_HELPERS.includes(name)), []);
  const tx = w.calls.delegates.find(d => d.model === '$transaction');
  assert.equal(tx.args.isolationLevel, 'RepeatableRead');
});

// ── CC-S10 request tags ──

test('CC-S10 request tags are the header strings verbatim; non-text and over-long values are notes, absent tags no items', async () => {
  const long = 'X'.repeat(10241);
  const w = world([study(ANCHOR, { series: [
    { modality: 'SR', uid: ANCHOR + '.0', instances: [{ sop: ANCHOR + '.0.1', tags: { '0032,1030': { Type: 'String', Value: 'SYN-SR-VALUE' } } }] },
    { modality: 'CT', uid: ANCHOR + '.2', instances: [
      { sop: ANCHOR + '.2.9', tags: { '0032,1030': { Type: 'String', Value: 'SYN-LATER-INSTANCE' } } },
      { sop: ANCHOR + '.2.10', tags: {
        '0032,1030': { Name: 'RETIRED_ReasonForStudy', Type: 'String', Value: '  앞 공백 사유' },
        '0040,1002': { Name: 'ReasonForTheRequestedProcedure', Type: 'String', Value: 'A\\B' },
        '0010,21b0': { Name: 'AdditionalPatientHistory', Type: 'Sequence', Value: [] },
        '0032,4000': { Name: 'RETIRED_StudyComments', Type: 'String', Value: long } } }] },
  ] })]);
  const answer = await ok(w, reader);
  const tags = answer.sections.requestTags;
  assert.equal(tags.state, 'present');
  assert.deepEqual(tags.checked, FIVE);
  assert.deepEqual(tags.items.map(i => [i.tag, i.keyword, i.vr, i.value, i.note]), [
    ['00321030', 'ReasonForStudy', 'LO', '  앞 공백 사유', null],
    ['00401002', 'ReasonForTheRequestedProcedure', 'LO', 'A\\B', null],
    ['001021B0', 'AdditionalPatientHistory', 'LT', null, 'not_text'],
    ['00324000', 'StudyComments', 'LT', null, 'too_long'],
  ]);
  assert.ok(tags.items.every(i => i.provenance.recordId === ANCHOR + '.2.10'), 'the smallest SOP of the image series');
  assert.ok(!JSON.stringify(answer).includes('SYN-SR-VALUE') && !JSON.stringify(answer).includes('SYN-LATER-INSTANCE'));
  assert.deepEqual(w.calls.orthanc.filter(c => c.name === 'contextHeader').map(c => c.args[1]), [FIVE]);
});

test('CC-S10 the five header cases of section 5.4', async () => {
  const header = tags => world([study(ANCHOR, { series: [{ modality: 'MR', uid: ANCHOR + '.1', instances: [{ sop: ANCHOR + '.1.1', tags }] }] })]);
  let answer = await ok(header({ '0008,1080': { Type: 'String', Value: 'SYN admitting' } }), reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.checked], ['present', FIVE]);
  answer = await ok(header({}), reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason, answer.sections.requestTags.checked], ['absent', null, FIVE]);
  let w = world([study(ANCHOR, { series: [{ modality: 'SR', uid: ANCHOR + '.1', instances: [{ sop: ANCHOR + '.1.1', tags: {} }] }] })]);
  answer = await ok(w, reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason, answer.sections.requestTags.checked],
    ['not_configured', 'no_original_instance', []]);
  assert.equal(w.calls.orthanc.filter(c => c.name === 'contextHeader').length, 0);
  w = fullWorld();
  w.fail.header = new Error('synthetic');
  answer = await ok(w, reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason, answer.sections.requestTags.checked],
    ['failed', 'source_unavailable', []]);
  w = world([study(ANCHOR, { orthanc: false })]);
  answer = await ok(w, reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason, answer.sections.requestTags.checked],
    ['failed', 'source_row_missing', []]);
  assert.deepEqual([answer.sections.history.state, answer.sections.history.reason], ['failed', 'source_row_missing']);
  // a value Orthanc hid as TooLong was not read: the section fails instead of reporting the tag as absent or cut
  answer = await ok(header({ '0010,21b0': { Type: 'TooLong', Value: null } }), reader);
  assert.deepEqual([answer.sections.requestTags.state, answer.sections.requestTags.reason], ['failed', 'source_invalid']);
});

test('CC-S10 OrthancService header helpers: read-only GETs, ids checked, ignore-length in 8-hex form, 16 MiB bound', async () => {
  process.env.ORTHANC_USER = 'synthetic';
  process.env.ORTHANC_PASS = 'synthetic';
  const orthanc = new OrthancService();
  const seen = [];
  const saved = globalThis.fetch;
  let payload = [];
  globalThis.fetch = async (url, init) => { seen.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ''), method: init.method, body: init.body });
    return new Response(JSON.stringify(payload)); };
  try {
    const id = '0a1b2c3d-00000000-00000000-00000000-00000001';
    payload = [{ Type: 'Study', ID: id }];
    assert.deepEqual(await orthanc.contextLookup('2.25.1'), payload);
    await orthanc.contextSeries(id);
    await orthanc.contextInstances(id);
    await orthanc.contextHeader(id, FIVE);
    assert.deepEqual(seen.map(s => [s.method, s.path]), [['POST', '/tools/lookup'], ['GET', '/studies/' + id + '/series'],
      ['GET', '/series/' + id + '/instances'], ['GET', '/instances/' + id + '/tags?ignore-length=' + FIVE.join(',')]]);
    assert.equal(seen[0].body, '2.25.1');
    for (const bad of ['../x', id.toUpperCase(), '1', '']) {
      await assert.rejects(orthanc.contextSeries(bad), e => e.getStatus() === 400);
      await assert.rejects(orthanc.contextHeader(bad, FIVE), e => e.getStatus() === 400);
    }
    for (const tags of [[], ['0032,1030'], ['ReasonForStudy'], ['00321030&x=1']])
      await assert.rejects(orthanc.contextHeader(id, tags), e => e.getStatus() === 400);
    assert.equal(seen.length, 4, 'a refused id or tag list reaches no fetch');
    payload = [{ Type: 'Instance', ID: id, MainDicomTags: { SOPInstanceUID: 'X'.repeat(300000) } }];
    assert.equal((await orthanc.contextInstances(id)).length, 1, 'a 300 KB list is within the header-read bound');
    await assert.rejects(orthanc.contextLookup('2.25.1'), e => e.getStatus() === 503, 'the lookup keeps the 256 KiB viewer bound');
  } finally {
    globalThis.fetch = saved;
  }
});

// ── CC-S11 bounds and order ──

test('CC-S11 history 200 + truncated, prior 10 + truncated, date order with malformed dates last, no hidden count', async () => {
  const members = [];
  for (let i = 0; i < 201; i++) members.push(study('2.25.8' + String(i).padStart(3, '0'), { date: '2020' + String(1 + (i % 12)).padStart(2, '0') + '01' }));
  const hidden = study('2.25.9001', { state: { institutionId: C } });
  let answer = await ok(world([study(ANCHOR), ...members, hidden]), reader);
  assert.deepEqual([answer.sections.history.items.length, answer.sections.history.truncated], [200, true]);
  assert.ok(!JSON.stringify(answer).includes('2.25.9001'), 'the invisible member is nowhere');
  assert.equal(Object.values(answer.sections).some(section => Object.keys(section).some(key => /count|total|hidden/i.test(key))), false,
    'no hidden or total count');
  const signed = [];
  for (let i = 0; i < 11; i++) signed.push(study('2.25.83' + String(i).padStart(2, '0'), { date: '201901' + String(10 + i), ...signedAt(1, 'S' + i) }));
  answer = await ok(world([study(ANCHOR), ...signed]), reader);
  assert.deepEqual([answer.sections.priorReports.items.length, answer.sections.priorReports.truncated], [10, true]);
  assert.equal(answer.sections.history.truncated, false);
  const order = world([study(ANCHOR),
    study('2.25.8501', { date: '20240101' }), study('2.25.8502', { date: 'bad' }), study('2.25.8503', { date: '20250101' }),
    study('2.25.8504', { date: '20240101' }), study('2.25.8505', { date: '' }), study('2.25.8506', { date: '20230230' })]);
  answer = await ok(order, reader);
  assert.deepEqual(uidsOf(answer.sections.history), ['2.25.8503', '2.25.8501', '2.25.8504', '2.25.8502', '2.25.8505', '2.25.8506']);
});

// ── CC-S12 no patient key ──

test('CC-S12 an anchor without PatientID: prior and history not_configured/no_patient_key, the others unaffected', async () => {
  const w = world([study(ANCHOR, { pid: '', notes: [{ version: 3, text: '', author: 'syn-tech' }] }), study('2.25.8601', { pid: '' })]);
  const answer = await ok(w, reader);
  for (const name of ['priorReports', 'history']) assert.deepEqual([answer.sections[name].state, answer.sections[name].reason,
    answer.sections[name].observedAt, answer.sections[name].items], ['not_configured', 'no_patient_key', null, []], name);
  assert.equal(answer.patientKey, null);
  assert.deepEqual([answer.sections.techNote.state, answer.sections.techNote.items[0].hasText, answer.anchor.techNoteVersion], ['present', false, 3]);
  assert.equal(answer.sections.requestTags.state, 'absent');
  assert.deepEqual(answer.identity, { conflict: false, birth: 'not_comparable', sex: 'not_comparable' });
});

// ── CC-S13 closed shape ──

test('CC-S13 the closed keys are exactly the contract response keys, and every violation is refused', async () => {
  const union = new Set(Object.values(policy.CLINICAL_CONTEXT_KEYS).flat());
  assert.deepEqual([...union].sort(), [...RESPONSE_KEYS].sort());
  const answer = await ok(fullWorld(), reader);
  assert.deepEqual([...deepKeys(answer)].sort(), [...RESPONSE_KEYS].sort(), 'an all-present answer uses every key and no other');
  const broken = (edit) => { const copy = structuredClone(answer); edit(copy); return policy.clinicalContextShapeError(copy); };
  assert.notEqual(broken(a => { a.order = null; }), null);
  assert.notEqual(broken(a => { a.sections.history.items[0].ward = 'x'; }), null);
  assert.notEqual(broken(a => { a.sections.orders = { state: 'absent' }; }), null);
  assert.notEqual(broken(a => { a.schema = 'kin.clinical-context/2'; }), null);
  assert.notEqual(broken(a => { a.anchor.techNoteVersion = 2; }), null, 'techNote version differs from anchor.techNoteVersion');
  assert.notEqual(broken(a => { a.sections.requestTags.checked = []; }), null, 'checked disagrees with a read header');
  assert.notEqual(broken(a => { a.sections.history.items[0].access = 'tele'; }), null, 'item access differs from anchor.access');
  assert.notEqual(broken(a => { a.sections.history.items[0].institutionName = 'other'; }), null);
  assert.notEqual(broken(a => { a.identity.conflict = true; }), null);
  assert.notEqual(broken(a => { a.sections.priorReports.items[0].provenance.recordedAt = null; }), null);
  assert.notEqual(broken(a => { a.sections.requestTags.items[0].provenance.recordedAt = answer.observedAt; }), null);
  assert.notEqual(broken(a => { a.sections.techNote.state = 'absent'; a.sections.techNote.items = []; }), null);
  // the server never sends such a section: it becomes failed/source_invalid and the rest of the answer stands
  const parts = { uid: answer.uid, observedAt: answer.observedAt, patientKey: answer.patientKey, anchor: answer.anchor,
    identity: answer.identity, sections: structuredClone(answer.sections) };
  parts.sections.history.items[0].ward = 'SENTINEL';
  const sent = policy.clinicalContextAnswer(parts);
  assert.deepEqual([sent.sections.history.state, sent.sections.history.reason, sent.sections.history.items], ['failed', 'source_invalid', []]);
  assert.equal(sent.sections.priorReports.state, 'present');
  assert.ok(!JSON.stringify(sent).includes('SENTINEL'));
});

// ── CC-S14 anchor block, stale baselines and permission basis ──

test('CC-S14 anchor block and permission basis: owner answers are owner, tele answers tele, names are the worklist names', async () => {
  const owner = await ok(changeWorld(), reader);
  const tele = await ok(changeWorld(), teleReader);
  for (const [answer, access] of [[owner, 'owner'], [tele, 'tele']]) {
    assert.deepEqual(answer.anchor, { access, institutionName: 'SYN Hospital A', techNoteVersion: 1 });
    for (const name of ['priorReports', 'history']) for (const item of answer.sections[name].items) assert.equal(item.access, access, name);
    assert.equal(answer.sections.techNote.items[0].version, answer.anchor.techNoteVersion);
  }
  const probe = world([]);
  assert.equal(owner.anchor.institutionName, probe.pacs.institutionName(A), 'the name the worklist row shows');
  assert.equal((await ok(world([study(ANCHOR)]), reader)).anchor.techNoteVersion, 0);
});

test('CC-S14 the stale baselines are the values R6 read and R7(a) confirmed; no anchor RS or head field is sent', async () => {
  const w = world([
    study(ANCHOR, { state: { rs: 'P', preDoc: 'syn-other', preReviewer: 'syn-senior' }, report: { version: 4, findings: 'ANCHOR-P-BODY' },
      versions: [{ version: 4, action: 'save', findings: 'ANCHOR-P-BODY' }] }),
    study('2.25.8801', { ...signedAt(3, 'B8801', 'addendum'), state: { rs: 'A' } }),
    study('2.25.8802', { state: { rs: 'T' }, report: { version: 2 }, versions: [{ version: 1, action: 'save' }, { version: 2, action: 'save' }] }),
  ]);
  const answer = await ok(w, reader);
  const confirmed = new Map(w.calls.rechecks[0].rows.map(row => [row.uid, row]));
  for (const item of answer.sections.history.items) {
    assert.deepEqual([item.reading.rs, item.reading.reportVersion], [confirmed.get(item.studyUid).rs, confirmed.get(item.studyUid).reportVersion]);
  }
  assert.equal(answer.sections.priorReports.items[0].report.version, confirmed.get('2.25.8801').reportVersion);
  assert.deepEqual(Object.keys(answer.anchor).sort(), ['access', 'institutionName', 'techNoteVersion']);
  assert.ok(!JSON.stringify(answer).includes('ANCHOR-P-BODY'));
  assert.ok(!answer.sections.history.items.some(item => item.studyUid === ANCHOR), 'the anchor has no history row');
});
