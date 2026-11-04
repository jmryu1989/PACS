"""CD-09-C RC4: the draft destruction ledger is not in what the backup archives.

REQ: claude-plan-cd-09c.md section 1-1 "운영·복구 장소의 의미" and the plan review's section 6 item 6 -> RISK: a ledger
inside a backed-up volume comes back with an older database and can no longer say what was destroyed after the copy ->
TEST: this file. It reads the deployment's own declarations (docker-compose.yml and the production override, the API
image's default) and the backup tool's own selection rule (scripts/ops_backup.py: the volume mounted at EMR_STATE in the
API container, Orthanc's database volume, the dump and configuration files) and asserts that the ledger directory's
volume is none of them. Scope: the declared configuration and the selection rule; no backup is executed here, and a
copy an operator takes by other means is outside what this can show (the runbook's first-start procedure covers it).
"""
from __future__ import annotations

from pathlib import Path, PurePosixPath
import re
import sys
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_backup  # noqa: E402


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


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
