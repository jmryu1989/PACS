# F online binding

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
`subject: { issuer, subject }`; callers never need an internal ID.
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

Investigation uses an indexed institution/stream/sequence snapshot and keyset pages. E facts
are fetched by UUID arrays. Every recorded target survives the split into B1's
65,536-byte canonical payloads inside the same transaction. Roster authority reads
share the institution lock; designation writes take it exclusively.
