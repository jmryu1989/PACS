# coding: utf-8
"""TEST-F mutants (EMR-F round 1): M-F-01..M-F-07 and M-F-S1..S7 of api/src/emr-audit.

REQ-EMR-07/15/16/17/19 -> RISK-F-01..08 -> TEST-F-01..08 (tests/emr/f/contract_test.cjs).

Each mutant breaks one protection of the product in a COPY of api/src/emr-audit (api/src/emr-contract copied beside it
unchanged) and runs the contract test against that copy through KIN_EMR_F_SRC. A mutant counts as killed only when ALL
of these hold:
  * the unmutated copies first pass the same command and collect exactly DECLARED_CASES (else no kill is reported);
  * the anchor occurs exactly once in its file (a missing or repeated anchor is a failure, not a survivor);
  * the child exits non-zero, the named case is reported `not ok` in the TAP stream with failureType testCodeFailure
    and code ERR_ASSERTION, and that mutant's own expect text is inside that case's failure block;
  * no crash marker (syntax/reference/module errors) appears: an import or process failure is never a kill.

The live forms of these risks (the R2 SQL predicate, the A gate in lawful-defaults.ts, the real roster store and print
flow) are reported "not_run" with their reason, never as kills. The source tree is never modified. Source and mutated
file hashes go into the summary.

stdlib only. Usage: python -B tests/emr/f/mutants.py [--anchors-only] [--out PATH]; node comes from KIN_NODE or PATH.
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
F_DIR = ROOT / "api" / "src" / "emr-audit"
A_DIR = ROOT / "api" / "src" / "emr-contract"
TEST = ROOT / "tests" / "emr" / "f" / "contract_test.cjs"
CRASH_MARKERS = ("SyntaxError:", "ReferenceError:", "Cannot find module", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE")

MUTANTS = [
    {
        "id": "M-F-01",
        "title": "a general admin is given audit authority without a roster grant",
        "file": "contract.ts",
        "old": "  if (!scopes.length) refuse('AuditorNotDesignated');\n",
        "new": "  if (!scopes.length && c.roles.includes('admin')) scopes.push(...ROSTER_SCOPES);\n"
               "  if (!scopes.length) refuse('AuditorNotDesignated');\n",
        "case": "TEST-F-01 roster_scope: a designated auditor gets exactly the granted scopes and a general admin without a grant gets none",
        "expect": "M-F-01: a general admin without a grant gets no audit authority",
    },
    {
        "id": "M-F-02",
        "title": "the institution filter is applied after the page is cut (count and page include other institutions)",
        "file": "contract.ts",
        "old": "      if (!inInstitutionScope(plan, event)) continue;\n"
               "      const targets = eventMatches(plan, event);\n"
               "      if (!targets) continue;\n"
               "      total++;\n"
               "      if (after !== null && sequence >= after) continue;\n"
               "      if (rows.length < limit) { rows.push(replayEntry(sequence, durableAt, event, targets, options.currentLink)); last = sequence; }\n",
        "new": "      const targets = eventMatches(plan, event);\n"
               "      if (!targets) continue;\n"
               "      total++;\n"
               "      if (after !== null && sequence >= after) continue;\n"
               "      if (rows.length < limit) { if (inInstitutionScope(plan, event)) rows.push(replayEntry(sequence, durableAt, event, targets, options.currentLink)); last = sequence; }\n",
        "case": "TEST-F-01 roster_scope: only the institution events are counted, paged and exported and other institutions add nothing",
        "expect": "M-F-02: other institutions add nothing to the count or the page",
    },
    {
        "id": "M-F-03",
        "title": "past events are re-attributed to the study's current patient link",
        "file": "contract.ts",
        "old": "    patient: recorded,\n",
        "new": "    patient: current ? { status: 'known' as const, value: current } : recorded,\n",
        "case": "TEST-F-02 patient_replay: replay keeps each event recorded patient, institutions, version and times after a re-match",
        "expect": "M-F-03: past events stay attributed to the patient they recorded",
    },
    {
        "id": "M-F-04",
        "title": "opening a print window marks the copy as issued",
        "file": "contract.ts",
        "old": "          if (state === null || TERMINAL.includes(state)) refuse('IssuanceTransitionRefused');\n"
               "          break;\n",
        "new": "          if (state === null || TERMINAL.includes(state)) refuse('IssuanceTransitionRefused');\n"
               "          if (state === 'Prepared' && e.observation === 'print-opened') state = 'Issued';\n"
               "          break;\n",
        "case": "TEST-F-04 issuance_result: Issued needs server bytes bound to the manifest and a designated issuer while a print window or client PDF never issues",
        "expect": "M-F-04: a print window is not an issued copy",
    },
    {
        "id": "M-F-05",
        "title": "the clause wording is chosen by promulgation date, so the future military clause applies now",
        "file": "contract.ts",
        "old": "  const inForce = DISCLOSURE_CLAUSE_VERSIONS.filter(v => v.effectiveAt <= day);\n",
        "new": "  const inForce = DISCLOSURE_CLAUSE_VERSIONS.filter(v => v.publishedAt <= day);\n",
        "case": "TEST-F-03 lawful_issue: a military manpower request is judged by the wording in force when it arrived",
        "expect": "M-F-05: a future clause is not applied before it is in force",
    },
    {
        "id": "M-F-06",
        "title": "a pending request hold ends at the original until although the deadline was lawfully extended",
        "file": "contract.ts",
        "old": "  if (at >= due) return freeze({ preserve: true, state: 'pending-overdue', dueAt: due });\n",
        "new": "  if (at >= facts.initialDueAt) return freeze({ preserve: false, state: 'pending-overdue', dueAt: facts.initialDueAt });\n",
        "case": "TEST-F-06 extended_request_hold: a lawfully extended pending request keeps its hold after the old until and the old until releases nothing",
        "expect": "M-F-06: the old until does not end a pending extended request",
    },
    {
        "id": "M-F-07",
        "title": "the automatically generated monthly report counts as the human review",
        "file": "contract.ts",
        "old": "    const review = events.filter(e => e.kind === 'reviewed').pop() ?? null;\n",
        "new": "    const review = events.filter(e => e.kind === 'reviewed' || e.kind === 'report-generated').pop() ?? null;\n",
        "case": "TEST-F-05 followup: an automatically generated monthly report is not an inspection and a designated reviewer completes it",
        "expect": "M-F-07: a generated report alone is not a completed inspection",
    },
    {
        "id": "M-F-S1",
        "title": "an unreadable ledger is reported as an incident with nobody affected (legal register D-15)",
        "file": "contract.ts",
        "old": "    reasons.push({ kind: 'ledger-unreadable', code: error.code });\n",
        "new": "    void error.code;\n",
        "case": "TEST-F-07 incident_scope: a ledger that cannot be read or verified is reported as subjects not identifiable and never as nobody affected",
        "expect": "M-F-S1: an unreadable ledger never reads as nobody affected",
    },
    {
        "id": "M-F-S2",
        "title": "a deletion request deletes a record the law keeps (legal register D-7)",
        "file": "contract.ts",
        "old": "    const outcome: RightsOutcome = r.kind === 'deletion' ? (kept ? 'refused-retained-by-law' : 'delete-irreversibly') :\n",
        "new": "    const outcome: RightsOutcome = r.kind === 'deletion' ? 'delete-irreversibly' :\n",
        "case": "TEST-F-08 rights_request: deletion or suspension of a record the law keeps is refused with reason and objection notice while purpose data is acted on",
        "expect": "M-F-S2: a statutory record is never deleted on request",
    },
    {
        "id": "M-F-S3", "title": "synthetic issuance can be relabelled as operational", "file": "contract.ts",
        "old": "    if (environment !== v.manifest.environment) refuse('IssuanceEnvironmentMismatch');\n",
        "new": "",
        "case": "TEST-F-04 issuance_result: a paper handover is the staff attestation and not a detection and synthetic recipients never count as operational",
        "expect": "M-F-S3: relabelling a synthetic issuance cannot make operational evidence",
    },
    {
        "id": "M-F-S4", "title": "the view stream is silently omitted", "file": "contract.ts",
        "old": "totalEntries: changePage.total + viewPage.total",
        "new": "totalEntries: changePage.total",
        "case": "TEST-F-02 patient_replay: change and view streams keep independent snapshots and cursors and neither stream may silently disappear",
        "expect": "M-F-S4: both access streams contribute their own entries",
    },
    {
        "id": "M-F-S5", "title": "an unbound stored release ends a pending request hold", "file": "contract.ts",
        "old": "  if (hold.release !== null) {\n    const release = guarded('HoldReleaseBindingRefused', () => {\n",
        "new": "  if (hold.release !== null) return freeze({ preserve: false, state: 'released', dueAt: due });\n"
               "  if (hold.release !== null) {\n    const release = guarded('HoldReleaseBindingRefused', () => {\n",
        "case": "TEST-F-06 extended_request_hold: a reloaded release needs its own verified resolution and institution and cannot end preservation early",
        "expect": "M-F-S5: a release without the request resolution never ends preservation",
    },
    {
        "id": "M-F-S6", "title": "an older recheck closes a new follow-up action", "file": "contract.ts",
        "old": "      return !action || recheck?.result !== 'resolved' || events.indexOf(recheck) <= events.indexOf(action);\n",
        "new": "      return !action || recheck?.result !== 'resolved';\n",
        "case": "TEST-F-05 followup: every new action needs a later recheck before closing including actions at the same time",
        "expect": "M-F-S6: a new action cannot reuse an earlier recheck",
    },
    {
        "id": "M-F-S7", "title": "possible-leak notification waits beyond its 72-hour deadline", "file": "contract.ts",
        "old": " : numeric ? hours72(c.at) : IMMEDIATE_TIMING_RULE.dueAt;\n",
        "new": " : numeric ? hours72(c.family === 'possibility' ? hours72(c.at) : c.at) : IMMEDIATE_TIMING_RULE.dueAt;\n",
        "case": "TEST-F-07 incident_scope: possible leak notice covers all possibly affected subjects within 72 hours and an unknown population is never zero",
        "expect": "M-F-S7: possible-leak notice retains its 72-hour deadline and all-possible-subject audience",
    },
]
MUTANTS += [
    {
        "id": "M-F-R2-001", "title": "a no-breach verdict erases the possibility obligation", "file": "contract.ts",
        "old": "      if (v.possibleGround !== null && possibleAt >= INCIDENT_COMMON_RULE.possibilityEffectiveFrom) causes.push({ family: 'possibility',",
        "new": "      if (v.possibleGround !== null && v.status !== 'not-a-leak' && possibleAt >= INCIDENT_COMMON_RULE.possibilityEffectiveFrom) causes.push({ family: 'possibility',",
        "case": "TEST-F-07 incident_scope: a late no-breach verdict retains the overdue possibility obligation and actual notices",
        "expect": "M-F-R2-001: a late no-breach verdict retains the overdue obligation",
    },
    {
        "id": "M-F-R2-002", "title": "the old investigation resolution hides the new finding investigation", "file": "contract.ts",
        "old": "    const openInvestigations = [...investigations.keys()].filter(id => {\n",
        "new": "    const openInvestigations = [...investigations.keys()].slice(0, 1).filter(id => {\n",
        "case": "TEST-F-05 followup: a new anomaly after a resolved investigation needs its own action and recheck",
        "expect": "M-F-R2-002: a new anomaly cannot reuse an old resolution",
    },
    {
        "id": "M-F-R2-003", "title": "copy issuance ignores fixed signature time and predecessor binding", "file": "contract.ts",
        "old": "        if (digest(payload.text) !== e.contentSha256 || payload.serverTime !== e.signature.signedAt ||\n"
               "            payload.serverTime !== e.at || (e.predecessor === null ? payload.previousVersion !== null :\n"
               "              payload.previousVersion === null || payload.previousVersion.recordId !== e.predecessor.recordId ||\n"
               "              payload.previousVersion.versionId !== e.predecessor.partId || payload.previousVersion.sha256 !== e.predecessor.sha256))\n"
               "          refuse('SignatureEvidenceMismatch');\n",
        "new": "",
        "case": "TEST-F-03 lawful_issue: signature signed-at time must equal the stored fixed version",
        "expect": "M-F-R2-003-time: contradictory signature refuses the package",
    },
]
MUTANTS += [
    {
        "id": "M-F-R3-001", "title": "trust the input notice flag instead of recorded obligation history", "file": "contract.ts",
        "old": "    const possibleNotices = notices.filter(n => n.kind === 'possible-leak');\n",
        "new": "    const possibleNotices = f.priorPossibleNotice ? notices.filter(n => n.noticeId === f.priorPossibleNotice.noticeId) : [];\n",
        "case": "TEST-F-07 incident_scope: stored bound possibility notice automatically requires no-breach follow-up without an input flag",
        "expect": "M-F-R3-001: stored bound notice requires follow-up without a caller flag",
    },
    {
        "id": "M-F-R3-002", "title": "read a null inspection step before validating it", "file": "contract.ts",
        "old": "  guarded('InspectionStepRefused', () => object(step, Object.keys(step ?? {})));\n",
        "new": "",
        "case": "TEST-F-05 followup: a null inspection step gives a typed refusal and leaves the cycle unchanged",
        "expect": "M-F-R3-002: null step returns the typed refusal",
    },
]
MUTANTS += [
    {
        "id": "M-F-R4-001", "title": "derive notice facts before binding newly supplied evidence", "file": "contract.ts",
        "old": "    const possibleNotices = notices.filter(n => n.kind === 'possible-leak');\n",
        "new": "    const possibleNotices = (previous?.ledger.notices ?? []).filter(n => n.kind === 'possible-leak');\n",
        "case": "TEST-F-07 C11 new notice and no-leak verdict create the follow-up in the same call",
        "expect": "M-F-R4-001: newly supplied notice creates follow-up without another call",
    },
    {
        "id": "M-F-R4-002", "title": "recognise only notices of a previously met whole duty", "file": "contract.ts",
        "old": "    const possibleNotices = notices.filter(n => n.kind === 'possible-leak');\n",
        "new": "    const possibleNotices = notices.filter(n => n.kind === 'possible-leak' && previous?.obligations.some(o => o.status === 'met' && o.noticeRefs.includes(n.noticeId)));\n",
        "case": "TEST-F-07 C42 partial notices create recipient follow-ups although the whole duty remains overdue",
        "expect": "M-F-R4-002: partial bound notice is a notice fact independently of whole-duty status",
    },
    {
        "id": "M-F-R4-003", "title": "freeze the first projection instead of replaying newly bound past facts", "file": "contract.ts",
        "old": "    const currentVerdict = effective[effective.length - 1];\n",
        "new": "    if (previous) return previous;\n    const currentVerdict = effective[effective.length - 1];\n",
        "case": "TEST-F-07 C26 C29 batched split and late-received evidence replay to the same semantic projection",
        "expect": "M-F-R4-003: past evidence replays a formerly moot duty and its follow-up",
    },
    {
        "id": "M-F-R4-004", "title": "overwrite conflicting evidence with the last use of its ID", "file": "contract.ts",
        "old": "        if (old && digest(content(old)) !== digest(content(item))) throw new Error('Conflicting evidence ID');\n",
        "new": "        if (old && digest(content(old)) !== digest(content(item))) result.set(id(item), item);\n",
        "case": "TEST-F-07 C30 conflicting notice identity refuses atomically instead of overwriting delivery evidence",
        "expect": "M-F-R4-004: a notice ID cannot overwrite conflicting evidence",
    },
    {
        "id": "M-F-R4-005", "title": "overdue is absorbing even after actual delivery", "file": "contract.ts",
        "old": "      o.observations = [...(old?.observations ?? []), { asOf, status: o.status, noticeRefs: [...o.noticeRefs] }];\n",
        "new": "      if (old?.status === 'overdue') o.status = 'overdue';\n      o.observations = [...(old?.observations ?? []), { asOf, status: o.status, noticeRefs: [...o.noticeRefs] }];\n",
        "case": "TEST-F-07 C33 C34 overdue observations allow late performance and late recording of timely performance",
        "expect": "M-F-R4-005: overdue is not an absorbing state after actual delivery",
    },
    {
        "id": "M-F-R4-006", "title": "retroactively moot duties even after their numeric deadline", "file": "contract.ts",
        "old": "canMoot: (at: string, due: string | null) => due !== null && at < due",
        "new": "canMoot: (at: string, due: string | null) => due !== null",
        "case": "TEST-F-07 C35 C36 LQ-03 only a pre-deadline no-leak determination moots an unnotified duty",
        "expect": "M-F-R4-006: no-leak at or after deadline cannot retroactively moot the duty",
    },
    {
        "id": "M-F-R4-007", "title": "immediate duties have a zero-time deadline and are automatically missed", "file": "contract.ts",
        "old": "      if (fulfilled) o.status = 'met';\n",
        "new": "      if (o.timing === 'immediate') o.dueAt = o.triggeredAt;\n"
               "      if (o.timing === 'immediate' && (fulfilled?.sentAt ?? asOf) > o.dueAt) o.status = 'missed';\n"
               "      else if (fulfilled) o.status = 'met';\n",
        "case": "TEST-F-07 C20 LQ-01 no-leak follow-up sent thirty minutes later is met with no numeric legal deadline",
        "expect": "M-F-R4-007: immediate performance has no invented zero-time deadline",
    },
    {
        "id": "M-F-R4-008", "title": "clearing a delay grants a fresh 72-hour grace window", "file": "contract.ts",
        "old": "clearedDueAt: (_at: string): string | null => null",
        "new": "clearedDueAt: (at: string): string | null => hours72(at)",
        "case": "TEST-F-07 C38 LQ-02 accepted delay clearance and delivery stay on one duty and require follow-up",
        "expect": "M-F-R4-008: clearance grants no new 72-hour window",
    },
    {
        "id": "M-F-R4-009", "title": "elapsed numeric deadline fabricates a final missed judgment", "file": "contract.ts",
        "old": "} else if ((o.dueAt !== null && asOf > o.dueAt) || boundDecisions.some(d => d.effect === 'timeliness-overdue')) o.status = 'overdue';",
        "new": "} else if ((o.dueAt !== null && asOf > o.dueAt) || boundDecisions.some(d => d.effect === 'timeliness-overdue')) o.status = 'missed';",
        "case": "TEST-F-07 C32 LQ-03 numeric deadline boundaries remain pending then overdue and never auto-missed",
        "expect": "M-F-R4-009: elapsed time never fabricates a final nonperformance judgment",
    },
    {
        "id": "M-F-R4-010", "title": "issue-time comparison checks only the head and revision", "file": "contract.ts",
        "old": "    const currentVersions = record.selection === 'all-versions' ? l.versions : record.versions.map(v => l.versions.find(x => x.versionId === v.versionId));\n"
               "    if (currentVersions.length !== record.versions.length || currentVersions.some((v, i) => !v || digest(v) !== digest(record.versions[i])))\n"
               "      refuse('DisclosurePackageChanged');\n",
        "new": "",
        "case": "TEST-F-03 C19 a replaced original with unchanged head and revision refuses issuance",
        "expect": "M-F-R4-010: every packaged version is compared at issue time",
    },
]
MUTANTS += [
    {"id": "M-F-R5-001", "title": "keep sending a superseded no-breach conclusion", "file": "contract.ts",
     "old": "const retiredFollowup = o.family === 'no-leak' && current &&", "new": "const retiredFollowup = false && current &&",
     "case": "TEST-F-07 R5-I01 LQ-06 later effective verdict retires only unsent no-breach follow-ups",
     "expect": "M-F-R5-001: a replaced no-breach conclusion is never an immediate send instruction"},
    {"id": "M-F-R5-002", "title": "an early no-breach result forever moots later possibility evidence", "file": "contract.ts",
     "old": "const changed = current && current.at >= o.triggeredAt && Date.parse(current.at) > causeEvidenceAt && current.status === 'not-a-leak' &&\n        NO_LEAK_CLOSURE_RULE.canMoot(current.at, o.originalDueAt) ? current : undefined;",
     "new": "const changed = effective.find(v => v.at >= o.triggeredAt && v.status === 'not-a-leak' && NO_LEAK_CLOSURE_RULE.canMoot(v.at, o.originalDueAt));",
     "case": "TEST-F-07 R5-I02 LQ-03 later possibility evidence revives the original clock",
     "expect": "M-F-R5-002: later possibility reopens its original deadline without a supersedes requirement"},
    {"id": "M-F-R5-003", "title": "replace an already performed possibility notice", "file": "contract.ts",
     "old": "        !satisfiesPossible(x, c.at) &&\n", "new": "",
     "case": "TEST-F-07 R5-I03 LQ-05 a performed possibility notice preserves the confirmed notice own deadline",
     "expect": "M-F-R5-003: a sent possibility notice is not replaced and cannot shorten confirmation clock"},
    {"id": "M-F-R5-004", "title": "repeat follow-up duties for the same conclusion and recipients", "file": "contract.ts",
     "old": "const root = consecutiveRoot(v, recipients);", "new": "const root = v;",
     "case": "TEST-F-07 R5-I04 LQ-06 consecutive same-conclusion verdicts need one follow-up per recipient",
     "expect": "M-F-R5-004: consecutive no-breach confirmations never duplicate recipient duties"},
    {"id": "M-F-R5-005", "title": "copy the privacy seventy-two-hour window to ISP reporting", "file": "contract.ts",
     "old": "ispHours: 24,", "new": "ispHours: 72,",
     "case": "TEST-F-07 R5 LQ-01 ISP initial report has its own twenty-four-hour clock and unknown is provisional",
     "expect": "M-F-R5-005: ISP reporting keeps its independent twenty-four-hour deadline"},
    {"id": "M-F-R5-006", "title": "unverified designation stops the clock", "file": "contract.ts",
     "old": "(d.status === 'verified-privacy-officer' || (d.status === 'representative' && !!d.exemptionEvidenceId))",
     "new": "(d.status === 'designationUnverified' || d.status === 'verified-privacy-officer' || (d.status === 'representative' && !!d.exemptionEvidenceId))",
     "case": "TEST-F-07 R5 LQ-02 accepted delays require clause category and verified owner authority",
     "expect": "M-F-R5-006: unverified designation never stops a clock"},
    {"id": "M-F-R5-007", "title": "an unverified report exemption closes the report", "file": "contract.ts",
     "old": "d.effect === 'report-exemption' && DELAY_RULE.decider(d.decider, owner.id)", "new": "d.effect === 'report-exemption'",
     "case": "TEST-F-07 R5 LQ-03 report exemption is separate and never closes subject or medical duties",
     "expect": "M-F-R5-007: unverified exemption cannot close a report"},
    {"id": "M-F-R5-008", "title": "one day of posting completes the duty", "file": "contract.ts",
     "old": "postingDays: 30,", "new": "postingDays: 1,",
     "case": "TEST-F-07 R5 LQ-03 COMMON posting needs cause scope content and thirty days of maintenance",
     "expect": "M-F-R5-008: a posting shorter than thirty days never completes the duty"},
    {"id": "M-F-R5-009", "title": "confirmed substitution ignores recipient and item coverage", "file": "contract.ts",
     "old": "        possibleFields.every(k => n.coveredFields?.includes(k))) : undefined;",
     "new": "        true) : undefined;",
     "case": "TEST-F-07 R5 LQ-05 substitution needs actual notice covering possibility recipients and items",
     "expect": "M-F-R5-009: substitution requires actual recipient and item coverage"},
    {"id": "M-F-R5-010", "title": "no-breach follow-up ignores the verdict recipient scope", "file": "contract.ts",
     "old": "for (const recipients of intersection(n.recipientScopeRef, v.scope))", "new": "for (const recipients of [n.recipientScopeRef])",
     "case": "TEST-F-07 R5 LQ-06 verdict intersection deduplicates overlapping notified scopes and warns on reverse sends",
     "expect": "M-F-R5-010: only actually notified recipients in the verdict scope receive one duty"},
    {"id": "M-F-R5-011", "title": "medical notice has no electronic-intrusion element", "file": "contract.ts",
     "old": "owner.kind !== 'processor' && v.medicalIncident?.electronicIntrusion", "new": "owner.kind !== 'processor' && v.medicalIncident",
     "case": "TEST-F-07 R5 LQ-04 COMMON medical duty requires intrusion and binds institutional knowledge and channel",
     "expect": "M-F-R5-011: medical notice requires the electronic-intrusion element"},
    {"id": "M-F-R5-012", "title": "apply the possibility-notice law before its effective date", "file": "contract.ts",
     "old": "possibleAt >= INCIDENT_COMMON_RULE.possibilityEffectiveFrom", "new": "true",
     "case": "TEST-F-07 R5 COMMON possibility effective date and health-data report trigger are independent",
     "expect": "M-F-R5-012: possibility knowledge before the effective date never creates the new statutory duty"},
    {"id": "M-F-R5-013", "title": "health-data leak requires an explicit report flag", "file": "contract.ts",
     "old": "...(v.healthDataActualLeak ? [INCIDENT_COMMON_RULE.healthLeakReportTrigger] : [])", "new": "...[]",
     "case": "TEST-F-07 R5 COMMON possibility effective date and health-data report trigger are independent",
     "expect": "M-F-R5-013: actual health-data leak automatically triggers the report"},
    {"id": "M-F-R5-014", "title": "hospital officer suspends the processor duty set", "file": "contract.ts",
     "old": "!!d && d.ownerId === ownerId &&", "new": "!!d &&",
     "case": "TEST-F-07 R5 COMMON processor clocks and decision authority are separate from hospital duties",
     "expect": "M-F-R5-014: hospital authority never suspends processor obligations"},
    {"id": "M-F-R5-015", "title": "unknown ISP applicability becomes legal overdue", "file": "contract.ts",
     "old": "if (o.applicability === 'unverified' && !retiredUserDuty) { o.status = 'unverified-pending';", "new": "if (false) { o.status = 'unverified-pending';",
     "case": "TEST-F-07 R5 LQ-01 ISP initial report has its own twenty-four-hour clock and unknown is provisional",
     "expect": "M-F-R5-015: unknown ISP applicability is provisional and never legal overdue"},
    {"id": "M-F-R5-016", "title": "initial ISP report removes its supplementary report duties", "file": "contract.ts",
     "old": "        if (!prior) continue;", "new": "        if (!prior || c.family === 'isp-supplement') continue;",
     "case": "TEST-F-07 R5 LQ-01 ISP supplement and affected-user notice survive initial report and no-breach verdict",
     "expect": "M-F-R5-016: every additionally confirmed fact retains its independent ISP supplement"},
    {"id": "M-F-R5-017", "title": "all data subjects implicitly cover every service user", "file": "contract.ts",
     "old": "const covers = (whole: string, part: string): boolean => whole === part ||",
     "new": "const covers = (whole: string, part: string): boolean => whole === 'incident-subjects' || whole === part ||",
     "case": "TEST-F-07 R5 LQ-01 ISP priority user notice and per-recipient deemed notice retain remaining duties",
     "expect": "M-F-R5-017: data-subject delivery never proves coverage of a different service-user population"},
]
MUTANTS += [
    {"id": "M-F-R6-001", "title": "create historical tasks without checking the law then in force", "file": "contract.ts",
     "old": "function ispLawAt(at: string) {\n", "new": "function ispLawAt(at: string) {\n  if (Date.parse(at) < Date.parse('2024-08-14T00:00:00+09:00')) return ISP.initialReport.legalBasisByKnowledgeDate.bands[1];\n",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2024-08-13 23:59 KST is display-only without exemption",
     "expect": "M-F-R6-001: historical knowledge creates no automatic report task"},
    {"id": "M-F-R6-002", "title": "erase the old-decree twenty-four-hour deadline", "file": "contract.ts",
     "old": "let originalDueAt = numericIsp ?", "new": "let originalDueAt = numericIsp && Date.parse(c.at) < Date.parse('2026-10-01T00:00:00+09:00') ? null : numericIsp ?",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2024-08-14 00:00 KST keeps its deadline and knowledge-date basis",
     "expect": "M-F-R6-002: old and new knowledge bands both retain continuous twenty-four hours"},
    {"id": "M-F-R6-003", "title": "select initial-report law by deadline date", "file": "contract.ts",
     "old": "const reportLaw = ['isp-report', 'isp-supplement'].includes(c.family) ? ispLawAt(c.at) : null;",
     "new": "const reportLaw = ['isp-report', 'isp-supplement'].includes(c.family) ? ispLawAt(new Date(Date.parse(c.at) + 86400000).toISOString()) : null;",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2026-09-30 23:59 KST keeps its deadline and knowledge-date basis",
     "expect": "M-F-R6-003: basis follows original knowledge even when due after cutover"},
    {"id": "M-F-R6-004", "title": "treat the midnight KST legal boundary as UTC", "file": "contract.ts",
     "old": "function ispLawAt(at: string) {\n", "new": "function ispLawAt(at: string) {\n  at = new Date(Date.parse(at) - 9 * 3600000).toISOString();\n",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2026-10-01 00:00 KST keeps its deadline and knowledge-date basis",
     "expect": "M-F-R6-004: the statute boundary is midnight KST"},
    {"id": "M-F-R6-005", "title": "use knowledge as the user-notice occurrence date", "file": "contract.ts",
     "old": "const occurredAt = starts[0], endedAt = ends[0]", "new": "const occurredAt = knowledgeAt, endedAt = ends[0]",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V3-N1 user notice selects occurrence independently of later knowledge",
     "expect": "M-F-R6-005: later knowledge never substitutes for the occurrence cutover"},
    {"id": "M-F-R6-006", "title": "auto-apply user notice to unclear occurrence", "file": "contract.ts",
     "old": ": 'decision-required' : definite ?", "new": ": 'applicable' : definite ?",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V3-N1 unclear or straddling occurrence requires a recorded decision",
     "expect": "M-F-R6-006: uncertainty never automatically creates or exempts the user notice"},
    {"id": "M-F-R6-007", "title": "deem an other-law supplement to close the ISP supplement", "file": "contract.ts",
     "old": "supplementDeemed: { policy: 'not-until-legal-basis-bound', kinds: [] as readonly string[] }",
     "new": "supplementDeemed: { policy: 'not-until-legal-basis-bound', kinds: ['pipc-kisa-additional'] as readonly string[] }",
     "case": "TEST-F-07 R6 LQ-03 D25V3-N2 supplements require actual reports after direct or deemed initial performance",
     "expect": "M-F-R6-007: other-law supplementary performance alone never closes an ISP supplement"},
    {"id": "M-F-R6-008", "title": "late supplements are permanently unperformed", "file": "contract.ts",
     "old": "if (fulfilled) o.status = 'met';", "new": "if (fulfilled && !(o.family === 'isp-supplement' && performedAt(fulfilled) > o.originalDueAt)) o.status = 'met';",
     "case": "TEST-F-07 R6 LQ-03 v5 late supplementary performance remains performed without retroactive timeliness",
     "expect": "M-F-R6-008: a late actual supplement is not permanently unperformed"},
    {"id": "M-F-R6-009", "title": "certify a late supplement as timely after performance", "file": "contract.ts",
     "old": "o.lateByMs = o.applicability === 'unverified'", "new": "o.lateByMs = o.family === 'isp-supplement' && fulfilled ? 0 : o.applicability === 'unverified'",
     "case": "TEST-F-07 R6 LQ-03 v5 late supplementary performance remains performed without retroactive timeliness",
     "expect": "M-F-R6-009: late performance is never retroactively certified as timely"},
    {"id": "M-F-R6-010", "title": "outage status excludes other-law notice deeming", "file": "contract.ts",
     "old": "? NO_LEAK_CLOSURE_RULE.deemedUserKinds.includes(n.kind) &&",
     "new": "? dutySources.find(c => c.family === o.family && c.eventId === o.triggerEventId).fact.ispIncident.userImpact.kind !== 'outage' && NO_LEAK_CLOSURE_RULE.deemedUserKinds.includes(n.kind) &&",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V3-N3 outage permits recipient deeming and otherwise needs direct notice",
     "expect": "M-F-R6-010: outage never excludes valid other-law user notice"},
    {"id": "M-F-R6-011", "title": "exclude posting as user-notice performance", "file": "contract.ts",
     "old": "const postingReady = (n: BoundNotice) => !n.posting || elapsed(n.sentAt, n.posting.maintainedThrough) >= NO_LEAK_CLOSURE_RULE.postingDays * 86400000;",
     "new": "const postingReady = (n: BoundNotice) => !n.posting || (n.kind !== 'isp-user-notice' && elapsed(n.sentAt, n.posting.maintainedThrough) >= NO_LEAK_CLOSURE_RULE.postingDays * 86400000);",
     "case": "TEST-F-07 R6 ISP-DUTIES D25V3-N3 outage permits reasoned thirty-day posting",
     "expect": "M-F-R6-011: outage permits a qualified thirty-day posting"},
    {"id": "M-F-R6-012", "title": "omit supplementary tasks during unverified applicability", "file": "contract.ts",
     "old": "        if (!prior) continue;", "new": "        if (!prior || (c.family === 'isp-supplement' && applicability === 'unknown')) continue;",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N4 unknown supplements retain each event on late true replay",
     "expect": "M-F-R6-012: unknown status retains provisional supplementary clocks after initial performance"},
    {"id": "M-F-R6-013", "title": "bulk-start supplementary deadlines from initial knowledge on verification", "file": "contract.ts",
     "old": "let originalDueAt = numericIsp ? new Date(Date.parse(c.at)",
     "new": "let originalDueAt = numericIsp ? new Date(Date.parse(c.family === 'isp-supplement' && applicability === true ? f.awarenessAt : c.at)",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N4 unknown supplements retain each event on late true replay",
     "expect": "M-F-R6-013: replay uses each supplementary event and its own law"},
    {"id": "M-F-R6-014", "title": "restart the initial-report deadline at verification", "file": "contract.ts",
     "old": "let originalDueAt = numericIsp ? new Date(Date.parse(c.at)",
     "new": "let originalDueAt = numericIsp ? new Date(Date.parse(c.family === 'isp-report' && applicability === true ? facts.filter(v => v.ispIncident?.verification).map(v => v.ispIncident.verification.at).sort().slice(-1)[0] : c.at)",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N4 unknown supplements retain each event on late true replay",
     "expect": "M-F-R6-014: verification never restarts the original report clock"},
    {"id": "M-F-R6-015", "title": "start user notice from initial knowledge instead of impact confirmation", "file": "contract.ts",
     "old": "family: 'isp-user', eventId: isp.eventId, at: isp.userImpact.confirmedAt,", "new": "family: 'isp-user', eventId: isp.eventId, at: v.awarenessAt,",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N4 user replay starts at impact confirmation and keeps elapsed time",
     "expect": "M-F-R6-015: user notice replays its impact confirmation event"},
    {"id": "M-F-R6-016", "title": "require both statutory ISP types cumulatively", "file": "contract.ts",
     "old": "types.telecomBusiness || types.forProfitTelecomInformation", "new": "types.telecomBusiness && types.forProfitTelecomInformation",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N5 operator types are alternatives and deployment is only a clue",
     "expect": "M-F-R6-016: either ISP type suffices and both may apply"},
    {"id": "M-F-R6-017", "title": "derive verified false from the on-prem label", "file": "contract.ts",
     "old": "return latest?.status ?? 'unknown';", "new": "return latest?.deploymentModel === 'on-prem' ? false : latest?.status ?? 'unknown';",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N5 operator types are alternatives and deployment is only a clue",
     "expect": "M-F-R6-017: deployment never overrides verified ISP applicability"},
    {"id": "M-F-R6-018", "title": "accept false without a verified non-applicability basis", "file": "contract.ts",
     "old": "if (isp.status === false) string(x.nonApplicabilityBasis);", "new": "",
     "case": "TEST-F-07 R6 INSTALL-FACTS D25V3-N5 false requires verified non-applicability evidence",
     "expect": "M-F-R6-018: false needs a verified non-applicability basis"},
    {"id": "M-F-R6-019", "title": "waive Annex 1 qualification for an appointed representative", "file": "contract.ts",
     "old": "(!d.qualificationRequired || !!d.qualificationEvidenceId)", "new": "true",
     "case": "TEST-F-07 R6 INSTALL-FACTS I-6 verified designation includes category and Annex 1 qualifications",
     "expect": "M-F-R6-019: representative status alone never waives Annex 1 qualifications"},
]
# The exact round-1 selection including repair round 6, authored as requirements (never generated from a run). The
# baseline must collect exactly these cases, each once, all passing; R2 moves the declaration into emr/units/f.json.
MUTANTS += [
    {"id": "M-F-R7-001", "title": "discard pre-cutover user notice causes", "file": "contract.ts",
     "old": "if (isp.userImpact) causes.push({ family: 'isp-user',",
     "new": "if (isp.userImpact && ispAssessments.find(x => x.eventId === isp.eventId)?.userNotice.applicability !== 'not-applicable') causes.push({ family: 'isp-user',",
     "case": "TEST-F-07 R7-I01 voluntary pre-cutover user notice is preserved without a duty",
     "expect": "M-F-R7-001: voluntary pre-cutover notice remains admissible evidence"},
    {"id": "M-F-R7-002", "title": "discard user notices before an applicability decision", "file": "contract.ts",
     "old": "if (isp.userImpact) causes.push({ family: 'isp-user',",
     "new": "if (isp.userImpact && ispAssessments.find(x => x.eventId === isp.eventId)?.userNotice.applicability !== 'decision-required') causes.push({ family: 'isp-user',",
     "case": "TEST-F-07 R7-I02 user notice before an applicability decision replays after the decision",
     "expect": "M-F-R7-002: a notice before the applicability decision is preserved"},
    {"id": "M-F-R7-003", "title": "reject prior user delivery after an inapplicability decision", "file": "contract.ts",
     "old": "const notices: BoundNotice[] = merge(parsedNotices, n => n.noticeId,",
     "new": "if (ispAssessments.some(a => a.userNotice.applicability === 'not-applicable') && parsedNotices.some(n => n.kind === 'isp-user-notice')) throw new Error('Rejected actual delivery');\n    const notices: BoundNotice[] = merge(parsedNotices, n => n.noticeId,",
     "case": "TEST-F-07 R7-I03 true to false applicability re-decision preserves sent user notice",
     "expect": "M-F-R7-003: a negative re-decision never invalidates a prior actual notice"},
    {"id": "M-F-R7-004", "title": "give the ISP operator the processor privacy duties", "file": "contract.ts",
     "old": "if (owner.kind === 'operator' && !isIsp) continue;", "new": "",
     "case": "TEST-F-07 R7-I04 operator causes are ISP-only while processor privacy duties remain separate",
     "expect": "M-F-R7-004: operator owns only the ISP duty structure"},
    {"id": "M-F-R7-005", "title": "show an applicable deadline for a verified non-ISP", "file": "contract.ts",
     "old": "initialReport: { dueAt: status === true ? reportDueAt : null,",
     "new": "initialReport: { dueAt: status !== 'unknown' ? reportDueAt : null,",
     "case": "TEST-F-07 R7-I05 verified non-ISP assessment has no applicable report deadline",
     "expect": "M-F-R7-005: verified non-ISP assessment has no due date"},
    {"id": "M-F-R7-006", "title": "label an unknown ISP assessment as verified", "file": "contract.ts",
     "old": "applicability: status === true ? 'verified' : status === false ? 'not-applicable' : 'unverified',",
     "new": "applicability: status !== false ? 'verified' : 'not-applicable',",
     "case": "TEST-F-07 R7-I06 unknown ISP assessment labels its original deadline provisional",
     "expect": "M-F-R7-006: unknown assessment exposes a provisional deadline only"},
    {"id": "M-F-R7-007", "title": "refuse evidence until the officer decides in the same call", "file": "contract.ts",
     "old": "const needsRedecision = !uncertain && !!latest && latest.applies !== definite;",
     "new": "const needsRedecision = !uncertain && !!latest && latest.applies !== definite;\n      if (needsRedecision) throw new Error('Decision contradicts occurrence evidence');",
     "case": "TEST-F-07 R7-I07 contradictory occurrence evidence is accepted pending a reasoned re-decision",
     "expect": "M-F-R7-007: contradictory occurrence evidence is accepted before re-decision"},
    {"id": "M-F-R7-008", "title": "discard supplementary delivery when no user duty applies", "file": "contract.ts",
     "old": "if (isp.userImpact) causes.push({ family: 'isp-user-additional',",
     "new": "if (isp.userImpact && ispUserApplicable(isp.eventId)) causes.push({ family: 'isp-user-additional',",
     "case": "TEST-F-07 R7-I08 supplementary user notices persist outside applicable duties",
     "expect": "M-F-R7-008: supplementary user delivery remains evidence without applicability"},
]

MUTANTS += [
    {"id": "M-F-R8-001", "title": "let a negative decision hide definite post-cutover evidence", "file": "contract.ts",
     "old": "applicable: definite || !!latest?.applies,", "new": "applicable: !!latest?.applies,",
     "case": "TEST-F-07 R8-I01 definite evidence derives the owed duty despite a negative decision",
     "expect": "M-F-R8-001: definite occurrence independently derives an owed user duty"},
    {"id": "M-F-R8-002", "title": "hide the positive-decision duty pending re-decision", "file": "contract.ts",
     "old": "if (applicability === false) continue;",
     "new": "if (applicability === false) continue;\n      if (c.family === 'isp-user' && ispAssessments.find(a => a.eventId === c.fact.ispIncident.eventId)?.userNotice.applicability === 're-decision-required') continue;",
     "case": "TEST-F-07 R8-I01 a positive decision keeps the pending duty despite pre-cutover evidence",
     "expect": "M-F-R8-002: the effective positive decision keeps the duty owed until re-decision"},
    {"id": "M-F-R8-003", "title": "erase duties after a negative re-decision", "file": "contract.ts",
     "old": "!ispUserPreviouslyApplicable(c.fact.ispIncident.eventId, c.at) &&\n          !previous?.obligations.some(o => o.obligationKey === key(c.family, c.eventId, c.recipients))) continue;", "new": "true) continue;",
     "case": "TEST-F-07 R8-I02 negative re-decision retains unmet history as moot and later applicability reopens it",
     "expect": "M-F-R8-003: an effective negative decision never deletes the historical duty"},
    {"id": "M-F-R8-004", "title": "replace performed duties with moot after re-decision", "file": "contract.ts",
     "old": "if (fulfilled) o.status = 'met';", "new": "if (fulfilled) o.status = retiredUserDuty ? 'moot' : 'met';",
     "case": "TEST-F-07 R8-I03 met user duties remain met through contrary evidence and effective re-decision",
     "expect": "M-F-R8-004: performed user duty stays met after re-decision"},
    {"id": "M-F-R8-005", "title": "restart the user clock at the re-decision observation", "file": "contract.ts",
     "old": "family: 'isp-user', eventId: isp.eventId, at: isp.userImpact.confirmedAt,",
     "new": "family: 'isp-user', eventId: isp.eventId, at: asOf,",
     "case": "TEST-F-07 R8-I01 definite evidence derives the owed duty despite a negative decision",
     "expect": "M-F-R8-005: re-decision retains the original clock and actual elapsed time"},
    {"id": "M-F-R8-006", "title": "hide the applicability contradiction on the owed duty", "file": "contract.ts",
     "old": "o.reasonCode = assessment.userNotice.reasonCode;", "new": "o.reasonCode = null;",
     "case": "TEST-F-07 R8-I01 definite evidence derives the owed duty despite a negative decision",
     "expect": "M-F-R8-006: owed duty carries the contradiction reason and decision references"},
    {"id": "M-F-R8-007", "title": "reject the operator plan carrying other-law evidence", "file": "contract.ts",
     "old": "!operatorEvidence(n) && !dutySources.some", "new": "true && !dutySources.some",
     "case": "TEST-F-07 R8-I04 operator other-law reports remain evidence until actual ISP reporting",
     "expect": "M-F-R8-007: operator other-law delivery binds as evidence without a privacy duty"},
    {"id": "M-F-R8-008", "title": "automatically deem the operator initial report from other-law evidence", "file": "contract.ts",
     "old": "const deemed = notices.filter(n => owner.kind !== 'operator' &&",
     "new": "const deemed = notices.filter(n => (owner.kind !== 'operator' || o.family === 'isp-report') &&",
     "case": "TEST-F-07 R8-I04 operator other-law reports remain evidence until actual ISP reporting",
     "expect": "M-F-R8-008: operator other-law reports cannot fulfill the ISP initial report"},
    {"id": "M-F-R8-009", "title": "automatically deem the operator user notice from other-law evidence", "file": "contract.ts",
     "old": "const deemed = notices.filter(n => owner.kind !== 'operator' &&",
     "new": "const deemed = notices.filter(n => (owner.kind !== 'operator' || o.family === 'isp-user') &&",
     "case": "TEST-F-07 R8-I04 operator other-law user notices remain evidence despite matching recipients and content",
     "expect": "M-F-R8-009: operator other-law notices cannot fulfill the ISP user duty"},
    {"id": "M-F-R8-010", "title": "apply a retired positive decision to newly arising user duties", "file": "contract.ts",
     "old": "d.applies && (!all[i + 1] || all[i + 1].at > at)", "new": "d.applies",
     "case": "TEST-F-07 R8-I02 supplementary duty history ends at the effective negative decision interval",
     "expect": "M-F-R8-010: a retired applicability interval cannot create later supplementary duties"},
    {"id": "M-F-R8-011", "title": "keep the duty owed after an effective negative re-decision", "file": "contract.ts",
     "old": "else if (retiredUserDuty) o.status = 'moot';", "new": "else if (retiredUserDuty) o.status = 'pending';",
     "case": "TEST-F-07 R8-I02 negative re-decision retains unmet history as moot and later applicability reopens it",
     "expect": "M-F-R8-011: a negative re-decision moots the unmet duty with its reference"},
]

# D839 replaces R8-I04's over-claim; the old mutant IDs remain bound to their corrected acceptance contract.
MUTANTS += [
    {"id": "M-F-R9-001", "title": "use the hospital MOHW notice as the operator ISP performance", "file": "contract.ts",
     "old": "const deemed = notices.filter(n => owner.kind !== 'operator' &&",
     "new": "const deemed = notices.filter(n => (owner.kind !== 'operator' || n.kind === 'mohw-notice') &&",
     "case": "TEST-F-07 R9-I01 CE16 hospital MOHW evidence cannot fulfill the operator ISP report",
     "expect": "M-F-R9-001: hospital MOHW notice is never operator ISP performance"},
    {"id": "M-F-R9-002", "title": "use an unattributed PIPC KISA report as operator ISP performance", "file": "contract.ts",
     "old": "const deemed = notices.filter(n => owner.kind !== 'operator' &&",
     "new": "const deemed = notices.filter(n => (owner.kind !== 'operator' || n.kind === 'pipc-kisa-report') &&",
     "case": "TEST-F-07 R9-I01 CE11a unattributed PIPC KISA reports are evidence only for the operator",
     "expect": "M-F-R9-002: unattributed PIPC KISA evidence cannot discharge operator reporting"},
    {"id": "M-F-R9-003", "title": "overlay an unknown ISP retired duty with unverified pending", "file": "contract.ts",
     "old": "if (o.applicability === 'unverified' && !retiredUserDuty) {",
     "new": "if (o.applicability === 'unverified') {",
     "case": "TEST-F-07 R9-I02 CE15 a negative re-decision closes unknown ISP user duties",
     "expect": "M-F-R9-003: an unknown ISP retired user duty is moot and not owed"},
    {"id": "M-F-R9-004", "title": "reject corrected occurrence times as conflicting evidence", "file": "contract.ts",
     "old": "const effectiveOccurrences = occurrences.filter(o => !occurrences.some(x => x.correction?.supersedes === o.evidenceId));",
     "new": "const effectiveOccurrences = occurrences;",
     "case": "TEST-F-07 R9-I03 CE18 occurrence correction retires the unsent duty with evidence history",
     "expect": "M-F-R9-004: a reasoned occurrence correction is recordable"},
    {"id": "M-F-R9-005", "title": "erase the duty historically derived from a corrected occurrence", "file": "contract.ts",
     "old": "rule?.occurrences.some(o => o.occurredAt !== null", "new": "false && rule?.occurrences.some(o => o.occurredAt !== null",
     "case": "TEST-F-07 R9-I03 CE18 occurrence correction retires the unsent duty with evidence history",
     "expect": "M-F-R9-005: occurrence correction retains the historical user duty"},
    {"id": "M-F-R9-006", "title": "keep a superseded definite post-cutover occurrence applicable", "file": "contract.ts",
     "old": "const definite = !!occurredAt && Date.parse(occurredAt) >= cutover;",
     "new": "const definite = (!!occurredAt && Date.parse(occurredAt) >= cutover) || occurrences.some(o => o.occurredAt && Date.parse(o.occurredAt) >= cutover);",
     "case": "TEST-F-07 R9-I03 CE12 effective occurrence correction resolves repeated negative decisions",
     "expect": "M-F-R9-006: superseded post-cutover evidence no longer forces applicability"},
    {"id": "M-F-R9-007", "title": "discard superseded occurrence findings from the ledger", "file": "contract.ts",
     "old": "ledger: { findings, notices, noticeAttributions, delays, decisions }, obligations",
     "new": "ledger: { findings: findings.filter(v => !v.facts.ispIncident?.occurrence || !findings.some(n => n.facts.ispIncident?.eventId === v.facts.ispIncident.eventId && n.facts.ispIncident?.occurrence?.correction?.supersedes === v.facts.ispIncident.occurrence.evidenceId)), notices, noticeAttributions, delays, decisions }, obligations",
     "case": "TEST-F-07 R9-I03 CE18 occurrence correction retires the unsent duty with evidence history",
     "expect": "M-F-R9-007: superseded occurrence findings remain in the evidence ledger"},
    {"id": "M-F-R9-008", "title": "accept an occurrence correction without a reason", "file": "contract.ts",
     "old": "string(c.supersedes); string(c.reason); string(c.evidenceId);",
     "new": "string(c.supersedes); string(c.evidenceId);",
     "case": "TEST-F-07 R9-I03 invalid occurrence corrections refuse atomically without losing prior evidence",
     "expect": "M-F-R9-008: occurrence correction needs a recorded reason"},
    {"id": "M-F-R9-009", "title": "accept branching occurrence corrections", "file": "contract.ts",
     "old": "occurrences.some(x => x.evidenceId !== o.evidenceId && x.correction?.supersedes === old.evidenceId)", "new": "false",
     "case": "TEST-F-07 R9-I03 invalid occurrence corrections refuse atomically without losing prior evidence",
     "expect": "M-F-R9-009: two corrections cannot supersede the same occurrence"},
    {"id": "M-F-R9-010", "title": "use operator other-law report as the initial supplementary report prerequisite", "file": "contract.ts",
     "old": "(owner.kind !== 'operator' && NO_LEAK_CLOSURE_RULE.deemedReportKinds.includes(n.kind)",
     "new": "(NO_LEAK_CLOSURE_RULE.deemedReportKinds.includes(n.kind)",
     "case": "TEST-F-07 R9-I01 operator other-law evidence cannot stand in for initial ISP performance",
     "expect": "M-F-R9-010: other-law report is not the operator initial ISP report"},
    {"id": "M-F-R9-011", "title": "use operator other-law notice as the initial supplementary user notice prerequisite", "file": "contract.ts",
     "old": "(owner.kind !== 'operator' && ['possible-leak', 'confirmed-leak', 'confirmed-priority'].includes(n.kind))",
     "new": "(['possible-leak', 'confirmed-leak', 'confirmed-priority'].includes(n.kind))",
     "case": "TEST-F-07 R9-I01 operator other-law evidence cannot stand in for initial ISP performance",
     "expect": "M-F-R9-011: other-law user notice is not the operator initial ISP notice"},
    {"id": "M-F-R9-012", "title": "omit the occurrence correction reference on a retired duty", "file": "contract.ts",
     "old": "o.replacedBy = rule.retirement.ref;", "new": "o.replacedBy = null;",
     "case": "TEST-F-07 R9-I03 CE18 occurrence correction retires the unsent duty with evidence history",
     "expect": "M-F-R9-012: corrected closure identifies its occurrence evidence"},
]

DECLARED_CASES = [
    "TEST-F-07 R9-I01 CE16 hospital MOHW evidence cannot fulfill the operator ISP report",
    "TEST-F-07 R9-I01 CE11a unattributed PIPC KISA reports are evidence only for the operator",
    "TEST-F-07 R9-I01 operator other-law evidence cannot stand in for initial ISP performance",
    "TEST-F-07 R9-I02 CE15 a negative re-decision closes unknown ISP user duties",
    "TEST-F-07 R9-I03 CE18 occurrence correction retires the unsent duty with evidence history",
    "TEST-F-07 R9-I03 CE12 effective occurrence correction resolves repeated negative decisions",
    "TEST-F-07 R9-I03 occurrence correction preserves actual notices and ends the old supplement interval",
    "TEST-F-07 R9-I03 invalid occurrence corrections refuse atomically without losing prior evidence",
    "TEST-F-07 R9-I03 chained occurrence corrections replay independently of intake order",
    "TEST-F-07 R8-I01 definite evidence derives the owed duty despite a negative decision",
    "TEST-F-07 R8-I01 a positive decision keeps the pending duty despite pre-cutover evidence",
    "TEST-F-07 R8-I02 negative re-decision retains unmet history as moot and later applicability reopens it",
    "TEST-F-07 R8-I03 met user duties remain met through contrary evidence and effective re-decision",
    "TEST-F-07 R8-I02 supplementary duty history ends at the effective negative decision interval",
    "TEST-F-07 R8-I04 operator other-law reports remain evidence until actual ISP reporting",
    "TEST-F-07 R8-I04 operator other-law user notices remain evidence despite matching recipients and content",
    "TEST-F-07 R8-I04 operator evidence never creates privacy medical or no-breach follow-up duties",
    "TEST-F-07 R8-I04 invalid operator notice binding refuses atomically while actual evidence replays",
    "TEST-F-01 roster_scope: a designated auditor gets exactly the granted scopes and a general admin without a grant gets none",
    "TEST-F-01 roster_scope: a revoked, expired, not-yet-valid or moved auditor gets no authority and nothing is read",
    "TEST-F-01 roster_scope: client claims of auditor status, roles or institution are refused and the scope is the grant institution",
    "TEST-F-01 roster_scope: only the institution events are counted, paged and exported and other institutions add nothing",
    "TEST-F-01 roster_scope: every grant change is rights history kept three years on its own clock apart from the access ledger",
    "TEST-F-02 patient_replay: replay keeps each event recorded patient, institutions, version and times after a re-match",
    "TEST-F-02 patient_replay: the new patient finds only its own recorded events and a multi-target event shows only the investigated patient",
    "TEST-F-02 patient_replay: a stored event whose patient or version was rewritten fails its chain hash and nothing is shown",
    "TEST-F-02 patient_replay: refused, aborted and conflict events are replayed as such and filtered by action, result and address",
    "TEST-F-02 patient_replay: a source failure, misordered or out-of-snapshot row is an error and never an empty or short result",
    "TEST-F-02 patient_replay: a sealed cursor continues the same snapshot without duplicates or gaps and another plan, auditor or forged cursor is refused",
    "TEST-F-02 patient_replay: the investigation is itself an access event for exactly the rows shown and an export is a download",
    "TEST-F-03 lawful_issue: a patient own request prepares every version with the verification material of each signed version",
    "TEST-F-03 lawful_issue: a military manpower request is judged by the wording in force when it arrived",
    "TEST-F-03 lawful_issue: family, agent and statutory requests need their own qualification evidence and anything missing is refused before any package",
    "TEST-F-03 lawful_issue: the default is the whole record and a requester-specified part stays exact while incomplete or foreign listings are refused",
    "TEST-F-03 lawful_issue: a record head that moved after preparation refuses issuance and nothing is issued",
    "TEST-F-03 lawful_issue: the disclosure ledger event built from the package is a valid A event on the authorized-disclosure surface",
    "TEST-F-04 issuance_result: Issued needs server bytes bound to the manifest and a designated issuer while a print window or client PDF never issues",
    "TEST-F-04 issuance_result: Delivered needs real handover or receipt evidence while an unknown outcome is ReceiptUnknown and a failure is DeliveryFailed",
    "TEST-F-04 issuance_result: a paper handover is the staff attestation and not a detection and synthetic recipients never count as operational",
    "TEST-F-04 issuance_result: Closed only after a delivery outcome with a reason when not delivered and abort only before issue on an append-only history",
    "TEST-F-05 followup: an automatically generated monthly report is not an inspection and a designated reviewer completes it",
    "TEST-F-05 followup: every download of the month needs a confirmed reason before closing",
    "TEST-F-05 followup: an investigation closes only with a recorded action and a passing recheck by designated people",
    "TEST-F-05 followup: the inspection period stays the Seoul calendar month before and after 2026-11-01",
    "TEST-F-06 extended_request_hold: a lawfully extended pending request keeps its hold after the old until and the old until releases nothing",
    "TEST-F-06 extended_request_hold: the extension moves the request due and the hold validity together and keeps the earlier due and validity as history",
    "TEST-F-06 extended_request_hold: a release binds only to the same request verified resolution and A accepts it on reload",
    "TEST-F-06 extended_request_hold: an untimely, backward or unbound extension is refused and a due never becomes unlimited",
    "TEST-F-07 incident_scope: an incident query names the patients whose records were provided for the period and address and nothing for refused attempts",
    "TEST-F-07 incident_scope: a ledger that cannot be read or verified is reported as subjects not identifiable and never as nobody affected",
    "TEST-F-08 rights_request: deletion or suspension of a record the law keeps is refused with reason and objection notice while purpose data is acted on",
    "TEST-F-08 rights_request: a correction is a new signed version that keeps the original and an access event is never edited and the request binds its own patient",
    "TEST-F-02 patient_replay: change and view streams keep independent snapshots and cursors and neither stream may silently disappear",
    "TEST-F-06 extended_request_hold: a reloaded release needs its own verified resolution and institution and cannot end preservation early",
    "TEST-F-05 followup: every new action needs a later recheck before closing including actions at the same time",
    "TEST-F-07 incident_scope: possible leak notice covers all possibly affected subjects within 72 hours and an unknown population is never zero",
    "TEST-F-07 incident_scope: confirmed priority and additional notices and PIPC or KISA reports have separate deadlines and required fields",
    "TEST-F-07 incident_scope: not-a-leak follow-up and immediate MOHW notice remain distinct and a template is never sent evidence",
    "TEST-F-07 incident_scope: a late no-breach verdict retains the overdue possibility obligation and actual notices",
    "TEST-F-07 incident_scope: a no-breach verdict before the deadline makes the obligation moot without erasing it",
    "TEST-F-07 incident_scope: met notices and prior confirmed obligations remain bound across a later verdict",
    "TEST-F-07 incident_scope: stored bound possibility notice automatically requires no-breach follow-up without an input flag",
    "TEST-F-07 incident_scope: contradictory prior notice assertions refuse without producing or changing a plan",
    "TEST-F-07 incident_scope: no bound notice leaves the no-breach path without a follow-up obligation",
    "TEST-F-05 followup: a null inspection step gives a typed refusal and leaves the cycle unchanged",
    "TEST-F-05 followup: a new anomaly after a resolved investigation needs its own action and recheck",
    "TEST-F-05 followup: reopening a resolved finding creates a new investigation and cannot relabel the old resolution",
    "TEST-F-05 followup: each finding attached to an open investigation needs a subsequent action and recheck",
    "TEST-F-03 lawful_issue: signature record id must equal the stored fixed version",
    "TEST-F-03 lawful_issue: signature version id must equal the stored fixed version",
    "TEST-F-03 lawful_issue: signature content hash must equal the stored fixed version",
    "TEST-F-03 lawful_issue: signature signed-at time must equal the stored fixed version",
    "TEST-F-03 lawful_issue: signature predecessor hash must equal the stored fixed version",
    "TEST-F-07 C10 late notice fulfills the duty and triggers follow-up with actual elapsed and lateness",
    "TEST-F-07 C06 unpaid priority notice and regulator report retain their causes after a late no-leak verdict",
    "TEST-F-05 C08 a benign later review cannot close an unresolved finding",
    "TEST-F-07 C11 new notice and no-leak verdict create the follow-up in the same call",
    "TEST-F-07 C12 matching simultaneous assertion and null current possibility ground are accepted",
    "TEST-F-07 C20 LQ-01 no-leak follow-up sent thirty minutes later is met with no numeric legal deadline",
    "TEST-F-07 C21 LQ-04 medical notice preserves occurrence and discovery elapsed times",
    "TEST-F-07 C22 LQ-04 medical notice at coincident occurrence and discovery has zero elapsed",
    "TEST-F-07 C23 C24 LQ-01 additional subject notice and regulator report fulfill independent immediate duties",
    "TEST-F-07 C25 LQ-01 every immediate family stays owed as time advances without a decision",
    "TEST-F-07 C26 C29 batched split and late-received evidence replay to the same semantic projection",
    "TEST-F-07 C27 C28 first-call complete evidence permutations and exact retransmission yield one duty per cause",
    "TEST-F-07 C28 independent additional sources at the same time retain separate duties in either order",
    "TEST-F-07 C30 conflicting notice identity refuses atomically instead of overwriting delivery evidence",
    "TEST-F-07 C30 foreign future unknown-trigger and contradictory verdict evidence refuses atomically",
    "TEST-F-07 C30 a later explicit verdict correction preserves earlier duties and performance",
    "TEST-F-07 C32 LQ-03 numeric deadline boundaries remain pending then overdue and never auto-missed",
    "TEST-F-07 C33 C34 overdue observations allow late performance and late recording of timely performance",
    "TEST-F-07 C35 C36 LQ-03 only a pre-deadline no-leak determination moots an unnotified duty",
    "TEST-F-07 C37 C40 LQ-05 replacement and completeness preserve independent original clocks",
    "TEST-F-07 C38 LQ-02 accepted delay clearance and delivery stay on one duty and require follow-up",
    "TEST-F-07 C39 LQ-02 pending invalid and cleared delay claims preserve the applicable clock",
    "TEST-F-07 C37 LQ-05 confirmation during an accepted possibility delay inherits immediate performance on clearance",
    "TEST-F-07 C41 LQ-03 final judgments require evidence retain remaining duties and survive later performance",
    "TEST-F-07 C25 C41 LQ-01 immediate overdue needs an individual timing decision and keeps performance open",
    "TEST-F-07 C42 partial notices create recipient follow-ups although the whole duty remains overdue",
    "TEST-F-07 C48 LQ-06 reverse-order deliveries trigger follow-up for each newly notified scope",
    "TEST-F-05 C13 closed inspections reject new steps and replay with appended or inserted findings",
    "TEST-F-05 C14 a resolved recheck without its own action leaves a reopened finding open",
    "TEST-F-04 C15 Closed and Aborted issuances refuse every subsequent lifecycle operation",
    "TEST-F-06 C16 a resolved request and released hold cannot be extended or released again",
    "TEST-F-03 C07 C18 signed predecessor identity and hash must bind the stored predecessor",
    "TEST-F-03 C17 a stored predecessor hash mismatch refuses preparation and preserves the listing",
    "TEST-F-03 C19 a replaced original with unchanged head and revision refuses issuance",
    "TEST-F-03 C43 middle version id hash and predecessor changes each refuse an unchanged head package",
    "TEST-F-03 C44 changed signature envelope key and evidence references each refuse issuance",
    "TEST-F-03 C45 a changed middle version of the last record is checked in a multi-record package",
    "TEST-F-03 C46 requester-specified historical versions issue exactly that subset and reject its replacement",
    "TEST-F-03 C47 incomplete added duplicate reordered and unchanged version listings bind issuance precisely",
    "TEST-F-07 R5-I01 LQ-06 later effective verdict retires only unsent no-breach follow-ups",
    "TEST-F-07 R5-I02 LQ-03 later possibility evidence revives the original clock",
    "TEST-F-07 R5-I03 LQ-05 a performed possibility notice preserves the confirmed notice own deadline",
    "TEST-F-07 R5-I04 LQ-06 consecutive same-conclusion verdicts need one follow-up per recipient",
    "TEST-F-07 R5 LQ-06 verdict intersection deduplicates overlapping notified scopes and warns on reverse sends",
    "TEST-F-07 R5 LQ-05 substitution needs actual notice covering possibility recipients and items",
    "TEST-F-07 R5 LQ-02 accepted delays require clause category and verified owner authority",
    "TEST-F-07 R5 LQ-02 late causal evidence preserves observations and each clearance time",
    "TEST-F-07 R5 LQ-03 report exemption is separate and never closes subject or medical duties",
    "TEST-F-07 R5 LQ-03 COMMON posting needs cause scope content and thirty days of maintenance",
    "TEST-F-07 R5 LQ-04 COMMON medical duty requires intrusion and binds institutional knowledge and channel",
    "TEST-F-07 R5 COMMON possibility effective date and health-data report trigger are independent",
    "TEST-F-07 R5 COMMON processor clocks and decision authority are separate from hospital duties",
    "TEST-F-07 R5 LQ-01 ISP initial report has its own twenty-four-hour clock and unknown is provisional",
    "TEST-F-07 R5 LQ-01 ISP deemed report needs actual same-incident authority notice and content",
    "TEST-F-07 R5 LQ-01 ISP supplement and affected-user notice survive initial report and no-breach verdict",
    "TEST-F-07 R5 LQ-01 ISP priority user notice and per-recipient deemed notice retain remaining duties",
    "TEST-F-07 R5 LQ-05 multiple possibility causes retain the earliest deadline with proved recipient coverage",
    "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2024-08-13 23:59 KST is display-only without exemption",
    "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2024-08-14 00:00 KST keeps its deadline and knowledge-date basis",
    "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2026-09-30 23:59 KST keeps its deadline and knowledge-date basis",
    "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2026-10-01 00:00 KST keeps its deadline and knowledge-date basis",
    "TEST-F-07 R6 ISP-DUTIES D25V4-N1 2026-09-29 10:00 counterexample KST keeps its deadline and knowledge-date basis",
    "TEST-F-07 R6 ISP-DUTIES D25V3-N1 user notice selects occurrence independently of later knowledge",
    "TEST-F-07 R6 ISP-DUTIES D25V3-N1 unclear or straddling occurrence requires a recorded decision",
    "TEST-F-07 R6 LQ-03 D25V3-N2 supplements require actual reports after direct or deemed initial performance",
    "TEST-F-07 R6 LQ-03 v5 late supplementary performance remains performed without retroactive timeliness",
    "TEST-F-07 R6 ISP-DUTIES D25V3-N3 outage permits recipient deeming and otherwise needs direct notice",
    "TEST-F-07 R6 ISP-DUTIES D25V3-N3 outage permits reasoned thirty-day posting",
    "TEST-F-07 R6 INSTALL-FACTS D25V3-N4 unknown supplements retain each event on late true replay",
    "TEST-F-07 R6 INSTALL-FACTS D25V3-N4 user replay starts at impact confirmation and keeps elapsed time",
    "TEST-F-07 R6 INSTALL-FACTS D25V3-N5 operator types are alternatives and deployment is only a clue",
    "TEST-F-07 R6 INSTALL-FACTS D25V3-N5 false requires verified non-applicability evidence",
    "TEST-F-07 R6 INSTALL-FACTS I-6 verified designation includes category and Annex 1 qualifications",
    "TEST-F-07 R7-I01 voluntary pre-cutover user notice is preserved without a duty",
    "TEST-F-07 R7-I02 user notice before an applicability decision replays after the decision",
    "TEST-F-07 R7-I03 true to false applicability re-decision preserves sent user notice",
    "TEST-F-07 R7-I04 operator causes are ISP-only while processor privacy duties remain separate",
    "TEST-F-07 R7-I05 verified non-ISP assessment has no applicable report deadline",
    "TEST-F-07 R7-I06 unknown ISP assessment labels its original deadline provisional",
    "TEST-F-07 R7-I07 contradictory occurrence evidence is accepted pending a reasoned re-decision",
    "TEST-F-07 R7-I08 supplementary user notices persist outside applicable duties",
]
# D850: exact added cases and one injected defect for each new invariant.
MUTANTS += [{'id': 'M-F-R10-001',
  'title': 'D26 certainty is not a prediction flag',
  'file': 'contract.ts',
  'old': '"prediction": false,',
  'new': '"prediction": true,',
  'case': 'TEST-F-07 R10 D26-N1 C21 Q4 conservative interpretation and no automatic deeming',
  'expect': 'D26 no legislative prediction'},
 {'id': 'M-F-R10-002',
  'title': 'D26 attribution falsely closes ISP reporting',
  'file': 'contract.ts',
  'old': "if (fulfilled) o.status = 'met';",
  'new': "if (notices.some(n => n.operatorEvidence?.attributionComplete) && o.family === 'isp-report') { "
         "o.status = 'met'; }\n"
         "      else if (fulfilled) o.status = 'met';",
  'case': 'TEST-F-07 R10 D26-N1 C21 Q4 conservative interpretation and no automatic deeming',
  'expect': 'D26 complete attribution never closes the duty'},
 {'id': 'M-F-R10-003',
  'title': 'omit missing reporterEntity',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'reporterEntity' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing reporterEntity is recorded on evidence',
  'expect': 'D26 missing reporterEntity remains visible'},
 {'id': 'M-F-R10-004',
  'title': 'omit missing capacity',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'capacity' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing capacity is recorded on evidence',
  'expect': 'D26 missing capacity remains visible'},
 {'id': 'M-F-R10-005',
  'title': 'omit missing recipientAuthority',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'recipientAuthority' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing recipientAuthority is recorded on evidence',
  'expect': 'D26 missing recipientAuthority remains visible'},
 {'id': 'M-F-R10-006',
  'title': 'omit missing incidentIdentity',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'incidentIdentity' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing incidentIdentity is recorded on evidence',
  'expect': 'D26 missing incidentIdentity remains visible'},
 {'id': 'M-F-R10-007',
  'title': 'omit missing coveredItems',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'coveredItems' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing coveredItems is recorded on evidence',
  'expect': 'D26 missing coveredItems remains visible'},
 {'id': 'M-F-R10-008',
  'title': 'omit missing performedAt',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'performedAt' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing performedAt is recorded on evidence',
  'expect': 'D26 missing performedAt remains visible'},
 {'id': 'M-F-R10-009',
  'title': 'omit missing legalBasisRef',
  'file': 'contract.ts',
  'old': 'attributionFields.filter(k => a?.[k] === undefined)',
  'new': "attributionFields.filter(k => k !== 'legalBasisRef' && a?.[k] === undefined)",
  'case': 'TEST-F-07 R10 D26-N3 missing legalBasisRef is recorded on evidence',
  'expect': 'D26 missing legalBasisRef remains visible'},
 {'id': 'M-F-R10-010',
  'title': 'trust invalid reporterEntity',
  'file': 'contract.ts',
  'old': 'if (!missingFields.includes(field) && !ok) invalidFields.push(field);',
  'new': "if (field !== 'reporterEntity' && !missingFields.includes(field) && !ok) "
         'invalidFields.push(field);',
  'case': 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and '
          'basis',
  'expect': 'D26 invalid reporterEntity is not attributed'},
 {'id': 'M-F-R10-011',
  'title': 'trust invalid capacity',
  'file': 'contract.ts',
  'old': 'if (!missingFields.includes(field) && !ok) invalidFields.push(field);',
  'new': "if (field !== 'capacity' && !missingFields.includes(field) && !ok) invalidFields.push(field);",
  'case': 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and '
          'basis',
  'expect': 'D26 invalid capacity is not attributed'},
 {'id': 'M-F-R10-012',
  'title': 'trust invalid recipientAuthority',
  'file': 'contract.ts',
  'old': 'if (!missingFields.includes(field) && !ok) invalidFields.push(field);',
  'new': "if (field !== 'recipientAuthority' && !missingFields.includes(field) && !ok) "
         'invalidFields.push(field);',
  'case': 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and '
          'basis',
  'expect': 'D26 invalid recipientAuthority is not attributed'},
 {'id': 'M-F-R10-013',
  'title': 'trust invalid incidentIdentity',
  'file': 'contract.ts',
  'old': 'if (!missingFields.includes(field) && !ok) invalidFields.push(field);',
  'new': "if (field !== 'incidentIdentity' && !missingFields.includes(field) && !ok) "
         'invalidFields.push(field);',
  'case': 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and '
          'basis',
  'expect': 'D26 invalid incidentIdentity is not attributed'},
 {'id': 'M-F-R10-014',
  'title': 'trust invalid coveredItems',
  'file': 'contract.ts',
  'old': 'if (!missingFields.includes(field) && !ok) invalidFields.push(field);',
  'new': "if (field !== 'coveredItems' && !missingFields.includes(field) && !ok) invalidFields.push(field);",
  'case': 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and '
          'basis',
  'expect': 'D26 invalid coveredItems is not attributed'},
 {'id': 'M-F-R10-015',
  'title': 'trust invalid legalBasisRef',
  'file': 'contract.ts',
  'old': 'if (!missingFields.includes(field) && !ok) invalidFields.push(field);',
  'new': "if (field !== 'legalBasisRef' && !missingFields.includes(field) && !ok) invalidFields.push(field);",
  'case': 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and '
          'basis',
  'expect': 'D26 invalid legalBasisRef is not attributed'},
 {'id': 'M-F-R10-016',
  'title': 'omit possibility notice basis',
  'file': 'contract.ts',
  'old': "['P26⑧→P34①+PD39', 'P26⑧→P34②+PD39의2·39의3'].includes(a?.legalBasisRef?.basis)",
  'new': "['P26⑧→P34①+PD39'].includes(a?.legalBasisRef?.basis)",
  'case': 'TEST-F-07 R10 D26-N3 C12 user legalBasisRef alternatives and service-user intersections',
  'expect': 'D26 both user-notice legal paths are accepted'},
 {'id': 'M-F-R10-017',
  'title': 'merge patients with service users',
  'file': 'contract.ts',
  'old': 'delivered.includes(id) && serviceUsers.includes(id)',
  'new': 'delivered.includes(id)',
  'case': 'TEST-F-07 R10 D26-N3 C12 user legalBasisRef alternatives and service-user intersections',
  'expect': 'D26 non-users never join the user intersection'},
 {'id': 'M-F-R10-018',
  'title': 'replace original performance time during completion',
  'file': 'contract.ts',
  'old': 'if (a.performedAt !== undefined && utc(a.performedAt) !== n.sentAt)',
  'new': 'if (false && a.performedAt !== undefined && utc(a.performedAt) !== n.sentAt)',
  'case': 'TEST-F-07 R10 D26 C20 attribution completion preserves all original times and immutable evidence '
          'history',
  'expect': 'D26 attribution cannot rewrite performance time'},
 {'id': 'M-F-R10-019',
  'title': 'discard superseded attribution history',
  'file': 'contract.ts',
  'old': 'missingFields, invalidFields, attributionHistory, eligibleRecipientIds,',
  'new': 'missingFields, invalidFields, attributionHistory: latest, eligibleRecipientIds,',
  'case': 'TEST-F-07 R10 D26 C20 attribution completion preserves all original times and immutable evidence '
          'history',
  'expect': 'D26 attribution history is append-only'},
 {'id': 'M-F-R10-020',
  'title': 'complete all users from a partial notice',
  'file': 'contract.ts',
  'old': 'if (required?.length && required.every(id => reached.has(id))) return n;',
  'new': 'if (required?.length && required.some(id => reached.has(id))) return n;',
  'case': 'TEST-F-07 R10 D26 C12 C14 C18 partial direct user delivery retains other users and delay judgment',
  'expect': 'D26 partial notice never closes other users'},
 {'id': 'M-F-R10-021',
  'title': 'hide the officer action prompt',
  'file': 'contract.ts',
  'old': "operatorEvidencePrompt: owner.kind === 'operator' && notices.some(n => n.operatorEvidence)",
  'new': "operatorEvidencePrompt: false && owner.kind === 'operator' && notices.some(n => "
         'n.operatorEvidence)',
  'case': 'TEST-F-07 R10 D26 C22 C23 direct report receipt needs no duplicate PIPA attribution and prompt is '
          'officer only',
  'expect': 'D26 prompt is privacy-officer only'},
 {'id': 'M-F-R10-022',
  'title': 'CE21 erases an observed duty after a backdated correction',
  'file': 'contract.ts',
  'old': '!previous?.obligations.some(o => o.obligationKey === key(c.family, c.eventId, c.recipients))',
  'new': 'true',
  'case': 'TEST-F-07 R10 R9-I04 CE21 earlier-effective correction retains observed moot history',
  'expect': 'R9-I04 CE21 observed duty never disappears'},
 {'id': 'M-F-R10-023',
  'title': 'CE21b erases an observed duty after a backdated correction',
  'file': 'contract.ts',
  'old': '!previous?.obligations.some(o => o.obligationKey === key(c.family, c.eventId, c.recipients))',
  'new': 'true',
  'case': 'TEST-F-07 R10 R9-I04 CE21b earlier-effective correction retains observed moot history',
  'expect': 'R9-I04 CE21b observed duty never disappears'}]
DECLARED_CASES += ['TEST-F-07 R10 D26-N1 C21 Q4 conservative interpretation and no automatic deeming',
 'TEST-F-07 R10 D26-N3 missing reporterEntity is recorded on evidence',
 'TEST-F-07 R10 D26-N3 missing capacity is recorded on evidence',
 'TEST-F-07 R10 D26-N3 missing recipientAuthority is recorded on evidence',
 'TEST-F-07 R10 D26-N3 missing incidentIdentity is recorded on evidence',
 'TEST-F-07 R10 D26-N3 missing coveredItems is recorded on evidence',
 'TEST-F-07 R10 D26-N3 missing performedAt is recorded on evidence',
 'TEST-F-07 R10 D26-N3 missing legalBasisRef is recorded on evidence',
 'TEST-F-07 R10 D26-N3 C03 C10 attribution values require own capacity same attack content and basis',
 'TEST-F-07 R10 D26-N3 C12 user legalBasisRef alternatives and service-user intersections',
 'TEST-F-07 R10 D26 C20 attribution completion preserves all original times and immutable evidence history',
 'TEST-F-07 R10 D26 C12 C14 C18 partial direct user delivery retains other users and delay judgment',
 'TEST-F-07 R10 D26 C22 C23 direct report receipt needs no duplicate PIPA attribution and prompt is officer '
 'only',
 'TEST-F-07 R10 R9-I04 CE21 earlier-effective correction retains observed moot history',
 'TEST-F-07 R10 R9-I04 CE21b earlier-effective correction retains observed moot history']
MUTANTS += [{'id': 'M-F-R10-024',
  'title': 'unverified PIPA exemption releases a report',
  'file': 'contract.ts',
  'old': "d.effect === 'report-exemption' && DELAY_RULE.decider(d.decider, owner.id)",
  'new': "d.effect === 'report-exemption'",
  'case': 'TEST-F-07 R10 D26-N2 PD40 principal trigger and separately verified exemption never exempt ISP',
  'expect': 'D26 unverified exception never auto-releases'},
 {'id': 'M-F-R10-025',
  'title': 'PIPA exemption propagates to ISP',
  'file': 'contract.ts',
  'old': "else if (exemption) o.status = 'exempt';",
  'new': "else if (exemption || (o.family === 'isp-report' && decisions.some(d => d.effect === "
         "'report-exemption'))) o.status = 'exempt';",
  'case': 'TEST-F-07 R10 D26-N2 PD40 principal trigger and separately verified exemption never exempt ISP',
  'expect': 'D26 PIPA exemption never closes ISP reporting or declares missed'},
 {'id': 'M-F-R10-026',
  'title': 'supplement classified as evidence eligible for deeming',
  'file': 'contract.ts',
  'old': "'isp-incident-report-supplement': 'never' } };",
  'new': "'isp-incident-report-supplement': 'evidence-only' } };",
  'case': 'TEST-F-07 R10 D26 C13 C19 never kinds and supplements cannot be satisfied by attributed other-law '
          'evidence',
  'expect': 'D26 supplement never deems other-law evidence'}]
DECLARED_CASES += ['TEST-F-07 R10 D26-N2 PD40 principal trigger and separately verified exemption never exempt ISP', 'TEST-F-07 R10 D26 C13 C19 never kinds and supplements cannot be satisfied by attributed other-law evidence']
MUTANTS += [{'id': 'M-F-R10-027',
  'title': 'relabel report as subject notice',
  'file': 'contract.ts',
  'old': "if (reportKind ? !['report', 'additional-report'].includes(DUTY_FAMILY[n.kind]) : a.kind === "
         "'mohw-notice' ? n.kind !== 'mohw-notice' :\n"
         "          !['possibility', 'confirmed', 'additional-notice', "
         "'no-leak'].includes(DUTY_FAMILY[n.kind]))",
  'new': 'if (false)',
  'case': 'TEST-F-07 R10 D26 C13 attribution cannot relabel a performed act or its authority',
  'expect': 'D26 report evidence cannot become subject-notice evidence'},
 {'id': 'M-F-R10-028',
  'title': 'attribute another receiving authority',
  'file': 'contract.ts',
  'old': "['PIPC', 'KISA'].includes(a?.recipientAuthority as string) && a?.recipientAuthority === n.channel",
  'new': "['PIPC', 'KISA'].includes(a?.recipientAuthority as string)",
  'case': 'TEST-F-07 R10 D26 C13 attribution cannot relabel a performed act or its authority',
  'expect': 'D26 recipient authority matches actual receipt'}]
DECLARED_CASES += ['TEST-F-07 R10 D26 C13 attribution cannot relabel a performed act or its authority']
MUTANTS += [{'id': 'M-F-R10-029',
  'title': 'open automatic deeming for isp-incident-report',
  'file': 'contract.ts',
  'old': '"isp-incident-report": {\n    "deemableKinds": [],',
  'new': '"isp-incident-report": {\n    "deemableKinds": ["pipa-processor-report"],',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-030',
  'title': 'open automatic deeming for isp-user-notice',
  'file': 'contract.ts',
  'old': '"isp-user-notice": {\n    "deemableKinds": [],',
  'new': '"isp-user-notice": {\n    "deemableKinds": ["pipa-processor-report"],',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-031',
  'title': 'open automatic deeming for isp-incident-report-supplement',
  'file': 'contract.ts',
  'old': '"isp-incident-report-supplement": {\n    "deemableKinds": [],',
  'new': '"isp-incident-report-supplement": {\n    "deemableKinds": ["pipa-processor-report"],',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-032',
  'title': 'change D26 interpretationStatus',
  'file': 'contract.ts',
  'old': '"interpretationStatus": "적용 미확정·증거 전용 (statutory deeming possibility ≠ product auto-closure; not a '
         'permanent denial — separate candidate if an official interpretation or reviewed basis is bound)"',
  'new': '"interpretationStatus": "적용 확정"',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-033',
  'title': 'change D26 physicianFacing',
  'file': 'contract.ts',
  'old': '"physicianFacing": "none"',
  'new': '"physicianFacing": "physician"',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-034',
  'title': 'change D26 perRecipient',
  'file': 'contract.ts',
  'old': '"perRecipient": true',
  'new': '"perRecipient": false',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-035',
  'title': 'change D26 recipientMustBeOperatorServiceUser',
  'file': 'contract.ts',
  'old': '"recipientMustBeOperatorServiceUser": true',
  'new': '"recipientMustBeOperatorServiceUser": false',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'},
 {'id': 'M-F-R10-036',
  'title': 'change D26 hospitalPlanRules',
  'file': 'contract.ts',
  'old': '"hospitalPlanRules": "unchanged (D-25); never cross-applied to the operator plan"',
  'new': '"hospitalPlanRules": "cross-apply"',
  'case': 'TEST-F-07 R10 D26 Q4 exact reviewed v2 constant',
  'expect': 'D26 Q4 exact legal contract'}]
DECLARED_CASES += ['TEST-F-07 R10 D26 Q4 exact reviewed v2 constant']
NOT_RUN = [
    {"id": "M-F-01-live", "status": "not_run", "reason": "the server roster check over B1 storage and the B2 caller context is round 2 "
     "(api/src/emr-audit/query.ts, admin.service.ts); TEST-F-01 live pair in tests/emr/f/live.py"},
    {"id": "M-F-02-live", "status": "not_run", "reason": "the institution/audit-scope predicate inside the R2 SQL query and its count/CSV "
     "(api/src/emr-audit/query.ts) does not exist in round 1"},
    {"id": "M-F-04-live", "status": "not_run", "reason": "the real print/PDF flow and the server artifact generator are round 2 "
     "(api/src/emr-audit/disclosure.ts, scripts/emr-disclosure.mjs, admin.html)"},
    {"id": "M-F-06-A", "status": "not_run", "reason": "the A gate holdEnded in api/src/emr-contract/lawful-defaults.ts (L5-06) is round-2 "
     "owned by F after release of ownership; H verifies the destruction race"},
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_lf(path):
    # Anchors are written with LF; a Windows checkout may hold CRLF. Compare and mutate on LF text.
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def check_anchors():
    problems = []
    for m in MUTANTS:
        count = read_lf(F_DIR / m["file"]).count(m["old"])
        if count != 1:
            problems.append(f"{m['id']}: anchor occurs {count} times in {m['file']}")
    if len(set(DECLARED_CASES)) != len(DECLARED_CASES):
        problems.append("DECLARED_CASES repeats a case")
    problems += [f"{m['id']}: named case is not declared" for m in MUTANTS if m["case"] not in DECLARED_CASES]
    return problems


def node_binary():
    node = os.environ.get("KIN_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("node not found (set KIN_NODE)")
    return node


def stage(workdir, mutant=None):
    src = pathlib.Path(workdir) / "api" / "src"
    shutil.copytree(A_DIR, src / "emr-contract")
    shutil.copytree(F_DIR, src / "emr-audit")
    hashes = {}
    if mutant:
        target = src / "emr-audit" / mutant["file"]
        text = read_lf(target)
        mutated = text.replace(mutant["old"], mutant["new"], 1)
        target.write_bytes(mutated.encode("utf-8"))
        hashes = {"source": sha(text.encode("utf-8")), "mutated": sha(mutated.encode("utf-8"))}
    return src / "emr-audit", hashes


def run(node, f_src):
    env = {**os.environ, "KIN_EMR_F_SRC": str(f_src), "NODE_OPTIONS": ""}
    proc = subprocess.run([node, "--test", "--test-reporter=tap", str(TEST)], cwd=ROOT, env=env, capture_output=True, timeout=600)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


TAP_LINE = re.compile(r"^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$")


def tap_cases(stdout):
    """Top-level TAP results: name -> (status, directive, block lines). Node escapes '#' and '\\' in names; ours have neither."""
    lines, cases, i = stdout.splitlines(), {}, 0
    while i < len(lines):
        match = TAP_LINE.match(lines[i])
        i += 1
        if not match:
            continue
        block = []
        if i < len(lines) and lines[i].strip() == "---":
            i += 1
            # Node may put an indented "..." in an assertion diff's block scalar. Only the
            # two-space TAP diagnostic terminator ends this top-level case's evidence.
            while i < len(lines) and lines[i] != "  ...":
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
    if code != 1:
        reasons.append(f"child exit is {code}, expected assertion-failure exit 1")
    if set(cases) != set(DECLARED_CASES) or any(skip for _, skip, _ in cases.values()):
        reasons.append("mutant collection differs from the exact declared selection")
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
    raw_dir = pathlib.Path(args.out).with_suffix(".raw") if args.out else None
    if raw_dir is not None:
        raw_dir.mkdir(parents=True, exist_ok=False)

    def retain_logs(label, stdout, stderr):
        if raw_dir is None:
            return {"stdout": stdout, "stderr": stderr}
        paths = {}
        for name, value in (("stdout", stdout), ("stderr", stderr)):
            log = raw_dir / f"{label}.{name}.log"
            log.write_text(value, encoding="utf-8")
            paths[name] = str(log)
        return paths
    problems = check_anchors()
    sources = {str(p.relative_to(ROOT)).replace("\\", "/"): sha(p.read_bytes())
               for p in sorted([*F_DIR.glob("*.ts"), *A_DIR.glob("*.ts"), TEST])}
    summary = {"sources": sources, "anchors": "ok" if not problems else problems, "baseline": None, "mutants": [], "not_run": NOT_RUN}

    def emit(code):
        text = json.dumps(summary, ensure_ascii=False, indent=2)
        if args.out:
            pathlib.Path(args.out).write_text(text, encoding="utf-8")
        print(text)
        return code

    if problems or args.anchors_only:
        return emit(1 if problems else 0)
    node = node_binary()
    summary["node"] = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="emr-f-baseline-") as work:
        f_src, _ = stage(work)
        code, stdout, stderr = run(node, f_src)
        cases = tap_cases(stdout)
        passed = {name for name, (status, skip, _) in cases.items() if status == "ok" and not skip}
        selection = {"declared": len(DECLARED_CASES), "collected": len(cases), "passed": len(passed),
                     "undeclared": sorted(set(cases) - set(DECLARED_CASES)), "not_collected": sorted(set(DECLARED_CASES) - set(cases))}
        summary["baseline"] = {"exit": code, "selection": selection, "logs": retain_logs("baseline", stdout, stderr),
                               "not_ok": sorted(n for n, (s, _, _) in cases.items() if s == "not ok")}
        if code != 0 or set(cases) != set(DECLARED_CASES) or passed != set(DECLARED_CASES):
            summary["baseline"]["stderr_tail"] = stderr[-2000:]
            return emit(1)
    for mutant in MUTANTS:
        with tempfile.TemporaryDirectory(prefix=f"emr-f-{mutant['id'].lower()}-") as work:
            f_src, hashes = stage(work, mutant)
            code, stdout, stderr = run(node, f_src)
            verdict = judge(mutant, code, stdout, stderr)
            summary["mutants"].append({"id": mutant["id"], "title": mutant["title"], "file": "api/src/emr-audit/" + mutant["file"],
                                       "case": mutant["case"], "expect": mutant["expect"], "exit": code,
                                       "logs": retain_logs(mutant["id"], stdout, stderr), **hashes, **verdict})
    killed = all(m["killed"] for m in summary["mutants"])
    summary["result"] = {"killed": sum(m["killed"] for m in summary["mutants"]), "total": len(MUTANTS), "not_run": len(NOT_RUN)}
    return emit(0 if killed else 1)


if __name__ == "__main__":
    sys.exit(main())
