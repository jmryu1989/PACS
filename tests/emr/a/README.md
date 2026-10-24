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
preparation. A1 introduces no timer, reserve or new timeout.

Serialization runs once before recording. The hash identifies the actual
serialized target projection; it is not a signature or an integrity chain.
The interceptor obtains the Guard's `REQUEST_CONTEXT_SOURCE` and the same B2
request work. All target receipts precede the selected `StreamableFile`. Nest
pipes that stream after its other interceptors accept the response. Only stream
consumption plus a finished 200 produces `transfer-ended`; a refusal, close,
error, or other body produces `transfer-aborted`. These are server observations,
not proof of browser display or human reading.

A3 must replace W9's `transferOf` and its old `prepare/finish` integration when
adopting this boundary. Running both creates duplicate outcomes. A1 does not
activate W9, change its existing source/policy checks, or call `requireCurrent`.
RF owns work release after the last follow-up; no work starts from finish/close.

The event retains RF's issuer/subject identity, roles, rights version, institution,
session binding, server requestId and observed ingress. Local targets contain no
formal PatientLink, signature or retained-state placeholders. Audit replay exposes
`patient: null` with `localSource` for these targets. The `sourcePatientId` filter
is an observed identifier inside the investigation's existing institution scope;
it is not interchangeable with the formal patient/assigning-authority filter.

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
not a substitute route or real HTTP wire. Pure failures use no fake durable
receipt. UNKNOWN is queried only under the original operation ID and is never
retried as a new event.

REQ-A-DURABLE / A-PG-COMMIT remains partial until A2/A3's real routes prove
COMMIT before their first clinical byte and lost-reply resolution. REQ-A-TARGET
/ A-HTTP-BODY and REQ-A-OUTCOME / A-HTTP-OUTCOME require the real Nest routes;
renderer acceptance belongs to A5. Empty fixture endpoints do not close them.
The current workflow is `validate.yml`; the order's `emr-b.yml` is absent.
Its owner must add these selections when assembling the joint candidate.
