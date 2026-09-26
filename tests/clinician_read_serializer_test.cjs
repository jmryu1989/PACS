'use strict';
/* TEST-S5-U1b-PURE: the clinician read projections in api/src/clinician-policy.ts.
 * REQ-S5-U1b-CLINICIAN-READ -> RISK-S5-U1b-DRAFT-LEAK / NONFINAL-BODY / WRITER-FIELD / COUNT-LEAK.
 *
 * Every vector checks two things: each allowlisted field is present, and no field outside the allowlist
 * appears anywhere in the output (a deep key walk over tests/clinician_policy_fixtures.json read_contract).
 * Input rows deliberately carry every writer field the services hold (draft, holder, ov/orig, preDoc,
 * gateway receipt, order identity, authorSub...), so a projection that spreads its input fails here.
 *
 * Module: KIN_CLINICIAN_POLICY_MODULE, default the compiled /app/dist/clinician-policy (kin-api:ci).
 * A path ending in .ts loads the source through Node type stripping (Node >= 22.18); its single
 * '@nestjs/common' import (RequestMethod) is served from the fixture's request_method_enum.
 * This is a pure check of the projections, not runtime proof of the Nest routes (clinician_read_live.py).
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { createHmac, randomBytes } = require('node:crypto');

const FIXTURES = JSON.parse(readFileSync(path.join(__dirname, 'clinician_policy_fixtures.json'), 'utf8'));
const C = FIXTURES.read_contract;
const MODULE = process.env.KIN_CLINICIAN_POLICY_MODULE || '/app/dist/clinician-policy';
const TARGET = path.isAbsolute(MODULE) ? MODULE : path.resolve(__dirname, '..', MODULE);

if (TARGET.endsWith('.ts')) {
  const { registerHooks } = require('node:module');
  if (typeof registerHooks !== 'function') throw new Error('loading the .ts source needs node:module registerHooks (Node >= 22.15)');
  const methods = {};
  for (const [number, name] of Object.entries(FIXTURES.request_method_enum)) { methods[number] = name; methods[name] = Number(number); }
  const stub = 'data:text/javascript,' + encodeURIComponent('export const RequestMethod = ' + JSON.stringify(methods) + ';');
  registerHooks({ resolve(specifier, context, next) {
    return specifier === '@nestjs/common' ? { url: stub, format: 'module', shortCircuit: true } : next(specifier, context);
  } });
}
const P = require(TARGET);

const sorted = value => [...value].sort();
const keys = value => sorted(Object.keys(value));
const FORBIDDEN = new Set(C.forbidden_keys);

/** Every key at every depth. A projection must not carry a writer field under any parent. */
function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) deepKeys(item, out); return out; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.add(key); deepKeys(item, out); }
  return out;
}
function clean(value, label) {
  const leaked = [...deepKeys(value)].filter(key => FORBIDDEN.has(key));
  assert.deepEqual(leaked, [], `${label}: writer/engineering field reached the clinician`);
}

const SECRET = 'U1B-SECRET-BODY';
const DRAFT = 'U1B-SECRET-DRAFT';
// A StudyState row as the services read it: every writer column set.
const writerState = (over = {}) => ({
  uid: '1.2.3', institutionId: 'hallym', teleInstitutionId: null, origin: 'dicom', rs: 'A', ss: 'Verified', em: 'E',
  ts: 'none', matched: 'M', ward: 'W7', reqHosp: 'KIN', repDoc: 'doc', confirm: '2026-09-26', holdReason: 'hold reason',
  preDoc: 'author@x', preReviewer: 'reviewer@x', ov: null, orig: '{"name":"orig"}', orderOid: 'O-1', holder: 'doctor@x',
  heldAt: new Date(), draft: { findings: DRAFT }, createdAt: new Date(), updatedAt: new Date(), ...over,
});
const head = (action, over = {}) => ({ version: 3, action, findings: SECRET + '-F', conclusion: SECRET + '-C',
  recommendation: SECRET + '-R', author: 'doctor@x', reason: 'r', citations: [], structured: [], ...over });
// The toClient state carried by a worklist row (pacs.service toClient): ov is already parsed, drafts ride along.
const clientState = (over = {}) => ({
  rs: 'A', ss: 'Verified', em: 'E', ts: 'none', matched: 'M', ward: 'W7', reqHosp: 'KIN', institutionId: 'hallym',
  teleInstitutionId: null, preDoc: null, preReviewer: null, prelimHidden: false, repDoc: 'doc', confirm: '2026-09-26',
  ov: null, orig: { name: 'orig' }, oid: 'O-1', holder: 'doctor@x', holdReason: 'hold reason', version: 3,
  findings: SECRET + '-F', conclusion: SECRET + '-C', recommendation: SECRET + '-R',
  draft: { findings: DRAFT, conclusion: '', recommendation: '', baseVersion: 3, at: new Date() }, ...over,
});
// The one-statement snapshot row clinicianStudies reads (pacs.service): scope, report status, Report.version and its action.
const snap = (over = {}) => ({ uid: '1.2.3', institutionId: 'hallym', teleInstitutionId: null, rs: 'A', repDoc: 'doc',
  confirm: '2026-09-26', version: 3, action: 'approve', ...over });
