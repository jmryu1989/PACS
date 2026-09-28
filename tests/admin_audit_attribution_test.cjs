'use strict';
/* TEST-S5-U5b-PURE: the admin audit attribution rule (api/src/admin-audit.ts).
 * REQ-S5-U5b-ADMIN-AUDIT / MOVE-PROJECTION / UNCLEAR-HIDDEN / NO-MIGRATION-START
 *   -> RISK-S5-U5b-CROSS-INSTITUTION / CURRENT-GROUP-ATTRIBUTION / CURRENT-OWNER-ATTRIBUTION / HIDDEN-COUNT /
 *      NEW-ACTION-DEFAULT / INVENTED-FIELDS / FAILURE-AS-EMPTY.
 *
 *  - the 30 synthetic vectors of the stage5 S5-U5b card (audit_attribution_contract, run 30): record-time readers and
 *    withheld sides per row, over synthetic AuditLog rows shaped like the real writers; vector 31 (added after the card,
 *    Astra S5-U5b-D-F02) is the S5-U4a `study.question` row, hidden by its own table row from every institution;
 *  - the rejected current-group / current-owner rule as a negative control: it leaks exactly the card's rows;
 *  - unclear rows, the page read (filtering before paging, totals and continuations over visible rows only, a failed
 *    source never an empty page), the sealed continuation and the query shape;
 *  - Astra S5-U5b-B-F01: the continuation has one length whatever the pinned top, the row id, the reader or the hidden
 *    rows above the reader's own (GCM does not hide the payload length);
 *  - Astra S5-U5b-B-F02: the SQL prefilter (strpos, a literal substring) loses no visible row and adds none for
 *    institution names carrying \, ", % and _; the removed LIKE form, modelled, loses exactly the \ and " names' rows;
 *  - completeness (Astra S7-U3a-AUDIT-SPEC-R-001 F01-F04): every file of api/src is read; every audit candidate there is
 *    resolved, proven not a write, or unresolved — and one unresolved fails; every action a write can record has a
 *    contract row and every row is written somewhere. The TypeScript compiler api/package-lock.json installs reads the
 *    program of api/src (see the completeness section). The checker's own tests run on test-owned fixtures
 *    (tests/fixtures/admin_audit_completeness): the supported notations, and each failure class failing the gate alone;
 *    api/src rewritten in other notations keeps every write site; unlisted, dynamic and unwritten actions each fail alone.
 *
 * Module: KIN_ADMIN_AUDIT_MODULE, default api/src/admin-audit.ts loaded through Node type stripping (Node >= 22.18);
 * the compiled /app/dist/admin-audit (kin-api:ci) is the same rule. The completeness cases read api/src and use
 * api/node_modules/typescript ('npm ci --prefix api --ignore-scripts'), so the repository must be mounted with it; without
 * it they fail. Synthetic data only: no network, database, credentials or clinical data.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { createCipheriv, randomBytes } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const MODULE = process.env.KIN_ADMIN_AUDIT_MODULE || 'api/src/admin-audit.ts';
const A = require(path.isAbsolute(MODULE) ? MODULE : path.resolve(ROOT, MODULE));

/* BEGIN S5-U5b audit_attribution_contract */
const CONTRACT = {
  "field_rules": {"study.arrived":{"source":"detail.institutionId","meaning":"owner at creation (system sync; null = unassigned)"},"study.announce":{"source":"detail.institutionId","meaning":"owner at creation (gateway credential institution)"},"study.assign":{"source":"detail.institutionId","meaning":"newly assigned owner (assign refuses re-assignment)"},"match":{"source":"detail.by","meaning":"caller institution; match is owner-only"},"unmatch":{"source":"detail.by","meaning":"caller institution; unmatch is owner-only"},"state.delete":{"source":"detail.by","meaning":"caller institution; delete is owner-only"},"tech-note.revise":{"source":"detail.institutionId","meaning":"caller institution; tech notes are owner-only"},"state.patch":{"source":"detail.by","meaning":"ACTOR institution (owner, or tele receiver for its TS segment)"},"report.draft.force-discard":{"source":"detail.by","meaning":"actor institution"},"hold.force-release":{"source":"detail.by","meaning":"actor institution"},"reader.assignment":{"source":"detail.institution","meaning":"owner institution; assignment is owner-only"},"study.access":{"source":"detail.institution","meaning":"policy institution; subject was a member there at write time"},"study.consultation":{"source":"detail.institution","meaning":"owner institution; consultation is owner-only"},"hanging-protocol.site.save":{"source":"target","meaning":"target is the site institution id"},"hanging-protocol.site.reset":{"source":"target","meaning":"target is the site institution id"}},
  "report_commit_actions_by_detail_by": ["addendum","approve","defer","preliminary","reset","save"],
  "hidden_no_record_time_institution": ["admin.user.list","report.draft","report.draft.clear","report.draft.rebase","report.draft.discard","report.hold","dictation.request","gateway.receipt.first","gateway.receipt.transition","gateway.receipt.epoch_unrecognised","gateway.retry.request","viewer.job","manualSr.expire","manualSr.expire-deferred","manualSr.store","manualSr.prepare","manualSr.store-intent","finding.*","viewer.*","favorite.*","study.tag.*"],
  "hidden_connect_out_of_scope": ["basis.record","basis.revoke","agreement.record","agreement.terminate","transfer.open","transfer.expire","transfer.revoke"],
  "default": "hidden:unknown_action (fail closed)",
  "member_snapshot_fields_projected": ["id","username","name","roles","enabled","approvalState","emailVerified","institution"],
  "member_event_fields": ["verificationOverride","mode","failed"],
  "member_email_projected": false,
  "synthetic_vectors": [
    {"row":1,"action":"admin.user.create","rule":"member_snapshots","record_time_visible_to":[],"withheld_sides":{},"note":"created PENDING: no institution at write time"},
    {"row":2,"action":"admin.user.approve","rule":"member_snapshots","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"approved into A"},
    {"row":3,"action":"admin.user.update","rule":"member_snapshots","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A-era role change"},
    {"row":4,"action":"admin.user.reset-password","rule":"member_snapshots","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A-era password reset"},
    {"row":5,"action":"admin.user.update","rule":"member_snapshots","record_time_visible_to":["inst-a","inst-b"],"withheld_sides":{"inst-a":["after"],"inst-b":["before"]},"note":"MOVE A->B by a third-institution admin (realm-wide console)"},
    {"row":6,"action":"admin.user.suspend","rule":"member_snapshots","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"B-era suspend"},
    {"row":7,"action":"admin.user.unapprove","rule":"member_snapshots","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"approval cancelled while in B"},
    {"row":8,"action":"admin.user.patch.failed","rule":"member_snapshots","record_time_visible_to":[],"withheld_sides":{},"note":"failed patch from PENDING, after not recorded: no institution"},
    {"row":9,"action":"admin.user.patch.failed","rule":"member_snapshots","record_time_visible_to":["inst-a","inst-b"],"withheld_sides":{"inst-a":["before"],"inst-b":["after"]},"note":"partial move B->A left isolated (after has one group, no role = INVALID but single institution)"},
    {"row":10,"action":"admin.user.update","rule":"member_snapshots","record_time_visible_to":[],"withheld_sides":{},"note":"before snapshot ambiguous (several groups -> institution null, INVALID): hidden"},
    {"row":11,"action":"admin.user.list","rule":"hidden:no_record_time_institution","record_time_visible_to":[],"withheld_sides":{},"note":"no record-time institution (realm-wide counts)"},
    {"row":12,"action":"admin.user.create.failed","rule":"member_snapshots","record_time_visible_to":[],"withheld_sides":{},"note":"nothing recorded"},
    {"row":13,"action":"admin.user.create","rule":"member_snapshots","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"face-to-face create into A"},
    {"row":14,"action":"admin.user.update","rule":"member_snapshots","record_time_visible_to":[],"withheld_sides":{},"note":"unparsable detail"},
    {"row":15,"action":"study.access","rule":"field:detail.institution","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A policy on m1 written while m1 was in A"},
    {"row":16,"action":"study.arrived","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"S1 created under A"},
    {"row":17,"action":"match","rule":"field:detail.by","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A-era match with overlay"},
    {"row":18,"action":"reader.assignment","rule":"field:detail.institution","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A-era reader assignment"},
    {"row":19,"action":"state.delete","rule":"field:detail.by","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A deletes StudyState S1"},
    {"row":20,"action":"study.arrived","rule":"field:detail.institutionId","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"sync re-creates S1 under tag-resolved B"},
    {"row":21,"action":"state.patch","rule":"field:detail.by","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"B-era patch"},
    {"row":22,"action":"report.approve","rule":"field:detail.by","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"tele receiver B approves A's study S2: actor institution only"},
    {"row":23,"action":"report.draft","rule":"hidden:no_record_time_institution","record_time_visible_to":[],"withheld_sides":{},"note":"no record-time institution"},
    {"row":24,"action":"study.arrived","rule":"field:detail.institutionId","record_time_visible_to":[],"withheld_sides":{},"note":"unassigned at write time"},
    {"row":25,"action":"study.assign","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"assigned to A by another institution's admin"},
    {"row":26,"action":"gateway.receipt.first","rule":"hidden:no_record_time_institution","record_time_visible_to":[],"withheld_sides":{},"note":"no institution in row (S5-U6a has its own scoped surface)"},
    {"row":27,"action":"agreement.record","rule":"hidden:connect_out_of_scope","record_time_visible_to":[],"withheld_sides":{},"note":"Connect rows not widened by S5-U5b"},
    {"row":28,"action":"future.action","rule":"hidden:unknown_action","record_time_visible_to":[],"withheld_sides":{},"note":"unknown action: fail closed"},
    {"row":29,"action":"hanging-protocol.site.save","rule":"field:target","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"site setting of A"},
    {"row":30,"action":"hold.force-release","rule":"field:detail.by","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A admin releases a hold on its study"}
  ],
  "rejected_current_rule_leaks": [
    {"row":2,"action":"admin.user.approve","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]},
    {"row":3,"action":"admin.user.update","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]},
    {"row":4,"action":"admin.user.reset-password","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]},
    {"row":5,"action":"admin.user.update","recorded":["inst-a","inst-b"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a","inst-b"]},
    {"row":9,"action":"admin.user.patch.failed","recorded":["inst-a","inst-b"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a","inst-b"]},
    {"row":16,"action":"study.arrived","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]},
    {"row":17,"action":"match","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]},
    {"row":18,"action":"reader.assignment","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]},
    {"row":19,"action":"state.delete","recorded":["inst-a"],"leaked_to":["inst-b"],"hidden_from_record_time_institution":["inst-a"]}
  ]
};
/* END S5-U5b audit_attribution_contract */
/* After the card (Astra S5-U5b-D-F02): `study.question`, the S5-U4a clinician question record, gets its own hidden row
 * instead of the unknown-action default. Its detail names the creating institution, but the one place that shows it is
 * the study-scoped audit (pacs.service.ts audits(), OWNER_ONLY_AUDIT_ACTIONS), to the owner institution only; the
 * Members console shows it to no institution. The card block above stays verbatim. `study.image-request`, the S5-U4c
 * image request record (the S5-U4c merge), is the same kind of owner-only study-scoped row and takes the same row, and
 * so does `study.critical-result`, the S7-U1a critical result delivery record (contract S7-U1p section 11.2: owner-only,
 * never the Members console; the admin is no actor of a delivery). */
CONTRACT.hidden_study_scoped_owner_only = ["study.question", "study.image-request", "study.critical-result"];
CONTRACT.synthetic_vectors.push({"row":31,"action":"study.question","rule":"hidden:study_scoped_owner_only","record_time_visible_to":[],"withheld_sides":{},"note":"clinician question naming its institution: study-scoped owner-only audit, never the Members console"});

const json = value => JSON.parse(JSON.stringify(value));
const WITHHELD = { withheld: 'other_institution' };

// ── synthetic rows (SYN-*), shaped like the writers: admin.service.ts row()/audit(), pacs.service.ts, study-access ──
const M = 'syn-member-m';            // approved into A, moved A->B, suspended and un-approved in B
const MP = 'syn-member-pending';     // stays PENDING
const M2 = 'syn-member-m2';          // B member left isolated in A by a failed move, later put back into B
const MX = 'syn-member-ambiguous';   // several groups when the row was written, deleted since
const MF = 'syn-member-failed';      // failed create, deleted since
const M3 = 'syn-member-face';        // face-to-face create into A
const MU = 'syn-member-unparsable';
const M1 = 'syn-member-m1';          // study-access subject, still in A
const S1 = '1.2.826.0.1.3680043.10.5001.1', S2 = '1.2.826.0.1.3680043.10.5001.2';
const S3 = '1.2.826.0.1.3680043.10.5001.3', S4 = '1.2.826.0.1.3680043.10.5001.4';

function snap(id, institution, approvalState, extra = {}) {
  return { id, username: `${id}-user`, email: `${id}@members.test`, emailVerified: true, name: `SYN ${id}`,
    institution, roles: approvalState === 'PENDING' ? [] : ['technician'], enabled: true, approvalState, ...extra };
}
const at = n => new Date(Date.UTC(2026, 8, 26, 0, 0, n));
const row = (id, action, target, detail, actor = 'syn-admin-a@members.test') =>
  ({ id, at: at(id), actor, action, target, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

const ROWS = new Map([
  row(1, 'admin.user.create', MP, { before: null, after: snap(MP, null, 'PENDING'), verificationOverride: false }),
  row(2, 'admin.user.approve', M, { before: snap(M, null, 'PENDING'), after: snap(M, 'inst-a', 'APPROVED'), verificationOverride: true }),
  row(3, 'admin.user.update', M, { before: snap(M, 'inst-a', 'APPROVED'),
    after: snap(M, 'inst-a', 'APPROVED', { roles: ['radiologist', 'technician'] }), verificationOverride: false }),
  row(4, 'admin.user.reset-password', M, { before: snap(M, 'inst-a', 'APPROVED'), after: snap(M, 'inst-a', 'APPROVED'), mode: 'temp' }),
  row(5, 'admin.user.update', M, { before: snap(M, 'inst-a', 'APPROVED'), after: snap(M, 'inst-b', 'APPROVED'),
    verificationOverride: true }, 'syn-admin-z@members.test'),
  row(6, 'admin.user.suspend', M, { before: snap(M, 'inst-b', 'APPROVED'), after: snap(M, 'inst-b', 'APPROVED', { enabled: false }),
    verificationOverride: false }, 'syn-admin-b@members.test'),
  row(7, 'admin.user.unapprove', M, { before: snap(M, 'inst-b', 'APPROVED', { enabled: false }), after: snap(M, null, 'PENDING'),
    verificationOverride: false }, 'syn-admin-b@members.test'),
  row(8, 'admin.user.patch.failed', MP, { before: snap(MP, null, 'PENDING'), after: null, verificationOverride: true, failed: true }),
  row(9, 'admin.user.patch.failed', M2, { before: snap(M2, 'inst-b', 'APPROVED'), after: snap(M2, 'inst-a', 'INVALID', { roles: [] }),
    verificationOverride: true, failed: true }, 'syn-admin-z@members.test'),
  row(10, 'admin.user.update', MX, { before: snap(MX, null, 'INVALID'), after: snap(MX, 'inst-a', 'APPROVED'), verificationOverride: true }),
  row(11, 'admin.user.list', 'admin-users', { page: 1, count: 4, pendingCount: 1 }),
  row(12, 'admin.user.create.failed', MF, { before: null, after: null, verificationOverride: true, failed: true }),
  row(13, 'admin.user.create', M3, { before: null, after: snap(M3, 'inst-a', 'APPROVED'), verificationOverride: true }),
  row(14, 'admin.user.update', MU, `{"before":{"id":"${MU}","institution":"inst-a","approvalState":"APPROVED"},"after":`),
  row(15, 'study.access', M1, { institution: 'inst-a', subject: M1, revision: 1, restricted: true, reason: 'SYN policy reason',
    requestId: '00000000-0000-4000-8000-000000000015' }),
  row(16, 'study.arrived', S1, { institutionId: 'inst-a' }, 'system'),
  row(17, 'match', S1, { oid: 'O-SYN-17', ov: { name: 'SYN^PATIENT', id: 'SYN-P1' }, by: 'inst-a' }),
  row(18, 'reader.assignment', S1, { institution: 'inst-a', revision: 1, from: null, to: 'syn-reader-a@members.test' }),
  row(19, 'state.delete', S1, { by: 'inst-a' }),
  row(20, 'study.arrived', S1, { institutionId: 'inst-b' }, 'system'),
  row(21, 'state.patch', S1, { ward: 'SYN-WARD', by: 'inst-b' }, 'syn-admin-b@members.test'),
  row(22, 'report.approve', S2, { version: 1, by: 'inst-b', len: [10, 5, 0] }, 'syn-reader-b@members.test'),
  row(23, 'report.draft', S2, { len: [3, 0, 0] }, 'syn-reader-a@members.test'),
  row(24, 'study.arrived', S3, { institutionId: null }, 'system'),
  row(25, 'study.assign', S3, { institutionId: 'inst-a' }, 'syn-admin-z@members.test'),
  row(26, 'gateway.receipt.first', S4, { epoch: '0a1b2c3d-0000-4000-8000-00000000000a', seq: 1, phase: 'sending' }, 'service-account-gw-syn'),
  row(27, 'agreement.record', 'syn-agreement-27', { agreementId: 'syn-agreement-27', from: 'inst-a', to: 'inst-b' }),
  row(28, 'future.action', S1, { by: 'inst-a' }),
  row(29, 'hanging-protocol.site.save', 'inst-a', { revision: 2 }),
  row(30, 'hold.force-release', S2, { by: 'inst-a', holder: 'syn-reader-b@members.test', heldAt: '2026-09-26T00:00:00.000Z', alive: true }),
  // clinician-question.service.ts receipt(): the creating institution is recorded, the row is still not the console's
  row(31, 'study.question', S2, { id: '00000000-0000-4000-8000-000000000031', institution: 'inst-a',
    entry: '00000000-0000-4000-8000-000000000031', kind: 'question', from: null, to: 'Open', revision: 1,
    requestId: '00000000-0000-4000-8000-000000000031', role: 'clinician' }, 'syn-clinician-a@members.test'),
].map(r => [r.id, r]));

/** Sides of a member row the reader gets as {withheld:'other_institution'} (field rows withhold nothing). */
function withheldSides(projection) {
  return ['before', 'after'].filter(side => JSON.stringify(projection.detail[side]) === JSON.stringify(WITHHELD));
}

function deepKeys(value, keys = new Set()) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { keys.add(key); deepKeys(item, keys); }
  return keys;
}

// ── the contract table ──

test('the module table is the card contract; allowed and hidden never overlap; the default is hidden', () => {
  assert.deepEqual(json(A.AUDIT_FIELD_RULES), Object.fromEntries(Object.entries(CONTRACT.field_rules).map(([k, v]) => [k, v.source])));
  assert.deepEqual(json(A.AUDIT_REPORT_COMMIT_ACTIONS), CONTRACT.report_commit_actions_by_detail_by);
  assert.deepEqual(json(A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION), CONTRACT.hidden_no_record_time_institution);
  assert.deepEqual(json(A.AUDIT_HIDDEN_CONNECT), CONTRACT.hidden_connect_out_of_scope);
  assert.deepEqual(json(A.AUDIT_HIDDEN_STUDY_SCOPED), CONTRACT.hidden_study_scoped_owner_only);
  assert.deepEqual(json(A.AUDIT_MEMBER_SNAPSHOT_FIELDS), CONTRACT.member_snapshot_fields_projected);
  assert.equal(CONTRACT.member_email_projected, false);
  assert.ok(!A.AUDIT_MEMBER_SNAPSHOT_FIELDS.includes('email'));
  for (const list of [A.AUDIT_MEMBER_ACTIONS, A.AUDIT_REPORT_COMMIT_ACTIONS, A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION,
    A.AUDIT_HIDDEN_CONNECT, A.AUDIT_HIDDEN_STUDY_SCOPED, A.AUDIT_MEMBER_SNAPSHOT_FIELDS, A.AUDIT_CANDIDATE_ACTIONS,
    A.AUDIT_TARGET_ACTIONS])
    assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(A.AUDIT_FIELD_RULES));
  // Every allowed action resolves to its own rule, never to a hidden wildcard, and the candidate list is exactly them.
  const allowed = [...A.AUDIT_MEMBER_ACTIONS, ...Object.keys(A.AUDIT_FIELD_RULES), ...A.AUDIT_REPORT_COMMIT_ACTIONS.map(a => 'report.' + a)];
  assert.deepEqual([...A.AUDIT_CANDIDATE_ACTIONS].sort(), [...new Set(allowed)].sort());
  for (const action of allowed) assert.doesNotMatch(A.auditRule(action), /^hidden:/, action);
  const hiddenEntries = [...A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION, ...A.AUDIT_HIDDEN_CONNECT, ...A.AUDIT_HIDDEN_STUDY_SCOPED];
  for (const entry of hiddenEntries) {
    const covers = action => entry.endsWith('*') ? action.startsWith(entry.slice(0, -1)) : action === entry;
    assert.deepEqual(allowed.filter(covers), [], `${entry} shadows an allowed action`);
  }
  assert.deepEqual(json(A.AUDIT_TARGET_ACTIONS), ['hanging-protocol.site.save', 'hanging-protocol.site.reset']);
  // study.question (S5-U4a), study.image-request (S5-U4c) and study.critical-result (S7-U1a) are hidden by their own
  // rows, and the SQL prefilter never fetches them for any institution.
  for (const action of ['study.question', 'study.image-request', 'study.critical-result']) {
    assert.equal(A.auditRule(action), 'hidden:study_scoped_owner_only', action);
    assert.ok(!A.AUDIT_CANDIDATE_ACTIONS.includes(action), action);
  }
  for (const reader of ['inst-a', 'inst-b', 'inst-z']) assert.equal(A.auditCandidateRow(ROWS.get(31), reader), false, reader);
  // Fail closed: unknown, near-miss and non-string actions are hidden.
  assert.equal(CONTRACT.default, 'hidden:unknown_action (fail closed)');
  for (const action of ['future.action', 'Match', 'match ', 'report.sign', 'report.', 'admin.user.delete', 'study.question.reply',
    'study.image-transfer', 'hanging-protocol.site', '', null, undefined, 7, {}])
    assert.equal(A.auditRule(action), 'hidden:unknown_action', String(action));
});

test('the synthetic vectors (the card\'s 30 and study.question): record-time readers and withheld sides per row', () => {
  // 31 = the card's 30, unchanged, and the study.question row added with its contract row (Astra S5-U5b-D-F02).
  assert.equal(CONTRACT.synthetic_vectors.length, 31);
  assert.deepEqual(CONTRACT.synthetic_vectors.slice(0, 30).map(v => v.row), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual(CONTRACT.synthetic_vectors[30], { row: 31, action: 'study.question', rule: 'hidden:study_scoped_owner_only',
    record_time_visible_to: [], withheld_sides: {}, note: CONTRACT.synthetic_vectors[30].note });
  assert.deepEqual([...ROWS.keys()], CONTRACT.synthetic_vectors.map(v => v.row));
  for (const vector of CONTRACT.synthetic_vectors) {
    const source = ROWS.get(vector.row);
    assert.equal(source.action, vector.action, `row ${vector.row}`);
    const result = A.attributeAuditRow(source);
    assert.equal(result.rule, vector.rule, `row ${vector.row} rule`);
    assert.deepEqual(json(result.visible_to), vector.record_time_visible_to, `row ${vector.row} (${vector.note})`);
    assert.deepEqual([...result.projection_by_side.keys()].sort(), vector.record_time_visible_to, `row ${vector.row} sides`);
    assert.deepEqual(Object.keys(vector.withheld_sides).sort(), vector.record_time_visible_to);
    for (const reader of vector.record_time_visible_to) {
      const projection = result.projection_by_side.get(reader);
      assert.deepEqual(projection, A.projectAuditRow(source, reader));
      assert.deepEqual(withheldSides(projection), vector.withheld_sides[reader], `row ${vector.row} withheld for ${reader}`);
      assert.deepEqual([projection.at, projection.actor, projection.action, projection.target, projection.rule],
        [source.at.toISOString(), source.actor, source.action, source.target, vector.rule]);
    }
    for (const reader of ['inst-a', 'inst-b', 'inst-z'].filter(i => !vector.record_time_visible_to.includes(i)))
      assert.equal(A.projectAuditRow(source, reader), null, `row ${vector.row} must not reach ${reader}`);
    assert.equal(result.hidden === null, vector.record_time_visible_to.length > 0, `row ${vector.row} hidden reason`);
  }
});

test('member rows: each side sees its own snapshot, the other side is withheld unnamed; email is never projected', () => {
  const move = A.attributeAuditRow(ROWS.get(5));
  const a = move.projection_by_side.get('inst-a'), b = move.projection_by_side.get('inst-b');
  assert.deepEqual(json(a.detail), { before: { institution: 'inst-a', approvalState: 'APPROVED', id: M, username: `${M}-user`,
    name: `SYN ${M}`, roles: ['technician'], enabled: true, emailVerified: true }, after: WITHHELD, verificationOverride: true });
  assert.deepEqual(json(b.detail.before), WITHHELD);
  assert.equal(b.detail.after.institution, 'inst-b');
  assert.ok(!JSON.stringify(a).includes('inst-b'), 'A never learns where the member went');
  assert.ok(!JSON.stringify(b).includes('inst-a'), 'B never learns where the member came from');
  // The event fields go to both sides; the actor (a third institution's admin) is an event field.
  assert.equal(a.actor, 'syn-admin-z@members.test');
  assert.equal(b.actor, 'syn-admin-z@members.test');
  // A PENDING snapshot names no institution: it is shown with the side that does (approve, unapprove).
  const approve = A.projectAuditRow(ROWS.get(2), 'inst-a');
  assert.equal(approve.detail.before.approvalState, 'PENDING');
  assert.equal(approve.detail.before.institution, null);
  const reset = A.projectAuditRow(ROWS.get(4), 'inst-a');
  assert.equal(reset.detail.mode, 'temp');
  assert.ok(!('verificationOverride' in reset.detail), 'a field the row did not record is not invented');
  const failed = A.projectAuditRow(ROWS.get(9), 'inst-a');
  assert.deepEqual([failed.detail.failed, failed.detail.after.approvalState, failed.detail.after.roles], [true, 'INVALID', []]);
  // No projection of any vector carries an email key or a member's email address.
  for (const source of ROWS.values()) {
    for (const [reader, projection] of A.attributeAuditRow(source).projection_by_side) {
      assert.ok(!deepKeys(projection).has('email'), `row ${source.id} for ${reader}`);
      assert.doesNotMatch(JSON.stringify(projection), /syn-member-[a-z0-9]+@members\.test/, `row ${source.id} for ${reader}`);
    }
  }
  // A projection is a copy: changing what one reader got changes neither the next read nor the other side.
  a.detail.before.roles.push('admin');
  assert.deepEqual(A.projectAuditRow(ROWS.get(5), 'inst-a').detail.before.roles, ['technician']);
});

// The rejected rule (the removed D7 wording): a member row goes whole to the member's CURRENT group and a study row to
// the study's CURRENT owner/tele. The current world: m moved to B, m2 put back into B, S1 deleted and re-created under B.
const CURRENT_GROUP = new Map([[M, 'inst-b'], [M2, 'inst-b'], [M3, 'inst-a'], [M1, 'inst-a']]);
const CURRENT_OWNER = new Map([[S1, ['inst-b']], [S2, ['inst-a', 'inst-b']], [S3, ['inst-a']]]);
function currentRule(source) {
  if (source.action.startsWith('admin.user.') || source.action === 'study.access') {
    const group = CURRENT_GROUP.get(source.target);
    return group ? [group] : [];
  }
  return [...(CURRENT_OWNER.get(source.target) ?? [])].sort();
}

test('negative control: the current-group/current-owner rule leaks exactly the card rows; the record-time rule does not', () => {
  assert.equal(CONTRACT.rejected_current_rule_leaks.length, 9);
  for (const leak of CONTRACT.rejected_current_rule_leaks) {
    const source = ROWS.get(leak.row);
    assert.equal(source.action, leak.action);
    const recorded = A.attributeAuditRow(source);
    assert.deepEqual(json(recorded.visible_to), leak.recorded, `row ${leak.row}`);
    assert.deepEqual(currentRule(source), leak.leaked_to, `row ${leak.row}: the rejected rule hands the row to ${leak.leaked_to}`);
    const whole = JSON.parse(source.detail);
    for (const institution of leak.leaked_to) {
      const mine = recorded.projection_by_side.get(institution);
      if (!mine) continue;   // the record-time rule does not show it at all
      // Shown on both sides (a move): the record-time view withholds the side that is not this institution's,
      // where the rejected rule hands over the whole row with both snapshots.
      assert.ok(withheldSides(mine).length === 1, `row ${leak.row}`);
      const other = withheldSides(mine)[0];
      assert.notDeepEqual(json(mine.detail[other]), whole[other]);
      assert.ok(!JSON.stringify(mine).includes(whole[other].institution), `row ${leak.row}: the other side is unnamed`);
    }
    for (const institution of leak.hidden_from_record_time_institution) {
      const mine = recorded.projection_by_side.get(institution);
      assert.ok(mine, `row ${leak.row}: ${institution} receives its record-time view`);
      // What the rejected rule gives this institution is never its record-time view: nothing, or the unprojected row.
      const rejected = currentRule(source).includes(institution) ? whole : null;
      assert.notDeepEqual(rejected === null ? null : json(rejected), json(mine.detail), `row ${leak.row} ${institution}`);
    }
  }
  // The vector harness catches the rejected rule: it disagrees with the expected readers on every leak row.
  const wrong = CONTRACT.synthetic_vectors.filter(v => JSON.stringify(currentRule(ROWS.get(v.row))) !==
    JSON.stringify(v.record_time_visible_to)).map(v => v.row);
  for (const leak of CONTRACT.rejected_current_rule_leaks) assert.ok(wrong.includes(leak.row), `row ${leak.row} undetected`);
});

test('unclear rows are hidden: unparsable, ambiguous or malformed snapshots, missing fields, foreign ids', () => {
  const member = (detail, action = 'admin.user.update', target = M) => A.attributeAuditRow(row(99, action, target, detail));
  const cases = {
    'detail is not JSON': member('{"before":'),
    'detail is an array': member([snap(M, 'inst-a', 'APPROVED')]),
    'detail is JSON null': member('null'),
    'detail is absent': A.attributeAuditRow({ ...row(99, 'admin.user.update', M, {}), detail: null }),
    'no before key': member({ after: snap(M, 'inst-a', 'APPROVED') }),
    'no after key': member({ before: snap(M, 'inst-a', 'APPROVED') }),
    'several groups (null, INVALID) after': member({ before: snap(M, 'inst-a', 'APPROVED'), after: snap(M, null, 'INVALID') }),
    'null institution but APPROVED': member({ before: snap(M, 'inst-a', 'APPROVED'), after: snap(M, null, 'APPROVED') }),
    'institution while PENDING': member({ before: null, after: snap(M, 'inst-a', 'PENDING') }),
    'empty institution': member({ before: null, after: snap(M, '', 'APPROVED') }),
    'numeric institution': member({ before: null, after: snap(M, 7, 'APPROVED') }),
    'unknown approval state': member({ before: null, after: snap(M, 'inst-a', 'ACTIVE') }),
    'no institution key': member({ before: null, after: (({ institution, ...rest }) => rest)(snap(M, 'inst-a', 'APPROVED')) }),
    'another member\'s snapshot': member({ before: null, after: snap(M2, 'inst-a', 'APPROVED') }),
    'snapshot is a string': member({ before: null, after: 'inst-a' }),
    'both not recorded': member({ before: null, after: null }),
    'field row without its field': A.attributeAuditRow(row(99, 'state.patch', S1, { ward: 'X' })),
    'field row with a null field': A.attributeAuditRow(row(99, 'match', S1, { by: null })),
    'field row with a numeric field': A.attributeAuditRow(row(99, 'study.access', M1, { institution: 1 })),
    'field row with an empty field': A.attributeAuditRow(row(99, 'reader.assignment', S1, { institution: '' })),
    'field value inherited, not own': A.attributeAuditRow({ ...row(99, 'match', S1, {}), detail: '{"__proto__":{"by":"inst-a"}}' }),
    'target rule with an empty target': A.attributeAuditRow(row(99, 'hanging-protocol.site.reset', '', { revision: 1 })),
    'invalid time': A.attributeAuditRow({ ...row(99, 'match', S1, { by: 'inst-a' }), at: 'yesterday' }),
    'non-string actor': A.attributeAuditRow({ ...row(99, 'match', S1, { by: 'inst-a' }), actor: null }),
    'no row at all': A.attributeAuditRow(undefined),
  };
  for (const [name, result] of Object.entries(cases)) {
    assert.deepEqual(json(result.visible_to), [], name);
    assert.equal(result.projection_by_side.size, 0, name);
    assert.equal(typeof result.hidden, 'string', name);
  }
  // A malformed display field is not guessed: it is left out (the page says not recorded); attribution still holds.
  const odd = A.projectAuditRow(row(99, 'admin.user.update', M, { before: null,
    after: snap(M, 'inst-a', 'APPROVED', { roles: 'technician', enabled: 'yes', name: 7 }) }), 'inst-a');
  assert.deepEqual(Object.keys(odd.detail.after).sort(), ['approvalState', 'emailVerified', 'id', 'institution', 'username']);
  assert.equal(odd.detail.before, null);
  // An inherited-looking key in a recorded detail stays data.
  const proto = A.projectAuditRow({ ...row(99, 'match', S1, {}), detail: '{"by":"inst-a","__proto__":{"x":1}}' }, 'inst-a');
  assert.equal(proto.detail.by, 'inst-a');
  assert.equal(({}).x, undefined);
});

// ── the page read ──

function table() {
  // ids 1..40, newest first when read: A rows, B rows, hidden rows and an unparsable A-looking row, interleaved.
  const rows = [];
  for (let id = 1; id <= 40; id++) {
    const kind = id % 4;
    if (kind === 0) rows.push(row(id, 'study.arrived', `${S1}.${id}`, { institutionId: 'inst-a' }, 'system'));
    else if (kind === 1) rows.push(row(id, 'state.patch', `${S1}.${id}`, { by: 'inst-b' }));
    else if (kind === 2) rows.push(row(id, 'report.draft', `${S1}.${id}`, { len: [1, 0, 0], by: 'inst-a' }));
    else rows.push(row(id, 'match', `${S1}.${id}`, '{"by":"inst-a"'));
  }
  return rows;
}
function sourceOver(rows, calls = []) {
  return async (below, take) => {
    calls.push([below, take]);
    return rows.filter(r => below === null || r.id < below).sort((x, y) => y.id - x.id).slice(0, take);
  };
}

test('the page read filters before paging: totals, pages and the continuation count visible rows only', async () => {
  const rows = table(), visibleA = rows.filter(r => r.id % 4 === 0).map(r => r.id).sort((x, y) => y - x);
  assert.deepEqual(visibleA, [40, 36, 32, 28, 24, 20, 16, 12, 8, 4]);
  const calls = [];
  const first = await A.readAuditPage(sourceOver(rows, calls), 'inst-a', { after: null, limit: 4, batch: 3 });
  assert.equal(first.total, 10, 'hidden, unparsable and other-institution rows are not counted');
  assert.deepEqual(first.rows.map(r => r.target), [40, 36, 32, 28].map(id => `${S1}.${id}`));
  assert.equal(first.last, 28);
  assert.deepEqual(calls.slice(0, 3), [[null, 3], [38, 3], [35, 3]], 'the source is walked downward in batches');
  // Totals need every visible row: 13 full batches of 3 and a last short one of 1, whatever the page size.
  assert.equal(calls.length, 14);
  const second = await A.readAuditPage(sourceOver(rows), 'inst-a', { after: first.last, limit: 4, batch: 7 });
  assert.equal(second.total, 10);
  assert.deepEqual(second.rows.map(r => r.target), [24, 20, 16, 12].map(id => `${S1}.${id}`));
  const third = await A.readAuditPage(sourceOver(rows), 'inst-a', { after: second.last, limit: 4, batch: 100 });
  assert.deepEqual(third.rows.map(r => r.target), [8, 4].map(id => `${S1}.${id}`));
  assert.equal(third.last, null, 'no continuation after the last visible row');
  // An exact page end: four visible rows and a limit of four leave no continuation.
  const exact = await A.readAuditPage(sourceOver(rows.filter(r => r.id <= 16)), 'inst-a', { after: null, limit: 4 });
  assert.deepEqual([exact.total, exact.rows.length, exact.last], [4, 4, null]);
  // B sees its own rows; Z sees nothing and an empty page is an answer with total 0, not a failure.
  const b = await A.readAuditPage(sourceOver(rows), 'inst-b', { after: null, limit: 100 });
  assert.deepEqual([b.total, b.rows.length, b.last], [10, 10, null]);
  const z = await A.readAuditPage(sourceOver(rows), 'inst-z', { after: null, limit: 25 });
  assert.deepEqual(json(z), { rows: [], total: 0, last: null });
  const empty = await A.readAuditPage(sourceOver([]), 'inst-a', { after: null, limit: 25 });
  assert.deepEqual(json(empty), { rows: [], total: 0, last: null });
});

test('a failed or disordered source is an error, never an empty page', async () => {
  const rows = table();
  let n = 0;
  const failing = async (below, take) => { if (++n === 2) throw Object.assign(new Error('SYN db down'), { code: 'P1001' }); return sourceOver(rows)(below, take); };
  await assert.rejects(A.readAuditPage(failing, 'inst-a', { after: null, limit: 25, batch: 5 }), /SYN db down/);
  const ascending = async (below, take) => rows.filter(r => below === null || r.id > below).slice(0, take);
  await assert.rejects(A.readAuditPage(ascending, 'inst-a', { after: null, limit: 25, batch: 5 }), /audit source order/);
  const repeated = async () => [rows[39], rows[39]];
  await assert.rejects(A.readAuditPage(repeated, 'inst-a', { after: null, limit: 25, batch: 5 }), /audit source order/);
  const noIds = async () => [{ ...rows[39], id: undefined }];
  await assert.rejects(A.readAuditPage(noIds, 'inst-a', { after: null, limit: 25, batch: 5 }), /audit source order/);
  const oversized = async () => rows.slice(0, 6);
  await assert.rejects(A.readAuditPage(oversized, 'inst-a', { after: null, limit: 25, batch: 5 }), /audit source answer/);
  const notArray = async () => null;
  await assert.rejects(A.readAuditPage(notArray, 'inst-a', { after: null, limit: 25, batch: 5 }), /audit source answer/);
});

// ── the continuation ──

test('the continuation is sealed: opaque, bound to the reader, expiring, and names no row id', () => {
  const key = randomBytes(32), owner = ['inst-a', '00000000-0000-4000-8000-0000000000aa'], now = Date.UTC(2026, 8, 26);
  const token = A.sealAuditCursor(key, owner, { top: 987654, after: 912345 }, now);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(token.length <= A.AUDIT_CURSOR_MAX);
  assert.equal(token.length, A.AUDIT_CURSOR_LENGTH);
  assert.deepEqual(A.openAuditCursor(key, owner, token, now + 1000), { top: 987654, after: 912345 });
  const bytes = Buffer.from(token, 'base64url').toString('latin1');
  for (const plainText of ['987654', '912345', '"after"', '"top"', 'inst-a']) assert.ok(!bytes.includes(plainText), plainText);
  assert.notEqual(A.sealAuditCursor(key, owner, { top: 987654, after: 912345 }, now), token, 'a fresh IV each time');
  const raw = Buffer.from(token, 'base64url');
  const flipped = Buffer.from(raw); flipped[raw.length - 1] ^= 1;
  // 53 bytes leave two unused bits in the last character: setting one decodes to the same bytes, but is not this value.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const loose = token.slice(0, -1) + ALPHABET[ALPHABET.indexOf(token.slice(-1)) | 1];
  const refused = {
    'another institution': A.openAuditCursor(key, ['inst-b', owner[1]], token, now),
    'another admin': A.openAuditCursor(key, [owner[0], '00000000-0000-4000-8000-0000000000bb'], token, now),
    'another key (restart)': A.openAuditCursor(randomBytes(32), owner, token, now),
    'expired': A.openAuditCursor(key, owner, token, now + A.AUDIT_CURSOR_TTL_MS),
    'tampered': A.openAuditCursor(key, owner, flipped.toString('base64url'), now),
    'truncated': A.openAuditCursor(key, owner, token.slice(0, 30), now),
    'non-canonical base64': A.openAuditCursor(key, owner, token + '=', now),
    'non-canonical last character': A.openAuditCursor(key, owner, loose, now),
    'a readable row id': A.openAuditCursor(key, owner, '912345', now),
    'too long': A.openAuditCursor(key, owner, 'A'.repeat(A.AUDIT_CURSOR_MAX + 1), now),
    'not a string': A.openAuditCursor(key, owner, 912345, now),
  };
  for (const [name, value] of Object.entries(refused)) assert.equal(value, null, name);
  const outOfRange = A.sealAuditCursor(key, owner, { top: 5, after: 6 }, now);
  assert.equal(A.openAuditCursor(key, owner, outOfRange, now), null, 'after beyond the pinned top');
});

test('B-F01: the continuation has one length: id digits, the supported maximum and the reader never change it', () => {
  const key = randomBytes(32), owner = ['inst-a', '00000000-0000-4000-8000-0000000000aa'], now = Date.UTC(2026, 8, 26);
  assert.equal(A.AUDIT_CURSOR_LENGTH, 71, '12 IV + 16 tag + 25 payload bytes, base64url without padding');
  const INT4 = 2147483647, MAX = Number.MAX_SAFE_INTEGER;   // AuditLog.id is int4; the layout carries any safe integer
  const pairs = [[1, 1], [9, 2], [9, 9], [10, 2], [10, 9], [10, 10], [99, 2], [100, 2], [100, 99], [999, 2], [1000, 2],
    [1000, 999], [INT4, 1], [INT4, INT4], [MAX, 1], [MAX, MAX]];
  const lengths = new Set(), sizes = new Set();
  for (const [top, after] of pairs) {
    const token = A.sealAuditCursor(key, owner, { top, after }, now);
    lengths.add(token.length);
    sizes.add(Buffer.from(token, 'base64url').length);
    assert.deepEqual(A.openAuditCursor(key, owner, token, now + 1), { top, after }, `${top}/${after}`);
  }
  assert.deepEqual([...lengths], [A.AUDIT_CURSOR_LENGTH]);
  assert.deepEqual([...sizes], [53]);
  // The expiry is fixed width too: the clock does not lengthen the value.
  for (const clock of [0, 9, now, MAX - A.AUDIT_CURSOR_TTL_MS])
    assert.equal(A.sealAuditCursor(key, owner, { top: 10, after: 2 }, clock).length, A.AUDIT_CURSOR_LENGTH, `clock ${clock}`);
  // The reader is bound as GCM additional data, not written into the payload: its length does not show either.
  for (const other of [['i', 's'], ['inst-' + 'x'.repeat(120), owner[1]], ['병원 \\ "%_', owner[1]]]) {
    const token = A.sealAuditCursor(key, other, { top: 1000, after: 2 }, now);
    assert.equal(token.length, A.AUDIT_CURSOR_LENGTH, JSON.stringify(other));
    assert.deepEqual(A.openAuditCursor(key, other, token, now), { top: 1000, after: 2 });
    assert.equal(A.openAuditCursor(key, owner, token, now), null, 'bound to its own reader');
  }
  // A value the layout cannot carry is refused when sealing, never truncated or wrapped.
  for (const bad of [{ top: -1, after: 1 }, { top: MAX + 1, after: 1 }, { top: 1.5, after: 1 }, { top: 10, after: NaN }])
    assert.throws(() => A.sealAuditCursor(key, owner, bad, now), RangeError, JSON.stringify(bad));
  assert.throws(() => A.sealAuditCursor(key, owner, { top: 10, after: 2 }, MAX), RangeError, 'an expiry beyond the safe range');
  // Only the fixed layout opens: under the right key and reader, another version, an unsafe value, another length or
  // the old JSON payload is refused.
  const forge = payload => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(owner), 'utf8'));
    const body = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  };
  const layout = Buffer.alloc(25);
  layout.writeUInt8(2, 0);
  layout.writeBigUInt64BE(10n, 1);
  layout.writeBigUInt64BE(2n, 9);
  layout.writeBigUInt64BE(BigInt(now + 1000), 17);
  assert.deepEqual(A.openAuditCursor(key, owner, forge(layout), now), { top: 10, after: 2 }, 'the forge builds the real layout');
  const version1 = Buffer.from(layout); version1[0] = 1;
  const unsafe = Buffer.from(layout); unsafe.writeBigUInt64BE(BigInt(MAX) + 1n, 1);
  const unsafeExpiry = Buffer.from(layout); unsafeExpiry.writeBigUInt64BE(BigInt(MAX) + 1n, 17);
  const zeroAfter = Buffer.from(layout); zeroAfter.writeBigUInt64BE(0n, 9);
  const forged = {
    'version 1': version1, 'top beyond the safe range': unsafe, 'expiry beyond the safe range': unsafeExpiry,
    'after 0': zeroAfter, 'one byte shorter': layout.subarray(0, 24), 'one byte longer': Buffer.concat([layout, Buffer.alloc(1)]),
    'the old JSON payload': Buffer.from(JSON.stringify({ v: 1, owner, top: 10, after: 2, expires: now + 1000 }), 'utf8'),
  };
  for (const [name, payload] of Object.entries(forged)) assert.equal(A.openAuditCursor(key, owner, forge(payload), now), null, name);
});

test('B-F01: hidden rows that move the pinned top across digit boundaries change no row, total, page end or length', async () => {
  const key = randomBytes(32), owner = ['inst-a', '00000000-0000-4000-8000-0000000000aa'], now = Date.UTC(2026, 8, 26);
  const visible = [1, 2, 3, 4, 5].map(id => row(id, 'study.arrived', `${S1}.${id}`, { institutionId: 'inst-a' }, 'system'));
  const seen = [];
  for (const top of [5, 9, 10, 99, 100, 999, 1000, 10000]) {
    // Everything above the reader's rows is hidden from it: another institution's rows and a hidden action naming it.
    const hiddenRows = [];
    for (let id = 6; id <= top; id++)
      hiddenRows.push(id % 2 ? row(id, 'state.patch', `${S2}.${id}`, { by: 'inst-b' })
        : row(id, 'report.draft', `${S2}.${id}`, { len: [1, 0, 0], by: 'inst-a' }));
    const rows = [...visible, ...hiddenRows];
    const pinned = Math.max(...rows.map(r => r.id));
    assert.equal(pinned, top);
    const first = await A.readAuditPage(sourceOver(rows), 'inst-a', { after: null, limit: 2 });
    const token = A.sealAuditCursor(key, owner, { top: pinned, after: first.last }, now);
    const cursor = A.openAuditCursor(key, owner, token, now);
    assert.deepEqual(cursor, { top: pinned, after: first.last });
    const second = await A.readAuditPage(sourceOver(rows.filter(r => r.id <= cursor.top)), 'inst-a', { after: cursor.after, limit: 2 });
    seen.push(JSON.stringify({ rows: first.rows, total: first.total, last: first.last, next: second.rows, length: token.length }));
  }
  assert.equal(new Set(seen).size, 1, 'the reader cannot tell how many hidden rows sit above its own');
  assert.equal(JSON.parse(seen[0]).length, A.AUDIT_CURSOR_LENGTH);
  assert.equal(JSON.parse(seen[0]).total, 5);
});

// ── the SQL prefilter (B-F02) ──

/** PostgreSQL LIKE with its default escape character \ (the removed Prisma `contains` passed the value unescaped). */
function likeMatches(text, pattern) {
  const literal = ch => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') source += literal(pattern[++i] ?? '');
    else if (ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else source += literal(ch);
  }
  return new RegExp('^' + source + '$', 'u').test(text);
}
const removedLikeCandidate = (source, reader) => A.AUDIT_CANDIDATE_ACTIONS.includes(source.action)
  && ((typeof source.detail === 'string' && likeMatches(source.detail, '%' + JSON.stringify(reader) + '%'))
    || (A.AUDIT_TARGET_ACTIONS.includes(source.action) && source.target === reader));

test('B-F02: the SQL prefilter is a literal substring: names with \\, ", % and _ lose no visible row and add none', async () => {
  const NAMES = ['inst-a', 'inst\\b', 'inst"q', 'inst%p', 'inst_u', 'a\\"%_\\\\z', '병원 A'];
  const OTHER = 'inst-z';
  const rows = [], expected = new Map([...NAMES, OTHER].map(name => [name, []]));
  let id = 0;
  const add = (readers, action, target, detail, actor) => {
    rows.push(row(++id, action, target, detail, actor));
    for (const reader of readers) expected.get(reader).push(id);
  };
  NAMES.forEach((name, n) => {
    const m = `syn-member-name-${n}`, uid = k => `${S3}.${n}.${k}`;
    add([name], 'admin.user.approve', m, { before: snap(m, null, 'PENDING'), after: snap(m, name, 'APPROVED'), verificationOverride: true });
    add([name, OTHER], 'admin.user.update', m, { before: snap(m, name, 'APPROVED'), after: snap(m, OTHER, 'APPROVED'),
      verificationOverride: true });
    add([name], 'study.access', m, { institution: name, subject: m, revision: 1, restricted: false, reason: 'SYN reason' });
    add([name], 'study.arrived', uid(1), { institutionId: name }, 'system');
    add([name], 'match', uid(1), { oid: 'O-SYN', ov: { name: 'SYN^PATIENT', id: 'SYN-P' }, by: name });
    add([name], 'reader.assignment', uid(1), { institution: name, revision: 1, from: null, to: 'syn-reader@members.test' });
    add([name], 'tech-note.revise', uid(1), { version: 1, institutionId: name });
    add([name], 'report.approve', uid(1), { version: 1, by: name, len: [1, 0, 0] });
    add([name], 'hanging-protocol.site.save', name, { revision: 1 });
    add([], 'report.draft', uid(1), { len: [1, 0, 0], by: name });                  // hidden action
    add([], 'study.arrived', uid(2), { institutionId: null, note: name }, 'system'); // unassigned: nobody
  });
  const all = { after: null, limit: 100 };
  const lost = {};
  for (const reader of [...NAMES, OTHER]) {
    const label = JSON.stringify(reader);
    const everything = await A.readAuditPage(sourceOver(rows), reader, all);
    // What each reader sees is exactly the rows written for it: nothing of another name, however its LIKE pattern reads.
    const shownIds = rows.filter(r => A.projectAuditRow(r, reader)).map(r => r.id);
    assert.deepEqual(shownIds, expected.get(reader), label);
    assert.equal(everything.total, reader === OTHER ? NAMES.length : 9, label);
    // No visible row misses the prefilter, and the prefiltered read is the whole read.
    for (const r of rows) if (A.projectAuditRow(r, reader)) assert.ok(A.auditCandidateRow(r, reader), `row ${r.id} for ${label}`);
    const prefiltered = await A.readAuditPage(sourceOver(rows.filter(r => A.auditCandidateRow(r, reader))), reader, all);
    assert.deepEqual(prefiltered, everything, `${label}: the prefilter changes nothing`);
    const removed = await A.readAuditPage(sourceOver(rows.filter(r => removedLikeCandidate(r, reader))), reader, all);
    lost[reader] = everything.total - removed.total;
  }
  // Negative control: the removed LIKE form loses every detail-attributed row of a name with \ or " (only the target
  // row survives), and none for %, _ or plain names — the defect this test would catch if the LIKE came back.
  assert.deepEqual(lost, { 'inst-a': 0, 'inst\\b': 8, 'inst"q': 8, 'inst%p': 0, 'inst_u': 0, 'a\\"%_\\\\z': 8, '병원 A': 0,
    'inst-z': 0 });
  // The mention is the JSON text the writers leave in detail.
  for (const name of NAMES) assert.equal(A.auditMention(name), JSON.stringify(name));
  // The service's SQL is the model above: strpos over the same mention, the same candidate and target lists, no LIKE.
  const service = readFileSync(path.join(ROOT, 'api', 'src', 'admin.service.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = service.indexOf('\n  async auditEvents(');
  assert.ok(start > 0, 'auditEvents is found');
  const method = service.slice(start, service.indexOf('\n  }\n', start));
  const sql = /\$queryRaw<AuditLogRow\[\]>`([^`]*)`/.exec(method);
  assert.ok(sql, 'the audit read is one raw query');
  assert.match(method, /const mention = auditMention\(me\);/);
  assert.match(method, /const candidates = Prisma\.join\(\[\.\.\.AUDIT_CANDIDATE_ACTIONS\]\), targets = Prisma\.join\(\[\.\.\.AUDIT_TARGET_ACTIONS\]\);/);
  assert.match(sql[1], /"action" IN \(\$\{candidates\}\)/);
  assert.match(sql[1], /AND \(strpos\("detail", \$\{mention\}\) > 0 OR \("action" IN \(\$\{targets\}\) AND "target" = \$\{me\}\)\)/);
  assert.match(sql[1], /ORDER BY "id" DESC LIMIT \$\{take\}/);
  assert.doesNotMatch(sql[1], /\b(I?LIKE|SIMILAR)\b/i);
  assert.doesNotMatch(method, /\bcontains\s*:/);
});

test('the query takes limit (1-100, default 25) and the sealed after only', () => {
  assert.deepEqual(A.auditPageQuery(undefined), { limit: 25, after: null });
  assert.deepEqual(A.auditPageQuery({}), { limit: 25, after: null });
  assert.deepEqual(A.auditPageQuery({ limit: '100', after: 'SYN-TOKEN' }), { limit: 100, after: 'SYN-TOKEN' });
  assert.deepEqual(A.auditPageQuery({ limit: '1' }), { limit: 1, after: null });
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '01' }, { limit: '2.5' }, { limit: ['2', '3'] }, { limit: 5 },
    { after: '' }, { after: ['a', 'b'] }, { after: { x: '1' } }, { after: 'A'.repeat(A.AUDIT_CURSOR_MAX + 1) },
    { take: '5' }, { limit: '5', institution: 'inst-b' }, 'limit=5', []])
    assert.equal(A.auditPageQuery(query), null, JSON.stringify(query));
});

// ── completeness over api/src ──
//
// What this proves and how is fixed by Astra S7-U3a-AUDIT-SPEC-R-001 (F01-F04). Statically, over the audit writes of
// api/src, both directions of the action table as correspondence in the source: every action a write can record has a
// contract row, and every exact contract row (every hidden wildcard: a value or prefix under it) has a write in the source
// that records it. The source is not an execution: how many rows a write leaves, whose they are and what a failure undoes
// are held on the compiled services (tests/reader_assignment_scope_test.cjs, Astra S7-U3a-B-R-001-F01).
//
// The input is the direct audit writes of api/src — the Prisma `auditLog` delegate and raw SQL — and the helpers their
// values pass through; not arbitrary JavaScript equivalence, not database triggers or functions. The files of api/src are
// listed from the disk and compared with the program the compiler reads (api/package-lock.json's typescript with
// api/tsconfig.json's options; without it these cases fail and never skip, AGENTS 1-B.15). Every candidate ends
// `resolved`, `proven_non_audit` (with its reason) or `unresolved`, and one unresolved candidate fails. The contract table
// is used in the verdict only, never to find a candidate or to read a value. Nothing depends on the generated Prisma
// client's types (CI installs with --ignore-scripts and generates none).
//
//  F01 candidates: every member access, destructured property or computed key whose name the program fixes as `auditLog`
//    (a dot, a literal or a constant key): the delegate must be the receiver of a called method — a read method is not a
//    write, `create` is read below, any other method (createMany, upsert, update, delete ...) is unresolved, and so is the
//    delegate kept, passed, returned or destructured; a member read by a key the program does not fix from a value a
//    Prisma client may reach (the client flow; from any other value it is proven_non_audit); every raw call ($executeRaw,
//    $queryRaw, their Unsafe forms) and every text of the program that names AuditLog other than as one bare name (a
//    member key such as 'auditLog' is the delegate's; SQL reaches the table only through its quoted identifier).
//    The client flow: a class extending @prisma/client's PrismaClient, a binding annotated with such a class or with
//    Prisma's TransactionClient, and the first parameter of a callback handed to `$transaction` hold a client, and so does
//    every binding, parameter (by every call the program makes) and function result a client value reaches (a fixed
//    point). A client value anywhere else — spread, kept in an object or an untyped member, handed to a library or to a
//    callee the program does not fix, returned from a function that is handed on — is unresolved.
//  F02 values, a finite list; anything else is unresolved, and so is any mix of a value with an unresolved one:
//    (a) blanks, comments, line breaks and trailing commas; parentheses, as, satisfies, ! and <T> around a value;
//    (b) a member by a dot or by a key that is one string (element access, computed property name): one key reader for the
//        delegate, its method, `data` and `action`; the last definition of a property wins, and a later spread or computed
//        key that may set it again leaves it unresolved;
//    (c) string literals and templates, `+` and templates of fixed pieces;
//    (d) const bindings, through renames, imports, re-exports and namespaces;
//    (e) a property of a const `as const` literal that no use changes, hands on or reads by an unfixed key, an explicit
//        string enum member and an initialized readonly field, neither written through any receiver (a type is no proof);
//    (f) both sides of ?:, ||, ?? and &&;
//    (g) a let, var or parameter with every value assigned to it;
//    (h) a parameter of a private or local undecorated function: the argument of every call the program makes of it,
//        followed through variables, arguments and callbacks — no call at all, or the function handed on, is unresolved;
//    (i) what a preceding `if (... || !['a', ...].includes(x) || ...) throw/return` of an enclosing statement list lets
//        through to a binding nothing changes.
//    A fixed start followed by a value the program does not fix is a dynamic suffix; a hidden wildcard row must cover it.
//  F03 raw SQL, one form only: `INSERT INTO [schema.]"AuditLog" (columns) VALUES (values) [;]`, read by position under
//    PostgreSQL's lexical rules (strings, quoted identifiers and their case, comments, parentheses, interpolations). The
//    value at the one `action` column is an SQL string or one interpolation read by F02; other columns and comments do not
//    count. Every interpolation must be a value (a string the program fixes, or of a primitive or Date type), never an SQL
//    fragment. A missing, doubled or miscounted column list, an unclosed token, an interpolation where SQL structure goes,
//    and every other statement that names AuditLog (INSERT … SELECT, WITH, several statements, ON CONFLICT, RETURNING,
//    UPDATE, DELETE ...) is unresolved — but one SELECT that changes no row only reads. The SQL must be the fixed text of
//    its raw call: a text naming AuditLog anywhere else, and SQL the program does not fix (an Unsafe call with a computed
//    text, Prisma.raw of a computed text, a computed join separator), is unresolved.

const API = path.join(ROOT, 'api');
const slash = file => path.resolve(file).split(path.sep).join('/');
const repoPath = file => path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
let compiler = null;

/** api/package-lock.json's typescript, api/tsconfig.json's options and the api/src files they name. */
function typescript() {
  if (compiler) return compiler;
  let where;
  try {
    where = require.resolve('typescript', { paths: [API] });
  } catch (error) {
    throw new Error(`typescript is not installed under api/ (npm ci --prefix api --ignore-scripts): ${error.message}`);
  }
  const ts = require(where);
  const config = ts.readConfigFile(path.join(API, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, API);
  const options = { ...parsed.options, noEmit: true, incremental: false, sourceMap: false };
  delete options.outDir;
  delete options.tsBuildInfoFile;
  const src = slash(path.join(API, 'src')) + '/';
  const named = parsed.fileNames.map(slash).filter(file => file.startsWith(src)).map(repoPath).sort();
  assert.ok(named.length > 0, 'api/tsconfig.json includes the files of api/src');
  compiler = { ts, options, src, named, base: ts.createCompilerHost(options, true), lookups: new Map(), external: new Map(),
    internal: new Map(), previous: undefined, product: null };
  return compiler;
}

/** Every entry under `dir` as found on the disk (anything that is neither a file nor a directory is named as such). */
function onDisk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const at = path.join(dir, entry.name);
    return entry.isDirectory() ? onDisk(at) : [entry.isFile() ? repoPath(at) : `${repoPath(at)} (not a file)`];
  });
}
const SCRIPT = /\.[cm]?[jt]sx?$/;   // what a compiler could be handed: TypeScript and JavaScript sources, declarations too
/** The script files on the disk against the files the program reads: one it does not read is `unread`. */
function sourceListing(disk, named) {
  const scripts = disk.filter(file => SCRIPT.test(file) || file.endsWith(' (not a file)')).sort();
  return { disk: scripts.length, program: named.length, unread: scripts.filter(file => !named.includes(file)),
    extra: named.filter(file => !scripts.includes(file)) };
}
/** api/src as checked out: the listing (disk against program) and the sources the program reads. */
function productSources() {
  const c = typescript();
  c.product ??= { listing: sourceListing(onDisk(path.join(API, 'src')), c.named),
    sources: c.named.map(file => ({ file, text: readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n') })) };
  return c.product;
}
const auditSources = () => productSources().sources;

/** The program of `sources` (files under api/src; lib and node_modules from disk), reusing what earlier calls parsed. */
function auditProgram(sources) {
  const c = typescript(), { ts, src, base } = c;
  const texts = new Map(sources.map(source => [slash(path.join(ROOT, source.file)), source.text]));
  const inside = file => slash(file).startsWith(src);
  // Outside api/src nothing changes during a run: each lookup of lib and node_modules is asked of the disk once.
  const once = (name, ask) => key => {
    const cache = c.lookups.get(name) ?? new Map();
    c.lookups.set(name, cache);
    if (!cache.has(key)) cache.set(key, ask(key));
    return cache.get(key);
  };
  const exists = once('fileExists', file => base.fileExists(file)), read = once('readFile', file => base.readFile(file));
  const directory = once('directoryExists', dir => !base.directoryExists || base.directoryExists(dir));
  const host = {
    ...base,
    fileExists: file => (inside(file) ? texts.has(slash(file)) : exists(file)),
    readFile: file => (inside(file) ? texts.get(slash(file)) : read(file)),
    directoryExists: dir => (inside(slash(dir) + '/') ? [...texts.keys()].some(file => file.startsWith(slash(dir) + '/')) : directory(dir)),
    realpath: base.realpath && once('realpath', file => base.realpath(file)),
    getDirectories: base.getDirectories && once('getDirectories', dir => base.getDirectories(dir)),
    getSourceFile(file, version, onError, create) {
      const at = slash(file);
      if (!inside(at)) {
        if (!c.external.has(at)) c.external.set(at, base.getSourceFile(file, version, onError, create));
        return c.external.get(at);
      }
      const text = texts.get(at);
      if (text === undefined) return undefined;
      if (!c.internal.has(at)) c.internal.set(at, new Map());
      const parsed = c.internal.get(at);
      if (!parsed.has(text)) parsed.set(text, ts.createSourceFile(file, text, version, true));
      return parsed.get(text);
    },
  };
  c.previous = ts.createProgram({ rootNames: [...texts.keys()], options: c.options, host, oldProgram: c.previous });
  return c.previous;
}

/**
 * The audit candidates of `sources` (default: api/src as checked out). `sites` are the resolved writes with the actions
 * and dynamic prefixes each can record and the basis of each; `candidates` is every candidate with its status and reason;
 * `unresolved` the unresolved ones. A site and a candidate also carry (not enumerable) their offset, and a create site its
 * call, its action property and the literals its actions come from, for the controls that rewrite them.
 */
function scanAuditWrites(sources = auditSources()) {
  const { ts } = typescript();
  const K = ts.SyntaxKind, TF = ts.TypeFlags;
  const program = auditProgram(sources), checker = program.getTypeChecker();
  const files = [], sites = [], candidates = [];

  const WRAPPERS = new Set([K.ParenthesizedExpression, K.AsExpression, K.SatisfiesExpression, K.NonNullExpression, K.TypeAssertionExpression]);
  const CHOICES = new Set([K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken]);
  const EQUALITIES = new Set([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken,
    K.InstanceOfKeyword, K.InKeyword]);
  const bare = node => { while (node && WRAPPERS.has(node.kind)) node = node.expression; return node; };
  const outer = node => { while (node.parent && WRAPPERS.has(node.parent.kind)) node = node.parent; return node; };
  const position = node => {
    const file = node.getSourceFile();
    return { file: repoPath(file.fileName), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 };
  };
  const where = node => { const at = position(node); return `${at.file}:${at.line}`; };
  const snippet = node => node.getText().replace(/\s+/g, ' ').slice(0, 60);
  const resolve = symbol => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  /** The symbol a name stands for as a value (a shorthand property's name stands for the variable it reads). */
  const symbolAt = node => resolve(ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node));
  const isAccess = node => !!node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node));
  /** The access a member name belongs to (`this.x` for its `x`, `this['x']` for its literal 'x'), else null. */
  const accessOf = node => {
    const parent = node.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return parent;
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
    const held = outer(node);
    return held.parent && ts.isElementAccessExpression(held.parent) && held.parent.argumentExpression === held ? held.parent : null;
  };
  /** A candidate: where, what, its status and why. */
  function note(node, kind, status, reason) {
    const entry = { ...position(node), kind, status, reason };
    Object.defineProperty(entry, 'start', { value: node.getStart() });
    candidates.push(entry);
    return entry;
  }

  // ── values: the finite list (a)-(i) ──
  const text = (value, from = []) => ({ key: 't' + value, text: value, from });
  const prefix = (value, why) => ({ key: 'p' + value, prefix: value, why });
  const unknown = why => ({ key: 'u' + why, unknown: why });
  const fn = node => ({ key: `f${where(node)}@${node.pos}`, fn: node });
  function union(...lists) {
    const out = new Map();
    for (const value of lists.flat()) {
      const known = out.get(value.key);
      out.set(value.key, known && value.from ? { ...known, from: [...new Set([...known.from, ...value.from])] } : known ?? value);
    }
    return [...out.values()];
  }
  /** Every value a text, or null: the one form a key and an SQL action slot take. */
  const texts = found => (found.length > 0 && found.every(value => value.text !== undefined) ? [...new Set(found.map(value => value.text))] : null);
  /** `left + right`: a text start with a value the program does not fix after it is a dynamic suffix. */
  const concat = (left, right) => union(left.flatMap(l => right.map(r => {
    if (l.text === undefined) return l.prefix !== undefined ? l : unknown(l.unknown ?? `${where(l.fn)}: a function used as text`);
    if (r.text !== undefined) return text(l.text + r.text);
    if (r.prefix !== undefined) return prefix(l.text + r.prefix, r.why);
    return prefix(l.text, r.unknown ?? `${where(r.fn)}: a function used as text`);
  })));

  const memo = new Map(), active = new Set();
  function values(expression) {
    const node = bare(expression);
    if (memo.has(node)) return memo.get(node);
    if (active.has(node)) return [unknown(`${where(node)}: \`${snippet(node)}\` depends on itself`)];
    active.add(node);
    try {
      const found = union(evaluate(node));
      memo.set(node, found);
      return found;
    } finally {
      active.delete(node);
    }
  }
  function evaluate(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [text(node.text, [node])];
    if (ts.isTemplateExpression(node))
      return node.templateSpans.reduce((sum, span) => concat(concat(sum, values(span.expression)), [text(span.literal.text)]),
        [text(node.head.text)]);
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === K.PlusToken) return concat(values(node.left), values(node.right));
      if (CHOICES.has(operator)) return union(values(node.left), values(node.right));
      if (operator === K.CommaToken) return values(node.right);
    }
    if (ts.isConditionalExpression(node)) return union(values(node.whenTrue), values(node.whenFalse));
    // Nothing, which no call can run: unresolved as a text, left out of a callee's functions.
    if (node.kind === K.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined' && !symbolAt(node)?.declarations?.length)) {
      return [{ ...unknown(`${where(node)}: \`${node.getText()}\` is no value`), none: true }];
    }
    if (ts.isIdentifier(node)) return named(symbolAt(node), node);
    if (isAccess(node)) return member(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [fn(node)];
    return [unknown(`${where(node)}: \`${snippet(node)}\` is a ${K[node.kind]}`)];
  }

  /** (b) The names an access, an object literal member or a binding element's property takes; null when not fixed. */
  function keyValues(node) {
    if (ts.isPropertyAccessExpression(node)) return [node.name.text];
    const expression = ts.isElementAccessExpression(node) ? bare(node.argumentExpression)
      : ts.isComputedPropertyName(node) ? bare(node.expression) : null;
    const name = expression ?? node;
    if (ts.isNumericLiteral(name)) return [String(Number(name.text))];
    if (expression) return texts(values(expression));
    return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
      ? [name.text] : null;
  }
  /** (b, d, e) `a.b` or `a[k]`: for each key the program fixes, the member the checker binds on the type of `a`. */
  function member(node) {
    const keys = keyValues(node);
    if (!keys) return [unknown(`${where(node)}: \`${snippet(node)}\` has a key the program does not fix`)];
    const type = checker.getTypeAtLocation(node.expression);
    return union(...keys.map(key => {
      const property = checker.getPropertyOfType(type, key);
      return property ? named(resolve(property), node) : [unknown(`${where(node)}: \`${snippet(node)}\` is a property the program does not fix`)];
    }));
  }

  /** The values of what `symbol` is bound to, read at `use`. */
  function named(symbol, use) {
    const name = ts.isIdentifier(use) ? use.text : snippet(use);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length !== 1) {
      return [unknown(`${where(use)}: \`${name}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}`)];
    }
    const [declaration] = declarations;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
      // A declaration without a body (a library's) is code this program does not have: what it does with a value is unknown.
      return declaration.body ? [fn(declaration)] : [unknown(`${where(use)}: \`${name}\` has no body in this program`)];
    }
    if (ts.isEnumMember(declaration)) {
      if (!declaration.initializer) return [unknown(`${where(use)}: \`${name}\` is a numbered enum member`)];
      const changed = memberChanged(symbol);
      return changed ? [unknown(`${where(use)}: \`${name}\` is written at ${changed}`)] : values(declaration.initializer);
    }
    if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
      const table = frozen(declaration.parent);
      if (!table) return [unknown(`${where(use)}: \`${name}\` is a property of an object that is not \`as const\``)];
      const keys = keyValues(declaration.name);
      if (keys?.length !== 1 || property(declaration.parent, keys[0]).member !== declaration) {
        return [unknown(`${where(use)}: \`${name}\` is set again later in its object`)];
      }
      const escape = tableEscapes(table);
      if (escape) return [unknown(`${where(use)}: \`${name}\` is a property of \`${table.name.text}\`, which ${escape}`)];
      return ts.isPropertyAssignment(declaration) ? values(declaration.initializer) : named(symbolAt(declaration.name), declaration.name);
    }
    let found;
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      found = declaration.initializer ? values(declaration.initializer)
        : [unknown(`${where(declaration)}: \`${name}\` is declared without a value`)];
    } else if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent)) {
      found = passed(declaration);
    } else if (ts.isPropertyDeclaration(declaration) && declaration.initializer
      && ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) {
      const changed = memberChanged(symbol);
      if (changed) return [unknown(`${where(use)}: \`${name}\` is written at ${changed}`)];
      found = values(declaration.initializer);
    } else {
      return [unknown(`${where(use)}: \`${name}\` is a ${K[declaration.kind]}`)];
    }
    const constant = ts.isVariableDeclaration(declaration) && ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const;
    const changes = constant ? [] : assignments(symbol);
    if (changes.length) return union(found, changes);
    // A binding nothing changes keeps its value, and a preceding exit for every other value limits it here.
    const limit = found.some(value => value.text === undefined) ? limited(use, symbol) : null;
    return limit ? limit.members.filter(member => found.some(value => value.text === undefined || value.text === member))
      .map(member => ({ ...text(member), guard: where(limit.at) })) : found;
  }

  /** The const declaration whose initializer is the outermost `as const` literal holding `object`, else null. */
  function frozen(object) {
    let node = object, constant = false;
    for (;;) {
      const parent = node.parent;
      if (ts.isAsExpression(parent) && ts.isConstTypeReference(parent.type)) constant = true;
      if (WRAPPERS.has(parent.kind)) { node = parent; continue; }
      if (ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isObjectLiteralExpression(parent.parent)) {
        node = parent.parent;
        constant = false;
        continue;
      }
      return constant && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)
        && ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const ? parent : null;
    }
  }
  /** Whether `node` is written: an assignment's target, ++ or --, delete, a for-in/of target, a destructuring target. */
  function mutated(node) {
    const parent = node.parent;
    return (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= K.FirstAssignment
        && parent.operatorToken.kind <= K.LastAssignment)
      || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
        && (parent.operator === K.PlusPlusToken || parent.operator === K.MinusMinusToken))
      || ts.isDeleteExpression(parent) || ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node)
      || destructured(node);
  }
  /** A use that neither changes nor hands on a value: tested, compared, typeof, void, a statement of its own. */
  const inert = node => {
    const parent = node.parent;
    return ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isExpressionStatement(parent)
      || (ts.isForStatement(parent) && parent.condition === node) || (ts.isConditionalExpression(parent) && parent.condition === node)
      || (ts.isPrefixUnaryExpression(parent) && parent.operator === K.ExclamationToken) || ts.isTypeOfExpression(parent)
      || ts.isVoidExpression(parent) || (ts.isBinaryExpression(parent) && EQUALITIES.has(parent.operatorToken.kind));
  };
  /** (e) Why the table a const `as const` declaration holds may not keep its literal values, or null: every use must read
   *  a value out of it through keys the program fixes, and never write it or hand the table or a part of it on. */
  function tableEscapes(declaration) {
    for (const reference of references(symbolAt(declaration.name))) {
      if (ts.isTypeQueryNode(reference.parent)) continue;
      let node = reference, object = bare(declaration.initializer);
      for (;;) {
        const parent = node.parent;
        if (WRAPPERS.has(parent.kind)) { node = parent; continue; }
        if (!isAccess(parent) || parent.expression !== node) break;
        if (object) {
          const keys = keyValues(parent);
          if (!keys) return `is read by a key the program does not fix at ${where(parent)}`;
          const inner = keys.map(key => {
            const index = /^\d+$/.test(key) ? Number(key) : -1;
            if (ts.isArrayLiteralExpression(object) && (index < 0 || object.elements.slice(0, index + 1).some(ts.isSpreadElement))) return undefined;
            const next = ts.isArrayLiteralExpression(object) ? object.elements[index] : property(object, key).node;
            return next ? bare(next) : null;
          });
          if (inner.includes(undefined)) return `is used through \`${keys.join(' | ')}\` at ${where(parent)}`;
          const nested = inner.filter(next => next && (ts.isObjectLiteralExpression(next) || ts.isArrayLiteralExpression(next)));
          if (nested.length && keys.length > 1) return `is read into nested objects by several keys at ${where(parent)}`;
          object = nested[0] ?? null;
        }
        node = parent;
      }
      if (mutated(node)) return `is written at ${where(node.parent)}`;
      if (object && !inert(node)) return `is handed on at ${where(node.parent)}`;
    }
    return null;
  }
  /** Where a member named like `symbol` is written through a receiver that is it or that the checker does not type. */
  function memberChanged(symbol) {
    for (const node of spelled().names.get(symbol.name) ?? []) {
      const access = accessOf(node);
      if (!access) continue;
      const found = symbolAt(node);
      if (found && !same(found, symbol)) continue;
      if (mutated(outer(access))) return where(access);
    }
    return null;
  }

  // ── control flow: a guard `if (... || !['a', 'b'].includes(x) || ...) throw/return;` before the use ──
  const jumps = node => ts.isBreakOrContinueStatement(node) || !!ts.forEachChild(node, child => jumps(child) || undefined);
  const exits = statement => ts.isThrowStatement(statement) || ts.isReturnStatement(statement)
    || (ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements[statement.statements.length - 1])
      && !jumps(statement));
  function guarded(statement, symbol) {
    if (!ts.isIfStatement(statement) || statement.elseStatement || !exits(statement.thenStatement)) return null;
    const alternatives = [];
    const split = node => {
      node = bare(node);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.BarBarToken) { split(node.left); split(node.right); }
      else alternatives.push(node);
    };
    split(statement.expression);
    for (const alternative of alternatives) {
      if (!ts.isPrefixUnaryExpression(alternative) || alternative.operator !== K.ExclamationToken) continue;
      const call = bare(alternative.operand), callee = ts.isCallExpression(call) ? bare(call.expression) : null;
      if (!isAccess(callee) || call.arguments.length !== 1 || keyValues(callee)?.join() !== 'includes') continue;
      const tested = bare(call.arguments[0]), list = bare(callee.expression);
      if (!ts.isIdentifier(tested) || symbolAt(tested) !== symbol || !ts.isArrayLiteralExpression(list)) continue;
      const members = list.elements.map(element => (ts.isSpreadElement(element) ? [unknown('spread')] : values(element)));
      if (members.every(found => found.every(value => value.text !== undefined))) return { members: members.flat().map(value => value.text), at: statement };
    }
    return null;
  }
  /** The values a guard of an enclosing statement list lets through to `use`; a hoisted function skips its own list. */
  function limited(use, symbol) {
    let hoisted = false;
    for (let node = use; node.parent; node = node.parent) {
      if (ts.isFunctionDeclaration(node)) hoisted = true;
      const parent = node.parent;
      const list = ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent) || ts.isCaseOrDefaultClause(parent)
        ? parent.statements : null;
      if (!list) continue;
      if (!hoisted) {
        for (let i = list.indexOf(node) - 1; i >= 0; i--) {
          const members = guarded(list[i], symbol);
          if (members) return members;
        }
      }
      hoisted = false;
    }
    return null;
  }

  // ── references, assignments and calls ──
  let spellings = null;
  /** Every identifier and member key of the program's sources by spelling, and the local names of renamed imports and exports. */
  function spelled() {
    if (spellings) return spellings;
    const index = spellings = { names: new Map(), renamed: new Map() };
    const add = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
    const walk = node => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) add(index.names, node.text, node);
      else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && accessOf(node)) add(index.names, node.text, node);
      if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.propertyName) add(index.renamed, node.propertyName.text, node.name.text);
      ts.forEachChild(node, walk);
    };
    files.forEach(walk);
    return index;
  }
  const same = (found, symbol) => found === symbol || !!found?.declarations?.some(declaration => symbol.declarations?.includes(declaration));
  /** The uses of `symbol` in the program's sources (a parameter's or a function-local's in its own file), declarations left out. */
  function references(symbol) {
    if (!symbol) return [];
    const { names, renamed } = spelled();
    const [first] = symbol.declarations ?? [];
    const own = new Set((symbol.declarations ?? []).map(declaration => declaration.name));
    const statement = first && ts.isVariableDeclaration(first) ? first.parent?.parent : null;
    const local = first && (ts.isParameter(first) || (statement && !ts.isSourceFile(statement.parent) && !ts.isModuleBlock(statement.parent)))
      ? first.getSourceFile() : null;
    return [...new Set([symbol.name, ...(renamed.get(symbol.name) ?? [])])].flatMap(name => names.get(name) ?? [])
      .filter(node => !own.has(node) && (!local || node.getSourceFile() === local) && same(symbolAt(node), symbol));
  }
  /** A name on the left of a destructuring assignment. */
  function destructured(node) {
    let at = node;
    while (ts.isArrayLiteralExpression(at.parent) || ts.isObjectLiteralExpression(at.parent) || ts.isSpreadElement(at.parent)
      || ts.isSpreadAssignment(at.parent) || (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at)
      || ts.isShorthandPropertyAssignment(at.parent)) at = at.parent;
    return at !== node && ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === K.EqualsToken && at.parent.left === at;
  }
  /** (g) The values assigned to a binding after its declaration; a change that is not a plain assignment is unresolved. */
  function assignments(symbol) {
    const found = [];
    for (const reference of references(symbol)) {
      const node = outer(accessOf(reference) ?? reference), parent = node.parent;
      const operator = ts.isBinaryExpression(parent) && parent.left === node ? parent.operatorToken.kind : null;
      if (operator === K.EqualsToken) found.push(...values(parent.right));
      else if ((operator !== null && operator >= K.FirstCompoundAssignment && operator <= K.LastCompoundAssignment)
        || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && (parent.operator === K.PlusPlusToken || parent.operator === K.MinusMinusToken))
        || ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node) || destructured(node)) {
        found.push(unknown(`${where(parent)}: \`${symbol.name}\` is changed by \`${snippet(parent)}\``));
      }
    }
    return found;
  }

  const describe = owner => (owner.name ? `\`${owner.name.getText()}\` (${where(owner)})` : `the function at ${where(owner)}`);
  const decorated = node => ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
  /** A function callers outside this program can reach: Nest calls public class members and whatever a decorator names. */
  const open = owner => decorated(owner) || owner.parameters.some(decorated)
    || ((ts.isMethodDeclaration(owner) || ts.isConstructorDeclaration(owner) || ts.isGetAccessorDeclaration(owner)
      || ts.isSetAccessorDeclaration(owner)) && !(ts.getCombinedModifierFlags(owner) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected))
      && !(owner.name && ts.isPrivateIdentifier(owner.name)));
  const shift = owner => (owner.parameters[0]?.name.getText() === 'this' ? 1 : 0);
  /** (h) The arguments every call of the parameter's function passes for it. */
  function passed(parameter) {
    const owner = parameter.parent, name = parameter.name.getText();
    const index = owner.parameters.indexOf(parameter) - shift(owner);
    if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) {
      return [unknown(`${where(parameter)}: \`${name}\` is a rest or destructured parameter`)];
    }
    if (!owner.body || open(owner)) {
      return [unknown(`${where(parameter)}: \`${name}\` is a parameter of ${describe(owner)}, which callers outside this program can call`)];
    }
    const { calls, escapes } = invocations(owner);
    if (escapes.length) {
      return [unknown(`${where(parameter)}: \`${name}\` is a parameter of ${describe(owner)}, which is handed on at ${escapes.join(', ')}`)];
    }
    if (!calls.length) return [unknown(`${where(parameter)}: \`${name}\` is a parameter of ${describe(owner)}, which nothing in the program calls`)];
    return union(...calls.map(call => {
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return [unknown(`${where(call)}: a spread argument`)];
      const argument = call.arguments[index];
      return argument ? values(argument) : parameter.initializer ? values(parameter.initializer)
        : [unknown(`${where(call)}: no argument for \`${name}\``)];
    }));
  }

  const invoked = new Map();
  /** Every call of a function, following it through variables, arguments and parameters; anywhere else is an escape. */
  function invocations(owner) {
    if (invoked.has(owner)) {
      return invoked.get(owner) ?? { calls: [], escapes: [`${where(owner)} (reached again while its calls are being found)`] };
    }
    invoked.set(owner, null);
    const calls = [], escapes = [], seen = new Set(), queue = carriers(owner, escapes);
    while (queue.length) {
      const node = queue.shift();
      if (!seen.has(node)) { seen.add(node); follow(node, calls, escapes, queue); }
    }
    const result = { calls: [...new Set(calls)], escapes };
    invoked.set(owner, result);
    return result;
  }
  function carriers(owner, escapes) {
    if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
      return [owner, ...(ts.isFunctionExpression(owner) && owner.name ? references(symbolAt(owner.name)) : [])];
    }
    const symbol = owner.name ? symbolAt(owner.name) : null;
    if (!symbol) { escapes.push(`${where(owner)} (no name to follow)`); return []; }
    // A method is also reached as a member of a value the checker cannot type (`any`): such a member of its name could be it.
    for (const node of ts.isMethodDeclaration(owner) ? spelled().names.get(symbol.name) ?? [] : []) {
      if (accessOf(node) && !symbolAt(node)) escapes.push(`${where(node)} (\`${symbol.name}\` of a value the program does not type)`);
    }
    return references(symbol).map(node => accessOf(node) ?? node);
  }
  function follow(start, calls, escapes, queue) {
    let node = start;
    for (;;) {   // the expressions that hand the same value on
      const parent = node.parent;
      if (WRAPPERS.has(parent.kind) || (ts.isConditionalExpression(parent) && parent.condition !== node)
        || (ts.isBinaryExpression(parent) && (CHOICES.has(parent.operatorToken.kind)
          || (parent.operatorToken.kind === K.CommaToken && parent.right === node)))) node = parent;
      else break;
    }
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) { calls.push(parent); return; }
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
      const index = parent.arguments.indexOf(node);
      if (parent.arguments.slice(0, index).some(ts.isSpreadElement)) { escapes.push(`${where(parent)} (after a spread argument)`); return; }
      for (const callee of values(parent.expression)) {
        const parameter = callee.fn?.parameters?.[index + shift(callee.fn)];
        if (!callee.fn) escapes.push(`${where(parent)} (handed to \`${snippet(parent.expression)}\`)`);
        else if (parameter && (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))) {
          escapes.push(`${where(parameter)} (a rest or destructured parameter)`);
        } else if (parameter) queue.push(...references(symbolAt(parameter.name)));
      }
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      queue.push(...references(symbolAt(parent.name)));
      return;
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === K.EqualsToken && parent.right === node && ts.isIdentifier(bare(parent.left))) {
      queue.push(...references(symbolAt(bare(parent.left))));
      return;
    }
    const tested = inert(node) || ts.isTypeQueryNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
      || ts.isImportClause(parent);
    if (!tested) escapes.push(`${where(parent)} (${K[parent.kind]})`);
  }

  // ── the client: which values may hold a Prisma client ──
  const PRISMA = '@prisma/client';
  /** The name `identifier` is imported under from @prisma/client ('*' for a namespace, 'default'), else null. */
  function prismaImport(identifier) {
    const symbol = identifier && ts.isIdentifier(identifier) ? checker.getSymbolAtLocation(identifier) : null;
    for (const declaration of symbol?.declarations ?? []) {
      const clause = ts.isImportSpecifier(declaration) ? declaration.parent.parent.parent
        : ts.isNamespaceImport(declaration) ? declaration.parent.parent : ts.isImportClause(declaration) ? declaration.parent : null;
      if (clause && ts.isImportDeclaration(clause) && ts.isStringLiteral(clause.moduleSpecifier) && clause.moduleSpecifier.text === PRISMA) {
        return ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text
          : ts.isNamespaceImport(declaration) ? '*' : 'default';
      }
    }
    return null;
  }
  /** A member of the Prisma namespace import (`Prisma.sql`, `Prisma.raw` ...): its name, else null. */
  const prismaMember = node => {
    const at = bare(node);
    return isAccess(at) && ts.isIdentifier(bare(at.expression)) && prismaImport(bare(at.expression)) !== null
      && keyValues(at)?.length === 1 ? keyValues(at)[0] : null;
  };
  const clientClasses = new Map();
  /** A class that extends @prisma/client's PrismaClient, or such a class of the program. */
  function clientClass(declaration) {
    if (!declaration || !ts.isClassLike(declaration)) return false;
    if (clientClasses.has(declaration)) return clientClasses.get(declaration);
    clientClasses.set(declaration, false);
    const heritage = declaration.heritageClauses?.find(clause => clause.token === K.ExtendsKeyword)?.types[0];
    const base = heritage && bare(heritage.expression);
    const found = !!base && ((ts.isIdentifier(base) && prismaImport(base) === 'PrismaClient') || prismaMember(base) === 'PrismaClient'
      || clientClass(resolve(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(base) ? base.name : base))?.declarations?.[0]));
    clientClasses.set(declaration, found);
    return found;
  }
  const classOf = node => resolve(node && checker.getSymbolAtLocation(node))?.declarations?.[0];
  /** A type annotation whose value may be a client: a client class, @prisma/client's PrismaClient, Prisma's
   *  TransactionClient, as such, in a union or intersection, as a type argument (Omit<...>) or as an array's element. A
   *  function type is not its parameters' type, and an object type's members are declarations of their own. */
  function clientType(type) {
    if (!type) return false;
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName;
      let left = name;
      while (ts.isQualifiedName(left)) left = left.left;
      if (ts.isIdentifier(name) ? prismaImport(name) === 'PrismaClient' || clientClass(classOf(name))
        : ['TransactionClient', 'PrismaClient'].includes(name.right.text) && prismaImport(left) !== null) return true;
      return (type.typeArguments ?? []).some(clientType);
    }
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some(clientType);
    if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) return clientType(type.type);
    if (ts.isArrayTypeNode(type)) return clientType(type.elementType);
    if (ts.isTupleTypeNode(type)) return type.elements.some(element => clientType(ts.isNamedTupleMember(element) ? element.type : element));
    return false;
  }
  /** The first parameter of a callback handed to `$transaction`. */
  function transactionCallback(parameter) {
    const owner = parameter.parent;
    if (!(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) || owner.parameters.indexOf(parameter) !== shift(owner)) return false;
    const held = outer(owner), call = held.parent, callee = call && ts.isCallExpression(call) && call.arguments[0] === held ? bare(call.expression) : null;
    return isAccess(callee) && !!keyValues(callee)?.includes('$transaction');
  }
  const thisClass = node => {
    for (let at = node.parent; at; at = at.parent) {
      if (ts.isClassLike(at)) return at;
      if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at)) return null;
    }
    return null;
  };
  const clients = new Set(), clientFunctions = new Set(), clientMembers = new Set();
  const heldClient = symbol => !!symbol?.declarations?.some(declaration => clients.has(declaration));
  /** The functions a call or `new` runs, when every value its callee can take is one of the program's functions; else null. */
  function callees(call) {
    if (ts.isNewExpression(call)) {
      const declaration = classOf(call.expression);
      const constructor = declaration && ts.isClassLike(declaration) ? declaration.members.find(ts.isConstructorDeclaration) : null;
      return constructor?.body ? [constructor] : null;
    }
    const found = values(call.expression).filter(value => !value.none);
    return found.every(value => value.fn && value.fn.body) ? found.map(value => value.fn) : null;
  }
  /** Whether a value may be a client (the fixed point below decides the bindings). */
  function isClient(expression) {
    const node = bare(expression);
    if (!node) return false;
    if (ts.isAwaitExpression(node)) return isClient(node.expression);
    if (node.kind === K.ThisKeyword) return clientClass(thisClass(node));
    if (ts.isIdentifier(node)) return heldClient(symbolAt(node));
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = resolve(checker.getSymbolAtLocation(node.name));
      return symbol ? heldClient(symbol) : clientMembers.has(node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const keys = keyValues(node), type = checker.getTypeAtLocation(node.expression);
      return !!keys && keys.some(key => { const symbol = checker.getPropertyOfType(type, key); return symbol ? heldClient(resolve(symbol)) : clientMembers.has(key); });
    }
    if (ts.isConditionalExpression(node)) return isClient(node.whenTrue) || isClient(node.whenFalse);
    if (ts.isBinaryExpression(node)) {
      return CHOICES.has(node.operatorToken.kind) ? isClient(node.left) || isClient(node.right)
        : node.operatorToken.kind === K.CommaToken && isClient(node.right);
    }
    if (ts.isNewExpression(node)) return clientClass(classOf(node.expression));
    // A call handed a client class (Nest's `app.get(PrismaService)`) gives an instance of it.
    if (ts.isCallExpression(node)) {
      return node.arguments.some(argument => ts.isIdentifier(bare(argument)) && clientClass(classOf(bare(argument))))
        || (clientFunctions.size > 0 && !!callees(node)?.some(owner => clientFunctions.has(owner)));
    }
    return false;
  }

  // ── raw SQL (F03) ──
  const RAW = new Set(['$executeRaw', '$queryRaw', '$executeRawUnsafe', '$queryRawUnsafe']);
  const claimed = new Set(), naming = [];
  const TABLE_WORDS = /auditlog/i;
  /** Texts that may name the AuditLog table in SQL: any text with it that is not one bare name (a member key such as
   *  'auditLog' is F01's; SQL names the table as the quoted identifier, the only spelling that reaches it). */
  const namesTable = value => TABLE_WORDS.test(value) && !/^[A-Za-z_$][\w$]*$/.test(value);
  /**
   * SQL tokens over the texts between interpolations, by PostgreSQL's lexical rules for what the INSERT form needs: a string
   * ('' is a quote), a quoted identifier ("" is a quote; case kept), a word (keyword or unquoted identifier, folded to lower
   * case), a number, a punctuation mark, an operator and each interpolation; blanks and comments (--, nested / * * /) are
   * dropped. An unclosed string, identifier or comment (none may hold an interpolation), E'', B'', X'', N'', U& and $ throw.
   */
  function sqlTokens(parts) {
    const tokens = [];
    parts.forEach((part, index) => {
      if (index > 0) tokens.push({ kind: 'param', index: index - 1 });
      const last = index === parts.length - 1;
      const fail = why => { throw new Error(why); };
      let i = 0;
      while (i < part.length) {
        const ch = part[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (part.startsWith('--', i)) {
          const end = part.indexOf('\n', i);
          if (end < 0 && !last) fail('a line comment runs into an interpolation');
          i = end < 0 ? part.length : end + 1;
          continue;
        }
        if (part.startsWith('/*', i)) {
          let depth = 0;
          do {
            if (part.startsWith('/*', i)) { depth++; i += 2; } else if (part.startsWith('*/', i)) { depth--; i += 2; } else i++;
            if (i >= part.length && depth > 0) fail('an unclosed comment');
          } while (depth > 0);
          continue;
        }
        if (ch === "'" || ch === '"') {
          let value = '', j = i + 1;
          for (;;) {
            if (j >= part.length) fail(ch === "'" ? 'an unclosed string' : 'an unclosed quoted identifier');
            if (part[j] === ch) { if (part[j + 1] === ch) { value += ch; j += 2; continue; } break; }
            value += part[j++];
          }
          if (ch === '"' && !value) fail('an empty quoted identifier');
          tokens.push(ch === "'" ? { kind: 'string', value } : { kind: 'ident', value, name: value });
          i = j + 1;
          continue;
        }
        const word = /^(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*/.exec(part.slice(i));
        if (word) {
          const next = part[i + word[0].length];
          if (/^[EeBbXxNn]$/.test(word[0]) && next === "'") fail(`a ${word[0]}'' string`);
          if (/^[Uu]$/.test(word[0]) && next === '&') fail('a U& escape');
          tokens.push({ kind: 'word', value: word[0], name: word[0].toLowerCase(), upper: word[0].toUpperCase() });
          i += word[0].length;
          continue;
        }
        const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(part.slice(i));
        if (number) { tokens.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
        if ('(),;.[]'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i++; continue; }
        if (ch === '$') fail('a $ parameter or dollar quote');
        const operator = /^[+\-*/<>=~!@#%^&|`?:]+/.exec(part.slice(i));
        if (!operator) fail(`the character ${JSON.stringify(ch)}`);
        const cut = operator[0].search(/--|\/\*/);   // a comment starts inside what would be one operator
        const value = cut > 0 ? operator[0].slice(0, cut) : operator[0];
        tokens.push({ kind: 'operator', value });
        i += value.length;
      }
    });
    return tokens;
  }
  const shown = token => (!token ? 'the end' : token.kind === 'param' ? 'an interpolation' : token.kind === 'string' ? `'${token.value}'`
    : token.kind === 'ident' ? `"${token.value}"` : token.value);
  const statements = tokens => tokens.filter((token, n) => token.kind === 'punct' && token.value === ';' && n !== tokens.length - 1).length + 1;
  /** INSERT INTO [schema.]"AuditLog" (columns) VALUES (values) [;]: the column names and the value tokens by position. */
  function insertForm(tokens) {
    let i = 0;
    const word = value => tokens[i]?.kind === 'word' && tokens[i].upper === value;
    const punct = value => tokens[i]?.kind === 'punct' && tokens[i].value === value;
    const name = token => (token?.kind === 'ident' ? token.value : token?.kind === 'word' ? token.name : null);
    if (statements(tokens) > 1) return { error: 'several statements' };
    if (!word('INSERT')) return { error: `not the INSERT form: it begins with ${shown(tokens[0])}` };
    i++;
    if (!word('INTO')) return { error: `not the INSERT form: ${shown(tokens[i])} after INSERT` };
    i++;
    const table = [tokens[i++]];
    if (punct('.')) { i++; table.push(tokens[i++]); }
    if (table.some(token => token?.kind === 'param')) return { error: 'an interpolation where the table goes' };
    if (table.some(token => name(token) === null)) return { error: `not a table name: ${table.map(shown).join('.')}` };
    const target = table[table.length - 1];
    if (!(target.kind === 'ident' && target.value === 'AuditLog')) return { error: `it inserts into ${table.map(shown).join('.')}, not "AuditLog"` };
    if (!punct('(')) return { error: `no column list (${shown(tokens[i])} after the table)` };
    i++;
    const columns = [];
    for (;;) {
      const token = tokens[i++];
      if (token?.kind === 'param') return { error: 'an interpolation where a column goes' };
      if (name(token) === null) return { error: `a column list with ${shown(token)}` };
      columns.push(name(token));
      if (punct(',')) { i++; continue; }
      if (punct(')')) { i++; break; }
      return { error: `a column list with ${shown(tokens[i])}` };
    }
    if (!word('VALUES')) return { error: `${shown(tokens[i])} where VALUES goes (INSERT … SELECT or another form)` };
    i++;
    if (!punct('(')) return { error: `${shown(tokens[i])} after VALUES` };
    i++;
    const row = [[]];
    for (let depth = 0; ;) {
      const token = tokens[i++];
      if (!token) return { error: 'an unclosed VALUES list' };
      if (token.kind === 'punct' && (token.value === '(' || token.value === '[')) depth++;
      if (token.kind === 'punct' && (token.value === ')' || token.value === ']')) {
        if (depth === 0) break;
        depth--;
      }
      if (depth === 0 && token.kind === 'punct' && token.value === ',') { row.push([]); continue; }
      row[row.length - 1].push(token);
    }
    if (punct(';')) i++;
    if (i < tokens.length) return { error: `${shown(tokens[i])} after the VALUES list (a second row, ON CONFLICT, RETURNING or another clause)` };
    if (row.some(value => value.length === 0)) return { error: 'an empty value in the VALUES list' };
    if (row.length !== columns.length) return { error: `${columns.length} columns and ${row.length} values` };
    const twice = columns.find((column, n) => columns.indexOf(column) !== n);
    if (twice !== undefined) return { error: `the column ${twice} is named twice` };
    const at = columns.indexOf('action');
    if (at < 0) return { error: 'no action column' };
    return { columns, row, action: row[at] };
  }
  const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'TRUNCATE', 'INTO', 'CALL', 'DO', 'EXECUTE', 'ALTER',
    'DROP', 'CREATE', 'GRANT', 'REVOKE', 'LOCK', 'SET']);
  /** One SELECT with no word that changes rows (FOR UPDATE / FOR NO KEY UPDATE only lock). */
  const readsOnly = tokens => statements(tokens) === 1 && tokens[0]?.kind === 'word' && tokens[0].upper === 'SELECT'
    && tokens.every((token, n) => token.kind !== 'word' || !WRITES.has(token.upper)
      || (token.upper === 'UPDATE' && ['FOR', 'KEY'].includes(tokens[n - 1]?.upper)));
  const isDate = type => type.symbol?.name === 'Date' && !!type.symbol.declarations?.some(declaration =>
    program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  const PRIMITIVE = TF.StringLike | TF.NumberLike | TF.BooleanLike | TF.BigIntLike | TF.Null | TF.Undefined | TF.EnumLike;
  /** Why an interpolation may not be a value parameter (an SQL fragment would change the statement), or null. */
  function notValue(expression) {
    if (texts(values(expression))) return null;
    const type = checker.getTypeAtLocation(expression);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every(part => part.flags & PRIMITIVE || isDate(part)) ? null
      : `\`${snippet(expression)}\` (${checker.typeToString(type)}) is not shown to be a value`;
  }
  /** A raw call: its SQL must be one fixed text of the program; the INSERT form writes, one SELECT reads, others unresolved. */
  function rawCall(call) {
    let source = null;
    if (ts.isTaggedTemplateExpression(call)) source = call.template;
    else if (call.arguments.length === 1) {
      const argument = bare(call.arguments[0]);
      if (ts.isTaggedTemplateExpression(argument) && prismaMember(argument.tag) === 'sql') source = argument.template;
      else if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) source = argument;
    }
    if (!source) return note(call, 'raw call', 'unresolved', `its SQL is not one fixed text of the program: \`${snippet(call)}\``);
    claimed.add(source);
    const parts = ts.isTemplateExpression(source) ? [source.head.text, ...source.templateSpans.map(span => span.literal.text)] : [source.text];
    const spans = ts.isTemplateExpression(source) ? source.templateSpans.map(span => span.expression) : [];
    if (!parts.some(part => TABLE_WORDS.test(part))) return note(call, 'raw call', 'proven_non_audit', 'its SQL names no AuditLog');
    let tokens;
    try {
      tokens = sqlTokens(parts);
    } catch (error) {
      return note(call, 'raw SQL naming AuditLog', 'unresolved', `${error.message} in its SQL`);
    }
    if (!tokens.some(token => (token.kind === 'ident' || token.kind === 'word') && token.name.toLowerCase() === 'auditlog')) {
      return note(call, 'raw call', 'proven_non_audit', 'AuditLog is only in its strings or comments');
    }
    if (readsOnly(tokens)) return note(call, 'raw SQL naming AuditLog', 'proven_non_audit', 'one SELECT that changes no row reads AuditLog');
    const form = insertForm(tokens);
    if (form.error) return note(call, 'raw SQL naming AuditLog', 'unresolved', form.error);
    const [slot] = form.action, column = `column ${form.columns.indexOf('action') + 1} of ${form.columns.length}`;
    if (form.action.length !== 1 || (slot.kind !== 'string' && slot.kind !== 'param')) {
      return note(call, 'raw INSERT INTO "AuditLog"', 'unresolved', `the action value is not one SQL string or one interpolation: ${form.action.map(shown).join(' ')}`);
    }
    const found = slot.kind === 'string' ? [text(slot.value)] : values(spans[slot.index]);
    if (found.some(value => value.text === undefined && value.prefix === undefined)) return record(call, 'raw INSERT INTO "AuditLog"', found);
    const fragment = tokens.filter(token => token.kind === 'param' && token !== slot).map(token => notValue(spans[token.index])).find(Boolean);
    if (fragment) return note(call, 'raw INSERT INTO "AuditLog"', 'unresolved', fragment);
    record(call, 'raw INSERT INTO "AuditLog"', found, null, [slot.kind === 'string' ? `SQL string '${slot.value}' at ${column}`
      : `the interpolation \`${snippet(spans[slot.index])}\` at ${column}`]);
  }

  // ── the writes ──
  const READS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);
  function record(node, via, found, action, basis = []) {
    const unread = found.filter(value => value.text === undefined && value.prefix === undefined);
    if (!found.length || unread.length) {
      return note(node, via, 'unresolved', !found.length ? 'its action has no value in the program'
        : unread.map(value => value.unknown ?? `${where(value.fn)}: a function`).join('; '));
    }
    const origins = [...new Set(found.flatMap(value => value.from ?? []))];
    const site = { ...position(node), via, actions: found.filter(value => value.text !== undefined).map(value => value.text).sort(),
      prefixes: found.filter(value => value.prefix !== undefined).map(value => value.prefix).sort(),
      basis: [...basis, ...origins.map(origin => `${where(origin)} ${JSON.stringify(origin.text)}`),
        ...found.filter(value => value.guard).map(value => `${JSON.stringify(value.text)} let through by the guard at ${value.guard}`),
        ...found.filter(value => value.prefix !== undefined).map(value => `${value.prefix}… then ${value.why}`)] };
    Object.defineProperties(site, { call: { value: node }, action: { value: action }, origins: { value: origins }, start: { value: node.getStart() } });
    sites.push(site);
    note(node, via, 'resolved', site.basis.join('; '));
  }
  /** The property `name` an object literal ends up with: its last definition, unless a later spread or computed key may set it. */
  function property(object, name) {
    let found = { why: 'is not set' };
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) { found = { why: `may be set by the spread at ${where(member)}` }; continue; }
      const keys = member.name ? keyValues(member.name) : null;
      if (!keys) found = { why: `may be set by the computed key at ${where(member)}` };
      else if (keys.includes(name)) {
        found = keys.length > 1 ? { why: `may be set by the computed key at ${where(member)}` }
          : ts.isPropertyAssignment(member) ? { node: member.initializer, member }
            : ts.isShorthandPropertyAssignment(member) ? { shorthand: member, member } : { why: `is an accessor or method at ${where(member)}` };
      }
    }
    return found;
  }
  function create(call) {
    const argument = call.arguments.length === 1 ? bare(call.arguments[0]) : null;
    if (!argument || !ts.isObjectLiteralExpression(argument)) return record(call, 'auditLog.create', [unknown('its argument is not one object literal')]);
    const data = property(argument, 'data');
    const object = data.node && bare(data.node);
    if (!object || !ts.isObjectLiteralExpression(object)) {
      return record(call, 'auditLog.create', [unknown(`data ${data.why ?? 'is not an object literal'}`)]);
    }
    const action = property(object, 'action');
    const found = action.node ? values(action.node) : action.shorthand ? named(symbolAt(action.shorthand.name), action.shorthand.name)
      : [unknown(`action ${action.why}`)];
    record(call, 'auditLog.create', found, action, action.member ? [`action \`${snippet(action.member)}\``] : []);
  }
  /** `x.auditLog` (any fixed key): only the receiver of a called method; `create` is a write this check reads. */
  function delegate(access) {
    const held = outer(access), parent = held.parent;
    if (!isAccess(parent) || parent.expression !== held) {
      return note(access, 'auditLog delegate', 'unresolved', `the delegate is used other than by calling one of its methods (${K[parent.kind]})`);
    }
    const methods = keyValues(parent);
    if (!methods || methods.length !== 1) return note(parent, 'auditLog method', 'unresolved', 'a method of the delegate by a key the program does not fix');
    const [method] = methods, callee = outer(parent), call = callee.parent;
    if (READS.has(method)) return note(parent, `auditLog.${method}`, 'proven_non_audit', 'a read method');
    if (!ts.isCallExpression(call) || call.expression !== callee) {
      return note(parent, `auditLog.${method}`, 'unresolved', 'the method is used other than by calling it');
    }
    if (method !== 'create') return note(call, `auditLog.${method}`, 'unresolved', 'writes rows this check does not read');
    create(call);
  }
  function access(node) {
    const inner = bare(node.expression);
    if (isAccess(inner) && keyValues(inner)?.includes('auditLog')) return;   // the delegate's method: read by delegate()
    const keys = keyValues(node);
    if (keys?.some(key => RAW.has(key))) {
      const held = outer(node), parent = held.parent;
      const called = (ts.isTaggedTemplateExpression(parent) && parent.tag === held) || (ts.isCallExpression(parent) && parent.expression === held);
      if (keys.length === 1 && called) return rawCall(parent);
      return note(node, 'raw call', 'unresolved', keys.length > 1 ? 'a raw method by a key the program does not fix' : 'a raw method used other than by calling it');
    }
    if (keys?.includes('auditLog')) {
      return keys.length === 1 ? delegate(node)
        : note(node, 'auditLog access', 'unresolved', `the key may be auditLog or ${keys.filter(key => key !== 'auditLog').join(', ')}`);
    }
    const literal = ts.isElementAccessExpression(node) && [K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.NumericLiteral].includes(bare(node.argumentExpression).kind);
    if (!ts.isElementAccessExpression(node) || literal) return;
    if (keys) {
      if (isClient(node.expression)) note(node, 'member of a client', 'proven_non_audit', `the key is ${keys.join(' or ')}`);
      return;
    }
    if (isClient(node.expression)) note(node, 'member of a client', 'unresolved', 'a member of a client value by a key the program does not fix');
    else note(node, 'computed key', 'proven_non_audit', `no client value reaches \`${snippet(node.expression)}\``);
  }
  /** A destructured property of a client, or one named auditLog: the delegate taken out of its client. */
  function destructuring(node, keyNode, source, rest) {
    const keys = rest ? null : keyValues(keyNode);
    if (keys?.includes('auditLog')) return note(node, 'auditLog delegate', 'unresolved', 'the delegate is taken out of its client by destructuring');
    if (source && isClient(source) && (!keys || rest)) {
      note(node, 'member of a client', 'unresolved', rest ? 'the rest of a client is taken out by destructuring' : 'a member of a client is taken out by a key the program does not fix');
    }
  }
  /** Prisma's SQL fragment builders: a fragment whose text the program does not fix. */
  function fragment(node) {
    const name = prismaMember(node.expression);
    if (!name) return;
    const literal = argument => !!argument && (ts.isStringLiteral(bare(argument)) || ts.isNoSubstitutionTemplateLiteral(bare(argument)));
    if ((name === 'raw' && !literal(node.arguments?.[0])) || (name === 'sql' && ts.isCallExpression(node)) || name === 'Sql'
      || (name === 'join' && (node.arguments?.length ?? 0) > 1 && !node.arguments.slice(1).every(literal))) {
      note(node, 'raw SQL fragment', 'unresolved', `\`${snippet(node)}\`: SQL whose text the program does not fix`);
    }
  }
  function visit(node) {
    if (isAccess(node)) access(node);
    else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      let declaration = node.parent;
      while (ts.isBindingElement(declaration) || ts.isObjectBindingPattern(declaration) || ts.isArrayBindingPattern(declaration)) declaration = declaration.parent;
      destructuring(node, node.propertyName ?? node.name, ts.isVariableDeclaration(declaration) ? declaration.initializer : null, !!node.dotDotDotToken);
    } else if (ts.isObjectLiteralExpression(node) && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === K.EqualsToken
      && node.parent.left === node) {
      for (const member of node.properties) {
        destructuring(member, ts.isSpreadAssignment(member) ? null : member.name, node.parent.right, ts.isSpreadAssignment(member));
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) fragment(node);
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && namesTable(node.text)) naming.push(node);
    if (ts.isTemplateExpression(node) && namesTable([node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('\u0000'))) naming.push(node);
    ts.forEachChild(node, visit);
  }

  // ── the scan ──
  for (const source of sources) {
    const file = program.getSourceFile(slash(path.join(ROOT, source.file)));
    const broken = program.getSyntacticDiagnostics(file);
    if (broken.length) note(file, 'source file', 'unresolved', `does not parse: ${ts.flattenDiagnosticMessageText(broken[0].messageText, ' ')}`);
    else files.push(file);
  }
  // The client flow: the seeds, then every binding, argument and result a client reaches, to a fixed point.
  const bindings = [], calls = [], results = [];
  const enclosing = node => { for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return at.body ? at : null; return null; };
  const collect = node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (clientType(node.type) || (ts.isParameter(node) && transactionCallback(node))) clients.add(node);
      if (node.initializer) bindings.push([node, node.initializer]);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.EqualsToken) {
      const left = bare(node.left);
      const symbol = ts.isIdentifier(left) ? symbolAt(left) : ts.isPropertyAccessExpression(left) ? resolve(checker.getSymbolAtLocation(left.name)) : null;
      if (symbol?.declarations?.length === 1) bindings.push([symbol.declarations[0], node.right]);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
    if (ts.isReturnStatement(node) && node.expression && enclosing(node)) results.push([enclosing(node), node.expression]);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) results.push([node, node.body]);
    ts.forEachChild(node, collect);
  };
  files.forEach(collect);
  const memberName = declaration => ((ts.isPropertyDeclaration(declaration) || (ts.isParameter(declaration) && ts.getCombinedModifierFlags(declaration)
    & (ts.ModifierFlags.ParameterPropertyModifier))) && declaration.name && !ts.isComputedPropertyName(declaration.name) ? declaration.name.text : null);
  for (let changed = true; changed;) {
    changed = false;
    const add = (set, item) => { if (!set.has(item)) { set.add(item); changed = true; } };
    for (const [declaration, value] of bindings) if (!clients.has(declaration) && isClient(value)) add(clients, declaration);
    for (const call of calls) {
      (call.arguments ?? []).forEach((argument, index) => {
        if (ts.isSpreadElement(argument) || !isClient(argument)) return;
        for (const owner of callees(call) ?? []) {
          const parameter = owner.parameters[index + shift(owner)];
          if (parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken) add(clients, parameter);
        }
      });
    }
    for (const [owner, value] of results) if (!clientFunctions.has(owner) && isClient(value)) add(clientFunctions, owner);
    for (const declaration of clients) { const name = memberName(declaration); if (name) add(clientMembers, name); }
  }
  files.forEach(visit);
  // Every client value is followed by the fixed point, or it is unresolved.
  const assignedClient = left => {
    const target = bare(left);
    const symbol = ts.isIdentifier(target) ? symbolAt(target) : ts.isPropertyAccessExpression(target) ? resolve(checker.getSymbolAtLocation(target.name)) : null;
    return heldClient(symbol);
  };
  function followClient(start) {
    let node = start;
    for (;;) {
      const parent = node.parent;
      if (WRAPPERS.has(parent.kind) || ts.isAwaitExpression(parent) || (ts.isConditionalExpression(parent) && parent.condition !== node)
        || (ts.isBinaryExpression(parent) && (CHOICES.has(parent.operatorToken.kind)
          || (parent.operatorToken.kind === K.CommaToken && parent.right === node)))) node = parent;
      else break;
    }
    const parent = node.parent;
    const argument = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node);
    const receiving = argument && callees(parent)?.every(owner => {
      const parameter = owner.parameters[parent.arguments.indexOf(node) + shift(owner)];
      return parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken && clients.has(parameter);
    });
    const returned = ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node);
    const owner = returned ? (ts.isReturnStatement(parent) ? enclosing(parent) : parent) : null;
    if ((isAccess(parent) && parent.expression === node)
      || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node
        && (clients.has(parent) || !ts.isIdentifier(parent.name)))
      || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === K.EqualsToken && parent.right === node
        && (assignedClient(parent.left) || ts.isObjectLiteralExpression(bare(parent.left)) || ts.isArrayLiteralExpression(bare(parent.left))))
      || (argument && receiving) || (owner && invocations(owner).escapes.length === 0) || inert(node)) return;
    note(start, 'client value', 'unresolved', `\`${snippet(start)}\`: ` + (argument ? `a client value handed to \`${snippet(parent.expression)}\`, which this check does not follow`
      : owner ? `a client value returned from ${describe(owner)}, which is handed on` : `a client value used in a ${K[parent.kind]}, where this check does not follow it`));
  }
  const occurrences = node => {
    if (ts.isTypeNode(node)) return;
    const name = ts.isIdentifier(node) && (accessOf(node) || (node.parent && 'name' in node.parent && node.parent.name === node
      && !ts.isShorthandPropertyAssignment(node.parent)) || ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent));
    const held = outer(node);   // written, not read: `tx = undefined`
    const target = !!held.parent && ts.isBinaryExpression(held.parent) && held.parent.left === held && held.parent.operatorToken.kind === K.EqualsToken;
    const value = node.kind === K.ThisKeyword || (ts.isIdentifier(node) && !name) || isAccess(node) || ts.isNewExpression(node) || ts.isCallExpression(node);
    if (value && !target && isClient(node)) followClient(node);
    ts.forEachChild(node, occurrences);
  };
  files.forEach(occurrences);
  for (const node of naming) if (!claimed.has(node)) note(node, 'SQL naming AuditLog', 'unresolved', 'names AuditLog but is not the fixed SQL of a raw call');
  const scan = { typescript: ts.version, files: sources.map(source => source.file), sites, candidates,
    unresolved: candidates.filter(entry => entry.status === 'unresolved').map(entry => `${entry.file}:${entry.line} ${entry.kind}: ${entry.reason}`),
    flow: { clients: [...clients].map(declaration => `${where(declaration)} ${declaration.name?.getText() ?? K[declaration.kind]}`).sort(),
      functions: [...clientFunctions].map(describe).sort(), members: [...clientMembers].sort() } };
  Object.defineProperties(scan, { tools: { value: { ts, bare, symbolAt, references } } });
  return scan;
}

