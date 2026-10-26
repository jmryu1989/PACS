# Online signing keys: backup and restore

The per-doctor encrypted private keys are in `kin.emr_signing.private_key`;
`doctor_key`, `key_history` and `signed_version` retain their registration and
verification evidence. Clinical records are in `emr_clinical`. The daily
`scripts/ops_backup.py backup` and its `rehearse` compare every table in `public`,
`emr_access`, `emr_signing` and `emr_clinical`, using the captured counts, not fixed totals.

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

Custody directories are not deleted by daily database rotation and are not
included in ordinary database export. Retain each alongside its dependent
restorable snapshot under the existing custody procedure. Moving a snapshot to
another host requires moving its separate custody directory and recording the
new `wrapping_custody.directory` before rehearsal. This unit does not enable
offsite transfer or change the external-backup OFF decision.

## Recovery and rehearsal

Restore the database with the existing release recovery procedure. Before
enabling online approvals, restore the wrapping files into a new directory:

```sh
python3 scripts/ops_backup.py restore-wrapping /srv/kin-backups/SET --destination /srv/kin-signing-restored/SET
python3 scripts/ops_backup.py rehearse /srv/kin-backups/SET
```

The first command checks the custody files against the snapshot and prints only
the restored ID/path mapping. Point `KIN_EMR_WRAPPING_SECRET_FILE` of the signing
overlay (above) at the restored `c2-wrap-v1` file. The command refuses to
overwrite an existing destination.

Rehearsal restores its own temporary custody copy using that same locator, checks
all restored table counts and calls the existing product key-unwrapping function
for every restored private key using the recorded API image. Missing or wrong
custody fails rehearsal. Its receipt records `wrapping_custody` and `success`;
secret bytes are never printed. Existing signatures retain public verification
evidence, but successful DB restoration alone does not certify new approvals.
