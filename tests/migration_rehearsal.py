"""TEST-OPS-03: baseline and deploy in isolated databases, including refusal cases.

python tests/migration_rehearsal.py <completed-backup-directory>
Uses the API's current image and the checked-out Prisma files; no live DB writes.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops


def main(directory):
    ops.require_local_docker()
    directory, manifest = ops.validate_backup(directory)
    image = ops.text(["docker", "inspect", "--format", "{{.Image}}", "kin-api"])
    token = uuid.uuid4().hex
    container = "kin-rehearsal-" + token[:16] + "-migration"
    source_counts = ops.counts("kin-db", "kin", "kin")
    before_migrations = ops.text(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                                  "SELECT to_regclass('public._prisma_migrations');"])
    cases = []

    def psql(database, sql):
        return ops.text(["docker", "exec", container, "psql", "-X", "-U", "postgres", "-d", database,
                         "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql])

    def api(database, args, *, refused=None):
        helper_token = uuid.uuid4().hex
        helper = "kin-rehearsal-" + helper_token[:16] + "-api"
        command = ["docker", "run", "--rm", "--name", helper, "--label", "kin.ops.run=" + helper_token,
                   "--network", "container:" + container,
                   "--mount", f"type=bind,source={ops.ROOT / 'api/prisma'},target=/app/prisma,readonly",
                   "-e", f"DATABASE_URL=postgresql://postgres@127.0.0.1:5432/{database}",
                   "--entrypoint", "node", image, *args]
        try:
            reply = ops.run(command, check=False, timeout=180)
            output = (reply.stdout + reply.stderr).decode("utf-8", errors="replace")
            if refused:
                if reply.returncode == 0 or refused not in output:
                    raise RuntimeError("Expected migration refusal was not observed: " + refused)
            elif reply.returncode:
                raise RuntimeError("Isolated migration command failed")
        finally:
            ops.remove_owned_if_present("container", helper, helper_token)

    deploy = ["node_modules/prisma/build/index.js", "migrate", "deploy"]
    drift = ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
             "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"]
    try:
        ops.run(["docker", "run", "-d", "--name", container, "--label", "kin.ops.run=" + token,
                 "--network", "none", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", manifest["postgres_image"]])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if ops.run(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not start")
        for database in ("blank", "existing", "drifted"):
            ops.run(["docker", "exec", container, "createdb", "-U", "postgres", database])
            if database != "blank":
                with (directory / "kin.dump").open("rb") as handle:
                    ops.run(["docker", "exec", "-i", container, "pg_restore", "-U", "postgres", "-d", database,
                             "--no-owner", "--no-privileges", "--exit-on-error"], input_file=handle)

        api("blank", ["prisma/baseline.mjs"], refused="Empty database")
        if psql("blank", "SELECT count(*) FROM pg_tables WHERE schemaname='public';") != "0":
            raise RuntimeError("Refused empty baseline changed the database")
        cases.append("empty baseline refused without changes")
        api("blank", deploy)
        api("blank", drift)
        cases.append("empty migrate deploy creates matching schema")

        before = ops.counts(container, "existing", "postgres")
        api("existing", ["prisma/baseline.mjs"])
        api("existing", ["prisma/baseline.mjs"])
        api("existing", deploy)
        api("existing", drift)
        after = ops.counts(container, "existing", "postgres")
        after.pop("_prisma_migrations", None)
        before.pop("_prisma_migrations", None)
        if after != before:
            raise RuntimeError("Baseline changed existing table row counts")
        if psql("existing", 'SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=\'0_init\' AND finished_at IS NOT NULL;') != "1":
            raise RuntimeError("Baseline history is not exactly one applied migration")
        cases.append("existing baseline, repeat and deploy preserve all table row counts")

        psql("drifted", 'ALTER TABLE "Report" ADD COLUMN "testUnexpected" TEXT;')
        api("drifted", ["prisma/baseline.mjs"], refused="schema drift detected")
        if psql("drifted", "SELECT to_regclass('public._prisma_migrations');"):
            raise RuntimeError("Drifted baseline wrote migration history")
        cases.append("schema drift refused before migration history write")
    finally:
        ops.remove_owned_if_present("container", container, token)
    if ops.counts("kin-db", "kin", "kin") != source_counts:
        raise RuntimeError("Live database row counts changed during isolated rehearsal")
    current_migrations = ops.text(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                                   "SELECT to_regclass('public._prisma_migrations');"])
    if current_migrations != before_migrations:
        raise RuntimeError("Live migration metadata changed during rehearsal")
    print(json.dumps({"success": True, "cases": cases, "live_database_unchanged": True, "temporary_container_removed": True}))


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise RuntimeError("Pass one completed backup directory")
        with ops.lock():
            main(sys.argv[1])
    except Exception as error:
        print(f"Migration rehearsal failed: {error}", file=sys.stderr)
        sys.exit(1)
