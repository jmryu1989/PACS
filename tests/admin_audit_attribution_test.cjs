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
 *  - completeness (Astra S7-U3a-AUDIT-SPEC-R-001 F01-F04, F01/F03 amended by S7-U3a-AUDIT-SPEC-B-R-001 with the second
 *    raw SQL form, the positive reading closed to the list W1-W6 of S7-U3a-AUDIT-SPEC-C-R-001): every file of api/src and every api/prisma/*.cjs entry point
 *    is read; every audit candidate there is resolved or proven not an audit write;
 *    every action a write can record has a contract row and every row is written somewhere. The TypeScript compiler
 *    api/package-lock.json installs reads the program of api/src (see the completeness section). The checker's own tests
 *    run on test-owned fixtures (tests/fixtures/admin_audit_completeness, and tests/fixtures/admin-audit-checker for the
 *    forms W1-W6 take, the counterexamples of Astra S7-U3a-E-R-001, S7-U3a-F-R-001 and C-RAW-CAST, and the marks the
 *    closed list replaces): the forms taken, each failure class and each counterexample failing the gate alone; api/src
 *    rewritten in other notations keeps every write site; unlisted, dynamic and unwritten actions each fail alone, and so
 *    does each write given one more path through a helper called by a constant key or a fragment written or handed on.
 *
 * S7-U3a-RAW-PROVENANCE: every raw site must be proved without a set-aside list. Local fixed
 * compositions are enumerated before SQL classification; any unproved variant fails the verdict.
 * REQ-S7-RAW-PROVENANCE -> RISK-S7-RAW-HIDDEN-WRITE / RISK-S7-RAW-BEHAVIOUR-DRIFT
 *   -> TEST-S7-RAW-COMPOSITION / TEST-S7-RAW-MUTANTS.
 *
 * Module: KIN_ADMIN_AUDIT_MODULE, default api/src/admin-audit.ts loaded through Node type stripping (Node >= 22.18);
 * the compiled /app/dist/admin-audit (kin-api:ci) is the same rule. The completeness cases read api/src and api/prisma/*.cjs and use
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
  // are the S7-U5 access-record rows (AT-02).
  assert.equal(CONTRACT.synthetic_vectors.length, 41);
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

// ── S7-U5 access records (TEST-S7-U5-ATTRIBUTION AT-03..AT-05; AT-01 and AT-02 are the table and vectors above, AT-06 the
// completeness cases below) ──

test('AT-03 negative control: the current-group rule hands exactly m\'s A-era access rows to B; the record-time rule keeps them in A', () => {
  const vectors = CONTRACT.synthetic_vectors.filter(v => v.row >= 32);
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

// ── completeness over api/src ──
//
// What this proves and how is fixed by Astra S7-U3a-AUDIT-SPEC-R-001 (F01-F04), amended by S7-U3a-AUDIT-SPEC-B-R-001 (G2)
// and S7-U3a-AUDIT-SPEC-C-R-001 (the closed list W1-W6, SQL values before any raw classification). Statically, over the audit writes of
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
//  Candidates (SPEC-F01, kept): every member access, destructured property or computed key whose key W1 fixes as
//    `auditLog`: the delegate must be the receiver of a called method — a read method is not a write (W6), `create` is read
//    below, any other method (createMany, upsert, update, delete ...) is unresolved, and so is the delegate kept, passed,
//    returned or destructured; a member read by a key W1 does not fix from a value a Prisma client may reach (the client
//    flow; from any other value it is proven_non_audit), so a key outside W1 never hides a candidate; every raw call
//    ($executeRaw, $queryRaw, their Unsafe forms) and every text of the program that names AuditLog other than as one bare
//    name (a member key such as 'auditLog' is the delegate's; SQL reaches the table only through its quoted identifier).
//    The client flow: a class extending @prisma/client's PrismaClient, a binding annotated with such a class or with
//    Prisma's TransactionClient, and the first parameter of a callback handed to `$transaction` hold a client, and so does
//    every binding, parameter and function result a client value reaches (a fixed point) through the calls the program
//    makes of functions it has — a W3 helper or callback, a method of a program class reached through a receiver typed as
//    it (W4), a function a file imports directly. A client value anywhere else — spread, kept in an object or an untyped
//    member, handed to a library or to a callee not fixed that way, returned from a function that is handed on — is
//    unresolved.
//  The positive reading is a closed list (Astra S7-U3a-AUDIT-SPEC-C-R-001, W1-W6 replacing the earlier (a)-(i)); every
//    resolved write and every candidate proven not a write names the rules it took (`rules`, `rule`), and whatever is not
//    on the list is unresolved where it stands, with why.
//  W1 keys: a dot, a string or number literal, or a const of the same file whose initializer is a string literal — for
//    the delegate, its method, `data`, `action`, a helper and any member. Parentheses, `as`, `satisfies`, `!` and `<T>` are
//    notation: what they hold is read, the type they state is never evidence. The last definition of a property wins; a
//    later spread or a key W1 does not fix that may set it leaves it unresolved.
//  W2 action values: a string literal, a template without interpolation, a const of the same file or of one direct import
//    (not a re-export or a namespace) holding one of these; (i) `+` and templates of W2 values; (ii) both sides of ?:;
//    (iii) a let of a function, its initializer and every plain assignment W2 values; (iv) a binding nothing changes that
//    a preceding `if (... || !['a', ...].includes(x) || ...) throw/return` of an enclosing statement list limits. A fixed
//    start followed by anything else is a prefix a hidden wildcard row must cover. A parameter only through W3. Nothing
//    else: no property (enum, `as const` table, readonly field, namespace), no ||, ?? or &&, no function result.
//  W3 helpers: a private method, a function of its file that is not exported, a const arrow or function expression that is
//    not exported — every call the program makes of it (a method: every access typed as it, W1 keys; it replaced nowhere;
//    its object kept, W4), each argument read by W2 or F02; no call, a call not fixed, the helper replaced, taken out or
//    handed on is unresolved. One callback rule (the `scopeWrite` form): a helper hands a local function to a callback
//    parameter every caller of the same file writes in place, and each callback only calls (or tests) the function it
//    receives — those calls are the local function's.
//  W4 objects: a helper is reached through a class or its instances; every use of what holds one — the class name, `this`
//    and `super` in its family's code, every value typed as its instance — is a member read, written or called by a key
//    W1 fixes (a called member a method with a body in the program that nothing replaces, by a dot, a key or through any
//    holder), a test or `new`; anything else (handed on, aliased, a key W1 does not fix, a prototype, a decorator) and a
//    method replaced leave what is reached through it unresolved. A value the checker does not type cannot reach the
//    object while its holders keep to this, so an access on one is not taken for the method. Every value TypeScript types
//    as an SQL fragment (Prisma's Sql, or a function giving one) goes only into a Prisma.sql or raw template, a raw call,
//    Prisma.join, a variable, parameter or return typed as a fragment, Array#map's result, a test, or a read of its text;
//    anything else — an assertion to another type, a parameter typed any, an object, a library — is its own unresolved
//    candidate there.
//  F02 SQL values, before any raw classification: an interpolation is a value (Prisma binds it) when it is a literal, a
//    result the language makes a primitive (template, arithmetic, comparison, `!`, `typeof`), each side of ?:, ||, ?? and
//    &&, `new Date()`, an array literal (one parameter), a const or let through its initializer and every assignment, a W3
//    parameter through every call's argument, a parameter of a function outside callers call declared a primitive or a
//    Date, a JSON/Prisma result (a delegate method's or raw query's rows, `JSON.parse`, through consts, W3 arguments and
//    returns, `??`, destructuring and for-of) and its fields (W6), a field of an object literal it always is, a member
//    declared a primitive or a Date of a record (a parameter declared an object type, a call typed as one), an inferred
//    primitive field of a typed function result, a contextually typed callback parameter, or a call the
//    checker types a primitive or a Date. A type stated by an assertion or an annotation is never evidence (wrappers are
//    read through); a type is taken only where no fragment is handed on in code connected by calls to it (W4). Anything
//    typed any or unknown is a value only as a JSON/Prisma result or its field. Nothing typed as a fragment is a value.
//  W5 writes, two raw forms only (Astra S7-U3a-AUDIT-SPEC-B-R-001), read by position under PostgreSQL's lexical rules
//    (strings, quoted identifiers and their case, comments, parentheses, interpolations):
//      G1 `INSERT INTO [schema.]"AuditLog" (columns) VALUES (values) [;]`;
//      G2 `[WITH name AS (...), ...] INSERT INTO [schema.]"AuditLog" (columns) SELECT items FROM source [;]` — a WITH list
//         that is not RECURSIVE (a name, its column list, [NOT] MATERIALIZED and a body in parentheses that names no
//         AuditLog); with it the source is one of its names, without it one [schema.]table; no JOIN, UNION, WHERE or other
//         clause, no DISTINCT.
//    The value or item at the one `action` column is, whole, an SQL string or one interpolation W2 reads; every other
//    interpolation is an F02 value, except that one in a WITH body may be a fragment every value of which is a Prisma.sql
//    text `[alias.]column = ${value}::type` (its interpolation an F02 value) written where it is passed to a private or
//    local helper of the write's file, or held by a const, each holder used for nothing else (interpolated there, passed
//    to such a helper, aliased by a const, tested). Everything else that names AuditLog (a missing, doubled or miscounted
//    column list, an empty value, an unclosed token, an interpolation where SQL structure goes, WITH before VALUES,
//    several statements, ON CONFLICT, RETURNING, UPDATE, DELETE ...) is unresolved.
//  W6 not audit writes: a read method of the delegate; every alternative of a raw call names no AuditLog, names it only
//    in strings/comments, or is one SELECT that changes no row. RAW-PROVENANCE adds local const fragments, ?:, sql/empty,
//    literal raw, fixed-array join and same-file helper returns. Text is concatenated before lexing. Comma-separated
//    repetitions of proved bound values (optionally cast) cannot introduce identifiers; unknown arrays/spreads fail.
//    A composition exposing an audit INSERT still needs W5 and W2 attribution. Existing direct audit INSERTs retain W5's
//    narrower predicate grammar. Cross-module SQL helpers, nonliteral raw/concatenation/separators and any unproved
//    alternative remain unresolved. Data projection through array producers does not admit SQL from another module.
//  Named limits (final hardening round; this scan guards against honest mistakes, not against a developer who hides a
//    write on purpose). Each shape below passes the scan and is left so because no realistic honest mistake in this
//    codebase was found that produces it: L1 the Prisma namespace used as a plain value (held in an `any` variable,
//    handed to Object.assign) and its methods called through that value; L2 an ambient `declare` value typed any that
//    comes from outside the program; L3 code that does not compile (an unresolved name — the API image build refuses
//    it); L4 an SQL function that executes a text argument inside an ordinary query (dblink_exec and the like). That
//    none of them is used today is an observation, not a proof: a change that introduces one of these shapes reopens
//    the limit. The cases are kept as comments beside the negative table (LIMIT L1-L3) so that they are not rediscovered.
//  Closure (Astra S7-U3a-AUDIT-SPEC-C-R-001-F03, the conditions of S7-U3a-G-R-001): (a) W1-W6 alone resolve every write of
//    the baseline and give every other candidate its classification, with no writer left out, no exception by place and
//    no product change; (b) each enumerated counterexample, alone next to the baseline, leaves its write unresolved and
//    fails the gate; (c) a construction outside the list refused as unresolved, with where and why, meets this check's own
//    tests — it never lets a product candidate stay unresolved, and a missed candidate or a resolved/proven_non_audit
//    without ground is a defect in or out of the list; (d) the site/action and prefix multisets of the notations kept, the
//    independent failures, and the audit attribution and compiled-service tests stay.

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
  // Named as the config file, as `tsc -p api` has it: its type roots (api/node_modules/@types) are then the program's too.
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, API, undefined, path.join(API, 'tsconfig.json'));
  const options = { ...parsed.options, allowJs: true, noEmit: true, incremental: false, sourceMap: false };
  delete options.outDir;
  delete options.tsBuildInfoFile;
  const src = slash(path.join(API, 'src')) + '/';
  const named = parsed.fileNames.map(slash).filter(file => file.startsWith(src)).map(repoPath).sort();
  assert.ok(named.length > 0, 'api/tsconfig.json includes the files of api/src');
  // Deployment entry points are outside tsconfig but must not hide raw SQL from the audit inventory.
  named.push(...onDisk(path.join(API, 'prisma')).filter(file => file.endsWith('.cjs')));
  named.sort();
  const base = ts.createCompilerHost(options, true);
  // `@prisma/client` only re-exports the client `prisma generate` writes, and CI installs with --ignore-scripts, so none
  // is there: `Prisma.sql`, `Prisma.join`, `Prisma.empty`, `Prisma.raw` and `Prisma.Sql` would lose the types the SQL
  // rules read, and the check would read CI's tree otherwise than a developer's. The generated namespace takes those five
  // from the package's own runtime whatever the schema; with no generated client, that part (as 5.22 writes it) is read.
  const generated = path.join(API, 'node_modules', '.prisma', 'client');
  const stub = base.fileExists(path.join(generated, 'default.d.ts')) ? null : {
    file: slash(path.join(generated, 'default.d.ts')),
    directories: new Set([slash(path.dirname(generated)), slash(generated)]),
    text: "import * as runtime from '@prisma/client/runtime/library.js';\nexport namespace Prisma {\n"
      + '  export import sql = runtime.sqltag\n  export import empty = runtime.empty\n  export import join = runtime.join\n'
      + '  export import raw = runtime.raw\n  export import Sql = runtime.Sql\n}\n',
  };
  compiler = { ts, options, src, named, base, stub, lookups: new Map(), external: new Map(), internal: new Map(),
    previous: undefined, product: null };
  return compiler;
}

// A context event belongs to its recorded institution, regardless of current ownership or source spelling.
test('context event audit projection uses the recorded institution and withholds unscoped rows', () => {
  const event = row(42, 'viewer-context.event', S1, {institution:'inst-a', stage:'loss', cause:'context-lost'});
  assert.equal(A.projectAuditRow(event, 'inst-b'), null);
  assert.equal(A.projectAuditRow(event, 'inst-a').detail.stage, 'loss');
  for (const detail of [{}, {institution:null}, {institution:''}, {by:'inst-a'}])
    assert.equal(A.projectAuditRow({...event, detail:JSON.stringify(detail)}, 'inst-a'), null);
});

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
  c.product ??= { listing: sourceListing([...onDisk(path.join(API, 'src')), ...onDisk(path.join(API, 'prisma')).filter(file => file.endsWith('.cjs'))], c.named),
    sources: c.named.map(file => ({ file, text: readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n') })) };
  return c.product;
}
const auditSources = () => productSources().sources;

/** The program of `sources` (files under api/src; lib and node_modules from disk, and the Prisma runtime part when no
 *  client was generated), reusing what earlier calls parsed. */
