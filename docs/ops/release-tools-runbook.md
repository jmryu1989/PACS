# Clean installation (D1800)

First installation uses a new site stack and its configured empty volumes. It does
not call `ops_deploy_entry.py` with `mode=emr-introduction`: that mode is for an
existing installation's conversion only. No conversion phase or rehearsal receipt
is an admission condition for a clean install.

1. Backup: preserve the selected installation configuration and signing wrapping
   secrets before installation. For an existing stack, first run
   `python3 scripts/ops_backup.py backup --output <backup-directory>` and keep the
   resulting snapshot. A new empty site has no patient database to back up.
2. Install and migrate under the existing operations lock. Keep one operator's
   Python session open in the configured checkout for steps 2–4; do not launch
   Compose outside that session. Before mutation, compare `socket.gethostname()`,
   `git rev-parse HEAD`, `docker version` and `docker compose version` with the
   selected site's host and approved release/version record. A mismatch stops the
   install. Record those observed values, the selected SHA, configuration/secret
   backup locations and the operator in the private release record.

   ```python
   # Start python3 interactively in the selected checkout.
   import sys, socket
   from pathlib import Path
   sys.path.insert(0, 'scripts')
   import ops_backup as ops
   hold = ops.lock()
   lease = hold.__enter__()  # held across installation, verification and rehearsal
   ops.require_local_docker()
   observed = {'host': socket.gethostname(), 'sha': ops.text(['git', 'rev-parse', 'HEAD']),
               'docker': ops.text(['docker', 'version']),
               'compose': ops.text(['docker', 'compose', 'version'])}
   print(observed)  # compare to the selected site's release record before continuing
   ```

   After that comparison, set `record_path` to the private release record's path
   outside the checkout, `record` to the observed values plus the operator and
   backup locations, and `install_timeout` to the site's measured installation
   hang timeout (seconds). Persist the hold before starting Compose:

   ```python
   lease.retain()
   record['status'] = 'STARTED'
   ops.write_json(record_path, record)
   compose = ['docker', 'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml']
   ops.run(compose + ['up', '-d', '--build'], timeout=install_timeout)
   ```

   PostgreSQL initializes both `kin` and `keycloak` on the new empty data volume;
   the init SQL does not run again on an existing volume. The API image runs
   `prisma migrate deploy`; do not use schema reset or db push.
