# F online binding

`EmrAuditController` is registered in `AppModule`. Its routes use `AuthGuard`
and `RequestContextSource`; identity, institution and current rights are server
facts. `emr_audit.grantor` is installed by the institution's configuration owner
from its designation document. An ordinary admin cannot appoint an auditor.
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
bytes. It does not sign again or infer recipient delivery from HTTP success.
`KIN_EMR_ENVIRONMENT=synthetic-test` marks synthetic artifacts; the default is
operational. Artifact creation is separate from delivery evidence.

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