// One listStudies row: every writer/engineering field the worklist sends.
const worklistRow = (over = {}, state = {}) => ({
  uid: '1.2.3', techNote: { version: 2, present: true },
  readerAssignment: { revision: 1, reader: { sub: 'sub-r', actor: 'reader@x', name: 'Reader' } },
  gatewayReceipt: { phase: 'complete', successCount: 3, localCount: 3 },
  orderIdentity: { source: 'engineering_only', oid: 'O-1', accession: 'match', patientId: 'match', patientName: 'match', birth: 'match', sex: 'match' },
  count: 120, series: 3, acc: 'ACC-1', id: 'PID-1', sourcePatientKey: 'hallym|PID-1', name: 'KIM JOHN', birth: '19800101',
  date: '20260926', sex: 'M', modality: 'CT', desc: 'CT CHEST', institutionName: 'Hallym', tele: false,
  state: clientState(state), ...over,
});
const snapshot = kind => ({
  key: { schemaVersion: 1, kind: 'key', seriesUid: '1.2.3.4', sopUid: '1.2.3.4.5', frame: 1, title: 'Key <b>', description: '' },
  arrow: { schemaVersion: 1, kind: 'arrow', seriesUid: '1.2.3.4', sopUid: '1.2.3.4.5', frame: 1, frameOfReferenceUid: '1.2.9',
    label: 'arrow', points: [[0, 0, 0], [1, 1, 1]] },
  length: { schemaVersion: 1, kind: 'length', seriesUid: '1.2.3.4', sopUid: '1.2.3.4.5', frame: 1, frameOfReferenceUid: '1.2.9',
    label: '12 mm', points: [[0, 0, 0], [1, 1, 1]], viewPlaneNormal: [0, 0, 1], viewUp: [0, -1, 0],
    baseline: { calculator: 'kin-native-manual-v1', values: [12] } },
}[kind]);
const withEngineering = (item, over = {}) => ({ ...item, hidden: false, sourceDigest: 'sha256:abc', authorActor: 'doctor@x', ...over });

test('the U1b allowlist and the S5-F5 constants are exactly the fixture values', () => {
  assert.deepEqual([...P.CLINICIAN_BUSINESS_ROUTES], FIXTURES.business_routes);
  assert.ok(Object.isFrozen(P.CLINICIAN_BUSINESS_ROUTES));
  assert.deepEqual([...P.CLINICIAN_FINAL_ACTIONS], C.final_actions);
  assert.deepEqual([...P.CLINICIAN_OPEN_STATES], C.open_states);
  assert.deepEqual([...P.CLINICIAN_LIST_PINS], C.list_snapshot_pins);
  assert.ok(Object.isFrozen(P.CLINICIAN_LIST_PINS));
  assert.equal(P.CLINICIAN_VIEWER_CHANGED, C.viewer_changed_code);
  assert.equal(P.CLINICIAN_VIEWER_CURSOR_MAX, C.viewer_cursor_max);
  assert.deepEqual(Object.fromEntries(Object.entries(P.CLINICIAN_SNAPSHOT_FIELDS).map(([k, v]) => [k, [...v]])), C.snapshot_keys);
  for (const route of FIXTURES.business_routes) assert.equal(P.clinicianRouteAllowed(route), true, route);
  for (const route of FIXTURES.must_stay_denied) assert.equal(P.clinicianRouteAllowed(route), false, route);
  // Only reads: the one non-GET row is the viewer's SOP lookup, which answers an Orthanc id and writes nothing.
  assert.deepEqual(FIXTURES.business_routes.filter(route => !route.startsWith('GET ')), ['POST dicom/lookup']);
});

test('final means rs A and a head row whose own action is approve or addendum, nothing looser', () => {
  for (const action of ['approve', 'addendum']) {
    assert.equal(P.clinicianFinal('A', { version: 1, action }), true, action);
    for (const rs of ['W', 'T', 'P', 'H', 'a', 'A ', '', null, undefined, ['A']])
      assert.equal(P.clinicianFinal(rs, { version: 1, action }), false, `${JSON.stringify(rs)}/${action}`);
    for (const version of [0, -1, 1.5, '1', NaN, null, undefined])
      assert.equal(P.clinicianFinal('A', { version, action }), false, `version ${String(version)}`);
  }
  for (const action of ['save', 'reset', 'preliminary', 'defer', 'discarded', 'Approve', 'APPROVE', ' approve', 'addendum ',
    ['approve'], {}, true, '', null, undefined])
    assert.equal(P.clinicianFinal('A', { version: 2, action }), false, JSON.stringify(action) ?? String(action));
  assert.equal(P.clinicianFinal('A', null), false, 'legacy rs A without any head row is not final');
  assert.equal(P.clinicianFinal('A', undefined), false);
});

