"""CD-09-C RC4: the draft destruction ledger is not in what the backup archives.

REQ: claude-plan-cd-09c.md section 1-1 "운영·복구 장소의 의미" and the plan review's section 6 item 6 -> RISK: a ledger
inside a backed-up volume comes back with an older database and can no longer say what was destroyed after the copy ->
TEST: this file. It reads the deployment's own declarations (docker-compose.yml and the production override, the API
image's default) and asserts that the ledger directory is its own volume. Then (GPT review C-F3) it runs the daily
backup itself, ops_backup.backup, in the existing pure backup harness (tests/ops_backup_test.py Host: no Docker, every
docker command answered by the harness) with each container's mounts as Docker reports the declared volumes, collects
the volume every helper the backup starts mounts - the archives at the archive boundary (temporary_run with an output)
and the size reads - and asserts that the ledger volume is none of them and that the archives are exactly Orthanc's
database volume and the EMR state volume. Scope: the backup tool's selection against the declared configuration; no
Docker or real backup runs, and a copy an operator takes by other means is outside what this can show (the runbook's
first-start procedure covers it).
"""
from __future__ import annotations

from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import ops_backup  # noqa: E402
import ops_audit_integrity as audit  # noqa: E402
from ops_backup_test import Host  # noqa: E402

PROJECT = "fixture"   # the harness's Compose project label
SERVICE_CONTAINERS = {"api": "kin-api", "keycloak": "kin-keycloak", "orthanc": "kin-orthanc", "db": "kin-db", "proxy": "kin-proxy"}


class _Loader(yaml.SafeLoader):
    pass


# The production override uses Compose's merge tags (!override, !reset); their value is what replaces the base entry.
_Loader.add_multi_constructor("!", lambda loader, suffix, node: (
    loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode)
    else loader.construct_mapping(node) if isinstance(node, yaml.MappingNode) else loader.construct_scalar(node)))


def compose(name):
    return yaml.load((ROOT / name).read_text(encoding="utf-8"), Loader=_Loader)


def mounts(service):
    """Container path -> source (named volume or host path) of one service's volume list."""
    result = {}
    for entry in service.get("volumes") or []:
        source, target = entry.split(":")[:2]
        result[PurePosixPath(target)] = source
    return result


def inside(path, parent):
    return path == parent or parent in path.parents


class LedgerOutsideBackup(unittest.TestCase):
    def deployments(self):
        base, prod = compose("docker-compose.yml"), compose("docker-compose.prod.yml")
        merged_api = dict(base["services"]["api"])
        if "volumes" in prod["services"].get("api", {}):
            merged_api["volumes"] = prod["services"]["api"]["volumes"]
        yield "docker-compose.yml", base["services"]["api"], base["services"]["orthanc"]
        yield "docker-compose.yml + docker-compose.prod.yml", merged_api, base["services"]["orthanc"]

    def test_the_ledger_volume_is_none_of_the_archived_sources(self):
        dockerfile = (ROOT / "api" / "Dockerfile").read_text(encoding="utf-8")
        image_default = re.search(r"^ENV KIN_PURPOSE_LEDGER_DIR=(\S+)$", dockerfile, re.M).group(1)
        state = PurePosixPath(ops_backup.EMR_STATE)
        for label, api, orthanc in self.deployments():
            with self.subTest(label):
                ledger = PurePosixPath(api["environment"]["KIN_PURPOSE_LEDGER_DIR"])
                self.assertEqual(str(ledger), image_default, "the image default and the deployment name one directory")
                self.assertEqual(PurePosixPath(api["environment"]["KIN_EMR_STATE_DIR"]), state)
                api_mounts = mounts(api)
                # What the backup archives from the API container: exactly the volume mounted at EMR_STATE.
                self.assertIn(state, api_mounts, "the backup's selection rule finds the state volume")
                ledger_mounts = [target for target in api_mounts if inside(ledger, target)]
                self.assertEqual(ledger_mounts, [ledger], "the ledger directory is its own mount, not a path under another one")
                ledger_source = api_mounts[ledger]
                self.assertNotEqual(ledger_source, api_mounts[state])
                self.assertFalse(inside(ledger, state) or inside(state, ledger))
                # Orthanc's archived volume, and every file component, are other things.
                orthanc_db = mounts(orthanc)[PurePosixPath("/var/lib/orthanc/db")]
                self.assertNotEqual(ledger_source, orthanc_db)
                components = ops_backup.backup_components({"emr": {}})
                self.assertFalse([name for name in components if "purpose" in name or name.endswith(".jsonl")], components)

    def services(self):
        """Each deployment's services, with the production override's volume lists replacing the base ones."""
        base, prod = compose("docker-compose.yml"), compose("docker-compose.prod.yml")
        yield "docker-compose.yml", base["services"]
        merged = {name: dict(service) for name, service in base["services"].items()}
        for name, service in (prod.get("services") or {}).items():
            if name in merged and "volumes" in service:
                merged[name]["volumes"] = service["volumes"]
        yield "docker-compose.yml + docker-compose.prod.yml", merged

    @staticmethod
    def inspected_mounts(service):
        """The Mounts of `docker inspect` for one service: a named volume is <project>_<name>, anything else a bind."""
        result = []
        for target, source in mounts(service).items():
            if source.startswith((".", "/", "~", "$")):
                result.append({"Type": "bind", "Source": source, "Destination": str(target)})
            else:
                result.append({"Type": "volume", "Name": PROJECT + "_" + source, "Destination": str(target)})
        return result

    def test_the_backup_archives_exactly_orthanc_and_the_state_volume_and_never_mounts_the_ledger(self):
        for label, services in self.services():
            with self.subTest(label), tempfile.TemporaryDirectory() as temporary:
                host = Host(temporary)
                for item in host.info:
                    service = next(name for name, container in SERVICE_CONTAINERS.items() if "/" + container == item["Name"])
                    item["Mounts"] = self.inspected_mounts(services[service])
                api = {m["Destination"]: m for m in host.info[[i["Name"] for i in host.info].index("/kin-api")]["Mounts"]}
                ledger_volume = api[services["api"]["environment"]["KIN_PURPOSE_LEDGER_DIR"]]["Name"]
                state_volume = api[ops_backup.EMR_STATE]["Name"]
                orthanc = {m["Destination"]: m for m in self.inspected_mounts(services["orthanc"])}["/var/lib/orthanc/db"]["Name"]
                helpers, answer = [], host.fake_archive

                def witness(args, **kwargs):
                    specs = [dict(part.split("=", 1) for part in args[i + 1].split(",") if "=" in part)
                             for i, arg in enumerate(args) if arg == "--mount"]
                    helpers.append({"archive": kwargs.get("output") is not None,
                                    "volumes": [spec["source"] for spec in specs if spec.get("type") == "volume"]})
                    return answer(args, **kwargs)
                host.fake_archive = witness
                folder, manifest, error = host.backup(audit.InputError("no seal"))
                self.assertIsNone(error)
                self.assertTrue(manifest["complete"])
                archives = [h["volumes"] for h in helpers if h["archive"]]
                # The archive boundary ran: one archive of each source, in the backup's own order.
                self.assertEqual(archives, [[orthanc], [state_volume]])
                self.assertEqual(manifest["emr"]["state_volume"], state_volume)
                self.assertNotIn(ledger_volume, [volume for h in helpers for volume in h["volumes"]],
                                 "no helper of the backup mounts the ledger volume")
                self.assertFalse([path.name for path in folder.iterdir() if "purpose" in path.name or path.name.endswith(".jsonl")])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
