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
   Then perform the approved synthetic save/reopen and signing checks before
   clinical handover. Save their actual outcomes in the release record.
4. Backup and restore: after verification, take the **first populated backup**
   with `ops.backup('<backup-directory>')` in this same locked session (the CLI
   equivalent outside this session is `python3 scripts/ops_backup.py backup --output <backup-directory>`).
   Record the exact snapshot directory printed by the backup, then run
   `ops.rehearse(Path('<snapshot-directory>'))`, equivalent to
   `python3 scripts/ops_backup.py rehearse <snapshot-directory>`. Follow the
   wrapping custody recovery commands below as well. This exercises restore even
   when the site had no database before installation.

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

Restore the database with the existing release recovery procedure. Before
enabling online approvals, restore the wrapping files into a new directory:

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
