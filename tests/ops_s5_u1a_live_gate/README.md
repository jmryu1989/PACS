# S5 hosted clinician live gate for an immutable candidate

Runs a declared list of the candidate's live modules, each once, in GitHub-hosted CI. Decision D2(a) keeps
these modules out of the `candidate_ci.py` BASE, so the candidate commit is not changed to run them: this
gate lives on its own branch and checks the candidate out separately. It began as S5-U1a G2
(`TEST-S5-U1a-CLINICIAN-LIVE`, `tests/clinician_policy_live.py` only, run 36210036499) and now takes the
list from `modules.json`, so S5-U1b and later units add modules instead of a new workflow.

| File | Role |
|---|---|
| `.github/workflows/s5-u1a-clinician-live.yml` | push to `opus/s5-u1a-live-gate-20260926` (GitHub refuses `workflow_dispatch` for a workflow not on the default branch) or `workflow_dispatch` with `candidate_sha` and an optional `modules` JSON string replacing `modules.json` |
| `candidate.txt` | the candidate SHA a push runs: one full lowercase SHA and a line end (S5-U1b: `d02ed37e29d4c9f9700b51ab0e2c8f63252f99c2`; S5-U1a was `88ce2df`, PR #86) |
| `modules.json` | the module list a push runs; it describes the candidate in `candidate.txt`, so both change in the same commit |
| `run_live.py` | `resolve` picks the SHA and validates the list into `s5-live-modules.json`; `run` proves the checkout with `candidate_ci.hosted_target`, pins each module's cases, adds one profile to the candidate's own `measurement_ci.py` and calls its `main` |
| `summarize.py` | the list validation, `write` (recorded files → `s5-live-summary.json`) and `check` (the convenience status) |
| `live_gate_test.py` | pure checks, run locally and as the job's step before the stack |

## modules.json

A JSON list of 1–4 entries, each with exactly these keys:

```json
{"module": "tests/clinician_policy_live.py", "unit": "s5-u1a-clinician-live", "timeout": 900,
 "cases": ["ClinicianPolicyLive.test_01_...", "..."],
 "expected": {"sweep": {"routes": 108, "denied": 102}, "audit_rows": {"clinician": 0}}}
```

- `module`: an API-only `tests/<name>_live.py` (the job installs no browser); each module stem once.
- `unit`: the run-tests.py unit (`[a-z0-9][a-z0-9-]{0,79}`), each once; its ledger allows 3 attempts, and
  every workflow run consumes one of them for every listed unit.
- `timeout`: 1–900 s, passed unchanged as `--timeout`.
- `cases`: `Class.test_name`, exactly the cases `run-tests.py` must select, in that order.
- `expected.sweep`: `{routes, denied}` of the single `CLINICIAN_LIVE_SWEEP` marker, or `null` when the
  module prints none (then a marker is a failure).
- `expected.audit_rows`: logical LiveStack identity → the row count expected in its cleanup archive.

`measurement_ci.main` gives the stack and every suite one 25-minute deadline and keeps 35 s per suite, so
the list is refused unless Σ(timeout + 35) ≤ 1500 − 175 = 1325 s (175 s is the smallest stack share an
existing multi-suite profile keeps). Two modules at 900 s do not fit: one module at 900 leaves at most
355 s for the other. At run time the driver still refuses, instead of shortening, any module whose
`--timeout` the remaining deadline would cut.

The committed list is S5-U1b's, for candidate `d02ed37e`: `tests/clinician_read_live.py` (unit
`s5-u1b-clinician-read`, 800 s, the five `ClinicianReadLive` cases, `sweep: null`, no audit identity
listed) and then a re-run of `tests/clinician_policy_live.py` under its own unit `s5-u1b-clinician-policy`
(355 s, the four `ClinicianPolicyLive` cases, sweep routes 110 / denied 99, clinician audit rows 0), a
declared worst case of 835 + 390 = 1225 s. The conductor chooses these values and commits them with
`candidate.txt`; `live_gate_test.py` pins none of them. It reads both committed files and checks only the
rules a push runs under: the list passes the validation above (schema, each unit and module once, cases
as `Class.test_name`, Σ(timeout + 35) ≤ 1325), `candidate.txt` holds one full lowercase SHA, and the
workflow's `workflow_dispatch` `candidate_sha` default is that same SHA, so a dispatch left at its
default runs the candidate the committed list describes. The refusal and summary checks run both the
committed list and a fixed two-entry list and expect one record per listed unit, in order. A
`workflow_dispatch` `modules` override is validated the same way.

