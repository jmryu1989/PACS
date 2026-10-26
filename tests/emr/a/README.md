# Local read recording boundary

A1 implements `LocalReadResponse`, the `local-read` formatVersion 2 branch and
the Nest response interceptor registered by `AppModule.withLedger()`.

A2/A3 return `new LocalReadResponse(body, sources)` after their existing source
snapshot and authorization checks. Each source names its actual local study,
stored row/version (metadata may have no observed version), managing institution,
observed source PatientID/institution and a path into the JSON response. Generate
the source `eventId` on the server before including its access reference in the
body. Include every returned target; an actually empty result has no sources.
Do not read mutable source rows again to construct this manifest.
Pass an existing source work context when observed (including W9's comparison
anchor); otherwise it remains null. A3 passes its existing cancellation/deadline
signal as the third constructor argument and keeps that deadline alive through
preparation. A3 also supplies its existing W9_AUDIT_UNAVAILABLE failure body;
other consumers retain EMR_VIEWING_UNAVAILABLE. A1 introduces no timer, reserve
or new timeout. A lifecycle abort refuses HTTP immediately while the admitted
append and its aborted follow-up drain in the original work.
A local-read route answers 200: preparation refuses any other status set before
the interceptor runs, and only a finished 200 is `transfer-ended`. Nest gives a
POST route 201, so a POST local-read route declares `@HttpCode(200)` (W9's
resolve already does).

Serialization runs once before recording. The hash identifies the actual
serialized target projection; it is not a signature or an integrity chain.
The interceptor obtains the Guard's `REQUEST_CONTEXT_SOURCE` and the same B2
request work. All target receipts precede the selected `StreamableFile`. Nest
pipes that stream after its other interceptors accept the response. Only stream
consumption plus a finished 200 produces `transfer-ended`; a refusal, close,
error, or other body produces `transfer-aborted`. These are server observations,
not proof of browser display or human reading.

A3 replaces W9's `transferOf` and its old `prepare/finish` integration with
this boundary. Running both would create duplicate outcomes. A1 does not
duplicate W9's source/policy checks or call `requireCurrent`.
RF owns work release after the last follow-up; no work starts from finish/close.

The event retains RF's issuer/subject identity, roles, rights version, institution,
session binding, server requestId and observed ingress. Local targets contain no
formal PatientLink, signature or retained-state placeholders. Audit replay exposes
`patient: null` with `localSource` for these targets. The `sourcePatientId` filter
is an observed identifier inside the investigation's existing institution scope;
it is not interchangeable with the formal patient/assigning-authority filter.
`incidentScope` lists these subjects in `identifiedLocally` by their observed
PatientID and source institution (an unobserved PatientID stays unresolved, one
entry per study). They are not formal identifications: their presence adds the
reason `identified-locally`, so `subjectsIdentifiable` is false. The auditor's
own access event (`investigationLedgerEvent`, also `incidentScope.auditEvent`)
carries one `access-audit` target per shown local row with the same observed
identifiers and no PatientLink. The route that records that event must accept
these targets; no route records it yet.

Run the parser/projection, failure and transport component cases:

```sh
node --test tests/emr/a/local_read_test.cjs
```

Run the accepted B2 synthetic PG fixture with the built API image (or its existing
native `KIN_B2R_*` settings), through the normal live execution gate:

```sh
KIN_TEST_API_IMAGE=<candidate-image> python scripts/run-tests.py --module tests/emr/a/recording_boundary_test.py --mode live --unit module-a-01-pg --timeout <measured-hang-timeout-seconds>
```

The PG driver proves append/readback/filter, request attribution, all receipts
before stream selection, a last-target SQL failure and close before a delayed
COMMIT using fixture-owned SQL locks. Its transport objects are component inputs,
not a substitute route or real HTTP wire. A second PG case (A-PG-AUDIT-LOCAL)
builds the incident scope and the export from rows read back from
`emr_access.access_entry`. Pure failures use no fake durable receipt. UNKNOWN is
queried only under the original operation ID and is never retried as a new event.

REQ-A-DURABLE / A-PG-COMMIT remains partial until A2/A3's real routes prove
COMMIT before their first clinical byte and lost-reply resolution. REQ-A-TARGET
/ A-HTTP-BODY and REQ-A-OUTCOME / A-HTTP-OUTCOME require the real Nest routes;
renderer acceptance belongs to A5. Empty fixture endpoints do not close them.
The current workflow is `validate.yml`; the order's `emr-b.yml` is absent.

## A2 report history reads

`GET studies/:uid/report/versions` and
`GET studies/:uid/report/versions/:version/citations` return a `LocalReadResponse`
built by `api/src/emr-viewing/report-read.ts` from the rows their existing gates
already fixed (no second read). Every returned version row is a `report-version`
target (study UID, the `ReportVersion` id, its version) and carries its own
`accessRef`, the event ID of its provide-prepared record; an empty history has no
target. A version citations answer is one `report-evidence` target for the stored
version and the filtered answer (an empty projection is still that version's
read) and carries its `accessRef`. The routes' own refusals (400/403/404/409)
record nothing; a refusal by an outer interceptor after preparation (the
`StudyAccessInterceptor` 409) leaves the prepared records with `transfer-aborted`.
The routes retain the raw source PatientID and InstitutionName observed by this
request's `StudyAccessService.prepareSourceIdentity`; its single QIDO read names
`00080080` in `includefield`, because InstitutionName is not a QIDO default
attribute (measured on Orthanc 1.12.5). Missing or blank values
remain `not-observed`; neither value is inferred from StudyState. Cause is
`user-view` and no work context is observed.

