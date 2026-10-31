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
   hang timeout (seconds). Until the site has its own measurement, use
   `install_timeout = 2400` and `backup_timeout = 600` (R7), the values the
   2026-10-31 rehearsal ran with; 600 s is also the existing base-backup helper
   hang timeout (below step 4). Define `clean_env`, `compose_for` and
   `config_matches` from [Site Compose command](#site-compose-command).

   Put `KIN_REVISION=<selected full SHA>` in the checkout's `.env` before the
   build. The API image's revision label comes only from it
   (`VCS_REF: ${KIN_REVISION:-unknown}`, `docker-compose.prod.yml`), because
   `clean_env` drops an exported value. `.env` is not tracked, so `backup()`
   does not count the change as a dirty checkout.

   Decide signing before Compose starts. Online approvals are enabled at
   installation exactly when the custody configuration
   `/etc/kin-deploy/emr-wrapping-custody.json` is installed (Nightly job). Its
   `c2-wrap-v1` file is then prepared as Enabling online approvals requires, and
   the stack starts with the signing overlay mapping that same file. Without the
   configuration the stack starts without the overlay. Persist the hold and the
   decision before starting Compose:

   ```python
   import re
   assert 'KIN_EMR_WRAPPING_CUSTODY' not in os.environ   # backups in this session read only the installed configuration
   project = ops.ROOT.name                                # a plain invocation in the checkout then names the same project
   assert re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project)
   assert 'COMPOSE_PROJECT_NAME' not in ops.env_names(ops.ROOT / '.env')
   secret_file = None
   if ops.WRAPPING_CUSTODY_CONFIG.is_file():
       secret_file = json.loads(ops.WRAPPING_CUSTODY_CONFIG.read_text(encoding='utf-8'))['files']['c2-wrap-v1']
   files = ['docker-compose.yml', 'docker-compose.prod.yml'] + ([SIGNING_OVERLAY] if secret_file else [])
   compose = compose_for(project, ops.ROOT, files, secret_file)
   lease.retain()
   record.update(status='STARTED', compose_project=project, compose_files=files, wrapping_secret_file=secret_file)
   ops.write_json(record_path, record)
   ops.run(compose + ['up', '-d', '--build'], timeout=install_timeout)
   ```

   A host that must not build (its CPU and memory are shared with other
   services) loads images built elsewhere instead and drops `--build`, as in
   upgrade step 3 below.

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

## Site Compose command

Installation, upgrade, enabling online approvals and rollback start Compose only
in this form. Each Compose project is then fully described by its checkout
directory, that directory's `.env`, its compose file list and at most one
signing file path:
- `env -i` drops every inherited variable, so an exported `POSTGRES_PASSWORD`,
  `KC_WEB_SECRET` or `COMPOSE_PROJECT_NAME` cannot override `.env`. Docker's
  interpolation precedence puts the shell environment above `.env`.
- Only what the Docker client itself needs passes through.
- The signing overlay's one variable is given explicitly, and only together with
  the overlay.

```python
import json, os
from pathlib import Path
SIGNING_OVERLAY = 'emr/deploy/docker-compose.signing.yml'

def clean_env(*assignments):
    keep = [f'{name}={os.environ[name]}' for name in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG')
            if name in os.environ]
    return ['env', '-i', *keep, *assignments]

def compose_for(project, directory, files, secret_file):
    """files: paths relative to directory, in merge order; secret_file: the c2-wrap-v1 host file, or None."""
    assert (SIGNING_OVERLAY in files) == bool(secret_file)
    directory = Path(directory)
    signing = [f'KIN_EMR_WRAPPING_SECRET_FILE={secret_file}'] if secret_file else []
    return (clean_env(*signing) + ['docker', 'compose', '-p', project, '--project-directory', str(directory),
                                   '--env-file', str(directory / '.env')]
            + [arg for name in files for arg in ('-f', str(directory / name))])

def config_matches(compose, project):
    """The cleaned environment reaches this session's daemon, and every existing container of the project carries
    the configuration hash this command renders."""
    probe = ['docker', 'info', '--format', '{{.ID}}']
    daemon = ops.text(probe)
    if not daemon or ops.text(clean_env() + probe) != daemon:
        return False
    rendered = dict(line.split(' ', 1) for line in ops.text(compose + ['config', '--hash', '*']).splitlines())
    ids = ops.text(clean_env() + ['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}']).split()
    labels = ([item['Config']['Labels'] for item in json.loads(ops.text(clean_env() + ['docker', 'inspect', *ids]))]
              if ids else [])
    return bool(labels) and all(rendered.get(label['com.docker.compose.service']) == label['com.docker.compose.config-hash']
                                for label in labels)
```

`config_matches` compares hashes only, so no configuration value reaches the
log. Compose stores the same service hash in each container's
`com.docker.compose.config-hash` label when it creates the container. Equality
therefore means the command reproduces the running configuration, including
interpolated credentials. The hash leaves out build settings. A different
Compose version can compute it differently. The observed `docker compose version`
is compared with the release record before any of this runs.

Every Docker read in `config_matches` runs under `clean_env`, as Compose will.
It first compares the daemon ID that `docker info` reports under `clean_env` with
the one this session reaches. A cleaned environment that reaches no daemon fails
the command. One that reaches another daemon, or reports an empty ID, returns
`False`. Either way the check fails before anything changes.

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
3. **Signing path of the running API on the host.** `secret_file` is the host
   path the stack was started with (`None` without the overlay):
   - after installation, an upgrade or Enabling online approvals:
     `record['wrapping_secret_file']`;
   - in rollback R7: `record['rollback_secret_file']`;
   - on the way back to N: `record['n_secret_file']`.

   The check applies when `secret_file` is set,
   `/etc/kin-deploy/emr-wrapping-custody.json` exists, or
   `emr_signing.private_key` has rows. Otherwise, record "online approvals not
   enabled". Approvals then answer `WrappingSecretConfigurationPending` (Enabling
   online approvals).

   The check confirms three things:
   - the custody configuration, which the nightly backup copies, names the same
     `c2-wrap-v1` file;
   - `kin-api` runs with the signing overlay's mapping of that file;
   - its own user reads the mapped file and unwraps every stored private key with
     the product code an approval uses (`FileWrappingSecrets.read`, then
     `unwrapServerPrivateKey`).

   ```python
   import json, tempfile
   custody = json.loads(ops.WRAPPING_CUSTODY_CONFIG.read_text(encoding='utf-8'))
   assert secret_file and custody['files'].get('c2-wrap-v1') == secret_file
   api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
   env = dict(entry.split('=', 1) for entry in api['Config']['Env'] if '=' in entry)
   assert env.get('KIN_EMR_WRAPPING_KEY_ID') == 'c2-wrap-v1'
   assert [m['Source'] for m in api['Mounts']
           if m['Destination'] == '/run/secrets/emr-signing-wrap-v1'] == [secret_file]
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
   a missing overlay, a custody configuration naming another file, or bytes that
   differ from the stored keys therefore fail here, not at a doctor's first
   approval or a later restore. The script prints no error text, so no key
   material reaches the log.

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
installation. The production host that runs a86ecf1 through the protected entry
(`/opt/kin-deploy/entry.py`) reaches the plain form, at N, only through
[One-time upgrade of the a86ecf1 host](#one-time-upgrade-of-the-a86ecf1-host),
which has its own rollback; this section applies there from N onward. The
application-only switch-back of `scripts/ops_deploy_runner.py`
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
(held, never rotated). No tool merges it into N-1 (see Gaps).
N's volumes are kept, never removed:
- access records keep their 2-year period (개인정보의 안전성 확보조치 기준
  제8조제1항, Recovery and rehearsal);
- record retention follows 의료법 시행규칙 제15조제1항.

**How the rollback is built.** Three rules apply to every step below.
1. **N is only stopped, never reconfigured.** N's checkout directory (its HEAD,
   `.env` and compose files), its project, volumes and signing file are left as
   they are. Preflight P3 proves that the recorded command `compose_n` renders
   N's running configuration exactly. `compose_n down` therefore stops N as it
   runs, and on the way back `compose_n up -d` restarts it unchanged.
2. **R is built only from B.** The rolled-back release runs as a new Compose
   project R from **its own new checkout directory** at N-1 (a `git worktree`
   named R). Its `.env` is B's checksummed copy. Its signing files are restored
   from B's custody into a new directory, and its custody configuration is
   staged as a new file. That configuration is activated in R7, after N has
   stopped and R's API has proved the files. N's custody configuration is kept
   as a copy for the way back.
3. **No inherited environment.** Every Compose command is `compose_for`
   ([Site Compose command](#site-compose-command)). R's backups run with R's
   own `scripts/ops_backup.py` under `clean_env`.

The restored-copy expiry sweep runs after the running API has finished its own
recovery, while the proxy is still not started (R6).

A host keeps one serving stack: the container names are fixed (`kin-db`, `kin-api`,
…), so N and R cannot run at the same time. This section does not claim that a
rollback was executed by this documentation change.

**Precondition: the upgrade itself.** Run it in one locked operator session in the
site checkout at N-1, in the form of steps 2–4. Define `clean_env`, `compose_for`
and `config_matches` there too, and check that the session does not carry
`KIN_EMR_WRAPPING_CUSTODY` (step 2). The session runs as the account that owns the
backup root. `backup()` refuses any other account, and rotation checks that a set's
components belong to the account that runs it.

1. **Address the running stack exactly.** Take the Compose project, file list and
   signing file from N-1's own containers. Then prove that the clean command
   reproduces them:

   ```python
   api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
   labels = api['Config']['Labels']
   assert Path(labels['com.docker.compose.project.working_dir']).resolve() == ops.ROOT
   project = labels['com.docker.compose.project']
   files = []
   for name in labels['com.docker.compose.project.config_files'].split(','):
       path = Path(name).resolve()
       files.append(path.relative_to(ops.ROOT).as_posix() if path.is_relative_to(ops.ROOT) else str(path))
   outside_files = {name: ops.digest(Path(name)) for name in files if Path(name).is_absolute()}
   mount = [m['Source'] for m in api['Mounts'] if m['Destination'] == '/run/secrets/emr-signing-wrap-v1']
   secret_file = mount[0] if mount else None
   compose = compose_for(project, ops.ROOT, files, secret_file)
   assert config_matches(compose, project)   # N-1 runs exactly what its directory's .env and files say
   record.update(compose_project=project, compose_files=files, outside_files=outside_files,
                 wrapping_secret_file=secret_file, config_matched=True)
   ```

   A stack started with exported variables, or with a file list other than its
   labels, fails here, before B is taken. Correct the cause first. B's `.env` then
   provably reproduces the configuration that N-1 ran with (including its
   PostgreSQL, Keycloak and client credentials), and a rollback can rely on it.
   The checkout's own files are relative, so they follow the checkout to N and
   R's checkout to N-1. A file outside the checkout (a host overlay such as
   `/etc/kin-deploy/overlays/…`) stays absolute; `compose_for` takes it as it is.
   Neither git nor B holds it, so its sha256 is recorded here, and step 3, P3 and
   P5 compare it.
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

   Then keep B's images with one tag each, before anything is loaded or built:

   ```python
   b_manifest = json.loads((B / 'manifest.json').read_text(encoding='utf-8'))
   hold_tags = []
   for container, image in b_manifest['running_images'].items():
       tag = f"kin-rollback-hold/{container}:{b_manifest['git_sha'][:12]}"
       ops.run(['docker', 'tag', image['id'], tag])
       hold_tags.append(tag)
   record.update(backup_set=str(B), rollback_hold_tags=hold_tags)
   ops.write_json(record_path, record)
   ```

   The upgrade's `up` can delete the N-1 image that B records. In the 2026-10-31
   rehearsal (containerd image store) `up -d --build` moved the `<project>-api`
   tag to N's image and N-1's image ceased to exist; `validate_backup` then
   stopped P1 at `docker image inspect`, and no rollback was possible. With
   these tags the same rollback passed.
3. **Upgrade.** Set `KIN_REVISION=<N SHA>` in `.env` (step 2). Choose how N's
   images arrive. A host that builds sets `build = ['--build']`. A host that
   must not build (the production host: 2 vCPU, no swap, shared with other
   services) loads them, after B's hold tags. Build them on another host from a
   checkout at N whose directory has the site checkout's name (the project name,
   so the images are `<project>-api`, `<project>-api-migrate` and
   `<project>-proxy`) and whose `.env` has `KIN_REVISION=<N SHA>`. Save them with
   `docker save -o <file> <project>-api <project>-api-migrate <project>-proxy`.
   On the site:

   ```python
   ops.run(['docker', 'load', '-i', '<file>'], timeout=install_timeout)
   revision = '{{index .Config.Labels "org.opencontainers.image.revision"}}'
   assert all(ops.text(['docker', 'image', 'inspect', '--format', revision, f'{project}-{service}']) == '<N SHA>'
              for service in ('api', 'api-migrate'))   # the proxy image carries no revision label
   build = []   # up -d uses the loaded names; a missing name would make up build on the host
   ```

   Then upgrade:

   ```python
   lease.retain()   # as in step 2: the hold persists before the checkout or the stack changes
   record.update(status='STARTED', release_sha='<N SHA>')
   ops.write_json(record_path, record)
   ops.run(['git', 'checkout', '--detach', '<N SHA>'])
   assert all(ops.digest(Path(name)) == sha for name, sha in record['outside_files'].items())
   ops.run(compose + ['up', '-d', *build], timeout=install_timeout)
   ```

   Every recorded compose file inside the checkout must exist at N. Then
   continue with steps 3–4, including check 3 (signing path). `migrate deploy`
   applies only N's new migrations.

Keep the image IDs that B records until the rollback window ends; step 2's tags
do this, and no image is pruned in the window. `validate_backup` runs
`docker image inspect` on them, so without them B can no longer be restored or
rehearsed. When the window ends, remove the hold with
`(B / ops.HOLD_FILE).unlink()` in a locked session as the same account, then the
tags with `ops.run(['docker', 'image', 'rm', *record['rollback_hold_tags']])`
(an image is deleted only when no other tag or container uses it), and record
both. The next rotation then treats B as an ordinary daily set.

**Rollback session.** Open one operator Python session in the site checkout, still
at N, as for steps 2–4:
- `ops.lock()`, `hold.__enter__()` and `ops.require_local_docker()`;
- the observed values compared with the record, and recorded;
- `clean_env`, `compose_for` and `config_matches` defined;
- `'KIN_EMR_WRAPPING_CUSTODY' not in os.environ` checked.

The session runs as the account that owns the backup root (see the precondition).
N's lock in this checkout also keeps the nightly job, which runs in this checkout,
out until R7 points it at R. Load the upgrade's release record with
`record = json.loads(record_path.read_text(encoding='utf-8'))`.

**Preflight, while N keeps serving.** Nothing of N is stopped, switched or
reconfigured. Preflight writes only new paths:
- the private record;
- R's checkout directory (P6);
- R's staged signing directory and custody configuration (P7).

```python
import contextlib, hashlib, io, re, shutil, subprocess, sys, time
backup_set = Path('<B>')
previous_sha = '<N-1 full SHA>'
n_sha = ops.text(['git', 'rev-parse', 'HEAD'])
R = '<new project name>'             # lower-case letters, digits, '-' or '_'; not N's project
R_dir = ops.ROOT.parent / R          # R's own checkout; its name is its project name
R_signing = Path('<new directory>')  # outside both checkouts and both backup roots
R_custody = Path('<new file>')       # R's custody configuration, beside the private record
backup_root = '<backup-directory>'   # the daily backup root (B's parent)
```

- **P1. Validate B and the upgrade's evidence.**

  ```python
  directory, manifest = ops.validate_backup(backup_set)   # checksums, archive entries, recorded images present
  assert manifest['git_sha'] == previous_sha and manifest['git_dirty'] is False
  assert manifest.get('emr') and manifest.get('role_catalog') is not None   # otherwise: Gaps, no live restore path
  assert record.get('config_matched') is True and record['compose_files']   # precondition step 1
  ```

- **P2. Rehearse B.** Run `ops.rehearse(directory)`. Expected: `success: true`, as
  in step 4.
- **P3. N is addressable as it runs.**

  ```python
  api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
  labels = api['Config']['Labels']
  assert Path(labels['com.docker.compose.project.working_dir']).resolve() == ops.ROOT
  n_project = labels['com.docker.compose.project']
  n_files = []
  for name in labels['com.docker.compose.project.config_files'].split(','):
      path = Path(name).resolve()
      n_files.append(path.relative_to(ops.ROOT).as_posix() if path.is_relative_to(ops.ROOT) else str(path))
  assert ({name: ops.digest(Path(name)) for name in n_files if Path(name).is_absolute()}
          == record.get('outside_files', {}))   # precondition step 1's sha256 of each file outside the checkout
  mount = [m['Source'] for m in api['Mounts'] if m['Destination'] == '/run/secrets/emr-signing-wrap-v1']
  n_secret_file = mount[0] if mount else None
  compose_n = compose_for(n_project, ops.ROOT, n_files, n_secret_file)
  assert config_matches(compose_n, n_project)
  ```

  N's signing file is N's own mount source. It is taken from N, never from N-1's
  record or R's files. The hash comparison covers every N container, including
  the exited `kin-api-migrate` and `kin-emr-provision`. `compose_n` therefore
  interpolates completely for `down`, and it restarts N unchanged on the way
  back.
- **P4. R is unused.**
  - `re.fullmatch(r'[a-z0-9][a-z0-9_-]*', R)` must hold, with `R != n_project`.
  - `R_dir` must not exist.
  - Both commands must print nothing:
    - `ops.text(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={R}'])`
    - `ops.text(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={R}'])`
  - `ops.run(['docker', 'volume', 'inspect', f'{R}_{v}'], check=False).returncode`
    must be non-zero for each of `pg-db`, `emr-access`, `orthanc-db` and
    `emr-state`.

  Compose names a project's volumes `<project>_<volume>` (`docker-compose.yml`),
  and it reuses an existing volume of that name. An old database or tablespace
  volume would make R4's restore refuse the cluster, or start N-1 on foreign
  data.
- **P5. N-1's configuration, from B.**
  - Each recorded compose file inside the checkout must exist at N-1:
    `ops.run(['git', 'cat-file', '-e', f'{previous_sha}:{name}'])` for each
    `name` in `record['compose_files']` that is not an absolute path. Each
    absolute one (outside the checkout) must still have the sha256 that
    precondition step 1 recorded:
    `ops.digest(Path(name)) == record['outside_files'][name]`. R reads that same
    host file, so it is the file N-1 ran with. It is not in N-1's tree, so
    `git cat-file` would stop here.
  - N-1's compose files must equal B's copies:
    `hashlib.sha256(ops.run(['git', 'show', f'{previous_sha}:{name}']).stdout).hexdigest() == manifest['sha256'][name]`
    for `docker-compose.yml` and `docker-compose.prod.yml`.
  - `'COMPOSE_PROJECT_NAME' not in ops.env_names(directory / '.env')`. Otherwise a
    plain invocation in R's directory would name another project, possibly
    N's. No tool rewrites a set's `.env` (Gaps).
  - Signing follows B: `bool(record['wrapping_secret_file']) == ('wrapping_custody' in manifest)`.
    When B has custody, `'c2-wrap-v1' in manifest['wrapping_custody']['files']`.
    The overlay is used exactly when a custody configuration is installed (step
    2, Enabling online approvals), and B records custody exactly when one was
    installed (`capture_wrapping_custody`). A mismatch means that N-1 was not
    configured by these procedures.
- **P6. Stage R's checkout.**

  ```python
  ops.run(['git', 'worktree', 'add', '--detach', str(R_dir), previous_sha])
  shutil.copyfile(directory / '.env', R_dir / '.env')
  (R_dir / '.env').chmod(0o600)
  assert ops.text(['git', '-C', str(R_dir), 'rev-parse', 'HEAD']) == previous_sha
  assert ops.digest(R_dir / '.env') == manifest['sha256']['.env']
  ```

  R uses B's own `.env` unchanged. B's Keycloak database, client secrets and
  PostgreSQL roles were made with it, and `restore_snapshot` sets the restored
  role passwords from it (`snapshot_credentials`). N's `.env` is never touched.
  Bind mounts such as `./config` and `./keycloak` come from R's directory at
  N-1. Identical bytes do not yet mean identical passwords:
  `snapshot_credentials` only splits each line at `=` and strips surrounding
  quotes. It does not apply Compose's `.env` rules (interpolation, inline
  comments, escapes). P8 compares both readings.