3. Verify in the same session: run `ops.run(compose + ['ps'])` and
   check both the API and the Keycloak realm through the configured HTTPS origin:

   ```python
   import subprocess, time
   origin = '<configured-HTTPS-origin>'  # no trailing slash
   readiness_timeout = 134
   deadline = time.monotonic() + readiness_timeout
   failure = None  # (path, curl's own error) of the last request that failed
   while True:
       for path in ['/api/health', '/auth/realms/kin/.well-known/openid-configuration']:
           remaining = deadline - time.monotonic()
           if remaining <= 0:
               where, cause = failure or (path, 'the deadline came before this request')
               raise RuntimeError(f'Installation unverified: HTTPS readiness failed within '
                                  f'{readiness_timeout}s at {where} ({cause}); inspect service logs')
           try:
               result = ops.run(['curl', '--fail', '--silent', '--show-error', '--max-time', str(remaining),
                                 origin + path], timeout=remaining, check=False)
               cause = result.returncode and (f'curl exit {result.returncode}: '
                                              + result.stderr.decode('utf-8', 'replace').strip())
           except subprocess.TimeoutExpired:
               cause = f'no answer within {remaining:.0f}s'
           if cause:
               failure = (path, cause)
               break
       else:
           break  # both requests answered in the same round
       time.sleep(min(3, max(0, deadline - time.monotonic())))
   ```

   The failure names the request that last failed and curl's own error for it,
   never the request that merely found the deadline passed. The 134 s bound is
   `ceil(2 × max(41.7, 45.3, 67.0, 30.5))`: twice the slowest clean-install
   readiness recorded for PR #258 (laptop 41.7, 45.3 and 67.0 s; desktop 30.5 s),
   rounded up to whole seconds. The 3 s pause only
   spaces the rounds; it is not a measured value and the deadline alone decides
   the outcome. Record the site's elapsed readiness time and recheck this bound
   before a larger site; it is an installation wait, not a clinical performance
   requirement.
   Both requests must succeed. A running container and `/api/health` with
   `auth:true` alone do not establish that Keycloak has started: `auth` describes
   the API's authentication configuration. If either request fails, inspect the
   service logs and keep the installation unverified. After correcting the cause,
   repeat this bounded check and preserve the first failure in the release record.
   Then perform the approved synthetic save/reopen and signing checks
   ([below](#synthetic-savereopen-and-signing-checks)) before clinical handover.
   Save their actual outcomes in the release record.
4. Backup and restore: after verification, take the **first populated backup**
   with `ops.backup('<backup-directory>')` in this same locked session (the CLI
   equivalent outside this session is `python3 scripts/ops_backup.py backup --output <backup-directory>`).
   Record the exact snapshot directory printed by the backup, then run
   `ops.rehearse(Path('<snapshot-directory>'))`, equivalent to
   `python3 scripts/ops_backup.py rehearse <snapshot-directory>`. When the set's
   manifest has `wrapping_custody`, follow the wrapping custody recovery commands
   below as well; otherwise record them as not applicable (check 2 below). This
   exercises restore even when the site had no database before installation.

   Only after verification and rehearsal succeed, record their raw evidence paths
   and `status=VERIFIED_AND_RESTORED` with `ops.write_json(record_path, record)`,
   then set `lease.retained = False` and call `hold.__exit__(None, None, None)`.
   On failure or interruption, keep the lock and a `NEEDS_ATTENTION` release
   record; inspect the incomplete installation before releasing it. Preserve the
   failed installation and restore the selected snapshot in the recovery
   environment; never overwrite an existing site's volumes with a clean install.

The first site's measured backup size and elapsed time are installation records;
recheck them before a larger site or when the backup approaches the existing 600 s
base-backup helper hang timeout; that timeout still needs the first-site measurement. Conversion commands remain available only when
an existing installation actually needs conversion. This procedure does not claim
an installation or restore was executed by this documentation change.

## Synthetic save/reopen and signing checks

Three checks make up step 3's "approved synthetic save/reopen and signing
checks". Neither writes a synthetic record into a clinical installation: report
versions are append-only (AGENTS §1.1) and there is no Orthanc delete feature
(AGENTS §6), so whatever a check saved on the site would stay there.

1. **Save/reopen and signed approval: the G3 candidate run of the installed SHA.**
   `.github/workflows/candidate.yml` (`tests/candidate_ci.py`) is the approved
   candidate gate (AGENTS §2). It runs on a disposable synthetic stack that
   `tests/measurement_ci.py` starts with the deployment's own signing overlay and
   a fresh 32-byte `c2-wrap-v1` file (`tests/emr/d/synthetic_stack.py`); each
   synthetic doctor gets a C2 key (`tests/emr/d/provision_synthetic.cjs`). Its
   selection includes `WorklistE2E.test_02_selection_draft_isolation` (draft
   save), `test_11_approved_buttons_stay_disabled_after_reload` (UI Approve,
   reload, the same findings, one version) and
   `RelatedReportModeE2E.test_w5_01_prior_insert_loss_check_back_commit_reopen`
   (save, approval, reopen). An approval there succeeds only through the server
   signing path; a stack without the wrapping mapping answers
   `WrappingSecretConfigurationPending` (see Enabling online approvals). These
   tests do not read `emr_signing.signed_version` themselves; signature
   verification after a PostgreSQL restore is CI's `ServerSigningPg`
   (`tests/emr/c/server_signing_live.py`). Find the run with
   `gh run list --workflow candidate.yml --json databaseId,displayTitle,conclusion,createdAt`.
   Expected: `displayTitle` `candidate <installed SHA> [g3:<nonce>]` and
   `conclusion` `success`. Record the run ID and the `candidate-<SHA>` artifact
   in the release record. A missing or failed run leaves the check NOT_RUN or
   FAIL; a run of another SHA does not count.
2. **Signing recovery on the installed host: step 4's backup and rehearsal.**
   `rehearse` restores the set's wrapping custody copy and unwraps every restored
   private key with the recorded API image's own `unwrapServerPrivateKey`.
   Expected in its printed JSON, besides `success: true`:
   - custody configured (Nightly job): `wrapping_custody.custody` =
     `restored and verified` and `wrapping_custody.keys` = the row count of
     `emr_signing.private_key`. That count is 0 on a clean install and ≥ 1 after
     the admin's first Create Key (Enabling online approvals). Run a new backup
     and rehearsal after that first key; until then the key is not recoverable;
   - no custody configuration and no keys:
     `{"keys": 0, "custody": "not configured; no stored signing keys"}`. Stored
     keys without custody fail the backup itself.

   When the set's manifest has `wrapping_custody`, `restore-wrapping` (Recovery
   and rehearsal) must print the `c2-wrap-v1` → restored file mapping. A set
   without it has no locator: the command stops with `Wrapping custody locator is
   missing` (`ops_backup.wrapping_custody_files`). Record custody restoration as
   not applicable then, with the rehearsal JSON above as the evidence.
3. **Signing path of the running API on the host.** This applies when the site
   has enabled online approvals: the release record names a
   `wrapping_secret_file`, `/etc/kin-deploy/emr-wrapping-custody.json` exists, or
   `emr_signing.private_key` has rows. Otherwise, record "online approvals not
   enabled". Approvals then answer `WrappingSecretConfigurationPending` (Enabling
   online approvals).

   The check confirms two things:
   - `kin-api` runs with the signing overlay's mapping;
   - its own user reads the mapped file and unwraps every stored private key with
     the product code an approval uses (`FileWrappingSecrets.read`, then
     `unwrapServerPrivateKey`).

   ```python
   import json, tempfile
   api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
   env = dict(entry.split('=', 1) for entry in api['Config']['Env'] if '=' in entry)
   assert env.get('KIN_EMR_WRAPPING_KEY_ID') == 'c2-wrap-v1'
   assert [m['Source'] for m in api['Mounts']
           if m['Destination'] == '/run/secrets/emr-signing-wrap-v1'] == [record['wrapping_secret_file']]
   script = """const {FileWrappingSecrets}=require('/app/dist/emr-signature/server-keys');
   const {unwrapServerPrivateKey}=require('/app/dist/emr-signature/server-crypto');
   (async()=>{const rows=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
   const secrets=new FileWrappingSecrets(process.env.KIN_EMR_WRAPPING_KEY_ID,JSON.parse(process.env.KIN_EMR_WRAPPING_KEY_FILES));
   (await secrets.read(secrets.currentId)).fill(0);
   for(const row of rows){const id=row.wrapped.wrappingKeyId,secret=await secrets.read(id);
   try{unwrapServerPrivateKey(row.wrapped,row.kid,id,secret);}finally{secret.fill(0);}}
   process.stdout.write('SIGNING_PATH_READY '+rows.length);})().catch(()=>{process.exitCode=1;});"""
   with tempfile.TemporaryFile() as rows:
       rows.write(json.dumps(ops.signing_keys('kin-db')).encode())
       rows.seek(0)
       print(ops.run(['docker', 'exec', '-i', 'kin-api', 'node', '-e', script], input_file=rows).stdout.decode())
   ```

   Expected: `SIGNING_PATH_READY <n>`, where `n` is the row count of
   `emr_signing.private_key`. `docker exec` runs as the production image's
   `node` user (`api/Dockerfile`, `USER node`). A file that uid 1000 cannot read,
   a missing overlay or bytes that differ from the stored keys therefore fail
   here, not at a doctor's first approval. The script prints no error text, so no
   key material reaches the log.