## One stack, modules in order; what is and is not isolated between them

The candidate's stack is built and started once; the modules then run in the listed order against that
same database, Keycloak realm and Orthanc. Nothing resets the stack between modules. What separates them
is only each module's own LiveStack setup and class cleanup: temporary `kin-test-<hex>-<name>` identities
and the rows those identities own are created and removed by the module that made them. Anything else a
module changes, or anything its cleanup leaves, is seen by the next module, so the order is part of the
list and the evidence. `measurement_ci` stops at the first module whose `run-tests.py` exits non-zero;
the later modules are recorded as `not_run`, never as passed.

## Commands and budget

Each launch must be exactly

```
python scripts/run-tests.py --module <module> --mode live --unit <unit> --timeout <timeout>
```

(the candidate's own `run-tests.py`, `sys.executable` of the job's venv), in the listed order, each once.
Budget D3: every push to the branch or dispatch is one run, a re-run (`run_attempt` ≠ 1) is refused and
never counts, and a cancelled or timed-out run is consumed, never a pass. Runs are serialized by the
`s5-u1a-clinician-live` concurrency group.

## Evidence (artifact `s5-live-gate-<run_id>-<attempt>`)

- `target/tests/e2e/artifacts/s5-live-gate-ci/` — `measurement_ci`'s sanitized raw logs: one
  `<module stem>.log` per launched module (`EXACT_TESTS`, any `CLINICIAN_LIVE_SWEEP` marker,
  `OWNED TEST AUDIT CLEANUP`, `PLAN_RESULT`, the unittest output), each stack step, `services.log`,
  `cleanup.log`, `results.json`.
- `s5-live-modules.json` — the exact list the run used; its sha256 is in provenance and the summary.
- `s5-live/provenance.json` (candidate/checked-out/tools SHA, the list, each module's plan, source sha256),
  `s5-live/driver.json` (driver exit, the launched commands, error), `s5-live/test-gate/` (the run-tests
  ledger of each listed unit), `s5-live/s5-live-summary.json`.

The summary has run-level checks (list valid and equal to provenance, candidate checked out, driver exit 0,
each module launched once) and one `modules[]` record per entry: `status` (`passed`/`failed`/`not_run`),
`exit` (its `results.json` row), the launched command, `plan_result`, `attempts`, `exact_tests`,
`tests_ran`, `unittest_result`, `marker`/`routes`/`denied`, `audit_rows` and its checks against the entry's
`expected`. `audit_rows` counts, per listed identity, rows whose actor is exactly that run identity in the
cleanup archive `LiveStack.cleanup_test_identities` prints before it deletes owned rows; it is null unless
unittest ended `OK` (only then did that cleanup run to the end). For a module with a sweep,
`audit_rows_in_test` is 0 when the marker printed, because the policy module prints it only after
asserting `count(*) = 0` for the clinician actor.

## What a matching summary shows

On a fresh hosted runner with an empty Docker daemon, the candidate checkout at exactly the requested SHA
built and started its own synthetic stack (generated secrets, synthetic DICOM seed, realm from the
candidate's `keycloak/kin-realm.json` import) and every listed module ran its declared cases in a single
run-tests attempt, in order, with the declared marker counts and archived audit rows.

## What it does not show

- The production Keycloak realm, real accounts or any server: the realm here is the candidate's import JSON
  on a disposable database, and no deployment is involved.
- That the swept routes are every route: `controller_routes()` reads the candidate's controller decorators.
- That a module passes on a fresh stack when it ran after another one, or in another order.
- Browser/UI behaviour (no browser runs), the pure/compiled checks in `validate.yml`, independent review,
  physician use, or anything for a SHA or list other than the ones recorded.
- An acceptance: the job's colour is a convenience; the conductor decides from the artifact.

No secret is used or uploaded (the stack's generated values are masked and redacted by `measurement_ci`),
and no real patient data exists anywhere in the run.
