# S7-U3a SPEC-D: temporary non-write dispositions

Ruling: S7-U3a-AUDIT-SPEC-D-R-001, option (c).
Owner: Fable commander; product implementation: assigned product worker.
Follow-up unit required by this ruling: S7-U3a-RAW-PROVENANCE.
This is a checker-spec closure with explicit debt, not a release approval.

## Rule and inventory

W1-W6, F02 interpolation provenance, G1/G2 and candidate discovery do not change.
All 32 baseline writers remain statically resolved; no writer is exempted.
The explicit checker input is tests/admin-audit-nonwrite-deferrals.json.
It is policy, not a fixture or a list inferred from current failures.
Its entries are [file, one-based line, UTF-16 start in LF text, candidate kind].

D-NW temporarily disposes exactly those 27 baseline raw candidates as
deferred_non_audit. It does not prove them safe or change their raw unresolved
status. Raw reasons/rules, all candidates and writers remain in the inventory.
The gate uses the remaining unresolved candidates plus any policy-input error.
Every disposition is separately logged with its position, reason, owner and ruling.

The policy pins the entire api/src source set and LF text, TypeScript version,
tsconfig, package lock, Prisma schema and complete unresolved diagnostic inventory.
The baseline SHA records provenance; it is not compared to the later test-only HEAD.
Missing, duplicate, stale or ambiguous pins, changed sources/dependencies/diagnoses
and missing inputs fail closed, atomically. New candidates are never auto-added.
Even an unrelated api/src edit invalidates this policy. This deliberate temporary
cost prevents changed helpers, callers or imports from inheriting a location waiver.
Never regenerate these hashes merely to make a gate green.

The 27-entry map is the explicit policy:
- 18 with fragments: admin:364, clinical-context:224, favorite:25,
  finding:151/195/205/224/270/280/324/382, pacs:1158/3251/3347,
  study-tags:23, viewer-job:41, viewer:139/152.
- 9 with request-derived any values: critical-result:369/595/612,
  image-request:234/299/303, study-access:135/140/141.
The fragment group ALSO has unresolved callback take at admin:364 and returned
object properties at finding:205/224 and viewer:139/152. These reasons are retained.
Study-access:140/141 write non-audit tables; "non-audit" does not mean "read-only".
Existing writer rule maps remain W1-W6; D-NW is a disposition rule for these entries.

## Bypass and closure

Option (b) is rejected: fixed non-audit text can interpolate SQL that writes
AuditLog. It reopens F-F02 and C-RAW-CAST-in-fixed-non-audit-sql.
A cast is not a value conversion. Option (a) would require additional bounded
provenance rules for callbacks and returned objects as well as fragments/any;
the 18/9 grouping alone is not a complete minimal extension.

SPEC-C F01's no-file-exceptions acceptance condition and F03(a)'s
no-position-exceptions / zero-raw-unresolved condition are amended ONLY for this
reviewed D-NW input. There must be zero BLOCKING unresolved
candidates; the raw inventory must still disclose all 27 unresolved dispositions.
No other production unresolved input passes. F03(c) means an unsupported synthetic
case passes its checker self-test by being rejected, not that a product gate passes.

The E/F/C-RAW-CAST scanner assertions are unchanged. Each counterexample still
fails alone on its own unresolved raw/write candidate, and the policy adapter is
also checked against every listed counterexample. Source/diagnosis binding rejects
a change even at an exempted location. No rawCall provenance-bypass path is added.
The supported-notation multiset and all existing attribution/negative controls stay.

## Product follow-up and retirement

S7-U3a-RAW-PROVENANCE owns all 27 positions and their preserved F02 reasons.
Review runtime-validated scalar DTOs, immutable fragment construction and callback
contracts as a product unit, with unchanged SQL semantics, authorization, data
preservation and real-service behavior. Do not change product code solely to please
this checker. Review any additional bounded proof rule separately. Before changing
the pinned corpus, obtain a new independent disposition or remove this temporary
policy through that review; the apply-only worker must not repin or broaden it.
Retire the input and adapter when all entries have proof and no exception remains.