function auditProgram(sources) {
  const c = typescript(), { ts, src, base, stub } = c;
  const texts = new Map(sources.map(source => [slash(path.join(ROOT, source.file)), source.text]));
  const inside = file => slash(file).startsWith(src) || texts.has(slash(file)), virtual = file => stub !== null && slash(file) === stub.file;
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
    fileExists: file => (virtual(file) || (inside(file) ? texts.has(slash(file)) : exists(file))),
    readFile: file => (virtual(file) ? stub.text : inside(file) ? texts.get(slash(file)) : read(file)),
    directoryExists: dir => (stub?.directories.has(slash(dir)) ? true
      : inside(slash(dir) + '/') ? [...texts.keys()].some(file => file.startsWith(slash(dir) + '/')) : directory(dir)),
    realpath: base.realpath && once('realpath', file => (virtual(file) ? file : base.realpath(file))),
    getDirectories: base.getDirectories && once('getDirectories', dir => base.getDirectories(dir)),
    getSourceFile(file, version, onError, create) {
      const at = slash(file);
      if (!inside(at)) {
        if (!c.external.has(at)) {
          c.external.set(at, virtual(at) ? ts.createSourceFile(file, stub.text, version, true) : base.getSourceFile(file, version, onError, create));
        }
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
 * and dynamic prefixes each can record, the basis of each and the W rules it took (`rules`); `candidates` is every
 * candidate with its status, reason and rule; `unresolved` the unresolved ones. A site and a candidate also carry (not
 * enumerable) their offset, and a create site its call, its action property and the literals its actions come from, for
 * the controls that rewrite them. Every positive judgement below is one of the entries W1-W6 name; anything else is
 * unresolved with where and why.
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
  /** Parentheses and type wrappers are notation (W1): what they hold is read, the type they state is never evidence. */
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
  /** A candidate: where, what, its status, why, and the rule that decided it. */
  function note(node, kind, status, reason, rule) {
    const entry = { ...position(node), kind, status, reason, rule };
    Object.defineProperty(entry, 'start', { value: node.getStart() });
    candidates.push(entry);
    return entry;
  }
  const inProgram = declaration => files.includes(declaration.getSourceFile());
  const isStatic = node => !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static);
  const isConst = declaration => ts.isVariableDeclaration(declaration) && !!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const);
  const isLet = declaration => ts.isVariableDeclaration(declaration) && !!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Let);
  const lib = declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile());
  const typeText = type => checker.typeToString(type).slice(0, 60);

  // ── W1: keys ──
  /**
   * W1: the one key an access, an object literal member's name or a binding element's property takes — a dot, a string
   * or number literal, or a const of the same file whose initializer is a string literal — else why not. Nothing else
   * fixes a key; a candidate is still found where the key is not fixed (the client flow below).
   */
  function w1(node) {
    if (ts.isPropertyAccessExpression(node)) return { key: node.name.text, rule: 'W1 dot' };
    const expression = ts.isElementAccessExpression(node) ? node.argumentExpression : ts.isComputedPropertyName(node) ? node.expression : null;
    if (!expression) {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { key: node.text, rule: 'W1 name' };
      if (ts.isNumericLiteral(node)) return { key: String(Number(node.text)), rule: 'W1 name' };
      return { why: `\`${snippet(node)}\` is a ${K[node.kind]} name` };
    }
    const at = bare(expression);
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at)) return { key: at.text, rule: 'W1 literal key' };
    if (ts.isNumericLiteral(at)) return { key: String(Number(at.text)), rule: 'W1 literal key' };
    if (ts.isIdentifier(at)) {
      const declarations = symbolAt(at)?.declarations ?? [], [declaration] = declarations;
      const value = declarations.length === 1 && isConst(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer
        && declaration.getSourceFile() === at.getSourceFile() ? bare(declaration.initializer) : null;
      if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
        return { key: value.text, rule: `W1 const key \`${at.text}\` (${where(declaration)})` };
      }
    }
    return { why: `\`${snippet(expression)}\` is not a key W1 fixes (a literal, or a const of its file holding one)` };
  }

  // ── references ──
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
      if (ts.isImportClause(node) && node.name) add(index.renamed, 'default', node.name.text);   // a default import names what it likes
      ts.forEachChild(node, walk);
    };
    files.forEach(walk);
    return index;
  }
  const same = (found, symbol) => found === symbol || !!found?.declarations?.some(declaration => symbol.declarations?.includes(declaration));
  /** The uses of `symbol` in the program's sources (a parameter's or a function-local's in its own file), declarations left out. */
  const referenceCache = new Map();
  function references(symbol) {
    if (!symbol) return [];
    if (referenceCache.has(symbol)) return referenceCache.get(symbol);
    const { names, renamed } = spelled();
    const [first] = symbol.declarations ?? [];
    const own = new Set((symbol.declarations ?? []).map(declaration => declaration.name));
    const statement = first && ts.isVariableDeclaration(first) ? first.parent?.parent : null;
    const local = first && (ts.isParameter(first) || (statement && !ts.isSourceFile(statement.parent) && !ts.isModuleBlock(statement.parent)))
      ? first.getSourceFile() : null;
    const found = [...new Set([symbol.name, ...(renamed.get(symbol.name) ?? []), ...(renamed.get('default') ?? [])])].flatMap(name => names.get(name) ?? [])
      .filter(node => !own.has(node) && (!local || node.getSourceFile() === local) && same(symbolAt(node), symbol));
    referenceCache.set(symbol, found);
    return found;
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
  /** A name on the left of a destructuring assignment. */
  function destructured(node) {
    let at = node;
    while (ts.isArrayLiteralExpression(at.parent) || ts.isObjectLiteralExpression(at.parent) || ts.isSpreadElement(at.parent)
      || ts.isSpreadAssignment(at.parent) || (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at)
      || ts.isShorthandPropertyAssignment(at.parent) || (ts.isBinaryExpression(at.parent) && at.parent.left === at
        && at.parent.operatorToken.kind === K.EqualsToken && (ts.isArrayLiteralExpression(at.parent.parent)
          || ts.isPropertyAssignment(at.parent.parent)))) at = at.parent;
    return at !== node && ((ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === K.EqualsToken && at.parent.left === at)
      || ((ts.isForInStatement(at.parent) || ts.isForOfStatement(at.parent)) && at.parent.initializer === at));
  }
  /** The destructuring assignment `[a] = x` or `({a} = x)` a name is a target of: its right side, else null. */
  function destructuredFrom(node) {
    let at = node;
    while (ts.isArrayLiteralExpression(at.parent) || ts.isObjectLiteralExpression(at.parent) || ts.isSpreadElement(at.parent)
      || ts.isSpreadAssignment(at.parent) || (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at)
      || ts.isShorthandPropertyAssignment(at.parent)) at = at.parent;
    return at !== node && ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === K.EqualsToken && at.parent.left === at ? at.parent.right : null;
  }
  /** A use that neither changes nor hands on a value: tested, compared, typeof, void, a statement of its own. */
  const inert = node => {
    const parent = node.parent;
    return ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isExpressionStatement(parent)
      || (ts.isForStatement(parent) && parent.condition === node) || (ts.isConditionalExpression(parent) && parent.condition === node)
      || (ts.isPrefixUnaryExpression(parent) && parent.operator === K.ExclamationToken) || ts.isTypeOfExpression(parent)
      || ts.isVoidExpression(parent) || (ts.isBinaryExpression(parent) && EQUALITIES.has(parent.operatorToken.kind));
  };
  /** The writes of a binding after its declaration: `{ plain: [right sides], other: [nodes] }` (compound, ++, for-in/of,
   *  destructuring — the last with its right side in `from`). */
  /** A direct eval or a with statement anywhere in the program (either may write any binding it can see), else null. */
  let directEval;
  const evalCall = () => {
    if (directEval !== undefined) return directEval;
    // `(eval)(...)` is still a direct eval: the callee is looked for through the wrappers around the name.
    directEval = (spelled().names.get('eval') ?? []).find(node => { const whole = outer(node); return ts.isCallExpression(whole.parent) && whole.parent.expression === whole; }) ?? null;
    const walk = node => { if (!directEval && ts.isWithStatement(node)) directEval = node.expression; else if (!directEval) ts.forEachChild(node, walk); };
    if (!directEval) files.forEach(walk);
    return directEval;
  };
  function writesOf(symbol) {
    const plain = [], other = [];
    for (const declaration of (symbol?.declarations ?? []).slice(1)) {
      if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
        || (ts.isFunctionDeclaration(declaration) && !declaration.body)) continue;   // type space, overload signatures
      other.push({ at: declaration });   // var / function redeclaration re-initialises the binding
    }
    if (evalCall()) other.push({ at: evalCall().parent });
    for (const reference of references(symbol)) {
      const node = outer(accessOf(reference) ?? reference), parent = node.parent;
      const operator = ts.isBinaryExpression(parent) && parent.left === node ? parent.operatorToken.kind : null;
      if (destructured(node)) other.push({ at: parent, from: destructuredFrom(node) });
      else if (operator === K.EqualsToken) plain.push(parent.right);
      else if ((operator !== null && operator >= K.FirstCompoundAssignment && operator <= K.LastCompoundAssignment)
        || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && (parent.operator === K.PlusPlusToken || parent.operator === K.MinusMinusToken))
        || ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node)) other.push({ at: parent });
      else if (destructured(node)) other.push({ at: parent, from: destructuredFrom(node) });
      else if (mutated(node)) other.push({ at: parent });
    }
    return { plain, other };
  }
  /** A substitution must not silently discard a write, including one in a closure. The symbol
   * index includes every source in the program; the syntax check is independent of control flow. */
  function changedBinding(symbol) {
    const { plain, other } = writesOf(symbol);
    const write = plain[0]?.parent ?? other[0]?.at;
    return write ? `binding \`${symbol.name}\` is written at ${where(write)} (${snippet(write)})` : null;
  }
  const argumentUses = new Map();
  function implicitArguments(owner) {
    if (argumentUses.has(owner)) return argumentUses.get(owner);
    let found = null;
    const walk = node => {
      if (found || ts.isTypeNode(node) || (node !== owner && ts.isFunctionLike(node) && !ts.isArrowFunction(node))) return;
      if (ts.isIdentifier(node) && node.text === 'arguments' && !nameOnly(node)) found = node;
      ts.forEachChild(node, walk);
    };
    walk(owner);
    argumentUses.set(owner, found);
    return found;
  }
  function parameterHazard(declaration) {
    if (!ts.isParameter(declaration)) return null;
    const name = declaration.name.getText(), use = implicitArguments(declaration.parent);
    if (use) return `binding \`${name}\` belongs to a function using arguments at ${where(use)}`;
    // Defaults execute in the callee scope, before its body. Following them in the caller's
    // environment would silently change which parameter (or shadowed outer binding) is read.
    if (declaration.initializer) {
      let dependent = null;
      const walk = node => {
        if (ts.isIdentifier(node) && !nameOnly(node) && (symbolAt(node)?.declarations ?? []).some(ts.isParameter)) dependent = node;
        ts.forEachChild(node, walk);
      };
      walk(declaration.initializer);
      if (dependent) return `binding \`${name}\` has a default depending on parameter \`${dependent.text}\``;
    }
    return null;
  }
  /** Check every use of a followed object, along the projection being proved. A const freezes
   * the binding, not its contents. Aliases, callback elements and closed helper parameters keep
   * the same obligation; an opaque consumer cannot establish absence of writes. */
  const contentCache = new Map();
  function contentIssue(symbol, keys = [], pushes = false, seen = null) {
    const stamp = JSON.stringify([keys, pushes]);
    if (seen?.get(symbol)?.has(stamp)) return null;
    if (!contentCache.has(symbol)) contentCache.set(symbol, new Map());
    const memo = contentCache.get(symbol);
    if (memo.has(stamp)) return memo.get(stamp);
    if (seen) return checkContents(symbol, keys, pushes, seen);
    memo.set(stamp, `binding \`${symbol?.name ?? '?'}\` depends on itself while checking content writes`);
    const reached = new Map(), issue = checkContents(symbol, keys, pushes, reached);
    memo.set(stamp, issue);
    // Cache an alias component only after *all* its edges passed. Caching an in-progress
    // cycle as safe would hide a write discovered later on a different edge of that cycle.
    if (!issue) for (const [binding, paths] of reached) {
      if (!contentCache.has(binding)) contentCache.set(binding, new Map());
      for (const path of paths) contentCache.get(binding).set(path, null);
    }
    return memo.get(stamp);
  }
  function checkContents(symbol, keys, pushes, seen) {
    if (!symbol) return 'an object binding does not resolve';
    const declared = checker.getTypeOfSymbol(symbol);
    if (!keys.length && (declared.isUnion() ? declared.types : [declared]).every(type => type.flags & PRIMITIVE)) return null;
    const label = `binding \`${symbol.name}\``;
    const stamp = JSON.stringify([keys, pushes]);
    if (seen.get(symbol)?.has(stamp)) return null; // all edges of this alias component are visited
    if (keys.length > 20 || [...seen.values()].reduce((sum, paths) => sum + paths.size, 0) > 80) return `${label} exceeds the alias analysis limit`;
    if (!seen.has(symbol)) seen.set(symbol, new Set());
    seen.get(symbol).add(stamp);
    const fail = (node, why) => `${label} ${why} at ${where(node)}`;
    const follow = (name, path) => {
      if (!ts.isIdentifier(name)) {
        if (!ts.isArrayBindingPattern(name) && !ts.isObjectBindingPattern(name)) return fail(name, 'has an unsupported destructured alias');
        for (const [index, element] of name.elements.entries()) {
          if (ts.isOmittedExpression(element)) continue;
          if (element.dotDotDotToken) return fail(element, 'has an unsupported rest alias');
          const key = ts.isArrayBindingPattern(name) ? String(index) : element.propertyName ? w1(element.propertyName).key : element.name.text;
          if (key === undefined) return fail(element, 'has an unknown binding key');
          if (path.length && path[0] !== '*' && path[0] !== key) continue;
          if (path.length === 1) continue;
          const issue = follow(element.name, path.slice(1));
          if (issue) return issue;
        }
        return null;
      }
      return contentIssue(symbolAt(name), path, pushes, seen);
    };
    const use = (start, path, depth = 0) => {
      if (depth > 80) return fail(start, 'exceeds the use analysis limit');
      const node = outer(start), parent = node.parent;
      if (inTypePosition(start) || inert(node) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return null;
      if (mutated(node)) return fail(node, 'is written through');
      if (isAccess(parent) && parent.expression === node) {
        const key = w1(parent).key, held = outer(parent), consumer = held.parent;
        if (path[0] === '*' && key === 'length' && !mutated(held)) return null;
        if (ts.isCallExpression(consumer) && consumer.expression === held) {
          const signature = checker.getResolvedSignature(consumer)?.declaration;
          const receiverType = checker.getNonNullableType(checker.getTypeAtLocation(node));
          if (receiverType.symbol?.name === 'Promise' && signature && lib(signature) && ['catch', 'finally'].includes(key))
            return use(consumer, path, depth + 1);
          if (isLibSet(receiverType) && ['has', 'delete', 'clear'].includes(key) && signature && lib(signature)) return null;
          if (['Map', 'ReadonlyMap'].includes(receiverType.symbol?.name) && signature && lib(signature)) {
            if (['set', 'has', 'delete', 'clear'].includes(key)) return null;
            if (path[0] === '@key') return key === 'keys' ? use(consumer, ['*', ...path.slice(1)], depth + 1)
              : ['get', 'values'].includes(key) ? null : fail(consumer, 'has an unproved Map key consumer');
            if (key === 'get') return use(consumer, path.slice(1), depth + 1);
            if (key === 'values') return use(consumer, path, depth + 1);
            return fail(consumer, 'has an unproved Map consumer');
          }
          if ((!signature || !lib(signature)) && path[0] !== '*' && !/^\d+$/.test(path[0] ?? '')) return fail(consumer, `has an unproved method consumer (${path.join('.')} via ${key})`);
          if (key === 'push' && pushes && path[0] === '*') {
            if (pushes === 'alias') return null; // other stored values cannot mutate the original object
            return consumer.arguments.every(value => ts.isSpreadElement(value) ? projectedValue(value.expression, path)
              : projectedValue(value, path.slice(1))) ? null : fail(consumer, 'has an unproved pushed value');
          }
          const array = ['map', 'flatMap', 'forEach', 'filter', 'slice', 'sort', 'find', 'some', 'every', 'findIndex', 'includes', 'indexOf', 'join'];
          if (!array.includes(key)) return fail(consumer, `may be changed by \`${key ?? '?'}\``);
          // sort changes order, so it preserves an all-elements proof but not an indexed one.
          if (key === 'sort' && path[0] !== '*') return use(consumer, ['*', ...path.slice(1)], depth + 1);
          if (['map', 'flatMap', 'forEach', 'filter', 'sort', 'find', 'some', 'every', 'findIndex'].includes(key) && consumer.arguments[0]) {
            const callback = bare(consumer.arguments[0]);
            const callbacks = functionsOf(callback, 'flow');
            if (!callbacks?.length) return fail(callback, 'has an opaque array callback');
            const indices = key === 'sort' ? [0, 1] : [0, 2];
            for (const fn of callbacks) for (const index of indices) {
              const parameter = fn.parameters[index];
              if (!parameter) continue;
              if (index !== 2 && path.length === 1) continue; // copying a proved primitive element cannot mutate the container
              const issue = parameterHazard(parameter) || follow(parameter.name, index === 2 ? path : path.slice(1));
              if (issue) return issue;
            }
          }
          if (['filter', 'slice', 'sort'].includes(key)) return path.length === 1 ? null : use(consumer, path, depth + 1);
          if (key === 'find') return use(consumer, path.slice(1), depth + 1);
          return null;
        }
        if (key === undefined) {
          if (mutated(held)) return fail(held, 'is written through an unknown key');
          return path.length === 1 ? null : use(parent, path.slice(1), depth + 1);
        }
        if (path.length && path[0] !== '*' && path[0] !== key) return null;
        // A read of the requested leaf is copied as a value. Writes to that leaf still count.
        if (mutated(held)) return fail(held, 'is written through');
        if (path.length === 1) return null;
        return use(parent, path.length ? path.slice(1) : [], depth + 1);
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        if (ts.isIdentifier(parent.name)) return follow(parent.name, path);
        const elements = [];
        const collect = (pattern, prefix = []) => {
          for (const [index, element] of pattern.elements.entries()) {
            if (ts.isOmittedExpression(element)) continue;
            // Object rest copies the selected leaf; nested objects remain aliases.
            if (element.dotDotDotToken) {
              if (ts.isObjectBindingPattern(pattern) && path.length === 1) continue;
              elements.push({ element, path: null }); continue;
            }
            const key = ts.isArrayBindingPattern(pattern) ? String(index) : element.propertyName ? w1(element.propertyName).key : element.name.text;
            const at = [...prefix, key];
            if (ts.isIdentifier(element.name)) elements.push({ element, path: at });
            else collect(element.name, at);
          }
        };
        collect(parent.name);
        for (const entry of elements) {
          if (!entry.path || entry.path.includes(undefined)) return fail(entry.element, 'has an unknown destructured alias');
          if (path.length && entry.path.some((key, i) => path[i] !== '*' && path[i] !== key)) continue;
          if (path.length && entry.path.length >= path.length) continue;
          const issue = follow(entry.element.name, path.slice(entry.path.length));
          if (issue) return issue;
        }
        return null;
      }
      if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
        const callee = bare(parent.expression);
        if (['join', 'sql'].includes(prismaMember(callee)) || (isAccess(callee) && RAW.has(w1(callee).key))) return null;
        if (isAccess(callee) && ts.isIdentifier(bare(callee.expression))
          && (symbolAt(bare(callee.expression))?.declarations ?? []).some(lib)
          && ['Array.isArray', 'Object.keys', 'Object.values', 'Object.entries', 'JSON.stringify'].includes(`${bare(callee.expression).text}.${w1(callee).key}`)
          && (!['values', 'entries'].includes(w1(callee).key) || path.length === 1)) return null;
        if (isAccess(callee) && w1(callee).key === 'call' && isAccess(bare(callee.expression))
          && w1(bare(callee.expression)).key === 'hasOwnProperty'
          && (symbolAt(bare(callee.expression).name)?.declarations ?? []).some(lib)) return null;
        // Prisma serializes query arguments; it does not retain or mutate the caller's records.
        if (isAccess(callee) && isAccess(bare(callee.expression)) && isClient(bare(bare(callee.expression).expression))) return null;
        if (isAccess(callee) && w1(callee).key === 'push' && lib(checker.getResolvedSignature(parent)?.declaration ?? parent)) {
          const receiver = bare(callee.expression);
          return ts.isIdentifier(receiver) ? contentIssue(symbolAt(receiver), ['*', ...path], 'alias', seen)
            : fail(parent, 'is stored in an unproved array');
        }
        if (isAccess(callee) && w1(callee).key === 'set' && parent.arguments[1] === node
          && lib(checker.getResolvedSignature(parent)?.declaration ?? parent)) {
          const receiver = bare(callee.expression), type = checker.getTypeAtLocation(receiver);
          if (type.symbol?.name === 'Map' && ts.isIdentifier(receiver)) return contentIssue(symbolAt(receiver), ['*', ...path], 'alias', seen);
        }
        if (isAccess(callee) && parent.arguments[0] === node && lib(checker.getResolvedSignature(parent)?.declaration ?? parent)) {
          const receiver = bare(callee.expression), type = checker.getTypeAtLocation(receiver), method = w1(callee).key;
          if (['Map', 'ReadonlyMap'].includes(type.symbol?.name)) {
            if (['get', 'has', 'delete'].includes(method)) return null;
            if (method === 'set' && ts.isIdentifier(receiver)) return contentIssue(symbolAt(receiver), ['@key', ...path], 'alias', seen);
          }
          if (isLibSet(type) && ['has', 'delete'].includes(method)) return null;
        }
        let targets = argumentTargets(parent, parent.arguments.indexOf(node), 'flow');
        // A directly named static method has no instance dispatch. For data-use analysis its
        // parameter's complete use graph is enough; replacements still invalidate the target.
        if (!targets && isAccess(callee) && ts.isIdentifier(bare(callee.expression))) {
          const declaration = checker.getResolvedSignature(parent)?.declaration;
          if (declaration && ts.isMethodDeclaration(declaration) && isStatic(declaration) && declaration.body && inProgram(declaration)
            && !memberChanged(symbolAt(declaration.name)) && classOf(bare(callee.expression)) === declaration.parent) {
            const target = declaration.parameters[parent.arguments.indexOf(node)];
            if (target && !target.dotDotDotToken) targets = [target];
          }
        }
        if (!targets) return fail(parent, `is handed to unproved consumer \`${snippet(callee)}\``);
        for (const target of targets) {
          const issue = parameterHazard(target) || follow(target.name, path);
          if (issue) return issue;
        }
        return null;
      }
      if (ts.isTemplateSpan(parent)) return null; // raw composition/value proof judges this use
      if (ts.isNewExpression(parent) && parent.arguments?.[0] === node && ts.isIdentifier(bare(parent.expression))
        && (symbolAt(bare(parent.expression))?.declarations ?? []).some(lib)) {
        const name = bare(parent.expression).text;
        if (name === 'Map' && path[0] === '*' && path[1] === '1') return use(parent, ['*', ...path.slice(2)], depth + 1);
        if (name === 'Set') return path.length === 1 ? null : use(parent, path, depth + 1);
      }
      if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === K.EqualsToken) {
        const left = bare(parent.left);
        return ts.isIdentifier(left) ? follow(left, path) : fail(parent, 'is stored through another object');
      }
      if (ts.isConditionalExpression(parent) || ts.isAwaitExpression(parent)
        || (ts.isBinaryExpression(parent) && CHOICES.has(parent.operatorToken.kind))) return use(parent, path, depth + 1);
      if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
        let owner = parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        const passed = owner && outer(owner).parent;
        if (passed && ts.isCallExpression(passed) && isAccess(bare(passed.expression))
          && w1(bare(passed.expression)).key === '$transaction' && passed.arguments[0] === outer(owner)) return use(passed, path, depth + 1);
        if (passed && ts.isCallExpression(passed) && isAccess(bare(passed.expression))
          && ['map', 'flatMap'].includes(w1(bare(passed.expression)).key) && passed.arguments[0] === outer(owner)
          && lib(checker.getResolvedSignature(passed)?.declaration ?? passed))
          return use(passed, w1(bare(passed.expression)).key === 'flatMap' ? path : ['*', ...path], depth + 1);
        const found = owner && callsOf(owner, 'flow');
        if (!found || found.escapes.length) return fail(parent, `is returned through an unproved function (${found?.escapes.join(', ')})`);
        for (const call of found.calls) { const issue = use(call, path, depth + 1); if (issue) return issue; }
        return null;
      }
      if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
        const key = w1(parent.name).key;
        return key === undefined ? fail(parent, 'is stored under an unknown key') : use(parent.parent, [key, ...path], depth + 1);
      }
      if (ts.isArrayLiteralExpression(parent)) return use(parent, [String(parent.elements.indexOf(node)), ...path], depth + 1);
      if (ts.isSpreadAssignment(parent)) return use(parent.parent, path, depth + 1);
      if (ts.isSpreadElement(parent)) return path.length === 1 ? null : use(parent.parent, path, depth + 1);
      if (ts.isForOfStatement(parent) && parent.expression === node) {
        const declaration = ts.isVariableDeclarationList(parent.initializer) ? parent.initializer.declarations[0] : null;
        const map = ['Map', 'ReadonlyMap'].includes(checker.getTypeAtLocation(node).symbol?.name);
        return declaration ? follow(declaration.name, map ? [path[0] === '@key' ? '0' : '1', ...path.slice(1)] : path.slice(1)) : fail(parent, 'has an unproved loop alias');
      }
      return fail(parent, `has an unproved ${K[parent.kind]} use`);
    };
    for (const reference of references(symbol)) {
      // Reassignments are separately enumerated by sourcesOf, or refused by changedBinding.
      if (mutated(outer(reference))) continue;
      const issue = use(reference, keys);
      if (issue) return issue;
    }
    return null;
  }

  // ── members by W1 key, and the objects that hold them (W4) ──
  let byName = null;
  /** Every member access of the program's sources, by the key W1 gives it. */
  function memberIndex() {
    if (byName) return byName;
    byName = new Map();
    const walk = node => {
      if (isAccess(node)) {
        const { key } = w1(node);
        if (key !== undefined) { if (!byName.has(key)) byName.set(key, []); byName.get(key).push(node); }
      }
      ts.forEachChild(node, walk);
    };
    files.forEach(walk);
    return byName;
  }
  /** The name a member is reached by (a private name with its #). */
  const memberKey = symbol => {
    const name = symbol.declarations?.[0]?.name;
    return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) ? name.text
      : name && ts.isNumericLiteral(name) ? String(Number(name.text)) : symbol.name;
  };
  /** The accesses that name `symbol`'s member by a key W1 fixes: `typed` where the receiver's type has it as that member,
   *  `untyped` where that type has no member of the name (any, unknown, an index signature) and it may be it. */
  function memberRefs(symbol) {
    const name = memberKey(symbol), typed = [], untyped = [];
    for (const access of memberIndex().get(name) ?? []) {
      const found = ts.isPropertyAccessExpression(access) ? symbolAt(access.name)
        : resolve(checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(access.expression)), name));
      if (!found) untyped.push(access);
      else if (same(found, symbol)) typed.push(access);
    }
    return { typed, untyped };
  }
  /**
   * Where a member is written (replaced), else null (W4): through a receiver the checker types as its class or through
   * anything that holds the object (`this` included, whatever wrapper or assertion is around it), by a dot or a key W1
   * fixes. A receiver the checker does not type (any, unknown) cannot hold the object: an instance or a class reaches one
   * only through a use of a holder, which objectUse() rejects, and code outside the program is taken to keep TypeScript's
   * private members.
   */
  function memberChanged(symbol) {
    const { typed } = memberRefs(symbol);
    const written = typed.find(access => mutated(outer(access)));
    if (written) return where(written);
    const [declaration] = symbol.declarations ?? [];
    const object = declaration && holdingObject(declaration);
    return object ? objectWrites(object).get(memberKey(symbol)) ?? null : null;
  }
  const writtenThrough = { class: new Map(), instance: new Map() };
  /** The members written through what holds a class or its instances (a holder, then a member by a key W1 fixes). */
  function objectWrites(object) {
    const memo = writtenThrough[object.kind];
    if (memo.has(object.declaration)) return memo.get(object.declaration);
    const found = new Map();
    memo.set(object.declaration, found);
    for (const holder of new Set(holdersOf(object))) {
      let node = holder;
      while (WRAPPERS.has(node.parent.kind)) node = node.parent;
      const parent = node.parent;
      if (!isAccess(parent) || parent.expression !== node) continue;
      const { key } = w1(parent);
      if (key !== undefined && mutated(outer(parent)) && !found.has(key)) found.set(key, where(parent));
    }
    return found;
  }

  /** The object a class member is reached through: the class (static) or its instances. */
  const holdingObject = declaration => (ts.isClassLike(declaration.parent)
    ? { kind: isStatic(declaration) ? 'class' : 'instance', declaration: declaration.parent } : null);
  const objectName = object => `${{ class: 'the class', instance: 'an instance of' }[object.kind]} \`${object.declaration.name?.getText() ?? 'an anonymous class'}\``;
  const classOf = node => resolve(node && checker.getSymbolAtLocation(node))?.declarations?.[0];
  /** The class a class expression or declaration extends, when the program has it; else null. */
  const baseOf = declaration => {
    const heritage = declaration.heritageClauses?.find(clause => clause.token === K.ExtendsKeyword)?.types[0];
    const expression = heritage && bare(heritage.expression);
    const found = expression && classOf(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    return found && ts.isClassLike(found) && inProgram(found) ? found : null;
  };
  let classes = null;
  const families = new Map();
  /** A class with its bases and its subclasses in the program: an instance of it may run the code of any of them. */
  function familyOf(declaration) {
    if (families.has(declaration)) return families.get(declaration);
    if (!classes) {
      classes = [];
      const walk = node => { if (ts.isClassLike(node)) classes.push(node); ts.forEachChild(node, walk); };
      files.forEach(walk);
    }
    const found = new Set();
    for (let at = declaration; at && !found.has(at); at = baseOf(at)) found.add(at);
    const descends = other => { for (let at = baseOf(other), seen = new Set(); at && !seen.has(at); seen.add(at), at = baseOf(at)) if (at === declaration) return true; return false; };
    for (const other of classes) if (descends(other)) found.add(other);
    families.set(declaration, found);
    return found;
  }
  let selves = null;
  /** Every `this` and `super` of the program's sources, with the class it stands for and its side (static or not). */
  function thisUses() {
    if (selves) return selves;
    selves = [];
    const owner = node => {
      for (let at = node.parent; at; at = at.parent) {
        if (ts.isArrowFunction(at)) continue;
        if (ts.isClassStaticBlockDeclaration(at)) return { declaration: at.parent, static: true };
        if ((ts.isPropertyDeclaration(at) || ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at) || ts.isGetAccessorDeclaration(at)
          || ts.isSetAccessorDeclaration(at)) && ts.isClassLike(at.parent)) return { declaration: at.parent, static: isStatic(at) };
        if (ts.isFunctionLike(at) || ts.isClassLike(at)) return null;
      }
      return null;
    };
    const walk = node => {
      if (node.kind === K.ThisKeyword || node.kind === K.SuperKeyword) selves.push({ node, ...(owner(node) ?? { declaration: null, static: false }) });
      ts.forEachChild(node, walk);
    };
    files.forEach(walk);
    return selves;
  }
  /** An identifier that names (a declaration, a member, a label, an import or export) rather than stands for a value. */
  const nameOnly = node => !!accessOf(node) || ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)
    || ts.isLabeledStatement(node.parent) || ts.isBreakOrContinueStatement(node.parent)
    || ('name' in node.parent && node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent));
  let typedValues = null;
  /** The value expressions of the program by each program class they have the instance type of (each of a union's). A
   *  name or a dot is taken at its declared type, which holds every type narrowing leaves it. */
  function instancesTyped(declaration) {
    if (!typedValues) {
      typedValues = new Map();
      const declared = symbol => (symbol ? checker.getTypeOfSymbol(symbol) : null);
      const walk = node => {
        if (ts.isTypeNode(node)) return;
        const type = ts.isIdentifier(node) ? (nameOnly(node) ? null : declared(symbolAt(node)))
          : ts.isPropertyAccessExpression(node) ? declared(resolve(checker.getSymbolAtLocation(node.name)))
            : ts.isElementAccessExpression(node) || ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)
              || ts.isAwaitExpression(node) ? checker.getTypeAtLocation(node) : null;
        if (type) {
          for (const part of type.isUnionOrIntersection() ? type.types : [type]) {
            const target = part.objectFlags & ts.ObjectFlags.Reference ? part.target : part;
            if (!(target.objectFlags & ts.ObjectFlags.Class)) continue;
            for (const found of target.symbol?.declarations ?? []) {
              if (!ts.isClassLike(found)) continue;
              if (!typedValues.has(found)) typedValues.set(found, []);
              typedValues.get(found).push(node);
            }
          }
        }
        ts.forEachChild(node, walk);
      };
      files.forEach(walk);
    }
    return typedValues.get(declaration) ?? [];
  }
  /** The class a reference stands in the `extends` clause of, else null. */
  const extendedBy = node => (ts.isExpressionWithTypeArguments(node.parent) && ts.isHeritageClause(node.parent.parent)
    && node.parent.parent.token === K.ExtendsKeyword && ts.isClassLike(node.parent.parent.parent) ? node.parent.parent.parent : null);
  const inTypePosition = node => !extendedBy(node) && (ts.isTypeNode(node.parent) || ts.isQualifiedName(node.parent));
  /** What holds a class or its instances: the uses of the class name, `this` and `super` in its code (for an instance, its
   *  program bases' and subclasses' code too), and every value typed as an instance of its family. */
  function holdersOf(object) {
    const { kind, declaration } = object;
    const named = () => references(symbolAt(declaration.name)).filter(node => !inTypePosition(node)).map(node => accessOf(node) ?? node);
    const members = kind === 'instance' ? familyOf(declaration) : new Set([declaration]);
    const selves = thisUses().filter(self => self.declaration && members.has(self.declaration) && self.static === (kind === 'class')).map(self => self.node);
    return kind === 'class' ? [...(declaration.name ? named() : []), ...selves] : [...selves, ...[...members].flatMap(instancesTyped)];
  }
  const objects = { class: new Map(), instance: new Map() };
  const SHARED = new Set(['prototype', 'constructor', '__proto__']);
  /**
   * W4: what the program does with a class or its instances — `escape`, why a member reached through it may not run the
   * body the program declares (null when every use keeps to the program), and `writes`, the members written through it.
   * Every use of every holder is read: a member read or written by a key W1 fixes, a call of a method whose body the
   * program has and nothing replaces, a test, `new`; `this` handed on (an argument, an alias, a return, a store), a key
   * W1 does not fix, a prototype, a decorator or a replaced method is an escape.
   */
  function objectUse(object) {
    const memo = objects[object.kind];
    if (memo.has(object.declaration)) return memo.get(object.declaration) ?? { escape: 'is reached again while its uses are checked', writes: [] };
    memo.set(object.declaration, null);
    const result = { escape: null, writes: [] };
    if (object.kind === 'class') {
      const decorator = ts.canHaveDecorators(object.declaration) ? ts.getDecorators(object.declaration)?.[0] : undefined;
      const instance = objectUse({ kind: 'instance', declaration: object.declaration }).escape;
      result.escape = decorator ? `is handed to the decorator at ${where(decorator)}` : instance ? `is reached through an instance, which ${instance}` : null;
    }
    if (object.kind === 'instance') {
      // An instance's members live on it and on its classes' prototypes: a prototype reached through a class name (or its
      // `this` in static code) is the instance's too. The class handed on otherwise is the class's (its static members).
      const through = node => { let at = node; while (WRAPPERS.has(at.parent.kind)) at = at.parent; return isAccess(at.parent) && at.parent.expression === at ? at.parent : null; };
      const reached = [...familyOf(object.declaration)].flatMap(member => holdersOf({ kind: 'class', declaration: member })).map(through)
        .find(access => access && SHARED.has(w1(access).key ?? 'prototype'));
      if (reached) result.escape = `is reached through \`${snippet(reached)}\` at ${where(reached)}`;
    }
    for (const node of result.escape ? [] : new Set(holdersOf(object))) {
      result.escape = holderUse(object, node, result.writes);
      if (result.escape) break;
    }
    memo.set(object.declaration, result);
    return result;
  }
  /** Why the use `start` (a node holding a class or an instance) may change it or hand it on, else null; a member write is
   *  recorded in `writes` (W4: a write of a member no positive judgement reads, such as a count, stays allowed). */
  function holderUse(object, start, writes) {
    let node = start;
    while (WRAPPERS.has(node.parent.kind)) node = node.parent;
    const parent = node.parent;
    if (isAccess(parent) && parent.expression === node) {
      const { key, why } = w1(parent);
      if (key === undefined) return `is read by a key the program does not fix at ${where(parent)} (${why})`;
      if (SHARED.has(key)) return `is handed on through \`${snippet(parent)}\` at ${where(parent)}`;
      const member = outer(parent), use = member.parent;
      const called = (ts.isCallExpression(use) && use.expression === member) || (ts.isTaggedTemplateExpression(use) && use.tag === member);
      const foreign = foreignThis(object, start, key, parent, called);
      if (foreign) return foreign;
      if (mutated(member)) writes.push({ key, at: where(parent) });
      return null;
    }
    if (mutated(node)) return `is written at ${where(parent)}`;
    if (inert(node) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return null;
    if (object.kind === 'class' && ts.isNewExpression(parent) && parent.expression === node) return null;
    if (start.kind === K.SuperKeyword && ts.isCallExpression(parent) && parent.expression === node) {
      const self = thisUses().find(entry => entry.node === start);
      return self?.declaration && baseOf(self.declaration) ? null : `is handed on as \`this\` of the base constructor at ${where(parent)}`;
    }
    if (object.kind === 'class' && extendedBy(node)) return `is extended at ${where(extendedBy(node))}`;
    return `is handed on at ${where(parent)}`;
  }
  /** Why reaching the member `key` of a class or an instance through `holder` may run code with it as `this` that the check
   *  does not read, else null: every declaration of the name the holder's type and the family have must be a method or an
   *  accessor with a body in the program that nothing replaces (a dot, a key W1 fixes or a receiver the checker does not
   *  type; Astra S7-U3a-F-R-001-F01), or, called, a field whose one value is an arrow function nothing replaces. */
  function foreignThis(object, holder, key, access, called) {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(holder));
    const family = object.kind === 'instance' ? [...familyOf(object.declaration)] : [object.declaration];
    const accessor = found => ts.isGetAccessorDeclaration(found) || ts.isSetAccessorDeclaration(found);
    const kept = found => !memberChanged(symbolAt(found.name));
    const own = found => (ts.isMethodDeclaration(found) || accessor(found)) && !!found.body && inProgram(found) && kept(found);
    const arrow = found => ts.isPropertyDeclaration(found) && !!found.initializer && ts.isArrowFunction(bare(found.initializer)) && inProgram(found) && kept(found);
    const named = [...(checker.getPropertyOfType(type, key)?.declarations ?? []), ...family.flatMap(declaration => declaration.members.filter(member =>
      member.name && !ts.isComputedPropertyName(member.name) && member.name.text === key && isStatic(member) === (object.kind === 'class')))];
    const code = called ? named : named.filter(accessor);
    if ((called && !named.length) || !code.every(found => own(found) || (called && arrow(found)))) {
      const replaced = named.map(found => found.name && memberChanged(symbolAt(found.name))).find(Boolean);
      return `is handed on as \`this\` of \`${snippet(access)}\` at ${where(access)}${replaced ? ` (replaced at ${replaced})` : ''}`;
    }
    return null;
  }

  // ── W3: functions, their calls and their callbacks ──
  const describe = owner => (owner.name ? `\`${owner.name.getText()}\` (${where(owner)})` : `the function at ${where(owner)}`);
  const decorated = node => ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
  const shift = owner => (owner.parameters[0]?.name.getText() === 'this' ? 1 : 0);
  /** Whether a function, a const or a class is exported from its file (a modifier, `export { name }`, `export default name`). */
  function isExported(declaration) {
    const statement = ts.isVariableDeclaration(declaration) ? declaration.parent?.parent : declaration;
    if (statement && ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === K.ExportKeyword)) return true;
    const name = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    return !!name && declaration.getSourceFile().statements.some(statement => (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(element => (element.propertyName ?? element.name).text === name))
      || (ts.isExportAssignment(statement) && ts.isIdentifier(bare(statement.expression)) && bare(statement.expression).text === name));
  }
  /** The const declaration an arrow or function expression is the value of, else null. */
  const constHolder = fn => { const held = outer(fn), parent = held.parent; return isConst(parent) && parent.initializer === held && ts.isIdentifier(parent.name) ? parent : null; };
  /**
   * W3: the kind of helper `fn` is — a private method of its class, a function of its file that is not exported, a const
   * arrow or function expression that is not exported, or a callback written where it is passed — else why callers
   * outside the program can call it.
   */
  function helperKind(fn) {
    if (!fn.body) return { why: 'which has no body in this program' };
    if (decorated(fn) || fn.parameters.some(decorated)) return { why: 'which callers outside this program can call (it is decorated)' };
    if (ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent)) {
      const own = (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Private) || (fn.name && ts.isPrivateIdentifier(fn.name));
      return own ? { kind: 'private method' } : { why: 'which callers outside this program can call' };
    }
    if (ts.isFunctionDeclaration(fn)) return isExported(fn) ? { why: 'which callers outside this program can call (it is exported)' } : { kind: 'function of its file' };
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      const holder = constHolder(fn);
      if (holder) return isExported(holder) ? { why: 'which callers outside this program can call (it is exported)' } : { kind: 'const function' };
      return { kind: 'callback' };
    }
    return { why: `which callers outside this program can call (a ${K[fn.kind]})` };
  }
  const W3_KINDS = new Set(['private method', 'function of its file', 'const function', 'callback']);
  /** The node a value reaches its use through: parentheses and type wrappers (W1 notation). */
  const lifted = node => { let at = node; while (at.parent && WRAPPERS.has(at.parent.kind)) at = at.parent; return at; };
  const calls = { w3: new Map(), flow: new Map() };
  /**
   * The calls of `fn` (W3), with `escapes` when it may be run some other way. A name's every reference must be the callee
   * of a call, a test, or — the one callback rule W3 has (the `scopeWrite` form) — an argument of a call whose parameter
   * is itself only called or tested where it is received. A method is found by every access W1 keys to its name (one on a
   * value the checker does not type may be it), must be replaced nowhere, and its object must keep to the program (W4).
   * In mode 'w3' (values read through parameters) a function callers outside the program can call is an escape and
   * callbacks go between helpers of one file; in mode 'flow' (the client and fragment flows) a public method or an
   * exported function is followed through the references the program has of it.
   */
  function callsOf(fn, mode) {
    const memo = calls[mode];
    if (memo.has(fn)) return memo.get(fn) ?? { calls: [], escapes: [`${describe(fn)} (reached again while its calls are being found)`] };
    memo.set(fn, null);
    const found = [], escapes = [];
    const kind = helperKind(fn);
    if (kind.why && mode === 'w3') escapes.push(`${describe(fn)}, ${kind.why}`);
    else if (!fn.body) escapes.push(`${describe(fn)} (no body)`);
    else {
      for (const reference of carriersOf(fn, escapes)) {
        const node = lifted(reference), parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node) found.push(parent);
        else if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
          const index = parent.arguments.indexOf(node);
          const targets = mode === 'w3' && fn.getSourceFile() !== parent.getSourceFile() ? null : argumentTargets(parent, index, mode);
          if (!targets) { escapes.push(`${where(parent)} (handed to \`${snippet(parent.expression)}\`)`); continue; }
          for (const target of targets) {
            for (const use of references(symbolAt(target.name))) {
              const at = lifted(use), user = at.parent;
              if (ts.isCallExpression(user) && user.expression === at) found.push(user);
              else if (!inert(at)) escapes.push(`${where(user)} (\`${target.name.getText()}\`, the parameter it is handed to, is used in a ${K[user.kind]})`);
            }
          }
        } else if (!inert(node) && !ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent)) escapes.push(`${where(parent)} (${K[parent.kind]})`);
      }
    }
    const result = { calls: [...new Set(found)], escapes };
    memo.set(fn, result);
    return result;
  }
  /** Where the value of `fn` is referenced: a method's W1-keyed accesses (W4 on its object), a function's or const's
   *  references (it replaced nowhere), a callback's own place. */
  function carriersOf(fn, escapes) {
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !constHolder(fn)) return [fn];
    const holder = constHolder(fn);
    if (holder) return references(symbolAt(holder.name));
    const symbol = fn.name ? symbolAt(fn.name) : null;
    if (!symbol) { escapes.push(`${where(fn)} (no name to follow)`); return []; }
    if (!ts.isMethodDeclaration(fn)) {
      const replaced = writesOf(symbol);
      for (const at of [...replaced.plain.map(right => right.parent), ...replaced.other.map(write => write.at)]) escapes.push(`${where(at)} (it is replaced)`);
      return references(symbol).map(node => accessOf(node) ?? node);
    }
    // Its calls are the accesses typed as it; one on a value the checker does not type cannot reach the object while its
    // holders keep to the program (W4 below).
    const { typed } = memberRefs(symbol);
    const replaced = memberChanged(symbol);
    if (replaced) escapes.push(`${replaced} (the method is replaced)`);
    const object = holdingObject(fn), escape = object && objectUse(object).escape;
    if (escape) escapes.push(`${where(fn)} (${objectName(object)}, which ${escape})`);
    return typed;
  }
  /** The parameters that receive argument `index` of `call`, or null when a callee or the parameter is not fixed. An arrow
   *  function without that parameter never sees the argument (it has no `arguments`). */
  function argumentTargets(call, index, mode) {
    if (call.arguments.slice(0, index).some(ts.isSpreadElement)) return null;
    const owners = callees(call, mode);
    if (!owners) return null;
    const targets = [];
    for (const owner of owners) {
      const parameter = owner.parameters[index + shift(owner)];
      if (!parameter && ts.isArrowFunction(owner) && !owner.parameters.some(item => item.dotDotDotToken)) continue;
      if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return null;
      targets.push(parameter);
    }
    return targets;
  }
  /** The functions a call runs (W3; in mode 'flow' also a method of a program class reached through a receiver typed as
   *  it, W4, and a function a file imports directly), else null. */
  function callees(call, mode) {
    if (ts.isNewExpression(call)) {
      if (mode === 'w3') return null;
      const declaration = classOf(call.expression);
      const constructor = declaration && ts.isClassLike(declaration) ? declaration.members.find(ts.isConstructorDeclaration) : null;
      return constructor?.body ? [constructor] : null;
    }
    return functionsOf(call.expression, mode);
  }
  const functions = { w3: new Map(), flow: new Map() };
  function functionsOf(expression, mode) {
    const node = bare(expression), memo = functions[mode];
    if (memo.has(node)) return memo.get(node) === undefined ? null : memo.get(node);
    memo.set(node, undefined);
    const found = functionValue(node, mode);
    memo.set(node, found ?? undefined);
    return found;
  }
  function functionValue(node, mode) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [node];
    if (ts.isIdentifier(node)) {
      const own = checker.getSymbolAtLocation(node);
      if (own && own.flags & ts.SymbolFlags.Alias && mode === 'w3') return null;   // W3: a helper of the same file
      const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
      if (declarations.length !== 1) return null;
      if (changedBinding(symbol) || parameterHazard(declaration)) return null;
      if (ts.isFunctionDeclaration(declaration)) {
        const replaced = writesOf(symbol);
        if (!declaration.body || replaced.plain.length || replaced.other.length) return null;
        return mode === 'flow' || W3_KINDS.has(helperKind(declaration).kind) ? [declaration] : null;
      }
      if (isConst(declaration) && declaration.initializer && ts.isIdentifier(declaration.name)) {
        const value = bare(declaration.initializer);
        if (!(ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return null;
        return mode === 'flow' || W3_KINDS.has(helperKind(value).kind) ? [value] : null;
      }
      if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent) && ts.isIdentifier(declaration.name) && !declaration.dotDotDotToken) {
        const owner = declaration.parent, index = owner.parameters.indexOf(declaration) - shift(owner);
        const replaced = writesOf(symbol);
        if (replaced.plain.length || replaced.other.length) return null;
        const { calls: found, escapes } = callsOf(owner, mode);
        if (escapes.length || !found.length) return null;
        const values = [];
        for (const call of found) {
          if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return null;
          const argument = call.arguments[index] ?? declaration.initializer;
          if (!argument) continue;
          const at = bare(argument);
          if (at.kind === K.NullKeyword || (ts.isIdentifier(at) && at.text === 'undefined' && !symbolAt(at)?.declarations?.length)) continue;
          if (mode === 'w3' && argument.getSourceFile() !== node.getSourceFile()) return null;
          const inner = functionsOf(argument, mode);
          if (!inner) return null;
          values.push(...inner);
        }
        return values;
      }
      return null;
    }
    if (isAccess(node)) {
      const { key } = w1(node);
      if (key === undefined) return null;
      const receiver = bare(node.expression);
      // W3: a private method called on `this` (or, static, on its class's name) in its own file.
      const named = ts.isIdentifier(receiver) ? classOf(receiver) : null;
      if (mode === 'w3' && receiver.kind !== K.ThisKeyword && !(named && ts.isClassLike(named))) return null;
      const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
      const property = checker.getPropertyOfType(type, key), declarations = property?.declarations ?? [];
      if (!declarations.length || !declarations.every(declaration => ts.isMethodDeclaration(declaration) && declaration.body && inProgram(declaration)
        && ts.isClassLike(declaration.parent))) return null;
      if (mode === 'w3' && !declarations.every(declaration => helperKind(declaration).kind === 'private method'
        && declaration.getSourceFile() === node.getSourceFile())) return null;
      for (const declaration of declarations) {
        if (memberChanged(symbolAt(declaration.name))) return null;
        const object = holdingObject(declaration);
        if (objectUse(object).escape) return null;
        // An override in the family runs instead of it on some instances: every one is a method with a body too.
        const family = object.kind === 'instance' ? [...familyOf(object.declaration)] : [object.declaration];
        for (const other of family.flatMap(member => member.members.filter(item => item.name && !ts.isComputedPropertyName(item.name)
          && item.name.text === key && isStatic(item) === isStatic(declaration)))) {
          if (!ts.isMethodDeclaration(other) || !other.body || memberChanged(symbolAt(other.name))) return null;
          if (!declarations.includes(other)) declarations.push(other);
        }
      }
      return [...new Set(declarations)];
    }
    return null;
  }

  // ── W2: action values ──
  const text = (value, from = [], rule = 'W2 literal') => ({ key: 't' + value, text: value, from, rules: [rule] });
  const prefix = (value, why, rules = []) => ({ key: 'p' + value, prefix: value, why, rules });
  const unknown = why => ({ key: 'u' + why, unknown: why, rules: [] });
  function union(...lists) {
    const out = new Map();
    for (const value of lists.flat()) {
      const known = out.get(value.key);
      out.set(value.key, known ? { ...known, from: [...new Set([...(known.from ?? []), ...(value.from ?? [])])],
        rules: [...new Set([...known.rules, ...value.rules])] } : value);
    }
    return [...out.values()];
  }
  const tagged = (found, rule) => found.map(value => ({ ...value, rules: [...new Set([...value.rules, rule])] }));
  /** Every value a text, or null. */
  const texts = found => (found.length > 0 && found.every(value => value.text !== undefined) ? [...new Set(found.map(value => value.text))] : null);
  /** W2 (i) `left + right` and templates: fixed pieces join; a fixed start with anything after it is a prefix. */
  const concat = (left, right) => union(left.flatMap(l => right.map(r => {
    const rules = [...new Set([...l.rules, ...r.rules, 'W2(i) + or template'])];
    if (l.text === undefined) return l.prefix !== undefined ? { ...l, rules } : l;
    if (r.text !== undefined) return { ...text(l.text + r.text), rules };
    if (r.prefix !== undefined) return prefix(l.text + r.prefix, r.why, rules);
    return prefix(l.text, r.unknown, [...rules, 'W2 prefix']);
  })));
  const memo = new Map(), active = new Set();
  /** W2: the values an action takes — a finite list; anything else is unresolved with where and why. */
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
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce((sum, span) => concat(concat(sum, values(span.expression)), [text(span.literal.text)]), [text(node.head.text)]);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.PlusToken) return concat(values(node.left), values(node.right));
    if (ts.isConditionalExpression(node)) return tagged(union(values(node.whenTrue), values(node.whenFalse)), 'W2(ii) ?:');
    if (ts.isIdentifier(node) && node.text === 'undefined' && !symbolAt(node)?.declarations?.length) return [unknown(`${where(node)}: \`undefined\` is no value`)];
    if (ts.isIdentifier(node)) return named(symbolAt(node), node);
    if (isAccess(node)) return [unknown(`${where(node)}: \`${snippet(node)}\` is a property the program does not fix (W2 reads no property: no enum, \`as const\` table, readonly field or namespace)`)];
    if (ts.isBinaryExpression(node)) return [unknown(`${where(node)}: \`${snippet(node)}\` is a ${ts.tokenToString(node.operatorToken.kind)} expression, outside W2`)];
    return [unknown(`${where(node)}: \`${snippet(node)}\` is a ${K[node.kind]}, outside W2`)];
  }
  /** Why a name reaches its declaration through something other than its own file or one direct import, else null. */
  function throughExport(use) {
    const own = ts.isShorthandPropertyAssignment(use.parent) && use.parent.name === use
      ? checker.getShorthandAssignmentValueSymbol(use.parent) : checker.getSymbolAtLocation(use);
    if (!own || !(own.flags & ts.SymbolFlags.Alias)) return null;
    const [declaration] = own.declarations ?? [];
    if (!declaration || !ts.isImportSpecifier(declaration)) return `is imported as ${declaration ? K[declaration.kind] : 'nothing'}`;
    const next = checker.getImmediateAliasedSymbol(own);
    return next && next.flags & ts.SymbolFlags.Alias ? `reaches its value through the re-export at ${where(next.declarations[0])}` : null;
  }
  /** W2: the values of what `symbol` is bound to, read at `use`. */
  function named(symbol, use) {
    const name = ts.isIdentifier(use) ? use.text : snippet(use);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length !== 1) {
      return [unknown(`${where(use)}: \`${name}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}`)];
    }
    const [declaration] = declarations;
    const exported = throughExport(use);
    if (exported) return [unknown(`${where(use)}: \`${name}\` ${exported} (W2 reads a const of its file or of one direct import)`)];
    let found;
    if (isConst(declaration) && ts.isIdentifier(declaration.name)) {
      if (!declaration.initializer) return [unknown(`${where(declaration)}: \`${name}\` is declared without a value`)];
      found = tagged(values(declaration.initializer), declaration.getSourceFile() === use.getSourceFile() ? `W2 const \`${name}\`` : `W2 imported const \`${name}\``);
    } else if (isLet(declaration) && ts.isIdentifier(declaration.name)) {
      if (!localToFunction(declaration)) return [unknown(`${where(use)}: \`${name}\` is a let of its module, outside W2 (a let of a function only)`)];
      if (!declaration.initializer) return [unknown(`${where(declaration)}: \`${name}\` is declared without a value`)];
      found = tagged(values(declaration.initializer), `W2(iii) let \`${name}\``);
    } else if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent)) {
      found = tagged(passed(declaration), `W3 parameter \`${name}\` of ${describe(declaration.parent)}`);
    } else if (ts.isVariableDeclaration(declaration)) {
      return [unknown(`${where(use)}: \`${name}\` is a var, outside W2`)];
    } else {
      return [unknown(`${where(use)}: \`${name}\` is a ${K[declaration.kind]}, outside W2 (no enum, \`as const\` table, readonly field or namespace)`)];
    }
    if (!isConst(declaration)) {
      const { plain, other } = writesOf(symbol);
      if (other.length) return union(found, [unknown(`${where(other[0].at)}: \`${name}\` is changed by \`${snippet(other[0].at)}\``)]);
      if (plain.length) return union(found, ...plain.map(right => tagged(values(right), `W2(iii) assignment to \`${name}\``)));
    }
    // W2 (iv): a binding nothing changes keeps its value, and a preceding exit for every other value limits it here.
    const limit = found.some(value => value.text === undefined) ? limited(use, symbol) : null;
    return limit ? limit.members.filter(member => found.some(value => value.text === undefined || value.text === member))
      .map(member => ({ ...text(member), rules: [`W2(iv) the guard at ${where(limit.at)}`] })) : found;
  }
  /** A let declared in a function's body (not at the top of a module). */
  const localToFunction = declaration => {
    for (let at = declaration.parent; at; at = at.parent) {
      if (ts.isFunctionLike(at)) return true;
      if (ts.isSourceFile(at) || ts.isModuleBlock(at)) return false;
    }
    return false;
  };
  /** W3: the values every call the program makes of a helper passes for its parameter. */
  function passed(parameter) {
    const owner = parameter.parent, name = parameter.name.getText();
    if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return [unknown(`${where(parameter)}: \`${name}\` is a rest or destructured parameter`)];
    const kind = helperKind(owner);
    if (kind.why) return [unknown(`${where(parameter)}: \`${name}\` is a parameter of ${describe(owner)}, ${kind.why}`)];
    const index = owner.parameters.indexOf(parameter) - shift(owner);
    const { calls: found, escapes } = callsOf(owner, 'w3');
    if (escapes.length) return [unknown(`${where(parameter)}: \`${name}\` is a parameter of ${describe(owner)}, which is handed on at ${escapes.join(', ')}`)];
    if (!found.length) return [unknown(`${where(parameter)}: \`${name}\` is a parameter of ${describe(owner)}, which nothing in the program calls`)];
    return union(...found.map(call => {
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return [unknown(`${where(call)}: a spread argument`)];
      const argument = call.arguments[index];
      return argument ? values(argument) : parameter.initializer ? values(parameter.initializer) : [unknown(`${where(call)}: no argument for \`${name}\``)];
    }));
  }
  // W2 (iv): a guard `if (... || !['a', 'b'].includes(x) || ...) throw/return;` before the use.
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
      if (!isAccess(callee) || call.arguments.length !== 1 || w1(callee).key !== 'includes') continue;
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
  /** A member of the Prisma namespace import (`Prisma.sql`, `Prisma.raw` ...) by a key W1 fixes: its name, else null. */
  const prismaMember = node => {
    const at = bare(node);
    return isAccess(at) && ts.isIdentifier(bare(at.expression)) && prismaImport(bare(at.expression)) !== null ? w1(at).key ?? null : null;
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
    return isAccess(callee) && w1(callee).key === '$transaction';
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
      const { key } = w1(node);
      if (key === undefined) return false;
      const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), key);
      return symbol ? heldClient(resolve(symbol)) : clientMembers.has(key);
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
        || (clientFunctions.size > 0 && !!callees(node, 'flow')?.some(owner => clientFunctions.has(owner)));
    }
    return false;
  }

  // ── W4 over every SQL fragment (Astra S7-U3a-AUDIT-SPEC-C-R-001-F02) ──
  /** Prisma's Sql class (the fragment type `Prisma.sql`, `raw`, `join`, `empty` and `new Sql` give). */
  const isSqlClass = type => {
    const symbol = type?.symbol ?? type?.aliasSymbol;
    return symbol?.name === 'Sql' && !!symbol.declarations?.some(declaration => /[\\/]node_modules[\\/](?:@prisma|\.prisma)[\\/]/.test(declaration.getSourceFile().fileName));
  };
  const sqlTypes = new Map();
  /** Whether a value of `type` may be or hold an SQL fragment: Sql, a union with it, an array, promise or other generic of
   *  it, or a function or class whose call or construction gives one. */
  function containsSql(type, depth = 0) {
    if (!type || depth > 5) return false;
    if (sqlTypes.has(type)) return sqlTypes.get(type);
    sqlTypes.set(type, false);
    let found = isSqlClass(type);
    if (!found && type.isUnionOrIntersection()) found = type.types.some(part => containsSql(part, depth + 1));
    if (!found && type.objectFlags & ts.ObjectFlags.Reference) found = checker.getTypeArguments(type).some(part => containsSql(part, depth + 1));
    if (!found) found = [...type.getCallSignatures(), ...type.getConstructSignatures()].some(signature => containsSql(checker.getReturnTypeOfSignature(signature), depth + 1));
    sqlTypes.set(type, found);
    return found;
  }
  const RAW = new Set(['$executeRaw', '$queryRaw', '$executeRawUnsafe', '$queryRawUnsafe']);
  /** Where a fragment ends up is one of these, else it is handed on (the reason). The value is lifted through
   *  parentheses, `!`, `satisfies`, `await`, both sides of ?:, ||, ?? and && and an array literal; an assertion to a type
   *  that holds no fragment is a hand-on (the fragment would pass for something else). */
  function fragmentUse(origin) {
    let node = origin;
    for (;;) {
      const parent = node.parent;
      if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isAwaitExpression(parent)
        || (ts.isConditionalExpression(parent) && parent.condition !== node)
        || (ts.isBinaryExpression(parent) && (CHOICES.has(parent.operatorToken.kind) || (parent.operatorToken.kind === K.CommaToken && parent.right === node)))
        || ts.isArrayLiteralExpression(parent)) { node = parent; continue; }
      if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) {
        if (containsSql(checker.getTypeAtLocation(parent))) { node = parent; continue; }
        return { use: parent, why: `is asserted to \`${parent.type.getText()}\` at ${where(parent)}` };
      }
      break;
    }
    const parent = node.parent;
    const found = why => ({ use: node, why });
    if (ts.isArrayLiteralExpression(node) && !(ts.isCallExpression(parent) && prismaMember(parent.expression) === 'join')
      && !(isConst(parent) && parent.initializer === node && ts.isIdentifier(parent.name))) {
      return found(`is kept in an array at ${where(node)}`);
    }
    if (ts.isTemplateSpan(parent) && parent.expression === node) {
      const template = parent.parent, holder = template.parent;
      if (!ts.isTaggedTemplateExpression(holder)) return null;   // an untagged template makes it a string
      const tag = bare(holder.tag);
      if (prismaMember(tag) === 'sql' || (isAccess(tag) && RAW.has(w1(tag).key))) return null;
      return found(`is handed to the tag \`${snippet(holder.tag)}\` at ${where(holder)}`);
    }
    if ((ts.isCallExpression(parent) && parent.expression === node) || (ts.isTaggedTemplateExpression(parent) && parent.tag === node)
      || (ts.isNewExpression(parent) && parent.expression === node)) return null;   // run: what it gives is read where it goes
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
      const callee = bare(parent.expression);
      if ((isAccess(callee) && RAW.has(w1(callee).key)) || ['join', 'sql', 'raw'].includes(prismaMember(callee))) return null;
      if (isAccess(callee) && w1(callee).key === 'map' && parent.arguments[0] === node && lib(checker.getResolvedSignature(parent)?.declaration ?? parent)) {
        return fragmentUse(parent);   // Array#map gives exactly what the callback returns, in a new array
      }
      const index = parent.arguments.indexOf(node), targets = argumentTargets(parent, index, 'flow');
      if (!targets) return found(`is handed to \`${snippet(parent.expression)}\` at ${where(parent)}, which this check does not follow`);
      const loose = targets.find(target => !containsSql(checker.getTypeOfSymbol(symbolAt(target.name))));
      return loose ? found(`is handed to \`${snippet(parent.expression)}\` at ${where(parent)}, whose parameter \`${loose.name.getText()}\` is typed \`${typeText(checker.getTypeOfSymbol(symbolAt(loose.name)))}\``) : null;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      if (!ts.isIdentifier(parent.name)) return found(`is destructured at ${where(parent)}`);
      const type = checker.getTypeOfSymbol(symbolAt(parent.name));
      return containsSql(type) ? null : found(`is kept in \`${parent.name.text}\`, typed \`${typeText(type)}\`, at ${where(parent)}`);
    }
    if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === K.EqualsToken) {
      const left = bare(parent.left);
      return ts.isIdentifier(left) && containsSql(checker.getTypeOfSymbol(symbolAt(left) ?? checker.getSymbolAtLocation(left))) ? null
        : found(`is assigned to \`${snippet(parent.left)}\` at ${where(parent)}`);
    }
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
      let owner = parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      const signature = owner && checker.getSignatureFromDeclaration(owner);
      return signature && containsSql(checker.getReturnTypeOfSignature(signature)) ? null : found(`is returned at ${where(parent)} from a function typed \`${signature ? typeText(checker.getReturnTypeOfSignature(signature)) : '?'}\``);
    }
    if (inert(node) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isTypeQueryNode(parent)) return null;
    if (isAccess(parent) && parent.expression === node) {
      // A part of the fragment: its text, read, is harmless; written or handed on, the fragment is no longer the one read.
      let member = parent;
      for (;;) {
        const held = outer(member);
        if (mutated(held)) return found(`is written at ${where(held.parent)}`);
        if (valueType(checker.getTypeAtLocation(held)) && !checker.isArrayType?.(checker.getTypeAtLocation(held))) return null;
        const next = held.parent;
        if (isAccess(next) && next.expression === held) { member = next; continue; }
        if (ts.isCallExpression(next) && next.expression === held) return null;   // a method of the fragment's own class
        return inert(held) ? null : found(`hands a part of it on at ${where(next)}`);
      }
    }
    return found(`is used in a ${K[parent.kind]} at ${where(parent)}`);
  }
  const ORIGINS = new Set([K.Identifier, K.PropertyAccessExpression, K.ElementAccessExpression, K.CallExpression, K.NewExpression,
    K.TaggedTemplateExpression, K.ArrowFunction, K.FunctionExpression]);
  /** Every value of the program TypeScript types as a fragment (or a builder of one), each checked where it goes. */
  function fragmentFlow() {
    const reported = new Set();
    const walk = node => {
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
      // A name written (`selector = …`) is not a use of the fragment it held; what is written is read where it comes from.
      const written = ts.isIdentifier(node) && ts.isBinaryExpression(lifted(node).parent) && lifted(node).parent.left === lifted(node)
        && lifted(node).parent.operatorToken.kind === K.EqualsToken;
      if (ORIGINS.has(node.kind) && !written && !(ts.isIdentifier(node) && (nameOnly(node) || inTypePosition(node)))
        && !(ts.isIdentifier(node) && node.text === 'undefined') && containsSql(checker.getTypeAtLocation(node))) {
        const escaped = fragmentUse(node);
        if (escaped && !reported.has(escaped.use)) {
          reported.add(escaped.use);
          note(node, 'SQL fragment', 'unresolved', `\`${snippet(node)}\` (${typeText(checker.getTypeAtLocation(node))}) ${escaped.why}`, 'W4 fragments');
        }
      }
      ts.forEachChild(node, walk);
    };
    files.forEach(walk);
  }

  // ── SQL values (Astra S7-U3a-AUDIT-SPEC-C-R-001-F02, W5, W6) ──
  const PRIMITIVE = TF.StringLike | TF.NumberLike | TF.BooleanLike | TF.BigIntLike | TF.Null | TF.Undefined | TF.EnumLike;
  const isDate = type => type.symbol?.name === 'Date' && !!type.symbol.declarations?.some(lib);
  const isLibSet = type => ['Set', 'ReadonlySet'].includes(type.symbol?.name) && !!type.symbol.declarations?.some(lib);
  /** A primitive, a Date, or an array, tuple or set of them: what Prisma binds as one parameter. */
  function valueType(type, depth = 0) {
    if (!type || type.flags & (TF.Any | TF.Unknown | TF.Never)) return false;
    const parts = type.isUnion() ? type.types : [type];
    return parts.every(part => (part.flags & PRIMITIVE) || isDate(part)
      || (depth === 0 && (checker.isArrayType(part) || checker.isTupleType(part) || (isLibSet(part) && part.objectFlags & ts.ObjectFlags.Reference))
        && checker.getTypeArguments(part).every(item => valueType(item, 1))));
  }
  const declaredType = declaration => (declaration?.type ? checker.getTypeFromTypeNode(declaration.type) : null);
  // A value taken at its type (a call's result, a declared parameter or member) can hold a fragment only if one is handed on
  // (W4 below) in code connected to it: the same file, or a file a call of either runs. Where one is, the type is no
  // evidence (`escapedNear`, set once the W4 check has run).
  let escapedNear = null;
  const keptNote = node => {
    const found = escapedNear ? escapedNear(node) : 'the W4 check over every fragment has not run';
    return found ? `a fragment is handed on in code connected to it (${found}), so its type is no evidence` : null;
  };
  const judged = new Map(), judging = new Set();
  /**
   * F02: whether an interpolation is a value (Prisma binds it as a parameter) — { rules } — or why not. The finite list:
   * a literal; a result the language makes a primitive (a template literal, arithmetic, a comparison, `!`, `typeof`); each
   * side of ?:, ||, ?? and &&; `new Date()`; an array of values; a const or let through its initializer and every
   * assignment; a W3 helper's parameter through every call's argument; a parameter of a function outside callers call,
   * declared a primitive or a Date; a JSON/Prisma result and its fields (W6); a fixed projection declared a primitive or a
   * Date of a record (a parameter declared an object type, a W3 argument, a const, a call typed as an object); and, taken
   * at the type the checker gives it, a call typed a primitive or a Date. A type an assertion or an annotation states is
   * never evidence: wrappers are read through, and a call's or a declaration's type counts only while no fragment of the
   * program is handed on (W4 above). Nothing typed as a fragment is a value.
   */
  function sqlValue(expression) {
    const node = bare(expression);
    if (judged.has(node)) return judged.get(node);
    if (judging.has(node)) return { why: `\`${snippet(node)}\` depends on itself` };
    judging.add(node);
    try {
      const found = judge(node);
      judged.set(node, found);
      return found;
    } finally {
      judging.delete(node);
    }
  }
  const ok = (...rules) => ({ rules });
  const all = (nodes, rule) => {
    const rules = [rule];
    for (const node of nodes) {
      const found = sqlValue(node);
      if (found.why) return found;
      rules.push(...found.rules);
    }
    return { rules: [...new Set(rules)] };
  };
  const byType = (node, rule) => {
    const lost = keptNote(node);
    if (lost) return { why: `\`${snippet(node)}\` is taken at its type, and ${lost}` };
    return ok(rule);
  };
  function judge(node) {
    if (containsSql(checker.getTypeAtLocation(node))) return { why: `\`${snippet(node)}\` (${typeText(checker.getTypeAtLocation(node))}) is an SQL fragment` };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
      || node.kind === K.TrueKeyword || node.kind === K.FalseKeyword || node.kind === K.NullKeyword
      || (ts.isIdentifier(node) && node.text === 'undefined' && !symbolAt(node)?.declarations?.length)) return ok('F02 literal');
    if (ts.isTemplateExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isTypeOfExpression(node)
      || ts.isVoidExpression(node)) return ok('F02 a primitive by the language (template, unary, typeof)');
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (CHOICES.has(operator)) return all([node.left, node.right], 'F02 each alternative');
      if (operator === K.CommaToken || operator === K.EqualsToken) return sqlValue(node.right);
      if (operator >= K.FirstAssignment && operator <= K.LastAssignment && [K.BarBarEqualsToken, K.QuestionQuestionEqualsToken, K.AmpersandAmpersandEqualsToken].includes(operator)) {
        return all([node.left, node.right], 'F02 each alternative');
      }
      return ok('F02 a primitive by the language (arithmetic, comparison)');
    }
    if (ts.isConditionalExpression(node)) return all([node.whenTrue, node.whenFalse], 'F02 each alternative of ?:');
    // A new array is never a fragment: Prisma binds it as one parameter and never reads a fragment out of it.
    if (ts.isArrayLiteralExpression(node)) return ok('F02 an array literal (one parameter)');
    if (ts.isNewExpression(node) && isDate(checker.getTypeAtLocation(node)) && ts.isIdentifier(bare(node.expression))
      && (symbolAt(bare(node.expression))?.declarations ?? []).some(lib)) return ok('F02 new Date');
    if (isAccess(node)) return projection(node);
    const row = result(node);
    if (row) return ok(`W6 ${row}`);
    if (ts.isIdentifier(node)) return binding(node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      return valueType(type) ? byType(node, `F02 a call the checker types \`${typeText(type)}\` (its callee is not read)`)
        : { why: `\`${snippet(node)}\` is a call typed \`${typeText(type)}\`` };
    }
    return { why: `\`${snippet(node)}\` is a ${K[node.kind]}` };
  }
  /** The sources of a binding: its initializer and every assignment, or why one is not a plain value. */
  function sourcesOf(symbol, declaration, name) {
    const found = [];
    if (declaration.initializer) found.push(declaration.initializer);
    const { plain, other } = writesOf(symbol);
    found.push(...plain);
    for (const write of other) {
      if (write.from && result(write.from)) continue;   // `[head] = await tx.$queryRaw…`: an element of a JSON/Prisma result
      return { why: `\`${name}\` is changed by \`${snippet(write.at)}\`` };
    }
    return { found };
  }
  function binding(node) {
    const symbol = symbolAt(node), name = node.text, declarations = symbol?.declarations ?? [], [declaration] = declarations;
    if (declarations.length !== 1) return { why: `\`${name}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}` };
    const exported = throughExport(node);
    if (exported) return { why: `\`${name}\` ${exported}` };
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      const loop = forOf(declaration);
      if (loop) {
        if (result(loop.expression)) return ok('W6 an element of a JSON/Prisma result');
        const element = elementType(loop.expression);
        return element && valueType(element) ? byType(declaration, `F02 an element of \`${snippet(loop.expression)}\`, typed \`${typeText(element)}\``)
          : { why: `\`${name}\` is an element of \`${snippet(loop.expression)}\`${element ? `, typed \`${typeText(element)}\`` : ''}` };
      }
      if (!declaration.initializer && !isLet(declaration)) return { why: `\`${name}\` is declared without a value` };
      const sources = sourcesOf(symbol, declaration, name);
      if (sources.why) return sources;
      if (!sources.found.length) return { why: `\`${name}\` is given no value` };
      return all(sources.found, `F02 ${isConst(declaration) ? 'const' : 'let'} \`${name}\``);
    }
    if (ts.isBindingElement(declaration)) {
      const changed = changedBinding(symbol);
      if (changed) return { why: changed };
      const element = destructuredValue(declaration);
      if (element.row) return ok(`W6 destructured from ${element.row}`);
      if (element.why) return { why: `\`${name}\` is destructured: ${element.why}` };
      return all(element.expressions ?? [element.expression], `F02 \`${name}\` destructured from a literal`);
    }
    if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent)) return parameterValue(declaration, symbol, name, false);
    return { why: `\`${name}\` is a ${K[declaration.kind]}` };
  }
  /** A parameter as a value (`record` false) or as a record whose fixed projections are values (true). */
  function parameterValue(declaration, symbol, name, record) {
    const owner = declaration.parent;
    const hazard = parameterHazard(declaration);
    if (hazard) return { why: hazard };
    if (declaration.dotDotDotToken || !ts.isIdentifier(declaration.name)) return { why: `\`${name}\` is a rest or destructured parameter` };
    const { plain, other } = writesOf(symbol);
    if (other.length) return { why: `\`${name}\` is changed by \`${snippet(other[0].at)}\`` };
    const kind = helperKind(owner);
    let base;
    if (W3_KINDS.has(kind.kind)) {
      const index = owner.parameters.indexOf(declaration) - shift(owner);
      const { calls: found, escapes } = callsOf(owner, 'w3');
      if (escapes.length) {
        // A contextually typed callback has the same value boundary as a public function parameter.
        // Only an explicit function annotation or the library's Array#map supplies that context.
        const held = constHolder(owner), parent = owner.parent;
        const mapped = ts.isCallExpression(parent) && parent.arguments[0] === owner
          && isAccess(bare(parent.expression)) && w1(bare(parent.expression)).key === 'map'
          && lib(checker.getResolvedSignature(parent)?.declaration ?? parent);
        // Callback annotations can narrow any[] without any evidence. Only the receiver's
        // element type (and the library's numeric index) describes what map actually supplies.
        const type = mapped ? (index === 0 ? elementType(bare(parent.expression).expression)
          : index === 1 ? checker.getNumberType() : null) : checker.getTypeAtLocation(declaration);
        if (type && (held?.type || mapped) && (record ? isRecordType(type) : valueType(type)) && !plain.length)
          return byType(declaration, `F02 contextually typed callback parameter \`${name}\`: \`${typeText(type)}\``);
        return { why: `\`${name}\` is a parameter of ${describe(owner)}, which is handed on at ${escapes.join(', ')}` };
      }
      if (!found.length) return { why: `\`${name}\` is a parameter of ${describe(owner)}, which nothing in the program calls` };
      const argumentsOf = [];
      for (const call of found) {
        if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return { why: `${where(call)}: a spread argument` };
        const argument = call.arguments[index] ?? declaration.initializer;
        if (!argument) return { why: `${where(call)}: no argument for \`${name}\`` };
        argumentsOf.push(argument);
      }
      const rule = `W3 \`${name}\` of ${describe(owner)}: every call's argument`;
      base = record ? recordAll(argumentsOf, rule) : all(argumentsOf, rule);
    } else {
      const type = declaredType(declaration);
      if (!type) return { why: `\`${name}\` is a parameter of ${describe(owner)}, ${kind.why}, declared with no type` };
      const fits = record ? isRecordType(type) : valueType(type);
      if (!fits) return { why: `\`${name}\` is a parameter of ${describe(owner)}, ${kind.why}, declared \`${declaration.type.getText()}\`` };
      base = byType(declaration, `F02 \`${name}\` declared \`${declaration.type.getText()}\` by ${describe(owner)}, which callers outside this program call`);
    }
    if (base.why || !plain.length) return base;
    const assigned = record ? recordAll(plain, `F02 assignments to \`${name}\``) : all(plain, `F02 assignments to \`${name}\``);
    return assigned.why ? assigned : ok(...new Set([...base.rules, ...assigned.rules]));
  }
  const objectLike = part => !!(part.flags & TF.Object) || (!!(part.flags & TF.Intersection) && part.types.every(objectLike));
  const isRecordType = type => !!type && !(type.flags & (TF.Any | TF.Unknown | TF.Never)) && !containsSql(type) && !valueType(type)
    && (type.isUnion() ? type.types : [type]).every(part => objectLike(part) || part.flags & (TF.Null | TF.Undefined));
  /** The element type of an array or a set, else null. */
  const elementType = expression => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(bare(expression)));
    return (checker.isArrayType(type) || (isLibSet(type) && type.objectFlags & ts.ObjectFlags.Reference)) ? checker.getTypeArguments(type)[0] : null;
  };
  /** A fixed projection (F02): a field of a JSON/Prisma result (W6), of an object literal it always is, or a member
   *  declared a primitive or a Date of a record. */
  function projection(access) {
    const { key, why } = w1(access);
    if (key === undefined) return { why: `\`${snippet(access)}\` is read by a key W1 does not fix (${why})` };
    const found = fieldOf(access.expression, key, new Set());
    return found.why ? { why: `\`${snippet(access)}\`: ${found.why}` } : found;
  }
  /**
   * The field `key` of what `expression` holds, as a value: a field of a JSON/Prisma result (W6); read in each object
   * literal it can be — through a const or let and each assignment, a W3 argument, a W3 helper's every return, both sides
   * of ?: — at its last definition, and through every spread after it; otherwise a member declared a primitive or a Date of
   * a record. A binding's field reached again through its own spread (`head = { ...head, x }`) adds no value.
   */
  function fieldOf(expression, key, seen) {
    const node = bare(expression);
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), declaration = symbol?.declarations?.[0];
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration))) {
        const issue = contentIssue(symbol, [key]);
        if (issue) return { why: issue };
      }
    }
    const row = result(node);
    if (row) return ok(`W6 a field of ${row}`);
    if (ts.isObjectLiteralExpression(node)) return literalField(node, key, seen);
    if (ts.isConditionalExpression(node)) return fieldsOf([node.whenTrue, node.whenFalse], key, seen, 'F02 each alternative of ?:');
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
      if (declarations.length === 1 && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && !forOf(declaration)) {
        const mark = `${where(declaration)}#${key}`;
        if (seen.has(mark)) return ok(`its own earlier \`${key}\``);
        const sources = sourcesOf(symbol, declaration, node.text);
        if (sources.why) return sources;
        if (!sources.found.length) return { why: `\`${node.text}\` is given no value` };
        return fieldsOf(sources.found, key, new Set(seen).add(mark), `F02 ${isConst(declaration) ? 'const' : 'let'} \`${node.text}\``);
      }
      if (declarations.length === 1 && ts.isParameter(declaration) && W3_KINDS.has(helperKind(declaration.parent).kind)) {
        const inputs = parameterInputs(declaration, symbol, node.text);
        if (!inputs.why) return fieldsOf(inputs.found, key, seen, `W3 \`${node.text}\` of ${describe(declaration.parent)}: every call's argument`);
        const context = parameterValue(declaration, symbol, node.text, true);
        if (context.why) return context.why.includes('so its type is no evidence') ? context : inputs;
      }
      if (declarations.length === 1 && ts.isBindingElement(declaration)) {
        const element = destructuredValue(declaration);
        if (element.row) return ok(`W6 a field of what is destructured from ${element.row}`);
        if (element.expression || element.expressions) return fieldsOf(element.expressions ?? [element.expression], key, seen, `F02 \`${node.text}\` destructured from a literal`);
      }
    }
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) {
      const returned = helperReturns(ts.isAwaitExpression(node) ? bare(node.expression) : node);
      if (returned) return fieldsOf(returned.found, key, seen, returned.rule);
    }
    // A member declared a primitive or a Date, of a record.
    const parameter = ts.isIdentifier(node) ? symbolAt(node)?.declarations?.[0] : null;
    const callback = parameter && ts.isParameter(parameter) ? parameter.parent : null;
    const mapCall = callback?.parent;
    const mapped = mapCall && ts.isCallExpression(mapCall) && mapCall.arguments[0] === callback
      && isAccess(bare(mapCall.expression)) && w1(bare(mapCall.expression)).key === 'map'
      && lib(checker.getResolvedSignature(mapCall)?.declaration ?? mapCall);
    const receiverElement = mapped && callback.parameters[0] === parameter ? elementType(bare(mapCall.expression).expression) : null;
    const type = checker.getNonNullableType(receiverElement ?? checker.getTypeAtLocation(node));
    const symbol = checker.getPropertyOfType(type, key), [declaration] = symbol?.declarations ?? [];
    if (!symbol) return { why: `\`${key}\` is a property the program does not fix (\`${snippet(node)}\` is typed \`${typeText(type)}\`)` };
    if (mapped) {
      const base = parameterValue(parameter, symbolAt(node), node.text, true);
      return receiverElement && valueType(checker.getTypeOfSymbolAtLocation(symbol, node)) && !base.why
        ? ok(`F02 map receiver element field \`${node.text}.${key}\``, ...base.rules)
        : { why: `binding \`${node.text}\`: map receiver does not prove field \`${key}\`` };
    }
    // A function result is already an F02 type boundary. Its inferred primitive fields are as much
    // values as an explicitly declared field; local annotations and assertions still are not evidence.
    if ((ts.isCallExpression(node) || ts.isAwaitExpression(node)) && valueType(checker.getTypeOfSymbolAtLocation(symbol, node))) {
      const base = recordOf(node);
      return base.why ? base : ok(`F02 primitive result field \`${key}\``, ...base.rules);
    }
    const declared = declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration)) && declaration.type
      ? checker.getTypeFromTypeNode(declaration.type) : null;
    if (!declared || !valueType(declared)) return { why: `\`${key}\` is declared \`${declared ? typeText(declared) : declaration ? K[declaration.kind] : '?'}\`, not a primitive or a Date` };
    const base = recordOf(node);
    return base.why ? base : ok(`F02 \`${key}\` declared \`${declaration.type.getText()}\``, ...base.rules);
  }
  function fieldsOf(nodes, key, seen, rule) {
    const rules = [rule];
    for (const node of nodes) {
      if (nothing(node)) continue;
      const found = fieldOf(node, key, seen);
      if (found.why) return found;
      rules.push(...found.rules);
    }
    return ok(...new Set(rules));
  }
  /** The field `key` of an object literal: its last plain definition, and every spread after it that may define it. */
  function literalField(literal, key, seen) {
    const rules = [`F02 \`${key}\` of the object literal at ${where(literal)}`];
    for (const member of [...literal.properties].reverse()) {
      if (ts.isSpreadAssignment(member)) {
        const found = fieldOf(member.expression, key, seen);
        if (found.why) return { why: `\`${key}\` may come from the spread at ${where(member)}: ${found.why}` };
        rules.push(...found.rules);
        continue;
      }
      const name = member.name ? w1(member.name) : { why: 'no name' };
      if (name.key === undefined) return { why: `\`${key}\` may be set by the computed key at ${where(member)}` };
      if (name.key !== key) continue;
      const found = ts.isPropertyAssignment(member) ? sqlValue(member.initializer) : ts.isShorthandPropertyAssignment(member) ? binding(member.name)
        : { why: `\`${key}\` is an accessor or method at ${where(member)}` };
      return found.why ? found : ok(...new Set([...rules, ...found.rules]));
    }
    return ok(...rules, 'F02 not set: undefined');
  }
  const forOf = declaration => { const loop = declaration.parent?.parent; return loop && ts.isForOfStatement(loop) && loop.initializer === declaration.parent ? loop : null; };
  /** The argument every call of a W3 helper passes for a parameter (with its default), or why not. */
  function parameterInputs(declaration, symbol, name) {
    const owner = declaration.parent, index = owner.parameters.indexOf(declaration) - shift(owner);
    const hazard = parameterHazard(declaration);
    if (hazard) return { why: hazard };
    if (declaration.dotDotDotToken || !ts.isIdentifier(declaration.name)) return { why: `\`${name}\` is a rest or destructured parameter` };
    const { plain, other } = writesOf(symbol);
    if (other.length) return { why: `\`${name}\` is changed by \`${snippet(other[0].at)}\`` };
    const { calls: found, escapes } = callsOf(owner, 'w3');
    if (escapes.length) return { why: `\`${name}\` is a parameter of ${describe(owner)}, which is handed on at ${escapes.join(', ')}` };
    if (!found.length) return { why: `\`${name}\` is a parameter of ${describe(owner)}, which nothing in the program calls` };
    const inputs = [...plain];
    for (const call of found) {
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return { why: `${where(call)}: a spread argument` };
      const argument = call.arguments[index] ?? declaration.initializer;
      if (!argument) return { why: `${where(call)}: no argument for \`${name}\`` };
      inputs.push(argument);
    }
    return { found: inputs };
  }
  /** The return expressions of the W3 helpers a call runs, when every one of them is a W3 helper; else null. */
  function helperReturns(call) {
    if (!ts.isCallExpression(call)) return null;
    const owners = functionsOf(call.expression, 'w3');
    if (!owners?.length) return null;
    const found = [];
    for (const owner of owners) {
      if (ts.isArrowFunction(owner) && !ts.isBlock(owner.body)) { found.push(owner.body); continue; }
      const walk = node => {
        if (node !== owner && ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
        ts.forEachChild(node, walk);
      };
      walk(owner.body);
    }
    return { found, rule: `W3 the returns of ${owners.map(describe).join(', ')}` };
  }
  /** What a binding element takes: the element or field of what is destructured, when it is read by an index or a key W1
   *  fixes out of an array or object literal it always is ({ expression }), or of a JSON/Prisma result ({ row }). */
  function destructuredValue(element) {
    const changed = changedBinding(symbolAt(element.name));
    if (changed) return { why: changed };
    if (element.initializer) return { why: `binding \`${element.name.getText()}\` has an unproved destructuring default` };
    const path = [];
    let at = element;
    while (ts.isBindingElement(at)) {
      const pattern = at.parent;
      if (at.dotDotDotToken) return { why: 'a rest element' };
      path.unshift(ts.isArrayBindingPattern(pattern) ? { index: pattern.elements.indexOf(at) }
        : { key: at.propertyName ? w1(at.propertyName).key : at.name.text });
      at = pattern.parent;
    }
    const from = ts.isVariableDeclaration(at) ? at.initializer : null;
    if (!from) return { why: 'no initializer' };
    if (result(from)) return { row: result(from) };
    let expressions = [from];
    for (const step of path) {
      const next = [];
      for (const expression of expressions) {
        const literals = literalsOf(expression);
        if (!literals) return { why: `\`${snippet(expression)}\` is not a literal the program fixes` };
        for (const literal of literals) {
          if (step.index !== undefined && ts.isArrayLiteralExpression(literal)) {
            const item = literal.elements[step.index];
            if (!item || literal.elements.slice(0, step.index + 1).some(ts.isSpreadElement)) return { why: `no element ${step.index} at ${where(literal)}` };
            next.push(item);
          } else if (step.key !== undefined && ts.isObjectLiteralExpression(literal)) {
            const member = property(literal, step.key);
            if (!member.node && !member.shorthand) return { why: `\`${step.key}\` ${member.why}` };
            next.push(member.node ?? member.shorthand.name);
          } else return { why: `a pattern that does not fit ${where(literal)}` };
        }
      }
      expressions = next;
    }
    return expressions.length === 1 ? { expression: expressions[0] } : { expressions };
  }
  /** The array and object literals an expression always is — itself, both sides of ?:, a const's initializer, every return
   *  of the W3 helpers a call runs — or null. */
  function literalsOf(expression, depth = 0) {
    const node = bare(expression);
    if (depth > 8) return null;
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return [node];
    if (ts.isAwaitExpression(node)) return literalsOf(node.expression, depth + 1);
    if (ts.isConditionalExpression(node)) {
      const sides = [node.whenTrue, node.whenFalse].filter(side => !nothing(side)).map(side => literalsOf(side, depth + 1));
      return sides.every(Boolean) ? sides.flat() : null;
    }
    if (ts.isIdentifier(node)) {
      const [declaration] = symbolAt(node)?.declarations ?? [];
      return declaration && isConst(declaration) && declaration.initializer && !changedBinding(symbolAt(node))
        && !contentIssue(symbolAt(node)) ? literalsOf(declaration.initializer, depth + 1) : null;
    }
    const returned = helperReturns(node);
    if (!returned) return null;
    const each = returned.found.filter(value => !nothing(value)).map(value => literalsOf(value, depth + 1));
    return each.length && each.every(Boolean) ? each.flat() : null;
  }
  /** F02: a record, whose fixed projections declared a primitive or a Date are values — or why not. */
  function recordOf(expression) {
    const node = bare(expression);
    if (result(node)) return ok('W6 a JSON/Prisma result');
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
      if (declarations.length !== 1) return { why: `\`${node.text}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}` };
      if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent)) return parameterValue(declaration, symbol, node.text, true);
      const loop = ts.isVariableDeclaration(declaration) ? forOf(declaration) : null;
      if (loop) {
        if (result(loop.expression)) return ok('W6 an element of a JSON/Prisma result');
        const element = elementType(loop.expression);
        return element && isRecordType(element) ? byType(declaration, `F02 an element of \`${snippet(loop.expression)}\`, typed \`${typeText(element)}\``)
          : { why: `\`${node.text}\` is an element of \`${snippet(loop.expression)}\`` };
      }
      if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer) {
        const sources = sourcesOf(symbol, declaration, node.text);
        return sources.why ? sources : recordAll(sources.found, `F02 ${isConst(declaration) ? 'const' : 'let'} \`${node.text}\``);
      }
      return { why: `\`${node.text}\` is a ${K[declaration.kind]}, not a record` };
    }
    if (isAccess(node)) {
      const { key } = w1(node);
      const symbol = key === undefined ? null : ts.isPropertyAccessExpression(node) ? resolve(checker.getSymbolAtLocation(node.name))
        : resolve(checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(node.expression)), key));
      const [declaration] = symbol?.declarations ?? [];
      const type = declaration?.type ? checker.getTypeFromTypeNode(declaration.type) : null;
      if (!type || !isRecordType(type)) return { why: `\`${snippet(node)}\` is not a member declared as an object type` };
      const base = recordOf(node.expression);
      return base.why ? base : ok(`F02 \`${key}\` declared \`${declaration.type.getText()}\``, ...base.rules);
    }
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      return isRecordType(type) ? byType(node, `F02 a call the checker types \`${typeText(type)}\``) : { why: `\`${snippet(node)}\` is a call typed \`${typeText(type)}\`` };
    }
    return { why: `\`${snippet(node)}\` is a ${K[node.kind]}, not a record` };
  }
  function recordAll(nodes, rule) {
    const rules = [rule];
    for (const node of nodes) {
      const at = bare(node);
      if (at.kind === K.NullKeyword || (ts.isIdentifier(at) && at.text === 'undefined')) continue;
      const found = ts.isObjectLiteralExpression(at) ? { why: `an object literal at ${where(at)} held by a binding that is not a const` } : recordOf(at);
      if (found.why) return found;
      rules.push(...found.rules);
    }
    return ok(...new Set(rules));
  }
  const RESULTS = new Set(['$queryRaw', '$queryRawUnsafe']);
  const results = new Map(), resulting = new Set();
  /** W6: a JSON/Prisma result — what a delegate method or a raw query of a client gives, awaited, `JSON.parse`, their
   *  elements and fields, a const, let or W3 argument that is only one of them — as a description, else null. Its fields
   *  are data the database or JSON gave, never a fragment. */
  function result(expression) {
    const node = bare(expression);
    if (results.has(node)) return results.get(node);
    if (resulting.has(node)) return null;
    resulting.add(node);
    try {
      const found = resultOf(node);
      results.set(node, found);
      return found;
    } finally {
      resulting.delete(node);
    }
  }
  const nothing = node => { const at = bare(node); return at.kind === K.NullKeyword || (ts.isIdentifier(at) && at.text === 'undefined' && !symbolAt(at)?.declarations?.length); };
  /** The returns of a function (not of the functions inside it). */
  const returnsOf = owner => {
    if (ts.isArrowFunction(owner) && !ts.isBlock(owner.body)) return [owner.body];
    const returned = [];
    const walk = at => {
      if (at !== owner && ts.isFunctionLike(at)) return;
      if (ts.isReturnStatement(at) && at.expression) returned.push(at.expression);
      ts.forEachChild(at, walk);
    };
    walk(owner.body);
    return returned;
  };
  /** What a promise-giving expression settles to, when it is a result: a raw query or a delegate method of a client, the
   *  callback's returns of a client's `$transaction`, the returns of the W3 helpers a call runs (their parameters bound to
   *  that call's arguments, `bound`). */
  function settled(expression, bound = null, depth = 0) {
    const inner = bare(expression);
    if (depth > 12) return null;
    if (ts.isAwaitExpression(inner)) return settled(inner.expression, bound, depth + 1);
    const given = boundArgument(inner, bound);
    if (given) return settled(given.expression, given.outer, depth + 1);
    const query = ts.isTaggedTemplateExpression(inner) ? bare(inner.tag) : ts.isCallExpression(inner) ? bare(inner.expression) : null;
    if (query && isAccess(query)) {
      const { key } = w1(query), receiver = bare(query.expression);
      if (key !== undefined && RESULTS.has(key) && isClient(receiver)) return `the rows of \`${snippet(inner)}\``;
      if (key !== undefined && !key.startsWith('$') && isAccess(receiver) && isClient(bare(receiver.expression))) {
        const model = w1(receiver).key;
        if (model !== undefined && !model.startsWith('$')) return `the result of \`${snippet(inner)}\``;
      }
      // `client.$transaction(async tx => …)` settles to what its callback returns.
      if (key === '$transaction' && isClient(receiver) && ts.isCallExpression(inner)) {
        const callbacks = inner.arguments[0] ? callables(inner.arguments[0], bound) : null;
        if (!callbacks?.length) return null;
        const each = callbacks.flatMap(returnsOf).filter(value => !nothing(value)).map(value => settled(value, bound, depth + 1));
        return each.length && each.every(Boolean) ? `${each[0]} (returned by the \`$transaction\` callback)` : null;
      }
    }
    if (ts.isCallExpression(inner)) return helperResult(inner, bound, depth + 1);
    return result(inner);
  }
  /** The argument a parameter is bound to in the call being read, else null. */
  const boundArgument = (node, bound) => {
    if (!bound || !ts.isIdentifier(node)) return null;
    const [declaration] = symbolAt(node)?.declarations ?? [];
    const given = declaration ? bound.get(declaration) ?? null : null;
    if (given) {
      const why = changedBinding(symbolAt(node)) || parameterHazard(declaration);
      if (why) throw new SqlProofError(why);
      if (declaration.initializer && given.expression !== declaration.initializer) {
        const type = checker.getTypeAtLocation(bare(given.expression));
        if ((type.isUnion() ? type.types : [type]).some(part => part.flags & (TF.Undefined | TF.Any | TF.Unknown)))
          throw new SqlProofError(`binding \`${node.text}\` may take its default instead of the supplied argument`);
      }
    }
    return given;
  };
  /** The W3 functions an expression may be in the call being read (a parameter bound to its argument there). */
  const callables = (expression, bound) => {
    const given = boundArgument(bare(expression), bound);
    return given ? callables(given.expression, given.outer) : functionsOf(expression, 'w3');
  };
  function resultOf(node) {
    if (ts.isAwaitExpression(node)) return settled(node.expression);
    if (ts.isConditionalExpression(node)) {
      const sides = [node.whenTrue, node.whenFalse].filter(side => !nothing(side)).map(result);
      return sides.length && sides.every(Boolean) ? sides[0] : null;
    }
    if (ts.isBinaryExpression(node) && CHOICES.has(node.operatorToken.kind)) {
      const sides = [node.left, node.right].filter(side => !nothing(side)).map(result);
      return sides.length && sides.every(Boolean) ? sides[0] : null;
    }
    if (ts.isCallExpression(node)) {
      const callee = bare(node.expression);
      if (isAccess(callee) && w1(callee).key === 'parse' && ts.isIdentifier(bare(callee.expression)) && bare(callee.expression).text === 'JSON'
        && (symbolAt(bare(callee.expression))?.declarations ?? []).some(lib)) return 'a `JSON.parse` result';
      return helperResult(node);
    }
    if (isAccess(node)) { const inner = result(node.expression); return inner ? `a field of ${inner}` : null; }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
      if (declarations.length !== 1) return null;
      if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const loop = declaration.parent?.parent;
        if (loop && ts.isForOfStatement(loop) && loop.initializer === declaration.parent) { const inner = result(loop.expression); return inner ? `an element of ${inner}` : null; }
        const sources = sourcesOf(symbol, declaration, node.text);
        if (sources.why) return null;
        const found = sources.found.filter(source => !nothing(source)).map(result);
        return found.length && found.every(Boolean) ? found[0] : null;
      }
      if (ts.isBindingElement(declaration)) {
        if (changedBinding(symbol) || declaration.initializer) return null;
        let at = declaration;
        while (ts.isBindingElement(at) || ts.isObjectBindingPattern(at) || ts.isArrayBindingPattern(at)) at = at.parent;
        const inner = ts.isVariableDeclaration(at) && at.initializer ? result(at.initializer) : null;
        return inner ? `an element of ${inner}` : null;
      }
      if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent) && W3_KINDS.has(helperKind(declaration.parent).kind)) {
        const owner = declaration.parent, index = owner.parameters.indexOf(declaration) - shift(owner);
        const { calls: found, escapes } = callsOf(owner, 'w3');
        if (escapes.length || !found.length || writesOf(symbol).plain.length || writesOf(symbol).other.length) return null;
        const given = found.map(call => call.arguments[index]).filter(argument => argument && !nothing(argument));
        if (given.length !== found.filter(call => call.arguments[index]).length || !given.length) return null;
        const inner = given.map(result);
        return inner.every(Boolean) ? `${inner[0]} (W3 \`${node.text}\` of ${describe(owner)})` : null;
      }
    }
    return null;
  }
  /** A call of W3 helpers whose every return, read with its parameters bound to this call's arguments, is a JSON/Prisma
   *  result (W3: closed local passing), else null. */
  function helperResult(call, bound = null, depth = 0) {
    const owners = callables(call.expression, bound);
    if (!owners?.length) return null;
    let found = null;
    for (const owner of owners) {
      const inner = new Map();
      owner.parameters.forEach((parameter, n) => {
        const argument = call.arguments[n - shift(owner)];
        if (argument && !call.arguments.slice(0, n - shift(owner) + 1).some(ts.isSpreadElement)) inner.set(parameter, { expression: argument, outer: bound });
      });
      const each = returnsOf(owner).filter(value => !nothing(value)).map(value => settled(value, inner, depth + 1));
      if (!each.length || !each.every(Boolean)) return null;
      found = `${each[0]} (returned by ${describe(owner)})`;
    }
    return found;
  }

  // ── raw SQL (W5 the two INSERT forms, W6 the rest) ──
  const claimed = new Set(), naming = [];
  const TABLE_WORDS = /auditlog/i;
  /** Texts that may name the AuditLog table in SQL: any text with it that is not one bare name (a member key such as
   *  'auditLog' is the delegate's; SQL names the table as the quoted identifier, the only spelling that reaches it). */
  const namesTable = value => TABLE_WORDS.test(value) && !/^[A-Za-z_$][\w$]*$/.test(value);
  /**
   * SQL tokens over the texts between interpolations, by PostgreSQL's lexical rules for what the two forms need: a string
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
            if (part[j] === '\\' && ch === "'") fail('an unmodelled string escape');
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
  const opens = token => token?.kind === 'punct' && (token.value === '(' || token.value === '[');
  const closes = token => token?.kind === 'punct' && (token.value === ')' || token.value === ']');
  // Words that begin another clause: none may stand at the top level of G2's SELECT items (a UNION before FROM included).
  const CLAUSES = new Set(['SELECT', 'UNION', 'INTERSECT', 'EXCEPT', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT',
    'OFFSET', 'FETCH', 'FOR', 'RETURNING', 'VALUES', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'JOIN', 'ON']);
  /**
   * The two forms (Astra S7-U3a-AUDIT-SPEC-B-R-001, F03 as amended), else {error}:
   *  G1 `INSERT INTO [schema.]"AuditLog" (columns) VALUES (values) [;]`;
   *  G2 `[WITH name AS (...), ...] INSERT INTO [schema.]"AuditLog" (columns) SELECT items FROM source [;]`.
   * The column names, the value or item tokens by position, the WITH bodies and where INSERT begins.
   */
  function insertForm(tokens) {
    let i = 0;
    const word = value => tokens[i]?.kind === 'word' && tokens[i].upper === value;
    const punct = value => tokens[i]?.kind === 'punct' && tokens[i].value === value;
    const name = token => (token?.kind === 'ident' ? token.value : token?.kind === 'word' ? token.name : null);
    /** The tokens inside the parentheses opening at i (i then after them), or null when they do not close. */
    const enclosed = () => {
      const start = ++i;
      for (let depth = 0; i < tokens.length; i++) {
        if (opens(tokens[i])) depth++;
        else if (closes(tokens[i]) && depth-- === 0) return tokens.slice(start, i++);
      }
      return null;
    };
    if (statements(tokens) > 1) return { error: 'several statements' };
    // G2's WITH list: name [(columns)] AS [[NOT] MATERIALIZED] (body), ... — not RECURSIVE; a body naming AuditLog could
    // be one more audit write (or read) the statement hides, so it is not read here.
    const ctes = [];
    if (word('WITH')) {
      i++;
      if (word('RECURSIVE')) return { error: 'a WITH RECURSIVE list' };
      do {
        if (ctes.length) i++;
        const token = tokens[i++];
        if (token?.kind === 'param') return { error: 'an interpolation where a WITH name goes' };
        if (name(token) === null) return { error: `a WITH list with ${shown(token)}` };
        if (punct('(')) {
          const columns = enclosed();
          if (!columns?.length || columns.length % 2 === 0
            || columns.some((column, n) => (n % 2 ? !(column.kind === 'punct' && column.value === ',') : name(column) === null))) {
            return { error: `a WITH column list of ${shown(token)} that is not names` };
          }
        }
        if (!word('AS')) return { error: `${shown(tokens[i])} where AS goes after the WITH name ${shown(token)}` };
        i++;
        if (word('NOT')) { i++; if (!word('MATERIALIZED')) return { error: `NOT ${shown(tokens[i])} in the WITH list` }; }
        if (word('MATERIALIZED')) i++;
        if (!punct('(')) return { error: `${shown(tokens[i])} where the WITH body of ${shown(token)} goes` };
        const body = enclosed();
        if (!body) return { error: `an unclosed WITH body of ${shown(token)}` };
        if (!body.length) return { error: `an empty WITH body of ${shown(token)}` };
        if (body.some(inner => (inner.kind === 'ident' || inner.kind === 'word') && inner.name.toLowerCase() === 'auditlog')) {
          return { error: `the WITH body of ${shown(token)} names AuditLog` };
        }
        ctes.push({ name: name(token), shown: shown(token), body });
      } while (punct(','));
      const twice = ctes.find((cte, n) => ctes.findIndex(other => other.name === cte.name) !== n);
      if (twice) return { error: `the WITH name ${twice.shown} is declared twice` };
    }
    const insert = i;
    if (!word('INSERT')) {
      return { error: ctes.length ? `${shown(tokens[i])} after the WITH list, where INSERT goes` : `not the INSERT form: it begins with ${shown(tokens[0])}` };
    }
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
    /** The checks both forms share, once nothing follows the values or the source. */
    const matched = (row, what, form) => {
      if (row.some(value => value.length === 0)) return { error: `an empty ${what === 'values' ? 'value in the VALUES list' : 'item in the SELECT list'}` };
      if (row.length !== columns.length) return { error: `${columns.length} columns and ${row.length} ${what}` };
      const twice = columns.find((column, n) => columns.indexOf(column) !== n);
      if (twice !== undefined) return { error: `the column ${twice} is named twice` };
      const at = columns.indexOf('action');
      if (at < 0) return { error: 'no action column' };
      return { form, columns, row, action: row[at], ctes, insert };
    };
    if (word('VALUES')) {   // G1
      if (ctes.length) return { error: 'a WITH list before INSERT … VALUES (only INSERT … SELECT takes one)' };
      i++;
      if (!punct('(')) return { error: `${shown(tokens[i])} after VALUES` };
      i++;
      const row = [[]];
      for (let depth = 0; ;) {
        const token = tokens[i++];
        if (!token) return { error: 'an unclosed VALUES list' };
        if (opens(token)) depth++;
        if (closes(token)) {
          if (depth === 0) break;
          depth--;
        }
        if (depth === 0 && token.kind === 'punct' && token.value === ',') { row.push([]); continue; }
        row[row.length - 1].push(token);
      }
      if (punct(';')) i++;
      if (i < tokens.length) return { error: `${shown(tokens[i])} after the VALUES list (a second row, ON CONFLICT, RETURNING or another clause)` };
      return matched(row, 'values', 'G1');
    }
    if (!word('SELECT')) return { error: `${shown(tokens[i])} where VALUES or SELECT goes` };
    i++;   // G2
    if (word('DISTINCT') || word('ALL')) return { error: `SELECT ${tokens[i].upper}, not SELECT items FROM one source` };
    const items = [[]];
    for (let depth = 0; ; i++) {
      const token = tokens[i];
      if (!token) return { error: 'no FROM after the SELECT items' };
      if (depth === 0 && token.kind === 'word' && token.upper === 'FROM') break;
      if (depth === 0 && token.kind === 'word' && CLAUSES.has(token.upper)) return { error: `${token.value} in the SELECT items (UNION or another clause)` };
      if (opens(token)) depth++;
      if (closes(token)) {
        if (depth === 0) return { error: `an unmatched ${token.value} in the SELECT items` };
        depth--;
      }
      if (depth === 0 && token.kind === 'punct' && token.value === ',') { items.push([]); continue; }
      items[items.length - 1].push(token);
    }
    i++;
    const source = [tokens[i++]];
    if (!ctes.length && punct('.')) { i++; source.push(tokens[i++]); }
    const from = source.map(shown).join('.');
    if (source.some(token => token?.kind === 'param')) return { error: 'an interpolation where the source goes' };
    if (source.some(token => name(token) === null)) return { error: `not a source name after FROM: ${from}` };
    if (ctes.length && !ctes.some(cte => cte.name === name(source[0]))) return { error: `FROM ${from}, which the WITH list does not declare` };
    if (punct(';')) i++;
    if (i < tokens.length) return { error: `${shown(tokens[i])} after FROM ${from} (a JOIN, WHERE, UNION or another clause)` };
    return { ...matched(items, 'SELECT items', 'G2'), from };
  }
  const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'TRUNCATE', 'INTO', 'CALL', 'DO', 'EXECUTE', 'ALTER',
    'DROP', 'CREATE', 'GRANT', 'REVOKE', 'LOCK', 'SET']);
  /** W6: one SELECT with no word that changes rows (FOR UPDATE / FOR NO KEY UPDATE only lock), read by token. */
  const readsOnly = tokens => statements(tokens) === 1 && tokens[0]?.kind === 'word' && tokens[0].upper === 'SELECT'
    && tokens.every((token, n) => token.kind !== 'word' || !WRITES.has(token.upper)
      || (token.upper === 'UPDATE' && ['FOR', 'KEY'].includes(tokens[n - 1]?.upper)));
  const isFragment = expression => containsSql(checker.getTypeAtLocation(expression));
  // Finite SQL alternatives retain the boundary between text and bound values. Concatenate before
  // lexing, so two innocent-looking fragments cannot hide a table name across their seam.
  class SqlProofError extends Error {}
  const sqlText = value => ({ parts: [value], spans: [] });
  const sqlParameter = expression => ({ parts: ['', ''], spans: [expression] });
  const appendSql = (left, right) => ({
    parts: [...left.parts.slice(0, -1), left.parts.at(-1) + right.parts[0], ...right.parts.slice(1)],
    spans: [...left.spans, ...right.spans],
    repeated: new Set([...(left.repeated ?? []), ...(right.repeated ?? [])]),
  });
  function sqlProduct(left, right) {
    if (!left.length || !right.length || left.length * right.length > 256)
      throw new SqlProofError('SQL alternatives are empty or exceed the enumeration limit');
    return left.flatMap(a => right.map(b => appendSql(a, b)));
  }
  function fragmentArray(expression, writer, seen = new Set()) {
    const node = bare(expression);
    if (ts.isArrayLiteralExpression(node)) return node;
    if (!ts.isIdentifier(node)) return null;
    const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
    if (declarations.length !== 1 || !isConst(declaration) || !declaration.initializer
      || declaration.getSourceFile() !== writer.getSourceFile() || seen.has(declaration)) return null;
    // No writes or opaque aliases to this array: even a const's elements are mutable.
    if (references(symbol).some(reference => {
      const held = outer(reference), parent = held.parent;
      return !inTypePosition(reference) && !inert(held)
        && !(ts.isCallExpression(parent) && prismaMember(parent.expression) === 'join' && parent.arguments[0] === held);
    })) return null;
    return fragmentArray(declaration.initializer, writer, new Set(seen).add(declaration));
  }
  /** A primitive projection through array-producing code. This follows data, never SQL fragments:
   * local arrays populated by push, record returns, map/filter/slice/sort/find and Map#values.
   * It lets a JSON-shaped service result retain the proof of its string uid even when the enclosing
   * record was declared any. An unknown producer, write, spread or projection fails the proof. */
  function projectedValue(expression, keys, bound = new Map(), seen = new Set()) {
    const node = bare(expression);
    const mark = `${where(node)}@${node.pos}:${node.end}:${K[node.kind]}:${keys.join('.')}`;
    if (seen.has(mark) || seen.size > 80 || containsSql(checker.getTypeAtLocation(node))) return false;
    const next = new Set(seen).add(mark);
    const read = (value, path = keys, scope = bound) => projectedValue(value, path, scope, next);
    const given = boundArgument(node, bound);
    if (given) {
      const issue = keys.length && contentIssue(symbolAt(node), keys);
      if (issue) throw new SqlProofError(issue);
      return read(given.expression, [...(given.keys ?? []), ...keys], given.outer);
    }
    if (!keys.length && !sqlValue(node).why) return true;
    if (ts.isAwaitExpression(node)) return read(node.expression);
    if (ts.isConditionalExpression(node)) return read(node.whenTrue) && read(node.whenFalse);
    if (ts.isNewExpression(node) && ts.isIdentifier(bare(node.expression)) && bare(node.expression).text === 'Set'
      && (symbolAt(bare(node.expression))?.declarations ?? []).some(lib) && node.arguments?.length === 1 && keys[0] === '*')
      return read(node.arguments[0]);
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
      if (declarations.length === 1 && ts.isParameter(declaration)) {
        const issue = changedBinding(symbol) || parameterHazard(declaration) || contentIssue(symbol, keys);
        if (issue) throw new SqlProofError(issue);
        const element = keys[0] === '*' && elementType(node);
        if (W3_KINDS.has(helperKind(declaration.parent).kind)) {
          const inputs = parameterInputs(declaration, symbol, node.text);
          if (!inputs.why) return inputs.found.every(value => read(value));
        }
        if (keys.length === 1 && element && valueType(element) && !sqlValue(node).why) return true;
        return false;
      }
      if (declarations.length !== 1 || !isConst(declaration) || !declaration.initializer || writesOf(symbol).plain.length || writesOf(symbol).other.length) return false;
      const issue = contentIssue(symbol, keys, true);
      if (issue) throw new SqlProofError(issue);
      return read(declaration.initializer); // contentIssue proved every pushed value, including aliases and spreads
    }
    if (isAccess(node)) {
      const { key } = w1(node);
      return key !== undefined && read(node.expression, [key, ...keys]);
    }
    if (ts.isObjectLiteralExpression(node) && keys.length) {
      const [key, ...rest] = keys;
      if (key === '*') return false;
      for (const member of [...node.properties].reverse()) {
        if (ts.isSpreadAssignment(member)) {
          const type = checker.getTypeAtLocation(member.expression);
          const parts = type.isUnion() ? type.types : [type];
          if (parts.every(part => !(part.flags & (TF.Any | TF.Unknown)) && !checker.getPropertyOfType(part, key)
            && !checker.getIndexTypeOfType(part, ts.IndexKind.String))) continue;
          return false;
        }
        const name = member.name && w1(member.name).key;
        if (name === undefined) return false;
        if (name !== key) continue;
        return ts.isPropertyAssignment(member) ? read(member.initializer, rest)
          : ts.isShorthandPropertyAssignment(member) && read(member.name, rest);
      }
      return !rest.length; // an absent field is a bound undefined
    }
    if (ts.isArrayLiteralExpression(node) && keys.length) {
      const [key, ...rest] = keys;
      if (key !== '*') return !node.elements.some(ts.isSpreadElement) && !!node.elements[Number(key)] && read(node.elements[Number(key)], rest);
      return node.elements.every(item => ts.isSpreadElement(item) ? read(item.expression, keys) : read(item, rest));
    }
    if (ts.isCallExpression(node)) {
      const callee = bare(node.expression);
      if (result(node) || settled(node)) return true; // W6 JSON/Prisma data; holders are checked before following this producer
      if (isAccess(callee) && ts.isIdentifier(bare(callee.expression)) && bare(callee.expression).text === 'Object'
        && (symbolAt(bare(callee.expression))?.declarations ?? []).some(lib)) {
        if (w1(callee).key === 'freeze' && node.arguments.length === 1) return read(node.arguments[0]);
        if (w1(callee).key === 'keys' && keys.length === 1 && keys[0] === '*') return true;
      }
      if (keys.length === 1 && keys[0] === '*' && valueType(elementType(node)) && !sqlValue(node).why) {
        // F02's existing typed-call boundary; local holders were checked before reaching it.
        // Library array transforms still inspect their receiver and callback below.
        if (!(isAccess(callee) && lib(checker.getResolvedSignature(node)?.declaration ?? node))) return true;
      }
      if (isAccess(callee) && lib(checker.getResolvedSignature(node)?.declaration ?? node)) {
        const method = w1(callee).key, receiver = bare(callee.expression);
        if (['filter', 'slice', 'sort'].includes(method)) return read(receiver);
        if (method === 'find') return read(receiver, ['*', ...keys]);
        if (['map', 'flatMap'].includes(method) && keys[0] === '*') {
          const fn = node.arguments[0];
          if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.parameters.length) return false;
          const scope = new Map(bound).set(fn.parameters[0], { expression: receiver, keys: ['*'], outer: bound });
          const returned = returnsOf(fn);
          return returned.length > 0 && returned.every(value => read(value, method === 'flatMap' ? keys : keys.slice(1), scope));
        }
        if (method === 'values' && keys[0] === '*' && ts.isNewExpression(receiver)
          && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'Map'
          && (symbolAt(receiver.expression)?.declarations ?? []).some(lib) && receiver.arguments?.length === 1)
          return read(receiver.arguments[0], ['*', '1', ...keys.slice(1)]);
        return false;
      }
      const owners = functionsOf(callee, 'flow');
      if (!owners?.length || node.arguments.some(ts.isSpreadElement)) return false;
      return owners.every(owner => {
        const scope = new Map(bound);
        for (const [index, parameter] of owner.parameters.entries()) {
          const argument = node.arguments[index - shift(owner)] ?? parameter.initializer;
          if (!argument && parameter.questionToken) continue;
          if (parameter.dotDotDotToken || !argument) return false;
          scope.set(parameter, { expression: argument, outer: bound });
        }
        const returned = returnsOf(owner);
        return returned.length > 0 && returned.every(value => read(value, keys, scope));
      });
    }
    return false;
  }
  /** Preserve F02's bound-array boundary while auditing the holders it follows. A declared
   * element type alone is insufficient: sqlValue must also establish the array's provenance,
   * and every content write must preserve the element proof. */
  function arrayInputsKept(expression, seen = new Set()) {
    const node = bare(expression);
    if (seen.has(node)) return false;
    const next = new Set(seen).add(node), read = value => arrayInputsKept(value, next);
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), [declaration] = symbol?.declarations ?? [];
      if (!declaration) return false;
      const issue = contentIssue(symbol, ['*'], true) || parameterHazard(declaration);
      if (issue) throw new SqlProofError(issue);
      if (ts.isVariableDeclaration(declaration)) {
        const sources = sourcesOf(symbol, declaration, node.text);
        return !sources.why && sources.found.length > 0 && sources.found.every(read);
      }
      if (ts.isParameter(declaration)) {
        const inputs = parameterInputs(declaration, symbol, node.text);
        return inputs.why ? !W3_KINDS.has(helperKind(declaration.parent).kind) && !changedBinding(symbol)
          : inputs.found.every(read);
      }
      return false;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.filter(ts.isSpreadElement).every(value => read(value.expression));
    if (ts.isConditionalExpression(node)) return read(node.whenTrue) && read(node.whenFalse);
    if (ts.isAwaitExpression(node)) return read(node.expression);
    if (ts.isNewExpression(node) && isLibSet(checker.getTypeAtLocation(node))) return node.arguments?.length === 1 && read(node.arguments[0]);
    if (isAccess(node)) {
      const base = bare(node.expression), key = w1(node).key;
      if (ts.isIdentifier(base)) {
        const issue = contentIssue(symbolAt(base), [key, '*'], true);
        if (issue) throw new SqlProofError(issue);
      }
      // This helper audits writes, not a second type boundary. The caller has already
      // required F02 for the entire array expression (including typed library producers).
      return key !== undefined;
    }
    if (ts.isCallExpression(node)) {
      const callee = bare(node.expression);
      if (isAccess(callee) && lib(checker.getResolvedSignature(node)?.declaration ?? node)
        && ['map', 'flatMap', 'filter', 'slice', 'sort'].includes(w1(callee).key)) {
        const fn = node.arguments[0] && bare(node.arguments[0]);
        if (w1(callee).key === 'map' && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const returned = returnsOf(fn);
          if (returned.length && returned.every(value => ts.isCallExpression(bare(value)) && valueType(checker.getTypeAtLocation(bare(value)))
            && !sqlValue(value).why)) return true;
        }
        return read(callee.expression);
      }
      return !sqlValue(node).why;
    }
    return false;
  }
  /** Local fixed compositions only. Unknown text never becomes an empty fragment. W4 continues to
   *  reject fragments written through an alias or handed to code whose use we cannot follow. */
  function composedSql(expression, writer, seen = new Set(), bound = null, templates = new Set()) {
    const node = bare(expression);
    const fail = why => { throw new SqlProofError(`${where(node)}: ${why}`); };
    if (seen.has(node) || seen.size > 64) fail('recursive SQL composition');
    const next = new Set(seen).add(node);
    const compose = value => composedSql(value, writer, next, bound, templates);
    const given = boundArgument(node, bound);
    if (given) {
      const issue = contentIssue(symbolAt(node));
      if (issue) fail(issue);
      return composedSql(given.expression, writer, next, given.outer, templates);
    }
    if (node.getSourceFile() !== writer.getSourceFile()) fail('SQL fragment comes from another module');
    // A nullable fragment's null branch is a bound null, not SQL text. Keeping even unreachable
    // branches is a conservative superset (e.g. a later truthiness check selects the fragment).
    if (nothing(node)) return [sqlParameter(node)];
    if (ts.isConditionalExpression(node)) return [...compose(node.whenTrue), ...compose(node.whenFalse)];
    if (prismaMember(node) === 'empty') return [sqlText('')];
    if (ts.isTaggedTemplateExpression(node) && prismaMember(node.tag) === 'sql') {
      templates.add(node.template);
      return composedTemplate(node.template, writer, next, bound, templates);
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node), declarations = symbol?.declarations ?? [], [declaration] = declarations;
      if (declarations.length !== 1 || declaration.getSourceFile() !== writer.getSourceFile()) fail('SQL holder is not local');
      const issue = changedBinding(symbol) || contentIssue(symbol) || parameterHazard(declaration);
      if (issue) fail(issue);
      if (isConst(declaration) && declaration.initializer) return compose(declaration.initializer);
      if (ts.isParameter(declaration) && W3_KINDS.has(helperKind(declaration.parent).kind)) {
        const inputs = parameterInputs(declaration, symbol, node.text);
        if (inputs.why) fail(inputs.why);
        return inputs.found.flatMap(compose);
      }
      fail('SQL holder is not a const or a closed helper parameter');
    }
    if (ts.isCallExpression(node)) {
      const name = prismaMember(node.expression);
      if (name === 'raw') {
        const literal = bare(node.arguments[0]);
        if (node.arguments.length !== 1 || !(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)))
          fail('Prisma.raw text is not literal');
        templates.add(literal);
        return [sqlText(literal.text)];
      }
      if (name === 'join') {
        const args = node.arguments.slice(1).map(bare);
        if (args.some(arg => !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)))) fail('join punctuation is not literal');
        const [separator = ',', prefix = '', suffix = ''] = args.map(arg => arg.text);
        if (args.length > 3 || !node.arguments[0]) fail('unsupported join arguments');
        const array = bare(node.arguments[0]), literal = fragmentArray(array, writer);
        // A literal array is a finite composition (including each conditional fragment).
        if (literal && !literal.elements.some(ts.isSpreadElement)) {
          let variants = [sqlText(prefix)];
          for (const [index, item] of literal.elements.entries()) {
            if (index) variants = sqlProduct(variants, [sqlText(separator)]);
            variants = sqlProduct(variants, composedInterpolation(item, writer, next, bound, templates));
          }
          if (!literal.elements.length) fail('an empty join throws before SQL is sent');
          return sqlProduct(variants, [sqlText(suffix)]);
        }
        // An arbitrary number of *parameters*, separated by commas, cannot add identifiers. This
        // is repetition of a token class, not sampling array elements. Other separators fail closed.
        if (separator !== ',' || prefix || suffix) fail('unbounded join with structural punctuation');
        const escaped = keptNote(array);
        if (escaped) fail(escaped);
        const element = elementType(array);
        if (element && (valueType(element) && !sqlValue(array).why && arrayInputsKept(array) || projectedValue(array, ['*'], bound ?? new Map()))) {
          const lost = keptNote(array);
          if (lost) fail(lost);
          const value = sqlValue(array);
          if (value.why && !projectedValue(array, ['*'])) fail(value.why);
          // The repetition proof concerns each element, not the array as one F02 parameter.
          return [{ ...sqlParameter(array), repeated: new Set([array]) }];
        }
        // Array#map of bound values with casts is the other repetition used by the product.
        // Restrict its grammar to parameter[::type]; arbitrary repeated SQL is not enumerated.
        if (ts.isCallExpression(array) && isAccess(bare(array.expression)) && w1(bare(array.expression)).key === 'map'
          && lib(checker.getResolvedSignature(array)?.declaration ?? array)) {
          const fn = array.arguments[0];
          if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) fail('map callback is not local');
          const returned = returnsOf(fn);
          if (!returned.length) fail('map callback has no return');
          const variants = returned.flatMap(compose);
          for (const variant of variants) {
            let tokens;
            try { tokens = sqlTokens(variant.parts); } catch (error) { fail(error.message); }
            if (!(tokens[0]?.kind === 'param' && (tokens.length === 1 || tokens.length === 3
              && tokens[1].value === '::' && ['word', 'ident'].includes(tokens[2].kind)))) fail('map is not a bound value with an optional cast');
            for (const span of variant.spans) { const value = sqlValue(span); if (value.why) fail(value.why); }
          }
          return variants;
        }
        fail('join array elements are unknown');
      }
      const owners = functionsOf(node.expression, 'w3');
      if (!owners?.length || node.arguments.some(ts.isSpreadElement)) fail(`SQL helper \`${snippet(node.expression)}\` is not followed`);
      return owners.flatMap(owner => {
        if (owner.getSourceFile() !== writer.getSourceFile()) fail('SQL helper comes from another module');
        const bindings = new Map();
        owner.parameters.forEach((parameter, index) => {
          const argument = node.arguments[index - shift(owner)] ?? parameter.initializer;
          if (parameter.dotDotDotToken || !argument) fail('SQL helper arguments are not fixed');
          bindings.set(parameter, { expression: argument, outer: bound });
        });
        const returned = returnsOf(owner);
        if (!returned.length) fail('SQL helper has no return');
        return returned.flatMap(value => composedSql(value, writer, next, bindings, templates));
      });
    }
    fail(`unsupported SQL composition \`${snippet(node)}\``);
  }
  function composedInterpolation(expression, writer, seen, bound, templates) {
    const node = bare(expression), given = boundArgument(node, bound);
    if (given && isFragment(node)) {
      const issue = contentIssue(symbolAt(node));
      if (issue) throw new SqlProofError(issue);
    }
    if (given) return composedInterpolation(given.expression, writer, seen, given.outer, templates);
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse]
      .flatMap(value => composedInterpolation(value, writer, seen, bound, templates));
    if (isFragment(node)) return composedSql(node, writer, seen, bound, templates);
    const value = sqlValue(node);
    if (value.why) throw new SqlProofError(value.why);
    return [sqlParameter(node)];
  }
  function composedTemplate(source, writer, seen, bound, templates) {
    if (!ts.isTemplateExpression(source)) return [sqlText(source.text)];
    let variants = [sqlText(source.head.text)];
    for (const span of source.templateSpans) {
      variants = sqlProduct(variants, composedInterpolation(span.expression, writer, seen, bound, templates));
      variants = sqlProduct(variants, [sqlText(span.literal.text)]);
    }
    return variants;
  }
  function rawCall(call) {
    try { return proveRawCall(call); }
    catch (error) {
      if (!(error instanceof SqlProofError)) throw error;
      return note(call, 'raw call', 'unresolved', error.message, 'F02 binding provenance');
    }
  }
  function proveRawCall(call) {
    let source = ts.isTaggedTemplateExpression(call) ? call.template : null;
    const argument = !source && call.arguments.length === 1 ? bare(call.arguments[0]) : null;
    if (argument && ts.isTaggedTemplateExpression(argument) && prismaMember(argument.tag) === 'sql') source = argument.template;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) source = argument;
    // Keep the existing two positive audit-write grammars and their narrower WITH predicate rule.
    // For a read or a composition, enumerate first, then apply those same grammars to every variant.
    if (source) {
      const parts = ts.isTemplateExpression(source) ? [source.head.text, ...source.templateSpans.map(span => span.literal.text)] : [source.text];
      try {
        const tokens = sqlTokens(parts);
        if (tokens.some(token => (token.kind === 'word' || token.kind === 'ident') && token.name.toLowerCase() === 'auditlog')
          && !readsOnly(tokens)) return rawVariant(call);
      } catch { /* A fragment seam may close the token; the composed text is still lexed below. */ }
      if (!ts.isTemplateExpression(source) || !source.templateSpans.some(span => isFragment(bare(span.expression)))) return rawVariant(call);
    }
    let variants;
    const templates = new Set();
    try {
      variants = source ? composedTemplate(source, call, new Set(), null, templates)
        : argument ? composedSql(argument, call, new Set(), null, templates) : null;
    } catch (error) {
      if (!(error instanceof SqlProofError)) throw error;
      // The original diagnosis also identifies cast/escape paths guarded by W4 and F02.
      const entry = rawVariant(call);
      entry.reason += `; composition: ${error.message}`;
      return entry;
    }
    if (!variants?.length) return rawVariant(call);
    if (variants.length > 256) return note(call, 'raw call', 'unresolved', 'SQL alternatives exceed the enumeration limit', 'F02 composition');
    for (const template of templates) claimed.add(template);
    if (source) claimed.add(source);
    const at = candidates.length, written = sites.length;
    for (const variant of variants) rawVariant(call, variant);
    const results = candidates.splice(at), writers = sites.splice(written);
    const failed = results.filter(result => result.status === 'unresolved');
    if (failed.length) return note(call, failed[0].kind, 'unresolved', [...new Set(failed.map(result => result.reason))].join('; '), 'F02 composition; W5');
    if (writers.length) {
      const found = union(...writers.map(site => site.actions.map(action => text(action, site.origins, 'W5 composition'))),
        ...writers.map(site => site.prefixes.map(value => prefix(value, 'composed action', site.rules))));
      return record(call, writers[0].via, found, null, [...new Set(writers.flatMap(site => site.basis))],
        [...new Set(writers.flatMap(site => site.fragments))], [...new Set(writers.flatMap(site => site.rules))]);
    }
    return note(call, results[0].kind, 'proven_non_audit', `all ${variants.length} SQL alternatives: ${[...new Set(results.map(result => result.reason))].join('; ')}`, 'W6 composition');
  }
  /**
   * A raw call. Its SQL must be one fixed text of the program. Every interpolation is judged first (F02), whatever the SQL
   * says: a value (sqlValue), or — only inside a G2 WITH body — a fixed predicate (W5); a fragment anywhere else leaves it
   * unresolved. Then: SQL naming no AuditLog, AuditLog only in strings or comments, and one SELECT that changes no row are
   * not writes (W6); G1 and G2 are writes (W5); every other statement naming AuditLog is unresolved.
   */
  function rawVariant(call, composed = null) {
    let source = null;
    if (ts.isTaggedTemplateExpression(call)) source = call.template;
    else if (call.arguments.length === 1) {
      const argument = bare(call.arguments[0]);
      if (ts.isTaggedTemplateExpression(argument) && prismaMember(argument.tag) === 'sql') source = argument.template;
      else if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) source = argument;
    }
    if (!source && !composed) return note(call, 'raw call', 'unresolved', `its SQL is not one fixed text of the program: \`${snippet(call)}\``, 'W6');
    if (source) claimed.add(source);
    const parts = composed?.parts ?? (ts.isTemplateExpression(source) ? [source.head.text, ...source.templateSpans.map(span => span.literal.text)] : [source.text]);
    const spans = composed?.spans ?? (ts.isTemplateExpression(source) ? source.templateSpans.map(span => span.expression) : []);
    let tokens, form = null;
    try { tokens = sqlTokens(parts); }
    catch (error) { return note(call, 'raw call', 'unresolved', `${error.message} in its SQL`, 'W6'); }
    // A string executed by SQL is SQL text, not a harmless string containing a table name.
    if (tokens.some((token, index) => token.kind === 'word' && (token.upper === 'EXECUTE'
      || ['DO', 'CALL'].includes(token.upper) && (index === 0 || tokens[index - 1]?.value === ';')
      || token.upper === 'CREATE' && (index === 0 || tokens[index - 1]?.value === ';')
        && tokens.slice(index + 1, index + 5).some(next => next.kind === 'word'
          && ['FUNCTION', 'PROCEDURE', 'TRIGGER', 'RULE'].includes(next.upper)))))
      return note(call, 'raw call', 'unresolved', 'dynamic SQL execution is not modelled', 'W6');
    const names = tokens.some(token => (token.kind === 'ident' || token.kind === 'word') && token.name.toLowerCase() === 'auditlog');
    if (names) form = readsOnly(tokens) ? { read: true } : insertForm(tokens);
    const writes = form && !form.read && !form.error;
    const slot = writes && form.action.length === 1 && form.action[0].kind === 'param' ? form.action[0] : null;
    const inWith = token => writes && form.form === 'G2' && tokens.indexOf(token) < form.insert;
    const kind = writes ? 'raw INSERT INTO "AuditLog"' : form ? 'raw SQL naming AuditLog' : 'raw call';
    // F02 first: what every interpolation is (every one that is not a value or a fixed predicate is named).
    const basis = [], rules = new Set(), fragments = [], problems = [];
    for (const [index, expression] of spans.entries()) {
      if (slot && slot.index === index) continue;   // the action: read by W2 below
      if (composed?.repeated?.has(expression)) { rules.add('F02 comma-separated bound values (every element proved)'); continue; }
      const token = tokens?.find(item => item.kind === 'param' && item.index === index);
      if (isFragment(expression)) {
        if (token && inWith(token)) {
          const predicate = fixedPredicate(expression, call);
          if (predicate.error) { problems.push({ rule: 'W5', why: `the WITH fragment \`${snippet(expression)}\`: ${predicate.error}` }); continue; }
          basis.push(predicate.basis);
          predicate.rules.forEach(rule => rules.add(rule));
          fragments.push(expression);
          continue;
        }
        problems.push({ rule: 'F02', why: writes
          ? `\`${snippet(expression)}\` (${typeText(checker.getTypeAtLocation(expression))}) is not shown to be a value: an SQL fragment after INSERT (W5 takes one only as a WITH predicate)`
          : `\`${snippet(expression)}\` (${typeText(checker.getTypeAtLocation(expression))}) is an SQL fragment: in a raw call that writes no audit row F02 takes only values (a fragment only as a G2 WITH predicate, W5)` });
        continue;
      }
      const value = sqlValue(expression);
      if (value.why) { problems.push({ rule: 'F02', why: `\`${snippet(expression)}\` is not shown to be a value: ${value.why}` }); continue; }
      value.rules.forEach(rule => rules.add(rule));
    }
    if (problems.length) {
      return note(call, kind, 'unresolved', problems.map(problem => problem.why).join('; '), [...new Set(problems.map(problem => problem.rule))].join('; '));
    }
    const valued = spans.length ? `every interpolation a value (${[...rules].join('; ')})` : 'no interpolation';
    if (!names) return note(call, 'raw call', 'proven_non_audit', `${parts.some(part => TABLE_WORDS.test(part))
      ? 'AuditLog is only in its strings or comments' : 'its SQL names no AuditLog'}; ${valued}`, 'W6');
    if (!form) return note(call, 'raw call', 'proven_non_audit', `AuditLog is only in its strings or comments; ${valued}`, 'W6');
    if (form.read) return note(call, 'raw SQL naming AuditLog', 'proven_non_audit', `one SELECT that changes no row reads AuditLog; ${valued}`, 'W6');
    if (form.error) return note(call, 'raw SQL naming AuditLog', 'unresolved', form.error, 'W5');
    const count = form.columns.length, position = form.columns.indexOf('action') + 1;
    const column = form.form === 'G1' ? `column ${position} of ${count}`
      : `item ${position} of ${count} of INSERT … SELECT … FROM ${form.from}${form.ctes.length ? ` after WITH ${form.ctes.map(cte => cte.shown).join(', ')}` : ''}`;
    const [action] = form.action;
    if (form.action.length !== 1 || (action.kind !== 'string' && action.kind !== 'param')) {
      return note(call, kind, 'unresolved', `the action value is not one SQL string or one interpolation: ${form.action.map(shown).join(' ')}`, 'W5');
    }
    const found = action.kind === 'string' ? [text(action.value, [], 'W5 SQL string')] : values(spans[action.index]);
    record(call, kind, found, null, [action.kind === 'string' ? `SQL string '${action.value}' at ${column}`
      : `the interpolation \`${snippet(spans[action.index])}\` at ${column}`, ...basis, ...(spans.length ? [valued] : [])], fragments,
    [`W5 ${form.form}`, ...rules]);
  }
  /**
   * W5: a fragment interpolated in a G2 WITH body — every value it can take is a Prisma.sql text of the one shape
   * `[alias.]column = ${value}::type` (its interpolation a value, F02), written directly as the argument of a call of a
   * private or local helper of the writer's file that nothing replaces, or held on the way by a const; each holder is
   * used for nothing else (W4: interpolated here, passed to such a helper, aliased by a const, or tested), else {error}.
   */
  function fixedPredicate(expression, writer) {
    const sources = predicateSources(expression, new Set(), writer);
    const unfixed = sources.find(source => source.unknown);
    if (unfixed) return { error: unfixed.unknown };
    const shapes = new Set(), rules = new Set(['W5 predicate']);
    for (const { tagged: at, via } of sources) {
      const why = predicateShape(at, rules);
      if (why) return { error: `${where(at)}: ${why}` };
      shapes.add(`${snippet(at)} (${where(at)})`);
      via.forEach(rule => rules.add(rule));
    }
    return { basis: `the WITH fragment \`${snippet(expression)}\` (${where(expression)}) is ${[...shapes].join(' or ')}`, rules: [...rules] };
  }
  const SHAPE = 'the predicate `[alias.]column = ${value}::type`';
  function predicateSources(expression, seen, writer, via = []) {
    const node = bare(expression);
    if (ts.isTaggedTemplateExpression(node) && prismaMember(node.tag) === 'sql') {
      if (node.getSourceFile() !== writer.getSourceFile()) return [{ unknown: `${where(node)}: the predicate is written in another file than the write` }];
      return [{ tagged: node, via }];
    }
    if (!ts.isIdentifier(node)) return [{ unknown: `${where(node)}: \`${snippet(node)}\` is not a Prisma.sql text` }];
    const symbol = symbolAt(node), declarations = symbol?.declarations ?? [];
    if (declarations.length !== 1) return [{ unknown: `${where(node)}: \`${node.text}\` ${declarations.length ? 'has several declarations' : 'does not resolve'}` }];
    const [declaration] = declarations;
    if (seen.has(declaration)) return [{ unknown: `${where(node)}: \`${node.text}\` is reached again through the calls it comes from` }];
    const next = new Set(seen).add(declaration);
    const changed = references(symbol).find(reference => mutated(outer(reference)));
    if (changed) return [{ unknown: `${where(changed)}: \`${node.text}\` is changed` }];
    if (declaration.getSourceFile() !== writer.getSourceFile()) return [{ unknown: `${where(node)}: \`${node.text}\` is declared in another file than the write` }];
    const escape = predicateHolder(declaration, writer);
    if (escape) return [{ unknown: `${where(node)}: \`${node.text}\` holds an SQL fragment that ${escape}` }];
    if (isConst(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer) {
      return predicateSources(declaration.initializer, next, writer, [...via, `W5 const \`${node.text}\``]);
    }
    if (!ts.isParameter(declaration) || !ts.isFunctionLike(declaration.parent)) {
      return [{ unknown: `${where(node)}: \`${node.text}\` is a ${K[declaration.kind]} that is not const` }];
    }
    const owner = declaration.parent, index = owner.parameters.indexOf(declaration) - shift(owner), kind = helperKind(owner);
    if (declaration.dotDotDotToken || !ts.isIdentifier(declaration.name)) return [{ unknown: `${where(declaration)}: \`${node.text}\` is a rest or destructured parameter` }];
    if (!['private method', 'function of its file', 'const function'].includes(kind.kind)) {
      return [{ unknown: `${where(declaration)}: \`${node.text}\` is a parameter of ${describe(owner)}, ${kind.why ?? 'a callback, not a private or local helper'}` }];
    }
    const { calls: found, escapes } = callsOf(owner, 'w3');
    if (escapes.length) return [{ unknown: `${where(declaration)}: \`${node.text}\` is a parameter of ${describe(owner)}, which is handed on at ${escapes.join(', ')}` }];
    if (!found.length) return [{ unknown: `${where(declaration)}: \`${node.text}\` is a parameter of ${describe(owner)}, which nothing in the program calls` }];
    return found.flatMap(call => {
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return [{ unknown: `${where(call)}: a spread argument` }];
      if (call.getSourceFile() !== writer.getSourceFile()) return [{ unknown: `${where(call)}: a call from another file than the write` }];
      const argument = call.arguments[index] ?? declaration.initializer;
      return argument ? predicateSources(argument, next, writer, [...via, `W5 argument of ${describe(owner)} (${helperKind(owner).kind})`])
        : [{ unknown: `${where(call)}: no argument for \`${node.text}\`` }];
    });
  }
  /** W4 for a predicate's holder (a const or a parameter): each use interpolated in the write, passed to a private or local
   *  helper of the file, aliased by a const whose uses keep to the same, or tested — else why. */
  function predicateHolder(declaration, writer) {
    const queue = [declaration], seen = new Set();
    while (queue.length) {
      const holder = queue.shift();
      if (seen.has(holder)) continue;
      seen.add(holder);
      for (const reference of references(symbolAt(holder.name))) {
        const node = lifted(reference), parent = node.parent;
        if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) return `is asserted to \`${parent.type.getText()}\` at ${where(parent)}`;
        if (ts.isTemplateSpan(parent) && parent.expression === node) {
          if (parent.parent.parent === writer || parent.parent === writer.template) continue;
          return `is interpolated elsewhere at ${where(parent)}`;
        }
        if (isConst(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) { queue.push(parent); continue; }
        if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
          // Passed to a private or local helper of the file: the parameter it lands in keeps to the same rule.
          const owners = callees(parent, 'w3'), targets = owners && argumentTargets(parent, parent.arguments.indexOf(node), 'w3');
          if (owners?.length && targets && owners.every(owner => ['private method', 'function of its file', 'const function'].includes(helperKind(owner).kind))) {
            queue.push(...targets);
            continue;
          }
          return `is handed to \`${snippet(parent.expression)}\` at ${where(parent)}`;
        }
        if (isAccess(parent) && parent.expression === node) {
          let member = outer(parent);
          while (!mutated(member) && isAccess(member.parent) && member.parent.expression === member) member = outer(member.parent);
          return mutated(member) ? `is written at ${where(member.parent)}` : `is handed on at ${where(parent)} (a part of it read)`;
        }
        if (inert(node)) continue;
        if (mutated(node)) return `is written at ${where(parent)}`;
        return `is handed on at ${where(parent)}`;
      }
    }
    return null;
  }
  /** Why a Prisma.sql text is not exactly SHAPE with a value interpolated, or null. */
  function predicateShape(tagged, rules) {
    const template = tagged.template;
    const parts = ts.isTemplateExpression(template) ? [template.head.text, ...template.templateSpans.map(span => span.literal.text)] : [template.text];
    let tokens;
    try {
      tokens = sqlTokens(parts);
    } catch (error) {
      return `${error.message} in its text`;
    }
    const name = token => token?.kind === 'ident' || token?.kind === 'word';
    const operator = (token, value) => token?.kind === 'operator' && token.value === value;
    const n = name(tokens[0]) && tokens[1]?.kind === 'punct' && tokens[1].value === '.' ? 2 : 0;
    if (!(name(tokens[n]) && operator(tokens[n + 1], '=') && tokens[n + 2]?.kind === 'param' && operator(tokens[n + 3], '::')
      && name(tokens[n + 4]) && tokens.length === n + 5)) return `\`${snippet(tagged)}\` is not ${SHAPE}`;
    const inner = template.templateSpans[tokens[n + 2].index].expression;
    if (isFragment(inner)) return `\`${snippet(inner)}\` is not shown to be a value: it is an SQL fragment`;
    const value = sqlValue(inner);
    if (value.why) return `\`${snippet(inner)}\` is not shown to be a value: ${value.why}`;
    value.rules.forEach(rule => rules.add(rule));
    return null;
  }

  // ── the writes ──
  const READS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);
  function record(node, via, found, action, basis = [], fragments = [], rules = []) {
    const unread = found.filter(value => value.text === undefined && value.prefix === undefined);
    if (!found.length || unread.length) {
      return note(node, via, 'unresolved', !found.length ? 'its action has no value in the program'
        : unread.map(value => value.unknown).join('; '), 'W2');
    }
    const origins = [...new Set(found.flatMap(value => value.from ?? []))];
    const site = { ...position(node), via, actions: found.filter(value => value.text !== undefined).map(value => value.text).sort(),
      prefixes: found.filter(value => value.prefix !== undefined).map(value => value.prefix).sort(),
      basis: [...basis, ...origins.map(origin => `${where(origin)} ${JSON.stringify(origin.text)}`),
        ...found.filter(value => value.prefix !== undefined).map(value => `${value.prefix}… then ${value.why}`)],
      rules: [...new Set([...rules, ...found.flatMap(value => value.rules)])].sort() };
    Object.defineProperties(site, { call: { value: node }, action: { value: action }, origins: { value: origins }, start: { value: node.getStart() },
      fragments: { value: fragments } });
    sites.push(site);
    note(node, via, 'resolved', site.basis.join('; '), site.rules.join('; '));
  }
  /** W1: the property `name` an object literal ends up with — its last definition, unless a later spread or a key W1
   *  does not fix may set it. */
  function property(object, name) {
    let found = { why: 'is not set' };
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) { found = { why: `may be set by the spread at ${where(member)}` }; continue; }
      const key = member.name ? w1(member.name) : { why: 'no name' };
      if (key.key === undefined) found = { why: `may be set by the computed key at ${where(member)} (${key.why})` };
      else if (key.key === name) {
        found = ts.isPropertyAssignment(member) ? { node: member.initializer, member, rule: key.rule }
          : ts.isShorthandPropertyAssignment(member) ? { shorthand: member, member, rule: key.rule } : { why: `is an accessor or method at ${where(member)}` };
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
    record(call, 'auditLog.create', found, action, action.member ? [`action \`${snippet(action.member)}\``] : [], [],
      ['W1 data and action', ...(action.rule ? [action.rule] : [])]);
  }
  /** `x.auditLog` (any key W1 fixes): only the receiver of a called method; `create` is a write this check reads. */
  function delegate(access, rule) {
    const held = outer(access), parent = held.parent;
    if (!isAccess(parent) || parent.expression !== held) {
      return note(access, 'auditLog delegate', 'unresolved', `the delegate is used other than by calling one of its methods (${K[parent.kind]})`, 'SPEC-F01');
    }
    const method = w1(parent);
    if (method.key === undefined) return note(parent, 'auditLog method', 'unresolved', `a method of the delegate by a key the program does not fix (${method.why})`, 'W1');
    const callee = outer(parent), call = callee.parent;
    if (READS.has(method.key)) return note(parent, `auditLog.${method.key}`, 'proven_non_audit', 'a read method of the delegate', 'W6 delegate read');
    if (!ts.isCallExpression(call) || call.expression !== callee) {
      return note(parent, `auditLog.${method.key}`, 'unresolved', 'the method is used other than by calling it', 'SPEC-F01');
    }
    if (method.key !== 'create') return note(call, `auditLog.${method.key}`, 'unresolved', 'writes rows this check does not read', 'SPEC-F01');
    create(call);
  }
  function access(node) {
    const inner = bare(node.expression);
    if (isAccess(inner) && w1(inner).key === 'auditLog') return;   // the delegate's method: read by delegate()
    const found = w1(node);
    if (found.key !== undefined && RAW.has(found.key)) {
      const held = outer(node), parent = held.parent;
      const called = (ts.isTaggedTemplateExpression(parent) && parent.tag === held) || (ts.isCallExpression(parent) && parent.expression === held);
      return called ? rawCall(parent) : note(node, 'raw call', 'unresolved', 'a raw method used other than by calling it', 'SPEC-F01');
    }
    if (found.key === 'auditLog') return delegate(node, found.rule);
    if (!ts.isElementAccessExpression(node)) return;
    const literal = [K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.NumericLiteral].includes(bare(node.argumentExpression).kind);
    if (literal) return;
    if (found.key !== undefined) {
      if (isClient(node.expression)) note(node, 'member of a client', 'proven_non_audit', `the key is ${found.key} (${found.rule})`, 'W1');
      return;
    }
    if (isClient(node.expression)) note(node, 'member of a client', 'unresolved', `a member of a client value by a key the program does not fix (${found.why})`, 'W1');
    else note(node, 'computed key', 'proven_non_audit', `no client value reaches \`${snippet(node.expression)}\``, 'SPEC-F01 client flow');
  }
  /** A destructured property of a client, or one named auditLog: the delegate taken out of its client. */
  function destructuring(node, keyNode, source, rest) {
    const key = rest || !keyNode ? {} : w1(keyNode);
    if (key.key === 'auditLog') return note(node, 'auditLog delegate', 'unresolved', 'the delegate is taken out of its client by destructuring', 'SPEC-F01');
    if (source && isClient(source) && (key.key === undefined || rest)) {
      note(node, 'member of a client', 'unresolved', rest ? 'the rest of a client is taken out by destructuring' : 'a member of a client is taken out by a key the program does not fix', 'W1');
    }
  }
  /** Prisma's SQL fragment builders: a fragment whose text the program does not fix. */
  function fragment(node) {
    const name = prismaMember(node.expression);
    if (!name) return;
    const literal = argument => !!argument && (ts.isStringLiteral(bare(argument)) || ts.isNoSubstitutionTemplateLiteral(bare(argument)));
    if ((name === 'raw' && !literal(node.arguments?.[0])) || (name === 'sql' && ts.isCallExpression(node)) || name === 'Sql'
      || (name === 'join' && (node.arguments?.length ?? 0) > 1 && !node.arguments.slice(1).every(literal))) {
      note(node, 'raw SQL fragment', 'unresolved', `\`${snippet(node)}\`: SQL whose text the program does not fix`, 'F02');
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
    if (broken.length) note(file, 'source file', 'unresolved', `does not parse: ${ts.flattenDiagnosticMessageText(broken[0].messageText, ' ')}`, 'SPEC-F01');
    else files.push(file);
  }
  // The client flow: the seeds, then every binding, argument and result a client reaches, to a fixed point.
  const bindings = [], calledAt = [], returns = [];
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
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) calledAt.push(node);
    if (ts.isReturnStatement(node) && node.expression && enclosing(node)) returns.push([enclosing(node), node.expression]);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) returns.push([node, node.body]);
    ts.forEachChild(node, collect);
  };
  files.forEach(collect);
  const memberName = declaration => ((ts.isPropertyDeclaration(declaration) || (ts.isParameter(declaration) && ts.getCombinedModifierFlags(declaration)
    & (ts.ModifierFlags.ParameterPropertyModifier))) && declaration.name && !ts.isComputedPropertyName(declaration.name) ? declaration.name.text : null);
  for (let changed = true; changed;) {
    changed = false;
    const add = (set, item) => { if (!set.has(item)) { set.add(item); changed = true; } };
    for (const [declaration, value] of bindings) if (!clients.has(declaration) && isClient(value)) add(clients, declaration);
    for (const call of calledAt) {
      (call.arguments ?? []).forEach((argument, index) => {
        if (ts.isSpreadElement(argument) || !isClient(argument)) return;
        for (const owner of callees(call, 'flow') ?? []) {
          const parameter = owner.parameters[index + shift(owner)];
          if (parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken) add(clients, parameter);
        }
      });
    }
    for (const [owner, value] of returns) if (!clientFunctions.has(owner) && isClient(value)) add(clientFunctions, owner);
    for (const declaration of clients) { const name = memberName(declaration); if (name) add(clientMembers, name); }
  }
  // W4 over every fragment first: the values judged by their type below rely on it, in the files connected by calls to
  // where one is handed on.
  const before = candidates.length;
  fragmentFlow();
  const escaped = candidates.slice(before);
  const roots = new Map();
  const rootOf = file => { let at = file; while (roots.has(at) && roots.get(at) !== at) at = roots.get(at); return at; };
  const link = (a, b) => { const [x, y] = [rootOf(a), rootOf(b)]; if (x !== y) roots.set(x, y); };
  for (const file of files) roots.set(repoPath(file.fileName), repoPath(file.fileName));
  if (escaped.length) {
    for (const call of calledAt) {
      for (const owner of callees(call, 'flow') ?? []) if (inProgram(owner)) link(position(call).file, position(owner).file);
    }
  }
  escapedNear = node => {
    const root = rootOf(position(node).file);
    const near = escaped.filter(entry => rootOf(entry.file) === root);
    return near.length ? near.map(entry => `${entry.file}:${entry.line}`).join(', ') : null;
  };
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
    const receiving = argument && callees(parent, 'flow')?.every(owner => {
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
      || (argument && receiving) || (owner && callsOf(owner, 'flow').escapes.length === 0) || inert(node)) return;
    note(start, 'client value', 'unresolved', `\`${snippet(start)}\`: ` + (argument ? `a client value handed to \`${snippet(parent.expression)}\`, which this check does not follow`
      : owner ? `a client value returned from ${describe(owner)}, which is handed on` : `a client value used in a ${K[parent.kind]}, where this check does not follow it`), 'SPEC-F01 client flow');
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
  for (const node of naming) if (!claimed.has(node)) note(node, 'SQL naming AuditLog', 'unresolved', 'names AuditLog but is not the fixed SQL of a raw call', 'W6');
  const scan = { typescript: ts.version, files: sources.map(source => source.file), sites, candidates,
    unresolved: candidates.filter(entry => entry.status === 'unresolved').map(entry => `${entry.file}:${entry.line} ${entry.kind}: ${entry.reason}`),
    flow: { clients: [...clients].map(declaration => `${where(declaration)} ${declaration.name?.getText() ?? K[declaration.kind]}`).sort(),
      functions: [...clientFunctions].map(describe).sort(), members: [...clientMembers].sort() } };
  Object.defineProperties(scan, { tools: { value: { ts, bare, symbolAt, references } } });
  return scan;
}