- **P7. Stage R's signing files and custody configuration** (only when B has
  custody):

  ```python
  r_secret_file = None
  if 'wrapping_custody' in manifest or ops.WRAPPING_CUSTODY_CONFIG.is_file():
      ops.run(['sudo', '-n', 'true'])   # R7 changes the custody configuration with the same non-interactive sudo
  if 'wrapping_custody' in manifest:
      restored = json.loads(ops.text([sys.executable, 'scripts/ops_backup.py', 'restore-wrapping', str(directory),
                                      '--destination', str(R_signing)]))['files']
      sums = {key: entry['sha256'] for key, entry in manifest['wrapping_custody']['files'].items()}
      r_secret_file = restored['c2-wrap-v1']
      Path(r_secret_file).chmod(0o440)
      ops.run(['sudo', '-n', 'chown', f'1000:{os.getgid()}', r_secret_file])   # Enabling online approvals
      # R7's backup reads every file as this account; R's API reads the mounted one as the image's node user.
      assert all(ops.digest(Path(path)) == sums[key] for key, path in restored.items())
      read = "process.stdout.write(String(require('node:fs').readFileSync('/run/secrets/emr-signing-wrap-v1').length))"
      assert ops.temporary_run(['--network', 'none', '--read-only', '--mount',
                                f'type=bind,source={r_secret_file},target=/run/secrets/emr-signing-wrap-v1,readonly',
                                '--entrypoint', 'node', manifest['running_images']['kin-api']['id'], '-e', read]) == '32'
      ops.write_json(R_custody, {'backup_root': str(Path(manifest['wrapping_custody']['directory']).parent),
                                 'files': restored})
  ```

  `restore-wrapping` checks every custody file against B's sha256 before it
  creates the directory, and it prints only the ID → path mapping. R's files are
  therefore byte-equal to the copies that P2 just unwrapped B's keys with. The
  custody configuration currently installed (N's) and N's own signing file are
  not changed. `backup_root` is B's custody root, so R's sets and B rotate under
  the same root.

  R's `c2-wrap-v1` file gets the arrangement of Enabling online approvals: owner
  uid 1000 (the API's `node` user), group = this session's group, mode 0440.
  This session runs as the backup account (see the precondition), and R7's backup
  and the nightly job read the file as that account. Both readers are checked
  before N stops:
  - the digests read the files as this account;
  - a temporary container of N-1's own API image (B's `running_images`) reads the
    mapped file as the image's user, at the overlay's mount point. It prints only
    the length.

  A file that either reader cannot open, including one whose ownership a
  user-namespace or rootless daemon maps differently, fails here.
- **P8. R's command renders.**

  ```python
  compose_r = compose_for(R, R_dir, record['compose_files'], r_secret_file)
  ops.run(compose_r + ['config', '--quiet'])
  # R4 sets the role passwords from snapshot_credentials; R6's services get Compose's own reading. Never printed.
  services = json.loads(ops.text(compose_r + ['config', '--format', 'json']))['services']
  delivered = {'kin': services['db']['environment']['POSTGRES_PASSWORD'],
               'kin_runtime': services['emr-provision']['environment']['KIN_EMR_RUNTIME_PASSWORD']}
  verifiers = manifest['role_catalog']['login_verifiers']
  restore_input = ops.snapshot_credentials(directory)
  credentials_equal = set(verifiers) <= delivered.keys() and all(restore_input[role] == delivered[role]
                                                                 for role in verifiers)
  del services, delivered, restore_input
  assert credentials_equal
  r_tool = [sys.executable, str(R_dir / 'scripts' / 'ops_backup.py')]
  assert '--no-rotate' in ops.text(clean_env() + r_tool + ['backup', '--help'])   # R7 runs N-1's own tool
  record.update(n_project=n_project, n_files=n_files, n_secret_file=n_secret_file, rollback_project=R,
                rollback_dir=str(R_dir), rollback_files=record['compose_files'], rollback_secret_file=r_secret_file,
                rollback_custody=str(R_custody) if r_secret_file else None, rollback_signing=str(R_signing))
  ops.write_json(record_path, record)
  ```

  `config --quiet` fails on a missing variable or file and prints nothing. The
  help check confirms, before N stops, that N-1's own backup tool takes the
  options R7 uses.

  The credential check compares, in memory, two readings of every login role
  that B's catalog restores with a password (`login_verifiers`):
  - the value R4 will set (`snapshot_credentials` of B's `.env`);
  - the value Compose delivers to R's services. `POSTGRES_PASSWORD` reaches
    `db`, Keycloak and `api-migrate`, and `KIN_EMR_RUNTIME_PASSWORD` reaches
    `emr-provision` and the API's `DATABASE_URL`.

  Only the outcome is kept. A value that the two readings parse differently (an
  inline comment, `${...}` interpolation, an escape) fails here, while N still
  serves. So does a login role whose password Compose passes to no service:
  that is an input this check cannot compare. No tool rewrites a set's `.env`
  (Gaps). P2's rehearsal does not show this, because its restored copy accepts
  trusted connections.

If any preflight step fails, N has not changed. Record `ROLLBACK_NOT_STARTED`
with the cause and the paths that P6 and P7 created, then release the lock
normally (not retained); N keeps serving. Before a repeat with the same R, inspect
and remove only what this preflight created: run
`git worktree remove --force <R_dir>`, delete the staged signing directory (B's
custody keeps the original) and delete `R_custody`. Otherwise choose a new R.
Only after the preflight passes, save N's custody configuration once, and only
then switch the record:

```python
saved_n_custody = record_path.parent / f'n-wrapping-custody-{R}.json'
had_n_custody = ops.WRAPPING_CUSTODY_CONFIG.is_file()
if had_n_custody:
    descriptor = os.open(saved_n_custody, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # never replaced
    with os.fdopen(descriptor, 'wb') as copy:
        copy.write(ops.WRAPPING_CUSTODY_CONFIG.read_bytes())
lease.retain()
record.update(status='ROLLING_BACK', had_n_custody=had_n_custody,
              saved_n_custody=str(saved_n_custody) if had_n_custody else None,
              n_custody_sha256=ops.digest(saved_n_custody) if had_n_custody else None)
ops.write_json(record_path, record)
```

The installed configuration is still N's here: preflight did not touch it. The
copy, its existence flag and its digest are recorded once for this rollback.
R7 and the way back to N only read them, so a repeated R7, or a forward attempt
with R′, cannot replace N's configuration with R's or lose the flag.

- **R1. Preserve N while it serves.** Bind N's set from the receipt that
  `backup()` prints, not from its return value. `backup()` prints the receipt
  even when it then raises for a readiness failure after `"complete": true`:

  ```python
  printed, n_error = io.StringIO(), None
  try:
      with contextlib.redirect_stdout(printed):
          ops.backup(backup_root)
  except Exception as error:
      n_error = f'{type(error).__name__}: {error}'
  lines = printed.getvalue().splitlines()
  receipt = json.loads(lines[-1]) if lines else None
  print(receipt, n_error)
  if receipt is None or receipt['complete'] is not True:
      raise RuntimeError('N was not preserved; N is not stopped (see below)')
  N_set = Path(receipt['backup'])
  _, n_manifest = ops.validate_backup(N_set)
  assert n_manifest['git_sha'] == n_sha
  ops.write_json(N_set / ops.HOLD_FILE, {'reason': 'rolled-back release', 'release': n_sha})
  record.update(n_set=str(N_set), n_backup_receipt=receipt, n_backup_error=n_error)
  ops.write_json(record_path, record)
  ops.rehearse(N_set)
  ```

  N's set is taken with N's own custody configuration, which nothing has
  changed. Its rehearsal unwraps N's stored keys with that custody copy, so the
  set is a usable copy of N's keys. Beside N's volumes, it is the only copy of
  what N wrote after B. Its hold has no end date: removing it is a separate
  retention decision.

  When `kin-db` of N is not running, no backup is possible: `backup()` stops
  before writing anything (`PostgreSQL must be running`). Record
  `n_set = None` with that cause and continue. N's volumes are then the only
  copy. Any other failure in R1 (no complete receipt, a validation, or a failed
  rehearsal) stops here. Nothing has been switched: record `ROLLBACK_NOT_STARTED`
  with the cause, keep any held set, set `lease.retained = False` and release the
  lock. N keeps its containers; `backup()` resumes the writers it stopped. The
  saved custody copy stays with the record. Before a repeat with the same R,
  delete it together with what preflight created.
- **R2. Stop N.** Run `ops.run(compose_n + ['down'])`. Do not pass `-v`: N's named
  volumes stay under N's Compose project. Record
  `ops.text(['docker', 'volume', 'ls', '--filter', f'label=com.docker.compose.project={n_project}'])`.
  N's checkout, `.env`, signing file and custody configuration are unchanged.
- **R3. Start R's empty cluster alone:**
  `ops.run(compose_r + ['up', '-d', '--wait', 'db'], timeout=install_timeout)`. Its
  init creates the empty `kin` and `keycloak` databases and the tablespace
  directory.
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
  N-1 from R's directory and create R's containers without starting them:
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
- **R6. Start N-1 without the entry, let its API recover, expire, then open.**
  1. Run `ops.run(compose_r + ['up', '-d', 'api'], timeout=install_timeout)`. This
     starts `db`, `emr-provision`, `api-migrate`, `keycloak`, `orthanc` and `api`
     through `depends_on`. It does not start `proxy`, which is the only business
     entry: `docker-compose.prod.yml` publishes no API port, and Orthanc and
     Keycloak listen on 127.0.0.1 only.
  2. Check that `kin-api-migrate` and `kin-emr-provision` exit 0, with
     `ops.text(['docker', 'inspect', '--format', '{{.State.ExitCode}}', name])`.
     The migrate log (`ops.text(compose_r + ['logs', 'api-migrate'])`) shows
     `No pending migrations to apply.`, because the restored history is N-1's.
  3. Wait until the running API has finished its own recovery. `api/src/main.ts`
     awaits `runtime.start()` before `app.listen(3000)`, and `start()` runs
     `recoverPending()` and then the failure-journal replay
     (`api/src/emr-runtime/application.ts`). Any HTTP answer on the API's own
     port therefore comes after both:

     ```python
     listening = ("require('node:http').get('http://127.0.0.1:3000/api/health',"
                  "r=>{r.resume();process.stdout.write('LISTENING');}).on('error',()=>{process.exitCode=1;})")
     api_timeout = 134   # step 3's installation readiness bound
     started = time.monotonic()
     deadline = started + api_timeout
     while True:
         remaining = deadline - time.monotonic()
         if remaining <= 0:
             raise RuntimeError(f'R API did not finish recovery within {api_timeout}s; keep the proxy closed and inspect its log')
         try:
             if ops.run(['docker', 'exec', 'kin-api', 'node', '-e', listening], timeout=min(30, remaining),
                        check=False).stdout == b'LISTENING':
                 break
         except subprocess.TimeoutExpired:
             pass
         time.sleep(min(3, max(0, deadline - time.monotonic())))
     record['api_recovered_seconds'] = round(time.monotonic() - started, 3)
     ```

     A failed start makes the API exit before it listens, so a restart loop
     never answers and the bound decides. Record the elapsed time. Recheck the
     bound for a larger restored failure spool; it is not a clinical performance
     requirement.
  4. Only then run the restored-copy expiry sweep, as `rehearse_held` runs it
     after its own recovery check:

     ```python
     sweep = ops.restored_emr_expiry('kin-db', 'kin')
     assert sweep.get('ran') is True   # rehearse: "Restored expiry sweep did not run before business use"
     record['expiry_sweep'] = sweep
     ops.write_json(record_path, record)
     ```

     The sweep removes access and failure rows past their period, unless a hold
     or an open duty request keeps them. It keeps history rows that have no
     ending evidence and counts them (Recovery and rehearsal). The API's own
     startup does not run it. Nothing replays after it, because the replay ran
     once, before `listen`.
  5. Open the entry: `ops.run(compose_r + ['up', '-d'], timeout=install_timeout)`.
- **R7. Activate R's custody configuration, verify, and hand over.**
  1. Install R's custody configuration. N's was saved before R1. After R2,
     nothing reads the configuration: N's nightly job is held out by this
     session's lock.

     ```python
     if r_secret_file:
         ops.run(['sudo', '-n', 'install', '-o', str(os.getuid()), '-g', str(os.getgid()), '-m', '0600',
                  str(R_custody), str(ops.WRAPPING_CUSTODY_CONFIG)])
     elif record['had_n_custody']:   # N enabled approvals after B; R runs as B did, without them
         ops.run(['sudo', '-n', 'rm', '-f', str(ops.WRAPPING_CUSTODY_CONFIG)])
     record['custody_activated'] = True
     ops.write_json(record_path, record)
     ```

     The step reads and writes no copy of N's configuration, so it can be
     repeated.

  2. Run the bounded HTTPS readiness check and the synthetic save/reopen and
     signing checks above. For check 1, use the G3 run of N-1. For check 3, set
     `secret_file = record['rollback_secret_file']` and expect `n` = B's
     `emr_signing.private_key` count.
  3. Take R's first populated backup with R's own tool, the one the nightly job
     will run, and rehearse it:

     ```python
     result = ops.run(clean_env() + r_tool + ['backup', '--output', backup_root, '--no-rotate'],
                      timeout=backup_timeout, check=False)
     r_receipt = json.loads(result.stdout.decode('utf-8').splitlines()[-1])
     assert result.returncode == 0 and r_receipt['complete'] is True
     R_set = Path(r_receipt['backup'])
     print(ops.text(clean_env() + r_tool + ['rehearse', str(R_set)], timeout=backup_timeout))
     ```

     `backup_timeout` is the site's backup hang timeout, set from the backup
     elapsed time recorded at installation (below step 4); 600 s until that
     measurement exists (step 2).
     `backup()` refuses containers whose Compose working directory is not its
     own checkout, so only R's tool can back up R. The rehearsal must show
     `success: true` and check 2's `wrapping_custody` result. With custody, it
     unwraps every restored key with the copy that R's new custody configuration
     just captured.
  4. Point the host's jobs that name the site checkout at `R_dir`: the nightly
     backup command (Nightly job), and certbot's webroot `certbot/www`
     (`docker-compose.prod.yml` mounts `./certbot/www`). From N's checkout the
     nightly backup now fails on purpose with `Container configuration belongs
     to a different repository`. Record the changed job definitions.

  Only then record `status=ROLLED_BACK` with the evidence paths, and release the
  lock as in step 4. R's directory is the site checkout from now on. A later
  upgrade starts there (precondition step 1 reads R's labels).

**Failure after R2 (N stopped).** Keep the lock and record `NEEDS_ATTENTION`.
Never remove a volume of N or R without inspection. B and N's set stay held.
Then take one of two ways:
- **Forward with a new project.** Use this from R3 onwards. A partly restored R is
  no longer a fresh cluster, and `restore_snapshot` refuses it.
  1. Run `ops.run(compose_r + ['down'])` without `-v`; R's volumes and directory
     stay for inspection.
  2. Choose R′. Repeat P4 and P6–P8 for R′ (new directory, staged files and
     `compose_r`). N's saved custody copy and `had_n_custody` stay as recorded;
     do not repeat the block that saved them.
  3. Continue from R3.

  For a failure in R6 or R7 whose cause is outside the data (configuration,
  readiness), correct it and repeat that step on R.
- **Back to N.** When the rollback session has ended, its retained lock
  (`.kin-ops.lock`, content `retained:…`) stays in N's checkout, and `ops.lock()`
  refuses while it exists. Remove it only after inspecting what that session
  left, and record the removal. Then open a new session in N's checkout as for
  the rollback session (lock, observed values, the three definitions,
  `install_timeout`) and rebuild both commands from the record:

  ```python
  record = json.loads(record_path.read_text(encoding='utf-8'))
  compose_r = compose_for(record['rollback_project'], record['rollback_dir'], record['rollback_files'],
                          record['rollback_secret_file'])
  compose_n = compose_for(record['n_project'], ops.ROOT, record['n_files'], record['n_secret_file'])
  lease.retain()
  ```

  1. Run `ops.run(compose_r + ['down'])` without `-v`.
  2. Put N's custody configuration back from the copy saved before R1. Do this
     whether or not R7 ran: it is idempotent, and it also covers an R7 that
     changed the configuration but did not record it.

     ```python
     if record['had_n_custody']:
         saved = Path(record['saved_n_custody'])
         assert ops.digest(saved) == record['n_custody_sha256']
         ops.run(['sudo', '-n', 'install', '-o', str(os.getuid()), '-g', str(os.getgid()), '-m', '0600',
                  str(saved), str(ops.WRAPPING_CUSTODY_CONFIG)])
     elif record['rollback_custody']:   # only R7 can have installed one, and P7 checked sudo for it
         ops.run(['sudo', '-n', 'rm', '-f', str(ops.WRAPPING_CUSTODY_CONFIG)])
     ```

     With neither N nor B having custody, nothing in this procedure creates a
     configuration, so there is nothing to remove and no sudo is used.

     If R7 had repointed the host's jobs, point them back at N's checkout.
  3. Run `ops.run(compose_n + ['up', '-d'], timeout=install_timeout)`. N's
     checkout, `.env`, compose files and signing file were never changed, and P3
     proved that `compose_n` renders N's configuration. R2 kept N's volumes.
  4. Run step 3's readiness check and check 3 with
     `secret_file = record['n_secret_file']`, then record
     `ROLLBACK_ABANDONED` and release the lock.

**Gaps (no existing tool; not invented here):**
- There is no single restore command for a daily set into a live site. R3–R6
  compose the existing `ops_backup` functions that `rehearse` runs in its isolated
  copy. Until a host rehearsal runs this section, these remain unverified:
  - whether `up --no-start --build` leaves the running `db` as it is;
  - whether a live Orthanc and API accept the file ownership that the tar
    extraction leaves;
  - whether R's `proxy` can create the fixed-name `kin-workflow` network
    (`docker-compose.prod.yml`) while the separately managed workflow receiver
    stays attached to N's network;
  - whether `docker compose config --hash '*'` equals the creating Compose's
    `com.docker.compose.config-hash` labels for every N container. A difference
    fails P3 or precondition step 1, before anything changes;
  - whether `clean_env` keeps everything the host's Docker client needs. A
    cleaned environment that reaches no daemon, or another one, fails
    `config_matches` in P3 or precondition step 1, before anything changes
    (Site Compose command);
  - whether `docker compose config --format json` on the site's Compose
    version renders `environment` as the mapping P8 reads. Another shape fails
    P8, before anything changes.

  A failure in the first three shows at R5–R7.
- No tool repoints the host's jobs that name the checkout path (the nightly
  backup and certbot's webroot). They are host-managed; R7 step 4 records the
  change.
- No tool rewrites a set's `.env`. A B whose `.env` names `COMPOSE_PROJECT_NAME`
  fails P5 and needs a separate decision. So does a B whose credentials
  `snapshot_credentials` reads differently from Compose (P8):
  `restore_snapshot` has no other credential input.
- R7 and the way back to N write or remove `/etc/kin-deploy/emr-wrapping-custody.json`
  with `sudo -n`, only when B or N has custody. P7 checks non-interactive sudo in
  exactly that case, before anything changes.
- No tool brings data written on N after B into the rolled-back N-1 site.
- A daily set without `role_catalog` (made before D23) has no live restore path.
  `restore_snapshot` needs that catalog. The older sets' `pg_dumpall` role replay
  is refused by PostgreSQL 16 for a `GRANTED BY kin` membership
  (`ops_backup.rehearse`, tests/README.md D23).
- No tool performs a save, reopen or signed approval on the installed host.
  Check 3 shows only that the running API can reach every stored key
  (Synthetic save/reopen and signing checks).

# One-time upgrade of the a86ecf1 host

Used once, for the production host as observed on 2026-10-31: a86ecf1 started on
10-15 by the protected entry (`kin-api`'s `config_files` label names root-only
copies under `/var/lib/kin-deploy/compose-entries/<generation>/` plus a
`runtime.yml` with image pins), the Halo overlay
`/etc/kin-deploy/overlays/docker-compose.halo-reports.yml`, and the nightly job
`~/.local/bin/kin-pacs-reviewed-backup`. After it the host runs N in the plain
form, and the sections above apply from N onward.

**Each side uses its own version's tools.** a86ecf1's checkout has no backup
tool that knows its own ledger and no restore command; the main tools do not
know a86ecf1's (no `/app/dist/emr-runtime/application` in its API image, no
`restore_expiry_sweep` in its database). So:
- Up to and including B, and the whole rollback, use the helper production runs
  every night: c7ef074's `ops_backup.py` and `ops_audit_integrity.py`, stored in
  `.git/` and pinned by the nightly wrapper. They import with `ROOT` = the site
  checkout (`Path(__file__).parents[1]`), and the bytes do not change when the
  checkout moves between a86ecf1 and N. Its `backup()` is exactly what the
  nightly CLI runs (`--ready-timeout 240 --no-rotate`), and its daily-set
  `rehearse()` and `restore_snapshot(..., 'post')` restore a role-catalog set into
  a fresh product cluster.
- Compose runs the files of the checked-out version, through `compose_for`.
- N's `scripts/ops_backup.py` runs only against N: its first backup and
  rehearsal (U5), and N's set before a rollback (R1).
- Nothing is built on the host. N's images are loaded; a86ecf1's are the
  running images, kept by tag. Every `up` passes `--no-build --pull never`, so a
  missing image stops Compose instead of building or pulling one.

The c7ef074 CLI and N's CLI take the operations lock themselves (`.kin-ops.lock`
in the checkout). An operator session therefore holds the lock only around its
own steps, and a CLI runs only while the session does not hold it.

## Before the window (no change to the running stack)

1. **Fetch and verify N.** The host's repository lacks N (it lacks even
   9bdbb7d), and loaded images bring no Git objects:

   ```bash
   git -C /home/ubuntu/pacs-starter-kit fetch origin main
   git -C /home/ubuntu/pacs-starter-kit cat-file -t <N full SHA>          # commit
   git -C /home/ubuntu/pacs-starter-kit rev-parse --verify '<N full SHA>^{commit}'
   git -C /home/ubuntu/pacs-starter-kit merge-base --is-ancestor <N full SHA> origin/main && echo on-main
   ```

   The full SHA must equal the approved release record's N and be on main. A
   fetch writes only `.git` objects and refs; HEAD stays a86ecf1.