// ── the verdict: the contract table is read here only ──
const VERDICT = {
  unread_sources: 'every script file under api/src is read by the program',
  unresolved: 'every audit candidate is resolved or proven not an audit write',
  unlisted: 'an audit action written under api/src without a contract row',
  uncovered_prefixes: 'a dynamic audit action without a wildcard row',
  unwritten_rows: 'contract rows nothing writes',
  unwritten_wildcards: 'wildcard rows nothing writes',
};
const EMPTY_VERDICT = Object.fromEntries(Object.keys(VERDICT).map(name => [name, []]));
/** The rows of api/src/admin-audit.ts: the exact rows (allowed and hidden) and the hidden wildcards' stems. */
function productTable() {
  const allowed = [...A.AUDIT_MEMBER_ACTIONS, ...Object.keys(A.AUDIT_FIELD_RULES), ...A.AUDIT_REPORT_COMMIT_ACTIONS.map(a => 'report.' + a)];
  const hidden = [...A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION, ...A.AUDIT_HIDDEN_CONNECT, ...A.AUDIT_HIDDEN_STUDY_SCOPED];
  return { rows: [...allowed, ...hidden.filter(entry => !entry.endsWith('*'))],
    wildcards: hidden.filter(entry => entry.endsWith('*')).map(entry => entry.slice(0, -1)),
    listed: action => A.auditRule(action) !== 'hidden:unknown_action' };
}
/** Every failure class of one scan at once, so that one never hides another. */
function verdict(scan, table = productTable(), listing = null) {
  const literals = new Set(scan.sites.flatMap(site => site.actions)), prefixes = new Set(scan.sites.flatMap(site => site.prefixes));
  return {
    unread_sources: listing ? [...listing.unread, ...listing.extra.map(file => `${file} (named by tsconfig, not on the disk)`)] : [],
    unresolved: scan.unresolved,
    unlisted: [...literals].filter(action => !table.listed(action)).sort(),
    uncovered_prefixes: [...prefixes].filter(start => !table.wildcards.some(stem => start.startsWith(stem))).sort(),
    unwritten_rows: table.rows.filter(action => !literals.has(action)),
    unwritten_wildcards: table.wildcards.filter(stem => ![...literals, ...prefixes].some(action => action.startsWith(stem))),
  };
}
const failing = found => Object.keys(VERDICT).filter(name => found[name].length > 0);