The end-to-end signed approval is check 1's synthetic run. Check 3 shows that
the installed API takes the same path to the key. The site's own first signed
approval is a doctor's, not the operator's (AGENTS §1.1). Record its outcome as
the first observation after handover: either a new `emr_signing.signed_version`
row, or the error the doctor saw. No tool performs a save, reopen or signed
approval on the installed host itself. The LiveStack suites run only on a
disposable synthetic stack through `scripts/run-tests.py` (AGENTS §2), not on a
site.

# Rollback to the previous release (N → N-1)

Applies to a host installed and upgraded with the plain Compose list of the clean
installation. A host that runs through the protected entry
(`/opt/kin-deploy/entry.py`) uses that mode's own rollback (tests/README.md, EMR
introduction). The application-only switch-back of `scripts/ops_deploy_runner.py`
(same schema, previous API image, no database restore) needs an installed
operational adapter and a compatibility authorization. Neither exists: its CLI
prints `No operational adapter installed; deployment CLI is unavailable.`

**What is and is not reversible.** Migrations are forward-only. The API image runs
`prisma migrate deploy`, `api/prisma/migrations/` holds no down migration, and
schema reset or db push is not allowed (step 2). Nothing is reverted in place. A
rollback replaces the site's state with the **pre-upgrade backup B** in new
volumes. It does this even when N added no migration, because data that N wrote
can still be unreadable to N-1 (for example tests/README.md, OP-3 a: a saved column
setting from a later build is refused by an earlier one until it is cleared).
Everything written after B is **not** in the rolled-back site:
- reports and their versions;
- images received;
- access and audit rows;
- Keycloak account and password changes;
- signing keys created on N, and the approvals they signed.

All of that stays in N's preserved volumes, plus the N backup taken in step R1
when it succeeds (held, never rotated). No tool merges it into N-1 (see Gaps).
N's volumes are kept, never removed:
- access records keep their 2-year period (개인정보의 안전성 확보조치 기준
  제8조제1항, Recovery and rehearsal);
