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
destination, so a missing or changed file leaves no partial directory. Configure the existing signing service's
`FileWrappingSecrets` paths and secret mounts with that mapping. The command
refuses to overwrite an existing destination. Startup wiring of that service
belongs to the API integration unit; this ops unit does not change it.

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