test('completeness: every api/src file is read, every audit candidate is resolved or proven not a write, both directions hold', () => {
  const { sources, listing } = productSources();
  const scan = scanAuditWrites(sources), found = verdict(scan, productTable(), listing);
  // The inventory, whatever the verdict: every write site with its kind, actions or prefixes and their basis, every
  // unresolved candidate, and every candidate proven not to be a write with its reason.
  console.log('ADMIN_AUDIT_SOURCES ' + JSON.stringify(listing));
  for (const site of scan.sites) console.log('ADMIN_AUDIT_WRITER ' + JSON.stringify({ ...site, status: 'resolved' }));
  for (const entry of scan.candidates.filter(entry => entry.status === 'unresolved')) console.log('ADMIN_AUDIT_WRITER ' + JSON.stringify(entry));
  const tally = {};
  for (const entry of scan.candidates) tally[`${entry.kind} / ${entry.status}`] = (tally[`${entry.kind} / ${entry.status}`] ?? 0) + 1;
  console.log('ADMIN_AUDIT_CANDIDATES ' + JSON.stringify(tally));
  for (const entry of scan.candidates.filter(entry => entry.status === 'proven_non_audit')) console.log('ADMIN_AUDIT_NON_AUDIT ' + JSON.stringify(entry));
  console.log('ADMIN_AUDIT_CLIENT_FLOW ' + JSON.stringify(scan.flow));
  const literals = new Set(scan.sites.flatMap(site => site.actions)), byRule = {};
  for (const action of literals) { const rule = A.auditRule(action).split(':')[0]; byRule[rule] = (byRule[rule] ?? 0) + 1; }
  console.log('ADMIN_AUDIT_COMPLETENESS ' + JSON.stringify({ typescript: scan.typescript, files_listed: listing.disk, files_read: scan.files.length,
    write_sites: scan.sites.length, raw_sql_sites: scan.sites.filter(site => site.via.startsWith('raw')).length,
    unresolved: scan.unresolved.length, distinct_actions: literals.size, dynamic_prefixes: [...new Set(scan.sites.flatMap(site => site.prefixes))].sort(),
    by_rule: byRule, write_files: new Set(scan.sites.map(site => site.file)).size }));
  console.log('ADMIN_AUDIT_VERDICT ' + JSON.stringify(found));
  // The owner-only study-scoped records (the S5-U4a question, the S5-U4c image request, the S7-U1a critical result) are
  // each written, and their own rows keep them off the console whatever their detail names.
  for (const action of A.AUDIT_HIDDEN_STUDY_SCOPED) assert.ok(literals.has(action), action);
  assert.deepEqual(found, EMPTY_VERDICT, `the audit completeness verdict fails: ${failing(found).map(name => VERDICT[name]).join('; ')}`);
});

