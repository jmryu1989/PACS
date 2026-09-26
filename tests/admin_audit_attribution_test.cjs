'use strict';
/* TEST-S5-U5b-PURE: the admin audit attribution rule (api/src/admin-audit.ts).
 * REQ-S5-U5b-ADMIN-AUDIT / MOVE-PROJECTION / UNCLEAR-HIDDEN / NO-MIGRATION-START
 *   -> RISK-S5-U5b-CROSS-INSTITUTION / CURRENT-GROUP-ATTRIBUTION / CURRENT-OWNER-ATTRIBUTION / HIDDEN-COUNT /
 *      NEW-ACTION-DEFAULT / INVENTED-FIELDS / FAILURE-AS-EMPTY.
 *
 *  - the 30 synthetic vectors of the stage5 S5-U5b card (audit_attribution_contract, run 30): record-time readers and
 *    withheld sides per row, over synthetic AuditLog rows shaped like the real writers;
 *  - the rejected current-group / current-owner rule as a negative control: it leaks exactly the card's rows;
 *  - unclear rows, the page read (filtering before paging, totals and continuations over visible rows only, a failed
 *    source never an empty page), the sealed continuation and the query shape;
 *  - completeness: every audit action written under api/src has a contract row (an unlisted action fails), and every
 *    contract row is written somewhere.
 *
 * Module: KIN_ADMIN_AUDIT_MODULE, default api/src/admin-audit.ts loaded through Node type stripping (Node >= 22.18);
 * the compiled /app/dist/admin-audit (kin-api:ci) is the same rule. The completeness scan reads api/src itself, so the
 * repository must be mounted. Synthetic data only: no network, database, credentials or clinical data.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

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
  assert.deepEqual(json(A.AUDIT_MEMBER_SNAPSHOT_FIELDS), CONTRACT.member_snapshot_fields_projected);
  assert.equal(CONTRACT.member_email_projected, false);
  assert.ok(!A.AUDIT_MEMBER_SNAPSHOT_FIELDS.includes('email'));
  for (const list of [A.AUDIT_MEMBER_ACTIONS, A.AUDIT_REPORT_COMMIT_ACTIONS, A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION,
    A.AUDIT_HIDDEN_CONNECT, A.AUDIT_MEMBER_SNAPSHOT_FIELDS, A.AUDIT_CANDIDATE_ACTIONS, A.AUDIT_TARGET_ACTIONS])
    assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(A.AUDIT_FIELD_RULES));
  // Every allowed action resolves to its own rule, never to a hidden wildcard, and the candidate list is exactly them.
  const allowed = [...A.AUDIT_MEMBER_ACTIONS, ...Object.keys(A.AUDIT_FIELD_RULES), ...A.AUDIT_REPORT_COMMIT_ACTIONS.map(a => 'report.' + a)];
  assert.deepEqual([...A.AUDIT_CANDIDATE_ACTIONS].sort(), [...new Set(allowed)].sort());
  for (const action of allowed) assert.doesNotMatch(A.auditRule(action), /^hidden:/, action);
  const hiddenEntries = [...A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION, ...A.AUDIT_HIDDEN_CONNECT];
  for (const entry of hiddenEntries) {
    const covers = action => entry.endsWith('*') ? action.startsWith(entry.slice(0, -1)) : action === entry;
    assert.deepEqual(allowed.filter(covers), [], `${entry} shadows an allowed action`);
  }
  assert.deepEqual(json(A.AUDIT_TARGET_ACTIONS), ['hanging-protocol.site.save', 'hanging-protocol.site.reset']);
  // Fail closed: unknown, near-miss and non-string actions are hidden.
  assert.equal(CONTRACT.default, 'hidden:unknown_action (fail closed)');
  for (const action of ['future.action', 'Match', 'match ', 'report.sign', 'report.', 'admin.user.delete', 'study.question',
    'study.image-request', 'hanging-protocol.site', '', null, undefined, 7, {}])
    assert.equal(A.auditRule(action), 'hidden:unknown_action', String(action));
});

test('the 30 synthetic vectors: record-time readers and withheld sides per row', () => {
  assert.equal(CONTRACT.synthetic_vectors.length, 30);
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
  assert.deepEqual(A.openAuditCursor(key, owner, token, now + 1000), { top: 987654, after: 912345 });
  const bytes = Buffer.from(token, 'base64url').toString('latin1');
  for (const plainText of ['987654', '912345', '"after"', '"top"', 'inst-a']) assert.ok(!bytes.includes(plainText), plainText);
  assert.notEqual(A.sealAuditCursor(key, owner, { top: 987654, after: 912345 }, now), token, 'a fresh IV each time');
  const raw = Buffer.from(token, 'base64url');
  const flipped = Buffer.from(raw); flipped[raw.length - 1] ^= 1;
  const refused = {
    'another institution': A.openAuditCursor(key, ['inst-b', owner[1]], token, now),
    'another admin': A.openAuditCursor(key, [owner[0], '00000000-0000-4000-8000-0000000000bb'], token, now),
    'another key (restart)': A.openAuditCursor(randomBytes(32), owner, token, now),
    'expired': A.openAuditCursor(key, owner, token, now + A.AUDIT_CURSOR_TTL_MS),
    'tampered': A.openAuditCursor(key, owner, flipped.toString('base64url'), now),
    'truncated': A.openAuditCursor(key, owner, token.slice(0, 30), now),
    'non-canonical base64': A.openAuditCursor(key, owner, token + '=', now),
    'a readable row id': A.openAuditCursor(key, owner, '912345', now),
    'too long': A.openAuditCursor(key, owner, 'A'.repeat(A.AUDIT_CURSOR_MAX + 1), now),
    'not a string': A.openAuditCursor(key, owner, 912345, now),
  };
  for (const [name, value] of Object.entries(refused)) assert.equal(value, null, name);
  const outOfRange = A.sealAuditCursor(key, owner, { top: 5, after: 6 }, now);
  assert.equal(A.openAuditCursor(key, owner, outOfRange, now), null, 'after beyond the pinned top');
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

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? tsFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}
const SOURCES = tsFiles(path.join(ROOT, 'api', 'src')).sort().map(file => ({
  file: path.relative(ROOT, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n') }));

function skipQuoted(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i;
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') { i = matching(text, i + 1); if (i < 0) break; }
    else if (quote !== '`' && text[i] === '\n') break;
  }
  throw new Error(`unterminated string at ${start}`);
}
/** Index of the bracket that closes text[open]; strings and templates are skipped. */
function matching(text, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' }, stack = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(text, i); continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') { if (stack.pop() !== ch) return -1; if (!stack.length) return i; }
  }
  return -1;
}
function splitTop(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(text, i); continue; }
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
/** One action expression: a literal, a literal + ternary of two literals, a literal prefix + variable, a template. */
function actionOf(expression) {
  let m;
  if ((m = /^'([^'\\]+)'$/.exec(expression)) || (m = /^"([^"\\]+)"$/.exec(expression))) return { kind: 'literal', actions: [m[1]] };
  if ((m = /^'([^'\\]+)'\s*\+\s*\(\s*[^?]+\?\s*'([^'\\]+)'\s*:\s*'([^'\\]+)'\s*\)$/.exec(expression)))
    return { kind: 'literal', actions: [m[1] + m[2], m[1] + m[3]] };
  if ((m = /^'([^'\\]+)'\s*\+\s*[\w.]+$/.exec(expression))) return { kind: 'prefix', prefix: m[1] };
  if ((m = /^`([^`$\\]+)\$\{(\w+)\}`$/.exec(expression))) return { kind: 'template', prefix: m[1], variable: m[2] };
  return null;
}
const line = (text, index) => text.slice(0, index).split('\n').length;
function methodBefore(text, index) {
  const start = text.lastIndexOf('\n  async ', index);
  if (start < 0) throw new Error('no enclosing method');
  return text.slice(start, index);
}
/** The values a template's variable takes, read from the method that writes it. A template without one fails. */
const EXPANSIONS = {
  'api/src/admin.service.ts admin.user.': (text, index) => {
    const values = new Set();
    for (const [, rhs] of methodBefore(text, index).matchAll(/\baction\s*=(?!=)\s*([^;\n]+)/g)) {
      const branches = rhs.includes('?') ? rhs.slice(rhs.indexOf('?') + 1) : rhs;
      for (const [, value] of branches.matchAll(/'([^']+)'/g)) values.add(value);
    }
    return [...values];
  },
  'api/src/pacs.service.ts report.': (text, index) => {
    const m = /\[([^\]]+)\]\.includes\(action\)/.exec(methodBefore(text, index));
    if (!m) throw new Error('commitReport action list not found');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  },
};
const READS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);

/**
 * The audit helpers a file defines, by parameter list: `private audit(...)` (called as this.audit) and the local ones
 * called bare (`const audit = (...) =>`, and scopeWrite's `audit:(...)=>` callback type). A callback typed
 * `audit: ((...) => ...)` hands over a whole write and is not a helper with an action parameter.
 */
function auditHelpers(text) {
  const helpers = [];
  for (const m of text.matchAll(/(private\s+audit\s*|const\s+audit\s*=\s*|\baudit\s*:\s*)\((?!\()/g)) {
    const open = m.index + m[0].length - 1, close = matching(text, open);
    const params = splitTop(text.slice(open + 1, close)).map(param => {
      const name = /^(\w+)(\?)?/.exec(param);
      return { name: name?.[1], optional: !!name?.[2] || param.includes('=') };
    });
    helpers.push({ self: m[1].startsWith('private'), action: params.findIndex(p => p.name === 'action'),
      min: params.filter(p => !p.optional).length, max: params.length });
  }
  return helpers;
}

function scanAuditWrites() {
  const sites = [], helpers = [], callbacks = [], handlers = [], unrecognized = [];
  const add = (file, text, index, form, parsed) => {
    if (!parsed) { unrecognized.push(`${file}:${line(text, index)} ${form}`); return; }
    if (parsed.kind === 'template') {
      const expand = EXPANSIONS[`${file} ${parsed.prefix}`];
      if (!expand) { unrecognized.push(`${file}:${line(text, index)} template ${parsed.prefix}\${${parsed.variable}}`); return; }
      parsed = { kind: 'literal', actions: expand(text, index).map(value => parsed.prefix + value), template: parsed.prefix };
    }
    sites.push({ file, line: line(text, index), form, ...parsed });
  };
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(/\bauditLog\s*\.\s*(\w+)\s*\(/g)) {
      if (READS.has(m[1])) continue;
      if (m[1] !== 'create') { unrecognized.push(`${file}:${line(text, m.index)} auditLog.${m[1]}`); continue; }
      const open = m.index + m[0].length - 1, close = matching(text, open);
      const data = /\bdata\s*:\s*\{/.exec(text.slice(open, close));
      if (close < 0 || !data) { unrecognized.push(`${file}:${line(text, m.index)} auditLog.create without data`); continue; }
      const dataOpen = open + data.index + data[0].length - 1;
      const property = splitTop(text.slice(dataOpen + 1, matching(text, dataOpen)))
        .map(part => /^action\s*(?::\s*([\s\S]+))?$/.exec(part)).find(Boolean);
      if (!property) { unrecognized.push(`${file}:${line(text, m.index)} auditLog.create without action`); continue; }
      if (property[1] === undefined || property[1].trim() === 'action') { helpers.push(`${file}:${line(text, m.index)}`); continue; }
      add(file, text, m.index, 'auditLog.create', actionOf(property[1].trim()));
    }
    for (const m of text.matchAll(/INSERT\s+INTO\s+"AuditLog"\s*\(([^)]*)\)\s*(SELECT|VALUES)/gi)) {
      const columns = m[1].split(',').map(c => c.trim().replace(/"/g, ''));
      let rest = text.slice(m.index + m[0].length);
      rest = rest.slice(0, rest.indexOf('`'));
      if (m[2].toUpperCase() === 'VALUES') rest = rest.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
      else rest = rest.split(/\bFROM\b/)[0];
      const values = splitTop(rest);
      add(file, text, m.index, 'raw INSERT', values.length === columns.length ? actionOf(values[columns.indexOf('action')]) : null);
    }
    const defined = auditHelpers(text);
    for (const m of text.matchAll(/(?<![\w.$])(this\.)?audit\s*\(/g)) {
      const open = m.index + m[0].length - 1, close = matching(text, open);
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(?:private|protected|public)\s+(?:async\s+)?$/.test(text.slice(lineStart, m.index))) continue;   // helper method definition
      const args = splitTop(text.slice(open + 1, close));
      if (args[0]?.startsWith('@')) { handlers.push(`${file}:${line(text, m.index)}`); continue; }      // controller handler
      const call = text.slice(m.index, close + 1);
      // A call with no literal or template at all hands over a prepared write (the site hanging-protocol callback).
      if (!args.some(actionOf)) { callbacks.push({ file, line: line(text, m.index), call }); continue; }
      // Otherwise the action is the argument at the helper's `action` position (the actor can be a literal too).
      const positions = [...new Set(defined.filter(h => h.self === !!m[1] && h.action >= 0 && h.min <= args.length && args.length <= h.max)
        .map(h => h.action))];
      add(file, text, m.index, call, positions.length === 1 ? actionOf(args[positions[0]] ?? '') : null);
    }
  }
  return { sites, helpers, callbacks, handlers, unrecognized };
}

