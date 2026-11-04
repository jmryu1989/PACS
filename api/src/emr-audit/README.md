# F online binding

Incident binds `incidentScope` and `planIncidentResponse` unchanged. Every incident
route requires the institution's auditor designation and both `investigate` and
`export`: its impact scope is a complete read, never a single page.

| Routes under `/api/emr-audit` | Response recording |
| --- | --- |
| POST incidents | Registration / exact replay: incident ID and all returned scope targets |
| GET incidents | IDs, type, effective verdict, status and awareness only; no patient identifiers |
| GET incidents/:id | Fixed impact scope, projected duties and evidence history |
| POST incidents/:id/findings | Exactly one of facts, decision or delay with operationId; contract validation and exact replay |
| POST incidents/:id/notices | Actual performance evidence and scope; no dispatch; exact replay |
| POST incidents/:id/close | Evidence with no owed duty/unresolved decision, or supersededBy an existing open same-institution incident |
| GET incidents/:id/drafts/:form | Six draft families with all scope targets recorded as download |

The existing append-only `request_event` holds a distinct `incident` body. It stores
the registration query and fixed viewing-stream snapshot (also containing changes),
scope determinations, accepted findings/notices with actor/roles/time, and closure
evidence. The shared request-ID lock prevents copy/rights collisions. No migration,
clinical write or external dispatch is involved. Historical authority is reconstructed
from the original subject's roster at acceptance; current authority gates every route.
Plans/scopes are reconstructed through the real contract constructors, preserving the
original findings' attribution. Raw source rows do not cross the response boundary.
Returned patient/local-source/event references are recorded on every detail and draft.
An unreadable/corrupt snapshot stays explicitly unidentifiable, never zero affected.

Closure requires a non-possible verdict and the absence of remaining contract duties.
Not-a-leak after a possibility notice still requires the contract's follow-up. Late
performance is accepted and keeps the original clock/delay. Closed incidents allow
reads/drafts/exact replay but refuse new findings/notices or replacement closure.
Listing uses the effective contract verdict, including retroactively recorded facts.
Decisions and delays are saved on their acceptance step and replayed through the
unchanged contract. Decision makers bind to the current actor's institution grantor
record; designation/qualification and causal evidence still require contract validation.
Report exemption is a recorded human decision, never an automatic product conclusion.
Accepted delays display their cause and evidence while retaining the original deadline.
Superseded closure records evidenceId and supersededBy without changing any verdict,
scope or draft. Both request IDs are locked in sorted order; self, foreign, missing
or closed replacements refuse. Exact closure replay remains readable even after the
replacement later closes. An open replacement requirement prevents cycles.

Snapshot storage/list-read performance re-check trigger (P3-3): before a larger
hospital, or when an incident query covers a whole month of an institution.