- record retention follows 의료법 시행규칙 제15조제1항.

The host's wrapping secret files are not changed by the upgrade or by the
rollback. Preflight P5 checks this against B.

**Precondition: the upgrade itself.** Run it in one locked operator session at
N-1, in the form of steps 2–4. The session runs as the account that owns the
backup root. `backup()` refuses any other account, and rotation checks that a
set's components belong to the account that runs it.

1. **Address the running stack exactly.** Take the Compose project and file list
   from N-1's own containers, so the upgrade carries the signing overlay when the
   site uses it:

   ```python
   import json, os
   from pathlib import Path
   api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
   project = api['Config']['Labels']['com.docker.compose.project']
   files = api['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
   secret = [m['Source'] for m in api['Mounts'] if m['Destination'] == '/run/secrets/emr-signing-wrap-v1']
   if secret:
       os.environ['KIN_EMR_WRAPPING_SECRET_FILE'] = secret[0]   # the overlay's required variable
   compose = ['docker', 'compose', '-p', project] + [arg for name in files for arg in ('-f', name)]
   record.update(compose_project=project, compose_files=files, wrapping_secret_file=secret[0] if secret else None)
   ```

   `-p` takes precedence over an inherited `COMPOSE_PROJECT_NAME` and over `.env`
   (Docker Compose's documented precedence; `ops.run` passes the session's
   environment through). The upgrade therefore cannot start a second stack.
2. **Take and hold B.** Run `B = ops.backup('<backup-directory>')`, then
   `ops.rehearse(B)`. Record B's directory and its manifest's `git_sha` (N-1) and
   `running_images`. Then protect B from the nightly rotation for the rollback
   window:
   `ops.write_json(B / ops.HOLD_FILE, {'reason': 'rollback-window', 'release': '<N SHA>'})`.
   - Rotation keeps a set that holds `restore-hold.json` (`ops_backup.rotate`,
     reason `hold`; `tests/ops_backup_rotation_test.py` test_03).
   - A held set is never thinned, and it keeps its custody directory (Nightly
     job).
   - Without the hold, the nightly CLI's seven daily generations
     (`DAILY_GENERATIONS`) would delete B.
3. **Upgrade.** Run `ops.run(['git', 'checkout', '--detach', '<N SHA>'])`. Every
   recorded compose file must exist at N. Then run
   `ops.run(compose + ['up', '-d', '--build'], timeout=install_timeout)` and
   continue with steps 3–4, including check 3 (signing path). `migrate deploy`
   applies only N's new migrations.

Keep the image IDs that B records until the rollback window ends.
`validate_backup` runs `docker image inspect` on them, so after an image prune B
can no longer be restored or rehearsed. When the window ends, remove the hold
with `(B / ops.HOLD_FILE).unlink()` in a locked session as the same account, and
record it. The next rotation then treats B as an ordinary daily set.

**Rollback.** Run it in one operator Python session in the site checkout, still
at N, as for steps 2–4: `ops.lock()`, `hold.__enter__()`,
`ops.require_local_docker()`, and the observed values compared and recorded. The
session runs as the account that owns the backup root (see the precondition).

Restoring into N's volumes would overwrite them. The site therefore gets a new
Compose project R, with fresh empty volumes, while N's volumes remain.

**Preflight, while N keeps serving.** Nothing is stopped, switched or written
outside the private record.

```python
import hashlib, json, os, shutil
from pathlib import Path
backup_set = Path('<B>')
previous_sha = '<N-1 full SHA>'
R = '<new project name>'   # lower-case letters, digits, '-' or '_'; not N's project
directory, manifest = ops.validate_backup(backup_set)   # P1: checksums, archive entries, recorded images present
assert manifest['git_sha'] == previous_sha and manifest['git_dirty'] is False
assert manifest.get('emr') and manifest.get('role_catalog') is not None   # otherwise: Gaps, no live restore path
os.environ.pop('COMPOSE_PROJECT_NAME', None)   # P6, with -p below
api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
n_files = api['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
n_project = api['Config']['Labels']['com.docker.compose.project']
compose_n = ['docker', 'compose', '-p', n_project] + [arg for name in n_files for arg in ('-f', name)]
compose_r = ['docker', 'compose', '-p', R] + [arg for name in record['compose_files'] for arg in ('-f', name)]
```

`record['compose_files']` and `record['wrapping_secret_file']` are N-1's values,
recorded at the upgrade (precondition step 1).

- **P1. Validate B** (above).
- **P2. Rehearse B.** Run `ops.rehearse(directory)`. Expected: `success: true`, as
  in step 4.