test('completeness: the files of api/src are listed from the disk; one the program does not read fails the gate on its own', () => {
  const { listing } = productSources();
  assert.equal(listing.disk, typescript().named.length + listing.unread.length - listing.extra.length);
  const named = ['api/src/a.ts', 'api/src/b.ts'];
  assert.deepEqual(sourceListing(['api/src/a.ts', 'api/src/b.ts', 'api/src/notes.md'], named), { disk: 2, program: 2, unread: [], extra: [] });
  assert.deepEqual(sourceListing([...named, 'api/src/legacy.js', 'api/src/types.d.ts', 'api/src/link.ts (not a file)'], named).unread,
    ['api/src/legacy.js', 'api/src/link.ts (not a file)', 'api/src/types.d.ts']);
  assert.deepEqual(sourceListing(['api/src/a.ts'], named).extra, ['api/src/b.ts']);
  const clean = scanAuditWrites(baselineSources());
  assert.deepEqual(failing(verdict(clean, fixtureTable(), sourceListing([...named, 'api/src/legacy.js'], named))), ['unread_sources']);
});

// ── the checker's own tests, on test-owned fixtures (tests/fixtures/admin_audit_completeness; Astra S7-U3a-AUDIT-SPEC-R-001-F04) ──
// Each fixture declares what it expects: `// expect:` on a line names the one candidate the line gives, the violations'
// headers name the one failure class each must cause, and contract.json is their table. Nothing here is read from the
// checker's output to decide what is expected.

