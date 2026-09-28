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
 *  - completeness: every audit action written under api/src has a contract row (an unlisted action fails), and every
 *    contract row is written somewhere. Which calls write and which values their action takes is read by the TypeScript
 *    compiler api/package-lock.json installs, over the program of api/src (see the completeness section). Controls: the
 *    same writes in other notations read the same actions; unlisted, unreadable and unwritten actions each fail.
 *
 * Module: KIN_ADMIN_AUDIT_MODULE, default api/src/admin-audit.ts loaded through Node type stripping (Node >= 22.18);
 * the compiled /app/dist/admin-audit (kin-api:ci) is the same rule. The completeness cases read api/src and use
 * api/node_modules/typescript ('npm ci --prefix api --ignore-scripts'), so the repository must be mounted with it; without
 * it they fail. Synthetic data only: no network, database, credentials or clinical data.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
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
// Both directions of the action table over the audit writes under api/src: every action a write can record has a
// contract row (an unlisted action fails), and every contract row is written somewhere (a stale row would hide a renamed
// writer). Which calls write the audit log and which values their action takes is answered by the TypeScript compiler
// api/package-lock.json installs, with api/tsconfig.json's options: its parser and type checker over the program of
// api/src, not a reader of this repository's text (AGENTS 1-B.15, Astra S7-U3a-C-R-001-F01). Without it the completeness
// cases fail; they never skip.
//
//  - A write is a call of the `create` member of an `auditLog` member (property or element access, whatever the layout,
//    comments, parentheses or type assertions), or a raw SQL text that inserts into "AuditLog". Any other use of an
//    auditLog member (createMany, upsert, the delegate kept in a variable ...) is a write this check does not read.
//  - The action of a create is the `action` property of the object literal its `data` holds (not set again by a later
//    spread). Its values: string literals and templates; `+` of values; both sides of `?:`, `||`, `??`; a name the checker
//    binds, through imports and aliases, to a const initializer, a property of an `as const` object literal, an enum
//    member or a readonly field; a let, var or parameter with every value assigned to it; a parameter of a private or
//    local function (not decorated) with the argument of every call the program makes of that function, followed through
//    variables, arguments and callbacks; a value that a preceding `if (... || !['a', ...].includes(x) || ...)
//    throw/return` of an enclosing block limits. A literal start followed by a value the program does not fix is a
//    dynamic suffix, which a hidden wildcard row must cover.
//  - Fail closed: an action from anything else (a call, a property of a request, a parameter of a public or decorated
//    method, a function handed where its calls are not followed ...) is unreadable, and an unreadable write fails.
//  - Raw SQL is not TypeScript and no SQL parser is installed, so the statement is not parsed: its action is the one
//    action-like quoted value or evaluable ${} value after INSERT INTO "AuditLog", and none or several is unreadable. What
//    the Connect statement writes is held live as well (tests/connect_gate_test.py, its transfer.revoke rows).
// How many rows a write leaves and whose they are is not this file's claim: the S7-U3a reader assignment writes are held
// to that on the compiled services (tests/reader_assignment_scope_test.cjs, Astra S7-U3a-B-R-001-F01).

const API = path.join(ROOT, 'api');
const slash = file => path.resolve(file).split(path.sep).join('/');
const repoPath = file => path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
let compiler = null;