test('final report: status, signer and the head row body only; every writer field stays behind', () => {
  for (const action of ['approve', 'addendum']) {
    const read = P.clinicianReport(writerState(), head(action));
    assert.deepEqual(keys(read), sorted([...C.report_final_keys, ...C.report_body_keys]), action);
    assert.deepEqual(read, { final: true, rs: 'A', action, version: 3, repDoc: 'doc', confirm: '2026-09-26',
      findings: SECRET + '-F', conclusion: SECRET + '-C', recommendation: SECRET + '-R' });
    assert.ok(!JSON.stringify(read).includes(DRAFT), 'a draft reached the clinician');
    clean(read, 'final report ' + action);
    const status = P.clinicianReportStatus(writerState(), head(action));
    assert.deepEqual(keys(status), sorted(C.report_final_keys));
    assert.ok(!JSON.stringify(status).includes(SECRET), 'the list status must never carry the body');
  }
  // Missing signer columns are an explicit null, never undefined (JSON would drop the key).
  const unsigned = P.clinicianReportStatus(writerState({ repDoc: undefined, confirm: 42 }), head('approve'));
  assert.equal(unsigned.repDoc, null); assert.equal(unsigned.confirm, null);
  assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(unsigned)), 'repDoc'));
  // Body fields that are not strings become '' rather than leaking an object or a number.
  assert.equal(P.clinicianReport(writerState(), head('approve', { findings: { x: 1 } })).findings, '');
});

test('non-final report: RS only, never a body, never labelled final, unknown states are null', () => {
  const cases = [
    ['W', null, 'W'], ['W', head('reset', { findings: '' }), 'W'], ['T', head('save'), 'T'], ['P', head('preliminary'), 'P'],
    ['P', head('save'), 'P'], ['H', head('defer'), 'H'], ['A', head('save'), null], ['A', null, null],
    ['A', head('approve', { version: 0 }), null], ['O', head('save'), null], ['X', head('approve'), null],
    [undefined, head('approve'), null], ['W', head('approve'), 'W'], ['T', head('addendum'), 'T'],
  ];
  for (const [rs, row, expected] of cases) {
    const label = `${String(rs)}/${row?.action ?? 'none'}`;
    const read = P.clinicianReport(writerState({ rs }), row);
    assert.deepEqual(keys(read), sorted(C.report_open_keys), label);
    assert.deepEqual(read, { final: false, rs: expected }, label);
    assert.ok(!JSON.stringify(read).includes(SECRET) && !JSON.stringify(read).includes(DRAFT), label + ': body leaked');
    clean(read, label);
    assert.deepEqual(P.clinicianReportStatus(writerState({ rs }), row), read, label + ': list status = read status');
  }
});

test('key images: only unhidden kind=key, with id, revision and the key fields; no author, no hidden flag', () => {
  const row = { id: '00000000-0000-4000-8000-000000000001', revision: 2, authorActor: 'doctor@x', authorSub: 'sub-1',
    hidden: false, studyUid: '1.2.3', snapshot: withEngineering(snapshot('key')) };
  const key = P.clinicianKeyImage(row);
  assert.deepEqual(keys(key), sorted(C.key_image_keys));
  assert.deepEqual(keys(key.item), sorted(C.snapshot_keys.key));
  assert.equal(key.item.title, 'Key <b>', 'text is data; escaping is the screen\'s job');
  clean(key, 'key image');
  assert.equal(P.clinicianKeyImage({ ...row, hidden: true }), null, 'hidden row');
  assert.equal(P.clinicianKeyImage({ ...row, snapshot: withEngineering(snapshot('key'), { hidden: true }) }), null, 'hidden snapshot');
  assert.equal(P.clinicianKeyImage({ ...row, snapshot: withEngineering(snapshot('arrow')) }), null, 'an arrow is not a key image');
  for (const bad of [null, [], 'key', { kind: '__proto__' }, { kind: 'constructor' }, { kind: 'KEY' }])
    assert.equal(P.clinicianKeyImage({ ...row, snapshot: bad }), null, JSON.stringify(bad));
});