const FIXTURES = path.join(__dirname, 'fixtures', 'admin_audit_completeness');
const fixtureText = name => readFileSync(path.join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');
const asSource = (name, text) => ({ file: `api/src/syn-fixture/${name}`, text });
const baselineSources = () => ['actions.ts', 'forward.ts', 'baseline.ts'].map(name => asSource(name, fixtureText(name)));
/** contract.json as a table, with a case's added rows or wildcards. */
function fixtureTable(added = {}) {
  const table = JSON.parse(fixtureText('contract.json'));
  const rows = [...table.rows, ...(added.rows ?? [])], wildcards = [...table.wildcards, ...(added.wildcards ?? [])];
  return { rows, wildcards, listed: action => rows.includes(action) || wildcards.some(stem => action.startsWith(stem)) };
}
/** A fixture's marks: line -> {status, detail}; a mark alone on its line is the next line's. */
function marks(text) {
  const found = new Map();
  text.split('\n').forEach((line, index) => {
    const mark = /\/\/ expect: (resolved|proven_non_audit|unresolved)(?: (.*))?$/.exec(line);
    if (!mark) return;
    const at = /^\s*\/\/ expect:/.test(line) ? index + 2 : index + 1;
    assert.ok(!found.has(at), `line ${at} is marked twice`);
    found.set(at, { status: mark[1], detail: (mark[2] ?? '').trim() });
  });
  return found;
}
/** The candidates of `scan` in `source` against its marks: one per marked line, as marked, and none on another line. */
function assertMarked(scan, source) {
  const expected = marks(source.text), seen = new Set();
  for (const entry of scan.candidates.filter(entry => entry.file === source.file)) {
    const label = `${source.file}:${entry.line} ${entry.kind} ${entry.status}: ${entry.reason}`;
    const mark = expected.get(entry.line);
    assert.ok(mark, `a candidate on a line without a mark: ${label}`);
    assert.ok(!seen.has(entry.line), `a second candidate on a marked line: ${label}`);
    seen.add(entry.line);
    assert.equal(entry.status, mark.status, label);
    if (mark.status === 'resolved') {
      const site = scan.sites.find(site => site.file === entry.file && site.start === entry.start), words = mark.detail.split(/\s+/).filter(Boolean);
      assert.deepEqual([site.actions, site.prefixes], [words.filter(word => !word.startsWith('prefix:')).sort(),
        words.filter(word => word.startsWith('prefix:')).map(word => word.slice('prefix:'.length)).sort()], label);
    } else {
      assert.ok(entry.reason.includes(mark.detail), `${label}\n  the mark says: ${mark.detail}`);
    }
  }
  assert.deepEqual([...expected.keys()].filter(line => !seen.has(line)), [], `${source.file}: marked lines that gave no candidate`);
  return { marked: expected.size, resolved: [...expected.values()].filter(mark => mark.status === 'resolved').length,
    unresolved: [...expected.values()].filter(mark => mark.status === 'unresolved').length };
}
/** violations.txt: one module per `// ==== case: <name> | verdict: <class> [entries] [| table: +row|+wildcard <x>] ====`. */
function violationCases() {
  const cases = [];
  for (const line of fixtureText('violations.txt').split('\n')) {
    const header = /^\/\/ ==== case: (\S+) \| verdict: (\w+)((?: [^\s|]+)*)((?: \| table: \+(?:row|wildcard) \S+)*) ====$/.exec(line);
    if (header) {
      const table = { rows: [], wildcards: [] };
      for (const [, kind, value] of header[4].matchAll(/\| table: \+(row|wildcard) (\S+)/g)) table[kind === 'row' ? 'rows' : 'wildcards'].push(value);
      cases.push({ name: header[1], failing: header[2], entries: header[3].trim().split(/\s+/).filter(Boolean), table, lines: [] });
    } else if (cases.length) {
      cases[cases.length - 1].lines.push(line);
    }
  }
  return cases.map(entry => ({ ...entry, source: asSource(`case-${entry.name}.ts`, entry.lines.join('\n')) }));
}
/** A scan's candidates as `file@offset kind status [actions prefixes]`, their offsets carried through `edits` if given. */
function inventory(scan, edits = null) {
  return scan.candidates.map(entry => {
    const site = entry.status === 'resolved' ? scan.sites.find(site => site.file === entry.file && site.start === entry.start) : null;
    return `${entry.file}@${edits ? moved(edits, entry.file, entry.start) : entry.start} ${entry.kind} ${entry.status}`
      + (site ? ` [${site.actions}] [${site.prefixes}]` : '');
  }).sort();
}
/** Where `offset` of `file` lands after `edits` (none overlapping); null when an edit replaced it. */
function moved(edits, file, offset) {
  let delta = 0;
  for (const [start, end, replacement] of edits.get(file) ?? []) {
    if (end <= offset) delta += replacement.length - (end - start);
    else if (start < offset) return null;
  }
  return offset + delta;
}

test('checker self-test: the baseline fixture passes the gate alone; its writes, reads and other accesses are as marked', () => {
  const sources = baselineSources(), scan = scanAuditWrites(sources);
  const counts = sources.map(source => assertMarked(scan, source));
  assert.deepEqual(verdict(scan, fixtureTable()), EMPTY_VERDICT);
  assert.equal(scan.sites.length, counts.reduce((sum, count) => sum + count.resolved, 0));
  // The flow found the client of the baseline where it is: the PrismaClient subclass's member and the $transaction callback's parameter.
  assert.deepEqual(scan.flow.clients.map(entry => entry.split(' ').pop()), ['prisma', 'tx']);
  console.log('ADMIN_AUDIT_CHECKER_BASELINE ' + JSON.stringify({ marks: counts, sites: scan.sites.length, candidates: scan.candidates.length, flow: scan.flow }));
});

test('checker self-test: the supported notations (a)-(i) and the INSERT positions each add exactly their marked writes', () => {
  const base = scanAuditWrites(baselineSources()), before = inventory(base);
  for (const name of ['equivalent.ts', 'sql-positions.ts']) {
    const source = asSource(name, fixtureText(name)), scan = scanAuditWrites([...baselineSources(), source]);
    const count = assertMarked(scan, source);
    // Each marked write is one more site, and nothing of the baseline changed.
    assert.equal(scan.sites.filter(site => site.file === source.file).length, count.resolved, name);
    assert.deepEqual(inventory(scan).filter(entry => !entry.startsWith(source.file + '@')), before, name);
    assert.deepEqual(verdict(scan, fixtureTable()), EMPTY_VERDICT, name);
    console.log('ADMIN_AUDIT_CHECKER_SUPPORTED ' + JSON.stringify({ fixture: name, ...count,
      sites: scan.sites.filter(site => site.file === source.file).map(site => `${site.line} ${site.via} [${site.actions}] [${site.prefixes}]`) }));
  }
});

test('checker self-test: every failure class fails the gate on its own, on exactly its marked candidates', async t => {
  const cases = violationCases(), results = [];
  assert.ok(cases.length >= 60, `${cases.length} cases`);
  assert.deepEqual(cases.map(entry => entry.name).filter((name, n, all) => all.indexOf(name) !== n), [], 'case names are unique');
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const scan = scanAuditWrites([...baselineSources(), entry.source]), found = verdict(scan, fixtureTable(entry.table));
      const count = assertMarked(scan, entry.source);
      assert.deepEqual(failing(found), [entry.failing], `${entry.name}: ${JSON.stringify(found)}`);
      if (entry.failing === 'unresolved') {
        assert.equal(found.unresolved.length, count.unresolved);
        for (const reason of found.unresolved) assert.ok(reason.startsWith(entry.source.file + ':'), reason);
      } else {
        assert.deepEqual(found[entry.failing], entry.entries);
      }
      results.push({ case: entry.name, failing: failing(found), found: found[entry.failing] });
    });
  }
  console.log('ADMIN_AUDIT_CHECKER_VIOLATIONS ' + JSON.stringify(results));
});