The real cells run the production `AppModule.withLedger` over HTTP on the B2 PG
fixture with an independent witness: all targets committed before the first
response byte (ledger INSERT held by an SQL lock), the exact returned rows and
hashes, filtered/empty/missing/refused citations, a last-target SQL failure, a
client that leaves before a late COMMIT, an outer `StudyAccessInterceptor`
refusal after preparation, and a COMMIT reply lost in a TCP relay in front of
the ledger connection. The synthetic Orthanc answers only the default QIDO study
attributes and the tags the request names in `includefield`, as Orthanc does:

```sh
KIN_TEST_API_IMAGE=<candidate-image> python scripts/run-tests.py --module tests/emr/a/report_reads_test.py --class ReportReadsHttp --mode live --unit module-a-02-http --timeout <measured-hang-timeout-seconds>
```

Display (`client-shown`) of the returned rows belongs to A4/A5.
A1, A2 and A3 selections are registered in `validate.yml`'s `emr-b` job.


A3 binds W9's ready metadata to this boundary. Its source manifest uses each
ready member's UID and original ordinal, the admitted StudyState institution,
the raw observed PatientID/InstitutionName, and the existing D-5 comparison
anchor. Only the serialized `members[ordinal].metadata` projection is hashed.
Error members have neither metadata nor receipt. Client composition/generation/
request IDs remain correlation fields; RF supplies the recording identity.
W9's existing source cutoff/deadline remains active through A1 preparation;
finish/close releases its timer. A1 alone records response outcomes and drains
late receipts. These metadata receipts do not certify image display/download.
W9API-20 stays disposed. A3 removes W9's duplicate post-source StudyState/policy
and source-tag rechecks, preserving initial access and split-source identity.

Run the actual W9 HTTP/PG boundary on the B2 synthetic fixture:

```sh
KIN_TEST_API_IMAGE=<candidate-image> python scripts/run-tests.py --module tests/emr/a/viewing_set_test.py --class ViewingSetHttpBoundary --mode live --unit module-a-03-w9 --timeout 300
```

The 300-second hang timeout follows the existing Module A PG CI step. The
fixture checks ready/partial/error-only, original ordinal and comparison anchor,
source patient/UID mismatch, COMMIT before first clinical byte, final-target
SQL refusal, a real StudyAccessPolicy denial beside ready members (no source
read or receipt), close/deadline with a late receipt, and the existing source cutoff.
The deadline assertion observes the 503 before releasing the PG append lock.
Native runs use the existing `KIN_B2R_NODE`, `KIN_B2R_BUILD`, and
`KIN_B2R_PRISMA_CLI` fixture settings. No source/production stack is used.
The real registration is `validate.yml`'s `emr-b` job (the order's `emr-b.yml`
does not exist); A3's continuation transfers ownership of this additive step.
Audit replay's local-subject consumers depend on #225 and are not certified
by the W9 HTTP tests. Actual client rendering belongs to W9-UI/A5.

## A4 report display observations

`POST studies/:uid/view-observations` (200) takes exactly `accessRef` (the
event ID A2 returned with a version row or a version-citations answer),
`eventId` (the browser's UUIDv4 for one display) and `shownAt` (the display
time in UTC milliseconds). The new request takes the gates of
`GET studies/:uid/report/versions` (institution/tele, StudyAccess, split source,
preliminary readability); a clinician-only member stays outside that scope.
The provide-prepared entry is read back from B2 (`work.snapshot` of the viewing
stream) and must be a local-read report-version/report-evidence provision of
this study by the same member, institution and session binding (a bearer
provision keeps its null session; a cookie session reports only its own). A
missing, disposed, metadata, other-study, other-member or other-session
reference is one 404 and records nothing.

The record is that provision's `client-shown` follow-up: the stored target,
kind, projection, surface and managing institution, `relatedEventId` = the
provision, the reporting request's actor/roles/rights/session/requestId/ingress,
cause `user-view`. Its `occurredAt` is the client-reported display time (as
`displayReported` and the offline branch use the device time); B2's own
reception time is the receipt's `durableAt`, answered as `receivedAt`. The ACK
follows the COMMIT and its durable receipt. A resend of the same report replays
the stored entry through B2 and answers the first accepted fact; another report
under that event ID is 409; a new opening is a new event ID. A lost COMMIT
reply is resolved through the same operation; closed, unreachable or unknown
recording is the non-PHI 503 and never an ACK. B2 binds an event ID to its
first payload, so a report whose first attempt stays pending or ends negative
is not recorded later under that ID (UNKNOWN stays unknown).

```sh
KIN_TEST_API_IMAGE=<candidate-image> python scripts/run-tests.py --module tests/emr/a/report_observation_test.py --class ReportObservationHttp --mode live --unit module-a-04-http --timeout 300
```

The cells use the production `AppModule.withLedger` with A2's real reads and
W9's real metadata read for the provisions: the ACK waits for the client-shown
INSERT held by an SQL lock, resend/conflict/new opening, wrong study/unknown/
metadata/disposed references, malformed reports, institution/preliminary/
clinician refusals, cookie account switch and re-login, a lost COMMIT reply in
the ledger relay, a closed record port, and a resend to a second API process on the
same database (B2 composes once per process, so the restart is a new process).
They do not prove that a page displayed anything; the served renderer is A5.
The route's EMR route classification (`api/src/emr-contract/routes.ts`) is
outside A4's paths and is handed to its owner; until it lands,
`tests/emr_contract_test.cjs` TEST-EMR-01-A reports the unclassified route.
