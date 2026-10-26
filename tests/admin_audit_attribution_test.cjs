'use strict';
/* Audit attribution and paging behavior over synthetic rows.
 * Actual producer writes are covered by fixtures/admin-audit-checker/recorded-boundaries.cjs and
 * reader_assignment_scope_test.cjs; source spelling is not an audit contract. */
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
/* S7-U5 (TEST-S7-U5-ATTRIBUTION AT-01..AT-02, D7): the access-record rows auth.login, auth.logout and auth.session.expired
 * are attributed to the institution they recorded at the event - the token's one group then (the verified token at login,
 * the stored token of the session that ended), never the member's group now. Vectors 32-41 continue the numbering; the
 * card block above stays verbatim. */
const AUTH_MEANING = "record-time institution from the token groups at the event";
CONTRACT.field_rules['viewer-context.event'] = {source:'detail.institution',meaning:'verified viewer actor institution at event receipt'};
Object.assign(CONTRACT.field_rules, {"auth.login":{"source":"detail.institution","meaning":AUTH_MEANING},
  "auth.logout":{"source":"detail.institution","meaning":AUTH_MEANING},
  "auth.session.expired":{"source":"detail.institution","meaning":AUTH_MEANING},
  // S7-U5 (U5S-REQ-09): the entry of a login by its single-use proof, recorded from the stored token of that session.
  "auth.entry":{"source":"detail.institution","meaning":AUTH_MEANING}});