// ── the verdict: the contract table is read here only ──

const VERDICT = {
  unread_sources: 'every script file under api/src and every api/prisma/*.cjs entry point is read by the program',
  unresolved: 'an audit candidate lacks proof',
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


test('completeness: every api/src file and prisma CJS entry point is read, every candidate is proved, both directions hold', () => {
  const { sources, listing } = productSources();
  const scan = scanAuditWrites(sources);
  const found = verdict(scan, productTable(), listing);
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
    unresolved: scan.unresolved.length,
    distinct_actions: literals.size, dynamic_prefixes: [...new Set(scan.sites.flatMap(site => site.prefixes))].sort(),
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

test('completeness: a Prisma CJS entry point is scanned and its unlisted raw write fails', () => {
  const file = 'api/prisma/synthetic-audit-entry.cjs';
  const source = { file, text: "db.$executeRaw`INSERT INTO \"AuditLog\" (action) VALUES ('syn.cjs-unlisted')`;" };
  const scan = scanAuditWrites([...baselineSources(), source]);
  assert.ok(scan.files.includes(file));
  assert.equal(scan.sites.filter(site => site.file === file).length, 1);
  assert.deepEqual(verdict(scan, fixtureTable()), { ...EMPTY_VERDICT, unlisted: ['syn.cjs-unlisted'] });
  assert.deepEqual(sourceListing([file], []).unread, [file]);
});

// ── the checker's own tests, on test-owned fixtures ──
// Each fixture declares what it expects: `// expect:` on a line names the candidate the line gives, the violations'
// headers name the one failure class each must cause, and contract.json is their table. Nothing here is read from the
// checker's output to decide what is expected. tests/fixtures/admin_audit_completeness is fix4-fix5's (Astra
// S7-U3a-AUDIT-SPEC-R-001-F04); tests/fixtures/admin-audit-checker is fix6-fix7's: members.ts and supported.ts beside
// equivalent.ts and sql-positions.ts, violations.txt beside the other, and reclassified.json — every mark of the older
// fixtures the closed list W1-W6 (Astra S7-U3a-AUDIT-SPEC-C-R-001) changes, replaced where it stands (F03: a positive
// outside the list becomes an unresolved refusal there and in a case of its own; nothing is deleted or skipped).

const FIXTURES = path.join(__dirname, 'fixtures', 'admin_audit_completeness');
const MEMBER_FIXTURES = path.join(__dirname, 'fixtures', 'admin-audit-checker');
const fixtureText = (name, dir = FIXTURES) => readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const asSource = (name, text) => ({ file: `api/src/syn-fixture/${name}`, text });
const baselineSources = () => ['actions.ts', 'forward.ts', 'baseline.ts'].map(name => asSource(name, fixtureText(name)));
/** contract.json as a table, with a case's added rows or wildcards. */
function fixtureTable(added = {}) {
  const table = JSON.parse(fixtureText('contract.json'));
  const rows = [...table.rows, ...(added.rows ?? [])], wildcards = [...table.wildcards, ...(added.wildcards ?? [])];
  return { rows, wildcards, listed: action => rows.includes(action) || wildcards.some(stem => action.startsWith(stem)) };
}
const RECLASSIFIED = JSON.parse(fixtureText('reclassified.json', MEMBER_FIXTURES)).entries;
/** The ledger's entries for a fixture of tests/fixtures/admin_audit_completeness, by the file's line. */
const reclassified = name => new Map(RECLASSIFIED.filter(entry => entry.fixture === `admin_audit_completeness/${name}`).map(entry => [entry.line, entry]));
/**
 * A fixture's marks: line -> [{status, detail}]; a mark alone on its line is the next line's. `ledger` (the file's line ->
 * entry) replaces the mark of a line that must carry exactly the entry's `was`; `first` is the file line of the text's
 * first line (a violation case is a part of its file). Every entry in the text's lines must be used.
 */
function marks(text, ledger = new Map(), first = 1) {
  const found = new Map(), used = new Set(), lines = text.split('\n');
  lines.forEach((line, index) => {
    const mark = /\/\/ expect: ((resolved|proven_non_audit|unresolved)(?: (.*))?)$/.exec(line);
    if (!mark) return;
    const at = /^\s*\/\/ expect:/.test(line) ? index + 2 : index + 1;
    assert.ok(!found.has(at), `line ${at} is marked twice`);
    const entry = ledger.get(first + index);
    if (!entry) return found.set(at, [{ status: mark[2], detail: (mark[3] ?? '').trim() }]);
    assert.equal(mark[1], entry.was, `the reclassified line ${entry.fixture}:${entry.line} carries another mark`);
    used.add(entry.line);
    found.set(at, entry.now.map(item => ({ status: item.status, detail: item.detail })));
  });
  for (const line of ledger.keys()) if (line >= first && line < first + lines.length) assert.ok(used.has(line), `the reclassified line ${line} carries no mark`);
  return found;
}
/** The candidates of `scan` in `source` against its marks: each candidate one of its line's marks, as marked, every mark
 *  given, and no candidate on a line without one. */
function assertMarked(scan, source, ledger = new Map(), first = 1) {
  const expected = marks(source.text, ledger, first), left = new Map([...expected].map(([line, list]) => [line, [...list]]));
  for (const entry of scan.candidates.filter(entry => entry.file === source.file)) {
    const label = `${source.file}:${entry.line} ${entry.kind} ${entry.status}: ${entry.reason}`;
    const list = left.get(entry.line);
    assert.ok(expected.has(entry.line), `a candidate on a line without a mark: ${label}`);
    const site = entry.status === 'resolved' ? scan.sites.find(site => site.file === entry.file && site.start === entry.start) : null;
    const fits = mark => {
      if (mark.status !== entry.status) return false;
      if (mark.status !== 'resolved') return entry.reason.includes(mark.detail);
      const words = mark.detail.split(/\s+/).filter(Boolean);
      return JSON.stringify([site.actions, site.prefixes]) === JSON.stringify([words.filter(word => !word.startsWith('prefix:')).sort(),
        words.filter(word => word.startsWith('prefix:')).map(word => word.slice('prefix:'.length)).sort()]);
    };
    const at = list.findIndex(fits);
    assert.ok(at >= 0, `${label}\n  the line's marks say: ${JSON.stringify(expected.get(entry.line))}`);
    list.splice(at, 1);
  }
  assert.deepEqual([...left].filter(([, list]) => list.length).map(([line]) => line), [], `${source.file}: marked lines that gave no candidate`);
  const all = [...expected.values()].flat();
  return { marked: all.length, resolved: all.filter(mark => mark.status === 'resolved').length,
    unresolved: all.filter(mark => mark.status === 'unresolved').length };
}
/** Both violations.txt: one module per `// ==== case: <name> | verdict: <class> [entries] [| table: +row|+wildcard <x>] ====`,
 *  with the file line its first line is (for the ledger). */
function violationCases() {
  const cases = [];
  for (const dir of [FIXTURES, MEMBER_FIXTURES]) {
    let current = null;   // a file's note, before its first header, belongs to no case
    fixtureText('violations.txt', dir).split('\n').forEach((line, index) => {
      const header = /^\/\/ ==== case: (\S+) \| verdict: (\w+)((?: [^\s|]+)*)((?: \| table: \+(?:row|wildcard) \S+)*) ====$/.exec(line);
      if (header) {
        const table = { rows: [], wildcards: [] };
        for (const [, kind, value] of header[4].matchAll(/\| table: \+(row|wildcard) (\S+)/g)) table[kind === 'row' ? 'rows' : 'wildcards'].push(value);
        cases.push(current = { name: header[1], failing: header[2], entries: header[3].trim().split(/\s+/).filter(Boolean), table, lines: [],
          first: index + 2, ledger: dir === FIXTURES ? reclassified('violations.txt') : new Map(), fixture: path.basename(dir) });
      } else if (current) {
        current.lines.push(line);
      }
    });
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

test('checker self-test: the forms W1-W6 take, the INSERT positions and the kept objects each add exactly their marked writes; the forms fix7 leaves out are refused where they stand', () => {
  const base = scanAuditWrites(baselineSources()), before = inventory(base);
  for (const [name, dir] of [['equivalent.ts', FIXTURES], ['sql-positions.ts', FIXTURES], ['members.ts', MEMBER_FIXTURES], ['supported.ts', MEMBER_FIXTURES]]) {
    const ledger = dir === FIXTURES ? reclassified(name) : new Map();
    const source = asSource(name, fixtureText(name, dir)), scan = scanAuditWrites([...baselineSources(), source]);
    const count = assertMarked(scan, source, ledger);
    // Each marked write is one more site, and nothing of the baseline changed.
    assert.equal(scan.sites.filter(site => site.file === source.file).length, count.resolved, name);
    assert.deepEqual(inventory(scan).filter(entry => !entry.startsWith(source.file + '@')), before, name);
    // The gate passes but for the lines reclassified.json moved out of the list: each is an unresolved candidate there.
    const found = verdict(scan, fixtureTable());
    assert.deepEqual({ ...found, unresolved: [] }, EMPTY_VERDICT, name);
    assert.equal(found.unresolved.length, count.unresolved, name);
    for (const reason of found.unresolved) assert.ok(reason.startsWith(source.file + ':'), reason);
    console.log('ADMIN_AUDIT_CHECKER_SUPPORTED ' + JSON.stringify({ fixture: name, ...count, reclassified: [...ledger.keys()],
      sites: scan.sites.filter(site => site.file === source.file).map(site => `${site.line} ${site.via} [${site.actions}] [${site.prefixes}] ${site.rules.join('; ')}`),
      not_writes: scan.candidates.filter(entry => entry.file === source.file && entry.status === 'proven_non_audit').map(entry => `${entry.line} ${entry.kind}: ${entry.rule}`) }));
  }
});

test('checker self-test: every failure class fails the gate on its own, on exactly its marked candidates', async t => {
  const cases = violationCases(), results = [];
  assert.ok(cases.length >= 60, `${cases.length} cases`);
  assert.deepEqual(cases.map(entry => entry.name).filter((name, n, all) => all.indexOf(name) !== n), [], 'case names are unique');
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const scan = scanAuditWrites([...baselineSources(), entry.source]), found = verdict(scan, fixtureTable(entry.table));
      const count = assertMarked(scan, entry.source, entry.ledger, entry.first);
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

// Astra S7-U3a-AUDIT-SPEC-C-R-001-F03 (b): the counterexamples of S7-U3a-E-R-001 and S7-U3a-F-R-001 by finding and module
// variant, and C-RAW-CAST with its two variants (F02). Each is a case of tests/fixtures/admin-audit-checker/violations.txt
// the test above runs alone next to the baseline; here each must leave its write or raw call itself unresolved (not only
// a note beside it), with the gate failing on nothing but unresolved. The normal controls F01-F03 name stay resolved in
// members.ts (a helper called by a constant key) and supported.ts (a string parameter in an audit INSERT, a method called
// and never replaced), and sql-positions.ts (an unchanged predicate from two callers).
const COUNTEREXAMPLES = {
  'S7-U3a-E-R-001-F01': {
    'an action helper called by an unknown value through a constant key': 'e-f01-a-helper-called-by-a-constant-key-with-a-request-value',
    'a readonly field written by a constant key': 'e-f01-a-readonly-field-written-by-a-constant-key',
    'a WITH helper called by a constant key with an unfixed fragment': 'e-f01-a-with-fragment-helper-called-by-a-constant-key',
    'a WITH helper whose object is read by an unknown key': 'e-f01-an-unknown-constant-key-call-of-a-with-helper',
  },
  'S7-U3a-E-R-001-F02': {
    'the predicate written through a member': 'e-f02-a-fragment-written-through-a-member',
    'the predicate handed to an outside function': 'e-f02-a-fragment-handed-to-an-outside-function',
    'the predicate written through a const alias': 'e-f02-a-fragment-written-through-a-const-alias',
    'the predicate handed on after an alias': 'e-f02-a-fragment-handed-on-after-an-alias',
    'the predicate written by the local helper it is handed to': 'e-f02-a-fragment-written-by-a-local-helper',
  },
  'S7-U3a-E-R-001-F03': {
    'the receiving object of a readonly field handed to an outside function': 'e-f03-a-readonly-field-object-handed-to-an-outside-function',
    'the receiving object of a helper handed to an outside function': 'e-f03-a-helper-object-handed-to-an-outside-function',
  },
  'S7-U3a-F-R-001-F01': {
    'a method replaced by a dot next to a readonly field': 'f-f01-a-method-replaced-by-a-dot-next-to-a-readonly-field',
    'a method replaced by a dot next to a helper': 'f-f01-a-method-replaced-by-a-dot',
    'a method replaced by a constant key next to a helper': 'f-f01-a-method-replaced-by-a-constant-key',
    'the predicate handed to a method replaced by a dot': 'f-f01-a-predicate-handed-to-a-method-replaced-by-a-dot',
    'the predicate handed to a method replaced by a constant key': 'f-f01-a-predicate-handed-to-a-method-replaced-by-a-constant-key',
  },
  'S7-U3a-F-R-001-F02': {
    'a raw call of a fragment only': 'f-f02-a-fragment-only-raw-call',
    'fixed SQL of no audit write with a fragment': 'f-f02-a-fixed-non-audit-sql-with-a-fragment',
  },
  'S7-U3a-AUDIT-SPEC-C-R-001-F02 (C-RAW-CAST)': {
    'a fragment asserted to string through a const': 'c-raw-cast-through-a-const',
    'a fragment asserted to string where it is interpolated': 'c-raw-cast-direct',
    'the asserted fragment in fixed SQL of no audit write': 'c-raw-cast-in-fixed-non-audit-sql',
  },
};
const WRITES_AND_RAW = new Set(['auditLog.create', 'raw INSERT INTO "AuditLog"', 'raw SQL naming AuditLog', 'raw call']);

test('checker self-test: every counterexample F03 enumerates leaves its write or raw call unresolved on its own', () => {
  const cases = new Map(violationCases().map(entry => [entry.name, entry])), results = {};
  for (const [finding, variants] of Object.entries(COUNTEREXAMPLES)) {
    for (const [variant, name] of Object.entries(variants)) {
      const entry = cases.get(name);
      assert.ok(entry, `${finding} ${variant}: no case ${name}`);
      assert.equal(entry.failing, 'unresolved', name);
      const scan = scanAuditWrites([...baselineSources(), entry.source]), found = verdict(scan, fixtureTable(entry.table));
      assert.deepEqual(failing(found), ['unresolved'], name);
      const own = scan.candidates.filter(candidate => candidate.file === entry.source.file);
      const writes = own.filter(candidate => WRITES_AND_RAW.has(candidate.kind) && candidate.status !== 'proven_non_audit');
      assert.ok(writes.length > 0 && writes.every(candidate => candidate.status === 'unresolved'), `${name}: ${JSON.stringify(own)}`);
      assert.equal(scan.sites.filter(site => site.file === entry.source.file).length, 0, `${name}: no write of it resolves`);
      results[`${finding} / ${variant}`] = { case: name, unresolved: writes.map(candidate => `${candidate.line} ${candidate.kind}: ${candidate.reason}`),
        beside: own.filter(candidate => !writes.includes(candidate)).map(candidate => `${candidate.line} ${candidate.kind} ${candidate.status}`) };
    }
  }
  console.log('ADMIN_AUDIT_COUNTEREXAMPLES ' + JSON.stringify(results));
});

test('checker self-test: every positive mark reclassified.json replaces is refused by a case of its own, and every entry names its rule', () => {
  const cases = new Map(violationCases().map(entry => [entry.name, entry]));
  const moved = RECLASSIFIED.filter(entry => entry.was.startsWith('resolved'));
  assert.ok(moved.length > 0, 'fix6 positives outside W1-W6 are reclassified');
  for (const entry of moved) {
    const refusal = cases.get(entry.moved_to);
    assert.ok(refusal && refusal.fixture === 'admin-audit-checker', `${entry.fixture}:${entry.line}: no case ${entry.moved_to}`);
    assert.equal(refusal.failing, 'unresolved', entry.moved_to);
    assert.ok(entry.now.some(item => item.status === 'unresolved'), `${entry.fixture}:${entry.line} is refused where it stands too`);
  }
  for (const entry of RECLASSIFIED) assert.ok(entry.rule, `${entry.fixture}:${entry.line} names the rule it applies`);
  console.log('ADMIN_AUDIT_RECLASSIFIED ' + JSON.stringify(RECLASSIFIED.map(entry => `${entry.fixture}:${entry.line} ${entry.was} -> `
    + `${entry.now.map(item => `${item.status} ${item.detail}`).join(' + ')} (${entry.rule}${entry.moved_to ? `; alone in ${entry.moved_to}` : ''})`)));
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
    // Every private or protected method of a class in a file that writes, reached by a constant key where the source has a
    // dot: `x[SYN_METHOD_KEY_n](...)`, the constant declared in the file (Astra S7-U3a-E-R-001-F01: a dot and a fixed key
    // are one reference, for the calls of a helper as for anything else).
    'constant keys for the methods of the writing classes': edits => {
      let n = 0;
      const walk = node => {
        if (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent) && ts.isIdentifier(node.name)
          && ts.getCombinedModifierFlags(node) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
          const key = `SYN_METHOD_KEY_${n++}`;
          for (const at of references(symbolAt(node.name))) {
            const access = at.parent;
            if (!ts.isPropertyAccessExpression(access) || access.name !== at) continue;
            const file = repoPath(at.getSourceFile().fileName);
            declare(edits, file, `const ${key} = '${node.name.text}';`);
            edit(edits, file, access.expression.end, access.end, `${access.questionDotToken ? '?.' : ''}[${key}]`);
          }
        }
        ts.forEachChild(node, walk);
      };
      new Set(base.sites.map(site => site.call.getSourceFile())).forEach(walk);
    },
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
    const lineless = scanned => ({ ...scanned, unresolved: scanned.unresolved.map(entry => entry.replace(/([\w./-]+\.[cm]?[jt]sx?):\d+/g, '$1')) });
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

test('completeness negative controls on api/src: unlisted, dynamic without a wildcard, unwritten actions, an unfixed WITH fragment path, a helper called by a constant key and a fragment written or handed on each fail on their own', () => {
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
  // raw SQL whose action column holds it while another column holds a registered action (S7-U3a-D-R-001-F02). The writer is
  // public so that the raw write's other value, `actor`, is a parameter an outside caller gives as declared (F02); a private
  // helper nothing calls would leave that value, and the write, unresolved before its action is read.
  alone(scanAuditWrites([...sources, { file: 'api/src/syn-unlisted.service.ts', text: [
    "import { Prisma } from '@prisma/client';",
    "export const SYN_UNLISTED_ACTION = 'syn.unlisted';",
    "const LOG = 'auditLog';",
    'export class SynUnlistedService {',
    '  async write(tx: Prisma.TransactionClient, actor: string, uid: string) {',
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
  // where its writes record nothing else, else the first such row of the table. The lines a write spans stay, so no entry
  // the other classes name (an unresolved candidate is named by its line) moves.
  const only = row => base.sites.some(site => site.actions.includes(row)) && base.sites.every(site => !site.actions.includes(row) || `${site.actions}` === row);
  const row = only('reader.assignment') ? 'reader.assignment' : productTable().rows.find(only);
  assert.ok(row, 'a contract row whose writes record nothing else');
  const removed = new Map();
  for (const site of base.sites.filter(site => site.actions.includes(row))) {
    const write = ts.isTaggedTemplateExpression(site.call.parent) ? site.call.parent : site.call;
    edit(removed, site.file, write.getStart(), write.end, 'void 0' + '\n'.repeat(write.getText().split('\n').length - 1));
  }
  alone(scanAuditWrites(edited(sources, removed)), 'unwritten_rows', [row]);
  // (e) A WITH fragment passed once more from a value the program does not fix (Astra S7-U3a-AUDIT-SPEC-B-R-001-F01), and
  // (f) the paths of Astra S7-U3a-E-R-001 on api/src: a helper reached by a constant key as by a dot (F01), a fixed
  // predicate written through a member or handed to a function outside the program before it is passed on (F02). For every
  // raw write whose WITH fragment is a parameter of a method or function, members added next to it pass that parameter a
  // request value (by a dot and, for a method, by a constant key), a fixed predicate first written through a member, and
  // one first handed to a declared outside function; they take the helper's other parameters as it declares them and pass
  // them on (values an outside caller gives, F02), varying only the fragment. For every create whose action is a parameter
  // of a method, an added private method calls it by a constant key with a request value there. Each makes that write
  // unresolved, naming its path. A fragment the added code hands on is a note of its own there (W4 over every fragment),
  // and then the values judged by their type in code connected to it are no longer evidence: such a candidate may become
  // unresolved for that reason and no other. Every other candidate is where it was, as it was; the verdict is the verdict of
  // the writes that stay resolved.
  const { bare, symbolAt } = base.tools;
  const oneWrite = (site, edits, why) => {
    const scan = scanAuditWrites(edited(sources, edits)), found = verdict(scan, productTable(), listing);
    const [from, , text] = [...edits.get(site.file)].sort((a, b) => a[0] - b[0])[0], to = from + text.length;
    const added = entry => entry.file === site.file && entry.start >= from && entry.start < to;
    const notes = scan.candidates.filter(added);
    for (const entry of notes) assert.ok(entry.status === 'unresolved' && entry.kind === 'SQL fragment', `a candidate of the added code: ${JSON.stringify(entry)}`);
    const escapedAt = notes.map(entry => `${entry.file}:${entry.line}`);
    // Candidates by place and kind (a multiset: nested accesses may begin at one offset), matched to the old ones in order.
    const after = new Map();
    for (const entry of scan.candidates.filter(entry => !added(entry))) {
      const key = `${entry.file}@${entry.start} ${entry.kind}`;
      after.set(key, [...(after.get(key) ?? []), entry]);
    }
    let target = null, tainted = 0;
    for (const entry of base.candidates) {
      const key = `${entry.file}@${moved(edits, entry.file, entry.start)} ${entry.kind}`, same = after.get(key) ?? [];
      const at = same.findIndex(other => other.status === entry.status), now = same.splice(at >= 0 ? at : 0, 1)[0];
      if (!same.length) after.delete(key);
      assert.ok(now, `${site.file}:${site.line} (${why}): ${key} is no longer found`);
      if (entry.file === site.file && entry.start === site.start) { target = now; continue; }
      if (now.status === entry.status) continue;
      assert.ok(now.status === 'unresolved' && escapedAt.length && now.reason.includes('so its type is no evidence')
        && escapedAt.some(at => now.reason.includes(at)), `${key}: ${entry.status} -> ${now.status}: ${now.reason}`);
      tainted++;
    }
    assert.deepEqual([...after.keys()], [], 'candidates that are neither old nor of the added code');
    assert.ok(target.status === 'unresolved' && target.reason.includes(why), `${site.file}:${site.line}: ${target.reason}`);
    const kept = new Set(scan.sites.map(other => `${other.file}@${other.start}`));
    const rest = verdict({ ...base, sites: base.sites.filter(other => kept.has(`${other.file}@${moved(edits, other.file, other.start)}`)),
      unresolved: scan.unresolved }, productTable(), listing);
    assert.deepEqual(found, rest);
    return { write: `${site.file}:${site.line}`, reason: target.reason, fragment_notes: escapedAt, taken_at_their_type_no_longer: tainted };
  };
  /** Edits adding `members` to the class of the method `owner` (or functions after the function `owner`) — private, or
   *  public (exported) when `open` — and `tail` at the end of its file. */
  const adding = (site, owner, members, tail = '', open = false) => {
    const edits = new Map(), method = ts.isMethodDeclaration(owner), at = method ? owner.parent.end - 1 : owner.end;
    edit(edits, site.file, at, at, `\n${members.map(member => (method ? `  ${open ? '' : 'private '}${member}` : `${open ? 'export ' : ''}function ${member}`)).join('\n')}\n`);
    const end = owner.getSourceFile().text.length;
    if (tail) edit(edits, site.file, end, end, tail);
    return edits;
  };
  const paths = [];
  const passedIn = base.sites.flatMap(site => site.fragments.map(fragment => ({ site, declaration: symbolAt(bare(fragment))?.declarations?.[0] })))
    .filter(({ declaration }) => declaration && ts.isParameter(declaration) && (ts.isMethodDeclaration(declaration.parent)
      || ts.isFunctionDeclaration(declaration.parent)));
  assert.ok(passedIn.length > 0, 'api/src has a raw write whose WITH fragment is a parameter');
  const predicate = "SynPrisma.sql`s.uid = ${String(body.uid)}::text`";
  const outside = "\nimport { Prisma as SynPrisma } from '@prisma/client';\ndeclare function synOpaque(value: unknown): void;\n";
  for (const { site, declaration } of passedIn) {
    const owner = declaration.parent, method = ts.isMethodDeclaration(owner), name = owner.name.getText();
    const prefix = method && ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Static ? 'static ' : '';
    const params = [...owner.parameters.filter(parameter => parameter !== declaration).map(parameter => parameter.getText()), 'body: any'].join(', ');
    const call = (value, callee = method ? `this.${name}` : name) =>
      `${callee}(${owner.parameters.map(parameter => (parameter === declaration ? value : parameter.name.getText())).join(', ')})`;
    paths.push([site, adding(site, owner, [`${prefix}synUnfixedPath(${params}) { return ${call('body.where')}; }`], '', true), '`body.where` is not a Prisma.sql text']);
    if (method) {
      paths.push([site, adding(site, owner, [`${prefix}synKeyPath(${params}) { const SYN_KEY = '${name}'; return ${call('body.where', 'this[SYN_KEY]')}; }`], '', true),
        '`body.where` is not a Prisma.sql text']);
    }
    paths.push([site, adding(site, owner, [`${prefix}synWrittenPath(${params}) { const selector = ${predicate}; (selector as any).strings[0] = String(body.sql); return ${call('selector')}; }`], outside, true),
      'holds an SQL fragment that is written at']);
    paths.push([site, adding(site, owner, [`${prefix}synHandedPath(${params}) { const selector = ${predicate}; synOpaque(selector); return ${call('selector')}; }`], outside, true),
      'holds an SQL fragment that is handed to `synOpaque`']);
  }
  const helped = base.sites.filter(site => site.via === 'auditLog.create').map(site => {
    const node = site.action.node ? bare(site.action.node) : site.action.shorthand?.name;
    const declaration = node && ts.isIdentifier(node) ? symbolAt(node)?.declarations?.[0] : null;
    return declaration && ts.isParameter(declaration) && ts.isMethodDeclaration(declaration.parent) ? { site, declaration } : null;
  }).filter(Boolean);
  assert.ok(helped.length > 0, 'api/src has a create whose action is a parameter of a method');
  for (const { site, declaration } of helped) {
    const owner = declaration.parent, name = owner.name.getText();
    const prefix = ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Static ? 'static ' : '';
    const args = owner.parameters.map((parameter, n) => (parameter === declaration ? 'body.action' : `body.p${n}`)).join(', ');
    paths.push([site, adding(site, owner, [`${prefix}synKeyCall(body: any) { const SYN_KEY = '${name}'; return this[SYN_KEY](${args}); }`]),
      '`body.action` is a property the program does not fix']);
  }
  const reasons = paths.map(([site, edits, why]) => oneWrite(site, edits, why));
  console.log('ADMIN_AUDIT_NEGATIVE_CONTROLS ' + JSON.stringify({ revalued_literals: origins.length, unlisted_after_revalue: changed.unlisted.length,
    unwritten_row: row, writes_taken_out: [...removed.values()].flat().length,
    unfixed_fragment_paths: passedIn.map(({ site, declaration }) => `${site.file}:${site.line} \`${declaration.name.getText()}\``),
    helpers_by_a_constant_key: helped.map(({ site, declaration }) => `${site.file}:${site.line} \`${declaration.parent.name.getText()}\``),
    one_write_paths: reasons }));
});

test('raw provenance: fixed alternatives are classified after composition, including newly exposed audit writes', () => {
  const source = asSource('raw-composition.ts', String.raw`
import { Prisma } from '@prisma/client';
const table = Prisma.sql\`"AuditLog"\`;
function predicate(uid: string) { return Prisma.sql\`uid = \${uid}\`; }
export function run(tx: Prisma.TransactionClient, uid: string, choice: boolean, ids: string[]) {
  const optional = choice ? Prisma.sql\` FOR SHARE\` : Prisma.empty;
  const columns = [Prisma.sql\`uid\`, choice ? Prisma.sql\`ward\` : Prisma.sql\`rs\`];
  tx.$queryRaw(Prisma.sql\`SELECT \${Prisma.join(columns)} FROM "StudyState" WHERE \${predicate(uid)}\${optional}\`);
  tx.$queryRaw\`SELECT uid FROM "StudyState" WHERE uid IN (\${Prisma.join(ids)})\`;
  tx.$queryRaw\`SELECT uid FROM "StudyState" WHERE uid IN (\${Prisma.join(ids.map(id => Prisma.sql\`\${id}::text\`))})\`;
  tx.$executeRaw\`UPDATE "StudyState" SET ward=\${uid} WHERE \${predicate(uid)}\`;
  tx.$executeRaw\`INSERT INTO \${table} (action) VALUES ('syn.allowed')\`;
  const statement = choice ? Prisma.sql\`SELECT 1\` : Prisma.sql\`INSERT INTO "AuditLog" (action) VALUES ('syn.new-action')\`;
  tx.$executeRaw(statement);
}
`.replace(/\\([`$])/g, '$1'));
  const scan = scanAuditWrites([source]);
  assert.deepEqual(scan.unresolved, []);
  assert.equal(scan.candidates.filter(entry => entry.status === 'proven_non_audit' && WRITES_AND_RAW.has(entry.kind)).length, 4);
  assert.deepEqual(scan.sites.map(site => site.actions), [['syn.allowed'], ['syn.new-action']]);
  const table = { rows: ['syn.allowed'], wildcards: [], listed: action => action === 'syn.allowed' };
  assert.deepEqual(failing(verdict(scan, table)), ['unlisted']);
  assert.deepEqual(verdict(scan, table).unlisted, ['syn.new-action']);
});

test('raw provenance: every unenumerable input fails closed on its own', async t => {
  const cases = {
    'nonliteral SQL': 'tx.$executeRawUnsafe(body.sql);',
    'nonliteral raw': 'tx.$queryRaw(Prisma.sql`SELECT ${Prisma.raw(body.sql)}`);',
    'concatenation': 'tx.$executeRawUnsafe("SELECT " + body.sql);',
    'unknown spread': 'tx.$queryRaw`SELECT ${Prisma.join([...body.parts])}`;',
    'unknown array behind an annotation': 'const ids: string[] = body.ids; tx.$queryRaw`SELECT ${Prisma.join(ids)}`;',
    'unknown conditional': 'const part = choice ? Prisma.sql`SELECT 1` : body.sql; tx.$queryRaw(part);',
    'array mutation': 'const parts = [Prisma.sql`SELECT 1`]; parts.push(body.sql); tx.$queryRaw`${Prisma.join(parts)}`;',
    'array alias mutation': 'const rows: any[] = []; const alias = rows; alias.push(body.row); const ids: string[] = rows.map(row => row.uid); tx.$queryRaw`SELECT ${Prisma.join(ids)}`;',
    'opaque array consumer': 'const rows: any[] = []; opaque(rows); const ids: string[] = rows.map(row => row.uid); tx.$queryRaw`SELECT ${Prisma.join(ids)}`;',
    'cross-module helper': 'tx.$queryRaw`SELECT ${fragment()}`;',
    'fragment mutation': 'const part = Prisma.sql`SELECT 1`; (part as any).strings[0] = body.sql; tx.$queryRaw(part);',
    'text seam': 'tx.$executeRaw`${Prisma.raw("INSERT INTO \\\"Au")}${Prisma.raw("ditLog\\\" (action) VALUES (\\\'syn.new-action\\\')")}`;',
  };
  for (const [name, body] of Object.entries(cases)) await t.test(name, () => {
    const source = asSource('raw-unknown.ts', `import { Prisma } from '@prisma/client';
import { fragment } from './foreign-fragment';
declare function opaque(value: unknown): void;
export function run(tx: Prisma.TransactionClient, body: any, choice: boolean) { ${body} }`);
    const foreign = asSource('foreign-fragment.ts', 'import { Prisma } from "@prisma/client"; export function fragment() { return Prisma.sql`1`; }');
    const scan = scanAuditWrites([source, foreign]);
    const found = verdict(scan, { rows: [], wildcards: [], listed: () => false });
    assert.ok(failing(found).length > 0, name);
    if (name === 'text seam') {
      assert.deepEqual(failing(found), ['unlisted']);
      assert.deepEqual(found.unlisted, ['syn.new-action']);
    }
    else assert.ok(found.unresolved.length > 0, `${name}: ${JSON.stringify(scan.candidates)}`);
  });
});

// REQ-S7-RAW-PROVENANCE -> RISK-S7-RAW-HIDDEN-WRITE -> TEST-S7-RAW-BINDINGS.
// These are behavioural counterexamples: every raw call must refuse an unaccounted-for value,
// even when another candidate (for example W4) would independently make the verdict fail.
test('raw provenance: substitution accounts for writes to every binding kind', async t => {
  const seam = 'Prisma.sql`${Prisma.sql`DELETE FROM "Audit`}${Prisma.sql`Log"`}`';
  const cases = [
    ['review B1 parameter assignment', 'function h(p: Prisma.Sql, q: Prisma.Sql) { p = q; return p; }',
      `tx.$executeRaw(h(Prisma.sql\`SELECT 1\`, ${seam}));`, 'p'],
    ['review B2 parameter hides insert', 'function h(p: Prisma.Sql, q: Prisma.Sql) { p = q; return p; }',
      'tx.$executeRaw(h(Prisma.sql`SELECT 1`, Prisma.sql`INSERT INTO "Audit${Prisma.sql`Log" (action) VALUES (\'syn.hidden\')`}`));', 'p'],
    ['review B4 conditional assignment', 'function h(p: Prisma.Sql, q: Prisma.Sql, flag: boolean) { if (flag) p = q; return p; }',
      `tx.$executeRaw\`\${h(Prisma.sql\`SELECT 1\`, ${seam}, choice)}\`;`, 'p'],
    ['review B5 interpolation assignment', 'function h(p: Prisma.Sql, q: Prisma.Sql) { p = q; return Prisma.sql`${p}`; }',
      `tx.$executeRaw(h(Prisma.sql\`SELECT 1\`, ${seam}));`, 'p'],
    ['helper closure writes parameter', 'function h(p: Prisma.Sql, q: Prisma.Sql) { const change = () => { p = q; }; change(); return p; }',
      `tx.$executeRaw(h(Prisma.sql\`SELECT 1\`, ${seam}));`, 'p'],
    ['arguments index write', 'function h(p: Prisma.Sql, q: Prisma.Sql) { arguments[0] = q; return p; }',
      `tx.$executeRaw(h(Prisma.sql\`SELECT 1\`, ${seam}));`, 'p'],
    ['arguments captured by arrow', 'function h(p: Prisma.Sql, q: Prisma.Sql) { (() => { arguments[0] = q; })(); return p; }',
      `tx.$executeRaw(h(Prisma.sql\`SELECT 1\`, ${seam}));`, 'p'],
    ['dependent default', 'function h(p: Prisma.Sql, q: Prisma.Sql = p) { return q; }',
      `tx.$executeRaw(h(${seam}));`, 'q'],
    ['dependent default primitive binding', 'function h(p: string, q = p) { return Prisma.sql`${q}`; }',
      'tx.$queryRaw(h("ok"));', 'q'],
    ['explicit undefined selects default', `function h(p: Prisma.Sql = ${seam}) { return p; }`,
      'tx.$executeRaw(h(undefined));', 'p'],
    ['const object property', '', 'const box = { id: "ok" }; box.id = body.sql; tx.$queryRaw`SELECT ${box.id}`;', 'box'],
    ['const object index', '', 'const box = { id: "ok" }; box["id"] = body.sql; tx.$queryRaw`SELECT ${box.id}`;', 'box'],
    ['Object.assign', '', 'const box = { id: "ok" }; Object.assign(box, { id: body.sql }); tx.$queryRaw`SELECT ${box.id}`;', 'box'],
    ['spread written back', '', 'let box = { id: "ok" }; box = { ...box, id: body.sql }; tx.$queryRaw`SELECT ${box.id}`;', 'box'],
    ['object alias', '', 'const box = { id: "ok" }; const alias = box; alias.id = body.sql; tx.$queryRaw`SELECT ${box.id}`;', 'alias'],
    ['object passed to helper', 'function change(p: any, value: any) { p.id = value; }',
      'const box = { id: "ok" }; change(box, body.sql); tx.$queryRaw`SELECT ${box.id}`;', 'p'],
    ['object getter', '', 'const box = { get id() { return body.sql; } }; tx.$queryRaw`SELECT ${box.id}`;', 'box'],
    ['array push', '', 'const ids: string[] = ["ok"]; ids.push(body.sql); tx.$queryRaw`SELECT ${Prisma.join(ids)}`;', 'ids'],
    ['array index assignment', '', 'const ids: string[] = ["ok"]; ids[0] = body.sql; tx.$queryRaw`SELECT ${Prisma.join(ids)}`;', 'ids'],
    ['array Object.assign', '', 'const ids: string[] = ["ok"]; Object.assign(ids, { 0: body.sql }); tx.$queryRaw`SELECT ${Prisma.join(ids)}`;', 'ids'],
    ['array callback writes array', '', 'const ids: string[] = ["ok"]; ids.map((id, index, all) => { all[0] = body.sql; return id; }); tx.$queryRaw`SELECT ${Prisma.join(ids)}`;', 'all'],
    ['array callback writes element', '', 'const rows = [{id:"ok"}]; rows.map(row => { row.id = body.sql; }); tx.$queryRaw`SELECT ${Prisma.join(rows.map(row => row.id))}`;', 'row'],
    ['let assignment', '', 'let p: any = "ok"; p = body.sql; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['var assignment', '', 'var p: any = "ok"; p = body.sql; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['loop assignment', '', 'let p: any = "ok"; for (const ignored of rows) p = body.sql; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['loop target', '', 'let p: any = "ok"; for (p of rows) {} tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['loop destructured target', '', 'let p: any = "ok"; for ([p] of rows) {} tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['compound assignment', '', 'let p: any = "ok"; p ||= body.sql; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['increment', '', 'let p: any = 1; p++; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['destructuring assignment', '', 'let p: any = "ok"; ({id:p} = body); tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['destructuring default assignment', '', 'let p: any = "ok"; [p = "safe"] = rows; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['destructured binding reassignment', '', 'let {id:p} = {id:"ok"}; p = body.sql; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['destructured binding from changed object', '', 'const box = {id:"ok"}; box.id = body.sql; const {id:p} = box; tx.$queryRaw`SELECT ${p}`;', 'box'],
    ['destructured result reassignment', '', 'let {id:p} = JSON.parse("{}"); p = body.sql; tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['captured outer binding', '', 'let p: any = "ok"; const change = () => { p = body.sql; }; change(); tx.$queryRaw`SELECT ${p}`;', 'p'],
    ['captured outer object', '', 'const box = {id:"ok"}; const change = () => { box.id = body.sql; }; change(); tx.$queryRaw`SELECT ${box.id}`;', 'box'],
    ['helper replaced', 'function h() { return Prisma.sql`SELECT 1`; }', `h = () => ${seam}; tx.$executeRaw(h());`, 'h'],
    ['projected helper parameter replaced', 'function h(p: any[], q: any[]) { p = q; return p; }',
      'const ids: string[] = h(["ok"], body.parts).map(id => id); tx.$queryRaw`SELECT ${Prisma.join(ids)}`;', 'p'],
    ['review C1 callback record annotation', '', 'tx.$queryRaw`SELECT ${Prisma.join(rows.map((r: {id:string}) => Prisma.sql`${r.id}::uuid`))}`;', 'r'],
    ['review C2 callback primitive annotation', '', 'tx.$queryRaw`SELECT ${Prisma.join(rows.map((id: string) => Prisma.sql`${id}::uuid`))}`;', 'id'],
    ['callback annotation narrows a record field', 'declare const records: { id: unknown }[];',
      'tx.$queryRaw`SELECT ${Prisma.join(records.map((row: {id:string}) => Prisma.sql`${row.id}::uuid`))}`;', 'row'],
    ['callback annotation narrows a record union', 'declare const records: ({ id: string } | {id:unknown})[];',
      'tx.$queryRaw`SELECT ${Prisma.join(records.map((row: {id:string}) => Prisma.sql`${row.id}::uuid`))}`;', 'row'],
  ];
  for (const [name, pre, body, binding] of cases) await t.test(name, () => {
    const source = asSource('raw-binding.ts', `import { Prisma } from '@prisma/client';\n${pre}\nexport function run(tx: Prisma.TransactionClient, body: any, rows: any[], choice: boolean) { ${body} }`);
    const scan = scanAuditWrites([source]);
    const raw = scan.candidates.filter(entry => entry.kind.startsWith('raw '));
    assert.ok(raw.length && raw.every(entry => entry.status === 'unresolved'), JSON.stringify(raw));
    assert.ok(raw.some(entry => entry.reason.includes(binding)), `${binding}: ${JSON.stringify(raw)}`);
    assert.ok(verdict(scan, { rows: [], wildcards: [], listed: () => false }).unresolved.length);
  });
});

test('raw provenance: stable bindings, shadowing and accounted-for pushes keep their meaning', () => {
  const source = asSource('raw-stable.ts', `import { Prisma } from '@prisma/client';
function h(p: Prisma.Sql) { return p; }
export function run(tx: Prisma.TransactionClient, ids: string[], choice: boolean) {
  const primitive = 'ok';
  const box = {id: primitive}; const {id} = box;
  let scalar = id; scalar = choice ? 'other' : 'ok';
  const values = [primitive]; const alias = values; alias.push('next'); values.push(...ids);
  tx.$queryRaw\`SELECT \${scalar}, \${box.id} WHERE id IN (\${Prisma.join(values)})\`;
  tx.$queryRaw(h(Prisma.sql\`SELECT 1\`));
  tx.$queryRaw\`SELECT \${Prisma.join(ids.map((value: string) => Prisma.sql\`\${value}::uuid\`))}\`;
  { function h() { return Prisma.sql\`INSERT INTO "AuditLog" (action) VALUES ('syn.shadowed')\`; } tx.$executeRaw(h()); }
}`);
  const scan = scanAuditWrites([source]), found = verdict(scan, {rows:[], wildcards:[], listed: () => false});
  assert.deepEqual(scan.unresolved, []);
  assert.deepEqual(found.unlisted, ['syn.shadowed']);
  assert.equal(scan.candidates.filter(entry => entry.kind.startsWith('raw ') && entry.status === 'proven_non_audit').length, 3);
});

test('raw provenance: every proven SQL text is lexed regardless of table spelling', async t => {
  const statements = [
    'DELETE FROM U&"Audit\\004Cog"',
    'EXECUTE \'DELETE FROM "Au\' || \'ditLog"\'',
    'DO $$ BEGIN DELETE FROM "AuditLog"; END $$',
    'SELECT E\'unmodelled\\escape\'',
    'SELECT \'unmodelled\\escape\'',
    'UPDATE public."AuditLog" SET actor = \'x\'',
    'DELETE FROM AUDITLOG',
    'DELETE FROM "auditlog"',
    'MERGE INTO "AuditLog" USING source ON TRUE WHEN MATCHED THEN DELETE',
    'COPY public."AuditLog" FROM STDIN',
    'TRUNCATE TABLE "AuditLog"',
    'WITH changed AS (DELETE FROM "AuditLog" RETURNING *) SELECT * FROM changed',
    'INSERT INTO "AuditLog" (action) SELECT \'syn.lexed\' FROM source',
  ];
  for (const statement of statements) for (const composed of [false, true]) await t.test(`${composed ? 'fragment' : 'direct'} ${statement}`, () => {
    // JSON quoting preserves SQL escapes in TypeScript text; these are actual raw texts, not parser-shape checks.
    const expression = composed ? `Prisma.raw(${JSON.stringify(statement)})` : JSON.stringify(statement);
    const source = asSource('raw-lexing.ts', `import { Prisma } from '@prisma/client'; export function run(tx: Prisma.TransactionClient) { tx.$executeRawUnsafe(${expression}); }`);
    const scan = scanAuditWrites([source]), found = verdict(scan, { rows: [], wildcards: [], listed: () => false });
    assert.ok(found.unresolved.length || found.unlisted.includes('syn.lexed'), JSON.stringify(scan.candidates));
  });
});

test('raw provenance r3: reviewer counterexamples and neighbouring unknown writes', async t => {
  const seam = 'Prisma.sql`${Prisma.sql`DELETE FROM "Audit`}${Prisma.sql`Log"`}`';
  const call = `const evil = ${seam}; await tx.$executeRaw(h(Prisma.sql\`SELECT 1\`, evil));`;
  const cases = [
    ['N06 second declaration', 'function h(p: Prisma.Sql, q: Prisma.Sql) { var p = q; return p; }', call],
    ['N06b second declaration inside block', 'function h(p: Prisma.Sql, q: Prisma.Sql) { if (q) { var p = q; } return p; }', call],
    ['N06d second declaration in template', 'function h(p: Prisma.Sql, q: Prisma.Sql) { var p = q; return Prisma.sql`${p}`; }', call],
    ['N07 direct eval', "function h(p: Prisma.Sql, q: Prisma.Sql) { eval('p = q'); return p; }", call],
    ['N07 parenthesised direct eval', "function h(p: Prisma.Sql, q: Prisma.Sql) { (eval)('p = q'); return p; }", call],
    ['N08 module eval', 'function h() { return Prisma.sql`SELECT 1`; } export function admin(s: string) { eval(s); }', 'await tx.$executeRaw(h());'],
    // LIMIT L1 (namespace laundered into any): ['N69 asserted return through any', 'function v(): string { const P: any = Prisma; return P.raw(\'DELETE FROM "Au\' + \'ditLog"\'); }', 'await tx.$executeRaw`${v()}`;'],
    ['N90 executable SQL string body', '', 'await tx.$executeRaw`CREATE OR REPLACE FUNCTION pg_temp.f() RETURNS void LANGUAGE sql AS \'DELETE FROM "AuditLog"\'`; await tx.$queryRaw`SELECT pg_temp.f()`;'],
    ['V09 action through eval', '', 'let action = "syn.ok"; eval(body.code); await tx.$executeRaw`INSERT INTO "AuditLog" (actor, action, target) VALUES (\'a\', ${action}, \'t\')`;'],
    ['assignment target is not a read', '', 'let action = "syn.ok"; action = body.action; await tx.$executeRaw`INSERT INTO "AuditLog" (action) VALUES (${action})`;'],
    ['F02f asserted array element', '', 'const rows: any[] = body.rows; for (const id of rows as string[]) await tx.$queryRaw`SELECT 1 WHERE id = ${id}`;'],
    ['with scope', 'function h(p: Prisma.Sql, q: Prisma.Sql) { with (q) {} return p; }', call],
    // DROPPED (Function() cannot write a local binding): ['dynamic Function scope', 'function h(p: Prisma.Sql, q: Prisma.Sql) { Function(String(q))(); return p; }', call],
    // LIMIT L3 (does not compile, TS2304; CI build refuses it): ['unattributed reference', 'function h(p: Prisma.Sql, q: Prisma.Sql) { return p; } function broken() { p; }', call],
    ['postfix is not a read', 'function h(p: any, q: Prisma.Sql) { p++; return p; }', call],
    ['angle assertion array', '', 'const rows: any[] = body.rows; for (const id of <string[]>rows) await tx.$queryRaw`SELECT ${id}`;'],
    // LIMIT L2 (ambient any from outside the program): ['non-null any return', 'function v(): string { return bodyValue!; } declare const bodyValue: any;', 'await tx.$queryRaw`SELECT ${v()}`;'],
    ...['PROCEDURE', 'TRIGGER', 'RULE'].map(kind => [`CREATE ${kind} body`, '', `await tx.$executeRawUnsafe(${JSON.stringify(`CREATE ${kind} f AS 'DELETE FROM "AuditLog"'`)});`]),
  ];
  for (const [name, pre, body] of cases) await t.test(name, () => {
    const source = asSource('raw-review-r3.ts', `import { Prisma } from '@prisma/client';\n${pre}\nexport async function run(tx: Prisma.TransactionClient, body: any) { ${body} }`);
    const scan = scanAuditWrites([source]), found = verdict(scan, { rows: [], wildcards: [], listed: a => a === 'syn.ok' });
    assert.ok(found.unresolved.length, JSON.stringify(scan.candidates));
    assert.ok(scan.candidates.some(entry => entry.kind.startsWith('raw ') && entry.status === 'unresolved'), JSON.stringify(scan.candidates));
  });
  await t.test('N28b namespace overwrite is outside the honest-mistake contract', () => {
    // Deliberate mutation of the imported Prisma namespace remains outside this tool's purpose.
    // Keep the reviewer's exact counterexample visible without claiming that it is detected.
    const source = asSource('raw-namespace-r3.ts', `import { Prisma } from '@prisma/client';
export function configure(s: string) { Object.assign(Prisma, JSON.parse(s)); }
export async function run(tx: Prisma.TransactionClient, choice: boolean) {
  await tx.$executeRaw(choice ? Prisma.sql\`SELECT 1\` : Prisma.empty);
}`);
    const scan = scanAuditWrites([source]);
    assert.deepEqual(scan.candidates.filter(entry => entry.kind === 'raw call').map(entry => entry.status), ['proven_non_audit']);
  });
});

test('raw provenance r3: proved reads retain fixed SQL without type annotations as evidence', async t => {
  const helpers = [
    'function h(p: Prisma.Sql) { return p; }',
    // DROPPED (fix-2 relaxation of arguments.length, no product need)
    'function h(p: Prisma.Sql) { const copy = p; return copy; }',
    'function h(p: Prisma.Sql) { Function("return 1")(); return p; }',
  ];
  for (const helper of helpers) await t.test(helper, () => {
    const source = asSource('raw-read-control-r3.ts', `import { Prisma } from '@prisma/client';
${helper}
export function run(tx: Prisma.TransactionClient) { tx.$queryRaw(h(Prisma.sql\`SELECT 1\`)); }`);
    const scan = scanAuditWrites([source]);
    assert.deepEqual(scan.unresolved, []);
    assert.deepEqual(scan.candidates.filter(entry => entry.kind === 'raw call').map(entry => entry.status), ['proven_non_audit']);
  });
});