/** api/package-lock.json's typescript, api/tsconfig.json's options and the api/src files they name, as checked out. */
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
  const files = parsed.fileNames.map(slash).filter(file => file.startsWith(src)).sort();
  assert.ok(files.length > 0, 'api/tsconfig.json includes the files of api/src');
  compiler = { ts, options, src, base: ts.createCompilerHost(options, true), lookups: new Map(), external: new Map(), internal: new Map(),
    previous: undefined, sources: files.map(file => ({ file: repoPath(file), text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n') })) };
  return compiler;
}
/** The api/src files as checked out; the controls pass changed copies. */
const auditSources = () => typescript().sources;

/** The program of `sources` (the whole of api/src; lib and node_modules from disk), reusing what earlier calls parsed. */
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
 * The audit writes of `sources` (default: api/src as checked out): `sites` with the actions and dynamic prefixes each can
 * record, and `unrecognized`, every write this check cannot read and why. A site also carries (not enumerable) its call,
 * its action property and the string literals its actions come from, for the controls that rewrite them.
 */
function scanAuditWrites(sources = auditSources()) {
  const { ts } = typescript();
  const K = ts.SyntaxKind;
  const program = auditProgram(sources), checker = program.getTypeChecker();
  const files = sources.map(source => program.getSourceFile(slash(path.join(ROOT, source.file))));
  const sites = [], unrecognized = [];

  const WRAPPERS = new Set([K.ParenthesizedExpression, K.AsExpression, K.SatisfiesExpression, K.NonNullExpression, K.TypeAssertionExpression]);
  const CHOICES = new Set([K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken]);
  const EQUALITIES = new Set([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken,
    K.InstanceOfKeyword]);
  const bare = node => { while (node && WRAPPERS.has(node.kind)) node = node.expression; return node; };
  const outer = node => { while (node.parent && WRAPPERS.has(node.parent.kind)) node = node.parent; return node; };
  const where = node => {
    const file = node.getSourceFile();
    return `${repoPath(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  };
  const snippet = node => node.getText().replace(/\s+/g, ' ').slice(0, 60);
  const resolve = symbol => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  /** The symbol a name stands for as a value (a shorthand property's name stands for the variable it reads). */
  const symbolAt = node => resolve(ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node));
  const keyText = name => {
    if (!name) return null;
    if (ts.isComputedPropertyName(name)) name = bare(name.expression);
    return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
      || ts.isNumericLiteral(name) ? name.text : null;
  };
  /** The member name of `a.b` or `a['b']` (a literal key), else null. */
  const keyOf = node => (ts.isPropertyAccessExpression(node) ? keyText(node.name)
    : ts.isElementAccessExpression(node) ? keyText(bare(node.argumentExpression)) : null);
  /** The access a member name belongs to (`this.x` for its `x`, `this['x']` for its literal 'x'), else null. */
  const accessOf = node => {
    const parent = node.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return parent;
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
    const held = outer(node);
    return held.parent && ts.isElementAccessExpression(held.parent) && held.parent.argumentExpression === held ? held.parent : null;
  };

  // ── values ──
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
    if (ts.isIdentifier(node)) return named(symbolAt(node), node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name : bare(node.argumentExpression);
      const symbol = keyOf(node) === null ? null : symbolAt(key);
      return symbol ? named(symbol, key) : [unknown(`${where(node)}: \`${snippet(node)}\` is a property the program does not fix`)];
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [fn(node)];
    return [unknown(`${where(node)}: \`${snippet(node)}\` is a ${K[node.kind]}`)];
  }

  /** The values of what `symbol` is bound to, read at `use`. */
  function named(symbol, use) {
    const name = use.text;
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
      return declaration.initializer ? values(declaration.initializer) : [unknown(`${where(use)}: \`${name}\` is a numbered enum member`)];
    }
    if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
      if (!frozen(declaration.parent)) return [unknown(`${where(use)}: \`${name}\` is a property of an object that is not \`as const\``)];
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
      found = values(declaration.initializer);
    } else {
      return [unknown(`${where(use)}: \`${name}\` is a ${K[declaration.kind]}`)];
    }
    const constant = ts.isVariableDeclaration(declaration) && ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const;
    const changes = constant ? [] : assignments(symbol);
    if (changes.length) return union(found, changes);
    // A binding nothing changes keeps its value, and a preceding exit for every other value limits it here.
    const members = found.some(value => value.text === undefined) ? limited(use, symbol) : null;
    return members ? members.filter(member => found.some(value => value.text === undefined || value.text === member)).map(member => text(member))
      : found;
  }

  /** An object literal a const holds under `as const` (the outermost literal asserted): its properties never change. */
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
      return constant && ts.isVariableDeclaration(parent) && parent.initializer === node
        && !!(ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const);
    }
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
      const call = bare(alternative.operand);
      if (!ts.isCallExpression(call) || call.arguments.length !== 1 || keyOf(bare(call.expression)) !== 'includes') continue;
      const tested = bare(call.arguments[0]), list = bare(bare(call.expression).expression);
      if (!ts.isIdentifier(tested) || symbolAt(tested) !== symbol || !ts.isArrayLiteralExpression(list)) continue;
      const members = list.elements.map(element => (ts.isSpreadElement(element) ? [unknown('spread')] : values(element)));
      if (members.every(found => found.every(value => value.text !== undefined))) return members.flat().map(value => value.text);
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
  /** Every identifier and member key of api/src by spelling, and the local names of renamed imports and exports. */
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
  /** The uses of `symbol` in api/src (a parameter's or a function-local's in its own file), declarations left out. */
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
  /** The values assigned to a binding after its declaration; a change that is not a plain assignment is unreadable. */
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
  /** The arguments every call of the parameter's function passes for it. */
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
    const tested = ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isExpressionStatement(parent)
      || (ts.isForStatement(parent) && parent.condition === node) || (ts.isConditionalExpression(parent) && parent.condition === node)
      || (ts.isPrefixUnaryExpression(parent) && parent.operator === K.ExclamationToken) || ts.isTypeOfExpression(parent)
      || ts.isVoidExpression(parent) || ts.isTypeQueryNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
      || ts.isImportClause(parent) || (ts.isBinaryExpression(parent) && EQUALITIES.has(parent.operatorToken.kind));
    if (!tested) escapes.push(`${where(parent)} (${K[parent.kind]})`);
  }

  // ── the writes ──
  const READS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);
  function record(node, via, found, action) {
    const unread = found.filter(value => value.text === undefined && !value.prefix);
    if (unread.length) {
      unrecognized.push(`${where(node)} ${via}: ${unread.map(value => value.unknown ?? value.why ?? `${where(value.fn)}: a function`).join('; ')}`);
      return;
    }
    const file = node.getSourceFile();
    const site = { file: repoPath(file.fileName), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, via,
      actions: found.filter(value => value.text !== undefined).map(value => value.text).sort(),
      prefixes: found.filter(value => value.prefix).map(value => value.prefix).sort() };
    Object.defineProperties(site, { call: { value: node }, action: { value: action },
      origins: { value: [...new Set(found.flatMap(value => value.from ?? []))] } });
    sites.push(site);
  }
  /** The property `name` an object literal ends up with: its last definition, unless a later spread may set it again. */
  function property(object, name) {
    let found = { why: 'is not set' };
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) found = { why: `may be set by the spread at ${where(member)}` };
      else if (member.name && ts.isComputedPropertyName(member.name) && keyText(member.name) === null) {
        found = { why: `may be set by the computed key at ${where(member)}` };
      } else if (keyText(member.name) === name) {
        found = ts.isPropertyAssignment(member) ? { node: member.initializer, member }
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
    record(call, 'auditLog.create', found, action);
  }
  function delegate(access) {
    const held = outer(access), method = held.parent;
    const name = method && method.expression === held ? keyOf(method) : null;
    const callee = name === null ? null : outer(method), call = callee?.parent;
    if (name === null || !call || !ts.isCallExpression(call) || call.expression !== callee) {
      unrecognized.push(`${where(access)} auditLog: used other than by calling one of its methods`);
    } else if (!READS.has(name)) {
      if (name === 'create') create(call);
      else unrecognized.push(`${where(access)} auditLog.${name}: writes rows this check does not read`);
    }
  }
  const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE)\s+(?:"?\w+"?\s*\.\s*)?"?AuditLog"?(?![\w"])/gi;
  const QUOTED = /(?<![\w'])'([^'\s\u0000]+)'(?![\w'])/g;
  const actionLike = value => /^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(value) || A.auditRule(value) !== 'hidden:unknown_action';
  /** A raw SQL text that writes "AuditLog": its one action-like value after INSERT INTO "AuditLog" (spans marked \0). */
  function rawSql(node) {
    const spans = ts.isTemplateExpression(node) ? node.templateSpans : [];
    const statement = (ts.isTemplateExpression(node) ? [node.head.text, ...spans.map(span => span.literal.text)] : [node.text]).join('\u0000');
    const writes = [...statement.matchAll(SQL_WRITE)];
    const spansBefore = at => statement.slice(0, at).split('\u0000').length - 1;
    writes.forEach((write, n) => {
      if (/^UPDATE/i.test(write[1])) { unrecognized.push(`${where(node)} raw SQL: updates "AuditLog" rows`); return; }
      const end = n + 1 < writes.length ? writes[n + 1].index : statement.length;
      const quoted = [...statement.slice(write.index, end).matchAll(QUOTED)].map(match => match[1]).filter(actionLike).map(value => text(value));
      const bound = spans.slice(spansBefore(write.index), spansBefore(end)).flatMap(span => values(span.expression))
        .filter(value => (value.text !== undefined ? actionLike(value.text) : !!value.prefix));
      const candidates = union(quoted, bound);
      if (candidates.length === 1) record(node, 'raw SQL INSERT INTO "AuditLog"', candidates);
      else {
        unrecognized.push(`${where(node)} raw SQL INSERT INTO "AuditLog": ${candidates.length} action-like values `
          + `(${candidates.map(value => value.text ?? `${value.prefix}…`).join(', ')}) where one is needed`);
      }
    });
  }
  function visit(node) {
    if (keyOf(node) === 'auditLog') delegate(node);
    else if (ts.isBindingElement(node) && keyText(node.propertyName ?? node.name) === 'auditLog') {
      unrecognized.push(`${where(node)} auditLog: the delegate is taken out of its client`);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) rawSql(node);
    ts.forEachChild(node, visit);
  }

  for (const file of files) {
    const broken = program.getSyntacticDiagnostics(file);
    if (broken.length) unrecognized.push(`${repoPath(file.fileName)} does not parse: ${ts.flattenDiagnosticMessageText(broken[0].messageText, ' ')}`);
    else visit(file);
  }
  const scan = { typescript: ts.version, sites, unrecognized };
  Object.defineProperties(scan, { tools: { value: { ts, bare, symbolAt, references } } });
  return scan;
}

/** The completeness verdict over one scan: throws at the first condition it does not meet. */
function assertComplete(scan) {
  assert.deepEqual(scan.unrecognized, [], 'every audit write site must have a readable action');
  const literals = new Set(scan.sites.flatMap(site => site.actions));
  const prefixes = new Set(scan.sites.flatMap(site => site.prefixes));
  const hiddenEntries = [...A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION, ...A.AUDIT_HIDDEN_CONNECT, ...A.AUDIT_HIDDEN_STUDY_SCOPED];
  const stems = hiddenEntries.filter(entry => entry.endsWith('*')).map(entry => entry.slice(0, -1));
  const unlisted = [...literals].filter(action => A.auditRule(action) === 'hidden:unknown_action').sort();
  assert.deepEqual(unlisted, [], 'an audit action written under api/src without a contract row');
  // A dynamic suffix cannot be listed one by one: whatever it becomes must fall under a hidden wildcard row (fail closed).
  assert.deepEqual([...prefixes].filter(start => !stems.some(stem => start.startsWith(stem))).sort(), [],
    'a dynamic audit action without a wildcard row');
  // The other direction: no contract row names an action nothing writes (a stale row would hide a renamed writer).
  const allowed = [...A.AUDIT_MEMBER_ACTIONS, ...Object.keys(A.AUDIT_FIELD_RULES), ...A.AUDIT_REPORT_COMMIT_ACTIONS.map(a => 'report.' + a)];
  const exactHidden = hiddenEntries.filter(entry => !entry.endsWith('*'));
  assert.deepEqual([...allowed, ...exactHidden].filter(action => !literals.has(action)), [], 'contract rows nothing writes');
  assert.deepEqual(stems.filter(stem => ![...literals, ...prefixes].some(action => action.startsWith(stem))), [],
    'wildcard rows nothing writes');
  return { literals, prefixes, unlisted };
}

/** What a scan read, by file: the actions and dynamic prefixes of its writes. */
function readActions(scan) {
  const byFile = {};
  for (const site of scan.sites) {
    const entry = byFile[site.file] ??= { actions: new Set(), prefixes: new Set() };
    site.actions.forEach(action => entry.actions.add(action));
    site.prefixes.forEach(start => entry.prefixes.add(start));
  }
  return Object.fromEntries(Object.keys(byFile).sort().map(file => [file, { actions: [...byFile[file].actions].sort(),
    prefixes: [...byFile[file].prefixes].sort() }]));
}

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
};

test('completeness: every audit action written under api/src has a contract row, and every row is written', () => {
  const scan = scanAuditWrites();
  const { literals, prefixes, unlisted } = assertComplete(scan);
  // The owner-only study-scoped records (the S5-U4a question, the S5-U4c image request, the S7-U1a critical result) are
  // each written, and their own rows keep them off the console whatever their detail names.
  for (const action of A.AUDIT_HIDDEN_STUDY_SCOPED) assert.ok(literals.has(action), action);
  const byRule = {};
  for (const action of literals) { const rule = A.auditRule(action).split(':')[0]; byRule[rule] = (byRule[rule] ?? 0) + 1; }
  console.log('ADMIN_AUDIT_COMPLETENESS ' + JSON.stringify({
    typescript: scan.typescript, write_sites: scan.sites.length, raw_sql_sites: scan.sites.filter(site => site.via.startsWith('raw')).length,
    distinct_actions: literals.size, dynamic_prefixes: [...prefixes].sort(), registered: literals.size - unlisted.length,
    by_rule: byRule, files: new Set(scan.sites.map(site => site.file)).size,
  }));
});

// The same writes in another notation read the same actions (Astra S7-U3a-C-R-001-F01: `action: (ACTION)` and
// `auditLog['create'](...)` of the reader assignment writes were refused by the former text scanner). The rewrites are
// made by position on what the compiler parsed, over every audit create of api/src, so no spelling of the product is
// assumed here.
test('completeness equivalents: every write of api/src rewritten in another notation reads the same actions', () => {
  const sources = auditSources(), base = scanAuditWrites(sources), expected = readActions(base);
  assertComplete(base);
  const { ts, bare, symbolAt, references } = base.tools;
  const creates = base.sites.filter(site => site.via === 'auditLog.create');
  assert.ok(creates.length > 0);
  const text = node => node.getSourceFile().text.slice(node.getStart(), node.end);
  const variants = {
    // `action: (x)` for every action, a shorthand `action` included.
    'the action in parentheses': edits => creates.forEach(site => {
      const node = site.action.node ?? site.action.shorthand;
      edit(edits, site.file, node.getStart(), node.end, site.action.node ? `(${text(node)})` : `${text(node)}: (${text(node)})`);
    }),
    // `x['auditLog']['create'](...)` for every `x.auditLog.create(...)`.
    'element access to the delegate and its create': edits => creates.forEach(site => {
      for (let access = bare(site.call.expression); access && (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access));
        access = bare(access.expression)) {
        const key = ts.isPropertyAccessExpression(access) ? access.name.text : null;
        if (key === 'create' || key === 'auditLog') edit(edits, site.file, access.expression.end, access.end, `['${key}']`);
        if (key === 'auditLog') break;
      }
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
  const counts = {};
  for (const [name, make] of Object.entries(variants)) {
    const edits = new Map();
    make(edits);
    counts[name] = [...edits.values()].reduce((sum, list) => sum + list.length, 0);
    assert.ok(counts[name] > 0, `${name} changes the source`);
    const scan = scanAuditWrites(edited(sources, edits));
    assert.deepEqual(scan.unrecognized, [], name);
    assert.deepEqual(readActions(scan), expected, name);
    assertComplete(scan);
  }
  console.log('ADMIN_AUDIT_EQUIVALENT_REWRITES ' + JSON.stringify(counts));
});

// A writer of api/src's own spelling is not needed to show how a notation reads: these synthetic files are added to the
// program next to it (in memory; nothing is written to disk).
const SYN_ACTIONS = "export const READER_ASSIGNMENT = 'reader.assignment';";
const SYN_EQUIVALENT = [
  "import { READER_ASSIGNMENT as MOVED } from './syn-audit-actions';",
  "import * as ACTIONS from './syn-audit-actions';",
  "const ACTION = 'reader.assignment' as const;",
  "const TABLE = { reader: { assignment: 'reader.assignment' } } as const;",
  "const READER = 'reader';",
  "enum Kind { Assignment = 'reader.assignment' }",
  'export class SynEquivalentWrites {',
  "  private static readonly FIELD = 'reader.assignment';",
  '  private audit(tx: any, actor: string, action: string, uid: string) {',
  '    return tx.auditLog.create({ data: { actor, action, target: uid } });',
  '  }',
  '  async write(tx: any, c: any, uid: string, body: any) {',
  '    await tx.auditLog.create({ data: { actor: c.actor, action: ACTION satisfies string, target: uid } });',
  '    await tx.auditLog.create({ data: { actor: c.actor, action: MOVED, target: uid } });',
  '    await tx.auditLog.create({ data: { actor: c.actor, action: ACTIONS.READER_ASSIGNMENT, target: uid } });',
  '    await tx.auditLog.create({ data: { actor: c.actor, action: TABLE.reader.assignment, target: uid } });',
  "    await tx.auditLog.create({ data: { actor: c.actor, action: TABLE['reader']['assignment'], target: uid } });",
  '    await tx.auditLog.create({ data: { actor: c.actor, action: `${READER}.assignment`, target: uid } });',
  "    await tx.auditLog.create({ data: { actor: c.actor, action: READER + '.' + 'assignment', target: uid } });",
  '    await tx.auditLog.create({ data: { actor: c.actor, action: Kind.Assignment, target: uid } });',
  '    await tx.auditLog.create({ data: { actor: c.actor, action: SynEquivalentWrites.FIELD, target: uid } });',
  '    await this.audit(tx, c.actor, ACTION, uid);',
  '    const local = (action: string) => tx.auditLog.create({ data: { actor: c.actor, action, target: uid } });',
  '    await local(MOVED);',
  "    let chosen = 'reader.assignment';",
  '    if (body.again) chosen = ACTION;',
  '    await tx.auditLog.create({ data: { actor: c.actor, action: chosen, target: uid } });',
  '    const kind = body.kind;',
  "    if (!body || !['reader.assignment'].includes(kind)) throw new Error('SYN unknown kind');",
  '    await tx.auditLog.create({ data: { actor: c.actor, action: kind, target: uid } });',
  "    await tx.$executeRaw`INSERT INTO \"AuditLog\" (actor, action, target) VALUES (${c.actor}, 'reader.assignment', ${uid})`;",
  '    await tx.$executeRaw`INSERT INTO "AuditLog" (actor, action, target) VALUES (${c.actor}, ${ACTION}, ${uid})`;',
  '  }',
  '}',
].join('\n');

test('completeness equivalents: constants moved, imported, aliased, tabled, typed, passed, assigned or checked read the same action', () => {
  const scan = scanAuditWrites([...auditSources(), { file: 'api/src/syn-audit-actions.ts', text: SYN_ACTIONS },
    { file: 'api/src/syn-equivalent-writes.ts', text: SYN_EQUIVALENT }]);
  assert.deepEqual(scan.unrecognized, []);
  const writes = scan.sites.filter(site => site.file === 'api/src/syn-equivalent-writes.ts');
  // Thirteen creates (one in the private helper, one in the local arrow) and two raw inserts, each read as the one action.
  assert.deepEqual(writes.map(site => [site.via, site.actions, site.prefixes]),
    [...Array(13).fill(['auditLog.create', ['reader.assignment'], []]), ...Array(2).fill(['raw SQL INSERT INTO "AuditLog"', ['reader.assignment'], []])]);
  assertComplete(scan);
});

const SYN_UNREADABLE = [   // [code, why the write on that line is unreadable (null: nothing to read there)]
  ["import { MISSING } from './syn-missing-module';", null],
  ["const MUTABLE = { reader: 'reader.assignment' };", null],
  'const SynHook = (): MethodDecorator => () => undefined;',
  'export class SynUnreadableWrites {',
  '  private writers: any[] = [];',
  ['  private audit(tx: any, action: string) { return tx.auditLog.create({ data: { action } }); }', 'is a property the program does not fix'],
  ['  private handed(tx: any, action: string) { return tx.auditLog.create({ data: { action } }); }', 'which is handed on at'],
  ['  @SynHook() private hooked(tx: any, action: string) { return tx.auditLog.create({ data: { action } }); }',
    'which callers outside this program can call'],
  '  async request(tx: any, body: any) {',
  ['    await tx.auditLog.create({ data: { action: body.kind } });', '`body.kind` is a property the program does not fix'],
  '    await this.audit(tx, body.kind);',
  "    let chosen = 'reader.assignment';",
  '    if (body.again) chosen = body.kind;',
  ['    await tx.auditLog.create({ data: { action: chosen } });', 'is a property the program does not fix'],
  '    const kind = body.kind;',
  "    if (!['reader.assignment'].includes(kind)) console.warn('SYN unknown kind');",
  ['    await tx.auditLog.create({ data: { action: kind } });', 'is a property the program does not fix'],
  ["    await tx.auditLog.create({ data: { action: String('reader.assignment') } });", 'is a CallExpression'],
  ['    await tx.auditLog.create({ data: { action: MISSING } });', '`MISSING` does not resolve'],
  ['    await tx.auditLog.create({ data: { action: MUTABLE.reader } });', 'is not `as const`'],
  ["    await tx.auditLog.create({ data: { action: 'reader.assignment', ...body.extra } });", 'may be set by the spread'],
  '    this.writers.push(this.handed);',
  ["    await tx.auditLog.createMany({ data: [{ action: 'reader.assignment' }] });", 'createMany: writes rows this check does not read'],
  ['    const log = tx.auditLog;', 'used other than by calling one of its methods'],
  ["    await log.create({ data: { action: 'reader.assignment' } });", null],
  ['    const { auditLog } = tx;', 'the delegate is taken out of its client'],
  ["    await tx.$executeRaw`INSERT INTO \"AuditLog\" (actor, action) SELECT actor, action FROM \"AuditLog\" WHERE action IN ('reader.assignment', 'study.access')`;",
    '2 action-like values'],
  ['    await tx.$executeRaw`INSERT INTO "AuditLog" (actor, action, target) VALUES (${body.actor}, ${body.kind}, ${body.uid})`;', '0 action-like values'],
  '  }',
  '  async write(tx: any, action: string) {',
  ['    await tx.auditLog.create({ data: { action } });', 'which callers outside this program can call'],
  '  }',
  '}',
].map(entry => (Array.isArray(entry) ? entry : [entry, null]));

test('completeness negative controls: an action the program does not fix, or a write this check cannot read, fails', () => {
  const FILE = 'api/src/syn-unreadable-writes.ts';
  const { scan, error } = completenessFailure([...auditSources(), { file: FILE, text: SYN_UNREADABLE.map(([code]) => code).join('\n') }]);
  assert.match(error.message, /^every audit write site must have a readable action/);
  const expected = SYN_UNREADABLE.flatMap(([, reason], i) => (reason ? [[i + 1, reason]] : []));
  const found = scan.unrecognized.filter(entry => entry.startsWith(FILE + ':'));
  assert.equal(found.length, expected.length, found.join('\n'));
  for (const [line, reason] of expected) {
    assert.ok(found.some(entry => entry.startsWith(`${FILE}:${line} `) && entry.includes(reason)), `line ${line}: ${reason}\n${found.join('\n')}`);
  }
  assert.deepEqual(scan.sites.filter(site => site.file === FILE), [], 'nothing of the file is read as a write');
  // Only the added file is unreadable: api/src as checked out reads in full.
  assert.deepEqual(scan.unrecognized.filter(entry => !entry.startsWith(FILE + ':')), []);
  // A source that does not parse is not read at all.
  const broken = completenessFailure([...auditSources(), { file: 'api/src/syn-broken.ts', text: 'export const = ;' }]);
  assert.deepEqual(broken.error.actual.map(entry => entry.split(' does not parse')[0]), ['api/src/syn-broken.ts']);
});

/** The scan of `sources` and the completeness error it must give. */
function completenessFailure(sources) {
  const scan = scanAuditWrites(sources);
  try {
    assertComplete(scan);
  } catch (error) {
    return { scan, error };
  }
  assert.fail('the completeness check passed');
}

test('completeness negative controls: unlisted, dynamic without a wildcard and unwritten actions fail', () => {
  const sources = auditSources(), base = scanAuditWrites(sources), { ts } = base.tools;
  const UNLISTED = /^an audit action written under api\/src without a contract row/;
  // (a) A new write of an action without a row, as a literal, as a constant and as raw SQL.
  const added = completenessFailure([...sources, { file: 'api/src/syn-unlisted.service.ts', text: [
    "export const SYN_UNLISTED_ACTION = 'syn.unlisted';",
    'export class SynUnlistedService {',
    '  async write(tx: any, c: any, uid: string) {',
    "    await tx.auditLog.create({ data: { actor: c.actor, action: 'study.question.reply', target: uid } });",
    '    await tx.auditLog.create({ data: { actor: c.actor, action: SYN_UNLISTED_ACTION, target: uid } });',
    "    await tx.$executeRaw`INSERT INTO \"AuditLog\" (actor, action, target) VALUES (${c.actor}, 'syn.raw-unlisted', ${uid})`;",
    '  }',
    '}',
  ].join('\n') }]);
  assert.match(added.error.message, UNLISTED);
  assert.deepEqual(added.error.actual, ['study.question.reply', 'syn.raw-unlisted', 'syn.unlisted']);
  // (b) The values existing writes take change to values without a row: every literal an action of api/src is read from,
  // wherever the compiler found it (a constant, a helper's argument, the create itself), gets '.v2' (unless a wildcard row
  // would still cover it). Each is then read, through the same constants, helpers and callbacks, as unlisted.
  const origins = [...new Set(base.sites.flatMap(site => site.origins))]
    .filter(origin => A.auditRule(origin.text + '.v2') === 'hidden:unknown_action');
  assert.ok(origins.length > 0, 'actions of api/src are read from literals');
  const revalued = new Map();
  for (const origin of origins) {
    const quote = origin.getText()[0];
    edit(revalued, repoPath(origin.getSourceFile().fileName), origin.getStart(), origin.end, `${quote}${origin.text}.v2${quote}`);
  }
  const changed = completenessFailure(edited(sources, revalued));
  assert.match(changed.error.message, UNLISTED);
  assert.deepEqual(changed.error.actual, [...new Set(origins.map(origin => origin.text + '.v2'))].sort());
  assert.ok(changed.error.actual.includes('reader.assignment.v2'), 'the reader assignment writes are among them');
  // (c) A dynamic suffix no hidden wildcard row covers.
  const dynamic = completenessFailure([...sources, { file: 'api/src/syn-dynamic.service.ts', text: [
    'export class SynDynamicService {',
    "  async write(tx: any, body: any) { await tx.auditLog.create({ data: { action: 'reader.' + body.kind } }); }",
    '}',
  ].join('\n') }]);
  assert.match(dynamic.error.message, /^a dynamic audit action without a wildcard row/);
  assert.deepEqual(dynamic.error.actual, ['reader.']);
  // (d) A contract row nothing writes: every write of reader.assignment is taken out (`void 0` in its place).
  const removed = new Map();
  for (const site of base.sites.filter(site => site.actions.includes('reader.assignment'))) {
    const write = ts.isTaggedTemplateExpression(site.call.parent) ? site.call.parent : site.call;
    edit(removed, site.file, write.getStart(), write.end, 'void 0');
  }
  const unwritten = completenessFailure(edited(sources, removed));
  assert.match(unwritten.error.message, /^contract rows nothing writes/);
  assert.deepEqual(unwritten.error.actual, ['reader.assignment']);
});
