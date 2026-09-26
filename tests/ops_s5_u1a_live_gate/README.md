# S5-U1a G2 — hosted clinician live gate for an immutable candidate

`TEST-S5-U1a-CLINICIAN-LIVE` (REQ-S5-U1a-ROLE-DEFAULT-DENY) runs `tests/clinician_policy_live.py` of the
candidate, once, in GitHub-hosted CI. Decision D2(a) keeps that live module out of the `candidate_ci.py`
BASE, so the candidate commit is not changed to run it: this gate lives on its own branch and checks the
candidate out separately.

| File | Role |
|---|---|
| `.github/workflows/s5-u1a-clinician-live.yml` | push to `opus/s5-u1a-live-gate-20260926` (GitHub refuses `workflow_dispatch` for a workflow not on the default branch) or `workflow_dispatch` with `candidate_sha` |
| `candidate.txt` | the candidate SHA a push runs: `88ce2df3b56ca1b63a66e14e0406e04aee5f2f62` (PR #86) |
| `run_live.py` | `resolve` picks the SHA; `run` proves the checkout with `candidate_ci.hosted_target`, pins the four cases, adds one profile to the candidate's own `measurement_ci.py` and calls its `main` |
| `summarize.py` | `write` turns the recorded files into `u1a-live-summary.json`; `check` is the convenience status |
| `live_gate_test.py` | pure checks, run locally and as the job's step before the stack |

## Single live command and budget

The driver refuses to launch anything but

```
python scripts/run-tests.py --module tests/clinician_policy_live.py --mode live --unit s5-u1a-clinician-live --timeout 900
```

(the candidate's own `run-tests.py`, `sys.executable` of the job's venv). If stack setup left less than
935 s of `measurement_ci`'s 25-minute deadline the timeout would shrink, so the driver refuses instead.
Budget D3 is three runs of 900 s: every push to the branch or dispatch is one run, a re-run
(`run_attempt` ≠ 1) is refused and never counts, and a cancelled or timed-out run is consumed, never a
pass. Runs are serialized by the `s5-u1a-clinician-live` concurrency group.

## Evidence (artifact `s5-u1a-clinician-live-<run_id>-<attempt>`)

- `target/tests/e2e/artifacts/s5-u1a-clinician-live-ci/` — `measurement_ci`'s sanitized raw logs: the suite
  (`clinician_policy_live.log`: `EXACT_TESTS`, the `CLINICIAN_LIVE_SWEEP` marker, `OWNED TEST AUDIT CLEANUP`,
  `PLAN_RESULT`, the unittest output), each stack step, `services.log`, `cleanup.log`, `results.json`.
- `u1a-live/provenance.json` (candidate/checked-out/tools SHA, the four cases, source sha256),
  `u1a-live/driver.json` (driver exit, the launched command, error), `u1a-live/test-gate/` (the run-tests
  ledger for the unit: attempt count and status), `u1a-live/u1a-live-summary.json`.

Summary fields: `candidate_sha`, `exit` (the run-tests.py exit in `results.json`), `marker`, `routes`,
`denied`, `audit_rows`, `run_id`, plus every check. `audit_rows` counts rows whose actor is exactly the
run's `clinician` identity in the cleanup archive `LiveStack.cleanup_test_identities` prints before it
deletes owned rows; it is null unless unittest ended `OK` (only then did that cleanup run to the end).
`audit_rows_in_test` is 0 when the marker printed, because test_01 prints it only after asserting
`count(*) = 0` for the clinician actor. Expected for this candidate: routes 108, denied 102, audit rows 0.

## What a matching summary shows

On a fresh hosted runner with an empty Docker daemon, the candidate checkout at exactly the requested SHA
built and started its own synthetic stack (generated secrets, synthetic DICOM seed, realm from the
candidate's `keycloak/kin-realm.json` import) and the four declared cases passed in a single run-tests
attempt: for a clinician-only member every declared route except the two session routes (`GET me`,
`POST auth/logout`) and the four public routes answered 403 with `CLINICIAN_ROUTE_DENIED` while `GET me`,
`GET health` and `POST auth/logout` answered, the clinician actor wrote no audit row, PENDING/INVALID
clinicians kept their membership codes, the member console refused an unknown role and approved, changed
and revoked a clinician, and mixed/legacy roles kept their existing paths.

## What it does not show

- The production Keycloak realm, real accounts or any server: the realm here is the candidate's import JSON
  on a disposable database, and no deployment is involved.
- That the 108 routes are every route: `controller_routes()` reads the candidate's controller decorators.
- Browser/UI behaviour (no browser runs), the pure/compiled checks in `validate.yml`, independent review,
  physician use, or anything for a SHA other than the one recorded.
- An acceptance: the job's colour is a convenience; the conductor decides from the artifact.

No secret is used or uploaded (the stack's generated values are masked and redacted by `measurement_ci`),
and no real patient data exists anywhere in the run.