After the verbatim patch, the next gate requires: 32 baseline writers resolved;
exactly these 27 visibly deferred under valid D-NW; every E/F/C-RAW-CAST variant
unresolved and failing alone; completeness green with no other failure class;
supported writer site/action/prefix multisets preserved; no deleted/skipped tests.
Record checks at the applied HEAD with before/after SHA, commands, exits, raw logs,
all api/src inputs, this module/policy, both fixture directories and compiler inputs.
Include generated-client present/absent and compiler-missing refusal evidence.
Keep the existing compiled-service and ordinary CI/merge requirements separate;
historical 263719d evidence is not evidence that the applied HEAD passed them.

## SPEC-F and SPEC-G reviewed transitions (schema 3)

SPEC-F (S7-U3a-AUDIT-SPEC-F-R-001) is unchanged for files with no deferred
site. Its predecessor entries, diagnostics and all deferral-bearing files
must be identical. U5 remains under SPEC-F when it changes only such files
(e.g. admin-audit.ts, not admin.service.ts). Use the latest approved base;
U1c and U5 policy updates are serialized.

SPEC-G (S7-U1c-SPEC-G-B-R-001, option A) additionally permits the reviewed
U1c transition of critical-result.service.ts. No other deferral-bearing
file is permitted. It is temporary D-NW, not a W1-W6 proof or product approval.
Apply this checker patch INSIDE U1c after SPEC-F merges, not as a separate
product candidate. The supplied policy stays in SPEC-F mode until U1c's
actual source and proof inputs exist; do not invent future hashes.

For U1c, take baseline_source_sha and repin.source_sha from the approved
implementation base B. Set repin.ruling to S7-U1c-SPEC-G-B-R-001.
Copy B's entries into repin.entries and hash that array into
repin.entries_sha256; copy B's unresolved/corpus/compiler/context pins
into repin. Carry the LF Git text of EVERY changed api/src file in
repin.before. The same compiler rescans the reconstructed entire B corpus.
Set current sources_sha256, unresolved_sha256 and entries from candidate S.
Current positions are locators only: the three calls must correspond
one-to-one by file/kind/rule/exact reason and TypeScript AST scope/branch/
binding/tag shape. Duplicate anchors, changed diagnoses, added/removed
unresolved calls, another deferred file or incomplete reconstruction fail
atomically. The other 24 entries keep their exact positions and reasons.

repin.site_proofs has exactly three records, keyed by deferralIdentity's
identity hash. Each records before_call_sha256 and after_call_sha256
(SHA256 of the UTF-8 LF call text), nonempty sql, values, dependencies
narratives, and evidence: [{ref, sha256}]. All three need a bounded
RAW-PROVENANCE-style review, including the moved-only call: changing its
helpers or callers can change provenance without changing the call text.
The checker verifies correspondence, diagnoses and proof bindings only.
A nonempty narrative, matching diagnostic or evidence hash format is
NOT proof, and never grants review approval.

At candidate review, independently open each evidence file from the
manifest, verify its digest and candidate/input binding, and establish:
the actual SQL operation/table set and absence of an audit write; every
unproven interpolation's complete expression, origins, runtime validation,
assignments and helper/caller paths; no fragment/cast escape or added
unresolved path; and the authorized tele/read/count behavior. Cover all
changed dependencies, not just the printed (possibly truncated) reason.
Missing or inconclusive proof prevents ACCEPT; never infer scalar safety
from an any type, cast, SELECT prefix or unchanged diagnostic. If a call
gains scanner proof, or these conditions cannot hold, obtain a separate
disposition/RAW-PROVENANCE resolution; do not relabel or silently drop it.
Evidence contains synthetic data and code references only.

Keep the raw scan, all 32 writers, 27 diagnoses and 27 visible dispositions.
Run every original E/F/C-RAW-CAST and SPEC-F control plus SPEC-G controls;
no skips, assertion deletion or product restructuring for this checker.
Record exact candidate SHA, whole inputs, command, exit and raw output,
including compiler-missing and generated-client present/absent conditions.
The U1c service/authorization/preservation tests, PR CI, G3 and independent
candidate review remain mandatory. RAW-PROVENANCE stays open before S7 exit.