// ── the controls over api/src: rewrites by the positions the compiler parsed, and values changed to fail ──
// No spelling of the product is assumed: the edits are made where the compiler found each write, and every write site keeps
// its position (carried through the edits), its kind and its actions — a site that disappears or appears fails, even when
// another site records the same action (Astra S7-U3a-AUDIT-SPEC-R-001-F04).

/** `sources` with the text edits of `edits` (file -> [[start, end, text], ...], none overlapping) made by position. */
function edited(sources, edits) {
  return sources.map(source => {
    const list = [...(edits.get(source.file) ?? [])].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    let text = source.text;
    list.forEach(([start, end, replacement], i) => {
      assert.ok(i === 0 || end <= list[i - 1][0], `${source.file}: overlapping edits at ${start}`);
      text = text.slice(0, start) + replacement + text.slice(end);
    });
    return { file: source.file, text };
  });
}
const edit = (edits, file, start, end, replacement) => {
  if (!edits.has(file)) edits.set(file, []);
  if (!edits.get(file).some(([s, e, r]) => s === start && e === end && r === replacement)) edits.get(file).push([start, end, replacement]);
  edits.get(file).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
};

test('completeness equivalents: every write of api/src rewritten in another notation keeps its site, position and actions', () => {
  const sources = auditSources(), base = scanAuditWrites(sources);
  const { ts, bare, symbolAt, references } = base.tools;
  const creates = base.sites.filter(site => site.via === 'auditLog.create');
  assert.ok(creates.length > 0);
  const text = node => node.getSourceFile().text.slice(node.getStart(), node.end);
  /** The `x.auditLog` and `.create` accesses of a create call, outermost first. */
  const chain = site => {
    const found = [];
    for (let access = bare(site.call.expression); access && (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access));
      access = bare(access.expression)) {
      found.push(access);
      if (found.length === 2) break;
    }
    return found;
  };
  const declare = (edits, file, line) => edit(edits, file, 0, 0, line + '\n');
  const variants = {
    // `action: (x)` for every action, a shorthand `action` included.
    'the action in parentheses': edits => creates.forEach(site => {
      const node = site.action.node ?? site.action.shorthand;
      edit(edits, site.file, node.getStart(), node.end, site.action.node ? `(${text(node)})` : `${text(node)}: (${text(node)})`);
    }),
    // `x['auditLog']['create'](...)` for every `x.auditLog.create(...)`.
    'element access to the delegate and its create': edits => creates.forEach(site => {
      for (const access of chain(site)) if (ts.isPropertyAccessExpression(access)) edit(edits, site.file, access.expression.end, access.end, `['${access.name.text}']`);
    }),
    // `x[AUDIT_DELEGATE_KEY][AUDIT_CREATE_KEY](...)` with the two constants declared in the file (Astra S7-U3a-D-R-001-F01).
    'constant keys for the delegate and its create': edits => creates.forEach(site => {
      declare(edits, site.file, "const AUDIT_DELEGATE_KEY = 'auditLog', AUDIT_CREATE_KEY = 'create';");
      for (const access of chain(site)) {
        const key = access.name?.text === 'auditLog' ? 'AUDIT_DELEGATE_KEY' : 'AUDIT_CREATE_KEY';
        if (ts.isPropertyAccessExpression(access)) edit(edits, site.file, access.expression.end, access.end, `[${key}]`);
      }
    }),
    // `{ [AUDIT_DATA_KEY]: { [AUDIT_ACTION_KEY]: x } }` with the two constants declared in the file.
    'constant computed keys for data and action': edits => creates.forEach(site => {
      declare(edits, site.file, "const AUDIT_DATA_KEY = 'data', AUDIT_ACTION_KEY = 'action';");
      const member = site.action.member, data = member.parent.parent;
      edit(edits, site.file, data.name.getStart(), data.name.end, '[AUDIT_DATA_KEY]');
      if (site.action.shorthand) edit(edits, site.file, member.getStart(), member.end, `[AUDIT_ACTION_KEY]: ${text(member)}`);
      else edit(edits, site.file, member.name.getStart(), member.name.end, '[AUDIT_ACTION_KEY]');
    }),
    // A comment and a line break before the action and the argument, trailing commas after the last properties.
    'comments, line breaks and trailing commas': edits => creates.forEach(site => {
      const member = site.action.member, data = member.parent, argument = bare(site.call.arguments[0]);
      edit(edits, site.file, member.getStart(), member.getStart(), '// the audited action\n');
      edit(edits, site.file, site.call.arguments.pos, site.call.arguments.pos, '\n  /* the row */\n');
      for (const object of [data, argument]) if (!object.properties.hasTrailingComma) edit(edits, site.file, object.properties.end, object.properties.end, ',');
    }),
    // `as const` on every const literal an action comes from; `satisfies string` on every action named by a binding.
    'as const and satisfies': edits => creates.forEach(site => {
      for (const origin of site.origins) {
        const holder = origin.parent;
        if (ts.isVariableDeclaration(holder) && holder.initializer === origin) edit(edits, repoPath(origin.getSourceFile().fileName), origin.end, origin.end, ' as const');
      }
      const node = site.action.node ? bare(site.action.node) : site.action.shorthand;
      if (site.action.shorthand) edit(edits, site.file, node.getStart(), node.end, `${text(node)}: ${text(node)} satisfies string`);
      else if (ts.isIdentifier(node)) edit(edits, site.file, node.end, node.end, ' satisfies string');
    }),
    // Every const an action names directly, renamed with all its uses (the checker's references, imports included).
    'the constants renamed': edits => creates.forEach(site => {
      const node = site.action.node ? bare(site.action.node) : null;
      if (!node || !ts.isIdentifier(node)) return;
      const symbol = symbolAt(node), [declaration] = symbol?.declarations ?? [];
      if (!declaration || !ts.isVariableDeclaration(declaration) || !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return;
      const renamed = `${symbol.name}_RENAMED`;
      for (const at of [declaration.name, ...references(symbol)]) {
        const file = repoPath(at.getSourceFile().fileName);
        const shorthand = ts.isShorthandPropertyAssignment(at.parent) && at.parent.name === at;
        edit(edits, file, at.getStart(), at.end, shorthand ? `${at.text}: ${renamed}` : renamed);
      }
    }),
  };
  const expectedAll = inventory(base), counts = {};
  for (const [name, make] of Object.entries(variants)) {
    const edits = new Map();
    make(edits);
    counts[name] = [...edits.values()].reduce((sum, list) => sum + list.length, 0);
    assert.ok(counts[name] > 0, `${name} changes the source`);
    const scan = scanAuditWrites(edited(sources, edits));
    // Every candidate of api/src, each write site with its actions, where the rewrite carried it; none more, none less.
    assert.deepEqual(inventory(scan), inventory(base, edits), name);
    assert.equal(scan.sites.length, base.sites.length, name);
    // The same verdict (its positions are the inventory's above; a declaration a rewrite adds moves lines).
    const lineless = scanned => ({ ...scanned, unresolved: scanned.unresolved.map(entry => entry.replace(/^([^:]+):\d+ /, '$1 ')) });
    assert.deepEqual(lineless(verdict(scan, productTable(), productSources().listing)), lineless(verdict(base, productTable(), productSources().listing)), name);
  }
  console.log('ADMIN_AUDIT_EQUIVALENT_REWRITES ' + JSON.stringify({ edits: counts, candidates: expectedAll.length, sites: base.sites.length }));

  // The comparison keeps each site: taking out one of two writes of a file that record the same actions (the reader
  // assignment close and assign writes, where they are) is caught, where a comparison of the actions each file records
  // does not see it.
  const twins = creates.filter(site => creates.some(other => other !== site && other.file === site.file && `${other.actions}` === `${site.actions}`));
  const first = twins.find(site => site.actions.includes('reader.assignment')) ?? twins[0], removal = new Map();
  assert.ok(first, 'api/src has two writes of one file that record the same actions');
  edit(removal, first.file, first.call.getStart(), first.call.end, 'void 0');
  const removed = scanAuditWrites(edited(sources, removal));
  const actionsByFile = scan => JSON.stringify(Object.fromEntries([...new Set(scan.sites.map(site => site.file))].sort()
    .map(file => [file, [...new Set(scan.sites.filter(site => site.file === file).flatMap(site => site.actions))].sort()])));
  assert.equal(actionsByFile(removed), actionsByFile(base), 'the actions per file are the same without it');
  assert.notDeepEqual(inventory(removed), inventory(base, removal));
  assert.deepEqual(inventory(base, removal).filter(entry => !inventory(removed).includes(entry)),
    [`${first.file}@${first.start} auditLog.create resolved [${first.actions}] [${first.prefixes}]`]);
  // A new synthetic writer adds exactly one site.
  const writer = [
    "import { Prisma } from '@prisma/client';",
    "export async function addedWriter(tx: Prisma.TransactionClient) { await tx.auditLog.create({ data: { action: 'reader.assignment' } }); }",
  ].join('\n');
  const added = scanAuditWrites([...sources, { file: 'api/src/syn-added-writer.ts', text: writer }]);
  assert.deepEqual(inventory(added).filter(entry => !expectedAll.includes(entry)),
    [`api/src/syn-added-writer.ts@${writer.indexOf('tx.auditLog')} auditLog.create resolved [reader.assignment] []`]);
  assert.equal(added.sites.length, base.sites.length + 1);
  console.log('ADMIN_AUDIT_SITE_CONTROLS ' + JSON.stringify({ removed: `${first.file}:${first.line} [${first.actions}]`, twins: twins.length,
    added: 'api/src/syn-added-writer.ts' }));
});