Form keys: `possibility`, `confirmed` (full/priority/additional), `not-a-leak`, `report`
(PIPC/KISA), `medical` (MOHW), `network` (ISP report/supplement/user notice). Drafts
contain actual facts/scope, matching duties with required fields, legal grounds and
performance evidence. P5 wording remains pending; #69 is `조건부`. The cloud duty
is represented by a display-only cloud-incident row (클라우드컴퓨팅법 제25조,
조건부 #69, 공급 구조 결정 전); it creates no tracked obligation. A form without
matching contract obligations has no static legal basis and explicitly says
"현재 계약 결과에 이 서식의 의무가 없습니다(조회 사실만 포함)". CVR Misdelivery
is manual until CD-12. Printing/downloading is never notice performance. Numeric,
immediate and provisional deadlines are taken from the date-sensitive contract.

REQ-EMR-15/19 → RISK-F-07 → TEST-F-INCIDENT / TEST-AUDIT-INCIDENT / TEST-F-LINK-INCIDENT.
Service, browser and HTTP/PG tests: `incident_service_test.cjs`,
`audit_incident_dom_test.py`, `link_pg_test.cjs`.

`EmrAuditController` is registered in `AppModule`. Its routes use `AuthGuard`
and `RequestContextSource`; identity, institution and current rights are server
facts. On a clean install, after migrations the institution's configuration owner
runs the existing installer SQL tool with the officer's IdP issuer and subject
and the actual designation document:

```sh
python scripts/emr-compose.py sql audit-grantor --institution '<institution>' --issuer '<OIDC issuer>' --subject '<officer sub>' --capacity privacy-officer --basis-document '<designation document ID>' > audit-grantor.sql
psql -X -v ON_ERROR_STOP=1 -f audit-grantor.sql
```

Use the installer connection (normal psql environment/service configuration).
The command resolves the internal member ID and records the officer; re-running
updates that institution/subject's capacity and document. `institution-representative`
is the other supported capacity. The roster POST accepts
`subject: { issuer, subject }`; callers never need an internal ID. The person must
have signed in once. Both designation paths refuse an unknown issuer/subject without creating an identity.
An ordinary admin cannot appoint an auditor.
Roster changes append full grant history and the B1 rights event together.

Investigation/export reads the PostgreSQL record-change and viewing streams
separately, retaining their own cursors and retention. Recorded patient and
institution attribution is preserved. E preparation, transport and staging-copy
observations accompany the selected event; transport is not display evidence.

Issuance consumes D `online_version` and C2 `signed_version`, verifies their
original signatures and packages the exact selected originals. Preparation
fixes the version list; a changed head requires new preparation. The issued
electronic UTF-8 JSON document contains the manifest and original signed
documents. Paper copies use printable HTML with readable version contents. The
HTTP response carries saved bytes as base64 with their content type and SHA-256. Reopening reads those saved
bytes after recomputing their SHA-256 and matching the column and issuance history. Paper Author uses the original signer registration identity. It does not sign again or infer recipient delivery from HTTP success.
`KIN_EMR_ENVIRONMENT=synthetic-test` marks synthetic artifacts; the default is
operational. Artifact creation is separate from delivery evidence.

`POST /api/emr-audit/requests` commits request intake and holds without loading a package.
`POST /api/emr-audit/issuances` also commits this intake first, then prepares the package.
Missing/unavailable originals or a failed preparation leave `issuanceId: null`, and
GET/extend/resolve still operate on that request. Fulfillment needs actual delivery
evidence; withdrawal/refusal can resolve an unpackageable request.

Request intake supplies the actual due date and qualification evidence. The
designated auditor records the extension's legal basis and notice evidence;
the software does not invent a statutory extension duration. Request history
and every associated hold move in one transaction. B1 `holds_for` and
`duty_requests` expose their current values to A/H while preserving original
rows and extension history. A pending request stays held after its due date;
resolution and explicit, evidence-bound release are required.

H_LINK consumes `emr_audit.fixed_copy` joined by issuance ID to
`issuance_event.body.manifest.records` (record/version/hash), and
`request_event` (request/hold history). Its record decisions must use
`lockFixedRecord`, shared by D/C2 publication and F. No destruction worker or
external transmission is started here.

REQ-EMR-07/15/19 → RISK-F-01/02 → TEST-F-LINK-AUDIT;
REQ-EMR-16 → RISK-F-03/04 → TEST-F-LINK-COPY;
REQ-EMR-17 → RISK-F-06 → TEST-F-LINK-HOLD.
`tests/emr/f/link_live.py` runs the real Nest HTTP and PG boundaries on owned
synthetic fixtures; its companion Node test drives D/C2 and E producers.

This binding uses only consumers present on main. D's unmerged #219 route,
manual-SR adoption and served-page work are not accepted by this test. E's
Module A catalog binding and derived PDF/preview snapshots remain their own
dependencies; F does not reconstruct missing originals from transport facts.

The legal text used here is 개인정보 보호법 제35조③ (열람 및 정당한 사유의 연기),
[law text](https://www.law.go.kr/법령/개인정보보호법/제35조), and 의료법 제22조①
(의료행위 기록 및 서명), [law text](https://www.law.go.kr/법령/의료법/제22조).
Placement uses A's `clauseVersionAt(HOLD_CLAUSE_VERSIONS['privacy:35.3'], at)`;
it records the publication in force at the hold time rather than the current
publication at reopening. Extensions preserve that placement basis.

Rights Requests uses the existing `request_event` append-only store with the distinct
`rights-request` body kind. It shares request ID locking with copy requests and refuses
an ID already used by the other workflow. No migration or clinical write is involved.

| Routes | Auditor scope | Response recording |
| --- | --- | --- |
| POST rights-requests | disclosure | Intake patient/record references; replay records a read |
| GET rights-requests | disclosure | Request IDs/status only; no patient identifiers |
| GET rights-requests/:id | disclosure | Exactly the requested patient/record references |
| POST rights-requests/:id/decide | disclosure | Decision patient/record references; replay records a read |
| POST rights-requests/:id/notify | disclosure | Actual notice or withdrawal evidence and patient/record references |

All paths above are under `/api/emr-audit`. Designation, current session and institution
checks are the same as the copy workflow; a clinician role alone grants nothing.
F's `decideRightsRequest` alone supplies outcomes, grounds and deadline. Intake calls
it to validate the stored subject and obtain the deadline; an explicit decision reloads
the verified D/C2 originals. The shipped contract classifies statutory records regardless
of age; this binding does not reinterpret expiry. Unknown original stores and a unit
whose stored versions have different retention dispositions are refused for follow-up;
the binding does not invent one classification for a mixed unit.
Correction guides the operator to Addendum/new signed version; deletion and suspension
decisions execute no mutation. `Notified` requires an actual notice timestamp, recipient,
method, text and evidence; it never means automatic dispatch or action completion.
Missing P5 text remains a grounds-only placeholder with the objection method marked pending.
Late notices are accepted and displayed as late. The first decision and notice are immutable.

REQ-EMR-17 → TEST-F-RIGHTS / TEST-AUDIT-RIGHTS. 위험 ID 미배정: 문서 트랙 대기.
(`tests/emr/f/rights_service_test.cjs`, `tests/audit_rights_dom_test.py`).

Intake also writes B's existing `correction-request` duty as `received`. Decision leaves it open.
The shipped decision contract has no closure event: this binding closes the response duty at
evidenced `Notified` (`resolved`), pending CD-07-Q4. The response outcome is `lawfully-refused`
when every record is refused, otherwise `fulfilled`; it does not assert execution of the decision.
Open duties block ledger expiry and supply the `privacy:36.2` hold reader without a new migration.
The same close endpoint accepts `{outcome: 'withdrawn', evidenceId}` from `Received` or `Decided`.
It appends a withdrawal to the existing request history and `resolved` with outcome `withdrawn`
to the append-only duty ledger; it never replaces the received fact or an earlier decision.
The status is `Withdrawn`, and the operator/evidence/time remain readable in detail and list.
The same evidence replays the saved withdrawal without another duty or request event; conflicting
evidence, a later decision or notification are refused. A notified outcome cannot be replaced by withdrawal.
Withdrawal does not reload originals, so an undecidable request can still be withdrawn with evidence.

접수 뒤 원본 재검증이나 결정 계약이 거절되면 요구는 Received로 남고, 열린 응답 의무가 접속기록 만료를 계속 막는다(CD-07-Q4). 철회가 아니면 닫지 않는다.
The page reserves Q3 guidance for failed intake and shows the separate Q4 line on a refused decision.
Transport failures retain the recovery guidance to reopen the request; they do not assert an unconfirmed state.

Investigation uses an indexed institution/stream/sequence snapshot and keyset pages.
SQL applies the same filters to pages and totals. Continuations carry the snapshot total;
replay stops after the page and its next matching event.
Exports reuse identical events across streams and validate each audit chunk at B1 admission.
A transaction/statement timeout returns HTTP 503 `InvestigationTimedOut` with guidance to narrow the period or filters. E facts
are fetched by UUID arrays. Every recorded target survives the split into B1's
65,536-byte canonical payloads inside the same transaction. Roster authority reads
share the institution lock; designation writes take it exclusively.