test('completeness: every audit action written under api/src has a contract row, and every row is written', () => {
  const scan = scanAuditWrites();
  assert.deepEqual(scan.unrecognized, [], 'every audit write site must have a readable action');
  // The one literal-free helper call is the site hanging-protocol callback; its action is the auditLog.create it wraps.
  assert.deepEqual(scan.callbacks.map(c => [c.file, c.call]), [['api/src/pacs.service.ts', 'audit(tx, row)']]);
  assert.deepEqual(scan.handlers.map(h => h.split(':')[0]), ['api/src/pacs.controller.ts'], 'only the study-scoped GET audit handler');
  const literals = new Set(scan.sites.flatMap(site => site.kind === 'literal' ? site.actions : []));
  const prefixes = new Set(scan.sites.filter(site => site.kind === 'prefix').map(site => site.prefix));
  const hiddenEntries = [...A.AUDIT_HIDDEN_NO_RECORD_TIME_INSTITUTION, ...A.AUDIT_HIDDEN_CONNECT];
  const unlisted = [...literals].filter(action => A.auditRule(action) === 'hidden:unknown_action');
  assert.deepEqual(unlisted, [], 'an audit action written under api/src without a contract row');
  // A dynamic suffix cannot be listed one by one: its whole prefix must be a hidden wildcard (fail closed).
  for (const prefix of prefixes) assert.ok(hiddenEntries.includes(prefix + '*'), `dynamic action ${prefix}* has no wildcard row`);
  // Templates expand to exactly the table's member and report actions.
  const template = prefix => [...new Set(scan.sites.filter(s => s.template === prefix).flatMap(s => s.actions))].sort();
  assert.deepEqual(template('report.'), [...A.AUDIT_REPORT_COMMIT_ACTIONS].map(a => 'report.' + a).sort());
  assert.deepEqual(template('admin.user.'), ['admin.user.activate', 'admin.user.approve', 'admin.user.suspend',
    'admin.user.unapprove', 'admin.user.update']);
  // The other direction: no contract row names an action nothing writes (a stale row would hide a renamed writer).
  const allowed = [...A.AUDIT_MEMBER_ACTIONS, ...Object.keys(A.AUDIT_FIELD_RULES), ...A.AUDIT_REPORT_COMMIT_ACTIONS.map(a => 'report.' + a)];
  const exactHidden = hiddenEntries.filter(entry => !entry.endsWith('*'));
  assert.deepEqual([...allowed, ...exactHidden].filter(action => !literals.has(action)), [], 'contract rows nothing writes');
  assert.deepEqual(hiddenEntries.filter(entry => entry.endsWith('*')).map(entry => entry.slice(0, -1)).filter(p => !prefixes.has(p)), [],
    'wildcard rows without a dynamic writer');
  const byRule = {};
  for (const action of literals) { const rule = A.auditRule(action).split(':')[0]; byRule[rule] = (byRule[rule] ?? 0) + 1; }
  console.log('ADMIN_AUDIT_COMPLETENESS ' + JSON.stringify({
    write_sites: scan.sites.length, helper_definitions: scan.helpers.length, callback_invocations: scan.callbacks.length,
    distinct_actions: literals.size, dynamic_prefixes: [...prefixes].sort(), registered: literals.size - unlisted.length,
    by_rule: byRule, files: [...new Set(scan.sites.map(s => s.file))].length,
  }));
});