test('completeness negative controls on api/src: unlisted, dynamic without a wildcard and unwritten actions each fail on their own', () => {
  const sources = auditSources(), base = scanAuditWrites(sources), { ts } = base.tools, listing = productSources().listing;
  const before = verdict(base, productTable(), listing);
  /** The verdict of `changed`: class `name` gains exactly `added` (in the verdict's own order), every other class is as it was. */
  const alone = (changed, name, added) => {
    const found = verdict(changed, productTable(), listing), grown = [...before[name], ...added];
    const expected = name === 'unwritten_rows' ? productTable().rows.filter(row => grown.includes(row)) : [...new Set(grown)].sort();
    assert.deepEqual(found[name], expected, name);
    for (const other of Object.keys(VERDICT).filter(other => other !== name)) assert.deepEqual(found[other], before[other], `${name}: ${other}`);
    return found;
  };
  // (a) New writes of actions without a row: a literal, a constant, a constant delegate key (Astra S7-U3a-D-R-001-F01) and
  // raw SQL whose action column holds it while another column holds a registered action (S7-U3a-D-R-001-F02).
  alone(scanAuditWrites([...sources, { file: 'api/src/syn-unlisted.service.ts', text: [
    "import { Prisma } from '@prisma/client';",
    "export const SYN_UNLISTED_ACTION = 'syn.unlisted';",
    "const LOG = 'auditLog';",
    'export class SynUnlistedService {',
    '  private async write(tx: Prisma.TransactionClient, actor: string, uid: string) {',
    "    await tx.auditLog.create({ data: { actor, action: 'study.question.reply', target: uid } });",
    '    await tx.auditLog.create({ data: { actor, action: SYN_UNLISTED_ACTION, target: uid } });',
    "    await tx[LOG].create({ data: { actor, action: 'syn.const-key-unlisted', target: uid } });",
    "    await tx.$executeRaw`INSERT INTO \"AuditLog\" (actor, action, target) VALUES (${actor}, 'syn.raw-unlisted', 'reader.assignment')`;",
    '  }',
    '}',
  ].join('\n') }]), 'unlisted', ['study.question.reply', 'syn.const-key-unlisted', 'syn.raw-unlisted', 'syn.unlisted']);
  // (b) The values existing writes take change to values without a row: every literal an action of api/src is read from,
  // wherever the compiler found it (a constant, a helper's argument, the create itself), gets '.v2' (unless a wildcard row
  // would still cover it). Each is then read, through the same constants, helpers and callbacks, as unlisted.
  const origins = [...new Set(base.sites.flatMap(site => site.origins))].filter(origin => A.auditRule(origin.text + '.v2') === 'hidden:unknown_action');
  assert.ok(origins.length > 0, 'actions of api/src are read from literals');
  const revalued = new Map();
  for (const origin of origins) {
    const quote = origin.getText()[0];
    edit(revalued, repoPath(origin.getSourceFile().fileName), origin.getStart(), origin.end, `${quote}${origin.text}.v2${quote}`);
  }
  const changed = verdict(scanAuditWrites(edited(sources, revalued)), productTable(), listing);
  assert.deepEqual(changed.unlisted, [...new Set([...before.unlisted.filter(action => !origins.some(origin => origin.text === action)),
    ...origins.map(origin => origin.text + '.v2')])].sort());
  assert.deepEqual([changed.unresolved, changed.uncovered_prefixes, changed.unread_sources], [before.unresolved, before.uncovered_prefixes, before.unread_sources]);
  // (c) A dynamic suffix no hidden wildcard row covers.
  alone(scanAuditWrites([...sources, { file: 'api/src/syn-dynamic.service.ts', text: [
    "import { Prisma } from '@prisma/client';",
    'export class SynDynamicService {',
    "  private async write(tx: Prisma.TransactionClient, body: any) { await tx.auditLog.create({ data: { action: 'reader.' + body.kind } }); }",
    '}',
  ].join('\n') }]), 'uncovered_prefixes', ['reader.']);
  // (d) A contract row nothing writes: every write of one row is taken out (`void 0` in its place) — reader.assignment
  // where its writes record nothing else, else the first such row of the table.
  const only = row => base.sites.some(site => site.actions.includes(row)) && base.sites.every(site => !site.actions.includes(row) || `${site.actions}` === row);
  const row = only('reader.assignment') ? 'reader.assignment' : productTable().rows.find(only);
  assert.ok(row, 'a contract row whose writes record nothing else');
  const removed = new Map();
  for (const site of base.sites.filter(site => site.actions.includes(row))) {
    const write = ts.isTaggedTemplateExpression(site.call.parent) ? site.call.parent : site.call;
    edit(removed, site.file, write.getStart(), write.end, 'void 0');
  }
  alone(scanAuditWrites(edited(sources, removed)), 'unwritten_rows', [row]);
  console.log('ADMIN_AUDIT_NEGATIVE_CONTROLS ' + JSON.stringify({ revalued_literals: origins.length, unlisted_after_revalue: changed.unlisted.length,
    unwritten_row: row, writes_taken_out: [...removed.values()].flat().length }));
});