- **P3. Configuration.**
  - Each recorded compose file must exist at N-1:
    `ops.run(['git', 'cat-file', '-e', f'{previous_sha}:{Path(name).relative_to(ops.ROOT).as_posix()}'])`.
  - N-1's compose files must equal B's copies:
    `hashlib.sha256(ops.run(['git', 'show', f'{previous_sha}:{name}']).stdout).hexdigest() == manifest['sha256'][name]`
    for `docker-compose.yml` and `docker-compose.prod.yml`.
  - Compare `ops.digest(ops.ROOT / '.env')` with `manifest['sha256']['.env']`.
    If they differ (N changed its configuration), R uses B's own checksummed
    copy `directory / '.env'`. B's Keycloak database, client secrets and
    PostgreSQL roles were made with that copy. Record that `.env` differs; do not
    record its values.
- **P4. R is unused.** Both commands must print nothing:
  - `ops.text(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={R}'])`
  - `ops.text(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={R}'])`

  Also, `ops.run(['docker', 'volume', 'inspect', f'{R}_{v}'], check=False).returncode`
  must be non-zero for each of `pg-db`, `emr-access`, `orthanc-db` and
  `emr-state`. Compose names a project's volumes `<project>_<volume>`
  (`docker-compose.yml`), and it reuses an existing volume of that name. An old
  database or tablespace volume would make R4's restore refuse the cluster, or
  start N-1 on foreign data.
- **P5. Signing.**
  - If B's manifest has `wrapping_custody`: run
    `ops.digest(Path(record['wrapping_secret_file']))`. It must equal
    `manifest['wrapping_custody']['files']['c2-wrap-v1']['sha256']`. If the host
    file is gone or differs, restore it from custody instead: run
    `restore-wrapping` into a new directory (Recovery and rehearsal), then
    `chown 1000:1000` and `chmod 0400` (Enabling online approvals). Use that path
    as `record['wrapping_secret_file']` and in the custody configuration's
    `files` entry (Nightly job).
  - If B has no custody and no keys, and N-1 ran without the overlay, R runs
    without it too. Record signing as not enabled.
  - If R uses the overlay, run
    `os.environ['KIN_EMR_WRAPPING_SECRET_FILE'] = record['wrapping_secret_file']`.
    Compose stops on the overlay's missing variable, even for `down`.
- **P6. Project pinning.** Every command below uses `compose_n` or `compose_r`,
  each with `-p`. An inherited `COMPOSE_PROJECT_NAME` cannot redirect them, and
  the session no longer carries one.

If any preflight step fails, nothing has changed. Record
`ROLLBACK_NOT_STARTED` with the cause, release the lock normally (not retained),
and N keeps serving. Correct the cause and repeat the preflight. Only after the
preflight passes:

```python
lease.retain()
record.update(status='ROLLING_BACK', rollback_project=R, n_project=n_project, n_compose_files=n_files)
ops.write_json(record_path, record)
```