test('viewer items: per-kind fields, measurement source status always present, unknown or hidden dropped', () => {
  const base = { id: '00000000-0000-4000-8000-000000000002', studyUid: '1.2.3', authorSub: 'sub-1', authorActor: 'doctor@x',
    revision: 1, createdAt: '2026-09-26T00:00:00.000Z', hidden: false, updatedAt: '2026-09-26T00:00:01.000Z' };
  for (const kind of ['key', 'arrow', 'length']) {
    const item = P.clinicianViewerItem({ ...base, item: withEngineering(snapshot(kind)), referenceStatus: 'verified' });
    const measure = kind === 'length';
    assert.deepEqual(keys(item), sorted([...C.viewer_item_keys, ...(measure ? C.viewer_measurement_extra_keys : [])]), kind);
    assert.deepEqual(keys(item.item), sorted(C.snapshot_keys[kind]), kind);
    clean(item, kind);
    if (measure) assert.equal(item.referenceStatus, 'verified');
  }
  for (const kind of ['angle', 'ellipse'])
    assert.deepEqual(keys(P.clinicianViewerItem({ ...base, item: { ...snapshot('length'), kind } }).item), sorted(C.snapshot_keys[kind]));
  // A missing or unexpected verdict is 'unverified': the screen can never read an absent field as verified.
  for (const verdict of [undefined, null, 'VERIFIED', 'unverified', true])
    assert.equal(P.clinicianViewerItem({ ...base, item: snapshot('length'), referenceStatus: verdict }).referenceStatus, 'unverified', String(verdict));
  assert.equal(P.clinicianViewerItem({ ...base, hidden: true, item: snapshot('key') }), null, 'hidden row');
  assert.equal(P.clinicianViewerItem({ ...base, item: { ...snapshot('key'), hidden: true } }), null, 'hidden snapshot');
  for (const bad of [null, [], { kind: 'polygon' }, { kind: 'toString' }, { kind: 'hasOwnProperty' }])
    assert.equal(P.clinicianViewerItem({ ...base, item: bad }), null, JSON.stringify(bad));
  // Only fields the stored kind defines: a stray field inside the snapshot does not ride along.
  assert.deepEqual(keys(P.clinicianViewerItem({ ...base, item: { ...snapshot('key'), points: [[0, 0, 0]], note: 'x' } }).item),
    sorted(C.snapshot_keys.key));
});