2. **Build N's images on another host**, never on this one (2 vCPU, no swap,
   shared with Halo and the studio). Use a checkout at N in a directory named
   `pacs-starter-kit`, so the images get the site's project names, and a `.env`
   with `KIN_REVISION=<N full SHA>` plus throwaway values for the `:?`
   variables (no site credential leaves the site):

   ```bash
   docker compose -p pacs-starter-kit -f docker-compose.yml -f docker-compose.prod.yml build api api-migrate proxy
   docker save -o kin-n-images.tar pacs-starter-kit-api pacs-starter-kit-api-migrate pacs-starter-kit-proxy
   sha256sum kin-n-images.tar
   ```

   Copy the file to the host outside the checkout and the backup root, and
   compare its sha256 there.
3. **Check the nightly helper and the space.**
   `~/.local/bin/kin-pacs-reviewed-backup --check` must print
   `pins ok c7ef074`. The newest daily set must be `complete: true`. Free space:
   at least two daily sets (B and N's set) plus the image file and the loaded
   images, about 3 GB on 2026-10-31.
4. Schedule the window so that it does not cover the nightly job's 20:00 UTC
   start. During a locked step the job fails on the lock (`O_EXCL`) and writes
   nothing.

## In the window

**Session.** One `python3 -B -E -s` session in `/home/ubuntu/pacs-starter-kit`
(HEAD a86ecf1) as `ubuntu`, the account that owns the backup root:

```python
import hashlib, json, os, socket, sys, time
from pathlib import Path
PINS = {'ops_backup.py': '473c2acc78089aeae43cad8b52e0fc47f21eada1f2238b6267ac3b6fe79c8dbe',
        'ops_audit_integrity.py': '0ec3984285f82e02ada1bfd9ccdec0c78e87abf818ac8a3bb34dd02e486c029f'}
assert all(hashlib.sha256((Path('.git') / name).read_bytes()).hexdigest() == sha for name, sha in PINS.items())
sys.path.insert(0, str(Path('.git').resolve()))
import ops_backup as ops          # the nightly job's c7ef074 helper
assert ops.ROOT == Path.cwd().resolve()
hold = ops.lock()
lease = hold.__enter__()
ops.require_local_docker()
observed = {'host': socket.gethostname(), 'sha': ops.text(['git', 'rev-parse', 'HEAD']),
            'docker': ops.text(['docker', 'version']), 'compose': ops.text(['docker', 'compose', 'version'])}
```

Compare `observed` with the release record, then set `record_path` (outside
the checkout), `record`, `install_timeout = 2400`, `backup_root =
Path('/home/ubuntu/backups/kin-pacs')`, `N = '<N full SHA>'` and
`OLD = 'a86ecf1655c8c587012cef5fd16e233e121ae7dc'`. Define `clean_env`,
`compose_for` and `config_matches` from [Site Compose command](#site-compose-command),
and the readiness loop of installation step 3 as `ready()`. c7ef074's lease has
no `retain()`: keep the lock with `lease.retained = True`, release it with
`lease.retained = False` and `hold.__exit__(None, None, None)`.

- **U1. Adopt the running stack into the plain form.** About 1–2 minutes of
  outage.
  1. Add `KIN_MONITOR_PUBLIC_DIR` and `KIN_REVISION=<OLD>` to `.env`.
     `docker-compose.monitor.yml` requires the first (`:?`), and `compose_for`
     passes nothing else. Its value is in the entry's root-only
     `environment.json`, which holds the literal `.env` values, credentials
     included: read only this key (`sudo -n python3 -c` printing that one
     value) and never print the file.
  2. Name the running images as plain Compose does. The compose files give
     `api`, `api-migrate` and `proxy` no `image:`, so without the names `up`
     would build. The other services name tags; each tag must already be the
     running image, or the recreate would switch it:

     ```python
     project = ops.ROOT.name
     image = {c: ops.text(['docker', 'inspect', '--format', '{{.Image}}', c])
              for c in ('kin-api', 'kin-proxy', 'kin-db', 'kin-orthanc', 'kin-keycloak')}
     for tag, container in (('postgres:16-alpine', 'kin-db'), ('orthancteam/orthanc:24.12.0', 'kin-orthanc'),
                            ('quay.io/keycloak/keycloak:26.7.3', 'kin-keycloak')):
         assert ops.text(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag]) == image[container], tag
     for service, container in (('api', 'kin-api'), ('api-migrate', 'kin-api'), ('proxy', 'kin-proxy')):
         ops.run(['docker', 'tag', image[container], f'{project}-{service}'])
     ```

     `api-migrate` is the same `production` target of `api/` as `api`.
  3. Recreate once with the plain command and the entry's own file list:

     ```python
     files = ['docker-compose.yml', 'docker-compose.prod.yml',
              '/etc/kin-deploy/overlays/docker-compose.halo-reports.yml', 'docker-compose.monitor.yml']
     outside_files = {name: ops.digest(Path(name)) for name in files if Path(name).is_absolute()}
     compose = compose_for(project, ops.ROOT, files, None)   # no custody configuration on this host
     assert not Path('/etc/kin-deploy/emr-wrapping-custody.json').exists()
     lease.retained = True
     record.update(status='ADOPTING', compose_project=project, compose_files=files, outside_files=outside_files,
                   wrapping_secret_file=None)
     ops.write_json(record_path, record)
     ops.run(compose + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
     ready()
     assert config_matches(compose, project)
     ```

     `runtime.yml`'s pins, labels and one-shot names change every container's
     configuration hash, so all of them are recreated, `db` included; volumes
     are kept. `emr-provision` and `api-migrate` run again (no pending
     migration).

  From then on, never run `/opt/kin-deploy/entry.py compose recreate`: it
  would bring back the entry's recorded generation over the plain stack. Leave
  `/var/lib/kin-deploy` and `/etc/kin-deploy` as they are and record them as
  inert.
- **U2. Take B with the nightly helper, rehearse it, hold it.**

  ```python
  B = ops.backup(str(backup_root), 240)    # what the nightly CLI runs, without rotation
  ops.rehearse(B)                           # expected: "success": true, "shape": "post", catalog equal, emr verified
  b_manifest = json.loads((B / 'manifest.json').read_text(encoding='utf-8'))
  assert b_manifest['git_sha'] == OLD and b_manifest['git_dirty'] is False and b_manifest['role_catalog']
  ops.write_json(B / ops.HOLD_FILE, {'reason': 'rollback-window and original ledger representation', 'release': N})
  hold_tags = []
  for container, entry in b_manifest['running_images'].items():
      tag = f'kin-rollback-hold/{container}:{OLD[:12]}'
      ops.run(['docker', 'tag', entry['id'], tag])
      hold_tags.append(tag)
  record.update(backup_set=str(B), rollback_hold_tags=hold_tags)
  ops.write_json(record_path, record)
  ```

  B holds both databases whole (`kin` with `emr_access` and its one 10-15
  ledger event, `keycloak`), the role catalog and EMR catalog, the EMR state
  volume, the Orthanc storage, `.env`, both base compose files and the sealed
  AuditLog checkpoint. It does not hold the host files: the Halo overlay (its
  sha256 is in the record), `/etc/kin-workflow`, the certificates and the
  entry's state. B's rehearsal restores it into a fresh networkless cluster
  with the role-catalog replay and checks the EMR seal with B's own API image.
  Keep B's hold and tags after the window until a separate retention decision:
  B is the only copy of the ledger in its original (chain) representation.
- **U3. Load N's images.**

  ```python
  ops.run(['docker', 'load', '-i', '<kin-n-images.tar>'], timeout=install_timeout)
  revision = '{{index .Config.Labels "org.opencontainers.image.revision"}}'
  assert all(ops.text(['docker', 'image', 'inspect', '--format', revision, f'{project}-{service}']) == N
             for service in ('api', 'api-migrate'))   # the proxy image carries no revision label
  ```

  The load moves the three project tags to N; B's images keep their hold tags.
- **U4. Upgrade.** Set `KIN_REVISION=<N>` in `.env`, then:

  ```python
  record.update(status='STARTED', release_sha=N)
  ops.write_json(record_path, record)
  ops.run(['git', 'checkout', '--detach', N])
  assert all(ops.digest(Path(name)) == sha for name, sha in record['outside_files'].items())
  ops.run(compose + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
  ready()
  assert ops.text(['docker', 'inspect', '--format', '{{.State.ExitCode}}', 'kin-api-migrate']) == '0'
  ```

  `api-migrate` applies N's 21 migrations to the 46 of a86ecf1. Then check:
  - `_prisma_migrations`: 67 rows, all finished, none rolled back;
  - the 10-15 probe event moved into the new ledger: one `emr_access.access_entry`
    (stream `viewing`, act `열람`, `viewing2y`) whose payload has executor
    `service`, user `release-probe`, target `system-operation`;
  - Access Review shows it: `emr_access.review_entries('kin-center', '2026-10-15', '2026-10-16', false, NULL, NULL, 10)`
    as `kin_runtime` returns that row (the admin page reads exactly this function);
  - `config_matches(compose, project)`.

  If `kin-api-migrate` exits non-zero, go to M below. Any other failure: keep
  the lock, record `NEEDS_ATTENTION`, and choose the rollback.
- **U5. N's own tools from here.** Record `status='UPGRADED'`, set
  `lease.retained = False` and release the lock. Then, as the same account:

  ```bash
  env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_backup.py backup --output /home/ubuntu/backups/kin-pacs --no-rotate
  env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_backup.py rehearse <printed set>
  ```

  This is N's first backup. Write `restore-hold.json` in it as well, and run
  checks 2 and 3 of the synthetic checks (no custody: "online approvals not
  enabled"). Enabling online approvals is a later step on the running N.

**M. `api-migrate` failed in the window.** Each migration file runs in one
transaction, so the failing file left nothing, and the files before it are
applied. N's API has not started (it waits for `api-migrate`), so the doctors
still see the outage, and nothing has written to the database since B.

```python
print(ops.text(compose + ['logs', 'api-migrate']))   # the failing migration and PostgreSQL's error
failed = ops.text(['docker', 'exec', 'kin-db', 'psql', '-X', '-U', 'kin', '-d', 'kin', '-qAt', '-c',
                   'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL'])
```

Prisma refuses every later `migrate deploy` while that row exists (P3009). The
default is the rollback below. Go forward only when the cause is outside the
data and is corrected (an object in the way, a missing privilege), and record
the cause and the correction. Then mark the attempt rolled back and run the
migration again:

```python
ops.run(compose + ['run', '--rm', '--no-deps', 'api-migrate',
                   './node_modules/.bin/prisma', 'migrate', 'resolve', '--rolled-back', failed])
ops.run(compose + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
```

and continue at U4's checks. `resolve` changes only that history row.

## Rollback to a86ecf1

Applies from U4 until N's first change that B cannot represent is accepted
(see the end of this section). R is a new Compose project in the same checkout,
switched back to a86ecf1, with new volumes restored from B and B's own images.
N's volumes are kept and N's project is only stopped. Keeping the one checkout
means the nightly job, certbot's webroot and the monitor keep their paths.

**Preflight, while N serves.** A session as above (pinned import, `observed`,
the definitions), still at N, **without** the lock:

```python
B = Path(record['backup_set'])
directory, manifest = ops.validate_backup(B)              # checksums, archives, B's images present by ID
assert manifest['git_sha'] == OLD and manifest['git_dirty'] is False and manifest['role_catalog']
api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
n_project = api['Config']['Labels']['com.docker.compose.project']
n_files = record['compose_files']
compose_n = compose_for(n_project, ops.ROOT, n_files, None)
assert config_matches(compose_n, n_project)
R = n_project + '-r1'                                     # unused: no container, no volume with this project
assert not ops.text(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={R}'])
assert not ops.text(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={R}'])
for name in ('docker-compose.yml', 'docker-compose.prod.yml'):
    assert hashlib.sha256(ops.run(['git', 'show', f'{OLD}:{name}']).stdout).hexdigest() == manifest['sha256'][name]
ops.run(['git', 'cat-file', '-e', f'{OLD}:docker-compose.monitor.yml'])
assert all(ops.digest(Path(name)) == sha for name, sha in record['outside_files'].items())
site_env = [l for l in (ops.ROOT / '.env').read_text(encoding='utf-8').splitlines() if not l.startswith('KIN_REVISION=')]
b_env = [l for l in (directory / '.env').read_text(encoding='utf-8').splitlines() if not l.startswith('KIN_REVISION=')]
assert site_env == b_env    # R runs with the credentials B's databases were made with
for tag, container in (('postgres:16-alpine', 'kin-db'), ('orthancteam/orthanc:24.12.0', 'kin-orthanc'),
                       ('quay.io/keycloak/keycloak:26.7.3', 'kin-keycloak')):
    assert ops.text(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag]) == manifest['running_images'][container]['id']
assert not Path('/etc/kin-deploy/emr-wrapping-custody.json').exists()   # see the end of this section
record.update(n_project=n_project, n_files=n_files, rollback_project=R)
ops.write_json(record_path, record)
```

Then `ops.rehearse(directory)` again when B's last rehearsal is not from this
window. Any failure here: record `ROLLBACK_NOT_STARTED`; N keeps serving.

- **R1. Preserve N with N's tool**, still without the session lock:
  `env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_backup.py backup --output /home/ubuntu/backups/kin-pacs --no-rotate`,
  then its `rehearse`, then `restore-hold.json` in that set (reason
  `rolled-back release`). Record the set. Without a complete N set, stop
  (`ROLLBACK_NOT_STARTED`). When N's `kin-db` does not run, record that N's
  volumes are the only copy and continue.
- **R2. Lock, stop N.** `hold = ops.lock(); lease = hold.__enter__()`,
  `lease.retained = True`, `status='ROLLING_BACK'`, then
  `ops.run(compose_n + ['down'])` without `-v`. Record N's volumes
  (`docker volume ls --filter label=com.docker.compose.project=<n_project>`).
- **R3. Check out a86ecf1 and give R B's images.**

  ```python
  ops.run(['git', 'checkout', '--detach', OLD])
  images = manifest['running_images']
  for service, container in (('api', 'kin-api'), ('api-migrate', 'kin-api'), ('proxy', 'kin-proxy')):
      ops.run(['docker', 'tag', images[container]['id'], f'{R}-{service}'])
  compose_r = compose_for(R, ops.ROOT, record['compose_files'], None)
  ops.run(compose_r + ['config', '--quiet'])
  ops.run(compose_r + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'], timeout=install_timeout)
  ```

  a86ecf1's `db` creates only `kin` (no `keycloak` init script), which is the
  fresh cluster `restore_snapshot` requires.
- **R4. Restore PostgreSQL from B** (c7ef074's daily-set restore, the one its
  rehearsal uses):

  ```python
  source, outside = ops.daily_set_catalog(manifest['role_catalog'])
  print(ops.restore_snapshot('kin-db', directory, 'kin', 'post', source=source), outside)   # outside == []
  assert all(ops.counts('kin-db', db, 'kin') == manifest['counts'][db] for db in ops.PRE_DATABASES)
  assert ops.emr_catalog('kin-db', 'kin') == json.loads((directory / 'emr-catalog.json').read_text(encoding='utf-8'))
  print([row[0] for row in ops.migration_rows('kin-db')][-1])   # 20261011120000_filter_shortcuts
  ```
- **R5. Restore Orthanc and the EMR state.**
  `ops.run(compose_r + ['up', '--no-start', '--no-build', '--pull', 'never'], timeout=install_timeout)`,
  read `orthanc_volume` (`kin-orthanc` at `/var/lib/orthanc/db`) and
  `state_volume` (`kin-api` at `/var/lib/kin-emr`) from the mounts (they must be
  `<R>_orthanc-db` and `<R>_emr-state`), then extract with c7ef074's helper:

  ```python
  for volume, archive in ((orthanc_volume, 'orthanc.tgz'), (state_volume, 'emr-state.tgz')):
      ops.temporary_run(['--network', 'none', '--read-only', '--mount', f'type=volume,source={volume},target=/restore',
                         '--mount', f'type=bind,source={directory},target=/backup,readonly', '--entrypoint', 'tar',
                         manifest['postgres_image'], '-xzf', '/backup/' + archive, '-C', '/restore'], timeout=1800)
  print(ops.temporary_run(['--network', 'none', '--read-only', '--mount', f'type=volume,source={orthanc_volume},target=/restore,readonly',
                           '--entrypoint', 'python3', manifest['orthanc_image'], '-c', ops.SQLITE_CHECK], timeout=300))
  ```

  Expected: `"integrity": "ok"` with B's attachment count.
- **R6. Start R.** `ops.run(compose_r + ['up', '-d', '--no-build', '--pull', 'never', 'api'], timeout=install_timeout)`;
  `kin-emr-provision` and `kin-api-migrate` exit 0 (`No pending migrations to
  apply.`); the API answers on its own port (a86ecf1's API recovers its EMR seal
  before it listens). a86ecf1 has no restored-copy expiry sweep; there is none
  to run. Then `ops.run(compose_r + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)`.
- **R7. Verify and hand over.** `ready()`; `config_matches(compose_r, R)`;
  B's data: the row counts of B's manifest, its ledger event, Orthanc's
  instance count. Then R's first backup with R's own tool, the nightly helper:
  `R_set = ops.backup(str(backup_root), 240)`, `ops.rehearse(R_set)`. Record
  `status='ROLLED_BACK'`, set `lease.retained = False` and release the lock. The
  nightly job, which names this checkout, now backs up R unchanged.

**Back to N** (after R7, or after a failure from R2 on): in a session holding the
lock (remove a retained `.kin-ops.lock` only after inspecting what its session
left, and record it):

```python
compose_r = compose_for(record['rollback_project'], ops.ROOT, record['compose_files'], None)
compose_n = compose_for(record['n_project'], ops.ROOT, record['n_files'], None)
ops.run(compose_r + ['down'])                     # no -v: R's volumes stay for inspection
ops.run(['git', 'checkout', '--detach', record['release_sha']])
ops.run(compose_n + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
ready()
assert config_matches(compose_n, record['n_project'])
```

N's checkout files, `.env` and volumes are as they were at R2, so N comes back
with everything it wrote. Record `ROLLBACK_ABANDONED`.

**Where this rollback ends.** It restores a86ecf1 without online approvals.
Once a custody configuration is installed on N (Enabling online approvals) or
a doctor has a signing key, it no longer applies (preflight refuses on the
custody file): a86ecf1 cannot use the key, and the sections above, with N's
tools on both sides, cover later releases.

## After the window

- The nightly job keeps c7ef074's helper until it is replaced by N's tool in a
  separate change. N's tool rotates to seven daily generations by default and
  would delete older sets on its first run; keep `--no-rotate` or protect the
  sets first.
- B, its hold file and its `kin-rollback-hold/*` tags stay until a separate
  retention decision. So do N's first set and its hold.
- Remove `kin-n-images.tar` once N's images are confirmed loaded.

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
configuration's `files` entry for `c2-wrap-v1` names). It has two readers: the
API container user (`node`, uid 1000 in the production image) and the backup
account, whose nightly backup copies it into custody. Make it readable by those
two only: `chown 1000:<backup account's group>`, `chmod 0440`. With a backup
account of uid 1000 the owner bit already covers both. A file only uid 1000 can
read makes another backup account's backup fail with `Wrapping source file is
unavailable`. Install the custody configuration (Nightly job) first, so that the
overlay and the nightly custody copy name the same file.

At installation, step 2 adds the overlay itself. On a running stack, use one
locked operator session in the site checkout, as for steps 2–4. Address the stack
as in upgrade step 1, then merge the overlay after the stack's own files, record
the new list and file, and run check 3:

```python
secret_file = json.loads(ops.WRAPPING_CUSTODY_CONFIG.read_text(encoding='utf-8'))['files']['c2-wrap-v1']
files = record['compose_files'] + [SIGNING_OVERLAY]
compose = compose_for(record['compose_project'], ops.ROOT, files, secret_file)
ops.run(compose + ['up', '-d', 'api'], timeout=install_timeout)
record.update(compose_files=files, wrapping_secret_file=secret_file)
ops.write_json(record_path, record)
```

The overlay's own header shows the bare shell form. Use `compose_for` on a site
instead: an exported variable would otherwise override `.env` (Site Compose
command).

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
destination, so a missing or changed file leaves no partial directory. Start the
stack with the restored `c2-wrap-v1` file as `compose_for`'s `secret_file`, and
name the restored files in the custody configuration, as rollback P7 and R7 do.
The command refuses to overwrite an existing destination.

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