- **R1. Preserve N.** If N's containers run, call
  `N_set = ops.backup('<backup-directory>')`. Keep the printed set even when the
  call raises after `"complete": true` (a readiness failure of N). Hold that set
  with `ops.write_json(N_set / ops.HOLD_FILE, {'reason': 'rolled-back release', 'release': '<N SHA>'})`.
  Beside N's volumes, it is the only copy of what N wrote after B. Its hold has
  no end date: removing it is a separate retention decision.

  If N could not be backed up, copy the current `.env` (N's) into the private
  record's directory with mode 0600. Then run `ops.run(compose_n + ['down'])`.
  Do not pass `-v`: N's named volumes stay under N's Compose project. Record
  `ops.text(['docker', 'volume', 'ls', '--filter', f'label=com.docker.compose.project={n_project}'])`.
- **R2. Check out N-1 and set its configuration.** Run
  `ops.run(['git', 'checkout', '--detach', previous_sha])`. If P3 found `.env`
  different, run `shutil.copyfile(directory / '.env', ops.ROOT / '.env')` and
  `(ops.ROOT / '.env').chmod(0o600)`.

  Then add `COMPOSE_PROJECT_NAME=<R>` to `.env`, or replace an existing line, so
  that a later plain `docker compose` in the checkout also addresses R. Record R
  and the site's new compose list (`compose_r`) in the release record. Future
  upgrades read both from R's containers (precondition step 1).

  Container names are fixed, so the nightly `backup` follows R unchanged.
- **R3. Start the empty cluster alone:**
  `ops.run(compose_r + ['up', '-d', '--wait', 'db'])`. Its init creates the empty
  `kin` and `keycloak` databases and the tablespace directory.
- **R4. Restore PostgreSQL** with the daily set's own restore, the one `rehearse`
  uses:

  ```python
  source, outside = ops.daily_set_catalog(manifest['role_catalog'])
  print(ops.restore_snapshot('kin-db', directory, 'kin', 'post', source=source))
  assert all(ops.counts('kin-db', db, 'kin') == manifest['counts'][db] for db in ops.PRE_DATABASES)
  assert ops.emr_catalog('kin-db', 'kin') == json.loads((directory / 'emr-catalog.json').read_text(encoding='utf-8'))
  print([row[0] for row in ops.migration_rows('kin-db')][-1])   # N-1's last migration
  ```

  `restore_snapshot` refuses a cluster that is not fresh or has a non-empty
  database. Expected: `{"roles_created": [...], "memberships_granted": n, "catalog": "equal"}`,
  `outside` = `[]`, and the last migration equal to the last folder of
  `git ls-tree --name-only <N-1> api/prisma/migrations/`.
- **R5. Restore Orthanc and the EMR state into R's new volumes.** First build
  N-1 and create R's containers without starting them:
  `ops.run(compose_r + ['up', '--no-start', '--build'], timeout=install_timeout)`.
  Read the volume names from the mounts, as `backup()` does:
  - `orthanc_volume` is the `kin-orthanc` mount at `/var/lib/orthanc/db`;
  - `state_volume` is the `kin-api` mount at `/var/lib/kin-emr`.

  Read them with `json.loads(ops.text(['docker', 'inspect', name]))[0]['Mounts']`.
  They must be `f'{R}_orthanc-db'` and `f'{R}_emr-state'`. Then extract with
  `rehearse`'s own helper:

  ```python
  for volume, archive in ((orthanc_volume, 'orthanc.tgz'), (state_volume, 'emr-state.tgz')):
      ops.temporary_run(['--network', 'none', '--read-only', '--mount', f'type=volume,source={volume},target=/restore',
                         '--mount', f'type=bind,source={directory},target=/backup,readonly', '--entrypoint', 'tar',
                         manifest['postgres_image'], '-xzf', '/backup/' + archive, '-C', '/restore'], timeout=1800)
  print(ops.temporary_run(['--network', 'none', '--read-only', '--mount', f'type=volume,source={orthanc_volume},target=/restore,readonly',
                           '--entrypoint', 'python3', manifest['orthanc_image'], '-c', ops.SQLITE_CHECK], timeout=300))
  ```

  Expected: `{"integrity": "ok", "attachments": n, ...}`, with `n` equal to B's
  rehearsal receipt.
- **R6. Start N-1 without the entry, expire, then open.**
  1. Run `ops.run(compose_r + ['up', '-d', 'api'], timeout=install_timeout)`. This
     starts `db`, `emr-provision`, `api-migrate`, `keycloak`, `orthanc` and `api`
     through `depends_on`. It does not start `proxy`, which is the only business
     entry: `docker-compose.prod.yml` publishes no API port, and Orthanc and
     Keycloak listen on 127.0.0.1 only.
  2. Check that `kin-api-migrate` and `kin-emr-provision` exit 0, with
     `ops.text(['docker', 'inspect', '--format', '{{.State.ExitCode}}', name])`.
     The migrate log (`ops.text(compose_r + ['logs', 'api-migrate'])`) shows
     `No pending migrations to apply.`, because the restored history is N-1's.
  3. Run the restored-copy expiry sweep in the same order as `rehearse_held`: the
     ledger is ready, then `restored_emr_expiry`.

     ```python
     ops.resumed_ledger_ready(120)   # backup()'s default readiness bound
     sweep = ops.restored_emr_expiry('kin-db', 'kin')
     assert sweep.get('ran') is True   # rehearse: "Restored expiry sweep did not run before business use"
     record['expiry_sweep'] = sweep
     ops.write_json(record_path, record)
     ```

     The sweep removes access and failure rows past their period, unless a hold
     or an open duty request keeps them. It keeps history rows that have no
     ending evidence and counts them (Recovery and rehearsal). The API's own
     startup does not run it.
  4. Open the entry: `ops.run(compose_r + ['up', '-d'], timeout=install_timeout)`.
- **R7. Verify as in steps 3–4.**
  - Run the bounded HTTPS readiness check and the synthetic save/reopen and
    signing checks above.
  - For check 1, use the G3 run of N-1.
  - For check 3, expect `n` = B's `emr_signing.private_key` count.
  - Then take R's first populated backup and `rehearse` it. Run the custody
    commands when its manifest has `wrapping_custody`; otherwise record them as
    not applicable.

  Only then record `status=ROLLED_BACK` with the evidence paths, and release the
  lock as in step 4.

**Failure after R1 (N stopped).** Keep the lock and record `NEEDS_ATTENTION`.
Never remove a volume of N or R without inspection. B and N's set stay held.
Then take one of two ways:
- **Forward with a new project.** Use this from R3 onwards. A partly restored R is
  no longer a fresh cluster, and `restore_snapshot` refuses it.
  1. Run `ops.run(compose_r + ['down'])` without `-v`; R's volumes stay for
     inspection.
  2. Choose R′, repeat P4 for it, and build `compose_r` with `-p R′`.
  3. Set `.env`'s `COMPOSE_PROJECT_NAME`, then continue from R3.

  For a failure in R6 or R7 whose cause is outside the data (configuration,
  readiness), correct it and repeat that step on R.
- **Back to N.**
  1. Run `ops.run(compose_r + ['down'])` without `-v`.
  2. Run `ops.run(['git', 'checkout', '--detach', '<N SHA>'])`.
  3. Put back N's `.env`, from N's set or the saved copy.
  4. Set `KIN_EMR_WRAPPING_SECRET_FILE` to N's mount source when N used the
     overlay.
  5. Run `ops.run(compose_n + ['up', '-d'], timeout=install_timeout)`.

  N's volumes are unchanged, because R1's `down` kept them. Then run step 3's
  readiness check and check 3 before reopening. Record `ROLLBACK_ABANDONED`.

A host keeps one serving stack: the container names are fixed (`kin-db`, `kin-api`,
…), so N and R cannot run at the same time. This section does not claim that a
rollback was executed by this documentation change.

**Gaps (no existing tool; not invented here):**
- There is no single restore command for a daily set into a live site. R3–R6
  compose the existing `ops_backup` functions that `rehearse` runs in its isolated
  copy. Until a rehearsal runs this section, these remain unverified:
  - whether `up --no-start --build` leaves the running `db` as it is;
  - whether a live Orthanc and API accept the file ownership that the tar
    extraction leaves;
  - whether R's `proxy` can create the fixed-name `kin-workflow` network
    (`docker-compose.prod.yml`) while the separately managed workflow receiver
    stays attached to N's network;
  - whether the Compose label `com.docker.compose.project.config_files` names the
    files exactly as the site invoked them (no tool in the repository reads it
    yet).

  A failure in any of these shows at R5–R7.
- No tool brings data written on N after B into the rolled-back N-1 site.
- A daily set without `role_catalog` (made before D23) has no live restore path.
  `restore_snapshot` needs that catalog. The older sets' `pg_dumpall` role replay
  is refused by PostgreSQL 16 for a `GRANTED BY kin` membership
  (`ops_backup.rehearse`, tests/README.md D23).
- No tool performs a save, reopen or signed approval on the installed host.
  Check 3 shows only that the running API can reach every stored key
  (Synthetic save/reopen and signing checks).

# Online signing keys: backup and restore

The per-doctor encrypted private keys are in `kin.emr_signing.private_key`;
`doctor_key`, `key_history` and `signed_version` retain their registration and
verification evidence. Clinical records are in `emr_clinical`, issuance fixed
copies and audit events in `emr_audit`, image preparation records in `emr_image`.
The daily `scripts/ops_backup.py backup` and its `rehearse` compare every table in
`public`, `emr_access`, `emr_signing`, `emr_clinical`, `emr_audit` and `emr_image`,
using the captured counts, not fixed totals; a restored copy missing a row fails.

Wrapping bytes stay outside PostgreSQL and its backup directory. The deployed
`FileWrappingSecrets` mapping must use the same key IDs and bytes as the custody
configuration. The C2 handoff uses ID `c2-wrap-v1` mounted at
`/run/secrets/emr-signing-wrap-v1`; a host source path must be supplied by the
installation operator. This runbook does not claim that any site is configured.

## Enabling online approvals

`emr/deploy/docker-compose.signing.yml` is that mapping for the API container. On
the host, keep one raw 32-byte file per wrapping ID (the file the custody
configuration's `files` entry for `c2-wrap-v1` names), readable by the API
container user only (`node`, uid 1000 in the production image: `chown 1000:1000`,
`chmod 0400`). Merge the overlay after the stack's own files with
`KIN_EMR_WRAPPING_SECRET_FILE` set to that absolute path, for example:

```sh
KIN_EMR_WRAPPING_SECRET_FILE=/srv/kin-signing-secrets/emr-signing-wrap-v1 \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml -f emr/deploy/docker-compose.signing.yml up -d api
```

A missing variable or file stops Compose; nothing creates replacement bytes. A
stack started without the overlay still serves its other work and answers each
approval with `WrappingSecretConfigurationPending`. The production introduction
tooling's fixed Compose list does not include this overlay yet; adding it there is
part of the approved operational activation, not of this file.

Each doctor's key is then created by the institution's admin: Members → the
member's **Signing Key** → Create Key (Rotate Key replaces it, Retire Key ends it;
each needs a reason). Doctors approve as before with no extra step. Every change
is one `server:doctor-key-management` entry of the access ledger (Access Review),
and earlier signatures keep verifying from the retained public keys. Because the
new private key is wrapped with `c2-wrap-v1`, the next nightly backup must succeed
with this custody configuration before the change is considered recoverable.

## Nightly job

Install a private JSON configuration at `/etc/kin-deploy/emr-wrapping-custody.json`,
using `emr/deploy/wrapping-custody.example.json` as the shape. Both the nightly
backup and the installed release entry read this location; the release entry
clears its environment. A direct invocation can override the configuration path
with `KIN_EMR_WRAPPING_CUSTODY`. `files` maps **all** current and historical wrapping
IDs still used by stored private keys to their absolute host file paths. Each is
the existing raw 32-byte wrapping secret; do not generate replacement bytes for
recovery. `backup_root` is a separate custody location, outside the checkout and
outside the database backup root, writable by the existing backup account.

Run the existing command:

```sh
python3 scripts/ops_backup.py backup --output /srv/kin-backups
```

While writers are paused, the tool copies the configured secrets to
`<backup_root>/<backup-set-name>/wrap-N.key` and records the absolute directory,
key-ID-to-file mapping and checksums in the database set's
`manifest.json` → `wrapping_custody`. That is the exact recovery locator.
Missing configuration when private keys exist, missing IDs, missing files or
invalid key lengths fail the backup; writers still resume through the existing
cleanup path. Held release captures use the same custody function.

Custody directories are not included in ordinary database export. Daily
rotation removes a deleted set's custody directory after the set itself, so an
interrupted removal never leaves a set without its key copy; a cleanup failure is
reported as `custody_cleanup_pending`. Thinned, held, protected and other retained
sets keep their custody directory. Rotation removes only
`<backup_root>/<set-name>` under the configured `backup_root` holding exactly the
recorded `wrap-N.key` files; a set whose custody is elsewhere (for example after
`backup_root` changed) or differs is kept and the run stops as `preserved-stop`.
Moving a snapshot to another host requires moving its custody directory too. Give
the new location with `--source` / `--wrapping-source` below; do not edit the
set's manifest. This unit does not enable offsite transfer or change the
external-backup OFF decision.

## Recovery and rehearsal

Restore the database as in Rollback to the previous release (R3–R6) or, for a
host behind the protected entry, with that mode's rollback. When the set's
manifest has `wrapping_custody`, restore the wrapping files into a new directory
before enabling online approvals. A set without it has no stored keys and no
locator; record custody restoration as not applicable, as in check 2 of the
synthetic checks.

```sh
python3 scripts/ops_backup.py restore-wrapping /srv/kin-backups/SET --destination /srv/kin-signing-restored/SET
python3 scripts/ops_backup.py rehearse /srv/kin-backups/SET
# custody moved to this host at another path:
python3 scripts/ops_backup.py restore-wrapping /srv/kin-backups/SET --source /mnt/custody/SET --destination /srv/kin-signing-restored/SET
python3 scripts/ops_backup.py rehearse /srv/kin-backups/SET --wrapping-source /mnt/custody/SET
```

The first command checks the custody files against the snapshot and prints only
the restored ID/path mapping. It reads every custody file before creating the
destination, so a missing or changed file leaves no partial directory. Point
`KIN_EMR_WRAPPING_SECRET_FILE` of the signing overlay (above) at the restored
`c2-wrap-v1` file. The command refuses to overwrite an existing destination.

Rehearsal restores its own temporary custody copy using that same locator, checks
all restored table counts and calls the existing product key-unwrapping function
for every restored private key using the recorded API image. Missing or wrong
custody fails rehearsal. Before the restored copy counts as verified it runs the
existing `emr_access.restore_expiry_sweep`: access and failure rows past their
period (개인정보의 안전성 확보조치 기준 제8조제1항, 2 years) are removed unless a hold
or open duty request keeps them, and history rows without ending evidence are kept
and counted. Record retention stays at 의료법 시행규칙 제15조제1항. Its receipt records
`wrapping_custody`, `emr.expiry_sweep` and `success`; secret bytes are never printed. Existing signatures retain public verification
evidence, but successful DB restoration alone does not certify new approvals.