// S5-U1b-F04 cursor vectors. KEY stands in for the controller's process key; OTHER_KEY for the key of a restarted API.
const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';
const b64 = value => Buffer.from(value, 'utf8').toString('base64url');
const unb64 = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
/** A cursor signed with `key` over any payload: reaches the payload checks that follow a valid signature. */
const signed = (payload, key = KEY) => {
  const body = b64(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url');
};
const itemRow = id => ({ id, revision: 1, hidden: false, item: snapshot('key'), authorSub: 's' });

test('viewer page and withheld answer carry the requested uid; withheld items are null, not an empty list', () => {
  const page = P.clinicianViewerPage('1.2.3', 3, { items: [
    itemRow(ID_A),
    { id: ID_B, revision: 1, hidden: false, item: { kind: 'polygon' } },
  ], nextCursor: ID_B }, KEY);
  assert.deepEqual(keys(page), sorted(C.viewer_page_keys));
  assert.deepEqual([page.uid, page.final, page.reportVersion, page.items.map(i => i.id)], ['1.2.3', true, 3, [ID_A]]);
  // S5-U1b-F04: the continuation is never the bare item id; it is this study, this version and the last row read, signed
  assert.notEqual(page.nextCursor, ID_B);
  assert.deepEqual(unb64(page.nextCursor.split('.')[0]), { v: 1, uid: '1.2.3', version: 3, after: ID_B });
  assert.deepEqual(P.clinicianViewerContinuation(KEY, '1.2.3', page.nextCursor), { version: 3, after: ID_B });
  clean(page, 'viewer page');
  for (const cursor of [null, undefined, 3, {}]) assert.equal(P.clinicianViewerPage('1.2.3', 3, { items: [], nextCursor: cursor }, KEY).nextCursor, null);
  assert.deepEqual(P.clinicianViewerPage('1.2.3', 3, {}, KEY).items, []);
  // never a final page without the version it was read under, and never a cursor over a non-item boundary or a weak key
  for (const version of [0, -1, 1.5, '3', null, undefined, 2 ** 53])
    assert.throws(() => P.clinicianViewerPage('1.2.3', version, { items: [], nextCursor: null }, KEY), /signed report version/, String(version));
  for (const after of ['b', ID_B.toUpperCase(), ID_B + ' ', ''])
    assert.throws(() => P.clinicianViewerPage('1.2.3', 3, { items: [], nextCursor: after }, KEY), /item id/, after);
  for (const key of [Buffer.alloc(0), randomBytes(31), 'k'.repeat(64), null, undefined])
    assert.throws(() => P.clinicianViewerPage('1.2.3', 3, { items: [], nextCursor: ID_B }, key), /at least 32 bytes/, String(key));
  const withheld = P.clinicianViewerWithheld('1.2.3');
  assert.deepEqual(withheld, { uid: '1.2.3', final: false, items: null, nextCursor: null });
  assert.deepEqual(keys(withheld), sorted(C.viewer_withheld_keys));
});

test('viewer page chain (S5-U1b-F04): one chain is one signed version; a moved head or a cursor without its version is refused', () => {
  // page 1 read under v3, page 2 continues only while the head is still v3, page 3 ends the chain
  const page1 = P.clinicianViewerPage('1.2.3', 3, { items: [itemRow(ID_A)], nextCursor: ID_A }, KEY);
  const resumed = P.clinicianViewerContinuation(KEY, '1.2.3', page1.nextCursor);
  assert.deepEqual(resumed, { version: 3, after: ID_A });
  assert.equal(P.clinicianViewerContinues(resumed.version, 3), true, 'same signed head: the chain continues');
  const page2 = P.clinicianViewerPage('1.2.3', resumed.version, { items: [itemRow(ID_B)], nextCursor: ID_B }, KEY);
  const resumed2 = P.clinicianViewerContinuation(KEY, '1.2.3', page2.nextCursor);
  assert.deepEqual(resumed2, { version: 3, after: ID_B });
  const page3 = P.clinicianViewerPage('1.2.3', resumed2.version, { items: [itemRow(ID_C)], nextCursor: null }, KEY);
  assert.deepEqual([page1, page2, page3].map(p => [p.reportVersion, p.items.map(i => i.id)]), [[3, [ID_A]], [3, [ID_B]], [3, [ID_C]]]);
  assert.equal(page3.nextCursor, null);

  // the head the gate sees on the next page is not the version the chain started on
  for (const [label, head] of [
    // Astra S5-U1b-F04: page 1 under v3; reset; the first item hidden and the second edited; re-approved as v6
    ['reset, edited and re-approved between the pages', 6],
    ['addendum between the pages', 4],
    ['reset between the pages (no signed head now)', null],
    ['version as text', '3'], ['boolean', true], ['version 0', 0], ['missing', undefined],
  ]) assert.equal(P.clinicianViewerContinues(resumed.version, head), false, label);
  // a first page (no continuation) starts on whatever the gate sees; a null head is withheld by the caller afterwards
  assert.equal(P.clinicianViewerContinues(null, 6), true);
  assert.equal(P.clinicianViewerContinues(null, null), true);
  // started is only ever a verified version: anything else never continues
  for (const started of [0, -1, '3', 1.5]) assert.equal(P.clinicianViewerContinues(started, started), false, String(started));

  // a continuation that does not carry a version this server signed for this study is no continuation at all
  const [payload, signature] = page1.nextCursor.split('.');
  const forged = b64(JSON.stringify({ ...unb64(payload), version: 6 })) + '.' + signature;
  // 32 MAC bytes leave 2 unused bits in the last base64url character: its twin decodes to the same bytes
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const twin = signature.slice(0, -1) + ALPHABET[ALPHABET.indexOf(signature.slice(-1)) ^ 1];
  assert.deepEqual(Buffer.from(twin, 'base64url'), Buffer.from(signature, 'base64url'), 'the twin really decodes to the same MAC');
  for (const [label, cursor] of [
    ['the radiologist path cursor: the bare item id, no version', ID_A],
    ['version moved to the new head, old signature', forged],
    ['signed by a restarted API (another key)', signed(unb64(payload), OTHER_KEY)],
    ['another study\'s continuation', P.clinicianViewerPage('1.2.4', 3, { items: [], nextCursor: ID_A }, KEY).nextCursor],
    ['signature cut short', page1.nextCursor.slice(0, -2)],
    ['signature padded', page1.nextCursor + '='],
    ['signature with a non-canonical last character', payload + '.' + twin],
    ['three parts', page1.nextCursor + '.x'],
    ['no signature', payload], ['empty signature', payload + '.'], ['empty payload', '.' + signature], ['empty', ''],
    ['too long', 'a'.repeat(C.viewer_cursor_max + 1)],
    ['not a string', [page1.nextCursor]], ['null', null], ['number', 3],
    // correctly signed, but the payload is not a continuation this server writes
    ['signed, no version', signed({ v: 1, uid: '1.2.3', after: ID_A })],
    ['signed, version 0', signed({ v: 1, uid: '1.2.3', version: 0, after: ID_A })],
    ['signed, version as text', signed({ v: 1, uid: '1.2.3', version: '3', after: ID_A })],
    ['signed, fractional version', signed({ v: 1, uid: '1.2.3', version: 3.5, after: ID_A })],
    ['signed, unknown format', signed({ v: 2, uid: '1.2.3', version: 3, after: ID_A })],
    ['signed, no uid', signed({ v: 1, version: 3, after: ID_A })],
    ['signed, boundary not an item id', signed({ v: 1, uid: '1.2.3', version: 3, after: 'x' })],
    ['signed, not JSON', signed('{"v":1,')],
    ['signed, JSON null', signed('null')],
  ]) assert.equal(P.clinicianViewerContinuation(KEY, '1.2.3', cursor), null, label);
  // the same cursor verifies again (no one-shot state), and only under the key that signed it
  assert.deepEqual(P.clinicianViewerContinuation(KEY, '1.2.3', page1.nextCursor), resumed);
  assert.equal(P.clinicianViewerContinuation(OTHER_KEY, '1.2.3', page1.nextCursor), null);
  assert.throws(() => P.clinicianViewerContinuation(Buffer.alloc(8), '1.2.3', page1.nextCursor), /at least 32 bytes/);
});

test('viewer pin: the gate before, the signed head read with the items and the gate after must be one version', () => {
  assert.equal(P.clinicianViewerPinned(3, 3, 3), true, 'no report change between the gates');
  for (const [label, before, read, after] of [
    // S5-U1b-F01: gate sees v3; reset reopens (v5, W); an item written and read in W; hidden; re-approved as v6.
    // Both gates say "signed", which a boolean recheck accepted. The read carried no signed head at all.
    ['reset, read in W, re-approved', 3, null, 6],
    // the read itself already sees the re-approved head: still not the version the first gate admitted
    ['reset and re-approved before the read', 3, 6, 6],
    // an addendum or reset after the read: the last gate refuses the page read under v3
    ['addendum after the read', 3, 3, 4],
    ['reset after the read (no longer signed)', 3, 3, null],
    ['reset before the read', 3, null, null],
    // never a boolean, a string or a non-positive version standing in for a head
    ['booleans are not versions', true, true, true],
    ['strings are not versions', '3', '3', '3'],
    ['mixed number and string', 3, '3', 3],
    ['version 0 is no signed head', 0, 0, 0],
    ['negative', -1, -1, -1],
    ['fraction', 1.5, 1.5, 1.5],
    ['unsafe integer', 2 ** 53, 2 ** 53, 2 ** 53],
    ['missing', undefined, undefined, undefined],
    ['null', null, null, null],
  ]) assert.equal(P.clinicianViewerPinned(before, read, after), false, label);
});

test('viewer query: hidden items cannot be requested; a cursor is one bounded string; the rest passes through to viewerPage', () => {
  assert.deepEqual(P.clinicianViewerQuery(undefined), { includeHidden: 'false' });
  assert.deepEqual(P.clinicianViewerQuery({}), { includeHidden: 'false' });
  assert.deepEqual(P.clinicianViewerQuery({ limit: '10', cursor: 'x' }), { limit: '10', cursor: 'x', includeHidden: 'false' });
  assert.deepEqual(P.clinicianViewerQuery({ includeHidden: 'false' }), { includeHidden: 'false' });
  const longest = 'a'.repeat(C.viewer_cursor_max);
  assert.deepEqual(P.clinicianViewerQuery({ cursor: longest }), { cursor: longest, includeHidden: 'false' });
  assert.deepEqual(P.clinicianViewerQuery({ recheck: ID_A }), { recheck: ID_A, includeHidden: 'false' });
  for (const refused of [{ includeHidden: 'true' }, { includeHidden: ['false', 'true'] }, { includeHidden: '' },
    { includeHidden: 'FALSE' }, { includeHidden: undefined }, [], 'includeHidden=true', 7,
    // shape of the continuation (its signature and version are judged by clinicianViewerContinuation)
    { cursor: longest + 'a' }, { cursor: ['a', 'b'] }, { cursor: { after: ID_A } }, { cursor: 3 }, { cursor: undefined },
    { cursor: 'x', recheck: ID_A }])
    assert.equal(P.clinicianViewerQuery(refused), null, JSON.stringify(refused));
});

test('list row: allowlisted identity and status from a full worklist row; overlay applied; no writer field', () => {
  const overlay = { id: 'PID-FIXED', name: 'LEE FIXED', birth: '19810202', sex: 'F', date: '20260925',
    acc: 'ACC-FIXED', desc: 'CT FIXED', modality: 'MR', ward: 'W9', age: 44 };
  const row = P.clinicianStudyRow(worklistRow({}, { ov: overlay }), snap());
  assert.deepEqual(keys(row), sorted(C.list_row_keys));
  assert.deepEqual(keys(row.report), sorted(C.report_final_keys));
  assert.deepEqual([row.id, row.name, row.birth, row.sex, row.date, row.acc, row.desc, row.modality],
    ['PID-FIXED', 'LEE FIXED', '19810202', 'F', '20260925', 'ACC-FIXED', 'CT FIXED', 'MR']);
  assert.equal(row.sourcePatientKey, 'hallym|PID-1', 'the grouping key stays the worklist\'s original-PatientID key');
  assert.deepEqual([row.uid, row.count, row.series, row.institutionName, row.tele], ['1.2.3', 120, 3, 'Hallym', false]);
  assert.deepEqual(row.report, { final: true, rs: 'A', action: 'approve', version: 3, repDoc: 'doc', confirm: '2026-09-26' });
  const text = JSON.stringify(row);
  for (const secret of [SECRET, DRAFT, 'W9', 'hold reason', 'O-1', 'doctor@x', 'reader@x', 'orig', 'engineering_only'])
    assert.ok(!text.includes(secret), secret);
  clean(row, 'list row');
  assert.equal(P.clinicianStudyRow(worklistRow(), snap()).name, 'KIM JOHN', 'no overlay: the server-read tag');

  // Non-object overlays and non-string overlay values fall back to the row's server-read tag.
  for (const ov of ['{"id":"X"}', [1], 'x', 7, { name: 7, id: null }, null]) {
    const plain = P.clinicianStudyRow(worklistRow({}, { ov }), null);
    assert.deepEqual([plain.id, plain.name], ['PID-1', 'KIM JOHN'], JSON.stringify(ov));
  }
  assert.equal(P.clinicianStudyRow(worklistRow({ tele: true }), null).tele, true);
  assert.equal(P.clinicianStudyRow(worklistRow({ tele: 'true' }), null).tele, false, 'only a real boolean');
  assert.equal(P.clinicianStudyRow(worklistRow({ sourcePatientKey: null }), null).sourcePatientKey, null);
  // Unknown counts stay unknown (null), never 0.
  const counts = P.clinicianStudyRow(worklistRow({ count: null, series: 2.5 }), null);
  assert.deepEqual([counts.count, counts.series], [null, null]);
  // Non-final rows carry RS only; a P row stays P without its (already hidden) body.
  const open = { repDoc: null, confirm: null };
  assert.deepEqual(P.clinicianStudyRow(worklistRow({}, { rs: 'T', ...open, version: 4 }), snap({ rs: 'T', ...open, version: 4, action: 'save' })).report,
    { final: false, rs: 'T' });
  assert.deepEqual(P.clinicianStudyRow(worklistRow({}, { rs: 'P', prelimHidden: true, ...open, version: 4 }),
    snap({ rs: 'P', ...open, version: 4, action: 'preliminary' })).report, { final: false, rs: 'P' });
});

test('list row status comes only from the one-statement snapshot, never from the worklist row state', () => {
  // S5-U1b-F02: listStudies read StudyState before an Addendum and Report after it, so its row carries the NEW
  // version with the OLD signer and date. The snapshot row holds the one real combination; the row shows that.
  const mixed = worklistRow({}, { repDoc: 'old-doc', confirm: '2026-09-25', version: 4 });
  const addendum = snap({ repDoc: 'new-doc', confirm: '2026-09-26', version: 4, action: 'addendum' });
  const row = P.clinicianStudyRow(mixed, addendum);
  assert.deepEqual(row.report, { final: true, rs: 'A', action: 'addendum', version: 4, repDoc: 'new-doc', confirm: '2026-09-26' });
  assert.ok(!JSON.stringify(row).includes('old-doc') && !JSON.stringify(row).includes('2026-09-25'), 'a signer of another version leaked');
  // ...and the service never sends that row: the recheck sees the signer the worklist row carried move.
  assert.equal(P.clinicianListChanged([mixed], [addendum]), true);
  // The worklist row saying "signed" does not make the row signed, and the reverse.
  assert.deepEqual(P.clinicianStudyRow(worklistRow(), snap({ rs: 'W', repDoc: null, confirm: null, version: 5, action: 'reset' })).report,
    { final: false, rs: 'W' });
  assert.deepEqual(P.clinicianStudyRow(worklistRow({}, { rs: 'W', version: 0 }), snap()).report.final, true,
    'the projection follows the snapshot; the recheck below is what refuses a list that disagrees with it');
  // No snapshot, a snapshot of another study, or a row without a uid: unknown, never signed.
  for (const [label, listRow, snapshot] of [['no snapshot', worklistRow(), undefined], ['null snapshot', worklistRow(), null],
    ['another study', worklistRow(), snap({ uid: '1.2.4' })], ['row without uid', { state: clientState() }, snap()],
    ['row with a non-string uid', worklistRow({ uid: 7 }), snap({ uid: 7 })]])
    assert.deepEqual(P.clinicianStudyRow(listRow, snapshot).report, { final: false, rs: null }, label);
  // Only a signed head in the snapshot itself is final: its version and action, not the worklist row's.
  for (const [label, over, rs] of [['version as text', { version: '3' }, null], ['no Report row', { version: 0, action: null }, null],
    ['head not a sign-off', { action: 'save' }, null], ['head a discarded row', { action: 'discarded' }, null],
    ['head missing', { action: undefined }, null], ['rs H over a signed head', { rs: 'H' }, 'H']])
    assert.deepEqual(P.clinicianStudyRow(worklistRow(), snap(over)).report, { final: false, rs }, label);
});

test('list answer: narrowed rows, serverTime and counts-only pagination; engineering surfaces dropped', () => {
  const list = { studies: [worklistRow(), worklistRow({ uid: '1.2.4' }, { rs: 'W', version: 0 })],
    serverTime: '2026-09-26T00:00:00.000Z', observedAt: '2026-09-26T00:00:00.000Z',
    notObserved: [{ uid: '9.9', origin: 'gateway', createdAt: 'x', gatewayReceipt: {} }],
    orderReconciliation: { orders: [{ oid: 'O-2', accession: 'present' }] },
    pagination: { owner: ['hallym', 'sub'], next: 'n.s', total: 2, offset: 0, limit: 2 } };
  const snapshots = [snap({ action: 'addendum' }), snap({ uid: '1.2.4', rs: 'W', repDoc: null, confirm: null, version: 0, action: null }),
    snap({ uid: '7.7', version: 1 })];
  const answer = P.clinicianList(list, snapshots);
  assert.deepEqual(keys(answer), sorted(C.list_paged_response_keys));
  assert.deepEqual(answer.studies.map(row => [row.uid, row.report.final, row.report.rs]), [['1.2.3', true, 'A'], ['1.2.4', false, 'W']]);
  assert.equal(answer.studies[0].report.action, 'addendum');
  assert.deepEqual(answer.pagination, { next: 'n.s', total: 2, offset: 0, limit: 2 });
  assert.ok(!JSON.stringify(answer).includes('7.7'), 'a snapshot for a study the list did not carry never appears');
  clean(answer, 'list answer');
  const whole = P.clinicianList({ studies: [], serverTime: 's', observedAt: 'o', notObserved: [], orderReconciliation: null }, []);
  assert.deepEqual(whole, { studies: [], serverTime: 's' });
  assert.deepEqual(keys(whole), sorted(C.list_response_keys));
});

test('list recheck: scope, RS, signer, sign-off date or version moved between the list and the snapshot refuses the answer', () => {
  const rows = [worklistRow(), worklistRow({ uid: '1.2.4' }, { rs: 'T', teleInstitutionId: 'kin-center', repDoc: null, confirm: null, version: 2 })];
  const same = [snap(), snap({ uid: '1.2.4', teleInstitutionId: 'kin-center', rs: 'T', repDoc: null, confirm: null, version: 2, action: 'save' })];
  assert.equal(P.clinicianListChanged(rows, same), false);
  assert.equal(P.clinicianListChanged([], []), false);
  // SQL NULL and an absent key are the same "no value" on both sides.
  assert.equal(P.clinicianListChanged(rows, [{ ...same[0], teleInstitutionId: undefined }, same[1]]), false);
  for (const [label, current] of [
    ['institution', [{ ...same[0], institutionId: 'kin-center' }, same[1]]],
    ['tele cancelled', [same[0], { ...same[1], teleInstitutionId: null }]],
    ['rs reset', [{ ...same[0], rs: 'W' }, same[1]]],
    ['addendum by another signer', [{ ...same[0], repDoc: 'doc2', version: 4, action: 'addendum' }, same[1]]],
    ['addendum by the same signer the next day', [{ ...same[0], confirm: '2026-09-27', version: 4, action: 'addendum' }, same[1]]],
    ['addendum by the same signer the same day', [{ ...same[0], version: 4, action: 'addendum' }, same[1]]],
    ['signer only', [{ ...same[0], repDoc: 'doc2' }, same[1]]],
    ['a first Report row', [same[0], { ...same[1], version: 3 }]],
    ['version as text', [{ ...same[0], version: '3' }, same[1]]],
    ['row gone', [same[0]]],
    ['other row', [same[0], { ...same[1], uid: '1.2.5' }]],
  ]) assert.equal(P.clinicianListChanged(rows, current), true, label);
  // Every pin is compared: moving any one of them alone refuses.
  for (const key of C.list_snapshot_pins)
    assert.equal(P.clinicianListChanged(rows, [{ ...same[0], [key]: 'moved' }, same[1]]), true, key);
});

test('pagination: counts and cursor only; the owner identifiers are not echoed', () => {
  const page = P.clinicianPagination({ owner: ['hallym', 'sub'], next: 'abc.def', total: 7, offset: 0, limit: 5 });
  assert.deepEqual(page, { next: 'abc.def', total: 7, offset: 0, limit: 5 });
  assert.deepEqual(keys(page), sorted(C.pagination_keys));
  assert.equal(P.clinicianPagination({ next: null, total: 1, offset: 0, limit: 5 }).next, null);
  assert.equal(P.clinicianPagination(undefined), undefined);
  clean(page, 'pagination');
});
