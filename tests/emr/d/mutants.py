# coding: utf-8
"""TEST-D mutants (EMR-D round 1, fix round 2): the pure mutants M-D-01..05 and M-D-R1-01a..06 of api/src/emr-clinical.

REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01..04 (tests/emr/d/contract_test.cjs).

Each mutant breaks one protection of the product in a COPY of api/src/emr-clinical (with api/src/emr-contract copied
beside it unchanged) and runs the contract test against that copy through KIN_EMR_D_SRC. A mutant counts as killed only
when ALL of these hold:
  * the unmutated copy first passes the full declared selection, including each mutant's named case;
  * the anchor occurs exactly once in its file (a missing or repeated anchor is a failure, not a survivor);
  * the child exits non-zero, the named case is reported `not ok` in the TAP stream with failureType testCodeFailure
    and code ERR_ASSERTION, and that mutant's own expect text is inside that case's failure block;
  * no crash marker (syntax/reference/module errors) appears: an import or process failure is never a kill.

M-D-06 (the delayed-response sequence check) lives in page code that round 2 owns; it is reported "not_run" with that
reason, never as a kill. The source tree is never modified. Source and mutated file hashes go into the summary.

stdlib only. Usage: python -B tests/emr/d/mutants.py [--anchors-only] [--out PATH]; node comes from KIN_NODE or PATH.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[3]
D_DIR = ROOT / "api" / "src" / "emr-clinical"
A_DIR = ROOT / "api" / "src" / "emr-contract"
TEST = ROOT / "tests" / "emr" / "d" / "contract_test.cjs"
CRASH_MARKERS = ("SyntaxError:", "ReferenceError:", "Cannot find module", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE")

MUTANTS = [
    {
        "id": "M-D-01",
        "title": "a clinical entry is classified as an assignment (no signature is requested)",
        "file": "contract.ts",
        "old": "  return path.capacity === C ? 'clinical-entry' : 'operational-note';",
        "new": "  return path.capacity === C ? 'assignment' : 'operational-note';",
        "case": "TEST-D-01 clinical_vs_operational: a question and its answer are signed clinical entries of their own authors",
        "expect": "M-D-01: a clinician question text must be a signed clinical entry",
    },
    {
        "id": "M-D-02",
        "title": "a version is stored without its original text (only the hash remains)",
        "file": "records.ts",
        "old": "    text, contentSha256: text === null ? null : hex(Buffer.from(text, 'utf8')), reason, reasonSource, attachments, navigation,",
        "new": "    text: null, contentSha256: text === null ? null : hex(Buffer.from(text, 'utf8')), reason, reasonSource, attachments, navigation,",
        "case": "TEST-D-02 versions_and_sr: every change appends a version; earlier text stays exact and the projection is the fold",
        "expect": "M-D-02: the request text and the reply both stay in the history",
    },
    {
        "id": "M-D-03",
        "title": "a failed signature still proceeds to the commit and answers success",
        "file": "records.ts",
        "old": "      catch { return seal(store, execution, { cause: 'not-dispatched', code: 'SignatureFailed' }, attemptId); }\n      if (!(await store.checkpoint",
        "new": "      catch { envelope = null; }\n      if (!(await store.checkpoint",
        "case": "TEST-D-04 atomic_retry: a failed, unverified or proxy signature commits nothing and leaves the record unchanged",
        "expect": "M-D-03: a signature failure must not commit or answer success",
    },
    {
        "id": "M-D-04",
        "title": "the 24-hour window clears adopted and store-attempted SR bytes",
        "file": "records.ts",
        "old": "      row.storedAt !== null || row.adoptedVersion !== null ? 'adopted' :\n      row.attemptedAt !== null ? 'store-attempted' :\n",
        "new": "",
        "case": "TEST-D-02 versions_and_sr: the 24-hour window ends only an unattempted, unadopted, unreferenced, unheld copy Orthanc confirms absent",
        "expect": "M-D-04: an adopted SR is never cleared by the 24-hour window",
    },
    {
        "id": "M-D-05",
        "title": "the institution boundary is skipped",
        "file": "records.ts",
        "old": "  return institutionId === managing;",
        "new": "  return true || institutionId === managing;",
        "case": "TEST-D-03 read_scope: the author and institution readers are served; another clinician and another institution are not",
        "expect": "M-D-05: another institution gets no body",
    },
    # Round 2 (Astra review of 5457844): each re-introduces one finding D-R1-01..06 and is killed by its own behaviour case.
    {
        "id": "M-D-R1-01a",
        "title": "the replay fingerprint names the current stored unit instead of the route target",
        "file": "records.ts",
        "old": "  const target = [study.studyId, spec.route.includes(':id') ? recordId : null];",
        "new": "  const target = [study.studyId, unit ? unit.recordId : null];",
        "case": "TEST-D-04 atomic_retry: an opening write replays from the re-read unit; a new amendment still needs its reason",
        "expect": "M-D-R1-01: the first assignment replays from the re-read unit",
    },
    {
        "id": "M-D-R1-01b",
        "title": "revision/state/reason rules run before the replay is recognised",
        "file": "records.ts",
        "old": "  const admitted = await checkedRequest(ports.store, input, attemptId);",
        "new": "  const admitted = await checkedRequest(ports.store, input, attemptId); planClinicalWrite(input);",
        "case": "TEST-D-04 atomic_retry: an opening write replays from the re-read unit; a new amendment still needs its reason",
        "expect": "M-D-R1-01: the first assignment replays from the re-read unit",
    },
    {
        "id": "M-D-R1-02",
        "title": "the fingerprint keeps only the text and revision fields (kind, counterparty and the rest drop out)",
        "file": "records.ts",
        "old": "    .filter(key => key !== idField && key !== 'expectedOwner')",
        "new": "    .filter(key => key === spec.textField || key === spec.revisionField)",
        "case": "TEST-D-04 atomic_retry: the same request ID with another image-request.create kind is refused",
        "expect": "M-D-R1-02: image-request.create kind is part of the request meaning",
    },
    {
        "id": "M-D-R1-03",
        "title": "a missing receipt after a lost commit answer is reported as a failure",
        "file": "records.ts",
        "old": "  if (observation.state === 'absent' || observation.state === 'pending') return unknownOutcome();",
        "new": "  if (observation.state === 'absent' || observation.state === 'pending') return failed('StorageFailed');",
        "case": "TEST-D-04 atomic_retry: a lost answer with no visible receipt stays unknown and resolves to the late real outcome",
        "expect": "M-D-R1-03: a missing receipt after a lost answer is not a failure",
    },
    {
        "id": "M-D-R1-04",
        "title": "the author and recipient are taken from the stored projection instead of the opening version",
        "file": "records.ts",
        "old": "  const parties = { authorId: first.author.id, recipientId: first.recipientId };",
        "new": "  const parties = u.parties;",
        "case": "TEST-D-03 read_scope: a rewritten author or recipient projection is refused and no body is provided",
        "expect": "M-D-R1-04: a rewritten author projection grants nothing",
    },
    {
        "id": "M-D-R1-05",
        "title": "a stored SR short-circuits to adopted before the Orthanc observation is compared",
        "file": "records.ts",
        "old": "  if (status === 'unknown') { object(o, ['status']); outcome = row.storedAt !== null ? 'already-adopted' : 'keep-pending'; }",
        "new": "  if (row.storedAt !== null) outcome = 'already-adopted';\n  else if (status === 'unknown') { object(o, ['status']); outcome = row.storedAt !== null ? 'already-adopted' : 'keep-pending'; }",
        "case": "TEST-D-02 versions_and_sr: an Orthanc observation contradicting an adopted SR is a conflict, never adopted",
        "expect": "M-D-R1-05: another hash under an adopted SOP is a conflict",
    },
    {
        "id": "M-D-R1-06",
        "title": "the work-context reason is not bound, so an in-context hide demands a typed reason",
        "file": "records.ts",
        "old": "      if (context) return { text: content, reason: ",
        "new": "      if (false && context) return { text: content, reason: ",
        "case": "TEST-D-02 versions_and_sr: hide and restore in the reading context need no typed reason and are signed corrections keeping the original",
        "expect": "M-D-R1-06: hiding in the reading context needs no typed reason",
    },
    # Round 3 (Astra re-review of eef4781).
    {
        "id": "M-D-R1-03b",
        "title": "an unreadable receipt store on resend is reported as a failure",
        "file": "records.ts",
        "old": "  if (observation.state === 'unavailable') return unknownOutcome();",
        "new": "  if (observation.state === 'unavailable') return failed('StoreUnavailable');",
        "case": "TEST-D-04 atomic_retry: a resend whose receipt lookup fails stays unknown until the late original is visible",
        "expect": "M-D-R1-03b: an unreadable receipt store on resend is not a failure",
    },
    {
        "id": "M-D-R2-01",
        "title": "a Tech Note amendment in its work context still demands a typed reason",
        "file": "records.ts",
        "old": "      if (context) return { text: field, reason: ",
        "new": "      if (false && context) return { text: field, reason: ",
        "case": "TEST-D-02 versions_and_sr: a Tech Note amendment in the acquisition context needs no typed reason and is a signed correction keeping the original",
        "expect": "M-D-R2-01: a Tech Note amendment in the acquisition context needs no typed reason",
    },
]
# The consult's invariant mutants are separate executions, even where their meaning overlaps a retained mutant.
# Model-scoped mutations validate the port contract only, never actual B1 transactions/fencing or R2 DOM behaviour.
MUTANTS += [
    {"id": "M-C01", "invariant": "I01", "title": "omit image request kind from the admitted meaning", "file": "records.ts",
     "old": ".filter(key => key !== idField && key !== 'expectedOwner')",
     "new": ".filter(key => key !== idField && key !== 'expectedOwner' && key !== 'kind')",
     "case": "CONSULT C25 concurrent different meanings cannot replace the winning original",
     "expect": "C25: kind is bound in every pending original"},
    {"id": "M-C02", "invariant": "I02", "scope": "contract-model", "title": "grant a pending observer the original permit", "file": "contract_test.cjs",
     "old": "if (row) return { kind: 'observer', observation: lookup(request, attemptId, true) };",
     "new": "if (row) { const observation = lookup(request, attemptId, true); if (observation.state === 'pending') { row.locked = false; return { kind: 'owner', execution: { ...execution(row), checkpoint: null } }; } return { kind: 'observer', observation }; }",
     "case": "CONSULT C15 pending resend cannot invoke a failing signer", "expect": "C15: observer has no execution effects"},
    {"id": "M-C03", "invariant": "I03", "title": "accept a mismatched receipt as committed evidence", "file": "records.ts",
     "old": "if (!sameRequest(request, plan) || canonical(ec.receipt) !== canonical(plan.receipt) ||\n        !sameRef(ec.version, ref(plan.version)) || !sameRef(ec.version, { recordId: ec.receipt.recordId,\n          versionId: ec.receipt.versionId, sha256: ec.receipt.versionSha256 }) || !string(ec.transactionId) || !string(ec.changeId)) return unknownOutcome();",
     "new": "if (false) return unknownOutcome();",
     "case": "CONSULT C14 mismatched commit evidence cannot answer success", "expect": "C14: mismatched receipt cannot terminate the request"},
    {"id": "M-C04", "invariant": "I04", "scope": "contract-model", "title": "interpret an absent receipt as new admission", "file": "contract_test.cjs",
     "old": "if (row) return { kind: 'observer', observation: lookup(request, attemptId, true) };",
     "new": "if (row && row.terminal) return { kind: 'observer', observation: lookup(request, attemptId, true) };",
     "case": "CONSULT C11 absent receipt never grants a second execution", "expect": "C11: pending receipt is not a new permit"},
    {"id": "M-C05", "invariant": "I05", "title": "elevate a bare rollback to terminal rejection", "file": "records.ts",
     "old": "      const rollback = error instanceof CommitRolledBack ? error.proof : null;",
     "new": "      if (error instanceof CommitRolledBack) return { state: 'rejected', original: request, epoch: permit.epoch, proof: { original: request, epoch: permit.epoch, rejectionId: 'unproved', code: 'StorageFailed', fencedThrough: permit.epoch, noClinicalEffects: true } };\n      const rollback = error instanceof CommitRolledBack ? error.proof : null;",
     "case": "CONSULT C19 a bare old transaction rollback is only an attempt error", "expect": "C19: bare rollback cannot produce failed or R"},
    {"id": "M-C06", "invariant": "I06", "scope": "contract-model", "title": "commit clinical effects despite H failure", "file": "contract_test.cjs",
     "old": "    if (state.failAudit) return rollback();", "new": "",
     "case": "CONSULT C47 an H failure rolls back every clinical effect and seals the original", "expect": "C47: failed H stores no version signature or success"},
    {"id": "M-C07", "invariant": "I07", "title": "skip signature version and hash binding", "file": "records.ts",
     "old": "  if (e.recordId !== s.recordId || e.versionId !== s.versionId || e.versionSha256 !== s.versionSha256) refuse('SignatureBindingRefused');",
     "new": "",
     "case": "CONSULT C07 another version or hash is never adopted", "expect": "C07: only the bound author version can be stored"},
    {"id": "M-C08", "invariant": "I08", "scope": "contract-model", "title": "omit the current epoch check at the storage boundary", "file": "contract_test.cjs",
     "old": "!row.terminal && row.epoch === permit.epoch ? row : null;", "new": "!row.terminal ? row : null;",
     "case": "CONSULT C39 the recovery epoch fences a late old writer before effects", "expect": "C39: old epoch has zero clinical effects"},
    {"id": "M-C09", "invariant": "I09", "scope": "contract-model", "title": "misclassify an observer poll as clinical change H", "file": "contract_test.cjs",
     "old": "    if (external) state.observations.push({ attemptId, originalId: row?.original.originalId ?? null, kind: 'service-job' });",
     "new": "    if (external) { state.observations.push({ attemptId, originalId: row?.original.originalId ?? null, kind: 'service-job' }); state.changes.push({ originalId: row?.original.originalId }); }",
     "case": "CONSULT C23 concurrent observers add O but never duplicate H or L", "expect": "C23 pending: V/S/H/L/J/O"},
    {"id": "M-C10", "invariant": "I10", "title": "replan a recovered intent after its context has ended", "file": "records.ts",
     "old": "    const plan = work.plan;",
     "new": "    const plan = execution.checkpoint ? planClinicalWrite({ ...execution.seed, workContext: null }) : work.plan;",
     "case": "CONSULT C35 prepared recovery preserves original time version text and context reason",
     "expect": "C35: recovery reuses the fixed context reason without replanning"},
    {"id": "M-C11", "invariant": "I11", "title": "skip the current institution check for outcome lookup", "file": "records.ts",
     "old": "  if (!institutionAdmits(actor.institutionId, managing)) refuse('NotFound');", "new": "",
     "case": "CONSULT C46 each outcome lookup enforces current institution access", "expect": "C46: another institution gets no outcome receipt or body"},
    {"id": "M-C12", "invariant": "I12", "scope": "reconciliation-model", "title": "disable automatic lookup and require another external event", "file": "records.ts",
     "old": "    await waitNext();", "new": "    return;",
     "case": "CONSULT C49 automatic next lookup applies observable original success with no user event",
     "expect": "C49: automatic next lookup completes without a Retry click"},
]
# The exact round-1 selection of tests/emr/d/contract_test.cjs, written by hand (never generated from a run). The
# baseline must collect exactly these cases, each once, all passing; R2 moves the declaration into emr/units/d.json.
DECLARED_CASES = [
    "TEST-D-01 clinical_vs_operational: a question and its answer are signed clinical entries of their own authors",
    "TEST-D-01 clinical_vs_operational: consultation and finding text is signed; acceptance only moves state",
    "TEST-D-01 clinical_vs_operational: reader assignment carries no text and never a clinical signature",
    "TEST-D-01 clinical_vs_operational: staff processing text is an operational note; a clinician's request text is adopted and signed",
    "TEST-D-01 clinical_vs_operational: a radiographer signs their own Tech Note; an administrator never signs in their place",
    "TEST-D-01 clinical_vs_operational: body claims of authority are refused and server facts alone decide the class",
    "TEST-D-01 clinical_vs_operational: no registered signer, a service account or a foreign path plans nothing",
    "TEST-D-01 clinical_vs_operational: planned kinds belong to the A route and the signing request is a valid A payload",
    "TEST-D-02 versions_and_sr: every change appends a version; earlier text stays exact and the projection is the fold",
    "TEST-D-02 versions_and_sr: a rewritten, dropped or reordered earlier version is refused, never projected",
    "TEST-D-02 versions_and_sr: a finding correction keeps the original and incorporates source copies, not the comparison link",
    "TEST-D-02 versions_and_sr: the 24-hour window ends only an unattempted, unadopted, unreferenced, unheld copy Orthanc confirms absent",
    "TEST-D-02 versions_and_sr: Orthanc reconciliation adopts only the exact bytes this server authorized",
    "TEST-D-02 versions_and_sr: the store intent is the author's signature over the exact SR bytes; others are refused",
    "TEST-D-03 read_scope: the author and institution readers are served; another clinician and another institution are not",
    "TEST-D-03 read_scope: a write from another institution is refused before anything else is examined",
    "TEST-D-03 read_scope: bodies are handed out only after the access event for exactly those versions is durable",
    "TEST-D-03 read_scope: summaries, receipts and refusals carry no clinical text",
    "TEST-D-04 atomic_retry: one commit per request; a replay returns the stored receipt without signing again",
    "TEST-D-04 atomic_retry: a failed, unverified or proxy signature commits nothing and leaves the record unchanged",
    "TEST-D-04 atomic_retry: a lost commit answer is resolved by the stored receipt, never guessed",
    "TEST-D-04 atomic_retry: a stale revision, a forbidden transition or a regressed clock is refused before any signing",
    "TEST-D-04 atomic_retry: an opening write replays from the re-read unit; a new amendment still needs its reason",
    "TEST-D-04 atomic_retry: the same request ID with another image-request.create kind is refused",
    "TEST-D-04 atomic_retry: the same request ID with another image-request.create counterparty is refused",
    "TEST-D-04 atomic_retry: the same request ID with another image-request.create counterpartyInstitutionId is refused",
    "TEST-D-04 atomic_retry: the same request ID with another image-request.create reason is refused",
    "TEST-D-04 atomic_retry: the same request ID with another consultation.create recipientSub is refused",
    "TEST-D-04 atomic_retry: the same request ID with another consultation.create reason is refused",
    "TEST-D-04 atomic_retry: the same request ID with another question.create body is refused",
    "TEST-D-04 atomic_retry: the same request ID with another question.reply body is refused",
    "TEST-D-04 atomic_retry: the same request ID with another question.reply revision is refused",
    "TEST-D-04 atomic_retry: the same request ID with another question.close note is refused",
    "TEST-D-04 atomic_retry: the same request ID with another consultation.complete note is refused",
    "TEST-D-04 atomic_retry: the same request ID with another consultation.accept action is refused",
    "TEST-D-04 atomic_retry: the same request ID with another image-request.close note is refused",
    "TEST-D-04 atomic_retry: the same request ID with another assignment.write readerSub is refused",
    "TEST-D-04 atomic_retry: the same request ID with another assignment.write revision is refused",
    "TEST-D-04 atomic_retry: the same request ID with another tech-note.write text is refused",
    "TEST-D-04 atomic_retry: the same request ID with another tech-note.write reason is refused",
    "TEST-D-04 atomic_retry: the same request ID with another tech-note.write baseVersion is refused",
    "TEST-D-04 atomic_retry: the same request ID with another finding.create item is refused",
    "TEST-D-04 atomic_retry: the same request ID with another finding.hide item is refused",
    "TEST-D-04 atomic_retry: the same request ID with another finding.hide reason is refused",
    "TEST-D-04 atomic_retry: a lost answer with no visible receipt stays unknown and resolves to the late real outcome",
    "TEST-D-03 read_scope: a rewritten author or recipient projection is refused and no body is provided",
    "TEST-D-02 versions_and_sr: an Orthanc observation contradicting an adopted SR is a conflict, never adopted",
    "TEST-D-02 versions_and_sr: hide and restore in the reading context need no typed reason and are signed corrections keeping the original",
    "TEST-D-04 atomic_retry: a resend whose receipt lookup fails stays unknown until the late original is visible",
    "TEST-D-02 versions_and_sr: a Tech Note amendment in the acquisition context needs no typed reason and is a signed correction keeping the original",
]
NOT_RUN = [{"id": "M-D-06", "status": "not_run",
            "reason": "delayed-response UID+sequence/account-generation check is page code (consultations.js, finding-command.js, "
                      "reading-findings.js, clinician.js); round 2 DOM case TEST-D-05 ui_reopen owns it"}]
CONSULT_CASES = [
    "CONSULT C01 original clinical commit has one jointly stored terminal",
    "CONSULT C02 operational acceptance never invents a medical signature",
    "CONSULT C03 original sign throw is sealed before failure",
    "CONSULT C04 original verify throw is sealed before failure",
    "CONSULT C05 invalid verification is never adopted",
    "CONSULT C06 another signer is never adopted",
    "CONSULT C07 another version or hash is never adopted",
    "CONSULT C08 original rollback needs its durable fenced rejection",
    "CONSULT C09 failed sealing stays unknown until recovery seals the original cause",
    "CONSULT C10 a lost commit answer reconciles the exact original success",
    "CONSULT C11 absent receipt never grants a second execution",
    "CONSULT C12 lookup outages never replace the original result",
    "CONSULT C13 only atomic admission can establish a previously absent original",
    "CONSULT C14 mismatched commit evidence cannot answer success",
    "CONSULT C15 pending resend cannot invoke a failing signer",
    "CONSULT C16 pending resend cannot invoke a failing verifier",
    "CONSULT C17 pending resend cannot adopt invalid verification",
    "CONSULT C18 even successful resend ports have no execution permit",
    "CONSULT C19 a bare old transaction rollback is only an attempt error",
    "CONSULT C20 resend cannot invoke its timeout transaction",
    "CONSULT C21 the next observation returns an already observable terminal immediately",
    "CONSULT C22 another original cannot supply terminal evidence",
    "CONSULT C23 concurrent observers add O but never duplicate H or L",
    "CONSULT C24 concurrent equal admissions create exactly one original",
    "CONSULT C25 concurrent different meanings cannot replace the winning original",
    "CONSULT C26 committed meanings remain immutable and body free",
    "CONSULT C27 another original or epoch rollback cannot seal this request",
    "CONSULT C28 a rejected ID only ever looks up the same failure",
    "CONSULT C29 a late unknown cannot erase the request terminal already applied",
    "CONSULT C30 observer never replans current revision time or context",
    "CONSULT C31 first Tech Note replays after context and generated IDs change",
    "CONSULT C32 an older request returns its own receipt after another commit",
    "CONSULT C33 restart before admission has no phantom original or effect",
    "CONSULT C34 recovery after lost admission resumes the same original",
    "CONSULT C35 prepared recovery preserves original time version text and context reason",
    "CONSULT C36 signed recovery adopts the preserved signature without signing again",
    "CONSULT C37 restart observes the late original transaction commit",
    "CONSULT C38 restart seals only the dispatched originals proved rollback",
    "CONSULT C39 the recovery epoch fences a late old writer before effects",
    "CONSULT C40 elapsed time cannot discard a pending original or intent",
    "CONSULT C41 lost rejection response survives a restarted healthy signer",
    "CONSULT C42 a pending Tech Note keeps the original context cause in version signature and H",
    "CONSULT C43 reading hide and restore keep automatic reasons and signed originals",
    "CONSULT C44 acquisition amendments and clearing are signed reasoned corrections",
    "CONSULT C45 a rejected context needs a new ID for a corrected explicit reason",
    "CONSULT C46 each outcome lookup enforces current institution access",
    "CONSULT C47 an H failure rolls back every clinical effect and seals the original",
    "CONSULT C48 receipt observation is separate from durable body provision and display",
    "CONSULT C49 automatic next lookup applies observable original success with no user event",
    "CONSULT C50 automatic lookups survive two outages without guessing or prompting",
    "CONSULT C51 repeated absence keeps automatic lookup on the original ID",
    "CONSULT C52 actual view ABA and account-generation application",
    "CONSULT C53 original sign wait timeout never fails a still running original",
    "CONSULT C54 original verify wait timeout never fails a still running original",
    "CONSULT C55 fenced cancellation before late sign prevents verify and commit",
    "CONSULT C56 fenced cancellation before late verify prevents commit",
]
DECLARED_CASES += CONSULT_CASES
CASE_NOT_RUN = {"CONSULT C52 actual view ABA and account-generation application":
                "R2 DOM UID+sequence/account generation, newer input preservation, actual zero-friction UI acceptance"}
INTEGRATION_NOT_RUN = [
    "B1 durable register/transaction/fencing and multi-process restart: every C case, especially M-C06/M-C08",
    "B2 authenticated immutable actor identity, fresh institution/route authorization and protected intent access",
    "C actual signing identity/operation-ID reconciliation and signature verification",
    "R2 DOM application for C29/C49-C52 and M-C12; M-D-06 remains a separate not_run mutant",
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_lf(path):
    # Anchors are written with LF; a Windows checkout may hold CRLF. Compare and mutate on LF text.
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def check_anchors():
    problems = []
    for m in MUTANTS:
        count = read_lf(TEST if m["file"] == TEST.name else D_DIR / m["file"]).count(m["old"])
        if count != 1:
            problems.append(f"{m['id']}: anchor occurs {count} times in {m['file']}")
    return problems


def node_binary():
    node = os.environ.get("KIN_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("node not found (set KIN_NODE)")
    return node


def stage(workdir, mutant=None):
    src = pathlib.Path(workdir) / "api" / "src"
    shutil.copytree(A_DIR, src / "emr-contract")
    shutil.copytree(D_DIR, src / "emr-clinical")
    test = pathlib.Path(workdir) / "tests" / "emr" / "d" / TEST.name
    test.parent.mkdir(parents=True)
    shutil.copyfile(TEST, test)
    hashes = {}
    if mutant:
        target = test if mutant["file"] == TEST.name else src / "emr-clinical" / mutant["file"]
        text = read_lf(target)
        mutated = text.replace(mutant["old"], mutant["new"], 1)
        target.write_bytes(mutated.encode("utf-8"))
        hashes = {"source": sha(text.encode("utf-8")), "mutated": sha(mutated.encode("utf-8"))}
    return src / "emr-clinical", test, hashes


def run(node, d_src, test, case=None):
    env = {**os.environ, "KIN_EMR_D_SRC": str(d_src), "KIN_EMR_D_ROOT": str(ROOT), "NODE_OPTIONS": ""}
    # A broken invariant can invalidate an unrelated schedule's barrier. Only its own behavioural assertion judges
    # each mutant; the unmutated baseline above still collects every declared case, not a shortened selection.
    selection = ["--test-name-pattern=^" + re.escape(case) + "$"] if case else []
    proc = subprocess.run([node, "--test", "--test-reporter=tap", *selection, str(test)], cwd=ROOT, env=env, capture_output=True, timeout=600)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


TAP_LINE = re.compile(r"^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$")


def tap_cases(stdout):
    """Top-level TAP results: name -> (status, block lines). Node escapes '#' and '\\' in names; ours contain neither."""
    lines, cases, i = stdout.splitlines(), {}, 0
    while i < len(lines):
        match = TAP_LINE.match(lines[i])
        i += 1
        if not match:
            continue
        block = []
        if i < len(lines) and lines[i].strip() == "---":
            i += 1
            while i < len(lines) and lines[i].strip() != "...":
                block.append(lines[i])
                i += 1
            i += 1
        if match.group(3) in cases:
            raise SystemExit(f"duplicate TAP case name: {match.group(3)}")
        cases[match.group(3)] = (match.group(1), match.group(4), block)
    return cases


def judge(mutant, code, stdout, stderr):
    cases = tap_cases(stdout)
    entry = cases.get(mutant["case"])
    block = "\n".join(entry[2]) if entry else ""
    crash = [marker for marker in CRASH_MARKERS if marker in stdout or marker in stderr]
    reasons = []
    if code == 0:
        reasons.append("child exited 0")
    if entry is None:
        reasons.append("named case not reported")
    elif entry[0] != "not ok" or entry[1]:
        reasons.append(f"named case reported {entry[0]} {entry[1] or ''}".strip())
    if "failureType: 'testCodeFailure'" not in block:
        reasons.append("no testCodeFailure in the case block")
    if "code: 'ERR_ASSERTION'" not in block:
        reasons.append("no ERR_ASSERTION in the case block")
    if mutant["expect"] not in block:
        reasons.append("expect text not in the case block")
    if crash:
        reasons.append("crash markers: " + ", ".join(crash))
    failing = sorted(name for name, (status, _, _) in cases.items() if status == "not ok")
    return {"killed": not reasons, "reasons": reasons, "failing_cases": failing, "case_block": entry[2] if entry else []}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--anchors-only", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()
    problems = check_anchors()
    sources = {str(p.relative_to(ROOT)).replace("\\", "/"): sha(p.read_bytes())
               for p in sorted([*D_DIR.glob("*.ts"), *A_DIR.glob("*.ts"), TEST])}
    summary = {"sources": sources, "anchors": "ok" if not problems else problems, "baseline": None, "mutants": [], "not_run": NOT_RUN,
               "case_not_run": CASE_NOT_RUN, "integration_not_run": INTEGRATION_NOT_RUN}
    if problems or args.anchors_only:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 1 if problems else 0
    node = node_binary()
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    summary["node"] = version
    with tempfile.TemporaryDirectory(prefix="emr-d-baseline-") as work:
        d_src, test, _ = stage(work)
        code, stdout, stderr = run(node, d_src, test)
        cases = tap_cases(stdout)
        passed = {name for name, (status, skip, _) in cases.items() if status == "ok" and not skip}
        missing = sorted({m["case"] for m in MUTANTS} - passed)
        skipped = {name for name, (status, skip, _) in cases.items() if status == "ok" and skip == "SKIP"}
        selection = {"declared": len(DECLARED_CASES), "collected": len(cases), "passed": len(passed), "skipped": sorted(skipped),
                     "undeclared": sorted(set(cases) - set(DECLARED_CASES)), "not_collected": sorted(set(DECLARED_CASES) - set(cases))}
        summary["baseline"] = {"exit": code, "selection": selection, "not_ok": sorted(n for n, (s, _, _) in cases.items() if s == "not ok"),
                               "named_cases_not_passing": missing, "stdout": stdout, "stderr": stderr}
        mismatch = (len(set(DECLARED_CASES)) != len(DECLARED_CASES) or set(cases) != set(DECLARED_CASES) or
                    passed != set(DECLARED_CASES) - set(CASE_NOT_RUN) or skipped != set(CASE_NOT_RUN))
        if code != 0 or missing or mismatch:
            summary["baseline"]["stderr_tail"] = stderr[-2000:]
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 1
    for mutant in MUTANTS:
        with tempfile.TemporaryDirectory(prefix=f"emr-d-{mutant['id'].lower()}-") as work:
            d_src, test, hashes = stage(work, mutant)
            code, stdout, stderr = run(node, d_src, test, mutant["case"])
            verdict = judge(mutant, code, stdout, stderr)
            source = "tests/emr/d/" if mutant["file"] == TEST.name else "api/src/emr-clinical/"
            summary["mutants"].append({"id": mutant["id"], "title": mutant["title"], "file": source + mutant["file"],
                                       "scope": mutant.get("scope", "D-module"), "invariant": mutant.get("invariant"),
                                       "case": mutant["case"], "expect": mutant["expect"], "exit": code,
                                       "stdout": stdout, "stderr": stderr, **hashes, **verdict})
    killed = all(m["killed"] for m in summary["mutants"])
    summary["result"] = {"killed": sum(m["killed"] for m in summary["mutants"]), "total": len(MUTANTS), "not_run": len(NOT_RUN)}
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if killed else 1


if __name__ == "__main__":
    sys.exit(main())