CONTRACT.synthetic_vectors.push(
  {"row":32,"action":"auth.login","rule":"field:detail.institution","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"m logs in while in A"},
  {"row":33,"action":"auth.logout","rule":"field:detail.institution","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"m logs out while in A"},
  {"row":34,"action":"auth.session.expired","rule":"field:detail.institution","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"m's B-era session ends idle"},
  {"row":35,"action":"auth.session.expired","rule":"field:detail.institution","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"m2's B session swept: no request, ip null"},
  {"row":36,"action":"auth.session.expired","rule":"field:detail.institution","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"m3's A session ends on a refused refresh"},
  {"row":37,"action":"auth.logout","rule":"field:detail.institution","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"m's B session ends by an account switch"},
  {"row":38,"action":"auth.login","rule":"field:detail.institution","record_time_visible_to":[],"withheld_sides":{},"note":"failed login, identity unknown: no institution"},
  {"row":39,"action":"auth.login","rule":"field:detail.institution","record_time_visible_to":[],"withheld_sides":{},"note":"PENDING member (no group): no institution"},
  {"row":40,"action":"auth.login","rule":"field:detail.institution","record_time_visible_to":[],"withheld_sides":{},"note":"two groups (INVALID): no single institution"},
  {"row":41,"action":"auth.login","rule":"field:detail.institution","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"m3's session could not be stored: failure row with the verified A identity"});
/* S9-U4b (contract S9-U4p 4.9, U4P4-02): the seven self-institution import / original download actions are attributed to
 * the institution they recorded, detail.institutionId = the operation's ImportOperation.institutionId (the verified session
 * institution of the member who opened it; for a recovery the operation's, which the admin's own must equal). Vectors
 * 42-50 continue the numbering; the card block above stays verbatim. */
const IMPORT_MEANING = "record-time institution of the operation (ImportOperation.institutionId)";
Object.assign(CONTRACT.field_rules, {"dicom.import.intent":{"source":"detail.institutionId","meaning":IMPORT_MEANING},
  "dicom.import.result":{"source":"detail.institutionId","meaning":IMPORT_MEANING},
  "dicom.import.recovery.request":{"source":"detail.institutionId","meaning":IMPORT_MEANING},
  "dicom.import.recovery.result":{"source":"detail.institutionId","meaning":IMPORT_MEANING},
  "original.download.prepare":{"source":"detail.institutionId","meaning":IMPORT_MEANING},
  "original.download.intent":{"source":"detail.institutionId","meaning":IMPORT_MEANING},
  "original.download.result":{"source":"detail.institutionId","meaning":IMPORT_MEANING}});
// D1489: the archive grant's issue/refusal row is attributed the same way (vectors 51-52).
CONTRACT.field_rules["original.download.grant"] = {"source":"detail.institutionId","meaning":IMPORT_MEANING};
CONTRACT.synthetic_vectors.push(
  {"row":42,"action":"dicom.import.intent","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A member's import intent"},
  {"row":43,"action":"dicom.import.result","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A's unconfirmed file result: the admin finds operationId and index"},
  {"row":44,"action":"dicom.import.result","rule":"field:detail.institutionId","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"B's file result, never A's"},
  {"row":45,"action":"dicom.import.recovery.request","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A admin's recovery request"},
  {"row":46,"action":"dicom.import.recovery.result","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A admin's recovery result"},
  {"row":47,"action":"original.download.prepare","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A member's download preparation"},
  {"row":48,"action":"original.download.intent","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A member's archive intent"},
  {"row":49,"action":"original.download.result","rule":"field:detail.institutionId","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"B member's archive result"},
  {"row":50,"action":"dicom.import.result","rule":"field:detail.institutionId","record_time_visible_to":[],"withheld_sides":{},"note":"no institutionId recorded although the actor is an A member: no_institution_recorded, nobody sees it"},
  {"row":51,"action":"original.download.grant","rule":"field:detail.institutionId","record_time_visible_to":["inst-a"],"withheld_sides":{"inst-a":[]},"note":"A member's archive grant issued (D1489)"},
  {"row":52,"action":"original.download.grant","rule":"field:detail.institutionId","record_time_visible_to":["inst-b"],"withheld_sides":{"inst-b":[]},"note":"B member's archive grant refused, never A's"});

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
// S7-U5: auth.service.ts writes {institution, ip, dataSubject: null, outcome[, cause]} (login) or {institution, ip,
// dataSubject: null, cause} (logout, expiry); target is the account id, actor its login identity.
const authDetail = (institution, rest, ip = '198.51.100.7') => ({ institution, ip, dataSubject: null, ...rest });
for (const r of [
  row(32, 'auth.login', M, authDetail('inst-a', { outcome: 'success' }), 'syn-m-login@synthetic.test'),
  row(33, 'auth.logout', M, authDetail('inst-a', { cause: 'logout' }), 'syn-m-login@synthetic.test'),
  row(34, 'auth.session.expired', M, authDetail('inst-b', { cause: 'idle' }), 'syn-m-login@synthetic.test'),
  row(35, 'auth.session.expired', M2, authDetail('inst-b', { cause: 'sweep' }, null), 'syn-m2-login@synthetic.test'),
  row(36, 'auth.session.expired', M3, authDetail('inst-a', { cause: 'refresh_failed' }), 'syn-m3-login@synthetic.test'),
  row(37, 'auth.logout', M, authDetail('inst-b', { cause: 'account_switch' }), 'syn-m-login@synthetic.test'),
  row(38, 'auth.login', '', authDetail(null, { outcome: 'failure', cause: 'provider_error' }), 'unknown'),
  row(39, 'auth.login', MP, authDetail(null, { outcome: 'success' }), 'syn-mp-login@synthetic.test'),
  row(40, 'auth.login', MX, authDetail(null, { outcome: 'success' }), 'syn-mx-login@synthetic.test'),
  row(41, 'auth.login', M3, authDetail('inst-a', { outcome: 'failure', cause: 'session_failed' }), 'syn-m3-login@synthetic.test'),
]) ROWS.set(r.id, r);
// S9-U4b: dicom-import-gate.service.ts and study-transfer-local.service.ts write these details (UIDs, hashes, ids and
// outcomes; never a patient value); target is the Study UID, actor the member (or the admin for a recovery).
const OP_A = '00000000-0000-4000-8000-0000000004a1', OP_B = '00000000-0000-4000-8000-0000000004b1', ATT = '00000000-0000-4000-8000-0000000004c1';
const importDetail = (institutionId, rest = {}) => ({ institutionId, operationId: institutionId === 'inst-b' ? OP_B : OP_A, index: 3, attemptId: ATT,
  generation: 1, kind: 'import', actor: 'syn-tech-a@members.test', ownerIssuer: 'https://synthetic.test/realms/kin', ownerSubject: 'syn-tech-a-sub',
  studyUid: S1, seriesUid: S1 + '.1', sopUid: S1 + '.1.1', sha256: 'a'.repeat(64), bytes: 2048, at: '2026-10-15T00:00:00.000Z', ...rest });
const downloadDetail = (institutionId, rest = {}) => ({ institutionId, operationId: institutionId === 'inst-b' ? OP_B : OP_A, manifestSha256: 'b'.repeat(64),
  ownerIssuer: 'https://synthetic.test/realms/kin', ownerSubject: 'syn-rad-sub', at: '2026-10-15T00:00:00.000Z', ...rest });
for (const r of [
  row(42, 'dicom.import.intent', S1, importDetail('inst-a'), 'syn-tech-a@members.test'),
  row(43, 'dicom.import.result', S1, importDetail('inst-a', { outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', writeDisposition: null, transport: 'unknown' }), 'syn-tech-a@members.test'),
  row(44, 'dicom.import.result', S2, importDetail('inst-b', { studyUid: S2, outcome: 'stored', code: null, writeDisposition: null, transport: null }), 'syn-tech-b@members.test'),
  row(45, 'dicom.import.recovery.request', S1, { institutionId: 'inst-a', operationId: OP_A, index: 3, attemptId: ATT, generation: 1, basis: 'orthanc-restarted',
    checkedAt: '2026-10-15T00:00:00.000Z', adminIssuer: 'https://synthetic.test/realms/kin', adminSubject: 'syn-admin-a-sub', at: '2026-10-15T00:01:00.000Z' }, 'syn-admin-a@members.test'),
  row(46, 'dicom.import.recovery.result', S1, { institutionId: 'inst-a', operationId: OP_A, index: 3, attemptId: ATT, generation: 1, basis: 'orthanc-restarted',
    checkedAt: '2026-10-15T00:00:00.000Z', adminIssuer: 'https://synthetic.test/realms/kin', adminSubject: 'syn-admin-a-sub', outcome: 'retryable',
    code: 'RECOVERED_NO_OBJECT', at: '2026-10-15T00:01:01.000Z' }, 'syn-admin-a@members.test'),
  row(47, 'original.download.prepare', S1, downloadDetail('inst-a', { studyUid: S1, objects: 3, bytes: 6144 }), 'syn-rad-a@members.test'),
  row(48, 'original.download.intent', S1, downloadDetail('inst-a', { attemptId: ATT, number: 1 }), 'syn-rad-a@members.test'),
  row(49, 'original.download.result', S2, downloadDetail('inst-b', { attemptId: ATT, state: 'sent', archiveSha256: 'c'.repeat(64), responseFinished: true,
    reason: null, objects: [{ sopUid: S2 + '.1.1', sha256: 'd'.repeat(64), bytesSupplied: 2048, complete: true }] }), 'syn-rad-b@members.test'),
  row(50, 'dicom.import.result', S1, (({ institutionId, ...rest }) => ({ ...rest, outcome: 'stored', code: null }))(importDetail('inst-a')), 'syn-tech-a@members.test'),
  row(51, 'original.download.grant', S1, downloadDetail('inst-a', { phase: 'issued', studyUid: S1, grantId: ATT, grantHash: 'e'.repeat(64), sessionRef: 'ref-synthetic',
    issuedAt: '2026-10-15T00:00:00.000Z', expiresAt: '2026-10-15T00:02:00.000Z', replacedGrantId: null, authMethod: 'session', bindingMethod: 'session-header' }), 'syn-rad-a@members.test'),
  row(52, 'original.download.grant', S2, downloadDetail('inst-b', { phase: 'refused', studyUid: S2, grantId: ATT, grantHash: 'f'.repeat(64), sessionRef: 'ref-synthetic-b',
    code: 'MANIFEST_CHANGED', authMethod: 'session', bindingMethod: 'archive-grant' }), 'syn-rad-b@members.test'),
]) ROWS.set(r.id, r);

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
  // 31 = the card's 30, unchanged, and the study.question row added with its contract row (Astra S5-U5b-D-F02); 32-41
  // are the S7-U5 access-record rows (AT-02); 42-50 the S9-U4b import/download rows (contract S9-U4p 4.9).
  // 51-52: the D1489 archive grant rows.
  assert.equal(CONTRACT.synthetic_vectors.length, 52);
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

test('S9-U4b import/download rows: the admin finds operationId and index; a row without institutionId reaches nobody; eight more candidates (D1489 the grant)', () => {
  const unconfirmed = A.projectAuditRow(ROWS.get(43), 'inst-a');
  assert.deepEqual([unconfirmed.detail.operationId, unconfirmed.detail.index, unconfirmed.detail.attemptId, unconfirmed.detail.outcome],
    [OP_A, 3, ATT, 'unconfirmed']);
  assert.equal(A.projectAuditRow(ROWS.get(43), 'inst-b'), null);
  assert.equal(A.attributeAuditRow(ROWS.get(50)).hidden, 'no_institution_recorded');
  const seven = ['dicom.import.intent', 'dicom.import.result', 'dicom.import.recovery.request', 'dicom.import.recovery.result',
    'original.download.prepare', 'original.download.grant', 'original.download.intent', 'original.download.result'];
  for (const action of seven) assert.equal(A.auditRule(action), 'field:detail.institutionId', action);
  assert.deepEqual(A.AUDIT_CANDIDATE_ACTIONS.filter(action => /^(dicom\.import|original\.download)\./.test(action)).sort(), [...seven].sort());
  // Not one of them is widened by a hidden wildcard or a neighbouring name.
  for (const near of ['dicom.import', 'dicom.import.recovery', 'original.download', 'dicom.import.result.extra', 'original.download.grant.issued']) assert.equal(A.auditRule(near), 'hidden:unknown_action', near);
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
  // An access-record row (S7-U5) names its account as target, like a member row: the rejected rule hands it to that
  // account's group now.
  if (source.action.startsWith('admin.user.') || source.action === 'study.access' || source.action.startsWith('auth.')) {
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

// ── S7-U1c (TEST-S7-U1c-AUDIT TA01..TA03, scenario TA-03): the study.critical-result rows of a tele record name two
// record-time institutions (detail.institution = the owner A, detail.senderInstitution = the tele sender B; contract
// S7-U1p section 11). The Members console shows them to no institution: the action keeps its hidden owner-only
// study-scoped row (section 11.2, OP-2 a), whatever the detail names. The rows are shaped like the service's writeAudit.
const crId = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const CR_KEYS = ['event', 'from', 'id', 'institution', 'recipient', 'replacedBy', 'requestId', 'revision', 'role', 'senderInstitution',
  'source', 'supersedes', 'to'];
const crRow = (n, event, from, to, revision, actor, role, extra = {}) => row(40 + n, 'study.critical-result', S2, {
  id: crId(41), institution: 'inst-a', senderInstitution: 'inst-b', event, from, to, revision, requestId: crId(140 + n), role,
  source: 1, recipient: 'syn-clinician-a@members.test', supersedes: null, replacedBy: null, ...extra }, actor);
const TELE_CR_ROWS = [
  crRow(1, 'created', null, 'created', 1, 'syn-reader-b@members.test', 'radiologist'),
  crRow(2, 'acknowledged', 'created', 'acknowledged', 2, 'syn-clinician-a@members.test', 'clinician'),
  crRow(3, 'cancelled', 'created', 'cancelled', 2, 'syn-reader-b@members.test', 'radiologist'),
  crRow(4, 'superseded', 'created', 'superseded', 2, 'syn-reader-b@members.test', 'radiologist', { replacedBy: crId(45) }),
  crRow(5, 'created', null, 'created', 1, 'syn-reader-b@members.test', 'radiologist', { id: crId(45), supersedes: crId(41) }),
  // a channel moved to a third institution: its reader's record names Z as the sender institution
  crRow(6, 'created', null, 'created', 1, 'syn-reader-z@members.test', 'radiologist', { id: crId(46), senderInstitution: 'inst-z' }),
];
const READERS = ['inst-a', 'inst-b', 'inst-z'];

test('TA01 a tele critical result row names both record-time institutions and reaches no institution of the Members console', () => {
  for (const source of TELE_CR_ROWS) {
    const detail = JSON.parse(source.detail);
    assert.deepEqual(Object.keys(detail).sort(), CR_KEYS, `row ${source.id}`);
    const result = A.attributeAuditRow(source);
    assert.deepEqual([result.rule, json(result.visible_to), result.projection_by_side.size, result.hidden],
      ['hidden:study_scoped_owner_only', [], 0, 'study_scoped_owner_only'], `row ${source.id}`);
    // preserving variants of the same row: key order, spacing and one key the contract does not name
    const variants = [source, ...[JSON.stringify(Object.fromEntries(Object.entries(detail).reverse())), JSON.stringify(detail, null, 2),
      JSON.stringify({ ...detail, note: 'SYN' })].map(text => ({ ...source, detail: text }))];
    for (const variant of variants) {
      assert.deepEqual(json(A.attributeAuditRow(variant).visible_to), [], `row ${source.id}`);
      for (const reader of READERS) {
        assert.equal(A.projectAuditRow(variant, reader), null, `row ${source.id} for ${reader}`);
        assert.equal(A.auditCandidateRow(variant, reader), false, `row ${source.id} prefetched for ${reader}`);
      }
    }
  }
});

test('TA02 negative control: the same rows attributed by one recorded field reach A or B, so the vectors can see a leak', () => {
  // A test-owned table that reads one recorded field, as a field rule would (the rejected ways to show these rows).
  const byField = field => source => { const value = JSON.parse(source.detail)[field]; return typeof value === 'string' && value ? [value] : []; };
  for (const source of TELE_CR_ROWS) {
    const detail = JSON.parse(source.detail);
    assert.deepEqual(byField('institution')(source), ['inst-a'], `row ${source.id}`);
    assert.deepEqual(byField('senderInstitution')(source), [detail.senderInstitution], `row ${source.id}`);
    assert.notDeepEqual(byField('senderInstitution')(source), byField('institution')(source), `row ${source.id}: two sides`);
    // The product's own field-rule path over the same detail: read as a field:detail.institution row, it reaches A.
    const asField = { ...source, action: 'reader.assignment' };
    assert.deepEqual([A.attributeAuditRow(asField).rule, json(A.attributeAuditRow(asField).visible_to)], ['field:detail.institution', ['inst-a']]);
    assert.ok(A.projectAuditRow(asField, 'inst-a'), `row ${source.id}`);
    // ...where the product row for the action is hidden from every reader
    assert.deepEqual(READERS.filter(reader => A.projectAuditRow(source, reader)), [], `row ${source.id}`);
  }
});

test('TA03 study.critical-result keeps its one hidden study-scoped row: no candidate, field or member rule would show a two-institution row', () => {
  const action = 'study.critical-result';
  assert.equal(A.auditRule(action), 'hidden:study_scoped_owner_only');
  assert.deepEqual([A.AUDIT_HIDDEN_STUDY_SCOPED.includes(action), A.AUDIT_CANDIDATE_ACTIONS.includes(action),
    Object.prototype.hasOwnProperty.call(A.AUDIT_FIELD_RULES, action), A.AUDIT_MEMBER_ACTIONS.includes(action),
    A.AUDIT_TARGET_ACTIONS.includes(action)], [true, false, false, false, false]);
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

});

// ── S7-U5 access records (TEST-S7-U5-ATTRIBUTION AT-03..AT-05; AT-01 and AT-02 are the table and vectors above, AT-06 the
// completeness cases below) ──

test('AT-03 negative control: the current-group rule hands exactly m\'s A-era access rows to B; the record-time rule keeps them in A', () => {
  // The S7-U5 access-record vectors are 32-41 (the S9-U4b rows 42-50 follow them and are no access records).
  const vectors = CONTRACT.synthetic_vectors.filter(v => v.row >= 32 && v.row <= 41);
  assert.deepEqual(vectors.map(v => v.row), [32, 33, 34, 35, 36, 37, 38, 39, 40, 41]);
  const leaks = vectors.filter(v => JSON.stringify(currentRule(ROWS.get(v.row))) !== JSON.stringify(v.record_time_visible_to))
    .map(v => v.row);
  assert.deepEqual(leaks, [32, 33]);
  for (const n of leaks) {
    assert.deepEqual(currentRule(ROWS.get(n)), ['inst-b'], `row ${n}: the rejected rule follows m to B`);
    assert.equal(A.projectAuditRow(ROWS.get(n), 'inst-b'), null, `row ${n} never reaches B`);
    assert.ok(A.projectAuditRow(ROWS.get(n), 'inst-a'), `row ${n} stays with A`);
  }
  // Preserving pair: the B-era rows read the same under both rules.
  for (const n of [34, 37]) assert.deepEqual(currentRule(ROWS.get(n)), json(A.attributeAuditRow(ROWS.get(n)).visible_to), `row ${n}`);
  assert.equal(CONTRACT.rejected_current_rule_leaks.length, 9, 'the card leak list is unchanged');
});

test('AT-04 an access row that does not clearly record one institution is hidden; a clear one is projected as recorded', () => {
  const auth = (detail, extra = {}) =>
    A.attributeAuditRow({ ...row(99, 'auth.logout', M, detail, 'syn-m-login@synthetic.test'), ...extra });
  const cases = {
    'institution null': auth(authDetail(null, { cause: 'logout' })),
    'institution empty': auth(authDetail('', { cause: 'logout' })),
    'institution numeric': auth(authDetail(7, { cause: 'logout' })),
    'no institution key': auth((({ institution, ...rest }) => rest)(authDetail('inst-a', { cause: 'logout' }))),
    'institution only inherited': auth('{"__proto__":{"institution":"inst-a"},"cause":"logout"}'),
    'detail not JSON': auth('{"institution":"inst-a"'),
    'detail an array': auth([authDetail('inst-a', { cause: 'logout' })]),
    'non-string actor': auth(authDetail('inst-a', { cause: 'logout' }), { actor: null }),
    'invalid time': auth(authDetail('inst-a', { cause: 'logout' }), { at: 'yesterday' }),
  };
  for (const [name, result] of Object.entries(cases)) {
    assert.deepEqual(json(result.visible_to), [], name);
    assert.equal(result.projection_by_side.size, 0, name);
    assert.equal(typeof result.hidden, 'string', name);
    for (const reader of ['inst-a', 'inst-b', 'inst-z']) assert.equal(result.projection_by_side.get(reader), undefined, name);
  }
  // A clear row is shown with exactly the keys it recorded: nothing is added, guessed or dropped.
  for (const [n, reader] of [[32, 'inst-a'], [35, 'inst-b'], [41, 'inst-a']]) {
    const recorded = JSON.parse(ROWS.get(n).detail), shown = A.projectAuditRow(ROWS.get(n), reader);
    assert.deepEqual(json(shown.detail), recorded, `row ${n}`);
    assert.deepEqual(Object.keys(shown.detail), Object.keys(recorded), `row ${n}`);
    assert.equal(shown.target, ROWS.get(n).target, `row ${n}`);
  }
  // The entry of a login (auth.entry) is an access row like the others: the institution it recorded reads it, as recorded.
  const entered = row(98, 'auth.entry', M, authDetail('inst-a', {}), 'syn-m-login@synthetic.test');
  const attributed = A.attributeAuditRow(entered);
  assert.deepEqual([attributed.rule, json(attributed.visible_to)], ['field:detail.institution', ['inst-a']]);
  assert.deepEqual(json(A.projectAuditRow(entered, 'inst-a').detail), { institution: 'inst-a', ip: '198.51.100.7', dataSubject: null });
  for (const reader of ['inst-b', 'inst-z']) assert.equal(A.projectAuditRow(entered, reader), null, reader);
});

test('AT-05 the SQL prefilter keeps every access row of a name with \\, ", % and _ and adds none', async () => {
  const NAMES = ['inst-a', 'inst\\b', 'inst"q', 'inst%p', 'inst_u', 'a\\"%_\\\\z', '병원 A'];
  const rows = [], expected = new Map(NAMES.map(name => [name, []]));
  let id = 0;
  NAMES.forEach((name, n) => {
    const account = `syn-account-${n}`;
    for (const [action, rest] of [['auth.login', { outcome: 'success' }], ['auth.logout', { cause: 'logout' }],
      ['auth.session.expired', { cause: 'idle' }]]) {
      rows.push(row(++id, action, account, authDetail(name, rest), `syn-login-${n}@synthetic.test`));
      expected.get(name).push(id);
    }
    // a failed login of an unknown identity next to them: nobody's
    rows.push(row(++id, 'auth.login', '', authDetail(null, { outcome: 'failure', cause: 'provider_error' }), 'unknown'));
  });
  const all = { after: null, limit: 100 }, lost = {};
  for (const reader of NAMES) {
    const label = JSON.stringify(reader);
    assert.deepEqual(rows.filter(r => A.projectAuditRow(r, reader)).map(r => r.id), expected.get(reader), label);
    for (const r of rows) if (A.projectAuditRow(r, reader)) assert.ok(A.auditCandidateRow(r, reader), `row ${r.id} for ${label}`);
    const everything = await A.readAuditPage(sourceOver(rows), reader, all);
    assert.equal(everything.total, 3, label);
    const prefiltered = await A.readAuditPage(sourceOver(rows.filter(r => A.auditCandidateRow(r, reader))), reader, all);
    assert.deepEqual(prefiltered, everything, `${label}: the prefilter changes nothing`);
    const removed = await A.readAuditPage(sourceOver(rows.filter(r => removedLikeCandidate(r, reader))), reader, all);
    lost[reader] = everything.total - removed.total;
  }
  // Negative control: the removed LIKE form (modelled above) loses every access row of a name with \ or ".
  assert.deepEqual(lost, { 'inst-a': 0, 'inst\\b': 3, 'inst"q': 3, 'inst%p': 0, 'inst_u': 0, 'a\\"%_\\\\z': 3, '병원 A': 0 });
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

test('B2 scope behaviour: EMR-D writes and reads record B2 events with the shared request facts; the admin create keeps its AuditLog row', async () => {
  const recorded = await require('./fixtures/admin-audit-checker/recorded-boundaries.cjs')();
  console.log('ADMIN_AUDIT_RECORDED_BOUNDARIES ' + JSON.stringify(recorded));
  assert.deepEqual(recorded.legacyActions, ['admin.user.create']);
  assert.deepEqual(recorded.clinicalEvents, ['write', 'provide-prepared']);
});
